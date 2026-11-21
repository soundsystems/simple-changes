import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "bun";
import { redactSecrets } from "./redact.ts";

/**
 * What one attempt to move a folder to the Trash says happened. `location`
 * is where the attempt believes the folder went; `moveToTrash` confirms it
 * before anyone relies on it.
 */
export type TrashAttempt =
  | { location: string | null; moved: true }
  | { moved: false; reason: string };

/** Moves one folder to the Trash. Tests substitute it. */
export type TrashMover = (path: string) => TrashAttempt;

/** What is known for certain after an attempt. */
export type TrashResult =
  /** The folder is where it was, untouched. */
  | { reason: string; state: "kept" }
  /**
   * The folder is no longer at its path. `location` is where it is now,
   * confirmed to be the very same folder, or null when that could not be
   * confirmed.
   */
  | { location: string | null; state: "moved" };

/**
 * Names a folder that stands in for the Trash: a copy is moved into it with
 * one rename instead of through the system Trash. It is how a computer
 * without a Trash this tool can use opts in, and how the tests keep every
 * move inside their own temporary folder.
 */
export const TRASH_DIRECTORY_VARIABLE = "SIMPLE_CHANGES_TRASH_DIR";

const MAC_TRASH_TOOL = "/usr/bin/trash";
const TRASH_TIMEOUT_MS = 30_000;
const MOVED_LINE_START = '# Moved "';
const MOVED_LINE_SEPARATOR = '" to "';
const NON_NAME_CHARACTERS = /[^0-9A-Za-z]+/gu;
const textDecoder = new TextDecoder();

interface FolderIdentity {
  device: bigint;
  inode: bigint;
}

// The folder itself, never what a link at that path points to. Null when
// nothing is there.
const folderIdentity = (path: string): FolderIdentity | null => {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() ? { device: stat.dev, inode: stat.ino } : null;
  } catch {
    return null;
  }
};

const sameFolder = (
  one: FolderIdentity | null,
  other: FolderIdentity | null
): boolean =>
  one !== null &&
  other !== null &&
  one.device === other.device &&
  one.inode === other.inode;

// Whether anything at all is at the path. An unreadable path counts as
// present, so an unknown answer never reads as "it moved".
const somethingAt = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
};

const firstLine = (text: string): string =>
  redactSecrets(text.trim().split("\n")[0] ?? "");

// One rename into the stand-in folder, under a name nothing there has yet.
const moveIntoDirectory = (path: string, directory: string): TrashAttempt => {
  try {
    mkdirSync(directory, { recursive: true });
    const name = basename(path);
    const stamp = new Date().toISOString().replace(NON_NAME_CHARACTERS, "-");
    const location = somethingAt(join(directory, name))
      ? join(directory, `${name} ${stamp}-${crypto.randomUUID().slice(0, 8)}`)
      : join(directory, name);
    renameSync(path, location);
    return { location, moved: true };
  } catch (error) {
    return {
      moved: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

// Where `trash --verbose` says the folder went: `# Moved "<from>" to
// "<to>"`, with neither path escaped. Every way of splitting the line is
// tried, and only a place that holds the very same folder is believed.
const reportedLocation = (
  output: string,
  moved: FolderIdentity
): string | null => {
  for (const line of output.split("\n")) {
    if (!(line.startsWith(MOVED_LINE_START) && line.endsWith('"'))) {
      continue;
    }
    for (
      let split = line.indexOf(MOVED_LINE_SEPARATOR);
      split !== -1;
      split = line.indexOf(MOVED_LINE_SEPARATOR, split + 1)
    ) {
      const location = line.slice(split + MOVED_LINE_SEPARATOR.length, -1);
      if (sameFolder(folderIdentity(location), moved)) {
        return location;
      }
    }
  }
  return null;
};

// macOS 15 and later ship `trash`, which moves a folder to the user's Trash
// and, with `-v`, prints where it went; `-s` makes a failed move exit
// nonzero. The path is absolute, so it is never read as an option.
const macTrash = (path: string): TrashAttempt => {
  const before = folderIdentity(path);
  if (!before) {
    return { moved: false, reason: "it is not a folder" };
  }
  const result = spawnSync([MAC_TRASH_TOOL, "-s", "-v", path], {
    stderr: "pipe",
    stdout: "pipe",
    timeout: TRASH_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    return {
      moved: false,
      reason:
        result.exitCode === null
          ? "the Trash did not answer in time"
          : firstLine(textDecoder.decode(result.stderr)) ||
            `trash exited ${result.exitCode}`,
    };
  }
  return {
    location: reportedLocation(textDecoder.decode(result.stdout), before),
    moved: true,
  };
};

const canRun = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The Trash of this computer: the stand-in folder when one is named, else
 * the macOS `trash` tool. Anywhere else there is no Trash this tool can
 * check, so nothing is moved. A test run never reaches the real Trash.
 */
export const systemTrashMover: TrashMover = (path) => {
  const directory = process.env[TRASH_DIRECTORY_VARIABLE]?.trim();
  if (directory) {
    return moveIntoDirectory(path, directory);
  }
  if (process.env.NODE_ENV === "test") {
    return { moved: false, reason: "a test run never uses the real Trash" };
  }
  if (process.platform === "darwin" && canRun(MAC_TRASH_TOOL)) {
    return macTrash(path);
  }
  return {
    moved: false,
    reason: `this computer has no Trash I can use (macOS 15 or later has one; ${TRASH_DIRECTORY_VARIABLE} can name a folder to use instead)`,
  };
};

/**
 * Moves one folder to the Trash and reports only what was then checked on
 * disk, whatever the mover claimed. The folder counts as moved only when
 * nothing is left at its path, and its new place is given only when that
 * place holds the very same folder (same device and file number, which a
 * move keeps and a copy does not). Nothing is ever deleted here, and no
 * failure throws: a folder that did not move is `kept`, exactly as it was.
 */
export const moveToTrash = (
  path: string,
  mover: TrashMover = systemTrashMover
): TrashResult => {
  const before = folderIdentity(path);
  if (!before) {
    return { reason: "it is not a folder", state: "kept" };
  }
  let attempt: TrashAttempt;
  try {
    attempt = mover(path);
  } catch (error) {
    attempt = {
      moved: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (somethingAt(path)) {
    return {
      reason: attempt.moved
        ? "the Trash reported a move, but the folder is still here"
        : attempt.reason,
      state: "kept",
    };
  }
  const location = attempt.moved ? attempt.location : null;
  return {
    location:
      location !== null && sameFolder(folderIdentity(location), before)
        ? location
        : null,
    state: "moved",
  };
};
