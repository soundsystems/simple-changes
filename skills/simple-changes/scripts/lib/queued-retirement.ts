import { type Dirent, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { targetContainsRevision } from "./cleanup-core.ts";
import { proveExactByteTargetContainment } from "./exact-byte-proof.ts";
import { completeObjectId } from "./git-complete.ts";
import { credentialFreeRemoteUrl } from "./inventory.ts";
import { nothingAtPath } from "./loop-lease-core.ts";
import { worktreeSourceEntry } from "./loop-lease-shipment.ts";
import { liveClaimFor } from "./loop-lease-verify.ts";
import { runGit, runGitRemote } from "./process.ts";
import { askRemoteRef, type RemoteHead } from "./queued-completion.ts";
import {
  type KeptQueuedWorktree,
  privateGitDirectory,
  type QueuedTargetBinding,
  readQueuedWorktreesRecords,
  readRegistrationId,
  singleFetchUrl,
  writeQueuedWorktreesRecord,
} from "./queued-worktrees.ts";
import { redactSecrets } from "./redact.ts";
import { sourceWorktreeDelta } from "./source-worktree-delta.ts";
import type { RepositoryInventory, WorktreeInventory } from "./types.ts";
import {
  assertNoGitOperation,
  readCoordinationDocumentFromCommonDirectory,
} from "./worktree-coordination.ts";
import { removeProvenWorktrees } from "./worktree-maintenance.ts";

/**
 * How the remote's own target was shown to contain a worktree's work:
 * its head is an ancestor of the target, or every path its commits touched
 * has exactly the same bytes and mode in the target (a squash merge). Never
 * patch IDs, which ignore whitespace.
 */
export type QueuedRetirementProof = "exact-byte-target" | "target-contained";

export interface QueuedRetirementRemoval {
  branch: string | null;
  /** Whether the worktree's own branch, still at the proven head, went too. */
  branchDeleted: boolean;
  headSha: string;
  path: string;
  proof: QueuedRetirementProof;
  /** The remote ref that was asked, and the commit it answered with. */
  target: { ref: string; revision: string; url: string };
}

/** What a Queue or Sweep start did with earlier runs' kept worktrees. */
export interface QueuedRetirementReport {
  /** Merged worktrees left in place, each with one plain reason. */
  kept: { path: string; reason: string }[];
  /** Why something could not be checked. Never a failure of the start. */
  notes: string[];
  removed: QueuedRetirementRemoval[];
}

export interface QueuedRetirementHooks {
  /**
   * Called with a worktree's path once it has passed every earlier check
   * and the remover's own re-read, just before its last checks run. Tests
   * use it to change a checkout that was already checked.
   */
  beforeLastChecks?: (path: string) => void;
}

type Candidate = WorktreeInventory & { headSha: string };

interface Evidence {
  proof: QueuedRetirementProof;
  revision: string;
}

interface RetirementContext {
  /** The first answer of each target this start asked, for sorting only. */
  answers: Map<string, RemoteHead>;
  /** Registration IDs whose worktree is gone or is another registration. */
  forgotten: Set<string>;
  hooks: QueuedRetirementHooks;
  inventory: RepositoryInventory;
  report: QueuedRetirementReport;
  repositoryPath: string;
}

const MAX_NAMED_FILES = 5;
const HEAD_REF_PREFIX = "refs/heads/";
// `<mode> <type> <object>\t<path>` from `ls-tree -z`.
const LS_TREE_RECORD_PATTERN = /^(\d+) (\w+) [0-9a-f]+\t(.+)$/su;
const SYMLINK_MODE = "120000";
// Refs Git keeps per worktree, in its private directory, outside any branch.
const OWN_REF_NAMESPACES = [
  "refs/worktree/",
  "refs/bisect/",
  "refs/rewritten/",
];

const WHITESPACE_RUN = /\s+/gu;

const left = (path: string): string => `so I left it in place: ${path}`;

// Git's own words on one line, for a sentence a person reads.
const oneLine = (detail: string): string =>
  detail.replace(WHITESPACE_RUN, " ").trim();

/** What to tell the owner about a kept copy that holds ignored files. */
export const ignoredFilesReason = (
  path: string,
  names: readonly string[]
): string =>
  `This copy holds files Git ignores (${names.join(", ")}), so I left it in place. Remove it by hand, or with computer use, once you have what you need from them: ${path}`;

// ---------------------------------------------------------------------------
// The target, asked of its own remote

/**
 * The address to ask about a recorded target, or null when Git would read
 * it as an option. The recorded address has no credential, so the remote of
 * that name is asked through its own address while that still is the
 * recorded one; otherwise the recorded address is asked directly. No other
 * remote is ever asked.
 */
const targetDestination = (
  primaryCheckout: string,
  target: QueuedTargetBinding
): string | null => {
  const configured = singleFetchUrl(primaryCheckout, target.remote);
  const destination =
    configured && credentialFreeRemoteUrl(configured) === target.url
      ? configured
      : target.url;
  return destination.startsWith("-") ? null : destination;
};

/** Asks the recorded remote address for the recorded ref, now. */
const askTarget = (
  primaryCheckout: string,
  target: QueuedTargetBinding
): RemoteHead => {
  const destination = targetDestination(primaryCheckout, target);
  return destination
    ? askRemoteRef(primaryCheckout, destination, target.ref)
    : { detail: "its address cannot be asked", state: "unanswered" };
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
 * arrive. No local ref moves, `FETCH_HEAD` is not written, and no tag,
 * submodule, or maintenance step follows, so the run's baseline is the
 * same with or without it. Returns why the commit is still missing, or
 * null.
 */
const fetchTargetCommit = (
  primaryCheckout: string,
  target: QueuedTargetBinding,
  revision: string
): string | null => {
  if (haveCommit(primaryCheckout, revision)) {
    return null;
  }
  const destination = targetDestination(primaryCheckout, target);
  if (!destination) {
    return "its address cannot be asked";
  }
  const fetched = runGitRemote(primaryCheckout, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    "--no-recurse-submodules",
    "--no-auto-maintenance",
    destination,
    target.ref,
  ]);
  if (fetched.exitCode !== 0) {
    return redactSecrets(
      fetched.stderr.trim() || `git fetch exited ${fetched.exitCode}`
    );
  }
  // The target may have moved on between the answer and the download; a
  // commit that did not arrive is simply not proven this time.
  return null;
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
    if (
      completeObjectId(primaryCheckout, `${targetRevision}^{commit}`) !==
      targetRevision
    ) {
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

// ---------------------------------------------------------------------------
// What a clean, merged checkout can still hold that exists nowhere else

interface TrackedShape {
  directories: ReadonlySet<string>;
  root: string;
  /** Every path the commit tracks, with its mode. */
  tracked: ReadonlyMap<string, string>;
}

/** The commit's own file list, or why it cannot be used. */
const trackedShape = (
  worktreePath: string,
  headSha: string
): TrackedShape | { failure: string } => {
  const listed = runGit(
    worktreePath,
    ["ls-tree", "-r", "-z", "--full-tree", headSha],
    true
  );
  const records = listed.stdout.split("\0").filter(Boolean);
  if (listed.exitCode !== 0 || records.length === 0) {
    return { failure: "its commit's file list could not be read" };
  }
  const tracked = new Map<string, string>();
  const directories = new Set<string>();
  for (const record of records) {
    const [, mode, type, path] = LS_TREE_RECORD_PATTERN.exec(record) ?? [];
    if (!(mode && path)) {
      return { failure: "its commit's file list could not be read" };
    }
    if (type !== "blob") {
      return { failure: `${path} is a nested project (a submodule)` };
    }
    tracked.set(path, mode);
    for (
      let end = path.lastIndexOf("/");
      end > 0 && !directories.has(path.slice(0, end));
      end = path.lastIndexOf("/", end - 1)
    ) {
      directories.add(path.slice(0, end));
    }
  }
  return { directories, root: worktreePath, tracked };
};

type EntryVerdict = "descend" | "extra" | "tracked" | { failure: string };

// One entry on disk against the commit's shape. A symbolic link is never
// followed: it passes only where the commit itself holds a link.
const entryVerdict = (
  shape: TrackedShape,
  path: string,
  entry: Dirent
): EntryVerdict => {
  const mode = shape.tracked.get(path);
  const untracked = mode === undefined && !shape.directories.has(path);
  if (entry.isDirectory()) {
    return shape.directories.has(path) ? "descend" : "extra";
  }
  if (entry.isFile()) {
    return mode === undefined ? "extra" : "tracked";
  }
  if (entry.isSymbolicLink() && mode === SYMLINK_MODE) {
    return "tracked";
  }
  return untracked
    ? "extra"
    : {
        failure: `${path} is a link or special file where its commit holds a file or folder`,
      };
};

// Adds what `relative` holds beyond the commit's shape, up to five names. A
// directory with no tracked path under it is named and not descended into,
// which covers a nested repository.
const collectExtras = (
  shape: TrackedShape,
  relative: string,
  extras: string[]
): string | null => {
  // Sorted, so the same checkout always names the same files.
  const entries = readdirSync(resolve(shape.root, relative), {
    withFileTypes: true,
  }).sort((one, other) => (one.name < other.name ? -1 : 1));
  for (const entry of entries) {
    if (extras.length >= MAX_NAMED_FILES) {
      return null;
    }
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (path === ".git") {
      continue;
    }
    const verdict = entryVerdict(shape, path, entry);
    if (typeof verdict === "object") {
      return verdict.failure;
    }
    if (verdict === "extra") {
      extras.push(entry.isDirectory() ? `${path}/` : path);
    }
    const failure =
      verdict === "descend" ? collectExtras(shape, path, extras) : null;
    if (failure) {
      return failure;
    }
  }
  return null;
};

/**
 * Up to five entries on disk in a checkout that its commit does not track,
 * which in a checkout with clean status are files Git ignores. The disk
 * itself is walked and compared with the commit's own file list, so a list
 * Git lost or cut short shows more extra files, never fewer. Anything that
 * cannot be read, a submodule, or a link or special file in a tracked
 * place is a failure, which keeps the checkout.
 */
export const filesBeyondHead = (
  worktreePath: string,
  headSha: string
): { extras: string[] } | { failure: string } => {
  const shape = trackedShape(worktreePath, headSha);
  if ("failure" in shape) {
    return shape;
  }
  const extras: string[] = [];
  try {
    const failure = collectExtras(shape, "", extras);
    return failure ? { failure } : { extras };
  } catch {
    return { failure: "a folder in it could not be listed" };
  }
};

// Whether anything is stored under a directory, without following links.
const holdsAnyFile = (directory: string): boolean => {
  if (nothingAtPath(directory)) {
    return false;
  }
  return readdirSync(directory, { withFileTypes: true }).some(
    (entry) => !entry.isDirectory() || holdsAnyFile(join(directory, entry.name))
  );
};

/**
 * Why Git state private to this worktree would be lost with it, or null.
 * `assertNoGitOperation` reads the merge, cherry-pick, revert, bisect, and
 * rebase markers; a `sequencer` directory is checked here as well, since an
 * interrupted multi-commit cherry-pick or revert can sit between picks on a
 * clean head with its remaining steps stored only there. Refs the worktree
 * keeps for itself count too. Anything unreadable is a reason.
 */
const privateGitState = (
  commonGitDirectory: string,
  worktreePath: string
): string | null => {
  const unfinished = `This copy has an unfinished Git operation, ${left(worktreePath)}`;
  try {
    assertNoGitOperation(worktreePath);
    const gitDirectory = privateGitDirectory(commonGitDirectory, worktreePath);
    if (!(gitDirectory && nothingAtPath(join(gitDirectory, "sequencer")))) {
      return unfinished;
    }
    const ownRefs = runGit(
      worktreePath,
      ["for-each-ref", "--format=%(refname)", ...OWN_REF_NAMESPACES],
      true
    );
    return ownRefs.exitCode !== 0 ||
      ownRefs.stdout.trim() !== "" ||
      holdsAnyFile(join(gitDirectory, "refs", "worktree"))
      ? `This copy holds Git references of its own, ${left(worktreePath)}`
      : null;
  } catch {
    return unfinished;
  }
};

/**
 * Why the checkout's files are not exactly its commit, or null. Every file
 * is compared with the head itself, so an edit under an assume-unchanged or
 * skip-worktree entry counts, and then the disk is walked for anything the
 * commit does not track at all.
 */
const contentBeyondCommit = (worktree: Candidate): string | null => {
  const delta = sourceWorktreeDelta(worktree.path, worktree.headSha, (path) =>
    worktreeSourceEntry(worktree.path, path)
  );
  if ("failure" in delta) {
    return `I could not compare this copy's files with its saved version (${delta.failure}), ${left(worktree.path)}`;
  }
  if (delta.entries.size > 0) {
    return `This copy holds changes Git's status does not show (${[...delta.entries.keys()].slice(0, MAX_NAMED_FILES).join(", ")}), ${left(worktree.path)}`;
  }
  const beyond = filesBeyondHead(worktree.path, worktree.headSha);
  if ("failure" in beyond) {
    return `I could not check every file in this copy (${beyond.failure}), ${left(worktree.path)}`;
  }
  return beyond.extras.length > 0
    ? ignoredFilesReason(worktree.path, beyond.extras)
    : null;
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

// ---------------------------------------------------------------------------
// One recorded worktree at a time

type Registration = "another" | "same" | "unknown";

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
      return "unknown";
    }
    return readRegistrationId(gitDirectory) === recorded.registrationId
      ? "same"
      : "another";
  } catch {
    return "unknown";
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
  const registration = registrationOf(commonGitDirectory, recorded);
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

// The first time a start asks about a target: the remote's answer, with
// its commit brought here if it is missing. A remote that gives no answer
// or no commits is noted once, and keeps every worktree bound to it.
const firstAnswer = (
  context: RetirementContext,
  { target }: KeptQueuedWorktree
): RemoteHead => {
  const { primaryCheckout } = context.inventory.repository;
  const answer = askTarget(primaryCheckout, target);
  const failure =
    answer.state === "unanswered"
      ? answer.detail
      : answer.head && fetchTargetCommit(primaryCheckout, target, answer.head);
  if (failure) {
    context.report.notes.push(
      `I could not ask ${target.url} what has been merged (${oneLine(failure)}), so earlier copies that wait on it were left in place.`
    );
  }
  return answer;
};

const targetKey = (target: QueuedTargetBinding): string =>
  `${target.url}\n${target.ref}`;

/**
 * Whether the remote's target contains this worktree's head, by this
 * start's first answer for that target. It only sorts the merged from the
 * rest: a worktree is removed on the fresh answer `lastChecks` asks for. An
 * unanswered remote is noted once and keeps every worktree bound to it.
 */
const mergedEvidence = (
  context: RetirementContext,
  recorded: KeptQueuedWorktree,
  worktree: Candidate
): Evidence | null => {
  const { primaryCheckout } = context.inventory.repository;
  const key = targetKey(recorded.target);
  const answer = context.answers.get(key) ?? firstAnswer(context, recorded);
  context.answers.set(key, answer);
  if (answer.state === "unanswered" || !answer.head) {
    return null;
  }
  const proof = containmentProof(
    primaryCheckout,
    worktree.headSha,
    answer.head
  );
  return proof ? { proof, revision: answer.head } : null;
};

/**
 * Every safety check for one worktree, run after the remover's own fresh
 * re-read and immediately before Git removes it, so nothing rests on an
 * earlier look: the registration and branch, a fresh answer from the
 * recorded remote with the proof repeated if the target moved, the claim,
 * Git state private to the worktree, and last the files themselves.
 * Returns the reason to keep it, or null.
 */
const lastChecks = (
  context: RetirementContext,
  recorded: KeptQueuedWorktree,
  fresh: Candidate,
  evidence: Evidence
): string | null => {
  const { commonGitDirectory, primaryCheckout } = context.inventory.repository;
  if (
    fresh.branch !== recorded.branch ||
    registrationOf(commonGitDirectory, recorded) !== "same"
  ) {
    return `This copy changed while I was checking it, ${left(fresh.path)}`;
  }
  const answer = askTarget(primaryCheckout, recorded.target);
  const unconfirmed = `I could not confirm with ${recorded.target.url} that this copy's work is still in the project, ${left(fresh.path)}`;
  if (answer.state === "unanswered" || !answer.head) {
    return unconfirmed;
  }
  if (answer.head !== evidence.revision) {
    const proof = containmentProof(primaryCheckout, fresh.headSha, answer.head);
    if (!proof) {
      return unconfirmed;
    }
    evidence.proof = proof;
    evidence.revision = answer.head;
  }
  return (
    claimReason(commonGitDirectory, fresh.path) ??
    privateGitState(commonGitDirectory, fresh.path) ??
    contentBeyondCommit(fresh)
  );
};

/**
 * Removes one merged worktree through `removeProvenWorktrees`, the removal
 * `prune` and `worktree cleanup` use, one candidate per call with
 * `lastChecks` as its guard. It removes without force and deletes the
 * branch only while that is the worktree's own, still at the proven head.
 */
const removeMerged = (
  context: RetirementContext,
  recorded: KeptQueuedWorktree,
  worktree: Candidate,
  evidence: Evidence
): void => {
  const { report } = context;
  const errors: string[] = [];
  const guard: { ran: boolean; reason: string | null } = {
    ran: false,
    reason: null,
  };
  const [removed] = removeProvenWorktrees(
    context.repositoryPath,
    // The full local form of the target branch, which is never deleted.
    recorded.target.ref,
    [{ containment: evidence.proof, worktree }],
    errors,
    {
      beforeRemoval: (fresh) => {
        context.hooks.beforeLastChecks?.(fresh.path);
        guard.reason = lastChecks(context, recorded, fresh, evidence);
        guard.ran = true;
        return guard.reason;
      },
    }
  );
  if (!removed) {
    const fallback = guard.ran
      ? `Git would not remove this copy (${oneLine(errors.join(" "))}), ${left(worktree.path)}`
      : `This copy changed while I was checking it, ${left(worktree.path)}`;
    report.kept.push({
      path: worktree.path,
      reason: guard.reason ?? fallback,
    });
    return;
  }
  context.forgotten.add(recorded.registrationId);
  report.notes.push(...errors);
  report.removed.push({
    branch: removed.branch,
    branchDeleted: removed.branchDeleted,
    headSha: removed.headSha,
    path: removed.path,
    proof: evidence.proof,
    target: {
      ref: recorded.target.ref,
      revision: evidence.revision,
      url: recorded.target.url,
    },
  });
};

const retireOne = (
  context: RetirementContext,
  recorded: KeptQueuedWorktree
): void => {
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
  // Not merged yet, as far as the remote says: it waits, unreported.
  const evidence = mergedEvidence(context, recorded, worktree);
  if (!evidence) {
    return;
  }
  const early =
    claimReason(
      context.inventory.repository.commonGitDirectory,
      worktree.path
    ) ??
    (worktree.changes.length > 0
      ? `This copy has changes that are not saved in a commit, ${left(worktree.path)}`
      : null);
  if (early) {
    context.report.kept.push({ path: worktree.path, reason: early });
    return;
  }
  removeMerged(context, recorded, worktree, evidence);
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * At a fresh Queue or Sweep start, clears the worktrees earlier Queue and
 * Sweep runs created and kept, once their work is merged. The caller holds
 * the loop and worktree-coordination locks, has finished validating the
 * start, and has not captured the lease baseline yet.
 *
 * Each recorded worktree is taken alone, checked, and removed before the
 * next one is looked at. It goes only when all of this is proven:
 *
 * - it is the registration the run recorded (the ID in its private Git
 *   directory), on the recorded branch, and not the checkout in use;
 * - the recorded remote, asked now for the recorded target ref, answers
 *   with a commit that contains its head by ancestry or exact bytes;
 * - no claim holds it, its status is clean, and no Git operation or
 *   private ref would be lost with it;
 * - its files equal its commit even where status is told not to look, and
 *   nothing is on disk beyond what the commit tracks.
 *
 * Anything else, or anything that cannot be read, keeps the worktree. One
 * that is merged and kept is reported with its reason; one that is not
 * merged yet is not mentioned. This never throws and never stops the run.
 */
export const retireMergedQueuedWorktrees = (
  repositoryPath: string,
  inventory: RepositoryInventory,
  hooks: QueuedRetirementHooks = {}
): QueuedRetirementReport => {
  const report: QueuedRetirementReport = { kept: [], notes: [], removed: [] };
  const context: RetirementContext = {
    answers: new Map(),
    forgotten: new Set(),
    hooks,
    inventory,
    report,
    repositoryPath,
  };
  try {
    const { commonGitDirectory } = inventory.repository;
    const records = readQueuedWorktreesRecords(commonGitDirectory);
    for (const recorded of records.flatMap((record) => record.worktrees)) {
      try {
        retireOne(context, recorded);
      } catch (error) {
        report.notes.push(
          `I could not check an earlier copy (${message(error)}), ${left(recorded.path)}`
        );
      }
    }
    for (const record of records) {
      const worktrees = record.worktrees.filter(
        (item) => !context.forgotten.has(item.registrationId)
      );
      if (worktrees.length !== record.worktrees.length) {
        writeQueuedWorktreesRecord(commonGitDirectory, {
          ...record,
          worktrees,
        });
      }
    }
  } catch (error) {
    report.notes.push(`Earlier copies were not checked: ${message(error)}`);
  }
  return report;
};
