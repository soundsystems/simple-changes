import {
  PATCH_EQUIVALENCE_MAX_COMMITS,
  targetContainmentAudit,
} from "./cleanup-core.ts";
import { runGit } from "./process.ts";
import type {
  RemoteBranchOpenProposalTarget,
  RemoteBranchReconciliationEntry,
  RemoteBranchReconciliationReceipt,
  RepositoryInventory,
  WorktreeClaim,
} from "./types.ts";

/**
 * Remote branches a reconciliation receipt preserves but that the evidence
 * says are finished. Nothing here deletes anything or writes state: the
 * builder turns merged-proposal heads into deletion proposals that still go
 * through `loop guard`, an exact provider deletion, `loop verify`, and a fresh
 * final inventory, and `loop finalize` reports what is left as pending.
 */

/** Dispositions that preserve a branch nobody has proven live or finished. */
const UNCERTAIN_DISPOSITIONS: ReadonlySet<
  RemoteBranchReconciliationEntry["disposition"]
> = new Set(["preserved-ambiguous", "preserved-audited"]);

const finalProposals = (entry: RemoteBranchReconciliationEntry) =>
  entry.proposals.filter((proposal) => proposal.observedFinally !== false);

/**
 * A preserved branch the provider proves finished: present at the same head
 * in the opening and final inventories, unprotected, not the target, no
 * proposal open from it in the final inventory, and a final merged proposal
 * recorded at exactly that head. Holds (open proposals that target it, live
 * leases and claims) are checked separately.
 */
export const mergedHeadDeletionCandidate = (
  entry: RemoteBranchReconciliationEntry,
  targetBranch: string
): { headRevision: string; proposalObjectId: string } | null => {
  const head = entry.finalHeadRevision;
  if (
    !head ||
    entry.initialHeadRevision !== head ||
    entry.name === targetBranch ||
    entry.protected ||
    !UNCERTAIN_DISPOSITIONS.has(entry.disposition)
  ) {
    return null;
  }
  const records = finalProposals(entry);
  if (records.some((proposal) => proposal.state === "open")) {
    return null;
  }
  const merged = records.find(
    (proposal) => proposal.state === "merged" && proposal.headRevision === head
  );
  return merged
    ? { headRevision: head, proposalObjectId: merged.objectId }
    : null;
};

/** Whether a branch entry is one the cleanup report may consider at all. */
const reportable = (
  entry: RemoteBranchReconciliationEntry,
  targetBranch: string
): entry is RemoteBranchReconciliationEntry & { finalHeadRevision: string } =>
  entry.finalHeadRevision !== null &&
  entry.name !== targetBranch &&
  !entry.protected &&
  UNCERTAIN_DISPOSITIONS.has(entry.disposition) &&
  !finalProposals(entry).some((proposal) => proposal.state === "open");

/**
 * Local evidence that a remote branch is still in use: by name (checked out
 * in a worktree, held by an unreleased claim, a claim's resume target, or the
 * upstream of a live branch) and by revision (the exact point where a live
 * branch forked from the target, which is how a fresh integration branch that
 * still equals the target is recognized). A lease's own registrations are not
 * holds: a worktree the run removed stays registered, and a branch the
 * target already contains must not stay hidden behind it.
 */
export interface RemoteBranchHolds {
  byName: Map<string, string[]>;
  byRevision: Map<string, string[]>;
}

const addHold = (
  holds: Map<string, string[]>,
  key: string | null | undefined,
  reason: string
): void => {
  if (!key) {
    return;
  }
  const reasons = holds.get(key) ?? [];
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
  holds.set(key, reasons);
};

const branchNameForRef = (
  ref: string,
  targetRemote: string | null
): string | null => {
  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length) || null;
  }
  if (ref.startsWith("refs/remotes/")) {
    const rest = ref.slice("refs/remotes/".length);
    const separator = rest.indexOf("/");
    return separator === -1 ? null : rest.slice(separator + 1) || null;
  }
  if (targetRemote && ref.startsWith(`${targetRemote}/`)) {
    return ref.slice(targetRemote.length + 1) || null;
  }
  return ref || null;
};

export interface RemoteBranchHoldInput {
  claims: readonly WorktreeClaim[];
  inventory: Pick<RepositoryInventory, "branches" | "repository" | "worktrees">;
  targetBranch: string;
  targetRevision: string;
}

/**
 * Holds by name, and the live local branches whose upstreams and fork points
 * also hold: every branch checked out in a worktree or held by an unreleased
 * claim, which includes a stale claim whose owner may still return.
 */
const nameHolds = (
  input: RemoteBranchHoldInput,
  byName: Map<string, string[]>
): Map<string, string> => {
  const { claims, inventory } = input;
  const live = new Map<string, string>();
  for (const worktree of inventory.worktrees) {
    if (worktree.branch) {
      addHold(byName, worktree.branch, `checked out in ${worktree.path}`);
      live.set(worktree.branch, `checked out in ${worktree.path}`);
    }
  }
  for (const claim of claims) {
    if (claim.state === "released") {
      continue;
    }
    const owner = `claim ${claim.claimId} (${claim.owner.agentId}, ${claim.state})`;
    if (claim.branch) {
      addHold(byName, claim.branch, `held by ${owner}`);
      live.set(claim.branch, `held by ${owner}`);
    }
    if (claim.resumeTarget) {
      addHold(
        byName,
        branchNameForRef(
          claim.resumeTarget.targetRef,
          inventory.repository.targetRemote
        ),
        `resume target of ${owner}`
      );
    }
  }
  return live;
};

/**
 * Where a live branch forked from the target. No shared history means no fork
 * point; any other Git failure throws, because a hold that cannot be computed
 * must not read as no hold.
 */
const forkPoint = (
  repositoryPath: string,
  branch: string,
  head: string,
  targetRevision: string
): string | null => {
  const result = runGit(
    repositoryPath,
    ["merge-base", `${head}^{commit}`, `${targetRevision}^{commit}`],
    true
  );
  if (result.exitCode === 1 && result.stderr.trim() === "") {
    return null;
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `cannot find where ${branch} forked from target ${targetRevision}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return result.stdout.trim();
};

/**
 * Collects the holds. Fork points need Git; a fork point that cannot be
 * computed throws, so a caller deciding deletions can refuse instead of
 * proposing one it could not check.
 */
export const remoteBranchHolds = (
  input: RemoteBranchHoldInput
): RemoteBranchHolds => {
  const { inventory, targetBranch, targetRevision } = input;
  const { primaryCheckout, targetRemote } = inventory.repository;
  const byName = new Map<string, string[]>();
  const byRevision = new Map<string, string[]>();
  const live = nameHolds(input, byName);
  for (const [branch, why] of live) {
    if (branch === targetBranch) {
      continue;
    }
    const local = inventory.branches.find((item) => item.name === branch);
    const upstream =
      local?.upstream && targetRemote
        ? branchNameForRef(local.upstream, targetRemote)
        : null;
    if (upstream && upstream !== targetBranch) {
      addHold(byName, upstream, `upstream of ${branch}, ${why}`);
    }
    const head =
      local?.sha ??
      inventory.worktrees.find((worktree) => worktree.branch === branch)
        ?.headSha;
    const point = head
      ? forkPoint(primaryCheckout, branch, head, targetRevision)
      : null;
    addHold(byRevision, point, `fork point of ${branch}, ${why}`);
  }
  return { byName, byRevision };
};

/** Every reason a branch at a head must not be deleted or reported pending. */
export const holdReasons = (
  name: string,
  headRevision: string,
  holds: RemoteBranchHolds,
  openTargets: readonly RemoteBranchOpenProposalTarget[] | null
): string[] => [
  ...(holds.byName.get(name) ?? []),
  ...(holds.byRevision.get(headRevision) ?? []),
  ...(openTargets ?? [])
    .filter((target) => target.targetBranch === name)
    .map((target) => `target of open proposal ${target.objectId}`),
];

export type RemoteBranchCleanupProof =
  | "merged-proposal-head"
  | "target-contained"
  | "patch-equivalent";

export interface RemoteBranchCleanupItem {
  headRevision: string;
  /** Present when the head moved or arrived during the run. */
  movedDuringRun?: true;
  name: string;
  proof: RemoteBranchCleanupProof;
  proposalObjectId?: string;
}

/**
 * What `loop finalize` reports about preserved provider branches. `pending`
 * is cleanup the user or controller can approve; `held` would be pending but
 * is still in use, so it is reported and never counted.
 */
export interface RemoteBranchCleanupReport {
  errors: string[];
  held: Array<RemoteBranchCleanupItem & { reasons: string[] }>;
  openProposalTargets: "recorded" | "unknown";
  pending: RemoteBranchCleanupItem[];
}

export interface RemoteBranchCleanupInput {
  claims: readonly WorktreeClaim[];
  inventory: Pick<RepositoryInventory, "branches" | "repository" | "worktrees">;
  openTargets: RemoteBranchOpenProposalTarget[] | null;
  receipt: RemoteBranchReconciliationReceipt;
}

const headIsLocal = (repositoryPath: string, head: string): boolean =>
  runGit(repositoryPath, ["cat-file", "-e", `${head}^{commit}`], true)
    .exitCode === 0;

/**
 * The finished-branch proof for one reportable entry, or null when Git proves
 * the target does not contain it. Reporting judges the final head alone, so a
 * branch that moved or arrived still counts when a final merged MR recorded
 * that head. A head Git cannot audit (missing locally, or too far ahead for
 * patch equivalence) is recorded as an error, which keeps cleanup pending:
 * unknown never reads as clean.
 */
const cleanupItem = (
  entry: RemoteBranchReconciliationEntry & { finalHeadRevision: string },
  receipt: RemoteBranchReconciliationReceipt,
  repositoryPath: string,
  patchIdCache: Map<string, Map<string, string>>,
  errors: string[]
): RemoteBranchCleanupItem | null => {
  const head = entry.finalHeadRevision;
  const moved =
    entry.initialHeadRevision === head ? {} : { movedDuringRun: true as const };
  const merged = finalProposals(entry).find(
    (proposal) => proposal.state === "merged" && proposal.headRevision === head
  );
  if (merged) {
    return {
      headRevision: head,
      ...moved,
      name: entry.name,
      proof: "merged-proposal-head",
      proposalObjectId: merged.objectId,
    };
  }
  if (!headIsLocal(repositoryPath, head)) {
    errors.push(
      `Head ${head} of ${entry.name} is not present locally, so its containment could not be checked; fetch the branch and finalize again.`
    );
    return null;
  }
  try {
    const { exceededMaxCommits, method } = targetContainmentAudit(
      repositoryPath,
      receipt.targetRevision,
      head,
      patchIdCache
    );
    if (exceededMaxCommits) {
      errors.push(
        `${entry.name} at ${head} has more than ${PATCH_EQUIVALENCE_MAX_COMMITS} commits outside the target, too many to prove by patch equivalence; classify it yourself.`
      );
      return null;
    }
    if (!method) {
      return null;
    }
    return { headRevision: head, ...moved, name: entry.name, proof: method };
  } catch (error) {
    errors.push(
      `Containment of ${entry.name} at ${head} could not be checked: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
};

/**
 * Builds the report from the recorded receipt and fresh local evidence. A
 * preserved branch counts as pending when a final merged MR recorded its
 * final head, or when Git proves the target contains that head by exact
 * ancestry or full patch-id equivalence. Holds are applied first and move a
 * proven branch to `held`; a held branch whose audit cannot settle is left
 * out, because it is in use and not proven finished. For an unheld branch,
 * evidence Git cannot settle is an error, which keeps cleanup pending, and an
 * error computing the holds leaves every branch unheld: unknown evidence
 * reports more as pending, never fewer.
 */
export const remoteBranchCleanupReport = (
  input: RemoteBranchCleanupInput
): RemoteBranchCleanupReport => {
  const { claims, inventory, openTargets, receipt } = input;
  const repositoryPath = inventory.repository.primaryCheckout;
  const errors: string[] = [];
  let holds: RemoteBranchHolds = { byName: new Map(), byRevision: new Map() };
  try {
    holds = remoteBranchHolds({
      claims,
      inventory,
      targetBranch: receipt.targetBranch,
      targetRevision: receipt.targetRevision,
    });
  } catch (error) {
    errors.push(
      `Live branch holds could not be read, so none is applied: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const report: RemoteBranchCleanupReport = {
    errors,
    held: [],
    openProposalTargets: openTargets === null ? "unknown" : "recorded",
    pending: [],
  };
  const patchIdCache = new Map<string, Map<string, string>>();
  for (const entry of receipt.branches) {
    if (!reportable(entry, receipt.targetBranch)) {
      continue;
    }
    // Holds come first: a branch in use never counts, so what its audit
    // could not settle is not an error either.
    const reasons = holdReasons(
      entry.name,
      entry.finalHeadRevision,
      holds,
      openTargets
    );
    const item = cleanupItem(
      entry,
      receipt,
      repositoryPath,
      patchIdCache,
      reasons.length > 0 ? [] : errors
    );
    if (!item) {
      continue;
    }
    if (reasons.length > 0) {
      report.held.push({ ...item, reasons });
    } else {
      report.pending.push(item);
    }
  }
  return report;
};
