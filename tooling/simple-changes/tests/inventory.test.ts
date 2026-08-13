import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureInventory,
  compareSnapshots,
  credentialFreeRemoteUrl,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

let repositories: TestRepository[] = [];

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

describe("Git inventory and concurrency", () => {
  test("removes embedded Git credentials while preserving destination identity", () => {
    expect(
      credentialFreeRemoteUrl(
        "https://oauth2:TOPSECRET@gitlab.example/group/repo.git"
      )
    ).toBe("https://gitlab.example/group/repo.git");
    expect(
      credentialFreeRemoteUrl("https://gitlab.example/group/repo.git")
    ).toBe("https://gitlab.example/group/repo.git");
  });
  test("inventories dirty work without creating run state", () => {
    const fixture = repository();
    writeFixture(fixture.root, "src/change.ts", "export const ready = true;\n");
    const beforeStatus = git(fixture.root, ["status", "--porcelain=v1"]);
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current)
    );
    expect(opening.repository.primaryCheckout).toBe(fixture.root);
    expect(opening.localChanges.map((change) => change.path)).toContain(
      "src/change.ts"
    );
    expect(plan.units).toHaveLength(1);
    expect(plan.mutationCount).toBe(0);
    expect(git(fixture.root, ["status", "--porcelain=v1"])).toBe(beforeStatus);
    expect(existsSync(join(fixture.root, ".git/simple-changes"))).toBe(false);
  });

  test("streams large binary identities and never reads a FIFO", () => {
    const fixture = repository();
    const binaryPath = join(fixture.root, "large.bin");
    const fifoPath = join(fixture.root, "agent.pipe");
    writeFixture(fixture.root, "agent.pipe", "tracked placeholder\n");
    git(fixture.root, ["add", "agent.pipe"]);
    git(fixture.root, ["commit", "-m", "Track future pipe path"]);
    unlinkSync(fifoPath);
    writeFileSync(binaryPath, Buffer.alloc(8 * 1024 * 1024, 7));
    const fifo = spawnSync("mkfifo", [fifoPath]);
    if (fifo.status !== 0) {
      throw new Error(`mkfifo failed: ${fifo.stderr.toString()}`);
    }

    const opening = captureInventory(fixture.root);
    writeFileSync(binaryPath, Buffer.alloc(8 * 1024 * 1024, 8));
    const current = captureInventory(fixture.root);

    expect(opening.localChanges.map((change) => change.path)).toContain(
      "agent.pipe"
    );
    expect(current.baselineDigest).not.toBe(opening.baselineDigest);
  }, 15_000);

  test("prefers the branch remote over an alphabetically earlier auxiliary remote", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "auxiliary",
      "https://example.invalid/aux.git",
    ]);
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/canonical.git",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/auxiliary/main", "HEAD"]);
    git(fixture.root, [
      "symbolic-ref",
      "refs/remotes/auxiliary/HEAD",
      "refs/remotes/auxiliary/main",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    git(fixture.root, ["config", "branch.main.remote", "origin"]);
    git(fixture.root, ["config", "branch.main.merge", "refs/heads/main"]);

    expect(captureInventory(fixture.root).targetRef).toBe("origin/main");
    expect(captureInventory(fixture.root).repository.targetRemote).toBe(
      "origin"
    );
    expect(
      captureInventory(fixture.root).repository.remoteBindings
    ).toContainEqual({
      fetchUrls: ["https://example.invalid/canonical.git"],
      name: "origin",
      provider: "example.invalid",
      pushUrls: ["https://example.invalid/canonical.git"],
    });
  });

  test("reports changelog relevance separately from skill availability", () => {
    const fixture = repository();
    writeFixture(fixture.root, "CHANGELOG.md", "# Changelog\n");
    const inventory = captureInventory(fixture.root, {
      changelogEnvironment: {
        SIMPLE_CHANGES_SKILL_ROOTS: "",
      },
    });

    expect(inventory.capabilities).toContainEqual(
      expect.objectContaining({
        category: "changelog",
        provider: "repository-native",
        status: "configuration",
      })
    );
  });

  test("reports a repository-local changelog skill as supported", () => {
    const fixture = repository();
    writeFixture(
      fixture.root,
      "skills/simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n"
    );
    const inventory = captureInventory(fixture.root);

    expect(inventory.capabilities).toContainEqual(
      expect.objectContaining({
        category: "changelog",
        provider: "simple-changelogs",
        status: "supported",
      })
    );
  });

  test("treats a stable wip-named worktree as ready", () => {
    const fixture = repository();
    const linked = join(fixture.base, "wip-linked");
    git(fixture.root, ["worktree", "add", "-b", "wip-stable", linked]);
    writeFixture(linked, "src/stable.ts", "export const stable = true;\n");
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const comparison = compareSnapshots(opening, current);
    const plan = buildPreviewPlan(opening, current, comparison);
    expect(comparison.stableWorktrees.map((item) => item.path)).toContain(
      linked
    );
    expect(plan.units.some((unit) => unit.sourceWorktree === linked)).toBe(
      true
    );
  });

  test("preserves a worktree created after the opening snapshot", () => {
    const fixture = repository();
    const opening = captureInventory(fixture.root);
    const linked = join(fixture.base, "concurrent-linked");
    git(fixture.root, ["worktree", "add", "-b", "concurrent-work", linked]);
    writeFixture(linked, "src/new.ts", "export const concurrent = true;\n");
    const current = captureInventory(fixture.root);
    const comparison = compareSnapshots(opening, current);
    const plan = buildPreviewPlan(opening, current, comparison);
    expect(comparison.concurrentWorktrees.map((item) => item.path)).toContain(
      linked
    );
    expect(plan.preserved).toContainEqual(
      expect.objectContaining({
        classification: "concurrent-arrival",
        worktreePath: linked,
      })
    );
  });

  test("preserves an existing worktree that changes between snapshots", () => {
    const fixture = repository();
    writeFixture(fixture.root, "src/first.ts", "export const first = true;\n");
    const opening = captureInventory(fixture.root);
    writeFixture(
      fixture.root,
      "src/second.ts",
      "export const second = true;\n"
    );
    const current = captureInventory(fixture.root);
    const comparison = compareSnapshots(opening, current);
    expect(comparison.activelyChangingWorktrees).toHaveLength(1);
    const plan = buildPreviewPlan(opening, current, comparison);
    expect(plan.units).toHaveLength(0);
    expect(plan.preserved[0]?.classification).toBe("actively-changing");
  });

  test("preserves symlink paths as unsafe", () => {
    const fixture = repository();
    symlinkSync("/tmp", join(fixture.root, "external-link"));
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current)
    );
    expect(plan.units).toHaveLength(0);
    expect(plan.preserved[0]?.classification).toBe("unsafe");
  });

  test("inventories a pre-existing stash without changing it", () => {
    const fixture = repository();
    writeFixture(
      fixture.root,
      "src/stashed.ts",
      "export const stash = true;\n"
    );
    git(fixture.root, ["add", "src/stashed.ts"]);
    git(fixture.root, ["stash", "push", "-m", "existing fixture stash"]);
    writeFixture(fixture.root, "src/ready.ts", "export const ready = true;\n");
    const before = git(fixture.root, ["stash", "list", "--format=%gd:%gs"]);
    const inventory = captureInventory(fixture.root);
    const after = git(fixture.root, ["stash", "list", "--format=%gd:%gs"]);
    expect(inventory.stashes).toHaveLength(1);
    expect(inventory.stashes[0]?.subject).toContain("existing fixture stash");
    expect(after).toBe(before);
  });
});
