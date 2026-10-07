import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as bunSpawn, spawnSync as bunSpawnSync, sleep } from "bun";
import { CURRENT_GUIDANCE_VERSION } from "../../../skills/simple-changes/scripts/lib/guidance-updates.ts";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  DEFAULT_POLICY,
  writeRepositoryPolicyTrustReceipt,
} from "../../../skills/simple-changes/scripts/lib/policy.ts";
import { SCHEMA_NAMES } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const decoder = new TextDecoder();
setDefaultTimeout(30_000);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(
  testDirectory,
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const ASYNC_CLI_WAIT_ATTEMPTS = 500;
const USAGE_LIST_SEPARATOR = /,\s*(?:or\s+)?|\s+or\s+/u;
const TRAILING_PERIOD = /\.$/u;

interface CliSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stderr?: "pipe";
  stdout?: "pipe";
}

const spawnSync = (
  command: string[],
  options: CliSpawnOptions = {}
): ReturnType<typeof bunSpawnSync> =>
  bunSpawnSync(command, {
    ...options,
    env: {
      ...process.env,
      SIMPLE_CHANGES_SKILL_ROOTS: "",
      ...options.env,
    },
  });

const waitForPath = (path: string): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      if (existsSync(path)) {
        clearInterval(interval);
        resolvePromise();
        return;
      }
      if (attempts >= ASYNC_CLI_WAIT_ATTEMPTS) {
        clearInterval(interval);
        rejectPromise(new Error(`Timed out waiting for ${path}`));
      }
    }, 10);
  });

const waitForGuardedProcess = (
  ownerPath: string
): Promise<{ childProcessId: number; processGroupId: number }> =>
  new Promise((resolvePromise, rejectPromise) => {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as {
          childProcessId?: number;
          processGroupId?: number;
        };
        if (owner.childProcessId && owner.processGroupId) {
          clearInterval(interval);
          resolvePromise({
            childProcessId: owner.childProcessId,
            processGroupId: owner.processGroupId,
          });
          return;
        }
      } catch {
        // The lock owner file may be between creation and its atomic update.
      }
      if (attempts >= ASYNC_CLI_WAIT_ATTEMPTS) {
        clearInterval(interval);
        rejectPromise(new Error(`Timed out waiting for ${ownerPath}`));
      }
    }, 10);
  });

let repositories: TestRepository[] = [];
const paginationCoverage = (
  branches: number,
  branchDigest: string,
  proposals = 0,
  proposalDigest = createHash("sha256").update("[]").digest("hex")
) => ({
  branches: {
    ledgerDigest: createHash("sha256")
      .update(
        JSON.stringify({
          entryDigest: branchDigest,
          pageDigests: [branchDigest],
        })
      )
      .digest("hex"),
    pages: [
      {
        cursorIn: null,
        cursorOut: null,
        itemCount: branches,
        responseDigest: branchDigest,
      },
    ],
  },
  proposalStates: ["closed", "merged", "open"] as const,
  proposals: {
    ledgerDigest: createHash("sha256")
      .update(
        JSON.stringify({
          entryDigest: proposalDigest,
          pageDigests: [proposalDigest],
        })
      )
      .digest("hex"),
    pages: [
      {
        cursorIn: null,
        cursorOut: null,
        itemCount: proposals,
        responseDigest: proposalDigest,
      },
    ],
  },
});

const remoteSnapshot = (targetRevision: string, observedAt: string) => {
  const entries = [{ headRevision: targetRevision, name: "main" }];
  const branchDigest = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  return {
    branches: [
      {
        classification: "canonical-target",
        disposition: "preserved-target",
        evidence: ["Complete GitLab inventory includes main."],
        finalHeadRevision: targetRevision,
        initialHeadRevision: targetRevision,
        name: "main",
        obsoleteProof: null,
        proposals: [],
        protected: true,
      },
    ],
    finalBranchCount: 1,
    finalCoverage: paginationCoverage(1, branchDigest),
    finalInventoryComplete: true,
    initialBranchCount: 1,
    initialCoverage: paginationCoverage(1, branchDigest),
    initialInventoryComplete: true,
    observedAt,
    project: "group/project",
    provider: "gitlab",
    schemaVersion: 1,
    targetBranch: "main",
    targetRevision,
  };
};
const migrationApplyPlan = (
  operationSet: {
    digest: string;
    operations: Array<{ contentDigest: string; revision: string }>;
  },
  target: { environment: string; project: string; provider: string }
) => {
  const issuedAt = new Date();
  return {
    ...operationSet,
    adapter: "exact-operation-argv-v1",
    command: [
      realpathSync("/usr/bin/true"),
      "apply-exact",
      "--target",
      `${target.provider}/${target.project}/${target.environment}`,
      ...operationSet.operations.flatMap((operation) => [
        "--revision",
        operation.revision,
        "--digest",
        operation.contentDigest,
      ]),
    ],
    executableDigest: createHash("sha256")
      .update(readFileSync(realpathSync("/usr/bin/true")))
      .digest("hex"),
    expiresAt: new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString(),
    issuedAt: issuedAt.toISOString(),
    nonce: "migration-plan-0001",
    remoteLedger: {
      ...operationSet,
      observedAt: issuedAt.toISOString(),
      target,
    },
    scope: "exact-listed-operations",
    target,
  };
};

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("contract CLI", () => {
  test("renders one closed permission bundle through the CLI", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "permissions.json",
      `${JSON.stringify([
        {
          authority: "proposal-write",
          consequence: "Exports the reviewed head.",
          operation: "push",
          reason: "The proposal branch must exist remotely.",
          target: "origin gitlab.com/group/repo",
        },
        {
          authority: "production-deploy",
          consequence: "Makes the exact reviewed revision live.",
          operation: "deploy-production",
          reason: "Ship includes production verification.",
          target: "Vercel project simple-changes production",
        },
      ])}\n`
    );

    const result = spawnSync([
      process.execPath,
      cliPath,
      "permissions",
      "bundle",
      resolve(fixture.root, "permissions.json"),
      "--json",
    ]);
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      mode: string;
      requests: unknown[];
    };
    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({ mode: "ship" });
    expect(output.requests).toHaveLength(2);
  });

  test("decides reviewed migration automation from saved exact-target policy", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const revision = "supabase/migrations/20260812090000_add_index.sql";
    writeFixture(
      fixture.root,
      revision,
      "create index example_idx on example(id);\n"
    );
    const operations = [
      {
        contentDigest: createHash("sha256")
          .update(readFileSync(resolve(fixture.root, revision)))
          .digest("hex"),
        revision,
      },
    ];
    const digest = createHash("sha256")
      .update(JSON.stringify(operations))
      .digest("hex");
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify(
        {
          ...DEFAULT_POLICY,
          migrationHandling: "auto-apply-reviewed-routine",
          migrationTargets: [
            {
              environment: "production",
              project: "primary-db",
              provider: "supabase",
            },
          ],
        },
        null,
        2
      )}\n`
    );
    writeRepositoryPolicyTrustReceipt(
      fixture.root,
      resolve(fixture.root, ".git"),
      "test-user",
      "Authorize this exact test policy"
    );
    writeFixture(
      fixture.root,
      "migration-review.json",
      `${JSON.stringify({
        backupOrRollbackVerified: true,
        destructive: false,
        irreversible: false,
        lockHeavy: false,
        operations: { digest, operations },
        postApplyVerificationPlanned: true,
        reviewed: true,
        routine: true,
        target: {
          environment: "production",
          project: "primary-db",
          provider: "supabase",
        },
        unboundedDataChange: false,
      })}\n`
    );
    writeFixture(
      fixture.root,
      "migration-pending.json",
      `${JSON.stringify({ digest, operations })}\n`
    );
    writeFixture(
      fixture.root,
      "migration-apply-plan.json",
      `${JSON.stringify(
        migrationApplyPlan(
          { digest, operations },
          {
            environment: "production",
            project: "primary-db",
            provider: "supabase",
          }
        )
      )}\n`
    );

    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "migration",
        "decision",
        "--state",
        resolve(fixture.root, "migration-review.json"),
        "--pending",
        resolve(fixture.root, "migration-pending.json"),
        "--apply-plan",
        resolve(fixture.root, "migration-apply-plan.json"),
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(result.exitCode).toBe(0);
    const decision = JSON.parse(decoder.decode(result.stdout)) as {
      action: string;
      authorizationDigest: string;
      authorizedByPolicy: boolean;
    };
    expect(decision).toMatchObject({
      action: "auto-apply",
      authorizedByPolicy: true,
    });
    const consume = () =>
      spawnSync(
        [
          process.execPath,
          cliPath,
          "migration",
          "apply",
          "--state",
          resolve(fixture.root, "migration-review.json"),
          "--pending",
          resolve(fixture.root, "migration-pending.json"),
          "--apply-plan",
          resolve(fixture.root, "migration-apply-plan.json"),
          "--json",
          "--repo",
          fixture.root,
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
    expect(consume().exitCode).toBe(0);
    const replay = consume();
    expect(replay.exitCode).not.toBe(0);
    expect(decoder.decode(replay.stderr)).toContain("already been consumed");
  });

  test("rejects a saved migration review when the fresh pending set changes", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const reviewed = [
      { contentDigest: "1".repeat(64), revision: "migrations/a.sql" },
    ];
    writeFixture(fixture.root, "migrations/b.sql", "select 2;\n");
    const pending = [
      {
        contentDigest: createHash("sha256")
          .update(readFileSync(resolve(fixture.root, "migrations/b.sql")))
          .digest("hex"),
        revision: "migrations/b.sql",
      },
    ];
    const digest = (operations: typeof reviewed) =>
      createHash("sha256").update(JSON.stringify(operations)).digest("hex");
    writeFixture(
      fixture.root,
      "migration-review.json",
      `${JSON.stringify({
        backupOrRollbackVerified: true,
        destructive: false,
        irreversible: false,
        lockHeavy: false,
        operations: { digest: digest(reviewed), operations: reviewed },
        postApplyVerificationPlanned: true,
        reviewed: true,
        routine: true,
        target: {
          environment: "production",
          project: "primary-db",
          provider: "supabase",
        },
        unboundedDataChange: false,
      })}\n`
    );
    writeFixture(
      fixture.root,
      "migration-pending.json",
      `${JSON.stringify({ digest: digest(pending), operations: pending })}\n`
    );
    writeFixture(
      fixture.root,
      "migration-apply-plan.json",
      `${JSON.stringify(
        migrationApplyPlan(
          { digest: digest(pending), operations: pending },
          {
            environment: "production",
            project: "primary-db",
            provider: "supabase",
          }
        )
      )}\n`
    );
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "migration",
        "decision",
        "--state",
        resolve(fixture.root, "migration-review.json"),
        "--pending",
        resolve(fixture.root, "migration-pending.json"),
        "--apply-plan",
        resolve(fixture.root, "migration-apply-plan.json"),
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(result.stdout))).toMatchObject({
      action: "review-required",
      authorizedByPolicy: false,
    });
  });

  test("rejects replayed pending evidence after migration content changes", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const revision = "migrations/change.sql";
    writeFixture(fixture.root, revision, "select 1;\n");
    const operations = [
      {
        contentDigest: createHash("sha256")
          .update(readFileSync(resolve(fixture.root, revision)))
          .digest("hex"),
        revision,
      },
    ];
    const digest = createHash("sha256")
      .update(JSON.stringify(operations))
      .digest("hex");
    const review = {
      backupOrRollbackVerified: true,
      destructive: false,
      irreversible: false,
      lockHeavy: false,
      operations: { digest, operations },
      postApplyVerificationPlanned: true,
      reviewed: true,
      routine: true,
      target: {
        environment: "production",
        project: "db",
        provider: "supabase",
      },
      unboundedDataChange: false,
    };
    writeFixture(fixture.root, "review.json", `${JSON.stringify(review)}\n`);
    writeFixture(
      fixture.root,
      "pending.json",
      `${JSON.stringify({ digest, operations })}\n`
    );
    writeFixture(
      fixture.root,
      "apply-plan.json",
      `${JSON.stringify(
        migrationApplyPlan(
          { digest, operations },
          {
            environment: "production",
            project: "db",
            provider: "supabase",
          }
        )
      )}\n`
    );
    writeFixture(fixture.root, revision, "select 2;\n");
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "migration",
        "decision",
        "--state",
        resolve(fixture.root, "review.json"),
        "--pending",
        resolve(fixture.root, "pending.json"),
        "--apply-plan",
        resolve(fixture.root, "apply-plan.json"),
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).toBe(3);
    expect(decoder.decode(result.stderr)).toContain(
      "content changed after evidence capture"
    );
  });

  test("rejects replayed review and pending evidence when the apply plan adds an operation", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const operation = {
      contentDigest: "1".repeat(64),
      revision: "migrations/a.sql",
    };
    const added = {
      contentDigest: "2".repeat(64),
      revision: "migrations/b.sql",
    };
    writeFixture(fixture.root, operation.revision, "select 1;\n");
    operation.contentDigest = createHash("sha256")
      .update(readFileSync(resolve(fixture.root, operation.revision)))
      .digest("hex");
    writeFixture(fixture.root, added.revision, "select 2;\n");
    added.contentDigest = createHash("sha256")
      .update(readFileSync(resolve(fixture.root, added.revision)))
      .digest("hex");
    const digest = (operations: (typeof operation)[]) =>
      createHash("sha256").update(JSON.stringify(operations)).digest("hex");
    const oldOperations = [operation];
    const applyOperations = [operation, added];
    const review = {
      backupOrRollbackVerified: true,
      destructive: false,
      irreversible: false,
      lockHeavy: false,
      operations: { digest: digest(oldOperations), operations: oldOperations },
      postApplyVerificationPlanned: true,
      reviewed: true,
      routine: true,
      target: {
        environment: "production",
        project: "db",
        provider: "supabase",
      },
      unboundedDataChange: false,
    };
    writeFixture(fixture.root, "review.json", `${JSON.stringify(review)}\n`);
    writeFixture(
      fixture.root,
      "pending.json",
      `${JSON.stringify(review.operations)}\n`
    );
    writeFixture(
      fixture.root,
      "apply.json",
      `${JSON.stringify(
        migrationApplyPlan(
          { digest: digest(applyOperations), operations: applyOperations },
          {
            environment: "production",
            project: "db",
            provider: "supabase",
          }
        )
      )}\n`
    );
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "migration",
        "decision",
        "--state",
        resolve(fixture.root, "review.json"),
        "--pending",
        resolve(fixture.root, "pending.json"),
        "--apply-plan",
        resolve(fixture.root, "apply.json"),
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(result.stdout))).toMatchObject({
      action: "review-required",
      authorizedByPolicy: false,
    });
  });

  test("finalizes an incomplete lease as relinquished and resumes it", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "first-controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const { lease } = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    const prepared = spawnSync(
      [
        process.execPath,
        cliPath,
        "prepare-agent",
        "--run-id",
        lease.runId,
        "--agent-id",
        "unfinished-author",
        "--purpose",
        "unfinished-unit",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(prepared.exitCode).toBe(0);
    const { path: preparedPath } = JSON.parse(
      decoder.decode(prepared.stdout)
    ) as { path: string };
    writeFixture(preparedPath, "unfinished.txt", "still being authored\n");
    const finalized = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "finalize",
        "--run-id",
        lease.runId,
        "--agent-id",
        "first-controller",
        "--reason",
        "The agent turn ended with shipping work still open.",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(finalized.exitCode).toBe(5);
    expect(JSON.parse(decoder.decode(finalized.stderr))).toMatchObject({
      exitCode: 5,
      ok: false,
    });
    expect(decoder.decode(finalized.stderr)).toContain("Relinquished");

    const resumed = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "resume",
        "--agent-id",
        "next-controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(resumed.stdout))).toMatchObject({
      lease: {
        controller: { status: "active" },
        mode: "ship",
        ownerAgentId: "next-controller",
        runId: lease.runId,
      },
    });
  });

  test("records and resumes Emergency Shipping state through the CLI", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const { lease } = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    const candidateRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFixture(
      fixture.root,
      "emergency.json",
      `${JSON.stringify({
        artifactEquivalenceProven: false,
        authoritySource: null,
        breakGlassAuthorized: false,
        candidateArtifactId: null,
        candidateRevision,
        candidateVerifiedHealthy: false,
        canonicalArtifactId: null,
        canonicalRevision: null,
        changelogReconciled: false,
        cleanupCompleted: false,
        deployedArtifactId: null,
        deployedRevision: null,
        evidence: ["urgency-language"],
        finalVerificationPassed: false,
        focusedChecksPassed: false,
        independentReview: "pending",
        mergeCompleted: false,
        mode: "expedited",
        previousProductionRevision: null,
        productionAuthorized: false,
        redeployDecision: "pending",
        rollbackAnchorRecorded: false,
        rollbackSupported: false,
        status: "ready",
      })}\n`
    );

    const recorded = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "emergency",
        "record",
        "--run-id",
        lease.runId,
        "--agent-id",
        "controller",
        "--state",
        resolve(fixture.root, "emergency.json"),
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(recorded.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(recorded.stdout))).toMatchObject({
      decision: { action: "request-production-approval" },
      state: { candidateRevision, status: "ready" },
      verification: { ok: true },
    });

    const resumed = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "emergency",
        "status",
        "--run-id",
        lease.runId,
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(resumed.stdout))).toMatchObject({
      decision: { action: "request-production-approval" },
      state: { candidateRevision, status: "ready" },
    });

    writeFixture(
      fixture.root,
      "break-glass.json",
      `${JSON.stringify({
        ...JSON.parse(
          readFileSync(resolve(fixture.root, "emergency.json"), "utf8")
        ),
        authoritySource: "explicit-current-request",
        breakGlassAuthorized: true,
        evidence: ["urgency-language", "deploy-before-review"],
        mode: "break-glass",
        rollbackSupported: true,
      })}\n`
    );
    const upgraded = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "emergency",
        "record",
        "--run-id",
        lease.runId,
        "--agent-id",
        "controller",
        "--state",
        resolve(fixture.root, "break-glass.json"),
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(upgraded.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(upgraded.stdout))).toMatchObject({
      state: {
        breakGlassAuthorized: true,
        mode: "break-glass",
        rollbackSupported: true,
      },
    });
  });

  test("holds the loop lock for the full guarded command", async () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const { lease } = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    const releasePath = resolve(fixture.base, "release-guarded-child");
    const running = bunSpawn(
      [
        process.execPath,
        cliPath,
        "loop",
        "exec",
        "--run-id",
        lease.runId,
        "--agent-id",
        "controller",
        "--repo",
        fixture.root,
        "--",
        process.execPath,
        "-e",
        `import { existsSync } from "node:fs";
const deadline = Date.now() + 120_000;
while (!existsSync(process.env.SIMPLE_CHANGES_TEST_RELEASE_PATH)) {
  if (Date.now() > deadline) { process.exit(2); }
  await Bun.sleep(10);
}`,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_SKILL_ROOTS: "",
          SIMPLE_CHANGES_TEST_RELEASE_PATH: releasePath,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    try {
      const lockPath = resolve(
        fixture.root,
        ".git/simple-changes/active-loop.lock"
      );
      await waitForPath(lockPath);
      expect(existsSync(lockPath)).toBe(true);
      const guardedProcess = await waitForGuardedProcess(
        resolve(lockPath, "owner.json")
      );
      expect(guardedProcess.processGroupId).toBe(guardedProcess.childProcessId);

      const competing = spawnSync(
        [
          process.execPath,
          cliPath,
          "loop",
          "guard",
          "--run-id",
          lease.runId,
          "--agent-id",
          "controller",
          "--repo",
          fixture.root,
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      expect(competing.exitCode).toBe(5);
      expect(decoder.decode(competing.stderr)).toContain("state is busy");
      expect(existsSync(releasePath)).toBe(false);
      writeFileSync(releasePath, "release\n");
      expect(await running.exited).toBe(0);
    } finally {
      // Release even when a contention assertion fails, so the child cannot
      // outlive this fixture and contaminate the following tests.
      writeFileSync(releasePath, "release\n");
      await running.exited;
    }
  }, 20_000);

  test("starts a lease and prepares an isolated agent worktree", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "integrate",
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const startedOutput = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    expect(started.exitCode).toBe(0);

    const prepared = spawnSync(
      [
        process.execPath,
        cliPath,
        "prepare-agent",
        "--run-id",
        startedOutput.lease.runId,
        "--agent-id",
        "author",
        "--purpose",
        "focused unit",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const preparedOutput = JSON.parse(decoder.decode(prepared.stdout)) as {
      created: boolean;
      path: string;
    };
    expect(prepared.exitCode).toBe(0);
    expect(preparedOutput.created).toBe(true);
    expect(preparedOutput.path).not.toBe(fixture.root);

    const guarded = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "guard",
        "--run-id",
        startedOutput.lease.runId,
        "--agent-id",
        "author",
        "--json",
        "--repo",
        preparedOutput.path,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(guarded.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(guarded.stdout))).toMatchObject({
      active: true,
      ok: true,
    });

    const executed = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "exec",
        "--run-id",
        startedOutput.lease.runId,
        "--agent-id",
        "author",
        "--json",
        "--repo",
        preparedOutput.path,
        "--",
        process.execPath,
        "-e",
        "await Bun.write('cli-atomic.txt', 'ok\\n')",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(executed.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(executed.stdout))).toMatchObject({
      result: { exitCode: 0 },
      verification: { ok: true },
    });
    expect(
      readFileSync(resolve(preparedOutput.path, "cli-atomic.txt"), "utf8")
    ).toBe("ok\n");
  }, 30_000);

  test("claims, pauses, and adopts a concurrent worktree through the CLI", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "integrate",
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const startedOutput = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    const concurrent = resolve(fixture.base, "cli-concurrent");
    git(fixture.root, ["worktree", "add", "-b", "cli-concurrent", concurrent]);

    const claimed = spawnSync(
      [
        process.execPath,
        cliPath,
        "worktree",
        "claim",
        "--agent-id",
        "owner",
        "--worktree",
        concurrent,
        "--adapter",
        "claude-code",
        "--owner-ref",
        "session-123",
        "--json",
        "--repo",
        concurrent,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(claimed.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(claimed.stdout))).toMatchObject({
      capabilityProbe: { automatic: true },
      claim: { owner: { ownerRef: "session-123" } },
    });
    const claimedOutput = JSON.parse(decoder.decode(claimed.stdout)) as {
      claim: { claimId: string };
    };

    const requested = spawnSync(
      [
        process.execPath,
        cliPath,
        "worktree",
        "request",
        "--claim-id",
        claimedOutput.claim.claimId,
        "--run-id",
        startedOutput.lease.runId,
        "--request-action",
        "request-pause",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(requested.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(requested.stdout))).toMatchObject({
      capabilityProbe: { automatic: true },
      request: {
        action: "request-pause",
        claimId: claimedOutput.claim.claimId,
        owner: { ownerRef: "session-123" },
        runId: startedOutput.lease.runId,
      },
    });

    const paused = spawnSync(
      [
        process.execPath,
        cliPath,
        "worktree",
        "pause",
        "--agent-id",
        "owner",
        "--worktree",
        concurrent,
        "--run-id",
        startedOutput.lease.runId,
        "--disposition",
        "preserve-in-place",
        "--reason",
        "Pause for CLI adoption",
        "--json",
        "--repo",
        concurrent,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const pauseReceipt = JSON.parse(decoder.decode(paused.stdout)) as {
      receiptId: string;
    };
    expect(paused.exitCode).toBe(0);

    const adopted = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "adopt-worktree",
        "--run-id",
        startedOutput.lease.runId,
        "--agent-id",
        "controller",
        "--pause-receipt",
        pauseReceipt.receiptId,
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(adopted.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(adopted.stdout))).toMatchObject({
      lease: {
        worktrees: expect.arrayContaining([
          expect.objectContaining({
            coordinationState: "adopted-preserved",
            mutationAllowed: false,
            path: concurrent,
          }),
        ]),
      },
    });
  }, 30_000);

  test("records an audited opening-worktree removal disposition", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const obsolete = resolve(fixture.base, "obsolete");
    git(fixture.root, ["worktree", "add", "-b", "obsolete-work", obsolete]);
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "reconcile",
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const startedOutput = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    const worktree = captureInventory(fixture.root).worktrees.find(
      (item) => item.path === obsolete
    );
    expect(worktree).toBeDefined();

    const disposed = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "dispose-worktree",
        "--run-id",
        startedOutput.lease.runId,
        "--agent-id",
        "controller",
        "--worktree",
        obsolete,
        "--status-digest",
        worktree?.changeDigest ?? "",
        "--approved-by",
        "user",
        "--reason",
        "Audited obsolete with no unique work",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(disposed.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(disposed.stdout))).toMatchObject({
      lease: {
        dispositions: [
          {
            outcome: "remove-after-audit",
            path: obsolete,
            uniqueCommitCount: 0,
          },
        ],
      },
    });

    git(fixture.root, ["worktree", "remove", obsolete]);
    const verified = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "verify",
        "--run-id",
        startedOutput.lease.runId,
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(verified.stdout))).toMatchObject({
      ok: true,
    });
  }, 20_000);

  test("records a complete remote-branch reconciliation receipt", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const branchDigest = createHash("sha256")
      .update(JSON.stringify([{ headRevision: targetRevision, name: "main" }]))
      .digest("hex");
    const openingRemoteInventory = {
      branches: [
        {
          classification: "canonical-target",
          disposition: "preserved-target",
          evidence: ["Opening GitLab inventory includes main."],
          finalHeadRevision: targetRevision,
          initialHeadRevision: targetRevision,
          name: "main",
          obsoleteProof: null,
          proposals: [],
          protected: true,
        },
      ],
      finalBranchCount: 1,
      finalCoverage: paginationCoverage(1, branchDigest),
      finalInventoryComplete: true,
      initialBranchCount: 1,
      initialCoverage: paginationCoverage(1, branchDigest),
      initialInventoryComplete: true,
      observedAt: new Date().toISOString(),
      project: "group/project",
      provider: "gitlab",
      schemaVersion: 1,
      targetBranch: "main",
      targetRevision,
    };
    writeFixture(
      fixture.root,
      "opening-remote-branches.json",
      `${JSON.stringify(openingRemoteInventory, null, 2)}\n`
    );
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "reconcile",
        "--agent-id",
        "controller",
        "--opening-remote-inventory",
        resolve(fixture.root, "opening-remote-branches.json"),
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const {
      lease: { runId },
    } = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    writeFixture(
      fixture.root,
      "remote-branches.json",
      `${JSON.stringify(
        {
          branches: [
            {
              classification: "canonical-target",
              disposition: "preserved-target",
              evidence: ["Final GitLab inventory includes main."],
              finalHeadRevision: targetRevision,
              initialHeadRevision: targetRevision,
              name: "main",
              obsoleteProof: null,
              proposals: [],
              protected: true,
            },
          ],
          finalBranchCount: 1,
          finalCoverage: paginationCoverage(1, branchDigest),
          finalInventoryComplete: true,
          initialBranchCount: 1,
          initialCoverage: paginationCoverage(1, branchDigest),
          initialInventoryComplete: true,
          observedAt: new Date().toISOString(),
          project: "group/project",
          provider: "gitlab",
          schemaVersion: 1,
          targetBranch: "main",
          targetRevision,
        },
        null,
        2
      )}\n`
    );

    const reconciled = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "reconcile-remote-branches",
        "--run-id",
        runId,
        "--agent-id",
        "controller",
        "--receipt",
        resolve(fixture.root, "remote-branches.json"),
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(reconciled.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(reconciled.stdout))).toMatchObject({
      lease: {
        remoteBranchReconciliation: {
          project: "group/project",
          targetRevision,
        },
      },
    });
  }, 30_000);

  test("closes completed legacy bookkeeping through the explicit CLI recovery", async () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "git@gitlab.com:group/project.git",
    ]);
    const targetRevision = git(fixture.root, ["rev-parse", "HEAD"]);
    const firstObservedAt = new Date(Date.now() - 2000).toISOString();
    const first = remoteSnapshot(targetRevision, firstObservedAt);
    const openingPath = resolve(fixture.base, "legacy-opening.json");
    writeFileSync(openingPath, `${JSON.stringify(first, null, 2)}\n`, "utf8");
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "controller",
        "--opening-remote-inventory",
        openingPath,
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const { lease } = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    const { commonGitDirectory } = captureInventory(fixture.root).repository;
    const leasePath = resolve(
      commonGitDirectory,
      "simple-changes",
      "active-loop.json"
    );
    const stored = JSON.parse(readFileSync(leasePath, "utf8")) as Record<
      string,
      unknown
    >;
    Reflect.deleteProperty(stored, "openingRemoteInventory");
    // Reproduce the pre-capture ledger, rather than a new Ship ledger.
    stored.shipmentScopeRequired = false;
    Reflect.deleteProperty(stored, "shipmentScope");
    writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const ordinaryEnd = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "end",
        "--run-id",
        lease.runId,
        "--agent-id",
        "controller",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(ordinaryEnd.exitCode).not.toBe(0);
    expect(decoder.decode(ordinaryEnd.stderr)).toContain(
      "only approved post-cleanup recovery may close it"
    );

    const finalized = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "finalize",
        "--run-id",
        lease.runId,
        "--agent-id",
        "controller",
        "--reason",
        "Cleanup is complete but opening evidence is unavailable.",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(finalized.exitCode).toBe(5);
    const resumed = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "resume",
        "--agent-id",
        "recovery-controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(resumed.exitCode).toBe(0);
    const observeClaims = () => {
      const observed = spawnSync(
        [
          process.execPath,
          cliPath,
          "worktree",
          "observe",
          "--json",
          "--repo",
          fixture.root,
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      expect(observed.exitCode).toBe(0);
      return JSON.parse(decoder.decode(observed.stdout)) as {
        activeClaimCount: 0;
        digest: string;
        observedAt: string;
      };
    };
    const firstClaimObservation = observeClaims();
    await sleep(2);
    const secondClaimObservation = observeClaims();
    const receipt = {
      approvedBy: "user",
      authority: "close-only",
      firstClaimObservation,
      firstFinalInventory: first,
      openingEvidenceUnavailableReason:
        "The legacy runtime did not save opening provider evidence.",
      project: "group/project",
      provider: "gitlab",
      reason: "Cleanup is already complete; close bookkeeping only.",
      schemaVersion: 1,
      secondClaimObservation,
      secondFinalInventory: remoteSnapshot(
        targetRevision,
        new Date(Date.parse(firstObservedAt) + 1000).toISOString()
      ),
      targetBranch: "main",
      targetRevision,
    };
    const receiptPath = resolve(fixture.base, "post-cleanup-recovery.json");
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const recoveryCommand = [
      process.execPath,
      cliPath,
      "loop",
      "recover-post-cleanup",
      "--run-id",
      lease.runId,
      "--agent-id",
      "recovery-controller",
      "--receipt",
      receiptPath,
      "--repo",
      fixture.root,
    ];
    const crashed = spawnSync(recoveryCommand, {
      env: {
        NODE_ENV: "test",
        SIMPLE_CHANGES_TEST_CRASH_AFTER_POST_CLEANUP_INTENT: lease.runId,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(crashed.exitCode).not.toBe(0);
    await sleep(5100);
    const lockRecovery = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "recover",
        "--agent-id",
        "recovery-controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(lockRecovery.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(lockRecovery.stdout))).toMatchObject({
      coordinationRecovered: true,
      recovered: true,
    });
    const recovered = spawnSync(recoveryCommand, {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(decoder.decode(recovered.stderr)).toBe("");
    expect(recovered.exitCode).toBe(0);
    expect(decoder.decode(recovered.stdout)).toBe(
      "Cleanup was already complete; Simple Changes repaired and closed its old bookkeeping record.\n"
    );
    const status = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "status",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(JSON.parse(decoder.decode(status.stdout))).toMatchObject({
      lease: null,
      verification: { active: false, ok: true, violations: [] },
    });
  }, 60_000);

  test("retains an exact clean worktree through the CLI", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const startedOutput = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    const walkthrough = resolve(fixture.base, "driver-walkthrough");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "driver-walkthrough",
      walkthrough,
    ]);
    const worktree = captureInventory(fixture.root).worktrees.find(
      (item) => item.path === walkthrough
    );

    const retained = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "retain-worktree",
        "--run-id",
        startedOutput.lease.runId,
        "--agent-id",
        "controller",
        "--worktree",
        walkthrough,
        "--status-digest",
        worktree?.changeDigest ?? "",
        "--approved-by",
        "user",
        "--reason",
        "Keep unrelated walkthrough work out of this shipment",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(retained.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(retained.stdout))).toMatchObject({
      lease: {
        worktrees: expect.arrayContaining([
          expect.objectContaining({
            mutationAllowed: false,
            path: walkthrough,
            role: "retained",
          }),
        ]),
      },
    });
  }, 30_000);

  test("blocks a new authoring agent in the controller checkout", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "integrate",
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(started.exitCode).toBe(0);

    const blocked = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "queue",
        "--agent-id",
        "new-author",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(blocked.exitCode).toBe(5);
    expect(decoder.decode(blocked.stderr)).toContain(
      "not allowed to run guarded integration mutations"
    );
  });

  test("reports onboarding before a first write-capable run", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const configurationRoot = resolve(fixture.base, "configuration");
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "queue",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      inferredDefaultFinish: string;
      onboardingRequired: boolean;
      writeCapable: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      inferredDefaultFinish: "open-change-request",
      onboardingRequired: true,
      writeCapable: true,
    });
  });

  test("reports a required Simple Changelogs update before creating a shipment loop", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = resolve(fixture.base, "global-skills");
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify(
        {
          ...DEFAULT_POLICY,
          guidance: { disposition: "accepted", version: 4 },
        },
        null,
        2
      )}\n`
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"guidance":{"version":8,"backfillStatus":"deferred"}}\n'
    );
    writeFixture(
      skillRoot,
      "simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n\nCurrent guidance version: 9\n"
    );
    writeFixture(
      skillRoot,
      "simple-changelogs/references/guidance-updates.md",
      "# Guidance Updates\n\n## Guidance 9\n\nProduction Web deployment is now a release boundary. Deployed work must leave Unreleased first. Exact retries reuse the same release version.\n"
    );

    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "ship",
        "--changelog-required",
        "--repo",
        fixture.root,
      ],
      {
        env: { SIMPLE_CHANGES_SKILL_ROOTS: skillRoot },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const output = decoder.decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("**Simple Changes has recently been updated.**");
    expect(output).toContain(
      "**Simple Changelogs has recently been updated.**"
    );
    expect(output).toContain(
      "Resolve the required update choice before continuing."
    );
    expect(output).toContain("- Resolve required choices (Recommended)");
    expect(output).toContain("- Short walkthrough");
    expect(output).toContain("- Expanded walkthrough");
    expect(output).not.toContain("Available actions:");
    expect(output).toContain("Action required before loop start: yes");
    expect(output).toContain(
      "Resolve this owner-controlled update before starting the Simple Changes shipment loop."
    );
    expect(
      existsSync(resolve(fixture.root, ".git/simple-changes/active-loop.json"))
    ).toBe(false);

    const directStart = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "controller",
        "--changelog-required",
        "--repo",
        fixture.root,
      ],
      {
        env: { SIMPLE_CHANGES_SKILL_ROOTS: skillRoot },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    expect(directStart.exitCode).toBe(5);
    expect(decoder.decode(directStart.stderr)).toContain(
      "every required update choice before loop start"
    );
    expect(
      existsSync(resolve(fixture.root, ".git/simple-changes/active-loop.json"))
    ).toBe(false);
  });

  test("records one installed-update decision and unblocks initialization", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify(
        {
          ...DEFAULT_POLICY,
          guidance: { disposition: "accepted", version: 1 },
        },
        null,
        2
      )}\n`
    );

    const notice = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "queue",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const noticeOutput = decoder.decode(notice.stdout);
    expect(notice.exitCode).toBe(0);
    expect(noticeOutput).toContain("No new settings answers are required.");
    expect(noticeOutput).toContain("What matters:");
    expect(noticeOutput).toContain(
      "- Continue with current settings (Recommended)"
    );
    expect(noticeOutput).toContain("- Short walkthrough");
    expect(noticeOutput).toContain("- Expanded walkthrough");
    expect(noticeOutput.indexOf("What matters:")).toBeLessThan(
      noticeOutput.indexOf("How would you like to continue?")
    );
    expect(noticeOutput).not.toContain("Explain every new ability");

    const pending = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "queue",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const pendingOutput = JSON.parse(decoder.decode(pending.stdout)) as {
      guidanceUpdate: { status: string };
      mutationAllowed: boolean;
    };
    expect(pending.exitCode).toBe(0);
    expect(pendingOutput).toMatchObject({
      guidanceUpdate: { status: "update-available" },
      mutationAllowed: false,
    });

    const acknowledged = spawnSync(
      [
        process.execPath,
        cliPath,
        "acknowledge-update",
        "--guidance-decision",
        "deferred",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(acknowledged.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(acknowledged.stdout))).toMatchObject({
      currentVersion: CURRENT_GUIDANCE_VERSION,
      disposition: "deferred",
      previousVersion: 1,
      written: true,
    });
    expect(
      JSON.parse(
        readFileSync(resolve(fixture.root, ".simple-changes.json"), "utf8")
      )
    ).toMatchObject({
      guidance: { disposition: "deferred", version: CURRENT_GUIDANCE_VERSION },
    });

    const resumed = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "queue",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(resumed.stdout))).toMatchObject({
      guidanceUpdate: { status: "current" },
      mutationAllowed: true,
    });
  });

  test("does not onboard a first preview run", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "preview",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      onboardingRequired: boolean;
      writeCapable: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      firstUseWalkthroughAvailable: true,
      onboardingRequired: false,
      writeCapable: false,
    });

    const conversational = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "preview",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(decoder.decode(conversational.stdout)).toContain(
      "New to Simple Changes? I can give you a quick walkthrough of everything it can do."
    );
  });

  test("accepts first-run Sync with fixed preservation guardrails", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "sync",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      mode: string;
      mutationAllowed: boolean;
      onboardingRequired: boolean;
      writeCapable: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      mode: "sync",
      mutationAllowed: true,
      onboardingRequired: false,
      writeCapable: true,
    });
  });

  test("automatically runs setup during non-interactive initialization when answers are complete", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const configurationRoot = resolve(fixture.base, "configuration");
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "integrate",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      policy: {
        defaultFinish: string;
      };
      written: boolean;
    };
    const policy = JSON.parse(
      readFileSync(resolve(fixture.root, ".simple-changes.json"), "utf8")
    ) as {
      defaultFinish: string;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      policy: {
        defaultFinish: "integrate",
      },
      written: true,
    });
    expect(policy.defaultFinish).toBe("integrate");

    const repeated = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "ship",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const repeatedOutput = JSON.parse(decoder.decode(repeated.stdout)) as {
      onboardingRequired: boolean;
      policySource: string;
    };
    expect(repeated.exitCode).toBe(0);
    expect(repeatedOutput).toMatchObject({
      onboardingRequired: false,
      policySource: "repository",
    });
  });

  test("supports global personal setup outside a Git repository", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const configurationRoot = resolve(fixture.base, "configuration");
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "ship",
        "--production",
        "ask",
        "--shipping-mode",
        "standard",
        "--git-push-authorization",
        "configure-harness",
        "--acknowledge-push-scope",
        "--questions",
        "blocking-only",
        "--scope",
        "user",
        "--yes",
        "--json",
      ],
      {
        cwd: fixture.base,
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const personalPath = resolve(
      configurationRoot,
      "simple-changes",
      "preferences.json"
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      path: string;
      policy: {
        defaultFinish: string;
      };
      written: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      path: personalPath,
      policy: {
        defaultFinish: "ship",
      },
      written: true,
    });

    const initialized = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "queue",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const initializedOutput = JSON.parse(
      decoder.decode(initialized.stdout)
    ) as {
      onboardingRequired: boolean;
      policySource: string;
    };
    expect(initialized.exitCode).toBe(0);
    expect(initializedOutput).toMatchObject({
      onboardingRequired: false,
      policySource: "user",
    });
  });

  test("rejects repository-scoped setup outside a Git repository", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
      ],
      {
        cwd: fixture.base,
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain(
      "Repository-scoped setup requires a Git repository"
    );
  });

  test("requires an explicit changelog preference when surfaces are present", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "CHANGELOG.md", "# Changelog\n");
    const incomplete = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "run",
        "--yes",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_SKILL_ROOTS: "",
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    expect(incomplete.exitCode).toBe(2);
    expect(decoder.decode(incomplete.stderr)).toContain(
      "--changelog when relevant"
    );

    const unoffered = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--changelog",
        "delegate-if-available",
        "--questions",
        "blocking-only",
        "--scope",
        "run",
        "--yes",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_SKILL_ROOTS: "",
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    expect(unoffered.exitCode).toBe(2);
    expect(decoder.decode(unoffered.stderr)).toContain(
      "--changelog-install after offering the Simple Changelogs install"
    );

    const complete = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--changelog",
        "delegate-if-available",
        "--changelog-install",
        "decline",
        "--questions",
        "blocking-only",
        "--scope",
        "run",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: {
          ...process.env,
          SIMPLE_CHANGES_SKILL_ROOTS: "",
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const output = JSON.parse(decoder.decode(complete.stdout)) as {
      changelogInstall: {
        command: string | null;
        decision: string | null;
        distribution: string | null;
        offered: boolean;
      };
      policy: {
        changelogHandling: string;
        changelogInstall?: unknown;
      };
    };

    expect(complete.exitCode).toBe(0);
    expect(output.policy.changelogHandling).toBe("delegate-if-available");
    expect(output.policy).not.toHaveProperty("changelogInstall");
    expect(output.changelogInstall).toEqual({
      command:
        "bunx skills add https://gitlab.com/soundsystems/simple-changelogs --skill simple-changelogs",
      decision: "declined",
      distribution: null,
      offered: true,
    });
  });

  test("reports the Simple Changelogs install consent and exact distribution command", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"distribution":"web","guidance":{"version":8}}\n'
    );
    const expectedCommand =
      "bunx skills add https://gitlab.com/soundsystems/simple-changelogs --skill simple-changelogs-web";

    const status = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "integrate",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const statusOutput = JSON.parse(decoder.decode(status.stdout)) as {
      changelogInstall: unknown;
      onboardingRequired: boolean;
    };

    expect(status.exitCode).toBe(0);
    expect(statusOutput.onboardingRequired).toBe(true);
    expect(statusOutput.changelogInstall).toEqual({
      command: expectedCommand,
      decision: null,
      distribution: "web",
      offered: false,
    });

    const invalid = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--changelog-install",
        "someday",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(invalid.exitCode).toBe(2);
    expect(decoder.decode(invalid.stderr)).toContain(
      "--changelog-install must be now, after-shipment, later, or decline"
    );

    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--changelog",
        "delegate-if-available",
        "--changelog-install",
        "after-shipment",
        "--questions",
        "blocking-only",
        "--scope",
        "run",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      changelogInstall: unknown;
      summary: string;
      written: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output.written).toBe(false);
    expect(output.changelogInstall).toEqual({
      command: expectedCommand,
      decision: "install-after-shipment",
      distribution: "web",
      offered: true,
    });
    expect(output.summary).toContain(
      `Simple Changelogs install: After this shipment. I'll run \`${expectedCommand}\` only after this consent, and its setup is recorded as outstanding work`
    );
    expect(existsSync(resolve(fixture.root, ".simple-changes.json"))).toBe(
      false
    );
  });

  test("returns run-only onboarding preferences without writing a file", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "ship",
        "--production",
        "allow",
        "--shipping-mode",
        "break-glass",
        "--git-push-authorization",
        "configure-harness",
        "--acknowledge-push-scope",
        "--migration-handling",
        "auto-apply-reviewed-routine",
        "--migration-target",
        "supabase:primary-db:production",
        "--questions",
        "never",
        "--scope",
        "run",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      confirmed: boolean;
      path: string | null;
      policy: {
        defaultFinish: string;
        migrationHandling: string;
        migrationTargets: Array<{
          environment: string;
          project: string;
          provider: string;
        }>;
        productionDeploy: string;
        questions: string;
        shippingMode: string;
      };
      written: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      confirmed: true,
      path: null,
      policy: {
        defaultFinish: "ship",
        migrationHandling: "auto-apply-reviewed-routine",
        migrationTargets: [
          {
            environment: "production",
            project: "primary-db",
            provider: "supabase",
          },
        ],
        productionDeploy: "allow",
        questions: "never",
        shippingMode: "break-glass",
      },
      written: false,
    });
  });

  test("saves repository onboarding preferences in the primary checkout", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "integrate",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      path: string;
      written: boolean;
    };
    const policy = JSON.parse(
      readFileSync(resolve(fixture.root, ".simple-changes.json"), "utf8")
    ) as {
      defaultFinish: string;
      productionDeploy: string;
    };

    expect(result.exitCode).toBe(0);
    expect(output.written).toBe(true);
    expect(output.path).toBe(resolve(fixture.root, ".simple-changes.json"));
    expect(policy).toMatchObject({
      defaultFinish: "integrate",
      handoffTiming: "confirm-ready",
      productionDeploy: "ask",
    });
  });

  test("persists confirmed repository auto-push trust end to end", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const command = [
      process.execPath,
      cliPath,
      "setup",
      "--finish",
      "integrate",
      "--git-push-authorization",
      "configure-harness",
      "--acknowledge-push-scope",
      "--questions",
      "blocking-only",
      "--scope",
      "repository",
      "--yes",
      "--json",
      "--repo",
      fixture.root,
    ];
    expect(spawnSync(command).exitCode).toBe(0);
    const inventory = captureInventory(fixture.root);
    expect(inventory.policy).toMatchObject({
      source: "repository",
      trust: "trusted",
      value: { gitPushAuthorization: "configure-harness" },
    });
  });

  test("requires closed-scope acknowledgement and rejects trust symlinks", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const commonState = resolve(fixture.root, ".git/simple-changes");
    writeFixture(fixture.root, ".git/simple-changes/outside", "{}\n");
    symlinkSync(
      resolve(commonState, "outside"),
      resolve(commonState, "policy-trust.json")
    );
    const args = [
      process.execPath,
      cliPath,
      "setup",
      "--finish",
      "integrate",
      "--git-push-authorization",
      "configure-harness",
      "--questions",
      "blocking-only",
      "--scope",
      "repository",
      "--yes",
      "--json",
      "--repo",
      fixture.root,
    ];
    const unacknowledged = spawnSync(args, { stderr: "pipe" });
    expect(unacknowledged.exitCode).not.toBe(0);
    expect(decoder.decode(unacknowledged.stderr)).toContain(
      "--acknowledge-push-scope"
    );
    const rejectedSymlink = spawnSync(
      [...args.slice(0, -4), "--acknowledge-push-scope", ...args.slice(-4)],
      { stderr: "pipe" }
    );
    expect(rejectedSymlink.exitCode).not.toBe(0);
    expect(decoder.decode(rejectedSymlink.stderr)).toContain(
      "symlink ancestor"
    );
  });

  test("adds a confirmed instruction pointer and gates completed-work handoff", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    const setup = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--instruction-pointer",
        "add",
        "--handoff",
        "ask",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const setupOutput = JSON.parse(decoder.decode(setup.stdout)) as {
      instructionPointer: {
        action: string;
        written: boolean;
      };
      policy: {
        handoffTiming: string;
      };
    };

    expect(setup.exitCode).toBe(0);
    expect(setupOutput).toMatchObject({
      instructionPointer: {
        action: "add",
        written: true,
      },
      policy: {
        handoffTiming: "confirm-ready",
      },
    });
    expect(readFileSync(resolve(fixture.root, "AGENTS.md"), "utf8")).toContain(
      "Is this ready for Simple Changes, or do you want more changes first?"
    );

    const waiting = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "handoff",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(JSON.parse(decoder.decode(waiting.stdout))).toMatchObject({
      handoffAction: "confirm-readiness",
      mutationAllowed: false,
      resolvedMode: null,
    });

    const ready = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "handoff",
        "--ready",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(JSON.parse(decoder.decode(ready.stdout))).toMatchObject({
      handoffAction: "proceed",
      mutationAllowed: true,
      resolvedMode: "queue",
    });
  });

  test("requires explicit pointer answers in non-interactive setup", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain(
      "--instruction-pointer when an instruction file exists"
    );
  });

  test("supports conditional saved UI artifact versioning", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const incomplete = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "run",
        "--ui-artifacts",
        "--yes",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(incomplete.exitCode).toBe(2);
    expect(decoder.decode(incomplete.stderr)).toContain(
      "--ui-versioning with --ui-artifacts"
    );

    const complete = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "run",
        "--ui-artifacts",
        "--ui-versioning",
        "number-and-date",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(complete.stdout)) as {
      policy: {
        uiArtifactVersioning: string;
      };
      uiArtifactsRelevant: boolean;
    };

    expect(complete.exitCode).toBe(0);
    expect(output).toMatchObject({
      policy: {
        uiArtifactVersioning: "number-and-date",
      },
      uiArtifactsRelevant: true,
    });
  });

  test("saves personal preferences outside the repository", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const configurationRoot = resolve(fixture.base, "configuration");
    const environment = {
      ...process.env,
      SIMPLE_CHANGES_CONFIG_DIR: configurationRoot,
    };
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "always",
        "--scope",
        "user",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      {
        env: environment,
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const personalPath = resolve(
      configurationRoot,
      "simple-changes",
      "preferences.json"
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      path: string;
      written: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      path: personalPath,
      written: true,
    });
    expect(
      JSON.parse(readFileSync(personalPath, "utf8")) as {
        questions: string;
      }
    ).toMatchObject({ questions: "always" });

    const inventoryResult = spawnSync(
      [
        process.execPath,
        cliPath,
        "inventory",
        "--json",
        "--repo",
        fixture.root,
      ],
      { env: environment, stderr: "pipe", stdout: "pipe" }
    );
    const inventory = JSON.parse(decoder.decode(inventoryResult.stdout)) as {
      policy: {
        path: string;
        source: string;
      };
    };
    expect(inventoryResult.exitCode).toBe(0);
    expect(inventory.policy).toEqual(
      expect.objectContaining({
        path: personalPath,
        source: "user",
      })
    );
  }, 15_000);

  test("saves repository preferences in the canonical primary checkout", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const linkedWorktree = resolve(fixture.base, "linked");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "onboarding-test",
      linkedWorktree,
    ]);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--yes",
        "--json",
        "--repo",
        linkedWorktree,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      path: string;
      written: boolean;
    };

    expect(result.exitCode).toBe(0);
    expect(output).toEqual(
      expect.objectContaining({
        path: resolve(fixture.root, ".simple-changes.json"),
        written: true,
      })
    );
  });

  test("requires complete answers and confirmation without a terminal", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "ship",
        "--questions",
        "never",
        "--scope",
        "run",
        "--yes",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain(
      "Interactive setup requires a terminal"
    );
  });

  test("emits a validated JSON preview with stable success status", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "src/ready.ts", "export const ready = true;\n");
    const result = spawnSync(
      [process.execPath, cliPath, "preview", "--json", "--repo", fixture.root],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      mode: string;
      mutationCount: number;
      units: unknown[];
    };
    expect(result.exitCode).toBe(0);
    expect(output.mode).toBe("preview");
    expect(output.mutationCount).toBe(0);
    expect(output.units).toHaveLength(1);
  });

  test("records and reports a comprehensive Ship scope before mutation", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "src/ready.ts", "export const ready = true;\n");
    const preview = spawnSync(
      [process.execPath, cliPath, "preview", "--json", "--repo", fixture.root],
      { stderr: "pipe", stdout: "pipe" }
    );
    const planPath = resolve(fixture.base, "shipment-plan.json");
    writeFileSync(planPath, decoder.decode(preview.stdout), "utf8");
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const {
      lease: { runId },
    } = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };
    const recorded = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "record-scope",
        "--run-id",
        runId,
        "--agent-id",
        "controller",
        "--receipt",
        planPath,
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(recorded.exitCode).toBe(0);
    expect(decoder.decode(recorded.stdout)).toContain(
      "No changed path is unaccounted for"
    );
  });

  test("uses stable usage exit code for an unknown command", () => {
    const result = spawnSync([process.execPath, cliPath, "does-not-exist"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain("Unknown command");
  });

  test("reports the package release version", () => {
    const packageVersion = (
      JSON.parse(
        readFileSync(resolve(testDirectory, "../../../package.json"), "utf8")
      ) as { version: string }
    ).version;
    const result = spawnSync([process.execPath, cliPath, "version"], {
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stdout).trim()).toBe(packageVersion);
  });

  test("renders public release notes from the latest released changelog section", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      `# Changelog

## Unreleased

- Keep this pending.

## 0.2.0 - 2026-07-23

<!-- private release metadata -->
- Added release notes to the CLI.
`
    );
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "release-notes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      markdown: string;
      version: string;
    };

    expect(result.exitCode).toBe(0);
    expect(output.version).toBe("0.2.0");
    expect(output.markdown).toContain("Added release notes to the CLI.");
    expect(output.markdown).not.toContain("private release metadata");
    expect(output.markdown).not.toContain("Keep this pending.");
  });

  test("defaults release notes to the packaged Simple Changes changelog", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      "# Changelog\n\n## 99.0.0 - 2099-01-01\n\n- Wrong repository.\n"
    );
    const result = spawnSync(
      [process.execPath, cliPath, "release-notes", "--json"],
      { cwd: fixture.root, stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      markdown: string;
      source: string;
      version: string;
    };

    expect(result.exitCode).toBe(0);
    expect(output.version).not.toBe("99.0.0");
    expect(output.markdown).not.toContain("Wrong repository.");
    expect(output.source).toEndWith("/simple-changes/CHANGELOG.md");
  });

  test("selects a release-note version from the CLI", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      `# Changelog

## 0.2.0 - 2026-07-23

- New notes.

## 0.1.0 - 2026-07-01

- Original notes.
`
    );
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "release-notes",
        "--repo",
        fixture.root,
        "--version",
        "0.1.0",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = decoder.decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("## 0.1.0 - 2026-07-01");
    expect(output).toContain("Original notes.");
    expect(output).not.toContain("New notes.");
  });

  test("checks release consistency with a stable validation exit code", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      "# Changelog\n\n## 0.2.0 - 2026-07-23\n\n- Public notes.\n"
    );
    writeFixture(
      fixture.root,
      "DEVELOPER_CHANGELOG.md",
      "# Developer changelog\n\n## 0.1.0 - 2026-07-23\n\n- Developer notes.\n"
    );
    writeFixture(
      fixture.root,
      "package.json",
      '{ "name": "fixture", "version": "0.2.0" }\n'
    );
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "release-notes",
        "--check",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const output = JSON.parse(decoder.decode(result.stdout)) as {
      issues: string[];
      valid: boolean;
    };

    expect(result.exitCode).toBe(3);
    expect(output.valid).toBe(false);
    expect(output.issues).toContain(
      "developer-history version 0.1.0 does not match public release 0.2.0."
    );
  });

  test("fails the release check when SKILL.md metadata.version disagrees with the packaged changelog", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const history = "# Changelog\n\n## 0.27.0 - 2026-10-07\n\n- Notes.\n";
    writeFixture(fixture.root, "CHANGELOG.md", history);
    writeFixture(fixture.root, "DEVELOPER_CHANGELOG.md", history);
    writeFixture(fixture.root, "skills/simple-changes/CHANGELOG.md", history);
    writeFixture(
      fixture.root,
      "package.json",
      '{ "name": "simple-changes", "version": "0.27.0" }\n'
    );
    writeFixture(
      fixture.root,
      "skills/simple-changes/SKILL.md",
      '---\nname: simple-changes\ndescription: Ships changes.\nmetadata:\n  version: "0.26.0"\n---\n'
    );
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "release-notes",
        "--check",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).toBe(3);
    expect(
      (JSON.parse(decoder.decode(result.stdout)) as { issues: string[] }).issues
    ).toContain(
      "skills/simple-changes/SKILL.md metadata.version 0.26.0 does not match the packaged CHANGELOG.md release 0.27.0."
    );
  });

  test("rejects conflicting release-note selectors", () => {
    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "release-notes",
        "--check",
        "--version",
        "0.2.0",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain(
      "--check and --version cannot be combined"
    );
  });

  test("requires an explicit repository for maintainer consistency checks", () => {
    const result = spawnSync(
      [process.execPath, cliPath, "release-notes", "--check"],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(result.exitCode).toBe(2);
    expect(decoder.decode(result.stderr)).toContain(
      "--check requires an explicit --repo PATH"
    );
  });

  test("matches the packaged version", () => {
    const { version } = JSON.parse(
      readFileSync(resolve(testDirectory, "../../../package.json"), "utf8")
    ) as { version: string };
    const result = spawnSync([process.execPath, cliPath, "--version"], {
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stdout)).toBe(`${version}\n`);
  });

  test("treats --help after a subcommand as a help request", () => {
    for (const flag of ["--help", "-h"]) {
      const result = spawnSync([process.execPath, cliPath, "worktree", flag], {
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(decoder.decode(result.stdout)).toContain("Usage:");
    }
  });

  test("lists every supported schema kind in help", () => {
    const result = spawnSync([process.execPath, cliPath, "help"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const output = decoder.decode(result.stdout);

    expect(result.exitCode).toBe(0);
    for (const schemaName of SCHEMA_NAMES) {
      expect(output).toContain(schemaName);
    }
  });

  test("points unknown commands and options at help", () => {
    const unknownCommand = spawnSync([process.execPath, cliPath, "shipit"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(unknownCommand.exitCode).toBe(2);
    expect(decoder.decode(unknownCommand.stderr)).toContain(
      "Unknown command: shipit. Run 'simple-changes help' for usage."
    );

    const unknownOption = spawnSync(
      [process.execPath, cliPath, "inventory", "--frobnicate"],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(unknownOption.exitCode).toBe(2);
    expect(decoder.decode(unknownOption.stderr)).toContain(
      "Unknown option: --frobnicate. Run 'simple-changes help' for usage."
    );
  });

  test("reports an unconfirmed consequential repository policy", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify(
        { ...DEFAULT_POLICY, productionDeploy: "allow" },
        null,
        2
      )}\n`
    );

    const result = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "preview",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(result.stdout))).toMatchObject({
      policyTrust: "untrusted",
      productionDeploy: "ask",
    });

    const rendered = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "preview",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(rendered.exitCode).toBe(0);
    expect(decoder.decode(rendered.stdout)).toContain(
      "Repository policy requests consequential authority but has not been confirmed on this clone; running with reduced authority until setup confirms it."
    );
    expect(decoder.decode(rendered.stdout)).toContain("Production deploy: ask");

    writeRepositoryPolicyTrustReceipt(
      fixture.root,
      resolve(fixture.root, ".git"),
      "test-user",
      "Authorize this exact test policy"
    );
    const trusted = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "preview",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(trusted.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(trusted.stdout))).toMatchObject({
      policyTrust: "trusted",
      productionDeploy: "allow",
    });
  });

  test("completed-work handoff releases the author's own worktree claim", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const setup = spawnSync(
      [
        process.execPath,
        cliPath,
        "setup",
        "--finish",
        "review",
        "--git-push-authorization",
        "ask",
        "--questions",
        "blocking-only",
        "--scope",
        "repository",
        "--instruction-pointer",
        "leave",
        "--handoff",
        "automatic",
        "--yes",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(setup.exitCode).toBe(0);
    const worktree = resolve(fixture.base, "handoff-feature");
    git(fixture.root, ["worktree", "add", "-b", "handoff-feature", worktree]);
    const claimed = spawnSync(
      [
        process.execPath,
        cliPath,
        "worktree",
        "claim",
        "--agent-id",
        "feature-author",
        "--worktree",
        worktree,
        "--adapter",
        "claude-code",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(claimed.exitCode).toBe(0);
    const { claim } = JSON.parse(decoder.decode(claimed.stdout)) as {
      claim: { claimId: string };
    };
    const started = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "integration-controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(started.exitCode).toBe(0);
    const { lease } = JSON.parse(decoder.decode(started.stdout)) as {
      lease: { runId: string };
    };

    const handoff = spawnSync(
      [
        process.execPath,
        cliPath,
        "initialize",
        "--mode",
        "handoff",
        "--ready",
        "--agent-id",
        "feature-author",
        "--json",
        "--repo",
        worktree,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(handoff.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(handoff.stdout))).toMatchObject({
      handoffAction: "proceed",
      handoffClaimRelease: {
        claimId: claim.claimId,
        path: realpathSync(worktree),
      },
      mutationAllowed: true,
    });
    const status = spawnSync(
      [
        process.execPath,
        cliPath,
        "worktree",
        "status",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(JSON.parse(decoder.decode(status.stdout))).toMatchObject({
      claims: [{ releaseReason: "handoff", state: "released" }],
    });
    const verified = spawnSync(
      [
        process.execPath,
        cliPath,
        "loop",
        "verify",
        "--run-id",
        lease.runId,
        "--agent-id",
        "integration-controller",
        "--json",
        "--repo",
        fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(verified.stdout))).toMatchObject({
      ok: true,
    });
  });

  test("help and the usage errors agree on every dispatched loop and worktree action", () => {
    const help = decoder.decode(
      spawnSync([process.execPath, cliPath, "help"], {
        stderr: "pipe",
        stdout: "pipe",
      }).stdout
    );
    for (const group of ["loop", "worktree"] as const) {
      const documented = new Set(
        [
          ...help.matchAll(
            new RegExp(`simple-changes ${group} ([a-z-]+)`, "gu")
          ),
        ]
          .map((match) => match[1])
          .filter((action): action is string => Boolean(action))
      );
      const usage = decoder.decode(
        spawnSync([process.execPath, cliPath, group], {
          stderr: "pipe",
          stdout: "pipe",
        }).stderr
      );
      const listed = usage.match(new RegExp(`${group} requires (.+)$`, "mu"));
      expect(listed).not.toBeNull();
      const dispatched = new Set(
        (listed?.[1] ?? "")
          .split(USAGE_LIST_SEPARATOR)
          .map((action) => action.trim().replace(TRAILING_PERIOD, ""))
          .filter(Boolean)
      );
      expect([...documented].sort()).toEqual([...dispatched].sort());
    }
  });
});
