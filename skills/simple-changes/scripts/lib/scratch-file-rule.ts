import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  readLeaseFromCommonDirectory,
  withLoopStateLock,
} from "./loop-lease.ts";
import {
  type InstructionRule,
  type InstructionRuleState,
  type InstructionScope,
  inspectInstructionRule,
  locateInstructionTarget,
  writeInstructionRule,
} from "./repository-instructions.ts";
import {
  registeredCheckouts,
  type WorkDirectoryRepository,
} from "./work-directory.ts";

export interface InstructionRuleRefresh {
  changed: boolean;
  path: string;
  scope: InstructionScope;
  status: InstructionRuleState;
  written: boolean;
}
export type ScratchFileRuleRefresh = InstructionRuleRefresh;

// The command and setup flag each rule is refreshed and added with.
const RULE_COMMANDS: Record<
  InstructionRule,
  { command: string; name: string; setupFlag: string }
> = {
  "review-loop": {
    command: "review-loop-rule refresh",
    name: "review-loop rule",
    setupFlag: "--review-loop-rule add",
  },
  "scratch-files": {
    command: "scratch-file-rule refresh",
    name: "scratch-file rule",
    setupFlag: "--scratch-file-rule add",
  },
};

// Whether `path` is inside one of `checkouts`, compared through real paths;
// a checkout that no longer exists holds nothing.
const insideCheckout = (
  path: string,
  checkouts: readonly string[]
): boolean => {
  const real = realpathSync(path);
  return checkouts.some((checkout) => {
    let root: string;
    try {
      root = realpathSync(checkout);
    } catch {
      return false;
    }
    const relativePath = relative(root, real);
    return !(
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    );
  });
};

/**
 * Rewrites one stale rule block in place, and nothing else: adding the
 * rule to a file without one stays a setup decision. While any run
 * holds a lease here, even a paused or relinquished one, a file in one of
 * the repository's checkouts is refused: the run preserves those checkouts.
 * A global file outside every checkout stays free.
 *
 * `repository` may have been located before the lock, so its checkouts are
 * never trusted: under the lock the registered checkouts and the lease are
 * read again and the target is located and classified again, so a checkout
 * registered meanwhile, such as one `prepare-agent` adds, is seen.
 */
export const refreshInstructionRule = (
  repository: WorkDirectoryRepository,
  file: string,
  rule: InstructionRule
): InstructionRuleRefresh =>
  withLoopStateLock(
    repository.commonGitDirectory,
    RULE_COMMANDS[rule].command,
    () => {
      const checkouts = registeredCheckouts(repository.commonGitDirectory);
      const target = locateInstructionTarget(file, checkouts[0] ?? null);
      const lease = readLeaseFromCommonDirectory(repository.commonGitDirectory);
      if (
        lease &&
        (target.scope === "repository" ||
          insideCheckout(target.path, [
            ...checkouts,
            lease.primaryCheckout,
            ...lease.worktrees.map((worktree) => worktree.path),
            ...lease.preparations.map((preparation) => preparation.path),
          ]))
      ) {
        throw new SimpleChangesError(
          `Simple Changes run ${lease.runId} holds this repository, and ${target.path} is in one of its checkouts; refresh it after the run ends.`,
          EXIT_CODES.unsafe
        );
      }
      const status = inspectInstructionRule(target, rule);
      if (status === "absent") {
        throw new SimpleChangesError(
          `No Simple Changes ${RULE_COMMANDS[rule].name} in ${target.path}; add one with setup ${RULE_COMMANDS[rule].setupFlag}.`,
          EXIT_CODES.usage
        );
      }
      if (status === "invalid") {
        throw new SimpleChangesError(
          `Instruction file has an invalid Simple Changes managed block; repair it by hand: ${target.path}`,
          EXIT_CODES.unsafe
        );
      }
      const written =
        status === "stale" ? writeInstructionRule(target, rule) : null;
      return {
        changed: written?.changed ?? false,
        path: target.path,
        scope: target.scope,
        status,
        written: written?.written ?? false,
      };
    }
  );

export const refreshScratchFileRule = (
  repository: WorkDirectoryRepository,
  file: string
): ScratchFileRuleRefresh =>
  refreshInstructionRule(repository, file, "scratch-files");
