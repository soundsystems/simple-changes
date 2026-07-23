import { spawnSync } from "bun";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { redactSecrets } from "./redact.ts";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
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

export const runGit = (
  cwd: string,
  args: readonly string[],
  allowFailure = false
): CommandResult => runCommand("git", ["-C", cwd, ...args], cwd, allowFailure);
