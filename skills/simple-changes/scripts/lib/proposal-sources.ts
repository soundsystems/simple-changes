import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { completeLine, completeObjectId } from "./git-complete.ts";
import { ensureStateDirectory } from "./git-location.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";

/**
 * Which branch a proposal was opened from, as `proposal record-authors`
 * saw it at one exact head. The review ledger binds a proposal to commits
 * only, and older runtimes read its closed shape strictly, so the source
 * branch lives in this file of its own, which they never open.
 */
export interface ProposalSource {
  headSha: string;
  proposalId: string;
  recordedAt: string;
  /** The remote the branch tracks, when it had an upstream; else null. */
  remote: string | null;
  /** The branch's name on that remote; null without an upstream. */
  remoteBranch: string | null;
  /** The local branch whose tip was exactly `headSha`. */
  sourceBranch: string;
}

interface ProposalSourcesDocument {
  schemaVersion: 1;
  sources: ProposalSource[];
}

const proposalSourcesPath = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, "simple-changes", "proposal-sources.json");

// A file that is missing, unreadable, or not this shape holds no binding:
// a binding only ever lets a proposal be accepted, so none is the safe read.
export const readProposalSources = (
  commonGitDirectory: string
): ProposalSource[] => {
  try {
    return validateSchema<ProposalSourcesDocument>(
      "proposal-sources",
      JSON.parse(
        readFileSync(proposalSourcesPath(commonGitDirectory), "utf8")
      ) as unknown
    ).sources;
  } catch {
    return [];
  }
};

/** Records a proposal's one current source, replacing its earlier one. */
export const recordProposalSource = (
  commonGitDirectory: string,
  source: ProposalSource
): void => {
  const document = validateSchema<ProposalSourcesDocument>("proposal-sources", {
    schemaVersion: 1,
    sources: [
      ...readProposalSources(commonGitDirectory).filter(
        (item) => item.proposalId !== source.proposalId
      ),
      source,
    ],
  });
  const path = proposalSourcesPath(commonGitDirectory);
  ensureStateDirectory(commonGitDirectory, resolve(path, ".."));
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
};

const HEAD_REF_PREFIX = "refs/heads/";

/** Local branches whose tip is exactly this commit. */
const branchesAt = (cwd: string, headSha: string): string[] => {
  const listed = runGit(
    cwd,
    [
      "for-each-ref",
      "--format=%(refname)",
      "--points-at",
      headSha,
      HEAD_REF_PREFIX,
    ],
    true
  );
  return listed.exitCode === 0
    ? listed.stdout
        .split("\n")
        .filter((ref) => ref.startsWith(HEAD_REF_PREFIX))
        .map((ref) => ref.slice(HEAD_REF_PREFIX.length))
    : [];
};

const configValue = (cwd: string, key: string): string | null => {
  try {
    return completeLine(cwd, ["config", "--get", key]).line;
  } catch {
    return null;
  }
};

/**
 * The branch a proposal at `headSha` was opened from. A named branch must
 * point at exactly that commit, or the command is refused. Without a name,
 * the branch is taken from the commit only when exactly one local branch
 * points at it; none or several leave the source unrecorded, never guessed.
 */
export const proposalSourceAt = (
  cwd: string,
  headSha: string,
  requested: string | undefined
): Pick<ProposalSource, "remote" | "remoteBranch" | "sourceBranch"> | null => {
  const named = requested?.trim();
  if (
    named &&
    completeObjectId(cwd, `${HEAD_REF_PREFIX}${named}^{commit}`) !== headSha
  ) {
    throw new SimpleChangesError(
      `--source-branch ${named} does not point at --head ${headSha}; a proposal's source branch is recorded only at its exact head.`,
      EXIT_CODES.validation
    );
  }
  const candidates = named ? [named] : branchesAt(cwd, headSha);
  const [sourceBranch] = candidates;
  if (candidates.length !== 1 || !sourceBranch) {
    return null;
  }
  const remote = configValue(cwd, `branch.${sourceBranch}.remote`);
  const merge = configValue(cwd, `branch.${sourceBranch}.merge`);
  const tracked = Boolean(remote && merge?.startsWith(HEAD_REF_PREFIX));
  return {
    remote: tracked ? remote : null,
    remoteBranch: tracked && merge ? merge.slice(HEAD_REF_PREFIX.length) : null,
    sourceBranch,
  };
};
