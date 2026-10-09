import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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
  git,
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

  test("plans an uncommitted authoring sidecar as an ordinary unit", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      ".simple-changes-authoring.json",
      `${JSON.stringify({ harnesses: {}, roles: {}, schemaVersion: 1 })}\n`
    );
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current)
    );
    expect(plan.units.flatMap((unit) => unit.paths)).toContain(
      ".simple-changes-authoring.json"
    );
    expect(() => validatePlanConservation(plan, current)).not.toThrow();
    git(fixture.root, ["add", ".simple-changes-authoring.json"]);
    git(fixture.root, ["commit", "-m", "Record authoring preferences"]);
    const clean = captureInventory(fixture.root);
    expect(
      buildPreviewPlan(clean, clean, compareSnapshots(clean, clean)).units
    ).toHaveLength(0);
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

  test("requires clean-checkout dependency verification for manifest changes", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "apps/web/package.json",
      '{"scripts":{"build":"echo build"}}\n'
    );
    writeFixture(
      fixture.root,
      "apps/web/pnpm-lock.yaml",
      "lockfileVersion: '9.0'\n"
    );
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current)
    );

    expect(plan.units.flatMap((unit) => unit.checks)).toContain(
      "Verify a frozen install and production build from an isolated clean checkout"
    );
  });

  test("can exclude one same-relative-path change by worktree", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const secondWorktree = join(fixture.base, "second");
    git(fixture.root, ["worktree", "add", "--detach", secondWorktree]);
    writeFixture(fixture.root, "contact.ts", "export const first = true;\n");
    writeFixture(secondWorktree, "contact.ts", "export const second = true;\n");
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current)
    );
    const scopedPlan: ChangePlan = {
      ...plan,
      exclusions: [
        {
          path: "contact.ts",
          reason: "The second implementation is intentionally superseded.",
          worktreePath: secondWorktree,
        },
      ],
      units: plan.units.filter(
        (unit) => unit.sourceWorktree !== secondWorktree
      ),
    };

    expect(() => validatePlanConservation(scopedPlan, current)).not.toThrow();
  });
});
