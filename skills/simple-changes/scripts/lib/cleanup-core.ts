import { runGit } from "./process.ts";
import { commitEquivalenceAgainstTarget } from "./worktree-equivalence.ts";

export const PATCH_EQUIVALENCE_MAX_COMMITS = 200;

export type TargetContainmentMethod = "target-contained" | "patch-equivalent";

export interface TargetContainmentAudit {
  exceededMaxCommits: boolean;
  method: TargetContainmentMethod | null;
}

export const targetContainsRevision = (
  repositoryPath: string,
  targetRevision: string,
  revision: string | null
): boolean =>
  Boolean(
    revision &&
      runGit(
        repositoryPath,
        [
          "merge-base",
          "--is-ancestor",
          `${revision}^{commit}`,
          `${targetRevision}^{commit}`,
        ],
        true
      ).exitCode === 0
  );

/**
 * The single containment proof every cleanup path shares: a revision counts as
 * contained only when the refreshed target reaches it by exact ancestry, or
 * when every one of its unique commits has a patch-equivalent commit in the
 * target. Anything beyond the commit bound is reported, never assumed.
 */
export const targetContainmentAudit = (
  repositoryPath: string,
  targetRevision: string,
  revision: string | null,
  targetPatchIdCache?: Map<string, Map<string, string>>
): TargetContainmentAudit => {
  if (!revision) {
    return { exceededMaxCommits: false, method: null };
  }
  if (targetContainsRevision(repositoryPath, targetRevision, revision)) {
    return { exceededMaxCommits: false, method: "target-contained" };
  }
  const equivalence = commitEquivalenceAgainstTarget(
    repositoryPath,
    revision,
    targetRevision,
    { maxCommits: PATCH_EQUIVALENCE_MAX_COMMITS, targetPatchIdCache }
  );
  if (equivalence.exceededMaxCommits) {
    return { exceededMaxCommits: true, method: null };
  }
  if (
    equivalence.mergeBase !== null &&
    equivalence.commitCount > 0 &&
    equivalence.fullyMatched
  ) {
    return { exceededMaxCommits: false, method: "patch-equivalent" };
  }
  return { exceededMaxCommits: false, method: null };
};

export const localBranchForTargetRef = (
  primaryCheckout: string,
  targetRef: string
): string | null => {
  if (targetRef.startsWith("refs/heads/")) {
    return targetRef.slice("refs/heads/".length);
  }
  if (targetRef.startsWith("refs/remotes/")) {
    const remoteRef = targetRef.slice("refs/remotes/".length);
    const separator = remoteRef.indexOf("/");
    return separator === -1 ? null : remoteRef.slice(separator + 1);
  }
  const remoteNames = runGit(primaryCheckout, ["remote"], true)
    .stdout.split("\n")
    .map((remoteName) => remoteName.trim())
    .filter(Boolean);
  const matchedRemote = remoteNames.find((name) =>
    targetRef.startsWith(`${name}/`)
  );
  return matchedRemote ? targetRef.slice(matchedRemote.length + 1) : targetRef;
};

export interface ContainedBranchCandidate {
  name: string;
  sha: string;
}

export interface ContainedBranchRemoval {
  branch: string;
  method: TargetContainmentMethod;
  sha: string;
}

export interface ContainedBranchPreservation {
  branch: string;
  reason: string;
}

export interface ContainedBranchDeletionResult {
  errors: string[];
  preserved: ContainedBranchPreservation[];
  removed: ContainedBranchRemoval[];
}

export interface ContainedBranchDeletionOptions {
  branches: readonly ContainedBranchCandidate[];
  dryRun?: boolean;
  repositoryPath: string;
  targetPatchIdCache?: Map<string, Map<string, string>>;
  targetRevision: string;
}

/**
 * Delete already-eligible local branches whose unique commits the refreshed
 * target contains. Callers decide eligibility (never the target, never
 * attached to a worktree, never protected by a live lease); this function only
 * proves containment and performs the exact-old-value ref deletion, so every
 * cleanup path deletes branches on identical evidence.
 */
export const deleteTargetContainedBranches = (
  options: ContainedBranchDeletionOptions
): ContainedBranchDeletionResult => {
  const result: ContainedBranchDeletionResult = {
    errors: [],
    preserved: [],
    removed: [],
  };
  const targetPatchIdCache =
    options.targetPatchIdCache ?? new Map<string, Map<string, string>>();
  for (const branch of options.branches) {
    const containment = targetContainmentAudit(
      options.repositoryPath,
      options.targetRevision,
      branch.sha,
      targetPatchIdCache
    );
    if (containment.exceededMaxCommits) {
      result.errors.push(
        `Skipped the patch-equivalence audit for branch ${branch.name}: it is more than ${PATCH_EQUIVALENCE_MAX_COMMITS} commits ahead of the target. The branch was preserved.`
      );
      result.preserved.push({
        branch: branch.name,
        reason: `The branch is more than ${PATCH_EQUIVALENCE_MAX_COMMITS} commits ahead of the target, so its patch-equivalence audit was skipped.`,
      });
      continue;
    }
    if (!containment.method) {
      result.preserved.push({
        branch: branch.name,
        reason:
          "The branch has commits that are neither contained in nor patch-equivalent to the refreshed target. Run branch audit --head <branch> --target <target> before treating it as unshipped; a replacement may have changed patch IDs during review.",
      });
      continue;
    }
    if (options.dryRun) {
      result.removed.push({
        branch: branch.name,
        method: containment.method,
        sha: branch.sha,
      });
      continue;
    }
    const deleted = runGit(
      options.repositoryPath,
      ["update-ref", "-d", `refs/heads/${branch.name}`, branch.sha],
      true
    );
    if (deleted.exitCode !== 0) {
      result.errors.push(
        `Could not delete proven target-contained branch ${branch.name}: ${deleted.stderr.trim() || deleted.stdout.trim()}`
      );
      result.preserved.push({
        branch: branch.name,
        reason: "The branch reference could not be deleted.",
      });
      continue;
    }
    result.removed.push({
      branch: branch.name,
      method: containment.method,
      sha: branch.sha,
    });
    runGit(
      options.repositoryPath,
      ["config", "--remove-section", `branch.${branch.name}`],
      true
    );
  }
  return result;
};
