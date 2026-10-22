import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
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
import { parseWorktreeList } from "./inventory.ts";
import {
  type ArchiveRetentionPolicy,
  archiveRetentionPolicy,
} from "./policy.ts";
import { runGit } from "./process.ts";
import { headCoverage, readReviewLedger } from "./review-ledger.ts";
import { validateSchema } from "./schema.ts";
import type {
  RepositoryInventory,
  WorktreeClaim,
  WorktreeInventory,
} from "./types.ts";
import {
  type ArchiveBranchConfig,
  type ArchivePinRef,
  archivePinNamespace,
  assertArchiveCapacity,
  compareLiveWithManifest,
  copyWorktreeIntoArchive,
  DEFAULT_MAX_ARCHIVE_BYTES,
  measureTree,
  newArchiveId,
  type WorktreeArchiveManifest,
  worktreeArchivesRoot,
  writeWorktreeArchiveManifest,
} from "./worktree-archive.ts";
import {
  readWorktreeTakeovers,
  repositoryIdFor,
} from "./worktree-coordination.ts";

/** The most unique source commits one receipt may map. */
export const REPLACEMENT_LINEAGE_MAX_COMMITS = PATCH_EQUIVALENCE_MAX_COMMITS;

/** How long a user's approval stays usable after it was given. */
export const REPLACEMENT_LINEAGE_APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 86_400_000;
const DIFFERENCE_SUMMARY_LIMIT = 5;

/**
 * Environment variables that redirect what every Git command reads or
 * removes: with one set, the inventory, the boundary's reads and
 * `git worktree remove`'s own check would look at another index, directory
 * or object store than the checkout's. A reviewed removal and a restore
 * refuse them.
 */
export const GIT_ENVIRONMENT_REDIRECTS = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
] as const;

/** Refuses, writing nothing, when the environment redirects what Git reads. */
export const assertPlainGitEnvironment = (
  environment: Record<string, string | undefined> = process.env
): void => {
  const set = GIT_ENVIRONMENT_REDIRECTS.filter(
    (name) => environment[name] !== undefined
  );
  if (set.length > 0) {
    throw new SimpleChangesError(
      `The environment sets ${set.join(", ")}, which would make Git read or remove something other than the checkout itself. Unset ${set.length === 1 ? "it" : "them"} and run the command again. Nothing was written or removed.`,
      EXIT_CODES.unsafe
    );
  }
};

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

/** What the archive of the checkout will be, measured before anything is written. */
export interface ReplacementLineageArchivePlan {
  /** Regular file bytes of the checkout folder and its private Git directory. */
  bytes: number;
  /** When automatic pruning may remove the archive, from the policy in force. */
  expiresAt: string;
  /** The per-archive cap this run applies. */
  maxArchiveBytes: number;
  /** `<common>/worktrees/<name>`, which `git worktree remove` deletes. */
  privateGitDirectory: string;
  retention: ArchiveRetentionPolicy;
}

export interface VerifiedReplacementLineage {
  archive: ReplacementLineageArchivePlan;
  byteProof: ReplacementLineageByteProof;
  commonGitDirectory: string;
  now: Date;
  /** The primary checkout every removal Git command runs from. */
  primaryCheckout: string;
  receipt: ReplacementLineageReceipt;
  receiptDigest: string;
  repositoryId: string;
  /** The current cleanup target revision, which contains the reviewed one. */
  targetRevision: string;
  uniqueCommits: string[];
  worktree: WorktreeInventory & { headSha: string };
}

/** The archive a removal made (or, in a plan, would make). */
export interface ReplacementLineageArchiveOutcome {
  /** Null in a plan: the ID is chosen when the archive is written. */
  archiveId: string | null;
  bytes: number;
  expiresAt: string;
  path: string | null;
  retention: { days: number; maxTotalBytes: number };
  /** Policy values that were not usable and fell back to the default. */
  retentionFallbacks: string[];
}

export interface ReplacementLineageOutcome {
  archive: ReplacementLineageArchiveOutcome;
  branch: string | null;
  branchDeleted: boolean;
  byteProof: ReplacementLineageByteProof;
  headSha: string;
  method: typeof REVIEWED_REPLACEMENT_METHOD;
  path: string;
  /** The refs that keep the head and every object the checkout named. */
  pinRefs: string[];
  receiptDigest: string;
  recordPaths: string[];
  removalId: string | null;
  uniqueCommits: string[];
  worktreeRemoved: boolean;
}

export interface ReplacementLineageRemovalRecord {
  approvedBy: string;
  archive: {
    archiveId: string;
    bytes: number;
    expiresAt: string;
    path: string;
    retention: { days: number; maxTotalBytes: number };
  } | null;
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
  pinRefs: ArchivePinRef[];
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
  /** The per-archive size cap; the module default when absent. */
  maxArchiveBytes?: number | undefined;
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
// Authors are the declared one, the recorded owner of every claim on this
// checkout's path or branch (a released claim still records its last
// owner), both sides of every reassign takeover the history holds for those
// claims, and every agent the review ledger attests for a unique commit,
// directly, through a replay record's sources, or in a completion's
// records. The agent who carried out a release takeover never owned the
// claim and is not an author. A claim that visibly references a takeover
// the history does not hold refuses: its earlier owners cannot be read.
const TAKEOVER_OWNER_REFERENCE = "takeover:";

const claimsOnCheckout = (
  context: ReplacementLineageContext
): WorktreeClaim[] => {
  const { source } = context.receipt;
  return context.claims.filter(
    (claim) =>
      claim.path === source.path ||
      (source.branch !== null && claim.branch === source.branch)
  );
};

// Every agent the claims on this checkout and the takeover receipts for
// them show as an owner; refuses a claim whose takeover the history lacks.
const claimOwners = (
  context: ReplacementLineageContext,
  refuse: Refuse
): Set<string> => {
  const owners = new Set<string>();
  const claims = claimsOnCheckout(context);
  const claimIds = new Set(claims.map((claim) => claim.claimId));
  for (const claim of claims) {
    owners.add(claim.owner.agentId.trim());
  }
  const takeovers = readWorktreeTakeovers(
    context.inventory.repository.commonGitDirectory
  ).filter(
    (takeover) =>
      takeover.path === context.receipt.source.path ||
      claimIds.has(takeover.claimId)
  );
  for (const takeover of takeovers) {
    if (takeover.action === "reassign") {
      owners.add(takeover.previousOwner.agentId.trim());
      owners.add(takeover.newAgentId.trim());
    }
  }
  for (const claim of claims) {
    const hasReceipt = (action: "reassign" | "release"): boolean =>
      takeovers.some(
        (takeover) =>
          takeover.action === action && takeover.claimId === claim.claimId
      );
    if (
      claim.owner.ownerRef?.startsWith(TAKEOVER_OWNER_REFERENCE) &&
      !hasReceipt("reassign")
    ) {
      refuse(
        `claim ${claim.claimId} records that a takeover handed it to ${claim.owner.agentId} (owner reference ${claim.owner.ownerRef}), but the takeover history holds no reassign receipt for it, so its earlier owners cannot be read. Restore the takeover history, or, if the owner reference was given by hand, release the claim and claim the checkout again without it. The removal is reversible once it runs, but the reviewer must still be shown independent.`
      );
    }
    if (claim.releaseReason === "takeover" && !hasReceipt("release")) {
      refuse(
        `claim ${claim.claimId} records that a takeover released it, but the takeover history holds no release receipt for it, so the history is incomplete. Restore the takeover history and run the command again.`
      );
    }
  }
  return owners;
};

// Every agent the review ledger attests for a unique commit, directly,
// through a replay record's sources, or in a completion's records.
const attestedAuthors = (
  context: ReplacementLineageContext,
  unique: readonly string[],
  refuse: Refuse
): Set<string> => {
  const ledger = readReviewLedger(
    context.inventory.repository.commonGitDirectory
  );
  if (ledger.state === "malformed") {
    refuse(
      "the review ledger is malformed, so the source commits' attested authors cannot be read."
    );
  }
  const authors = new Set<string>();
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
  return authors;
};

const assertIndependence = (
  context: ReplacementLineageContext,
  unique: readonly string[],
  refuse: Refuse
): void => {
  const { approval, review, source } = context.receipt;
  const authors = new Set<string>([
    source.authorAgentId.trim(),
    ...claimOwners(context, refuse),
    ...attestedAuthors(context, unique, refuse),
  ]);
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

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}${sep}`);

// The checkout's private Git directory, which `git worktree remove` deletes
// and the archive must hold: `<common>/worktrees/<name>` of a linked
// checkout that lies outside the Git directory and the archives.
const sourcePrivateGitDirectory = (
  worktreePath: string,
  commonGitDirectory: string,
  refuse: Refuse
): string => {
  const listed = runGit(
    worktreePath,
    ["rev-parse", "--absolute-git-dir"],
    true
  );
  if (listed.exitCode !== 0) {
    return refuse(
      `Git could not name the checkout's private directory: ${listed.stderr.trim()}`
    );
  }
  const directory = realpathSync(listed.stdout.trim());
  const common = realpathSync(commonGitDirectory);
  if (dirname(directory) !== resolve(common, "worktrees")) {
    refuse(
      `its private Git directory ${directory} is not under ${resolve(common, "worktrees")}, so it is not a linked checkout this command can archive.`
    );
  }
  const real = realpathSync(worktreePath);
  if (isInside(real, common) || isInside(real, worktreeArchivesRoot(common))) {
    refuse(
      `the checkout ${worktreePath} lies inside the repository's Git directory or its archives, which an archive cannot hold.`
    );
  }
  return directory;
};

// Measures and bounds the archive before anything is written, so a dry run
// reports the size and the expiry the user approves.
const archivePlan = (
  context: ReplacementLineageContext,
  worktreePath: string,
  refuse: Refuse
): ReplacementLineageArchivePlan => {
  const { commonGitDirectory } = context.inventory.repository;
  const privateGitDirectory = sourcePrivateGitDirectory(
    worktreePath,
    commonGitDirectory,
    refuse
  );
  const retention = archiveRetentionPolicy(context.inventory.policy.value);
  const maxArchiveBytes = context.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const bytes =
    measureTree(worktreePath).bytes + measureTree(privateGitDirectory).bytes;
  assertArchiveCapacity({
    bytes,
    maxArchiveBytes,
    root: worktreeArchivesRoot(commonGitDirectory),
  });
  return {
    bytes,
    expiresAt: new Date(
      context.now.getTime() + retention.days * DAY_MS
    ).toISOString(),
    maxArchiveBytes,
    privateGitDirectory,
    retention,
  };
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
 *
 * It also plans the archive the removal will make: the checkout's private
 * Git directory, the size of both, the per-archive cap and the free space,
 * and the expiry the retention policy gives, so a dry run shows the user
 * what the approval covers.
 */
export const verifyReplacementLineage = (
  context: ReplacementLineageContext
): VerifiedReplacementLineage => {
  const { receipt } = context;
  const refuse = refusalFor(receipt.source.path);
  assertPlainGitEnvironment();
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
  const { commonGitDirectory } = context.inventory.repository;
  return {
    archive: archivePlan(context, worktree.path, refuse),
    byteProof,
    commonGitDirectory,
    now: context.now,
    primaryCheckout: primary,
    receipt,
    receiptDigest,
    repositoryId: repositoryIdFor(commonGitDirectory),
    targetRevision: context.targetRevision,
    uniqueCommits: unique,
    worktree,
  };
};

/** What a dry run reports: the verified plan, with nothing applied. */
export const plannedReplacementLineage = (
  verified: VerifiedReplacementLineage
): ReplacementLineageOutcome => ({
  archive: {
    archiveId: null,
    bytes: verified.archive.bytes,
    expiresAt: verified.archive.expiresAt,
    path: null,
    retention: {
      days: verified.archive.retention.days,
      maxTotalBytes: verified.archive.retention.maxTotalBytes,
    },
    retentionFallbacks: verified.archive.retention.fallbacks,
  },
  branch: verified.worktree.branch,
  branchDeleted: false,
  byteProof: verified.byteProof,
  headSha: verified.worktree.headSha,
  method: REVIEWED_REPLACEMENT_METHOD,
  path: verified.worktree.path,
  pinRefs: [],
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

// The reviewed removal's own Git boundary. From the check before the pin
// through branch deletion, every Git command runs with these options: no
// pager, no lazy fetch, hooks and fsmonitor off, and every filter driver
// either checkout's effective configuration defines emptied. With
// submodules, partial clones, and configured hooks refused, this keeps the
// programs it recognizes from running between reading the checkout and
// removing it. It is hardening, not a guarantee: as on the other removal
// paths, configured programs are trusted, and a filter driver whose name
// does not read back exactly (empty, or not valid UTF-8) is not covered.
const CALLBACK_FREE_BASE = [
  "--no-pager",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;
const FILTER_COMMAND_KEYS = ["clean", "smudge", "process"] as const;
const FILTER_KEY_PATTERN = /^filter\.(.+)\.(clean|smudge|process|required)$/u;
const CONFIGURED_HOOK_PATTERN = /^hook\./u;
const PROMISOR_KEY_PATTERN = /^remote\..+\.promisor$/u;
const FALSE_VALUES = new Set(["false", "no", "off", "0", ""]);
const LINE_ENDS = /[\r\n]+$/u;
const HEADS_PREFIX = /^refs\/heads\//u;

const boundaryRefusal = (path: string, detail: string): SimpleChangesError =>
  new SimpleChangesError(
    `Refusing the reviewed replacement removal of ${path}: ${detail} Nothing was written or removed.`,
    EXIT_CODES.unsafe
  );

// Every `name value` pair of the effective configuration in one checkout,
// across system, global, local, worktree, included, and environment scopes.
// A key written without `=` has a null value, which Git reads as true.
const effectiveConfig = (
  context: string,
  options: readonly string[]
): Array<{ key: string; value: string | null }> => {
  const listed = runGit(context, [...options, "config", "--list", "-z"], true);
  if (listed.exitCode !== 0) {
    return [];
  }
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const split = entry.indexOf("\n");
      return split < 0
        ? { key: entry, value: null }
        : { key: entry.slice(0, split), value: entry.slice(split + 1) };
    });
};

// Collects the filter drivers one checkout's effective configuration
// defines, and refuses a configured hook, a partial clone, or a driver name
// the command line cannot override.
const scanContext = (
  context: string,
  source: string,
  drivers: Set<string>
): void => {
  for (const { key, value } of effectiveConfig(context, CALLBACK_FREE_BASE)) {
    if (CONFIGURED_HOOK_PATTERN.test(key)) {
      throw boundaryRefusal(
        source,
        `${context} configures a hook through ${key}, which hooks off cannot stop.`
      );
    }
    if (key === "core.virtualfilesystem" && value !== "") {
      throw boundaryRefusal(
        source,
        `${context} sets core.virtualFilesystem, a program some Git builds run during status.`
      );
    }
    const promisor =
      PROMISOR_KEY_PATTERN.test(key) &&
      (value === null || !FALSE_VALUES.has(value.toLowerCase()));
    if (key === "extensions.partialclone" || promisor) {
      throw boundaryRefusal(
        source,
        `${context} is a partial clone (${key}), where reading a missing object would start a fetch.`
      );
    }
    const driver = FILTER_KEY_PATTERN.exec(key)?.[1];
    if (driver === undefined) {
      continue;
    }
    if (driver.includes("=")) {
      throw boundaryRefusal(
        source,
        `filter configuration key ${JSON.stringify(key)} cannot be overridden on the command line.`
      );
    }
    drivers.add(driver);
  }
};

// What one checkout does not read back as overridden.
const unconfirmedIn = (
  context: string,
  overrides: readonly string[],
  drivers: ReadonlySet<string>
): string[] => {
  const effective = new Map<string, string | null>();
  for (const { key, value } of effectiveConfig(context, overrides)) {
    effective.set(key, value);
  }
  const wanted = new Map<string, string>([
    ["core.hookspath", "/dev/null"],
    ["core.fsmonitor", "false"],
  ]);
  for (const driver of drivers) {
    for (const key of FILTER_COMMAND_KEYS) {
      wanted.set(`filter.${driver}.${key}`, "");
    }
    wanted.set(`filter.${driver}.required`, "false");
  }
  const missing = [...wanted]
    .filter(([key, value]) => effective.get(key) !== value)
    .map(([key]) => `${key} in ${context}`);
  for (const key of effective.keys()) {
    const driver = FILTER_KEY_PATTERN.exec(key)?.[1];
    if (driver !== undefined && !drivers.has(driver)) {
      missing.push(`${key} in ${context}`);
    }
  }
  const hooks = runGit(
    context,
    [...overrides, "rev-parse", "--git-path", "hooks"],
    true
  ).stdout.replace(LINE_ENDS, "");
  if (hooks !== "/dev/null") {
    missing.push(`the hooks directory in ${context}`);
  }
  return missing;
};

/**
 * The options that keep configured programs from running, confirmed in
 * effect in both the primary and the source checkout, whose effective
 * configurations differ (worktree config, `includeIf`). Throws, before
 * anything is written, when either checkout configures a hook through
 * `hook.*`, is a partial clone (a missing object would start a fetch), names
 * a filter driver the command line cannot override, or does not read back
 * hooks at /dev/null, fsmonitor off, and every driver emptied.
 */
const callbackFreeOverrides = (primary: string, source: string): string[] => {
  const contexts = [primary, source];
  const drivers = new Set<string>();
  for (const context of contexts) {
    scanContext(context, source, drivers);
  }
  const overrides: string[] = [...CALLBACK_FREE_BASE];
  for (const driver of [...drivers].sort()) {
    for (const key of FILTER_COMMAND_KEYS) {
      overrides.push("-c", `filter.${driver}.${key}=`);
    }
    overrides.push("-c", `filter.${driver}.required=false`);
  }
  const unconfirmed = contexts.flatMap((context) =>
    unconfirmedIn(context, overrides, drivers)
  );
  if (unconfirmed.length > 0) {
    throw boundaryRefusal(
      source,
      `Git did not confirm the overrides that keep configured programs from running (${unconfirmed.join(", ")}).`
    );
  }
  return overrides;
};

const listedWorktrees = (primary: string, overrides: readonly string[]) =>
  parseWorktreeList(
    runGit(primary, [...overrides, "worktree", "list", "--porcelain"]).stdout
  );

// Why the verified checkout no longer matches the receipt, or null when it
// still does. It runs inside the callback-free boundary and reads status
// first, then the head and branch, so nothing it runs can move the head
// after it was read: clean status, the reviewed head and branch, the same
// private Git directory, still registered and unlocked, and no other
// checkout on its branch.
const reviewedCheckoutDrift = (
  verified: VerifiedReplacementLineage,
  overrides: readonly string[]
): string | null => {
  const { path, headSha, branch } = verified.worktree;
  const staged = runGit(
    path,
    [...overrides, "ls-files", "--stage", "-z"],
    true
  );
  const modules = runGit(
    path,
    [
      ...overrides,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "modules",
    ],
    true
  ).stdout.replace(LINE_ENDS, "");
  if (
    staged.exitCode !== 0 ||
    staged.stdout.split("\0").some((line) => line.startsWith("160000 ")) ||
    existsSync(modules)
  ) {
    return "it has submodules, whose own configuration and status the boundary cannot cover";
  }
  const status = runGit(
    path,
    [
      ...overrides,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ],
    true
  );
  if (status.exitCode !== 0) {
    return `its status could not be read (${status.stderr.trim()})`;
  }
  if (status.stdout !== "") {
    return "it has uncommitted changes";
  }
  const head = runGit(
    path,
    [...overrides, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    true
  ).stdout.trim();
  if (head !== headSha) {
    return `its head is ${head || "unresolved"}, not the reviewed ${headSha}`;
  }
  const symbolic = runGit(
    path,
    [...overrides, "symbolic-ref", "--quiet", "HEAD"],
    true
  );
  const current =
    symbolic.exitCode === 0
      ? symbolic.stdout.replace(LINE_ENDS, "").replace(HEADS_PREFIX, "")
      : null;
  if (current !== branch) {
    return `it is on ${current ?? "a detached HEAD"}, not the reviewed ${branch ?? "detached HEAD"}`;
  }
  const privateDirectory = runGit(
    path,
    [...overrides, "rev-parse", "--absolute-git-dir"],
    true
  ).stdout.trim();
  if (
    !privateDirectory ||
    realpathSync(privateDirectory) !== verified.archive.privateGitDirectory
  ) {
    return `its private Git directory is ${privateDirectory || "unknown"}, not ${verified.archive.privateGitDirectory}`;
  }
  return registrationDrift(verified, overrides);
};

// The checkout as Git's registry sees it from the primary: registered,
// unlocked, and alone on its branch.
const registrationDrift = (
  verified: VerifiedReplacementLineage,
  overrides: readonly string[]
): string | null => {
  const { path, branch } = verified.worktree;
  const worktrees = listedWorktrees(verified.primaryCheckout, overrides);
  const entry = worktrees.find((worktree) => worktree.path === path);
  if (!entry || entry.prunable) {
    return "it is no longer a registered checkout";
  }
  if (entry.locked) {
    return "it is locked";
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
    return `another checkout has branch ${branch} checked out`;
  }
  return null;
};

/** What the checkout's own refs name, read before it is copied. */
export interface ReviewedSourceState {
  /** The `branch.<name>.*` entries of the checkout's branch, restored with it. */
  branchConfig: ArchiveBranchConfig[];
  /** Each object a per-worktree ref or pseudo-ref names, with that name. */
  namedObjects: Array<{ name: string; object: string }>;
}

// The ref namespaces Git keeps per worktree, and the pseudo-refs that can
// name an object nothing else reaches (an autostash, a rebase's original
// head), read through Git so the ref backend does not matter.
const PER_WORKTREE_REF_NAMESPACES = [
  "refs/bisect",
  "refs/worktree",
  "refs/rewritten",
] as const;
const PSEUDO_REFS = [
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "MERGE_AUTOSTASH",
  "AUTO_MERGE",
  "BISECT_EXPECTED_REV",
  "FETCH_HEAD",
] as const;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const EXTENDED_REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/gu;

const namedObjectsOf = (
  path: string,
  overrides: readonly string[]
): ReviewedSourceState["namedObjects"] => {
  const found: ReviewedSourceState["namedObjects"] = [];
  const refs = runGit(
    path,
    [
      ...overrides,
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      ...PER_WORKTREE_REF_NAMESPACES,
    ],
    true
  );
  if (refs.exitCode === 0) {
    for (const line of refs.stdout.split("\n")) {
      const [name, object] = line.split("\0");
      if (name && object && OBJECT_ID_PATTERN.test(object)) {
        found.push({ name, object });
      }
    }
  }
  for (const name of PSEUDO_REFS) {
    const resolved = runGit(
      path,
      [...overrides, "rev-parse", "--verify", "--quiet", name],
      true
    );
    const object = resolved.stdout.trim();
    if (resolved.exitCode === 0 && OBJECT_ID_PATTERN.test(object)) {
      found.push({ name, object });
    }
  }
  return found;
};

// The branch's configuration section in the shared local configuration,
// which branch deletion removes and restore puts back.
const branchConfigurationOf = (
  primary: string,
  branch: string | null,
  overrides: readonly string[]
): ArchiveBranchConfig[] => {
  if (branch === null) {
    return [];
  }
  const listed = runGit(
    primary,
    [
      ...overrides,
      "config",
      "--local",
      "-z",
      "--get-regexp",
      `^branch\\.${branch.replace(EXTENDED_REGEX_SPECIALS, "\\$&")}\\.`,
    ],
    true
  );
  if (listed.exitCode !== 0) {
    return [];
  }
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const split = entry.indexOf("\n");
      return split < 0
        ? { key: entry, value: "" }
        : { key: entry.slice(0, split), value: entry.slice(split + 1) };
    })
    .filter((entry) => entry.key.startsWith(`branch.${branch}.`));
};

/**
 * Confirms the callback-free boundary and re-reads the verified checkout
 * inside it before a cleanup writes or removes anything, and refuses the
 * whole run when the boundary cannot be confirmed or the checkout changed.
 * Returns what the checkout's own refs name and its branch configuration:
 * the last Git commands that run in the source before `git worktree
 * remove`, so that nothing rewrites it between the archive copy and the
 * comparison that precedes removal.
 */
export const assertReviewedReplacementUnchanged = (
  verified: VerifiedReplacementLineage
): ReviewedSourceState => {
  assertPlainGitEnvironment();
  const overrides = callbackFreeOverrides(
    verified.primaryCheckout,
    verified.worktree.path
  );
  const drift = reviewedCheckoutDrift(verified, overrides);
  if (drift) {
    throw boundaryRefusal(
      verified.worktree.path,
      `${drift}. Review the checkout again and write a new receipt.`
    );
  }
  return {
    branchConfig: branchConfigurationOf(
      verified.primaryCheckout,
      verified.worktree.branch,
      overrides
    ),
    namedObjects: namedObjectsOf(verified.worktree.path, overrides),
  };
};

export interface ReplacementLineageRemovalOptions {
  approvedBy: string;
  cleanupId: string | null;
  command: "prune" | "worktree-cleanup";
  commonGitDirectory: string;
  controllerAgentId: string;
  errors: string[];
  reason: string;
  /** From `assertReviewedReplacementUnchanged`, read just before this call. */
  source: ReviewedSourceState;
  verified: VerifiedReplacementLineage;
}

const summarizeDifferences = (differences: readonly string[]): string => {
  const shown = differences.slice(0, DIFFERENCE_SUMMARY_LIMIT).join("; ");
  const more = differences.length - DIFFERENCE_SUMMARY_LIMIT;
  return more > 0 ? `${shown}; and ${more} more` : shown;
};

interface ArchivedSource {
  directory: string;
  /** Why the pins are incomplete, or null; the manifest lists what was pinned. */
  failure: string | null;
  manifest: WorktreeArchiveManifest;
}

const zeroObject = (object: string): string => "0".repeat(object.length);

// Pins the head and every object the checkout named under the archive's own
// namespace, each created only when absent and without dereferencing, so
// two archives never share a pin and nothing outside the namespace moves.
const pinArchive = (
  verified: VerifiedReplacementLineage,
  source: ReviewedSourceState,
  candidates: readonly string[],
  archiveId: string,
  overrides: readonly string[]
): { failure: string | null; pinRefs: ArchivePinRef[] } => {
  const primary = verified.primaryCheckout;
  const { headSha, branch, path } = verified.worktree;
  const namespace = archivePinNamespace(archiveId);
  const pinRefs: ArchivePinRef[] = [];
  const write = (ref: string, object: string): string | null => {
    const written = runGit(
      primary,
      [
        ...overrides,
        "update-ref",
        "--no-deref",
        "-m",
        `simple-changes: archive ${archiveId} of ${branch ?? path}`,
        ref,
        object,
        zeroObject(object),
      ],
      true
    );
    if (written.exitCode !== 0) {
      return `Could not pin ${object} at ${ref}: ${written.stderr.trim()}`;
    }
    const readBack = runGit(
      primary,
      [...overrides, "rev-parse", "--verify", "--quiet", ref],
      true
    ).stdout.trim();
    if (readBack !== object) {
      return `Pinned ${ref}, but it reads back as ${readBack || "nothing"}, not ${object}.`;
    }
    pinRefs.push({ object, ref });
    return null;
  };
  const headFailure = write(`${namespace}/head`, headSha);
  if (headFailure) {
    return { failure: headFailure, pinRefs };
  }
  const objects = new Set<string>([
    ...source.namedObjects.map((named) => named.object),
    ...candidates,
  ]);
  objects.delete(headSha);
  for (const object of [...objects].sort()) {
    const known = runGit(
      primary,
      [...overrides, "cat-file", "-t", object],
      true
    );
    if (known.exitCode !== 0) {
      continue;
    }
    const failure = write(`${namespace}/objects/${object}`, object);
    if (failure) {
      return { failure, pinRefs };
    }
  }
  return { failure: null, pinRefs };
};

// Measures and bounds the checkout again, copies it and its private Git
// directory into a new archive, pins what it names, and writes the manifest.
// A size, space or copy problem leaves no archive; a pin problem leaves the
// archive with the pins it got and reports it.
const archiveSource = (
  verified: VerifiedReplacementLineage,
  source: ReviewedSourceState,
  removalId: string,
  overrides: readonly string[]
): ArchivedSource => {
  const { archive, commonGitDirectory, receipt, receiptDigest, worktree } =
    verified;
  const bytes =
    measureTree(worktree.path).bytes +
    measureTree(archive.privateGitDirectory).bytes;
  assertArchiveCapacity({
    bytes,
    maxArchiveBytes: archive.maxArchiveBytes,
    root: worktreeArchivesRoot(commonGitDirectory),
  });
  const createdAt = new Date();
  const archiveId = newArchiveId(createdAt, receiptDigest);
  const copy = copyWorktreeIntoArchive({
    archiveId,
    checkoutPath: worktree.path,
    commonGitDirectory,
    privateGitDirectory: archive.privateGitDirectory,
  });
  const pins = pinArchive(
    verified,
    source,
    copy.objectIdCandidates,
    archiveId,
    overrides
  );
  const manifest: WorktreeArchiveManifest = {
    archiveId,
    branchConfig: source.branchConfig,
    checkout: copy.checkout,
    commonGitDirectory,
    createdAt: createdAt.toISOString(),
    expiresAt: archive.expiresAt,
    gitDirectory: copy.gitDirectory,
    kind: "worktree-archive",
    pinRefs: pins.pinRefs,
    privateGitDirectory: archive.privateGitDirectory,
    receiptDigest,
    removalId,
    replacementCommits: [
      ...new Set(receipt.commits.flatMap((entry) => entry.replacementCommits)),
    ].sort(),
    repositoryId: verified.repositoryId,
    retention: {
      days: archive.retention.days,
      maxTotalBytes: archive.retention.maxTotalBytes,
    },
    schemaVersion: 1,
    source: {
      branch: worktree.branch,
      changeDigest: worktree.changeDigest,
      headSha: worktree.headSha,
      path: worktree.path,
    },
    targetRef: receipt.targetRef,
  };
  writeWorktreeArchiveManifest(copy.directory, manifest);
  return { directory: copy.directory, failure: pins.failure, manifest };
};

// A test-only seam: a change to the checkout between the archive copy and
// the comparison that precedes removal, which the comparison must catch.
const changeAfterArchiveForTests = (): void => {
  const target = process.env.SIMPLE_CHANGES_TEST_MUTATE_AFTER_ARCHIVE;
  if (process.env.NODE_ENV === "test" && target) {
    writeFileSync(target, "changed after the archive\n");
  }
};

// Why the archived checkout no longer matches its manifest, or null: a file
// comparison only, so no Git command touches the source between the copy
// and the removal, then the registry read from the primary.
const liveDrift = (
  verified: VerifiedReplacementLineage,
  manifest: WorktreeArchiveManifest,
  overrides: readonly string[]
): string | null => {
  const differences = compareLiveWithManifest(manifest);
  if (differences.length > 0) {
    return `it changed after it was archived (${summarizeDifferences(differences)})`;
  }
  return registrationDrift(verified, overrides);
};

// Deletes the source branch only while no checkout has it checked out and it
// still points at the pinned head, with an exact old-value ref update rather
// than a forced branch deletion, never following a symbolic ref, inside the
// callback-free boundary. Its configuration section goes with it, as
// `git branch -d` does; the manifest holds the entries for restore.
const deleteReviewedBranch = (
  verified: VerifiedReplacementLineage,
  branch: string,
  overrides: readonly string[],
  stepErrors: string[]
): boolean => {
  const primary = verified.primaryCheckout;
  const { headSha } = verified.worktree;
  const user = listedWorktrees(primary, overrides).find(
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
    [
      ...overrides,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}^{commit}`,
    ],
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
    [
      ...overrides,
      "update-ref",
      "--no-deref",
      "-d",
      `refs/heads/${branch}`,
      headSha,
    ],
    true
  );
  if (deleted.exitCode !== 0) {
    stepErrors.push(
      `Could not delete reviewed replacement branch ${branch}; its head stays pinned in the archive: ${deleted.stderr.trim()}`
    );
    return false;
  }
  runGit(
    primary,
    [...overrides, "config", "--remove-section", `branch.${branch}`],
    true
  );
  return true;
};

/**
 * Removes a verified source checkout without forcing anything, with every
 * Git command inside the callback-free boundary, and reversibly: it measures
 * and bounds the archive, copies the checkout folder and its private Git
 * directory into `<common>/simple-changes/archives/<id>/` with a verified
 * manifest, pins the reviewed head and every object the checkout named under
 * `refs/simple-changes/archives/<id>/`, records the intent, compares the
 * live files with the manifest as the last step before plain `git worktree
 * remove` (no Git command runs in the source in between), deletes the
 * branch only while it still points at the pinned head and no other
 * checkout uses it, and records the outcome. A failure at any step stops
 * the later ones and is reported; a failure before the archive is complete
 * leaves no archive, and one after it keeps the archive. Callers run it
 * before every other removal and stop the run when the checkout was not
 * removed.
 */
export const removeReviewedReplacement = (
  options: ReplacementLineageRemovalOptions
): ReplacementLineageOutcome => {
  const { errors, source, verified } = options;
  const outcome = plannedReplacementLineage(verified);
  const { path, branch } = verified.worktree;
  const primary = verified.primaryCheckout;
  const overrides = callbackFreeOverrides(primary, path);
  assertPlainGitEnvironment();
  const removalId = `lineage-${randomUUID()}`;
  let archived: ArchivedSource;
  try {
    archived = archiveSource(verified, source, removalId, overrides);
  } catch (error) {
    if (error instanceof SimpleChangesError) {
      errors.push(
        `${path} was preserved; no archive was made. ${error.message}`
      );
      return outcome;
    }
    throw error;
  }
  const { manifest } = archived;
  outcome.archive = {
    ...outcome.archive,
    archiveId: manifest.archiveId,
    path: archived.directory,
  };
  outcome.pinRefs = manifest.pinRefs.map((pin) => pin.ref);
  if (archived.failure) {
    errors.push(
      `${path} was preserved. ${archived.failure} Archive ${manifest.archiveId} at ${archived.directory} is complete and expires at ${manifest.expiresAt}.`
    );
    return outcome;
  }
  const base = {
    approvedBy: options.approvedBy,
    archive: {
      archiveId: manifest.archiveId,
      bytes: outcome.archive.bytes,
      expiresAt: manifest.expiresAt,
      path: archived.directory,
      retention: manifest.retention,
    },
    byteProof: verified.byteProof,
    cleanupId: options.cleanupId,
    command: options.command,
    controllerAgentId: options.controllerAgentId,
    kind: "replacement-lineage-removal" as const,
    pinRefs: manifest.pinRefs,
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
  changeAfterArchiveForTests();
  const stepErrors: string[] = [];
  const drift = liveDrift(verified, manifest, overrides);
  if (drift) {
    stepErrors.push(
      `Preserved reviewed replacement checkout ${path}: ${drift}. Archive ${manifest.archiveId} and its pins stay until they expire (${manifest.expiresAt}); review the checkout again, or prune the archive with \`simple-changes worktree prune-archives --archive ${manifest.archiveId}\`.`
    );
  } else {
    const removal = runGit(
      primary,
      [...overrides, "worktree", "remove", path],
      true
    );
    if (removal.exitCode === 0) {
      outcome.worktreeRemoved = true;
    } else {
      stepErrors.push(
        `Reviewed replacement checkout ${path} was not removed by this run (${removal.stderr.trim() || removal.stdout.trim()}); Git may have deleted some of its files or unregistered it, so inspect the folder and \`git worktree list\`. Archive ${manifest.archiveId} restores it: \`simple-changes worktree restore-archive --archive ${manifest.archiveId}\`.`
      );
    }
  }
  if (outcome.worktreeRemoved && branch) {
    outcome.branchDeleted = deleteReviewedBranch(
      verified,
      branch,
      overrides,
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
