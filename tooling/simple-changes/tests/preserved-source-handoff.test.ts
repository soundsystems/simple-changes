import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Json } from "../../../skills/simple-changes/scripts/lib/hash.ts";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  acceptPausedWorktreeChange,
  finalizeLoop,
  readLoopLease,
  recordShipmentOutcome,
  recordShipmentScope,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import {
  type PreservedSourceHandoffContext,
  preservedSourceHandoffFailure,
} from "../../../skills/simple-changes/scripts/lib/preserved-source-handoff.ts";
import {
  recordedPreservedSourceEvidence,
  splitShipmentOutcomeInput,
} from "../../../skills/simple-changes/scripts/lib/preserved-source-override.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import type {
  ChangePlan,
  LoopLease,
  PreservedSourceHandoffReceipt,
  PreservedSourceHandoffRecord,
  PreservedSourceOverrideReceipt,
  ShipmentOutcomeInput,
  WorktreeInventory,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  pauseClaimedWorktree,
  readWorktreeCoordination,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// A run keeps a dirty, detached source in place under its original owner's
// claim and accepted preserve-in-place pause, while a committed copy of its
// exact bytes plus independently reviewed docs ship to the target.

const SOURCE = "/tmp/detached-source";
const SOURCE_HEAD = "1".repeat(40);
const TARGET_HEAD = "2".repeat(40);
const COPY_HEAD = "a".repeat(40);
const OPENING_TARGET = "b".repeat(40);
const SOURCE_DIGEST = "3".repeat(64);
const CODE_ENTRY = `100644:blob:${"4".repeat(40)}`;
const DOCS_SOURCE_ENTRY = `100644:blob:${"5".repeat(40)}`;
const DOCS_TARGET_ENTRY = `100644:blob:${"6".repeat(40)}`;
const COMMON = "/tmp/detached-repository.git";
const RUN_ID = "run-detached-handoff";
const RUN_STARTED_AT = "2026-10-03T00:00:00.000Z";
const RECORDED_AT = "2026-10-03T00:30:00.000Z";

const MISSING_ERROR = /approval for the preserved-source handoff is missing/;
const REGISTRATION_ERROR = /registered as preserved through an accepted pause/;
const FROZEN_ERROR = /exact opening and accepted branch/;
const PAUSE_ERROR = /accepted preserve-in-place pause/;
const CLAIM_ERROR = /original owner's accepted claim/;
const OWNER_ERROR = /different owner/;
const APPROVAL_ERROR = /approval to keep the source in place/;
const REVIEW_ERROR = /independent review of the handed-off/;
const BINDING_ERROR = /does not bind this exact run/;
const PATH_ERROR = /cover every scoped path/;
const SOURCE_ERROR = /preserved source entry changed/;
const COPY_ERROR = /does not hold the preserved source bytes/;
const TARGET_ERROR = /no longer holds the reviewed entry/;
const PROVENANCE_ERROR = /changes only this unit's scoped paths/;
const DELIVERED_ERROR = /not a commit this run delivered/;

const sourceEntries = new Map([
  ["docs.md", DOCS_SOURCE_ENTRY],
  ["feature.ts", CODE_ENTRY],
]);
const targetEntries = new Map([
  ["docs.md", DOCS_TARGET_ENTRY],
  ["feature.ts", CODE_ENTRY],
]);

const context = (): PreservedSourceHandoffContext => {
  const current: WorktreeInventory = {
    bare: false,
    branch: null,
    changeDigest: SOURCE_DIGEST,
    changes: [...sourceEntries.keys()].map((path) => ({
      conflicted: false,
      indexStatus: "?",
      originalPath: null,
      path,
      symlink: false,
      untracked: true,
      worktreePath: SOURCE,
      worktreeStatus: "?",
    })),
    detached: true,
    headSha: SOURCE_HEAD,
    isCurrent: false,
    isPrimary: false,
    locked: false,
    path: SOURCE,
    prunable: false,
  };
  const handoff: PreservedSourceHandoffReceipt = {
    approvalReason: "Keep the original detached source; its copy shipped.",
    approvalReference: "chat:user-message-7",
    approvedAt: "2026-10-03T00:20:00.000Z",
    approvedBy: "repository-owner",
    claimId: "claim-1",
    copyRevision: COPY_HEAD,
    decision: "reviewed-handoff",
    ownerAgentId: "owner",
    paths: [...sourceEntries].map(([path, entry]) => ({
      copyEntry: entry,
      path,
      sourceEntry: entry,
      targetEntry: targetEntries.get(path) ?? null,
    })),
    pauseReceiptId: "pause-1",
    preservation: "keep-source-in-place",
    reviewedAt: "2026-10-03T00:10:00.000Z",
    reviewerAgentId: "independent-reviewer",
    reviewReference: "review:docs-integration",
    runId: RUN_ID,
    sourceBranch: null,
    sourceChangeDigest: SOURCE_DIGEST,
    sourceHeadRevision: SOURCE_HEAD,
    sourceWorktree: SOURCE,
    targetRevision: TARGET_HEAD,
    unitId: "workflow",
  };
  return {
    claim: {
      branch: null,
      changeDigest: SOURCE_DIGEST,
      claimId: "claim-1",
      commonGitDirectory: COMMON,
      createdAt: "2026-10-02T23:00:00.000Z",
      headSha: SOURCE_HEAD,
      owner: { adapter: "claude-code", agentId: "owner", ownerRef: null },
      path: SOURCE,
      repositoryId: "detached-repository",
      schemaVersion: 1,
      state: "adopted-preserved",
      updatedAt: "2026-10-03T00:05:00.000Z",
    },
    commonGitDirectory: COMMON,
    controllerAgentId: "controller",
    copy: {
      changedPaths: () => [...sourceEntries.keys()],
      containedInOpeningTarget: () => false,
      containedInTarget: () => true,
      entry: (path) => sourceEntries.get(path) ?? null,
    },
    current,
    disposition: "delivered",
    finalPaths: [...targetEntries].map(([path, entry]) => ({ entry, path })),
    handoff,
    opening: {
      branch: null,
      changeDigest: SOURCE_DIGEST,
      headSha: SOURCE_HEAD,
      path: SOURCE,
    },
    openingEntries: new Map(sourceEntries),
    originalPaths: [],
    pauseReceipt: {
      acknowledgedAt: "2026-10-03T00:05:00.000Z",
      branch: null,
      changeDigest: SOURCE_DIGEST,
      claimId: "claim-1",
      disposition: "preserve-in-place",
      headSha: SOURCE_HEAD,
      ownerAgentId: "owner",
      path: SOURCE,
      reason: "Preserve the original detached source.",
      receiptId: "pause-1",
      requestingRunId: RUN_ID,
      schemaVersion: 1,
    },
    registered: {
      agentId: null,
      baselineChangeDigest: SOURCE_DIGEST,
      baselineHeadSha: SOURCE_HEAD,
      branch: null,
      claimId: "claim-1",
      coordinationState: "adopted-preserved",
      createdByRun: false,
      mutationAllowed: false,
      path: SOURCE,
      pauseReceiptId: "pause-1",
      role: "preserved",
    },
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    scopePaths: [...sourceEntries.keys()],
    sourceEntry: (path) => sourceEntries.get(path) ?? null,
    sourceWorktree: SOURCE,
    targetEntry: (path) => targetEntries.get(path) ?? null,
    targetRevision: TARGET_HEAD,
    unitId: "workflow",
  };
};

const failure = (snapshot: PreservedSourceHandoffContext): string =>
  preservedSourceHandoffFailure(snapshot, RECORDED_AT) ?? "";

const edited = (
  edit: (snapshot: PreservedSourceHandoffContext) => void
): string => {
  const snapshot = context();
  edit(snapshot);
  return failure(snapshot);
};

const editHandoff = (
  edit: (handoff: PreservedSourceHandoffReceipt) => void
): string =>
  edited((snapshot) => {
    if (snapshot.handoff) {
      edit(snapshot.handoff);
    }
  });

describe("preserved-source handoff evidence", () => {
  test("accepts a detached source under its owner's accepted pause with an exact copy and reviewed target", () => {
    expect(preservedSourceHandoffFailure(context(), RECORDED_AT)).toBeNull();
  });

  test("accepts a source on a branch held the same way", () => {
    const snapshot = context();
    for (const record of [
      snapshot.current,
      snapshot.claim,
      snapshot.opening,
      snapshot.pauseReceipt,
      snapshot.registered,
    ]) {
      if (record) {
        record.branch = "workflow-source";
      }
    }
    if (snapshot.handoff && snapshot.current) {
      snapshot.handoff.sourceBranch = "workflow-source";
      snapshot.current.detached = false;
    }
    expect(preservedSourceHandoffFailure(snapshot, RECORDED_AT)).toBeNull();
  });

  test("refuses a source that is not an accepted, dirty, preserved registration", () => {
    expect(
      edited((snapshot) => {
        snapshot.handoff = undefined;
      })
    ).toMatch(MISSING_ERROR);
    expect(
      edited((snapshot) => {
        snapshot.disposition = "target-equivalent";
      })
    ).toMatch(REGISTRATION_ERROR);
    expect(
      edited((snapshot) => {
        if (snapshot.registered) {
          snapshot.registered.role = "concurrent-author";
        }
      })
    ).toMatch(REGISTRATION_ERROR);
    expect(
      edited((snapshot) => {
        if (snapshot.registered) {
          snapshot.registered.createdByRun = true;
        }
      })
    ).toMatch(REGISTRATION_ERROR);
    expect(
      edited((snapshot) => {
        if (snapshot.registered) {
          snapshot.registered.coordinationState = "resume-ready";
        }
      })
    ).toMatch(REGISTRATION_ERROR);
    expect(
      edited((snapshot) => {
        if (snapshot.current) {
          snapshot.current.changes = [];
        }
      })
    ).toMatch(REGISTRATION_ERROR);
    expect(
      edited((snapshot) => {
        if (snapshot.current) {
          snapshot.current.isPrimary = true;
        }
      })
    ).toMatch(REGISTRATION_ERROR);
    // A renamed source file's original path is outside the scope, so its
    // removal could never be shown to ship.
    expect(
      edited((snapshot) => {
        const [first] = snapshot.current?.changes ?? [];
        if (first) {
          first.originalPath = "old-feature.ts";
        }
      })
    ).toMatch(REGISTRATION_ERROR);
  });

  test("refuses a dirty source that changed after the pause", () => {
    expect(
      edited((snapshot) => {
        if (snapshot.current) {
          snapshot.current.changeDigest = "7".repeat(64);
        }
      })
    ).toMatch(FROZEN_ERROR);
    expect(
      edited((snapshot) => {
        if (snapshot.current) {
          snapshot.current.headSha = "8".repeat(40);
        }
      })
    ).toMatch(FROZEN_ERROR);
    expect(
      edited((snapshot) => {
        if (snapshot.current) {
          snapshot.current.branch = "moved";
        }
      })
    ).toMatch(FROZEN_ERROR);
    expect(
      edited((snapshot) => {
        snapshot.sourceEntry = () => `100644:blob:${"9".repeat(40)}`;
      })
    ).toMatch(SOURCE_ERROR);
  });

  test("refuses a pause that is not this run's accepted preserve-in-place pause", () => {
    for (const edit of [
      (receipt: NonNullable<PreservedSourceHandoffContext["pauseReceipt"]>) => {
        receipt.requestingRunId = "run-another";
      },
      (receipt: NonNullable<PreservedSourceHandoffContext["pauseReceipt"]>) => {
        receipt.disposition = "detach-clean-checkout";
      },
      (receipt: NonNullable<PreservedSourceHandoffContext["pauseReceipt"]>) => {
        receipt.changeDigest = "7".repeat(64);
      },
    ]) {
      expect(
        edited((snapshot) => {
          if (snapshot.pauseReceipt) {
            edit(snapshot.pauseReceipt);
          }
        })
      ).toMatch(PAUSE_ERROR);
    }
    expect(
      edited((snapshot) => {
        snapshot.pauseReceipt = undefined;
      })
    ).toMatch(CLAIM_ERROR);
  });

  test("refuses a different owner and fake ownership", () => {
    expect(
      editHandoff((handoff) => {
        handoff.ownerAgentId = "another-owner";
      })
    ).toMatch(OWNER_ERROR);
    // A claim reassigned to someone else no longer matches the owner's pause.
    expect(
      edited((snapshot) => {
        if (snapshot.claim) {
          snapshot.claim.owner = {
            adapter: "claude-code",
            agentId: "another-owner",
            ownerRef: null,
          };
        }
      })
    ).toMatch(OWNER_ERROR);
    // The controller cannot stand in as the source's owner.
    expect(
      edited((snapshot) => {
        if (snapshot.claim && snapshot.pauseReceipt && snapshot.handoff) {
          snapshot.claim.owner.agentId = "controller";
          snapshot.pauseReceipt.ownerAgentId = "controller";
          snapshot.handoff.ownerAgentId = "controller";
          snapshot.handoff.approvedBy = "repository-owner";
        }
      })
    ).toMatch(OWNER_ERROR);
    // An unreadable run start cannot show the claim is older.
    expect(
      edited((snapshot) => {
        snapshot.runStartedAt = "not a time";
      })
    ).toMatch(CLAIM_ERROR);
    // A claim taken after the run started is not the original owner's.
    expect(
      edited((snapshot) => {
        if (snapshot.claim) {
          snapshot.claim.createdAt = "2026-10-03T00:01:00.000Z";
        }
      })
    ).toMatch(CLAIM_ERROR);
    for (const state of ["active", "paused", "released"] as const) {
      expect(
        edited((snapshot) => {
          if (snapshot.claim) {
            snapshot.claim.state = state;
          }
        })
      ).toMatch(CLAIM_ERROR);
    }
    expect(
      edited((snapshot) => {
        snapshot.claim = undefined;
      })
    ).toMatch(CLAIM_ERROR);
  });

  test("refuses missing, stale, premature, or self-given preservation approval", () => {
    for (const edit of [
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.approvedBy = " ";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.approvedBy = "controller ";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.approvedBy = "owner";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.approvalReference = "";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.approvedAt = "2026-10-03T00:05:00.000Z";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.approvedAt = "2026-10-02T23:20:00.000Z";
        handoff.reviewedAt = "2026-10-02T23:10:00.000Z";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.approvedAt = "2026-10-03T00:40:00.000Z";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        (handoff as { preservation: string }).preservation = "discard";
      },
    ]) {
      expect(editHandoff(edit)).toMatch(APPROVAL_ERROR);
    }
  });

  test("refuses missing or dependent review of the semantic target entries", () => {
    for (const edit of [
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.reviewerAgentId = "";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.reviewerAgentId = " controller";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.reviewerAgentId = "owner";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.reviewReference = " ";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        (handoff as { decision: string }).decision = "semantically-equivalent";
      },
    ]) {
      expect(editHandoff(edit)).toMatch(REVIEW_ERROR);
    }
    // A semantic entry left out of the reviewed paths was never reviewed.
    expect(
      editHandoff((handoff) => {
        handoff.paths = handoff.paths.filter((item) => item.path !== "docs.md");
      })
    ).toMatch(PATH_ERROR);
  });

  test("refuses a handoff bound to another run, unit, claim, pause, source, or target", () => {
    for (const edit of [
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.runId = "run-another";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.unitId = "another-unit";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.claimId = "claim-2";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.pauseReceiptId = "pause-2";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.sourceBranch = "workflow-source";
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.sourceChangeDigest = "7".repeat(64);
      },
      (handoff: PreservedSourceHandoffReceipt) => {
        handoff.targetRevision = "8".repeat(40);
      },
    ]) {
      expect(editHandoff(edit)).toMatch(BINDING_ERROR);
    }
  });

  test("refuses a copy whose bytes differ from the source", () => {
    // The copy commit holds other bytes than the receipt claims.
    expect(
      edited((snapshot) => {
        snapshot.copy = {
          ...snapshot.copy,
          entry: (path) =>
            path === "feature.ts"
              ? `100644:blob:${"9".repeat(40)}`
              : (sourceEntries.get(path) ?? null),
        };
      })
    ).toMatch(COPY_ERROR);
    // The receipt itself records a copy that differs from the source.
    expect(
      editHandoff((handoff) => {
        const [first] = handoff.paths;
        if (first) {
          first.copyEntry = DOCS_TARGET_ENTRY;
        }
      })
    ).toMatch(COPY_ERROR);
  });

  test("refuses a target that no longer holds the reviewed entries", () => {
    expect(
      edited((snapshot) => {
        snapshot.targetEntry = (path) =>
          path === "docs.md"
            ? `100644:blob:${"9".repeat(40)}`
            : (targetEntries.get(path) ?? null);
      })
    ).toMatch(TARGET_ERROR);
    expect(
      edited((snapshot) => {
        snapshot.finalPaths = snapshot.finalPaths.map((item) =>
          item.path === "docs.md"
            ? { ...item, entry: `100644:blob:${"9".repeat(40)}` }
            : item
        );
      })
    ).toMatch(TARGET_ERROR);
  });

  test("refuses a copy commit with unrelated changes or that this run did not deliver", () => {
    expect(
      edited((snapshot) => {
        snapshot.copy = {
          ...snapshot.copy,
          changedPaths: () => ["feature.ts", "README.md"],
        };
      })
    ).toMatch(PROVENANCE_ERROR);
    expect(
      edited((snapshot) => {
        snapshot.copy = { ...snapshot.copy, changedPaths: () => null };
      })
    ).toMatch(PROVENANCE_ERROR);
    expect(
      edited((snapshot) => {
        snapshot.copy = { ...snapshot.copy, containedInTarget: () => false };
      })
    ).toMatch(DELIVERED_ERROR);
    expect(
      edited((snapshot) => {
        snapshot.copy = {
          ...snapshot.copy,
          containedInOpeningTarget: () => true,
        };
      })
    ).toMatch(DELIVERED_ERROR);
    expect(OPENING_TARGET).not.toBe(COPY_HEAD);
  });
});

describe("splitting preserved-source handoffs out of an outcome", () => {
  const unit = {
    disposition: "delivered" as const,
    evidence: ["Copy commit and reviewed docs shipped."],
    finalPaths: [...targetEntries].map(([path, entry]) => ({ entry, path })),
    originalPaths: [],
    summary: "Delivered the detached workflow source",
    unitId: "workflow",
  };
  const input = (): ShipmentOutcomeInput => ({
    additionalPaths: [],
    runId: RUN_ID,
    schemaVersion: 1,
    targetRevision: TARGET_HEAD,
    units: [
      {
        ...unit,
        preservedSourceHandoff: context()
          .handoff as PreservedSourceHandoffReceipt,
      },
    ],
  });

  test("keeps the original receipt shape and digests the complete receipt", () => {
    const split = splitShipmentOutcomeInput(structuredClone(input()));
    expect(split.receipt).toEqual({ ...input(), units: [unit] });
    expect(split.handoffs).toEqual([
      context().handoff as PreservedSourceHandoffReceipt,
    ]);
    expect(split.overrides).toEqual([]);
    expect(split.receiptDigest).toBe(sha256Json(input()));
    expect(() =>
      validateSchema("shipment-outcome", structuredClone(input()))
    ).toThrow();
  });

  test("refuses an invalid, misplaced, or doubled handoff", () => {
    const invalid = input();
    const [invalidUnit] = invalid.units;
    if (invalidUnit?.preservedSourceHandoff) {
      invalidUnit.preservedSourceHandoff.copyRevision = "not-a-commit";
    }
    expect(() => splitShipmentOutcomeInput(invalid)).toThrow();

    const misplaced = input();
    const [misplacedUnit] = misplaced.units;
    if (misplacedUnit?.preservedSourceHandoff) {
      misplacedUnit.preservedSourceHandoff.unitId = "other-unit";
    }
    expect(() => splitShipmentOutcomeInput(misplaced)).toThrow(
      "the preservedSourceHandoff on unit workflow must be an object naming that unit"
    );

    const doubled = input();
    const [doubledUnit] = doubled.units;
    if (doubledUnit) {
      doubledUnit.preservedSourceOverride = {
        unitId: "workflow",
      } as PreservedSourceOverrideReceipt;
    }
    expect(() => splitShipmentOutcomeInput(doubled)).toThrow(
      "a preservedSourceOverride or a preservedSourceHandoff, not both"
    );
  });
});

describe("loop record-outcome with a detached preserved-source handoff", () => {
  setDefaultTimeout(120_000);
  const repositories: TestRepository[] = [];
  afterEach(() => {
    for (const fixture of repositories) {
      fixture.cleanup();
    }
    repositories.length = 0;
  });

  const commitAll = (cwd: string, message: string): string => {
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-m", message]);
    return git(cwd, ["rev-parse", "HEAD"]);
  };

  const ORIGINAL_DOCS = "# Workflow\n\nOriginal notes.\n";
  const REVIEWED_DOCS = "# Workflow\n\nReviewed notes.\n";
  const FEATURE = "export const workflow = 1;\n";

  /**
   * The original owner claims a dirty detached checkout, the run starts and
   * scopes it, and the owner pauses it in place for the run, which accepts
   * the pause. The run commits an exact copy of its bytes on the target, then
   * an independently reviewed docs change.
   */
  const handoffFixture = (
    options: { copyDocs?: string; copyExtra?: boolean; rename?: boolean } = {}
  ) => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "docs.md", "# Workflow\n");
    commitAll(fixture.root, "Docs baseline");
    const source = join(fixture.base, "detached-source");
    git(fixture.root, ["worktree", "add", "--detach", source]);
    writeFixture(source, "feature.ts", FEATURE);
    writeFixture(source, "docs.md", ORIGINAL_DOCS);
    if (options.rename) {
      git(source, ["mv", "README.md", "GUIDE.md"]);
    }
    const claim = claimWorktree(source, "owner", source, "claude-code");
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
        .filter((planned) => planned.sourceWorktree === source)
        .map((planned) => ({
          ...planned,
          operations: ["commit"],
          requiredAuthority: ["local-write"],
        })),
    };
    const [unit, ...otherUnits] = plan.units;
    if (!unit || otherUnits.length > 0) {
      throw new Error("Expected one unit for the detached source");
    }
    recordShipmentScope(fixture.root, lease.runId, "controller", plan);
    const pause = pauseClaimedWorktree(
      source,
      "owner",
      source,
      lease.runId,
      "preserve-in-place",
      "Keep the original detached source for its owner."
    );
    acceptPausedWorktreeChange(
      fixture.root,
      lease.runId,
      "controller",
      pause.receiptId
    );
    // The run's byte-bound committed copy, then the reviewed docs.
    writeFixture(fixture.root, "feature.ts", FEATURE);
    writeFixture(fixture.root, "docs.md", options.copyDocs ?? ORIGINAL_DOCS);
    if (options.copyExtra) {
      writeFixture(fixture.root, "README.md", "# Fixture, copied\n");
    }
    if (options.rename) {
      // The copy adds the renamed file but keeps the original in place.
      writeFixture(fixture.root, "GUIDE.md", "# Fixture\n");
    }
    const copy = commitAll(fixture.root, "Copy the detached source");
    writeFixture(fixture.root, "docs.md", REVIEWED_DOCS);
    const target = commitAll(fixture.root, "Integrate reviewed docs");
    const entryAt = (revision: string, path: string): string =>
      `100644:blob:${git(fixture.root, ["rev-parse", `${revision}:${path}`])}`;
    const stored = readLoopLease(fixture.root) as LoopLease;
    const openingEntry = (path: string): string | null =>
      stored.shipmentScope?.openingChanges.find(
        (change) => change.worktreePath === source && change.path === path
      )?.sourceEntry ?? null;
    const current = captureInventory(fixture.root).worktrees.find(
      (item) => item.path === source
    );
    if (!current?.headSha) {
      throw new Error("Expected the detached source checkout");
    }
    const now = Date.now();
    const handoff: PreservedSourceHandoffReceipt = {
      approvalReason: "Keep the original detached source in place.",
      approvalReference: "chat:message-1",
      approvedAt: new Date(now - 1000).toISOString(),
      approvedBy: "repository-owner",
      claimId: claim.claimId,
      copyRevision: copy,
      decision: "reviewed-handoff",
      ownerAgentId: "owner",
      paths: unit.paths.map((path) => ({
        copyEntry: openingEntry(path),
        path,
        sourceEntry: openingEntry(path),
        targetEntry: entryAt(target, path),
      })),
      pauseReceiptId: pause.receiptId,
      preservation: "keep-source-in-place",
      reviewedAt: new Date(now - 2000).toISOString(),
      reviewerAgentId: "independent-reviewer",
      reviewReference: "review:docs-integration",
      runId: lease.runId,
      sourceBranch: current.branch,
      sourceChangeDigest: current.changeDigest,
      sourceHeadRevision: current.headSha,
      sourceWorktree: source,
      targetRevision: target,
      unitId: unit.id,
    };
    const outcome = (
      withHandoff: PreservedSourceHandoffReceipt | null = handoff,
      finalTarget = target
    ): ShipmentOutcomeInput => ({
      additionalPaths: options.copyExtra
        ? [
            {
              classification: "external-target-change",
              entry: entryAt(finalTarget, "README.md"),
              path: "README.md",
              reason: "Copied alongside the source.",
            },
          ]
        : [],
      runId: lease.runId,
      schemaVersion: 1,
      targetRevision: finalTarget,
      units: [
        {
          disposition: "delivered",
          evidence: ["The copy commit and the reviewed docs reached main."],
          finalPaths: unit.paths.map((path) => ({
            entry: entryAt(finalTarget, path),
            path,
          })),
          originalPaths: [],
          ...(withHandoff ? { preservedSourceHandoff: withHandoff } : {}),
          summary: "Delivered the detached workflow source",
          unitId: unit.id,
        },
      ],
    });
    const approval = {
      approvalReference: handoff.approvalReference,
      approvedBy: handoff.approvedBy,
    };
    const common = captureInventory(fixture.root).repository.commonGitDirectory;
    const sidecarPath = join(
      common,
      "simple-changes",
      "preserved-source-handoff",
      `${lease.runId}.json`
    );
    const record = (input = outcome()) =>
      recordShipmentOutcome(
        fixture.root,
        lease.runId,
        "controller",
        input,
        approval
      );
    return {
      ...fixture,
      approval,
      claim,
      common,
      handoff,
      lease,
      outcome,
      record,
      sidecarPath,
      source,
      target,
    };
  };

  type Fixture = ReturnType<typeof handoffFixture>;

  const expectSourcePreserved = (fixture: Fixture): void => {
    expect(readFileSync(join(fixture.source, "docs.md"), "utf8")).toBe(
      ORIGINAL_DOCS
    );
    expect(readFileSync(join(fixture.source, "feature.ts"), "utf8")).toBe(
      FEATURE
    );
    expect(
      readWorktreeCoordination(fixture.root).claims.find(
        (claim) => claim.claimId === fixture.claim.claimId
      )?.state
    ).toBe("adopted-preserved");
  };

  test("accounts the detached handoff as delivered and keeps the source in place", () => {
    const fixture = handoffFixture();
    fixture.record();
    const lease = readLoopLease(fixture.root) as LoopLease;
    // The lease keeps the shape older clients validate; the handoff lives in
    // its own sidecar, and the digest covers the complete receipt.
    expect(JSON.stringify(lease)).not.toContain("preservedSourceHandoff");
    expect(validateSchema<LoopLease>("loop-lease", lease)).toEqual(lease);
    expect(lease.shipmentOutcome?.receiptDigest).toBe(
      sha256Json(fixture.outcome())
    );
    const sidecar = JSON.parse(
      readFileSync(fixture.sidecarPath, "utf8")
    ) as PreservedSourceHandoffRecord;
    expect(sidecar).toEqual({
      handoffs: [fixture.handoff],
      receiptDigest: lease.shipmentOutcome?.receiptDigest ?? "",
      runId: fixture.lease.runId,
      schemaVersion: 1,
    });
    expect(
      existsSync(
        join(
          fixture.common,
          "simple-changes",
          "preserved-source-override",
          `${fixture.lease.runId}.json`
        )
      )
    ).toBe(false);
    const result = finalizeLoop(
      fixture.root,
      fixture.lease.runId,
      "controller",
      "Copy and reviewed docs shipped; the original source stays."
    );
    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.receipt.deliveryStatus).toBe("verified");
    expect(readLoopLease(fixture.root)).toBeNull();
    expectSourcePreserved(fixture);
  });

  test("without a handoff, the reviewed docs are not the source result", () => {
    const fixture = handoffFixture();
    expect(() => fixture.record(fixture.outcome(null))).toThrow(
      "Manual approval flags require a preserved-source override or handoff"
    );
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        fixture.lease.runId,
        "controller",
        fixture.outcome(null)
      )
    ).toThrow("does not match its exact opening source result for docs.md");
  });

  test("refuses missing or mismatched approval flags", () => {
    const fixture = handoffFixture();
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        fixture.lease.runId,
        "controller",
        fixture.outcome()
      )
    ).toThrow("manual preserved-source approver");
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        fixture.lease.runId,
        "controller",
        fixture.outcome(),
        { ...fixture.approval, approvalReference: "chat:other" }
      )
    ).toThrow("must match every exact outcome override and handoff");
    expect(readLoopLease(fixture.root)?.shipmentOutcome).toBeUndefined();
  });

  test("refuses a different owner", () => {
    const fixture = handoffFixture();
    expect(() =>
      fixture.record(
        fixture.outcome({ ...fixture.handoff, ownerAgentId: "someone-else" })
      )
    ).toThrow(OWNER_ERROR);
  });

  test("refuses a source changed after the pause", () => {
    const fixture = handoffFixture();
    writeFixture(fixture.source, "docs.md", "# Workflow\n\nEdited later.\n");
    expect(() => fixture.record()).toThrow(FROZEN_ERROR);
  });

  test("refuses a copy whose bytes differ", () => {
    const fixture = handoffFixture({
      copyDocs: "# Workflow\n\nOriginal notes, retyped.\n",
    });
    expect(() => fixture.record()).toThrow(COPY_ERROR);
  });

  test("refuses a copy commit that carries unrelated changes", () => {
    const fixture = handoffFixture({ copyExtra: true });
    expect(() => fixture.record()).toThrow(PROVENANCE_ERROR);
  });

  test("refuses a source whose rename original the copy never removed", () => {
    const fixture = handoffFixture({ rename: true });
    expect(fixture.handoff.paths.map((item) => item.path)).toContain(
      "GUIDE.md"
    );
    expect(() => fixture.record()).toThrow(REGISTRATION_ERROR);
  });

  test("refuses missing review of the semantic entries", () => {
    const fixture = handoffFixture();
    expect(() =>
      fixture.record(
        fixture.outcome({
          ...fixture.handoff,
          paths: fixture.handoff.paths.filter(
            (item) => item.path !== "docs.md"
          ),
        })
      )
    ).toThrow(PATH_ERROR);
    expect(() =>
      fixture.record(
        fixture.outcome({ ...fixture.handoff, reviewerAgentId: "controller" })
      )
    ).toThrow(REVIEW_ERROR);
    const { reviewReference: _omitted, ...unreviewed } = fixture.handoff;
    expect(() =>
      fixture.record(
        fixture.outcome(unreviewed as PreservedSourceHandoffReceipt)
      )
    ).toThrow("reviewReference");
  });

  test("refuses missing preservation approval", () => {
    const fixture = handoffFixture();
    const { preservation: _omitted, ...unapproved } = fixture.handoff;
    expect(() =>
      fixture.record(
        fixture.outcome(unapproved as PreservedSourceHandoffReceipt)
      )
    ).toThrow("preservation");
    // The source's own owner cannot approve keeping it.
    expect(() =>
      recordShipmentOutcome(
        fixture.root,
        fixture.lease.runId,
        "controller",
        fixture.outcome({ ...fixture.handoff, approvedBy: "owner" }),
        { ...fixture.approval, approvedBy: "owner" }
      )
    ).toThrow(APPROVAL_ERROR);
    expect(readLoopLease(fixture.root)?.shipmentOutcome).toBeUndefined();
  });

  test("refuses a target advance that drops the reviewed entries", () => {
    const fixture = handoffFixture();
    writeFixture(fixture.root, "docs.md", "# Workflow\n\nRewritten.\n");
    const advanced = commitAll(fixture.root, "Rewrite docs");
    // The handoff still names the reviewed entry the new target dropped.
    expect(() =>
      fixture.record(
        fixture.outcome(
          { ...fixture.handoff, targetRevision: advanced },
          advanced
        )
      )
    ).toThrow(TARGET_ERROR);
  });

  test("a target advance after recording keeps the run open", () => {
    const fixture = handoffFixture();
    fixture.record();
    writeFixture(fixture.root, "docs.md", "# Workflow\n\nRewritten.\n");
    commitAll(fixture.root, "Rewrite docs");
    const result = finalizeLoop(
      fixture.root,
      fixture.lease.runId,
      "controller",
      "The target moved."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join(" ")).toContain(
      `Shipment outcome targets ${fixture.target}`
    );
    expectSourcePreserved(fixture);
  });

  test("a source changed after recording keeps the run open and the source in place", () => {
    const fixture = handoffFixture();
    fixture.record();
    writeFixture(fixture.source, "docs.md", "# Workflow\n\nEdited later.\n");
    const result = finalizeLoop(
      fixture.root,
      fixture.lease.runId,
      "controller",
      "The source moved."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join(" ")).toContain("changed after recording");
    expect(readFileSync(join(fixture.source, "docs.md"), "utf8")).toBe(
      "# Workflow\n\nEdited later.\n"
    );
  });

  test("an edited handoff sidecar keeps the run open", () => {
    const fixture = handoffFixture();
    fixture.record();
    const sidecar = JSON.parse(
      readFileSync(fixture.sidecarPath, "utf8")
    ) as PreservedSourceHandoffRecord;
    const [handoff] = sidecar.handoffs;
    if (handoff) {
      handoff.reviewerAgentId = "another-reviewer";
    }
    writeFileSync(fixture.sidecarPath, JSON.stringify(sidecar));
    const result = finalizeLoop(
      fixture.root,
      fixture.lease.runId,
      "controller",
      "The handoff evidence was edited."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join(" ")).toContain(
      "do not match this run's recorded shipment outcome"
    );
    expectSourcePreserved(fixture);
  });

  test("a reader that knows only the override sidecar fails closed", () => {
    const fixture = handoffFixture();
    fixture.record();
    const lease = readLoopLease(fixture.root) as LoopLease;
    const outcome = lease.shipmentOutcome;
    if (!outcome) {
      throw new Error("Expected a recorded outcome");
    }
    // An older runtime reads no handoff sidecar, so the digest it recomputes
    // cannot match and it refuses to close the run.
    expect(() =>
      recordedPreservedSourceEvidence(
        null,
        null,
        lease.runId,
        outcome.receipt,
        outcome.receiptDigest
      )
    ).toThrow("sidecar is missing");
  });
});
