import { targetContainsRevision } from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { completeLine } from "./git-complete.ts";
import { isLossyName } from "./inventory.ts";
import {
  resolvedCurrentTargetRevision,
  retirementForRegistration,
  targetBranchForRef,
} from "./loop-lease-core.ts";
import { worktreeSourceEntry } from "./loop-lease-shipment.ts";
import { runGit, runGitRemote } from "./process.ts";
import { readProposalSources } from "./proposal-sources.ts";
import { redactSecrets } from "./redact.ts";
import {
  isProposalId,
  latestRecordedHead,
  readReviewLedger,
} from "./review-ledger.ts";
import { sourceWorktreeDelta } from "./source-worktree-delta.ts";
import type {
  BranchInventory,
  LoopLease,
  LoopWorktreeLease,
  RepositoryInventory,
  WorktreeInventory,
} from "./types.ts";

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

const MAX_NO_PROPOSAL_REASON_LENGTH = 500;

const MAX_QUEUED_PROPOSALS = 50;

/** One branch a Queue or Sweep run pushed and left for review. */
export interface QueuedUnit {
  branch: string;
  headSha: string;
  /**
   * The proposal the controller named for this branch, whose recorded head
   * is exactly `headSha` and whose recorded base the target contains; null
   * when the branch was pushed without one.
   */
  proposalId: string | null;
  remote: string;
  remoteBranch: string;
  /**
   * Why the branch was pushed without a proposal, as the controller declared
   * it for a remote with nowhere to open one; null when a proposal exists.
   */
  withoutProposal: string | null;
  /** The run-created checkout, kept in place; null when it is already gone. */
  worktree: string | null;
}

export interface QueuedAssessment {
  blockers: string[];
  /** Every live run-created checkout. Finalization keeps them all. */
  keptWorktrees: string[];
  units: QueuedUnit[];
}

/** What the controller told `loop finalize` about its pushed branches. */
export interface QueuedDeclarations {
  /** `--no-proposal`: why no proposal can be opened; null when not given. */
  noProposal: string | null;
  /**
   * `--queued-proposal <branch>=<id>`: the proposal named for a branch,
   * when the recorded ones do not settle it. It must still bind.
   */
  proposals: ReadonlyMap<string, string>;
}

/**
 * Whether finalization judges this run by Queue's finish line: its own
 * pushed branches and their proposals, never a merged target or a clean
 * primary. A run that recorded a shipment scope keeps the scoped rules.
 */
export const closesAsQueued = (lease: LoopLease): boolean =>
  QUEUED_MODES.has(lease.mode) && !lease.shipmentScope;

/**
 * Reads the finalize options. Each `--queued-proposal` is `<branch>=<id>`,
 * split at the last `=`, since a branch name may hold one and a proposal id
 * never does. A malformed or repeated branch is a usage error.
 */
export const queuedDeclarations = (
  noProposalInput: string | undefined,
  proposalInputs: readonly string[] = []
): QueuedDeclarations => {
  if (proposalInputs.length > MAX_QUEUED_PROPOSALS) {
    throw new SimpleChangesError(
      `Name at most ${MAX_QUEUED_PROPOSALS} queued proposals.`,
      EXIT_CODES.usage
    );
  }
  const proposals = new Map<string, string>();
  for (const input of proposalInputs) {
    const separator = input.lastIndexOf("=");
    const branch = input.slice(0, Math.max(separator, 0)).trim();
    const proposalId = input.slice(separator + 1).trim();
    if (!(branch && isProposalId(proposalId)) || proposals.has(branch)) {
      throw new SimpleChangesError(
        "--queued-proposal must be <branch>=<proposal id>, once per branch.",
        EXIT_CODES.usage
      );
    }
    proposals.set(branch, proposalId);
  }
  const reason = noProposalInput?.trim();
  return {
    noProposal: reason ? reason.slice(0, MAX_NO_PROPOSAL_REASON_LENGTH) : null,
    proposals,
  };
};

interface QueuedContext {
  declared: QueuedDeclarations;
  inventory: RepositoryInventory;
  lease: LoopLease;
  /** The target's remote, when the target is a remote branch. */
  remote: string | null;
  targetBranch: string | null;
  targetRevision: string;
}

export type RemoteHead =
  | { head: string | null; state: "answered" }
  | { detail: string; state: "unanswered" };

const LS_REMOTE_LINE = /^([0-9a-f]{40,64})\t(.+)$/u;

/**
 * The head of exactly `ref` at one remote address, asked of the remote
 * itself: a remote-tracking ref can still name a commit the server has
 * since deleted or rewritten. The answer counts only when it arrived
 * whole. Absence is `ls-remote --exit-code` exiting 2 with no output, which
 * a lost answer cannot fake; anything else is no answer.
 */
export const askRemoteRef = (
  repositoryPath: string,
  destination: string,
  ref: string
): RemoteHead => {
  const listing = runGitRemote(repositoryPath, [
    "ls-remote",
    "--exit-code",
    destination,
    ref,
  ]);
  if (listing.exitCode === 2 && listing.stdout === "") {
    return { head: null, state: "answered" };
  }
  const lines = listing.stdout.split("\n");
  if (listing.exitCode !== 0 || lines.pop() !== "") {
    return {
      detail: redactSecrets(
        (listing.stderr || listing.stdout).trim() ||
          `git ls-remote exited ${listing.exitCode}`
      ),
      state: "unanswered",
    };
  }
  const entries = lines.map((line) => LS_REMOTE_LINE.exec(line));
  if (entries.length === 0 || entries.some((entry) => entry === null)) {
    return {
      detail: "the listing was lost or cut short",
      state: "unanswered",
    };
  }
  return {
    head: entries.find((entry) => entry?.[2] === ref)?.[1] ?? null,
    state: "answered",
  };
};

/**
 * The head of exactly `refs/heads/<branch>` at the remote's push
 * destination; see `askRemoteRef`. A remote without one push destination
 * has nothing to ask, which is no answer.
 */
const remoteBranchHead = (
  repositoryPath: string,
  remote: string,
  branch: string
): RemoteHead => {
  let destination: string | null;
  try {
    // Every push URL, which must be one whole line: Git pushes to each
    // of several, so a remote with more has no single destination to ask,
    // and is refused below as no answer.
    destination = completeLine(repositoryPath, [
      "remote",
      "get-url",
      "--push",
      "--all",
      remote,
    ]).line;
  } catch {
    destination = null;
  }
  // A destination that begins with a dash would be read as an option.
  if (!destination || destination.startsWith("-")) {
    return {
      detail: `${remote} has no single push destination to ask`,
      state: "unanswered",
    };
  }
  return askRemoteRef(repositoryPath, destination, `refs/heads/${branch}`);
};

interface PushDestination {
  name: string;
  remote: string;
}

/** A branch whose exact head its push destination confirmed. */
interface PushedUnit {
  branch: string;
  headSha: string;
  pushed: PushDestination;
}

/**
 * Where this branch is pushed, read from its own configuration: its
 * upstream on any remote, or its namesake on the target remote, and never
 * the target itself.
 */
const pushDestinations = (
  context: QueuedContext,
  branch: BranchInventory
): PushDestination[] => {
  const destinations: PushDestination[] = [];
  const upstreamRemote = context.inventory.repository.remoteBindings.find(
    (binding) => branch.upstream?.startsWith(`${binding.name}/`)
  )?.name;
  if (upstreamRemote && branch.upstream) {
    destinations.push({
      name: branch.upstream.slice(upstreamRemote.length + 1),
      remote: upstreamRemote,
    });
  }
  if (
    context.remote &&
    !destinations.some(
      (item) => item.remote === context.remote && item.name === branch.exactName
    )
  ) {
    destinations.push({ name: branch.exactName, remote: context.remote });
  }
  return destinations.filter(
    (item) =>
      !(item.remote === context.remote && item.name === context.targetBranch)
  );
};

/**
 * The remote branch that holds exactly this head, or why none is proven.
 * Only a destination whose remote-tracking ref already names the head is
 * asked, so unpushed work costs no network call; the remote's own answer
 * then decides.
 */
const pushedBranch = (
  context: QueuedContext,
  branch: BranchInventory,
  headSha: string
): PushDestination | { blocker: string } => {
  const repositoryPath = context.lease.primaryCheckout;
  const notPushed = `Queued branch ${branch.name} at ${headSha} is not pushed: no remote branch holds exactly that commit. Push it as its own branch (\`git push -u ${context.remote ?? "<remote>"} ${branch.name}:${branch.name}\`), then resume and finalize again. Nothing was removed.`;
  for (const destination of pushDestinations(context, branch)) {
    const tracked = runGit(
      repositoryPath,
      [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/${destination.remote}/${destination.name}^{commit}`,
      ],
      true
    );
    if (tracked.exitCode !== 0 || tracked.stdout.trim() !== headSha) {
      continue;
    }
    const asked = remoteBranchHead(
      repositoryPath,
      destination.remote,
      destination.name
    );
    if (asked.state === "unanswered") {
      return {
        blocker: `Could not confirm that ${destination.remote} still holds queued branch ${destination.name} at ${headSha}: ${asked.detail}. The local record of a push is not proof, so the run stays open; resume and finalize again when the remote answers.`,
      };
    }
    if (asked.head === headSha) {
      return destination;
    }
    return {
      blocker: `${destination.remote} no longer holds queued branch ${destination.name} at ${headSha}: it ${asked.head ? `is at ${asked.head}` : "has no such branch"} there now. Push the branch again or settle what replaced it, then resume and finalize again. Nothing was removed.`,
    };
  }
  return { blocker: notPushed };
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
 * Why a proposal does not bind to this pushed branch, or null when it does.
 * Three records must agree, and none matches by commit alone:
 *
 * - its source, written by `proposal record-authors` beside the ledger,
 *   names this exact branch at this exact head, on this remote branch when
 *   the branch had an upstream then;
 * - the review ledger records the proposal's latest head as exactly the
 *   queued head, never an ancestor or descendant;
 * - that head's recorded base is contained in the run's target.
 */
const proposalMismatch = (
  context: QueuedContext,
  unit: PushedUnit,
  proposalId: string
): string | null => {
  const { lease } = context;
  const { branch, headSha, pushed } = unit;
  const source = readProposalSources(lease.commonGitDirectory).find(
    (item) => item.proposalId === proposalId
  );
  const recordAuthors = `\`simple-changes proposal record-authors --proposal ${proposalId} --base ${lease.targetRevision} --head ${headSha} --source-branch ${branch}\``;
  if (source?.sourceBranch !== branch || source.headSha !== headSha) {
    return `Proposal ${proposalId} is not recorded as opened from ${branch} at ${headSha}${source ? ` (it is recorded from ${source.sourceBranch} at ${source.headSha})` : ""}. If it is that branch's proposal, run ${recordAuthors}.`;
  }
  if (
    source.remote !== null &&
    !(source.remote === pushed.remote && source.remoteBranch === pushed.name)
  ) {
    return `Proposal ${proposalId} is recorded from ${source.remote}/${source.remoteBranch}, but ${branch} is pushed as ${pushed.remote}/${pushed.name}.`;
  }
  const ledger = readReviewLedger(lease.commonGitDirectory);
  const record =
    ledger.state === "valid" &&
    Object.hasOwn(ledger.ledger.proposals, proposalId)
      ? ledger.ledger.proposals[proposalId]
      : undefined;
  const recorded = record ? latestRecordedHead(record) : null;
  if (!(record && recorded === headSha)) {
    return `Proposal ${proposalId} is recorded at ${recorded ?? "no head"} in the review ledger, not at the queued head ${headSha} of ${branch}. Run ${recordAuthors}.`;
  }
  const base = record.heads[recorded]?.base;
  return base &&
    targetContainsRevision(lease.primaryCheckout, context.targetRevision, base)
    ? null
    : `Proposal ${proposalId} is recorded against a base that ${lease.targetRef} does not contain, so it is not a proposal into this run's target. Run ${recordAuthors}.`;
};

/** Every recorded proposal that binds to this pushed branch. */
const boundProposals = (context: QueuedContext, unit: PushedUnit): string[] =>
  readProposalSources(context.lease.commonGitDirectory)
    .filter(
      (source) =>
        source.sourceBranch === unit.branch && source.headSha === unit.headSha
    )
    .map((source) => source.proposalId)
    .filter(
      (proposalId) => proposalMismatch(context, unit, proposalId) === null
    )
    .sort((left, right) => left.localeCompare(right));

/**
 * The proposal state of one pushed branch. A proposal the controller named
 * must bind to the branch. Without a name, the one recorded proposal that
 * binds to it is found; none, or several, keeps the run open with the
 * command that settles it. A remote with nowhere to open one may instead
 * carry the declared reason.
 */
const proposalState = (
  context: QueuedContext,
  unit: PushedUnit
):
  | { blocker: string }
  | { proposalId: string | null; withoutProposal: string | null } => {
  const { branch, headSha, pushed } = unit;
  const again = "then resume and finalize again";
  const named = context.declared.proposals.get(branch);
  if (named) {
    const mismatch = proposalMismatch(context, unit, named);
    return mismatch
      ? { blocker: `${mismatch} Nothing was removed; ${again}.` }
      : { proposalId: named, withoutProposal: null };
  }
  const bound = boundProposals(context, unit);
  const [only] = bound;
  if (bound.length === 1 && only) {
    return { proposalId: only, withoutProposal: null };
  }
  if (bound.length > 1) {
    return {
      blocker: `${bound.length} proposals are recorded from queued branch ${branch} at ${headSha} (${bound.join(", ")}). Name the one that carries it: resume and finalize again with \`--queued-proposal ${branch}=<id>\`.`,
    };
  }
  const record = `No proposal is recorded from queued branch ${branch} at ${headSha}. Open its proposal, run \`simple-changes proposal record-authors --proposal <id> --base ${context.lease.targetRevision} --head ${headSha} --source-branch ${branch}\`, ${again}`;
  const forge = proposalForge(context, pushed.remote);
  if (forge) {
    return {
      blocker: `${record}. ${forge} can open proposals, so \`--no-proposal\` does not apply to ${pushed.remote}.`,
    };
  }
  if (context.declared.noProposal) {
    return { proposalId: null, withoutProposal: context.declared.noProposal };
  }
  return {
    blocker: `${record}; or, only when ${pushed.remote} has nowhere to open one, finalize with \`--no-proposal "<why>"\` so the receipt reports the branch as pushed without a proposal.`,
  };
};

type Verdict = { blocker: string } | { unit: QueuedUnit } | null;

/**
 * Reads one registered branch at its head: null when the target already
 * contains it, so there is nothing to queue, a queued unit when its exact
 * head is on the remote with its proposal state settled, or a blocker.
 */
const branchVerdict = (
  context: QueuedContext,
  branch: BranchInventory,
  worktree: string | null
): Verdict => {
  const headSha = branch.sha;
  const { lease, targetRevision } = context;
  if (targetContainsRevision(lease.primaryCheckout, targetRevision, headSha)) {
    return null;
  }
  const pushed = pushedBranch(context, branch, headSha);
  if ("blocker" in pushed) {
    return pushed;
  }
  const moved = movedTargetBlocker(context, branch.name, headSha);
  if (moved) {
    return { blocker: moved };
  }
  const proposal = proposalState(context, {
    branch: branch.name,
    headSha,
    pushed,
  });
  if ("blocker" in proposal) {
    return proposal;
  }
  return {
    unit: {
      branch: branch.name,
      headSha,
      proposalId: proposal.proposalId,
      remote: pushed.remote,
      remoteBranch: pushed.name,
      withoutProposal: proposal.withoutProposal,
      worktree,
    },
  };
};

/**
 * Why a checkout with clean status still differs from its commit, or null.
 * Status skips a path marked assume-unchanged or skip-worktree, so every
 * file is compared with the head itself; a comparison that cannot be read
 * proves nothing and blocks.
 */
const hiddenChanges = (worktree: WorktreeInventory): string | null => {
  if (!worktree.headSha) {
    return `Queued worktree ${worktree.path} has no commit to check.`;
  }
  const delta = sourceWorktreeDelta(worktree.path, worktree.headSha, (path) =>
    worktreeSourceEntry(worktree.path, path)
  );
  if ("failure" in delta) {
    return `Queued worktree ${worktree.path} could not be compared with its commit (${delta.failure}), so its work is not proven committed. Nothing in it was removed.`;
  }
  return delta.entries.size > 0
    ? `Queued worktree ${worktree.path} holds changes Git's status does not show (${[...delta.entries.keys()].slice(0, 5).join(", ")}). Commit and push them, or restore those files; nothing in it was removed.`
    : null;
};

/** A live run-created checkout: it must be clean and on its exact branch. */
const liveVerdict = (
  context: QueuedContext,
  worktree: WorktreeInventory
): Verdict => {
  if (worktree.prunable) {
    return {
      blocker: `Run-created worktree ${worktree.path} has no directory any more, so its work cannot be checked. Restore it, or prune its record with Git, before closing.`,
    };
  }
  if (worktree.changes.length > 0) {
    return {
      blocker: `Queued worktree ${worktree.path} has uncommitted changes. Commit and push them, or keep them and pause for the user; nothing in it was removed.`,
    };
  }
  const hidden = hiddenChanges(worktree);
  if (hidden) {
    return { blocker: hidden };
  }
  const branch = context.inventory.branches.find(
    (item) =>
      item.worktreePath === worktree.path && item.sha === worktree.headSha
  );
  if (!(branch && worktree.branch) || isLossyName(worktree.branch)) {
    return {
      blocker: `Queued worktree ${worktree.path} is not on a branch whose pushed copy can be named exactly, so its commits cannot be proven pushed.`,
    };
  }
  return branchVerdict(context, branch, worktree.path);
};

/**
 * A registered author whose checkout is gone. Its branch outlives the
 * checkout, so commits made there still count: the branch is read exactly
 * as a live one is. With the branch gone too, nothing can be checked.
 */
const absentVerdict = (
  context: QueuedContext,
  registered: LoopWorktreeLease
): Verdict => {
  if (retirementForRegistration(context.lease, registered)) {
    return null;
  }
  const branch = context.inventory.branches.find(
    (item) => item.name === registered.branch
  );
  if (!branch || isLossyName(branch.name)) {
    return {
      blocker: `Run-created worktree ${registered.path} is gone and its branch ${registered.branch ?? "(none)"} cannot be read, so commits made there cannot be checked. Restore the branch before closing.`,
    };
  }
  if (branch.worktreePath !== null) {
    return {
      blocker: `Run-created worktree ${registered.path} is gone, and its branch ${branch.name} is checked out in ${branch.worktreePath}, which this run did not create. Settle that checkout before closing.`,
    };
  }
  return branchVerdict(context, branch, null);
};

/**
 * Reads every author registration of a Queue or Sweep run, live checkout or
 * not, as queued work: its exact head on the remote with its proposal state
 * settled, or contained in the target and so nothing to queue. Anything
 * else is a blocker. Nothing here changes the repository, and an
 * unresolved target is a blocker, never an empty result.
 */
export const assessQueuedWork = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  declared: QueuedDeclarations
): QueuedAssessment => {
  const assessment: QueuedAssessment = {
    blockers: [],
    keptWorktrees: [],
    units: [],
  };
  // Resolved once for every check below; a failed lookup is a blocker, so
  // it can never read as a run that queued nothing.
  const targetRevision = resolvedCurrentTargetRevision(lease);
  if (!targetRevision) {
    assessment.blockers.push(
      `Target ${lease.targetRef} could not be resolved, so no queued work was checked. Refresh it, then resume and finalize again.`
    );
    return assessment;
  }
  const context: QueuedContext = {
    declared,
    inventory,
    lease,
    remote: inventory.repository.targetRemote,
    targetBranch: targetBranchForRef(lease.primaryCheckout, lease.targetRef),
    targetRevision,
  };
  const branches = new Set<string | null>();
  for (const registered of lease.worktrees) {
    if (!registered.createdByRun) {
      continue;
    }
    const worktree = inventory.worktrees.find(
      (item) => item.path === registered.path
    );
    if (worktree) {
      assessment.keptWorktrees.push(worktree.path);
    }
    branches.add(worktree ? worktree.branch : registered.branch);
    const verdict = worktree
      ? liveVerdict(context, worktree)
      : absentVerdict(context, registered);
    if (verdict && "blocker" in verdict) {
      assessment.blockers.push(verdict.blocker);
    } else if (verdict) {
      assessment.units.push(verdict.unit);
    }
  }
  for (const branch of declared.proposals.keys()) {
    if (!branches.has(branch)) {
      assessment.blockers.push(
        `\`--queued-proposal\` names ${branch}, which is not a branch this run created. Name each branch exactly as the run registered it.`
      );
    }
  }
  return assessment;
};

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "es"}`;

/** One plain sentence set for the receipt and the command's own output. */
export const queuedSummary = (
  lease: LoopLease,
  assessment: QueuedAssessment
): string => {
  const { keptWorktrees, units } = assessment;
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
  const kept =
    keptWorktrees.length === 0
      ? ""
      : ` The run's ${keptWorktrees.length === 1 ? "worktree was" : "worktrees were"} kept for now: ${keptWorktrees.join(", ")}. A later Queue or Sweep run moves a kept worktree to the Trash by itself once the remote confirms its work is merged and nothing in it is unsaved.`;
  return `Queued for review, not merged: ${counts}. Nothing was added to ${lease.targetRef}, and finalization deleted no checkout, branch, or file. Uncommitted work in the primary checkout was left exactly as it was.${kept}`;
};
