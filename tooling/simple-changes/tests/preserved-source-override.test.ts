import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  endLoop,
  finalizeLoop,
  readLoopLease,
  recordShipmentOutcome,
  recordShipmentScope,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import {
  type PreservedSourceOverrideContext,
  preservedSourceOverrideFailure,
  splitShipmentOutcomeInput,
} from "../../../skills/simple-changes/scripts/lib/preserved-source-override.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import type {
  ChangePlan,
  LoopLease,
  LoopOpeningWorktree,
  LoopWorktreeLease,
  PreservedSourceOverrideReceipt,
  PreservedSourceOverrideRecord,
  ShipmentOutcomeInput,
  ShipmentOutcomeReceipt,
  WorktreeClaim,
  WorktreeInventory,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  readWorktreeCoordination,
  withWorktreeCoordinationLock,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// Ported from the Thoronath fork, where this override closed a real shipment.

const SOURCE = "/tmp/fork-author-checkout";
const SOURCE_BRANCH = "codex/messages-layout";
const SOURCE_HEAD = "1".repeat(40);
const TARGET_HEAD = "2".repeat(40);
const SOURCE_DIGEST = "3".repeat(64);
const SOURCE_ENTRY = `100644:blob:${"4".repeat(40)}`;
const TARGET_ENTRY = `100644:blob:${"5".repeat(40)}`;
const PATH = "src/features/messages/messaging-screen.tsx";
const FROZEN_ERROR = /frozen/;
const CLAIM_ERROR = /active author claim/;
const TARGET_ERROR = /target entry changed/;
const PROCESS_ERROR = /process evidence/;
const APPROVAL_ERROR = /manual user approval/;
const PATH_ERROR = /cover every scoped/;
const DIRTY_ERROR = /dirty, claimed/;
const COORDINATION_BUSY = /Worktree coordination state is busy/;

const context = (): PreservedSourceOverrideContext => {
  const current: WorktreeInventory = {
    bare: false,
    branch: SOURCE_BRANCH,
    changeDigest: SOURCE_DIGEST,
    changes: [
      {
        conflicted: false,
        indexStatus: " ",
        originalPath: null,
        path: PATH,
        symlink: false,
        untracked: false,
        worktreePath: SOURCE,
        worktreeStatus: "M",
      },
    ],
    detached: false,
    headSha: SOURCE_HEAD,
    isCurrent: false,
    isPrimary: false,
    locked: false,
    path: SOURCE,
    prunable: false,
  };
  const registered: LoopWorktreeLease = {
    agentId: "author",
    baselineChangeDigest: SOURCE_DIGEST,
    baselineHeadSha: SOURCE_HEAD,
    branch: current.branch,
    claimId: "claim-1",
    createdByRun: false,
    mutationAllowed: true,
    path: SOURCE,
    role: "concurrent-author",
  };
  const opening: LoopOpeningWorktree = {
    branch: current.branch,
    changeDigest: SOURCE_DIGEST,
    headSha: SOURCE_HEAD,
    path: SOURCE,
  };
  const claim: WorktreeClaim = {
    branch: current.branch,
    changeDigest: SOURCE_DIGEST,
    claimId: "claim-1",
    commonGitDirectory: "/tmp/fork-repository.git",
    createdAt: "2026-10-03T00:00:00.000Z",
    headSha: SOURCE_HEAD,
    owner: { adapter: "codex", agentId: "author", ownerRef: null },
    path: SOURCE,
    repositoryId: "fork-repository",
    schemaVersion: 1,
    state: "active",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  const override: PreservedSourceOverrideReceipt = {
    approvalReason: "Preserve the reviewed dirty messaging checkout",
    approvalReference: "codex-thread:user-message-123",
    approvedAt: "2026-10-03T00:15:00.000Z",
    approvedBy: "repository-owner",
    claimId: "claim-1",
    decision: "semantically-equivalent",
    paths: [
      { path: PATH, sourceEntry: SOURCE_ENTRY, targetEntry: TARGET_ENTRY },
    ],
    reviewedAt: "2026-10-03T00:00:00.000Z",
    reviewerAgentId: "independent-reviewer",
    reviewReference: "https://forge.invalid/reviews/123",
    runId: "run-reviewed-source",
    sourceBranch: SOURCE_BRANCH,
    sourceChangeDigest: SOURCE_DIGEST,
    sourceHeadRevision: SOURCE_HEAD,
    sourceWorktree: SOURCE,
    targetRevision: TARGET_HEAD,
    unitId: "messaging",
  };
  return {
    claim,
    controllerAgentId: "controller",
    current,
    disposition: "target-equivalent",
    finalPaths: [{ entry: TARGET_ENTRY, path: PATH }],
    opening,
    openingEntries: new Map([[PATH, SOURCE_ENTRY]]),
    originalPaths: [],
    override,
    registered,
    runId: "run-reviewed-source",
    scopePaths: [PATH],
    sourceEntry: () => SOURCE_ENTRY,
    sourceWorktree: SOURCE,
    targetEntry: () => TARGET_ENTRY,
    targetRevision: TARGET_HEAD,
    unitId: "messaging",
  };
};

const RECORDED_AT = "2026-10-03T00:30:00.000Z";
const failure = (
  snapshot: PreservedSourceOverrideContext,
  recordedAt = RECORDED_AT
) => preservedSourceOverrideFailure(snapshot, recordedAt);

test("accepts a freshly approved preserved dirty source with exact target bytes", () => {
  expect(failure(context())).toBeNull();
});

test("keeps a frozen source valid when only its claim snapshot is stale", () => {
  const snapshot = context();
  if (snapshot.claim) {
    snapshot.claim.headSha = "8".repeat(40);
    snapshot.claim.changeDigest = "9".repeat(64);
  }
  expect(failure(snapshot)).toBeNull();
});

test("splits the structured manual override out of the shipment receipt", () => {
  const snapshot = context();
  if (!snapshot.override) {
    throw new Error("Fixture override missing");
  }
  const unit = {
    disposition: "target-equivalent" as const,
    evidence: ["Independent review compared source and target behavior"],
    finalPaths: [{ entry: TARGET_ENTRY, path: PATH }],
    originalPaths: [],
    summary: "Reviewed equivalent target result",
    unitId: "messaging",
  };
  const input: ShipmentOutcomeInput = {
    additionalPaths: [],
    runId: "run-reviewed-source",
    schemaVersion: 1,
    targetRevision: TARGET_HEAD,
    units: [{ ...unit, preservedSourceOverride: snapshot.override }],
  };
  const split = splitShipmentOutcomeInput(structuredClone(input));
  // The lease keeps the original receipt shape that older clients validate.
  expect(split.receipt).toEqual({ ...input, units: [unit] });
  expect(
    validateSchema<ShipmentOutcomeReceipt>("shipment-outcome", split.receipt)
  ).toEqual(split.receipt);
  expect(split.overrides).toEqual([snapshot.override]);
  expect(() =>
    validateSchema("shipment-outcome", structuredClone(input))
  ).toThrow();

  const invalid = structuredClone(input);
  const [invalidUnit] = invalid.units;
  if (invalidUnit?.preservedSourceOverride) {
    invalidUnit.preservedSourceOverride.sourceChangeDigest = "invalid";
  }
  expect(() => splitShipmentOutcomeInput(invalid)).toThrow();

  const misplaced = structuredClone(input);
  const [misplacedUnit] = misplaced.units;
  if (misplacedUnit?.preservedSourceOverride) {
    misplacedUnit.preservedSourceOverride.unitId = "other-unit";
  }
  expect(() => splitShipmentOutcomeInput(misplaced)).toThrow(
    "must be an object naming that unit"
  );
});

test("rejects source, claim, and target drift after approval", () => {
  const sourceDrift = context();
  if (sourceDrift.current) {
    sourceDrift.current.changeDigest = "6".repeat(64);
  }
  expect(failure(sourceDrift) ?? "").toMatch(FROZEN_ERROR);

  const claimDrift = context();
  if (claimDrift.claim) {
    claimDrift.claim.state = "released";
  }
  expect(failure(claimDrift) ?? "").toMatch(CLAIM_ERROR);

  const targetDrift = context();
  targetDrift.targetEntry = () => `100644:blob:${"7".repeat(40)}`;
  expect(failure(targetDrift) ?? "").toMatch(TARGET_ERROR);

  const bytesDrift = context();
  bytesDrift.sourceEntry = () => `100644:blob:${"7".repeat(40)}`;
  expect(failure(bytesDrift) ?? "").toMatch(TARGET_ERROR);
});

test("rejects invalid process evidence, missing paths, and an unpreserved source", () => {
  const selfReview = context();
  if (selfReview.override) {
    selfReview.override.reviewerAgentId = "author";
  }
  expect(failure(selfReview) ?? "").toMatch(PROCESS_ERROR);

  const missingPath = context();
  if (missingPath.override) {
    missingPath.override.paths = [];
  }
  expect(failure(missingPath) ?? "").toMatch(PATH_ERROR);

  const unpreserved = context();
  if (unpreserved.current) {
    unpreserved.current.changes = [];
  }
  expect(failure(unpreserved) ?? "").toMatch(DIRTY_ERROR);
});

test("rejects missing, stale, premature, or mismatched manual approval", () => {
  const missing = context();
  missing.override = undefined;
  expect(failure(missing) ?? "").toMatch(APPROVAL_ERROR);

  const stale = context();
  if (stale.override) {
    stale.override.approvedAt = "2026-10-02T23:00:00.000Z";
  }
  expect(failure(stale) ?? "").toMatch(APPROVAL_ERROR);

  const premature = context();
  if (premature.override) {
    premature.override.approvedAt = "2026-10-02T23:59:59.000Z";
  }
  expect(failure(premature) ?? "").toMatch(APPROVAL_ERROR);

  const target = context();
  if (target.override) {
    target.override.targetRevision = "6".repeat(40);
  }
  expect(failure(target) ?? "").toMatch(PROCESS_ERROR);

  const unit = context();
  if (unit.override) {
    unit.override.unitId = "other-unit";
  }
  expect(failure(unit) ?? "").toMatch(PROCESS_ERROR);
});

describe("loop record-outcome with a preserved-source override", () => {
  setDefaultTimeout(60_000);
  const repositories: TestRepository[] = [];
  afterEach(() => {
    for (const fixture of repositories) {
      fixture.cleanup();
    }
    repositories.length = 0;
  });

  const equivalentFixture = () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const author = join(fixture.base, "author");
    git(fixture.root, ["worktree", "add", "-b", "author-feature", author]);
    writeFixture(author, "feature.ts", "export const value = 1;\n");
    claimWorktree(author, "author", author, "codex");
    const lease = startLoop(fixture.root, "controller", "ship");
    const opening = captureInventory(fixture.root);
    const preview = buildPreviewPlan(
      opening,
      opening,
      compareSnapshots(opening, opening)
    );
    const plan: ChangePlan = {
      ...preview,
      units: preview.units
        .filter((planned) => planned.sourceWorktree === author)
        .map((planned) => ({
          ...planned,
          operations: ["commit"],
          requiredAuthority: ["local-write"],
        })),
    };
    const [unit] = plan.units;
    if (!unit) {
      throw new Error("Expected the author's unit");
    }
    recordShipmentScope(fixture.root, lease.runId, "controller", plan);
    // The reviewed integration is equivalent but not byte-identical.
    writeFixture(
      fixture.root,
      "feature.ts",
      "// Reviewed form.\nexport const value = 1;\n"
    );
    git(fixture.root, ["add", "feature.ts"]);
    git(fixture.root, ["commit", "-m", "Reviewed feature"]);
    const target = git(fixture.root, ["rev-parse", "HEAD"]);
    const targetEntry = `100644:blob:${git(fixture.root, ["rev-parse", `${target}:feature.ts`])}`;
    const stored = readLoopLease(fixture.root);
    const registered = stored?.worktrees.find((item) => item.path === author);
    const sourceEntry =
      stored?.shipmentScope?.openingChanges.find(
        (change) => change.worktreePath === author
      )?.sourceEntry ?? null;
    const source = captureInventory(fixture.root).worktrees.find(
      (item) => item.path === author
    );
    if (!(registered?.claimId && source?.headSha && source.branch)) {
      throw new Error("Expected a claimed author registration");
    }
    const now = Date.now();
    const override: PreservedSourceOverrideReceipt = {
      approvalReason: "Keep the author's checkout; its reviewed form shipped.",
      approvalReference: "chat:message-1",
      approvedAt: new Date(now - 1000).toISOString(),
      approvedBy: "repository-owner",
      claimId: registered.claimId,
      decision: "semantically-equivalent",
      paths: [{ path: "feature.ts", sourceEntry, targetEntry }],
      reviewedAt: new Date(now - 2000).toISOString(),
      reviewerAgentId: "independent-reviewer",
      reviewReference: "review:feature-equivalence",
      runId: lease.runId,
      sourceBranch: source.branch,
      sourceChangeDigest: source.changeDigest,
      sourceHeadRevision: source.headSha,
      sourceWorktree: author,
      targetRevision: target,
      unitId: unit.id,
    };
    const outcome = (withOverride: boolean): ShipmentOutcomeInput => ({
      additionalPaths: [],
      runId: lease.runId,
      schemaVersion: 1,
      targetRevision: target,
      units: [
        {
          disposition: "target-equivalent",
          evidence: ["Independent review found the target form equivalent."],
          finalPaths: [{ entry: targetEntry, path: "feature.ts" }],
          originalPaths: [],
          ...(withOverride ? { preservedSourceOverride: override } : {}),
          summary: "Reviewed equivalent target result",
          unitId: unit.id,
        },
      ],
    });
    const approval = {
      approvalReference: override.approvalReference,
      approvedBy: override.approvedBy,
    };
    const sidecarPath = join(
      captureInventory(fixture.root).repository.commonGitDirectory,
      "simple-changes",
      "preserved-source-override",
      `${lease.runId}.json`
    );
    return { ...fixture, approval, author, lease, outcome, sidecarPath };
  };

  test("refuses approval flags that are missing, mismatched, or without an override", () => {
    const fixture = equivalentFixture();
    const { lease } = fixture;
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        fixture.outcome(true)
      )
    ).toThrow("manual preserved-source approver");
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        fixture.outcome(true),
        { ...fixture.approval, approvalReference: "chat:other-message" }
      )
    ).toThrow("must match every exact outcome override");
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        fixture.outcome(false),
        fixture.approval
      )
    ).toThrow("require a preserved-source override");
    expect(readLoopLease(fixture.root)?.shipmentOutcome).toBeUndefined();
  });

  test("without an override, a different target form is not the source result", () => {
    const fixture = equivalentFixture();
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        fixture.lease.runId,
        "controller",
        fixture.outcome(false)
      )
    ).toThrow("does not match its exact opening source result");
  });

  test("records the approved override and closes with the author checkout preserved", () => {
    const fixture = equivalentFixture();
    recordShipmentOutcome(
      fixture.root,
      fixture.lease.runId,
      "controller",
      fixture.outcome(true),
      fixture.approval
    );
    const result = finalizeLoop(
      fixture.root,
      fixture.lease.runId,
      "controller",
      "Reviewed equivalent form shipped."
    );
    expect(result.blockers).toEqual([]);
    expect(result.outcome).not.toBe("relinquished");
    expect(readLoopLease(fixture.root)).toBeNull();
    expect(readFileSync(join(fixture.author, "feature.ts"), "utf8")).toBe(
      "export const value = 1;\n"
    );
    expect(
      readWorktreeCoordination(fixture.root).claims.some(
        (claim) => claim.path === fixture.author && claim.state === "active"
      )
    ).toBe(true);
  });

  test("keeps the override beside the lease so older clients can read it", () => {
    const fixture = equivalentFixture();
    recordShipmentOutcome(
      fixture.root,
      fixture.lease.runId,
      "controller",
      fixture.outcome(true),
      fixture.approval
    );
    const lease = readLoopLease(fixture.root) as LoopLease;
    expect(JSON.stringify(lease)).not.toContain("preservedSourceOverride");
    expect(validateSchema<LoopLease>("loop-lease", lease)).toEqual(lease);
    const sidecar = JSON.parse(
      readFileSync(fixture.sidecarPath, "utf8")
    ) as PreservedSourceOverrideRecord;
    expect(sidecar).toMatchObject({
      receiptDigest: lease.shipmentOutcome?.receiptDigest,
      runId: fixture.lease.runId,
      schemaVersion: 1,
    });
    expect(sidecar.overrides).toEqual(
      fixture
        .outcome(true)
        .units.flatMap((unit) =>
          unit.preservedSourceOverride ? [unit.preservedSourceOverride] : []
        )
    );
  });

  test.each(["missing", "mismatched"])(
    "a %s override sidecar keeps the run open",
    (condition) => {
      const fixture = equivalentFixture();
      recordShipmentOutcome(
        fixture.root,
        fixture.lease.runId,
        "controller",
        fixture.outcome(true),
        fixture.approval
      );
      if (condition === "missing") {
        rmSync(fixture.sidecarPath);
      } else {
        const sidecar = JSON.parse(readFileSync(fixture.sidecarPath, "utf8"));
        sidecar.receiptDigest = "0".repeat(64);
        writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));
      }
      const result = finalizeLoop(
        fixture.root,
        fixture.lease.runId,
        "controller",
        "Override evidence is gone."
      );
      expect(result.outcome).toBe("relinquished");
      expect(readFileSync(join(fixture.author, "feature.ts"), "utf8")).toBe(
        "export const value = 1;\n"
      );
    }
  );

  test("a source changed after recording blocks completion", () => {
    const fixture = equivalentFixture();
    recordShipmentOutcome(
      fixture.root,
      fixture.lease.runId,
      "controller",
      fixture.outcome(true),
      fixture.approval
    );
    writeFixture(fixture.author, "feature.ts", "export const value = 2;\n");
    const result = finalizeLoop(
      fixture.root,
      fixture.lease.runId,
      "controller",
      "Source moved after approval."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join(" ")).toContain("changed after recording");
  });

  test("record-outcome and loop end wait for the claim coordination lock", () => {
    const fixture = equivalentFixture();
    const common = captureInventory(fixture.root).repository.commonGitDirectory;
    withWorktreeCoordinationLock(common, "claim transition", () => {
      expect(() =>
        recordShipmentOutcome(
          fixture.root,
          fixture.lease.runId,
          "controller",
          fixture.outcome(true),
          fixture.approval
        )
      ).toThrow(COORDINATION_BUSY);
      expect(() =>
        endLoop(fixture.root, fixture.lease.runId, "controller")
      ).toThrow(COORDINATION_BUSY);
    });
  });
});
