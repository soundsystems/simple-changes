import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { packagedChangelogProtocol } from "../../../skills/simple-changes/scripts/lib/release-gate.ts";
import {
  createTestRepository,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const decoder = new TextDecoder();
const cliPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const revision = "a".repeat(40);
let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const runCli = (cwd: string, ...args: string[]) =>
  spawnSync([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
    stderr: "pipe",
    stdout: "pipe",
  });

describe("changelog protocol CLI", () => {
  test("negotiates packaged capabilities", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const protocol = packagedChangelogProtocol();
    writeFixture(
      fixture.root,
      "capabilities.json",
      JSON.stringify({
        distribution: "web",
        features: protocol.features,
        guidanceVersion: 14,
        provider: "simple-changelogs",
        receiptVersions: protocol.receiptVersions,
        requestVersions: protocol.requestVersions,
        schemaDigests: protocol.schemaDigests,
        schemaVersion: 1,
      })
    );

    const result = runCli(
      fixture.root,
      "negotiate-changelog",
      "capabilities.json",
      "--json"
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(result.stdout))).toMatchObject({
      compatible: true,
      receiptVersion: 2,
      requestVersion: 1,
    });
  });

  test("validates a bound legacy classification transaction", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "request.json",
      JSON.stringify({
        approvedDecisionDigest: null,
        approvedVersion: null,
        attempt: 1,
        boundary: "none",
        environment: "production",
        finalizedTargetRevision: null,
        inputTargetRevision: revision,
        mutationScope: "read-only",
        phase: "classify",
        priorReceiptDigest: null,
        releaseSetId: null,
        releaseTrain: "web",
        schemaVersion: 1,
        supportedReceiptVersions: [1],
        transactionId: "legacy-classification",
      })
    );
    writeFixture(
      fixture.root,
      "receipt.json",
      JSON.stringify({
        checks: [],
        evidence: [],
        observedAt: "2026-08-10T12:00:00-05:00",
        paths: [],
        provider: "simple-changelogs",
        reason: null,
        release: null,
        releaseImpact: "none",
        schemaVersion: 1,
        sourceRevision: revision,
        status: "not-applicable",
      })
    );

    const result = runCli(
      fixture.root,
      "validate-changelog-transaction",
      "request.json",
      "receipt.json",
      "--json"
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(result.stdout))).toMatchObject({
      receipt: { schemaVersion: 1, status: "not-applicable" },
      valid: true,
    });
  });
});
