import { randomUUID } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { targetContainsRevision } from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { completeLine } from "./git-complete.ts";
import { ensureStateDirectory } from "./git-location.ts";
import { isLossyName } from "./inventory.ts";
import {
  resolvedCurrentTargetRevision,
  retirementForRegistration,
  STATE_DIRECTORY,
  targetBranchForRef,
} from "./loop-lease-core.ts";
import { runGit, runGitRemote } from "./process.ts";
import { redactSecrets } from "./redact.ts";
import {
  isProposalId,
  latestRecordedHead,
  readReviewLedger,
} from "./review-ledger.ts";
import { validateSchema } from "./schema.ts";
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

/**
 * A run-created checkout finalization kept, with the reason a later
 * clean-up will still leave it when there already is one: files in it that
 * Git ignores, which exist nowhere else.
 */
export interface KeptQueuedWorktree {
  note: string | null;
  path: string;
}

export interface QueuedAssessment {
  blockers: string[];
  /** Every live run-created checkout. Finalization keeps them all. */
  keptWorktrees: KeptQueuedWorktree[];
  units: QueuedUnit[];
}

const MAX_NAMED_FILES = 5;

/** Every directory that holds a tracked path. */
const trackedDirectories = (tracked: ReadonlySet<string>): Set<string> => {
  const directories = new Set<string>();
  for (const path of tracked) {
    for (
      let end = path.lastIndexOf("/");
      end > 0 && !directories.has(path.slice(0, end));
      end = path.lastIndexOf("/", end - 1)
    ) {
      directories.add(path.slice(0, end));
    }
  }
  return directories;
};

interface TrackedShape {
  directories: ReadonlySet<string>;
  root: string;
  tracked: ReadonlySet<string>;
}

// Adds what `relative` holds beyond the tracked shape, up to five names. A
// directory with no tracked path under it is named and not descended into.
const collectExtras = (
  shape: TrackedShape,
  relative: string,
  extras: string[]
): void => {
  const entries = readdirSync(resolve(shape.root, relative), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (extras.length >= MAX_NAMED_FILES) {
      return;
    }
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (path === ".git" || shape.tracked.has(path)) {
      continue;
    }
    if (entry.isDirectory() && shape.directories.has(path)) {
      collectExtras(shape, path, extras);
    } else {
      extras.push(entry.isDirectory() ? `${path}/` : path);
    }
  }
};

/**
 * Up to five entries on disk in a checkout that its head does not track,
 * which in a checkout with clean status are files Git ignores. The disk is
 * walked and compared with the head's own file list, so a list Git lost or
 * cut short shows more extra files, never fewer. Null when either side
 * cannot be read.
 */
export const filesBeyondHead = (
  worktreePath: string,
  headSha: string
): string[] | null => {
  const listed = runGit(
    worktreePath,
    ["ls-tree", "-r", "-z", "--name-only", headSha],
    true
  );
  const tracked = new Set(listed.stdout.split("\0").filter(Boolean));
  if (listed.exitCode !== 0 || tracked.size === 0) {
    return null;
  }
  const extras: string[] = [];
  try {
    collectExtras(
      { directories: trackedDirectories(tracked), root: worktreePath, tracked },
      "",
      extras
    );
  } catch {
    return null;
  }
  return extras;
};

/** What to tell the owner about a kept checkout that holds ignored files. */
export const ignoredFilesNote = (
  path: string,
  names: readonly string[]
): string =>
  `This copy holds files Git ignores (${names.join(", ")}), so I left it in place. Remove it by hand, or with computer use, once you have what you need from them: ${path}`;

const keptWorktree = (worktree: WorktreeInventory): KeptQueuedWorktree => {
  const extras =
    worktree.headSha && worktree.changes.length === 0 && !worktree.prunable
      ? filesBeyondHead(worktree.path, worktree.headSha)
      : null;
  return {
    note: extras?.length ? ignoredFilesNote(worktree.path, extras) : null,
    path: worktree.path,
  };
};

/** What the controller told `loop finalize` about its pushed branches. */
export interface QueuedDeclarations {
  /** `--no-proposal`: why no proposal can be opened; null when not given. */
  noProposal: string | null;
  /** `--queued-proposal <branch>=<id>`: the proposal each branch is in. */
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

type RemoteHead =
  | { head: string | null; state: "answered" }
  | { detail: string; state: "unanswered" };

const LS_REMOTE_LINE = /^([0-9a-f]{40,64})\t(.+)$/u;

/**
 * The head of exactly `refs/heads/<branch>` at the remote's push
 * destination, asked of the remote itself: a remote-tracking ref can still
 * name a commit the server has since deleted or rewritten. The answer
 * counts only when it arrived whole. Absence is `ls-remote --exit-code`
 * exiting 2 with no output, which a lost answer cannot fake; anything else
 * is no answer.
 */
const remoteBranchHead = (
  repositoryPath: string,
  remote: string,
  branch: string
): RemoteHead => {
  const ref = `refs/heads/${branch}`;
  let destination: string | null;
  try {
    // One whole line: a remote with several push URLs has no single
    // destination to ask, and is refused below as no answer.
    destination = completeLine(repositoryPath, [
      "remote",
      "get-url",
      "--push",
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

interface PushDestination {
  name: string;
  remote: string;
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
 * Why the proposal the controller named for this branch does not bind to
 * it, or null when it does. The name ties the proposal to this source
 * branch and to no other; the review ledger must record that proposal's
 * latest head as exactly the queued head, never an ancestor or descendant,
 * with a base the run's target contains.
 */
const proposalMismatch = (
  context: QueuedContext,
  branch: string,
  headSha: string,
  proposalId: string
): string | null => {
  const { declared, lease } = context;
  const shared = [...declared.proposals].find(
    ([other, id]) => id === proposalId && other !== branch
  )?.[0];
  if (shared) {
    return `Proposal ${proposalId} is named for both ${branch} and ${shared}; one proposal carries one branch.`;
  }
  const ledger = readReviewLedger(lease.commonGitDirectory);
  const record =
    ledger.state === "valid" &&
    Object.hasOwn(ledger.ledger.proposals, proposalId)
      ? ledger.ledger.proposals[proposalId]
      : undefined;
  const recorded = record ? latestRecordedHead(record) : null;
  const recordAuthors = `\`simple-changes proposal record-authors --proposal ${proposalId} --base ${lease.targetRevision} --head ${headSha}\``;
  if (!(record && recorded)) {
    return `Proposal ${proposalId} has no recorded head in the review ledger. Run ${recordAuthors}.`;
  }
  if (recorded !== headSha) {
    return `Proposal ${proposalId} is recorded at ${recorded}, not at the queued head ${headSha} of ${branch}. Run ${recordAuthors}.`;
  }
  const base = record.heads[recorded]?.base;
  return base &&
    targetContainsRevision(lease.primaryCheckout, context.targetRevision, base)
    ? null
    : `Proposal ${proposalId} is recorded against a base that ${lease.targetRef} does not contain, so it is not a proposal into this run's target. Run ${recordAuthors}.`;
};

/**
 * The proposal state of one pushed branch: the proposal bound to it, the
 * declared reason it has none, or why neither holds.
 */
const proposalState = (
  context: QueuedContext,
  branch: string,
  headSha: string,
  pushedRemote: string
):
  | { blocker: string }
  | { proposalId: string | null; withoutProposal: string | null } => {
  const again = "then resume and finalize again";
  const proposalId = context.declared.proposals.get(branch);
  if (proposalId) {
    const mismatch = proposalMismatch(context, branch, headSha, proposalId);
    return mismatch
      ? { blocker: `${mismatch} Nothing was removed; ${again}.` }
      : { proposalId, withoutProposal: null };
  }
  const name = `No proposal is named for queued branch ${branch} at ${headSha}. Open its proposal, run \`simple-changes proposal record-authors --proposal <id> --base ${context.lease.targetRevision} --head ${headSha}\`, ${again} with \`--queued-proposal ${branch}=<id>\``;
  const forge = proposalForge(context, pushedRemote);
  if (forge) {
    return {
      blocker: `${name}. ${forge} can open proposals, so \`--no-proposal\` does not apply to ${pushedRemote}.`,
    };
  }
  if (context.declared.noProposal) {
    return { proposalId: null, withoutProposal: context.declared.noProposal };
  }
  return {
    blocker: `${name}; or, only when ${pushedRemote} has nowhere to open one, finalize with \`--no-proposal "<why>"\` so the receipt reports the branch as pushed without a proposal.`,
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
  const proposal = proposalState(context, branch.name, headSha, pushed.remote);
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
      assessment.keptWorktrees.push(keptWorktree(worktree));
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
      : ` The run's ${keptWorktrees.length === 1 ? "worktree was" : `${keptWorktrees.length} worktrees were`} kept. The next Queue or Sweep run removes one once its work is merged and nothing in it exists only there; or remove one yourself with \`git worktree remove <path>\`, which refuses a checkout that holds changes. Its branch keeps the work.`;
  return `Queued for review, not merged: ${counts}. Nothing was added to ${lease.targetRef}, and finalization deleted no checkout, branch, or file. Uncommitted work in the primary checkout was left exactly as it was.${kept}`;
};

// ---------------------------------------------------------------------------
// The worktrees a closed Queue or Sweep run kept

/**
 * The record a closed Queue or Sweep run leaves beside the loop state, in
 * its own file so older runtimes never meet it: the worktrees it created
 * and kept, each with its branch. A later Queue or Sweep start reads it to
 * know which checkouts it may clean up once their work is in the target;
 * it proves nothing by itself.
 */
export interface QueuedWorktreesRecord {
  closedAt: string;
  kind: "queued-worktrees";
  mode: "queue" | "sweep";
  runId: string;
  schemaVersion: 1;
  worktrees: { branch: string; path: string }[];
}

const queuedWorktreesDirectory = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY, "queued-worktrees");

/** Writes the record, or deletes it once no worktree is left in it. */
export const writeQueuedWorktreesRecord = (
  commonGitDirectory: string,
  record: QueuedWorktreesRecord
): void => {
  const path = resolve(
    queuedWorktreesDirectory(commonGitDirectory),
    `${record.runId}.json`
  );
  if (record.worktrees.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const validated = validateSchema<QueuedWorktreesRecord>(
    "queued-worktrees",
    record
  );
  ensureStateDirectory(
    commonGitDirectory,
    queuedWorktreesDirectory(commonGitDirectory)
  );
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
};

/** The kept worktrees of a run that just closed, on their exact branches. */
export const keptQueuedWorktreesRecord = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  assessment: QueuedAssessment,
  closedAt: string
): QueuedWorktreesRecord => ({
  closedAt,
  kind: "queued-worktrees",
  mode: lease.mode === "sweep" ? "sweep" : "queue",
  runId: lease.runId,
  schemaVersion: 1,
  worktrees: assessment.keptWorktrees.flatMap(({ path }) => {
    const branch = inventory.worktrees.find(
      (worktree) => worktree.path === path
    )?.branch;
    return branch && !isLossyName(branch) ? [{ branch, path }] : [];
  }),
});

// A record that is missing, unreadable, or not this shape is skipped: it
// only ever allows a clean-up, so skipping it keeps its worktrees.
export const readQueuedWorktreesRecords = (
  commonGitDirectory: string
): QueuedWorktreesRecord[] => {
  const directory = queuedWorktreesDirectory(commonGitDirectory);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const records: QueuedWorktreesRecord[] = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    try {
      const record = validateSchema<QueuedWorktreesRecord>(
        "queued-worktrees",
        JSON.parse(readFileSync(resolve(directory, name), "utf8")) as unknown
      );
      if (name === `${record.runId}.json`) {
        records.push(record);
      }
    } catch {
      // Skipped, as above.
    }
  }
  return records;
};
