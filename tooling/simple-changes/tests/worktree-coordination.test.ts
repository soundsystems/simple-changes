import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { statSync } from "node:fs";
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
import {
  attachClaimedWorktree,
  claimWorktree,
  detachClaimedWorktree,
  pauseClaimedWorktree,
  readWorktreeCoordination,
  releaseWorktreeClaim,
  worktreeCoordinationPath,
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
    claimWorktree(preserved, "owner", preserved, "hermes-gateway", "session-1");
    const lease = startLoop(fixture.root, "controller", "reconcile");
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
