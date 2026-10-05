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
const FRONTMATTER_BLOCK = /^---\n[\s\S]*?\n---\n/u;
const FRONTMATTER_NAME = /^name: simple-changes\r?$/mu;
// The description line plus any indented continuation lines of a folded value.
const FRONTMATTER_DESCRIPTION = /^description:.*(?:\n[ \t]+.*)*$/mu;
const TITLE = /^# Simple Changes\r?$/mu;
const CODEX_METADATA = "agents/openai.yaml";
const CODEX_DISPLAY_NAME = /^([ \t]*display_name:[ \t]*).*$/mu;
const CODEX_SHORT_DESCRIPTION = /^([ \t]*short_description:[ \t]*).*$/mu;
const CODEX_SKILL_MENTION = "$simple-changes";
const FORK_NAME_SUFFIX = "-simple-changes";
// Discovery reads every description at session start; a fork's stays short.
const MAX_FORK_DESCRIPTION_LENGTH = 400;
const MAX_CODEX_SHORT_DESCRIPTION_LENGTH = 64;
const THIS_REPOSITORY = "this repository";
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
  description: string;
  destination: string;
  fileCount: number;
  name: string;
  source: string;
  upstreamCommit: string;
}

/**
 * Where the fork applies: the project its conventional `<project>-simple-changes`
 * name carries, or this repository. Either way the result is plain words.
 */
const forkScope = (name: string): string =>
  name.endsWith(FORK_NAME_SUFFIX) && name.length > FORK_NAME_SUFFIX.length
    ? name.slice(0, -FORK_NAME_SUFFIX.length)
    : THIS_REPOSITORY;

const describeFork = (name: string, where: string): string =>
  `${name} is the Simple Changes fork for ${where}; use it instead of the global simple-changes skill in ${where} when a user asks to sync, package, queue, publish, integrate, review, merge, ship, reconcile, or clean Git changes, branches, worktrees, proposals, or deployments. Not for changelog authoring or read-only code review.`;

/**
 * The fork's frontmatter description. It starts with the fork's name and
 * tells an agent that sees both skills to load the fork in its repository. A
 * fork name is lowercase letters, digits, and hyphens, so the text never holds
 * the ": " or " #" that would break or truncate an unquoted YAML value.
 */
export const forkDescription = (name: string): string => {
  const scoped = describeFork(name, forkScope(name));
  return scoped.length <= MAX_FORK_DESCRIPTION_LENGTH
    ? scoped
    : describeFork(name, THIS_REPOSITORY);
};

const forkSkillMarkdown = (
  original: string,
  name: string,
  provenance: string
): string => {
  const frontmatter = FRONTMATTER_BLOCK.exec(original)?.[0] ?? "";
  const renamed = frontmatter.replace(FRONTMATTER_NAME, () => `name: ${name}`);
  const description = `description: ${forkDescription(name)}`;
  const described = FRONTMATTER_DESCRIPTION.test(renamed)
    ? renamed.replace(FRONTMATTER_DESCRIPTION, () => description)
    : renamed.replace(`name: ${name}`, () => `name: ${name}\n${description}`);
  return `${described}${original
    .slice(frontmatter.length)
    .replace(TITLE, () => provenance)}`;
};

// Codex shows the display name and runs the default prompt; both must name the
// fork, or the prompt would invoke the global skill instead.
const forkCodexMetadata = (original: string, name: string): string => {
  const scoped = `Simple Changes fork for ${forkScope(name)}`;
  const shortDescription =
    scoped.length <= MAX_CODEX_SHORT_DESCRIPTION_LENGTH
      ? scoped
      : `Simple Changes fork for ${THIS_REPOSITORY}`;
  return original
    .replace(CODEX_DISPLAY_NAME, (_line, key: string) => `${key}"${name}"`)
    .replace(
      CODEX_SHORT_DESCRIPTION,
      (_line, key: string) => `${key}"${shortDescription}"`
    )
    .replaceAll(CODEX_SKILL_MENTION, () => `$${name}`);
};

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
  const destination = created.at(-1);
  if (destination) {
    rmSync(destination, { force: true, recursive: true });
  }
  // Parents were created outermost first, so walk back from the innermost.
  for (let index = created.length - 2; index >= 0; index -= 1) {
    try {
      rmdirSync(created[index] as string);
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
      FRONTMATTER_NAME.test(FRONTMATTER_BLOCK.exec(original)?.[0] ?? "") &&
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
    forkSkillMarkdown(
      original,
      options.name,
      `# ${options.name}\n\nForked from \`simple-changes\` @ \`${upstreamCommit}\`. Fork-specific deltas: ${deltas}`
    )
  );
  const codex = files.find((file) => file.path === CODEX_METADATA);
  if (codex) {
    codex.content = Buffer.from(
      forkCodexMetadata(codex.content.toString("utf8"), options.name)
    );
  }
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
    description: forkDescription(options.name),
    destination,
    fileCount: files.length,
    name: options.name,
    source,
    upstreamCommit,
  };
};
