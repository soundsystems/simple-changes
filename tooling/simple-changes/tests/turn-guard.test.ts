import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  currentHarnessSession,
  listControllerSessionEntries,
} from "../../../skills/simple-changes/scripts/lib/harness-session.ts";
import {
  finalizeLoop,
  guardLoopMutation,
  LEASE_STALE_AFTER_MS,
  leaseLiveness,
  loopLeasePath,
  readControllerBinding,
  readLoopLease,
  recoverStaleLoopLease,
  SESSION_EXIT_GRACE_MS,
  staleLeaseArchivePath,
  startLoop,
  turnEndReminder,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { runtimeFreshness } from "../../../skills/simple-changes/scripts/lib/runtime-freshness.ts";
import {
  ownerLoopInvocations,
  subagentControlIndex,
} from "../../../skills/simple-changes/scripts/lib/subagent-control.ts";
import {
  hookInstallScript,
  parseTurnCheckHookInput,
  stopHookCommand,
  stopHookStatus,
  turnCheck,
  turnCheckHookOutput,
} from "../../../skills/simple-changes/scripts/lib/turn-guard.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import { createTestRepository, git, type TestRepository } from "./helpers.ts";

const SCRIPT = resolve(
  import.meta.dir,
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "66666666-7777-4888-8999-000000000000";
const HARNESS_VARIABLES = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
  "CODEX_THREAD_ID",
  "SIMPLE_CHANGES_CONFIG_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
] as const;

let fixtures: TestRepository[] = [];
let configDirectory = "";
let saved: Record<string, string | undefined> = {};

const useSession = (sessionId: string, hostPid?: number): void => {
  process.env.CLAUDE_CODE_SESSION_ID = sessionId;
  if (hostPid === undefined) {
    delete process.env.CLAUDE_PID;
  } else {
    process.env.CLAUDE_PID = String(hostPid);
  }
};

const fixture = (): TestRepository => {
  const created = createTestRepository();
  fixtures.push(created);
  return created;
};

const deadPid = (): number => {
  const child = spawnSync("true");
  return child.pid ?? 99_998;
};

beforeEach(() => {
  saved = Object.fromEntries(
    HARNESS_VARIABLES.map((name) => [name, process.env[name]])
  );
  configDirectory = mkdtempSync(join(tmpdir(), "simple-changes-config-"));
  process.env.SIMPLE_CHANGES_CONFIG_DIR = configDirectory;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_PID;
  delete process.env.CODEX_THREAD_ID;
});

afterEach(() => {
  for (const name of HARNESS_VARIABLES) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
  rmSync(configDirectory, { force: true, recursive: true });
  for (const created of fixtures) {
    created.cleanup();
  }
  fixtures = [];
});

describe("harness session detection", () => {
  test("reads Claude Code and Codex session variables and nothing else", () => {
    expect(currentHarnessSession({})).toBeNull();
    expect(
      currentHarnessSession({
        CLAUDE_CODE_SESSION_ID: SESSION,
        CLAUDE_PID: String(process.pid),
      })
    ).toEqual({
      harness: "claude-code",
      hostname: hostname(),
      hostPid: process.pid,
      sessionId: SESSION,
    });
    // A PID this process cannot see, as inside a sandboxed namespace, is not
    // recorded.
    expect(
      currentHarnessSession({
        CLAUDE_CODE_SESSION_ID: SESSION,
        CLAUDE_PID: String(deadPid()),
      })?.hostPid
    ).toBeNull();
    expect(currentHarnessSession({ CODEX_THREAD_ID: OTHER_SESSION })).toEqual({
      harness: "codex",
      hostname: hostname(),
      hostPid: null,
      sessionId: OTHER_SESSION,
    });
    expect(
      currentHarnessSession({ CLAUDE_CODE_SESSION_ID: "not a/valid id" })
    ).toBeNull();
  });
});

describe("turn-end guard", () => {
  test("blocks a turn while this session controls an active run, then lets a paused run end", () => {
    const repository = fixture();
    useSession(SESSION);
    const lease = startLoop(repository.root, "controller", "integrate");

    expect(readControllerBinding(lease)?.session).toMatchObject({
      harness: "claude-code",
      sessionId: SESSION,
    });
    // The lease itself keeps the shape older runtimes validate.
    expect(Object.keys(lease.controller ?? {}).sort()).toEqual([
      "acquiredAt",
      "handoffs",
      "reason",
      "relinquishedAt",
      "status",
    ]);
    expect(listControllerSessionEntries(SESSION)).toHaveLength(1);

    const blocked = turnCheck({ sessionId: SESSION, stopHookActive: false });
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain(lease.runId);
    expect(blocked.reason).toContain("loop finalize");
    expect(blocked.reason).toContain("--awaiting-user");
    expect(JSON.parse(turnCheckHookOutput(blocked))).toEqual({
      decision: "block",
      reason: blocked.reason,
    });

    const repeated = turnCheck({ sessionId: SESSION, stopHookActive: true });
    expect(repeated.decision).toBe("warn");
    expect(JSON.parse(turnCheckHookOutput(repeated))).toEqual({
      systemMessage: repeated.reason,
    });

    expect(
      turnCheck({ sessionId: OTHER_SESSION, stopHookActive: false }).decision
    ).toBe("allow");

    const paused = finalizeLoop(
      repository.root,
      lease.runId,
      "controller",
      "Ask the user which migration to apply.",
      { awaitingUser: ["Apply migration 0042 to production?"] }
    );
    expect(paused.outcome).toBe("relinquished");
    expect(paused.receipt.awaitingUser).toEqual([
      "Apply migration 0042 to production?",
    ]);
    const pausedLease = readLoopLease(repository.root);
    expect(pausedLease?.controller?.status).toBe("relinquished");
    expect(
      pausedLease ? readControllerBinding(pausedLease)?.awaitingUser : null
    ).toMatchObject({ questions: ["Apply migration 0042 to production?"] });
    expect(
      turnCheck({ sessionId: SESSION, stopHookActive: false }).decision
    ).toBe("allow");
    expect(listControllerSessionEntries(SESSION)).toHaveLength(0);
  });

  test("a resumed controller inherits the questions its predecessor paused on", () => {
    const repository = fixture();
    useSession(SESSION);
    const lease = startLoop(repository.root, "controller", "integrate");
    finalizeLoop(repository.root, lease.runId, "controller", "Pause.", {
      awaitingUser: ["Ship the web deploy now?"],
    });

    useSession(OTHER_SESSION);
    const resumed = startLoop(repository.root, "next-controller", "resume");

    expect(resumed.controller?.status).toBe("active");
    expect(resumed.controller?.handoffs.at(-1)).toMatchObject({
      kind: "resume",
      toAgentId: "next-controller",
    });
    expect(readControllerBinding(resumed)).toMatchObject({
      awaitingUser: null,
      inheritedAwaitingUser: ["Ship the web deploy now?"],
      ownerAgentId: "next-controller",
      session: { sessionId: OTHER_SESSION },
    });
    expect(
      turnCheck({ sessionId: OTHER_SESSION, stopHookActive: false }).decision
    ).toBe("block");
    expect(
      turnCheck({ sessionId: SESSION, stopHookActive: false }).decision
    ).toBe("allow");
  });

  test("an owner command rebinds the run to a restarted session", () => {
    const repository = fixture();
    useSession(SESSION);
    const lease = startLoop(repository.root, "controller", "integrate");

    useSession(OTHER_SESSION);
    guardLoopMutation(repository.root, lease.runId, "controller");
    expect(readControllerBinding(lease)?.session?.sessionId).toBe(
      OTHER_SESSION
    );
    expect(
      turnCheck({ sessionId: OTHER_SESSION, stopHookActive: false }).decision
    ).toBe("block");
    expect(
      turnCheck({ sessionId: SESSION, stopHookActive: false }).decision
    ).toBe("allow");

    useSession(SESSION);
    startLoop(repository.root, "controller", "integrate");
    expect(readControllerBinding(lease)?.session?.sessionId).toBe(SESSION);
  });

  test("pausing clears the session and a later tenure ignores the old binding", () => {
    const repository = fixture();
    useSession(SESSION);
    const lease = startLoop(repository.root, "controller", "integrate");
    finalizeLoop(repository.root, lease.runId, "controller", "Pause.", {
      awaitingUser: ["Deploy now?"],
    });
    const paused = readLoopLease(repository.root);
    if (!paused) {
      throw new Error("expected the paused lease");
    }

    expect(readControllerBinding(paused)).toMatchObject({
      awaitingUser: { questions: ["Deploy now?"] },
      session: null,
    });
    expect(listControllerSessionEntries(SESSION)).toHaveLength(0);
    // A runtime that does not write bindings resumes under the same agent ID.
    const { controller } = paused;
    if (!controller) {
      throw new Error("expected a controller lifecycle");
    }
    expect(
      readControllerBinding({
        ...paused,
        controller: { ...controller, acquiredAt: new Date().toISOString() },
      })
    ).toBeNull();
  });

  test("loop start JSON hands a resuming controller the paused questions", () => {
    const repository = fixture();
    useSession(SESSION);
    const lease = startLoop(repository.root, "controller", "integrate");
    finalizeLoop(repository.root, lease.runId, "controller", "Pause.", {
      awaitingUser: ["Apply migration 0042?"],
    });
    const resumed = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "loop",
        "start",
        "--mode",
        "resume",
        "--agent-id",
        "next-controller",
        "--json",
        "--repo",
        repository.root,
      ],
      {
        cwd: repository.root,
        encoding: "utf8",
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: OTHER_SESSION },
      }
    );

    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout).inheritedAwaitingUser).toEqual([
      "Apply migration 0042?",
    ]);
  });

  test("a binding for another run or owner is ignored", () => {
    const repository = fixture();
    useSession(SESSION);
    const lease = startLoop(repository.root, "controller", "integrate");

    expect(
      readControllerBinding({ ...lease, ownerAgentId: "someone-else" })
    ).toBeNull();
    expect(readControllerBinding({ ...lease, runId: "run-other" })).toBeNull();
  });

  test("a completed run drops its session pointer", () => {
    const repository = fixture();
    useSession(SESSION);
    const lease = startLoop(repository.root, "controller", "integrate");

    expect(
      finalizeLoop(repository.root, lease.runId, "controller", "Done.").outcome
    ).toBe("completed");
    expect(listControllerSessionEntries(SESSION)).toHaveLength(0);
    expect(
      turnCheck({ sessionId: SESSION, stopHookActive: false }).decision
    ).toBe("allow");
  });

  test("rejects too many or empty awaiting-user questions before changing anything", () => {
    const repository = fixture();
    const lease = startLoop(repository.root, "controller", "integrate");

    expect(() =>
      finalizeLoop(repository.root, lease.runId, "controller", "Pause.", {
        awaitingUser: Array.from({ length: 11 }, (_, index) => `Q${index}?`),
      })
    ).toThrow("at most 10");
    expect(() =>
      finalizeLoop(repository.root, lease.runId, "controller", "Pause.", {
        awaitingUser: ["  "],
      })
    ).toThrow("awaiting-user question is required");
    expect(readLoopLease(repository.root)).toEqual(lease);
  });

  test("parses hook input defensively", () => {
    expect(
      parseTurnCheckHookInput(
        JSON.stringify({ session_id: SESSION, stop_hook_active: true })
      )
    ).toEqual({
      backgroundTasks: [],
      sessionId: SESSION,
      stopHookActive: true,
      transcriptPath: null,
    });
    expect(
      parseTurnCheckHookInput(
        JSON.stringify({
          background_tasks: [
            {
              description: "Ship",
              id: "a1",
              status: "running",
              type: "subagent",
            },
            { id: 7, status: "running", type: "subagent" },
            null,
          ],
          session_id: SESSION,
          transcript_path: "/t/session.jsonl",
        })
      )
    ).toEqual({
      backgroundTasks: [
        { description: "Ship", id: "a1", status: "running", type: "subagent" },
      ],
      sessionId: SESSION,
      stopHookActive: false,
      transcriptPath: "/t/session.jsonl",
    });
    expect(parseTurnCheckHookInput("not json")).toEqual({
      backgroundTasks: [],
      sessionId: null,
      stopHookActive: false,
      transcriptPath: null,
    });
    expect(
      turnCheckHookOutput({
        decision: "allow",
        reason: null,
        runs: [],
        sessionId: null,
      })
    ).toBe("");
  });

  test("the CLI hook blocks over stdin and never fails the harness", () => {
    const repository = fixture();
    useSession(SESSION);
    const lease = startLoop(repository.root, "controller", "integrate");
    // The hook must find the session from its stdin, not its environment.
    const { CLAUDE_CODE_SESSION_ID: _session, ...environment } = process.env;

    const run = (input: string) =>
      spawnSync(process.execPath, [SCRIPT, "loop", "turn-check", "--hook"], {
        cwd: tmpdir(),
        encoding: "utf8",
        env: environment,
        input,
      });

    const blocked = run(JSON.stringify({ session_id: SESSION }));
    expect(blocked.status).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({ decision: "block" });
    expect(blocked.stdout).toContain(lease.runId);

    const unrelated = run(JSON.stringify({ session_id: OTHER_SESSION }));
    expect(unrelated.status).toBe(0);
    expect(unrelated.stdout).toBe("");

    const garbage = run("{");
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe("");
  });
});

describe("turn-end guard with background subagents", () => {
  const SUBAGENT = "a40a5185ff03e378c";
  const OTHER_SUBAGENT = "a0316717ea7f4d2f6";

  interface Transcripts {
    parent: string;
    subagent: (id: string) => string;
  }

  // Claude Code keeps a session's transcript at <dir>/<session>.jsonl and each
  // subagent's at <dir>/<session>/subagents/agent-<id>.jsonl.
  const transcripts = (): Transcripts => {
    const directory = mkdtempSync(
      join(tmpdir(), "simple-changes-transcripts-")
    );
    fixtures.push({
      cleanup: () => rmSync(directory, { force: true, recursive: true }),
    } as TestRepository);
    const parent = join(directory, `${SESSION}.jsonl`);
    writeFileSync(parent, "");
    return {
      parent,
      subagent: (id) => {
        const path = join(directory, SESSION, "subagents", `agent-${id}.jsonl`);
        mkdirSync(dirname(path), { recursive: true });
        return path;
      },
    };
  };

  interface CallContext {
    /** The subagent writing the entry; omitted for the parent. */
    agentId?: string;
    /** Null leaves the timestamp out. */
    at: Date | null;
    /** The shell directory the transcript records for the entry. */
    cwd?: string;
    /** Marks the output as a failed command, as a nonzero exit does. */
    isError?: boolean;
    sidechain?: boolean;
  }

  let toolUse = 0;
  // One Bash call and its output, as transcript lines.
  const bashCall = (
    command: string,
    output: string,
    context: CallContext
  ): string => {
    toolUse += 1;
    const id = `toolu_${toolUse}`;
    const common = {
      ...(context.agentId ? { agentId: context.agentId } : {}),
      ...(context.cwd ? { cwd: context.cwd } : {}),
      isSidechain: context.sidechain ?? context.agentId !== undefined,
      ...(context.at ? { timestamp: context.at.toISOString() } : {}),
    };
    return `${[
      {
        ...common,
        message: {
          content: [{ id, input: { command }, name: "Bash", type: "tool_use" }],
          role: "assistant",
        },
        type: "assistant",
      },
      {
        ...common,
        message: {
          content: [
            {
              content: output,
              is_error: context.isError ?? false,
              tool_use_id: id,
              type: "tool_result",
            },
          ],
          role: "user",
        },
        type: "user",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
  };

  const secondsAgo = (seconds: number): Date =>
    new Date(Date.now() - seconds * 1000);

  const running = (id: string, status = "running") => ({
    description: "Ship the fork update",
    id,
    status,
    type: "subagent",
  });

  const START =
    "sh scripts/simple-changes-runtime.sh loop start --mode ship --agent-id controller --json";
  const exec = (runId: string): string =>
    `R="bun simple-changes.ts"; $R loop exec --run-id ${runId} --agent-id controller -- git push`;

  // A subagent's `loop start`, whose output alone names the run, then an owner
  // command naming both.
  const driveFromSubagent = (
    paths: Transcripts,
    id: string,
    lease: LoopLease,
    lastSecondsAgo = 5
  ): void => {
    writeFileSync(
      paths.subagent(id),
      bashCall(START, `{"runId":"${lease.runId}"}`, {
        agentId: id,
        at: secondsAgo(lastSecondsAgo + 5),
      }) +
        bashCall(exec(lease.runId), "ok", {
          agentId: id,
          at: secondsAgo(lastSecondsAgo),
        })
    );
  };

  const check = (paths: Transcripts, backgroundTasks = [running(SUBAGENT)]) =>
    turnCheck({
      backgroundTasks,
      sessionId: SESSION,
      stopHookActive: false,
      transcriptPath: paths.parent,
    });

  const setup = () => {
    const repository = fixture();
    useSession(SESSION);
    const lease = startLoop(repository.root, "controller", "ship");
    const paths = transcripts();
    return { lease, paths, repository };
  };

  test("reads only Simple Changes loop invocations that name an owner", () => {
    expect(
      ownerLoopInvocations(
        `R="sh x/simple-changes-runtime.sh"; $R loop exec --run-id=run-a1 --agent-id 'ctl' -- git push --agent-id other; simple-changes loop guard --agent-id=ctl2 --run-id "run-b2"`
      )
    ).toEqual([
      { action: "exec", agentId: "ctl", runId: "run-a1" },
      { action: "guard", agentId: "ctl2", runId: "run-b2" },
    ]);
    expect(
      ownerLoopInvocations(
        "(simple-changes loop exec --run-id run-a1 --agent-id ctl) && echo ok"
      )
    ).toEqual([{ action: "exec", agentId: "ctl", runId: "run-a1" }]);
    // A shell expansion is not a literal ID.
    expect(
      ownerLoopInvocations(
        "simple-changes loop exec --run-id $R --agent-id ctl -- git push"
      )
    ).toEqual([{ action: "exec", agentId: "ctl", runId: null }]);
    for (const probe of [
      "simple-changes loop exec --run-id run-a1 --agent-id $A",
      'simple-changes loop exec --run-id run-a1 --agent-id "$A"',
      "simple-changes loop exec --run-id run-a1 --agent-id ctl$A",
      "simple-changes loop status --agent-id ctl --run-id run-a1",
      "simple-changes loop replan-status --agent-id ctl",
      "simple-changes loop turn-check --agent-id ctl",
      "simple-changes loop verify --run-id run-a1 --agent-id ctl",
      "rg -n ctl notes.md",
      "cat /var/ctl/state.json",
      "echo loop start --agent-id ctl",
      "simple-changes loop status --json",
      "simple-changes loop status --json; echo --agent-id ctl",
    ]) {
      expect(ownerLoopInvocations(probe)).toEqual([]);
    }
  });

  test("a live run a running subagent drives only advises the user", () => {
    const { lease, paths } = setup();
    driveFromSubagent(paths, SUBAGENT, lease);
    // The parent only looked at status, and another agent's sidechain entries
    // in its transcript are not its own commands.
    writeFileSync(
      paths.parent,
      bashCall(
        "simple-changes loop status --json",
        `{"runId":"${lease.runId}","ownerAgentId":"controller"}`,
        { at: secondsAgo(2) }
      ) +
        bashCall(exec(lease.runId), "ok", {
          at: secondsAgo(1),
          sidechain: true,
        })
    );

    const advised = check(paths);
    expect(advised.decision).toBe("advise");
    expect(advised.runs[0]?.drivenBy).toMatchObject({ agentId: SUBAGENT });
    expect(advised.reason).toBe(
      `Simple Changes: run ${lease.runId} in ${lease.primaryCheckout} is being driven by background agent ${SUBAGENT} (Ship the fork update); that agent finalizes it when it finishes, and this session is asked to if it does not.`
    );
    expect(JSON.parse(turnCheckHookOutput(advised))).toEqual({
      systemMessage: advised.reason,
    });
    // The pointer stays: once the subagent is gone, the guard blocks again.
    expect(listControllerSessionEntries(SESSION)).toHaveLength(1);

    // A subagent command still waiting for its output covers a lease write.
    writeFileSync(
      loopLeasePath(lease.commonGitDirectory),
      `${JSON.stringify({ ...lease, updatedAt: new Date().toISOString() })}\n`
    );
    const [inFlight] = bashCall(exec(lease.runId), "", {
      agentId: SUBAGENT,
      at: secondsAgo(600),
    }).split("\n");
    writeFileSync(paths.subagent(SUBAGENT), `${inFlight}\n`);
    expect(check(paths).decision).toBe("advise");
  });

  test("the parent's own run still blocks", () => {
    const { lease, paths } = setup();
    driveFromSubagent(paths, SUBAGENT, lease);

    // An unrelated running subagent never excuses the parent's run.
    expect(check(paths, [running(OTHER_SUBAGENT)]).decision).toBe("block");

    // Loose mentions of the owner are not owner commands.
    writeFileSync(
      paths.subagent(OTHER_SUBAGENT),
      [
        "rg -n controller notes.md",
        "cat /var/controller/state.json",
        "simple-changes loop status --json",
        "simple-changes loop status --agent-id controller --json",
      ]
        .map((command) =>
          bashCall(command, `{"runId":"${lease.runId}"}`, {
            agentId: OTHER_SUBAGENT,
            at: secondsAgo(1),
          })
        )
        .join("")
    );
    expect(check(paths, [running(OTHER_SUBAGENT)]).decision).toBe("block");

    // A transcript claiming to be another agent's is not this subagent's.
    writeFileSync(
      paths.subagent(OTHER_SUBAGENT),
      bashCall(exec(lease.runId), "ok", {
        agentId: SUBAGENT,
        at: secondsAgo(1),
      })
    );
    expect(check(paths, [running(OTHER_SUBAGENT)]).decision).toBe("block");

    // The parent's `loop start`, named only by its output, after the subagent.
    writeFileSync(
      paths.parent,
      bashCall(
        START.replace("sh scripts/simple-changes-runtime.sh", "simple-changes"),
        `{"runId":"${lease.runId}"}`,
        {
          at: secondsAgo(1),
        }
      )
    );
    const parentOwned = check(paths);
    expect(parentOwned.decision).toBe("block");
    expect(parentOwned.runs[0]?.drivenBy).toBeNull();
    expect(parentOwned.reason).toContain("loop finalize");

    // A parent owner command without a time counts as the newest.
    writeFileSync(
      paths.parent,
      bashCall(exec(lease.runId), "ok", { at: null })
    );
    expect(check(paths).decision).toBe("block");

    // An unreadable parent transcript proves nothing.
    writeFileSync(paths.parent, "");
    expect(check(paths).decision).toBe("advise");
    expect(
      turnCheck({
        backgroundTasks: [running(SUBAGENT)],
        sessionId: SESSION,
        stopHookActive: false,
        transcriptPath: `${paths.parent}.missing.jsonl`,
      }).decision
    ).toBe("block");
  });

  test("failed or prose-only subagent output proves nothing", () => {
    const { lease, paths } = setup();
    const start = (output: string, isError: boolean, cwd?: string): string =>
      bashCall(START, output, {
        agentId: SUBAGENT,
        at: secondsAgo(2),
        ...(cwd ? { cwd } : {}),
        isError,
      });
    for (const evidence of [
      // A refused start names the parent's run in its error.
      start(`${lease.runId} is already active for controller.`, true),
      start(`{"runId":"${lease.runId}"}`, true),
      // A failed owner command is not control.
      bashCall(exec(lease.runId), "rejected", {
        agentId: SUBAGENT,
        at: secondsAgo(2),
        isError: true,
      }),
    ]) {
      writeFileSync(paths.subagent(SUBAGENT), evidence);
      expect(check(paths).decision).toBe("block");
    }
    // A successful start whose output names the run only in prose counts
    // through its owner ID, since no parent command ever used that ID, but
    // only once it is known to have run in this run's repository.
    const prose = `Integration-controller loop ${lease.runId} is active.`;
    writeFileSync(paths.subagent(SUBAGENT), start(prose, false));
    expect(check(paths).decision).toBe("block");
    writeFileSync(
      paths.subagent(SUBAGENT),
      start(prose, false, lease.primaryCheckout)
    );
    expect(check(paths).decision).toBe("advise");

    // The parent's failed attempt still counts as the parent commanding it.
    driveFromSubagent(paths, SUBAGENT, lease, 10);
    expect(check(paths).decision).toBe("advise");
    writeFileSync(
      paths.parent,
      bashCall(exec(lease.runId), "rejected", {
        at: secondsAgo(1),
        isError: true,
      })
    );
    expect(check(paths).decision).toBe("block");
  });

  test("the owner ID identifies a subagent driving a run it never names", () => {
    const { lease, paths } = setup();
    // The patrick pattern: `loop start` output went to a file and later
    // commands pass the run ID through a shell variable.
    const ownerIdOnly = (
      agentId: string,
      owner = "controller",
      directory = lease.primaryCheckout
    ): string =>
      bashCall(
        `S=/tmp/s; cd ${directory} && sh skills/x/scripts/simple-changes-runtime.sh loop start --mode ship --agent-id ${owner} --json > $S/start.json`,
        "",
        { agentId, at: secondsAgo(10) }
      ) +
      bashCall(
        `S=/tmp/s; R=$(cat $S/run-id); cd ${directory} && sh skills/x/scripts/simple-changes-runtime.sh loop exec --run-id $R --agent-id ${owner} -- git push`,
        "ok",
        { agentId, at: secondsAgo(5) }
      );
    writeFileSync(paths.subagent(SUBAGENT), ownerIdOnly(SUBAGENT));
    const advised = check(paths);
    expect(advised.decision).toBe("advise");
    expect(advised.runs[0]?.drivenBy).toMatchObject({ agentId: SUBAGENT });

    // A variable owner ID is no evidence.
    writeFileSync(paths.subagent(SUBAGENT), ownerIdOnly(SUBAGENT, "$A"));
    expect(check(paths).decision).toBe("block");
    writeFileSync(paths.subagent(SUBAGENT), ownerIdOnly(SUBAGENT));

    // Another running subagent using the same ID makes the driver ambiguous.
    writeFileSync(
      paths.subagent(OTHER_SUBAGENT),
      bashCall("simple-changes loop status --agent-id controller", "{}", {
        agentId: OTHER_SUBAGENT,
        at: secondsAgo(30),
      })
    );
    expect(
      check(paths, [running(SUBAGENT), running(OTHER_SUBAGENT)]).decision
    ).toBe("block");
    expect(check(paths, [running(SUBAGENT)]).decision).toBe("advise");

    // A lease written well after the subagent's last command blocks.
    writeFileSync(
      loopLeasePath(lease.commonGitDirectory),
      `${JSON.stringify({ ...lease, updatedAt: new Date(Date.now() + 120_000).toISOString() })}\n`
    );
    expect(check(paths).decision).toBe("block");
    writeFileSync(
      loopLeasePath(lease.commonGitDirectory),
      `${JSON.stringify(lease)}\n`
    );
    expect(check(paths).decision).toBe("advise");

    // The commands must have run in this run's repository: another
    // repository, or a directory the transcript cannot pin down, blocks.
    const elsewhere = fixture();
    for (const evidence of [
      ownerIdOnly(SUBAGENT, "controller", elsewhere.root),
      ownerIdOnly(SUBAGENT, "controller", "$W"),
      ownerIdOnly(SUBAGENT, "controller", "relative/path"),
    ]) {
      writeFileSync(paths.subagent(SUBAGENT), evidence);
      expect(check(paths).decision).toBe("block");
    }
    // Without a `cd`, the shell directory the transcript recorded counts.
    const bare = (cwd: string): string =>
      bashCall(
        "R=$(cat /tmp/s/run-id); simple-changes loop exec --run-id $R --agent-id controller -- git push",
        "ok",
        { agentId: SUBAGENT, at: secondsAgo(5), cwd }
      );
    writeFileSync(paths.subagent(SUBAGENT), bare(elsewhere.root));
    expect(check(paths).decision).toBe("block");
    writeFileSync(paths.subagent(SUBAGENT), bare(lease.primaryCheckout));
    expect(check(paths).decision).toBe("advise");

    // A command still waiting for its output never excuses a fresh lease
    // write here: it names no run, so it may be serving another one.
    const [pending] = bashCall(
      `R=$(cat /tmp/s/run-id); cd ${lease.primaryCheckout} && simple-changes loop exec --run-id $R --agent-id controller -- sleep 999`,
      "",
      { agentId: SUBAGENT, at: secondsAgo(600) }
    ).split("\n");
    writeFileSync(paths.subagent(SUBAGENT), `${pending}\n`);
    writeFileSync(
      loopLeasePath(lease.commonGitDirectory),
      `${JSON.stringify({ ...lease, updatedAt: new Date().toISOString() })}\n`
    );
    expect(check(paths).decision).toBe("block");
    writeFileSync(
      loopLeasePath(lease.commonGitDirectory),
      `${JSON.stringify(lease)}\n`
    );
    writeFileSync(paths.subagent(SUBAGENT), ownerIdOnly(SUBAGENT));

    // The parent drives this run through a variable owner ID while the
    // subagent uses the ID literally for its own run in another repository.
    writeFileSync(
      paths.subagent(SUBAGENT),
      ownerIdOnly(SUBAGENT, "controller", elsewhere.root)
    );
    writeFileSync(
      paths.parent,
      bashCall(
        `A=controller; cd ${lease.primaryCheckout} && simple-changes loop exec --run-id ${lease.runId} --agent-id "$A" -- git push`,
        "ok",
        { at: secondsAgo(1) }
      )
    );
    expect(check(paths).decision).toBe("block");
    writeFileSync(paths.parent, "");
    writeFileSync(paths.subagent(SUBAGENT), ownerIdOnly(SUBAGENT));
    expect(check(paths).decision).toBe("advise");

    // The parent using that ID at all, even in a failed or read-only command,
    // means the ID is shared, so it proves nothing.
    for (const command of [
      "simple-changes loop status --agent-id controller --json",
      "simple-changes loop guard --run-id $R --agent-id controller",
    ]) {
      writeFileSync(
        paths.parent,
        bashCall(command, "refused", { at: secondsAgo(600), isError: true })
      );
      expect(check(paths).decision).toBe("block");
    }
  });

  test("resolves a variable the same command assigns once to a literal", () => {
    const invocation = (command: string) => ownerLoopInvocations(command)[0];
    expect(
      invocation(
        "R=run-abc-1; simple-changes loop exec --run-id $R --agent-id x -- git push"
      )
    ).toEqual({ action: "exec", agentId: "x", runId: "run-abc-1" });
    expect(
      invocation(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell ${R} expansion.
        'R=\'run-abc-2\'; A="x"; simple-changes loop guard --run-id "${R}" --agent-id $A'
      )
    ).toEqual({ action: "guard", agentId: "x", runId: "run-abc-2" });
    for (const command of [
      // Reassigned, substituted, assigned after use, or never assigned here.
      "R=run-a; R=run-b; simple-changes loop exec --run-id $R --agent-id x",
      "R=$(cat /tmp/run-id); simple-changes loop exec --run-id $R --agent-id x",
      "simple-changes loop exec --run-id $R --agent-id x; R=run-late",
      "simple-changes loop exec --run-id $R --agent-id x",
      "R=$OTHER; simple-changes loop exec --run-id $R --agent-id x",
      // Shell forms where the assignment does not bind the use, or binds it
      // more than once.
      "R=run-a simple-changes loop exec --run-id $R --agent-id x",
      "(R=run-a); simple-changes loop exec --run-id $R --agent-id x",
      "R=run-a | cat; simple-changes loop exec --run-id $R --agent-id x",
      "R=run-a; R+=x; simple-changes loop exec --run-id $R --agent-id x",
      "for R in run-a; do simple-changes loop exec --run-id $R --agent-id x; done",
      "R=run-a; read R; simple-changes loop exec --run-id $R --agent-id x",
      "R=run-a; unset R; simple-changes loop exec --run-id $R --agent-id x",
      "R=run-a; simple-changes loop exec --run-id '$R' --agent-id x",
      'echo "R=run-a"; simple-changes loop exec --run-id $R --agent-id x',
      "(R=run-a; true); simple-changes loop exec --run-id $R --agent-id x",
      "echo $(R=run-a; echo x); simple-changes loop exec --run-id $R --agent-id x",
      "R=run-a S=y simple-changes loop exec --run-id $R --agent-id x",
      "false && R=run-a; simple-changes loop exec --run-id $R --agent-id x",
      "if false; then R=run-a; fi; simple-changes loop exec --run-id $R --agent-id x",
      "# R=run-a\nsimple-changes loop exec --run-id $R --agent-id x",
      "cat <<EOF\nR=run-a\nEOF\nsimple-changes loop exec --run-id $R --agent-id x",
      "R=run-a; read -r X R; simple-changes loop exec --run-id $R --agent-id x",
      "R=run-a; printf -v R %s other; simple-changes loop exec --run-id $R --agent-id x",
      "eval R=run-a; simple-changes loop exec --run-id $R --agent-id x",
      "if false; then\n  R=run-a\nfi; simple-changes loop exec --run-id $R --agent-id x",
      "while false; do\nR=run-a\ndone; simple-changes loop exec --run-id $R --agent-id x",
      "case b in a) :; R=run-a;; esac; simple-changes loop exec --run-id $R --agent-id x",
      "false && { :; R=run-a; }; simple-changes loop exec --run-id $R --agent-id x",
      "false && export R=run-a; simple-changes loop exec --run-id $R --agent-id x",
      "true | export R=run-a; simple-changes loop exec --run-id $R --agent-id x",
    ]) {
      expect(invocation(command)?.runId ?? null).toBeNull();
    }
    // A value with a space or shell operator is never spliced in, so it can
    // neither cut a command short nor invent a directory.
    expect(
      invocation(
        'WHY="approved; ok"; simple-changes loop allow --reason "$WHY" --run-id run-x --agent-id ctl'
      )
    ).toEqual({ action: "allow", agentId: "ctl", runId: "run-x" });
    for (const reason of ["ok -- approved", "a | b", "line\nbreak"]) {
      expect(
        invocation(
          `WHY="${reason}"; simple-changes loop allow --reason "$WHY" --run-id run-x --agent-id ctl`
        )
      ).toEqual({ action: "allow", agentId: "ctl", runId: "run-x" });
    }
    // A value starting with `-` could read as a flag, so it is never
    // spliced in and the literal flags still parse.
    expect(
      invocation(
        "S=--; simple-changes loop exec $S --run-id run-x --agent-id ctl"
      )
    ).toEqual({ action: "exec", agentId: "ctl", runId: "run-x" });
    expect(
      invocation(
        "F=--agent-id; simple-changes loop exec --run-id run-x $F ctl2 --agent-id ctl"
      )?.agentId
    ).toBe("ctl");
    // A use in a heredoc body is not expanded by a quoted delimiter.
    expect(
      ownerLoopInvocations(
        "R=run-h; cat > /tmp/x.sh <<'EOF'\nsimple-changes loop exec --run-id $R --agent-id x\nEOF"
      )[0]?.runId ?? null
    ).toBeNull();
    // A quoted value that contains the name still resolves.
    expect(
      invocation(
        'W="/a/W"; R=run-q; cd $W && simple-changes loop exec --run-id $R --agent-id x'
      )?.runId
    ).toBe("run-q");
    // An earlier assignment of another name does not block resolution.
    expect(
      invocation(
        "export W=/repo; R=run-c; cd $W && simple-changes loop exec --run-id $R --agent-id x"
      )?.runId
    ).toBe("run-c");
  });

  test("credits the hash pattern and names why an owner-ID user is not credited", () => {
    const { lease, paths } = setup();
    const elsewhere = fixture();
    // The hash 0.22.4 pattern: the run ID and directory are shell variables
    // assigned literally in the same command, from a shell that started in
    // another repository.
    const hashStyle = (assignRun: string, directory = lease.primaryCheckout) =>
      bashCall(
        `S=/tmp/s; W=${directory}; ${assignRun}; cd $W && sh skills/x/scripts/simple-changes-runtime.sh loop exec --run-id $R --agent-id controller -- git push`,
        "ok",
        { agentId: SUBAGENT, at: secondsAgo(5), cwd: elsewhere.root }
      );
    writeFileSync(
      paths.subagent(SUBAGENT),
      hashStyle(`R=${lease.runId}`, elsewhere.root)
    );
    expect(check(paths).runs[0]?.drivenBy).toMatchObject({
      agentId: SUBAGENT,
    });
    // An unresolvable run ID still counts when the literal cd puts the owner
    // command in this repository.
    writeFileSync(paths.subagent(SUBAGENT), hashStyle("R=$(cat $S/run-id)"));
    expect(check(paths).decision).toBe("advise");

    // Neither the run nor the repository: blocked, and the hook says why.
    writeFileSync(
      paths.subagent(SUBAGENT),
      hashStyle("R=$(cat $S/run-id)", elsewhere.root)
    );
    const blocked = check(paths);
    expect(blocked.decision).toBe("block");
    expect(blocked.runs[0]?.uncredited?.reason).toContain(
      `background agent ${SUBAGENT} used controller, but none of its successful owner commands named ${lease.runId}`
    );
    expect(blocked.reason).toContain(
      `${lease.runId} is not credited to a background agent`
    );
    expect(blocked.reason).toContain(
      `it must pass --run-id ${lease.runId} literally`
    );
    expect(blocked.reason).toContain(
      "If that agent is still driving it, wait for it instead of finalizing."
    );

    // A quoted directory with a space stays unknown instead of becoming a
    // shorter path that happens to sit inside the repository.
    writeFileSync(
      paths.subagent(SUBAGENT),
      bashCall(
        `W="${lease.primaryCheckout} copy"; R=$(cat /tmp/s/run-id); cd "$W" && simple-changes loop exec --run-id $R --agent-id controller -- git push`,
        "ok",
        { agentId: SUBAGENT, at: secondsAgo(5), cwd: elsewhere.root }
      )
    );
    expect(check(paths).decision).toBe("block");

    // A parent-owned run with no subagent using its ID gets no such note.
    writeFileSync(paths.subagent(SUBAGENT), "");
    const parentOwned = check(paths);
    expect(parentOwned.decision).toBe("block");
    expect(parentOwned.runs[0]?.uncredited).toBeNull();
    expect(parentOwned.reason).not.toContain("is not credited");
  });

  test("names the exact reason an owner-ID user is not credited", () => {
    const { lease, paths } = setup();
    const reasonFor = (tasks = [running(SUBAGENT)]): string | undefined =>
      check(paths, tasks).runs[0]?.uncredited?.reason;

    // It named a different run.
    writeFileSync(
      paths.subagent(SUBAGENT),
      bashCall(
        `cd ${lease.primaryCheckout} && simple-changes loop exec --run-id run-older-1 --agent-id controller -- git push`,
        "ok",
        { agentId: SUBAGENT, at: secondsAgo(5) }
      )
    );
    expect(check(paths).runs[0]?.uncredited).toEqual({
      mayStillDrive: false,
      reason: `background agent ${SUBAGENT}'s owner commands under controller named run-older-1, not ${lease.runId}`,
    });

    // Its command naming this run failed.
    writeFileSync(
      paths.subagent(SUBAGENT),
      bashCall(exec(lease.runId), "refused", {
        agentId: SUBAGENT,
        at: secondsAgo(5),
        isError: true,
      })
    );
    expect(reasonFor()).toContain(
      `owner commands naming ${lease.runId} failed`
    );

    // Two running agents share the ID.
    driveFromSubagent(paths, SUBAGENT, lease);
    writeFileSync(
      paths.subagent(OTHER_SUBAGENT),
      bashCall("simple-changes loop exec --agent-id controller -- true", "ok", {
        agentId: OTHER_SUBAGENT,
        at: secondsAgo(5),
      })
    );
    writeFileSync(
      paths.subagent(SUBAGENT),
      bashCall(
        "R=$(cat /tmp/r); simple-changes loop exec --run-id $R --agent-id controller -- true",
        "ok",
        { agentId: SUBAGENT, at: secondsAgo(5) }
      )
    );
    expect(reasonFor([running(SUBAGENT), running(OTHER_SUBAGENT)])).toContain(
      "all used controller, so the owner ID cannot identify the driver"
    );

    // The parent used the same ID, so only a literal run ID would identify
    // the driver.
    writeFileSync(
      paths.parent,
      bashCall("simple-changes loop status --agent-id controller", "{}", {
        at: secondsAgo(60),
      })
    );
    expect(reasonFor()).toContain("this session also used that ID");

    // Control visibly moved back to this session: no advice to wait.
    driveFromSubagent(paths, SUBAGENT, lease, 30);
    writeFileSync(
      paths.parent,
      bashCall(exec(lease.runId), "ok", { at: secondsAgo(1) })
    );
    const returned = check(paths);
    expect(returned.decision).toBe("block");
    expect(returned.runs[0]?.uncredited).toEqual({
      mayStillDrive: false,
      reason: `this session issued an owner command for ${lease.runId} after background agent ${SUBAGENT} last did`,
    });
    expect(returned.reason).not.toContain("wait for it");

    // A lease written well after the agent's last command: no advice to wait.
    writeFileSync(paths.parent, "");
    driveFromSubagent(paths, SUBAGENT, lease, 300);
    const stale = check(paths);
    expect(stale.runs[0]?.uncredited?.mayStillDrive).toBe(false);
    expect(stale.runs[0]?.uncredited?.reason).toContain(
      `more than 60 s after background agent ${SUBAGENT}'s last owner command`
    );
    expect(stale.reason).not.toContain("wait for it");
  });

  test("subagent commands without a time prove nothing", () => {
    const { lease, paths } = setup();
    writeFileSync(
      paths.subagent(SUBAGENT),
      bashCall(exec(lease.runId), "ok", { agentId: SUBAGENT, at: null })
    );
    expect(check(paths).decision).toBe("block");
  });

  test("a lease written well after the subagent's last command blocks", () => {
    const { lease, paths } = setup();
    // The parent drove the run some other way, as through a wrapper script.
    driveFromSubagent(paths, SUBAGENT, lease, 300);
    expect(check(paths).decision).toBe("block");
    writeFileSync(
      loopLeasePath(lease.commonGitDirectory),
      `${JSON.stringify({ ...lease, updatedAt: secondsAgo(290).toISOString() })}\n`
    );
    expect(check(paths).decision).toBe("advise");
  });

  test("a mix of parent-owned and subagent-driven runs blocks and names both", () => {
    const first = setup();
    const second = startLoop(fixture().root, "controller", "ship");
    driveFromSubagent(first.paths, SUBAGENT, first.lease);

    const mixed = check(first.paths);
    expect(mixed.decision).toBe("block");
    expect(mixed.reason).toContain(
      `this session still controls ${second.runId}`
    );
    expect(mixed.reason).toContain(`loop finalize --run-id ${second.runId}`);
    expect(mixed.reason).toContain(`Leave ${first.lease.runId}`);
    expect(mixed.reason).not.toContain(
      `loop finalize --run-id ${first.lease.runId}`
    );
  });

  test("a finished or stale subagent run still blocks", () => {
    const { lease, paths } = setup();
    driveFromSubagent(paths, SUBAGENT, lease);

    for (const backgroundTasks of [
      [],
      [running(SUBAGENT, "completed")],
      [{ ...running(SUBAGENT), type: "workflow" }],
    ]) {
      expect(check(paths, backgroundTasks).decision).toBe("block");
    }

    // Listed as running, but the run went quiet past the stale threshold and
    // its recorded command process is gone: the subagent no longer drives it.
    const stored = JSON.parse(
      readFileSync(loopLeasePath(lease.commonGitDirectory), "utf8")
    ) as LoopLease;
    writeFileSync(
      loopLeasePath(lease.commonGitDirectory),
      `${JSON.stringify({
        ...stored,
        ownerProcess: { ...stored.ownerProcess, pid: deadPid() },
        updatedAt: new Date(
          Date.now() - LEASE_STALE_AFTER_MS - 60_000
        ).toISOString(),
      })}\n`
    );
    const stale = check(paths);
    expect(stale.decision).toBe("block");
    expect(stale.reason).toContain("loop finalize");
  });

  test("an oversized or slow transcript scan blocks instead of timing out", () => {
    const { lease, paths } = setup();
    driveFromSubagent(paths, SUBAGENT, lease);
    const run = {
      leaseUpdatedAt: new Date().toISOString(),
      ownerAgentId: "controller",
      repositoryRoots: [lease.primaryCheckout],
      runId: lease.runId,
    };
    const tasks = [running(SUBAGENT)];
    expect(
      subagentControlIndex(paths.parent, tasks).controllerOf(run)
    ).toMatchObject({ agentId: SUBAGENT });
    writeFileSync(paths.parent, "x".repeat(2048));
    expect(
      subagentControlIndex(paths.parent, tasks, {
        budgetMs: 60_000,
        maxBytes: 1024,
      }).controllerOf(run)
    ).toBeNull();
    expect(
      subagentControlIndex(paths.parent, tasks, {
        budgetMs: -1,
        maxBytes: 1024 * 1024,
      }).controllerOf(run)
    ).toBeNull();
  });

  test("scans a 20 MB transcript well inside the hook timeout", () => {
    const { lease, paths } = setup();
    driveFromSubagent(paths, SUBAGENT, lease);
    // Mostly ordinary output, with loop and owner-flag text in tool results
    // that are not the parent's commands.
    const filler = bashCall(
      "rg -n loop skills/simple-changes/SKILL.md",
      `loop exec --run-id ${lease.runId} --agent-id controller ${"x".repeat(4000)}`,
      { at: secondsAgo(30) }
    );
    const plain = `${JSON.stringify({ message: { content: "y".repeat(4000) }, type: "user" })}\n`;
    const chunk = filler + plain.repeat(9);
    writeFileSync(
      paths.parent,
      chunk.repeat(Math.ceil((20 * 1024 * 1024) / chunk.length))
    );
    const started = performance.now();
    const control = subagentControlIndex(paths.parent, [running(SUBAGENT)], {
      budgetMs: 60_000,
      maxBytes: 64 * 1024 * 1024,
    }).controllerOf({
      leaseUpdatedAt: new Date().toISOString(),
      ownerAgentId: "controller",
      repositoryRoots: [lease.primaryCheckout],
      runId: lease.runId,
    });
    const elapsed = performance.now() - started;
    expect(control).toMatchObject({ agentId: SUBAGENT });
    expect(elapsed).toBeLessThan(3000);
  });

  test("the CLI hook advises over stdin for a subagent run and is silent without a pointer", () => {
    const { lease, paths } = setup();
    driveFromSubagent(paths, SUBAGENT, lease);
    const { CLAUDE_CODE_SESSION_ID: _session, ...environment } = process.env;
    const run = (input: object) =>
      spawnSync(process.execPath, [SCRIPT, "loop", "turn-check", "--hook"], {
        cwd: tmpdir(),
        encoding: "utf8",
        env: environment,
        input: JSON.stringify(input),
      });

    const advised = run({
      background_tasks: [running(SUBAGENT)],
      hook_event_name: "Stop",
      session_id: SESSION,
      stop_hook_active: false,
      transcript_path: paths.parent,
    });
    expect(advised.status).toBe(0);
    const message = JSON.parse(advised.stdout);
    expect(message.decision).toBeUndefined();
    expect(message.systemMessage).toContain(lease.runId);

    const none = run({
      background_tasks: [running(SUBAGENT)],
      session_id: OTHER_SESSION,
      transcript_path: paths.parent,
    });
    expect(none.status).toBe(0);
    expect(none.stdout).toBe("");
  });
});

describe("turn-end reminders", () => {
  test("guarded commands repeat the finalize step with this run's identity", () => {
    const repository = fixture();
    const lease = startLoop(repository.root, "controller", "integrate");
    guardLoopMutation(repository.root, lease.runId, "controller");

    const reminder = turnEndReminder(lease);
    expect(reminder).toContain(
      `loop finalize --run-id ${lease.runId} --agent-id controller`
    );
    expect(reminder).toContain("--awaiting-user");
    expect(reminder).toContain("loop status --json");

    const output = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "loop",
        "guard",
        "--run-id",
        lease.runId,
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        repository.root,
      ],
      { encoding: "utf8", env: process.env }
    );
    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout).turnEnd).toBe(reminder);
  });
});

describe("lease liveness", () => {
  const exitedSessionLease = async (
    repository: TestRepository
  ): Promise<LoopLease> => {
    const session = spawn("sleep", ["30"]);
    if (!session.pid) {
      throw new Error("could not start a stand-in session process");
    }
    useSession(SESSION, session.pid);
    const lease = startLoop(repository.root, "controller", "integrate");
    // This test process plays an observer that can see host processes.
    useSession(SESSION);
    const exited = new Promise((done) => session.once("exit", done));
    session.kill();
    await exited;
    return lease;
  };

  const aged = (lease: LoopLease, ageMs: number): LoopLease => ({
    ...lease,
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
  });

  test("a sandbox-invisible session process is never recorded", () => {
    const repository = fixture();
    useSession(SESSION, deadPid());
    const lease = startLoop(repository.root, "controller", "integrate");

    expect(readControllerBinding(lease)?.session?.hostPid).toBeNull();
    expect(
      leaseLiveness(aged(lease, SESSION_EXIT_GRACE_MS + 60_000)).state
    ).toBe("live");
  });

  test("an exited session makes a quiet run stale after the grace period", async () => {
    const repository = fixture();
    const lease = await exitedSessionLease(repository);

    expect(leaseLiveness(lease)).toMatchObject({
      ownerSessionEnded: false,
      state: "live",
    });
    expect(
      leaseLiveness(aged(lease, SESSION_EXIT_GRACE_MS + 60_000))
    ).toMatchObject({
      ownerProcessProvable: false,
      ownerSessionEnded: true,
      state: "stale",
    });
  });

  test("a running session process alone does not keep an idle run live", () => {
    const repository = fixture();
    useSession(SESSION, process.pid);
    const lease = startLoop(repository.root, "controller", "integrate");

    expect(leaseLiveness(lease)).toMatchObject({
      ownerSessionEnded: false,
      state: "live",
    });
    expect(
      leaseLiveness(aged(lease, LEASE_STALE_AFTER_MS + 60_000)).state
    ).toBe("stale");
  });

  test("stale-lease recovery archives the complete lease beside an unchanged receipt", async () => {
    const repository = fixture();
    const lease = await exitedSessionLease(repository);
    const quiet = aged(lease, SESSION_EXIT_GRACE_MS + 60_000);
    writeFileSync(
      loopLeasePath(lease.commonGitDirectory),
      `${JSON.stringify(quiet, null, 2)}\n`
    );

    const receipt = recoverStaleLoopLease(
      repository.root,
      lease.runId,
      "recoverer",
      "user",
      "The owning session exited."
    );

    expect(Object.keys(receipt)).not.toContain("lease");
    const archive = JSON.parse(
      readFileSync(
        staleLeaseArchivePath(lease.commonGitDirectory, lease.runId),
        "utf8"
      )
    );
    expect(archive.lease).toEqual(quiet);
    expect(archive.ownerSessionEnded).toBe(true);
    expect(archive.controllerBinding.session.sessionId).toBe(SESSION);
    expect(readLoopLease(repository.root)).toBeNull();
    expect(listControllerSessionEntries(SESSION)).toHaveLength(0);
  });
});

describe("stop hook installer", () => {
  const RUNNING = "0.21.1";
  let installed = "";

  const runtimeSource = (version: string, withTurnCheck = true): string =>
    `const VERSION = "${version}";\n${withTurnCheck ? 'const ACTION = "turn-check";\n' : ""}`;

  const hookScript = (version: string, withTurnCheck = true): string => {
    const directory = mkdtempSync(join(tmpdir(), "installed-skill-"));
    const path = join(directory, "simple-changes.ts");
    writeFileSync(path, runtimeSource(version, withTurnCheck));
    return path;
  };

  beforeEach(() => {
    installed = hookScript(RUNNING);
  });

  afterEach(() => {
    rmSync(dirname(installed), { force: true, recursive: true });
  });

  test("reports, installs once, and keeps every other Claude Code setting", () => {
    const claudeDirectory = mkdtempSync(join(tmpdir(), "claude-settings-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDirectory;
    const settingsPath = join(claudeDirectory, "settings.json");
    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "echo bye", type: "command" }] }],
        },
        model: "opus",
      })}\n`,
      { mode: 0o600 }
    );
    try {
      expect(
        stopHookStatus("claude-code", installed, RUNNING, false)
      ).toMatchObject({
        installed: false,
        path: settingsPath,
        written: false,
      });

      const written = stopHookStatus("claude-code", installed, RUNNING, true);
      expect(written).toMatchObject({
        current: true,
        installed: true,
        written: true,
      });
      expect(
        written.command.startsWith(`[ -f '${installed}' ] || exit 0;`)
      ).toBe(true);
      expect(written.command.endsWith("loop turn-check --hook || exit 0")).toBe(
        true
      );
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.model).toBe("opus");
      expect(settings.hooks.Stop).toHaveLength(2);
      expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo bye");
      expect(settings.hooks.Stop[1].hooks[0].command).toBe(written.command);
      expect(statSync(settingsPath).mode % 0o1000).toBe(0o600);

      expect(
        stopHookStatus("claude-code", installed, RUNNING, true).written
      ).toBe(false);
      expect(
        JSON.parse(readFileSync(settingsPath, "utf8")).hooks.Stop
      ).toHaveLength(2);
    } finally {
      rmSync(claudeDirectory, { force: true, recursive: true });
    }
  });

  test("leaves another copy's hook alone while its script is at least as new", () => {
    const claudeDirectory = mkdtempSync(join(tmpdir(), "claude-settings-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDirectory;
    const other = hookScript("0.22.0");
    const older = hookScript("0.20.0");
    try {
      stopHookStatus("claude-code", other, "0.22.0", true);
      expect(
        stopHookStatus("claude-code", installed, RUNNING, false)
      ).toMatchObject({
        current: true,
        installed: true,
      });
      expect(
        stopHookStatus("claude-code", installed, RUNNING, true).written
      ).toBe(false);

      rmSync(dirname(other), { force: true, recursive: true });
      expect(
        stopHookStatus("claude-code", installed, RUNNING, false).current
      ).toBe(false);

      stopHookStatus("claude-code", older, "0.20.0", true);
      expect(
        stopHookStatus("claude-code", installed, RUNNING, false).current
      ).toBe(false);

      // Same version number, but a copy from before the turn check existed.
      const predating = hookScript(RUNNING, false);
      stopHookStatus("claude-code", installed, RUNNING, true);
      const settingsPath = join(claudeDirectory, "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const [handler] = settings.hooks.Stop[0].hooks;
      handler.command = handler.command.replaceAll(installed, predating);
      writeFileSync(settingsPath, JSON.stringify(settings));
      expect(
        stopHookStatus("claude-code", installed, RUNNING, false).current
      ).toBe(false);

      // A hook without the fail-open ending is outdated even for a good copy.
      handler.command = `'bun' '${installed}' loop turn-check --hook`;
      writeFileSync(settingsPath, JSON.stringify(settings));
      expect(
        stopHookStatus("claude-code", installed, RUNNING, false).current
      ).toBe(false);
      rmSync(dirname(predating), { force: true, recursive: true });
    } finally {
      rmSync(dirname(older), { force: true, recursive: true });
      rmSync(claudeDirectory, { force: true, recursive: true });
    }
  });

  test("refuses to point the user-level hook into a linked worktree", () => {
    const repository = fixture();
    const linked = join(repository.base, "linked");
    git(repository.root, ["worktree", "add", "-q", "-b", "linked", linked]);
    const script = join(linked, "simple-changes.ts");
    writeFileSync(script, `const VERSION = "${RUNNING}";\n`);
    const claudeDirectory = mkdtempSync(join(tmpdir(), "claude-settings-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDirectory;
    try {
      expect(() =>
        stopHookStatus("claude-code", script, RUNNING, true)
      ).toThrow("linked Git worktree");
      expect(existsSync(join(claudeDirectory, "settings.json"))).toBe(false);
    } finally {
      rmSync(claudeDirectory, { force: true, recursive: true });
    }
  });

  test("installs from the primary checkout's copy when run from a linked worktree", () => {
    const repository = fixture();
    const relativeScript = "skills/sc/scripts/simple-changes.ts";
    mkdirSync(join(repository.root, "skills/sc/scripts"), { recursive: true });
    writeFileSync(
      join(repository.root, relativeScript),
      runtimeSource(RUNNING)
    );
    git(repository.root, ["add", "-A"]);
    git(repository.root, ["commit", "-q", "-m", "Vendored runtime"]);
    const linked = join(repository.base, "linked");
    git(repository.root, ["worktree", "add", "-q", "-b", "linked", linked]);

    expect(hookInstallScript(join(linked, relativeScript), RUNNING)).toBe(
      join(repository.root, relativeScript)
    );
    expect(
      hookInstallScript(join(linked, relativeScript), "0.99.0")
    ).toBeNull();
    writeFileSync(
      join(repository.root, relativeScript),
      runtimeSource(RUNNING, false)
    );
    expect(hookInstallScript(join(linked, relativeScript), RUNNING)).toBeNull();
    expect(hookInstallScript(installed, RUNNING)).toBe(installed);

    const submodule = mkdtempSync(join(tmpdir(), "submodule-"));
    try {
      writeFileSync(join(submodule, ".git"), "gitdir: ../.git/modules/sc\n");
      const script = join(submodule, "simple-changes.ts");
      writeFileSync(script, runtimeSource(RUNNING));
      expect(hookInstallScript(script, RUNNING)).toBe(script);
    } finally {
      rmSync(submodule, { force: true, recursive: true });
    }
  });

  describe("from a repository fork", () => {
    const CANONICAL_SKILL =
      "---\nname: simple-changes\ndescription: Fixture\n---\n\n# Simple Changes\n";
    const FORK_SKILL =
      "---\nname: acme-simple-changes\ndescription: Fixture fork\n---\n\n# acme-simple-changes\n\nForked from `simple-changes` @ `0123456789abcdef0123456789abcdef01234567`. Fork-specific deltas: fixture.\n";
    let base = "";

    beforeEach(() => {
      base = realpathSync(mkdtempSync(join(tmpdir(), "fork-hook-")));
    });

    afterEach(() => {
      rmSync(base, { force: true, recursive: true });
    });

    // A skill directory whose runtime supports the turn check.
    const skillCopy = (
      root: string,
      skill: string,
      version = RUNNING,
      runtimeDirectory = false
    ): string => {
      const scripts = join(
        root,
        runtimeDirectory ? "runtime/scripts" : "scripts"
      );
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(root, "SKILL.md"), skill);
      const script = join(scripts, "simple-changes.ts");
      writeFileSync(script, runtimeSource(version));
      return script;
    };

    test("installs the global runtime's hook instead of the fork's", () => {
      const fork = skillCopy(
        join(base, "repo/.agents/skills/acme-simple-changes"),
        FORK_SKILL
      );
      const runtimeLayoutFork = skillCopy(
        join(base, "repo/skills/acme"),
        FORK_SKILL,
        RUNNING,
        true
      );
      const globalRoot = join(base, "home/.agents/skills");
      const global = skillCopy(
        join(globalRoot, "simple-changes"),
        CANONICAL_SKILL,
        "0.22.0"
      );
      // ~/.claude/skills links to the same installation as ~/.agents/skills.
      const linkedRoot = join(base, "home/.claude/skills");
      mkdirSync(linkedRoot, { recursive: true });
      symlinkSync(
        join(globalRoot, "simple-changes"),
        join(linkedRoot, "simple-changes")
      );
      const roots = (...paths: string[]) => ({
        environment: { SIMPLE_CHANGES_SKILL_ROOTS: paths.join(":") },
      });

      expect(hookInstallScript(fork, RUNNING, roots(globalRoot))).toBe(global);
      expect(
        hookInstallScript(runtimeLayoutFork, RUNNING, roots(globalRoot))
      ).toBe(global);
      expect(hookInstallScript(fork, RUNNING, roots(linkedRoot))).toBe(global);
      // No global install, or none at least as new as the fork: none here.
      expect(hookInstallScript(fork, RUNNING, roots())).toBeNull();
      expect(hookInstallScript(fork, "0.99.0", roots(globalRoot))).toBeNull();
      // A global copy that is itself a fork never takes the hook.
      writeFileSync(join(globalRoot, "simple-changes/SKILL.md"), FORK_SKILL);
      expect(hookInstallScript(fork, RUNNING, roots(globalRoot))).toBeNull();
      // Simple Changes itself still installs its own runtime.
      writeFileSync(
        join(globalRoot, "simple-changes/SKILL.md"),
        CANONICAL_SKILL
      );
      expect(hookInstallScript(global, RUNNING, roots())).toBe(global);
    });

    test("never binds the user-level hook to a fork and repoints one that is", () => {
      const fork = skillCopy(
        join(base, "repo/.agents/skills/acme-simple-changes"),
        FORK_SKILL
      );
      const claudeDirectory = join(base, "claude");
      mkdirSync(claudeDirectory);
      process.env.CLAUDE_CONFIG_DIR = claudeDirectory;
      const settingsPath = join(claudeDirectory, "settings.json");

      expect(() => stopHookStatus("claude-code", fork, RUNNING, true)).toThrow(
        "repository fork's runtime"
      );
      expect(existsSync(settingsPath)).toBe(false);

      // A hook an earlier version bound to the fork is outdated for every copy.
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            Stop: [
              { hooks: [{ command: stopHookCommand(fork), type: "command" }] },
            ],
          },
        })
      );
      expect(stopHookStatus("claude-code", fork, RUNNING, false)).toMatchObject(
        { current: false, installed: true }
      );
      expect(
        stopHookStatus("claude-code", installed, RUNNING, false)
      ).toMatchObject({ current: false, installed: true });
      stopHookStatus("claude-code", installed, RUNNING, true);
      const stop = JSON.parse(readFileSync(settingsPath, "utf8")).hooks.Stop;
      expect(stop).toHaveLength(1);
      expect(stop[0].hooks[0].command).toBe(stopHookCommand(installed));
    });

    test("initialization and the CLI offer the global runtime's hook from a fork", () => {
      const repository = fixture();
      const packaged = resolve(
        import.meta.dir,
        "../../../skills/simple-changes"
      );
      const forkRoot = join(
        repository.root,
        ".agents/skills/acme-simple-changes"
      );
      cpSync(packaged, forkRoot, { recursive: true });
      writeFileSync(
        join(forkRoot, "SKILL.md"),
        readFileSync(join(forkRoot, "SKILL.md"), "utf8")
          .replace("name: simple-changes", "name: acme-simple-changes")
          .replace(
            "# Simple Changes\n",
            "# acme-simple-changes\n\nForked from `simple-changes` @ `0123456789abcdef0123456789abcdef01234567`. Fork-specific deltas: fixture.\n"
          )
      );
      const forkScript = join(forkRoot, "scripts/simple-changes.ts");
      const globalRoot = join(base, "home/.agents/skills");
      cpSync(packaged, join(globalRoot, "simple-changes"), { recursive: true });
      const globalScript = join(
        globalRoot,
        "simple-changes/scripts/simple-changes.ts"
      );
      const claudeDirectory = join(base, "claude");
      mkdirSync(claudeDirectory);
      const run = (skillRoots: string, ...args: string[]) =>
        spawnSync(process.execPath, [forkScript, ...args], {
          cwd: repository.root,
          encoding: "utf8",
          env: {
            ...process.env,
            CLAUDE_CODE_SESSION_ID: SESSION,
            CLAUDE_CONFIG_DIR: claudeDirectory,
            SIMPLE_CHANGES_SKILL_ROOTS: skillRoots,
          },
        });

      const offered = run(
        globalRoot,
        "initialize",
        "--mode",
        "preview",
        "--json"
      );
      expect(offered.status).toBe(0);
      const guard = JSON.parse(offered.stdout).turnEndGuard;
      expect(guard).toMatchObject({
        current: false,
        harness: "claude-code",
        installed: false,
      });
      expect(guard.installCommand).toContain(
        `${globalScript} harness stop-hook --harness claude-code --write`
      );
      expect(guard.installCommand).not.toContain(forkRoot);

      const written = run(
        globalRoot,
        "harness",
        "stop-hook",
        "--harness",
        "claude-code",
        "--write",
        "--json"
      );
      expect(written.status).toBe(0);
      const [handler] = JSON.parse(
        readFileSync(join(claudeDirectory, "settings.json"), "utf8")
      ).hooks.Stop[0].hooks;
      expect(handler.command).toContain(`'${globalScript}' loop turn-check`);
      expect(handler.command).not.toContain(forkRoot);
      rmSync(join(claudeDirectory, "settings.json"));

      // Without a global install, the fork reports where the guard belongs.
      const reported = run("", "initialize", "--mode", "preview");
      expect(reported.status).toBe(0);
      expect(reported.stdout).toContain(
        "Turn-end guard: not installed for claude-code; this copy cannot be installed from here, so install it from the globally installed Simple Changes"
      );
      const refused = run(
        "",
        "harness",
        "stop-hook",
        "--harness",
        "claude-code",
        "--write"
      );
      expect(refused.status).toBe(5);
      expect(refused.stderr).toContain("is a repository fork");
      expect(existsSync(join(claudeDirectory, "settings.json"))).toBe(false);
    }, 30_000);
  });

  test("updates an older turn-check command in place for Codex", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    process.env.CODEX_HOME = codexHome;
    const hooksPath = join(codexHome, "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  command: "bun /old/simple-changes.ts loop turn-check --hook",
                  type: "command",
                },
              ],
            },
          ],
        },
      })
    );
    try {
      expect(stopHookStatus("codex", installed, RUNNING, false)).toMatchObject({
        current: false,
        installed: true,
        path: hooksPath,
      });
      stopHookStatus("codex", installed, RUNNING, true);
      const stop = JSON.parse(readFileSync(hooksPath, "utf8")).hooks.Stop;
      expect(stop).toHaveLength(1);
      expect(stop[0].hooks[0].command).toContain(installed);
    } finally {
      rmSync(codexHome, { force: true, recursive: true });
    }
  });

  test("refuses to rewrite settings it cannot parse", () => {
    const claudeDirectory = mkdtempSync(join(tmpdir(), "claude-settings-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDirectory;
    writeFileSync(join(claudeDirectory, "settings.json"), "{ nope");
    try {
      expect(() =>
        stopHookStatus("claude-code", installed, RUNNING, true)
      ).toThrow("is not valid JSON");
      expect(readFileSync(join(claudeDirectory, "settings.json"), "utf8")).toBe(
        "{ nope"
      );
    } finally {
      rmSync(claudeDirectory, { force: true, recursive: true });
    }
  });
});

describe("runtime freshness", () => {
  test("reports a runtime older than the same file on the target branch", () => {
    const repository = fixture();
    const runtimeDirectory = join(
      repository.root,
      "skills/fork/runtime/scripts"
    );
    mkdirSync(runtimeDirectory, { recursive: true });
    const script = join(runtimeDirectory, "simple-changes.ts");
    writeFileSync(script, 'const VERSION = "0.19.0";\n');
    git(repository.root, ["add", "-A"]);
    git(repository.root, ["commit", "-q", "-m", "Newer runtime on main"]);
    git(repository.root, ["checkout", "-q", "-b", "older"]);
    writeFileSync(script, 'const VERSION = "0.18.0";\n');
    git(repository.root, ["commit", "-q", "-am", "Older runtime on a branch"]);

    const context = { targetRef: "main", worktreePaths: [repository.root] };
    const behind = runtimeFreshness(context, "0.18.0", script);
    expect(behind).toMatchObject({
      path: "skills/fork/runtime/scripts/simple-changes.ts",
      status: "behind-target",
      targetVersion: "0.19.0",
    });
    expect(behind.message).toContain("older copy");
    expect(runtimeFreshness(context, "0.19.0", script).status).toBe("current");
    expect(
      runtimeFreshness(context, "0.18.0", join(tmpdir(), "elsewhere.ts")).status
    ).toBe("not-applicable");
    expect(existsSync(script)).toBe(true);
  });
});
