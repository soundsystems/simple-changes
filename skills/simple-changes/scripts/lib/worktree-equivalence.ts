import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "bun";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { captureInventory } from "./inventory.ts";
import { assertSafeRelativePath } from "./path-safety.ts";
import { runGit } from "./process.ts";
import { redactSecrets } from "./redact.ts";
import { validateSchema } from "./schema.ts";

const EQUIVALENCE_DISCLAIMER =
  "Patch and byte evidence only; semantic equivalence requires review.";
const RENAME_STATUSES = new Set(["R", "C"]);
const WHITESPACE_PATTERN = /\s+/u;
const TREE_ENTRY_PATTERN = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t/u;
const INDEX_ENTRY_PATTERN = /^(\d+)\s+([0-9a-f]+)\s+0\t/u;

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
  changeDigest: string;
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

export interface CommitEquivalenceOptions {
  maxCommits?: number;
  targetPatchIdCache?: Map<string, Map<string, string>> | undefined;
}

export interface CommitEquivalenceResult {
  commitCount: number;
  commits: WorktreeEquivalenceCommit[];
  exceededMaxCommits: boolean;
  fullyMatched: boolean;
  mergeBase: string | null;
}

export const commitEquivalenceAgainstTarget = (
  repositoryPath: string,
  headSha: string,
  targetRevision: string,
  options: CommitEquivalenceOptions = {}
): CommitEquivalenceResult => {
  const mergeBaseResult = runGit(
    repositoryPath,
    ["merge-base", headSha, targetRevision],
    true
  );
  if (mergeBaseResult.exitCode !== 0) {
    return {
      commitCount: 0,
      commits: [],
      exceededMaxCommits: false,
      fullyMatched: false,
      mergeBase: null,
    };
  }
  const mergeBase = mergeBaseResult.stdout.trim();
  const commitCount = Number.parseInt(
    runGit(repositoryPath, [
      "rev-list",
      "--count",
      `${mergeBase}..${headSha}`,
    ]).stdout.trim(),
    10
  );
  if (
    typeof options.maxCommits === "number" &&
    Number.isInteger(commitCount) &&
    commitCount > options.maxCommits
  ) {
    return {
      commitCount,
      commits: [],
      exceededMaxCommits: true,
      fullyMatched: false,
      mergeBase,
    };
  }
  const targetRange = `${mergeBase}..${targetRevision}`;
  const cachedTargetPatchIds = options.targetPatchIdCache?.get(targetRange);
  const targetPatchIds = cachedTargetPatchIds ?? new Map<string, string>();
  if (!cachedTargetPatchIds) {
    for (const sha of revisionList(repositoryPath, targetRange)) {
      const patchId = patchIdFor(repositoryPath, sha);
      if (patchId && !targetPatchIds.has(patchId)) {
        targetPatchIds.set(patchId, sha);
      }
    }
    options.targetPatchIdCache?.set(targetRange, targetPatchIds);
  }
  const commits: WorktreeEquivalenceCommit[] = revisionList(
    repositoryPath,
    `${mergeBase}..${headSha}`
  ).map((sha) => {
    const patchId = patchIdFor(repositoryPath, sha);
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
  return {
    commitCount,
    commits,
    exceededMaxCommits: false,
    fullyMatched: commits.every((commit) => commit.status === "matched"),
    mergeBase,
  };
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && Buffer.compare(left, right) === 0;

const statusEntries = (
  raw: string
): Array<{ path: string; status: string }> => {
  const tokens = raw.split("\0").filter(Boolean);
  const paths = new Map<string, string>();
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const status = token.slice(0, 2);
    paths.set(token.slice(3), status);
    index += 1;
    if (
      RENAME_STATUSES.has(status.slice(0, 1)) ||
      RENAME_STATUSES.has(status.slice(1, 2))
    ) {
      const original = tokens[index];
      if (original) {
        paths.set(original, status);
      }
      index += 1;
    }
  }
  return [...paths]
    .map(([path, status]) => ({ path, status }))
    .sort((left, right) => left.path.localeCompare(right.path));
};

const treeEntry = (
  worktreeRoot: string,
  revision: string,
  path: string
): { mode: string; objectId: string; type: string } | null => {
  const result = runGit(worktreeRoot, ["ls-tree", revision, "--", path], true);
  const line = result.stdout.trim();
  if (result.exitCode !== 0 || !line) {
    return null;
  }
  const match = TREE_ENTRY_PATTERN.exec(line);
  return match
    ? { mode: match[1] ?? "", objectId: match[3] ?? "", type: match[2] ?? "" }
    : null;
};

const indexEntry = (
  worktreeRoot: string,
  path: string
): { mode: string; objectId: string } | null => {
  const result = runGit(worktreeRoot, ["ls-files", "-s", "--", path], true);
  const line = result.stdout.trim();
  const match = INDEX_ENTRY_PATTERN.exec(line);
  return match ? { mode: match[1] ?? "", objectId: match[2] ?? "" } : null;
};

const stagedStateDiffers = (
  indexChanged: boolean,
  targetEntry: ReturnType<typeof treeEntry>,
  stagedEntry: ReturnType<typeof indexEntry>
): boolean =>
  indexChanged &&
  (!(targetEntry && stagedEntry) ||
    targetEntry.mode !== stagedEntry.mode ||
    targetEntry.objectId !== stagedEntry.objectId);

const fileModeIsExecutable = (mode: number): boolean => {
  const permissionMode = mode % 512;
  return (
    Math.floor(permissionMode / 64) % 2 === 1 ||
    Math.floor(permissionMode / 8) % 2 === 1 ||
    permissionMode % 2 === 1
  );
};

const classifyDirtyPath = (
  worktreeRoot: string,
  targetRevision: string,
  path: string,
  status: string
): WorktreeEquivalencePath | null => {
  const safe = assertSafeRelativePath(worktreeRoot, path);
  if (safe.symlink) {
    throw new SimpleChangesError(
      `Refusing equivalence evidence for symlinked path: ${JSON.stringify(path)}`,
      EXIT_CODES.unsafe
    );
  }
  const targetEntry = treeEntry(worktreeRoot, targetRevision, path);
  const stagedEntry = indexEntry(worktreeRoot, path);
  const indexChanged = status.slice(0, 1) !== " " && status.slice(0, 1) !== "?";
  if (stagedStateDiffers(indexChanged, targetEntry, stagedEntry)) {
    return { path, status: targetEntry ? "differs" : "absent-in-target" };
  }
  if (targetEntry && targetEntry.type !== "blob") {
    return { path, status: "differs" };
  }
  let localBytes: Uint8Array | null = null;
  if (existsSync(safe.absolutePath)) {
    if (!lstatSync(safe.absolutePath).isFile()) {
      return { path, status: "differs" };
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
    const executable = fileModeIsExecutable(lstatSync(safe.absolutePath).mode);
    const expectedExecutable = targetEntry?.mode === "100755";
    if (executable !== expectedExecutable) {
      return { path, status: "differs" };
    }
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

const worktreeEvidence = (
  worktreeRoot: string
): { changeDigest: string; headSha: string } => {
  const canonicalWorktree = realpathSync(worktreeRoot);
  const current = captureInventory(worktreeRoot).worktrees.find(
    (worktree) => worktree.path === canonicalWorktree
  );
  if (!current?.headSha) {
    throw new SimpleChangesError(
      "Equivalence evidence could not bind the current worktree inventory.",
      EXIT_CODES.inventory
    );
  }
  return { changeDigest: current.changeDigest, headSha: current.headSha };
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
  const openingEvidence = worktreeEvidence(worktreeRoot);
  const head = runGit(worktreeRoot, ["rev-parse", "HEAD"]).stdout.trim();
  if (head !== openingEvidence.headSha) {
    throw new SimpleChangesError(
      "The worktree changed while equivalence evidence was opening; retry the read-only audit.",
      EXIT_CODES.unsafe
    );
  }
  const targetRevision = runGit(worktreeRoot, [
    "rev-parse",
    "--verify",
    `${targetRef}^{commit}`,
  ]).stdout.trim();
  const equivalence = commitEquivalenceAgainstTarget(
    worktreeRoot,
    head,
    targetRevision
  );
  if (equivalence.mergeBase === null) {
    throw new SimpleChangesError(
      `No common history between HEAD and ${targetRef}; equivalence evidence needs a merge base.`,
      EXIT_CODES.unsafe
    );
  }
  const { mergeBase } = equivalence;
  const { commits } = equivalence;
  const statusOutput = textDecoder.decode(
    rawGit(worktreeRoot, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
    ]).stdout
  );
  const paths: WorktreeEquivalencePath[] = [];
  for (const { path, status } of statusEntries(statusOutput)) {
    const classified = classifyDirtyPath(
      worktreeRoot,
      targetRevision,
      path,
      status
    );
    if (classified) {
      paths.push(classified);
    }
  }
  if (
    process.env.NODE_ENV === "test" &&
    process.env.SIMPLE_CHANGES_TEST_EQUIVALENCE_MUTATE_PATH
  ) {
    const mutationPath = assertSafeRelativePath(
      worktreeRoot,
      process.env.SIMPLE_CHANGES_TEST_EQUIVALENCE_MUTATE_PATH
    );
    writeFileSync(mutationPath.absolutePath, "mutated during audit\n");
  }
  const finalEvidence = worktreeEvidence(worktreeRoot);
  if (
    finalEvidence.headSha !== openingEvidence.headSha ||
    finalEvidence.changeDigest !== openingEvidence.changeDigest
  ) {
    throw new SimpleChangesError(
      "The worktree changed while equivalence evidence was being computed; retry the read-only audit.",
      EXIT_CODES.unsafe
    );
  }
  return validateSchema<WorktreeEquivalenceReport>("worktree-equivalence", {
    changeDigest: finalEvidence.changeDigest,
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
