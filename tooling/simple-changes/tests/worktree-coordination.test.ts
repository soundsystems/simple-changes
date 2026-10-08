import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildCoordinationRequest,
  probeCoordinationAdapter,
} from "../../../skills/simple-changes/scripts/lib/coordination-adapter.ts";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  acceptPausedWorktreeChange,
  adoptPausedWorktree,
  endLoop,
  markWorktreeResumeReady,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import {
  attachClaimedWorktree,
  claimWorktree,
  detachClaimedWorktree,
  pauseClaimedWorktree,
  readWorktreeCoordination,
  readWorktreeTakeovers,
  releaseAbsentWorktreeClaimsUnderLock,
  releaseHandoffWorktreeClaim,
  releaseWorktreeClaim,
  takeoverWorktreeClaim,
  withWorktreeCoordinationLock,
  worktreeCoordinationPath,
  worktreeTakeoversPath,
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

describe("worktree coordination", () => {
  test("distinguishes permission denial from lock contention", () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = repository();
    const worktree = join(fixture.base, "permission-denied-claim");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "permission-denied-claim",
      worktree,
    ]);
    const { commonGitDirectory } = captureInventory(worktree).repository;
    const stateDirectory = join(commonGitDirectory, "simple-changes");
    mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
    chmodSync(stateDirectory, 0o500);

    try {
      expect(() =>
        claimWorktree(
          worktree,
          "permission-owner",
          worktree,
          "codex",
          "permission-test"
        )
      ).toThrow("This is not lock contention");
    } finally {
      chmodSync(stateDirectory, 0o700);
    }
    expect(readWorktreeCoordination(worktree).claims).toEqual([]);
  });

  test("claims exact dirty evidence idempotently and rejects another owner", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "claimed");
    git(fixture.root, ["worktree", "add", "-b", "claimed-work", worktree]);
    writeFixture(worktree, "dirty.ts", "export const dirty = true;\n");

    const claim = claimWorktree(
      worktree,
      "owner",
      worktree,
      "claude-code",
      "session-123"
    );
    const repeated = claimWorktree(
      worktree,
      "owner",
      worktree,
      "claude-code",
      "session-123"
    );
    const current = captureInventory(worktree).worktrees.find(
      (item) => item.path === worktree
    );

    expect(repeated).toEqual(claim);
    expect(claim.changeDigest).toBe(current?.changeDigest ?? "");
    expect(claim.owner.ownerRef).toBe("session-123");
    expect(() =>
      claimWorktree(worktree, "intruder", worktree, "codex-desktop")
    ).toThrow("already claimed");
    expect(() =>
      claimWorktree(
        worktree,
        "owner",
        worktree,
        "claude-code",
        "api_key=super-secret-value"
      )
    ).toThrow("must not contain credentials");
    const coordinationMode = statSync(
      worktreeCoordinationPath(
        captureInventory(worktree).repository.commonGitDirectory
      )
    ).mode;
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits require a bit mask.
    expect(coordinationMode & 0o777).toBe(0o600);

    writeFixture(worktree, "dirty.ts", "export const dirty = false;\n");
    expect(() =>
      pauseClaimedWorktree(
        worktree,
        "owner",
        worktree,
        "run-stale-claim",
        "preserve-in-place",
        "This stale claim must be refreshed"
      )
    ).toThrow("claim is stale");
    expect(
      readWorktreeCoordination(worktree).claims.find(
        (item) => item.claimId === claim.claimId
      )?.state
    ).toBe("stale");
    const refreshed = claimWorktree(
      worktree,
      "owner",
      worktree,
      "claude-code",
      "session-123"
    );
    expect(refreshed).toMatchObject({
      claimId: claim.claimId,
      state: "active",
    });
  });

  test("adopts a concurrent owner-paused worktree as immutable preserved state", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const concurrent = join(fixture.base, "concurrent");
    git(fixture.root, ["worktree", "add", "-b", "concurrent-work", concurrent]);
    writeFixture(concurrent, "owned.ts", "export const owned = true;\n");
    const claim = claimWorktree(
      concurrent,
      "owner",
      concurrent,
      "codex-desktop",
      "task-123"
    );
    const receipt = pauseClaimedWorktree(
      concurrent,
      "owner",
      concurrent,
      lease.runId,
      "preserve-in-place",
      "Controller requested a safe pause"
    );

    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "unregistered-worktree",
        path: concurrent,
      })
    );
    const updated = adoptPausedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      receipt.receiptId
    );
    expect(updated.worktrees).toContainEqual(
      expect.objectContaining({
        claimId: claim.claimId,
        coordinationState: "adopted-preserved",
        mutationAllowed: false,
        path: concurrent,
        pauseReceiptId: receipt.receiptId,
        role: "preserved",
      })
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);

    const resume = markWorktreeResumeReady(
      fixture.root,
      lease.runId,
      "controller",
      claim.claimId
    );
    expect(resume.targetSha).toBe(git(fixture.root, ["rev-parse", "main"]));
    expect(
      readWorktreeCoordination(fixture.root).claims.find(
        (item) => item.claimId === claim.claimId
      )
    ).toMatchObject({
      resumeTarget: { runId: lease.runId, targetSha: resume.targetSha },
      state: "resume-ready",
    });
    const resumeClaim = readWorktreeCoordination(fixture.root).claims.find(
      (item) => item.claimId === claim.claimId
    );
    if (!resumeClaim) {
      throw new Error("Expected the resume-ready claim");
    }
    expect(
      buildCoordinationRequest("notify-resume", resumeClaim, lease.runId)
        .safeMessage
    ).toContain(resume.targetSha);

    writeFixture(concurrent, "owned.ts", "export const owned = false;\n");
    expect(verifyLoop(fixture.root).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "preserved-worktree-changed" }),
        expect.objectContaining({ code: "coordination-claim-stale" }),
      ])
    );
  });

  test("accepts a changed opening worktree only from its exact pause receipt", () => {
    const fixture = repository();
    const preserved = join(fixture.base, "preserved");
    git(fixture.root, ["worktree", "add", "-b", "preserved-work", preserved]);
    const lease = startLoop(fixture.root, "controller", "reconcile");
    claimWorktree(preserved, "owner", preserved, "hermes-gateway", "session-1");
    writeFixture(preserved, "change.ts", "export const change = true;\n");
    claimWorktree(preserved, "owner", preserved, "hermes-gateway", "session-1");
    const receipt = pauseClaimedWorktree(
      preserved,
      "owner",
      preserved,
      lease.runId,
      "preserve-in-place",
      "Paused after completing an edit"
    );

    expect(verifyLoop(fixture.root).ok).toBe(false);
    acceptPausedWorktreeChange(
      fixture.root,
      lease.runId,
      "controller",
      receipt.receiptId
    );
    expect(verifyLoop(fixture.root).ok).toBe(true);
  });

  test("detaches and reattaches a clean branch with unique commits", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "reconcile");
    const worktree = join(fixture.base, "detachable");
    git(fixture.root, ["worktree", "add", "-b", "detachable-work", worktree]);
    writeFixture(worktree, "unique.ts", "export const unique = true;\n");
    git(worktree, ["add", "unique.ts"]);
    git(worktree, ["commit", "-m", "Unique work"]);
    const head = git(worktree, ["rev-parse", "HEAD"]);
    const claim = claimWorktree(
      worktree,
      "owner",
      worktree,
      "cursor-cloud",
      "agent-run-1"
    );
    const receipt = pauseClaimedWorktree(
      worktree,
      "owner",
      worktree,
      lease.runId,
      "detach-clean-checkout",
      "Temporarily detach during synchronization"
    );

    const detached = detachClaimedWorktree(
      fixture.root,
      "owner",
      worktree,
      receipt.receiptId
    );
    expect(detached.state).toBe("detached");
    expect(git(fixture.root, ["rev-parse", "detachable-work"])).toBe(head);
    expect(captureInventory(fixture.root).worktrees).not.toContainEqual(
      expect.objectContaining({ path: worktree })
    );

    const resume = markWorktreeResumeReady(
      fixture.root,
      lease.runId,
      "controller",
      claim.claimId
    );
    expect(resume.targetSha).toBe(git(fixture.root, ["rev-parse", "main"]));
    expect(endLoop(fixture.root, lease.runId, "controller").ok).toBe(true);

    const attached = attachClaimedWorktree(
      fixture.root,
      "owner",
      claim.claimId
    );
    expect(attached.state).toBe("attached");
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("rejects a detach receipt for a dirty worktree", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "dirty-detach");
    git(fixture.root, ["worktree", "add", "-b", "dirty-detach", worktree]);
    claimWorktree(worktree, "owner", worktree, "codex-desktop", "task-1");
    writeFixture(worktree, "dirty.ts", "export const dirty = true;\n");

    expect(() =>
      pauseClaimedWorktree(
        worktree,
        "owner",
        worktree,
        "run-dirty-detach",
        "detach-clean-checkout",
        "This must fail"
      )
    ).toThrow("completely clean");
  });

  test("invalidates a linked lease after release", () => {
    const fixture = repository();
    const concurrent = join(fixture.base, "release-linked");
    const lease = startLoop(fixture.root, "controller", "integrate");
    git(fixture.root, ["worktree", "add", "-b", "release-linked", concurrent]);
    const claim = claimWorktree(
      concurrent,
      "owner",
      concurrent,
      "grok-build",
      "session-1"
    );
    const receipt = pauseClaimedWorktree(
      concurrent,
      "owner",
      concurrent,
      lease.runId,
      "preserve-in-place",
      "Pause before adoption"
    );
    adoptPausedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      receipt.receiptId
    );
    releaseWorktreeClaim(concurrent, "owner", claim.claimId);
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({ code: "coordination-claim-stale" })
    );
    expect(() => endLoop(fixture.root, lease.runId, "controller")).toThrow(
      "manifest violations"
    );
    const released = readWorktreeCoordination(fixture.root).claims.find(
      (item) => item.claimId === claim.claimId
    );
    if (!released) {
      throw new Error("Expected the released claim");
    }
    expect(() =>
      buildCoordinationRequest("request-pause", released, lease.runId)
    ).toThrow("released claim");
  });

  test("reports full and capability-gated harness profiles without guessing", () => {
    expect(probeCoordinationAdapter("codex-desktop", "task-1")).toMatchObject({
      automatic: true,
      capabilities: {
        conditions: [expect.stringContaining("task tools")],
        wait: "event",
      },
    });
    expect(
      probeCoordinationAdapter("claude-code", "session-1", "darwin")
    ).toMatchObject({
      automatic: true,
      capabilities: {
        conditions: expect.arrayContaining([
          expect.stringContaining("cross-session messaging"),
          expect.stringContaining("same macOS or Linux host"),
        ]),
        scope: "same-host",
      },
    });
    expect(
      probeCoordinationAdapter("claude-code", "session-1", "win32")
    ).toMatchObject({
      automatic: false,
      blocker: {
        capability: "scope",
        code: "unsupported-capability",
        manualNextAction: expect.stringContaining("native Windows"),
      },
    });
    expect(probeCoordinationAdapter("cursor-cloud", null)).toMatchObject({
      automatic: false,
      blocker: { capability: "owner-ref" },
    });
    expect(probeCoordinationAdapter("cursor-local", "session-1")).toMatchObject(
      {
        automatic: false,
        blocker: { code: "unsupported-capability" },
        capabilities: { conditions: [] },
      }
    );
  });

  test("persists no prompts, provider tokens, or message bodies", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "safe-metadata");
    git(fixture.root, ["worktree", "add", "-b", "safe-metadata", worktree]);
    claimWorktree(
      worktree,
      "owner",
      worktree,
      "codex-desktop",
      "opaque-task-id"
    );
    const serialized = JSON.stringify(readWorktreeCoordination(worktree));
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("message");
  });
});

describe("worktree claim takeover", () => {
  test("reassigns a stale owner's claim only with exact digest evidence", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "abandoned");
    git(fixture.root, ["worktree", "add", "-b", "abandoned-work", worktree]);
    writeFixture(worktree, "dirty.ts", "export const dirty = true;\n");
    const claim = claimWorktree(
      worktree,
      "vanished-owner",
      worktree,
      "codex-desktop",
      "gone-session"
    );
    const current = captureInventory(worktree).worktrees.find(
      (item) => item.path === worktree
    );
    if (!current) {
      throw new Error("Expected the abandoned worktree inventory");
    }

    expect(() =>
      takeoverWorktreeClaim({
        action: "reassign",
        approvedBy: "jaay",
        claimId: "claim-does-not-exist",
        expectedStatusDigest: current.changeDigest,
        newAgentId: "admin-agent",
        reason: "Owner agent no longer exists",
        repositoryPath: worktree,
      })
    ).toThrow("Unknown worktree claim");
    expect(() =>
      takeoverWorktreeClaim({
        action: "reassign",
        approvedBy: "jaay",
        claimId: claim.claimId,
        expectedStatusDigest: "0".repeat(64),
        newAgentId: "admin-agent",
        reason: "Owner agent no longer exists",
        repositoryPath: worktree,
      })
    ).toThrow("re-observe");
    expect(() =>
      takeoverWorktreeClaim({
        action: "reassign",
        approvedBy: "  ",
        claimId: claim.claimId,
        expectedStatusDigest: current.changeDigest,
        newAgentId: "admin-agent",
        reason: "Owner agent no longer exists",
        repositoryPath: worktree,
      })
    ).toThrow("approver is required");
    expect(() =>
      takeoverWorktreeClaim({
        action: "reassign",
        approvedBy: "jaay",
        claimId: claim.claimId,
        expectedStatusDigest: current.changeDigest,
        newAgentId: "admin-agent",
        reason: "",
        repositoryPath: worktree,
      })
    ).toThrow("takeover reason is required");

    const result = takeoverWorktreeClaim({
      action: "reassign",
      approvedBy: "jaay",
      claimId: claim.claimId,
      expectedStatusDigest: current.changeDigest,
      newAgentId: "admin-agent",
      reason: "Owner agent no longer exists",
      repositoryPath: worktree,
    });
    expect(result.claim).toMatchObject({
      branch: claim.branch,
      claimId: claim.claimId,
      headSha: claim.headSha,
      owner: {
        adapter: "codex-desktop",
        agentId: "admin-agent",
        ownerRef: "takeover:jaay",
      },
      path: claim.path,
      state: "active",
    });
    expect(() =>
      validateSchema("worktree-takeover", result.receipt)
    ).not.toThrow();
    expect(result.receipt).toMatchObject({
      action: "reassign",
      approvedBy: "jaay",
      changeDigest: current.changeDigest,
      claimId: claim.claimId,
      newAgentId: "admin-agent",
      previousOwner: {
        adapter: "codex-desktop",
        agentId: "vanished-owner",
        ownerRef: "gone-session",
      },
    });
    expect(Number.isNaN(Date.parse(result.receipt.takenOverAt))).toBe(false);

    const { commonGitDirectory } = captureInventory(worktree).repository;
    const audited = readWorktreeTakeovers(commonGitDirectory);
    expect(audited).toEqual([result.receipt]);
    const takeoversMode = statSync(
      worktreeTakeoversPath(commonGitDirectory)
    ).mode;
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits require a bit mask.
    expect(takeoversMode & 0o777).toBe(0o600);

    const untouched = captureInventory(worktree).worktrees.find(
      (item) => item.path === worktree
    );
    expect(untouched).toMatchObject({
      branch: claim.branch,
      changeDigest: current.changeDigest,
      headSha: claim.headSha,
    });
    expect(readFileSync(join(worktree, "dirty.ts"), "utf8")).toBe(
      "export const dirty = true;\n"
    );
  });

  test("release action releases through the claim safety path", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "releasable");
    git(fixture.root, ["worktree", "add", "-b", "releasable-work", worktree]);
    const claim = claimWorktree(
      worktree,
      "vanished-owner",
      worktree,
      "cursor-cloud",
      "gone-run"
    );
    const current = captureInventory(worktree).worktrees.find(
      (item) => item.path === worktree
    );
    const result = takeoverWorktreeClaim({
      action: "release",
      approvedBy: "jaay",
      claimId: claim.claimId,
      expectedStatusDigest: current?.changeDigest ?? "",
      newAgentId: "admin-agent",
      reason: "Abandoned claim blocks cleanup",
      repositoryPath: worktree,
    });
    expect(result.claim.state).toBe("released");
    expect(result.receipt.action).toBe("release");
    expect(
      readWorktreeCoordination(worktree).claims.find(
        (item) => item.claimId === claim.claimId
      )?.state
    ).toBe("released");
    expect(
      readWorktreeCoordination(worktree).events.filter(
        (event) => event.claimId === claim.claimId && event.state === "released"
      )
    ).toHaveLength(1);
    expect(() =>
      takeoverWorktreeClaim({
        action: "release",
        approvedBy: "jaay",
        claimId: claim.claimId,
        expectedStatusDigest: current?.changeDigest ?? "",
        newAgentId: "admin-agent",
        reason: "Repeated takeover of a released claim",
        repositoryPath: worktree,
      })
    ).toThrow("only a live claim can be taken over");
  });

  test("recovers a durable takeover intent after coordination write interruption", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "intent-recovery");
    git(fixture.root, ["worktree", "add", "-b", "intent-recovery", worktree]);
    const claim = claimWorktree(
      worktree,
      "vanished-owner",
      worktree,
      "codex-desktop",
      "gone-session"
    );
    const current = captureInventory(worktree).worktrees.find(
      (item) => item.path === worktree
    );
    if (!current) {
      throw new Error("Expected takeover recovery worktree inventory");
    }
    const options = {
      action: "reassign" as const,
      approvedBy: "jaay",
      claimId: claim.claimId,
      expectedStatusDigest: current.changeDigest,
      newAgentId: "admin-agent",
      reason: "Owner agent no longer exists",
      repositoryPath: worktree,
    };
    process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT = claim.claimId;
    try {
      expect(() => takeoverWorktreeClaim(options)).toThrow(
        "durable takeover intent"
      );
    } finally {
      Reflect.deleteProperty(
        process.env,
        "SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT"
      );
    }
    const { commonGitDirectory } = captureInventory(worktree).repository;
    expect(readWorktreeTakeovers(commonGitDirectory)).toEqual([
      expect.objectContaining({ claimId: claim.claimId, phase: "intent" }),
    ]);
    expect(
      readWorktreeCoordination(worktree).claims.find(
        (item) => item.claimId === claim.claimId
      )?.owner.agentId
    ).toBe("vanished-owner");

    const recovered = takeoverWorktreeClaim(options);
    expect(recovered.receipt.phase).toBe("completed");
    expect(readWorktreeTakeovers(commonGitDirectory)).toEqual([
      recovered.receipt,
    ]);
  });

  test("refuses takeover while a live lease still requires the worktree", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const worktree = join(fixture.base, "leased");
    git(fixture.root, ["worktree", "add", "-b", "leased-work", worktree]);
    writeFixture(worktree, "leased.ts", "export const leased = true;\n");
    const claim = claimWorktree(
      worktree,
      "vanished-owner",
      worktree,
      "claude-code",
      "gone-session"
    );
    const receipt = pauseClaimedWorktree(
      worktree,
      "vanished-owner",
      worktree,
      lease.runId,
      "preserve-in-place",
      "Paused before the owner disappeared"
    );
    adoptPausedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      receipt.receiptId
    );
    const current = captureInventory(worktree).worktrees.find(
      (item) => item.path === worktree
    );
    expect(() =>
      takeoverWorktreeClaim({
        action: "reassign",
        approvedBy: "jaay",
        claimId: claim.claimId,
        expectedStatusDigest: current?.changeDigest ?? "",
        newAgentId: "admin-agent",
        reason: "Owner disappeared mid-loop",
        repositoryPath: worktree,
      })
    ).toThrow("active loop lease still requires");
  });

  test("records why a claim was released", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "release-reason");
    git(fixture.root, ["worktree", "add", "-b", "release-reason", worktree]);
    const claim = claimWorktree(fixture.root, "owner", worktree, "codex");

    const released = releaseWorktreeClaim(fixture.root, "owner", claim.claimId);

    expect(released).toMatchObject({
      releaseReason: "owner-release",
      state: "released",
    });
    expect(readWorktreeCoordination(fixture.root).claims[0]).toMatchObject({
      releaseReason: "owner-release",
    });
  });

  test("checks the releasing owner under the coordination lock", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "release-race");
    git(fixture.root, ["worktree", "add", "-b", "release-race", worktree]);
    const claim = claimWorktree(fixture.root, "owner", worktree, "codex");
    const { commonGitDirectory } = captureInventory(fixture.root).repository;
    const coordinationPath = worktreeCoordinationPath(commonGitDirectory);

    // A takeover holds the lock while it reassigns the claim. A release that
    // checked ownership before taking the lock would have accepted the old
    // owner and then released the new owner's claim.
    withWorktreeCoordinationLock(commonGitDirectory, "takeover", () => {
      const document = JSON.parse(readFileSync(coordinationPath, "utf8")) as {
        claims: { owner: { agentId: string } }[];
      };
      for (const item of document.claims) {
        item.owner.agentId = "new-owner";
      }
      writeFileSync(coordinationPath, `${JSON.stringify(document)}\n`);
      expect(() =>
        releaseWorktreeClaim(fixture.root, "owner", claim.claimId)
      ).toThrow("is busy");
    });

    expect(() =>
      releaseWorktreeClaim(fixture.root, "owner", claim.claimId)
    ).toThrow("Only the exact claim owner may release this worktree claim.");
    expect(readWorktreeCoordination(fixture.root).claims[0]).toMatchObject({
      owner: { agentId: "new-owner" },
      state: "active",
    });
    expect(
      releaseWorktreeClaim(fixture.root, "new-owner", claim.claimId)
    ).toMatchObject({ releaseReason: "owner-release", state: "released" });
    expect(() =>
      releaseWorktreeClaim(fixture.root, "new-owner", claim.claimId)
    ).toThrow(
      `Claim ${claim.claimId} cannot transition from released to released.`
    );
  });

  test("records the released state, never evidence from a missing checkout", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "release-evidence");
    git(fixture.root, ["worktree", "add", "-b", "release-evidence", worktree]);
    const claim = claimWorktree(fixture.root, "owner", worktree, "codex");
    writeFixture(worktree, "released.ts", "export const released = true;\n");
    const current = captureInventory(fixture.root).worktrees.find(
      (item) => item.path === worktree
    );

    expect(
      releaseWorktreeClaim(fixture.root, "owner", claim.claimId)
    ).toMatchObject({
      branch: current?.branch,
      changeDigest: current?.changeDigest,
      headSha: current?.headSha,
    });

    // A removed checkout still lists its branch head and an empty status
    // digest; neither is a state its owner released.
    const gone = join(fixture.base, "release-gone");
    git(fixture.root, ["worktree", "add", "-b", "release-gone", gone]);
    const goneClaim = claimWorktree(fixture.root, "owner", gone, "codex");
    writeFixture(gone, "gone.ts", "export const gone = true;\n");
    git(gone, ["add", "gone.ts"]);
    git(gone, ["commit", "-m", "Commit before removal"]);
    rmSync(gone, { force: true, recursive: true });
    expect(
      releaseWorktreeClaim(fixture.root, "owner", goneClaim.claimId)
    ).toMatchObject({
      branch: goneClaim.branch,
      changeDigest: goneClaim.changeDigest,
      headSha: goneClaim.headSha,
      releaseReason: "owner-release",
    });
  });

  test("releases only live non-detached claims whose worktree is gone", () => {
    const fixture = repository();
    const absent = join(fixture.base, "absent-unit");
    const present = join(fixture.base, "present-unit");
    const detached = join(fixture.base, "detached-unit");
    git(fixture.root, ["worktree", "add", "-b", "absent-unit", absent]);
    git(fixture.root, ["worktree", "add", "-b", "present-unit", present]);
    const absentClaim = claimWorktree(fixture.root, "owner", absent, "codex");
    const presentClaim = claimWorktree(fixture.root, "owner", present, "codex");
    const lease = startLoop(fixture.root, "controller", "integrate");
    git(fixture.root, ["worktree", "add", "-b", "detached-unit", detached]);
    const detachedClaim = claimWorktree(
      fixture.root,
      "owner",
      detached,
      "codex"
    );
    const receipt = pauseClaimedWorktree(
      fixture.root,
      "owner",
      detached,
      lease.runId,
      "detach-clean-checkout",
      "Detach for the test."
    );
    detachClaimedWorktree(fixture.root, "owner", detached, receipt.receiptId);
    rmSync(absent, { force: true, recursive: true });
    git(fixture.root, ["worktree", "prune"]);
    const {
      repository: { commonGitDirectory },
    } = captureInventory(fixture.root);

    const released = releaseAbsentWorktreeClaimsUnderLock(
      commonGitDirectory,
      captureInventory(fixture.root),
      "controller"
    );

    expect(released.map((claim) => claim.claimId)).toEqual([
      absentClaim.claimId,
    ]);
    const { claims } = readWorktreeCoordination(fixture.root);
    expect(
      claims.find((claim) => claim.claimId === absentClaim.claimId)
    ).toMatchObject({ releaseReason: "worktree-absent", state: "released" });
    expect(
      claims.find((claim) => claim.claimId === presentClaim.claimId)?.state
    ).toBe("active");
    expect(
      claims.find((claim) => claim.claimId === detachedClaim.claimId)?.state
    ).toBe("detached");
  });

  test("completed-work handoff releases only the author's own claim on the current checkout", () => {
    const fixture = repository();
    const own = join(fixture.base, "handoff-own");
    const other = join(fixture.base, "handoff-other");
    git(fixture.root, ["worktree", "add", "-b", "handoff-own", own]);
    git(fixture.root, ["worktree", "add", "-b", "handoff-other", other]);
    const ownClaim = claimWorktree(fixture.root, "author", own, "claude-code");
    claimWorktree(fixture.root, "someone-else", other, "codex");

    expect(releaseHandoffWorktreeClaim(other, "author")).toBeNull();
    expect(releaseHandoffWorktreeClaim(fixture.root, "author")).toBeNull();
    expect(releaseHandoffWorktreeClaim(own, "author")).toMatchObject({
      claimId: ownClaim.claimId,
      releaseReason: "handoff",
      state: "released",
    });
    expect(releaseHandoffWorktreeClaim(own, "author")).toBeNull();
  });
});
