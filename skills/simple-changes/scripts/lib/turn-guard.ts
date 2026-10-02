import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { which } from "bun";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  currentHarnessSession,
  forgetControllerSession,
  listControllerSessionEntries,
} from "./harness-session.ts";
import {
  loopLeasePath,
  readControllerBinding,
  turnEndReminder,
} from "./loop-lease.ts";
import { declaredVersion, isOlderVersion } from "./runtime-freshness.ts";
import type { LoopControllerSession, LoopLease } from "./types.ts";

type Environment = Record<string, string | undefined>;
export type TurnGuardHarness = LoopControllerSession["harness"];

export interface TurnCheckInput {
  sessionId: string | null;
  stopHookActive: boolean;
}

export interface TurnCheckRun {
  ownerAgentId: string;
  primaryCheckout: string;
  reminder: string;
  runId: string;
}

export interface TurnCheckResult {
  decision: "allow" | "block" | "warn";
  reason: string | null;
  runs: TurnCheckRun[];
  sessionId: string | null;
}

const readLease = (commonGitDirectory: string): LoopLease | null => {
  try {
    return JSON.parse(
      readFileSync(loopLeasePath(commonGitDirectory), "utf8")
    ) as LoopLease;
  } catch {
    return null;
  }
};

/**
 * Find the runs this harness session still actively controls. The session
 * index only points at repositories; each lease is read again and must name
 * this session on an active controller. Pointers to closed, paused, resumed,
 * or taken-over runs are pruned as they are found.
 */
export const turnCheck = (
  input: TurnCheckInput,
  environment: Environment = process.env
): TurnCheckResult => {
  const sessionId =
    input.sessionId?.trim() ||
    currentHarnessSession(environment)?.sessionId ||
    null;
  if (!sessionId) {
    return { decision: "allow", reason: null, runs: [], sessionId: null };
  }
  const runs: TurnCheckRun[] = [];
  for (const entry of listControllerSessionEntries(sessionId, environment)) {
    const lease = readLease(entry.commonGitDirectory);
    if (
      !lease ||
      lease.runId !== entry.runId ||
      (lease.controller?.status ?? "active") !== "active" ||
      readControllerBinding(lease)?.session?.sessionId !== sessionId
    ) {
      forgetControllerSession(sessionId, entry.runId, environment);
      continue;
    }
    runs.push({
      ownerAgentId: lease.ownerAgentId,
      primaryCheckout: lease.primaryCheckout,
      reminder: turnEndReminder(lease),
      runId: lease.runId,
    });
  }
  if (runs.length === 0) {
    return { decision: "allow", reason: null, runs, sessionId };
  }
  const reason = [
    `Simple Changes: this session still controls ${runs
      .map((run) => `${run.runId} in ${run.primaryCheckout}`)
      .join(", ")}.`,
    ...runs.map((run) => run.reminder),
  ].join(" ");
  return {
    decision: input.stopHookActive ? "warn" : "block",
    reason,
    runs,
    sessionId,
  };
};

/**
 * The JSON a Stop hook prints. Blocking once makes the agent finalize; when the
 * harness reports the agent is already continuing because of this hook, warn
 * the user instead of blocking again, so the hook can never trap a session.
 */
export const turnCheckHookOutput = (result: TurnCheckResult): string => {
  if (result.decision === "block") {
    return `${JSON.stringify({ decision: "block", reason: result.reason })}\n`;
  }
  if (result.decision === "warn") {
    return `${JSON.stringify({ systemMessage: result.reason })}\n`;
  }
  return "";
};

export const parseTurnCheckHookInput = (raw: string): TurnCheckInput => {
  try {
    const parsed = JSON.parse(raw) as {
      session_id?: unknown;
      stop_hook_active?: unknown;
    };
    return {
      sessionId:
        typeof parsed.session_id === "string" ? parsed.session_id : null,
      stopHookActive: parsed.stop_hook_active === true,
    };
  } catch {
    return { sessionId: null, stopHookActive: false };
  }
};

export interface StopHookStatus {
  command: string;
  current: boolean;
  harness: TurnGuardHarness;
  installed: boolean;
  path: string;
  written: boolean;
}

const TURN_CHECK_ACTION = "turn-check";
const TURN_CHECK_MARKER = `loop ${TURN_CHECK_ACTION}`;

const QUOTED_SCRIPT_PATTERN = /'((?:[^']|'\\'')+)'\s+loop turn-check/u;

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const ALLOW_ON_FAILURE = "|| exit 0";

/**
 * The hook command. It names the stable `bun` on PATH rather than a versioned
 * install directory, and any failure allows the turn to end: a missing script,
 * or a copy that predates `loop turn-check` and would exit with a usage error,
 * which Claude Code reads as "keep going". The guard itself blocks only
 * through JSON on a zero exit.
 */
export const stopHookCommand = (
  scriptPath: string,
  bunPath: string = which("bun") ?? process.execPath
): string =>
  `[ -f ${shellQuote(scriptPath)} ] ${ALLOW_ON_FAILURE}; ${shellQuote(bunPath)} ${shellQuote(scriptPath)} ${TURN_CHECK_MARKER} --hook ${ALLOW_ON_FAILURE}`;

const hookScriptPath = (command: string): string | null => {
  const quoted = QUOTED_SCRIPT_PATTERN.exec(command)?.[1];
  return quoted ? quoted.replaceAll("'\\''", "'") : null;
};

// Another copy's hook stays in place while it has the fail-open ending and its
// script still supports the turn check and is at least as new as this one;
// offering to repoint it would make copies fight.
const hookIsCurrent = (
  command: string,
  ourCommand: string,
  runningVersion: string
): boolean => {
  if (command === ourCommand) {
    return true;
  }
  const script = hookScriptPath(command);
  return Boolean(
    command.trimEnd().endsWith(ALLOW_ON_FAILURE) &&
      script &&
      supportsTurnCheck(script, runningVersion)
  );
};

const LINKED_WORKTREE_GITDIR_PATTERN =
  /^gitdir:\s*(.+)\/worktrees\/[^/\n]+\s*$/mu;

interface LinkedWorktree {
  primaryCheckout: string;
  root: string;
}

// A linked worktree's `.git` file points into `<common>/worktrees/<name>`; a
// submodule's points into `modules/` and is not a linked worktree.
const linkedWorktreeOf = (path: string): LinkedWorktree | null => {
  let directory = dirname(path);
  let previous = "";
  while (previous !== directory) {
    const marker = resolve(directory, ".git");
    if (existsSync(marker)) {
      if (lstatSync(marker).isDirectory()) {
        return null;
      }
      const common = LINKED_WORKTREE_GITDIR_PATTERN.exec(
        readFileSync(marker, "utf8")
      )?.[1];
      return common
        ? {
            primaryCheckout: dirname(resolve(directory, common.trim())),
            root: directory,
          }
        : null;
    }
    previous = directory;
    directory = dirname(directory);
  }
  return null;
};

// A linked worktree is removed when its work ships; a hook pointing into one
// would silently stop guarding every session.
const insideLinkedWorktree = (path: string): boolean =>
  linkedWorktreeOf(path) !== null;

// A copy qualifies only when it exists, is at least as new as this one, and
// actually implements the turn check: a branch checked out in a primary
// checkout can carry the same version number from before the feature.
const supportsTurnCheck = (path: string, version: string): boolean => {
  try {
    const source = readFileSync(path, "utf8");
    const declared = declaredVersion(source);
    return (
      declared !== null &&
      !isOlderVersion(declared, version) &&
      source.includes(`"${TURN_CHECK_ACTION}"`)
    );
  } catch {
    return false;
  }
};

/**
 * The copy a user-level hook should point at when installing from `script`:
 * the script itself, or, from a linked worktree, the primary checkout's copy at
 * the same path when it exists and is at least as new. Null means no copy here
 * can be installed; install from the globally installed Simple Changes.
 */
export const hookInstallScript = (
  script: string,
  runningVersion: string
): string | null => {
  const linked = linkedWorktreeOf(script);
  if (!linked) {
    return script;
  }
  const candidate = resolve(
    linked.primaryCheckout,
    relative(linked.root, script)
  );
  return supportsTurnCheck(candidate, runningVersion) ? candidate : null;
};

export const stopHookSettingsPath = (
  harness: TurnGuardHarness,
  environment: Environment = process.env,
  home: string = homedir()
): string =>
  harness === "claude-code"
    ? resolve(
        environment.CLAUDE_CONFIG_DIR?.trim() || resolve(home, ".claude"),
        "settings.json"
      )
    : resolve(
        environment.CODEX_HOME?.trim() || resolve(home, ".codex"),
        "hooks.json"
      );

interface HookHandler {
  command?: unknown;
  timeout?: unknown;
  type?: unknown;
}

interface HookGroup {
  hooks?: HookHandler[];
  matcher?: unknown;
}

interface HookSettings {
  hooks?: { [event: string]: unknown; Stop?: HookGroup[] };
  [key: string]: unknown;
}

const readSettings = (path: string): HookSettings => {
  if (!existsSync(path)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw SimpleChangesError.withCause(
      `Cannot install the turn-end hook: ${path} is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }). Fix the file, then retry.`,
      EXIT_CODES.validation,
      error
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SimpleChangesError(
      `Cannot install the turn-end hook: ${path} does not hold a JSON object.`,
      EXIT_CODES.validation
    );
  }
  return parsed as HookSettings;
};

const turnCheckHandlers = (settings: HookSettings): HookHandler[] =>
  (Array.isArray(settings.hooks?.Stop) ? settings.hooks.Stop : []).flatMap(
    (group) =>
      Array.isArray(group?.hooks)
        ? group.hooks.filter(
            (handler) =>
              typeof handler?.command === "string" &&
              handler.command.includes(TURN_CHECK_MARKER)
          )
        : []
  );

// Repoint an existing turn-check handler in place, or add one Stop group;
// every other key, event, and handler is kept as it was.
const mergeTurnCheckHook = (
  settings: HookSettings,
  command: string,
  installed: boolean
): HookSettings => {
  const hooks = { ...(settings.hooks ?? {}) };
  const stop = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  if (installed) {
    for (const handler of stop.flatMap((group) => group.hooks ?? [])) {
      if (
        typeof handler.command === "string" &&
        handler.command.includes(TURN_CHECK_MARKER)
      ) {
        handler.command = command;
      }
    }
  } else {
    stop.push({ hooks: [{ command, timeout: 15, type: "command" }] });
  }
  hooks.Stop = stop;
  return { ...settings, hooks };
};

// Keep the settings file's own permissions; a new file gets the usual 0644.
const writeSettings = (path: string, settings: HookSettings): void => {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode % 0o1000 : 0o644;
  const temporary = `${path}.${process.pid}.simple-changes.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  renameSync(temporary, path);
};

/**
 * Report, and with `write` install, the user-level Stop hook that runs `loop
 * turn-check` for one harness. Writing merges into the existing settings: an
 * earlier turn-check handler is updated in place and every other setting and
 * hook is kept. It is persistent harness configuration, so callers ask first.
 */
export const stopHookStatus = (
  harness: TurnGuardHarness,
  scriptPath: string,
  runningVersion: string,
  write: boolean,
  environment: Environment = process.env
): StopHookStatus => {
  const configuredPath = stopHookSettingsPath(harness, environment);
  // Settings are often symlinked from a dotfiles checkout; write the target.
  const path =
    existsSync(configuredPath) && lstatSync(configuredPath).isSymbolicLink()
      ? realpathSync(configuredPath)
      : configuredPath;
  const command = stopHookCommand(scriptPath);
  const settings = readSettings(path);
  const existing = turnCheckHandlers(settings);
  const installed = existing.length > 0;
  const current = existing.some(
    (handler) =>
      typeof handler.command === "string" &&
      hookIsCurrent(handler.command, command, runningVersion)
  );
  if (!write || current) {
    return { command, current, harness, installed, path, written: false };
  }
  if (insideLinkedWorktree(scriptPath)) {
    throw new SimpleChangesError(
      `Refusing to point the user-level turn-end hook at ${scriptPath}: it lives in a linked Git worktree that is removed when its work ships. Install from the globally installed Simple Changes copy instead.`,
      EXIT_CODES.unsafe
    );
  }
  writeSettings(path, mergeTurnCheckHook(settings, command, installed));
  return {
    command,
    current: true,
    harness,
    installed: true,
    path,
    written: true,
  };
};
