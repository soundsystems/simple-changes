import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sleepSync, spawnSync } from "bun";
import {
  type GitExecutableProbe,
  GuardedProcessGroupStillAliveError,
  PROCESS_GROUP_CONTROL,
  type ProcessGroupControl,
  type ProcessGroupRunDependencies,
  resolveGitExecutable,
  runGit,
  runGitConcurrently,
  runGuardInProcessGroup,
  runInProcessGroup,
  unregisteredCommandCleanup,
} from "../../../skills/simple-changes/scripts/lib/process.ts";
import { createTestRepository, git, type TestRepository } from "./helpers.ts";

const DEVELOPER_GIT = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";

const probe = (overrides: Partial<GitExecutableProbe>): GitExecutableProbe => ({
  platform: "darwin",
  realpath: (path) => path,
  which: () => "/usr/bin/git",
  xcrunFind: () => DEVELOPER_GIT,
  ...overrides,
});

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("Git executable resolution", () => {
  test("bypasses the macOS xcrun shim with the binary it would run", () => {
    expect(resolveGitExecutable(probe({}))).toBe(DEVELOPER_GIT);
  });

  test("keeps plain git whenever the shim is not what PATH resolves", () => {
    expect(resolveGitExecutable(probe({ platform: "linux" }))).toBe("git");
    expect(
      resolveGitExecutable(probe({ which: () => "/opt/homebrew/bin/git" }))
    ).toBe("git");
    expect(resolveGitExecutable(probe({ which: () => null }))).toBe("git");
    expect(
      resolveGitExecutable(
        probe({
          realpath: () => {
            throw new Error("dangling link");
          },
        })
      )
    ).toBe("git");
  });

  test("finds the developer Git without running xcrun when it can", () => {
    let xcrunRan = false;
    const xcrunFind = () => {
      xcrunRan = true;
      return DEVELOPER_GIT;
    };
    const commandLineGit = "/Library/Developer/CommandLineTools/usr/bin/git";
    expect(
      resolveGitExecutable(
        probe({ developerGit: () => commandLineGit, xcrunFind })
      )
    ).toBe(commandLineGit);
    expect(xcrunRan).toBe(false);
    expect(
      resolveGitExecutable(probe({ developerGit: () => null, xcrunFind }))
    ).toBe(DEVELOPER_GIT);
    expect(xcrunRan).toBe(true);
  });

  test("read-only resolution never runs xcrun and refuses the shim", () => {
    let xcrunRan = false;
    const xcrunFind = () => {
      xcrunRan = true;
      return DEVELOPER_GIT;
    };
    const directOnly = { directOnly: true };
    for (const overrides of [
      { developerGit: () => null },
      {},
      {
        realpath: () => {
          throw new Error("dangling link");
        },
      },
    ]) {
      expect(() =>
        resolveGitExecutable(probe({ ...overrides, xcrunFind }), directOnly)
      ).toThrow("never through xcrun");
    }
    const commandLineGit = "/Library/Developer/CommandLineTools/usr/bin/git";
    expect(
      resolveGitExecutable(
        probe({ developerGit: () => commandLineGit, xcrunFind }),
        directOnly
      )
    ).toBe(commandLineGit);
    expect(
      resolveGitExecutable(probe({ platform: "linux", xcrunFind }), directOnly)
    ).toBe("git");
    expect(
      resolveGitExecutable(
        probe({ which: () => "/opt/homebrew/bin/git", xcrunFind }),
        directOnly
      )
    ).toBe("git");
    expect(xcrunRan).toBe(false);
  });

  test("read-only commands refuse rather than run xcrun or the shim", () => {
    if (process.platform !== "darwin") {
      return;
    }
    const fixture = createTestRepository();
    repositories.push(fixture);
    const fakeBin = join(fixture.base, "bin");
    mkdirSync(fakeBin);
    const marker = join(fixture.base, "xcrun-ran");
    writeFileSync(
      join(fakeBin, "xcrun"),
      `#!/bin/sh\necho ran > '${marker}'\necho /usr/bin/git\n`
    );
    chmodSync(join(fakeBin, "xcrun"), 0o755);
    const cliPath = fileURLToPath(
      new URL(
        "../../../skills/simple-changes/scripts/simple-changes.ts",
        import.meta.url
      )
    );
    // A configured developer directory with no Git: xcrun would stop there,
    // so only xcrun or the /usr/bin/git shim could still find a Git.
    const env = {
      ...process.env,
      DEVELOPER_DIR: join(fixture.base, "NoDeveloper"),
      HOME: fixture.base,
      PATH: `${fakeBin}:/usr/bin:/bin`,
    };
    for (const args of [
      ["status", "--json", "--repo", fixture.root],
      ["status", "--all", "--root", fixture.base, "--json"],
      ["loop", "draft-outcome", "--run-id", "run-x", "--repo", fixture.root],
    ]) {
      const result = spawnSync([process.execPath, cliPath, ...args], {
        cwd: fixture.root,
        env,
        stderr: "pipe",
        stdout: "pipe",
      });
      const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
      expect({ args, exitCode: result.exitCode }).toEqual({
        args,
        exitCode: 5,
      });
      expect(output).toContain("never through xcrun");
      expect(existsSync(marker)).toBe(false);
    }
  });

  test("a read-only read refuses a shim resolved earlier in the process", () => {
    if (process.platform !== "darwin") {
      return;
    }
    const fixture = createTestRepository();
    repositories.push(fixture);
    const fakeBin = join(fixture.base, "bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "xcrun"), "#!/bin/sh\necho /usr/bin/git\n");
    chmodSync(join(fakeBin, "xcrun"), 0o755);
    const lib = (name: string) =>
      JSON.stringify(
        fileURLToPath(
          new URL(
            `../../../skills/simple-changes/scripts/lib/${name}`,
            import.meta.url
          )
        )
      );
    const script = [
      `const { gitExecutable } = await import(${lib("process.ts")});`,
      `const { withReadOnlyGit } = await import(${lib("read-only-git.ts")});`,
      // An ordinary command resolves first and keeps the shim.
      "console.log(gitExecutable());",
      "try { withReadOnlyGit(() => console.log('read')); }",
      "catch (error) { console.log('refused: ' + error.message); }",
    ].join("\n");
    const result = spawnSync([process.execPath, "-e", script], {
      env: {
        ...process.env,
        DEVELOPER_DIR: join(fixture.base, "NoDeveloper"),
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
    expect(lines[0]).toBe("git");
    expect(lines[1]).toStartWith("refused: ");
    expect(lines[1]).toContain("never through xcrun");
    expect(lines).not.toContain("read");
  });

  test("the runtime finds the developer Git without running xcrun", () => {
    if (process.platform !== "darwin") {
      return;
    }
    const fixture = createTestRepository();
    repositories.push(fixture);
    const developer = join(fixture.base, "Developer");
    const fakeBin = join(fixture.base, "bin");
    mkdirSync(join(developer, "usr", "bin"), { recursive: true });
    mkdirSync(fakeBin);
    const developerGit = join(developer, "usr", "bin", "git");
    writeFileSync(developerGit, "#!/bin/sh\nexit 0\n");
    chmodSync(developerGit, 0o755);
    const marker = join(fixture.base, "xcrun-ran");
    writeFileSync(
      join(fakeBin, "xcrun"),
      `#!/bin/sh\necho ran > '${marker}'\necho /usr/bin/git\n`
    );
    chmodSync(join(fakeBin, "xcrun"), 0o755);
    const processModule = fileURLToPath(
      new URL(
        "../../../skills/simple-changes/scripts/lib/process.ts",
        import.meta.url
      )
    );
    const result = spawnSync(
      [
        process.execPath,
        "-e",
        `const { gitExecutable } = await import(${JSON.stringify(processModule)}); console.log(gitExecutable());`,
      ],
      {
        env: {
          ...process.env,
          DEVELOPER_DIR: developer,
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    expect(new TextDecoder().decode(result.stdout).trim()).toBe(developerGit);
    expect(existsSync(marker)).toBe(false);
  });

  test("follows a PATH link that resolves to the shim", () => {
    expect(
      resolveGitExecutable(
        probe({
          realpath: () => "/usr/bin/git",
          which: () => "/usr/local/bin/git",
        })
      )
    ).toBe(DEVELOPER_GIT);
  });

  test("keeps plain git when xcrun cannot name a real binary", () => {
    expect(resolveGitExecutable(probe({ xcrunFind: () => null }))).toBe("git");
    expect(resolveGitExecutable(probe({ xcrunFind: () => "git" }))).toBe("git");
    expect(
      resolveGitExecutable(probe({ xcrunFind: () => "/usr/bin/git" }))
    ).toBe("git");
  });
});

describe("Concurrent Git reads", () => {
  test("return the same stdout, in request order, as sequential reads", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const requests = [
      ["rev-parse", "HEAD"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      ["log", "--format=%s", "-1"],
      ["ls-files", "--stage", "-z"],
      ["symbolic-ref", "--short", "HEAD"],
    ].map((args) => ({ args, cwd: fixture.root }));

    const concurrent = runGitConcurrently(requests);

    expect(concurrent.map((result) => result.stdout)).toEqual(
      requests.map((request) => runGit(request.cwd, request.args).stdout)
    );
    expect(concurrent.every((result) => result.exitCode === 0)).toBe(true);
  });

  test("raise the same error a sequential read would", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const failing = ["rev-parse", "--verify", "refs/heads/does-not-exist"];
    const requests = [
      ["rev-parse", "HEAD"],
      ["rev-parse", "HEAD"],
      failing,
      ["rev-parse", "HEAD"],
    ].map((args) => ({ args, cwd: fixture.root }));

    let sequentialError: unknown;
    try {
      runGit(fixture.root, failing);
    } catch (error) {
      sequentialError = error;
    }

    expect(sequentialError).toBeInstanceOf(Error);
    expect(() => runGitConcurrently(requests)).toThrow(
      (sequentialError as Error).message
    );
  });

  test("run in the worker rather than the sequential fallback", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    // An ambiguous name succeeds but warns on stderr. Sequential reads keep
    // that warning; worker results carry no stderr, which proves they ran
    // concurrently instead of silently falling back.
    git(fixture.root, ["config", "core.warnAmbiguousRefs", "true"]);
    git(fixture.root, ["tag", "ambiguous"]);
    git(fixture.root, ["branch", "ambiguous"]);
    const requests = Array.from({ length: 4 }, () => ({
      args: ["rev-parse", "ambiguous"],
      cwd: fixture.root,
    }));

    const sequential = runGit(fixture.root, ["rev-parse", "ambiguous"]);
    const concurrent = runGitConcurrently(requests);

    expect(sequential.stderr).toContain("ambiguous");
    expect(concurrent.map((result) => result.stderr)).toEqual(
      requests.map(() => "")
    );
    expect(concurrent.map((result) => result.stdout)).toEqual(
      requests.map(() => sequential.stdout)
    );
  });

  test("re-run a request the worker could not start", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const missing = join(fixture.base, "missing-directory");
    const requests = [fixture.root, fixture.root, missing, fixture.root].map(
      (cwd) => ({ args: ["rev-parse", "HEAD"], cwd })
    );

    let sequentialError: unknown;
    try {
      runGit(missing, ["rev-parse", "HEAD"]);
    } catch (error) {
      sequentialError = error;
    }

    expect(sequentialError).toBeInstanceOf(Error);
    expect(() => runGitConcurrently(requests)).toThrow(
      (sequentialError as Error).message
    );
  });
});

describe("Guarded process groups", () => {
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test.skipIf(process.platform === "win32")(
    "a failed registration terminates descendants the command already started",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "guarded-group-"));
      const pidFile = join(directory, "descendant.pid");
      const registration = new Error("lock owner write failed");
      try {
        const run = runGuardInProcessGroup(
          "sh",
          ["-c", `sleep 30 & echo $! > "${pidFile}"; wait`],
          directory,
          () => {
            // Fail registration only once the descendant exists, so the
            // whole group, not just its leader, must be terminated.
            const deadline = Date.now() + 10_000;
            while (!existsSync(pidFile) && Date.now() < deadline) {
              sleepSync(10);
            }
            throw registration;
          },
          {}
        );
        await expect(run).rejects.toBe(registration);
        const descendant = Number(readFileSync(pidFile, "utf8").trim());
        expect(Number.isSafeInteger(descendant)).toBe(true);
        expect(isAlive(descendant)).toBe(false);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  );
});

// Deterministic stand-ins for the process boundary: each simulates one way a
// process group can answer, so a cleanup that releases the lock early fails.
const CHILD_PID = 4242;
const errno = (code: string): Error =>
  Object.assign(new Error(`${code} (simulated)`), { code });

interface RecordingControl extends ProcessGroupControl {
  pids: number[];
  signals: Array<NodeJS.Signals | 0>;
  taskkills: Array<{ argv: string[]; timeoutMs: number }>;
}

const simulatedGroup = (
  behavior: "exits-on-sigterm" | "survives" | "unsignallable",
  overrides: Partial<ProcessGroupControl> = {}
): RecordingControl => {
  let alive = true;
  const pids: number[] = [];
  const signals: Array<NodeJS.Signals | 0> = [];
  const taskkills: Array<{ argv: string[]; timeoutMs: number }> = [];
  return {
    graceMs: 0,
    kill: (pid, signal) => {
      pids.push(pid);
      signals.push(signal);
      if (behavior === "unsignallable") {
        throw errno("EPERM");
      }
      if (signal === 0 && !alive) {
        throw errno("ESRCH");
      }
      if (signal === "SIGTERM" && behavior === "exits-on-sigterm") {
        alive = false;
      }
    },
    pids,
    platform: "linux",
    runSync: (argv, timeoutMs) => {
      taskkills.push({ argv, timeoutMs });
    },
    signals,
    taskkills,
    ...overrides,
  };
};

describe("Unregistered command cleanup", () => {
  test("releases the lock only once the terminated group is gone", async () => {
    const control = simulatedGroup("exits-on-sigterm");
    expect(
      await unregisteredCommandCleanup("guard", CHILD_PID, control)
    ).toBeNull();
    expect(control.signals).toContain("SIGTERM");
  });

  test("keeps the lock when the group survives SIGTERM and SIGKILL", async () => {
    const control = simulatedGroup("survives");
    expect(
      await unregisteredCommandCleanup("guard", CHILD_PID, control)
    ).toBeInstanceOf(GuardedProcessGroupStillAliveError);
    expect(control.signals).toContain("SIGTERM");
    expect(control.signals).toContain("SIGKILL");
    // Every signal targets the whole group, never only its leader.
    expect(new Set(control.pids)).toEqual(new Set([-CHILD_PID]));
  });

  test("keeps the lock when the group cannot be signalled", async () => {
    expect(
      await unregisteredCommandCleanup(
        "guard",
        CHILD_PID,
        simulatedGroup("unsignallable")
      )
    ).toBeInstanceOf(GuardedProcessGroupStillAliveError);
  });

  test("on Windows, kills the tree with a bounded taskkill and keeps the lock", async () => {
    const control = simulatedGroup("survives", { platform: "win32" });
    expect(
      await unregisteredCommandCleanup("guard", CHILD_PID, control)
    ).toBeInstanceOf(GuardedProcessGroupStillAliveError);
    expect(control.signals).toEqual([]);
    expect(control.taskkills).toHaveLength(1);
    const [taskkill] = control.taskkills;
    expect(taskkill?.argv).toEqual([
      "taskkill",
      "/pid",
      String(CHILD_PID),
      "/t",
      "/f",
    ]);
    expect(taskkill?.timeoutMs).toBeGreaterThan(0);
    expect(taskkill?.timeoutMs).toBeLessThanOrEqual(60_000);
  });

  test("on Windows, keeps the lock when taskkill cannot launch", async () => {
    const control = simulatedGroup("survives", {
      platform: "win32",
      runSync: () => {
        throw errno("ENOENT");
      },
    });
    expect(
      await unregisteredCommandCleanup("guard", CHILD_PID, control)
    ).toBeInstanceOf(GuardedProcessGroupStillAliveError);
  });

  test("the production taskkill runner stops a command that hangs", () => {
    const started = Date.now();
    PROCESS_GROUP_CONTROL.runSync(
      [process.execPath, "-e", "await Bun.sleep(15_000)"],
      200
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("Registration failure settlement", () => {
  // A child that never runs anything: the test decides which events it emits.
  const fakeChild = (): EventEmitter =>
    Object.assign(new EventEmitter(), { kill: () => true, pid: CHILD_PID });

  const failingRegistration = (
    cleanupUnregistered: ProcessGroupRunDependencies["cleanupUnregistered"]
  ) => {
    const child = fakeChild();
    const registration = new Error("lock owner write failed");
    const run = runInProcessGroup(
      "guard",
      [],
      tmpdir(),
      () => {
        throw registration;
      },
      { environment: {}, streamOutputToStderr: true },
      {
        cleanupUnregistered,
        platform: "linux",
        spawn: () => child as unknown as ChildProcess,
      }
    );
    return { child, registration, run };
  };

  test("a late child error cannot settle the run before cleanup", async () => {
    let finish: (value: GuardedProcessGroupStillAliveError | null) => void =
      () => undefined;
    const cleanup = new Promise<GuardedProcessGroupStillAliveError | null>(
      (resolve) => {
        finish = resolve;
      }
    );
    const { child, run } = failingRegistration(() => cleanup);
    child.emit("error", new Error("late child error"));
    const kept = new GuardedProcessGroupStillAliveError("guard", CHILD_PID);
    finish(kept);
    await expect(run).rejects.toBe(kept);
  });

  test("a group that survives cleanup keeps the lock", async () => {
    const { run } = failingRegistration((command, pid) =>
      unregisteredCommandCleanup(command, pid, simulatedGroup("survives"))
    );
    await expect(run).rejects.toBeInstanceOf(
      GuardedProcessGroupStillAliveError
    );
  });

  test("a group that cannot be signalled keeps the lock", async () => {
    const { run } = failingRegistration((command, pid) =>
      unregisteredCommandCleanup(command, pid, simulatedGroup("unsignallable"))
    );
    await expect(run).rejects.toBeInstanceOf(
      GuardedProcessGroupStillAliveError
    );
  });

  test("a cleanup that rejects keeps the lock", async () => {
    const { run } = failingRegistration(() =>
      Promise.reject(new Error("cleanup failed"))
    );
    await expect(run).rejects.toBeInstanceOf(
      GuardedProcessGroupStillAliveError
    );
  });

  test("a cleanup that throws synchronously keeps the lock", async () => {
    const { run } = failingRegistration(() => {
      throw new Error("cleanup failed");
    });
    await expect(run).rejects.toBeInstanceOf(
      GuardedProcessGroupStillAliveError
    );
  });

  test("a proven cleanup reports the registration failure itself", async () => {
    const { registration, run } = failingRegistration((command, pid) =>
      unregisteredCommandCleanup(
        command,
        pid,
        simulatedGroup("exits-on-sigterm")
      )
    );
    await expect(run).rejects.toBe(registration);
  });

  test("Windows registration failure keeps the lock", async () => {
    const { run } = failingRegistration((command, pid) =>
      unregisteredCommandCleanup(
        command,
        pid,
        simulatedGroup("survives", { platform: "win32" })
      )
    );
    await expect(run).rejects.toBeInstanceOf(
      GuardedProcessGroupStillAliveError
    );
  });
});

describe("guarded process input", () => {
  test("writes in-memory stdin to the child and still reports its exit code", async () => {
    const echoed = await runInProcessGroup(
      process.execPath,
      ["-e", "process.stdout.write(await Bun.stdin.text())"],
      tmpdir(),
      () => undefined,
      {
        environment: {},
        stdin: "object abc\n\nmessage\n",
        streamOutputToStderr: false,
      }
    );
    expect(echoed).toMatchObject({
      exitCode: 0,
      stdout: "object abc\n\nmessage\n",
    });
    // A child that never reads its input exits on its own terms.
    const ignored = await runInProcessGroup(
      process.execPath,
      ["-e", "process.exit(3)"],
      tmpdir(),
      () => undefined,
      {
        environment: {},
        stdin: "x".repeat(1_048_576),
        streamOutputToStderr: false,
      }
    );
    expect(ignored.exitCode).toBe(3);
    // Without input, stdin stays closed to the child.
    const closed = await runInProcessGroup(
      process.execPath,
      ["-e", "process.stdout.write(String((await Bun.stdin.text()).length))"],
      tmpdir(),
      () => undefined,
      { environment: {}, streamOutputToStderr: false }
    );
    expect(closed.stdout).toBe("0");
  });
});
