import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  finalizeLoop,
  loopStatus,
  prepareAgentWorktree,
  readLoopLease,
  recordShipmentOutcome,
  recordShipmentScope,
  recoverLoopLock,
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

function deliveredFixture(
  squash = false,
  excludePrimary = false,
  runCreated = false
) {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  if (runCreated) {
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/repo.git",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
  }
  writeFixture(fixture.root, "personal.txt", "unrelated work\n");
  const author = join(fixture.base, "shipping");
  const authorBranch = "shipping";
  git(fixture.root, ["worktree", "add", "-b", authorBranch, author]);
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
    exclusions: excludePrimary
      ? [
          {
            path: "personal.txt",
            reason: "Outside shipment scope.",
            worktreePath: fixture.root,
          },
        ]
      : preview.exclusions,
    preserved: excludePrimary
      ? []
      : [
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
  const prepared = runCreated
    ? prepareAgentWorktree(author, lease.runId, "delivery-author", "delivery")
    : null;
  git(author, ["add", "feature.txt"]);
  git(author, ["commit", "-m", "Feature"]);
  if (prepared) {
    git(prepared.path, ["merge", "--ff-only", authorBranch]);
  }
  if (runCreated) {
    git(fixture.root, [
      "update-ref",
      "refs/remotes/origin/main",
      git(author, ["rev-parse", "HEAD"]),
    ]);
  } else if (squash) {
    git(fixture.root, ["merge", "--squash", authorBranch]);
    git(fixture.root, ["commit", "-m", "Squash feature"]);
  } else {
    git(fixture.root, ["merge", "--ff-only", authorBranch]);
  }
  const target = git(fixture.root, [
    "rev-parse",
    runCreated ? "origin/main" : "HEAD",
  ]);
  const blob = git(fixture.root, ["rev-parse", `${target}:feature.txt`]);
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
  return { ...fixture, author, lease, outcome, plan, prepared };
}

describe("shipment finalization", () => {
  test("proves delivery for a shipment packaged from a changed primary checkout", () => {
    const fixture = createTestRepository();
    fixtures.push(fixture);
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/repo.git",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    // Shippable work sits uncommitted in the dirty primary next to unrelated work.
    writeFixture(fixture.root, "feature.txt", "draft feature\n");
    writeFixture(fixture.root, "helper.txt", "final helper\n");
    writeFixture(fixture.root, "personal.txt", "unrelated work\n");
    const baselineHead = git(fixture.root, ["rev-parse", "HEAD"]);
    const lease = startLoop(fixture.root, "controller", "ship");
    const opening = captureInventory(fixture.root);
    const preview = buildPreviewPlan(
      opening,
      opening,
      compareSnapshots(opening, opening)
    );
    const plan: ChangePlan = {
      ...preview,
      exclusions: [
        {
          path: "personal.txt",
          reason: "Outside shipment scope.",
          worktreePath: fixture.root,
        },
      ],
      preserved: [],
      units: preview.units
        .map((unit) => ({
          ...unit,
          operations: ["commit"] as ChangePlan["units"][number]["operations"],
          paths: unit.paths.filter((path) => path !== "personal.txt"),
          requiredAuthority: [
            "local-write",
          ] as ChangePlan["units"][number]["requiredAuthority"],
        }))
        .filter((unit) => unit.paths.length > 0),
    };
    recordShipmentScope(fixture.root, lease.runId, "controller", plan);
    const primaryBefore = captureInventory(fixture.root).worktrees.find(
      (item) => item.isPrimary
    );

    // The work is copied into a run-prepared author worktree, where review
    // changes the bytes that actually ship.
    const prepared = prepareAgentWorktree(
      fixture.root,
      lease.runId,
      "delivery-author",
      "delivery"
    );
    writeFixture(prepared.path, "feature.txt", "reviewed feature\n");
    writeFixture(prepared.path, "helper.txt", "final helper\n");
    git(prepared.path, ["add", "feature.txt", "helper.txt"]);
    git(prepared.path, ["commit", "-m", "Reviewed feature"]);
    const reviewed = git(prepared.path, ["rev-parse", "HEAD"]);
    const receiptFor = (target: string): ShipmentOutcomeReceipt => ({
      additionalPaths: [],
      runId: lease.runId,
      schemaVersion: 1,
      targetRevision: target,
      units: plan.units.map((unit) => ({
        disposition: "delivered",
        evidence: ["Review changed the feature before merge."],
        finalPaths: unit.paths.map((path) => ({
          entry: `100644:blob:${git(fixture.root, ["rev-parse", `${target}:${path}`])}`,
          path,
        })),
        originalPaths: [],
        summary: "Reviewed feature integrated",
        unitId: unit.id,
      })),
    });

    // A target holding the reviewed bytes without the primary's history does
    // not prove the primary's work was delivered.
    const orphan = git(fixture.root, [
      "commit-tree",
      `${reviewed}^{tree}`,
      "-m",
      "Rewritten history",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", orphan]);
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        receiptFor(orphan)
      )
    ).toThrow("contained in the bound target");

    git(fixture.root, ["update-ref", "refs/remotes/origin/main", reviewed]);
    // A primary edited after the scope opened cannot launder its edits.
    writeFixture(fixture.root, "feature.txt", "tampered after opening\n");
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        receiptFor(reviewed)
      )
    ).toThrow("does not match its exact opening source result");
    writeFixture(fixture.root, "feature.txt", "draft feature\n");

    recordShipmentOutcome(
      fixture.root,
      lease.runId,
      "controller",
      receiptFor(reviewed)
    );
    const result = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Close the reviewed shipment."
    );
    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.receipt.deliveryStatus).toBe("verified");
    expect(result.cleanup.cleanedPrimaryPaths).toHaveLength(0);
    expect(result.cleanup.primaryUpdated).toBe(false);
    expect(existsSync(prepared.path)).toBe(false);
    expect(readLoopLease(fixture.root)).toBeNull();
    const primaryAfter = captureInventory(fixture.root).worktrees.find(
      (item) => item.isPrimary
    );
    expect(primaryAfter?.changeDigest).toBe(primaryBefore?.changeDigest);
    expect(primaryAfter?.headSha).toBe(baselineHead);
    expect(readFileSync(join(fixture.root, "feature.txt"), "utf8")).toBe(
      "draft feature\n"
    );
    expect(readFileSync(join(fixture.root, "helper.txt"), "utf8")).toBe(
      "final helper\n"
    );
    expect(readFileSync(join(fixture.root, "personal.txt"), "utf8")).toBe(
      "unrelated work\n"
    );
  });

  test("closes exact delivery with explicit exclusions without changing unrelated claims or primary bytes", () => {
    const fixture = deliveredFixture(false, true);
    const otherPath = join(fixture.base, "other-author");
    git(fixture.root, ["worktree", "add", "-b", "other-author", otherPath]);
    claimWorktree(fixture.root, "other", otherPath, "test");
    const claims = readWorktreeCoordination(fixture.root);
    const primaryBefore = captureInventory(fixture.root).worktrees.find(
      (item) => item.isPrimary
    );
    const result = finalizeLoop(
      fixture.author,
      fixture.lease.runId,
      "controller",
      "Close only delivered scope."
    );
    expect(result.outcome).toBe("completed");
    expect(result.receipt.blocksNextShipment).toBe(false);
    expect(result.receipt.deliveryStatus).toBe("verified");
    expect(result.cleanup.cleanedPrimaryPaths).toHaveLength(0);
    expect(result.cleanup.primaryUpdated).toBe(false);
    expect(readWorktreeCoordination(fixture.root)).toEqual(claims);
    const primaryAfter = captureInventory(fixture.root).worktrees.find(
      (item) => item.isPrimary
    );
    expect(primaryAfter?.changeDigest).toBe(primaryBefore?.changeDigest);
    expect(primaryAfter?.headSha).toBe(primaryBefore?.headSha);
    expect(readFileSync(join(fixture.root, "personal.txt"), "utf8")).toBe(
      "unrelated work\n"
    );
    expect(existsSync(otherPath)).toBe(true);
    expect(readLoopLease(fixture.root)).toBeNull();
  });

  test("resumes explicit-exclusion finalization after audited run-created author removal", async () => {
    const fixture = deliveredFixture(false, true, true);
    if (!fixture.prepared) {
      throw new Error("Missing run-created delivery author fixture");
    }
    const removedAuthor = fixture.prepared.path;
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
        `import { finalizeLoop } from ${JSON.stringify(moduleUrl)}; finalizeLoop(${JSON.stringify(fixture.root)}, ${JSON.stringify(fixture.lease.runId)}, "controller", "Crash after audited removal.");`,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          SIMPLE_CHANGES_TEST_CRASH_AFTER_WORKTREE_REMOVE: removedAuthor,
        },
        stdio: ["ignore", "ignore", "pipe"],
      }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const termination = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) =>
      child.once("exit", (code, signal) => resolveExit({ code, signal }))
    );
    expect({ ...termination, stderr }).toEqual({
      code: null,
      signal: "SIGKILL",
      stderr: "",
    });
    expect(existsSync(removedAuthor)).toBe(false);
    expect(readLoopLease(fixture.root)?.dispositions).toContainEqual(
      expect.objectContaining({
        outcome: "remove-after-audit",
        path: removedAuthor,
      })
    );
    await sleep(5100);
    expect(recoverLoopLock(fixture.root, "controller").recovered).toBe(true);
    const result = finalizeLoop(
      fixture.root,
      fixture.lease.runId,
      "controller",
      "Resume exact audited removal."
    );
    expect(result.outcome).toBe("completed");
    expect(result.receipt.deliveryStatus).toBe("verified");
    expect(result.cleanup.cleanedPrimaryPaths).toHaveLength(0);
    expect(result.cleanup.primaryUpdated).toBe(false);
    expect(readFileSync(join(fixture.root, "personal.txt"), "utf8")).toBe(
      "unrelated work\n"
    );
  });

  test("explicit exclusions do not excuse a missing source without removal evidence", () => {
    const fixture = deliveredFixture(false, true);
    git(fixture.root, ["worktree", "remove", fixture.author]);
    const result = finalizeLoop(
      fixture.root,
      fixture.lease.runId,
      "controller",
      "Do not assume removal was safe."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.receipt.deliveryStatus).not.toBe("verified");
    expect(result.receipt.blocksNextShipment).toBe(true);
  });

  test.each(["changed-bytes", "unclassified-path"])(
    "explicit exclusions never accept %s",
    (kind) => {
      const fixture = deliveredFixture(false, true);
      writeFixture(
        fixture.root,
        kind === "changed-bytes" ? "personal.txt" : "extra.txt",
        "new work\n"
      );
      const result = finalizeLoop(
        fixture.author,
        fixture.lease.runId,
        "controller",
        "Preserve changed work."
      );
      expect(result.outcome).toBe("relinquished");
      expect(result.receipt.blocksNextShipment).toBe(true);
      expect(readLoopLease(fixture.root)).not.toBeNull();
    }
  );

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
