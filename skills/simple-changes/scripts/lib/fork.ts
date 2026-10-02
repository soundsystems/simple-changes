import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

const treeMatches = (
  upstream: string,
  commit: string,
  files: SourceFile[]
): boolean => {
  const entries = runGit(upstream, [
    "ls-tree",
    "-r",
    "-z",
    commit,
    "--",
    SKILL_PATH,
  ])
    .stdout.split("\0")
    .filter(Boolean);
  if (entries.length !== files.length) {
    return false;
  }
  const hashes = new Map(
    files.map((file) => [
      `${SKILL_PATH}/${file.path}`,
      createHash("sha1")
        .update(`blob ${file.content.length}\0`)
        .update(file.content)
        .digest("hex"),
    ])
  );
  return entries.every((entry) => {
    const match = TREE_ENTRY.exec(entry);
    return match !== null && hashes.get(match[3] ?? "") === match[2];
  });
};

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
  return (
    commit ??
    unsafe(
      "The installed source does not match an upstream commit. Update the global skill, or pass --upstream PATH to its complete source checkout. No fork was created."
    )
  );
};

const locateSourceCommit = (
  options: CreateForkOptions,
  files: SourceFile[]
): string => {
  if (options.upstreamPath) {
    return verifySourceCommit(resolve(options.upstreamPath), files);
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
const reserveDestination = (root: string, destination: string): void => {
  let directory = root;
  for (const part of relative(root, dirname(destination))
    .split(sep)
    .filter(Boolean)) {
    directory = join(directory, part);
    try {
      mkdirSync(directory);
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
};

export const createFork = (options: CreateForkOptions): CreatedFork => {
  if (
    !NAME_PATTERN.test(options.name) ||
    options.name.length > 64 ||
    options.name === "simple-changes"
  ) {
    throw new SimpleChangesError(
      "--name must be a distinct lowercase skill name, at most 64 characters, using letters, digits, and hyphens.",
      EXIT_CODES.usage
    );
  }
  const deltas = options.deltas.trim().replace(/\s+/gu, " ");
  if (!deltas) {
    throw new SimpleChangesError(
      "--deltas must describe the fork's intended custom behavior.",
      EXIT_CODES.usage
    );
  }
  const root = realpathSync(options.repositoryPath);
  const source = realpathSync(options.sourcePath);
  const destination = resolve(
    root,
    options.destination ?? `.agents/skills/${options.name}`
  );
  if (
    !inside(root, destination) ||
    destination === source ||
    inside(source, destination) ||
    inside(destination, source)
  ) {
    unsafe(
      "Destination must be inside the repository and separate from the source skill."
    );
  }
  const files = snapshotSource(source);
  const skill = files.find((file) => file.path === "SKILL.md");
  const original = skill?.content.toString("utf8") ?? "";
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
  reserveDestination(root, destination);
  try {
    for (const file of files) {
      const path = join(destination, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content, { flag: "wx" });
      chmodSync(path, file.mode % 0o1000);
    }
  } catch (error) {
    rmSync(destination, { force: true, recursive: true });
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
