import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  localBranchForTargetRef,
  PATCH_EQUIVALENCE_MAX_COMMITS,
  REVIEWED_REPLACEMENT_METHOD,
  targetContainmentAudit,
  targetContainsRevision,
} from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { proveExactByteTargetContainment } from "./exact-byte-proof.ts";
import { sha256Json } from "./hash.ts";
import { captureInventory } from "./inventory.ts";
import { runGit } from "./process.ts";
import { headCoverage, readReviewLedger } from "./review-ledger.ts";
import { validateSchema } from "./schema.ts";
import type {
  RepositoryInventory,
  WorktreeClaim,
  WorktreeInventory,
} from "./types.ts";

/** The most unique source commits one receipt may map. */
export const REPLACEMENT_LINEAGE_MAX_COMMITS = PATCH_EQUIVALENCE_MAX_COMMITS;

/** How long a user's approval stays usable after it was given. */
export const REPLACEMENT_LINEAGE_APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PIN_PREFIX = "refs/simple-changes/superseded/replacement-lineage-";

/**
 * The reviewed lineage of one clean local source checkout, as the controller
 * passes it to `prune` or `worktree cleanup` with `--lineage-receipt`.
 */
export interface ReplacementLineageReceipt {
  approval: {
    approvalReference: string;
    approvedAt: string;
    approvedBy: string;
    reason: string;
  };
  commits: Array<{ replacementCommits: string[]; sourceCommit: string }>;
  kind: "replacement-lineage-receipt";
  review: {
    decision: "replaced-in-target";
    reviewedAt: string;
    reviewerAgentId: string;
    reviewReference: string;
  };
  schemaVersion: 1;
  source: {
    authorAgentId: string;
    branch: string | null;
    changeDigest: string;
    headRevision: string;
    path: string;
  };
  targetRef: string;
  targetRevision: string;
}

export type ReplacementLineageByteProof =
  | { baseRevision: string; status: "proven"; touchedPaths: string[] }
  | { differingPaths: string[]; reason: string; status: "not-proven" };

export interface VerifiedReplacementLineage {
  byteProof: ReplacementLineageByteProof;
  pinRef: string;
  receipt: ReplacementLineageReceipt;
  receiptDigest: string;
  /** The current cleanup target revision, which contains the reviewed one. */
  targetRevision: string;
  uniqueCommits: string[];
  worktree: WorktreeInventory & { headSha: string };
}

export interface ReplacementLineageOutcome {
  branch: string | null;
  branchDeleted: boolean;
  byteProof: ReplacementLineageByteProof;
  headSha: string;
  method: typeof REVIEWED_REPLACEMENT_METHOD;
  path: string;
  pinRef: string;
  receiptDigest: string;
  recordPaths: string[];
  removalId: string | null;
  uniqueCommits: string[];
  worktreeRemoved: boolean;
}

export interface ReplacementLineageRemovalRecord {
  approvedBy: string;
  byteProof: ReplacementLineageByteProof;
  cleanupId: string | null;
  command: "prune" | "worktree-cleanup";
  controllerAgentId: string;
  kind: "replacement-lineage-removal";
  outcome: {
    branchDeleted: boolean;
    errors: string[];
    worktreeRemoved: boolean;
  } | null;
  phase: "intent" | "completed";
  pinRef: string;
  reason: string;
  receipt: ReplacementLineageReceipt;
  receiptDigest: string;
  recordedAt: string;
  removalId: string;
  schemaVersion: 1;
  targetRevision: string;
  uniqueCommits: string[];
}

/** Strict shape check of a `--lineage-receipt` document; it reads no Git. */
export const parseReplacementLineageReceipt = (
  value: unknown
): ReplacementLineageReceipt =>
  validateSchema<ReplacementLineageReceipt>(
    "replacement-lineage-receipt",
    value
  );

export interface ReplacementLineageContext {
  approvedBy: string;
  /** Every claim in the coordination document, released ones included. */
  claims: readonly WorktreeClaim[];
  controllerAgentId: string;
  inventory: RepositoryInventory;
  leaseBranches: ReadonlySet<string>;
  leasePaths: ReadonlyMap<string, string>;
  now: Date;
  receipt: ReplacementLineageReceipt;
  targetRef: string;
  targetRevision: string;
}

// Independence compares agent IDs without surrounding whitespace, so a
// padded author or controller ID cannot pass as another reviewer.
const sameAgent = (left: string, right: string): boolean =>
  left.trim() === right.trim();

const commitExists = (repositoryPath: string, revision: string): boolean =>
  runGit(repositoryPath, ["cat-file", "-e", `${revision}^{commit}`], true)
    .exitCode === 0;

type Refuse = (message: string, exitCode?: number) => never;

const refusalFor =
  (path: string): Refuse =>
  (message, exitCode = EXIT_CODES.unsafe) => {
    throw new SimpleChangesError(
      `Reviewed replacement lineage for ${path} is refused: ${message} Nothing was written or removed.`,
      exitCode
    );
  };

// The review must come first, the approval after it, both in the past, and
// the approval within the freshness window.
const assertProcessEvidence = (
  context: ReplacementLineageContext,
  refuse: Refuse
): void => {
  const { approval, review } = context.receipt;
  if (!sameAgent(approval.approvedBy, context.approvedBy)) {
    refuse(
      `the approval names ${approval.approvedBy}, but this command runs on approval from ${context.approvedBy}.`
    );
  }
  const reviewedAt = Date.parse(review.reviewedAt);
  const approvedAt = Date.parse(approval.approvedAt);
  const now = context.now.getTime();
  if (!(Number.isFinite(reviewedAt) && Number.isFinite(approvedAt))) {
    refuse("the review or approval time is not a valid date-time.");
  }
  if (approvedAt < reviewedAt) {
    refuse(
      `the approval (${approval.approvedAt}) predates the review (${review.reviewedAt}); the user must approve after the independent review.`
    );
  }
  if (reviewedAt > now || approvedAt > now) {
    refuse("the review or approval is dated in the future.");
  }
  if (now - approvedAt > REPLACEMENT_LINEAGE_APPROVAL_MAX_AGE_MS) {
    refuse(
      `the approval (${approval.approvedAt}) is more than ${REPLACEMENT_LINEAGE_APPROVAL_MAX_AGE_MS / 3_600_000} hours old; ask the user to approve again.`
    );
  }
};

// The exact checkout the review read: clean, unclaimed, unregistered, and
// at the reviewed branch and head.
const reviewedCheckout = (
  context: ReplacementLineageContext,
  refuse: Refuse
): WorktreeInventory & { headSha: string } => {
  const { inventory } = context;
  const { source } = context.receipt;
  const primary = inventory.repository.primaryCheckout;
  const worktree = inventory.worktrees.find(
    (candidate) => candidate.path === source.path
  );
  if (!worktree || worktree.prunable) {
    return refuse("no live checkout is registered at that path.");
  }
  if (worktree.isPrimary || worktree.bare) {
    refuse("the primary checkout is never removed.");
  }
  if (worktree.locked) {
    refuse("the checkout is locked; its owner must unlock it first.");
  }
  const targetBranch = localBranchForTargetRef(primary, context.targetRef);
  if (worktree.branch !== null && worktree.branch === targetBranch) {
    refuse(`the checkout is attached to target branch ${targetBranch}.`);
  }
  if (
    worktree.changes.length > 0 ||
    worktree.changeDigest !== source.changeDigest
  ) {
    refuse(
      "the checkout has uncommitted changes or a status digest that differs from the reviewed one."
    );
  }
  if (worktree.branch !== source.branch) {
    refuse(
      `the checkout is on ${worktree.branch ?? "a detached HEAD"}, not the reviewed ${source.branch ?? "detached HEAD"}.`
    );
  }
  if (worktree.headSha !== source.headRevision) {
    refuse(
      `the checkout's head is ${worktree.headSha ?? "unresolved"}, not the reviewed ${source.headRevision}; it moved after the review.`
    );
  }
  const sharing = inventory.worktrees.find(
    (candidate) =>
      candidate.path !== source.path &&
      !candidate.prunable &&
      source.branch !== null &&
      candidate.branch === source.branch
  );
  if (sharing) {
    refuse(
      `checkout ${sharing.path} also has branch ${source.branch} checked out, so deleting the branch would break it.`
    );
  }
  const claim = context.claims.find(
    (candidate) =>
      candidate.state !== "released" &&
      (candidate.path === source.path ||
        (source.branch !== null && candidate.branch === source.branch))
  );
  if (claim) {
    refuse(
      `claim ${claim.claimId} (${claim.state}, owned by ${claim.owner.agentId}) still covers the checkout; only its owner or an approved takeover may release it.`
    );
  }
  if (
    context.leasePaths.has(source.path) ||
    (source.branch !== null && context.leaseBranches.has(source.branch))
  ) {
    refuse(
      "an open loop lease registers the checkout or its branch; its controller owns that cleanup."
    );
  }
  return worktree as WorktreeInventory & { headSha: string };
};

// Every commit the reviewed target lacks, oldest first, after showing that
// the existing proofs do not already remove the checkout.
const uniqueSourceCommits = (
  context: ReplacementLineageContext,
  refuse: Refuse
): string[] => {
  const { receipt } = context;
  const primary = context.inventory.repository.primaryCheckout;
  const head = receipt.source.headRevision;
  if (!commitExists(primary, receipt.targetRevision)) {
    refuse(`reviewed target ${receipt.targetRevision} is not present locally.`);
  }
  if (
    !targetContainsRevision(
      primary,
      context.targetRevision,
      receipt.targetRevision
    )
  ) {
    refuse(
      `the current target ${context.targetRevision} does not contain the reviewed target ${receipt.targetRevision}; review again against the current target.`
    );
  }
  const containment = targetContainmentAudit(
    primary,
    context.targetRevision,
    head
  ).method;
  if (containment) {
    refuse(
      `the target already contains head ${head} (${containment}), so cleanup removes it without a receipt. Run it again without --lineage-receipt.`,
      EXIT_CODES.validation
    );
  }
  if (
    runGit(primary, ["merge-base", head, receipt.targetRevision], true)
      .exitCode !== 0
  ) {
    refuse(
      `head ${head} shares no history with reviewed target ${receipt.targetRevision}.`
    );
  }
  const unique = runGit(primary, [
    "rev-list",
    "--reverse",
    `${receipt.targetRevision}..${head}`,
  ])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (unique.length > REPLACEMENT_LINEAGE_MAX_COMMITS) {
    refuse(
      `the source has ${unique.length} commits outside the reviewed target, more than the ${REPLACEMENT_LINEAGE_MAX_COMMITS} one receipt may map.`
    );
  }
  return unique;
};

// The mapping covers exactly the unique commits, and every replacement is in
// the reviewed target and is not already part of the source.
const assertMapping = (
  context: ReplacementLineageContext,
  unique: readonly string[],
  refuse: Refuse
): void => {
  const { receipt } = context;
  const primary = context.inventory.repository.primaryCheckout;
  const mapping = new Map<string, string[]>();
  for (const entry of receipt.commits) {
    if (mapping.has(entry.sourceCommit)) {
      refuse(`source commit ${entry.sourceCommit} is mapped more than once.`);
    }
    mapping.set(entry.sourceCommit, entry.replacementCommits);
  }
  const uniqueSet = new Set(unique);
  const unmapped = unique.filter((commit) => !mapping.has(commit));
  if (unmapped.length > 0) {
    refuse(
      `unique source commit(s) ${unmapped.join(", ")} have no reviewed replacement; that work stays outstanding.`
    );
  }
  const extra = [...mapping.keys()].filter((commit) => !uniqueSet.has(commit));
  if (extra.length > 0) {
    refuse(
      `the receipt maps ${extra.join(", ")}, which the source does not hold outside the reviewed target; the receipt does not describe this history.`
    );
  }
  for (const [sourceCommit, replacements] of mapping) {
    for (const replacement of replacements) {
      if (
        !(
          commitExists(primary, replacement) &&
          targetContainsRevision(primary, receipt.targetRevision, replacement)
        )
      ) {
        refuse(
          `replacement ${replacement} for ${sourceCommit} is not contained in reviewed target ${receipt.targetRevision} (or is missing locally).`
        );
      }
      if (
        targetContainsRevision(
          primary,
          receipt.source.headRevision,
          replacement
        )
      ) {
        refuse(
          `replacement ${replacement} for ${sourceCommit} is already an ancestor of source head ${receipt.source.headRevision}, so it cannot be the work that replaced it.`
        );
      }
    }
  }
};

// The reviewer and the approver are neither an author nor the controller.
// Authors are the declared one, every agent that ever held a claim on this
// checkout, and every agent the review ledger attests for a unique commit,
// directly, through a replay record's sources, or in a completion's records.
const assertIndependence = (
  context: ReplacementLineageContext,
  unique: readonly string[],
  refuse: Refuse
): void => {
  const { approval, review, source } = context.receipt;
  const authors = new Set<string>([source.authorAgentId.trim()]);
  for (const entry of context.claims) {
    if (entry.path === source.path) {
      authors.add(entry.owner.agentId.trim());
    }
  }
  const ledger = readReviewLedger(
    context.inventory.repository.commonGitDirectory
  );
  if (ledger.state === "malformed") {
    refuse(
      "the review ledger is malformed, so the source commits' attested authors cannot be read."
    );
  }
  const coverage = headCoverage(ledger.ledger, unique);
  for (const commit of unique) {
    for (const attestation of [
      ...(coverage.authors[commit] ?? []),
      ...(coverage.recordedAuthors[commit] ?? []),
    ]) {
      if (attestation.logicalId) {
        authors.add(attestation.logicalId.trim());
      }
    }
  }
  const reviewer = review.reviewerAgentId;
  if (sameAgent(reviewer, context.controllerAgentId)) {
    refuse(
      `reviewer ${reviewer} is the controller running this cleanup; the review must be independent.`
    );
  }
  if (authors.has(reviewer.trim())) {
    refuse(
      `reviewer ${reviewer} is an author of the source; the review must be independent.`
    );
  }
  if (
    sameAgent(approval.approvedBy, reviewer) ||
    sameAgent(approval.approvedBy, context.controllerAgentId) ||
    authors.has(approval.approvedBy.trim())
  ) {
    refuse(
      `approver ${approval.approvedBy} is the reviewer, the controller, or an author; the approval must come from the user.`
    );
  }
};

/**
 * Checks a reviewed replacement lineage receipt against live Git and the
 * coordination state, and returns what removal would rely on. It reads only,
 * and every refusal throws before anything is written.
 *
 * The receipt's facts must match the checkout exactly: path, branch, head,
 * and clean status digest. The checkout must be unclaimed, unregistered by
 * any open lease, unlocked, not the primary or a target checkout, and in a
 * full clone. Its head must lie outside the target (otherwise the existing
 * proofs remove it). Every commit the reviewed target lacks must be mapped
 * once, each to replacement commits the reviewed target contains and the
 * source head does not, and the current target must still contain the
 * reviewed target. The reviewer must be neither an author nor the
 * controller, and the user's approval must follow the review, name the
 * approver this command runs for, and be fresh.
 *
 * Byte identity is recorded, not required: when the replacement kept the
 * source's bytes, the exact-byte proof says so; when review changed them,
 * the reviewed mapping, the review, and the approval are the evidence.
 */
export const verifyReplacementLineage = (
  context: ReplacementLineageContext
): VerifiedReplacementLineage => {
  const { receipt } = context;
  const refuse = refusalFor(receipt.source.path);
  if (!isAbsolute(receipt.source.path)) {
    refuse("source.path must be an absolute checkout path.", EXIT_CODES.usage);
  }
  if (receipt.targetRef !== context.targetRef) {
    refuse(
      `the receipt was reviewed against ${receipt.targetRef}, but this cleanup targets ${context.targetRef}. Run it with --target ${receipt.targetRef}.`,
      EXIT_CODES.usage
    );
  }
  assertProcessEvidence(context, refuse);
  const primary = context.inventory.repository.primaryCheckout;
  if (
    runGit(
      primary,
      ["rev-parse", "--is-shallow-repository"],
      true
    ).stdout.trim() !== "false"
  ) {
    refuse(
      "this is a shallow clone, where Git cannot prove a replacement came after the source forked. Run `git fetch --unshallow` first."
    );
  }
  const worktree = reviewedCheckout(context, refuse);
  const unique = uniqueSourceCommits(context, refuse);
  assertMapping(context, unique, refuse);
  assertIndependence(context, unique, refuse);
  const proof = proveExactByteTargetContainment(primary, {
    sourceHead: receipt.source.headRevision,
    targetRevision: receipt.targetRevision,
  });
  const byteProof: ReplacementLineageByteProof =
    proof.status === "proven"
      ? {
          baseRevision: proof.baseRevision,
          status: "proven",
          touchedPaths: proof.touchedPaths,
        }
      : {
          differingPaths: proof.differingPaths,
          reason: proof.reason,
          status: "not-proven",
        };
  const receiptDigest = sha256Json(receipt);
  return {
    byteProof,
    pinRef: `${PIN_PREFIX}${receiptDigest}/${receipt.source.headRevision}`,
    receipt,
    receiptDigest,
    targetRevision: context.targetRevision,
    uniqueCommits: unique,
    worktree,
  };
};

/** What a dry run reports: the verified plan, with nothing applied. */
export const plannedReplacementLineage = (
  verified: VerifiedReplacementLineage
): ReplacementLineageOutcome => ({
  branch: verified.worktree.branch,
  branchDeleted: false,
  byteProof: verified.byteProof,
  headSha: verified.worktree.headSha,
  method: REVIEWED_REPLACEMENT_METHOD,
  path: verified.worktree.path,
  pinRef: verified.pinRef,
  receiptDigest: verified.receiptDigest,
  recordPaths: [],
  removalId: null,
  uniqueCommits: verified.uniqueCommits,
  worktreeRemoved: false,
});

export const replacementLineageDirectory = (
  commonGitDirectory: string
): string =>
  resolve(commonGitDirectory, "simple-changes", "replacement-lineage");

const writeRecord = (
  commonGitDirectory: string,
  record: ReplacementLineageRemovalRecord
): string => {
  const valid = validateSchema<ReplacementLineageRemovalRecord>(
    "replacement-lineage-removal",
    record
  );
  const directory = replacementLineageDirectory(commonGitDirectory);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const path = resolve(directory, `${valid.removalId}-${valid.phase}.json`);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(valid, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return path;
};

export interface ReplacementLineageRemovalOptions {
  approvedBy: string;
  cleanupId: string | null;
  command: "prune" | "worktree-cleanup";
  commonGitDirectory: string;
  controllerAgentId: string;
  errors: string[];
  reason: string;
  repositoryPath: string;
  verified: VerifiedReplacementLineage;
}

// Deletes the source branch only while no checkout has it checked out and it
// still points at the pinned head, with an exact old-value ref update rather
// than a forced branch deletion.
const deleteReviewedBranch = (
  primary: string,
  branch: string,
  headSha: string,
  pinRef: string,
  stepErrors: string[]
): boolean => {
  const user = captureInventory(primary).worktrees.find(
    (worktree) => !worktree.prunable && worktree.branch === branch
  );
  if (user) {
    stepErrors.push(
      `Kept branch ${branch}: checkout ${user.path} has it checked out.`
    );
    return false;
  }
  const tip = runGit(
    primary,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
    true
  ).stdout.trim();
  if (tip !== headSha) {
    stepErrors.push(
      `Kept branch ${branch}: it no longer points at the reviewed head ${headSha}.`
    );
    return false;
  }
  const deleted = runGit(
    primary,
    ["update-ref", "-d", `refs/heads/${branch}`, headSha],
    true
  );
  if (deleted.exitCode !== 0) {
    stepErrors.push(
      `Could not delete reviewed replacement branch ${branch}; its head stays pinned at ${pinRef}: ${deleted.stderr.trim()}`
    );
    return false;
  }
  runGit(primary, ["config", "--remove-section", `branch.${branch}`], true);
  return true;
};

// Why the verified checkout no longer matches the receipt, or null when it
// still does: same path, branch, head, and clean status, unlocked, and no
// other checkout on its branch.
const reviewedCheckoutDrift = (
  repositoryPath: string,
  verified: VerifiedReplacementLineage
): string | null => {
  const { path, headSha, branch, changeDigest } = verified.worktree;
  const { worktrees } = captureInventory(repositoryPath);
  const fresh = worktrees.find(
    (worktree) =>
      worktree.path === path &&
      !worktree.prunable &&
      !worktree.locked &&
      worktree.headSha === headSha &&
      worktree.branch === branch &&
      worktree.changeDigest === changeDigest &&
      worktree.changes.length === 0
  );
  if (!fresh) {
    return "its branch, head, status, or lock changed after verification";
  }
  if (
    branch !== null &&
    worktrees.some(
      (worktree) =>
        worktree.path !== path &&
        !worktree.prunable &&
        worktree.branch === branch
    )
  ) {
    return `another checkout now has branch ${branch} checked out`;
  }
  return null;
};

/**
 * Re-reads the verified checkout before a cleanup writes or removes
 * anything, and refuses the whole run when it changed since verification.
 */
export const assertReviewedReplacementUnchanged = (
  repositoryPath: string,
  verified: VerifiedReplacementLineage
): void => {
  const drift = reviewedCheckoutDrift(repositoryPath, verified);
  if (drift) {
    throw new SimpleChangesError(
      `Refusing the reviewed replacement removal of ${verified.worktree.path}: ${drift}. Nothing was written or removed. Review the checkout again and write a new receipt.`,
      EXIT_CODES.unsafe
    );
  }
};

/**
 * Removes a verified source checkout without forcing anything. It pins the
 * reviewed head under
 * `refs/simple-changes/superseded/replacement-lineage-<receipt digest>/<head>`
 * so the source history survives, records the intent, re-reads the checkout
 * as the last step before plain `git worktree remove` (so no write of its
 * own, or hook a write triggers, falls between that audit and the removal),
 * deletes the branch only while it still points at the pinned head and no
 * other checkout uses it, and records the outcome. A failure at any step
 * stops the later ones and is reported; callers run it before every other
 * removal and stop the run when the checkout was not removed.
 */
export const removeReviewedReplacement = (
  options: ReplacementLineageRemovalOptions
): ReplacementLineageOutcome => {
  const { errors, verified } = options;
  const outcome = plannedReplacementLineage(verified);
  const { path, headSha, branch } = verified.worktree;
  const primary = captureInventory(options.repositoryPath).repository
    .primaryCheckout;
  const pinned = runGit(
    primary,
    [
      "update-ref",
      "-m",
      `simple-changes: pin reviewed replacement source ${branch ?? path}`,
      verified.pinRef,
      headSha,
    ],
    true
  );
  if (
    pinned.exitCode !== 0 ||
    runGit(
      primary,
      ["rev-parse", "--verify", "--quiet", verified.pinRef],
      true
    ).stdout.trim() !== headSha
  ) {
    errors.push(
      `Could not pin reviewed replacement head ${headSha} at ${verified.pinRef}; ${path} was preserved. ${pinned.stderr.trim()}`.trim()
    );
    return outcome;
  }
  const removalId = `lineage-${randomUUID()}`;
  const base = {
    approvedBy: options.approvedBy,
    byteProof: verified.byteProof,
    cleanupId: options.cleanupId,
    command: options.command,
    controllerAgentId: options.controllerAgentId,
    kind: "replacement-lineage-removal" as const,
    pinRef: verified.pinRef,
    reason: options.reason,
    receipt: verified.receipt,
    receiptDigest: verified.receiptDigest,
    removalId,
    schemaVersion: 1 as const,
    targetRevision: verified.targetRevision,
    uniqueCommits: verified.uniqueCommits,
  };
  outcome.removalId = removalId;
  outcome.recordPaths.push(
    writeRecord(options.commonGitDirectory, {
      ...base,
      outcome: null,
      phase: "intent",
      recordedAt: new Date().toISOString(),
    })
  );
  const stepErrors: string[] = [];
  const drift = reviewedCheckoutDrift(options.repositoryPath, verified);
  if (drift) {
    stepErrors.push(
      `Preserved reviewed replacement checkout ${path}: ${drift}. The reviewed head stays pinned at ${verified.pinRef}.`
    );
  } else {
    const removal = runGit(
      options.repositoryPath,
      ["worktree", "remove", path],
      true
    );
    if (removal.exitCode === 0) {
      outcome.worktreeRemoved = true;
    } else {
      stepErrors.push(
        `Could not remove reviewed replacement checkout ${path}: ${removal.stderr.trim() || removal.stdout.trim()}`
      );
    }
  }
  if (outcome.worktreeRemoved && branch) {
    outcome.branchDeleted = deleteReviewedBranch(
      primary,
      branch,
      headSha,
      verified.pinRef,
      stepErrors
    );
  }
  errors.push(...stepErrors);
  outcome.recordPaths.push(
    writeRecord(options.commonGitDirectory, {
      ...base,
      outcome: {
        branchDeleted: outcome.branchDeleted,
        errors: stepErrors,
        worktreeRemoved: outcome.worktreeRemoved,
      },
      phase: "completed",
      recordedAt: new Date().toISOString(),
    })
  );
  return outcome;
};
