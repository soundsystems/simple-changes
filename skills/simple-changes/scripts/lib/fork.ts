import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { runGit, runGitRemote } from "./process.ts";

const UPSTREAM_URL = "https://gitlab.com/soundsystems/simple-changes.git";
const SKILL_PATH = "skills/simple-changes";
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FRONTMATTER_NAME = /^name: simple-changes\r?$/mu;
const TITLE = /^# Simple Changes\r?$/mu;
const TREE_ENTRY = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/u;
const WHITESPACE_RUN = /\s+/gu;
// Finder metadata is never part of the skill and must not block verification.
const IGNORED_NAMES = new Set([".DS_Store"]);
const MISMATCH_LIMIT = 5;

const usage = (message: string): never => {
  throw new SimpleChangesError(message, EXIT_CODES.usage);
};

interface SourceFile {
  content: Buffer;
  mode: number;
  path: string;
}

export interface CreateForkOptions {
  deltas: string;
  destination?: string | undefined;
  name: string;
  repositoryPath: string;
  sourcePath: string;
  upstreamPath?: string | undefined;
}

export interface CreatedFork {
  destination: string;
  fileCount: number;
  name: string;
  source: string;
  upstreamCommit: string;
}

const unsafe = (message: string): never => {
  throw new SimpleChangesError(message, EXIT_CODES.unsafe);
};

// Capture bytes once: the verified tree is also the tree copied, even if the
// global installation is updated while this command is running.
const snapshotSource = (root: string, directory = ""): SourceFile[] => {
  const files: SourceFile[] = [];
  for (const name of readdirSync(join(root, directory)).sort()) {
    if (IGNORED_NAMES.has(name)) {
      continue;
    }
    const path = directory ? `${directory}/${name}` : name;
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      files.push(...snapshotSource(root, path));
    } else if (stat.isFile()) {
      files.push({ content: readFileSync(absolute), mode: stat.mode, path });
    } else {
      unsafe(`Source contains a symlink or special file: ${path}`);
    }
  }
  return files;
};

const blobHash = (content: Buffer): string =>
  createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");

const upstreamTree = (upstream: string, commit: string): Map<string, string> =>
  new Map(
    runGit(upstream, ["ls-tree", "-r", "-z", commit, "--", SKILL_PATH])
      .stdout.split("\0")
      .filter(Boolean)
      .map((entry): [string, string] => {
        // A symlink, submodule, or other non-regular entry can never match a
        // copied file, so keep it with an impossible hash instead of dropping it.
        const match = TREE_ENTRY.exec(entry);
        const path = match?.[3] ?? entry.slice(entry.indexOf("\t") + 1);
        return [path.slice(SKILL_PATH.length + 1), match?.[2] ?? "unsupported"];
      })
  );

/** Paths that differ between the installed source and one upstream tree. */
const treeDifferences = (
  tree: Map<string, string>,
  files: SourceFile[]
): string[] => {
  const local = new Map(
    files.map((file) => [file.path, blobHash(file.content)])
  );
  return [
    ...[...local.keys()]
      .filter((path) => !tree.has(path))
      .map((path) => `extra ${path}`),
    ...[...tree.keys()]
      .filter((path) => !local.has(path))
      .map((path) => `missing ${path}`),
    ...[...local.entries()]
      .filter(([path, hash]) => tree.has(path) && tree.get(path) !== hash)
      .map(([path]) => `changed ${path}`),
  ];
};

const treeMatches = (
  upstream: string,
  commit: string,
  files: SourceFile[]
): boolean =>
  treeDifferences(upstreamTree(upstream, commit), files).length === 0;

const verifySourceCommit = (upstream: string, files: SourceFile[]): string => {
  const head = runGit(upstream, ["rev-parse", "HEAD"]).stdout.trim();
  const candidates = [
    head,
    ...runGit(upstream, ["log", "--format=%H", "HEAD", "--", SKILL_PATH])
      .stdout.trim()
      .split("\n")
      .filter(Boolean),
  ];
  const commit = candidates.find((candidate) =>
    treeMatches(upstream, candidate, files)
  );
  if (commit) {
    return commit;
  }
  const differences = treeDifferences(upstreamTree(upstream, head), files);
  const shown = differences.slice(0, MISMATCH_LIMIT).join(", ");
  const more =
    differences.length > MISMATCH_LIMIT
      ? ` and ${differences.length - MISMATCH_LIMIT} more`
      : "";
  return unsafe(
    `The installed source does not match an upstream commit (against the latest: ${shown}${more}). Update the global skill, or pass --upstream PATH to its complete source checkout. No fork was created.`
  );
};

const locateSourceCommit = (
  options: CreateForkOptions,
  files: SourceFile[]
): string => {
  if (options.upstreamPath) {
    const upstream = resolve(options.upstreamPath);
    if (
      !existsSync(upstream) ||
      runGit(upstream, ["rev-parse", "--git-dir"], true).exitCode !== 0
    ) {
      usage(`--upstream must be a Simple Changes Git checkout: ${upstream}`);
    }
    return verifySourceCommit(upstream, files);
  }
  const temporary = mkdtempSync(join(tmpdir(), "simple-changes-fork-"));
  try {
    const upstream = join(temporary, "upstream.git");
    const result = runGitRemote(temporary, [
      "clone",
      "--quiet",
      "--bare",
      "--filter=blob:none",
      UPSTREAM_URL,
      upstream,
    ]);
    if (result.exitCode !== 0) {
      return unsafe(
        "Could not read upstream history. Check connectivity or pass --upstream PATH for offline creation. No fork was created."
      );
    }
    return verifySourceCommit(upstream, files);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
};

const inside = (root: string, path: string): boolean => {
  const delta = relative(root, path);
  return (
    delta !== "" &&
    delta !== ".." &&
    !delta.startsWith(`..${sep}`) &&
    !isAbsolute(delta)
  );
};

// Never follow a repository symlink while creating the destination. Reserve
// the final directory exclusively so another invocation cannot be overwritten.
const reserveDestination = (root: string, destination: string): string[] => {
  const created: string[] = [];
  let directory = root;
  for (const part of relative(root, dirname(destination))
    .split(sep)
    .filter(Boolean)) {
    directory = join(directory, part);
    try {
      mkdirSync(directory);
      created.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      unsafe(`Destination parent must be a real directory: ${directory}`);
    }
  }
  try {
    mkdirSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      unsafe(
        `Destination already exists; choose a new name or path: ${destination}`
      );
    }
    throw error;
  }
  return [...created, destination];
};

/** Remove what this command created, innermost first, keeping anything else. */
const removeCreated = (created: readonly string[]): void => {
  const [destination, ...parents] = [...created].reverse();
  if (destination) {
    rmSync(destination, { force: true, recursive: true });
  }
  for (const parent of parents) {
    try {
      rmdirSync(parent);
    } catch {
      // Not empty or already gone: someone else's content stays.
    }
  }
};

/** The top level of the Git worktree that contains `path`. */
const repositoryRoot = (path: string): string => {
  const candidate = resolve(path);
  if (!existsSync(candidate)) {
    usage(`--repo does not exist: ${candidate}`);
  }
  const top = runGit(candidate, ["rev-parse", "--show-toplevel"], true);
  if (top.exitCode !== 0 || !top.stdout.trim()) {
    usage(
      `A fork belongs to a repository; run inside a Git worktree or pass --repo PATH: ${candidate}`
    );
  }
  return realpathSync(top.stdout.trim());
};

const separated = (root: string, source: string, path: string): boolean =>
  inside(root, path) &&
  path !== source &&
  !inside(source, path) &&
  !inside(path, source);

// An installed sibling such as `update-local-forks` or `simple-changelogs`
// must never be shadowed by a repository-local copy of this skill.
const assertDistinctName = (name: string, source: string): void => {
  const installed = new Set(
    existsSync(dirname(source)) ? readdirSync(dirname(source)) : []
  );
  if (
    !NAME_PATTERN.test(name) ||
    name.length > 64 ||
    name === "simple-changes" ||
    installed.has(name)
  ) {
    usage(
      "--name must be a distinct lowercase skill name, at most 64 characters, using letters, digits, and hyphens, and must not match an installed skill."
    );
  }
};

export const createFork = (options: CreateForkOptions): CreatedFork => {
  const source = realpathSync(options.sourcePath);
  assertDistinctName(options.name, source);
  const deltas = options.deltas.trim().replace(WHITESPACE_RUN, " ");
  if (!deltas) {
    throw new SimpleChangesError(
      "--deltas must describe the fork's intended custom behavior.",
      EXIT_CODES.usage
    );
  }
  const root = repositoryRoot(options.repositoryPath);
  const destination = resolve(
    root,
    options.destination ?? `.agents/skills/${options.name}`
  );
  if (!separated(root, source, destination)) {
    unsafe(
      "Destination must be inside the repository and separate from the source skill."
    );
  }
  const files = snapshotSource(source);
  const skill = files.find((file) => file.path === "SKILL.md");
  const original = skill?.content.toString("utf8") ?? "";
  if (original.includes("\r\n")) {
    unsafe(
      "The installed SKILL.md uses Windows line endings (for example from core.autocrlf), so its bytes cannot match upstream. Reinstall the skill with LF line endings, then retry."
    );
  }
  if (
    !(
      skill &&
      original.startsWith("---\n") &&
      FRONTMATTER_NAME.test(original) &&
      TITLE.test(original)
    ) ||
    original.includes("Forked from `simple-changes` @")
  ) {
    return unsafe(
      "Source must be the canonical Simple Changes skill, not another fork."
    );
  }
  const upstreamCommit = locateSourceCommit(options, files);
  skill.content = Buffer.from(
    original
      .replace(FRONTMATTER_NAME, () => `name: ${options.name}`)
      .replace(
        TITLE,
        () =>
          `# ${options.name}\n\nForked from \`simple-changes\` @ \`${upstreamCommit}\`. Fork-specific deltas: ${deltas}`
      )
  );
  const created = reserveDestination(root, destination);
  // Case-insensitive filesystems can resolve a differently cased path into the
  // source install; judge separation again on the real, created path.
  if (!separated(root, source, realpathSync(destination))) {
    removeCreated(created);
    unsafe(
      "Destination must be inside the repository and separate from the source skill."
    );
  }
  try {
    for (const file of files) {
      const path = join(destination, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content, { flag: "wx" });
      chmodSync(path, file.mode % 0o1000);
    }
  } catch (error) {
    removeCreated(created);
    throw error;
  }
  return {
    destination,
    fileCount: files.length,
    name: options.name,
    source,
    upstreamCommit,
  };
};
