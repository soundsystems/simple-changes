import { canonicalModelId } from "./authoring.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { locateRepository } from "./inventory.ts";
import { runGit } from "./process.ts";
import {
  type CommitGaps,
  type HeadCoverage,
  headCoverage,
  isCommitSha,
  type ReviewLedger,
  type ReviewLedgerState,
  readReviewLedger,
} from "./review-ledger.ts";

// Author coverage of a commit range, read before work is handed off as ready
// or a proposal is presented for review: the commits with no attested author,
// the replay sources with none, and the inconclusive replays nobody attested
// an edit on. It reads Git and the review ledger and writes nothing. It never
// says who made a commit: nothing here can tell, so a missing attestation is
// only ever fixed by the agent that made the commit, from its own session, or
// waived by the owner on the proposal.

const MAX_COVERAGE_COMMITS = 1000;
const LINE_SEPARATOR = /\r?\n/u;
const PLAIN_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/u;

export type CoverageItemKind =
  | "unattributed"
  | "unresolved-source"
  | "uncovered-edit";

/** One commit that needs an attested author before the range is covered. */
export interface CoverageItem {
  /** The range commits whose coverage this item holds open, in range order. */
  carriedBy: string[];
  kind: CoverageItemKind;
  /** The sources the ledger records for `sha` when it is a replay. */
  replaySources: string[];
  /** The commit that needs an attested author or an attested edit. */
  sha: string;
}

/** An effective attestation that names no model ID. */
export interface IncompleteAttestation {
  commit: string;
  /** Whether its session, harness and agent id are known, so `--complete-identity` can apply. */
  completable: boolean;
  logicalId: string | null;
}

export interface AuthorCoverage {
  /** The digest `proposal record-authors` computes for the same range. */
  authorsDigest: string | null;
  base: string;
  commits: string[];
  gaps: Record<string, CommitGaps>;
  head: string;
  incompleteIdentities: IncompleteAttestation[];
  ledger: {
    errors: string[];
    path: string;
    state: ReviewLedgerState["state"];
  };
  outstanding: CoverageItem[];
  status: "covered" | "incomplete" | "ledger-unreadable";
  unattributed: string[];
}

const resolveRevision = (
  cwd: string,
  value: string,
  option: string
): string => {
  const revision = value.trim();
  if (!revision || revision.startsWith("-")) {
    throw new SimpleChangesError(
      `${option} must name a commit.`,
      EXIT_CODES.usage
    );
  }
  const result = runGit(
    cwd,
    ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
    true
  );
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !isCommitSha(sha)) {
    throw new SimpleChangesError(
      `${option} ${revision} is not a commit in this repository.`,
      EXIT_CODES.usage
    );
  }
  return sha;
};

/** The commit where `head` leaves `base`, or null when they share none. */
const forkPoint = (cwd: string, base: string, head: string): string | null => {
  const result = runGit(cwd, ["merge-base", base, head], true);
  const sha = result.stdout.trim();
  if (result.exitCode === 0 && isCommitSha(sha)) {
    return sha;
  }
  if (result.exitCode === 1) {
    return null;
  }
  throw new SimpleChangesError(
    `Could not find where ${head} leaves ${base}: ${result.stderr.trim()}`,
    EXIT_CODES.inventory
  );
};

// The same commits, in the same order, as `proposal record-authors` lists
// for a range, so the digest here equals the one it records.
const rangeCommits = (cwd: string, base: string, head: string): string[] => {
  if (base === head) {
    return [];
  }
  const count = Number.parseInt(
    runGit(cwd, ["rev-list", "--count", `${base}..${head}`]).stdout.trim(),
    10
  );
  if (!Number.isSafeInteger(count) || count > MAX_COVERAGE_COMMITS) {
    throw new SimpleChangesError(
      `${base}..${head} holds more than ${MAX_COVERAGE_COMMITS} commits; check the base.`,
      EXIT_CODES.validation
    );
  }
  return runGit(cwd, [
    "rev-list",
    "--reverse",
    "--topo-order",
    `${base}..${head}`,
  ])
    .stdout.split(LINE_SEPARATOR)
    .filter(Boolean);
};

const ownGaps = (
  gaps: Record<string, CommitGaps>,
  commit: string
): CommitGaps | undefined =>
  Object.hasOwn(gaps, commit) ? gaps[commit] : undefined;

const recordedSources = (ledger: ReviewLedger, sha: string): string[] =>
  Object.hasOwn(ledger.replays, sha)
    ? [...(ledger.replays[sha]?.sources ?? [])]
    : [];

const outstandingItems = (
  ledger: ReviewLedger,
  commits: readonly string[],
  coverage: HeadCoverage
): CoverageItem[] => {
  const items = new Map<string, CoverageItem>();
  const add = (kind: CoverageItemKind, sha: string, commit: string): void => {
    const key = `${kind}:${sha}`;
    const known = items.get(key);
    if (known) {
      if (!known.carriedBy.includes(commit)) {
        known.carriedBy.push(commit);
      }
      return;
    }
    items.set(key, {
      carriedBy: [commit],
      kind,
      replaySources: recordedSources(ledger, sha),
      sha,
    });
  };
  const unattributed = new Set(coverage.unattributed);
  for (const commit of commits) {
    if (unattributed.has(commit)) {
      add("unattributed", commit, commit);
    }
    const gaps = ownGaps(coverage.gaps, commit);
    for (const sha of gaps?.unresolvedSources ?? []) {
      add("unresolved-source", sha, commit);
    }
    for (const sha of gaps?.uncoveredEdits ?? []) {
      add("uncovered-edit", sha, commit);
    }
  }
  return [...items.values()];
};

// Adversarial review compares model IDs, so a display name, an effort label,
// the planning sentinel, or a blank name leaves the attestation incomplete.
const hasModelId = (agent: string | null): boolean =>
  canonicalModelId(agent) !== null;

// Only a commit's own attestations that still count are listed: one a
// destination inherits from a replay source belongs to that source, and
// `--complete-identity` applies only on the commit that carries it. Resolving
// the ledger without its replay links leaves each commit's own effective
// authors, with every recorded completion already applied.
const incompleteIdentities = (
  ledger: ReviewLedger,
  commits: readonly string[]
): IncompleteAttestation[] => {
  const own = headCoverage({ ...ledger, replays: {} }, commits).authors;
  return commits.flatMap((commit) =>
    (Object.hasOwn(own, commit) ? (own[commit] ?? []) : [])
      .filter((author) => !hasModelId(author.agent))
      .map((author) => ({
        commit,
        completable:
          author.session !== null &&
          author.harness !== null &&
          author.logicalId !== null,
        logicalId: author.logicalId,
      }))
  );
};

const coverageOf = (
  cwd: string,
  base: string,
  head: string
): AuthorCoverage => {
  const { commonGitDirectory } = locateRepository(cwd).repository;
  const commits = rangeCommits(cwd, base, head);
  const state = readReviewLedger(commonGitDirectory);
  const ledger = { errors: state.errors, path: state.path, state: state.state };
  if (state.state === "malformed") {
    return {
      authorsDigest: null,
      base,
      commits,
      gaps: {},
      head,
      incompleteIdentities: [],
      ledger,
      outstanding: [],
      status: "ledger-unreadable",
      unattributed: [],
    };
  }
  const coverage = headCoverage(state.ledger, commits);
  const outstanding = outstandingItems(state.ledger, commits, coverage);
  return {
    authorsDigest: coverage.authorsDigest,
    base,
    commits,
    gaps: coverage.gaps,
    head,
    incompleteIdentities: incompleteIdentities(state.ledger, commits),
    ledger,
    outstanding,
    status: outstanding.length === 0 ? "covered" : "incomplete",
    unattributed: coverage.unattributed,
  };
};

/**
 * `author coverage --base <ref> --head <ref>`: coverage of the commits `head`
 * adds after it leaves `base`, which is what a proposal from `head` into
 * `base` carries. Read-only: no lock, no ledger write, no proposal needed.
 */
export const authorCoverage = (
  repositoryPath: string,
  baseInput: string,
  headInput: string
): AuthorCoverage => {
  const head = resolveRevision(repositoryPath, headInput, "--head");
  const target = resolveRevision(repositoryPath, baseInput, "--base");
  const base = forkPoint(repositoryPath, target, head);
  if (base === null) {
    throw new SimpleChangesError(
      `--head ${headInput} shares no history with --base ${baseInput}.`,
      EXIT_CODES.validation
    );
  }
  return coverageOf(repositoryPath, base, head);
};

/** Coverage of what `targetRef` still lacks from `head`, for a ready handoff. */
export const readyRangeCoverage = (
  cwd: string,
  targetRef: string,
  head: string
): AuthorCoverage => {
  const target = targetRef.startsWith("-")
    ? ""
    : runGit(
        cwd,
        ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`],
        true
      ).stdout.trim();
  if (!isCommitSha(target)) {
    throw new SimpleChangesError(
      `The target ${targetRef} does not resolve to a commit here, so the commits it lacks cannot be listed; fetch it first.`,
      EXIT_CODES.inventory
    );
  }
  const base = forkPoint(cwd, target, head);
  if (base === null) {
    throw new SimpleChangesError(
      `${head} shares no history with the target ${targetRef}.`,
      EXIT_CODES.validation
    );
  }
  return coverageOf(cwd, base, head);
};

const shellWord = (value: string): string =>
  PLAIN_SHELL_WORD.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

const describeItem = (item: CoverageItem): string => {
  if (item.kind === "unattributed") {
    return `${item.sha}: no attested author`;
  }
  if (item.kind === "unresolved-source") {
    return `${item.sha}: replayed by ${item.carriedBy.join(", ")} but has no attested author`;
  }
  return `${item.sha}: an inconclusive replay of ${item.replaySources.join(", ") || "its sources"} that nobody attested an edit on`;
};

/** One line per outstanding item, for any reader. */
export const describeOutstanding = (items: readonly CoverageItem[]): string[] =>
  items.map((item) => `- ${describeItem(item)}`);

/** The next step for anyone but the commit's own author: never a command to run for it. */
export const COVERAGE_NEXT_STEP =
  "Ask the agent that made each commit to attest it from its own session with `author attest`, or, once the proposal exists as a draft and `proposal record-authors` has run, ask the owner whether to waive the exact items with `proposal waive-coverage`. Never attest another agent's commits.";

export interface ReadyCoverageResult {
  coverage: AuthorCoverage;
  /** The outstanding items `--leave-uncovered` named, left for their author or the owner. */
  leftUncovered: CoverageItem[];
}

const ownerCommands = (
  coverage: AuthorCoverage,
  items: readonly CoverageItem[],
  agentId: string,
  worktreePath: string
): string[] => {
  const suffix = `--agent-id ${shellWord(agentId)} --repo ${shellWord(worktreePath)}`;
  const identity = "[--instance <id>] [--agent <model ID>]";
  const lines: string[] = [];
  const unattributed = items.filter((item) => item.kind === "unattributed");
  if (unattributed.length > 0) {
    lines.push(
      "Attest each of these commits you made, from this session, before the claim is released:",
      `  simple-changes author attest ${unattributed.map((item) => `--commit ${item.sha}`).join(" ")} ${suffix} ${identity}`,
      "  For a commit you rewrote by rebase, cherry-pick, or squash, attest it with --replays <old sha>[,<old sha>...] instead."
    );
  }
  for (const item of items.filter((entry) => entry.kind === "uncovered-edit")) {
    lines.push(
      `If you changed the implementation while replaying ${item.sha}, attest that edit from this session:`,
      `  simple-changes author attest --commit ${item.sha} --replays ${item.replaySources.join(",")} --contribution implementation ${suffix} ${identity}`
    );
  }
  const own = [
    ...new Set(
      coverage.incompleteIdentities
        .filter((entry) => entry.logicalId === agentId && entry.completable)
        .map((entry) => entry.commit)
    ),
  ];
  if (own.length > 0) {
    lines.push(
      `Attestations under your agent id on ${own.join(", ")} report no model ID. If you made them in this same session, complete them with the model ID your harness reports, such as \`model-5-5\`, and \`--instance\` whenever the earlier record has one:`,
      `  simple-changes author attest ${own.map((commit) => `--commit ${commit}`).join(" ")} ${suffix} --agent <model ID> [--instance <id>] --complete-identity`
    );
  }
  return lines;
};

/**
 * The ready-work preflight. It refuses, naming the exact commits and the
 * owner's own commands, while any commit the target lacks has no attested
 * author, carries a replay source with none, or is an inconclusive replay
 * nobody attested an edit on, unless `leaveUncovered` names exactly those
 * commits. Naming them records nothing: review of the work stays blocked
 * until the commits are attested or the owner waives them on the proposal.
 */
export const assertReadyCoverage = (
  coverage: AuthorCoverage,
  owner: { agentId: string; branch: string; claimId: string; path: string },
  leaveUncoveredInput: readonly string[]
): ReadyCoverageResult => {
  const range = `${coverage.base}..${coverage.head}`;
  if (coverage.status === "ledger-unreadable") {
    throw new SimpleChangesError(
      `The review ledger at ${coverage.ledger.path} is malformed (${coverage.ledger.errors.join("; ")}), so author coverage of ${range} cannot be shown. Ask the owner to repair it; ready work was not recorded and claim ${owner.claimId} is still yours.`,
      EXIT_CODES.unsafe
    );
  }
  const named = [...new Set(leaveUncoveredInput.map((sha) => sha.trim()))];
  const malformed = named.filter((sha) => !isCommitSha(sha));
  if (malformed.length > 0) {
    throw new SimpleChangesError(
      `--leave-uncovered takes full commit SHAs as the coverage report prints them: ${malformed.join(", ")}.`,
      EXIT_CODES.usage
    );
  }
  const outstanding = new Set(coverage.outstanding.map((item) => item.sha));
  const stray = named.filter((sha) => !outstanding.has(sha));
  if (stray.length > 0) {
    throw new SimpleChangesError(
      `--leave-uncovered names commits that are not outstanding in ${range}: ${stray.join(", ")}. Name exactly the outstanding commits; nothing was recorded.`,
      EXIT_CODES.validation
    );
  }
  const left = new Set(named);
  const remaining = coverage.outstanding.filter((item) => !left.has(item.sha));
  if (remaining.length === 0) {
    return {
      coverage,
      leftUncovered: coverage.outstanding.filter((item) => left.has(item.sha)),
    };
  }
  throw new SimpleChangesError(
    [
      `Author coverage of ${range} on ${owner.branch} is incomplete, so ready work was not recorded and claim ${owner.claimId} is still yours:`,
      ...describeOutstanding(remaining),
      ...ownerCommands(coverage, remaining, owner.agentId, owner.path),
      "A commit another agent made is that agent's to attest from its own session; never attest it for them. To hand off with such commits still uncovered, pass --leave-uncovered with exactly their SHAs. That records nothing: worktree status keeps showing them, and review stays blocked until they are attested or the owner waives them on the proposal.",
    ].join("\n"),
    EXIT_CODES.unsafe
  );
};
