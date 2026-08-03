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
import { basename, dirname, resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { captureInventory } from "./inventory.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";
import type {
  LoopLease,
  LoopOverride,
  LoopVerification,
  LoopViolation,
  LoopWorktreeLease,
  RepositoryInventory,
  RequestMode,
  WorktreeInventory,
} from "./types.ts";

const STATE_DIRECTORY = "simple-changes";
const STATE_FILENAME = "active-loop.json";
const LOCK_DIRECTORY = "active-loop.lock";
const RUN_ID_PATTERN = /^run-[a-z0-9-]+$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const LOOP_MODES = new Set<RequestMode>([
  "queue",
  "sweep",
  "integrate",
  "ship",
  "reconcile",
  "resume",
]);

const stateDirectory = (commonGitDirectory: string): string =>
  resolve(commonGitDirectory, STATE_DIRECTORY);

export const loopLeasePath = (commonGitDirectory: string): string =>
  resolve(stateDirectory(commonGitDirectory), STATE_FILENAME);

const loopLockPath = (commonGitDirectory: string): string =>
  resolve(stateDirectory(commonGitDirectory), LOCK_DIRECTORY);

const withStateLock = <T>(
  commonGitDirectory: string,
  operation: () => T
): T => {
  const directory = stateDirectory(commonGitDirectory);
  const lockPath = loopLockPath(commonGitDirectory);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // biome-ignore lint/style/useErrorCause: SimpleChangesError forwards ErrorOptions to Error.
      throw new SimpleChangesError(
        `Active-loop state is busy at ${lockPath}; retry after the current lease operation finishes.`,
        EXIT_CODES.unsafe,
        { cause: error }
      );
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { force: true, recursive: true });
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
  mutationAllowed: role !== "preserved",
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
  for (const worktree of inventory.worktrees) {
    const registered = registeredByPath.get(worktree.path);
    if (!registered) {
      violations.push({
        changeDigest: worktree.changeDigest,
        code: "unregistered-worktree",
        headSha: worktree.headSha,
        message:
          "A worktree appeared after loop start without run registration. Preserve it and prepare an isolated agent worktree instead.",
        path: worktree.path,
      });
      continue;
    }
    if (
      registered.role === "preserved" &&
      (registered.baselineHeadSha !== worktree.headSha ||
        registered.baselineChangeDigest !== worktree.changeDigest) &&
      !matchingOverride(lease, worktree)
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
  }
  for (const registered of lease.worktrees) {
    if (
      registered.role === "preserved" &&
      !currentByPath.has(registered.path)
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
  return lease;
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
  const inventory = captureInventory(repositoryPath);
  return withStateLock(inventory.repository.commonGitDirectory, () => {
    const existing = readLeaseFromCommonDirectory(
      inventory.repository.commonGitDirectory
    );
    if (existing) {
      if (existing.ownerAgentId === agentId && existing.mode === mode) {
        return existing;
      }
      throw new SimpleChangesError(
        `Loop ${existing.runId} is already active for ${existing.ownerAgentId}. Start no second shipping loop in this repository.`,
        EXIT_CODES.unsafe
      );
    }
    const now = new Date().toISOString();
    const currentPath = inventory.repository.currentCheckout;
    const worktrees = inventory.worktrees.map((worktree) =>
      worktreeLease(
        worktree,
        worktree.path === currentPath ? "controller" : "preserved",
        worktree.path === currentPath ? agentId : null,
        false
      )
    );
    const lease: LoopLease = {
      baselineDigest: inventory.baselineDigest,
      commonGitDirectory: inventory.repository.commonGitDirectory,
      createdAt: now,
      mode: mode as LoopLease["mode"],
      overrides: [],
      ownerAgentId: agentId,
      primaryCheckout: inventory.repository.primaryCheckout,
      runId: `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      schemaVersion: 1,
      targetRef: inventory.targetRef,
      updatedAt: now,
      worktrees,
    };
    return writeLease(lease);
  });
};

export const verifyLoop = (repositoryPath: string): LoopVerification => {
  const inventory = captureInventory(repositoryPath);
  const lease = readLeaseFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  if (!lease) {
    return {
      active: false,
      checkedAt: new Date().toISOString(),
      currentBaselineDigest: inventory.baselineDigest,
      ok: true,
      runId: null,
      violations: [],
    };
  }
  return verificationAgainst(lease, inventory);
};

export const guardLoopMutation = (
  repositoryPath: string,
  runId: string,
  agentIdInput: string
): LoopVerification => {
  const agentId = requiredText(agentIdInput, "agent ID");
  const inventory = captureInventory(repositoryPath);
  return withStateLock(inventory.repository.commonGitDirectory, () => {
    const lease = requireLease(inventory);
    assertMatchingRun(lease, runId);
    const currentPath = inventory.repository.currentCheckout;
    const registered = lease.worktrees.find(
      (worktree) => worktree.path === currentPath
    );
    if (!registered?.mutationAllowed || registered.agentId !== agentId) {
      throw new SimpleChangesError(
        `Agent ${agentId} is not allowed to mutate ${currentPath}. Run prepare-agent first and continue from its returned worktree path.`,
        EXIT_CODES.unsafe
      );
    }
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
  });
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
  const inventory = captureInventory(repositoryPath);
  return withStateLock(inventory.repository.commonGitDirectory, () => {
    const lease = requireLease(inventory);
    assertMatchingRun(lease, runId);
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
      return {
        agentId,
        baseRevision: existing.baselineHeadSha ?? lease.targetRef,
        branch: existing.branch,
        created: false,
        path: existing.path,
        runId: lease.runId,
      };
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
    const repositorySlug = slug(basename(lease.primaryCheckout), "repository");
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
    const baseRevision = runGit(lease.primaryCheckout, [
      "rev-parse",
      "--verify",
      `${lease.targetRef}^{commit}`,
    ]).stdout.trim();
    mkdirSync(dirname(path), { recursive: true });
    runGit(lease.primaryCheckout, [
      "worktree",
      "add",
      "-b",
      branch,
      path,
      baseRevision,
    ]);
    const refreshed = captureInventory(path);
    const createdWorktree = refreshed.worktrees.find(
      (worktree) => worktree.path === realpathSync(path)
    );
    if (!createdWorktree) {
      throw new SimpleChangesError(
        `Git created ${path}, but inventory could not register it.`,
        EXIT_CODES.inventory
      );
    }
    writeLease({
      ...lease,
      updatedAt: new Date().toISOString(),
      worktrees: [
        ...lease.worktrees,
        worktreeLease(createdWorktree, "author", agentId, true),
      ],
    });
    return {
      agentId,
      baseRevision,
      branch,
      created: true,
      path: createdWorktree.path,
      runId: lease.runId,
    };
  });
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
  const inventory = captureInventory(repositoryPath);
  return withStateLock(inventory.repository.commonGitDirectory, () => {
    const lease = requireLease(inventory);
    assertMatchingRun(lease, runId);
    if (lease.ownerAgentId !== ownerAgentId) {
      throw new SimpleChangesError(
        `Only loop owner ${lease.ownerAgentId} may record an override.`,
        EXIT_CODES.unsafe
      );
    }
    const path = existsSync(pathInput)
      ? realpathSync(pathInput)
      : resolve(pathInput);
    const registered = lease.worktrees.find(
      (worktree) => worktree.path === path && worktree.role === "preserved"
    );
    const current = inventory.worktrees.find(
      (worktree) => worktree.path === path
    );
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
  });
};

export const endLoop = (
  repositoryPath: string,
  runId: string,
  ownerAgentIdInput: string
): LoopVerification => {
  const ownerAgentId = requiredText(ownerAgentIdInput, "agent ID");
  const inventory = captureInventory(repositoryPath);
  return withStateLock(inventory.repository.commonGitDirectory, () => {
    const lease = requireLease(inventory);
    assertMatchingRun(lease, runId);
    if (lease.ownerAgentId !== ownerAgentId) {
      throw new SimpleChangesError(
        `Only loop owner ${lease.ownerAgentId} may end this loop.`,
        EXIT_CODES.unsafe
      );
    }
    const verification = verificationAgainst(lease, inventory);
    if (!verification.ok) {
      throw new SimpleChangesError(
        `Cannot end loop with manifest violations: ${verification.violations
          .map((violation) => `${violation.code}:${violation.path}`)
          .join(", ")}`,
        EXIT_CODES.unsafe
      );
    }
    const liveRunWorktrees = lease.worktrees.filter(
      (worktree) =>
        worktree.createdByRun &&
        inventory.worktrees.some((current) => current.path === worktree.path)
    );
    if (liveRunWorktrees.length > 0) {
      throw new SimpleChangesError(
        `Remove run-created worktrees before ending the loop: ${liveRunWorktrees
          .map((worktree) => worktree.path)
          .join(", ")}`,
        EXIT_CODES.unsafe
      );
    }
    rmSync(loopLeasePath(lease.commonGitDirectory), { force: true });
    return verification;
  });
};

export const loopStatus = (
  repositoryPath: string
): { lease: LoopLease | null; verification: LoopVerification } => ({
  lease: readLoopLease(repositoryPath),
  verification: verifyLoop(repositoryPath),
});

export const loopManifestDigest = (lease: LoopLease): string =>
  sha256(JSON.stringify(lease));
