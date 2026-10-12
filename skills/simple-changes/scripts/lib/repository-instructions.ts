import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { runningSkillName } from "./skill-roots.ts";
import type { HandoffTiming } from "./types.ts";

export type InstructionScope = "user" | "repository";

export interface InstructionTarget {
  path: string;
  scope: InstructionScope;
}

export interface InstructionPointerPlan {
  block: string;
  changed: boolean;
  path: string;
  scope: InstructionScope;
}

export interface InstructionPointerResult extends InstructionPointerPlan {
  written: boolean;
}

interface ManagedBlockMarkers {
  end: string;
  start: string;
}

const POINTER_MARKERS: ManagedBlockMarkers = {
  end: "<!-- simple-changes:end -->",
  start: "<!-- simple-changes:start -->",
};
// A separate block, so the pointer and this rule are added, kept, or
// replaced independently.
const SCRATCH_FILE_MARKERS: ManagedBlockMarkers = {
  end: "<!-- simple-changes:scratch-files:end -->",
  start: "<!-- simple-changes:scratch-files:start -->",
};
const REPOSITORY_CANDIDATES = ["AGENTS.md", "CLAUDE.md"] as const;

let runningSkill: string | undefined;

/**
 * The skill this runtime ships in, so a repository fork's setup points agents
 * at the fork rather than the global `simple-changes`.
 */
const defaultSkillName = (): string => {
  runningSkill ??= runningSkillName(
    fileURLToPath(new URL("../simple-changes.ts", import.meta.url))
  );
  return runningSkill;
};

const assertExistingInstructionFile = (path: string): void => {
  if (!existsSync(path)) {
    throw new SimpleChangesError(
      `Instruction file does not exist; refusing to create it: ${path}`,
      EXIT_CODES.usage
    );
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    throw new SimpleChangesError(
      `Refusing to update an instruction symlink: ${path}`,
      EXIT_CODES.unsafe
    );
  }
  if (!metadata.isFile()) {
    throw new SimpleChangesError(
      `Instruction target is not a regular file: ${path}`,
      EXIT_CODES.usage
    );
  }
};

const assertRepositoryTarget = (
  primaryCheckout: string,
  path: string
): void => {
  const canonicalCheckout = realpathSync(primaryCheckout);
  const relativePath = relative(canonicalCheckout, realpathSync(path));
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new SimpleChangesError(
      `Instruction file escapes the primary checkout: ${path}`,
      EXIT_CODES.unsafe
    );
  }
  if (realpathSync(path) !== resolve(path)) {
    throw new SimpleChangesError(
      `Refusing an instruction path that traverses a symlink: ${path}`,
      EXIT_CODES.unsafe
    );
  }
};

export const discoverInstructionTargets = (
  scope: "user" | "repository" | "run",
  primaryCheckout: string | null,
  explicitPath?: string
): InstructionTarget[] => {
  if (scope === "run") {
    return [];
  }
  if (scope === "repository" && !primaryCheckout) {
    return [];
  }
  if (explicitPath) {
    const path =
      scope === "repository" && primaryCheckout && !isAbsolute(explicitPath)
        ? resolve(primaryCheckout, explicitPath)
        : resolve(explicitPath);
    if (scope === "repository" && primaryCheckout) {
      assertExistingInstructionFile(path);
      assertRepositoryTarget(primaryCheckout, path);
    } else {
      assertExistingInstructionFile(path);
      if (realpathSync(path) !== resolve(path)) {
        throw new SimpleChangesError(
          `Refusing an instruction path that traverses a symlink: ${path}`,
          EXIT_CODES.unsafe
        );
      }
    }
    return [{ path, scope }];
  }
  if (scope === "user" || !primaryCheckout) {
    return [];
  }
  return REPOSITORY_CANDIDATES.map((filename) =>
    resolve(primaryCheckout, filename)
  )
    .filter((path) => existsSync(path))
    .map((path) => {
      assertExistingInstructionFile(path);
      assertRepositoryTarget(primaryCheckout, path);
      return { path, scope };
    });
};

const pointerBody = (
  scope: InstructionScope,
  timing: HandoffTiming,
  skillName: string
): string => {
  const policy =
    scope === "repository"
      ? "the current request and `.simple-changes.json`"
      : "the current request and the repository's own policy";
  // A user-level file spans repositories, so it keeps the generic wording
  // that lets each repository's own fork apply.
  const skill =
    scope === "repository"
      ? `the \`${skillName}\` skill`
      : "the applicable `simple-changes` skill";
  if (timing === "automatic") {
    return `After an agent completes and verifies assigned implementation work, use ${skill} to hand off that completed work according to ${policy}. Do not trigger this after planning, diagnosis, read-only work, blocked or incomplete implementation, work with failing checks, tasks that changed no repository files, or a Simple Changes run itself.`;
  }
  if (timing === "confirm-ready") {
    return `After an agent completes and verifies assigned implementation work, ask: "The implementation and checks are complete. Is this ready for Simple Changes, or do you want more changes first?" Use ${skill} only after the user confirms it is ready, then follow ${policy}.`;
  }
  return `When the user indicates that completed work is ready to put up, merge, ship, finish, or reconcile, use ${skill} and follow ${policy}.`;
};

export const renderInstructionPointer = (
  scope: InstructionScope,
  timing: HandoffTiming,
  skillName: string = defaultSkillName()
): string =>
  [
    POINTER_MARKERS.start,
    pointerBody(scope, timing, skillName),
    POINTER_MARKERS.end,
  ].join("\n");

const SCRATCH_FILE_RULE =
  "Write scratch files, captured command output, proof bundles, and handoff notes to the session's scratch directory or a private folder under the system temporary directory, never inside or next to a repository checkout. During a Simple Changes run, use the work directory it reports. Delete them when the task ends unless the user asks to keep them.";

export const renderScratchFileRule = (): string =>
  [
    SCRATCH_FILE_MARKERS.start,
    SCRATCH_FILE_RULE,
    SCRATCH_FILE_MARKERS.end,
  ].join("\n");

const markerCount = (source: string, marker: string): number =>
  source.split(marker).length - 1;

const formatWithNewline = (source: string, value: string): string => {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return value.replaceAll("\n", newline);
};

const planManagedBlock = (
  target: InstructionTarget,
  markers: ManagedBlockMarkers,
  block: string
): InstructionPointerPlan & { contents: string } => {
  assertExistingInstructionFile(target.path);
  const source = readFileSync(target.path, "utf8");
  const startCount = markerCount(source, markers.start);
  const endCount = markerCount(source, markers.end);
  if (startCount > 1 || endCount > 1 || startCount !== endCount) {
    throw new SimpleChangesError(
      `Instruction file has an invalid Simple Changes managed block: ${target.path}`,
      EXIT_CODES.unsafe
    );
  }
  const formattedBlock = formatWithNewline(source, block);
  let contents: string;
  if (startCount === 1) {
    const start = source.indexOf(markers.start);
    const end = source.indexOf(markers.end, start);
    if (end < start) {
      throw new SimpleChangesError(
        `Instruction file has an invalid Simple Changes managed block: ${target.path}`,
        EXIT_CODES.unsafe
      );
    }
    contents = `${source.slice(0, start)}${formattedBlock}${source.slice(
      end + markers.end.length
    )}`;
  } else {
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    let separator = newline.repeat(2);
    if (source.length === 0) {
      separator = "";
    } else if (source.endsWith(newline)) {
      separator = newline;
    }
    contents = `${source}${separator}${formattedBlock}${newline}`;
  }
  return {
    block,
    changed: contents !== source,
    contents,
    path: target.path,
    scope: target.scope,
  };
};

const writeManagedBlock = (
  target: InstructionTarget,
  markers: ManagedBlockMarkers,
  block: string
): InstructionPointerResult => {
  const plan = planManagedBlock(target, markers, block);
  if (!plan.changed) {
    return {
      block: plan.block,
      changed: plan.changed,
      path: plan.path,
      scope: plan.scope,
      written: false,
    };
  }
  const directory = dirname(target.path);
  const temporaryPath = resolve(
    directory,
    `.${randomUUID()}.simple-changes-instructions.tmp`
  );
  writeFileSync(temporaryPath, plan.contents, {
    encoding: "utf8",
    flag: "wx",
    mode: statSync(target.path).mode,
  });
  try {
    renameSync(temporaryPath, target.path);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
  if (readFileSync(target.path, "utf8") !== plan.contents) {
    throw new SimpleChangesError(
      `Instruction file verification failed after writing: ${target.path}`,
      EXIT_CODES.validation
    );
  }
  return {
    block: plan.block,
    changed: plan.changed,
    path: plan.path,
    scope: plan.scope,
    written: true,
  };
};

export const writeInstructionPointer = (
  target: InstructionTarget,
  timing: HandoffTiming,
  skillName: string = defaultSkillName()
): InstructionPointerResult =>
  writeManagedBlock(
    target,
    POINTER_MARKERS,
    renderInstructionPointer(target.scope, timing, skillName)
  );

export const writeScratchFileRule = (
  target: InstructionTarget
): InstructionPointerResult =>
  writeManagedBlock(target, SCRATCH_FILE_MARKERS, renderScratchFileRule());
