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
  createWorkDirectory,
  locateWorkDirectoryRepository,
  removeFinishedRunWorkDirectories,
  removeRunWorkDirectories,
  removeWorkDirectory,
  repositoryWorkDirectory,
  runWorkDirectoryBinding,
  sameSession,
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

const byPath = (left: string, right: string): number =>
  left.localeCompare(right);

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
    const { fixture, location } = repository();
    const opening = createWorkDirectory(location, "controller", environment);
    writeFileSync(join(opening, "opening.json"), "{}\n");

    expect(
      workDirectoryContaining(location, join(opening, "opening.json"))
    ).toBe(opening);
    expect(
      workDirectoryContaining(location, join(fixture.root, "README.md"))
    ).toBe(null);
    expect(
      bindRunWorkDirectory(
        location,
        "run-a",
        "controller",
        null,
        opening,
        environment
      )
    ).toBe(opening);
    expect(
      bindRunWorkDirectory(
        location,
        "run-a",
        "controller",
        null,
        null,
        environment
      )
    ).toBe(opening);
    expect(runWorkDirectoryBinding(location, "run-a", "controller")?.path).toBe(
      opening
    );

    const author = bindRunWorkDirectory(
      location,
      "run-a",
      "author",
      null,
      null,
      environment
    );
    expect(author).not.toBe(opening);
    expect(runWorkDirectoryBinding(location, "run-a", "author")?.path).toBe(
      author
    );
  });

  test("a clean close removes exactly the run's directories", () => {
    const { environment } = workRoot();
    const { location } = repository();
    const controller = bindRunWorkDirectory(
      location,
      "run-a",
      "controller",
      null,
      null,
      environment
    );
    const author = bindRunWorkDirectory(
      location,
      "run-a",
      "author",
      null,
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
    bindRunWorkDirectory(
      location,
      "run-a",
      "controller",
      null,
      null,
      environment
    );
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
      null,
      environment
    );
    const abandoned = bindRunWorkDirectory(
      location,
      "run-old",
      "author",
      null,
      null,
      environment
    );
    expect(
      bindRunWorkDirectory(
        location,
        "run-new",
        "controller",
        null,
        reused,
        environment
      )
    ).toBe(reused);

    expect(removeFinishedRunWorkDirectories(location, "run-new")).toEqual({
      kept: [],
      removed: [abandoned],
    });
    expect(existsSync(reused)).toBe(true);
    expect(
      runWorkDirectoryBinding(location, "run-new", "controller")?.path
    ).toBe(reused);
  });

  test("removes one directory on request unless the live run holds it", () => {
    const { environment } = workRoot();
    const { fixture, location } = repository();
    const live = bindRunWorkDirectory(
      location,
      "run-a",
      "controller",
      null,
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

describe("work directory identity and paths", () => {
  test("a binding follows its agent to a new session", () => {
    const { environment } = workRoot();
    const { location } = repository();
    const path = bindRunWorkDirectory(
      location,
      "run-a",
      "controller",
      "claude-code:first",
      null,
      environment
    );
    expect(runWorkDirectoryBinding(location, "run-a", "controller")).toEqual({
      path,
      session: "claude-code:first",
    });
    // A resume or takeover proves the new session holds the run.
    expect(
      bindRunWorkDirectory(
        location,
        "run-a",
        "controller",
        "codex:second",
        null,
        environment
      )
    ).toBe(path);
    expect(runWorkDirectoryBinding(location, "run-a", "controller")).toEqual({
      path,
      session: "codex:second",
    });
    expect(sameSession("codex:second", "codex:second")).toBe(true);
    expect(sameSession("codex:second", null)).toBe(true);
    expect(sameSession("codex:second", "claude-code:first")).toBe(false);
  });

  test("never removes a binding that leaves the repository directory", () => {
    const { environment, root } = workRoot();
    const { location } = repository();
    const own = bindRunWorkDirectory(
      location,
      "run-a",
      "controller",
      null,
      null,
      environment
    );
    const repositoryDirectory = dirname(own);
    const other = createWorkDirectory(location, "other", environment);
    const bindings = join(
      location.commonGitDirectory,
      "simple-changes",
      "work-directories",
      "run-a"
    );
    for (const [name, path] of [
      ["dots", `${repositoryDirectory}/..`],
      ["trailing", `${other}/`],
      ["inner", `${repositoryDirectory}/../${basename(repositoryDirectory)}`],
    ] as const) {
      writeFileSync(
        join(bindings, `${name}.json`),
        `${JSON.stringify({ agentId: name, path, schemaVersion: 1 })}\n`
      );
    }

    const removal = removeRunWorkDirectories(location, "run-a");
    expect(removal.removed).toEqual([own]);
    expect(removal.kept.map((entry) => entry.path).sort(byPath)).toEqual(
      [
        `${repositoryDirectory}/..`,
        `${other}/`,
        `${repositoryDirectory}/../${basename(repositoryDirectory)}`,
      ].sort(byPath)
    );
    for (const path of [root, repositoryDirectory, other]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  test("refuses a root inside any registered worktree", () => {
    const { fixture, location } = repository();
    const worktree = join(fixture.base, "linked");
    git(fixture.root, ["worktree", "add", "-q", "-b", "linked", worktree]);
    const fromPrimary = locateWorkDirectoryRepository(fixture.root);
    expect(fromPrimary.checkouts).toContain(realpathSync(worktree));
    const root = join(worktree, "scratch");
    expect(() =>
      repositoryWorkDirectory(fromPrimary, { [WORK_ROOT_ENVIRONMENT]: root })
    ).toThrow("Refusing a work directory inside");
    expect(existsSync(root)).toBe(false);
    expect(location.checkouts).toContain(fixture.root);
  });
});

describe("work directory safety", () => {
  test("creates each missing parent privately", () => {
    const { base } = workRoot();
    const { location } = repository();
    const root = join(base, "a", "b", "root");
    repositoryWorkDirectory(location, { [WORK_ROOT_ENVIRONMENT]: root });
    for (const path of [join(base, "a"), join(base, "a", "b"), root]) {
      expect(mode(path)).toBe(0o700);
    }
  });

  test("never removes a directory that holds a registered checkout", () => {
    const { environment } = workRoot();
    const { fixture, location } = repository();
    const directory = bindRunWorkDirectory(
      location,
      "run-a",
      "controller",
      null,
      null,
      environment
    );
    const nested = join(directory, "author");
    git(fixture.root, ["worktree", "add", "-q", "-b", "nested", nested]);

    const removal = removeRunWorkDirectories(
      locateWorkDirectoryRepository(fixture.root),
      "run-a"
    );
    expect(removal.removed).toEqual([]);
    expect(removal.kept).toEqual([
      { path: directory, reason: expect.stringContaining("which holds") },
    ]);
    expect(existsSync(join(nested, "README.md"))).toBe(true);
  });
});

describe("work directories through the CLI", () => {
  const run = (
    args: string[],
    repositoryPath: string,
    environment: Record<string, string> = {}
  ) => {
    const result = spawnSync(
      [process.execPath, cliPath, ...args, "--repo", repositoryPath],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_SKILL_ROOTS: "",
          ...environment,
        },
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

  test("workdir binds any other agent of the live run, and finalize removes it", () => {
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

    // A reviewer or check runner the run never prepared still gets a
    // directory bound to the run, kept across calls in the same session.
    const helper = run(
      ["workdir", "--agent-id", "reviewer", "--json"],
      fixture.root
    );
    expect(helper.exitCode).toBe(0);
    const bound = JSON.parse(helper.stdout) as {
      bound: boolean;
      workDir: string;
    };
    expect(bound.bound).toBe(true);
    expect(bound.workDir).not.toBe(workDir);
    expect(existsSync(bound.workDir)).toBe(true);
    expect(
      run(["workdir", "--agent-id", "reviewer"], fixture.root).stdout.trim()
    ).toBe(bound.workDir);

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
      removedWorkDirectories: [bound.workDir, workDir].sort((left, right) =>
        left.localeCompare(right)
      ),
    });
    expect(existsSync(bound.workDir)).toBe(false);
    expect(existsSync(workDir)).toBe(false);
  });

  test("another session reusing the controller's agent ID gets its own directory", () => {
    const { fixture, location } = repository();
    // A session-bound start records the controller's session; keep that
    // record out of the developer's configuration.
    const config = realpathSync(
      mkdtempSync(join(tmpdir(), "work-directory-config-"))
    );
    scratch.push(config);
    const session = (id: string) => ({
      CLAUDE_CODE_SESSION_ID: id,
      SIMPLE_CHANGES_CONFIG_DIR: config,
    });
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
      fixture.root,
      session("session-one")
    );
    expect(started.exitCode).toBe(0);
    const { lease, workDir } = JSON.parse(started.stdout) as {
      lease: { runId: string };
      workDir: string;
    };
    const ask = (id: string) =>
      JSON.parse(
        run(
          ["workdir", "--agent-id", "controller", "--json"],
          fixture.root,
          session(id)
        ).stdout
      ) as { agentId: string; bound: boolean; workDir: string };

    expect(ask("session-one")).toEqual({
      agentId: "controller",
      bound: true,
      workDir,
    });
    const intruder = ask("session-two");
    expect(intruder.bound).toBe(false);
    expect(intruder.workDir).not.toBe(workDir);

    // A controller whose binding is gone, as after a takeover, is bound again.
    rmSync(
      join(
        location.commonGitDirectory,
        "simple-changes",
        "work-directories",
        lease.runId
      ),
      { force: true, recursive: true }
    );
    const rebound = ask("session-one");
    expect(rebound.bound).toBe(true);
    expect(ask("session-one").workDir).toBe(rebound.workDir);
    expect(ask("session-two").bound).toBe(false);
  });

  test("loop start removes the directories of runs that ended without a close", () => {
    const { fixture, location } = repository();
    const abandoned = bindRunWorkDirectory(
      location,
      "run-abandoned",
      "controller",
      null,
      null
    );
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
    expect(JSON.parse(started.stdout)).toMatchObject({
      removedWorkDirectories: [abandoned],
    });
    expect(existsSync(abandoned)).toBe(false);
  });

  test("a prepared author's own session claims its directory", () => {
    const { fixture } = repository();
    const config = realpathSync(
      mkdtempSync(join(tmpdir(), "work-directory-config-"))
    );
    scratch.push(config);
    const session = (id: string) => ({
      CLAUDE_CODE_SESSION_ID: id,
      SIMPLE_CHANGES_CONFIG_DIR: config,
    });
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
      fixture.root,
      session("controller-session")
    );
    const { lease } = JSON.parse(started.stdout) as {
      lease: { runId: string };
    };
    const prepared = run(
      [
        "prepare-agent",
        "--run-id",
        lease.runId,
        "--agent-id",
        "author",
        "--purpose",
        "unit",
        "--json",
      ],
      fixture.root,
      session("controller-session")
    );
    expect(prepared.exitCode).toBe(0);
    const { workDir } = JSON.parse(prepared.stdout) as { workDir: string };
    const ask = (id: string) =>
      JSON.parse(
        run(
          ["workdir", "--agent-id", "author", "--json"],
          fixture.root,
          session(id)
        ).stdout
      ) as { bound: boolean; workDir: string };

    expect(ask("author-session")).toMatchObject({ bound: true, workDir });
    expect(ask("author-session")).toMatchObject({ bound: true, workDir });
    expect(ask("other-session").bound).toBe(false);
  });
});
