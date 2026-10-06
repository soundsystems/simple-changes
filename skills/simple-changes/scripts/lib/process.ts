import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawnSync, which } from "bun";
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

const runCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
  allowFailure = false,
  displayName = command
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
      `${displayName} ${args[0] ?? ""} failed${detail ? `: ${detail}` : ""}`,
      EXIT_CODES.inventory
    );
  }
  return { exitCode, stderr, stdout };
};

const XCRUN_GIT_SHIM = "/usr/bin/git";

export interface GitExecutableProbe {
  platform: NodeJS.Platform;
  realpath: (path: string) => string;
  which: (command: string) => string | null;
  xcrunFind: () => string | null;
}

// On macOS `/usr/bin/git` is an xcrun shim that locates the active developer
// directory before every exec, which costs far more than most read-only Git
// commands themselves. Resolve the binary it would run once per process and
// call that directly; any other Git on PATH, or a failed lookup, keeps `git`.
export const resolveGitExecutable = (probe: GitExecutableProbe): string => {
  if (probe.platform !== "darwin") {
    return "git";
  }
  const onPath = probe.which("git");
  if (!onPath) {
    return "git";
  }
  let resolvedOnPath: string;
  try {
    resolvedOnPath = probe.realpath(onPath);
  } catch {
    return "git";
  }
  if (resolvedOnPath !== XCRUN_GIT_SHIM) {
    return "git";
  }
  const developerGit = probe.xcrunFind();
  return developerGit &&
    isAbsolute(developerGit) &&
    developerGit !== XCRUN_GIT_SHIM
    ? developerGit
    : "git";
};

const xcrunFindGit = (): string | null => {
  const result = spawnSync(["xcrun", "--find", "git"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    return null;
  }
  const path = textDecoder.decode(result.stdout).trim();
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return null;
  }
  return path;
};

let cachedGitExecutable: string | undefined;

export const gitExecutable = (): string => {
  cachedGitExecutable ??= resolveGitExecutable({
    platform: process.platform,
    realpath: realpathSync,
    which: (command) => which(command),
    xcrunFind: xcrunFindGit,
  });
  return cachedGitExecutable;
};

interface ProcessGroupRunOptions {
  /** Extra environment for the child, on top of this process's own. */
  environment: Record<string, string>;
  /** Stream the child's output to this process's stderr instead of capturing it. */
  streamOutputToStderr: boolean;
}

/**
 * Runs one command in its own process group and resolves with its exit code,
 * whatever it is. Rejects when the command cannot start or leaves a
 * background descendant behind.
 */
const runInProcessGroup = (
  command: string,
  args: readonly string[],
  cwd: string,
  onSpawn: (process: CommandProcess) => void,
  options: ProcessGroupRunOptions
): Promise<CommandResult> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...options.environment,
      },
      stdio: options.streamOutputToStderr
        ? ["ignore", 2, 2]
        : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
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
      // The command may already have started descendants. Once the leader
      // exits, terminate the whole group; a group that survives keeps the
      // lock, exactly like one left behind by a finished command.
      child.once("exit", async () => {
        const processGroupError = await lingeringProcessGroupError(
          command,
          args[0],
          childPid
        );
        rejectPromise(
          processGroupError instanceof GuardedProcessGroupStillAliveError
            ? processGroupError
            : error
        );
      });
      child.kill("SIGKILL");
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
      resolvePromise({ exitCode, stderr, stdout });
    });
  });

export const runCommandInProcessGroup = async (
  command: string,
  args: readonly string[],
  cwd: string,
  onSpawn: (process: CommandProcess) => void
): Promise<CommandResult> => {
  const result = await runInProcessGroup(command, args, cwd, onSpawn, {
    environment: { LC_ALL: "C" },
    streamOutputToStderr: false,
  });
  if (result.exitCode !== 0) {
    const detail = redactSecrets(result.stderr.trim() || result.stdout.trim());
    throw new SimpleChangesError(
      `${command} ${args[0] ?? ""} failed${detail ? `: ${detail}` : ""}`,
      EXIT_CODES.inventory
    );
  }
  return result;
};

/**
 * Runs a policy-declared guard in its own process group with its output on
 * this process's stderr, so `--json` stdout stays machine-readable. Resolves
 * with the guard's exit code; the caller decides what a refusal means.
 */
export const runGuardInProcessGroup = async (
  command: string,
  args: readonly string[],
  cwd: string,
  onSpawn: (process: CommandProcess) => void,
  environment: Record<string, string>
): Promise<number> =>
  (
    await runInProcessGroup(command, args, cwd, onSpawn, {
      environment,
      streamOutputToStderr: true,
    })
  ).exitCode;

export const runGit = (
  cwd: string,
  args: readonly string[],
  allowFailure = false
): CommandResult =>
  runCommand(gitExecutable(), ["-C", cwd, ...args], cwd, allowFailure, "git");

export interface GitRequest {
  args: readonly string[];
  cwd: string;
}

// Below this many requests the worker's own startup costs more than it saves.
const CONCURRENT_GIT_MINIMUM = 4;
const CONCURRENT_GIT_LIMIT = 8;
const GIT_WORKER_PATH = fileURLToPath(
  new URL("./git-worker.ts", import.meta.url)
);

const concurrentGitResults = (
  requests: readonly GitRequest[]
): (CommandResult | null)[] | null => {
  const worker = spawnSync([process.execPath, GIT_WORKER_PATH], {
    env: {
      ...process.env,
      LC_ALL: "C",
    },
    stderr: "pipe",
    stdin: Buffer.from(
      JSON.stringify({
        concurrency: CONCURRENT_GIT_LIMIT,
        executable: gitExecutable(),
        requests,
      })
    ),
    stdout: "pipe",
  });
  if (worker.exitCode !== 0) {
    return null;
  }
  let reply: unknown;
  try {
    reply = JSON.parse(textDecoder.decode(worker.stdout));
  } catch {
    return null;
  }
  if (!Array.isArray(reply) || reply.length !== requests.length) {
    return null;
  }
  return reply.map((item: unknown) => {
    const result = item as { exitCode?: unknown; stdout?: unknown } | null;
    if (
      typeof result?.exitCode !== "number" ||
      typeof result.stdout !== "string"
    ) {
      return null;
    }
    return {
      exitCode: result.exitCode,
      stderr: "",
      stdout: textDecoder.decode(Buffer.from(result.stdout, "base64")),
    };
  });
};

/**
 * Runs independent read-only Git commands concurrently and returns results in
 * request order with the stdout `runGit` would return without
 * `allowFailure`; stderr is not collected on success. The
 * inventory is synchronous, so the fan-out happens in one short-lived worker
 * process. Any request the worker did not complete successfully, or every
 * request when the worker itself fails, runs again through `runGit`, so
 * output and failures are identical to the sequential path.
 */
export const runGitConcurrently = (
  requests: readonly GitRequest[]
): CommandResult[] => {
  const results =
    requests.length >= CONCURRENT_GIT_MINIMUM
      ? concurrentGitResults(requests)
      : null;
  return requests.map((request, index) => {
    const result = results?.[index];
    return result && result.exitCode === 0
      ? result
      : runGit(request.cwd, request.args);
  });
};

const REMOTE_GIT_TIMEOUT_MS = 30_000;

/**
 * Run a network Git command (`ls-remote`, `fetch`, `push`) that must never
 * wait for a person: terminal credential prompts are disabled, SSH runs in
 * batch mode unless the user configured their own SSH command, and the
 * command is killed after a bounded time. Failures are returned, not thrown.
 */
export const runGitRemote = (
  cwd: string,
  args: readonly string[],
  timeoutMs = REMOTE_GIT_TIMEOUT_MS
): CommandResult => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GCM_INTERACTIVE: "never",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  const customSsh =
    process.env.GIT_SSH_COMMAND ||
    process.env.GIT_SSH ||
    runGit(cwd, ["config", "--get", "core.sshCommand"], true).stdout.trim();
  if (!customSsh) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }
  const result = spawnSync([gitExecutable(), "-C", cwd, ...args], {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
    timeout: timeoutMs,
  });
  const stdout = textDecoder.decode(result.stdout);
  const stderr = textDecoder.decode(result.stderr);
  if (result.exitCode === null) {
    return {
      exitCode: 124,
      stderr: `git ${args[0] ?? ""} did not finish within ${timeoutMs} ms.`,
      stdout,
    };
  }
  return { exitCode: result.exitCode, stderr, stdout };
};

/** Run Git with `input` on stdin, for plumbing such as `hash-object --stdin`. */
export const runGitWithInput = (
  cwd: string,
  args: readonly string[],
  input: string,
  env: Record<string, string> = {}
): CommandResult => {
  const result = spawnSync([gitExecutable(), "-C", cwd, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
      LC_ALL: "C",
    },
    stderr: "pipe",
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
  });
  const stdout = textDecoder.decode(result.stdout);
  const stderr = textDecoder.decode(result.stderr);
  if (result.exitCode !== 0) {
    const detail = redactSecrets(stderr.trim() || stdout.trim());
    throw new SimpleChangesError(
      `git ${args[0] ?? ""} failed${detail ? `: ${detail}` : ""}`,
      EXIT_CODES.inventory
    );
  }
  return { exitCode: result.exitCode, stderr, stdout };
};
