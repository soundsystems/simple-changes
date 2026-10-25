import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statfsSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  completeListing,
  completeObjectId,
  completeRevisionList,
} from "./git-complete.ts";
import { parseWorktreeList } from "./inventory.ts";
import { runGit, runGitWithInput } from "./process.ts";
import { validateSchema } from "./schema.ts";

// A reviewed checkout is copied here before it is removed, so the removal is
// reversible for as long as the archive is retained. Layout, under the Git
// common directory: `simple-changes/archives/<archive id>/` holding
// `manifest.json`, `checkout/` (the checkout folder), `git/` (its private Git
// directory) and, while a restore runs, `restoring.json`; plus
// `simple-changes/archives/prune-log.json`, one record per pruned archive.

export const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
export const ARCHIVE_FREE_SPACE_MARGIN_BYTES = 64 * 1024 ** 2;
export const ARCHIVE_ID_PATTERN =
  /^archive-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}-[0-9a-f]{8}$/u;

const STATE_DIRECTORY = "simple-changes";
const ARCHIVES_DIRECTORY = "archives";
const MANIFEST_FILENAME = "manifest.json";
const RESTORING_FILENAME = "restoring.json";
const PRUNE_LOG_FILENAME = "prune-log.json";
const CHECKOUT_FOLDER = "checkout";
const GIT_FOLDER = "git";
const PIN_NAMESPACE_ROOT = "refs/simple-changes/archives";
const CHUNK_BYTES = 64 * 1024;
const OBJECT_SCAN_LIMIT_BYTES = 1024 ** 2;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SUMMARY_LIMIT = 5;
const APPROVER_MAXIMUM_LENGTH = 128;
const REASON_MAXIMUM_LENGTH = 500;
const REPLACEMENT_CHARACTER = "\uFFFD";
const OBJECT_ID_TOKEN_PATTERN =
  /(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])/gu;
const DIGEST_PREFIX_PATTERN = /^[0-9a-f]{8}/u;
const STAMP_SEPARATOR_PATTERN = /[-:]/gu;
const EXTENDED_REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/gu;
const TRAILING_PERIODS = /\.+$/u;
const NUL = "\u0000";

/* biome-ignore-start lint/suspicious/noBitwiseOperators: POSIX open flags and permission bits are bit masks */
// O_NONBLOCK keeps a read from hanging when a named pipe replaced a file
// between the lstat and the open; on a regular file it changes nothing.
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;
const permissionBits = (mode: number): number => mode & 0o7777;
/* biome-ignore-end lint/suspicious/noBitwiseOperators: masks end here */

export type ArchiveEntryType = "file" | "directory" | "symlink";
export interface ArchiveEntry {
  linkTarget: string | null;
  mode: number;
  path: string;
  sha256: string | null;
  size: number;
  type: ArchiveEntryType;
}
/** Entries sorted by path in code point order; `bytes` sums file sizes. */
export interface ArchiveTree {
  bytes: number;
  count: number;
  entries: ArchiveEntry[];
}
export interface ArchivePinRef {
  object: string;
  ref: string;
}
/**
 * One `branch.<name>.*` entry, as `{ key: "branch.old.description", value }`.
 * A `null` value is a key written without `=`, which Git reads as true;
 * restore writes it back as `true`, the same meaning in a form Git can write.
 */
export interface ArchiveBranchConfig {
  key: string;
  value: string | null;
}
export interface WorktreeArchiveManifest {
  archiveId: string;
  branchConfig: ArchiveBranchConfig[];
  checkout: ArchiveTree;
  commonGitDirectory: string;
  createdAt: string;
  expiresAt: string;
  gitDirectory: ArchiveTree;
  kind: "worktree-archive";
  pinRefs: ArchivePinRef[];
  privateGitDirectory: string;
  receiptDigest: string;
  removalId: string;
  replacementCommits: string[];
  repositoryId: string;
  retention: { days: number; maxTotalBytes: number };
  schemaVersion: 1;
  source: {
    branch: string | null;
    changeDigest: string;
    headSha: string;
    path: string;
  };
  targetRef: string;
}
/**
 * One prune-log record. `createdAt`, `expiresAt`, `receiptDigest` and
 * `source` come from the manifest; they are null only for an archive pruned
 * by id whose manifest did not parse.
 */
export interface ArchivePruneRecord {
  approvedBy: string | null;
  archiveId: string;
  bytes: number;
  cause: "expired" | "size-cap" | "manual";
  command: "prune" | "worktree-cleanup" | "loop-finalize" | "prune-archives";
  createdAt: string | null;
  expiresAt: string | null;
  kind: "worktree-archive-prune";
  pinRefsDeleted: string[];
  prunedAt: string;
  reason: string | null;
  receiptDigest: string | null;
  schemaVersion: 1;
  source: { branch: string | null; headSha: string; path: string } | null;
}

const refusal = (
  message: string,
  exitCode: number = EXIT_CODES.unsafe
): SimpleChangesError => new SimpleChangesError(message, exitCode);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Every file system failure leaves as a SimpleChangesError that names the
// path, so callers can report it without inspecting Node error codes.
const guarded = <T>(action: string, operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SimpleChangesError) {
      throw error;
    }
    throw SimpleChangesError.withCause(
      `Could not ${action}: ${errorText(error)}`,
      EXIT_CODES.unsafe,
      error
    );
  }
};

const summarize = (differences: readonly string[]): string => {
  const shown = differences.slice(0, SUMMARY_LIMIT).join("; ");
  const more = differences.length - SUMMARY_LIMIT;
  return more > 0 ? `${shown}; and ${more} more` : shown;
};

// UTF-8 byte order is code point order, unlike `<` on UTF-16 strings.
const compareCodePoints = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}${sep}`);

// A path's comparable form: its parent resolved through links, so `/var` and
// `/private/var` spellings of one folder compare equal even when the last
// component does not exist.
const comparablePath = (path: string): string => {
  const absolute = resolve(path);
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
};

const assertArchiveId = (archiveId: string): void => {
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
    throw refusal(
      `${JSON.stringify(archiveId)} is not an archive ID; archive IDs look like archive-20261022T120000Z-1a2b3c4d-5e6f7a8b. Run \`simple-changes worktree archives\` to list them.`,
      EXIT_CODES.usage
    );
  }
};

export const worktreeArchivesRoot = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY, ARCHIVES_DIRECTORY);

/** The ref namespace an archive's pins live under, without a trailing slash. */
export const archivePinNamespace = (archiveId: string): string => {
  assertArchiveId(archiveId);
  return `${PIN_NAMESPACE_ROOT}/${archiveId}`;
};

export const worktreeArchiveDirectory = (
  commonGitDirectory: string,
  archiveId: string
): string => {
  assertArchiveId(archiveId);
  return resolve(worktreeArchivesRoot(commonGitDirectory), archiveId);
};

export const archivePruneLogPath = (commonGitDirectory: string): string =>
  resolve(worktreeArchivesRoot(commonGitDirectory), PRUNE_LOG_FILENAME);

export const newArchiveId = (
  createdAt: Date,
  receiptDigest: string
): string => {
  const prefix = DIGEST_PREFIX_PATTERN.exec(receiptDigest)?.[0];
  if (Number.isNaN(createdAt.getTime()) || !prefix) {
    throw refusal(
      "An archive ID needs a valid creation time and a lowercase hexadecimal receipt digest.",
      EXIT_CODES.usage
    );
  }
  const stamp = `${createdAt
    .toISOString()
    .slice(0, 19)
    .replace(STAMP_SEPARATOR_PATTERN, "")}Z`;
  const archiveId = `archive-${stamp}-${prefix}-${randomBytes(4).toString("hex")}`;
  assertArchiveId(archiveId);
  return archiveId;
};

const lstatOrNull = (path: string): Stats | null =>
  guarded(
    `read ${path}`,
    () => lstatSync(path, { throwIfNoEntry: false }) ?? null
  );

const describeSpecial = (stats: Stats): string => {
  if (stats.isFIFO()) {
    return "a named pipe (FIFO)";
  }
  if (stats.isSocket()) {
    return "a socket";
  }
  if (stats.isBlockDevice() || stats.isCharacterDevice()) {
    return "a device";
  }
  return "neither a file, a folder nor a symbolic link";
};

const entryType = (path: string, stats: Stats): ArchiveEntryType => {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  throw refusal(
    `${path} is ${describeSpecial(stats)}, which an archive cannot hold: an archive keeps only files, folders and symbolic links. Move it out of the checkout and run the command again.`
  );
};

const assertRealDirectory = (path: string): Stats => {
  const stats = lstatOrNull(path);
  if (!stats) {
    throw refusal(`${path} does not exist.`);
  }
  if (stats.isSymbolicLink()) {
    throw refusal(
      `${path} is a symbolic link. Simple Changes never follows a symbolic link when it archives, verifies or restores a checkout, so it will not read or write through this one.`
    );
  }
  if (!stats.isDirectory()) {
    throw refusal(`${path} is not a folder.`);
  }
  return stats;
};

const directoryNames = (path: string): string[] => {
  const names = guarded(`list ${path}`, () => readdirSync(path));
  const lossy = names.find((name) => name.includes(REPLACEMENT_CHARACTER));
  if (lossy !== undefined) {
    throw refusal(
      `${join(path, lossy)} has a name that is not valid UTF-8, so Simple Changes cannot copy it exactly. Rename or move it and run the command again.`
    );
  }
  return names.sort(compareCodePoints);
};

const readLinkTarget = (path: string): string => {
  const target = guarded(`read the symbolic link ${path}`, () =>
    readlinkSync(path)
  );
  if (target.includes(REPLACEMENT_CHARACTER)) {
    throw refusal(
      `The symbolic link ${path} points at a name that is not valid UTF-8, so Simple Changes cannot copy it exactly. Replace the link and run the command again.`
    );
  }
  return target;
};

const childPath = (relativeDirectory: string, name: string): string =>
  relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;

interface WalkedEntry {
  absolute: string;
  relative: string;
  stats: Stats;
  type: ArchiveEntryType;
}

// Every entry under `root`, by lstat, never following a link; the root itself
// must be a real folder.
const walkTree = (root: string): WalkedEntry[] => {
  assertRealDirectory(root);
  const walked: WalkedEntry[] = [];
  const pending = [""];
  let relativeDirectory = pending.pop();
  while (relativeDirectory !== undefined) {
    for (const name of directoryNames(join(root, relativeDirectory))) {
      const relative = childPath(relativeDirectory, name);
      const absolute = join(root, relative);
      const stats = guarded(`read ${absolute}`, () => lstatSync(absolute));
      const type = entryType(absolute, stats);
      walked.push({ absolute, relative, stats, type });
      if (type === "directory") {
        pending.push(relative);
      }
    }
    relativeDirectory = pending.pop();
  }
  return walked;
};

const withDescriptor = <T>(descriptor: number, use: () => T): T => {
  try {
    return use();
  } finally {
    closeSync(descriptor);
  }
};

const openRegularFile = (path: string): number => {
  const descriptor = guarded(`open ${path}`, () => openSync(path, READ_FLAGS));
  if (!fstatSync(descriptor).isFile()) {
    closeSync(descriptor);
    throw refusal(
      `${path} stopped being a regular file while Simple Changes read it. Run the command again.`
    );
  }
  return descriptor;
};

const writeFully = (descriptor: number, chunk: Buffer, path: string): void =>
  guarded(`write ${path}`, () => {
    let offset = 0;
    while (offset < chunk.length) {
      offset += writeSync(descriptor, chunk, offset, chunk.length - offset);
    }
  });

// Reads the open file in chunks, hashing every byte and handing each chunk to
// `sink`, so a copy's digest is the digest of the bytes it wrote.
const streamFile = (
  descriptor: number,
  path: string,
  sink?: (chunk: Buffer) => void
): { sha256: string; size: number } => {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const readChunk = (): number =>
    guarded(`read ${path}`, () =>
      readSync(descriptor, buffer, 0, CHUNK_BYTES, null)
    );
  let size = 0;
  let count = readChunk();
  while (count > 0) {
    const chunk = buffer.subarray(0, count);
    digest.update(chunk);
    sink?.(chunk);
    size += count;
    count = readChunk();
  }
  return { sha256: digest.digest("hex"), size };
};

const directoryEntry = (relative: string, mode: number): ArchiveEntry => ({
  linkTarget: null,
  mode,
  path: relative,
  sha256: null,
  size: 0,
  type: "directory",
});

const symlinkEntry = (relative: string, linkTarget: string): ArchiveEntry => ({
  linkTarget,
  mode: 0,
  path: relative,
  sha256: null,
  size: 0,
  type: "symlink",
});

const scannedEntry = (item: WalkedEntry): ArchiveEntry => {
  if (item.type === "symlink") {
    return symlinkEntry(item.relative, readLinkTarget(item.absolute));
  }
  if (item.type === "directory") {
    return directoryEntry(item.relative, permissionBits(item.stats.mode));
  }
  const descriptor = openRegularFile(item.absolute);
  const contents = withDescriptor(descriptor, () =>
    streamFile(descriptor, item.absolute)
  );
  return {
    linkTarget: null,
    mode: permissionBits(item.stats.mode),
    path: item.relative,
    sha256: contents.sha256,
    size: contents.size,
    type: "file",
  };
};

const treeOf = (entries: ArchiveEntry[]): ArchiveTree => {
  const sorted = [...entries].sort((left, right) =>
    compareCodePoints(left.path, right.path)
  );
  return {
    bytes: sorted.reduce(
      (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
      0
    ),
    count: sorted.length,
    entries: sorted,
  };
};

/**
 * Every entry under `root` with its type, permission bits, size, content
 * digest and link target. Never follows a symbolic link, the root included,
 * and refuses anything that is not a file, folder or link.
 */
export const scanTree = (root: string): ArchiveTree =>
  treeOf(walkTree(root).map(scannedEntry));

/** The same walk as `scanTree` without reading file contents. */
export const measureTree = (root: string): { bytes: number; count: number } => {
  const walked = walkTree(root);
  return {
    bytes: walked.reduce(
      (sum, item) => sum + (item.type === "file" ? item.stats.size : 0),
      0
    ),
    count: walked.length,
  };
};

// Directories are made writable first so a read-only folder copied from a
// checkout does not stop its own removal.
const makeRemovable = (path: string): void => {
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    makeRemovable(join(path, name));
  }
};

const removeTree = (path: string): void => {
  makeRemovable(path);
  rmSync(path, { force: true, recursive: true });
};

/**
 * Removes an archive folder that is not worth keeping (its manifest could
 * not be written), making read-only folders removable first.
 */
export const discardArchiveDirectory = (directory: string): void =>
  guarded(`remove ${directory}`, () => removeTree(directory));

const discardPartial = (path: string, error: unknown): never => {
  try {
    removeTree(path);
  } catch (cleanupError) {
    throw SimpleChangesError.withCause(
      `${errorText(error)} The partial copy at ${path} could not be removed (${errorText(cleanupError)}); remove it by hand.`,
      error instanceof SimpleChangesError ? error.exitCode : EXIT_CODES.unsafe,
      error
    );
  }
  throw error;
};

const copyRegularFile = (
  from: string,
  to: string,
  relative: string
): ArchiveEntry => {
  const input = openRegularFile(from);
  return withDescriptor(input, () => {
    const mode = permissionBits(fstatSync(input).mode);
    const output = guarded(`create ${to}`, () =>
      openSync(to, WRITE_FLAGS, 0o600)
    );
    return withDescriptor(output, () => {
      const contents = streamFile(input, from, (chunk) =>
        writeFully(output, chunk, to)
      );
      guarded(`set the mode of ${to}`, () => fchmodSync(output, mode));
      return {
        linkTarget: null,
        mode,
        path: relative,
        sha256: contents.sha256,
        size: contents.size,
        type: "file",
      };
    });
  });
};

const copySymbolicLink = (
  from: string,
  to: string,
  relative: string
): ArchiveEntry => {
  const linkTarget = readLinkTarget(from);
  guarded(`create the symbolic link ${to}`, () => symlinkSync(linkTarget, to));
  return symlinkEntry(relative, linkTarget);
};

const copyDirectoryContents = (
  sourceDirectory: string,
  destinationDirectory: string,
  relativeDirectory: string,
  entries: ArchiveEntry[]
): void => {
  for (const name of directoryNames(sourceDirectory)) {
    const from = join(sourceDirectory, name);
    const to = join(destinationDirectory, name);
    const relative = childPath(relativeDirectory, name);
    const stats = guarded(`read ${from}`, () => lstatSync(from));
    const type = entryType(from, stats);
    if (type === "file") {
      entries.push(copyRegularFile(from, to, relative));
    } else if (type === "symlink") {
      entries.push(copySymbolicLink(from, to, relative));
    } else {
      // Filled while writable, then given the source mode, so a read-only
      // folder copies with its contents.
      guarded(`create ${to}`, () => mkdirSync(to, { mode: 0o700 }));
      copyDirectoryContents(from, to, relative, entries);
      const mode = permissionBits(stats.mode);
      guarded(`set the mode of ${to}`, () => chmodSync(to, mode));
      entries.push(directoryEntry(relative, mode));
    }
  }
};

/**
 * Copies the folder `source` to `destination`, which must not exist: files by
 * content with their permission bits, folders with their modes, symbolic
 * links as links. Returns the entries hashed from the bytes copied. On any
 * error, everything it created under `destination` is removed.
 */
export const copyTree = (source: string, destination: string): ArchiveTree => {
  const rootStats = assertRealDirectory(source);
  const from = resolve(source);
  const to = resolve(destination);
  if (lstatOrNull(to)) {
    throw refusal(
      `Cannot copy ${from} to ${to}: something already exists at ${to}. Nothing was copied.`
    );
  }
  const realSource = guarded(`resolve ${from}`, () => realpathSync(from));
  if (isInside(comparablePath(to), realSource)) {
    throw refusal(
      `Cannot copy ${from} into ${to}, a path inside it. Nothing was copied.`
    );
  }
  guarded(`create ${to}`, () => mkdirSync(to, { mode: 0o700 }));
  const entries: ArchiveEntry[] = [];
  try {
    copyDirectoryContents(from, to, "", entries);
    guarded(`set the mode of ${to}`, () =>
      chmodSync(to, permissionBits(rootStats.mode))
    );
  } catch (error) {
    return discardPartial(to, error);
  }
  return treeOf(entries);
};

const formatMode = (mode: number): string =>
  `0${mode.toString(8).padStart(3, "0")}`;

const entryChanges = (
  expected: ArchiveEntry,
  actual: ArchiveEntry
): string[] => {
  if (expected.type !== actual.type) {
    return [`was a ${expected.type}, is now a ${actual.type}`];
  }
  const changes: string[] = [];
  if (expected.mode !== actual.mode) {
    changes.push(
      `mode ${formatMode(expected.mode)} is now ${formatMode(actual.mode)}`
    );
  }
  if (expected.size !== actual.size) {
    changes.push(`size ${expected.size} bytes is now ${actual.size}`);
  }
  if (expected.sha256 !== actual.sha256) {
    changes.push("contents differ");
  }
  if (expected.linkTarget !== actual.linkTarget) {
    changes.push(
      `link target ${JSON.stringify(expected.linkTarget)} is now ${JSON.stringify(actual.linkTarget)}`
    );
  }
  return changes;
};

const treeDifferences = (
  expected: ArchiveTree,
  actual: ArchiveTree,
  prefix: string
): string[] => {
  const actualByPath = new Map(
    actual.entries.map((entry) => [entry.path, entry])
  );
  const expectedPaths = new Set(expected.entries.map((entry) => entry.path));
  const differences: string[] = [];
  for (const entry of expected.entries) {
    const found = actualByPath.get(entry.path);
    const changes = found
      ? entryChanges(entry, found)
      : [`missing (a ${entry.type} was recorded)`];
    if (changes.length > 0) {
      differences.push(`${prefix}${entry.path}: ${changes.join(", ")}`);
    }
  }
  for (const entry of actual.entries) {
    if (!expectedPaths.has(entry.path)) {
      differences.push(
        `${prefix}${entry.path}: an extra ${entry.type} that was not recorded`
      );
    }
  }
  if (
    differences.length === 0 &&
    (expected.bytes !== actual.bytes || expected.count !== actual.count)
  ) {
    differences.push(
      `${prefix || "tree"}: totals differ (${expected.count} entries and ${expected.bytes} bytes recorded, ${actual.count} entries and ${actual.bytes} bytes found)`
    );
  }
  return differences.sort(compareCodePoints);
};

/**
 * Human-readable differences between two trees, one line per path that is
 * missing, extra, or differs in type, mode, size, content or link target;
 * empty when they are identical.
 */
export const compareTrees = (
  expected: ArchiveTree,
  actual: ArchiveTree
): string[] => treeDifferences(expected, actual, "");

// The reflogs are not scanned as text: the caller names the commits they
// hold through Git, which also reads the branch's reflog in the common
// directory and a ref backend that keeps no reflog files.
const isObjectNamingFile = (item: WalkedEntry): boolean =>
  item.type === "file" &&
  item.relative !== "index" &&
  !item.relative.startsWith("logs/");

const isScannedForObjectIds = (item: WalkedEntry): boolean =>
  isObjectNamingFile(item) && item.stats.size <= OBJECT_SCAN_LIMIT_BYTES;

/** The most bytes of one Git state file the object scan reads. */
export const OBJECT_SCAN_LIMIT = OBJECT_SCAN_LIMIT_BYTES;

/**
 * The regular files of a Git directory tree that the object scan would have
 * to skip for their size (everything but the index and the reflogs is
 * scanned). A caller that must pin every object such a file names refuses
 * instead of pinning part of it.
 */
export const oversizedScanFiles = (gitTreeRoot: string): string[] =>
  walkTree(gitTreeRoot)
    .filter(
      (item) =>
        isObjectNamingFile(item) && item.stats.size > OBJECT_SCAN_LIMIT_BYTES
    )
    .map((item) => `${item.relative} (${item.stats.size} bytes)`);

const readSmallFile = (path: string): string => {
  const descriptor = openRegularFile(path);
  return withDescriptor(descriptor, () =>
    guarded(`read ${path}`, () => readFileSync(descriptor).toString("latin1"))
  );
};

/**
 * Distinct 40- and 64-digit hexadecimal tokens in the regular files of a Git
 * directory tree, sorted: the objects its state files may name (sequencer
 * and rebase state, autostash, pseudo-refs). The index, the reflogs (which
 * the caller reads through Git) and files over 1 MiB are not read. The
 * caller resolves each candidate.
 */
export const objectIdCandidates = (gitTreeRoot: string): string[] => {
  const found = new Set<string>();
  for (const item of walkTree(gitTreeRoot).filter(isScannedForObjectIds)) {
    for (const match of readSmallFile(item.absolute).matchAll(
      OBJECT_ID_TOKEN_PATTERN
    )) {
      found.add(match[0]);
    }
  }
  return [...found].sort(compareCodePoints);
};

const nearestExistingPath = (path: string): string => {
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) {
    current = dirname(current);
  }
  return current;
};

const isByteCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * Refuses an archive above `maxArchiveBytes`, or when the filesystem that
 * holds `root` (or its nearest existing ancestor) has less free space than
 * the archive plus a margin.
 */
export const assertArchiveCapacity = (input: {
  bytes: number;
  maxArchiveBytes: number;
  root: string;
}): void => {
  if (
    !(
      isByteCount(input.bytes) &&
      isByteCount(input.maxArchiveBytes) &&
      input.maxArchiveBytes > 0
    )
  ) {
    throw refusal(
      "Archive sizes must be whole numbers of bytes, and the limit must be at least 1.",
      EXIT_CODES.usage
    );
  }
  if (input.bytes > input.maxArchiveBytes) {
    throw refusal(
      `The archive would hold ${input.bytes} bytes, more than the ${input.maxArchiveBytes}-byte limit for one archive. Nothing was copied. Raise the limit with --max-archive-bytes, or move large untracked files out of the checkout first.`
    );
  }
  const existing = nearestExistingPath(input.root);
  const stats = guarded(`read the free space of ${existing}`, () =>
    statfsSync(existing)
  );
  const free = stats.bavail * stats.bsize;
  const needed = input.bytes + ARCHIVE_FREE_SPACE_MARGIN_BYTES;
  if (free < needed) {
    throw refusal(
      `The filesystem holding ${input.root} has ${free} bytes free, and the archive needs ${input.bytes} bytes plus a ${ARCHIVE_FREE_SPACE_MARGIN_BYTES}-byte margin (${needed} bytes). Nothing was copied. Free some space and run the command again.`
    );
  }
};

export interface ArchiveCopyInput {
  archiveId: string;
  checkoutPath: string;
  commonGitDirectory: string;
  privateGitDirectory: string;
}
export interface ArchiveCopy {
  checkout: ArchiveTree;
  directory: string;
  gitDirectory: ArchiveTree;
  objectIdCandidates: string[];
}

const ensureArchivesRoot = (commonGitDirectory: string): string => {
  const root = worktreeArchivesRoot(commonGitDirectory);
  guarded(`create ${root}`, () =>
    mkdirSync(root, { mode: 0o700, recursive: true })
  );
  assertRealDirectory(root);
  return root;
};

// A source that contains the archive would copy itself without end, and a
// source inside the archives would archive an archive.
const assertSeparateFromArchive = (
  root: string,
  directory: string,
  sources: readonly string[]
): void => {
  const archive = comparablePath(directory);
  const archives = comparablePath(root);
  for (const source of sources) {
    const real = comparablePath(source);
    if (isInside(archive, real) || isInside(real, archives)) {
      throw refusal(
        `Cannot archive ${source} into ${directory}: one contains the other. Nothing was copied.`
      );
    }
  }
};

/**
 * Creates `<archives root>/<archiveId>/` (mode 0700), copies the checkout
 * folder into `checkout/` and the private Git directory into `git/`, then
 * walks both copies again and compares them with what was copied. On any
 * failure the whole archive folder is removed and the error is rethrown.
 */
export const copyWorktreeIntoArchive = (
  input: ArchiveCopyInput
): ArchiveCopy => {
  const directory = worktreeArchiveDirectory(
    input.commonGitDirectory,
    input.archiveId
  );
  const root = ensureArchivesRoot(input.commonGitDirectory);
  assertSeparateFromArchive(root, directory, [
    input.checkoutPath,
    input.privateGitDirectory,
  ]);
  if (lstatOrNull(directory)) {
    throw refusal(
      `Archive ${input.archiveId} already exists at ${directory}. Nothing was copied; make a new archive ID and run the command again.`
    );
  }
  guarded(`create ${directory}`, () => mkdirSync(directory, { mode: 0o700 }));
  try {
    const checkoutCopy = join(directory, CHECKOUT_FOLDER);
    const gitCopy = join(directory, GIT_FOLDER);
    const checkout = copyTree(input.checkoutPath, checkoutCopy);
    const gitDirectory = copyTree(input.privateGitDirectory, gitCopy);
    const differences = [
      ...treeDifferences(checkout, scanTree(checkoutCopy), "checkout/"),
      ...treeDifferences(gitDirectory, scanTree(gitCopy), "git/"),
    ];
    if (differences.length > 0) {
      throw refusal(
        `The archive copy does not match what was read (${summarize(differences)}). The partial archive was removed and nothing else changed; run the command again.`
      );
    }
    // The object scan reads this copy, so a state file that grew past the
    // scan limit between the caller's own checks and the copy is caught
    // here, and the partial archive is discarded like any other copy failure.
    const oversized = oversizedScanFiles(gitCopy);
    if (oversized.length > 0) {
      throw refusal(
        `The copied private Git directory holds ${oversized.join(", ")}, larger than the ${OBJECT_SCAN_LIMIT_BYTES} bytes the object scan reads, so the objects they name could not all be pinned. The partial archive was removed and nothing else changed; shrink or remove those files (for FETCH_HEAD, run \`git fetch\` without --append) and run the command again.`
      );
    }
    return {
      checkout,
      directory,
      gitDirectory,
      objectIdCandidates: objectIdCandidates(gitCopy),
    };
  } catch (error) {
    return discardPartial(directory, error);
  }
};

const treeProblems = (tree: ArchiveTree, name: string): string[] => {
  const problems: string[] = [];
  if (tree.count !== tree.entries.length) {
    problems.push(
      `${name} counts ${tree.count} entries but lists ${tree.entries.length}`
    );
  }
  const bytes = tree.entries.reduce(
    (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
    0
  );
  if (tree.bytes !== bytes) {
    problems.push(
      `${name} records ${tree.bytes} bytes but its files sum to ${bytes}`
    );
  }
  const unordered = tree.entries.findIndex(
    (entry, index) =>
      index > 0 &&
      compareCodePoints(tree.entries[index - 1]?.path ?? "", entry.path) >= 0
  );
  if (unordered > 0) {
    problems.push(
      `${name} entries are not sorted and distinct at ${tree.entries[unordered]?.path ?? ""}`
    );
  }
  return problems;
};

const assertManifestConsistent = (
  directory: string,
  manifest: WorktreeArchiveManifest
): void => {
  const problems = [
    ...(basename(directory) === manifest.archiveId
      ? []
      : [`it names archive ${manifest.archiveId}`]),
    ...treeProblems(manifest.checkout, "checkout"),
    ...treeProblems(manifest.gitDirectory, "gitDirectory"),
  ];
  if (problems.length > 0) {
    throw refusal(
      `The manifest of archive ${basename(directory)} is inconsistent: ${problems.join("; ")}.`,
      EXIT_CODES.validation
    );
  }
};

// A state file's text, never through a link and never blocking on a pipe;
// null when nothing is there.
const readStateFile = (path: string): string | null => {
  const stats = lstatOrNull(path);
  if (!stats) {
    return null;
  }
  if (!stats.isFile()) {
    throw refusal(`${path} is not a regular file.`, EXIT_CODES.validation);
  }
  const descriptor = openRegularFile(path);
  return withDescriptor(descriptor, () =>
    guarded(`read ${path}`, () => readFileSync(descriptor, "utf8"))
  );
};

const parseJson = (text: string, path: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw SimpleChangesError.withCause(
      `${path} is not valid JSON: ${errorText(error)}`,
      EXIT_CODES.validation,
      error
    );
  }
};

const writeJsonAtomically = (path: string, value: unknown): void => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  guarded(`write ${temporaryPath}`, () =>
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
  );
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw SimpleChangesError.withCause(
      `Could not write ${path}: ${errorText(error)}`,
      EXIT_CODES.unsafe,
      error
    );
  }
};

/** Strict: a missing, unparsable, invalid or inconsistent manifest throws. */
export const readWorktreeArchiveManifest = (
  directory: string
): WorktreeArchiveManifest => {
  const path = join(directory, MANIFEST_FILENAME);
  const text = readStateFile(path);
  if (text === null) {
    throw refusal(
      `Archive ${basename(directory)} has no ${MANIFEST_FILENAME}, so Simple Changes cannot verify, restore or automatically prune it. Inspect ${directory}; remove it with \`simple-changes worktree prune-archives --archive ${basename(directory)}\` when it is not needed.`
    );
  }
  const manifest = validateSchema<WorktreeArchiveManifest>(
    "worktree-archive",
    parseJson(text, path)
  );
  assertManifestConsistent(directory, manifest);
  return manifest;
};

/** Validates the manifest, writes `manifest.json` atomically, reads it back. */
export const writeWorktreeArchiveManifest = (
  directory: string,
  manifest: WorktreeArchiveManifest
): string => {
  const validated = validateSchema<WorktreeArchiveManifest>(
    "worktree-archive",
    manifest
  );
  assertManifestConsistent(directory, validated);
  assertRealDirectory(directory);
  const path = join(directory, MANIFEST_FILENAME);
  writeJsonAtomically(path, validated);
  readWorktreeArchiveManifest(directory);
  return path;
};

const scanDifferences = (
  expected: ArchiveTree,
  root: string,
  prefix: string
): string[] => {
  try {
    return treeDifferences(expected, scanTree(root), prefix);
  } catch (error) {
    if (error instanceof SimpleChangesError) {
      return [`${prefix || root}: could not be read (${error.message})`];
    }
    throw error;
  }
};

/** Differences between the archive's `checkout/` and `git/` and its manifest. */
export const verifyWorktreeArchive = (
  directory: string,
  manifest: WorktreeArchiveManifest
): string[] => [
  ...scanDifferences(
    manifest.checkout,
    join(directory, CHECKOUT_FOLDER),
    `${CHECKOUT_FOLDER}/`
  ),
  ...scanDifferences(
    manifest.gitDirectory,
    join(directory, GIT_FOLDER),
    `${GIT_FOLDER}/`
  ),
];

/**
 * Differences between the live checkout folder and private Git directory and
 * the manifest, by walking and hashing them now; no Git command runs.
 */
export const compareLiveWithManifest = (
  manifest: WorktreeArchiveManifest
): string[] => [
  ...scanDifferences(
    manifest.checkout,
    manifest.source.path,
    `${manifest.source.path}/`
  ),
  ...scanDifferences(
    manifest.gitDirectory,
    manifest.privateGitDirectory,
    `${manifest.privateGitDirectory}/`
  ),
];

export interface RestoringMarker {
  pid: number;
  startedAt: string;
}

export const restoringMarkerPath = (directory: string): string =>
  join(directory, RESTORING_FILENAME);

const isRestoringMarker = (value: unknown): value is RestoringMarker =>
  isRecord(value) &&
  Object.keys(value).sort().join(",") === "pid,startedAt" &&
  typeof value.pid === "number" &&
  Number.isSafeInteger(value.pid) &&
  value.pid > 0 &&
  typeof value.startedAt === "string" &&
  !Number.isNaN(Date.parse(value.startedAt));

/** The restore marker, null when absent; a marker that does not parse throws. */
export const readRestoringMarker = (
  directory: string
): RestoringMarker | null => {
  const path = restoringMarkerPath(directory);
  const text = readStateFile(path);
  if (text === null) {
    return null;
  }
  const value = parseJson(text, path);
  if (!isRestoringMarker(value)) {
    throw refusal(
      `${path} is not a restore marker ({ pid, startedAt }). A restore of this archive may have stopped half way; restore it again or prune it by ID.`,
      EXIT_CODES.validation
    );
  }
  return { pid: value.pid, startedAt: value.startedAt };
};

const writeRestoringMarker = (directory: string): void =>
  writeJsonAtomically(restoringMarkerPath(directory), {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  } satisfies RestoringMarker);

const removeRestoringMarker = (directory: string): void =>
  guarded(`remove ${restoringMarkerPath(directory)}`, () =>
    rmSync(restoringMarkerPath(directory), { force: true })
  );

export interface ArchiveListing {
  archiveId: string;
  directory: string;
  error: string | null;
  manifest: WorktreeArchiveManifest | null;
  restoring: RestoringMarker | null;
}

const readOrRecord = <T>(read: () => T, problems: string[]): T | null => {
  try {
    return read();
  } catch (error) {
    if (error instanceof SimpleChangesError) {
      problems.push(error.message);
      return null;
    }
    throw error;
  }
};

const archiveListing = (directory: string): ArchiveListing => {
  const problems: string[] = [];
  const manifest = readOrRecord(
    () => readWorktreeArchiveManifest(directory),
    problems
  );
  const restoring = readOrRecord(
    () => readRestoringMarker(directory),
    problems
  );
  return {
    archiveId: basename(directory),
    directory,
    error: problems.length > 0 ? problems.join(" ") : null,
    manifest,
    restoring,
  };
};

/**
 * Every folder under the archives root named like an archive, sorted by ID.
 * A manifest or marker that does not parse is reported in `error`.
 */
export const listWorktreeArchives = (
  commonGitDirectory: string
): ArchiveListing[] => {
  const root = worktreeArchivesRoot(commonGitDirectory);
  if (!lstatOrNull(root)) {
    return [];
  }
  assertRealDirectory(root);
  return guarded(`list ${root}`, () => readdirSync(root))
    .filter((name) => ARCHIVE_ID_PATTERN.test(name))
    .sort(compareCodePoints)
    .map((name) => join(root, name))
    .filter((path) => lstatOrNull(path)?.isDirectory() === true)
    .map(archiveListing);
};

const assertArchiveFolder = (directory: string, archiveId: string): void => {
  if (lstatOrNull(directory)?.isDirectory() !== true) {
    throw refusal(
      `There is no archive ${archiveId} at ${directory}. Run \`simple-changes worktree archives\` to list the archives.`,
      EXIT_CODES.usage
    );
  }
};

const archiveMismatch = (
  archiveId: string,
  differences: readonly string[],
  outcome: string
): SimpleChangesError =>
  refusal(
    `Archive ${archiveId} does not match its manifest (${summarize(differences)}), so it is damaged. ${outcome} Copy out what is there with \`simple-changes worktree restore-archive --archive ${archiveId} --extract-to <folder>\`.`
  );

export interface RestoreWorktreeArchiveInput {
  archiveId: string;
  commonGitDirectory: string;
  gitOptions?: readonly string[];
  primaryCheckout: string;
}
export interface RestoreWorktreeArchiveResult {
  archiveId: string;
  branch: string | null;
  branchCreated: boolean;
  headSha: string;
  path: string;
  privateGitDirectory: string;
}

interface RestoreContext {
  archiveId: string;
  directory: string;
  gitOptions: readonly string[];
  manifest: WorktreeArchiveManifest;
  primaryCheckout: string;
}

const extractHint = (archiveId: string): string =>
  `copy the archive out with \`simple-changes worktree restore-archive --archive ${archiveId} --extract-to <folder>\``;

interface ListedWorktree {
  branch: string | null;
  headSha: string | null;
  path: string;
}

const listedWorktrees = (context: RestoreContext): ListedWorktree[] => {
  const result = runGit(
    context.primaryCheckout,
    [
      ...context.gitOptions,
      "--no-optional-locks",
      "worktree",
      "list",
      "--porcelain",
    ],
    true
  );
  if (result.exitCode !== 0) {
    throw refusal(
      `Could not list the checkouts Git knows (git worktree list): ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  return parseWorktreeList(result.stdout).map((worktree) => ({
    branch: worktree.branch,
    headSha: worktree.headSha,
    path: worktree.path,
  }));
};

const assertRestoreTargetsFree = (
  context: RestoreContext,
  worktrees: readonly ListedWorktree[]
): void => {
  const { archiveId, manifest } = context;
  const { path } = manifest.source;
  const parent = dirname(resolve(path));
  const nothingChanged = `Nothing was changed. Move it aside and run the restore again, or ${extractHint(archiveId)}.`;
  if (lstatOrNull(path)) {
    throw refusal(
      `${path} already exists, so archive ${archiveId} cannot be restored there without overwriting it. ${nothingChanged}`
    );
  }
  const parentStats = lstatOrNull(parent);
  if (!parentStats?.isDirectory()) {
    throw refusal(
      `The folder ${parent} that held the checkout ${parentStats ? "is now a symbolic link or a file" : "no longer exists"}, and restore neither creates it nor writes through a link. Nothing was changed. Create the folder and run the restore again, or ${extractHint(archiveId)}.`
    );
  }
  if (lstatOrNull(manifest.privateGitDirectory)) {
    throw refusal(
      `Git's folder for this checkout, ${manifest.privateGitDirectory}, already exists, so another checkout may be using its name. ${nothingChanged}`
    );
  }
  const target = comparablePath(path);
  if (worktrees.some((worktree) => comparablePath(worktree.path) === target)) {
    throw refusal(
      `Git still lists a checkout at ${path} (git worktree list). Nothing was changed. Run \`git worktree prune\` when that checkout is gone, then run the restore again.`
    );
  }
};

const assertManifestPlacement = (context: RestoreContext): void => {
  const { archiveId, manifest } = context;
  const worktreesFolder = resolve(manifest.commonGitDirectory, "worktrees");
  if (dirname(resolve(manifest.privateGitDirectory)) !== worktreesFolder) {
    throw refusal(
      `The manifest of archive ${archiveId} places Git's folder for the checkout at ${manifest.privateGitDirectory}, outside ${worktreesFolder}, so restore will not write it. Nothing was changed; ${extractHint(archiveId)}.`
    );
  }
  const { branch } = manifest.source;
  const outside = manifest.branchConfig.find(
    (entry) => branch === null || !entry.key.startsWith(`branch.${branch}.`)
  );
  if (outside) {
    throw refusal(
      `The manifest of archive ${archiveId} records configuration ${outside.key}, outside the checkout's branch section, so restore will not write it. Nothing was changed; ${extractHint(archiveId)}.`
    );
  }
};

const assertHeadPresent = (context: RestoreContext): void => {
  const { headSha } = context.manifest.source;
  const result = runGit(
    context.primaryCheckout,
    [...context.gitOptions, "cat-file", "-e", `${headSha}^{commit}`],
    true
  );
  if (result.exitCode !== 0) {
    throw refusal(
      `The archived head commit ${headSha} is no longer in this repository, so the checkout cannot be restored at it. Nothing was changed; ${extractHint(context.archiveId)}.`
    );
  }
};

// The branch's current commit, or null when it does not exist.
const branchCommit = (
  context: RestoreContext,
  branch: string
): string | null => {
  const result = runGit(
    context.primaryCheckout,
    [
      ...context.gitOptions,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ],
    true
  );
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  if (result.exitCode === 1) {
    return null;
  }
  throw refusal(
    `Could not read branch ${branch}: ${result.stderr.trim() || result.stdout.trim()}`
  );
};

type BranchPlan = "absent" | "at-head" | "none";

const planBranch = (
  context: RestoreContext,
  worktrees: readonly ListedWorktree[]
): BranchPlan => {
  const { branch, headSha } = context.manifest.source;
  if (branch === null) {
    return "none";
  }
  const holder = worktrees.find((worktree) => worktree.branch === branch);
  if (holder) {
    throw refusal(
      `Branch ${branch} is checked out at ${holder.path}, and Git allows a branch in only one checkout. Nothing was changed. Switch that checkout to another branch and run the restore again, or ${extractHint(context.archiveId)}.`
    );
  }
  const current = branchCommit(context, branch);
  if (current !== null && current !== headSha) {
    throw refusal(
      `Branch ${branch} now points at ${current}, not the archived head ${headSha}, so restoring the checkout on it could hide newer work. Nothing was changed. Rename the branch and run the restore again, or ${extractHint(context.archiveId)}.`
    );
  }
  return current === null ? "absent" : "at-head";
};

const createBranch = (context: RestoreContext, branch: string): void => {
  const { headSha } = context.manifest.source;
  const result = runGit(
    context.primaryCheckout,
    [
      ...context.gitOptions,
      "update-ref",
      "-m",
      `simple-changes: restore archive ${context.archiveId}`,
      `refs/heads/${branch}`,
      headSha,
      "0".repeat(headSha.length),
    ],
    true
  );
  if (result.exitCode !== 0) {
    throw refusal(
      `Could not create branch ${branch} at ${headSha}: ${result.stderr.trim() || result.stdout.trim()}. Nothing was changed.`
    );
  }
};

const escapeExtendedRegex = (text: string): string =>
  text.replace(EXTENDED_REGEX_SPECIALS, "\\$&");

// Only into an absent section, so configuration someone wrote since the
// removal is never overwritten or duplicated.
const restoreBranchConfig = (context: RestoreContext, branch: string): void => {
  const existing = runGit(
    context.primaryCheckout,
    [
      ...context.gitOptions,
      "config",
      "--local",
      "--get-regexp",
      `^branch\\.${escapeExtendedRegex(branch)}\\.`,
    ],
    true
  );
  if (existing.exitCode === 0) {
    return;
  }
  if (existing.exitCode !== 1) {
    throw refusal(
      `Could not read the configuration of branch ${branch}: ${existing.stderr.trim()}`
    );
  }
  for (const entry of context.manifest.branchConfig) {
    const written = runGit(
      context.primaryCheckout,
      [
        ...context.gitOptions,
        "config",
        "--local",
        "--add",
        entry.key,
        entry.value ?? "true",
      ],
      true
    );
    if (written.exitCode !== 0) {
      throw refusal(`Could not restore ${entry.key}: ${written.stderr.trim()}`);
    }
  }
};

const incompleteRestore = (
  context: RestoreContext,
  error: unknown
): SimpleChangesError => {
  const { manifest } = context;
  const branch = manifest.source.branch
    ? ` and branch ${manifest.source.branch}`
    : "";
  return SimpleChangesError.withCause(
    `The restore of archive ${context.archiveId} is incomplete: ${errorText(error)} The archive itself is unchanged, and what was restored so far is left in place. Inspect ${manifest.source.path}, ${manifest.privateGitDirectory}${branch}, move aside what is there, and run the restore again, or ${extractHint(context.archiveId)}. The restore marker stays, so automatic pruning keeps this archive until a restore succeeds or it is pruned by ID.`,
    EXIT_CODES.unsafe,
    error
  );
};

const verifyRestoredCheckout = (context: RestoreContext): void => {
  const { branch, headSha, path } = context.manifest.source;
  const target = comparablePath(path);
  const listed = listedWorktrees(context).find(
    (worktree) => comparablePath(worktree.path) === target
  );
  if (!listed) {
    throw refusal(`Git does not list the restored checkout at ${path}.`);
  }
  if (listed.headSha !== headSha || listed.branch !== branch) {
    throw refusal(
      `Git lists the restored checkout at ${listed.headSha ?? "no commit"} on ${listed.branch ?? "no branch"}, not ${headSha} on ${branch ?? "no branch"}.`
    );
  }
  const status = runGit(
    path,
    [...context.gitOptions, "--no-optional-locks", "status", "--porcelain"],
    true
  );
  if (status.exitCode !== 0 || status.stdout.trim() !== "") {
    throw refusal(
      `The restored checkout at ${path} is not clean: ${(status.stdout.trim() || status.stderr.trim()).split("\n").slice(0, SUMMARY_LIMIT).join("; ")}.`
    );
  }
};

// Nothing is written before these checks pass, so a refusal here removes
// the marker again and leaves the archive exactly as it was.
const checkRestore = (context: RestoreContext): BranchPlan => {
  const differences = verifyWorktreeArchive(
    context.directory,
    context.manifest
  );
  if (differences.length > 0) {
    throw archiveMismatch(
      context.archiveId,
      differences,
      "Nothing was changed."
    );
  }
  assertManifestPlacement(context);
  const worktrees = listedWorktrees(context);
  assertRestoreTargetsFree(context, worktrees);
  assertHeadPresent(context);
  return planBranch(context, worktrees);
};

const writeRestore = (context: RestoreContext, plan: BranchPlan): void => {
  const { manifest } = context;
  const { branch } = manifest.source;
  if (plan === "absent" && branch !== null) {
    restoreBranchConfig(context, branch);
  }
  guarded(`create ${dirname(manifest.privateGitDirectory)}`, () =>
    mkdirSync(dirname(manifest.privateGitDirectory), { recursive: true })
  );
  copyTree(join(context.directory, GIT_FOLDER), manifest.privateGitDirectory);
  copyTree(join(context.directory, CHECKOUT_FOLDER), manifest.source.path);
  verifyRestoredCheckout(context);
};

/**
 * Recreates an archived checkout at its recorded path: verifies the archive,
 * refuses anything that exists in the way, recreates the branch at the head
 * (and its configuration section when absent), copies `git/` and
 * `checkout/` back, and confirms Git registers a clean checkout. The caller
 * checks the Git environment and holds the cleanup locks.
 */
export const restoreWorktreeArchive = (
  input: RestoreWorktreeArchiveInput
): RestoreWorktreeArchiveResult => {
  const directory = worktreeArchiveDirectory(
    input.commonGitDirectory,
    input.archiveId
  );
  assertArchiveFolder(directory, input.archiveId);
  const manifest = readWorktreeArchiveManifest(directory);
  if (
    comparablePath(manifest.commonGitDirectory) !==
    comparablePath(input.commonGitDirectory)
  ) {
    throw refusal(
      `Archive ${input.archiveId} belongs to the repository at ${manifest.commonGitDirectory}, not ${input.commonGitDirectory}. Nothing was changed; ${extractHint(input.archiveId)}.`
    );
  }
  const context: RestoreContext = {
    archiveId: input.archiveId,
    directory,
    gitOptions: input.gitOptions ?? [],
    manifest,
    primaryCheckout: input.primaryCheckout,
  };
  // A marker left by an earlier restore that stopped half way stays through
  // a refusal here, so the archive keeps its protection from pruning until
  // a restore succeeds or it is pruned by ID.
  const earlierMarker = readRestoringMarker(directory) !== null;
  writeRestoringMarker(directory);
  let plan: BranchPlan;
  try {
    plan = checkRestore(context);
    if (plan === "absent" && manifest.source.branch !== null) {
      createBranch(context, manifest.source.branch);
    }
  } catch (error) {
    if (!earlierMarker) {
      removeRestoringMarker(directory);
    }
    throw error;
  }
  try {
    writeRestore(context, plan);
  } catch (error) {
    throw incompleteRestore(context, error);
  }
  removeRestoringMarker(directory);
  return {
    archiveId: input.archiveId,
    branch: manifest.source.branch,
    branchCreated: plan === "absent",
    headSha: manifest.source.headSha,
    path: manifest.source.path,
    privateGitDirectory: manifest.privateGitDirectory,
  };
};

// True when the folder was created here, so a failure removes all of it;
// an existing empty folder only loses what was copied into it.
const prepareExtractDestination = (destination: string): boolean => {
  const stats = lstatOrNull(destination);
  if (!stats) {
    guarded(`create ${destination}`, () =>
      mkdirSync(destination, { mode: 0o700, recursive: true })
    );
    return true;
  }
  if (!stats.isDirectory()) {
    throw refusal(
      `${destination} is not a folder (a symbolic link or a file). Nothing was copied. Choose an empty or new folder.`,
      EXIT_CODES.usage
    );
  }
  if (
    guarded(`list ${destination}`, () => readdirSync(destination)).length > 0
  ) {
    throw refusal(
      `${destination} is not empty. Nothing was copied. Choose an empty or new folder.`,
      EXIT_CODES.usage
    );
  }
  return false;
};

const discardExtraction = (
  destination: string,
  created: boolean,
  error: unknown
): never => {
  if (created) {
    return discardPartial(destination, error);
  }
  for (const name of [MANIFEST_FILENAME, CHECKOUT_FOLDER, GIT_FOLDER]) {
    try {
      removeTree(join(destination, name));
    } catch {
      // The original error matters more; what is left is in a folder the
      // user chose for a manual copy.
    }
  }
  throw error;
};

/**
 * Verifies the archive, then copies `manifest.json`, `checkout/` and `git/`
 * into `destination`, which must be absent or empty. Writes no marker and
 * touches nothing else.
 */
export const extractWorktreeArchive = (input: {
  archiveId: string;
  commonGitDirectory: string;
  destination: string;
}): { bytes: number; destination: string } => {
  const directory = worktreeArchiveDirectory(
    input.commonGitDirectory,
    input.archiveId
  );
  assertArchiveFolder(directory, input.archiveId);
  const manifest = readWorktreeArchiveManifest(directory);
  const differences = verifyWorktreeArchive(directory, manifest);
  if (differences.length > 0) {
    throw refusal(
      `Archive ${input.archiveId} does not match its manifest (${summarize(differences)}), so it is damaged. Nothing was copied. Inspect ${directory} by hand to salvage what is there.`
    );
  }
  const destination = resolve(input.destination);
  const created = prepareExtractDestination(destination);
  try {
    const manifestCopy = copyRegularFile(
      join(directory, MANIFEST_FILENAME),
      join(destination, MANIFEST_FILENAME),
      MANIFEST_FILENAME
    );
    const checkout = copyTree(
      join(directory, CHECKOUT_FOLDER),
      join(destination, CHECKOUT_FOLDER)
    );
    const gitDirectory = copyTree(
      join(directory, GIT_FOLDER),
      join(destination, GIT_FOLDER)
    );
    const changed = [
      ...treeDifferences(manifest.checkout, checkout, `${CHECKOUT_FOLDER}/`),
      ...treeDifferences(manifest.gitDirectory, gitDirectory, `${GIT_FOLDER}/`),
    ];
    if (changed.length > 0) {
      throw refusal(
        `Archive ${input.archiveId} changed while it was copied (${summarize(changed)}). The partial copy was removed; run the command again.`
      );
    }
    return {
      bytes: manifestCopy.size + checkout.bytes + gitDirectory.bytes,
      destination,
    };
  } catch (error) {
    return discardExtraction(destination, created, error);
  }
};

export interface ArchivePruneInput {
  command: ArchivePruneRecord["command"];
  commonGitDirectory: string;
  dryRun: boolean;
  gitOptions?: readonly string[];
  /** Archives this run made; never pruned by the run itself. */
  keep?: readonly string[];
  /** Absent for automatic pruning. */
  manual?: {
    approvedBy: string;
    archiveId?: string;
    olderThanDays?: number;
    reason: string;
  };
  now: Date;
  primaryCheckout: string;
  retention: { days: number; maxTotalBytes: number };
}
export interface ArchivePruneResult {
  /** The retention this run applied: the policy's, as the output names it. */
  appliedRetention: { days: number; maxTotalBytes: number };
  keptForAttention: Array<{
    archiveId: string;
    reason: string;
    restoreCommand: string;
  }>;
  pruned: Array<{
    archiveId: string;
    bytes: number;
    cause: ArchivePruneRecord["cause"];
    /** What the run noticed about this archive, such as a failed re-check a manual prune overrode. */
    notes: string[];
    pinRefsDeleted: string[];
  }>;
  /** Null in a dry run or when nothing was pruned. */
  recordPath: string | null;
  skipped: Array<{ archiveId: string; reason: string }>;
  totalBytesAfter: number;
  totalBytesBefore: number;
}

type PrunedArchive = ArchivePruneResult["pruned"][number];

interface PruneItem {
  bytes: number;
  cause: ArchivePruneRecord["cause"];
  /** Pruned whatever the total: expired, past the manual age, or named by ID. */
  due: boolean;
  listing: ArchiveListing;
  manifest: WorktreeArchiveManifest | null;
  notes: string[];
}

interface PrunePlan {
  keptForAttention: ArchivePruneResult["keptForAttention"];
  /** Every eligible archive in creation order; execution walks it. */
  queue: PruneItem[];
  skipped: ArchivePruneResult["skipped"];
}

interface PruneContext {
  gitOptions: readonly string[];
  input: ArchivePruneInput;
}

const manifestBytes = (manifest: WorktreeArchiveManifest): number =>
  manifest.checkout.bytes + manifest.gitDirectory.bytes;

const restoreCommand = (archiveId: string): string =>
  `simple-changes worktree restore-archive --archive ${archiveId}`;

const gitDetail = (result: { stderr: string; stdout: string }): string =>
  (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "";

/**
 * Applies ref updates (`create <ref> <object>` or `delete <ref> <object>`)
 * in one Git transaction that never follows a symbolic ref: `start`, the
 * updates, `prepare`, `commit`. Git takes every lock and checks every value
 * in `prepare`, before it changes any ref, so a stale lock or a value that
 * no longer matches leaves every ref as it was. Returns null when Git
 * committed the transaction, otherwise its reason; it never throws, so a
 * spawn that fails under load is reported like any other failure.
 */
export const applyRefTransaction = (
  repositoryPath: string,
  gitOptions: readonly string[],
  updates: readonly string[],
  message?: string
): string | null => {
  try {
    runGitWithInput(
      repositoryPath,
      [
        ...gitOptions,
        "update-ref",
        "--no-deref",
        ...(message === undefined ? [] : ["-m", message]),
        "--stdin",
      ],
      ["start", ...updates, "prepare", "commit", ""].join("\n")
    );
    return null;
  } catch (error) {
    return errorText(error).trim().split("\n")[0] || "Git gave no reason";
  }
};

const replacementFailure = (
  context: PruneContext,
  targetRef: string,
  target: string,
  replacement: string
): string | null => {
  const { primaryCheckout } = context.input;
  const ancestry = runGit(
    primaryCheckout,
    [...context.gitOptions, "merge-base", "--is-ancestor", replacement, target],
    true
  );
  if (ancestry.exitCode === 1) {
    return `${targetRef} no longer contains replacement ${replacement}.`;
  }
  if (ancestry.exitCode !== 0) {
    return `Simple Changes could not check that ${targetRef} contains replacement ${replacement}: ${gitDetail(ancestry)}.`;
  }
  // No revert is an empty listing, which is also what a lost answer looks
  // like, so the listing is checked whole against Git's own count of it.
  let reverts: string[];
  try {
    reverts = completeRevisionList(
      primaryCheckout,
      [
        "--fixed-strings",
        `--grep=This reverts commit ${replacement}`,
        `${replacement}..${target}`,
      ],
      { gitOptions: context.gitOptions }
    );
  } catch (error) {
    return `Simple Changes could not check whether ${targetRef} reverts replacement ${replacement}: ${errorText(error)}`;
  }
  const [revert] = reverts;
  return revert
    ? `${targetRef} reverts replacement ${replacement} in commit ${revert} (found by Git's own revert message).`
    : null;
};

// Null when the target still contains every replacement and reverts none;
// otherwise why the archive needs attention, naming the replacement. A
// check Git could not answer whole is a reason too, so the archive is kept
// and reported rather than pruned on a lost answer.
const recheckFailure = (
  context: PruneContext,
  manifest: WorktreeArchiveManifest
): string | null => {
  try {
    const target = completeObjectId(
      context.input.primaryCheckout,
      `${manifest.targetRef}^{commit}`,
      context.gitOptions
    );
    if (!target) {
      return `The target ${manifest.targetRef} no longer resolves to a commit, so Simple Changes cannot show that it still carries the replacements.`;
    }
    for (const replacement of manifest.replacementCommits) {
      const failure = replacementFailure(
        context,
        manifest.targetRef,
        target,
        replacement
      );
      if (failure) {
        return failure;
      }
    }
    return null;
  } catch (error) {
    return `Simple Changes could not re-check ${manifest.targetRef} against the replacements: ${errorText(error)}`;
  }
};

const markerAge = (marker: RestoringMarker, now: Date): string => {
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(marker.startedAt)) / MINUTE_MS)
  );
  return minutes < 120
    ? `${minutes} minutes`
    : `${Math.round(minutes / 60)} hours`;
};

const skipReason = (
  listing: ArchiveListing,
  now: Date,
  keep: readonly string[]
): string | null => {
  if (keep.includes(listing.archiveId)) {
    return "It was made by this run, so it is kept until a later cleanup point.";
  }
  if (listing.error !== null || !listing.manifest) {
    return `Its state does not parse (${listing.error ?? "no manifest"}), so it is left alone. Inspect ${listing.directory}; remove it with \`simple-changes worktree prune-archives --archive ${listing.archiveId} --approved-by <user> --reason <why>\` when it is not needed.`;
  }
  if (listing.restoring) {
    return `A restore started ${markerAge(listing.restoring, now)} ago (at ${listing.restoring.startedAt}, process ${listing.restoring.pid}) has not finished, so it is left alone. Run \`${restoreCommand(listing.archiveId)}\` again, or prune it by ID.`;
  }
  return null;
};

const byCreation = (left: PruneItem, right: PruneItem): number =>
  Date.parse(left.manifest?.createdAt ?? "") -
    Date.parse(right.manifest?.createdAt ?? "") ||
  compareCodePoints(left.listing.archiveId, right.listing.archiveId);

const isDue = (
  manifest: WorktreeArchiveManifest,
  input: ArchivePruneInput
): boolean => {
  const olderThanDays = input.manual?.olderThanDays;
  const dueAt =
    olderThanDays === undefined
      ? Date.parse(manifest.expiresAt)
      : Date.parse(manifest.createdAt) + olderThanDays * DAY_MS;
  return dueAt <= input.now.getTime();
};

// Every archive is re-checked, due or not, so each report names every
// archive whose target lost or reverted a replacement.
const classifyListings = (
  context: PruneContext,
  listings: readonly ArchiveListing[],
  plan: PrunePlan
): PruneItem[] => {
  const eligible: PruneItem[] = [];
  for (const listing of listings) {
    const reason = skipReason(
      listing,
      context.input.now,
      context.input.keep ?? []
    );
    const failure =
      reason === null && listing.manifest
        ? recheckFailure(context, listing.manifest)
        : null;
    if (reason !== null) {
      plan.skipped.push({ archiveId: listing.archiveId, reason });
    } else if (failure !== null) {
      plan.keptForAttention.push({
        archiveId: listing.archiveId,
        reason: failure,
        restoreCommand: restoreCommand(listing.archiveId),
      });
    } else if (listing.manifest) {
      eligible.push({
        bytes: manifestBytes(listing.manifest),
        cause: context.input.manual === undefined ? "expired" : "manual",
        due: isDue(listing.manifest, context.input),
        listing,
        manifest: listing.manifest,
        notes: [],
      });
    }
  }
  return eligible.sort(byCreation);
};

// The plan only classifies; which archives the cap takes is decided while
// the queue runs, from what each removal actually freed.
const automaticPlan = (
  context: PruneContext,
  listings: readonly ArchiveListing[]
): PrunePlan => {
  const plan: PrunePlan = { keptForAttention: [], queue: [], skipped: [] };
  plan.queue = classifyListings(context, listings, plan);
  return plan;
};

const measuredBytes = (directory: string): number => {
  try {
    return measureTree(directory).bytes;
  } catch {
    return 0;
  }
};

const manualPlan = (
  context: PruneContext,
  listings: readonly ArchiveListing[],
  archiveId: string
): PrunePlan => {
  const directory = worktreeArchiveDirectory(
    context.input.commonGitDirectory,
    archiveId
  );
  const listing = listings.find((item) => item.archiveId === archiveId);
  if (!listing) {
    throw refusal(
      `There is no archive ${archiveId} at ${directory}. Nothing was pruned. Run \`simple-changes worktree archives\` to list the archives.`,
      EXIT_CODES.usage
    );
  }
  const notes: string[] = [];
  if (listing.error !== null) {
    notes.push(`Its state did not parse: ${listing.error}`);
  }
  if (listing.restoring) {
    notes.push(
      `A restore marker from process ${listing.restoring.pid}, started at ${listing.restoring.startedAt}, was present.`
    );
  }
  if (listing.manifest) {
    const failure = recheckFailure(context, listing.manifest);
    notes.push(
      failure === null
        ? `The re-check passed: ${listing.manifest.targetRef} still contains every replacement.`
        : `The re-check failed and the archive was pruned anyway because it was named: ${failure}`
    );
  }
  return {
    keptForAttention: [],
    queue: [
      {
        bytes: listing.manifest
          ? manifestBytes(listing.manifest)
          : measuredBytes(directory),
        cause: "manual",
        due: true,
        listing,
        manifest: listing.manifest,
        notes,
      },
    ],
    skipped: [],
  };
};

interface CurrentRef {
  object: string;
  symref: string;
}

// The refs under an archive's namespace, or null when Git could not list
// them whole. A line cut short could drop the `%(symref)` field and read a
// symbolic ref as a plain one, so a listing that stops inside a line is
// refused; one lost or cut at a line's end only leaves pins out, which
// `planPins` confirms by exit code before it calls a pin gone.
const namespaceRefs = (
  context: PruneContext,
  namespace: string
): Map<string, CurrentRef> | null => {
  let result: { exitCode: number; stdout: string };
  try {
    result = completeListing(
      context.input.primaryCheckout,
      [
        ...context.gitOptions,
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(symref)",
        `${namespace}/`,
      ],
      "\n"
    );
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }
  const refs = new Map<string, CurrentRef>();
  for (const line of result.stdout.split("\n")) {
    const [ref, object, symref] = line.split(NUL);
    if (ref && object !== undefined) {
      refs.set(ref, { object, symref: symref ?? "" });
    }
  }
  return refs;
};

// A pin is `deletable` when it still holds its recorded object, `gone` when
// nothing is left to delete, and `blocked` when it cannot be deleted by
// exact value (it moved, became a symbolic ref, lies outside the archive's
// namespace, or Git could not list the namespace).
interface PinPlan {
  blocked: string[];
  deletable: ArchivePinRef[];
  gone: string[];
  notes: string[];
}

const pinBlockReason = (
  pin: ArchivePinRef,
  current: CurrentRef
): string | null => {
  if (current.symref !== "") {
    return `${pin.ref} is now a symbolic ref to ${current.symref}, so it was left alone rather than followed.`;
  }
  if (current.object !== pin.object) {
    return `${pin.ref} now points at ${current.object}, not the pinned ${pin.object}, so it was left alone.`;
  }
  return null;
};

// Whether Git says a pin the listing left out is really gone: `rev-parse
// --verify` exits 1 for a ref that does not exist, which a lost listing
// cannot fake. Anything else means the listing lost it.
const pinIsGone = (context: PruneContext, ref: string): boolean =>
  runGit(
    context.input.primaryCheckout,
    [...context.gitOptions, "rev-parse", "--verify", "--quiet", ref],
    true
  ).exitCode === 1;

const planPins = (
  context: PruneContext,
  manifest: WorktreeArchiveManifest
): PinPlan => {
  const namespace = archivePinNamespace(manifest.archiveId);
  const current = namespaceRefs(context, namespace);
  const plan: PinPlan = { blocked: [], deletable: [], gone: [], notes: [] };
  for (const pin of manifest.pinRefs) {
    // The listing covers only the archive's namespace, so a pin outside it
    // is judged before the lookup; it is never "gone".
    if (!pin.ref.startsWith(`${namespace}/`)) {
      plan.blocked.push(pin.ref);
      plan.notes.push(
        `${pin.ref} is outside the archive's namespace ${namespace}/, so it was left alone.`
      );
      continue;
    }
    const ref = current?.get(pin.ref);
    if (!current) {
      plan.blocked.push(pin.ref);
      plan.notes.push(
        `${pin.ref} was left alone because Git could not list the archive's pins.`
      );
    } else if (ref) {
      const reason = pinBlockReason(pin, ref);
      if (reason === null) {
        plan.deletable.push(pin);
      } else {
        plan.blocked.push(pin.ref);
        plan.notes.push(reason);
      }
    } else if (pinIsGone(context, pin.ref)) {
      plan.gone.push(pin.ref);
    } else {
      plan.blocked.push(pin.ref);
      plan.notes.push(
        `${pin.ref} was left alone because Git's listing of the archive's pins left it out although it exists.`
      );
    }
  }
  return plan;
};

// Without a manifest there is no recorded value to delete by; the refs in
// the archive's own namespace are deleted at the value they hold now, since
// the user named this archive.
const unlistedPins = (context: PruneContext, archiveId: string): PinPlan => {
  const namespace = archivePinNamespace(archiveId);
  const current = namespaceRefs(context, namespace);
  if (!current) {
    return {
      blocked: [`${namespace}/`],
      deletable: [],
      gone: [],
      notes: [
        `Its pins under ${namespace}/ were left alone because Git could not list them.`,
      ],
    };
  }
  const plan: PinPlan = { blocked: [], deletable: [], gone: [], notes: [] };
  for (const [ref, state] of [...current].sort(([left], [right]) =>
    compareCodePoints(left, right)
  )) {
    if (state.symref === "") {
      plan.deletable.push({ object: state.object, ref });
    } else {
      plan.blocked.push(ref);
      plan.notes.push(
        `${ref} is a symbolic ref to ${state.symref}, so it was left alone rather than followed.`
      );
    }
  }
  if (plan.deletable.length > 0) {
    plan.notes.push(
      `Its pins under ${namespace}/ were deleted at the values they held, because the manifest that lists them did not parse.`
    );
  }
  return plan;
};

const pinPlanFor = (context: PruneContext, item: PruneItem): PinPlan =>
  item.manifest
    ? planPins(context, item.manifest)
    : unlistedPins(context, item.listing.archiveId);

// Exact old value and no dereference: a pin that moved, or became a
// symbolic ref, is reported rather than forced. A plan with a blocked pin
// deletes nothing, and the deletable pins go in one transaction, so a
// failure (a stale lock, a pin that moved since the plan) deletes none of
// them: an archive that stays keeps every pin, its head's included.
const deletePins = (
  context: PruneContext,
  plan: PinPlan
): { deleted: string[]; notes: string[]; unresolved: string[] } => {
  const notes = [...plan.notes];
  if (plan.blocked.length > 0) {
    return { deleted: [], notes, unresolved: [...plan.blocked] };
  }
  const refs = plan.deletable.map((pin) => pin.ref);
  if (refs.length === 0) {
    return { deleted: [], notes, unresolved: [] };
  }
  const failure = applyRefTransaction(
    context.input.primaryCheckout,
    context.gitOptions,
    plan.deletable.map((pin) => `delete ${pin.ref} ${pin.object}`)
  );
  if (failure === null) {
    return { deleted: refs, notes, unresolved: [] };
  }
  notes.push(
    `${refs.join(", ")} could not be deleted: ${failure.replace(TRAILING_PERIODS, "")}. Git deletes an archive's pins together or not at all, so every one was kept.`
  );
  return { deleted: [], notes, unresolved: refs };
};

const pruneRecord = (
  input: ArchivePruneInput,
  item: PruneItem,
  pinRefsDeleted: string[]
): ArchivePruneRecord => {
  const manual = item.cause === "manual" ? input.manual : undefined;
  const { manifest } = item;
  return {
    approvedBy: manual?.approvedBy ?? null,
    archiveId: item.listing.archiveId,
    bytes: item.bytes,
    cause: item.cause,
    command: input.command,
    createdAt: manifest?.createdAt ?? null,
    expiresAt: manifest?.expiresAt ?? null,
    kind: "worktree-archive-prune",
    pinRefsDeleted,
    prunedAt: input.now.toISOString(),
    reason: manual?.reason ?? null,
    receiptDigest: manifest?.receiptDigest ?? null,
    schemaVersion: 1,
    source: manifest
      ? {
          branch: manifest.source.branch,
          headSha: manifest.source.headSha,
          path: manifest.source.path,
        }
      : null,
  };
};

/** Strict: a log that is not a list of valid records throws. */
export const readArchivePruneLog = (
  commonGitDirectory: string
): ArchivePruneRecord[] => {
  const path = archivePruneLogPath(commonGitDirectory);
  const text = readStateFile(path);
  if (text === null) {
    return [];
  }
  const records = parseJson(text, path);
  if (!Array.isArray(records)) {
    throw refusal(
      "The worktree archive prune log is not an append-only record list.",
      EXIT_CODES.unsafe
    );
  }
  return records.map((record) =>
    validateSchema<ArchivePruneRecord>("worktree-archive-prune", record)
  );
};

const appendPruneRecord = (
  commonGitDirectory: string,
  record: ArchivePruneRecord
): void => {
  const validated = validateSchema<ArchivePruneRecord>(
    "worktree-archive-prune",
    record
  );
  writeJsonAtomically(archivePruneLogPath(commonGitDirectory), [
    ...readArchivePruneLog(commonGitDirectory),
    validated,
  ]);
};

type PruneOutcome =
  | { kept: ArchivePruneResult["keptForAttention"][number]; pruned?: never }
  | { kept?: never; pruned: PrunedArchive & { folderRemoved: boolean } };

// Pins first; the record and the folder only once every pin is gone. An
// archive whose pins could not all be deleted stays whole, manifest
// included, so the next prune (automatic or by ID) retries it, and is
// reported. A crash after the record leaves a recorded archive that the
// next run prunes again, never an unrecorded removal.
const executePrune = (context: PruneContext, item: PruneItem): PruneOutcome => {
  const pins = deletePins(context, pinPlanFor(context, item));
  const notes = [...item.notes, ...pins.notes];
  if (pins.unresolved.length > 0) {
    return {
      kept: {
        archiveId: item.listing.archiveId,
        reason: `Its pins could not all be deleted (${pins.unresolved.join(", ")}): ${notes.join(" ")} The archive stays whole so the next prune retries it; delete the refs by hand with \`git update-ref --no-deref -d <ref>\` if they are not to be kept.`,
        restoreCommand: restoreCommand(item.listing.archiveId),
      },
    };
  }
  appendPruneRecord(
    context.input.commonGitDirectory,
    pruneRecord(context.input, item, pins.deleted)
  );
  let folderRemoved = true;
  try {
    removeTree(item.listing.directory);
  } catch (error) {
    folderRemoved = false;
    notes.push(
      `The prune record was written, but ${item.listing.directory} could not be removed (${errorText(error)}); its bytes are still held and the next prune removes it.`
    );
  }
  return {
    pruned: {
      archiveId: item.listing.archiveId,
      bytes: item.bytes,
      cause: item.cause,
      folderRemoved,
      notes,
      pinRefsDeleted: pins.deleted,
    },
  };
};

// What a dry run would do: an archive with a pin that cannot be deleted
// would be kept, like a real run keeps it.
const plannedPrune = (context: PruneContext, item: PruneItem): PruneOutcome => {
  const pins = pinPlanFor(context, item);
  if (pins.blocked.length > 0) {
    return {
      kept: {
        archiveId: item.listing.archiveId,
        reason: `Its pins could not all be deleted (${pins.blocked.join(", ")}): ${[...item.notes, ...pins.notes].join(" ")} The archive would stay whole.`,
        restoreCommand: restoreCommand(item.listing.archiveId),
      },
    };
  }
  return {
    pruned: {
      archiveId: item.listing.archiveId,
      bytes: item.bytes,
      cause: item.cause,
      folderRemoved: true,
      notes: [...item.notes, ...pins.notes],
      pinRefsDeleted: pins.deletable.map((pin) => pin.ref),
    },
  };
};

interface QueueOutcome {
  item: PruneItem;
  outcome: PruneOutcome;
}

// Only an archive whose folder is gone frees its bytes.
const freedBytes = (item: PruneItem, outcome: PruneOutcome): number =>
  outcome.pruned?.folderRemoved && item.manifest ? item.bytes : 0;

// Execution walks the eligible archives in creation order. While the total
// is over the cap (the policy's; a manual run prunes by age or by ID only),
// the oldest is pruned for the cap and credited only once its folder is
// gone, so a kept archive, whether its pins were blocked in the plan or a
// deletion failed when tried, advances the queue to the next-oldest. Then
// every due archive left in the queue is pruned. A dry run walks the same
// queue with the pin plans, so it matches the real run except for a
// deletion that fails only when tried.
const runQueue = (
  context: PruneContext,
  queue: readonly PruneItem[],
  totalBytesBefore: number
): { outcomes: QueueOutcome[]; totalBytesAfter: number } => {
  const { input } = context;
  const run = (item: PruneItem): QueueOutcome => ({
    item,
    outcome: input.dryRun
      ? plannedPrune(context, item)
      : executePrune(context, item),
  });
  const remaining = [...queue];
  const outcomes: QueueOutcome[] = [];
  let total = totalBytesBefore;
  while (
    input.manual === undefined &&
    total > input.retention.maxTotalBytes &&
    remaining.length > 0
  ) {
    const oldest = remaining.shift();
    if (oldest) {
      const ran = run({ ...oldest, cause: "size-cap" });
      outcomes.push(ran);
      total -= freedBytes(ran.item, ran.outcome);
    }
  }
  for (const item of remaining.filter((candidate) => candidate.due)) {
    const ran = run(item);
    outcomes.push(ran);
    total -= freedBytes(ran.item, ran.outcome);
  }
  return { outcomes, totalBytesAfter: total };
};

// Whether the queue would touch anything, so a damaged log refuses only a
// run that would prune.
const queueWouldPrune = (
  input: ArchivePruneInput,
  queue: readonly PruneItem[],
  totalBytesBefore: number
): boolean =>
  (input.manual === undefined &&
    totalBytesBefore > input.retention.maxTotalBytes &&
    queue.length > 0) ||
  queue.some((item) => item.due);

const isPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const isBoundedText = (value: string, maximum: number): boolean =>
  value.trim().length > 0 && value.length <= maximum;

const assertPruneInput = (input: ArchivePruneInput): void => {
  if (
    Number.isNaN(input.now.getTime()) ||
    !isPositiveInteger(input.retention.days) ||
    !isPositiveInteger(input.retention.maxTotalBytes)
  ) {
    throw refusal(
      "Archive pruning needs a valid time and a retention of whole positive days and bytes.",
      EXIT_CODES.usage
    );
  }
  const { manual } = input;
  if (!manual) {
    return;
  }
  const byId = manual.archiveId !== undefined;
  const byAge = manual.olderThanDays !== undefined;
  if (
    byId === byAge ||
    !isBoundedText(manual.approvedBy, APPROVER_MAXIMUM_LENGTH) ||
    !isBoundedText(manual.reason, REASON_MAXIMUM_LENGTH) ||
    (byAge && !isByteCount(manual.olderThanDays ?? -1))
  ) {
    throw refusal(
      `A manual archive prune names exactly one of an archive ID or an age in whole days, an approver (at most ${APPROVER_MAXIMUM_LENGTH} characters) and a reason (at most ${REASON_MAXIMUM_LENGTH} characters).`,
      EXIT_CODES.usage
    );
  }
};

/**
 * Prunes worktree archives. Automatic: an
 * archive being restored, or whose state does not parse, is skipped; one
 * whose target lost or reverted a replacement is kept for attention; the
 * rest are pruned oldest first while the total is above the cap, then every
 * expired one. Manual by ID prunes the named archive whatever the re-check
 * or marker says, and notes it; manual by age uses the given age instead of
 * the expiry. Each pruned archive's pins are deleted by exact value in one
 * transaction, all or none, then its record is appended, then its folder
 * is removed.
 */
export const pruneWorktreeArchives = (
  input: ArchivePruneInput
): ArchivePruneResult => {
  assertPruneInput(input);
  const context: PruneContext = { gitOptions: input.gitOptions ?? [], input };
  const listings = listWorktreeArchives(input.commonGitDirectory);
  const totalBytesBefore = listings.reduce(
    (sum, listing) =>
      sum + (listing.manifest ? manifestBytes(listing.manifest) : 0),
    0
  );
  const manualId = input.manual?.archiveId;
  const plan =
    manualId === undefined
      ? automaticPlan(context, listings)
      : manualPlan(context, listings, manualId);
  if (!input.dryRun && queueWouldPrune(input, plan.queue, totalBytesBefore)) {
    // A damaged log refuses before any pin or folder is touched.
    readArchivePruneLog(input.commonGitDirectory);
  }
  const { outcomes, totalBytesAfter } = runQueue(
    context,
    plan.queue,
    totalBytesBefore
  );
  const keptForAttention = [
    ...plan.keptForAttention,
    ...outcomes.flatMap(({ outcome }) => (outcome.kept ? [outcome.kept] : [])),
  ];
  const pruned = outcomes.flatMap(({ outcome }) =>
    outcome.pruned
      ? [(({ folderRemoved: _removed, ...entry }) => entry)(outcome.pruned)]
      : []
  );
  return {
    appliedRetention: {
      days: input.retention.days,
      maxTotalBytes: input.retention.maxTotalBytes,
    },
    keptForAttention,
    pruned,
    recordPath:
      !input.dryRun && pruned.length > 0
        ? archivePruneLogPath(input.commonGitDirectory)
        : null,
    skipped: plan.skipped,
    totalBytesAfter,
    totalBytesBefore,
  };
};
