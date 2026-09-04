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
  cwd?: string
): { exitCode: number; stdout: string; stderr: string } => {
  const result = spawnSync(command, {
    ...(cwd === undefined ? {} : { cwd }),
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

const sourceDigest = (sourcePath: string): string =>
  sha256(
    walkFiles(sourcePath)
      .sort(byText)
      .map((path) => `${path}\0${sha256(readFileSync(join(sourcePath, path)))}`)
      .join("\n")
  );

const treeDigest = (upstream: UpstreamHandle, sha: string): string =>
  sha256(
    treeFiles(upstream, sha)
      .sort(byText)
      .map((path) => `${path}\0${sha256(treeFile(upstream, sha, path) ?? "")}`)
      .join("\n")
  );

/**
 * Find the upstream commit whose packaged skill is byte-identical to the
 * installed source. Search the fetched default branch for the release entry,
 * then prove tree equality; a provenance pin is never bumped to a guess.
 */
const locateSourceCommit = (
  upstream: UpstreamHandle,
  source: DiscoveredSource,
  url: string,
  branch: string
): { commit: string | null; verified: boolean; reason: string } => {
  if (!source.version) {
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
      "400",
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
  const candidates = git(
    upstream.gitDirectory,
    [
      "log",
      "--format=%H",
      `-S## ${source.version} `,
      ref,
      "--",
      `${UPSTREAM_SKILL_PATH}/CHANGELOG.md`,
    ],
    true
  )
    .split("\n")
    .filter(Boolean);
  const installed = sourceDigest(source.path);
  for (const candidate of candidates) {
    if (treeDigest(upstream, candidate) === installed) {
      return {
        commit: candidate,
        reason: "byte-identical tree",
        verified: true,
      };
    }
  }
  return {
    commit: candidates[0] ?? null,
    reason:
      candidates.length === 0
        ? `No commit on ${branch} introduces release ${source.version}.`
        : "The installed source is not byte-identical to any release commit; the pin will not be bumped.",
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
  | "review";

export interface PlanEntry {
  action: PlanAction;
  content?: string;
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
    writeFileSync(paths.ours, ours);
    writeFileSync(paths.base, base);
    writeFileSync(paths.theirs, theirs);
    const result = run([
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
    ]);
    return { conflict: result.exitCode !== 0, merged: result.stdout };
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

const classify = (
  upstreamPath: string,
  forkPath: string,
  versions: Versions
): PlanEntry => {
  const { base, current, target } = versions;
  let result: Outcome;
  if (base === null && target !== null) {
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
    forkDigest: current === null ? null : sha256(current),
    forkPath,
    upstreamPath,
  };
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
  for (const forkPath of walkFiles(fork.path)) {
    if (
      forkPath.startsWith("runtime/") ||
      forkPath.endsWith(MERGE_SIDECAR_SUFFIX) ||
      plannedContent.has(forkPath)
    ) {
      continue;
    }
    const content = readText(join(fork.path, forkPath));
    if (content === null) {
      continue;
    }
    for (const [from, to] of substitutions) {
      if (from !== to && content.includes(from)) {
        rewrites.push({ forkDigest: sha256(content), forkPath, from, to });
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
    skillEntry.content ?? readText(join(fork.path, "SKILL.md")) ?? "";
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
  for (const upstreamPath of [...upstreamPaths].sort(byText)) {
    const forkPath = mapUpstreamPath(fork, upstreamPath);
    if (forkPath === null) {
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
    const entry = classify(upstreamPath, forkPath, {
      base: treeFile(upstream, fork.pin, upstreamPath),
      current: readText(join(fork.path, forkPath)),
      target: readText(join(source.path, upstreamPath)),
    });
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
  const pinCandidate = source.commitVerified ? source.commit : null;
  const pinReady = advanceProvenance(
    fork,
    entries,
    plannedContent,
    pinCandidate
  );
  const pinUpdate: ForkPlan["pinUpdate"] = {
    from: fork.pin,
    reason:
      pinCandidate && !pinReady
        ? "The provenance file conflicts; resolve it before advancing the pin."
        : located.reason,
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
  );
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
  written: string[];
}

const WRITE_ACTIONS = new Set<PlanAction>(["update", "merge", "add"]);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

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
          ["content", "sidecarDigest"]
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
      typeof rewrite.to !== "string" ||
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
  const sidecar = readText(join(forkRoot, sidecarPath));
  const sidecarDigest = sidecar === null ? null : sha256(sidecar);
  if (sidecarDigest !== entry.sidecarDigest) {
    throw new ForkUpdateError(
      `${sidecarPath} changed after the plan was made; re-run plan.`,
      EXIT.blocked
    );
  }
};

const assertFileUnchanged = (forkRoot: string, entry: PlanEntry): void => {
  const current = readText(join(forkRoot, entry.forkPath));
  const digest = current === null ? null : sha256(current);
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
    const current = readText(join(forkRoot, rewrite.forkPath));
    if (current === null || sha256(current) !== rewrite.forkDigest) {
      throw new ForkUpdateError(
        `${rewrite.forkPath} changed after the plan was made; re-run plan.`,
        EXIT.blocked
      );
    }
  }
};

const applyEntries = (
  forkRoot: string,
  entries: PlanEntry[]
): { deleted: string[]; written: string[] } => {
  const written: string[] = [];
  const deleted: string[] = [];
  for (const entry of entries) {
    const path = join(forkRoot, entry.forkPath);
    if (WRITE_ACTIONS.has(entry.action) && entry.content !== undefined) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.content);
      written.push(entry.forkPath);
    } else if (entry.action === "delete") {
      unlinkSync(path);
      deleted.push(entry.forkPath);
    } else if (entry.action === "conflict" && entry.content !== undefined) {
      writeFileSync(path + MERGE_SIDECAR_SUFFIX, entry.content);
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
    let content = readText(path);
    if (content === null) {
      continue;
    }
    for (const rewrite of fileRewrites) {
      content = content.split(rewrite.from).join(rewrite.to);
      count += 1;
    }
    writeFileSync(path, content);
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
    `  ${plan.summary.update} update, ${plan.summary.merge} merge, ${plan.summary.add} add, ${plan.summary.delete} delete, ${plan.summary["keep-fork-delta"]} fork edits kept, ${plan.summary["keep-fork-only"]} fork-only files kept, ${plan.summary.omitted} omitted, ${plan.summary.conflict} conflict, ${plan.summary.review} to review, ${plan.literalRewrites.length} literal rewrites`,
  ];
  for (const entry of plan.entries) {
    if (
      ["update", "merge", "add", "delete", "conflict", "review"].includes(
        entry.action
      )
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
  return plan.summary.conflict > 0 ? EXIT.blocked : EXIT.success;
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
    `Applied to ${receipt.fork}: wrote ${receipt.written.length} file(s), deleted ${receipt.deleted.length}, rewrote ${receipt.literalRewrites} literal(s), pin ${receipt.pin.from} -> ${receipt.pin.to ?? "unchanged"}; ${receipt.conflicts.length} conflict(s) and ${receipt.review.length} review item(s) left untouched.\n`
  );
  return receipt.conflicts.length > 0 ? EXIT.blocked : EXIT.success;
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
