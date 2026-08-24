import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideEmergencyShipping,
  deriveEmergencyShippingStatus,
} from "./emergency-shipping.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256, sha256Json } from "./hash.ts";
import { captureInventory } from "./inventory.ts";
import {
  assertNoSymlinkAncestors,
  assertSafeRelativePath,
} from "./path-safety.ts";
import { validatePlanConservation } from "./planner.ts";
import {
  type CommandProcess,
  type CommandResult,
  GuardedProcessGroupStillAliveError,
  runCommandInProcessGroup,
  runGit,
} from "./process.ts";
import {
  remoteInventoryDigest,
  validateOpeningRemoteInventory,
  validatePostCleanupRecovery,
  validateRemoteBranchReconciliation,
} from "./remote-branch-reconciliation.ts";
import { validateSchema, validateSchemaDocument } from "./schema.ts";
import type {
  ChangePlan,
  EmergencyShippingLedgerEntry,
  LoopCloseEquivalentOutcome,
  LoopCloseEquivalentWorktreeProof,
  LoopControllerLifecycle,
  LoopLease,
  LoopOverride,
  LoopVerification,
  LoopViolation,
  LoopWorktreeDisposition,
  LoopWorktreeLease,
  LoopWorktreePreparation,
  PostCleanupRecoveryReceipt,
  RemoteBranchReconciliationReceipt,
  RepositoryInventory,
  RequestMode,
  ShipmentOutcomeReceipt,
  WorktreeClaim,
  WorktreeCoordinationDocument,
  WorktreeInventory,
} from "./types.ts";
import {
  type AbsentWorktreeClaimRetirementPlan,
  coordinationEvidence,
  coordinationLinkIsCurrent,
  markCoordinationAdopted,
  markCoordinationResumeReady,
  planAbsentWorktreeClaimRetirementUnderLock,
  readCoordinationDocumentFromCommonDirectory,
  recoverStaleWorktreeCoordinationLock,
  retireAbsentWorktreeClaimsUnderLock,
  withWorktreeCoordinationLock,
  worktreeClaimDocumentDigest,
} from "./worktree-coordination.ts";

const STATE_DIRECTORY = "simple-changes";
const STATE_FILENAME = "active-loop.json";
const LOCK_DIRECTORY = "active-loop.lock";
const LOCK_OWNER_FILENAME = "owner.json";
const RECOVERY_HISTORY_DIRECTORY = "history";
const STALE_LOCK_MINIMUM_AGE_MS = 5000;
const RUN_ID_PATTERN = /^run-[a-z0-9-]+$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const PERMISSION_DENIED_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
const SCP_REMOTE_URL_PATTERN = /^[^@/\s]+@([^:/\s]+):(.+)$/u;
const REMOTE_PROJECT_PATH_PATTERN = /^\/+|\.git\/?$/gu;
const LS_TREE_ENTRY_PATTERN = /^(\d+)\s+(blob|commit)\s+([0-9a-f]+)\t/u;
const LOOP_MODES = new Set<RequestMode>([
  "queue",
  "sweep",
  "integrate",
  "ship",
  "reconcile",
  "resume",
]);
const REMOTE_RECONCILIATION_MODES = new Set<LoopLease["mode"]>([
  "integrate",
  "ship",
  "reconcile",
  "resume",
]);
const AUTOMATIC_CLEANUP_MODES = REMOTE_RECONCILIATION_MODES;
const MISSING_OPENING_REMOTE_INVENTORY_BLOCKER =
  "Cannot end a legacy GitLab loop without its opening remote inventory; only approved post-cleanup recovery may close it. Next: run `simple-changes loop recover-post-cleanup` when cleanup is already complete, or `simple-changes loop close-equivalent` when the work is already contained in the target.";
const MISSING_REMOTE_RECONCILIATION_BLOCKER =
  "Cannot end a GitLab integration loop before recording a complete remote-branch reconciliation receipt.";

interface PostCleanupRecoveryIntent {
  archivedAt: string;
  authority: "close-only";
  claimRetirement: AbsentWorktreeClaimRetirementPlan;
  kind: "post-cleanup-recovery";
  lease: LoopLease;
  leaseDigest: string;
  receipt: PostCleanupRecoveryReceipt;
  receiptDigest: string;
  removedWorktreePaths: string[];
  runId: string;
  schemaVersion: 1;
}

const permissionDeniedLoopStateError = (
  lockPath: string,
  error: unknown
): SimpleChangesError | null => {
  const { code } = error as NodeJS.ErrnoException;
  if (!(code && PERMISSION_DENIED_CODES.has(code))) {
    return null;
  }
  return SimpleChangesError.withCause(
    `Simple Changes could not write local controller state at ${lockPath} because the harness or filesystem denied permission (${code}). This is not lock contention: do not pause other authors or recover/delete controller state. Fix the exact local permission and retry.`,
    EXIT_CODES.unsafe,
    error
  );
};

const stateDirectory = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY);

const recoveryHistoryDirectory = (
  commonGitDirectory: string,
  runId: string
): string =>
  assertNoSymlinkAncestors(
    commonGitDirectory,
    join(STATE_DIRECTORY, RECOVERY_HISTORY_DIRECTORY, requiredRunId(runId))
  );

const recoveryHistoryPath = (
  commonGitDirectory: string,
  runId: string,
  event: "intent" | "completed"
): string =>
  resolve(recoveryHistoryDirectory(commonGitDirectory, runId), `${event}.json`);

const readImmutableRecoveryEvent = <T extends object>(path: string): T => {
  let descriptor: number;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are a bitmask.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw SimpleChangesError.withCause(
      `Recovery audit event must be an existing regular file, not a link or special file: ${path}`,
      EXIT_CODES.unsafe,
      error
    );
  }
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new SimpleChangesError(
        `Recovery audit event must be a regular file: ${path}`,
        EXIT_CODES.unsafe
      );
    }
    return JSON.parse(readFileSync(descriptor, "utf8")) as T;
  } finally {
    closeSync(descriptor);
  }
};

const writeImmutableRecoveryEvent = <T extends object>(
  path: string,
  value: T
): T => {
  if (existsSync(path)) {
    return readImmutableRecoveryEvent<T>(path);
  }
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return value;
};

export const loopLeasePath = (commonGitDirectory: string): string =>
  resolve(stateDirectory(commonGitDirectory), STATE_FILENAME);

export const loopLockPath = (commonGitDirectory: string): string =>
  resolve(stateDirectory(commonGitDirectory), LOCK_DIRECTORY);

const loopLockOwnerPath = (commonGitDirectory: string): string =>
  resolve(loopLockPath(commonGitDirectory), LOCK_OWNER_FILENAME);

export interface LoopLockOwner {
  childProcessId?: number;
  childStarting?: boolean;
  createdAt: string;
  hostname: string;
  operation: string;
  pid: number;
  processGroupId?: number;
  token: string;
}

const readLockOwner = (commonGitDirectory: string): LoopLockOwner | null => {
  const path = loopLockOwnerPath(commonGitDirectory);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<LoopLockOwner>;
    if (
      typeof parsed.createdAt === "string" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.operation === "string" &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      (parsed.childProcessId === undefined ||
        (typeof parsed.childProcessId === "number" &&
          Number.isInteger(parsed.childProcessId) &&
          parsed.childProcessId > 0)) &&
      (parsed.childStarting === undefined ||
        typeof parsed.childStarting === "boolean") &&
      (parsed.processGroupId === undefined ||
        (typeof parsed.processGroupId === "number" &&
          Number.isInteger(parsed.processGroupId) &&
          parsed.processGroupId > 0)) &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
    ) {
      return parsed as LoopLockOwner;
    }
  } catch {
    return null;
  }
  return null;
};

interface StateLock {
  release: () => void;
  retain: () => void;
  update: (updates: Partial<LoopLockOwner>) => LoopLockOwner;
}

const writeLockOwner = (
  commonGitDirectory: string,
  owner: LoopLockOwner,
  exclusive: boolean
): void => {
  const ownerPath = loopLockOwnerPath(commonGitDirectory);
  if (exclusive) {
    writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return;
  }
  const temporaryPath = resolve(
    loopLockPath(commonGitDirectory),
    `${LOCK_OWNER_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  );
  writeFileSync(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, ownerPath);
};

const acquireStateLock = (
  commonGitDirectory: string,
  operationName: string
): StateLock => {
  const directory = stateDirectory(commonGitDirectory);
  const lockPath = loopLockPath(commonGitDirectory);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const owner = readLockOwner(commonGitDirectory);
      const detail = owner
        ? ` PID ${owner.pid} on ${owner.hostname} has held ${owner.operation} since ${owner.createdAt}.`
        : " Its ownership metadata is missing or invalid.";
      throw SimpleChangesError.withCause(
        `Active-loop state is busy at ${lockPath}.${detail} Retry after it finishes, or use loop recover only after proving the owner process is dead.`,
        EXIT_CODES.unsafe,
        error
      );
    }
    const permissionError = permissionDeniedLoopStateError(lockPath, error);
    if (permissionError) {
      throw permissionError;
    }
    throw error;
  }
  let owner: LoopLockOwner = {
    createdAt: new Date().toISOString(),
    hostname: hostname(),
    operation: operationName,
    pid: process.pid,
    token: randomUUID(),
  };
  let retained = false;
  try {
    writeLockOwner(commonGitDirectory, owner, true);
  } catch (error) {
    rmSync(lockPath, { force: true, recursive: true });
    const permissionError = permissionDeniedLoopStateError(lockPath, error);
    if (permissionError) {
      throw permissionError;
    }
    throw error;
  }
  return {
    release: () => {
      if (retained) {
        return;
      }
      const currentOwner = readLockOwner(commonGitDirectory);
      if (currentOwner?.token === owner.token) {
        rmSync(lockPath, { force: true, recursive: true });
      }
    },
    retain: () => {
      const currentOwner = readLockOwner(commonGitDirectory);
      if (currentOwner?.token !== owner.token) {
        throw new SimpleChangesError(
          "Active-loop lock ownership changed before it could be retained.",
          EXIT_CODES.unsafe
        );
      }
      retained = true;
    },
    update: (updates) => {
      const currentOwner = readLockOwner(commonGitDirectory);
      if (currentOwner?.token !== owner.token) {
        throw new SimpleChangesError(
          "Active-loop lock ownership changed during the guarded operation.",
          EXIT_CODES.unsafe
        );
      }
      owner = { ...owner, ...updates };
      writeLockOwner(commonGitDirectory, owner, false);
      return owner;
    },
  };
};

const withStateLock = <T>(
  commonGitDirectory: string,
  operationName: string,
  operation: () => T
): T => {
  const lock = acquireStateLock(commonGitDirectory, operationName);
  try {
    return operation();
  } finally {
    lock.release();
  }
};

const withAsyncStateLock = async <T>(
  commonGitDirectory: string,
  operationName: string,
  operation: (lock: StateLock) => Promise<T>
): Promise<T> => {
  const lock = acquireStateLock(commonGitDirectory, operationName);
  try {
    return await operation(lock);
  } finally {
    lock.release();
  }
};

const readLeaseFromCommonDirectory = (
  commonGitDirectory: string
): LoopLease | null => {
  const path = loopLeasePath(commonGitDirectory);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  const legacyReconciliation = parsed.remoteBranchReconciliation;
  if (
    legacyReconciliation &&
    typeof legacyReconciliation === "object" &&
    !(
      "initialCoverage" in legacyReconciliation &&
      "finalCoverage" in legacyReconciliation
    )
  ) {
    // A pre-0.12.2 receipt cannot prove complete paginated coverage. Keep the
    // controller recoverable, but force fresh reconciliation before finalize.
    Reflect.deleteProperty(parsed, "remoteBranchReconciliation");
  }
  return validateSchema<LoopLease>("loop-lease", parsed);
};

const writeLease = (lease: LoopLease): LoopLease => {
  const validated = validateSchema<LoopLease>("loop-lease", lease);
  const directory = stateDirectory(validated.commonGitDirectory);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const temporaryPath = resolve(
    directory,
    `${STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  );
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, loopLeasePath(validated.commonGitDirectory));
  return validated;
};

const requiredText = (value: string, name: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SimpleChangesError(`${name} is required.`, EXIT_CODES.usage);
  }
  return trimmed;
};

const controllerLifecycle = (lease: LoopLease): LoopControllerLifecycle =>
  lease.controller ?? {
    acquiredAt: lease.createdAt,
    handoffs: [],
    reason: null,
    relinquishedAt: null,
    status: "active",
  };

const effectiveShipmentScopeFrozenAt = (lease: LoopLease): string | null => {
  if (lease.shipmentScopeFrozenAt !== undefined) {
    return lease.shipmentScopeFrozenAt;
  }
  const lifecycle = controllerLifecycle(lease);
  if (lifecycle.status === "relinquished") {
    return lifecycle.relinquishedAt ?? lifecycle.acquiredAt;
  }
  return lifecycle.handoffs.at(0)?.at ?? null;
};

const assertControllerActive = (lease: LoopLease): void => {
  if (controllerLifecycle(lease).status === "relinquished") {
    throw new SimpleChangesError(
      `Integration-controller loop ${lease.runId} was relinquished by ${lease.ownerAgentId}; resume it with a new controller before mutating it. Next: start the loop again in resume mode to continue its frozen shipment, or run \`simple-changes loop close-equivalent --run-id ${lease.runId} --approved-by <you> --reason <why>\` if the work is already contained in the target.`,
      EXIT_CODES.unsafe
    );
  }
};

const assertNewAuthorPreparationAllowed = (lease: LoopLease): void => {
  const frozenAt = effectiveShipmentScopeFrozenAt(lease);
  if (frozenAt) {
    throw new SimpleChangesError(
      `Shipment scope for ${lease.runId} froze when its controller relinquished at ${frozenAt}. A resumed controller may finish registered work, reconcile, deploy, clean up, and close this shipment, but cannot prepare a new author for a later shipment. Close this loop and start a fresh one. Next: if this work is already contained in the target, run \`simple-changes loop close-equivalent --run-id ${lease.runId} --approved-by <you> --reason <why>\`.`,
      EXIT_CODES.unsafe
    );
  }
};

const transferController = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  nextAgentId: string,
  kind: "resume" | "takeover",
  reason: string,
  approvedBy: string | null
): LoopLease => {
  const currentPath = inventory.repository.currentCheckout;
  if (!lease.worktrees.some((worktree) => worktree.path === currentPath)) {
    throw new SimpleChangesError(
      `Controller transfer must run from a worktree registered in ${lease.runId}: ${currentPath}.`,
      EXIT_CODES.unsafe
    );
  }
  const now = new Date().toISOString();
  const previous = controllerLifecycle(lease);
  const frozenAt = effectiveShipmentScopeFrozenAt(lease);
  const mayRebindLegacyDestinations =
    !lease.remoteBindings &&
    (previous.status === "relinquished" ||
      (kind === "takeover" && approvedBy !== null));
  if (!(lease.remoteBindings || mayRebindLegacyDestinations)) {
    throw new SimpleChangesError(
      "Legacy controller transfer requires an explicit relinquished resume or user-authorized takeover before binding current remote destinations.",
      EXIT_CODES.unsafe
    );
  }
  return writeLease({
    ...lease,
    controller: {
      acquiredAt: now,
      handoffs: [
        ...previous.handoffs,
        {
          approvedBy,
          at: now,
          fromAgentId: lease.ownerAgentId,
          kind,
          reason,
          toAgentId: nextAgentId,
        },
      ],
      reason: null,
      relinquishedAt: null,
      status: "active",
    },
    openingBranches:
      lease.openingBranches ??
      inventory.branches.map(({ name, sha }) => ({ name, sha })),
    ownerAgentId: nextAgentId,
    remoteBindings: lease.remoteBindings ?? inventory.repository.remoteBindings,
    shipmentScopeFrozenAt:
      frozenAt ??
      (previous.status === "relinquished"
        ? (previous.relinquishedAt ?? now)
        : null),
    updatedAt: now,
    worktrees: lease.worktrees.map((worktree) => {
      if (worktree.path === currentPath) {
        return {
          ...worktree,
          agentId: nextAgentId,
          mutationAllowed: true,
          role: "controller",
        };
      }
      if (worktree.role === "controller") {
        return {
          ...worktree,
          agentId: null,
          mutationAllowed: false,
          role: "preserved",
        };
      }
      return worktree;
    }),
  });
};

const requiredRunId = (value: string): string => {
  const runId = requiredText(value, "run ID");
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new SimpleChangesError(
      "run ID must match run-[a-z0-9-]+.",
      EXIT_CODES.usage
    );
  }
  return runId;
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
};

const processGroupIsAlive = (processGroupId: number): boolean => {
  if (process.platform === "win32") {
    return true;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
};

export interface LoopLockRecovery {
  coordinationRecovered: boolean;
  recovered: boolean;
  recoveredAt: string;
  staleOwner: LoopLockOwner;
}

export const recoverLoopLock = (
  repositoryPath: string,
  agentIdInput: string
): LoopLockRecovery => {
  const agentId = requiredText(agentIdInput, "agent ID");
  const inventory = captureInventory(repositoryPath);
  const { commonGitDirectory } = inventory.repository;
  const lockPath = loopLockPath(commonGitDirectory);
  if (!existsSync(lockPath)) {
    throw new SimpleChangesError(
      "No active-loop lock exists to recover.",
      EXIT_CODES.unsafe
    );
  }
  const owner = readLockOwner(commonGitDirectory);
  if (!owner) {
    throw new SimpleChangesError(
      `Cannot recover ${lockPath}: ownership metadata is missing or invalid. Inspect it manually rather than guessing.`,
      EXIT_CODES.unsafe
    );
  }
  if (owner.hostname !== hostname()) {
    throw new SimpleChangesError(
      `Cannot recover a lock owned on ${owner.hostname} from ${hostname()}.`,
      EXIT_CODES.unsafe
    );
  }
  const age = Date.now() - Date.parse(owner.createdAt);
  if (!(Number.isFinite(age) && age >= STALE_LOCK_MINIMUM_AGE_MS)) {
    throw new SimpleChangesError(
      `Cannot recover a lock younger than ${STALE_LOCK_MINIMUM_AGE_MS / 1000} seconds.`,
      EXIT_CODES.unsafe
    );
  }
  if (processIsAlive(owner.pid)) {
    throw new SimpleChangesError(
      `Cannot recover active lock owner PID ${owner.pid}.`,
      EXIT_CODES.unsafe
    );
  }
  if (owner.childStarting) {
    throw new SimpleChangesError(
      "Cannot recover a loop-exec lock whose child launch did not finish recording. Inspect the operation manually before removing the lock.",
      EXIT_CODES.unsafe
    );
  }
  if (
    owner.processGroupId !== undefined &&
    processGroupIsAlive(owner.processGroupId)
  ) {
    throw new SimpleChangesError(
      `Cannot recover active guarded process group ${owner.processGroupId}.`,
      EXIT_CODES.unsafe
    );
  }
  if (
    owner.processGroupId === undefined &&
    owner.childProcessId !== undefined &&
    processIsAlive(owner.childProcessId)
  ) {
    throw new SimpleChangesError(
      `Cannot recover active guarded child PID ${owner.childProcessId}.`,
      EXIT_CODES.unsafe
    );
  }
  const lease = readLeaseFromCommonDirectory(commonGitDirectory);
  if (lease && lease.ownerAgentId !== agentId) {
    throw new SimpleChangesError(
      `Only loop owner ${lease.ownerAgentId} may recover its dead lock.`,
      EXIT_CODES.unsafe
    );
  }
  const coordinationRecovered = recoverStaleWorktreeCoordinationLock(
    commonGitDirectory,
    owner.pid
  );
  const recoveryPath = `${lockPath}.recovery-${randomUUID()}`;
  renameSync(lockPath, recoveryPath);
  rmSync(recoveryPath, { force: true, recursive: true });
  return {
    coordinationRecovered,
    recovered: true,
    recoveredAt: new Date().toISOString(),
    staleOwner: owner,
  };
};

const slug = (value: string, fallback: string): string => {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || fallback;
};

const worktreeLease = (
  worktree: WorktreeInventory,
  role: LoopWorktreeLease["role"],
  agentId: string | null,
  createdByRun: boolean
): LoopWorktreeLease => ({
  agentId,
  baselineChangeDigest: worktree.changeDigest,
  baselineHeadSha: worktree.headSha,
  branch: worktree.branch,
  createdByRun,
  mutationAllowed: role !== "preserved" && role !== "retained",
  path: worktree.path,
  role,
});

const assertMatchingRun = (lease: LoopLease, runId: string): void => {
  if (lease.runId !== requiredRunId(runId)) {
    throw new SimpleChangesError(
      `Active loop is ${lease.runId}, not ${runId}. Refusing to act on a different lease.`,
      EXIT_CODES.unsafe
    );
  }
};

const matchingOverride = (
  lease: LoopLease,
  worktree: WorktreeInventory
): LoopOverride | undefined =>
  lease.overrides.find(
    (override) =>
      override.path === worktree.path &&
      override.headSha === worktree.headSha &&
      override.changeDigest === worktree.changeDigest
  );

const resolvedCurrentTargetRevision = (lease: LoopLease): string | null => {
  const result = runGit(
    lease.primaryCheckout,
    ["rev-parse", "--verify", `${lease.targetRef}^{commit}`],
    true
  );
  const revision = result.stdout.trim();
  return result.exitCode === 0 && revision ? revision : null;
};

const matchingRemovalDisposition = (
  lease: LoopLease,
  worktree: WorktreeInventory
): LoopWorktreeDisposition | undefined =>
  (lease.dispositions ?? []).find(
    (disposition) =>
      disposition.outcome === "remove-after-audit" &&
      disposition.path === worktree.path &&
      disposition.branch === worktree.branch &&
      disposition.headSha === worktree.headSha &&
      disposition.changeDigest === worktree.changeDigest &&
      disposition.targetRef === lease.targetRef &&
      disposition.targetRevision === resolvedCurrentTargetRevision(lease)
  );

const removalDispositionForPath = (
  lease: LoopLease,
  path: string
): LoopWorktreeDisposition | undefined =>
  (lease.dispositions ?? []).find(
    (disposition) =>
      disposition.outcome === "remove-after-audit" &&
      disposition.path === path &&
      disposition.targetRef === lease.targetRef &&
      disposition.targetRevision === resolvedCurrentTargetRevision(lease)
  );

const targetBranchForRef = (
  repositoryPath: string,
  targetRef: string
): string | null => {
  const resolved = runGit(
    repositoryPath,
    ["rev-parse", "--symbolic-full-name", targetRef],
    true
  );
  const symbolicRef = resolved.exitCode === 0 ? resolved.stdout.trim() : "";
  if (symbolicRef.startsWith("refs/heads/")) {
    return symbolicRef.slice("refs/heads/".length);
  }
  if (symbolicRef.startsWith("refs/remotes/")) {
    const remoteAndBranch = symbolicRef.slice("refs/remotes/".length);
    const separator = remoteAndBranch.indexOf("/");
    return separator === -1 ? null : remoteAndBranch.slice(separator + 1);
  }
  const separator = targetRef.indexOf("/");
  if (separator !== -1) {
    const remote = targetRef.slice(0, separator);
    const remotes = runGit(repositoryPath, ["remote"], true)
      .stdout.split("\n")
      .filter(Boolean);
    if (remotes.includes(remote)) {
      return targetRef.slice(separator + 1) || null;
    }
  }
  return targetRef || null;
};

const targetUsesGitLab = (inventory: RepositoryInventory): boolean => {
  const { targetRemote } = inventory.repository;
  return Boolean(
    targetRemote &&
      inventory.repository.remoteBindings.some(
        (binding) =>
          binding.name === targetRemote && binding.provider === "gitlab"
      )
  );
};

const targetRemoteForRef = (
  repositoryPath: string,
  targetRef: string
): string | null => {
  const symbolicRef = runGit(repositoryPath, [
    "rev-parse",
    "--symbolic-full-name",
    targetRef,
  ]).stdout.trim();
  if (!symbolicRef.startsWith("refs/remotes/")) {
    return null;
  }
  const remoteAndBranch = symbolicRef.slice("refs/remotes/".length);
  const separator = remoteAndBranch.indexOf("/");
  return separator === -1 ? null : remoteAndBranch.slice(0, separator);
};

const projectPathFromRemoteUrl = (remoteUrl: string): string | null => {
  const scpLike = remoteUrl.match(SCP_REMOTE_URL_PATTERN);
  let path: string;
  if (scpLike) {
    path = scpLike[2] ?? "";
  } else {
    try {
      path = new URL(remoteUrl).pathname;
    } catch {
      return null;
    }
  }
  const normalized = path.replace(REMOTE_PROJECT_PATH_PATTERN, "");
  return normalized.includes("/") ? normalized : null;
};

const gitLabProjectForTargetRef = (
  repositoryPath: string,
  targetRef: string
): string | null => {
  const remote = targetRemoteForRef(repositoryPath, targetRef);
  if (remote) {
    const remoteUrl = runGit(repositoryPath, [
      "config",
      "--get",
      `remote.${remote}.url`,
    ]).stdout.trim();
    return remoteUrl ? projectPathFromRemoteUrl(remoteUrl) : null;
  }
  const gitLabProjects = runGit(repositoryPath, ["remote"])
    .stdout.split("\n")
    .filter(Boolean)
    .map((candidate) =>
      runGit(repositoryPath, [
        "config",
        "--get",
        `remote.${candidate}.url`,
      ]).stdout.trim()
    )
    .filter((remoteUrl) => remoteUrl.toLowerCase().includes("gitlab"))
    .map(projectPathFromRemoteUrl)
    .filter((project): project is string => project !== null);
  return gitLabProjects.length === 1 ? (gitLabProjects[0] ?? null) : null;
};

const currentTargetRevision = (lease: LoopLease): string => {
  const revision = resolvedCurrentTargetRevision(lease);
  if (!revision) {
    throw new SimpleChangesError(
      `Cannot resolve current target ${lease.targetRef}.`,
      EXIT_CODES.unsafe
    );
  }
  return revision;
};

const assertCurrentRemoteBranchReconciliation = (
  lease: LoopLease,
  inventory: RepositoryInventory
): void => {
  if (targetUsesGitLab(inventory) && !lease.openingRemoteInventory) {
    throw new SimpleChangesError(
      MISSING_OPENING_REMOTE_INVENTORY_BLOCKER,
      EXIT_CODES.unsafe
    );
  }
  if (
    !(
      REMOTE_RECONCILIATION_MODES.has(lease.mode) && targetUsesGitLab(inventory)
    )
  ) {
    return;
  }
  const receipt = lease.remoteBranchReconciliation;
  if (!receipt) {
    throw new SimpleChangesError(
      MISSING_REMOTE_RECONCILIATION_BLOCKER,
      EXIT_CODES.unsafe
    );
  }
  validateRemoteBranchReconciliation(receipt);
  const targetBranch = targetBranchForRef(
    inventory.repository.primaryCheckout,
    lease.targetRef
  );
  const targetRevision = currentTargetRevision(lease);
  const project = gitLabProjectForTargetRef(
    inventory.repository.primaryCheckout,
    lease.targetRef
  );
  if (
    receipt.provider !== "gitlab" ||
    receipt.project !== project ||
    receipt.targetBranch !== targetBranch ||
    receipt.targetRevision !== targetRevision
  ) {
    throw new SimpleChangesError(
      "Cannot end the loop with a stale or mismatched remote-branch reconciliation receipt; refresh every GitLab branch and record the final accounted inventory again.",
      EXIT_CODES.unsafe
    );
  }
};

const concurrentClaimFor = (
  lease: Pick<
    LoopLease,
    "commonGitDirectory" | "concurrentWork" | "primaryCheckout"
  >,
  worktree: WorktreeInventory,
  document: WorktreeCoordinationDocument,
  primaryBranch: string | null,
  targetBranch: string | null
): WorktreeClaim | undefined => {
  if (
    lease.concurrentWork !== "allow-claimed" ||
    worktree.isPrimary ||
    worktree.path === lease.primaryCheckout ||
    !worktree.branch ||
    worktree.branch === primaryBranch ||
    worktree.branch === targetBranch
  ) {
    return;
  }
  return document.claims.find(
    (claim) =>
      claim.commonGitDirectory === lease.commonGitDirectory &&
      claim.path === worktree.path &&
      claim.branch === worktree.branch &&
      claim.state === "active"
  );
};

const withConcurrentAuthorAdmissions = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopLease => {
  if (
    lease.concurrentWork !== "allow-claimed" ||
    effectiveShipmentScopeFrozenAt(lease)
  ) {
    return lease;
  }
  const registeredByPath = new Map(
    lease.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const primaryBranch =
    inventory.worktrees.find(
      (worktree) => worktree.path === lease.primaryCheckout
    )?.branch ?? null;
  const targetBranch = targetBranchForRef(
    lease.primaryCheckout,
    lease.targetRef
  );
  const admissions = new Map<string, LoopWorktreeLease>();
  for (const worktree of inventory.worktrees) {
    const claim = concurrentClaimFor(
      lease,
      worktree,
      coordination,
      primaryBranch,
      targetBranch
    );
    if (!claim) {
      continue;
    }
    const registered = registeredByPath.get(worktree.path);
    if (
      registered &&
      registered.role !== "preserved" &&
      registered.role !== "retained"
    ) {
      continue;
    }
    admissions.set(worktree.path, {
      ...worktreeLease(
        worktree,
        "concurrent-author",
        claim.owner.agentId,
        false
      ),
      claimId: claim.claimId,
    });
  }
  if (admissions.size === 0) {
    return lease;
  }
  return {
    ...lease,
    updatedAt: new Date().toISOString(),
    worktrees: [
      ...lease.worktrees.map(
        (worktree) => admissions.get(worktree.path) ?? worktree
      ),
      ...[...admissions.values()].filter(
        (worktree) => !registeredByPath.has(worktree.path)
      ),
    ],
  };
};

const concurrentClaimViolations = (
  registered: LoopWorktreeLease,
  concurrentClaim: WorktreeClaim | undefined,
  worktree: WorktreeInventory
): LoopViolation[] => {
  if (
    registered.role !== "concurrent-author" ||
    (concurrentClaim &&
      concurrentClaim.claimId === registered.claimId &&
      concurrentClaim.owner.agentId === registered.agentId)
  ) {
    return [];
  }
  return [
    {
      changeDigest: worktree.changeDigest,
      code: "coordination-claim-stale",
      headSha: worktree.headSha,
      message:
        "A concurrent author worktree lost or changed its active ownership claim. Refresh the original claim or use strict paused-worktree coordination before integration continues.",
      path: worktree.path,
    },
  ];
};

const retainedWorktreeViolations = (
  registered: LoopWorktreeLease,
  worktree: WorktreeInventory
): LoopViolation[] => {
  if (registered.role !== "retained") {
    return [];
  }
  const violations: LoopViolation[] = [];
  if (!registered.retention) {
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "retained-worktree-authorization-missing",
      headSha: worktree.headSha,
      message:
        "A retained excluded worktree has no approval receipt. Record exact retention evidence before cleanup can exempt it.",
      path: worktree.path,
    });
  }
  if (
    registered.baselineHeadSha !== worktree.headSha ||
    registered.baselineChangeDigest !== worktree.changeDigest
  ) {
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "retained-worktree-changed",
      headSha: worktree.headSha,
      message:
        "A retained excluded worktree changed. Its owner must claim it as an active concurrent author, or pause it at a stable boundary, before integration continues.",
      path: worktree.path,
    });
  }
  return violations;
};

const unregisteredWorktreeViolations = (
  lease: LoopLease,
  worktree: WorktreeInventory,
  preparation: LoopWorktreePreparation | undefined,
  concurrentClaim: WorktreeClaim | undefined
): LoopViolation[] => {
  if (
    preparation &&
    worktree.branch === preparation.branch &&
    worktree.headSha === preparation.baseRevision
  ) {
    return [];
  }
  if (effectiveShipmentScopeFrozenAt(lease) && concurrentClaim) {
    return [];
  }
  return [
    {
      changeDigest: worktree.changeDigest,
      code: "unregistered-worktree",
      headSha: worktree.headSha,
      message:
        "A worktree appeared after loop start without run registration. Preserve it and prepare an isolated agent worktree instead.",
      path: worktree.path,
    },
  ];
};

const currentWorktreeViolations = (
  lease: LoopLease,
  worktree: WorktreeInventory,
  registered: LoopWorktreeLease | undefined,
  preparation: LoopWorktreePreparation | undefined,
  concurrentClaim: WorktreeClaim | undefined
): LoopViolation[] => {
  if (!registered) {
    return unregisteredWorktreeViolations(
      lease,
      worktree,
      preparation,
      concurrentClaim
    );
  }
  const violations = concurrentClaimViolations(
    registered,
    concurrentClaim,
    worktree
  );
  violations.push(...retainedWorktreeViolations(registered, worktree));
  if (
    registered.role === "preserved" &&
    (registered.baselineHeadSha !== worktree.headSha ||
      registered.baselineChangeDigest !== worktree.changeDigest) &&
    !matchingOverride(lease, worktree) &&
    !matchingRemovalDisposition(lease, worktree)
  ) {
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "preserved-worktree-changed",
      headSha: worktree.headSha,
      message:
        "A baseline worktree changed after loop start. Its exact path and current status digest need a recorded user-approved override before integration continues.",
      path: worktree.path,
    });
  }
  if (
    registered.role === "preserved" &&
    registered.claimId &&
    registered.pauseReceiptId &&
    !coordinationLinkIsCurrent(
      lease.commonGitDirectory,
      registered.claimId,
      registered.pauseReceiptId,
      worktree
    )
  ) {
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "coordination-claim-stale",
      headSha: worktree.headSha,
      message:
        "The adopted worktree claim or pause receipt no longer matches current coordination and Git evidence.",
      path: worktree.path,
    });
  }
  if (
    registered.role === "preserved" &&
    ((registered.claimId && !registered.pauseReceiptId) ||
      (!registered.claimId && registered.pauseReceiptId))
  ) {
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "coordination-claim-stale",
      headSha: worktree.headSha,
      message: "The worktree lease has an incomplete coordination linkage.",
      path: worktree.path,
    });
  }
  if (registered.mutationAllowed && registered.branch !== worktree.branch) {
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "registered-worktree-branch-changed",
      headSha: worktree.headSha,
      message: `A mutation-authorized worktree moved from registered branch ${registered.branch ?? "(detached)"} to ${worktree.branch ?? "(detached)"}. Resume only from its recorded branch.`,
      path: worktree.path,
    });
  }
  return violations;
};

const verificationAgainst = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopVerification => {
  const violations: LoopViolation[] = [];
  if (inventory.repository.commonGitDirectory !== lease.commonGitDirectory) {
    violations.push({
      changeDigest: null,
      code: "common-git-directory-mismatch",
      headSha: inventory.repository.headSha,
      message:
        "The checkout belongs to a different common Git directory than the active loop.",
      path: inventory.repository.currentCheckout,
    });
  }
  if (!lease.remoteBindings) {
    violations.push({
      changeDigest: null,
      code: "remote-destination-rebind-required",
      headSha: inventory.repository.headSha,
      message:
        "This legacy controller predates remote destination binding. Relinquish it and start a current controller before any guarded remote mutation.",
      path: inventory.repository.currentCheckout,
    });
  } else if (
    JSON.stringify(inventory.repository.remoteBindings) !==
    JSON.stringify(lease.remoteBindings)
  ) {
    violations.push({
      changeDigest: null,
      code: "remote-destination-changed",
      headSha: inventory.repository.headSha,
      message:
        "A Git remote fetch or push destination changed after loop start. Re-verify the exact repository destination before starting a new controller lease.",
      path: inventory.repository.currentCheckout,
    });
  }
  const registeredByPath = new Map(
    lease.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const currentByPath = new Map(
    inventory.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const preparationByPath = new Map(
    lease.preparations.map((preparation) => [preparation.path, preparation])
  );
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const primaryBranch =
    inventory.worktrees.find(
      (worktree) => worktree.path === lease.primaryCheckout
    )?.branch ?? null;
  const targetBranch = targetBranchForRef(
    lease.primaryCheckout,
    lease.targetRef
  );
  for (const worktree of inventory.worktrees) {
    const concurrentClaim = concurrentClaimFor(
      lease,
      worktree,
      coordination,
      primaryBranch,
      targetBranch
    );
    violations.push(
      ...currentWorktreeViolations(
        lease,
        worktree,
        registeredByPath.get(worktree.path),
        preparationByPath.get(worktree.path),
        concurrentClaim
      )
    );
  }
  for (const preparation of lease.preparations) {
    violations.push({
      changeDigest: currentByPath.get(preparation.path)?.changeDigest ?? null,
      code: "incomplete-worktree-preparation",
      headSha: currentByPath.get(preparation.path)?.headSha ?? null,
      message:
        "An agent worktree preparation did not finish registration. Resume prepare-agent for that agent before any other mutation.",
      path: preparation.path,
    });
  }
  for (const registered of lease.worktrees) {
    if (
      registered.role === "preserved" &&
      !currentByPath.has(registered.path) &&
      !removalDispositionForPath(lease, registered.path)
    ) {
      violations.push({
        changeDigest: null,
        code: "missing-preserved-worktree",
        headSha: null,
        message:
          "A baseline worktree disappeared after loop start. The loop cannot assume that deletion was safe.",
        path: registered.path,
      });
    }
    if (
      registered.role === "retained" &&
      !currentByPath.has(registered.path) &&
      !removalDispositionForPath(lease, registered.path)
    ) {
      violations.push({
        changeDigest: null,
        code: "missing-retained-worktree",
        headSha: null,
        message:
          "A retained excluded worktree disappeared. The loop cannot assume its removal was safe.",
        path: registered.path,
      });
    }
  }
  return {
    active: true,
    checkedAt: new Date().toISOString(),
    currentBaselineDigest: inventory.baselineDigest,
    ok: violations.length === 0,
    runId: lease.runId,
    violations,
  };
};

const requireLease = (inventory: RepositoryInventory): LoopLease => {
  const lease = readLeaseFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  if (!lease) {
    throw new SimpleChangesError(
      "No active Simple Changes integration loop was found.",
      EXIT_CODES.unsafe
    );
  }
  return withConcurrentAuthorAdmissions(lease, inventory);
};

const assertShipmentScopeRecorded = (lease: LoopLease): void => {
  if (lease.shipmentScopeRequired && !lease.shipmentScope) {
    throw new SimpleChangesError(
      "Record the comprehensive shipment scope before changing shared integration or worktree state.",
      EXIT_CODES.unsafe
    );
  }
};

const assertAgentMutationAllowed = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  agentId: string
): void => {
  assertControllerActive(lease);
  if (targetUsesGitLab(inventory) && !lease.openingRemoteInventory) {
    throw new SimpleChangesError(
      "This legacy run has no opening remote inventory. It is close-only: use approved post-cleanup recovery after proving cleanup is already complete. Next: run `simple-changes loop recover-post-cleanup` when cleanup is already complete, or `simple-changes loop close-equivalent` when the work is already contained in the target.",
      EXIT_CODES.unsafe
    );
  }
  assertShipmentScopeRecorded(lease);
  const currentPath = inventory.repository.currentCheckout;
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === currentPath
  );
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === currentPath
  );
  const integrationAuthorized =
    registered?.role === "controller" || registered?.role === "author";
  if (
    !registered?.mutationAllowed ||
    registered.agentId !== agentId ||
    !integrationAuthorized
  ) {
    throw new SimpleChangesError(
      `Agent ${agentId} is not allowed to run guarded integration mutations from ${currentPath}. The controller and its run-prepared authors may use loop guard or loop exec; independent concurrent authors keep ordinary edits and commits outside the integration executor.`,
      EXIT_CODES.unsafe
    );
  }
  if (!current || current.branch !== registered.branch) {
    throw new SimpleChangesError(
      `Agent ${agentId} must resume ${currentPath} on registered branch ${registered.branch ?? "(detached)"}; current branch is ${current?.branch ?? "(detached or missing)"}.`,
      EXIT_CODES.unsafe
    );
  }
};

export const readLoopLease = (repositoryPath: string): LoopLease | null => {
  const inventory = captureInventory(repositoryPath);
  return readLeaseFromCommonDirectory(inventory.repository.commonGitDirectory);
};

const openingRemoteInventoryForStart = (
  inventory: RepositoryInventory,
  input: unknown,
  targetBranch: string | null,
  targetRevision: string
): RemoteBranchReconciliationReceipt | undefined => {
  const required = targetUsesGitLab(inventory);
  const receipt = input ? validateOpeningRemoteInventory(input) : undefined;
  if (required && !receipt) {
    throw new SimpleChangesError(
      "Start this GitLab integration loop with a complete opening remote inventory; capture it before any provider mutation.",
      EXIT_CODES.unsafe
    );
  }
  if (!receipt) {
    return;
  }
  const project = gitLabProjectForTargetRef(
    inventory.repository.primaryCheckout,
    inventory.targetRef
  );
  if (
    receipt.project !== project ||
    receipt.targetBranch !== targetBranch ||
    receipt.targetRevision !== targetRevision
  ) {
    throw new SimpleChangesError(
      "Opening remote inventory must bind the exact GitLab project, target branch, and opening target revision.",
      EXIT_CODES.validation
    );
  }
  return receipt;
};

const assertLegacyRunAllowsMutation = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  message: string
): void => {
  if (targetUsesGitLab(inventory) && !lease.openingRemoteInventory) {
    throw new SimpleChangesError(message, EXIT_CODES.unsafe);
  }
};

export const startLoop = (
  repositoryPath: string,
  agentIdInput: string,
  mode: RequestMode,
  openingRemoteInventoryInput?: unknown
): LoopLease => {
  const agentId = requiredText(agentIdInput, "agent ID");
  if (!LOOP_MODES.has(mode)) {
    throw new SimpleChangesError(
      "Loop mode must be queue, sweep, integrate, ship, reconcile, or resume.",
      EXIT_CODES.usage
    );
  }
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop start",
    () => {
      const inventory = captureInventory(repositoryPath);
      const existing = readLeaseFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      if (existing) {
        const lifecycle = controllerLifecycle(existing);
        if (
          lifecycle.status === "active" &&
          existing.ownerAgentId === agentId &&
          existing.mode === mode
        ) {
          return existing;
        }
        if (lifecycle.status === "relinquished" && mode === "resume") {
          return transferController(
            existing,
            inventory,
            agentId,
            "resume",
            lifecycle.reason ?? "Resumed relinquished integration loop.",
            null
          );
        }
        if (lifecycle.status === "relinquished") {
          throw new SimpleChangesError(
            `Integration-controller loop ${existing.runId} was relinquished by ${existing.ownerAgentId}. Resume it explicitly to finish or close its frozen shipment; do not reuse it for a later ${mode} shipment. Next: start the loop again in resume mode to finish it, or run \`simple-changes loop close-equivalent --run-id ${existing.runId} --approved-by <you> --reason <why>\` if there is nothing left to ship.`,
            EXIT_CODES.unsafe
          );
        }
        throw new SimpleChangesError(
          `Integration-controller loop ${existing.runId} is already active for ${existing.ownerAgentId}. Independent agents may continue in distinct actively claimed worktrees; start no second push/MR/merge/cleanup controller.`,
          EXIT_CODES.unsafe
        );
      }
      const now = new Date().toISOString();
      const currentPath = inventory.repository.currentCheckout;
      const concurrentWork =
        inventory.policy.value.concurrentWork === "strict"
          ? "strict"
          : "allow-claimed";
      const coordination = readCoordinationDocumentFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      const primaryBranch =
        inventory.worktrees.find((worktree) => worktree.isPrimary)?.branch ??
        null;
      const targetBranch = targetBranchForRef(
        inventory.repository.primaryCheckout,
        inventory.targetRef
      );
      const targetRevision = runGit(inventory.repository.primaryCheckout, [
        "rev-parse",
        "--verify",
        `${inventory.targetRef}^{commit}`,
      ]).stdout.trim();
      const openingRemoteInventory = openingRemoteInventoryForStart(
        inventory,
        openingRemoteInventoryInput,
        targetBranch,
        targetRevision
      );
      const worktrees = inventory.worktrees.map((worktree) => {
        if (worktree.path === currentPath) {
          return worktreeLease(worktree, "controller", agentId, false);
        }
        const claim = concurrentClaimFor(
          {
            commonGitDirectory: inventory.repository.commonGitDirectory,
            concurrentWork,
            primaryCheckout: inventory.repository.primaryCheckout,
          },
          worktree,
          coordination,
          primaryBranch,
          targetBranch
        );
        if (claim) {
          return {
            ...worktreeLease(
              worktree,
              "concurrent-author",
              claim.owner.agentId,
              false
            ),
            claimId: claim.claimId,
          };
        }
        return worktreeLease(worktree, "preserved", null, false);
      });
      const lease: LoopLease = {
        baselineDigest: inventory.baselineDigest,
        commonGitDirectory: inventory.repository.commonGitDirectory,
        concurrentWork,
        controller: {
          acquiredAt: now,
          handoffs: [],
          reason: null,
          relinquishedAt: null,
          status: "active",
        },
        createdAt: now,
        dispositions: [],
        mode: mode as LoopLease["mode"],
        openingBranches: inventory.branches.map(({ name, sha }) => ({
          name,
          sha,
        })),
        ...(openingRemoteInventory ? { openingRemoteInventory } : {}),
        overrides: [],
        ownerAgentId: agentId,
        preparations: [],
        primaryCheckout: inventory.repository.primaryCheckout,
        remoteBindings: inventory.repository.remoteBindings,
        runId: `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        schemaVersion: 1,
        shipmentScopeFrozenAt: null,
        shipmentScopeRequired:
          mode === "ship" && inventory.localChanges.length > 0,
        targetRef: inventory.targetRef,
        targetRevision,
        updatedAt: now,
        worktrees,
      };
      return writeLease(lease);
    }
  );
};

export interface ShipmentScopeReceipt {
  includedPaths: number;
  planDigest: string;
  preservedPaths: number;
  recordedAt: string;
  runId: string;
  summary: string;
}

const shipmentScopeSummary = (
  plan: ChangePlan,
  inventory: RepositoryInventory
): string => {
  const includedPaths = plan.units.reduce(
    (count, unit) => count + unit.paths.length,
    0
  );
  const preservedPaths = plan.preserved.reduce(
    (count, item) => count + item.paths.length,
    0
  );
  const branchFor = (worktreePath: string): string => {
    const worktree = inventory.worktrees.find(
      (candidate) => candidate.path === worktreePath
    );
    return (
      worktree?.branch ??
      (worktree?.headSha
        ? `detached@${worktree.headSha.slice(0, 8)}`
        : "detached")
    );
  };
  const lines = [
    `Pre-ship scope: ${plan.units.length} work item(s), ${includedPaths} changed path(s).`,
    "Included:",
    ...plan.units.map(
      (unit) =>
        `- ${unit.title}: ${unit.outcome} Branch ${branchFor(unit.sourceWorktree)}; worktree ${unit.sourceWorktree}.`
    ),
  ];
  if (plan.preserved.length > 0) {
    lines.push(
      "Preserved:",
      ...plan.preserved.map(
        (item) =>
          `- ${item.reason} Branch ${branchFor(item.worktreePath)}; worktree ${item.worktreePath}.`
      )
    );
  }
  if (plan.exclusions.length > 0) {
    lines.push(
      "Excluded:",
      ...plan.exclusions.map(
        (item) =>
          `- ${item.path}: ${item.reason}${item.worktreePath ? ` Worktree ${item.worktreePath}.` : ""}`
      )
    );
  }
  lines.push(
    `${preservedPaths} path(s) preserved; ${plan.exclusions.length} path(s) explicitly excluded. No changed path is unaccounted for.`
  );
  return lines.join("\n");
};

const worktreeSourceEntry = (
  worktreePath: string,
  path: string
): string | null => {
  assertSafeRelativePath(worktreePath, path);
  const absolutePath = resolve(worktreePath, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (stat.isDirectory()) {
    const revision = runGit(absolutePath, ["rev-parse", "HEAD"], true);
    return revision.exitCode === 0
      ? `160000:commit:${revision.stdout.trim()}`
      : null;
  }
  let objectId: string;
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolutePath, { encoding: "buffer" });
    const objectFormat = runGit(worktreePath, [
      "rev-parse",
      "--show-object-format",
    ]).stdout.trim();
    objectId = createHash(objectFormat)
      .update(`blob ${target.byteLength}\0`)
      .update(target)
      .digest("hex");
  } else {
    objectId = runGit(worktreePath, [
      "hash-object",
      `--path=${path}`,
      "--",
      path,
    ]).stdout.trim();
  }
  const executable = stat.mode
    .toString(8)
    .slice(-3)
    .split("")
    .some((digit) => Number(digit) % 2 === 1);
  let mode = "100644";
  if (stat.isSymbolicLink()) {
    mode = "120000";
  } else if (executable) {
    mode = "100755";
  }
  return `${mode}:blob:${objectId}`;
};

const assertShipmentScopeRecordable = (
  lease: LoopLease,
  plan: ChangePlan,
  inventory: RepositoryInventory,
  refresh: boolean
): void => {
  if (plan.mode !== "preview" || plan.mutationsAllowed) {
    throw new SimpleChangesError(
      "Shipment scope must come from a non-mutating Simple Changes preview plan.",
      EXIT_CODES.validation
    );
  }
  if (refresh && !lease.shipmentScope) {
    throw new SimpleChangesError(
      "Shipment scope refresh requires an existing recorded scope.",
      EXIT_CODES.validation
    );
  }
  if (!refresh && lease.shipmentScope) {
    throw new SimpleChangesError(
      "Shipment scope is already recorded. Use loop refresh-scope after review-driven source changes.",
      EXIT_CODES.unsafe
    );
  }
  if (refresh && lease.shipmentOutcome) {
    throw new SimpleChangesError(
      "Shipment scope cannot be refreshed after an outcome is recorded.",
      EXIT_CODES.unsafe
    );
  }
  const inventoryMatches =
    plan.repositoryRoot === inventory.repository.root &&
    plan.baselineDigest === inventory.baselineDigest;
  const openingMatches =
    refresh || inventory.baselineDigest === lease.baselineDigest;
  if (!(inventoryMatches && openingMatches)) {
    throw new SimpleChangesError(
      refresh
        ? "Refreshed shipment scope must match the exact current repository inventory."
        : "Shipment scope must match the exact unchanged opening repository inventory. Re-run preview before mutation.",
      EXIT_CODES.unsafe
    );
  }
  if (plan.questions.length > 0) {
    throw new SimpleChangesError(
      "Resolve every shipment-scope question before guarded mutation.",
      EXIT_CODES.unsafe
    );
  }
  validatePlanConservation(plan, inventory);
  const existingScope = lease.shipmentScope;
  if (refresh && existingScope) {
    const scoped = new Set(
      existingScope.openingChanges.map(
        (change) => `${change.worktreePath}\0${change.path}`
      )
    );
    const added = inventory.localChanges.find((change) => {
      if (scoped.has(`${change.worktreePath}\0${change.path}`)) {
        return false;
      }
      const entry = worktreeSourceEntry(change.worktreePath, change.path);
      return !existingScope.openingChanges.some(
        (scopedChange) =>
          scopedChange.path === change.path &&
          worktreeSourceEntry(scopedChange.worktreePath, scopedChange.path) ===
            entry
      );
    });
    if (added) {
      throw new SimpleChangesError(
        `Shipment scope refresh cannot add a new path: ${added.path}. Start a new shipment run for expanded scope.`,
        EXIT_CODES.unsafe
      );
    }
  }
};

export const recordShipmentScope = (
  repositoryPath: string,
  runIdInput: string,
  agentIdInput: string,
  planInput: unknown,
  refresh = false
): ShipmentScopeReceipt => {
  const runId = requiredRunId(runIdInput);
  const agentId = requiredText(agentIdInput, "agent ID");
  const plan = validateSchema<ChangePlan>("change-plan", planInput);
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "record shipment scope",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertControllerActive(lease);
      if (lease.runId !== runId || lease.ownerAgentId !== agentId) {
        throw new SimpleChangesError(
          `Only ${lease.ownerAgentId} may record shipment scope for ${lease.runId}.`,
          EXIT_CODES.unsafe
        );
      }
      const frozenAt = effectiveShipmentScopeFrozenAt(lease);
      if (frozenAt && !lease.shipmentScope) {
        throw new SimpleChangesError(
          `Shipment scope for ${lease.runId} froze when its controller relinquished at ${frozenAt}. A resumed controller cannot record a first scope from later repository state. Next: if this work is already contained in the target, run \`simple-changes loop close-equivalent --run-id ${lease.runId} --approved-by <you> --reason <why>\`; otherwise close this loop and start a fresh shipment.`,
          EXIT_CODES.unsafe
        );
      }
      assertShipmentScopeRecordable(lease, plan, inventory, refresh);
      const recordedAt = new Date().toISOString();
      const priorScope = lease.shipmentScope;
      const activePlan =
        refresh && priorScope
          ? {
              ...priorScope.plan,
              baselineDigest: plan.baselineDigest,
              generatedAt: plan.generatedAt,
            }
          : plan;
      const openingChanges =
        refresh && priorScope
          ? priorScope.openingChanges.map(
              ({ originalPath, path, worktreePath }) => ({
                originalPath,
                path,
                sourceEntry: worktreeSourceEntry(worktreePath, path),
                worktreePath,
              })
            )
          : inventory.localChanges.map(
              ({ originalPath, path, worktreePath }) => ({
                originalPath,
                path,
                sourceEntry: worktreeSourceEntry(worktreePath, path),
                worktreePath,
              })
            );
      const planDigest = refresh
        ? sha256Json({ openingChanges, plan: activePlan })
        : sha256Json(activePlan);
      const shipmentScopeHistory = lease.shipmentScope
        ? [
            ...(lease.shipmentScopeHistory ?? []),
            {
              planDigest: lease.shipmentScope.planDigest,
              recordedAt: lease.shipmentScope.recordedAt,
              supersededAt: recordedAt,
            },
          ]
        : lease.shipmentScopeHistory;
      writeLease({
        ...lease,
        ...(shipmentScopeHistory ? { shipmentScopeHistory } : {}),
        shipmentScope: {
          openingChanges,
          plan: activePlan,
          planDigest,
          recordedAt,
        },
        updatedAt: recordedAt,
      });
      const includedPaths = activePlan.units.reduce(
        (count, unit) => count + unit.paths.length,
        0
      );
      const preservedPaths = activePlan.preserved.reduce(
        (count, item) => count + item.paths.length,
        0
      );
      return {
        includedPaths,
        planDigest,
        preservedPaths,
        recordedAt,
        runId,
        summary: shipmentScopeSummary(activePlan, inventory),
      };
    }
  );
};

export interface ShipmentOutcomeRecord {
  receiptDigest: string;
  recordedAt: string;
  summary: string;
}

const targetDiffPaths = (
  repositoryPath: string,
  openingRevision: string,
  finalRevision: string
): string[] =>
  runGit(repositoryPath, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    openingRevision,
    finalRevision,
    "--",
  ])
    .stdout.split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

const targetRenameOriginals = (
  repositoryPath: string,
  openingRevision: string,
  finalRevision: string
): Map<string, string> => {
  const fields = runGit(repositoryPath, [
    "diff",
    "--name-status",
    "-z",
    "-M",
    openingRevision,
    finalRevision,
    "--",
  ]).stdout.split("\0");
  const originals = new Map<string, string>();
  for (let index = 0; index < fields.length; ) {
    const status = fields[index] ?? "";
    index += 1;
    if (!status) {
      continue;
    }
    const firstPath = fields[index] ?? "";
    index += 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      const destinationPath = fields[index] ?? "";
      index += 1;
      if (firstPath && destinationPath) {
        originals.set(destinationPath, firstPath);
      }
    }
  }
  return originals;
};

const assertShipmentOutcomeEntry = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  path: string,
  entry: string | null,
  label: string
): void => {
  assertSafeRelativePath(lease.primaryCheckout, path);
  if (
    targetTreeEntry(lease.primaryCheckout, receipt.targetRevision, path) !==
    entry
  ) {
    throw new SimpleChangesError(
      `${label} does not match final target: ${path}`,
      EXIT_CODES.validation
    );
  }
};

type OutcomeUnit = ShipmentOutcomeReceipt["units"][number];
type PlannedUnit = ChangePlan["units"][number];
type OpeningShipmentChange = NonNullable<
  LoopLease["shipmentScope"]
>["openingChanges"][number];

const validateOutcomeUnitFinalPaths = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  expected: PlannedUnit
): Set<string> => {
  const names = unit.finalPaths.map((item) => item.path);
  if (new Set(names).size !== names.length) {
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} repeats a final path.`,
      EXIT_CODES.validation
    );
  }
  const missing = expected.paths.filter((path) => !names.includes(path));
  const unexpected = names.filter((path) => !expected.paths.includes(path));
  if (missing.length > 0 || unexpected.length > 0) {
    const detail =
      missing.length > 0
        ? `omits scoped path ${missing[0]}`
        : `includes unscoped final path ${unexpected[0]}`;
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} ${detail}.`,
      EXIT_CODES.validation
    );
  }
  for (const item of unit.finalPaths) {
    assertShipmentOutcomeEntry(
      lease,
      receipt,
      item.path,
      item.entry,
      "Shipment outcome entry"
    );
  }
  return new Set(names);
};

const validateOutcomeUnitOriginalPaths = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  expected: PlannedUnit,
  targetDeltaPaths: Set<string>,
  renameOriginals: Map<string, string>
): Set<string> => {
  const names = unit.originalPaths.map((item) => item.path);
  const allowed = new Set(
    expected.paths
      .map((path) => renameOriginals.get(path))
      .filter((path): path is string => Boolean(path))
  );
  if (new Set(names).size !== names.length) {
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} repeats an original path.`,
      EXIT_CODES.validation
    );
  }
  const missing = [...allowed].filter(
    (path) => targetDeltaPaths.has(path) && !names.includes(path)
  );
  if (missing.length > 0) {
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} omits rename original path ${missing[0]}.`,
      EXIT_CODES.validation
    );
  }
  for (const item of unit.originalPaths) {
    if (!(allowed.has(item.path) && targetDeltaPaths.has(item.path))) {
      throw new SimpleChangesError(
        `Shipment outcome unit ${unit.unitId} includes an unrelated original path ${item.path}.`,
        EXIT_CODES.validation
      );
    }
    assertShipmentOutcomeEntry(
      lease,
      receipt,
      item.path,
      item.entry,
      "Shipment rename original entry"
    );
  }
  return new Set(names);
};

const assertDirectOutcomeMatchesSource = (
  unit: OutcomeUnit,
  expected: PlannedUnit,
  openingChanges: OpeningShipmentChange[]
): void => {
  for (const item of unit.finalPaths) {
    const sources = openingChanges.filter(
      (change) =>
        change.worktreePath === expected.sourceWorktree &&
        change.path === item.path
    );
    if (sources.length !== 1 || sources[0]?.sourceEntry !== item.entry) {
      throw new SimpleChangesError(
        `Shipment outcome unit ${unit.unitId} does not match its exact opening source result for ${item.path}.`,
        EXIT_CODES.validation
      );
    }
  }
};

const validateShipmentOutcomeUnits = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  targetDeltaPaths: Set<string>,
  renameOriginals: Map<string, string>
): { accountedPaths: Set<string>; scopedPaths: Set<string> } => {
  const scope = lease.shipmentScope;
  if (!scope) {
    throw new SimpleChangesError(
      "Record shipment scope before reconciling its exact outcome.",
      EXIT_CODES.unsafe
    );
  }
  const expectedUnits = new Map(
    scope.plan.units.map((unit) => [unit.id, unit])
  );
  const seenUnits = new Set<string>();
  const accountedPaths = new Set<string>();
  for (const unit of receipt.units) {
    const expected = expectedUnits.get(unit.unitId);
    if (!expected || seenUnits.has(unit.unitId)) {
      throw new SimpleChangesError(
        `Shipment outcome has an unknown or duplicate unit: ${unit.unitId}`,
        EXIT_CODES.validation
      );
    }
    seenUnits.add(unit.unitId);
    requiredText(unit.summary, `summary for ${unit.unitId}`);
    for (const item of unit.evidence) {
      requiredText(item, `evidence for ${unit.unitId}`);
    }
    for (const path of validateOutcomeUnitFinalPaths(
      lease,
      receipt,
      unit,
      expected
    )) {
      accountedPaths.add(path);
    }
    const originalPaths = validateOutcomeUnitOriginalPaths(
      lease,
      receipt,
      unit,
      expected,
      targetDeltaPaths,
      renameOriginals
    );
    for (const path of originalPaths) {
      accountedPaths.add(path);
    }
    assertDirectOutcomeMatchesSource(unit, expected, scope.openingChanges);
  }
  const missing = [...expectedUnits.keys()].filter(
    (unitId) => !seenUnits.has(unitId)
  );
  if (missing.length > 0) {
    throw new SimpleChangesError(
      `Shipment outcome omits scoped units: ${missing.join(", ")}`,
      EXIT_CODES.validation
    );
  }
  return {
    accountedPaths,
    scopedPaths: new Set(scope.plan.units.flatMap((unit) => unit.paths)),
  };
};

const validateAdditionalShipmentPaths = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  accountedPaths: Set<string>,
  scopedPaths: Set<string>,
  targetDeltaPaths: Set<string>
): void => {
  for (const item of receipt.additionalPaths) {
    requiredText(item.reason, `reason for ${item.path}`);
    if (scopedPaths.has(item.path)) {
      throw new SimpleChangesError(
        `Scoped path must be reconciled through its unit, not additionalPaths: ${item.path}`,
        EXIT_CODES.validation
      );
    }
    if (accountedPaths.has(item.path)) {
      throw new SimpleChangesError(
        `Additional shipment path is already accounted for: ${item.path}`,
        EXIT_CODES.validation
      );
    }
    if (!targetDeltaPaths.has(item.path)) {
      throw new SimpleChangesError(
        `Additional shipment path is not part of the final target delta: ${item.path}`,
        EXIT_CODES.validation
      );
    }
    assertShipmentOutcomeEntry(
      lease,
      receipt,
      item.path,
      item.entry,
      "Additional shipment path entry"
    );
    accountedPaths.add(item.path);
  }
};

const assertCompleteTargetDelta = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  accountedPaths: Set<string>
): void => {
  const missing = targetDiffPaths(
    lease.primaryCheckout,
    lease.targetRevision,
    receipt.targetRevision
  ).filter((path) => !accountedPaths.has(path));
  if (missing.length > 0) {
    throw new SimpleChangesError(
      `Shipment outcome omits final target delta paths: ${missing.join(", ")}`,
      EXIT_CODES.validation
    );
  }
};

export const recordShipmentOutcome = (
  repositoryPath: string,
  runIdInput: string,
  agentIdInput: string,
  receiptInput: unknown
): ShipmentOutcomeRecord => {
  const runId = requiredRunId(runIdInput);
  const agentId = requiredText(agentIdInput, "agent ID");
  const receipt = validateSchema<ShipmentOutcomeReceipt>(
    "shipment-outcome",
    receiptInput
  );
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "record shipment outcome",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertControllerActive(lease);
      if (
        lease.runId !== runId ||
        receipt.runId !== runId ||
        lease.ownerAgentId !== agentId
      ) {
        throw new SimpleChangesError(
          `Only ${lease.ownerAgentId} may reconcile the exact outcome for ${lease.runId}.`,
          EXIT_CODES.unsafe
        );
      }
      const finalTargetRevision = currentTargetRevision(lease);
      if (receipt.targetRevision !== finalTargetRevision) {
        throw new SimpleChangesError(
          `Shipment outcome must bind current target ${finalTargetRevision}.`,
          EXIT_CODES.unsafe
        );
      }
      const targetDeltaPaths = new Set(
        targetDiffPaths(
          lease.primaryCheckout,
          lease.targetRevision,
          receipt.targetRevision
        )
      );
      const renameOriginals = targetRenameOriginals(
        lease.primaryCheckout,
        lease.targetRevision,
        receipt.targetRevision
      );
      const { accountedPaths, scopedPaths } = validateShipmentOutcomeUnits(
        lease,
        receipt,
        targetDeltaPaths,
        renameOriginals
      );
      validateAdditionalShipmentPaths(
        lease,
        receipt,
        accountedPaths,
        scopedPaths,
        targetDeltaPaths
      );
      assertCompleteTargetDelta(lease, receipt, accountedPaths);
      const recordedAt = new Date().toISOString();
      const receiptDigest = sha256Json(receipt);
      writeLease({
        ...lease,
        shipmentOutcome: { receipt, receiptDigest, recordedAt },
        updatedAt: recordedAt,
      });
      return {
        receiptDigest,
        recordedAt,
        summary: `Reviewed shipment outcome: ${receipt.units.length} scoped work item(s) and ${receipt.additionalPaths.length} additional final-target path(s) accounted at ${receipt.targetRevision}.`,
      };
    }
  );
};

export const takeoverLoop = (
  repositoryPath: string,
  runIdInput: string,
  nextAgentIdInput: string,
  expectedManifestDigestInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const runId = requiredRunId(runIdInput);
  const nextAgentId = requiredText(nextAgentIdInput, "agent ID");
  const expectedManifestDigest = requiredText(
    expectedManifestDigestInput,
    "manifest digest"
  );
  const approvedBy = requiredText(approvedByInput, "approver");
  const reason = requiredText(reasonInput, "takeover reason");
  if (!DIGEST_PATTERN.test(expectedManifestDigest)) {
    throw new SimpleChangesError(
      "manifest digest must be a lowercase SHA-256 value.",
      EXIT_CODES.usage
    );
  }
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop takeover",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = readLeaseFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      if (!lease) {
        throw new SimpleChangesError(
          "No active Simple Changes integration loop was found.",
          EXIT_CODES.unsafe
        );
      }
      assertMatchingRun(lease, runId);
      const actualManifestDigest = sha256(JSON.stringify(lease));
      if (actualManifestDigest !== expectedManifestDigest) {
        throw new SimpleChangesError(
          `Active-loop manifest digest changed: expected ${expectedManifestDigest}, observed ${actualManifestDigest}. Re-inspect before authorizing takeover.`,
          EXIT_CODES.unsafe
        );
      }
      if (lease.ownerAgentId === nextAgentId) {
        throw new SimpleChangesError(
          `${nextAgentId} already owns ${runId}; takeover requires a different controller. Next: continue directly as the current controller, or run \`simple-changes loop close-equivalent --run-id ${runId} --approved-by <you> --reason <why>\` if the work is already contained in the target.`,
          EXIT_CODES.usage
        );
      }
      return transferController(
        lease,
        inventory,
        nextAgentId,
        "takeover",
        reason,
        approvedBy
      );
    }
  );
};

export const verifyLoop = (repositoryPath: string): LoopVerification => {
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop verify",
    () => {
      const inventory = captureInventory(repositoryPath);
      const storedLease = readLeaseFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      if (!storedLease) {
        return {
          active: false,
          checkedAt: new Date().toISOString(),
          currentBaselineDigest: inventory.baselineDigest,
          ok: true,
          runId: null,
          violations: [],
        };
      }
      const projected = withConcurrentAuthorAdmissions(storedLease, inventory);
      const lease =
        controllerLifecycle(storedLease).status === "active" &&
        projected !== storedLease
          ? writeLease(projected)
          : projected;
      return verificationAgainst(lease, inventory);
    }
  );
};

export const guardLoopMutation = (
  repositoryPath: string,
  runId: string,
  agentIdInput: string
): LoopVerification => {
  const agentId = requiredText(agentIdInput, "agent ID");
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop guard",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      assertAgentMutationAllowed(lease, inventory, agentId);
      const verification = verificationAgainst(lease, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Loop guard rejected mutation: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      writeLease({
        ...lease,
        updatedAt: verification.checkedAt,
      });
      return verification;
    }
  );
};

export interface LoopMutationResult {
  command: string[];
  result: CommandResult;
  verification: LoopVerification;
}

export interface LoopOperationResult<T> {
  result: T;
  verification: LoopVerification;
}

export interface LoopMutationLeaseContext {
  markChildStarting: () => void;
  registerProcess: (process: CommandProcess) => void;
}

export const withLoopMutationLease = <T>(
  repositoryPath: string,
  runId: string,
  agentIdInput: string,
  operationNameInput: string,
  operation: (context: LoopMutationLeaseContext) => T | Promise<T>
): Promise<LoopOperationResult<T>> => {
  const agentId = requiredText(agentIdInput, "agent ID");
  const operationName = requiredText(operationNameInput, "operation name");
  const opening = captureInventory(repositoryPath);
  return withAsyncStateLock(
    opening.repository.commonGitDirectory,
    operationName,
    async (lock) => {
      const before = captureInventory(repositoryPath);
      const lease = requireLease(before);
      assertMatchingRun(lease, runId);
      assertAgentMutationAllowed(lease, before, agentId);
      const openingVerification = verificationAgainst(lease, before);
      if (!openingVerification.ok) {
        throw new SimpleChangesError(
          `Loop operation rejected mutation: ${openingVerification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }

      let operationError: unknown;
      let result: T | undefined;
      try {
        result = await operation({
          markChildStarting: () => {
            lock.update({ childStarting: true });
          },
          registerProcess: (guardedProcess) => {
            lock.update({
              childProcessId: guardedProcess.childPid,
              childStarting: false,
              ...(guardedProcess.processGroupId === null
                ? {}
                : { processGroupId: guardedProcess.processGroupId }),
            });
          },
        });
      } catch (error) {
        if (error instanceof GuardedProcessGroupStillAliveError) {
          lock.retain();
        }
        operationError = error;
      }

      const after = captureInventory(repositoryPath);
      const currentLease = requireLease(after);
      assertMatchingRun(currentLease, runId);
      const closingVerification = verificationAgainst(currentLease, after);
      writeLease({
        ...currentLease,
        updatedAt: closingVerification.checkedAt,
      });
      if (!closingVerification.ok) {
        throw new SimpleChangesError(
          `Loop operation detected a manifest violation after mutation: ${closingVerification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe,
          operationError === undefined ? undefined : { cause: operationError }
        );
      }
      if (operationError !== undefined) {
        throw operationError;
      }
      return {
        result: result as T,
        verification: closingVerification,
      };
    }
  );
};

const irreversibleEmergencyFlags: Array<keyof EmergencyShippingLedgerEntry> = [
  "artifactEquivalenceProven",
  "breakGlassAuthorized",
  "candidateVerifiedHealthy",
  "changelogReconciled",
  "cleanupCompleted",
  "finalVerificationPassed",
  "focusedChecksPassed",
  "mergeCompleted",
  "productionAuthorized",
  "rollbackAnchorRecorded",
  "rollbackSupported",
];

const assertEmergencyUpdate = (
  previous: EmergencyShippingLedgerEntry | undefined,
  next: EmergencyShippingLedgerEntry
): void => {
  if (!previous) {
    return;
  }
  const explicitPredeploymentBreakGlassUpgrade =
    previous.mode === "expedited" &&
    next.mode === "break-glass" &&
    !previous.deployedRevision &&
    previous.independentReview === "pending" &&
    !previous.mergeCompleted &&
    !previous.changelogReconciled &&
    !previous.finalVerificationPassed &&
    !previous.cleanupCompleted &&
    next.breakGlassAuthorized &&
    next.authoritySource !== null &&
    next.evidence.includes("deploy-before-review");
  if (
    (previous.mode !== next.mode && !explicitPredeploymentBreakGlassUpgrade) ||
    previous.candidateRevision !== next.candidateRevision
  ) {
    throw new SimpleChangesError(
      "Emergency Shipping updates cannot replace the recorded mode or candidate revision.",
      EXIT_CODES.validation
    );
  }
  for (const field of irreversibleEmergencyFlags) {
    if (previous[field] === true && next[field] !== true) {
      throw new SimpleChangesError(
        `Emergency Shipping updates cannot clear completed evidence: ${field}.`,
        EXIT_CODES.validation
      );
    }
  }
  for (const field of [
    "candidateArtifactId",
    "deployedRevision",
    "canonicalRevision",
    "deployedArtifactId",
    "canonicalArtifactId",
    "previousProductionRevision",
  ] as const) {
    if (previous[field] && previous[field] !== next[field]) {
      throw new SimpleChangesError(
        `Emergency Shipping updates cannot replace recorded identity: ${field}.`,
        EXIT_CODES.validation
      );
    }
  }
  if (
    previous.authoritySource &&
    previous.authoritySource !== next.authoritySource
  ) {
    throw new SimpleChangesError(
      "Emergency Shipping authority source cannot be replaced after recording.",
      EXIT_CODES.validation
    );
  }
  if (previous.evidence.some((item) => !next.evidence.includes(item))) {
    throw new SimpleChangesError(
      "Emergency Shipping evidence labels cannot be removed after recording.",
      EXIT_CODES.validation
    );
  }
  if (
    previous.independentReview !== "pending" &&
    next.independentReview !== previous.independentReview
  ) {
    throw new SimpleChangesError(
      "Emergency Shipping review evidence cannot be reset or replaced.",
      EXIT_CODES.validation
    );
  }
};

export const recordEmergencyShipping = async (
  repositoryPath: string,
  runId: string,
  agentId: string,
  input: unknown
): Promise<LoopOperationResult<EmergencyShippingLedgerEntry>> =>
  withLoopMutationLease(
    repositoryPath,
    runId,
    agentId,
    "loop emergency record",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      const validated = validateSchema<EmergencyShippingLedgerEntry | null>(
        "emergency-shipping",
        input
      );
      if (!validated) {
        throw new SimpleChangesError(
          "Emergency Shipping state cannot be null.",
          EXIT_CODES.validation
        );
      }
      const next = {
        ...validated,
        status: deriveEmergencyShippingStatus(validated),
      };
      assertEmergencyUpdate(lease.emergencyShipping, next);
      writeLease({
        ...lease,
        emergencyShipping: next,
        updatedAt: new Date().toISOString(),
      });
      return next;
    }
  );

export const emergencyShippingStatus = (
  repositoryPath: string,
  runId: string
): {
  decision: ReturnType<typeof decideEmergencyShipping>;
  state: EmergencyShippingLedgerEntry;
} => {
  const lease = readLoopLease(repositoryPath);
  if (!(lease && lease.runId === runId && lease.emergencyShipping)) {
    throw new SimpleChangesError(
      `No Emergency Shipping state is recorded for ${runId}.`,
      EXIT_CODES.unsafe
    );
  }
  return {
    decision: decideEmergencyShipping(lease.emergencyShipping),
    state: lease.emergencyShipping,
  };
};

export const executeLoopMutation = async (
  repositoryPath: string,
  runId: string,
  agentIdInput: string,
  commandInput: readonly string[]
): Promise<LoopMutationResult> => {
  const [command, ...args] = commandInput;
  if (!command) {
    throw new SimpleChangesError(
      "loop exec requires a command after --.",
      EXIT_CODES.usage
    );
  }
  const executable = basename(command);
  if (executable === "git" || executable === "git.exe") {
    let commandIndex = 0;
    while (commandIndex < args.length) {
      const argument = args[commandIndex];
      if (
        argument === "-C" ||
        argument === "-c" ||
        argument === "--git-dir" ||
        argument === "--work-tree"
      ) {
        commandIndex += 2;
        continue;
      }
      if (
        argument?.startsWith("--git-dir=") ||
        argument?.startsWith("--work-tree=") ||
        argument === "--no-pager"
      ) {
        commandIndex += 1;
        continue;
      }
      if (argument?.startsWith("-")) {
        throw new SimpleChangesError(
          `loop exec cannot safely classify Git global option ${argument}. Run the intended Git subcommand without unrecognized global options.`,
          EXIT_CODES.unsafe
        );
      }
      break;
    }
    const gitCommand = args[commandIndex];
    const checkoutArguments = args.slice(commandIndex + 1);
    const changesRegisteredBranch =
      gitCommand === "switch" ||
      (gitCommand === "checkout" && !checkoutArguments.includes("--"));
    if (changesRegisteredBranch) {
      throw new SimpleChangesError(
        "Do not switch the registered controller or author worktree to another branch during loop exec. Prepare the intended branch/worktree first, then start or resume its controller. Path-only git checkout with an explicit -- separator remains available.",
        EXIT_CODES.unsafe
      );
    }
  }
  const guarded = await withLoopMutationLease(
    repositoryPath,
    runId,
    agentIdInput,
    "loop exec",
    (context) => {
      context.markChildStarting();
      return runCommandInProcessGroup(
        command,
        args,
        captureInventory(repositoryPath).repository.currentCheckout,
        context.registerProcess
      );
    }
  );
  return {
    command: [command, ...args],
    result: guarded.result,
    verification: guarded.verification,
  };
};

export interface PreparedAgentWorktree {
  agentId: string;
  baseRevision: string;
  branch: string;
  created: boolean;
  path: string;
  runId: string;
}

export const prepareAgentWorktree = (
  repositoryPath: string,
  runId: string,
  agentIdInput: string,
  purposeInput: string
): PreparedAgentWorktree => {
  const agentId = requiredText(agentIdInput, "agent ID");
  const purpose = slug(requiredText(purposeInput, "purpose"), "work");
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "prepare agent worktree",
    () => {
      let inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      assertControllerActive(lease);
      assertShipmentScopeRecorded(lease);
      assertLegacyRunAllowsMutation(
        lease,
        inventory,
        "This legacy run has no opening remote inventory and cannot prepare new authoring work; use close-only post-cleanup recovery. Next: run `simple-changes loop recover-post-cleanup` when cleanup is already complete, or `simple-changes loop close-equivalent` when the work is already contained in the target."
      );
      const existing = lease.worktrees.find(
        (worktree) => worktree.agentId === agentId
      );
      if (existing) {
        if (!(existing.branch && existing.mutationAllowed)) {
          throw new SimpleChangesError(
            `Agent ${agentId} is registered without an authoring worktree.`,
            EXIT_CODES.unsafe
          );
        }
        const existingWorktree = inventory.worktrees.find(
          (worktree) => worktree.path === existing.path
        );
        if (!existingWorktree || existingWorktree.branch !== existing.branch) {
          throw new SimpleChangesError(
            `Agent ${agentId} must resume prepared path ${existing.path} on registered branch ${existing.branch}; current branch is ${existingWorktree?.branch ?? "missing or detached"}.`,
            EXIT_CODES.unsafe
          );
        }
        return {
          agentId,
          baseRevision: existing.baselineHeadSha ?? lease.targetRevision,
          branch: existing.branch,
          created: false,
          path: existing.path,
          runId: lease.runId,
        };
      }

      const finalizePreparation = (
        currentLease: LoopLease,
        preparation: LoopWorktreePreparation
      ): PreparedAgentWorktree => {
        inventory = captureInventory(repositoryPath);
        const preparedPath = existsSync(preparation.path)
          ? realpathSync(preparation.path)
          : preparation.path;
        const createdWorktree = inventory.worktrees.find(
          (worktree) => worktree.path === preparedPath
        );
        if (
          !createdWorktree ||
          createdWorktree.branch !== preparation.branch ||
          createdWorktree.headSha !== preparation.baseRevision
        ) {
          throw new SimpleChangesError(
            `Agent worktree preparation at ${preparation.path} is incomplete or no longer matches branch ${preparation.branch} at ${preparation.baseRevision}. Resume only after restoring that exact state.`,
            EXIT_CODES.unsafe
          );
        }
        if (createdWorktree.changes.length > 0) {
          throw new SimpleChangesError(
            `Agent worktree preparation at ${preparation.path} contains staged, unstaged, or untracked changes. Preserve it for inspection; only a clean interrupted preparation may be registered.`,
            EXIT_CODES.unsafe
          );
        }
        const completedLease: LoopLease = {
          ...currentLease,
          preparations: currentLease.preparations.filter(
            (item) => item.agentId !== preparation.agentId
          ),
          updatedAt: new Date().toISOString(),
          worktrees: [
            ...currentLease.worktrees,
            worktreeLease(createdWorktree, "author", agentId, true),
          ],
        };
        writeLease(completedLease);
        const closingVerification = verificationAgainst(
          completedLease,
          inventory
        );
        if (!closingVerification.ok) {
          throw new SimpleChangesError(
            `Agent worktree registered, but concurrent manifest violations now block mutation: ${closingVerification.violations
              .map((violation) => `${violation.code}:${violation.path}`)
              .join(", ")}`,
            EXIT_CODES.unsafe
          );
        }
        return {
          agentId,
          baseRevision: preparation.baseRevision,
          branch: preparation.branch,
          created: true,
          path: createdWorktree.path,
          runId: currentLease.runId,
        };
      };

      const resumePreparation = (
        currentLease: LoopLease,
        preparation: LoopWorktreePreparation
      ): PreparedAgentWorktree => {
        const preparedPath = existsSync(preparation.path)
          ? realpathSync(preparation.path)
          : preparation.path;
        const currentWorktree = inventory.worktrees.find(
          (worktree) => worktree.path === preparedPath
        );
        if (currentWorktree) {
          return finalizePreparation(currentLease, preparation);
        }
        if (existsSync(preparation.path)) {
          throw new SimpleChangesError(
            `Prepared path ${preparation.path} exists but is not the registered Git worktree. Preserve it for inspection.`,
            EXIT_CODES.unsafe
          );
        }
        const branchResult = runGit(
          currentLease.primaryCheckout,
          [
            "rev-parse",
            "--verify",
            `refs/heads/${preparation.branch}^{commit}`,
          ],
          true
        );
        const branchRevision = branchResult.stdout.trim();
        if (
          branchResult.exitCode === 0 &&
          branchRevision !== preparation.baseRevision
        ) {
          throw new SimpleChangesError(
            `Prepared branch ${preparation.branch} moved to ${branchRevision}; expected ${preparation.baseRevision}.`,
            EXIT_CODES.unsafe
          );
        }
        mkdirSync(dirname(preparation.path), { recursive: true });
        if (branchResult.exitCode === 0) {
          runGit(currentLease.primaryCheckout, [
            "worktree",
            "add",
            preparation.path,
            preparation.branch,
          ]);
        } else {
          runGit(currentLease.primaryCheckout, [
            "worktree",
            "add",
            "-b",
            preparation.branch,
            preparation.path,
            preparation.baseRevision,
          ]);
        }
        return finalizePreparation(currentLease, preparation);
      };

      const pending = lease.preparations.find(
        (preparation) => preparation.agentId === agentId
      );
      if (pending) {
        return resumePreparation(lease, pending);
      }
      assertNewAuthorPreparationAllowed(lease);
      const verification = verificationAgainst(lease, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Cannot prepare an agent worktree while the loop manifest has violations: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      const agentSlug = slug(agentId, "agent");
      const runSlug = lease.runId.slice(4, 16);
      const repositorySlug = slug(
        basename(lease.primaryCheckout),
        "repository"
      );
      const branch = `simple-changes/${purpose}-${agentSlug}-${runSlug}`;
      const path = resolve(
        dirname(lease.primaryCheckout),
        ".simple-changes-worktrees",
        repositorySlug,
        `${runSlug}-${purpose}-${agentSlug}`
      );
      if (existsSync(path)) {
        throw new SimpleChangesError(
          `Refusing to reuse unregistered agent worktree path ${path}.`,
          EXIT_CODES.unsafe
        );
      }
      const branchExists =
        runGit(
          lease.primaryCheckout,
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          true
        ).exitCode === 0;
      if (branchExists) {
        throw new SimpleChangesError(
          `Refusing to reuse unregistered agent branch ${branch}.`,
          EXIT_CODES.unsafe
        );
      }
      const baseRevision = lease.targetRevision;
      const newPreparation: LoopWorktreePreparation = {
        agentId,
        baseRevision,
        branch,
        createdAt: new Date().toISOString(),
        path,
        purpose,
      };
      const preparingLease = writeLease({
        ...lease,
        preparations: [...lease.preparations, newPreparation],
        updatedAt: newPreparation.createdAt,
      });
      return resumePreparation(preparingLease, newPreparation);
    }
  );
};

interface WorktreeRemovalAudit {
  current: WorktreeInventory & { headSha: string };
  path: string;
  targetRevision: string;
}

const auditWorktreeRemoval = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pathInput: string,
  changeDigest: string
): WorktreeRemovalAudit => {
  const path = existsSync(pathInput)
    ? realpathSync(pathInput)
    : resolve(pathInput);
  if (path === lease.primaryCheckout) {
    throw new SimpleChangesError(
      "The canonical primary checkout cannot be disposed by the active loop.",
      EXIT_CODES.unsafe
    );
  }
  const registered = lease.worktrees.find(
    (worktree) =>
      worktree.path === path &&
      worktree.role === "preserved" &&
      !worktree.createdByRun
  );
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === path
  );
  if (!(registered && current)) {
    throw new SimpleChangesError(
      `Disposition path must name a current preserved opening worktree: ${path}`,
      EXIT_CODES.unsafe
    );
  }
  if (current.changeDigest !== changeDigest) {
    throw new SimpleChangesError(
      `Disposition digest does not match ${path}; expected current digest ${current.changeDigest}.`,
      EXIT_CODES.unsafe
    );
  }
  if (current.changes.length > 0) {
    throw new SimpleChangesError(
      `Opening worktree ${path} must be clean before removal can be authorized.`,
      EXIT_CODES.unsafe
    );
  }
  if (!current.headSha) {
    throw new SimpleChangesError(
      `Opening worktree ${path} has no auditable HEAD revision.`,
      EXIT_CODES.unsafe
    );
  }
  const targetRevision = currentTargetRevision(lease);
  const targetDescendsFromPinned =
    runGit(
      lease.primaryCheckout,
      [
        "merge-base",
        "--is-ancestor",
        `${lease.targetRevision}^{commit}`,
        `${targetRevision}^{commit}`,
      ],
      true
    ).exitCode === 0;
  if (!targetDescendsFromPinned) {
    throw new SimpleChangesError(
      `Refreshed target ${targetRevision} does not descend from pinned target ${lease.targetRevision}.`,
      EXIT_CODES.unsafe
    );
  }
  const uniqueCommitCount = Number.parseInt(
    runGit(lease.primaryCheckout, [
      "rev-list",
      "--count",
      `${targetRevision}..${current.headSha}`,
    ]).stdout.trim(),
    10
  );
  if (!(Number.isInteger(uniqueCommitCount) && uniqueCommitCount === 0)) {
    throw new SimpleChangesError(
      `Opening worktree ${path} has ${uniqueCommitCount} unique commit(s) outside ${lease.targetRef} at ${targetRevision}.`,
      EXIT_CODES.unsafe
    );
  }
  return {
    current: current as WorktreeInventory & { headSha: string },
    path,
    targetRevision,
  };
};

export const authorizeWorktreeRemoval = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pathInput: string,
  changeDigestInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approved-by identity");
  const reason = requiredText(reasonInput, "disposition reason");
  const changeDigest = requiredText(changeDigestInput, "status digest");
  if (!DIGEST_PATTERN.test(changeDigest)) {
    throw new SimpleChangesError(
      "status digest must be a 64-character lowercase SHA-256 value.",
      EXIT_CODES.usage
    );
  }
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "authorize opening worktree removal",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      if (lease.ownerAgentId !== ownerAgentId) {
        throw new SimpleChangesError(
          `Only loop owner ${lease.ownerAgentId} may record a worktree disposition.`,
          EXIT_CODES.unsafe
        );
      }
      assertControllerActive(lease);
      const { current, path, targetRevision } = auditWorktreeRemoval(
        lease,
        inventory,
        pathInput,
        changeDigest
      );
      const disposition: LoopWorktreeDisposition = {
        approvedBy,
        branch: current.branch,
        changeDigest,
        createdAt: new Date().toISOString(),
        headSha: current.headSha,
        outcome: "remove-after-audit",
        path,
        reason,
        targetRef: lease.targetRef,
        targetRevision,
        uniqueCommitCount: 0,
      };
      const candidate: LoopLease = {
        ...lease,
        dispositions: [
          ...(lease.dispositions ?? []).filter((item) => item.path !== path),
          disposition,
        ],
        updatedAt: disposition.createdAt,
      };
      const verification = verificationAgainst(candidate, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Worktree disposition is exact but other loop violations remain: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      return writeLease(candidate);
    }
  );
};

const auditWorktreeRetention = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pathInput: string,
  changeDigest: string
): { current: WorktreeInventory & { headSha: string }; path: string } => {
  const path = existsSync(pathInput)
    ? realpathSync(pathInput)
    : resolve(pathInput);
  if (path === lease.primaryCheckout) {
    throw new SimpleChangesError(
      "The canonical primary checkout cannot be retained as excluded concurrent state.",
      EXIT_CODES.unsafe
    );
  }
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === path
  );
  if (!current) {
    throw new SimpleChangesError(
      `Retention path must name a current worktree: ${path}`,
      EXIT_CODES.unsafe
    );
  }
  if (current.changeDigest !== changeDigest) {
    throw new SimpleChangesError(
      `Retention digest does not match ${path}; expected current digest ${current.changeDigest}.`,
      EXIT_CODES.unsafe
    );
  }
  if (current.changes.length > 0) {
    throw new SimpleChangesError(
      `Worktree ${path} is changing or dirty; its owner must claim it as an active concurrent author or pause it before it can be excluded from this shipment.`,
      EXIT_CODES.unsafe
    );
  }
  if (!current.headSha) {
    throw new SimpleChangesError(
      `Worktree ${path} has no auditable HEAD revision.`,
      EXIT_CODES.unsafe
    );
  }
  const registered = lease.worktrees.find((worktree) => worktree.path === path);
  if (
    registered &&
    registered.role !== "preserved" &&
    registered.role !== "retained"
  ) {
    throw new SimpleChangesError(
      `Worktree ${path} is already registered as ${registered.role}; it cannot also be retained as excluded state.`,
      EXIT_CODES.unsafe
    );
  }
  const targetRevision = currentTargetRevision(lease);
  const targetContainsHead =
    runGit(
      lease.primaryCheckout,
      [
        "merge-base",
        "--is-ancestor",
        `${current.headSha}^{commit}`,
        `${targetRevision}^{commit}`,
      ],
      true
    ).exitCode === 0;
  if (!targetContainsHead) {
    throw new SimpleChangesError(
      `Worktree ${path} has commits outside ${lease.targetRef}; preserve and inspect that work instead of marking it as an unchanged cleanup exclusion.`,
      EXIT_CODES.unsafe
    );
  }
  return { current: current as WorktreeInventory & { headSha: string }, path };
};

export const retainExcludedWorktree = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pathInput: string,
  changeDigestInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approved-by identity");
  const reason = requiredText(reasonInput, "retention reason");
  const changeDigest = requiredText(changeDigestInput, "status digest");
  if (!DIGEST_PATTERN.test(changeDigest)) {
    throw new SimpleChangesError(
      "status digest must be a 64-character lowercase SHA-256 value.",
      EXIT_CODES.usage
    );
  }
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "retain excluded worktree",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      if (lease.ownerAgentId !== ownerAgentId) {
        throw new SimpleChangesError(
          `Only loop owner ${lease.ownerAgentId} may retain an excluded worktree.`,
          EXIT_CODES.unsafe
        );
      }
      assertControllerActive(lease);
      const { current, path } = auditWorktreeRetention(
        lease,
        inventory,
        pathInput,
        changeDigest
      );
      const createdAt = new Date().toISOString();
      const retained: LoopWorktreeLease = {
        ...worktreeLease(current, "retained", null, false),
        retention: { approvedBy, createdAt, reason },
      };
      const candidate: LoopLease = {
        ...lease,
        updatedAt: createdAt,
        worktrees: [
          ...lease.worktrees.filter((worktree) => worktree.path !== path),
          retained,
        ],
      };
      const pathViolation = verificationAgainst(
        candidate,
        inventory
      ).violations.find((violation) => violation.path === path);
      if (pathViolation) {
        throw new SimpleChangesError(
          `Could not retain ${path}: ${pathViolation.message}`,
          EXIT_CODES.unsafe
        );
      }
      return writeLease(candidate);
    }
  );
};

export const grantLoopOverride = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pathInput: string,
  changeDigestInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approved-by identity");
  const reason = requiredText(reasonInput, "override reason");
  const changeDigest = requiredText(changeDigestInput, "status digest");
  if (!DIGEST_PATTERN.test(changeDigest)) {
    throw new SimpleChangesError(
      "status digest must be a 64-character lowercase SHA-256 value.",
      EXIT_CODES.usage
    );
  }
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop allow",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      if (lease.ownerAgentId !== ownerAgentId) {
        throw new SimpleChangesError(
          `Only loop owner ${lease.ownerAgentId} may record an override.`,
          EXIT_CODES.unsafe
        );
      }
      assertControllerActive(lease);
      const path = existsSync(pathInput)
        ? realpathSync(pathInput)
        : resolve(pathInput);
      const registered = lease.worktrees.find(
        (worktree) => worktree.path === path && worktree.role === "preserved"
      );
      const concurrentAuthor = lease.worktrees.find(
        (worktree) =>
          worktree.path === path && worktree.role === "concurrent-author"
      );
      const current = inventory.worktrees.find(
        (worktree) => worktree.path === path
      );
      if (concurrentAuthor) {
        throw new SimpleChangesError(
          `Worktree ${path} is already recognized as an actively claimed concurrent author; no user-approved override is allowed or needed.`,
          EXIT_CODES.unsafe
        );
      }
      if (!(registered && current)) {
        throw new SimpleChangesError(
          `Override path must name a current preserved baseline worktree: ${path}`,
          EXIT_CODES.unsafe
        );
      }
      if (current.changeDigest !== changeDigest) {
        throw new SimpleChangesError(
          `Override digest does not match ${path}; expected current digest ${current.changeDigest}.`,
          EXIT_CODES.unsafe
        );
      }
      const override: LoopOverride = {
        approvedBy,
        changeDigest,
        createdAt: new Date().toISOString(),
        headSha: current.headSha,
        path,
        reason,
      };
      const candidate = {
        ...lease,
        overrides: [
          ...lease.overrides.filter((item) => item.path !== path),
          override,
        ],
        updatedAt: override.createdAt,
      };
      const pathViolation = verificationAgainst(
        candidate,
        inventory
      ).violations.find((violation) => violation.path === path);
      if (pathViolation) {
        throw new SimpleChangesError(
          `Override does not resolve ${path}: ${pathViolation.message}`,
          EXIT_CODES.unsafe
        );
      }
      return writeLease(candidate);
    }
  );
};

const exactPausedEvidence = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pauseReceiptIdInput: string
): {
  claimId: string;
  current: WorktreeInventory;
  pauseReceiptId: string;
} => {
  const pauseReceiptId = requiredText(pauseReceiptIdInput, "pause receipt ID");
  const { claim, receipt } = coordinationEvidence(
    lease.commonGitDirectory,
    pauseReceiptId
  );
  if (
    claim.commonGitDirectory !== lease.commonGitDirectory ||
    receipt.requestingRunId !== lease.runId ||
    !["paused", "adopted-preserved"].includes(claim.state)
  ) {
    throw new SimpleChangesError(
      "Pause receipt does not belong to this active loop and paused claim.",
      EXIT_CODES.unsafe
    );
  }
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === receipt.path
  );
  if (
    !(
      current &&
      coordinationLinkIsCurrent(
        lease.commonGitDirectory,
        claim.claimId,
        pauseReceiptId,
        current
      )
    )
  ) {
    throw new SimpleChangesError(
      "Pause receipt no longer matches current worktree evidence.",
      EXIT_CODES.unsafe
    );
  }
  return { claimId: claim.claimId, current, pauseReceiptId };
};

export const adoptPausedWorktree = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pauseReceiptIdInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop adopt-worktree",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      if (lease.ownerAgentId !== ownerAgentId) {
        throw new SimpleChangesError(
          `Only loop owner ${lease.ownerAgentId} may adopt a paused worktree.`,
          EXIT_CODES.unsafe
        );
      }
      assertControllerActive(lease);
      const evidence = exactPausedEvidence(
        lease,
        inventory,
        pauseReceiptIdInput
      );
      if (
        lease.worktrees.some(
          (worktree) => worktree.path === evidence.current.path
        )
      ) {
        throw new SimpleChangesError(
          "loop adopt-worktree requires a current unregistered worktree.",
          EXIT_CODES.unsafe
        );
      }
      const adopted: LoopWorktreeLease = {
        ...worktreeLease(evidence.current, "preserved", null, false),
        claimId: evidence.claimId,
        coordinationState: "adopted-preserved",
        pauseReceiptId: evidence.pauseReceiptId,
      };
      const candidate: LoopLease = {
        ...lease,
        updatedAt: new Date().toISOString(),
        worktrees: [...lease.worktrees, adopted],
      };
      const verification = verificationAgainst(candidate, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Paused worktree is exact but other loop violations remain: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      markCoordinationAdopted(
        lease.commonGitDirectory,
        evidence.claimId,
        evidence.pauseReceiptId,
        ownerAgentId
      );
      return writeLease(candidate);
    }
  );
};

export const acceptPausedWorktreeChange = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pauseReceiptIdInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop accept-paused-change",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      if (lease.ownerAgentId !== ownerAgentId) {
        throw new SimpleChangesError(
          `Only loop owner ${lease.ownerAgentId} may accept a paused change.`,
          EXIT_CODES.unsafe
        );
      }
      assertControllerActive(lease);
      const evidence = exactPausedEvidence(
        lease,
        inventory,
        pauseReceiptIdInput
      );
      const registered = lease.worktrees.find(
        (worktree) =>
          worktree.path === evidence.current.path &&
          !worktree.createdByRun &&
          ["preserved", "retained", "concurrent-author"].includes(worktree.role)
      );
      if (!registered) {
        throw new SimpleChangesError(
          "loop accept-paused-change requires an opening preserved, retained, or concurrent-author worktree.",
          EXIT_CODES.unsafe
        );
      }
      const accepted: LoopWorktreeLease = {
        ...worktreeLease(evidence.current, "preserved", null, false),
        claimId: evidence.claimId,
        coordinationState: "adopted-preserved",
        pauseReceiptId: evidence.pauseReceiptId,
      };
      const candidate: LoopLease = {
        ...lease,
        updatedAt: new Date().toISOString(),
        worktrees: lease.worktrees.map((worktree) =>
          worktree.path === evidence.current.path ? accepted : worktree
        ),
      };
      const verification = verificationAgainst(candidate, inventory);
      const unrelatedStaleClaims = verification.violations.filter(
        (violation) =>
          violation.code === "coordination-claim-stale" &&
          violation.path !== evidence.current.path
      );
      if (
        !verification.ok &&
        unrelatedStaleClaims.length !== verification.violations.length
      ) {
        throw new SimpleChangesError(
          `Paused change is exact but other loop violations remain: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      markCoordinationAdopted(
        lease.commonGitDirectory,
        evidence.claimId,
        evidence.pauseReceiptId,
        ownerAgentId
      );
      return writeLease(candidate);
    }
  );
};

export const markWorktreeResumeReady = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  claimIdInput: string
): {
  claimId: string;
  lease: LoopLease;
  targetRef: string;
  targetSha: string;
} => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const claimId = requiredText(claimIdInput, "claim ID");
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "worktree resume-ready",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      if (lease.ownerAgentId !== ownerAgentId) {
        throw new SimpleChangesError(
          `Only loop owner ${lease.ownerAgentId} may mark a worktree resume-ready.`,
          EXIT_CODES.unsafe
        );
      }
      assertControllerActive(lease);
      const verification = verificationAgainst(lease, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Cannot mark resume-ready while manifest violations remain: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      const targetSha = runGit(lease.primaryCheckout, [
        "rev-parse",
        "--verify",
        `${lease.targetRef}^{commit}`,
      ]).stdout.trim();
      markCoordinationResumeReady(
        lease.commonGitDirectory,
        claimId,
        ownerAgentId,
        lease.runId,
        lease.targetRef,
        targetSha
      );
      const candidate: LoopLease = {
        ...lease,
        updatedAt: new Date().toISOString(),
        worktrees: lease.worktrees.map((worktree) =>
          worktree.claimId === claimId
            ? { ...worktree, coordinationState: "resume-ready" as const }
            : worktree
        ),
      };
      return {
        claimId,
        lease: writeLease(candidate),
        targetRef: lease.targetRef,
        targetSha,
      };
    }
  );
};

export const recordRemoteBranchReconciliation = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  receiptInput: unknown
): LoopLease & {
  remoteBranchReconciliation: RemoteBranchReconciliationReceipt;
} => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const receipt: RemoteBranchReconciliationReceipt =
    validateRemoteBranchReconciliation(receiptInput);
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "record remote branch reconciliation",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      if (lease.ownerAgentId !== ownerAgentId) {
        throw new SimpleChangesError(
          `Only loop owner ${lease.ownerAgentId} may record remote branch reconciliation.`,
          EXIT_CODES.unsafe
        );
      }
      assertControllerActive(lease);
      if (!lease.openingRemoteInventory) {
        throw new SimpleChangesError(
          "A legacy GitLab run without opening evidence cannot record an ordinary reconciliation receipt; use approved close-only post-cleanup recovery.",
          EXIT_CODES.unsafe
        );
      }
      const verification = verificationAgainst(lease, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Cannot record remote branch reconciliation with manifest violations: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      if (!(targetUsesGitLab(inventory) && receipt.provider === "gitlab")) {
        throw new SimpleChangesError(
          "Remote branch reconciliation provider must match the target GitLab remote.",
          EXIT_CODES.validation
        );
      }
      const targetBranch = targetBranchForRef(
        inventory.repository.primaryCheckout,
        lease.targetRef
      );
      const targetRevision = currentTargetRevision(lease);
      const project = gitLabProjectForTargetRef(
        inventory.repository.primaryCheckout,
        lease.targetRef
      );
      if (
        receipt.project !== project ||
        receipt.targetBranch !== targetBranch ||
        receipt.targetRevision !== targetRevision
      ) {
        throw new SimpleChangesError(
          `Remote branch reconciliation must bind GitLab project ${project ?? "(unresolved)"} and refreshed target ${targetBranch ?? "(unresolved)"} at ${targetRevision}.`,
          EXIT_CODES.validation
        );
      }
      if (
        lease.openingRemoteInventory &&
        remoteInventoryDigest(lease.openingRemoteInventory, "final") !==
          remoteInventoryDigest(receipt, "initial")
      ) {
        throw new SimpleChangesError(
          "Final remote reconciliation does not begin from the exact opening inventory persisted at loop start.",
          EXIT_CODES.validation
        );
      }
      return writeLease({
        ...lease,
        remoteBranchReconciliation: receipt,
        updatedAt: new Date().toISOString(),
      }) as LoopLease & {
        remoteBranchReconciliation: RemoteBranchReconciliationReceipt;
      };
    }
  );
};

export interface FinalizationCleanupResult {
  cleanedPrimaryPaths: string[];
  errors: string[];
  primaryUpdated: boolean;
  prunedWorktreeMetadata: number;
  removedBranches: string[];
  removedWorktrees: string[];
}

const emptyFinalizationCleanup = (): FinalizationCleanupResult => ({
  cleanedPrimaryPaths: [],
  errors: [],
  primaryUpdated: false,
  prunedWorktreeMetadata: 0,
  removedBranches: [],
  removedWorktrees: [],
});

const targetContainsRevision = (
  repositoryPath: string,
  targetRevision: string,
  revision: string | null
): boolean =>
  Boolean(
    revision &&
      runGit(
        repositoryPath,
        [
          "merge-base",
          "--is-ancestor",
          `${revision}^{commit}`,
          `${targetRevision}^{commit}`,
        ],
        true
      ).exitCode === 0
  );

const automaticRemovalDisposition = (
  lease: LoopLease,
  worktree: WorktreeInventory & { headSha: string },
  targetRevision: string
): LoopWorktreeDisposition => ({
  approvedBy: `mode:${lease.mode}`,
  branch: worktree.branch,
  changeDigest: worktree.changeDigest,
  createdAt: new Date().toISOString(),
  headSha: worktree.headSha,
  outcome: "remove-after-audit",
  path: worktree.path,
  reason:
    "The current integration request authorizes automatic cleanup after repeated inventory proved this unchanged clean checkout has zero commits outside the refreshed target.",
  status: "intended",
  targetRef: lease.targetRef,
  targetRevision,
  uniqueCommitCount: 0,
});

type AutomaticCleanupCandidate = WorktreeInventory & { headSha: string };

const automaticCleanupCandidates = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string,
  targetRevision: string
): AutomaticCleanupCandidate[] => {
  const registeredByPath = new Map(
    lease.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const primaryBranch =
    inventory.worktrees.find(
      (worktree) => worktree.path === lease.primaryCheckout
    )?.branch ?? null;
  return inventory.worktrees.filter((worktree) => {
    const registered = registeredByPath.get(worktree.path);
    const basicCandidate = Boolean(
      !worktree.isPrimary &&
        registered &&
        registered.role !== "concurrent-author" &&
        registered.role !== "retained" &&
        worktree.changes.length === 0 &&
        worktree.headSha &&
        targetContainsRevision(
          inventory.repository.primaryCheckout,
          targetRevision,
          worktree.headSha
        )
    );
    if (!(basicCandidate && registered)) {
      return false;
    }
    const activelyClaimed = concurrentClaimFor(
      lease,
      worktree,
      coordination,
      primaryBranch,
      targetBranch
    );
    return Boolean(
      !activelyClaimed &&
        (registered.createdByRun ||
          (registered.role === "preserved" &&
            registered.baselineHeadSha === worktree.headSha &&
            registered.baselineChangeDigest === worktree.changeDigest))
    );
  }) as AutomaticCleanupCandidate[];
};

const recordAutomaticDispositions = (
  lease: LoopLease,
  candidates: AutomaticCleanupCandidate[],
  targetRevision: string
): LoopLease => {
  const dispositions = candidates.map((worktree) =>
    automaticRemovalDisposition(lease, worktree, targetRevision)
  );
  if (dispositions.length === 0) {
    return lease;
  }
  const paths = new Set(dispositions.map((disposition) => disposition.path));
  return writeLease({
    ...lease,
    dispositions: [
      ...(lease.dispositions ?? []).filter(
        (disposition) => !paths.has(disposition.path)
      ),
      ...dispositions,
    ],
    updatedAt: new Date().toISOString(),
  });
};

const completeAutomaticDispositions = (
  lease: LoopLease,
  paths: string[]
): LoopLease => {
  const completedPaths = new Set(paths);
  if (completedPaths.size === 0) {
    return lease;
  }
  const completedAt = new Date().toISOString();
  return writeLease({
    ...lease,
    dispositions: (lease.dispositions ?? []).map((disposition) =>
      completedPaths.has(disposition.path)
        ? { ...disposition, completedAt, status: "completed" }
        : disposition
    ),
    updatedAt: completedAt,
  });
};

const completeAbsentRemovalIntents = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string
): LoopLease => {
  const currentPaths = new Set(
    inventory.worktrees.map((worktree) => worktree.path)
  );
  const completedPaths = (lease.dispositions ?? [])
    .filter(
      (disposition) =>
        disposition.status !== "completed" &&
        !currentPaths.has(disposition.path) &&
        disposition.targetRef === lease.targetRef &&
        disposition.targetRevision === targetRevision &&
        targetContainsRevision(
          inventory.repository.primaryCheckout,
          targetRevision,
          disposition.headSha
        )
    )
    .map((disposition) => disposition.path);
  return completeAutomaticDispositions(lease, completedPaths);
};

const reconcileAbsentRetainedWorktrees = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopLease => {
  if (!AUTOMATIC_CLEANUP_MODES.has(lease.mode)) {
    return lease;
  }
  let targetRevision: string;
  try {
    targetRevision = currentTargetRevision(lease);
  } catch {
    return lease;
  }
  const currentPaths = new Set(
    inventory.worktrees.map((worktree) => worktree.path)
  );
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const activelyClaimedPaths = new Set(
    coordination.claims
      .filter((claim) => claim.state === "active")
      .map((claim) => claim.path)
  );
  const completedAt = new Date().toISOString();
  const dispositions = lease.worktrees.flatMap((worktree) => {
    if (
      worktree.role !== "retained" ||
      !worktree.retention ||
      currentPaths.has(worktree.path) ||
      activelyClaimedPaths.has(worktree.path) ||
      !worktree.branch ||
      !worktree.baselineHeadSha ||
      !targetContainsRevision(
        inventory.repository.primaryCheckout,
        targetRevision,
        worktree.baselineHeadSha
      )
    ) {
      return [];
    }
    const branchRevisionResult = runGit(
      inventory.repository.primaryCheckout,
      ["rev-parse", "--verify", `refs/heads/${worktree.branch}^{commit}`],
      true
    );
    const branchRevision = branchRevisionResult.stdout.trim();
    if (
      branchRevisionResult.exitCode !== 0 ||
      !branchRevision ||
      !targetContainsRevision(
        inventory.repository.primaryCheckout,
        targetRevision,
        branchRevision
      )
    ) {
      return [];
    }
    return [
      {
        approvedBy: `mode:${lease.mode}`,
        branch: worktree.branch,
        changeDigest: worktree.baselineChangeDigest,
        completedAt,
        createdAt: completedAt,
        headSha: branchRevision,
        outcome: "remove-after-audit" as const,
        path: worktree.path,
        reason:
          "The retained checkout is already absent, and its last audited clean revision plus current local branch are both contained in the finalized target. Reconcile stale cleanup bookkeeping without another user confirmation.",
        status: "completed" as const,
        targetRef: lease.targetRef,
        targetRevision,
        uniqueCommitCount: 0 as const,
      },
    ];
  });
  if (dispositions.length === 0) {
    return lease;
  }
  const paths = new Set(dispositions.map((disposition) => disposition.path));
  return writeLease({
    ...lease,
    dispositions: [
      ...(lease.dispositions ?? []).filter(
        (disposition) => !paths.has(disposition.path)
      ),
      ...dispositions,
    ],
    updatedAt: completedAt,
  });
};

interface AutomaticRemovalResult {
  lease: LoopLease;
  removed: AutomaticCleanupCandidate[];
}

const crashAfterAutomaticWorktreeRemovalForTest = (path: string): void => {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.SIMPLE_CHANGES_TEST_CRASH_AFTER_WORKTREE_REMOVE === path
  ) {
    process.kill(process.pid, "SIGKILL");
  }
};

const removeAutomaticWorktrees = (
  lease: LoopLease,
  repositoryPath: string,
  targetBranch: string,
  targetRevision: string,
  candidates: AutomaticCleanupCandidate[],
  cleanup: FinalizationCleanupResult
): AutomaticRemovalResult => {
  let currentLease = lease;
  const removed: AutomaticCleanupCandidate[] = [];
  for (const worktree of candidates.filter(
    (candidate) => !candidate.prunable
  )) {
    const freshInventory = captureInventory(repositoryPath);
    const fresh = automaticCleanupCandidates(
      lease,
      freshInventory,
      targetBranch,
      targetRevision
    ).find(
      (candidate) =>
        candidate.path === worktree.path &&
        candidate.branch === worktree.branch &&
        candidate.headSha === worktree.headSha &&
        candidate.changeDigest === worktree.changeDigest
    );
    if (!fresh) {
      cleanup.errors.push(
        `Cleanup candidate changed or became claimed during final audit and was preserved: ${worktree.path}`
      );
      continue;
    }
    currentLease = recordAutomaticDispositions(
      currentLease,
      [fresh],
      targetRevision
    );
    const removal = runGit(
      repositoryPath,
      ["worktree", "remove", worktree.path],
      true
    );
    if (removal.exitCode === 0) {
      crashAfterAutomaticWorktreeRemovalForTest(worktree.path);
      currentLease = completeAutomaticDispositions(currentLease, [
        worktree.path,
      ]);
      cleanup.removedWorktrees.push(worktree.path);
      removed.push(worktree);
      continue;
    }
    cleanup.errors.push(
      `Could not remove proven cleanup worktree ${worktree.path}: ${removal.stderr.trim() || removal.stdout.trim()}`
    );
  }
  return { lease: currentLease, removed };
};

const pruneAutomaticWorktreeMetadata = (
  lease: LoopLease,
  repositoryPath: string,
  candidates: AutomaticCleanupCandidate[],
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): AutomaticRemovalResult => {
  let currentLease = lease;
  const removed: AutomaticCleanupCandidate[] = [];
  const prunable = candidates.filter((candidate) => candidate.prunable);
  if (prunable.length === 0) {
    return { lease: currentLease, removed };
  }
  currentLease = recordAutomaticDispositions(
    currentLease,
    prunable,
    targetRevision
  );
  const result = runGit(
    repositoryPath,
    ["worktree", "prune", "--expire", "now"],
    true
  );
  if (result.exitCode !== 0) {
    cleanup.errors.push(
      `Could not prune stale worktree metadata: ${result.stderr.trim() || result.stdout.trim()}`
    );
    return { lease: currentLease, removed };
  }
  const remainingPaths = new Set(
    captureInventory(repositoryPath).worktrees.map((worktree) => worktree.path)
  );
  for (const candidate of prunable) {
    if (remainingPaths.has(candidate.path)) {
      cleanup.errors.push(
        `Stale worktree metadata remained after pruning: ${candidate.path}`
      );
      continue;
    }
    cleanup.prunedWorktreeMetadata += 1;
    cleanup.removedWorktrees.push(candidate.path);
    removed.push(candidate);
  }
  currentLease = completeAutomaticDispositions(
    currentLease,
    removed.map((candidate) => candidate.path)
  );
  return { lease: currentLease, removed };
};

const removeTargetContainedBranches = (
  lease: LoopLease,
  repositoryPath: string,
  targetBranch: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): void => {
  const inventory = captureInventory(repositoryPath);
  const openingBranches = new Map(
    (lease.openingBranches ?? []).map((branch) => [branch.name, branch.sha])
  );
  const runOwnedBranches = new Set([
    ...lease.worktrees
      .filter((worktree) => worktree.createdByRun)
      .flatMap((worktree) => (worktree.branch ? [worktree.branch] : [])),
    ...lease.preparations.map((preparation) => preparation.branch),
  ]);
  const reconciledAbsentBranches = new Set(
    (lease.dispositions ?? [])
      .filter(
        (disposition) =>
          disposition.status === "completed" &&
          disposition.targetRef === lease.targetRef &&
          disposition.targetRevision === targetRevision &&
          disposition.branch
      )
      .map((disposition) => disposition.branch as string)
  );
  for (const branch of inventory.branches) {
    const unchangedOpeningBranch =
      openingBranches.get(branch.name) === branch.sha;
    const removable =
      branch.name !== targetBranch &&
      branch.worktreePath === null &&
      (unchangedOpeningBranch ||
        runOwnedBranches.has(branch.name) ||
        reconciledAbsentBranches.has(branch.name)) &&
      targetContainsRevision(repositoryPath, targetRevision, branch.sha);
    if (!removable) {
      continue;
    }
    const deleted = runGit(
      repositoryPath,
      ["update-ref", "-d", `refs/heads/${branch.name}`, branch.sha],
      true
    );
    if (deleted.exitCode !== 0) {
      cleanup.errors.push(
        `Could not delete proven target-contained branch ${branch.name}: ${deleted.stderr.trim() || deleted.stdout.trim()}`
      );
      continue;
    }
    cleanup.removedBranches.push(branch.name);
    runGit(
      repositoryPath,
      ["config", "--remove-section", `branch.${branch.name}`],
      true
    );
  }
};

const switchCleanPrimaryToTarget = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): void => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (
    !primary ||
    primary.changes.length > 0 ||
    primary.branch === targetBranch
  ) {
    return;
  }
  const targetExists = inventory.branches.some(
    (branch) => branch.name === targetBranch
  );
  const result = runGit(
    lease.primaryCheckout,
    targetExists
      ? ["switch", targetBranch]
      : ["switch", "-c", targetBranch, targetRevision],
    true
  );
  if (result.exitCode === 0) {
    cleanup.primaryUpdated = true;
    return;
  }
  cleanup.errors.push(
    `Could not restore clean primary checkout to ${targetBranch}: ${result.stderr.trim() || result.stdout.trim()}`
  );
};

const diffMatchesRevision = (
  repositoryPath: string,
  revision: string,
  paths: string[],
  cached = false
): boolean =>
  runGit(
    repositoryPath,
    [
      "diff",
      ...(cached ? ["--cached"] : []),
      ...(cached ? ["--ita-visible-in-index"] : []),
      "--quiet",
      revision,
      "--",
      ...paths,
    ],
    true
  ).exitCode === 0;

const indexHasOnlyOrdinaryEntries = (
  repositoryPath: string,
  paths: string[]
): boolean =>
  paths.every((path) => {
    const result = runGit(
      repositoryPath,
      ["ls-files", "--debug", "--", path],
      true
    );
    if (result.exitCode !== 0) {
      return false;
    }
    const flags = [...result.stdout.matchAll(/^\s+flags:\s+(\d+)\s*$/gmu)];
    return flags.every((match) => match[1] === "0");
  });

const reconcileTargetEquivalentPrimaryChanges = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): void => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (!(primary?.headSha && primary.changes.length > 0)) {
    return;
  }
  const eligiblePaths = new Set<string>();
  for (const change of primary.changes) {
    if (change.conflicted || change.untracked) {
      continue;
    }
    const paths = [change.originalPath, change.path].filter(
      (path): path is string => Boolean(path)
    );
    const worktreeMatchesTarget = diffMatchesRevision(
      lease.primaryCheckout,
      targetRevision,
      paths
    );
    const indexIsRecoverable =
      indexHasOnlyOrdinaryEntries(lease.primaryCheckout, paths) &&
      (diffMatchesRevision(
        lease.primaryCheckout,
        primary.headSha,
        paths,
        true
      ) ||
        diffMatchesRevision(
          lease.primaryCheckout,
          targetRevision,
          paths,
          true
        ));
    if (worktreeMatchesTarget && indexIsRecoverable) {
      for (const path of paths) {
        eligiblePaths.add(path);
      }
    }
  }
  if (eligiblePaths.size === 0) {
    return;
  }
  const freshPrimary = captureInventory(lease.primaryCheckout).worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (freshPrimary?.changeDigest !== primary.changeDigest) {
    cleanup.errors.push(
      "The primary checkout changed while target-equivalent paths were being audited; no primary path was cleaned."
    );
    return;
  }
  const paths = [...eligiblePaths].sort();
  const restored = runGit(
    lease.primaryCheckout,
    [
      "restore",
      `--source=${primary.headSha}`,
      "--staged",
      "--worktree",
      "--",
      ...paths,
    ],
    true
  );
  if (restored.exitCode !== 0) {
    cleanup.errors.push(
      `Could not normalize target-equivalent primary paths: ${restored.stderr.trim() || restored.stdout.trim()}`
    );
    return;
  }
  cleanup.cleanedPrimaryPaths.push(...paths);
  cleanup.primaryUpdated = true;
};

const fastForwardCleanPrimary = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): void => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  const localTarget = inventory.branches.find(
    (branch) => branch.name === targetBranch
  );
  const canFastForward = Boolean(
    primary?.branch === targetBranch &&
      primary.changes.length === 0 &&
      localTarget &&
      localTarget.sha !== targetRevision &&
      targetContainsRevision(
        inventory.repository.primaryCheckout,
        targetRevision,
        localTarget.sha
      )
  );
  if (!(canFastForward && localTarget)) {
    return;
  }
  const result = runGit(
    lease.primaryCheckout,
    ["merge", "--ff-only", targetRevision],
    true
  );
  if (result.exitCode === 0) {
    cleanup.primaryUpdated = true;
    return;
  }
  cleanup.errors.push(
    `Could not fast-forward clean primary checkout to ${targetRevision}: ${result.stderr.trim() || result.stdout.trim()}`
  );
};

const bindAutomaticPrimaryBranchChange = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopLease => {
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (
    !(primary && registered?.mutationAllowed) ||
    registered.branch === primary.branch
  ) {
    return lease;
  }
  return writeLease({
    ...lease,
    updatedAt: new Date().toISOString(),
    worktrees: lease.worktrees.map((worktree) =>
      worktree.path === lease.primaryCheckout
        ? { ...worktree, branch: primary.branch }
        : worktree
    ),
  });
};

const automaticFinalizationCleanup = (
  leaseInput: LoopLease,
  inventoryInput: RepositoryInventory,
  verification: LoopVerification
): { cleanup: FinalizationCleanupResult; lease: LoopLease } => {
  const cleanup = emptyFinalizationCleanup();
  if (!(AUTOMATIC_CLEANUP_MODES.has(leaseInput.mode) && verification.ok)) {
    return { cleanup, lease: leaseInput };
  }
  if (targetUsesGitLab(inventoryInput) && !leaseInput.openingRemoteInventory) {
    // Legacy GitLab runs without an opening provider inventory are recovery-only.
    // Finalization must not turn missing historical evidence into mutation authority.
    return { cleanup, lease: leaseInput };
  }
  let lease = leaseInput;
  let targetRevision: string;
  const targetBranch = targetBranchForRef(
    inventoryInput.repository.primaryCheckout,
    lease.targetRef
  );
  try {
    targetRevision = currentTargetRevision(lease);
  } catch (error) {
    cleanup.errors.push(
      error instanceof Error
        ? error.message
        : "The cleanup target is unresolved."
    );
    return { cleanup, lease };
  }
  if (!targetBranch) {
    cleanup.errors.push(
      `Cannot resolve the local branch for ${lease.targetRef}.`
    );
    return { cleanup, lease };
  }
  const repositoryPath = inventoryInput.repository.primaryCheckout;
  lease = completeAbsentRemovalIntents(lease, inventoryInput, targetRevision);
  const candidates = automaticCleanupCandidates(
    lease,
    inventoryInput,
    targetBranch,
    targetRevision
  );
  const liveRemoval = removeAutomaticWorktrees(
    lease,
    repositoryPath,
    targetBranch,
    targetRevision,
    candidates,
    cleanup
  );
  ({ lease } = liveRemoval);
  const staleRemoval = pruneAutomaticWorktreeMetadata(
    lease,
    repositoryPath,
    candidates,
    targetRevision,
    cleanup
  );
  ({ lease } = staleRemoval);
  removeTargetContainedBranches(
    lease,
    repositoryPath,
    targetBranch,
    targetRevision,
    cleanup
  );
  let inventory = captureInventory(repositoryPath);
  reconcileTargetEquivalentPrimaryChanges(
    lease,
    inventory,
    targetRevision,
    cleanup
  );
  inventory = captureInventory(repositoryPath);
  switchCleanPrimaryToTarget(
    lease,
    inventory,
    targetBranch,
    targetRevision,
    cleanup
  );
  inventory = captureInventory(repositoryPath);
  fastForwardCleanPrimary(
    lease,
    inventory,
    targetBranch,
    targetRevision,
    cleanup
  );
  inventory = captureInventory(repositoryPath);
  lease = bindAutomaticPrimaryBranchChange(lease, inventory);
  removeTargetContainedBranches(
    lease,
    repositoryPath,
    targetBranch,
    targetRevision,
    cleanup
  );
  cleanup.removedBranches = [...new Set(cleanup.removedBranches)].sort();
  cleanup.removedWorktrees = [...new Set(cleanup.removedWorktrees)].sort();
  return { cleanup, lease };
};

const targetTreeEntry = (
  repositoryPath: string,
  targetRevision: string,
  path: string
): string | null => {
  try {
    const output = runGit(repositoryPath, [
      "ls-tree",
      targetRevision,
      "--",
      path,
    ]).stdout.trim();
    const match = LS_TREE_ENTRY_PATTERN.exec(output);
    return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
  } catch {
    return null;
  }
};

const missingShipmentScopeBlockers = (lease: LoopLease): string[] =>
  lease.shipmentScopeRequired && !lease.shipmentScope
    ? [
        "Record the comprehensive shipment scope and pre-ship brief before ending this Ship run.",
      ]
    : [];

const shipmentOutcomeCompletionBlockers = (
  lease: LoopLease,
  targetRevision: string | null
): string[] => {
  if (!lease.shipmentScope) {
    return [];
  }
  if (!lease.shipmentOutcome) {
    return [
      "Record the exact reviewed shipment outcome before completion; every scoped unit and final target delta must be accounted for.",
    ];
  }
  const { receipt } = lease.shipmentOutcome;
  if (receipt.targetRevision !== targetRevision) {
    return [
      `Shipment outcome targets ${receipt.targetRevision}, but the current target is ${targetRevision ?? "unresolved"}. Reconcile the exact final target again.`,
    ];
  }
  const paths = [
    ...receipt.units.flatMap((unit) => [
      ...unit.finalPaths,
      ...unit.originalPaths,
    ]),
    ...receipt.additionalPaths,
  ];
  return paths.flatMap((item) =>
    targetTreeEntry(
      lease.primaryCheckout,
      receipt.targetRevision,
      item.path
    ) === item.entry
      ? []
      : [`Shipment outcome entry changed after review: ${item.path}`]
  );
};

const loopCompletionBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification,
  cleanupErrors: string[] = []
): string[] => {
  const blockers: string[] = [...cleanupErrors];
  blockers.push(...missingShipmentScopeBlockers(lease));
  if (!verification.ok) {
    blockers.push(
      `manifest violations: ${verification.violations
        .map((violation) => `${violation.code}:${violation.path}`)
        .join(", ")}`
    );
  }
  const liveRunWorktrees = lease.worktrees.filter(
    (worktree) =>
      worktree.createdByRun &&
      inventory.worktrees.some((current) => current.path === worktree.path)
  );
  if (liveRunWorktrees.length > 0) {
    blockers.push(
      `Remove run-created worktrees before ending the loop: ${liveRunWorktrees
        .map((worktree) => worktree.path)
        .join(", ")}`
    );
  }
  let targetBranch: string | null = null;
  let targetRevision: string | null = null;
  try {
    targetBranch = targetBranchForRef(
      inventory.repository.primaryCheckout,
      lease.targetRef
    );
    targetRevision = currentTargetRevision(lease);
  } catch {
    blockers.push(
      `Refresh unresolved target ref ${lease.targetRef} before ending the loop.`
    );
  }
  blockers.push(...shipmentOutcomeCompletionBlockers(lease, targetRevision));
  const localTarget = targetBranch
    ? inventory.branches.find((branch) => branch.name === targetBranch)
    : undefined;
  if (targetBranch && targetRevision && !localTarget) {
    blockers.push(
      `Create local target branch ${targetBranch} at ${targetRevision} before ending the loop.`
    );
  } else if (
    targetRevision &&
    localTarget &&
    localTarget.sha !== targetRevision
  ) {
    blockers.push(
      `Update local target branch ${localTarget.name} from ${localTarget.sha} to ${targetRevision} before ending the loop.`
    );
  }
  const primaryWorktree = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (targetBranch && primaryWorktree?.branch !== targetBranch) {
    blockers.push(
      `Restore primary checkout ${lease.primaryCheckout} to local target branch ${targetBranch} before ending the loop.`
    );
  }
  if (primaryWorktree && primaryWorktree.changes.length > 0) {
    blockers.push(
      `Clean primary checkout ${lease.primaryCheckout} before ending the loop; preserve uncertain changes instead of discarding them.`
    );
  }
  const registeredByPath = new Map(
    lease.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const isTargetContained = (revision: string): boolean =>
    Boolean(
      targetRevision &&
        runGit(
          inventory.repository.primaryCheckout,
          [
            "merge-base",
            "--is-ancestor",
            `${revision}^{commit}`,
            `${targetRevision}^{commit}`,
          ],
          true
        ).exitCode === 0
    );
  const mergedCleanupWorktrees = inventory.worktrees
    .filter((worktree) => {
      const registered = registeredByPath.get(worktree.path);
      return (
        !worktree.isPrimary &&
        worktree.changes.length === 0 &&
        !registered?.createdByRun &&
        registered?.role !== "concurrent-author" &&
        registered?.role !== "retained" &&
        Boolean(worktree.headSha && isTargetContained(worktree.headSha))
      );
    })
    .map((worktree) => worktree.path);
  if (mergedCleanupWorktrees.length > 0) {
    blockers.push(
      `Remove clean worktrees whose branches are contained in ${lease.targetRef}: ${mergedCleanupWorktrees.join(", ")}`
    );
  }
  const mergedCleanupBranchNames = inventory.branches
    .filter(
      (branch) =>
        branch.name !== targetBranch &&
        branch.worktreePath === null &&
        isTargetContained(branch.sha)
    )
    .map((branch) => branch.name);
  if (mergedCleanupBranchNames.length > 0) {
    blockers.push(
      `Delete local branches contained in ${lease.targetRef}: ${mergedCleanupBranchNames.join(", ")}`
    );
  }
  if (
    lease.emergencyShipping &&
    deriveEmergencyShippingStatus(lease.emergencyShipping) !== "complete"
  ) {
    blockers.push(
      `Emergency Shipping remains incomplete: ${decideEmergencyShipping(lease.emergencyShipping).action}.`
    );
  }
  try {
    assertCurrentRemoteBranchReconciliation(lease, inventory);
  } catch (error) {
    blockers.push(
      error instanceof Error ? error.message : "Remote reconciliation failed."
    );
  }
  return blockers;
};

export interface LoopFinalizationResult {
  blockers: string[];
  cleanup: FinalizationCleanupResult;
  lease: LoopLease | null;
  outcome: "completed" | "relinquished";
  verification: LoopVerification;
}

export interface PostCleanupRecoveryResult {
  active: false;
  archivedAt: string;
  ok: true;
  retiredClaimIds: string[];
  runId: string;
  violations: [];
}

const completedPostCleanupRecovery = (
  commonGitDirectory: string,
  runId: string,
  receiptDigest: string
): PostCleanupRecoveryResult | null => {
  const completedPath = recoveryHistoryPath(
    commonGitDirectory,
    runId,
    "completed"
  );
  if (
    !existsSync(completedPath) ||
    existsSync(loopLeasePath(commonGitDirectory))
  ) {
    return null;
  }
  const completed = readImmutableRecoveryEvent<{
    archivedAt: string;
    receiptDigest: string;
    retiredClaimIds: string[];
  }>(completedPath);
  if (completed.receiptDigest !== receiptDigest) {
    throw new SimpleChangesError(
      "Post-cleanup recovery was already completed with different evidence.",
      EXIT_CODES.unsafe
    );
  }
  return {
    active: false,
    archivedAt: completed.archivedAt,
    ok: true,
    retiredClaimIds: completed.retiredClaimIds,
    runId,
    violations: [],
  };
};

const postCleanupAbsentPaths = (
  inventory: RepositoryInventory,
  lease: LoopLease,
  ownerAgentId: string,
  receipt: PostCleanupRecoveryReceipt,
  postRetirementClaimDigest?: string
): string[] => {
  if (lease.ownerAgentId !== ownerAgentId) {
    throw new SimpleChangesError(
      `Only loop owner ${lease.ownerAgentId} may recover this bookkeeping record.`,
      EXIT_CODES.unsafe
    );
  }
  assertControllerActive(lease);
  if (lease.openingRemoteInventory) {
    throw new SimpleChangesError(
      "Post-cleanup recovery is only for a legacy run whose opening remote inventory is unavailable.",
      EXIT_CODES.usage
    );
  }
  const targetBranch = targetBranchForRef(
    inventory.repository.primaryCheckout,
    lease.targetRef
  );
  const targetRevision = currentTargetRevision(lease);
  const project = gitLabProjectForTargetRef(
    inventory.repository.primaryCheckout,
    lease.targetRef
  );
  if (
    receipt.project !== project ||
    receipt.targetBranch !== targetBranch ||
    receipt.targetRevision !== targetRevision
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery must bind the exact current GitLab project, target branch, and target revision.",
      EXIT_CODES.validation
    );
  }
  const verification = verificationAgainst(lease, inventory);
  const recoverableMissingCreatedWorktrees = new Set(
    lease.worktrees
      .filter(
        (worktree) =>
          worktree.createdByRun &&
          worktree.role === "preserved" &&
          !inventory.worktrees.some(
            (current) => current.path === worktree.path
          ) &&
          targetContainsRevision(
            inventory.repository.primaryCheckout,
            targetRevision,
            worktree.baselineHeadSha
          )
      )
      .map((worktree) => worktree.path)
  );
  const currentPrimary = inventory.worktrees.find(
    (worktree) => worktree.path === inventory.repository.primaryCheckout
  );
  const recoverableCurrentPrimaryBranch = Boolean(
    currentPrimary &&
      currentPrimary.branch === targetBranch &&
      currentPrimary.headSha === targetRevision &&
      currentPrimary.changes.length === 0
  );
  const remainingViolations = verification.violations.filter((violation) => {
    if (
      violation.code === "missing-preserved-worktree" &&
      recoverableMissingCreatedWorktrees.has(violation.path)
    ) {
      return false;
    }
    if (
      violation.code === "registered-worktree-branch-changed" &&
      violation.path === inventory.repository.primaryCheckout &&
      recoverableCurrentPrimaryBranch
    ) {
      return false;
    }
    return true;
  });
  if (remainingViolations.length > 0) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close while controller manifest violations remain.",
      EXIT_CODES.unsafe
    );
  }
  const recoveryVerification: LoopVerification = {
    ...verification,
    ok: true,
    violations: [],
  };
  const coordination = readCoordinationDocumentFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  const activeClaims = coordination.claims.filter(
    (claim) => claim.state === "active"
  );
  if (activeClaims.length !== receipt.secondClaimObservation.activeClaimCount) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close because the active worktree claim count changed after the approved observations.",
      EXIT_CODES.unsafe
    );
  }
  const currentPaths = new Set(
    inventory.worktrees.map((worktree) => worktree.path)
  );
  if (activeClaims.some((claim) => !currentPaths.has(claim.path))) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close while an active claim names an absent worktree.",
      EXIT_CODES.unsafe
    );
  }
  const currentClaimDigest = worktreeClaimDocumentDigest(coordination);
  const retirementAlreadyApplied =
    postRetirementClaimDigest !== undefined &&
    currentClaimDigest === postRetirementClaimDigest;
  if (
    currentClaimDigest !== receipt.secondClaimObservation.digest &&
    !retirementAlreadyApplied
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close because worktree claims changed after the approved observations.",
      EXIT_CODES.unsafe
    );
  }
  const firstObservation = Date.parse(receipt.firstFinalInventory.observedAt);
  if (
    !retirementAlreadyApplied &&
    coordination.claims.some(
      (claim) => Date.parse(claim.updatedAt) > firstObservation
    )
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery cannot close because a worktree claim changed during or after the approved observation window.",
      EXIT_CODES.unsafe
    );
  }
  const blockers = loopCompletionBlockers(
    lease,
    inventory,
    recoveryVerification
  ).filter(
    (blocker) =>
      blocker !== MISSING_OPENING_REMOTE_INVENTORY_BLOCKER &&
      blocker !== MISSING_REMOTE_RECONCILIATION_BLOCKER
  );
  if (blockers.length > 0) {
    throw new SimpleChangesError(
      `Post-cleanup recovery is close-only and cannot proceed while cleanup remains: ${blockers.join(" ")}`,
      EXIT_CODES.unsafe
    );
  }
  return lease.worktrees
    .map((worktree) => worktree.path)
    .filter((path) => !currentPaths.has(path))
    .sort((left, right) => left.localeCompare(right));
};

const preparePostCleanupRecoveryIntent = (
  commonGitDirectory: string,
  inventory: RepositoryInventory,
  lease: LoopLease,
  ownerAgentId: string,
  receipt: PostCleanupRecoveryReceipt,
  receiptDigest: string
): { absentPaths: string[]; intent: PostCleanupRecoveryIntent } => {
  const intentPath = recoveryHistoryPath(
    commonGitDirectory,
    lease.runId,
    "intent"
  );
  const existingIntent = existsSync(intentPath)
    ? readImmutableRecoveryEvent<PostCleanupRecoveryIntent>(intentPath)
    : null;
  const absentPaths = postCleanupAbsentPaths(
    inventory,
    lease,
    ownerAgentId,
    receipt,
    existingIntent?.claimRetirement.afterDigest
  );
  const archivedAt = existingIntent?.archivedAt ?? new Date().toISOString();
  const leaseDigest = loopManifestDigest(lease);
  const claimRetirement =
    existingIntent?.claimRetirement ??
    planAbsentWorktreeClaimRetirementUnderLock(
      commonGitDirectory,
      absentPaths,
      ownerAgentId,
      archivedAt
    );
  const intent = writeImmutableRecoveryEvent<PostCleanupRecoveryIntent>(
    intentPath,
    {
      archivedAt,
      authority: "close-only",
      claimRetirement,
      kind: "post-cleanup-recovery",
      lease,
      leaseDigest,
      receipt,
      receiptDigest,
      removedWorktreePaths: absentPaths,
      runId: lease.runId,
      schemaVersion: 1,
    }
  );
  if (
    intent.receiptDigest !== receiptDigest ||
    intent.leaseDigest !== leaseDigest ||
    intent.runId !== lease.runId ||
    intent.authority !== "close-only" ||
    intent.kind !== "post-cleanup-recovery" ||
    typeof intent.claimRetirement !== "object" ||
    intent.claimRetirement === null ||
    intent.claimRetirement.beforeDigest !==
      receipt.secondClaimObservation.digest ||
    JSON.stringify(intent.removedWorktreePaths) !== JSON.stringify(absentPaths)
  ) {
    throw new SimpleChangesError(
      "Post-cleanup recovery intent already exists with different evidence.",
      EXIT_CODES.unsafe
    );
  }
  return { absentPaths, intent };
};

export const recoverPostCleanupLoop = (
  repositoryPath: string,
  runIdInput: string,
  ownerAgentIdInput: string,
  receiptInput: unknown
): PostCleanupRecoveryResult => {
  const runId = requiredRunId(runIdInput);
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const receipt: PostCleanupRecoveryReceipt =
    validatePostCleanupRecovery(receiptInput);
  const opening = captureInventory(repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withStateLock(commonGitDirectory, "post-cleanup recovery", () => {
    const receiptDigest = sha256(JSON.stringify(receipt));
    const prior = completedPostCleanupRecovery(
      commonGitDirectory,
      runId,
      receiptDigest
    );
    if (prior) {
      return prior;
    }
    return withWorktreeCoordinationLock(
      commonGitDirectory,
      "post-cleanup recovery close",
      () => {
        const inventory = captureInventory(repositoryPath);
        const lease = requireLease(inventory);
        assertMatchingRun(lease, runId);
        const { absentPaths, intent } = preparePostCleanupRecoveryIntent(
          commonGitDirectory,
          inventory,
          lease,
          ownerAgentId,
          receipt,
          receiptDigest
        );
        if (
          process.env.NODE_ENV === "test" &&
          process.env.SIMPLE_CHANGES_TEST_CRASH_AFTER_POST_CLEANUP_INTENT ===
            runId
        ) {
          process.kill(process.pid, "SIGKILL");
        }
        const retiredClaimIds = retireAbsentWorktreeClaimsUnderLock(
          commonGitDirectory,
          absentPaths,
          ownerAgentId,
          intent.claimRetirement
        );
        if (
          process.env.NODE_ENV === "test" &&
          process.env
            .SIMPLE_CHANGES_TEST_CRASH_AFTER_POST_CLEANUP_RETIREMENT === runId
        ) {
          process.kill(process.pid, "SIGKILL");
        }
        const completed = writeImmutableRecoveryEvent(
          recoveryHistoryPath(commonGitDirectory, runId, "completed"),
          {
            archivedAt: intent.archivedAt,
            authority: "close-only",
            kind: "post-cleanup-recovery-completed",
            receiptDigest,
            retiredClaimIds,
            runId,
            schemaVersion: 1,
          }
        );
        if (completed.receiptDigest !== receiptDigest) {
          throw new SimpleChangesError(
            "Post-cleanup recovery completion evidence does not match the approved receipt.",
            EXIT_CODES.unsafe
          );
        }
        rmSync(loopLeasePath(commonGitDirectory), { force: true });
        return {
          active: false,
          archivedAt: completed.archivedAt,
          ok: true,
          retiredClaimIds: completed.retiredClaimIds,
          runId,
          violations: [],
        };
      }
    );
  });
};

export const finalizeLoop = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  reasonInput: string
): LoopFinalizationResult => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const reason = requiredText(reasonInput, "finalization reason");
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop finalize",
    () =>
      withWorktreeCoordinationLock(
        opening.repository.commonGitDirectory,
        "loop finalize cleanup",
        () => {
          const inventory = captureInventory(repositoryPath);
          let lease = requireLease(inventory);
          assertMatchingRun(lease, runId);
          if (lease.ownerAgentId !== ownerAgentId) {
            throw new SimpleChangesError(
              `Only loop owner ${lease.ownerAgentId} may finalize this loop.`,
              EXIT_CODES.unsafe
            );
          }
          assertControllerActive(lease);
          lease = reconcileAbsentRetainedWorktrees(lease, inventory);
          const openingVerification = verificationAgainst(lease, inventory);
          const automaticCleanup =
            lease.shipmentScopeRequired && !lease.shipmentScope
              ? { cleanup: emptyFinalizationCleanup(), lease }
              : automaticFinalizationCleanup(
                  lease,
                  inventory,
                  openingVerification
                );
          ({ lease } = automaticCleanup);
          const finalInventory = captureInventory(repositoryPath);
          const verification = verificationAgainst(lease, finalInventory);
          const blockers = loopCompletionBlockers(
            lease,
            finalInventory,
            verification,
            automaticCleanup.cleanup.errors
          );
          if (blockers.length === 0) {
            rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
            return {
              blockers,
              cleanup: automaticCleanup.cleanup,
              lease: null,
              outcome: "completed",
              verification,
            };
          }
          const now = new Date().toISOString();
          const updated = writeLease({
            ...lease,
            controller: {
              ...controllerLifecycle(lease),
              reason,
              relinquishedAt: now,
              status: "relinquished",
            },
            shipmentScopeFrozenAt: effectiveShipmentScopeFrozenAt(lease) ?? now,
            updatedAt: now,
            worktrees: lease.worktrees.map((worktree) =>
              worktree.role === "controller"
                ? { ...worktree, mutationAllowed: false }
                : worktree
            ),
          });
          return {
            blockers,
            cleanup: automaticCleanup.cleanup,
            lease: updated,
            outcome: "relinquished",
            verification,
          };
        }
      )
  );
};

const closeEquivalentSchemaDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../evals/schemas"
);

const closeEquivalentRecordSchema = JSON.parse(
  readFileSync(
    resolve(
      closeEquivalentSchemaDirectory,
      "loop-close-equivalent.schema.json"
    ),
    "utf8"
  )
) as Record<string, unknown>;

/**
 * Local shape of the read-only `worktree-equivalence` audit receipt produced
 * by a separate command. Defined here on purpose instead of importing it, so
 * this module keeps working when that command and its module are absent.
 */
interface WorktreeEquivalenceReceipt {
  commits: Array<{
    matched: boolean;
    matchedTargetSha?: string;
    patchId: string;
    sha: string;
  }>;
  disclaimer: string;
  equivalence: "contained" | "divergent" | "partial";
  head: string;
  mergeBase: string;
  paths: Array<{
    path: string;
    state: "absent-in-target" | "differs" | "identical";
  }>;
  targetRef: string;
  targetRevision: string;
}

export interface LoopEquivalenceEvidence {
  receipt: unknown;
  worktreePath: string;
}

export interface LoopCloseEquivalentRecord {
  approvedBy: string;
  archivedAt: string;
  authority: "close-equivalent";
  kind: "loop-close-equivalent";
  leaseDigest: string;
  outcome: "target-equivalent";
  reason: string;
  remoteReconciliationSkipped: string;
  runId: string;
  schemaVersion: 1;
  targetRef: string;
  targetRevision: string;
  worktrees: LoopCloseEquivalentWorktreeProof[];
}

export interface LoopTargetEquivalentCloseResult {
  archivedAt: string;
  cleanup: FinalizationCleanupResult;
  outcome: "target-equivalent";
  runId: string;
  worktrees: LoopCloseEquivalentWorktreeProof[];
}

const worktreeEquivalenceSchema = (): Record<string, unknown> | null => {
  const overridePath =
    process.env.NODE_ENV === "test"
      ? process.env.SIMPLE_CHANGES_TEST_WORKTREE_EQUIVALENCE_SCHEMA
      : undefined;
  const path =
    overridePath ??
    resolve(closeEquivalentSchemaDirectory, "worktree-equivalence.schema.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const isEquivalenceReceiptShape = (
  value: unknown
): value is WorktreeEquivalenceReceipt => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.targetRef === "string" &&
    typeof record.targetRevision === "string" &&
    typeof record.mergeBase === "string" &&
    typeof record.head === "string" &&
    Array.isArray(record.commits) &&
    Array.isArray(record.paths) &&
    typeof record.disclaimer === "string" &&
    (record.equivalence === "contained" ||
      record.equivalence === "partial" ||
      record.equivalence === "divergent")
  );
};

const equivalenceReceiptProof = (
  schema: Record<string, unknown> | null,
  rawReceipt: unknown,
  current: WorktreeInventory,
  primaryCheckout: string,
  targetRevision: string
): { failure: string } | { proof: LoopCloseEquivalentWorktreeProof } => {
  if (!schema) {
    return {
      failure:
        "an equivalence receipt was provided, but the worktree-equivalence schema is not installed, so the receipt cannot be used as evidence; only strict target containment applies",
    };
  }
  let validated: unknown;
  try {
    validated = validateSchemaDocument<unknown>(
      "worktree-equivalence",
      schema,
      rawReceipt
    );
  } catch (error) {
    return {
      failure: `the provided equivalence receipt is not a valid worktree-equivalence result (${error instanceof Error ? error.message : "unreadable receipt"})`,
    };
  }
  if (!isEquivalenceReceiptShape(validated)) {
    return {
      failure:
        "the provided equivalence receipt does not have the expected worktree-equivalence shape",
    };
  }
  if (validated.equivalence !== "contained") {
    return {
      failure: `the equivalence receipt reports "${validated.equivalence}", not "contained"`,
    };
  }
  if (!current.headSha || validated.head !== current.headSha) {
    return {
      failure: `the equivalence receipt is stale: it recorded head ${validated.head}, but the worktree is now at ${current.headSha ?? "(unknown)"}`,
    };
  }
  if (
    !targetContainsRevision(
      primaryCheckout,
      targetRevision,
      validated.targetRevision
    )
  ) {
    return {
      failure: `the equivalence receipt is stale: its recorded target revision ${validated.targetRevision} is not contained in the refreshed target`,
    };
  }
  return {
    proof: {
      headSha: current.headSha,
      method: "equivalence-receipt",
      path: current.path,
      receiptDigest: sha256Json(rawReceipt),
    },
  };
};

const closeEquivalentObligatedPaths = (
  lease: LoopLease,
  currentByPath: Map<string, WorktreeInventory>
): string[] => {
  const obligated = new Set<string>();
  for (const registered of lease.worktrees) {
    const eligible =
      registered.role === "controller" ||
      registered.role === "author" ||
      registered.createdByRun;
    if (eligible && currentByPath.has(registered.path)) {
      obligated.add(registered.path);
    }
  }
  for (const preparation of lease.preparations) {
    const path = existsSync(preparation.path)
      ? realpathSync(preparation.path)
      : preparation.path;
    if (currentByPath.has(path)) {
      obligated.add(path);
    }
  }
  return [...obligated].sort((left, right) => left.localeCompare(right));
};

const proveNothingLeftToShip = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string,
  equivalenceEvidence: readonly LoopEquivalenceEvidence[]
): LoopCloseEquivalentWorktreeProof[] => {
  const schema = worktreeEquivalenceSchema();
  const receiptsByPath = new Map<string, unknown>();
  for (const item of equivalenceEvidence) {
    const path = existsSync(item.worktreePath)
      ? realpathSync(item.worktreePath)
      : resolve(item.worktreePath);
    receiptsByPath.set(path, item.receipt);
  }
  const currentByPath = new Map(
    inventory.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const proofs: LoopCloseEquivalentWorktreeProof[] = [];
  const unproven: string[] = [];
  for (const path of closeEquivalentObligatedPaths(lease, currentByPath)) {
    const current = currentByPath.get(path);
    if (!current) {
      continue;
    }
    if (
      current.changes.length === 0 &&
      current.headSha &&
      targetContainsRevision(
        lease.primaryCheckout,
        targetRevision,
        current.headSha
      )
    ) {
      proofs.push({
        headSha: current.headSha,
        method: "target-ancestry",
        path,
      });
      continue;
    }
    const rawReceipt = receiptsByPath.get(path);
    if (rawReceipt !== undefined) {
      const assessed = equivalenceReceiptProof(
        schema,
        rawReceipt,
        current,
        lease.primaryCheckout,
        targetRevision
      );
      if ("proof" in assessed) {
        proofs.push(assessed.proof);
        continue;
      }
      unproven.push(`${path}: ${assessed.failure}`);
      continue;
    }
    unproven.push(
      current.changes.length > 0
        ? `${path}: the worktree has uncommitted changes and no equivalence receipt was provided`
        : `${path}: HEAD ${current.headSha ?? "(unknown)"} has commits that are not contained in the refreshed target and no equivalence receipt was provided`
    );
  }
  if (unproven.length > 0) {
    throw new SimpleChangesError(
      `Cannot close ${lease.runId} as target-equivalent; nothing-to-ship is unproven for: ${unproven.join("; ")}. Nothing was changed. Next: resume the loop to ship or preserve the remaining work, or provide a current worktree-equivalence receipt whose equivalence is "contained" for each listed path and run \`simple-changes loop close-equivalent\` again.`,
      EXIT_CODES.unsafe
    );
  }
  return proofs.sort((left, right) => left.path.localeCompare(right.path));
};

const priorTargetEquivalentClose = (
  commonGitDirectory: string,
  runId: string,
  archivePath: string
): LoopTargetEquivalentCloseResult | null => {
  if (
    existsSync(loopLeasePath(commonGitDirectory)) ||
    !existsSync(archivePath)
  ) {
    return null;
  }
  const prior =
    readImmutableRecoveryEvent<LoopCloseEquivalentRecord>(archivePath);
  if (prior.runId !== runId || prior.kind !== "loop-close-equivalent") {
    throw new SimpleChangesError(
      "A different terminal closure record already exists for this run.",
      EXIT_CODES.unsafe
    );
  }
  return {
    archivedAt: prior.archivedAt,
    cleanup: emptyFinalizationCleanup(),
    outcome: "target-equivalent",
    runId,
    worktrees: prior.worktrees,
  };
};

/**
 * Close a loop whose work is already contained in the target, so there is
 * nothing left to ship. This is the recovery path out of the frozen-scope
 * dead end: it works on a relinquished lease without a takeover ceremony,
 * requires explicit user approval and a reason, performs only the local
 * proven-safe cleanup ordinary finalization performs, and records a terminal
 * `target-equivalent` outcome that is never reportable as a shipped delivery.
 */
export const closeLoopTargetEquivalent = (
  repositoryPath: string,
  runIdInput: string,
  agentIdInput: string,
  approvedByInput: string,
  reasonInput: string,
  equivalenceEvidence: readonly LoopEquivalenceEvidence[] = []
): LoopTargetEquivalentCloseResult => {
  const runId = requiredRunId(runIdInput);
  const agentId = requiredText(agentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approver");
  const reason = requiredText(reasonInput, "close-equivalent reason");
  const opening = captureInventory(repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withStateLock(commonGitDirectory, "loop close-equivalent", () =>
    withWorktreeCoordinationLock(
      commonGitDirectory,
      "loop close-equivalent cleanup",
      () => {
        const archivePath = resolve(
          recoveryHistoryDirectory(commonGitDirectory, runId),
          "close-equivalent.json"
        );
        const prior = priorTargetEquivalentClose(
          commonGitDirectory,
          runId,
          archivePath
        );
        if (prior) {
          return prior;
        }
        const inventory = captureInventory(repositoryPath);
        let lease = requireLease(inventory);
        assertMatchingRun(lease, runId);
        const lifecycle = controllerLifecycle(lease);
        if (lifecycle.status === "active" && lease.ownerAgentId !== agentId) {
          throw new SimpleChangesError(
            `Only current controller ${lease.ownerAgentId} may close active loop ${lease.runId} as target-equivalent. A relinquished loop may be closed by another agent with explicit user approval.`,
            EXIT_CODES.unsafe
          );
        }
        const targetRevision = currentTargetRevision(lease);
        const proofs = proveNothingLeftToShip(
          lease,
          inventory,
          targetRevision,
          equivalenceEvidence
        );
        const recordedAt = new Date().toISOString();
        const remoteReconciliationSkipped =
          "Remote reconciliation was not required for this closure: no provider mutation, push, or remote branch change occurred.";
        const outcomeRecord: LoopCloseEquivalentOutcome = {
          approvedBy,
          outcome: "target-equivalent",
          reason,
          recordedAt,
          remoteReconciliationSkipped,
          targetRevision,
          worktrees: proofs,
        };
        lease = writeLease({
          ...lease,
          closeEquivalentOutcome: outcomeRecord,
          updatedAt: recordedAt,
        });
        const verification = verificationAgainst(lease, inventory);
        const automaticCleanup = automaticFinalizationCleanup(
          lease,
          inventory,
          verification
        );
        ({ lease } = automaticCleanup);
        const record: LoopCloseEquivalentRecord = {
          approvedBy,
          archivedAt: recordedAt,
          authority: "close-equivalent",
          kind: "loop-close-equivalent",
          leaseDigest: loopManifestDigest(lease),
          outcome: "target-equivalent",
          reason,
          remoteReconciliationSkipped,
          runId,
          schemaVersion: 1,
          targetRef: lease.targetRef,
          targetRevision,
          worktrees: proofs,
        };
        validateSchemaDocument<LoopCloseEquivalentRecord>(
          "loop-close-equivalent",
          closeEquivalentRecordSchema,
          record
        );
        writeImmutableRecoveryEvent(archivePath, record);
        rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
        return {
          archivedAt: recordedAt,
          cleanup: automaticCleanup.cleanup,
          outcome: "target-equivalent",
          runId,
          worktrees: proofs,
        };
      }
    )
  );
};

export const endLoop = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string
): LoopVerification => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const opening = captureInventory(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop end",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      if (lease.ownerAgentId !== ownerAgentId) {
        throw new SimpleChangesError(
          `Only loop owner ${lease.ownerAgentId} may end this loop.`,
          EXIT_CODES.unsafe
        );
      }
      assertControllerActive(lease);
      const verification = verificationAgainst(lease, inventory);
      const blockers = loopCompletionBlockers(lease, inventory, verification);
      if (blockers.length > 0) {
        throw new SimpleChangesError(blockers.join(" "), EXIT_CODES.unsafe);
      }
      rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
      return verification;
    }
  );
};

export const loopStatus = (
  repositoryPath: string
): { lease: LoopLease | null; verification: LoopVerification } => {
  const inventory = captureInventory(repositoryPath);
  const storedLease = readLeaseFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  let lease = storedLease;
  if (storedLease && controllerLifecycle(storedLease).status === "active") {
    lease = withConcurrentAuthorAdmissions(storedLease, inventory);
  }
  return {
    lease,
    verification: lease
      ? verificationAgainst(lease, inventory)
      : {
          active: false,
          checkedAt: new Date().toISOString(),
          currentBaselineDigest: inventory.baselineDigest,
          ok: true,
          runId: null,
          violations: [],
        },
  };
};

export const loopManifestDigest = (lease: LoopLease): string =>
  sha256(JSON.stringify(lease));
