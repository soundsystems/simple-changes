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
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sleep, spawnSync } from "bun";
import { PATCH_EQUIVALENCE_MAX_COMMITS } from "../../../skills/simple-changes/scripts/lib/cleanup-core.ts";
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
  rebaselineLoopWorktrees,
  recordEmergencyShipping,
  recordRemoteBranchReconciliation,
  recordShipmentOutcome,
  recordShipmentScope,
  recoverLoopLock,
  recoverPostCleanupLoop,
  retainExcludedWorktree,
  retireAbsentWorktree,
  staleClaimRecoveryCommands,
  startLoop,
  takeoverLoop,
  verifyLoop,
  withLoopMutationLease,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import {
  remoteBranchReconciliationDigest,
  splitRemoteBranchReconciliationInput,
  validateRemoteBranchReconciliation,
} from "../../../skills/simple-changes/scripts/lib/remote-branch-reconciliation.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import type {
  ChangePlan,
  LoopLease,
  RemoteBranchReconciliationReceipt,
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
  worktreeCoordinationPath,
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
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
setDefaultTimeout(30_000);

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const commitFixture = (
  root: string,
  relativePath: string,
  contents: string
): void => {
  writeFixture(root, relativePath, contents);
  git(root, ["add", relativePath]);
  git(root, ["commit", "-m", `Update ${relativePath}`]);
};

const cliPath = fileURLToPath(
  new URL(
    "../../../skills/simple-changes/scripts/simple-changes.ts",
    import.meta.url
  )
);
const cliDecoder = new TextDecoder();

const runCli = (
  cwd: string,
  args: string[]
): { exitCode: number | null; stderr: string; stdout: string } => {
  const result = spawnSync([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: cliDecoder.decode(result.stderr),
    stdout: cliDecoder.decode(result.stdout),
  };
};

// Run printed recovery steps as written, filling in only their placeholders:
// each acceptance takes the next receipt an earlier pause printed.
const runPrintedSteps = (cwd: string, commands: readonly string[]): void => {
  const receipts: string[] = [];
  const fill = (word: string): string => {
    if (word === "<why>") {
      return "Recover-through-the-printed-steps";
    }
    return word === "<pause-receipt-id>" ? (receipts.shift() ?? word) : word;
  };
  for (const command of commands) {
    const args = command.split(" ").slice(1).map(fill);
    const result = runCli(cwd, [...args, "--json"]);
    expect({ command, stderr: result.stderr }).toEqual({ command, stderr: "" });
    expect(result.exitCode).toBe(0);
    if (args[1] === "pause") {
      receipts.push(
        (JSON.parse(result.stdout) as { receiptId: string }).receiptId
      );
    }
  }
};

// Reproduce the ledger written before opening provider and clean scope capture.
const removeLegacyOpeningEvidence = (stored: LoopLease): void => {
  Reflect.deleteProperty(stored, "openingRemoteInventory");
  stored.shipmentScopeRequired = false;
  Reflect.deleteProperty(stored, "shipmentScope");
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

const sha256Of = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Branch and proposal ledgers with one-page coverage for a reconciliation receipt. */
const remoteLedger = (
  branches: Array<{
    finalHeadRevision: string | null;
    initialHeadRevision: string | null;
    name: string;
    proposals: Array<{
      headRevision: string | null;
      objectId: string;
      observedFinally?: boolean;
      observedInitially?: boolean;
      state: string;
    }>;
  }>,
  phase: "initial" | "final"
) => {
  const branchEntries = branches
    .filter((branch) =>
      phase === "initial"
        ? branch.initialHeadRevision !== null
        : branch.finalHeadRevision !== null
    )
    .map((branch) => ({
      headRevision:
        phase === "initial"
          ? branch.initialHeadRevision
          : branch.finalHeadRevision,
      name: branch.name,
    }));
  const proposalEntries = branches.flatMap((branch) =>
    branch.proposals
      .filter((proposal) =>
        phase === "initial"
          ? proposal.observedInitially !== false
          : proposal.observedFinally !== false
      )
      .map((proposal) => ({
        branch: branch.name,
        headRevision: proposal.headRevision,
        objectId: proposal.objectId,
        state: proposal.state,
      }))
  );
  return {
    count: branchEntries.length,
    coverage: paginationCoverage(
      branchEntries.length,
      sha256Of(branchEntries),
      proposalEntries.length,
      sha256Of(proposalEntries)
    ),
  };
};

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

// Finalization closes a Ship run that changed nothing instead of freezing its
// scope. Tests about relinquished, frozen runs record mutation evidence first,
// as any guarded operation would, so finalization relinquishes them.
const stampFirstMutation = (root: string): void => {
  const path = loopLeasePath(
    captureInventory(root).repository.commonGitDirectory
  );
  const stored = JSON.parse(readFileSync(path, "utf8")) as LoopLease;
  stored.firstMutationAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
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
    removeLegacyOpeningEvidence(stored);
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
      removeLegacyOpeningEvidence(stored);
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
    removeLegacyOpeningEvidence(stored);
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
    removeLegacyOpeningEvidence(stored);
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
    removeLegacyOpeningEvidence(stored);
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
    removeLegacyOpeningEvidence(stored);
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
      removeLegacyOpeningEvidence(stored);
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
    removeLegacyOpeningEvidence(stored);
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
    removeLegacyOpeningEvidence(stored);
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
    removeLegacyOpeningEvidence(stored);
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
    removeLegacyOpeningEvidence(stored);
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
    stampFirstMutation(fixture.root);
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

  test("removes a target-contained checkout its owner released at finalization", () => {
    const fixture = repository();
    const released = join(fixture.base, "owner-release-ancestry");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "owner-release-ancestry",
      released,
    ]);
    const claim = claimWorktree(
      fixture.root,
      "release-author",
      released,
      "codex",
      "task-release-ancestry"
    );
    const lease = startLoop(fixture.root, "controller", "integrate");

    expect(
      releaseWorktreeClaim(released, "release-author", claim.claimId)
    ).toMatchObject({ releaseReason: "owner-release", state: "released" });
    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The released work is already an ancestor of the target."
    );

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(finalized.cleanup.removedWorktrees).toContain(released);
    expect(finalized.cleanup.removedBranches).toContainEqual({
      branch: "owner-release-ancestry",
      method: "target-contained",
    });
    expect(existsSync(released)).toBe(false);
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

    // The release records the exact state it released, dirty or not, and
    // admits only that state.
    releaseWorktreeClaim(fixture.root, "feature-agent", claim.claimId);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    writeFixture(authorPath, "feature.ts", "export const feature = 3;\n");
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "coordination-claim-stale",
        path: authorPath,
      })
    );
  });

  test("recovers an author changed after its owner released it through the printed steps", async () => {
    const fixture = repository();
    const authorPath = join(fixture.base, "released-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "released-author-work",
      authorPath,
    ]);
    const claim = claimWorktree(
      fixture.root,
      "subagent",
      authorPath,
      "claude-code",
      "task-subagent"
    );
    const lease = startLoop(fixture.root, "controller", "ship");
    expect(lease.worktrees).toContainEqual(
      expect.objectContaining({
        claimId: claim.claimId,
        path: authorPath,
        role: "concurrent-author",
      })
    );
    commitFixture(authorPath, "feature.ts", "export const feature = 1;\n");
    releaseWorktreeClaim(authorPath, "subagent", claim.claimId);
    expect(verifyLoop(fixture.root).ok).toBe(true);

    // The 0.27.0 deadlock: a commit lands after the owner released its claim.
    commitFixture(authorPath, "feature.ts", "export const feature = 2;\n");
    const stale = verifyLoop(fixture.root).violations.find(
      (violation) =>
        violation.code === "coordination-claim-stale" &&
        violation.path === authorPath
    );
    const sequence = [
      `simple-changes worktree claim --agent-id subagent --worktree ${authorPath} --adapter claude-code --owner-ref task-subagent`,
      `simple-changes worktree pause --agent-id subagent --worktree ${authorPath} --run-id ${lease.runId} --disposition preserve-in-place --reason <why>`,
      `simple-changes loop accept-paused-change --run-id ${lease.runId} --agent-id controller --pause-receipt <pause-receipt-id>`,
    ];
    expect(stale?.nextCommands).toEqual(sequence);
    for (const command of sequence) {
      expect(stale?.message).toContain(`\`${command}\``);
    }
    expect(stale?.message).toContain(
      `no longer matches the exact state subagent released under claim ${claim.claimId} (owner-release)`
    );
    expect(stale?.message).not.toContain("Refresh the original claim");
    expect(loopStatus(fixture.root).guidance.nextCommands).toEqual(sequence);
    expect(() =>
      guardLoopMutation(fixture.root, lease.runId, "controller")
    ).toThrow("Run `simple-changes loop status` for the exact next commands.");
    await expect(
      withLoopMutationLease(
        fixture.root,
        lease.runId,
        "controller",
        "probe",
        () => undefined
      )
    ).rejects.toThrow(
      "Run `simple-changes loop status` for the exact next commands."
    );
    const verifyText = runCli(fixture.root, [
      "loop",
      "verify",
      "--run-id",
      lease.runId,
    ]);
    expect(verifyText.exitCode).not.toBe(0);
    for (const command of sequence) {
      expect(verifyText.stdout).toContain(`  Next: ${command}\n`);
    }

    // Run the printed steps as written, filling in only the placeholders.
    let receiptId = "";
    for (const command of sequence) {
      const args = command
        .split(" ")
        .slice(1)
        .map((word) =>
          word === "<why>"
            ? "Recover-the-released-author"
            : word.replace("<pause-receipt-id>", receiptId)
        );
      const result = runCli(fixture.root, [...args, "--json"]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      if (args[1] === "pause") {
        ({ receiptId } = JSON.parse(result.stdout) as { receiptId: string });
      }
    }
    expect(receiptId).toStartWith("pause-");
    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(readLoopLease(fixture.root)?.worktrees).toContainEqual(
      expect.objectContaining({
        path: authorPath,
        pauseReceiptId: receiptId,
        role: "preserved",
      })
    );
  });

  test("admits an author released at its exact current state by owner release or handoff", () => {
    const fixture = repository();
    const releasedPath = join(fixture.base, "owner-released");
    const handedOffPath = join(fixture.base, "handed-off");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "owner-released-work",
      releasedPath,
    ]);
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "handed-off-work",
      handedOffPath,
    ]);
    const activePath = join(fixture.base, "still-active");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "still-active-work",
      activePath,
    ]);
    const released = claimWorktree(
      fixture.root,
      "release-agent",
      releasedPath,
      "codex"
    );
    claimWorktree(fixture.root, "handoff-agent", handedOffPath, "codex");
    // A live claim on another checkout does not hold these released ones.
    claimWorktree(fixture.root, "active-agent", activePath, "codex");
    startLoop(fixture.root, "controller", "ship");
    // Both owners commit after claiming, so only the release itself can
    // record the state the loop admits.
    commitFixture(releasedPath, "released.ts", "export const done = 1;\n");
    commitFixture(handedOffPath, "handoff.ts", "export const done = 1;\n");

    const releasedClaim = releaseWorktreeClaim(
      releasedPath,
      "release-agent",
      released.claimId
    );
    const handedOffClaim = releaseHandoffWorktreeClaim(
      handedOffPath,
      "handoff-agent"
    );
    const current = (path: string) =>
      captureInventory(fixture.root).worktrees.find(
        (worktree) => worktree.path === path
      );
    for (const [claim, path, reason] of [
      [releasedClaim, releasedPath, "owner-release"],
      [handedOffClaim, handedOffPath, "handoff"],
    ] as const) {
      expect(claim).toMatchObject({
        branch: current(path)?.branch,
        changeDigest: current(path)?.changeDigest,
        headSha: current(path)?.headSha,
        releaseReason: reason,
        state: "released",
      });
    }
    expect(verifyLoop(fixture.root).ok).toBe(true);
  });

  test("admits a released author only while every recorded fact still matches", () => {
    const fixture = repository();
    const authorPath = join(fixture.base, "released-facts");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "released-facts-work",
      authorPath,
    ]);
    const claim = claimWorktree(
      fixture.root,
      "fact-agent",
      authorPath,
      "codex"
    );
    startLoop(fixture.root, "controller", "ship");
    commitFixture(authorPath, "facts.ts", "export const facts = 1;\n");
    const released = releaseWorktreeClaim(
      authorPath,
      "fact-agent",
      claim.claimId
    );
    const coordinationPath = worktreeCoordinationPath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const original = readFileSync(coordinationPath, "utf8");
    const withClaim = (patch: Record<string, unknown>): void => {
      const document = JSON.parse(original) as {
        claims: Record<string, unknown>[];
      };
      document.claims = document.claims.map((item) =>
        item.claimId === claim.claimId ? { ...item, ...patch } : item
      );
      writeFileSync(coordinationPath, `${JSON.stringify(document)}\n`);
    };
    const staleFor = () =>
      verifyLoop(fixture.root).violations.filter(
        (violation) =>
          violation.code === "coordination-claim-stale" &&
          violation.path === authorPath
      );

    expect(verifyLoop(fixture.root).ok).toBe(true);
    withClaim({ releaseReason: "handoff" });
    expect(verifyLoop(fixture.root).ok).toBe(true);
    const changedState = `no longer matches the exact state fact-agent released under claim ${claim.claimId} (owner-release)`;
    for (const [patch, cause] of [
      [
        { releaseReason: "shipped" },
        `claim ${claim.claimId} of this concurrent author worktree was released (shipped), which does not hand its work off`,
      ],
      [
        { releaseReason: "takeover" },
        "was released (takeover), which does not hand its work off",
      ],
      [
        { owner: { ...released.owner, agentId: "another-agent" } },
        "no longer matches the exact state another-agent released",
      ],
      [{ path: join(fixture.base, "elsewhere") }, changedState],
      [{ branch: "another-branch" }, changedState],
      [{ headSha: "0".repeat(40) }, changedState],
      [{ changeDigest: "f".repeat(64) }, changedState],
      [
        { state: "stale" },
        `claim ${claim.claimId} of this concurrent author worktree is stale or records another branch`,
      ],
    ] as const) {
      withClaim(patch);
      const stale = staleFor();
      expect({ patch, stale: stale.length }).toEqual({ patch, stale: 1 });
      expect(stale[0]?.message).toContain(cause);
    }
    writeFileSync(coordinationPath, original);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    writeFixture(authorPath, "facts.ts", "export const facts = 2;\n");
    expect(staleFor()).toHaveLength(1);
  });

  test("tells an author whose own claim went inactive to refresh it in place", () => {
    const fixture = repository();
    const authorPath = join(fixture.base, "inactive-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "inactive-author-work",
      authorPath,
    ]);
    const ownerRef = "Ann's task";
    const claim = claimWorktree(
      fixture.root,
      "inactive-agent",
      authorPath,
      "codex",
      ownerRef
    );
    const lease = startLoop(fixture.root, "controller", "ship");
    pauseClaimedWorktree(
      authorPath,
      "inactive-agent",
      authorPath,
      lease.runId,
      "preserve-in-place",
      "Paused without being accepted."
    );
    const claimCommand = (agent: string) =>
      `simple-changes worktree claim --agent-id ${agent} --worktree ${authorPath} --adapter codex --owner-ref 'Ann'\\''s task'`;
    const refresh = [
      claimCommand("inactive-agent"),
      `simple-changes loop verify --run-id ${lease.runId}`,
    ];
    const pauseAndAccept = (agent: string) => [
      claimCommand(agent),
      `simple-changes worktree pause --agent-id ${agent} --worktree ${authorPath} --run-id ${lease.runId} --disposition preserve-in-place --reason <why>`,
      `simple-changes loop accept-paused-change --run-id ${lease.runId} --agent-id controller --pause-receipt <pause-receipt-id>`,
    ];
    const staleCommands = () =>
      verifyLoop(fixture.root).violations.find(
        (violation) =>
          violation.code === "coordination-claim-stale" &&
          violation.path === authorPath
      )?.nextCommands;

    expect(staleCommands()).toEqual(refresh);
    // The printed command runs as written in a POSIX shell and keeps the ID.
    const shell = spawnSync(
      [
        "sh",
        "-c",
        `${refresh[0]?.replace("simple-changes ", `'${process.execPath}' '${cliPath}' `)} --json`,
      ],
      {
        cwd: fixture.root,
        env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    expect(cliDecoder.decode(shell.stderr)).toBe("");
    expect(
      (
        JSON.parse(cliDecoder.decode(shell.stdout)) as {
          claim: { claimId: string; owner: { ownerRef: string } };
        }
      ).claim
    ).toMatchObject({ claimId: claim.claimId, owner: { ownerRef } });
    expect(verifyLoop(fixture.root).ok).toBe(true);

    // Only the registered owner can refresh the registered claim.
    const coordinationPath = worktreeCoordinationPath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const original = readFileSync(coordinationPath, "utf8");
    const document = JSON.parse(original) as {
      claims: { claimId: string; owner: { agentId: string } }[];
    };
    for (const item of document.claims) {
      if (item.claimId === claim.claimId) {
        item.owner.agentId = "other-agent";
      }
    }
    writeFileSync(coordinationPath, `${JSON.stringify(document)}\n`);
    expect(staleCommands()).toEqual(pauseAndAccept("other-agent"));
    writeFileSync(coordinationPath, original);

    // A live claim that recorded another branch is refreshed the same way
    // while the checkout stays on its registered branch.
    const moved = JSON.parse(original) as {
      claims: { branch: string | null; claimId: string }[];
    };
    for (const item of moved.claims) {
      if (item.claimId === claim.claimId) {
        item.branch = "inactive-author-elsewhere";
      }
    }
    writeFileSync(coordinationPath, `${JSON.stringify(moved)}\n`);
    expect(staleCommands()).toEqual(refresh);
    claimWorktree(
      fixture.root,
      "inactive-agent",
      authorPath,
      "codex",
      ownerRef
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);

    // The lease pins the author to its registered branch, so after a branch
    // switch only the exact pause and accept steps restore verification.
    git(authorPath, ["checkout", "-b", "inactive-author-renamed"]);
    expect(staleCommands()).toEqual(pauseAndAccept("inactive-agent"));
    claimWorktree(
      fixture.root,
      "inactive-agent",
      authorPath,
      "codex",
      ownerRef
    );
    const receipt = pauseClaimedWorktree(
      fixture.root,
      "inactive-agent",
      authorPath,
      lease.runId,
      "preserve-in-place",
      "Hand the renamed branch to the controller."
    );
    acceptPausedWorktreeChange(
      fixture.root,
      lease.runId,
      "controller",
      receipt.receiptId
    );
    expect(verifyLoop(fixture.root)).toMatchObject({
      ok: true,
      violations: [],
    });
  });

  test("asks an owner who claimed again after releasing to pause, not refresh", () => {
    const fixture = repository();
    const authorPath = join(fixture.base, "returning-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "returning-author-work",
      authorPath,
    ]);
    const first = claimWorktree(
      fixture.root,
      "returning-agent",
      authorPath,
      "codex",
      "task-return"
    );
    const lease = startLoop(fixture.root, "controller", "ship");
    releaseWorktreeClaim(authorPath, "returning-agent", first.claimId);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    const second = claimWorktree(
      fixture.root,
      "returning-agent",
      authorPath,
      "codex",
      "task-return"
    );
    expect(second.claimId).not.toBe(first.claimId);

    const stale = verifyLoop(fixture.root).violations.find(
      (violation) =>
        violation.code === "coordination-claim-stale" &&
        violation.path === authorPath
    );
    expect(stale?.message).toContain(
      `now held by claim ${second.claimId} of returning-agent, not by its registered claim ${first.claimId}`
    );
    expect(stale?.nextCommands).toEqual([
      `simple-changes worktree claim --agent-id returning-agent --worktree ${authorPath} --adapter codex --owner-ref task-return`,
      `simple-changes worktree pause --agent-id returning-agent --worktree ${authorPath} --run-id ${lease.runId} --disposition preserve-in-place --reason <why>`,
      `simple-changes loop accept-paused-change --run-id ${lease.runId} --agent-id controller --pause-receipt <pause-receipt-id>`,
    ]);
  });

  for (const concurrentWork of ["allow-claimed", "strict"] as const) {
    test(`accepts several changed adopted checkouts through the printed steps (${concurrentWork})`, () => {
      const fixture = repository();
      if (concurrentWork === "strict") {
        writeFixture(
          fixture.root,
          ".simple-changes.json",
          `${JSON.stringify({ ...DEFAULT_POLICY, concurrentWork })}\n`
        );
      }
      const paths = ["adopted-first", "adopted-second"].map((name) => {
        const path = join(fixture.base, name);
        git(fixture.root, ["worktree", "add", "-b", `${name}-work`, path]);
        return path;
      });
      const lease = startLoop(fixture.root, "controller", "integrate");
      expect(lease.concurrentWork).toBe(concurrentWork);
      for (const [index, path] of paths.entries()) {
        claimWorktree(fixture.root, `owner-${index}`, path, "codex");
        const receipt = pauseClaimedWorktree(
          fixture.root,
          `owner-${index}`,
          path,
          lease.runId,
          "preserve-in-place",
          "Pause for adoption."
        );
        acceptPausedWorktreeChange(
          fixture.root,
          lease.runId,
          "controller",
          receipt.receiptId
        );
      }
      expect(verifyLoop(fixture.root).ok).toBe(true);

      // Both owners keep editing after their receipts were accepted.
      for (const path of paths) {
        writeFixture(path, "changed.ts", "export const changed = true;\n");
      }
      const verification = verifyLoop(fixture.root);
      for (const path of paths) {
        for (const code of [
          "coordination-claim-stale",
          "preserved-worktree-changed",
        ]) {
          expect(verification.violations).toContainEqual(
            expect.objectContaining({ code, path })
          );
        }
      }
      const printed = staleClaimRecoveryCommands(verification.violations);
      expect(printed.map((command) => command.split(" ")[2])).toEqual([
        "claim",
        "pause",
        "claim",
        "pause",
        "accept-paused-change",
        "accept-paused-change",
      ]);
      // loop status prints exactly these steps: an override cannot resolve a
      // checkout whose coordination link is stale.
      expect(loopStatus(fixture.root).guidance.nextCommands).toEqual(printed);
      expect(
        runCli(fixture.root, ["loop", "verify", "--run-id", lease.runId]).stdout
      ).toContain(printed.map((command) => `  Next: ${command}\n`).join(""));

      runPrintedSteps(fixture.root, printed);
      expect(verifyLoop(fixture.root)).toMatchObject({
        ok: true,
        violations: [],
      });
    }, 120_000);
  }

  test("recovers two concurrent authors that both switched branches through the printed steps", () => {
    const fixture = repository();
    const paths = ["switching-first", "switching-second"].map((name) => {
      const path = join(fixture.base, name);
      git(fixture.root, ["worktree", "add", "-b", `${name}-work`, path]);
      return path;
    });
    for (const [index, path] of paths.entries()) {
      claimWorktree(fixture.root, `switcher-${index}`, path, "codex");
    }
    const lease = startLoop(fixture.root, "controller", "ship");
    for (const path of paths) {
      expect(lease.worktrees).toContainEqual(
        expect.objectContaining({ path, role: "concurrent-author" })
      );
    }
    for (const [index, path] of paths.entries()) {
      git(path, ["checkout", "-b", `switched-${index}`]);
    }
    const verification = verifyLoop(fixture.root);
    for (const path of paths) {
      for (const code of [
        "coordination-claim-stale",
        "registered-worktree-branch-changed",
      ]) {
        expect(verification.violations).toContainEqual(
          expect.objectContaining({ code, path })
        );
      }
    }
    const printed = staleClaimRecoveryCommands(verification.violations);
    expect(printed.map((command) => command.split(" ")[2])).toEqual([
      "claim",
      "pause",
      "claim",
      "pause",
      "accept-paused-change",
      "accept-paused-change",
    ]);
    expect(loopStatus(fixture.root).guidance.nextCommands).toEqual(printed);

    runPrintedSteps(fixture.root, printed);
    expect(verifyLoop(fixture.root)).toMatchObject({
      ok: true,
      violations: [],
    });
  }, 120_000);

  test("keeps a changed sibling blocking until its own current receipt covers it", () => {
    const fixture = repository();
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify({ ...DEFAULT_POLICY, concurrentWork: "strict" })}\n`
    );
    const [first, second] = ["sibling-first", "sibling-second"].map((name) => {
      const path = join(fixture.base, name);
      git(fixture.root, ["worktree", "add", "-b", `${name}-work`, path]);
      return path;
    });
    if (!(first && second)) {
      throw new Error("Expected two sibling worktrees");
    }
    const lease = startLoop(fixture.root, "controller", "integrate");
    const claimAndPause = (
      path: string,
      owner: string,
      runId = lease.runId
    ) => {
      claimWorktree(fixture.root, owner, path, "codex");
      return pauseClaimedWorktree(
        fixture.root,
        owner,
        path,
        runId,
        "preserve-in-place",
        "Pause the exact checkout."
      );
    };
    for (const [path, owner] of [
      [first, "first-owner"],
      [second, "second-owner"],
    ] as const) {
      acceptPausedWorktreeChange(
        fixture.root,
        lease.runId,
        "controller",
        claimAndPause(path, owner).receiptId
      );
    }
    writeFixture(first, "changed.ts", "export const changed = 1;\n");
    writeFixture(second, "changed.ts", "export const changed = 1;\n");
    const firstReceipt = claimAndPause(first, "first-owner");
    const acceptFirst = () =>
      acceptPausedWorktreeChange(
        fixture.root,
        lease.runId,
        "controller",
        firstReceipt.receiptId
      );
    const blockedBySecond = `preserved-worktree-changed:${second}`;

    // Its adoption receipt no longer matches the changed checkout.
    expect(acceptFirst).toThrow(blockedBySecond);
    // A receipt for another run does not cover it.
    claimAndPause(second, "second-owner", "run-another-run");
    expect(acceptFirst).toThrow(blockedBySecond);
    // Nor does a receipt whose claim is live again.
    claimAndPause(second, "second-owner");
    claimWorktree(fixture.root, "second-owner", second, "codex");
    expect(acceptFirst).toThrow(blockedBySecond);
    // Nor one whose checkout changed after the pause.
    pauseClaimedWorktree(
      fixture.root,
      "second-owner",
      second,
      lease.runId,
      "preserve-in-place",
      "Pause before another edit."
    );
    writeFixture(second, "changed.ts", "export const changed = 2;\n");
    expect(acceptFirst).toThrow(blockedBySecond);
    // Nor one whose claim another owner now holds.
    const secondReceipt = claimAndPause(second, "second-owner");
    const coordinationPath = worktreeCoordinationPath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const original = readFileSync(coordinationPath, "utf8");
    const reassigned = JSON.parse(original) as {
      claims: { claimId: string; owner: { agentId: string } }[];
    };
    for (const item of reassigned.claims) {
      if (item.claimId === secondReceipt.claimId) {
        item.owner.agentId = "another-owner";
      }
    }
    writeFileSync(coordinationPath, `${JSON.stringify(reassigned)}\n`);
    expect(acceptFirst).toThrow(blockedBySecond);
    writeFileSync(coordinationPath, original);

    // Its own exact current receipt lets the first checkout go first.
    acceptFirst();
    expect(verifyLoop(fixture.root).ok).toBe(false);
    acceptPausedWorktreeChange(
      fixture.root,
      lease.runId,
      "controller",
      secondReceipt.receiptId
    );
    expect(verifyLoop(fixture.root)).toMatchObject({
      ok: true,
      violations: [],
    });
  });

  test("never lets a receipt excuse the controller checkout switching branches", () => {
    const fixture = repository();
    const preserved = join(fixture.base, "accepted-beside-controller");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "accepted-beside-controller-work",
      preserved,
    ]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    writeFixture(preserved, "changed.ts", "export const changed = true;\n");
    claimWorktree(fixture.root, "preserved-owner", preserved, "codex");
    const receipt = pauseClaimedWorktree(
      fixture.root,
      "preserved-owner",
      preserved,
      lease.runId,
      "preserve-in-place",
      "Pause the changed checkout."
    );
    // Only the loop controller may claim its own checkout, and its receipt
    // still cannot excuse that checkout's branch change.
    git(fixture.root, ["checkout", "-b", "controller-switched"]);
    claimWorktree(fixture.root, "controller", fixture.root, "codex");
    pauseClaimedWorktree(
      fixture.root,
      "controller",
      fixture.root,
      lease.runId,
      "preserve-in-place",
      "Pause the controller checkout."
    );

    expect(() =>
      acceptPausedWorktreeChange(
        fixture.root,
        lease.runId,
        "controller",
        receipt.receiptId
      )
    ).toThrow(`registered-worktree-branch-changed:${fixture.root}`);
  });

  test("orders every printed recovery so it runs as printed", () => {
    const stale = (nextCommands: string[]) => ({
      changeDigest: null,
      code: "coordination-claim-stale" as const,
      headSha: null,
      message: "",
      nextCommands,
      path: "/checkout",
    });
    const verify = "simple-changes loop verify --run-id run-a";
    const accept = (receipt: string) =>
      `simple-changes loop accept-paused-change --run-id run-a --agent-id controller --pause-receipt ${receipt}`;

    expect(
      staleClaimRecoveryCommands([
        stale(["claim a", verify]),
        stale(["claim b", "pause b", accept("b")]),
        {
          changeDigest: null,
          code: "preserved-worktree-changed",
          headSha: null,
          message: "",
          path: "/other",
        },
        stale(["claim c", "pause c", accept("c")]),
        stale(["claim d", verify]),
      ])
    ).toEqual([
      "claim a",
      "claim b",
      "pause b",
      "claim c",
      "pause c",
      "claim d",
      accept("b"),
      accept("c"),
      verify,
    ]);
  });

  test("prints placeholders for a link whose owner is unknown", () => {
    const fixture = repository();
    const preservedPath = join(fixture.base, "unlinked-preserved");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "unlinked-preserved-work",
      preservedPath,
    ]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const leasePath = loopLeasePath(lease.commonGitDirectory);
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    stored.worktrees = stored.worktrees.map((worktree) =>
      worktree.path === preservedPath
        ? { ...worktree, claimId: "claim-missing" }
        : worktree
    );
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const stale = verifyLoop(fixture.root).violations.find(
      (violation) =>
        violation.code === "coordination-claim-stale" &&
        violation.path === preservedPath
    );
    expect(stale?.message).toStartWith(
      "The worktree lease has an incomplete coordination linkage. Owner <owner> runs"
    );
    expect(stale?.nextCommands).toEqual([
      `simple-changes worktree claim --agent-id <owner> --worktree ${preservedPath} --adapter <adapter>`,
      `simple-changes worktree pause --agent-id <owner> --worktree ${preservedPath} --run-id ${lease.runId} --disposition preserve-in-place --reason <why>`,
      `simple-changes loop accept-paused-change --run-id ${lease.runId} --agent-id controller --pause-receipt <pause-receipt-id>`,
    ]);
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
    // The release alone admits the unchanged checkout; a newer live claim
    // by anyone does not.
    expect(verifyLoop(fixture.root).ok).toBe(true);
    const secondClaim = claimWorktree(
      fixture.root,
      "second-agent",
      authorPath,
      "codex",
      "task-second"
    );
    const stale = verifyLoop(fixture.root).violations.find(
      (violation) =>
        violation.code === "coordination-claim-stale" &&
        violation.path === authorPath
    );
    expect(stale?.message).toContain(
      `now held by claim ${secondClaim.claimId} of second-agent, not by its registered claim ${firstClaim.claimId}`
    );
    expect(stale?.nextCommands).toEqual([
      `simple-changes worktree claim --agent-id second-agent --worktree ${authorPath} --adapter codex --owner-ref task-second`,
      `simple-changes worktree pause --agent-id second-agent --worktree ${authorPath} --run-id ${lease.runId} --disposition preserve-in-place --reason <why>`,
      `simple-changes loop accept-paused-change --run-id ${lease.runId} --agent-id controller --pause-receipt <pause-receipt-id>`,
    ]);
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

  test("retires a rebaselined worktree after its owner deletes it", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "reconcile");
    const late = join(fixture.base, "late-author");
    git(fixture.root, ["worktree", "add", "-b", "late-work", late]);
    writeFixture(late, "late.txt", "unique work\n");
    git(late, ["add", "late.txt"]);
    git(late, ["commit", "-m", "Late unique work"]);
    const rebaselined = rebaselineLoopWorktrees(
      fixture.root,
      lease.runId,
      "controller",
      "user",
      "Register the late author"
    );
    const registered = rebaselined.lease.worktrees.find(
      (worktree) => worktree.path === late
    );
    expect(registered?.role).toBe("preserved");
    expect(() =>
      retireAbsentWorktree(
        fixture.root,
        lease.runId,
        "controller",
        late,
        "user",
        "Still present"
      )
    ).toThrow("still exists on disk");

    const lateHead = git(fixture.root, ["rev-parse", "--verify", "late-work"]);
    git(fixture.root, ["worktree", "remove", "--force", late]);
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "missing-preserved-worktree",
        path: late,
      })
    );
    expect(loopStatus(fixture.root).guidance.nextCommands).toContainEqual(
      expect.stringContaining("loop retire-absent-worktree")
    );

    const retired = retireAbsentWorktree(
      fixture.root,
      lease.runId,
      "controller",
      late,
      "user",
      "The owning task removed its checkout."
    );
    expect(retired.retirements).toEqual([
      expect.objectContaining({
        actorAgentId: "controller",
        approvedBy: "user",
        baselineChangeDigest: registered?.baselineChangeDigest,
        baselineHeadSha: registered?.baselineHeadSha,
        branch: "late-work",
        path: late,
        registration: "rebaseline",
        targetRef: lease.targetRef,
      }),
    ]);
    expect(retired.dispositions ?? []).toEqual([]);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(
      retireAbsentWorktree(
        fixture.root,
        lease.runId,
        "controller",
        late,
        "user",
        "Repeat"
      ).retirements
    ).toHaveLength(1);
    expect(git(fixture.root, ["rev-parse", "--verify", "late-work"])).toBe(
      lateHead
    );
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
    expect(git(fixture.root, ["branch", "--list", "late-work"])).toContain(
      "late-work"
    );
  }, 30_000);

  test("retires an opening worktree deleted outside Git while stale metadata remains", () => {
    const fixture = repository();
    const preserved = join(fixture.base, "preserved");
    git(fixture.root, ["worktree", "add", "-b", "preserved-work", preserved]);
    const lease = startLoop(fixture.root, "controller", "reconcile");
    rmSync(preserved, { force: true, recursive: true });
    expect(
      captureInventory(fixture.root).worktrees.find(
        (worktree) => worktree.path === preserved
      )?.prunable
    ).toBe(true);
    expect(verifyLoop(fixture.root).ok).toBe(false);

    const retired = retireAbsentWorktree(
      fixture.root,
      lease.runId,
      "controller",
      preserved,
      "user",
      "Removed by its owner without git worktree remove."
    );
    expect(retired.retirements?.[0]?.registration).toBe("opening");
    expect(verifyLoop(fixture.root).ok).toBe(true);
    git(fixture.root, ["worktree", "prune"]);
    expect(verifyLoop(fixture.root).ok).toBe(true);
  });

  test("a retirement stops applying once something reappears at the path", () => {
    const fixture = repository();
    const preserved = join(fixture.base, "preserved");
    git(fixture.root, ["worktree", "add", "-b", "preserved-work", preserved]);
    const lease = startLoop(fixture.root, "controller", "reconcile");
    git(fixture.root, ["worktree", "remove", "--force", preserved]);
    retireAbsentWorktree(
      fixture.root,
      lease.runId,
      "controller",
      preserved,
      "user",
      "Removed by its owner."
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);

    // A dangling symlink is not absence.
    symlinkSync(join(fixture.base, "nowhere"), preserved);
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({ code: "missing-preserved-worktree" })
    );
    rmSync(preserved);

    // A recreated checkout with different content is checked again.
    git(fixture.root, ["worktree", "add", "--detach", preserved]);
    writeFixture(preserved, "changed.txt", "new bytes\n");
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "preserved-worktree-changed",
        path: preserved,
      })
    );
    git(fixture.root, ["worktree", "remove", "--force", preserved]);
    expect(verifyLoop(fixture.root).ok).toBe(true);
  }, 30_000);

  test("refuses retirement for live, unregistered, run-created, or primary paths", () => {
    const fixture = repository();
    const controller = join(fixture.base, "controller");
    git(fixture.root, ["worktree", "add", "-b", "controller-work", controller]);
    const lease = startLoop(controller, "controller", "reconcile");
    expect(() =>
      retireAbsentWorktree(
        controller,
        lease.runId,
        "controller",
        fixture.root,
        "user",
        "Primary"
      )
    ).toThrow("primary checkout cannot be retired");
    expect(() =>
      retireAbsentWorktree(
        controller,
        lease.runId,
        "controller",
        join(fixture.base, "never-registered"),
        "user",
        "Unknown"
      )
    ).toThrow("must name a preserved registration");
    const prepared = prepareAgentWorktree(
      controller,
      lease.runId,
      "author",
      "run-created"
    );
    git(fixture.root, ["worktree", "remove", "--force", prepared.path]);
    expect(() =>
      retireAbsentWorktree(
        controller,
        lease.runId,
        "controller",
        prepared.path,
        "user",
        "Run-created"
      )
    ).toThrow("must name a preserved registration");
    expect(() =>
      retireAbsentWorktree(
        controller,
        lease.runId,
        "other-agent",
        prepared.path,
        "user",
        "Wrong owner"
      )
    ).toThrow("Only loop owner");
  }, 30_000);

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

  test("refreshes scope while another agent's preserved worktree keeps changing", () => {
    const fixture = repository();
    const codexWorktree = join(fixture.base, "codex");
    git(fixture.root, ["worktree", "add", "--detach", codexWorktree]);
    writeFixture(fixture.root, "contact.ts", "export const email = 'v1';\n");
    writeFixture(codexWorktree, "draft.ts", "export const draft = 1;\n");
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");
    const preserveCodex = (plan: ChangePlan): ChangePlan => ({
      ...plan,
      preserved: [
        ...plan.preserved,
        {
          classification: "actively-changing",
          paths: plan.units
            .filter((unit) => unit.sourceWorktree === codexWorktree)
            .flatMap((unit) => unit.paths),
          reason: "Another agent's in-progress worktree; never shipped here.",
          worktreePath: codexWorktree,
        },
      ],
      units: plan.units.filter((unit) => unit.sourceWorktree !== codexWorktree),
    });
    const previewNow = () => {
      const current = captureInventory(fixture.root);
      return buildPreviewPlan(
        current,
        current,
        compareSnapshots(current, current),
        "Ship reviewed local changes"
      );
    };
    const scoped = preserveCodex(
      buildPreviewPlan(
        opening,
        captureInventory(fixture.root),
        compareSnapshots(opening, captureInventory(fixture.root)),
        "Ship my contact change"
      )
    );
    recordShipmentScope(fixture.root, lease.runId, "controller", scoped);

    // Review changes the shipped file while the other agent adds a file.
    writeFixture(fixture.root, "contact.ts", "export const email = 'v2';\n");
    writeFixture(codexWorktree, "later.ts", "export const later = 2;\n");
    expect(() =>
      recordShipmentScope(
        fixture.root,
        lease.runId,
        "controller",
        previewNow(),
        true
      )
    ).toThrow("cannot add a new path: later.ts");

    const refreshed = recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      preserveCodex(previewNow()),
      true
    );
    expect(refreshed.summary).toContain("2 path(s) preserved");
    const activePlan = readLoopLease(fixture.root)?.shipmentScope?.plan;
    expect(activePlan?.units).toEqual(scoped.units);
    expect(activePlan?.preserved).toEqual([
      expect.objectContaining({
        paths: ["draft.ts", "later.ts"],
        worktreePath: codexWorktree,
      }),
    ]);

    // Excluding, rather than preserving, another agent's new path is still
    // expanded scope.
    writeFixture(codexWorktree, "excluded.ts", "export const excluded = 3;\n");
    const excludedPlan = preserveCodex(previewNow());
    expect(() =>
      recordShipmentScope(
        fixture.root,
        lease.runId,
        "controller",
        {
          ...excludedPlan,
          exclusions: [
            ...excludedPlan.exclusions,
            {
              path: "excluded.ts",
              reason: "Not ours.",
              worktreePath: codexWorktree,
            },
          ],
          preserved: excludedPlan.preserved.map((item) => ({
            ...item,
            paths: item.paths.filter((path) => path !== "excluded.ts"),
          })),
        },
        true
      )
    ).toThrow("cannot add a new path: excluded.ts");
    rmSync(join(codexWorktree, "excluded.ts"));

    // Preserving a new path inside the shipped source worktree is still
    // expanded scope.
    writeFixture(fixture.root, "extra.ts", "export const extra = true;\n");
    const sourcePreserved = preserveCodex(previewNow());
    const extraUnit = sourcePreserved.units.find((unit) =>
      unit.paths.includes("extra.ts")
    );
    expect(extraUnit).toBeDefined();
    expect(() =>
      recordShipmentScope(
        fixture.root,
        lease.runId,
        "controller",
        {
          ...sourcePreserved,
          preserved: [
            ...sourcePreserved.preserved,
            {
              classification: "actively-changing",
              paths: ["extra.ts"],
              reason: "Not part of this shipment.",
              worktreePath: fixture.root,
            },
          ],
          units: sourcePreserved.units.map((unit) => ({
            ...unit,
            paths: unit.paths.filter((path) => path !== "extra.ts"),
          })),
        },
        true
      )
    ).toThrow("cannot add a new path: extra.ts");
  });

  test("a refresh from the raw preview keeps the primary's preserved work preserved", () => {
    const fixture = repository();
    const featureWorktree = join(fixture.base, "feature");
    git(fixture.root, ["worktree", "add", "--detach", featureWorktree]);
    writeFixture(featureWorktree, "feature.ts", "export const feature = 1;\n");
    writeFixture(fixture.root, "wip.ts", "export const wip = true;\n");
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");
    const raw = buildPreviewPlan(
      opening,
      captureInventory(fixture.root),
      compareSnapshots(opening, captureInventory(fixture.root)),
      "Ship the feature"
    );
    recordShipmentScope(fixture.root, lease.runId, "controller", {
      ...raw,
      preserved: [
        {
          classification: "actively-changing",
          paths: ["wip.ts"],
          reason: "The user's uncommitted work in the primary checkout.",
          worktreePath: fixture.root,
        },
      ],
      units: raw.units.filter((unit) => unit.sourceWorktree !== fixture.root),
    });

    writeFixture(featureWorktree, "feature.ts", "export const feature = 2;\n");
    const reviewed = captureInventory(fixture.root);
    const refreshed = recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      buildPreviewPlan(
        reviewed,
        reviewed,
        compareSnapshots(reviewed, reviewed),
        "Ship the reviewed feature"
      ),
      true
    );
    expect(refreshed.summary).toContain("1 path(s) preserved");
    expect(readLoopLease(fixture.root)?.shipmentScope?.plan.preserved).toEqual([
      expect.objectContaining({
        paths: ["wip.ts"],
        worktreePath: fixture.root,
      }),
    ]);
  });

  test("a pathless exclusion keeps excluding only the path it covered", () => {
    const fixture = repository();
    const codexWorktree = join(fixture.base, "codex");
    git(fixture.root, ["worktree", "add", "--detach", codexWorktree]);
    writeFixture(fixture.root, "contact.ts", "export const email = 'v1';\n");
    writeFixture(fixture.root, "notes.md", "local notes\n");
    const opening = captureInventory(fixture.root);
    const lease = startLoop(fixture.root, "controller", "ship");
    const raw = buildPreviewPlan(
      opening,
      captureInventory(fixture.root),
      compareSnapshots(opening, captureInventory(fixture.root)),
      "Ship the contact change"
    );
    recordShipmentScope(fixture.root, lease.runId, "controller", {
      ...raw,
      exclusions: [{ path: "notes.md", reason: "Local notes stay unshipped." }],
      units: raw.units.map((unit) => ({
        ...unit,
        paths: unit.paths.filter((path) => path !== "notes.md"),
      })),
    });

    // Another agent's worktree later gains a file with the same name.
    writeFixture(fixture.root, "contact.ts", "export const email = 'v2';\n");
    writeFixture(codexWorktree, "notes.md", "another agent's notes\n");
    const reviewed = captureInventory(fixture.root);
    const refreshedRaw = buildPreviewPlan(
      reviewed,
      reviewed,
      compareSnapshots(reviewed, reviewed),
      "Ship the reviewed contact change"
    );
    const refreshed = recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      {
        ...refreshedRaw,
        exclusions: [
          {
            path: "notes.md",
            reason: "Local notes stay unshipped.",
            worktreePath: fixture.root,
          },
        ],
        preserved: [
          {
            classification: "actively-changing",
            paths: ["notes.md"],
            reason: "Another agent's in-progress worktree.",
            worktreePath: codexWorktree,
          },
        ],
        units: refreshedRaw.units
          .filter((unit) => unit.sourceWorktree === fixture.root)
          .map((unit) => ({
            ...unit,
            paths: unit.paths.filter((path) => path !== "notes.md"),
          })),
      },
      true
    );
    expect(refreshed.summary).toContain("1 path(s) preserved");
    expect(readLoopLease(fixture.root)?.shipmentScope?.plan.preserved).toEqual([
      expect.objectContaining({
        paths: ["notes.md"],
        worktreePath: codexWorktree,
      }),
    ]);
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

  test("captures a clean shipment scope before committed-source authoring and requires exact final deltas", async () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    const scope = lease.shipmentScope;
    if (!scope) {
      throw new Error("Clean ship start must capture its opening scope.");
    }
    expect(lease.shipmentScopeRequired).toBe(true);
    expect(scope.openingInventoryDigest).toBe(lease.baselineDigest);
    expect(scope.openingChanges).toEqual([]);
    expect(scope.plan.units).toEqual([]);
    expect(scope.plan.mode).toBe("preview");
    expect(scope.plan.mutationsAllowed).toBe(false);
    expect(scope.planDigest).toMatch(SHA256_PATTERN);
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "author",
      "committed source"
    );
    git(prepared.path, ["mv", "README.md", "GUIDE.md"]);
    writeFixture(prepared.path, "feature.ts", "export const ready = true;\n");
    git(prepared.path, ["add", "feature.ts", "GUIDE.md"]);
    git(prepared.path, ["commit", "-m", "Prepare committed source"]);
    const merged = await executeLoopMutation(
      fixture.root,
      lease.runId,
      "controller",
      ["git", "merge", "--ff-only", prepared.branch]
    );
    expect(merged.result.exitCode).toBe(0);
    const targetRevision = git(fixture.root, ["rev-parse", "main"]);
    const outcome = shipmentOutcome(
      fixture.root,
      lease,
      scope.plan,
      targetRevision
    );
    expect(() =>
      recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome)
    ).toThrow("omits final target delta");
    outcome.additionalPaths = ["README.md", "GUIDE.md", "feature.ts"].map(
      (path) => ({
        classification: "external-target-change",
        entry: treeEntry(fixture.root, targetRevision, path),
        path,
        reason:
          "The independently reviewed committed-source delta landed in the target.",
      })
    );
    const wrongEntry = structuredClone(outcome);
    const [first] = wrongEntry.additionalPaths;
    if (first) {
      first.entry = `100644:blob:${"f".repeat(40)}`;
    }
    expect(() =>
      recordShipmentOutcome(fixture.root, lease.runId, "controller", wrongEntry)
    ).toThrow();
    recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome);
    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Committed source delivered with every final tree delta."
    );
    expect(finalized.outcome).toBe("completed");
    expect(readLoopLease(fixture.root)).toBeNull();
  });

  test("an automatically captured empty scope does not prove an empty shipment", () => {
    const fixture = repository();
    git(fixture.root, ["switch", "-c", "unshipped-committed-source"]);
    writeFixture(
      fixture.root,
      "feature.ts",
      "export const unshipped = true;\n"
    );
    git(fixture.root, ["add", "feature.ts"]);
    git(fixture.root, ["commit", "-m", "Unshipped committed source"]);
    const lease = startLoop(fixture.root, "controller", "ship");
    const plan = lease.shipmentScope?.plan;
    if (!plan) {
      throw new Error("Expected clean opening scope.");
    }
    const targetRevision = git(fixture.root, ["rev-parse", "main"]);
    recordShipmentOutcome(
      fixture.root,
      lease.runId,
      "controller",
      shipmentOutcome(fixture.root, lease, plan, targetRevision)
    );
    const finalization = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "An empty opening scope does not prove committed source delivery."
    );
    expect(finalization.receipt.deliveryStatus).toBe("unverified");
    expect(git(fixture.root, ["rev-parse", "main"])).toBe(targetRevision);
    expect(
      git(fixture.root, ["rev-parse", "unshipped-committed-source"])
    ).not.toBe(targetRevision);
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

  test("verifies merged-head ancestry with git and keeps the proof out of the lease", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const baseRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFixture(fixture.root, "shipped.txt", "opening head\n");
    git(fixture.root, ["add", "shipped.txt"]);
    git(fixture.root, ["commit", "-m", "Opening MR head"]);
    const initialHead = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFixture(fixture.root, "shipped.txt", "fast-forwarded head\n");
    git(fixture.root, ["add", "shipped.txt"]);
    git(fixture.root, ["commit", "-m", "Release preparation"]);
    const mergedHead = git(fixture.root, ["rev-parse", "HEAD"]);
    const targetRevision = mergedHead;
    const tree = git(fixture.root, ["rev-parse", "HEAD^{tree}"]);
    const rewrittenHead = git(fixture.root, [
      "commit-tree",
      tree,
      "-p",
      baseRevision,
      "-m",
      "Force-pushed replacement",
    ]);
    const outsideTarget = git(fixture.root, [
      "commit-tree",
      tree,
      "-p",
      mergedHead,
      "-m",
      "Never merged",
    ]);
    const mainEntry = {
      classification: "canonical-target" as const,
      disposition: "preserved-target" as const,
      evidence: ["Complete GitLab inventory includes protected main."],
      finalHeadRevision: targetRevision,
      initialHeadRevision: targetRevision,
      name: "main",
      obsoleteProof: null,
      proposals: [],
      protected: true,
    };
    const openingBranches = [
      mainEntry,
      {
        classification: "open-proposal" as const,
        disposition: "preserved-open-proposal" as const,
        evidence: ["MR !70 is open at the opening source head."],
        finalHeadRevision: initialHead,
        initialHeadRevision: initialHead,
        name: "fix/shipped",
        obsoleteProof: null,
        proposals: [
          { headRevision: initialHead, objectId: "70", state: "open" as const },
        ],
        protected: false,
      },
    ];
    const openingLedger = remoteLedger(openingBranches, "initial");
    const lease = startLoop(fixture.root, "controller", "integrate", {
      branches: openingBranches,
      finalBranchCount: openingLedger.count,
      finalCoverage: openingLedger.coverage,
      finalInventoryComplete: true,
      initialBranchCount: openingLedger.count,
      initialCoverage: openingLedger.coverage,
      initialInventoryComplete: true,
      observedAt: new Date().toISOString(),
      project: "group/project",
      provider: "gitlab",
      schemaVersion: 1,
      targetBranch: "main",
      targetRevision,
    });
    const finalReceipt = (claimedMergedHead: string) => {
      const branches = [
        mainEntry,
        {
          classification: "merged-obsolete" as const,
          disposition: "deleted-merged" as const,
          evidence: [
            "MR !70 merged at the fast-forwarded head and GitLab deleted the source branch.",
          ],
          finalHeadRevision: null,
          initialHeadRevision: initialHead,
          mergedHeadAncestry: {
            initialHeadRevision: initialHead,
            mergedHeadRevision: claimedMergedHead,
            proposalObjectId: "70",
          },
          name: "fix/shipped",
          obsoleteProof: "merged-proposal-head" as const,
          proposals: [
            {
              headRevision: initialHead,
              objectId: "70",
              observedFinally: false,
              state: "open" as const,
            },
            {
              headRevision: claimedMergedHead,
              objectId: "70",
              observedInitially: false,
              state: "merged" as const,
            },
          ],
          protected: false,
        },
      ];
      const initial = remoteLedger(branches, "initial");
      const final = remoteLedger(branches, "final");
      return {
        branches,
        finalBranchCount: final.count,
        finalCoverage: final.coverage,
        finalInventoryComplete: true as const,
        initialBranchCount: initial.count,
        initialCoverage: initial.coverage,
        initialInventoryComplete: true as const,
        observedAt: new Date().toISOString(),
        project: "group/project",
        provider: "gitlab",
        schemaVersion: 1 as const,
        targetBranch: "main",
        targetRevision,
      };
    };

    const embedded = (claimedMergedHead: string) =>
      splitRemoteBranchReconciliationInput(finalReceipt(claimedMergedHead));
    const leasePath = loopLeasePath(join(fixture.root, ".git"));
    const ancestryPath = join(
      fixture.root,
      ".git",
      "simple-changes",
      "remote-branch-ancestry",
      `${lease.runId}.json`
    );

    for (const [claimedMergedHead, message] of [
      [rewrittenHead, "is not the merged head"],
      [outsideTarget, "is not contained in target"],
      ["f".repeat(40), "is not the merged head"],
    ] as const) {
      const forged = embedded(claimedMergedHead);
      expect(
        validateRemoteBranchReconciliation(
          forged.receipt,
          forged.ancestryProofs
        )
      ).toEqual(forged.receipt as RemoteBranchReconciliationReceipt);
      expect(() =>
        recordRemoteBranchReconciliation(
          fixture.root,
          lease.runId,
          "controller",
          finalReceipt(claimedMergedHead)
        )
      ).toThrow(message);
    }
    expect(readLoopLease(fixture.root)?.remoteBranchReconciliation).toBe(
      undefined
    );
    expect(existsSync(ancestryPath)).toBe(false);

    const genuineInput = finalReceipt(mergedHead);
    const updated = recordRemoteBranchReconciliation(
      fixture.root,
      lease.runId,
      "controller",
      genuineInput
    );
    const genuine = splitRemoteBranchReconciliationInput(genuineInput);
    expect(updated.remoteBranchReconciliation).toEqual(
      genuine.receipt as RemoteBranchReconciliationReceipt
    );
    expect(JSON.parse(readFileSync(ancestryPath, "utf8"))).toEqual({
      proofs: [
        {
          branch: "fix/shipped",
          initialHeadRevision: initialHead,
          mergedHeadRevision: mergedHead,
          proposalObjectId: "70",
        },
      ],
      receiptDigest: remoteBranchReconciliationDigest(
        updated.remoteBranchReconciliation
      ),
      runId: lease.runId,
      schemaVersion: 1,
    });

    // Older clients strictly validate the lease with the 0.22.0 schemas; the
    // lease must not change shape when an ancestry proof is recorded.
    const storedLease = readFileSync(leasePath, "utf8");
    expect(storedLease).not.toContain("mergedHeadAncestry");
    const repositoryRoot = git(dirname(fileURLToPath(import.meta.url)), [
      "rev-parse",
      "--show-toplevel",
    ]);
    const pending = ["loop-lease.schema.json"];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const filename = pending.pop() ?? "";
      if (seen.has(filename)) {
        continue;
      }
      seen.add(filename);
      const released = git(repositoryRoot, [
        "show",
        `5ce7345:skills/simple-changes/evals/schemas/${filename}`,
      ]);
      const current = readFileSync(
        join(repositoryRoot, "skills/simple-changes/evals/schemas", filename),
        "utf8"
      );
      expect({ filename, schema: JSON.parse(current) }).toEqual({
        filename,
        schema: JSON.parse(released),
      });
      for (const match of released.matchAll(
        /"\$ref": "([a-z-]+\.schema\.json)/gu
      )) {
        pending.push(match[1] ?? "");
      }
    }
    expect(seen.has("remote-branch-reconciliation.schema.json")).toBe(true);
    expect(() =>
      validateSchema("loop-lease", JSON.parse(storedLease))
    ).not.toThrow();

    const sidecar = readFileSync(ancestryPath, "utf8");
    rmSync(ancestryPath);
    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "No merged-head ancestry proof sidecar exists"
    );
    writeFileSync(
      ancestryPath,
      sidecar.replace(
        remoteBranchReconciliationDigest(updated.remoteBranchReconciliation),
        "0".repeat(64)
      )
    );
    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "do not match this run's recorded reconciliation receipt"
    );

    // A lease and sidecar edited together to claim a rewritten head still
    // fail at loop end because git re-verifies the ancestry there.
    const forgedEnd = embedded(rewrittenHead);
    const forgedReceipt =
      forgedEnd.receipt as RemoteBranchReconciliationReceipt;
    writeFileSync(
      leasePath,
      `${JSON.stringify(
        {
          ...JSON.parse(storedLease),
          remoteBranchReconciliation: forgedReceipt,
        },
        null,
        2
      )}\n`
    );
    writeFileSync(
      ancestryPath,
      `${JSON.stringify(
        {
          proofs: forgedEnd.ancestryProofs,
          receiptDigest: remoteBranchReconciliationDigest(forgedReceipt),
          runId: lease.runId,
          schemaVersion: 1,
        },
        null,
        2
      )}\n`
    );
    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "is not the merged head"
    );

    writeFileSync(leasePath, storedLease);
    writeFileSync(ancestryPath, sidecar);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

  test("records the same proposal merged at the unchanged opening head", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    writeFixture(fixture.root, "shipped.txt", "opening head\n");
    git(fixture.root, ["add", "shipped.txt"]);
    git(fixture.root, ["commit", "-m", "Opening MR head"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    const main = {
      classification: "canonical-target" as const,
      disposition: "preserved-target" as const,
      evidence: ["Complete GitLab inventory includes protected main."],
      finalHeadRevision: head,
      initialHeadRevision: head,
      name: "main",
      obsoleteProof: null,
      proposals: [],
      protected: true,
    };
    const openingBranches = [
      main,
      {
        classification: "open-proposal" as const,
        disposition: "preserved-open-proposal" as const,
        evidence: ["MR !71 is open at the opening source head."],
        finalHeadRevision: head,
        initialHeadRevision: head,
        name: "fix/same-head",
        obsoleteProof: null,
        proposals: [
          { headRevision: head, objectId: "71", state: "open" as const },
        ],
        protected: false,
      },
    ];
    const branchEntries = [
      { headRevision: head, name: "main" },
      { headRevision: head, name: "fix/same-head" },
    ];
    const openProposal = [
      {
        branch: "fix/same-head",
        headRevision: head,
        objectId: "71",
        state: "open",
      },
    ];
    const mergedProposal = [
      {
        branch: "fix/same-head",
        headRevision: head,
        objectId: "71",
        state: "merged",
      },
    ];
    const openingCoverage = paginationCoverage(
      2,
      sha256Of(branchEntries),
      1,
      sha256Of(openProposal)
    );
    const lease = startLoop(fixture.root, "controller", "integrate", {
      branches: openingBranches,
      finalBranchCount: 2,
      finalCoverage: openingCoverage,
      finalInventoryComplete: true,
      initialBranchCount: 2,
      initialCoverage: openingCoverage,
      initialInventoryComplete: true,
      observedAt: new Date().toISOString(),
      project: "group/project",
      provider: "gitlab",
      schemaVersion: 1,
      targetBranch: "main",
      targetRevision: head,
    });
    const updated = recordRemoteBranchReconciliation(
      fixture.root,
      lease.runId,
      "controller",
      {
        branches: [
          main,
          {
            classification: "merged-obsolete",
            disposition: "deleted-merged",
            evidence: [
              "MR !71 merged at its opening head and GitLab deleted the source branch.",
            ],
            finalHeadRevision: null,
            initialHeadRevision: head,
            mergedHeadAncestry: {
              initialHeadRevision: head,
              mergedHeadRevision: head,
              proposalObjectId: "71",
            },
            name: "fix/same-head",
            obsoleteProof: "merged-proposal-head",
            proposals: [
              {
                headRevision: head,
                objectId: "71",
                observedFinally: false,
                state: "open",
              },
              {
                headRevision: head,
                objectId: "71",
                observedInitially: false,
                state: "merged",
              },
            ],
            protected: false,
          },
        ],
        finalBranchCount: 1,
        finalCoverage: paginationCoverage(
          1,
          sha256Of([{ headRevision: head, name: "main" }]),
          1,
          sha256Of(mergedProposal)
        ),
        finalInventoryComplete: true,
        initialBranchCount: 2,
        initialCoverage: openingCoverage,
        initialInventoryComplete: true,
        observedAt: new Date().toISOString(),
        project: "group/project",
        provider: "gitlab",
        schemaVersion: 1,
        targetBranch: "main",
        targetRevision: head,
      }
    );
    expect(updated.remoteBranchReconciliation.branches).toHaveLength(2);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

  test("records a same-head merge without a sidecar only when the target contains the head", () => {
    for (const squashed of [false, true]) {
      const fixture = repository();
      git(fixture.root, [
        "remote",
        "add",
        "origin",
        "git@gitlab.com:group/project.git",
      ]);
      const base = git(fixture.root, ["rev-parse", "HEAD"]);
      writeFixture(fixture.root, "shipped.txt", "opening head\n");
      git(fixture.root, ["add", "shipped.txt"]);
      git(fixture.root, ["commit", "-m", "Opening MR head"]);
      const head = git(fixture.root, ["rev-parse", "HEAD"]);
      if (squashed) {
        // A squash merge lands the same tree as a new commit that does not
        // contain the source head.
        const squash = git(fixture.root, [
          "commit-tree",
          git(fixture.root, ["rev-parse", "HEAD^{tree}"]),
          "-p",
          base,
          "-m",
          "Squashed MR !72",
        ]);
        git(fixture.root, ["reset", "-q", "--hard", squash]);
      }
      const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
      const main = {
        classification: "canonical-target" as const,
        disposition: "preserved-target" as const,
        evidence: ["Complete GitLab inventory includes protected main."],
        finalHeadRevision: targetRevision,
        initialHeadRevision: targetRevision,
        name: "main",
        obsoleteProof: null,
        proposals: [],
        protected: true,
      };
      const openingBranches = [
        main,
        {
          classification: "open-proposal" as const,
          disposition: "preserved-open-proposal" as const,
          evidence: ["MR !72 is open at the opening source head."],
          finalHeadRevision: head,
          initialHeadRevision: head,
          name: "fix/same-head",
          obsoleteProof: null,
          proposals: [
            { headRevision: head, objectId: "72", state: "open" as const },
          ],
          protected: false,
        },
      ];
      const opening = remoteLedger(openingBranches, "initial");
      const lease = startLoop(fixture.root, "controller", "integrate", {
        branches: openingBranches,
        finalBranchCount: opening.count,
        finalCoverage: opening.coverage,
        finalInventoryComplete: true,
        initialBranchCount: opening.count,
        initialCoverage: opening.coverage,
        initialInventoryComplete: true,
        observedAt: new Date().toISOString(),
        project: "group/project",
        provider: "gitlab",
        schemaVersion: 1,
        targetBranch: "main",
        targetRevision,
      });
      const branches = [
        main,
        {
          classification: "merged-obsolete" as const,
          disposition: "deleted-merged" as const,
          evidence: [
            "MR !72 merged at its opening head and GitLab deleted the source branch.",
          ],
          finalHeadRevision: null,
          initialHeadRevision: head,
          name: "fix/same-head",
          obsoleteProof: "merged-proposal-head" as const,
          proposals: [
            {
              headRevision: head,
              objectId: "72",
              observedFinally: false,
              state: "open" as const,
            },
            {
              headRevision: head,
              objectId: "72",
              observedInitially: false,
              state: "merged" as const,
            },
          ],
          protected: false,
        },
      ];
      const initial = remoteLedger(branches, "initial");
      const final = remoteLedger(branches, "final");
      const record = () =>
        recordRemoteBranchReconciliation(
          fixture.root,
          lease.runId,
          "controller",
          {
            branches,
            finalBranchCount: final.count,
            finalCoverage: final.coverage,
            finalInventoryComplete: true,
            initialBranchCount: initial.count,
            initialCoverage: initial.coverage,
            initialInventoryComplete: true,
            observedAt: new Date().toISOString(),
            project: "group/project",
            provider: "gitlab",
            schemaVersion: 1,
            targetBranch: "main",
            targetRevision,
          }
        );
      if (squashed) {
        expect(record).toThrow("is not contained in target");
        expect(readLoopLease(fixture.root)?.remoteBranchReconciliation).toBe(
          undefined
        );
      } else {
        expect(record().remoteBranchReconciliation.branches).toHaveLength(2);
        expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
      }
    }
  });

  test("verifies an approved supersession with git and keeps it out of the lease", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const forkPoint = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFixture(fixture.root, "community.txt", "closed MR version\n");
    git(fixture.root, ["add", "community.txt"]);
    git(fixture.root, ["commit", "-m", "Closed MR head"]);
    const deletedHead = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["reset", "--hard", forkPoint]);
    writeFixture(fixture.root, "community.txt", "shipped version\n");
    git(fixture.root, ["add", "community.txt"]);
    git(fixture.root, ["commit", "-m", "Ship the same work another way"]);
    const replacement = git(fixture.root, ["rev-parse", "HEAD"]);
    const targetRevision = replacement;
    const outsideTarget = git(fixture.root, [
      "commit-tree",
      git(fixture.root, ["rev-parse", "HEAD^{tree}"]),
      "-p",
      replacement,
      "-m",
      "Never merged",
    ]);
    const mainEntry = {
      classification: "canonical-target" as const,
      disposition: "preserved-target" as const,
      evidence: ["Complete GitLab inventory includes protected main."],
      finalHeadRevision: targetRevision,
      initialHeadRevision: targetRevision,
      name: "main",
      obsoleteProof: null,
      proposals: [],
      protected: true,
    };
    const closedProposal = {
      headRevision: deletedHead,
      objectId: "981",
      state: "closed" as const,
    };
    const openingBranches = [
      mainEntry,
      {
        classification: "closed-unmerged" as const,
        disposition: "preserved-audited" as const,
        evidence: ["MR !981 is closed at the opening source head."],
        finalHeadRevision: deletedHead,
        initialHeadRevision: deletedHead,
        name: "feature/superseded",
        obsoleteProof: null,
        proposals: [closedProposal],
        protected: false,
      },
    ];
    const openingLedger = remoteLedger(openingBranches, "initial");
    const lease = startLoop(fixture.root, "controller", "integrate", {
      branches: openingBranches,
      finalBranchCount: openingLedger.count,
      finalCoverage: openingLedger.coverage,
      finalInventoryComplete: true,
      initialBranchCount: openingLedger.count,
      initialCoverage: openingLedger.coverage,
      initialInventoryComplete: true,
      observedAt: new Date().toISOString(),
      project: "group/project",
      provider: "gitlab",
      schemaVersion: 1,
      targetBranch: "main",
      targetRevision,
    });
    const finalReceipt = (replacementRevisions: string[]) => {
      const branches = [
        mainEntry,
        {
          classification: "closed-unmerged" as const,
          disposition: "deleted-proven-obsolete" as const,
          evidence: [
            "The branch was deleted outside the run; the user judged MR !981 superseded.",
          ],
          finalHeadRevision: null,
          initialHeadRevision: deletedHead,
          name: "feature/superseded",
          obsoleteProof: null,
          proposals: [closedProposal],
          protected: false,
          supersession: {
            approvedBy: "jaay",
            initialHeadRevision: deletedHead,
            reason: "The same work shipped through another commit.",
            replacementRevisions,
          },
        },
      ];
      const initial = remoteLedger(branches, "initial");
      const final = remoteLedger(branches, "final");
      return {
        branches,
        finalBranchCount: final.count,
        finalCoverage: final.coverage,
        finalInventoryComplete: true as const,
        initialBranchCount: initial.count,
        initialCoverage: initial.coverage,
        initialInventoryComplete: true as const,
        observedAt: new Date().toISOString(),
        project: "group/project",
        provider: "gitlab",
        schemaVersion: 1 as const,
        targetBranch: "main",
        targetRevision,
      };
    };
    const record = (replacementRevisions: string[]) =>
      recordRemoteBranchReconciliation(
        fixture.root,
        lease.runId,
        "controller",
        finalReceipt(replacementRevisions)
      );
    const endMessage = () => {
      try {
        endLoop(fixture.root, lease.runId, "controller");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    };
    const leasePath = loopLeasePath(join(fixture.root, ".git"));
    const sidecarPath = (directory: string) =>
      join(
        fixture.root,
        ".git",
        "simple-changes",
        directory,
        `${lease.runId}.json`
      );
    const supersessionPath = sidecarPath("remote-branch-supersession");

    for (const [replacementRevisions, message] of [
      [[outsideTarget], "is not contained in target"],
      [[forkPoint], "is already an ancestor of deleted head"],
      [[replacement, "f".repeat(40)], "is not contained in target"],
    ] as const) {
      const forged = splitRemoteBranchReconciliationInput(
        finalReceipt([...replacementRevisions])
      );
      expect(
        validateRemoteBranchReconciliation(
          forged.receipt,
          forged.ancestryProofs,
          forged.supersessions
        )
      ).toEqual(forged.receipt as RemoteBranchReconciliationReceipt);
      expect(() => record([...replacementRevisions])).toThrow(message);
    }

    // A deleted head that was never fetched cannot be audited or restored.
    const objectPath = join(
      fixture.root,
      ".git",
      "objects",
      deletedHead.slice(0, 2),
      deletedHead.slice(2)
    );
    const objectBytes = readFileSync(objectPath);
    rmSync(objectPath);
    expect(() => record([replacement])).toThrow("is not present locally");
    writeFileSync(objectPath, objectBytes);
    expect(readLoopLease(fixture.root)?.remoteBranchReconciliation).toBe(
      undefined
    );
    expect(existsSync(supersessionPath)).toBe(false);

    // A shallow boundary hides the deleted head's parents, so the fork point
    // would falsely look unrelated to it.
    const shallowPath = join(fixture.root, ".git", "shallow");
    writeFileSync(shallowPath, `${deletedHead}\n`);
    expect(() => record([forkPoint])).toThrow("shallow clone");
    expect(() => record([replacement])).toThrow("shallow clone");
    rmSync(shallowPath);

    const updated = record([replacement]);
    expect(
      git(fixture.root, [
        "rev-parse",
        `refs/simple-changes/superseded/${lease.runId}/${deletedHead}`,
      ])
    ).toBe(deletedHead);
    expect(JSON.parse(readFileSync(supersessionPath, "utf8"))).toEqual({
      receiptDigest: remoteBranchReconciliationDigest(
        updated.remoteBranchReconciliation
      ),
      runId: lease.runId,
      schemaVersion: 1,
      supersessions: [
        {
          approvedBy: "jaay",
          branch: "feature/superseded",
          initialHeadRevision: deletedHead,
          reason: "The same work shipped through another commit.",
          replacementRevisions: [replacement],
        },
      ],
    });
    expect(existsSync(sidecarPath("remote-branch-ancestry"))).toBe(false);

    // Re-recording without the approval removes the stale sidecar; the pin
    // stays so the work remains restorable.
    recordRemoteBranchReconciliation(fixture.root, lease.runId, "controller", {
      ...finalReceipt([replacement]),
      branches: openingBranches,
      finalBranchCount: openingLedger.count,
      finalCoverage: openingLedger.coverage,
    });
    expect(existsSync(supersessionPath)).toBe(false);
    expect(
      git(fixture.root, [
        "rev-parse",
        `refs/simple-changes/superseded/${lease.runId}/${deletedHead}`,
      ])
    ).toBe(deletedHead);
    const rerecorded = record([replacement]);
    expect(rerecorded.remoteBranchReconciliation.branches).toEqual(
      (
        splitRemoteBranchReconciliationInput(finalReceipt([replacement]))
          .receipt as RemoteBranchReconciliationReceipt
      ).branches
    );
    expect(existsSync(supersessionPath)).toBe(true);

    // Older clients strictly validate the lease; the approval stays outside it.
    const storedLease = readFileSync(leasePath, "utf8");
    expect(storedLease).not.toContain("supersession");
    expect(storedLease).not.toContain("replacementRevisions");
    expect(() =>
      validateSchema("loop-lease", JSON.parse(storedLease))
    ).not.toThrow();

    const sidecar = readFileSync(supersessionPath, "utf8");
    rmSync(supersessionPath);
    expect(endMessage()).toContain(
      `No supersession approval sidecar exists for ${lease.runId}`
    );
    expect(endMessage()).not.toContain("merged-head ancestry");
    writeFileSync(
      supersessionPath,
      sidecar.replace(
        remoteBranchReconciliationDigest(rerecorded.remoteBranchReconciliation),
        "0".repeat(64)
      )
    );
    expect(endMessage()).toContain(
      "do not match this run's recorded reconciliation receipt"
    );

    // A lease and sidecar edited together to name a commit outside the
    // target still fail at loop end because git re-verifies there.
    const forgedEnd = splitRemoteBranchReconciliationInput(
      finalReceipt([outsideTarget])
    );
    const forgedReceipt =
      forgedEnd.receipt as RemoteBranchReconciliationReceipt;
    writeFileSync(
      leasePath,
      `${JSON.stringify(
        {
          ...JSON.parse(storedLease),
          remoteBranchReconciliation: forgedReceipt,
        },
        null,
        2
      )}\n`
    );
    writeFileSync(
      supersessionPath,
      `${JSON.stringify(
        {
          receiptDigest: remoteBranchReconciliationDigest(forgedReceipt),
          runId: lease.runId,
          schemaVersion: 1,
          supersessions: forgedEnd.supersessions,
        },
        null,
        2
      )}\n`
    );
    expect(endMessage()).toContain("is not contained in target");

    writeFileSync(leasePath, storedLease);
    writeFileSync(supersessionPath, sidecar);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

  test("refuses supersession when the target already contains the deleted head", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    writeFixture(fixture.root, "merged.txt", "already shipped\n");
    git(fixture.root, ["add", "merged.txt"]);
    git(fixture.root, ["commit", "-m", "Branch head"]);
    const deletedHead = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFixture(fixture.root, "merged.txt", "later target work\n");
    git(fixture.root, ["add", "merged.txt"]);
    git(fixture.root, ["commit", "-m", "Later target work"]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const mainEntry = {
      classification: "canonical-target" as const,
      disposition: "preserved-target" as const,
      evidence: ["Complete GitLab inventory includes protected main."],
      finalHeadRevision: targetRevision,
      initialHeadRevision: targetRevision,
      name: "main",
      obsoleteProof: null,
      proposals: [],
      protected: true,
    };
    const branch = {
      classification: "no-proposal" as const,
      evidence: ["No MR ever used this branch."],
      initialHeadRevision: deletedHead,
      name: "build/contained",
      obsoleteProof: null,
      proposals: [],
      protected: false,
    };
    const openingBranches = [
      mainEntry,
      {
        ...branch,
        disposition: "preserved-audited" as const,
        finalHeadRevision: deletedHead,
      },
    ];
    const opening = remoteLedger(openingBranches, "initial");
    const lease = startLoop(fixture.root, "controller", "integrate", {
      branches: openingBranches,
      finalBranchCount: opening.count,
      finalCoverage: opening.coverage,
      finalInventoryComplete: true,
      initialBranchCount: opening.count,
      initialCoverage: opening.coverage,
      initialInventoryComplete: true,
      observedAt: new Date().toISOString(),
      project: "group/project",
      provider: "gitlab",
      schemaVersion: 1,
      targetBranch: "main",
      targetRevision,
    });
    const finalBranches = [
      mainEntry,
      {
        ...branch,
        disposition: "deleted-proven-obsolete" as const,
        finalHeadRevision: null,
        supersession: {
          approvedBy: "jaay",
          initialHeadRevision: deletedHead,
          reason: "Judged superseded.",
          replacementRevisions: [targetRevision],
        },
      },
    ];
    const initial = remoteLedger(finalBranches, "initial");
    const final = remoteLedger(finalBranches, "final");
    expect(() =>
      recordRemoteBranchReconciliation(
        fixture.root,
        lease.runId,
        "controller",
        {
          branches: finalBranches,
          finalBranchCount: final.count,
          finalCoverage: final.coverage,
          finalInventoryComplete: true,
          initialBranchCount: initial.count,
          initialCoverage: initial.coverage,
          initialInventoryComplete: true,
          observedAt: new Date().toISOString(),
          project: "group/project",
          provider: "gitlab",
          schemaVersion: 1,
          targetBranch: "main",
          targetRevision,
        }
      )
    ).toThrow("record target-contains-head proof instead");
  });

  /**
   * Deleted no-MR branches the target contains by ancestry, by patch
   * equivalence, only partly, not at all, or past the patch-equivalence bound.
   */
  const deletedHeadFixture = () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const forkPoint = git(fixture.root, ["rev-parse", "HEAD"]);
    const sideCommits = (branch: string, files: string[]) => {
      git(fixture.root, ["switch", "-q", "-c", branch, forkPoint]);
      const heads = files.map((file) => {
        writeFixture(fixture.root, file, `${file}\n`);
        git(fixture.root, ["add", file]);
        git(fixture.root, ["commit", "-q", "-m", `Work on ${file}`]);
        return git(fixture.root, ["rev-parse", "HEAD"]);
      });
      git(fixture.root, ["switch", "-q", "main"]);
      git(fixture.root, ["branch", "-q", "-D", branch]);
      return heads;
    };
    const [cherryHead = ""] = sideCommits("cherry-src", ["cherry.txt"]);
    const [uniqueHead = ""] = sideCommits("unique-src", ["unique.txt"]);
    const [partialFirst = "", partialHead = ""] = sideCommits("partial-src", [
      "partial-a.txt",
      "partial-b.txt",
    ]);
    const stream = Array.from(
      { length: PATCH_EQUIVALENCE_MAX_COMMITS + 1 },
      (_, index) =>
        [
          "commit refs/heads/big-src",
          "committer Simple Changes Tests <tests@example.com> 1700000000 +0000",
          `data ${`Big ${index}`.length}`,
          `Big ${index}`,
          index === 0 ? `from ${forkPoint}` : "",
          "M 100644 inline big.txt",
          `data ${`${index}\n`.length}`,
          `${index}`,
          "",
        ]
          .filter((line, position) => position !== 4 || line)
          .join("\n")
    ).join("\n");
    const imported = spawnSync(
      ["git", "-C", fixture.root, "fast-import", "--quiet"],
      { stdin: new TextEncoder().encode(`${stream}\n`) }
    );
    expect(imported.exitCode).toBe(0);
    const bigHead = git(fixture.root, ["rev-parse", "refs/heads/big-src"]);
    git(fixture.root, ["update-ref", "-d", "refs/heads/big-src"]);
    writeFixture(fixture.root, "merged.txt", "merged\n");
    git(fixture.root, ["add", "merged.txt"]);
    git(fixture.root, ["commit", "-q", "-m", "Merged work"]);
    const ancestryHead = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["cherry-pick", cherryHead]);
    git(fixture.root, ["cherry-pick", partialFirst]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const providerHead = "e".repeat(40);
    const mainEntry = {
      classification: "canonical-target" as const,
      disposition: "preserved-target" as const,
      evidence: ["Complete GitLab inventory includes protected main."],
      finalHeadRevision: targetRevision,
      initialHeadRevision: targetRevision,
      name: "main",
      obsoleteProof: null,
      proposals: [],
      protected: true,
    };
    const audited = (name: string, head: string) => ({
      classification: "no-proposal" as const,
      disposition: "preserved-audited" as const,
      evidence: [`No MR ever used ${name}.`],
      finalHeadRevision: head,
      initialHeadRevision: head,
      name,
      obsoleteProof: null,
      proposals: [],
      protected: false,
    });
    const deleted = (
      name: string,
      head: string,
      obsoleteProof:
        | "target-contains-head"
        | "provider-diff-empty" = "target-contains-head"
    ) => ({
      ...audited(name, head),
      disposition: "deleted-proven-obsolete" as const,
      evidence: [`Deleted ${name} with ${obsoleteProof} evidence.`],
      finalHeadRevision: null,
      obsoleteProof,
    });
    const heads = {
      "build/ancestry": ancestryHead,
      "build/big": bigHead,
      "build/cherry": cherryHead,
      "build/partial": partialHead,
      "build/provider": providerHead,
      "build/unique": uniqueHead,
    };
    const openingBranches = [
      mainEntry,
      ...Object.entries(heads).map(([name, head]) => audited(name, head)),
    ];
    const opening = remoteLedger(openingBranches, "initial");
    const lease = startLoop(fixture.root, "controller", "integrate", {
      branches: openingBranches,
      finalBranchCount: opening.count,
      finalCoverage: opening.coverage,
      finalInventoryComplete: true,
      initialBranchCount: opening.count,
      initialCoverage: opening.coverage,
      initialInventoryComplete: true,
      observedAt: new Date().toISOString(),
      project: "group/project",
      provider: "gitlab",
      schemaVersion: 1,
      targetBranch: "main",
      targetRevision,
    });
    /** Every branch preserved except the overrides, in a fixed order. */
    const receiptFor = (overrides: Record<string, Record<string, unknown>>) => {
      const branches = [
        mainEntry,
        ...Object.entries(heads).map(
          ([name, head]) => overrides[name] ?? audited(name, head)
        ),
      ] as Parameters<typeof remoteLedger>[0];
      const initial = remoteLedger(branches, "initial");
      const final = remoteLedger(branches, "final");
      return {
        branches,
        finalBranchCount: final.count,
        finalCoverage: final.coverage,
        finalInventoryComplete: true as const,
        initialBranchCount: initial.count,
        initialCoverage: initial.coverage,
        initialInventoryComplete: true as const,
        observedAt: new Date().toISOString(),
        project: "group/project",
        provider: "gitlab",
        schemaVersion: 1 as const,
        targetBranch: "main",
        targetRevision,
      };
    };
    const record = (overrides: Record<string, Record<string, unknown>>) =>
      recordRemoteBranchReconciliation(
        fixture.root,
        lease.runId,
        "controller",
        receiptFor(overrides)
      );
    const objectPath = (revision: string) =>
      join(
        fixture.root,
        ".git",
        "objects",
        revision.slice(0, 2),
        revision.slice(2)
      );
    return {
      deleted,
      fixture,
      heads,
      lease,
      objectPath,
      receiptFor,
      record,
      targetRevision,
    };
  };

  test("verifies target-contains-head deletion proof with git when the receipt is recorded", () => {
    const {
      deleted,
      fixture,
      heads,
      lease,
      objectPath,
      record,
      targetRevision,
    } = deletedHeadFixture();
    const proven = {
      "build/ancestry": deleted("build/ancestry", heads["build/ancestry"]),
      "build/cherry": deleted("build/cherry", heads["build/cherry"]),
    };

    // Work the target lacks, wholly or partly, cannot be closed over by a claim.
    for (const name of ["build/unique", "build/partial"] as const) {
      expect(() =>
        record({ ...proven, [name]: deleted(name, heads[name]) })
      ).toThrow(
        `target ${targetRevision} neither contains deleted head ${heads[name]}`
      );
    }
    expect(() =>
      record({ "build/unique": deleted("build/unique", heads["build/unique"]) })
    ).toThrow("record their supersession approval instead");
    expect(() =>
      record({ "build/big": deleted("build/big", heads["build/big"]) })
    ).toThrow(`has more than ${PATCH_EQUIVALENCE_MAX_COMMITS} unique commits`);

    // An approval cannot stand in for proof Git already has.
    expect(() =>
      record({
        "build/cherry": {
          ...deleted("build/cherry", heads["build/cherry"]),
          obsoleteProof: null,
          supersession: {
            approvedBy: "jaay",
            initialHeadRevision: heads["build/cherry"],
            reason: "Cherry-picked into the target.",
            replacementRevisions: [targetRevision],
          },
        },
      })
    ).toThrow(
      "(patch-equivalent), so record target-contains-head proof instead"
    );

    // A head that was never fetched cannot be audited.
    const cherryObject = objectPath(heads["build/cherry"]);
    const cherryBytes = readFileSync(cherryObject);
    rmSync(cherryObject);
    expect(() => record(proven)).toThrow(
      `deleted head ${heads["build/cherry"]} is not present locally`
    );
    writeFileSync(cherryObject, cherryBytes);

    // Missing history is named as such, not reported as lost work.
    const shallowPath = join(fixture.root, ".git", "shallow");
    writeFileSync(shallowPath, `${targetRevision}\n`);
    expect(() => record(proven)).toThrow(
      "cannot be verified in a shallow clone"
    );
    rmSync(shallowPath);
    expect(readLoopLease(fixture.root)?.remoteBranchReconciliation).toBe(
      undefined
    );

    // Exact ancestry and full per-commit patch equivalence both prove it, and
    // provider-diff-empty stays provider evidence Git does not check.
    const updated = record({
      ...proven,
      "build/provider": deleted(
        "build/provider",
        heads["build/provider"],
        "provider-diff-empty"
      ),
    });
    expect(
      updated.remoteBranchReconciliation.branches
        .filter((branch) => branch.finalHeadRevision === null)
        .map((branch) => `${branch.name}:${branch.obsoleteProof}`)
    ).toEqual([
      "build/ancestry:target-contains-head",
      "build/cherry:target-contains-head",
      "build/provider:provider-diff-empty",
    ]);

    // The proof is checked once, where it is recorded: gc later removing the
    // unreachable patch-equivalent head must not strand the run.
    rmSync(cherryObject);
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

  test("ends a run whose 0.22.3 receipt superseded a patch-equivalent head", () => {
    const {
      deleted,
      fixture,
      heads,
      lease,
      receiptFor,
      record,
      targetRevision,
    } = deletedHeadFixture();
    record({});
    // 0.22.3 checked only exact ancestry before accepting this approval.
    const legacy = splitRemoteBranchReconciliationInput(
      receiptFor({
        "build/cherry": {
          ...deleted("build/cherry", heads["build/cherry"]),
          obsoleteProof: null,
          supersession: {
            approvedBy: "jaay",
            initialHeadRevision: heads["build/cherry"],
            reason: "Recorded by 0.22.3 before the audit existed.",
            replacementRevisions: [targetRevision],
          },
        },
      })
    );
    const legacyReceipt = legacy.receipt as RemoteBranchReconciliationReceipt;
    const leasePath = loopLeasePath(join(fixture.root, ".git"));
    writeFileSync(
      leasePath,
      `${JSON.stringify(
        {
          ...JSON.parse(readFileSync(leasePath, "utf8")),
          remoteBranchReconciliation: legacyReceipt,
        },
        null,
        2
      )}\n`
    );
    const sidecar = join(
      fixture.root,
      ".git",
      "simple-changes",
      "remote-branch-supersession",
      `${lease.runId}.json`
    );
    mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        receiptDigest: remoteBranchReconciliationDigest(legacyReceipt),
        runId: lease.runId,
        schemaVersion: 1,
        supersessions: legacy.supersessions,
      })}\n`
    );
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);
  });

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
    ).toThrow("Shipment scope is already recorded");

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
    stampFirstMutation(fixture.root);
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

describe("untouched Ship run close", () => {
  const editLease = (root: string, edit: (lease: LoopLease) => void): void => {
    const path = loopLeasePath(
      captureInventory(root).repository.commonGitDirectory
    );
    const stored = JSON.parse(readFileSync(path, "utf8")) as LoopLease;
    edit(stored);
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  };

  const historyPath = (root: string, runId: string, name: string): string =>
    join(
      captureInventory(root).repository.commonGitDirectory,
      "simple-changes",
      "history",
      runId,
      name
    );

  // A Ship run whose opening inventory holds local changes must record its
  // scope before shared mutations. A claimed concurrent author keeps working.
  const scopeRequiredShipRun = () => {
    const fixture = repository();
    const authorPath = join(fixture.base, "claimed-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "claimed-author-work",
      authorPath,
    ]);
    claimWorktree(
      fixture.root,
      "feature-agent",
      authorPath,
      "codex",
      "task-feature"
    );
    writeFixture(
      fixture.root,
      "contact.ts",
      "export const email = 'resend';\n"
    );
    const lease = startLoop(fixture.root, "controller", "ship");
    expect(lease).toMatchObject({
      firstMutationAt: null,
      shipmentScopeRequired: true,
    });
    expect(lease.worktrees).toContainEqual(
      expect.objectContaining({ path: authorPath, role: "concurrent-author" })
    );
    return { authorPath, fixture, lease };
  };

  // The lighter form: only the controller's own checkout holds opening work.
  const dirtyShipRun = () => {
    const fixture = repository();
    writeFixture(fixture.root, "contact.ts", "export const email = 1;\n");
    const lease = startLoop(fixture.root, "controller", "ship");
    expect(lease).toMatchObject({
      firstMutationAt: null,
      shipmentScopeRequired: true,
    });
    return { fixture, lease };
  };

  test("closes a run whose scope can no longer be recorded, then starts fresh", () => {
    const { authorPath, fixture, lease } = scopeRequiredShipRun();
    expect(() =>
      guardLoopMutation(fixture.root, lease.runId, "controller")
    ).toThrow("comprehensive shipment scope");

    // The claimed author's edit alone would not block record-scope; the
    // controller's own later edit changes source bytes registered at start.
    writeFixture(authorPath, "feature.ts", "export const feature = 1;\n");
    writeFixture(fixture.root, "later.ts", "export const later = 1;\n");
    const current = captureInventory(fixture.root);
    expect(current.baselineDigest).not.toBe(lease.baselineDigest);
    const plan = buildPreviewPlan(
      current,
      current,
      compareSnapshots(current, current),
      "Ship every finished local change"
    );
    expect(() =>
      recordShipmentScope(fixture.root, lease.runId, "controller", plan)
    ).toThrow(
      `This run has not changed anything yet, so if the scope can no longer be recorded, close it with \`simple-changes loop end --run-id ${lease.runId} --agent-id controller\``
    );
    const status = loopStatus(fixture.root);
    expect(status.verification.ok).toBe(true);
    expect(status.guidance.headline).toContain("has not changed anything");
    expect(status.guidance.nextCommands[0]).toContain(
      `loop end --run-id ${lease.runId} --agent-id controller`
    );
    expect(status.guidance.nextCommands[1]).toContain("loop start --mode ship");
    expect(readLoopLease(fixture.root)?.firstMutationAt).toBeNull();

    const ended = endLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The opening inventory moved before scope was recorded."
    );

    const receiptPath = historyPath(
      fixture.root,
      lease.runId,
      "abort-unmutated.json"
    );
    expect(ended.ok).toBe(true);
    expect(ended.closedWithoutMutation?.receiptPath).toBe(receiptPath);
    expect(ended.closedWithoutMutation?.receipt).toMatchObject({
      closedBy: "loop end",
      kind: "loop-unmutated-close",
      openingBaselineDigest: lease.baselineDigest,
      ownerAgentId: "controller",
      reason: "The opening inventory moved before scope was recorded.",
      runId: lease.runId,
      verification: {
        currentBaselineDigest: current.baselineDigest,
        ok: true,
        violations: [],
      },
    });
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(
      ended.closedWithoutMutation?.receipt
    );
    expect(readLoopLease(fixture.root)).toBeNull();
    expect(readFileSync(join(authorPath, "feature.ts"), "utf8")).toBe(
      "export const feature = 1;\n"
    );
    expect(readFileSync(join(fixture.root, "contact.ts"), "utf8")).toBe(
      "export const email = 'resend';\n"
    );

    const fresh = startLoop(fixture.root, "controller", "ship");
    expect(fresh.runId).not.toBe(lease.runId);
    expect(fresh.baselineDigest).toBe(current.baselineDigest);
    expect(fresh.firstMutationAt).toBeNull();
  }, 90_000);

  test("closes over an unclaimed opening worktree that kept changing and records it", () => {
    const fixture = repository();
    const preservedPath = join(fixture.base, "unclaimed");
    git(fixture.root, ["worktree", "add", "--detach", preservedPath]);
    writeFixture(fixture.root, "contact.ts", "export const email = 1;\n");
    const lease = startLoop(fixture.root, "controller", "ship");
    writeFixture(preservedPath, "notes.txt", "still being written\n");
    const current = captureInventory(fixture.root);
    expect(() =>
      recordShipmentScope(
        fixture.root,
        lease.runId,
        "controller",
        buildPreviewPlan(
          current,
          current,
          compareSnapshots(current, current),
          "Ship every finished local change"
        )
      )
    ).toThrow(
      `preserved-worktree-changed:${preservedPath}. Run \`simple-changes loop status\` for the exact next commands; a changed unclaimed opening worktree needs a user-approved \`loop allow\` before scope is recorded. Because this run has not changed anything yet, \`simple-changes loop end --run-id ${lease.runId} --agent-id controller\` can instead close it`
    );

    const ended = endLoop(fixture.root, lease.runId, "controller");

    expect(ended.ok).toBe(false);
    expect(ended.closedWithoutMutation?.receipt).toMatchObject({
      reason: null,
      verification: {
        ok: false,
        violations: [
          { code: "preserved-worktree-changed", path: preservedPath },
        ],
      },
    });
    expect(readLoopLease(fixture.root)).toBeNull();
    expect(readFileSync(join(preservedPath, "notes.txt"), "utf8")).toBe(
      "still being written\n"
    );
  }, 60_000);

  test("refuses the untouched close when an unregistered worktree appears", () => {
    const { fixture, lease } = scopeRequiredShipRun();
    const late = join(fixture.base, "late-unregistered");
    git(fixture.root, ["worktree", "add", "-b", "late-unregistered", late]);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      current,
      current,
      compareSnapshots(current, current),
      "Ship every finished local change"
    );
    let message = "";
    try {
      recordShipmentScope(fixture.root, lease.runId, "controller", plan);
    } catch (error) {
      ({ message } = error as Error);
    }
    expect(message).toBe(
      `Shipment scope cannot be recorded while loop ${lease.runId} verification fails: unregistered-worktree:${late}. Run \`simple-changes loop status\` for the exact next commands; a changed unclaimed opening worktree needs a user-approved \`loop allow\` before scope is recorded.`
    );
    expect(loopStatus(fixture.root).guidance.headline).toContain(
      "Verification"
    );

    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      `Record the comprehensive shipment scope and pre-ship brief before ending this Ship run. manifest violations: unregistered-worktree:${late}`
    );
    expect(readLoopLease(fixture.root)?.runId).toBe(lease.runId);
    expect(
      existsSync(historyPath(fixture.root, lease.runId, "abort-unmutated.json"))
    ).toBe(false);
  }, 60_000);

  // Guarded operations refuse before scope is recorded, so the requirement is
  // lifted around them; their mutation evidence alone must keep the blocker.
  const withScopeRequirementLifted = async (
    root: string,
    action: () => unknown
  ): Promise<void> => {
    editLease(root, (lease) => {
      lease.shipmentScopeRequired = false;
    });
    try {
      await action();
    } finally {
      editLease(root, (lease) => {
        lease.shipmentScopeRequired = true;
      });
    }
  };

  test.each([
    [
      "loop guard",
      (root: string, runId: string) =>
        withScopeRequirementLifted(root, () =>
          guardLoopMutation(root, runId, "controller")
        ),
    ],
    [
      "loop exec",
      (root: string, runId: string) =>
        withScopeRequirementLifted(root, () =>
          executeLoopMutation(root, runId, "controller", [
            "git",
            "status",
            "--short",
          ])
        ),
    ],
    [
      "prepare-agent",
      (root: string, runId: string) =>
        withScopeRequirementLifted(root, () =>
          prepareAgentWorktree(root, runId, "author", "unit")
        ),
    ],
    [
      "loop rebaseline",
      (root: string, runId: string, base: string) => {
        git(root, [
          "worktree",
          "add",
          "-b",
          "late-rebaselined",
          join(base, "late-rebaselined"),
        ]);
        rebaselineLoopWorktrees(
          root,
          runId,
          "controller",
          "user",
          "Register the late worktree"
        );
      },
    ],
  ] as const)(
    "keeps the scope blocker after %s records mutation evidence",
    async (_name, act) => {
      const { fixture, lease } = dirtyShipRun();
      await act(fixture.root, lease.runId, fixture.base);
      writeFixture(fixture.root, "later.ts", "export const later = 1;\n");

      expect(readLoopLease(fixture.root)?.firstMutationAt).toEqual(
        expect.any(String)
      );
      expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
        "Record the comprehensive shipment scope and pre-ship brief before ending this Ship run."
      );
      expect(readLoopLease(fixture.root)?.runId).toBe(lease.runId);
      expect(
        existsSync(
          historyPath(fixture.root, lease.runId, "abort-unmutated.json")
        )
      ).toBe(false);
    },
    60_000
  );

  test("records the first mutation once and keeps it across a takeover", async () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "ship");
    expect(lease.firstMutationAt).toBeNull();

    guardLoopMutation(fixture.root, lease.runId, "controller");
    const first = readLoopLease(fixture.root)?.firstMutationAt;
    expect(first).toEqual(expect.any(String));
    await sleep(5);
    guardLoopMutation(fixture.root, lease.runId, "controller");
    await executeLoopMutation(fixture.root, lease.runId, "controller", [
      "git",
      "status",
      "--short",
    ]);
    expect(readLoopLease(fixture.root)?.firstMutationAt).toBe(first);

    const taken = takeoverLoop(
      fixture.root,
      lease.runId,
      "replacement-controller",
      loopManifestDigest(readLoopLease(fixture.root) as LoopLease),
      "repository-owner",
      "The prior controller stopped responding."
    );
    expect(taken.ownerAgentId).toBe("replacement-controller");
    expect(taken.firstMutationAt).toBe(first);
  }, 60_000);

  test("treats a takeover of an untouched run as mutation evidence", () => {
    const { fixture, lease } = dirtyShipRun();
    const taken = takeoverLoop(
      fixture.root,
      lease.runId,
      "replacement-controller",
      loopManifestDigest(lease),
      "repository-owner",
      "The prior controller stopped responding."
    );
    expect(taken.firstMutationAt).toEqual(expect.any(String));
    writeFixture(fixture.root, "later.ts", "export const later = 1;\n");

    expect(() =>
      endLoop(fixture.root, lease.runId, "replacement-controller")
    ).toThrow("Record the comprehensive shipment scope");
    expect(readLoopLease(fixture.root)?.runId).toBe(lease.runId);
  }, 60_000);

  test("accepts a lease without the field or with null, but never closes a legacy lease as untouched", () => {
    const { fixture, lease } = dirtyShipRun();
    expect(
      validateSchema<LoopLease>("loop-lease", lease).firstMutationAt
    ).toBeNull();
    const { firstMutationAt: _firstMutationAt, ...legacy } = lease;
    expect(
      validateSchema<LoopLease>("loop-lease", legacy).firstMutationAt
    ).toBeUndefined();

    editLease(fixture.root, (stored) => {
      Reflect.deleteProperty(stored, "firstMutationAt");
    });
    writeFixture(fixture.root, "later.ts", "export const later = 1;\n");
    expect(readLoopLease(fixture.root)?.firstMutationAt).toBeUndefined();
    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "Record the comprehensive shipment scope"
    );
    expect(readLoopLease(fixture.root)?.runId).toBe(lease.runId);
  }, 60_000);

  test("finalize closes the moved untouched run instead of freezing its scope", () => {
    const { authorPath, fixture, lease } = scopeRequiredShipRun();
    writeFixture(authorPath, "feature.ts", "export const feature = 1;\n");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The opening inventory moved before scope was recorded."
    );

    expect(finalized).toMatchObject({
      blockers: [],
      lease: null,
      outcome: "closed-without-mutation",
      receipt: {
        blocksNextShipment: false,
        controllerStatus: "released",
        deliveryStatus: "unverified",
        shipmentStatus: "unstarted",
      },
    });
    expect(finalized.closedWithoutMutation?.receipt.closedBy).toBe(
      "loop finalize"
    );
    expect(existsSync(finalized.receiptPath)).toBe(true);
    expect(
      existsSync(historyPath(fixture.root, lease.runId, "abort-unmutated.json"))
    ).toBe(true);
    expect(readLoopLease(fixture.root)).toBeNull();
    expect(startLoop(fixture.root, "controller", "ship").runId).not.toBe(
      lease.runId
    );
  }, 60_000);
  test("finalize closes an untouched run even when nothing moved", () => {
    const { fixture, lease } = dirtyShipRun();
    expect(captureInventory(fixture.root).baselineDigest).toBe(
      lease.baselineDigest
    );

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The turn ended on a scope question."
    );

    expect(finalized).toMatchObject({
      lease: null,
      outcome: "closed-without-mutation",
      receipt: { shipmentStatus: "unstarted" },
    });
    expect(readLoopLease(fixture.root)).toBeNull();
    expect(readFileSync(join(fixture.root, "contact.ts"), "utf8")).toBe(
      "export const email = 1;\n"
    );
    const fresh = startLoop(fixture.root, "controller", "ship");
    expect(fresh.runId).not.toBe(lease.runId);
    expect(fresh.baselineDigest).toBe(lease.baselineDigest);
  }, 60_000);

  // Each of these records lease evidence without a shipment scope. The run
  // stays healthy, so only that evidence can be what refuses the close.
  const gitLabTarget = (root: string): string => {
    git(root, ["remote", "add", "origin", "git@gitlab.com:group/project.git"]);
    return git(root, ["rev-parse", "HEAD"]);
  };
  type EvidenceCase = [
    string,
    (root: string, base: string) => ReturnType<typeof remoteSnapshot> | null,
    (root: string, base: string, runId: string) => void,
  ];
  const evidenceCases: EvidenceCase[] = [
    [
      "loop allow",
      (root: string, base: string) => {
        git(root, ["worktree", "add", "--detach", join(base, "unclaimed")]);
        return null;
      },
      (root: string, base: string, runId: string) => {
        const path = join(base, "unclaimed");
        writeFixture(path, "notes.txt", "still being written\n");
        const changed = captureInventory(root).worktrees.find(
          (worktree) => worktree.path === path
        );
        grantLoopOverride(
          root,
          runId,
          "controller",
          path,
          changed?.changeDigest ?? "",
          "user",
          "Keep the notes in place."
        );
      },
    ],
    [
      "loop dispose-worktree",
      (root: string, base: string) => {
        git(root, ["worktree", "add", "-b", "obsolete-work", join(base, "o")]);
        return null;
      },
      (root: string, base: string, runId: string) => {
        const path = join(base, "o");
        const current = captureInventory(root).worktrees.find(
          (worktree) => worktree.path === path
        );
        authorizeWorktreeRemoval(
          root,
          runId,
          "controller",
          path,
          current?.changeDigest ?? "",
          "user",
          "Audited obsolete with no unique work."
        );
      },
    ],
    [
      "loop retain-worktree",
      () => null,
      (root: string, base: string, runId: string) => {
        const path = join(base, "walkthrough");
        git(root, ["worktree", "add", "-b", "walkthrough", path]);
        const current = captureInventory(root).worktrees.find(
          (worktree) => worktree.path === path
        );
        retainExcludedWorktree(
          root,
          runId,
          "controller",
          path,
          current?.changeDigest ?? "",
          "user",
          "Keep the walkthrough out of this shipment."
        );
      },
    ],
    [
      "loop retire-absent-worktree",
      (root: string, base: string) => {
        git(root, ["worktree", "add", "-b", "gone-work", join(base, "gone")]);
        return null;
      },
      (root: string, base: string, runId: string) => {
        const path = join(base, "gone");
        rmSync(path, { force: true, recursive: true });
        git(root, ["worktree", "prune"]);
        retireAbsentWorktree(
          root,
          runId,
          "controller",
          path,
          "user",
          "Removed by its owner."
        );
      },
    ],
    [
      "loop adopt-worktree",
      () => null,
      (root: string, base: string, runId: string) => {
        const path = join(base, "straggler");
        git(root, ["worktree", "add", "-b", "straggler", path]);
        claimWorktree(path, "straggler-author", path, "codex", "task-s");
        const pause = pauseClaimedWorktree(
          path,
          "straggler-author",
          path,
          runId,
          "preserve-in-place",
          "Pause at a stable boundary for adoption."
        );
        adoptPausedWorktree(root, runId, "controller", pause.receiptId);
      },
    ],
    [
      "loop reconcile-remote-branches",
      (root: string) => remoteSnapshot(gitLabTarget(root)),
      (root: string, _base: string, runId: string) => {
        recordRemoteBranchReconciliation(
          root,
          runId,
          "controller",
          remoteSnapshot(git(root, ["rev-parse", "HEAD"]))
        );
      },
    ],
  ];
  test.each(evidenceCases)(
    "refuses the untouched close after %s records lease evidence",
    (_name, beforeStart, act) => {
      const fixture = repository();
      writeFixture(fixture.root, "contact.ts", "export const email = 1;\n");
      const openingRemote = beforeStart(fixture.root, fixture.base);
      const lease = startLoop(
        fixture.root,
        "controller",
        "ship",
        openingRemote ?? undefined
      );
      expect(lease).toMatchObject({
        firstMutationAt: null,
        shipmentScopeRequired: true,
      });

      act(fixture.root, fixture.base, lease.runId);

      expect(readLoopLease(fixture.root)?.firstMutationAt).toEqual(
        expect.any(String)
      );
      expect(verifyLoop(fixture.root).ok).toBe(true);
      expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
        "Record the comprehensive shipment scope"
      );
      expect(
        finalizeLoop(
          fixture.root,
          lease.runId,
          "controller",
          "Scope was never recorded."
        ).outcome
      ).toBe("relinquished");
      expect(
        existsSync(
          historyPath(fixture.root, lease.runId, "abort-unmutated.json")
        )
      ).toBe(false);
    },
    60_000
  );
});

describe("first shipment scope after unrelated changes", () => {
  const editLease = (root: string, edit: (lease: LoopLease) => void): void => {
    const path = loopLeasePath(
      captureInventory(root).repository.commonGitDirectory
    );
    const stored = JSON.parse(readFileSync(path, "utf8")) as LoopLease;
    edit(stored);
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  };

  // A preview of the exact current inventory in which every unit from a
  // `preserve` worktree moves to the preserved section, as a controller does
  // for work a claimed concurrent author still owns.
  const currentPlan = (root: string, preserve: string[] = []): ChangePlan => {
    const inventory = captureInventory(root);
    const preview = buildPreviewPlan(
      inventory,
      inventory,
      compareSnapshots(inventory, inventory),
      "Ship every finished local change"
    );
    const preservedWork = preserve
      .map((worktreePath) => ({
        classification: "actively-changing" as const,
        paths: preview.units
          .filter((unit) => unit.sourceWorktree === worktreePath)
          .flatMap((unit) => unit.paths)
          .sort(),
        reason: "Another author still owns this work.",
        worktreePath,
      }))
      .filter((item) => item.paths.length > 0);
    return {
      ...preview,
      preserved: [...preview.preserved, ...preservedWork],
      units: preview.units.filter(
        (unit) => !preserve.includes(unit.sourceWorktree)
      ),
    };
  };

  const refusal = (action: () => unknown): string => {
    try {
      action();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("Expected record-scope to refuse.");
  };

  // A Ship run whose controller checkout holds opening work while a claimed
  // concurrent author works on its own branch.
  const shipRunWithClaimedAuthor = (
    beforeStart: (fixture: TestRepository) => void = () => undefined
  ) => {
    const fixture = repository();
    const authorPath = join(fixture.base, "claimed-author");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "claimed-author-work",
      authorPath,
    ]);
    claimWorktree(
      fixture.root,
      "feature-agent",
      authorPath,
      "codex",
      "task-feature"
    );
    writeFixture(
      fixture.root,
      "contact.ts",
      "export const email = 'resend';\n"
    );
    beforeStart(fixture);
    const lease = startLoop(fixture.root, "controller", "ship");
    expect(lease).toMatchObject({
      firstMutationAt: null,
      openingInvariantDigest: expect.stringMatching(SHA256_PATTERN),
      shipmentScopeRequired: true,
    });
    expect(lease.openingWorktrees).toContainEqual(
      expect.objectContaining({
        branch: "claimed-author-work",
        path: authorPath,
      })
    );
    return { authorPath, fixture, lease };
  };

  const endCommand = (lease: LoopLease): string =>
    `close it with \`simple-changes loop end --run-id ${lease.runId} --agent-id controller\``;

  test("records scope while a claimed author keeps editing and committing", () => {
    const { authorPath, fixture, lease } = shipRunWithClaimedAuthor();
    writeFixture(authorPath, "feature.ts", "export const feature = 1;\n");
    git(authorPath, ["add", "feature.ts"]);
    git(authorPath, ["commit", "-m", "Author-local commit"]);
    writeFixture(authorPath, "draft.ts", "export const draft = true;\n");
    const current = captureInventory(fixture.root);
    expect(current.baselineDigest).not.toBe(lease.baselineDigest);

    const status = loopStatus(fixture.root);
    expect(status.verification.ok).toBe(true);
    expect(status.guidance.headline).toContain(
      "Record-scope accepts unrelated changes made since loop start"
    );
    expect(status.guidance.nextCommands).toEqual([
      expect.stringContaining(`loop record-scope --run-id ${lease.runId}`),
    ]);

    const receipt = recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      currentPlan(fixture.root, [authorPath])
    );

    expect(receipt).toMatchObject({ includedPaths: 1, preservedPaths: 1 });
    expect(receipt.summary).toContain(
      `Branch claimed-author-work; worktree ${authorPath}.`
    );
    const stored = readLoopLease(fixture.root);
    expect(stored?.shipmentScope?.plan.preserved).toContainEqual(
      expect.objectContaining({ paths: ["draft.ts"], worktreePath: authorPath })
    );
    expect(stored?.shipmentScope?.plan.units).toEqual([
      expect.objectContaining({
        paths: ["contact.ts"],
        sourceWorktree: fixture.root,
      }),
    ]);
    expect(stored?.shipmentScope?.openingInventoryDigest).toBe(
      current.baselineDigest
    );
    expect(stored?.baselineDigest).toBe(lease.baselineDigest);
    expect(guardLoopMutation(fixture.root, lease.runId, "controller").ok).toBe(
      true
    );
  }, 60_000);

  test("records scope after an unrelated branch commit and a stash", () => {
    const { authorPath, fixture, lease } = shipRunWithClaimedAuthor(
      ({ root }) => {
        git(root, ["branch", "side"]);
      }
    );
    const tree = git(fixture.root, ["rev-parse", "HEAD^{tree}"]);
    const sideCommit = git(fixture.root, [
      "commit-tree",
      tree,
      "-p",
      "side",
      "-m",
      "Unrelated side work",
    ]);
    git(fixture.root, ["update-ref", "refs/heads/side", sideCommit]);
    git(fixture.root, ["branch", "late-unrelated", sideCommit]);
    writeFixture(authorPath, "README.md", "# Stashed author edit\n");
    git(authorPath, ["stash", "push", "-m", "Author stash"]);
    const current = captureInventory(fixture.root);
    expect(current.stashes).toHaveLength(1);
    expect(current.baselineDigest).not.toBe(lease.baselineDigest);

    expect(
      refusal(() =>
        recordShipmentScope(
          authorPath,
          lease.runId,
          "controller",
          currentPlan(authorPath)
        )
      )
    ).toBe(
      `Record shipment scope from the controller checkout ${fixture.root}; this command ran from ${authorPath}. Generate the preview there too.`
    );
    const receipt = recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      currentPlan(fixture.root)
    );
    expect(receipt.includedPaths).toBe(1);
    expect(readLoopLease(fixture.root)?.shipmentScope?.openingChanges).toEqual([
      expect.objectContaining({
        path: "contact.ts",
        worktreePath: fixture.root,
      }),
    ]);
  }, 60_000);

  test("refuses scope when the controller or a scoped source changed since start", () => {
    const { authorPath, fixture, lease } = shipRunWithClaimedAuthor(
      ({ base, root }) => {
        const unclaimed = join(base, "claimed-later");
        git(root, ["worktree", "add", "-b", "claimed-later-work", unclaimed]);
        writeFixture(unclaimed, "later.ts", "export const later = 1;\n");
      }
    );
    const claimedLater = join(fixture.base, "claimed-later");
    writeFixture(authorPath, "feature.ts", "export const feature = 1;\n");

    // A claimed author's changed worktree cannot be packaged as a unit.
    const authorRefusal = refusal(() =>
      recordShipmentScope(
        fixture.root,
        lease.runId,
        "controller",
        currentPlan(fixture.root, [claimedLater])
      )
    );
    expect(authorRefusal).toContain(
      `Scoped source worktree ${authorPath} changed after loop ${lease.runId} started: its staged, unstaged, or untracked content changed. Scoped source bytes must be the ones registered at loop start; keep its paths preserved or excluded in the plan instead.`
    );
    expect(authorRefusal).toContain(endCommand(lease));

    // Claiming an opening worktree later re-baselines its lease registration,
    // but its source bytes are still compared with the loop-start record.
    writeFixture(claimedLater, "later.ts", "export const later = 2;\n");
    claimWorktree(
      fixture.root,
      "later-agent",
      claimedLater,
      "codex",
      "task-later"
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(
      refusal(() =>
        recordShipmentScope(
          fixture.root,
          lease.runId,
          "controller",
          currentPlan(fixture.root, [authorPath])
        )
      )
    ).toContain(
      `Scoped source worktree ${claimedLater} changed after loop ${lease.runId} started: its staged, unstaged, or untracked content changed.`
    );
    recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      currentPlan(fixture.root, [authorPath, claimedLater])
    );
    expect(readLoopLease(fixture.root)?.shipmentScope?.plan.units).toEqual([
      expect.objectContaining({ sourceWorktree: fixture.root }),
    ]);
  }, 90_000);

  test("refuses scope from a changed controller checkout and names the next step", () => {
    const { authorPath, fixture, lease } = shipRunWithClaimedAuthor();
    writeFixture(fixture.root, "later.ts", "export const later = 1;\n");
    const plan = currentPlan(fixture.root, [authorPath]);

    const untouched = refusal(() =>
      recordShipmentScope(fixture.root, lease.runId, "controller", plan)
    );
    expect(untouched).toContain(
      `Controller checkout ${fixture.root} changed after loop ${lease.runId} started: its staged, unstaged, or untracked content changed. Scoped source bytes must be the ones registered at loop start.`
    );
    expect(untouched).toContain(
      `This run has not changed anything yet, so if the scope can no longer be recorded, ${endCommand(lease)}`
    );
    const status = loopStatus(fixture.root);
    expect(status.guidance.headline).toContain(
      `Loop ${lease.runId} has not changed anything, but its shipment scope can no longer be recorded. Controller checkout ${fixture.root} changed`
    );
    expect(status.guidance.nextCommands[0]).toContain(
      `loop end --run-id ${lease.runId} --agent-id controller`
    );

    // Once the run holds mutation evidence, `loop end` is no longer offered.
    editLease(fixture.root, (stored) => {
      stored.firstMutationAt = new Date().toISOString();
    });
    const mutated = refusal(() =>
      recordShipmentScope(fixture.root, lease.runId, "controller", plan)
    );
    expect(mutated).toContain(
      `Controller checkout ${fixture.root} changed after loop ${lease.runId} started`
    );
    expect(mutated).toContain(
      "This run has already recorded mutation evidence, so `loop end` cannot close it."
    );
    expect(mutated).toContain(
      `finalize it with \`simple-changes loop finalize --run-id ${lease.runId} --agent-id controller --reason <why>\`, which relinquishes its controller, then replan it`
    );
    expect(mutated).not.toContain("loop end --run-id");
    const mutatedStatus = loopStatus(fixture.root).guidance;
    expect(mutatedStatus.headline).toContain(
      `Loop ${lease.runId} can no longer record its first shipment scope.`
    );
    expect(mutatedStatus.nextCommands[0]).toContain(
      `loop finalize --run-id ${lease.runId}`
    );
    expect(mutatedStatus.nextCommands.join("\n")).not.toContain("loop end");
  }, 60_000);

  test("refuses scope after the pinned target moves", () => {
    const { authorPath, fixture, lease } = shipRunWithClaimedAuthor();
    const tree = git(fixture.root, ["rev-parse", "HEAD^{tree}"]);
    const moved = git(fixture.root, [
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-m",
      "Target moved",
    ]);
    git(fixture.root, ["update-ref", "refs/heads/main", moved]);

    const message = refusal(() =>
      recordShipmentScope(
        fixture.root,
        lease.runId,
        "controller",
        currentPlan(fixture.root, [authorPath])
      )
    );
    expect(message).toContain(
      `Target main moved from ${lease.targetRevision.slice(0, 12)} to ${moved.slice(0, 12)} after loop ${lease.runId} started, so a first shipment scope can no longer be recorded against the pinned target revision.`
    );
    expect(message).toContain(endCommand(lease));
    expect(loopStatus(fixture.root).guidance.headline).toContain(
      `Target main moved from ${lease.targetRevision.slice(0, 12)}`
    );
  }, 60_000);

  test("refuses scope after repository policy changes", () => {
    const { authorPath, fixture, lease } = shipRunWithClaimedAuthor();
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify({ ...DEFAULT_POLICY, questions: "always" })}\n`
    );

    const message = refusal(() =>
      recordShipmentScope(
        fixture.root,
        lease.runId,
        "controller",
        currentPlan(fixture.root, [authorPath])
      )
    );
    expect(message).toContain(
      `Repository policy, discovered capabilities, remote bindings, or the target binding changed after loop ${lease.runId} started, so a first shipment scope can no longer be recorded.`
    );
    expect(message).toContain(endCommand(lease));
  }, 60_000);

  test("requires an explicit allow for a changed unclaimed opening worktree", () => {
    const fixture = repository();
    const preservedPath = join(fixture.base, "unclaimed");
    git(fixture.root, ["worktree", "add", "--detach", preservedPath]);
    writeFixture(fixture.root, "contact.ts", "export const email = 1;\n");
    const lease = startLoop(fixture.root, "controller", "ship");
    writeFixture(preservedPath, "notes.txt", "still being written\n");
    const plan = currentPlan(fixture.root, [preservedPath]);

    const message = refusal(() =>
      recordShipmentScope(fixture.root, lease.runId, "controller", plan)
    );
    expect(message).toContain(
      `Shipment scope cannot be recorded while loop ${lease.runId} verification fails: preserved-worktree-changed:${preservedPath}. Run \`simple-changes loop status\` for the exact next commands; a changed unclaimed opening worktree needs a user-approved \`loop allow\` before scope is recorded.`
    );
    expect(message).toContain("can instead close it for a fresh `loop start`");
    const status = loopStatus(fixture.root).guidance;
    expect(status.nextCommands[0]).toContain(
      `loop allow --run-id ${lease.runId} --agent-id controller --worktree ${preservedPath}`
    );
    expect(status.nextCommands.at(-1)).toContain(
      `loop end --run-id ${lease.runId}`
    );

    const changed = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === preservedPath
    );
    grantLoopOverride(
      fixture.root,
      lease.runId,
      "controller",
      preservedPath,
      changed?.changeDigest ?? "",
      "user",
      "Keep these notes in place while contact.ts ships."
    );
    // The allowed worktree may be preserved, but never packaged.
    expect(
      refusal(() =>
        recordShipmentScope(
          fixture.root,
          lease.runId,
          "controller",
          currentPlan(fixture.root)
        )
      )
    ).toContain(
      `Scoped source worktree ${preservedPath} changed after loop ${lease.runId} started`
    );
    const receipt = recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      plan
    );
    expect(receipt).toMatchObject({ includedPaths: 1, preservedPaths: 1 });
  }, 60_000);

  test("keeps the whole-inventory rule for a lease without scoped invariants", () => {
    const { authorPath, fixture, lease } = shipRunWithClaimedAuthor();
    editLease(fixture.root, (stored) => {
      Reflect.deleteProperty(stored, "openingInvariantDigest");
      Reflect.deleteProperty(stored, "openingWorktrees");
    });
    const legacy = readLoopLease(fixture.root);
    expect(legacy?.openingInvariantDigest).toBeUndefined();
    expect(legacy?.openingWorktrees).toBeUndefined();
    writeFixture(authorPath, "feature.ts", "export const feature = 1;\n");

    const message = refusal(() =>
      recordShipmentScope(
        fixture.root,
        lease.runId,
        "controller",
        currentPlan(fixture.root, [authorPath])
      )
    );
    expect(message).toContain(
      `Shipment scope must match the exact unchanged opening repository inventory: loop ${lease.runId} predates scoped record-scope checks, and the repository changed after it started.`
    );
    expect(message).toContain(endCommand(lease));

    rmSync(join(authorPath, "feature.ts"));
    expect(captureInventory(fixture.root).baselineDigest).toBe(
      lease.baselineDigest
    );
    recordShipmentScope(
      fixture.root,
      lease.runId,
      "controller",
      currentPlan(fixture.root, [authorPath])
    );
    expect(
      readLoopLease(fixture.root)?.shipmentScope?.openingInventoryDigest
    ).toBe(lease.baselineDigest);
  }, 60_000);
});
