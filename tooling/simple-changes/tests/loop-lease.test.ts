import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { sleep } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  authorizeWorktreeRemoval,
  endLoop,
  executeLoopMutation,
  grantLoopOverride,
  guardLoopMutation,
  loopLeasePath,
  loopLockPath,
  prepareAgentWorktree,
  readLoopLease,
  recordRemoteBranchReconciliation,
  recoverLoopLock,
  startLoop,
  verifyLoop,
  withLoopMutationLease,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import {
  claimWorktree,
  releaseWorktreeClaim,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
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
    ).toThrow("not allowed to run guarded integration mutations");
  }, 60_000);

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

  test("allows an opening claimed author to keep changing during integration", () => {
    const fixture = repository();
    const authorPath = join(fixture.base, "claimed-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "claimed-author-work",
      authorPath,
    ]);
    const claim = claimWorktree(
      fixture.root,
      "feature-agent",
      authorPath,
      "codex",
      "task-feature"
    );
    const lease = startLoop(fixture.root, "controller", "ship");

    expect(lease.concurrentWork).toBe("allow-claimed");
    expect(lease.worktrees).toContainEqual(
      expect.objectContaining({
        agentId: "feature-agent",
        claimId: claim.claimId,
        mutationAllowed: true,
        path: authorPath,
        role: "concurrent-author",
      })
    );
    expect(() =>
      guardLoopMutation(authorPath, lease.runId, "feature-agent")
    ).toThrow("not allowed to run guarded integration mutations");

    writeFixture(authorPath, "feature.ts", "export const feature = 1;\n");
    expect(verifyLoop(fixture.root).ok).toBe(true);
    writeFixture(authorPath, "feature.ts", "export const feature = 2;\n");
    expect(verifyLoop(fixture.root).ok).toBe(true);

    releaseWorktreeClaim(fixture.root, "feature-agent", claim.claimId);
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "coordination-claim-stale",
        path: authorPath,
      })
    );
  });

  test("promotes an opening preserved worktree after its owner claims it", () => {
    const fixture = repository();
    const authorPath = join(fixture.base, "claimed-after-start");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "claimed-after-start-work",
      authorPath,
    ]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(lease.worktrees).toContainEqual(
      expect.objectContaining({
        agentId: null,
        path: authorPath,
        role: "preserved",
      })
    );

    writeFixture(authorPath, "feature.ts", "export const feature = 1;\n");
    const claim = claimWorktree(
      fixture.root,
      "feature-agent",
      authorPath,
      "codex",
      "task-feature"
    );

    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(readLoopLease(fixture.root)?.worktrees).toContainEqual(
      expect.objectContaining({
        agentId: "feature-agent",
        claimId: claim.claimId,
        path: authorPath,
        role: "concurrent-author",
      })
    );

    writeFixture(authorPath, "feature.ts", "export const feature = 2;\n");
    expect(verifyLoop(fixture.root).ok).toBe(true);
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === authorPath
    );
    expect(() =>
      grantLoopOverride(
        fixture.root,
        lease.runId,
        "controller",
        authorPath,
        current?.changeDigest ?? "",
        "user",
        "Treat ordinary claimed work as an exception"
      )
    ).toThrow("no user-approved override is allowed or needed");
    expect(readLoopLease(fixture.root)?.overrides).toEqual([]);
  });

  test("rejects a claimed author worktree on the target branch", () => {
    const fixture = repository();
    const remotePath = join(fixture.base, "remote.git");
    git(fixture.base, ["init", "--bare", remotePath]);
    git(fixture.root, ["remote", "add", "origin", remotePath]);
    git(fixture.root, ["push", "-u", "origin", "main"]);
    git(fixture.root, ["branch", "-m", "feature-controller"]);
    const targetPath = join(fixture.base, "target-main");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "main",
      targetPath,
      "origin/main",
    ]);
    claimWorktree(
      fixture.root,
      "target-agent",
      targetPath,
      "codex",
      "task-target"
    );

    const lease = startLoop(fixture.root, "controller", "integrate");
    const targetRegistration = lease.worktrees.find(
      (worktree) => worktree.path === targetPath
    );
    expect(lease.targetRef).toBe("main");
    expect(targetRegistration).toMatchObject({
      mutationAllowed: false,
      role: "preserved",
    });
  });

  test("allows a newly arrived claimed author without adopting or pausing it", () => {
    const fixture = repository();
    startLoop(fixture.root, "controller", "integrate");
    const authorPath = join(fixture.base, "late-claimed-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "late-claimed-author-work",
      authorPath,
    ]);
    claimWorktree(fixture.root, "late-agent", authorPath, "codex", "task-late");

    writeFixture(authorPath, "late.ts", "export const late = true;\n");
    expect(verifyLoop(fixture.root).ok).toBe(true);
  });

  test("binds a late claimed author and rejects claim reassignment", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const authorPath = join(fixture.base, "late-bound-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "late-bound-author-work",
      authorPath,
    ]);
    const firstClaim = claimWorktree(
      fixture.root,
      "first-agent",
      authorPath,
      "codex",
      "task-first"
    );

    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(readLoopLease(fixture.root)?.worktrees).toContainEqual(
      expect.objectContaining({
        agentId: "first-agent",
        claimId: firstClaim.claimId,
        path: authorPath,
        role: "concurrent-author",
      })
    );
    expect(() =>
      guardLoopMutation(authorPath, lease.runId, "first-agent")
    ).toThrow("not allowed to run guarded integration mutations");

    releaseWorktreeClaim(fixture.root, "first-agent", firstClaim.claimId);
    claimWorktree(
      fixture.root,
      "second-agent",
      authorPath,
      "codex",
      "task-second"
    );
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "coordination-claim-stale",
        path: authorPath,
      })
    );
  });

  test("strict concurrent-work policy preserves repository-wide serialization", () => {
    const fixture = repository();
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify({
        ...DEFAULT_POLICY,
        concurrentWork: "strict",
      })}\n`
    );
    const authorPath = join(fixture.base, "strict-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "strict-author-work",
      authorPath,
    ]);
    claimWorktree(
      fixture.root,
      "strict-agent",
      authorPath,
      "codex",
      "task-strict"
    );
    const lease = startLoop(fixture.root, "controller", "ship");
    expect(lease.concurrentWork).toBe("strict");
    expect(lease.worktrees).toContainEqual(
      expect.objectContaining({ path: authorPath, role: "preserved" })
    );

    writeFixture(authorPath, "strict.ts", "export const strict = true;\n");
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "preserved-worktree-changed",
        path: authorPath,
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
  }, 20_000);

  test("authorizes removal of an audited obsolete opening worktree", () => {
    const fixture = repository();
    const obsolete = join(fixture.base, "obsolete");
    git(fixture.root, ["worktree", "add", "-b", "obsolete-work", obsolete]);
    const lease = startLoop(fixture.root, "controller", "reconcile");
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === obsolete
    );
    expect(current).toBeDefined();

    const updated = authorizeWorktreeRemoval(
      fixture.root,
      lease.runId,
      "controller",
      obsolete,
      current?.changeDigest ?? "",
      "user",
      "Audited obsolete with no unique work"
    );
    expect(updated.dispositions).toContainEqual(
      expect.objectContaining({
        approvedBy: "user",
        branch: "obsolete-work",
        changeDigest: current?.changeDigest,
        headSha: current?.headSha,
        outcome: "remove-after-audit",
        path: obsolete,
        targetRef: lease.targetRef,
        uniqueCommitCount: 0,
      })
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);

    git(fixture.root, ["worktree", "remove", obsolete]);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  }, 20_000);

  test("keeps an opening worktree protected without an approved disposition", () => {
    const fixture = repository();
    const preserved = join(fixture.base, "preserved");
    git(fixture.root, ["worktree", "add", "-b", "preserved-work", preserved]);
    startLoop(fixture.root, "controller", "reconcile");

    git(fixture.root, ["worktree", "remove", preserved]);
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "missing-preserved-worktree",
        path: preserved,
      })
    );
  });

  test("invalidates an opening-worktree disposition after any change", () => {
    const fixture = repository();
    const obsolete = join(fixture.base, "obsolete");
    git(fixture.root, ["worktree", "add", "-b", "obsolete-work", obsolete]);
    const lease = startLoop(fixture.root, "controller", "reconcile");
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === obsolete
    );
    authorizeWorktreeRemoval(
      fixture.root,
      lease.runId,
      "controller",
      obsolete,
      current?.changeDigest ?? "",
      "user",
      "Audited obsolete with no unique work"
    );

    writeFixture(obsolete, "new-work.ts", "export const newWork = true;\n");
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "preserved-worktree-changed",
        path: obsolete,
      })
    );
  });

  test("rejects removal disposition for dirty or unique opening work", () => {
    const fixture = repository();
    const dirty = join(fixture.base, "dirty");
    const unique = join(fixture.base, "unique");
    git(fixture.root, ["worktree", "add", "-b", "dirty-work", dirty]);
    git(fixture.root, ["worktree", "add", "-b", "unique-work", unique]);
    writeFixture(unique, "unique.ts", "export const unique = true;\n");
    git(unique, ["add", "unique.ts"]);
    git(unique, ["commit", "-m", "Unique opening work"]);
    const lease = startLoop(fixture.root, "controller", "reconcile");

    writeFixture(dirty, "dirty.ts", "export const dirty = true;\n");
    const inventory = captureInventory(fixture.root);
    const dirtyInventory = inventory.worktrees.find(
      (worktree) => worktree.path === dirty
    );
    const uniqueInventory = inventory.worktrees.find(
      (worktree) => worktree.path === unique
    );
    expect(() =>
      authorizeWorktreeRemoval(
        fixture.root,
        lease.runId,
        "controller",
        dirty,
        dirtyInventory?.changeDigest ?? "",
        "user",
        "Remove dirty work"
      )
    ).toThrow("must be clean");
    expect(() =>
      authorizeWorktreeRemoval(
        fixture.root,
        lease.runId,
        "controller",
        unique,
        uniqueInventory?.changeDigest ?? "",
        "user",
        "Remove unique work"
      )
    ).toThrow("unique commit");
  }, 20_000);

  test("audits removal against the pinned target after the target ref moves", () => {
    const fixture = repository();
    const unique = join(fixture.base, "unique-after-start");
    git(fixture.root, ["worktree", "add", "-b", "unique-after-start", unique]);
    writeFixture(unique, "unique.ts", "export const unique = true;\n");
    git(unique, ["add", "unique.ts"]);
    git(unique, ["commit", "-m", "Unique opening work"]);
    const lease = startLoop(fixture.root, "controller", "reconcile");

    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === unique
    );
    if (!current?.headSha) {
      throw new Error("Expected the unique opening worktree HEAD");
    }
    git(fixture.root, ["update-ref", "refs/heads/main", current.headSha]);
    expect(git(fixture.root, ["rev-parse", lease.targetRef])).toBe(
      current.headSha
    );
    expect(() =>
      authorizeWorktreeRemoval(
        fixture.root,
        lease.runId,
        "controller",
        unique,
        current.changeDigest,
        "user",
        "Target moved after loop start"
      )
    ).toThrow("unique commit");
  }, 20_000);

  test("does not trust disposition target evidence that differs from the lease", () => {
    const fixture = repository();
    const obsolete = join(fixture.base, "tampered-target");
    git(fixture.root, ["worktree", "add", "-b", "tampered-target", obsolete]);
    const lease = startLoop(fixture.root, "controller", "reconcile");
    const inventory = captureInventory(fixture.root);
    const current = inventory.worktrees.find(
      (worktree) => worktree.path === obsolete
    );
    authorizeWorktreeRemoval(
      fixture.root,
      lease.runId,
      "controller",
      obsolete,
      current?.changeDigest ?? "",
      "user",
      "Audited obsolete with no unique work"
    );

    const leasePath = loopLeasePath(inventory.repository.commonGitDirectory);
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as {
      dispositions: Array<{ targetRevision: string }>;
    };
    const [disposition] = stored.dispositions;
    expect(disposition).toBeDefined();
    if (!disposition) {
      throw new Error("Expected an opening-worktree disposition");
    }
    disposition.targetRevision = "0".repeat(40);
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    git(fixture.root, ["worktree", "remove", obsolete]);

    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "missing-preserved-worktree",
        path: obsolete,
      })
    );
  }, 20_000);

  test("never authorizes removal of the canonical primary checkout", () => {
    const fixture = repository();
    const controller = join(fixture.base, "controller");
    git(fixture.root, ["worktree", "add", "-b", "controller-work", controller]);
    const lease = startLoop(controller, "controller", "reconcile");
    const primary = captureInventory(controller).worktrees.find(
      (worktree) => worktree.path === fixture.root
    );

    expect(() =>
      authorizeWorktreeRemoval(
        controller,
        lease.runId,
        "controller",
        fixture.root,
        primary?.changeDigest ?? "",
        "user",
        "Remove primary"
      )
    ).toThrow("canonical primary checkout");
  });

  test("rejects a registered author worktree that switches branches", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "branch-bound"
    );
    git(prepared.path, ["switch", "-c", "unrelated-author-branch"]);

    expect(() =>
      guardLoopMutation(prepared.path, lease.runId, "author")
    ).toThrow("must resume");
    expect(() =>
      prepareAgentWorktree(prepared.path, lease.runId, "author", "ignored")
    ).toThrow("registered branch");
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "registered-worktree-branch-changed",
        path: prepared.path,
      })
    );
  }, 30_000);

  test("executes one mutation while holding the lease lock", async () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const result = await executeLoopMutation(
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

  test.skipIf(process.platform === "win32")(
    "terminates background descendants before releasing the lease",
    async () => {
      const fixture = repository();
      const lease = startLoop(fixture.root, "controller", "ship");
      const pidPath = join(fixture.root, "lingering.pid");

      await expect(
        executeLoopMutation(fixture.root, lease.runId, "controller", [
          "sh",
          "-c",
          `sleep 30 >/dev/null 2>&1 & echo $! > ${pidPath}`,
        ])
      ).rejects.toThrow("left background processes");

      const lingeringPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      expect(Number.isInteger(lingeringPid)).toBe(true);
      expect(() => process.kill(lingeringPid, 0)).toThrow();
      expect(
        guardLoopMutation(fixture.root, lease.runId, "controller").ok
      ).toBe(true);
    },
    20_000
  );

  test.skipIf(process.platform === "win32")(
    "terminates background descendants after a failed command leader",
    async () => {
      const fixture = repository();
      const lease = startLoop(fixture.root, "controller", "ship");
      const pidPath = join(fixture.root, "failed-lingering.pid");

      await expect(
        executeLoopMutation(fixture.root, lease.runId, "controller", [
          "sh",
          "-c",
          `sleep 30 >/dev/null 2>&1 & echo $! > ${pidPath}; exit 7`,
        ])
      ).rejects.toThrow("left background processes");

      const lingeringPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
      expect(Number.isInteger(lingeringPid)).toBe(true);
      expect(() => process.kill(lingeringPid, 0)).toThrow();
      expect(
        guardLoopMutation(fixture.root, lease.runId, "controller").ok
      ).toBe(true);
    },
    20_000
  );

  test("awaits an asynchronous callback before releasing the lease", async () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const mutation = withLoopMutationLease(
      fixture.root,
      lease.runId,
      "controller",
      "async test mutation",
      async () => {
        await sleep(100);
        writeFixture(fixture.root, "async.txt", "complete\n");
        return "done";
      }
    );
    await sleep(20);

    expect(() =>
      guardLoopMutation(fixture.root, lease.runId, "controller")
    ).toThrow("state is busy");
    expect((await mutation).result).toBe("done");
    expect(readFileSync(join(fixture.root, "async.txt"), "utf8")).toBe(
      "complete\n"
    );
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

  test("refuses recovery while a guarded process group remains alive", () => {
    const fixture = repository();
    startLoop(fixture.root, "controller", "ship");
    const inventory = captureInventory(fixture.root);
    const lockPath = loopLockPath(inventory.repository.commonGitDirectory);
    const child = spawn(process.execPath, ["-e", "await Bun.sleep(30_000)"], {
      detached: true,
      stdio: "ignore",
    });
    const childPid = child.pid;
    if (!childPid) {
      throw new Error("Expected detached child PID");
    }
    child.unref();
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        childProcessId: childPid,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        hostname: hostname(),
        operation: "crashed loop exec",
        pid: 2_147_483_647,
        processGroupId: childPid,
        token: "dead-wrapper-live-group",
      })}\n`
    );
    try {
      expect(() => recoverLoopLock(fixture.root, "controller")).toThrow(
        "process group"
      );
    } finally {
      process.kill(-childPid, "SIGTERM");
    }
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
  }, 30_000);

  test("refuses to adopt dirty content from an interrupted preparation", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "dirty-resume"
    );
    const inventory = captureInventory(fixture.root);
    const statePath = loopLeasePath(inventory.repository.commonGitDirectory);
    const currentLease = readLoopLease(fixture.root);
    if (!currentLease) {
      throw new Error("Expected active loop lease");
    }
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
              purpose: "dirty-resume",
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
    writeFixture(prepared.path, "unexpected.txt", "unreviewed\n");

    expect(() =>
      prepareAgentWorktree(fixture.root, lease.runId, "author", "ignored")
    ).toThrow("contains staged, unstaged, or untracked changes");
    expect(readLoopLease(fixture.root)?.preparations).toHaveLength(1);
  }, 30_000);

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

  test("requires a final accounted GitLab branch inventory before integration completion", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "complete remote-branch reconciliation receipt"
    );

    expect(() =>
      recordRemoteBranchReconciliation(
        fixture.root,
        lease.runId,
        "controller",
        {
          branches: [
            {
              classification: "canonical-target",
              disposition: "preserved-target",
              evidence: ["A claimed inventory from the wrong project."],
              finalHeadRevision: targetRevision,
              initialHeadRevision: targetRevision,
              name: "main",
              obsoleteProof: null,
              proposals: [],
              protected: true,
            },
          ],
          finalBranchCount: 1,
          finalInventoryComplete: true,
          initialBranchCount: 1,
          initialInventoryComplete: true,
          observedAt: new Date().toISOString(),
          project: "group/other-project",
          provider: "gitlab",
          schemaVersion: 1,
          targetBranch: "main",
          targetRevision,
        }
      )
    ).toThrow("must bind GitLab project group/project");

    const updated = recordRemoteBranchReconciliation(
      fixture.root,
      lease.runId,
      "controller",
      {
        branches: [
          {
            classification: "canonical-target",
            disposition: "preserved-target",
            evidence: ["GitLab final inventory contains the canonical target."],
            finalHeadRevision: targetRevision,
            initialHeadRevision: targetRevision,
            name: "main",
            obsoleteProof: null,
            proposals: [],
            protected: true,
          },
        ],
        finalBranchCount: 1,
        finalInventoryComplete: true,
        initialBranchCount: 1,
        initialInventoryComplete: true,
        observedAt: new Date().toISOString(),
        project: "group/project",
        provider: "gitlab",
        schemaVersion: 1,
        targetBranch: "main",
        targetRevision,
      }
    );

    expect(updated.remoteBranchReconciliation?.project).toBe("group/project");
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });
});
