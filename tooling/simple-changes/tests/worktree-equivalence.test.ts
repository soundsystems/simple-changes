import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import {
  auditWorktreeEquivalence,
  commitEquivalenceAgainstTarget,
} from "../../../skills/simple-changes/scripts/lib/worktree-equivalence.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

let repositories: TestRepository[] = [];
setDefaultTimeout(30_000);

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const featureWorktree = (fixture: TestRepository): string => {
  const worktree = join(fixture.base, "feature");
  git(fixture.root, ["worktree", "add", "-b", "feature", worktree]);
  writeFixture(fixture.root, "base.ts", "export const base = 0;\n");
  git(fixture.root, ["add", "base.ts"]);
  git(fixture.root, ["commit", "-m", "Diverge main from feature"]);
  return worktree;
};

describe("worktree equivalence evidence", () => {
  test("classifies cherry-picked, reworked, and dirty evidence as partial", () => {
    const fixture = repository();
    const worktree = featureWorktree(fixture);

    writeFixture(worktree, "picked.ts", "export const picked = 1;\n");
    git(worktree, ["add", "picked.ts"]);
    git(worktree, ["commit", "-m", "Add picked module"]);
    const pickedSha = git(worktree, ["rev-parse", "HEAD"]);
    git(fixture.root, ["cherry-pick", pickedSha]);
    const pickedTargetSha = git(fixture.root, ["rev-parse", "HEAD"]);

    writeFixture(worktree, "unique.ts", "export const unique = 1;\n");
    git(worktree, ["add", "unique.ts"]);
    git(worktree, ["commit", "-m", "Add unique module"]);
    const uniqueSha = git(worktree, ["rev-parse", "HEAD"]);

    writeFixture(fixture.root, "shared.ts", "export const shared = 2;\n");
    git(fixture.root, ["add", "shared.ts"]);
    git(fixture.root, ["commit", "-m", "Add shared module on main"]);

    writeFixture(worktree, "README.md", "# Fixture v2\n");
    writeFixture(worktree, "shared.ts", "export const shared = 2;\n");
    writeFixture(worktree, "absent.ts", "export const absent = true;\n");

    const report = auditWorktreeEquivalence({
      targetRef: "main",
      worktreePath: worktree,
    });

    expect(() => validateSchema("worktree-equivalence", report)).not.toThrow();
    expect(report.targetRevision).toBe(
      git(fixture.root, ["rev-parse", "main"])
    );
    expect(report.head).toBe(uniqueSha);
    expect(report.commits).toEqual([
      expect.objectContaining({
        matchedTargetSha: pickedTargetSha,
        sha: pickedSha,
        status: "matched",
      }),
      expect.objectContaining({
        matchedTargetSha: null,
        sha: uniqueSha,
        status: "unmatched",
      }),
    ]);
    expect(report.paths).toEqual([
      { path: "absent.ts", status: "absent-in-target" },
      { path: "README.md", status: "differs" },
      { path: "shared.ts", status: "identical" },
    ]);
    expect(report.equivalence).toBe("partial");
    expect(report.disclaimer).toBe(
      "Patch and byte evidence only; semantic equivalence requires review."
    );
  });

  test("reports contained when every commit and dirty byte is in the target", () => {
    const fixture = repository();
    const worktree = featureWorktree(fixture);

    writeFixture(worktree, "picked.ts", "export const picked = 1;\n");
    git(worktree, ["add", "picked.ts"]);
    git(worktree, ["commit", "-m", "Add picked module"]);
    const pickedSha = git(worktree, ["rev-parse", "HEAD"]);
    git(fixture.root, ["cherry-pick", pickedSha]);

    writeFixture(fixture.root, "shared.ts", "export const shared = 2;\n");
    git(fixture.root, ["add", "shared.ts"]);
    git(fixture.root, ["commit", "-m", "Add shared module on main"]);
    writeFixture(worktree, "shared.ts", "export const shared = 2;\n");

    const report = auditWorktreeEquivalence({
      targetRef: "main",
      worktreePath: worktree,
    });
    expect(report.commits).toEqual([
      expect.objectContaining({ sha: pickedSha, status: "matched" }),
    ]);
    expect(report.paths).toEqual([{ path: "shared.ts", status: "identical" }]);
    expect(report.equivalence).toBe("contained");
  });

  test("reports divergent when nothing matches the target", () => {
    const fixture = repository();
    const worktree = featureWorktree(fixture);

    writeFixture(worktree, "unique.ts", "export const unique = 1;\n");
    git(worktree, ["add", "unique.ts"]);
    git(worktree, ["commit", "-m", "Add unique module"]);
    writeFixture(worktree, "README.md", "# Fixture rewritten\n");

    const report = auditWorktreeEquivalence({
      targetRef: "main",
      worktreePath: worktree,
    });
    expect(report.commits).toEqual([
      expect.objectContaining({ matchedTargetSha: null, status: "unmatched" }),
    ]);
    expect(report.paths).toEqual([{ path: "README.md", status: "differs" }]);
    expect(report.equivalence).toBe("divergent");
  });

  test("proves per-commit patch equivalence against the target", () => {
    const fixture = repository();
    const worktree = featureWorktree(fixture);

    writeFixture(worktree, "picked.ts", "export const picked = 1;\n");
    git(worktree, ["add", "picked.ts"]);
    git(worktree, ["commit", "-m", "Add picked module"]);
    const pickedSha = git(worktree, ["rev-parse", "HEAD"]);
    git(fixture.root, ["cherry-pick", pickedSha]);
    const pickedTargetSha = git(fixture.root, ["rev-parse", "HEAD"]);

    const result = commitEquivalenceAgainstTarget(
      worktree,
      pickedSha,
      pickedTargetSha
    );

    expect(result.mergeBase).not.toBeNull();
    expect(result.commitCount).toBe(1);
    expect(result.exceededMaxCommits).toBe(false);
    expect(result.fullyMatched).toBe(true);
    expect(result.commits).toEqual([
      expect.objectContaining({
        matchedTargetSha: pickedTargetSha,
        sha: pickedSha,
        status: "matched",
      }),
    ]);
  });

  test("reports unmatched commits without inventing equivalence", () => {
    const fixture = repository();
    const worktree = featureWorktree(fixture);

    writeFixture(worktree, "unique.ts", "export const unique = 1;\n");
    git(worktree, ["add", "unique.ts"]);
    git(worktree, ["commit", "-m", "Add unique module"]);
    const head = git(worktree, ["rev-parse", "HEAD"]);
    const target = git(fixture.root, ["rev-parse", "main"]);

    const result = commitEquivalenceAgainstTarget(worktree, head, target);

    expect(result.fullyMatched).toBe(false);
    expect(result.commits).toEqual([
      expect.objectContaining({ sha: head, status: "unmatched" }),
    ]);
  });

  test("flags histories beyond the commit bound instead of auditing them", () => {
    const fixture = repository();
    const worktree = featureWorktree(fixture);

    writeFixture(worktree, "first.ts", "export const first = 1;\n");
    git(worktree, ["add", "first.ts"]);
    git(worktree, ["commit", "-m", "First commit"]);
    writeFixture(worktree, "second.ts", "export const second = 2;\n");
    git(worktree, ["add", "second.ts"]);
    git(worktree, ["commit", "-m", "Second commit"]);
    const head = git(worktree, ["rev-parse", "HEAD"]);
    const target = git(fixture.root, ["rev-parse", "main"]);

    const result = commitEquivalenceAgainstTarget(worktree, head, target, {
      maxCommits: 1,
    });

    expect(result.exceededMaxCommits).toBe(true);
    expect(result.fullyMatched).toBe(false);
    expect(result.commitCount).toBe(2);
    expect(result.commits).toEqual([]);
  });

  test("refuses symlinked dirty paths", () => {
    const fixture = repository();
    const worktree = featureWorktree(fixture);
    symlinkSync("README.md", join(worktree, "link.md"));

    expect(() =>
      auditWorktreeEquivalence({ targetRef: "main", worktreePath: worktree })
    ).toThrow("symlinked path");
  });
});
