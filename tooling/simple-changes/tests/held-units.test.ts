import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { sha256Json } from "../../../skills/simple-changes/scripts/lib/hash.ts";
import {
  assertHeldScopeConservation,
  heldUnitExclusions,
  readHeldUnits,
} from "../../../skills/simple-changes/scripts/lib/held-units.ts";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  finalizeLoop,
  type HoldUnitApproval,
  holdScopedUnit,
  prepareAgentWorktree,
  readLoopLease,
  recordShipmentOutcome,
  recordShipmentScope,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { readinessEvidenceFailure } from "../../../skills/simple-changes/scripts/lib/loop-lease-hold.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import { recordedPreservedSourceOverrides } from "../../../skills/simple-changes/scripts/lib/preserved-source-override.ts";
import {
  draftShipmentOutcome,
  type ShipmentOutcomeDraftReceipt,
} from "../../../skills/simple-changes/scripts/lib/shipment-outcome-draft.ts";
import type {
  ChangePlan,
  ChangeUnit,
  HeldUnitHold,
  LoopLease,
  ShipmentOutcomeReceipt,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  readWorktreeCoordination,
  releaseWorktreeClaim,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// Spawn-heavy: the runner's `--timeout`, which SIMPLE_CHANGES_TEST_TIMEOUT_MS
// overrides, bounds each test.

const CONTROLLER = "controller";
const APPROVER = "repository-owner";
const REASON = "Independent review found two defects.";
const HELD_ERROR = /was held by loop hold-unit/u;
const STALE_ERROR = /is not the current state of unit/u;
const AMBIGUOUS_ERROR = /missing or ambiguous/u;
const DIGEST_LINE = /Observation digest: ([0-9a-f]{64})/u;

let repositories: TestRepository[] = [];
afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const commitAll = (root: string, message: string): string => {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
};

const cliPath = fileURLToPath(
  new URL(
    "../../../skills/simple-changes/scripts/simple-changes.ts",
    import.meta.url
  )
);

const heldFile = (root: string, runId: string): string =>
  join(root, ".git", "simple-changes", "held-units", `${runId}.json`);

const unitFrom = (
  template: ChangeUnit,
  id: string,
  title: string,
  paths: string[]
): ChangeUnit => ({
  ...template,
  dependencies: [],
  id,
  operations: ["commit"],
  outcome: `${title}.`,
  paths,
  requiredAuthority: ["local-write"],
  title,
});

/**
 * A Ship run packaged from a dirty primary checkout, as in the downstream
 * run: `feature` ships after review, `role` adds role checks and a shared
 * changelog line, and `guide` adds a new file the target never receives.
 */
const primaryFixture = (dependencies: string[] = []) => {
  const fixture = repository();
  const { root } = fixture;
  writeFixture(root, "CHANGELOG.md", "# Changelog\n");
  commitAll(root, "Base fixture");
  git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  writeFixture(root, "feature.txt", "draft feature\n");
  writeFixture(root, "CHANGELOG.md", "# Changelog\n\n- Role checks.\n");
  writeFixture(root, "role/check.ts", "export const check = 1;\n");
  writeFixture(root, "docs/guide.md", "# Guide\n");
  const lease = startLoop(root, CONTROLLER, "ship");
  const opening = captureInventory(root);
  const preview = buildPreviewPlan(
    opening,
    opening,
    compareSnapshots(opening, opening)
  );
  const [template] = preview.units;
  if (!template) {
    throw new Error("Expected a previewed unit");
  }
  const plan: ChangePlan = {
    ...preview,
    exclusions: [],
    preserved: [],
    units: [
      {
        ...unitFrom(template, "feature", "Ship the feature", ["feature.txt"]),
        dependencies,
      },
      unitFrom(template, "role", "Add role checks", [
        "CHANGELOG.md",
        "role/check.ts",
      ]),
      unitFrom(template, "guide", "Add the guide", ["docs/guide.md"]),
    ],
  };
  recordShipmentScope(root, lease.runId, CONTROLLER, plan);
  return { ...fixture, lease, plan };
};

// The feature ships through a run-prepared author after review, and
// unrelated merged work changes the shared changelog.
const deliverFeature = (root: string, runId: string): string => {
  const prepared = prepareAgentWorktree(
    root,
    runId,
    "delivery-author",
    "delivery"
  );
  writeFixture(prepared.path, "feature.txt", "reviewed feature\n");
  commitAll(prepared.path, "Reviewed feature");
  writeFixture(prepared.path, "CHANGELOG.md", "# Changelog\n\n- Other work.\n");
  const target = commitAll(prepared.path, "Unrelated merged work");
  git(root, ["update-ref", "refs/remotes/origin/main", target]);
  return target;
};

const holdUnit = (
  root: string,
  runId: string,
  unitId: string,
  readinessEvidence: string[],
  approval?: HoldUnitApproval
) =>
  holdScopedUnit(root, {
    agentId: CONTROLLER,
    ...(approval ? { approval } : {}),
    readinessEvidence,
    reason: REASON,
    runId,
    unitId,
  });

// The user approves the exact observation the preview returned.
const approvedHold = (
  root: string,
  runId: string,
  unitId: string,
  readinessEvidence: string[]
) => {
  const preview = holdUnit(root, runId, unitId, readinessEvidence);
  expect(preview.status).toBe("approval-required");
  expect(preview.hold).toBeNull();
  return holdUnit(root, runId, unitId, readinessEvidence, {
    approvalReference: "chat:user-approval-1",
    approvedBy: APPROVER,
    observationDigest: preview.observationDigest,
  });
};

const reviewed = ({
  draftReview: _draftReview,
  ...draft
}: ShipmentOutcomeDraftReceipt): ShipmentOutcomeReceipt => ({
  ...draft,
  additionalPaths: draft.additionalPaths.map((item) => ({
    ...item,
    reason: `Reviewed: ${item.path} reached the target through merged work unrelated to any held unit.`,
  })),
  units: draft.units.map((unit) => ({
    ...unit,
    evidence: ["Reviewed and checked at the final target."],
    summary: `Delivered ${unit.unitId}.`,
  })),
});

describe("loop hold-unit", () => {
  test("keeps a held unit preserved despite a shared changelog edit, and an absent baseline never proves equivalence", () => {
    const { lease, root } = primaryFixture();
    const target = deliverFeature(root, lease.runId);

    // Without a hold, path movement alone suggests the held units shipped.
    const unheld = draftShipmentOutcome(root, lease.runId);
    expect(
      Object.fromEntries(
        unheld.draft.units.map((unit) => [unit.unitId, unit.disposition])
      )
    ).toEqual({
      feature: "delivered",
      guide: "target-equivalent",
      role: "delivered",
    });

    const role = approvedHold(root, lease.runId, "role", [
      "Both independent reviewers found two P2 defects in unit role at its current source.",
    ]);
    expect(role.status).toBe("held");
    expect(role.hold?.exclusions).toEqual([
      {
        path: "CHANGELOG.md",
        reason: `Held by loop hold-unit: ${REASON}`,
        worktreePath: root,
      },
      {
        path: "role/check.ts",
        reason: `Held by loop hold-unit: ${REASON}`,
        worktreePath: root,
      },
    ]);
    expect(role.observation).toMatchObject({
      claim: null,
      controllerAgentId: CONTROLLER,
      source: { isPrimary: true, worktree: root },
      target: { ref: "origin/main", revision: target },
      unitId: "role",
    });
    expect(role.observation.paths.map((item) => item.path)).toEqual([
      "CHANGELOG.md",
      "role/check.ts",
    ]);
    approvedHold(root, lease.runId, "guide", [
      "docs/guide.md is not ready: the guide still describes the old flow.",
    ]);

    // The draft no longer proposes a disposition for a held unit and flags
    // the shared changelog as a filename-only match.
    const draft = draftShipmentOutcome(root, lease.runId);
    expect(draft.draft.units.map((unit) => unit.unitId)).toEqual(["feature"]);
    expect(draft.summary.heldUnits).toEqual(["role", "guide"]);
    const changelog = draft.draft.additionalPaths.find(
      (item) => item.path === "CHANGELOG.md"
    );
    expect(changelog?.classification).toBe("external-target-change");
    expect(changelog?.reason).toContain(
      "held unit role also scopes this path, but a filename match does not show it shipped"
    );
    expect(draft.warnings).toContainEqual(
      expect.stringContaining(
        "Held unit role scopes CHANGELOG.md, which changed on the target. That is a filename match only"
      )
    );

    // Neither held unit can be recorded as delivered or target-equivalent.
    const outcome = reviewed(draft.draft);
    const entry = (path: string) =>
      `100644:blob:${git(root, ["rev-parse", `${target}:${path}`])}`;
    for (const unit of [
      {
        disposition: "delivered" as const,
        evidence: ["The changelog moved."],
        finalPaths: [
          { entry: entry("CHANGELOG.md"), path: "CHANGELOG.md" },
          { entry: null, path: "role/check.ts" },
        ],
        originalPaths: [],
        summary: "Role checks.",
        unitId: "role",
      },
      {
        disposition: "target-equivalent" as const,
        evidence: ["The guide is absent from the target."],
        finalPaths: [{ entry: null, path: "docs/guide.md" }],
        originalPaths: [],
        summary: "Guide.",
        unitId: "guide",
      },
    ]) {
      expect(() =>
        recordShipmentOutcome(root, lease.runId, CONTROLLER, {
          ...outcome,
          additionalPaths: outcome.additionalPaths.filter(
            (item) => !unit.finalPaths.some((path) => path.path === item.path)
          ),
          units: [...outcome.units, unit],
        })
      ).toThrow(HELD_ERROR);
    }
    // The changed shared changelog must still be accounted for.
    expect(() =>
      recordShipmentOutcome(root, lease.runId, CONTROLLER, {
        ...outcome,
        additionalPaths: [],
      })
    ).toThrow("omits final target delta paths: CHANGELOG.md");
    const recorded = recordShipmentOutcome(
      root,
      lease.runId,
      CONTROLLER,
      outcome
    );
    expect(recorded.summary).toContain(
      "2 held unit(s) stay preserved and are not reported as delivered: role, guide."
    );
    // The recorded digest binds the holds, so a runtime that does not read
    // the held-unit record refuses the outcome instead of closing over it.
    const stored = readLoopLease(root)?.shipmentOutcome;
    if (!stored) {
      throw new Error("Expected a recorded outcome");
    }
    expect(stored.receiptDigest).not.toBe(sha256Json(stored.receipt));
    expect(() =>
      recordedPreservedSourceOverrides(
        null,
        lease.runId,
        stored.receipt,
        stored.receiptDigest
      )
    ).toThrow("record the outcome again");

    const result = finalizeLoop(
      root,
      lease.runId,
      CONTROLLER,
      "Close the shipment with held units."
    );
    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.receipt.deliveryStatus).toBe("verified");
    expect(result.cleanup.cleanedPrimaryPaths).toEqual([]);
    expect(
      result.receipt.heldUnits?.map(({ sourceMatchesHold, unitId }) => ({
        sourceMatchesHold,
        unitId,
      }))
    ).toEqual([
      { sourceMatchesHold: true, unitId: "role" },
      { sourceMatchesHold: true, unitId: "guide" },
    ]);
    // The held bytes stay exactly as held, and the record stays as audit.
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(
      "# Changelog\n\n- Role checks.\n"
    );
    expect(readFileSync(join(root, "role/check.ts"), "utf8")).toBe(
      "export const check = 1;\n"
    );
    expect(readFileSync(join(root, "docs/guide.md"), "utf8")).toBe("# Guide\n");
    expect(existsSync(heldFile(root, lease.runId))).toBe(true);
    expect(readLoopLease(root)).toBeNull();
  });

  test("refuses a missing or partial approval, an approver who is not the user, and stale source or target evidence", () => {
    const { lease, root } = primaryFixture();
    deliverFeature(root, lease.runId);
    const evidence = ["Unit role failed review with two P2 defects."];

    expect(() =>
      holdUnit(root, lease.runId, "role", evidence, { approvedBy: APPROVER })
    ).toThrow(
      "pass --approved-by, --approval-reference, and --observation-digest together"
    );
    const preview = holdUnit(root, lease.runId, "role", evidence);
    expect(preview.summary).toContain(
      `Observation digest: ${preview.observationDigest}`
    );
    expect(preview.approvalCommand).toContain(
      `--observation-digest ${preview.observationDigest}`
    );
    const approval = {
      approvalReference: "chat:user-approval-2",
      approvedBy: APPROVER,
      observationDigest: preview.observationDigest,
    };
    expect(() =>
      holdUnit(root, lease.runId, "role", evidence, {
        ...approval,
        observationDigest: "0".repeat(64),
      })
    ).toThrow(STALE_ERROR);
    expect(() =>
      holdUnit(root, lease.runId, "role", evidence, {
        ...approval,
        approvedBy: CONTROLLER,
      })
    ).toThrow("not the approving user");

    // A changed source byte after the approval refuses it; restoring the
    // exact bytes restores the exact observation.
    writeFixture(root, "role/check.ts", "export const check = 2;\n");
    expect(() =>
      holdUnit(root, lease.runId, "role", evidence, approval)
    ).toThrow(STALE_ERROR);
    writeFixture(root, "role/check.ts", "export const check = 1;\n");
    // A target that moved after the approval refuses it.
    const moved = git(root, [
      "commit-tree",
      "-p",
      git(root, ["rev-parse", "origin/main"]),
      "-m",
      "Later target",
      `${git(root, ["rev-parse", "origin/main"])}^{tree}`,
    ]);
    const before = git(root, ["rev-parse", "origin/main"]);
    git(root, ["update-ref", "refs/remotes/origin/main", moved]);
    expect(() =>
      holdUnit(root, lease.runId, "role", evidence, approval)
    ).toThrow(STALE_ERROR);
    git(root, ["update-ref", "refs/remotes/origin/main", before]);
    // A different reason or evidence is a different decision.
    expect(() =>
      holdScopedUnit(root, {
        agentId: CONTROLLER,
        approval,
        readinessEvidence: evidence,
        reason: "Some other reason.",
        runId: lease.runId,
        unitId: "role",
      })
    ).toThrow(STALE_ERROR);
    expect(existsSync(heldFile(root, lease.runId))).toBe(false);

    const held = holdUnit(root, lease.runId, "role", evidence, approval);
    expect(held.status).toBe("held");
    expect(held.hold?.authorization).toMatchObject({
      approvalReference: "chat:user-approval-2",
      approvedBy: APPROVER,
    });
    // A hold is immutable and never recorded twice.
    expect(() => holdUnit(root, lease.runId, "role", evidence)).toThrow(
      "already held"
    );
    expect(() =>
      holdUnit(root, lease.runId, "unknown", ["Unit unknown failed."])
    ).toThrow("is not in the frozen shipment scope");
  });

  test("never switches or normalizes a clean held primary checkout", () => {
    const fixture = repository();
    const { root } = fixture;
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    git(root, ["switch", "-q", "-c", "work"]);
    writeFixture(root, "feature.txt", "draft feature\n");
    writeFixture(root, "role/check.ts", "export const check = 1;\n");
    const lease = startLoop(root, CONTROLLER, "ship");
    const opening = captureInventory(root);
    const preview = buildPreviewPlan(
      opening,
      opening,
      compareSnapshots(opening, opening)
    );
    const [template] = preview.units;
    if (!template) {
      throw new Error("Expected a previewed unit");
    }
    recordShipmentScope(root, lease.runId, CONTROLLER, {
      ...preview,
      units: [
        unitFrom(template, "feature", "Ship the feature", ["feature.txt"]),
        unitFrom(template, "role", "Add role checks", ["role/check.ts"]),
      ],
    });
    const prepared = prepareAgentWorktree(
      root,
      lease.runId,
      "delivery-author",
      "delivery"
    );
    writeFixture(prepared.path, "feature.txt", "draft feature\n");
    const target = commitAll(prepared.path, "Feature");
    git(root, ["update-ref", "refs/remotes/origin/main", target]);
    // The primary commits its own copy, so it is clean on its branch.
    const held = commitAll(root, "Work in progress");
    approvedHold(root, lease.runId, "role", ["Unit role failed review."]);
    recordShipmentOutcome(
      root,
      lease.runId,
      CONTROLLER,
      reviewed(draftShipmentOutcome(root, lease.runId).draft)
    );
    finalizeLoop(root, lease.runId, CONTROLLER, "Finish with role held.");
    expect(git(root, ["branch", "--show-current"])).toBe("work");
    expect(git(root, ["rev-parse", "HEAD"])).toBe(held);
    expect(readFileSync(join(root, "role/check.ts"), "utf8")).toBe(
      "export const check = 1;\n"
    );
  });

  test("refuses missing or ambiguous readiness evidence", () => {
    const { lease, root } = primaryFixture();
    for (const evidence of [
      [],
      ["Review found two defects."],
      ["Units role and feature both failed review."],
    ]) {
      expect(() => holdUnit(root, lease.runId, "role", evidence)).toThrow(
        AMBIGUOUS_ERROR
      );
    }
    expect(() =>
      holdUnit(root, lease.runId, "role", [
        "SIMPLE-CHANGES-DRAFT: replace with the evidence for unit role.",
      ])
    ).toThrow("placeholder");
    // A path only this unit scopes identifies it.
    expect(
      holdUnit(root, lease.runId, "role", [
        "role/check.ts fails the permission ratchet test.",
      ]).status
    ).toBe("approval-required");
  });

  test("refuses to hold a unit another unit depends on, after an outcome, or without a scope", () => {
    const dependent = primaryFixture(["role"]);
    expect(() =>
      holdUnit(dependent.root, dependent.lease.runId, "role", [
        "Unit role failed review.",
      ])
    ).toThrow("Scoped unit feature depends on role");

    const { lease, root } = primaryFixture();
    const target = deliverFeature(root, lease.runId);
    approvedHold(root, lease.runId, "role", ["Unit role failed review."]);
    approvedHold(root, lease.runId, "guide", ["Unit guide is not ready."]);
    const draft = draftShipmentOutcome(root, lease.runId);
    recordShipmentOutcome(root, lease.runId, CONTROLLER, reviewed(draft.draft));
    expect(target).toBe(draft.draft.targetRevision);
    // A recorded outcome already reports the feature as delivered.
    expect(() =>
      holdUnit(root, lease.runId, "feature", ["Unit feature failed review."])
    ).toThrow("already recorded its shipment outcome");

    const bare = repository();
    const scopeless = startLoop(bare.root, CONTROLLER, "integrate");
    expect(() =>
      holdUnit(bare.root, scopeless.runId, "role", ["Unit role failed."])
    ).toThrow("has no recorded shipment scope");
  });

  test("fails closed when a hold record is edited, copied, or does not match the frozen scope", () => {
    const { lease, root } = primaryFixture();
    const target = deliverFeature(root, lease.runId);
    approvedHold(root, lease.runId, "role", ["Unit role failed review."]);
    approvedHold(root, lease.runId, "guide", ["Unit guide is not ready."]);
    const path = heldFile(root, lease.runId);
    const original = readFileSync(path, "utf8");
    const draft = reviewed(draftShipmentOutcome(root, lease.runId).draft);
    expect(draft.targetRevision).toBe(target);

    const record = JSON.parse(original) as { holds: HeldUnitHold[] };
    const [hold] = record.holds;
    if (!hold) {
      throw new Error("Expected a hold");
    }
    hold.authorization.approvedBy = "someone-else";
    writeFileSync(path, JSON.stringify(record));
    expect(() =>
      recordShipmentOutcome(root, lease.runId, CONTROLLER, draft)
    ).toThrow("not the one loop hold-unit wrote for unit role");

    // A record from another run is refused.
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(original), runId: "run-other" })
    );
    expect(() => readHeldUnits(lease)).toThrow("names run run-other");
    writeFileSync(path, original);

    // A run whose scope does not register the held unit refuses the record.
    const other = primaryFixture();
    const otherPath = heldFile(other.root, other.lease.runId);
    mkdirSync(dirname(otherPath), { recursive: true });
    writeFileSync(
      otherPath,
      original.replaceAll(lease.runId, other.lease.runId)
    );
    expect(() => readHeldUnits(other.lease)).toThrow("not the one");

    // With the original record restored, the outcome records and closes.
    recordShipmentOutcome(root, lease.runId, CONTROLLER, draft);
    // Removing the record after the outcome leaves the held unit unreported,
    // which blocks completion instead of releasing it.
    writeFileSync(path, "{}");
    const blocked = finalizeLoop(
      root,
      lease.runId,
      CONTROLLER,
      "Try to close without the hold record."
    );
    expect(blocked.outcome).toBe("relinquished");
    expect(blocked.receipt.deliveryStatus).toBe("unverified");
    expect(blocked.receipt.heldUnits).toBeUndefined();
    expect(readFileSync(join(root, "role/check.ts"), "utf8")).toBe(
      "export const check = 1;\n"
    );
  });

  test("an earlier outcome without holds still records and finalizes as before", () => {
    const { lease, root } = primaryFixture();
    deliverFeature(root, lease.runId);
    expect(readHeldUnits(lease)).toEqual([]);
    const draft = draftShipmentOutcome(root, lease.runId);
    expect(draft.summary.heldUnits).toEqual([]);
    expect(draft.draft.units.map((unit) => unit.unitId)).toEqual([
      "feature",
      "role",
      "guide",
    ]);
    // The receipt shape is unchanged, so an older runtime's schema reads it.
    expect(Object.keys(reviewed(draft.draft)).sort()).toEqual([
      "additionalPaths",
      "runId",
      "schemaVersion",
      "targetRevision",
      "units",
    ]);
    expect(() =>
      recordShipmentOutcome(root, lease.runId, CONTROLLER, {
        ...reviewed(draft.draft),
        units: reviewed(draft.draft).units.filter(
          (unit) => unit.unitId === "feature"
        ),
      })
    ).toThrow("omits scoped units: role, guide");
  });
});

describe("held unit in a claimed author checkout", () => {
  /**
   * Two claimed checkouts both change `CHANGELOG.md`: `shipping` ships it
   * with its feature, while `role` commits its own changelog line and role
   * check but stays held. The controller owns both claims.
   */
  const claimedFixture = () => {
    const fixture = repository();
    const { base, root } = fixture;
    writeFixture(root, "CHANGELOG.md", "# Changelog\n");
    commitAll(root, "Base fixture");
    const shipping = join(base, "shipping");
    const role = join(base, "role");
    git(root, ["worktree", "add", "-q", "-b", "shipping", shipping]);
    git(root, ["worktree", "add", "-q", "-b", "role", role]);
    writeFixture(shipping, "CHANGELOG.md", "# Changelog\n\n- Feature.\n");
    writeFixture(shipping, "feature.txt", "feature\n");
    writeFixture(role, "CHANGELOG.md", "# Changelog\n\n- Role checks.\n");
    writeFixture(role, "role.ts", "export const role = 1;\n");
    const claim = claimWorktree(root, CONTROLLER, role, "test");
    const lease = startLoop(shipping, CONTROLLER, "ship");
    const opening = captureInventory(shipping);
    const preview = buildPreviewPlan(
      opening,
      opening,
      compareSnapshots(opening, opening)
    );
    const plan: ChangePlan = {
      ...preview,
      units: preview.units.map((unit) => ({
        ...unit,
        operations: ["commit"],
        requiredAuthority: ["local-write"],
      })),
    };
    recordShipmentScope(shipping, lease.runId, CONTROLLER, plan);
    const ids = Object.fromEntries(
      plan.units.map((unit) => [unit.sourceWorktree, unit.id])
    );
    return {
      ...fixture,
      claim,
      lease,
      plan,
      role,
      roleUnit: ids[role] ?? "",
      shipping,
      shippingUnit: ids[shipping] ?? "",
    };
  };

  test("conserves a repeated filename per checkout and leaves the held checkout, branch, and claim untouched", () => {
    const fixture = claimedFixture();
    const { claim, lease, role, roleUnit, root, shipping, shippingUnit } =
      fixture;
    expect(roleUnit).not.toBe("");
    expect(shippingUnit).not.toBe("");
    const roleHead = commitAll(role, "Role checks under review");
    commitAll(shipping, "Feature");
    git(root, ["merge", "-q", "--ff-only", "shipping"]);

    // A filename the shipping unit also scopes does not identify the unit.
    expect(() =>
      holdUnit(root, lease.runId, roleUnit, ["The CHANGELOG.md line is wrong."])
    ).toThrow("a filename another unit shares does not identify it");
    const held = approvedHold(shipping, lease.runId, roleUnit, [
      `Unit ${roleUnit} failed independent review: two P2 defects.`,
    ]);
    expect(held.observation.claim).toEqual({
      branch: "role",
      claimId: claim.claimId,
      ownerAgentId: CONTROLLER,
      state: "active",
    });
    expect(held.observation.source).toMatchObject({
      branch: "role",
      headSha: roleHead,
      isPrimary: false,
      worktree: role,
    });
    expect(held.hold?.exclusions.map((item) => item.worktreePath)).toEqual([
      role,
      role,
    ]);
    const current = readLoopLease(root) as LoopLease;
    assertHeldScopeConservation(
      current.shipmentScope as NonNullable<LoopLease["shipmentScope"]>,
      readHeldUnits(current)
    );

    const draft = draftShipmentOutcome(root, lease.runId);
    expect(draft.draft.units.map((unit) => unit.unitId)).toEqual([
      shippingUnit,
    ]);
    expect(draft.warnings).toContainEqual(
      expect.stringContaining(
        `the draft attributes the change to unit ${shippingUnit}, which also scopes it, and unit ${roleUnit} stays held`
      )
    );
    recordShipmentOutcome(
      shipping,
      lease.runId,
      CONTROLLER,
      reviewed(draft.draft)
    );
    const result = finalizeLoop(
      shipping,
      lease.runId,
      CONTROLLER,
      "Close the shipment with the role unit held."
    );
    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.receipt.heldUnits).toMatchObject([
      {
        sourceBranch: "role",
        sourceHeadSha: roleHead,
        sourceMatchesHold: true,
        sourceWorktree: role,
        unitId: roleUnit,
      },
    ]);
    expect(
      result.cleanup.releasedClaims.map((item) => item.claimId)
    ).not.toContain(claim.claimId);
    const kept = readWorktreeCoordination(root).claims.find(
      (item) => item.claimId === claim.claimId
    );
    expect(kept?.state).toBe("active");
    expect(existsSync(role)).toBe(true);
    expect(git(root, ["rev-parse", "refs/heads/role"])).toBe(roleHead);
    expect(readFileSync(join(role, "CHANGELOG.md"), "utf8")).toBe(
      "# Changelog\n\n- Role checks.\n"
    );
  });

  test("refuses an approval after the claim changed", () => {
    const { claim, lease, role, roleUnit, shipping } = claimedFixture();
    const evidence = [`Unit ${roleUnit} failed review.`];
    const preview = holdUnit(shipping, lease.runId, roleUnit, evidence);
    releaseWorktreeClaim(shipping, CONTROLLER, claim.claimId);
    claimWorktree(shipping, "another-author", role, "test");
    expect(() =>
      holdUnit(shipping, lease.runId, roleUnit, evidence, {
        approvalReference: "chat:user-approval-3",
        approvedBy: APPROVER,
        observationDigest: preview.observationDigest,
      })
    ).toThrow(STALE_ERROR);
    // The claim owner is not the approving user either.
    const fresh = holdUnit(shipping, lease.runId, roleUnit, evidence);
    expect(() =>
      holdUnit(shipping, lease.runId, roleUnit, evidence, {
        approvalReference: "chat:user-approval-3",
        approvedBy: "another-author",
        observationDigest: fresh.observationDigest,
      })
    ).toThrow("not the approving user");
  });
});

describe("held scope conservation", () => {
  const unit = (id: string, worktree: string, paths: string[]): ChangeUnit => ({
    checks: [],
    dependencies: [],
    id,
    operations: [],
    outcome: `${id}.`,
    paths,
    releaseImpact: "none",
    requiredAuthority: [],
    sourceWorktree: worktree,
    status: "ready",
    title: id,
  });
  const scope = (): NonNullable<LoopLease["shipmentScope"]> => {
    const units = [
      unit("shipping", "/w/shipping", ["CHANGELOG.md", "feature.txt"]),
      unit("role", "/w/role", ["CHANGELOG.md", "role.ts"]),
    ];
    const plan: ChangePlan = {
      baselineDigest: "0".repeat(64),
      exclusions: [{ path: "notes.md", reason: "Personal." }],
      generatedAt: "2026-10-21T00:00:00.000Z",
      mode: "preview",
      mutationCount: 0,
      mutationsAllowed: false,
      preserved: [
        {
          classification: "paused",
          paths: ["CHANGELOG.md"],
          reason: "Another author.",
          worktreePath: "/w/other",
        },
      ],
      questions: [],
      repositoryRoot: "/w/repo",
      request: "Ship",
      schemaVersion: 1,
      units,
      warnings: [],
    };
    return {
      openingChanges: [
        ["/w/shipping", "CHANGELOG.md"],
        ["/w/shipping", "feature.txt"],
        ["/w/role", "CHANGELOG.md"],
        ["/w/role", "role.ts"],
        ["/w/other", "CHANGELOG.md"],
        ["/w/repo", "notes.md"],
      ].map(([worktreePath, path]) => ({
        originalPath: null,
        path: path ?? "",
        sourceEntry: null,
        worktreePath: worktreePath ?? "",
      })),
      plan,
      planDigest: sha256Json(plan),
      recordedAt: "2026-10-21T00:00:00.000Z",
    };
  };
  const holdOf = (
    held: ChangeUnit,
    exclusions = heldUnitExclusions(held, "Not ready.")
  ): HeldUnitHold => ({ exclusions, unit: held }) as unknown as HeldUnitHold;

  test("accounts for every original path exactly once, keyed by checkout", () => {
    const frozen = scope();
    const [, role] = frozen.plan.units;
    if (!role) {
      throw new Error("Expected the role unit");
    }
    expect(() =>
      assertHeldScopeConservation(frozen, [holdOf(role)])
    ).not.toThrow();
    // A hold that leaves a path out loses it.
    expect(() =>
      assertHeldScopeConservation(frozen, [
        holdOf(role, heldUnitExclusions({ ...role, paths: ["role.ts"] }, "x")),
      ])
    ).toThrow("would not conserve");
    // A hold that excludes another checkout's same-named path counts it twice.
    expect(() =>
      assertHeldScopeConservation(frozen, [
        holdOf(role, [
          ...heldUnitExclusions(role, "x"),
          { path: "CHANGELOG.md", reason: "x", worktreePath: "/w/other" },
        ]),
      ])
    ).toThrow("more than once");
    // A hold that names a path no checkout changed adds one.
    expect(() =>
      assertHeldScopeConservation(frozen, [
        holdOf(role, [
          ...heldUnitExclusions(role, "x"),
          { path: "new.ts", reason: "x", worktreePath: "/w/role" },
        ]),
      ])
    ).toThrow("would not conserve");
  });
});

describe("readiness evidence", () => {
  const role = { id: "role", paths: ["CHANGELOG.md", "role/check.ts"] };
  const units = [
    role,
    { id: "role-2", paths: ["role2/check.ts"] },
    { id: "feature", paths: ["CHANGELOG.md", "feature.txt"] },
  ];

  test("must name the unit, and only that unit", () => {
    expect(readinessEvidenceFailure(role, units, [])).toContain(
      "no readiness evidence"
    );
    expect(
      readinessEvidenceFailure(role, units, ["Unit role failed review."])
    ).toBeNull();
    expect(
      readinessEvidenceFailure(role, units, ["role/check.ts fails its test."])
    ).toBeNull();
    // A longer ID that contains this one is not this unit.
    expect(
      readinessEvidenceFailure(role, units, ["Unit role-2 failed review."])
    ).toContain("also names scoped unit role-2");
    expect(
      readinessEvidenceFailure(role, units, ["CHANGELOG.md is wrong."])
    ).toContain("a filename another unit shares does not identify it");
    // A path is matched whole: another unit's longer path is not this one.
    const app = { id: "app", paths: ["role.ts"] };
    const nested = [app, { id: "suite", paths: ["tests/role.ts"] }];
    expect(
      readinessEvidenceFailure(app, nested, [
        "tests/role.ts failed independent review.",
      ])
    ).toContain("names tests/role.ts, which only scoped unit suite scopes");
    expect(
      readinessEvidenceFailure(app, nested, [
        "`role.ts` failed independent review.",
      ])
    ).toBeNull();
    expect(
      readinessEvidenceFailure(role, units, [
        "Unit role failed review.",
        "Something else failed.",
      ])
    ).toContain("readiness evidence 2 names neither unit role");
  });
});

describe("loop hold-unit command", () => {
  test("shows the observation to approve, then holds the unit", () => {
    const { lease, root } = primaryFixture();
    const run = (extra: string[]) =>
      spawnSync(
        [
          process.execPath,
          cliPath,
          "loop",
          "hold-unit",
          "--run-id",
          lease.runId,
          "--agent-id",
          CONTROLLER,
          "--unit",
          "role",
          "--reason",
          REASON,
          "--readiness-evidence",
          "Unit role failed review.",
          ...extra,
        ],
        {
          cwd: root,
          env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
    const decoder = new TextDecoder();
    const preview = run([]);
    expect(decoder.decode(preview.stderr)).toBe("");
    expect(preview.exitCode).toBe(0);
    const text = decoder.decode(preview.stdout);
    expect(text).toContain("Nothing is held yet.");
    expect(text).toContain(
      "an earlier or conditional instruction is not enough"
    );
    const digest = DIGEST_LINE.exec(text)?.[1] ?? "";
    expect(digest).toHaveLength(64);
    const held = run([
      "--approved-by",
      APPROVER,
      "--approval-reference",
      "chat:user-approval-4",
      "--observation-digest",
      digest,
      "--json",
    ]);
    expect(decoder.decode(held.stderr)).toBe("");
    expect(held.exitCode).toBe(0);
    const result = JSON.parse(decoder.decode(held.stdout)) as {
      status: string;
    };
    expect(result.status).toBe("held");
    expect(readHeldUnits(lease).map((hold) => hold.unit.id)).toEqual(["role"]);
  });
});
