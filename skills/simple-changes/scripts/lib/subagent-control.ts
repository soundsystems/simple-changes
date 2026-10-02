import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * One in-flight background task as a Claude Code Stop hook reports it in
 * `background_tasks`: running or pending work the session is waiting on.
 */
export interface HookBackgroundTask {
  description: string;
  id: string;
  status: string;
  type: string;
}

/** A still-running background subagent that is driving a run itself. */
export interface SubagentControl {
  agentId: string;
  description: string;
  lastCommandAt: string;
}

export interface TranscriptScanLimits {
  /** Total wall-clock budget for reading every transcript in one hook. */
  budgetMs: number;
  /** A larger transcript is not read; a parent's that large blocks. */
  maxBytes: number;
}

/**
 * The hook runs under a 15-second harness timeout, and a timed-out hook lets
 * the turn end. Scanning stops well inside it and then proves nothing, so
 * the guard blocks instead.
 */
export const TRANSCRIPT_SCAN_LIMITS: TranscriptScanLimits = {
  budgetMs: 5000,
  maxBytes: 64 * 1024 * 1024,
};

/**
 * How much later than a subagent's last owner command the lease may have been
 * written before something else is taken to be driving the run.
 */
export const LEASE_WRITE_TOLERANCE_MS = 60_000;

const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const IN_FLIGHT = new Set(["pending", "running"]);
// A run ID taken from output must be the JSON `runId` a successful command
// printed, never a run named in an error or a status line.
const RUN_ID_FIELD = /"runId"\s*:\s*"(run-[a-z0-9-]+)"/gu;
const LOOP_ACTION = /(?:^|[\s;&|(])loop\s+([a-z][a-z-]*)/gu;
const SEGMENT_END = /;|&&|\|\||\||\n|\s--(?:\s|$)/u;
// A value is a literal: it ends at whitespace, a quote, or a shell operator or
// closer, and one that starts with `$` is a shell expansion, not an ID.
const AGENT_FLAG =
  /--agent-id(?:=|\s+)(["']?)([^\s"';&|()<>`$]+)\1(?=$|[\s"';&|()<>`])/u;
const RUN_FLAG =
  /--run-id(?:=|\s+)(["']?)([^\s"';&|()<>`$]+)\1(?=$|[\s"';&|()<>`])/u;
// Actions that only read state prove nothing about who drives a run; `verify`
// takes no owner and checks evidence anyone may check.
const READ_ONLY_ACTIONS = new Set([
  "replan-status",
  "status",
  "turn-check",
  "verify",
]);
// Only these actions print a run ID their command did not name.
const RUN_FROM_OUTPUT = new Set(["start", "takeover"]);

class ScanBudgetExceeded extends Error {}

interface Scan {
  deadline: number;
  limits: TranscriptScanLimits;
}

/** One Simple Changes `loop` command an agent issued as a named owner. */
interface OwnerCommand {
  action: string;
  agentId: string;
  /** When the command ran, or +Infinity when the parent's time is unknown. */
  at: number;
  /** When its output arrived; null while it is still running. */
  completedAt: number | null;
  /** The literal directory it ran in, or null when unknown. */
  directory: string | null;
  /** A subagent command that failed names its agent but shows no control. */
  failed: boolean;
  /** A read-only action names an agent but never shows control. */
  readOnly: boolean;
  runIds: Set<string>;
}

interface TranscriptBlock {
  content?: unknown;
  id?: unknown;
  input?: { command?: unknown };
  is_error?: unknown;
  text?: unknown;
  tool_use_id?: unknown;
  type?: unknown;
}

interface TranscriptEntry {
  agentId?: unknown;
  cwd?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown };
  timestamp?: unknown;
  type?: unknown;
}

const blocks = (entry: TranscriptEntry): TranscriptBlock[] =>
  Array.isArray(entry.message?.content)
    ? (entry.message.content as TranscriptBlock[])
    : [];

const resultText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((part: TranscriptBlock | null) =>
          typeof part?.text === "string" ? part.text : ""
        )
        .join("\n")
    : "";
};

/**
 * The Simple Changes `loop` invocations in one shell command that name an
 * owner with `--agent-id`. A `loop` word counts only after the command has
 * named Simple Changes, as its script, bin, or a fork's runtime wrapper, and
 * its flags are read up to the next shell separator or `--`.
 */
export const ownerLoopInvocations = (
  command: string
): { action: string; agentId: string; runId: string | null }[] =>
  loopInvocations(command)
    .filter((invocation) => !invocation.readOnly)
    .map(({ action, agentId, runId }) => ({ action, agentId, runId }));

interface LoopInvocation {
  action: string;
  agentId: string;
  /** The literal directory the invocation ran in, or null when unknown. */
  directory: string | null;
  readOnly: boolean;
  runId: string | null;
}

const REPO_FLAG =
  /--repo(?:=|\s+)(["']?)([^\s"';&|()<>`$]+)\1(?=$|[\s"';&|()<>`])/u;
const CHANGE_DIRECTORY =
  /(?:^|[\s;&|(])(?:cd|pushd)\s+(["']?)([^\s"';&|()<>`]*)\1(?=$|[\s;&|()])/gu;

const literalDirectory = (value: string | undefined): string | null =>
  value && isAbsolute(value) && !value.includes("$") ? value : null;

// Where an invocation ran: its own `--repo`, else the last `cd` before it,
// else the shell's directory when the command never changed it. A `cd` to
// anything but a literal absolute path makes the directory unknown.
const invocationDirectory = (
  command: string,
  start: number,
  segment: string,
  shellDirectory: string | null
): string | null => {
  const repo = REPO_FLAG.exec(segment)?.[2];
  if (repo) {
    return literalDirectory(repo);
  }
  const changes = [...command.slice(0, start).matchAll(CHANGE_DIRECTORY)];
  const last = changes.at(-1);
  return last ? literalDirectory(last[2]) : shellDirectory;
};

// Every Simple Changes `loop` invocation naming a literal `--agent-id`,
// read-only ones included.
const loopInvocations = (
  command: string,
  shellDirectory: string | null = null
): LoopInvocation[] => {
  const invocations: LoopInvocation[] = [];
  for (const match of command.matchAll(LOOP_ACTION)) {
    const start = match.index ?? 0;
    if (!command.slice(0, start).includes("simple-changes")) {
      continue;
    }
    const rest = command.slice(start + match[0].length);
    const end = SEGMENT_END.exec(rest)?.index ?? rest.length;
    const segment = rest.slice(0, end);
    const agentId = AGENT_FLAG.exec(segment)?.[2];
    if (agentId) {
      const action = match[1] ?? "";
      invocations.push({
        action,
        agentId,
        directory: invocationDirectory(command, start, segment, shellDirectory),
        readOnly: READ_ONLY_ACTIONS.has(action),
        runId: RUN_FLAG.exec(segment)?.[2] ?? null,
      });
    }
  }
  return invocations;
};

const entryTime = (entry: TranscriptEntry): number | null => {
  const at = Date.parse(String(entry.timestamp));
  return Number.isFinite(at) ? at : null;
};

const readTranscript = (path: string, scan: Scan): string => {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
  if (stat.size > scan.limits.maxBytes) {
    throw new ScanBudgetExceeded(`${path} exceeds the transcript size cap`);
  }
  return readFileSync(path, "utf8");
};

interface TranscriptOwner {
  /** Only entries carrying this agent ID count; null for the parent. */
  agentId: string | null;
}

const TOOL_USE_ID_KEY = '"tool_use_id":"';

// Whether the line carries output for a command being tracked, found without
// parsing the line.
const answersTracked = (
  line: string,
  commands: Map<string, OwnerCommand[]>
): boolean => {
  let from = line.indexOf(TOOL_USE_ID_KEY);
  while (from !== -1) {
    const start = from + TOOL_USE_ID_KEY.length;
    const end = line.indexOf('"', start);
    if (end !== -1 && commands.has(line.slice(start, end))) {
      return true;
    }
    from = line.indexOf(TOOL_USE_ID_KEY, start);
  }
  return false;
};

/**
 * Every owner `loop` command a transcript's own agent issued. The parent's
 * entries without a readable time count as the newest, so missing evidence
 * never ages its control; a subagent's are ignored, so it never proves the
 * subagent newer. Sidechain entries are another agent's and never the parent's.
 * A command whose output is an error still counts for the parent, which tried
 * to command the run, but never for a subagent.
 */
const ownerCommands = (
  path: string,
  owner: TranscriptOwner,
  scan: Scan
): OwnerCommand[] => {
  const commands = new Map<string, OwnerCommand[]>();
  const lines = readTranscript(path, scan).split("\n");
  for (const [index, line] of lines.entries()) {
    if (index % 4096 === 0 && Date.now() > scan.deadline) {
      throw new ScanBudgetExceeded("transcript scan ran out of time");
    }
    const isCommand = line.includes("--agent-id") && line.includes("loop");
    if (!(isCommand || (commands.size > 0 && answersTracked(line, commands)))) {
      continue;
    }
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    const foreign =
      owner.agentId === null
        ? entry.isSidechain === true
        : entry.agentId !== owner.agentId;
    const parsedAt = entryTime(entry);
    if (foreign || (parsedAt === null && owner.agentId !== null)) {
      continue;
    }
    const at = parsedAt ?? Number.POSITIVE_INFINITY;
    for (const block of blocks(entry)) {
      recordBlock(entry, block, at, commands, owner.agentId !== null);
    }
  }
  return [...commands.values()].flat();
};

const recordBlock = (
  entry: TranscriptEntry,
  block: TranscriptBlock,
  at: number,
  commands: Map<string, OwnerCommand[]>,
  dropFailed: boolean
): void => {
  if (
    entry.type === "assistant" &&
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    typeof block.input?.command === "string"
  ) {
    const invocations = loopInvocations(
      block.input.command,
      typeof entry.cwd === "string" ? literalDirectory(entry.cwd) : null
    );
    if (invocations.length > 0) {
      commands.set(
        block.id,
        invocations.map((invocation) => ({
          action: invocation.action,
          agentId: invocation.agentId,
          at,
          completedAt: null,
          directory: invocation.directory,
          failed: false,
          readOnly: invocation.readOnly,
          runIds: new Set(invocation.runId ? [invocation.runId] : []),
        }))
      );
    }
    return;
  }
  if (
    entry.type !== "user" ||
    block.type !== "tool_result" ||
    typeof block.tool_use_id !== "string"
  ) {
    return;
  }
  recordResult(block, block.tool_use_id, at, commands, dropFailed);
};

// Output completes its commands. A failed subagent command shows no control;
// a run ID is read only from a successful start or takeover's JSON.
const recordResult = (
  block: TranscriptBlock,
  toolUseId: string,
  at: number,
  commands: Map<string, OwnerCommand[]>,
  dropFailed: boolean
): void => {
  const failed = block.is_error === true;
  for (const command of commands.get(toolUseId) ?? []) {
    command.completedAt = at;
    command.failed = failed && dropFailed;
    if (
      failed ||
      command.runIds.size > 0 ||
      !RUN_FROM_OUTPUT.has(command.action)
    ) {
      continue;
    }
    for (const [, runId] of resultText(block.content).matchAll(RUN_ID_FIELD)) {
      if (runId) {
        command.runIds.add(runId);
      }
    }
  }
};

interface RunActivity {
  /** Whether an owner command for the run is still waiting for its output. */
  inFlight: boolean;
  /** The latest time an owner command for the run ran or returned. */
  lastAt: number;
}

const activityOf = (matching: OwnerCommand[]): RunActivity | null => {
  if (matching.length === 0) {
    return null;
  }
  return {
    inFlight: matching.some((command) => command.completedAt === null),
    lastAt: Math.max(
      ...matching.map((command) =>
        Math.max(command.at, command.completedAt ?? command.at)
      )
    ),
  };
};

// Owner commands that name the run literally.
const runActivity = (
  commands: OwnerCommand[],
  runId: string,
  ownerAgentId: string
): RunActivity | null =>
  activityOf(
    commands.filter(
      (command) =>
        !(command.readOnly || command.failed) &&
        command.agentId === ownerAgentId &&
        command.runIds.has(runId)
    )
  );

// Owner commands under the run's owner ID that name no run, as when the run
// ID is a shell variable or `loop start` output went to a file.
const unnamedOwnerCommands = (
  commands: OwnerCommand[],
  ownerAgentId: string
): OwnerCommand[] =>
  commands.filter(
    (command) =>
      !(command.readOnly || command.failed) &&
      command.agentId === ownerAgentId &&
      command.runIds.size === 0
  );

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const within = (path: string, roots: string[]): boolean => {
  const target = canonical(path);
  return roots.some((root) => {
    const offset = relative(canonical(root), target);
    return offset === "" || !(offset.startsWith("..") || isAbsolute(offset));
  });
};

const usesAgentId = (commands: OwnerCommand[], agentId: string): boolean =>
  commands.some((command) => command.agentId === agentId);

export interface RunToAttribute {
  leaseUpdatedAt: string;
  ownerAgentId: string;
  /** The run's primary checkout and every worktree of its repository. */
  repositoryRoots: string[];
  runId: string;
}

/**
 * Reads one Stop hook's transcripts once and answers, per run, which still
 * running background subagent of the session is driving it.
 */
export interface SubagentControlIndex {
  controllerOf: (run: RunToAttribute) => SubagentControl | null;
}

const NOBODY: SubagentControlIndex = { controllerOf: () => null };

interface SubagentTranscript {
  commands: OwnerCommand[];
  task: HookBackgroundTask;
}

/**
 * Background subagents share their parent's session ID and process, so the
 * lease cannot tell them apart; the Stop hook's own input can. A subagent
 * drives a run only when the hook lists it as in flight, its own transcript
 * issued an owner `loop` command for the run, the parent's transcript did not
 * issue one since, and the lease was not written well after the subagent's
 * last such command, which would mean something else is driving it. When no
 * command names the run literally, successful owner commands under the
 * lease's exact owner ID count instead, but only when no parent command and
 * no other running subagent ever used that ID. An
 * unreadable, oversized, or slow parent transcript proves nothing, so every
 * run stays the parent's and the guard blocks. Workflow agents are not
 * considered.
 */
export const subagentControlIndex = (
  transcriptPath: string | null,
  backgroundTasks: HookBackgroundTask[],
  limits: TranscriptScanLimits = TRANSCRIPT_SCAN_LIMITS,
  now: () => number = Date.now
): SubagentControlIndex => {
  const subagents = backgroundTasks.filter(
    (task) =>
      task.type === "subagent" &&
      IN_FLIGHT.has(task.status) &&
      TASK_ID_PATTERN.test(task.id)
  );
  if (!transcriptPath?.endsWith(".jsonl") || subagents.length === 0) {
    return NOBODY;
  }
  const scan: Scan = { deadline: now() + limits.budgetMs, limits };
  let parent: OwnerCommand[];
  const transcripts: SubagentTranscript[] = [];
  try {
    parent = ownerCommands(transcriptPath, { agentId: null }, scan);
    const directory = resolve(
      dirname(transcriptPath),
      basename(transcriptPath, ".jsonl"),
      "subagents"
    );
    for (const task of subagents) {
      try {
        transcripts.push({
          commands: ownerCommands(
            resolve(directory, `agent-${task.id}.jsonl`),
            { agentId: task.id },
            scan
          ),
          task,
        });
      } catch (error) {
        if (error instanceof ScanBudgetExceeded) {
          throw error;
        }
      }
    }
  } catch {
    return NOBODY;
  }
  return {
    controllerOf: ({
      leaseUpdatedAt,
      ownerAgentId,
      repositoryRoots,
      runId,
    }) => {
      const leaseWrittenAt = Date.parse(leaseUpdatedAt);
      // Without a literal run ID, the owner ID alone identifies the driver,
      // but only while exactly one running subagent and never the parent
      // used it.
      const users = transcripts.filter(({ commands }) =>
        usesAgentId(commands, ownerAgentId)
      );
      const ownerIdDriver =
        users.length === 1 && !usesAgentId(parent, ownerAgentId)
          ? users[0]
          : undefined;
      let best: Driver | null = null;
      for (const transcript of transcripts) {
        const driver = driverOf(
          transcript,
          transcript === ownerIdDriver,
          runId,
          ownerAgentId,
          repositoryRoots
        );
        if (
          driver &&
          (!best || driver.activity.lastAt > best.activity.lastAt)
        ) {
          best = driver;
        }
      }
      const parentLastAt = runActivity(parent, runId, ownerAgentId)?.lastAt;
      if (
        !best ||
        (parentLastAt !== undefined && parentLastAt >= best.activity.lastAt) ||
        !Number.isFinite(leaseWrittenAt) ||
        (!best.activity.inFlight &&
          leaseWrittenAt > best.activity.lastAt + LEASE_WRITE_TOLERANCE_MS)
      ) {
        return null;
      }
      return {
        agentId: best.task.id,
        description: best.task.description,
        lastCommandAt: new Date(best.activity.lastAt).toISOString(),
      };
    },
  };
};

interface Driver {
  activity: RunActivity;
  task: HookBackgroundTask;
}

/**
 * One subagent's evidence for a run. Commands naming the run count as they
 * are. When the owner ID uniquely identifies this subagent, its commands that
 * name no run count too, but those could serve another run under the same ID:
 * at least one of them must have run in this run's repository, and no command
 * still waiting for output excuses a later lease write.
 */
const driverOf = (
  { commands, task }: SubagentTranscript,
  ownerIdOnly: boolean,
  runId: string,
  ownerAgentId: string,
  repositoryRoots: string[]
): Driver | null => {
  const named = commands.filter(
    (command) =>
      !(command.readOnly || command.failed) &&
      command.agentId === ownerAgentId &&
      command.runIds.has(runId)
  );
  const unnamed = ownerIdOnly
    ? unnamedOwnerCommands(commands, ownerAgentId)
    : [];
  // Commands that name no run count only when one of them ran in this run's
  // repository; otherwise they may serve another run under the same ID.
  const inRepository = unnamed.some(
    (command) =>
      command.directory !== null && within(command.directory, repositoryRoots)
  );
  if (!inRepository) {
    const activity = activityOf(named);
    return activity ? { activity, task } : null;
  }
  const activity = activityOf([...named, ...unnamed]);
  return activity ? { activity: { ...activity, inFlight: false }, task } : null;
};

export const parseHookBackgroundTasks = (
  value: unknown
): HookBackgroundTask[] =>
  Array.isArray(value)
    ? value.flatMap(
        (task: Partial<Record<keyof HookBackgroundTask, unknown>> | null) =>
          task &&
          typeof task.id === "string" &&
          typeof task.type === "string" &&
          typeof task.status === "string"
            ? [
                {
                  description:
                    typeof task.description === "string"
                      ? task.description
                      : "",
                  id: task.id,
                  status: task.status,
                  type: task.type,
                },
              ]
            : []
      )
    : [];
