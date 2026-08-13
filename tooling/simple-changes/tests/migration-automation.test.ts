import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  applyMigrationAuthorization,
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
import { createTestRepository, type TestRepository } from "./helpers.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
let repositories: TestRepository[] = [];
afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

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
const operationRevision = "supabase/migrations/20260812090000_add_index.sql";
const operationDigest = "1".repeat(64);
const operations: MigrationOperationSet = {
  digest: migrationOperationDigest(operationsList),
  operations: operationsList,
};
const now = new Date();
const applyPlan = {
  ...operations,
  adapter: "exact-operation-argv-v1",
  command: [
    realpathSync("/usr/bin/true"),
    "apply-exact",
    "--target",
    "supabase/primary-db/production",
    "--revision",
    operationRevision,
    "--digest",
    operationDigest,
  ],
  executableDigest: createHash("sha256")
    .update(readFileSync(realpathSync("/usr/bin/true")))
    .digest("hex"),
  expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  issuedAt: now.toISOString(),
  nonce: "migration-plan-0001",
  remoteLedger: {
    ...operations,
    observedAt: now.toISOString(),
    target,
  },
  scope: "exact-listed-operations" as const,
  target,
};

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
  test("atomically consumes and runs one digest-bound adapter snapshot", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const adapter = resolve(fixture.root, "adapter.sh");
    writeFileSync(adapter, "#!/bin/sh\nprintf applied\n", { mode: 0o700 });
    chmodSync(adapter, 0o700);
    const plan = {
      ...applyPlan,
      command: [adapter, ...applyPlan.command.slice(1)],
      executableDigest: createHash("sha256")
        .update(readFileSync(adapter))
        .digest("hex"),
    };
    const decision = decideMigrationAutomation(
      policy("auto-apply-reviewed"),
      review(),
      operations,
      plan
    );
    expect(
      applyMigrationAuthorization(
        resolve(fixture.root, ".git"),
        fixture.root,
        decision
      )
    ).toMatchObject({ exitCode: 0, stdout: "applied" });
    expect(() =>
      applyMigrationAuthorization(
        resolve(fixture.root, ".git"),
        fixture.root,
        decision
      )
    ).toThrow("already consumed");
  });

  test("rejects a symlinked migration authorization state directory", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const outside = resolve(fixture.base, "outside-state");
    mkdirSync(outside);
    symlinkSync(outside, resolve(fixture.root, ".git/simple-changes"));
    expect(() =>
      applyMigrationAuthorization(resolve(fixture.root, ".git"), fixture.root, {
        action: "auto-apply",
        authorizationDigest: "a".repeat(64),
        authorizedByPolicy: true,
        authorizedCommand: applyPlan.command,
        authorizedExecutableDigest: applyPlan.executableDigest,
        authorizedOperations: operations.operations,
        reason: "test",
      })
    ).toThrow("symlink ancestor");
  });
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
        review(),
        operations,
        applyPlan
      )
    ).toMatchObject({
      authorizationDigest: expect.stringMatching(SHA256_PATTERN),
      authorizedCommand: applyPlan.command,
    });
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
    ).toMatchObject({ action: "review-required" });
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
        {
          ...applyPlan,
          ...changed,
          remoteLedger: { ...applyPlan.remoteLedger, ...changed },
        }
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
          ...applyPlan,
          digest: migrationOperationDigest(plannedOperations),
          operations: plannedOperations,
        }
      )
    ).toMatchObject({ action: "review-required", authorizedByPolicy: false });
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review(),
        operations,
        {
          ...applyPlan,
          adapter: "supabase-cli",
          command: ["supabase", "db", "push", "--linked"],
        }
      )
    ).toMatchObject({ action: "review-required", authorizedByPolicy: false });
  });

  test("rejects changed commands, targets, and stale remote ledgers", () => {
    const stale = new Date(now.getTime() - 6 * 60 * 1000).toISOString();
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review(),
        operations,
        {
          ...applyPlan,
          remoteLedger: { ...applyPlan.remoteLedger, observedAt: stale },
        },
        now
      )
    ).toMatchObject({ action: "review-required" });
    expect(
      decideMigrationAutomation(
        policy("auto-apply-reviewed"),
        review(),
        operations,
        {
          ...applyPlan,
          target: { ...target, project: "other-db" },
        },
        now
      )
    ).toMatchObject({ action: "review-required" });
  });
});
