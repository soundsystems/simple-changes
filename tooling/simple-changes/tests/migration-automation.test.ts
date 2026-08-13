import { describe, expect, test } from "bun:test";
import {
  decideMigrationAutomation,
  type MigrationOperationSet,
  type MigrationReview,
  migrationOperationDigest,
} from "../../../skills/simple-changes/scripts/lib/migration-automation.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import type {
  MigrationTarget,
  RepoPolicy,
} from "../../../skills/simple-changes/scripts/lib/types.ts";

const target: MigrationTarget = {
  environment: "production",
  project: "primary-db",
  provider: "supabase",
};

const operationsList = [
  {
    contentDigest: "1".repeat(64),
    revision: "supabase/migrations/20260812090000_add_index.sql",
  },
];
const operations: MigrationOperationSet = {
  digest: migrationOperationDigest(operationsList),
  operations: operationsList,
};
const applyPlan = { ...operations, scope: "exact-listed-operations" as const };

const policy = (
  migrationHandling: RepoPolicy["migrationHandling"]
): RepoPolicy => ({
  ...DEFAULT_POLICY,
  migrationHandling,
  migrationTargets: [target],
});

const review = (overrides: Partial<MigrationReview> = {}): MigrationReview => ({
  backupOrRollbackVerified: true,
  destructive: false,
  irreversible: false,
  lockHeavy: false,
  operations,
  postApplyVerificationPlanned: true,
  reviewed: true,
  routine: true,
  target,
  unboundedDataChange: false,
  ...overrides,
});

describe("reviewed migration automation", () => {
  test("never applies before technical review", () => {
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review({ reviewed: false }),
        operations,
        applyPlan
      )
    ).toMatchObject({ action: "review-required", authorizedByPolicy: false });
  });

  test("asks after review without requiring a saved automatic target", () => {
    expect(
      decideMigrationAutomation(DEFAULT_POLICY, review(), operations, applyPlan)
    ).toMatchObject({
      action: "request-apply-authorization",
      authorizedByPolicy: false,
    });
  });

  test("auto-applies routine migrations only after review on a bound target", () => {
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed-routine"),
        review(),
        operations,
        applyPlan
      )
    ).toMatchObject({ action: "auto-apply", authorizedByPolicy: true });
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed-routine"),
        review({ routine: false }),
        operations,
        applyPlan
      )
    ).toMatchObject({
      action: "request-apply-authorization",
      authorizedByPolicy: false,
    });
  });

  test("the broader tier auto-applies reviewed eligible non-routine migrations", () => {
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review({ routine: false }),
        operations,
        applyPlan
      )
    ).toMatchObject({ action: "auto-apply", authorizedByPolicy: true });
  });

  test("hard exclusions and unbound targets always require exact authority", () => {
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review({ destructive: true }),
        operations,
        applyPlan
      )
    ).toMatchObject({ action: "request-apply-authorization" });
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review({
          target: { ...target, environment: "staging" },
        }),
        operations,
        applyPlan
      )
    ).toMatchObject({ action: "request-target-authorization" });
  });

  test("fails closed when the reviewed operation identity is stale or changed", () => {
    const changedOperations = [
      {
        contentDigest: "2".repeat(64),
        revision: "supabase/migrations/20260812100000_new_table.sql",
      },
    ];
    const changed = {
      digest: migrationOperationDigest(changedOperations),
      operations: changedOperations,
    };
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review(),
        changed,
        { ...changed, scope: "exact-listed-operations" }
      )
    ).toMatchObject({ action: "review-required", authorizedByPolicy: false });
    const changedContent = [
      {
        contentDigest: "3".repeat(64),
        revision: "supabase/migrations/20260812090000_add_index.sql",
      },
    ];
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review(),
        {
          digest: migrationOperationDigest(changedContent),
          operations: changedContent,
        },
        { ...applyPlan }
      )
    ).toMatchObject({ action: "review-required", authorizedByPolicy: false });
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review({ operations: { ...operations, digest: "0".repeat(64) } }),
        operations,
        applyPlan
      )
    ).toMatchObject({ action: "review-required", authorizedByPolicy: false });
  });

  test("rejects a broad or changed apply plan even when old evidence matches", () => {
    const added = {
      contentDigest: "4".repeat(64),
      revision: "supabase/migrations/20260812110000_added.sql",
    };
    const plannedOperations = [...operationsList, added];
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review(),
        operations,
        {
          digest: migrationOperationDigest(plannedOperations),
          operations: plannedOperations,
          scope: "exact-listed-operations",
        }
      )
    ).toMatchObject({ action: "review-required", authorizedByPolicy: false });
  });
});
