import { describe, expect, test } from "bun:test";
import {
  changelogReceiptDigest,
  createChangelogRequest,
  decideReleaseGate,
  inspectChangelogTransaction,
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
  test("rejects version approval for internal-only work", () => {
    const internalOnly = receipt("decision-required");
    const decision = internalOnly.versionDecision;
    if (!decision) {
      throw new Error("fixture requires a version decision");
    }
    internalOnly.releaseImpact = "none";
    internalOnly.versionDecision = {
      ...decision,
      boundary: "none",
      bumpLevel: "none",
      suggestedVersion: null,
    };
    expect(() => validateChangelogTransaction(request(), internalOnly)).toThrow(
      "Internal-only or non-public work must not request a public version"
    );
  });

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

  test("negotiates only the features both sides support", () => {
    const consumer = packagedChangelogProtocol();
    expect(consumer.features).toContain("guidance-update-notices");
    expect(
      negotiateChangelogProtocol({
        distribution: "skill-repository",
        features: ["public-version-policy", "classify-prepare-verify"],
        guidanceVersion: 8,
        provider: "simple-changelogs",
        receiptVersions: [1, 2],
        requestVersions: [1],
        schemaDigests: consumer.schemaDigests,
        schemaVersion: 1,
      })
    ).toEqual({
      compatible: true,
      features: ["public-version-policy", "classify-prepare-verify"],
      reasonCode: null,
      receiptVersion: 2,
      requestVersion: 1,
      requiredAction: null,
      schemaDigestStatus: "match",
    });
  });

  test("fails closed for version skew", () => {
    const consumer = packagedChangelogProtocol();
    expect(
      negotiateChangelogProtocol({
        distribution: "web",
        features: [],
        guidanceVersion: 1,
        provider: "simple-changelogs",
        receiptVersions: [1],
        requestVersions: [2],
        schemaDigests: consumer.schemaDigests,
        schemaVersion: 1,
      })
    ).toEqual({
      compatible: false,
      features: [],
      reasonCode: "unsupported-protocol",
      receiptVersion: 1,
      requestVersion: null,
      requiredAction: "upgrade-producer",
      schemaDigestStatus: "match",
    });
  });

  test("rejects a provider that advertises no usable protocol version", () => {
    expect(() =>
      negotiateChangelogProtocol({
        distribution: "web",
        features: [],
        guidanceVersion: 1,
        provider: "simple-changelogs",
        receiptVersions: [1],
        requestVersions: [0],
        schemaVersion: 1,
      })
    ).toThrow();
  });

  test("reports schema drift without blocking a version-compatible peer", () => {
    const consumer = packagedChangelogProtocol();
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
      })
    ).toMatchObject({
      compatible: true,
      reasonCode: null,
      schemaDigestStatus: "differs",
    });
  });

  test("negotiates a provider that advertises no schema digests", () => {
    expect(
      negotiateChangelogProtocol({
        distribution: "web",
        features: [],
        guidanceVersion: 1,
        provider: "simple-changelogs",
        receiptVersions: [1, 2],
        requestVersions: [1],
        schemaVersion: 1,
      })
    ).toMatchObject({
      compatible: true,
      receiptVersion: 2,
      schemaDigestStatus: "unadvertised",
    });
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

  test("binds a transaction whose request omits attempt and environment", () => {
    const { attempt, environment, ...minimal } = request();
    expect(attempt).toBe(1);
    expect(environment).toBe("production");
    const classify = createChangelogRequest(minimal);
    expect(classify).not.toHaveProperty("attempt");
    expect(validateChangelogTransaction(classify, receipt())).toMatchObject({
      status: "decision-required",
    });
    expect(
      decideReleaseGate({
        alreadyLive: false,
        productionAuthorized: false,
        productionDeploy: "allow",
        receipt: receipt(),
        request: classify,
        versionAuthorized: false,
      })
    ).toMatchObject({ action: "request-version-approval" });
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

  test("binds a later phase to the receipt it builds on", () => {
    const classified = receipt("decision-required");
    const prepare = {
      ...request("prepare"),
      priorReceiptDigest: changelogReceiptDigest(classified),
    };

    expect(
      inspectChangelogTransaction(prepare, receipt("prepared"), classified)
    ).toMatchObject({
      priorReceiptDigestStatus: "verified",
      receipt: { status: "prepared" },
    });
    expect(
      inspectChangelogTransaction(prepare, receipt("prepared"))
    ).toMatchObject({ priorReceiptDigestStatus: "unverified" });
    expect(
      inspectChangelogTransaction(request("classify"), receipt())
        .priorReceiptDigestStatus
    ).toBe("not-applicable");

    expect(
      decideReleaseGate({
        alreadyLive: false,
        productionAuthorized: true,
        productionDeploy: "allow",
        receipt: receipt("prepared"),
        request: prepare,
        versionAuthorized: true,
      })
    ).toMatchObject({ action: "block", reasonCode: "malformed-request" });

    expect(
      decideReleaseGate({
        alreadyLive: false,
        priorReceipt: classified,
        productionAuthorized: true,
        productionDeploy: "allow",
        receipt: receipt("prepared"),
        request: prepare,
        versionAuthorized: true,
      })
    ).toMatchObject({ action: "merge-reconciliation" });
  });

  test("fails closed on a prior receipt that does not match the request", () => {
    const stale = receipt("decision-required");
    stale.evidence = ["Aggregate impact was re-derived."];
    const prepare = {
      ...request("prepare"),
      priorReceiptDigest: changelogReceiptDigest(receipt("decision-required")),
    };

    expect(() =>
      validateChangelogTransaction(prepare, receipt("prepared"), stale)
    ).toThrow("Prior receipt digest does not match");
    expect(() =>
      validateChangelogTransaction(request("classify"), receipt(), stale)
    ).toThrow("names no prior receipt digest");
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

// The CMS distribution owns a version-less operator history: its handoff
// prepares and verifies an entry on the `none` boundary and never a version.
describe("entry-only operator-history handoff", () => {
  const entryRequest = (
    phase: ChangelogRequest["phase"] = "classify"
  ): ChangelogRequest => ({
    ...request(phase),
    approvedVersion: null,
    boundary: "none",
    releaseTrain: "cms-operators",
    transactionId: "cms-entry-01",
  });

  const entryReceipt = (
    status: Extract<
      ChangelogReceiptV2["status"],
      "prepared" | "verified" | "not-applicable"
    >
  ): ChangelogReceiptV2 => {
    const base = receipt(status);
    return {
      ...base,
      evidence: ["Operator-visible workflow change recorded."],
      paths:
        status === "prepared"
          ? [{ digest: "f".repeat(64), path: "CMS_CHANGELOG.json" }]
          : [],
      release: null,
      releaseImpact: status === "not-applicable" ? "none" : "minor",
      transactionId: "cms-entry-01",
      versionDecision: {
        boundary: "none",
        bumpLevel: "none",
        currentVersion: null,
        policyAction: "not-applicable",
        releaseTrain: "cms-operators",
        resolution: "not-required",
        selectedVersion: null,
        source: "repository-policy",
        suggestedVersion: null,
      },
    };
  };

  const gate = (
    phase: ChangelogRequest["phase"],
    status: "prepared" | "verified" | "not-applicable",
    overrides: Partial<
      Omit<ReleaseGateContextInput, "request" | "receipt">
    > = {}
  ) =>
    decideReleaseGate({
      alreadyLive: false,
      productionAuthorized: false,
      productionDeploy: "ask",
      versionAuthorized: false,
      ...overrides,
      receipt: entryReceipt(status),
      request: entryRequest(phase),
    });

  test("accepts a version-less prepare request on the none boundary only", () => {
    expect(createChangelogRequest(entryRequest("prepare"))).toMatchObject({
      approvedVersion: null,
      boundary: "none",
    });
    expect(() =>
      createChangelogRequest({ ...request("prepare"), approvedVersion: null })
    ).toThrow();
    expect(() =>
      createChangelogRequest({
        ...entryRequest("prepare"),
        approvedVersion: "1.0.0",
      })
    ).toThrow();
  });

  test("merges a prepared entry regardless of production policy", () => {
    expect(gate("prepare", "prepared")).toMatchObject({
      action: "merge-reconciliation",
      selectedVersion: null,
    });
    expect(
      gate("prepare", "prepared", { productionDeploy: "deny" }).action
    ).toBe("merge-reconciliation");
  });

  test("continues after a verified entry and never deploys", () => {
    expect(gate("verify", "verified")).toMatchObject({
      action: "continue",
      selectedVersion: null,
    });
    expect(
      gate("verify", "verified", {
        productionAuthorized: true,
        productionDeploy: "allow",
      }).action
    ).toBe("continue");
  });

  test("continues when the change is not operator-relevant", () => {
    expect(gate("classify", "not-applicable").action).toBe("continue");
  });

  test("accepts a null version decision on the none boundary", () => {
    const prepared = { ...entryReceipt("prepared"), versionDecision: null };
    expect(
      validateChangelogTransaction(entryRequest("prepare"), prepared)
    ).toMatchObject({ status: "prepared" });
  });

  test("rejects a version on the none boundary", () => {
    const versioned = entryReceipt("prepared");
    versioned.release = {
      date: "2026-08-10",
      targetContainedUnreleased: "prepared",
      version: "0.10.0",
    };
    expect(() =>
      validateChangelogTransaction(entryRequest("prepare"), versioned)
    ).toThrow("must not name a release");

    const bumped = entryReceipt("prepared");
    if (bumped.versionDecision) {
      bumped.versionDecision.bumpLevel = "patch";
    }
    expect(() =>
      validateChangelogTransaction(entryRequest("prepare"), bumped)
    ).toThrow();
  });

  test("still requires a release on a web-production boundary", () => {
    // A versioned decision with no release record already fails the schema;
    // a version-less receipt passes it and must then fail the boundary binding.
    const versionedWithoutRelease = receipt("prepared");
    versionedWithoutRelease.release = null;
    expect(() =>
      validateChangelogTransaction(request("prepare"), versionedWithoutRelease)
    ).toThrow("must match one allowed schema");

    const versionless = {
      ...receipt("prepared"),
      release: null,
      versionDecision: null,
    };
    expect(() =>
      validateChangelogTransaction(request("prepare"), versionless)
    ).toThrow("must name the release");

    const verifiedWithoutRelease = {
      ...receipt("verified"),
      release: null,
      versionDecision: null,
    };
    expect(() =>
      validateChangelogTransaction(request("verify"), verifiedWithoutRelease)
    ).toThrow("must name the release");
  });
});

type ReleaseGateContextInput = Parameters<typeof decideReleaseGate>[0];
