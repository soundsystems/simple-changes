import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type ContainedBranchPreservation,
  type ContainedBranchRemoval,
  deleteTargetContainedBranches,
  localBranchForTargetRef,
  type TargetContainmentMethod,
  targetContainmentAudit,
} from "./cleanup-core.ts";
import { probeCoordinationAdapter } from "./coordination-adapter.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { captureInventory } from "./inventory.ts";
import {
  type LeaseLiveness,
  leaseLiveness,
  readLoopLease,
} from "./loop-lease.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";
import type {
  RepositoryInventory,
  WorktreeCoordinationState,
  WorktreeInventory,
} from "./types.ts";
import {
  readCoordinationDocumentFromCommonDirectory,
  releaseAbsentWorktreeClaimsUnderLock,
  withWorktreeCoordinationLock,
} from "./worktree-coordination.ts";

const CLEANUP_LIVE_CLAIM_STATES = new Set<WorktreeCoordinationState>([
  "active",
  "paused",
  "adopted-preserved",
  "detached",
  "attached",
  "resume-ready",
]);

const cleanupsPath = (commonGitDirectory: string): string =>
  resolve(
    commonGitDirectory,
    "simple-changes",
    "worktree-coordination",
    "cleanups.json"
  );

export interface WorktreeCleanupRemoval {
  branch: string | null;
  branchDeleted: boolean;
  changeDigest: string;
  containment: TargetContainmentMethod;
  headSha: string;
  path: string;
}

export interface WorktreeCleanupPreserved {
  nextCommand: string | null;
  path: string;
  reason: string;
}

export interface WorktreeCleanupReleasedClaim {
  claimId: string;
  path: string;
  releaseReason: "worktree-absent";
}

export interface WorktreeCleanupReceipt {
  agentId: string;
  approvedBy: string;
  cleanupId: string;
  errors: string[];
  phase?: "intent" | "completed";
  plannedPrunePaths?: string[];
  plannedRemovals?: Omit<WorktreeCleanupRemoval, "branchDeleted">[];
  preserved: WorktreeCleanupPreserved[];
  prunedPaths: string[];
  reason: string;
  recordedAt: string;
  releasedClaims?: WorktreeCleanupReleasedClaim[];
  removed: WorktreeCleanupRemoval[];
  schemaVersion: 1 | 2;
  targetRef: string;
  targetRevision: string;
}

export interface WorktreeCleanupOptions {
  agentId: string;
  approvedBy: string;
  reason: string;
  repositoryPath: string;
  targetRef?: string | undefined;
}

const requiredText = (value: string, name: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SimpleChangesError(`${name} is required.`, EXIT_CODES.usage);
  }
  return trimmed;
};

const resolveCleanupTarget = (
  inventory: RepositoryInventory,
  requestedTargetRef: string | undefined
): { targetRef: string; targetRevision: string } => {
  const targetRef = (requestedTargetRef ?? inventory.targetRef).trim();
  if (!targetRef || targetRef.startsWith("-")) {
    throw new SimpleChangesError(
      "Standalone cleanup requires a plain target reference.",
      EXIT_CODES.usage
    );
  }
  const targetResult = runGit(
    inventory.repository.primaryCheckout,
    ["rev-parse", "--verify", `${targetRef}^{commit}`],
    true
  );
  const targetRevision = targetResult.stdout.trim();
  if (targetResult.exitCode !== 0 || !targetRevision) {
    throw new SimpleChangesError(
      `Cannot resolve cleanup target ${targetRef}.`,
      EXIT_CODES.unsafe
    );
  }
  return { targetRef, targetRevision };
};

export const readWorktreeCleanups = (
  commonGitDirectory: string
): WorktreeCleanupReceipt[] => {
  const path = cleanupsPath(commonGitDirectory);
  if (!existsSync(path)) {
    return [];
  }
  const records = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(records)) {
    throw new SimpleChangesError(
      "Worktree cleanup history is not an append-only record list.",
      EXIT_CODES.unsafe
    );
  }
  return records.map((record) =>
    validateSchema<WorktreeCleanupReceipt>("worktree-cleanup", record)
  );
};

const appendWorktreeCleanup = (
  commonGitDirectory: string,
  receipt: WorktreeCleanupReceipt
): void => {
  const path = cleanupsPath(commonGitDirectory);
  const history = readWorktreeCleanups(commonGitDirectory);
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify([...history, receipt], null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  renameSync(temporaryPath, path);
};

const assertNoLoopLease = (repositoryPath: string): void => {
  const lease = readLoopLease(repositoryPath);
  if (lease) {
    throw new SimpleChangesError(
      `A Simple Changes loop record exists for ${lease.runId}; standalone cleanup is refused while any loop record exists, because cleanup then belongs to that loop's audited lifecycle. Next: run \`simple-changes loop status --json\` and follow its guidance (finalize, close-equivalent, takeover, or \`loop recover --stale-lease\` when it reports a stale lease), or run \`simple-changes prune --approved-by <user> --reason <why>\` to clean only what that loop does not register.`,
      EXIT_CODES.unsafe
    );
  }
};

const containmentFor = (
  primaryCheckout: string,
  targetRevision: string,
  headSha: string,
  targetPatchIdCache: Map<string, Map<string, string>>
): TargetContainmentMethod | null =>
  targetContainmentAudit(
    primaryCheckout,
    targetRevision,
    headSha,
    targetPatchIdCache
  ).method;

const liveClaimPaths = (commonGitDirectory: string): Set<string> => {
  const document =
    readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
  return new Set(
    document.claims
      .filter((claim) => CLEANUP_LIVE_CLAIM_STATES.has(claim.state))
      .map((claim) => claim.path)
  );
};

interface CleanupClassification {
  preserved: WorktreeCleanupPreserved[];
  prunable: WorktreeInventory[];
  removable: Array<{
    containment: TargetContainmentMethod;
    worktree: WorktreeInventory & { headSha: string };
  }>;
}

const classifyCleanupCandidates = (
  inventory: RepositoryInventory,
  targetRevision: string,
  targetRef: string,
  protectedPaths: ReadonlyMap<string, string> = new Map()
): CleanupClassification => {
  const classification: CleanupClassification = {
    preserved: [],
    prunable: [],
    removable: [],
  };
  const claimed = liveClaimPaths(inventory.repository.commonGitDirectory);
  const targetBranch = localBranchForTargetRef(
    inventory.repository.primaryCheckout,
    targetRef
  );
  const targetPatchIdCache = new Map<string, Map<string, string>>();
  for (const worktree of inventory.worktrees) {
    if (worktree.isPrimary) {
      continue;
    }
    const protection = protectedPaths.get(worktree.path);
    if (protection) {
      classification.preserved.push({
        nextCommand: "simple-changes loop status --json",
        path: worktree.path,
        reason: protection,
      });
      continue;
    }
    if (worktree.prunable) {
      classification.prunable.push(worktree);
      continue;
    }
    if (worktree.branch && worktree.branch === targetBranch) {
      classification.preserved.push({
        nextCommand: null,
        path: worktree.path,
        reason: `The checkout is attached to cleanup target branch ${targetBranch}; target checkouts are preserved.`,
      });
      continue;
    }
    if (claimed.has(worktree.path)) {
      classification.preserved.push({
        nextCommand:
          "simple-changes worktree takeover --claim-id <id> --agent-id <you> --status-digest <digest> --approved-by <user> --reason <why> --release",
        path: worktree.path,
        reason:
          "A live worktree claim protects this checkout; only its owner or an approved takeover may release it.",
      });
      continue;
    }
    if (worktree.changes.length > 0) {
      classification.preserved.push({
        nextCommand: `simple-changes worktree equivalence --worktree ${worktree.path} --json`,
        path: worktree.path,
        reason:
          "The worktree has uncommitted changes; standalone cleanup never deletes unproven work.",
      });
      continue;
    }
    if (!worktree.headSha) {
      classification.preserved.push({
        nextCommand: null,
        path: worktree.path,
        reason: "The worktree HEAD could not be resolved.",
      });
      continue;
    }
    const containment = containmentFor(
      inventory.repository.primaryCheckout,
      targetRevision,
      worktree.headSha,
      targetPatchIdCache
    );
    if (!containment) {
      classification.preserved.push({
        nextCommand: `simple-changes worktree equivalence --worktree ${worktree.path} --json`,
        path: worktree.path,
        reason:
          "HEAD has commits that are neither contained in nor patch-equivalent to the refreshed target.",
      });
      continue;
    }
    classification.removable.push({
      containment,
      worktree: worktree as WorktreeInventory & { headSha: string },
    });
  }
  return classification;
};

const branchTipSha = (
  primaryCheckout: string,
  branch: string
): string | null => {
  const result = runGit(
    primaryCheckout,
    ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
    true
  );
  const sha = result.stdout.trim();
  return result.exitCode === 0 && sha ? sha : null;
};

const deleteContainedBranch = (
  primaryCheckout: string,
  branch: string | null,
  headSha: string,
  targetRef: string,
  errors: string[]
): boolean => {
  const targetBranch = localBranchForTargetRef(primaryCheckout, targetRef);
  if (!branch || branch === targetRef || branch === targetBranch) {
    return false;
  }
  if (branchTipSha(primaryCheckout, branch) !== headSha) {
    return false;
  }
  const removal = runGit(primaryCheckout, ["branch", "-D", branch], true);
  if (removal.exitCode !== 0) {
    errors.push(
      `Could not delete target-contained branch ${branch}: ${removal.stderr.trim() || removal.stdout.trim()}`
    );
    return false;
  }
  return true;
};

const removeProvenWorktrees = (
  repositoryPath: string,
  targetRef: string,
  removable: CleanupClassification["removable"],
  errors: string[]
): WorktreeCleanupRemoval[] => {
  const removed: WorktreeCleanupRemoval[] = [];
  for (const candidate of removable) {
    const fresh = captureInventory(repositoryPath).worktrees.find(
      (worktree) =>
        worktree.path === candidate.worktree.path &&
        worktree.headSha === candidate.worktree.headSha &&
        worktree.changeDigest === candidate.worktree.changeDigest &&
        worktree.changes.length === 0
    );
    if (!fresh) {
      errors.push(
        `Cleanup candidate changed during final audit and was preserved: ${candidate.worktree.path}`
      );
      continue;
    }
    const removal = runGit(
      repositoryPath,
      ["worktree", "remove", candidate.worktree.path],
      true
    );
    if (removal.exitCode !== 0) {
      errors.push(
        `Could not remove proven cleanup worktree ${candidate.worktree.path}: ${removal.stderr.trim() || removal.stdout.trim()}`
      );
      continue;
    }
    const {
      repository: { primaryCheckout },
    } = captureInventory(repositoryPath);
    const branchDeleted = deleteContainedBranch(
      primaryCheckout,
      candidate.worktree.branch,
      candidate.worktree.headSha,
      targetRef,
      errors
    );
    removed.push({
      branch: candidate.worktree.branch,
      branchDeleted,
      changeDigest: candidate.worktree.changeDigest,
      containment: candidate.containment,
      headSha: candidate.worktree.headSha,
      path: candidate.worktree.path,
    });
  }
  return removed;
};

const pruneStaleWorktreeMetadata = (
  repositoryPath: string,
  prunable: WorktreeInventory[],
  errors: string[]
): string[] => {
  if (prunable.length === 0) {
    return [];
  }
  const plannedPaths = prunable
    .map((worktree) => worktree.path)
    .sort((left, right) => left.localeCompare(right));
  const freshPaths = captureInventory(repositoryPath)
    .worktrees.filter((worktree) => worktree.prunable)
    .map((worktree) => worktree.path)
    .sort((left, right) => left.localeCompare(right));
  if (
    plannedPaths.length !== freshPaths.length ||
    plannedPaths.some((path, index) => path !== freshPaths[index])
  ) {
    errors.push(
      "Prunable worktree metadata changed after cleanup intent was recorded; no metadata was pruned. Re-run cleanup to record a fresh exact plan."
    );
    return [];
  }
  const result = runGit(
    repositoryPath,
    ["worktree", "prune", "--expire", "now"],
    true
  );
  if (result.exitCode !== 0) {
    errors.push(
      `Could not prune stale worktree metadata: ${result.stderr.trim() || result.stdout.trim()}`
    );
    return [];
  }
  const remaining = new Set(
    captureInventory(repositoryPath).worktrees.map((worktree) => worktree.path)
  );
  const pruned: string[] = [];
  for (const worktree of prunable) {
    if (remaining.has(worktree.path)) {
      errors.push(
        `Stale worktree metadata remained after pruning: ${worktree.path}`
      );
      continue;
    }
    pruned.push(worktree.path);
  }
  return pruned.sort((left, right) => left.localeCompare(right));
};

/**
 * Audited standalone cleanup for repositories with no loop record at all.
 * Removes only worktrees that are proven safe right now: unclaimed, clean,
 * and fully contained in the refreshed target by exact ancestry or complete
 * per-commit patch equivalence, plus stale metadata whose directory no longer
 * exists. Everything else is preserved and named with the exact next command.
 * The whole pass is recorded as an append-only receipt.
 */
export const standaloneWorktreeCleanup = (
  options: WorktreeCleanupOptions
): WorktreeCleanupReceipt => {
  const agentId = requiredText(options.agentId, "agent ID");
  const approvedBy = requiredText(options.approvedBy, "approver");
  const reason = requiredText(options.reason, "cleanup reason");
  assertNoLoopLease(options.repositoryPath);
  const opening = captureInventory(options.repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withWorktreeCoordinationLock(
    commonGitDirectory,
    "standalone worktree cleanup",
    () => {
      assertNoLoopLease(options.repositoryPath);
      const inventory = captureInventory(options.repositoryPath);
      const { targetRef, targetRevision } = resolveCleanupTarget(
        inventory,
        options.targetRef
      );
      const errors: string[] = [];
      const classification = classifyCleanupCandidates(
        inventory,
        targetRevision,
        targetRef
      );
      const cleanupId = `cleanup-${randomUUID()}`;
      const plannedRemovals = classification.removable
        .map((candidate) => ({
          branch: candidate.worktree.branch,
          changeDigest: candidate.worktree.changeDigest,
          containment: candidate.containment,
          headSha: candidate.worktree.headSha,
          path: candidate.worktree.path,
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      const plannedPrunePaths = classification.prunable
        .map((worktree) => worktree.path)
        .sort((left, right) => left.localeCompare(right));
      const preserved = classification.preserved.sort((left, right) =>
        left.path.localeCompare(right.path)
      );
      const intent = validateSchema<WorktreeCleanupReceipt>(
        "worktree-cleanup",
        {
          agentId,
          approvedBy,
          cleanupId,
          errors: [],
          phase: "intent",
          plannedPrunePaths,
          plannedRemovals,
          preserved,
          prunedPaths: [],
          reason,
          recordedAt: new Date().toISOString(),
          removed: [],
          schemaVersion: 2,
          targetRef,
          targetRevision,
        } satisfies WorktreeCleanupReceipt
      );
      appendWorktreeCleanup(commonGitDirectory, intent);
      const removed = removeProvenWorktrees(
        options.repositoryPath,
        targetRef,
        classification.removable,
        errors
      );
      const prunedPaths = pruneStaleWorktreeMetadata(
        options.repositoryPath,
        classification.prunable,
        errors
      );
      // A claim whose checkout is gone (removed above, pruned above, or already
      // absent) protects nothing; release it so it stops demanding a takeover.
      const releasedClaims = releaseAbsentWorktreeClaimsUnderLock(
        commonGitDirectory,
        captureInventory(options.repositoryPath),
        agentId
      )
        .map((claim) => ({
          claimId: claim.claimId,
          path: claim.path,
          releaseReason: "worktree-absent" as const,
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      const receipt = validateSchema<WorktreeCleanupReceipt>(
        "worktree-cleanup",
        {
          agentId,
          approvedBy,
          cleanupId,
          errors,
          phase: "completed",
          plannedPrunePaths,
          plannedRemovals,
          preserved,
          prunedPaths,
          reason,
          recordedAt: new Date().toISOString(),
          releasedClaims,
          removed: removed.sort((left, right) =>
            left.path.localeCompare(right.path)
          ),
          schemaVersion: 2,
          targetRef,
          targetRevision,
        } satisfies WorktreeCleanupReceipt
      );
      appendWorktreeCleanup(commonGitDirectory, receipt);
      return receipt;
    }
  );
};

export interface PruneOptions {
  approvedBy?: string | undefined;
  dryRun: boolean;
  reason?: string | undefined;
  repositoryPath: string;
  targetRef?: string | undefined;
}

export interface PruneLeaseProtection {
  liveness: LeaseLiveness;
  ownerAgentId: string;
  protectedBranches: string[];
  protectedPaths: string[];
  runId: string;
  scope: "everything-registered" | "preserved-and-retained";
}

export interface PrunePlannedRemoval {
  branch: string | null;
  containment: TargetContainmentMethod;
  headSha: string;
  path: string;
}

export interface PruneReport {
  approvedBy: string | null;
  dryRun: boolean;
  errors: string[];
  lease: PruneLeaseProtection | null;
  notes: string[];
  plannedBranchRemovals: ContainedBranchRemoval[];
  plannedPrunePaths: string[];
  plannedRemovals: PrunePlannedRemoval[];
  preserved: WorktreeCleanupPreserved[];
  preservedBranches: ContainedBranchPreservation[];
  prunedPaths: string[];
  reason: string | null;
  removed: WorktreeCleanupRemoval[];
  removedBranches: ContainedBranchRemoval[];
  targetRef: string;
  targetRevision: string;
}

const leaseProtectionFor = (
  repositoryPath: string
): {
  branches: Set<string>;
  paths: Map<string, string>;
  protection: PruneLeaseProtection | null;
} => {
  const lease = readLoopLease(repositoryPath);
  if (!lease) {
    return { branches: new Set(), paths: new Map(), protection: null };
  }
  const liveness = leaseLiveness(lease);
  const registeredScope = liveness.state !== "stale";
  const branches = new Set<string>();
  const paths = new Map<string, string>();
  for (const worktree of lease.worktrees) {
    const durableRole =
      worktree.role === "preserved" || worktree.role === "retained";
    if (!(registeredScope || durableRole)) {
      continue;
    }
    paths.set(
      worktree.path,
      registeredScope
        ? `Loop ${lease.runId} is ${liveness.state} and registers this checkout; prune never touches what a lease that may still be working registers.`
        : `Loop ${lease.runId} registers this checkout as ${worktree.role}; prune never removes preserved or retained work.`
    );
    if (worktree.branch) {
      branches.add(worktree.branch);
    }
  }
  if (registeredScope) {
    for (const preparation of lease.preparations) {
      branches.add(preparation.branch);
      paths.set(
        preparation.path,
        `Loop ${lease.runId} is ${liveness.state} and prepared this checkout; prune never touches what a lease that may still be working registers.`
      );
    }
  }
  return {
    branches,
    paths,
    protection: {
      liveness,
      ownerAgentId: lease.ownerAgentId,
      protectedBranches: [...branches].sort((left, right) =>
        left.localeCompare(right)
      ),
      protectedPaths: [...paths.keys()].sort((left, right) =>
        left.localeCompare(right)
      ),
      runId: lease.runId,
      scope: registeredScope
        ? "everything-registered"
        : "preserved-and-retained",
    },
  };
};

const prunableBranchCandidates = (
  inventory: RepositoryInventory,
  targetRef: string,
  protectedBranches: ReadonlySet<string>
): {
  candidates: Array<{ name: string; sha: string }>;
  protectedByLease: ContainedBranchPreservation[];
} => {
  const targetBranch = localBranchForTargetRef(
    inventory.repository.primaryCheckout,
    targetRef
  );
  const candidates: Array<{ name: string; sha: string }> = [];
  const protectedByLease: ContainedBranchPreservation[] = [];
  for (const branch of inventory.branches) {
    if (branch.name === targetBranch || branch.name === targetRef) {
      continue;
    }
    if (branch.worktreePath !== null) {
      continue;
    }
    if (protectedBranches.has(branch.name)) {
      protectedByLease.push({
        branch: branch.name,
        reason:
          "An active loop lease registers this branch; prune leaves the lease manifest alone.",
      });
      continue;
    }
    candidates.push({ name: branch.name, sha: branch.sha });
  }
  return { candidates, protectedByLease };
};

const sortedByPath = <T extends { path: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => left.path.localeCompare(right.path));

const sortedByBranch = <T extends { branch: string }>(items: T[]): T[] =>
  [...items].sort((left, right) => left.branch.localeCompare(right.branch));

/**
 * Prune proven-obsolete local state without a lease of its own.
 *
 * This runs the same proven-safe audit finalization runs, so an agent that
 * merged its work and stopped without finalizing can still clean up: unchanged
 * clean checkouts the refreshed target already contains, stale worktree
 * metadata whose directory is gone, and local branches whose unique commits
 * the target contains by ancestry or complete per-commit patch equivalence.
 *
 * Nothing else is touched. The primary checkout, the target branch, any dirty
 * or claimed checkout, anything a lease registers as preserved or retained,
 * and everything registered by a lease that is not provably stale are all
 * preserved and named with the reason. Lease state, claims, and durable
 * receipts are never modified.
 */
export const pruneRepository = (options: PruneOptions): PruneReport => {
  if (!options.dryRun) {
    requiredText(options.approvedBy ?? "", "approver");
    requiredText(options.reason ?? "", "prune reason");
  }
  const approvedBy = options.approvedBy?.trim() || null;
  const reason = options.reason?.trim() || null;
  const opening = captureInventory(options.repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withWorktreeCoordinationLock(commonGitDirectory, "prune", () => {
    const inventory = captureInventory(options.repositoryPath);
    const { targetRef, targetRevision } = resolveCleanupTarget(
      inventory,
      options.targetRef
    );
    const lease = leaseProtectionFor(options.repositoryPath);
    const errors: string[] = [];
    const notes: string[] = [];
    if (lease.protection) {
      notes.push(
        lease.protection.scope === "everything-registered"
          ? `Loop ${lease.protection.runId} is ${lease.protection.liveness.state}; prune refused to touch anything it registers and pruned only unrelated state.`
          : `Loop ${lease.protection.runId} is stale, so prune audited its unregistered state; its preserved and retained checkouts were still left alone. Clear the lease itself with \`simple-changes loop recover --stale-lease\`.`
      );
    }
    notes.push(
      "Prune never edits lease state, worktree claims, or recorded receipts."
    );
    const classification = classifyCleanupCandidates(
      inventory,
      targetRevision,
      targetRef,
      lease.paths
    );
    const branchPlan = prunableBranchCandidates(
      inventory,
      targetRef,
      lease.branches
    );
    const plannedBranches = deleteTargetContainedBranches({
      branches: branchPlan.candidates,
      dryRun: true,
      repositoryPath: inventory.repository.primaryCheckout,
      targetRevision,
    });
    const plannedRemovals = sortedByPath(
      classification.removable.map((candidate) => ({
        branch: candidate.worktree.branch,
        containment: candidate.containment,
        headSha: candidate.worktree.headSha,
        path: candidate.worktree.path,
      }))
    );
    const plannedPrunePaths = classification.prunable
      .map((worktree) => worktree.path)
      .sort((left, right) => left.localeCompare(right));
    const plannedBranchRemovals = sortedByBranch(plannedBranches.removed);
    const report: PruneReport = {
      approvedBy,
      dryRun: options.dryRun,
      errors,
      lease: lease.protection,
      notes,
      plannedBranchRemovals,
      plannedPrunePaths,
      plannedRemovals,
      preserved: sortedByPath(classification.preserved),
      preservedBranches: sortedByBranch([
        ...branchPlan.protectedByLease,
        ...plannedBranches.preserved,
      ]),
      prunedPaths: [],
      reason,
      removed: [],
      removedBranches: [],
      targetRef,
      targetRevision,
    };
    if (options.dryRun) {
      return report;
    }
    report.removed = sortedByPath(
      removeProvenWorktrees(
        options.repositoryPath,
        targetRef,
        classification.removable,
        errors
      )
    );
    report.prunedPaths = pruneStaleWorktreeMetadata(
      options.repositoryPath,
      classification.prunable,
      errors
    );
    const refreshed = captureInventory(options.repositoryPath);
    const finalBranches = prunableBranchCandidates(
      refreshed,
      targetRef,
      lease.branches
    );
    const deletion = deleteTargetContainedBranches({
      branches: finalBranches.candidates,
      repositoryPath: refreshed.repository.primaryCheckout,
      targetRevision,
    });
    errors.push(...deletion.errors);
    report.removedBranches = sortedByBranch(deletion.removed);
    report.preservedBranches = sortedByBranch([
      ...finalBranches.protectedByLease,
      ...deletion.preserved,
    ]);
    return report;
  });
};

export interface WorktreeIndexAdapterNote {
  adapter: string;
  note: string;
  worktreeIdentity: string;
}

export interface WorktreeIndexRefreshResult {
  adapterNotes: WorktreeIndexAdapterNote[];
  notes: string[];
  prunedPaths: string[];
  remainingWorktreePaths: string[];
}

/**
 * Refresh the authoritative Git worktree inventory so editor and desktop
 * surfaces that cache their own worktree view can re-sync. Prunes only
 * metadata for worktree directories that no longer exist; working files,
 * branches, claims, and session or task history are never touched.
 */
export const refreshWorktreeIndex = (
  repositoryPath: string
): WorktreeIndexRefreshResult => {
  const opening = captureInventory(repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withWorktreeCoordinationLock(
    commonGitDirectory,
    "worktree index refresh",
    () => {
      const before = captureInventory(repositoryPath);
      const stale = before.worktrees
        .filter((worktree) => worktree.prunable)
        .map((worktree) => worktree.path);
      const result = runGit(
        before.repository.primaryCheckout,
        ["worktree", "prune", "--expire", "now"],
        true
      );
      if (result.exitCode !== 0) {
        throw new SimpleChangesError(
          `Could not prune stale worktree metadata: ${result.stderr.trim() || result.stdout.trim()}`,
          EXIT_CODES.inventory
        );
      }
      const remainingWorktreePaths = captureInventory(repositoryPath)
        .worktrees.map((worktree) => worktree.path)
        .sort((left, right) => left.localeCompare(right));
      const remaining = new Set(remainingWorktreePaths);
      const document =
        readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
      const adapters = [
        ...new Set(
          document.claims
            .filter((claim) => CLEANUP_LIVE_CLAIM_STATES.has(claim.state))
            .map((claim) => claim.owner.adapter)
        ),
      ].sort((left, right) => left.localeCompare(right));
      const adapterNotes = adapters.map((adapter) => {
        const { capabilities } = probeCoordinationAdapter(adapter, null);
        return {
          adapter,
          note:
            capabilities.worktreeIdentity === "native"
              ? "This surface derives worktree identity natively; its live inventory re-reads the pruned Git state on its next sync. Session and task history are audit records and are not touched."
              : "This adapter tracks worktrees by claim only; there is no cached surface index to refresh.",
          worktreeIdentity: capabilities.worktreeIdentity,
        };
      });
      return {
        adapterNotes,
        notes: [
          "Pruning removed metadata only for worktree directories that no longer exist; no working files, branches, or claims were touched.",
        ],
        prunedPaths: stale
          .filter((path) => !remaining.has(path))
          .sort((left, right) => left.localeCompare(right)),
        remainingWorktreePaths,
      };
    }
  );
};
