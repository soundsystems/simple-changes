import { randomUUID } from "node:crypto";
import type { AuthoringSidecar } from "./authoring.ts";
import { assertNotChangelogAuthorCheckout } from "./changelog-authors.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { requireHarnessSession } from "./harness-session.ts";
import { sha256Json } from "./hash.ts";
import {
  captureInventory,
  compareSnapshots,
  locateRepository,
} from "./inventory.ts";
import {
  concurrentClaimFor,
  controllerLifecycle,
  exactWorktreeLease,
  gitLabProjectForTargetRef,
  leaseLiveness,
  readLeaseFromCommonDirectory,
  refreshControllerSession,
  requiredText,
  scopeInvariantDigest,
  staleLeaseRecoveryCommand,
  targetBranchForRef,
  targetUsesGitLab,
  transferController,
  withStateLock,
  writeControllerBinding,
  writeLease,
} from "./loop-lease-core.ts";
import { buildPreviewPlan } from "./planner.ts";
import { runGit } from "./process.ts";
import {
  type QueuedRetirementHooks,
  type QueuedRetirementReport,
  retireMergedQueuedWorktrees,
} from "./queued-retirement.ts";
import { validateOpeningRemoteInventory } from "./remote-branch-reconciliation.ts";
import {
  heldLoopLock,
  loadReviewLedgerForResume,
  type ReviewLedgerResumeState,
} from "./review-ledger.ts";
import type {
  LoopLease,
  RemoteBranchReconciliationReceipt,
  RepositoryInventory,
  RequestMode,
} from "./types.ts";
import {
  readCoordinationDocumentFromCommonDirectory,
  withWorktreeCoordinationLock,
} from "./worktree-coordination.ts";

const LOOP_MODES = new Set<RequestMode>([
  "queue",
  "sweep",
  "integrate",
  "ship",
  "reconcile",
  "resume",
]);

const openingRemoteInventoryForStart = (
  inventory: RepositoryInventory,
  input: unknown,
  targetBranch: string | null,
  targetRevision: string
): RemoteBranchReconciliationReceipt | undefined => {
  const required = targetUsesGitLab(inventory);
  const receipt = input ? validateOpeningRemoteInventory(input) : undefined;
  if (required && !receipt) {
    throw new SimpleChangesError(
      "Start this GitLab integration loop with a complete opening remote inventory; capture it before any provider mutation.",
      EXIT_CODES.unsafe
    );
  }
  if (!receipt) {
    return;
  }
  const project = gitLabProjectForTargetRef(
    inventory.repository.primaryCheckout,
    inventory.targetRef
  );
  if (
    receipt.project !== project ||
    receipt.targetBranch !== targetBranch ||
    receipt.targetRevision !== targetRevision
  ) {
    throw new SimpleChangesError(
      "Opening remote inventory must bind the exact GitLab project, target branch, and opening target revision.",
      EXIT_CODES.validation
    );
  }
  return receipt;
};

const resolveExistingLoopStart = (
  existing: LoopLease | null,
  inventory: RepositoryInventory,
  agentId: string,
  mode: RequestMode
): LoopLease | null => {
  if (!existing) {
    return null;
  }
  const lifecycle = controllerLifecycle(existing);
  if (
    lifecycle.status === "active" &&
    existing.ownerAgentId === agentId &&
    existing.mode === mode
  ) {
    return existing;
  }
  if (lifecycle.status === "relinquished" && mode === "resume") {
    assertNotChangelogAuthorCheckout(
      existing,
      inventory.repository.currentCheckout
    );
    return transferController(
      existing,
      inventory,
      agentId,
      "resume",
      lifecycle.reason ?? "Resumed relinquished integration loop.",
      null
    );
  }
  if (lifecycle.status === "relinquished") {
    throw new SimpleChangesError(
      `Integration-controller loop ${existing.runId} was relinquished by ${existing.ownerAgentId}. Resume it explicitly to finish or close its frozen shipment; do not reuse it for a later ${mode} shipment. Next: start the loop again in resume mode to finish it, or run \`simple-changes loop close-equivalent --run-id ${existing.runId} --approved-by <you> --reason <why>\` if there is nothing left to ship.`,
      EXIT_CODES.unsafe
    );
  }
  if (leaseLiveness(existing).state === "stale") {
    throw new SimpleChangesError(
      `Integration-controller loop ${existing.runId} has no recent activity; this alone does not prove its agent has stopped. On existing user authority for stale bookkeeping recovery, run \`${staleLeaseRecoveryCommand(existing)}\`, then retry from fresh inventory.`,
      EXIT_CODES.unsafe
    );
  }
  throw new SimpleChangesError(
    `Integration-controller loop ${existing.runId} is already active for ${existing.ownerAgentId}. Independent agents may continue in distinct actively claimed worktrees; start no second push/MR/merge/cleanup controller.`,
    EXIT_CODES.unsafe
  );
};

export interface LoopStartOptions {
  /**
   * Receives what a fresh Queue or Sweep start did with the worktrees
   * earlier Queue and Sweep runs kept, even when it removed none. It is not
   * called for any other mode, or when the start returns a run that
   * already exists.
   */
  onQueuedRetirement?: (report: QueuedRetirementReport) => void;
  /** Receives the review ledger a resume loads under the held loop lock. */
  onReviewLedger?: (state: ReviewLedgerResumeState) => void;
  /**
   * Runs under the loop locks once the run is started or resumed, so work
   * that depends on which run is live cannot race another start or close.
   */
  onStarted?: (lease: LoopLease) => void;
  /** Test seams for the clearing of earlier Queue and Sweep worktrees. */
  queuedRetirementHooks?: QueuedRetirementHooks;
  /**
   * The run's `--authoring-request` (resume only): revalidation uses it
   * combined with the saved settings, so the run has one review gate.
   */
  request?: AuthoringSidecar;
}

interface OpeningTarget {
  openingRemoteInventory: RemoteBranchReconciliationReceipt | undefined;
  targetBranch: string | null;
  targetRevision: string;
}

// The target a fresh run opens on, with its provider inventory validated.
const openingTarget = (
  inventory: RepositoryInventory,
  openingRemoteInventoryInput: unknown
): OpeningTarget => {
  const targetBranch = targetBranchForRef(
    inventory.repository.primaryCheckout,
    inventory.targetRef
  );
  const targetRevision = runGit(inventory.repository.primaryCheckout, [
    "rev-parse",
    "--verify",
    `${inventory.targetRef}^{commit}`,
  ]).stdout.trim();
  return {
    openingRemoteInventory: openingRemoteInventoryForStart(
      inventory,
      openingRemoteInventoryInput,
      targetBranch,
      targetRevision
    ),
    targetBranch,
    targetRevision,
  };
};

const QUEUED_MODES: ReadonlySet<RequestMode> = new Set(["queue", "sweep"]);

/**
 * The inventory a fresh run's baseline is taken from. A Queue or Sweep
 * start first clears the worktrees earlier Queue and Sweep runs kept whose
 * work is merged, here: under the start's locks, after the start is
 * validated, and before the lease records any baseline. The report is
 * handed over even when nothing was removed, and clearing never refuses
 * the start. The inventory is read again only when something was removed.
 */
const inventoryAfterQueuedRetirement = (
  repositoryPath: string,
  validated: RepositoryInventory,
  mode: RequestMode,
  options: LoopStartOptions
): RepositoryInventory => {
  if (!QUEUED_MODES.has(mode)) {
    return validated;
  }
  const report = retireMergedQueuedWorktrees(
    repositoryPath,
    validated,
    options.queuedRetirementHooks
  );
  options.onQueuedRetirement?.(report);
  return report.removed.length > 0
    ? captureInventory(repositoryPath)
    : validated;
};

// The lease of a fresh run, taken from one inventory.
const openingLease = (
  inventory: RepositoryInventory,
  agentId: string,
  mode: RequestMode,
  { openingRemoteInventory, targetBranch, targetRevision }: OpeningTarget
): LoopLease => {
  const now = new Date().toISOString();
  const currentPath = inventory.repository.currentCheckout;
  const concurrentWork =
    inventory.policy.value.concurrentWork === "strict"
      ? "strict"
      : "allow-claimed";
  const coordination = readCoordinationDocumentFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  const primaryBranch =
    inventory.worktrees.find((worktree) => worktree.isPrimary)?.branch ?? null;
  // Each registration, and the opening inventory below, records the
  // worktree's branch, so a branch that is not exact refuses the start
  // and names the worktree.
  const worktrees = inventory.worktrees.map((worktree) => {
    if (worktree.path === currentPath) {
      return exactWorktreeLease(worktree, "controller", agentId, false);
    }
    const claim = concurrentClaimFor(
      {
        commonGitDirectory: inventory.repository.commonGitDirectory,
        concurrentWork,
        primaryCheckout: inventory.repository.primaryCheckout,
      },
      worktree,
      coordination,
      primaryBranch,
      targetBranch
    );
    if (claim) {
      return {
        ...exactWorktreeLease(
          worktree,
          "concurrent-author",
          claim.owner.agentId,
          false
        ),
        claimId: claim.claimId,
      };
    }
    return exactWorktreeLease(worktree, "preserved", null, false);
  });
  const lease: LoopLease = {
    baselineDigest: inventory.baselineDigest,
    commonGitDirectory: inventory.repository.commonGitDirectory,
    concurrentWork,
    controller: {
      acquiredAt: now,
      handoffs: [],
      reason: null,
      relinquishedAt: null,
      status: "active",
    },
    createdAt: now,
    dispositions: [],
    firstMutationAt: null,
    mode: mode as LoopLease["mode"],
    openingBranches: inventory.branches.map(({ name, sha }) => ({
      name,
      sha,
    })),
    openingInvariantDigest: scopeInvariantDigest(inventory),
    ...(openingRemoteInventory ? { openingRemoteInventory } : {}),
    openingWorktrees: inventory.worktrees.map(
      ({ branch, changeDigest, headSha, path }) => ({
        branch,
        changeDigest,
        headSha,
        path,
      })
    ),
    overrides: [],
    ownerAgentId: agentId,
    preparations: [],
    primaryCheckout: inventory.repository.primaryCheckout,
    remoteBindings: inventory.repository.remoteBindings,
    runId: `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    schemaVersion: 1,
    shipmentScopeFrozenAt: null,
    shipmentScopeRequired: mode === "ship",
    targetRef: inventory.targetRef,
    targetRevision,
    updatedAt: now,
    worktrees,
  };
  if (mode === "ship" && inventory.localChanges.length === 0) {
    // Capture the clean opening baseline while both locks are held.
    // Committed and generated delivery remains explicit additionalPaths
    // in the later outcome; an empty scope proves no delivery by itself.
    const plan = buildPreviewPlan(
      inventory,
      inventory,
      compareSnapshots(inventory, inventory),
      "Capture the clean opening shipment baseline"
    );
    lease.shipmentScope = {
      openingChanges: [],
      openingInventoryDigest: inventory.baselineDigest,
      plan,
      planDigest: sha256Json(plan),
      recordedAt: now,
    };
  }
  return lease;
};

export const startLoop = (
  repositoryPath: string,
  agentIdInput: string,
  mode: RequestMode,
  openingRemoteInventoryInput?: unknown,
  options: LoopStartOptions = {}
): LoopLease => {
  const agentId = requiredText(agentIdInput, "agent ID");
  if (!LOOP_MODES.has(mode)) {
    throw new SimpleChangesError(
      "Loop mode must be queue, sweep, integrate, ship, reconcile, or resume.",
      EXIT_CODES.usage
    );
  }
  // Every start binds or refreshes the run's controller session, a repeated
  // start included, so with sessions of two harnesses in the environment the
  // command must say which is its own before it touches anything.
  const session = requireHarnessSession(
    mode === "resume" ? "loop start --mode resume" : "loop start"
  );
  const opening = locateRepository(repositoryPath);
  // The run's request layer, when one is passed, reaches resume revalidation.
  const resumeOptions =
    options.request === undefined ? {} : { request: options.request };
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop start",
    () =>
      withWorktreeCoordinationLock(
        opening.repository.commonGitDirectory,
        "loop start claim snapshot",
        () => {
          const validated = captureInventory(repositoryPath);
          const existing = readLeaseFromCommonDirectory(
            validated.repository.commonGitDirectory
          );
          const resumed = resolveExistingLoopStart(
            existing,
            validated,
            agentId,
            mode
          );
          if (resumed) {
            refreshControllerSession(resumed);
            if (mode === "resume") {
              // Beside the lease it transfers, under the loop lock it holds.
              const reviewLedger = loadReviewLedgerForResume(
                heldLoopLock(
                  validated.repository.commonGitDirectory,
                  "loop start"
                ),
                resumed.primaryCheckout,
                resumeOptions
              );
              options.onReviewLedger?.(reviewLedger);
            }
            options.onStarted?.(resumed);
            return resumed;
          }
          // The last of start validation: the controller session and any
          // existing run were settled above, and these settle the target,
          // the provider inventory, and each worktree's exact branch.
          const target = openingTarget(validated, openingRemoteInventoryInput);
          // Only a validated start clears anything, and the lease is taken
          // again from a fresh inventory when clearing changed it.
          const validatedLease = openingLease(validated, agentId, mode, target);
          const cleared = inventoryAfterQueuedRetirement(
            repositoryPath,
            validated,
            mode,
            options
          );
          const lease =
            cleared === validated
              ? validatedLease
              : openingLease(cleared, agentId, mode, target);
          const written = writeLease(lease);
          writeControllerBinding(written, {
            awaitingUser: null,
            inheritedAwaitingUser: null,
            session,
          });
          options.onStarted?.(written);
          return written;
        }
      )
  );
};
