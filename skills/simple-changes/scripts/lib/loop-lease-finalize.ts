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
import { captureInventory, locateRepository } from "./inventory.ts";
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
import { assertCurrentRemoteBranchReconciliation } from "./loop-lease-remote.ts";
import {
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
import { recordedPreservedSourceOverrides } from "./preserved-source-override.ts";
import { primaryDeliveryProof } from "./primary-delivery-proof.ts";
import { runGit } from "./process.ts";
import {
  type ReviewAttemptsReport,
  reviewAttemptsForFinalization,
} from "./review-ledger.ts";
import type {
  LoopLease,
  LoopVerification,
  LoopViolation,
  LoopWorktreeDisposition,
  LoopWorktreeLease,
  PreservedSourceOverrideReceipt,
  RepositoryInventory,
  WorktreeClaim,
  WorktreeInventory,
} from "./types.ts";
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
  primaryUpdated: boolean;
  prunedWorktreeMetadata: number;
  releasedClaims: FinalizationReleasedClaim[];
  removedBranches: FinalizationRemovedBranch[];
  removedWorktrees: string[];
}

const emptyFinalizationCleanup = (): FinalizationCleanupResult => ({
  cleanedPrimaryPaths: [],
  errors: [],
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
  cleanup: FinalizationCleanupResult
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
    if (registered.role !== "concurrent-author" || !registered.claimId) {
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
    if (handoffContainment) {
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
    if (claim.state !== "active") {
      continue;
    }
    let releaseReason: FinalizationReleasedClaim["releaseReason"] | null = null;
    if (worktree.prunable) {
      releaseReason = "worktree-absent";
    } else if (
      claim.owner.agentId === lease.ownerAgentId &&
      claim.headSha === worktree.headSha &&
      claim.changeDigest === worktree.changeDigest &&
      worktree.changes.length === 0 &&
      worktree.headSha &&
      targetContainsRevision(repositoryPath, targetRevision, worktree.headSha)
    ) {
      releaseReason = "shipped";
    }
    if (!releaseReason) {
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
  return inventory.worktrees.filter((worktree) => {
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
        ? { ...disposition, completedAt, status: "completed" }
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
        branch: worktree.branch,
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
  cleanup: FinalizationCleanupResult
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
  const deletion = deleteTargetContainedBranches({
    branches: inventory.branches.filter(
      (branch) =>
        branch.name !== targetBranch &&
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

const diffMatchesRevision = (
  repositoryPath: string,
  revision: string,
  paths: string[],
  cached = false
): boolean =>
  runGit(
    repositoryPath,
    [
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

const indexHasOnlyOrdinaryEntries = (
  repositoryPath: string,
  paths: string[]
): boolean =>
  paths.every((path) => {
    const result = runGit(
      repositoryPath,
      ["ls-files", "--debug", "--", path],
      true
    );
    if (result.exitCode !== 0) {
      return false;
    }
    const flags = [...result.stdout.matchAll(/^\s+flags:\s+(\d+)\s*$/gmu)];
    return flags.every((match) => match[1] === "0");
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
  const scopedPrimaryPaths = new Set(
    (lease.shipmentScope?.plan.units ?? [])
      .filter((unit) => unit.sourceWorktree === primary.path)
      .flatMap((unit) => unit.paths)
  );
  return (
    primary.changes.some(
      (change) =>
        scopedPrimaryPaths.has(change.path) && !eligiblePaths.has(change.path)
    ) && preservesUnchangedPrimary(lease, inventory)
  );
};

const reconcileTargetEquivalentPrimaryChanges = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): void => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (!(primary?.headSha && primary.changes.length > 0)) {
    return;
  }
  const eligiblePaths = new Set<string>();
  for (const change of primary.changes) {
    if (change.conflicted || change.untracked) {
      continue;
    }
    const paths = [change.originalPath, change.path].filter(
      (path): path is string => Boolean(path)
    );
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
  if (eligiblePaths.size === 0) {
    return;
  }
  if (preservesProvenMixedPrimary(lease, inventory, primary, eligiblePaths)) {
    return;
  }
  const freshPrimary = captureInventory(lease.primaryCheckout).worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (freshPrimary?.changeDigest !== primary.changeDigest) {
    cleanup.errors.push(
      "The primary checkout changed while target-equivalent paths were being audited; no primary path was cleaned."
    );
    return;
  }
  const paths = [...eligiblePaths].sort();
  const restored = runGit(
    lease.primaryCheckout,
    [
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
    return;
  }
  cleanup.cleanedPrimaryPaths.push(...paths);
  cleanup.primaryUpdated = true;
};

const fastForwardCleanPrimary = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): void => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  const localTarget = inventory.branches.find(
    (branch) => branch.name === targetBranch
  );
  const canFastForward = Boolean(
    primary?.branch === targetBranch &&
      primary.changes.length === 0 &&
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
    ["merge", "--ff-only", targetRevision],
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
  if (!targetBranch) {
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
  if (
    !(primary && registered?.mutationAllowed) ||
    registered.branch === primary.branch
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
  const repositoryPath = inventoryInput.repository.primaryCheckout;
  lease = completeAbsentRemovalIntents(lease, inventoryInput, targetRevision);
  lease = reconcileConcurrentAuthorClaims(
    lease,
    inventoryInput,
    repositoryPath,
    targetRevision,
    cleanup
  );
  const candidates = automaticCleanupCandidates(
    lease,
    inventoryInput,
    targetRevision
  );
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
  removeTargetContainedBranches(
    lease,
    repositoryPath,
    targetBranch,
    targetRevision,
    cleanup
  );
  let inventory = captureInventory(repositoryPath);
  if (
    preparePrimarySynchronization(
      lease,
      inventory,
      targetBranch,
      targetRevision
    )
  ) {
    reconcileTargetEquivalentPrimaryChanges(
      lease,
      inventory,
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
      cleanup
    );
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
    cleanup
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
    lease.ownerAgentId
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
 * The overrides recorded beside the lease for its exact shipment outcome.
 * Throws when the stored receipt and its sidecar no longer recompose into the
 * complete receipt the recorded digest names.
 */
const storedPreservedSourceOverrides = (
  lease: LoopLease
): PreservedSourceOverrideReceipt[] => {
  const outcome = lease.shipmentOutcome;
  if (!outcome) {
    return [];
  }
  return recordedPreservedSourceOverrides(
    readReceiptSidecar(
      lease.commonGitDirectory,
      PRESERVED_SOURCE_OVERRIDE_DIRECTORY,
      lease.runId
    ),
    lease.runId,
    outcome.receipt,
    outcome.receiptDigest
  );
};

const recordedOutcomeIntact = (lease: LoopLease): boolean => {
  try {
    storedPreservedSourceOverrides(lease);
    return true;
  } catch {
    return false;
  }
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
  let overrides: PreservedSourceOverrideReceipt[];
  try {
    overrides = storedPreservedSourceOverrides(lease);
  } catch (error) {
    return [
      ...targetBlockers,
      error instanceof Error ? error.message : String(error),
    ];
  }
  // A preserved-source override holds only while its source, claim, and
  // target entries stay exactly as approved.
  const sourceBlockers = lease.shipmentScope.plan.units.flatMap((expected) => {
    const unit = receipt.units.find((item) => item.unitId === expected.id);
    const override = overrides.find((item) => item.unitId === expected.id);
    if (!(unit && override)) {
      return [];
    }
    const issue = preservedSourceOverrideIssue(
      lease,
      inventory,
      receipt,
      unit,
      override,
      expected,
      lease.shipmentOutcome?.recordedAt ?? ""
    );
    return issue
      ? [
          `Manually approved preserved source ${expected.sourceWorktree} changed after recording: ${issue}`,
        ]
      : [];
  });
  return [...targetBlockers, ...sourceBlockers];
};

const repositoryCleanupBlockers = (
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
  const mergedCleanupWorktrees = inventory.worktrees
    .filter((worktree) => {
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
  const mergedCleanupBranchNames = inventory.branches
    .filter(
      (branch) =>
        branch.name !== targetBranch &&
        branch.worktreePath === null &&
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

const loopCompletionBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification,
  cleanupErrors: string[] = [],
  scopedCompletion = false
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
  const liveRunWorktrees = lease.worktrees.filter(
    (worktree) =>
      worktree.createdByRun &&
      inventory.worktrees.some((current) => current.path === worktree.path)
  );
  if (!scopedCompletion && liveRunWorktrees.length > 0) {
    blockers.push(
      `Remove run-created worktrees before ending the loop: ${liveRunWorktrees
        .map((worktree) => worktree.path)
        .join(", ")}`
    );
  }
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
  if (!scopedCompletion) {
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
  blockers: string[];
  cleanup: FinalizationCleanupResult;
  closedWithoutMutation?: LoopUnmutatedClose;
  lease: LoopLease | null;
  outcome: "completed" | "relinquished" | "closed-without-mutation";
  receipt: LoopFinalizationReceipt;
  receiptPath: string;
  verification: LoopVerification;
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
  kind: "loop-finalization";
  leaseDigest: string;
  preservedWorktrees: string[];
  reason: string;
  /** Review attempts recorded during the run, per proposal, when a ledger exists. */
  reviewAttempts?: ReviewAttemptsReport;
  runId: string;
  schemaVersion: 1;
  shipmentStatus: "closed" | "open" | "unstarted";
  targetRevision: string | null;
}

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
  return scope.plan.units.every((unit) => {
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
    // A user-approved preserved source stays dirty in its author's claimed
    // checkout; it counts only while its override still holds exactly. The
    // completion blockers above already proved the sidecar readable.
    const override = storedPreservedSourceOverrides(lease).find(
      (item) => item.unitId === unit.id
    );
    const recorded = outcome.units.find((item) => item.unitId === unit.id);
    return Boolean(
      override &&
        recorded &&
        preservedSourceOverrideIssue(
          lease,
          inventory,
          outcome,
          recorded,
          override,
          unit,
          lease.shipmentOutcome?.recordedAt ?? ""
        ) === null
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
  if (!(primary && registered && scope)) {
    return false;
  }
  const units = scope.plan.units.filter(
    (unit) => unit.sourceWorktree === primary.path
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
    excluded: scope.plan.exclusions
      .filter((item) => item.worktreePath === primary.path)
      .map((item) => item.path),
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

const finalizationDecision = (
  lease: LoopLease,
  finalInventory: RepositoryInventory,
  cleanup: FinalizationCleanupResult,
  reason: string,
  awaitingUser: string[] | null = null
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
  const scopedCompletion =
    verifiedDelivery &&
    (!primary?.changes.length ||
      preservesUnchangedPrimary(lease, finalInventory));
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
    scopedCompletion
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
  const cleanupPending =
    loopCompletionBlockers(
      lease,
      finalInventory,
      strictVerification,
      cleanup.errors
    ).length > 0;
  const now = new Date().toISOString();
  const receipt: LoopFinalizationReceipt = {
    ...lifecycle,
    ...(awaitingUser ? { awaitingUser } : {}),
    blockers,
    cleanup,
    cleanupStatus: cleanupPending ? "pending" : "complete",
    deliveryStatus: verifiedDelivery ? "verified" : "unverified",
    finalizedAt: now,
    kind: "loop-finalization",
    leaseDigest: loopManifestDigest(lease),
    preservedWorktrees: finalInventory.worktrees
      .map((worktree) => worktree.path)
      .sort((left, right) => left.localeCompare(right)),
    reason,
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
  const sourcePaths = new Set(
    lease.shipmentScope?.plan.units.map((unit) => unit.sourceWorktree)
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
  awaitingUser: string[] | null
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
  const { blockers, verification, receipt } = finalizationDecision(
    lease,
    finalInventory,
    automaticCleanup.cleanup,
    reason,
    awaitingUser
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
   * Runs under the loop locks when the run closes (completed or closed
   * without mutation), never when it pauses or relinquishes.
   */
  onClosed?: () => void;
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
  awaitingUser: string[] | null
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
      awaitingUser
    );
  } catch (error) {
    return relinquishAfterFinalizationError(lease, error, awaitingUser);
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
            awaitingUser
          );
          if (result.outcome !== "relinquished") {
            options.onClosed?.();
          }
          return result;
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
