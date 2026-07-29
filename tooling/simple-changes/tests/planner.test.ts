import { afterEach, describe, expect, test } from "bun:test";
import { validatePlanAuthority } from "../../../skills/simple-changes/scripts/lib/authority.ts";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  buildPreviewPlan,
  planFingerprint,
  validatePlanConservation,
} from "../../../skills/simple-changes/scripts/lib/planner.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import type { ChangePlan } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("preview planning", () => {
  test("conserves mixed paths and has a stable fingerprint", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "src/app.ts", "export const app = true;\n");
    writeFixture(fixture.root, "docs/guide.md", "# Guide\n");
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current)
    );
    expect(plan.units).toHaveLength(2);
    expect(() => validatePlanConservation(plan, current)).not.toThrow();
    expect(planFingerprint(plan)).toHaveLength(64);
    expect(planFingerprint(plan)).toBe(planFingerprint(plan));
  });

  test("keeps Sync authority narrower than ordinary local writes", () => {
    const syncUnit: ChangePlan["units"][number] = {
      checks: ["git status --short"],
      dependencies: [],
      id: "sync-main",
      operations: ["fetch-target", "fast-forward-target"],
      outcome: "Fast-forward the clean canonical target.",
      paths: ["."],
      releaseImpact: "none",
      requiredAuthority: ["local-sync"],
      sourceWorktree: "/repo",
      status: "ready",
      title: "Sync main",
    };
    const syncPlan: ChangePlan = {
      baselineDigest: "a".repeat(64),
      exclusions: [],
      generatedAt: new Date().toISOString(),
      mode: "sync",
      mutationCount: 2,
      mutationsAllowed: true,
      preserved: [],
      questions: [],
      repositoryRoot: "/repo",
      request: "sync",
      schemaVersion: 1,
      units: [syncUnit],
      warnings: [],
    };
    expect(() => validatePlanAuthority(syncPlan, DEFAULT_POLICY)).not.toThrow();
    expect(() =>
      validatePlanAuthority(
        {
          ...syncPlan,
          units: [
            {
              ...syncUnit,
              operations: ["push"],
              requiredAuthority: ["proposal-write"],
            },
          ],
        },
        DEFAULT_POLICY
      )
    ).toThrow("unauthorized capability proposal-write");
  });

  test("rejects a plan that loses a changed path", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "src/app.ts", "export const app = true;\n");
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current)
    );
    const invalidPlan = { ...plan, units: [] };
    expect(() => validatePlanConservation(invalidPlan, current)).toThrow(
      "does not conserve"
    );
  });
});
