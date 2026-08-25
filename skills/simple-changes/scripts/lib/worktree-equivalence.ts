import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "bun";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { assertSafeRelativePath } from "./path-safety.ts";
import { runGit } from "./process.ts";
import { redactSecrets } from "./redact.ts";
import { validateSchema } from "./schema.ts";

const EQUIVALENCE_DISCLAIMER =
  "Patch and byte evidence only; semantic equivalence requires review.";
const RENAME_STATUSES = new Set(["R", "C"]);
const WHITESPACE_PATTERN = /\s+/u;

export interface WorktreeEquivalenceOptions {
  repositoryRoot?: string;
  targetRef: string;
  worktreePath?: string;
}

export interface WorktreeEquivalenceCommit {
  matchedTargetSha: string | null;
  patchId: string | null;
  sha: string;
  status: "matched" | "unmatched";
}

export interface WorktreeEquivalencePath {
  path: string;
  status: "identical" | "differs" | "absent-in-target";
}

export interface WorktreeEquivalenceReport {
  commits: WorktreeEquivalenceCommit[];
  disclaimer: string;
  equivalence: "contained" | "partial" | "divergent";
  head: string;
  mergeBase: string;
  paths: WorktreeEquivalencePath[];
  schemaVersion: 1;
  targetRef: string;
  targetRevision: string;
}

const textDecoder = new TextDecoder();

const rawGit = (
  cwd: string,
  args: readonly string[],
  stdin?: Uint8Array,
  allowFailure = false
): { exitCode: number; stdout: Uint8Array } => {
  const result = spawnSync(["git", "-C", cwd, ...args], {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
    stderr: "pipe",
    stdin,
    stdout: "pipe",
  });
  if (result.exitCode !== 0 && !allowFailure) {
    const detail = redactSecrets(
      textDecoder.decode(result.stderr).trim() ||
        textDecoder.decode(result.stdout).trim()
    );
    throw new SimpleChangesError(
      `git ${args[0] ?? ""} failed${detail ? `: ${detail}` : ""}`,
      EXIT_CODES.inventory
    );
  }
  return { exitCode: result.exitCode, stdout: new Uint8Array(result.stdout) };
};

const revisionList = (cwd: string, range: string): string[] =>
  runGit(cwd, ["rev-list", "--reverse", range])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const patchIdFor = (cwd: string, sha: string): string | null => {
  const diff = rawGit(cwd, [
    "diff-tree",
    "--patch",
    "--no-commit-id",
    "--full-index",
    sha,
  ]).stdout;
  if (diff.length === 0) {
    return null;
  }
  const output = textDecoder
    .decode(rawGit(cwd, ["patch-id", "--stable"], diff).stdout)
    .trim();
  const [patchId] = output.split(WHITESPACE_PATTERN);
  return patchId || null;
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && Buffer.compare(left, right) === 0;

const statusEntryPaths = (raw: string): string[] => {
  const tokens = raw.split("\0").filter(Boolean);
  const paths = new Set<string>();
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const status = token.slice(0, 2);
    paths.add(token.slice(3));
    index += 1;
    if (
      RENAME_STATUSES.has(status.slice(0, 1)) ||
      RENAME_STATUSES.has(status.slice(1, 2))
    ) {
      const original = tokens[index];
      if (original) {
        paths.add(original);
      }
      index += 1;
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
};

const classifyDirtyPath = (
  worktreeRoot: string,
  targetRevision: string,
  path: string
): WorktreeEquivalencePath | null => {
  const safe = assertSafeRelativePath(worktreeRoot, path);
  if (safe.symlink) {
    throw new SimpleChangesError(
      `Refusing equivalence evidence for symlinked path: ${JSON.stringify(path)}`,
      EXIT_CODES.unsafe
    );
  }
  let localBytes: Uint8Array | null = null;
  if (existsSync(safe.absolutePath)) {
    if (!lstatSync(safe.absolutePath).isFile()) {
      return null;
    }
    localBytes = new Uint8Array(readFileSync(safe.absolutePath));
  }
  const target = rawGit(
    worktreeRoot,
    ["cat-file", "blob", `${targetRevision}:${path}`],
    undefined,
    true
  );
  const targetBytes = target.exitCode === 0 ? target.stdout : null;
  if (targetBytes === null) {
    return {
      path,
      status: localBytes === null ? "identical" : "absent-in-target",
    };
  }
  if (localBytes !== null && bytesEqual(localBytes, targetBytes)) {
    return { path, status: "identical" };
  }
  return { path, status: "differs" };
};

const classifyEquivalence = (
  commits: WorktreeEquivalenceCommit[],
  paths: WorktreeEquivalencePath[]
): WorktreeEquivalenceReport["equivalence"] => {
  const unmatched = commits.filter((commit) => commit.status === "unmatched");
  const matched = commits.length - unmatched.length;
  const identical = paths.filter((item) => item.status === "identical").length;
  const differing = paths.length - identical;
  if (unmatched.length === 0 && differing === 0) {
    return "contained";
  }
  if (matched === 0 && identical === 0) {
    return "divergent";
  }
  return "partial";
};

export const auditWorktreeEquivalence = (
  options: WorktreeEquivalenceOptions
): WorktreeEquivalenceReport => {
  const worktreeRoot = options.worktreePath ?? options.repositoryRoot;
  if (!worktreeRoot) {
    throw new SimpleChangesError(
      "Equivalence evidence requires a worktreePath or repositoryRoot.",
      EXIT_CODES.usage
    );
  }
  const targetRef = options.targetRef.trim();
  if (!targetRef || targetRef.startsWith("-")) {
    throw new SimpleChangesError(
      "Equivalence evidence requires a plain target reference.",
      EXIT_CODES.usage
    );
  }
  const head = runGit(worktreeRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const targetRevision = runGit(worktreeRoot, [
    "rev-parse",
    "--verify",
    `${targetRef}^{commit}`,
  ]).stdout.trim();
  const mergeBaseResult = runGit(
    worktreeRoot,
    ["merge-base", head, targetRevision],
    true
  );
  if (mergeBaseResult.exitCode !== 0) {
    throw new SimpleChangesError(
      `No common history between HEAD and ${targetRef}; equivalence evidence needs a merge base.`,
      EXIT_CODES.unsafe
    );
  }
  const mergeBase = mergeBaseResult.stdout.trim();
  const targetPatchIds = new Map<string, string>();
  for (const sha of revisionList(
    worktreeRoot,
    `${mergeBase}..${targetRevision}`
  )) {
    const patchId = patchIdFor(worktreeRoot, sha);
    if (patchId && !targetPatchIds.has(patchId)) {
      targetPatchIds.set(patchId, sha);
    }
  }
  const commits: WorktreeEquivalenceCommit[] = revisionList(
    worktreeRoot,
    `${mergeBase}..${head}`
  ).map((sha) => {
    const patchId = patchIdFor(worktreeRoot, sha);
    const matchedTargetSha = patchId
      ? (targetPatchIds.get(patchId) ?? null)
      : null;
    return {
      matchedTargetSha,
      patchId,
      sha,
      status: matchedTargetSha ? "matched" : "unmatched",
    };
  });
  const statusOutput = textDecoder.decode(
    rawGit(worktreeRoot, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
    ]).stdout
  );
  const paths: WorktreeEquivalencePath[] = [];
  for (const path of statusEntryPaths(statusOutput)) {
    const classified = classifyDirtyPath(worktreeRoot, targetRevision, path);
    if (classified) {
      paths.push(classified);
    }
  }
  return validateSchema<WorktreeEquivalenceReport>("worktree-equivalence", {
    commits,
    disclaimer: EQUIVALENCE_DISCLAIMER,
    equivalence: classifyEquivalence(commits, paths),
    head,
    mergeBase,
    paths,
    schemaVersion: 1,
    targetRef,
    targetRevision,
  } satisfies WorktreeEquivalenceReport);
};
