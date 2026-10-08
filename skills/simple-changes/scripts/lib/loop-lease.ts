import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
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
  deleteTargetContainedBranches,
  PATCH_EQUIVALENCE_MAX_COMMITS,
  type TargetContainmentMethod,
  targetContainmentAudit,
  targetContainsRevision,
} from "./cleanup-core.ts";
import {
  decideEmergencyShipping,
  deriveEmergencyShippingStatus,
} from "./emergency-shipping.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { assertExecGuardAllows, execGuardFor } from "./exec-guard.ts";
import {
  currentHarnessSession,
  forgetControllerSession,
  recordControllerSession,
} from "./harness-session.ts";
import { sha256, sha256Json } from "./hash.ts";
import {
  captureInventory,
  compareSnapshots,
  locateRepository,
} from "./inventory.ts";
import {
  assertNoSymlinkAncestors,
  assertSafeRelativePath,
} from "./path-safety.ts";
import { buildPreviewPlan, validatePlanConservation } from "./planner.ts";
import {
  preservedSourceOverrideFailure,
  recordedPreservedSourceOverrides,
  splitShipmentOutcomeInput,
} from "./preserved-source-override.ts";
import { primaryDeliveryProof } from "./primary-delivery-proof.ts";
import {
  assertCommandSucceeded,
  type CommandProcess,
  type CommandResult,
  GuardedProcessGroupStillAliveError,
  runGit,
  runInProcessGroup,
} from "./process.ts";
import {
  remoteBranchReconciliationDigest,
  remoteInventoryDigest,
  splitRemoteBranchReconciliationInput,
  validateOpeningRemoteInventory,
  validatePostCleanupRecovery,
  validateRemoteBranchAncestryRecord,
  validateRemoteBranchReconciliation,
  validateRemoteBranchSupersessionRecord,
} from "./remote-branch-reconciliation.ts";
import { validateSchema, validateSchemaDocument } from "./schema.ts";
import type {
  ChangePlan,
  EmergencyShippingLedgerEntry,
  LoopCloseEquivalentWorktreeProof,
  LoopControllerBinding,
  LoopControllerLifecycle,
  LoopControllerSession,
  LoopLease,
  LoopOverride,
  LoopOwnerProcess,
  LoopRebaselineRecord,
  LoopRebaselineRegistration,
  LoopVerification,
  LoopViolation,
  LoopWorktreeDisposition,
  LoopWorktreeLease,
  LoopWorktreePreparation,
  LoopWorktreeRetirement,
  PostCleanupRecoveryReceipt,
  PreservedSourceOverrideReceipt,
  RemoteBranchAncestryProof,
  RemoteBranchAncestryRecord,
  RemoteBranchReconciliationReceipt,
  RemoteBranchSupersession,
  RemoteBranchSupersessionRecord,
  RepositoryInventory,
  RequestMode,
  ShipmentOutcomeReceipt,
  WorktreeClaim,
  WorktreeClaimReleaseReason,
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
  releaseAbsentWorktreeClaimsUnderLock,
  releaseClaimUnderLock,
  releaseRecordedState,
  retireAbsentWorktreeClaimsUnderLock,
  withWorktreeCoordinationLock,
  worktreeClaimDocumentDigest,
} from "./worktree-coordination.ts";

const STATE_DIRECTORY = "simple-changes";
const STATE_FILENAME = "active-loop.json";
const LOCK_DIRECTORY = "active-loop.lock";
const LOCK_OWNER_FILENAME = "owner.json";
const RECOVERY_HISTORY_DIRECTORY = "history";
const REMOTE_BRANCH_ANCESTRY_DIRECTORY = "remote-branch-ancestry";
const REMOTE_BRANCH_SUPERSESSION_DIRECTORY = "remote-branch-supersession";
const PRESERVED_SOURCE_OVERRIDE_DIRECTORY = "preserved-source-override";
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

// Standalone maintenance shares this short lock without acquiring a controller
// lease, so its inventory cannot race a registration or integration mutation.
export { withStateLock as withLoopStateLock };

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

export const readLeaseFromCommonDirectory = (
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

const CONTROLLER_BINDING_FILENAME = "active-loop-controller.json";

const controllerBindingPath = (commonGitDirectory: string): string =>
  resolve(stateDirectory(commonGitDirectory), CONTROLLER_BINDING_FILENAME);

const isControllerSession = (
  value: unknown
): value is LoopControllerSession => {
  const session = value as Partial<LoopControllerSession> | null;
  return Boolean(
    session &&
      (session.harness === "claude-code" || session.harness === "codex") &&
      typeof session.sessionId === "string" &&
      typeof session.hostname === "string" &&
      (session.hostPid === null || Number.isSafeInteger(session.hostPid))
  );
};

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;

/**
 * The controller binding for this exact run and owner, or null. It is advisory
 * evidence kept beside the lease: a missing, unreadable, or mismatched file
 * means no session binding and no recorded questions, never an error.
 */
export const readControllerBinding = (
  lease: Pick<
    LoopLease,
    "commonGitDirectory" | "controller" | "createdAt" | "ownerAgentId" | "runId"
  >
): LoopControllerBinding | null => {
  try {
    const parsed = JSON.parse(
      readFileSync(controllerBindingPath(lease.commonGitDirectory), "utf8")
    ) as Partial<LoopControllerBinding>;
    // Matching the controller's acquisition time ties the binding to this
    // exact controller tenure, so a resume or takeover by a runtime that does
    // not write bindings leaves the old one behind as inert.
    if (
      parsed.schemaVersion !== 1 ||
      parsed.runId !== lease.runId ||
      parsed.ownerAgentId !== lease.ownerAgentId ||
      parsed.controllerAcquiredAt !==
        (lease.controller?.acquiredAt ?? lease.createdAt)
    ) {
      return null;
    }
    const questions = stringList(parsed.awaitingUser?.questions);
    return {
      awaitingUser:
        questions && typeof parsed.awaitingUser?.recordedAt === "string"
          ? { questions, recordedAt: parsed.awaitingUser.recordedAt }
          : null,
      controllerAcquiredAt: parsed.controllerAcquiredAt,
      inheritedAwaitingUser: stringList(parsed.inheritedAwaitingUser),
      ownerAgentId: parsed.ownerAgentId,
      runId: parsed.runId,
      schemaVersion: 1,
      session: isControllerSession(parsed.session) ? parsed.session : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
};

// Best effort: the binding never gates a loop operation, so a write failure
// leaves the run without a session binding rather than failing the command.
const writeControllerBinding = (
  lease: LoopLease,
  changes: Partial<
    Pick<
      LoopControllerBinding,
      "awaitingUser" | "inheritedAwaitingUser" | "session"
    >
  >
): void => {
  const current = readControllerBinding(lease);
  const binding: LoopControllerBinding = {
    awaitingUser: current?.awaitingUser ?? null,
    controllerAcquiredAt: controllerLifecycle(lease).acquiredAt,
    inheritedAwaitingUser: current?.inheritedAwaitingUser ?? null,
    ownerAgentId: lease.ownerAgentId,
    runId: lease.runId,
    schemaVersion: 1,
    session: current?.session ?? null,
    updatedAt: new Date().toISOString(),
    ...changes,
  };
  try {
    const path = controllerBindingPath(lease.commonGitDirectory);
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch {
    // The run continues without a binding; turn-end hooks find nothing.
  }
  if (binding.session) {
    recordControllerSession(
      binding.session,
      lease.commonGitDirectory,
      lease.runId
    );
  }
};

const removeControllerBinding = (lease: LoopLease): void => {
  rmSync(controllerBindingPath(lease.commonGitDirectory), { force: true });
};

/**
 * Bind the run to the harness session issuing an owner command, so a restarted
 * harness process or a resumed session keeps a current binding. Only commands
 * that already proved ownership call this.
 */
const refreshControllerSession = (lease: LoopLease): void => {
  const session = currentHarnessSession();
  if (!session) {
    return;
  }
  const current = readControllerBinding(lease)?.session;
  if (
    current?.sessionId === session.sessionId &&
    current.hostPid === session.hostPid &&
    current.hostname === session.hostname
  ) {
    return;
  }
  if (current && current.sessionId !== session.sessionId) {
    forgetControllerSession(current.sessionId, lease.runId);
  }
  writeControllerBinding(lease, { session });
};

// The session index is only a pointer for turn-end hooks; drop it whenever
// this session stops controlling the run.
const forgetLeaseSession = (lease: LoopLease): void => {
  const session = readControllerBinding(lease)?.session;
  if (session) {
    forgetControllerSession(session.sessionId, lease.runId);
  }
};

/**
 * The step every controller owes before it replies to the user. Commands that
 * touch shared state repeat it, because an agent reads command output far more
 * reliably than a rule it read once in the skill.
 */
export const turnEndReminder = (lease: LoopLease): string =>
  `Before you reply to the user, run \`simple-changes loop finalize --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason "<why>" --json\` (add \`--awaiting-user "<question>"\` when you are about to ask them to decide something), then \`simple-changes loop status --json\` to confirm the controller is released or paused.`;

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

// Durable evidence that the run began changing shared state or recording run
// evidence. It is set once, in the same write as the first such change, and is
// never cleared or replaced, so `loop end` can tell an untouched run apart.
const withMutationEvidence = (lease: LoopLease, at: string): LoopLease => ({
  ...lease,
  firstMutationAt: lease.firstMutationAt ?? at,
});

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
  const session = currentHarnessSession();
  const previousBinding = readControllerBinding(lease);
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
  forgetLeaseSession(lease);
  const transferred = writeLease({
    ...withMutationEvidence(lease, now),
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
  writeControllerBinding(transferred, {
    awaitingUser: null,
    inheritedAwaitingUser: previousBinding?.awaitingUser?.questions ?? null,
    session,
  });
  return transferred;
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

/**
 * How long a lease may go without a heartbeat before an unprovable owner makes
 * it stale. Exported so callers and tests reference one definition instead of
 * re-deriving a timeout. Agent harnesses run each loop command as a short-lived
 * process, so the recorded command process is almost never provable; two
 * hours covers long checks and reviews without leaving an abandoned run
 * looking live for half a working day.
 */
export const LEASE_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * How long a run whose recorded harness session process has exited may stay
 * live, so a restarted harness can refresh its binding with its next command.
 */
export const SESSION_EXIT_GRACE_MS = 10 * 60 * 1000;

// When this process runs inside a harness that exports its own PID but cannot
// see it, it sits in a separate process namespace where liveness checks of
// recorded harness PIDs are meaningless.
const harnessProcessesVisible = (): boolean => {
  const own = Number.parseInt(process.env.CLAUDE_PID ?? "", 10);
  return !(Number.isSafeInteger(own) && own > 0) || processIsAlive(own);
};

export interface LeaseLiveness {
  ageMs: number | null;
  lastUpdatedAt: string;
  ownerProcessProvable: boolean;
  /**
   * The harness session that acquired the controller recorded its own process,
   * and that process has exited on this host: the owner is provably gone.
   */
  ownerSessionEnded: boolean;
  state: "live" | "stale" | "unknown";
}

const ownerProcessEvidence = (recordedAt: string): LoopOwnerProcess => ({
  hostname: hostname(),
  pid: process.pid,
  recordedAt,
});

/**
 * Decide whether a lease still has a living owner. A lease is `stale` when its
 * owner cannot be proven alive (no recorded process, a process recorded on
 * another host, or a recorded PID that is gone) and either its last heartbeat
 * is older than the threshold, or the harness session process bound to the
 * controller has exited on this host and the heartbeat is older than the
 * short grace period. A lease whose `updatedAt` cannot be parsed is `unknown`,
 * never stale: unreadable evidence is not proof of death.
 */
export const leaseLiveness = (
  lease: LoopLease,
  now: number = Date.now(),
  staleAfterMs: number = LEASE_STALE_AFTER_MS
): LeaseLiveness => {
  const ownerProcessProvable = Boolean(
    lease.ownerProcess &&
      lease.ownerProcess.hostname === hostname() &&
      processIsAlive(lease.ownerProcess.pid)
  );
  const updatedAt = Date.parse(lease.updatedAt);
  const ageMs = Number.isFinite(updatedAt)
    ? Math.max(0, now - updatedAt)
    : null;
  const session = readControllerBinding(lease)?.session;
  // A restarted harness refreshes the binding on its next owner command, so a
  // dead session process counts only after a short quiet period, and only when
  // this process can see its own harness process: inside a sandbox with its
  // own process namespace, an invisible PID proves nothing.
  const ownerSessionEnded = Boolean(
    !ownerProcessProvable &&
      ageMs !== null &&
      ageMs > SESSION_EXIT_GRACE_MS &&
      session?.hostPid &&
      session.hostname === hostname() &&
      harnessProcessesVisible() &&
      !processIsAlive(session.hostPid)
  );
  const evidence = {
    ageMs,
    lastUpdatedAt: lease.updatedAt,
    ownerProcessProvable,
    ownerSessionEnded,
  };
  if (ownerProcessProvable) {
    return { ...evidence, state: "live" };
  }
  if (ownerSessionEnded) {
    return { ...evidence, state: "stale" };
  }
  if (ageMs === null) {
    return { ...evidence, state: "unknown" };
  }
  return { ...evidence, state: ageMs > staleAfterMs ? "stale" : "live" };
};

export interface LoopLockRecovery {
  coordinationRecovered: boolean;
  recovered: boolean;
  recoveredAt: string;
  staleOwner: LoopLockOwner;
}

const staleLeaseRecoveryCommand = (lease: LoopLease): string =>
  `simple-changes loop recover --stale-lease --run-id ${lease.runId} --agent-id <you> --approved-by <user> --reason <why>`;

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

const retirementForRegistration = (
  lease: LoopLease,
  registered: LoopWorktreeLease
): LoopWorktreeRetirement | undefined =>
  (lease.retirements ?? []).find(
    (retirement) =>
      retirement.path === registered.path &&
      retirement.baselineChangeDigest === registered.baselineChangeDigest &&
      retirement.baselineHeadSha === registered.baselineHeadSha
  );

// Nothing at all may sit at the path: a dangling symlink is not absence.
const nothingAtPath = (path: string): boolean => {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
};

// Canonicalize through the nearest existing ancestor so a deleted path is
// spelled the way the lease recorded it (for example /private/var on macOS).
const canonicalAbsentPath = (pathInput: string): string => {
  const absolute = resolve(pathInput);
  let ancestor = dirname(absolute);
  const trailing: string[] = [basename(absolute)];
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
    trailing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return existsSync(ancestor)
    ? join(realpathSync(ancestor), ...trailing)
    : absolute;
};

// Absent means nothing is at the path and Git either no longer lists the
// worktree or only lists it as prunable metadata.
const worktreeIsAbsent = (
  inventory: RepositoryInventory,
  path: string
): boolean => {
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === path
  );
  return nothingAtPath(path) && (!current || current.prunable);
};

const retiredAbsentPaths = (
  lease: LoopLease,
  inventory: RepositoryInventory
): Set<string> =>
  new Set(
    lease.worktrees
      .filter(
        (registered) =>
          registered.role === "preserved" &&
          retirementForRegistration(lease, registered) &&
          worktreeIsAbsent(inventory, registered.path)
      )
      .map((registered) => registered.path)
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

type ReceiptSidecarDirectory =
  | typeof PRESERVED_SOURCE_OVERRIDE_DIRECTORY
  | typeof REMOTE_BRANCH_ANCESTRY_DIRECTORY
  | typeof REMOTE_BRANCH_SUPERSESSION_DIRECTORY;

const receiptSidecarPath = (
  commonGitDirectory: string,
  directory: ReceiptSidecarDirectory,
  runId: string
): string =>
  assertNoSymlinkAncestors(
    commonGitDirectory,
    join(STATE_DIRECTORY, directory, `${requiredRunId(runId)}.json`)
  );

const readReceiptSidecar = (
  commonGitDirectory: string,
  directory: ReceiptSidecarDirectory,
  runId: string
): unknown => {
  const path = receiptSidecarPath(commonGitDirectory, directory, runId);
  if (!existsSync(path)) {
    return null;
  }
  return readImmutableRecoveryEvent<object>(path);
};

/**
 * Writes or removes one receipt sidecar atomically. Callers hold the state
 * lock; a null record removes a stale sidecar from an earlier receipt.
 */
const writeReceiptSidecar = (
  lease: LoopLease,
  directory: ReceiptSidecarDirectory,
  record: object | null
): void => {
  const path = receiptSidecarPath(
    lease.commonGitDirectory,
    directory,
    lease.runId
  );
  if (record === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
};

/**
 * Merged-head ancestry proofs live beside the lease, never inside it: older
 * clients strictly validate the lease, so the embedded receipt keeps the
 * original schema. The sidecar is replaced or removed under the state lock
 * whenever a receipt is recorded, and is kept afterward as audit evidence.
 */
const writeRemoteBranchAncestry = (
  lease: LoopLease,
  receipt: RemoteBranchReconciliationReceipt,
  proofs: RemoteBranchAncestryProof[]
): void =>
  writeReceiptSidecar(
    lease,
    REMOTE_BRANCH_ANCESTRY_DIRECTORY,
    proofs.length === 0
      ? null
      : validateSchema<RemoteBranchAncestryRecord>("remote-branch-ancestry", {
          proofs,
          receiptDigest: remoteBranchReconciliationDigest(receipt),
          runId: lease.runId,
          schemaVersion: 1,
        })
  );

/**
 * Supersession approvals follow the ancestry sidecar's rules: beside the
 * lease, bound to the exact receipt digest, replaced or removed whenever a
 * receipt is recorded, and kept afterward as audit evidence.
 */
const writeRemoteBranchSupersession = (
  lease: LoopLease,
  receipt: RemoteBranchReconciliationReceipt,
  supersessions: RemoteBranchSupersession[]
): void =>
  writeReceiptSidecar(
    lease,
    REMOTE_BRANCH_SUPERSESSION_DIRECTORY,
    supersessions.length === 0
      ? null
      : validateSchema<RemoteBranchSupersessionRecord>(
          "remote-branch-supersession",
          {
            receiptDigest: remoteBranchReconciliationDigest(receipt),
            runId: lease.runId,
            schemaVersion: 1,
            supersessions,
          }
        )
  );

/**
 * The receipt validator is pure, so an ancestry proof is only a claim until
 * git confirms the initial head is the merged head or its ancestor and the
 * target contains the merged head. A branch whose proposal was open at the
 * opening inventory and merged at that unchanged head needs no sidecar, but
 * git must still find the head in the target, so a squash merge or a merge
 * into another branch fails closed exactly as with a sidecar. Missing objects
 * fail closed.
 */
const assertRemoteBranchAncestry = (
  repositoryPath: string,
  receipt: RemoteBranchReconciliationReceipt,
  proofs: readonly RemoteBranchAncestryProof[]
): void => {
  const proven = new Set(proofs.map((proof) => proof.branch));
  for (const branch of receipt.branches) {
    const openedBeforeMerge =
      branch.disposition === "deleted-merged" &&
      branch.obsoleteProof === "merged-proposal-head" &&
      !proven.has(branch.name) &&
      branch.proposals.some(
        (proposal) =>
          proposal.state === "open" && proposal.observedFinally === false
      );
    if (
      openedBeforeMerge &&
      branch.initialHeadRevision &&
      !targetContainsRevision(
        repositoryPath,
        receipt.targetRevision,
        branch.initialHeadRevision
      )
    ) {
      throw new SimpleChangesError(
        `Merged deletion of ${branch.name} is not verified: its proposal was open at the opening inventory, and merged head ${branch.initialHeadRevision} is not contained in target ${receipt.targetRevision} (for example after a squash merge or a merge into another branch). Report the branch, head, and proposal to the user; this receipt cannot be recorded.`,
        EXIT_CODES.unsafe
      );
    }
  }
  for (const proof of proofs) {
    const reportable = `Report branch ${proof.branch}, initial head ${proof.initialHeadRevision}, and proposal ${proof.proposalObjectId} to the user; this receipt cannot be recorded.`;
    if (
      !targetContainsRevision(
        repositoryPath,
        proof.mergedHeadRevision,
        proof.initialHeadRevision
      )
    ) {
      throw new SimpleChangesError(
        `Merged-head ancestry proof for ${proof.branch} is not verified: initial head ${proof.initialHeadRevision} is not the merged head ${proof.mergedHeadRevision} or a local ancestor of it (rewritten, force-pushed, or GitLab-rebased history, or missing objects). ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
    if (
      !targetContainsRevision(
        repositoryPath,
        receipt.targetRevision,
        proof.mergedHeadRevision
      )
    ) {
      throw new SimpleChangesError(
        `Merged-head ancestry proof for ${proof.branch} is not verified: merged head ${proof.mergedHeadRevision} is not contained in target ${receipt.targetRevision} (for example after a squash merge). ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
  }
};

const SUPERSEDED_HEAD_REF_PREFIX = "refs/simple-changes/superseded/";

const supersededHeadRef = (runId: string, head: string): string =>
  `${SUPERSEDED_HEAD_REF_PREFIX}${requiredRunId(runId)}/${head}`;

/**
 * A supersession approval is a user's judgment, but its facts are Git's: the
 * deleted head must still exist locally (so the work stays auditable and
 * restorable) and lie outside the target (otherwise target-contains-head is
 * the proof to record), and every replacement must be in the target without
 * being an ancestor of the deleted head, so the shared fork point can never be
 * named as the replacement. That last check is negative, so a shallow clone,
 * whose boundary commits hide their parents, or a head with no history shared
 * with the target would pass it falsely; both fail closed. Missing objects fail
 * closed.
 *
 * Whether the approval is unnecessary is a tidiness check, not a safety one.
 * Where the receipt is recorded it uses the same containment audit as
 * target-contains-head, so the two can never disagree; at loop end it stays the
 * cheap exact-ancestry check older clients recorded against, so a run recorded
 * by 0.22.3 still ends.
 */
const assertRemoteBranchSupersession = (
  repositoryPath: string,
  receipt: RemoteBranchReconciliationReceipt,
  supersessions: readonly RemoteBranchSupersession[],
  check:
    | { phase: "record"; targetPatchIdCache: Map<string, Map<string, string>> }
    | { phase: "loop-end" }
): void => {
  if (
    supersessions.length > 0 &&
    runGit(
      repositoryPath,
      ["rev-parse", "--is-shallow-repository"],
      true
    ).stdout.trim() !== "false"
  ) {
    throw new SimpleChangesError(
      "Supersession cannot be verified in a shallow clone: Git cannot prove a replacement came after the branch forked when commit parents are missing. Run `git fetch --unshallow` (and fetch the deleted head at full depth), then record the final reconciliation again.",
      EXIT_CODES.unsafe
    );
  }
  for (const supersession of supersessions) {
    const head = supersession.initialHeadRevision;
    const reportable = `Report branch ${supersession.branch} and deleted head ${head} to the user; this receipt cannot be recorded.`;
    if (
      runGit(repositoryPath, ["cat-file", "-e", `${head}^{commit}`], true)
        .exitCode !== 0
    ) {
      throw new SimpleChangesError(
        `Supersession of ${supersession.branch} is not verified: deleted head ${head} is not present locally. Fetch it first at full depth (GitLab keeps a merge request's head at refs/merge-requests/<iid>/head after its branch is deleted). ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
    if (
      runGit(
        repositoryPath,
        [
          "merge-base",
          `${head}^{commit}`,
          `${receipt.targetRevision}^{commit}`,
        ],
        true
      ).exitCode !== 0
    ) {
      throw new SimpleChangesError(
        `Supersession of ${supersession.branch} is not verified: deleted head ${head} shares no history with target ${receipt.targetRevision}. ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
    const containment =
      check.phase === "record"
        ? targetContainmentAudit(
            repositoryPath,
            receipt.targetRevision,
            head,
            check.targetPatchIdCache
          ).method
        : targetContainsRevision(
            repositoryPath,
            receipt.targetRevision,
            head
          ) && "target-contained";
    if (containment) {
      throw new SimpleChangesError(
        `Supersession of ${supersession.branch} is unnecessary: target ${receipt.targetRevision} already contains deleted head ${head} (${containment}), so record target-contains-head proof instead.`,
        EXIT_CODES.validation
      );
    }
    for (const replacement of supersession.replacementRevisions) {
      if (
        !targetContainsRevision(
          repositoryPath,
          receipt.targetRevision,
          replacement
        )
      ) {
        throw new SimpleChangesError(
          `Supersession of ${supersession.branch} is not verified: replacement ${replacement} is not contained in target ${receipt.targetRevision} (or is missing locally). ${reportable}`,
          EXIT_CODES.unsafe
        );
      }
      if (targetContainsRevision(repositoryPath, head, replacement)) {
        throw new SimpleChangesError(
          `Supersession of ${supersession.branch} is not verified: replacement ${replacement} is already an ancestor of deleted head ${head}, so it cannot be the work that replaced it. ${reportable}`,
          EXIT_CODES.unsafe
        );
      }
    }
  }
};

/**
 * `target-contains-head` is the one audited deletion proof Git can check
 * locally: the deleted head must be present and the target must contain it by
 * exact ancestry or by full per-commit patch equivalence (`git patch-id
 * --stable`, which ignores whitespace, as `git cherry` does), the containment
 * proof every local cleanup path shares. Both are positive checks, so a shallow
 * clone fails closed; the refusal then names the shallow clone rather than
 * suggesting lost work. It is checked where the receipt is recorded and not
 * again at loop end: loop end already binds the receipt to the current target
 * revision, so re-running the audit there would only repeat this answer for
 * receipts recorded by this client, while receipts recorded by older clients
 * never had this check and could strand a run that already deleted the branch.
 * `provider-diff-empty` is provider evidence that Git cannot reproduce locally.
 */
const assertTargetContainsDeletedHeads = (
  repositoryPath: string,
  receipt: RemoteBranchReconciliationReceipt,
  targetPatchIdCache: Map<string, Map<string, string>>
): void => {
  const nextStep =
    "If the branch is already gone and the user judges its work shipped another way, record their supersession approval instead; otherwise report the branch and head to the user.";
  for (const branch of receipt.branches) {
    if (
      branch.disposition !== "deleted-proven-obsolete" ||
      branch.obsoleteProof !== "target-contains-head"
    ) {
      continue;
    }
    const head = branch.initialHeadRevision;
    const reportable = `Report branch ${branch.name} and deleted head ${head} to the user; this receipt cannot be recorded.`;
    if (
      !head ||
      runGit(repositoryPath, ["cat-file", "-e", `${head}^{commit}`], true)
        .exitCode !== 0
    ) {
      throw new SimpleChangesError(
        `target-contains-head proof for ${branch.name} is not verified: deleted head ${head} is not present locally. Fetch it first at full depth (GitLab keeps a merge request's head at refs/merge-requests/<iid>/head after its branch is deleted); if no clone or merge request still has it, stop and report the branch to the user. ${reportable}`,
        EXIT_CODES.unsafe
      );
    }
    const audit = targetContainmentAudit(
      repositoryPath,
      receipt.targetRevision,
      head,
      targetPatchIdCache
    );
    if (audit.method !== null) {
      continue;
    }
    if (
      runGit(
        repositoryPath,
        ["rev-parse", "--is-shallow-repository"],
        true
      ).stdout.trim() !== "false"
    ) {
      throw new SimpleChangesError(
        `target-contains-head proof for ${branch.name} cannot be verified in a shallow clone: missing history hides whether target ${receipt.targetRevision} contains deleted head ${head}. Run \`git fetch --unshallow\`, then record the final reconciliation again.`,
        EXIT_CODES.unsafe
      );
    }
    throw new SimpleChangesError(
      audit.exceededMaxCommits
        ? `target-contains-head proof for ${branch.name} is not verified: deleted head ${head} is not in target ${receipt.targetRevision} and has more than ${PATCH_EQUIVALENCE_MAX_COMMITS} unique commits, too many to prove by patch equivalence. ${nextStep} ${reportable}`
        : `target-contains-head proof for ${branch.name} is not verified: target ${receipt.targetRevision} neither contains deleted head ${head} nor has a patch-equivalent commit for each of its unique commits (merge and empty commits never match). ${nextStep} ${reportable}`,
      EXIT_CODES.unsafe
    );
  }
};

/**
 * A deleted head is otherwise an unreachable object that gc may remove, which
 * would leave the run unable to end and the work unrecoverable. Pin each
 * approved head under `refs/simple-changes/superseded/<runId>/<head>`; the pin
 * is kept afterward so the user can restore the branch from it.
 */
const pinSupersededHeads = (
  repositoryPath: string,
  runId: string,
  supersessions: readonly RemoteBranchSupersession[]
): void => {
  for (const { branch, initialHeadRevision } of supersessions) {
    const pinned = runGit(
      repositoryPath,
      [
        "update-ref",
        "-m",
        `simple-changes: pin superseded ${branch}`,
        supersededHeadRef(runId, initialHeadRevision),
        initialHeadRevision,
      ],
      true
    );
    if (pinned.exitCode !== 0) {
      throw new SimpleChangesError(
        `Could not pin superseded head ${initialHeadRevision} of ${branch}: ${pinned.stderr.trim()}`,
        EXIT_CODES.unsafe
      );
    }
  }
};

const isSupersededShape = (
  branch: RemoteBranchReconciliationReceipt["branches"][number]
): boolean =>
  branch.disposition === "deleted-proven-obsolete" &&
  branch.obsoleteProof === null;

/** A deleted-merged branch the exact merged-proposal-head rule cannot prove. */
const needsAncestryShape = (
  branch: RemoteBranchReconciliationReceipt["branches"][number]
): boolean =>
  branch.disposition === "deleted-merged" &&
  // Judged from the final snapshot, as merged deletion itself is.
  (branch.proposals.some(
    (proposal) =>
      proposal.state === "open" && proposal.observedFinally !== false
  ) ||
    !branch.proposals.some(
      (proposal) =>
        proposal.state === "merged" &&
        proposal.observedFinally !== false &&
        proposal.headRevision === branch.initialHeadRevision
    ));

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
  const storedAncestry = readReceiptSidecar(
    lease.commonGitDirectory,
    REMOTE_BRANCH_ANCESTRY_DIRECTORY,
    lease.runId
  );
  const ancestryProofs =
    storedAncestry === null
      ? []
      : validateRemoteBranchAncestryRecord(
          storedAncestry,
          lease.runId,
          receipt
        );
  const storedSupersession = readReceiptSidecar(
    lease.commonGitDirectory,
    REMOTE_BRANCH_SUPERSESSION_DIRECTORY,
    lease.runId
  );
  const supersessions =
    storedSupersession === null
      ? []
      : validateRemoteBranchSupersessionRecord(
          storedSupersession,
          lease.runId,
          receipt
        );
  try {
    validateRemoteBranchReconciliation(receipt, ancestryProofs, supersessions);
  } catch (error) {
    const missing = [
      storedAncestry === null && receipt.branches.some(needsAncestryShape)
        ? "merged-head ancestry proof"
        : null,
      storedSupersession === null && receipt.branches.some(isSupersededShape)
        ? "supersession approval"
        : null,
    ].filter((kind) => kind !== null);
    if (missing.length > 0 && error instanceof SimpleChangesError) {
      throw SimpleChangesError.withCause(
        `${error.message} No ${missing.join(" or ")} sidecar exists for ${lease.runId}; if one was recorded it is missing, so record the final reconciliation again.`,
        error.exitCode,
        error
      );
    }
    throw error;
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
  assertRemoteBranchAncestry(lease.primaryCheckout, receipt, ancestryProofs);
  assertRemoteBranchSupersession(
    lease.primaryCheckout,
    receipt,
    supersessions,
    {
      phase: "loop-end",
    }
  );
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

const resolvePrimaryAndTargetBranches = (
  lease: LoopLease,
  inventory: RepositoryInventory
): { primaryBranch: string | null; targetBranch: string | null } => ({
  primaryBranch:
    inventory.worktrees.find(
      (worktree) => worktree.path === lease.primaryCheckout
    )?.branch ?? null,
  targetBranch: targetBranchForRef(lease.primaryCheckout, lease.targetRef),
});

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
  const { primaryBranch, targetBranch } = resolvePrimaryAndTargetBranches(
    lease,
    inventory
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

// An author's own finished release, through `initialize --mode handoff`, a
// ready-work receipt, or a plain `worktree release`, makes its checkout
// ordinary stable work. Each records the exact state it released, so the
// release admits only that state, only when the release itself recorded it
// from the present checkout, and only while no newer live claim holds the
// checkout. Any other release goes through pause and accept. Callers find
// the claim by the registration's own claim ID.
const COMPLETED_RELEASE_REASONS: ReadonlySet<WorktreeClaimReleaseReason> =
  new Set(["handoff", "owner-release"]);

const completedReleaseMatches = (
  registered: LoopWorktreeLease,
  claim: WorktreeClaim | undefined,
  worktree: WorktreeInventory,
  { liveClaim, releaseRecorded }: ReleaseContext
): boolean =>
  claim?.state === "released" &&
  claim.releaseReason !== undefined &&
  COMPLETED_RELEASE_REASONS.has(claim.releaseReason) &&
  releaseRecorded &&
  claim.owner.agentId === registered.agentId &&
  claim.path === worktree.path &&
  claim.branch === worktree.branch &&
  claim.headSha === worktree.headSha &&
  claim.changeDigest === worktree.changeDigest &&
  liveClaim === undefined;

interface ReleaseContext {
  /** The unreleased claim that holds the checkout now, if any. */
  liveClaim: WorktreeClaim | undefined;
  /** The linked claim's release recorded the state from the present checkout. */
  releaseRecorded: boolean;
}

/** The claim that holds a checkout now: the one it has not released. */
const liveClaimFor = (
  document: WorktreeCoordinationDocument,
  commonGitDirectory: string,
  path: string
): WorktreeClaim | undefined =>
  document.claims.find(
    (claim) =>
      claim.commonGitDirectory === commonGitDirectory &&
      claim.path === path &&
      claim.state !== "released"
  );

interface WorktreeClaimContext extends ReleaseContext {
  /** The active claim that admits a concurrent author on this checkout. */
  concurrentClaim: WorktreeClaim | undefined;
  /** The claim the registration names, in any state. */
  linkedClaim: WorktreeClaim | undefined;
}

const SAFE_COMMAND_WORD_PATTERN = /^[A-Za-z0-9._:/@%+=,-]+$/u;

// Quote a value only when a POSIX shell would split or expand it.
const commandWord = (value: string): string =>
  SAFE_COMMAND_WORD_PATTERN.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;

interface StaleClaimRecovery {
  commands: string[];
  text: string;
}

const ACCEPT_PAUSED_CHANGE = "simple-changes loop accept-paused-change";
const LOOP_VERIFY = "simple-changes loop verify";

/**
 * Every stale link's recovery commands, ordered to run as printed: owners
 * claim and pause every checkout before the controller accepts any receipt,
 * because an acceptance refuses while a changed sibling still lacks its own
 * current receipt, and verification runs once at the end. Each acceptance is
 * bound to its path by the receipt it names.
 */
export const staleClaimRecoveryCommands = (
  violations: readonly LoopViolation[]
): string[] => {
  const ownerSteps: string[] = [];
  const accepts: string[] = [];
  const verifies = new Set<string>();
  for (const command of violations.flatMap(
    (violation) => violation.nextCommands ?? []
  )) {
    if (command.startsWith(`${ACCEPT_PAUSED_CHANGE} `)) {
      accepts.push(command);
    } else if (command.startsWith(`${LOOP_VERIFY} `)) {
      verifies.add(command);
    } else {
      ownerSteps.push(command);
    }
  }
  return [...ownerSteps, ...accepts, ...verifies];
};

/**
 * The exact recovery for one stale coordination link. `worktree claim`
 * refreshes a live claim in place under its existing ID, which restores a
 * concurrent author whose own registered claim only went inactive or recorded
 * another branch, as long as the checkout is still on its registered branch:
 * the lease pins the author there. A released claim is never refreshed (a new
 * claim gets a new ID). In every other case the live claim's owner, or the
 * registered owner when nothing holds the checkout, claims and pauses its exact
 * current state, and the controller accepts that pause receipt, which works
 * from any state.
 */
const staleClaimRecovery = (
  lease: Pick<LoopLease, "ownerAgentId" | "runId">,
  registered: LoopWorktreeLease,
  worktree: WorktreeInventory,
  { linkedClaim, liveClaim }: WorktreeClaimContext
): StaleClaimRecovery => {
  const owner = liveClaim?.owner ?? linkedClaim?.owner;
  const ownerId = owner?.agentId ?? registered.agentId;
  const agent = ownerId ? commandWord(ownerId) : "<owner>";
  const path = commandWord(worktree.path);
  const claim = [
    `simple-changes worktree claim --agent-id ${agent} --worktree ${path}`,
    `--adapter ${owner ? commandWord(owner.adapter) : "<adapter>"}`,
    ...(owner?.ownerRef ? [`--owner-ref ${commandWord(owner.ownerRef)}`] : []),
  ].join(" ");
  if (
    registered.role === "concurrent-author" &&
    registered.branch === worktree.branch &&
    liveClaim !== undefined &&
    liveClaim.claimId === registered.claimId &&
    liveClaim.owner.agentId === registered.agentId
  ) {
    const verify = `${LOOP_VERIFY} --run-id ${lease.runId}`;
    return {
      commands: [claim, verify],
      text: `Owner ${agent} refreshes claim ${liveClaim.claimId} in place with \`${claim}\`; then re-run \`${verify}\`.`,
    };
  }
  const controller = commandWord(lease.ownerAgentId);
  const pause = `simple-changes worktree pause --agent-id ${agent} --worktree ${path} --run-id ${lease.runId} --disposition preserve-in-place --reason <why>`;
  const accept = `${ACCEPT_PAUSED_CHANGE} --run-id ${lease.runId} --agent-id ${controller} --pause-receipt <pause-receipt-id>`;
  return {
    commands: [claim, pause, accept],
    text: `Owner ${agent} runs \`${claim}\`, then \`${pause}\`; controller ${controller} then runs \`${accept}\` with the receipt ID the pause prints.`,
  };
};

const staleConcurrentClaimCause = (
  registered: LoopWorktreeLease,
  { linkedClaim, liveClaim, releaseRecorded }: WorktreeClaimContext
): string => {
  const claimId = registered.claimId ?? "(none)";
  if (liveClaim && liveClaim.claimId !== registered.claimId) {
    return `This concurrent author worktree is now held by claim ${liveClaim.claimId} of ${liveClaim.owner.agentId}, not by its registered claim ${claimId}.`;
  }
  if (linkedClaim?.state === "released") {
    const reason = linkedClaim.releaseReason ?? "unrecorded";
    const never =
      "A released claim is never refreshed; a new claim gets a new ID.";
    if (
      !(
        linkedClaim.releaseReason &&
        COMPLETED_RELEASE_REASONS.has(linkedClaim.releaseReason)
      )
    ) {
      return `The registered claim ${claimId} of this concurrent author worktree was released (${reason}), which does not hand its work off. ${never}`;
    }
    return releaseRecorded
      ? `This concurrent author worktree no longer matches the exact state ${linkedClaim.owner.agentId} released under claim ${claimId} (${reason}). ${never}`
      : `The registered claim ${claimId} of this concurrent author worktree was released (${reason}) without recording the checkout's state at release, so no state is admitted. ${never}`;
  }
  if (linkedClaim) {
    return `The registered claim ${claimId} of this concurrent author worktree is ${linkedClaim.state} or records another branch.`;
  }
  return `The registered claim ${claimId} of this concurrent author worktree no longer exists.`;
};

const concurrentClaimViolations = (
  lease: Pick<LoopLease, "ownerAgentId" | "runId">,
  registered: LoopWorktreeLease,
  claims: WorktreeClaimContext,
  worktree: WorktreeInventory
): LoopViolation[] => {
  const { concurrentClaim, linkedClaim } = claims;
  if (
    registered.role !== "concurrent-author" ||
    completedReleaseMatches(registered, linkedClaim, worktree, claims) ||
    (concurrentClaim &&
      concurrentClaim.claimId === registered.claimId &&
      concurrentClaim.owner.agentId === registered.agentId)
  ) {
    return [];
  }
  const recovery = staleClaimRecovery(lease, registered, worktree, claims);
  return [
    {
      changeDigest: worktree.changeDigest,
      code: "coordination-claim-stale",
      headSha: worktree.headSha,
      message: `${staleConcurrentClaimCause(registered, claims)} ${recovery.text}`,
      nextCommands: recovery.commands,
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
  claims: WorktreeClaimContext
): LoopViolation[] => {
  if (!registered) {
    return unregisteredWorktreeViolations(
      lease,
      worktree,
      preparation,
      claims.concurrentClaim
    );
  }
  const violations = concurrentClaimViolations(
    lease,
    registered,
    claims,
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
    const recovery = staleClaimRecovery(lease, registered, worktree, claims);
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "coordination-claim-stale",
      headSha: worktree.headSha,
      message: `The adopted worktree claim or pause receipt no longer matches current coordination and Git evidence. ${recovery.text}`,
      nextCommands: recovery.commands,
      path: worktree.path,
    });
  }
  if (
    registered.role === "preserved" &&
    ((registered.claimId && !registered.pauseReceiptId) ||
      (!registered.claimId && registered.pauseReceiptId))
  ) {
    const recovery = staleClaimRecovery(lease, registered, worktree, claims);
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "coordination-claim-stale",
      headSha: worktree.headSha,
      message: `The worktree lease has an incomplete coordination linkage. ${recovery.text}`,
      nextCommands: recovery.commands,
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
  const { primaryBranch, targetBranch } = resolvePrimaryAndTargetBranches(
    lease,
    inventory
  );
  const retired = retiredAbsentPaths(lease, inventory);
  for (const worktree of inventory.worktrees) {
    if (retired.has(worktree.path)) {
      continue;
    }
    const concurrentClaim = concurrentClaimFor(
      lease,
      worktree,
      coordination,
      primaryBranch,
      targetBranch
    );
    const registered = registeredByPath.get(worktree.path);
    const linkedClaim = registered?.claimId
      ? coordination.claims.find(
          (claim) => claim.claimId === registered.claimId
        )
      : undefined;
    const liveClaim = liveClaimFor(
      coordination,
      lease.commonGitDirectory,
      worktree.path
    );
    violations.push(
      ...currentWorktreeViolations(
        lease,
        worktree,
        registered,
        preparationByPath.get(worktree.path),
        {
          concurrentClaim,
          linkedClaim,
          liveClaim,
          releaseRecorded:
            linkedClaim !== undefined &&
            releaseRecordedState(coordination, linkedClaim.claimId),
        }
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
      !removalDispositionForPath(lease, registered.path) &&
      !retired.has(registered.path)
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
    // Reported evidence of the whole current inventory. It is not a scope
    // gate: record-scope checks its own narrower invariants.
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

const requireOwnedLease = (
  repositoryPath: string,
  runId: string,
  ownerAgentId: string,
  action: string
): { inventory: RepositoryInventory; lease: LoopLease } => {
  const inventory = captureInventory(repositoryPath);
  const lease = requireLease(inventory);
  assertMatchingRun(lease, runId);
  if (lease.ownerAgentId !== ownerAgentId) {
    throw new SimpleChangesError(
      `Only loop owner ${lease.ownerAgentId} may ${action}.`,
      EXIT_CODES.unsafe
    );
  }
  return { inventory, lease };
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
  const inventory = locateRepository(repositoryPath);
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

const resolveExistingLoopStart = (
  existing: LoopLease | null,
  inventory: RepositoryInventory,
  agentId: string,
  mode: RequestMode
): LoopLease | null => {
  if (!existing) {
    return null;
  }
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
  if (leaseLiveness(existing).state === "stale") {
    throw new SimpleChangesError(
      `Integration-controller loop ${existing.runId} has no recent activity; this alone does not prove its agent has stopped. On existing user authority for stale bookkeeping recovery, run \`${staleLeaseRecoveryCommand(existing)}\`, then retry from fresh inventory.`,
      EXIT_CODES.unsafe
    );
  }
  throw new SimpleChangesError(
    `Integration-controller loop ${existing.runId} is already active for ${existing.ownerAgentId}. Independent agents may continue in distinct actively claimed worktrees; start no second push/MR/merge/cleanup controller.`,
    EXIT_CODES.unsafe
  );
};

// Repository facts a first shipment scope depends on besides worktree bytes:
// policy, discovered capabilities, remote bindings, and the target binding.
// None of them carries a timestamp, so an unchanged repository digests alike.
const scopeInvariantDigest = (inventory: RepositoryInventory): string =>
  sha256Json({
    capabilities: inventory.capabilities,
    policy: inventory.policy,
    remoteBindings: inventory.repository.remoteBindings,
    targetRef: inventory.targetRef,
    targetRemote: inventory.repository.targetRemote,
  });

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
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop start",
    () =>
      withWorktreeCoordinationLock(
        opening.repository.commonGitDirectory,
        "loop start claim snapshot",
        () => {
          const inventory = captureInventory(repositoryPath);
          const existing = readLeaseFromCommonDirectory(
            inventory.repository.commonGitDirectory
          );
          const resumed = resolveExistingLoopStart(
            existing,
            inventory,
            agentId,
            mode
          );
          if (resumed) {
            refreshControllerSession(resumed);
            return resumed;
          }
          const now = new Date().toISOString();
          const session = currentHarnessSession();
          const currentPath = inventory.repository.currentCheckout;
          const concurrentWork =
            inventory.policy.value.concurrentWork === "strict"
              ? "strict"
              : "allow-claimed";
          const coordination = readCoordinationDocumentFromCommonDirectory(
            inventory.repository.commonGitDirectory
          );
          const primaryBranch =
            inventory.worktrees.find((worktree) => worktree.isPrimary)
              ?.branch ?? null;
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
            firstMutationAt: null,
            mode: mode as LoopLease["mode"],
            openingBranches: inventory.branches.map(({ name, sha }) => ({
              name,
              sha,
            })),
            openingInvariantDigest: scopeInvariantDigest(inventory),
            ...(openingRemoteInventory ? { openingRemoteInventory } : {}),
            openingWorktrees: inventory.worktrees.map(
              ({ branch, changeDigest, headSha, path }) => ({
                branch,
                changeDigest,
                headSha,
                path,
              })
            ),
            overrides: [],
            ownerAgentId: agentId,
            preparations: [],
            primaryCheckout: inventory.repository.primaryCheckout,
            remoteBindings: inventory.repository.remoteBindings,
            runId: `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
            schemaVersion: 1,
            shipmentScopeFrozenAt: null,
            shipmentScopeRequired: mode === "ship",
            targetRef: inventory.targetRef,
            targetRevision,
            updatedAt: now,
            worktrees,
          };
          if (mode === "ship" && inventory.localChanges.length === 0) {
            // Capture the clean opening baseline while both locks are held.
            // Committed and generated delivery remains explicit additionalPaths
            // in the later outcome; an empty scope proves no delivery by itself.
            const plan = buildPreviewPlan(
              inventory,
              inventory,
              compareSnapshots(inventory, inventory),
              "Capture the clean opening shipment baseline"
            );
            lease.shipmentScope = {
              openingChanges: [],
              openingInventoryDigest: inventory.baselineDigest,
              plan,
              planDigest: sha256Json(plan),
              recordedAt: now,
            };
          }
          const written = writeLease(lease);
          writeControllerBinding(written, {
            awaitingUser: null,
            inheritedAwaitingUser: null,
            session,
          });
          return written;
        }
      )
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

const shortRevision = (revision: string | null): string =>
  revision ? revision.slice(0, 12) : "(unresolved)";

// A lease records these at `loop start`. Without them it predates scoped
// record-scope checks, and its first scope keeps the whole-inventory rule.
const hasScopedOpeningInvariants = (
  lease: LoopLease
): lease is LoopLease & {
  openingInvariantDigest: string;
  openingWorktrees: NonNullable<LoopLease["openingWorktrees"]>;
} => Boolean(lease.openingInvariantDigest && lease.openingWorktrees);

// A first scope can still be recorded only by an active controller of a run
// that owes one and has not frozen it by relinquishing.
const owesFirstScope = (lease: LoopLease): boolean =>
  lease.shipmentScopeRequired === true &&
  !lease.shipmentScope &&
  !effectiveShipmentScopeFrozenAt(lease) &&
  controllerLifecycle(lease).status === "active";

const registeredController = (lease: LoopLease): LoopWorktreeLease | null =>
  lease.worktrees.find((worktree) => worktree.role === "controller") ?? null;

/**
 * Describes how a worktree differs from the exact state `loop start` saw, or
 * returns null when its branch, head, and content digest are all unchanged.
 * A first shipment scope may only package bytes that were present then.
 */
const openingWorktreeDrift = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  path: string
): string | null => {
  const opening = lease.openingWorktrees?.find(
    (worktree) => worktree.path === path
  );
  if (!opening) {
    return "it was not in the loop-start inventory";
  }
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === path
  );
  if (!current) {
    return "it is missing";
  }
  if (current.branch !== opening.branch) {
    return `its branch moved from ${opening.branch ?? "(detached)"} to ${current.branch ?? "(detached)"}`;
  }
  if (current.headSha !== opening.headSha) {
    return `its head moved from ${shortRevision(opening.headSha)} to ${shortRevision(current.headSha)}`;
  }
  if (current.changeDigest !== opening.changeDigest) {
    return "its staged, unstaged, or untracked content changed";
  }
  return null;
};

/**
 * The first plan-independent reason a first shipment scope can no longer be
 * recorded, or null. Unrelated changes (claimed authors' edits and commits,
 * other branches, stashes, late claimed worktrees) do not count: the plan
 * accounts for them from the current inventory. What still counts is a moved
 * target, changed policy, capabilities, remote bindings or target binding, and
 * a changed controller checkout. A lease that predates these invariants keeps
 * the old rule: the whole-repository inventory must equal its opening digest.
 */
const openingScopeFailure = (
  lease: LoopLease,
  inventory: RepositoryInventory
): string | null => {
  if (!hasScopedOpeningInvariants(lease)) {
    return inventory.baselineDigest === lease.baselineDigest
      ? null
      : `Shipment scope must match the exact unchanged opening repository inventory: loop ${lease.runId} predates scoped record-scope checks, and the repository changed after it started.`;
  }
  const targetRevision = resolvedCurrentTargetRevision(lease);
  if (targetRevision !== lease.targetRevision) {
    return `Target ${lease.targetRef} moved from ${shortRevision(lease.targetRevision)} to ${shortRevision(targetRevision)} after loop ${lease.runId} started, so a first shipment scope can no longer be recorded against the pinned target revision.`;
  }
  if (scopeInvariantDigest(inventory) !== lease.openingInvariantDigest) {
    return `Repository policy, discovered capabilities, remote bindings, or the target binding changed after loop ${lease.runId} started, so a first shipment scope can no longer be recorded.`;
  }
  const controller = registeredController(lease);
  const controllerDrift = controller
    ? openingWorktreeDrift(lease, inventory, controller.path)
    : "no controller checkout is registered";
  if (controllerDrift) {
    return `Controller checkout ${controller?.path ?? "(none)"} changed after loop ${lease.runId} started: ${controllerDrift}. Scoped source bytes must be the ones registered at loop start.`;
  }
  return null;
};

// The next step after a first scope is refused for a reason the plan cannot
// fix. Only a run with no mutation evidence may close through `loop end`; any
// other run must relinquish through finalization and be replanned.
const firstScopeRecoveryStep = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification
): string => {
  if (unmutatedCloseReady(lease, inventory, verification)) {
    return ` This run has not changed anything yet, so if the scope can no longer be recorded, close it with \`simple-changes loop end --run-id ${lease.runId} --agent-id ${lease.ownerAgentId}\`, then run \`simple-changes loop start --mode ${lease.mode} --agent-id ${lease.ownerAgentId}\` to take a new baseline.`;
  }
  if (lease.firstMutationAt === null) {
    return " This run has not changed anything yet, but `loop end` cannot close it yet; run `simple-changes loop status` for the exact next commands.";
  }
  const evidence =
    lease.firstMutationAt === undefined
      ? "This lease predates mutation tracking and cannot prove it changed nothing"
      : "This run has already recorded mutation evidence";
  return ` ${evidence}, so \`loop end\` cannot close it. If the scope can no longer be recorded, finalize it with \`simple-changes loop finalize --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>\`, which relinquishes its controller, then replan it with \`simple-changes loop replan-status\` and an approved \`simple-changes loop replan\`.`;
};

const refuseFirstScope = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification,
  reason: string
): never => {
  throw new SimpleChangesError(
    `${reason}${firstScopeRecoveryStep(lease, inventory, verification)}`,
    EXIT_CODES.unsafe
  );
};

/**
 * A first scope must describe the repository as it is now and package only
 * source bytes the run registered at loop start. Beyond the plan matching the
 * current inventory, that requires: the controller runs it from its own
 * checkout; the pinned target has not moved; policy, capabilities, remote
 * bindings, and the target binding are unchanged; manifest verification
 * passes (so a changed unclaimed opening worktree needs an explicit `loop
 * allow`, while claimed concurrent authors keep editing); and the controller
 * checkout and every unit source worktree still match their loop-start state.
 */
const assertFirstScopeInvariants = (
  lease: LoopLease,
  plan: ChangePlan,
  inventory: RepositoryInventory
): void => {
  const verification = verificationAgainst(lease, inventory);
  const controller = registeredController(lease);
  if (
    hasScopedOpeningInvariants(lease) &&
    controller &&
    inventory.repository.currentCheckout !== controller.path
  ) {
    throw new SimpleChangesError(
      `Record shipment scope from the controller checkout ${controller.path}; this command ran from ${inventory.repository.currentCheckout}. Generate the preview there too.`,
      EXIT_CODES.unsafe
    );
  }
  const failure = openingScopeFailure(lease, inventory);
  if (failure) {
    refuseFirstScope(lease, inventory, verification, failure);
  }
  if (!hasScopedOpeningInvariants(lease)) {
    return;
  }
  if (!verification.ok) {
    const alternative = unmutatedCloseReady(lease, inventory, verification)
      ? ` Because this run has not changed anything yet, \`simple-changes loop end --run-id ${lease.runId} --agent-id ${lease.ownerAgentId}\` can instead close it for a fresh \`loop start\`.`
      : "";
    throw new SimpleChangesError(
      `Shipment scope cannot be recorded while loop ${lease.runId} verification fails: ${verification.violations
        .map((violation) => `${violation.code}:${violation.path}`)
        .join(
          ", "
        )}. Run \`simple-changes loop status\` for the exact next commands; a changed unclaimed opening worktree needs a user-approved \`loop allow\` before scope is recorded.${alternative}`,
      EXIT_CODES.unsafe
    );
  }
  const sources = [
    ...new Set(plan.units.map((unit) => unit.sourceWorktree)),
  ].sort((left, right) => left.localeCompare(right));
  for (const source of sources) {
    const drift = openingWorktreeDrift(lease, inventory, source);
    if (drift) {
      refuseFirstScope(
        lease,
        inventory,
        verification,
        `Scoped source worktree ${source} changed after loop ${lease.runId} started: ${drift}. Scoped source bytes must be the ones registered at loop start; keep its paths preserved or excluded in the plan instead.`
      );
    }
  }
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
  // The plan must describe the repository exactly as it is now, so the
  // returned pre-ship brief is current. This holds for first and refreshed
  // scopes alike; only the comparison with loop start differs.
  if (
    !(
      plan.repositoryRoot === inventory.repository.root &&
      plan.baselineDigest === inventory.baselineDigest
    )
  ) {
    throw new SimpleChangesError(
      refresh
        ? "Refreshed shipment scope must match the exact current repository inventory."
        : "Shipment scope must come from a preview of the exact current repository inventory. Re-run preview and record the new plan.",
      EXIT_CODES.unsafe
    );
  }
  if (!refresh) {
    assertFirstScopeInvariants(lease, plan, inventory);
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
    const preservedElsewhere = refreshPreservedPaths(existingScope.plan, plan);
    const added = inventory.localChanges.find((change) => {
      if (
        scoped.has(`${change.worktreePath}\0${change.path}`) ||
        preservedElsewhere.has(`${change.worktreePath}\0${change.path}`)
      ) {
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

/**
 * Paths the refreshed plan preserves outside every worktree the scope ships
 * from. Another agent's actively changing worktree keeps adding paths while a
 * run waits on review, and those paths are never shipped, so a refresh accepts
 * them as preserved instead of refusing them as expanded scope. A new path in a
 * scoped source worktree still needs a new shipment run.
 */
const refreshPreservedPaths = (
  scopedPlan: ChangePlan,
  refreshedPlan: ChangePlan
): Set<string> => {
  const sources = new Set(scopedPlan.units.map((unit) => unit.sourceWorktree));
  return new Set(
    refreshedPlan.preserved
      .filter((item) => !sources.has(item.worktreePath))
      .flatMap((item) =>
        item.paths.map((path) => `${item.worktreePath}\0${path}`)
      )
  );
};

/**
 * The preserved list a refresh records. Entries in scoped source worktrees
 * stay as first scoped. Elsewhere, every previously preserved path that is
 * still changed stays preserved, and the refreshed plan's preserved paths are
 * added, keyed by worktree; a path the first scope excluded stays excluded
 * rather than being counted twice.
 */
const refreshedPreserved = (
  { openingChanges, plan: scopedPlan }: NonNullable<LoopLease["shipmentScope"]>,
  refreshedPlan: ChangePlan,
  inventory: RepositoryInventory
): ChangePlan["preserved"] => {
  const sources = new Set(scopedPlan.units.map((unit) => unit.sourceWorktree));
  const changed = new Set(
    inventory.localChanges.map(
      (change) => `${change.worktreePath}\0${change.path}`
    )
  );
  // A pathless exclusion covered the one opening change with that path, so it
  // keeps excluding only that worktree's path.
  const excluded = new Set(
    scopedPlan.exclusions.flatMap((exclusion) => {
      const worktrees = exclusion.worktreePath
        ? [exclusion.worktreePath]
        : openingChanges
            .filter((change) => change.path === exclusion.path)
            .map((change) => change.worktreePath);
      return worktrees.map((worktree) => `${worktree}\0${exclusion.path}`);
    })
  );
  const merged = new Map<string, ChangePlan["preserved"][number]>();
  for (const item of [...scopedPlan.preserved, ...refreshedPlan.preserved]) {
    if (sources.has(item.worktreePath)) {
      continue;
    }
    const prior = merged.get(item.worktreePath);
    const paths = [...(prior?.paths ?? []), ...item.paths].filter(
      (path, index, all) =>
        all.indexOf(path) === index &&
        changed.has(`${item.worktreePath}\0${path}`) &&
        !excluded.has(`${item.worktreePath}\0${path}`)
    );
    merged.set(item.worktreePath, { ...item, paths });
  }
  return [
    ...scopedPlan.preserved.filter((item) => sources.has(item.worktreePath)),
    ...[...merged.values()].filter((item) => item.paths.length > 0),
  ];
};

// The inventory a scope's opening changes came from. A refresh keeps the
// first scope's value, because it keeps that scope's opening changes. A scope
// recorded before this field existed was recorded at the unchanged opening
// inventory, so the lease's opening digest stands in for it.
const scopeOpeningInventoryDigest = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  refresh: boolean
): string => {
  if (refresh && lease.shipmentScope) {
    return lease.shipmentScope.openingInventoryDigest ?? lease.baselineDigest;
  }
  return inventory.baselineDigest;
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
  const opening = locateRepository(repositoryPath);
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
      // A refresh keeps the scoped units and exclusions. Outside scoped
      // source worktrees, a path stays preserved while it is still changed,
      // whatever the refreshed preview proposes for it, and the refreshed
      // plan may preserve new paths there.
      const activePlan =
        refresh && priorScope
          ? {
              ...priorScope.plan,
              baselineDigest: plan.baselineDigest,
              generatedAt: plan.generatedAt,
              preserved: refreshedPreserved(priorScope, plan, inventory),
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
      const openingInventoryDigest = scopeOpeningInventoryDigest(
        lease,
        inventory,
        refresh
      );
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
        ...withMutationEvidence(lease, recordedAt),
        ...(shipmentScopeHistory ? { shipmentScopeHistory } : {}),
        ownerProcess: ownerProcessEvidence(recordedAt),
        shipmentScope: {
          openingChanges,
          openingInventoryDigest,
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

/**
 * A unit packaged from the dirty primary checkout may ship a reviewed result
 * whose bytes differ from the frozen opening copy. That is accepted only while
 * the primary is provably untouched since the run's baseline and its HEAD is
 * contained in the bound target, so the outcome cannot launder controller
 * edits made in the primary itself.
 */
const primaryReviewedResultAllowed = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  expected: PlannedUnit
): boolean => {
  if (
    unit.disposition !== "delivered" ||
    expected.sourceWorktree !== lease.primaryCheckout
  ) {
    return false;
  }
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (!(primary?.isPrimary && primary.headSha && registered)) {
    return false;
  }
  const baselineDigest =
    matchingOverride(lease, primary)?.changeDigest ??
    registered.baselineChangeDigest;
  return (
    primary.branch === registered.branch &&
    primary.changeDigest === baselineDigest &&
    (primary.headSha === registered.baselineHeadSha ||
      primary.headSha === receipt.targetRevision) &&
    targetContainsRevision(
      lease.primaryCheckout,
      receipt.targetRevision,
      primary.headSha
    )
  );
};

/**
 * Rechecks a user-approved preserved-source override against the live claim,
 * the frozen source checkout, and the exact target tree. Reads the claim
 * document, so callers hold the worktree-coordination lock.
 */
const preservedSourceOverrideIssue = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  override: PreservedSourceOverrideReceipt | undefined,
  expected: PlannedUnit,
  recordedAt: string
): string | null => {
  const { sourceWorktree } = expected;
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === sourceWorktree
  );
  const { claims } = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const openingEntries = new Map(
    (lease.shipmentScope?.openingChanges ?? [])
      .filter((change) => change.worktreePath === sourceWorktree)
      .map((change) => [change.path, change.sourceEntry])
  );
  return preservedSourceOverrideFailure(
    {
      claim: claims.find((item) => item.claimId === registered?.claimId),
      controllerAgentId: lease.ownerAgentId,
      current: inventory.worktrees.find((item) => item.path === sourceWorktree),
      disposition: unit.disposition,
      finalPaths: unit.finalPaths,
      opening: lease.openingWorktrees?.find(
        (worktree) => worktree.path === sourceWorktree
      ),
      openingEntries,
      originalPaths: unit.originalPaths,
      override,
      registered,
      runId: lease.runId,
      scopePaths: expected.paths,
      sourceEntry: (path) => worktreeSourceEntry(sourceWorktree, path),
      sourceWorktree,
      targetEntry: (path) =>
        targetTreeEntry(lease.primaryCheckout, receipt.targetRevision, path),
      targetRevision: receipt.targetRevision,
      unitId: unit.unitId,
    },
    recordedAt
  );
};

const assertDirectOutcomeMatchesSource = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  override: PreservedSourceOverrideReceipt | undefined,
  expected: PlannedUnit,
  openingChanges: OpeningShipmentChange[],
  recordedAt: string
): void => {
  let reviewedPrimaryResultAllowed: boolean | null = null;
  let preservedSourceOverrideAllowed = false;
  if (override) {
    const issue = preservedSourceOverrideIssue(
      lease,
      inventory,
      receipt,
      unit,
      override,
      expected,
      recordedAt
    );
    if (issue) {
      throw new SimpleChangesError(
        `Shipment outcome unit ${unit.unitId} has invalid manual preserved-source override: ${issue}.`,
        EXIT_CODES.validation
      );
    }
    preservedSourceOverrideAllowed = true;
  }
  for (const item of unit.finalPaths) {
    const sources = openingChanges.filter(
      (change) =>
        change.worktreePath === expected.sourceWorktree &&
        change.path === item.path
    );
    if (sources.length === 1 && sources[0]?.sourceEntry === item.entry) {
      continue;
    }
    reviewedPrimaryResultAllowed ??= primaryReviewedResultAllowed(
      lease,
      inventory,
      receipt,
      unit,
      expected
    );
    if (sources.length === 1 && reviewedPrimaryResultAllowed) {
      continue;
    }
    if (sources.length === 1 && preservedSourceOverrideAllowed) {
      continue;
    }
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} does not match its exact opening source result for ${item.path}.${
        expected.sourceWorktree === lease.primaryCheckout
          ? " A reviewed result for work packaged from the primary checkout is accepted only while that checkout is unchanged from its baseline and its HEAD is contained in the bound target."
          : ""
      }`,
      EXIT_CODES.validation
    );
  }
};

const validateShipmentOutcomeUnits = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  receipt: ShipmentOutcomeReceipt,
  targetDeltaPaths: Set<string>,
  renameOriginals: Map<string, string>,
  overrides: readonly PreservedSourceOverrideReceipt[],
  recordedAt: string
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
    assertDirectOutcomeMatchesSource(
      lease,
      inventory,
      receipt,
      unit,
      overrides.find((item) => item.unitId === unit.unitId),
      expected,
      scope.openingChanges,
      recordedAt
    );
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

export interface PreservedSourceApproval {
  approvalReference?: string | undefined;
  approvedBy?: string | undefined;
}

/**
 * The approval flags on `loop record-outcome` must restate every
 * preserved-source override exactly, and are refused when no override exists.
 */
const assertPreservedSourceApproval = (
  overrides: readonly PreservedSourceOverrideReceipt[],
  approval: PreservedSourceApproval | undefined
): void => {
  if (overrides.length === 0) {
    if (approval?.approvedBy || approval?.approvalReference) {
      throw new SimpleChangesError(
        "Manual approval flags require a preserved-source override in the outcome.",
        EXIT_CODES.validation
      );
    }
    return;
  }
  const approvedBy = requiredText(
    approval?.approvedBy ?? "",
    "manual preserved-source approver"
  );
  const approvalReference = requiredText(
    approval?.approvalReference ?? "",
    "manual preserved-source approval reference"
  );
  if (
    overrides.some(
      (item) =>
        item.approvedBy !== approvedBy ||
        item.approvalReference !== approvalReference
    )
  ) {
    throw new SimpleChangesError(
      "Manual preserved-source approval flags must match every exact outcome override.",
      EXIT_CODES.validation
    );
  }
};

export const recordShipmentOutcome = (
  repositoryPath: string,
  runIdInput: string,
  agentIdInput: string,
  receiptInput: unknown,
  approval?: PreservedSourceApproval
): ShipmentOutcomeRecord => {
  const runId = requiredRunId(runIdInput);
  const agentId = requiredText(agentIdInput, "agent ID");
  // Overrides ride on the receipt's units but are stored beside the lease;
  // the recorded digest covers the complete receipt, overrides included.
  const { overrides, receipt, receiptDigest } =
    splitShipmentOutcomeInput(receiptInput);
  assertPreservedSourceApproval(overrides, approval);
  const opening = locateRepository(repositoryPath);
  // The coordination lock keeps the claim a preserved-source override binds
  // from changing between validation and the lease write.
  return withStateLock(
    opening.repository.commonGitDirectory,
    "record shipment outcome",
    () =>
      withWorktreeCoordinationLock(
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
          const recordedAt = new Date().toISOString();
          const { accountedPaths, scopedPaths } = validateShipmentOutcomeUnits(
            lease,
            inventory,
            receipt,
            targetDeltaPaths,
            renameOriginals,
            overrides,
            recordedAt
          );
          validateAdditionalShipmentPaths(
            lease,
            receipt,
            accountedPaths,
            scopedPaths,
            targetDeltaPaths
          );
          assertCompleteTargetDelta(lease, receipt, accountedPaths);
          // A null record removes a sidecar left by an earlier outcome.
          writeReceiptSidecar(
            lease,
            PRESERVED_SOURCE_OVERRIDE_DIRECTORY,
            overrides.length === 0
              ? null
              : {
                  overrides,
                  receiptDigest,
                  runId: lease.runId,
                  schemaVersion: 1,
                }
          );
          writeLease({
            ...withMutationEvidence(lease, recordedAt),
            ownerProcess: ownerProcessEvidence(recordedAt),
            shipmentOutcome: { receipt, receiptDigest, recordedAt },
            updatedAt: recordedAt,
          });
          return {
            receiptDigest,
            recordedAt,
            summary: `Reviewed shipment outcome: ${receipt.units.length} scoped work item(s) and ${receipt.additionalPaths.length} additional final-target path(s) accounted at ${receipt.targetRevision}.`,
          };
        }
      )
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
  const opening = locateRepository(repositoryPath);
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
      const actualManifestDigest = loopManifestDigest(lease);
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

const emptyVerification = (
  inventory: RepositoryInventory
): LoopVerification => ({
  active: false,
  checkedAt: new Date().toISOString(),
  currentBaselineDigest: inventory.baselineDigest,
  ok: true,
  runId: null,
  violations: [],
});

export const verifyLoop = (repositoryPath: string): LoopVerification => {
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop verify",
    () => {
      const inventory = captureInventory(repositoryPath);
      const storedLease = readLeaseFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      if (!storedLease) {
        return emptyVerification(inventory);
      }
      const projected = withConcurrentAuthorAdmissions(storedLease, inventory);
      const lease =
        controllerLifecycle(storedLease).status === "active"
          ? writeLease({
              ...projected,
              ownerProcess: ownerProcessEvidence(new Date().toISOString()),
              updatedAt: new Date().toISOString(),
            })
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
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop guard",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      assertAgentMutationAllowed(lease, inventory, agentId);
      if (agentId === lease.ownerAgentId) {
        refreshControllerSession(lease);
      }
      const verification = verificationAgainst(lease, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Loop guard rejected mutation: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(
              ", "
            )}. Run \`simple-changes loop status\` for the exact next commands.`,
          EXIT_CODES.unsafe
        );
      }
      writeLease({
        ...withMutationEvidence(lease, verification.checkedAt),
        ownerProcess: ownerProcessEvidence(verification.checkedAt),
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
  const opening = locateRepository(repositoryPath);
  return withAsyncStateLock(
    opening.repository.commonGitDirectory,
    operationName,
    async (lock) => {
      const before = captureInventory(repositoryPath);
      const lease = requireLease(before);
      assertMatchingRun(lease, runId);
      assertAgentMutationAllowed(lease, before, agentId);
      if (agentId === lease.ownerAgentId) {
        refreshControllerSession(lease);
      }
      const openingVerification = verificationAgainst(lease, before);
      if (!openingVerification.ok) {
        throw new SimpleChangesError(
          `Loop operation rejected mutation: ${openingVerification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(
              ", "
            )}. Run \`simple-changes loop status\` for the exact next commands.`,
          EXIT_CODES.unsafe
        );
      }

      const operationStartedAt = new Date().toISOString();
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
        ...withMutationEvidence(currentLease, operationStartedAt),
        ownerProcess: ownerProcessEvidence(closingVerification.checkedAt),
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
      const recordedAt = new Date().toISOString();
      writeLease({
        ...withMutationEvidence(lease, recordedAt),
        emergencyShipping: next,
        updatedAt: recordedAt,
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
  const guarded = await withGuardedLoopCommands(
    repositoryPath,
    runId,
    agentIdInput,
    "loop exec",
    async (runGuarded) =>
      assertCommandSucceeded(command, args, await runGuarded(commandInput))
  );
  return {
    command: [command, ...args],
    result: guarded.result,
    verification: guarded.verification,
  };
};

export interface GuardedLoopCommandInput {
  /** Extra environment for the command, on top of this process's own. */
  environment?: Record<string, string>;
  /** In-memory input for the command's stdin. */
  stdin?: string;
}

/**
 * Runs one command exactly as `loop exec` runs its child: the repository's
 * `execGuard` sees the exact argv first, and the command runs in its own
 * tracked process group from the current checkout. It resolves with the
 * command's result whatever its exit code; a guard refusal, a command that
 * cannot start, or a surviving process group rejects.
 */
export type GuardedLoopCommand = (
  argv: readonly string[],
  input?: GuardedLoopCommandInput
) => Promise<CommandResult>;

export interface GuardedLoopCommandOptions {
  /** Refuse unless the agent owns the active controller lease. */
  controllerOnly?: boolean;
}

/**
 * Holds the controller's integration lock across one or more guarded
 * commands. Lease and manifest verification run before the first command and
 * after the last, exactly as for a single `loop exec`.
 */
export const withGuardedLoopCommands = <T>(
  repositoryPath: string,
  runId: string,
  agentIdInput: string,
  operationName: string,
  operation: (
    runGuarded: GuardedLoopCommand,
    inventory: RepositoryInventory
  ) => Promise<T>,
  options: GuardedLoopCommandOptions = {}
): Promise<LoopOperationResult<T>> =>
  withLoopMutationLease(
    repositoryPath,
    runId,
    agentIdInput,
    operationName,
    (context) => {
      const inventory = captureInventory(repositoryPath);
      if (options.controllerOnly) {
        assertLeaseController(requireLease(inventory), runId, agentIdInput);
      }
      const checkout = inventory.repository.currentCheckout;
      // The repository's guard runs last, after every lease check, and only
      // restricts: a refusal leaves the command unstarted.
      const guard = execGuardFor(inventory);
      const runGuarded: GuardedLoopCommand = async (argv, input = {}) => {
        const [command, ...args] = argv;
        if (!command) {
          throw new SimpleChangesError(
            "A guarded command needs an executable.",
            EXIT_CODES.usage
          );
        }
        if (guard) {
          context.markChildStarting();
          await assertExecGuardAllows({
            checkout,
            command: argv,
            guard,
            onSpawn: context.registerProcess,
            runId,
          });
        }
        context.markChildStarting();
        return runInProcessGroup(
          command,
          args,
          checkout,
          context.registerProcess,
          {
            environment: { ...input.environment, LC_ALL: "C" },
            ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
            streamOutputToStderr: false,
          }
        );
      };
      return operation(runGuarded, inventory);
    }
  );

// The active run's own controller: matching run, active (not relinquished),
// and owned by this agent. Delegated authors never qualify.
const assertLeaseController = (
  lease: LoopLease,
  runId: string,
  agentIdInput: string
): LoopLease => {
  const agentId = requiredText(agentIdInput, "agent ID");
  assertMatchingRun(lease, runId);
  assertControllerActive(lease);
  if (lease.ownerAgentId !== agentId) {
    throw new SimpleChangesError(
      `Only the controller of ${lease.runId} (${lease.ownerAgentId}) may run this step; ${agentId} may not.`,
      EXIT_CODES.unsafe
    );
  }
  return lease;
};

/**
 * The active lease, when `agentId` controls run `runId`; read without the
 * integration lock, for read-only steps that only need the controller's
 * bindings.
 */
export const readControllerLease = (
  repositoryPath: string,
  runId: string,
  agentId: string
): LoopLease => {
  const lease = readLoopLease(repositoryPath);
  if (!lease) {
    throw new SimpleChangesError(
      "No active Simple Changes integration loop was found.",
      EXIT_CODES.unsafe
    );
  }
  return assertLeaseController(lease, runId, agentId);
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
  const opening = locateRepository(repositoryPath);
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
        const completedAt = new Date().toISOString();
        const completedLease: LoopLease = {
          ...withMutationEvidence(currentLease, completedAt),
          preparations: currentLease.preparations.filter(
            (item) => item.agentId !== preparation.agentId
          ),
          updatedAt: completedAt,
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
        ...withMutationEvidence(lease, newPreparation.createdAt),
        preparations: [...lease.preparations, newPreparation],
        updatedAt: newPreparation.createdAt,
      });
      return resumePreparation(preparingLease, newPreparation);
    }
  );
};

interface WorktreeRemovalAudit {
  containmentMethod: TargetContainmentMethod;
  current: WorktreeInventory & { headSha: string };
  path: string;
  targetRevision: string;
}

interface CleanWorktreeAuditMessages {
  digestLabel: string;
  dirty: (path: string) => string;
  isRegistered: (path: string) => boolean;
  missing: (path: string) => string;
  missingHead: (path: string) => string;
  primary: string;
}

const auditCleanNonPrimaryWorktree = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pathInput: string,
  changeDigest: string,
  messages: CleanWorktreeAuditMessages
): { current: WorktreeInventory & { headSha: string }; path: string } => {
  const path = existsSync(pathInput)
    ? realpathSync(pathInput)
    : resolve(pathInput);
  if (path === lease.primaryCheckout) {
    throw new SimpleChangesError(messages.primary, EXIT_CODES.unsafe);
  }
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === path
  );
  if (!(current && messages.isRegistered(path))) {
    throw new SimpleChangesError(messages.missing(path), EXIT_CODES.unsafe);
  }
  if (current.changeDigest !== changeDigest) {
    throw new SimpleChangesError(
      `${messages.digestLabel} digest does not match ${path}; expected current digest ${current.changeDigest}.`,
      EXIT_CODES.unsafe
    );
  }
  if (current.changes.length > 0) {
    throw new SimpleChangesError(messages.dirty(path), EXIT_CODES.unsafe);
  }
  if (!current.headSha) {
    throw new SimpleChangesError(messages.missingHead(path), EXIT_CODES.unsafe);
  }
  return { current: current as WorktreeInventory & { headSha: string }, path };
};

const auditWorktreeRemoval = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pathInput: string,
  changeDigest: string
): WorktreeRemovalAudit => {
  const { current, path } = auditCleanNonPrimaryWorktree(
    lease,
    inventory,
    pathInput,
    changeDigest,
    {
      digestLabel: "Disposition",
      dirty: (candidate) =>
        `Opening worktree ${candidate} must be clean before removal can be authorized.`,
      isRegistered: (candidate) =>
        lease.worktrees.some(
          (worktree) =>
            worktree.path === candidate &&
            worktree.role === "preserved" &&
            !worktree.createdByRun
        ),
      missing: (candidate) =>
        `Disposition path must name a current preserved worktree (one registered at loop start, or adopted through adopt-worktree or accept-paused-change): ${candidate}`,
      missingHead: (candidate) =>
        `Opening worktree ${candidate} has no auditable HEAD revision.`,
      primary:
        "The canonical primary checkout cannot be disposed by the active loop.",
    }
  );
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
  let containmentMethod: TargetContainmentMethod = "target-contained";
  if (!(Number.isInteger(uniqueCommitCount) && uniqueCommitCount === 0)) {
    const containment = targetContainmentAudit(
      lease.primaryCheckout,
      targetRevision,
      current.headSha
    );
    if (containment.exceededMaxCommits) {
      throw new SimpleChangesError(
        `Worktree ${path} is more than ${PATCH_EQUIVALENCE_MAX_COMMITS} commits ahead of ${lease.targetRef}; the patch-equivalence audit was skipped. Next: ship or preserve that work instead of disposing the worktree.`,
        EXIT_CODES.unsafe
      );
    }
    if (containment.method !== "patch-equivalent") {
      throw new SimpleChangesError(
        `Worktree ${path} has ${uniqueCommitCount} unique commit(s) outside ${lease.targetRef} at ${targetRevision}, and they are not patch-equivalent to commits already in the target. Next: ship or preserve that work instead of disposing the worktree.`,
        EXIT_CODES.unsafe
      );
    }
    containmentMethod = "patch-equivalent";
  }
  return { containmentMethod, current, path, targetRevision };
};

const validatedWorktreeDispositionInputs = (
  ownerAgentIdInput: string,
  changeDigestInput: string,
  approvedByInput: string,
  reasonInput: string,
  reasonName: string
): {
  approvedBy: string;
  changeDigest: string;
  ownerAgentId: string;
  reason: string;
} => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approved-by identity");
  const reason = requiredText(reasonInput, reasonName);
  const changeDigest = requiredText(changeDigestInput, "status digest");
  if (!DIGEST_PATTERN.test(changeDigest)) {
    throw new SimpleChangesError(
      "status digest must be a 64-character lowercase SHA-256 value.",
      EXIT_CODES.usage
    );
  }
  return { approvedBy, changeDigest, ownerAgentId, reason };
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
  const { approvedBy, changeDigest, ownerAgentId, reason } =
    validatedWorktreeDispositionInputs(
      ownerAgentIdInput,
      changeDigestInput,
      approvedByInput,
      reasonInput,
      "disposition reason"
    );
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "authorize opening worktree removal",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "record a worktree disposition"
      );
      assertControllerActive(lease);
      const { containmentMethod, current, path, targetRevision } =
        auditWorktreeRemoval(lease, inventory, pathInput, changeDigest);
      const disposition: LoopWorktreeDisposition = {
        approvedBy,
        branch: current.branch,
        changeDigest,
        containmentMethod,
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
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
    }
  );
};

const registrationKind = (
  lease: LoopLease,
  registered: LoopWorktreeLease
): LoopWorktreeRetirement["registration"] => {
  if (
    (lease.rebaselines ?? []).some((record) =>
      record.registered.some((item) => item.path === registered.path)
    )
  ) {
    return "rebaseline";
  }
  return registered.claimId ? "adopted" : "opening";
};

/**
 * Accounts for a preserved registration whose checkout another task removed.
 * The path must be absent from disk and from Git's live worktree list; the
 * record is bound to the exact registered baseline and to named approval.
 * Nothing is deleted, no delivery is proven, and no branch cleanup follows.
 */
export const retireAbsentWorktree = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pathInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approved-by identity");
  const reason = requiredText(reasonInput, "retirement reason");
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop retire-absent-worktree",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "retire an absent worktree"
      );
      assertControllerActive(lease);
      const path = existsSync(pathInput)
        ? realpathSync(pathInput)
        : canonicalAbsentPath(pathInput);
      if (path === lease.primaryCheckout) {
        throw new SimpleChangesError(
          "The canonical primary checkout cannot be retired by the active loop.",
          EXIT_CODES.unsafe
        );
      }
      const registered = lease.worktrees.find(
        (worktree) => worktree.path === path
      );
      if (registered?.role !== "preserved" || registered.createdByRun) {
        throw new SimpleChangesError(
          `Retirement path must name a preserved registration that this run did not create (an opening, rebaselined, or adopted worktree): ${path}`,
          EXIT_CODES.unsafe
        );
      }
      if (!nothingAtPath(path)) {
        throw new SimpleChangesError(
          `Worktree ${path} still exists on disk. Retirement records an absence; use loop allow, loop retain-worktree, or loop dispose-worktree for a checkout that is present.`,
          EXIT_CODES.unsafe
        );
      }
      const current = inventory.worktrees.find(
        (worktree) => worktree.path === path
      );
      if (current && !current.prunable) {
        throw new SimpleChangesError(
          `Git still lists ${path} as a live worktree. Retirement requires the checkout to be absent from both the filesystem and the worktree list.`,
          EXIT_CODES.unsafe
        );
      }
      const existing = retirementForRegistration(lease, registered);
      if (existing) {
        return lease;
      }
      const now = new Date().toISOString();
      const retirement: LoopWorktreeRetirement = {
        absenceCheckedAt: now,
        actorAgentId: ownerAgentId,
        approvedBy,
        baselineChangeDigest: registered.baselineChangeDigest,
        baselineHeadSha: registered.baselineHeadSha,
        branch: registered.branch,
        createdAt: now,
        path,
        reason,
        registration: registrationKind(lease, registered),
        targetRef: lease.targetRef,
        targetRevision: currentTargetRevision(lease),
      };
      writeImmutableRecoveryEvent(
        resolve(
          recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
          `worktree-retirement-${sha256Json(retirement)}.json`
        ),
        { retirement, runId: lease.runId }
      );
      return writeLease({
        ...withMutationEvidence(lease, now),
        retirements: [...(lease.retirements ?? []), retirement],
        updatedAt: now,
      });
    }
  );
};

const auditWorktreeRetention = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  pathInput: string,
  changeDigest: string
): { current: WorktreeInventory & { headSha: string }; path: string } => {
  const { current, path } = auditCleanNonPrimaryWorktree(
    lease,
    inventory,
    pathInput,
    changeDigest,
    {
      digestLabel: "Retention",
      dirty: (candidate) =>
        `Worktree ${candidate} is changing or dirty; its owner must claim it as an active concurrent author or pause it before it can be excluded from this shipment.`,
      isRegistered: () => true,
      missing: (candidate) =>
        `Retention path must name a current worktree: ${candidate}`,
      missingHead: (candidate) =>
        `Worktree ${candidate} has no auditable HEAD revision.`,
      primary:
        "The canonical primary checkout cannot be retained as excluded concurrent state.",
    }
  );
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
  return { current, path };
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
  const { approvedBy, changeDigest, ownerAgentId, reason } =
    validatedWorktreeDispositionInputs(
      ownerAgentIdInput,
      changeDigestInput,
      approvedByInput,
      reasonInput,
      "retention reason"
    );
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "retain excluded worktree",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "retain an excluded worktree"
      );
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
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
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
  const { approvedBy, changeDigest, ownerAgentId, reason } =
    validatedWorktreeDispositionInputs(
      ownerAgentIdInput,
      changeDigestInput,
      approvedByInput,
      reasonInput,
      "override reason"
    );
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop allow",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "record an override"
      );
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
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
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

// Registered entries that `loop accept-paused-change` may record.
const ACCEPTABLE_PAUSED_ROLES: ReadonlySet<LoopWorktreeLease["role"]> = new Set(
  ["concurrent-author", "preserved", "retained"]
);

// A sibling checkout that adoption or acceptance could record next, and whose
// exact current state its own valid current pause receipt for this run
// covers, is waiting for its own turn: its violations do not block recording
// another path, so several receipted checkouts can be recorded one at a time
// in any order. Its own entry keeps failing verification until it is recorded
// too. Every other violation still blocks.
const isReceiptedSiblingViolation = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  violation: LoopViolation,
  recordingPath: string
): boolean => {
  if (violation.path === recordingPath) {
    return false;
  }
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === violation.path
  );
  const recordable = registered
    ? !registered.createdByRun && ACCEPTABLE_PAUSED_ROLES.has(registered.role)
    : violation.code === "unregistered-worktree";
  if (!recordable) {
    return false;
  }
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === violation.path
  );
  if (!current) {
    return false;
  }
  const document = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  return document.receipts.some((receipt) => {
    if (
      receipt.path !== violation.path ||
      receipt.requestingRunId !== lease.runId
    ) {
      return false;
    }
    const claim = document.claims.find(
      (item) => item.claimId === receipt.claimId
    );
    return Boolean(
      claim &&
        claim.commonGitDirectory === lease.commonGitDirectory &&
        ["paused", "adopted-preserved"].includes(claim.state) &&
        coordinationLinkIsCurrent(
          lease.commonGitDirectory,
          claim.claimId,
          receipt.receiptId,
          current
        )
    );
  });
};

export const adoptPausedWorktree = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  pauseReceiptIdInput: string
): LoopLease => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop adopt-worktree",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "adopt a paused worktree"
      );
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
      const blocking = verification.violations.filter(
        (violation) =>
          !isReceiptedSiblingViolation(
            lease,
            inventory,
            violation,
            evidence.current.path
          )
      );
      if (blocking.length > 0) {
        throw new SimpleChangesError(
          `Paused worktree is exact but other loop violations remain: ${blocking
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
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
    }
  );
};

export interface LoopRebaselineResult {
  lease: LoopLease;
  rebaseline: LoopRebaselineRecord;
  verification: LoopVerification;
}

/**
 * Re-baseline the active loop's worktree manifest to current reality. Every
 * worktree that appeared after loop start without run registration is
 * registered as preserved at its exact current state, so the run can proceed
 * or close instead of deadlocking on a stale opening manifest. Registered
 * late arrivals stay owner-controlled and untouched: any later change to one
 * still fails verification until its owner coordinates or the user approves
 * an exact override.
 */
export const rebaselineLoopWorktrees = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  approvedByInput: string,
  reasonInput: string
): LoopRebaselineResult => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approved-by identity");
  const reason = requiredText(reasonInput, "rebaseline reason");
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop rebaseline",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "re-baseline the worktree manifest. Next: run `simple-changes loop takeover` first if this controller is being resumed by a different agent"
      );
      assertControllerActive(lease);
      const lateArrivalPaths = new Set(
        verificationAgainst(lease, inventory)
          .violations.filter(
            (violation) => violation.code === "unregistered-worktree"
          )
          .map((violation) => violation.path)
      );
      const additions = inventory.worktrees.filter((worktree) =>
        lateArrivalPaths.has(worktree.path)
      );
      if (additions.length === 0) {
        throw new SimpleChangesError(
          `Loop ${lease.runId} has no unregistered late-arrival worktrees; there is nothing to re-baseline. Nothing was changed.`,
          EXIT_CODES.unsafe
        );
      }
      const recordedAt = new Date().toISOString();
      const registered: LoopRebaselineRegistration[] = additions.map(
        (worktree) => ({
          changeDigest: worktree.changeDigest,
          headSha: worktree.headSha,
          path: worktree.path,
        })
      );
      const rebaseline: LoopRebaselineRecord = {
        approvedBy,
        reason,
        recordedAt,
        registered,
      };
      const candidate: LoopLease = {
        ...lease,
        rebaselines: [...(lease.rebaselines ?? []), rebaseline],
        updatedAt: recordedAt,
        worktrees: [
          ...lease.worktrees,
          ...additions.map((worktree) =>
            worktreeLease(worktree, "preserved", null, false)
          ),
        ],
      };
      const updated = writeLease(
        withMutationEvidence(candidate, candidate.updatedAt)
      );
      return {
        lease: updated,
        rebaseline,
        verification: verificationAgainst(updated, inventory),
      };
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
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop accept-paused-change",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "accept a paused change"
      );
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
          ACCEPTABLE_PAUSED_ROLES.has(worktree.role)
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
      const blocking = verification.violations.filter(
        (violation) =>
          !(
            (violation.code === "coordination-claim-stale" &&
              violation.path !== evidence.current.path) ||
            isReceiptedSiblingViolation(
              lease,
              inventory,
              violation,
              evidence.current.path
            )
          )
      );
      if (blocking.length > 0) {
        throw new SimpleChangesError(
          `Paused change is exact but other loop violations remain: ${blocking
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
      return writeLease(withMutationEvidence(candidate, candidate.updatedAt));
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
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "worktree resume-ready",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "mark a worktree resume-ready"
      );
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
        lease: writeLease(withMutationEvidence(candidate, candidate.updatedAt)),
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
  const split = splitRemoteBranchReconciliationInput(receiptInput);
  const { ancestryProofs, supersessions } = split;
  const receipt: RemoteBranchReconciliationReceipt =
    validateRemoteBranchReconciliation(
      split.receipt,
      ancestryProofs,
      supersessions
    );
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "record remote branch reconciliation",
    () => {
      const { inventory, lease } = requireOwnedLease(
        repositoryPath,
        runId,
        ownerAgentId,
        "record remote branch reconciliation"
      );
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
      assertRemoteBranchAncestry(
        lease.primaryCheckout,
        receipt,
        ancestryProofs
      );
      const targetPatchIdCache = new Map<string, Map<string, string>>();
      assertRemoteBranchSupersession(
        lease.primaryCheckout,
        receipt,
        supersessions,
        { phase: "record", targetPatchIdCache }
      );
      assertTargetContainsDeletedHeads(
        lease.primaryCheckout,
        receipt,
        targetPatchIdCache
      );
      pinSupersededHeads(lease.primaryCheckout, lease.runId, supersessions);
      writeRemoteBranchAncestry(lease, receipt, ancestryProofs);
      writeRemoteBranchSupersession(lease, receipt, supersessions);
      const reconciledAt = new Date().toISOString();
      return writeLease({
        ...withMutationEvidence(lease, reconciledAt),
        ownerProcess: ownerProcessEvidence(reconciledAt),
        remoteBranchReconciliation: receipt,
        updatedAt: reconciledAt,
      }) as LoopLease & {
        remoteBranchReconciliation: RemoteBranchReconciliationReceipt;
      };
    }
  );
};

export interface FinalizationRemovedBranch {
  branch: string;
  method: TargetContainmentMethod;
}

export interface FinalizationReleasedClaim {
  claimId: string;
  path: string;
  releaseReason: "shipped" | "worktree-absent";
}

export interface FinalizationCleanupResult {
  cleanedPrimaryPaths: string[];
  errors: string[];
  primaryUpdated: boolean;
  prunedWorktreeMetadata: number;
  releasedClaims: FinalizationReleasedClaim[];
  removedBranches: FinalizationRemovedBranch[];
  removedWorktrees: string[];
}

const emptyFinalizationCleanup = (): FinalizationCleanupResult => ({
  cleanedPrimaryPaths: [],
  errors: [],
  primaryUpdated: false,
  prunedWorktreeMetadata: 0,
  releasedClaims: [],
  removedBranches: [],
  removedWorktrees: [],
});

const completedHandoffContainment = (
  registered: LoopWorktreeLease,
  claim: WorktreeClaim,
  release: ReleaseContext,
  worktree: WorktreeInventory,
  repositoryPath: string,
  targetRevision: string
): TargetContainmentMethod | null => {
  if (
    !completedReleaseMatches(registered, claim, worktree, release) ||
    worktree.changes.length > 0
  ) {
    return null;
  }
  return targetContainmentAudit(
    repositoryPath,
    targetRevision,
    worktree.headSha
  ).method;
};

/**
 * Release claims that finalization has already proven obsolete and demote
 * their lease entries from `concurrent-author` to unchanged `preserved`, so
 * the ordinary cleanup candidate audit can see them:
 *
 * - a claim on a prunable worktree (directory gone) protects nothing;
 * - the controller's own active claim on a clean checkout whose exact head the
 *   target already contains is finished work, not concurrent authoring.
 *
 * Any other owner's live claim is untouched. This runs under both the loop
 * and coordination locks; the demoted entry keeps its exact current head and
 * digest as the new baseline so later verification still fails closed on any
 * change.
 */
const reconcileConcurrentAuthorClaims = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  repositoryPath: string,
  targetRevision: string,
  cleanup: FinalizationCleanupResult
): LoopLease => {
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const worktreesByPath = new Map(
    inventory.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const demoted = new Map<string, LoopWorktreeLease>();
  const handoffDispositions = new Map<string, LoopWorktreeDisposition>();
  for (const registered of lease.worktrees) {
    if (registered.role !== "concurrent-author" || !registered.claimId) {
      continue;
    }
    const worktree = worktreesByPath.get(registered.path);
    const claim = coordination.claims.find(
      (item) => item.claimId === registered.claimId
    );
    if (!(worktree && claim)) {
      continue;
    }
    const handoffContainment = completedHandoffContainment(
      registered,
      claim,
      {
        liveClaim: liveClaimFor(
          coordination,
          lease.commonGitDirectory,
          registered.path
        ),
        releaseRecorded: releaseRecordedState(coordination, claim.claimId),
      },
      worktree,
      repositoryPath,
      targetRevision
    );
    if (handoffContainment) {
      const { claimId: _claimId, ...rest } = registered;
      demoted.set(registered.path, {
        ...rest,
        ...worktreeLease(worktree, "preserved", null, registered.createdByRun),
      });
      handoffDispositions.set(
        registered.path,
        automaticRemovalDisposition(lease, worktree, targetRevision)
      );
      continue;
    }
    if (claim.state !== "active") {
      continue;
    }
    let releaseReason: FinalizationReleasedClaim["releaseReason"] | null = null;
    if (worktree.prunable) {
      releaseReason = "worktree-absent";
    } else if (
      claim.owner.agentId === lease.ownerAgentId &&
      claim.headSha === worktree.headSha &&
      claim.changeDigest === worktree.changeDigest &&
      worktree.changes.length === 0 &&
      worktree.headSha &&
      targetContainsRevision(repositoryPath, targetRevision, worktree.headSha)
    ) {
      releaseReason = "shipped";
    }
    if (!releaseReason) {
      continue;
    }
    releaseClaimUnderLock(
      lease.commonGitDirectory,
      claim.claimId,
      lease.ownerAgentId,
      releaseReason
    );
    cleanup.releasedClaims.push({
      claimId: claim.claimId,
      path: claim.path,
      releaseReason,
    });
    const { claimId: _claimId, ...rest } = registered;
    demoted.set(registered.path, {
      ...rest,
      ...worktreeLease(worktree, "preserved", null, registered.createdByRun),
    });
  }
  if (demoted.size === 0) {
    return lease;
  }
  return writeLease({
    ...lease,
    dispositions: [
      ...(lease.dispositions ?? []).filter(
        (disposition) => !handoffDispositions.has(disposition.path)
      ),
      ...handoffDispositions.values(),
    ],
    updatedAt: new Date().toISOString(),
    worktrees: lease.worktrees.map(
      (worktree) => demoted.get(worktree.path) ?? worktree
    ),
  });
};

const automaticRemovalDisposition = (
  lease: LoopLease,
  worktree: WorktreeInventory,
  targetRevision: string
): LoopWorktreeDisposition => {
  if (!worktree.headSha) {
    throw new SimpleChangesError(
      `Cannot record automatic cleanup without a commit identity for ${worktree.path}.`,
      EXIT_CODES.unsafe
    );
  }
  const containment = targetContainmentAudit(
    lease.primaryCheckout,
    targetRevision,
    worktree.headSha
  );
  if (!containment.method) {
    throw new SimpleChangesError(
      `Cannot record automatic cleanup without target containment evidence for ${worktree.path}.`,
      EXIT_CODES.unsafe
    );
  }
  return {
    approvedBy: `mode:${lease.mode}`,
    branch: worktree.branch,
    changeDigest: worktree.changeDigest,
    containmentMethod: containment.method,
    createdAt: new Date().toISOString(),
    headSha: worktree.headSha,
    outcome: "remove-after-audit",
    path: worktree.path,
    reason:
      "The current integration request authorizes automatic cleanup after repeated inventory proved this unchanged clean checkout is contained in the refreshed target.",
    status: "intended",
    targetRef: lease.targetRef,
    targetRevision,
    uniqueCommitCount: 0,
  };
};

type AutomaticCleanupCandidate = WorktreeInventory & { headSha: string };

const automaticCleanupCandidates = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string
): AutomaticCleanupCandidate[] => {
  const registeredByPath = new Map(
    lease.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  return inventory.worktrees.filter((worktree) => {
    const registered = registeredByPath.get(worktree.path);
    const removalDisposition = matchingRemovalDisposition(lease, worktree);
    const targetContained = targetContainsRevision(
      inventory.repository.primaryCheckout,
      targetRevision,
      worktree.headSha
    );
    const dispositionContained = Boolean(
      removalDisposition &&
        targetContainmentAudit(
          inventory.repository.primaryCheckout,
          targetRevision,
          worktree.headSha
        ).method === removalDisposition.containmentMethod
    );
    const basicCandidate = Boolean(
      !worktree.isPrimary &&
        registered &&
        registered.role !== "concurrent-author" &&
        registered.role !== "retained" &&
        worktree.changes.length === 0 &&
        worktree.headSha &&
        (targetContained || dispositionContained)
    );
    if (!(basicCandidate && registered)) {
      return false;
    }
    // Any claim not yet released holds the checkout, whatever its state or
    // the policy, except the claim this run adopted through the
    // registration's own pause receipt.
    const holder = liveClaimFor(
      coordination,
      lease.commonGitDirectory,
      worktree.path
    );
    const held =
      holder !== undefined &&
      !(
        holder.state === "adopted-preserved" &&
        holder.claimId === registered.claimId &&
        registered.pauseReceiptId !== undefined
      );
    return Boolean(
      !held &&
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
  const dispositionPatchIdCache = new Map<string, Map<string, string>>();
  const completedPaths = (lease.dispositions ?? [])
    .filter(
      (disposition) =>
        disposition.status !== "completed" &&
        !currentPaths.has(disposition.path) &&
        disposition.targetRef === lease.targetRef &&
        disposition.targetRevision === targetRevision &&
        targetContainmentAudit(
          inventory.repository.primaryCheckout,
          targetRevision,
          disposition.headSha,
          dispositionPatchIdCache
        ).method !== null
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
        containmentMethod: "target-contained" as const,
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
  // Git prunes every stale registration, not just the candidates we pass to
  // this helper. Preserve the entire set if even one path lacks a fresh audit.
  const freshInventory = captureInventory(repositoryPath);
  const freshCandidates = automaticCleanupCandidates(
    currentLease,
    freshInventory,
    targetRevision
  );
  const freshPrunable = freshInventory.worktrees.filter(
    (worktree) => worktree.prunable
  );
  const fullyAudited = freshPrunable.every(
    (worktree) =>
      prunable.some(
        (candidate) =>
          candidate.path === worktree.path &&
          candidate.branch === worktree.branch &&
          candidate.headSha === worktree.headSha &&
          candidate.changeDigest === worktree.changeDigest
      ) && freshCandidates.some((candidate) => candidate.path === worktree.path)
  );
  if (!fullyAudited || freshPrunable.length !== prunable.length) {
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
  const deletion = deleteTargetContainedBranches({
    branches: inventory.branches.filter(
      (branch) =>
        branch.name !== targetBranch &&
        branch.worktreePath === null &&
        (openingBranches.get(branch.name) === branch.sha ||
          runOwnedBranches.has(branch.name) ||
          reconciledAbsentBranches.has(branch.name))
    ),
    repositoryPath,
    targetRevision,
  });
  cleanup.errors.push(...deletion.errors);
  cleanup.removedBranches.push(
    ...deletion.removed.map(({ branch, method }) => ({ branch, method }))
  );
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

/**
 * When review changed some scoped bytes, normalizing only the
 * target-equivalent paths would alter the primary's baseline digest and defeat
 * the delivery proof that lets the run close. Proven delivered mixed-source
 * state is then preserved byte-for-byte, including the index.
 */
const preservesProvenMixedPrimary = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  primary: WorktreeInventory,
  eligiblePaths: Set<string>
): boolean => {
  const scopedPrimaryPaths = new Set(
    (lease.shipmentScope?.plan.units ?? [])
      .filter((unit) => unit.sourceWorktree === primary.path)
      .flatMap((unit) => unit.paths)
  );
  return (
    primary.changes.some(
      (change) =>
        scopedPrimaryPaths.has(change.path) && !eligiblePaths.has(change.path)
    ) && preservesUnchangedPrimary(lease, inventory)
  );
};

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
  if (preservesProvenMixedPrimary(lease, inventory, primary, eligiblePaths)) {
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

const primarySynchronizationIntent = (
  lease: LoopLease,
  targetBranch: string,
  targetRevision: string
) => {
  const before = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (before?.role !== "preserved" || before.claimId) {
    return null;
  }
  const after = {
    ...before,
    baselineChangeDigest: sha256(
      JSON.stringify({ changes: [], contentIdentities: [] })
    ),
    baselineHeadSha: targetRevision,
    branch: targetBranch,
  };
  const record = {
    after,
    before,
    kind: "automatic-primary-synchronization",
    runId: lease.runId,
    targetRef: lease.targetRef,
    targetRevision,
  };
  return {
    path: resolve(
      recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
      `primary-synchronization-${sha256Json(record)}.json`
    ),
    record,
  };
};

const reconcilePrimarySynchronization = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopLease => {
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (registered?.role !== "preserved" || registered.claimId) {
    return lease;
  }
  const targetBranch = targetBranchForRef(
    lease.primaryCheckout,
    lease.targetRef
  );
  if (!targetBranch) {
    return lease;
  }
  let targetRevision: string;
  try {
    targetRevision = currentTargetRevision(lease);
  } catch {
    // Ordinary finalization must still record its unresolved-target blocker
    // and relinquish. Missing recovery evidence cannot short-circuit that.
    return lease;
  }
  const intent = primarySynchronizationIntent(
    lease,
    targetBranch,
    targetRevision
  );
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (!(intent && primary && existsSync(intent.path))) {
    return lease;
  }
  const recorded = readImmutableRecoveryEvent(intent.path);
  if (sha256Json(recorded) !== sha256Json(intent.record)) {
    throw new SimpleChangesError(
      "Primary synchronization intent does not match this run and target.",
      EXIT_CODES.unsafe
    );
  }
  const expected = intent.record.after;
  if (
    primary.branch !== expected.branch ||
    primary.headSha !== expected.baselineHeadSha ||
    primary.changeDigest !== expected.baselineChangeDigest ||
    primary.changes.length > 0
  ) {
    return lease;
  }
  return writeLease({
    ...lease,
    updatedAt: new Date().toISOString(),
    worktrees: lease.worktrees.map((worktree) =>
      worktree.path === primary.path ? expected : worktree
    ),
  });
};

const preparePrimarySynchronization = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string,
  targetRevision: string
): boolean => {
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (registered?.role !== "preserved") {
    return true;
  }
  const intent = primarySynchronizationIntent(
    lease,
    targetBranch,
    targetRevision
  );
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (
    !(intent && primary) ||
    primary.changes.length > 0 ||
    primary.branch !== registered.branch ||
    primary.headSha !== registered.baselineHeadSha ||
    primary.changeDigest !== registered.baselineChangeDigest
  ) {
    return false;
  }
  if (primary.branch === targetBranch && primary.headSha === targetRevision) {
    return true;
  }
  if (
    !targetContainsRevision(
      lease.primaryCheckout,
      targetRevision,
      primary.headSha
    )
  ) {
    return false;
  }
  const recorded = writeImmutableRecoveryEvent(intent.path, intent.record);
  if (sha256Json(recorded) !== sha256Json(intent.record)) {
    throw new SimpleChangesError(
      "Primary synchronization intent does not match this run and target.",
      EXIT_CODES.unsafe
    );
  }
  return true;
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
      worktree.path === primary.path
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
  lease = reconcileConcurrentAuthorClaims(
    lease,
    inventoryInput,
    repositoryPath,
    targetRevision,
    cleanup
  );
  const candidates = automaticCleanupCandidates(
    lease,
    inventoryInput,
    targetRevision
  );
  const liveRemoval = removeAutomaticWorktrees(
    lease,
    repositoryPath,
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
  if (
    preparePrimarySynchronization(
      lease,
      inventory,
      targetBranch,
      targetRevision
    )
  ) {
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
    if (
      process.env.NODE_ENV === "test" &&
      process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_PRIMARY_SYNC === lease.runId
    ) {
      throw new SimpleChangesError(
        "Injected failure after primary synchronization.",
        EXIT_CODES.unsafe
      );
    }
    inventory = captureInventory(repositoryPath);
    lease = reconcilePrimarySynchronization(lease, inventory);
    lease = bindAutomaticPrimaryBranchChange(lease, inventory);
  }
  removeTargetContainedBranches(
    lease,
    repositoryPath,
    targetBranch,
    targetRevision,
    cleanup
  );
  cleanup.removedBranches = [
    ...new Map(
      cleanup.removedBranches.map((entry) => [entry.branch, entry])
    ).values(),
  ].sort((left, right) => left.branch.localeCompare(right.branch));
  cleanup.removedWorktrees = [...new Set(cleanup.removedWorktrees)].sort();
  for (const claim of releaseAbsentWorktreeClaimsUnderLock(
    lease.commonGitDirectory,
    captureInventory(repositoryPath),
    lease.ownerAgentId
  )) {
    cleanup.releasedClaims.push({
      claimId: claim.claimId,
      path: claim.path,
      releaseReason: "worktree-absent",
    });
  }
  cleanup.releasedClaims.sort((left, right) =>
    left.path.localeCompare(right.path)
  );
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

/**
 * A Ship run that still owes its first shipment scope may close without it
 * only when it provably did nothing. `firstMutationAt` must be explicitly
 * null, because a lease written before the field existed cannot prove that,
 * and the lease must carry no other evidence of action: no preparation,
 * disposition, override, rebaseline, retirement, Emergency Shipping state,
 * shipment outcome, remote reconciliation, target-equivalent outcome,
 * superseded or frozen scope, controller handoff or relinquishment, and no
 * worktree that the run created, retained, adopted, or marked resume-ready.
 */
const isUnmutatedScopelessRun = (lease: LoopLease): boolean => {
  const lifecycle = controllerLifecycle(lease);
  return (
    lease.shipmentScopeRequired === true &&
    !lease.shipmentScope &&
    lease.firstMutationAt === null &&
    lease.preparations.length === 0 &&
    (lease.dispositions ?? []).length === 0 &&
    lease.overrides.length === 0 &&
    (lease.rebaselines ?? []).length === 0 &&
    (lease.retirements ?? []).length === 0 &&
    !lease.emergencyShipping &&
    !lease.shipmentOutcome &&
    !lease.remoteBranchReconciliation &&
    !lease.closeEquivalentOutcome &&
    (lease.shipmentScopeHistory ?? []).length === 0 &&
    !effectiveShipmentScopeFrozenAt(lease) &&
    lifecycle.status === "active" &&
    lifecycle.handoffs.length === 0 &&
    lease.worktrees.every(
      (worktree) =>
        !worktree.createdByRun &&
        worktree.role !== "author" &&
        worktree.role !== "retained" &&
        worktree.retention === undefined &&
        worktree.pauseReceiptId === undefined &&
        worktree.coordinationState === undefined
    )
  );
};

// Violations an untouched run may still close over. Each describes a change
// that someone else made to a worktree this run never had authority over: an
// opening checkout its owner kept editing, or a concurrent author whose claim
// lapsed. Closing deletes nothing, and the next loop start re-baselines both.
// Every other code refuses the close. A new unregistered worktree, a missing
// opening worktree, a moved controller branch, or a changed remote destination
// may be this run acting outside the loop, and a wrong-repository or legacy
// binding cannot vouch for itself. Retained, preparation, and adopted-claim
// codes cannot arise without evidence that already disqualifies the run.
const UNMUTATED_CLOSE_COMPATIBLE_VIOLATIONS: ReadonlySet<
  LoopViolation["code"]
> = new Set(["coordination-claim-stale", "preserved-worktree-changed"]);

/**
 * Returns null when the untouched-run close does not apply, so the ordinary
 * completion gates decide. Otherwise returns the violations that still refuse
 * it; an empty list means the run may close without mutation.
 */
const unmutatedCloseBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification
): string[] | null => {
  if (
    !isUnmutatedScopelessRun(lease) ||
    (targetUsesGitLab(inventory) && !lease.openingRemoteInventory)
  ) {
    return null;
  }
  return verification.violations
    .filter(
      (violation) => !UNMUTATED_CLOSE_COMPATIBLE_VIOLATIONS.has(violation.code)
    )
    .map((violation) => `${violation.code}:${violation.path}`);
};

const unmutatedCloseReady = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification
): boolean =>
  unmutatedCloseBlockers(lease, inventory, verification)?.length === 0;

export interface LoopUnmutatedCloseReceipt {
  checkedAt: string;
  closedBy: "loop end" | "loop finalize";
  kind: "loop-unmutated-close";
  leaseDigest: string;
  mode: LoopLease["mode"];
  openingBaselineDigest: string;
  ownerAgentId: string;
  reason: string | null;
  runId: string;
  schemaVersion: 1;
  targetRef: string;
  targetRevision: string;
  verification: {
    currentBaselineDigest: string | null;
    ok: boolean;
    violations: Pick<LoopViolation, "code" | "path">[];
  };
}

export interface LoopUnmutatedClose {
  receipt: LoopUnmutatedCloseReceipt;
  receiptPath: string;
}

// Records why an untouched run closed, then releases only its bookkeeping.
// No worktree, branch, claim, or provider state is touched.
const closeUnmutatedRun = (
  lease: LoopLease,
  verification: LoopVerification,
  reason: string | null,
  closedBy: LoopUnmutatedCloseReceipt["closedBy"]
): LoopUnmutatedClose => {
  const receiptPath = resolve(
    recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
    "abort-unmutated.json"
  );
  const receipt = writeImmutableRecoveryEvent<LoopUnmutatedCloseReceipt>(
    receiptPath,
    {
      checkedAt: verification.checkedAt,
      closedBy,
      kind: "loop-unmutated-close",
      leaseDigest: loopManifestDigest(lease),
      mode: lease.mode,
      // An untouched run never recorded a scope, so its only opening is the
      // loop-start inventory; there is no scope-time digest to report.
      openingBaselineDigest: lease.baselineDigest,
      ownerAgentId: lease.ownerAgentId,
      reason,
      runId: lease.runId,
      schemaVersion: 1,
      targetRef: lease.targetRef,
      targetRevision: lease.targetRevision,
      verification: {
        currentBaselineDigest: verification.currentBaselineDigest,
        ok: verification.ok,
        violations: verification.violations.map(({ code, path }) => ({
          code,
          path,
        })),
      },
    }
  );
  rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
  return { receipt, receiptPath };
};

const missingShipmentScopeBlockers = (lease: LoopLease): string[] =>
  lease.shipmentScopeRequired && !lease.shipmentScope
    ? [
        "Record the comprehensive shipment scope and pre-ship brief before ending this Ship run.",
      ]
    : [];

/**
 * The overrides recorded beside the lease for its exact shipment outcome.
 * Throws when the stored receipt and its sidecar no longer recompose into the
 * complete receipt the recorded digest names.
 */
const storedPreservedSourceOverrides = (
  lease: LoopLease
): PreservedSourceOverrideReceipt[] => {
  const outcome = lease.shipmentOutcome;
  if (!outcome) {
    return [];
  }
  return recordedPreservedSourceOverrides(
    readReceiptSidecar(
      lease.commonGitDirectory,
      PRESERVED_SOURCE_OVERRIDE_DIRECTORY,
      lease.runId
    ),
    lease.runId,
    outcome.receipt,
    outcome.receiptDigest
  );
};

const recordedOutcomeIntact = (lease: LoopLease): boolean => {
  try {
    storedPreservedSourceOverrides(lease);
    return true;
  } catch {
    return false;
  }
};

const shipmentOutcomeCompletionBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
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
  const targetBlockers = paths.flatMap((item) =>
    targetTreeEntry(
      lease.primaryCheckout,
      receipt.targetRevision,
      item.path
    ) === item.entry
      ? []
      : [`Shipment outcome entry changed after review: ${item.path}`]
  );
  let overrides: PreservedSourceOverrideReceipt[];
  try {
    overrides = storedPreservedSourceOverrides(lease);
  } catch (error) {
    return [
      ...targetBlockers,
      error instanceof Error ? error.message : String(error),
    ];
  }
  // A preserved-source override holds only while its source, claim, and
  // target entries stay exactly as approved.
  const sourceBlockers = lease.shipmentScope.plan.units.flatMap((expected) => {
    const unit = receipt.units.find((item) => item.unitId === expected.id);
    const override = overrides.find((item) => item.unitId === expected.id);
    if (!(unit && override)) {
      return [];
    }
    const issue = preservedSourceOverrideIssue(
      lease,
      inventory,
      receipt,
      unit,
      override,
      expected,
      lease.shipmentOutcome?.recordedAt ?? ""
    );
    return issue
      ? [
          `Manually approved preserved source ${expected.sourceWorktree} changed after recording: ${issue}`,
        ]
      : [];
  });
  return [...targetBlockers, ...sourceBlockers];
};

const repositoryCleanupBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetBranch: string | null,
  targetRevision: string | null
): string[] => {
  const blockers: string[] = [];
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
  return blockers;
};

const loopCompletionBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification,
  cleanupErrors: string[] = [],
  scopedCompletion = false
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
  if (!scopedCompletion && liveRunWorktrees.length > 0) {
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
  blockers.push(
    ...shipmentOutcomeCompletionBlockers(lease, inventory, targetRevision)
  );
  if (!scopedCompletion) {
    blockers.push(
      ...repositoryCleanupBlockers(
        lease,
        inventory,
        targetBranch,
        targetRevision
      )
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
  closedWithoutMutation?: LoopUnmutatedClose;
  lease: LoopLease | null;
  outcome: "completed" | "relinquished" | "closed-without-mutation";
  receipt: LoopFinalizationReceipt;
  receiptPath: string;
  verification: LoopVerification;
}

export interface LoopFinalizationReceipt {
  /** Questions a paused controller left for the user. */
  awaitingUser?: string[];
  blockers: string[];
  blocksNextShipment: boolean;
  cleanup: FinalizationCleanupResult;
  cleanupStatus: "complete" | "pending";
  controllerStatus: "released" | "relinquished";
  deliveryStatus: "verified" | "unverified";
  finalizedAt: string;
  kind: "loop-finalization";
  leaseDigest: string;
  preservedWorktrees: string[];
  reason: string;
  runId: string;
  schemaVersion: 1;
  shipmentStatus: "closed" | "open" | "unstarted";
  targetRevision: string | null;
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
  receiptDigests: readonly string[]
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
  if (!receiptDigests.includes(completed.receiptDigest)) {
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
  canonicalReceiptDigest: string,
  legacyReceiptDigest: string
): { absentPaths: string[]; intent: PostCleanupRecoveryIntent } => {
  const intentPath = recoveryHistoryPath(
    commonGitDirectory,
    lease.runId,
    "intent"
  );
  const existingIntent = existsSync(intentPath)
    ? readImmutableRecoveryEvent<PostCleanupRecoveryIntent>(intentPath)
    : null;
  // An intent recorded by an earlier version carries the key-order-sensitive
  // digest; keep using it so that interrupted recovery can still resume.
  const receiptDigest =
    existingIntent?.receiptDigest === legacyReceiptDigest
      ? legacyReceiptDigest
      : canonicalReceiptDigest;
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
  const opening = locateRepository(repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withStateLock(commonGitDirectory, "post-cleanup recovery", () => {
    const receiptDigest = sha256Json(receipt);
    // Earlier versions digested the receipt with key-order-sensitive
    // JSON.stringify; accept that digest too so recovery evidence recorded
    // under the old version still matches.
    const legacyReceiptDigest = sha256(JSON.stringify(receipt));
    const prior = completedPostCleanupRecovery(commonGitDirectory, runId, [
      receiptDigest,
      legacyReceiptDigest,
    ]);
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
          receiptDigest,
          legacyReceiptDigest
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
            receiptDigest: intent.receiptDigest,
            retiredClaimIds,
            runId,
            schemaVersion: 1,
          }
        );
        if (completed.receiptDigest !== intent.receiptDigest) {
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

// Delivery and repository housekeeping are separate completion conditions. Only
// an exact delivered outcome may close with unrelated state left in place.
const hasVerifiedDelivery = (
  lease: LoopLease,
  inventory: RepositoryInventory
): boolean => {
  const scope = lease.shipmentScope;
  const outcome = lease.shipmentOutcome?.receipt;
  if (
    !(
      scope &&
      outcome &&
      (outcome.units.length > 0 || outcome.additionalPaths.length > 0)
    )
  ) {
    return false;
  }
  const target = currentTargetRevision(lease);
  if (shipmentOutcomeCompletionBlockers(lease, inventory, target).length > 0) {
    return false;
  }
  return scope.plan.units.every((unit) => {
    const source = inventory.worktrees.find(
      (worktree) => worktree.path === unit.sourceWorktree
    );
    if (!source) {
      return (lease.dispositions ?? []).some(
        (item) =>
          item.path === unit.sourceWorktree &&
          item.status === "completed" &&
          item.targetRevision === target
      );
    }
    if (source.isPrimary && preservesUnchangedPrimary(lease, inventory)) {
      return true;
    }
    if (
      source.changes.length === 0 &&
      source.headSha &&
      targetContainmentAudit(lease.primaryCheckout, target, source.headSha)
        .method
    ) {
      return true;
    }
    // A user-approved preserved source stays dirty in its author's claimed
    // checkout; it counts only while its override still holds exactly. The
    // completion blockers above already proved the sidecar readable.
    const override = storedPreservedSourceOverrides(lease).find(
      (item) => item.unitId === unit.id
    );
    const recorded = outcome.units.find((item) => item.unitId === unit.id);
    return Boolean(
      override &&
        recorded &&
        preservedSourceOverrideIssue(
          lease,
          inventory,
          outcome,
          recorded,
          override,
          unit,
          lease.shipmentOutcome?.recordedAt ?? ""
        ) === null
    );
  });
};

/**
 * Proves that a primary checkout still carrying dirty paths does not hold the
 * shipment open: it is unchanged from its baseline, its HEAD is contained in
 * the target, every scoped path has its recorded reviewed result in the
 * target, and every other dirty path was explicitly preserved or excluded.
 */
const preservesUnchangedPrimary = (
  lease: LoopLease,
  inventory: RepositoryInventory
): boolean => {
  const primary = inventory.worktrees.find((worktree) => worktree.isPrimary);
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  const scope = lease.shipmentScope;
  if (!(primary && registered && scope)) {
    return false;
  }
  const units = scope.plan.units.filter(
    (unit) => unit.sourceWorktree === primary.path
  );
  const outcome = lease.shipmentOutcome?.receipt;
  const delivered = new Map<string, string | null>();
  for (const unit of units) {
    const result = outcome?.units.find((item) => item.unitId === unit.id);
    if (!result) {
      return false;
    }
    for (const item of [...result.finalPaths, ...result.originalPaths]) {
      delivered.set(item.path, item.entry);
    }
  }
  const target = currentTargetRevision(lease);
  return primaryDeliveryProof({
    baselineBranch: registered.branch,
    baselineDigest:
      matchingOverride(lease, primary)?.changeDigest ??
      registered.baselineChangeDigest,
    baselineHead: registered.baselineHeadSha,
    branch: primary.branch,
    changes: primary.changes,
    delivered,
    digest: primary.changeDigest,
    excluded: scope.plan.exclusions
      .filter((item) => item.worktreePath === primary.path)
      .map((item) => item.path),
    head: primary.headSha,
    headContained: Boolean(
      primary.headSha &&
        targetContainsRevision(lease.primaryCheckout, target, primary.headSha)
    ),
    headEntry: (path) =>
      primary.headSha
        ? targetTreeEntry(primary.path, primary.headSha, path)
        : null,
    isPrimary: primary.isPrimary,
    outcomeTarget: units.length > 0 ? outcome?.targetRevision : target,
    preserved: scope.plan.preserved
      .filter((item) => item.worktreePath === primary.path)
      .flatMap((item) => item.paths),
    scoped: units.flatMap((unit) => unit.paths),
    sourceEntry: (path) => worktreeSourceEntry(primary.path, path),
    target,
    targetEntry: (path) => targetTreeEntry(lease.primaryCheckout, target, path),
  });
};

const shipmentFinalizationVerification = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification,
  verifiedDelivery: boolean
): LoopVerification => {
  if (!verifiedDelivery) {
    return verification;
  }
  const targetBranch = targetBranchForRef(
    lease.primaryCheckout,
    lease.targetRef
  );
  const primary = inventory.worktrees.find((worktree) => worktree.isPrimary);
  const violations = verification.violations.filter((violation) => {
    if (
      violation.code === "preserved-worktree-changed" &&
      violation.path === lease.primaryCheckout &&
      preservesUnchangedPrimary(lease, inventory)
    ) {
      return false;
    }
    if (violation.code !== "unregistered-worktree") {
      return true;
    }
    const arrival = inventory.worktrees.find(
      (worktree) => worktree.path === violation.path
    );
    return !(
      arrival &&
      !arrival.isPrimary &&
      arrival.branch !== targetBranch &&
      arrival.branch !== primary?.branch &&
      !lease.preparations.some((item) => item.path === arrival.path)
    );
  });
  return { ...verification, ok: violations.length === 0, violations };
};

const finalizationDecision = (
  lease: LoopLease,
  finalInventory: RepositoryInventory,
  cleanup: FinalizationCleanupResult,
  reason: string,
  awaitingUser: string[] | null = null
): {
  blockers: string[];
  verification: LoopVerification;
  receipt: LoopFinalizationReceipt;
} => {
  const strictVerification = verificationAgainst(lease, finalInventory);
  let verifiedDelivery = false;
  try {
    verifiedDelivery = hasVerifiedDelivery(lease, finalInventory);
  } catch {
    // The ordinary blockers below report unresolved target evidence.
  }
  const primary = finalInventory.worktrees.find(
    (worktree) => worktree.isPrimary
  );
  const scopedCompletion =
    verifiedDelivery &&
    (!primary?.changes.length ||
      preservesUnchangedPrimary(lease, finalInventory));
  const verification = shipmentFinalizationVerification(
    lease,
    finalInventory,
    strictVerification,
    scopedCompletion
  );
  const blockers = loopCompletionBlockers(
    lease,
    finalInventory,
    verification,
    cleanup.errors,
    scopedCompletion
  );
  if (
    lease.shipmentOutcome?.receipt.units.some(
      (unit) => unit.disposition === "delivered"
    ) &&
    !verifiedDelivery
  ) {
    blockers.push(
      "Reconcile delivered source worktrees and the exact current target before finalization; unaccounted source changes must remain open."
    );
  }
  if (awaitingUser) {
    blockers.push(
      `Paused for the user's answer before this run can continue: ${awaitingUser.join(" | ")}`
    );
  }
  const lifecycle: Pick<
    LoopFinalizationReceipt,
    "blocksNextShipment" | "controllerStatus" | "shipmentStatus"
  > =
    blockers.length === 0
      ? {
          blocksNextShipment: false,
          controllerStatus: "released",
          shipmentStatus: "closed",
        }
      : {
          blocksNextShipment: true,
          controllerStatus: "relinquished",
          shipmentStatus: "open",
        };
  const cleanupPending =
    loopCompletionBlockers(
      lease,
      finalInventory,
      strictVerification,
      cleanup.errors
    ).length > 0;
  const now = new Date().toISOString();
  const receipt: LoopFinalizationReceipt = {
    ...lifecycle,
    ...(awaitingUser ? { awaitingUser } : {}),
    blockers,
    cleanup,
    cleanupStatus: cleanupPending ? "pending" : "complete",
    deliveryStatus: verifiedDelivery ? "verified" : "unverified",
    finalizedAt: now,
    kind: "loop-finalization",
    leaseDigest: loopManifestDigest(lease),
    preservedWorktrees: finalInventory.worktrees
      .map((worktree) => worktree.path)
      .sort((left, right) => left.localeCompare(right)),
    reason,
    runId: lease.runId,
    schemaVersion: 1,
    targetRevision: verifiedDelivery
      ? (lease.shipmentOutcome?.receipt.targetRevision ?? null)
      : null,
  };
  return { blockers, receipt, verification };
};

const releaseDeliveredSourceClaims = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  cleanup: FinalizationCleanupResult
): void => {
  const sourcePaths = new Set(
    lease.shipmentScope?.plan.units.map((unit) => unit.sourceWorktree)
  );
  const { claims } = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  for (const claim of claims) {
    const source = inventory.worktrees.find(
      (worktree) => worktree.path === claim.path
    );
    if (
      claim.state === "active" &&
      claim.owner.agentId === lease.ownerAgentId &&
      sourcePaths.has(claim.path) &&
      source &&
      source.branch === claim.branch &&
      source.changes.length === 0
    ) {
      releaseClaimUnderLock(
        lease.commonGitDirectory,
        claim.claimId,
        lease.ownerAgentId,
        "shipped"
      );
      cleanup.releasedClaims.push({
        claimId: claim.claimId,
        path: claim.path,
        releaseReason: "shipped",
      });
    }
  }
};

// Finalization runs before every terminal response, including one that ends
// the turn on a scope question. Relinquishing an untouched Ship run would freeze
// a scope it never recorded and leave only an approved replan, so finalization
// closes it instead, whether or not the repository moved. Nothing is lost: a
// fresh `loop start` on an unchanged repository takes the same baseline.
const finalizeUnmutatedRun = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  reason: string,
  awaitingUser: string[] | null
): LoopFinalizationResult | null => {
  if (!isUnmutatedScopelessRun(lease)) {
    return null;
  }
  const verification = verificationAgainst(lease, inventory);
  if (!unmutatedCloseReady(lease, inventory, verification)) {
    return null;
  }
  const cleanup = emptyFinalizationCleanup();
  const receipt: LoopFinalizationReceipt = {
    ...(awaitingUser ? { awaitingUser } : {}),
    blockers: [],
    blocksNextShipment: false,
    cleanup,
    // No automatic cleanup runs for a run that never recorded its scope.
    cleanupStatus: "pending",
    controllerStatus: "released",
    deliveryStatus: "unverified",
    finalizedAt: verification.checkedAt,
    kind: "loop-finalization",
    leaseDigest: loopManifestDigest(lease),
    preservedWorktrees: inventory.worktrees
      .map((worktree) => worktree.path)
      .sort((left, right) => left.localeCompare(right)),
    reason,
    runId: lease.runId,
    schemaVersion: 1,
    shipmentStatus: "unstarted",
    targetRevision: null,
  };
  const receiptPath = resolve(
    recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
    `finalization-${sha256Json(receipt)}.json`
  );
  writeImmutableRecoveryEvent(receiptPath, { lease, receipt });
  forgetLeaseSession(lease);
  removeControllerBinding(lease);
  return {
    blockers: [],
    cleanup,
    closedWithoutMutation: closeUnmutatedRun(
      lease,
      verification,
      reason,
      "loop finalize"
    ),
    lease: null,
    outcome: "closed-without-mutation",
    receipt,
    receiptPath,
    verification,
  };
};

const relinquishController = (
  lease: LoopLease,
  reason: string,
  now: string,
  awaitingUser: string[] | null = null
): LoopLease => {
  forgetLeaseSession(lease);
  // A released controller is no session's to finish; only its questions stay.
  writeControllerBinding(lease, {
    awaitingUser: awaitingUser
      ? { questions: awaitingUser, recordedAt: now }
      : null,
    session: null,
  });
  return writeLease({
    ...withMutationEvidence(lease, now),
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
};

const finalizeOwnedLoop = (
  repositoryPath: string,
  openingLease: LoopLease,
  inventory: RepositoryInventory,
  reason: string,
  awaitingUser: string[] | null
): LoopFinalizationResult => {
  let lease = reconcileAbsentRetainedWorktrees(openingLease, inventory);
  lease = reconcilePrimarySynchronization(lease, inventory);
  const openingVerification = verificationAgainst(lease, inventory);
  const automaticCleanup =
    lease.shipmentScopeRequired && !lease.shipmentScope
      ? { cleanup: emptyFinalizationCleanup(), lease }
      : automaticFinalizationCleanup(lease, inventory, openingVerification);
  ({ lease } = automaticCleanup);
  const finalInventory = captureInventory(repositoryPath);
  const { blockers, verification, receipt } = finalizationDecision(
    lease,
    finalInventory,
    automaticCleanup.cleanup,
    reason,
    awaitingUser
  );
  const now = receipt.finalizedAt;
  if (blockers.length === 0 && receipt.deliveryStatus === "verified") {
    releaseDeliveredSourceClaims(
      lease,
      finalInventory,
      automaticCleanup.cleanup
    );
  }
  const receiptPath = resolve(
    recoveryHistoryDirectory(lease.commonGitDirectory, lease.runId),
    `finalization-${sha256Json(receipt)}.json`
  );
  writeImmutableRecoveryEvent(receiptPath, { lease, receipt });
  if (blockers.length === 0) {
    rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
    forgetLeaseSession(lease);
    removeControllerBinding(lease);
    return {
      blockers,
      cleanup: automaticCleanup.cleanup,
      lease: null,
      outcome: "completed",
      receipt,
      receiptPath,
      verification,
    };
  }
  const updated = relinquishController(lease, reason, now, awaitingUser);
  return {
    blockers,
    cleanup: automaticCleanup.cleanup,
    lease: updated,
    outcome: "relinquished",
    receipt,
    receiptPath,
    verification,
  };
};

// Cleanup may already have persisted removal or synchronization evidence.
// Release the latest state under both locks, never the opening snapshot, and
// keep the failure that stopped finalization visible: an unwritable lease is
// reported beside it, never instead of it.
const relinquishAfterFinalizationError = (
  lease: LoopLease,
  error: unknown,
  awaitingUser: string[] | null
): never => {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    const current = readLeaseFromCommonDirectory(lease.commonGitDirectory);
    if (current?.runId === lease.runId) {
      relinquishController(
        current,
        `Finalization failed: ${detail}`.slice(0, 500),
        new Date().toISOString(),
        awaitingUser
      );
    }
  } catch (relinquishError) {
    const relinquishDetail =
      relinquishError instanceof Error
        ? relinquishError.message
        : String(relinquishError);
    throw new Error(
      `Finalization failed: ${detail}. The controller could not be relinquished: ${relinquishDetail}`,
      { cause: relinquishError }
    );
  }
  throw error;
};

export interface LoopFinalizationOptions {
  /**
   * Decisions the controller is about to ask the user for. The run pauses:
   * it relinquishes even when nothing else blocks closure, records the
   * questions, and resumes with `loop start --mode resume` after the answer.
   */
  awaitingUser?: readonly string[];
}

const MAX_AWAITING_USER_QUESTIONS = 10;
const MAX_AWAITING_USER_QUESTION_LENGTH = 500;

const awaitingUserQuestions = (
  input: readonly string[] | undefined
): string[] | null => {
  if (!input || input.length === 0) {
    return null;
  }
  const questions = input.map((question) =>
    requiredText(question, "awaiting-user question")
  );
  if (
    questions.length > MAX_AWAITING_USER_QUESTIONS ||
    questions.some(
      (question) => question.length > MAX_AWAITING_USER_QUESTION_LENGTH
    )
  ) {
    throw new SimpleChangesError(
      `Record at most ${MAX_AWAITING_USER_QUESTIONS} awaiting-user questions of at most ${MAX_AWAITING_USER_QUESTION_LENGTH} characters each.`,
      EXIT_CODES.usage
    );
  }
  return questions;
};

export const finalizeLoop = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  reasonInput: string,
  options: LoopFinalizationOptions = {}
): LoopFinalizationResult => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const reason = requiredText(reasonInput, "finalization reason");
  const awaitingUser = awaitingUserQuestions(options.awaitingUser);
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop finalize",
    () =>
      withWorktreeCoordinationLock(
        opening.repository.commonGitDirectory,
        "loop finalize cleanup",
        () => {
          const inventory = captureInventory(repositoryPath);
          const lease = requireLease(inventory);
          assertMatchingRun(lease, runId);
          if (lease.ownerAgentId !== ownerAgentId) {
            throw new SimpleChangesError(
              `Only loop owner ${lease.ownerAgentId} may finalize this loop.`,
              EXIT_CODES.unsafe
            );
          }
          assertControllerActive(lease);
          const untouched = finalizeUnmutatedRun(
            lease,
            inventory,
            reason,
            awaitingUser
          );
          if (untouched) {
            return untouched;
          }
          try {
            return finalizeOwnedLoop(
              repositoryPath,
              lease,
              inventory,
              reason,
              awaitingUser
            );
          } catch (error) {
            return relinquishAfterFinalizationError(lease, error, awaitingUser);
          }
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
  changeDigest: string;
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
    typeof record.changeDigest === "string" &&
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
  if (validated.changeDigest !== current.changeDigest) {
    return {
      failure: `the equivalence receipt is stale: its recorded worktree digest ${validated.changeDigest} does not match the current digest ${current.changeDigest}`,
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

// Every scoped source worktree owes delivery proof, even one registered as
// preserved, so a frozen-scope close never treats scoped work as unrelated.
const closeEquivalentObligatedPaths = (lease: LoopLease): string[] => {
  const obligated = new Set<string>(
    lease.shipmentScope?.plan.units.map((unit) => unit.sourceWorktree) ?? []
  );
  for (const registered of lease.worktrees) {
    const eligible =
      registered.role === "controller" ||
      registered.role === "author" ||
      registered.createdByRun;
    if (eligible) {
      obligated.add(registered.path);
    }
  }
  for (const preparation of lease.preparations) {
    const path = existsSync(preparation.path)
      ? realpathSync(preparation.path)
      : preparation.path;
    obligated.add(path);
  }
  return [...obligated].sort((left, right) => left.localeCompare(right));
};

/**
 * An obligated worktree this run itself removed after an audited
 * `remove-after-audit` disposition is proven when its path is gone from disk
 * and the refreshed target still contains both the audited target and the
 * removed head. A patch-equivalent removal is not re-proven this way and
 * blocks the close.
 */
export const completedRemovalProofForPath = (
  lease: LoopLease,
  path: string,
  targetRevision: string,
  contains: (
    repositoryPath: string,
    targetRevision: string,
    revision: string
  ) => boolean = targetContainsRevision
): LoopCloseEquivalentWorktreeProof | null => {
  // lstat, not existsSync: a dangling symlink recreated at the path is present.
  if (lstatSync(path, { throwIfNoEntry: false })) {
    return null;
  }
  const disposition = (lease.dispositions ?? []).find(
    (item) =>
      item.path === path &&
      item.outcome === "remove-after-audit" &&
      item.status === "completed" &&
      item.targetRef === lease.targetRef &&
      contains(lease.primaryCheckout, targetRevision, item.targetRevision) &&
      contains(lease.primaryCheckout, targetRevision, item.headSha)
  );
  return disposition
    ? { headSha: disposition.headSha, method: "target-ancestry", path }
    : null;
};

const equivalenceReceiptsByPath = (
  evidence: readonly LoopEquivalenceEvidence[]
): Map<string, unknown> =>
  new Map(
    evidence.map((item) => [
      existsSync(item.worktreePath)
        ? realpathSync(item.worktreePath)
        : resolve(item.worktreePath),
      item.receipt,
    ])
  );

const proveNothingLeftToShip = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string,
  equivalenceEvidence: readonly LoopEquivalenceEvidence[]
): LoopCloseEquivalentWorktreeProof[] => {
  const schema = worktreeEquivalenceSchema();
  const receiptsByPath = equivalenceReceiptsByPath(equivalenceEvidence);
  const currentByPath = new Map(
    inventory.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const proofs: LoopCloseEquivalentWorktreeProof[] = [];
  const unproven: string[] = [];
  for (const path of closeEquivalentObligatedPaths(lease)) {
    const current = currentByPath.get(path);
    if (!current) {
      const removalProof = completedRemovalProofForPath(
        lease,
        path,
        targetRevision
      );
      if (removalProof) {
        proofs.push(removalProof);
        continue;
      }
      unproven.push(
        `${path}: the obligated worktree is missing and no exact absence/branch-containment recovery evidence exists`
      );
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

const assertTargetEquivalentRemoteReconciliation = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  targetRevision: string
): void => {
  if (!targetUsesGitLab(inventory)) {
    return;
  }
  const reconciliation = lease.remoteBranchReconciliation;
  if (
    !reconciliation?.finalInventoryComplete ||
    reconciliation.targetRevision !== targetRevision
  ) {
    throw new SimpleChangesError(
      `Cannot close ${lease.runId} as target-equivalent until a complete final GitLab branch/proposal reconciliation is recorded for ${targetRevision}. This recovery path cannot infer that no provider mutation occurred.`,
      EXIT_CODES.unsafe
    );
  }
};

/**
 * A frozen-scope close answers for its own shipment obligations, not for
 * unrelated preserved or retained work: an unclaimed, unpaused checkout outside
 * the obligations may go missing or change without blocking the close. The
 * primary checkout is never unrelated, because finalization and cleanup act on
 * it. Claim, authorization, and coordination violations still block, and
 * before the scope freezes every violation does.
 */
export const frozenRecoveryBlockingViolations = (
  lease: LoopLease,
  verification: LoopVerification
): LoopVerification["violations"] => {
  if (!effectiveShipmentScopeFrozenAt(lease)) {
    return verification.violations;
  }
  const obligated = new Set(closeEquivalentObligatedPaths(lease));
  return verification.violations.filter((violation) => {
    const registered = lease.worktrees.find(
      (item) => item.path === violation.path
    );
    return !(
      registered &&
      violation.path !== lease.primaryCheckout &&
      !obligated.has(violation.path) &&
      !registered.claimId &&
      !registered.pauseReceiptId &&
      ["preserved", "retained"].includes(registered.role) &&
      [
        "missing-preserved-worktree",
        "missing-retained-worktree",
        "preserved-worktree-changed",
      ].includes(violation.code)
    );
  });
};

const assertTargetEquivalentCleanupComplete = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  cleanupErrors: readonly string[]
): void => {
  const verification = verificationAgainst(lease, inventory);
  const blockers = frozenRecoveryBlockingViolations(lease, verification);
  if (blockers.length === 0 && cleanupErrors.length === 0) {
    return;
  }
  throw new SimpleChangesError(
    `Cannot close ${lease.runId} as target-equivalent because final verification or cleanup is incomplete: ${[
      ...blockers.map((item) => item.message),
      ...cleanupErrors,
    ].join("; ")}`,
    EXIT_CODES.unsafe
  );
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
  const opening = locateRepository(repositoryPath);
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
        lease = reconcilePrimarySynchronization(lease, inventory);
        const targetRevision = currentTargetRevision(lease);
        assertTargetEquivalentRemoteReconciliation(
          lease,
          inventory,
          targetRevision
        );
        const proofs = proveNothingLeftToShip(
          lease,
          inventory,
          targetRevision,
          equivalenceEvidence
        );
        const recordedAt = new Date().toISOString();
        const remoteReconciliationSkipped = targetUsesGitLab(inventory)
          ? "Remote reconciliation was completed and recorded before target-equivalent closure; no reconciliation gate was skipped."
          : "The target provider does not require GitLab branch/proposal reconciliation.";
        // Completion belongs in the immutable archive. A failed cleanup or
        // archive write must leave the active run resumable, without a terminal
        // outcome that would disable replan.
        const verification = verificationAgainst(lease, inventory);
        const automaticCleanup = automaticFinalizationCleanup(
          lease,
          inventory,
          verification
        );
        ({ lease } = automaticCleanup);
        assertTargetEquivalentCleanupComplete(
          lease,
          captureInventory(repositoryPath),
          automaticCleanup.cleanup.errors
        );
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

export interface StaleLeaseRecoveryReceipt {
  agentId: string;
  approvedBy: string;
  archivedAt: string;
  kind: "stale-lease-recovery";
  leaseDigest: string;
  liveness: {
    ageMs: number | null;
    lastUpdatedAt: string;
    ownerProcessProvable: false;
    state: "stale";
  };
  mode: LoopLease["mode"];
  ownerAgentId: string;
  preservedWorktreePaths: string[];
  reason: string;
  runId: string;
  schemaVersion: 1;
  staleAfterMs: number;
  targetRef: string;
  targetRevision: string;
}

const staleLeaseRecoveryPath = (
  commonGitDirectory: string,
  runId: string
): string =>
  resolve(
    recoveryHistoryDirectory(commonGitDirectory, runId),
    "stale-lease-recovery.json"
  );

export const staleLeaseArchivePath = (
  commonGitDirectory: string,
  runId: string
): string =>
  resolve(
    recoveryHistoryDirectory(commonGitDirectory, runId),
    "stale-lease-recovery-lease.json"
  );

/**
 * Clear a lease whose owner cannot be proven alive and whose heartbeat has
 * gone quiet past the staleness threshold, on explicit user authority. This
 * clears the bookkeeping record only: every worktree, branch, claim, and
 * durable receipt survives untouched, and the cleared lease is archived into
 * the run history the way other terminal records are. A lease that is still
 * live is refused; recovering it needs its owner, or an approved takeover.
 */
export const recoverStaleLoopLease = (
  repositoryPath: string,
  runIdInput: string,
  agentIdInput: string,
  approvedByInput: string,
  reasonInput: string
): StaleLeaseRecoveryReceipt => {
  const runId = requiredRunId(runIdInput);
  const agentId = requiredText(agentIdInput, "agent ID");
  const approvedBy = requiredText(approvedByInput, "approver");
  const reason = requiredText(reasonInput, "stale-lease recovery reason");
  const opening = locateRepository(repositoryPath);
  const { commonGitDirectory } = opening.repository;
  return withStateLock(commonGitDirectory, "loop recover stale lease", () => {
    const archivePath = staleLeaseRecoveryPath(commonGitDirectory, runId);
    const lease = readLeaseFromCommonDirectory(commonGitDirectory);
    if (!lease) {
      if (existsSync(archivePath)) {
        return readImmutableRecoveryEvent<StaleLeaseRecoveryReceipt>(
          archivePath
        );
      }
      throw new SimpleChangesError(
        `No Simple Changes loop lease exists to recover for ${runId}.`,
        EXIT_CODES.unsafe
      );
    }
    assertMatchingRun(lease, runId);
    const liveness = leaseLiveness(lease);
    if (liveness.state !== "stale") {
      throw new SimpleChangesError(
        `Loop ${runId} is ${liveness.state}, not stale: ${
          liveness.ownerProcessProvable
            ? `its owner process ${lease.ownerProcess?.pid} is still running`
            : `its last heartbeat ${liveness.lastUpdatedAt} is not older than ${LEASE_STALE_AFTER_MS} ms`
        }. Simple Changes never clears a lease whose owner may still be working. Next: finish the run as its controller, or run \`simple-changes loop takeover --run-id ${runId} --agent-id <you> --manifest-digest ${loopManifestDigest(lease)} --approved-by <user> --reason <why>\`.`,
        EXIT_CODES.unsafe
      );
    }
    const archivedAt = new Date().toISOString();
    const record: StaleLeaseRecoveryReceipt = {
      agentId,
      approvedBy,
      archivedAt,
      kind: "stale-lease-recovery",
      leaseDigest: loopManifestDigest(lease),
      liveness: {
        ageMs: liveness.ageMs,
        lastUpdatedAt: liveness.lastUpdatedAt,
        ownerProcessProvable: false,
        state: "stale",
      },
      mode: lease.mode,
      ownerAgentId: lease.ownerAgentId,
      preservedWorktreePaths: lease.worktrees
        .map((worktree) => worktree.path)
        .sort((left, right) => left.localeCompare(right)),
      reason,
      runId,
      schemaVersion: 1,
      staleAfterMs: LEASE_STALE_AFTER_MS,
      targetRef: lease.targetRef,
      targetRevision: lease.targetRevision,
    };
    const archived = writeImmutableRecoveryEvent(
      archivePath,
      validateSchema<StaleLeaseRecoveryReceipt>("stale-lease-recovery", record)
    );
    // The receipt keeps its established shape for older runtimes; the full
    // cleared lease and its controller binding go beside it, so the run's
    // scope, outcome, and paused questions survive recovery.
    writeImmutableRecoveryEvent(
      staleLeaseArchivePath(commonGitDirectory, runId),
      {
        controllerBinding: readControllerBinding(lease),
        lease,
        ownerSessionEnded: liveness.ownerSessionEnded,
      }
    );
    rmSync(loopLeasePath(commonGitDirectory), { force: true });
    forgetLeaseSession(lease);
    removeControllerBinding(lease);
    return archived;
  });
};

export interface LoopEndResult extends LoopVerification {
  closedWithoutMutation?: LoopUnmutatedClose;
}

export const endLoop = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string,
  reasonInput: string | null = null
): LoopEndResult => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const reason = reasonInput?.trim() || null;
  const opening = locateRepository(repositoryPath);
  // Completion rechecks preserved-source claims, so it holds the coordination
  // lock as finalization does.
  return withStateLock(opening.repository.commonGitDirectory, "loop end", () =>
    withWorktreeCoordinationLock(
      opening.repository.commonGitDirectory,
      "loop end",
      () => {
        const { inventory, lease } = requireOwnedLease(
          repositoryPath,
          runId,
          ownerAgentId,
          "end this loop"
        );
        assertControllerActive(lease);
        const verification = verificationAgainst(lease, inventory);
        // A Ship run that never changed anything owes no shipment scope, remote
        // reconciliation, or cleanup; those gates protect integrated work.
        if (unmutatedCloseReady(lease, inventory, verification)) {
          return {
            ...verification,
            closedWithoutMutation: closeUnmutatedRun(
              lease,
              verification,
              reason,
              "loop end"
            ),
          };
        }
        const blockers = loopCompletionBlockers(lease, inventory, verification);
        if (blockers.length > 0) {
          throw new SimpleChangesError(blockers.join(" "), EXIT_CODES.unsafe);
        }
        rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
        return verification;
      }
    )
  );
};

export interface LoopGuidance {
  headline: string;
  nextCommands: string[];
}

const violationGuidanceCommands = (
  lease: LoopLease,
  violations: readonly LoopViolation[]
): string[] => {
  const commands: string[] = [];
  const add = (command: string): void => {
    if (!commands.includes(command)) {
      commands.push(command);
    }
  };
  const codes = new Set(violations.map((violation) => violation.code));
  if (codes.has("unregistered-worktree")) {
    add(
      `simple-changes loop rebaseline --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --approved-by <user> --reason <why>`
    );
  }
  // An override cannot resolve a path whose coordination link is stale; its
  // printed claim, pause, and accept steps below do.
  const stalePaths = new Set(
    violations
      .filter((violation) => violation.code === "coordination-claim-stale")
      .map((violation) => violation.path)
  );
  for (const violation of violations) {
    if (
      violation.code === "preserved-worktree-changed" &&
      !stalePaths.has(violation.path)
    ) {
      add(
        `simple-changes loop allow --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --worktree ${violation.path} --status-digest ${violation.changeDigest ?? "<digest>"} --approved-by <user> --reason <why>`
      );
    }
  }
  if (codes.has("missing-preserved-worktree")) {
    add(
      `simple-changes loop retire-absent-worktree --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --worktree <path> --approved-by <user> --reason <why>`
    );
  }
  if (
    codes.has("missing-preserved-worktree") ||
    codes.has("missing-retained-worktree")
  ) {
    add(
      `simple-changes loop dispose-worktree --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --worktree <path> --status-digest <digest> --approved-by <user> --reason <why>`
    );
  }
  if (codes.has("incomplete-worktree-preparation")) {
    add(
      `simple-changes prepare-agent --run-id ${lease.runId} --agent-id <agent> --purpose <purpose>`
    );
  }
  if (codes.has("retained-worktree-changed")) {
    add(
      `Ask the exact worktree owner to claim it as an active concurrent author or pause it at a stable boundary, then re-run \`simple-changes loop verify --run-id ${lease.runId}\`.`
    );
  }
  // Keep every step: two checkouts each need their own accepted receipt.
  commands.push(...staleClaimRecoveryCommands(violations));
  if (
    codes.has("remote-destination-changed") ||
    codes.has("remote-destination-rebind-required")
  ) {
    add(
      "Restore the exact recorded Git remote destinations, or relinquish this controller and start a current one."
    );
  }
  if (codes.has("common-git-directory-mismatch")) {
    add(
      "Re-run this command from a checkout of the repository that owns the active loop."
    );
  }
  return commands;
};

interface LoopGuidanceContext {
  // Why this run's first shipment scope can no longer be recorded, whatever
  // plan is offered; null when it still can, or when no first scope is owed.
  firstScopeFailure: string | null;
  liveness: LeaseLiveness | null;
  unmutatedCloseAvailable: boolean;
}

const archiveRecordedCommand = (
  lease: LoopLease,
  manifestDigest: string,
  statusDigest: string
): string =>
  `simple-changes loop archive-recorded --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --manifest-digest ${manifestDigest} --status-digest ${statusDigest} --approved-by <user> --reason <why>`;

// A recorded outcome disables `loop replan`; name the approved archival that
// remains for a released run, paused or not, that can no longer finish.
const withArchiveRecordedGuidance = (
  lease: LoopLease,
  guidance: LoopGuidance
): LoopGuidance =>
  lease.shipmentOutcome && effectiveShipmentScopeFrozenAt(lease)
    ? {
        headline: `${guidance.headline} It already recorded a shipment outcome, so \`loop replan\` cannot archive it; if it can no longer finish, its owner may archive it with explicit user approval through \`loop replan-status\` and \`loop archive-recorded\`, which never counts as delivery.`,
        nextCommands: [
          ...guidance.nextCommands,
          "simple-changes loop replan-status --json",
          archiveRecordedCommand(lease, "<digest>", "<digest>"),
        ],
      }
    : guidance;

const relinquishedGuidance = (lease: LoopLease): LoopGuidance =>
  withArchiveRecordedGuidance(lease, {
    headline: `Loop ${lease.runId} has released its controller. Resume it to finish its recorded work; takeover approval is unnecessary. Its existing scope and safety checks still apply.`,
    nextCommands: [
      "simple-changes loop start --mode resume --agent-id <you>",
      `simple-changes loop close-equivalent --run-id ${lease.runId} --agent-id <you> --approved-by <user> --reason <why>`,
    ],
  });

const loopGuidanceFor = (
  lease: LoopLease | null,
  verification: LoopVerification,
  {
    firstScopeFailure,
    liveness,
    unmutatedCloseAvailable,
  }: LoopGuidanceContext = {
    firstScopeFailure: null,
    liveness: null,
    unmutatedCloseAvailable: false,
  }
): LoopGuidance => {
  if (!lease) {
    return {
      headline: "No active integration loop.",
      nextCommands: ["simple-changes loop start --mode MODE --agent-id <you>"],
    };
  }
  const lifecycle = controllerLifecycle(lease);
  const awaitingUser =
    lifecycle.status === "relinquished"
      ? readControllerBinding(lease)?.awaitingUser
      : null;
  if (awaitingUser) {
    return withArchiveRecordedGuidance(lease, {
      headline: `Loop ${lease.runId} is paused waiting on the user: ${awaitingUser.questions.join(" | ")}. Once they answer, resume it; takeover approval is unnecessary, and its existing scope and safety checks still apply.`,
      nextCommands: [
        "simple-changes loop start --mode resume --agent-id <you>",
        `simple-changes loop close-equivalent --run-id ${lease.runId} --agent-id <you> --approved-by <user> --reason <why>`,
      ],
    });
  }
  if (lifecycle.status === "relinquished") {
    return relinquishedGuidance(lease);
  }
  if (liveness?.state === "stale") {
    return {
      headline: `Loop ${lease.runId} is stale: ${
        liveness.ownerSessionEnded
          ? `the harness session of its owner ${lease.ownerAgentId} has exited`
          : `its owner ${lease.ownerAgentId} cannot be proven alive`
      } and it last recorded activity at ${liveness.lastUpdatedAt}. Clearing the lease with user approval keeps every worktree and receipt.`,
      nextCommands: [
        staleLeaseRecoveryCommand(lease),
        `simple-changes loop takeover --run-id ${lease.runId} --agent-id <you> --manifest-digest ${loopManifestDigest(lease)} --approved-by <user> --reason <why>`,
      ],
    };
  }
  // Scope guidance follows record-scope's own invariants rather than the
  // whole-repository digest, so an untouched run whose scope can still be
  // recorded is told to record it, not to end.
  const endCommand = `simple-changes loop end --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>`;
  const startCommand = `simple-changes loop start --mode ${lease.mode} --agent-id ${lease.ownerAgentId}`;
  if (unmutatedCloseAvailable && firstScopeFailure) {
    return {
      headline: `Loop ${lease.runId} has not changed anything, but its shipment scope can no longer be recorded. ${firstScopeFailure} Close this untouched run with \`loop end\`; a fresh \`loop start\` then takes a new baseline.`,
      nextCommands: [endCommand, startCommand],
    };
  }
  if (firstScopeFailure && lease.firstMutationAt !== null) {
    return {
      headline: `Loop ${lease.runId} can no longer record its first shipment scope. ${firstScopeFailure} It has already recorded mutation evidence, so \`loop end\` cannot close it: finalize it, which relinquishes its controller, then replan it with explicit approval.`,
      nextCommands: [
        `simple-changes loop finalize --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>`,
        "simple-changes loop replan-status --json",
        `simple-changes loop replan --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --manifest-digest <digest> --status-digest <digest> --approved-by <user> --reason <why>`,
      ],
    };
  }
  if (!verification.ok) {
    const nextCommands = violationGuidanceCommands(
      lease,
      verification.violations
    );
    if (unmutatedCloseAvailable) {
      return {
        headline: `Verification for ${lease.runId} is failing with ${verification.violations.length} violation(s); resolve each violation before recording scope or guarded mutations. This run has not changed anything yet, so \`loop end\` can instead close it for a fresh \`loop start\`.`,
        nextCommands: [...nextCommands, endCommand],
      };
    }
    return {
      headline: `Verification for ${lease.runId} is failing with ${verification.violations.length} violation(s); resolve each violation before guarded mutations.`,
      nextCommands,
    };
  }
  if (lease.shipmentScopeRequired && !lease.shipmentScope) {
    return {
      headline: `Loop ${lease.runId} is healthy but has no recorded shipment scope; record it before shared integration or worktree mutations. Record-scope accepts unrelated changes made since loop start, such as claimed authors' edits and commits, other branches, and stashes. It still refuses when the target moved; policy, capabilities, or remote bindings changed; verification fails; or the controller checkout or a scoped source worktree changed since loop start.`,
      nextCommands: [
        `simple-changes loop record-scope --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --receipt <file>`,
      ],
    };
  }
  if (!lease.shipmentOutcome) {
    return {
      headline: `Loop ${lease.runId} is healthy; continue the shipment, then record its outcome before finalizing.`,
      nextCommands: [
        `simple-changes loop record-outcome --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --receipt <file>`,
        `simple-changes loop finalize --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>`,
      ],
    };
  }
  return {
    headline: `Loop ${lease.runId} has a recorded shipment outcome; finalize to run automatic cleanup and close.`,
    nextCommands: [
      `simple-changes loop finalize --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>`,
    ],
  };
};

export const loopStatus = (
  repositoryPath: string
): {
  guidance: LoopGuidance;
  lease: LoopLease | null;
  liveness: LeaseLiveness | null;
  verification: LoopVerification;
} => {
  const inventory = captureInventory(repositoryPath);
  const storedLease = readLeaseFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  let lease = storedLease;
  if (storedLease && controllerLifecycle(storedLease).status === "active") {
    lease = withConcurrentAuthorAdmissions(storedLease, inventory);
  }
  const verification = lease
    ? verificationAgainst(lease, inventory)
    : emptyVerification(inventory);
  const liveness = storedLease ? leaseLiveness(storedLease) : null;
  return {
    guidance: loopGuidanceFor(lease, verification, {
      // The target binding is resolved from the current checkout's branch,
      // so the scope invariants are judged only from the controller checkout,
      // where record-scope itself must run.
      firstScopeFailure:
        lease &&
        owesFirstScope(lease) &&
        registeredController(lease)?.path ===
          inventory.repository.currentCheckout
          ? openingScopeFailure(lease, inventory)
          : null,
      liveness,
      unmutatedCloseAvailable: lease
        ? unmutatedCloseReady(lease, inventory, verification)
        : false,
    }),
    lease,
    liveness,
    verification,
  };
};

// Liveness fields are deliberately excluded: a heartbeat must never invalidate
// a manifest digest that takeover and finalization compare against. The first
// mutation timestamp is excluded for the same reason: `loop guard` and
// `loop exec` stamp it on their heartbeat write and never changed the manifest.
export const loopManifestDigest = (lease: LoopLease): string => {
  const {
    firstMutationAt: _firstMutationAt,
    ownerProcess: _ownerProcess,
    updatedAt: _updatedAt,
    ...manifest
  } = lease;
  return sha256(JSON.stringify(manifest));
};

const requireReplanLease = (inventory: RepositoryInventory): LoopLease => {
  const common = inventory.repository.commonGitDirectory;
  const lease = readLeaseFromCommonDirectory(common);
  if (!lease || lease.commonGitDirectory !== common) {
    throw new SimpleChangesError(
      "Replan requires the active lease of this exact repository.",
      EXIT_CODES.unsafe
    );
  }
  // Do not virtually admit concurrent authors: approval and archive must bind
  // the stored manifest, while observation separately includes current claims.
  return lease;
};

export interface LoopReplanRequest {
  agentId: string;
  approvedBy: string;
  /**
   * Set only by `loop archive-recorded`: archive a frozen run that already
   * recorded a shipment outcome but cannot finish. Its record keeps the
   * `loop-archive-recorded` kind and `archived-unfinished` outcome.
   */
  archiveRecordedOutcome?: true;
  manifestDigest: string;
  reason: string;
  runId: string;
  statusDigest: string;
}

interface LoopReplanRecord {
  archivedAt: string;
  fullLeaseDigest: string;
  kind: "loop-replan" | "loop-archive-recorded";
  lease: LoopLease;
  observation: ReturnType<typeof replanObservation>;
  outcome: "replanned" | "archived-unfinished";
  request: LoopReplanRequest;
  schemaVersion: 1;
}

const replanObservation = (
  lease: LoopLease,
  inventory: RepositoryInventory
) => ({
  coordination: readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  ),
  inventoryDigest: inventory.baselineDigest,
  targetRevision: currentTargetRevision(lease),
});

// Observe from the same checkout used for execution. Inventory digests include
// checkout identity, while coordination and the current target bind shared state.
export const loopReplanStatus = (repositoryPath: string) => {
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop replan status",
    () =>
      withWorktreeCoordinationLock(
        opening.repository.commonGitDirectory,
        "loop replan status",
        () => {
          const inventory = captureInventory(repositoryPath);
          const lease = requireReplanLease(inventory);
          const observation = replanObservation(lease, inventory);
          const manifestDigest = loopManifestDigest(lease);
          const statusDigest = sha256Json(observation);
          // Only the next command differs: a recorded outcome refuses
          // `loop replan`, leaving the approved `loop archive-recorded`.
          return {
            agentId: lease.ownerAgentId,
            manifestDigest,
            nextCommand: lease.shipmentOutcome
              ? archiveRecordedCommand(lease, manifestDigest, statusDigest)
              : `simple-changes loop replan --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --manifest-digest ${manifestDigest} --status-digest ${statusDigest} --approved-by <user> --reason <why>`,
            observation,
            runId: lease.runId,
            statusDigest,
          };
        }
      )
  );
};

const syncReplanPath = (path: string): void => {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

// Publish without replacing an existing audit record. A partial temporary write
// is never considered an intent; retries validate every field of a published one.
const publishReplanIntent = (path: string, record: LoopReplanRecord): void => {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  // Persist each new history ancestor before an intent can authorize removal
  // of the active directory entry, including on filesystems with delayed metadata.
  let ancestor = dirname(path);
  while (ancestor !== record.lease.commonGitDirectory) {
    syncReplanPath(ancestor);
    ancestor = dirname(ancestor);
  }
  syncReplanPath(ancestor);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
    syncReplanPath(dirname(path));
  } finally {
    rmSync(temporary);
  }
};

const replanPathExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const readReplanLeaseBytes = (path: string): string => {
  // Validate the inode before reading. In particular, do not follow a dangling
  // symlink or block opening a FIFO supplied in place of an audit record.
  if (!lstatSync(path).isFile()) {
    throw new SimpleChangesError(
      "Replan lease must be a regular file.",
      EXIT_CODES.unsafe
    );
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are a bitmask.
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new SimpleChangesError(
        "Replan lease must be a regular file.",
        EXIT_CODES.unsafe
      );
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
};

/**
 * Validates a lease stored in a replan or archive-recorded record. Leases
 * started by an earlier repository fork carry `openingScopeInvariantDigest`,
 * which this runtime never writes; it is ignored for validation but kept for
 * the manifest digest the record's approval bound.
 */
const archivedReplanLease = (value: LoopLease): LoopLease => {
  const { openingScopeInvariantDigest: _legacy, ...lease } =
    value as LoopLease & {
      openingScopeInvariantDigest?: unknown;
    };
  validateSchema<LoopLease>("loop-lease", lease);
  return value;
};

const assertReplanRecord = (
  record: LoopReplanRecord,
  request: LoopReplanRequest
): void => {
  validateSchemaDocument(
    "loop-replan",
    {
      additionalProperties: false,
      properties: {
        archivedAt: { format: "date-time", type: "string" },
        fullLeaseDigest: { pattern: "^[0-9a-f]{64}$", type: "string" },
        kind: {
          const: request.archiveRecordedOutcome
            ? "loop-archive-recorded"
            : "loop-replan",
        },
        lease: { type: "object" },
        observation: {
          additionalProperties: false,
          properties: {
            coordination: { type: "object" },
            inventoryDigest: { pattern: "^[0-9a-f]{64}$", type: "string" },
            targetRevision: { minLength: 1, type: "string" },
          },
          required: ["coordination", "inventoryDigest", "targetRevision"],
          type: "object",
        },
        outcome: {
          const: request.archiveRecordedOutcome
            ? "archived-unfinished"
            : "replanned",
        },
        request: {
          additionalProperties: false,
          properties: Object.fromEntries(
            Object.keys(request).map((key) => [
              key,
              { const: request[key as keyof LoopReplanRequest] },
            ])
          ),
          required: [
            "agentId",
            "approvedBy",
            "manifestDigest",
            "reason",
            "runId",
            "statusDigest",
          ],
          type: "object",
        },
        schemaVersion: { const: 1 },
      },
      required: [
        "archivedAt",
        "fullLeaseDigest",
        "kind",
        "lease",
        "observation",
        "outcome",
        "request",
        "schemaVersion",
      ],
      type: "object",
    },
    record
  );
  const lease = archivedReplanLease(record.lease);
  if (
    record.schemaVersion !== 1 ||
    record.kind !==
      (request.archiveRecordedOutcome
        ? "loop-archive-recorded"
        : "loop-replan") ||
    record.outcome !==
      (request.archiveRecordedOutcome ? "archived-unfinished" : "replanned") ||
    typeof record.archivedAt !== "string" ||
    !DIGEST_PATTERN.test(record.fullLeaseDigest) ||
    JSON.stringify(record.request) !== JSON.stringify(request) ||
    lease.runId !== request.runId ||
    lease.ownerAgentId !== request.agentId ||
    loopManifestDigest(lease) !== request.manifestDigest ||
    sha256Json(record.observation) !== request.statusDigest
  ) {
    throw new SimpleChangesError(
      "Replan archive does not match the exact approved request.",
      EXIT_CODES.unsafe
    );
  }
};

/**
 * `loop archive-recorded` archives a run whose recorded shipment outcome can no
 * longer finish. It proves only that the recorded receipt is intact and still
 * describes history the current target contains; it never claims delivery.
 */
const assertArchivableRecordedOutcome = (lease: LoopLease): void => {
  const outcome = lease.shipmentOutcome;
  if (!outcome) {
    throw new SimpleChangesError(
      "Recorded-outcome archival requires a historical receipt.",
      EXIT_CODES.unsafe
    );
  }
  const target = currentTargetRevision(lease);
  const receipt = validateSchema<ShipmentOutcomeReceipt>(
    "shipment-outcome",
    outcome.receipt
  );
  const paths = [
    ...receipt.units.flatMap((unit) => [
      ...unit.finalPaths,
      ...unit.originalPaths,
    ]),
    ...receipt.additionalPaths,
  ];
  if (
    receipt.runId !== lease.runId ||
    // The recorded digest covers any preserved-source overrides beside the
    // lease, so a tampered or missing sidecar refuses archival.
    !recordedOutcomeIntact(lease) ||
    paths.length === 0 ||
    !target ||
    !targetContainsRevision(
      lease.primaryCheckout,
      target,
      receipt.targetRevision
    ) ||
    paths.some(
      (item) =>
        targetTreeEntry(
          lease.primaryCheckout,
          receipt.targetRevision,
          item.path
        ) !== item.entry
    )
  ) {
    throw new SimpleChangesError(
      "Recorded-outcome archival requires an intact historical receipt and tree contained in the current target.",
      EXIT_CODES.unsafe
    );
  }
};

const createReplanIntent = (
  repositoryPath: string,
  request: LoopReplanRequest,
  activePath: string,
  intentPath: string
): LoopReplanRecord => {
  const inventory = captureInventory(repositoryPath);
  const lease = requireReplanLease(inventory);
  assertMatchingRun(lease, request.runId);
  if (
    lease.ownerAgentId !== request.agentId ||
    !effectiveShipmentScopeFrozenAt(lease) ||
    (!request.archiveRecordedOutcome && lease.shipmentOutcome) ||
    lease.closeEquivalentOutcome ||
    lease.emergencyShipping ||
    verificationAgainst(lease, inventory).violations.some(
      (violation) => violation.code === "incomplete-worktree-preparation"
    )
  ) {
    throw new SimpleChangesError(
      "Replan requires the frozen loop's exact owner, no terminal outcome, and complete preparations.",
      EXIT_CODES.unsafe
    );
  }
  if (request.archiveRecordedOutcome) {
    assertArchivableRecordedOutcome(lease);
  }
  const observation = replanObservation(lease, inventory);
  if (
    loopManifestDigest(lease) !== request.manifestDigest ||
    sha256Json(observation) !== request.statusDigest
  ) {
    throw new SimpleChangesError(
      "Replan manifest or current inventory/coordination/target digest changed.",
      EXIT_CODES.unsafe
    );
  }
  const bytes = readReplanLeaseBytes(activePath);
  if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(lease)) {
    throw new SimpleChangesError(
      "Active lease changed during replan.",
      EXIT_CODES.unsafe
    );
  }
  const record: LoopReplanRecord = {
    archivedAt: new Date().toISOString(),
    fullLeaseDigest: sha256(bytes),
    kind: request.archiveRecordedOutcome
      ? "loop-archive-recorded"
      : "loop-replan",
    lease,
    observation,
    outcome: request.archiveRecordedOutcome
      ? "archived-unfinished"
      : "replanned",
    request,
    schemaVersion: 1,
  };
  publishReplanIntent(intentPath, record);
  return record;
};

const replanLeaseMatches = (bytes: string, record: LoopReplanRecord): boolean =>
  sha256(bytes) === record.fullLeaseDigest &&
  JSON.stringify(JSON.parse(bytes)) === JSON.stringify(record.lease);

// The transition of a pending replan or archival: the active lease must still
// be the recorded bytes and inventory, and an archival re-proves its recorded
// outcome, first attempt or retry after a crash, so a sidecar edited or lost
// after the intent refuses.
const archivePendingReplan = (
  repositoryPath: string,
  request: LoopReplanRequest,
  record: LoopReplanRecord,
  activePath: string,
  archivePath: string
): void => {
  const bytes = readReplanLeaseBytes(activePath);
  const inventory = captureInventory(repositoryPath);
  if (
    !replanLeaseMatches(bytes, record) ||
    sha256Json(replanObservation(record.lease, inventory)) !==
      request.statusDigest
  ) {
    throw new SimpleChangesError(
      "Replan intent no longer matches the active lease or exact inventory.",
      EXIT_CODES.unsafe
    );
  }
  if (request.archiveRecordedOutcome) {
    assertArchivableRecordedOutcome(record.lease);
  }
  // Both directories are within the same common Git directory. This atomic
  // rename is the transition: every original byte is preserved, and a crash
  // cannot leave an unarchived cleared lease. No Git or claim cleanup occurs.
  renameSync(activePath, archivePath);
  syncReplanPath(archivePath);
  syncReplanPath(dirname(archivePath));
  syncReplanPath(dirname(activePath));
};

export const replanLoop = (
  repositoryPath: string,
  input: LoopReplanRequest
): LoopReplanRecord => {
  // Key order is part of the stored record: retries compare the request by its
  // serialized bytes, so archive-recorded records written by earlier forks
  // must keep `archiveRecordedOutcome` first.
  const request: LoopReplanRequest = {
    ...(input.archiveRecordedOutcome
      ? { archiveRecordedOutcome: true as const }
      : {}),
    agentId: requiredText(input.agentId, "agent ID"),
    approvedBy: requiredText(input.approvedBy, "approver"),
    manifestDigest: requiredText(input.manifestDigest, "manifest digest"),
    reason: requiredText(input.reason, "replan reason"),
    runId: requiredRunId(input.runId),
    statusDigest: requiredText(input.statusDigest, "status digest"),
  };
  if (
    !(
      DIGEST_PATTERN.test(request.manifestDigest) &&
      DIGEST_PATTERN.test(request.statusDigest)
    )
  ) {
    throw new SimpleChangesError(
      "Replan requires exact SHA256 digests.",
      EXIT_CODES.usage
    );
  }
  const opening = locateRepository(repositoryPath);
  const common = opening.repository.commonGitDirectory;
  const attempt = `${request.archiveRecordedOutcome ? "archive-recorded" : "replan"}-${sha256Json(request)}`;
  return withStateLock(common, "loop replan", () =>
    withWorktreeCoordinationLock(common, "loop replan", () => {
      const directory = assertNoSymlinkAncestors(
        common,
        join(
          STATE_DIRECTORY,
          RECOVERY_HISTORY_DIRECTORY,
          request.runId,
          attempt
        )
      );
      const intentPath = join(directory, "replan.json");
      const archivePath = join(directory, "replan-lease.json");
      const activePath = loopLeasePath(common);
      let record: LoopReplanRecord;
      if (replanPathExists(intentPath)) {
        record = JSON.parse(
          readReplanLeaseBytes(intentPath)
        ) as LoopReplanRecord;
        assertReplanRecord(record, request);
        if (record.lease.commonGitDirectory !== common) {
          throw new SimpleChangesError(
            "Replan archive belongs to another repository.",
            EXIT_CODES.unsafe
          );
        }
      } else {
        if (replanPathExists(archivePath)) {
          throw new SimpleChangesError(
            "Replan lease archive has no matching intent.",
            EXIT_CODES.unsafe
          );
        }
        record = createReplanIntent(
          repositoryPath,
          request,
          activePath,
          intentPath
        );
      }
      if (replanPathExists(archivePath)) {
        const bytes = readReplanLeaseBytes(archivePath);
        if (!replanLeaseMatches(bytes, record)) {
          throw new SimpleChangesError(
            "Replan archived lease integrity check failed.",
            EXIT_CODES.unsafe
          );
        }
        // A completed retry must never remove a successor, even with the same actor.
        return record;
      }
      archivePendingReplan(
        repositoryPath,
        request,
        record,
        activePath,
        archivePath
      );
      return record;
    })
  );
};
