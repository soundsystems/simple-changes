import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  endLoop,
  executeLoopMutation,
  grantLoopOverride,
  guardLoopMutation,
  loopLeasePath,
  loopLockPath,
  prepareAgentWorktree,
  readLoopLease,
  recoverLoopLock,
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
    expect(prepared.baseRevision).toBe(lease.targetRevision);
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

  test("prepares from the target revision pinned at loop start", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    writeFixture(
      fixture.root,
      "advanced.ts",
      "export const advanced = true;\n"
    );
    git(fixture.root, ["add", "advanced.ts"]);
    git(fixture.root, ["commit", "-m", "Advance target after lease start"]);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).not.toBe(
      lease.targetRevision
    );

    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "late-agent",
      "pinned"
    );
    expect(prepared.baseRevision).toBe(lease.targetRevision);
    expect(git(prepared.path, ["rev-parse", "HEAD"])).toBe(
      lease.targetRevision
    );
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

    writeFixture(preserved, "outside.ts", "export const outside = false;\n");
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "preserved-worktree-changed",
        path: preserved,
      })
    );
  });

  test("executes one mutation while holding the lease lock", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const result = executeLoopMutation(
      fixture.root,
      lease.runId,
      "controller",
      [
        process.execPath,
        "-e",
        "await Bun.write('atomic.txt', 'guarded mutation\\n')",
      ]
    );

    expect(result.result.exitCode).toBe(0);
    expect(readFileSync(join(fixture.root, "atomic.txt"), "utf8")).toBe(
      "guarded mutation\n"
    );
    expect(result.verification.ok).toBe(true);
  });

  test("recovers only a stale lock whose local owner process is dead", () => {
    const fixture = repository();
    startLoop(fixture.root, "controller", "ship");
    const inventory = captureInventory(fixture.root);
    const lockPath = loopLockPath(inventory.repository.commonGitDirectory);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        hostname: hostname(),
        operation: "crashed mutation",
        pid: 2_147_483_647,
        token: "dead-owner",
      })}\n`
    );

    expect(recoverLoopLock(fixture.root, "controller").recovered).toBe(true);

    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        hostname: hostname(),
        operation: "live mutation",
        pid: process.pid,
        token: "live-owner",
      })}\n`
    );
    expect(() => recoverLoopLock(fixture.root, "controller")).toThrow(
      "active lock owner"
    );
  });

  test("resumes registration after worktree creation was interrupted", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "resumable"
    );
    const inventory = captureInventory(fixture.root);
    const statePath = loopLeasePath(inventory.repository.commonGitDirectory);
    const currentLease = readLoopLease(fixture.root);
    if (!currentLease) {
      throw new Error("Expected active loop lease");
    }
    const authorWorktree = currentLease.worktrees.find(
      (worktree) => worktree.agentId === "author"
    );
    expect(authorWorktree).toBeDefined();
    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          ...currentLease,
          preparations: [
            {
              agentId: "author",
              baseRevision: prepared.baseRevision,
              branch: prepared.branch,
              createdAt: new Date().toISOString(),
              path: prepared.path,
              purpose: "resumable",
            },
          ],
          worktrees: currentLease.worktrees.filter(
            (worktree) => worktree.agentId !== "author"
          ),
        },
        null,
        2
      )}\n`
    );

    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "incomplete-worktree-preparation",
        path: prepared.path,
      })
    );
    const resumed = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "ignored"
    );
    expect(resumed.path).toBe(prepared.path);
    expect(readLoopLease(fixture.root)?.preparations).toEqual([]);
    expect(verifyLoop(fixture.root).ok).toBe(true);
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
  }, 20_000);
});
