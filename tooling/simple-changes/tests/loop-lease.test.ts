import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { sleep } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  acceptPausedWorktreeChange,
  authorizeWorktreeRemoval,
  emergencyShippingStatus,
  endLoop,
  executeLoopMutation,
  finalizeLoop,
  grantLoopOverride,
  guardLoopMutation,
  loopLeasePath,
  loopLockPath,
  loopManifestDigest,
  loopStatus,
  prepareAgentWorktree,
  readLoopLease,
  recordEmergencyShipping,
  recordRemoteBranchReconciliation,
  recoverLoopLock,
  retainExcludedWorktree,
  startLoop,
  takeoverLoop,
  verifyLoop,
  withLoopMutationLease,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  pauseClaimedWorktree,
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

const paginationCoverage = (
  branches: number,
  branchDigest: string,
  proposals = 0,
  proposalDigest = createHash("sha256").update("[]").digest("hex")
) => ({
  branches: {
    pages: [
      {
        cursorIn: null,
        cursorOut: null,
        itemCount: branches,
        responseDigest: branchDigest,
      },
    ],
  },
  proposalStates: ["closed", "merged", "open"] as const,
  proposals: {
    pages: [
      {
        cursorIn: null,
        cursorOut: null,
        itemCount: proposals,
        responseDigest: proposalDigest,
      },
    ],
  },
});

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("active integration-loop lease", () => {
  test("reads and safely verifies a pre-remote-binding lease", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const inventory = captureInventory(fixture.root);
    const leasePath = loopLeasePath(inventory.repository.commonGitDirectory);
    const { remoteBindings: _remoteBindings, ...legacy } = lease;
    writeFileSync(leasePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    expect(readLoopLease(fixture.root)?.remoteBindings).toBeUndefined();
    expect(verifyLoop(fixture.root)).toMatchObject({ active: true, ok: true });
  });

  test("recovers a lease with a legacy reconciliation as refresh-required", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const inventory = captureInventory(fixture.root);
    const leasePath = loopLeasePath(inventory.repository.commonGitDirectory);
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        ...lease,
        remoteBranchReconciliation: {
          branches: [],
          finalInventoryComplete: true,
          initialInventoryComplete: true,
          observedAt: new Date().toISOString(),
          project: "group/project",
          provider: "gitlab",
          schemaVersion: 1,
          targetBranch: "main",
          targetRevision: lease.targetRevision,
        },
      })}\n`,
      "utf8"
    );

    expect(
      readLoopLease(fixture.root)?.remoteBranchReconciliation
    ).toBeUndefined();
    expect(verifyLoop(fixture.root)).toMatchObject({ active: true, ok: true });
  });

  test("rejects a remote destination change after loop start", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://gitlab.example.invalid/group/first.git",
    ]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    expect(lease.remoteBindings?.[0]?.pushUrls).toEqual([
      "https://gitlab.example.invalid/group/first.git",
    ]);

    git(fixture.root, [
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://gitlab.example.invalid/group/second.git",
    ]);
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({ code: "remote-destination-changed" })
    );
  });
  test("does not require GitLab cleanup for an auxiliary GitLab remote", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://github.com/example/canonical.git",
    ]);
    git(fixture.root, [
      "remote",
      "add",
      "gitlab-mirror",
      "https://gitlab.example.invalid/example/mirror.git",
    ]);
    git(fixture.root, ["config", "branch.main.remote", "origin"]);
    git(fixture.root, ["config", "branch.main.merge", "refs/heads/main"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(captureInventory(fixture.root).repository.targetRemote).toBe(
      "origin"
    );
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });
  test("relinquishes an incomplete loop and lets the next controller resume the same run", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "first-controller", "ship");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "unfinished unit"
    );

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "first-controller",
      "Agent turn finished before shipping reconciliation completed."
    );

    expect(finalized).toMatchObject({
      lease: {
        controller: {
          reason:
            "Agent turn finished before shipping reconciliation completed.",
          status: "relinquished",
        },
        ownerAgentId: "first-controller",
        runId: lease.runId,
      },
      outcome: "relinquished",
    });
    expect(finalized.blockers).toContainEqual(
      expect.stringContaining("run-created worktrees")
    );
    expect(() =>
      guardLoopMutation(fixture.root, lease.runId, "first-controller")
    ).toThrow("relinquished");

    const resumed = startLoop(fixture.root, "next-controller", "resume");
    expect(resumed).toMatchObject({
      controller: {
        handoffs: [
          expect.objectContaining({
            fromAgentId: "first-controller",
            kind: "resume",
            toAgentId: "next-controller",
          }),
        ],
        status: "active",
      },
      mode: "ship",
      ownerAgentId: "next-controller",
      runId: lease.runId,
    });
    expect(resumed.worktrees).toContainEqual(
      expect.objectContaining({ path: prepared.path, role: "author" })
    );
    expect(
      guardLoopMutation(fixture.root, lease.runId, "next-controller").ok
    ).toBe(true);
  }, 20_000);

  test("closes a complete loop during terminal finalization", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(
      finalizeLoop(
        fixture.root,
        lease.runId,
        "controller",
        "All integration work completed."
      )
    ).toMatchObject({ blockers: [], outcome: "completed" });
    expect(readLoopLease(fixture.root)).toBeNull();
  });

  test("refuses completion while a target-contained local branch remains", () => {
    const fixture = repository();
    git(fixture.root, ["branch", "merged-unit"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "A merged local branch still needs cleanup."
    );

    expect(finalized).toMatchObject({
      blockers: [expect.stringContaining("merged-unit")],
      outcome: "relinquished",
    });
  });

  test("refuses completion while a clean merged worktree remains", () => {
    const fixture = repository();
    const mergedWorktree = join(fixture.base, "merged-unit");
    git(fixture.root, ["worktree", "add", "-b", "merged-unit", mergedWorktree]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "A clean merged worktree still needs cleanup."
    );

    expect(finalized).toMatchObject({
      blockers: [expect.stringContaining(mergedWorktree)],
      outcome: "relinquished",
    });
  });

  test("refuses completion while the local target trails the refreshed target", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/canonical.git",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    git(fixture.root, ["checkout", "--detach"]);
    writeFixture(fixture.root, "remote.txt", "remote target\n");
    git(fixture.root, ["add", "remote.txt"]);
    git(fixture.root, ["commit", "-m", "Advance remote target"]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, ["checkout", "main"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The local target still needs its guarded update."
    );

    expect(finalized).toMatchObject({
      blockers: [expect.stringContaining("Update local target branch main")],
      outcome: "relinquished",
    });
  });

  test("preserves dirty worktrees and branches with unique commits", () => {
    const fixture = repository();
    const dirtyWorktree = join(fixture.base, "dirty-work");
    git(fixture.root, ["worktree", "add", "-b", "dirty-work", dirtyWorktree]);
    writeFixture(dirtyWorktree, "dirty.txt", "preserve me\n");
    git(fixture.root, ["branch", "unique-work"]);
    git(fixture.root, ["checkout", "unique-work"]);
    writeFixture(fixture.root, "unique.txt", "unique commit\n");
    git(fixture.root, ["add", "unique.txt"]);
    git(fixture.root, ["commit", "-m", "Unique work"]);
    git(fixture.root, ["checkout", "main"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(
      finalizeLoop(
        fixture.root,
        lease.runId,
        "controller",
        "Only preserved work remains."
      )
    ).toMatchObject({ blockers: [], outcome: "completed" });
  });

  test("refuses completion until the primary checkout is restored", () => {
    const fixture = repository();
    git(fixture.root, ["checkout", "-b", "merged-controller"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The primary checkout still needs restoration."
    );

    expect(finalized.blockers).toContainEqual(
      expect.stringContaining("Restore primary checkout")
    );
    expect(finalized.outcome).toBe("relinquished");
  });

  test("refuses completion while the primary checkout is dirty", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    writeFixture(fixture.root, "unfinished.txt", "preserve me\n");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The primary checkout still has unfinished changes."
    );

    expect(finalized.blockers).toContainEqual(
      expect.stringContaining("Clean primary checkout")
    );
    expect(finalized.outcome).toBe("relinquished");
  });

  test("relinquishes instead of stranding the controller when the target is unresolved", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/canonical.git",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    git(fixture.root, ["update-ref", "-d", "refs/remotes/origin/main"]);

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The target ref disappeared before finalization."
    );

    expect(finalized.blockers).toContainEqual(
      expect.stringContaining("Refresh unresolved target ref origin/main")
    );
    expect(finalized).toMatchObject({
      lease: { controller: { status: "relinquished" } },
      outcome: "relinquished",
    });
  });

  test("refuses completion while a clean target-contained detached worktree remains", () => {
    const fixture = repository();
    const detachedWorktree = join(fixture.base, "detached-merged-unit");
    git(fixture.root, [
      "worktree",
      "add",
      "--detach",
      detachedWorktree,
      "HEAD",
    ]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "A clean detached worktree still needs cleanup."
    );

    expect(finalized.blockers).toContainEqual(
      expect.stringContaining(detachedWorktree)
    );
    expect(finalized.outcome).toBe("relinquished");
  });

  test("requires exact user-authorized evidence to take over an active controller", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "abandoned-controller", "ship");
    const digest = loopManifestDigest(lease);

    expect(() =>
      takeoverLoop(
        fixture.root,
        lease.runId,
        "replacement-controller",
        "0".repeat(64),
        "repository-owner",
        "The prior controller ended without finalizing."
      )
    ).toThrow("manifest digest");

    const resumed = takeoverLoop(
      fixture.root,
      lease.runId,
      "replacement-controller",
      digest,
      "repository-owner",
      "The prior controller ended without finalizing."
    );
    expect(resumed).toMatchObject({
      controller: {
        handoffs: [
          expect.objectContaining({
            approvedBy: "repository-owner",
            fromAgentId: "abandoned-controller",
            kind: "takeover",
            toAgentId: "replacement-controller",
          }),
        ],
        status: "active",
      },
      ownerAgentId: "replacement-controller",
      runId: lease.runId,
    });
  });

  test("keeps a relinquished manifest immutable while new concurrent claims appear", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "first-controller", "ship");
    prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "unfinished-author",
      "unfinished unit"
    );
    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "first-controller",
      "The controller turn ended with unfinished work."
    );
    const manifestDigest = loopManifestDigest(
      finalized.lease as NonNullable<typeof finalized.lease>
    );
    const statePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const originalState = readFileSync(statePath, "utf8");
    const concurrentPath = join(fixture.base, "late-concurrent-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "late-concurrent-author",
      concurrentPath,
    ]);
    claimWorktree(
      fixture.root,
      "late-agent",
      concurrentPath,
      "codex",
      "late-task"
    );

    expect(() =>
      guardLoopMutation(fixture.root, lease.runId, "first-controller")
    ).toThrow("relinquished");
    expect(readFileSync(statePath, "utf8")).toBe(originalState);
    expect(
      loopManifestDigest(loopStatus(fixture.root).lease as LoopLease)
    ).toBe(manifestDigest);
    expect(() =>
      takeoverLoop(
        fixture.root,
        lease.runId,
        "replacement-controller",
        "0".repeat(64),
        "repository-owner",
        "The prior controller disappeared."
      )
    ).toThrow("manifest digest");
    expect(readFileSync(statePath, "utf8")).toBe(originalState);

    expect(
      takeoverLoop(
        fixture.root,
        lease.runId,
        "replacement-controller",
        manifestDigest,
        "repository-owner",
        "The prior controller disappeared."
      ).ownerAgentId
    ).toBe("replacement-controller");
  }, 20_000);

  test("persists and resumes Emergency Shipping state under the loop lease", async () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const candidateRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const initial = {
      artifactEquivalenceProven: false,
      authoritySource: null,
      breakGlassAuthorized: false,
      candidateArtifactId: null,
      candidateRevision,
      candidateVerifiedHealthy: false,
      canonicalArtifactId: null,
      canonicalRevision: null,
      changelogReconciled: false,
      cleanupCompleted: false,
      deployedArtifactId: null,
      deployedRevision: null,
      evidence: ["urgency-language"] as const,
      finalVerificationPassed: false,
      focusedChecksPassed: false,
      independentReview: "pending" as const,
      mergeCompleted: false,
      mode: "expedited" as const,
      previousProductionRevision: null,
      productionAuthorized: false,
      redeployDecision: "pending" as const,
      rollbackAnchorRecorded: false,
      rollbackSupported: false,
      status: "ready" as const,
    };

    await recordEmergencyShipping(
      fixture.root,
      lease.runId,
      "controller",
      initial
    );

    expect(readLoopLease(fixture.root)?.emergencyShipping?.status).toBe(
      "ready"
    );
    expect(emergencyShippingStatus(fixture.root, lease.runId)).toMatchObject({
      decision: { action: "request-production-approval" },
      state: { candidateRevision, status: "ready" },
    });
    await recordEmergencyShipping(fixture.root, lease.runId, "controller", {
      ...initial,
      authoritySource: "explicit-current-request",
      breakGlassAuthorized: true,
      evidence: ["urgency-language", "deploy-before-review"],
      mode: "break-glass",
      rollbackSupported: true,
    });
    expect(
      emergencyShippingStatus(fixture.root, lease.runId).state
    ).toMatchObject({
      authoritySource: "explicit-current-request",
      breakGlassAuthorized: true,
      mode: "break-glass",
      rollbackSupported: true,
    });
    await recordEmergencyShipping(fixture.root, lease.runId, "controller", {
      ...initial,
      authoritySource: "explicit-current-request",
      breakGlassAuthorized: true,
      candidateArtifactId: "candidate-artifact-a",
      evidence: ["urgency-language", "deploy-before-review"],
      mode: "break-glass",
      rollbackSupported: true,
    });
    await expect(
      recordEmergencyShipping(fixture.root, lease.runId, "controller", {
        ...initial,
        authoritySource: "explicit-current-request",
        breakGlassAuthorized: true,
        candidateArtifactId: "candidate-artifact-b",
        evidence: ["urgency-language", "deploy-before-review"],
        mode: "break-glass",
        rollbackSupported: true,
      })
    ).rejects.toThrow("cannot replace recorded identity: candidateArtifactId");
    await expect(
      recordEmergencyShipping(fixture.root, lease.runId, "controller", {
        ...initial,
        authoritySource: "confirmed-run-only",
        breakGlassAuthorized: true,
        candidateArtifactId: "candidate-artifact-a",
        evidence: ["urgency-language", "deploy-before-review"],
        mode: "break-glass",
        rollbackSupported: true,
      })
    ).rejects.toThrow("authority source cannot be replaced");
    await expect(
      recordEmergencyShipping(fixture.root, lease.runId, "controller", {
        ...initial,
        authoritySource: "explicit-current-request",
        breakGlassAuthorized: true,
        candidateArtifactId: "candidate-artifact-a",
        evidence: ["deploy-before-review"],
        mode: "break-glass",
        rollbackSupported: true,
      })
    ).rejects.toThrow("evidence labels cannot be removed");
    await expect(
      recordEmergencyShipping(fixture.root, lease.runId, "controller", {
        ...initial,
        authoritySource: "explicit-current-request",
        breakGlassAuthorized: true,
        candidateArtifactId: "candidate-artifact-a",
        evidence: ["urgency-language", "deploy-before-review"],
        mode: "break-glass",
        rollbackSupported: false,
      })
    ).rejects.toThrow("cannot clear completed evidence: rollbackSupported");
    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "Emergency Shipping remains incomplete"
    );
  });
  test("inspects loop status without writing Git metadata", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const statePath = join(fixture.root, ".git", "simple-changes");

    chmodSync(statePath, 0o500);
    try {
      const status = loopStatus(fixture.root);

      expect(status.lease?.runId).toBe(lease.runId);
      expect(status.verification).toMatchObject({
        active: true,
        ok: true,
        runId: lease.runId,
      });
    } finally {
      chmodSync(statePath, 0o700);
    }
  });

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

  test("retains an exact clean late worktree without deleting or shipping it", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const walkthrough = join(fixture.base, "driver-walkthrough");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "driver-walkthrough",
      walkthrough,
    ]);
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === walkthrough
    );
    if (!current) {
      throw new Error("Expected the walkthrough worktree");
    }

    const retained = retainExcludedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      walkthrough,
      current.changeDigest,
      "user",
      "Keep the unrelated walkthrough worktree out of this shipment."
    );

    expect(retained.worktrees).toContainEqual(
      expect.objectContaining({
        baselineChangeDigest: current.changeDigest,
        baselineHeadSha: current.headSha,
        mutationAllowed: false,
        path: walkthrough,
        role: "retained",
      })
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(
      finalizeLoop(
        fixture.root,
        lease.runId,
        "controller",
        "The unrelated worktree is retained by exact evidence."
      )
    ).toMatchObject({ blockers: [], outcome: "completed" });
    expect(captureInventory(fixture.root).worktrees).toContainEqual(
      expect.objectContaining({ path: walkthrough })
    );
  });

  test("invalidates retention when work starts, then admits the owner's claim", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const walkthrough = join(fixture.base, "driver-walkthrough");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "driver-walkthrough",
      walkthrough,
    ]);
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === walkthrough
    );
    if (!current) {
      throw new Error("Expected the walkthrough worktree");
    }
    retainExcludedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      walkthrough,
      current.changeDigest,
      "user",
      "Keep unrelated walkthrough work out of this shipment."
    );

    writeFixture(walkthrough, "0339_walkthrough.sql", "select 1;\n");
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "retained-worktree-changed",
        path: walkthrough,
      })
    );

    const claim = claimWorktree(
      walkthrough,
      "walkthrough-author",
      walkthrough,
      "codex-desktop",
      "task-driver-walkthrough"
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(readLoopLease(fixture.root)?.worktrees).toContainEqual(
      expect.objectContaining({
        agentId: "walkthrough-author",
        claimId: claim.claimId,
        mutationAllowed: true,
        path: walkthrough,
        role: "concurrent-author",
      })
    );
  });

  test("accepts an exact pause after a retained worktree was promoted", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const walkthrough = join(fixture.base, "retained-promoted-paused");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "retained-promoted-paused",
      walkthrough,
    ]);
    const opening = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === walkthrough
    );
    if (!opening) {
      throw new Error("Expected the retained worktree");
    }
    retainExcludedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      walkthrough,
      opening.changeDigest,
      "user",
      "Keep unrelated walkthrough work out of this shipment."
    );

    writeFixture(
      walkthrough,
      "walkthrough.ts",
      "export const active = true;\n"
    );
    claimWorktree(
      walkthrough,
      "walkthrough-author",
      walkthrough,
      "codex-desktop",
      "task-walkthrough"
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(readLoopLease(fixture.root)?.worktrees).toContainEqual(
      expect.objectContaining({
        path: walkthrough,
        role: "concurrent-author",
      })
    );

    const receipt = pauseClaimedWorktree(
      walkthrough,
      "walkthrough-author",
      walkthrough,
      lease.runId,
      "preserve-in-place",
      "Pause at a stable boundary for integration."
    );
    expect(verifyLoop(fixture.root).ok).toBe(false);

    const accepted = acceptPausedWorktreeChange(
      fixture.root,
      lease.runId,
      "controller",
      receipt.receiptId
    );
    expect(accepted.worktrees).toContainEqual(
      expect.objectContaining({
        agentId: null,
        claimId: receipt.claimId,
        coordinationState: "adopted-preserved",
        mutationAllowed: false,
        path: walkthrough,
        pauseReceiptId: receipt.receiptId,
        role: "preserved",
      })
    );
    expect(
      accepted.worktrees.find((worktree) => worktree.path === walkthrough)
        ?.retention
    ).toBeUndefined();
    expect(verifyLoop(fixture.root).ok).toBe(true);
  }, 20_000);

  test("accepts an exact pause before retained worktree promotion", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const walkthrough = join(fixture.base, "retained-paused-first");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "retained-paused-first",
      walkthrough,
    ]);
    const opening = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === walkthrough
    );
    if (!opening) {
      throw new Error("Expected the retained worktree");
    }
    retainExcludedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      walkthrough,
      opening.changeDigest,
      "user",
      "Keep unrelated walkthrough work out of this shipment."
    );

    writeFixture(
      walkthrough,
      "walkthrough.ts",
      "export const active = true;\n"
    );
    claimWorktree(
      walkthrough,
      "walkthrough-author",
      walkthrough,
      "codex-desktop",
      "task-walkthrough"
    );
    const receipt = pauseClaimedWorktree(
      walkthrough,
      "walkthrough-author",
      walkthrough,
      lease.runId,
      "preserve-in-place",
      "Pause before the controller observes the active claim."
    );

    const accepted = acceptPausedWorktreeChange(
      fixture.root,
      lease.runId,
      "controller",
      receipt.receiptId
    );
    expect(accepted.worktrees).toContainEqual(
      expect.objectContaining({
        path: walkthrough,
        role: "preserved",
      })
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
  }, 30_000);

  test("requires an active claim or pause before retaining a dirty worktree", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const walkthrough = join(fixture.base, "driver-walkthrough");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "driver-walkthrough",
      walkthrough,
    ]);
    writeFixture(
      walkthrough,
      "walkthrough.ts",
      "export const active = true;\n"
    );
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === walkthrough
    );
    if (!current) {
      throw new Error("Expected the walkthrough worktree");
    }

    expect(() =>
      retainExcludedWorktree(
        fixture.root,
        lease.runId,
        "controller",
        walkthrough,
        current.changeDigest,
        "user",
        "Keep it out of this shipment."
      )
    ).toThrow("claim it as an active concurrent author or pause it");
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
    git(fixture.root, ["branch", "-d", "obsolete-work"]);
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

  test("audits removal against the refreshed target after the target ref moves", () => {
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
    const updated = authorizeWorktreeRemoval(
      fixture.root,
      lease.runId,
      "controller",
      unique,
      current.changeDigest,
      "user",
      "The refreshed target now contains this exact opening worktree head."
    );
    expect(updated.dispositions).toContainEqual(
      expect.objectContaining({
        headSha: current.headSha,
        path: unique,
        targetRevision: current.headSha,
        uniqueCommitCount: 0,
      })
    );
    git(fixture.root, ["worktree", "remove", unique]);
    expect(verifyLoop(fixture.root).ok).toBe(true);
  }, 20_000);

  test("rejects disposal when the refreshed target does not descend from the pinned target", () => {
    const fixture = repository();
    const opening = join(fixture.base, "opening-divergent-target");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "opening-divergent-target",
      opening,
    ]);
    const lease = startLoop(fixture.root, "controller", "reconcile");
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === opening
    );
    const divergent = git(fixture.root, [
      "commit-tree",
      "HEAD^{tree}",
      "-m",
      "divergent",
    ]);
    git(fixture.root, ["update-ref", "refs/heads/main", divergent]);

    expect(() =>
      authorizeWorktreeRemoval(
        fixture.root,
        lease.runId,
        "controller",
        opening,
        current?.changeDigest ?? "",
        "user",
        "Do not trust a rewritten target."
      )
    ).toThrow("does not descend from pinned target");
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
    const branchDigest = createHash("sha256")
      .update(JSON.stringify([{ headRevision: targetRevision, name: "main" }]))
      .digest("hex");
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
          finalCoverage: paginationCoverage(1, branchDigest),
          finalInventoryComplete: true,
          initialBranchCount: 1,
          initialCoverage: paginationCoverage(1, branchDigest),
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
        finalCoverage: paginationCoverage(1, branchDigest),
        finalInventoryComplete: true,
        initialBranchCount: 1,
        initialCoverage: paginationCoverage(1, branchDigest),
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
