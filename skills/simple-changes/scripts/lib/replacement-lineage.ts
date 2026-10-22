import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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
import { parseWorktreeList } from "./inventory.ts";
import { runGit } from "./process.ts";
import { headCoverage, readReviewLedger } from "./review-ledger.ts";
import { validateSchema } from "./schema.ts";
import type {
  RepositoryInventory,
  WorktreeClaim,
  WorktreeInventory,
} from "./types.ts";
import { readWorktreeTakeovers } from "./worktree-coordination.ts";

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
  /** The primary checkout every removal Git command runs from. */
  primaryCheckout: string;
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
// checkout (its current owner and every owner a takeover replaced, along the
// whole chain), and every agent the review ledger attests for a unique commit,
// directly, through a replay record's sources, or in a completion's records.
const assertIndependence = (
  context: ReplacementLineageContext,
  unique: readonly string[],
  refuse: Refuse
): void => {
  const { approval, review, source } = context.receipt;
  const authors = new Set<string>([source.authorAgentId.trim()]);
  const claimIds = new Set<string>();
  for (const entry of context.claims) {
    if (entry.path === source.path) {
      claimIds.add(entry.claimId);
      authors.add(entry.owner.agentId.trim());
    }
  }
  for (const takeover of readWorktreeTakeovers(
    context.inventory.repository.commonGitDirectory
  )) {
    if (takeover.path === source.path || claimIds.has(takeover.claimId)) {
      authors.add(takeover.previousOwner.agentId.trim());
      authors.add(takeover.newAgentId.trim());
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
    primaryCheckout: primary,
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
// after it was read: clean status, the reviewed head and branch, still
// registered and unlocked, and no other checkout on its branch.
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

/**
 * Confirms the callback-free boundary and re-reads the verified checkout
 * inside it before a cleanup writes or removes anything, and refuses the
 * whole run when the boundary cannot be confirmed or the checkout changed.
 */
export const assertReviewedReplacementUnchanged = (
  verified: VerifiedReplacementLineage
): void => {
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
};

export interface ReplacementLineageRemovalOptions {
  approvedBy: string;
  cleanupId: string | null;
  command: "prune" | "worktree-cleanup";
  commonGitDirectory: string;
  controllerAgentId: string;
  errors: string[];
  reason: string;
  verified: VerifiedReplacementLineage;
}

// Deletes the source branch only while no checkout has it checked out and it
// still points at the pinned head, with an exact old-value ref update rather
// than a forced branch deletion, inside the callback-free boundary.
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
    [...overrides, "update-ref", "-d", `refs/heads/${branch}`, headSha],
    true
  );
  if (deleted.exitCode !== 0) {
    stepErrors.push(
      `Could not delete reviewed replacement branch ${branch}; its head stays pinned at ${verified.pinRef}: ${deleted.stderr.trim()}`
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
 * Git command inside the callback-free boundary: it confirms the boundary,
 * pins the reviewed head under
 * `refs/simple-changes/superseded/replacement-lineage-<receipt digest>/<head>`
 * so the source history survives, records the intent, re-reads the checkout
 * (status first, then head and branch) as the last step before plain
 * `git worktree remove`, deletes the branch only while it still points at
 * the pinned head and no other checkout uses it, and records the outcome. A
 * failure at any step stops the later ones and is reported; callers run it
 * before every other removal and stop the run when the checkout was not
 * removed.
 */
export const removeReviewedReplacement = (
  options: ReplacementLineageRemovalOptions
): ReplacementLineageOutcome => {
  const { errors, verified } = options;
  const outcome = plannedReplacementLineage(verified);
  const { path, headSha, branch } = verified.worktree;
  const primary = verified.primaryCheckout;
  const overrides = callbackFreeOverrides(primary, path);
  const pinned = runGit(
    primary,
    [
      ...overrides,
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
      [...overrides, "rev-parse", "--verify", "--quiet", verified.pinRef],
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
  const drift = reviewedCheckoutDrift(verified, overrides);
  if (drift) {
    stepErrors.push(
      `Preserved reviewed replacement checkout ${path}: ${drift}. The reviewed head stays pinned at ${verified.pinRef}.`
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
        `Could not remove reviewed replacement checkout ${path}: ${removal.stderr.trim() || removal.stdout.trim()}`
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
