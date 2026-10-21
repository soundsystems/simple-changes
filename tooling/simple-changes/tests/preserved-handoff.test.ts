import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  acceptPausedWorktreeChange,
  executeLoopMutation,
  finalizeLoop,
  loopLeasePath,
  readLoopLease,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import type {
  LoopLease,
  LoopViolation,
  WorktreeClaim,
  WorktreePauseReceipt,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  pauseClaimedWorktree,
  readWorktreeCoordination,
  releaseHandoffWorktreeClaim,
  releaseWorktreeClaim,
  worktreeCoordinationPath,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// Ownership handoffs of an unchanged adopted-preserved checkout (#3): an
// owner whose pause the controller accepted may release its claim as
// finished work without reclaiming and pausing again.

setDefaultTimeout(120_000);

let repositories: TestRepository[] = [];
afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const commit = (cwd: string, path: string, contents: string): void => {
  writeFixture(cwd, path, contents);
  git(cwd, ["add", path]);
  git(cwd, ["commit", "-m", `Write ${path}`]);
};

interface AcceptedCheckout {
  claim: WorktreeClaim;
  common: string;
  fixture: TestRepository;
  path: string;
  receipt: WorktreePauseReceipt;
  runId: string;
}

/**
 * A run whose controller accepted the exact pause of an owner's clean,
 * committed checkout. With `contained`, the target already holds its head.
 */
const acceptedCheckout = (
  mode: "integrate" | "ship",
  contained = false
): AcceptedCheckout => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  const path = join(fixture.base, "accepted");
  git(fixture.root, ["worktree", "add", "-b", "accepted-work", path]);
  commit(path, "history.ts", "export const history = 1;\n");
  if (contained) {
    git(fixture.root, ["merge", "--ff-only", "accepted-work"]);
  }
  const lease = startLoop(fixture.root, "controller", mode);
  const claim = claimWorktree(path, "owner", path, "claude-code");
  const receipt = pauseClaimedWorktree(
    path,
    "owner",
    path,
    lease.runId,
    "preserve-in-place",
    "Hand the finished checkout to the run."
  );
  acceptPausedWorktreeChange(
    fixture.root,
    lease.runId,
    "controller",
    receipt.receiptId
  );
  expect(readLoopLease(fixture.root)?.worktrees).toContainEqual(
    expect.objectContaining({
      claimId: claim.claimId,
      coordinationState: "adopted-preserved",
      path,
      pauseReceiptId: receipt.receiptId,
      role: "preserved",
    })
  );
  expect(verifyLoop(fixture.root)).toMatchObject({ ok: true, violations: [] });
  return {
    claim,
    common: lease.commonGitDirectory,
    fixture,
    path,
    receipt,
    runId: lease.runId,
  };
};

const violationsAt = (root: string, path: string): LoopViolation[] =>
  verifyLoop(root).violations.filter((violation) => violation.path === path);

const staleAt = (root: string, path: string): LoopViolation[] =>
  violationsAt(root, path).filter(
    (violation) => violation.code === "coordination-claim-stale"
  );

const releaseAs = (
  accepted: AcceptedCheckout,
  reason: "handoff" | "owner-release"
): WorktreeClaim | null =>
  reason === "handoff"
    ? releaseHandoffWorktreeClaim(accepted.path, "owner")
    : releaseWorktreeClaim(
        accepted.fixture.root,
        "owner",
        accepted.claim.claimId
      );

// Freeze the shipment scope, so a new claim is no longer registered as a
// concurrent author and only the pause and accept route records it.
const freezeScope = (accepted: AcceptedCheckout): void => {
  const path = loopLeasePath(accepted.common);
  const stored = JSON.parse(readFileSync(path, "utf8")) as LoopLease;
  stored.shipmentScopeFrozenAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
};

describe("accepted preserved checkouts released as finished work", () => {
  for (const reason of ["owner-release", "handoff"] as const) {
    test(`an exact ${reason} release keeps the adopted link current`, async () => {
      const accepted = acceptedCheckout("ship");
      const { fixture, path } = accepted;
      const before = captureInventory(fixture.root).worktrees.find(
        (worktree) => worktree.path === path
      );
      expect(releaseAs(accepted, reason)).toMatchObject({
        branch: before?.branch,
        changeDigest: before?.changeDigest,
        headSha: before?.headSha,
        releaseReason: reason,
        state: "released",
      });
      expect(verifyLoop(fixture.root)).toMatchObject({
        ok: true,
        violations: [],
      });
      // Unrelated guarded mutations keep running.
      const guarded = await executeLoopMutation(
        fixture.root,
        accepted.runId,
        "controller",
        ["git", "status", "--short"]
      );
      expect(guarded.verification).toMatchObject({ ok: true, violations: [] });
      expect(readLoopLease(fixture.root)?.worktrees).toContainEqual(
        expect.objectContaining({
          claimId: accepted.claim.claimId,
          path,
          pauseReceiptId: accepted.receipt.receiptId,
          role: "preserved",
        })
      );
    });
  }

  test("finalization cleans up a released accepted checkout the target contains", () => {
    const accepted = acceptedCheckout("integrate", true);
    releaseAs(accepted, "owner-release");
    const result = finalizeLoop(
      accepted.fixture.root,
      accepted.runId,
      "controller",
      "Close after the owner handed its checkout back."
    );
    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.cleanup.removedWorktrees).toContain(accepted.path);
    expect(readLoopLease(accepted.fixture.root)).toBeNull();
  });

  test("admits the release only while every recorded fact still matches", () => {
    const accepted = acceptedCheckout("ship");
    const { claim, fixture, path, receipt } = accepted;
    releaseAs(accepted, "owner-release");
    expect(verifyLoop(fixture.root).ok).toBe(true);
    const coordinationPath = worktreeCoordinationPath(accepted.common);
    const original = readFileSync(coordinationPath, "utf8");
    const patched = (
      claimPatch: Record<string, unknown>,
      receiptPatch: Record<string, unknown> = {}
    ): void => {
      const document = JSON.parse(original) as {
        claims: Record<string, unknown>[];
        receipts: Record<string, unknown>[];
      };
      document.claims = document.claims.map((item) =>
        item.claimId === claim.claimId ? { ...item, ...claimPatch } : item
      );
      document.receipts = document.receipts.map((item) =>
        item.receiptId === receipt.receiptId
          ? { ...item, ...receiptPatch }
          : item
      );
      writeFileSync(coordinationPath, `${JSON.stringify(document)}\n`);
    };
    const changedState = `the exact state owner released under claim ${claim.claimId} (owner-release) no longer all match`;
    for (const [claimPatch, receiptPatch, cause] of [
      [
        { releaseReason: "shipped" },
        {},
        `claim ${claim.claimId} of this adopted worktree was released (shipped), which does not hand its work off`,
      ],
      [
        { releaseReason: "takeover" },
        {},
        "was released (takeover), which does not hand its work off",
      ],
      [
        { owner: { ...claim.owner, agentId: "another-agent" } },
        {},
        "the exact state another-agent released",
      ],
      [{ path: join(fixture.base, "elsewhere") }, {}, changedState],
      [{ branch: "another-branch" }, {}, changedState],
      [{ headSha: "0".repeat(40) }, {}, changedState],
      [{ changeDigest: "f".repeat(64) }, {}, changedState],
      [{}, { headSha: "0".repeat(40) }, changedState],
      [{}, { changeDigest: "f".repeat(64) }, changedState],
      [{}, { ownerAgentId: "another-agent" }, changedState],
    ] as const) {
      patched(claimPatch, receiptPatch);
      const stale = staleAt(fixture.root, path);
      expect({ claimPatch, receiptPatch, stale: stale.length }).toEqual({
        claimPatch,
        receiptPatch,
        stale: 1,
      });
      expect(stale[0]?.message).toContain(cause);
    }

    // A release whose event does not show it recorded the present state,
    // as an older client writes it, admits nothing.
    const document = JSON.parse(original) as {
      events: { claimId: string; eventId: string; state: string }[];
    };
    document.events = document.events.map((event) =>
      event.claimId === claim.claimId && event.state === "released"
        ? { ...event, eventId: "event-legacy-release" }
        : event
    );
    writeFileSync(coordinationPath, `${JSON.stringify(document)}\n`);
    expect(staleAt(fixture.root, path)[0]?.message).toContain(
      "without recording the checkout's state at release"
    );

    writeFileSync(coordinationPath, original);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    // A baseline that no longer equals the checkout admits nothing either.
    const leasePath = loopLeasePath(accepted.common);
    const leaseBytes = readFileSync(leasePath, "utf8");
    const lease = JSON.parse(leaseBytes) as LoopLease;
    lease.worktrees = lease.worktrees.map((worktree) =>
      worktree.path === path
        ? { ...worktree, baselineChangeDigest: "f".repeat(64) }
        : worktree
    );
    writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
    expect(violationsAt(fixture.root, path).map(({ code }) => code)).toEqual([
      "preserved-worktree-changed",
      "coordination-claim-stale",
    ]);
    writeFileSync(leasePath, leaseBytes);
    expect(verifyLoop(fixture.root).ok).toBe(true);
  });

  test("a release that recorded a state other than the checkout's stays stale", () => {
    const accepted = acceptedCheckout("ship");
    const { fixture, path } = accepted;
    // The owner edits, releases that edited state, then reverts the edit, so
    // the checkout matches its baseline again but not what was released.
    writeFixture(path, "draft.ts", "export const draft = 1;\n");
    releaseAs(accepted, "owner-release");
    rmSync(join(path, "draft.ts"));
    const stale = violationsAt(fixture.root, path);
    expect(stale.map(({ code }) => code)).toEqual(["coordination-claim-stale"]);
    expect(stale[0]?.message).toContain("no longer all match");
    expect(stale[0]?.message).toContain(
      "If the checkout is passing to a new owner"
    );

    // A change after an exact release is stale too.
    const exact = acceptedCheckout("ship");
    releaseAs(exact, "owner-release");
    writeFixture(exact.path, "late.ts", "export const late = 1;\n");
    expect(
      violationsAt(exact.fixture.root, exact.path).map(({ code }) => code)
    ).toEqual(["preserved-worktree-changed", "coordination-claim-stale"]);
  });

  test("a live claim by another agent after the release stays stale", () => {
    const accepted = acceptedCheckout("ship");
    const { fixture, path } = accepted;
    freezeScope(accepted);
    releaseAs(accepted, "owner-release");
    expect(verifyLoop(fixture.root).ok).toBe(true);
    const next = claimWorktree(path, "next-owner", path, "claude-code");
    const stale = staleAt(fixture.root, path);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.message).toContain(
      `now held by claim ${next.claimId} of next-owner, not by its accepted claim ${accepted.claim.claimId}`
    );
    expect(stale[0]?.nextCommands?.[0]).toContain("--agent-id next-owner");
    // The new owner's own pause, accepted by the controller, records it again.
    const receipt = pauseClaimedWorktree(
      path,
      "next-owner",
      path,
      accepted.runId,
      "preserve-in-place",
      "Take the checkout over as its new owner."
    );
    acceptPausedWorktreeChange(
      fixture.root,
      accepted.runId,
      "controller",
      receipt.receiptId
    );
    expect(verifyLoop(fixture.root)).toMatchObject({
      ok: true,
      violations: [],
    });
    expect(
      readWorktreeCoordination(fixture.root).claims.find(
        (item) => item.claimId === next.claimId
      )?.state
    ).toBe("adopted-preserved");
  });
});
