import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  finalizeLoop,
  loopStatus,
  readLoopLease,
  recordShipmentOutcome,
  recordShipmentScope,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import type {
  ChangePlan,
  ShipmentOutcomeReceipt,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  readWorktreeCoordination,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const fixtures: TestRepository[] = [];
setDefaultTimeout(60_000);
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
});

function deliveredFixture(squash = false) {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  writeFixture(fixture.root, "personal.txt", "unrelated work\n");
  const author = join(fixture.base, "shipping");
  git(fixture.root, ["worktree", "add", "-b", "shipping", author]);
  writeFixture(author, "feature.txt", "shipped feature\n");
  const lease = startLoop(author, "controller", "ship");
  const opening = captureInventory(author);
  const current = captureInventory(author);
  const preview = buildPreviewPlan(
    opening,
    current,
    compareSnapshots(opening, current)
  );
  const plan: ChangePlan = {
    ...preview,
    preserved: [
      {
        classification: "paused",
        paths: ["personal.txt"],
        reason: "User's unrelated work stays in place.",
        worktreePath: fixture.root,
      },
    ],
    units: preview.units
      .filter((unit) => unit.sourceWorktree === author)
      .map((unit) => ({
        ...unit,
        operations: ["commit"],
        requiredAuthority: ["local-write"],
      })),
  };
  recordShipmentScope(author, lease.runId, "controller", plan);
  git(author, ["add", "feature.txt"]);
  git(author, ["commit", "-m", "Feature"]);
  if (squash) {
    git(fixture.root, ["merge", "--squash", "shipping"]);
    git(fixture.root, ["commit", "-m", "Squash feature"]);
  } else {
    git(fixture.root, ["merge", "--ff-only", "shipping"]);
  }
  const target = git(fixture.root, ["rev-parse", "HEAD"]);
  const blob = git(fixture.root, ["rev-parse", "HEAD:feature.txt"]);
  const outcome: ShipmentOutcomeReceipt = {
    additionalPaths: [],
    runId: lease.runId,
    schemaVersion: 1,
    targetRevision: target,
    units: plan.units.map((unit) => ({
      disposition: "delivered",
      evidence: ["Target contains the reviewed feature."],
      finalPaths: [{ entry: `100644:blob:${blob}`, path: "feature.txt" }],
      originalPaths: [],
      summary: "Feature integrated",
      unitId: unit.id,
    })),
  };
  recordShipmentOutcome(author, lease.runId, "controller", outcome);
  return { ...fixture, author, lease, outcome, plan };
}

describe("shipment finalization", () => {
  test("closes a verified squash merge while preserving unrelated work", () => {
    const fixture = deliveredFixture(true);
    const result = finalizeLoop(
      fixture.author,
      fixture.lease.runId,
      "controller",
      "Squash merge verified."
    );
    expect(result.outcome).toBe("completed");
    expect(result.receipt.deliveryStatus).toBe("verified");
    expect(readFileSync(join(fixture.root, "personal.txt"), "utf8")).toBe(
      "unrelated work\n"
    );
  });

  test("releases its own delivered source claim and keeps another author's claim", () => {
    const fixture = deliveredFixture();
    const own = claimWorktree(
      fixture.root,
      "controller",
      fixture.author,
      "test"
    );
    const otherPath = join(fixture.base, "other-author");
    git(fixture.root, ["worktree", "add", "-b", "other-author", otherPath]);
    const other = claimWorktree(fixture.root, "other", otherPath, "test");
    const result = finalizeLoop(
      fixture.author,
      fixture.lease.runId,
      "controller",
      "Delivered and verified."
    );
    expect(result.outcome).toBe("completed");
    const { claims } = readWorktreeCoordination(fixture.root);
    expect(claims.find((claim) => claim.claimId === own.claimId)).toMatchObject(
      { releaseReason: "shipped", state: "released" }
    );
    expect(claims.find((claim) => claim.claimId === other.claimId)?.state).toBe(
      "active"
    );
    expect(result.cleanup.releasedClaims).toContainEqual({
      claimId: own.claimId,
      path: fixture.author,
      releaseReason: "shipped",
    });
  });

  test("closes delivered work while preserving unrelated dirty primary state", () => {
    const fixture = deliveredFixture();
    const result = finalizeLoop(
      fixture.author,
      fixture.lease.runId,
      "controller",
      "Finish the delivered unit."
    );
    expect(result.outcome).toBe("completed");
    expect(result.receipt).toMatchObject({
      blocksNextShipment: false,
      controllerStatus: "released",
      deliveryStatus: "verified",
      shipmentStatus: "closed",
    });
    expect(result.receipt.preservedWorktrees).toContain(fixture.root);
    expect(readFileSync(join(fixture.root, "personal.txt"), "utf8")).toBe(
      "unrelated work\n"
    );
    expect(readLoopLease(fixture.root)).toBeNull();
    expect(existsSync(result.receiptPath)).toBe(true);
    const archived = JSON.parse(readFileSync(result.receiptPath, "utf8"));
    expect(archived.lease.shipmentOutcome.receipt).toEqual(fixture.outcome);
    expect(archived.receipt).toEqual(result.receipt);
    expect(
      startLoop(fixture.root, "next-controller", "integrate").runId
    ).not.toBe(fixture.lease.runId);
  });

  test("preserves late clean and dirty worktrees without registering them for cleanup", () => {
    const fixture = deliveredFixture();
    for (const name of ["late-clean", "late-dirty"]) {
      const path = join(fixture.base, name);
      git(fixture.root, ["worktree", "add", "-b", name, path]);
      if (name === "late-dirty") {
        writeFixture(path, "new.txt", "other task\n");
      }
    }
    const result = finalizeLoop(
      fixture.author,
      fixture.lease.runId,
      "controller",
      "Preserve concurrent arrivals."
    );
    expect(result.outcome).toBe("completed");
    for (const name of ["late-clean", "late-dirty"]) {
      expect(existsSync(join(fixture.base, name))).toBe(true);
      expect(result.cleanup.removedWorktrees).not.toContain(
        join(fixture.base, name)
      );
      expect(result.receipt.preservedWorktrees).toContain(
        join(fixture.base, name)
      );
    }
  });

  test("keeps an outcome bound to a stale target open", () => {
    const fixture = deliveredFixture();
    writeFixture(fixture.author, "later.txt", "unaccounted target change\n");
    git(fixture.author, ["add", "later.txt"]);
    git(fixture.author, ["commit", "-m", "Later work"]);
    git(fixture.root, ["merge", "--ff-only", "shipping"]);
    const result = finalizeLoop(
      fixture.author,
      fixture.lease.runId,
      "controller",
      "Target changed."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.receipt).toMatchObject({
      blocksNextShipment: true,
      controllerStatus: "relinquished",
      shipmentStatus: "open",
    });
    expect(result.blockers.join(" ")).toContain("Shipment outcome targets");
  });

  test("directs an authorized agent to resume a relinquished run without takeover approval", () => {
    const fixture = createTestRepository();
    fixtures.push(fixture);
    const lease = startLoop(fixture.root, "first", "ship");
    writeFixture(fixture.root, "unfinished.txt", "unfinished\n");
    finalizeLoop(fixture.root, lease.runId, "first", "Work remains.");
    const { guidance } = loopStatus(fixture.root);
    expect(guidance.nextCommands[0]).toContain("--mode resume");
    expect(guidance.nextCommands[0]).not.toContain("--approved-by");
    expect(startLoop(fixture.root, "second", "resume").ownerAgentId).toBe(
      "second"
    );
  });

  test("keeps new work in a delivered source open even when the primary is clean", () => {
    const fixture = deliveredFixture();
    // Account for the original unrelated file before checking source drift.
    git(fixture.root, ["clean", "-f", "--", "personal.txt"]);
    writeFixture(fixture.author, "unfinished.txt", "new source work\n");
    const result = finalizeLoop(
      fixture.author,
      fixture.lease.runId,
      "controller",
      "Source changed."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join(" ")).toContain("unaccounted source changes");
    expect(readFileSync(join(fixture.author, "unfinished.txt"), "utf8")).toBe(
      "new source work\n"
    );
    expect(readLoopLease(fixture.root)).not.toBeNull();
  });

  test("does not close over changed preserved work or remote destinations", () => {
    const fixture = deliveredFixture();
    writeFixture(fixture.root, "personal.txt", "changed unrelated work\n");
    git(fixture.root, [
      "remote",
      "add",
      "other",
      "https://example.invalid/other.git",
    ]);
    const result = finalizeLoop(
      fixture.author,
      fixture.lease.runId,
      "controller",
      "Preservation evidence changed."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.verification.violations.map((item) => item.code)).toContain(
      "remote-destination-changed"
    );
    expect(result.verification.violations.map((item) => item.code)).toContain(
      "preserved-worktree-changed"
    );
  });
});

function externalTargetFixture(advance = true) {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  writeFixture(fixture.root, "personal.txt", "unrelated work\n");
  const author = join(fixture.base, "ready-author");
  git(fixture.root, ["worktree", "add", "-b", "ready-author", author]);
  writeFixture(author, "feature.txt", "already committed repair\n");
  git(author, ["add", "feature.txt"]);
  git(author, ["commit", "-m", "Reviewed repair"]);
  claimWorktree(fixture.root, "independent-author", author, "test");
  const lease = startLoop(fixture.root, "controller", "ship");
  const inventory = captureInventory(fixture.root);
  const preview = buildPreviewPlan(
    inventory,
    inventory,
    compareSnapshots(inventory, inventory)
  );
  const plan: ChangePlan = {
    ...preview,
    preserved: [
      {
        classification: "paused",
        paths: ["personal.txt"],
        reason: "Preserve unrelated primary work.",
        worktreePath: fixture.root,
      },
    ],
    units: [],
  };
  recordShipmentScope(fixture.root, lease.runId, "controller", plan);
  if (advance) {
    git(fixture.root, ["merge", "--ff-only", "ready-author"]);
  }
  const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
  const outcome: ShipmentOutcomeReceipt = {
    additionalPaths: advance
      ? [
          {
            classification: "external-target-change",
            entry: `100644:blob:${git(fixture.root, ["rev-parse", "HEAD:feature.txt"])}`,
            path: "feature.txt",
            reason:
              "Exact reviewed clean branch merged outside the dirty-path scope.",
          },
        ]
      : [],
    runId: lease.runId,
    schemaVersion: 1,
    targetRevision,
    units: [],
  };
  recordShipmentOutcome(fixture.root, lease.runId, "controller", outcome);
  return { ...fixture, author, lease, outcome };
}

test("reconciled external-only target delivery closes with excluded primary and claims preserved", () => {
  const fixture = externalTargetFixture();
  const claims = readWorktreeCoordination(fixture.root);
  const result = finalizeLoop(
    fixture.root,
    fixture.lease.runId,
    "controller",
    "Reviewed external target delta reconciled."
  );
  expect(result.outcome).toBe("completed");
  expect(result.receipt.deliveryStatus).toBe("verified");
  expect(result.cleanup.releasedClaims).toHaveLength(0);
  expect(readWorktreeCoordination(fixture.root)).toEqual(claims);
  expect(readFileSync(join(fixture.root, "personal.txt"), "utf8")).toBe(
    "unrelated work\n"
  );
  expect(existsSync(fixture.author)).toBe(true);
});

test("empty outcome without target delivery does not close around excluded primary", () => {
  const fixture = externalTargetFixture(false);
  const result = finalizeLoop(
    fixture.root,
    fixture.lease.runId,
    "controller",
    "No verified target delivery."
  );
  expect(result.outcome).toBe("relinquished");
  expect(result.receipt.deliveryStatus).not.toBe("verified");
});

test.each(["target", "excluded-primary"])(
  "external target delivery still blocks %s drift",
  (kind) => {
    const fixture = externalTargetFixture();
    if (kind === "target") {
      git(fixture.root, ["commit", "--allow-empty", "-m", "Later target"]);
    } else {
      writeFixture(fixture.root, "personal.txt", "new unrelated edit\n");
    }
    const result = finalizeLoop(
      fixture.root,
      fixture.lease.runId,
      "controller",
      "Changed evidence must remain open."
    );
    expect(result.outcome).toBe("relinquished");
  }
);

test("external-only outcome refuses wrong target entry before finalization", () => {
  const fixture = externalTargetFixture();
  const invalid = structuredClone(fixture.outcome);
  const [entry] = invalid.additionalPaths;
  if (!entry) {
    throw new Error("Missing fixture entry");
  }
  entry.entry = `100644:blob:${"a".repeat(40)}`;
  expect(() =>
    recordShipmentOutcome(
      fixture.root,
      fixture.lease.runId,
      "controller",
      invalid
    )
  ).toThrow();
});

test.each(["dirty", "unique-commit"])(
  "additional target paths do not bypass %s scoped source",
  (kind) => {
    const fixture = deliveredFixture();
    writeFixture(fixture.root, "release.txt", "external target change\n");
    git(fixture.root, ["add", "release.txt"]);
    git(fixture.root, ["commit", "-m", "Release reconciliation"]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    recordShipmentOutcome(fixture.author, fixture.lease.runId, "controller", {
      ...fixture.outcome,
      additionalPaths: [
        {
          classification: "external-target-change",
          entry: `100644:blob:${git(fixture.root, ["rev-parse", "HEAD:release.txt"])}`,
          path: "release.txt",
          reason: "Reconciled external target delta.",
        },
      ],
      targetRevision,
    });
    writeFixture(fixture.author, "leftover.txt", "unaccounted source work\n");
    if (kind === "unique-commit") {
      git(fixture.author, ["add", "leftover.txt"]);
      git(fixture.author, ["commit", "-m", "Unaccounted source work"]);
    }
    const result = finalizeLoop(
      fixture.author,
      fixture.lease.runId,
      "controller",
      "Scoped source remains outstanding."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.receipt.deliveryStatus).not.toBe("verified");
  }
);
