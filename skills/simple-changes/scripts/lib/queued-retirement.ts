import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { targetContainsRevision } from "./cleanup-core.ts";
import { proveExactByteTargetContainment } from "./exact-byte-proof.ts";
import {
  completeLine,
  completeListing,
  completeObjectId,
} from "./git-complete.ts";
import { nothingAtPath } from "./loop-lease-core.ts";
import { liveClaimFor } from "./loop-lease-verify.ts";
import {
  runGit,
  runGitRemote,
  runGitWithInput,
  withGitDeadline,
} from "./process.ts";
import { askRemoteRef, type RemoteHead } from "./queued-completion.ts";
import { moveToTrash, type TrashMover } from "./queued-trash.ts";
import {
  type KeptQueuedWorktree,
  privateGitDirectory,
  type QueuedTargetBinding,
  type QueuedWorktreesRecord,
  readQueuedWorktreesRecords,
  readRegistrationId,
  safeTargetAddress,
  singleFetchUrl,
  type TrashedQueuedWorktree,
  writeQueuedWorktreesRecord,
} from "./queued-worktrees.ts";
import { redactSecrets } from "./redact.ts";
import { namedObjectsOf } from "./replacement-lineage.ts";
import type { RepositoryInventory, WorktreeInventory } from "./types.ts";
import {
  assertNoGitOperation,
  readCoordinationDocumentFromCommonDirectory,
} from "./worktree-coordination.ts";

/**
 * How the remote's own target was shown to contain a worktree's work:
 * its head is an ancestor of the target, or every path its commits touched
 * has exactly the same bytes and mode in the target (a squash merge). Never
 * patch IDs, which ignore whitespace.
 */
export type QueuedRetirementProof = "exact-byte-target" | "target-contained";

/** One kept worktree a start moved to the Trash. Its branch was kept. */
export interface QueuedRetirementMove {
  branch: string;
  headSha: string;
  /**
   * Where the folder is now, confirmed to be the same folder, or null when
   * its place in the Trash could not be confirmed.
   */
  location: string | null;
  /** Where the folder was. */
  path: string;
  proof: QueuedRetirementProof;
  /** See `TrashedQueuedWorktree.registration`. */
  registration: TrashedQueuedWorktree["registration"];
  /** How to put it back, in plain words, with the exact paths. */
  restore: string;
  /** The remote ref that was asked, and the commit it answered with. */
  target: { ref: string; revision: string; url: string };
  trashedAt: string;
}

/** What a Queue or Sweep start did with earlier runs' kept worktrees. */
export interface QueuedRetirementReport {
  /** Merged worktrees left in place, each with one plain reason. */
  kept: { path: string; reason: string }[];
  /** Merged worktrees moved to the Trash. Nothing was deleted. */
  movedToTrash: QueuedRetirementMove[];
  /** Why something could not be checked. Never a failure of the start. */
  notes: string[];
}

export interface QueuedRetirementHooks {
  /**
   * Called with a worktree's path once it has passed every earlier check,
   * just before its last checks run. Tests use it to change a checkout
   * that was already checked.
   */
  beforeLastChecks?: (path: string) => void;
  /** Stands in for the Trash. Without it, `systemTrashMover` is used. */
  moveToTrash?: TrashMover;
  /** The current time, for tests of how long a move is remembered. */
  now?: () => Date;
}

type Candidate = WorktreeInventory & { headSha: string };

interface Evidence {
  proof: QueuedRetirementProof;
  revision: string;
}

interface RetirementContext {
  /** This start's one answer for each target it asked. */
  answers: Map<string, RemoteHead>;
  /** Registration IDs whose worktree is gone or is another registration. */
  forgotten: Set<string>;
  hooks: QueuedRetirementHooks;
  inventory: RepositoryInventory;
  /** Whether Git can be kept from downloading on its own; asked once. */
  lazyFetchOff?: boolean;
  report: QueuedRetirementReport;
}

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const HEAD_REF_PREFIX = "refs/heads/";
/**
 * The folder, inside a moved worktree, that holds the private Git directory
 * the worktree had (`<common>/worktrees/<name>`): its index, its own HEAD
 * log, and any ref it kept for itself.
 */
export const MOVED_GIT_DIRECTORY = ".simple-changes-git-worktree";
// A record of a move is kept this long, the time macOS itself keeps an item
// in the Trash when it is set to empty it automatically.
const REMEMBER_MOVED_DAYS = 30;
const DAY_MS = 86_400_000;
// What a multi-step Git operation leaves in a worktree's private directory
// while it is unfinished, beyond the markers `assertNoGitOperation` reads.
const UNFINISHED_OPERATION_MARKERS = [
  "sequencer",
  "NOTES_MERGE_WORKTREE",
  "NOTES_MERGE_PARTIAL",
  "NOTES_MERGE_REF",
];
// A partial clone downloads objects when a command first reads them.
const PARTIAL_CLONE_KEYS =
  "^(extensions\\.partialclone|remote\\..*\\.promisor)$";
const GIT_VERSION_PATTERN = /^git version (\d+)\.(\d+)/u;
const NO_LAZY_FETCH_MAJOR = 2;
const NO_LAZY_FETCH_MINOR = 45;
/**
 * Set for every Git command this module starts. Nothing here may download
 * on its own: only the two bounded remote commands reach the network, so
 * the start's locks are never held on a download no one bounded. And a
 * replacement object must not stand in for real history in a proof.
 */
const RETIREMENT_GIT_ENVIRONMENT = {
  GIT_GRAFT_FILE: devNull,
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
};
const STATUS_HEAD_PREFIX = "# branch.oid ";
const STATUS_BRANCH_PREFIX = "# branch.head ";
const WHITESPACE_RUN = /\s+/gu;

const left = (path: string): string => `so I left it in place: ${path}`;

// Git's own words on one line, for a sentence a person reads.
const oneLine = (detail: string): string =>
  redactSecrets(detail.replace(WHITESPACE_RUN, " ").trim());

const message = (error: unknown): string =>
  oneLine(error instanceof Error ? error.message : String(error));

const withEnvironment = <T>(
  values: Record<string, string>,
  operation: () => T
): T => {
  const previous = new Map(
    Object.keys(values).map((name) => [name, process.env[name]])
  );
  Object.assign(process.env, values);
  try {
    return operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }
};

/**
 * Whether no local read can turn into a download. Outside a partial clone
 * none can. In one, `GIT_NO_LAZY_FETCH` stops them from Git 2.45 on; an
 * older Git ignores it, and anything unreadable counts as "cannot tell".
 */
const lazyFetchStaysOff = (primaryCheckout: string): boolean => {
  try {
    const partial = runGit(
      primaryCheckout,
      ["config", "--get-regexp", PARTIAL_CLONE_KEYS],
      true
    );
    if (partial.exitCode !== 0) {
      // Exit 1 is Git's "no such key": an ordinary, complete clone.
      return partial.exitCode === 1;
    }
    const [, major, minor] =
      GIT_VERSION_PATTERN.exec(runGit(primaryCheckout, ["version"]).stdout) ??
      [];
    const version = [Number(major), Number(minor)] as const;
    return (
      version[0] > NO_LAZY_FETCH_MAJOR ||
      (version[0] === NO_LAZY_FETCH_MAJOR && version[1] >= NO_LAZY_FETCH_MINOR)
    );
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// The target, asked of its own remote

/**
 * The address to ask about a recorded target, or null when the recorded
 * address is not in the safe form the record requires. The recorded address
 * has no credential, so the remote of that name is asked through its own
 * address while that still is the recorded one; otherwise the recorded
 * address is asked directly. No other remote is ever asked. A safe address
 * is a URL, an `[user@]host:path`, or an absolute path, so Git can never
 * read it as an option or as the name of a configured remote.
 */
const targetDestination = (
  primaryCheckout: string,
  target: QueuedTargetBinding
): string | null => {
  if (safeTargetAddress(target.url) !== target.url) {
    return null;
  }
  const configured = singleFetchUrl(primaryCheckout, target.remote);
  const operand =
    configured && safeTargetAddress(configured) === target.url
      ? configured
      : target.url;
  try {
    const effective = completeLine(primaryCheckout, [
      "ls-remote",
      "--get-url",
      "--",
      operand,
    ]).line;
    return effective === operand ? operand : null;
  } catch {
    // Git diagnostics can repeat an operand containing credentials.
    return null;
  }
};

const haveCommit = (primaryCheckout: string, revision: string): boolean => {
  try {
    return (
      completeObjectId(primaryCheckout, `${revision}^{commit}`) === revision
    );
  } catch {
    return false;
  }
};

/**
 * Downloads the recorded target's commits from its recorded address when
 * the commit the remote answered with is not on this machine yet, which is
 * the usual case: a run starts before it refreshes its target. Only objects
 * arrive. The empty `--refmap=` stops Git from moving any remote-tracking
 * ref, `FETCH_HEAD` is not written, and no tag, submodule, or maintenance
 * step follows, so the run's baseline is the same with or without it. The
 * command is bounded like every remote command. Returns why the commit is
 * still missing, or null.
 */
const fetchTargetCommit = (
  primaryCheckout: string,
  destination: string,
  ref: string,
  revision: string
): string | null => {
  if (haveCommit(primaryCheckout, revision)) {
    return null;
  }
  const fetched = runGitRemote(primaryCheckout, [
    "fetch",
    "--quiet",
    "--refmap=",
    "--no-tags",
    "--no-write-fetch-head",
    "--no-recurse-submodules",
    "--no-auto-maintenance",
    destination,
    ref,
  ]);
  // The target may have moved on between the answer and the download; a
  // commit that did not arrive is simply not proven this time.
  return fetched.exitCode === 0
    ? null
    : fetched.stderr.trim() || `git fetch exited ${fetched.exitCode}`;
};

/**
 * This start's one question to a recorded target: the remote's answer, with
 * its commit brought here if it is missing. A remote that gives no answer
 * or no commits is noted once, and keeps every worktree bound to it. The
 * address that was asked may hold a credential, so it never reaches a note.
 */
const askTarget = (
  context: RetirementContext,
  target: QueuedTargetBinding
): RemoteHead => {
  const { primaryCheckout } = context.inventory.repository;
  const destination = targetDestination(primaryCheckout, target);
  const answer: RemoteHead = destination
    ? askRemoteRef(primaryCheckout, destination, target.ref)
    : { detail: "its address cannot be asked", state: "unanswered" };
  let failure: string | null = null;
  if (answer.state === "unanswered") {
    failure = answer.detail;
  } else if (answer.head && destination) {
    failure = fetchTargetCommit(
      primaryCheckout,
      destination,
      target.ref,
      answer.head
    );
  }
  if (failure) {
    const label =
      safeTargetAddress(target.url) === target.url
        ? target.url
        : "the recorded target";
    context.report.notes.push(
      `I could not ask ${label} what has been merged, so earlier copies that wait on it were left in place.`
    );
    return { detail: "remote unavailable", state: "unanswered" };
  }
  return answer;
};

/**
 * Proves the remote's target commit contains the worktree's head: by
 * ancestry, or by `proveExactByteTargetContainment` over a nonempty set of
 * touched paths. Null when neither holds, the target commit is not on this
 * machine yet, or Git could not answer.
 */
const containmentProof = (
  primaryCheckout: string,
  headSha: string,
  targetRevision: string
): QueuedRetirementProof | null => {
  try {
    if (!haveCommit(primaryCheckout, targetRevision)) {
      return null;
    }
    if (targetContainsRevision(primaryCheckout, targetRevision, headSha)) {
      return "target-contained";
    }
    const proof = proveExactByteTargetContainment(primaryCheckout, {
      sourceHead: headSha,
      targetRevision,
    });
    return proof.status === "proven" && proof.touchedPaths.length > 0
      ? "exact-byte-target"
      : null;
  } catch {
    return null;
  }
};

const targetKey = (target: QueuedTargetBinding): string =>
  `${target.url}\n${target.ref}`;

/**
 * Whether the remote's target contains this worktree's head, by the one
 * answer this start asked that target for. An unanswered remote keeps every
 * worktree bound to it.
 */
const mergedEvidence = (
  context: RetirementContext,
  recorded: KeptQueuedWorktree,
  worktree: Candidate
): Evidence | null => {
  const key = targetKey(recorded.target);
  const answer =
    context.answers.get(key) ?? askTarget(context, recorded.target);
  context.answers.set(key, answer);
  if (answer.state === "unanswered" || !answer.head) {
    return null;
  }
  const proof = containmentProof(
    context.inventory.repository.primaryCheckout,
    worktree.headSha,
    answer.head
  );
  return proof ? { proof, revision: answer.head } : null;
};

// ---------------------------------------------------------------------------
// What keeps a merged worktree where it is

/**
 * Why Git's own fresh look at the checkout does not show the recorded
 * branch at the proven commit with nothing unsaved, or null. One `status`
 * call answers all three, and always prints its branch lines, so an answer
 * lost on its way here reads as "could not check", never as clean.
 * Untracked files count; files Git ignores do not.
 */
const unsavedOrChanged = (
  worktree: Candidate,
  branch: string
): string | null => {
  const changed = `This copy changed while I was checking it, ${left(worktree.path)}`;
  let entries: string[];
  try {
    const status = completeListing(
      worktree.path,
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      "\0"
    );
    if (status.exitCode !== 0 || status.stdout === "") {
      return `I could not check this copy for unsaved work, ${left(worktree.path)}`;
    }
    entries = status.stdout.split("\0").filter(Boolean);
  } catch {
    return `I could not check this copy for unsaved work, ${left(worktree.path)}`;
  }
  if (
    !(
      entries.includes(`${STATUS_HEAD_PREFIX}${worktree.headSha}`) &&
      entries.includes(`${STATUS_BRANCH_PREFIX}${branch}`)
    )
  ) {
    return changed;
  }
  return entries.some((entry) => !entry.startsWith("# "))
    ? `This copy has changes that are not saved in a commit, ${left(worktree.path)}`
    : null;
};

/**
 * Whether a Git operation is unfinished in this worktree.
 * `assertNoGitOperation` reads the merge, cherry-pick, revert, bisect, and
 * rebase markers; the rest are checked here, since an interrupted
 * multi-commit cherry-pick or revert, or a notes merge, can sit on a clean
 * head with its remaining steps stored only in the private directory.
 * Anything unreadable counts as unfinished.
 */
const hasUnfinishedOperation = (
  gitDirectory: string,
  worktreePath: string
): boolean => {
  try {
    assertNoGitOperation(worktreePath);
    return UNFINISHED_OPERATION_MARKERS.some(
      (marker) => !nothingAtPath(join(gitDirectory, marker))
    );
  } catch {
    return true;
  }
};

const claimReason = (
  commonGitDirectory: string,
  path: string
): string | null =>
  liveClaimFor(
    readCoordinationDocumentFromCommonDirectory(commonGitDirectory),
    commonGitDirectory,
    path
  )
    ? `Another agent has claimed this copy, ${left(path)}`
    : null;

// Moving a folder moves everything inside it, so a worktree that holds
// another registered worktree, or the repository itself, stays.
const holdsOtherWork = (
  inventory: RepositoryInventory,
  path: string
): boolean => {
  const inside = `${path}${sep}`;
  const live = completeListing(
    inventory.repository.primaryCheckout,
    ["worktree", "list", "--porcelain", "-z"],
    "\0",
    false
  );
  if (!live.stdout.startsWith("worktree ")) {
    return true;
  }
  return (
    live.stdout
      .split("\0")
      .some((field) => field.startsWith(`worktree ${inside}`)) ||
    inventory.repository.commonGitDirectory.startsWith(inside) ||
    inventory.worktrees.some((item) => item.path.startsWith(inside))
  );
};

// ---------------------------------------------------------------------------
// One recorded worktree at a time

type Registration =
  | { gitDirectory: string; state: "same" }
  | { state: "another" | "unknown" };

/**
 * Whether the checkout at the recorded path is the registration the run
 * recorded: the ID in its private Git directory must be the recorded one.
 * Git deletes that directory with the worktree, so a checkout made again at
 * the same path, on the same branch, is another registration.
 */
const registrationOf = (
  commonGitDirectory: string,
  recorded: KeptQueuedWorktree
): Registration => {
  try {
    const gitDirectory = privateGitDirectory(commonGitDirectory, recorded.path);
    if (!gitDirectory) {
      return { state: "unknown" };
    }
    return readRegistrationId(gitDirectory, recorded.path) ===
      recorded.registrationId
      ? { gitDirectory, state: "same" }
      : { state: "another" };
  } catch {
    return { state: "unknown" };
  }
};

/**
 * The recorded worktree as this start's inventory sees it: `forget` when
 * its checkout is gone or is another registration, `wait` when it is not a
 * candidate now (the checkout this command runs in, another branch, or
 * anything unreadable), which is never reported.
 */
const locate = (
  context: RetirementContext,
  recorded: KeptQueuedWorktree
): Candidate | "forget" | "wait" => {
  const { commonGitDirectory, currentCheckout } = context.inventory.repository;
  const worktree = context.inventory.worktrees.find(
    (item) => item.path === recorded.path
  );
  if (!worktree || worktree.prunable || worktree.isPrimary) {
    return "forget";
  }
  const registration = registrationOf(commonGitDirectory, recorded).state;
  if (registration === "another") {
    return "forget";
  }
  if (
    registration === "unknown" ||
    worktree.path === currentCheckout ||
    worktree.branch !== recorded.branch ||
    !worktree.headSha
  ) {
    return "wait";
  }
  return { ...worktree, headSha: worktree.headSha };
};

/**
 * Every check for one worktree, on a fresh read, immediately before it is
 * moved, so nothing rests on an earlier look: the registration, Git's own
 * fresh word on its branch, commit, and unsaved work, the proof run again
 * against that commit, the claim, a lock, an unfinished Git operation, and
 * anything else that lives inside the folder. Returns the reason to keep
 * it, or the private Git directory to take along.
 */
const lastChecks = (
  context: RetirementContext,
  recorded: KeptQueuedWorktree,
  worktree: Candidate,
  evidence: Evidence
): { gitDirectory: string } | { reason: string } => {
  const { commonGitDirectory, primaryCheckout } = context.inventory.repository;
  const { path } = worktree;
  const registration = registrationOf(commonGitDirectory, recorded);
  if (registration.state !== "same") {
    return {
      reason: `This copy changed while I was checking it, ${left(path)}`,
    };
  }
  const { gitDirectory } = registration;
  const proof = containmentProof(
    primaryCheckout,
    worktree.headSha,
    evidence.revision
  );
  if (!proof) {
    return {
      reason: `I could not confirm again that this copy's work is in the project, ${left(path)}`,
    };
  }
  evidence.proof = proof;
  let reason =
    unsavedOrChanged(worktree, recorded.branch) ??
    claimReason(commonGitDirectory, path);
  if (!reason && hasUnfinishedOperation(gitDirectory, path)) {
    reason = `This copy has an unfinished Git operation, ${left(path)}`;
  }
  if (!(reason || nothingAtPath(join(gitDirectory, "locked")))) {
    reason = `This copy is locked, ${left(path)}`;
  }
  if (!reason && holdsOtherWork(context.inventory, path)) {
    reason = `Another copy of the project lives inside this one, ${left(path)}`;
  }
  return reason ? { reason } : { gitDirectory };
};

/** How to put a moved worktree back, in plain words with exact paths. */
export const restoreSteps = (
  path: string,
  trashed: Pick<
    TrashedQueuedWorktree,
    "gitDirectory" | "location" | "registration"
  >
): string => {
  const folder = trashed.location
    ? `move ${trashed.location} back to ${path}`
    : `find the folder named ${basename(path)} in the Trash and move it back to ${path}`;
  return trashed.registration === "moved-with-copy"
    ? `To get it back, ${folder}, then move ${join(path, MOVED_GIT_DIRECTORY)} to ${trashed.gitDirectory} (make the folder that holds it first if it is gone).`
    : `To get it back, ${folder}, then run git worktree unlock from the primary checkout with the restored path as its argument.`;
};

const saveRecord = (
  context: RetirementContext,
  record: QueuedWorktreesRecord
): void => {
  try {
    writeQueuedWorktreesRecord(
      context.inventory.repository.commonGitDirectory,
      record
    );
  } catch (error) {
    context.report.notes.push(
      `I could not update the record of earlier copies (${message(error)}).`
    );
  }
};

/**
 * Takes the worktree's private Git directory along into the moved folder,
 * with one rename. Git then no longer lists a worktree whose folder is
 * missing and no longer counts its branch as checked out, and nothing in
 * that directory (the index, the worktree's own HEAD log, refs it kept for
 * itself) is left for a later `git worktree prune` to delete. Any failure
 * leaves the directory exactly where it was.
 */
const takeGitDirectoryAlong = (
  gitDirectory: string,
  location: string
): boolean => {
  try {
    const destination = join(location, MOVED_GIT_DIRECTORY);
    if (!nothingAtPath(destination)) {
      return false;
    }
    renameSync(gitDirectory, destination);
    return true;
  } catch {
    return false;
  }
};

const pinPrefix = (id: string): string =>
  `refs/simple-changes/queued-trash/${id}/`;

// Git no longer traverses private reflogs once their directory is in the
// Trash. Publish recovery roots in a single ref transaction before moving.
const pinRecoveryObjects = (
  path: string,
  directory: string,
  copy: KeptQueuedWorktree,
  head: string
): void => {
  const named = namedObjectsOf(path, directory, []);
  const objects = new Set([head, ...named.map((item) => item.object)]);
  const common = dirname(dirname(directory));
  const logs = [
    join(directory, "logs/HEAD"),
    join(common, "logs/refs/heads", copy.branch),
    ...named
      .filter((item) => item.name.startsWith("refs/"))
      .map((item) => join(directory, "logs", item.name)),
  ];
  for (const log of logs) {
    if (nothingAtPath(log)) {
      continue;
    }
    for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      const ids = line.split(" ", 2);
      if (ids.length !== 2 || !ids.every((id) => OBJECT_ID_PATTERN.test(id))) {
        throw new Error("Unreadable recovery reflog");
      }
      for (const id of ids) {
        if (id !== "0".repeat(id.length)) {
          objects.add(id);
        }
      }
    }
  }
  const prefix = pinPrefix(copy.registrationId);
  runGitWithInput(
    path,
    ["-c", `core.hooksPath=${devNull}`, "update-ref", "--no-deref", "--stdin"],
    [...objects].map((oid) => `update ${prefix}${oid} ${oid}\n`).join("")
  );
};

const releasePins = (primary: string, id: string): void => {
  const prefix = pinPrefix(id);
  const refs = completeListing(
    primary,
    ["for-each-ref", "--format=%(refname)", prefix],
    "\n",
    false
  );
  const deletes = refs.stdout
    .split("\n")
    .filter(Boolean)
    .map((ref) => {
      const oid = ref.slice(prefix.length);
      if (!(ref.startsWith(prefix) && OBJECT_ID_PATTERN.test(oid))) {
        throw new Error("Unexpected recovery ref");
      }
      return `delete ${ref} ${oid}\n`;
    });
  if (deletes.length) {
    runGitWithInput(
      primary,
      [
        "-c",
        `core.hooksPath=${devNull}`,
        "update-ref",
        "--no-deref",
        "--stdin",
      ],
      deletes.join("")
    );
  }
};

/**
 * Moves one merged worktree to the Trash. Nothing changes before the folder
 * is confirmed gone from its path; a folder that did not move is reported
 * kept, exactly as it was. Each step that did happen is written to the
 * report and the record before the next one starts, so a later failure
 * cannot hide it. The branch is never deleted.
 */
const moveMerged = (
  context: RetirementContext,
  record: QueuedWorktreesRecord,
  recorded: KeptQueuedWorktree,
  worktree: Candidate,
  evidence: Evidence
): void => {
  const { report } = context;
  const { path } = worktree;
  context.hooks.beforeLastChecks?.(path);
  const checked = lastChecks(context, recorded, worktree, evidence);
  if ("reason" in checked) {
    report.kept.push({ path, reason: checked.reason });
    return;
  }
  pinRecoveryObjects(path, checked.gitDirectory, recorded, worktree.headSha);
  // Protect the index and private refs even if the process stops after
  // Trash takes the folder, or macOS conceals its destination.
  const lock = join(checked.gitDirectory, "locked");
  writeFileSync(lock, "Simple Changes Trash recovery\n", { flag: "wx" });
  const result = moveToTrash(path, context.hooks.moveToTrash);
  if (result.state === "kept") {
    unlinkSync(lock);
    releasePins(path, recorded.registrationId);
    report.kept.push({
      path,
      reason: `I could not move this copy to the Trash (${oneLine(result.reason)}), ${left(path)}`,
    });
    return;
  }
  const trashed: TrashedQueuedWorktree = {
    at: (context.hooks.now?.() ?? new Date()).toISOString(),
    gitDirectory: checked.gitDirectory,
    headSha: worktree.headSha,
    location: result.location,
    registration: "left-in-git",
  };
  const move: QueuedRetirementMove = {
    branch: recorded.branch,
    headSha: worktree.headSha,
    location: trashed.location,
    path,
    proof: evidence.proof,
    registration: trashed.registration,
    restore: restoreSteps(path, trashed),
    target: {
      ref: recorded.target.ref,
      revision: evidence.revision,
      url: recorded.target.url,
    },
    trashedAt: trashed.at,
  };
  report.movedToTrash.push(move);
  recorded.trashed = trashed;
  saveRecord(context, record);
  if (
    result.location &&
    takeGitDirectoryAlong(checked.gitDirectory, result.location)
  ) {
    trashed.registration = "moved-with-copy";
    move.registration = trashed.registration;
    move.restore = restoreSteps(path, trashed);
    saveRecord(context, record);
    unlinkSync(join(result.location, MOVED_GIT_DIRECTORY, "locked"));
    return;
  }
  report.notes.push(
    `Git still lists the copy that was at ${path}, because its place in the Trash could not be confirmed or its Git folder could not be moved along. Its Git registration is locked against pruning.`
  );
};

const retireOne = (
  context: RetirementContext,
  record: QueuedWorktreesRecord,
  recorded: KeptQueuedWorktree
): void => {
  // Already moved by an earlier start: history, never a candidate again,
  // also when someone has put the folder back.
  if (recorded.trashed) {
    return;
  }
  const worktree = locate(context, recorded);
  if (worktree === "forget") {
    context.forgotten.add(recorded.registrationId);
    return;
  }
  // The local form of the target branch is never a candidate.
  if (
    worktree === "wait" ||
    `${HEAD_REF_PREFIX}${worktree.branch}` === recorded.target.ref
  ) {
    return;
  }
  const { commonGitDirectory, primaryCheckout } = context.inventory.repository;
  context.lazyFetchOff ??= lazyFetchStaysOff(primaryCheckout);
  if (!context.lazyFetchOff) {
    return;
  }
  // Not merged yet, as far as the remote says: it waits, unreported.
  const evidence = mergedEvidence(context, recorded, worktree);
  if (!evidence) {
    return;
  }
  const early =
    claimReason(commonGitDirectory, worktree.path) ??
    (worktree.changes.length > 0
      ? `This copy has changes that are not saved in a commit, ${left(worktree.path)}`
      : null);
  if (early) {
    context.report.kept.push({ path: worktree.path, reason: early });
    return;
  }
  moveMerged(context, record, recorded, worktree, evidence);
};

// Drops the entries nothing will act on again: a worktree that is gone or
// is another registration, and a move made long enough ago. Only the record
// is touched.
const forgetSettledEntries = (
  context: RetirementContext,
  records: readonly QueuedWorktreesRecord[]
): void => {
  const now = (context.hooks.now?.() ?? new Date()).getTime();
  const remembered = (item: KeptQueuedWorktree): boolean => {
    if (!item.trashed) {
      return !context.forgotten.has(item.registrationId);
    }
    const age = now - Date.parse(item.trashed.at);
    if (age > REMEMBER_MOVED_DAYS * DAY_MS) {
      releasePins(
        context.inventory.repository.primaryCheckout,
        item.registrationId
      );
      return false;
    }
    return true;
  };
  for (const record of records) {
    const worktrees = record.worktrees.filter(remembered);
    if (worktrees.length !== record.worktrees.length) {
      saveRecord(context, { ...record, worktrees });
    }
  }
};

/**
 * At a fresh Queue or Sweep start, moves to the Trash the worktrees earlier
 * Queue and Sweep runs created and kept, once their work is merged. The
 * caller holds the loop and worktree-coordination locks, has finished
 * validating the start, and has not captured the lease baseline yet.
 *
 * Nothing is deleted: no `git worktree remove`, no branch deletion. A
 * mistake is undone by moving the folder back (`restoreSteps`), so the
 * checks are the reasonable ones, not an exhaustive proof. Each recorded
 * worktree is taken alone and moved only when:
 *
 * - it is the registration the run recorded (the ID `prepare-agent` wrote
 *   into its private Git directory), on the recorded branch, and not the
 *   checkout in use;
 * - the recorded remote, asked at this start for the recorded target ref,
 *   answers with a commit that contains its head by ancestry or exact
 *   bytes, and that proof still holds on the last look;
 * - no claim or lock holds it, Git's own fresh status shows no uncommitted
 *   change and no untracked file, and no Git operation is unfinished.
 *
 * Files Git ignores (installed packages, build output, local settings) go
 * to the Trash with the folder. Anything else, or anything that cannot be
 * read, keeps the worktree. One that is merged and kept is reported with
 * its reason; one that is not merged yet is not mentioned. This never
 * throws and never stops the run.
 */
export const retireMergedQueuedWorktrees = (
  inventory: RepositoryInventory,
  hooks: QueuedRetirementHooks = {}
): QueuedRetirementReport => {
  const report: QueuedRetirementReport = {
    kept: [],
    movedToTrash: [],
    notes: [],
  };
  const context: RetirementContext = {
    answers: new Map(),
    forgotten: new Set(),
    hooks,
    inventory,
    report,
  };
  try {
    withGitDeadline(30_000, () =>
      withEnvironment(RETIREMENT_GIT_ENVIRONMENT, () => {
        const records = readQueuedWorktreesRecords(
          inventory.repository.commonGitDirectory
        );
        for (const record of records) {
          for (const recorded of record.worktrees) {
            try {
              retireOne(context, record, recorded);
            } catch (error) {
              report.notes.push(
                `I could not check an earlier copy (${message(error)}), ${left(recorded.path)}`
              );
            }
          }
        }
        if (context.lazyFetchOff === false) {
          report.notes.push(
            "This project downloads parts of its history only when they are read, and this Git cannot be told not to (Git 2.45 or later can), so earlier copies were left in place."
          );
        }
        forgetSettledEntries(context, records);
      })
    );
  } catch (error) {
    report.notes.push(`Earlier copies were not checked: ${message(error)}`);
  }
  return report;
};
