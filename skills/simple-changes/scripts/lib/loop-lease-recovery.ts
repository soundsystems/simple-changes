import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { targetContainsRevision } from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256, sha256Json } from "./hash.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import {
  assertControllerActive,
  assertMatchingRun,
  controllerLifecycle,
  currentTargetRevision,
  DIGEST_PATTERN,
  effectiveShipmentScopeFrozenAt,
  forgetLeaseSession,
  gitLabProjectForTargetRef,
  LEASE_STALE_AFTER_MS,
  type LoopLockOwner,
  leaseLiveness,
  loopLeasePath,
  loopLockPath,
  loopManifestDigest,
  MISSING_OPENING_REMOTE_INVENTORY_BLOCKER,
  MISSING_REMOTE_RECONCILIATION_BLOCKER,
  nothingAtPath,
  processGroupIsAlive,
  processIsAlive,
  RECOVERY_HISTORY_DIRECTORY,
  readControllerBinding,
  readImmutableRecoveryEvent,
  readLeaseFromCommonDirectory,
  readLockOwner,
  recoveryHistoryDirectory,
  recoveryHistoryPath,
  removeControllerBinding,
  requiredRunId,
  requiredText,
  requireLease,
  requireOwnedLease,
  retirementForRegistration,
  STATE_DIRECTORY,
  targetBranchForRef,
  targetUsesGitLab,
  transferController,
  withMutationEvidence,
  withStateLock,
  worktreeLease,
  writeImmutableRecoveryEvent,
  writeLease,
} from "./loop-lease-core.ts";
import {
  automaticFinalizationCleanup,
  emptyFinalizationCleanup,
  type FinalizationCleanupResult,
  loopCompletionBlockers,
  reconcilePrimarySynchronization,
  recordedOutcomeIntact,
} from "./loop-lease-finalize.ts";
import { targetTreeEntry } from "./loop-lease-shipment.ts";
import { verificationAgainst } from "./loop-lease-verify.ts";
import { assertNoSymlinkAncestors } from "./path-safety.ts";
import { validatePostCleanupRecovery } from "./remote-branch-reconciliation.ts";
import { validateSchema, validateSchemaDocument } from "./schema.ts";
import type {
  LoopCloseEquivalentWorktreeProof,
  LoopLease,
  LoopRebaselineRecord,
  LoopRebaselineRegistration,
  LoopVerification,
  LoopViolation,
  LoopWorktreeLease,
  LoopWorktreeRetirement,
  PostCleanupRecoveryReceipt,
  RepositoryInventory,
  ShipmentOutcomeReceipt,
  WorktreeInventory,
} from "./types.ts";
import {
  type AbsentWorktreeClaimRetirementPlan,
  coordinationEvidence,
  coordinationLinkIsCurrent,
  markCoordinationAdopted,
  planAbsentWorktreeClaimRetirementUnderLock,
  readCoordinationDocumentFromCommonDirectory,
  recoverStaleWorktreeCoordinationLock,
  retireAbsentWorktreeClaimsUnderLock,
  withWorktreeCoordinationLock,
  worktreeClaimDocumentDigest,
} from "./worktree-coordination.ts";

const STALE_LOCK_MINIMUM_AGE_MS = 5000;

interface PostCleanupRecoveryIntent {
  archivedAt: string;
  authority: "close-only";
  claimRetirement: AbsentWorktreeClaimRetirementPlan;
  kind: "post-cleanup-recovery";
  lease: LoopLease;
  leaseDigest: string;
  receipt: PostCleanupRecoveryReceipt;
  receiptDigest: string;
  removedWorktreePaths: string[];
  runId: string;
  schemaVersion: 1;
}

export interface LoopLockRecovery {
  coordinationRecovered: boolean;
  recovered: boolean;
  recoveredAt: string;
  staleOwner: LoopLockOwner;
}

export const recoverLoopLock = (
  repositoryPath: string,
  agentIdInput: string
): LoopLockRecovery => {
  const agentId = requiredText(agentIdInput, "agent ID");
  const inventory = captureInventory(repositoryPath);
  const { commonGitDirectory } = inventory.repository;
  const lockPath = loopLockPath(commonGitDirectory);
  if (!existsSync(lockPath)) {
    throw new SimpleChangesError(
      "No active-loop lock exists to recover.",
      EXIT_CODES.unsafe
    );
  }
  const owner = readLockOwner(commonGitDirectory);
  if (!owner) {
    throw new SimpleChangesError(
      `Cannot recover ${lockPath}: ownership metadata is missing or invalid. Inspect it manually rather than guessing.`,
      EXIT_CODES.unsafe
    );
  }
  if (owner.hostname !== hostname()) {
    throw new SimpleChangesError(
      `Cannot recover a lock owned on ${owner.hostname} from ${hostname()}.`,
      EXIT_CODES.unsafe
    );
  }
  const age = Date.now() - Date.parse(owner.createdAt);
  if (!(Number.isFinite(age) && age >= STALE_LOCK_MINIMUM_AGE_MS)) {
    throw new SimpleChangesError(
      `Cannot recover a lock younger than ${STALE_LOCK_MINIMUM_AGE_MS / 1000} seconds.`,
      EXIT_CODES.unsafe
    );
  }
  if (processIsAlive(owner.pid)) {
    throw new SimpleChangesError(
      `Cannot recover active lock owner PID ${owner.pid}.`,
      EXIT_CODES.unsafe
    );
  }
  if (owner.childStarting) {
    throw new SimpleChangesError(
      "Cannot recover a loop-exec lock whose child launch did not finish recording. Inspect the operation manually before removing the lock.",
      EXIT_CODES.unsafe
    );
  }
  if (
    owner.processGroupId !== undefined &&
    processGroupIsAlive(owner.processGroupId)
  ) {
    throw new SimpleChangesError(
      `Cannot recover active guarded process group ${owner.processGroupId}.`,
      EXIT_CODES.unsafe
    );
  }
  if (
    owner.processGroupId === undefined &&
    owner.childProcessId !== undefined &&
    processIsAlive(owner.childProcessId)
  ) {
    throw new SimpleChangesError(
      `Cannot recover active guarded child PID ${owner.childProcessId}.`,
      EXIT_CODES.unsafe
    );
  }
  const lease = readLeaseFromCommonDirectory(commonGitDirectory);
  if (lease && lease.ownerAgentId !== agentId) {
    throw new SimpleChangesError(
      `Only loop owner ${lease.ownerAgentId} may recover its dead lock.`,
      EXIT_CODES.unsafe
    );
  }
  const coordinationRecovered = recoverStaleWorktreeCoordinationLock(
    commonGitDirectory,
    owner.pid
  );
  const recoveryPath = `${lockPath}.recovery-${randomUUID()}`;
  renameSync(lockPath, recoveryPath);
  rmSync(recoveryPath, { force: true, recursive: true });
  return {
    coordinationRecovered,
    recovered: true,
    recoveredAt: new Date().toISOString(),
    staleOwner: owner,
  };
};

// Canonicalize through the nearest existing ancestor so a deleted path is
// spelled the way the lease recorded it (for example /private/var on macOS).
const canonicalAbsentPath = (pathInput: string): string => {
  const absolute = resolve(pathInput);
  let ancestor = dirname(absolute);
  const trailing: string[] = [basename(absolute)];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    trailing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return existsSync(ancestor)
    ? join(realpathSync(ancestor), ...trailing)
    : absolute;
};

export const takeoverLoop = (
  repositoryPath: string,
  runIdInput: string,
  nextAgentIdInput: string,
  expectedManifestDigestInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const runId = requiredRunId(runIdInput);
  const nextAgentId = requiredText(nextAgentIdInput, "agent ID");
  const expectedManifestDigest = requiredText(
    expectedManifestDigestInput,
    "manifest digest"
  );
  const approvedBy = requiredText(approvedByInput, "approver");
  const reason = requiredText(reasonInput, "takeover reason");
  if (!DIGEST_PATTERN.test(expectedManifestDigest)) {
    throw new SimpleChangesError(
      "manifest digest must be a lowercase SHA-256 value.",
      EXIT_CODES.usage
    );
  }
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop takeover",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = readLeaseFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      if (!lease) {
        throw new SimpleChangesError(
          "No active Simple Changes integration loop was found.",
          EXIT_CODES.unsafe
        );
      }
      assertMatchingRun(lease, runId);
      const actualManifestDigest = loopManifestDigest(lease);
      if (actualManifestDigest !== expectedManifestDigest) {
        throw new SimpleChangesError(
          `Active-loop manifest digest changed: expected ${expectedManifestDigest}, observed ${actualManifestDigest}. Re-inspect before authorizing takeover.`,
          EXIT_CODES.unsafe
        );
      }
      if (lease.ownerAgentId === nextAgentId) {
        throw new SimpleChangesError(
          `${nextAgentId} already owns ${runId}; takeover requires a different controller. Next: continue directly as the current controller, or run \`simple-changes loop close-equivalent --run-id ${runId} --approved-by <you> --reason <why>\` if the work is already contained in the target.`,
          EXIT_CODES.usage
        );
      }
      return transferController(
        lease,
        inventory,
        nextAgentId,
        "takeover",
        reason,
        approvedBy
      );
    }
  );
};

const registrationKind = (
  lease: LoopLease,
  registered: LoopWorktreeLease
): LoopWorktreeRetirement["registration"] => {
  if (
    (lease.rebaselines ?? []).some((record) =>
      record.registered.some((item) => item.path === registered.path)
    )
  ) {
    return "rebaseline";
  }
  return registered.claimId ? "adopted" : "opening";
};

/**
 * Accounts for a preserved registration whose checkout another task removed.
 * The path must be absent from disk and from Git's live worktree list; the
 * record is bound to the exact registered baseline and to named approval.
 * Nothing is deleted, no delivery is proven, and no branch cleanup follows.
 */
export const retireAbsentWorktree = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pathInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approved-by identity");
  const reason = requiredText(reasonInput, "retirement reason");
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop retire-absent-worktree",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "retire an absent worktree"
      );
      assertControllerActive(lease);
      const path = existsSync(pathInput)
        ? realpathSync(pathInput)
        : canonicalAbsentPath(pathInput);
      if (path === lease.primaryCheckout) {
        throw new SimpleChangesError(
          "The canonical primary checkout cannot be retired by the active loop.",
          EXIT_CODES.unsafe
        );
      }
      const registered = lease.worktrees.find(
        (worktree) => worktree.path === path
      );
      if (registered?.role !== "preserved" || registered.createdByRun) {
        throw new SimpleChangesError(
          `Retirement path must name a preserved registration that this run did not create (an opening, rebaselined, or adopted worktree): ${path}`,
          EXIT_CODES.unsafe
        );
      }
      if (!nothingAtPath(path)) {
        throw new SimpleChangesError(
          `Worktree ${path} still exists on disk. Retirement records an absence; use loop allow, loop retain-worktree, or loop dispose-worktree for a checkout that is present.`,
          EXIT_CODES.unsafe
        );
      }
      const current = inventory.worktrees.find(
        (worktree) => worktree.path === path
      );
      if (current && !current.prunable) {
        throw new SimpleChangesError(
          `Git still lists ${path} as a live worktree. Retirement requires the checkout to be absent from both the filesystem and the worktree list.`,
          EXIT_CODES.unsafe
        );
      }
      const existing = retirementForRegistration(lease, registered);
      if (existing) {
        return lease;
      }
      const now = new Date().toISOString();
      const retirement: LoopWorktreeRetirement = {
        absenceCheckedAt: now,
        actorAgentId: ownerAgentId,
        approvedBy,
        baselineChangeDigest: registered.baselineChangeDigest,
        baselineHeadSha: registered.baselineHeadSha,
        branch: registered.branch,
        createdAt: now,
        path,
        reason,
        registration: registrationKind(lease, registered),
        targetRef: lease.targetRef,
        targetRevision: currentTargetRevision(lease),
      };
      writeImmutableRecoveryEvent(
        resolve(
          recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
          `worktree-retirement-${sha256Json(retirement)}.json`
        ),
        { retirement, runId: lease.runId }
      );
      return writeLease({
        ...withMutationEvidence(lease, now),
        retirements: [...(lease.retirements ?? []), retirement],
        updatedAt: now,
      });
    }
  );
};

const exactPausedEvidence = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pauseReceiptIdInput: string
): {
  claimId: string;
  current: WorktreeInventory;
  pauseReceiptId: string;
} => {
  const pauseReceiptId = requiredText(pauseReceiptIdInput, "pause receipt ID");
  const { claim, receipt } = coordinationEvidence(
    lease.commonGitDirectory,
    pauseReceiptId
  );
  if (
    claim.commonGitDirectory !== lease.commonGitDirectory ||
    receipt.requestingRunId !== lease.runId ||
    !["paused", "adopted-preserved"].includes(claim.state)
  ) {
    throw new SimpleChangesError(
      "Pause receipt does not belong to this active loop and paused claim.",
      EXIT_CODES.unsafe
    );
  }
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === receipt.path
  );
  if (
    !(
      current &&
      coordinationLinkIsCurrent(
        lease.commonGitDirectory,
        claim.claimId,
        pauseReceiptId,
        current
      )
    )
  ) {
    throw new SimpleChangesError(
      "Pause receipt no longer matches current worktree evidence.",
      EXIT_CODES.unsafe
    );
  }
  return { claimId: claim.claimId, current, pauseReceiptId };
};

// Registered entries that `loop accept-paused-change` may record.
const ACCEPTABLE_PAUSED_ROLES: ReadonlySet<LoopWorktreeLease["role"]> = new Set(
  ["concurrent-author", "preserved", "retained"]
);

// The per-checkout violations that recording that checkout resolves.
// Repository-wide violations are reported at the checkout a command runs in,
// so they never qualify.
const RECORDABLE_SIBLING_CODES: ReadonlySet<LoopViolation["code"]> = new Set([
  "coordination-claim-stale",
  "preserved-worktree-changed",
  "registered-worktree-branch-changed",
  "retained-worktree-authorization-missing",
  "retained-worktree-changed",
  "unregistered-worktree",
]);

// A sibling checkout that adoption or acceptance could record next, and whose
// exact current state its own valid current pause receipt for this run
// covers, is waiting for its own turn: its per-checkout violations do not
// block recording another path, so several receipted checkouts can be
// recorded one at a time in any order. Its own entry keeps failing
// verification until it is recorded too. Every other violation still blocks.
const isReceiptedSiblingViolation = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  violation: LoopViolation,
  recordingPath: string
): boolean => {
  if (
    violation.path === recordingPath ||
    !RECORDABLE_SIBLING_CODES.has(violation.code)
  ) {
    return false;
  }
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === violation.path
  );
  const recordable = registered
    ? !registered.createdByRun && ACCEPTABLE_PAUSED_ROLES.has(registered.role)
    : violation.code === "unregistered-worktree";
  if (!recordable) {
    return false;
  }
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === violation.path
  );
  if (!current) {
    return false;
  }
  const document = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  return document.receipts.some((receipt) => {
    if (
      receipt.path !== violation.path ||
      receipt.requestingRunId !== lease.runId
    ) {
      return false;
    }
    const claim = document.claims.find(
      (item) => item.claimId === receipt.claimId
    );
    return Boolean(
      claim &&
        claim.commonGitDirectory === lease.commonGitDirectory &&
        ["paused", "adopted-preserved"].includes(claim.state) &&
        coordinationLinkIsCurrent(
          lease.commonGitDirectory,
          claim.claimId,
          receipt.receiptId,
          current
        )
    );
  });
};

export const adoptPausedWorktree = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pauseReceiptIdInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop adopt-worktree",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "adopt a paused worktree"
      );
      assertControllerActive(lease);
      const evidence = exactPausedEvidence(
        lease,
        inventory,
        pauseReceiptIdInput
      );
      if (
        lease.worktrees.some(
          (worktree) => worktree.path === evidence.current.path
        )
      ) {
        throw new SimpleChangesError(
          "loop adopt-worktree requires a current unregistered worktree.",
          EXIT_CODES.unsafe
        );
      }
      const adopted: LoopWorktreeLease = {
        ...worktreeLease(evidence.current, "preserved", null, false),
        claimId: evidence.claimId,
        coordinationState: "adopted-preserved",
        pauseReceiptId: evidence.pauseReceiptId,
      };
      const candidate: LoopLease = {
        ...lease,
        updatedAt: new Date().toISOString(),
        worktrees: [...lease.worktrees, adopted],
      };
      const verification = verificationAgainst(candidate, inventory);
      const blocking = verification.violations.filter(
        (violation) =>
          !isReceiptedSiblingViolation(
            lease,
            inventory,
            violation,
            evidence.current.path
          )
      );
      if (blocking.length > 0) {
        throw new SimpleChangesError(
          `Paused worktree is exact but other loop violations remain: ${blocking
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      markCoordinationAdopted(
        lease.commonGitDirectory,
        evidence.claimId,
        evidence.pauseReceiptId,
        ownerAgentId
      );
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
    }
  );
};

export interface LoopRebaselineResult {
  lease: LoopLease;
  rebaseline: LoopRebaselineRecord;
  verification: LoopVerification;
}

/**
 * Re-baseline the active loop's worktree manifest to current reality. Every
 * worktree that appeared after loop start without run registration is
 * registered as preserved at its exact current state, so the run can proceed
 * or close instead of deadlocking on a stale opening manifest. Registered
 * late arrivals stay owner-controlled and untouched: any later change to one
 * still fails verification until its owner coordinates or the user approves
 * an exact override.
 */
export const rebaselineLoopWorktrees = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopRebaselineResult => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approved-by identity");
  const reason = requiredText(reasonInput, "rebaseline reason");
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop rebaseline",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "re-baseline the worktree manifest. Next: run `simple-changes loop takeover` first if this controller is being resumed by a different agent"
      );
      assertControllerActive(lease);
      const lateArrivalPaths = new Set(
        verificationAgainst(lease, inventory)
          .violations.filter(
            (violation) => violation.code === "unregistered-worktree"
          )
          .map((violation) => violation.path)
      );
      const additions = inventory.worktrees.filter((worktree) =>
        lateArrivalPaths.has(worktree.path)
      );
      if (additions.length === 0) {
        throw new SimpleChangesError(
          `Loop ${lease.runId} has no unregistered late-arrival worktrees; there is nothing to re-baseline. Nothing was changed.`,
          EXIT_CODES.unsafe
        );
      }
      const recordedAt = new Date().toISOString();
      const registered: LoopRebaselineRegistration[] = additions.map(
        (worktree) => ({
          changeDigest: worktree.changeDigest,
          headSha: worktree.headSha,
          path: worktree.path,
        })
      );
      const rebaseline: LoopRebaselineRecord = {
        approvedBy,
        reason,
        recordedAt,
        registered,
      };
      const candidate: LoopLease = {
        ...lease,
        rebaselines: [...(lease.rebaselines ?? []), rebaseline],
        updatedAt: recordedAt,
        worktrees: [
          ...lease.worktrees,
          ...additions.map((worktree) =>
            worktreeLease(worktree, "preserved", null, false)
          ),
        ],
      };
      const updated = writeLease(
        withMutationEvidence(candidate, candidate.updatedAt)
      );
      return {
        lease: updated,
        rebaseline,
        verification: verificationAgainst(updated, inventory),
      };
    }
  );
};

export const acceptPausedWorktreeChange = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pauseReceiptIdInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop accept-paused-change",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "accept a paused change"
      );
      assertControllerActive(lease);
      const evidence = exactPausedEvidence(
        lease,
        inventory,
        pauseReceiptIdInput
      );
      const registered = lease.worktrees.find(
        (worktree) =>
          worktree.path === evidence.current.path &&
          !worktree.createdByRun &&
          ACCEPTABLE_PAUSED_ROLES.has(worktree.role)
      );
      if (!registered) {
        throw new SimpleChangesError(
          "loop accept-paused-change requires an opening preserved, retained, or concurrent-author worktree.",
          EXIT_CODES.unsafe
        );
      }
      const accepted: LoopWorktreeLease = {
        ...worktreeLease(evidence.current, "preserved", null, false),
        claimId: evidence.claimId,
        coordinationState: "adopted-preserved",
        pauseReceiptId: evidence.pauseReceiptId,
      };
      const candidate: LoopLease = {
        ...lease,
        updatedAt: new Date().toISOString(),
        worktrees: lease.worktrees.map((worktree) =>
          worktree.path === evidence.current.path ? accepted : worktree
        ),
      };
      const verification = verificationAgainst(candidate, inventory);
      const blocking = verification.violations.filter(
        (violation) =>
          !(
            (violation.code === "coordination-claim-stale" &&
              violation.path !== evidence.current.path) ||
            isReceiptedSiblingViolation(
              lease,
              inventory,
              violation,
              evidence.current.path
            )
          )
      );
      if (blocking.length > 0) {
        throw new SimpleChangesError(
          `Paused change is exact but other loop violations remain: ${blocking
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      markCoordinationAdopted(
        lease.commonGitDirectory,
        evidence.claimId,
        evidence.pauseReceiptId,
        ownerAgentId
      );
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
    }
  );
};

export interface PostCleanupRecoveryResult {
  active: false;
  archivedAt: string;
  ok: true;
  retiredClaimIds: string[];
  runId: string;
  violations: [];
}

const completedPostCleanupRecovery = (
  commonGitDirectory: string,
  runId: string,
  receiptDigests: readonly string[]
): PostCleanupRecoveryResult | null => {
  const completedPath = recoveryHistoryPath(
    commonGitDirectory,
    runId,
    "completed"
  );
  if (
    !existsSync(completedPath) ||
    existsSync(loopLeasePath(commonGitDirectory))
  ) {
    return null;
  }
  const completed = readImmutableRecoveryEvent<{
    archivedAt: string;
    receiptDigest: string;
    retiredClaimIds: string[];
  }>(completedPath);
  if (!receiptDigests.includes(completed.receiptDigest)) {
    throw new SimpleChangesError(
      "Post-cleanup recovery was already completed with different evidence.",
      EXIT_CODES.unsafe
    );
  }
  return {
    active: false,
    archivedAt: completed.archivedAt,
    ok: true,
    retiredClaimIds: completed.retiredClaimIds,
    runId,
    violations: [],
  };
};

const postCleanupAbsentPaths = (
  inventory: RepositoryInventory,
  lease: LoopLease,
  ownerAgentId: string,
  receipt: PostCleanupRecoveryReceipt,
  postRetirementClaimDigest?: string
): string[] => {
  if (lease.ownerAgentId !== ownerAgentId) {
    throw new SimpleChangesError(
      `Only loop owner ${lease.ownerAgentId} may recover this bookkeeping record.`,
      EXIT_CODES.unsafe
    );
  }
  assertControllerActive(lease);
  if (lease.openingRemoteInventory) {
    throw new SimpleChangesError(
      "Post-cleanup recovery is only for a legacy run whose opening remote inventory is unavailable.",
      EXIT_CODES.usage
    );
  }
  const targetBranch = targetBranchForRef(
    inventory.repository.primaryCheckout,
    lease.targetRef
  );
  const targetRevision = currentTargetRevision(lease);
  const project = gitLabProjectForTargetRef(
    inventory.repository.primaryCheckout,
    lease.targetRef
  );
  if (
    receipt.project !== project ||
    receipt.targetBranch !== targetBranch ||
    receipt.targetRevision !== targetRevision
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery must bind the exact current GitLab project, target branch, and target revision.",
      EXIT_CODES.validation
    );
  }
  const verification = verificationAgainst(lease, inventory);
  const recoverableMissingCreatedWorktrees = new Set(
    lease.worktrees
      .filter(
        (worktree) =>
          worktree.createdByRun &&
          worktree.role === "preserved" &&
          !inventory.worktrees.some(
            (current) => current.path === worktree.path
          ) &&
          targetContainsRevision(
            inventory.repository.primaryCheckout,
            targetRevision,
            worktree.baselineHeadSha
          )
      )
      .map((worktree) => worktree.path)
  );
  const currentPrimary = inventory.worktrees.find(
    (worktree) => worktree.path === inventory.repository.primaryCheckout
  );
  const recoverableCurrentPrimaryBranch = Boolean(
    currentPrimary &&
      currentPrimary.branch === targetBranch &&
      currentPrimary.headSha === targetRevision &&
      currentPrimary.changes.length === 0
  );
  const remainingViolations = verification.violations.filter((violation) => {
    if (
      violation.code === "missing-preserved-worktree" &&
      recoverableMissingCreatedWorktrees.has(violation.path)
    ) {
      return false;
    }
    if (
      violation.code === "registered-worktree-branch-changed" &&
      violation.path === inventory.repository.primaryCheckout &&
      recoverableCurrentPrimaryBranch
    ) {
      return false;
    }
    return true;
  });
  if (remainingViolations.length > 0) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close while controller manifest violations remain.",
      EXIT_CODES.unsafe
    );
  }
  const recoveryVerification: LoopVerification = {
    ...verification,
    ok: true,
    violations: [],
  };
  const coordination = readCoordinationDocumentFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  const activeClaims = coordination.claims.filter(
    (claim) => claim.state === "active"
  );
  if (activeClaims.length !== receipt.secondClaimObservation.activeClaimCount) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close because the active worktree claim count changed after the approved observations.",
      EXIT_CODES.unsafe
    );
  }
  const currentPaths = new Set(
    inventory.worktrees.map((worktree) => worktree.path)
  );
  if (activeClaims.some((claim) => !currentPaths.has(claim.path))) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close while an active claim names an absent worktree.",
      EXIT_CODES.unsafe
    );
  }
  const currentClaimDigest = worktreeClaimDocumentDigest(coordination);
  const retirementAlreadyApplied =
    postRetirementClaimDigest !== undefined &&
    currentClaimDigest === postRetirementClaimDigest;
  if (
    currentClaimDigest !== receipt.secondClaimObservation.digest &&
    !retirementAlreadyApplied
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close because worktree claims changed after the approved observations.",
      EXIT_CODES.unsafe
    );
  }
  const firstObservation = Date.parse(receipt.firstFinalInventory.observedAt);
  if (
    !retirementAlreadyApplied &&
    coordination.claims.some(
      (claim) => Date.parse(claim.updatedAt) > firstObservation
    )
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close because a worktree claim changed during or after the approved observation window.",
      EXIT_CODES.unsafe
    );
  }
  const blockers = loopCompletionBlockers(
    lease,
    inventory,
    recoveryVerification
  ).filter(
    (blocker) =>
      blocker !== MISSING_OPENING_REMOTE_INVENTORY_BLOCKER &&
      blocker !== MISSING_REMOTE_RECONCILIATION_BLOCKER
  );
  if (blockers.length > 0) {
    throw new SimpleChangesError(
      `Post-cleanup recovery is close-only and cannot proceed while cleanup remains: ${blockers.join(" ")}`,
      EXIT_CODES.unsafe
    );
  }
  return lease.worktrees
    .map((worktree) => worktree.path)
    .filter((path) => !currentPaths.has(path))
    .sort((left, right) => left.localeCompare(right));
};

const preparePostCleanupRecoveryIntent = (
  commonGitDirectory: string,
  inventory: RepositoryInventory,
  lease: LoopLease,
  ownerAgentId: string,
  receipt: PostCleanupRecoveryReceipt,
  canonicalReceiptDigest: string,
  legacyReceiptDigest: string
): { absentPaths: string[]; intent: PostCleanupRecoveryIntent } => {
  const intentPath = recoveryHistoryPath(
    commonGitDirectory,
    lease.runId,
    "intent"
  );
  const existingIntent = existsSync(intentPath)
    ? readImmutableRecoveryEvent<PostCleanupRecoveryIntent>(intentPath)
    : null;
  // An intent recorded by an earlier version carries the key-order-sensitive
  // digest; keep using it so that interrupted recovery can still resume.
  const receiptDigest =
    existingIntent?.receiptDigest === legacyReceiptDigest
      ? legacyReceiptDigest
      : canonicalReceiptDigest;
  const absentPaths = postCleanupAbsentPaths(
    inventory,
    lease,
    ownerAgentId,
    receipt,
    existingIntent?.claimRetirement.afterDigest
  );
  const archivedAt = existingIntent?.archivedAt ?? new Date().toISOString();
  const leaseDigest = loopManifestDigest(lease);
  const claimRetirement =
    existingIntent?.claimRetirement ??
    planAbsentWorktreeClaimRetirementUnderLock(
      commonGitDirectory,
      absentPaths,
      ownerAgentId,
      archivedAt
    );
  const intent = writeImmutableRecoveryEvent<PostCleanupRecoveryIntent>(
    intentPath,
    {
      archivedAt,
      authority: "close-only",
      claimRetirement,
      kind: "post-cleanup-recovery",
      lease,
      leaseDigest,
      receipt,
      receiptDigest,
      removedWorktreePaths: absentPaths,
      runId: lease.runId,
      schemaVersion: 1,
    }
  );
  if (
    intent.receiptDigest !== receiptDigest ||
    intent.leaseDigest !== leaseDigest ||
    intent.runId !== lease.runId ||
    intent.authority !== "close-only" ||
    intent.kind !== "post-cleanup-recovery" ||
    typeof intent.claimRetirement !== "object" ||
    intent.claimRetirement === null ||
    intent.claimRetirement.beforeDigest !==
      receipt.secondClaimObservation.digest ||
    JSON.stringify(intent.removedWorktreePaths) !== JSON.stringify(absentPaths)
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery intent already exists with different evidence.",
      EXIT_CODES.unsafe
    );
  }
  return { absentPaths, intent };
};

export const recoverPostCleanupLoop = (
  repositoryPath: string,
  runIdInput: string,
  ownerAgentIdInput: string,
  receiptInput: unknown
): PostCleanupRecoveryResult => {
  const runId = requiredRunId(runIdInput);
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const receipt: PostCleanupRecoveryReceipt =
    validatePostCleanupRecovery(receiptInput);
  const opening = locateRepository(repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withStateLock(commonGitDirectory, "post-cleanup recovery", () => {
    const receiptDigest = sha256Json(receipt);
    // Earlier versions digested the receipt with key-order-sensitive
    // JSON.stringify; accept that digest too so recovery evidence recorded
    // under the old version still matches.
    const legacyReceiptDigest = sha256(JSON.stringify(receipt));
    const prior = completedPostCleanupRecovery(commonGitDirectory, runId, [
      receiptDigest,
      legacyReceiptDigest,
    ]);
    if (prior) {
      return prior;
    }
    return withWorktreeCoordinationLock(
      commonGitDirectory,
      "post-cleanup recovery close",
      () => {
        const inventory = captureInventory(repositoryPath);
        const lease = requireLease(inventory);
        assertMatchingRun(lease, runId);
        const { absentPaths, intent } = preparePostCleanupRecoveryIntent(
          commonGitDirectory,
          inventory,
          lease,
          ownerAgentId,
          receipt,
          receiptDigest,
          legacyReceiptDigest
        );
        if (
          process.env.NODE_ENV === "test" &&
          process.env.SIMPLE_CHANGES_TEST_CRASH_AFTER_POST_CLEANUP_INTENT ===
            runId
        ) {
          process.kill(process.pid, "SIGKILL");
        }
        const retiredClaimIds = retireAbsentWorktreeClaimsUnderLock(
          commonGitDirectory,
          absentPaths,
          ownerAgentId,
          intent.claimRetirement
        );
        if (
          process.env.NODE_ENV === "test" &&
          process.env
            .SIMPLE_CHANGES_TEST_CRASH_AFTER_POST_CLEANUP_RETIREMENT === runId
        ) {
          process.kill(process.pid, "SIGKILL");
        }
        const completed = writeImmutableRecoveryEvent(
          recoveryHistoryPath(commonGitDirectory, runId, "completed"),
          {
            archivedAt: intent.archivedAt,
            authority: "close-only",
            kind: "post-cleanup-recovery-completed",
            receiptDigest: intent.receiptDigest,
            retiredClaimIds,
            runId,
            schemaVersion: 1,
          }
        );
        if (completed.receiptDigest !== intent.receiptDigest) {
          throw new SimpleChangesError(
            "Post-cleanup recovery completion evidence does not match the approved receipt.",
            EXIT_CODES.unsafe
          );
        }
        rmSync(loopLeasePath(commonGitDirectory), { force: true });
        return {
          active: false,
          archivedAt: completed.archivedAt,
          ok: true,
          retiredClaimIds: completed.retiredClaimIds,
          runId,
          violations: [],
        };
      }
    );
  });
};

const closeEquivalentSchemaDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../evals/schemas"
);

const closeEquivalentRecordSchema = JSON.parse(
  readFileSync(
    resolve(
      closeEquivalentSchemaDirectory,
      "loop-close-equivalent.schema.json"
    ),
    "utf8"
  )
) as Record<string, unknown>;

/**
 * Local shape of the read-only `worktree-equivalence` audit receipt produced
 * by a separate command. Defined here on purpose instead of importing it, so
 * this module keeps working when that command and its module are absent.
 */
interface WorktreeEquivalenceReceipt {
  changeDigest: string;
  commits: Array<{
    matched: boolean;
    matchedTargetSha?: string;
    patchId: string;
    sha: string;
  }>;
  disclaimer: string;
  equivalence: "contained" | "divergent" | "partial";
  head: string;
  mergeBase: string;
  paths: Array<{
    path: string;
    state: "absent-in-target" | "differs" | "identical";
  }>;
  targetRef: string;
  targetRevision: string;
}

export interface LoopEquivalenceEvidence {
  receipt: unknown;
  worktreePath: string;
}

export interface LoopCloseEquivalentRecord {
  approvedBy: string;
  archivedAt: string;
  authority: "close-equivalent";
  kind: "loop-close-equivalent";
  leaseDigest: string;
  outcome: "target-equivalent";
  reason: string;
  remoteReconciliationSkipped: string;
  runId: string;
  schemaVersion: 1;
  targetRef: string;
  targetRevision: string;
  worktrees: LoopCloseEquivalentWorktreeProof[];
}

export interface LoopTargetEquivalentCloseResult {
  archivedAt: string;
  cleanup: FinalizationCleanupResult;
  outcome: "target-equivalent";
  runId: string;
  worktrees: LoopCloseEquivalentWorktreeProof[];
}

const worktreeEquivalenceSchema = (): Record<string, unknown> | null => {
  const overridePath =
    process.env.NODE_ENV === "test"
      ? process.env.SIMPLE_CHANGES_TEST_WORKTREE_EQUIVALENCE_SCHEMA
      : undefined;
  const path =
    overridePath ??
    resolve(closeEquivalentSchemaDirectory, "worktree-equivalence.schema.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const isEquivalenceReceiptShape = (
  value: unknown
): value is WorktreeEquivalenceReceipt => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.targetRef === "string" &&
    typeof record.targetRevision === "string" &&
    typeof record.mergeBase === "string" &&
    typeof record.head === "string" &&
    typeof record.changeDigest === "string" &&
    Array.isArray(record.commits) &&
    Array.isArray(record.paths) &&
    typeof record.disclaimer === "string" &&
    (record.equivalence === "contained" ||
      record.equivalence === "partial" ||
      record.equivalence === "divergent")
  );
};

const equivalenceReceiptProof = (
  schema: Record<string, unknown> | null,
  rawReceipt: unknown,
  current: WorktreeInventory,
  primaryCheckout: string,
  targetRevision: string
): { failure: string } | { proof: LoopCloseEquivalentWorktreeProof } => {
  if (!schema) {
    return {
      failure:
        "an equivalence receipt was provided, but the worktree-equivalence schema is not installed, so the receipt cannot be used as evidence; only strict target containment applies",
    };
  }
  let validated: unknown;
  try {
    validated = validateSchemaDocument<unknown>(
      "worktree-equivalence",
      schema,
      rawReceipt
    );
  } catch (error) {
    return {
      failure: `the provided equivalence receipt is not a valid worktree-equivalence result (${error instanceof Error ? error.message : "unreadable receipt"})`,
    };
  }
  if (!isEquivalenceReceiptShape(validated)) {
    return {
      failure:
        "the provided equivalence receipt does not have the expected worktree-equivalence shape",
    };
  }
  if (validated.equivalence !== "contained") {
    return {
      failure: `the equivalence receipt reports "${validated.equivalence}", not "contained"`,
    };
  }
  if (!current.headSha || validated.head !== current.headSha) {
    return {
      failure: `the equivalence receipt is stale: it recorded head ${validated.head}, but the worktree is now at ${current.headSha ?? "(unknown)"}`,
    };
  }
  if (validated.changeDigest !== current.changeDigest) {
    return {
      failure: `the equivalence receipt is stale: its recorded worktree digest ${validated.changeDigest} does not match the current digest ${current.changeDigest}`,
    };
  }
  if (
    !targetContainsRevision(
      primaryCheckout,
      targetRevision,
      validated.targetRevision
    )
  ) {
    return {
      failure: `the equivalence receipt is stale: its recorded target revision ${validated.targetRevision} is not contained in the refreshed target`,
    };
  }
  return {
    proof: {
      headSha: current.headSha,
      method: "equivalence-receipt",
      path: current.path,
      receiptDigest: sha256Json(rawReceipt),
    },
  };
};

// Every scoped source worktree owes delivery proof, even one registered as
// preserved, so a frozen-scope close never treats scoped work as unrelated.
const closeEquivalentObligatedPaths = (lease: LoopLease): string[] => {
  const obligated = new Set<string>(
    lease.shipmentScope?.plan.units.map((unit) => unit.sourceWorktree) ?? []
  );
  for (const registered of lease.worktrees) {
    const eligible =
      registered.role === "controller" ||
      registered.role === "author" ||
      registered.createdByRun;
    if (eligible) {
      obligated.add(registered.path);
    }
  }
  for (const preparation of lease.preparations) {
    const path = existsSync(preparation.path)
      ? realpathSync(preparation.path)
      : preparation.path;
    obligated.add(path);
  }
  return [...obligated].sort((left, right) => left.localeCompare(right));
};

/**
 * An obligated worktree this run itself removed after an audited
 * `remove-after-audit` disposition is proven when its path is gone from disk
 * and the refreshed target still contains both the audited target and the
 * removed head. A patch-equivalent removal is not re-proven this way and
 * blocks the close.
 */
export const completedRemovalProofForPath = (
  lease: LoopLease,
  path: string,
  targetRevision: string,
  contains: (
    repositoryPath: string,
    targetRevision: string,
    revision: string
  ) => boolean = targetContainsRevision
): LoopCloseEquivalentWorktreeProof | null => {
  // lstat, not existsSync: a dangling symlink recreated at the path is present.
  if (lstatSync(path, { throwIfNoEntry: false })) {
    return null;
  }
  const disposition = (lease.dispositions ?? []).find(
    (item) =>
      item.path === path &&
      item.outcome === "remove-after-audit" &&
      item.status === "completed" &&
      item.targetRef === lease.targetRef &&
      contains(lease.primaryCheckout, targetRevision, item.targetRevision) &&
      contains(lease.primaryCheckout, targetRevision, item.headSha)
  );
  return disposition
    ? { headSha: disposition.headSha, method: "target-ancestry", path }
    : null;
};

const equivalenceReceiptsByPath = (
  evidence: readonly LoopEquivalenceEvidence[]
): Map<string, unknown> =>
  new Map(
    evidence.map((item) => [
      existsSync(item.worktreePath)
        ? realpathSync(item.worktreePath)
        : resolve(item.worktreePath),
      item.receipt,
    ])
  );

const proveNothingLeftToShip = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string,
  equivalenceEvidence: readonly LoopEquivalenceEvidence[]
): LoopCloseEquivalentWorktreeProof[] => {
  const schema = worktreeEquivalenceSchema();
  const receiptsByPath = equivalenceReceiptsByPath(equivalenceEvidence);
  const currentByPath = new Map(
    inventory.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const proofs: LoopCloseEquivalentWorktreeProof[] = [];
  const unproven: string[] = [];
  for (const path of closeEquivalentObligatedPaths(lease)) {
    const current = currentByPath.get(path);
    if (!current) {
      const removalProof = completedRemovalProofForPath(
        lease,
        path,
        targetRevision
      );
      if (removalProof) {
        proofs.push(removalProof);
        continue;
      }
      unproven.push(
        `${path}: the obligated worktree is missing and no exact absence/branch-containment recovery evidence exists`
      );
      continue;
    }
    if (
      current.changes.length === 0 &&
      current.headSha &&
      targetContainsRevision(
        lease.primaryCheckout,
        targetRevision,
        current.headSha
      )
    ) {
      proofs.push({
        headSha: current.headSha,
        method: "target-ancestry",
        path,
      });
      continue;
    }
    const rawReceipt = receiptsByPath.get(path);
    if (rawReceipt !== undefined) {
      const assessed = equivalenceReceiptProof(
        schema,
        rawReceipt,
        current,
        lease.primaryCheckout,
        targetRevision
      );
      if ("proof" in assessed) {
        proofs.push(assessed.proof);
        continue;
      }
      unproven.push(`${path}: ${assessed.failure}`);
      continue;
    }
    unproven.push(
      current.changes.length > 0
        ? `${path}: the worktree has uncommitted changes and no equivalence receipt was provided`
        : `${path}: HEAD ${current.headSha ?? "(unknown)"} has commits that are not contained in the refreshed target and no equivalence receipt was provided`
    );
  }
  if (unproven.length > 0) {
    throw new SimpleChangesError(
      `Cannot close ${lease.runId} as target-equivalent; nothing-to-ship is unproven for: ${unproven.join("; ")}. Nothing was changed. Next: resume the loop to ship or preserve the remaining work, or provide a current worktree-equivalence receipt whose equivalence is "contained" for each listed path and run \`simple-changes loop close-equivalent\` again.`,
      EXIT_CODES.unsafe
    );
  }
  return proofs.sort((left, right) => left.path.localeCompare(right.path));
};

const priorTargetEquivalentClose = (
  commonGitDirectory: string,
  runId: string,
  archivePath: string
): LoopTargetEquivalentCloseResult | null => {
  if (
    existsSync(loopLeasePath(commonGitDirectory)) ||
    !existsSync(archivePath)
  ) {
    return null;
  }
  const prior =
    readImmutableRecoveryEvent<LoopCloseEquivalentRecord>(archivePath);
  if (prior.runId !== runId || prior.kind !== "loop-close-equivalent") {
    throw new SimpleChangesError(
      "A different terminal closure record already exists for this run.",
      EXIT_CODES.unsafe
    );
  }
  return {
    archivedAt: prior.archivedAt,
    cleanup: emptyFinalizationCleanup(),
    outcome: "target-equivalent",
    runId,
    worktrees: prior.worktrees,
  };
};

const assertTargetEquivalentRemoteReconciliation = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string
): void => {
  if (!targetUsesGitLab(inventory)) {
    return;
  }
  const reconciliation = lease.remoteBranchReconciliation;
  if (
    !reconciliation?.finalInventoryComplete ||
    reconciliation.targetRevision !== targetRevision
  ) {
    throw new SimpleChangesError(
      `Cannot close ${lease.runId} as target-equivalent until a complete final GitLab branch/proposal reconciliation is recorded for ${targetRevision}. This recovery path cannot infer that no provider mutation occurred.`,
      EXIT_CODES.unsafe
    );
  }
};

/**
 * A frozen-scope close answers for its own shipment obligations, not for
 * unrelated preserved or retained work: an unclaimed, unpaused checkout outside
 * the obligations may go missing or change without blocking the close. The
 * primary checkout is never unrelated, because finalization and cleanup act on
 * it. Claim, authorization, and coordination violations still block, and
 * before the scope freezes every violation does.
 */
export const frozenRecoveryBlockingViolations = (
  lease: LoopLease,
  verification: LoopVerification
): LoopVerification["violations"] => {
  if (!effectiveShipmentScopeFrozenAt(lease)) {
    return verification.violations;
  }
  const obligated = new Set(closeEquivalentObligatedPaths(lease));
  return verification.violations.filter((violation) => {
    const registered = lease.worktrees.find(
      (item) => item.path === violation.path
    );
    return !(
      registered &&
      violation.path !== lease.primaryCheckout &&
      !obligated.has(violation.path) &&
      !registered.claimId &&
      !registered.pauseReceiptId &&
      ["preserved", "retained"].includes(registered.role) &&
      [
        "missing-preserved-worktree",
        "missing-retained-worktree",
        "preserved-worktree-changed",
      ].includes(violation.code)
    );
  });
};

const assertTargetEquivalentCleanupComplete = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  cleanupErrors: readonly string[]
): void => {
  const verification = verificationAgainst(lease, inventory);
  const blockers = frozenRecoveryBlockingViolations(lease, verification);
  if (blockers.length === 0 && cleanupErrors.length === 0) {
    return;
  }
  throw new SimpleChangesError(
    `Cannot close ${lease.runId} as target-equivalent because final verification or cleanup is incomplete: ${[
      ...blockers.map((item) => item.message),
      ...cleanupErrors,
    ].join("; ")}`,
    EXIT_CODES.unsafe
  );
};

/**
 * Close a loop whose work is already contained in the target, so there is
 * nothing left to ship. This is the recovery path out of the frozen-scope
 * dead end: it works on a relinquished lease without a takeover ceremony,
 * requires explicit user approval and a reason, performs only the local
 * proven-safe cleanup ordinary finalization performs, and records a terminal
 * `target-equivalent` outcome that is never reportable as a shipped delivery.
 */
export const closeLoopTargetEquivalent = (
  repositoryPath: string,
  runIdInput: string,
  agentIdInput: string,
  approvedByInput: string,
  reasonInput: string,
  equivalenceEvidence: readonly LoopEquivalenceEvidence[] = []
): LoopTargetEquivalentCloseResult => {
  const runId = requiredRunId(runIdInput);
  const agentId = requiredText(agentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approver");
  const reason = requiredText(reasonInput, "close-equivalent reason");
  const opening = locateRepository(repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withStateLock(commonGitDirectory, "loop close-equivalent", () =>
    withWorktreeCoordinationLock(
      commonGitDirectory,
      "loop close-equivalent cleanup",
      () => {
        const archivePath = resolve(
          recoveryHistoryDirectory(commonGitDirectory, runId),
          "close-equivalent.json"
        );
        const prior = priorTargetEquivalentClose(
          commonGitDirectory,
          runId,
          archivePath
        );
        if (prior) {
          return prior;
        }
        const inventory = captureInventory(repositoryPath);
        let lease = requireLease(inventory);
        assertMatchingRun(lease, runId);
        const lifecycle = controllerLifecycle(lease);
        if (lifecycle.status === "active" && lease.ownerAgentId !== agentId) {
          throw new SimpleChangesError(
            `Only current controller ${lease.ownerAgentId} may close active loop ${lease.runId} as target-equivalent. A relinquished loop may be closed by another agent with explicit user approval.`,
            EXIT_CODES.unsafe
          );
        }
        lease = reconcilePrimarySynchronization(lease, inventory);
        const targetRevision = currentTargetRevision(lease);
        assertTargetEquivalentRemoteReconciliation(
          lease,
          inventory,
          targetRevision
        );
        const proofs = proveNothingLeftToShip(
          lease,
          inventory,
          targetRevision,
          equivalenceEvidence
        );
        const recordedAt = new Date().toISOString();
        const remoteReconciliationSkipped = targetUsesGitLab(inventory)
          ? "Remote reconciliation was completed and recorded before target-equivalent closure; no reconciliation gate was skipped."
          : "The target provider does not require GitLab branch/proposal reconciliation.";
        // Completion belongs in the immutable archive. A failed cleanup or
        // archive write must leave the active run resumable, without a terminal
        // outcome that would disable replan.
        const verification = verificationAgainst(lease, inventory);
        const automaticCleanup = automaticFinalizationCleanup(
          lease,
          inventory,
          verification
        );
        ({ lease } = automaticCleanup);
        assertTargetEquivalentCleanupComplete(
          lease,
          captureInventory(repositoryPath),
          automaticCleanup.cleanup.errors
        );
        const record: LoopCloseEquivalentRecord = {
          approvedBy,
          archivedAt: recordedAt,
          authority: "close-equivalent",
          kind: "loop-close-equivalent",
          leaseDigest: loopManifestDigest(lease),
          outcome: "target-equivalent",
          reason,
          remoteReconciliationSkipped,
          runId,
          schemaVersion: 1,
          targetRef: lease.targetRef,
          targetRevision,
          worktrees: proofs,
        };
        validateSchemaDocument<LoopCloseEquivalentRecord>(
          "loop-close-equivalent",
          closeEquivalentRecordSchema,
          record
        );
        writeImmutableRecoveryEvent(archivePath, record);
        rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
        return {
          archivedAt: recordedAt,
          cleanup: automaticCleanup.cleanup,
          outcome: "target-equivalent",
          runId,
          worktrees: proofs,
        };
      }
    )
  );
};

export interface StaleLeaseRecoveryReceipt {
  agentId: string;
  approvedBy: string;
  archivedAt: string;
  kind: "stale-lease-recovery";
  leaseDigest: string;
  liveness: {
    ageMs: number | null;
    lastUpdatedAt: string;
    ownerProcessProvable: false;
    state: "stale";
  };
  mode: LoopLease["mode"];
  ownerAgentId: string;
  preservedWorktreePaths: string[];
  reason: string;
  runId: string;
  schemaVersion: 1;
  staleAfterMs: number;
  targetRef: string;
  targetRevision: string;
}

const staleLeaseRecoveryPath = (
  commonGitDirectory: string,
  runId: string
): string =>
  resolve(
    recoveryHistoryDirectory(commonGitDirectory, runId),
    "stale-lease-recovery.json"
  );

export const staleLeaseArchivePath = (
  commonGitDirectory: string,
  runId: string
): string =>
  resolve(
    recoveryHistoryDirectory(commonGitDirectory, runId),
    "stale-lease-recovery-lease.json"
  );

/**
 * Clear a lease whose owner cannot be proven alive and whose heartbeat has
 * gone quiet past the staleness threshold, on explicit user authority. This
 * clears the bookkeeping record only: every worktree, branch, claim, and
 * durable receipt survives untouched, and the cleared lease is archived into
 * the run history the way other terminal records are. A lease that is still
 * live is refused; recovering it needs its owner, or an approved takeover.
 */
export const recoverStaleLoopLease = (
  repositoryPath: string,
  runIdInput: string,
  agentIdInput: string,
  approvedByInput: string,
  reasonInput: string
): StaleLeaseRecoveryReceipt => {
  const runId = requiredRunId(runIdInput);
  const agentId = requiredText(agentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approver");
  const reason = requiredText(reasonInput, "stale-lease recovery reason");
  const opening = locateRepository(repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withStateLock(commonGitDirectory, "loop recover stale lease", () => {
    const archivePath = staleLeaseRecoveryPath(commonGitDirectory, runId);
    const lease = readLeaseFromCommonDirectory(commonGitDirectory);
    if (!lease) {
      if (existsSync(archivePath)) {
        return readImmutableRecoveryEvent<StaleLeaseRecoveryReceipt>(
          archivePath
        );
      }
      throw new SimpleChangesError(
        `No Simple Changes loop lease exists to recover for ${runId}.`,
        EXIT_CODES.unsafe
      );
    }
    assertMatchingRun(lease, runId);
    const liveness = leaseLiveness(lease);
    if (liveness.state !== "stale") {
      throw new SimpleChangesError(
        `Loop ${runId} is ${liveness.state}, not stale: ${
          liveness.ownerProcessProvable
            ? `its owner process ${lease.ownerProcess?.pid} is still running`
            : `its last heartbeat ${liveness.lastUpdatedAt} is not older than ${LEASE_STALE_AFTER_MS} ms`
        }. Simple Changes never clears a lease whose owner may still be working. Next: finish the run as its controller, or run \`simple-changes loop takeover --run-id ${runId} --agent-id <you> --manifest-digest ${loopManifestDigest(lease)} --approved-by <user> --reason <why>\`.`,
        EXIT_CODES.unsafe
      );
    }
    const archivedAt = new Date().toISOString();
    const record: StaleLeaseRecoveryReceipt = {
      agentId,
      approvedBy,
      archivedAt,
      kind: "stale-lease-recovery",
      leaseDigest: loopManifestDigest(lease),
      liveness: {
        ageMs: liveness.ageMs,
        lastUpdatedAt: liveness.lastUpdatedAt,
        ownerProcessProvable: false,
        state: "stale",
      },
      mode: lease.mode,
      ownerAgentId: lease.ownerAgentId,
      preservedWorktreePaths: lease.worktrees
        .map((worktree) => worktree.path)
        .sort((left, right) => left.localeCompare(right)),
      reason,
      runId,
      schemaVersion: 1,
      staleAfterMs: LEASE_STALE_AFTER_MS,
      targetRef: lease.targetRef,
      targetRevision: lease.targetRevision,
    };
    const archived = writeImmutableRecoveryEvent(
      archivePath,
      validateSchema<StaleLeaseRecoveryReceipt>("stale-lease-recovery", record)
    );
    // The receipt keeps its established shape for older runtimes; the full
    // cleared lease and its controller binding go beside it, so the run's
    // scope, outcome, and paused questions survive recovery.
    writeImmutableRecoveryEvent(
      staleLeaseArchivePath(commonGitDirectory, runId),
      {
        controllerBinding: readControllerBinding(lease),
        lease,
        ownerSessionEnded: liveness.ownerSessionEnded,
      }
    );
    rmSync(loopLeasePath(commonGitDirectory), { force: true });
    forgetLeaseSession(lease);
    removeControllerBinding(lease);
    return archived;
  });
};

const archiveRecordedCommand = (
  lease: LoopLease,
  manifestDigest: string,
  statusDigest: string
): string =>
  `simple-changes loop archive-recorded --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --manifest-digest ${manifestDigest} --status-digest ${statusDigest} --approved-by <user> --reason <why>`;

const requireReplanLease = (inventory: RepositoryInventory): LoopLease => {
  const common = inventory.repository.commonGitDirectory;
  const lease = readLeaseFromCommonDirectory(common);
  if (!lease || lease.commonGitDirectory !== common) {
    throw new SimpleChangesError(
      "Replan requires the active lease of this exact repository.",
      EXIT_CODES.unsafe
    );
  }
  // Do not virtually admit concurrent authors: approval and archive must bind
  // the stored manifest, while observation separately includes current claims.
  return lease;
};

export interface LoopReplanRequest {
  agentId: string;
  approvedBy: string;
  /**
   * Set only by `loop archive-recorded`: archive a frozen run that already
   * recorded a shipment outcome but cannot finish. Its record keeps the
   * `loop-archive-recorded` kind and `archived-unfinished` outcome.
   */
  archiveRecordedOutcome?: true;
  manifestDigest: string;
  reason: string;
  runId: string;
  statusDigest: string;
}

interface LoopReplanRecord {
  archivedAt: string;
  fullLeaseDigest: string;
  kind: "loop-replan" | "loop-archive-recorded";
  lease: LoopLease;
  observation: ReturnType<typeof replanObservation>;
  outcome: "replanned" | "archived-unfinished";
  request: LoopReplanRequest;
  schemaVersion: 1;
}

const replanObservation = (
  lease: LoopLease,
  inventory: RepositoryInventory
) => ({
  coordination: readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  ),
  inventoryDigest: inventory.baselineDigest,
  targetRevision: currentTargetRevision(lease),
});

// Observe from the same checkout used for execution. Inventory digests include
// checkout identity, while coordination and the current target bind shared state.
export const loopReplanStatus = (repositoryPath: string) => {
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop replan status",
    () =>
      withWorktreeCoordinationLock(
        opening.repository.commonGitDirectory,
        "loop replan status",
        () => {
          const inventory = captureInventory(repositoryPath);
          const lease = requireReplanLease(inventory);
          const observation = replanObservation(lease, inventory);
          const manifestDigest = loopManifestDigest(lease);
          const statusDigest = sha256Json(observation);
          // Only the next command differs: a recorded outcome refuses
          // `loop replan`, leaving the approved `loop archive-recorded`.
          return {
            agentId: lease.ownerAgentId,
            manifestDigest,
            nextCommand: lease.shipmentOutcome
              ? archiveRecordedCommand(lease, manifestDigest, statusDigest)
              : `simple-changes loop replan --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --manifest-digest ${manifestDigest} --status-digest ${statusDigest} --approved-by <user> --reason <why>`,
            observation,
            runId: lease.runId,
            statusDigest,
          };
        }
      )
  );
};

const syncReplanPath = (path: string): void => {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

// Publish without replacing an existing audit record. A partial temporary write
// is never considered an intent; retries validate every field of a published one.
const publishReplanIntent = (path: string, record: LoopReplanRecord): void => {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  // Persist each new history ancestor before an intent can authorize removal
  // of the active directory entry, including on filesystems with delayed metadata.
  let ancestor = dirname(path);
  while (ancestor !== record.lease.commonGitDirectory) {
    syncReplanPath(ancestor);
    ancestor = dirname(ancestor);
  }
  syncReplanPath(ancestor);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
    syncReplanPath(dirname(path));
  } finally {
    rmSync(temporary);
  }
};

const replanPathExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const readReplanLeaseBytes = (path: string): string => {
  // Validate the inode before reading. In particular, do not follow a dangling
  // symlink or block opening a FIFO supplied in place of an audit record.
  if (!lstatSync(path).isFile()) {
    throw new SimpleChangesError(
      "Replan lease must be a regular file.",
      EXIT_CODES.unsafe
    );
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are a bitmask.
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new SimpleChangesError(
        "Replan lease must be a regular file.",
        EXIT_CODES.unsafe
      );
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
};

/**
 * Validates a lease stored in a replan or archive-recorded record. Leases
 * started by an earlier repository fork carry `openingScopeInvariantDigest`,
 * which this runtime never writes; it is ignored for validation but kept for
 * the manifest digest the record's approval bound.
 */
const archivedReplanLease = (value: LoopLease): LoopLease => {
  const { openingScopeInvariantDigest: _legacy, ...lease } =
    value as LoopLease & {
      openingScopeInvariantDigest?: unknown;
    };
  validateSchema<LoopLease>("loop-lease", lease);
  return value;
};

const assertReplanRecord = (
  record: LoopReplanRecord,
  request: LoopReplanRequest
): void => {
  validateSchemaDocument(
    "loop-replan",
    {
      additionalProperties: false,
      properties: {
        archivedAt: { format: "date-time", type: "string" },
        fullLeaseDigest: { pattern: "^[0-9a-f]{64}$", type: "string" },
        kind: {
          const: request.archiveRecordedOutcome
            ? "loop-archive-recorded"
            : "loop-replan",
        },
        lease: { type: "object" },
        observation: {
          additionalProperties: false,
          properties: {
            coordination: { type: "object" },
            inventoryDigest: { pattern: "^[0-9a-f]{64}$", type: "string" },
            targetRevision: { minLength: 1, type: "string" },
          },
          required: ["coordination", "inventoryDigest", "targetRevision"],
          type: "object",
        },
        outcome: {
          const: request.archiveRecordedOutcome
            ? "archived-unfinished"
            : "replanned",
        },
        request: {
          additionalProperties: false,
          properties: Object.fromEntries(
            Object.keys(request).map((key) => [
              key,
              { const: request[key as keyof LoopReplanRequest] },
            ])
          ),
          required: [
            "agentId",
            "approvedBy",
            "manifestDigest",
            "reason",
            "runId",
            "statusDigest",
          ],
          type: "object",
        },
        schemaVersion: { const: 1 },
      },
      required: [
        "archivedAt",
        "fullLeaseDigest",
        "kind",
        "lease",
        "observation",
        "outcome",
        "request",
        "schemaVersion",
      ],
      type: "object",
    },
    record
  );
  const lease = archivedReplanLease(record.lease);
  if (
    record.schemaVersion !== 1 ||
    record.kind !==
      (request.archiveRecordedOutcome
        ? "loop-archive-recorded"
        : "loop-replan") ||
    record.outcome !==
      (request.archiveRecordedOutcome ? "archived-unfinished" : "replanned") ||
    typeof record.archivedAt !== "string" ||
    !DIGEST_PATTERN.test(record.fullLeaseDigest) ||
    JSON.stringify(record.request) !== JSON.stringify(request) ||
    lease.runId !== request.runId ||
    lease.ownerAgentId !== request.agentId ||
    loopManifestDigest(lease) !== request.manifestDigest ||
    sha256Json(record.observation) !== request.statusDigest
  ) {
    throw new SimpleChangesError(
      "Replan archive does not match the exact approved request.",
      EXIT_CODES.unsafe
    );
  }
};

/**
 * `loop archive-recorded` archives a run whose recorded shipment outcome can no
 * longer finish. It proves only that the recorded receipt is intact and still
 * describes history the current target contains; it never claims delivery.
 */
const assertArchivableRecordedOutcome = (lease: LoopLease): void => {
  const outcome = lease.shipmentOutcome;
  if (!outcome) {
    throw new SimpleChangesError(
      "Recorded-outcome archival requires a historical receipt.",
      EXIT_CODES.unsafe
    );
  }
  const target = currentTargetRevision(lease);
  const receipt = validateSchema<ShipmentOutcomeReceipt>(
    "shipment-outcome",
    outcome.receipt
  );
  const paths = [
    ...receipt.units.flatMap((unit) => [
      ...unit.finalPaths,
      ...unit.originalPaths,
    ]),
    ...receipt.additionalPaths,
  ];
  if (
    receipt.runId !== lease.runId ||
    // The recorded digest covers any preserved-source overrides beside the
    // lease, so a tampered or missing sidecar refuses archival.
    !recordedOutcomeIntact(lease) ||
    paths.length === 0 ||
    !target ||
    !targetContainsRevision(
      lease.primaryCheckout,
      target,
      receipt.targetRevision
    ) ||
    paths.some(
      (item) =>
        targetTreeEntry(
          lease.primaryCheckout,
          receipt.targetRevision,
          item.path
        ) !== item.entry
    )
  ) {
    throw new SimpleChangesError(
      "Recorded-outcome archival requires an intact historical receipt and tree contained in the current target.",
      EXIT_CODES.unsafe
    );
  }
};

const createReplanIntent = (
  repositoryPath: string,
  request: LoopReplanRequest,
  activePath: string,
  intentPath: string
): LoopReplanRecord => {
  const inventory = captureInventory(repositoryPath);
  const lease = requireReplanLease(inventory);
  assertMatchingRun(lease, request.runId);
  if (
    lease.ownerAgentId !== request.agentId ||
    !effectiveShipmentScopeFrozenAt(lease) ||
    (!request.archiveRecordedOutcome && lease.shipmentOutcome) ||
    lease.closeEquivalentOutcome ||
    lease.emergencyShipping ||
    verificationAgainst(lease, inventory).violations.some(
      (violation) => violation.code === "incomplete-worktree-preparation"
    )
  ) {
    throw new SimpleChangesError(
      "Replan requires the frozen loop's exact owner, no terminal outcome, and complete preparations.",
      EXIT_CODES.unsafe
    );
  }
  if (request.archiveRecordedOutcome) {
    assertArchivableRecordedOutcome(lease);
  }
  const observation = replanObservation(lease, inventory);
  if (
    loopManifestDigest(lease) !== request.manifestDigest ||
    sha256Json(observation) !== request.statusDigest
  ) {
    throw new SimpleChangesError(
      "Replan manifest or current inventory/coordination/target digest changed.",
      EXIT_CODES.unsafe
    );
  }
  const bytes = readReplanLeaseBytes(activePath);
  if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(lease)) {
    throw new SimpleChangesError(
      "Active lease changed during replan.",
      EXIT_CODES.unsafe
    );
  }
  const record: LoopReplanRecord = {
    archivedAt: new Date().toISOString(),
    fullLeaseDigest: sha256(bytes),
    kind: request.archiveRecordedOutcome
      ? "loop-archive-recorded"
      : "loop-replan",
    lease,
    observation,
    outcome: request.archiveRecordedOutcome
      ? "archived-unfinished"
      : "replanned",
    request,
    schemaVersion: 1,
  };
  publishReplanIntent(intentPath, record);
  return record;
};

const replanLeaseMatches = (bytes: string, record: LoopReplanRecord): boolean =>
  sha256(bytes) === record.fullLeaseDigest &&
  JSON.stringify(JSON.parse(bytes)) === JSON.stringify(record.lease);

// The transition of a pending replan or archival: the active lease must still
// be the recorded bytes and inventory, and an archival re-proves its recorded
// outcome, first attempt or retry after a crash, so a sidecar edited or lost
// after the intent refuses.
const archivePendingReplan = (
  repositoryPath: string,
  request: LoopReplanRequest,
  record: LoopReplanRecord,
  activePath: string,
  archivePath: string
): void => {
  const bytes = readReplanLeaseBytes(activePath);
  const inventory = captureInventory(repositoryPath);
  if (
    !replanLeaseMatches(bytes, record) ||
    sha256Json(replanObservation(record.lease, inventory)) !==
      request.statusDigest
  ) {
    throw new SimpleChangesError(
      "Replan intent no longer matches the active lease or exact inventory.",
      EXIT_CODES.unsafe
    );
  }
  if (request.archiveRecordedOutcome) {
    assertArchivableRecordedOutcome(record.lease);
  }
  // Both directories are within the same common Git directory. This atomic
  // rename is the transition: every original byte is preserved, and a crash
  // cannot leave an unarchived cleared lease. No Git or claim cleanup occurs.
  renameSync(activePath, archivePath);
  syncReplanPath(archivePath);
  syncReplanPath(dirname(archivePath));
  syncReplanPath(dirname(activePath));
};

export const replanLoop = (
  repositoryPath: string,
  input: LoopReplanRequest
): LoopReplanRecord => {
  // Key order is part of the stored record: retries compare the request by its
  // serialized bytes, so archive-recorded records written by earlier forks
  // must keep `archiveRecordedOutcome` first.
  const request: LoopReplanRequest = {
    ...(input.archiveRecordedOutcome
      ? { archiveRecordedOutcome: true as const }
      : {}),
    agentId: requiredText(input.agentId, "agent ID"),
    approvedBy: requiredText(input.approvedBy, "approver"),
    manifestDigest: requiredText(input.manifestDigest, "manifest digest"),
    reason: requiredText(input.reason, "replan reason"),
    runId: requiredRunId(input.runId),
    statusDigest: requiredText(input.statusDigest, "status digest"),
  };
  if (
    !(
      DIGEST_PATTERN.test(request.manifestDigest) &&
      DIGEST_PATTERN.test(request.statusDigest)
    )
  ) {
    throw new SimpleChangesError(
      "Replan requires exact SHA256 digests.",
      EXIT_CODES.usage
    );
  }
  const opening = locateRepository(repositoryPath);
  const common = opening.repository.commonGitDirectory;
  const attempt = `${request.archiveRecordedOutcome ? "archive-recorded" : "replan"}-${sha256Json(request)}`;
  return withStateLock(common, "loop replan", () =>
    withWorktreeCoordinationLock(common, "loop replan", () => {
      const directory = assertNoSymlinkAncestors(
        common,
        join(
          STATE_DIRECTORY,
          RECOVERY_HISTORY_DIRECTORY,
          request.runId,
          attempt
        )
      );
      const intentPath = join(directory, "replan.json");
      const archivePath = join(directory, "replan-lease.json");
      const activePath = loopLeasePath(common);
      let record: LoopReplanRecord;
      if (replanPathExists(intentPath)) {
        record = JSON.parse(
          readReplanLeaseBytes(intentPath)
        ) as LoopReplanRecord;
        assertReplanRecord(record, request);
        if (record.lease.commonGitDirectory !== common) {
          throw new SimpleChangesError(
            "Replan archive belongs to another repository.",
            EXIT_CODES.unsafe
          );
        }
      } else {
        if (replanPathExists(archivePath)) {
          throw new SimpleChangesError(
            "Replan lease archive has no matching intent.",
            EXIT_CODES.unsafe
          );
        }
        record = createReplanIntent(
          repositoryPath,
          request,
          activePath,
          intentPath
        );
      }
      if (replanPathExists(archivePath)) {
        const bytes = readReplanLeaseBytes(archivePath);
        if (!replanLeaseMatches(bytes, record)) {
          throw new SimpleChangesError(
            "Replan archived lease integrity check failed.",
            EXIT_CODES.unsafe
          );
        }
        // A completed retry must never remove a successor, even with the same actor.
        return record;
      }
      archivePendingReplan(
        repositoryPath,
        request,
        record,
        activePath,
        archivePath
      );
      return record;
    })
  );
};

export { archiveRecordedCommand };
