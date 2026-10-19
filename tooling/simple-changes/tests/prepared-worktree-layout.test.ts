import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "bun";
import {
  prepareAgentWorktree,
  readLoopLease,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  createTestRepository,
  git,
  legacyPreparedWorktreePath,
  prepareLegacyLayoutAgentWorktree,
  type TestRepository,
} from "./helpers.ts";

let repositories: TestRepository[] = [];
setDefaultTimeout(60_000);

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const activeRun = () => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  const lease = startLoop(fixture.root, "controller", "integrate");
  return { ...fixture, lease, runSlug: lease.runId.slice(4, 16) };
};

// Written out rather than computed, so the expectation does not depend on
// the code under test.
const flatPath = (
  fixture: ReturnType<typeof activeRun>,
  purpose: string,
  agent: string
): string =>
  join(
    fixture.base,
    `.simple-changes-repo--${fixture.runSlug}--${purpose}--${agent}`
  );

const branchExists = (root: string, branch: string): boolean =>
  spawnSync([
    "git",
    "-C",
    root,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).exitCode === 0;

describe("prepared worktree layout", () => {
  test("creates the worktree directly beside the primary and no other directory", () => {
    const fixture = activeRun();
    expect(readdirSync(fixture.base)).toEqual(["repo"]);
    const prepared = prepareAgentWorktree(
      fixture.root,
      fixture.lease.runId,
      "author",
      "layout"
    );
    const expected = flatPath(fixture, "layout", "author");
    expect(prepared.path).toBe(expected);
    expect(prepared.created).toBe(true);
    expect(prepared.branch).toBe(
      `simple-changes/layout-author-${fixture.runSlug}`
    );
    expect(readdirSync(fixture.base).sort()).toEqual(
      [basename(expected), "repo"].sort()
    );
    expect(existsSync(join(fixture.base, ".simple-changes-worktrees"))).toBe(
      false
    );
    expect(git(prepared.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      prepared.branch
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
  });

  test("refuses a target path that already exists and creates nothing", () => {
    const blockers: Record<string, (path: string) => void> = {
      "dangling link": (path) =>
        symlinkSync(join(dirname(path), "nowhere"), path),
      "empty directory": (path) => mkdirSync(path),
      file: (path) => writeFileSync(path, "someone else's\n"),
    };
    for (const [kind, block] of Object.entries(blockers)) {
      const fixture = activeRun();
      const target = flatPath(fixture, "layout", "author");
      block(target);
      const before = readdirSync(fixture.base).sort();
      expect(
        () =>
          prepareAgentWorktree(
            fixture.root,
            fixture.lease.runId,
            "author",
            "layout"
          ),
        kind
      ).toThrow(
        `Refusing to reuse unregistered agent worktree path ${target}.`
      );
      expect(readdirSync(fixture.base).sort()).toEqual(before);
      expect(
        lstatSync(target).isDirectory() ? readdirSync(target) : []
      ).toEqual([]);
      if (kind === "file") {
        expect(readFileSync(target, "utf8")).toBe("someone else's\n");
      }
      expect(readLoopLease(fixture.root)?.preparations).toEqual([]);
      expect(
        branchExists(
          fixture.root,
          `simple-changes/layout-author-${fixture.runSlug}`
        )
      ).toBe(false);
    }
  }, 120_000);

  test("reduces names to slugs that cannot leave the folder beside the primary", () => {
    const fixture = activeRun();
    const prepared = prepareAgentWorktree(
      fixture.root,
      fixture.lease.runId,
      "../../Escape/Agent",
      "../../etc/passwd"
    );
    expect(prepared.path).toBe(flatPath(fixture, "etc-passwd", "escape-agent"));
    expect(dirname(prepared.path)).toBe(fixture.base);
    expect(readdirSync(fixture.base).sort()).toEqual(
      [basename(prepared.path), "repo"].sort()
    );
  });

  test("refuses an agent whose name gives a path or branch already in use", () => {
    const fixture = activeRun();
    const first = prepareAgentWorktree(
      fixture.root,
      fixture.lease.runId,
      "Author One",
      "layout"
    );
    const after = readdirSync(fixture.base).sort();
    expect(after).toEqual([basename(first.path), "repo"].sort());

    // The same slugs give the same path, which is refused.
    expect(() =>
      prepareAgentWorktree(
        fixture.root,
        fixture.lease.runId,
        "author-one",
        "layout"
      )
    ).toThrow(
      `Refusing to reuse unregistered agent worktree path ${first.path}.`
    );

    // Different fields always give different paths; the branch name that
    // joins them without a separator is refused instead.
    const second = prepareAgentWorktree(
      fixture.root,
      fixture.lease.runId,
      "c",
      "a-b"
    );
    expect(second.path).toBe(flatPath(fixture, "a-b", "c"));
    const withSecond = readdirSync(fixture.base).sort();
    expect(() =>
      prepareAgentWorktree(fixture.root, fixture.lease.runId, "b-c", "a")
    ).toThrow(
      `Refusing to reuse unregistered agent branch simple-changes/a-b-c-${fixture.runSlug}.`
    );
    expect(existsSync(flatPath(fixture, "a", "b-c"))).toBe(false);
    expect(readdirSync(fixture.base).sort()).toEqual(withSecond);
    expect(readLoopLease(fixture.root)?.preparations).toEqual([]);
  }, 120_000);

  test("resumes a preparation an older runtime recorded in the managed layout", () => {
    const fixture = activeRun();
    const legacy = legacyPreparedWorktreePath(
      fixture.root,
      fixture.lease.runId,
      "author",
      "legacy"
    );
    const prepared = prepareLegacyLayoutAgentWorktree(
      fixture.root,
      fixture.lease.runId,
      "author",
      "legacy"
    );
    expect(prepared.path).toBe(legacy);
    expect(prepared.created).toBe(true);
    expect(readLoopLease(fixture.root)?.preparations).toEqual([]);
    expect(readLoopLease(fixture.root)?.worktrees).toContainEqual(
      expect.objectContaining({
        agentId: "author",
        path: legacy,
        role: "author",
      })
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
    // Asking again returns the same registration.
    expect(
      prepareAgentWorktree(
        fixture.root,
        fixture.lease.runId,
        "author",
        "legacy"
      )
    ).toMatchObject({ created: false, path: legacy });
  });

  test("never creates the missing parent folders of an older preparation", () => {
    const fixture = activeRun();
    const legacy = legacyPreparedWorktreePath(
      fixture.root,
      fixture.lease.runId,
      "author",
      "legacy"
    );
    expect(() =>
      prepareLegacyLayoutAgentWorktree(
        fixture.root,
        fixture.lease.runId,
        "author",
        "legacy",
        false
      )
    ).toThrow(
      `The folder ${dirname(legacy)} that holds prepared path ${legacy} is missing or is not a directory`
    );
    expect(readdirSync(fixture.base)).toEqual(["repo"]);
    expect(readLoopLease(fixture.root)?.preparations).toHaveLength(1);
  });
});
