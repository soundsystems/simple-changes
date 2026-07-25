import { describe, expect, test } from "bun:test";
import { inspectInitialization } from "../../../skills/simple-changes/scripts/lib/initialization.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import type { RepoPolicy } from "../../../skills/simple-changes/scripts/lib/types.ts";

describe("closed schemas", () => {
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
});
