import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { probeCoordinationAdapter } from "./coordination-adapter.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { captureInventory } from "./inventory.ts";
import { readLoopLease } from "./loop-lease.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";
import type {
  RepositoryInventory,
  WorktreeCoordinationState,
  WorktreeInventory,
} from "./types.ts";
import {
  readCoordinationDocumentFromCommonDirectory,
  withWorktreeCoordinationLock,
} from "./worktree-coordination.ts";
import { commitEquivalenceAgainstTarget } from "./worktree-equivalence.ts";

const CLEANUP_LIVE_CLAIM_STATES = new Set<WorktreeCoordinationState>([
  "active",
  "pause-requested",
  "paused",
  "adopted-preserved",
  "detach-requested",
  "detached",
  "attached",
  "resume-ready",
  "blocked",
]);

const CLEANUP_PATCH_EQUIVALENCE_MAX_COMMITS = 200;

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
  containment: "target-contained" | "patch-equivalent";
  headSha: string;
  path: string;
}

export interface WorktreeCleanupPreserved {
  nextCommand: string | null;
  path: string;
  reason: string;
}

export interface WorktreeCleanupReceipt {
  agentId: string;
  approvedBy: string;
  cleanupId: string;
  errors: string[];
  preserved: WorktreeCleanupPreserved[];
  prunedPaths: string[];
  reason: string;
  recordedAt: string;
  removed: WorktreeCleanupRemoval[];
  schemaVersion: 1;
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
      `A Simple Changes loop record exists for ${lease.runId}; standalone cleanup is refused while any loop record exists, because cleanup then belongs to that loop's audited lifecycle. Next: run \`simple-changes loop status --json\` and follow its guidance (finalize, close-equivalent, or takeover).`,
      EXIT_CODES.unsafe
    );
  }
};

const containmentFor = (
  primaryCheckout: string,
  targetRevision: string,
  headSha: string,
  targetPatchIdCache: Map<string, Map<string, string>>
): "target-contained" | "patch-equivalent" | null => {
  const ancestry = runGit(
    primaryCheckout,
    [
      "merge-base",
      "--is-ancestor",
      `${headSha}^{commit}`,
      `${targetRevision}^{commit}`,
    ],
    true
  );
  if (ancestry.exitCode === 0) {
    return "target-contained";
  }
  const equivalence = commitEquivalenceAgainstTarget(
    primaryCheckout,
    headSha,
    targetRevision,
    {
      maxCommits: CLEANUP_PATCH_EQUIVALENCE_MAX_COMMITS,
      targetPatchIdCache,
    }
  );
  if (
    !equivalence.exceededMaxCommits &&
    equivalence.mergeBase !== null &&
    equivalence.commitCount > 0 &&
    equivalence.fullyMatched
  ) {
    return "patch-equivalent";
  }
  return null;
};

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
    containment: "target-contained" | "patch-equivalent";
    worktree: WorktreeInventory & { headSha: string };
  }>;
}

const classifyCleanupCandidates = (
  inventory: RepositoryInventory,
  targetRevision: string
): CleanupClassification => {
  const classification: CleanupClassification = {
    preserved: [],
    prunable: [],
    removable: [],
  };
  const claimed = liveClaimPaths(inventory.repository.commonGitDirectory);
  const targetPatchIdCache = new Map<string, Map<string, string>>();
  for (const worktree of inventory.worktrees) {
    if (worktree.isPrimary) {
      continue;
    }
    if (worktree.prunable) {
      classification.prunable.push(worktree);
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
  if (!branch || branch === targetRef) {
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
      const targetRef = (options.targetRef ?? inventory.targetRef).trim();
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
      const errors: string[] = [];
      const classification = classifyCleanupCandidates(
        inventory,
        targetRevision
      );
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
      const receipt = validateSchema<WorktreeCleanupReceipt>(
        "worktree-cleanup",
        {
          agentId,
          approvedBy,
          cleanupId: `cleanup-${randomUUID()}`,
          errors,
          preserved: classification.preserved.sort((left, right) =>
            left.path.localeCompare(right.path)
          ),
          prunedPaths,
          reason,
          recordedAt: new Date().toISOString(),
          removed: removed.sort((left, right) =>
            left.path.localeCompare(right.path)
          ),
          schemaVersion: 1,
          targetRef,
          targetRevision,
        } satisfies WorktreeCleanupReceipt
      );
      appendWorktreeCleanup(commonGitDirectory, receipt);
      return receipt;
    }
  );
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
