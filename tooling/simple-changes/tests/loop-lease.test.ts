import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  endLoop,
  grantLoopOverride,
  guardLoopMutation,
  loopLeasePath,
  prepareAgentWorktree,
  readLoopLease,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
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

describe("active integration-loop lease", () => {
  test("captures an exclusive opening manifest without dirtying the checkout", () => {
    const fixture = repository();
    const before = git(fixture.root, ["status", "--porcelain=v1"]);
    const lease = startLoop(fixture.root, "controller", "ship");
    const inventory = captureInventory(fixture.root);

    expect(lease.ownerAgentId).toBe("controller");
    expect(lease.worktrees).toContainEqual(
      expect.objectContaining({
        agentId: "controller",
        mutationAllowed: true,
        path: fixture.root,
        role: "controller",
      })
    );
    expect(loopLeasePath(inventory.repository.commonGitDirectory)).toBe(
      join(
        inventory.repository.commonGitDirectory,
        "simple-changes",
        "active-loop.json"
      )
    );
    expect(git(fixture.root, ["status", "--porcelain=v1"])).toBe(before);
    expect(() => startLoop(fixture.root, "another-agent", "ship")).toThrow(
      "already active"
    );
  });

  test("prepares one isolated authoring worktree per agent", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "catalog-agent",
      "catalog fix"
    );
    const repeated = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "catalog-agent",
      "ignored second purpose"
    );

    expect(prepared.created).toBe(true);
    expect(prepared.path).not.toBe(fixture.root);
    expect(prepared.branch).toContain("catalog-fix-catalog-agent");
    expect(repeated).toMatchObject({
      branch: prepared.branch,
      created: false,
      path: prepared.path,
    });
    expect(
      guardLoopMutation(prepared.path, lease.runId, "catalog-agent").ok
    ).toBe(true);
    expect(() =>
      guardLoopMutation(fixture.root, lease.runId, "catalog-agent")
    ).toThrow("not allowed to mutate");
  });

  test("rejects an unregistered worktree created after loop start", () => {
    const fixture = repository();
    startLoop(fixture.root, "controller", "integrate");
    const unexpected = join(fixture.base, "unexpected");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "unexpected-agent-work",
      unexpected,
    ]);

    const verification = verifyLoop(fixture.root);
    expect(verification.ok).toBe(false);
    expect(verification.violations).toContainEqual(
      expect.objectContaining({
        code: "unregistered-worktree",
        path: unexpected,
      })
    );
  });

  test("binds a user-approved exception to one preserved path and digest", () => {
    const fixture = repository();
    const preserved = join(fixture.base, "preserved");
    git(fixture.root, ["worktree", "add", "-b", "preserved-work", preserved]);
    const lease = startLoop(fixture.root, "controller", "ship");
    writeFixture(preserved, "outside.ts", "export const outside = true;\n");

    const blocked = verifyLoop(fixture.root);
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === preserved
    );
    expect(blocked.violations).toContainEqual(
      expect.objectContaining({
        code: "preserved-worktree-changed",
        path: preserved,
      })
    );
    expect(current).toBeDefined();
    expect(() =>
      grantLoopOverride(
        fixture.root,
        lease.runId,
        "controller",
        preserved,
        "0".repeat(64),
        "user",
        "Include the exact completed slice"
      )
    ).toThrow("does not match");

    const updated = grantLoopOverride(
      fixture.root,
      lease.runId,
      "controller",
      preserved,
      current?.changeDigest ?? "",
      "user",
      "Include the exact completed slice"
    );
    expect(updated.overrides).toContainEqual(
      expect.objectContaining({
        approvedBy: "user",
        changeDigest: current?.changeDigest,
        path: preserved,
      })
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);

    writeFixture(preserved, "later.ts", "export const later = true;\n");
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "preserved-worktree-changed",
        path: preserved,
      })
    );
  });

  test("requires run-created worktree cleanup before releasing the lease", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "unit"
    );

    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "Remove run-created worktrees"
    );
    git(fixture.root, ["worktree", "remove", prepared.path]);
    git(fixture.root, ["branch", "-d", prepared.branch]);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
    expect(readLoopLease(fixture.root)).toBeNull();
  });
});
