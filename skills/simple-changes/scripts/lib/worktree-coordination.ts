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
import { currentHarnessSession } from "./harness-session.ts";
import { sha256, sha256Json } from "./hash.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import { runGit } from "./process.ts";
import { redactSecrets } from "./redact.ts";
import { validateSchema } from "./schema.ts";
import type {
  LoopLease,
  RepositoryInventory,
  WorktreeClaim,
  WorktreeClaimObservation,
  WorktreeClaimOwner,
  WorktreeClaimReleaseReason,
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
  "detach-requested",
  "adopted-preserved",
  "detached",
  "attached",
  "resume-ready",
  "blocked",
]);
// A detached claim intentionally has no directory: its owner removed the
// checkout through the detach protocol and keeps the branch for reattachment.
// Every other live state expects the worktree to exist, so an absent directory
// means the claim protects nothing and may be released by evidence.
const ABSENT_RELEASABLE_STATES = new Set<WorktreeCoordinationState>([
  "active",
  "pause-requested",
  "paused",
  "detach-requested",
  "adopted-preserved",
  "attached",
  "resume-ready",
  "blocked",
]);

const stateRoot = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY);
const coordinationRoot = (commonGitDirectory: string): string =>
  resolve(stateRoot(commonGitDirectory), COORDINATION_DIRECTORY);
export const worktreeCoordinationDirectory = (
  commonGitDirectory: string
): string => coordinationRoot(commonGitDirectory);
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

export const repositoryIdFor = (commonGitDirectory: string): string =>
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

// ---------------------------------------------------------------------------
// Claim sessions
//
// An agent ID acts on its claims only from the harness session that holds
// them. The claim record is closed to new fields, so older clients that share
// this file can still read it; the session is marked instead in the ID of the
// event that created, refreshed, or reassigned the claim, as a digest of
// `harness:sessionId`. A claim without such an event (one made before this
// marker existed, or with no harness session) is unbound and refuses no one.
// The session comes from the harness environment, so this stops mistakes and
// recovery steps from acting under another agent's ID; it is not
// authentication.

const SESSION_EVENT_PREFIX = "event-session-";
const UNBOUND_SESSION_MARK = "unbound";
const SESSION_DIGEST_LENGTH = 32;

/** The executing harness session as `harness:sessionId`, or null. */
export const executingClaimSession = (
  environment: Record<string, string | undefined> = process.env
): string | null => {
  const session = currentHarnessSession(environment);
  return session ? `${session.harness}:${session.sessionId}` : null;
};

const claimSessionDigest = (session: string): string =>
  sha256(`claim-session:${session}`).slice(0, SESSION_DIGEST_LENGTH);

// The ID of an event that binds its claim to `session`, or that unbinds it.
const sessionEventId = (session: string | null): string =>
  `${SESSION_EVENT_PREFIX}${session ? claimSessionDigest(session) : UNBOUND_SESSION_MARK}-${randomUUID()}`;

// A claim or refresh event binds the claim to a known session; without one
// it is an ordinary event that leaves the binding as it was.
const claimEventId = (session: string | null): string =>
  session ? sessionEventId(session) : `event-${randomUUID()}`;

// A reassigned claim belongs to the session that took it over; one taken
// over without a session is unbound. A release leaves the binding alone.
const takeoverEventId = (
  action: "reassign" | "release",
  session: string | null
): string =>
  action === "reassign" ? sessionEventId(session) : `event-${randomUUID()}`;

// A claim's latest session mark: a session digest, or null when unbound.
// Every marked event is written by the claim's owner at that moment, so a
// mark whose actor no longer owns the claim predates an ownership change that
// recorded none (a takeover by an older client), and binds nothing.
const claimSessionBinding = (
  document: WorktreeCoordinationDocument,
  claim: Pick<WorktreeClaim, "claimId" | "owner">
): string | null => {
  for (let index = document.events.length - 1; index >= 0; index -= 1) {
    const event = document.events[index];
    if (
      event?.claimId === claim.claimId &&
      event.eventId.startsWith(SESSION_EVENT_PREFIX)
    ) {
      const [mark = UNBOUND_SESSION_MARK] = event.eventId
        .slice(SESSION_EVENT_PREFIX.length)
        .split("-");
      return mark === UNBOUND_SESSION_MARK ||
        event.actorAgentId !== claim.owner.agentId
        ? null
        : mark;
    }
  }
  return null;
};

/**
 * Whether a claim belongs to a harness session other than `session`: it is
 * bound to one, and the command reports no session or a different one.
 */
export const claimHeldByAnotherSession = (
  document: WorktreeCoordinationDocument,
  claim: Pick<WorktreeClaim, "claimId" | "owner">,
  session: string | null
): boolean => {
  const binding = claimSessionBinding(document, claim);
  return (
    binding !== null &&
    (session === null || claimSessionDigest(session) !== binding)
  );
};

/**
 * The refusal for a command that would act on another session's claim under
 * its agent ID, with the approved takeover that moves the claim instead.
 */
export const claimSessionRefusal = (
  claim: WorktreeClaim,
  current: TakeoverState | null,
  session: string | null
): string => {
  const releaseOnly = current?.releaseOnly === true;
  const takeover = takeoverCommand({
    agentId: null,
    claimId: claim.claimId,
    current,
    release: releaseOnly,
  });
  const route = releaseOnly
    ? "which retires the claim: its checkout is gone and its recorded state can no longer be reattached, so it cannot be reassigned"
    : "naming your own agent ID (or the same one to continue its work), which reassigns the claim to this session";
  return `Claim ${claim.claimId} on ${claim.path} belongs to another harness session of ${claim.owner.agentId}${session ? "" : ", and this command reports no harness session"}, so it cannot act under that agent ID here: an agent ID acts only from the session that holds its claim. Ask ${claim.owner.agentId} to run this from its own session. If that session has ended, ask the user to approve \`${takeover}\`, ${route}.`;
};

/** The checkout state a takeover approval names. */
export interface TakeoverState {
  branch: string | null;
  changeDigest: string;
  headSha: string | null;
  /**
   * The checkout is gone and its recorded state cannot be reattached, so
   * only a release can name this state.
   */
  releaseOnly?: boolean;
}

// Claims whose owner removed the checkout through the detach protocol and
// kept its branch for reattachment.
const PRESERVED_BRANCH_STATES = new Set<WorktreeCoordinationState>([
  "detached",
  "resume-ready",
]);

const branchTip = (
  inventory: RepositoryInventory,
  branch: string
): string | null =>
  runGit(
    inventory.repository.primaryCheckout,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
    true
  ).stdout.trim() || null;

/**
 * What a takeover of `claim` compares with its approval, and what a printed
 * takeover names. A reassign continues the work, so it needs the exact state:
 * the worktree Git lists at the path, or, for a claim whose owner detached the
 * checkout and kept its branch, the recorded state while the path is absent
 * and that branch still points at the recorded HEAD. A release only retires
 * the claim and touches no file or ref, so it may name any state the owner's
 * own release could leave behind: without a listed worktree, the claim's
 * branch at its current tip, or the recorded HEAD once the branch is gone,
 * with the recorded digest, whatever now occupies the path. That state is
 * release-only.
 */
export const claimTakeoverState = (
  inventory: RepositoryInventory,
  claim: WorktreeClaim
): TakeoverState => {
  const present = inventory.worktrees.find(
    (worktree) => worktree.path === claim.path
  );
  if (present) {
    return present;
  }
  const tip = claim.branch ? branchTip(inventory, claim.branch) : null;
  const reattachable =
    PRESERVED_BRANCH_STATES.has(claim.state) &&
    tip !== null &&
    tip === claim.headSha &&
    !existsSync(claim.path);
  return {
    branch: claim.branch,
    changeDigest: claim.changeDigest,
    headSha: tip ?? claim.headSha,
    ...(reattachable ? {} : { releaseOnly: true }),
  };
};

/** Refuses when `claim` belongs to another harness session. */
export const assertClaimSession = (
  document: WorktreeCoordinationDocument,
  claim: WorktreeClaim,
  current: TakeoverState | null,
  session: string | null = executingClaimSession()
): void => {
  if (claimHeldByAnotherSession(document, claim, session)) {
    throw new SimpleChangesError(
      claimSessionRefusal(claim, current, session),
      EXIT_CODES.unsafe
    );
  }
};

// The owner's own claim refreshes only from its own session; a new claim
// needs the agent ID free of every other session.
const assertClaimantSession = (
  document: WorktreeCoordinationDocument,
  inventory: RepositoryInventory,
  existing: WorktreeClaim | undefined,
  agentId: string,
  worktree: WorktreeInventory,
  session: string | null
): void => {
  if (existing) {
    assertClaimSession(document, existing, worktree, session);
    return;
  }
  assertAgentSessionFree(document, inventory, agentId, worktree.path, session);
};

// Whether re-claiming changes the claim: its checkout moved, it is not
// active, or the first known session to claim an unbound claim binds it.
const claimNeedsRefresh = (
  document: WorktreeCoordinationDocument,
  existing: WorktreeClaim,
  worktree: WorktreeInventory,
  session: string | null
): boolean =>
  existing.branch !== worktree.branch ||
  existing.headSha !== worktree.headSha ||
  existing.changeDigest !== worktree.changeDigest ||
  existing.state !== "active" ||
  (session !== null && claimSessionBinding(document, existing) === null);

/**
 * Refuses a new claim under `agentId` when another session still uses that
 * agent ID: a live claim of it elsewhere belongs to another session, or its
 * latest earlier claim on this same checkout does. A checkout another
 * session claimed passes to this session under this session's own agent ID.
 */
const assertAgentSessionFree = (
  document: WorktreeCoordinationDocument,
  inventory: RepositoryInventory,
  agentId: string,
  path: string,
  session: string | null
): void => {
  const owned = document.claims.filter(
    (claim) => claim.owner.agentId === agentId
  );
  const live = owned.find(
    (claim) =>
      claim.state !== "released" &&
      claimHeldByAnotherSession(document, claim, session)
  );
  if (live) {
    throw new SimpleChangesError(
      `Agent ${agentId} still holds claim ${live.claimId} on ${live.path} in another harness session. ${claimSessionRefusal(
        live,
        claimTakeoverState(inventory, live),
        session
      )} Otherwise claim this checkout under an agent ID of your own.`,
      EXIT_CODES.unsafe
    );
  }
  // Only the latest earlier claim on this checkout decides: a later approved
  // takeover moves the checkout's history to the session that took it.
  const [earlier] = owned
    .filter((claim) => claim.path === path)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (earlier && claimHeldByAnotherSession(document, earlier, session)) {
    throw new SimpleChangesError(
      `Agent ${agentId}'s earlier claim ${earlier.claimId} on ${path} (released: ${earlier.releaseReason ?? "unrecorded"}) belongs to another harness session, so this session cannot claim the checkout under that agent ID. A new session records the checkout under its own agent ID, with its own claim and pause.`,
      EXIT_CODES.unsafe
    );
  }
};

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
  const registered = lease.worktrees.find((item) => item.path === worktreePath);
  if (!registered) {
    return false;
  }
  if (!lease.controller || lease.controller.status === "active") {
    return true;
  }
  // A relinquished loop preserves work through the worktrees themselves, not
  // through claim ownership, so a stale claim on one of its registered paths
  // may be taken over. The exception is an adopted coordination linkage: a
  // resumed controller must still verify that exact claim and pause receipt.
  return registered.role === "preserved" && Boolean(registered.claimId);
};

/**
 * Why a loop that still requires this claim's path refuses its takeover, or
 * null when nothing refuses it. A path the loop requires stays protected,
 * with one exception: while the controller is active, the live claim on a
 * checkout the run registered as a concurrent author may be reassigned to
 * that controller itself. The controller then claims, pauses, and accepts
 * the checkout's exact state as the printed recovery says, so a vanished
 * author never forces the run to relinquish and freeze its shipment scope.
 */
const activeLoopTakeoverRefusal = (
  commonGitDirectory: string,
  claimPath: string,
  action: "reassign" | "release",
  newAgentId: string
): string | null => {
  if (!activeLoopNeedsPath(commonGitDirectory, claimPath)) {
    return null;
  }
  const lease = activeLoop(commonGitDirectory);
  const registered = lease?.worktrees.find((item) => item.path === claimPath);
  if (
    !(
      lease &&
      (!lease.controller || lease.controller.status === "active") &&
      registered?.role === "concurrent-author"
    )
  ) {
    return "An active loop lease still requires this claimed worktree; takeover is refused until the lease releases it.";
  }
  if (action === "reassign" && newAgentId === lease.ownerAgentId) {
    return null;
  }
  return `Run ${lease.runId} registers ${claimPath} as a concurrent author, so while its controller is active this claim may only be reassigned to that controller: pass --agent-id ${lease.ownerAgentId} without --release, then claim, pause, and accept the checkout as the controller.`;
};

export const assertNoGitOperation = (worktreePath: string): void => {
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

export type PauseBlocker = "absent" | "conflicts" | "git-operation";

/**
 * What stops `worktree pause` from recording this checkout as it stands, or
 * null: its directory is gone (Git keeps a locked registration unprunable
 * after deletion, so presence is read from disk), a Git operation is in
 * progress, or a path is conflicted. Recovery guidance asks the same question
 * before it prints a pause.
 */
export const pauseBlocker = (
  current: WorktreeInventory
): PauseBlocker | null => {
  if (current.prunable || !existsSync(current.path)) {
    return "absent";
  }
  try {
    assertNoGitOperation(current.path);
  } catch {
    return "git-operation";
  }
  return current.changes.some((change) => change.conflicted)
    ? "conflicts"
    : null;
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
  const opening = locateRepository(repositoryPath);
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
      const session = executingClaimSession();
      assertClaimantSession(
        document,
        inventory,
        existing,
        agentId,
        worktree,
        session
      );
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
        if (!claimNeedsRefresh(document, existing, worktree, session)) {
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
          now,
          claimEventId(session)
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
        now,
        claimEventId(session)
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
  const opening = locateRepository(repositoryPath);
  return withCoordinationLock(
    opening.repository.commonGitDirectory,
    "worktree pause",
    () => {
      const inventory = captureInventory(repositoryPath);
      const current = worktreeAt(inventory, pathInput);
      const blocker = pauseBlocker(current);
      if (blocker) {
        throw new SimpleChangesError(
          {
            absent: `Worktree ${current.path} no longer exists.`,
            conflicts: `Worktree ${current.path} has unresolved conflicts.`,
            "git-operation": `Worktree ${current.path} has an active Git operation.`,
          }[blocker],
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
      assertClaimSession(document, claim, current);
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
  const opening = locateRepository(repositoryPath);
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
      assertClaimSession(document, claim, current);
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
  const opening = locateRepository(repositoryPath);
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
      assertClaimSession(document, claim, claimTakeoverState(inventory, claim));
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

/**
 * The checkout's exact branch, head, and content digest when its owner
 * releases it, or undefined when the claimed directory is gone. A released
 * claim is never refreshed, so recording the released state lets an active
 * loop admit exactly that state and fail closed on any later change. Git does
 * not mark a locked worktree prunable when its directory is deleted, so the
 * directory itself must exist.
 */
const releasedEvidence = (
  inventory: RepositoryInventory,
  path: string
): Pick<WorktreeClaim, "branch" | "changeDigest" | "headSha"> | undefined => {
  const current = inventory.worktrees.find(
    (worktree) =>
      worktree.path === path && !worktree.prunable && existsSync(worktree.path)
  );
  return current
    ? {
        branch: current.branch,
        changeDigest: current.changeDigest,
        headSha: current.headSha,
      }
    : undefined;
};

export const releaseWorktreeClaim = (
  repositoryPath: string,
  agentIdInput: string,
  claimIdInput: string
): WorktreeClaim => {
  const agentId = requiredText(agentIdInput, "agent ID", 128);
  const claimId = requiredText(claimIdInput, "claim ID", 128);
  const { commonGitDirectory } = locateRepository(repositoryPath).repository;
  // Check the owner and capture the released state under the same lock as
  // the release, so a takeover cannot reassign the claim in between.
  return withCoordinationLock(commonGitDirectory, "worktree released", () => {
    const inventory = captureInventory(repositoryPath);
    const document =
      readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
    const claim = document.claims.find((item) => item.claimId === claimId);
    if (!claim || claim.owner.agentId !== agentId) {
      throw new SimpleChangesError(
        "Only the exact claim owner may release this worktree claim.",
        EXIT_CODES.unsafe
      );
    }
    assertClaimSession(document, claim, claimTakeoverState(inventory, claim));
    if (!LIVE_STATES.has(claim.state)) {
      throw new SimpleChangesError(
        `Claim ${claimId} cannot transition from ${claim.state} to released.`,
        EXIT_CODES.unsafe
      );
    }
    return releaseClaimUnderLock(
      commonGitDirectory,
      claimId,
      agentId,
      "owner-release",
      releasedEvidence(inventory, claim.path)
    );
  });
};

const releasedClaim = (
  claim: WorktreeClaim,
  releaseReason: WorktreeClaimReleaseReason,
  updatedAt: string
): WorktreeClaim => ({
  ...claim,
  releaseReason,
  state: "released",
  updatedAt,
});

/**
 * Release every live, non-detached claim whose worktree no longer appears in
 * the inventory or whose directory is gone (`prunable`). The caller must
 * already hold the coordination lock. Such a claim protects nothing: the
 * checkout is absent and branch protection is decided separately, so leaving
 * it active only strands the owner's bookkeeping until a manual takeover.
 */
export const releaseAbsentWorktreeClaimsUnderLock = (
  commonGitDirectory: string,
  inventory: RepositoryInventory,
  actorAgentIdInput: string
): WorktreeClaim[] => {
  const actorAgentId = requiredText(actorAgentIdInput, "agent ID", 128);
  const presentPaths = new Set(
    inventory.worktrees
      .filter((worktree) => !worktree.prunable)
      .map((worktree) => worktree.path)
  );
  let document =
    readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
  const released: WorktreeClaim[] = [];
  const now = new Date().toISOString();
  for (const claim of document.claims) {
    if (
      claim.commonGitDirectory !== commonGitDirectory ||
      !ABSENT_RELEASABLE_STATES.has(claim.state) ||
      presentPaths.has(claim.path)
    ) {
      continue;
    }
    const updated = releasedClaim(claim, "worktree-absent", now);
    document = appendEvent(
      replaceClaim(document, updated),
      claim.claimId,
      actorAgentId,
      "released",
      now
    );
    released.push(updated);
  }
  if (released.length > 0) {
    writeCoordinationDocument(commonGitDirectory, document);
  }
  return released;
};

/**
 * Release one exact active claim by ID with a recorded reason. The caller must
 * hold the coordination lock and must already have proven the authority for
 * the release (for example, the loop controller releasing its own claim after
 * the work is contained in the target).
 */
export const releaseClaimUnderLock = (
  commonGitDirectory: string,
  claimId: string,
  actorAgentIdInput: string,
  releaseReason: WorktreeClaimReleaseReason,
  currentEvidence?: Pick<WorktreeClaim, "branch" | "changeDigest" | "headSha">
): WorktreeClaim => {
  const actorAgentId = requiredText(actorAgentIdInput, "agent ID", 128);
  let document =
    readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
  const claim = document.claims.find((item) => item.claimId === claimId);
  if (!(claim && LIVE_STATES.has(claim.state))) {
    throw new SimpleChangesError(
      `Claim ${claimId} is not a live worktree claim.`,
      EXIT_CODES.unsafe
    );
  }
  const now = new Date().toISOString();
  // A completed-work release may record the checkout's exact current evidence,
  // so an active loop can recognize the handed-off state it now admits.
  const updated = releasedClaim(
    { ...claim, ...currentEvidence },
    releaseReason,
    now
  );
  document = appendEvent(
    replaceClaim(document, updated),
    claimId,
    actorAgentId,
    "released",
    now,
    currentEvidence
      ? `${RELEASED_STATE_EVENT_PREFIX}${randomUUID()}`
      : `event-${randomUUID()}`
  );
  writeCoordinationDocument(commonGitDirectory, document);
  return updated;
};

// The claim record is closed to new fields, so older clients that share the
// coordination file can still read it; a release that recorded the
// checkout's exact state at release time is marked in its event ID instead.
const RELEASED_STATE_EVENT_PREFIX = "event-released-state-";

/**
 * Whether a released claim's branch, head, and digest are the state its
 * release recorded from the present checkout, rather than evidence left from
 * an earlier claim or refresh (a release by an older client, or one whose
 * checkout was already gone).
 */
export const releaseRecordedState = (
  document: WorktreeCoordinationDocument,
  claimId: string
): boolean =>
  document.events.some(
    (event) =>
      event.claimId === claimId &&
      event.eventId.startsWith(RELEASED_STATE_EVENT_PREFIX)
  );

/**
 * Completed-work handoff: the author declares the checkout it is running in
 * finished, so its own live claim there is released and the work becomes an
 * ordinary stable unit that any controller may ship. A claim held by a
 * different owner is left untouched and reported as `null`.
 */
export const releaseHandoffWorktreeClaim = (
  repositoryPath: string,
  agentIdInput: string
): WorktreeClaim | null => {
  const agentId = requiredText(agentIdInput, "agent ID", 128);
  const opening = captureInventory(repositoryPath);
  const { commonGitDirectory, currentCheckout } = opening.repository;
  return withCoordinationLock(commonGitDirectory, "handoff release", () => {
    const document =
      readCoordinationDocumentFromCommonDirectory(commonGitDirectory);
    const claim = document.claims.find(
      (item) =>
        item.path === canonicalCandidate(currentCheckout) &&
        item.owner.agentId === agentId &&
        LIVE_STATES.has(item.state)
    );
    if (!claim) {
      return null;
    }
    assertClaimSession(
      document,
      claim,
      opening.worktrees.find((item) => item.path === claim.path) ?? null
    );
    return releaseClaimUnderLock(
      commonGitDirectory,
      claim.claimId,
      agentId,
      "handoff",
      releasedEvidence(captureInventory(repositoryPath), claim.path)
    );
  });
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
    const updated = releasedClaim(claim, "post-cleanup-recovery", retiredAt);
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
  /**
   * The branch the approval names, or null for a detached checkout. Every
   * clean checkout has the same status digest, so an approval also names the
   * exact branch and HEAD it covers.
   */
  expectedBranch: string | null;
  /** The exact HEAD commit the approval names, or null for none yet. */
  expectedHeadSha: string | null;
  expectedStatusDigest: string;
  newAgentId: string;
  reason: string;
  repositoryPath: string;
}

/** The exact checkout state a takeover approval names. */
interface TakeoverEvidence {
  branch: string | null;
  changeDigest: string;
  headSha: string | null;
}

const SAFE_COMMAND_WORD_PATTERN = /^[A-Za-z0-9._:/@%+=,-]+$/u;

// Quote a value only when a POSIX shell would split or expand it.
const commandWord = (value: string): string =>
  SAFE_COMMAND_WORD_PATTERN.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;

export interface TakeoverCommandInput {
  /** The new owner, or null for a `<you>` placeholder. */
  agentId: string | null;
  claimId: string;
  /** The checkout as observed now; placeholders stand in when it is gone. */
  current: Pick<
    WorktreeInventory,
    "branch" | "changeDigest" | "headSha"
  > | null;
  release?: boolean;
  /** Already quoted for the shell. */
  repo?: string;
}

/**
 * The approved `worktree takeover` for one claim, naming the checkout's exact
 * branch (or `--detached`), HEAD, and status digest for the approval to
 * cover. Only the approver and reason are left to fill in.
 */
export const takeoverCommand = (input: TakeoverCommandInput): string => {
  const { current } = input;
  let branch = "--branch <name>";
  if (current) {
    branch = current.branch
      ? `--branch ${commandWord(current.branch)}`
      : "--detached";
  }
  return [
    `simple-changes worktree takeover --claim-id ${input.claimId}`,
    `--agent-id ${input.agentId ? commandWord(input.agentId) : "<you>"}`,
    `--head ${current ? (current.headSha ?? "none") : "<sha>"}`,
    branch,
    `--status-digest ${current?.changeDigest ?? "<digest>"}`,
    "--approved-by <user> --reason <why>",
    ...(input.release ? ["--release"] : []),
    ...(input.repo ? [`--repo ${input.repo}`] : []),
  ].join(" ");
};

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
  expected: TakeoverEvidence
): WorktreeTakeoverReceipt | undefined => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (
      item?.phase === "intent" &&
      item.claimId === options.claimId &&
      item.action === options.action &&
      item.newAgentId === options.newAgentId &&
      item.changeDigest === expected.changeDigest &&
      item.branch === expected.branch &&
      item.headSha === expected.headSha &&
      item.approvedBy === options.approvedBy &&
      item.reason === options.reason
    ) {
      return item;
    }
  }
};

const recoverAppliedTakeoverIntent = (
  commonGitDirectory: string,
  history: WorktreeTakeoverReceipt[],
  document: WorktreeCoordinationDocument,
  claim: WorktreeClaim,
  intent: WorktreeTakeoverReceipt | undefined,
  session: string | null
): WorktreeTakeoverResult | null => {
  if (!intent) {
    return null;
  }
  // An earlier takeover by the same agent and approver leaves the same owner,
  // so a reassign counts as applied only when the claim also records this
  // intent's exact checkout state and belongs to this session, and a release
  // only when a takeover released it. Anything else runs every check again.
  const applied =
    intent.action === "release"
      ? claim.state === "released" && claim.releaseReason === "takeover"
      : claim.owner.agentId === intent.newAgentId &&
        claim.owner.ownerRef === `takeover:${intent.approvedBy}` &&
        claim.branch === intent.branch &&
        claim.headSha === intent.headSha &&
        claim.changeDigest === intent.changeDigest &&
        claimSessionBinding(document, claim) ===
          (session ? claimSessionDigest(session) : null);
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

// A stale claim is still unreleased and holds its checkout: its owner's
// pause found the checkout moved. Only an approved takeover moves it to
// another session, so it can be taken over like a live claim.
const TAKEOVER_STATES = new Set<WorktreeCoordinationState>([
  ...LIVE_STATES,
  "stale",
]);

/**
 * The state the takeover covers, once it is proven to be the one the
 * approval names. A reassign never covers a release-only state.
 */
const approvedTakeoverState = (
  inventory: RepositoryInventory,
  claim: WorktreeClaim,
  action: "reassign" | "release",
  newAgentId: string,
  expected: TakeoverEvidence
): TakeoverState => {
  const current = claimTakeoverState(inventory, claim);
  if (current.releaseOnly && action === "reassign") {
    throw new SimpleChangesError(
      `Claim ${claim.claimId}'s checkout ${claim.path} is gone and its recorded state can no longer be reattached, so it can only be released: ask the user to approve \`${takeoverCommand(
        { agentId: newAgentId, claimId: claim.claimId, current, release: true }
      )}\`.`,
      EXIT_CODES.unsafe
    );
  }
  if (
    current.changeDigest !== expected.changeDigest ||
    current.headSha !== expected.headSha ||
    current.branch !== expected.branch
  ) {
    throw new SimpleChangesError(
      `The worktree changed since it was observed: it is now ${current.branch ? `on branch ${current.branch}` : "detached"} at ${current.headSha ?? "no commit"} with status digest ${current.changeDigest}. The approval names one exact branch, HEAD, and status digest, so re-observe the worktree, confirm the current state with the approver, and retry the takeover with fresh evidence.`,
      EXIT_CODES.unsafe
    );
  }
  return current;
};

// The exact checkout state the approval names, validated.
const takeoverEvidence = (
  options: WorktreeTakeoverOptions
): TakeoverEvidence => {
  const expected: TakeoverEvidence = {
    branch:
      options.expectedBranch === null
        ? null
        : requiredText(options.expectedBranch, "expected branch", 255),
    changeDigest: requiredText(
      options.expectedStatusDigest,
      "expected status digest",
      64
    ),
    headSha:
      options.expectedHeadSha === null
        ? null
        : requiredText(options.expectedHeadSha, "expected HEAD", 64),
  };
  if (expected.headSha !== null && !SHA_PATTERN.test(expected.headSha)) {
    throw new SimpleChangesError(
      "expected HEAD must be the checkout's full commit ID.",
      EXIT_CODES.usage
    );
  }
  return expected;
};

export const takeoverWorktreeClaim = (
  options: WorktreeTakeoverOptions
): WorktreeTakeoverResult => {
  const claimId = requiredText(options.claimId, "claim ID", 128);
  const newAgentId = requiredText(options.newAgentId, "new agent ID", 128);
  const approvedBy = requiredText(options.approvedBy, "approver", 128);
  const reason = requiredText(options.reason, "takeover reason");
  const expected = takeoverEvidence(options);
  if (options.action !== "reassign" && options.action !== "release") {
    throw new SimpleChangesError(
      'takeover action must be "reassign" or "release".',
      EXIT_CODES.usage
    );
  }
  const opening = locateRepository(options.repositoryPath);
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
        expected
      );
      const session = executingClaimSession();
      const recovered = recoverAppliedTakeoverIntent(
        commonGitDirectory,
        takeoverHistory,
        document,
        claim,
        pendingIntent,
        session
      );
      if (recovered) {
        return recovered;
      }
      if (!TAKEOVER_STATES.has(claim.state)) {
        throw new SimpleChangesError(
          `Claim ${claimId} is ${claim.state}; only a live claim can be taken over.`,
          EXIT_CODES.unsafe
        );
      }
      const current = approvedTakeoverState(
        inventory,
        claim,
        options.action,
        newAgentId,
        expected
      );
      const loopRefusal = activeLoopTakeoverRefusal(
        commonGitDirectory,
        claim.path,
        options.action,
        newAgentId
      );
      if (loopRefusal) {
        throw new SimpleChangesError(loopRefusal, EXIT_CODES.unsafe);
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
      // A reassigned claim records the exact state the approval named, so the
      // new owner's claim and pause bind that state without a refresh step.
      const updated: WorktreeClaim =
        options.action === "reassign"
          ? {
              ...claim,
              branch: current.branch,
              changeDigest: current.changeDigest,
              headSha: current.headSha,
              owner: {
                adapter: claim.owner.adapter,
                agentId: newAgentId,
                ownerRef: `takeover:${approvedBy}`,
              },
              updatedAt: takenOverAt,
            }
          : releasedClaim(claim, "takeover", takenOverAt);
      document = appendEvent(
        replaceClaim(document, updated),
        claimId,
        newAgentId,
        updated.state,
        takenOverAt,
        takeoverEventId(options.action, session)
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
