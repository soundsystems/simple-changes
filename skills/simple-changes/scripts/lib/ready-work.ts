import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { revisionContainmentMethod } from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import { runGit } from "./process.ts";
import { redactSecrets } from "./redact.ts";
import { validateSchema } from "./schema.ts";
import type {
  ReadyWorkCheck,
  ReadyWorkReceipt,
  ReadyWorkReleaseImpact,
  RepositoryInventory,
  WorktreeClaim,
} from "./types.ts";
import {
  assertNoGitOperation,
  readCoordinationDocumentFromCommonDirectory,
  releaseClaimUnderLock,
  withWorktreeCoordinationLock,
  worktreeCoordinationDirectory,
} from "./worktree-coordination.ts";

const READY_RECEIPTS_FILENAME = "ready-receipts.json";
const RELEASE_IMPACTS = new Set<ReadyWorkReleaseImpact>([
  "none",
  "patch",
  "minor",
  "major",
  "unknown",
]);
const CHECK_RESULTS = new Set<ReadyWorkCheck["result"]>([
  "passed",
  "failed",
  "skipped",
]);
const INPUT_KEYS = new Set([
  "checks",
  "deploymentConstraints",
  "migrations",
  "releaseImpact",
  "scope",
  "unresolvedAuthority",
]);
// A claim in one of these states still guards a present checkout, so its
// owner may declare that checkout ready.
const READY_CLAIM_STATES = new Set<WorktreeClaim["state"]>([
  "active",
  "attached",
  "resume-ready",
]);

export const readyReceiptsPath = (commonGitDirectory: string): string =>
  resolve(
    worktreeCoordinationDirectory(commonGitDirectory),
    READY_RECEIPTS_FILENAME
  );

export const readReadyReceipts = (
  commonGitDirectory: string
): ReadyWorkReceipt[] => {
  const path = readyReceiptsPath(commonGitDirectory);
  if (!existsSync(path)) {
    return [];
  }
  const records = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(records)) {
    throw new SimpleChangesError(
      "Ready-work receipts are not a record list.",
      EXIT_CODES.unsafe
    );
  }
  return records.map((record) =>
    validateSchema<ReadyWorkReceipt>("ready-work-receipt", record)
  );
};

const writeReadyReceipts = (
  commonGitDirectory: string,
  receipts: ReadyWorkReceipt[]
): void => {
  const root = worktreeCoordinationDirectory(commonGitDirectory);
  mkdirSync(root, { mode: 0o700, recursive: true });
  const temporaryPath = resolve(
    root,
    `${READY_RECEIPTS_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  );
  writeFileSync(temporaryPath, `${JSON.stringify(receipts, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, readyReceiptsPath(commonGitDirectory));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedText = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new SimpleChangesError(
      `Ready receipt ${name} must be non-empty text.`,
      EXIT_CODES.validation
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > 500) {
    throw new SimpleChangesError(
      `Ready receipt ${name} must be at most 500 characters.`,
      EXIT_CODES.validation
    );
  }
  if (redactSecrets(trimmed) !== trimmed) {
    throw new SimpleChangesError(
      `Ready receipt ${name} must not contain credentials or secrets.`,
      EXIT_CODES.unsafe
    );
  }
  return trimmed;
};

const textList = (value: unknown, name: string): string[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 50) {
    throw new SimpleChangesError(
      `Ready receipt ${name} must be a list of at most 50 entries.`,
      EXIT_CODES.validation
    );
  }
  return value.map((item, index) => boundedText(item, `${name}[${index}]`));
};

const readyChecks = (value: unknown): ReadyWorkCheck[] => {
  if (!Array.isArray(value) || value.length > 50) {
    throw new SimpleChangesError(
      "Ready receipt checks must be a list of at most 50 completed checks.",
      EXIT_CODES.validation
    );
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new SimpleChangesError(
        `Ready receipt checks[${index}] must be an object.`,
        EXIT_CODES.validation
      );
    }
    const result = item.result as ReadyWorkCheck["result"];
    if (!CHECK_RESULTS.has(result)) {
      throw new SimpleChangesError(
        `Ready receipt checks[${index}].result must be passed, failed, or skipped.`,
        EXIT_CODES.validation
      );
    }
    return {
      command: boundedText(item.command, `checks[${index}].command`),
      note:
        item.note === undefined || item.note === null
          ? null
          : boundedText(item.note, `checks[${index}].note`),
      result,
    };
  });
};

export interface ReadyWorkInput {
  checks: ReadyWorkCheck[];
  deploymentConstraints: string[];
  migrations: string[];
  releaseImpact: ReadyWorkReleaseImpact;
  scope: string;
  unresolvedAuthority: string[];
}

/**
 * Parse the author-written half of a ready-work receipt. The runtime binds
 * the claim, branch, head, and digest itself; the author never supplies them.
 */
export const parseReadyWorkInput = (value: unknown): ReadyWorkInput => {
  if (!isRecord(value)) {
    throw new SimpleChangesError(
      "Ready receipt input must be a JSON object.",
      EXIT_CODES.validation
    );
  }
  const unknown = Object.keys(value).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new SimpleChangesError(
      `Ready receipt input has unsupported field(s): ${unknown.join(", ")}. The runtime records the claim, branch, head, and digest itself.`,
      EXIT_CODES.validation
    );
  }
  const releaseImpact = value.releaseImpact as ReadyWorkReleaseImpact;
  if (!RELEASE_IMPACTS.has(releaseImpact)) {
    throw new SimpleChangesError(
      "Ready receipt releaseImpact must be none, patch, minor, major, or unknown.",
      EXIT_CODES.validation
    );
  }
  return {
    checks: readyChecks(value.checks),
    deploymentConstraints: textList(
      value.deploymentConstraints,
      "deploymentConstraints"
    ),
    migrations: textList(value.migrations, "migrations"),
    releaseImpact,
    scope: boundedText(value.scope, "scope"),
    unresolvedAuthority: textList(
      value.unresolvedAuthority,
      "unresolvedAuthority"
    ),
  };
};

export type ReadyWorkFreshness = "current" | "stale" | "shipped";

export interface ReadyWorkStatus {
  detail: string;
  freshness: ReadyWorkFreshness;
  receipt: ReadyWorkReceipt;
}

const resolveCommit = (root: string, ref: string): string | null => {
  const result = runGit(
    root,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    true
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
};

const readyFreshness = (
  inventory: RepositoryInventory,
  receipt: ReadyWorkReceipt
): Omit<ReadyWorkStatus, "receipt"> => {
  const root = inventory.repository.primaryCheckout;
  const target = resolveCommit(root, inventory.targetRef);
  const method = target
    ? revisionContainmentMethod(root, target, receipt.headSha)
    : null;
  if (method) {
    return {
      detail: `${inventory.targetRef} already contains ${receipt.headSha} (${method}).`,
      freshness: "shipped",
    };
  }
  const branchHead = resolveCommit(root, `refs/heads/${receipt.branch}`);
  if (branchHead !== receipt.headSha) {
    return {
      detail: branchHead
        ? `Branch ${receipt.branch} moved to ${branchHead} after the receipt; ask the owner for a new one.`
        : `Branch ${receipt.branch} no longer exists locally.`,
      freshness: "stale",
    };
  }
  const worktree = inventory.worktrees.find(
    (item) => item.path === receipt.path
  );
  if (
    worktree &&
    (worktree.branch !== receipt.branch ||
      worktree.changeDigest !== receipt.changeDigest)
  ) {
    return {
      detail: `Checkout ${receipt.path} changed after the receipt; ask the owner for a new one.`,
      freshness: "stale",
    };
  }
  return {
    detail: `Branch ${receipt.branch} is still at the receipted commit.`,
    freshness: "current",
  };
};

export interface ReadyWorkRecordResult {
  claim: WorktreeClaim;
  receipt: ReadyWorkReceipt;
}

const readyClaim = (
  commonGitDirectory: string,
  agentId: string,
  claimId: string
): WorktreeClaim => {
  const document =
    readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
  const claim = document.claims.find((item) => item.claimId === claimId);
  if (!claim || claim.owner.agentId !== agentId) {
    throw new SimpleChangesError(
      "Only the exact claim owner may record ready work for this claim.",
      EXIT_CODES.unsafe
    );
  }
  if (!READY_CLAIM_STATES.has(claim.state)) {
    throw new SimpleChangesError(
      `Claim ${claimId} is ${claim.state}; ready work requires an active claim on a present checkout.`,
      EXIT_CODES.unsafe
    );
  }
  return claim;
};

/**
 * Record a ready-work receipt for the owner's clean, committed checkout and
 * hand its claim off in the same coordination-lock interval, so a controller
 * never sees a released claim without the receipt that explains it.
 */
export const recordReadyWork = (
  repositoryPath: string,
  agentIdInput: string,
  claimIdInput: string,
  input: ReadyWorkInput
): ReadyWorkRecordResult => {
  const agentId = agentIdInput.trim();
  const claimId = claimIdInput.trim();
  const { commonGitDirectory } = locateRepository(repositoryPath).repository;
  return withWorktreeCoordinationLock(
    commonGitDirectory,
    "worktree ready",
    () => {
      const claim = readyClaim(commonGitDirectory, agentId, claimId);
      const inventory = captureInventory(repositoryPath);
      const current = inventory.worktrees.find(
        (item) => item.path === claim.path
      );
      if (
        !(current?.branch && current.headSha) ||
        current.detached ||
        current.changes.length > 0
      ) {
        throw new SimpleChangesError(
          "Ready work requires the claimed checkout to be present, attached to a branch, and clean: commit every change first.",
          EXIT_CODES.unsafe
        );
      }
      assertNoGitOperation(current.path);
      const receipt = validateSchema<ReadyWorkReceipt>("ready-work-receipt", {
        branch: current.branch,
        changeDigest: current.changeDigest,
        checks: input.checks,
        claimId: claim.claimId,
        deploymentConstraints: input.deploymentConstraints,
        headSha: current.headSha,
        migrations: input.migrations,
        owner: claim.owner,
        path: current.path,
        receiptId: `ready-${randomUUID()}`,
        recordedAt: new Date().toISOString(),
        releaseImpact: input.releaseImpact,
        schemaVersion: 1,
        scope: input.scope,
        unresolvedAuthority: input.unresolvedAuthority,
      });
      // Keep one receipt per claim and drop the ones the target already
      // contains, so the file only holds handoffs a controller still plans.
      writeReadyReceipts(commonGitDirectory, [
        ...readReadyReceipts(commonGitDirectory).filter(
          (item) =>
            item.claimId !== claim.claimId &&
            readyFreshness(inventory, item).freshness !== "shipped"
        ),
        receipt,
      ]);
      // Ready work is a completed-work handoff. `handoff` with the exact
      // receipted evidence lets an active loop that admitted this author keep
      // integrating, and older installed clients already accept the reason.
      const released = releaseClaimUnderLock(
        commonGitDirectory,
        claim.claimId,
        agentId,
        "handoff",
        {
          branch: current.branch,
          changeDigest: current.changeDigest,
          headSha: current.headSha,
        }
      );
      return { claim: released, receipt };
    }
  );
};

/** Evaluate every recorded receipt against fresh Git evidence. */
export const readyWorkStatus = (
  inventory: RepositoryInventory
): ReadyWorkStatus[] =>
  readReadyReceipts(inventory.repository.commonGitDirectory).map((receipt) => ({
    ...readyFreshness(inventory, receipt),
    receipt,
  }));
