import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  closeLoopTargetEquivalent,
  finalizeLoop,
  loopStatus,
  rebaselineLoopWorktrees,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  claimWorktree,
  takeoverWorktreeClaim,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import { auditWorktreeEquivalence } from "../../../skills/simple-changes/scripts/lib/worktree-equivalence.ts";
import {
  readWorktreeCleanups,
  refreshWorktreeIndex,
  standaloneWorktreeCleanup,
} from "../../../skills/simple-changes/scripts/lib/worktree-maintenance.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(120_000);

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

const NOTHING_TO_REBASELINE_PATTERN = /nothing to re-baseline/u;
const LEASE_REQUIRES_WORKTREE_PATTERN =
  /active loop lease still requires this claimed worktree/u;
const OWNER_ONLY_PATTERN = /Only loop owner controller/u;
const CLEANUP_REFUSED_PATTERN =
  /standalone cleanup is refused while any loop record exists/u;

describe("loop rebaseline", () => {
  test("registers late worktrees as preserved and clears the violation", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const lateWorktree = join(fixture.base, "late-unit");
    git(fixture.root, ["worktree", "add", "-b", "late-unit", lateWorktree]);
    writeFixture(lateWorktree, "wip.ts", "export const wip = 1;\n");

    const result = rebaselineLoopWorktrees(
      fixture.root,
      lease.runId,
      "controller",
      "the-user",
      "Two other agents opened worktrees after loop start."
    );

    expect(result.verification.ok).toBe(true);
    expect(result.rebaseline.registered).toHaveLength(1);
    expect(result.rebaseline.registered[0]?.path).toBe(lateWorktree);
    const registered = result.lease.worktrees.find(
      (worktree) => worktree.path === lateWorktree
    );
    expect(registered).toMatchObject({
      createdByRun: false,
      mutationAllowed: false,
      role: "preserved",
    });
    expect(result.lease.rebaselines).toHaveLength(1);
    expect(result.lease.rebaselines?.[0]).toMatchObject({
      approvedBy: "the-user",
      reason: "Two other agents opened worktrees after loop start.",
    });
    expect(existsSync(join(lateWorktree, "wip.ts"))).toBe(true);
  });

  test("refuses when there is nothing to re-baseline", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(() =>
      rebaselineLoopWorktrees(
        fixture.root,
        lease.runId,
        "controller",
        "the-user",
        "No late arrivals."
      )
    ).toThrow(NOTHING_TO_REBASELINE_PATTERN);
  });

  test("refuses a non-owner agent", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const lateWorktree = join(fixture.base, "late-unit");
    git(fixture.root, ["worktree", "add", "-b", "late-unit", lateWorktree]);

    expect(() =>
      rebaselineLoopWorktrees(
        fixture.root,
        lease.runId,
        "someone-else",
        "the-user",
        "Not the owner."
      )
    ).toThrow(OWNER_ONLY_PATTERN);
  });

  test("a rebaselined worktree that changes afterwards blocks verification again", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const lateWorktree = join(fixture.base, "late-unit");
    git(fixture.root, ["worktree", "add", "-b", "late-unit", lateWorktree]);

    const result = rebaselineLoopWorktrees(
      fixture.root,
      lease.runId,
      "controller",
      "the-user",
      "Register the late arrival."
    );
    expect(result.verification.ok).toBe(true);

    writeFixture(lateWorktree, "changed.ts", "export const changed = 1;\n");
    const status = loopStatus(fixture.root);
    expect(status.verification.ok).toBe(false);
    expect(status.verification.violations).toContainEqual(
      expect.objectContaining({
        code: "preserved-worktree-changed",
        path: lateWorktree,
      })
    );
  });

  test("unwedges the relinquished-run recovery chain: resume, rebaseline, close-equivalent", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const lateWorktree = join(fixture.base, "late-unit");
    git(fixture.root, ["worktree", "add", "-b", "late-unit", lateWorktree]);
    writeFixture(lateWorktree, "wip.ts", "export const wip = 1;\n");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "A worktree appeared after loop start."
    );
    expect(finalized.outcome).toBe("relinquished");

    const resumed = startLoop(fixture.root, "recovery-controller", "resume");
    expect(resumed.runId).toBe(lease.runId);

    const rebaselined = rebaselineLoopWorktrees(
      fixture.root,
      lease.runId,
      "recovery-controller",
      "the-user",
      "Adopt current reality; the late worktree stays untouched."
    );
    expect(rebaselined.verification.ok).toBe(true);

    const closed = closeLoopTargetEquivalent(
      fixture.root,
      lease.runId,
      "recovery-controller",
      "the-user",
      "Nothing to ship; the registered work is already in the target."
    );
    expect(closed.outcome).toBe("target-equivalent");
    expect(closed.worktrees.map((proof) => proof.path)).not.toContain(
      lateWorktree
    );
    expect(existsSync(join(lateWorktree, "wip.ts"))).toBe(true);
  });
});

describe("stale-claim takeover on lease-registered paths", () => {
  test("an active loop still protects its registered claimed worktrees, but a relinquished one does not", () => {
    const fixture = repository();
    const claimedWorktree = join(fixture.base, "stale-claimed-unit");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "stale-claimed-unit",
      claimedWorktree,
    ]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const claim = claimWorktree(
      fixture.root,
      "vanished-agent",
      claimedWorktree,
      "claude-code"
    );
    const digestFor = (): string => {
      const current = captureInventory(fixture.root).worktrees.find(
        (worktree) => worktree.path === claimedWorktree
      );
      if (!current) {
        throw new Error("claimed worktree missing from inventory");
      }
      return current.changeDigest;
    };

    expect(() =>
      takeoverWorktreeClaim({
        action: "release",
        approvedBy: "the-user",
        claimId: claim.claimId,
        expectedStatusDigest: digestFor(),
        newAgentId: "rescuer",
        reason: "The recorded owner no longer exists.",
        repositoryPath: fixture.root,
      })
    ).toThrow(LEASE_REQUIRES_WORKTREE_PATTERN);

    const lateWorktree = join(fixture.base, "late-unit");
    git(fixture.root, ["worktree", "add", "-b", "late-unit", lateWorktree]);
    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Blocked by a late worktree; the loop relinquishes."
    );
    expect(finalized.outcome).toBe("relinquished");

    const result = takeoverWorktreeClaim({
      action: "release",
      approvedBy: "the-user",
      claimId: claim.claimId,
      expectedStatusDigest: digestFor(),
      newAgentId: "rescuer",
      reason: "The recorded owner no longer exists.",
      repositoryPath: fixture.root,
    });
    expect(result.claim.state).toBe("released");
    expect(existsSync(claimedWorktree)).toBe(true);
  });
});

describe("loop status guidance", () => {
  test("with no lease it points at loop start", () => {
    const fixture = repository();
    const status = loopStatus(fixture.root);
    expect(status.guidance.headline).toBe("No active integration loop.");
    expect(status.guidance.nextCommands[0]).toContain("loop start");
  });

  test("with a late worktree it names the exact rebaseline command", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const lateWorktree = join(fixture.base, "late-unit");
    git(fixture.root, ["worktree", "add", "-b", "late-unit", lateWorktree]);

    const status = loopStatus(fixture.root);
    expect(status.verification.ok).toBe(false);
    expect(status.guidance.headline).toContain("Verification");
    expect(
      status.guidance.nextCommands.some((command) =>
        command.includes(`loop rebaseline --run-id ${lease.runId}`)
      )
    ).toBe(true);
  });

  test("for a relinquished lease it offers takeover and close-equivalent", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const lateWorktree = join(fixture.base, "late-unit");
    git(fixture.root, ["worktree", "add", "-b", "late-unit", lateWorktree]);
    finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Blocked by a late worktree."
    );

    const status = loopStatus(fixture.root);
    expect(status.guidance.headline).toContain("relinquished");
    expect(
      status.guidance.nextCommands.some((command) =>
        command.includes("loop takeover")
      )
    ).toBe(true);
    expect(
      status.guidance.nextCommands.some((command) =>
        command.includes("loop close-equivalent")
      )
    ).toBe(true);
  });

  test("for a healthy lease it names the finalize path", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const status = loopStatus(fixture.root);
    expect(status.verification.ok).toBe(true);
    expect(
      status.guidance.nextCommands.some((command) =>
        command.includes(`loop finalize --run-id ${lease.runId}`)
      )
    ).toBe(true);
  });
});

describe("standalone worktree cleanup", () => {
  test("removes proven-contained worktrees, prunes stale metadata, preserves the rest, and records a receipt", () => {
    const fixture = repository();
    const containedWorktree = join(fixture.base, "contained-unit");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "contained-unit",
      containedWorktree,
    ]);
    const dirtyWorktree = join(fixture.base, "dirty-unit");
    git(fixture.root, ["worktree", "add", "-b", "dirty-unit", dirtyWorktree]);
    writeFixture(dirtyWorktree, "wip.ts", "export const wip = 1;\n");
    const missingWorktree = join(fixture.base, "missing-unit");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "missing-unit",
      missingWorktree,
    ]);
    rmSync(missingWorktree, { force: true, recursive: true });

    const receipt = standaloneWorktreeCleanup({
      agentId: "cleaner",
      approvedBy: "the-user",
      reason: "Reconcile orphaned worktrees with no loop record.",
      repositoryPath: fixture.root,
    });

    expect(receipt.removed).toHaveLength(1);
    expect(receipt.removed[0]).toMatchObject({
      branch: "contained-unit",
      branchDeleted: true,
      containment: "target-contained",
      path: containedWorktree,
    });
    expect(existsSync(containedWorktree)).toBe(false);
    expect(git(fixture.root, ["branch", "--list", "contained-unit"])).toBe("");
    expect(receipt.prunedPaths).toEqual([missingWorktree]);
    expect(receipt.preserved).toHaveLength(1);
    expect(receipt.preserved[0]).toMatchObject({ path: dirtyWorktree });
    expect(receipt.preserved[0]?.reason).toContain("uncommitted changes");
    expect(receipt.preserved[0]?.nextCommand).toContain("worktree equivalence");
    expect(existsSync(join(dirtyWorktree, "wip.ts"))).toBe(true);
    expect(receipt.errors).toEqual([]);

    const history = readWorktreeCleanups(commonGitDirectory(fixture.root));
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.phase)).toEqual([
      "intent",
      "completed",
    ]);
    expect(history[0]).toMatchObject({
      cleanupId: receipt.cleanupId,
      plannedPrunePaths: [missingWorktree],
      plannedRemovals: [
        expect.objectContaining({
          branch: "contained-unit",
          path: containedWorktree,
        }),
      ],
      removed: [],
    });
    expect(history[1]?.cleanupId).toBe(receipt.cleanupId);
  });

  test("preserves the local branch represented by a remote target ref", () => {
    const fixture = repository();
    const targetWorktree = join(fixture.base, "target-main");
    const mergedWorktree = join(fixture.base, "merged-feature");
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["switch", "-c", "control"]);
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      join(fixture.base, "remote"),
    ]);
    git(fixture.root, [
      "update-ref",
      "refs/remotes/origin/main",
      targetRevision,
    ]);
    git(fixture.root, ["worktree", "add", targetWorktree, "main"]);
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "merged-feature",
      mergedWorktree,
      targetRevision,
    ]);

    const receipt = standaloneWorktreeCleanup({
      agentId: "cleaner",
      approvedBy: "the-user",
      reason: "Remove merged work while keeping the target checkout.",
      repositoryPath: fixture.root,
      targetRef: "origin/main",
    });

    expect(receipt.preserved).toContainEqual(
      expect.objectContaining({
        path: targetWorktree,
        reason: expect.stringContaining("target branch main"),
      })
    );
    expect(receipt.removed).toContainEqual(
      expect.objectContaining({
        branch: "merged-feature",
        path: mergedWorktree,
      })
    );
    expect(existsSync(targetWorktree)).toBe(true);
    expect(existsSync(mergedWorktree)).toBe(false);
    expect(git(fixture.root, ["branch", "--list", "main"])).toContain("main");
  });

  test("preserves legacy version 1 cleanup receipts without inventing plans", () => {
    const fixture = repository();
    const receipt = standaloneWorktreeCleanup({
      agentId: "cleaner",
      approvedBy: "the-user",
      reason: "Create a completed receipt for compatibility testing.",
      repositoryPath: fixture.root,
    });
    const legacyReceipt = {
      agentId: receipt.agentId,
      approvedBy: receipt.approvedBy,
      cleanupId: receipt.cleanupId,
      errors: receipt.errors,
      preserved: receipt.preserved,
      prunedPaths: receipt.prunedPaths,
      reason: receipt.reason,
      recordedAt: receipt.recordedAt,
      removed: receipt.removed,
      schemaVersion: 1 as const,
      targetRef: receipt.targetRef,
      targetRevision: receipt.targetRevision,
    };
    const cleanupHistoryPath = join(
      commonGitDirectory(fixture.root),
      "simple-changes",
      "worktree-coordination",
      "cleanups.json"
    );
    writeFileSync(
      cleanupHistoryPath,
      `${JSON.stringify([legacyReceipt], null, 2)}\n`
    );

    expect(readWorktreeCleanups(commonGitDirectory(fixture.root))).toEqual([
      legacyReceipt,
    ]);
  });

  test("removes a squash-merged worktree by patch equivalence", () => {
    const fixture = repository();
    const squashedWorktree = join(fixture.base, "squashed-unit");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "squashed-unit",
      squashedWorktree,
    ]);
    writeFixture(squashedWorktree, "feature.ts", "export const feature = 1;\n");
    git(squashedWorktree, ["add", "feature.ts"]);
    git(squashedWorktree, ["commit", "-m", "Feature work"]);
    const featureSha = git(squashedWorktree, ["rev-parse", "HEAD"]);
    const baseSha = git(fixture.root, ["rev-parse", "HEAD"]);
    const squashed = git(fixture.root, [
      "commit-tree",
      `${featureSha}^{tree}`,
      "-p",
      baseSha,
      "-m",
      "Squash-merge feature work",
    ]);
    git(fixture.root, ["merge", "--ff-only", squashed]);

    const receipt = standaloneWorktreeCleanup({
      agentId: "cleaner",
      approvedBy: "the-user",
      reason: "The squash merge landed; the branch is redundant.",
      repositoryPath: fixture.root,
    });

    expect(receipt.removed).toHaveLength(1);
    expect(receipt.removed[0]).toMatchObject({
      containment: "patch-equivalent",
      path: squashedWorktree,
    });
    expect(existsSync(squashedWorktree)).toBe(false);
  });

  test("preserves a live-claimed worktree with a takeover pointer", () => {
    const fixture = repository();
    const claimedWorktree = join(fixture.base, "claimed-unit");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "claimed-unit",
      claimedWorktree,
    ]);
    claimWorktree(fixture.root, "other-agent", claimedWorktree, "claude-code");

    const receipt = standaloneWorktreeCleanup({
      agentId: "cleaner",
      approvedBy: "the-user",
      reason: "Attempt cleanup around a live claim.",
      repositoryPath: fixture.root,
    });

    expect(receipt.removed).toHaveLength(0);
    expect(receipt.preserved).toHaveLength(1);
    expect(receipt.preserved[0]?.reason).toContain("live worktree claim");
    expect(receipt.preserved[0]?.nextCommand).toContain("worktree takeover");
    expect(existsSync(claimedWorktree)).toBe(true);
  });

  test("refuses while any loop record exists", () => {
    const fixture = repository();
    startLoop(fixture.root, "controller", "integrate");

    expect(() =>
      standaloneWorktreeCleanup({
        agentId: "cleaner",
        approvedBy: "the-user",
        reason: "Cleanup during a live loop.",
        repositoryPath: fixture.root,
      })
    ).toThrow(CLEANUP_REFUSED_PATTERN);
  });
});

describe("worktree index refresh", () => {
  test("prunes stale metadata only and reports the remaining inventory", () => {
    const fixture = repository();
    const keptWorktree = join(fixture.base, "kept-unit");
    git(fixture.root, ["worktree", "add", "-b", "kept-unit", keptWorktree]);
    const missingWorktree = join(fixture.base, "gone-unit");
    git(fixture.root, ["worktree", "add", "-b", "gone-unit", missingWorktree]);
    rmSync(missingWorktree, { force: true, recursive: true });

    const result = refreshWorktreeIndex(fixture.root);

    expect(result.prunedPaths).toEqual([missingWorktree]);
    expect(result.remainingWorktreePaths).toContain(keptWorktree);
    expect(result.remainingWorktreePaths).not.toContain(missingWorktree);
    expect(existsSync(keptWorktree)).toBe(true);
    expect(git(fixture.root, ["branch", "--list", "gone-unit"])).not.toBe("");
    expect(result.notes[0]).toContain("metadata only");
  });

  test("reports adapter notes for live claims", () => {
    const fixture = repository();
    const claimedWorktree = join(fixture.base, "claimed-unit");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "claimed-unit",
      claimedWorktree,
    ]);
    claimWorktree(fixture.root, "other-agent", claimedWorktree, "claude-code");

    const result = refreshWorktreeIndex(fixture.root);
    expect(result.adapterNotes).toHaveLength(1);
    expect(result.adapterNotes[0]).toMatchObject({
      adapter: "claude-code",
      worktreeIdentity: "claim-only",
    });
  });
});

describe("equivalence residue hints", () => {
  test("a contained checkout reports no residue", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "contained-unit");
    git(fixture.root, ["worktree", "add", "-b", "contained-unit", worktree]);

    const report = auditWorktreeEquivalence({
      targetRef: "main",
      worktreePath: worktree,
    });
    expect(report.equivalence).toBe("contained");
    expect(report.residue).toBeUndefined();
  });

  test("an unmatched commit whose end state already matches the target is hinted", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "semantic-unit");
    git(fixture.root, ["worktree", "add", "-b", "semantic-unit", worktree]);
    writeFixture(worktree, "notes.md", "hello world\n");
    git(worktree, ["add", "notes.md"]);
    git(worktree, ["commit", "-m", "Add notes in one step"]);
    writeFixture(fixture.root, "notes.md", "hello\n");
    git(fixture.root, ["add", "notes.md"]);
    git(fixture.root, ["commit", "-m", "Add notes"]);
    writeFixture(fixture.root, "notes.md", "hello world\n");
    git(fixture.root, ["add", "notes.md"]);
    git(fixture.root, ["commit", "-m", "Extend notes"]);

    const report = auditWorktreeEquivalence({
      targetRef: "main",
      worktreePath: worktree,
    });
    expect(report.equivalence).not.toBe("contained");
    expect(report.residue).toBeDefined();
    expect(report.residue?.commits).toHaveLength(1);
    expect(report.residue?.commits[0]).toMatchObject({
      endStateMatchesTarget: true,
      touchedPaths: ["notes.md"],
    });
    expect(report.residue?.note).toContain("not proof");
  });

  test("a dirty path differing only in whitespace is hinted", () => {
    const fixture = repository();
    writeFixture(fixture.root, "code.ts", "const value = 1;\n");
    git(fixture.root, ["add", "code.ts"]);
    git(fixture.root, ["commit", "-m", "Add code"]);
    const worktree = join(fixture.base, "whitespace-unit");
    git(fixture.root, ["worktree", "add", "-b", "whitespace-unit", worktree]);
    writeFixture(worktree, "code.ts", "const value  =  1;\n");

    const report = auditWorktreeEquivalence({
      targetRef: "main",
      worktreePath: worktree,
    });
    expect(report.paths).toContainEqual({
      path: "code.ts",
      status: "differs",
    });
    expect(report.residue?.paths).toContainEqual({
      path: "code.ts",
      whitespaceOnly: true,
    });
  });
});
