import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectInitialization } from "../../../skills/simple-changes/scripts/lib/initialization.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import type {
  ChangelogReceipt,
  LoopLease,
  RepoPolicy,
  ShipmentOutcomeReceipt,
  WorktreeCoordinationDocument,
} from "../../../skills/simple-changes/scripts/lib/types.ts";

describe("closed schemas", () => {
  test("accepts exact shipment outcomes and rejects unverifiable review claims", () => {
    const receipt: ShipmentOutcomeReceipt = {
      additionalPaths: [
        {
          classification: "release-generated",
          entry: "100644:blob:a1b2c3",
          path: "CHANGELOG.md",
          reason: "Release reconciliation generated the final note.",
        },
      ],
      runId: "run-example-1234",
      schemaVersion: 1,
      targetRevision: "a".repeat(40),
      units: [
        {
          disposition: "delivered",
          evidence: ["The final target matches the opening source result."],
          finalPaths: [
            {
              entry: "160000:commit:b2c3d4",
              path: "vendor/dependency",
            },
          ],
          originalPaths: [],
          summary: "Combined the reviewed dependency update.",
          unitId: "dependency-update",
        },
      ],
    };
    expect(
      validateSchema<ShipmentOutcomeReceipt>("shipment-outcome", receipt)
    ).toEqual(receipt);
    expect(() =>
      validateSchema("shipment-outcome", {
        ...receipt,
        approvalToken: "never",
      })
    ).toThrow("additional properties");
    expect(() =>
      validateSchema("shipment-outcome", {
        ...receipt,
        review: {
          evidence: ["Controller-authored review text is not proof."],
          reviewedRevision: "a".repeat(40),
          reviewerAgentId: "invented-reviewer",
          summary: "This must fail closed.",
          verdict: "approved",
        },
      })
    ).toThrow("additional properties");
    expect(() =>
      validateSchema("shipment-outcome", {
        ...receipt,
        units: [{ ...receipt.units[0], disposition: "reconciled" }],
      })
    ).toThrow("must be one of delivered, target-equivalent");
    expect(() =>
      validateSchema("shipment-outcome", {
        ...receipt,
        additionalPaths: [
          {
            classification: "review-delta",
            entry: "100644:blob:a1b2c3",
            path: "review-fix.ts",
            reason: "Controller-authored review deltas are not trusted.",
          },
        ],
      })
    ).toThrow("must be one of release-generated, external-target-change");
  });

  test("accepts the default repository policy", () => {
    expect(validateSchema<RepoPolicy>("repo-policy", DEFAULT_POLICY)).toEqual(
      DEFAULT_POLICY
    );
  });

  test("accepts a closed first-run initialization status", () => {
    const status = inspectInitialization("queue", {
      path: null,
      source: "default",
    });
    expect(validateSchema<typeof status>("initialization", status)).toEqual(
      status
    );
    expect(() =>
      validateSchema("initialization", {
        ...status,
        credentials: "never",
      })
    ).toThrow("additional properties");

    const syncStatus = inspectInitialization("sync", {
      path: null,
      source: "default",
    });
    expect(
      validateSchema<typeof syncStatus>("initialization", syncStatus)
    ).toEqual(syncStatus);
  });

  test("rejects unknown policy fields", () => {
    expect(() =>
      validateSchema("repo-policy", {
        ...DEFAULT_POLICY,
        token: "must-not-be-accepted",
      })
    ).toThrow("additional properties");
  });

  test("rejects changelog policy in Simple Changes policy", () => {
    expect(() =>
      validateSchema("repo-policy", {
        ...DEFAULT_POLICY,
        releaseNotes: {
          developerChangelog: "required",
          signatures: "agent-and-timestamp",
        },
      })
    ).toThrow("additional properties");
  });

  test("accepts the closed changelog coordination preference", () => {
    expect(
      validateSchema<RepoPolicy>("repo-policy", {
        ...DEFAULT_POLICY,
        changelogHandling: "delegate-if-available",
      })
    ).toMatchObject({
      changelogHandling: "delegate-if-available",
    });
    expect(() =>
      validateSchema("repo-policy", {
        ...DEFAULT_POLICY,
        changelogHandling: "write-it-yourself",
      })
    ).toThrow("changelogHandling");
  });

  test("accepts only closed handoff timing preferences", () => {
    for (const handoffTiming of [
      "confirm-ready",
      "automatic",
      "user-signaled",
    ] as const) {
      expect(
        validateSchema<RepoPolicy>("repo-policy", {
          ...DEFAULT_POLICY,
          handoffTiming,
        })
      ).toMatchObject({ handoffTiming });
    }
    expect(() =>
      validateSchema("repo-policy", {
        ...DEFAULT_POLICY,
        handoffTiming: "always-ship",
      })
    ).toThrow("handoffTiming");
  });

  test("accepts only closed UI artifact versioning preferences", () => {
    for (const uiArtifactVersioning of [
      "repository-convention",
      "number-and-date",
      "date-only",
      "number-only",
    ] as const) {
      expect(
        validateSchema<RepoPolicy>("repo-policy", {
          ...DEFAULT_POLICY,
          uiArtifactVersioning,
        })
      ).toMatchObject({ uiArtifactVersioning });
    }
    expect(() =>
      validateSchema("repo-policy", {
        ...DEFAULT_POLICY,
        uiArtifactVersioning: "semantic-release",
      })
    ).toThrow("uiArtifactVersioning");
  });

  test("requires exact targets for automatic migration handling", () => {
    expect(() =>
      validateSchema<RepoPolicy>("repo-policy", {
        ...DEFAULT_POLICY,
        migrationHandling: "auto-apply-reviewed",
      })
    ).toThrow("migrationTargets");
    expect(
      validateSchema<RepoPolicy>("repo-policy", {
        ...DEFAULT_POLICY,
        migrationHandling: "auto-apply-reviewed-routine",
        migrationTargets: [
          {
            environment: "production",
            project: "primary-db",
            provider: "supabase",
          },
        ],
      }).migrationHandling
    ).toBe("auto-apply-reviewed-routine");
  });

  test("requires immutable identity for reviewed and pending migration sets", () => {
    const operations = [
      {
        contentDigest: "b".repeat(64),
        revision: "supabase/migrations/20260812090000_add_index.sql",
      },
    ] as const;
    const [operation] = operations;
    const operationRevision = operation.revision;
    const operationDigest = operation.contentDigest;
    const digest = "a".repeat(64);
    expect(() =>
      validateSchema("migration-review", {
        backupOrRollbackVerified: true,
        destructive: false,
        irreversible: false,
        lockHeavy: false,
        postApplyVerificationPlanned: true,
        reviewed: true,
        routine: true,
        target: {
          environment: "production",
          project: "db",
          provider: "supabase",
        },
        unboundedDataChange: false,
      })
    ).toThrow();
    expect(
      validateSchema<{ digest: string; operations: typeof operations }>(
        "migration-pending",
        { digest, operations }
      )
    ).toEqual({ digest, operations });
    expect(
      validateSchema("migration-apply-plan", {
        adapter: "exact-operation-argv-v1",
        command: [
          realpathSync("/usr/bin/true"),
          "apply-exact",
          "--target",
          "supabase/db/production",
          "--revision",
          operationRevision,
          "--digest",
          operationDigest,
        ],
        digest,
        executableDigest: createHash("sha256")
          .update(readFileSync(realpathSync("/usr/bin/true")))
          .digest("hex"),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        issuedAt: new Date().toISOString(),
        nonce: "migration-plan-0001",
        operations,
        remoteLedger: {
          digest,
          observedAt: new Date().toISOString(),
          operations,
          target: {
            environment: "production",
            project: "db",
            provider: "supabase",
          },
        },
        scope: "exact-listed-operations",
        target: {
          environment: "production",
          project: "db",
          provider: "supabase",
        },
      })
    ).toBeDefined();
  });

  test("accepts a digest-bound changelog delegation receipt", () => {
    const receipt: ChangelogReceipt = {
      checks: ["release policy"],
      evidence: ["Prepared by simple-changelogs"],
      observedAt: new Date().toISOString(),
      paths: [
        {
          digest: "a".repeat(64),
          path: "CHANGELOG.md",
        },
      ],
      provider: "simple-changelogs",
      reason: null,
      release: {
        date: "2026-07-27",
        targetContainedUnreleased: "integrated",
        version: "1.4.0",
      },
      releaseImpact: "minor",
      schemaVersion: 1,
      sourceRevision: "b".repeat(40),
      status: "prepared",
    };

    expect(
      validateSchema<ChangelogReceipt>("changelog-receipt", receipt)
    ).toEqual(receipt);
    expect(() =>
      validateSchema("changelog-receipt", {
        ...receipt,
        paths: [{ digest: "short", path: "../CHANGELOG.md" }],
      })
    ).toThrow();
    expect(() =>
      validateSchema("changelog-receipt", {
        ...receipt,
        release: {
          ...receipt.release,
          targetContainedUnreleased: "pending",
        },
      })
    ).toThrow();
    expect(() =>
      validateSchema("changelog-receipt", {
        ...receipt,
        paths: [],
        sourceRevision: null,
      })
    ).toThrow();
    expect(() =>
      validateSchema("changelog-receipt", {
        ...receipt,
        reason: null,
        status: "blocked",
      })
    ).toThrow();
  });

  test("accepts a version-less prepared receipt only with a version-less decision", () => {
    const entryReceipt: ChangelogReceipt = {
      checks: ["Inspected exact target."],
      decisionDigest: "d".repeat(64),
      effectivePolicyDigest: "e".repeat(64),
      evidence: ["Operator workflow changed."],
      observedAt: "2026-09-02T12:00:00-05:00",
      paths: [{ digest: "f".repeat(64), path: "CMS_CHANGELOG.json" }],
      phase: "prepare",
      provider: "simple-changelogs",
      reason: null,
      reasonCode: null,
      release: null,
      releaseImpact: "minor",
      releaseSetId: null,
      requiredAction: null,
      revisionLineage: {
        finalizedTargetRevision: null,
        inputTargetRevision: "a".repeat(40),
        reconciliationHeadRevision: "b".repeat(40),
      },
      schemaVersion: 2,
      sourceRevision: "a".repeat(40),
      status: "prepared",
      transactionId: "cms-entry-01",
      versionDecision: null,
    };
    expect(
      validateSchema<ChangelogReceipt>("changelog-receipt", entryReceipt)
    ).toEqual(entryReceipt);
    expect(() =>
      validateSchema("changelog-receipt", {
        ...entryReceipt,
        versionDecision: {
          boundary: "none",
          bumpLevel: "patch",
          currentVersion: null,
          policyAction: "automatic",
          releaseTrain: "cms-operators",
          resolution: "automatic",
          selectedVersion: "1.0.1",
          source: "repository-policy",
          suggestedVersion: "1.0.1",
        },
      })
    ).toThrow();
  });

  test("treats changelog request attempt and environment as optional shape-checked fields", () => {
    const request = {
      approvedDecisionDigest: null,
      approvedVersion: null,
      boundary: "web-production",
      finalizedTargetRevision: null,
      inputTargetRevision: "a".repeat(40),
      mutationScope: "read-only",
      phase: "classify",
      priorReceiptDigest: null,
      releaseSetId: null,
      releaseTrain: "web",
      schemaVersion: 1,
      supportedReceiptVersions: [1, 2],
      transactionId: "release-01",
    };
    expect(
      validateSchema<typeof request>("changelog-request", request)
    ).toEqual(request);
    expect(
      validateSchema("changelog-request", {
        ...request,
        attempt: 2,
        environment: "production",
      })
    ).toMatchObject({ attempt: 2, environment: "production" });
    expect(() =>
      validateSchema("changelog-request", { ...request, attempt: 0 })
    ).toThrow();
    expect(() =>
      validateSchema("changelog-request", { ...request, environment: "" })
    ).toThrow();
    expect(() =>
      validateSchema("changelog-request", { ...request, environment: null })
    ).toThrow();
  });

  test("rejects run approvals without a revision", () => {
    expect(() =>
      validateSchema("run-state", {
        approvals: [
          {
            observedAt: new Date().toISOString(),
            reviewer: "reviewer",
            unitId: "unit",
            verdict: "approved",
          },
        ],
        baselineDigest: "a".repeat(64),
        blockers: [],
        cleanupTargets: [],
        concurrentArrivals: [],
        createdAt: new Date().toISOString(),
        mode: "integrate",
        receipts: [],
        resumeBoundary: "inventory",
        runId: "run-1",
        schemaVersion: 1,
        unitStates: [],
        updatedAt: new Date().toISOString(),
      })
    ).toThrow("revision");
  });

  test("accepts negotiated release protocol state without policy duplication", () => {
    const now = new Date().toISOString();
    const runState = {
      approvals: [],
      baselineDigest: "a".repeat(64),
      blockers: [],
      cleanupTargets: [],
      concurrentArrivals: [],
      coordinatedOnboarding: {
        owners: [
          {
            destination: "/repo/.simple-changes.json",
            owner: "simple-changes",
            policyDigest: "b".repeat(64),
            status: "completed",
            writeReceiptDigest: "c".repeat(64),
          },
          {
            destination: "/repo/.simple-changelogs.json",
            owner: "simple-changelogs",
            policyDigest: "d".repeat(64),
            status: "pending",
            writeReceiptDigest: null,
          },
        ],
        status: "partial",
        transactionId: "setup-01",
      },
      createdAt: now,
      emergencyShipping: {
        artifactEquivalenceProven: false,
        authoritySource: "confirmed-run-only",
        breakGlassAuthorized: true,
        candidateArtifactId: null,
        candidateRevision: "9".repeat(40),
        candidateVerifiedHealthy: false,
        canonicalArtifactId: null,
        canonicalRevision: null,
        changelogReconciled: false,
        cleanupCompleted: false,
        deployedArtifactId: null,
        deployedRevision: null,
        evidence: ["active-user-impact"],
        finalVerificationPassed: false,
        focusedChecksPassed: true,
        independentReview: "pending",
        mergeCompleted: false,
        mode: "break-glass",
        previousProductionRevision: "8".repeat(40),
        productionAuthorized: true,
        redeployDecision: "pending",
        rollbackAnchorRecorded: true,
        rollbackSupported: true,
        status: "ready",
      },
      mode: "ship",
      receipts: [],
      releaseDecisions: [
        {
          approval: {
            productionAuthorized: false,
            versionAuthorized: false,
          },
          attempt: 1,
          boundary: "web-production",
          compositeReceipt: null,
          currentVersion: "0.9.0",
          decisionDigest: "e".repeat(64),
          deployedRevision: null,
          effectivePolicyDigest: "f".repeat(64),
          finalizedTargetRevision: null,
          inputTargetRevision: "1".repeat(40),
          lastCompletedBoundary: "classify",
          phase: "classify",
          priorReceiptDigest: null,
          reasonCode: "version-direction-required",
          receiptSchemaDigest: "2".repeat(64),
          receiptVersion: 2,
          reconciliationHeadRevision: null,
          releaseSetId: null,
          releaseTrain: "web",
          requestSchemaDigest: "3".repeat(64),
          requestVersion: 1,
          requiredAction: "choose-version",
          selectedVersion: null,
          status: "decision-required",
          suggestedVersion: "0.10.0",
          transactionId: "release-01",
        },
      ],
      resumeBoundary: "release-classify",
      runId: "run-1",
      schemaVersion: 1,
      unitStates: [],
      updatedAt: now,
    };
    expect(validateSchema<typeof runState>("run-state", runState)).toEqual(
      runState
    );
    expect(() =>
      validateSchema("run-state", {
        ...runState,
        emergencyShipping: {
          ...runState.emergencyShipping,
          status: "complete",
        },
      })
    ).toThrow();
    expect(() =>
      validateSchema("run-state", {
        ...runState,
        emergencyShipping: {
          ...runState.emergencyShipping,
          rawPrompt: "deploy first",
        },
      })
    ).toThrow();
    expect(JSON.stringify(runState)).not.toContain("publicVersioning");
  });

  test("accepts a closed active-loop lease manifest", () => {
    const lease: LoopLease = {
      baselineDigest: "a".repeat(64),
      commonGitDirectory: "/repo/.git",
      createdAt: new Date().toISOString(),
      dispositions: [
        {
          approvedBy: "user",
          branch: "obsolete-work",
          changeDigest: "e".repeat(64),
          createdAt: new Date().toISOString(),
          headSha: "f".repeat(40),
          outcome: "remove-after-audit",
          path: "/repo-obsolete",
          reason: "Audited obsolete with no unique work",
          targetRef: "origin/main",
          targetRevision: "d".repeat(40),
          uniqueCommitCount: 0,
        },
      ],
      mode: "integrate",
      overrides: [],
      ownerAgentId: "controller",
      preparations: [],
      primaryCheckout: "/repo",
      remoteBindings: [
        {
          fetchUrls: ["https://gitlab.example/repo.git"],
          name: "origin",
          provider: "gitlab",
          pushUrls: ["https://gitlab.example/repo.git"],
        },
      ],
      runId: "run-test-1234",
      schemaVersion: 1,
      targetRef: "origin/main",
      targetRevision: "d".repeat(40),
      updatedAt: new Date().toISOString(),
      worktrees: [
        {
          agentId: "controller",
          baselineChangeDigest: "b".repeat(64),
          baselineHeadSha: "c".repeat(40),
          branch: "main",
          createdByRun: false,
          mutationAllowed: true,
          path: "/repo",
          role: "controller",
        },
      ],
    };
    expect(validateSchema<LoopLease>("loop-lease", lease)).toEqual(lease);
    const retained = {
      agentId: null,
      baselineChangeDigest: "e".repeat(64),
      baselineHeadSha: "f".repeat(40),
      branch: "walkthrough",
      createdByRun: false,
      mutationAllowed: false,
      path: "/repo-walkthrough",
      retention: {
        approvedBy: "user",
        createdAt: new Date().toISOString(),
        reason: "Keep this unrelated worktree outside the shipment",
      },
      role: "retained",
    } as const;
    expect(
      validateSchema<LoopLease>("loop-lease", {
        ...lease,
        worktrees: [...lease.worktrees, retained],
      }).worktrees
    ).toContainEqual(retained);
    const { retention: _retention, ...retainedWithoutEvidence } = retained;
    expect(() =>
      validateSchema("loop-lease", {
        ...lease,
        worktrees: [...lease.worktrees, retainedWithoutEvidence],
      })
    ).toThrow("retention");
    expect(() =>
      validateSchema("loop-lease", {
        ...lease,
        unrestrictedMutation: true,
      })
    ).toThrow("additional properties");
  });

  test("accepts closed worktree coordination state and rejects secrets", () => {
    const now = new Date().toISOString();
    const document: WorktreeCoordinationDocument = {
      claims: [
        {
          branch: "feature",
          changeDigest: "b".repeat(64),
          claimId: "claim-example",
          commonGitDirectory: "/repo/.git",
          createdAt: now,
          headSha: "a".repeat(40),
          owner: {
            adapter: "claude-code",
            agentId: "owner",
            ownerRef: "session-1",
          },
          path: "/repo/worktree",
          repositoryId: "c".repeat(64),
          schemaVersion: 1,
          state: "active",
          updatedAt: now,
        },
      ],
      events: [
        {
          actorAgentId: "owner",
          claimId: "claim-example",
          createdAt: now,
          eventId: "event-example",
          state: "active",
        },
      ],
      receipts: [],
      repositoryId: "c".repeat(64),
      schemaVersion: 1,
    };
    expect(
      validateSchema<WorktreeCoordinationDocument>(
        "worktree-coordination",
        document
      )
    ).toEqual(document);
    const [claim] = document.claims;
    const [event] = document.events;
    if (!(claim && event)) {
      throw new Error("coordination compatibility fixture is incomplete");
    }
    for (const state of [
      "pause-requested",
      "detach-requested",
      "blocked",
    ] as const) {
      const legacy: WorktreeCoordinationDocument = {
        ...document,
        claims: [{ ...claim, state }],
        events: [{ ...event, state }],
      };
      expect(
        validateSchema<WorktreeCoordinationDocument>(
          "worktree-coordination",
          legacy
        )
      ).toEqual(legacy);
    }
    expect(() =>
      validateSchema("worktree-coordination", {
        ...document,
        providerToken: "never-store-this",
      })
    ).toThrow("additional properties");
  });
});

describe("schema keyword support", () => {
  const supportedKeywords = new Set([
    "$defs",
    "$id",
    "$ref",
    "$schema",
    "additionalProperties",
    "allOf",
    "anyOf",
    "const",
    "description",
    "else",
    "enum",
    "format",
    "if",
    "items",
    "maxItems",
    "maxLength",
    "minItems",
    "minLength",
    "minimum",
    "pattern",
    "properties",
    "required",
    "then",
    "title",
    "type",
    "uniqueItems",
  ]);

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const collectViolations = (
    schema: Record<string, unknown>,
    path: string,
    violations: string[]
  ): void => {
    for (const [keyword, value] of Object.entries(schema)) {
      if (!supportedKeywords.has(keyword)) {
        violations.push(`${path}/${keyword}`);
        continue;
      }
      if (keyword === "additionalProperties" && typeof value !== "boolean") {
        violations.push(`${path}/${keyword}`);
        continue;
      }
      if (keyword === "properties" || keyword === "$defs") {
        if (isRecord(value)) {
          for (const [name, subschema] of Object.entries(value)) {
            if (isRecord(subschema)) {
              collectViolations(
                subschema,
                `${path}/${keyword}/${name}`,
                violations
              );
            }
          }
        }
        continue;
      }
      if (keyword === "allOf" || keyword === "anyOf") {
        if (Array.isArray(value)) {
          for (const [index, subschema] of value.entries()) {
            if (isRecord(subschema)) {
              collectViolations(
                subschema,
                `${path}/${keyword}/${index}`,
                violations
              );
            }
          }
        }
        continue;
      }
      if (
        (keyword === "items" ||
          keyword === "if" ||
          keyword === "then" ||
          keyword === "else") &&
        isRecord(value)
      ) {
        collectViolations(value, `${path}/${keyword}`, violations);
      }
    }
  };

  test("every packaged schema uses only keywords the validator enforces", () => {
    const schemaDirectory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../skills/simple-changes/evals/schemas"
    );
    const filenames = readdirSync(schemaDirectory).filter((filename) =>
      filename.endsWith(".schema.json")
    );
    expect(filenames.length).toBeGreaterThan(0);
    for (const filename of filenames) {
      const schema = JSON.parse(
        readFileSync(resolve(schemaDirectory, filename), "utf8")
      ) as Record<string, unknown>;
      const violations: string[] = [];
      collectViolations(schema, "", violations);
      expect({ filename, violations }).toEqual({ filename, violations: [] });
    }
  });
});
