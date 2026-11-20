import { randomUUID } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { completeLine, remoteIsConfigured } from "./git-complete.ts";
import { ensureStateDirectory, gitReportedPath } from "./git-location.ts";
import { credentialFreeRemoteUrl, isLossyName } from "./inventory.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";
import type { LoopLease, RepositoryInventory } from "./types.ts";

/**
 * The target a Queue or Sweep run proposed into, as it stood when the run
 * closed: one branch on one remote. A later clean-up asks exactly this
 * remote about exactly this ref, whatever target a later run selects.
 */
export interface QueuedTargetBinding {
  /** The target's full ref on the remote, `refs/heads/<branch>`. */
  ref: string;
  /** The remote's name when the run closed; the address is what binds. */
  remote: string;
  /**
   * The remote's one fetch address as Git resolved it, with any embedded
   * credential removed.
   */
  url: string;
}

/** One worktree a closed Queue or Sweep run created and kept. */
export interface KeptQueuedWorktree {
  branch: string;
  path: string;
  /**
   * The ID written into this worktree's private Git directory when the run
   * closed. A checkout made again at the same path has a new private
   * directory and so no such ID, and is never this registration.
   */
  registrationId: string;
  target: QueuedTargetBinding;
}

/**
 * The record a closed Queue or Sweep run leaves beside the loop state, in
 * its own file so older runtimes never meet it. A later Queue or Sweep
 * start reads it to know which checkouts it may clear once their work is
 * in the target; the record proves nothing by itself.
 */
export interface QueuedWorktreesRecord {
  closedAt: string;
  kind: "queued-worktrees";
  mode: "queue" | "sweep";
  runId: string;
  schemaVersion: 1;
  worktrees: KeptQueuedWorktree[];
}

const STATE_DIRECTORY = "simple-changes";
const RECORDS_DIRECTORY = "queued-worktrees";
const REGISTRATION_FILE = "simple-changes-queued-worktree";
const REGISTRATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REMOTE_REF_PREFIX = "refs/remotes/";

const recordsDirectory = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY, RECORDS_DIRECTORY);

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code;

/**
 * The remote's one fetch address exactly as Git resolved it, or null when
 * it has none, more than one, or one Git would read as an option. This is
 * the address to ask; only its credential-free form is ever recorded.
 */
export const singleFetchUrl = (
  repositoryPath: string,
  remote: string
): string | null => {
  let url: string | null;
  try {
    // One whole line: a remote with several fetch addresses is refused.
    url = completeLine(repositoryPath, [
      "remote",
      "get-url",
      "--all",
      remote,
    ]).line;
  } catch {
    url = null;
  }
  return url && !url.startsWith("-") ? url : null;
};

// The configured remote a remote-tracking ref belongs to, and its branch
// there. A remote's name may hold a slash, so each prefix is asked of Git,
// shortest first, as `localBranchForTargetRef` does.
const remoteAndBranch = (
  primaryCheckout: string,
  trackingRef: string
): { branch: string; remote: string } | null => {
  const rest = trackingRef.slice(REMOTE_REF_PREFIX.length);
  for (
    let separator = rest.indexOf("/");
    separator > 0;
    separator = rest.indexOf("/", separator + 1)
  ) {
    const remote = rest.slice(0, separator);
    const branch = rest.slice(separator + 1);
    if (branch && remoteIsConfigured(primaryCheckout, remote)) {
      return { branch, remote };
    }
  }
  return null;
};

/**
 * The remote branch `targetRef` stands for, or why it cannot be bound. A
 * target that is not a branch on a remote with one fetch address has
 * nothing a later run could ask, so its worktrees are never cleared
 * automatically.
 */
export const queuedTargetBinding = (
  primaryCheckout: string,
  targetRef: string
): QueuedTargetBinding | { unbound: string } => {
  let fullRef: string | null;
  try {
    fullRef = completeLine(primaryCheckout, [
      "rev-parse",
      "--symbolic-full-name",
      targetRef,
    ]).line;
  } catch {
    fullRef = null;
  }
  if (!fullRef?.startsWith(REMOTE_REF_PREFIX) || isLossyName(fullRef)) {
    return { unbound: `${targetRef} is not a branch on a remote` };
  }
  let found: { branch: string; remote: string } | null;
  try {
    found = remoteAndBranch(primaryCheckout, fullRef);
  } catch {
    found = null;
  }
  if (!found || found.branch === "HEAD") {
    return { unbound: `the remote of ${targetRef} could not be read` };
  }
  const url = singleFetchUrl(primaryCheckout, found.remote);
  if (!url) {
    return {
      unbound: `${found.remote} does not have exactly one address to ask`,
    };
  }
  return {
    ref: `refs/heads/${found.branch}`,
    remote: found.remote,
    url: credentialFreeRemoteUrl(url),
  };
};

/**
 * The private Git directory of a linked worktree, `<common>/worktrees/<id>`,
 * which Git deletes with the worktree. Null when the path is not a linked
 * worktree of this repository or Git cannot say.
 */
export const privateGitDirectory = (
  commonGitDirectory: string,
  worktreePath: string
): string | null => {
  const answer = runGit(
    worktreePath,
    ["rev-parse", "--absolute-git-dir"],
    true
  );
  if (answer.exitCode !== 0) {
    return null;
  }
  try {
    const directory = realpathSync(
      gitReportedPath(answer.stdout, "--absolute-git-dir", {
        repository: worktreePath,
      })
    );
    return dirname(directory) ===
      join(realpathSync(commonGitDirectory), "worktrees")
      ? directory
      : null;
  } catch {
    return null;
  }
};

/**
 * The registration ID in a worktree's private Git directory, or null when
 * none was ever written there. A file that cannot be read throws, so an
 * unknown answer never reads as "no ID".
 */
export const readRegistrationId = (gitDirectory: string): string | null => {
  let text: string;
  try {
    text = readFileSync(join(gitDirectory, REGISTRATION_FILE), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  const id = text.trim();
  return REGISTRATION_ID_PATTERN.test(id) ? id : null;
};

// The worktree's registration ID, written once: a worktree that already
// has one keeps it.
const ensureRegistrationId = (gitDirectory: string): string => {
  const existing = readRegistrationId(gitDirectory);
  if (existing) {
    return existing;
  }
  const id = randomUUID();
  const path = join(gitDirectory, REGISTRATION_FILE);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${id}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return id;
};

const recordPath = (commonGitDirectory: string, runId: string): string =>
  resolve(recordsDirectory(commonGitDirectory), `${runId}.json`);

/** Writes the record, or deletes it once no worktree is left in it. */
export const writeQueuedWorktreesRecord = (
  commonGitDirectory: string,
  record: QueuedWorktreesRecord
): void => {
  const path = recordPath(commonGitDirectory, record.runId);
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
    recordsDirectory(commonGitDirectory)
  );
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
};

/**
 * Every well-formed record, oldest file name first. A record that is
 * missing, unreadable, or not exactly this shape is skipped: a record only
 * ever allows a clean-up, so skipping it keeps its worktrees. That includes
 * any record without the target binding or the registration ID.
 */
export const readQueuedWorktreesRecords = (
  commonGitDirectory: string
): QueuedWorktreesRecord[] => {
  const directory = recordsDirectory(commonGitDirectory);
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

export interface KeptQueuedWorktreesResult {
  /** Why some kept worktree will not be cleared by a later run. */
  notes: string[];
  recorded: KeptQueuedWorktree[];
}

/**
 * Records the worktrees a Queue or Sweep run keeps as it closes: each one's
 * branch, the target the run proposed into, and a new ID written into the
 * worktree's private Git directory. A worktree that cannot be bound to all
 * three is left out, with a note, and so is never cleared automatically.
 */
export const recordKeptQueuedWorktrees = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  keptPaths: readonly string[],
  closedAt: string
): KeptQueuedWorktreesResult => {
  const result: KeptQueuedWorktreesResult = { notes: [], recorded: [] };
  if (keptPaths.length === 0) {
    return result;
  }
  const target = queuedTargetBinding(lease.primaryCheckout, lease.targetRef);
  if ("unbound" in target) {
    result.notes.push(
      `A later run will not clear this run's kept worktrees by itself, because ${target.unbound}, so there is no remote to ask whether their work is merged: ${keptPaths.join(", ")}.`
    );
    return result;
  }
  for (const path of keptPaths) {
    const worktree = inventory.worktrees.find((item) => item.path === path);
    const gitDirectory = privateGitDirectory(lease.commonGitDirectory, path);
    if (
      !(worktree?.branch && gitDirectory) ||
      worktree.isPrimary ||
      isLossyName(worktree.branch)
    ) {
      result.notes.push(
        `A later run will not clear kept worktree ${path} by itself: it is not a linked worktree on a branch that can be named exactly.`
      );
      continue;
    }
    result.recorded.push({
      branch: worktree.branch,
      path,
      registrationId: ensureRegistrationId(gitDirectory),
      target,
    });
  }
  writeQueuedWorktreesRecord(lease.commonGitDirectory, {
    closedAt,
    kind: "queued-worktrees",
    mode: lease.mode === "sweep" ? "sweep" : "queue",
    runId: lease.runId,
    schemaVersion: 1,
    worktrees: result.recorded,
  });
  return result;
};
