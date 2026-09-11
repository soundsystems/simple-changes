import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";

const SOURCE_LIMIT = 200;
const TARGET_LIMIT = 1000;
const CANDIDATE_LIMIT = 10;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;

interface CommitMetadata {
  originalCommits: string[];
  sha: string;
  subject: string;
}

export interface ReplacementCandidate {
  basis: "original-commit-trailer" | "subject-and-paths";
  rangeDiffArgs: string[];
  sharedPaths: string[];
  targetSha: string;
}

export interface BranchAuditReport {
  commits: Array<{
    candidates: ReplacementCandidate[];
    candidatesTruncated: boolean;
    sha: string;
  }>;
  disclaimer: string;
  head: string;
  headRef: string;
  mergeBase: string | null;
  schemaVersion: 1;
  sourceHistoryTruncated: boolean;
  status: "target-contained" | "review-required" | "unproven";
  targetHistoryTruncated: boolean;
  targetRef: string;
  targetRevision: string;
}

const resolveCommit = (root: string, ref: string): string => {
  if (!ref.trim() || ref.startsWith("-")) {
    throw new SimpleChangesError(
      "Expected a plain Git revision.",
      EXIT_CODES.usage
    );
  }
  return runGit(root, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]).stdout.trim();
};

const metadata = (
  root: string,
  range: string,
  limit: number
): CommitMetadata[] => {
  const fields = runGit(root, [
    "log",
    `--max-count=${limit + 1}`,
    "--format=%H%x00%s%x00%(trailers:key=Original-Commit,valueonly,separator=%x2C)%x00",
    range,
    "--",
  ]).stdout.split("\0");
  const commits: CommitMetadata[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index]?.trim() ?? "";
    if (!SHA_PATTERN.test(sha)) {
      throw new SimpleChangesError(
        "Invalid commit metadata from Git.",
        EXIT_CODES.inventory
      );
    }
    commits.push({
      originalCommits: (fields[index + 2] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => SHA_PATTERN.test(value)),
      sha,
      subject: fields[index + 1] ?? "",
    });
  }
  return commits;
};

const changedPaths = (root: string, sha: string): string[] =>
  runGit(root, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "-r",
    "-z",
    sha,
    "--",
  ])
    .stdout.split("\0")
    .filter(Boolean)
    .sort();

const candidatesFor = (
  root: string,
  source: CommitMetadata,
  targets: CommitMetadata[],
  pathCache: Map<string, string[]>
): { candidates: ReplacementCandidate[]; candidatesTruncated: boolean } => {
  const leads = targets.filter(
    (target) =>
      target.originalCommits.includes(source.sha) ||
      target.subject === source.subject
  );
  if (leads.length === 0) {
    return { candidates: [], candidatesTruncated: false };
  }
  const sourcePaths = new Set(changedPaths(root, source.sha));
  leads.sort(
    (a, b) =>
      Number(b.originalCommits.includes(source.sha)) -
      Number(a.originalCommits.includes(source.sha))
  );
  const candidates: ReplacementCandidate[] = [];
  for (const target of leads) {
    let paths = pathCache.get(target.sha);
    if (!paths) {
      paths = changedPaths(root, target.sha);
      pathCache.set(target.sha, paths);
    }
    const sharedPaths = paths.filter((path) => sourcePaths.has(path));
    const recorded = target.originalCommits.includes(source.sha);
    if (!(recorded || sharedPaths.length > 0)) {
      continue;
    }
    if (candidates.length === CANDIDATE_LIMIT) {
      return { candidates, candidatesTruncated: true };
    }
    candidates.push({
      basis: recorded ? "original-commit-trailer" : "subject-and-paths",
      rangeDiffArgs: [
        "range-diff",
        "--no-color",
        `${source.sha}^!`,
        `${target.sha}^!`,
      ],
      sharedPaths,
      targetSha: target.sha,
    });
  }
  return { candidates, candidatesTruncated: false };
};

/** Read-only discovery. A trailer is provenance supplied by an author, never cleanup authority. */
export const auditBranchReplacements = (options: {
  headRef: string;
  repositoryRoot: string;
  targetRef: string;
}): BranchAuditReport => {
  const { headRef, repositoryRoot: root, targetRef } = options;
  const head = resolveCommit(root, headRef);
  const targetRevision = resolveCommit(root, targetRef);
  const base = runGit(root, ["merge-base", head, targetRevision], true);
  const mergeBase = base.exitCode === 0 ? base.stdout.trim() : null;
  const contained =
    runGit(root, ["merge-base", "--is-ancestor", head, targetRevision], true)
      .exitCode === 0;
  const sources = contained
    ? []
    : metadata(root, `${targetRevision}..${head}`, SOURCE_LIMIT);
  const targets =
    contained || !mergeBase
      ? []
      : metadata(root, `${mergeBase}..${targetRevision}`, TARGET_LIMIT);
  const pathCache = new Map<string, string[]>();
  const commits = sources.slice(0, SOURCE_LIMIT).map((source) => ({
    ...candidatesFor(root, source, targets.slice(0, TARGET_LIMIT), pathCache),
    sha: source.sha,
  }));
  if (
    resolveCommit(root, headRef) !== head ||
    resolveCommit(root, targetRef) !== targetRevision
  ) {
    throw new SimpleChangesError(
      "A branch moved during the replacement audit; retry.",
      EXIT_CODES.unsafe
    );
  }
  let status: BranchAuditReport["status"] = "unproven";
  if (contained) {
    status = "target-contained";
  } else if (commits.some((commit) => commit.candidates.length > 0)) {
    status = "review-required";
  }
  return validateSchema<BranchAuditReport>("branch-audit", {
    commits,
    disclaimer:
      "Replacement candidates are advisory. Verify the merged proposal and independently review every source commit before deciding what remains to ship. This report never authorizes cleanup.",
    head,
    headRef,
    mergeBase,
    schemaVersion: 1,
    sourceHistoryTruncated: sources.length > SOURCE_LIMIT,
    status,
    targetHistoryTruncated: targets.length > TARGET_LIMIT,
    targetRef,
    targetRevision,
  });
};
