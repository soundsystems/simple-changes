import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { accessSync, constants, readlinkSync, realpathSync } from "node:fs";
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
// A taskkill that hangs must not hold the run open; the lock is kept anyway.
const TASKKILL_TIMEOUT_MS = 10_000;

/**
 * Everything process-group cleanup touches outside this process. Production
 * uses `PROCESS_GROUP_CONTROL`; tests substitute failures deterministically.
 */
export interface ProcessGroupControl {
  /** How long to wait for a group to exit after each signal. */
  graceMs: number;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  platform: NodeJS.Platform;
  /** Runs a command to completion, stopping it after `timeoutMs`. */
  runSync: (argv: string[], timeoutMs: number) => void;
}

export const PROCESS_GROUP_CONTROL: ProcessGroupControl = {
  graceMs: PROCESS_GROUP_EXIT_GRACE_MS,
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  platform: process.platform,
  runSync: (argv, timeoutMs) => {
    spawnSync(argv, { stderr: "ignore", stdout: "ignore", timeout: timeoutMs });
  },
};

const processGroupIsAlive = (
  processGroupId: number,
  control: ProcessGroupControl
): boolean => {
  if (control.platform === "win32") {
    return false;
  }
  try {
    control.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const pollForProcessGroupExit = async (
  processGroupId: number,
  deadline: number,
  control: ProcessGroupControl
): Promise<boolean> => {
  if (!processGroupIsAlive(processGroupId, control)) {
    return true;
  }
  if (Date.now() >= deadline) {
    return false;
  }
  await delay(PROCESS_GROUP_POLL_MS);
  return pollForProcessGroupExit(processGroupId, deadline, control);
};

const waitForProcessGroupExit = (
  processGroupId: number,
  control: ProcessGroupControl
): Promise<boolean> =>
  pollForProcessGroupExit(
    processGroupId,
    Date.now() + control.graceMs,
    control
  );

const signalProcessGroup = (
  processGroupId: number,
  signal: NodeJS.Signals,
  control: ProcessGroupControl
): void => {
  try {
    control.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
};

const terminateLingeringProcessGroup = async (
  processGroupId: number,
  control: ProcessGroupControl
): Promise<boolean> => {
  signalProcessGroup(processGroupId, "SIGTERM", control);
  if (await waitForProcessGroupExit(processGroupId, control)) {
    return true;
  }
  signalProcessGroup(processGroupId, "SIGKILL", control);
  return waitForProcessGroupExit(processGroupId, control);
};

const lingeringProcessGroupError = async (
  command: string,
  firstArgument: string | undefined,
  processGroupId: number,
  control: ProcessGroupControl = PROCESS_GROUP_CONTROL
): Promise<SimpleChangesError | null> => {
  if (
    control.platform === "win32" ||
    !processGroupIsAlive(processGroupId, control)
  ) {
    return null;
  }
  let terminated = false;
  try {
    terminated = await terminateLingeringProcessGroup(processGroupId, control);
  } catch {
    terminated = !processGroupIsAlive(processGroupId, control);
  }
  return terminated
    ? new SimpleChangesError(
        `${command} ${firstArgument ?? ""} left background processes in guarded process group ${processGroupId}; they were terminated before releasing the loop lease.`,
        EXIT_CODES.unsafe
      )
    : new GuardedProcessGroupStillAliveError(command, processGroupId);
};

/**
 * Terminates a command whose registration failed, with no wait on its leader.
 * On Unix the leader's whole process group is terminated, and a group that
 * survives (or cannot be signalled) keeps the lock. Windows has no group to
 * prove empty, so it attempts to kill the process tree, bounded by a timeout,
 * and always keeps the lock.
 */
export const unregisteredCommandCleanup = async (
  command: string,
  childPid: number,
  control: ProcessGroupControl = PROCESS_GROUP_CONTROL
): Promise<GuardedProcessGroupStillAliveError | null> => {
  if (control.platform === "win32") {
    try {
      control.runSync(
        ["taskkill", "/pid", String(childPid), "/t", "/f"],
        TASKKILL_TIMEOUT_MS
      );
    } catch {
      // The lock is kept below whether or not taskkill could run.
    }
    return new GuardedProcessGroupStillAliveError(command, childPid);
  }
  let terminated = false;
  try {
    terminated = await terminateLingeringProcessGroup(childPid, control);
  } catch {
    terminated = !processGroupIsAlive(childPid, control);
  }
  return terminated
    ? null
    : new GuardedProcessGroupStillAliveError(command, childPid);
};

const runCommand = (
  command: string,
  args: readonly string[],
  cwd: string,
  allowFailure = false,
  displayName = command,
  environment: Record<string, string> = {}
): CommandResult => {
  const result = spawnSync([command, ...args], {
    cwd,
    env: {
      ...process.env,
      ...environment,
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
  /**
   * The developer Git the shim would run, found from DEVELOPER_DIR, the
   * xcode-select link, or the Command Line Tools without running xcrun,
   * whose lookup cache is a write.
   */
  developerGit?: () => string | null;
  platform: NodeJS.Platform;
  realpath: (path: string) => string;
  which: (command: string) => string | null;
  xcrunFind: () => string | null;
}

const DIRECT_GIT_UNAVAILABLE =
  "A read-only command runs Git directly, never through xcrun, whose lookup cache is a write, and found no developer Git without it. Set DEVELOPER_DIR to the Xcode or Command Line Tools developer directory, or put a Git other than the /usr/bin/git shim first on PATH, then run the command again.";

interface GitResolution {
  executable: string;
  /** True when `executable` is `git` and PATH resolves it to the shim. */
  shim: boolean;
}

const canonicalPath = (
  probe: GitExecutableProbe,
  path: string
): string | null => {
  try {
    return probe.realpath(path);
  } catch {
    return null;
  }
};

// On macOS `/usr/bin/git` is an xcrun shim that locates the active developer
// directory before every exec, which costs far more than most read-only Git
// commands themselves. Resolve the binary it would run once per process and
// call that directly; any other Git on PATH, or a failed lookup, keeps `git`.
// With `directOnly`, for read-only commands, it never runs xcrun and refuses
// rather than fall back to the shim, since both write xcrun's lookup cache.
const resolveGit = (
  probe: GitExecutableProbe,
  directOnly: boolean
): GitResolution => {
  const plain = { executable: "git", shim: false };
  if (probe.platform !== "darwin") {
    return plain;
  }
  const onPath = probe.which("git");
  if (!onPath) {
    return plain;
  }
  let resolvedOnPath: string;
  try {
    resolvedOnPath = probe.realpath(onPath);
  } catch (error) {
    if (directOnly) {
      throw SimpleChangesError.withCause(
        DIRECT_GIT_UNAVAILABLE,
        EXIT_CODES.unsafe,
        error
      );
    }
    return plain;
  }
  if (resolvedOnPath !== XCRUN_GIT_SHIM) {
    return plain;
  }
  const candidate =
    probe.developerGit?.() ?? (directOnly ? null : probe.xcrunFind());
  const developerGit =
    candidate && isAbsolute(candidate) ? canonicalPath(probe, candidate) : null;
  // Compare the real file: `//usr/bin/git` or a link to the shim is the shim.
  if (developerGit && developerGit !== XCRUN_GIT_SHIM) {
    return { executable: developerGit, shim: false };
  }
  if (directOnly) {
    throw new SimpleChangesError(DIRECT_GIT_UNAVAILABLE, EXIT_CODES.unsafe);
  }
  return { executable: "git", shim: true };
};

export const resolveGitExecutable = (
  probe: GitExecutableProbe,
  options: { directOnly?: boolean } = {}
): string => resolveGit(probe, options.directOnly === true).executable;

const XCODE_SELECT_LINK = "/var/db/xcode_select_link";
const COMMAND_LINE_TOOLS = "/Library/Developer/CommandLineTools";

const executableOrNull = (path: string): string | null => {
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
};

/** The developer Git xcrun would pick, in xcrun's own order, without xcrun. */
const selectedDeveloperGit = (): string | null => {
  const configured = process.env.DEVELOPER_DIR?.trim();
  let selected: string | null = null;
  try {
    selected = readlinkSync(XCODE_SELECT_LINK);
  } catch {
    selected = null;
  }
  for (const directory of [configured, selected, COMMAND_LINE_TOOLS]) {
    if (!directory) {
      continue;
    }
    const developer = directory.endsWith(".app")
      ? `${directory}/Contents/Developer`
      : directory;
    const git = executableOrNull(`${developer}/usr/bin/git`);
    if (git) {
      return git;
    }
    // xcrun stops at the first configured directory it is given.
    if (directory === configured) {
      return null;
    }
  }
  return null;
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

let cachedGitResolution: GitResolution | undefined;
let directGitDepth = 0;

/**
 * Runs `read` with Git resolved directly: no xcrun lookup and no shim, both
 * of which write xcrun's cache. Resolution happens first, so a read-only
 * command that cannot run Git directly refuses before it reads anything. A
 * Git already resolved through xcrun earlier in the process is reused, since
 * using it runs no xcrun.
 */
export const withDirectGitOnly = <T>(read: () => T): T => {
  directGitDepth += 1;
  try {
    gitExecutable();
    return read();
  } finally {
    directGitDepth -= 1;
  }
};

export const gitExecutable = (): string => {
  const directOnly = directGitDepth > 0;
  cachedGitResolution ??= resolveGit(
    {
      developerGit: selectedDeveloperGit,
      platform: process.platform,
      realpath: realpathSync,
      which: (command) => which(command),
      xcrunFind: xcrunFindGit,
    },
    directOnly
  );
  if (directOnly && cachedGitResolution.shim) {
    throw new SimpleChangesError(DIRECT_GIT_UNAVAILABLE, EXIT_CODES.unsafe);
  }
  return cachedGitResolution.executable;
};

export interface ProcessGroupRunOptions {
  /** Extra environment for the child, on top of this process's own. */
  environment: Record<string, string>;
  /**
   * In-memory input written to the child's stdin, which is then closed.
   * Without it the child's stdin is ignored.
   */
  stdin?: string;
  /** Stream the child's output to this process's stderr instead of capturing it. */
  streamOutputToStderr: boolean;
}

/** The process boundary `runInProcessGroup` crosses; tests substitute it. */
export interface ProcessGroupRunDependencies {
  cleanupUnregistered: (
    command: string,
    childPid: number
  ) => Promise<GuardedProcessGroupStillAliveError | null>;
  platform: NodeJS.Platform;
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => ChildProcess;
}

const PROCESS_GROUP_RUN: ProcessGroupRunDependencies = {
  cleanupUnregistered: (command, childPid) =>
    unregisteredCommandCleanup(command, childPid),
  platform: process.platform,
  spawn: (command, args, options) => spawn(command, args, options),
};

/**
 * Runs one command in its own process group and resolves with its exit code,
 * whatever it is. Rejects when the command cannot start or leaves a
 * background descendant behind.
 */
export const runInProcessGroup = (
  command: string,
  args: readonly string[],
  cwd: string,
  onSpawn: (process: CommandProcess) => void,
  options: ProcessGroupRunOptions,
  dependencies: ProcessGroupRunDependencies = PROCESS_GROUP_RUN
): Promise<CommandResult> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = dependencies.spawn(command, [...args], {
      cwd,
      detached: dependencies.platform !== "win32",
      env: {
        ...process.env,
        ...options.environment,
      },
      stdio: [
        options.stdin === undefined ? "ignore" : "pipe",
        ...(options.streamOutputToStderr
          ? ([2, 2] as const)
          : (["pipe", "pipe"] as const)),
      ],
    });
    if (options.stdin !== undefined) {
      // A child that exits without reading its input must not crash this
      // process with EPIPE; its exit code still decides the result.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin);
    }
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
        processGroupId: dependencies.platform === "win32" ? null : childPid,
      });
    } catch (error) {
      // Nothing will await this unregistered command, so release the lock
      // only once its descendants are proven gone. A late child error must
      // not settle the run before that cleanup finishes.
      child.removeAllListeners("error");
      child.on("error", () => undefined);
      // A cleanup that throws, synchronously or not, proves nothing.
      (async () => dependencies.cleanupUnregistered(command, childPid))().then(
        (cleanupError) => rejectPromise(cleanupError ?? error),
        // A cleanup that itself failed proves nothing, so keep the lock.
        () =>
          rejectPromise(
            new GuardedProcessGroupStillAliveError(command, childPid)
          )
      );
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
  onSpawn: (process: CommandProcess) => void,
  input?: { environment?: Record<string, string>; stdin?: string }
): Promise<CommandResult> => {
  const result = await runInProcessGroup(command, args, cwd, onSpawn, {
    environment: { ...input?.environment, LC_ALL: "C" },
    ...(input?.stdin === undefined ? {} : { stdin: input.stdin }),
    streamOutputToStderr: false,
  });
  return assertCommandSucceeded(command, args, result);
};

/** The result of a guarded command, or the error a nonzero exit raises. */
export const assertCommandSucceeded = (
  command: string,
  args: readonly string[],
  result: CommandResult
): CommandResult => {
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
  allowFailure = false,
  environment: Record<string, string> = {}
): CommandResult =>
  runCommand(
    gitExecutable(),
    ["-C", cwd, ...args],
    cwd,
    allowFailure,
    "git",
    environment
  );

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
/**
 * The environment that keeps a network Git command from waiting for a person:
 * no terminal credential prompts, and SSH in batch mode unless the user
 * configured their own SSH command.
 */
export const nonInteractiveGitEnvironment = (
  cwd: string
): Record<string, string> => {
  const customSsh =
    process.env.GIT_SSH_COMMAND ||
    process.env.GIT_SSH ||
    runGit(cwd, ["config", "--get", "core.sshCommand"], true).stdout.trim();
  return {
    GCM_INTERACTIVE: "never",
    GIT_TERMINAL_PROMPT: "0",
    ...(customSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
  };
};

export const runGitRemote = (
  cwd: string,
  args: readonly string[],
  timeoutMs = REMOTE_GIT_TIMEOUT_MS,
  environment: Record<string, string> = {}
): CommandResult => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...nonInteractiveGitEnvironment(cwd),
    ...environment,
    LC_ALL: "C",
  };
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
