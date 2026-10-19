import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
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
// same folders, so only a creation record and marker (below) let cleanup
// remove one.
export const managedWorktreeDirectories = (
  primaryCheckout: string
): { repository: string; root: string } => {
  const root = resolve(dirname(primaryCheckout), ".simple-changes-worktrees");
  return {
    repository: resolve(root, slug(basename(primaryCheckout), "repository")),
    root,
  };
};

/**
 * The file Simple Changes writes, holding a random token, in each managed
 * directory it creates. A directory whose only entry is this marker, with the
 * recorded token, counts as empty.
 */
export const MANAGED_DIRECTORY_MARKER = ".simple-changes-directory";

/** One managed directory Simple Changes made, bound to its identity then. */
export interface ManagedDirectoryRecord {
  createdAt: string;
  device: string;
  inode: string;
  path: string;
  runId: string;
  token: string;
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

/** A test seam: runs just before each `rmdir`, after every check passed. */
export interface ManagedDirectoryCleanupHooks {
  beforeRemove?: (path: string) => void;
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

// A reason to keep a directory. `forget` drops its record too, because the
// directory there is provably not the one Simple Changes created.
class Kept extends Error {
  readonly forget: boolean;

  constructor(
    reason: string,
    options: { cause?: unknown; forget?: boolean } = {}
  ) {
    super(reason, { cause: options.cause });
    this.forget = options.forget ?? false;
  }
}

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

const sameObject = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const matchesRecord = (
  stats: BigIntStats,
  record: ManagedDirectoryRecord
): boolean =>
  stats.dev.toString() === record.device &&
  stats.ino.toString() === record.inode;

// `lstat` never follows the last component; a missing entry reads as null.
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

// Node has no openat or unlinkat, but a relative path resolves against the
// working directory, which the kernel holds as a directory object, not a
// path. So each step enters a directory, proves with lstat(".") that it is the
// one just checked, and acts on bare names inside it: renaming or replacing a
// path with a symbolic link afterwards cannot redirect what follows.
const enter = (entry: string, expected: BigIntStats, label: string): void => {
  process.chdir(entry);
  if (!sameObject(lstatSync(".", { bigint: true }), expected)) {
    throw new Kept(`${label} changed while it was being checked`);
  }
};

// Runs `operation`, which changes the working directory, and then returns to
// the directory the process was in, or to `fallback` when that is unknown.
const returningHere = <T>(fallback: string, operation: () => T): T => {
  let original: string | null = null;
  try {
    original = process.cwd();
  } catch {
    // The process was in a directory that no longer exists.
  }
  try {
    return operation();
  } finally {
    try {
      process.chdir(original ?? fallback);
    } catch {
      process.chdir(fallback);
    }
  }
};

// Enters the folder that holds the managed root, which must resolve to
// itself, so no level above the root is a symbolic link when it is checked.
const enterAnchor = (anchor: string): BigIntStats => {
  let resolved: string;
  try {
    resolved = realpathSync(anchor);
  } catch (error) {
    throw new Kept(`${anchor} cannot be resolved: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (resolved !== anchor) {
    throw new Kept(`${anchor} resolves through a symbolic link to ${resolved}`);
  }
  const stats = lstatSync(anchor, { bigint: true });
  if (!stats.isDirectory()) {
    throw new Kept(`${anchor} is not a directory`);
  }
  enter(anchor, stats, anchor);
  return stats;
};

// The real directory `name` in the working directory, or null when missing.
const realDirectoryEntry = (
  name: string,
  label: string
): BigIntStats | null => {
  const stats = lstatOrNull(name);
  if (!stats) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    throw new Kept(`${label} is a symbolic link`);
  }
  if (!stats.isDirectory()) {
    throw new Kept(`${label} is not a directory`);
  }
  return stats;
};

const MARKER_SIZE_LIMIT = 256;
/* biome-ignore-start lint/suspicious/noBitwiseOperators: POSIX open flags are a bitmask */
const MARKER_READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/* biome-ignore-end lint/suspicious/noBitwiseOperators: flag mask ends here */

// The token in the working directory's marker, read without following a link
// or blocking on anything that is not a regular file.
const readMarker = (): string | null => {
  let descriptor: number;
  try {
    descriptor = openSync(MANAGED_DIRECTORY_MARKER, MARKER_READ_FLAGS);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ELOOP") {
      return null;
    }
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    return stats.isFile() && stats.size <= MARKER_SIZE_LIMIT
      ? readFileSync(descriptor, "utf8").trim()
      : null;
  } finally {
    closeSync(descriptor);
  }
};

// Exclusive create: never follows or replaces an existing entry.
const writeMarker = (token: string): void => {
  writeFileSync(MANAGED_DIRECTORY_MARKER, `${token}\n`, {
    flag: "wx",
    mode: 0o600,
  });
};

// Makes `name` inside the working directory and marks it as made by this
// call, leaving the working directory inside it. Null when `name` existed.
const makeMarkedDirectory = (
  name: string,
  path: string,
  runId: string
): ManagedDirectoryRecord | null => {
  try {
    mkdirSync(name);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return null;
    }
    throw error;
  }
  const made = lstatSync(name, { bigint: true });
  if (made.isSymbolicLink() || !made.isDirectory()) {
    return null;
  }
  enter(name, made, path);
  const token = randomUUID();
  writeMarker(token);
  return {
    createdAt: new Date().toISOString(),
    device: made.dev.toString(),
    inode: made.ino.toString(),
    path,
    runId,
    token,
  };
};

const vanished = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${path} disappeared`), { code: "ENOENT" });

const PARENT_CREATION_ATTEMPTS = 3;

const createManagedLevels = (
  root: string,
  repository: string,
  runId: string,
  created: ManagedDirectoryRecord[]
): void => {
  const anchor = dirname(root);
  for (let attempt = 1; attempt <= PARENT_CREATION_ATTEMPTS; attempt += 1) {
    try {
      const anchorStats = enterAnchor(anchor);
      const rootRecord = makeMarkedDirectory(basename(root), root, runId);
      if (rootRecord) {
        created.push(rootRecord);
        enter("..", anchorStats, anchor);
      }
      const rootStats = realDirectoryEntry(basename(root), root);
      if (!rootStats) {
        throw vanished(root);
      }
      enter(basename(root), rootStats, root);
      const repositoryRecord = makeMarkedDirectory(
        basename(repository),
        repository,
        runId
      );
      if (repositoryRecord) {
        created.push(repositoryRecord);
      }
      return;
    } catch (error) {
      // Another repository's cleanup may remove the shared root, once it is
      // empty, between the two levels; start again from the anchor.
      if (
        errorCode(error) !== "ENOENT" ||
        attempt === PARENT_CREATION_ATTEMPTS
      ) {
        throw error;
      }
    }
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

/**
 * Creates the directory a prepared worktree goes in. For the managed
 * repository directory, each missing level is made on its own inside its
 * verified parent, marked with a random token, and recorded with its device,
 * inode, and token, so exactly the levels this call made, and none that
 * already existed, can later be removed. A level that cannot be made that way,
 * such as one under a symbolic link, and any other directory are created as
 * before and never recorded. Runs under the loop state lock, as cleanup does.
 */
export const createWorktreeParent = (
  commonGitDirectory: string,
  primaryCheckout: string,
  directory: string,
  runId: string
): void => {
  const { repository, root } = managedWorktreeDirectories(primaryCheckout);
  if (resolve(directory) === repository) {
    const created: ManagedDirectoryRecord[] = [];
    try {
      returningHere(primaryCheckout, () =>
        createManagedLevels(root, repository, runId, created)
      );
    } catch (error) {
      if (!(error instanceof Kept)) {
        throw error;
      }
    } finally {
      recordCreated(commonGitDirectory, created);
    }
  }
  // Makes whatever the marked walk did not; such levels are never recorded.
  mkdirSync(directory, { recursive: true });
};

type LevelOutcome = "gone" | "in-use" | "removed";

// Puts the marker back after a failed rmdir, so a later cleanup can still
// prove the directory; when that is impossible the record goes too.
const restoreMarker = (
  name: string,
  stats: BigIntStats,
  path: string,
  token: string
): void => {
  try {
    enter(name, stats, path);
    writeMarker(token);
  } catch (error) {
    throw new Kept(
      `its marker could not be restored after a failed removal (${errorMessage(error)}), so it is no longer treated as one Simple Changes created`,
      { cause: error, forget: true }
    );
  }
};

// Enters, from the anchor, each level above the last of `paths`, all real
// directories and, where recorded, still the ones Simple Changes created.
// False when a level is gone.
const enterParentLevels = (
  paths: string[],
  records: ManagedDirectoryRecord[]
): boolean => {
  enterAnchor(dirname(paths[0] ?? ""));
  for (const level of paths.slice(0, -1)) {
    const stats = realDirectoryEntry(basename(level), level);
    if (!stats) {
      return false;
    }
    const levelRecord = records.find((entry) => entry.path === level);
    if (levelRecord && !matchesRecord(stats, levelRecord)) {
      throw new Kept(
        `${level} is no longer the directory Simple Changes created there`
      );
    }
    enter(basename(level), stats, level);
  }
  return true;
};

// The recorded directory `target`, entered from its pinned parent, when it is
// still the one Simple Changes created: same identity and marker token.
const enterRecordedTarget = (
  target: string,
  record: ManagedDirectoryRecord
): BigIntStats | null => {
  const stats = lstatOrNull(basename(target));
  if (!stats) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    throw new Kept(`${target} is a symbolic link`);
  }
  if (!(stats.isDirectory() && matchesRecord(stats, record))) {
    throw new Kept(
      `${target} is no longer the directory Simple Changes created there, so its creation record was dropped`,
      { forget: true }
    );
  }
  enter(basename(target), stats, target);
  if (readMarker() !== record.token) {
    throw new Kept(
      `${target} lacks the marker Simple Changes wrote when it created it, so its creation record was dropped`,
      { forget: true }
    );
  }
  return stats;
};

// Removes the last of `paths` (each one level below the previous, starting at
// the managed root) once its only entry is the marker with `record`'s token,
// walking down from the anchor through verified, pinned directories.
const removeRecordedLevel = (
  paths: string[],
  record: ManagedDirectoryRecord,
  records: ManagedDirectoryRecord[],
  hooks: ManagedDirectoryCleanupHooks
): LevelOutcome => {
  const target = paths.at(-1) ?? "";
  if (!enterParentLevels(paths, records)) {
    return "gone";
  }
  const parent = lstatSync(".", { bigint: true });
  const stats = enterRecordedTarget(target, record);
  if (!stats) {
    return "gone";
  }
  if (readdirSync(".").length > 1) {
    return "in-use";
  }
  unlinkSync(MANAGED_DIRECTORY_MARKER);
  try {
    enter("..", parent, dirname(target));
  } catch (error) {
    throw new Kept(
      `${target} moved while it was being removed, and its marker is gone, so it is no longer treated as one Simple Changes created`,
      { cause: error, forget: true }
    );
  }
  hooks.beforeRemove?.(target);
  const name = basename(target);
  try {
    rmdirSync(name);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return "gone";
    }
    restoreMarker(name, stats, target, record.token);
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      return "in-use";
    }
    throw error;
  }
  return "removed";
};

// An empty managed directory without a record stays; say so, because it
// looks like one cleanup should have removed.
// Never throws: a level it cannot inspect is a note too.
const unrecordedEmptyNote = (directory: string): string | null => {
  try {
    const stats = lstatOrNull(directory);
    if (!stats?.isDirectory()) {
      return null;
    }
    return readdirSync(directory).length === 0
      ? `Kept empty ${directory}: this repository has no record that Simple Changes created it, so only whoever made it should remove it (with rmdir).`
      : null;
  } catch (error) {
    return `Kept ${directory}: it could not be inspected: ${errorMessage(error)}`;
  }
};

// Handles one managed level and returns the records to keep.
const cleanManagedLevel = (
  paths: string[],
  records: ManagedDirectoryRecord[],
  primaryCheckout: string,
  hooks: ManagedDirectoryCleanupHooks,
  cleanup: ManagedDirectoryCleanup
): ManagedDirectoryRecord[] => {
  const target = paths.at(-1) ?? "";
  const record = records.find((entry) => entry.path === target);
  if (!record) {
    const note = unrecordedEmptyNote(target);
    if (note) {
      cleanup.notes.push(note);
    }
    return records;
  }
  const others = records.filter((entry) => entry.path !== target);
  try {
    const outcome = returningHere(primaryCheckout, () =>
      removeRecordedLevel(paths, record, records, hooks)
    );
    if (outcome === "removed") {
      cleanup.removed.push(target);
    }
    return outcome === "in-use" ? records : others;
  } catch (error) {
    if (error instanceof Kept) {
      cleanup.notes.push(`Kept ${target}: ${error.message}.`);
      return error.forget ? others : records;
    }
    cleanup.notes.push(
      `Could not remove the empty managed worktree directory ${target}: ${errorMessage(error)}`
    );
    return records;
  }
};

/**
 * Removes the managed repository directory, then the managed root, once each
 * holds nothing but its marker, only when this repository recorded creating
 * it and it still has the recorded device, inode, and marker token. Every
 * level is reached from the anchor through real directories, each verified
 * after entering it, and `rmdir` acts on a bare name inside the verified
 * parent, so no symbolic link, before or during the pass, can redirect it.
 * Everything else is kept: directories a person, plain Git, or an older
 * runtime made, pre-existing ones `prepare-agent` reused, and any that still
 * hold something. Failures are returned as notes, never thrown.
 */
export const removeEmptyManagedWorktreeDirectories = (
  commonGitDirectory: string,
  primaryCheckout: string,
  hooks: ManagedDirectoryCleanupHooks = {}
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
  for (const paths of [[root, repository], [root]]) {
    records = cleanManagedLevel(
      paths,
      records,
      primaryCheckout,
      hooks,
      cleanup
    );
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
