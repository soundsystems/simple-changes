import { basename } from "node:path";
import {
  decideEmergencyShipping,
  deriveEmergencyShippingStatus,
} from "./emergency-shipping.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { assertExecGuardAllows, execGuardFor } from "./exec-guard.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import {
  assertControllerActive,
  assertMatchingRun,
  assertShipmentScopeRecorded,
  ownerProcessEvidence,
  readLoopLease,
  refreshControllerSession,
  requiredText,
  requireLease,
  targetUsesGitLab,
  withAsyncStateLock,
  withMutationEvidence,
  withStateLock,
  writeLease,
} from "./loop-lease-core.ts";
import { assertPinnedHeads, verificationAgainst } from "./loop-lease-verify.ts";
import {
  assertCommandSucceeded,
  type CommandProcess,
  type CommandResult,
  GuardedProcessGroupStillAliveError,
  runInProcessGroup,
} from "./process.ts";
import { validateSchema } from "./schema.ts";
import type {
  EmergencyShippingLedgerEntry,
  LoopLease,
  LoopVerification,
  RepositoryInventory,
} from "./types.ts";

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
        // Pinned heads are a lease check, so they refuse before the guard.
        assertPinnedHeads(requireLease(inventory), inventory, argv, {
          agentId: agentIdInput,
          checkout,
          runId,
        });
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
