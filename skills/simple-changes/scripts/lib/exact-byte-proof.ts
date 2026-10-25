import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  completeChangedPaths,
  completeMergeBase,
  completeObjectId,
  completeRevisionList,
} from "./git-complete.ts";
import { runGit } from "./process.ts";

/** The most source commits one proof reads; a longer range is refused. */
export const EXACT_BYTE_PROOF_MAX_COMMITS = 200;

export interface ExactByteTargetProofInput {
  /** Commits that bound the range at most; defaults to the module limit. */
  maxCommits?: number;
  /**
   * The exclusive start of the source range. It must be an ancestor of both
   * `sourceHead` and `targetRevision`, so every commit outside the range is
   * already in the target. Defaults to their merge base.
   */
  sourceBase?: string;
  /** The source tip, such as a branch head. */
  sourceHead: string;
  targetRevision: string;
}

export interface ExactByteTargetProof {
  baseRevision: string;
  /** Every commit in `baseRevision..headRevision`, oldest first. */
  commits: string[];
  headRevision: string;
  status: "proven";
  targetRevision: string;
  /** Every path any of `commits` added, changed, or removed, sorted. */
  touchedPaths: string[];
}

export interface ExactByteTargetRefusal {
  /** Touched paths whose entry at the source tip differs from the target. */
  differingPaths: string[];
  reason: string;
  status: "refused";
}

export type ExactByteTargetResult =
  | ExactByteTargetProof
  | ExactByteTargetRefusal;

const refused = (
  reason: string,
  differingPaths: string[] = []
): ExactByteTargetRefusal => ({ differingPaths, reason, status: "refused" });

// The full commit ID, read whole, so a proof never binds an ID cut short.
const resolveCommit = (
  repositoryPath: string,
  revision: string
): string | null =>
  !revision || revision.startsWith("-")
    ? null
    : completeObjectId(repositoryPath, `${revision}^{commit}`);

const isAncestor = (
  repositoryPath: string,
  ancestor: string,
  descendant: string
): boolean =>
  runGit(
    repositoryPath,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    true
  ).exitCode === 0;

const DIFF_OPTIONS = [
  "--no-renames",
  "--no-ext-diff",
  "--ignore-submodules=none",
] as const;

// The range's exclusive start: the given base or the merge base, which must
// be an ancestor of both the tip and the target.
const sourceBaseFor = (
  repositoryPath: string,
  sourceBase: string | undefined,
  headRevision: string,
  targetRevision: string
): string | ExactByteTargetRefusal => {
  let baseRevision: string | null;
  if (sourceBase === undefined) {
    const answer = completeMergeBase(
      repositoryPath,
      headRevision,
      targetRevision
    );
    baseRevision = "mergeBase" in answer ? answer.mergeBase : null;
    if (!baseRevision) {
      return refused(
        `Source tip ${headRevision} shares no history with target ${targetRevision}.`
      );
    }
  } else {
    baseRevision = resolveCommit(repositoryPath, sourceBase);
    if (!baseRevision) {
      return refused(`Source base ${sourceBase} does not name a commit.`);
    }
  }
  if (!isAncestor(repositoryPath, baseRevision, headRevision)) {
    return refused(
      `Source base ${baseRevision} is not an ancestor of source tip ${headRevision}.`
    );
  }
  if (!isAncestor(repositoryPath, baseRevision, targetRevision)) {
    return refused(
      `Source base ${baseRevision} is not contained in target ${targetRevision}, so commits before it would go unproven.`
    );
  }
  return baseRevision;
};

// Every commit in base..head, oldest first, refusing a merge or a range
// longer than the limit.
const singleParentCommits = (
  repositoryPath: string,
  baseRevision: string,
  headRevision: string,
  maxCommits: number
): string[] | ExactByteTargetRefusal => {
  const parentLines = completeRevisionList(repositoryPath, [
    "--reverse",
    "--parents",
    `${baseRevision}..${headRevision}`,
  ]);
  if (parentLines.length > maxCommits) {
    return refused(
      `Source range ${baseRevision}..${headRevision} has ${parentLines.length} commits, more than the ${maxCommits} one proof reads.`
    );
  }
  const commits: string[] = [];
  for (const line of parentLines) {
    const [sha, ...parents] = line.split(" ");
    if (!sha) {
      continue;
    }
    if (parents.length > 1) {
      return refused(
        `Source range ${baseRevision}..${headRevision} contains merge commit ${sha}; exact-byte proof reads only single-parent commits.`
      );
    }
    commits.push(sha);
  }
  return commits;
};

// The proof itself; the exported wrapper turns a lost Git answer into a
// refusal.
const exactByteProof = (
  repositoryPath: string,
  input: ExactByteTargetProofInput
): ExactByteTargetResult => {
  const headRevision = resolveCommit(repositoryPath, input.sourceHead);
  if (!headRevision) {
    return refused(`Source tip ${input.sourceHead} does not name a commit.`);
  }
  const targetRevision = resolveCommit(repositoryPath, input.targetRevision);
  if (!targetRevision) {
    return refused(
      `Target revision ${input.targetRevision} does not name a commit.`
    );
  }
  const baseRevision = sourceBaseFor(
    repositoryPath,
    input.sourceBase,
    headRevision,
    targetRevision
  );
  if (typeof baseRevision !== "string") {
    return baseRevision;
  }
  const commits = singleParentCommits(
    repositoryPath,
    baseRevision,
    headRevision,
    input.maxCommits ?? EXACT_BYTE_PROOF_MAX_COMMITS
  );
  if (!Array.isArray(commits)) {
    return commits;
  }
  const touched = new Set<string>();
  for (const sha of commits) {
    for (const path of completeChangedPaths(
      repositoryPath,
      "diff-tree",
      ["-r", "--no-commit-id", ...DIFF_OPTIONS],
      [sha]
    )) {
      touched.add(path);
    }
  }
  const different = new Set(
    completeChangedPaths(repositoryPath, "diff", DIFF_OPTIONS, [
      headRevision,
      targetRevision,
    ])
  );
  const touchedPaths = [...touched].sort();
  const differingPaths = touchedPaths.filter((path) => different.has(path));
  if (differingPaths.length > 0) {
    return refused(
      `Source tip ${headRevision} differs from target ${targetRevision} at ${differingPaths.length} path(s) its commits touched: ${differingPaths.join(", ")}.`,
      differingPaths
    );
  }
  return {
    baseRevision,
    commits,
    headRevision,
    status: "proven",
    targetRevision,
    touchedPaths,
  };
};

/**
 * Proves that a source range left nothing outside the target: every path
 * that any commit in `base..head` touched has exactly the same tree entry
 * (bytes and mode, or absence) at the source tip as at the target revision.
 * It reads history only and changes nothing.
 *
 * This is byte evidence, not ancestry: it holds when reviewed work reached
 * the target inside a different or broader commit, which patch-ID matching
 * cannot see. Because the base is an ancestor of the target and every path
 * the range changed already equals the target, deleting the source branch
 * would lose no content. It never says the target came from the source.
 *
 * It refuses, with a reason, when a revision does not resolve, the base is
 * not an ancestor of both the tip and the target, the range holds a merge
 * commit (whose changes depend on which parent is read) or more than
 * `maxCommits` commits, any touched path differs from the target, or a
 * listing it reads was twice lost or cut short.
 */
export const proveExactByteTargetContainment = (
  repositoryPath: string,
  input: ExactByteTargetProofInput
): ExactByteTargetResult => {
  // Every listing is read whole through git-complete.ts, which refuses an
  // answer lost or cut short; that refusal is a refusal of the proof too.
  try {
    return exactByteProof(repositoryPath, input);
  } catch (error) {
    if (
      error instanceof SimpleChangesError &&
      error.exitCode === EXIT_CODES.inventory
    ) {
      return refused(error.message);
    }
    throw error;
  }
};
