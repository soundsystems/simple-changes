import { afterEach, describe, expect, test } from "bun:test";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  buildPreviewPlan,
  planFingerprint,
  validatePlanConservation,
} from "../../../skills/simple-changes/scripts/lib/planner.ts";
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
