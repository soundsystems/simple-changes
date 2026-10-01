import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  hookInstallScript,
  parseTurnCheckHookInput,
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
    ).toEqual({ sessionId: SESSION, stopHookActive: true });
    expect(parseTurnCheckHookInput("not json")).toEqual({
      sessionId: null,
      stopHookActive: false,
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
