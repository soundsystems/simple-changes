import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { resolvePersonalPolicyPath } from "./policy.ts";
import { RUN_ID_PATTERN } from "./run-id.ts";
import type { LoopControllerSession } from "./types.ts";

type Environment = Record<string, string | undefined>;

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

const positiveInteger = (value: string | undefined): number | null => {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

// A sandbox with its own process namespace cannot see the harness process, so
// a PID that is not visible now is not recorded: its later absence would prove
// nothing about the session.
const visibleProcess = (pid: number | null): number | null => {
  if (pid === null) {
    return null;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null;
  }
};

/**
 * The harness ids this adapter identifies from their session variables. For
 * these, `currentHarnessSession` alone decides whether one is running; the
 * authoring detection consults `agents/harnesses.json` for every other id.
 */
export const SESSION_HARNESS_IDS: readonly string[] = ["claude-code", "codex"];

type SessionHarness = LoopControllerSession["harness"];

// Each harness's own session variable. A harness started from another one
// inherits the parent's variable beside its own, so no fixed order between
// them can say which harness is running.
const SESSION_VARIABLES: Record<SessionHarness, string> = {
  "claude-code": "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
};

export const isSessionHarness = (value: unknown): value is SessionHarness =>
  typeof value === "string" && Object.hasOwn(SESSION_VARIABLES, value);

export const isHarnessSessionId = (value: unknown): value is string =>
  typeof value === "string" && SESSION_ID_PATTERN.test(value);

/**
 * Every harness session the environment names, one per harness whose own
 * variable holds a valid session ID. Claude Code exports its session ID and
 * the PID of the session's own process; Codex exports its thread ID.
 */
export const harnessSessionsIn = (
  environment: Environment
): LoopControllerSession[] =>
  (Object.keys(SESSION_VARIABLES) as SessionHarness[]).flatMap((harness) => {
    const sessionId = environment[SESSION_VARIABLES[harness]]?.trim();
    if (!(sessionId && SESSION_ID_PATTERN.test(sessionId))) {
      return [];
    }
    return [
      {
        harness,
        hostname: hostname(),
        hostPid:
          harness === "claude-code"
            ? visibleProcess(positiveInteger(environment.CLAUDE_PID))
            : null,
        sessionId,
      },
    ];
  });

/**
 * How the executing harness session was decided. `none`: no session
 * variable is set. `detected`: exactly one is, and nothing was named.
 * `selected`: the harness this command named (`--harness`, or an identity
 * receipt) has its session variable set. `ambiguous`: more than one is set
 * and nothing named one, as when one harness starts another and the child
 * inherits the parent's variable. `mismatch`: the named harness has no
 * session here.
 */
export interface HarnessSessionResolution {
  /** The harnesses whose session variables are set. */
  present: SessionHarness[];
  /** The harness this command named, if any. */
  requested: string | null;
  session: LoopControllerSession | null;
  status: "none" | "detected" | "selected" | "ambiguous" | "mismatch";
}

// The harness this command invocation named with `--harness` or an identity
// receipt, set by the command line for its one command. It lives in this
// process only: an environment variable would be inherited by a nested
// harness, which is the very confusion it resolves.
let invocationHarness: string | null = null;

/**
 * Names the harness this invocation runs in for every session lookup that
 * follows; returns a function that restores the previous value.
 */
export const selectInvocationHarness = (
  harness: string | null
): (() => void) => {
  const previous = invocationHarness;
  invocationHarness = harness;
  return () => {
    invocationHarness = previous;
  };
};

export const resolveHarnessSession = (
  environment: Environment = process.env,
  requested: string | null = invocationHarness
): HarnessSessionResolution => {
  const sessions = harnessSessionsIn(environment);
  const present = sessions.map((item) => item.harness);
  if (requested !== null) {
    const session = sessions.find((item) => item.harness === requested);
    return session
      ? { present, requested, session, status: "selected" }
      : { present, requested, session: null, status: "mismatch" };
  }
  if (sessions.length > 1) {
    return { present, requested, session: null, status: "ambiguous" };
  }
  const [session = null] = sessions;
  return {
    present,
    requested,
    session,
    status: session ? "detected" : "none",
  };
};

/** The refusal for a command that cannot tell which session it runs in. */
export const ambiguousSessionMessage = (
  present: readonly SessionHarness[],
  command: string
): string =>
  `${command} cannot tell which harness session it runs in: the environment names sessions of ${present
    .map((harness) => `${harness} (${SESSION_VARIABLES[harness]})`)
    .join(
      " and "
    )}, as when one harness starts another and the child inherits the parent's variable. Pass --harness <id> naming the harness you run in, or --identity-receipt from your harness, and that harness's own session variable is used.`;

/** The refusal for a named harness that has no session here. */
export const mismatchedSessionMessage = (
  requested: string,
  present: readonly SessionHarness[]
): string =>
  `--harness ${requested} disagrees with the executing harness (${present.join(", ") || "none reported"}); the harness is read from the executing process only.`;

/**
 * The harness session running this command, when it is clear. One session
 * variable decides alone; with more than one, only the harness this command
 * named decides, and otherwise there is no session rather than a guess. The
 * session lets a turn-end hook recognize the runs its own session controls,
 * and a recorded session process that has exited is evidence the owner is
 * gone. Without a session there is no binding.
 */
export const currentHarnessSession = (
  environment: Environment = process.env,
  requested: string | null = invocationHarness
): LoopControllerSession | null =>
  resolveHarnessSession(environment, requested).session;

/**
 * The executing session for a command that records or checks it: null when
 * no session variable is set, and a refusal when the environment names more
 * than one and the command did not say which (exit 2), or when the harness
 * it named has no session here (exit 5).
 */
export const requireHarnessSession = (
  command: string,
  environment: Environment = process.env,
  requested: string | null = invocationHarness
): LoopControllerSession | null => {
  const resolution = resolveHarnessSession(environment, requested);
  if (resolution.status === "ambiguous") {
    throw new SimpleChangesError(
      ambiguousSessionMessage(resolution.present, command),
      EXIT_CODES.usage
    );
  }
  if (resolution.status === "mismatch") {
    throw new SimpleChangesError(
      mismatchedSessionMessage(resolution.requested ?? "", resolution.present),
      EXIT_CODES.unsafe
    );
  }
  return resolution.session;
};

export const controllerSessionIndexDirectory = (
  environment: Environment = process.env
): string =>
  resolve(
    dirname(resolvePersonalPolicyPath({ environment })),
    "controller-sessions"
  );

// Keyed by session ID alone: a turn-end hook receives the session ID but not
// always the harness name, and harness session IDs do not collide.
const sessionDirectory = (
  sessionId: string,
  environment: Environment
): string =>
  resolve(
    controllerSessionIndexDirectory(environment),
    sha256(`session:${sessionId}`).slice(0, 32)
  );

export interface ControllerSessionEntry {
  commonGitDirectory: string;
  recordedAt: string;
  runId: string;
}

/**
 * Remember that this session controls a run, so a turn-end hook can find it
 * even when the session's working directory is another repository. The index
 * is only a pointer: the lease in the repository stays authoritative. Writing
 * it is best effort and never fails the loop command.
 */
export const recordControllerSession = (
  session: LoopControllerSession | null,
  commonGitDirectory: string,
  runId: string,
  environment: Environment = process.env
): void => {
  if (!(session && RUN_ID_PATTERN.test(runId))) {
    return;
  }
  try {
    const directory = sessionDirectory(session.sessionId, environment);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const entry: ControllerSessionEntry = {
      commonGitDirectory,
      recordedAt: new Date().toISOString(),
      runId,
    };
    const path = resolve(directory, `${runId}.json`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // The hook falls back to finding nothing; the lease is unaffected.
  }
};

export const forgetControllerSession = (
  sessionId: string,
  runId: string,
  environment: Environment = process.env
): void => {
  if (!RUN_ID_PATTERN.test(runId)) {
    return;
  }
  try {
    rmSync(resolve(sessionDirectory(sessionId, environment), `${runId}.json`), {
      force: true,
    });
  } catch {
    // A stale pointer is pruned the next time the hook reads it.
  }
};

export const listControllerSessionEntries = (
  sessionId: string,
  environment: Environment = process.env
): ControllerSessionEntry[] => {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return [];
  }
  const directory = sessionDirectory(sessionId, environment);
  if (!existsSync(directory)) {
    return [];
  }
  const entries: ControllerSessionEntry[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        readFileSync(resolve(directory, name), "utf8")
      ) as Partial<ControllerSessionEntry>;
      if (
        typeof parsed.commonGitDirectory === "string" &&
        typeof parsed.runId === "string" &&
        RUN_ID_PATTERN.test(parsed.runId) &&
        typeof parsed.recordedAt === "string"
      ) {
        entries.push({
          commonGitDirectory: parsed.commonGitDirectory,
          recordedAt: parsed.recordedAt,
          runId: parsed.runId,
        });
      }
    } catch {
      // Ignore unreadable pointers; they are never authority.
    }
  }
  return entries;
};
