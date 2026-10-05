import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  type CommandProcess,
  GuardedProcessGroupStillAliveError,
  runGuardInProcessGroup,
} from "./process.ts";
import type { RepositoryInventory } from "./types.ts";

/** Environment a policy `execGuard` receives beside the exec command argv. */
export const EXEC_GUARD_RUN_ID_VARIABLE = "SIMPLE_CHANGES_RUN_ID";
export const EXEC_GUARD_REPOSITORY_VARIABLE = "SIMPLE_CHANGES_REPOSITORY";

/**
 * The `execGuard` argv from the repository's own `.simple-changes.json`, or
 * null. Personal preferences never supply one: a guard is repository code.
 * The guard only restricts `loop exec`, so it applies whether or not the
 * repository policy carries a trust receipt.
 */
export const execGuardFor = (
  inventory: RepositoryInventory
): readonly string[] | null => {
  const guard = inventory.policy.value.execGuard;
  return inventory.policy.source === "repository" && guard && guard.length > 0
    ? guard
    : null;
};

const describe = (argv: readonly string[]): string => JSON.stringify(argv);

export interface ExecGuardInvocation {
  /** The checkout the exec command runs in; also the guard's cwd. */
  checkout: string;
  /** The exec command argv, appended after the guard's own argv. */
  command: readonly string[];
  guard: readonly string[];
  onSpawn: (process: CommandProcess) => void;
  runId: string;
}

/**
 * Runs `[...guard, ...command]` before `loop exec` starts its child. Exit 0
 * allows the command; any other exit, or a guard that cannot start, refuses
 * it before the child exists. The guard decides which commands it gates and
 * must exit 0 for the rest.
 */
export const assertExecGuardAllows = async ({
  checkout,
  command,
  guard,
  onSpawn,
  runId,
}: ExecGuardInvocation): Promise<void> => {
  const [executable, ...guardArgs] = guard;
  if (!executable) {
    return;
  }
  let exitCode = 0;
  let failure: unknown;
  try {
    exitCode = await runGuardInProcessGroup(
      executable,
      [...guardArgs, ...command],
      checkout,
      onSpawn,
      {
        [EXEC_GUARD_REPOSITORY_VARIABLE]: checkout,
        [EXEC_GUARD_RUN_ID_VARIABLE]: runId,
      }
    );
  } catch (error) {
    failure = error;
  }
  // A guard whose process group survives keeps the lock for explicit
  // recovery, exactly like a guarded exec child.
  if (failure instanceof GuardedProcessGroupStillAliveError) {
    throw failure;
  }
  if (failure !== undefined) {
    throw new SimpleChangesError(
      `Repository execGuard ${describe(guard)} could not run, so loop exec refused ${describe(command)} without starting it: ${
        failure instanceof Error ? failure.message : String(failure)
      }`,
      EXIT_CODES.unsafe,
      { cause: failure }
    );
  }
  if (exitCode !== 0) {
    throw new SimpleChangesError(
      `Repository execGuard ${describe(guard)} exited ${exitCode}, so loop exec refused ${describe(command)} without starting it.`,
      EXIT_CODES.unsafe
    );
  }
};
