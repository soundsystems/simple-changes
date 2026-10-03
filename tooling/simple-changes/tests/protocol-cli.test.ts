import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  changelogReceiptDigest,
  packagedChangelogProtocol,
} from "../../../skills/simple-changes/scripts/lib/release-gate.ts";
import {
  createTestRepository,
  git,
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
      receiptVersion: 3,
      requestVersion: 2,
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
      priorReceiptDigestStatus: "not-applicable",
      receipt: { schemaVersion: 1, status: "not-applicable" },
      valid: true,
    });
  });

  test("verifies the prior receipt digest when the prior receipt is supplied", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const priorReceipt = {
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
    };
    writeFixture(
      fixture.root,
      "request.json",
      JSON.stringify({
        approvedDecisionDigest: null,
        approvedVersion: null,
        attempt: 2,
        boundary: "none",
        environment: "production",
        finalizedTargetRevision: null,
        inputTargetRevision: revision,
        mutationScope: "read-only",
        phase: "classify",
        priorReceiptDigest: changelogReceiptDigest(priorReceipt),
        releaseSetId: null,
        releaseTrain: "web",
        schemaVersion: 1,
        supportedReceiptVersions: [1],
        transactionId: "legacy-classification",
      })
    );
    writeFixture(fixture.root, "receipt.json", JSON.stringify(priorReceipt));
    writeFixture(
      fixture.root,
      "prior-receipt.json",
      JSON.stringify(priorReceipt)
    );
    writeFixture(
      fixture.root,
      "stale-receipt.json",
      JSON.stringify({ ...priorReceipt, checks: ["Re-derived."] })
    );

    const unverified = runCli(
      fixture.root,
      "validate-changelog-transaction",
      "request.json",
      "receipt.json",
      "--json"
    );
    expect(unverified.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(unverified.stdout))).toMatchObject({
      priorReceiptDigestStatus: "unverified",
      valid: true,
    });

    const verified = runCli(
      fixture.root,
      "validate-changelog-transaction",
      "request.json",
      "receipt.json",
      "--prior-receipt",
      "prior-receipt.json",
      "--json"
    );
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(verified.stdout))).toMatchObject({
      priorReceiptDigestStatus: "verified",
      valid: true,
    });

    const mismatched = runCli(
      fixture.root,
      "validate-changelog-transaction",
      "request.json",
      "receipt.json",
      "--prior-receipt",
      "stale-receipt.json"
    );
    expect(mismatched.exitCode).not.toBe(0);
    expect(decoder.decode(mismatched.stderr)).toContain(
      "Prior receipt digest does not match"
    );
  });

  test("decides the release gate and builds the delivery receipt from files", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const revisionC = "c".repeat(40);
    const digest = "d".repeat(64);
    writeFixture(
      fixture.root,
      "request.json",
      JSON.stringify({
        approvedDecisionDigest: digest,
        approvedVersion: "0.10.0",
        attempt: 1,
        boundary: "web-production",
        environment: "production",
        finalizedTargetRevision: revisionC,
        inputTargetRevision: revision,
        mutationScope: "read-only",
        phase: "verify",
        priorReceiptDigest: null,
        releaseSetId: null,
        releaseTrain: "web",
        schemaVersion: 1,
        supportedReceiptVersions: [1, 2],
        transactionId: "release-01",
      })
    );
    writeFixture(
      fixture.root,
      "receipt.json",
      JSON.stringify({
        checks: ["Inspected exact target."],
        decisionDigest: digest,
        effectivePolicyDigest: "e".repeat(64),
        evidence: ["Aggregate impact is minor."],
        observedAt: "2026-09-02T12:00:00-05:00",
        paths: [],
        phase: "verify",
        provider: "simple-changelogs",
        reason: null,
        reasonCode: null,
        release: {
          date: "2026-09-02",
          targetContainedUnreleased: "integrated",
          version: "0.10.0",
        },
        releaseImpact: "minor",
        releaseSetId: null,
        requiredAction: null,
        revisionLineage: {
          finalizedTargetRevision: revisionC,
          inputTargetRevision: revision,
          reconciliationHeadRevision: "b".repeat(40),
        },
        schemaVersion: 2,
        sourceRevision: revisionC,
        status: "verified",
        transactionId: "release-01",
        versionDecision: {
          boundary: "web-production",
          bumpLevel: "minor",
          currentVersion: "0.9.0",
          policyAction: "automatic",
          releaseTrain: "web",
          resolution: "automatic",
          selectedVersion: "0.10.0",
          source: "repository-policy",
          suggestedVersion: "0.10.0",
        },
      })
    );
    const deployment = (observedRevision: string) => ({
      action: "deploy-production",
      approvalRevision: null,
      baseRevision: null,
      canonicalTargets: [
        {
          matches: true,
          resolvedResultId: "dpl_1",
          url: "https://example.test",
        },
      ],
      deliveryModel: "git-connected",
      environment: "production",
      evidence: ["vercel inspect dpl_1"],
      expectedCanonicalTargets: ["https://example.test"],
      headRevision: observedRevision,
      immutableResultId: "dpl_1",
      intendedRevision: revisionC,
      kind: "deployment",
      objectId: "dpl_1",
      observedAt: "2026-09-02T12:05:00-05:00",
      observedRevision,
      project: "web",
      provider: "vercel",
      providerReady: true,
      schemaVersion: 1,
      smoke: { journey: "checkout", passed: true },
      status: "succeeded",
      url: "https://example.test",
    });
    writeFixture(
      fixture.root,
      "deployment.json",
      JSON.stringify(deployment(revisionC))
    );
    writeFixture(
      fixture.root,
      "drifted-deployment.json",
      JSON.stringify(deployment("f".repeat(40)))
    );

    const awaiting = runCli(
      fixture.root,
      "release-gate",
      "--request",
      "request.json",
      "--receipt",
      "receipt.json",
      "--production",
      "ask",
      "--json"
    );
    expect(awaiting.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(awaiting.stdout))).toMatchObject({
      action: "request-production-approval",
      selectedVersion: "0.10.0",
    });

    const deploy = runCli(
      fixture.root,
      "release-gate",
      "--request",
      "request.json",
      "--receipt",
      "receipt.json",
      "--production",
      "ask",
      "--production-authorized",
      "--json"
    );
    expect(deploy.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(deploy.stdout))).toMatchObject({
      action: "deploy",
    });

    // Every decision exits zero, including `block`; callers route on `action`.
    const request = JSON.parse(
      readFileSync(resolve(fixture.root, "request.json"), "utf8")
    );
    writeFixture(
      fixture.root,
      "unbound-request.json",
      JSON.stringify({ ...request, priorReceiptDigest: "f".repeat(64) })
    );
    const blocked = runCli(
      fixture.root,
      "release-gate",
      "--request",
      "unbound-request.json",
      "--receipt",
      "receipt.json",
      "--production",
      "allow",
      "--production-authorized",
      "--json"
    );
    expect(blocked.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(blocked.stdout))).toMatchObject({
      action: "block",
      reasonCode: "malformed-request",
    });

    // Rejected inputs exit nonzero and decide nothing.
    const rejected = runCli(
      fixture.root,
      "release-gate",
      "--request",
      "unbound-request.json",
      "--receipt",
      "receipt.json",
      "--prior-receipt",
      "receipt.json",
      "--production",
      "allow",
      "--json"
    );
    expect(rejected.exitCode).toBe(3);
    expect(decoder.decode(rejected.stdout)).not.toContain('"action"');
    expect(decoder.decode(rejected.stderr)).toContain(
      "Prior receipt digest does not match"
    );

    const complete = runCli(
      fixture.root,
      "release-delivery",
      "--changelog-receipt",
      "receipt.json",
      "--provider-receipt",
      "deployment.json",
      "--request",
      "request.json",
      "--json"
    );
    expect(complete.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(complete.stdout))).toMatchObject({
      deployedRevision: revisionC,
      releaseTrain: "web",
      status: "complete",
      transactionId: "release-01",
      version: "0.10.0",
    });

    const drifted = runCli(
      fixture.root,
      "release-delivery",
      "--changelog-receipt",
      "receipt.json",
      "--provider-receipt",
      "drifted-deployment.json",
      "--json"
    );
    expect(drifted.exitCode).not.toBe(0);
    expect(JSON.parse(decoder.decode(drifted.stdout))).toMatchObject({
      reasonCode: "deployment-revision-mismatch",
      status: "blocked",
    });

    // Receipt v3 carries the same lineage, so delivery accepts it unchanged.
    const v2 = JSON.parse(
      readFileSync(resolve(fixture.root, "receipt.json"), "utf8")
    );
    writeFixture(
      fixture.root,
      "receipt-v3.json",
      JSON.stringify({
        ...v2,
        releaseSetTrains: null,
        schemaVersion: 3,
        versionDecision: { ...v2.versionDecision, versionLine: null },
      })
    );
    const v3Delivery = runCli(
      fixture.root,
      "release-delivery",
      "--changelog-receipt",
      "receipt-v3.json",
      "--provider-receipt",
      "deployment.json",
      "--json"
    );
    expect(v3Delivery.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(v3Delivery.stdout))).toMatchObject({
      status: "complete",
      version: "0.10.0",
    });
  });

  test("builds the proposal signature block from commit trailers", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "feature.ts", "export const feature = 1;\n");
    git(fixture.root, ["checkout", "-b", "feature"]);
    git(fixture.root, ["add", "feature.ts"]);
    git(fixture.root, [
      "commit",
      "-m",
      "feat: Feature\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
    ]);

    const result = runCli(
      fixture.root,
      "proposal-signatures",
      "--agent",
      "Fable 5.1",
      "--role",
      "authored",
      "--base",
      "main",
      "--head",
      "feature",
      "--json"
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(result.stdout))).toMatchObject({
      block: "[[Authored by Fable 5.1]]\n[[Co-authored by Opus 5]]",
    });
    const badRole = runCli(
      fixture.root,
      "proposal-signatures",
      "--agent",
      "Fable 5.1",
      "--role",
      "shipped"
    );
    expect(badRole.exitCode).not.toBe(0);
  });
  test("checks one release set's receipts together", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const receiptFor = (train: string, version: string) => ({
      checks: ["Inspected exact target."],
      decisionDigest: "d".repeat(64),
      effectivePolicyDigest: "e".repeat(64),
      evidence: ["Both trains release together."],
      observedAt: "2026-10-02T12:00:00-05:00",
      paths: [{ digest: "f".repeat(64), path: `${train}/CHANGELOG.md` }],
      phase: "prepare",
      provider: "simple-changelogs",
      reason: null,
      reasonCode: null,
      release: {
        date: "2026-10-02",
        targetContainedUnreleased: "prepared",
        version,
      },
      releaseImpact: "minor",
      releaseSetId: "set-1",
      releaseSetTrains: ["ios", "web"],
      requiredAction: null,
      revisionLineage: {
        finalizedTargetRevision: null,
        inputTargetRevision: revision,
        reconciliationHeadRevision: "b".repeat(40),
      },
      schemaVersion: 3,
      sourceRevision: revision,
      status: "prepared",
      transactionId: `release-${train}`,
      versionDecision: {
        boundary: "store-release",
        bumpLevel: "minor",
        currentVersion: "0.9.0",
        policyAction: "automatic",
        releaseTrain: train,
        resolution: "automatic",
        selectedVersion: version,
        source: "repository-policy",
        suggestedVersion: version,
        versionLine: {
          members: ["ios", "web"],
          memberVersions: { ios: "0.9.0", web: "0.9.0" },
          mode: "bump-shared",
          outcome: "advance",
          sharedVersion: "0.9.0",
          sharedVersionTrains: ["ios", "web"],
        },
      },
    });
    writeFixture(
      fixture.root,
      "web.json",
      JSON.stringify(receiptFor("web", "0.10.0"))
    );
    writeFixture(
      fixture.root,
      "ios.json",
      JSON.stringify(receiptFor("ios", "0.10.0"))
    );
    writeFixture(
      fixture.root,
      "ios-off.json",
      JSON.stringify(receiptFor("ios", "0.11.0"))
    );

    const agreed = runCli(
      fixture.root,
      "validate-changelog-release-set",
      "web.json",
      "ios.json",
      "--json"
    );
    expect(agreed.exitCode).toBe(0);
    expect(JSON.parse(decoder.decode(agreed.stdout))).toMatchObject({
      lines: [{ members: ["ios", "web"], selectedVersion: "0.10.0" }],
      missingTrains: [],
      receipts: 2,
      releaseSetId: "set-1",
      valid: true,
    });

    const split = runCli(
      fixture.root,
      "validate-changelog-release-set",
      "web.json",
      "ios-off.json"
    );
    expect(split.exitCode).toBe(3);
    expect(decoder.decode(split.stderr)).toContain("must take one number");

    const usage = runCli(
      fixture.root,
      "validate-changelog-release-set",
      "web.json"
    );
    expect(usage.exitCode).toBe(2);
  });
});
