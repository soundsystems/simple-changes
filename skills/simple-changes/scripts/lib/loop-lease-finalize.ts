import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  deleteTargetContainedBranches,
  type TargetContainmentMethod,
  targetContainmentAudit,
  targetContainsRevision,
} from "./cleanup-core.ts";
import {
  decideEmergencyShipping,
  deriveEmergencyShippingStatus,
} from "./emergency-shipping.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256, sha256Json } from "./hash.ts";
import { heldUnitIds, readHeldUnits } from "./held-units.ts";
import {
  assertExactBranch,
  captureInventory,
  exactBranchRefusal,
  isLossyName,
  locateRepository,
} from "./inventory.ts";
import {
  assertControllerActive,
  assertMatchingRun,
  controllerLifecycle,
  currentTargetRevision,
  effectiveShipmentScopeFrozenAt,
  forgetLeaseSession,
  loopLeasePath,
  loopManifestDigest,
  matchingOverride,
  matchingRemovalDisposition,
  PRESERVED_SOURCE_HANDOFF_DIRECTORY,
  PRESERVED_SOURCE_OVERRIDE_DIRECTORY,
  REMOTE_RECONCILIATION_MODES,
  readImmutableRecoveryEvent,
  readLeaseFromCommonDirectory,
  readReceiptSidecar,
  recoveryHistoryDirectory,
  removeControllerBinding,
  requiredText,
  requireLease,
  requireOwnedLease,
  targetBranchForRef,
  targetUsesGitLab,
  withMutationEvidence,
  withStateLock,
  worktreeLease,
  writeControllerBinding,
  writeImmutableRecoveryEvent,
  writeLease,
} from "./loop-lease-core.ts";
import {
  assertCurrentRemoteBranchReconciliation,
  type ExpiredExternalDeletionPins,
  pruneExpiredExternalDeletionPins,
  recordedOpenProposalTargets,
} from "./loop-lease-remote.ts";
import {
  preservedSourceHandoffIssue,
  preservedSourceOverrideIssue,
  targetTreeEntry,
  worktreeSourceEntry,
} from "./loop-lease-shipment.ts";
import {
  completedReleaseMatches,
  isUnmutatedScopelessRun,
  liveClaimFor,
  type ReleaseContext,
  unmutatedCloseReady,
  verificationAgainst,
} from "./loop-lease-verify.ts";
import { emptyManagedWorktreeFolderNotes } from "./managed-worktrees.ts";
import { archiveRetentionPolicy, trustBoundPolicyPaths } from "./policy.ts";
import {
  type PreservedSourceEvidence,
  recordedPreservedSourceEvidence,
} from "./preserved-source-override.ts";
import { primaryDeliveryProof } from "./primary-delivery-proof.ts";
import { runGit } from "./process.ts";
import {
  assessQueuedWork,
  closesAsQueued,
  QUEUED_FOR_REVIEW,
  type QueuedAssessment,
  type QueuedDeclarations,
  type QueuedUnit,
  queuedDeclarations,
  queuedSummary,
} from "./queued-completion.ts";
import {
  type RemoteBranchCleanupReport,
  remoteBranchCleanupReport,
} from "./remote-branch-prune.ts";
import {
  type ReviewAttemptsReport,
  reviewAttemptsForFinalization,
} from "./review-ledger.ts";
import { retirementBackedBranches } from "./run-created-retirement.ts";
import type {
  HeldUnitHold,
  LoopLease,
  LoopVerification,
  LoopViolation,
  LoopWorktreeDisposition,
  LoopWorktreeLease,
  RepositoryInventory,
  WorktreeClaim,
  WorktreeInventory,
} from "./types.ts";
import {
  type ArchivePruneResult,
  pruneWorktreeArchives,
} from "./worktree-archive.ts";
import {
  readCoordinationDocumentFromCommonDirectory,
  releaseAbsentWorktreeClaimsUnderLock,
  releaseClaimUnderLock,
  releaseRecordedState,
  withWorktreeCoordinationLock,
} from "./worktree-coordination.ts";

const AUTOMATIC_CLEANUP_MODES = REMOTE_RECONCILIATION_MODES;

export interface FinalizationRemovedBranch {
  branch: string;
  method: TargetContainmentMethod;
}

export interface FinalizationReleasedClaim {
  claimId: string;
  path: string;
  releaseReason: "shipped" | "worktree-absent";
}

export interface FinalizationCleanupResult {
  cleanedPrimaryPaths: string[];
  errors: string[];
  /** Non-fatal: unlike `errors`, a note never blocks completion. */
  notes: string[];
  primaryUpdated: boolean;
  prunedWorktreeMetadata: number;
  releasedClaims: FinalizationReleasedClaim[];
  removedBranches: FinalizationRemovedBranch[];
  removedWorktrees: string[];
}

interface HeldProtection {
  /** Branches of held source checkouts, never deleted by finalization. */
  branches: Set<string>;
  holds: HeldUnitHold[];
  /** Held paths in the primary checkout, never normalized or counted. */
  primaryPaths: Set<string>;
  /** Held source checkouts, never removed, demoted, or released. */
  sources: Set<string>;
  unitIds: Set<string>;
}

/** Whether the run's scope has units and every one of them is held. */
const allUnitsHeld = (
  lease: LoopLease,
  holds: readonly HeldUnitHold[]
): boolean => {
  const units = lease.shipmentScope?.plan.units ?? [];
  const held = heldUnitIds(holds);
  return units.length > 0 && units.every((unit) => held.has(unit.id));
};

/**
 * The primary-checkout paths held units own: their scoped paths and the
 * original paths the hold observed as part of their result, such as the path
 * a held rename moved from, which the primary's status and delivery proof
 * also report. A copy's modified source is its own change, owned by whatever
 * scopes it, so it is not included.
 */
const heldPrimaryPaths = (
  lease: LoopLease,
  holds: readonly HeldUnitHold[]
): Set<string> =>
  new Set(
    holds
      .filter((hold) => hold.unit.sourceWorktree === lease.primaryCheckout)
      .flatMap((hold) => [
        ...hold.unit.paths,
        ...hold.observation.originalPaths.map((item) => item.path),
      ])
  );

/**
 * What this run's held units protect from finalization cleanup, or null when
 * the hold record cannot be read, in which case callers clean nothing.
 */
const heldProtection = (lease: LoopLease): HeldProtection | null => {
  let holds: HeldUnitHold[];
  try {
    holds = readHeldUnits(lease);
  } catch {
    return null;
  }
  return {
    branches: new Set(
      holds.flatMap((hold) =>
        hold.observation.source.branch ? [hold.observation.source.branch] : []
      )
    ),
    holds,
    primaryPaths: heldPrimaryPaths(lease, holds),
    sources: new Set(holds.map((hold) => hold.unit.sourceWorktree)),
    unitIds: heldUnitIds(holds),
  };
};

const emptyFinalizationCleanup = (): FinalizationCleanupResult => ({
  cleanedPrimaryPaths: [],
  errors: [],
  notes: [],
  primaryUpdated: false,
  prunedWorktreeMetadata: 0,
  releasedClaims: [],
  removedBranches: [],
  removedWorktrees: [],
});

const completedHandoffContainment = (
  registered: LoopWorktreeLease,
  claim: WorktreeClaim,
  release: ReleaseContext,
  worktree: WorktreeInventory,
  repositoryPath: string,
  targetRevision: string
): TargetContainmentMethod | null => {
  if (
    !completedReleaseMatches(registered, claim, worktree, release) ||
    worktree.changes.length > 0
  ) {
    return null;
  }
  return targetContainmentAudit(
    repositoryPath,
    targetRevision,
    worktree.headSha
  ).method;
};

// Why finalization may release an active claim as obsolete, or null when it
// may not.
const obsoleteClaimReleaseReason = (
  lease: LoopLease,
  claim: WorktreeClaim,
  worktree: WorktreeInventory,
  repositoryPath: string,
  targetRevision: string
): FinalizationReleasedClaim["releaseReason"] | null => {
  if (claim.state !== "active") {
    return null;
  }
  if (worktree.prunable) {
    return "worktree-absent";
  }
  return claim.owner.agentId === lease.ownerAgentId &&
    claim.headSha === worktree.headSha &&
    claim.changeDigest === worktree.changeDigest &&
    worktree.changes.length === 0 &&
    worktree.headSha &&
    targetContainsRevision(repositoryPath, targetRevision, worktree.headSha)
    ? "shipped"
    : null;
};

/**
 * Release claims that finalization has already proven obsolete and demote
 * their lease entries from `concurrent-author` to unchanged `preserved`, so
 * the ordinary cleanup candidate audit can see them:
 *
 * - a claim on a prunable worktree (directory gone) protects nothing;
 * - the controller's own active claim on a clean checkout whose exact head the
 *   target already contains is finished work, not concurrent authoring.
 *
 * Any other owner's live claim is untouched. This runs under both the loop
 * and coordination locks; the demoted entry keeps its exact current head and
 * digest as the new baseline so later verification still fails closed on any
 * change.
 */
const reconcileConcurrentAuthorClaims = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  repositoryPath: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult,
  // Receives each claim kept because its checkout's branch is not exact, so
  // the absent-claim sweep later in finalization keeps it too.
  keptClaims: Set<string>,
  // Held source checkouts keep their claims and registrations untouched.
  heldSources: ReadonlySet<string>
): LoopLease => {
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const worktreesByPath = new Map(
    inventory.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const demoted = new Map<string, LoopWorktreeLease>();
  const handoffDispositions = new Map<string, LoopWorktreeDisposition>();
  for (const registered of lease.worktrees) {
    if (
      registered.role !== "concurrent-author" ||
      !registered.claimId ||
      heldSources.has(registered.path)
    ) {
      continue;
    }
    const worktree = worktreesByPath.get(registered.path);
    const claim = coordination.claims.find(
      (item) => item.claimId === registered.claimId
    );
    if (!(worktree && claim)) {
      continue;
    }
    const handoffContainment = completedHandoffContainment(
      registered,
      claim,
      {
        liveClaim: liveClaimFor(
          coordination,
          lease.commonGitDirectory,
          registered.path
        ),
        releaseRecorded: releaseRecordedState(coordination, claim.claimId),
      },
      worktree,
      repositoryPath,
      targetRevision
    );
    // The demotion records the checkout's observed branch, so a name that
    // is not exact leaves the registration and its claim as they are.
    const refusal = exactBranchRefusal(
      worktree.branch,
      `the loop registration of ${worktree.path}`
    );
    if (handoffContainment) {
      if (refusal) {
        cleanup.errors.push(refusal);
        continue;
      }
      const { claimId: _claimId, ...rest } = registered;
      demoted.set(registered.path, {
        ...rest,
        ...worktreeLease(worktree, "preserved", null, registered.createdByRun),
      });
      handoffDispositions.set(
        registered.path,
        automaticRemovalDisposition(lease, worktree, targetRevision)
      );
      continue;
    }
    const releaseReason = obsoleteClaimReleaseReason(
      lease,
      claim,
      worktree,
      repositoryPath,
      targetRevision
    );
    if (!releaseReason) {
      continue;
    }
    // Checked before the release, so a refusal never leaves the claim
    // released while its registration stays a concurrent author.
    if (refusal) {
      cleanup.errors.push(refusal);
      keptClaims.add(claim.claimId);
      continue;
    }
    releaseClaimUnderLock(
      lease.commonGitDirectory,
      claim.claimId,
      lease.ownerAgentId,
      releaseReason
    );
    cleanup.releasedClaims.push({
      claimId: claim.claimId,
      path: claim.path,
      releaseReason,
    });
    const { claimId: _claimId, ...rest } = registered;
    demoted.set(registered.path, {
      ...rest,
      ...worktreeLease(worktree, "preserved", null, registered.createdByRun),
    });
  }
  if (demoted.size === 0) {
    return lease;
  }
  return writeLease({
    ...lease,
    dispositions: [
      ...(lease.dispositions ?? []).filter(
        (disposition) => !handoffDispositions.has(disposition.path)
      ),
      ...handoffDispositions.values(),
    ],
    updatedAt: new Date().toISOString(),
    worktrees: lease.worktrees.map(
      (worktree) => demoted.get(worktree.path) ?? worktree
    ),
  });
};

const automaticRemovalDisposition = (
  lease: LoopLease,
  worktree: WorktreeInventory,
  targetRevision: string
): LoopWorktreeDisposition => {
  if (!worktree.headSha) {
    throw new SimpleChangesError(
      `Cannot record automatic cleanup without a commit identity for ${worktree.path}.`,
      EXIT_CODES.unsafe
    );
  }
  assertExactBranch(
    worktree.branch,
    `the removal disposition of ${worktree.path}`
  );
  const containment = targetContainmentAudit(
    lease.primaryCheckout,
    targetRevision,
    worktree.headSha
  );
  if (!containment.method) {
    throw new SimpleChangesError(
      `Cannot record automatic cleanup without target containment evidence for ${worktree.path}.`,
      EXIT_CODES.unsafe
    );
  }
  return {
    approvedBy: `mode:${lease.mode}`,
    branch: worktree.branch,
    changeDigest: worktree.changeDigest,
    containmentMethod: containment.method,
    createdAt: new Date().toISOString(),
    headSha: worktree.headSha,
    outcome: "remove-after-audit",
    path: worktree.path,
    reason:
      "The current integration request authorizes automatic cleanup after repeated inventory proved this unchanged clean checkout is contained in the refreshed target.",
    status: "intended",
    targetRef: lease.targetRef,
    targetRevision,
    uniqueCommitCount: 0,
  };
};

type AutomaticCleanupCandidate = WorktreeInventory & { headSha: string };

// A late arrival registered by `loop rebaseline` stays owner-controlled: the
// re-baseline grants no cleanup authority over it, so automatic cleanup never
// takes it and its presence never blocks the run from ending.
const rebaselinedPaths = (lease: LoopLease): ReadonlySet<string> =>
  new Set(
    (lease.rebaselines ?? []).flatMap((record) =>
      record.registered.map((item) => item.path)
    )
  );

const automaticCleanupCandidates = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string
): AutomaticCleanupCandidate[] => {
  const registeredByPath = new Map(
    lease.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  // A held unit's source checkout is never a cleanup candidate, and an
  // unreadable hold record leaves every checkout in place.
  const protection = heldProtection(lease);
  if (!protection) {
    return [];
  }
  const rebaselined = rebaselinedPaths(lease);
  return inventory.worktrees.filter((worktree) => {
    if (
      protection.sources.has(worktree.path) ||
      rebaselined.has(worktree.path)
    ) {
      return false;
    }
    const registered = registeredByPath.get(worktree.path);
    const removalDisposition = matchingRemovalDisposition(lease, worktree);
    const targetContained = targetContainsRevision(
      inventory.repository.primaryCheckout,
      targetRevision,
      worktree.headSha
    );
    const dispositionContained = Boolean(
      removalDisposition &&
        targetContainmentAudit(
          inventory.repository.primaryCheckout,
          targetRevision,
          worktree.headSha
        ).method === removalDisposition.containmentMethod
    );
    const basicCandidate = Boolean(
      !worktree.isPrimary &&
        registered &&
        registered.role !== "concurrent-author" &&
        registered.role !== "retained" &&
        worktree.changes.length === 0 &&
        worktree.headSha &&
        (targetContained || dispositionContained)
    );
    if (!(basicCandidate && registered)) {
      return false;
    }
    // Any claim not yet released holds the checkout, whatever its state or
    // the policy, except the claim this run adopted through the
    // registration's own pause receipt.
    const holder = liveClaimFor(
      coordination,
      lease.commonGitDirectory,
      worktree.path
    );
    const held =
      holder !== undefined &&
      !(
        holder.state === "adopted-preserved" &&
        holder.claimId === registered.claimId &&
        registered.pauseReceiptId !== undefined
      );
    return Boolean(
      !held &&
        (registered.createdByRun ||
          (registered.role === "preserved" &&
            registered.baselineHeadSha === worktree.headSha &&
            registered.baselineChangeDigest === worktree.changeDigest))
    );
  }) as AutomaticCleanupCandidate[];
};

const recordAutomaticDispositions = (
  lease: LoopLease,
  candidates: AutomaticCleanupCandidate[],
  targetRevision: string
): LoopLease => {
  const dispositions = candidates.map((worktree) =>
    automaticRemovalDisposition(lease, worktree, targetRevision)
  );
  if (dispositions.length === 0) {
    return lease;
  }
  const paths = new Set(dispositions.map((disposition) => disposition.path));
  return writeLease({
    ...lease,
    dispositions: [
      ...(lease.dispositions ?? []).filter(
        (disposition) => !paths.has(disposition.path)
      ),
      ...dispositions,
    ],
    updatedAt: new Date().toISOString(),
  });
};

const completeAutomaticDispositions = (
  lease: LoopLease,
  paths: string[]
): LoopLease => {
  const completedPaths = new Set(paths);
  if (completedPaths.size === 0) {
    return lease;
  }
  const completedAt = new Date().toISOString();
  return writeLease({
    ...lease,
    dispositions: (lease.dispositions ?? []).map((disposition) =>
      completedPaths.has(disposition.path)
        ? {
            ...disposition,
            // A completed disposition makes its branch eligible for
            // deletion by name, so it never keeps a name that is not exact,
            // such as one an older runtime recorded.
            branch: isLossyName(disposition.branch) ? null : disposition.branch,
            completedAt,
            status: "completed",
          }
        : disposition
    ),
    updatedAt: completedAt,
  });
};

const completeAbsentRemovalIntents = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string
): LoopLease => {
  const currentPaths = new Set(
    inventory.worktrees.map((worktree) => worktree.path)
  );
  const dispositionPatchIdCache = new Map<string, Map<string, string>>();
  const completedPaths = (lease.dispositions ?? [])
    .filter(
      (disposition) =>
        disposition.status !== "completed" &&
        !currentPaths.has(disposition.path) &&
        disposition.targetRef === lease.targetRef &&
        disposition.targetRevision === targetRevision &&
        targetContainmentAudit(
          inventory.repository.primaryCheckout,
          targetRevision,
          disposition.headSha,
          dispositionPatchIdCache
        ).method !== null
    )
    .map((disposition) => disposition.path);
  return completeAutomaticDispositions(lease, completedPaths);
};

const reconcileAbsentRetainedWorktrees = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopLease => {
  if (!AUTOMATIC_CLEANUP_MODES.has(lease.mode)) {
    return lease;
  }
  let targetRevision: string;
  try {
    targetRevision = currentTargetRevision(lease);
  } catch {
    return lease;
  }
  const currentPaths = new Set(
    inventory.worktrees.map((worktree) => worktree.path)
  );
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const activelyClaimedPaths = new Set(
    coordination.claims
      .filter((claim) => claim.state === "active")
      .map((claim) => claim.path)
  );
  const completedAt = new Date().toISOString();
  const dispositions = lease.worktrees.flatMap((worktree) => {
    if (
      worktree.role !== "retained" ||
      !worktree.retention ||
      currentPaths.has(worktree.path) ||
      activelyClaimedPaths.has(worktree.path) ||
      !worktree.branch ||
      !worktree.baselineHeadSha ||
      !targetContainsRevision(
        inventory.repository.primaryCheckout,
        targetRevision,
        worktree.baselineHeadSha
      )
    ) {
      return [];
    }
    const branchRevisionResult = runGit(
      inventory.repository.primaryCheckout,
      ["rev-parse", "--verify", `refs/heads/${worktree.branch}^{commit}`],
      true
    );
    const branchRevision = branchRevisionResult.stdout.trim();
    if (
      branchRevisionResult.exitCode !== 0 ||
      !branchRevision ||
      !targetContainsRevision(
        inventory.repository.primaryCheckout,
        targetRevision,
        branchRevision
      )
    ) {
      return [];
    }
    return [
      {
        approvedBy: `mode:${lease.mode}`,
        // This retires an existing record, which stays possible for a
        // branch an older runtime recorded under a name that is not exact,
        // but the disposition does not repeat that name: a completed
        // disposition's branch is deleted by name later in finalization.
        branch: isLossyName(worktree.branch) ? null : worktree.branch,
        changeDigest: worktree.baselineChangeDigest,
        completedAt,
        containmentMethod: "target-contained" as const,
        createdAt: completedAt,
        headSha: branchRevision,
        outcome: "remove-after-audit" as const,
        path: worktree.path,
        reason:
          "The retained checkout is already absent, and its last audited clean revision plus current local branch are both contained in the finalized target. Reconcile stale cleanup bookkeeping without another user confirmation.",
        status: "completed" as const,
        targetRef: lease.targetRef,
        targetRevision,
        uniqueCommitCount: 0 as const,
      },
    ];
  });
  if (dispositions.length === 0) {
    return lease;
  }
  const paths = new Set(dispositions.map((disposition) => disposition.path));
  return writeLease({
    ...lease,
    dispositions: [
      ...(lease.dispositions ?? []).filter(
        (disposition) => !paths.has(disposition.path)
      ),
      ...dispositions,
    ],
    updatedAt: completedAt,
  });
};

interface AutomaticRemovalResult {
  lease: LoopLease;
  removed: AutomaticCleanupCandidate[];
}

const crashAfterAutomaticWorktreeRemovalForTest = (path: string): void => {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.SIMPLE_CHANGES_TEST_CRASH_AFTER_WORKTREE_REMOVE === path
  ) {
    process.kill(process.pid, "SIGKILL");
  }
};

const removeAutomaticWorktrees = (
  lease: LoopLease,
  repositoryPath: string,
  targetRevision: string,
  candidates: AutomaticCleanupCandidate[],
  cleanup: FinalizationCleanupResult
): AutomaticRemovalResult => {
  let currentLease = lease;
  const removed: AutomaticCleanupCandidate[] = [];
  for (const worktree of candidates.filter(
    (candidate) => !candidate.prunable
  )) {
    const freshInventory = captureInventory(repositoryPath);
    const fresh = automaticCleanupCandidates(
      lease,
      freshInventory,
      targetRevision
    ).find(
      (candidate) =>
        candidate.path === worktree.path &&
        candidate.branch === worktree.branch &&
        candidate.headSha === worktree.headSha &&
        candidate.changeDigest === worktree.changeDigest
    );
    if (!fresh) {
      cleanup.errors.push(
        `Cleanup candidate changed or became claimed during final audit and was preserved: ${worktree.path}`
      );
      continue;
    }
    currentLease = recordAutomaticDispositions(
      currentLease,
      [fresh],
      targetRevision
    );
    const removal = runGit(
      repositoryPath,
      ["worktree", "remove", worktree.path],
      true
    );
    if (removal.exitCode === 0) {
      crashAfterAutomaticWorktreeRemovalForTest(worktree.path);
      currentLease = completeAutomaticDispositions(currentLease, [
        worktree.path,
      ]);
      cleanup.removedWorktrees.push(worktree.path);
      removed.push(worktree);
      continue;
    }
    cleanup.errors.push(
      `Could not remove proven cleanup worktree ${worktree.path}: ${removal.stderr.trim() || removal.stdout.trim()}`
    );
  }
  return { lease: currentLease, removed };
};

const pruneAutomaticWorktreeMetadata = (
  lease: LoopLease,
  repositoryPath: string,
  candidates: AutomaticCleanupCandidate[],
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): AutomaticRemovalResult => {
  let currentLease = lease;
  const removed: AutomaticCleanupCandidate[] = [];
  const prunable = candidates.filter((candidate) => candidate.prunable);
  if (prunable.length === 0) {
    return { lease: currentLease, removed };
  }
  // Git prunes every stale registration, not just the candidates we pass to
  // this helper. Preserve the entire set if even one path lacks a fresh audit.
  const freshInventory = captureInventory(repositoryPath);
  const freshCandidates = automaticCleanupCandidates(
    currentLease,
    freshInventory,
    targetRevision
  );
  const freshPrunable = freshInventory.worktrees.filter(
    (worktree) => worktree.prunable
  );
  const fullyAudited = freshPrunable.every(
    (worktree) =>
      prunable.some(
        (candidate) =>
          candidate.path === worktree.path &&
          candidate.branch === worktree.branch &&
          candidate.headSha === worktree.headSha &&
          candidate.changeDigest === worktree.changeDigest
      ) && freshCandidates.some((candidate) => candidate.path === worktree.path)
  );
  if (!fullyAudited || freshPrunable.length !== prunable.length) {
    return { lease: currentLease, removed };
  }
  currentLease = recordAutomaticDispositions(
    currentLease,
    prunable,
    targetRevision
  );
  const result = runGit(
    repositoryPath,
    ["worktree", "prune", "--expire", "now"],
    true
  );
  if (result.exitCode !== 0) {
    cleanup.errors.push(
      `Could not prune stale worktree metadata: ${result.stderr.trim() || result.stdout.trim()}`
    );
    return { lease: currentLease, removed };
  }
  const remainingPaths = new Set(
    captureInventory(repositoryPath).worktrees.map((worktree) => worktree.path)
  );
  for (const candidate of prunable) {
    if (remainingPaths.has(candidate.path)) {
      cleanup.errors.push(
        `Stale worktree metadata remained after pruning: ${candidate.path}`
      );
      continue;
    }
    cleanup.prunedWorktreeMetadata += 1;
    cleanup.removedWorktrees.push(candidate.path);
    removed.push(candidate);
  }
  currentLease = completeAutomaticDispositions(
    currentLease,
    removed.map((candidate) => candidate.path)
  );
  return { lease: currentLease, removed };
};

const removeTargetContainedBranches = (
  lease: LoopLease,
  repositoryPath: string,
  targetBranch: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult,
  heldBranches: ReadonlySet<string>
): void => {
  const inventory = captureInventory(repositoryPath);
  const openingBranches = new Map(
    (lease.openingBranches ?? []).map((branch) => [branch.name, branch.sha])
  );
  const runOwnedBranches = new Set([
    ...lease.worktrees
      .filter((worktree) => worktree.createdByRun)
      .flatMap((worktree) => (worktree.branch ? [worktree.branch] : [])),
    ...lease.preparations.map((preparation) => preparation.branch),
  ]);
  const reconciledAbsentBranches = new Set(
    (lease.dispositions ?? [])
      .filter(
        (disposition) =>
          disposition.status === "completed" &&
          disposition.targetRef === lease.targetRef &&
          disposition.targetRevision === targetRevision &&
          disposition.branch
      )
      .map((disposition) => disposition.branch as string)
  );
  // A branch a run-created retirement relies on stays, or the retirement
  // would end.
  const retirementBacked = retirementBackedBranches(lease, inventory);
  const deletion = deleteTargetContainedBranches({
    // Deletion acts on names, so a branch whose name is not exact is never
    // deleted automatically, whichever record named it.
    branches: inventory.branches.filter(
      (branch) =>
        !(isLossyName(branch.name) || retirementBacked.has(branch.name)) &&
        branch.name !== targetBranch &&
        !heldBranches.has(branch.name) &&
        branch.worktreePath === null &&
        (openingBranches.get(branch.name) === branch.sha ||
          runOwnedBranches.has(branch.name) ||
          reconciledAbsentBranches.has(branch.name))
    ),
    repositoryPath,
    targetRevision,
  });
  cleanup.errors.push(...deletion.errors);
  cleanup.removedBranches.push(
    ...deletion.removed.map(({ branch, method }) => ({ branch, method }))
  );
};

const switchCleanPrimaryToTarget = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): void => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (
    !primary ||
    primary.changes.length > 0 ||
    primary.branch === targetBranch
  ) {
    return;
  }
  const targetExists = inventory.branches.some(
    (branch) => branch.name === targetBranch
  );
  const result = runGit(
    lease.primaryCheckout,
    targetExists
      ? ["switch", targetBranch]
      : ["switch", "-c", targetBranch, targetRevision],
    true
  );
  if (result.exitCode === 0) {
    cleanup.primaryUpdated = true;
    return;
  }
  cleanup.errors.push(
    `Could not restore clean primary checkout to ${targetBranch}: ${result.stderr.trim() || result.stdout.trim()}`
  );
};

// Primary paths are file names, never patterns: a tracked name such as
// `:(glob)*.json` must not widen a restore to the repository policy.
const LITERAL_PATHSPECS = "--literal-pathspecs";

const diffMatchesRevision = (
  repositoryPath: string,
  revision: string,
  paths: string[],
  cached = false
): boolean =>
  runGit(
    repositoryPath,
    [
      LITERAL_PATHSPECS,
      "diff",
      ...(cached ? ["--cached"] : []),
      ...(cached ? ["--ita-visible-in-index"] : []),
      "--quiet",
      revision,
      "--",
      ...paths,
    ],
    true
  ).exitCode === 0;

// Index flag bits under which Git's comparisons do not read a path's file,
// or that mark an entry as not an ordinary staged file: a conflict stage
// (two bits), assume-unchanged, intent-to-add, and skip-worktree.
// `ls-files --debug` prints each entry's flags in hexadecimal on the last
// of its six lines.
const UNORDINARY_INDEX_FLAG_BITS = [
  0x10_00, 0x20_00, 0x80_00, 0x20_00_00_00, 0x40_00_00_00,
] as const;
const DEBUG_LINES_PER_ENTRY = 6;
const DEBUG_FLAGS_LINE = /^ {2}size: [0-9]+\tflags: ([0-9a-f]+)$/u;

// Each listed entry's flags, or null when the listing did not arrive whole:
// a listing ends with a line break and holds six lines per entry, the last
// one its flags, so one cut short or cut at a line's end never parses.
const debugEntryFlags = (output: string): number[] | null => {
  const lines = output.split("\n");
  if (lines.pop() !== "" || lines.length % DEBUG_LINES_PER_ENTRY !== 0) {
    return null;
  }
  const flags: number[] = [];
  for (
    let last = DEBUG_LINES_PER_ENTRY - 1;
    last < lines.length;
    last += DEBUG_LINES_PER_ENTRY
  ) {
    const value = DEBUG_FLAGS_LINE.exec(lines[last] ?? "")?.[1];
    if (value === undefined) {
      return null;
    }
    flags.push(Number.parseInt(value, 16));
  }
  return flags;
};

// Whether every index entry of each path is an ordinary staged file, so
// comparing it with a revision reads the file itself. An empty listing is
// what an absent entry and a lost answer both look like, so it counts only
// when `--error-unmatch` exits 1, which a lost answer cannot fake. Anything
// Git could not answer whole twice is not ordinary, so the path is kept.
const indexHasOnlyOrdinaryEntries = (
  repositoryPath: string,
  paths: string[]
): boolean =>
  paths.every((path) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = runGit(
        repositoryPath,
        [LITERAL_PATHSPECS, "ls-files", "--debug", "--", path],
        true
      );
      if (result.exitCode !== 0) {
        return false;
      }
      const flags = debugEntryFlags(result.stdout);
      if (
        flags !== null &&
        (flags.length > 0 ||
          runGit(
            repositoryPath,
            [LITERAL_PATHSPECS, "ls-files", "--error-unmatch", "--", path],
            true
          ).exitCode === 1)
      ) {
        return flags.every((value) =>
          UNORDINARY_INDEX_FLAG_BITS.every(
            (bit) => Math.floor(value / bit) % 2 === 0
          )
        );
      }
    }
    return false;
  });

/**
 * When review changed some scoped bytes, normalizing only the
 * target-equivalent paths would alter the primary's baseline digest and defeat
 * the delivery proof that lets the run close. Proven delivered mixed-source
 * state is then preserved byte-for-byte, including the index.
 */
const preservesProvenMixedPrimary = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  primary: WorktreeInventory,
  eligiblePaths: Set<string>
): boolean => {
  const held = heldProtection(lease)?.unitIds ?? new Set<string>();
  const scopedPrimaryPaths = new Set(
    (lease.shipmentScope?.plan.units ?? [])
      .filter(
        (unit) => unit.sourceWorktree === primary.path && !held.has(unit.id)
      )
      .flatMap((unit) => unit.paths)
  );
  return (
    primary.changes.some(
      (change) =>
        scopedPrimaryPaths.has(change.path) && !eligiblePaths.has(change.path)
    ) && preservesUnchangedPrimary(lease, inventory)
  );
};

/**
 * Repository policy paths finalization carries through the fast-forward:
 * staged at the target's index entry, which already matches their bytes,
 * so the fast-forward lands them without writing them. `stagedAtTarget`
 * records whether each was staged that way before.
 */
interface CarriedPolicyPaths {
  headSha: string;
  paths: { path: string; stagedAtTarget: boolean }[];
}

// Whether the fast-forward that follows normalization can land the target
// from the primary's current branch without a switch.
const primaryCanFastForwardInPlace = (
  inventory: RepositoryInventory,
  primary: WorktreeInventory,
  targetBranch: string,
  targetRevision: string
): boolean => {
  const localTarget = inventory.branches.find(
    (branch) => branch.name === targetBranch
  );
  return Boolean(
    primary.branch === targetBranch &&
      localTarget &&
      localTarget.sha === primary.headSha &&
      localTarget.sha !== targetRevision &&
      targetContainsRevision(primary.path, targetRevision, localTarget.sha)
  );
};

/**
 * Normalization never writes the bytes of a dirty repository policy, or of
 * any path its trust receipt binds: restoring an older HEAD copy undoes
 * approved policy and invalidates the receipt. Those paths, with both
 * sides of a rename, leave the restore set. When every other dirty path is
 * normalizable and the primary can fast-forward in place, they are carried
 * through the fast-forward instead; otherwise they stay byte for byte and a
 * note names them. Synchronizing a clean policy file to a target that
 * committed different policy is not normalization: it adopts the target's
 * policy, which the receipt does not bind, so consequential settings stay
 * reduced until `setup` confirms them.
 */
const withoutPolicyPaths = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  primary: WorktreeInventory,
  eligiblePaths: Set<string>,
  targetBranch: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): string[] => {
  const consequential = new Set(
    trustBoundPolicyPaths(lease.primaryCheckout, lease.commonGitDirectory)
  );
  const policyChanges = primary.changes.filter((change) =>
    [change.originalPath, change.path].some(
      (path) => path !== undefined && path !== null && consequential.has(path)
    )
  );
  if (policyChanges.length === 0) {
    return [];
  }
  const carriable =
    policyChanges.every(
      (change) => !change.originalPath && eligiblePaths.has(change.path)
    ) &&
    primary.changes.every((change) =>
      [change.originalPath, change.path]
        .filter((path): path is string => Boolean(path))
        .every((path) => eligiblePaths.has(path))
    ) &&
    primaryCanFastForwardInPlace(
      inventory,
      primary,
      targetBranch,
      targetRevision
    );
  for (const change of policyChanges) {
    eligiblePaths.delete(change.path);
    if (change.originalPath) {
      eligiblePaths.delete(change.originalPath);
    }
  }
  if (carriable) {
    return policyChanges
      .map((change) => change.path)
      .sort((left, right) => left.localeCompare(right));
  }
  for (const change of policyChanges) {
    cleanup.notes.push(
      `Kept ${change.path} in the primary checkout byte for byte: finalization never restores repository policy to an older copy, and the primary cannot fast-forward to ${lease.targetRef} now, so its approved bytes and trust receipt stay as they are.`
    );
  }
  return [];
};

// Stages each carried policy path at the target's entry. Only the index
// changes; the bytes already equal the target and are never written.
const stagePolicyPathsAtTarget = (
  lease: LoopLease,
  headSha: string,
  paths: string[],
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): CarriedPolicyPaths | null => {
  if (paths.length === 0) {
    return null;
  }
  const carried: CarriedPolicyPaths = {
    headSha,
    paths: paths.map((path) => ({
      path,
      stagedAtTarget: diffMatchesRevision(
        lease.primaryCheckout,
        targetRevision,
        [path],
        true
      ),
    })),
  };
  const staged = runGit(
    lease.primaryCheckout,
    [
      LITERAL_PATHSPECS,
      "restore",
      `--source=${targetRevision}`,
      "--staged",
      "--",
      ...paths,
    ],
    true
  );
  if (staged.exitCode !== 0) {
    cleanup.errors.push(
      `Could not stage repository policy at the target entry: ${staged.stderr.trim() || staged.stdout.trim()}`
    );
  }
  return carried;
};

// Dirty primary paths whose bytes already equal the target and whose index
// can be restored. A held unit's primary bytes stay exactly as held.
const targetEquivalentPrimaryPaths = (
  lease: LoopLease,
  primary: WorktreeInventory & { headSha: string },
  targetRevision: string,
  heldPaths: ReadonlySet<string>
): Set<string> => {
  const eligiblePaths = new Set<string>();
  for (const change of primary.changes) {
    if (change.conflicted || change.untracked) {
      continue;
    }
    const paths = [change.originalPath, change.path].filter(
      (path): path is string => Boolean(path)
    );
    if (paths.some((path) => heldPaths.has(path))) {
      continue;
    }
    const worktreeMatchesTarget = diffMatchesRevision(
      lease.primaryCheckout,
      targetRevision,
      paths
    );
    const indexIsRecoverable =
      indexHasOnlyOrdinaryEntries(lease.primaryCheckout, paths) &&
      (diffMatchesRevision(
        lease.primaryCheckout,
        primary.headSha,
        paths,
        true
      ) ||
        diffMatchesRevision(
          lease.primaryCheckout,
          targetRevision,
          paths,
          true
        ));
    if (worktreeMatchesTarget && indexIsRecoverable) {
      for (const path of paths) {
        eligiblePaths.add(path);
      }
    }
  }
  return eligiblePaths;
};

const reconcileTargetEquivalentPrimaryChanges = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): CarriedPolicyPaths | null => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (!(primary?.headSha && primary.changes.length > 0)) {
    return null;
  }
  const protection = heldProtection(lease);
  if (!protection) {
    cleanup.errors.push(
      "The held-unit record could not be read, so no primary path was cleaned."
    );
    return null;
  }
  const eligiblePaths = targetEquivalentPrimaryPaths(
    lease,
    { ...primary, headSha: primary.headSha },
    targetRevision,
    protection.primaryPaths
  );
  if (eligiblePaths.size === 0) {
    return null;
  }
  if (preservesProvenMixedPrimary(lease, inventory, primary, eligiblePaths)) {
    return null;
  }
  const policyPaths = withoutPolicyPaths(
    lease,
    inventory,
    primary,
    eligiblePaths,
    targetBranch,
    targetRevision,
    cleanup
  );
  const freshPrimary = captureInventory(lease.primaryCheckout).worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (freshPrimary?.changeDigest !== primary.changeDigest) {
    cleanup.errors.push(
      "The primary checkout changed while target-equivalent paths were being audited; no primary path was cleaned."
    );
    return null;
  }
  const carried = stagePolicyPathsAtTarget(
    lease,
    primary.headSha,
    policyPaths,
    targetRevision,
    cleanup
  );
  if (eligiblePaths.size === 0) {
    return carried;
  }
  const paths = [...eligiblePaths].sort();
  const restored = runGit(
    lease.primaryCheckout,
    [
      LITERAL_PATHSPECS,
      "restore",
      `--source=${primary.headSha}`,
      "--staged",
      "--worktree",
      "--",
      ...paths,
    ],
    true
  );
  if (restored.exitCode !== 0) {
    cleanup.errors.push(
      `Could not normalize target-equivalent primary paths: ${restored.stderr.trim() || restored.stdout.trim()}`
    );
    return carried;
  }
  cleanup.cleanedPrimaryPaths.push(...paths);
  cleanup.primaryUpdated = true;
  return carried;
};

/**
 * After the fast-forward, reports carried policy paths. When it did not
 * land, each entry this run staged and that is still staged at the target
 * returns to the old HEAD's entry. That touches only the index, so the
 * approved bytes and trust receipt are unaffected either way.
 */
const settleCarriedPolicyPaths = (
  lease: LoopLease,
  carried: CarriedPolicyPaths | null,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): void => {
  if (!carried) {
    return;
  }
  const head = runGit(
    lease.primaryCheckout,
    ["rev-parse", "--verify", "HEAD"],
    true
  ).stdout.trim();
  for (const { path, stagedAtTarget } of carried.paths) {
    if (head === targetRevision) {
      cleanup.notes.push(
        `Carried ${path} through the fast-forward to ${lease.targetRef} without rewriting it; approved repository policy and its trust receipt are unchanged.`
      );
      continue;
    }
    if (
      !stagedAtTarget &&
      head === carried.headSha &&
      diffMatchesRevision(lease.primaryCheckout, targetRevision, [path], true)
    ) {
      runGit(
        lease.primaryCheckout,
        [
          LITERAL_PATHSPECS,
          "restore",
          `--source=${carried.headSha}`,
          "--staged",
          "--",
          path,
        ],
        true
      );
    }
    cleanup.notes.push(
      `Kept ${path} in the primary checkout byte for byte: the fast-forward to ${lease.targetRef} did not land, so its approved bytes and trust receipt stay as they are.`
    );
  }
};

const fastForwardCleanPrimary = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult,
  carried: CarriedPolicyPaths | null = null
): void => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  const localTarget = inventory.branches.find(
    (branch) => branch.name === targetBranch
  );
  // Only carried policy paths, staged at the target entry, may remain.
  const carriedPaths = new Set(carried?.paths.map(({ path }) => path));
  const canFastForward = Boolean(
    primary?.branch === targetBranch &&
      primary.changes.every(
        (change) =>
          carriedPaths.has(change.path) &&
          !change.originalPath &&
          !change.untracked &&
          !change.conflicted
      ) &&
      localTarget &&
      localTarget.sha !== targetRevision &&
      targetContainsRevision(
        inventory.repository.primaryCheckout,
        targetRevision,
        localTarget.sha
      )
  );
  if (!(canFastForward && localTarget)) {
    return;
  }
  const result = runGit(
    lease.primaryCheckout,
    // Autostash would stash and rewrite carried policy bytes.
    ["merge", "--ff-only", "--no-autostash", targetRevision],
    true
  );
  if (result.exitCode === 0) {
    cleanup.primaryUpdated = true;
    return;
  }
  cleanup.errors.push(
    `Could not fast-forward clean primary checkout to ${targetRevision}: ${result.stderr.trim() || result.stdout.trim()}`
  );
};

const primarySynchronizationIntent = (
  lease: LoopLease,
  targetBranch: string,
  targetRevision: string
) => {
  const before = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (before?.role !== "preserved" || before.claimId) {
    return null;
  }
  const after = {
    ...before,
    baselineChangeDigest: sha256(
      JSON.stringify({ changes: [], contentIdentities: [] })
    ),
    baselineHeadSha: targetRevision,
    branch: targetBranch,
  };
  const record = {
    after,
    before,
    kind: "automatic-primary-synchronization",
    runId: lease.runId,
    targetRef: lease.targetRef,
    targetRevision,
  };
  return {
    path: resolve(
      recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
      `primary-synchronization-${sha256Json(record)}.json`
    ),
    record,
  };
};

const reconcilePrimarySynchronization = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopLease => {
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (registered?.role !== "preserved" || registered.claimId) {
    return lease;
  }
  const targetBranch = targetBranchForRef(
    lease.primaryCheckout,
    lease.targetRef
  );
  if (!targetBranch || isLossyName(targetBranch)) {
    return lease;
  }
  let targetRevision: string;
  try {
    targetRevision = currentTargetRevision(lease);
  } catch {
    // Ordinary finalization must still record its unresolved-target blocker
    // and relinquish. Missing recovery evidence cannot short-circuit that.
    return lease;
  }
  const intent = primarySynchronizationIntent(
    lease,
    targetBranch,
    targetRevision
  );
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (!(intent && primary && existsSync(intent.path))) {
    return lease;
  }
  const recorded = readImmutableRecoveryEvent(intent.path);
  if (sha256Json(recorded) !== sha256Json(intent.record)) {
    throw new SimpleChangesError(
      "Primary synchronization intent does not match this run and target.",
      EXIT_CODES.unsafe
    );
  }
  const expected = intent.record.after;
  if (
    primary.branch !== expected.branch ||
    primary.headSha !== expected.baselineHeadSha ||
    primary.changeDigest !== expected.baselineChangeDigest ||
    primary.changes.length > 0
  ) {
    return lease;
  }
  return writeLease({
    ...lease,
    updatedAt: new Date().toISOString(),
    worktrees: lease.worktrees.map((worktree) =>
      worktree.path === primary.path ? expected : worktree
    ),
  });
};

const preparePrimarySynchronization = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string,
  targetRevision: string
): boolean => {
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (registered?.role !== "preserved") {
    return true;
  }
  const intent = primarySynchronizationIntent(
    lease,
    targetBranch,
    targetRevision
  );
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (
    !(intent && primary) ||
    primary.changes.length > 0 ||
    primary.branch !== registered.branch ||
    primary.headSha !== registered.baselineHeadSha ||
    primary.changeDigest !== registered.baselineChangeDigest
  ) {
    return false;
  }
  if (primary.branch === targetBranch && primary.headSha === targetRevision) {
    return true;
  }
  if (
    !targetContainsRevision(
      lease.primaryCheckout,
      targetRevision,
      primary.headSha
    )
  ) {
    return false;
  }
  const recorded = writeImmutableRecoveryEvent(intent.path, intent.record);
  if (sha256Json(recorded) !== sha256Json(intent.record)) {
    throw new SimpleChangesError(
      "Primary synchronization intent does not match this run and target.",
      EXIT_CODES.unsafe
    );
  }
  return true;
};

const bindAutomaticPrimaryBranchChange = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopLease => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  // A branch that is not exact is never recorded: the registration keeps its
  // branch, and verification reports the checkout's move.
  if (
    !(primary && registered?.mutationAllowed) ||
    registered.branch === primary.branch ||
    isLossyName(primary.branch)
  ) {
    return lease;
  }
  return writeLease({
    ...lease,
    updatedAt: new Date().toISOString(),
    worktrees: lease.worktrees.map((worktree) =>
      worktree.path === primary.path
        ? { ...worktree, branch: primary.branch }
        : worktree
    ),
  });
};

const automaticFinalizationCleanup = (
  leaseInput: LoopLease,
  inventoryInput: RepositoryInventory,
  verification: LoopVerification
): { cleanup: FinalizationCleanupResult; lease: LoopLease } => {
  const cleanup = emptyFinalizationCleanup();
  if (!(AUTOMATIC_CLEANUP_MODES.has(leaseInput.mode) && verification.ok)) {
    return { cleanup, lease: leaseInput };
  }
  if (targetUsesGitLab(inventoryInput) && !leaseInput.openingRemoteInventory) {
    // Legacy GitLab runs without an opening provider inventory are recovery-only.
    // Finalization must not turn missing historical evidence into mutation authority.
    return { cleanup, lease: leaseInput };
  }
  let lease = leaseInput;
  let targetRevision: string;
  const targetBranch = targetBranchForRef(
    inventoryInput.repository.primaryCheckout,
    lease.targetRef
  );
  try {
    targetRevision = currentTargetRevision(lease);
  } catch (error) {
    cleanup.errors.push(
      error instanceof Error
        ? error.message
        : "The cleanup target is unresolved."
    );
    return { cleanup, lease };
  }
  if (!targetBranch) {
    cleanup.errors.push(
      `Cannot resolve the local branch for ${lease.targetRef}.`
    );
    return { cleanup, lease };
  }
  // The primary's synchronization records the target branch by name and
  // switches to it, so a name that is not exact stops automatic cleanup.
  const targetRefusal = exactBranchRefusal(
    targetBranch,
    `the primary synchronization of ${inventoryInput.repository.primaryCheckout}`
  );
  if (targetRefusal) {
    cleanup.errors.push(targetRefusal);
    return { cleanup, lease };
  }
  // Held units' checkouts, branches, claims, and primary bytes stay exactly
  // as held; an unreadable hold record stops automatic cleanup entirely.
  const protection = heldProtection(lease);
  if (!protection) {
    cleanup.errors.push(
      `The held-unit record for ${lease.runId} could not be read or no longer matches what loop hold-unit recorded, so automatic cleanup did not run.`
    );
    return { cleanup, lease };
  }
  // The recorded outcome digest binds its overrides and holds. Check it
  // before any cleanup, so a removed or edited record can never leave held
  // work unprotected while cleanup runs.
  if (lease.shipmentOutcome && !recordedOutcomeIntact(lease)) {
    cleanup.errors.push(
      `The recorded shipment outcome for ${lease.runId} no longer matches its preserved-source overrides or held units, so automatic cleanup did not run.`
    );
    return { cleanup, lease };
  }
  const repositoryPath = inventoryInput.repository.primaryCheckout;
  lease = completeAbsentRemovalIntents(lease, inventoryInput, targetRevision);
  // A held unit's claim stays, even when its checkout is gone, and so does
  // every claim on a held source checkout: a claim that replaced the one
  // observed at hold time protects the same held work.
  const keptClaims = new Set<string>([
    ...protection.holds.flatMap((hold) =>
      hold.observation.claim ? [hold.observation.claim.claimId] : []
    ),
    ...readCoordinationDocumentFromCommonDirectory(lease.commonGitDirectory)
      .claims.filter((claim) => protection.sources.has(claim.path))
      .map((claim) => claim.claimId),
  ]);
  lease = reconcileConcurrentAuthorClaims(
    lease,
    inventoryInput,
    repositoryPath,
    targetRevision,
    cleanup,
    keptClaims,
    protection.sources
  );
  // A removal disposition records the checkout's branch, so a checkout on a
  // name that is not exact stays in place. Leaving it out of the candidates
  // also keeps stale metadata pruning, which needs every prunable checkout
  // audited, from running.
  const candidates = automaticCleanupCandidates(
    lease,
    inventoryInput,
    targetRevision
  ).filter((candidate) => {
    const refusal = exactBranchRefusal(
      candidate.branch,
      `the removal disposition of ${candidate.path}`
    );
    if (refusal) {
      cleanup.errors.push(refusal);
    }
    return refusal === null;
  });
  const liveRemoval = removeAutomaticWorktrees(
    lease,
    repositoryPath,
    targetRevision,
    candidates,
    cleanup
  );
  ({ lease } = liveRemoval);
  const staleRemoval = pruneAutomaticWorktreeMetadata(
    lease,
    repositoryPath,
    candidates,
    targetRevision,
    cleanup
  );
  ({ lease } = staleRemoval);
  // Parent folders stay; the removals above may have emptied managed ones.
  cleanup.notes.push(...emptyManagedWorktreeFolderNotes(repositoryPath));
  removeTargetContainedBranches(
    lease,
    repositoryPath,
    targetBranch,
    targetRevision,
    cleanup,
    protection.branches
  );
  let inventory = captureInventory(repositoryPath);
  // A held unit packaged from the primary checkout keeps that checkout on
  // its branch with its bytes, clean or not: no switch, fast-forward, or
  // normalization.
  if (
    !protection.sources.has(lease.primaryCheckout) &&
    preparePrimarySynchronization(
      lease,
      inventory,
      targetBranch,
      targetRevision
    )
  ) {
    const carriedPolicy = reconcileTargetEquivalentPrimaryChanges(
      lease,
      inventory,
      targetBranch,
      targetRevision,
      cleanup
    );
    inventory = captureInventory(repositoryPath);
    switchCleanPrimaryToTarget(
      lease,
      inventory,
      targetBranch,
      targetRevision,
      cleanup
    );
    inventory = captureInventory(repositoryPath);
    fastForwardCleanPrimary(
      lease,
      inventory,
      targetBranch,
      targetRevision,
      cleanup,
      carriedPolicy
    );
    settleCarriedPolicyPaths(lease, carriedPolicy, targetRevision, cleanup);
    if (
      process.env.NODE_ENV === "test" &&
      process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_PRIMARY_SYNC === lease.runId
    ) {
      throw new SimpleChangesError(
        "Injected failure after primary synchronization.",
        EXIT_CODES.unsafe
      );
    }
    inventory = captureInventory(repositoryPath);
    lease = reconcilePrimarySynchronization(lease, inventory);
    lease = bindAutomaticPrimaryBranchChange(lease, inventory);
  }
  removeTargetContainedBranches(
    lease,
    repositoryPath,
    targetBranch,
    targetRevision,
    cleanup,
    protection.branches
  );
  cleanup.removedBranches = [
    ...new Map(
      cleanup.removedBranches.map((entry) => [entry.branch, entry])
    ).values(),
  ].sort((left, right) => left.branch.localeCompare(right.branch));
  cleanup.removedWorktrees = [...new Set(cleanup.removedWorktrees)].sort();
  for (const claim of releaseAbsentWorktreeClaimsUnderLock(
    lease.commonGitDirectory,
    captureInventory(repositoryPath),
    lease.ownerAgentId,
    keptClaims,
    protection.sources
  )) {
    cleanup.releasedClaims.push({
      claimId: claim.claimId,
      path: claim.path,
      releaseReason: "worktree-absent",
    });
  }
  cleanup.releasedClaims.sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  return { cleanup, lease };
};

export interface LoopUnmutatedCloseReceipt {
  checkedAt: string;
  closedBy: "loop end" | "loop finalize";
  kind: "loop-unmutated-close";
  leaseDigest: string;
  mode: LoopLease["mode"];
  openingBaselineDigest: string;
  ownerAgentId: string;
  reason: string | null;
  runId: string;
  schemaVersion: 1;
  targetRef: string;
  targetRevision: string;
  verification: {
    currentBaselineDigest: string | null;
    ok: boolean;
    violations: Pick<LoopViolation, "code" | "path">[];
  };
}

export interface LoopUnmutatedClose {
  receipt: LoopUnmutatedCloseReceipt;
  receiptPath: string;
}

// Records why an untouched run closed, then releases only its bookkeeping.
// No worktree, branch, claim, or provider state is touched.
const closeUnmutatedRun = (
  lease: LoopLease,
  verification: LoopVerification,
  reason: string | null,
  closedBy: LoopUnmutatedCloseReceipt["closedBy"]
): LoopUnmutatedClose => {
  const receiptPath = resolve(
    recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
    "abort-unmutated.json"
  );
  const receipt = writeImmutableRecoveryEvent<LoopUnmutatedCloseReceipt>(
    receiptPath,
    {
      checkedAt: verification.checkedAt,
      closedBy,
      kind: "loop-unmutated-close",
      leaseDigest: loopManifestDigest(lease),
      mode: lease.mode,
      // An untouched run never recorded a scope, so its only opening is the
      // loop-start inventory; there is no scope-time digest to report.
      openingBaselineDigest: lease.baselineDigest,
      ownerAgentId: lease.ownerAgentId,
      reason,
      runId: lease.runId,
      schemaVersion: 1,
      targetRef: lease.targetRef,
      targetRevision: lease.targetRevision,
      verification: {
        currentBaselineDigest: verification.currentBaselineDigest,
        ok: verification.ok,
        violations: verification.violations.map(({ code, path }) => ({
          code,
          path,
        })),
      },
    }
  );
  rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
  return { receipt, receiptPath };
};

const missingShipmentScopeBlockers = (lease: LoopLease): string[] =>
  lease.shipmentScopeRequired && !lease.shipmentScope
    ? [
        "Record the comprehensive shipment scope and pre-ship brief before ending this Ship run.",
      ]
    : [];

/**
 * The overrides and handoffs recorded beside the lease for its exact shipment
 * outcome. Throws when the stored receipt and its sidecars no longer
 * recompose into the complete receipt the recorded digest names.
 */
const storedPreservedSources = (lease: LoopLease): PreservedSourceEvidence => {
  const outcome = lease.shipmentOutcome;
  if (!outcome) {
    return { handoffs: [], overrides: [] };
  }
  return recordedPreservedSourceEvidence(
    readReceiptSidecar(
      lease.commonGitDirectory,
      PRESERVED_SOURCE_OVERRIDE_DIRECTORY,
      lease.runId
    ),
    readReceiptSidecar(
      lease.commonGitDirectory,
      PRESERVED_SOURCE_HANDOFF_DIRECTORY,
      lease.runId
    ),
    lease.runId,
    outcome.receipt,
    outcome.receiptDigest,
    readHeldUnits(lease).map((hold) => hold.holdDigest)
  );
};

const recordedOutcomeIntact = (lease: LoopLease): boolean => {
  try {
    storedPreservedSources(lease);
    return true;
  } catch {
    return false;
  }
};

type RecordedUnit = NonNullable<
  LoopLease["shipmentOutcome"]
>["receipt"]["units"][number];

type ScopedUnit = NonNullable<
  LoopLease["shipmentScope"]
>["plan"]["units"][number];

/**
 * Why the override or handoff recorded for one unit no longer holds, or null
 * when it does or the unit has neither.
 */
const preservedSourceIssue = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  unit: RecordedUnit,
  expected: ScopedUnit,
  evidence: PreservedSourceEvidence
): string | null => {
  const outcome = lease.shipmentOutcome;
  if (!outcome) {
    return null;
  }
  const override = evidence.overrides.find(
    (item) => item.unitId === expected.id
  );
  if (override) {
    return preservedSourceOverrideIssue(
      lease,
      inventory,
      outcome.receipt,
      unit,
      override,
      expected,
      outcome.recordedAt
    );
  }
  const handoff = evidence.handoffs.find((item) => item.unitId === expected.id);
  return handoff
    ? preservedSourceHandoffIssue(
        lease,
        inventory,
        outcome.receipt,
        unit,
        handoff,
        expected,
        outcome.recordedAt
      )
    : null;
};

const shipmentOutcomeCompletionBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string | null
): string[] => {
  if (!lease.shipmentScope) {
    return [];
  }
  if (!lease.shipmentOutcome) {
    return [
      "Record the exact reviewed shipment outcome before completion; every scoped unit and final target delta must be accounted for.",
    ];
  }
  const { receipt } = lease.shipmentOutcome;
  if (receipt.targetRevision !== targetRevision) {
    return [
      `Shipment outcome targets ${receipt.targetRevision}, but the current target is ${targetRevision ?? "unresolved"}. Reconcile the exact final target again.`,
    ];
  }
  const paths = [
    ...receipt.units.flatMap((unit) => [
      ...unit.finalPaths,
      ...unit.originalPaths,
    ]),
    ...receipt.additionalPaths,
  ];
  const targetBlockers = paths.flatMap((item) =>
    targetTreeEntry(
      lease.primaryCheckout,
      receipt.targetRevision,
      item.path
    ) === item.entry
      ? []
      : [`Shipment outcome entry changed after review: ${item.path}`]
  );
  let evidence: PreservedSourceEvidence;
  let holds: HeldUnitHold[];
  try {
    evidence = storedPreservedSources(lease);
    holds = readHeldUnits(lease);
  } catch (error) {
    return [
      ...targetBlockers,
      error instanceof Error ? error.message : String(error),
    ];
  }
  // Every scoped unit is either reported in the outcome or held, never both.
  const held = heldUnitIds(holds);
  const reported = new Set(receipt.units.map((unit) => unit.unitId));
  const unitBlockers = lease.shipmentScope.plan.units.flatMap((unit) => {
    if (held.has(unit.id) && reported.has(unit.id)) {
      return [
        `Shipment outcome reports held unit ${unit.id}; a held unit is preserved and never delivered or target-equivalent. Record the outcome again without it.`,
      ];
    }
    if (!(held.has(unit.id) || reported.has(unit.id))) {
      return [
        `Shipment outcome omits scoped unit ${unit.id}, which is not held. Record the outcome again.`,
      ];
    }
    return [];
  });
  // A run that held every scoped unit delivered none of its scope. It closes
  // only at the exact pinned target, however it closes, and never as a
  // verified delivery.
  if (allUnitsHeld(lease, holds) && targetRevision !== lease.targetRevision) {
    unitBlockers.push(
      `Every scoped unit of ${lease.runId} is held, so it delivered nothing, but the target moved from ${lease.targetRevision} to ${targetRevision ?? "unresolved"}. A run that held all of its work closes only at its pinned target; replan it instead.`
    );
  }
  // A preserved-source override or handoff holds only while its source,
  // claim, pause, copy, and target entries stay exactly as approved.
  const sourceBlockers = lease.shipmentScope.plan.units.flatMap((expected) => {
    const unit = receipt.units.find((item) => item.unitId === expected.id);
    const issue = unit
      ? preservedSourceIssue(lease, inventory, unit, expected, evidence)
      : null;
    return issue
      ? [
          `Manually approved preserved source ${expected.sourceWorktree} changed after recording: ${issue}`,
        ]
      : [];
  });
  return [...targetBlockers, ...unitBlockers, ...sourceBlockers];
};

// What a merging run owes its primary checkout and local target branch.
const primaryAndTargetBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string | null,
  targetRevision: string | null
): string[] => {
  const blockers: string[] = [];
  const localTarget = targetBranch
    ? inventory.branches.find((branch) => branch.name === targetBranch)
    : undefined;
  if (targetBranch && targetRevision && !localTarget) {
    blockers.push(
      `Create local target branch ${targetBranch} at ${targetRevision} before ending the loop.`
    );
  } else if (
    targetRevision &&
    localTarget &&
    localTarget.sha !== targetRevision
  ) {
    blockers.push(
      `Update local target branch ${localTarget.name} from ${localTarget.sha} to ${targetRevision} before ending the loop.`
    );
  }
  const primaryWorktree = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (targetBranch && primaryWorktree?.branch !== targetBranch) {
    blockers.push(
      `Restore primary checkout ${lease.primaryCheckout} to local target branch ${targetBranch} before ending the loop.`
    );
  }
  if (primaryWorktree && primaryWorktree.changes.length > 0) {
    blockers.push(
      `Clean primary checkout ${lease.primaryCheckout} before ending the loop; preserve uncertain changes instead of discarding them.`
    );
  }
  return blockers;
};

// Clean worktrees and local branches the target already contains.
const containedCleanupBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string | null,
  targetRevision: string | null
): string[] => {
  const blockers: string[] = [];
  const registeredByPath = new Map(
    lease.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const isTargetContained = (revision: string): boolean =>
    Boolean(
      targetRevision &&
        runGit(
          inventory.repository.primaryCheckout,
          [
            "merge-base",
            "--is-ancestor",
            `${revision}^{commit}`,
            `${targetRevision}^{commit}`,
          ],
          true
        ).exitCode === 0
    );
  const rebaselined = rebaselinedPaths(lease);
  const mergedCleanupWorktrees = inventory.worktrees
    .filter((worktree) => {
      if (rebaselined.has(worktree.path)) {
        return false;
      }
      const registered = registeredByPath.get(worktree.path);
      return (
        !worktree.isPrimary &&
        worktree.changes.length === 0 &&
        !registered?.createdByRun &&
        registered?.role !== "concurrent-author" &&
        registered?.role !== "retained" &&
        Boolean(worktree.headSha && isTargetContained(worktree.headSha))
      );
    })
    .map((worktree) => worktree.path);
  if (mergedCleanupWorktrees.length > 0) {
    blockers.push(
      `Remove clean worktrees whose branches are contained in ${lease.targetRef}: ${mergedCleanupWorktrees.join(", ")}`
    );
  }
  const retirementBacked = retirementBackedBranches(lease, inventory);
  const mergedCleanupBranchNames = inventory.branches
    .filter(
      (branch) =>
        branch.name !== targetBranch &&
        branch.worktreePath === null &&
        !retirementBacked.has(branch.name) &&
        isTargetContained(branch.sha)
    )
    .map((branch) => branch.name);
  if (mergedCleanupBranchNames.length > 0) {
    blockers.push(
      `Delete local branches contained in ${lease.targetRef}: ${mergedCleanupBranchNames.join(", ")}`
    );
  }
  return blockers;
};

const repositoryCleanupBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string | null,
  targetRevision: string | null
): string[] => [
  ...primaryAndTargetBlockers(lease, inventory, targetBranch, targetRevision),
  ...containedCleanupBlockers(lease, inventory, targetBranch, targetRevision),
];

/**
 * How a run may close apart from the default bar of merged work and a clean
 * primary at the target: `scoped` for an exact verified shipment or a run
 * that held every unit, `queued` for a Queue or Sweep run, whose finish line
 * is its own pushed branches and never the target.
 */
interface CompletionBasis {
  queued?: QueuedAssessment | null;
  scoped?: boolean;
}

// A Queue or Sweep run answers for its own checkouts through their queued
// state; every other run must have removed the ones it created.
const runWorktreeBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  { queued, scoped }: CompletionBasis
): string[] => {
  if (queued) {
    return queued.blockers;
  }
  const liveRunWorktrees = lease.worktrees.filter(
    (worktree) =>
      worktree.createdByRun &&
      inventory.worktrees.some((current) => current.path === worktree.path)
  );
  return !scoped && liveRunWorktrees.length > 0
    ? [
        `Remove run-created worktrees before ending the loop: ${liveRunWorktrees
          .map((worktree) => worktree.path)
          .join(", ")}`,
      ]
    : [];
};

const loopCompletionBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification,
  cleanupErrors: string[] = [],
  basis: CompletionBasis = {}
): string[] => {
  const blockers: string[] = [...cleanupErrors];
  blockers.push(...missingShipmentScopeBlockers(lease));
  if (!verification.ok) {
    blockers.push(
      `manifest violations: ${verification.violations
        .map((violation) => `${violation.code}:${violation.path}`)
        .join(", ")}`
    );
  }
  blockers.push(...runWorktreeBlockers(lease, inventory, basis));
  let targetBranch: string | null = null;
  let targetRevision: string | null = null;
  try {
    targetBranch = targetBranchForRef(
      inventory.repository.primaryCheckout,
      lease.targetRef
    );
    targetRevision = currentTargetRevision(lease);
  } catch {
    blockers.push(
      `Refresh unresolved target ref ${lease.targetRef} before ending the loop.`
    );
  }
  blockers.push(
    ...shipmentOutcomeCompletionBlockers(lease, inventory, targetRevision)
  );
  if (!(basis.scoped || basis.queued)) {
    blockers.push(
      ...repositoryCleanupBlockers(
        lease,
        inventory,
        targetBranch,
        targetRevision
      )
    );
  }
  if (
    lease.emergencyShipping &&
    deriveEmergencyShippingStatus(lease.emergencyShipping) !== "complete"
  ) {
    blockers.push(
      `Emergency Shipping remains incomplete: ${decideEmergencyShipping(lease.emergencyShipping).action}.`
    );
  }
  try {
    assertCurrentRemoteBranchReconciliation(lease, inventory);
  } catch (error) {
    blockers.push(
      error instanceof Error ? error.message : "Remote reconciliation failed."
    );
  }
  return blockers;
};

export interface LoopFinalizationResult {
  /**
   * Expired worktree archives pruned once the run closed, with notes that
   * belong to the result only (a policy value that fell back, a pruning
   * failure); null when the run was relinquished. Never part of the
   * finalization receipt, which is persisted before pruning runs.
   */
  archivePruning: {
    notes: string[];
    result: ArchivePruneResult | null;
  } | null;
  blockers: string[];
  cleanup: FinalizationCleanupResult;
  closedWithoutMutation?: LoopUnmutatedClose;
  /**
   * Pins of branches deleted outside earlier runs that this closed run
   * removed once their retention passed. Not persisted in the receipt.
   */
  expiredExternalDeletionPins?: ExpiredExternalDeletionPins;
  lease: LoopLease | null;
  outcome: "completed" | "relinquished" | "closed-without-mutation";
  receipt: LoopFinalizationReceipt;
  receiptPath: string;
  verification: LoopVerification;
}

/**
 * How a Queue or Sweep run closed: its branches are pushed and waiting for
 * review. Nothing was merged or delivered, and the target did not change.
 */
export interface LoopFinalizationQueued {
  /**
   * Every checkout the run created that still exists. Finalization keeps
   * them all: it deletes no checkout, branch, or file in these modes.
   */
  keptWorktrees: string[];
  status: typeof QUEUED_FOR_REVIEW;
  summary: string;
  units: QueuedUnit[];
}

/**
 * A unit `loop hold-unit` held, reported apart from delivered work. Its
 * source checkout, branch, claim, and bytes were left untouched.
 */
export interface LoopFinalizationHeldUnit {
  approvedBy: string;
  holdDigest: string;
  paths: string[];
  reason: string;
  recordedAt: string;
  sourceBranch: string | null;
  sourceHeadSha: string | null;
  /** Whether the source still has the exact branch, head, status, and bytes the hold recorded. */
  sourceMatchesHold: boolean;
  sourceWorktree: string;
  title: string;
  unitId: string;
}

export interface LoopFinalizationReceipt {
  /** Questions a paused controller left for the user. */
  awaitingUser?: string[];
  blockers: string[];
  blocksNextShipment: boolean;
  cleanup: FinalizationCleanupResult;
  cleanupStatus: "complete" | "pending";
  controllerStatus: "released" | "relinquished";
  deliveryStatus: "verified" | "unverified";
  finalizedAt: string;
  /** Units held instead of delivered; present only when the run held one. */
  heldUnits?: LoopFinalizationHeldUnit[];
  kind: "loop-finalization";
  leaseDigest: string;
  preservedWorktrees: string[];
  /**
   * Present only when a Queue or Sweep run closed at its own finish line:
   * queued for review, not merged. `deliveryStatus` stays `unverified`.
   */
  queued?: LoopFinalizationQueued;
  reason: string;
  /**
   * Preserved provider branches the evidence says are finished, when a
   * remote-branch reconciliation receipt was recorded, and branches deleted
   * outside the run. Any pending entry, branch deleted outside the run, or
   * error makes `cleanupStatus` pending; none of them blocks closing.
   */
  remoteBranches?: RemoteBranchCleanupReport;
  /** Review attempts recorded during the run, per proposal, when a ledger exists. */
  reviewAttempts?: ReviewAttemptsReport;
  runId: string;
  schemaVersion: 1;
  shipmentStatus: "closed" | "open" | "unstarted";
  targetRevision: string | null;
}

// Whether a held source still has exactly what its hold recorded.
const heldSourceMatches = (
  hold: HeldUnitHold,
  inventory: RepositoryInventory
): boolean => {
  const { source } = hold.observation;
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === source.worktree
  );
  if (
    !current ||
    current.branch !== source.branch ||
    current.headSha !== source.headSha ||
    current.changeDigest !== source.changeDigest
  ) {
    return false;
  }
  try {
    return [...hold.observation.paths, ...hold.observation.originalPaths].every(
      (item) =>
        worktreeSourceEntry(current.path, item.path) === item.sourceEntry
    );
  } catch {
    return false;
  }
};

const heldUnitsField = (
  lease: LoopLease,
  inventory: RepositoryInventory
): Pick<LoopFinalizationReceipt, "heldUnits"> => {
  const holds = heldProtection(lease)?.holds ?? [];
  if (holds.length === 0) {
    return {};
  }
  return {
    heldUnits: holds.map((hold) => ({
      approvedBy: hold.authorization.approvedBy,
      holdDigest: hold.holdDigest,
      paths: [...hold.unit.paths],
      reason: hold.observation.reason,
      recordedAt: hold.recordedAt,
      sourceBranch: hold.observation.source.branch,
      sourceHeadSha: hold.observation.source.headSha,
      sourceMatchesHold: heldSourceMatches(hold, inventory),
      sourceWorktree: hold.unit.sourceWorktree,
      title: hold.unit.title,
      unitId: hold.unit.id,
    })),
  };
};

/**
 * Reports preserved provider branches that are finished but still present, so
 * a run that kept them can never read as clean. It reads only the recorded
 * receipt and local evidence, and a failure becomes a reported error, which
 * counts as pending, rather than a failed finalization.
 */
const remoteBranchesField = (
  lease: LoopLease,
  inventory: RepositoryInventory
): Pick<LoopFinalizationReceipt, "remoteBranches"> => {
  const receipt = lease.remoteBranchReconciliation;
  if (!receipt) {
    return {};
  }
  try {
    return {
      remoteBranches: remoteBranchCleanupReport({
        claims: readCoordinationDocumentFromCommonDirectory(
          lease.commonGitDirectory
        ).claims,
        inventory,
        openTargets: recordedOpenProposalTargets(lease),
        receipt,
        runId: lease.runId,
      }),
    };
  } catch (error) {
    return {
      remoteBranches: {
        errors: [
          `Remote branch cleanup could not be checked: ${error instanceof Error ? error.message : String(error)}`,
        ],
        held: [],
        openProposalTargets: "unknown",
        pending: [],
      },
    };
  }
};

const reviewAttemptsField = (
  lease: LoopLease
): Pick<LoopFinalizationReceipt, "reviewAttempts"> => {
  const report = reviewAttemptsForFinalization(
    lease.commonGitDirectory,
    lease.createdAt
  );
  return report ? { reviewAttempts: report } : {};
};

// Delivery and repository housekeeping are separate completion conditions. Only
// an exact delivered outcome may close with unrelated state left in place.
const hasVerifiedDelivery = (
  lease: LoopLease,
  inventory: RepositoryInventory
): boolean => {
  const scope = lease.shipmentScope;
  const outcome = lease.shipmentOutcome?.receipt;
  if (
    !(
      scope &&
      outcome &&
      (outcome.units.length > 0 || outcome.additionalPaths.length > 0)
    )
  ) {
    return false;
  }
  const target = currentTargetRevision(lease);
  if (shipmentOutcomeCompletionBlockers(lease, inventory, target).length > 0) {
    return false;
  }
  // Held units are reported separately and never count as delivered; the
  // blockers above already proved the hold record readable. A run that held
  // every unit delivered none of its scope.
  const holds = readHeldUnits(lease);
  if (allUnitsHeld(lease, holds)) {
    return false;
  }
  const held = heldUnitIds(holds);
  return scope.plan.units.every((unit) => {
    if (held.has(unit.id)) {
      return true;
    }
    const source = inventory.worktrees.find(
      (worktree) => worktree.path === unit.sourceWorktree
    );
    if (!source) {
      return (lease.dispositions ?? []).some(
        (item) =>
          item.path === unit.sourceWorktree &&
          item.status === "completed" &&
          item.targetRevision === target
      );
    }
    if (source.isPrimary && preservesUnchangedPrimary(lease, inventory)) {
      return true;
    }
    if (
      source.changes.length === 0 &&
      source.headSha &&
      targetContainmentAudit(lease.primaryCheckout, target, source.headSha)
        .method
    ) {
      return true;
    }
    // A user-approved preserved source stays dirty in its owner's claimed
    // checkout; it counts only while its override or handoff still holds
    // exactly. The completion blockers above already proved the sidecars
    // readable.
    const evidence = storedPreservedSources(lease);
    const recorded = outcome.units.find((item) => item.unitId === unit.id);
    return Boolean(
      recorded &&
        [...evidence.overrides, ...evidence.handoffs].some(
          (item) => item.unitId === unit.id
        ) &&
        preservedSourceIssue(lease, inventory, recorded, unit, evidence) ===
          null
    );
  });
};

/**
 * Proves that a primary checkout still carrying dirty paths does not hold the
 * shipment open: it is unchanged from its baseline, its HEAD is contained in
 * the target, every scoped path has its recorded reviewed result in the
 * target, and every other dirty path was explicitly preserved or excluded.
 */
const preservesUnchangedPrimary = (
  lease: LoopLease,
  inventory: RepositoryInventory
): boolean => {
  const primary = inventory.worktrees.find((worktree) => worktree.isPrimary);
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  const scope = lease.shipmentScope;
  // The proof compares branches by name, which a branch that is not exact
  // cannot prove.
  if (!(primary && registered && scope) || isLossyName(primary.branch)) {
    return false;
  }
  // A held unit's primary paths are excluded, never delivered.
  const protection = heldProtection(lease);
  if (!protection) {
    return false;
  }
  const units = scope.plan.units.filter(
    (unit) =>
      unit.sourceWorktree === primary.path && !protection.unitIds.has(unit.id)
  );
  const outcome = lease.shipmentOutcome?.receipt;
  const delivered = new Map<string, string | null>();
  for (const unit of units) {
    const result = outcome?.units.find((item) => item.unitId === unit.id);
    if (!result) {
      return false;
    }
    for (const item of [...result.finalPaths, ...result.originalPaths]) {
      delivered.set(item.path, item.entry);
    }
  }
  const target = currentTargetRevision(lease);
  return primaryDeliveryProof({
    baselineBranch: registered.branch,
    baselineDigest:
      matchingOverride(lease, primary)?.changeDigest ??
      registered.baselineChangeDigest,
    baselineHead: registered.baselineHeadSha,
    branch: primary.branch,
    changes: primary.changes,
    delivered,
    digest: primary.changeDigest,
    excluded: [
      ...scope.plan.exclusions
        .filter((item) => item.worktreePath === primary.path)
        .map((item) => item.path),
      ...protection.primaryPaths,
    ],
    head: primary.headSha,
    headContained: Boolean(
      primary.headSha &&
        targetContainsRevision(lease.primaryCheckout, target, primary.headSha)
    ),
    headEntry: (path) =>
      primary.headSha
        ? targetTreeEntry(primary.path, primary.headSha, path)
        : null,
    isPrimary: primary.isPrimary,
    outcomeTarget: units.length > 0 ? outcome?.targetRevision : target,
    preserved: scope.plan.preserved
      .filter((item) => item.worktreePath === primary.path)
      .flatMap((item) => item.paths),
    scoped: units.flatMap((unit) => unit.paths),
    sourceEntry: (path) => worktreeSourceEntry(primary.path, path),
    target,
    targetEntry: (path) => targetTreeEntry(lease.primaryCheckout, target, path),
  });
};

/**
 * A run that held every scoped unit delivered nothing. It may close, with
 * delivery left unverified, when its intact outcome is exactly empty (so the
 * target did not move), and any dirty primary is unchanged from its baseline
 * with every dirty path held, preserved, or excluded.
 */
const allHeldCompletion = (
  lease: LoopLease,
  inventory: RepositoryInventory
): boolean => {
  const scope = lease.shipmentScope;
  const outcome = lease.shipmentOutcome?.receipt;
  const protection = heldProtection(lease);
  if (
    !(scope && outcome && protection) ||
    scope.plan.units.length === 0 ||
    !scope.plan.units.every((unit) => protection.unitIds.has(unit.id)) ||
    outcome.units.length > 0 ||
    outcome.additionalPaths.length > 0
  ) {
    return false;
  }
  // The blockers include the exact pinned-target rule for all-held runs.
  const target = currentTargetRevision(lease);
  if (shipmentOutcomeCompletionBlockers(lease, inventory, target).length > 0) {
    return false;
  }
  const primary = inventory.worktrees.find((worktree) => worktree.isPrimary);
  return (
    !primary?.changes.length || preservesUnchangedPrimary(lease, inventory)
  );
};

const shipmentFinalizationVerification = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification,
  verifiedDelivery: boolean
): LoopVerification => {
  if (!verifiedDelivery) {
    return verification;
  }
  const targetBranch = targetBranchForRef(
    lease.primaryCheckout,
    lease.targetRef
  );
  const primary = inventory.worktrees.find((worktree) => worktree.isPrimary);
  const violations = verification.violations.filter((violation) => {
    if (
      violation.code === "preserved-worktree-changed" &&
      violation.path === lease.primaryCheckout &&
      preservesUnchangedPrimary(lease, inventory)
    ) {
      return false;
    }
    if (violation.code !== "unregistered-worktree") {
      return true;
    }
    const arrival = inventory.worktrees.find(
      (worktree) => worktree.path === violation.path
    );
    return !(
      arrival &&
      !arrival.isPrimary &&
      arrival.branch !== targetBranch &&
      arrival.branch !== primary?.branch &&
      !lease.preparations.some((item) => item.path === arrival.path)
    );
  });
  return { ...verification, ok: violations.length === 0, violations };
};

// Cleanup a Queue or Sweep run saw and left alone, since it never cleans
// up: clean worktrees and local branches the target already contains.
const queuedLeftovers = (
  lease: LoopLease,
  inventory: RepositoryInventory
): string[] => {
  try {
    return containedCleanupBlockers(
      lease,
      inventory,
      targetBranchForRef(inventory.repository.primaryCheckout, lease.targetRef),
      currentTargetRevision(lease)
    );
  } catch {
    // Completion reports the unresolved target itself.
    return [];
  }
};

/**
 * Whether housekeeping remains after this finalization. A Queue or Sweep
 * run that closes owes none for the primary checkout or the local target
 * branch, which it never moves, so only what the target already contains
 * counts for it; one that stays open is pending like any other.
 */
const housekeepingPending = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  strictVerification: LoopVerification,
  blockers: readonly string[],
  cleanupErrors: string[],
  queued: QueuedAssessment | null
): boolean =>
  queued
    ? blockers.length > 0 || queuedLeftovers(lease, inventory).length > 0
    : loopCompletionBlockers(
        lease,
        inventory,
        strictVerification,
        cleanupErrors
      ).length > 0;

const queuedField = (
  lease: LoopLease,
  queued: QueuedAssessment | null,
  blockers: readonly string[]
): Pick<LoopFinalizationReceipt, "queued"> =>
  queued && blockers.length === 0
    ? {
        queued: {
          keptWorktrees: queued.keptWorktrees,
          status: QUEUED_FOR_REVIEW,
          summary: queuedSummary(lease, queued),
          units: queued.units,
        },
      }
    : {};

const finalizationDecision = (
  lease: LoopLease,
  finalInventory: RepositoryInventory,
  cleanup: FinalizationCleanupResult,
  reason: string,
  awaitingUser: string[] | null = null,
  // A Queue or Sweep run's own checkouts read as queued work; null for
  // every other run.
  queued: QueuedAssessment | null = null
): {
  blockers: string[];
  verification: LoopVerification;
  receipt: LoopFinalizationReceipt;
} => {
  const strictVerification = verificationAgainst(lease, finalInventory);
  let verifiedDelivery = false;
  try {
    verifiedDelivery = hasVerifiedDelivery(lease, finalInventory);
  } catch {
    // The ordinary blockers below report unresolved target evidence.
  }
  const primary = finalInventory.worktrees.find(
    (worktree) => worktree.isPrimary
  );
  let heldOnly = false;
  if (!verifiedDelivery) {
    try {
      heldOnly = allHeldCompletion(lease, finalInventory);
    } catch {
      // The ordinary blockers below report unresolved target evidence.
    }
  }
  // A run that held every unit closes like a scoped delivery, with its held
  // work preserved in place, but never reports verified delivery.
  const scopedCompletion =
    heldOnly ||
    (verifiedDelivery &&
      (!primary?.changes.length ||
        preservesUnchangedPrimary(lease, finalInventory)));
  const verification = shipmentFinalizationVerification(
    lease,
    finalInventory,
    strictVerification,
    scopedCompletion
  );
  const blockers = loopCompletionBlockers(
    lease,
    finalInventory,
    verification,
    cleanup.errors,
    { queued, scoped: scopedCompletion }
  );
  if (
    lease.shipmentOutcome?.receipt.units.some(
      (unit) => unit.disposition === "delivered"
    ) &&
    !verifiedDelivery
  ) {
    blockers.push(
      "Reconcile delivered source worktrees and the exact current target before finalization; unaccounted source changes must remain open."
    );
  }
  if (awaitingUser) {
    blockers.push(
      `Paused for the user's answer before this run can continue: ${awaitingUser.join(" | ")}`
    );
  }
  const lifecycle: Pick<
    LoopFinalizationReceipt,
    "blocksNextShipment" | "controllerStatus" | "shipmentStatus"
  > =
    blockers.length === 0
      ? {
          blocksNextShipment: false,
          controllerStatus: "released",
          shipmentStatus: "closed",
        }
      : {
          blocksNextShipment: true,
          controllerStatus: "relinquished",
          shipmentStatus: "open",
        };
  const remoteBranches = remoteBranchesField(lease, finalInventory);
  const cleanupPending =
    housekeepingPending(
      lease,
      finalInventory,
      strictVerification,
      blockers,
      cleanup.errors,
      queued
    ) ||
    (remoteBranches.remoteBranches?.pending.length ?? 0) > 0 ||
    (remoteBranches.remoteBranches?.deletedExternally?.length ?? 0) > 0 ||
    (remoteBranches.remoteBranches?.errors.length ?? 0) > 0;
  const now = new Date().toISOString();
  const receipt: LoopFinalizationReceipt = {
    ...lifecycle,
    ...(awaitingUser ? { awaitingUser } : {}),
    blockers,
    cleanup,
    cleanupStatus: cleanupPending ? "pending" : "complete",
    deliveryStatus: verifiedDelivery ? "verified" : "unverified",
    finalizedAt: now,
    ...heldUnitsField(lease, finalInventory),
    kind: "loop-finalization",
    leaseDigest: loopManifestDigest(lease),
    preservedWorktrees: finalInventory.worktrees
      .map((worktree) => worktree.path)
      .sort((left, right) => left.localeCompare(right)),
    ...queuedField(lease, queued, blockers),
    reason,
    ...remoteBranches,
    ...reviewAttemptsField(lease),
    runId: lease.runId,
    schemaVersion: 1,
    targetRevision: verifiedDelivery
      ? (lease.shipmentOutcome?.receipt.targetRevision ?? null)
      : null,
  };
  return { blockers, receipt, verification };
};

const releaseDeliveredSourceClaims = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  cleanup: FinalizationCleanupResult
): void => {
  // A held unit's checkout keeps its claim, even when a delivered unit
  // shares it; an unreadable hold record releases nothing.
  const protection = heldProtection(lease);
  if (!protection) {
    return;
  }
  const sourcePaths = new Set(
    lease.shipmentScope?.plan.units
      .map((unit) => unit.sourceWorktree)
      .filter((path) => !protection.sources.has(path))
  );
  const { claims } = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  for (const claim of claims) {
    const source = inventory.worktrees.find(
      (worktree) => worktree.path === claim.path
    );
    if (
      claim.state === "active" &&
      claim.owner.agentId === lease.ownerAgentId &&
      sourcePaths.has(claim.path) &&
      source &&
      source.branch === claim.branch &&
      !isLossyName(source.branch) &&
      source.changes.length === 0
    ) {
      releaseClaimUnderLock(
        lease.commonGitDirectory,
        claim.claimId,
        lease.ownerAgentId,
        "shipped"
      );
      cleanup.releasedClaims.push({
        claimId: claim.claimId,
        path: claim.path,
        releaseReason: "shipped",
      });
    }
  }
};

// Finalization runs before every terminal response, including one that ends
// the turn on a scope question. Relinquishing an untouched Ship run would freeze
// a scope it never recorded and leave only an approved replan, so finalization
// closes it instead, whether or not the repository moved. Nothing is lost: a
// fresh `loop start` on an unchanged repository takes the same baseline.
const finalizeUnmutatedRun = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  reason: string,
  awaitingUser: string[] | null
): LoopFinalizationResult | null => {
  if (!isUnmutatedScopelessRun(lease)) {
    return null;
  }
  const verification = verificationAgainst(lease, inventory);
  if (!unmutatedCloseReady(lease, inventory, verification)) {
    return null;
  }
  const cleanup = emptyFinalizationCleanup();
  const receipt: LoopFinalizationReceipt = {
    ...(awaitingUser ? { awaitingUser } : {}),
    blockers: [],
    blocksNextShipment: false,
    cleanup,
    // No automatic cleanup runs for a run that never recorded its scope.
    cleanupStatus: "pending",
    controllerStatus: "released",
    deliveryStatus: "unverified",
    finalizedAt: verification.checkedAt,
    kind: "loop-finalization",
    leaseDigest: loopManifestDigest(lease),
    preservedWorktrees: inventory.worktrees
      .map((worktree) => worktree.path)
      .sort((left, right) => left.localeCompare(right)),
    reason,
    ...reviewAttemptsField(lease),
    runId: lease.runId,
    schemaVersion: 1,
    shipmentStatus: "unstarted",
    targetRevision: null,
  };
  const receiptPath = resolve(
    recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
    `finalization-${sha256Json(receipt)}.json`
  );
  writeImmutableRecoveryEvent(receiptPath, { lease, receipt });
  forgetLeaseSession(lease);
  removeControllerBinding(lease);
  return {
    archivePruning: null,
    blockers: [],
    cleanup,
    closedWithoutMutation: closeUnmutatedRun(
      lease,
      verification,
      reason,
      "loop finalize"
    ),
    lease: null,
    outcome: "closed-without-mutation",
    receipt,
    receiptPath,
    verification,
  };
};

const relinquishController = (
  lease: LoopLease,
  reason: string,
  now: string,
  awaitingUser: string[] | null = null
): LoopLease => {
  forgetLeaseSession(lease);
  // A released controller is no session's to finish; only its questions stay.
  writeControllerBinding(lease, {
    awaitingUser: awaitingUser
      ? { questions: awaitingUser, recordedAt: now }
      : null,
    session: null,
  });
  return writeLease({
    ...withMutationEvidence(lease, now),
    controller: {
      ...controllerLifecycle(lease),
      reason,
      relinquishedAt: now,
      status: "relinquished",
    },
    shipmentScopeFrozenAt: effectiveShipmentScopeFrozenAt(lease) ?? now,
    updatedAt: now,
    worktrees: lease.worktrees.map((worktree) =>
      worktree.role === "controller"
        ? { ...worktree, mutationAllowed: false }
        : worktree
    ),
  });
};

const finalizeOwnedLoop = (
  repositoryPath: string,
  openingLease: LoopLease,
  inventory: RepositoryInventory,
  reason: string,
  awaitingUser: string[] | null,
  declared: QueuedDeclarations
): LoopFinalizationResult => {
  let lease = reconcileAbsentRetainedWorktrees(openingLease, inventory);
  lease = reconcilePrimarySynchronization(lease, inventory);
  const openingVerification = verificationAgainst(lease, inventory);
  const automaticCleanup =
    lease.shipmentScopeRequired && !lease.shipmentScope
      ? { cleanup: emptyFinalizationCleanup(), lease }
      : automaticFinalizationCleanup(lease, inventory, openingVerification);
  ({ lease } = automaticCleanup);
  const finalInventory = captureInventory(repositoryPath);
  // A Queue or Sweep run never merges, so it is judged by its own pushed
  // branches and proposals. Its finalization deletes nothing: the primary
  // checkout, the local target branch, every earlier branch and worktree,
  // and the run's own worktrees all stay as they are.
  const queued = closesAsQueued(lease)
    ? assessQueuedWork(lease, finalInventory, declared)
    : null;
  if (queued) {
    automaticCleanup.cleanup.notes.push(
      ...queuedLeftovers(lease, finalInventory).map(
        (leftover) =>
          `Left for a later Integrate, Reconcile, or \`prune\`, because a ${lease.mode} run never cleans up: ${leftover}`
      )
    );
  }
  const { blockers, verification, receipt } = finalizationDecision(
    lease,
    finalInventory,
    automaticCleanup.cleanup,
    reason,
    awaitingUser,
    queued
  );
  const now = receipt.finalizedAt;
  if (blockers.length === 0 && receipt.deliveryStatus === "verified") {
    releaseDeliveredSourceClaims(
      lease,
      finalInventory,
      automaticCleanup.cleanup
    );
  }
  const receiptPath = resolve(
    recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
    `finalization-${sha256Json(receipt)}.json`
  );
  writeImmutableRecoveryEvent(receiptPath, { lease, receipt });
  if (blockers.length === 0) {
    rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
    forgetLeaseSession(lease);
    removeControllerBinding(lease);
    return {
      archivePruning: null,
      blockers,
      cleanup: automaticCleanup.cleanup,
      lease: null,
      outcome: "completed",
      receipt,
      receiptPath,
      verification,
    };
  }
  const updated = relinquishController(lease, reason, now, awaitingUser);
  return {
    archivePruning: null,
    blockers,
    cleanup: automaticCleanup.cleanup,
    lease: updated,
    outcome: "relinquished",
    receipt,
    receiptPath,
    verification,
  };
};

// Cleanup may already have persisted removal or synchronization evidence.
// Release the latest state under both locks, never the opening snapshot, and
// keep the failure that stopped finalization visible: an unwritable lease is
// reported beside it, never instead of it.
const relinquishAfterFinalizationError = (
  lease: LoopLease,
  error: unknown,
  awaitingUser: string[] | null
): never => {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    const current = readLeaseFromCommonDirectory(lease.commonGitDirectory);
    if (current?.runId === lease.runId) {
      relinquishController(
        current,
        `Finalization failed: ${detail}`.slice(0, 500),
        new Date().toISOString(),
        awaitingUser
      );
    }
  } catch (relinquishError) {
    const relinquishDetail =
      relinquishError instanceof Error
        ? relinquishError.message
        : String(relinquishError);
    throw new Error(
      `Finalization failed: ${detail}. The controller could not be relinquished: ${relinquishDetail}`,
      { cause: relinquishError }
    );
  }
  throw error;
};

export interface LoopFinalizationOptions {
  /**
   * Decisions the controller is about to ask the user for. The run pauses:
   * it relinquishes even when nothing else blocks closure, records the
   * questions, and resumes with `loop start --mode resume` after the answer.
   */
  awaitingUser?: readonly string[];
  /**
   * `--no-proposal`: why this run's pushed branches have no proposal. It
   * counts only for a Queue or Sweep run whose remote has nowhere to open
   * one; the receipt then reports each such branch as pushed without a
   * proposal. A remote on a forge that can open proposals ignores it.
   */
  noProposal?: string;
  /**
   * Runs under the loop locks when the run closes (completed or closed
   * without mutation), never when it pauses or relinquishes.
   */
  onClosed?: () => void;
  /**
   * `--queued-proposal <branch>=<id>`, once per pushed branch of a Queue or
   * Sweep run: the proposal that carries that branch. It binds only when
   * the review ledger records that proposal at the branch's exact head.
   */
  queuedProposals?: readonly string[];
}

const MAX_AWAITING_USER_QUESTIONS = 10;

const MAX_AWAITING_USER_QUESTION_LENGTH = 500;

const awaitingUserQuestions = (
  input: readonly string[] | undefined
): string[] | null => {
  if (!input || input.length === 0) {
    return null;
  }
  const questions = input.map((question) =>
    requiredText(question, "awaiting-user question")
  );
  if (
    questions.length > MAX_AWAITING_USER_QUESTIONS ||
    questions.some(
      (question) => question.length > MAX_AWAITING_USER_QUESTION_LENGTH
    )
  ) {
    throw new SimpleChangesError(
      `Record at most ${MAX_AWAITING_USER_QUESTIONS} awaiting-user questions of at most ${MAX_AWAITING_USER_QUESTION_LENGTH} characters each.`,
      EXIT_CODES.usage
    );
  }
  return questions;
};

const finalizeRun = (
  repositoryPath: string,
  lease: LoopLease,
  inventory: RepositoryInventory,
  reason: string,
  awaitingUser: string[] | null,
  declared: QueuedDeclarations
): LoopFinalizationResult => {
  const untouched = finalizeUnmutatedRun(
    lease,
    inventory,
    reason,
    awaitingUser
  );
  if (untouched) {
    return untouched;
  }
  try {
    return finalizeOwnedLoop(
      repositoryPath,
      lease,
      inventory,
      reason,
      awaitingUser,
      declared
    );
  } catch (error) {
    return relinquishAfterFinalizationError(lease, error, awaitingUser);
  }
};

// Reported in the result only: the finalization receipt is already
// persisted, and a pruning failure never undoes a finished run.
const pruneArchivesAtFinalize = (
  inventory: RepositoryInventory
): NonNullable<LoopFinalizationResult["archivePruning"]> => {
  const retention = archiveRetentionPolicy(inventory.policy.value);
  const notes = retention.fallbacks.map(
    (fallback) => `Archive retention: ${fallback}.`
  );
  try {
    return {
      notes,
      result: pruneWorktreeArchives({
        command: "loop-finalize",
        commonGitDirectory: inventory.repository.commonGitDirectory,
        dryRun: false,
        now: new Date(),
        primaryCheckout: inventory.repository.primaryCheckout,
        retention: {
          days: retention.days,
          maxTotalBytes: retention.maxTotalBytes,
        },
      }),
    };
  } catch (error) {
    if (error instanceof SimpleChangesError) {
      notes.push(`Expired worktree archives were not pruned: ${error.message}`);
      return { notes, result: null };
    }
    throw error;
  }
};

export const finalizeLoop = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  reasonInput: string,
  options: LoopFinalizationOptions = {}
): LoopFinalizationResult => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const reason = requiredText(reasonInput, "finalization reason");
  const awaitingUser = awaitingUserQuestions(options.awaitingUser);
  const declared = queuedDeclarations(
    options.noProposal,
    options.queuedProposals
  );
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop finalize",
    () =>
      withWorktreeCoordinationLock(
        opening.repository.commonGitDirectory,
        "loop finalize cleanup",
        () => {
          const inventory = captureInventory(repositoryPath);
          const lease = requireLease(inventory);
          assertMatchingRun(lease, runId);
          if (lease.ownerAgentId !== ownerAgentId) {
            throw new SimpleChangesError(
              `Only loop owner ${lease.ownerAgentId} may finalize this loop.`,
              EXIT_CODES.unsafe
            );
          }
          assertControllerActive(lease);
          const result = finalizeRun(
            repositoryPath,
            lease,
            inventory,
            reason,
            awaitingUser,
            declared
          );
          if (result.outcome !== "relinquished") {
            options.onClosed?.();
          }
          if (result.outcome === "relinquished") {
            return result;
          }
          // A closed run is a natural cleanup point; a relinquished one is
          // not over, so its archives and pins wait. Pins kept for branches
          // deleted outside earlier runs clean themselves up once their
          // retention passes.
          const expired = pruneExpiredExternalDeletionPins(
            repositoryPath,
            lease.runId
          );
          return {
            ...result,
            archivePruning: pruneArchivesAtFinalize(inventory),
            ...(expired.removed.length > 0 || expired.errors.length > 0
              ? { expiredExternalDeletionPins: expired }
              : {}),
          };
        }
      )
  );
};

export interface LoopEndResult extends LoopVerification {
  closedWithoutMutation?: LoopUnmutatedClose;
}

export const endLoop = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  reasonInput: string | null = null,
  // Runs under the loop locks once the run has ended.
  onClosed?: () => void
): LoopEndResult => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const reason = reasonInput?.trim() || null;
  const opening = locateRepository(repositoryPath);
  // Completion rechecks preserved-source claims, so it holds the coordination
  // lock as finalization does.
  return withStateLock(opening.repository.commonGitDirectory, "loop end", () =>
    withWorktreeCoordinationLock(
      opening.repository.commonGitDirectory,
      "loop end",
      () => {
        const { inventory, lease } = requireOwnedLease(
          repositoryPath,
          runId,
          ownerAgentId,
          "end this loop"
        );
        assertControllerActive(lease);
        const verification = verificationAgainst(lease, inventory);
        // A Ship run that never changed anything owes no shipment scope, remote
        // reconciliation, or cleanup; those gates protect integrated work.
        if (unmutatedCloseReady(lease, inventory, verification)) {
          const closedWithoutMutation = closeUnmutatedRun(
            lease,
            verification,
            reason,
            "loop end"
          );
          onClosed?.();
          return { ...verification, closedWithoutMutation };
        }
        const blockers = loopCompletionBlockers(lease, inventory, verification);
        if (blockers.length > 0) {
          throw new SimpleChangesError(blockers.join(" "), EXIT_CODES.unsafe);
        }
        rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
        onClosed?.();
        return verification;
      }
    )
  );
};

export {
  automaticFinalizationCleanup,
  emptyFinalizationCleanup,
  loopCompletionBlockers,
  reconcilePrimarySynchronization,
  recordedOutcomeIntact,
};
