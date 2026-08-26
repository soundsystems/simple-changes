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
import { dirname, resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256, sha256Json } from "./hash.ts";
import { captureInventory } from "./inventory.ts";
import { runGit } from "./process.ts";
import { redactSecrets } from "./redact.ts";
import { validateSchema } from "./schema.ts";
import type {
  LoopLease,
  WorktreeClaim,
  WorktreeClaimObservation,
  WorktreeClaimOwner,
  WorktreeCoordinationDocument,
  WorktreeCoordinationEvent,
  WorktreeCoordinationState,
  WorktreeInventory,
  WorktreePauseReceipt,
} from "./types.ts";

const STATE_DIRECTORY = "simple-changes";
const COORDINATION_DIRECTORY = "worktree-coordination";
const STATE_FILENAME = "state.json";
const TAKEOVERS_FILENAME = "takeovers.json";
const LOCK_DIRECTORY = "worktree-coordination.lock";
const LOCK_OWNER_FILENAME = "owner.json";
const ACTIVE_LOOP_FILENAME = "active-loop.json";
const ACTIVE_LOOP_LOCK_DIRECTORY = "active-loop.lock";
const STALE_LOCK_MINIMUM_AGE_MS = 5000;
const ADAPTER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RUN_ID_PATTERN = /^run-[a-z0-9-]+$/u;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const PERMISSION_DENIED_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
const LIVE_STATES = new Set<WorktreeCoordinationState>([
  "active",
  "pause-requested",
  "paused",
  "adopted-preserved",
  "detach-requested",
  "detached",
  "attached",
  "resume-ready",
  "blocked",
]);

const stateRoot = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY);
const coordinationRoot = (commonGitDirectory: string): string =>
  resolve(stateRoot(commonGitDirectory), COORDINATION_DIRECTORY);
export const worktreeCoordinationPath = (commonGitDirectory: string): string =>
  resolve(coordinationRoot(commonGitDirectory), STATE_FILENAME);
export const worktreeTakeoversPath = (commonGitDirectory: string): string =>
  resolve(coordinationRoot(commonGitDirectory), TAKEOVERS_FILENAME);
const coordinationLockPath = (commonGitDirectory: string): string =>
  resolve(stateRoot(commonGitDirectory), LOCK_DIRECTORY);
const activeLoopLockPath = (commonGitDirectory: string): string =>
  resolve(stateRoot(commonGitDirectory), ACTIVE_LOOP_LOCK_DIRECTORY);

const requiredText = (
  value: string,
  name: string,
  maximumLength = 500
): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SimpleChangesError(`${name} is required.`, EXIT_CODES.usage);
  }
  if (trimmed.length > maximumLength) {
    throw new SimpleChangesError(
      `${name} must be at most ${maximumLength} characters.`,
      EXIT_CODES.usage
    );
  }
  if (redactSecrets(trimmed) !== trimmed) {
    throw new SimpleChangesError(
      `${name} must not contain credentials or secrets.`,
      EXIT_CODES.unsafe
    );
  }
  return trimmed;
};

const canonicalCandidate = (path: string): string =>
  existsSync(path) ? realpathSync(path) : resolve(path);

const repositoryIdFor = (commonGitDirectory: string): string =>
  sha256(commonGitDirectory);

interface CoordinationLockOwner {
  createdAt: string;
  hostname: string;
  operation: string;
  pid: number;
  token: string;
}

const permissionDeniedLockError = (
  label: string,
  lockPath: string,
  error: unknown
): SimpleChangesError | null => {
  const { code } = error as NodeJS.ErrnoException;
  if (!(code && PERMISSION_DENIED_CODES.has(code))) {
    return null;
  }
  return SimpleChangesError.withCause(
    `${label} could not write its local coordination state at ${lockPath} because the harness or filesystem denied permission (${code}). This is not lock contention: do not pause other authors or recover/delete controller state. Fix the exact local permission and retry.`,
    EXIT_CODES.unsafe,
    error
  );
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export const recoverStaleWorktreeCoordinationLock = (
  commonGitDirectory: string,
  expectedPid: number
): boolean => {
  const lockPath = coordinationLockPath(commonGitDirectory);
  if (!existsSync(lockPath)) {
    return false;
  }
  const ownerPath = resolve(lockPath, LOCK_OWNER_FILENAME);
  let owner: CoordinationLockOwner;
  try {
    owner = JSON.parse(
      readFileSync(ownerPath, "utf8")
    ) as CoordinationLockOwner;
  } catch (error) {
    throw SimpleChangesError.withCause(
      `Cannot recover ${lockPath}: ownership metadata is missing or invalid.`,
      EXIT_CODES.unsafe,
      error
    );
  }
  if (owner.hostname !== hostname() || owner.pid !== expectedPid) {
    throw new SimpleChangesError(
      `Cannot recover worktree coordination owned by ${owner.hostname} PID ${owner.pid}; expected ${hostname()} PID ${expectedPid}.`,
      EXIT_CODES.unsafe
    );
  }
  const age = Date.now() - Date.parse(owner.createdAt);
  if (!(Number.isFinite(age) && age >= STALE_LOCK_MINIMUM_AGE_MS)) {
    throw new SimpleChangesError(
      `Cannot recover worktree coordination younger than ${STALE_LOCK_MINIMUM_AGE_MS}ms.`,
      EXIT_CODES.unsafe
    );
  }
  if (processIsAlive(owner.pid)) {
    throw new SimpleChangesError(
      `Cannot recover active worktree coordination owner PID ${owner.pid}.`,
      EXIT_CODES.unsafe
    );
  }
  const recoveryPath = `${lockPath}.recovery-${randomUUID()}`;
  renameSync(lockPath, recoveryPath);
  rmSync(recoveryPath, { force: true, recursive: true });
  return true;
};

const acquireNamedLock = (
  commonGitDirectory: string,
  lockPath: string,
  operation: string,
  label: string
): (() => void) => {
  const root = stateRoot(commonGitDirectory);
  mkdirSync(root, { mode: 0o700, recursive: true });
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw SimpleChangesError.withCause(
        `${label} is busy at ${lockPath}. Retry after the current operation finishes.`,
        EXIT_CODES.unsafe,
        error
      );
    }
    const permissionError = permissionDeniedLockError(label, lockPath, error);
    if (permissionError) {
      throw permissionError;
    }
    throw error;
  }
  const owner: CoordinationLockOwner = {
    createdAt: new Date().toISOString(),
    hostname: hostname(),
    operation,
    pid: process.pid,
    token: randomUUID(),
  };
  try {
    writeFileSync(
      resolve(lockPath, LOCK_OWNER_FILENAME),
      `${JSON.stringify(owner, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    rmSync(lockPath, { force: true, recursive: true });
    const permissionError = permissionDeniedLockError(label, lockPath, error);
    if (permissionError) {
      throw permissionError;
    }
    throw error;
  }
  return () => {
    const path = resolve(lockPath, LOCK_OWNER_FILENAME);
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as {
        token?: string;
      };
      if (current.token === owner.token) {
        rmSync(lockPath, { force: true, recursive: true });
      }
    } catch (error) {
      throw SimpleChangesError.withCause(
        `${label} lock ownership changed during the operation.`,
        EXIT_CODES.unsafe,
        error
      );
    }
  };
};

const acquireCoordinationLock = (
  commonGitDirectory: string,
  operation: string
): (() => void) =>
  acquireNamedLock(
    commonGitDirectory,
    coordinationLockPath(commonGitDirectory),
    operation,
    "Worktree coordination state"
  );

const withCoordinationLock = <T>(
  commonGitDirectory: string,
  operation: string,
  callback: () => T
): T => {
  const release = acquireCoordinationLock(commonGitDirectory, operation);
  try {
    return callback();
  } finally {
    release();
  }
};

export const withWorktreeCoordinationLock = <T>(
  commonGitDirectory: string,
  operation: string,
  callback: () => T
): T => withCoordinationLock(commonGitDirectory, operation, callback);

const withGitCoordinationLocks = <T>(
  commonGitDirectory: string,
  operation: string,
  callback: () => T
): T => {
  const releaseLoop = acquireNamedLock(
    commonGitDirectory,
    activeLoopLockPath(commonGitDirectory),
    operation,
    "Active-loop state"
  );
  try {
    return withCoordinationLock(commonGitDirectory, operation, callback);
  } finally {
    releaseLoop();
  }
};

const emptyDocument = (
  commonGitDirectory: string
): WorktreeCoordinationDocument => ({
  claims: [],
  events: [],
  receipts: [],
  repositoryId: repositoryIdFor(commonGitDirectory),
  schemaVersion: 1,
});

export const readCoordinationDocumentFromCommonDirectory = (
  commonGitDirectory: string
): WorktreeCoordinationDocument => {
  const path = worktreeCoordinationPath(commonGitDirectory);
  if (!existsSync(path)) {
    return emptyDocument(commonGitDirectory);
  }
  const document = validateSchema<WorktreeCoordinationDocument>(
    "worktree-coordination",
    JSON.parse(readFileSync(path, "utf8"))
  );
  if (document.repositoryId !== repositoryIdFor(commonGitDirectory)) {
    throw new SimpleChangesError(
      "Worktree coordination state belongs to a different repository identity.",
      EXIT_CODES.unsafe
    );
  }
  return document;
};

const writeCoordinationDocument = (
  commonGitDirectory: string,
  document: WorktreeCoordinationDocument
): WorktreeCoordinationDocument => {
  const validated = validateSchema<WorktreeCoordinationDocument>(
    "worktree-coordination",
    document
  );
  const root = coordinationRoot(commonGitDirectory);
  mkdirSync(root, { mode: 0o700, recursive: true });
  const temporaryPath = resolve(
    root,
    `${STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  );
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, worktreeCoordinationPath(commonGitDirectory));
  return validated;
};

const appendEvent = (
  document: WorktreeCoordinationDocument,
  claimId: string,
  actorAgentId: string,
  state: WorktreeCoordinationState,
  createdAt: string,
  eventId = `event-${randomUUID()}`
): WorktreeCoordinationDocument => {
  const event: WorktreeCoordinationEvent = {
    actorAgentId,
    claimId,
    createdAt,
    eventId,
    state,
  };
  return { ...document, events: [...document.events, event] };
};

const replaceClaim = (
  document: WorktreeCoordinationDocument,
  claim: WorktreeClaim
): WorktreeCoordinationDocument => ({
  ...document,
  claims: [
    ...document.claims.filter((item) => item.claimId !== claim.claimId),
    claim,
  ],
});

const worktreeAt = (
  inventory: ReturnType<typeof captureInventory>,
  pathInput: string
): WorktreeInventory => {
  const path = canonicalCandidate(pathInput);
  const worktree = inventory.worktrees.find((item) => item.path === path);
  if (!worktree) {
    throw new SimpleChangesError(
      `Path is not a current worktree in this repository: ${path}`,
      EXIT_CODES.unsafe
    );
  }
  return worktree;
};

const activeLoop = (commonGitDirectory: string): LoopLease | null => {
  const path = resolve(stateRoot(commonGitDirectory), ACTIVE_LOOP_FILENAME);
  if (!existsSync(path)) {
    return null;
  }
  return validateSchema<LoopLease>(
    "loop-lease",
    JSON.parse(readFileSync(path, "utf8"))
  );
};

const activeLoopNeedsPath = (
  commonGitDirectory: string,
  worktreePath: string
): boolean => {
  const lease = activeLoop(commonGitDirectory);
  if (!lease) {
    return false;
  }
  return lease.worktrees.some((item) => item.path === worktreePath);
};

const assertNoGitOperation = (worktreePath: string): void => {
  const gitDirectory = realpathSync(
    runGit(worktreePath, ["rev-parse", "--absolute-git-dir"]).stdout.trim()
  );
  const markers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-apply",
    "rebase-merge",
  ];
  if (markers.some((marker) => existsSync(resolve(gitDirectory, marker)))) {
    throw new SimpleChangesError(
      `Worktree ${worktreePath} has an active Git operation.`,
      EXIT_CODES.unsafe
    );
  }
};

const assertCurrentEvidence = (
  claim: WorktreeClaim,
  receipt: WorktreePauseReceipt,
  current: WorktreeInventory
): void => {
  if (
    receipt.claimId !== claim.claimId ||
    receipt.path !== claim.path ||
    current.path !== claim.path ||
    receipt.branch !== current.branch ||
    receipt.headSha !== current.headSha ||
    receipt.changeDigest !== current.changeDigest ||
    claim.branch !== current.branch ||
    claim.headSha !== current.headSha ||
    claim.changeDigest !== current.changeDigest ||
    receipt.ownerAgentId !== claim.owner.agentId
  ) {
    throw new SimpleChangesError(
      "Pause receipt no longer matches the exact claim and current Git evidence.",
      EXIT_CODES.unsafe
    );
  }
};

const assertDetachableWorktree = (current: WorktreeInventory): void => {
  if (
    current.isPrimary ||
    current.detached ||
    !current.branch ||
    !current.headSha ||
    current.changes.length > 0 ||
    current.changes.some((change) => change.conflicted)
  ) {
    throw new SimpleChangesError(
      "Detach requires a clean, non-primary worktree attached to a local branch.",
      EXIT_CODES.unsafe
    );
  }
};

export const readWorktreeCoordination = (
  repositoryPath: string
): WorktreeCoordinationDocument => {
  const inventory = captureInventory(repositoryPath);
  return readCoordinationDocumentFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
};

export const worktreeClaimDocumentDigest = (
  document: WorktreeCoordinationDocument
): string => sha256Json(document);

export const observeWorktreeClaims = (
  repositoryPath: string
): WorktreeClaimObservation => {
  const inventory = captureInventory(repositoryPath);
  const { commonGitDirectory } = inventory.repository;
  return withCoordinationLock(
    commonGitDirectory,
    "observe worktree claims",
    () => {
      const document =
        readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
      return {
        activeClaimCount: document.claims.filter(
          (claim) => claim.state === "active"
        ).length,
        digest: worktreeClaimDocumentDigest(document),
        observedAt: new Date().toISOString(),
      };
    }
  );
};

export const claimWorktree = (
  repositoryPath: string,
  agentIdInput: string,
  pathInput: string,
  adapterInput: string,
  ownerRefInput?: string
): WorktreeClaim => {
  const agentId = requiredText(agentIdInput, "agent ID", 128);
  const adapter = requiredText(adapterInput, "adapter", 64);
  if (!ADAPTER_PATTERN.test(adapter)) {
    throw new SimpleChangesError(
      "adapter must be a bounded lowercase slug.",
      EXIT_CODES.usage
    );
  }
  const ownerRef = ownerRefInput?.trim() || null;
  if (ownerRef && ownerRef.length > 512) {
    throw new SimpleChangesError(
      "owner reference must be at most 512 characters.",
      EXIT_CODES.usage
    );
  }
  if (ownerRef && redactSecrets(ownerRef) !== ownerRef) {
    throw new SimpleChangesError(
      "owner reference must not contain credentials or secrets.",
      EXIT_CODES.unsafe
    );
  }
  const opening = captureInventory(repositoryPath);
  return withCoordinationLock(
    opening.repository.commonGitDirectory,
    "worktree claim",
    () => {
      const inventory = captureInventory(repositoryPath);
      const worktree = worktreeAt(inventory, pathInput);
      if (worktree.isPrimary) {
        const lease = activeLoop(inventory.repository.commonGitDirectory);
        if (
          !lease ||
          lease.ownerAgentId !== agentId ||
          lease.primaryCheckout !== worktree.path
        ) {
          throw new SimpleChangesError(
            "The primary checkout may be claimed only by its active loop controller.",
            EXIT_CODES.unsafe
          );
        }
      }
      const now = new Date().toISOString();
      let document = readCoordinationDocumentFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      const existing = document.claims.find(
        (item) => item.path === worktree.path && item.state !== "released"
      );
      if (existing && existing.owner.agentId !== agentId) {
        throw new SimpleChangesError(
          `Worktree ${worktree.path} is already claimed by ${existing.owner.agentId}.`,
          EXIT_CODES.unsafe
        );
      }
      if (
        existing &&
        (existing.owner.adapter !== adapter ||
          existing.owner.ownerRef !== ownerRef)
      ) {
        throw new SimpleChangesError(
          `Worktree ${worktree.path} is already claimed with a different adapter or owner reference; repeat the exact owner identity or release the claim first.`,
          EXIT_CODES.unsafe
        );
      }
      if (existing) {
        if (
          existing.branch === worktree.branch &&
          existing.headSha === worktree.headSha &&
          existing.changeDigest === worktree.changeDigest &&
          existing.state === "active"
        ) {
          return existing;
        }
        const refreshed: WorktreeClaim = {
          ...existing,
          branch: worktree.branch,
          changeDigest: worktree.changeDigest,
          headSha: worktree.headSha,
          state: "active",
          updatedAt: now,
        };
        document = appendEvent(
          replaceClaim(document, refreshed),
          refreshed.claimId,
          agentId,
          "active",
          now
        );
        writeCoordinationDocument(
          inventory.repository.commonGitDirectory,
          document
        );
        return refreshed;
      }
      const claim: WorktreeClaim = {
        branch: worktree.branch,
        changeDigest: worktree.changeDigest,
        claimId: `claim-${randomUUID()}`,
        commonGitDirectory: inventory.repository.commonGitDirectory,
        createdAt: now,
        headSha: worktree.headSha,
        owner: { adapter, agentId, ownerRef },
        path: worktree.path,
        repositoryId: repositoryIdFor(inventory.repository.commonGitDirectory),
        schemaVersion: 1,
        state: "active",
        updatedAt: now,
      };
      document = appendEvent(
        replaceClaim(document, claim),
        claim.claimId,
        agentId,
        "active",
        now
      );
      writeCoordinationDocument(
        inventory.repository.commonGitDirectory,
        document
      );
      return claim;
    }
  );
};

export const pauseClaimedWorktree = (
  repositoryPath: string,
  agentIdInput: string,
  pathInput: string,
  requestingRunIdInput: string,
  disposition: WorktreePauseReceipt["disposition"],
  reasonInput: string
): WorktreePauseReceipt => {
  const agentId = requiredText(agentIdInput, "agent ID", 128);
  const requestingRunId = requiredText(requestingRunIdInput, "run ID", 128);
  const reason = requiredText(reasonInput, "pause reason");
  if (!RUN_ID_PATTERN.test(requestingRunId)) {
    throw new SimpleChangesError(
      "run ID must match run-[a-z0-9-]+.",
      EXIT_CODES.usage
    );
  }
  const opening = captureInventory(repositoryPath);
  return withCoordinationLock(
    opening.repository.commonGitDirectory,
    "worktree pause",
    () => {
      const inventory = captureInventory(repositoryPath);
      const current = worktreeAt(inventory, pathInput);
      assertNoGitOperation(current.path);
      if (current.changes.some((change) => change.conflicted)) {
        throw new SimpleChangesError(
          `Worktree ${current.path} has unresolved conflicts.`,
          EXIT_CODES.unsafe
        );
      }
      if (
        disposition === "detach-clean-checkout" &&
        current.changes.length > 0
      ) {
        throw new SimpleChangesError(
          "detach-clean-checkout requires a completely clean worktree.",
          EXIT_CODES.unsafe
        );
      }
      let document = readCoordinationDocumentFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      const claim = document.claims.find(
        (item) => item.path === current.path && LIVE_STATES.has(item.state)
      );
      if (!claim || claim.owner.agentId !== agentId) {
        throw new SimpleChangesError(
          `Only the current claim owner may pause ${current.path}.`,
          EXIT_CODES.unsafe
        );
      }
      if (
        claim.branch !== current.branch ||
        claim.headSha !== current.headSha ||
        claim.changeDigest !== current.changeDigest
      ) {
        const staleAt = new Date().toISOString();
        const staleClaim: WorktreeClaim = {
          ...claim,
          state: "stale",
          updatedAt: staleAt,
        };
        document = appendEvent(
          replaceClaim(document, staleClaim),
          claim.claimId,
          agentId,
          "stale",
          staleAt
        );
        writeCoordinationDocument(
          inventory.repository.commonGitDirectory,
          document
        );
        throw new SimpleChangesError(
          "The claim is stale; refresh it before acknowledging a pause.",
          EXIT_CODES.unsafe
        );
      }
      const acknowledgedAt = new Date().toISOString();
      const receipt: WorktreePauseReceipt = {
        acknowledgedAt,
        branch: current.branch,
        changeDigest: current.changeDigest,
        claimId: claim.claimId,
        disposition,
        headSha: current.headSha,
        ownerAgentId: agentId,
        path: current.path,
        reason,
        receiptId: `pause-${randomUUID()}`,
        requestingRunId,
        schemaVersion: 1,
      };
      const pausedClaim: WorktreeClaim = {
        ...claim,
        state: "paused",
        updatedAt: acknowledgedAt,
      };
      document = {
        ...replaceClaim(document, pausedClaim),
        receipts: [...document.receipts, receipt],
      };
      document = appendEvent(
        document,
        claim.claimId,
        agentId,
        "paused",
        acknowledgedAt
      );
      writeCoordinationDocument(
        inventory.repository.commonGitDirectory,
        document
      );
      return receipt;
    }
  );
};

export interface CoordinationEvidence {
  claim: WorktreeClaim;
  document: WorktreeCoordinationDocument;
  receipt: WorktreePauseReceipt;
}

export const coordinationEvidence = (
  commonGitDirectory: string,
  receiptId: string
): CoordinationEvidence => {
  const document =
    readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
  const receipt = document.receipts.find(
    (item) => item.receiptId === receiptId
  );
  const claim = receipt
    ? document.claims.find((item) => item.claimId === receipt.claimId)
    : undefined;
  if (!(claim && receipt)) {
    throw new SimpleChangesError(
      `Unknown pause receipt: ${receiptId}`,
      EXIT_CODES.unsafe
    );
  }
  return { claim, document, receipt };
};

const transitionClaim = (
  commonGitDirectory: string,
  claimId: string,
  actorAgentId: string,
  state: WorktreeCoordinationState,
  updates: Partial<WorktreeClaim> = {},
  allowedStates?: readonly WorktreeCoordinationState[]
): WorktreeClaim =>
  withCoordinationLock(commonGitDirectory, `worktree ${state}`, () => {
    let document =
      readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
    const claim = document.claims.find((item) => item.claimId === claimId);
    if (!claim) {
      throw new SimpleChangesError(
        `Unknown worktree claim: ${claimId}`,
        EXIT_CODES.unsafe
      );
    }
    if (allowedStates && !allowedStates.includes(claim.state)) {
      throw new SimpleChangesError(
        `Claim ${claimId} cannot transition from ${claim.state} to ${state}.`,
        EXIT_CODES.unsafe
      );
    }
    const updatedAt = new Date().toISOString();
    const updated: WorktreeClaim = {
      ...claim,
      ...updates,
      state,
      updatedAt,
    };
    document = appendEvent(
      replaceClaim(document, updated),
      claimId,
      actorAgentId,
      state,
      updatedAt
    );
    writeCoordinationDocument(commonGitDirectory, document);
    return updated;
  });

export const markCoordinationAdopted = (
  commonGitDirectory: string,
  claimId: string,
  receiptId: string,
  controllerAgentId: string
): WorktreeClaim => {
  const { claim } = coordinationEvidence(commonGitDirectory, receiptId);
  if (
    claim.claimId !== claimId ||
    !["paused", "adopted-preserved"].includes(claim.state)
  ) {
    throw new SimpleChangesError(
      "Only an exact paused claim can be adopted.",
      EXIT_CODES.unsafe
    );
  }
  if (claim.state === "adopted-preserved") {
    return claim;
  }
  return transitionClaim(
    commonGitDirectory,
    claimId,
    controllerAgentId,
    "adopted-preserved",
    {},
    ["paused", "adopted-preserved"]
  );
};

export const markCoordinationResumeReady = (
  commonGitDirectory: string,
  claimId: string,
  controllerAgentId: string,
  runId: string,
  targetRef: string,
  targetSha: string
): WorktreeClaim => {
  if (!(RUN_ID_PATTERN.test(runId) && SHA_PATTERN.test(targetSha))) {
    throw new SimpleChangesError(
      "Resume target must include a valid run ID and exact target SHA.",
      EXIT_CODES.usage
    );
  }
  const document =
    readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
  if (
    !document.receipts.some(
      (receipt) =>
        receipt.claimId === claimId && receipt.requestingRunId === runId
    )
  ) {
    throw new SimpleChangesError(
      "Resume-ready requires an owner pause receipt for this exact run.",
      EXIT_CODES.unsafe
    );
  }
  return transitionClaim(
    commonGitDirectory,
    claimId,
    controllerAgentId,
    "resume-ready",
    {
      resumeTarget: {
        createdAt: new Date().toISOString(),
        runId,
        targetRef,
        targetSha,
      },
    },
    ["paused", "adopted-preserved", "detached", "attached", "resume-ready"]
  );
};

export const detachClaimedWorktree = (
  repositoryPath: string,
  agentIdInput: string,
  pathInput: string,
  receiptIdInput: string
): WorktreeClaim => {
  const agentId = requiredText(agentIdInput, "agent ID", 128);
  const receiptId = requiredText(receiptIdInput, "pause receipt ID", 128);
  const opening = captureInventory(repositoryPath);
  return withGitCoordinationLocks(
    opening.repository.commonGitDirectory,
    "worktree detach",
    () => {
      const inventory = captureInventory(repositoryPath);
      const current = worktreeAt(inventory, pathInput);
      const document = readCoordinationDocumentFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      const receipt = document.receipts.find(
        (item) => item.receiptId === receiptId
      );
      const claim = receipt
        ? document.claims.find((item) => item.claimId === receipt.claimId)
        : undefined;
      if (!(claim && receipt) || claim.owner.agentId !== agentId) {
        throw new SimpleChangesError(
          "Only the exact claim owner may detach this pause receipt.",
          EXIT_CODES.unsafe
        );
      }
      if (
        claim.state !== "paused" ||
        receipt.disposition !== "detach-clean-checkout"
      ) {
        throw new SimpleChangesError(
          "Detach requires a current detach-clean-checkout pause receipt.",
          EXIT_CODES.unsafe
        );
      }
      assertCurrentEvidence(claim, receipt, current);
      assertNoGitOperation(current.path);
      assertDetachableWorktree(current);
      const branchSha = runGit(inventory.repository.primaryCheckout, [
        "rev-parse",
        "--verify",
        `refs/heads/${current.branch}^{commit}`,
      ]).stdout.trim();
      if (branchSha !== current.headSha) {
        throw new SimpleChangesError(
          "The worktree branch does not resolve to its exact HEAD.",
          EXIT_CODES.unsafe
        );
      }
      if (
        activeLoopNeedsPath(
          inventory.repository.commonGitDirectory,
          current.path
        )
      ) {
        throw new SimpleChangesError(
          "An active loop still requires this worktree path.",
          EXIT_CODES.unsafe
        );
      }
      const otherWorktrees = inventory.worktrees
        .filter((item) => item.path !== current.path)
        .map((item) => `${item.path}:${item.branch}:${item.headSha}`)
        .sort((left, right) => left.localeCompare(right));
      const refsBefore = runGit(inventory.repository.primaryCheckout, [
        "for-each-ref",
        "--format=%(refname):%(objectname)",
        "refs/heads",
      ]).stdout;
      runGit(inventory.repository.primaryCheckout, [
        "worktree",
        "remove",
        current.path,
      ]);
      const after = captureInventory(inventory.repository.primaryCheckout);
      const refsAfter = runGit(after.repository.primaryCheckout, [
        "for-each-ref",
        "--format=%(refname):%(objectname)",
        "refs/heads",
      ]).stdout;
      const otherAfter = after.worktrees
        .map((item) => `${item.path}:${item.branch}:${item.headSha}`)
        .sort((left, right) => left.localeCompare(right));
      const preservedBranchSha = runGit(after.repository.primaryCheckout, [
        "rev-parse",
        "--verify",
        `refs/heads/${current.branch}^{commit}`,
      ]).stdout.trim();
      if (
        existsSync(current.path) ||
        after.worktrees.some((item) => item.path === current.path) ||
        preservedBranchSha !== current.headSha ||
        refsBefore !== refsAfter ||
        JSON.stringify(otherWorktrees) !== JSON.stringify(otherAfter)
      ) {
        throw new SimpleChangesError(
          "Detach verification failed; inspect the preserved branch and worktree registry.",
          EXIT_CODES.unsafe
        );
      }
      const now = new Date().toISOString();
      const detached: WorktreeClaim = {
        ...claim,
        state: "detached",
        updatedAt: now,
      };
      let updatedDocument = appendEvent(
        replaceClaim(document, detached),
        claim.claimId,
        agentId,
        "detached",
        now
      );
      updatedDocument = writeCoordinationDocument(
        inventory.repository.commonGitDirectory,
        updatedDocument
      );
      return (
        updatedDocument.claims.find((item) => item.claimId === claim.claimId) ??
        detached
      );
    }
  );
};

export const attachClaimedWorktree = (
  repositoryPath: string,
  agentIdInput: string,
  claimIdInput: string
): WorktreeClaim => {
  const agentId = requiredText(agentIdInput, "agent ID", 128);
  const claimId = requiredText(claimIdInput, "claim ID", 128);
  const opening = captureInventory(repositoryPath);
  return withGitCoordinationLocks(
    opening.repository.commonGitDirectory,
    "worktree attach",
    () => {
      const inventory = captureInventory(repositoryPath);
      const document = readCoordinationDocumentFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      const claim = document.claims.find((item) => item.claimId === claimId);
      if (!claim || claim.owner.agentId !== agentId) {
        throw new SimpleChangesError(
          "Only the exact claim owner may attach this worktree.",
          EXIT_CODES.unsafe
        );
      }
      if (
        !(
          ["detached", "resume-ready"].includes(claim.state) &&
          claim.branch &&
          claim.headSha
        ) ||
        existsSync(claim.path) ||
        activeLoop(inventory.repository.commonGitDirectory)
      ) {
        throw new SimpleChangesError(
          "Attach requires an absent detached path, a preserved branch, and no active loop.",
          EXIT_CODES.unsafe
        );
      }
      const parent = dirname(claim.path);
      if (!existsSync(parent)) {
        throw new SimpleChangesError(
          `Attach parent directory no longer exists: ${parent}`,
          EXIT_CODES.unsafe
        );
      }
      if (realpathSync(parent) !== parent) {
        throw new SimpleChangesError(
          "Attach path has a symlinked or non-canonical parent.",
          EXIT_CODES.unsafe
        );
      }
      const branchSha = runGit(inventory.repository.primaryCheckout, [
        "rev-parse",
        "--verify",
        `refs/heads/${claim.branch}^{commit}`,
      ]).stdout.trim();
      if (branchSha !== claim.headSha) {
        throw new SimpleChangesError(
          "The preserved branch moved after detach; refresh the claim explicitly.",
          EXIT_CODES.unsafe
        );
      }
      runGit(inventory.repository.primaryCheckout, [
        "worktree",
        "add",
        claim.path,
        claim.branch,
      ]);
      const after = captureInventory(claim.path);
      const attached = worktreeAt(after, claim.path);
      if (
        attached.branch !== claim.branch ||
        attached.headSha !== claim.headSha ||
        attached.changes.length > 0
      ) {
        throw new SimpleChangesError(
          "Attached worktree does not match the preserved branch and HEAD.",
          EXIT_CODES.unsafe
        );
      }
      const now = new Date().toISOString();
      const updated: WorktreeClaim = {
        ...claim,
        changeDigest: attached.changeDigest,
        state: "attached",
        updatedAt: now,
      };
      const updatedDocument = appendEvent(
        replaceClaim(document, updated),
        claim.claimId,
        agentId,
        "attached",
        now
      );
      writeCoordinationDocument(
        inventory.repository.commonGitDirectory,
        updatedDocument
      );
      return updated;
    }
  );
};

export const releaseWorktreeClaim = (
  repositoryPath: string,
  agentIdInput: string,
  claimIdInput: string
): WorktreeClaim => {
  const agentId = requiredText(agentIdInput, "agent ID", 128);
  const claimId = requiredText(claimIdInput, "claim ID", 128);
  const inventory = captureInventory(repositoryPath);
  const document = readCoordinationDocumentFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  const claim = document.claims.find((item) => item.claimId === claimId);
  if (!claim || claim.owner.agentId !== agentId) {
    throw new SimpleChangesError(
      "Only the exact claim owner may release this worktree claim.",
      EXIT_CODES.unsafe
    );
  }
  return transitionClaim(
    inventory.repository.commonGitDirectory,
    claimId,
    agentId,
    "released",
    {},
    [
      "active",
      "pause-requested",
      "paused",
      "adopted-preserved",
      "detach-requested",
      "detached",
      "attached",
      "resume-ready",
      "blocked",
    ]
  );
};

export const retireAbsentWorktreeClaimsUnderLock = (
  commonGitDirectory: string,
  paths: string[],
  actorAgentIdInput: string,
  plan: AbsentWorktreeClaimRetirementPlan
): string[] => {
  const actorAgentId = requiredText(actorAgentIdInput, "agent ID", 128);
  const retiredPaths = new Set(paths);
  if (retiredPaths.size === 0) {
    return [];
  }
  const document =
    readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
  const currentDigest = worktreeClaimDocumentDigest(document);
  if (currentDigest === plan.afterDigest) {
    return plan.retiredClaimIds;
  }
  if (currentDigest !== plan.beforeDigest) {
    throw new SimpleChangesError(
      "Worktree claims no longer match the approved post-cleanup retirement plan.",
      EXIT_CODES.unsafe
    );
  }
  const retirement = projectAbsentWorktreeClaimRetirement(
    document,
    retiredPaths,
    actorAgentId,
    plan.retiredAt
  );
  if (
    retirement.afterDigest !== plan.afterDigest ||
    JSON.stringify(retirement.retiredClaimIds) !==
      JSON.stringify(plan.retiredClaimIds)
  ) {
    throw new SimpleChangesError(
      "Worktree claim retirement no longer matches its immutable recovery intent.",
      EXIT_CODES.unsafe
    );
  }
  if (retirement.afterDigest !== currentDigest) {
    writeCoordinationDocument(commonGitDirectory, retirement.document);
  }
  return retirement.retiredClaimIds;
};

export interface AbsentWorktreeClaimRetirementPlan {
  afterDigest: string;
  beforeDigest: string;
  retiredAt: string;
  retiredClaimIds: string[];
}

const projectAbsentWorktreeClaimRetirement = (
  openingDocument: WorktreeCoordinationDocument,
  retiredPaths: Set<string>,
  actorAgentId: string,
  retiredAt: string
): AbsentWorktreeClaimRetirementPlan & {
  document: WorktreeCoordinationDocument;
} => {
  let document = openingDocument;
  const retired: string[] = [];
  const openingDigest = worktreeClaimDocumentDigest(openingDocument);
  for (const claim of document.claims) {
    if (!retiredPaths.has(claim.path)) {
      continue;
    }
    if (claim.state === "active") {
      throw new SimpleChangesError(
        `Active claim ${claim.claimId} still owns ${claim.path}; post-cleanup recovery cannot retire it.`,
        EXIT_CODES.unsafe
      );
    }
    if (claim.state === "released") {
      retired.push(claim.claimId);
      continue;
    }
    const updated: WorktreeClaim = {
      ...claim,
      state: "released",
      updatedAt: retiredAt,
    };
    document = appendEvent(
      replaceClaim(document, updated),
      claim.claimId,
      actorAgentId,
      "released",
      retiredAt,
      `event-recovery-${sha256Json({
        actorAgentId,
        claimId: claim.claimId,
        openingDigest,
        retiredAt,
      })}`
    );
    retired.push(claim.claimId);
  }
  return {
    afterDigest: worktreeClaimDocumentDigest(document),
    beforeDigest: openingDigest,
    document,
    retiredAt,
    retiredClaimIds: retired.sort((left, right) => left.localeCompare(right)),
  };
};

export const planAbsentWorktreeClaimRetirementUnderLock = (
  commonGitDirectory: string,
  paths: string[],
  actorAgentIdInput: string,
  retiredAt: string
): AbsentWorktreeClaimRetirementPlan => {
  const actorAgentId = requiredText(actorAgentIdInput, "agent ID", 128);
  const document =
    readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
  const { document: _document, ...plan } = projectAbsentWorktreeClaimRetirement(
    document,
    new Set(paths),
    actorAgentId,
    retiredAt
  );
  return plan;
};

export const coordinationLinkIsCurrent = (
  commonGitDirectory: string,
  claimId: string,
  receiptId: string,
  current: WorktreeInventory
): boolean => {
  try {
    const { claim, receipt } = coordinationEvidence(
      commonGitDirectory,
      receiptId
    );
    if (
      claim.claimId !== claimId ||
      claim.state === "released" ||
      claim.state === "stale"
    ) {
      return false;
    }
    assertCurrentEvidence(claim, receipt, current);
    return true;
  } catch {
    return false;
  }
};

export interface WorktreeTakeoverReceipt {
  action: "reassign" | "release";
  approvedBy: string;
  branch: string | null;
  changeDigest: string;
  claimId: string;
  headSha: string | null;
  newAgentId: string;
  path: string;
  phase?: "completed" | "intent";
  previousOwner: WorktreeClaimOwner;
  reason: string;
  schemaVersion: 1;
  takenOverAt: string;
  takeoverId: string;
}

export interface WorktreeTakeoverOptions {
  action: "reassign" | "release";
  approvedBy: string;
  claimId: string;
  expectedStatusDigest: string;
  newAgentId: string;
  reason: string;
  repositoryPath: string;
}

export interface WorktreeTakeoverResult {
  claim: WorktreeClaim;
  receipt: WorktreeTakeoverReceipt;
}

export const readWorktreeTakeovers = (
  commonGitDirectory: string
): WorktreeTakeoverReceipt[] => {
  const path = worktreeTakeoversPath(commonGitDirectory);
  if (!existsSync(path)) {
    return [];
  }
  const records = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(records)) {
    throw new SimpleChangesError(
      "Worktree takeover history is not an append-only record list.",
      EXIT_CODES.unsafe
    );
  }
  return records.map((record) =>
    validateSchema<WorktreeTakeoverReceipt>("worktree-takeover", record)
  );
};

const writeWorktreeTakeovers = (
  commonGitDirectory: string,
  receipts: WorktreeTakeoverReceipt[]
): void => {
  const root = coordinationRoot(commonGitDirectory);
  mkdirSync(root, { mode: 0o700, recursive: true });
  const temporaryPath = resolve(
    root,
    `${TAKEOVERS_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  );
  writeFileSync(temporaryPath, `${JSON.stringify(receipts, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, worktreeTakeoversPath(commonGitDirectory));
};

const matchingTakeoverIntent = (
  history: readonly WorktreeTakeoverReceipt[],
  options: Pick<
    WorktreeTakeoverOptions,
    "action" | "approvedBy" | "claimId" | "newAgentId" | "reason"
  >,
  expectedStatusDigest: string
): WorktreeTakeoverReceipt | undefined =>
  [...history]
    .reverse()
    .find(
      (item) =>
        item.phase === "intent" &&
        item.claimId === options.claimId &&
        item.action === options.action &&
        item.newAgentId === options.newAgentId &&
        item.changeDigest === expectedStatusDigest &&
        item.approvedBy === options.approvedBy &&
        item.reason === options.reason
    );

const recoverAppliedTakeoverIntent = (
  commonGitDirectory: string,
  history: WorktreeTakeoverReceipt[],
  claim: WorktreeClaim,
  intent: WorktreeTakeoverReceipt | undefined
): WorktreeTakeoverResult | null => {
  if (!intent) {
    return null;
  }
  const applied =
    intent.action === "release"
      ? claim.state === "released"
      : claim.owner.agentId === intent.newAgentId &&
        claim.owner.ownerRef === `takeover:${intent.approvedBy}`;
  if (!applied) {
    return null;
  }
  const completed = { ...intent, phase: "completed" as const };
  writeWorktreeTakeovers(
    commonGitDirectory,
    history.map((item) =>
      item.takeoverId === completed.takeoverId ? completed : item
    )
  );
  return { claim, receipt: completed };
};

const persistTakeoverIntent = (
  commonGitDirectory: string,
  history: WorktreeTakeoverReceipt[],
  receipt: WorktreeTakeoverReceipt,
  reused: boolean
): void => {
  if (!reused) {
    writeWorktreeTakeovers(commonGitDirectory, [...history, receipt]);
  }
  if (
    process.env.NODE_ENV === "test" &&
    process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT ===
      receipt.claimId
  ) {
    throw new SimpleChangesError(
      "Simulated failure after durable takeover intent.",
      EXIT_CODES.unsafe
    );
  }
};

export const takeoverWorktreeClaim = (
  options: WorktreeTakeoverOptions
): WorktreeTakeoverResult => {
  const claimId = requiredText(options.claimId, "claim ID", 128);
  const newAgentId = requiredText(options.newAgentId, "new agent ID", 128);
  const approvedBy = requiredText(options.approvedBy, "approver", 128);
  const reason = requiredText(options.reason, "takeover reason");
  const expectedStatusDigest = requiredText(
    options.expectedStatusDigest,
    "expected status digest",
    64
  );
  if (options.action !== "reassign" && options.action !== "release") {
    throw new SimpleChangesError(
      'takeover action must be "reassign" or "release".',
      EXIT_CODES.usage
    );
  }
  const opening = captureInventory(options.repositoryPath);
  return withGitCoordinationLocks(
    opening.repository.commonGitDirectory,
    "worktree takeover",
    () => {
      const inventory = captureInventory(options.repositoryPath);
      const { commonGitDirectory } = inventory.repository;
      let document =
        readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
      const claim = document.claims.find((item) => item.claimId === claimId);
      if (!claim) {
        throw new SimpleChangesError(
          `Unknown worktree claim: ${claimId}`,
          EXIT_CODES.unsafe
        );
      }
      const takeoverHistory = readWorktreeTakeovers(commonGitDirectory);
      const pendingIntent = matchingTakeoverIntent(
        takeoverHistory,
        { ...options, approvedBy, claimId, newAgentId, reason },
        expectedStatusDigest
      );
      const recovered = recoverAppliedTakeoverIntent(
        commonGitDirectory,
        takeoverHistory,
        claim,
        pendingIntent
      );
      if (recovered) {
        return recovered;
      }
      if (!LIVE_STATES.has(claim.state)) {
        throw new SimpleChangesError(
          `Claim ${claimId} is ${claim.state}; only a live claim can be taken over.`,
          EXIT_CODES.unsafe
        );
      }
      const current = worktreeAt(inventory, claim.path);
      if (current.changeDigest !== expectedStatusDigest) {
        throw new SimpleChangesError(
          "The worktree status digest changed since it was observed; re-observe the worktree and retry the takeover with fresh evidence.",
          EXIT_CODES.unsafe
        );
      }
      if (activeLoopNeedsPath(commonGitDirectory, claim.path)) {
        throw new SimpleChangesError(
          "An active loop lease still requires this claimed worktree; takeover is refused until the lease releases it.",
          EXIT_CODES.unsafe
        );
      }
      const takenOverAt = new Date().toISOString();
      const receipt =
        pendingIntent ??
        validateSchema<WorktreeTakeoverReceipt>("worktree-takeover", {
          action: options.action,
          approvedBy,
          branch: current.branch,
          changeDigest: current.changeDigest,
          claimId,
          headSha: current.headSha,
          newAgentId,
          path: claim.path,
          phase: "intent",
          previousOwner: { ...claim.owner },
          reason,
          schemaVersion: 1,
          takenOverAt,
          takeoverId: `takeover-${randomUUID()}`,
        } satisfies WorktreeTakeoverReceipt);
      const updated: WorktreeClaim =
        options.action === "reassign"
          ? {
              ...claim,
              owner: {
                adapter: claim.owner.adapter,
                agentId: newAgentId,
                ownerRef: `takeover:${approvedBy}`,
              },
              updatedAt: takenOverAt,
            }
          : { ...claim, state: "released", updatedAt: takenOverAt };
      document = appendEvent(
        replaceClaim(document, updated),
        claimId,
        newAgentId,
        updated.state,
        takenOverAt
      );
      persistTakeoverIntent(
        commonGitDirectory,
        takeoverHistory,
        receipt,
        Boolean(pendingIntent)
      );
      writeCoordinationDocument(commonGitDirectory, document);
      const completed = { ...receipt, phase: "completed" as const };
      writeWorktreeTakeovers(
        commonGitDirectory,
        pendingIntent
          ? takeoverHistory.map((item) =>
              item.takeoverId === completed.takeoverId ? completed : item
            )
          : [...takeoverHistory, completed]
      );
      return { claim: updated, receipt: completed };
    }
  );
};
