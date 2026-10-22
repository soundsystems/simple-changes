import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proveExactByteTargetContainment } from "../../../skills/simple-changes/scripts/lib/exact-byte-proof.ts";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  closeLoopTargetEquivalent,
  loopLeasePath,
  prepareAgentWorktree,
  readLoopLease,
  retainExcludedWorktree,
  retireAbsentWorktree,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(
  Number(process.env.SIMPLE_CHANGES_TEST_TIMEOUT_MS ?? "") || 60_000
);

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const withOrigin = (root: string): void => {
  git(root, [
    "remote",
    "add",
    "origin",
    "https://example.invalid/canonical.git",
  ]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
};

// Commits files on a detached HEAD and moves origin/main there, leaving the
// local main branch and the primary checkout where they were.
const advanceTarget = (root: string, files: Record<string, string>): string => {
  git(root, ["checkout", "--quiet", "--detach"]);
  for (const [path, contents] of Object.entries(files)) {
    writeFixture(root, path, contents);
    git(root, ["add", path]);
  }
  git(root, ["commit", "--quiet", "-m", "Advance target"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const target = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "--quiet", "main"]);
  return target;
};

describe("exact-byte target proof", () => {
  test("proves work the target integrated inside a broader commit", () => {
    const fixture = repository();
    git(fixture.root, ["switch", "--quiet", "-c", "author"]);
    writeFixture(fixture.root, "a.txt", "alpha\n");
    git(fixture.root, ["add", "a.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Author a"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["switch", "--quiet", "main"]);
    writeFixture(fixture.root, "a.txt", "alpha\n");
    writeFixture(fixture.root, "b.txt", "beta\n");
    git(fixture.root, ["add", "a.txt", "b.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Broader"]);

    expect(
      proveExactByteTargetContainment(fixture.root, {
        sourceHead: head,
        targetRevision: "main",
      })
    ).toMatchObject({
      commits: [head],
      headRevision: head,
      status: "proven",
      touchedPaths: ["a.txt"],
    });

    writeFixture(fixture.root, "a.txt", "changed later\n");
    git(fixture.root, ["commit", "--quiet", "-am", "Change a"]);
    expect(
      proveExactByteTargetContainment(fixture.root, {
        sourceHead: head,
        targetRevision: "main",
      })
    ).toMatchObject({ differingPaths: ["a.txt"], status: "refused" });
  });

  test("refuses a merge commit, a base outside the target, and an unknown tip", () => {
    const fixture = repository();
    const root = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["switch", "--quiet", "-c", "side"]);
    writeFixture(fixture.root, "side.txt", "side\n");
    git(fixture.root, ["add", "side.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Side"]);
    const side = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["switch", "--quiet", "-c", "merged", root]);
    writeFixture(fixture.root, "other.txt", "other\n");
    git(fixture.root, ["add", "other.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Other"]);
    git(fixture.root, ["merge", "--quiet", "--no-edit", "side"]);
    const merged = git(fixture.root, ["rev-parse", "HEAD"]);

    expect(
      proveExactByteTargetContainment(fixture.root, {
        sourceHead: merged,
        targetRevision: merged,
      }).status
    ).toBe("proven");
    expect(
      proveExactByteTargetContainment(fixture.root, {
        sourceHead: merged,
        targetRevision: root,
      })
    ).toMatchObject({
      reason: expect.stringContaining("merge commit"),
      status: "refused",
    });
    expect(
      proveExactByteTargetContainment(fixture.root, {
        sourceBase: side,
        sourceHead: side,
        targetRevision: root,
      })
    ).toMatchObject({
      reason: expect.stringContaining("is not contained in target"),
      status: "refused",
    });
    expect(
      proveExactByteTargetContainment(fixture.root, {
        sourceHead: "no-such-branch",
        targetRevision: root,
      }).status
    ).toBe("refused");
  });
});

interface AuthorFixture {
  branch: string;
  fixture: TestRepository;
  path: string;
  runId: string;
}

// A run-created author commits a.txt; the target integrates the same bytes
// inside a broader commit, so neither ancestry nor patch IDs contain it.
const absentAuthorFixture = (targetA = "alpha\n"): AuthorFixture => {
  const fixture = repository();
  withOrigin(fixture.root);
  const lease = startLoop(fixture.root, "controller", "integrate");
  const prepared = prepareAgentWorktree(
    fixture.root,
    lease.runId,
    "tester",
    "unit-a"
  );
  writeFixture(prepared.path, "a.txt", "alpha\n");
  git(prepared.path, ["add", "a.txt"]);
  git(prepared.path, ["commit", "--quiet", "-m", "Author a"]);
  advanceTarget(fixture.root, { "a.txt": targetA, "b.txt": "beta\n" });
  git(fixture.root, ["worktree", "remove", prepared.path]);
  return {
    branch: prepared.branch,
    fixture,
    path: prepared.path,
    runId: lease.runId,
  };
};

const retirementRecords = (root: string, runId: string): string[] => {
  const directory = join(root, ".git", "simple-changes", "history", runId);
  return existsSync(directory)
    ? readdirSync(directory).filter((name) =>
        name.startsWith("run-created-retirement-")
      )
    : [];
};

describe("run-created author retirement", () => {
  test("retires an absent run-created author on exact-byte proof with its branch retained", () => {
    const { branch, fixture, path, runId } = absentAuthorFixture();
    const branchHead = git(fixture.root, ["rev-parse", branch]);
    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        runId,
        "controller",
        "user",
        "Before retirement"
      )
    ).toThrow("retire-absent-worktree");

    const retired = retireAbsentWorktree(
      fixture.root,
      runId,
      "controller",
      path,
      "user",
      "The user approved removing the delivered checkout."
    );

    expect(retired.retirements ?? []).toEqual([]);
    expect(retirementRecords(fixture.root, runId)).toHaveLength(1);
    expect(git(fixture.root, ["rev-parse", branch])).toBe(branchHead);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    // Retiring again records nothing new.
    retireAbsentWorktree(
      fixture.root,
      runId,
      "controller",
      path,
      "user",
      "Repeat"
    );
    expect(retirementRecords(fixture.root, runId)).toHaveLength(1);

    const closed = closeLoopTargetEquivalent(
      fixture.root,
      runId,
      "controller",
      "user",
      "The target holds the author's exact bytes."
    );
    expect(closed.outcome).toBe("target-equivalent");
    expect(git(fixture.root, ["rev-parse", branch])).toBe(branchHead);
  });

  test("a retirement stops applying once the retained branch moves or is deleted", () => {
    const { branch, fixture, path, runId } = absentAuthorFixture();
    retireAbsentWorktree(
      fixture.root,
      runId,
      "controller",
      path,
      "user",
      "Delivered"
    );
    git(fixture.root, ["branch", "--force", branch, "HEAD~0"]);
    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        runId,
        "controller",
        "user",
        "Moved"
      )
    ).toThrow("nothing-to-ship is unproven");
    // Deleting the moved branch does not bring the retirement back.
    git(fixture.root, ["branch", "-D", branch]);
    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        runId,
        "controller",
        "user",
        "Deleted"
      )
    ).toThrow("nothing-to-ship is unproven");
  });

  test("refuses when a touched path differs from the target", () => {
    const { fixture, path, runId } = absentAuthorFixture("different\n");
    expect(() =>
      retireAbsentWorktree(
        fixture.root,
        runId,
        "controller",
        path,
        "user",
        "Differs"
      )
    ).toThrow("exact-byte target proof failed");
    expect(retirementRecords(fixture.root, runId)).toEqual([]);
  });

  test("refuses when the author's branch is gone", () => {
    const { branch, fixture, path, runId } = absentAuthorFixture();
    git(fixture.root, ["branch", "-D", branch]);
    expect(() =>
      retireAbsentWorktree(
        fixture.root,
        runId,
        "controller",
        path,
        "user",
        "No branch"
      )
    ).toThrow(`its branch ${branch} no longer exists`);
    expect(retirementRecords(fixture.root, runId)).toEqual([]);
  });

  test("refuses a registration that is neither run-created nor preserved", () => {
    const fixture = repository();
    withOrigin(fixture.root);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const temporary = join(fixture.base, "temporary");
    git(fixture.root, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "temporary",
      temporary,
    ]);
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === temporary
    );
    retainExcludedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      temporary,
      current?.changeDigest ?? "",
      "user",
      "Keep it out of the shipment."
    );
    expect(
      readLoopLease(fixture.root)?.worktrees.find(
        (worktree) => worktree.path === temporary
      )
    ).toMatchObject({ createdByRun: false, role: "retained" });
    git(fixture.root, ["worktree", "remove", temporary]);
    expect(() =>
      retireAbsentWorktree(
        fixture.root,
        lease.runId,
        "controller",
        temporary,
        "user",
        "Retained"
      )
    ).toThrow("must name a preserved registration");
    expect(retirementRecords(fixture.root, lease.runId)).toEqual([]);
  });
  test("cleanup keeps the contained branch a legacy preserved author retirement relies on", () => {
    const fixture = repository();
    withOrigin(fixture.root);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "tester",
      "unit-a"
    );
    writeFixture(prepared.path, "a.txt", "alpha\n");
    git(prepared.path, ["add", "a.txt"]);
    git(prepared.path, ["commit", "--quiet", "-m", "Author a"]);
    // The target contains the author's commit by ancestry.
    git(fixture.root, ["checkout", "--quiet", "--detach", prepared.branch]);
    writeFixture(fixture.root, "b.txt", "beta\n");
    git(fixture.root, ["add", "b.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Later target work"]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, ["checkout", "--quiet", "main"]);
    git(fixture.root, ["worktree", "remove", prepared.path]);
    // An older runtime could leave a run-created author registered as
    // preserved.
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    stored.worktrees = stored.worktrees.map((worktree) =>
      worktree.path === prepared.path
        ? {
            ...worktree,
            agentId: null,
            mutationAllowed: false,
            role: "preserved",
          }
        : worktree
    );
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "missing-preserved-worktree",
        path: prepared.path,
      })
    );

    retireAbsentWorktree(
      fixture.root,
      lease.runId,
      "controller",
      prepared.path,
      "user",
      "The user approved removing the delivered checkout."
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);

    const closed = closeLoopTargetEquivalent(
      fixture.root,
      lease.runId,
      "controller",
      "user",
      "The target contains the author's work."
    );
    expect(closed.outcome).toBe("target-equivalent");
    expect(closed.cleanup.removedBranches).not.toContainEqual(
      expect.objectContaining({ branch: prepared.branch })
    );
    expect(git(fixture.root, ["branch", "--list", prepared.branch])).toContain(
      prepared.branch
    );
  });
});
