import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sleep } from "bun";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  acceptPausedWorktreeChange,
  adoptPausedWorktree,
  authorizeWorktreeRemoval,
  closeLoopTargetEquivalent,
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
  recordShipmentOutcome,
  recordShipmentScope,
  recoverLoopLock,
  recoverPostCleanupLoop,
  retainExcludedWorktree,
  startLoop,
  takeoverLoop,
  verifyLoop,
  withLoopMutationLease,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import type {
  ChangePlan,
  LoopLease,
  ShipmentOutcomeReceipt,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  observeWorktreeClaims,
  pauseClaimedWorktree,
  readCoordinationDocumentFromCommonDirectory,
  readWorktreeCoordination,
  releaseHandoffWorktreeClaim,
  releaseWorktreeClaim,
  withWorktreeCoordinationLock,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import { auditWorktreeEquivalence } from "../../../skills/simple-changes/scripts/lib/worktree-equivalence.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

let repositories: TestRepository[] = [];
const TREE_ENTRY_PATTERN = /^(\d+)\s+(blob|commit)\s+([0-9a-f]+)\t/u;
setDefaultTimeout(30_000);

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const treeEntry = (
  root: string,
  revision: string,
  path: string
): string | null => {
  const output = git(root, ["ls-tree", revision, "--", path]);
  const match = TREE_ENTRY_PATTERN.exec(output);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
};

const shipmentOutcome = (
  root: string,
  lease: LoopLease,
  plan: ChangePlan,
  targetRevision: string
): ShipmentOutcomeReceipt => ({
  additionalPaths: [],
  runId: lease.runId,
  schemaVersion: 1,
  targetRevision,
  units: plan.units.map((unit) => ({
    disposition: "delivered",
    evidence: ["The final target matches the exact opening source result."],
    finalPaths: unit.paths.map((path) => ({
      entry: treeEntry(root, targetRevision, path),
      path,
    })),
    originalPaths: [],
    summary: `Delivered ${unit.title}`,
    unitId: unit.id,
  })),
});

const paginationCoverage = (
  branches: number,
  branchDigest: string,
  proposals = 0,
  proposalDigest = createHash("sha256").update("[]").digest("hex")
) => ({
  branches: {
    ledgerDigest: createHash("sha256")
      .update(
        JSON.stringify({
          entryDigest: branchDigest,
          pageDigests: [branchDigest],
        })
      )
      .digest("hex"),
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
    ledgerDigest: createHash("sha256")
      .update(
        JSON.stringify({
          entryDigest: proposalDigest,
          pageDigests: [proposalDigest],
        })
      )
      .digest("hex"),
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

const remoteSnapshot = (
  targetRevision: string,
  observedAt = new Date().toISOString(),
  project = "group/project"
) => {
  const branches = [{ headRevision: targetRevision, name: "main" }];
  const branchDigest = createHash("sha256")
    .update(JSON.stringify(branches))
    .digest("hex");
  return {
    branches: [
      {
        classification: "canonical-target" as const,
        disposition: "preserved-target" as const,
        evidence: ["Complete GitLab inventory includes protected main."],
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
    finalInventoryComplete: true as const,
    initialBranchCount: 1,
    initialCoverage: paginationCoverage(1, branchDigest),
    initialInventoryComplete: true as const,
    observedAt,
    project,
    provider: "gitlab",
    schemaVersion: 1 as const,
    targetBranch: "main",
    targetRevision,
  };
};

const claimEvidence = (repositoryPath: string) => {
  const firstClaimObservation = observeWorktreeClaims(repositoryPath);
  return {
    firstClaimObservation,
    secondClaimObservation: {
      ...firstClaimObservation,
      observedAt: new Date(
        Date.parse(firstClaimObservation.observedAt) + 1
      ).toISOString(),
    },
  };
};

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("active integration-loop lease", () => {
  test("reports controller-state permission denial as distinct from a busy lock", () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = repository();
    const { commonGitDirectory } = captureInventory(fixture.root).repository;
    const stateDirectory = join(commonGitDirectory, "simple-changes");
    mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
    chmodSync(stateDirectory, 0o500);

    try {
      expect(() => startLoop(fixture.root, "controller", "ship")).toThrow(
        "This is not lock contention"
      );
    } finally {
      chmodSync(stateDirectory, 0o700);
    }
    expect(readLoopLease(fixture.root)).toBeNull();
  });

  test("requires opening remote evidence before a GitLab integration loop starts", () => {
    for (const mode of [
      "queue",
      "sweep",
      "integrate",
      "ship",
      "reconcile",
      "resume",
    ] as const) {
      const fixture = repository();
      git(fixture.root, [
        "remote",
        "add",
        "origin",
        "git@gitlab.com:group/project.git",
      ]);
      expect(() => startLoop(fixture.root, "controller", mode)).toThrow(
        "complete opening remote inventory"
      );
      expect(readLoopLease(fixture.root)).toBeNull();
    }
  });

  test("durably completes run-created worktree removal before relinquishing", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const lease = startLoop(
      fixture.root,
      "controller",
      "ship",
      remoteSnapshot(targetRevision)
    );
    expect(lease.openingRemoteInventory).toEqual(
      remoteSnapshot(targetRevision, lease.openingRemoteInventory?.observedAt)
    );
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "terminal removal audit"
    );

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Remote reconciliation remains pending."
    );

    expect(finalized.outcome).toBe("relinquished");
    expect(existsSync(prepared.path)).toBe(false);
    expect(finalized.lease?.dispositions).toContainEqual(
      expect.objectContaining({
        completedAt: expect.any(String),
        path: prepared.path,
        status: "completed",
      })
    );
  }, 30_000);

  test("does not mutate cleanup state when a legacy GitLab loop lacks opening evidence", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const lease = startLoop(
      fixture.root,
      "controller",
      "ship",
      remoteSnapshot(targetRevision)
    );
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "legacy-author",
      "must remain untouched"
    );
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    expect(() =>
      recordRemoteBranchReconciliation(
        fixture.root,
        lease.runId,
        "controller",
        remoteSnapshot(targetRevision)
      )
    ).toThrow("cannot record an ordinary reconciliation receipt");
    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "only approved post-cleanup recovery may close it"
    );

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Legacy evidence is missing."
    );

    expect(finalized.outcome).toBe("relinquished");
    expect(existsSync(prepared.path)).toBe(true);
    expect(git(prepared.path, ["rev-parse", "HEAD"])).toBe(targetRevision);
    expect(finalized.cleanup).toEqual({
      cleanedPrimaryPaths: [],
      errors: [],
      primaryUpdated: false,
      prunedWorktreeMetadata: 0,
      releasedClaims: [],
      removedBranches: [],
      removedWorktrees: [],
    });
  });

  test("keeps legacy GitLab Queue and Sweep runs close-only", () => {
    for (const mode of ["queue", "sweep"] as const) {
      const fixture = repository();
      git(fixture.root, [
        "remote",
        "add",
        "origin",
        "git@gitlab.com:group/project.git",
      ]);
      const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
      const lease = startLoop(
        fixture.root,
        "controller",
        mode,
        remoteSnapshot(targetRevision)
      );
      const leasePath = loopLeasePath(
        captureInventory(fixture.root).repository.commonGitDirectory
      );
      const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
      Reflect.deleteProperty(stored, "openingRemoteInventory");
      writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      const refsBefore = git(fixture.root, ["show-ref"]);
      const worktreesBefore = captureInventory(fixture.root).worktrees.map(
        (worktree) => worktree.path
      );

      expect(() =>
        prepareAgentWorktree(
          fixture.root,
          lease.runId,
          `${mode}-author`,
          "must remain close-only"
        )
      ).toThrow("cannot prepare new authoring work");
      expect(git(fixture.root, ["show-ref"])).toBe(refsBefore);
      expect(
        captureInventory(fixture.root).worktrees.map(
          (worktree) => worktree.path
        )
      ).toEqual(worktreesBefore);
    }
  });

  test("closes a legacy missing-opening ledger only with approved matching post-cleanup evidence", async () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const snapshot = remoteSnapshot(targetRevision);
    const secondSnapshot = {
      ...snapshot,
      observedAt: new Date(
        Date.parse(snapshot.observedAt) + 1000
      ).toISOString(),
    };
    const lease = startLoop(fixture.root, "controller", "ship", snapshot);
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "legacy-author",
      "legacy recovered cleanup"
    );
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Remote reconciliation remains pending."
    );
    expect(existsSync(prepared.path)).toBe(false);
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    startLoop(fixture.root, "recovery-controller", "resume");
    const refsBeforeRecovery = git(fixture.root, ["show-ref"]);
    const receipt = {
      approvedBy: "user",
      authority: "close-only" as const,
      ...claimEvidence(fixture.root),
      firstFinalInventory: snapshot,
      openingEvidenceUnavailableReason:
        "The legacy runtime did not persist the opening provider inventory.",
      project: "group/project",
      provider: "gitlab" as const,
      reason: "Cleanup was already complete; close old bookkeeping only.",
      schemaVersion: 1 as const,
      secondFinalInventory: secondSnapshot,
      targetBranch: "main",
      targetRevision,
    };
    const moduleUrl = pathToFileURL(
      join(
        import.meta.dir,
        "../../../skills/simple-changes/scripts/lib/loop-lease.ts"
      )
    ).href;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `import { recoverPostCleanupLoop } from ${JSON.stringify(moduleUrl)}; recoverPostCleanupLoop(${JSON.stringify(fixture.root)}, ${JSON.stringify(lease.runId)}, "recovery-controller", ${JSON.stringify(receipt)});`,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          SIMPLE_CHANGES_TEST_CRASH_AFTER_POST_CLEANUP_INTENT: lease.runId,
        },
        stdio: "ignore",
      }
    );
    const termination = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveTermination) => {
      child.once("exit", (code, signal) =>
        resolveTermination({ code, signal })
      );
    });
    expect(termination).toEqual({ code: null, signal: "SIGKILL" });
    await sleep(5100);
    expect(recoverLoopLock(fixture.root, "recovery-controller")).toMatchObject({
      coordinationRecovered: true,
      recovered: true,
    });

    const recovered = recoverPostCleanupLoop(
      fixture.root,
      lease.runId,
      "recovery-controller",
      receipt
    );

    expect(recovered).toMatchObject({
      active: false,
      ok: true,
      runId: lease.runId,
    });
    expect(git(fixture.root, ["show-ref"])).toBe(refsBeforeRecovery);
    expect(existsSync(prepared.path)).toBe(false);
    expect(readLoopLease(fixture.root)).toBeNull();
    expect(loopStatus(fixture.root)).toMatchObject({
      lease: null,
      verification: { active: false, ok: true, violations: [] },
    });
    const repeated = recoverPostCleanupLoop(
      fixture.root,
      lease.runId,
      "recovery-controller",
      receipt
    );
    expect(repeated).toEqual(recovered);
    const history = JSON.parse(
      readFileSync(
        join(
          captureInventory(fixture.root).repository.commonGitDirectory,
          "simple-changes",
          "history",
          lease.runId,
          "intent.json"
        ),
        "utf8"
      )
    ) as { removedWorktreePaths: string[] };
    expect(history.removedWorktreePaths).toContain(prepared.path);
  }, 60_000);

  test("closes legacy bookkeeping while stable unrelated claims remain active", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const snapshot = remoteSnapshot(targetRevision);
    const lease = startLoop(fixture.root, "controller", "ship", snapshot);
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const unrelated = join(fixture.base, "unrelated-active-claim");
    git(fixture.root, ["worktree", "add", "-b", "unrelated-active", unrelated]);
    claimWorktree(
      unrelated,
      "unrelated-owner",
      unrelated,
      "codex-desktop",
      "unrelated-task"
    );
    finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Remote reconciliation remains pending."
    );
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    startLoop(fixture.root, "recovery-controller", "resume");
    const claims = claimEvidence(fixture.root);
    const finalSnapshot = remoteSnapshot(
      targetRevision,
      new Date(Date.now() + 1000).toISOString()
    );
    const secondSnapshot = {
      ...finalSnapshot,
      observedAt: new Date(
        Date.parse(finalSnapshot.observedAt) + 1000
      ).toISOString(),
    };
    const recovered = recoverPostCleanupLoop(
      fixture.root,
      lease.runId,
      "recovery-controller",
      {
        approvedBy: "user",
        authority: "close-only",
        ...claims,
        firstFinalInventory: finalSnapshot,
        openingEvidenceUnavailableReason:
          "The legacy runtime did not persist opening provider evidence.",
        project: "group/project",
        provider: "gitlab",
        reason:
          "Close old bookkeeping while preserving unrelated claimed work.",
        schemaVersion: 1,
        secondFinalInventory: secondSnapshot,
        targetBranch: "main",
        targetRevision,
      }
    );
    expect(recovered).toMatchObject({ active: false, ok: true });
    expect(existsSync(unrelated)).toBe(true);
    expect(readLoopLease(fixture.root)).toBeNull();
  }, 60_000);

  test("recovers an absent target-contained run-created checkout reclassified as preserved", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const snapshot = remoteSnapshot(targetRevision);
    const lease = startLoop(fixture.root, "controller", "ship", snapshot);
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "legacy-preserved-author",
      "legacy preserved cleanup"
    );
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    stored.worktrees = stored.worktrees.map((worktree) => {
      if (worktree.path === prepared.path) {
        return {
          ...worktree,
          agentId: null,
          mutationAllowed: false,
          role: "preserved",
        };
      }
      if (worktree.path === fixture.root) {
        return { ...worktree, branch: "legacy-controller-branch" };
      }
      return worktree;
    });
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    git(fixture.root, ["worktree", "remove", prepared.path]);
    git(fixture.root, ["branch", "-D", prepared.branch]);
    const finalSnapshot = remoteSnapshot(
      targetRevision,
      new Date(Date.now() + 1000).toISOString()
    );
    const recovered = recoverPostCleanupLoop(
      fixture.root,
      lease.runId,
      "controller",
      {
        approvedBy: "user",
        authority: "close-only",
        ...claimEvidence(fixture.root),
        firstFinalInventory: finalSnapshot,
        openingEvidenceUnavailableReason:
          "The legacy runtime did not persist opening provider evidence.",
        project: "group/project",
        provider: "gitlab",
        reason: "The absent run-created checkout is target-contained.",
        schemaVersion: 1,
        secondFinalInventory: {
          ...finalSnapshot,
          observedAt: new Date(
            Date.parse(finalSnapshot.observedAt) + 1000
          ).toISOString(),
        },
        targetBranch: "main",
        targetRevision,
      }
    );
    expect(recovered).toMatchObject({ active: false, ok: true });
    expect(readLoopLease(fixture.root)).toBeNull();
  }, 30_000);

  test("retries safely after retiring an absent paused claim", async () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const openingSnapshot = remoteSnapshot(targetRevision);
    const lease = startLoop(
      fixture.root,
      "controller",
      "ship",
      openingSnapshot
    );
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "legacy-author",
      "claim retirement crash recovery"
    );
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Remote reconciliation remains pending."
    );
    expect(existsSync(prepared.path)).toBe(false);
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "historical-paused-claim",
      prepared.path,
      targetRevision,
    ]);
    const claim = claimWorktree(
      fixture.root,
      "historical-author",
      prepared.path,
      "codex",
      "historical-task"
    );
    pauseClaimedWorktree(
      fixture.root,
      "historical-author",
      prepared.path,
      lease.runId,
      "detach-clean-checkout",
      "The completed cleanup already removed this temporary checkout."
    );
    git(fixture.root, ["worktree", "remove", prepared.path]);
    git(fixture.root, ["branch", "-D", "historical-paused-claim"]);
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    startLoop(fixture.root, "recovery-controller", "resume");
    const firstFinalInventory = remoteSnapshot(targetRevision);
    const receipt = {
      approvedBy: "user",
      authority: "close-only" as const,
      ...claimEvidence(fixture.root),
      firstFinalInventory,
      openingEvidenceUnavailableReason:
        "The legacy runtime did not persist the opening provider inventory.",
      project: "group/project",
      provider: "gitlab" as const,
      reason: "Cleanup was already complete; close old bookkeeping only.",
      schemaVersion: 1 as const,
      secondFinalInventory: {
        ...firstFinalInventory,
        observedAt: new Date(
          Date.parse(firstFinalInventory.observedAt) + 1000
        ).toISOString(),
      },
      targetBranch: "main",
      targetRevision,
    };
    const moduleUrl = pathToFileURL(
      join(
        import.meta.dir,
        "../../../skills/simple-changes/scripts/lib/loop-lease.ts"
      )
    ).href;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `import { recoverPostCleanupLoop } from ${JSON.stringify(moduleUrl)}; recoverPostCleanupLoop(${JSON.stringify(fixture.root)}, ${JSON.stringify(lease.runId)}, "recovery-controller", ${JSON.stringify(receipt)});`,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          SIMPLE_CHANGES_TEST_CRASH_AFTER_POST_CLEANUP_RETIREMENT: lease.runId,
        },
        stdio: "ignore",
      }
    );
    const termination = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveTermination) => {
      child.once("exit", (code, signal) =>
        resolveTermination({ code, signal })
      );
    });
    expect(termination).toEqual({ code: null, signal: "SIGKILL" });
    const { commonGitDirectory } = captureInventory(fixture.root).repository;
    expect(
      readCoordinationDocumentFromCommonDirectory(
        commonGitDirectory
      ).claims.find((item) => item.claimId === claim.claimId)?.state
    ).toBe("released");
    await sleep(5100);
    expect(recoverLoopLock(fixture.root, "recovery-controller")).toMatchObject({
      coordinationRecovered: true,
      recovered: true,
    });

    expect(
      recoverPostCleanupLoop(
        fixture.root,
        lease.runId,
        "recovery-controller",
        receipt
      )
    ).toMatchObject({
      active: false,
      ok: true,
      retiredClaimIds: [claim.claimId],
    });
    expect(readLoopLease(fixture.root)).toBeNull();
  }, 60_000);

  test("rejects linked immutable recovery audit events", () => {
    for (const event of ["intent", "completed"] as const) {
      const fixture = repository();
      git(fixture.root, [
        "remote",
        "add",
        "origin",
        "git@gitlab.com:group/project.git",
      ]);
      const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
      const snapshot = remoteSnapshot(targetRevision);
      const lease = startLoop(fixture.root, "controller", "ship", snapshot);
      const leasePath = loopLeasePath(
        captureInventory(fixture.root).repository.commonGitDirectory
      );
      const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
      Reflect.deleteProperty(stored, "openingRemoteInventory");
      writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      const { commonGitDirectory } = captureInventory(fixture.root).repository;
      const historyDirectory = join(
        commonGitDirectory,
        "simple-changes",
        "history",
        lease.runId
      );
      mkdirSync(historyDirectory, { recursive: true });
      const external = join(fixture.base, `external-${event}.json`);
      writeFileSync(external, '{"external":true}\n', "utf8");
      symlinkSync(external, join(historyDirectory, `${event}.json`));
      const receipt = {
        approvedBy: "user",
        authority: "close-only" as const,
        ...claimEvidence(fixture.root),
        firstFinalInventory: snapshot,
        openingEvidenceUnavailableReason: "Legacy evidence is absent.",
        project: "group/project",
        provider: "gitlab" as const,
        reason: "Cleanup was already complete; close bookkeeping only.",
        schemaVersion: 1 as const,
        secondFinalInventory: {
          ...snapshot,
          observedAt: new Date(
            Date.parse(snapshot.observedAt) + 1000
          ).toISOString(),
        },
        targetBranch: "main",
        targetRevision,
      };

      expect(() =>
        recoverPostCleanupLoop(fixture.root, lease.runId, "controller", receipt)
      ).toThrow("regular file");
      expect(readFileSync(external, "utf8")).toBe('{"external":true}\n');
      expect(readLoopLease(fixture.root)).not.toBeNull();
    }
  });

  test("rejects post-cleanup recovery without explicit approval", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Recovery approval is intentionally absent."
    );
    startLoop(fixture.root, "recovery-controller", "resume");
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);

    expect(() =>
      recoverPostCleanupLoop(fixture.root, lease.runId, "recovery-controller", {
        approvedBy: "",
        authority: "close-only",
        ...claimEvidence(fixture.root),
        firstFinalInventory: remoteSnapshot(targetRevision),
        openingEvidenceUnavailableReason: "Legacy evidence is absent.",
        project: "group/project",
        provider: "gitlab",
        reason: "No approval.",
        schemaVersion: 1,
        secondFinalInventory: remoteSnapshot(targetRevision),
        targetBranch: "main",
        targetRevision,
      })
    ).toThrow();
  });

  test("rejects close-only recovery while local cleanup or work remains", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const snapshot = remoteSnapshot(targetRevision);
    const lease = startLoop(fixture.root, "controller", "ship", snapshot);
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Legacy evidence is missing."
    );
    startLoop(fixture.root, "recovery-controller", "resume");
    writeFixture(fixture.root, "still-dirty.txt", "not reconciled\n");
    const receipt = {
      approvedBy: "user",
      authority: "close-only" as const,
      ...claimEvidence(fixture.root),
      firstFinalInventory: snapshot,
      openingEvidenceUnavailableReason: "Legacy evidence is absent.",
      project: "group/project",
      provider: "gitlab" as const,
      reason: "Attempt close-only recovery.",
      schemaVersion: 1 as const,
      secondFinalInventory: {
        ...snapshot,
        observedAt: new Date(
          Date.parse(snapshot.observedAt) + 1000
        ).toISOString(),
      },
      targetBranch: "main",
      targetRevision,
    };

    expect(() =>
      recoverPostCleanupLoop(
        fixture.root,
        lease.runId,
        "recovery-controller",
        receipt
      )
    ).toThrow("cleanup remains");
    expect(readLoopLease(fixture.root)).not.toBeNull();
  }, 30_000);

  test("rejects close-only recovery while an active claim remains", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const snapshot = remoteSnapshot(targetRevision);
    const lease = startLoop(fixture.root, "controller", "ship", snapshot);
    const stableClaimEvidence = claimEvidence(fixture.root);
    const claimed = join(fixture.base, "active-recovery-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "active-recovery-author",
      claimed,
    ]);
    claimWorktree(
      fixture.root,
      "active-author",
      claimed,
      "codex",
      "active-recovery-task"
    );
    verifyLoop(fixture.root);
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Active author remains preserved."
    );
    startLoop(fixture.root, "recovery-controller", "resume");

    expect(() =>
      recoverPostCleanupLoop(fixture.root, lease.runId, "recovery-controller", {
        approvedBy: "user",
        authority: "close-only",
        ...stableClaimEvidence,
        firstFinalInventory: snapshot,
        openingEvidenceUnavailableReason: "Legacy evidence is absent.",
        project: "group/project",
        provider: "gitlab",
        reason: "Attempt close-only recovery.",
        schemaVersion: 1,
        secondFinalInventory: {
          ...snapshot,
          observedAt: new Date(
            Date.parse(snapshot.observedAt) + 1000
          ).toISOString(),
        },
        targetBranch: "main",
        targetRevision,
      })
    ).toThrow("active worktree claim");
    expect(existsSync(claimed)).toBe(true);
  }, 30_000);

  test("rejects close-only recovery when a claim changed after the first observation", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const snapshot = remoteSnapshot(
      targetRevision,
      new Date(Date.now() - 10_000).toISOString()
    );
    const lease = startLoop(fixture.root, "controller", "ship", snapshot);
    const stableClaimEvidence = claimEvidence(fixture.root);
    const changed = join(fixture.base, "changed-recovery-claim");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "changed-recovery-claim",
      changed,
    ]);
    const claim = claimWorktree(
      fixture.root,
      "changed-author",
      changed,
      "codex",
      "changed-recovery-task"
    );
    releaseWorktreeClaim(fixture.root, "changed-author", claim.claimId);
    git(fixture.root, ["worktree", "remove", changed]);
    git(fixture.root, ["branch", "-D", "changed-recovery-claim"]);
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Changed claim must remain auditable."
    );
    startLoop(fixture.root, "recovery-controller", "resume");

    expect(() =>
      recoverPostCleanupLoop(fixture.root, lease.runId, "recovery-controller", {
        approvedBy: "user",
        authority: "close-only",
        ...stableClaimEvidence,
        firstFinalInventory: snapshot,
        openingEvidenceUnavailableReason: "Legacy evidence is absent.",
        project: "group/project",
        provider: "gitlab",
        reason: "Attempt close-only recovery.",
        schemaVersion: 1,
        secondFinalInventory: {
          ...snapshot,
          observedAt: new Date(
            Date.parse(snapshot.observedAt) + 1000
          ).toISOString(),
        },
        targetBranch: "main",
        targetRevision,
      })
    ).toThrow("claims changed after the approved observations");
  }, 30_000);

  test("rejects close-only recovery when the primary is behind a moved target", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    git(fixture.root, ["config", "branch.main.remote", "origin"]);
    git(fixture.root, ["config", "branch.main.merge", "refs/heads/main"]);
    const openingTarget = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, [
      "update-ref",
      "refs/remotes/origin/main",
      openingTarget,
    ]);
    const openingSnapshot = remoteSnapshot(openingTarget);
    const lease = startLoop(
      fixture.root,
      "controller",
      "ship",
      openingSnapshot
    );
    const leasePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Legacy evidence is missing."
    );
    const movedTarget = git(fixture.root, [
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-m",
      "Remote target moved",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", movedTarget]);
    startLoop(fixture.root, "recovery-controller", "resume");
    const finalSnapshot = remoteSnapshot(movedTarget);
    const leaseBefore = readFileSync(leasePath);

    expect(() =>
      recoverPostCleanupLoop(fixture.root, lease.runId, "recovery-controller", {
        approvedBy: "user",
        authority: "close-only",
        ...claimEvidence(fixture.root),
        firstFinalInventory: finalSnapshot,
        openingEvidenceUnavailableReason: "Legacy evidence is absent.",
        project: "group/project",
        provider: "gitlab",
        reason: "Attempt close-only recovery.",
        schemaVersion: 1,
        secondFinalInventory: {
          ...finalSnapshot,
          observedAt: new Date(
            Date.parse(finalSnapshot.observedAt) + 1000
          ).toISOString(),
        },
        targetBranch: "main",
        targetRevision: movedTarget,
      })
    ).toThrow(
      "Post-cleanup recovery is close-only and cannot proceed while cleanup remains: Update local target branch main"
    );
    expect(git(fixture.root, ["rev-parse", "main"])).toBe(openingTarget);
    expect(readFileSync(leasePath)).toEqual(leaseBefore);
  }, 30_000);
  test("reads and safely verifies a pre-remote-binding lease", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const inventory = captureInventory(fixture.root);
    const leasePath = loopLeasePath(inventory.repository.commonGitDirectory);
    const { remoteBindings: _remoteBindings, ...legacy } = lease;
    writeFileSync(leasePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    expect(readLoopLease(fixture.root)?.remoteBindings).toBeUndefined();
    expect(verifyLoop(fixture.root)).toMatchObject({ active: true, ok: false });
    expect(verifyLoop(fixture.root).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "remote-destination-rebind-required" }),
      ])
    );
    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Upgrade the legacy controller safely."
    );
    expect(finalized.outcome).toBe("relinquished");
    const resumed = startLoop(fixture.root, "next-controller", "resume");
    expect(resumed.remoteBindings).toEqual(
      captureInventory(fixture.root).repository.remoteBindings
    );
    expect(verifyLoop(fixture.root)).toMatchObject({ active: true, ok: true });
  }, 120_000);

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
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const lease = startLoop(
      fixture.root,
      "controller",
      "integrate",
      remoteSnapshot(targetRevision, new Date().toISOString(), "group/first")
    );
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
    writeFixture(prepared.path, "unfinished.txt", "still being authored\n");

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
        shipmentScopeFrozenAt: expect.any(String),
      },
      outcome: "relinquished",
    });
    expect(finalized.blockers).toContainEqual(
      expect.stringContaining("run-created worktrees")
    );
    expect(() =>
      guardLoopMutation(fixture.root, lease.runId, "first-controller")
    ).toThrow("relinquished");

    expect(() => startLoop(fixture.root, "next-controller", "ship")).toThrow(
      "Resume it explicitly"
    );

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
    expect(
      prepareAgentWorktree(
        fixture.root,
        lease.runId,
        "author",
        "unfinished unit"
      )
    ).toMatchObject({ created: false, path: prepared.path });
    expect(() =>
      prepareAgentWorktree(
        fixture.root,
        lease.runId,
        "later-shipment-author",
        "unrelated later shipment"
      )
    ).toThrow("cannot prepare a new author for a later shipment");
  }, 40_000);

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

  test("does not let a resumed loop record its first scope from later repository state", () => {
    const fixture = repository();
    writeFixture(fixture.root, "opening.txt", "opening shipment work\n");
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "first-controller", "ship");
    expect(
      finalizeLoop(
        fixture.root,
        lease.runId,
        "first-controller",
        "Controller ended before recording shipment scope."
      )
    ).toMatchObject({
      lease: { shipmentScopeFrozenAt: expect.any(String) },
      outcome: "relinquished",
    });

    const statePath = loopLeasePath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const legacyLease = JSON.parse(readFileSync(statePath, "utf8"));
    Reflect.deleteProperty(legacyLease, "shipmentScopeFrozenAt");
    writeFileSync(statePath, `${JSON.stringify(legacyLease, null, 2)}\n`);

    expect(startLoop(fixture.root, "next-controller", "resume")).toMatchObject({
      shipmentScopeFrozenAt: expect.any(String),
    });
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current),
      "Ship the opening work"
    );
    expect(() =>
      recordShipmentScope(fixture.root, lease.runId, "next-controller", plan)
    ).toThrow("cannot record a first scope from later repository state");
  });

  test("automatically prunes a target-contained local branch at completion", () => {
    const fixture = repository();
    git(fixture.root, ["branch", "merged-unit"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "A merged local branch still needs cleanup."
    );

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(git(fixture.root, ["branch", "--list", "merged-unit"])).toBe("");
  });

  test("automatically removes a stable clean merged worktree at completion", () => {
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

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(existsSync(mergedWorktree)).toBe(false);
    expect(git(fixture.root, ["branch", "--list", "merged-unit"])).toBe("");
  });

  test("recovers after process death immediately following automatic worktree removal", async () => {
    const fixture = repository();
    const mergedWorktree = join(fixture.base, "crash-recovery-unit");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "crash-recovery-unit",
      mergedWorktree,
    ]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const moduleUrl = pathToFileURL(
      join(
        import.meta.dir,
        "../../../skills/simple-changes/scripts/lib/loop-lease.ts"
      )
    ).href;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `import { finalizeLoop } from ${JSON.stringify(moduleUrl)}; finalizeLoop(${JSON.stringify(fixture.root)}, ${JSON.stringify(lease.runId)}, "controller", "Crash recovery test.");`,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          SIMPLE_CHANGES_TEST_CRASH_AFTER_WORKTREE_REMOVE: mergedWorktree,
        },
        stdio: "ignore",
      }
    );
    const termination = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveTermination) => {
      child.once("exit", (code, signal) =>
        resolveTermination({ code, signal })
      );
    });

    expect(termination).toEqual({ code: null, signal: "SIGKILL" });
    expect(existsSync(mergedWorktree)).toBe(false);
    expect(readLoopLease(fixture.root)?.dispositions).toContainEqual(
      expect.objectContaining({
        outcome: "remove-after-audit",
        path: mergedWorktree,
      })
    );

    await sleep(5100);
    expect(recoverLoopLock(fixture.root, "controller")).toMatchObject({
      coordinationRecovered: true,
      recovered: true,
    });
    expect(
      finalizeLoop(
        fixture.root,
        lease.runId,
        "controller",
        "Resume after exact automatic cleanup recovery."
      )
    ).toMatchObject({ blockers: [], outcome: "completed" });
    expect(git(fixture.root, ["branch", "--list", "crash-recovery-unit"])).toBe(
      ""
    );
  }, 20_000);

  test("automatically prunes stale target-contained worktree metadata", () => {
    const fixture = repository();
    const staleWorktree = join(fixture.base, "stale-unit");
    git(fixture.root, ["worktree", "add", "-b", "stale-unit", staleWorktree]);
    rmSync(staleWorktree, { recursive: true });
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Prune stale worktree bookkeeping."
    );

    expect(finalized).toMatchObject({
      blockers: [],
      cleanup: { prunedWorktreeMetadata: 1 },
      outcome: "completed",
    });
    expect(git(fixture.root, ["branch", "--list", "stale-unit"])).toBe("");
  });

  test("does not auto-remove a clean worktree that arrives after the opening inventory", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const lateWorktree = join(fixture.base, "late-unit");
    git(fixture.root, ["worktree", "add", "-b", "late-unit", lateWorktree]);

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "A new unrelated checkout appeared during cleanup."
    );

    expect(finalized.outcome).toBe("relinquished");
    expect(finalized.cleanup.removedWorktrees).not.toContain(lateWorktree);
    expect(existsSync(lateWorktree)).toBe(true);
    expect(finalized.verification.violations).toContainEqual(
      expect.objectContaining({
        code: "unregistered-worktree",
        path: lateWorktree,
      })
    );
  });

  test("does not auto-remove a target-contained branch that arrives after the opening inventory", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    git(fixture.root, ["branch", "late-arrival"]);

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "A new local branch appeared during cleanup."
    );

    expect(finalized.outcome).toBe("relinquished");
    expect(
      finalized.cleanup.removedBranches.map((entry) => entry.branch)
    ).not.toContain("late-arrival");
    expect(git(fixture.root, ["branch", "--list", "late-arrival"])).not.toBe(
      ""
    );
  });

  test("removes an opening branch whose commits were squash-merged into the target", () => {
    const fixture = repository();
    writeFixture(fixture.root, "feature.ts", "export const feature = 1;\n");
    git(fixture.root, ["add", "feature.ts"]);
    git(fixture.root, ["commit", "-m", "Feature work"]);
    const featureSha = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["branch", "squash-merged", featureSha]);
    git(fixture.root, ["reset", "--hard", "HEAD^"]);
    const squashed = git(fixture.root, [
      "commit-tree",
      `${featureSha}^{tree}`,
      "-p",
      "HEAD",
      "-m",
      "Squash-merged: feature work",
    ]);
    git(fixture.root, ["reset", "--hard", squashed]);
    git(fixture.root, ["branch", "ancestry-contained", squashed]);
    expect(squashed).not.toBe(featureSha);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Clean up branches already merged upstream by squash."
    );

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(finalized.cleanup.removedBranches).toContainEqual({
      branch: "squash-merged",
      method: "patch-equivalent",
    });
    expect(finalized.cleanup.removedBranches).toContainEqual({
      branch: "ancestry-contained",
      method: "target-contained",
    });
    expect(git(fixture.root, ["branch", "--list", "squash-merged"])).toBe("");
    expect(git(fixture.root, ["branch", "--list", "ancestry-contained"])).toBe(
      ""
    );
  }, 20_000);

  test("adopts multiple pause-receipted stragglers while others still await adoption", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const pausedStraggler = (name: string) => {
      const path = join(fixture.base, name);
      git(fixture.root, ["worktree", "add", "-b", name, path]);
      claimWorktree(
        path,
        `${name}-author`,
        path,
        "codex-desktop",
        `task-${name}`
      );
      return pauseClaimedWorktree(
        path,
        `${name}-author`,
        path,
        lease.runId,
        "preserve-in-place",
        "Pause at a stable boundary for adoption."
      );
    };
    const first = pausedStraggler("straggler-a");
    const second = pausedStraggler("straggler-b");
    expect(verifyLoop(fixture.root).ok).toBe(false);

    adoptPausedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      first.receiptId
    );
    adoptPausedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      second.receiptId
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);

    const bystander = join(fixture.base, "no-receipt");
    git(fixture.root, ["worktree", "add", "-b", "no-receipt", bystander]);
    const third = pausedStraggler("straggler-c");
    expect(() =>
      adoptPausedWorktree(
        fixture.root,
        lease.runId,
        "controller",
        third.receiptId
      )
    ).toThrow("other loop violations remain");
  }, 30_000);

  test("disposes an adopted straggler whose commit was squash-merged into the target", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const straggler = join(fixture.base, "squashed-straggler");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "squashed-straggler",
      straggler,
    ]);
    writeFixture(straggler, "straggler.ts", "export const straggler = 1;\n");
    git(straggler, ["add", "straggler.ts"]);
    git(straggler, ["commit", "-m", "Straggler work"]);
    const stragglerSha = git(straggler, ["rev-parse", "HEAD"]);
    const squashed = git(fixture.root, [
      "commit-tree",
      `${stragglerSha}^{tree}`,
      "-p",
      "HEAD",
      "-m",
      "Squash-merged: straggler work",
    ]);
    git(fixture.root, ["reset", "--hard", squashed]);
    claimWorktree(
      straggler,
      "straggler-author",
      straggler,
      "codex-desktop",
      "task-straggler"
    );
    const receipt = pauseClaimedWorktree(
      straggler,
      "straggler-author",
      straggler,
      lease.runId,
      "preserve-in-place",
      "Pause the already-merged straggler."
    );
    adoptPausedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      receipt.receiptId
    );

    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === straggler
    );
    const updated = authorizeWorktreeRemoval(
      fixture.root,
      lease.runId,
      "controller",
      straggler,
      current?.changeDigest ?? "",
      "user",
      "The straggler's only commit was squash-merged into the target."
    );
    expect(updated.dispositions).toContainEqual(
      expect.objectContaining({
        containmentMethod: "patch-equivalent",
        headSha: stragglerSha,
        outcome: "remove-after-audit",
        path: straggler,
        uniqueCommitCount: 0,
      })
    );

    git(fixture.root, ["worktree", "remove", straggler]);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Close after the audited straggler disposal."
    );
    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(existsSync(straggler)).toBe(false);
    expect(finalized.cleanup.removedBranches).toContainEqual({
      branch: "squashed-straggler",
      method: "patch-equivalent",
    });
    expect(git(fixture.root, ["branch", "--list", "squashed-straggler"])).toBe(
      ""
    );
  }, 30_000);

  test("still refuses disposal of a dirty or truly-unique adopted worktree", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const adoptStraggler = (name: string, mutate: (path: string) => void) => {
      const path = join(fixture.base, name);
      git(fixture.root, ["worktree", "add", "-b", name, path]);
      mutate(path);
      claimWorktree(
        path,
        `${name}-author`,
        path,
        "codex-desktop",
        `task-${name}`
      );
      const receipt = pauseClaimedWorktree(
        path,
        `${name}-author`,
        path,
        lease.runId,
        "preserve-in-place",
        "Pause for adoption."
      );
      adoptPausedWorktree(
        fixture.root,
        lease.runId,
        "controller",
        receipt.receiptId
      );
      return path;
    };
    const unique = adoptStraggler("unique-straggler", (path) => {
      writeFixture(path, "unique.ts", "export const unique = 1;\n");
      git(path, ["add", "unique.ts"]);
      git(path, ["commit", "-m", "Unique straggler work"]);
    });
    const dirty = adoptStraggler("dirty-straggler", (path) => {
      writeFixture(path, "dirty.ts", "export const dirty = 1;\n");
    });

    const inventory = captureInventory(fixture.root);
    const uniqueCurrent = inventory.worktrees.find(
      (worktree) => worktree.path === unique
    );
    const dirtyCurrent = inventory.worktrees.find(
      (worktree) => worktree.path === dirty
    );
    expect(() =>
      authorizeWorktreeRemoval(
        fixture.root,
        lease.runId,
        "controller",
        unique,
        uniqueCurrent?.changeDigest ?? "",
        "user",
        "Remove the unique straggler."
      )
    ).toThrow("not patch-equivalent");
    expect(() =>
      authorizeWorktreeRemoval(
        fixture.root,
        lease.runId,
        "controller",
        dirty,
        dirtyCurrent?.changeDigest ?? "",
        "user",
        "Remove the dirty straggler."
      )
    ).toThrow("must be clean");
  }, 30_000);

  test("automatically fast-forwards a clean primary to the refreshed target", () => {
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

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(git(fixture.root, ["rev-parse", "main"])).toBe(
      git(fixture.root, ["rev-parse", "origin/main"])
    );
  });

  test("automatically normalizes target-equivalent dirty primary paths before fast-forwarding", () => {
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
    writeFixture(fixture.root, "README.md", "# Current target\n");
    git(fixture.root, ["add", "README.md"]);
    git(fixture.root, ["commit", "-m", "Advance tracked target content"]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, ["checkout", "main"]);
    writeFixture(fixture.root, "README.md", "# Current target\n");
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Normalize bytes that are already exact in the target."
    );

    expect(finalized).toMatchObject({
      blockers: [],
      cleanup: { cleanedPrimaryPaths: ["README.md"] },
      outcome: "completed",
    });
    expect(git(fixture.root, ["status", "--short"])).toBe("");
    expect(readFileSync(join(fixture.root, "README.md"), "utf8")).toBe(
      "# Current target\n"
    );
  });

  test("preserves target-equivalent worktree bytes when the index contains unique staged work", () => {
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
    writeFixture(fixture.root, "README.md", "# Current target\n");
    git(fixture.root, ["add", "README.md"]);
    git(fixture.root, ["commit", "-m", "Advance tracked target content"]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, ["checkout", "main"]);
    writeFixture(fixture.root, "README.md", "# Unique staged work\n");
    git(fixture.root, ["add", "README.md"]);
    writeFixture(fixture.root, "README.md", "# Current target\n");
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Do not erase staged work merely because worktree bytes match target."
    );

    expect(finalized.outcome).toBe("relinquished");
    expect(finalized.cleanup.cleanedPrimaryPaths).toEqual([]);
    expect(git(fixture.root, ["show", ":README.md"])).toBe(
      "# Unique staged work"
    );
    expect(readFileSync(join(fixture.root, "README.md"), "utf8")).toBe(
      "# Current target\n"
    );
  });

  test("preserves intent-to-add index state even when worktree bytes match target", () => {
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
    writeFixture(fixture.root, "target.txt", "already in target\n");
    git(fixture.root, ["add", "target.txt"]);
    git(fixture.root, ["commit", "-m", "Add target file"]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, ["checkout", "main"]);
    writeFixture(fixture.root, "target.txt", "already in target\n");
    git(fixture.root, ["add", "-N", "target.txt"]);
    const before = git(fixture.root, ["ls-files", "--debug", "target.txt"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Intent-to-add is distinct index state and must survive."
    );

    expect(finalized.outcome).toBe("relinquished");
    expect(finalized.cleanup.cleanedPrimaryPaths).toEqual([]);
    expect(git(fixture.root, ["ls-files", "--debug", "target.txt"])).toBe(
      before
    );
  });

  test("preserves a clean target-contained worktree claimed before finalization", () => {
    const fixture = repository();
    const claimed = join(fixture.base, "claimed-clean");
    git(fixture.root, ["worktree", "add", "-b", "claimed-clean", claimed]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    claimWorktree(fixture.root, "other-agent", claimed, "codex", "active-task");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "A claimed checkout must not be removed."
    );

    expect(finalized.outcome).toBe("completed");
    expect(finalized.cleanup.removedWorktrees).not.toContain(claimed);
    expect(existsSync(claimed)).toBe(true);
  });

  test("releases the controller's own claim on a clean target-contained checkout at finalization", () => {
    const fixture = repository();
    const shipped = join(fixture.base, "controller-shipped");
    git(fixture.root, ["worktree", "add", "-b", "controller-shipped", shipped]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const claim = claimWorktree(
      fixture.root,
      "controller",
      shipped,
      "codex",
      "takeover:the-user"
    );

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The controller's own claimed work is already in the target."
    );

    expect(finalized.outcome).toBe("completed");
    expect(finalized.cleanup.releasedClaims).toEqual([
      { claimId: claim.claimId, path: shipped, releaseReason: "shipped" },
    ]);
    expect(finalized.cleanup.removedWorktrees).toContain(shipped);
    expect(existsSync(shipped)).toBe(false);
    expect(readWorktreeCoordination(fixture.root).claims[0]).toMatchObject({
      releaseReason: "shipped",
      state: "released",
    });
  });

  test("removes a completed handoff after squash-equivalent integration", () => {
    const fixture = repository();
    const handedOff = join(fixture.base, "handoff-squash");
    git(fixture.root, ["worktree", "add", "-b", "handoff-squash", handedOff]);
    writeFixture(handedOff, "handoff.ts", "export const handedOff = true;\n");
    git(handedOff, ["add", "handoff.ts"]);
    git(handedOff, ["commit", "-m", "Completed handoff work"]);
    const handedOffRevision = git(handedOff, ["rev-parse", "HEAD"]);
    claimWorktree(
      fixture.root,
      "handoff-author",
      handedOff,
      "codex",
      "task-handoff"
    );
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(
      releaseHandoffWorktreeClaim(handedOff, "handoff-author")
    ).toMatchObject({ releaseReason: "handoff", state: "released" });
    expect(verifyLoop(fixture.root).ok).toBe(true);

    const squashed = git(fixture.root, [
      "commit-tree",
      `${handedOffRevision}^{tree}`,
      "-p",
      "HEAD",
      "-m",
      "Squash-merged completed handoff",
    ]);
    git(fixture.root, ["reset", "--hard", squashed]);

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The completed handoff was squash-integrated into the target."
    );

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(finalized.cleanup.removedWorktrees).toContain(handedOff);
    expect(finalized.cleanup.removedBranches).toContainEqual({
      branch: "handoff-squash",
      method: "patch-equivalent",
    });
    expect(existsSync(handedOff)).toBe(false);
    expect(git(fixture.root, ["branch", "--list", "handoff-squash"])).toBe("");
  }, 60_000);

  test("removes a completed handoff after exact-ancestry integration", () => {
    const fixture = repository();
    const handedOff = join(fixture.base, "handoff-ancestry");
    git(fixture.root, ["worktree", "add", "-b", "handoff-ancestry", handedOff]);
    claimWorktree(
      fixture.root,
      "handoff-author",
      handedOff,
      "codex",
      "task-handoff-ancestry"
    );
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(
      releaseHandoffWorktreeClaim(handedOff, "handoff-author")
    ).toMatchObject({ releaseReason: "handoff", state: "released" });
    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The completed handoff is already an ancestor of the target."
    );

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(finalized.cleanup.removedWorktrees).toContain(handedOff);
    expect(finalized.cleanup.removedBranches).toContainEqual({
      branch: "handoff-ancestry",
      method: "target-contained",
    });
    expect(existsSync(handedOff)).toBe(false);
  }, 60_000);

  test("keeps another owner's claim on a clean target-contained checkout at finalization", () => {
    const fixture = repository();
    const claimed = join(fixture.base, "other-owner-clean");
    git(fixture.root, ["worktree", "add", "-b", "other-owner-clean", claimed]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    claimWorktree(fixture.root, "other-agent", claimed, "codex");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Another owner's claim is not the controller's to release."
    );

    expect(finalized.outcome).toBe("completed");
    expect(finalized.cleanup.releasedClaims).toEqual([]);
    expect(existsSync(claimed)).toBe(true);
    expect(readWorktreeCoordination(fixture.root).claims[0]?.state).toBe(
      "active"
    );
  });

  test("releases a claim whose worktree directory vanished and prunes its metadata at finalization", () => {
    const fixture = repository();
    const vanished = join(fixture.base, "vanished-claim");
    git(fixture.root, ["worktree", "add", "-b", "vanished-claim", vanished]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const claim = claimWorktree(fixture.root, "other-agent", vanished, "codex");
    rmSync(vanished, { force: true, recursive: true });

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "A claim on a missing directory protects nothing."
    );

    expect(finalized.outcome).toBe("completed");
    expect(finalized.cleanup.releasedClaims).toEqual([
      {
        claimId: claim.claimId,
        path: vanished,
        releaseReason: "worktree-absent",
      },
    ]);
    expect(finalized.cleanup.prunedWorktreeMetadata).toBe(1);
    expect(readWorktreeCoordination(fixture.root).claims[0]).toMatchObject({
      releaseReason: "worktree-absent",
      state: "released",
    });
  });

  test("releases an orphaned claim that was never registered with the lease", () => {
    const fixture = repository();
    const orphan = join(fixture.base, "orphan-claim");
    git(fixture.root, ["worktree", "add", "-b", "orphan-claim", orphan]);
    const claim = claimWorktree(fixture.root, "gone-agent", orphan, "codex");
    rmSync(orphan, { force: true, recursive: true });
    git(fixture.root, ["worktree", "prune"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Release bookkeeping for a checkout that no longer exists."
    );

    expect(finalized.outcome).toBe("completed");
    expect(finalized.cleanup.releasedClaims).toEqual([
      {
        claimId: claim.claimId,
        path: orphan,
        releaseReason: "worktree-absent",
      },
    ]);
  });

  test("serializes final cleanup against coordination-state mutations", () => {
    const fixture = repository();
    const cleanupCandidate = join(fixture.base, "cleanup-candidate");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "cleanup-candidate",
      cleanupCandidate,
    ]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const {
      repository: { commonGitDirectory },
    } = captureInventory(fixture.root);

    withWorktreeCoordinationLock(
      commonGitDirectory,
      "simulated concurrent claim",
      () => {
        expect(() =>
          finalizeLoop(
            fixture.root,
            lease.runId,
            "controller",
            "Do not race a coordination mutation."
          )
        ).toThrow("is busy");
      }
    );

    expect(existsSync(cleanupCandidate)).toBe(true);
    expect(readLoopLease(fixture.root)?.controller?.status).toBe("active");
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

  test("automatically restores a clean target-contained primary checkout", () => {
    const fixture = repository();
    git(fixture.root, ["checkout", "-b", "merged-controller"]);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The primary checkout still needs restoration."
    );

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(git(fixture.root, ["branch", "--show-current"])).toBe("main");
    expect(git(fixture.root, ["branch", "--list", "merged-controller"])).toBe(
      ""
    );
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

  test("automatically removes a clean target-contained detached worktree", () => {
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

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(existsSync(detachedWorktree)).toBe(false);
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
    const unfinished = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "unfinished-author",
      "unfinished unit"
    );
    writeFixture(unfinished.path, "unfinished.txt", "still being authored\n");
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
    const resumedStatus = loopStatus(fixture.root);
    expect(resumedStatus.verification.ok).toBe(true);
    expect(resumedStatus.lease?.worktrees).not.toContainEqual(
      expect.objectContaining({ path: concurrentPath })
    );
    expect(
      guardLoopMutation(fixture.root, lease.runId, "replacement-controller").ok
    ).toBe(true);
  }, 40_000);

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
  }, 60_000);
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

  test("reconciles an already-missing retained checkout when its branch is target-contained", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const temporary = join(fixture.base, "temporary-deployment");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "temporary-deployment",
      temporary,
    ]);
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === temporary
    );
    if (!current) {
      throw new Error("Expected the temporary deployment worktree");
    }
    retainExcludedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      temporary,
      current.changeDigest,
      "user",
      "Keep this clean temporary checkout outside the shipment."
    );

    git(fixture.root, ["worktree", "remove", temporary]);
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "missing-retained-worktree",
        path: temporary,
      })
    );

    expect(
      finalizeLoop(
        fixture.root,
        lease.runId,
        "controller",
        "Reconcile the already-absent target-contained checkout."
      )
    ).toMatchObject({ blockers: [], outcome: "completed" });
  }, 20_000);

  test("keeps a missing retained checkout blocked when its branch has unique work", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const temporary = join(fixture.base, "temporary-unique");
    git(fixture.root, ["worktree", "add", "-b", "temporary-unique", temporary]);
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === temporary
    );
    if (!current) {
      throw new Error("Expected the temporary unique worktree");
    }
    retainExcludedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      temporary,
      current.changeDigest,
      "user",
      "Keep this clean temporary checkout outside the shipment."
    );
    writeFixture(temporary, "unique.ts", "export const unique = true;\n");
    git(temporary, ["add", "unique.ts"]);
    git(temporary, ["commit", "-m", "unique temporary work"]);
    git(fixture.root, ["worktree", "remove", temporary]);

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Do not reconcile a checkout whose branch has unique work."
    );
    expect(finalized.outcome).toBe("relinquished");
    expect(finalized.verification.violations).toContainEqual(
      expect.objectContaining({
        code: "missing-retained-worktree",
        path: temporary,
      })
    );
  }, 20_000);

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

  test("rebinds multiple exact stale paused claims sequentially", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const paths = [
      join(fixture.base, "stale-paused-first"),
      join(fixture.base, "stale-paused-second"),
    ];
    const receipts = paths.map((path, index) => {
      git(fixture.root, ["worktree", "add", "-b", `stale-${index}`, path]);
      const opening = captureInventory(fixture.root).worktrees.find(
        (worktree) => worktree.path === path
      );
      if (!opening) {
        throw new Error("Expected stale claim fixture worktree");
      }
      retainExcludedWorktree(
        fixture.root,
        lease.runId,
        "controller",
        path,
        opening.changeDigest,
        "user",
        "Preserve the claimed worktree."
      );
      claimWorktree(
        path,
        `old-owner-${index}`,
        path,
        "codex-desktop",
        `task-${index}`
      );
      const oldReceipt = pauseClaimedWorktree(
        path,
        `old-owner-${index}`,
        path,
        lease.runId,
        "preserve-in-place",
        "Pause before owner handoff."
      );
      acceptPausedWorktreeChange(
        fixture.root,
        lease.runId,
        "controller",
        oldReceipt.receiptId
      );
      releaseWorktreeClaim(path, `old-owner-${index}`, oldReceipt.claimId);
      claimWorktree(
        path,
        `new-owner-${index}`,
        path,
        "codex-desktop",
        `replacement-${index}`
      );
      return pauseClaimedWorktree(
        path,
        `new-owner-${index}`,
        path,
        lease.runId,
        "preserve-in-place",
        "Rebind the exact unchanged checkout."
      );
    });

    expect(verifyLoop(fixture.root).violations).toEqual(
      expect.arrayContaining(
        paths.map((path) =>
          expect.objectContaining({ code: "coordination-claim-stale", path })
        )
      )
    );
    const [firstReceipt, secondReceipt] = receipts;
    if (!(firstReceipt && secondReceipt)) {
      throw new Error("Expected two replacement pause receipts");
    }

    acceptPausedWorktreeChange(
      fixture.root,
      lease.runId,
      "controller",
      firstReceipt.receiptId
    );
    expect(verifyLoop(fixture.root).violations).toEqual([
      expect.objectContaining({
        code: "coordination-claim-stale",
        path: paths[1],
      }),
    ]);
    acceptPausedWorktreeChange(
      fixture.root,
      lease.runId,
      "controller",
      secondReceipt.receiptId
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
  }, 60_000);

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
    expect(lease.targetRef).toBe("origin/main");
    expect(lease.targetRevision).toBe(
      git(fixture.root, ["rev-parse", "origin/main"])
    );
    expect(targetRegistration).toMatchObject({
      branch: "main",
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

  test("records multiple exact historical overrides without an atomic deadlock", () => {
    const fixture = repository();
    const first = join(fixture.base, "first-preserved");
    const second = join(fixture.base, "second-preserved");
    git(fixture.root, ["worktree", "add", "-b", "first-work", first]);
    git(fixture.root, ["worktree", "add", "-b", "second-work", second]);
    const lease = startLoop(fixture.root, "controller", "ship");
    writeFixture(first, "first.ts", "export const first = true;\n");
    writeFixture(second, "second.ts", "export const second = true;\n");
    const inventory = captureInventory(fixture.root);
    const firstCurrent = inventory.worktrees.find(
      (worktree) => worktree.path === first
    );
    const secondCurrent = inventory.worktrees.find(
      (worktree) => worktree.path === second
    );

    const afterFirst = grantLoopOverride(
      fixture.root,
      lease.runId,
      "controller",
      first,
      firstCurrent?.changeDigest ?? "",
      "user",
      "Approve the first exact historical checkout"
    );

    expect(afterFirst.overrides).toContainEqual(
      expect.objectContaining({ path: first })
    );
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "preserved-worktree-changed",
        path: second,
      })
    );

    const afterSecond = grantLoopOverride(
      fixture.root,
      lease.runId,
      "controller",
      second,
      secondCurrent?.changeDigest ?? "",
      "user",
      "Approve the second exact historical checkout"
    );

    expect(
      afterSecond.overrides
        .map((override) => override.path)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual([first, second].sort((left, right) => left.localeCompare(right)));
    expect(verifyLoop(fixture.root).ok).toBe(true);
  });

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

  test("blocks Ship mutations until every opening worktree change is accounted for", () => {
    const fixture = repository();
    const analyticsWorktree = join(fixture.base, "analytics");
    git(fixture.root, ["worktree", "add", "--detach", analyticsWorktree]);
    writeFixture(
      fixture.root,
      "contact.ts",
      "export const email = 'resend';\n"
    );
    writeFixture(
      analyticsWorktree,
      "analytics.ts",
      "export const analytics = true;\n"
    );
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");

    expect(() =>
      guardLoopMutation(fixture.root, lease.runId, "controller")
    ).toThrow("comprehensive shipment scope");
    expect(() =>
      prepareAgentWorktree(
        fixture.root,
        lease.runId,
        "late-author",
        "must-wait-for-scope"
      )
    ).toThrow("Record the comprehensive shipment scope");

    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current),
      "Ship every finished local change"
    );
    expect(new Set(plan.units.map((unit) => unit.sourceWorktree))).toEqual(
      new Set([fixture.root, analyticsWorktree])
    );
    const incomplete = {
      ...plan,
      units: plan.units.filter(
        (unit) => unit.sourceWorktree !== analyticsWorktree
      ),
    };
    expect(() =>
      recordShipmentScope(fixture.root, lease.runId, "controller", incomplete)
    ).toThrow("does not conserve");

    const receipt = recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      plan
    );
    expect(receipt.includedPaths).toBe(2);
    expect(receipt.summary).toContain("Included:");
    expect(receipt.summary).toContain(fixture.root);
    expect(receipt.summary).toContain(analyticsWorktree);
    expect(receipt.summary).toContain("detached@");
    expect(receipt.summary).toContain("No changed path is unaccounted for");
    expect(() =>
      recordShipmentScope(fixture.root, lease.runId, "controller", plan)
    ).toThrow("Use loop refresh-scope");
    expect(guardLoopMutation(fixture.root, lease.runId, "controller").ok).toBe(
      true
    );

    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "Record the exact reviewed shipment outcome"
    );
    const unchangedTarget = git(fixture.root, ["rev-parse", "main"]);
    const fabricatedEquivalent = shipmentOutcome(
      fixture.root,
      lease,
      plan,
      unchangedTarget
    );
    for (const unit of fabricatedEquivalent.units) {
      unit.disposition = "target-equivalent";
    }
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        fabricatedEquivalent
      )
    ).toThrow("does not match its exact opening source result");
    writeFixture(
      fixture.root,
      "contact.ts",
      "export const email = 'resend';\nexport const tracking = 'analytics';\n"
    );
    writeFixture(
      fixture.root,
      "analytics.ts",
      "export const analytics = true;\n"
    );
    const reviewedInventory = captureInventory(fixture.root);
    const reviewedPlan = buildPreviewPlan(
      reviewedInventory,
      reviewedInventory,
      compareSnapshots(reviewedInventory, reviewedInventory),
      "Ship reviewed local changes"
    );
    const refreshed = recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      reviewedPlan,
      true
    );
    expect(refreshed.planDigest).not.toBe(receipt.planDigest);
    const refreshedLease = readLoopLease(fixture.root);
    expect(refreshedLease?.shipmentScopeHistory).toHaveLength(1);
    expect(refreshedLease?.shipmentScopeHistory?.[0]?.planDigest).toBe(
      receipt.planDigest
    );
    const activePlan = refreshedLease?.shipmentScope?.plan;
    if (!activePlan) {
      throw new Error("Expected refreshed shipment scope.");
    }
    git(fixture.root, ["add", "contact.ts", "analytics.ts"]);
    git(fixture.root, ["commit", "-m", "Ship complete scoped work"]);
    const targetRevision = git(fixture.root, ["rev-parse", "main"]);
    const outcome = shipmentOutcome(
      fixture.root,
      lease,
      activePlan,
      targetRevision
    );
    const wrongOutcome = structuredClone(outcome);
    const wrongPath = wrongOutcome.units[0]?.finalPaths[0];
    if (wrongPath) {
      wrongPath.entry = `100644:blob:${"a".repeat(40)}`;
    }
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        wrongOutcome
      )
    ).toThrow("does not match final target");
    recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  }, 60_000);

  test("rejects a branch switch before loop exec can move the checkout", async () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");

    await expect(
      executeLoopMutation(fixture.root, lease.runId, "controller", [
        "git",
        "switch",
        "-c",
        "wrong-branch",
      ])
    ).rejects.toThrow("Do not switch");
    await expect(
      executeLoopMutation(fixture.root, lease.runId, "controller", [
        "git",
        "--literal-pathspecs",
        "checkout",
        "another-wrong-branch",
      ])
    ).rejects.toThrow("cannot safely classify Git global option");
    await expect(
      executeLoopMutation(fixture.root, lease.runId, "controller", [
        "git",
        "--git-dir",
        ".git",
        "--work-tree",
        ".",
        "checkout",
        "-b",
        "also-wrong",
      ])
    ).rejects.toThrow("Do not switch");
    expect(git(fixture.root, ["branch", "--show-current"])).toBe("main");
    writeFixture(fixture.root, "README.md", "changed locally\n");
    const restored = await executeLoopMutation(
      fixture.root,
      lease.runId,
      "controller",
      ["git", "checkout", "--", "README.md"]
    );
    expect(restored.result.exitCode).toBe(0);
    expect(readFileSync(join(fixture.root, "README.md"), "utf8")).toBe(
      "# Fixture\n"
    );
    expect(guardLoopMutation(fixture.root, lease.runId, "controller").ok).toBe(
      true
    );
  });

  test("accepts only exact opening source results plus classified generated paths", () => {
    const fixture = repository();
    const sourceWorktree = join(fixture.base, "finished-feature");
    git(fixture.root, ["worktree", "add", "--detach", sourceWorktree]);
    writeFixture(
      sourceWorktree,
      "feature.ts",
      "export const feature = 'original';\n"
    );
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current),
      "Ship the reviewed feature"
    );
    recordShipmentScope(fixture.root, lease.runId, "controller", plan);

    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "Record the exact reviewed shipment outcome"
    );
    writeFixture(
      fixture.root,
      "feature.ts",
      "export const feature = 'original';\n"
    );
    writeFixture(
      fixture.root,
      "review-helper.ts",
      "export const reviewed = true;\n"
    );
    git(fixture.root, ["add", "feature.ts", "review-helper.ts"]);
    git(fixture.root, ["commit", "-m", "Ship reviewed feature"]);

    const targetRevision = git(fixture.root, ["rev-parse", "main"]);
    const outcome = shipmentOutcome(fixture.root, lease, plan, targetRevision);
    const hiddenReviewDelta = structuredClone(outcome);
    hiddenReviewDelta.units[0]?.finalPaths.push({
      entry: treeEntry(fixture.root, targetRevision, "review-helper.ts"),
      path: "review-helper.ts",
    });
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        hiddenReviewDelta
      )
    ).toThrow("includes unscoped final path review-helper.ts");
    const unchangedAdditional = structuredClone(outcome);
    unchangedAdditional.additionalPaths.push({
      classification: "release-generated",
      entry: treeEntry(fixture.root, targetRevision, "README.md"),
      path: "README.md",
      reason: "This unchanged path must not be accepted as a delta.",
    });
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        unchangedAdditional
      )
    ).toThrow("is not part of the final target delta");
    expect(() =>
      recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome)
    ).toThrow("omits final target delta paths: review-helper.ts");
    outcome.additionalPaths.push({
      classification: "release-generated",
      entry: treeEntry(fixture.root, targetRevision, "review-helper.ts"),
      path: "review-helper.ts",
      reason: "Release reconciliation generated a focused helper.",
    });
    recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome);

    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

  test("binds rename deletion and destination in the final outcome", () => {
    const fixture = repository();
    git(fixture.root, ["mv", "README.md", "GUIDE.md"]);
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current),
      "Ship the documentation rename"
    );
    recordShipmentScope(fixture.root, lease.runId, "controller", plan);
    git(fixture.root, ["commit", "-am", "Rename guide"]);
    const targetRevision = git(fixture.root, ["rev-parse", "main"]);
    const outcome = shipmentOutcome(fixture.root, lease, plan, targetRevision);
    expect(() =>
      recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome)
    ).toThrow("omits rename original path README.md");
    const [renameUnit] = outcome.units;
    if (!renameUnit) {
      throw new Error("Expected the rename shipment unit.");
    }
    renameUnit.originalPaths.push({
      entry: null,
      path: "README.md",
    });
    recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

  test("binds gitlink entries in the exact final outcome", () => {
    const fixture = repository();
    const dependency = repository();
    git(fixture.root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      dependency.root,
      "vendor/dependency",
    ]);
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current),
      "Ship the reviewed dependency pin"
    );
    recordShipmentScope(fixture.root, lease.runId, "controller", plan);
    git(fixture.root, ["commit", "-am", "Add dependency pin"]);
    const targetRevision = git(fixture.root, ["rev-parse", "main"]);
    const outcome = shipmentOutcome(fixture.root, lease, plan, targetRevision);
    expect(
      outcome.units
        .flatMap((unit) => unit.finalPaths)
        .find((item) => item.path === "vendor/dependency")?.entry
    ).toContain(":commit:");
    recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

  test("records a broken symlink by its opening link target", () => {
    const fixture = repository();
    symlinkSync("missing-guide", join(fixture.root, "guide-link"));
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current),
      "Ship the documentation link"
    );
    recordShipmentScope(fixture.root, lease.runId, "controller", plan);
    const expectedObject = createHash("sha1")
      .update("blob 13\0missing-guide")
      .digest("hex");
    const recordedLease = readLoopLease(fixture.root);
    if (!recordedLease?.shipmentScope) {
      throw new Error("Expected the recorded shipment scope.");
    }
    expect(
      recordedLease.shipmentScope.openingChanges.find(
        (change) => change.path === "guide-link"
      )?.sourceEntry
    ).toBe(`120000:blob:${expectedObject}`);
  });

  test("binds regular source identity through Git clean filters", () => {
    const fixture = repository();
    writeFixture(fixture.root, ".gitattributes", "*.txt text\n");
    git(fixture.root, ["add", ".gitattributes"]);
    git(fixture.root, ["commit", "-m", "Configure text normalization"]);
    writeFixture(fixture.root, "value.txt", "first\r\nsecond\r\n");
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current),
      "Ship normalized text"
    );
    recordShipmentScope(fixture.root, lease.runId, "controller", plan);
    git(fixture.root, ["add", "value.txt"]);
    git(fixture.root, ["commit", "-m", "Add normalized text"]);
    const targetRevision = git(fixture.root, ["rev-parse", "main"]);
    const outcome = shipmentOutcome(fixture.root, lease, plan, targetRevision);
    for (const unit of outcome.units) {
      unit.disposition = "target-equivalent";
    }
    recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

  test("binds a leading-dash filename as source content, not a Git option", () => {
    const fixture = repository();
    writeFixture(fixture.root, "--value.txt", "literal filename\n");
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current),
      "Ship the literal leading-dash filename"
    );
    recordShipmentScope(fixture.root, lease.runId, "controller", plan);
    git(fixture.root, ["add", "--", "--value.txt"]);
    git(fixture.root, ["commit", "-m", "Add literal filename"]);
    const targetRevision = git(fixture.root, ["rev-parse", "main"]);
    const outcome = shipmentOutcome(fixture.root, lease, plan, targetRevision);
    for (const unit of outcome.units) {
      unit.disposition = "delivered";
    }
    recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

  test("keeps author-local commits concurrent while an integration mutation holds the lease lock", async () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const firstAuthor = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author-one",
      "concurrent-one"
    );
    const secondAuthor = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author-two",
      "concurrent-two"
    );
    let announceLockHeld: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      announceLockHeld = resolve;
    });
    let releaseIntegrationMutation: (() => void) | undefined;
    const integrationMutationReleased = new Promise<void>((resolve) => {
      releaseIntegrationMutation = resolve;
    });
    const integrationMutation = withLoopMutationLease(
      fixture.root,
      lease.runId,
      "controller",
      "hold shared integration step",
      async () => {
        announceLockHeld?.();
        await integrationMutationReleased;
        return "released";
      }
    );

    await lockHeld;
    writeFixture(firstAuthor.path, "author-one.txt", "one\n");
    git(firstAuthor.path, ["add", "author-one.txt"]);
    git(firstAuthor.path, ["commit", "-m", "author one"]);
    writeFixture(secondAuthor.path, "author-two.txt", "two\n");
    git(secondAuthor.path, ["add", "author-two.txt"]);
    git(secondAuthor.path, ["commit", "-m", "author two"]);
    releaseIntegrationMutation?.();

    expect((await integrationMutation).result).toBe("released");
    expect(git(firstAuthor.path, ["show", "--format=%s", "--no-patch"])).toBe(
      "author one"
    );
    expect(git(secondAuthor.path, ["show", "--format=%s", "--no-patch"])).toBe(
      "author two"
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
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
    const lease = startLoop(
      fixture.root,
      "controller",
      "integrate",
      remoteSnapshot(targetRevision)
    );

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

describe("target-equivalent loop closure", () => {
  test("escapes the frozen-scope dead end when the work is already contained in the target", () => {
    const fixture = repository();
    const keepPath = join(fixture.base, "keep");
    git(fixture.root, ["worktree", "add", "-b", "keep-branch", keepPath]);
    writeFixture(keepPath, "keep.txt", "independent concurrent work\n");
    git(keepPath, ["add", "keep.txt"]);
    git(keepPath, ["commit", "-m", "Independent work outside the target"]);

    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "first-controller", "ship");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "opening unit"
    );
    writeFixture(prepared.path, "unfinished.txt", "still being authored\n");

    expect(
      finalizeLoop(
        fixture.root,
        lease.runId,
        "first-controller",
        "Agent turn finished before shipping reconciliation completed."
      )
    ).toMatchObject({
      lease: { shipmentScopeFrozenAt: expect.any(String) },
      outcome: "relinquished",
    });

    startLoop(fixture.root, "next-controller", "resume");
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current),
      "Ship the unfinished unit"
    );
    expect(() =>
      recordShipmentScope(fixture.root, lease.runId, "next-controller", plan)
    ).toThrow("close-equivalent");

    // The work turns out to already belong in the target.
    git(prepared.path, ["add", "unfinished.txt"]);
    git(prepared.path, ["commit", "-m", "Finish the unit"]);
    git(fixture.root, ["merge", "--ff-only", prepared.branch]);

    const closed = closeLoopTargetEquivalent(
      fixture.root,
      lease.runId,
      "next-controller",
      "user",
      "The unit already landed on main; nothing is left to ship."
    );
    expect(closed.outcome).toBe("target-equivalent");
    expect(closed.worktrees).toContainEqual(
      expect.objectContaining({
        method: "target-ancestry",
        path: prepared.path,
      })
    );
    expect(closed.cleanup.removedWorktrees).toContain(prepared.path);
    expect(readLoopLease(fixture.root)).toBeNull();
    expect(existsSync(prepared.path)).toBe(false);
    expect(existsSync(keepPath)).toBe(true);
    expect(
      git(fixture.root, ["rev-parse", "--verify", "keep-branch"])
    ).toBeTruthy();

    const { commonGitDirectory } = captureInventory(fixture.root).repository;
    const archived = JSON.parse(
      readFileSync(
        join(
          commonGitDirectory,
          "simple-changes",
          "history",
          lease.runId,
          "close-equivalent.json"
        ),
        "utf8"
      )
    ) as Record<string, unknown>;
    expect(archived).toMatchObject({
      approvedBy: "user",
      authority: "close-equivalent",
      kind: "loop-close-equivalent",
      outcome: "target-equivalent",
      runId: lease.runId,
    });
    expect(JSON.stringify(archived)).not.toContain("shipped");
  }, 90_000);

  test("closes a relinquished loop directly with explicit approval, without takeover or resume", () => {
    const fixture = repository();
    writeFixture(fixture.root, "opening.txt", "opening shipment work\n");
    const lease = startLoop(fixture.root, "first-controller", "ship");
    expect(
      finalizeLoop(
        fixture.root,
        lease.runId,
        "first-controller",
        "Controller ended before recording shipment scope."
      )
    ).toMatchObject({ outcome: "relinquished" });

    git(fixture.root, ["add", "opening.txt"]);
    git(fixture.root, ["commit", "-m", "Opening work landed on main directly"]);

    const closed = closeLoopTargetEquivalent(
      fixture.root,
      lease.runId,
      "recovery-agent",
      "user",
      "The opening work is already contained in main."
    );
    expect(closed.outcome).toBe("target-equivalent");
    expect(readLoopLease(fixture.root)).toBeNull();
  });

  test("blocks closure and names each unproven worktree when work remains", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "dirty unit"
    );
    writeFixture(prepared.path, "unshipped.txt", "not shipped anywhere\n");

    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        lease.runId,
        "controller",
        "user",
        "Attempting to close with unshipped work."
      )
    ).toThrow(`${prepared.path}: the worktree has uncommitted changes`);
    expect(readLoopLease(fixture.root)).toMatchObject({ runId: lease.runId });
    expect(existsSync(prepared.path)).toBe(true);
  });

  test("rejects a stale equivalence receipt whose recorded head moved", () => {
    const fixture = repository();
    const schemaPath = join(fixture.base, "worktree-equivalence.schema.json");
    writeFileSync(schemaPath, `${JSON.stringify({ type: "object" })}\n`);
    process.env.SIMPLE_CHANGES_TEST_WORKTREE_EQUIVALENCE_SCHEMA = schemaPath;
    try {
      const lease = startLoop(fixture.root, "controller", "ship");
      const prepared = prepareAgentWorktree(
        fixture.root,
        lease.runId,
        "author",
        "diverged unit"
      );
      writeFixture(prepared.path, "diverged.txt", "committed but unmerged\n");
      git(prepared.path, ["add", "diverged.txt"]);
      git(prepared.path, ["commit", "-m", "Diverge from the target"]);
      const targetRevision = git(fixture.root, ["rev-parse", "main"]);

      const staleReceipt = {
        changeDigest:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        commits: [],
        disclaimer: "Read-only audit evidence; not a shipment record.",
        equivalence: "contained",
        head: prepared.baseRevision,
        mergeBase: prepared.baseRevision,
        paths: [],
        targetRef: "main",
        targetRevision,
      };
      expect(() =>
        closeLoopTargetEquivalent(
          fixture.root,
          lease.runId,
          "controller",
          "user",
          "Attempting closure with stale evidence.",
          [{ receipt: staleReceipt, worktreePath: prepared.path }]
        )
      ).toThrow("stale");
      expect(readLoopLease(fixture.root)).toMatchObject({ runId: lease.runId });
      expect(existsSync(prepared.path)).toBe(true);
    } finally {
      Reflect.deleteProperty(
        process.env,
        "SIMPLE_CHANGES_TEST_WORKTREE_EQUIVALENCE_SCHEMA"
      );
    }
  });

  test("rejects an equivalence receipt after dirty bytes change", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "dirty equivalent unit"
    );
    writeFixture(fixture.root, "shared.txt", "contained bytes\n");
    git(fixture.root, ["add", "shared.txt"]);
    git(fixture.root, ["commit", "-m", "Add contained target bytes"]);
    writeFixture(prepared.path, "shared.txt", "contained bytes\n");
    const receipt = auditWorktreeEquivalence({
      targetRef: "main",
      worktreePath: prepared.path,
    });
    expect(receipt.equivalence).toBe("contained");

    writeFixture(prepared.path, "shared.txt", "unique later bytes\n");
    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        lease.runId,
        "controller",
        "user",
        "Attempting closure with stale dirty evidence.",
        [{ receipt, worktreePath: prepared.path }]
      )
    ).toThrow("worktree digest");
    expect(readLoopLease(fixture.root)).toMatchObject({ runId: lease.runId });
  });

  test("keeps a missing registered author as an unproven obligation", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "missing obligated unit"
    );
    git(fixture.root, ["worktree", "remove", prepared.path]);

    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        lease.runId,
        "controller",
        "user",
        "Attempting closure with a missing author worktree."
      )
    ).toThrow("obligated worktree is missing");
    expect(readLoopLease(fixture.root)).toMatchObject({ runId: lease.runId });
  });

  test("requires an explicit approver and reason", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        lease.runId,
        "controller",
        "  ",
        "A reason without an approver."
      )
    ).toThrow("approver is required");
    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        lease.runId,
        "controller",
        "user",
        "  "
      )
    ).toThrow("reason is required");
    expect(readLoopLease(fixture.root)).toMatchObject({ runId: lease.runId });
  });
});
