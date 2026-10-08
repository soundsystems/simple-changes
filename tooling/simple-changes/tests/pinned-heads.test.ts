import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  authorizeWorktreeRemoval,
  executeLoopMutation,
  grantLoopOverride,
  prepareAgentWorktree,
  readLoopLease,
  retainExcludedWorktree,
  retireAbsentWorktree,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  analyzePinnedCommand,
  gitFactsFor,
  mentionsName,
  type PinnedCommandContext,
  type PinnedUnit,
} from "../../../skills/simple-changes/scripts/lib/pinned-heads.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import {
  claimWorktree,
  releaseWorktreeClaim,
  worktreeCoordinationPath,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(60_000);

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

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  return fixture;
};

const commitFixture = (
  root: string,
  relativePath: string,
  contents: string
): string => {
  writeFixture(root, relativePath, contents);
  git(root, ["add", relativePath]);
  git(root, ["commit", "-m", `Update ${relativePath}`]);
  return git(root, ["rev-parse", "HEAD"]);
};

const cliPath = fileURLToPath(
  new URL(
    "../../../skills/simple-changes/scripts/simple-changes.ts",
    import.meta.url
  )
);
const decoder = new TextDecoder();

const runCli = (
  cwd: string,
  args: string[]
): { exitCode: number | null; stderr: string; stdout: string } => {
  const result = spawnSync([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

const rejection = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the command to be refused.");
};

const nextCommands = (message: string): string[] =>
  message
    .split("\n")
    .filter((line) => line.trim().startsWith("Next: "))
    .map((line) => line.trim().slice("Next: ".length));

// Runs a printed `simple-changes ...` line as written.
const runPrinted = (cwd: string, command: string) =>
  runCli(cwd, command.split(" ").slice(1));

// Runs each step after the previous one finishes, in order.
const inSequence = <T, R>(
  items: readonly T[],
  step: (item: T) => Promise<R>
): Promise<R[]> =>
  items.reduce<Promise<R[]>>(
    async (previous, item) => [...(await previous), await step(item)],
    Promise.resolve([])
  );

const RUN_ID_PATTERN = /^run-/u;

const commitOnTop = (root: string, parent: string, message: string): string =>
  git(root, ["commit-tree", `${parent}^{tree}`, "-p", parent, "-m", message]);

describe("pinned-head command analysis", () => {
  const analyzer = () => {
    const fixture = repository();
    const { root } = fixture;
    const base = git(root, ["rev-parse", "HEAD"]);
    const unitPath = join(fixture.base, "unit");
    git(root, ["worktree", "add", "-b", "feat/x", unitPath]);
    const head = commitFixture(unitPath, "unit.ts", "export const unit = 1;\n");
    git(root, ["branch", "feat/x-2", head]);
    git(root, ["branch", "other", base]);
    git(root, ["remote", "add", "origin", join(fixture.base, "remote.git")]);
    git(root, ["update-ref", "refs/remotes/origin/feat/x", head]);
    git(root, ["update-ref", "refs/remotes/origin/stale/feat/y", base]);
    git(root, ["symbolic-ref", "refs/heads/al", "refs/heads/feat/x"]);
    const unit: PinnedUnit = {
      branch: "feat/x",
      owner: "author-a",
      path: unitPath,
      recordedHeads: [head],
      state: "released",
    };
    const inventory = captureInventory(root);
    const context = (pins: PinnedUnit[] = [unit]): PinnedCommandContext => ({
      checkout: root,
      facts: gitFactsFor(root, inventory.repository.commonGitDirectory),
      pins,
      worktreePaths: inventory.worktrees.map((worktree) => worktree.path),
    });
    const analyze = (argv: string[], pins?: PinnedUnit[]) =>
      analyzePinnedCommand(argv, context(pins));
    const kinds = (argv: string[]) =>
      [...new Set(analyze(argv).refusals.map((item) => item.kind))].sort();
    return { analyze, base, head, kinds, root, unit, unitPath };
  };

  test("matches a branch name in every ref form and letter case, and nothing longer", () => {
    for (const text of [
      "feat/x",
      "refs/heads/feat/x",
      "heads/feat/x",
      "origin/feat/x",
      "refs/remotes/origin/feat/x",
      "feat/x~0",
      "feat/x^{commit}",
      "main..feat/x",
      "^feat/x",
      "+feat/x:refs/heads/main",
      "--onto=feat/x",
      "FEAT/X",
      "Merge feat/x into main",
    ]) {
      expect({ matches: mentionsName(text, "feat/x"), text }).toEqual({
        matches: true,
        text,
      });
    }
    for (const text of ["feat/x-2", "feat/xy", "prefix-feat/x", "afeat/x"]) {
      expect({ matches: mentionsName(text, "feat/x"), text }).toEqual({
        matches: false,
        text,
      });
    }
    expect(mentionsName("-sfeat/x", "feat/x")).toBe(false);
    expect(mentionsName("-sfeat/x", "feat/x", true)).toBe(true);
  });

  test("refuses merge-like commands that name a pinned branch, however spelled", () => {
    const { kinds } = analyzer();
    for (const argv of [
      ["git", "merge", "feat/x"],
      ["git", "merge", "--ff-only", "refs/heads/feat/x"],
      ["git", "merge", "heads/feat/x"],
      ["git", "merge", "origin/feat/x"],
      ["git", "merge", "refs/remotes/origin/feat/x"],
      ["git", "merge", "feat/x~0"],
      ["git", "merge", "FEAT/X"],
      ["git", "merge", "al"],
      ["git", "cherry-pick", "main..feat/x"],
      ["git", "rebase", "--onto=feat/x", "main"],
      ["git", "rebase", "-x", "git merge feat/x", "main"],
      ["git", "restore", "-sfeat/x", "--", "."],
      ["git", "checkout", "feat/x", "--", "."],
      ["git", "reset", "--hard", "feat/x"],
      ["git", "update-ref", "refs/heads/main", "feat/x"],
      ["git", "branch", "copy", "feat/x"],
      ["git", "branch", "-f", "-d", "-m", "feat/x", "copy"],
      ["git", "tag", "copy", "feat/x"],
      ["git", "worktree", "add", "../copy", "feat/x"],
      ["git", "pull", ".", "feat/x"],
      ["git", "push", "origin", "feat/x"],
      ["git", "push", "origin", "feat/x:refs/heads/main"],
      ["git", "push", "-o", "-d", "origin", "feat/x"],
      ["git", "fetch", ".", "feat/x:main"],
      ["git", "merge", "-X", "-m", "feat/x"],
      ["git", "merge", "--strat", "ours", "-m", "feat/x"],
      ["git", "merge", "--", "-m", "feat/x"],
      [
        "git",
        "-c",
        "remote.origin.push=refs/heads/feat/x:refs/heads/main",
        "push",
      ],
      ["git", "replay", "--onto", "main", "feat/x"],
    ]) {
      expect({ argv, kinds: kinds(argv) }).toEqual({
        argv,
        kinds: expect.arrayContaining(["named"]),
      });
    }
  });

  test("refuses indirect names that could resolve to a pinned branch", () => {
    const { kinds } = analyzer();
    for (const argv of [
      ["git", "merge", "FETCH_HEAD"],
      ["git", "merge", "-"],
      ["git", "merge", "@{u}"],
      ["git", "merge", "main@{1}"],
      ["git", "merge", ":/Update unit"],
      ["git", "merge", "worktrees/unit/HEAD"],
      ["git", "merge", "main-worktree/HEAD"],
      ["git", "cherry-pick", "--branches"],
      ["git", "cherry-pick", "--all", "^main"],
      ["git", "update-ref", "--stdin"],
      ["git", "fetch", "--stdin"],
      ["git", "push", "--all", "origin"],
      ["git", "push", "--mirror", "origin"],
      ["git", "push", "origin", ":"],
      ["git", "push", "origin", "refs/heads/*:refs/heads/*"],
      ["git", "fetch", ".", "refs/heads/*:refs/heads/*"],
    ]) {
      expect({ argv, kinds: kinds(argv) }).toEqual({
        argv,
        kinds: expect.arrayContaining(["indirect"]),
      });
    }
  });

  test("refuses commands that run in or read from a pinned checkout", () => {
    const { head, kinds, unitPath } = analyzer();
    for (const argv of [
      ["git", "-C", unitPath, "push", "origin", "HEAD:refs/heads/main"],
      ["git", "-C", unitPath, "merge", "--ff-only", head],
      ["git", "-C", join(unitPath, "sub"), "reset", "--hard", "HEAD"],
      ["git", "fetch", unitPath, "HEAD:refs/heads/main"],
      ["git", "fetch", `file://${unitPath}`, "HEAD:refs/heads/main"],
      ["git", "pull", unitPath],
      ["git", "--git-dir=.git", "merge", head],
      ["git", "--work-tree", unitPath, "merge", head],
    ]) {
      expect({ argv, kinds: kinds(argv) }).toEqual({
        argv,
        kinds: expect.arrayContaining(["checkout"]),
      });
    }
  });

  test("attributes a path to the deepest checkout that contains it", () => {
    const { analyze, head, root } = analyzer();
    const nestedPath = join(root, ".worktrees", "nested");
    git(root, ["worktree", "add", "-b", "feat/nested", nestedPath]);
    const nested: PinnedUnit = {
      branch: "feat/nested",
      owner: null,
      path: nestedPath,
      recordedHeads: [git(root, ["rev-parse", "feat/nested"])],
      state: "preserved",
    };
    const inventory = captureInventory(root);
    const kinds = (argv: string[]) =>
      analyzePinnedCommand(argv, {
        checkout: root,
        facts: gitFactsFor(root, inventory.repository.commonGitDirectory),
        pins: [nested],
        worktreePaths: inventory.worktrees.map((worktree) => worktree.path),
      }).refusals.map((item) => item.kind);
    expect(kinds(["git", "fetch", ".worktrees/nested", "HEAD:main"])).toEqual([
      "checkout",
    ]);
    expect(
      kinds(["git", "-C", ".worktrees/nested", "merge", "--ff-only", head])
    ).toEqual(["checkout"]);
    expect(kinds(["git", "fetch", ".", "HEAD:refs/heads/elsewhere"])).toEqual(
      []
    );
    expect(kinds(["git", "-C", root, "merge", "--ff-only", head])).toEqual([]);
    expect(analyze(["git", "merge", "--ff-only", head]).refusals).toEqual([]);
  });

  test("refuses aliases, configured stand-ins, replace refs, and wrapped Git", () => {
    const { head, kinds, root, unitPath } = analyzer();
    git(root, ["config", "alias.mff", "merge --ff-only"]);
    expect(kinds(["git", "mff", head])).toEqual(["alias"]);
    expect(kinds(["git", "-c", "alias.zz=merge", "zz", head])).toEqual([
      "alias",
    ]);
    // Git ignores an alias that shadows a builtin.
    git(root, ["config", "alias.merge", "merge feat/x"]);
    expect(kinds(["git", "merge", "--ff-only", head])).toEqual([]);

    git(root, ["branch", "--set-upstream-to=feat/x", "main"]);
    for (const argv of [
      ["git", "merge"],
      ["git", "merge", "--ff-only"],
      ["git", "merge", "--ff-only", "-m", head],
      ["git", "merge", "--unknown", head],
      ["git", "pull"],
      ["git", "pull", "--ff-only", "."],
      ["git", "rebase"],
      ["git", "rebase", head],
    ]) {
      expect({ argv, kinds: kinds(argv) }).toEqual({
        argv,
        kinds: ["configured"],
      });
    }
    expect(kinds(["git", "merge", "--ff-only", head])).toEqual([]);
    expect(kinds(["git", "merge", "--abort"])).toEqual([]);
    git(root, ["branch", "--unset-upstream", "main"]);
    expect(kinds(["git", "merge"])).toEqual([]);

    expect(kinds(["git", "-c", "push.default=matching", "push"])).toEqual([
      "configured",
    ]);
    expect(
      kinds(["git", "-c", "push.default=matching", "push", "--unknown", "x"])
    ).toEqual(["configured"]);
    // An option it does not know may take the next argument as its value.
    expect(
      kinds([
        "git",
        "-c",
        "push.default=matching",
        "push",
        "--unknown",
        "origin",
        `${head}:refs/heads/elsewhere`,
      ])
    ).toEqual(["configured"]);
    expect(
      kinds([
        "git",
        "-c",
        "push.default=matching",
        "push",
        "origin",
        `${head}:refs/heads/elsewhere`,
      ])
    ).toEqual([]);
    expect(
      kinds(["git", "-c", "remote.origin.push=refs/heads/*:refs/for/*", "push"])
    ).toEqual(["configured"]);
    expect(
      kinds(["git", "-c", `remote.u.url=${unitPath}`, "fetch", "u"])
    ).toEqual(["configured"]);

    git(root, ["replace", head, "HEAD"]);
    expect(kinds(["git", "merge", "--ff-only", head])).toEqual(["replaced"]);
    git(root, ["replace", "-d", head]);
    expect(kinds(["git", "merge", "--ff-only", head])).toEqual([]);

    for (const argv of [
      ["sh", "-c", "git merge feat/x"],
      ["env", "LC_ALL=C", "git", "merge", "feat/x"],
      ["sh", "-c", `cd ${unitPath} && git push origin HEAD:main`],
      ["sh", "-c", "git merge FETCH_HEAD"],
      ["xargs", "git", "merge", "al"],
    ]) {
      expect({ argv, kinds: kinds(argv) }).toEqual({
        argv,
        kinds: ["wrapped"],
      });
    }
    expect(kinds(["git", "--exec-path=/tmp", "merge", head])).toEqual([
      "unclassified",
    ]);
  });

  test("lets every other command through, including the recorded-commit form", () => {
    const { analyze, head, kinds, root, unitPath } = analyzer();
    for (const argv of [
      ["git", "merge", "--ff-only", head],
      ["git", "merge", "--no-ff", "-m", "Merge branch 'feat/x'", head],
      ["git", "merge", "--no-ff", "-mMerge feat/x", head],
      ["git", "merge", "--no-ff", "--message=Merge feat/x", head],
      ["git", "merge", "--ff-only", "feat/x-2"],
      ["git", "merge", "other"],
      ["git", "-C", root, "merge", "--ff-only", head],
      ["git", "cherry-pick", head],
      ["git", "log", "feat/x"],
      ["git", "diff", "main..feat/x"],
      ["git", "commit", "--allow-empty", "-m", "Mentions feat/x"],
      ["git", "status"],
      ["git", "push", "origin", `${head}:refs/heads/feat/x`],
      [
        "git",
        "push",
        `--force-with-lease=refs/heads/feat/x:${head}`,
        "origin",
        `${head}:refs/heads/feat/x`,
      ],
      ["git", "push", "origin", "--delete", "feat/x"],
      ["git", "push", "origin", ":refs/heads/feat/x"],
      ["git", "fetch", "origin", "feat/x"],
      ["git", "fetch", "--all"],
      ["git", "fetch", "https://example.invalid/repo.git", "main"],
      ["git", "branch", "-d", "feat/x"],
      ["git", "branch", "-D", "-r", "origin/feat/x"],
      ["git", "worktree", "remove", unitPath],
      ["git", "mktag"],
      ["bun", "-e", "console.log('feat/x')"],
      ["sh", "-c", "git status"],
    ]) {
      expect({ argv, kinds: kinds(argv) }).toEqual({ argv, kinds: [] });
    }
    // Nothing is pinned: nothing is refused.
    expect(analyze(["git", "merge", "feat/x"], []).refusals).toEqual([]);
  });

  test("prints a replacement only when it is certainly equivalent", () => {
    const { analyze, base, head, root, unitPath } = analyzer();
    const equivalent = (argv: string[]) => analyze(argv).equivalent;
    expect(equivalent(["git", "merge", "--ff-only", "feat/x"])).toEqual([
      "git",
      "merge",
      "--ff-only",
      head,
    ]);
    expect(
      equivalent([
        "git",
        "-C",
        root,
        "merge",
        "-q",
        "--ff-only",
        "heads/feat/x",
      ])
    ).toEqual(["git", "-C", root, "merge", "-q", "--ff-only", head]);
    // A symbolic ref to the pinned branch resolves to the same commit.
    expect(equivalent(["git", "merge", "--ff-only", "al"])).toEqual([
      "git",
      "merge",
      "--ff-only",
      head,
    ]);
    expect(equivalent(["git", "cherry-pick", "-x", "feat/x"])).toEqual([
      "git",
      "cherry-pick",
      "-x",
      head,
    ]);
    expect(equivalent(["git", "reset", "--hard", "refs/heads/feat/x"])).toEqual(
      ["git", "reset", "--hard", head]
    );
    for (const argv of [
      ["git", "merge", "feat/x"],
      ["git", "merge", "--no-ff", "feat/x"],
      ["git", "merge", "--ff-only", "--no-ff", "feat/x"],
      ["git", "merge", "-m", "--ff-only", "feat/x"],
      ["git", "merge", "--ff-only", "--squash", "feat/x"],
      ["git", "merge", "--ff-only", "--unknown", "feat/x"],
      ["git", "merge", "--ff-only", "feat/x~0"],
      ["git", "cherry-pick", "main..feat/x"],
      ["git", "push", "origin", "feat/x"],
      ["git", "-c", "x.y=feat/x", "merge", "--ff-only", head],
      ["git", "merge", "--ff-only", "feat/x", "FETCH_HEAD"],
      ["git", "-C", unitPath, "merge", "--ff-only", "feat/x"],
    ]) {
      expect({ argv, equivalent: equivalent(argv) }).toEqual({
        argv,
        equivalent: null,
      });
    }
    // A remote-tracking branch is replaced only while it holds the
    // recorded head itself.
    expect(equivalent(["git", "merge", "--ff-only", "origin/feat/x"])).toEqual([
      "git",
      "merge",
      "--ff-only",
      head,
    ]);
    git(root, ["update-ref", "refs/remotes/origin/feat/x", base]);
    expect(
      equivalent(["git", "merge", "--ff-only", "origin/feat/x"])
    ).toBeNull();
  });
});

// The guard plays the third party: while loop exec waits on it, another
// agent claims the released checkout and commits there.
const RACE_GUARD = `import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(process.env.PIN_TEST_RECORD, JSON.stringify(argv) + "\\n");
const target = process.env.PIN_TEST_RACE_PATH;
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: target, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(9);
  }
};
if (target && argv.includes("merge")) {
  run(process.execPath, [
    process.env.PIN_TEST_CLI,
    "worktree",
    "claim",
    "--agent-id",
    "third-party",
    "--worktree",
    target,
    "--adapter",
    "codex",
    "--repo",
    target,
  ]);
  writeFileSync(join(target, "third-party.ts"), "export const late = 1;\\n");
  run("git", ["add", "third-party.ts"]);
  run("git", ["commit", "-m", "Third-party commit during the merge"]);
}
process.exit(0);
`;

const guardedRepository = () => {
  const fixture = repository();
  writeFixture(fixture.root, "scripts/race-guard.ts", RACE_GUARD);
  writeFixture(
    fixture.root,
    ".simple-changes.json",
    `${JSON.stringify(
      {
        ...DEFAULT_POLICY,
        execGuard: [process.execPath, "scripts/race-guard.ts"],
      },
      null,
      2
    )}\n`
  );
  git(fixture.root, ["add", "."]);
  git(fixture.root, ["commit", "-m", "Add policy and race guard"]);
  const recordPath = join(fixture.base, "guard-record.jsonl");
  setEnvironment("PIN_TEST_RECORD", recordPath);
  setEnvironment("PIN_TEST_CLI", cliPath);
  const guardRuns = (): string[][] =>
    existsSync(recordPath)
      ? readFileSync(recordPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
  return { ...fixture, guardRuns };
};

// An author claims a checkout, the loop starts, and the author commits and
// releases, recording that exact head.
const releasedUnit = (
  fixture: TestRepository,
  name: string
): { head: string; path: string; runId: string } => {
  const path = join(fixture.base, name);
  git(fixture.root, ["worktree", "add", "-b", `feat/${name}`, path]);
  const claim = claimWorktree(fixture.root, "author-a", path, "codex");
  const lease = startLoop(fixture.root, "controller", "ship");
  const head = commitFixture(path, `${name}.ts`, "export const done = 1;\n");
  releaseWorktreeClaim(path, "author-a", claim.claimId);
  expect(verifyLoop(fixture.root).ok).toBe(true);
  return { head, path, runId: lease.runId };
};

describe("pinned heads in loop exec", () => {
  test("the round-10 race: a name is refused, and the recorded commit is exactly what merges", async () => {
    const fixture = guardedRepository();
    const { head, path, runId } = releasedUnit(fixture, "released");
    const target = git(fixture.root, ["rev-parse", "main"]);

    const refused = await rejection(
      executeLoopMutation(fixture.root, runId, "controller", [
        "git",
        "merge",
        "--ff-only",
        "feat/released",
      ])
    );
    expect(refused).toContain(
      "No merge-like `loop exec` command can integrate a commit other than a registered unit's recorded head"
    );
    expect(refused).toContain(
      `- it names pinned branch feat/released of ${path} (released by author-a), recorded at ${head}.`
    );
    expect(nextCommands(refused)).toEqual([
      `simple-changes loop exec --run-id ${runId} --agent-id controller --repo ${fixture.root} -- git merge --ff-only ${head}`,
    ]);
    // Refused before the guard: the third party never ran, nothing moved.
    expect(fixture.guardRuns()).toEqual([]);
    expect(git(fixture.root, ["rev-parse", "main"])).toBe(target);

    // The recorded form runs the guard, during which the third party claims
    // the released checkout and commits; the merge still takes only the
    // recorded commit, and closing verification reports the takeover.
    setEnvironment("PIN_TEST_RACE_PATH", path);
    const closing = await rejection(
      executeLoopMutation(fixture.root, runId, "controller", [
        "git",
        "merge",
        "--ff-only",
        head,
      ])
    );
    expect(fixture.guardRuns()).toEqual([["git", "merge", "--ff-only", head]]);
    expect(closing).toContain(
      `detected a manifest violation after mutation: coordination-claim-stale:${path}`
    );
    const late = git(fixture.root, ["rev-parse", "feat/released"]);
    expect(late).not.toBe(head);
    expect(git(fixture.root, ["rev-parse", "main"])).toBe(head);
    expect(
      spawnSync([
        "git",
        "-C",
        fixture.root,
        "merge-base",
        "--is-ancestor",
        late,
        "main",
      ]).exitCode
    ).toBe(1);
    // The merge gate reports the moved checkout once, as the stale claim.
    expect(
      verifyLoop(fixture.root, { forMerge: true }).violations.map(
        (violation) => violation.code
      )
    ).toEqual(["coordination-claim-stale"]);
  });

  test("a branch that moved without its checkout is refused with its recovery, and verify --for merge flags it", async () => {
    const fixture = repository();
    const { head, path, runId } = releasedUnit(fixture, "gone");
    git(fixture.root, ["worktree", "remove", path]);
    const moved = commitOnTop(fixture.root, head, "Third-party commit");
    git(fixture.root, ["update-ref", "refs/heads/feat/gone", moved]);
    // The checkout is gone, so ordinary verification has nothing to compare.
    expect(verifyLoop(fixture.root).ok).toBe(true);

    const merge = verifyLoop(fixture.root, { forMerge: true });
    expect(merge.ok).toBe(false);
    expect(merge.violations).toEqual([
      expect.objectContaining({
        code: "registered-branch-moved",
        headSha: moved,
        nextCommands: [
          `Restore the checkout at ${path} on branch feat/gone, then re-run \`simple-changes loop verify --run-id ${runId} --repo ${fixture.root}\` for its exact recovery steps.`,
        ],
        path,
      }),
    ]);
    expect(merge.violations[0]?.message).toContain(
      `moved from its recorded head ${head} to ${moved}`
    );

    const refused = await rejection(
      executeLoopMutation(fixture.root, runId, "controller", [
        "git",
        "merge",
        "--ff-only",
        "feat/gone",
      ])
    );
    expect(refused).toContain(
      `has moved from its recorded head ${head} to ${moved}. Name ${head} to integrate the recorded commit`
    );
    expect(nextCommands(refused)).toEqual(
      merge.violations[0]?.nextCommands ?? []
    );

    await executeLoopMutation(fixture.root, runId, "controller", [
      "git",
      "merge",
      "--ff-only",
      head,
    ]);
    expect(git(fixture.root, ["rev-parse", "main"])).toBe(head);
  });

  test("verify --for merge holds an unclaimed stable checkout's branch, and the printed recovery clears it", () => {
    const fixture = repository();
    const path = join(fixture.base, "stable");
    git(fixture.root, ["worktree", "add", "-b", "feat/stable", path]);
    const head = commitFixture(path, "stable.ts", "export const stable = 1;\n");
    const lease = startLoop(fixture.root, "controller", "ship");
    // The checkout moves to another branch at the same commit, which leaves
    // ordinary verification clean, and then its branch moves.
    git(path, ["switch", "-c", "parked"]);
    const moved = commitOnTop(fixture.root, head, "Moved branch");
    git(fixture.root, ["update-ref", "refs/heads/feat/stable", moved]);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    const merge = verifyLoop(fixture.root, { forMerge: true });
    expect(merge.violations.map((violation) => violation.code)).toEqual([
      "registered-branch-moved",
    ]);
    const steps = merge.violations[0]?.nextCommands ?? [];
    expect(steps.map((step) => step.split(" ").slice(0, 3).join(" "))).toEqual([
      "simple-changes worktree claim",
      "simple-changes worktree pause",
      "simple-changes loop accept-paused-change",
    ]);

    const fill: Record<string, string> = {
      "<adapter>": "codex",
      "<owner>": "stable-owner",
      "<why>": "Record-the-moved-unit",
    };
    let receipt = "";
    for (const step of steps) {
      const args = step
        .split(" ")
        .slice(1)
        .map((word) =>
          word === "<pause-receipt-id>" ? receipt : (fill[word] ?? word)
        );
      const result = runCli(fixture.root, [...args, "--json"]);
      expect({ stderr: result.stderr, step }).toEqual({ stderr: "", step });
      if (args[1] === "pause") {
        receipt = (JSON.parse(result.stdout) as { receiptId: string })
          .receiptId;
      }
    }
    expect(verifyLoop(fixture.root, { forMerge: true }).ok).toBe(true);
    expect(
      readLoopLease(fixture.root)?.worktrees.find(
        (worktree) => worktree.path === path
      )
    ).toMatchObject({ baselineHeadSha: head, branch: "parked" });
    expect(lease.runId).toMatch(RUN_ID_PATTERN);
  });

  test("leaves the controller, its prepared authors, and unrelated commands alone", async () => {
    const fixture = repository();
    const { head, runId } = releasedUnit(fixture, "pinned");
    const author = prepareAgentWorktree(
      fixture.root,
      runId,
      "author-1",
      "prepared work"
    );
    const authored = commitFixture(
      author.path,
      "authored.ts",
      "export const authored = 1;\n"
    );
    const results = await inSequence(
      [
        ["git", "merge", "--ff-only", author.branch],
        ["git", "status"],
        ["git", "log", "--oneline", "feat/pinned"],
        ["git", "commit", "--allow-empty", "-m", "Mentions feat/pinned"],
        [process.execPath, "-e", "console.log('feat/pinned')"],
        ["git", "merge", "--no-ff", "-m", "Merge branch 'feat/pinned'", head],
      ],
      async (argv) => ({
        argv,
        exitCode: (
          await executeLoopMutation(fixture.root, runId, "controller", argv)
        ).result.exitCode,
      })
    );
    for (const result of results) {
      expect(result).toEqual({ argv: result.argv, exitCode: 0 });
    }
    expect(
      spawnSync([
        "git",
        "-C",
        fixture.root,
        "merge-base",
        "--is-ancestor",
        authored,
        "main",
      ]).exitCode
    ).toBe(0);
  });

  test("the printed replacement does exactly what the refused command would have done", async () => {
    const fixture = repository();
    const { head, runId } = releasedUnit(fixture, "equal");
    // Diverge the target, so the cherry-pick creates a commit.
    commitFixture(fixture.root, "target.ts", "export const target = 1;\n");
    const twin = join(fixture.base, "twin");
    git(fixture.base, ["clone", "--quiet", fixture.root, twin]);
    git(twin, ["config", "user.name", "Simple Changes Tests"]);
    git(twin, ["config", "user.email", "tests@simple-changes.invalid"]);
    git(twin, ["branch", "feat/equal", head]);
    for (const [name, value] of [
      ["GIT_AUTHOR_DATE", "2026-10-08T12:00:00Z"],
      ["GIT_COMMITTER_DATE", "2026-10-08T12:00:00Z"],
    ] as const) {
      setEnvironment(name, value);
    }
    await inSequence(
      [
        ["git", "cherry-pick", "feat/equal"],
        ["git", "reset", "--hard", "feat/equal"],
      ],
      async (argv) => {
        const refused = await rejection(
          executeLoopMutation(fixture.root, runId, "controller", argv)
        );
        const [printed] = nextCommands(refused);
        expect(printed).toEndWith(`-- ${argv.slice(0, -1).join(" ")} ${head}`);
        expect(runPrinted(fixture.root, printed ?? "").exitCode).toBe(0);
        // Bun's spawnSync reads the environment from process start, so pass
        // the fixed dates explicitly.
        expect(
          spawnSync(["git", "-C", twin, ...argv.slice(1)], {
            env: { ...process.env },
          }).exitCode
        ).toBe(0);
        expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(
          git(twin, ["rev-parse", "HEAD"])
        );
      }
    );
  });

  test("the CLI prints the refusal and the merge gate with their next steps", () => {
    const fixture = repository();
    const { head, path, runId } = releasedUnit(fixture, "cli");
    git(fixture.root, ["worktree", "remove", path]);
    const moved = commitOnTop(fixture.root, head, "Moved");
    git(fixture.root, ["update-ref", "refs/heads/feat/cli", moved]);

    const exec = runCli(fixture.root, [
      "loop",
      "exec",
      "--run-id",
      runId,
      "--agent-id",
      "controller",
      "--",
      "git",
      "merge",
      "--ff-only",
      "feat/cli",
    ]);
    expect(exec.exitCode).toBe(5);
    expect(exec.stderr).toContain(`has moved from its recorded head ${head}`);
    expect(exec.stderr).toContain("Next: Restore the checkout at");

    const plain = runCli(fixture.root, ["loop", "verify", "--run-id", runId]);
    expect(plain.exitCode).toBe(0);
    const gate = runCli(fixture.root, [
      "loop",
      "verify",
      "--run-id",
      runId,
      "--for",
      "merge",
      "--local-only",
    ]);
    expect(gate.exitCode).toBe(5);
    expect(gate.stdout).toContain(`- registered-branch-moved: ${path}`);
    expect(gate.stdout).toContain(`Next: Restore the checkout at ${path}`);
  });

  test("a release that recorded no state pins its branch without a head to integrate", async () => {
    const fixture = repository();
    const { head, path, runId } = releasedUnit(fixture, "legacy");
    // An older client's release writes a plain event, so it records nothing.
    const coordinationPath = worktreeCoordinationPath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const document = JSON.parse(readFileSync(coordinationPath, "utf8")) as {
      events: { eventId: string; state: string }[];
    };
    for (const event of document.events) {
      if (event.state === "released") {
        event.eventId = "event-legacy-release";
      }
    }
    writeFileSync(coordinationPath, `${JSON.stringify(document)}\n`);
    git(fixture.root, ["worktree", "remove", path]);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    const refused = await rejection(
      executeLoopMutation(fixture.root, runId, "controller", [
        "git",
        "merge",
        "--ff-only",
        "feat/legacy",
      ])
    );
    expect(refused).toContain(
      `feat/legacy of ${path} (registered without a recorded release by author-a) has no recorded head. Record its current state first:`
    );
    expect(refused).not.toContain(head);
    expect(nextCommands(refused)).toEqual([
      `Restore the checkout at ${path} on branch feat/legacy, then re-run \`simple-changes loop verify --run-id ${runId} --repo ${fixture.root}\` for its exact recovery steps.`,
    ]);
  });
});

describe("the merge gate's scope", () => {
  test("an approved override records the newer head of a preserved checkout", async () => {
    const fixture = repository();
    const path = join(fixture.base, "approved");
    git(fixture.root, ["worktree", "add", "-b", "feat/approved", path]);
    commitFixture(path, "approved.ts", "export const approved = 1;\n");
    const { runId } = startLoop(fixture.root, "controller", "integrate");
    const newer = commitFixture(
      path,
      "approved.ts",
      "export const approved = 2;\n"
    );
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === path
    );
    grantLoopOverride(
      fixture.root,
      runId,
      "controller",
      path,
      current?.changeDigest ?? "",
      "user",
      "Include the newer commit."
    );
    expect(verifyLoop(fixture.root, { forMerge: true }).ok).toBe(true);
    const refused = await rejection(
      executeLoopMutation(fixture.root, runId, "controller", [
        "git",
        "merge",
        "--ff-only",
        "feat/approved",
      ])
    );
    expect(nextCommands(refused)).toEqual([
      `simple-changes loop exec --run-id ${runId} --agent-id controller --repo ${fixture.root} -- git merge --ff-only ${newer}`,
    ]);
  });

  test("holds neither a retained nor a retired unit's branch, though loop exec still pins both", async () => {
    const fixture = repository();
    const retiredPath = join(fixture.base, "retired");
    git(fixture.root, ["worktree", "add", "-b", "feat/retired", retiredPath]);
    const retiredHead = commitFixture(
      retiredPath,
      "retired.ts",
      "export const retired = 1;\n"
    );
    const { runId } = startLoop(fixture.root, "controller", "integrate");
    const keptPath = join(fixture.base, "kept");
    git(fixture.root, ["worktree", "add", "-b", "feat/kept", keptPath]);
    const kept = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === keptPath
    );
    retainExcludedWorktree(
      fixture.root,
      runId,
      "controller",
      keptPath,
      kept?.changeDigest ?? "",
      "user",
      "Keep this checkout out of the shipment."
    );
    git(keptPath, ["switch", "-c", "parked-kept"]);
    const keptHead = kept?.headSha ?? "";
    git(fixture.root, [
      "update-ref",
      "refs/heads/feat/kept",
      commitOnTop(fixture.root, keptHead, "Moved retained"),
    ]);
    git(fixture.root, ["worktree", "remove", retiredPath]);
    retireAbsentWorktree(
      fixture.root,
      runId,
      "controller",
      retiredPath,
      "user",
      "Its owner removed it."
    );
    git(fixture.root, [
      "update-ref",
      "refs/heads/feat/retired",
      commitOnTop(fixture.root, retiredHead, "Moved retired"),
    ]);
    expect(verifyLoop(fixture.root, { forMerge: true }).violations).toEqual([]);
    const refusals = await inSequence(["feat/kept", "feat/retired"], (branch) =>
      rejection(
        executeLoopMutation(fixture.root, runId, "controller", [
          "git",
          "merge",
          "--ff-only",
          branch,
        ])
      )
    );
    expect(refusals[0]).toContain(`feat/kept of ${keptPath} (retained)`);
    expect(refusals[1]).toContain(`feat/retired of ${retiredPath} (preserved)`);
  });

  test("a disposed checkout is removed through loop exec and its branch is no longer held", async () => {
    const fixture = repository();
    const donePath = join(fixture.base, "done");
    git(fixture.root, ["worktree", "add", "-b", "feat/done", donePath]);
    const { runId } = startLoop(fixture.root, "controller", "integrate");
    const done = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === donePath
    );
    authorizeWorktreeRemoval(
      fixture.root,
      runId,
      "controller",
      donePath,
      done?.changeDigest ?? "",
      "user",
      "Contained in the target."
    );
    await executeLoopMutation(fixture.root, runId, "controller", [
      "git",
      "worktree",
      "remove",
      donePath,
    ]);
    git(fixture.root, [
      "update-ref",
      "refs/heads/feat/done",
      commitOnTop(fixture.root, done?.headSha ?? "", "Moved disposed"),
    ]);
    expect(verifyLoop(fixture.root, { forMerge: true }).violations).toEqual([]);
  });
});
