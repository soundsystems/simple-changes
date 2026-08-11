import { describe, expect, test } from "bun:test";
import {
  changelogReceiptDigest,
  createChangelogRequest,
  decideReleaseGate,
  negotiateChangelogProtocol,
  packagedChangelogProtocol,
  validateChangelogTransaction,
} from "../../../skills/simple-changes/scripts/lib/release-gate.ts";
import type {
  ChangelogReceiptV2,
  ChangelogRequest,
} from "../../../skills/simple-changes/scripts/lib/types.ts";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const revisionC = "c".repeat(40);
const digest = "d".repeat(64);

const request = (
  phase: ChangelogRequest["phase"] = "classify"
): ChangelogRequest => ({
  approvedDecisionDigest: phase === "classify" ? null : digest,
  approvedVersion: phase === "classify" ? null : "0.10.0",
  attempt: 1,
  boundary: "web-production",
  environment: "production",
  finalizedTargetRevision: phase === "verify" ? revisionC : null,
  inputTargetRevision: revisionA,
  mutationScope: phase === "prepare" ? "prepare-release-files" : "read-only",
  phase,
  priorReceiptDigest: null,
  releaseSetId: null,
  releaseTrain: "web",
  schemaVersion: 1,
  supportedReceiptVersions: [1, 2],
  transactionId: "release-01",
});

const receipt = (
  status: ChangelogReceiptV2["status"] = "decision-required"
): ChangelogReceiptV2 => {
  const phases: Record<
    ChangelogReceiptV2["status"],
    ChangelogReceiptV2["phase"]
  > = {
    blocked: "classify",
    "decision-required": "classify",
    "not-applicable": "classify",
    prepared: "prepare",
    verified: "verify",
  };
  const phase = phases[status];
  const selected =
    status === "prepared" || status === "verified" ? "0.10.0" : null;
  return {
    checks: ["Inspected exact target."],
    decisionDigest: digest,
    effectivePolicyDigest: "e".repeat(64),
    evidence: ["Aggregate impact is minor."],
    observedAt: "2026-08-10T12:00:00-05:00",
    paths:
      status === "prepared"
        ? [{ digest: "f".repeat(64), path: "CHANGELOG.md" }]
        : [],
    phase,
    provider: "simple-changelogs",
    reason:
      status === "decision-required" ? "Choose the proposed version." : null,
    reasonCode:
      status === "decision-required" ? "version-direction-required" : null,
    release:
      status === "prepared" || status === "verified"
        ? {
            date: "2026-08-10",
            targetContainedUnreleased:
              status === "verified" ? "integrated" : "prepared",
            version: "0.10.0",
          }
        : null,
    releaseImpact: "minor",
    releaseSetId: null,
    requiredAction: status === "decision-required" ? "choose-version" : null,
    revisionLineage: {
      finalizedTargetRevision: status === "verified" ? revisionC : null,
      inputTargetRevision: revisionA,
      reconciliationHeadRevision:
        status === "prepared" || status === "verified" ? revisionB : null,
    },
    schemaVersion: 2,
    sourceRevision: status === "verified" ? revisionC : revisionA,
    status,
    transactionId: "release-01",
    versionDecision: {
      boundary: "web-production",
      bumpLevel: "minor",
      currentVersion: "0.9.0",
      policyAction: status === "decision-required" ? "ask" : "automatic",
      releaseTrain: "web",
      resolution:
        status === "decision-required" ? "approval-required" : "automatic",
      selectedVersion: selected,
      source: "repository-policy",
      suggestedVersion: "0.10.0",
    },
  };
};

describe("changelog protocol negotiation", () => {
  test("negotiates the highest mutually supported exact schemas", () => {
    const consumer = packagedChangelogProtocol();
    expect(
      negotiateChangelogProtocol({
        distribution: "web",
        features: consumer.features,
        guidanceVersion: 14,
        provider: "simple-changelogs",
        receiptVersions: [1, 2],
        requestVersions: [1],
        schemaDigests: consumer.schemaDigests,
        schemaVersion: 1,
      })
    ).toMatchObject({
      compatible: true,
      receiptVersion: 2,
      requestVersion: 1,
    });
  });

  test("accepts producer capability supersets and negotiates only shared features", () => {
    const consumer = packagedChangelogProtocol();
    expect(
      negotiateChangelogProtocol({
        distribution: "skill-repository",
        features: [...consumer.features, "guidance-update-notices"],
        guidanceVersion: 8,
        provider: "simple-changelogs",
        receiptVersions: [1, 2],
        requestVersions: [1],
        schemaDigests: consumer.schemaDigests,
        schemaVersion: 1,
      })
    ).toEqual({
      compatible: true,
      features: consumer.features,
      reasonCode: null,
      receiptVersion: 2,
      requestVersion: 1,
      requiredAction: null,
    });
  });

  test("fails closed for version skew and schema skew", () => {
    const consumer = packagedChangelogProtocol();
    expect(
      negotiateChangelogProtocol(
        {
          distribution: "web",
          features: [],
          guidanceVersion: 1,
          provider: "simple-changelogs",
          receiptVersions: [1],
          requestVersions: [1],
          schemaDigests: consumer.schemaDigests,
          schemaVersion: 1,
        },
        { ...consumer, requestVersions: [] }
      ).reasonCode
    ).toBe("unsupported-protocol");
    expect(
      negotiateChangelogProtocol({
        distribution: "web",
        features: [],
        guidanceVersion: 1,
        provider: "simple-changelogs",
        receiptVersions: [1],
        requestVersions: [1],
        schemaDigests: {
          ...consumer.schemaDigests,
          changelogReceipt: "0".repeat(64),
        },
        schemaVersion: 1,
      }).reasonCode
    ).toBe("schema-digest-mismatch");
  });
});

describe("phased release gate", () => {
  test("keeps normal version direction distinct from a blocker", () => {
    const classify = createChangelogRequest(request());
    const classified = receipt();
    expect(changelogReceiptDigest(classified)).toHaveLength(64);
    expect(
      decideReleaseGate({
        alreadyLive: false,
        productionAuthorized: false,
        productionDeploy: "ask",
        receipt: classified,
        request: classify,
        versionAuthorized: false,
      })
    ).toMatchObject({
      action: "request-combined-approval",
      reasonCode: "version-direction-required",
      requiredAction: "choose-version",
    });
  });

  test("prepares, verifies, and avoids a duplicate live deployment", () => {
    const prepared = receipt("prepared");
    expect(
      decideReleaseGate({
        alreadyLive: false,
        productionAuthorized: true,
        productionDeploy: "allow",
        receipt: prepared,
        request: request("prepare"),
        versionAuthorized: true,
      }).action
    ).toBe("merge-reconciliation");

    const verified = receipt("verified");
    expect(
      decideReleaseGate({
        alreadyLive: true,
        productionAuthorized: true,
        productionDeploy: "allow",
        receipt: verified,
        request: request("verify"),
        versionAuthorized: true,
      }).action
    ).toBe("verify-existing-production");
  });

  test("invalidates a receipt for a moved finalized target", () => {
    const moved = receipt("verified");
    moved.revisionLineage.finalizedTargetRevision = "9".repeat(40);
    expect(() =>
      validateChangelogTransaction(request("verify"), moved)
    ).toThrow("finalized target");
  });

  test("rejects inconsistent resolved and prepared versions", () => {
    const unresolved = receipt("prepared");
    if (unresolved.versionDecision) {
      unresolved.versionDecision.selectedVersion = null;
    }
    expect(() =>
      validateChangelogTransaction(request("prepare"), unresolved)
    ).toThrow("selected version");

    const mismatched = receipt("prepared");
    if (mismatched.release) {
      mismatched.release.version = "0.11.0";
    }
    expect(() =>
      validateChangelogTransaction(request("prepare"), mismatched)
    ).toThrow("does not match");
  });
});
