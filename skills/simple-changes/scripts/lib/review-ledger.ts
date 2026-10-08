import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "bun";
import {
  type AuthoringEffort,
  type AuthoringSidecar,
  EFFORT_LEVELS,
  higherEffort,
  isHarnessId,
  isModelName,
  MOST_CAPABLE,
  type RepositoryAuthoring,
  resolveRepositoryAuthoring,
  sameModelName,
} from "./authoring.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { currentHarnessSession } from "./harness-session.ts";
import { sha256 } from "./hash.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import {
  loopLockPath,
  readLeaseFromCommonDirectory,
  withLoopStateLock,
} from "./loop-lease.ts";
import { gitExecutable, runGit, runGitWithInput } from "./process.ts";
import type {
  LoopLease,
  RepositoryInventory,
  WorktreeCoordinationDocument,
} from "./types.ts";
import { readCoordinationDocumentFromCommonDirectory } from "./worktree-coordination.ts";

// The review ledger: durable, proposal-scoped evidence of who wrote each
// commit and who reviewed each proposal head, kept in its own versioned file
// beside the loop lease so the existing closed state objects never change and
// older copies never open it. Every identity in it is a runtime identity the
// executing session reported (trusted self-attestation); Git checks here are
// membership and baseline checks, never proof of where a commit was made.
// This module names no harness: the session and harness come only from the
// session adapter, and preferences come from the authoring sidecar resolver.

type Environment = Record<string, string | undefined>;

const STATE_DIRECTORY = "simple-changes";
const LEDGER_FILENAME = "review-ledger.json";
const LOCK_OWNER_FILENAME = "owner.json";
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REVISION_INPUT_PATTERN = /^[0-9a-f]{7,64}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/u;
const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#!@+-]{0,199}$/u;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const LINE_SEPARATOR = /\r?\n/u;
const BLANK_LINE = /\r?\n\r?\n/u;
const LOGICAL_ID_LIMIT = 128;
const APPROVER_LIMIT = 128;
const REASON_LIMIT = 1000;
const MAX_RANGE_COMMITS = 1000;
const ENDED_CLAIM_STATES = new Set(["released", "stale"]);
const HANDED_BACK_RELEASES = new Set(["owner-release", "handoff"]);
const ESCALATION_EFFORTS = new Set<AuthoringEffort>(["high", "xhigh"]);

/** A runtime identity as the executing harness reported it. */
export interface RuntimeIdentity {
  agent: string | null;
  harness: string | null;
  instance: string | null;
  session: string | null;
}

/** One agent's attested contribution to a commit's implementation. */
export interface Attestation extends RuntimeIdentity {
  logicalId: string | null;
  recordedAt: string;
}

export interface CommitGaps {
  uncoveredEdits: string[];
  unresolvedSources: string[];
}

export interface ReplayRecord {
  inheritedGaps: CommitGaps;
  ownGaps: { uncoveredEdit: boolean; unresolvedSources: string[] };
  recordedAt: string;
  sources: string[];
  verification: "verified" | "inconclusive";
}

export interface CopyAuthor extends RuntimeIdentity {
  recordedAt: string;
  source: "direct" | "delegated";
}

export interface CoverageWaiver {
  approvedBy: string;
  authorsDigest: string;
  gaps: Record<string, CommitGaps>;
  reason: string;
  recordedAt: string;
  unattributed: string[];
  waiverId: string;
}

export interface ProposalHead {
  authorsDigest: string;
  base: string;
  commits: string[];
  copyAuthors: CopyAuthor[];
  gaps: Record<string, CommitGaps>;
  unattributed: string[];
  waivers: CoverageWaiver[];
}

export type ReviewEffortSource = "configured" | "escalation" | "request";
export type ReviewVerdict = "findings" | "clean" | "failed";

export interface ReviewAttempt {
  acceptanceReason: string | null;
  accepted: boolean;
  attemptId: string;
  authorsDigest: string;
  coverageWaiverId: string | null;
  effort: AuthoringEffort;
  effortSource: ReviewEffortSource;
  findingsCount: number;
  headRevision: string;
  recordedAt: string;
  requested: { effort: AuthoringEffort; harness: string; model: string };
  verdict: ReviewVerdict;
  verified: RuntimeIdentity;
}

export interface ProposalRecord {
  attempts: ReviewAttempt[];
  heads: Record<string, ProposalHead>;
}

export interface ReviewLedger {
  attestations: Record<string, Attestation[]>;
  proposals: Record<string, ProposalRecord>;
  replays: Record<string, ReplayRecord>;
  schemaVersion: 1;
}

export type LedgerProblem = "ledger-malformed" | "ledger-cycle";

export interface ReviewLedgerState {
  errors: string[];
  ledger: ReviewLedger;
  path: string;
  reason: LedgerProblem | null;
  state: "absent" | "valid" | "malformed";
}

export type ReviewerReason =
  | "authoring-repair"
  | "author-identity-missing"
  | "authors-not-recorded"
  | "coverage-incomplete"
  | "ledger-cycle"
  | "ledger-malformed"
  | "most-capable-unresolved"
  | "no-delegation"
  | "no-effective-authors"
  | "reviewer-not-distinct"
  | "running-harness-unknown";

export type AcceptanceReason =
  | "authoring-repair"
  | "author-identity-missing"
  | "authors-not-recorded"
  | "coverage-incomplete"
  | "independence-unproven"
  | "no-effective-authors"
  | "review-failed"
  | "reviewer-identity-missing"
  | "reviewer-not-distinct"
  | "reviewer-not-independent"
  | "stale-head";

/** Coverage evidence for one proposal head, as verified resolution saw it. */
export interface ReviewerProposalEvidence {
  authorsDigest: string | null;
  coverageWaiverId: string | null;
  fullyCovered: boolean;
  gaps: Record<string, CommitGaps>;
  head: string;
  proposalId: string;
  reviewedAttemptId: string | null;
  unattributed: string[];
}

export interface ReviewerResolution {
  adversarial: boolean;
  effort: AuthoringEffort | null;
  effortSource: "configured" | "escalation" | null;
  harness: string | null;
  mode: "provisional" | "verified";
  model: string | null;
  proposal: ReviewerProposalEvidence | null;
  reason: ReviewerReason | null;
  status: "resolved" | "unresolved" | "blocked";
}

/** Proof that the caller holds the loop lock; writers refuse without it. */
export interface HeldLoopLock {
  readonly commonGitDirectory: string;
  readonly operation: string;
}

// ---------------------------------------------------------------------------
// Validation

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A map entry only when the map itself holds the key. Proposal ids such as
 * `constructor` or `toString` are valid, so an inherited property must
 * never be read as a ledger record.
 */
const ownValue = <T>(
  map: Readonly<Record<string, T>>,
  key: string
): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

// C0 controls (newlines included), DEL, and C1 controls.
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

export const isCommitSha = (value: unknown): value is string =>
  typeof value === "string" && SHA_PATTERN.test(value);

export const isProposalId = (value: unknown): value is string =>
  typeof value === "string" && PROPOSAL_ID_PATTERN.test(value);

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  value.includes("T") &&
  !Number.isNaN(Date.parse(value));

const isToken = (value: unknown): value is string =>
  typeof value === "string" && TOKEN_PATTERN.test(value);

// Lengths count Unicode characters (code points), as the schema engine does.
const characterCount = (value: string): number => [...value].length;

const isLogicalId = (value: unknown): value is string =>
  typeof value === "string" &&
  characterCount(value) > 0 &&
  characterCount(value) <= LOGICAL_ID_LIMIT &&
  value.trim() === value &&
  !hasControlCharacter(value);

const isText = (value: unknown, limit: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  characterCount(value) <= limit &&
  !hasControlCharacter(value);

const isEffort = (value: unknown): value is AuthoringEffort =>
  typeof value === "string" &&
  (EFFORT_LEVELS as readonly string[]).includes(value);

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

class Checker {
  readonly errors: string[] = [];

  check(ok: boolean, path: string, message: string): void {
    if (!ok) {
      this.errors.push(`${path} ${message}`);
    }
  }

  object(value: unknown, path: string): value is Record<string, unknown> {
    this.check(isRecord(value), path, "must be an object");
    return isRecord(value);
  }

  keys(
    value: Record<string, unknown>,
    keys: readonly string[],
    path: string
  ): void {
    for (const key of Object.keys(value)) {
      this.check(keys.includes(key), `${path}.${key}`, "is not allowed");
    }
    for (const key of keys) {
      this.check(Object.hasOwn(value, key), `${path}.${key}`, "is required");
    }
  }

  shaList(value: unknown, path: string, nonEmpty = false): value is string[] {
    if (!Array.isArray(value)) {
      this.check(false, path, "must be an array of commit SHAs");
      return false;
    }
    this.check(value.every(isCommitSha), path, "must hold full commit SHAs");
    this.check(new Set(value).size === value.length, path, "repeats a SHA");
    if (nonEmpty) {
      this.check(value.length > 0, path, "must not be empty");
    }
    return true;
  }

  gaps(value: unknown, path: string): void {
    if (this.object(value, path)) {
      this.keys(value, ["uncoveredEdits", "unresolvedSources"], path);
      this.shaList(value.unresolvedSources, `${path}.unresolvedSources`);
      this.shaList(value.uncoveredEdits, `${path}.uncoveredEdits`);
    }
  }

  gapMap(value: unknown, path: string, commits?: ReadonlySet<string>): void {
    if (!this.object(value, path)) {
      return;
    }
    for (const [commit, gaps] of Object.entries(value)) {
      this.check(isCommitSha(commit), `${path}.${commit}`, "is not a SHA");
      if (commits) {
        this.check(
          commits.has(commit),
          `${path}.${commit}`,
          "names a commit outside the range"
        );
      }
      this.gaps(gaps, `${path}.${commit}`);
    }
  }

  identity(value: Record<string, unknown>, path: string): void {
    this.check(
      value.instance === null || isToken(value.instance),
      `${path}.instance`,
      "must be an instance id or null"
    );
    this.check(
      value.session === null || isToken(value.session),
      `${path}.session`,
      "must be a session id or null"
    );
    this.check(
      value.harness === null || isHarnessId(value.harness),
      `${path}.harness`,
      "must be a harness id or null"
    );
    this.check(
      value.agent === null || isModelName(value.agent),
      `${path}.agent`,
      "must be a model name or null"
    );
  }
}

const IDENTITY_KEYS = ["agent", "harness", "instance", "session"] as const;

const checkAttestations = (checker: Checker, value: unknown): void => {
  if (!checker.object(value, "attestations")) {
    return;
  }
  for (const [commit, list] of Object.entries(value)) {
    const path = `attestations.${commit}`;
    checker.check(isCommitSha(commit), path, "is not keyed by a full SHA");
    if (!Array.isArray(list) || list.length === 0) {
      checker.check(false, path, "must be a non-empty array");
      continue;
    }
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
      const entryPath = `${path}[${index}]`;
      if (!checker.object(entry, entryPath)) {
        continue;
      }
      checker.keys(
        entry,
        [...IDENTITY_KEYS, "logicalId", "recordedAt"],
        entryPath
      );
      checker.identity(entry, entryPath);
      checker.check(
        entry.logicalId === null || isLogicalId(entry.logicalId),
        `${entryPath}.logicalId`,
        "must be an agent id or null"
      );
      checker.check(
        isTimestamp(entry.recordedAt),
        `${entryPath}.recordedAt`,
        "must be a date-time"
      );
      const key = identityKey(entry as unknown as Attestation);
      checker.check(!seen.has(key), entryPath, "repeats an identity");
      seen.add(key);
    }
  }
};

const checkReplay = (
  checker: Checker,
  destination: string,
  record: unknown
): void => {
  const path = `replays.${destination}`;
  checker.check(isCommitSha(destination), path, "is not keyed by a full SHA");
  if (!checker.object(record, path)) {
    return;
  }
  checker.keys(
    record,
    ["inheritedGaps", "ownGaps", "recordedAt", "sources", "verification"],
    path
  );
  if (checker.shaList(record.sources, `${path}.sources`, true)) {
    checker.check(
      !record.sources.includes(destination),
      `${path}.sources`,
      "must not name the destination itself"
    );
  }
  checker.check(
    record.verification === "verified" ||
      record.verification === "inconclusive",
    `${path}.verification`,
    "must be verified or inconclusive"
  );
  checker.check(
    isTimestamp(record.recordedAt),
    `${path}.recordedAt`,
    "must be a date-time"
  );
  checker.gaps(record.inheritedGaps, `${path}.inheritedGaps`);
  const own = record.ownGaps;
  if (checker.object(own, `${path}.ownGaps`)) {
    checker.keys(
      own,
      ["uncoveredEdit", "unresolvedSources"],
      `${path}.ownGaps`
    );
    checker.check(
      typeof own.uncoveredEdit === "boolean" &&
        !(own.uncoveredEdit && record.verification === "verified"),
      `${path}.ownGaps.uncoveredEdit`,
      "must be a boolean, and false for a verified replay"
    );
    if (
      checker.shaList(
        own.unresolvedSources,
        `${path}.ownGaps.unresolvedSources`
      ) &&
      Array.isArray(record.sources)
    ) {
      const sources = record.sources as unknown[];
      checker.check(
        own.unresolvedSources.every((source) => sources.includes(source)),
        `${path}.ownGaps.unresolvedSources`,
        "must name only the record's sources"
      );
    }
  }
};

const checkReplays = (checker: Checker, value: unknown): void => {
  if (!checker.object(value, "replays")) {
    return;
  }
  for (const [destination, record] of Object.entries(value)) {
    checkReplay(checker, destination, record);
  }
};

const checkCopyAuthor = (
  checker: Checker,
  value: unknown,
  path: string
): void => {
  if (!checker.object(value, path)) {
    return;
  }
  checker.keys(value, [...IDENTITY_KEYS, "recordedAt", "source"], path);
  checker.identity(value, path);
  checker.check(
    value.source === "direct" || value.source === "delegated",
    `${path}.source`,
    "must be direct or delegated"
  );
  checker.check(
    isTimestamp(value.recordedAt),
    `${path}.recordedAt`,
    "must be a date-time"
  );
};

const checkWaiver = (checker: Checker, value: unknown, path: string): void => {
  if (!checker.object(value, path)) {
    return;
  }
  checker.keys(
    value,
    [
      "approvedBy",
      "authorsDigest",
      "gaps",
      "reason",
      "recordedAt",
      "unattributed",
      "waiverId",
    ],
    path
  );
  checker.check(isUuid(value.waiverId), `${path}.waiverId`, "must be a UUID");
  checker.check(
    typeof value.authorsDigest === "string" &&
      DIGEST_PATTERN.test(value.authorsDigest),
    `${path}.authorsDigest`,
    "must be a SHA-256 digest"
  );
  checker.shaList(value.unattributed, `${path}.unattributed`);
  checker.gapMap(value.gaps, `${path}.gaps`);
  checker.check(
    isText(value.approvedBy, APPROVER_LIMIT),
    `${path}.approvedBy`,
    "must name the approver"
  );
  checker.check(
    isText(value.reason, REASON_LIMIT),
    `${path}.reason`,
    "must give a reason"
  );
  checker.check(
    isTimestamp(value.recordedAt),
    `${path}.recordedAt`,
    "must be a date-time"
  );
};

const checkHead = (
  checker: Checker,
  head: string,
  value: unknown,
  path: string
): void => {
  checker.check(isCommitSha(head), path, "is not keyed by a full SHA");
  if (!checker.object(value, path)) {
    return;
  }
  checker.keys(
    value,
    [
      "authorsDigest",
      "base",
      "commits",
      "copyAuthors",
      "gaps",
      "unattributed",
      "waivers",
    ],
    path
  );
  checker.check(isCommitSha(value.base), `${path}.base`, "must be a full SHA");
  const commits = checker.shaList(value.commits, `${path}.commits`, true)
    ? new Set(value.commits)
    : new Set<string>();
  if (checker.shaList(value.unattributed, `${path}.unattributed`)) {
    checker.check(
      value.unattributed.every((commit) => commits.has(commit)),
      `${path}.unattributed`,
      "must name only commits in the range"
    );
  }
  checker.gapMap(value.gaps, `${path}.gaps`, commits);
  checker.check(
    typeof value.authorsDigest === "string" &&
      DIGEST_PATTERN.test(value.authorsDigest),
    `${path}.authorsDigest`,
    "must be a SHA-256 digest"
  );
  if (Array.isArray(value.copyAuthors)) {
    for (const [index, author] of value.copyAuthors.entries()) {
      checkCopyAuthor(checker, author, `${path}.copyAuthors[${index}]`);
    }
  } else {
    checker.check(false, `${path}.copyAuthors`, "must be an array");
  }
  if (Array.isArray(value.waivers)) {
    for (const [index, waiver] of value.waivers.entries()) {
      checkWaiver(checker, waiver, `${path}.waivers[${index}]`);
    }
  } else {
    checker.check(false, `${path}.waivers`, "must be an array");
  }
};

const checkRequested = (
  checker: Checker,
  value: unknown,
  path: string
): void => {
  if (!checker.object(value, path)) {
    return;
  }
  checker.keys(value, ["effort", "harness", "model"], path);
  checker.check(isHarnessId(value.harness), `${path}.harness`, "is invalid");
  checker.check(isModelName(value.model), `${path}.model`, "is invalid");
  checker.check(isEffort(value.effort), `${path}.effort`, "is invalid");
};

const checkAttemptOutcome = (
  checker: Checker,
  value: Record<string, unknown>,
  path: string
): void => {
  checker.check(
    value.verdict === "findings" ||
      value.verdict === "clean" ||
      value.verdict === "failed",
    `${path}.verdict`,
    "must be findings, clean, or failed"
  );
  const count = value.findingsCount;
  checker.check(
    typeof count === "number" &&
      Number.isInteger(count) &&
      count >= 0 &&
      (value.verdict !== "findings" || count > 0) &&
      (value.verdict !== "clean" || count === 0),
    `${path}.findingsCount`,
    "must be a count consistent with the verdict"
  );
  checker.check(
    typeof value.accepted === "boolean",
    `${path}.accepted`,
    "must be a boolean"
  );
  checker.check(
    value.accepted === true
      ? value.acceptanceReason === null
      : typeof value.acceptanceReason === "string" &&
          REASON_CODE_PATTERN.test(value.acceptanceReason),
    `${path}.acceptanceReason`,
    "must be null when accepted and a reason code otherwise"
  );
  checker.check(
    value.coverageWaiverId === null || isUuid(value.coverageWaiverId),
    `${path}.coverageWaiverId`,
    "must be a waiver id or null"
  );
};

const checkAttempt = (checker: Checker, value: unknown, path: string): void => {
  if (!checker.object(value, path)) {
    return;
  }
  checker.keys(
    value,
    [
      "acceptanceReason",
      "accepted",
      "attemptId",
      "authorsDigest",
      "coverageWaiverId",
      "effort",
      "effortSource",
      "findingsCount",
      "headRevision",
      "recordedAt",
      "requested",
      "verdict",
      "verified",
    ],
    path
  );
  checker.check(isUuid(value.attemptId), `${path}.attemptId`, "must be a UUID");
  checker.check(
    isCommitSha(value.headRevision),
    `${path}.headRevision`,
    "must be a full SHA"
  );
  checker.check(
    typeof value.authorsDigest === "string" &&
      DIGEST_PATTERN.test(value.authorsDigest),
    `${path}.authorsDigest`,
    "must be a SHA-256 digest"
  );
  checkRequested(checker, value.requested, `${path}.requested`);
  if (checker.object(value.verified, `${path}.verified`)) {
    checker.keys(value.verified, IDENTITY_KEYS, `${path}.verified`);
    checker.identity(value.verified, `${path}.verified`);
  }
  checker.check(isEffort(value.effort), `${path}.effort`, "is invalid");
  checker.check(
    value.effortSource === "configured" ||
      value.effortSource === "request" ||
      (value.effortSource === "escalation" &&
        ESCALATION_EFFORTS.has(value.effort as AuthoringEffort)),
    `${path}.effortSource`,
    "must be configured, request, or escalation (high or xhigh only)"
  );
  checkAttemptOutcome(checker, value, path);
  checker.check(
    isTimestamp(value.recordedAt),
    `${path}.recordedAt`,
    "must be a date-time"
  );
};

const checkProposals = (checker: Checker, value: unknown): void => {
  if (!checker.object(value, "proposals")) {
    return;
  }
  const attemptIds = new Set<string>();
  for (const [proposalId, record] of Object.entries(value)) {
    const path = `proposals.${proposalId}`;
    checker.check(isProposalId(proposalId), path, "is not a proposal id");
    if (!checker.object(record, path)) {
      continue;
    }
    checker.keys(record, ["attempts", "heads"], path);
    if (checker.object(record.heads, `${path}.heads`)) {
      for (const [head, entry] of Object.entries(record.heads)) {
        checkHead(checker, head, entry, `${path}.heads.${head}`);
      }
    }
    if (!Array.isArray(record.attempts)) {
      checker.check(false, `${path}.attempts`, "must be an array");
      continue;
    }
    for (const [index, attempt] of record.attempts.entries()) {
      const attemptPath = `${path}.attempts[${index}]`;
      checkAttempt(checker, attempt, attemptPath);
      const id = isRecord(attempt) ? attempt.attemptId : undefined;
      if (typeof id === "string") {
        checker.check(!attemptIds.has(id), attemptPath, "repeats an attemptId");
        attemptIds.add(id);
      }
    }
  }
};

// Every commit resolution follows from a replay record: its sources, and the
// stored inherited unresolved sources it re-resolves to see whether they
// closed. Inherited gaps are always transitive sources, so a ledger built by
// these commands never gains a cycle from them.
const replayDependencies = (record: ReplayRecord | undefined): string[] =>
  record ? [...record.sources, ...record.inheritedGaps.unresolvedSources] : [];

interface CycleFrame {
  dependencies: string[];
  next: number;
  node: string;
}

/**
 * A commit reachable from itself through replay links, or null. Replay links
 * form a directed acyclic graph by construction, so a cycle can only come
 * from external editing; it makes the whole ledger malformed. The walk
 * follows every dependency resolution follows, so a ledger that validates
 * always resolves.
 */
const replayCycle = (replays: Record<string, ReplayRecord>): string | null => {
  const state = new Map<string, "visiting" | "done">();
  const frameFor = (node: string): CycleFrame => ({
    dependencies: replayDependencies(ownValue(replays, node)),
    next: 0,
    node,
  });
  for (const start of Object.keys(replays)) {
    if (state.has(start)) {
      continue;
    }
    state.set(start, "visiting");
    const stack: CycleFrame[] = [frameFor(start)];
    while (stack.length > 0) {
      const frame = stack.at(-1) as CycleFrame;
      const source = frame.dependencies[frame.next];
      if (source === undefined) {
        state.set(frame.node, "done");
        stack.pop();
        continue;
      }
      frame.next += 1;
      const seen = state.get(source);
      if (seen === "visiting") {
        return source;
      }
      if (!seen) {
        state.set(source, "visiting");
        stack.push(frameFor(source));
      }
    }
  }
  return null;
};

export interface ReviewLedgerValidation {
  errors: string[];
  reason: LedgerProblem | null;
}

/** Validates a whole ledger: exact keys at every level, then acyclicity. */
export const validateReviewLedger = (
  value: unknown
): ReviewLedgerValidation => {
  if (!isRecord(value)) {
    return {
      errors: ["the ledger must be a JSON object"],
      reason: "ledger-malformed",
    };
  }
  const checker = new Checker();
  checker.keys(
    value,
    ["attestations", "proposals", "replays", "schemaVersion"],
    "ledger"
  );
  checker.check(value.schemaVersion === 1, "ledger.schemaVersion", "must be 1");
  checkAttestations(checker, value.attestations);
  checkReplays(checker, value.replays);
  checkProposals(checker, value.proposals);
  if (checker.errors.length > 0) {
    return { errors: checker.errors, reason: "ledger-malformed" };
  }
  const cycle = replayCycle(value.replays as Record<string, ReplayRecord>);
  return cycle
    ? {
        errors: [`replays contain a cycle through ${cycle}`],
        reason: "ledger-cycle",
      }
    : { errors: [], reason: null };
};

// ---------------------------------------------------------------------------
// Reading, locking, and atomic writes

export const reviewLedgerPath = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY, LEDGER_FILENAME);

export const emptyReviewLedger = (): ReviewLedger => ({
  attestations: {},
  proposals: {},
  replays: {},
  schemaVersion: 1,
});

export interface ReadReviewLedgerOptions {
  /** Inspects the ledger path; tests inject failures here. */
  inspect?: (path: string) => { isFile: () => boolean };
}

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";

/**
 * Reads and validates the ledger without a lock. Only a missing file is
 * absence. A malformed ledger, or one that cannot be inspected or read, is
 * reported with its errors and an empty ledger in its place; it is never
 * repaired here, it blocks acceptance, and every write transaction refuses
 * it, so an inspection failure can never replace recorded history.
 */
export const readReviewLedger = (
  commonGitDirectory: string,
  options: ReadReviewLedgerOptions = {}
): ReviewLedgerState => {
  const path = reviewLedgerPath(commonGitDirectory);
  const malformed = (
    errors: string[],
    reason: LedgerProblem = "ledger-malformed"
  ): ReviewLedgerState => ({
    errors,
    ledger: emptyReviewLedger(),
    path,
    reason,
    state: "malformed",
  });
  const inspect = options.inspect ?? lstatSync;
  let isFile: boolean;
  try {
    isFile = inspect(path).isFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        errors: [],
        ledger: emptyReviewLedger(),
        path,
        reason: null,
        state: "absent",
      };
    }
    return malformed([
      `${path} could not be inspected (${errorCode(error)}); fix access to it before any ledger write`,
    ]);
  }
  if (!isFile) {
    return malformed([`${path} must be a regular file`]);
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return malformed([
      `${path} could not be read (${errorCode(error)}); fix access to it before any ledger write`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return malformed([`${path} is not valid JSON`]);
  }
  const validation = validateReviewLedger(parsed);
  if (validation.reason) {
    return malformed(validation.errors, validation.reason);
  }
  return {
    errors: [],
    ledger: parsed as ReviewLedger,
    path,
    reason: null,
    state: "valid",
  };
};

const lockOwner = (
  commonGitDirectory: string
): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(
        join(loopLockPath(commonGitDirectory), LOCK_OWNER_FILENAME),
        "utf8"
      )
    );
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Confirms this process holds the loop lock and returns the proof internal
 * callers pass in. The lock is not reentrant, so a caller that already holds
 * it (resume, finalize) uses this instead of acquiring it again.
 */
export const heldLoopLock = (
  commonGitDirectory: string,
  operation: string
): HeldLoopLock => {
  const owner = lockOwner(commonGitDirectory);
  if (!(owner?.pid === process.pid && owner.hostname === hostname())) {
    throw new SimpleChangesError(
      `The review ledger is written only while this process holds the loop lock at ${loopLockPath(commonGitDirectory)}.`,
      EXIT_CODES.unsafe
    );
  }
  return { commonGitDirectory, operation };
};

/**
 * Validates the whole ledger, writes a temporary file in the same directory,
 * and renames it over the ledger. A failed write leaves the previous ledger
 * unchanged and removes the temporary file.
 */
export const writeReviewLedger = (
  lock: HeldLoopLock,
  ledger: ReviewLedger
): void => {
  heldLoopLock(lock.commonGitDirectory, lock.operation);
  const validation = validateReviewLedger(ledger);
  if (validation.reason) {
    throw new SimpleChangesError(
      `Refusing to write an invalid review ledger (${validation.reason}): ${validation.errors.join("; ")}`,
      EXIT_CODES.validation
    );
  }
  const path = reviewLedgerPath(lock.commonGitDirectory);
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw SimpleChangesError.withCause(
      `Could not write the review ledger at ${path}; the previous ledger is unchanged.`,
      EXIT_CODES.unsafe,
      error
    );
  }
};

const assertOutsideLoopExec = (commonGitDirectory: string): void => {
  if (lockOwner(commonGitDirectory)?.operation === "loop exec") {
    throw new SimpleChangesError(
      "The review ledger cannot be written while loop exec holds the loop lock. Run this command after loop exec returns; it takes the loop lock itself and is never nested inside an exec.",
      EXIT_CODES.unsafe
    );
  }
};

/**
 * One public ledger write: take the loop lock, read and validate the whole
 * ledger (refusing a malformed one), apply the change to a copy, recompute
 * the derived coverage fields, and write atomically only when something
 * changed. Lock order stays loop lock, then coordination lock; this never
 * takes the coordination lock.
 */
const withLedgerTransaction = <T>(
  commonGitDirectory: string,
  operation: string,
  mutate: (ledger: ReviewLedger, lock: HeldLoopLock) => T
): T => {
  assertOutsideLoopExec(commonGitDirectory);
  return withLoopStateLock(commonGitDirectory, operation, () => {
    const lock = heldLoopLock(commonGitDirectory, operation);
    const current = readReviewLedger(commonGitDirectory);
    if (current.state === "malformed") {
      throw new SimpleChangesError(
        `The review ledger at ${current.path} is malformed (${current.reason}): ${current.errors.join("; ")}. Repair or remove it; it is never repaired silently.`,
        EXIT_CODES.validation
      );
    }
    const before = JSON.stringify(current.ledger);
    const ledger = structuredClone(current.ledger);
    const result = mutate(ledger, lock);
    refreshDerivedRecords(ledger);
    if (JSON.stringify(ledger) !== before) {
      writeReviewLedger(lock, ledger);
    }
    return result;
  });
};

// ---------------------------------------------------------------------------
// Effective authors, gaps, coverage, and the authors digest

const identityKey = (
  identity: RuntimeIdentity & { logicalId?: string | null }
): string =>
  JSON.stringify([
    identity.instance,
    identity.session,
    identity.harness,
    identity.agent,
    identity.logicalId ?? null,
  ]);

interface LedgerResolver {
  authors: (commit: string) => Attestation[];
  gaps: (commit: string) => CommitGaps;
  ownGaps: (commit: string) => ReplayRecord["ownGaps"] | null;
  /** Commits evaluated so far, each exactly once, in evaluation order. */
  visited: readonly string[];
}

const sortedGaps = (
  unresolved: Iterable<string>,
  uncovered: Iterable<string>
): CommitGaps => ({
  uncoveredEdits: [...new Set(uncovered)].sort(),
  unresolvedSources: [...new Set(unresolved)].sort(),
});

// One evaluated commit. Sets and maps are never mutated once stored, so a
// commit that adds nothing to its single source shares that source's values
// and a long linear chain stays linear in time and memory.
interface ResolvedNode {
  authors: ReadonlyMap<string, Attestation>;
  own: ReplayRecord["ownGaps"] | null;
  uncovered: ReadonlySet<string>;
  unresolved: ReadonlySet<string>;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_AUTHORS: ReadonlyMap<string, Attestation> = new Map();

const unionSets = (
  bases: readonly ReadonlySet<string>[],
  extras: readonly string[]
): ReadonlySet<string> => {
  const nonEmpty = bases.filter((base) => base.size > 0);
  const [first] = nonEmpty;
  if (!first) {
    return extras.length === 0 ? EMPTY_SET : new Set(extras);
  }
  if (nonEmpty.length === 1 && extras.every((extra) => first.has(extra))) {
    return first;
  }
  const union = new Set(first);
  for (const base of nonEmpty.slice(1)) {
    for (const value of base) {
      union.add(value);
    }
  }
  for (const extra of extras) {
    union.add(extra);
  }
  return union;
};

const unionAuthors = (
  bases: readonly ReadonlyMap<string, Attestation>[],
  own: readonly Attestation[]
): ReadonlyMap<string, Attestation> => {
  const nonEmpty = bases.filter((base) => base.size > 0);
  const [first] = nonEmpty;
  const ownKeys = own.map((attestation) => identityKey(attestation));
  if (
    first &&
    nonEmpty.length === 1 &&
    ownKeys.every((key) => first.has(key))
  ) {
    return first;
  }
  if (!first && own.length === 0) {
    return EMPTY_AUTHORS;
  }
  const union = new Map<string, Attestation>();
  for (const base of nonEmpty) {
    for (const [key, attestation] of base) {
      if (!union.has(key)) {
        union.set(key, attestation);
      }
    }
  }
  for (const [index, attestation] of own.entries()) {
    const key = ownKeys[index] as string;
    if (!union.has(key)) {
      union.set(key, attestation);
    }
  }
  return union;
};

/**
 * Effective authors and gaps for the whole ledger, resolved at read time
 * through the replay links in one iterative post-order traversal shared by
 * every query. Each commit is evaluated at most once per resolver, after its
 * sources and stored inherited sources, so coverage over many commits never
 * re-walks a shared ancestry.
 * A commit reached again while still on the traversal stack is a cycle,
 * reported as `ledger-cycle`.
 */
const createResolver = (ledger: ReviewLedger): LedgerResolver => {
  const memo = new Map<string, ResolvedNode>();
  const onStack = new Set<string>();
  const visited: string[] = [];
  // An inconclusive replay's edit stays uncovered until someone attests an
  // implementation contribution on that destination. A gap naming a commit
  // with no replay record cannot be shown closed, so it stays open.
  const editOpen = (destination: string): boolean => {
    const record = ownValue(ledger.replays, destination);
    return record
      ? record.verification === "inconclusive" &&
          (ownValue(ledger.attestations, destination)?.length ?? 0) === 0
      : true;
  };
  const cycle = (commit: string): SimpleChangesError =>
    new SimpleChangesError(
      `ledger-cycle: replay records loop through ${commit}.`,
      EXIT_CODES.validation
    );
  const resolveNode = (start: string): ResolvedNode => {
    const known = memo.get(start);
    if (known) {
      return known;
    }
    if (onStack.has(start)) {
      throw cycle(start);
    }
    onStack.add(start);
    // Every dependency evaluation reads, stored inherited sources included,
    // is resolved here before its dependent, so evaluation never recurses
    // and depth is bounded by memory, not the call stack.
    const frameFor = (node: string): CycleFrame => ({
      dependencies: replayDependencies(ownValue(ledger.replays, node)),
      next: 0,
      node,
    });
    const stack: CycleFrame[] = [frameFor(start)];
    while (stack.length > 0) {
      const frame = stack.at(-1) as CycleFrame;
      const source = frame.dependencies[frame.next];
      if (source !== undefined) {
        frame.next += 1;
        if (memo.has(source)) {
          continue;
        }
        if (onStack.has(source)) {
          throw cycle(source);
        }
        onStack.add(source);
        stack.push(frameFor(source));
        continue;
      }
      stack.pop();
      memo.set(frame.node, evaluate(frame.node));
      onStack.delete(frame.node);
      visited.push(frame.node);
    }
    return memo.get(start) as ResolvedNode;
  };
  const evaluate = (commit: string): ResolvedNode => {
    const record = ownValue(ledger.replays, commit);
    const own = ownValue(ledger.attestations, commit) ?? [];
    const sources = (record?.sources ?? []).map(
      (source) => memo.get(source) as ResolvedNode
    );
    const authors = unionAuthors(
      sources.map((source) => source.authors),
      own
    );
    if (!record) {
      return {
        authors,
        own: null,
        uncovered: EMPTY_SET,
        unresolved: EMPTY_SET,
      };
    }
    const ownGaps = {
      uncoveredEdit: record.verification === "inconclusive" && own.length === 0,
      unresolvedSources: record.sources.filter(
        (_, index) => sources[index]?.authors.size === 0
      ),
    };
    // Stored inherited gaps stay until closed: a source attested since, or an
    // edit attested since. They are resolved through the same memo.
    const inheritedUnresolved = record.inheritedGaps.unresolvedSources.filter(
      (sha) => (memo.get(sha) as ResolvedNode).authors.size === 0
    );
    const inheritedUncovered =
      record.inheritedGaps.uncoveredEdits.filter(editOpen);
    return {
      authors,
      own: ownGaps,
      uncovered: unionSets(
        sources.map((source) => source.uncovered),
        [...(ownGaps.uncoveredEdit ? [commit] : []), ...inheritedUncovered]
      ),
      unresolved: unionSets(
        sources.map((source) => source.unresolved),
        [...ownGaps.unresolvedSources, ...inheritedUnresolved]
      ),
    };
  };
  const sortedAuthors = new Map<string, Attestation[]>();
  return {
    authors: (commit) => {
      const known = sortedAuthors.get(commit);
      if (known) {
        return known;
      }
      const sorted = [...resolveNode(commit).authors.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, attestation]) => attestation);
      sortedAuthors.set(commit, sorted);
      return sorted;
    },
    gaps: (commit) => {
      const node = resolveNode(commit);
      return sortedGaps(node.unresolved, node.uncovered);
    },
    ownGaps: (commit) => resolveNode(commit).own,
    visited,
  };
};

/**
 * A commit's effective authors: its own attestations plus the effective
 * authors of every source its replay record names, recursively, resolved at
 * read time and never copied. Each commit is visited at most once.
 */
export const resolveEffectiveAuthors = (
  ledger: ReviewLedger,
  commit: string
): { authors: Attestation[]; visited: string[] } => {
  const resolver = createResolver(ledger);
  const authors = resolver.authors(commit);
  return { authors, visited: [...resolver.visited] };
};

const hasGaps = (gaps: CommitGaps): boolean =>
  gaps.unresolvedSources.length > 0 || gaps.uncoveredEdits.length > 0;

export interface HeadCoverage {
  authors: Record<string, Attestation[]>;
  authorsDigest: string;
  fullyCovered: boolean;
  gaps: Record<string, CommitGaps>;
  unattributed: string[];
}

const authorIdentity = (attestation: Attestation) => ({
  agent: attestation.agent,
  harness: attestation.harness,
  instance: attestation.instance,
  logicalId: attestation.logicalId,
  session: attestation.session,
});

/**
 * Coverage of a commit range: each commit's effective authors, the commits
 * with none, and every open own or inherited gap. The digest covers the
 * (commit, effective author) pairs, the unattributed list and the gaps map,
 * so an attestation anywhere in a commit's ancestry, a new commit, or a gap
 * opening or closing changes it.
 */
const computeCoverage = (
  resolver: LedgerResolver,
  commits: readonly string[]
): HeadCoverage => {
  const authors: Record<string, Attestation[]> = {};
  const gaps: Record<string, CommitGaps> = {};
  const unattributed: string[] = [];
  for (const commit of commits) {
    const resolved = resolver.authors(commit);
    authors[commit] = resolved;
    if (resolved.length === 0) {
      unattributed.push(commit);
    }
    const open = resolver.gaps(commit);
    if (hasGaps(open)) {
      gaps[commit] = open;
    }
  }
  const pairs = commits
    .flatMap((commit) =>
      (ownValue(authors, commit) ?? []).map((author) =>
        JSON.stringify({ author: authorIdentity(author), commit })
      )
    )
    .sort();
  const sortedUnattributed = [...unattributed].sort();
  const authorsDigest = sha256({
    authors: pairs,
    gaps: Object.fromEntries(
      Object.entries(gaps).map(([commit, value]) => [
        commit,
        {
          uncoveredEdits: value.uncoveredEdits,
          unresolvedSources: value.unresolvedSources,
        },
      ])
    ),
    unattributed: sortedUnattributed,
  });
  return {
    authors,
    authorsDigest,
    fullyCovered: unattributed.length === 0 && Object.keys(gaps).length === 0,
    gaps,
    unattributed: sortedUnattributed,
  };
};

/** Coverage of a commit range against the ledger as it stands now. */
export const headCoverage = (
  ledger: ReviewLedger,
  commits: readonly string[]
): HeadCoverage => computeCoverage(createResolver(ledger), commits);

// Derived fields are recomputed on every write, so a stored digest or own-gap
// snapshot never outlives the attestations it summarizes. Inherited gaps are
// not pruned: a remapped replay keeps them (only an attestation closes one).
const refreshDerivedRecords = (ledger: ReviewLedger): void => {
  const resolver = createResolver(ledger);
  for (const destination of Object.keys(ledger.replays)) {
    const record = ownValue(ledger.replays, destination) as ReplayRecord;
    record.ownGaps = resolver.ownGaps(destination) ?? record.ownGaps;
  }
  for (const proposal of Object.values(ledger.proposals)) {
    for (const head of Object.values(proposal.heads)) {
      const coverage = computeCoverage(resolver, head.commits);
      head.authorsDigest = coverage.authorsDigest;
      head.gaps = coverage.gaps;
      head.unattributed = coverage.unattributed;
    }
  }
};

const waiverCovers = (
  waiver: CoverageWaiver,
  coverage: HeadCoverage
): boolean =>
  coverage.unattributed.every((commit) =>
    waiver.unattributed.includes(commit)
  ) &&
  Object.entries(coverage.gaps).every(([commit, gaps]) => {
    const named = ownValue(waiver.gaps, commit);
    return (
      named !== undefined &&
      gaps.unresolvedSources.every((sha) =>
        named.unresolvedSources.includes(sha)
      ) &&
      gaps.uncoveredEdits.every((sha) => named.uncoveredEdits.includes(sha))
    );
  });

interface CoverageDecision {
  covered: boolean;
  waiver: CoverageWaiver | null;
}

/**
 * Condition (0): the head is fully covered, or a waiver bound to its current
 * digest names every unattributed commit and every open gap. Without a
 * waiver id the newest current waiver is consulted; an attempt passes the id
 * it recorded, and `null` means it referenced none.
 */
const coverageDecision = (
  head: ProposalHead,
  coverage: HeadCoverage,
  waiverId?: string | null
): CoverageDecision => {
  if (coverage.fullyCovered) {
    return { covered: true, waiver: null };
  }
  const current = head.waivers.filter(
    (item) => item.authorsDigest === coverage.authorsDigest
  );
  const waiver =
    waiverId === undefined
      ? (current.at(-1) ?? null)
      : (current.find((item) => item.waiverId === waiverId) ?? null);
  return {
    covered: waiver !== null && waiverCovers(waiver, coverage),
    waiver,
  };
};

/** The head `record-authors` recorded most recently for a proposal. */
export const latestRecordedHead = (proposal: ProposalRecord): string | null =>
  Object.keys(proposal.heads).at(-1) ?? null;

// ---------------------------------------------------------------------------
// Identity comparison

/**
 * Executor independence, the existing rule: a different instance (both
 * known) or a different session (both known). A background agent with its
 * own instance passes beside its parent's session. Logical ids, models and
 * harnesses are never consulted here.
 */
const executorIndependence = (
  reviewer: RuntimeIdentity,
  author: RuntimeIdentity
): "independent" | "same" | "unknown" => {
  const instanceDiffers =
    reviewer.instance !== null &&
    author.instance !== null &&
    reviewer.instance !== author.instance;
  const sessionDiffers =
    reviewer.session !== null &&
    author.session !== null &&
    reviewer.session !== author.session;
  if (instanceDiffers || sessionDiffers) {
    return "independent";
  }
  const instanceEqual =
    reviewer.instance !== null && reviewer.instance === author.instance;
  const sessionEqual =
    reviewer.session !== null && reviewer.session === author.session;
  return instanceEqual || sessionEqual ? "same" : "unknown";
};

/**
 * The model a runtime identity actually reported, or null. The
 * `most-capable` sentinel is a planning target, never a runtime model, so on
 * a reported identity it counts as missing evidence, like a blank name.
 */
const reportedModel = (agent: string | null): string | null =>
  agent === null || agent.trim() === "" || agent.trim() === MOST_CAPABLE
    ? null
    : agent;

const reportedHarness = (harness: string | null): string | null =>
  harness === null || harness.trim() === "" ? null : harness;

/**
 * Adversarial diversity between two reported identities: a different
 * harness id, or the same harness with a different reported model, is
 * distinct. Missing harness or model evidence on either side, the sentinel
 * included, is unknown, never distinct.
 */
const diversity = (
  reviewer: { agent: string | null; harness: string | null },
  author: { agent: string | null; harness: string | null }
): "distinct" | "same" | "unknown" => {
  const reviewerModel = reportedModel(reviewer.agent);
  const authorModel = reportedModel(author.agent);
  const reviewerHarness = reportedHarness(reviewer.harness);
  const authorHarness = reportedHarness(author.harness);
  if (!(reviewerHarness && reviewerModel && authorHarness && authorModel)) {
    return "unknown";
  }
  if (reviewerHarness !== authorHarness) {
    return "distinct";
  }
  return sameModelName(reviewerModel, authorModel) ? "same" : "distinct";
};

const uniqueAuthors = (coverage: HeadCoverage): Attestation[] => {
  const unique = new Map<string, Attestation>();
  for (const list of Object.values(coverage.authors)) {
    for (const author of list) {
      unique.set(identityKey(author), author);
    }
  }
  return [...unique.values()];
};

// ---------------------------------------------------------------------------
// Post-return gate and approval

export interface AcceptanceInput {
  adversarial: boolean;
  attempt: Pick<ReviewAttempt, "headRevision" | "verdict" | "verified">;
  currentHead: string;
  ledger: ReviewLedger;
  proposalId: string;
  repairRequired: boolean;
  /** The waiver an earlier attempt referenced; omit to use the newest. */
  waiverId?: string | null;
}

export interface AcceptanceDecision {
  acceptanceReason: AcceptanceReason | null;
  accepted: boolean;
  authorsDigest: string | null;
  coverage: HeadCoverage | null;
  coverageWaiverId: string | null;
}

const identityFailure = (
  input: AcceptanceInput,
  authors: Attestation[]
): AcceptanceReason | null => {
  const reviewer = input.attempt.verified;
  const executor = authors.map((author) =>
    executorIndependence(reviewer, author)
  );
  if (executor.includes("same")) {
    return "reviewer-not-independent";
  }
  if (executor.includes("unknown")) {
    return "independence-unproven";
  }
  if (!input.adversarial) {
    return null;
  }
  if (authors.length === 0) {
    return "no-effective-authors";
  }
  if (!(reportedHarness(reviewer.harness) && reportedModel(reviewer.agent))) {
    return "reviewer-identity-missing";
  }
  if (
    authors.some(
      (author) =>
        !(reportedHarness(author.harness) && reportedModel(author.agent))
    )
  ) {
    return "author-identity-missing";
  }
  return authors.every((author) => diversity(reviewer, author) === "distinct")
    ? null
    : "reviewer-not-distinct";
};

/**
 * The post-return gate. Acceptance is decided against the current head and
 * its current attestations: (0) coverage under either adversarial setting,
 * (a) executor independence from every effective author, always, and (b)
 * model or harness diversity from every effective author when adversarial.
 * Missing evidence for a test that applies rejects; a clean verdict is never
 * proof of independence.
 */
export const evaluateReviewAcceptance = (
  input: AcceptanceInput
): AcceptanceDecision => {
  const proposal = ownValue(input.ledger.proposals, input.proposalId);
  const head = proposal
    ? ownValue(proposal.heads, input.currentHead)
    : undefined;
  if (!(proposal && head)) {
    return {
      acceptanceReason: "authors-not-recorded",
      accepted: false,
      authorsDigest: null,
      coverage: null,
      coverageWaiverId: null,
    };
  }
  const coverage = headCoverage(input.ledger, head.commits);
  const decision = coverageDecision(head, coverage, input.waiverId);
  let reason: AcceptanceReason | null = null;
  if (input.repairRequired) {
    reason = "authoring-repair";
  } else if (
    latestRecordedHead(proposal) !== input.currentHead ||
    input.attempt.headRevision !== input.currentHead
  ) {
    reason = "stale-head";
  } else if (input.attempt.verdict === "failed") {
    reason = "review-failed";
  } else if (decision.covered) {
    reason = identityFailure(input, uniqueAuthors(coverage));
  } else {
    reason = "coverage-incomplete";
  }
  return {
    acceptanceReason: reason,
    accepted: reason === null,
    authorsDigest: coverage.authorsDigest,
    coverage,
    coverageWaiverId: decision.waiver?.waiverId ?? null,
  };
};

export interface FreshReviewEvidence {
  /** Required checks re-fetched and passing for this exact revision. */
  checks: boolean;
  /** Blocking discussions re-fetched and resolved. */
  discussions: boolean;
  /** Provider-side approval bound to this exact revision, when required. */
  providerApproval: boolean;
}

export interface ApprovalDecision {
  approved: boolean;
  attemptId: string | null;
  reasons: string[];
}

/** The newest attempt that still satisfies the ledger's half of approval. */
const reviewedAttempt = (
  input: Omit<AcceptanceInput, "attempt" | "waiverId">
): { attemptId: string | null; reason: string | null } => {
  const attempts =
    ownValue(input.ledger.proposals, input.proposalId)?.attempts ?? [];
  let reason = "no-accepted-clean-review";
  for (const attempt of [...attempts].reverse()) {
    if (
      !(
        attempt.accepted &&
        attempt.verdict === "clean" &&
        attempt.headRevision === input.currentHead
      )
    ) {
      continue;
    }
    const decision = evaluateReviewAcceptance({
      ...input,
      attempt,
      waiverId: attempt.coverageWaiverId,
    });
    if (decision.authorsDigest !== attempt.authorsDigest) {
      reason = "authors-digest-changed";
    } else if (decision.accepted) {
      return { attemptId: attempt.attemptId, reason: null };
    } else {
      reason = decision.acceptanceReason ?? reason;
    }
  }
  return { attemptId: null, reason };
};

/**
 * The approval predicate: one accepted clean attempt on the current head
 * whose digest equals the head's current digest, whose coverage still holds
 * with the waiver it referenced, and which passes the gate again now, plus
 * the existing fresh-evidence rules, which the ledger never replaces.
 */
export const reviewApproval = (
  input: Omit<AcceptanceInput, "attempt" | "waiverId"> & {
    freshEvidence: FreshReviewEvidence;
  }
): ApprovalDecision => {
  const reviewed = reviewedAttempt(input);
  const reasons = reviewed.reason ? [reviewed.reason] : [];
  if (!input.freshEvidence.checks) {
    reasons.push("checks-not-fresh");
  }
  if (!input.freshEvidence.discussions) {
    reasons.push("discussions-unresolved");
  }
  if (!input.freshEvidence.providerApproval) {
    reasons.push("provider-approval-missing");
  }
  return {
    approved: reasons.length === 0,
    attemptId: reviewed.attemptId,
    reasons,
  };
};

// ---------------------------------------------------------------------------
// Escalation and reviewer resolution before dispatch

/**
 * Escalation as a floor: after any attempt on the proposal reported
 * findings (accepted or not), later attempts run at the higher of the role's
 * effort and `escalateOnFindings`. It never lowers an effort and never
 * reaches `max` by itself; a request `max` is the agent's own choice.
 */
export const escalatedEffort = (
  roleEffort: AuthoringEffort,
  escalateOnFindings: "high" | "xhigh" | null,
  attempts: readonly Pick<ReviewAttempt, "verdict">[]
): { effort: AuthoringEffort; effortSource: "configured" | "escalation" } => {
  if (
    !(
      escalateOnFindings &&
      attempts.some((attempt) => attempt.verdict === "findings")
    )
  ) {
    return { effort: roleEffort, effortSource: "configured" };
  }
  const effort = higherEffort(roleEffort, escalateOnFindings);
  return {
    effort,
    effortSource: effort === roleEffort ? "configured" : "escalation",
  };
};

interface ReviewerTarget {
  agent: string | null;
  harness: string | null;
}

const targetDistinctness = (
  target: { harness: string; model: string },
  author: ReviewerTarget,
  provisional: boolean
): "distinct" | "same" | "unknown-author" | "unknown-model" => {
  // A provisional author is the configured `proposals` target, a plan that
  // may name the sentinel; a verified author is a reported runtime identity,
  // where the sentinel or a blank name is missing evidence.
  const authorModel = provisional ? author.agent : reportedModel(author.agent);
  const authorHarness = reportedHarness(author.harness);
  if (!(authorHarness && authorModel)) {
    return "unknown-author";
  }
  if (target.harness !== authorHarness) {
    return "distinct";
  }
  const targetSentinel = target.model === MOST_CAPABLE;
  const authorSentinel = authorModel === MOST_CAPABLE;
  if (targetSentinel || authorSentinel) {
    // Two `most-capable` targets in one harness resolve to the same model.
    return provisional && targetSentinel && authorSentinel
      ? "same"
      : "unknown-model";
  }
  return sameModelName(target.model, authorModel) ? "same" : "distinct";
};

const adversarialOutcome = (
  target: { harness: string; model: string },
  authors: ReviewerTarget[],
  provisional: boolean
): Pick<ReviewerResolution, "reason" | "status"> => {
  const verdicts = authors.map((author) =>
    targetDistinctness(target, author, provisional)
  );
  if (verdicts.includes("same")) {
    return { reason: "reviewer-not-distinct", status: "blocked" };
  }
  if (verdicts.includes("unknown-author")) {
    return { reason: "author-identity-missing", status: "unresolved" };
  }
  if (verdicts.includes("unknown-model")) {
    return { reason: "most-capable-unresolved", status: "unresolved" };
  }
  return { reason: null, status: "resolved" };
};

const resolveCommit = (cwd: string, value: string, option: string): string => {
  const candidate = value.trim().toLowerCase();
  if (!REVISION_INPUT_PATTERN.test(candidate)) {
    throw new SimpleChangesError(
      `${option} must be a commit SHA (7 to 64 hexadecimal characters).`,
      EXIT_CODES.usage
    );
  }
  const result = runGit(
    cwd,
    ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
    true
  );
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !isCommitSha(sha)) {
    throw new SimpleChangesError(
      `${option} ${value} is not a commit object in this repository.`,
      EXIT_CODES.validation
    );
  }
  return sha;
};

const requireProposalId = (value: string): string => {
  if (!isProposalId(value)) {
    throw new SimpleChangesError(
      "--proposal must be the provider's stable proposal id (letters, digits, and . _ : / # ! @ + -, at most 200 characters).",
      EXIT_CODES.usage
    );
  }
  return value;
};

const verifiedEvidence = (
  repositoryRoot: string,
  proposalId: string,
  headInput: string,
  adversarial: boolean,
  repairRequired: boolean
): {
  attempts: ReviewAttempt[];
  authors: Attestation[];
  evidence: ReviewerProposalEvidence;
  failure: ReviewerReason | null;
} => {
  const head = resolveCommit(repositoryRoot, headInput, "--head");
  const { commonGitDirectory } = locateRepository(repositoryRoot).repository;
  const state = readReviewLedger(commonGitDirectory);
  const evidence: ReviewerProposalEvidence = {
    authorsDigest: null,
    coverageWaiverId: null,
    fullyCovered: false,
    gaps: {},
    head,
    proposalId,
    reviewedAttemptId: null,
    unattributed: [],
  };
  if (state.reason) {
    return { attempts: [], authors: [], evidence, failure: state.reason };
  }
  const proposal = ownValue(state.ledger.proposals, proposalId);
  const record = proposal ? ownValue(proposal.heads, head) : undefined;
  const attempts = proposal?.attempts ?? [];
  if (!record) {
    return { attempts, authors: [], evidence, failure: "authors-not-recorded" };
  }
  const coverage = headCoverage(state.ledger, record.commits);
  const decision = coverageDecision(record, coverage);
  evidence.authorsDigest = coverage.authorsDigest;
  evidence.coverageWaiverId = decision.waiver?.waiverId ?? null;
  evidence.fullyCovered = coverage.fullyCovered;
  evidence.gaps = coverage.gaps;
  evidence.unattributed = coverage.unattributed;
  evidence.reviewedAttemptId = reviewedAttempt({
    adversarial,
    currentHead: head,
    ledger: state.ledger,
    proposalId,
    repairRequired,
  }).attemptId;
  return {
    attempts,
    authors: uniqueAuthors(coverage),
    evidence,
    failure: decision.covered ? null : "coverage-incomplete",
  };
};

/**
 * Resolves the `review` role before dispatch. Without a proposal it is a
 * provisional plan against the configured `proposals` target, never an
 * acceptance input. With `proposalId` and `head` it is verified against that
 * head's effective authors, resolved recursively at this moment, and
 * applies the coverage condition. Under `adversarial: false` no identity is
 * compared; independence is then enforced only after return.
 */
export const resolveReviewer = (input: {
  authoring: RepositoryAuthoring;
  head?: string;
  proposalId?: string;
  repositoryRoot: string;
}): ReviewerResolution => {
  if ((input.proposalId === undefined) !== (input.head === undefined)) {
    throw new SimpleChangesError(
      "--proposal and --head must be given together.",
      EXIT_CODES.usage
    );
  }
  // Every input is validated before any status is returned, so a caller
  // that changes state after resolving (a handoff releasing its claim)
  // never does so on a usage error.
  const target =
    input.proposalId === undefined || input.head === undefined
      ? null
      : {
          head: resolveCommit(input.repositoryRoot, input.head, "--head"),
          proposalId: requireProposalId(input.proposalId),
        };
  const { review } = input.authoring.effective;
  const mode = target === null ? "provisional" : "verified";
  const resolution: ReviewerResolution = {
    adversarial: review.adversarial,
    effort: null,
    effortSource: null,
    harness: null,
    mode,
    model: null,
    proposal: null,
    reason: null,
    status: "resolved",
  };
  if (input.authoring.repairRequired) {
    return { ...resolution, reason: "authoring-repair", status: "unresolved" };
  }
  let verified: ReturnType<typeof verifiedEvidence> | null = null;
  if (target) {
    verified = verifiedEvidence(
      input.repositoryRoot,
      target.proposalId,
      target.head,
      review.adversarial,
      input.authoring.repairRequired
    );
    resolution.proposal = verified.evidence;
  }
  const effort = escalatedEffort(
    review.effort,
    review.escalateOnFindings,
    verified?.attempts ?? []
  );
  resolution.effort = effort.effort;
  resolution.effortSource = effort.effortSource;
  resolution.model = review.model;
  // Failed detection is a status, never a harness string: a concrete harness
  // id may itself be spelled "unknown".
  if (review.status === "unresolved") {
    return {
      ...resolution,
      reason: "running-harness-unknown",
      status: "unresolved",
    };
  }
  resolution.harness = review.harness;
  if (review.status === "no-delegation") {
    return review.adversarial
      ? { ...resolution, reason: "reviewer-not-distinct", status: "blocked" }
      : { ...resolution, reason: "no-delegation", status: "unresolved" };
  }
  if (verified?.failure) {
    return { ...resolution, reason: verified.failure, status: "unresolved" };
  }
  if (!review.adversarial) {
    return resolution;
  }
  let authors: ReviewerTarget[];
  if (verified) {
    ({ authors } = verified);
  } else {
    const { proposals } = input.authoring.effective;
    if (proposals.status === "unresolved") {
      return {
        ...resolution,
        reason: "running-harness-unknown",
        status: "unresolved",
      };
    }
    authors = [{ agent: proposals.model, harness: proposals.harness }];
  }
  if (authors.length === 0) {
    return {
      ...resolution,
      reason: "no-effective-authors",
      status: "unresolved",
    };
  }
  return {
    ...resolution,
    ...adversarialOutcome(
      { harness: review.harness, model: review.model },
      authors,
      verified === null
    ),
  };
};

// ---------------------------------------------------------------------------
// Identity of the executing session

export interface ExecutingIdentityInput {
  /** The model name and version the executing harness reports. */
  agent?: string;
  environment?: Environment;
  /** Refused unless it equals the executing session's harness. */
  harness?: string;
  /** The runtime agent instance id the executing harness reports. */
  instance?: string;
  /** `--agent-id`; falls back to `AGENT_ID`. Never compared. */
  logicalId?: string;
  /** Refused unless it equals the executing session id. */
  session?: string;
}

interface ExecutingIdentity {
  identity: RuntimeIdentity;
  logicalId: string | null;
}

const optionalValue = (
  value: string | undefined,
  valid: (candidate: unknown) => boolean,
  option: string
): string | null => {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!valid(trimmed)) {
    throw new SimpleChangesError(`${option} is not valid.`, EXIT_CODES.usage);
  }
  return trimmed;
};

/**
 * Session and harness come only from the executing process's environment
 * through the session adapter; an argument that disagrees is refused, so an
 * agent can attest only as the session it runs in. Instance and agent are
 * what the harness reported to the agent, recorded `null` when absent.
 */
const executingIdentity = (
  input: ExecutingIdentityInput
): ExecutingIdentity => {
  const environment = input.environment ?? process.env;
  const session = currentHarnessSession(environment);
  const sessionId = session?.sessionId ?? null;
  const harness = session?.harness ?? null;
  if (input.session !== undefined && input.session.trim() !== sessionId) {
    throw new SimpleChangesError(
      `--session ${input.session} disagrees with the executing session (${sessionId ?? "none reported"}); the session is read from the executing process only.`,
      EXIT_CODES.unsafe
    );
  }
  if (input.harness !== undefined && input.harness.trim() !== harness) {
    throw new SimpleChangesError(
      `--harness ${input.harness} disagrees with the executing harness (${harness ?? "none reported"}); the harness is read from the executing process only.`,
      EXIT_CODES.unsafe
    );
  }
  const logical = (input.logicalId ?? environment.AGENT_ID)?.trim() || null;
  if (logical !== null && !isLogicalId(logical)) {
    throw new SimpleChangesError(
      "The agent id must be at most 128 characters without control characters.",
      EXIT_CODES.usage
    );
  }
  return {
    identity: {
      agent: optionalValue(input.agent, isModelName, "--agent"),
      harness,
      instance: optionalValue(input.instance, isToken, "--instance"),
      session: sessionId,
    },
    logicalId: logical,
  };
};

// ---------------------------------------------------------------------------
// author attest

export interface AuthorAttestInput extends ExecutingIdentityInput {
  commits: readonly string[];
  contribution?: "implementation";
  replays?: readonly string[];
  repositoryPath: string;
  /** A controller replay: the released or handed-off delegated worktree. */
  worktreePath?: string;
}

export interface ReplayCheck {
  detail: string;
  orderedSources: string[];
  verification: "verified" | "inconclusive";
}

export interface AuthorAttestResult {
  attestations: Array<{
    commit: string;
    status: "recorded" | "unchanged" | "not-attested";
  }>;
  eligibility: {
    basis: "claim" | "registration" | "controller-replay";
    worktree: string;
  };
  identity: RuntimeIdentity & { logicalId: string };
  ledgerPath: string;
  replay: {
    destination: string;
    detail: string;
    inheritedGaps: CommitGaps;
    ownGaps: ReplayRecord["ownGaps"];
    sources: string[];
    status: "recorded" | "unchanged" | "superseded";
    verification: "verified" | "inconclusive";
  } | null;
}

interface EligibleWorktree {
  basis: AuthorAttestResult["eligibility"]["basis"];
  path: string;
  tip: string;
}

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const worktreeTip = (
  inventory: RepositoryInventory,
  path: string,
  recordedBranch: string | null
): string | null => {
  const worktree = inventory.worktrees.find((item) => item.path === path);
  const branch = worktree ? worktree.branch : recordedBranch;
  if (branch) {
    return `refs/heads/${branch}`;
  }
  return worktree?.headSha ?? null;
};

const controllerReplayWorktree = (
  inventory: RepositoryInventory,
  lease: LoopLease | null,
  coordination: WorktreeCoordinationDocument,
  logicalId: string,
  worktreePath: string
): EligibleWorktree => {
  if (
    !(
      lease &&
      lease.ownerAgentId === logicalId &&
      (lease.controller?.status ?? "active") === "active"
    )
  ) {
    throw new SimpleChangesError(
      "--worktree is accepted only from the active loop's own controller, refreshing delegated work it holds the loop for.",
      EXIT_CODES.unsafe
    );
  }
  const path = canonicalPath(worktreePath);
  const registration = lease.worktrees.find((item) => item.path === path);
  if (!registration || registration.role === "controller") {
    throw new SimpleChangesError(
      `${path} is not a delegated worktree registered in run ${lease.runId}.`,
      EXIT_CODES.unsafe
    );
  }
  const claims = coordination.claims.filter((claim) => claim.path === path);
  const live = claims.find((claim) => !ENDED_CLAIM_STATES.has(claim.state));
  if (live) {
    throw new SimpleChangesError(
      `${path} is still claimed by ${live.owner.agentId}; refresh and attest it only after that claim is released or handed off.`,
      EXIT_CODES.unsafe
    );
  }
  const handedBack = claims.some(
    (claim) =>
      claim.state === "released" &&
      HANDED_BACK_RELEASES.has(claim.releaseReason ?? "")
  );
  // A run-prepared author worktree carries no claim: its agent's return is
  // reported to the controller, not recorded here. That return is the
  // enforcement boundary for a prepared worktree; a claimed one must show a
  // release or handoff.
  if (!(handedBack || registration.role === "author")) {
    throw new SimpleChangesError(
      `${path} has no released or handed-off claim; a controller replay needs one.`,
      EXIT_CODES.unsafe
    );
  }
  const tip = worktreeTip(inventory, path, registration.branch);
  if (!tip) {
    throw new SimpleChangesError(
      `${path} has no branch or commit to check the replay against.`,
      EXIT_CODES.unsafe
    );
  }
  return { basis: "controller-replay", path, tip };
};

const authorWorktrees = (
  inventory: RepositoryInventory,
  lease: LoopLease | null,
  coordination: WorktreeCoordinationDocument,
  logicalId: string
): EligibleWorktree[] => {
  const eligible: EligibleWorktree[] = [];
  for (const claim of coordination.claims) {
    if (
      claim.owner.agentId === logicalId &&
      !ENDED_CLAIM_STATES.has(claim.state)
    ) {
      const tip = worktreeTip(inventory, claim.path, claim.branch);
      if (tip) {
        eligible.push({ basis: "claim", path: claim.path, tip });
      }
    }
  }
  for (const registration of lease?.worktrees ?? []) {
    if (
      registration.agentId === logicalId &&
      (registration.role === "author" || registration.role === "controller")
    ) {
      const tip = worktreeTip(
        inventory,
        registration.path,
        registration.branch
      );
      if (tip) {
        eligible.push({ basis: "registration", path: registration.path, tip });
      }
    }
  }
  if (eligible.length === 0) {
    throw new SimpleChangesError(
      `Agent ${logicalId} holds no live worktree claim and is not the registered agent of a prepared worktree, so it cannot attest commits. Claim the worktree it works in, or use the agent id prepare-agent registered.`,
      EXIT_CODES.unsafe
    );
  }
  return eligible;
};

const isAncestor = (
  cwd: string,
  ancestor: string,
  descendant: string
): boolean => {
  const result = runGit(
    cwd,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    true
  );
  if (result.exitCode === 0 || result.exitCode === 1) {
    return result.exitCode === 0;
  }
  throw new SimpleChangesError(
    `Could not compare ${ancestor} with ${descendant}: ${result.stderr.trim()}`,
    EXIT_CODES.inventory
  );
};

/**
 * The commits an attestation may never cover: the run's pinned baseline
 * target and the target as it stands now. No timestamp is consulted.
 */
const baselineRevisions = (
  cwd: string,
  inventory: RepositoryInventory,
  lease: LoopLease | null
): string[] => {
  const revisions = new Set<string>();
  if (lease) {
    revisions.add(lease.targetRevision);
  }
  if (!inventory.targetRef.startsWith("-")) {
    const target = runGit(
      cwd,
      ["rev-parse", "--verify", "--quiet", `${inventory.targetRef}^{commit}`],
      true
    );
    const sha = target.stdout.trim();
    if (target.exitCode === 0 && isCommitSha(sha)) {
      revisions.add(sha);
    }
  }
  return [...revisions];
};

const eligibleWorktreeFor = (
  cwd: string,
  commit: string,
  candidates: readonly EligibleWorktree[],
  baselines: readonly string[]
): EligibleWorktree => {
  const contained = baselines.find((baseline) =>
    isAncestor(cwd, commit, baseline)
  );
  if (contained) {
    throw new SimpleChangesError(
      `${commit} is already contained in the pinned baseline target ${contained}; only new commits can be attested.`,
      EXIT_CODES.unsafe
    );
  }
  const owner = candidates.find((candidate) =>
    isAncestor(cwd, commit, candidate.tip)
  );
  if (!owner) {
    throw new SimpleChangesError(
      `${commit} is not reachable from any worktree this agent may attest for (${candidates.map((candidate) => candidate.path).join(", ")}).`,
      EXIT_CODES.unsafe
    );
  }
  return owner;
};

const commitParents = (cwd: string, commit: string): string[] =>
  runGit(cwd, ["rev-list", "--parents", "--max-count=1", commit])
    .stdout.trim()
    .split(" ")
    .slice(1)
    .filter(Boolean);

const firstParentChain = (
  sources: readonly string[],
  parents: ReadonlyMap<string, string[]>
): string[] | null => {
  const members = new Set(sources);
  const roots = sources.filter(
    (source) => !members.has(parents.get(source)?.[0] ?? "")
  );
  const [root] = roots;
  if (roots.length !== 1 || root === undefined) {
    return null;
  }
  const childOf = new Map<string, string>();
  for (const source of sources) {
    const parent = parents.get(source)?.[0];
    if (parent && members.has(parent)) {
      if (childOf.has(parent)) {
        return null;
      }
      childOf.set(parent, source);
    }
  }
  const ordered = [root];
  let next = childOf.get(root);
  while (next !== undefined) {
    ordered.push(next);
    next = childOf.get(next);
  }
  return ordered.length === sources.length ? ordered : null;
};

// The exact diff of a commit against its first parent: full blob ids, binary
// patches, no rename detection, no external or text-conversion drivers, and
// fixed prefixes, captured as bytes so no encoding step can alter it.
const exactPatch = (
  cwd: string,
  parent: string,
  commit: string
): Uint8Array | null => {
  const result = spawnSync(
    [
      gitExecutable(),
      "-C",
      cwd,
      "diff-tree",
      "-p",
      "--full-index",
      "--binary",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      parent,
      commit,
    ],
    { env: { ...process.env, LC_ALL: "C" }, stderr: "pipe", stdout: "pipe" }
  );
  return result.exitCode === 0 ? result.stdout : null;
};

const firstParentTree = (cwd: string, commit: string): string => {
  const [parent] = commitParents(cwd, commit);
  return parent
    ? `${parent}^{tree}`
    : runGitWithInput(
        cwd,
        ["hash-object", "-t", "tree", "--stdin"],
        ""
      ).stdout.trim();
};

const applyPatches = (
  cwd: string,
  directory: string,
  destination: string,
  patches: readonly string[],
  ordered: readonly string[]
): { detail: string; verified: boolean } => {
  const environment = { GIT_INDEX_FILE: join(directory, "index") };
  runGit(
    cwd,
    ["read-tree", firstParentTree(cwd, destination)],
    false,
    environment
  );
  for (const [index, patch] of patches.entries()) {
    const applied = runGit(
      cwd,
      [
        "-c",
        "apply.ignoreWhitespace=no",
        "apply",
        "--cached",
        "--whitespace=nowarn",
        patch,
      ],
      true,
      environment
    );
    if (applied.exitCode !== 0) {
      return {
        detail: `the exact diff of ${ordered[index]} does not apply cleanly to ${destination}'s first parent`,
        verified: false,
      };
    }
  }
  const tree = runGit(cwd, ["write-tree"], false, environment).stdout.trim();
  const expected = runGit(cwd, [
    "rev-parse",
    "--verify",
    `${destination}^{tree}`,
  ]).stdout.trim();
  return tree === expected
    ? {
        detail: `the sources' exact diffs rebuild ${destination}'s tree`,
        verified: true,
      }
    : {
        detail: `the rebuilt tree ${tree} differs from ${destination}'s tree ${expected}`,
        verified: false,
      };
};

/**
 * Exact, whitespace-preserving replay verification. Starting from the
 * destination's first-parent tree in a temporary index, each source's exact
 * diff against its own first parent is applied in first-parent order; the
 * replay is verified only when every patch applies and the rebuilt tree
 * equals the destination's tree. A merge, a root commit, a non-contiguous
 * set, an empty diff, or any apply failure is inconclusive.
 */
export const verifyReplay = (
  cwd: string,
  destination: string,
  sources: readonly string[]
): ReplayCheck => {
  const inconclusive = (
    detail: string,
    sequence: readonly string[] = [...sources].sort()
  ): ReplayCheck => ({
    detail,
    orderedSources: [...sequence],
    verification: "inconclusive",
  });
  const parents = new Map(
    sources.map((source) => [source, commitParents(cwd, source)])
  );
  for (const [source, list] of parents) {
    if (list.length !== 1) {
      return inconclusive(
        `unsupported: ${source} is ${list.length > 1 ? "a merge commit" : "a root commit"}`
      );
    }
  }
  const ordered = firstParentChain(sources, parents);
  if (!ordered) {
    return inconclusive(
      "unsupported: the sources are not one contiguous first-parent sequence"
    );
  }
  const directory = mkdtempSync(join(tmpdir(), "simple-changes-replay-"));
  try {
    const patches: string[] = [];
    for (const [index, source] of ordered.entries()) {
      const patch = exactPatch(cwd, parents.get(source)?.[0] ?? "", source);
      if (!patch || patch.length === 0) {
        return inconclusive(
          `unsupported: ${source} has ${patch ? "an empty diff" : "no readable diff"}`,
          ordered
        );
      }
      const path = join(directory, `${index}.patch`);
      writeFileSync(path, patch);
      patches.push(path);
    }
    const outcome = applyPatches(cwd, directory, destination, patches, ordered);
    return outcome.verified
      ? {
          detail: outcome.detail,
          orderedSources: ordered,
          verification: "verified",
        }
      : inconclusive(outcome.detail, ordered);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

/** Whether `target` is reachable from `start` through recorded replays. */
const replayReaches = (
  ledger: ReviewLedger,
  start: string,
  target: string
): boolean => {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === target) {
      return true;
    }
    for (const source of ownValue(ledger.replays, current)?.sources ?? []) {
      if (!seen.has(source)) {
        seen.add(source);
        stack.push(source);
      }
    }
  }
  return false;
};

const replaySources = (
  cwd: string,
  ledger: ReviewLedger,
  destination: string,
  inputs: readonly string[]
): string[] => {
  const sources = inputs.map((source) =>
    resolveCommit(cwd, source, "--replays")
  );
  if (sources.length === 0) {
    throw new SimpleChangesError(
      "--replays needs at least one source.",
      EXIT_CODES.usage
    );
  }
  if (new Set(sources).size !== sources.length) {
    throw new SimpleChangesError(
      "--replays names a source more than once.",
      EXIT_CODES.usage
    );
  }
  assertKeepsSources(ledger, destination, sources);
  for (const source of sources) {
    if (source === destination || replayReaches(ledger, source, destination)) {
      throw new SimpleChangesError(
        `replay-cycle: ${destination} is already reachable from ${source} through recorded replays (a commit cannot replay itself); link two commits in one direction only.`,
        EXIT_CODES.validation
      );
    }
  }
  return sources;
};

const appendAttestation = (
  ledger: ReviewLedger,
  commit: string,
  attestation: Attestation
): "recorded" | "unchanged" => {
  const list = ownValue(ledger.attestations, commit) ?? [];
  const key = identityKey(attestation);
  if (list.some((existing) => identityKey(existing) === key)) {
    return "unchanged";
  }
  ledger.attestations[commit] = [...list, attestation];
  return "recorded";
};

const unionGaps = (...lists: CommitGaps[]): CommitGaps =>
  sortedGaps(
    lists.flatMap((gaps) => gaps.unresolvedSources),
    lists.flatMap((gaps) => gaps.uncoveredEdits)
  );

/**
 * A corrected mapping may add sources but never drop one an earlier record
 * for the destination named: effective authors follow the current links, so
 * dropping a source would remove its implementers from every descendant's
 * gate. The record keeps one source list, so the safe default is to refuse.
 */
const assertKeepsSources = (
  ledger: ReviewLedger,
  destination: string,
  sources: readonly string[]
): void => {
  const dropped = (ownValue(ledger.replays, destination)?.sources ?? []).filter(
    (source) => !sources.includes(source)
  );
  if (dropped.length > 0) {
    throw new SimpleChangesError(
      `replay-correction-drops-source: ${destination} already replays ${dropped.join(", ")}; a corrected mapping may add sources but never drop one, because dropping it would remove its authors from every later replay. Name every earlier source again.`,
      EXIT_CODES.validation
    );
  }
};

/**
 * Writes the destination's replay record. An identical mapping (sources and
 * verification) is a no-op; a corrected one may only add sources, and it
 * supersedes the destination's own verification and own gaps but keeps
 * every inherited gap it had.
 */
export const applyReplayRecord = (
  ledger: ReviewLedger,
  destination: string,
  check: ReplayCheck,
  recordedAt: string
): NonNullable<AuthorAttestResult["replay"]> => {
  const existing = ownValue(ledger.replays, destination);
  const sources = check.orderedSources;
  assertKeepsSources(ledger, destination, sources);
  const resolver = createResolver(ledger);
  const unchanged =
    existing !== undefined &&
    existing.verification === check.verification &&
    JSON.stringify(existing.sources) === JSON.stringify(sources);
  if (!unchanged) {
    const inheritedGaps = unionGaps(
      ...sources.map((source) => resolver.gaps(source)),
      existing?.inheritedGaps ?? sortedGaps([], [])
    );
    ledger.replays[destination] = {
      inheritedGaps,
      ownGaps: { uncoveredEdit: false, unresolvedSources: [] },
      recordedAt,
      sources,
      verification: check.verification,
    };
  }
  const record = ownValue(ledger.replays, destination) as ReplayRecord;
  record.ownGaps =
    createResolver(ledger).ownGaps(destination) ?? record.ownGaps;
  let status: "recorded" | "unchanged" | "superseded" = "recorded";
  if (unchanged) {
    status = "unchanged";
  } else if (existing) {
    status = "superseded";
  }
  return {
    destination,
    detail: check.detail,
    inheritedGaps: record.inheritedGaps,
    ownGaps: record.ownGaps,
    sources,
    status,
    verification: record.verification,
  };
};

const assertAttestInput = (input: AuthorAttestInput): void => {
  if (input.commits.length === 0) {
    throw new SimpleChangesError(
      "author attest needs at least one --commit.",
      EXIT_CODES.usage
    );
  }
  if (input.replays !== undefined && input.commits.length !== 1) {
    throw new SimpleChangesError(
      "--replays maps one destination commit: pass exactly one --commit with it.",
      EXIT_CODES.usage
    );
  }
  if (input.worktreePath !== undefined && input.replays === undefined) {
    throw new SimpleChangesError(
      "--worktree is only for a controller replay: pass --replays with it.",
      EXIT_CODES.usage
    );
  }
};

/**
 * `author attest`: the agent that made a commit records, immediately and in
 * its own session, that it wrote that commit's implementation. With
 * `--replays` the command instead links a rewritten commit to its sources
 * and verifies the replay; the replayer is added only when it also attests
 * `--contribution implementation`. Nothing is copied between commits.
 */
export const attestCommits = (input: AuthorAttestInput): AuthorAttestResult => {
  assertAttestInput(input);
  const { identity, logicalId } = executingIdentity(input);
  if (!logicalId) {
    throw new SimpleChangesError(
      "author attest needs the executing agent's id: pass --agent-id or set AGENT_ID.",
      EXIT_CODES.usage
    );
  }
  const cwd = input.repositoryPath;
  const { commonGitDirectory } = locateRepository(cwd).repository;
  return withLedgerTransaction(
    commonGitDirectory,
    "author attest",
    (ledger) => {
      const inventory = captureInventory(cwd);
      const lease = readLeaseFromCommonDirectory(commonGitDirectory);
      const coordination =
        readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
      const commits = [
        ...new Set(
          input.commits.map((commit) => resolveCommit(cwd, commit, "--commit"))
        ),
      ];
      const candidates =
        input.worktreePath === undefined
          ? authorWorktrees(inventory, lease, coordination, logicalId)
          : [
              controllerReplayWorktree(
                inventory,
                lease,
                coordination,
                logicalId,
                input.worktreePath
              ),
            ];
      const baselines = baselineRevisions(cwd, inventory, lease);
      const owners = commits.map((commit) =>
        eligibleWorktreeFor(cwd, commit, candidates, baselines)
      );
      const [destination] = commits;
      const sources =
        input.replays && destination
          ? replaySources(cwd, ledger, destination, input.replays)
          : null;
      const recordedAt = new Date().toISOString();
      const attestation: Attestation = { ...identity, logicalId, recordedAt };
      const attestations = commits.map((commit) => ({
        commit,
        status:
          sources && !input.contribution
            ? ("not-attested" as const)
            : appendAttestation(ledger, commit, attestation),
      }));
      const replay =
        sources && destination
          ? applyReplayRecord(
              ledger,
              destination,
              verifyReplay(cwd, destination, sources),
              recordedAt
            )
          : null;
      const owner = owners[0] as EligibleWorktree;
      return {
        attestations,
        eligibility: { basis: owner.basis, worktree: owner.path },
        identity: { ...identity, logicalId },
        ledgerPath: reviewLedgerPath(commonGitDirectory),
        replay,
      };
    }
  );
};

// ---------------------------------------------------------------------------
// proposal record-authors

export interface RecordAuthorsInput extends ExecutingIdentityInput {
  base: string;
  /** The parsed `--receipt` JSON: `{ "copyAuthors": [...] }`. */
  copyAuthorsReceipt?: unknown;
  head: string;
  proposalId: string;
  repositoryPath: string;
}

export interface RecordAuthorsResult {
  authorsDigest: string;
  base: string;
  commits: string[];
  copyAuthors: CopyAuthor[];
  fullyCovered: boolean;
  gaps: Record<string, CommitGaps>;
  head: string;
  ledgerPath: string;
  proposalId: string;
  status: "recorded" | "updated" | "unchanged";
  unattributed: string[];
}

const receiptIdentityValue = (
  entry: Record<string, unknown>,
  key: (typeof IDENTITY_KEYS)[number],
  path: string
): string | null => {
  const value = entry[key];
  if (value === undefined || value === null) {
    return null;
  }
  const valid = {
    agent: isModelName,
    harness: isHarnessId,
    instance: isToken,
    session: isToken,
  }[key](value);
  if (!valid) {
    throw new SimpleChangesError(
      `${path}.${key} is not valid.`,
      EXIT_CODES.validation
    );
  }
  return value as string;
};

const parseCopyAuthor = (
  entry: unknown,
  path: string,
  executing: RuntimeIdentity,
  recordedAt: string
): CopyAuthor => {
  if (!isRecord(entry)) {
    throw new SimpleChangesError(
      `${path} must be an object.`,
      EXIT_CODES.validation
    );
  }
  const unknown = Object.keys(entry).filter(
    (key) => !["source", ...IDENTITY_KEYS].includes(key)
  );
  if (
    unknown.length > 0 ||
    !(entry.source === "direct" || entry.source === "delegated")
  ) {
    throw new SimpleChangesError(
      `${path} must hold source (direct or delegated) and only instance, session, harness and agent.`,
      EXIT_CODES.validation
    );
  }
  const reported = Object.fromEntries(
    IDENTITY_KEYS.map((key) => [key, receiptIdentityValue(entry, key, path)])
  ) as unknown as RuntimeIdentity;
  if (entry.source === "delegated") {
    // Every field as the delegate reported it; never the executing session's.
    return { ...reported, recordedAt, source: "delegated" };
  }
  for (const key of IDENTITY_KEYS) {
    if (Object.hasOwn(entry, key) && reported[key] !== executing[key]) {
      throw new SimpleChangesError(
        `${path}.${key} disagrees with the executing session; a direct copy author is the executing session itself.`,
        EXIT_CODES.unsafe
      );
    }
  }
  return { ...executing, recordedAt, source: "direct" };
};

const parseCopyAuthors = (
  receipt: unknown,
  executing: RuntimeIdentity,
  recordedAt: string
): CopyAuthor[] => {
  if (receipt === undefined) {
    return [];
  }
  if (
    !(
      isRecord(receipt) &&
      Object.keys(receipt).every((key) => key === "copyAuthors") &&
      Array.isArray(receipt.copyAuthors)
    )
  ) {
    throw new SimpleChangesError(
      'The record-authors receipt must be { "copyAuthors": [...] }; it may add copy authors only.',
      EXIT_CODES.validation
    );
  }
  return receipt.copyAuthors.map((entry, index) =>
    parseCopyAuthor(entry, `copyAuthors[${index}]`, executing, recordedAt)
  );
};

const mergeCopyAuthors = (
  existing: readonly CopyAuthor[],
  added: readonly CopyAuthor[]
): CopyAuthor[] => {
  const merged = [...existing];
  const keys = new Set(
    existing.map((author) => `${author.source}${identityKey(author)}`)
  );
  for (const author of added) {
    const key = `${author.source}${identityKey(author)}`;
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(author);
    }
  }
  return merged;
};

const rangeCommits = (cwd: string, base: string, head: string): string[] => {
  if (base === head) {
    throw new SimpleChangesError(
      "--base and --head are the same commit; the proposal range is empty.",
      EXIT_CODES.usage
    );
  }
  if (!isAncestor(cwd, base, head)) {
    throw new SimpleChangesError(
      `--base ${base} is not an ancestor of --head ${head}.`,
      EXIT_CODES.validation
    );
  }
  const commits = runGit(cwd, [
    "rev-list",
    "--reverse",
    "--topo-order",
    `${base}..${head}`,
  ])
    .stdout.split(LINE_SEPARATOR)
    .filter(Boolean);
  if (commits.length > MAX_RANGE_COMMITS) {
    throw new SimpleChangesError(
      `The range holds ${commits.length} commits, more than ${MAX_RANGE_COMMITS}; check --base.`,
      EXIT_CODES.validation
    );
  }
  return commits;
};

/**
 * `proposal record-authors`: binds a proposal head to the effective authors
 * of every commit in its pinned range, lists unattributed commits and gaps,
 * and computes the authors digest. Idempotent per (proposal, head); the most
 * recently recorded head is the proposal's current head for the ledger.
 */
export const recordProposalAuthors = (
  input: RecordAuthorsInput
): RecordAuthorsResult => {
  const proposalId = requireProposalId(input.proposalId);
  const { identity } = executingIdentity(input);
  const cwd = input.repositoryPath;
  const { commonGitDirectory } = locateRepository(cwd).repository;
  const recordedAt = new Date().toISOString();
  const added = parseCopyAuthors(
    input.copyAuthorsReceipt,
    identity,
    recordedAt
  );
  return withLedgerTransaction(
    commonGitDirectory,
    "proposal record-authors",
    (ledger) => {
      const base = resolveCommit(cwd, input.base, "--base");
      const head = resolveCommit(cwd, input.head, "--head");
      const commits = rangeCommits(cwd, base, head);
      const proposal = ownValue(ledger.proposals, proposalId) ?? {
        attempts: [],
        heads: {},
      };
      ledger.proposals[proposalId] = proposal;
      const existing = ownValue(proposal.heads, head);
      const copyAuthors = mergeCopyAuthors(existing?.copyAuthors ?? [], added);
      const coverage = headCoverage(ledger, commits);
      const entry: ProposalHead = {
        authorsDigest: coverage.authorsDigest,
        base,
        commits,
        copyAuthors,
        gaps: coverage.gaps,
        unattributed: coverage.unattributed,
        waivers: existing?.waivers ?? [],
      };
      let status: RecordAuthorsResult["status"] = "recorded";
      if (existing) {
        status =
          JSON.stringify(existing) === JSON.stringify(entry) &&
          latestRecordedHead(proposal) === head
            ? "unchanged"
            : "updated";
      }
      // Re-inserting moves the head to the end: the latest recorded head.
      Reflect.deleteProperty(proposal.heads, head);
      proposal.heads[head] = entry;
      return {
        authorsDigest: coverage.authorsDigest,
        base,
        commits,
        copyAuthors,
        fullyCovered: coverage.fullyCovered,
        gaps: coverage.gaps,
        head,
        ledgerPath: reviewLedgerPath(commonGitDirectory),
        proposalId,
        status,
        unattributed: coverage.unattributed,
      };
    }
  );
};

// ---------------------------------------------------------------------------
// proposal record-review

export interface RecordReviewInput {
  attemptId: string;
  /** Resolved from the primary checkout's sidecars when omitted. */
  authoring?: Pick<RepositoryAuthoring, "effective" | "repairRequired">;
  head: string;
  proposalId: string;
  /** The parsed `--receipt` JSON describing the returned review. */
  receipt: unknown;
  repositoryPath: string;
  /**
   * The validated `--authoring-request` object: the request layer for this
   * acceptance only (design 2.3 rule 6). It can make the gate adversarial
   * for a run-only answer and never loosens the saved settings.
   */
  request?: AuthoringSidecar;
}

export interface ReviewDisclosure {
  fields: Array<"harness" | "model">;
  message: string | null;
  mismatch: boolean;
}

export interface RecordReviewResult {
  /** The attempt still counts now and its verdict is clean. */
  approvalCandidate: boolean;
  /** The attempt as recorded: `accepted` is its acceptance at that time. */
  attempt: ReviewAttempt;
  /**
   * Whether the attempt counts now, against the proposal's current head,
   * digest, coverage and settings. A retry of a stale attempt reports why it
   * no longer counts; the stored attempt never changes.
   */
  currentValidity: { reason: string | null; valid: boolean };
  disclosure: ReviewDisclosure;
  ledgerPath: string;
  status: "recorded" | "unchanged";
}

type AttemptPayload = Pick<
  ReviewAttempt,
  | "effort"
  | "effortSource"
  | "findingsCount"
  | "requested"
  | "verdict"
  | "verified"
>;

const ATTEMPT_RECEIPT_KEYS = [
  "effort",
  "effortSource",
  "findingsCount",
  "requested",
  "verdict",
  "verified",
] as const;

const parseAttemptReceipt = (receipt: unknown): AttemptPayload => {
  const checker = new Checker();
  if (!checker.object(receipt, "receipt")) {
    throw new SimpleChangesError(
      "The record-review receipt must be a JSON object.",
      EXIT_CODES.validation
    );
  }
  checker.keys(receipt, ATTEMPT_RECEIPT_KEYS, "receipt");
  checkRequested(checker, receipt.requested, "receipt.requested");
  if (checker.object(receipt.verified, "receipt.verified")) {
    checker.keys(receipt.verified, IDENTITY_KEYS, "receipt.verified");
    checker.identity(receipt.verified, "receipt.verified");
  }
  checker.check(isEffort(receipt.effort), "receipt.effort", "is invalid");
  checker.check(
    receipt.effortSource === "configured" ||
      receipt.effortSource === "request" ||
      (receipt.effortSource === "escalation" &&
        ESCALATION_EFFORTS.has(receipt.effort as AuthoringEffort)),
    "receipt.effortSource",
    "must be configured, request, or escalation (high or xhigh only)"
  );
  checkAttemptOutcome(
    checker,
    {
      ...receipt,
      acceptanceReason: null,
      accepted: true,
      coverageWaiverId: null,
    },
    "receipt"
  );
  if (checker.errors.length > 0) {
    throw new SimpleChangesError(
      `Invalid record-review receipt: ${checker.errors.join("; ")}`,
      EXIT_CODES.validation
    );
  }
  const verified = receipt.verified as Record<string, unknown>;
  return {
    effort: receipt.effort as AuthoringEffort,
    effortSource: receipt.effortSource as ReviewEffortSource,
    findingsCount: receipt.findingsCount as number,
    requested: receipt.requested as ReviewAttempt["requested"],
    verdict: receipt.verdict as ReviewVerdict,
    verified: {
      agent: verified.agent as string | null,
      harness: verified.harness as string | null,
      instance: verified.instance as string | null,
      session: verified.session as string | null,
    },
  };
};

const attemptPayloadKey = (
  proposalId: string,
  head: string,
  payload: AttemptPayload
): string =>
  JSON.stringify([
    proposalId,
    head,
    payload.requested.harness,
    payload.requested.model,
    payload.requested.effort,
    payload.verified.instance,
    payload.verified.session,
    payload.verified.harness,
    payload.verified.agent,
    payload.effort,
    payload.effortSource,
    payload.verdict,
    payload.findingsCount,
  ]);

/**
 * The requested target and the verified result are separate records; a
 * mismatch is disclosed and the gate, not the request, decides acceptance.
 */
export const reviewDisclosure = (
  attempt: Pick<ReviewAttempt, "requested" | "verified">
): ReviewDisclosure => {
  const fields: ReviewDisclosure["fields"] = [];
  const reported = reportedModel(attempt.verified.agent);
  if (attempt.verified.harness !== attempt.requested.harness) {
    fields.push("harness");
  }
  if (
    reported === null ||
    attempt.requested.model === MOST_CAPABLE ||
    !sameModelName(attempt.requested.model, reported)
  ) {
    fields.push("model");
  }
  return {
    fields,
    message:
      fields.length === 0
        ? null
        : `Requested ${attempt.requested.model} in ${attempt.requested.harness}; the reviewer reported ${attempt.verified.agent ?? "no model"} in ${attempt.verified.harness ?? "no harness"}.`,
    mismatch: fields.length > 0,
  };
};

/**
 * The name a review signature uses: the model the reviewer reported, never
 * the setting. Null when it reported none, or only the sentinel.
 */
export const reviewSignatureAgent = (
  attempt: Pick<ReviewAttempt, "verified">
): string | null => reportedModel(attempt.verified.agent);

const findAttempt = (
  ledger: ReviewLedger,
  attemptId: string
): { attempt: ReviewAttempt; proposalId: string } | null => {
  for (const [proposalId, proposal] of Object.entries(ledger.proposals)) {
    const attempt = proposal.attempts.find(
      (item) => item.attemptId === attemptId
    );
    if (attempt) {
      return { attempt, proposalId };
    }
  }
  return null;
};

/**
 * `proposal record-review`: records a returned review as an attempt with its
 * requested target, verified identity, verdict and findings count, then runs
 * the post-return gate and records acceptance separately. Idempotent on
 * `attemptId`: an identical payload is a no-op and a different payload under
 * the same id is refused as a conflict.
 */
export const recordReviewAttempt = (
  input: RecordReviewInput
): RecordReviewResult => {
  const proposalId = requireProposalId(input.proposalId);
  const attemptId = input.attemptId.trim().toLowerCase();
  if (!isUuid(attemptId)) {
    throw new SimpleChangesError(
      "--attempt-id must be a UUID.",
      EXIT_CODES.usage
    );
  }
  const payload = parseAttemptReceipt(input.receipt);
  const cwd = input.repositoryPath;
  const { commonGitDirectory } = locateRepository(cwd).repository;
  const ledgerPath = reviewLedgerPath(commonGitDirectory);
  return withLedgerTransaction(
    commonGitDirectory,
    "proposal record-review",
    (ledger) => {
      // Read under the loop lock that setup's preference writes also hold,
      // so a setup that finished first is always seen. A personal sidecar
      // written from another repository is replaced by an atomic rename, so
      // this read is where acceptance is ordered against it; a retry and a
      // resume revalidate against the settings current then.
      const settings = authoringSettings(
        input.authoring ? cwd : primaryCheckoutOf(cwd),
        input.authoring,
        input.request
      );
      const head = resolveCommit(cwd, input.head, "--head");
      const prior = findAttempt(ledger, attemptId);
      if (prior) {
        if (
          attemptPayloadKey(
            prior.proposalId,
            prior.attempt.headRevision,
            prior.attempt
          ) !== attemptPayloadKey(proposalId, head, payload)
        ) {
          throw new SimpleChangesError(
            `Attempt ${attemptId} is already recorded with a different payload; use a new attempt id for a new review.`,
            EXIT_CODES.validation
          );
        }
        const proposalRecord = ownValue(ledger.proposals, prior.proposalId);
        const now = revalidateAttempt(
          ledger,
          prior.proposalId,
          proposalRecord ? latestRecordedHead(proposalRecord) : null,
          prior.attempt,
          settings
        );
        return {
          approvalCandidate:
            now.revalidated && prior.attempt.verdict === "clean",
          attempt: prior.attempt,
          currentValidity: {
            reason: now.revalidationReason,
            valid: now.revalidated,
          },
          disclosure: reviewDisclosure(prior.attempt),
          ledgerPath,
          status: "unchanged" as const,
        };
      }
      const proposal = ownValue(ledger.proposals, proposalId);
      if (!(proposal && ownValue(proposal.heads, head))) {
        throw new SimpleChangesError(
          `authors-not-recorded: run proposal record-authors for ${proposalId} at ${head} before recording a review of it.`,
          EXIT_CODES.validation
        );
      }
      const decision = evaluateReviewAcceptance({
        adversarial: settings.adversarial,
        attempt: {
          headRevision: head,
          verdict: payload.verdict,
          verified: payload.verified,
        },
        currentHead: head,
        ledger,
        proposalId,
        repairRequired: settings.repairRequired,
      });
      const attempt: ReviewAttempt = {
        ...payload,
        acceptanceReason: decision.acceptanceReason,
        accepted: decision.accepted,
        attemptId,
        authorsDigest: decision.authorsDigest as string,
        coverageWaiverId: decision.coverageWaiverId,
        headRevision: head,
        recordedAt: new Date().toISOString(),
      };
      proposal.attempts.push(attempt);
      return {
        approvalCandidate: attempt.accepted && attempt.verdict === "clean",
        attempt,
        currentValidity: {
          reason: attempt.acceptanceReason,
          valid: attempt.accepted,
        },
        disclosure: reviewDisclosure(attempt),
        ledgerPath,
        status: "recorded" as const,
      };
    }
  );
};

// ---------------------------------------------------------------------------
// proposal waive-coverage

export interface WaiveCoverageInput {
  authorsDigest: string;
  head: string;
  proposalId: string;
  /** `{ approvedBy, reason, unattributed, gaps }`. */
  receipt: unknown;
  repositoryPath: string;
}

export interface WaiveCoverageResult {
  covers: boolean;
  ledgerPath: string;
  outstanding: { gaps: Record<string, CommitGaps>; unattributed: string[] };
  status: "recorded" | "unchanged";
  waiver: CoverageWaiver;
}

const parseWaiverReceipt = (
  receipt: unknown
): Pick<CoverageWaiver, "approvedBy" | "gaps" | "reason" | "unattributed"> => {
  const checker = new Checker();
  if (checker.object(receipt, "receipt")) {
    checker.keys(
      receipt,
      ["approvedBy", "gaps", "reason", "unattributed"],
      "receipt"
    );
    checker.check(
      isText(receipt.approvedBy, APPROVER_LIMIT),
      "receipt.approvedBy",
      "must name the owner who approved the waiver"
    );
    checker.check(
      isText(receipt.reason, REASON_LIMIT),
      "receipt.reason",
      "must give the reason"
    );
    checker.shaList(receipt.unattributed, "receipt.unattributed");
    checker.gapMap(receipt.gaps, "receipt.gaps");
  }
  if (checker.errors.length > 0 || !isRecord(receipt)) {
    throw new SimpleChangesError(
      `Invalid waive-coverage receipt: ${checker.errors.join("; ")}`,
      EXIT_CODES.validation
    );
  }
  const gaps = receipt.gaps as Record<string, CommitGaps>;
  return {
    approvedBy: (receipt.approvedBy as string).trim(),
    gaps: Object.fromEntries(
      Object.entries(gaps)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([commit, value]) => [
          commit,
          sortedGaps(value.unresolvedSources, value.uncoveredEdits),
        ])
    ),
    reason: (receipt.reason as string).trim(),
    unattributed: [...(receipt.unattributed as string[])].sort(),
  };
};

const assertWaiverNamesOutstanding = (
  named: Pick<CoverageWaiver, "gaps" | "unattributed">,
  coverage: HeadCoverage
): void => {
  const stray = [
    ...named.unattributed.filter(
      (commit) => !coverage.unattributed.includes(commit)
    ),
    ...Object.entries(named.gaps).flatMap(([commit, gaps]) => {
      const open = ownValue(coverage.gaps, commit) ?? sortedGaps([], []);
      return [
        ...gaps.unresolvedSources.filter(
          (sha) => !open.unresolvedSources.includes(sha)
        ),
        ...gaps.uncoveredEdits.filter(
          (sha) => !open.uncoveredEdits.includes(sha)
        ),
      ].map((sha) => `${commit}:${sha}`);
    }),
  ];
  const namesSomething =
    named.unattributed.length > 0 ||
    Object.values(named.gaps).some((gaps) => hasGaps(gaps));
  if (stray.length > 0 || !namesSomething) {
    throw new SimpleChangesError(
      stray.length > 0
        ? `The waiver names items that are not outstanding on this head: ${stray.join(", ")}. Name exactly the outstanding unattributed commits and gaps.`
        : "The waiver names nothing; list the outstanding unattributed commits and gaps it covers.",
      EXIT_CODES.validation
    );
  }
};

/**
 * `proposal waive-coverage`: records an owner's named, reasoned decision
 * before dispatch, bound to the proposal, the head, and the digest passed on
 * the command line, which must be the head's current digest. A waiver covers
 * only what it names and is stale the moment the digest changes.
 */
export const waiveProposalCoverage = (
  input: WaiveCoverageInput
): WaiveCoverageResult => {
  const proposalId = requireProposalId(input.proposalId);
  if (!DIGEST_PATTERN.test(input.authorsDigest)) {
    throw new SimpleChangesError(
      "--authors-digest must be the head's 64-character authors digest.",
      EXIT_CODES.usage
    );
  }
  const named = parseWaiverReceipt(input.receipt);
  const cwd = input.repositoryPath;
  const { commonGitDirectory } = locateRepository(cwd).repository;
  return withLedgerTransaction(
    commonGitDirectory,
    "proposal waive-coverage",
    (ledger) => {
      const head = resolveCommit(cwd, input.head, "--head");
      const record = ownValue(
        ownValue(ledger.proposals, proposalId)?.heads ?? {},
        head
      );
      if (!record) {
        throw new SimpleChangesError(
          `authors-not-recorded: run proposal record-authors for ${proposalId} at ${head} first.`,
          EXIT_CODES.validation
        );
      }
      const coverage = headCoverage(ledger, record.commits);
      if (input.authorsDigest !== coverage.authorsDigest) {
        throw new SimpleChangesError(
          `--authors-digest is not the head's current digest (${coverage.authorsDigest}); the coverage changed, so review the outstanding items again.`,
          EXIT_CODES.validation
        );
      }
      assertWaiverNamesOutstanding(named, coverage);
      const existing = record.waivers.find(
        (item) =>
          item.authorsDigest === coverage.authorsDigest &&
          item.approvedBy === named.approvedBy &&
          item.reason === named.reason &&
          JSON.stringify(item.unattributed) ===
            JSON.stringify(named.unattributed) &&
          JSON.stringify(item.gaps) === JSON.stringify(named.gaps)
      );
      const waiver: CoverageWaiver = existing ?? {
        ...named,
        authorsDigest: coverage.authorsDigest,
        recordedAt: new Date().toISOString(),
        waiverId: randomUUID(),
      };
      if (!existing) {
        record.waivers.push(waiver);
      }
      const remaining = coverage.unattributed.filter(
        (commit) => !waiver.unattributed.includes(commit)
      );
      const outstandingGaps = Object.fromEntries(
        Object.entries(coverage.gaps)
          .map(([commit, gaps]): [string, CommitGaps] => {
            const covered = ownValue(waiver.gaps, commit) ?? sortedGaps([], []);
            return [
              commit,
              sortedGaps(
                gaps.unresolvedSources.filter(
                  (sha) => !covered.unresolvedSources.includes(sha)
                ),
                gaps.uncoveredEdits.filter(
                  (sha) => !covered.uncoveredEdits.includes(sha)
                )
              ),
            ];
          })
          .filter(([, gaps]) => hasGaps(gaps))
      );
      return {
        covers: waiverCovers(waiver, coverage),
        ledgerPath: reviewLedgerPath(commonGitDirectory),
        outstanding: { gaps: outstandingGaps, unattributed: remaining },
        status: existing ? ("unchanged" as const) : ("recorded" as const),
        waiver,
      };
    }
  );
};

// ---------------------------------------------------------------------------
// Resume and finalization

export interface ResumedReviewAttempt {
  accepted: boolean;
  attemptId: string;
  headRevision: string;
  /** True only for an accepted attempt that still passes the gate now. */
  revalidated: boolean;
  revalidationReason: string | null;
  verdict: ReviewVerdict;
}

export interface ResumedReviewProposal {
  attempts: ResumedReviewAttempt[];
  authorsDigest: string | null;
  covered: boolean;
  /** Any attempt reported findings, so an escalation floor applies. */
  findingsRecorded: boolean;
  latestHead: string | null;
  proposalId: string;
  reviewedAttemptId: string | null;
}

export interface ReviewLedgerResumeState {
  errors: string[];
  path: string;
  proposals: ResumedReviewProposal[];
  reason: LedgerProblem | null;
  state: ReviewLedgerState["state"];
}

const revalidateAttempt = (
  ledger: ReviewLedger,
  proposalId: string,
  latestHead: string | null,
  attempt: ReviewAttempt,
  settings: { adversarial: boolean; repairRequired: boolean }
): ResumedReviewAttempt => {
  const summary = {
    accepted: attempt.accepted,
    attemptId: attempt.attemptId,
    headRevision: attempt.headRevision,
    verdict: attempt.verdict,
  };
  if (!attempt.accepted) {
    return {
      ...summary,
      revalidated: false,
      revalidationReason: attempt.acceptanceReason,
    };
  }
  const decision = evaluateReviewAcceptance({
    ...settings,
    attempt,
    currentHead: latestHead ?? attempt.headRevision,
    ledger,
    proposalId,
    waiverId: attempt.coverageWaiverId,
  });
  let reason: string | null = decision.acceptanceReason;
  if (reason === null && decision.authorsDigest !== attempt.authorsDigest) {
    reason = "authors-digest-changed";
  }
  return {
    ...summary,
    revalidated: reason === null,
    revalidationReason: reason,
  };
};

// The primary checkout holds the repository sidecar: the first non-bare
// entry Git lists, exactly as inventory resolves it.
const primaryCheckoutOf = (cwd: string): string => {
  const blocks = runGit(cwd, ["worktree", "list", "--porcelain"]).stdout.split(
    BLANK_LINE
  );
  for (const block of blocks) {
    const lines = block.split(LINE_SEPARATOR);
    const path = lines
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length);
    if (path && !lines.includes("bare")) {
      return path;
    }
  }
  return cwd;
};

const authoringSettings = (
  primaryCheckout: string,
  authoring:
    | Pick<RepositoryAuthoring, "effective" | "repairRequired">
    | undefined,
  request?: AuthoringSidecar
): { adversarial: boolean; repairRequired: boolean } => {
  try {
    const resolved =
      authoring ??
      resolveRepositoryAuthoring(primaryCheckout, {
        ...(request === undefined ? {} : { request }),
      });
    return {
      // A request only tightens (design 2.3 rule 6): the resolver already
      // combined it with the saved settings by the stricter value.
      adversarial: resolved.effective.review.adversarial,
      repairRequired: resolved.repairRequired,
    };
  } catch {
    // An unreadable preference fails closed: nothing is revalidated.
    return { adversarial: true, repairRequired: true };
  }
};

/**
 * `loop start --mode resume` loads the ledger under the loop lock it already
 * holds and revalidates every accepted attempt against each proposal's latest
 * recorded head and its recomputed digest; anything that fails needs a fresh
 * review. A malformed ledger is reported, never repaired, and never blocks
 * the resume itself.
 */
export const loadReviewLedgerForResume = (
  lock: HeldLoopLock,
  primaryCheckout: string,
  options: {
    authoring?: Pick<RepositoryAuthoring, "effective" | "repairRequired">;
    /**
     * The run's `--authoring-request`: revalidation then uses the request
     * combined with the saved settings, so a request-tightened run has one
     * gate (design 5.5, "One gate per run"). Nothing about it is persisted.
     */
    request?: AuthoringSidecar;
  } = {}
): ReviewLedgerResumeState => {
  heldLoopLock(lock.commonGitDirectory, lock.operation);
  const current = readReviewLedger(lock.commonGitDirectory);
  const base = {
    errors: current.errors,
    path: current.path,
    reason: current.reason,
    state: current.state,
  };
  if (current.state !== "valid") {
    return { ...base, proposals: [] };
  }
  const settings = authoringSettings(
    primaryCheckout,
    options.authoring,
    options.request
  );
  const proposals = Object.entries(current.ledger.proposals).map(
    ([proposalId, proposal]): ResumedReviewProposal => {
      const latestHead = latestRecordedHead(proposal);
      const record = latestHead
        ? ownValue(proposal.heads, latestHead)
        : undefined;
      const coverage = record
        ? headCoverage(current.ledger, record.commits)
        : null;
      const attempts = proposal.attempts.map((attempt) =>
        revalidateAttempt(
          current.ledger,
          proposalId,
          latestHead,
          attempt,
          settings
        )
      );
      const reviewed = [...attempts]
        .reverse()
        .find(
          (attempt) =>
            attempt.revalidated &&
            attempt.verdict === "clean" &&
            attempt.headRevision === latestHead
        );
      return {
        attempts,
        authorsDigest: coverage?.authorsDigest ?? null,
        covered: Boolean(
          record && coverage && coverageDecision(record, coverage).covered
        ),
        findingsRecorded: proposal.attempts.some(
          (attempt) => attempt.verdict === "findings"
        ),
        latestHead,
        proposalId,
        reviewedAttemptId: reviewed?.attemptId ?? null,
      };
    }
  );
  return { ...base, proposals };
};

export type ReviewAttemptSummary = Pick<
  ReviewAttempt,
  | "acceptanceReason"
  | "accepted"
  | "attemptId"
  | "effort"
  | "effortSource"
  | "findingsCount"
  | "headRevision"
  | "recordedAt"
  | "verdict"
>;

export interface ReviewAttemptsReport {
  errors: string[];
  path: string;
  proposals: { attempts: ReviewAttemptSummary[]; proposalId: string }[];
  /** Attempts recorded at or after this time (the run's start) are listed. */
  since: string;
  state: "valid" | "malformed";
}

/**
 * The review attempts a finalization receipt lists: every attempt recorded
 * since the run started, per proposal. Null when no ledger exists, so a run
 * that never touched the ledger keeps its receipt shape.
 */
export const reviewAttemptsForFinalization = (
  commonGitDirectory: string,
  since: string
): ReviewAttemptsReport | null => {
  const current = readReviewLedger(commonGitDirectory);
  if (current.state === "absent") {
    return null;
  }
  const start = Date.parse(since);
  const proposals = Object.entries(current.ledger.proposals)
    .map(([proposalId, proposal]) => ({
      attempts: proposal.attempts
        .filter((attempt) => !(Date.parse(attempt.recordedAt) < start))
        .map((attempt) => ({
          acceptanceReason: attempt.acceptanceReason,
          accepted: attempt.accepted,
          attemptId: attempt.attemptId,
          effort: attempt.effort,
          effortSource: attempt.effortSource,
          findingsCount: attempt.findingsCount,
          headRevision: attempt.headRevision,
          recordedAt: attempt.recordedAt,
          verdict: attempt.verdict,
        })),
      proposalId,
    }))
    .filter((proposal) => proposal.attempts.length > 0);
  return {
    errors: current.errors,
    path: current.path,
    proposals,
    since,
    state: current.state,
  };
};
