import { randomUUID } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  deleteTargetContainedBranches,
  targetContainmentAudit,
  targetContainsRevision,
} from "./cleanup-core.ts";
import { ensureStateDirectory } from "./git-location.ts";
import {
  captureInventory,
  isLossyName,
  locateRepository,
} from "./inventory.ts";
import {
  resolvedCurrentTargetRevision,
  STATE_DIRECTORY,
  targetBranchForRef,
} from "./loop-lease-core.ts";
import { targetTreeEntry, worktreeSourceEntry } from "./loop-lease-shipment.ts";
import { liveClaimFor } from "./loop-lease-verify.ts";
import { runGit } from "./process.ts";
import { latestRecordedHead, readReviewLedger } from "./review-ledger.ts";
import { validateSchema } from "./schema.ts";
import type {
  BranchInventory,
  LoopLease,
  RepositoryInventory,
  WorktreeInventory,
} from "./types.ts";
import { readCoordinationDocumentFromCommonDirectory } from "./worktree-coordination.ts";

/**
 * The only finished state a Queue or Sweep run reports. It is never
 * delivery: nothing was merged, and the target did not change.
 */
export const QUEUED_FOR_REVIEW = "queued-for-review-not-merged";

const QUEUED_MODES: ReadonlySet<LoopLease["mode"]> = new Set([
  "queue",
  "sweep",
]);

/**
 * Hosts where a pushed branch can always get a proposal, so pushing without
 * one is unfinished work there, whatever the controller declares.
 */
const PROPOSAL_FORGES: ReadonlySet<string> = new Set([
  "codeberg",
  "github",
  "gitlab",
]);

const QUEUED_WORK_DIRECTORY = "queued-work";

/** A record older than this is forgotten at the next loop start. */
const QUEUED_WORK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const MAX_NO_PROPOSAL_REASON_LENGTH = 500;

/** One branch a Queue or Sweep run pushed and left for review. */
export interface QueuedUnit {
  branch: string;
  headSha: string;
  /**
   * Paths whose uncommitted bytes in the primary checkout equal this head's:
   * the queued branch carries a copy of them, and the primary keeps its own.
   */
  primaryCopies: string[];
  /** Proposals the review ledger records at exactly this pushed head. */
  proposalIds: string[];
  remote: string;
  remoteBranch: string;
  /**
   * Why the branch was pushed without a proposal, as the controller declared
   * it for a remote with nowhere to open one; null when a proposal exists.
   */
  withoutProposal: string | null;
  worktree: string;
}

/** A clean run-created checkout whose head the target already contains. */
export interface QueuedDiscardable {
  branch: string | null;
  headSha: string;
  path: string;
}

export interface QueuedAssessment {
  blockers: string[];
  discardable: QueuedDiscardable[];
  units: QueuedUnit[];
}

/**
 * Whether finalization judges this run by Queue's finish line: its own
 * pushed branches and their proposals, never a merged target or a clean
 * primary. A run that recorded a shipment scope keeps the scoped rules.
 */
export const closesAsQueued = (lease: LoopLease): boolean =>
  QUEUED_MODES.has(lease.mode) && !lease.shipmentScope;

export const noProposalReason = (input: string | undefined): string | null => {
  const reason = input?.trim();
  return reason ? reason.slice(0, MAX_NO_PROPOSAL_REASON_LENGTH) : null;
};

const resolveCommit = (repositoryPath: string, ref: string): string | null => {
  const result = runGit(
    repositoryPath,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    true
  );
  const revision = result.stdout.trim();
  return result.exitCode === 0 && revision ? revision : null;
};

interface PushedBranch {
  name: string;
  remote: string;
  revision: string;
}

/**
 * Where this head is pushed, by Git's own remote-tracking refs: the branch's
 * upstream on any remote, or its namesake on the target remote, and never
 * the target itself. A ref that does not resolve, or does not contain the
 * head, proves nothing, so the work then counts as not pushed.
 */
const pushedBranch = (
  context: QueuedContext,
  branch: BranchInventory,
  headSha: string
): PushedBranch | null => {
  const repositoryPath = context.lease.primaryCheckout;
  const candidates: { name: string; remote: string }[] = [];
  const upstreamRemote = context.inventory.repository.remoteBindings.find(
    (binding) => branch.upstream?.startsWith(`${binding.name}/`)
  )?.name;
  if (upstreamRemote && branch.upstream) {
    candidates.push({
      name: branch.upstream.slice(upstreamRemote.length + 1),
      remote: upstreamRemote,
    });
  }
  if (context.remote) {
    candidates.push({ name: branch.exactName, remote: context.remote });
  }
  for (const { name, remote } of candidates) {
    if (remote === context.remote && name === context.targetBranch) {
      continue;
    }
    const revision = resolveCommit(
      repositoryPath,
      `refs/remotes/${remote}/${name}`
    );
    if (revision && targetContainsRevision(repositoryPath, revision, headSha)) {
      return { name, remote, revision };
    }
  }
  return null;
};

/** Proposals whose latest recorded head is one of these revisions. */
const recordedProposals = (
  commonGitDirectory: string,
  revisions: readonly string[]
): string[] => {
  const ledger = readReviewLedger(commonGitDirectory);
  if (ledger.state !== "valid") {
    return [];
  }
  return Object.entries(ledger.ledger.proposals)
    .filter(([, proposal]) => {
      const latest = latestRecordedHead(proposal);
      return latest !== null && revisions.includes(latest);
    })
    .map(([proposalId]) => proposalId)
    .sort((left, right) => left.localeCompare(right));
};

/**
 * Whether the branch still merges into a target that moved since the run
 * started: true when it already descends from the target or Git merges the
 * two trees without a conflict, false on a conflict, null when Git could
 * not say.
 */
const mergesIntoMovedTarget = (
  repositoryPath: string,
  targetRevision: string,
  headSha: string
): boolean | null => {
  if (targetContainsRevision(repositoryPath, headSha, targetRevision)) {
    return true;
  }
  const merged = runGit(
    repositoryPath,
    ["merge-tree", "--write-tree", "--no-messages", targetRevision, headSha],
    true
  );
  if (merged.exitCode === 0) {
    return true;
  }
  return merged.exitCode === 1 ? false : null;
};

/**
 * Dirty primary paths whose bytes are exactly the ones this head changed
 * from the target: the content the person asked to put up, which the queued
 * branch now carries a copy of.
 */
const primaryCopiesOf = (
  primary: WorktreeInventory | undefined,
  headSha: string,
  targetRevision: string
): string[] => {
  if (!primary) {
    return [];
  }
  const copies: string[] = [];
  for (const change of primary.changes) {
    if (change.conflicted) {
      continue;
    }
    try {
      const queued = targetTreeEntry(primary.path, headSha, change.path);
      if (
        queued === worktreeSourceEntry(primary.path, change.path) &&
        queued !== targetTreeEntry(primary.path, targetRevision, change.path)
      ) {
        copies.push(change.path);
      }
    } catch {
      // An entry Git could not read is not proof of a copy.
    }
  }
  return copies.sort((left, right) => left.localeCompare(right));
};

interface QueuedContext {
  inventory: RepositoryInventory;
  lease: LoopLease;
  noProposal: string | null;
  primary: WorktreeInventory | undefined;
  /** The target's remote, when the target is a remote branch. */
  remote: string | null;
  targetBranch: string | null;
  targetRevision: string;
}

/**
 * The forge that can open a proposal for a branch pushed to this remote:
 * the target's own host, or the host the branch was pushed to, as a fork's
 * branch is proposed on the target's forge. Null when neither is one.
 */
const proposalForge = (
  context: QueuedContext,
  pushedRemote: string
): string | null =>
  context.inventory.repository.remoteBindings
    .filter(
      (binding) =>
        binding.name === context.remote || binding.name === pushedRemote
    )
    .map((binding) => binding.provider)
    .find((provider) => PROPOSAL_FORGES.has(provider)) ?? null;

/**
 * Why a pushed branch has no acceptable proposal state, or the declared
 * reason it has none, or null when the ledger records one.
 */
const proposalState = (
  context: QueuedContext,
  branch: string,
  headSha: string,
  pushed: PushedBranch,
  proposalIds: readonly string[]
): { blocker: string } | { withoutProposal: string | null } => {
  if (proposalIds.length > 0) {
    return { withoutProposal: null };
  }
  const record = `No proposal is recorded for queued branch ${branch} at ${headSha}. Open its proposal, run \`simple-changes proposal record-authors --proposal <id> --base ${context.lease.targetRevision} --head ${headSha}\`, then resume and finalize again`;
  const forge = proposalForge(context, pushed.remote);
  if (forge) {
    return {
      blocker: `${record}. ${forge} can open proposals, so \`--no-proposal\` does not apply to ${pushed.remote}.`,
    };
  }
  if (context.noProposal) {
    return { withoutProposal: context.noProposal };
  }
  return {
    blocker: `${record}; or, only when ${pushed.remote} has nowhere to open one, finalize with \`--no-proposal "<why>"\` so the receipt reports the branch as pushed without a proposal.`,
  };
};

/** Why a target that moved since the run started blocks this branch. */
const movedTargetBlocker = (
  context: QueuedContext,
  branch: string,
  headSha: string
): string | null => {
  const { lease, targetRevision } = context;
  if (targetRevision === lease.targetRevision) {
    return null;
  }
  const merges = mergesIntoMovedTarget(
    lease.primaryCheckout,
    targetRevision,
    headSha
  );
  if (merges === true) {
    return null;
  }
  const moved = `${lease.targetRef} moved from ${lease.targetRevision} to ${targetRevision} since this run started, and queued branch ${branch}`;
  return merges === false
    ? `${moved} no longer merges into it cleanly. Update the branch and its proposal, then finalize again.`
    : `${moved} could not be checked against it: \`git merge-tree --write-tree\` gave no answer (it needs Git 2.38 or later). Update the branch onto the new target, or retry.`;
};

type WorktreeVerdict =
  | { blocker: string }
  | { discardable: QueuedDiscardable }
  | { unit: QueuedUnit };

/** Why a run-created checkout cannot be read as queued work yet, or null. */
const unreadableReason = (worktree: WorktreeInventory): string | null => {
  if (worktree.prunable) {
    return `Run-created worktree ${worktree.path} has no directory any more, so its work cannot be checked. Restore it, or prune its record with Git, before closing.`;
  }
  if (worktree.changes.length > 0) {
    return `Queued worktree ${worktree.path} has uncommitted changes. Commit and push them, or keep them and pause for the user; nothing in it was removed.`;
  }
  return null;
};

const pushedUnit = (
  context: QueuedContext,
  worktree: WorktreeInventory,
  headSha: string
): WorktreeVerdict => {
  const { inventory, lease } = context;
  const branch = inventory.branches.find(
    (item) => item.worktreePath === worktree.path && item.sha === headSha
  );
  if (!(branch && worktree.branch) || isLossyName(worktree.branch)) {
    return {
      blocker: `Queued worktree ${worktree.path} is not on a branch whose pushed copy can be named exactly, so its commits cannot be proven pushed.`,
    };
  }
  const pushed = pushedBranch(context, branch, headSha);
  if (!pushed) {
    const remote = context.remote ?? "<remote>";
    return {
      blocker: `Queued branch ${worktree.branch} at ${headSha} is not pushed: no remote branch holds its commits. Push it as its own branch (\`git push -u ${remote} ${worktree.branch}:${worktree.branch}\`) before closing; its worktree ${worktree.path} was kept.`,
    };
  }
  const moved = movedTargetBlocker(context, worktree.branch, headSha);
  if (moved) {
    return { blocker: moved };
  }
  const proposalIds = recordedProposals(lease.commonGitDirectory, [
    headSha,
    pushed.revision,
  ]);
  const proposal = proposalState(
    context,
    worktree.branch,
    headSha,
    pushed,
    proposalIds
  );
  if ("blocker" in proposal) {
    return proposal;
  }
  return {
    unit: {
      branch: worktree.branch,
      headSha,
      primaryCopies: primaryCopiesOf(
        context.primary,
        headSha,
        context.targetRevision
      ),
      proposalIds,
      remote: pushed.remote,
      remoteBranch: pushed.name,
      withoutProposal: proposal.withoutProposal,
      worktree: worktree.path,
    },
  };
};

const worktreeVerdict = (
  context: QueuedContext,
  worktree: WorktreeInventory
): WorktreeVerdict => {
  const unreadable = unreadableReason(worktree);
  const { headSha } = worktree;
  if (unreadable !== null || headSha === null) {
    return {
      blocker:
        unreadable ??
        `Queued worktree ${worktree.path} has no commit to check.`,
    };
  }
  if (
    targetContainsRevision(
      context.lease.primaryCheckout,
      context.targetRevision,
      headSha
    )
  ) {
    return {
      discardable: { branch: worktree.branch, headSha, path: worktree.path },
    };
  }
  return pushedUnit(context, worktree, headSha);
};

/**
 * Reads every live run-created checkout of a Queue or Sweep run as queued
 * work: pushed as its own branch with a recorded proposal, or contained in
 * the target and so nothing to queue. Anything else is a blocker, and
 * nothing here changes the repository.
 */
export const assessQueuedWork = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  noProposal: string | null
): QueuedAssessment => {
  const assessment: QueuedAssessment = {
    blockers: [],
    discardable: [],
    units: [],
  };
  const targetRevision = resolvedCurrentTargetRevision(lease);
  if (!targetRevision) {
    // Completion already reports the unresolved target; nothing is proven.
    return assessment;
  }
  const remote = inventory.repository.targetRemote;
  const context: QueuedContext = {
    inventory,
    lease,
    noProposal,
    primary: inventory.worktrees.find(
      (worktree) => worktree.path === lease.primaryCheckout
    ),
    remote,
    targetBranch: targetBranchForRef(lease.primaryCheckout, lease.targetRef),
    targetRevision,
  };
  const created = new Set(
    lease.worktrees
      .filter((worktree) => worktree.createdByRun)
      .map((worktree) => worktree.path)
  );
  for (const worktree of inventory.worktrees) {
    if (!created.has(worktree.path)) {
      continue;
    }
    const verdict = worktreeVerdict(context, worktree);
    if ("blocker" in verdict) {
      assessment.blockers.push(verdict.blocker);
    } else if ("unit" in verdict) {
      assessment.units.push(verdict.unit);
    } else {
      assessment.discardable.push(verdict.discardable);
    }
  }
  return assessment;
};

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "es"}`;

/** One plain sentence set for the receipt and the command's own output. */
export const queuedSummary = (
  lease: LoopLease,
  units: readonly QueuedUnit[]
): string => {
  const proposed = units.filter((unit) => unit.withoutProposal === null);
  const bare = units.length - proposed.length;
  const counts =
    units.length === 0
      ? "nothing was queued by this run"
      : [
          ...(proposed.length > 0
            ? [`${plural(proposed.length, "branch")} pushed with a proposal`]
            : []),
          ...(bare > 0
            ? [
                `${plural(bare, "branch")} pushed without a proposal, because the remote has nowhere to open one`,
              ]
            : []),
        ].join(" and ");
  return `Queued for review, not merged: ${counts}. Nothing was added to ${lease.targetRef}. Uncommitted work in the primary checkout was left exactly as it was; each unit lists the paths its branch carries a copy of. A clean, pushed worktree of this run is removed after this receipt is written, and its local branch keeps the work.`;
};

export interface QueuedWorktreeCleanup {
  kept: { path: string; reason: string }[];
  removed: string[];
}

interface RemovalCandidate {
  branch: string | null;
  discard: boolean;
  headSha: string;
  path: string;
}

/**
 * Removes a run-created checkout with Git's own unforced removal, which
 * refuses one holding changes or untracked files. Returns why it was kept.
 */
const removeCleanWorktree = (
  repositoryPath: string,
  path: string
): string | null => {
  const removal = runGit(repositoryPath, ["worktree", "remove", path], true);
  return removal.exitCode === 0
    ? null
    : `Git did not remove it: ${removal.stderr.trim() || removal.stdout.trim()}`;
};

/**
 * Deletes the branches of removed checkouts that queued nothing, once
 * unattached: only a branch this run registered for that checkout and that
 * did not exist when the run started, so an earlier branch is never taken.
 */
const deleteDiscardedBranches = (
  lease: LoopLease,
  discarded: readonly RemovalCandidate[]
): void => {
  const targetRevision = resolvedCurrentTargetRevision(lease);
  if (!targetRevision || discarded.length === 0) {
    return;
  }
  const targetBranch = targetBranchForRef(
    lease.primaryCheckout,
    lease.targetRef
  );
  const opening = new Set(
    (lease.openingBranches ?? []).map((branch) => branch.name)
  );
  const heads = new Map(
    discarded.flatMap((item): [string, string][] =>
      item.branch &&
      !opening.has(item.branch) &&
      lease.worktrees.some(
        (worktree) =>
          worktree.createdByRun &&
          worktree.path === item.path &&
          worktree.branch === item.branch
      )
        ? [[item.branch, item.headSha]]
        : []
    )
  );
  deleteTargetContainedBranches({
    branches: captureInventory(lease.primaryCheckout).branches.filter(
      (branch) =>
        heads.get(branch.name) === branch.sha &&
        !isLossyName(branch.name) &&
        branch.name !== targetBranch &&
        branch.worktreePath === null
    ),
    repositoryPath: lease.primaryCheckout,
    targetRevision,
  });
};

/** Why a checkout the run just proved must stay after all, or null. */
const keepReason = (
  lease: LoopLease,
  fresh: RepositoryInventory,
  stillProven: ReadonlyMap<string, string>,
  candidate: RemovalCandidate
): string | null => {
  if (stillProven.get(candidate.path) !== candidate.headSha) {
    return "It changed while the run was closing.";
  }
  if (
    candidate.path === fresh.repository.currentCheckout ||
    lease.worktrees.some(
      (worktree) =>
        worktree.path === candidate.path && worktree.role === "controller"
    )
  ) {
    return "It is the checkout this run was controlled from.";
  }
  return liveClaimFor(
    readCoordinationDocumentFromCommonDirectory(lease.commonGitDirectory),
    lease.commonGitDirectory,
    candidate.path
  )
    ? "A worktree claim still holds it."
    : null;
};

const removeProvenWorktrees = (
  lease: LoopLease,
  repositoryPath: string,
  candidates: readonly RemovalCandidate[],
  noProposal: string | null,
  cleanup: QueuedWorktreeCleanup
): void => {
  const fresh = captureInventory(repositoryPath);
  const proven = assessQueuedWork(lease, fresh, noProposal);
  const stillProven = new Map<string, string>([
    ...proven.units.map((unit): [string, string] => [
      unit.worktree,
      unit.headSha,
    ]),
    ...proven.discardable.map((item): [string, string] => [
      item.path,
      item.headSha,
    ]),
  ]);
  const discarded: RemovalCandidate[] = [];
  for (const candidate of candidates) {
    const reason =
      keepReason(lease, fresh, stillProven, candidate) ??
      removeCleanWorktree(lease.primaryCheckout, candidate.path);
    if (reason) {
      cleanup.kept.push({ path: candidate.path, reason });
      continue;
    }
    cleanup.removed.push(candidate.path);
    if (candidate.discard) {
      discarded.push(candidate);
    }
  }
  deleteDiscardedBranches(lease, discarded);
};

/**
 * After a Queue or Sweep run has closed, removes each of its checkouts that
 * a fresh inventory still proves clean and either pushed with its proposal
 * state or contained in the target. The pushed branch stays, locally and on
 * the remote; a branch the target contains is deleted with its checkout.
 * Anything that changed, is claimed, is the controller's own checkout, or
 * that Git refuses to remove is kept and named. The run is already closed,
 * so this never blocks or throws: a failure keeps what is left.
 */
export const removeQueuedWorktrees = (
  lease: LoopLease,
  repositoryPath: string,
  assessed: QueuedAssessment,
  noProposal: string | null
): QueuedWorktreeCleanup => {
  const cleanup: QueuedWorktreeCleanup = { kept: [], removed: [] };
  const candidates: RemovalCandidate[] = [
    ...assessed.units.map((unit) => ({
      branch: unit.branch,
      discard: false,
      headSha: unit.headSha,
      path: unit.worktree,
    })),
    ...assessed.discardable.map((item) => ({ ...item, discard: true })),
  ];
  try {
    removeProvenWorktrees(
      lease,
      repositoryPath,
      candidates,
      noProposal,
      cleanup
    );
  } catch (error) {
    const settled = new Set([
      ...cleanup.removed,
      ...cleanup.kept.map((item) => item.path),
    ]);
    const detail = error instanceof Error ? error.message : String(error);
    for (const candidate of candidates) {
      if (!settled.has(candidate.path)) {
        cleanup.kept.push({
          path: candidate.path,
          reason: `Cleanup stopped before it: ${detail}`,
        });
      }
    }
  }
  return cleanup;
};

// ---------------------------------------------------------------------------
// What closed Queue and Sweep runs already put up

/**
 * The record a closed Queue or Sweep run leaves beside the loop state, in
 * its own file so older runtimes never meet it: the branches it pushed for
 * review. A later run reads it to say so before the same uncommitted bytes
 * are proposed again as new work.
 */
export interface QueuedWorkRecord {
  closedAt: string;
  kind: "queued-work";
  mode: "queue" | "sweep";
  primaryCheckout: string;
  runId: string;
  schemaVersion: 1;
  targetRef: string;
  units: QueuedUnit[];
}

const queuedWorkDirectory = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY, QUEUED_WORK_DIRECTORY);

export const writeQueuedWorkRecord = (
  lease: LoopLease,
  units: readonly QueuedUnit[],
  closedAt: string
): void => {
  if (units.length === 0) {
    return;
  }
  const record = validateSchema<QueuedWorkRecord>("queued-work", {
    closedAt,
    kind: "queued-work",
    mode: lease.mode,
    primaryCheckout: lease.primaryCheckout,
    runId: lease.runId,
    schemaVersion: 1,
    targetRef: lease.targetRef,
    units,
  });
  const directory = ensureStateDirectory(
    lease.commonGitDirectory,
    queuedWorkDirectory(lease.commonGitDirectory)
  );
  const path = resolve(directory, `${lease.runId}.json`);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
};

interface StoredQueuedWork {
  path: string;
  record: QueuedWorkRecord;
}

// A record that is missing, unreadable, or not this shape is skipped: it
// only ever adds a notice, so it never stops a command.
const storedQueuedWork = (commonGitDirectory: string): StoredQueuedWork[] => {
  const directory = queuedWorkDirectory(commonGitDirectory);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const stored: StoredQueuedWork[] = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    const path = resolve(directory, name);
    try {
      stored.push({
        path,
        record: validateSchema<QueuedWorkRecord>(
          "queued-work",
          JSON.parse(readFileSync(path, "utf8")) as unknown
        ),
      });
    } catch {
      // Skipped, as above.
    }
  }
  return stored;
};

export const readQueuedWorkRecords = (
  repositoryPath: string
): QueuedWorkRecord[] =>
  storedQueuedWork(
    locateRepository(repositoryPath).repository.commonGitDirectory
  ).map((item) => item.record);

/**
 * Whether a queued head is still waiting: present locally and not in the
 * target, by ancestry or patch equivalence. Absence is read from Git's exit
 * code alone, and an audit Git could not finish counts as still waiting, so
 * an answer lost under load never forgets queued work.
 */
const stillQueued = (
  repositoryPath: string,
  targetRevision: string,
  headSha: string
): boolean => {
  if (
    runGit(repositoryPath, ["cat-file", "-e", `${headSha}^{commit}`], true)
      .exitCode !== 0
  ) {
    return false;
  }
  try {
    return (
      targetContainmentAudit(repositoryPath, targetRevision, headSha).method ===
      null
    );
  } catch {
    return true;
  }
};

/**
 * Forgets every record whose branches are all merged or gone, or that has
 * passed its retention. Runs at loop start, under the loop lock.
 */
export const pruneQueuedWorkRecords = (
  inventory: RepositoryInventory
): void => {
  const { commonGitDirectory, primaryCheckout } = inventory.repository;
  try {
    const targetRevision = resolveCommit(primaryCheckout, inventory.targetRef);
    if (!targetRevision) {
      return;
    }
    const now = Date.now();
    for (const { path, record } of storedQueuedWork(commonGitDirectory)) {
      const expired = !(
        now - Date.parse(record.closedAt) <
        QUEUED_WORK_RETENTION_MS
      );
      if (
        expired ||
        !record.units.some((unit) =>
          stillQueued(primaryCheckout, targetRevision, unit.headSha)
        )
      ) {
        rmSync(path, { force: true });
      }
    }
  } catch {
    // Housekeeping only: a record that could not be judged or removed stays
    // for the next start, and never stops this one.
  }
};

/** Uncommitted primary content that an earlier run already put up. */
export interface QueuedWorkNotice {
  branch: string;
  headSha: string;
  message: string;
  paths: string[];
  proposalIds: string[];
  runId: string;
  withoutProposal: string | null;
}

const noticeFor = (
  record: QueuedWorkRecord,
  unit: QueuedUnit,
  paths: string[]
): QueuedWorkNotice => {
  const where =
    unit.proposalIds.length > 0
      ? `proposal ${unit.proposalIds.join(", ")}`
      : "pushed without a proposal";
  return {
    branch: unit.branch,
    headSha: unit.headSha,
    message: `${paths.join(", ")} in the primary checkout ${paths.length === 1 ? "is" : "are"} already queued for review, not merged: branch ${unit.branch} at ${unit.headSha} (${where}) carries the same bytes, put up by ${record.runId}. Do not propose ${paths.length === 1 ? "it" : "them"} again as new work; say ${paths.length === 1 ? "it is" : "they are"} already up, or update that branch and its proposal if the content should change.`,
    paths,
    proposalIds: unit.proposalIds,
    runId: record.runId,
    withoutProposal: unit.withoutProposal,
  };
};

const noticesFrom = (
  repositoryPath: string,
  inventoryInput?: RepositoryInventory
): QueuedWorkNotice[] => {
  const stored = storedQueuedWork(
    (inventoryInput ?? locateRepository(repositoryPath)).repository
      .commonGitDirectory
  );
  if (stored.length === 0) {
    // The usual case costs no inventory.
    return [];
  }
  const inventory = inventoryInput ?? captureInventory(repositoryPath);
  const { primaryCheckout } = inventory.repository;
  const primary = inventory.worktrees.find((worktree) => worktree.isPrimary);
  const targetRevision = resolveCommit(primaryCheckout, inventory.targetRef);
  if (!(primary?.changes.length && targetRevision)) {
    return [];
  }
  const notices: QueuedWorkNotice[] = [];
  for (const { record } of stored) {
    for (const unit of record.units) {
      // The cheap comparison first; the merge audit only for a match.
      const paths = primaryCopiesOf(primary, unit.headSha, targetRevision);
      if (
        paths.length > 0 &&
        stillQueued(primaryCheckout, targetRevision, unit.headSha)
      ) {
        notices.push(noticeFor(record, unit, paths));
      }
    }
  }
  return notices;
};

/**
 * Names every uncommitted path in the primary checkout whose bytes a closed
 * Queue or Sweep run already pushed for review and that is still unmerged.
 * Read-only, and judged from the current bytes: once the person edits a
 * path again, it is new work and is no longer named. It is advice beside a
 * command's own result, so a failure to read it never fails that command.
 */
export const queuedWorkNotices = (
  repositoryPath: string,
  inventory?: RepositoryInventory
): QueuedWorkNotice[] => {
  try {
    return noticesFrom(repositoryPath, inventory);
  } catch {
    return [];
  }
};
