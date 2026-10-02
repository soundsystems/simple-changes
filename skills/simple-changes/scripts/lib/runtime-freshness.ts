import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { runGit } from "./process.ts";

export interface RuntimeFreshness {
  message: string | null;
  /** The running script, relative to the checkout that contains it. */
  path: string | null;
  runningVersion: string;
  status: "current" | "behind-target" | "not-applicable";
  targetRef: string | null;
  targetVersion: string | null;
}

const VERSION_PATTERN = /const VERSION = "([^"]+)";/u;
const NUMERIC_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/u;

const numericVersion = (version: string): number[] | null => {
  const match = NUMERIC_VERSION_PATTERN.exec(version);
  return match ? match.slice(1, 4).map((part) => Number(part)) : null;
};

/** The `VERSION` constant declared in a Simple Changes CLI source, if any. */
export const declaredVersion = (source: string): string | null =>
  VERSION_PATTERN.exec(source)?.[1] ?? null;

/** Whether `running` is an older numeric release than `target`. */
export const isOlderVersion = (running: string, target: string): boolean => {
  const left = numericVersion(running);
  const right = numericVersion(target);
  if (!(left && right)) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) {
      return a < b;
    }
  }
  return false;
};

const resolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const notApplicable = (runningVersion: string): RuntimeFreshness => ({
  message: null,
  path: null,
  runningVersion,
  status: "not-applicable",
  targetRef: null,
  targetVersion: null,
});

export interface RuntimeFreshnessContext {
  targetRef: string;
  worktreePaths: readonly string[];
}

/**
 * Compare the running Simple Changes runtime with the copy of the same file on
 * the target branch, when the runtime lives inside a checkout of the
 * repository it is operating on (a vendored fork, or a development checkout).
 * Running an older copy from a stale branch means older guidance and checks,
 * so a newer target copy is reported. A global install outside the repository
 * is not compared: it has no target-branch counterpart.
 */
export const runtimeFreshness = (
  repository: RuntimeFreshnessContext,
  runningVersion: string,
  scriptFile: string
): RuntimeFreshness => {
  const script = resolved(scriptFile);
  const container = repository.worktreePaths
    .map((worktreePath) => resolved(worktreePath))
    .filter((root) => script.startsWith(`${root}${sep}`))
    .sort((left, right) => right.length - left.length)
    .at(0);
  if (!container) {
    return notApplicable(runningVersion);
  }
  const path = relative(container, script).split(sep).join("/");
  const shown = runGit(
    container,
    ["show", `${repository.targetRef}:${path}`],
    true
  );
  const targetVersion =
    shown.exitCode === 0 ? declaredVersion(shown.stdout) : null;
  if (!targetVersion) {
    return notApplicable(runningVersion);
  }
  if (!isOlderVersion(runningVersion, targetVersion)) {
    return {
      message: null,
      path,
      runningVersion,
      status: "current",
      targetRef: repository.targetRef,
      targetVersion,
    };
  }
  return {
    message: `This Simple Changes runtime is ${runningVersion}, but ${repository.targetRef} carries ${targetVersion} at ${path}. You are running an older copy from this checkout's branch, so its guidance and checks may miss rules the target already enforces. Run the target branch's copy, or update this checkout, before integrating or shipping.`,
    path,
    runningVersion,
    status: "behind-target",
    targetRef: repository.targetRef,
    targetVersion,
  };
};
