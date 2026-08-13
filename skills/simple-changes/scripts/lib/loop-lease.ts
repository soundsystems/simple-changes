import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  decideEmergencyShipping,
  deriveEmergencyShippingStatus,
} from "./emergency-shipping.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { captureInventory } from "./inventory.ts";
import {
  type CommandProcess,
  type CommandResult,
  GuardedProcessGroupStillAliveError,
  runCommandInProcessGroup,
  runGit,
} from "./process.ts";
import { validateRemoteBranchReconciliation } from "./remote-branch-reconciliation.ts";
import { validateSchema } from "./schema.ts";
import type {
  EmergencyShippingLedgerEntry,
  LoopControllerLifecycle,
  LoopLease,
  LoopOverride,
  LoopVerification,
  LoopViolation,
  LoopWorktreeDisposition,
  LoopWorktreeLease,
  LoopWorktreePreparation,
  RemoteBranchReconciliationReceipt,
  RepositoryInventory,
  RequestMode,
  WorktreeClaim,
  WorktreeCoordinationDocument,
  WorktreeInventory,
} from "./types.ts";
import {
  coordinationEvidence,
  coordinationLinkIsCurrent,
  markCoordinationAdopted,
  markCoordinationResumeReady,
  readCoordinationDocumentFromCommonDirectory,
} from "./worktree-coordination.ts";

const STATE_DIRECTORY = "simple-changes";
const STATE_FILENAME = "active-loop.json";
const LOCK_DIRECTORY = "active-loop.lock";
const LOCK_OWNER_FILENAME = "owner.json";
const STALE_LOCK_MINIMUM_AGE_MS = 5000;
const RUN_ID_PATTERN = /^run-[a-z0-9-]+$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SCP_REMOTE_URL_PATTERN = /^[^@/\s]+@([^:/\s]+):(.+)$/u;
const REMOTE_PROJECT_PATH_PATTERN = /^\/+|\.git\/?$/gu;
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

const stateDirectory = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY);

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
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
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

const assertControllerActive = (lease: LoopLease): void => {
  if (controllerLifecycle(lease).status === "relinquished") {
    throw new SimpleChangesError(
      `Integration-controller loop ${lease.runId} was relinquished by ${lease.ownerAgentId}; resume it with a new controller before mutating it.`,
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
    ownerAgentId: nextAgentId,
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
      `Cannot recover a lock younger than ${STALE_LOCK_MINIMUM_AGE_MS}ms.`,
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
  const recoveryPath = `${lockPath}.recovery-${randomUUID()}`;
  renameSync(lockPath, recoveryPath);
  rmSync(recoveryPath, { force: true, recursive: true });
  return {
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
      disposition.targetRevision === lease.targetRevision
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
      disposition.targetRevision === lease.targetRevision
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

const detectsGitLab = (inventory: RepositoryInventory): boolean =>
  inventory.capabilities.some(
    (capability) =>
      capability.category === "forge" && capability.provider === "gitlab"
  );

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

const currentTargetRevision = (lease: LoopLease): string =>
  runGit(lease.primaryCheckout, [
    "rev-parse",
    "--verify",
    `${lease.targetRef}^{commit}`,
  ]).stdout.trim();

const assertCurrentRemoteBranchReconciliation = (
  lease: LoopLease,
  inventory: RepositoryInventory
): void => {
  if (
    !(REMOTE_RECONCILIATION_MODES.has(lease.mode) && detectsGitLab(inventory))
  ) {
    return;
  }
  const receipt = lease.remoteBranchReconciliation;
  if (!receipt) {
    throw new SimpleChangesError(
      "Cannot end a GitLab integration loop before recording a complete remote-branch reconciliation receipt.",
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
  if (lease.concurrentWork !== "allow-claimed") {
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

const currentWorktreeViolations = (
  lease: LoopLease,
  worktree: WorktreeInventory,
  registered: LoopWorktreeLease | undefined,
  preparation: LoopWorktreePreparation | undefined,
  concurrentClaim: WorktreeClaim | undefined
): LoopViolation[] => {
  if (!registered) {
    if (
      preparation &&
      worktree.branch === preparation.branch &&
      worktree.headSha === preparation.baseRevision
    ) {
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
    if (registered.role === "retained" && !currentByPath.has(registered.path)) {
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

const assertAgentMutationAllowed = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  agentId: string
): void => {
  assertControllerActive(lease);
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

export const startLoop = (
  repositoryPath: string,
  agentIdInput: string,
  mode: RequestMode
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
        if (
          lifecycle.status === "relinquished" &&
          (mode === "resume" || mode === existing.mode)
        ) {
          return transferController(
            existing,
            inventory,
            agentId,
            "resume",
            lifecycle.reason ?? "Resumed relinquished integration loop.",
            null
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
        overrides: [],
        ownerAgentId: agentId,
        preparations: [],
        primaryCheckout: inventory.repository.primaryCheckout,
        runId: `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        schemaVersion: 1,
        targetRef: inventory.targetRef,
        targetRevision,
        updatedAt: now,
        worktrees,
      };
      return writeLease(lease);
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
          `${nextAgentId} already owns ${runId}; takeover requires a different controller.`,
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
  const targetRevision = runGit(lease.primaryCheckout, [
    "rev-parse",
    "--verify",
    `${lease.targetRevision}^{commit}`,
  ]).stdout.trim();
  if (targetRevision !== lease.targetRevision) {
    throw new SimpleChangesError(
      `Pinned target revision ${lease.targetRevision} no longer resolves exactly.`,
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
      const verification = verificationAgainst(candidate, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Override is exact but other loop violations remain: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
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
          worktree.role === "preserved"
      );
      if (!registered) {
        throw new SimpleChangesError(
          "loop accept-paused-change requires an opening preserved worktree.",
          EXIT_CODES.unsafe
        );
      }
      const candidate: LoopLease = {
        ...lease,
        updatedAt: new Date().toISOString(),
        worktrees: lease.worktrees.map((worktree) =>
          worktree.path === evidence.current.path
            ? {
                ...worktree,
                baselineChangeDigest: evidence.current.changeDigest,
                baselineHeadSha: evidence.current.headSha,
                branch: evidence.current.branch,
                claimId: evidence.claimId,
                coordinationState: "adopted-preserved" as const,
                mutationAllowed: false,
                pauseReceiptId: evidence.pauseReceiptId,
              }
            : worktree
        ),
      };
      const verification = verificationAgainst(candidate, inventory);
      if (!verification.ok) {
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
      const verification = verificationAgainst(lease, inventory);
      if (!verification.ok) {
        throw new SimpleChangesError(
          `Cannot record remote branch reconciliation with manifest violations: ${verification.violations
            .map((violation) => `${violation.code}:${violation.path}`)
            .join(", ")}`,
          EXIT_CODES.unsafe
        );
      }
      if (!(detectsGitLab(inventory) && receipt.provider === "gitlab")) {
        throw new SimpleChangesError(
          "Remote branch reconciliation provider must match a discovered GitLab remote.",
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

const loopCompletionBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification
): string[] => {
  const blockers: string[] = [];
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
  lease: LoopLease | null;
  outcome: "completed" | "relinquished";
  verification: LoopVerification;
}

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
      const verification = verificationAgainst(lease, inventory);
      const blockers = loopCompletionBlockers(lease, inventory, verification);
      if (blockers.length === 0) {
        rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
        return { blockers, lease: null, outcome: "completed", verification };
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
        updatedAt: now,
        worktrees: lease.worktrees.map((worktree) =>
          worktree.role === "controller"
            ? { ...worktree, mutationAllowed: false }
            : worktree
        ),
      });
      return {
        blockers,
        lease: updated,
        outcome: "relinquished",
        verification,
      };
    }
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
