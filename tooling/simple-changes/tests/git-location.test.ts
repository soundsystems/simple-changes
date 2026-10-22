import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, which } from "bun";
import {
  assertStateDestination,
  ensureStateDirectory,
  ensureStateDirectoryOf,
  verifiedGitDirectories,
} from "../../../skills/simple-changes/scripts/lib/git-location.ts";
import {
  captureInventory,
  locateRepository,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { gitAnswerIsRequired } from "../../../skills/simple-changes/scripts/lib/process.ts";
import { recordProposalAuthors } from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// Simple Changes state lives under `<common Git directory>/simple-changes`.
// One `proposal record-authors` run from a linked worktree once took the
// checkout root for the common directory and wrote a review ledger to
// `<checkout>/simple-changes`. A wrong Git answer must refuse, say what Git
// answered, and write nothing.

setDefaultTimeout(120_000);

const decoder = new TextDecoder();
const cliPath = fileURLToPath(
  new URL(
    "../../../skills/simple-changes/scripts/simple-changes.ts",
    import.meta.url
  )
);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
});

interface LinkedFixture {
  base: string;
  commit: string;
  fixture: TestRepository;
  linked: string;
  primaryGit: string;
}

const linkedFixture = (): LinkedFixture => {
  const fixture = createTestRepository();
  cleanups.push(fixture.cleanup);
  const linked = join(fixture.base, "linked");
  git(fixture.root, ["worktree", "add", "-b", "linked", linked]);
  const base = git(linked, ["rev-parse", "HEAD"]);
  writeFixture(linked, "a.txt", "a\n");
  git(linked, ["add", "a.txt"]);
  git(linked, ["commit", "-m", "Linked change"]);
  return {
    base,
    commit: git(linked, ["rev-parse", "HEAD"]),
    fixture,
    linked: realpathSync(linked),
    primaryGit: realpathSync(join(fixture.root, ".git")),
  };
};

// A Git on PATH that answers every question truthfully except
// `--git-common-dir`, whose line it replaces as FAKE_GIT_COMMON_DIR says:
// `empty`, `cut:N` (drop the last N characters), or a literal answer. While
// FAKE_GIT_EMPTY_TOKENS holds token files, a call naming FAKE_GIT_EMPTY_FLAG
// removes one and exits 0 with no output, as a lost answer looks.
const fakeGitDirectory = (): string => {
  const realGit = which("git");
  if (!realGit) {
    throw new Error("git is not on PATH");
  }
  const bin = mkdtempSync(join(tmpdir(), "simple-changes-fake-git-"));
  cleanups.push(() => rmSync(bin, { force: true, recursive: true }));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
real='${realGit}'
if [ -n "$FAKE_GIT_EMPTY_FLAG" ] && [ -d "$FAKE_GIT_EMPTY_TOKENS" ]; then
  case " $* " in
    *" $FAKE_GIT_EMPTY_FLAG "*)
      for token in "$FAKE_GIT_EMPTY_TOKENS"/*; do
        rm "$token" 2>/dev/null && exit 0
      done
      ;;
  esac
fi
case " $* " in
  *" --git-common-dir "*) ;;
  *) exec "$real" "$@" ;;
esac
[ -n "$FAKE_GIT_COMMON_DIR" ] || exec "$real" "$@"
out=$("$real" "$@") || exit $?
head=$(printf '%s\\n' "$out" | sed '$d')
last=$(printf '%s\\n' "$out" | tail -n 1)
case "$FAKE_GIT_COMMON_DIR" in
  empty) last="" ;;
  cut:*) last=$(printf '%s' "$last" | cut -c "1-$((\${#last} - \${FAKE_GIT_COMMON_DIR#cut:}))") ;;
  *) last="$FAKE_GIT_COMMON_DIR" ;;
esac
[ -n "$head" ] && printf '%s\\n' "$head"
printf '%s\\n' "$last"
`
  );
  chmodSync(join(bin, "git"), 0o755);
  return bin;
};

const recordAuthors = (
  setup: LinkedFixture,
  bin: string,
  commonDirectoryAnswer: string | null,
  environment: Record<string, string> = {}
) => {
  const result = spawnSync(
    [
      process.execPath,
      cliPath,
      "proposal",
      "record-authors",
      "--proposal",
      "17",
      "--base",
      setup.base,
      "--head",
      setup.commit,
      "--json",
      "--repo",
      setup.linked,
    ],
    {
      env: {
        ...process.env,
        FAKE_GIT_COMMON_DIR: commonDirectoryAnswer ?? "",
        ...environment,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
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

const untracked = (checkout: string): string =>
  git(checkout, [
    "status",
    "--porcelain",
    "--ignored",
    "--untracked-files=all",
  ]);

describe("the common Git directory behind Simple Changes state", () => {
  test("a linked worktree resolves to the primary checkout's Git directory", () => {
    const setup = linkedFixture();
    expect(locateRepository(setup.linked).repository.commonGitDirectory).toBe(
      setup.primaryGit
    );
    const inventory = captureInventory(setup.linked, {
      skipWorktreeStatus: true,
    });
    expect(inventory.repository.commonGitDirectory).toBe(setup.primaryGit);
    expect(inventory.repository.gitDirectory).toBe(
      realpathSync(join(setup.primaryGit, "worktrees", "linked"))
    );
    expect(
      locateRepository(setup.fixture.root).repository.commonGitDirectory
    ).toBe(setup.primaryGit);
  });

  test("record-authors from a linked worktree writes the ledger in the common Git directory", () => {
    const setup = linkedFixture();
    const bin = fakeGitDirectory();
    // The fake Git, answering truthfully, changes nothing.
    const recorded = recordAuthors(setup, bin, null);
    expect(recorded.exitCode).toBe(0);
    const ledgerPath = join(
      setup.primaryGit,
      "simple-changes",
      "review-ledger.json"
    );
    expect(JSON.parse(recorded.stdout)).toMatchObject({
      ledgerPath,
      status: "recorded",
    });
    expect(existsSync(ledgerPath)).toBe(true);
    expect(existsSync(join(setup.linked, "simple-changes"))).toBe(false);
    expect(untracked(setup.linked)).toBe("");
  });

  const refusals: [string, (setup: LinkedFixture) => string, string][] = [
    // The combined question's other answers still print, so this is an empty
    // line among them, not a lost answer.
    ["an empty answer", () => "empty", "printed no path"],
    [
      "an answer cut to a directory that is not a Git directory",
      // `<primary>/.git` less `git` resolves to the primary checkout.
      () => "cut:3",
      "is not a repository's Git directory",
    ],
    [
      "an answer cut to a path that does not exist",
      () => "cut:1",
      "which does not exist",
    ],
    ["the checkout root", (setup) => setup.linked, "named the checkout"],
    ["a relative answer naming the checkout", () => ".", "named the checkout"],
    [
      "the linked worktree's private Git directory",
      (setup) => join(setup.primaryGit, "worktrees", "linked"),
      "is not a repository's Git directory",
    ],
    [
      "another repository's Git directory",
      () => {
        const other = createTestRepository();
        cleanups.push(other.cleanup);
        return realpathSync(join(other.root, ".git"));
      },
      "does not belong to",
    ],
  ];

  for (const [name, answer, reason] of refusals) {
    test(`record-authors refuses ${name}, reports what Git answered, and writes nothing`, () => {
      const setup = linkedFixture();
      const bin = fakeGitDirectory();
      const given = answer(setup);
      const refused = recordAuthors(setup, bin, given);
      expect(refused.exitCode).toBe(4);
      const { error } = JSON.parse(refused.stderr) as { error: string };
      expect(error).toContain(reason);
      expect(error).toContain('Diagnostics: git executable "git"');
      expect(error).toContain(
        `working directory ${JSON.stringify(realpathSync(process.cwd()))}`
      );
      expect(error).toContain(`repository ${JSON.stringify(setup.linked)}`);
      expect(error).toContain("nothing was written");
      expect(error).toContain("rev-parse --git-common-dir answer");
      expect(error).toContain("rev-parse --absolute-git-dir answer");
      expect(existsSync(join(setup.linked, "simple-changes"))).toBe(false);
      expect(existsSync(join(setup.fixture.root, "simple-changes"))).toBe(
        false
      );
      expect(existsSync(join(setup.primaryGit, "simple-changes"))).toBe(false);
      if (given.startsWith("/") && existsSync(given)) {
        expect(readdirSync(given)).not.toContain("simple-changes");
      }
      expect(untracked(setup.linked)).toBe("");
      expect(untracked(setup.fixture.root)).toBe("");
    });
  }

  test("record-authors refuses a lost --show-toplevel answer and writes nothing", () => {
    const setup = linkedFixture();
    const bin = fakeGitDirectory();
    const tokens = mkdtempSync(join(tmpdir(), "simple-changes-lost-"));
    cleanups.push(() => rmSync(tokens, { force: true, recursive: true }));
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(tokens, `token-${index}`), "");
    }
    const refused = recordAuthors(setup, bin, null, {
      FAKE_GIT_EMPTY_FLAG: "--show-toplevel",
      FAKE_GIT_EMPTY_TOKENS: tokens,
    });
    expect(refused.exitCode).toBe(4);
    const { error } = JSON.parse(refused.stderr) as { error: string };
    expect(error).toContain("exited 0 without printing its answer, twice");
    expect(error).toContain(`repository ${JSON.stringify(setup.linked)}`);
    expect(existsSync(join(setup.linked, "simple-changes"))).toBe(false);
    expect(existsSync(join(setup.primaryGit, "simple-changes"))).toBe(false);
    expect(untracked(setup.linked)).toBe("");
  });

  test("a Git directory path with a line break inside it still resolves", () => {
    // Git keeps everything after `gitdir: ` but the trailing line ends, so a
    // linked worktree's `.git` file can hold a line break inside its path.
    const base = realpathSync(
      mkdtempSync(join(tmpdir(), "simple-changes-line-break-"))
    );
    cleanups.push(() => rmSync(base, { force: true, recursive: true }));
    const primary = join(base, "main\nrepository");
    mkdirSync(primary);
    git(primary, ["init", "-b", "main"]);
    git(primary, [
      "-c",
      "user.name=Simple Changes Tests",
      "-c",
      "user.email=tests@simple-changes.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Initial fixture",
    ]);
    const linked = join(base, "linked");
    git(primary, ["worktree", "add", "-b", "linked", linked]);
    const primaryGit = join(primary, ".git");
    expect(locateRepository(linked).repository.commonGitDirectory).toBe(
      primaryGit
    );
    expect(
      verifiedGitDirectories(
        linked,
        {
          commonGitDirectory: `${primaryGit}\n`,
          gitDirectory: `${join(primaryGit, "worktrees", "linked")}\n`,
        },
        linked
      ).commonGitDirectory
    ).toBe(primaryGit);
  });

  test("a state writer refuses a linked directory on its own path and writes nothing through it", () => {
    const fixture = createTestRepository();
    cleanups.push(fixture.cleanup);
    const elsewhere = join(fixture.base, "elsewhere");
    mkdirSync(elsewhere);
    const common = realpathSync(join(fixture.root, ".git"));
    mkdirSync(join(common, "simple-changes"));
    symlinkSync(
      elsewhere,
      join(common, "simple-changes", "worktree-coordination")
    );
    const worktree = join(fixture.base, "claimed");
    git(fixture.root, ["worktree", "add", "-b", "claimed", worktree]);
    const claimed = spawnSync(
      [
        process.execPath,
        cliPath,
        "worktree",
        "claim",
        "--agent-id",
        "agent-a",
        "--worktree",
        worktree,
        "--adapter",
        "claude-code",
        "--json",
        "--repo",
        fixture.root,
      ],
      { env: process.env, stderr: "pipe", stdout: "pipe" }
    );
    expect(claimed.exitCode).toBe(4);
    expect(decoder.decode(claimed.stderr)).toContain(
      "is not a plain directory, so state written through it would land somewhere else"
    );
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("a link at any depth, or an entry that cannot be inspected, refuses the directory", () => {
    const fixture = createTestRepository();
    cleanups.push(fixture.cleanup);
    const elsewhere = join(fixture.base, "elsewhere");
    mkdirSync(elsewhere);
    const common = realpathSync(join(fixture.root, ".git"));
    const state = join(common, "simple-changes");
    mkdirSync(join(state, "history"), { recursive: true });
    symlinkSync(elsewhere, join(state, "history", "run-linked"));
    expect(() =>
      ensureStateDirectory(
        common,
        join(state, "history", "run-linked", "replan-x")
      )
    ).toThrow("is not a plain directory");
    expect(readdirSync(elsewhere)).toEqual([]);
    // A directory this process may search but not list still shows the link.
    chmodSync(state, 0o300);
    try {
      expect(() =>
        ensureStateDirectory(
          common,
          join(state, "history", "run-linked", "replan-x")
        )
      ).toThrow("is not a plain directory");
      chmodSync(state, 0o000);
      expect(() =>
        ensureStateDirectory(common, join(state, "history", "run-new"))
      ).toThrow("Could not inspect");
    } finally {
      chmodSync(state, 0o700);
    }
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(() =>
      ensureStateDirectory(common, join(common, "objects", "x"))
    ).toThrow("is not inside");
    expect(() =>
      ensureStateDirectory(common, join(state, "..", "..", "outside"))
    ).toThrow("is not inside");
    const created = join(state, "history", "run-new", "replan-y");
    expect(ensureStateDirectory(common, created)).toBe(created);
    expect(ensureStateDirectoryOf(created)).toBe(created);
  });

  test("a checkout whose .git entry points at another Git directory is refused", () => {
    const setup = linkedFixture();
    const second = join(setup.fixture.base, "second");
    git(setup.fixture.root, ["worktree", "add", "-b", "second", second]);
    // Both private directories belong to the same common directory, but the
    // first checkout's `.git` file names its own, not the second's.
    expect(() =>
      verifiedGitDirectories(
        setup.linked,
        {
          commonGitDirectory: setup.primaryGit,
          gitDirectory: join(setup.primaryGit, "worktrees", "second"),
        },
        setup.linked
      )
    ).toThrow("The checkout's .git entry points at");
    expect(
      verifiedGitDirectories(
        setup.linked,
        {
          commonGitDirectory: setup.primaryGit,
          gitDirectory: join(setup.primaryGit, "worktrees", "linked"),
        },
        setup.linked
      )
    ).toEqual({
      commonGitDirectory: setup.primaryGit,
      gitDirectory: realpathSync(join(setup.primaryGit, "worktrees", "linked")),
    });
  });

  test("diagnostics quote and bound each value", () => {
    const setup = linkedFixture();
    const long = `/${"x".repeat(5000)}\u001b[31m`;
    let message = "";
    try {
      verifiedGitDirectories(
        setup.linked,
        { commonGitDirectory: long, gitDirectory: long },
        setup.linked
      );
    } catch (error) {
      ({ message } = error as Error);
    }
    expect(message).toContain("(first 240 of 5006 characters)");
    expect(message).not.toContain("\u001b");
    expect(message.length).toBeLessThan(2000);
  });

  test("a state directory that is a link out of the Git directory refuses ledger writes", () => {
    const fixture = createTestRepository();
    cleanups.push(fixture.cleanup);
    const elsewhere = join(fixture.base, "elsewhere");
    mkdirSync(elsewhere);
    const common = realpathSync(join(fixture.root, ".git"));
    symlinkSync(elsewhere, join(common, "simple-changes"));
    expect(() =>
      assertStateDestination(common, { repository: fixture.root })
    ).toThrow("is not a plain directory inside the Git directory");
    const base = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFixture(fixture.root, "b.txt", "b\n");
    git(fixture.root, ["add", "b.txt"]);
    git(fixture.root, ["commit", "-m", "Change"]);
    expect(() =>
      recordProposalAuthors({
        base,
        environment: {},
        head: git(fixture.root, ["rev-parse", "HEAD"]),
        proposalId: "17",
        repositoryPath: fixture.root,
      })
    ).toThrow("nothing was written");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("a common directory that is not a repository's Git directory refuses state writes", () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "simple-changes-not-git-"))
    );
    cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
    expect(() =>
      assertStateDestination(directory, { repository: directory })
    ).toThrow("is not a repository's Git directory");
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("lost Git answers", () => {
  const processPath = fileURLToPath(
    new URL(
      "../../../skills/simple-changes/scripts/lib/process.ts",
      import.meta.url
    )
  );

  test("only questions Git always answers are required to print", () => {
    for (const args of [
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--is-bare-repository", "--absolute-git-dir"],
      ["rev-parse", "--verify", "--quiet", "main^{commit}"],
      ["rev-parse", "HEAD"],
      ["--literal-pathspecs", "rev-parse", "HEAD"],
      ["-c", "core.quotePath=false", "rev-parse", "HEAD"],
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      ["config", "--get", "branch.main.remote"],
      ["remote", "get-url", "--all", "origin"],
      ["worktree", "list", "--porcelain"],
    ]) {
      expect([args, gitAnswerIsRequired(args)]).toEqual([args, true]);
    }
    for (const args of [
      ["rev-parse", "--symbolic-full-name", "abc"],
      ["rev-parse", "--show-superproject-working-tree"],
      ["rev-parse", "--glob=refs/simple-changes/*"],
      ["remote"],
      ["status", "--porcelain"],
      ["for-each-ref", "refs/heads"],
      ["symbolic-ref", "HEAD", "refs/heads/main"],
      ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
      ["config", "--remove-section", "branch.x"],
    ]) {
      expect([args, gitAnswerIsRequired(args)]).toEqual([args, false]);
    }
  });

  // Runs Git through process.ts in a child, so the fake Git on PATH is the
  // one it resolves, with `lost` answers to `--show-toplevel` lost first.
  const askInChild = (
    repository: string,
    lost: number,
    mode: "several" | "single"
  ) => {
    const bin = fakeGitDirectory();
    const tokens = mkdtempSync(join(tmpdir(), "simple-changes-lost-"));
    cleanups.push(() => rmSync(tokens, { force: true, recursive: true }));
    for (let index = 0; index < lost; index += 1) {
      writeFileSync(join(tokens, `token-${index}`), "");
    }
    const script = join(tokens, "..", `${tokens.split("/").at(-1)}-ask.ts`);
    cleanups.push(() => rmSync(script, { force: true }));
    writeFileSync(
      script,
      `import { runGit, runGitConcurrently } from ${JSON.stringify(processPath)};
const repository = ${JSON.stringify(repository)};
try {
  const reply = ${JSON.stringify(mode)} === "single"
    ? { single: runGit(repository, ["rev-parse", "--show-toplevel"]).stdout }
    : {
        several: runGitConcurrently(
          [0, 1, 2, 3].map(() => ({ args: ["rev-parse", "--show-toplevel"], cwd: repository }))
        ).map((result) => result.stdout),
      };
  console.log(JSON.stringify(reply));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, exitCode: error.exitCode }));
}
`
    );
    const result = spawnSync([process.execPath, script], {
      env: {
        ...process.env,
        FAKE_GIT_EMPTY_FLAG: "--show-toplevel",
        FAKE_GIT_EMPTY_TOKENS: tokens,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      remaining: readdirSync(tokens).length,
      reply: JSON.parse(decoder.decode(result.stdout)) as {
        error?: string;
        exitCode?: number;
        several?: string[];
        single?: string;
      },
    };
  };

  test("one lost answer is asked again and the real answer used", () => {
    const fixture = createTestRepository();
    cleanups.push(fixture.cleanup);
    const { remaining, reply } = askInChild(fixture.root, 1, "single");
    expect(remaining).toBe(0);
    expect(reply.single).toBe(`${fixture.root}\n`);
  });

  test("lost answers from the concurrent worker are asked again directly", () => {
    const fixture = createTestRepository();
    cleanups.push(fixture.cleanup);
    // The worker asks all four at once and every answer is lost; each is
    // then asked directly and answered.
    const { remaining, reply } = askInChild(fixture.root, 4, "several");
    expect(remaining).toBe(0);
    expect(reply.error).toBeUndefined();
    expect(reply.several).toEqual(
      Array.from({ length: 4 }, () => `${fixture.root}\n`)
    );
  });

  test("an answer lost twice refuses with a retryable error and diagnostics", () => {
    const fixture = createTestRepository();
    cleanups.push(fixture.cleanup);
    const { remaining, reply } = askInChild(fixture.root, 2, "single");
    expect(remaining).toBe(0);
    expect(reply.exitCode).toBe(4);
    expect(reply.error).toContain(
      'git "rev-parse --show-toplevel" exited 0 without printing its answer, twice'
    );
    expect(reply.error).toContain("retry the command");
    expect(reply.error).toContain('Diagnostics: git executable "git"');
    expect(reply.error).toContain(`repository ${JSON.stringify(fixture.root)}`);
  });
});
