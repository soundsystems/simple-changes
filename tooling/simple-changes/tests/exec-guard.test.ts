import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  executeLoopMutation,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(60_000);
const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const fixtures: TestRepository[] = [];
const restoredEnvironment: Record<string, string | undefined> = {};
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
  for (const [name, value] of Object.entries(restoredEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    delete restoredEnvironment[name];
  }
});

const setEnvironment = (name: string, value: string): void => {
  if (!(name in restoredEnvironment)) {
    restoredEnvironment[name] = process.env[name];
  }
  process.env[name] = value;
};

// The guard records what it saw outside the repository, then exits with the
// code the test chose, so a refusal is observable without repository writes.
const GUARD_SCRIPT = `import { appendFileSync } from "node:fs";
appendFileSync(
  process.env.EXEC_GUARD_TEST_RECORD,
  JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    repository: process.env.SIMPLE_CHANGES_REPOSITORY,
    runId: process.env.SIMPLE_CHANGES_RUN_ID,
  }) + "\\n"
);
if (process.env.EXEC_GUARD_TEST_PRINT) {
  console.log("guard-stdout-line");
  console.error("guard-stderr-line");
}
process.exit(Number(process.env.EXEC_GUARD_TEST_EXIT ?? "0"));
`;

const CHILD = [
  process.execPath,
  "-e",
  "await Bun.write('child-ran.txt', 'yes\\n')",
];

interface GuardRecord {
  argv: string[];
  cwd: string;
  repository: string;
  runId: string;
}

const guardedRepository = (execGuard?: string[]) => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  writeFixture(fixture.root, "scripts/exec-guard.ts", GUARD_SCRIPT);
  writeFixture(
    fixture.root,
    ".simple-changes.json",
    `${JSON.stringify(
      {
        ...DEFAULT_POLICY,
        ...(execGuard ? { execGuard } : {}),
      },
      null,
      2
    )}\n`
  );
  git(fixture.root, ["add", "."]);
  git(fixture.root, ["commit", "-m", "Add policy and guard"]);
  const recordPath = join(fixture.base, "guard-record.jsonl");
  setEnvironment("EXEC_GUARD_TEST_RECORD", recordPath);
  const records = (): GuardRecord[] =>
    existsSync(recordPath)
      ? readFileSync(recordPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as GuardRecord)
      : [];
  const childRan = () => existsSync(join(fixture.root, "child-ran.txt"));
  return { ...fixture, childRan, records };
};

const GUARD = [process.execPath, "scripts/exec-guard.ts"];

describe("repository execGuard", () => {
  test("an allowing guard sees the exact exec argv, run, and checkout", async () => {
    const fixture = guardedRepository(GUARD);
    setEnvironment("EXEC_GUARD_TEST_EXIT", "0");
    const lease = startLoop(fixture.root, "controller", "ship");
    const result = await executeLoopMutation(
      fixture.root,
      lease.runId,
      "controller",
      CHILD
    );
    expect(result.result.exitCode).toBe(0);
    expect(fixture.childRan()).toBe(true);
    expect(fixture.records()).toEqual([
      {
        argv: CHILD,
        cwd: fixture.root,
        repository: fixture.root,
        runId: lease.runId,
      },
    ]);
  });

  test("a refusing guard stops the command before it starts", async () => {
    const fixture = guardedRepository(GUARD);
    setEnvironment("EXEC_GUARD_TEST_EXIT", "3");
    const lease = startLoop(fixture.root, "controller", "ship");
    const refusal = executeLoopMutation(
      fixture.root,
      lease.runId,
      "controller",
      CHILD
    );
    await expect(refusal).rejects.toThrow(
      `Repository execGuard ${JSON.stringify(GUARD)} exited 3`
    );
    await expect(refusal).rejects.toThrow("without starting it");
    expect(fixture.childRan()).toBe(false);
    expect(fixture.records()).toHaveLength(1);
    // The refusal released the lease lock: the next allowed command runs.
    setEnvironment("EXEC_GUARD_TEST_EXIT", "0");
    await executeLoopMutation(fixture.root, lease.runId, "controller", CHILD);
    expect(fixture.childRan()).toBe(true);
  });

  test("a guard that cannot start refuses the command", async () => {
    const fixture = guardedRepository();
    const missing = [join(fixture.base, "missing-guard")];
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify({ ...DEFAULT_POLICY, execGuard: missing }, null, 2)}\n`
    );
    git(fixture.root, ["commit", "-am", "Point the guard at nothing"]);
    const lease = startLoop(fixture.root, "controller", "ship");
    await expect(
      executeLoopMutation(fixture.root, lease.runId, "controller", CHILD)
    ).rejects.toThrow(
      `Repository execGuard ${JSON.stringify(missing)} could not run`
    );
    expect(fixture.childRan()).toBe(false);
  });

  test("without execGuard, loop exec runs no guard", async () => {
    const fixture = guardedRepository();
    setEnvironment("EXEC_GUARD_TEST_EXIT", "3");
    const lease = startLoop(fixture.root, "controller", "ship");
    await executeLoopMutation(fixture.root, lease.runId, "controller", CHILD);
    expect(fixture.childRan()).toBe(true);
    expect(fixture.records()).toEqual([]);
  });

  test("personal preferences never supply a guard", async () => {
    const fixture = createTestRepository();
    fixtures.push(fixture);
    const configuration = join(fixture.base, "configuration");
    mkdirSync(join(configuration, "simple-changes"), { recursive: true });
    writeFileSync(
      join(configuration, "simple-changes", "preferences.json"),
      `${JSON.stringify({
        ...DEFAULT_POLICY,
        execGuard: [join(fixture.base, "missing-guard")],
      })}\n`
    );
    setEnvironment("SIMPLE_CHANGES_CONFIG_DIR", configuration);
    const lease = startLoop(fixture.root, "controller", "ship");
    await executeLoopMutation(fixture.root, lease.runId, "controller", CHILD);
    expect(existsSync(join(fixture.root, "child-ran.txt"))).toBe(true);
  });

  test("guard output goes to stderr so loop exec --json stays parseable", () => {
    const fixture = guardedRepository(GUARD);
    const environment = {
      ...process.env,
      EXEC_GUARD_TEST_EXIT: "0",
      EXEC_GUARD_TEST_PRINT: "1",
      SIMPLE_CHANGES_SKILL_ROOTS: "",
    };
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { env: environment, stderr: "pipe", stdout: "pipe" }
    );
    const { lease } = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    const executed = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "exec",
        "--run-id",
        lease.runId,
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
        "--",
        ...CHILD,
      ],
      { env: environment, stderr: "pipe", stdout: "pipe" }
    );
    const stdout = decoder.decode(executed.stdout);
    const stderr = decoder.decode(executed.stderr);
    expect(executed.exitCode).toBe(0);
    expect(stdout).not.toContain("guard-stdout-line");
    expect(JSON.parse(stdout)).toMatchObject({ command: CHILD });
    expect(stderr).toContain("guard-stdout-line");
    expect(stderr).toContain("guard-stderr-line");
    expect(fixture.childRan()).toBe(true);
  });

  test("setup and acknowledge-update keep a saved guard unchanged", () => {
    const fixture = guardedRepository(GUARD);
    const policyPath = join(fixture.root, ".simple-changes.json");
    const environment = {
      ...process.env,
      SIMPLE_CHANGES_CONFIG_DIR: join(fixture.base, "configuration"),
      SIMPLE_CHANGES_SKILL_ROOTS: "",
    };
    const setup = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "always",
        "--scope",
        "repository",
        "--instruction-pointer",
        "leave",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { env: environment, stderr: "pipe", stdout: "pipe" }
    );
    expect(decoder.decode(setup.stderr)).toBe("");
    expect(setup.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(policyPath, "utf8"));
    expect(written).toMatchObject({ execGuard: GUARD, questions: "always" });
    expect(JSON.parse(decoder.decode(setup.stdout)).policy.execGuard).toEqual(
      GUARD
    );
    writeFileSync(
      policyPath,
      `${JSON.stringify({ ...written, guidance: { version: 1 } }, null, 2)}\n`
    );
    const acknowledged = spawnSync(
      [
        process.execPath,
        cliPath,
        "acknowledge-update",
        "--guidance-decision",
        "accepted",
        "--json",
        "--repo",
        fixture.root,
      ],
      { env: environment, stderr: "pipe", stdout: "pipe" }
    );
    expect(acknowledged.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(policyPath, "utf8")).execGuard).toEqual(
      GUARD
    );
  });

  test("the policy schema accepts only a non-empty argv of non-empty strings", () => {
    const policy = (execGuard: unknown) => ({ ...DEFAULT_POLICY, execGuard });
    expect(validateSchema<unknown>("repo-policy", policy(GUARD))).toEqual(
      policy(GUARD)
    );
    for (const invalid of [[], "bun scripts/exec-guard.ts", [""], [1]]) {
      expect(() => validateSchema("repo-policy", policy(invalid))).toThrow();
    }
  });
});
