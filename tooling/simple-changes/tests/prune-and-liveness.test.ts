import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, spawnSync } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  guardLoopMutation,
  LEASE_STALE_AFTER_MS,
  leaseLiveness,
  loopManifestDigest,
  loopLeasePath,
  loopStatus,
  readLoopLease,
  recoverStaleLoopLease,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import { claimWorktree } from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import { pruneRepository } from "../../../skills/simple-changes/scripts/lib/worktree-maintenance.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(120_000);

const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const APPROVER_REQUIRED_PATTERN = /approver is required/u;
const REASON_REQUIRED_PATTERN = /prune reason is required/u;
const LIVE_LEASE_PATTERN = /is live, not stale/u;

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

const commonGitDirectory = (root: string): string =>
  captureInventory(root).repository.commonGitDirectory;

const readLeaseFile = (root: string): LoopLease =>
  JSON.parse(
    readFileSync(loopLeasePath(commonGitDirectory(root)), "utf8")
  ) as LoopLease;

const writeLeaseFile = (root: string, lease: LoopLease): void => {
  writeFileSync(
    loopLeasePath(commonGitDirectory(root)),
    `${JSON.stringify(lease, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
};

const branchExists = (root: string, branch: string): boolean =>
  git(root, ["branch", "--list", branch]) !== "";

const addMergedWorktree = (
  fixture: TestRepository,
  name: string
): { headSha: string; path: string } => {
  const path = join(fixture.base, name);
  git(fixture.root, ["worktree", "add", "-b", name, path]);
  writeFixture(
    path,
    `${name}.ts`,
    `export const ${name.replace(/-/gu, "_")} = 1;\n`
  );
  git(path, ["add", "."]);
  git(path, ["commit", "-m", `Work in ${name}`]);
  const headSha = git(path, ["rev-parse", "HEAD"]);
  git(fixture.root, ["merge", "--no-ff", "-m", `Merge ${name}`, headSha]);
  return { headSha, path };
};

const addUnmergedBranch = (fixture: TestRepository, name: string): void => {
  const path = join(fixture.base, `${name}-checkout`);
  git(fixture.root, ["worktree", "add", "-b", name, path]);
  writeFixture(path, `${name}.ts`, `export const unmerged = "${name}";\n`);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", `Unmerged work on ${name}`]);
  git(fixture.root, ["worktree", "remove", path]);
};

const addSquashMergedBranch = (
  fixture: TestRepository,
  name: string
): string => {
  const path = join(fixture.base, `${name}-checkout`);
  git(fixture.root, ["worktree", "add", "-b", name, path]);
  writeFixture(path, `${name}.ts`, `export const squashed = "${name}";\n`);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", `Squash source ${name}`]);
  const headSha = git(path, ["rev-parse", "HEAD"]);
  git(fixture.root, ["worktree", "remove", path]);
  const squashed = git(fixture.root, [
    "commit-tree",
    `${headSha}^{tree}`,
    "-p",
    "HEAD",
    "-m",
    `Squash-merged: ${name}`,
  ]);
  git(fixture.root, ["reset", "--hard", squashed]);
  return headSha;
};

describe("simple-changes prune", () => {
  test("removes proven-contained checkouts and merged branches with no lease at all", () => {
    const fixture = repository();
    const merged = addMergedWorktree(fixture, "merged-unit");
    addSquashMergedBranch(fixture, "squashed-unit");
    const dirty = addMergedWorktree(fixture, "dirty-unit");
    writeFixture(dirty.path, "wip.ts", "export const wip = 1;\n");
    const claimed = addMergedWorktree(fixture, "claimed-unit");
    claimWorktree(
      claimed.path,
      "other-author",
      claimed.path,
      "codex-desktop",
      "task-claimed"
    );
    const unique = join(fixture.base, "unique-unit");
    git(fixture.root, ["worktree", "add", "-b", "unique-unit", unique]);
    writeFixture(unique, "unique.ts", "export const unique = 1;\n");
    git(unique, ["add", "."]);
    git(unique, ["commit", "-m", "Genuinely unique work"]);
    addUnmergedBranch(fixture, "unmerged-branch");

    const report = pruneRepository({
      approvedBy: "the-user",
      dryRun: false,
      reason: "The merged agent stopped without finalizing.",
      repositoryPath: fixture.root,
    });

    expect(report.lease).toBeNull();
    expect(report.removed.map((entry) => entry.path)).toEqual([merged.path]);
    expect(report.removed[0]).toMatchObject({
      containment: "target-contained",
      headSha: merged.headSha,
      path: merged.path,
    });
    expect(existsSync(merged.path)).toBe(false);
    expect(report.removedBranches).toContainEqual(
      expect.objectContaining({
        branch: "squashed-unit",
        method: "patch-equivalent",
      })
    );
    expect(branchExists(fixture.root, "squashed-unit")).toBe(false);
    const preservedPaths = report.preserved.map((entry) => entry.path);
    expect(preservedPaths).toContain(dirty.path);
    expect(preservedPaths).toContain(claimed.path);
    expect(preservedPaths).toContain(unique);
    expect(existsSync(dirty.path)).toBe(true);
    expect(existsSync(claimed.path)).toBe(true);
    expect(existsSync(unique)).toBe(true);
    expect(branchExists(fixture.root, "unique-unit")).toBe(true);
    expect(report.preservedBranches).toContainEqual({
      branch: "unmerged-branch",
      reason:
        "The branch has commits that are neither contained in nor patch-equivalent to the refreshed target.",
    });
    expect(branchExists(fixture.root, "unmerged-branch")).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("prunes stale worktree metadata whose directory is gone", () => {
    const fixture = repository();
    const merged = addMergedWorktree(fixture, "vanished-unit");
    git(fixture.root, ["worktree", "lock", merged.path]);
    git(fixture.root, ["worktree", "unlock", merged.path]);
    rmSync(merged.path, { force: true, recursive: true });

    const report = pruneRepository({
      approvedBy: "the-user",
      dryRun: false,
      reason: "Reconcile a checkout that was deleted by hand.",
      repositoryPath: fixture.root,
    });

    expect(report.prunedPaths).toEqual([merged.path]);
    expect(
      captureInventory(fixture.root).worktrees.map((worktree) => worktree.path)
    ).not.toContain(merged.path);
  });

  test("refuses to touch anything an active non-stale lease registers", () => {
    const fixture = repository();
    const registered = addMergedWorktree(fixture, "registered-unit");
    const lease = startLoop(fixture.root, "controller", "integrate");
    expect(
      lease.worktrees.some((worktree) => worktree.path === registered.path)
    ).toBe(true);
    const unrelated = addMergedWorktree(fixture, "unrelated-unit");

    const report = pruneRepository({
      approvedBy: "the-user",
      dryRun: false,
      reason: "Clean up around a running loop.",
      repositoryPath: fixture.root,
    });

    expect(report.lease).toMatchObject({
      runId: lease.runId,
      scope: "everything-registered",
    });
    expect(report.lease?.protectedPaths).toContain(registered.path);
    expect(report.removed.map((entry) => entry.path)).toEqual([unrelated.path]);
    expect(existsSync(registered.path)).toBe(true);
    expect(existsSync(unrelated.path)).toBe(false);
    expect(
      report.preserved.find((entry) => entry.path === registered.path)?.reason
    ).toContain(lease.runId);
    expect(branchExists(fixture.root, "registered-unit")).toBe(true);
    expect(readLoopLease(fixture.root)?.runId).toBe(lease.runId);
  });

  test("--dry-run reports the exact plan and mutates nothing", () => {
    const fixture = repository();
    const merged = addMergedWorktree(fixture, "planned-unit");
    addSquashMergedBranch(fixture, "planned-branch");

    const report = pruneRepository({
      dryRun: true,
      repositoryPath: fixture.root,
    });

    expect(report.dryRun).toBe(true);
    expect(report.plannedRemovals).toEqual([
      {
        branch: "planned-unit",
        containment: "target-contained",
        headSha: merged.headSha,
        path: merged.path,
      },
    ]);
    expect(report.plannedBranchRemovals).toContainEqual(
      expect.objectContaining({
        branch: "planned-branch",
        method: "patch-equivalent",
      })
    );
    expect(report.removed).toEqual([]);
    expect(report.removedBranches).toEqual([]);
    expect(existsSync(merged.path)).toBe(true);
    expect(branchExists(fixture.root, "planned-branch")).toBe(true);
  });

  test("requires an approver and a reason for the destructive form", () => {
    const fixture = repository();

    expect(() =>
      pruneRepository({ dryRun: false, repositoryPath: fixture.root })
    ).toThrow(APPROVER_REQUIRED_PATTERN);
    expect(() =>
      pruneRepository({
        approvedBy: "the-user",
        dryRun: false,
        repositoryPath: fixture.root,
      })
    ).toThrow(REASON_REQUIRED_PATTERN);
  });
});

describe("simple-changes prune command surface", () => {
  test("documents prune in help and reports a dry-run plan as JSON", () => {
    const fixture = repository();
    const merged = addMergedWorktree(fixture, "cli-unit");

    const help = decoder.decode(
      spawnSync([process.execPath, cliPath, "help"], {
        stderr: "pipe",
        stdout: "pipe",
      }).stdout
    );
    expect(help).toContain(
      "simple-changes prune --approved-by ID --reason TEXT"
    );

    const planned = spawnSync(
      [
        process.execPath,
        cliPath,
        "prune",
        "--dry-run",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(planned.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(planned.stdout))).toMatchObject({
      dryRun: true,
      lease: null,
      plannedRemovals: [
        expect.objectContaining({
          containment: "target-contained",
          path: merged.path,
        }),
      ],
      removed: [],
    });
    expect(existsSync(merged.path)).toBe(true);

    const refused = spawnSync(
      [process.execPath, cliPath, "prune", "--json", "--repo", fixture.root],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(refused.exitCode).toBe(2);
    expect(decoder.decode(refused.stderr)).toContain("approver is required");
  });
});

describe("loop lease liveness", () => {
  test("treats a fresh lease as live", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");

    const liveness = leaseLiveness(lease);

    expect(liveness.state).toBe("live");
    expect(liveness.lastUpdatedAt).toBe(lease.updatedAt);
  });

  test("treats an unprovable owner with an old heartbeat as stale", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const quiet: LoopLease = {
      ...lease,
      updatedAt: new Date(
        Date.now() - LEASE_STALE_AFTER_MS - 60_000
      ).toISOString(),
    };

    const liveness = leaseLiveness(quiet);

    expect(quiet.ownerProcess).toBeUndefined();
    expect(liveness).toMatchObject({
      ownerProcessProvable: false,
      state: "stale",
    });
    expect(liveness.ageMs).toBeGreaterThan(LEASE_STALE_AFTER_MS);
  });

  test("keeps a lease live while its recorded owner process is running", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(
      leaseLiveness({
        ...lease,
        ownerProcess: {
          hostname: hostname(),
          pid: process.pid,
          recordedAt: lease.updatedAt,
        },
        updatedAt: new Date(
          Date.now() - LEASE_STALE_AFTER_MS - 60_000
        ).toISOString(),
      })
    ).toMatchObject({ ownerProcessProvable: true, state: "live" });
  });

  test("a guarded operation advances the recorded heartbeat", async () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    await sleep(5);

    guardLoopMutation(fixture.root, lease.runId, "controller");

    const beat = readLeaseFile(fixture.root);
    expect(Date.parse(beat.updatedAt)).toBeGreaterThan(
      Date.parse(lease.updatedAt)
    );
    expect(beat.ownerProcess).toMatchObject({
      hostname: hostname(),
      pid: process.pid,
    });
    expect(leaseLiveness(beat).state).toBe("live");
  });

  test("a heartbeat does not invalidate the manifest digest", async () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const digestBeforeHeartbeat = loopManifestDigest(lease);
    await sleep(5);

    guardLoopMutation(fixture.root, lease.runId, "controller");

    const beat = readLeaseFile(fixture.root);
    expect(Date.parse(beat.updatedAt)).toBeGreaterThan(
      Date.parse(lease.updatedAt)
    );
    expect(loopManifestDigest(beat)).toBe(digestBeforeHeartbeat);
  });

  test("loop status reports liveness without parsing timestamps", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    writeLeaseFile(fixture.root, {
      ...lease,
      updatedAt: new Date(
        Date.now() - LEASE_STALE_AFTER_MS - 60_000
      ).toISOString(),
    });

    const status = loopStatus(fixture.root);

    expect(status.liveness?.state).toBe("stale");
    expect(status.guidance.nextCommands[0]).toContain("--stale-lease");
  });
});

describe("stale loop-lease recovery", () => {
  const makeStale = (root: string, lease: LoopLease): LoopLease => {
    const quiet: LoopLease = {
      ...lease,
      updatedAt: new Date(
        Date.now() - LEASE_STALE_AFTER_MS - 60_000
      ).toISOString(),
    };
    writeLeaseFile(root, quiet);
    return quiet;
  };

  test("refuses a live lease", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(() =>
      recoverStaleLoopLease(
        fixture.root,
        lease.runId,
        "rescuer",
        "the-user",
        "Try to clear a running loop."
      )
    ).toThrow(LIVE_LEASE_PATTERN);
    expect(readLoopLease(fixture.root)?.runId).toBe(lease.runId);
  });

  test("clears a stale lease, archives it, and preserves every worktree", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "author-unit");
    git(fixture.root, ["worktree", "add", "-b", "author-unit", worktree]);
    writeFixture(worktree, "unit.ts", "export const unit = 1;\n");
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "-m", "Author work"]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const stale = makeStale(fixture.root, lease);

    const receipt = recoverStaleLoopLease(
      fixture.root,
      lease.runId,
      "rescuer",
      "the-user",
      "The owner died 14 hours ago and blocks every other agent."
    );

    expect(receipt).toMatchObject({
      agentId: "rescuer",
      approvedBy: "the-user",
      kind: "stale-lease-recovery",
      ownerAgentId: "controller",
      runId: lease.runId,
      schemaVersion: 1,
      staleAfterMs: LEASE_STALE_AFTER_MS,
    });
    expect(receipt.liveness).toMatchObject({
      lastUpdatedAt: stale.updatedAt,
      ownerProcessProvable: false,
      state: "stale",
    });
    expect(receipt.preservedWorktreePaths).toContain(worktree);
    expect(readLoopLease(fixture.root)).toBeNull();
    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(join(worktree, "unit.ts"))).toBe(true);
    expect(branchExists(fixture.root, "author-unit")).toBe(true);
    const archive = join(
      commonGitDirectory(fixture.root),
      "simple-changes",
      "history",
      lease.runId,
      "stale-lease-recovery.json"
    );
    expect(existsSync(archive)).toBe(true);
    expect(JSON.parse(readFileSync(archive, "utf8"))).toMatchObject({
      kind: "stale-lease-recovery",
      runId: lease.runId,
    });
  });

  test("replays its archived receipt instead of recovering twice", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    makeStale(fixture.root, lease);
    const first = recoverStaleLoopLease(
      fixture.root,
      lease.runId,
      "rescuer",
      "the-user",
      "Clear the abandoned lease."
    );

    const replay = recoverStaleLoopLease(
      fixture.root,
      lease.runId,
      "rescuer",
      "the-user",
      "Clear the abandoned lease."
    );

    expect(replay).toEqual(first);
  });

  test("lets prune clean unregistered state once the stale lease is cleared", () => {
    const fixture = repository();
    const merged = addMergedWorktree(fixture, "abandoned-unit");
    const lease = startLoop(fixture.root, "controller", "integrate");
    makeStale(fixture.root, lease);
    recoverStaleLoopLease(
      fixture.root,
      lease.runId,
      "rescuer",
      "the-user",
      "The owner merged and vanished."
    );

    const report = pruneRepository({
      approvedBy: "the-user",
      dryRun: false,
      reason: "Finish the cleanup the dead owner never ran.",
      repositoryPath: fixture.root,
    });

    expect(report.lease).toBeNull();
    expect(report.removed.map((entry) => entry.path)).toEqual([merged.path]);
    expect(existsSync(merged.path)).toBe(false);
  });
});
