import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "bun";
import {
  bindRunWorkDirectory,
  boundWorkDirectory,
  createWorkDirectory,
  locateWorkDirectoryRepository,
  removeFinishedRunWorkDirectories,
  removeRunWorkDirectories,
  removeWorkDirectory,
  repositoryWorkDirectory,
  WORK_ROOT_ENVIRONMENT,
  workDirectoryContaining,
} from "../../../skills/simple-changes/scripts/lib/work-directory.ts";
import { createTestRepository, git, type TestRepository } from "./helpers.ts";

const decoder = new TextDecoder();
const cliPath = new URL(
  "../../../skills/simple-changes/scripts/simple-changes.ts",
  import.meta.url
).pathname;

let repositories: TestRepository[] = [];
let scratch: string[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  for (const directory of scratch) {
    chmodSync(directory, 0o700);
    rmSync(directory, { force: true, recursive: true });
  }
  repositories = [];
  scratch = [];
});

const workRoot = (): {
  base: string;
  environment: NodeJS.ProcessEnv;
  root: string;
} => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "work-directory-")));
  scratch.push(base);
  const root = join(base, "root");
  return { base, environment: { [WORK_ROOT_ENVIRONMENT]: root }, root };
};

const repository = () => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return { fixture, location: locateWorkDirectoryRepository(fixture.root) };
};

const mode = (path: string): number => statSync(path).mode % 0o1000;

describe("agent work directories", () => {
  test("creates a new private directory on every request", () => {
    const { environment, root } = workRoot();
    const { location } = repository();

    const first = createWorkDirectory(location, "claude/opus 5.5", environment);
    const second = createWorkDirectory(
      location,
      "claude/opus 5.5",
      environment
    );
    expect(first).not.toBe(second);
    expect(dirname(first)).toBe(dirname(second));
    expect(dirname(dirname(first))).toBe(root);
    expect(basename(first).startsWith("claude-opus-5-5-")).toBe(true);
    for (const path of [root, dirname(first), first]) {
      expect(mode(path)).toBe(0o700);
    }
  });

  test("names one directory per repository, shared by its worktrees", () => {
    const { environment } = workRoot();
    const { fixture, location } = repository();
    const { location: other } = repository();
    const worktree = join(fixture.base, "linked");
    git(fixture.root, ["worktree", "add", "-q", "-b", "linked", worktree]);

    const here = repositoryWorkDirectory(location, environment);
    expect(
      repositoryWorkDirectory(
        locateWorkDirectoryRepository(worktree),
        environment
      )
    ).toBe(here);
    expect(repositoryWorkDirectory(other, environment)).not.toBe(here);
  });

  test("refuses a root inside the checkout or the Git common directory", () => {
    const { fixture, location } = repository();
    for (const root of [
      join(fixture.root, "nested", "scratch"),
      join(location.commonGitDirectory, "scratch"),
    ]) {
      expect(() =>
        repositoryWorkDirectory(location, { [WORK_ROOT_ENVIRONMENT]: root })
      ).toThrow("Refusing a work directory inside");
      expect(existsSync(root)).toBe(false);
    }
    expect(existsSync(join(fixture.root, "nested"))).toBe(false);
    expect(() =>
      repositoryWorkDirectory(location, {
        [WORK_ROOT_ENVIRONMENT]: "relative/root",
      })
    ).toThrow("must be an absolute path");
  });

  test("refuses a shared, redirected, or replaceable root", () => {
    const { base, environment, root } = workRoot();
    const { location } = repository();
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o777);
    expect(() => repositoryWorkDirectory(location, environment)).toThrow(
      "writable by others"
    );

    rmSync(root, { force: true, recursive: true });
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, root);
    expect(() => repositoryWorkDirectory(location, environment)).toThrow(
      "is a symlink"
    );
    rmSync(root, { force: true });

    // Another user could rename an ancestor that anyone may write without
    // the sticky bit, and redirect later checks and removals.
    chmodSync(base, 0o777);
    expect(() => repositoryWorkDirectory(location, environment)).toThrow(
      "which another user could replace"
    );
    expect(existsSync(root)).toBe(false);
  });

  test("binds the opening inventory's directory and reuses one binding", () => {
    const { environment } = workRoot();
    const { location } = repository();
    const opening = createWorkDirectory(location, "controller", environment);
    writeFileSync(join(opening, "opening.json"), "{}\n");

    expect(
      workDirectoryContaining(location, join(opening, "opening.json"))
    ).toBe(opening);
    expect(workDirectoryContaining(location, location.currentCheckout)).toBe(
      null
    );
    expect(
      bindRunWorkDirectory(
        location,
        "run-a",
        "controller",
        opening,
        environment
      )
    ).toBe(opening);
    expect(
      bindRunWorkDirectory(location, "run-a", "controller", null, environment)
    ).toBe(opening);
    expect(boundWorkDirectory(location, "run-a", "controller")).toBe(opening);

    const author = bindRunWorkDirectory(
      location,
      "run-a",
      "author",
      null,
      environment
    );
    expect(author).not.toBe(opening);
    expect(boundWorkDirectory(location, "run-a", "author")).toBe(author);
  });

  test("a clean close removes exactly the run's directories", () => {
    const { environment } = workRoot();
    const { location } = repository();
    const controller = bindRunWorkDirectory(
      location,
      "run-a",
      "controller",
      null,
      environment
    );
    const author = bindRunWorkDirectory(
      location,
      "run-a",
      "author",
      null,
      environment
    );
    // The same agent ID in another run, or unbound in another session, keeps
    // its own directory.
    const nextRun = bindRunWorkDirectory(
      location,
      "run-b",
      "controller",
      null,
      environment
    );
    const unbound = createWorkDirectory(location, "controller", environment);

    expect(removeRunWorkDirectories(location, "run-a")).toEqual({
      kept: [],
      removed: [controller, author].sort((left, right) =>
        left.localeCompare(right)
      ),
    });
    for (const path of [controller, author]) {
      expect(existsSync(path)).toBe(false);
    }
    for (const path of [nextRun, unbound]) {
      expect(existsSync(path)).toBe(true);
    }
    expect(removeRunWorkDirectories(location, "run-a")).toEqual({
      kept: [],
      removed: [],
    });
  });

  test("never removes a tampered binding's path", () => {
    const { base, environment } = workRoot();
    const { location } = repository();
    bindRunWorkDirectory(location, "run-a", "controller", null, environment);
    const outside = join(base, "precious");
    mkdirSync(outside, { mode: 0o700 });
    const bindings = join(
      location.commonGitDirectory,
      "simple-changes",
      "work-directories",
      "run-a"
    );
    writeFileSync(
      join(bindings, "tampered.json"),
      `${JSON.stringify({ agentId: "x", path: outside, schemaVersion: 1 })}\n`
    );

    const removal = removeRunWorkDirectories(location, "run-a");
    expect(removal.removed).toHaveLength(1);
    expect(removal.kept).toEqual([
      {
        path: outside,
        reason: expect.stringContaining("Not a work directory"),
      },
    ]);
    expect(existsSync(outside)).toBe(true);
  });

  test("moves a finished run's directory to the run that reuses it", () => {
    const { environment } = workRoot();
    const { location } = repository();
    const reused = bindRunWorkDirectory(
      location,
      "run-old",
      "controller",
      null,
      environment
    );
    const abandoned = bindRunWorkDirectory(
      location,
      "run-old",
      "author",
      null,
      environment
    );
    expect(
      bindRunWorkDirectory(
        location,
        "run-new",
        "controller",
        reused,
        environment
      )
    ).toBe(reused);

    expect(removeFinishedRunWorkDirectories(location, "run-new")).toEqual({
      kept: [],
      removed: [abandoned],
    });
    expect(existsSync(reused)).toBe(true);
    expect(boundWorkDirectory(location, "run-new", "controller")).toBe(reused);
  });

  test("removes one directory on request unless the live run holds it", () => {
    const { environment } = workRoot();
    const { fixture, location } = repository();
    const live = bindRunWorkDirectory(
      location,
      "run-a",
      "controller",
      null,
      environment
    );
    const loose = createWorkDirectory(location, "controller", environment);

    expect(() => removeWorkDirectory(location, live, "run-a")).toThrow(
      "belongs to active run run-a"
    );
    expect(removeWorkDirectory(location, loose, "run-a")).toBe(loose);
    expect(existsSync(loose)).toBe(false);
    expect(() => removeWorkDirectory(location, fixture.root, null)).toThrow(
      "Not a work directory"
    );
    expect(existsSync(fixture.root)).toBe(true);
  });
});

describe("work directories through the CLI", () => {
  const run = (args: string[], repositoryPath: string) => {
    const result = spawnSync(
      [process.execPath, cliPath, ...args, "--repo", repositoryPath],
      {
        env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    return {
      exitCode: result.exitCode,
      stderr: decoder.decode(result.stderr),
      stdout: decoder.decode(result.stdout),
    };
  };

  test("prints a new bare path before any loop and removes it on request", () => {
    const { fixture } = repository();
    const created = run(["workdir", "--agent-id", "controller"], fixture.root);
    expect(created.exitCode).toBe(0);
    const path = created.stdout.trim();
    expect(
      path.startsWith(realpathSync(process.env[WORK_ROOT_ENVIRONMENT] ?? "/"))
    ).toBe(true);
    expect(
      run(["workdir", "--agent-id", "controller"], fixture.root).stdout.trim()
    ).not.toBe(path);

    const removed = run(["workdir", "remove", path, "--json"], fixture.root);
    expect(JSON.parse(removed.stdout)).toEqual({
      removed: true,
      workDir: path,
    });
    expect(existsSync(path)).toBe(false);
    expect(run(["workdir", "tidy"], fixture.root).exitCode).not.toBe(0);
  });

  test("loop start binds a directory that workdir returns and finalize removes", () => {
    const { fixture } = repository();
    const started = run(
      [
        "loop",
        "start",
        "--mode",
        "queue",
        "--agent-id",
        "controller",
        "--json",
      ],
      fixture.root
    );
    expect(started.exitCode).toBe(0);
    const { lease, workDir } = JSON.parse(started.stdout) as {
      lease: { runId: string };
      workDir: string;
    };
    expect(existsSync(workDir)).toBe(true);
    expect(
      run(["workdir", "--agent-id", "controller"], fixture.root).stdout.trim()
    ).toBe(workDir);
    writeFileSync(join(workDir, "final.json"), "{}\n");

    const finalized = run(
      [
        "loop",
        "finalize",
        "--run-id",
        lease.runId,
        "--agent-id",
        "controller",
        "--reason",
        "Nothing was ready to queue.",
        "--json",
      ],
      fixture.root
    );
    expect(finalized.exitCode).toBe(0);
    expect(JSON.parse(finalized.stdout)).toMatchObject({
      outcome: "completed",
      removedWorkDirectories: [workDir],
    });
    expect(existsSync(workDir)).toBe(false);
  });
});
