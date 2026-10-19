import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256 } from "./hash.ts";
import { RUN_ID_PATTERN } from "./run-id.ts";
import type { LoopWorktreeLease } from "./types.ts";

// `loop replan` writes each approved attempt to
// `<common-git-dir>/simple-changes/history/<run-id>/replan-<request-digest>/`:
// `replan.json` is the intent, and the atomic move of the run's whole lease
// into `replan-lease.json` completes it (see references/recovery.md).
const STATE_DIRECTORY = "simple-changes";
const HISTORY_DIRECTORY = "history";
const REPLAN_ATTEMPT_PREFIX = "replan-";
const INTENT_FILENAME = "replan.json";
const ARCHIVE_FILENAME = "replan-lease.json";

const isRealDirectory = (path: string): boolean =>
  lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

// A regular file's text, never through a symbolic link and never blocking on
// a FIFO put in its place; null for anything else.
const regularFileText = (path: string): string | null => {
  if (lstatSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
    return null;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are a bitmask.
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return fstatSync(descriptor).isFile()
      ? readFileSync(descriptor, "utf8")
      : null;
  } finally {
    closeSync(descriptor);
  }
};

interface ArchivedReplan {
  fullLeaseDigest?: unknown;
  kind?: unknown;
  lease?: {
    commonGitDirectory?: unknown;
    runId?: unknown;
    worktrees?: unknown;
  };
  outcome?: unknown;
  request?: { runId?: unknown };
  schemaVersion?: unknown;
}

// The archived lease's registrations when `directory` holds a completed
// replan of `runId`: its archive is byte for byte the lease its intent
// recorded, for this repository and run.
const completedReplanRegistrations = (
  commonGitDirectory: string,
  runId: string,
  directory: string
): LoopWorktreeLease[] => {
  const intentText = regularFileText(join(directory, INTENT_FILENAME));
  const archiveText = regularFileText(join(directory, ARCHIVE_FILENAME));
  if (intentText === null || archiveText === null) {
    return [];
  }
  const intent = JSON.parse(intentText) as ArchivedReplan;
  if (
    intent.schemaVersion !== 1 ||
    intent.kind !== "loop-replan" ||
    intent.outcome !== "replanned" ||
    intent.request?.runId !== runId ||
    intent.lease?.runId !== runId ||
    intent.lease.commonGitDirectory !== commonGitDirectory ||
    !Array.isArray(intent.lease.worktrees) ||
    sha256(archiveText) !== intent.fullLeaseDigest ||
    JSON.stringify(JSON.parse(archiveText)) !== JSON.stringify(intent.lease)
  ) {
    return [];
  }
  return intent.lease.worktrees as LoopWorktreeLease[];
};

/**
 * The worktree registrations of run `runId`'s lease as an approved, completed
 * `loop replan` archived it, or none. Only an attempt whose archived lease is
 * exactly the lease its intent recorded counts; a missing, linked,
 * unreadable, or inconsistent record proves nothing.
 */
export const replannedRegistrations = (
  commonGitDirectory: string,
  runId: string
): LoopWorktreeLease[] => {
  if (!RUN_ID_PATTERN.test(runId)) {
    return [];
  }
  const runDirectory = join(
    commonGitDirectory,
    STATE_DIRECTORY,
    HISTORY_DIRECTORY,
    runId
  );
  if (
    ![
      join(commonGitDirectory, STATE_DIRECTORY),
      join(commonGitDirectory, STATE_DIRECTORY, HISTORY_DIRECTORY),
      runDirectory,
    ].every(isRealDirectory)
  ) {
    return [];
  }
  try {
    return readdirSync(runDirectory)
      .filter((name) => name.startsWith(REPLAN_ATTEMPT_PREFIX))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => join(runDirectory, name))
      .filter(isRealDirectory)
      .flatMap((directory) =>
        completedReplanRegistrations(commonGitDirectory, runId, directory)
      );
  } catch {
    return [];
  }
};
