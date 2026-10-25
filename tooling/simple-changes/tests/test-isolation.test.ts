import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "bun";
import { loadHarnessDefinitions } from "../../../skills/simple-changes/scripts/lib/authoring.ts";
import { gitReportedPath } from "../../../skills/simple-changes/scripts/lib/git-location.ts";
import { harnessSessionsIn } from "../../../skills/simple-changes/scripts/lib/harness-session.ts";
import { locateRepository } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { HARNESS_ENVIRONMENT_VARIABLES } from "./harness-environment.ts";
import { createTestRepository } from "./helpers.ts";

// A full check runs from this repository or a worktree that shares its `.git`,
// where other sessions keep live Simple Changes state. A test that falls back
// to the working directory, such as one passing `process.cwd()` as its
// repository or running the CLI without `--repo`, once read that state.
describe("test isolation from the host repository", () => {
  const repositoryCheckout = realpathSync(
    dirname(dirname(dirname(import.meta.dir)))
  );

  test("runs outside every repository, with discovery stopped above it", () => {
    const workingDirectory = realpathSync(process.cwd());
    expect(relative(repositoryCheckout, workingDirectory)).toStartWith("..");
    expect(process.env.GIT_CEILING_DIRECTORIES).toBe(dirname(workingDirectory));
    for (const name of ["GIT_COMMON_DIR", "GIT_DIR", "GIT_WORK_TREE"]) {
      expect(process.env[name]).toBeUndefined();
    }
    const discovery = spawnSync(["git", "rev-parse", "--git-common-dir"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(discovery.exitCode).not.toBe(0);
  });

  test("a lookup from the working directory fails instead of finding a repository", () => {
    expect(() => locateRepository(process.cwd())).toThrow();
  });

  test("an empty Git path answer is refused, never resolved to the working directory", () => {
    // `realpathSync("")` returns the working directory. Under heavy load
    // `rev-parse --show-toplevel` has printed nothing and exited 0, which
    // once made a fixture's lookup land in the repository the run started in.
    expect(realpathSync("")).toBe(realpathSync(process.cwd()));
    for (const output of ["", "\n", "\r\n"]) {
      expect(() => gitReportedPath(output, "--show-toplevel")).toThrow(
        "printed no path"
      );
    }
    expect(gitReportedPath("/repo\n", "--show-toplevel")).toBe("/repo");
  });

  test("fixture repositories still resolve to themselves", () => {
    const fixture = createTestRepository();
    try {
      expect(locateRepository(fixture.root).repository.commonGitDirectory).toBe(
        realpathSync(`${fixture.root}/.git`)
      );
    } finally {
      fixture.cleanup();
    }
  });
});

// The suite often runs inside an agent session, as the merge gate's receipt
// check does. A test that inherits that session's variables detects the
// running agent where a clean environment detects none, so it passes or
// fails by where it ran.
describe("test isolation from the running agent session", () => {
  const repositoryCheckout = realpathSync(
    dirname(dirname(dirname(import.meta.dir)))
  );
  const leakTestName =
    "no harness session or identity variable reaches a test or the processes it starts";
  const cleared: readonly string[] = HARNESS_ENVIRONMENT_VARIABLES;

  test("the preload clears every harness variable the runtime reads", () => {
    const scripts = join(
      repositoryCheckout,
      "skills",
      "simple-changes",
      "scripts"
    );
    const read = new Set<string>();
    for (const entry of readdirSync(scripts, { recursive: true })) {
      const path = join(scripts, String(entry));
      if (!path.endsWith(".ts")) {
        continue;
      }
      // An environment property read (`environment.CODEX_HOME`) or a
      // variable named in a string (`"CODEX_THREAD_ID"`).
      for (const match of readFileSync(path, "utf8").matchAll(
        /(?:\.|")((?:CLAUDE|CODEX)_[A-Z0-9_]+|AGENT_ID)\b/gu
      )) {
        read.add(match[1] as string);
      }
    }
    for (const definition of loadHarnessDefinitions()) {
      for (const name of definition.sessionEnv) {
        read.add(name);
      }
    }
    // The scan finds the variables the runtime reads today.
    for (const name of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) {
      expect(read.has(name)).toBe(true);
    }
    expect([...read].filter((name) => !cleared.includes(name))).toEqual([]);
  });

  test(leakTestName, () => {
    for (const name of cleared) {
      expect({ name, value: process.env[name] }).toEqual({
        name,
        value: undefined,
      });
    }
    expect(harnessSessionsIn(process.env)).toEqual([]);
    const child = spawnSync(
      [
        process.execPath,
        "-e",
        `console.log(JSON.stringify(${JSON.stringify(cleared)}.filter((name) => process.env[name] !== undefined)))`,
      ],
      { env: { ...process.env }, stderr: "pipe", stdout: "pipe" }
    );
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual([]);
  });

  test("control: the leak check fails in a test process started without the preload", () => {
    // Every variable set, as an agent session would set them. Bun reads the
    // preload from bunfig.toml in the directory `bun test` starts in, so the
    // same check run from the checkout is isolated and run from anywhere else
    // is not.
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "simple-changes-no-preload-"))
    );
    try {
      const valueFor = (name: string): string => {
        if (name === "CLAUDE_PID") {
          return String(process.pid);
        }
        if (name.endsWith("_DIR") || name.endsWith("_HOME")) {
          return join(outside, name.toLowerCase());
        }
        return `leaked-${name.toLowerCase()}`;
      };
      const session = Object.fromEntries(
        cleared.map((name) => [name, valueFor(name)])
      );
      expect(harnessSessionsIn(session).map((item) => item.harness)).toEqual([
        "claude-code",
        "codex",
      ]);
      const run = (cwd: string) => {
        const result = spawnSync(
          [
            process.execPath,
            "test",
            "--timeout",
            "120000",
            import.meta.path,
            "-t",
            leakTestName,
          ],
          {
            cwd,
            env: { ...process.env, ...session },
            stderr: "pipe",
            stdout: "pipe",
          }
        );
        return {
          exitCode: result.exitCode,
          output: `${result.stdout.toString()}${result.stderr.toString()}`,
        };
      };
      const isolated = run(repositoryCheckout);
      expect(isolated.output).toContain(" 1 pass");
      expect(isolated.exitCode).toBe(0);
      const leaked = run(outside);
      expect(leaked.output).toContain(leakTestName);
      expect(leaked.output).toContain(" 1 fail");
      expect(leaked.output).toContain("leaked-agent_id");
      expect(leaked.exitCode).not.toBe(0);
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });
});
