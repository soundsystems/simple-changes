import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "bun";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { redactSecrets } from "./redact.ts";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface CommandProcess {
  childPid: number;
  processGroupId: number | null;
}

export class GuardedProcessGroupStillAliveError extends SimpleChangesError {
  readonly processGroupId: number;

  constructor(command: string, processGroupId: number) {
    super(
      `${command} left guarded process group ${processGroupId} alive and it could not be terminated; the active-loop lock was retained for explicit recovery.`,
      EXIT_CODES.unsafe
    );
    this.name = "GuardedProcessGroupStillAliveError";
    this.processGroupId = processGroupId;
  }
}

const textDecoder = new TextDecoder();
const PROCESS_GROUP_EXIT_GRACE_MS = 1000;
const PROCESS_GROUP_POLL_MS = 25;

const processGroupIsAlive = (processGroupId: number): boolean => {
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const pollForProcessGroupExit = async (
  processGroupId: number,
  deadline: number
): Promise<boolean> => {
  if (!processGroupIsAlive(processGroupId)) {
    return true;
  }
  if (Date.now() >= deadline) {
    return false;
  }
  await delay(PROCESS_GROUP_POLL_MS);
  return pollForProcessGroupExit(processGroupId, deadline);
};

const waitForProcessGroupExit = (
  processGroupId: number,
  timeoutMs: number
): Promise<boolean> =>
  pollForProcessGroupExit(processGroupId, Date.now() + timeoutMs);

const terminateLingeringProcessGroup = async (
  processGroupId: number
): Promise<boolean> => {
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
  if (
    await waitForProcessGroupExit(processGroupId, PROCESS_GROUP_EXIT_GRACE_MS)
  ) {
    return true;
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
  return waitForProcessGroupExit(processGroupId, PROCESS_GROUP_EXIT_GRACE_MS);
};

const lingeringProcessGroupError = async (
  command: string,
  firstArgument: string | undefined,
  processGroupId: number
): Promise<SimpleChangesError | null> => {
  if (process.platform === "win32" || !processGroupIsAlive(processGroupId)) {
    return null;
  }
  let terminated = false;
  try {
    terminated = await terminateLingeringProcessGroup(processGroupId);
  } catch {
    terminated = !processGroupIsAlive(processGroupId);
  }
  return terminated
    ? new SimpleChangesError(
        `${command} ${firstArgument ?? ""} left background processes in guarded process group ${processGroupId}; they were terminated before releasing the loop lease.`,
        EXIT_CODES.unsafe
      )
    : new GuardedProcessGroupStillAliveError(command, processGroupId);
};

export const runCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
  allowFailure = false
): CommandResult => {
  const result = spawnSync([command, ...args], {
    cwd,
    env: {
      ...process.env,
      LC_ALL: "C",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = textDecoder.decode(result.stdout);
  const stderr = textDecoder.decode(result.stderr);
  const { exitCode } = result;
  if (exitCode !== 0 && !allowFailure) {
    const detail = redactSecrets(stderr.trim() || stdout.trim());
    throw new SimpleChangesError(
      `${command} ${args[0] ?? ""} failed${detail ? `: ${detail}` : ""}`,
      EXIT_CODES.inventory
    );
  }
  return { exitCode, stderr, stdout };
};

export const runCommandInProcessGroup = (
  command: string,
  args: readonly string[],
  cwd: string,
  onSpawn: (process: CommandProcess) => void
): Promise<CommandResult> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    const childPid = child.pid;
    if (!childPid) {
      child.kill();
      rejectPromise(
        new SimpleChangesError(
          `Could not start guarded command ${command}.`,
          EXIT_CODES.inventory
        )
      );
      return;
    }
    try {
      onSpawn({
        childPid,
        processGroupId: process.platform === "win32" ? null : childPid,
      });
    } catch (error) {
      child.kill();
      rejectPromise(error);
      return;
    }
    child.once("close", async (code) => {
      const exitCode = code ?? 1;
      const processGroupError = await lingeringProcessGroupError(
        command,
        args[0],
        childPid
      );
      if (processGroupError) {
        rejectPromise(processGroupError);
        return;
      }
      if (exitCode !== 0) {
        const detail = redactSecrets(stderr.trim() || stdout.trim());
        rejectPromise(
          new SimpleChangesError(
            `${command} ${args[0] ?? ""} failed${detail ? `: ${detail}` : ""}`,
            EXIT_CODES.inventory
          )
        );
        return;
      }
      resolvePromise({ exitCode, stderr, stdout });
    });
  });

export const runGit = (
  cwd: string,
  args: readonly string[],
  allowFailure = false
): CommandResult => runCommand("git", ["-C", cwd, ...args], cwd, allowFailure);
