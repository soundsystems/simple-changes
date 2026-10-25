import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { runGit } from "./process.ts";

/**
 * A source checkout's changes against its HEAD, read from the filesystem
 * rather than from Git status, or why the checkout is outside the supported
 * shape. Status and the index can be told to look away from a tracked edit
 * (assume-unchanged, skip-worktree, `core.filemode=false`, a submodule
 * `ignore` setting), so they supply only candidate path names here.
 */
export type SourceWorktreeDelta =
  | { entries: ReadonlyMap<string, string | null> }
  | { failure: string };

// `<mode> <type> <object>\t<path>` from `ls-tree -z`.
const LS_TREE_RECORD_PATTERN = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/su;

// Regular files are hashed in batches small enough for any argument limit.
const HASH_BATCH_SIZE = 200;

const isExecutable = (mode: number): boolean =>
  mode
    .toString(8)
    .slice(-3)
    .split("")
    .some((digit) => Number(digit) % 2 === 1);

const headEntries = (
  sourceWorktree: string,
  headRevision: string
): Map<string, string> | string => {
  const listed = runGit(
    sourceWorktree,
    ["ls-tree", "-r", "-z", "--full-tree", headRevision],
    true
  );
  if (listed.exitCode !== 0) {
    return "its HEAD tree cannot be read";
  }
  const entries = new Map<string, string>();
  for (const record of listed.stdout.split("\0").filter(Boolean)) {
    const match = LS_TREE_RECORD_PATTERN.exec(record);
    if (!match) {
      return "its HEAD tree cannot be read";
    }
    const [, mode, type, objectId, path] = match;
    if (type !== "blob") {
      return `${path} is a submodule in its HEAD`;
    }
    entries.set(path ?? "", `${mode}:${type}:${objectId}`);
  }
  return entries;
};

const indexedAndUntrackedPaths = (sourceWorktree: string): string[] | null => {
  const listed = runGit(
    sourceWorktree,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    true
  );
  return listed.exitCode === 0
    ? listed.stdout.split("\0").filter(Boolean)
    : null;
};

// Whether any directory above a path is a symlink, cached per directory.
const symlinkedAncestorCheck = (
  sourceWorktree: string
): ((path: string) => boolean) => {
  const known = new Map<string, boolean>();
  const isSymlink = (directory: string): boolean => {
    let symlink = known.get(directory);
    if (symlink === undefined) {
      try {
        symlink = lstatSync(
          resolve(sourceWorktree, directory)
        ).isSymbolicLink();
      } catch {
        symlink = false;
      }
      known.set(directory, symlink);
    }
    return symlink;
  };
  return (path) => {
    const segments = path.split("/").slice(0, -1);
    return segments.some((_, index) =>
      isSymlink(segments.slice(0, index + 1).join("/"))
    );
  };
};

type CandidateRead =
  | { entry: string | null; kind: "entry" }
  | { executable: boolean; kind: "regular" }
  | { failure: string; kind: "failure" };

const readCandidate = (
  sourceWorktree: string,
  path: string,
  symlinkEntry: (path: string) => string | null
): CandidateRead => {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(resolve(sourceWorktree, path));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { entry: null, kind: "entry" }
      : { failure: `${path} cannot be read`, kind: "failure" };
  }
  if (stat.isSymbolicLink()) {
    return { entry: symlinkEntry(path), kind: "entry" };
  }
  if (stat.isFile()) {
    return { executable: isExecutable(stat.mode), kind: "regular" };
  }
  return {
    failure: `${path} is a directory, submodule, or nested repository`,
    kind: "failure",
  };
};

// Hashes regular files the way `git add` would, in bounded batches.
const hashRegularFiles = (
  sourceWorktree: string,
  regular: readonly { executable: boolean; path: string }[],
  actual: Map<string, string | null>
): boolean => {
  for (let index = 0; index < regular.length; index += HASH_BATCH_SIZE) {
    const batch = regular.slice(index, index + HASH_BATCH_SIZE);
    const hashed = runGit(
      sourceWorktree,
      ["hash-object", "--", ...batch.map((item) => item.path)],
      true
    );
    const objectIds = hashed.stdout.split("\n").filter(Boolean);
    if (hashed.exitCode !== 0 || objectIds.length !== batch.length) {
      return false;
    }
    batch.forEach((item, offset) => {
      actual.set(
        item.path,
        `${item.executable ? "100755" : "100644"}:blob:${objectIds[offset]}`
      );
    });
  }
  return true;
};

/**
 * Reads every candidate path's actual entry. A symlinked ancestor, a
 * directory (a submodule, nested repository, or untracked directory), or any
 * other kind than a regular file or symlink puts the checkout outside the
 * supported shape. `symlinkEntry` reads a symlink's entry the way the scope
 * recorded it.
 */
export const sourceWorktreeDelta = (
  sourceWorktree: string,
  headRevision: string,
  symlinkEntry: (path: string) => string | null
): SourceWorktreeDelta => {
  const head = headEntries(sourceWorktree, headRevision);
  if (typeof head === "string") {
    return { failure: head };
  }
  const listed = indexedAndUntrackedPaths(sourceWorktree);
  // An empty listing beside a HEAD with files would mean an empty index and
  // no untracked file at all. A lost answer looks the same, and reading it as
  // empty would hide every untracked file, so the handoff refuses instead.
  if (!listed || (listed.length === 0 && head.size > 0)) {
    return { failure: "its index cannot be read" };
  }
  const symlinkedAncestor = symlinkedAncestorCheck(sourceWorktree);
  const actual = new Map<string, string | null>();
  const regular: Array<{ executable: boolean; path: string }> = [];
  for (const candidate of new Set([...head.keys(), ...listed])) {
    const path = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
    if (symlinkedAncestor(path)) {
      return { failure: `${path} is under a symlinked directory` };
    }
    const read = readCandidate(sourceWorktree, path, symlinkEntry);
    if (read.kind === "failure") {
      return { failure: read.failure };
    }
    if (read.kind === "regular") {
      regular.push({ executable: read.executable, path });
    } else {
      actual.set(path, read.entry);
    }
  }
  if (!hashRegularFiles(sourceWorktree, regular, actual)) {
    return { failure: "its files cannot be hashed" };
  }
  const entries = new Map<string, string | null>();
  for (const [path, entry] of actual) {
    if (entry !== (head.get(path) ?? null)) {
      entries.set(path, entry);
    }
  }
  return { entries };
};
