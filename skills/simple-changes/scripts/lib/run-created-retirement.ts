import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { targetContainsRevision } from "./cleanup-core.ts";
import { sha256Json } from "./hash.ts";
import {
  nothingAtPath,
  readImmutableRecoveryEvent,
  recoveryHistoryDirectory,
  resolvedCurrentTargetRevision,
} from "./loop-lease-core.ts";
import type {
  LoopLease,
  LoopWorktreeLease,
  LoopWorktreeRole,
  RepositoryInventory,
} from "./types.ts";

const RECORD_PATTERN = /^run-created-retirement-([0-9a-f]{64})\.json$/u;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;

/**
 * The approved retirement of a run-created authoring registration whose
 * checkout is gone. It lives in its own immutable file under the run's
 * recovery history, never in the lease, so a runtime that does not know it
 * keeps treating the registration as unaccounted for.
 */
export interface RunCreatedRetirement {
  absenceCheckedAt: string;
  actorAgentId: string;
  approvedBy: string;
  baselineChangeDigest: string;
  baselineHeadSha: string | null;
  branch: string;
  /** The retained branch's head that the proof read. */
  branchHeadSha: string;
  createdAt: string;
  path: string;
  proof: {
    baseRevision: string;
    commits: string[];
    method: "exact-byte-target";
    touchedPaths: string[];
  };
  reason: string;
  role: LoopWorktreeRole;
  targetRef: string;
  targetRevision: string;
}

export interface RunCreatedRetirementRecord {
  kind: "run-created-retirement";
  retirement: RunCreatedRetirement;
  runId: string;
  schemaVersion: 1;
}

export const runCreatedRetirementPath = (
  lease: LoopLease,
  retirement: RunCreatedRetirement
): string =>
  resolve(
    recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
    `run-created-retirement-${sha256Json(retirement)}.json`
  );

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

// A record counts only when every field has its exact shape and its file
// name is the digest of its retirement, so an edited record never applies.
const wellFormed = (
  record: unknown,
  runId: string,
  digest: string
): record is RunCreatedRetirementRecord => {
  if (typeof record !== "object" || record === null) {
    return false;
  }
  const candidate = record as Partial<RunCreatedRetirementRecord>;
  const retirement = candidate.retirement as
    | Partial<RunCreatedRetirement>
    | undefined;
  return Boolean(
    candidate.kind === "run-created-retirement" &&
      candidate.schemaVersion === 1 &&
      candidate.runId === runId &&
      retirement &&
      typeof retirement.path === "string" &&
      typeof retirement.branch === "string" &&
      typeof retirement.branchHeadSha === "string" &&
      SHA_PATTERN.test(retirement.branchHeadSha) &&
      typeof retirement.targetRevision === "string" &&
      SHA_PATTERN.test(retirement.targetRevision) &&
      typeof retirement.targetRef === "string" &&
      typeof retirement.baselineChangeDigest === "string" &&
      (retirement.baselineHeadSha === null ||
        typeof retirement.baselineHeadSha === "string") &&
      retirement.proof?.method === "exact-byte-target" &&
      isStringArray(retirement.proof.commits) &&
      isStringArray(retirement.proof.touchedPaths) &&
      sha256Json(retirement) === digest
  );
};

export const readRunCreatedRetirements = (
  lease: LoopLease
): RunCreatedRetirement[] => {
  const directory = recoveryHistoryDirectory(
    lease.commonGitDirectory,
    lease.runId
  );
  if (!existsSync(directory)) {
    return [];
  }
  const retirements: RunCreatedRetirement[] = [];
  for (const name of readdirSync(directory).sort()) {
    const digest = RECORD_PATTERN.exec(name)?.[1];
    if (!digest) {
      continue;
    }
    let record: unknown;
    try {
      record = readImmutableRecoveryEvent<object>(resolve(directory, name));
    } catch {
      continue;
    }
    if (wellFormed(record, lease.runId, digest)) {
      retirements.push(record.retirement);
    }
  }
  return retirements;
};

/**
 * The retirement that still accounts for a run-created registration: it
 * names this exact registration, the checkout is absent from disk and from
 * Git's live worktree list, the retained branch still points at the head
 * the proof read, and the current target still contains the target the
 * proof compared against. Anything else leaves the registration unretired.
 */
export const currentRunCreatedRetirement = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  registered: LoopWorktreeLease,
  retirements: readonly RunCreatedRetirement[] = readRunCreatedRetirements(
    lease
  )
): RunCreatedRetirement | undefined => {
  if (!registered.createdByRun || registered.branch === null) {
    return;
  }
  const live = inventory.worktrees.find(
    (worktree) => worktree.path === registered.path
  );
  if (!nothingAtPath(registered.path) || (live && !live.prunable)) {
    return;
  }
  const branchHead = inventory.branches.find(
    (branch) => branch.name === registered.branch
  )?.sha;
  const targetRevision = resolvedCurrentTargetRevision(lease);
  if (!(branchHead && targetRevision)) {
    return;
  }
  return retirements.find(
    (retirement) =>
      retirement.path === registered.path &&
      retirement.branch === registered.branch &&
      retirement.role === registered.role &&
      retirement.baselineChangeDigest === registered.baselineChangeDigest &&
      retirement.baselineHeadSha === registered.baselineHeadSha &&
      retirement.targetRef === lease.targetRef &&
      retirement.branchHeadSha === branchHead &&
      targetContainsRevision(
        lease.primaryCheckout,
        targetRevision,
        retirement.targetRevision
      )
  );
};

/** Paths of run-created registrations a current retirement accounts for. */
export const retiredRunCreatedPaths = (
  lease: LoopLease,
  inventory: RepositoryInventory
): Set<string> => {
  const candidates = lease.worktrees.filter(
    (registered) =>
      registered.createdByRun &&
      !inventory.worktrees.some(
        (worktree) => worktree.path === registered.path && !worktree.prunable
      )
  );
  if (candidates.length === 0) {
    return new Set();
  }
  const retirements = readRunCreatedRetirements(lease);
  return new Set(
    candidates
      .filter((registered) =>
        currentRunCreatedRetirement(lease, inventory, registered, retirements)
      )
      .map((registered) => registered.path)
  );
};
