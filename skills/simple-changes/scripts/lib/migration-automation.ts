import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { assertNoSymlinkAncestors } from "./path-safety.ts";
import type { MigrationTarget, RepoPolicy } from "./types.ts";

export interface MigrationOperation {
  contentDigest: string;
  revision: string;
}

export interface MigrationOperationSet {
  digest: string;
  operations: MigrationOperation[];
}

export interface MigrationApplyPlan extends MigrationOperationSet {
  adapter: string;
  command: string[];
  executableDigest: string;
  expiresAt: string;
  issuedAt: string;
  nonce: string;
  remoteLedger: MigrationOperationSet & {
    observedAt: string;
    target: MigrationTarget;
  };
  scope: "exact-listed-operations";
  target: MigrationTarget;
}

export interface MigrationReview {
  backupOrRollbackVerified: boolean;
  destructive: boolean;
  irreversible: boolean;
  lockHeavy: boolean;
  operations: MigrationOperationSet;
  postApplyVerificationPlanned: boolean;
  reviewed: boolean;
  routine: boolean;
  target: MigrationTarget;
  unboundedDataChange: boolean;
}

export type MigrationAutomationAction =
  | "review-required"
  | "request-target-authorization"
  | "request-apply-authorization"
  | "auto-apply"
  | "preserve";

export interface MigrationAutomationDecision {
  action: MigrationAutomationAction;
  authorizationDigest?: string;
  authorizedByPolicy: boolean;
  authorizedCommand?: string[];
  authorizedExecutableDigest?: string;
  authorizedOperations: MigrationOperation[];
  reason: string;
}

const sameTarget = (left: MigrationTarget, right: MigrationTarget): boolean =>
  left.provider === right.provider &&
  left.project === right.project &&
  left.environment === right.environment;

const targetLabel = (target: MigrationTarget): string =>
  `${target.provider}/${target.project}/${target.environment}`;

const exactCommandArguments = (
  operations: MigrationOperation[],
  target: MigrationTarget
): string[] => [
  "apply-exact",
  "--target",
  targetLabel(target),
  ...canonicalOperations(operations).flatMap((operation) => [
    "--revision",
    operation.revision,
    "--digest",
    operation.contentDigest,
  ]),
];

const commandIsExact = (applyPlan: MigrationApplyPlan): boolean => {
  if (applyPlan.adapter !== "exact-operation-argv-v1") {
    return false;
  }
  const [executable, ...arguments_] = applyPlan.command;
  return (
    Boolean(executable && isAbsolute(executable)) &&
    JSON.stringify(arguments_) ===
      JSON.stringify(
        exactCommandArguments(applyPlan.operations, applyPlan.target)
      )
  );
};

const executableDigestMatches = (applyPlan: MigrationApplyPlan): boolean => {
  const [executable] = applyPlan.command;
  if (!(executable && isAbsolute(executable))) {
    return false;
  }
  let descriptor: number | null = null;
  try {
    // biome-ignore-start lint/suspicious/noBitwiseOperators: POSIX open flags are a bitmask.
    const openFlags =
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
    // biome-ignore-end lint/suspicious/noBitwiseOperators: POSIX open flags are a bitmask.
    descriptor = openSync(executable, openFlags);
    const status = fstatSync(descriptor);
    return (
      status.isFile() &&
      realpathSync(executable) === executable &&
      createHash("sha256").update(readFileSync(descriptor)).digest("hex") ===
        applyPlan.executableDigest
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
  }
};

const canonicalOperations = (
  operations: MigrationOperation[]
): MigrationOperation[] =>
  [...operations].sort((left, right) =>
    left.revision.localeCompare(right.revision)
  );

export const migrationOperationDigest = (
  operations: MigrationOperation[]
): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalOperations(operations)))
    .digest("hex");

const exactOperationSet = (
  reviewed: MigrationOperationSet,
  pending: MigrationOperationSet
): boolean => {
  const reviewedOperations = canonicalOperations(reviewed.operations);
  const pendingOperations = canonicalOperations(pending.operations);
  return (
    reviewed.digest === migrationOperationDigest(reviewedOperations) &&
    pending.digest === migrationOperationDigest(pendingOperations) &&
    reviewed.digest === pending.digest &&
    JSON.stringify(reviewedOperations) === JSON.stringify(pendingOperations)
  );
};

const hardExclusions = (review: MigrationReview): string[] => {
  const exclusions: string[] = [];
  if (review.destructive) {
    exclusions.push("destructive or data-deleting operations");
  }
  if (review.irreversible) {
    exclusions.push("an irreversible migration");
  }
  if (review.lockHeavy) {
    exclusions.push("lock-heavy operations");
  }
  if (review.unboundedDataChange) {
    exclusions.push("an unbounded data change or backfill");
  }
  if (!review.backupOrRollbackVerified) {
    exclusions.push("missing verified backup or rollback evidence");
  }
  if (!review.postApplyVerificationPlanned) {
    exclusions.push("missing post-apply verification");
  }
  return exclusions;
};

export const decideMigrationAutomation = (
  policy: RepoPolicy,
  review: MigrationReview,
  pending: MigrationOperationSet,
  applyPlan: MigrationApplyPlan,
  now = new Date()
): MigrationAutomationDecision => {
  if (!review.reviewed) {
    return {
      action: "review-required",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason:
        "Review the exact pending migration operations before deciding whether they may be applied.",
    };
  }
  if (!exactOperationSet(review.operations, pending)) {
    return {
      action: "review-required",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason:
        "The reviewed migration identity does not match the exact fresh pending revision set; review the current operations again.",
    };
  }
  if (!exactOperationSet(pending, applyPlan)) {
    return {
      action: "review-required",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason:
        "The current apply plan is not scoped to exactly the reviewed pending operations; broad or changed apply commands require review and explicit authority.",
    };
  }
  if (
    !(
      sameTarget(review.target, applyPlan.target) &&
      sameTarget(review.target, applyPlan.remoteLedger.target) &&
      exactOperationSet(pending, applyPlan.remoteLedger)
    )
  ) {
    return {
      action: "review-required",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason:
        "The apply plan is not bound to a fresh remote ledger for the exact reviewed target.",
    };
  }
  const nowMs = now.getTime();
  const issuedAt = Date.parse(applyPlan.issuedAt);
  const expiresAt = Date.parse(applyPlan.expiresAt);
  const observedAt = Date.parse(applyPlan.remoteLedger.observedAt);
  if (
    !(
      Number.isFinite(issuedAt) &&
      Number.isFinite(expiresAt) &&
      Number.isFinite(observedAt)
    ) ||
    issuedAt > nowMs ||
    observedAt > nowMs ||
    nowMs - observedAt > 5 * 60 * 1000 ||
    expiresAt <= nowMs ||
    expiresAt - issuedAt > 15 * 60 * 1000 ||
    !applyPlan.nonce.trim() ||
    !applyPlan.adapter.trim() ||
    applyPlan.command.length === 0 ||
    applyPlan.command.some((argument) => !argument.trim()) ||
    !commandIsExact(applyPlan) ||
    !executableDigestMatches(applyPlan)
  ) {
    return {
      action: "review-required",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason:
        "The apply plan command binding or remote-ledger freshness window is invalid; regenerate exact execution evidence.",
    };
  }
  if (policy.migrationHandling === "never") {
    return {
      action: "preserve",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason:
        "Migration application is disabled by policy; preserve the reviewed migration and report it.",
    };
  }
  if (policy.migrationHandling === "ask-after-review") {
    return {
      action: "request-apply-authorization",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason:
        "The migration review passed, but policy requires approval before applying it to the exact reviewed target.",
    };
  }
  const targetAuthorized = policy.migrationTargets.some((target) =>
    sameTarget(target, review.target)
  );
  if (!targetAuthorized) {
    return {
      action: "request-target-authorization",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason: `The reviewed target ${targetLabel(review.target)} is not bound to the saved migration policy.`,
    };
  }
  const exclusions = hardExclusions(review);
  if (exclusions.length > 0) {
    return {
      action: "request-apply-authorization",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason: `Automatic apply is excluded because the review found ${exclusions.join(", ")}.`,
    };
  }
  if (
    policy.migrationHandling === "auto-apply-reviewed-routine" &&
    !review.routine
  ) {
    return {
      action: "request-apply-authorization",
      authorizedByPolicy: false,
      authorizedOperations: [],
      reason:
        "The migration passed review but is not routine, so this policy tier requires approval before apply.",
    };
  }
  return {
    action: "auto-apply",
    authorizationDigest: createHash("sha256")
      .update(
        JSON.stringify({
          adapter: applyPlan.adapter,
          command: applyPlan.command,
          executableDigest: applyPlan.executableDigest,
          expiresAt: applyPlan.expiresAt,
          nonce: applyPlan.nonce,
          operations: canonicalOperations(applyPlan.operations),
          remoteLedger: applyPlan.remoteLedger,
          target: applyPlan.target,
        })
      )
      .digest("hex"),
    authorizedByPolicy: true,
    authorizedCommand: [...applyPlan.command],
    authorizedExecutableDigest: applyPlan.executableDigest,
    authorizedOperations: canonicalOperations(applyPlan.operations),
    reason: review.routine
      ? "The exact target is bound and the reviewed migration meets every routine automatic-apply requirement."
      : "The exact target is bound and the migration passed the broader reviewed-eligible automatic-apply requirements.",
  };
};

export const consumeMigrationAuthorization = (
  commonGitDirectory: string,
  decision: MigrationAutomationDecision
): string => {
  if (
    decision.action !== "auto-apply" ||
    !decision.authorizationDigest ||
    !decision.authorizedCommand
  ) {
    throw new SimpleChangesError(
      "Only an exact automatic migration authorization can be consumed.",
      EXIT_CODES.validation
    );
  }
  const directory = resolve(
    commonGitDirectory,
    "simple-changes",
    "migration-authorizations"
  );
  assertNoSymlinkAncestors(
    commonGitDirectory,
    "simple-changes/migration-authorizations"
  );
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const receiptPath = resolve(
    directory,
    `${decision.authorizationDigest}.json`
  );
  try {
    writeFileSync(
      receiptPath,
      `${JSON.stringify(
        {
          authorizationDigest: decision.authorizationDigest,
          command: decision.authorizedCommand,
          consumedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    throw SimpleChangesError.withCause(
      "This migration authorization was already consumed or could not be recorded; regenerate fresh pending, review, ledger, nonce, and command evidence.",
      EXIT_CODES.unsafe,
      error
    );
  }
  return receiptPath;
};

export const applyMigrationAuthorization = (
  commonGitDirectory: string,
  repository: string,
  decision: MigrationAutomationDecision
): {
  authorizationDigest: string;
  exitCode: number;
  stderr: string;
  stdout: string;
} => {
  if (
    decision.action !== "auto-apply" ||
    !decision.authorizationDigest ||
    !decision.authorizedCommand ||
    !decision.authorizedExecutableDigest
  ) {
    throw new SimpleChangesError(
      "Only an exact automatic migration authorization can be applied.",
      EXIT_CODES.validation
    );
  }
  const [executable, ...arguments_] = decision.authorizedCommand;
  if (!executable) {
    throw new SimpleChangesError(
      "The exact migration executable is missing.",
      EXIT_CODES.validation
    );
  }
  const directory = resolve(
    commonGitDirectory,
    "simple-changes",
    "migration-authorizations"
  );
  assertNoSymlinkAncestors(
    commonGitDirectory,
    "simple-changes/migration-authorizations"
  );
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const executableBytes = readFileSync(executable);
  if (
    createHash("sha256").update(executableBytes).digest("hex") !==
    decision.authorizedExecutableDigest
  ) {
    throw new SimpleChangesError(
      "The migration adapter changed before execution; regenerate exact evidence.",
      EXIT_CODES.unsafe
    );
  }
  const snapshotPath = resolve(
    directory,
    `${decision.authorizationDigest}.adapter`
  );
  writeFileSync(snapshotPath, executableBytes, { flag: "wx", mode: 0o700 });
  chmodSync(snapshotPath, 0o700);
  try {
    consumeMigrationAuthorization(commonGitDirectory, decision);
    const result = spawnSync(snapshotPath, arguments_, {
      cwd: repository,
      encoding: "utf8",
      env: process.env,
      shell: false,
    });
    if (result.error) {
      throw SimpleChangesError.withCause(
        "The consumed exact migration adapter could not start.",
        EXIT_CODES.unsafe,
        result.error
      );
    }
    const exitCode = result.status ?? EXIT_CODES.unsafe;
    if (exitCode !== 0) {
      throw new SimpleChangesError(
        `The consumed exact migration adapter failed with exit code ${exitCode}: ${result.stderr.trim()}`,
        EXIT_CODES.unsafe
      );
    }
    return {
      authorizationDigest: decision.authorizationDigest,
      exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    if (existsSync(snapshotPath)) {
      unlinkSync(snapshotPath);
    }
  }
};

export const migrationAuthorizationConsumed = (
  commonGitDirectory: string,
  authorizationDigest: string
): boolean =>
  existsSync(
    assertNoSymlinkAncestors(
      commonGitDirectory,
      `simple-changes/migration-authorizations/${authorizationDigest}.json`
    )
  );
