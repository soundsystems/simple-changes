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
import { homedir } from "node:os";
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
const REVIEW_LOOP_MARKERS: ManagedBlockMarkers = {
  end: "<!-- simple-changes:review-loop:end -->",
  start: "<!-- simple-changes:review-loop:start -->",
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

// The repository's instruction files that are safe to inspect, each checked
// on its own: a missing, linked, escaping, or irregular candidate is simply
// not a target, and never hides a regular sibling. Setup keeps
// `discoverInstructionTargets`, which refuses the whole repository scope.
export const discoverRepositoryInstructionTargets = (
  primaryCheckout: string | null
): InstructionTarget[] => {
  if (!primaryCheckout) {
    return [];
  }
  const targets: InstructionTarget[] = [];
  for (const filename of REPOSITORY_CANDIDATES) {
    try {
      targets.push(
        ...discoverInstructionTargets("repository", primaryCheckout, filename)
      );
    } catch {
      // Absent, a symlink, outside the checkout, or not a regular file.
    }
  }
  return targets;
};

// The global instruction files the harnesses read, under the roots harness
// detection and the turn-end guard use. A missing, linked, or irregular
// file is simply not a target.
export const discoverGlobalInstructionTargets = (
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): InstructionTarget[] => {
  const override = environment.SIMPLE_CHANGES_HARNESS_ROOTS?.trim();
  const base = override ? resolve(override) : home;
  const candidates = [
    resolve(
      environment.CODEX_HOME?.trim() || resolve(base, ".codex"),
      "AGENTS.md"
    ),
    resolve(
      environment.CLAUDE_CONFIG_DIR?.trim() || resolve(base, ".claude"),
      "CLAUDE.md"
    ),
  ];
  const targets: InstructionTarget[] = [];
  for (const path of candidates) {
    try {
      targets.push(...discoverInstructionTargets("user", null, path));
    } catch {
      // Absent, a symlink, or not a regular file: nothing to inspect.
    }
  }
  return targets;
};

/**
 * The target for an explicit path: repository scope inside the primary
 * checkout, with that scope's checks, and user scope anywhere else.
 */
export const locateInstructionTarget = (
  path: string,
  primaryCheckout: string | null
): InstructionTarget => {
  const resolved = resolve(path);
  assertExistingInstructionFile(resolved);
  if (primaryCheckout) {
    const relativePath = relative(
      realpathSync(primaryCheckout),
      realpathSync(resolved)
    );
    if (
      !(
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      )
    ) {
      const [target] = discoverInstructionTargets(
        "repository",
        primaryCheckout,
        resolved
      );
      if (target) {
        return target;
      }
    }
  }
  const [target] = discoverInstructionTargets("user", null, resolved);
  if (!target) {
    throw new SimpleChangesError(
      `Not an instruction file: ${resolved}`,
      EXIT_CODES.usage
    );
  }
  return target;
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

// One folder per agent, deleted only by that agent or the run that bound it:
// several agents share a harness scratch directory and the work root, so a
// rule that says only "delete your scratch files" invites a subagent to
// sweep its parent's files by pattern.
const SCRATCH_FILE_RULE =
  "Write scratch files, captured command output, proof bundles, and handoff notes only in one scratch folder of your own, never inside or next to a repository checkout: the folder your brief names, the work directory a Simple Changes run reports, or a new folder you create with `mktemp -d` under the session's scratch directory or the system temporary directory. When you start another agent, give it a folder inside yours, or the one a Simple Changes run prepared for it, and name the path in its brief. When the task ends, delete exactly your own folder by its path, unless the user asks to keep it or a Simple Changes run reported it, which the run removes; never delete by pattern, extension, or age in a directory other agents share.";

// How Simple Changes runs review: the loop its runtime counts and the steps
// it leaves to the agent. It names no agent or model; those come from the
// authoring preferences.
const REVIEW_LOOP_RULE =
  "In Simple Changes runs, review in rounds at the exact head, with the reviewer, efforts, and limits from the authoring preferences that `simple-changes initialize` reports. Have the reviewer grade each finding blocking, should-fix, or nit, and record the grades; which findings escalate later reviews follows the preferences (by default only blocking and should-fix ones). After the first round, review the fixes, the boundary they protect, and what they touched, then run one full review at the final head before merge. Tell the reviewer which findings the user deferred or accepted. When `initialize` says the convergence check is due and the findings sit in one area, stop patching and question the approach; when it says the round cap is reached, ask the user whether to ship with the open findings filed as issues, change the design, or keep reviewing.";

/** An optional rule setup can add to an instruction file as its own block. */
export type InstructionRule = "review-loop" | "scratch-files";

const RULES: Record<
  InstructionRule,
  { markers: ManagedBlockMarkers; text: string }
> = {
  "review-loop": { markers: REVIEW_LOOP_MARKERS, text: REVIEW_LOOP_RULE },
  "scratch-files": { markers: SCRATCH_FILE_MARKERS, text: SCRATCH_FILE_RULE },
};

export const renderInstructionRule = (rule: InstructionRule): string =>
  [RULES[rule].markers.start, RULES[rule].text, RULES[rule].markers.end].join(
    "\n"
  );

export const renderScratchFileRule = (): string =>
  renderInstructionRule("scratch-files");

const markerCount = (source: string, marker: string): number =>
  source.split(marker).length - 1;

const formatWithNewline = (source: string, value: string): string => {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return value.replaceAll("\n", newline);
};

// Each block appears at most once, ends after it starts, and never overlaps
// or nests in another, so replacing one can never cut into another.
const managedBlockSpans = (
  source: string,
  path: string
): Map<ManagedBlockMarkers, { end: number; start: number }> => {
  const invalid = () =>
    new SimpleChangesError(
      `Instruction file has an invalid Simple Changes managed block: ${path}`,
      EXIT_CODES.unsafe
    );
  const spans = new Map<ManagedBlockMarkers, { end: number; start: number }>();
  for (const markers of [
    POINTER_MARKERS,
    SCRATCH_FILE_MARKERS,
    REVIEW_LOOP_MARKERS,
  ]) {
    const startCount = markerCount(source, markers.start);
    const endCount = markerCount(source, markers.end);
    if (startCount > 1 || endCount > 1 || startCount !== endCount) {
      throw invalid();
    }
    if (startCount === 1) {
      const start = source.indexOf(markers.start);
      const end = source.indexOf(markers.end, start);
      if (end < start) {
        throw invalid();
      }
      spans.set(markers, { end: end + markers.end.length, start });
    }
  }
  const ordered = [...spans.values()].sort(
    (left, right) => left.start - right.start
  );
  if (
    ordered.some(
      (span, index) => index > 0 && span.start < (ordered[index - 1]?.end ?? 0)
    )
  ) {
    throw invalid();
  }
  return spans;
};

const planManagedBlock = (
  target: InstructionTarget,
  markers: ManagedBlockMarkers,
  block: string
): InstructionPointerPlan & { contents: string } => {
  assertExistingInstructionFile(target.path);
  const source = readFileSync(target.path, "utf8");
  const span = managedBlockSpans(source, target.path).get(markers);
  const formattedBlock = formatWithNewline(source, block);
  let contents: string;
  if (span) {
    contents = `${source.slice(0, span.start)}${formattedBlock}${source.slice(
      span.end
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

export const writeInstructionRule = (
  target: InstructionTarget,
  rule: InstructionRule
): InstructionPointerResult =>
  writeManagedBlock(target, RULES[rule].markers, renderInstructionRule(rule));

export const writeScratchFileRule = (
  target: InstructionTarget
): InstructionPointerResult => writeInstructionRule(target, "scratch-files");

export type InstructionRuleState = "absent" | "current" | "invalid" | "stale";
export type ScratchFileRuleState = InstructionRuleState;

/**
 * The state of a rule's block in `target`: `current` when it reads exactly
 * as this runtime renders it, `stale` when its markers wrap older text that
 * `writeInstructionRule` would replace in place, `invalid` when any managed
 * markers are malformed (nothing rewrites that), else `absent`.
 */
export const inspectInstructionRule = (
  target: InstructionTarget,
  rule: InstructionRule
): InstructionRuleState => {
  assertExistingInstructionFile(target.path);
  const source = readFileSync(target.path, "utf8");
  let span: { end: number; start: number } | undefined;
  try {
    span = managedBlockSpans(source, target.path).get(RULES[rule].markers);
  } catch {
    return "invalid";
  }
  if (!span) {
    return "absent";
  }
  return source.slice(span.start, span.end) ===
    formatWithNewline(source, renderInstructionRule(rule))
    ? "current"
    : "stale";
};

export const inspectScratchFileRule = (
  target: InstructionTarget
): ScratchFileRuleState => inspectInstructionRule(target, "scratch-files");
