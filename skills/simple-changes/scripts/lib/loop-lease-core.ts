import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  currentHarnessSession,
  forgetControllerSession,
  recordControllerSession,
} from "./harness-session.ts";
import { sha256, sha256Json } from "./hash.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import { assertNoSymlinkAncestors } from "./path-safety.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";
import type {
  LoopControllerBinding,
  LoopControllerLifecycle,
  LoopControllerSession,
  LoopLease,
  LoopOverride,
  LoopOwnerProcess,
  LoopWorktreeDisposition,
  LoopWorktreeLease,
  LoopWorktreeRetirement,
  RepositoryInventory,
  WorktreeClaim,
  WorktreeCoordinationDocument,
  WorktreeInventory,
} from "./types.ts";
import { readCoordinationDocumentFromCommonDirectory } from "./worktree-coordination.ts";

const STATE_DIRECTORY = "simple-changes";

const STATE_FILENAME = "active-loop.json";

const LOCK_DIRECTORY = "active-loop.lock";

const LOCK_OWNER_FILENAME = "owner.json";

const RECOVERY_HISTORY_DIRECTORY = "history";

const REMOTE_BRANCH_ANCESTRY_DIRECTORY = "remote-branch-ancestry";

const REMOTE_BRANCH_SUPERSESSION_DIRECTORY = "remote-branch-supersession";

const PRESERVED_SOURCE_OVERRIDE_DIRECTORY = "preserved-source-override";

const RUN_ID_PATTERN = /^run-[a-z0-9-]+$/u;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

const PERMISSION_DENIED_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

const SCP_REMOTE_URL_PATTERN = /^[^@/\s]+@([^:/\s]+):(.+)$/u;

const REMOTE_PROJECT_PATH_PATTERN = /^\/+|\.git\/?$/gu;

const REMOTE_RECONCILIATION_MODES = new Set<LoopLease["mode"]>([
  "integrate",
  "ship",
  "reconcile",
  "resume",
]);

const MISSING_OPENING_REMOTE_INVENTORY_BLOCKER =
  "Cannot end a legacy GitLab loop without its opening remote inventory; only approved post-cleanup recovery may close it. Next: run `simple-changes loop recover-post-cleanup` when cleanup is already complete, or `simple-changes loop close-equivalent` when the work is already contained in the target.";

const MISSING_REMOTE_RECONCILIATION_BLOCKER =
  "Cannot end a GitLab integration loop before recording a complete remote-branch reconciliation receipt.";

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

// Only another holder's lock is waited out: a permission or filesystem
// failure is reported at once, never retried.
const isStateLockBusy = (error: unknown): boolean =>
  error instanceof SimpleChangesError &&
  (error.cause as NodeJS.ErrnoException | undefined)?.code === "EEXIST";

/**
 * `withLoopStateLock` for a short operation that should wait out another
 * holder, such as a controller's `loop exec`, instead of failing at once: it
 * polls every `intervalMs` and reports the busy lock as `withLoopStateLock`
 * does only once `waitMs` has passed. `onWait` runs once, when the first
 * attempt finds the lock busy. The operation itself runs synchronously
 * under the lock, so it must re-read any state it decides on.
 */
export const withLoopStateLockWaiting = <T>(
  commonGitDirectory: string,
  operationName: string,
  operation: () => T,
  options: { intervalMs: number; onWait?: () => void; waitMs: number }
): Promise<T> => {
  const deadline = Date.now() + options.waitMs;
  let waiting = false;
  // Polls by recursion, as process-group waits do, one attempt at a time.
  const attempt = async (): Promise<T> => {
    let lock: StateLock;
    try {
      lock = acquireStateLock(commonGitDirectory, operationName);
    } catch (error) {
      const remaining = deadline - Date.now();
      if (!isStateLockBusy(error) || remaining <= 0) {
        throw error;
      }
      if (!waiting) {
        waiting = true;
        options.onWait?.();
      }
      await delay(Math.min(options.intervalMs, remaining));
      return attempt();
    }
    try {
      return operation();
    } finally {
      lock.release();
    }
  };
  return attempt();
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

export const controllerBindingPath = (commonGitDirectory: string): string =>
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

const staleLeaseRecoveryCommand = (lease: LoopLease): string =>
  `simple-changes loop recover --stale-lease --run-id ${lease.runId} --agent-id <you> --approved-by <user> --reason <why>`;

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

/**
 * The full refs a lease's short target name may mean, most specific first.
 * Git resolves a short name to a same-named tag before a branch, so reading
 * the target only through refs/remotes or refs/heads keeps a tag named
 * `main` or `origin/main` from standing in for it. A target under a bound
 * remote is that remote-tracking ref; a lease without bindings tries the
 * remote-tracking ref before the local branch.
 */
const targetFullRefs = (
  lease: Pick<LoopLease, "remoteBindings" | "targetRef">
): string[] => {
  const { targetRef } = lease;
  if (targetRef.startsWith("refs/")) {
    return [targetRef];
  }
  const bindings = lease.remoteBindings;
  if (bindings && bindings.length > 0) {
    return bindings.some((binding) => targetRef.startsWith(`${binding.name}/`))
      ? [`refs/remotes/${targetRef}`]
      : [`refs/heads/${targetRef}`];
  }
  return targetRef.includes("/")
    ? [`refs/remotes/${targetRef}`, `refs/heads/${targetRef}`]
    : [`refs/heads/${targetRef}`];
};

export const resolvedCurrentTargetRevision = (
  lease: LoopLease
): string | null => {
  for (const ref of targetFullRefs(lease)) {
    const result = runGit(
      lease.primaryCheckout,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      true
    );
    const revision = result.stdout.trim();
    if (result.exitCode === 0 && revision) {
      return revision;
    }
  }
  return null;
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

export const readLoopLease = (repositoryPath: string): LoopLease | null => {
  const inventory = locateRepository(repositoryPath);
  return readLeaseFromCommonDirectory(inventory.repository.commonGitDirectory);
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

export {
  assertControllerActive,
  assertMatchingRun,
  assertNewAuthorPreparationAllowed,
  assertShipmentScopeRecorded,
  concurrentClaimFor,
  controllerLifecycle,
  currentTargetRevision,
  DIGEST_PATTERN,
  effectiveShipmentScopeFrozenAt,
  forgetLeaseSession,
  gitLabProjectForTargetRef,
  MISSING_OPENING_REMOTE_INVENTORY_BLOCKER,
  MISSING_REMOTE_RECONCILIATION_BLOCKER,
  matchingOverride,
  matchingRemovalDisposition,
  nothingAtPath,
  ownerProcessEvidence,
  PRESERVED_SOURCE_OVERRIDE_DIRECTORY,
  processGroupIsAlive,
  processIsAlive,
  RECOVERY_HISTORY_DIRECTORY,
  REMOTE_BRANCH_ANCESTRY_DIRECTORY,
  REMOTE_BRANCH_SUPERSESSION_DIRECTORY,
  REMOTE_RECONCILIATION_MODES,
  readImmutableRecoveryEvent,
  readLockOwner,
  readReceiptSidecar,
  recoveryHistoryDirectory,
  recoveryHistoryPath,
  refreshControllerSession,
  removeControllerBinding,
  requiredRunId,
  requiredText,
  requireLease,
  requireOwnedLease,
  resolvePrimaryAndTargetBranches,
  retirementForRegistration,
  STATE_DIRECTORY,
  scopeInvariantDigest,
  staleLeaseRecoveryCommand,
  targetBranchForRef,
  targetUsesGitLab,
  transferController,
  withAsyncStateLock,
  withConcurrentAuthorAdmissions,
  withMutationEvidence,
  withStateLock,
  worktreeLease,
  writeControllerBinding,
  writeImmutableRecoveryEvent,
  writeLease,
  writeReceiptSidecar,
};
