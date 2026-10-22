import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { sha256Json } from "../../../skills/simple-changes/scripts/lib/hash.ts";
import {
  assertHeldScopeConservation,
  heldUnitExclusions,
  heldUnitHoldDigest,
  heldUnitsDigest,
  readHeldUnits,
} from "../../../skills/simple-changes/scripts/lib/held-units.ts";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  closeLoopTargetEquivalent,
  endLoop,
  finalizeLoop,
  type HoldUnitApproval,
  holdScopedUnit,
  loopLeasePath,
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
  schemaPath,
  validateSchemaDocument,
} from "../../../skills/simple-changes/scripts/lib/schema.ts";
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

// Points the checkout's HEAD, at its current commit, at `release/` plus the
// raw byte `byte`, which Git output decodes as `release/\uFFFD` (#16). The
// ref is packed, since a file system may refuse such a loose ref.
const checkOutRawByteBranch = (path: string, byte: number): void => {
  const sha = git(path, ["rev-parse", "HEAD"]);
  const common = resolve(path, git(path, ["rev-parse", "--git-common-dir"]));
  appendFileSync(
    join(common, "packed-refs"),
    Buffer.concat([
      Buffer.from(`${sha} refs/heads/release/`),
      Buffer.from([byte]),
      Buffer.from("\n"),
    ])
  );
  const made = spawnSync(
    [
      "sh",
      "-c",
      `git symbolic-ref HEAD "$(printf 'refs/heads/release/\\${byte.toString(8)}')"`,
    ],
    { cwd: path, stderr: "pipe", stdout: "pipe" }
  );
  expect(new TextDecoder().decode(made.stderr)).toBe("");
};

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

/**
 * A clean primary checkout on its own branch holds a committed unit: the
 * primary commits its copy of both units after the feature ships elsewhere,
 * and the role unit is held.
 */
const cleanHeldPrimary = () => {
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
  approvedHold(root, lease.runId, "role", ["role: failed review."]);
  return { held, lease, root };
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
      "role: Both independent reviewers found two P2 defects at its current source.",
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
      "guide: the guide still describes the old flow.",
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
    const evidence = ["role: failed review with two P2 defects."];

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
      holdUnit(root, lease.runId, "unknown", ["unknown: failed."])
    ).toThrow("is not in the frozen shipment scope");
  });

  test("never switches or normalizes a clean held primary checkout", () => {
    const { held, lease, root } = cleanHeldPrimary();
    // The held head stays reachable whatever any runtime does to branches.
    expect(
      git(root, ["rev-parse", `refs/simple-changes/held/${lease.runId}/role`])
    ).toBe(held);
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

  test("a hold record removed before the outcome still stops cleanup", () => {
    const { held, lease, root } = cleanHeldPrimary();
    rmSync(heldFile(root, lease.runId));
    expect(() => readHeldUnits(lease)).toThrow(
      "the held-unit record no longer contains that hold"
    );
    expect(() => draftShipmentOutcome(root, lease.runId)).toThrow(
      "no longer contains that hold"
    );
    const result = finalizeLoop(
      root,
      lease.runId,
      CONTROLLER,
      "Try to finish without the hold record."
    );
    expect(result.outcome).toBe("relinquished");
    expect(result.cleanup.removedWorktrees).toEqual([]);
    expect(result.cleanup.errors).toContainEqual(
      expect.stringContaining("so automatic cleanup did not run")
    );
    expect(git(root, ["branch", "--show-current"])).toBe("work");
    expect(git(root, ["rev-parse", "HEAD"])).toBe(held);
  });

  test("refuses missing or ambiguous readiness evidence", () => {
    const { lease, root } = primaryFixture();
    for (const evidence of [
      [],
      ["Review found two defects."],
      ["role/check.ts fails the permission ratchet test."],
      ["role: Units role and feature both failed review."],
      ["role:"],
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
    expect(
      holdUnit(root, lease.runId, "role", [
        "role: role/check.ts fails the permission ratchet test.",
      ]).status
    ).toBe("approval-required");
  });

  test("refuses to hold a unit another unit depends on, after an outcome, or without a scope", () => {
    const dependent = primaryFixture(["role"]);
    expect(() =>
      holdUnit(dependent.root, dependent.lease.runId, "role", [
        "role: failed review.",
      ])
    ).toThrow("Scoped unit feature depends on role");

    const { lease, root } = primaryFixture();
    const target = deliverFeature(root, lease.runId);
    approvedHold(root, lease.runId, "role", ["role: failed review."]);
    approvedHold(root, lease.runId, "guide", ["guide: not ready."]);
    const draft = draftShipmentOutcome(root, lease.runId);
    recordShipmentOutcome(root, lease.runId, CONTROLLER, reviewed(draft.draft));
    expect(target).toBe(draft.draft.targetRevision);
    // A recorded outcome already reports the feature as delivered.
    expect(() =>
      holdUnit(root, lease.runId, "feature", ["feature: failed review."])
    ).toThrow("already recorded its shipment outcome");

    const bare = repository();
    const scopeless = startLoop(bare.root, CONTROLLER, "integrate");
    expect(() =>
      holdUnit(bare.root, scopeless.runId, "role", ["role: failed."])
    ).toThrow("has no recorded shipment scope");
  });

  test("fails closed when a hold record is edited, copied, or does not match the frozen scope", () => {
    const { lease, root } = primaryFixture();
    const target = deliverFeature(root, lease.runId);
    approvedHold(root, lease.runId, "role", ["role: failed review."]);
    approvedHold(root, lease.runId, "guide", ["guide: not ready."]);
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

    // A hold with no history event, such as one written by hand, is refused,
    // and so is a hold the controller approved itself, digests and all.
    const events = join(root, ".git", "simple-changes", "history", lease.runId);
    const eventNames = readdirSync(events).filter((name) =>
      name.startsWith("held-unit-")
    );
    expect(eventNames).toHaveLength(2);
    const [firstEvent] = eventNames;
    const eventPath = join(events, firstEvent ?? "");
    const eventText = readFileSync(eventPath, "utf8");
    rmSync(eventPath);
    expect(() => readHeldUnits(lease)).toThrow(
      "the run's history has no event for this hold"
    );
    writeFileSync(eventPath, eventText);
    const selfApproved = JSON.parse(original) as {
      holds: HeldUnitHold[];
    };
    const [first] = selfApproved.holds;
    if (!first) {
      throw new Error("Expected a hold");
    }
    const { holdDigest: _holdDigest, ...content } = {
      ...first,
      authorization: { ...first.authorization, approvedBy: CONTROLLER },
    };
    const forgedDigest = heldUnitHoldDigest(content);
    selfApproved.holds[0] = { ...content, holdDigest: forgedDigest };
    writeFileSync(path, JSON.stringify(selfApproved));
    writeFileSync(
      join(events, `held-unit-${forgedDigest}.json`),
      JSON.stringify({
        ...JSON.parse(eventText),
        holdDigest: forgedDigest,
      })
    );
    expect(() => readHeldUnits(lease)).toThrow(
      "its approver is the controller or the claim owner"
    );
    rmSync(join(events, `held-unit-${forgedDigest}.json`));
    writeFileSync(path, original);

    // With the original record restored, the outcome records and closes.
    recordShipmentOutcome(root, lease.runId, CONTROLLER, draft);
    // Removing the record after the outcome leaves the held unit unreported,
    // which blocks completion instead of releasing it.
    rmSync(path);
    const blocked = finalizeLoop(
      root,
      lease.runId,
      CONTROLLER,
      "Try to close without the hold record."
    );
    expect(blocked.outcome).toBe("relinquished");
    expect(blocked.receipt.deliveryStatus).toBe("unverified");
    // The digest is checked before cleanup, so nothing was cleaned, not even
    // the run's own target-contained author checkout.
    expect(blocked.cleanup.removedWorktrees).toEqual([]);
    expect(blocked.cleanup.errors).toContainEqual(
      expect.stringContaining("so automatic cleanup did not run")
    );
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

// A 0.32.0 reader: the same strict lease schema without the held-units key.
const olderLeaseSchema = (): Record<string, unknown> => {
  const schema = JSON.parse(readFileSync(schemaPath("loop-lease"), "utf8")) as {
    properties: Record<string, unknown>;
  };
  Reflect.deleteProperty(schema.properties, "heldUnits");
  return schema;
};

const readOlder = (root: string): unknown =>
  validateSchemaDocument(
    "loop-lease",
    olderLeaseSchema(),
    JSON.parse(readFileSync(loopLeasePath(join(root, ".git")), "utf8"))
  );

describe("held-unit lease key", () => {
  test("an older reader refuses a lease once it holds a unit, and never before", () => {
    const { lease, root } = primaryFixture();
    const leaseFile = loopLeasePath(join(root, ".git"));
    const before = readFileSync(leaseFile, "utf8");
    expect(before).not.toContain('"heldUnits"');
    expect(() => readOlder(root)).not.toThrow();
    // Observing a hold, or being refused one, writes nothing.
    const preview = holdUnit(root, lease.runId, "role", [
      "role: failed review.",
    ]);
    expect(() =>
      holdUnit(root, lease.runId, "role", ["role: failed review."], {
        approvalReference: "chat:user-approval-5",
        approvedBy: APPROVER,
        observationDigest: "0".repeat(64),
      })
    ).toThrow(STALE_ERROR);
    expect(readFileSync(leaseFile, "utf8")).toBe(before);
    holdUnit(root, lease.runId, "role", ["role: failed review."], {
      approvalReference: "chat:user-approval-5",
      approvedBy: APPROVER,
      observationDigest: preview.observationDigest,
    });
    const held = readLoopLease(root) as LoopLease;
    expect(held.heldUnits).toEqual({
      holdsDigest: heldUnitsDigest(readHeldUnits(held)),
    });
    expect(() => readOlder(root)).toThrow("heldUnits");
    // A second hold rebinds the key to both holds.
    approvedHold(root, lease.runId, "guide", ["guide: not ready."]);
    const both = readLoopLease(root) as LoopLease;
    expect(readHeldUnits(both)).toHaveLength(2);
    expect(both.heldUnits?.holdsDigest).not.toBe(held.heldUnits?.holdsDigest);
    // Dropping the key does not make the run readable as unheld.
    const { heldUnits: _heldUnits, ...stripped } = both;
    writeFileSync(leaseFile, `${JSON.stringify(stripped, null, 2)}\n`);
    expect(() => readHeldUnits(readLoopLease(root) as LoopLease)).toThrow(
      "disagree about which units are held"
    );
  });

  test("a run without holds keeps its exact lease shape and outcome digest", () => {
    const fixture = repository();
    const { root } = fixture;
    writeFixture(root, "contact.ts", "export const email = 'old';\n");
    commitAll(root, "Base fixture");
    writeFixture(root, "contact.ts", "export const email = 'new';\n");
    const lease = startLoop(root, CONTROLLER, "ship");
    const inventory = captureInventory(root);
    recordShipmentScope(
      root,
      lease.runId,
      CONTROLLER,
      buildPreviewPlan(
        inventory,
        inventory,
        compareSnapshots(inventory, inventory)
      )
    );
    commitAll(root, "Ship the scoped change");
    recordShipmentOutcome(
      root,
      lease.runId,
      CONTROLLER,
      reviewed(draftShipmentOutcome(root, lease.runId).draft)
    );
    const recorded = readLoopLease(root) as LoopLease;
    expect("heldUnits" in recorded).toBe(false);
    expect(() => readOlder(root)).not.toThrow();
    const stored = recorded.shipmentOutcome;
    expect(stored?.receiptDigest).toBe(sha256Json(stored?.receipt));
    const result = finalizeLoop(root, lease.runId, CONTROLLER, "Done.");
    expect(result.outcome).toBe("completed");
    expect("heldUnits" in result.receipt).toBe(false);
  });
});

describe("held-only and renamed held work", () => {
  test("a run that held every unit closes with its work in place and delivery unverified", () => {
    const { lease, root } = primaryFixture();
    for (const unitId of ["feature", "role", "guide"]) {
      approvedHold(root, lease.runId, unitId, [`${unitId}: not ready.`]);
    }
    const { draft } = draftShipmentOutcome(root, lease.runId);
    expect(draft).toMatchObject({ additionalPaths: [], units: [] });
    recordShipmentOutcome(root, lease.runId, CONTROLLER, reviewed(draft));
    const result = finalizeLoop(
      root,
      lease.runId,
      CONTROLLER,
      "Everything is held."
    );
    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.receipt.deliveryStatus).toBe("unverified");
    expect(result.receipt.targetRevision).toBeNull();
    expect(result.receipt.heldUnits?.map((unit) => unit.unitId)).toEqual([
      "feature",
      "role",
      "guide",
    ]);
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toBe(
      "draft feature\n"
    );
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(
      "# Changelog\n\n- Role checks.\n"
    );
  });

  test("an all-held run whose target moved, even by an empty commit, does not close", () => {
    const { lease, root } = primaryFixture();
    for (const unitId of ["feature", "role", "guide"]) {
      approvedHold(root, lease.runId, unitId, [`${unitId}: not ready.`]);
    }
    const base = git(root, ["rev-parse", "origin/main"]);
    const empty = git(root, [
      "commit-tree",
      "-p",
      base,
      "-m",
      "Empty target commit",
      `${base}^{tree}`,
    ]);
    git(root, ["update-ref", "refs/remotes/origin/main", empty]);
    const { draft } = draftShipmentOutcome(root, lease.runId);
    expect(draft).toMatchObject({ additionalPaths: [], units: [] });
    recordShipmentOutcome(root, lease.runId, CONTROLLER, reviewed(draft));
    const result = finalizeLoop(
      root,
      lease.runId,
      CONTROLLER,
      "Everything is held, but the target moved."
    );
    expect(result.outcome).toBe("relinquished");
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toBe(
      "draft feature\n"
    );
  });

  test("a held rename in the primary protects its original path too", () => {
    const fixture = repository();
    const { root } = fixture;
    writeFixture(root, "old-name.ts", "export const name = 1;\n");
    commitAll(root, "Base fixture");
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    git(root, ["mv", "old-name.ts", "new-name.ts"]);
    writeFixture(root, "feature.txt", "draft feature\n");
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
        unitFrom(template, "rename", "Rename the module", ["new-name.ts"]),
      ],
    });
    approvedHold(root, lease.runId, "rename", ["rename: not ready."]);
    const prepared = prepareAgentWorktree(
      root,
      lease.runId,
      "delivery-author",
      "delivery"
    );
    writeFixture(prepared.path, "feature.txt", "draft feature\n");
    git(root, [
      "update-ref",
      "refs/remotes/origin/main",
      commitAll(prepared.path, "Feature"),
    ]);
    recordShipmentOutcome(
      root,
      lease.runId,
      CONTROLLER,
      reviewed(draftShipmentOutcome(root, lease.runId).draft)
    );
    const result = finalizeLoop(
      root,
      lease.runId,
      CONTROLLER,
      "Ship the feature with the rename held."
    );
    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.receipt.deliveryStatus).toBe("verified");
    expect(git(root, ["status", "--porcelain"])).toContain(
      "R  old-name.ts -> new-name.ts"
    );
  });
});

describe("holding a rename or copy against the target", () => {
  // The primary renames old-name.ts to new-name.ts; the target then gets a
  // commit that adds an identical new-name.ts and, when `removeOriginal`
  // holds, also removes old-name.ts.
  const renameRun = (removeOriginal: boolean) => {
    const fixture = repository();
    const { base, root } = fixture;
    writeFixture(root, "old-name.ts", "export const name = 1;\n");
    commitAll(root, "Base fixture");
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    git(root, ["mv", "old-name.ts", "new-name.ts"]);
    writeFixture(root, "feature.txt", "draft feature\n");
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
        unitFrom(template, "rename", "Rename the module", ["new-name.ts"]),
      ],
    });
    const other = join(base, "target-author");
    git(root, ["worktree", "add", "-q", "--detach", other, "origin/main"]);
    writeFixture(other, "new-name.ts", "export const name = 1;\n");
    if (removeOriginal) {
      git(other, ["rm", "-q", "old-name.ts"]);
    }
    git(root, [
      "update-ref",
      "refs/remotes/origin/main",
      commitAll(other, "Target change"),
    ]);
    git(root, ["worktree", "remove", "--force", other]);
    return { lease, root };
  };

  test("holds a rename whose destination the target added while keeping its original", () => {
    const { lease, root } = renameRun(false);
    expect(git(root, ["ls-tree", "--name-only", "origin/main"])).toContain(
      "old-name.ts"
    );
    const held = approvedHold(root, lease.runId, "rename", [
      "rename: not ready.",
    ]);
    expect(held.status).toBe("held");
    expect(held.hold?.unit.id).toBe("rename");
    expect(held.hold?.observation.originalPaths).toEqual([
      { path: "old-name.ts", sourceEntry: null },
    ]);
  });

  test("refuses to hold a rename whose whole result is already in the target", () => {
    const { lease, root } = renameRun(true);
    expect(() =>
      holdUnit(root, lease.runId, "rename", ["rename: not ready."])
    ).toThrow("so nothing is left to hold");
    expect(existsSync(heldFile(root, lease.runId))).toBe(false);
  });

  // With status.renames=copies, the primary copies src.ts to copy.ts and
  // modifies src.ts, so Git reports `C copy.ts <- src.ts` and `M src.ts`.
  // The `copy` unit owns copy.ts and the `source` unit owns src.ts. The
  // target then gets the exact copy.ts, keeping src.ts unmodified, when
  // `targetHasCopy` holds.
  const ORIGINAL = "one\ntwo\nthree\nfour\nfive\n";
  const copyRun = (targetHasCopy: boolean) => {
    const fixture = repository();
    const { base, root } = fixture;
    git(root, ["config", "status.renames", "copies"]);
    writeFixture(root, "src.ts", ORIGINAL);
    commitAll(root, "Base fixture");
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    writeFixture(root, "copy.ts", ORIGINAL);
    writeFixture(root, "src.ts", `${ORIGINAL}six\n`);
    git(root, ["add", "copy.ts", "src.ts"]);
    const lease = startLoop(root, CONTROLLER, "ship");
    const opening = captureInventory(root);
    expect(
      opening.localChanges.find((change) => change.path === "copy.ts")
        ?.originalPath
    ).toBe("src.ts");
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
        unitFrom(template, "copy", "Copy the module", ["copy.ts"]),
        unitFrom(template, "source", "Extend the source", ["src.ts"]),
      ],
    });
    if (targetHasCopy) {
      const other = join(base, "target-author");
      git(root, ["worktree", "add", "-q", "--detach", other, "origin/main"]);
      writeFixture(other, "copy.ts", ORIGINAL);
      git(root, [
        "update-ref",
        "refs/remotes/origin/main",
        commitAll(other, "Target change"),
      ]);
      git(root, ["worktree", "remove", "--force", other]);
    }
    return { lease, root };
  };

  test("refuses to hold a copy whose exact destination the target has, with the source kept", () => {
    const { lease, root } = copyRun(true);
    expect(git(root, ["show", "origin/main:src.ts"])).toBe(ORIGINAL.trim());
    expect(() =>
      holdUnit(root, lease.runId, "copy", ["copy: not ready."])
    ).toThrow("so nothing is left to hold");
    expect(existsSync(heldFile(root, lease.runId))).toBe(false);
  });

  test("holds a copy the target does not have, and its source is not an original path", () => {
    const { lease, root } = copyRun(false);
    const held = approvedHold(root, lease.runId, "copy", ["copy: not ready."]);
    expect(held.status).toBe("held");
    expect(held.hold?.observation.originalPaths).toEqual([]);
  });
});

describe("whole-run recovery on a held run", () => {
  test("close-equivalent refuses a run that held a unit, even when the target now contains it", () => {
    const fixture = repository();
    const { root } = fixture;
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    writeFixture(root, "role/check.ts", "export const check = 1;\n");
    const lease = startLoop(root, CONTROLLER, "ship");
    const opening = captureInventory(root);
    recordShipmentScope(
      root,
      lease.runId,
      CONTROLLER,
      buildPreviewPlan(opening, opening, compareSnapshots(opening, opening))
    );
    const [unit] =
      (readLoopLease(root) as LoopLease).shipmentScope?.plan.units ?? [];
    const head = commitAll(root, "Role checks under review");
    approvedHold(root, lease.runId, unit?.id ?? "", [
      `${unit?.id ?? ""}: failed independent review.`,
    ]);
    git(root, ["update-ref", "refs/remotes/origin/main", head]);
    expect(() =>
      closeLoopTargetEquivalent(
        root,
        lease.runId,
        CONTROLLER,
        APPROVER,
        "The target contains the work.",
        []
      )
    ).toThrow("so loop close-equivalent cannot close it");
    expect(readLoopLease(root)?.runId).toBe(lease.runId);
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
    // A remote-tracking target moves without touching the primary checkout.
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
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
    git(root, [
      "update-ref",
      "refs/remotes/origin/main",
      git(shipping, ["rev-parse", "HEAD"]),
    ]);

    // A filename the shipping unit also scopes does not identify the unit.
    expect(() =>
      holdUnit(root, lease.runId, roleUnit, ["The CHANGELOG.md line is wrong."])
    ).toThrow(`must start with "${roleUnit}: "`);
    expect(() =>
      holdUnit(root, lease.runId, roleUnit, [
        `${roleUnit}: ${shippingUnit} shares the broken changelog line.`,
      ])
    ).toThrow(`also names scoped unit ${shippingUnit}`);
    const held = approvedHold(shipping, lease.runId, roleUnit, [
      `${roleUnit}: failed independent review with two P2 defects.`,
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

  test("keeps a held claim when its checkout is gone, and refuses to hold work the target already has", () => {
    const { claim, lease, role, roleUnit, root, shipping, shippingUnit } =
      claimedFixture();
    commitAll(shipping, "Feature");
    git(root, [
      "update-ref",
      "refs/remotes/origin/main",
      git(shipping, ["rev-parse", "HEAD"]),
    ]);
    // The shipping unit's exact bytes are in the target: nothing to hold.
    expect(() =>
      holdUnit(shipping, lease.runId, shippingUnit, [
        `${shippingUnit}: needs another look.`,
      ])
    ).toThrow("so nothing is left to hold");
    approvedHold(shipping, lease.runId, roleUnit, [
      `${roleUnit}: failed independent review.`,
    ]);
    recordShipmentOutcome(
      shipping,
      lease.runId,
      CONTROLLER,
      reviewed(draftShipmentOutcome(shipping, lease.runId).draft)
    );
    // Someone removes the held checkout; its claim still protects the work.
    git(root, ["worktree", "remove", "--force", role]);
    const result = finalizeLoop(
      shipping,
      lease.runId,
      CONTROLLER,
      "Finish with the held checkout gone."
    );
    expect(
      result.cleanup.releasedClaims.map((item) => item.claimId)
    ).not.toContain(claim.claimId);
    expect(
      readWorktreeCoordination(root).claims.find(
        (item) => item.claimId === claim.claimId
      )?.state
    ).toBe("active");
  });

  test("a run that held every claimed checkout closes only at its exact pinned target", () => {
    const holdBoth = () => {
      const fixture = claimedFixture();
      for (const unitId of [fixture.shippingUnit, fixture.roleUnit]) {
        approvedHold(fixture.shipping, fixture.lease.runId, unitId, [
          `${unitId}: not ready.`,
        ]);
      }
      return fixture;
    };
    const recordEmpty = (shipping: string, runId: string) => {
      const { draft } = draftShipmentOutcome(shipping, runId);
      expect(draft).toMatchObject({ additionalPaths: [], units: [] });
      recordShipmentOutcome(shipping, runId, CONTROLLER, reviewed(draft));
    };

    const moved = holdBoth();
    const base = git(moved.root, ["rev-parse", "origin/main"]);
    git(moved.root, [
      "update-ref",
      "refs/remotes/origin/main",
      git(moved.root, [
        "commit-tree",
        "-p",
        base,
        "-m",
        "Empty target commit",
        `${base}^{tree}`,
      ]),
    ]);
    recordEmpty(moved.shipping, moved.lease.runId);
    expect(() =>
      endLoop(moved.shipping, moved.lease.runId, CONTROLLER)
    ).toThrow("closes only at its pinned target");
    const refused = finalizeLoop(
      moved.shipping,
      moved.lease.runId,
      CONTROLLER,
      "Everything is held, but the target moved."
    );
    expect(refused.outcome).toBe("relinquished");
    expect(refused.receipt.deliveryStatus).toBe("unverified");
    expect(refused.blockers).toContainEqual(
      expect.stringContaining("closes only at its pinned target")
    );

    const pinned = holdBoth();
    recordEmpty(pinned.shipping, pinned.lease.runId);
    const closed = finalizeLoop(
      pinned.shipping,
      pinned.lease.runId,
      CONTROLLER,
      "Everything is held."
    );
    expect(closed.blockers).toEqual([]);
    expect(closed.outcome).toBe("completed");
    expect(closed.receipt.deliveryStatus).toBe("unverified");
    expect(existsSync(join(pinned.role, "role.ts"))).toBe(true);
    expect(existsSync(join(pinned.shipping, "feature.txt"))).toBe(true);
  });

  test("keeps a replacement claim on a held checkout when that checkout is gone", () => {
    const { claim, lease, role, roleUnit, root, shipping } = claimedFixture();
    commitAll(shipping, "Feature");
    git(root, [
      "update-ref",
      "refs/remotes/origin/main",
      git(shipping, ["rev-parse", "HEAD"]),
    ]);
    approvedHold(shipping, lease.runId, roleUnit, [
      `${roleUnit}: failed independent review.`,
    ]);
    recordShipmentOutcome(
      shipping,
      lease.runId,
      CONTROLLER,
      reviewed(draftShipmentOutcome(shipping, lease.runId).draft)
    );
    // The claim observed at hold time is released and replaced, then the
    // held checkout is removed.
    releaseWorktreeClaim(shipping, CONTROLLER, claim.claimId);
    const replacement = claimWorktree(shipping, "another-author", role, "test");
    git(root, ["worktree", "remove", "--force", role]);
    const result = finalizeLoop(
      shipping,
      lease.runId,
      CONTROLLER,
      "Finish with the held checkout gone under a new claim."
    );
    expect(
      result.cleanup.releasedClaims.map((item) => item.claimId)
    ).not.toContain(replacement.claimId);
    expect(
      readWorktreeCoordination(root).claims.find(
        (item) => item.claimId === replacement.claimId
      )?.state
    ).toBe("active");
  });

  test("refuses to observe a held source on a branch name that is not exact", () => {
    const { lease, role, roleUnit, root, shipping } = claimedFixture();
    const evidence = [`${roleUnit}: failed review.`];
    checkOutRawByteBranch(role, 0x80);
    const notExact =
      "is not valid UTF-8 or contains the replacement character U+FFFD";
    expect(() => holdUnit(shipping, lease.runId, roleUnit, evidence)).toThrow(
      notExact
    );
    // A second raw-byte name that decodes alike cannot reuse an approval.
    checkOutRawByteBranch(role, 0x81);
    expect(() =>
      holdUnit(shipping, lease.runId, roleUnit, evidence, {
        approvalReference: "chat:user-approval-4",
        approvedBy: APPROVER,
        observationDigest: "0".repeat(64),
      })
    ).toThrow(notExact);
    expect(existsSync(heldFile(root, lease.runId))).toBe(false);
  });

  test("refuses an approval after the claim changed", () => {
    const { claim, lease, role, roleUnit, shipping } = claimedFixture();
    const evidence = [`${roleUnit}: failed review.`];
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

  test("must start with the unit's ID and name no other unit", () => {
    expect(readinessEvidenceFailure(role, units, [])).toContain(
      "no readiness evidence"
    );
    expect(
      readinessEvidenceFailure(role, units, ["role: failed review."])
    ).toBeNull();
    // Attribution is declared, never inferred from a filename, shared or not.
    for (const item of [
      "role/check.ts fails its test.",
      "CHANGELOG.md is wrong.",
      "Unit role failed review.",
      "role failed review.",
      "role:",
      "role:   ",
      "role-2: failed review.",
    ]) {
      expect(readinessEvidenceFailure(role, units, [item])).toContain(
        'must start with "role: "'
      );
    }
    // A longer ID that contains this one is another unit.
    expect(
      readinessEvidenceFailure(role, units, [
        "role: the same defect as role-2.",
      ])
    ).toContain("also names scoped unit role-2");
    expect(
      readinessEvidenceFailure(role, units, ["role: feature also failed."])
    ).toContain("also names scoped unit feature");
    // An ID inside a path or filename is not a mention of that unit.
    expect(
      readinessEvidenceFailure(role, units, [
        "role: feature.txt.bak and features/x.ts are untouched; see role.ts:12.",
      ])
    ).toBeNull();
    expect(
      readinessEvidenceFailure(role, units, [
        "role: failed review.",
        "Something else failed.",
      ])
    ).toContain('readiness evidence 2 must start with "role: "');
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
          "role: failed review.",
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
    expect(
      readHeldUnits(readLoopLease(root) as LoopLease).map(
        (hold) => hold.unit.id
      )
    ).toEqual(["role"]);
  });
});
