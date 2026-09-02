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
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
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

const START_MARKER = "<!-- simple-changes:start -->";
const END_MARKER = "<!-- simple-changes:end -->";
const REPOSITORY_CANDIDATES = ["AGENTS.md", "CLAUDE.md"] as const;

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
  timing: HandoffTiming
): string => {
  const policy =
    scope === "repository"
      ? "the current request and `.simple-changes.json`"
      : "the current request and the repository's own policy";
  const skill =
    scope === "repository"
      ? "the `simple-changes` skill"
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
  timing: HandoffTiming
): string => [START_MARKER, pointerBody(scope, timing), END_MARKER].join("\n");

const markerCount = (source: string, marker: string): number =>
  source.split(marker).length - 1;

const formatWithNewline = (source: string, value: string): string => {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return value.replaceAll("\n", newline);
};

const planInstructionPointer = (
  target: InstructionTarget,
  timing: HandoffTiming
): InstructionPointerPlan & { contents: string } => {
  assertExistingInstructionFile(target.path);
  const source = readFileSync(target.path, "utf8");
  const startCount = markerCount(source, START_MARKER);
  const endCount = markerCount(source, END_MARKER);
  if (startCount > 1 || endCount > 1 || startCount !== endCount) {
    throw new SimpleChangesError(
      `Instruction file has an invalid Simple Changes managed block: ${target.path}`,
      EXIT_CODES.unsafe
    );
  }
  const block = renderInstructionPointer(target.scope, timing);
  const formattedBlock = formatWithNewline(source, block);
  let contents: string;
  if (startCount === 1) {
    const start = source.indexOf(START_MARKER);
    const end = source.indexOf(END_MARKER, start);
    if (end < start) {
      throw new SimpleChangesError(
        `Instruction file has an invalid Simple Changes managed block: ${target.path}`,
        EXIT_CODES.unsafe
      );
    }
    contents = `${source.slice(0, start)}${formattedBlock}${source.slice(
      end + END_MARKER.length
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

export const writeInstructionPointer = (
  target: InstructionTarget,
  timing: HandoffTiming
): InstructionPointerResult => {
  const plan = planInstructionPointer(target, timing);
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
