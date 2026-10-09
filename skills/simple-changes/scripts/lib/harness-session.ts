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
import { sha256 } from "./hash.ts";
import { resolvePersonalPolicyPath } from "./policy.ts";
import type { LoopControllerSession } from "./types.ts";

type Environment = Record<string, string | undefined>;

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const RUN_ID_PATTERN = /^run-[a-z0-9-]+$/u;

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

/**
 * The harness session running this command, when the harness says so. Claude
 * Code exports its session ID and the PID of the session's own process; Codex
 * exports its thread ID. The session lets a turn-end hook recognize the runs
 * its own session controls, and a recorded session process that has exited
 * is evidence the owner is gone. Without either variable there is no binding.
 */
export const currentHarnessSession = (
  environment: Environment = process.env
): LoopControllerSession | null => {
  const claude = environment.CLAUDE_CODE_SESSION_ID?.trim();
  if (claude && SESSION_ID_PATTERN.test(claude)) {
    return {
      harness: "claude-code",
      hostname: hostname(),
      hostPid: visibleProcess(positiveInteger(environment.CLAUDE_PID)),
      sessionId: claude,
    };
  }
  const codex = environment.CODEX_THREAD_ID?.trim();
  if (codex && SESSION_ID_PATTERN.test(codex)) {
    return {
      harness: "codex",
      hostname: hostname(),
      hostPid: null,
      sessionId: codex,
    };
  }
  return null;
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
