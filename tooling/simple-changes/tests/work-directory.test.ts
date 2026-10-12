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
import { dirname, join } from "node:path";
import { spawnSync } from "bun";
import {
  ensureWorkDirectory,
  locateWorkDirectoryRepository,
  removeWorkDirectory,
  WORK_ROOT_ENVIRONMENT,
  workDirectoryPath,
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
    rmSync(directory, { force: true, recursive: true });
  }
  repositories = [];
  scratch = [];
});

const workRoot = (): { environment: NodeJS.ProcessEnv; root: string } => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "work-directory-")));
  scratch.push(base);
  const root = join(base, "root");
  return { environment: { [WORK_ROOT_ENVIRONMENT]: root }, root };
};

const repository = () => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return { fixture, location: locateWorkDirectoryRepository(fixture.root) };
};

describe("agent work directories", () => {
  test("creates one private directory per repository and agent", () => {
    const { environment, root } = workRoot();
    const { location } = repository();
    const { location: other } = repository();

    const first = ensureWorkDirectory(location, "claude/opus 5.5", environment);
    expect(first.created).toBe(true);
    expect(first.path.startsWith(`${root}/repo-`)).toBe(true);
    expect(statSync(first.path).mode % 0o1000).toBe(0o700);
    expect(statSync(root).mode % 0o1000).toBe(0o700);
    expect(
      ensureWorkDirectory(location, "claude/opus 5.5", environment)
    ).toEqual({ created: false, path: first.path });

    const author = workDirectoryPath(location, "author", environment);
    const elsewhere = workDirectoryPath(other, "claude/opus 5.5", environment);
    expect(new Set([first.path, author, elsewhere]).size).toBe(3);
    // Agent IDs differing only in punctuation still get their own directory.
    expect(
      workDirectoryPath(location, "claude/opus-5.5", environment)
    ).not.toBe(first.path);
  });

  test("shares one directory between a repository's worktrees", () => {
    const { environment } = workRoot();
    const { fixture, location } = repository();
    const worktree = join(fixture.base, "linked");
    git(fixture.root, ["worktree", "add", "-q", "-b", "linked", worktree]);

    expect(
      workDirectoryPath(
        locateWorkDirectoryRepository(worktree),
        "agent",
        environment
      )
    ).toBe(workDirectoryPath(location, "agent", environment));
  });

  test("refuses a root inside the checkout or the Git common directory", () => {
    const { fixture, location } = repository();
    for (const root of [
      join(fixture.root, "scratch"),
      join(location.commonGitDirectory, "scratch"),
    ]) {
      expect(() =>
        ensureWorkDirectory(location, "agent", {
          [WORK_ROOT_ENVIRONMENT]: root,
        })
      ).toThrow("Refusing a work directory inside");
      expect(existsSync(root)).toBe(false);
    }
    expect(() =>
      ensureWorkDirectory(location, "agent", {
        [WORK_ROOT_ENVIRONMENT]: "relative/root",
      })
    ).toThrow("must be an absolute path");
  });

  test("refuses a shared or redirected root", () => {
    const { environment, root } = workRoot();
    const { location } = repository();
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o777);
    expect(() => ensureWorkDirectory(location, "agent", environment)).toThrow(
      "writable by others"
    );

    rmSync(root, { force: true, recursive: true });
    const target = join(dirname(root), "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, root);
    expect(() => ensureWorkDirectory(location, "agent", environment)).toThrow(
      "is a symlink"
    );
  });

  test("removes one agent's directory and leaves the others", () => {
    const { environment } = workRoot();
    const { location } = repository();
    const controller = ensureWorkDirectory(location, "controller", environment);
    const author = ensureWorkDirectory(location, "author", environment);
    writeFileSync(join(controller.path, "opening.json"), "{}\n");

    expect(removeWorkDirectory(location, "controller", environment)).toBe(
      controller.path
    );
    expect(existsSync(controller.path)).toBe(false);
    expect(existsSync(author.path)).toBe(true);
    expect(removeWorkDirectory(location, "controller", environment)).toBeNull();

    removeWorkDirectory(location, "author", environment);
    // The emptied repository directory goes too.
    expect(existsSync(dirname(author.path))).toBe(false);
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
      stdout: decoder.decode(result.stdout),
    };
  };

  test("prints a bare path before any loop and removes it on request", () => {
    const { fixture } = repository();
    const created = run(["workdir", "--agent-id", "controller"], fixture.root);
    expect(created.exitCode).toBe(0);
    const path = created.stdout.trim();
    expect(path.startsWith(process.env[WORK_ROOT_ENVIRONMENT] ?? "?")).toBe(
      true
    );
    expect(existsSync(path)).toBe(true);

    const removed = run(
      ["workdir", "remove", "--agent-id", "controller", "--json"],
      fixture.root
    );
    expect(JSON.parse(removed.stdout)).toEqual({
      agentId: "controller",
      removed: true,
      workDir: path,
    });
    expect(existsSync(path)).toBe(false);
    expect(
      run(["workdir", "tidy", "--agent-id", "controller"], fixture.root)
        .exitCode
    ).not.toBe(0);
  });

  test("loop start reports the directory and a clean finalize removes it", () => {
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
    writeFileSync(join(workDir, "opening.json"), "{}\n");

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
