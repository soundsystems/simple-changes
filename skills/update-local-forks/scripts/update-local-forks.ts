#!/usr/bin/env bun
/**
 * Update local forks of Simple Changes from the globally installed skill
 * while preserving each fork's own behavior.
 *
 * A fork records `Forked from \`simple-changes\` @ \`<sha>\`` under its title.
 * That pin is the merge base. The installed skill is the merge target. Every
 * file is classified by comparing base, target, and fork; portable upstream
 * changes are applied, fork deltas are kept, overlapping edits are three-way
 * merged with `git merge-file`, and anything ambiguous is reported for review
 * instead of written. Nothing is committed, pushed, or executed in the fork.
 */
import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "bun";

const VERSION = "1.0.0";
const DEFAULT_UPSTREAM_URL =
  "https://gitlab.com/soundsystems/simple-changes.git";
/**
 * How much default-branch history the cache fetches. The release search reads
 * the release entry and every commit after it up to the tip, so the depth must
 * reach back past recent releases; the bound keeps the cache small.
 */
const UPSTREAM_FETCH_DEPTH = 400;
const UPSTREAM_SKILL_PATH = "skills/simple-changes";
const PROVENANCE_PATTERN = /Forked from `simple-changes` @ `([0-9a-f]{7,40})`/u;
const GUIDANCE_PATTERN = /CURRENT_GUIDANCE_VERSION = (\d+);/u;
const CHANGELOG_VERSION_PATTERN = /^## (\d+\.\d+\.\d+)\b/mu;
const SKILL_NAME_PATTERN = /^name:\s*(\S+)\s*$/mu;
const GLOBAL_SKILL_ROOTS = [
  ".agents/skills",
  ".codex/skills",
  ".claude/skills",
  ".cursor/skills",
];
const PROJECT_ROOTS = ["Developer", "Projects", "Code", "src"];
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".cache",
  "Library",
  ".Trash",
  "dist",
  "coverage",
]);
const RUNTIME_PREFIXES = ["scripts/", "evals/"];
const REFERENCE_PREFIX = "references/";
/** The fork note whose Intentional omissions section lists omitted references. */
const OMISSIONS_FILE = "references/fork-maintenance.md";
const OMISSIONS_HEADING_PATTERN =
  /^##[ \t]+Intentional omissions[ \t]*#*[ \t]*$/iu;
const TOP_HEADING_PATTERN = /^#{1,2}[ \t]/u;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const OMISSION_ENTRY_PATTERN = /^[-*][ \t]+`([^`\s]+)`:[ \t]+(\S.*)$/u;
const LINE_BREAK_PATTERN = /\r?\n/u;
/** Sidecar left beside a file whose upstream merge conflicted. */
const MERGE_SIDECAR_SUFFIX = ".upstream-merge";
const EXIT = { blocked: 3, failure: 4, success: 0, usage: 2 } as const;

class ForkUpdateError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.failure) {
    super(message);
    this.exitCode = exitCode;
  }
}

const byText = (left: string, right: string): number =>
  left.localeCompare(right);

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const run = (
  command: string[],
  cwd?: string,
  input?: string
): { exitCode: number; stdout: string; stderr: string } => {
  const result = spawnSync(command, {
    ...(cwd === undefined ? {} : { cwd }),
    ...(input === undefined ? {} : { stdin: new TextEncoder().encode(input) }),
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  };
};

const git = (cwd: string, args: string[], allowFailure = false): string => {
  const result = run(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0 && !allowFailure) {
    throw new ForkUpdateError(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  return result.stdout;
};

const readText = (path: string): string | null =>
  existsSync(path) && statSync(path).isFile()
    ? readFileSync(path, "utf8")
    : null;

const walkFiles = (root: string, base = root): string[] => {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIRECTORIES.has(entry.name) ? [] : walkFiles(path, base);
    }
    return entry.isFile() ? [relative(base, path)] : [];
  });
};

const assertNoSymlinkPath = (root: string, relativePath: string): void => {
  let current = root;
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    const status = lstatSync(current, { throwIfNoEntry: false });
    if (status?.isSymbolicLink()) {
      throw new ForkUpdateError(
        `${relativePath} traverses a symlink inside the fork; replace it with a real path before updating.`,
        EXIT.blocked
      );
    }
  }
};

// ---------------------------------------------------------------- discovery

export interface DiscoveredFork {
  name: string;
  path: string;
  pin: string;
  /** The Git checkout that owns the fork, or null outside any repository. */
  repository: { linkedWorktree: boolean; root: string } | null;
  runtimeLayout: "runtime-directory" | "in-place";
}

export interface DiscoveredSource {
  guidanceVersion: number | null;
  path: string;
  version: string | null;
}

const skillNameOf = (skillMarkdown: string): string | null =>
  SKILL_NAME_PATTERN.exec(skillMarkdown)?.[1] ?? null;

const runtimeLayoutOf = (forkPath: string): DiscoveredFork["runtimeLayout"] =>
  existsSync(join(forkPath, "runtime", "scripts")) ||
  existsSync(join(forkPath, "runtime", "evals"))
    ? "runtime-directory"
    : "in-place";

// A fork inside a linked Git worktree is the same fork as the one in its
// primary checkout; updating it there would only create a duplicate change.
const repositoryOf = (path: string): DiscoveredFork["repository"] => {
  const top = run(["git", "-C", path, "rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) {
    return null;
  }
  const gitDir = run([
    "git",
    "-C",
    path,
    "rev-parse",
    "--git-dir",
  ]).stdout.trim();
  const commonDir = run([
    "git",
    "-C",
    path,
    "rev-parse",
    "--git-common-dir",
  ]).stdout.trim();
  return {
    linkedWorktree: resolve(path, gitDir) !== resolve(path, commonDir),
    root: top.stdout.trim(),
  };
};

export const inspectFork = (forkPath: string): DiscoveredFork | null => {
  const skill = readText(join(forkPath, "SKILL.md"));
  if (!skill) {
    return null;
  }
  const pin = PROVENANCE_PATTERN.exec(skill)?.[1];
  const name = skillNameOf(skill);
  if (!(pin && name)) {
    return null;
  }
  const path = realpathSync(forkPath);
  return {
    name,
    path,
    pin,
    repository: repositoryOf(path),
    runtimeLayout: runtimeLayoutOf(forkPath),
  };
};

export const inspectSource = (sourcePath: string): DiscoveredSource | null => {
  const skill = readText(join(sourcePath, "SKILL.md"));
  if (!skill || skillNameOf(skill) !== "simple-changes") {
    return null;
  }
  if (PROVENANCE_PATTERN.test(skill)) {
    return null;
  }
  const changelog = readText(join(sourcePath, "CHANGELOG.md")) ?? "";
  const guidance =
    readText(join(sourcePath, "scripts", "lib", "guidance-updates.ts")) ?? "";
  const guidanceVersion = GUIDANCE_PATTERN.exec(guidance)?.[1];
  return {
    guidanceVersion: guidanceVersion ? Number(guidanceVersion) : null,
    path: realpathSync(sourcePath),
    version: CHANGELOG_VERSION_PATTERN.exec(changelog)?.[1] ?? null,
  };
};

const safeReaddir = (root: string): Dirent[] => {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
};

const descendInto = (name: string, depth: number): boolean =>
  !SKIP_DIRECTORIES.has(name) &&
  (depth === 0 || !name.startsWith(".") || name === ".agents");

const walkSkillDirectories = (
  root: string,
  maxDepth: number,
  depth = 0
): string[] => {
  if (!existsSync(root) || depth > maxDepth) {
    return [];
  }
  const entries = safeReaddir(root);
  const here = entries.some(
    (entry) => entry.isFile() && entry.name === "SKILL.md"
  )
    ? [root]
    : [];
  return [
    ...here,
    ...entries
      .filter((entry) => entry.isDirectory() && descendInto(entry.name, depth))
      .flatMap((entry) =>
        walkSkillDirectories(join(root, entry.name), maxDepth, depth + 1)
      ),
  ];
};

export interface DiscoveryResult {
  forks: DiscoveredFork[];
  roots: string[];
  sources: DiscoveredSource[];
}

export const discover = (options: {
  home?: string;
  maxDepth?: number;
  roots: string[];
}): DiscoveryResult => {
  const home = options.home ?? homedir();
  const roots = [
    ...GLOBAL_SKILL_ROOTS.map((root) => join(home, root)),
    ...PROJECT_ROOTS.map((root) => join(home, root)),
    ...options.roots,
  ].filter(
    (root, index, all) => existsSync(root) && all.indexOf(root) === index
  );
  const seen = new Set<string>();
  const forks: DiscoveredFork[] = [];
  const sources: DiscoveredSource[] = [];
  for (const root of roots) {
    for (const directory of walkSkillDirectories(root, options.maxDepth ?? 6)) {
      const real = realpathSync(directory);
      if (seen.has(real)) {
        continue;
      }
      seen.add(real);
      const fork = inspectFork(real);
      if (fork) {
        forks.push(fork);
        continue;
      }
      const source = inspectSource(real);
      if (source) {
        sources.push(source);
      }
    }
  }
  return { forks, roots, sources };
};

// ----------------------------------------------------------------- upstream

export interface UpstreamHandle {
  /** A Git directory that can resolve the pin and the release commit. */
  gitDirectory: string;
  kind: "checkout" | "cache";
}

const cacheDirectory = (override?: string): string =>
  override ??
  join(
    homedir(),
    ".cache",
    "simple-changes",
    "update-local-forks",
    "upstream.git"
  );

const ensureCommit = (
  upstream: UpstreamHandle,
  sha: string,
  url: string
): void => {
  if (
    run([
      "git",
      "-C",
      upstream.gitDirectory,
      "cat-file",
      "-e",
      `${sha}^{commit}`,
    ]).exitCode === 0
  ) {
    return;
  }
  if (upstream.kind === "checkout") {
    throw new ForkUpdateError(
      `Upstream checkout ${upstream.gitDirectory} does not contain ${sha}; fetch it first.`,
      EXIT.blocked
    );
  }
  const fetched = run([
    "git",
    "-C",
    upstream.gitDirectory,
    "fetch",
    "--quiet",
    "--depth",
    "1",
    url,
    sha,
  ]);
  if (fetched.exitCode !== 0) {
    throw new ForkUpdateError(
      `Could not fetch pinned commit ${sha} from ${url}: ${fetched.stderr.trim()}`,
      EXIT.blocked
    );
  }
};

export const openUpstream = (options: {
  cache?: string;
  upstream?: string;
  url?: string;
}): UpstreamHandle => {
  if (options.upstream) {
    const checkout = resolve(options.upstream);
    if (!existsSync(join(checkout, UPSTREAM_SKILL_PATH, "SKILL.md"))) {
      throw new ForkUpdateError(
        `${checkout} is not a Simple Changes source checkout.`,
        EXIT.usage
      );
    }
    git(checkout, ["rev-parse", "--git-dir"]);
    return { gitDirectory: checkout, kind: "checkout" };
  }
  const cache = cacheDirectory(options.cache);
  if (!existsSync(cache)) {
    mkdirSync(dirname(cache), { recursive: true });
    git(dirname(cache), ["init", "--quiet", "--bare", cache]);
  }
  return { gitDirectory: cache, kind: "cache" };
};

const treeFiles = (upstream: UpstreamHandle, sha: string): string[] =>
  git(upstream.gitDirectory, [
    "ls-tree",
    "-r",
    "--name-only",
    sha,
    `${UPSTREAM_SKILL_PATH}/`,
  ])
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(UPSTREAM_SKILL_PATH.length + 1));

const treeFile = (
  upstream: UpstreamHandle,
  sha: string,
  path: string
): string | null => {
  const result = run([
    "git",
    "-C",
    upstream.gitDirectory,
    "show",
    `${sha}:${UPSTREAM_SKILL_PATH}/${path}`,
  ]);
  return result.exitCode === 0 ? result.stdout : null;
};

/** A packaged blob at `sha` as a byte string, read raw, or null. */
const treeBlob = (
  upstream: UpstreamHandle,
  sha: string,
  path: string
): string | null => {
  const result = spawnSync(
    [
      "git",
      "-C",
      upstream.gitDirectory,
      "cat-file",
      "blob",
      `${sha}:${UPSTREAM_SKILL_PATH}/${path}`,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  return result.exitCode === 0 ? byteString(result.stdout) : null;
};

/**
 * A path as a byte string: one character per raw byte. Filenames are bytes,
 * and decoding them as UTF-8 maps distinct invalid sequences to the same
 * replacement character, so a proof compares byte strings, never decoded
 * names.
 */
const byteString = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("latin1");

const byByte = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/**
 * A file's contents as a byte string, or null when it is not a regular file.
 * Plans compare, merge, and rewrite byte strings so every byte a fork receives
 * is the byte upstream or the fork already had; decoding to text would turn
 * invalid UTF-8 into replacement characters on the way back to disk.
 */
const readBytes = (path: string): string | null =>
  existsSync(path) && statSync(path).isFile()
    ? byteString(readFileSync(path))
    : null;

/** The digest of a byte string's raw bytes. */
const bytesDigest = (bytes: string): string =>
  sha256(Buffer.from(bytes, "latin1"));

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

const isUtf8 = (bytes: Uint8Array): boolean => {
  try {
    STRICT_UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/** A literal the rewrite moves: printable ASCII, so bytes and text agree. */
const ASCII_LITERAL_PATTERN = /^[\x20-\x7e]*$/u;

/** One digest over paths and raw file bytes, shared by both sides of a proof. */
const filesDigest = (files: { bytes: Buffer; path: string }[]): string =>
  sha256(
    [...files]
      .sort((left, right) => byByte(left.path, right.path))
      .map(({ bytes, path }) => `${path}\0${sha256(bytes)}`)
      .join("\n")
  );

const SLASH = Buffer.from("/");

/** Raw relative path bytes of every regular file under `root`, as walkFiles. */
const walkFileBytes = (root: Buffer, prefix?: Buffer): Buffer[] =>
  readdirSync(prefix ? Buffer.concat([root, SLASH, prefix]) : root, {
    encoding: "buffer",
  }).flatMap((raw) => {
    const name = Buffer.from(raw);
    const path = prefix ? Buffer.concat([prefix, SLASH, name]) : name;
    const status = lstatSync(Buffer.concat([root, SLASH, path]));
    if (status.isDirectory()) {
      return SKIP_DIRECTORIES.has(byteString(name))
        ? []
        : walkFileBytes(root, path);
    }
    return status.isFile() ? [path] : [];
  });

/**
 * The hex bytes of each path that is not valid UTF-8. Planning reads paths as
 * text, where such a path decodes to a replacement character and names no
 * file, so the file would silently drop out of the plan: no such path is ever
 * verified or planned.
 */
const nonUtf8Paths = (paths: Uint8Array[]): string[] =>
  paths
    .filter((path) => !isUtf8(path))
    .map((path) => Buffer.from(path).toString("hex"));

/** The installed source's files: byte-string paths and where to read them. */
const installedFiles = (
  sourcePath: string
): { location: Buffer; path: string }[] => {
  const root = Buffer.from(sourcePath);
  return walkFileBytes(root).map((path) => ({
    location: Buffer.concat([root, SLASH, path]),
    path: byteString(path),
  }));
};

/**
 * The raw bytes of each blob, read in one `git cat-file --batch` call. Never
 * decoded: text decoding maps distinct invalid byte sequences to the same
 * replacement characters, so decoded content cannot prove byte identity.
 */
const readBlobs = (upstream: UpstreamHandle, ids: string[]): Buffer[] => {
  const result = spawnSync(
    ["git", "-C", upstream.gitDirectory, "cat-file", "--batch"],
    {
      stderr: "pipe",
      stdin: new TextEncoder().encode(ids.map((id) => `${id}\n`).join("")),
      stdout: "pipe",
    }
  );
  if (result.exitCode !== 0) {
    throw new ForkUpdateError(
      `git cat-file --batch failed: ${new TextDecoder().decode(result.stderr).trim()}`
    );
  }
  const output = Buffer.from(result.stdout);
  let offset = 0;
  return ids.map((id) => {
    const end = output.indexOf(0x0a, offset);
    const [name, type, size] = output
      .subarray(offset, end < 0 ? offset : end)
      .toString("latin1")
      .split(" ");
    const length = Number(size);
    if (
      end < 0 ||
      name !== id ||
      type !== "blob" ||
      !Number.isInteger(length)
    ) {
      throw new ForkUpdateError(`git cat-file --batch could not read ${id}.`);
    }
    offset = end + 1 + length + 1;
    return output.subarray(end + 1, end + 1 + length);
  });
};

/**
 * The packaged skill tree and packaged changelog blob of each commit, read in
 * one `git cat-file` call; an entry is null where the commit lacks that path.
 */
const packagedObjects = (
  upstream: UpstreamHandle,
  commits: string[]
): Map<string, { changelog: string | null; tree: string | null }> => {
  const listing = run(
    [
      "git",
      "-C",
      upstream.gitDirectory,
      "cat-file",
      "--batch-check=%(objectname) %(objecttype)",
    ],
    undefined,
    commits
      .flatMap((commit) => [
        `${commit}:${UPSTREAM_SKILL_PATH}`,
        `${commit}:${UPSTREAM_SKILL_PATH}/CHANGELOG.md`,
      ])
      .map((line) => `${line}\n`)
      .join("")
  );
  if (listing.exitCode !== 0) {
    throw new ForkUpdateError(
      `git cat-file --batch-check failed: ${listing.stderr.trim()}`
    );
  }
  const lines = listing.stdout.split("\n");
  const object = (line: string | undefined, type: string): string | null => {
    const [name, kind] = (line ?? "").split(" ");
    return kind === type && name ? name : null;
  };
  return new Map(
    commits.map((commit, index) => [
      commit,
      {
        changelog: object(lines[index * 2 + 1], "blob"),
        tree: object(lines[index * 2], "tree"),
      },
    ])
  );
};

/** Commits whose packaged objects one `git cat-file` call looks up. */
const WINDOW_LOOKUP_BATCH = 64;

/**
 * The entry and its descendants up to `ref`, parents first, each with its
 * parents in order; a parent outside the walk is kept so the first parent
 * stays first.
 */
const descendantsOf = (
  upstream: UpstreamHandle,
  entry: string,
  ref: string
): { order: string[]; parents: Map<string, string[]> } => {
  const parents = new Map<string, string[]>([[entry, []]]);
  const order = [entry];
  for (const line of git(upstream.gitDirectory, [
    "rev-list",
    "--ancestry-path",
    "--topo-order",
    "--reverse",
    "--parents",
    `${entry}..${ref}`,
  ]).split("\n")) {
    const [commit, ...commitParents] = line.split(" ").filter(Boolean);
    if (commit) {
      parents.set(commit, commitParents);
      order.push(commit);
    }
  }
  return { order, parents };
};

/** The top version of each packaged changelog blob, read once per blob. */
const changelogVersions = (
  upstream: UpstreamHandle
): ((changelog: string) => string | null) => {
  const versions = new Map<string, string | null>();
  return (changelog) => {
    if (!versions.has(changelog)) {
      versions.set(
        changelog,
        CHANGELOG_VERSION_PATTERN.exec(
          git(upstream.gitDirectory, ["cat-file", "blob", changelog])
        )?.[1] ?? null
      );
    }
    return versions.get(changelog) ?? null;
  };
};

/** The window commits on `ref`'s first-parent chain inside the walk. */
const firstParentWithin = (
  upstream: UpstreamHandle,
  ref: string,
  parents: Map<string, string[]>,
  window: Map<string, string>
): Set<string> => {
  const firstParent = new Set<string>();
  let current = git(upstream.gitDirectory, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]).trim();
  while (parents.has(current)) {
    if (window.has(current)) {
      firstParent.add(current);
    }
    current = parents.get(current)?.[0] ?? "";
  }
  return firstParent;
};

/**
 * Commits a release may have shipped from: the commit that added the release
 * entry and its descendants on the searched branch, parents first, up to but
 * not including the next release entry. Review fixes often land after the
 * release-prep commit without touching the changelog, so the released tree is
 * frequently a later commit. A commit whose packaged changelog names another
 * top version is a release entry of its own and bounds the window, and so
 * does everything after it. The walk stops reading commits once no child of a
 * window commit is left undecided, since no later commit can then join it.
 * `firstParent` holds the window's commits on the branch's first-parent
 * history: what a merge brought onto the branch, as opposed to a commit only
 * on a merged side branch. `examined` counts the commits read.
 */
export const releaseWindow = (
  upstream: UpstreamHandle,
  entry: string,
  ref: string,
  version: string
): {
  commits: string[];
  examined: number;
  firstParent: Set<string>;
  trees: Map<string, string>;
} => {
  const { order, parents } = descendantsOf(upstream, entry, ref);
  // Only parents inside the walk can carry the window forward.
  const walkParents = (commit: string): string[] =>
    (parents.get(commit) ?? []).filter((parent) => parents.has(parent));
  const children = new Map<string, number>();
  for (const commit of order) {
    for (const parent of walkParents(commit)) {
      children.set(parent, (children.get(parent) ?? 0) + 1);
    }
  }
  const topVersion = changelogVersions(upstream);
  const objects = new Map<
    string,
    { changelog: string | null; tree: string | null }
  >();
  const trees = new Map<string, string>();
  // Children of window commits not yet decided.
  let undecided = 0;
  let examined = 0;
  for (const [index, commit] of order.entries()) {
    if (index > 0 && undecided === 0) {
      break;
    }
    if (!objects.has(commit)) {
      const batch = order.slice(index, index + WINDOW_LOOKUP_BATCH);
      for (const [key, value] of packagedObjects(upstream, batch)) {
        objects.set(key, value);
      }
    }
    examined += 1;
    // Parents come first, so every parent inside the walk is already decided.
    const commitParents = walkParents(commit);
    undecided -= commitParents.filter((parent) => trees.has(parent)).length;
    const pastNextRelease = commitParents.some((parent) => !trees.has(parent));
    const { changelog, tree } = objects.get(commit) ?? {};
    if (
      !pastNextRelease &&
      changelog &&
      tree &&
      topVersion(changelog) === version
    ) {
      trees.set(commit, tree);
      undecided += children.get(commit) ?? 0;
    }
  }
  return {
    commits: order.filter((commit) => trees.has(commit)),
    examined,
    firstParent: firstParentWithin(upstream, ref, parents, trees),
    trees,
  };
};

interface TreeEntry {
  object: string | undefined;
  path: string;
  size: number;
  type: string | undefined;
}

const shortSha = (sha: string): string => sha.slice(0, 12);

/**
 * Every entry of a tree, recursively, from `git ls-tree -r -l -z` read as raw
 * bytes so each path stays a byte string.
 */
const treeListing = (upstream: UpstreamHandle, tree: string): TreeEntry[] => {
  const result = spawnSync(
    ["git", "-C", upstream.gitDirectory, "ls-tree", "-r", "-l", "-z", tree],
    { stderr: "pipe", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    throw new ForkUpdateError(
      `git ls-tree ${tree} failed: ${new TextDecoder().decode(result.stderr).trim()}`
    );
  }
  const output = Buffer.from(result.stdout);
  const entries: TreeEntry[] = [];
  for (let start = 0; start < output.length; ) {
    const end = output.indexOf(0, start);
    const record = output.subarray(start, end < 0 ? output.length : end);
    start = end < 0 ? output.length : end + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) {
      continue;
    }
    const [, type, object, size] = record
      .subarray(0, tab)
      .toString("latin1")
      .split(" ")
      .filter(Boolean);
    entries.push({
      object,
      path: byteString(record.subarray(tab + 1)),
      size: Number(size),
      type,
    });
  }
  return entries;
};

/**
 * Whether a packaged tree is byte-identical to the installed source. The path
 * and size listing of `git ls-tree` cheaply rules out most trees; any tree it
 * cannot rule out is proven by a digest of its raw blob bytes, so equality is
 * never assumed. Only blobs can match the installed regular files.
 */
const matchesInstalledTree = (
  upstream: UpstreamHandle,
  source: DiscoveredSource
): {
  matches: (commit: string, tree: string) => boolean;
  refused: string[];
} => {
  const installed = installedFiles(source.path);
  const refused = nonUtf8Paths(
    installed.map(({ path }) => Buffer.from(path, "latin1"))
  ).map((hex) => `the installed source holds path bytes ${hex}`);
  const installedUtf8 = refused.length === 0;
  const installedDigest = filesDigest(
    installed.map(({ location, path }) => ({
      bytes: readFileSync(location),
      path,
    }))
  );
  const installedSizes = new Map(
    installed.map(({ location, path }) => [path, statSync(location).size])
  );
  const verdicts = new Map<string, boolean>();
  const byteIdentical = (commit: string, tree: string): boolean => {
    const entries = treeListing(upstream, tree);
    const invalid = nonUtf8Paths(
      entries.map((entry) => Buffer.from(entry.path, "latin1"))
    );
    if (invalid.length > 0) {
      refused.push(
        `${shortSha(commit)} names path bytes ${invalid.join(", ")}`
      );
      return false;
    }
    const sameShape =
      installedUtf8 &&
      entries.length === installedSizes.size &&
      entries.every(
        (entry) =>
          entry.type === "blob" &&
          entry.object !== undefined &&
          installedSizes.get(entry.path) === entry.size
      );
    if (!sameShape) {
      return false;
    }
    const blobs = readBlobs(
      upstream,
      entries.map((entry) => entry.object ?? "")
    );
    return (
      filesDigest(
        entries.map((entry, index) => ({
          bytes: blobs[index] ?? Buffer.alloc(0),
          path: entry.path,
        }))
      ) === installedDigest
    );
  };
  return {
    matches: (commit, tree) => {
      if (!verdicts.has(tree)) {
        verdicts.set(tree, byteIdentical(commit, tree));
      }
      return verdicts.get(tree) ?? false;
    },
    refused,
  };
};

/**
 * Find the upstream commit whose packaged skill is byte-identical to the
 * installed source. Search the fetched default branch for the release entry,
 * then prove tree equality against the entry and every commit after it before
 * the next release entry, preferring the branch's own first-parent history so
 * the pin stays reachable from it; a provenance pin is never bumped to a guess.
 */
const locateSourceCommit = (
  upstream: UpstreamHandle,
  source: DiscoveredSource,
  url: string,
  branch: string
): { commit: string | null; verified: boolean; reason: string } => {
  const { version } = source;
  if (!version) {
    return {
      commit: null,
      reason: "The installed source names no version.",
      verified: false,
    };
  }
  if (upstream.kind === "cache") {
    const fetched = run([
      "git",
      "-C",
      upstream.gitDirectory,
      "fetch",
      "--quiet",
      "--depth",
      String(UPSTREAM_FETCH_DEPTH),
      url,
      `+refs/heads/${branch}:refs/remotes/upstream/${branch}`,
    ]);
    if (fetched.exitCode !== 0) {
      return {
        commit: null,
        reason: `Could not fetch ${branch} from ${url}: ${fetched.stderr.trim()}`,
        verified: false,
      };
    }
  }
  const ref =
    upstream.kind === "cache" ? `refs/remotes/upstream/${branch}` : branch;
  const entries = git(
    upstream.gitDirectory,
    [
      "log",
      "--format=%H",
      `-S## ${version} `,
      ref,
      "--",
      `${UPSTREAM_SKILL_PATH}/CHANGELOG.md`,
    ],
    true
  )
    .split("\n")
    .filter(Boolean);
  if (entries.length === 0) {
    return {
      commit: null,
      reason: `No commit on ${branch} introduces release ${version}.`,
      verified: false,
    };
  }
  const { matches, refused } = matchesInstalledTree(upstream, source);
  const at = (commit: string, entry: string): string =>
    commit === entry
      ? `the ${version} release entry ${shortSha(entry)}`
      : `${shortSha(commit)}, after the ${version} release entry ${shortSha(entry)}`;
  const searched = new Set<string>();
  let sideBranch: { commit: string; entry: string } | null = null;
  for (const entry of entries) {
    const window = releaseWindow(upstream, entry, ref, version);
    const matching = window.commits.filter((commit) => {
      searched.add(commit);
      return matches(commit, window.trees.get(commit) ?? "");
    });
    const onBranch = matching.find((commit) => window.firstParent.has(commit));
    if (onBranch) {
      return {
        commit: onBranch,
        reason:
          onBranch === entry
            ? "byte-identical tree"
            : `byte-identical tree at ${at(onBranch, entry)} on ${branch}`,
        verified: true,
      };
    }
    const [first] = matching;
    sideBranch ??= first ? { commit: first, entry } : null;
  }
  if (sideBranch) {
    return {
      commit: sideBranch.commit,
      reason: `byte-identical tree at ${at(sideBranch.commit, sideBranch.entry)} on a branch merged into ${branch}; no first-parent commit of ${branch} carries that tree`,
      verified: true,
    };
  }
  return {
    commit: entries[0] ?? null,
    reason: `The installed source is not byte-identical to any of the ${searched.size} commit(s) on ${branch} from the ${version} release entry up to the next release entry; the pin will not be bumped.${refused.length > 0 ? ` A path that is not valid UTF-8 is never verified, and ${refused.join("; ")}.` : ""}`,
    verified: false,
  };
};

// --------------------------------------------------------------------- plan

export type PlanAction =
  | "current"
  | "update"
  | "merge"
  | "add"
  | "delete"
  | "keep-fork-delta"
  | "keep-fork-only"
  | "omitted"
  | "skip"
  | "conflict"
  | "review"
  | "unrecorded-omission";

export interface PlanEntry {
  action: PlanAction;
  /** What the entry writes, as UTF-8 text. */
  content?: string;
  /** What the entry writes, as base64, when the bytes are not valid UTF-8. */
  contentBase64?: string;
  forkDigest: string | null;
  forkPath: string;
  reason: string;
  sidecarDigest?: string | null;
  upstreamPath: string | null;
}

export interface LiteralRewrite {
  forkDigest: string;
  forkPath: string;
  from: string;
  to: string;
}

export interface ForkPlan {
  entries: PlanEntry[];
  fork: DiscoveredFork;
  literalRewrites: LiteralRewrite[];
  pinUpdate: { from: string; to: string | null; reason: string };
  schemaVersion: 1;
  source: DiscoveredSource & {
    commit: string | null;
    commitVerified: boolean;
  };
  summary: Record<PlanAction, number>;
}

const mapUpstreamPath = (
  fork: DiscoveredFork,
  upstreamPath: string
): string | null => {
  if (upstreamPath === "CHANGELOG.md") {
    return null;
  }
  if (
    fork.runtimeLayout === "runtime-directory" &&
    RUNTIME_PREFIXES.some((prefix) => upstreamPath.startsWith(prefix))
  ) {
    return `runtime/${upstreamPath}`;
  }
  return upstreamPath;
};

const isRuntimePath = (upstreamPath: string): boolean =>
  RUNTIME_PREFIXES.some((prefix) => upstreamPath.startsWith(prefix));

const mergeFile = (
  ours: string,
  base: string,
  theirs: string
): { conflict: boolean; merged: string } => {
  const scratch = join(
    tmpdir(),
    `update-local-forks-${process.pid}-${Date.now()}`
  );
  mkdirSync(scratch, { recursive: true });
  try {
    const paths = {
      base: join(scratch, "base"),
      ours: join(scratch, "ours"),
      theirs: join(scratch, "theirs"),
    };
    writeFileSync(paths.ours, Buffer.from(ours, "latin1"));
    writeFileSync(paths.base, Buffer.from(base, "latin1"));
    writeFileSync(paths.theirs, Buffer.from(theirs, "latin1"));
    const result = spawnSync(
      [
        "git",
        "merge-file",
        "-p",
        "-L",
        "fork",
        "-L",
        "pinned upstream",
        "-L",
        "installed upstream",
        paths.ours,
        paths.base,
        paths.theirs,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    return {
      conflict: result.exitCode !== 0,
      merged: byteString(result.stdout),
    };
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
};

interface Versions {
  base: string | null;
  current: string | null;
  target: string | null;
}

interface Outcome {
  action: PlanAction;
  content?: string;
  reason: string;
}

const outcome = (
  action: PlanAction,
  reason: string,
  content?: string
): Outcome => ({
  action,
  reason,
  ...(content === undefined ? {} : { content }),
});

const classifyAddedUpstream = (
  upstreamPath: string,
  { current, target }: Versions
): Outcome => {
  if (current === null) {
    return isRuntimePath(upstreamPath)
      ? outcome("add", "New upstream runtime file.", target ?? "")
      : outcome(
          "review",
          "New upstream file outside the runtime; decide whether this fork should carry it."
        );
  }
  return current === target
    ? outcome("current", "Already matches the installed upstream.")
    : outcome(
        "conflict",
        "Both upstream and the fork added this file with different contents."
      );
};

const classifyRemovedUpstream = ({ base, current }: Versions): Outcome => {
  if (current === null) {
    return outcome("current", "Removed upstream and absent from the fork.");
  }
  return current === base
    ? outcome("delete", "Removed upstream and unchanged in the fork.")
    : outcome(
        "review",
        "Removed upstream but changed in the fork; keep or drop it deliberately."
      );
};

const classifyUnchangedUpstream = ({ base, current }: Versions): Outcome => {
  if (current === null) {
    return outcome("omitted", "Unchanged upstream; the fork omits it.");
  }
  return current === base
    ? outcome("current", "Unchanged upstream and in the fork.")
    : outcome("keep-fork-delta", "Unchanged upstream; the fork's edit stands.");
};

const classifyChangedUpstream = (versions: Versions): Outcome => {
  const { base, current, target } = versions;
  if (current === null) {
    return outcome(
      "review",
      "Changed upstream but the fork omits this file; confirm the omission still applies."
    );
  }
  if (current === target) {
    return outcome("current", "Already matches the installed upstream.");
  }
  if (current === base) {
    return outcome(
      "update",
      "Changed upstream only; apply the upstream version.",
      target ?? ""
    );
  }
  const { conflict, merged } = mergeFile(current, base ?? "", target ?? "");
  return conflict
    ? outcome(
        "conflict",
        `Upstream and the fork changed overlapping lines; the marked merge is written beside the file as ${MERGE_SIDECAR_SUFFIX} for a hand merge.`,
        merged
      )
    : outcome(
        "merge",
        "Upstream and the fork changed different lines; three-way merge applied.",
        merged
      );
};

/** The code fence open after `line`, given the fence open before it. */
const fenceAfter = (line: string, fence: string | null): string | null => {
  if (fence === null) {
    return FENCE_OPEN_PATTERN.exec(line)?.[1] ?? null;
  }
  const closing = FENCE_CLOSE_PATTERN.exec(line)?.[1];
  return closing && closing[0] === fence[0] && closing.length >= fence.length
    ? null
    : fence;
};

/**
 * The upstream files a fork records as intentionally omitted, with the reason
 * it gives: list items of the form `- \`<path>\`: <reason>` under the
 * `## Intentional omissions` heading of its references/fork-maintenance.md.
 * Items outside that section or inside a code fence are examples, not records.
 */
export const intentionalOmissions = (forkPath: string): Map<string, string> => {
  const omissions = new Map<string, string>();
  const note = readText(join(forkPath, OMISSIONS_FILE));
  if (note === null) {
    return omissions;
  }
  let inSection = false;
  let fence: string | null = null;
  for (const line of note.split(LINE_BREAK_PATTERN)) {
    const wasFenced = fence !== null;
    fence = fenceAfter(line, fence);
    if (wasFenced || fence !== null) {
      continue;
    }
    if (OMISSIONS_HEADING_PATTERN.test(line)) {
      inSection = true;
    } else if (TOP_HEADING_PATTERN.test(line)) {
      inSection = false;
    } else if (inSection) {
      const [, path, reason] = OMISSION_ENTRY_PATTERN.exec(line) ?? [];
      if (path && reason) {
        omissions.set(path, reason.trim());
      }
    }
  }
  return omissions;
};

/**
 * A reference that upstream added or changed since the pin and the fork does
 * not carry: new guidance never reaches the fork unless it carries the file or
 * records why it leaves it out. A recorded omission stays a review item; an
 * unrecorded one blocks the pin.
 */
const classifyOmittedReference = (
  upstreamPath: string,
  { base, current, target }: Versions,
  omissions: ReadonlyMap<string, string>
): Outcome | null => {
  if (
    !upstreamPath.startsWith(REFERENCE_PREFIX) ||
    current !== null ||
    target === null ||
    target === base
  ) {
    return null;
  }
  const change = base === null ? "New upstream" : "Changed upstream";
  const reason = omissions.get(upstreamPath);
  return reason === undefined
    ? outcome(
        "unrecorded-omission",
        `${change}, and the fork neither carries this reference nor lists it under Intentional omissions in ${OMISSIONS_FILE}; carry the file or record why the fork omits it.`
      )
    : outcome(
        "review",
        `${change}; ${OMISSIONS_FILE} records it as an intentional omission (${reason}). Confirm the reason still holds.`
      );
};

const classify = (
  upstreamPath: string,
  forkPath: string,
  versions: Versions,
  omissions: ReadonlyMap<string, string> = new Map()
): PlanEntry => {
  const { base, current, target } = versions;
  const omitted = classifyOmittedReference(upstreamPath, versions, omissions);
  let result: Outcome;
  if (omitted) {
    result = omitted;
  } else if (base === null && target !== null) {
    result = classifyAddedUpstream(upstreamPath, versions);
  } else if (base !== null && target === null) {
    result = classifyRemovedUpstream(versions);
  } else if (base === null || target === null) {
    result = outcome("current", "Nothing to compare.");
  } else if (target === base) {
    result = classifyUnchangedUpstream(versions);
  } else {
    result = classifyChangedUpstream(versions);
  }
  return {
    ...result,
    forkDigest: current === null ? null : bytesDigest(current),
    forkPath,
    upstreamPath,
  };
};

// A fork's own records keep the literal they were written with; a moved pin or
// version is a current claim only outside them. Any line naming a commit or
// version range is a record. In Markdown, so is every heading and every line
// in a section that is a history entry, a history section, or inside one.
// An entry heading names what it records: a commit, a range, or a date, as in
// `## Upstream 0.24.1 (`628c66b..fd16f54`)`, `### Fork fix: ... (pin
// `fd16f54`)`, or `## Canonical 0.12.4 (`1b7b7e7`)`. A heading naming a
// history, such as `## History`, holds entries. A history log runs to the end
// of its parent section, so every later section beside an entry is an entry
// too, even one titled only by its subject. A heading that starts with
// "Current", such as `## Current upstream (0.25.0)`, marks current state
// outside any history: its section stays a claim and ends the log beside it.
// A fork's changelogs are its own history; no literal in them is a claim.
const CHANGELOG_FILE_PATTERN = /(?:^|\/)[^/]*CHANGELOG[^/]*\.md$/iu;
const RANGE_PATTERN =
  /\b(?:[0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40}|\d+\.\d+\.\d+\.{2,3}\d+\.\d+\.\d+)\b/u;
const HEADING_LEVEL_PATTERN = /^ {0,3}(#{1,6})(?:\s|$)/u;
/**
 * A commit or a date: what a history entry's heading names besides a range. A
 * commit is an abbreviated or full SHA of any shape in backticks, after "pin",
 * "pinned at", "commit", or "sha", or alone or listed in parentheses, as in
 * "(pin deadbee)" or "(5028750)"; elsewhere a bare one must mix digits and
 * letters, so a word such as "defaced" or a number never reads as one.
 */
const ENTRY_HEADING_PATTERN =
  /`[0-9a-f]{7,40}`|\b(?:[Pp]in(?:ned)?(?:\s+(?:at|to))?|[Cc]ommit|SHA|sha)\s+[0-9a-f]{7,40}\b|\(\s*[0-9a-f]{7,40}\s*[),]|,\s*[0-9a-f]{7,40}\s*\)|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b|\d{4}-\d{2}-\d{2}/u;
const HISTORY_HEADING_PATTERN = /\bhistory\b/iu;
const CURRENT_HEADING_PATTERN = /^ {0,3}#{1,6}[ \t]+current\b/iu;

/** What a heading outside any history section marks. */
const headingKind = (
  line: string
): "current" | "entry" | "history" | "plain" => {
  if (CURRENT_HEADING_PATTERN.test(line)) {
    return "current";
  }
  if (RANGE_PATTERN.test(line) || ENTRY_HEADING_PATTERN.test(line)) {
    return "entry";
  }
  return HISTORY_HEADING_PATTERN.test(line) ? "history" : "plain";
};

interface RecordSection {
  /** Whether the log of entries among this section's children has begun. */
  entries: boolean;
  historical: boolean;
  level: number;
}

/** Close the sections a heading ends, then open the one it starts. */
const openSection = (
  sections: RecordSection[],
  document: { entries: boolean },
  level: number,
  line: string
): void => {
  while ((sections.at(-1)?.level ?? 0) >= level) {
    sections.pop();
  }
  const parent = sections.at(-1) ?? document;
  const kind = sections.some((section) => section.historical)
    ? "history"
    : headingKind(line);
  sections.push({
    entries: false,
    historical: kind === "plain" ? parent.entries : kind !== "current",
    level,
  });
  parent.entries = kind === "entry" || (kind !== "current" && parent.entries);
};

/**
 * Which lines are records. Lines come from splitting on LF, so a CRLF file's
 * lines keep a trailing CR; it is dropped for matching only, and the rewrite
 * keeps every line ending as written.
 */
const recordLines = (forkPath: string, rawLines: string[]): boolean[] => {
  const lines = rawLines.map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line
  );
  if (!forkPath.endsWith(".md")) {
    return lines.map((line) => RANGE_PATTERN.test(line));
  }
  const document = { entries: false };
  const sections: RecordSection[] = [];
  let fence: string | null = null;
  return lines.map((line) => {
    const fenced = fence !== null;
    fence = fenceAfter(line, fence);
    const heading =
      fenced || fence !== null ? null : HEADING_LEVEL_PATTERN.exec(line);
    if (heading) {
      openSection(sections, document, heading[1]?.length ?? 1, line);
      return true;
    }
    return RANGE_PATTERN.test(line) || (sections.at(-1)?.historical ?? false);
  });
};

export const rewriteLiteral = (
  forkPath: string,
  content: string,
  from: string,
  to: string
): { content: string; rewritten: number } => {
  const lines = content.split("\n");
  const records = recordLines(forkPath, lines);
  let rewritten = 0;
  const next = lines.map((line, index) => {
    if (records[index] || !line.includes(from)) {
      return line;
    }
    const parts = line.split(from);
    rewritten += parts.length - 1;
    return parts.join(to);
  });
  return { content: next.join("\n"), rewritten };
};

const literalRewritesFor = (
  fork: DiscoveredFork,
  plannedContent: Map<string, string>,
  source: ForkPlan["source"],
  oldPin: string,
  newPin: string | null,
  oldGuidance: number | null,
  oldVersion: string | null
): LiteralRewrite[] => {
  const rewrites: LiteralRewrite[] = [];
  const substitutions: [string, string][] = [];
  if (newPin) {
    substitutions.push([oldPin, newPin]);
  }
  if (oldGuidance !== null && source.guidanceVersion !== null) {
    substitutions.push([
      `CURRENT_GUIDANCE_VERSION = ${oldGuidance}`,
      `CURRENT_GUIDANCE_VERSION = ${source.guidanceVersion}`,
    ]);
  }
  if (oldVersion && source.version) {
    substitutions.push([
      `Simple Changes ${oldVersion}`,
      `Simple Changes ${source.version}`,
    ]);
  }
  const literals = substitutions.filter(([from, to]) =>
    [from, to].every((literal) => ASCII_LITERAL_PATTERN.test(literal))
  );
  for (const forkPath of walkFiles(fork.path)) {
    if (
      forkPath.startsWith("runtime/") ||
      forkPath.endsWith(MERGE_SIDECAR_SUFFIX) ||
      plannedContent.has(forkPath) ||
      CHANGELOG_FILE_PATTERN.test(forkPath)
    ) {
      continue;
    }
    // Byte strings: an ASCII literal moves and every other byte stays.
    const content = readBytes(join(fork.path, forkPath));
    if (content === null) {
      continue;
    }
    for (const [from, to] of literals) {
      if (
        from !== to &&
        rewriteLiteral(forkPath, content, from, to).rewritten > 0
      ) {
        rewrites.push({
          forkDigest: bytesDigest(content),
          forkPath,
          from,
          to,
        });
      }
    }
  }
  return rewrites.sort(
    (left, right) =>
      byText(left.forkPath, right.forkPath) || byText(left.from, right.from)
  );
};

const PLAN_ACTIONS: readonly PlanAction[] = [
  "current",
  "update",
  "merge",
  "add",
  "delete",
  "keep-fork-delta",
  "keep-fork-only",
  "omitted",
  "skip",
  "conflict",
  "review",
  "unrecorded-omission",
];

const summarize = (entries: PlanEntry[]): Record<PlanAction, number> =>
  Object.fromEntries(
    PLAN_ACTIONS.map((action) => [
      action,
      entries.filter((entry) => entry.action === action).length,
    ])
  ) as Record<PlanAction, number>;

// The provenance line lives in SKILL.md; rewrite it on whatever content the
// plan will write there, or on the current file when SKILL.md is untouched.
const advanceProvenance = (
  fork: DiscoveredFork,
  entries: PlanEntry[],
  plannedContent: Map<string, string>,
  newPin: string | null
): boolean => {
  const skillEntry = entries.find((entry) => entry.forkPath === "SKILL.md");
  if (!(newPin && skillEntry) || skillEntry.action === "conflict") {
    return false;
  }
  const basis =
    skillEntry.content ?? readBytes(join(fork.path, "SKILL.md")) ?? "";
  const rewritten = basis.replace(
    PROVENANCE_PATTERN,
    `Forked from \`simple-changes\` @ \`${newPin}\``
  );
  if (rewritten === basis) {
    return PROVENANCE_PATTERN.exec(basis)?.[1] === newPin;
  }
  skillEntry.content = rewritten;
  if (
    skillEntry.action === "current" ||
    skillEntry.action === "keep-fork-delta"
  ) {
    skillEntry.action = "update";
    skillEntry.reason = "Provenance pin advanced to the installed release.";
  }
  plannedContent.set("SKILL.md", rewritten);
  return true;
};

interface ClassifiedFork {
  entries: PlanEntry[];
  plannedContent: Map<string, string>;
}

const classifyForkFiles = (
  fork: DiscoveredFork,
  upstream: UpstreamHandle,
  source: DiscoveredSource
): ClassifiedFork => {
  const upstreamPaths = new Set([
    ...treeFiles(upstream, fork.pin),
    ...walkFiles(source.path),
  ]);
  const entries: PlanEntry[] = [];
  const plannedContent = new Map<string, string>();
  const forkPathsTouched = new Set<string>();
  const omissions = intentionalOmissions(fork.path);
  for (const upstreamPath of [...upstreamPaths].sort(byText)) {
    const forkPath = mapUpstreamPath(fork, upstreamPath);
    if (forkPath === null) {
      // The fork's own file at this path is that history; list it once.
      forkPathsTouched.add(upstreamPath);
      entries.push({
        action: "skip",
        forkDigest: null,
        forkPath: upstreamPath,
        reason: "The fork owns its own release history.",
        upstreamPath,
      });
      continue;
    }
    forkPathsTouched.add(forkPath);
    assertNoSymlinkPath(fork.path, forkPath);
    assertNoSymlinkPath(fork.path, forkPath + MERGE_SIDECAR_SUFFIX);
    if (existsSync(join(fork.path, forkPath + MERGE_SIDECAR_SUFFIX))) {
      forkPathsTouched.add(forkPath + MERGE_SIDECAR_SUFFIX);
      entries.push({
        action: "review",
        forkDigest: null,
        forkPath,
        reason: `An earlier upstream merge conflicted; merge ${forkPath}${MERGE_SIDECAR_SUFFIX} into this file by hand, then delete the sidecar.`,
        upstreamPath,
      });
      continue;
    }
    const entry = classify(
      upstreamPath,
      forkPath,
      {
        base: treeBlob(upstream, fork.pin, upstreamPath),
        current: readBytes(join(fork.path, forkPath)),
        target: readBytes(join(source.path, upstreamPath)),
      },
      omissions
    );
    if (entry.action === "conflict") {
      entry.sidecarDigest = null;
    }
    if (entry.content !== undefined) {
      plannedContent.set(forkPath, entry.content);
    }
    entries.push(entry);
  }
  for (const forkPath of walkFiles(fork.path).sort(byText)) {
    if (forkPath.endsWith(MERGE_SIDECAR_SUFFIX)) {
      // Reported through the file it belongs to; never a fork-owned file.
      continue;
    }
    if (!forkPathsTouched.has(forkPath)) {
      entries.push({
        action: "keep-fork-only",
        forkDigest: sha256(readFileSync(join(fork.path, forkPath))),
        forkPath,
        reason: "Fork-owned file with no upstream counterpart.",
        upstreamPath: null,
      });
    }
  }
  return { entries, plannedContent };
};

// ----------------------------------------------------------- command parity

/**
 * Every classifier above reasons about one file in isolation, which cannot see
 * an invariant that spans two: a fork that gates the runtime behind its own
 * allowlist has encoded the upstream command surface in a fork-owned file, and
 * a command added upstream silently falls outside it. The vendored runtime
 * updates cleanly, the gate keeps its fork-only classification, and the new
 * command is unreachable until someone runs into it. This pass runs over the
 * finished plan and reports that consequence.
 */
const CLI_SOURCE_PATH = "scripts/simple-changes.ts";
/** Documented surface: `  simple-changes <command>` lines in the help text. */
const HELP_COMMAND_PATTERN = /^ {2}simple-changes ([a-z][a-z0-9-]*)/gmu;
/** Answered surface: the case labels of the top-level dispatch switch. */
const DISPATCH_CASE_PATTERN = /case "([a-z][a-z0-9-]*)":/gu;
const DISPATCH_ANCHOR = "switch (command) {";
/** Extensions that can plausibly gate a command; prose is excluded on purpose. */
const GATE_EXTENSIONS = new Set([
  "bash",
  "cjs",
  "js",
  "json",
  "mjs",
  "py",
  "sh",
  "ts",
  "zsh",
]);
/**
 * A gate enumerates commands together, in an allowlist or a dispatch table.
 * Prose that happens to name commands scatters them across a document, so
 * density over a short window separates the two far better than a total count:
 * a shell allowlist packs five commands into one line, while an eval suite
 * naming as many spreads them over a case apiece.
 */
const GATE_MIN_COMMANDS = 3;
const GATE_WINDOW = 120;

// Brace-balanced slice of the dispatch switch. Template literals inside it
// balance their own braces; an unbalanced brace in a string would truncate the
// slice, which only costs the secondary source, since help text still covers.
const dispatchRegion = (source: string): string => {
  const start = source.indexOf(DISPATCH_ANCHOR);
  if (start < 0) {
    return "";
  }
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return source.slice(start);
};

const commandSurface = (cliSource: string | null): Set<string> => {
  const commands = new Set<string>();
  if (cliSource === null) {
    return commands;
  }
  for (const [, name] of cliSource.matchAll(HELP_COMMAND_PATTERN)) {
    if (name) {
      commands.add(name);
    }
  }
  for (const [, name] of dispatchRegion(cliSource).matchAll(
    DISPATCH_CASE_PATTERN
  )) {
    if (name) {
      commands.add(name);
    }
  }
  return commands;
};

const namesCommand = (content: string, command: string): boolean =>
  new RegExp(String.raw`(?<![\w-])${command}(?![\w-])`, "u").test(content);

/** Most distinct commands named inside any GATE_WINDOW-character span. */
const densestCommandRun = (content: string, commands: Set<string>): number => {
  const hits: { command: string; index: number }[] = [];
  for (const command of commands) {
    for (const match of content.matchAll(
      new RegExp(String.raw`(?<![\w-])${command}(?![\w-])`, "gu")
    )) {
      hits.push({ command, index: match.index });
    }
  }
  hits.sort((left, right) => left.index - right.index);
  let densest = 0;
  let start = 0;
  for (let end = 0; end < hits.length; end += 1) {
    const last = hits[end];
    if (!last) {
      continue;
    }
    while ((hits[start]?.index ?? 0) < last.index - GATE_WINDOW) {
      start += 1;
    }
    densest = Math.max(
      densest,
      new Set(hits.slice(start, end + 1).map((hit) => hit.command)).size
    );
  }
  return densest;
};

const isGateCandidate = (forkPath: string, content: string): boolean => {
  const name = forkPath.slice(forkPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return GATE_EXTENSIONS.has(extension) || content.startsWith("#!");
};

const commandParityReview = (
  fork: DiscoveredFork,
  entries: PlanEntry[],
  upstream: UpstreamHandle,
  source: DiscoveredSource
): Set<string> => {
  const base = commandSurface(treeFile(upstream, fork.pin, CLI_SOURCE_PATH));
  const target = commandSurface(readText(join(source.path, CLI_SOURCE_PATH)));
  const added = [...target]
    .filter((command) => !base.has(command))
    .sort(byText);
  if (added.length === 0 || base.size === 0) {
    return new Set();
  }
  const pending = new Set<string>();
  for (const entry of entries) {
    if (entry.action !== "keep-fork-only") {
      continue;
    }
    const content = readText(join(fork.path, entry.forkPath));
    if (content === null || !isGateCandidate(entry.forkPath, content)) {
      continue;
    }
    const gated = densestCommandRun(content, base);
    if (gated < GATE_MIN_COMMANDS) {
      continue;
    }
    const missing = added.filter((command) => !namesCommand(content, command));
    if (missing.length === 0) {
      continue;
    }
    pending.add(entry.forkPath);
    entry.action = "review";
    entry.reason = `This fork-owned file lists ${gated} upstream commands together, so it reads as a gate on the runtime surface. Upstream added ${missing.join(", ")}, which it does not name; extend it or confirm the omission is deliberate.`;
  }
  return pending;
};

/**
 * Why the provenance pin cannot advance yet, or null: new-command gate review
 * and unrecorded reference omissions both hold it. While either is pending,
 * SKILL.md stays on its old base; partially merging it without advancing its
 * pin can conflict with that same upstream hunk when the next plan retries.
 */
const holdPin = (
  entries: PlanEntry[],
  plannedContent: Map<string, string>,
  parityPending: boolean
): string | null => {
  const omissionsPending = entries.some(
    (entry) => entry.action === "unrecorded-omission"
  );
  if (!(parityPending || omissionsPending)) {
    return null;
  }
  const pending = [
    ...(parityPending ? ["new-command gate review"] : []),
    ...(omissionsPending ? ["every unrecorded reference omission"] : []),
  ].join(" and ");
  const skillEntry = entries.find((entry) => entry.forkPath === "SKILL.md");
  if (skillEntry && skillEntry.action !== "conflict") {
    skillEntry.action = "review";
    skillEntry.reason = `Keep the provenance file unchanged until ${pending} is resolved.`;
    Reflect.deleteProperty(skillEntry, "content");
    plannedContent.delete("SKILL.md");
  }
  return [
    ...(parityPending
      ? [
          "New upstream commands require fork-owned gate review; resolve it before advancing the pin.",
        ]
      : []),
    ...(omissionsPending
      ? [
          `Upstream references changed that this fork neither carries nor lists under Intentional omissions in ${OMISSIONS_FILE}; carry or record each before advancing the pin.`,
        ]
      : []),
  ].join(" ");
};

/**
 * A plan carries what it writes as UTF-8 text when the bytes are valid UTF-8,
 * which writes back byte for byte, and as base64 otherwise.
 */
const encodeContent = (entry: PlanEntry): void => {
  if (entry.content === undefined) {
    return;
  }
  const bytes = Buffer.from(entry.content, "latin1");
  if (isUtf8(bytes)) {
    entry.content = bytes.toString("utf8");
    return;
  }
  Reflect.deleteProperty(entry, "content");
  entry.contentBase64 = bytes.toString("base64");
};

/**
 * Planning reads paths as text, so it refuses a tree that holds a path that is
 * not valid UTF-8 instead of planning around a file it cannot name.
 */
const refuseNonUtf8Paths = (role: string, root: string): void => {
  const invalid = nonUtf8Paths(walkFileBytes(Buffer.from(root)));
  if (invalid.length > 0) {
    throw new ForkUpdateError(
      `The ${role} at ${root} holds path bytes that are not valid UTF-8 (hex ${invalid.join(", ")}); planning cannot carry such a file, so it refuses. Rename the file, then plan again.`,
      EXIT.blocked
    );
  }
};

export const planForkUpdate = (options: {
  branch?: string;
  cache?: string;
  fork: string;
  source: string;
  upstream?: string;
  url?: string;
}): ForkPlan => {
  const fork = inspectFork(resolve(options.fork));
  if (!fork) {
    throw new ForkUpdateError(
      `${options.fork} is not a Simple Changes fork: SKILL.md must carry a provenance pin.`,
      EXIT.usage
    );
  }
  const installed = inspectSource(resolve(options.source));
  if (!installed) {
    throw new ForkUpdateError(
      `${options.source} is not an installed Simple Changes skill.`,
      EXIT.usage
    );
  }
  refuseNonUtf8Paths("installed source", installed.path);
  refuseNonUtf8Paths("fork", fork.path);
  const url = options.url ?? DEFAULT_UPSTREAM_URL;
  const upstream = openUpstream({
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.upstream === undefined ? {} : { upstream: options.upstream }),
    url,
  });
  ensureCommit(upstream, fork.pin, url);
  const located = locateSourceCommit(
    upstream,
    installed,
    url,
    options.branch ?? "main"
  );
  const source = {
    ...installed,
    commit: located.commit,
    commitVerified: located.verified,
  };
  const pinnedGuidance = GUIDANCE_PATTERN.exec(
    treeFile(upstream, fork.pin, "scripts/lib/guidance-updates.ts") ?? ""
  )?.[1];
  const pinnedVersion = CHANGELOG_VERSION_PATTERN.exec(
    treeFile(upstream, fork.pin, "CHANGELOG.md") ?? ""
  )?.[1];

  const { entries, plannedContent } = classifyForkFiles(
    fork,
    upstream,
    installed
  );
  const parityReviewPaths = commandParityReview(
    fork,
    entries,
    upstream,
    installed
  );
  const heldReason = holdPin(
    entries,
    plannedContent,
    parityReviewPaths.size > 0
  );
  const pinCandidate = source.commitVerified ? source.commit : null;
  const pinReady =
    heldReason === null &&
    advanceProvenance(fork, entries, plannedContent, pinCandidate);
  const ordinaryPinReason =
    pinCandidate && !pinReady
      ? "The provenance file conflicts; resolve it before advancing the pin."
      : located.reason;
  const pinUpdate: ForkPlan["pinUpdate"] = {
    from: fork.pin,
    reason: heldReason ?? ordinaryPinReason,
    to: pinReady ? pinCandidate : null,
  };
  const literalRewrites = literalRewritesFor(
    fork,
    plannedContent,
    source,
    fork.pin,
    pinUpdate.to,
    pinnedGuidance ? Number(pinnedGuidance) : null,
    pinnedVersion ?? null
  ).filter(
    (rewrite) =>
      !parityReviewPaths.has(rewrite.forkPath) &&
      (heldReason === null || rewrite.forkPath !== "SKILL.md")
  );
  for (const entry of entries) {
    encodeContent(entry);
  }
  return {
    entries,
    fork,
    literalRewrites,
    pinUpdate,
    schemaVersion: 1,
    source,
    summary: summarize(entries),
  };
};

// -------------------------------------------------------------------- apply

export interface ApplyReceipt {
  conflicts: string[];
  deleted: string[];
  fork: string;
  literalRewrites: number;
  pin: { from: string; to: string | null };
  review: string[];
  unrecordedOmissions: string[];
  written: string[];
}

const WRITE_ACTIONS = new Set<PlanAction>(["update", "merge", "add"]);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * Strict base64: whole quads, correct padding, and the one encoding of its
 * bytes, so a truncated or hand-edited value can never write fewer bytes than
 * the plan meant.
 */
const isCanonicalBase64 = (value: string): boolean =>
  BASE64_PATTERN.test(value) &&
  Buffer.from(value, "base64").toString("base64") === value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = []
): boolean => {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};

const safeForkPath = (forkRoot: string, value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    return false;
  }
  const contained = relative(forkRoot, resolve(forkRoot, value));
  return (
    contained !== "" && !contained.startsWith("..") && !isAbsolute(contained)
  );
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The closed plan schema is deliberately validated field by field at one trust boundary.
const validateForkPlan = (value: unknown): ForkPlan => {
  if (
    !(
      isRecord(value) &&
      hasExactKeys(value, [
        "entries",
        "fork",
        "literalRewrites",
        "pinUpdate",
        "schemaVersion",
        "source",
        "summary",
      ])
    ) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.literalRewrites) ||
    !isRecord(value.fork) ||
    !isRecord(value.pinUpdate) ||
    !isRecord(value.source) ||
    !isRecord(value.summary)
  ) {
    throw new ForkUpdateError(
      "The plan file is not a closed fork plan.",
      EXIT.usage
    );
  }
  const { fork, summary } = value;
  if (
    !hasExactKeys(fork, [
      "name",
      "path",
      "pin",
      "repository",
      "runtimeLayout",
    ]) ||
    typeof fork.name !== "string" ||
    typeof fork.path !== "string" ||
    typeof fork.pin !== "string" ||
    !["runtime-directory", "in-place"].includes(String(fork.runtimeLayout)) ||
    !(
      fork.repository === null ||
      (isRecord(fork.repository) &&
        hasExactKeys(fork.repository, ["linkedWorktree", "root"]) &&
        typeof fork.repository.linkedWorktree === "boolean" &&
        typeof fork.repository.root === "string")
    )
  ) {
    throw new ForkUpdateError(
      "The plan carries an invalid fork identity.",
      EXIT.usage
    );
  }
  const canonicalFork = inspectFork(fork.path);
  if (
    !canonicalFork ||
    canonicalFork.path !== fork.path ||
    canonicalFork.name !== fork.name ||
    canonicalFork.pin !== fork.pin ||
    canonicalFork.runtimeLayout !== fork.runtimeLayout ||
    canonicalFork.repository?.root !==
      (isRecord(fork.repository) ? fork.repository.root : undefined) ||
    canonicalFork.repository?.linkedWorktree !==
      (isRecord(fork.repository) ? fork.repository.linkedWorktree : undefined)
  ) {
    throw new ForkUpdateError(
      "The fork identity changed after the plan was made; re-run plan.",
      EXIT.blocked
    );
  }
  const forkRoot = canonicalFork.path;
  const entryPaths = new Set<string>();
  const writtenEntryPaths = new Set<string>();
  for (const entry of value.entries) {
    if (
      !(
        isRecord(entry) &&
        hasExactKeys(
          entry,
          ["action", "forkDigest", "forkPath", "reason", "upstreamPath"],
          ["content", "contentBase64", "sidecarDigest"]
        ) &&
        PLAN_ACTIONS.includes(entry.action as PlanAction) &&
        safeForkPath(forkRoot, entry.forkPath)
      ) ||
      typeof entry.reason !== "string" ||
      !(
        entry.upstreamPath === null ||
        (typeof entry.upstreamPath === "string" &&
          safeForkPath(forkRoot, entry.upstreamPath))
      ) ||
      !(
        entry.forkDigest === null ||
        (typeof entry.forkDigest === "string" &&
          DIGEST_PATTERN.test(entry.forkDigest))
      ) ||
      !(entry.content === undefined || typeof entry.content === "string") ||
      !(
        entry.contentBase64 === undefined ||
        (typeof entry.contentBase64 === "string" &&
          isCanonicalBase64(entry.contentBase64) &&
          entry.content === undefined)
      ) ||
      !(
        entry.sidecarDigest === undefined ||
        entry.sidecarDigest === null ||
        (typeof entry.sidecarDigest === "string" &&
          DIGEST_PATTERN.test(entry.sidecarDigest))
      ) ||
      entryPaths.has(entry.forkPath)
    ) {
      throw new ForkUpdateError(
        "The plan carries an invalid file entry.",
        EXIT.usage
      );
    }
    entryPaths.add(entry.forkPath);
    if (
      WRITE_ACTIONS.has(entry.action as PlanAction) ||
      entry.action === "delete"
    ) {
      writtenEntryPaths.add(entry.forkPath);
    }
    if (
      (entry.action === "conflict") !==
      Object.hasOwn(entry, "sidecarDigest")
    ) {
      throw new ForkUpdateError(
        "Conflict entries must bind their sidecar state.",
        EXIT.usage
      );
    }
  }
  for (const rewrite of value.literalRewrites) {
    if (
      !(
        isRecord(rewrite) &&
        hasExactKeys(rewrite, ["forkDigest", "forkPath", "from", "to"])
      ) ||
      typeof rewrite.forkDigest !== "string" ||
      !DIGEST_PATTERN.test(rewrite.forkDigest) ||
      !safeForkPath(forkRoot, rewrite.forkPath) ||
      typeof rewrite.from !== "string" ||
      rewrite.from.length === 0 ||
      !ASCII_LITERAL_PATTERN.test(rewrite.from) ||
      typeof rewrite.to !== "string" ||
      !ASCII_LITERAL_PATTERN.test(rewrite.to) ||
      writtenEntryPaths.has(rewrite.forkPath)
    ) {
      throw new ForkUpdateError(
        "The plan carries an invalid literal rewrite.",
        EXIT.usage
      );
    }
  }
  if (
    !hasExactKeys(value.pinUpdate, ["from", "reason", "to"]) ||
    typeof value.pinUpdate.from !== "string" ||
    typeof value.pinUpdate.reason !== "string" ||
    !(value.pinUpdate.to === null || typeof value.pinUpdate.to === "string") ||
    !hasExactKeys(value.source, [
      "commit",
      "commitVerified",
      "guidanceVersion",
      "path",
      "version",
    ]) ||
    !(
      value.source.commit === null || typeof value.source.commit === "string"
    ) ||
    typeof value.source.commitVerified !== "boolean" ||
    !(
      value.source.guidanceVersion === null ||
      (typeof value.source.guidanceVersion === "number" &&
        Number.isInteger(value.source.guidanceVersion))
    ) ||
    typeof value.source.path !== "string" ||
    !(
      value.source.version === null || typeof value.source.version === "string"
    ) ||
    !hasExactKeys(summary, [...PLAN_ACTIONS]) ||
    !PLAN_ACTIONS.every(
      (action) =>
        typeof summary[action] === "number" &&
        Number.isInteger(summary[action]) &&
        Number(summary[action]) >= 0
    )
  ) {
    throw new ForkUpdateError("The plan metadata is invalid.", EXIT.usage);
  }
  return value as unknown as ForkPlan;
};

// Fail closed if any file the plan would write or delete changed after the
// plan was made; never overwrite work that arrived in between.
const assertSidecarUnchanged = (forkRoot: string, entry: PlanEntry): void => {
  const sidecarPath = entry.forkPath + MERGE_SIDECAR_SUFFIX;
  const sidecar = readBytes(join(forkRoot, sidecarPath));
  const sidecarDigest = sidecar === null ? null : bytesDigest(sidecar);
  if (sidecarDigest !== entry.sidecarDigest) {
    throw new ForkUpdateError(
      `${sidecarPath} changed after the plan was made; re-run plan.`,
      EXIT.blocked
    );
  }
};

const assertFileUnchanged = (forkRoot: string, entry: PlanEntry): void => {
  const current = readBytes(join(forkRoot, entry.forkPath));
  const digest = current === null ? null : bytesDigest(current);
  if (digest !== entry.forkDigest) {
    throw new ForkUpdateError(
      `${entry.forkPath} changed after the plan was made; re-run plan.`,
      EXIT.blocked
    );
  }
};

const assertForkUnchanged = (
  forkRoot: string,
  entries: PlanEntry[],
  rewrites: LiteralRewrite[]
): void => {
  for (const entry of entries) {
    if (!(WRITE_ACTIONS.has(entry.action) || entry.action === "delete")) {
      if (entry.action !== "conflict") {
        continue;
      }
      assertFileUnchanged(forkRoot, entry);
      assertSidecarUnchanged(forkRoot, entry);
      continue;
    }
    assertFileUnchanged(forkRoot, entry);
  }
  for (const rewrite of rewrites) {
    const current = readBytes(join(forkRoot, rewrite.forkPath));
    if (current === null || bytesDigest(current) !== rewrite.forkDigest) {
      throw new ForkUpdateError(
        `${rewrite.forkPath} changed after the plan was made; re-run plan.`,
        EXIT.blocked
      );
    }
  }
};

/** The exact bytes an entry writes, or undefined when it writes nothing. */
const entryBytes = (entry: PlanEntry): Buffer | undefined => {
  if (entry.contentBase64 !== undefined) {
    return Buffer.from(entry.contentBase64, "base64");
  }
  return entry.content === undefined
    ? undefined
    : Buffer.from(entry.content, "utf8");
};

const applyEntries = (
  forkRoot: string,
  entries: PlanEntry[]
): { deleted: string[]; written: string[] } => {
  const written: string[] = [];
  const deleted: string[] = [];
  for (const entry of entries) {
    const path = join(forkRoot, entry.forkPath);
    const bytes = entryBytes(entry);
    if (WRITE_ACTIONS.has(entry.action) && bytes !== undefined) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      written.push(entry.forkPath);
    } else if (entry.action === "delete") {
      unlinkSync(path);
      deleted.push(entry.forkPath);
    } else if (entry.action === "conflict" && bytes !== undefined) {
      writeFileSync(path + MERGE_SIDECAR_SUFFIX, bytes);
      written.push(entry.forkPath + MERGE_SIDECAR_SUFFIX);
    }
  }
  return { deleted, written };
};

// Group rewrites per file so each file is read and written once.
const applyLiteralRewrites = (
  forkRoot: string,
  rewrites: LiteralRewrite[],
  written: string[]
): number => {
  let count = 0;
  const byPath = new Map<string, LiteralRewrite[]>();
  for (const rewrite of rewrites) {
    byPath.set(rewrite.forkPath, [
      ...(byPath.get(rewrite.forkPath) ?? []),
      rewrite,
    ]);
  }
  for (const [forkPath, fileRewrites] of byPath) {
    const path = join(forkRoot, forkPath);
    let content = readBytes(path);
    if (content === null) {
      continue;
    }
    for (const rewrite of fileRewrites) {
      ({ content } = rewriteLiteral(
        forkPath,
        content,
        rewrite.from,
        rewrite.to
      ));
      count += 1;
    }
    writeFileSync(path, Buffer.from(content, "latin1"));
    if (!written.includes(forkPath)) {
      written.push(forkPath);
    }
  }
  return count;
};

export const applyForkPlan = (plan: ForkPlan): ApplyReceipt => {
  const validated = validateForkPlan(plan);
  const forkRoot = validated.fork.path;
  for (const entry of validated.entries) {
    assertNoSymlinkPath(forkRoot, entry.forkPath);
    if (entry.action === "conflict") {
      assertNoSymlinkPath(forkRoot, entry.forkPath + MERGE_SIDECAR_SUFFIX);
    }
  }
  for (const rewrite of validated.literalRewrites) {
    assertNoSymlinkPath(forkRoot, rewrite.forkPath);
  }
  assertForkUnchanged(forkRoot, validated.entries, validated.literalRewrites);
  const { deleted, written } = applyEntries(forkRoot, validated.entries);
  const literalRewrites = applyLiteralRewrites(
    forkRoot,
    validated.literalRewrites,
    written
  );
  return {
    conflicts: validated.entries
      .filter((entry) => entry.action === "conflict")
      .map((entry) => entry.forkPath),
    deleted,
    fork: forkRoot,
    literalRewrites,
    pin: { from: validated.pinUpdate.from, to: validated.pinUpdate.to },
    review: validated.entries
      .filter((entry) => entry.action === "review")
      .map((entry) => entry.forkPath),
    unrecordedOmissions: validated.entries
      .filter((entry) => entry.action === "unrecorded-omission")
      .map((entry) => entry.forkPath),
    written: written.sort(byText),
  };
};

// ---------------------------------------------------------------------- CLI

const HELP = `update-local-forks ${VERSION}

Usage:
  update-local-forks discover [--root DIR ...] [--json]
  update-local-forks plan --fork DIR [--source DIR] [--upstream DIR | --upstream-url URL]
    [--branch NAME] [--cache DIR] [--json]
  update-local-forks apply --plan FILE [--json]
  update-local-forks help

discover  Find forks (SKILL.md with a provenance pin) and installed sources
          under global skill roots, conventional project folders, and any
          --root, without writing.
plan      Classify every file of one fork against its pinned base and the
          installed source; print the plan. Save it with --json > plan.json.
apply     Write exactly what a saved plan says: updates, merges, additions,
          deletions, the provenance pin, and exact literal rewrites. A
          conflicting file is left untouched and its marked merge is written
          beside it as <file>.upstream-merge; review items are never written.
          Fails closed if the fork changed since the plan.

An upstream reference added or changed since the pin that the fork neither
carries nor lists under "## Intentional omissions" in its
references/fork-maintenance.md is an unrecorded omission: it holds the pin,
and plan and apply exit 3 until the fork carries or records it.

The source defaults to the first installed skill found by discover. The
upstream defaults to a bare cache under ~/.cache/simple-changes fetched from
${DEFAULT_UPSTREAM_URL}; pass --upstream for a source checkout.

Exit codes: 0 success, 2 usage, 3 blocked, 4 failure
`;

interface CliOptions {
  branch?: string;
  cache?: string;
  fork?: string;
  json: boolean;
  plan?: string;
  positional: string[];
  roots: string[];
  source?: string;
  upstream?: string;
  url?: string;
}

const parseOptions = (args: string[]): CliOptions => {
  const options: CliOptions = { json: false, positional: [], roots: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new ForkUpdateError(`${arg} requires a value`, EXIT.usage);
      }
      index += 1;
      return next;
    };
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--root":
        options.roots.push(resolve(value()));
        break;
      case "--fork":
        options.fork = value();
        break;
      case "--source":
        options.source = value();
        break;
      case "--upstream":
        options.upstream = value();
        break;
      case "--upstream-url":
        options.url = value();
        break;
      case "--branch":
        options.branch = value();
        break;
      case "--cache":
        options.cache = value();
        break;
      case "--plan":
        options.plan = value();
        break;
      default:
        if (arg.startsWith("--")) {
          throw new ForkUpdateError(`Unknown option ${arg}`, EXIT.usage);
        }
        options.positional.push(arg);
    }
  }
  return options;
};

const emit = (value: unknown, json: boolean, text: string): void => {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
};

const renderPlan = (plan: ForkPlan): string => {
  const lines = [
    `Fork ${plan.fork.name} at ${plan.fork.path}`,
    `  pinned ${plan.pinUpdate.from} -> ${plan.pinUpdate.to ?? `(pin unchanged: ${plan.pinUpdate.reason})`}`,
    `  source ${plan.source.version ?? "unknown"} (guidance ${plan.source.guidanceVersion ?? "unknown"}) at ${plan.source.path}`,
    `  ${plan.summary.update} update, ${plan.summary.merge} merge, ${plan.summary.add} add, ${plan.summary.delete} delete, ${plan.summary["keep-fork-delta"]} fork edits kept, ${plan.summary["keep-fork-only"]} fork-only files kept, ${plan.summary.skip} skipped as fork-owned history, ${plan.summary.omitted} omitted, ${plan.summary.conflict} conflict, ${plan.summary.review} to review, ${plan.summary["unrecorded-omission"]} unrecorded omissions, ${plan.literalRewrites.length} literal rewrites`,
  ];
  for (const entry of plan.entries) {
    if (
      [
        "update",
        "merge",
        "add",
        "delete",
        "skip",
        "conflict",
        "review",
        "unrecorded-omission",
      ].includes(entry.action)
    ) {
      lines.push(
        `  ${entry.action.padEnd(8)} ${entry.forkPath}: ${entry.reason}`
      );
    }
  }
  for (const rewrite of plan.literalRewrites) {
    lines.push(
      `  rewrite  ${rewrite.forkPath}: ${rewrite.from} -> ${rewrite.to}`
    );
  }
  return `${lines.join("\n")}\n`;
};

const forkLine = (fork: DiscoveredFork): string => {
  const note = fork.repository?.linkedWorktree
    ? "; linked worktree, update the primary checkout instead"
    : "";
  return `  ${fork.name} at ${fork.path} pinned ${fork.pin} (${fork.runtimeLayout}${note})`;
};

const runDiscover = (options: CliOptions): number => {
  const result = discover({ roots: options.roots });
  emit(
    result,
    options.json,
    [
      `Installed sources (${result.sources.length}):`,
      ...result.sources.map(
        (source) =>
          `  ${source.path} (${source.version ?? "unknown"}, guidance ${source.guidanceVersion ?? "unknown"})`
      ),
      `Forks (${result.forks.length}):`,
      ...result.forks.map(forkLine),
      "",
    ].join("\n")
  );
  return EXIT.success;
};

const runPlan = (options: CliOptions): number => {
  if (!options.fork) {
    throw new ForkUpdateError("plan requires --fork DIR", EXIT.usage);
  }
  const source =
    options.source ?? discover({ roots: options.roots }).sources[0]?.path;
  if (!source) {
    throw new ForkUpdateError(
      "No installed Simple Changes source was found; pass --source DIR.",
      EXIT.usage
    );
  }
  const plan = planForkUpdate({
    fork: options.fork,
    source,
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.upstream === undefined ? {} : { upstream: options.upstream }),
    ...(options.url === undefined ? {} : { url: options.url }),
  });
  emit(plan, options.json, renderPlan(plan));
  return plan.summary.conflict > 0 || plan.summary["unrecorded-omission"] > 0
    ? EXIT.blocked
    : EXIT.success;
};

const runApply = (options: CliOptions): number => {
  if (!options.plan) {
    throw new ForkUpdateError("apply requires --plan FILE", EXIT.usage);
  }
  const plan = validateForkPlan(JSON.parse(readFileSync(options.plan, "utf8")));
  const receipt = applyForkPlan(plan);
  emit(
    receipt,
    options.json,
    `Applied to ${receipt.fork}: wrote ${receipt.written.length} file(s), deleted ${receipt.deleted.length}, rewrote ${receipt.literalRewrites} literal(s), pin ${receipt.pin.from} -> ${receipt.pin.to ?? "unchanged"}; ${receipt.conflicts.length} conflict(s), ${receipt.review.length} review item(s), and ${receipt.unrecordedOmissions.length} unrecorded omission(s) left untouched.\n`
  );
  return receipt.conflicts.length > 0 || receipt.unrecordedOmissions.length > 0
    ? EXIT.blocked
    : EXIT.success;
};

const COMMANDS: Record<string, (options: CliOptions) => number> = {
  apply: runApply,
  discover: runDiscover,
  plan: runPlan,
};

const main = (args: string[]): number => {
  const [command, ...rest] = args;
  if (command === undefined || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(HELP);
    return EXIT.success;
  }
  if (command === "version" || command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.success;
  }
  const runner = COMMANDS[command];
  if (!runner) {
    throw new ForkUpdateError(
      `Unknown command ${command}. Run 'update-local-forks help'.`,
      EXIT.usage
    );
  }
  return runner(parseOptions(rest));
};

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    const failure =
      error instanceof ForkUpdateError
        ? error
        : new ForkUpdateError(
            error instanceof Error ? error.message : String(error)
          );
    process.stderr.write(`update-local-forks: ${failure.message}\n`);
    process.exitCode = failure.exitCode;
  }
}
