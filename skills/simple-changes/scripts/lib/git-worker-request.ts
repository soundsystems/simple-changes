// The request `runGitConcurrently` writes to the Git worker, and the checks
// the worker applies before it starts anything. It imports only `node:path`
// so the worker stays cheap to start.

import { posix, win32 } from "node:path";

export interface GitWorkerRequest {
  args: readonly string[];
  cwd: string;
}

export interface GitWorkerInput {
  concurrency: number;
  executable: string;
  requests: readonly GitWorkerRequest[];
}

const WINDOWS_GIT_NAME = /^git(?:\.exe)?$/iu;

/**
 * Whether the worker may run `executable` as Git: the bare name, which the
 * worker resolves on PATH as `runGit` does, or an absolute path to a file of
 * that name, which macOS uses to bypass the xcrun shim. Windows names compare
 * without case and may end in `.exe`. This is a name check, not proof of
 * provenance: the caller resolves Git, and the worker refuses a request that
 * names any other program.
 */
export const isGitExecutable = (
  executable: string,
  platform: NodeJS.Platform = process.platform
): boolean => {
  const path = platform === "win32" ? win32 : posix;
  const name = path.basename(executable);
  const named =
    platform === "win32" ? WINDOWS_GIT_NAME.test(name) : name === "git";
  return (
    named &&
    !executable.includes("\0") &&
    executable.endsWith(name) &&
    (executable === name || path.isAbsolute(executable))
  );
};

const requestRefusal = (request: unknown, index: number): string | null => {
  const { args, cwd } = (request ?? {}) as Partial<
    Record<keyof GitWorkerRequest, unknown>
  >;
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    return `request ${index} has no working directory`;
  }
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    return `request ${index} has no Git arguments`;
  }
  // The worker places `-C <cwd>` itself, so the first argument must be the
  // subcommand: an option there (`-c`, `--exec-path`, another `-C`) would
  // change which program Git runs or where.
  if ((args[0] as string).startsWith("-")) {
    return `request ${index} starts with the option ${JSON.stringify(args[0])} instead of a Git subcommand`;
  }
  return null;
};

/**
 * Why the worker refuses `value`, or null when it may run every request. A
 * refusal runs nothing; the caller then runs each request through `runGit`.
 */
export const gitWorkerRefusal = (
  value: unknown,
  platform: NodeJS.Platform = process.platform
): string | null => {
  const { concurrency, executable, requests } = (value ?? {}) as Partial<
    Record<keyof GitWorkerInput, unknown>
  >;
  if (
    typeof executable !== "string" ||
    !isGitExecutable(executable, platform)
  ) {
    return `the executable ${JSON.stringify(executable)} is not Git`;
  }
  if (
    typeof concurrency !== "number" ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1
  ) {
    return "the concurrency is not a positive integer";
  }
  if (!Array.isArray(requests)) {
    return "the requests are not a list";
  }
  for (const [index, request] of requests.entries()) {
    const refusal = requestRefusal(request, index);
    if (refusal) {
      return refusal;
    }
  }
  return null;
};
