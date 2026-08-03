import { spawn } from "node:child_process";
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

const textDecoder = new TextDecoder();

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
    child.once("close", (code) => {
      const exitCode = code ?? 1;
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
