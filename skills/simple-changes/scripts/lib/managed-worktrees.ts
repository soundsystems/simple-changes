import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { validateSchema } from "./schema.ts";

export const slug = (value: string, fallback: string): string => {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || fallback;
};

// `prepare-agent` places every worktree it creates under
// `<parent of the primary>/.simple-changes-worktrees/<repository slug>/`.
// The names prove nothing: a person, plain Git, or another tool can make the
// same folders, so only a creation record (below) lets cleanup remove one.
export const managedWorktreeDirectories = (
  primaryCheckout: string
): { repository: string; root: string } => {
  const root = resolve(dirname(primaryCheckout), ".simple-changes-worktrees");
  return {
    repository: resolve(root, slug(basename(primaryCheckout), "repository")),
    root,
  };
};

/** One managed directory Simple Changes made, bound to its identity then. */
export interface ManagedDirectoryRecord {
  createdAt: string;
  device: string;
  inode: string;
  path: string;
  runId: string;
}

interface ManagedDirectoryDocument {
  directories: ManagedDirectoryRecord[];
  schemaVersion: 1;
}

/** What one cleanup pass did with the managed directories. */
export interface ManagedDirectoryCleanup {
  /** Non-fatal: directories kept for a reason worth reading, and failures. */
  notes: string[];
  removed: string[];
}

// A file of its own, because older runtimes validate the existing state files
// strictly; they never read this one, and so never remove these directories.
export const managedDirectoryRecordsPath = (
  commonGitDirectory: string
): string =>
  resolve(
    commonGitDirectory,
    "simple-changes",
    "managed-worktree-directories.json"
  );

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type RecordsRead =
  | { ok: true; records: ManagedDirectoryRecord[] }
  | { ok: false; problem: string };

const readRecords = (commonGitDirectory: string): RecordsRead => {
  let text: string;
  try {
    text = readFileSync(
      managedDirectoryRecordsPath(commonGitDirectory),
      "utf8"
    );
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { ok: true, records: [] }
      : { ok: false, problem: errorMessage(error) };
  }
  try {
    const document = validateSchema<ManagedDirectoryDocument>(
      "managed-worktree-directories",
      JSON.parse(text)
    );
    return { ok: true, records: document.directories };
  } catch (error) {
    return { ok: false, problem: errorMessage(error) };
  }
};

const writeRecords = (
  commonGitDirectory: string,
  records: ManagedDirectoryRecord[]
): void => {
  const path = managedDirectoryRecordsPath(commonGitDirectory);
  if (records.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const document = validateSchema<ManagedDirectoryDocument>(
    "managed-worktree-directories",
    {
      directories: [...records].sort((left, right) =>
        left.path.localeCompare(right.path)
      ),
      schemaVersion: 1,
    } satisfies ManagedDirectoryDocument
  );
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
};

const identityOf = (
  stats: BigIntStats
): Pick<ManagedDirectoryRecord, "device" | "inode"> => ({
  device: stats.dev.toString(),
  inode: stats.ino.toString(),
});

const sameIdentity = (
  stats: BigIntStats,
  record: ManagedDirectoryRecord
): boolean => {
  const current = identityOf(stats);
  return current.device === record.device && current.inode === record.inode;
};

// `lstat` never follows the last component; a missing level reads as null.
const lstatOrNull = (path: string): BigIntStats | null => {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
};

// Makes one level, never its parents, and reports whether this call made it.
const makeDirectory = (path: string): boolean => {
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }
    throw error;
  }
};

const recordCreated = (
  commonGitDirectory: string,
  created: ManagedDirectoryRecord[]
): void => {
  if (created.length === 0) {
    return;
  }
  // Unreadable records, possibly from a newer runtime, stay as they are; the
  // directories made here then have no record, so cleanup only ever keeps them.
  const current = readRecords(commonGitDirectory);
  if (!current.ok) {
    return;
  }
  const paths = new Set(created.map((record) => record.path));
  try {
    writeRecords(commonGitDirectory, [
      ...current.records.filter((record) => !paths.has(record.path)),
      ...created,
    ]);
  } catch {
    // The same holds when the record cannot be written: nothing is removed.
  }
};

const PARENT_CREATION_ATTEMPTS = 3;

/**
 * Creates the directory a prepared worktree goes in. For the managed
 * repository directory, each missing level is made on its own, so exactly the
 * levels this call made, and none that already existed, are recorded with
 * their device and inode for cleanup. Any other directory is created as before
 * and never recorded. Runs under the loop state lock, as cleanup does.
 */
export const createWorktreeParent = (
  commonGitDirectory: string,
  primaryCheckout: string,
  directory: string,
  runId: string
): void => {
  const { repository, root } = managedWorktreeDirectories(primaryCheckout);
  if (resolve(directory) !== repository) {
    mkdirSync(directory, { recursive: true });
    return;
  }
  const created: ManagedDirectoryRecord[] = [];
  try {
    for (let attempt = 1; attempt <= PARENT_CREATION_ATTEMPTS; attempt += 1) {
      try {
        for (const level of [root, repository]) {
          if (makeDirectory(level)) {
            created.push({
              createdAt: new Date().toISOString(),
              ...identityOf(lstatSync(level, { bigint: true })),
              path: level,
              runId,
            });
          }
        }
        return;
      } catch (error) {
        // Another repository's cleanup may remove the shared root, once it is
        // empty, between the two levels; start again from the root.
        if (
          errorCode(error) !== "ENOENT" ||
          attempt === PARENT_CREATION_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  } finally {
    recordCreated(commonGitDirectory, created);
  }
};

type RecordedInspection =
  | { state: "directory" }
  | { state: "missing" }
  | { reason: string; state: "refused" }
  | { reason: string; state: "replaced" };

const replacedReason = (level: string): string =>
  `${level} is no longer the directory Simple Changes created there`;

// Checks each level from the managed root down to the last of `levels` with
// `lstat`, so no symbolic link is followed, and the levels above the root
// with `realpath`. A recorded level must still be the directory created.
const inspectRecordedDirectory = (
  anchor: string,
  levels: string[],
  records: ManagedDirectoryRecord[]
): RecordedInspection => {
  let resolvedAnchor: string;
  try {
    resolvedAnchor = realpathSync(anchor);
  } catch (error) {
    return {
      reason: `${anchor} cannot be resolved: ${errorMessage(error)}`,
      state: "refused",
    };
  }
  if (resolvedAnchor !== anchor) {
    return {
      reason: `${anchor} resolves through a symbolic link to ${resolvedAnchor}`,
      state: "refused",
    };
  }
  const target = levels.at(-1);
  for (const level of levels) {
    const stats = lstatOrNull(level);
    if (!stats) {
      return { state: "missing" };
    }
    if (stats.isSymbolicLink()) {
      return { reason: `${level} is a symbolic link`, state: "refused" };
    }
    const record = records.find((entry) => entry.path === level);
    const created =
      stats.isDirectory() &&
      record !== undefined &&
      sameIdentity(stats, record);
    if (level === target && !created) {
      return { reason: replacedReason(level), state: "replaced" };
    }
    if (!stats.isDirectory()) {
      return { reason: `${level} is not a directory`, state: "refused" };
    }
    if (record && !created) {
      return { reason: replacedReason(level), state: "refused" };
    }
  }
  return { state: "directory" };
};

// An empty managed directory without a record stays; say so, because it
// looks like one cleanup should have removed.
const unrecordedEmptyNote = (directory: string): string | null => {
  const stats = lstatOrNull(directory);
  if (!stats?.isDirectory()) {
    return null;
  }
  try {
    return readdirSync(directory).length === 0
      ? `Kept empty ${directory}: this repository has no record that Simple Changes created it, so only whoever made it should remove it (with rmdir).`
      : null;
  } catch {
    return null;
  }
};

// Handles one recorded or unrecorded level and returns the records to keep.
const cleanManagedLevel = (
  levels: string[],
  records: ManagedDirectoryRecord[],
  cleanup: ManagedDirectoryCleanup
): ManagedDirectoryRecord[] => {
  const directory = levels.at(-1) ?? "";
  const others = records.filter((record) => record.path !== directory);
  if (others.length === records.length) {
    const note = unrecordedEmptyNote(directory);
    if (note) {
      cleanup.notes.push(note);
    }
    return records;
  }
  const inspection = inspectRecordedDirectory(
    dirname(levels[0] ?? directory),
    levels,
    records
  );
  if (inspection.state === "missing") {
    return others;
  }
  if (inspection.state === "refused") {
    cleanup.notes.push(
      `Kept ${directory}: ${inspection.reason}. Simple Changes removes a directory it created only through real directories that still match its record.`
    );
    return records;
  }
  if (inspection.state === "replaced") {
    cleanup.notes.push(
      `Kept ${directory}: ${inspection.reason}, so its creation record was dropped.`
    );
    return others;
  }
  try {
    rmdirSync(directory);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return others;
    }
    if (code !== "ENOTEMPTY" && code !== "EEXIST") {
      cleanup.notes.push(
        `Could not remove the empty managed worktree directory ${directory}: ${errorMessage(error)}`
      );
    }
    return records;
  }
  cleanup.removed.push(directory);
  return others;
};

/**
 * Removes the managed repository directory, then the managed root, once each
 * is empty, only when this repository recorded creating it and every level
 * from the root down is still a real directory, not a symbolic link, with the
 * recorded identity. Everything else is kept: directories a person, plain Git,
 * or an older runtime made, pre-existing ones `prepare-agent` reused, and any
 * that still hold something. Failures are returned as notes, never thrown.
 */
export const removeEmptyManagedWorktreeDirectories = (
  commonGitDirectory: string,
  primaryCheckout: string
): ManagedDirectoryCleanup => {
  const cleanup: ManagedDirectoryCleanup = { notes: [], removed: [] };
  const { repository, root } = managedWorktreeDirectories(primaryCheckout);
  const recordsPath = managedDirectoryRecordsPath(commonGitDirectory);
  const read = readRecords(commonGitDirectory);
  if (!read.ok) {
    cleanup.notes.push(
      `Kept the managed worktree directories under ${root}: the record of the ones Simple Changes created, ${recordsPath}, is unreadable: ${read.problem}`
    );
    return cleanup;
  }
  let { records } = read;
  for (const levels of [[root, repository], [root]]) {
    try {
      records = cleanManagedLevel(levels, records, cleanup);
    } catch (error) {
      cleanup.notes.push(
        `Kept ${levels.at(-1)}: it could not be inspected: ${errorMessage(error)}`
      );
    }
  }
  if (records.length !== read.records.length) {
    try {
      writeRecords(commonGitDirectory, records);
    } catch (error) {
      cleanup.notes.push(
        `Could not update ${recordsPath}: ${errorMessage(error)}`
      );
    }
  }
  return cleanup;
};
