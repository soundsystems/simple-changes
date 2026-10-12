import { randomUUID } from "node:crypto";
import type { AuthoringSidecar } from "./authoring.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { currentHarnessSession } from "./harness-session.ts";
import { sha256Json } from "./hash.ts";
import {
  captureInventory,
  compareSnapshots,
  locateRepository,
} from "./inventory.ts";
import {
  concurrentClaimFor,
  controllerLifecycle,
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
  worktreeLease,
  writeControllerBinding,
  writeLease,
} from "./loop-lease-core.ts";
import { buildPreviewPlan } from "./planner.ts";
import { runGit } from "./process.ts";
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
  /** Receives the review ledger a resume loads under the held loop lock. */
  onReviewLedger?: (state: ReviewLedgerResumeState) => void;
  /**
   * The run's `--authoring-request` (resume only): revalidation uses it
   * combined with the saved settings, so the run has one review gate.
   */
  request?: AuthoringSidecar;
}

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
          const inventory = captureInventory(repositoryPath);
          const existing = readLeaseFromCommonDirectory(
            inventory.repository.commonGitDirectory
          );
          const resumed = resolveExistingLoopStart(
            existing,
            inventory,
            agentId,
            mode
          );
          if (resumed) {
            refreshControllerSession(resumed);
            if (mode === "resume") {
              // Beside the lease it transfers, under the loop lock it holds.
              const reviewLedger = loadReviewLedgerForResume(
                heldLoopLock(
                  inventory.repository.commonGitDirectory,
                  "loop start"
                ),
                resumed.primaryCheckout,
                resumeOptions
              );
              options.onReviewLedger?.(reviewLedger);
            }
            return resumed;
          }
          const now = new Date().toISOString();
          const session = currentHarnessSession();
          const currentPath = inventory.repository.currentCheckout;
          const concurrentWork =
            inventory.policy.value.concurrentWork === "strict"
              ? "strict"
              : "allow-claimed";
          const coordination = readCoordinationDocumentFromCommonDirectory(
            inventory.repository.commonGitDirectory
          );
          const primaryBranch =
            inventory.worktrees.find((worktree) => worktree.isPrimary)
              ?.branch ?? null;
          const targetBranch = targetBranchForRef(
            inventory.repository.primaryCheckout,
            inventory.targetRef
          );
          const targetRevision = runGit(inventory.repository.primaryCheckout, [
            "rev-parse",
            "--verify",
            `${inventory.targetRef}^{commit}`,
          ]).stdout.trim();
          const openingRemoteInventory = openingRemoteInventoryForStart(
            inventory,
            openingRemoteInventoryInput,
            targetBranch,
            targetRevision
          );
          const worktrees = inventory.worktrees.map((worktree) => {
            if (worktree.path === currentPath) {
              return worktreeLease(worktree, "controller", agentId, false);
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
                ...worktreeLease(
                  worktree,
                  "concurrent-author",
                  claim.owner.agentId,
                  false
                ),
                claimId: claim.claimId,
              };
            }
            return worktreeLease(worktree, "preserved", null, false);
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
          const written = writeLease(lease);
          writeControllerBinding(written, {
            awaitingUser: null,
            inheritedAwaitingUser: null,
            session,
          });
          return written;
        }
      )
  );
};
