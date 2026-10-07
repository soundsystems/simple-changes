import { describe, expect, test } from "bun:test";
import { spawnSync } from "bun";
import {
  changelogReceiptDigest,
  createChangelogRequest,
  decideReleaseGate,
  inspectChangelogTransaction,
  negotiateChangelogProtocol,
  packagedChangelogProtocol,
  validateChangelogReleaseSet,
  validateChangelogTransaction,
} from "../../../skills/simple-changes/scripts/lib/release-gate.ts";
import type {
  ChangelogReceiptV2,
  ChangelogReceiptV3,
  ChangelogReceiptV4,
  ChangelogRequest,
  ReleaseTag,
  VersionDecision,
  VersionDecisionV3,
  VersionLine,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import { compareStableVersions } from "../../../skills/simple-changes/scripts/lib/version-line.ts";

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
    classified: "classify",
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

  test("re-delegates a classified entry-only receipt for preparation", () => {
    const classified = receipt("classified");
    classified.release = null;
    classified.versionDecision = {
      boundary: "none",
      bumpLevel: "none",
      currentVersion: null,
      policyAction: "not-applicable",
      releaseTrain: "cms-operators",
      resolution: "not-required",
      selectedVersion: null,
      source: "repository-policy",
      suggestedVersion: null,
    };
    const entryRequest: ChangelogRequest = {
      ...request(),
      approvedVersion: null,
      boundary: "none",
      releaseTrain: "cms-operators",
      transactionId: "cms-entry-01",
    };
    classified.transactionId = "cms-entry-01";

    expect(
      decideReleaseGate({
        alreadyLive: false,
        productionAuthorized: false,
        productionDeploy: "deny",
        receipt: classified,
        request: entryRequest,
        versionAuthorized: false,
      })
    ).toMatchObject({
      action: "re-delegate",
      decisionDigest: digest,
      selectedVersion: null,
    });
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
        requestVersions: [4],
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
  test("accepts resolved public classification without pretending release files were prepared", () => {
    const classified = receipt("classified");
    if (!classified.versionDecision) {
      throw new Error("Expected public direction.");
    }
    classified.versionDecision.selectedVersion = "0.10.0";
    expect(validateChangelogTransaction(request(), classified).status).toBe(
      "classified"
    );
    expect(
      decideReleaseGate({
        alreadyLive: false,
        productionAuthorized: false,
        productionDeploy: "ask",
        receipt: classified,
        request: request(),
        versionAuthorized: false,
      }).action
    ).toBe("re-delegate");
    // An ask policy resolves only by explicit direction.
    const asked = structuredClone(classified);
    if (asked.versionDecision) {
      asked.versionDecision.policyAction = "ask";
      asked.versionDecision.resolution = "explicit-direction";
    }
    expect(validateChangelogTransaction(request(), asked).status).toBe(
      "classified"
    );
    for (const variant of [
      "train",
      "revision",
      "unresolved",
      "prepared",
      "ask-automatic",
      "ask-repository-automation",
    ] as const) {
      const changed = structuredClone(classified);
      if (variant.startsWith("ask-") && changed.versionDecision) {
        changed.versionDecision.policyAction = "ask";
        changed.versionDecision.resolution =
          variant === "ask-automatic" ? "automatic" : "repository-automation";
      }
      if (variant === "train" && changed.versionDecision) {
        changed.versionDecision.releaseTrain = "ios";
      }
      if (variant === "revision") {
        changed.sourceRevision = revisionB;
      }
      if (variant === "unresolved" && changed.versionDecision) {
        changed.versionDecision.selectedVersion = null;
      }
      if (variant === "prepared") {
        changed.revisionLineage.reconciliationHeadRevision = revisionB;
      }
      expect(() => validateChangelogTransaction(request(), changed)).toThrow();
    }
    const prepareRequest = {
      ...request("prepare"),
      priorReceiptDigest: changelogReceiptDigest(classified),
    };
    expect(
      inspectChangelogTransaction(
        prepareRequest,
        receipt("prepared"),
        classified
      ).priorReceiptDigestStatus
    ).toBe("verified");
    const changedPrior = structuredClone(classified);
    changedPrior.evidence.push("Changed decision evidence");
    expect(() =>
      inspectChangelogTransaction(
        prepareRequest,
        receipt("prepared"),
        changedPrior
      )
    ).toThrow("Prior receipt digest");
  });

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

  test("classified entry-only receipts require a neutral decision in v2 and v3", () => {
    const neutral: ChangelogReceiptV2 = {
      ...entryReceipt("not-applicable"),
      releaseImpact: "minor",
      status: "classified",
    };
    const modern: ChangelogReceiptV3 = {
      ...neutral,
      releaseSetTrains: null,
      schemaVersion: 3,
      versionDecision: neutral.versionDecision
        ? { ...neutral.versionDecision, versionLine: null }
        : null,
    };
    const modernRequest: ChangelogRequest = {
      ...entryRequest(),
      releaseSetTrains: null,
      schemaVersion: 2,
      supportedReceiptVersions: [1, 2, 3],
    };
    for (const [classificationRequest, classified] of [
      [entryRequest(), neutral],
      [modernRequest, modern],
    ] as const) {
      expect(
        validateChangelogTransaction(classificationRequest, classified).status
      ).toBe("classified");
      expect(() =>
        validateChangelogTransaction(classificationRequest, {
          ...classified,
          versionDecision: null,
        })
      ).toThrow();
    }
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

describe("shared version lines (request v2, receipt v3)", () => {
  const requestV2 = (
    phase: ChangelogRequest["phase"] = "classify",
    overrides: Partial<ChangelogRequest> = {}
  ): ChangelogRequest => ({
    ...request(phase),
    releaseSetTrains: null,
    schemaVersion: 2,
    supportedReceiptVersions: [1, 2, 3],
    ...overrides,
  });

  // Web is behind iOS at 0.10.0 on a catch-up line, so it catches up.
  const line = (overrides: Partial<VersionLine> = {}): VersionLine => ({
    members: ["ios", "web"],
    memberVersions: { ios: "0.10.0", web: "0.9.0" },
    mode: "catch-up",
    outcome: "catch-up",
    sharedVersion: "0.10.0",
    sharedVersionTrains: ["ios"],
    ...overrides,
  });

  const receiptV3 = (
    status: ChangelogReceiptV2["status"] = "prepared",
    versionLine: VersionLine | null = line(),
    releaseSetTrains: string[] | null = null
  ): ChangelogReceiptV3 => {
    const base = receipt(status);
    const decision = base.versionDecision;
    return {
      ...base,
      releaseSetTrains,
      schemaVersion: 3,
      versionDecision: decision
        ? {
            ...decision,
            // A receipt's own previous version is its line entry.
            currentVersion: versionLine
              ? (versionLine.memberVersions[decision.releaseTrain] ?? null)
              : decision.currentVersion,
            versionLine,
          }
        : null,
    };
  };

  test("round-trips read-only resolved shared-line classification with unchanged protocol negotiation", () => {
    const classified = receiptV3("classified");
    if (!classified.versionDecision) {
      throw new Error("Expected line direction.");
    }
    classified.versionDecision.selectedVersion = "0.10.0";
    expect(validateChangelogTransaction(requestV2(), classified)).toMatchObject(
      { paths: [], release: null, schemaVersion: 3, status: "classified" }
    );
    const mismatch = structuredClone(classified);
    if (mismatch.versionDecision?.versionLine) {
      mismatch.versionDecision.versionLine.sharedVersion = "0.11.0";
    }
    expect(() => validateChangelogTransaction(requestV2(), mismatch)).toThrow();
    expect(() => validateChangelogTransaction(request(), classified)).toThrow(
      "did not advertise"
    );
  });

  const decisionOf = (value: ChangelogReceiptV3) => {
    if (!value.versionDecision) {
      throw new Error("fixture requires a version decision");
    }
    return value.versionDecision;
  };

  test("negotiates request v2 and receipt v3 and ignores unknown features", () => {
    const consumer = packagedChangelogProtocol();
    expect(consumer).toMatchObject({
      receiptVersions: [1, 2, 3, 4],
      requestVersions: [1, 2, 3],
    });
    expect(
      negotiateChangelogProtocol({
        distribution: "full",
        features: [
          "shared-version-lines",
          "a-later-feature",
          "multi-train-receipts",
        ],
        guidanceVersion: 24,
        provider: "simple-changelogs",
        receiptVersions: [1, 2, 3, 5],
        requestVersions: [1, 2, 9],
        schemaDigests: consumer.schemaDigests,
        schemaVersion: 1,
      })
    ).toMatchObject({
      compatible: true,
      // Producer order, as before 0.23.0.
      features: ["shared-version-lines", "multi-train-receipts"],
      receiptVersion: 3,
      requestVersion: 2,
    });
  });

  test("binds request v2's release set to its own train", () => {
    expect(() =>
      createChangelogRequest(
        requestV2("classify", { releaseSetTrains: ["ios", "web"] })
      )
    ).toThrow("Invalid changelog-request");
    expect(() =>
      createChangelogRequest(
        requestV2("classify", {
          releaseSetId: "set-1",
          releaseSetTrains: ["android", "ios"],
        })
      )
    ).toThrow("must include the releasing train");
    expect(
      createChangelogRequest(
        requestV2("classify", {
          releaseSetId: "set-1",
          releaseSetTrains: ["ios", "web"],
        })
      ).releaseSetTrains
    ).toEqual(["ios", "web"]);
    // Request v1 cannot advertise receipt v3.
    expect(() =>
      createChangelogRequest({
        ...request(),
        supportedReceiptVersions: [1, 2, 3],
      })
    ).toThrow("Invalid changelog-request");
  });

  test("accepts receipt v3 only for a request that advertised it", () => {
    expect(() =>
      validateChangelogTransaction(request("prepare"), receiptV3())
    ).toThrow("did not advertise receipt v3");
    expect(() =>
      validateChangelogTransaction(
        requestV2("prepare", { supportedReceiptVersions: [1, 2] }),
        receiptV3()
      )
    ).toThrow("did not advertise receipt v3");
    expect(
      validateChangelogTransaction(requestV2("prepare"), receiptV3())
    ).toMatchObject({
      schemaVersion: 3,
    });
  });

  test("checks a catch-up against the line head", () => {
    const behind = receiptV3();
    decisionOf(behind).selectedVersion = "0.10.1";
    if (behind.release) {
      behind.release.version = "0.10.1";
    }
    expect(() =>
      validateChangelogTransaction(
        requestV2("prepare", { approvedVersion: "0.10.1" }),
        behind
      )
    ).toThrow("must take the line head 0.10.0");
    expect(() =>
      validateChangelogTransaction(
        requestV2("prepare"),
        receiptV3(
          "prepared",
          line({
            memberVersions: { ios: "0.10.0", web: "0.10.0" },
            sharedVersionTrains: ["ios", "web"],
          })
        )
      )
    ).toThrow("Only a train behind the line head can catch up");
  });

  test("checks an advance and a bump-shared line", () => {
    const level = line({
      memberVersions: { ios: "0.9.0", web: "0.9.0" },
      outcome: "advance",
      sharedVersion: "0.9.0",
      sharedVersionTrains: ["ios", "web"],
    });
    expect(
      validateChangelogTransaction(
        requestV2("prepare"),
        receiptV3("prepared", level)
      )
    ).toMatchObject({ schemaVersion: 3 });
    expect(() =>
      validateChangelogTransaction(
        requestV2("prepare"),
        receiptV3("prepared", line({ outcome: "advance" }))
      )
    ).toThrow("must exceed the line head 0.10.0");
    expect(() =>
      validateChangelogTransaction(
        requestV2("prepare"),
        receiptV3("prepared", line({ mode: "bump-shared" }))
      )
    ).toThrow("A bump-shared line only ever advances");
    // A first release on a line with no stable version yet advances.
    expect(
      validateChangelogTransaction(
        requestV2("prepare"),
        receiptV3(
          "prepared",
          line({
            memberVersions: { ios: null, web: null },
            outcome: "advance",
            sharedVersion: null,
            sharedVersionTrains: [],
          })
        )
      )
    ).toMatchObject({ schemaVersion: 3 });
  });

  test("recomputes the line from memberVersions", () => {
    for (const [broken, message] of [
      [line({ members: ["web", "ios"] }), "sorted and unique"],
      [
        line({
          members: ["android", "ios"],
          memberVersions: { android: "0.1.0", ios: "0.10.0" },
        }),
        "including the releasing train",
      ],
      [
        line({ memberVersions: { ios: "0.10.0", tv: "0.9.0" } }),
        "must name exactly its members",
      ],
      // The schema itself refuses a prerelease member version.
      [
        line({ memberVersions: { ios: "0.10.0-beta.1", web: "0.9.0" } }),
        "Invalid changelog-receipt",
      ],
      [line({ sharedVersion: "0.9.0" }), "highest memberVersions value"],
      [line({ sharedVersionTrains: ["web"] }), "highest memberVersions value"],
    ] as const) {
      expect(() =>
        validateChangelogTransaction(
          requestV2("prepare"),
          receiptV3("prepared", broken)
        )
      ).toThrow(message);
    }
  });

  test("never lowers a train's own version", () => {
    const repeat = receiptV3(
      "prepared",
      line({
        memberVersions: { ios: "0.9.0", web: "0.10.0" },
        outcome: "advance",
        sharedVersionTrains: ["web"],
      })
    );
    expect(() =>
      validateChangelogTransaction(requestV2("prepare"), repeat)
    ).toThrow("must exceed its train's previous public version 0.10.0");
  });

  test("compares one to three dotted numbers, zero-padded", () => {
    expect(compareStableVersions("1.2", "1.2.0")).toBe(0);
    expect(compareStableVersions("1", "1.0.0+build.7")).toBe(0);
    expect(compareStableVersions("2026.10.2", "2026.9.30")).toBe(1);
    expect(compareStableVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareStableVersions("1.0.0-rc.1", "1.0.0")).toBeNull();
    expect(compareStableVersions("v1.0.0", "1.0.0")).toBeNull();
    const shortForm = receiptV3(
      "prepared",
      line({
        memberVersions: { ios: "0.10", web: "0.9.0" },
        sharedVersion: "0.10.0",
      })
    );
    expect(
      validateChangelogTransaction(requestV2("prepare"), shortForm)
    ).toMatchObject({ schemaVersion: 3 });
  });

  test("echoes the request's release set", () => {
    const setRequest = requestV2("prepare", {
      releaseSetId: "set-1",
      releaseSetTrains: ["ios", "web"],
    });
    const echoed = receiptV3("prepared", line(), ["ios", "web"]);
    echoed.releaseSetId = "set-1";
    expect(validateChangelogTransaction(setRequest, echoed)).toMatchObject({
      releaseSetTrains: ["ios", "web"],
    });
    const missing = receiptV3();
    missing.releaseSetId = "set-1";
    expect(() => validateChangelogTransaction(setRequest, missing)).toThrow(
      "must echo the delegated request"
    );
  });

  test("checks one release set's receipts together", () => {
    // Both trains release together from one target: one number for both.
    const sharedLine = line({
      memberVersions: { ios: "0.9.0", web: "0.9.0" },
      outcome: "advance",
      sharedVersion: "0.9.0",
      sharedVersionTrains: ["ios", "web"],
    });
    const forTrain = (train: string, version = "0.10.0") => {
      const value = receiptV3("prepared", sharedLine, ["ios", "web"]);
      value.releaseSetId = "set-1";
      value.transactionId = `release-${train}`;
      const decision = decisionOf(value);
      decision.releaseTrain = train;
      decision.selectedVersion = version;
      return value;
    };
    expect(
      validateChangelogReleaseSet([forTrain("web"), forTrain("ios")])
    ).toEqual({
      lines: [{ members: ["ios", "web"], selectedVersion: "0.10.0" }],
      missingTrains: [],
      receipts: 2,
      releaseSetId: "set-1",
    });
    expect(() =>
      validateChangelogReleaseSet([forTrain("web"), forTrain("ios", "0.10.1")])
    ).toThrow("must take one number");
    const moved = forTrain("ios");
    moved.revisionLineage.inputTargetRevision = revisionB;
    expect(() => validateChangelogReleaseSet([forTrain("web"), moved])).toThrow(
      "share its releaseSetId, input target revision, and releaseSetTrains"
    );
    expect(() =>
      validateChangelogReleaseSet([forTrain("web"), forTrain("android")])
    ).toThrow("Train android is not in the release set's releaseSetTrains");
    expect(() =>
      validateChangelogReleaseSet([forTrain("web"), receipt("prepared")])
    ).toThrow("needs receipt v3");
  });

  const setReceipt = (
    train: string,
    version: string,
    versionLine: VersionLine | null,
    trains = ["ios", "web"]
  ) => {
    const value = receiptV3("prepared", versionLine, trains);
    value.releaseSetId = "set-1";
    value.transactionId = `release-${train}`;
    const decision = decisionOf(value);
    decision.releaseTrain = train;
    decision.selectedVersion = version;
    return value;
  };
  const level = (members = ["ios", "web"]) =>
    line({
      members,
      memberVersions: Object.fromEntries(members.map((m) => [m, "0.9.0"])),
      outcome: "advance",
      sharedVersion: "0.9.0",
      sharedVersionTrains: members,
    });

  test("ties each train in a release set to one line", () => {
    const trains = ["android", "ios", "web"];
    // The two receipts disagree about which line web belongs to.
    expect(() =>
      validateChangelogReleaseSet([
        setReceipt("web", "0.10.0", level(["ios", "web"]), trains),
        setReceipt("ios", "0.11.0", level(["android", "ios", "web"]), trains),
      ])
    ).toThrow("Receipts disagree about the line ios belongs to");
    // iOS places web on its line, but web's own receipt has no line.
    expect(() =>
      validateChangelogReleaseSet([
        setReceipt("web", "0.12.0", null),
        setReceipt("ios", "0.10.0", level()),
      ])
    ).toThrow("Another receipt places web on the line [ios, web]");
  });

  test("requires a receipt's line to include its own train", () => {
    const trains = ["android", "ios", "web"];
    expect(() =>
      validateChangelogReleaseSet([
        setReceipt("ios", "0.10.0", level(), trains),
        setReceipt("android", "0.10.0", level(), trains),
      ])
    ).toThrow(
      "The receipt for android carries a line that does not include it"
    );
    // A receipt blocked before any version decision names no train and is
    // skipped by the per-train checks.
    const undecided = receiptV3("blocked", null, ["ios", "web"]);
    undecided.releaseSetId = "set-1";
    undecided.transactionId = "release-web";
    undecided.reason = "Two files claim the web version.";
    undecided.reasonCode = "version-owner-ambiguous";
    undecided.requiredAction = "resolve-version-owner";
    undecided.versionDecision = null;
    expect(
      validateChangelogReleaseSet([
        setReceipt("ios", "0.10.0", null),
        undecided,
      ]).missingTrains
    ).toEqual(["web"]);
  });

  test("refuses duplicate receipts and reports trains without one", () => {
    expect(() =>
      validateChangelogReleaseSet([
        setReceipt("ios", "0.10.0", level()),
        setReceipt("ios", "0.10.0", level()),
      ])
    ).toThrow("more than one receipt for ios");
    expect(
      validateChangelogReleaseSet([
        setReceipt("web", "0.10.0", level(), ["android", "ios", "web"]),
        setReceipt("ios", "0.10.0", level(), ["android", "ios", "web"]),
      ]).missingTrains
    ).toEqual(["android"]);
    const unlisted = setReceipt("ios", "0.10.0", level());
    unlisted.releaseSetTrains = null;
    expect(() =>
      validateChangelogReleaseSet([
        setReceipt("web", "0.10.0", level()),
        unlisted,
      ])
    ).toThrow("names no releaseSetTrains");
  });

  test("compares a release set by value but publishes one version string", () => {
    const reordered = setReceipt(
      "ios",
      "0.10.0",
      {
        ...level(),
        memberVersions: { ios: "0.9.0", web: "0.9" },
        sharedVersion: "0.9",
      },
      ["web", "ios"]
    );
    expect(
      validateChangelogReleaseSet([
        setReceipt("web", "0.10.0", level()),
        reordered,
      ]).receipts
    ).toBe(2);
    expect(() =>
      validateChangelogReleaseSet([
        setReceipt("web", "0.10.0", level()),
        setReceipt("ios", "0.10", level()),
      ])
    ).toThrow("must take one number, not 0.10.0 and 0.10");
  });

  test("keeps a blocked v3 receipt's closed-code routing", () => {
    const blocked = receiptV3(
      "blocked",
      line({
        memberVersions: { ios: "0.10.0", web: "0.10.0" },
        outcome: "advance",
        sharedVersionTrains: ["ios", "web"],
      })
    );
    blocked.reason = "The direction would fork the line.";
    blocked.reasonCode = "invalid-version-direction";
    blocked.requiredAction = "choose-version";
    const decision = decisionOf(blocked);
    decision.currentVersion = "0.10.0";
    decision.resolution = "blocked";
    decision.suggestedVersion = "0.10.0";
    expect(
      decideReleaseGate({
        alreadyLive: false,
        productionAuthorized: false,
        productionDeploy: "ask",
        receipt: blocked,
        request: requestV2(),
        versionAuthorized: false,
      })
    ).toMatchObject({
      action: "block",
      reasonCode: "invalid-version-direction",
      requiredAction: "choose-version",
    });
  });

  test("never selects below a stable currentVersion", () => {
    // The version owner says 2.0.0 while the line still records 1.0.0.
    const regressed = receiptV3(
      "prepared",
      line({
        memberVersions: { ios: "1.5.0", web: "1.0.0" },
        sharedVersion: "1.5.0",
      })
    );
    const decision = decisionOf(regressed);
    decision.currentVersion = "2.0.0";
    decision.selectedVersion = "1.5.0";
    if (regressed.release) {
      regressed.release.version = "1.5.0";
    }
    expect(() =>
      validateChangelogTransaction(
        requestV2("prepare", { approvedVersion: "1.5.0" }),
        regressed
      )
    ).toThrow("must not go below its train's current version 2.0.0");

    // A manifest already bumped to the number being released is fine.
    const bumped = receiptV3();
    decisionOf(bumped).currentVersion = "0.10.0";
    expect(
      validateChangelogTransaction(requestV2("prepare"), bumped)
    ).toMatchObject({ schemaVersion: 3 });

    // A train with no stable public release yet may still have a stable
    // owner version, and may catch up above it.
    const firstPublic = receiptV3(
      "prepared",
      line({
        memberVersions: { ios: "1.1.0", web: null },
        sharedVersion: "1.1.0",
      })
    );
    const first = decisionOf(firstPublic);
    first.currentVersion = "1.0.0";
    first.selectedVersion = "1.1.0";
    if (firstPublic.release) {
      firstPublic.release.version = "1.1.0";
    }
    expect(
      validateChangelogTransaction(
        requestV2("prepare", { approvedVersion: "1.1.0" }),
        firstPublic
      )
    ).toMatchObject({ schemaVersion: 3 });
  });

  test("refuses a bump-shared train reusing a number a partner released", () => {
    // memberVersions come from the set's shared input target, so a partner
    // holding H there released it before this set: web must advance past it.
    const partnerHead = line({
      memberVersions: { ios: "0.10.0", web: "0.9.0" },
      mode: "bump-shared",
      outcome: "advance",
      sharedVersionTrains: ["ios"],
    });
    const setRequest = requestV2("prepare", {
      releaseSetId: "set-1",
      releaseSetTrains: ["ios", "web"],
    });
    const sameSet = receiptV3("prepared", partnerHead, ["ios", "web"]);
    sameSet.releaseSetId = "set-1";
    expect(() => validateChangelogTransaction(setRequest, sameSet)).toThrow(
      "must exceed the line head 0.10.0"
    );
  });

  test("requires the decision digest to cover the line state", () => {
    const prior = receiptV3("decision-required");
    const prepare = requestV2("prepare", {
      priorReceiptDigest: changelogReceiptDigest(prior),
    });
    const changed = receiptV3(
      "prepared",
      line({
        memberVersions: { ios: "0.10.0", web: "0.9.1" },
      })
    );
    expect(() => inspectChangelogTransaction(prepare, changed, prior)).toThrow(
      "the digest must cover the line state"
    );
    expect(
      inspectChangelogTransaction(prepare, receiptV3(), prior)
        .priorReceiptDigestStatus
    ).toBe("verified");

    // An approved direction above the suggested catch-up turns it into an
    // advance under the same digest; the line state is unchanged.
    const overridden = receiptV3("prepared", line({ outcome: "advance" }));
    const decision = decisionOf(overridden);
    decision.resolution = "explicit-direction";
    decision.selectedVersion = "0.11.0";
    if (overridden.release) {
      overridden.release.version = "0.11.0";
    }
    expect(
      inspectChangelogTransaction(
        { ...prepare, approvedVersion: "0.11.0" },
        overridden,
        prior
      ).receipt
    ).toMatchObject({ schemaVersion: 3 });
  });

  test("reports field-level errors for an invalid request", () => {
    expect(() =>
      createChangelogRequest({
        ...request("prepare"),
        approvedDecisionDigest: null,
        mutationScope: "read-only",
      })
    ).toThrow('/mutationScope must equal "prepare-release-files"');
  });

  test("gates a v3 receipt exactly like v2", () => {
    expect(
      decideReleaseGate({
        alreadyLive: false,
        productionAuthorized: true,
        productionDeploy: "allow",
        receipt: receiptV3(),
        request: requestV2("prepare"),
        versionAuthorized: true,
      })
    ).toMatchObject({
      action: "merge-reconciliation",
      selectedVersion: "0.10.0",
    });
  });
});

describe("release tags (request v3, receipt v4)", () => {
  const TAG = { message: "Acme Web 0.10.0", name: "v0.10.0" };

  const requestV3 = (
    phase: ChangelogRequest["phase"] = "prepare",
    overrides: Partial<ChangelogRequest> = {}
  ): ChangelogRequest => ({
    ...request(phase),
    releaseSetTrains: null,
    schemaVersion: 3,
    supportedReceiptVersions: [1, 2, 3, 4],
    ...overrides,
  });

  const receiptV4 = (
    status: ChangelogReceiptV2["status"] = "prepared",
    tag: ReleaseTag | null = TAG,
    version = "0.10.0"
  ): ChangelogReceiptV4 => {
    const base = receipt(status);
    const decision = base.versionDecision;
    return {
      ...base,
      release: base.release ? { ...base.release, tag, version } : null,
      releaseSetTrains: null,
      schemaVersion: 4,
      versionDecision: decision
        ? {
            ...decision,
            selectedVersion: decision.selectedVersion ? version : null,
            suggestedVersion: version,
            versionLine: null,
          }
        : null,
    };
  };

  const withVersion = (version: string) =>
    requestV3("prepare", { approvedVersion: version });

  const producer = (
    requestVersions: number[],
    receiptVersions: number[]
  ): unknown => ({
    distribution: "full",
    features: [],
    guidanceVersion: 25,
    provider: "simple-changelogs",
    receiptVersions,
    requestVersions,
    schemaVersion: 1,
  });

  test("negotiates every row of the version table, capped by the request", () => {
    const negotiated = (
      requestVersions: number[],
      receiptVersions: number[],
      consumer = packagedChangelogProtocol()
    ) => {
      const result = negotiateChangelogProtocol(
        producer(requestVersions, receiptVersions),
        consumer
      );
      return [result.requestVersion, result.receiptVersion];
    };
    // Simple Changes 0.26.0 against each Simple Changelogs peer.
    expect(negotiated([1, 2, 3], [1, 2, 3, 4])).toEqual([3, 4]);
    expect(negotiated([1, 3], [1, 2, 4])).toEqual([3, 4]);
    expect(negotiated([1], [2])).toEqual([1, 2]);
    expect(negotiated([1, 2], [1, 2, 3])).toEqual([2, 3]);
    expect(negotiated([1], [1, 2])).toEqual([1, 2]);
    // An older controller negotiates exactly as it does today.
    const older = {
      ...packagedChangelogProtocol(),
      receiptVersions: [1, 2, 3] as Array<1 | 2 | 3 | 4>,
      requestVersions: [1, 2] as Array<1 | 2 | 3>,
    };
    expect(negotiated([1, 2, 3], [1, 2, 3, 4], older)).toEqual([2, 3]);
    expect(negotiated([1, 3], [1, 2, 4], older)).toEqual([1, 2]);
    // The cap: a request never pairs with a receipt it may not advertise.
    expect(negotiated([1], [1, 2, 3, 4])).toEqual([1, 2]);
    expect(negotiated([2], [1, 2, 3, 4])).toEqual([2, 3]);
    expect(negotiated([1, 2, 3], [1, 2, 3])).toEqual([3, 3]);
    expect(negotiated([3], [1, 2])).toEqual([3, 2]);
  });

  test("lets only request v3 advertise receipt v4", () => {
    expect(createChangelogRequest(requestV3()).schemaVersion).toBe(3);
    expect(() =>
      createChangelogRequest({
        ...requestV3(),
        schemaVersion: 2,
      })
    ).toThrow("Invalid changelog-request");
    expect(() =>
      createChangelogRequest({
        ...request("prepare"),
        supportedReceiptVersions: [1, 2, 4],
      })
    ).toThrow("Invalid changelog-request");
    expect(
      validateChangelogTransaction(requestV3(), receiptV4())
    ).toMatchObject({ release: { tag: TAG }, schemaVersion: 4 });
    expect(() =>
      validateChangelogTransaction(
        requestV3("prepare", { supportedReceiptVersions: [1, 2, 3] }),
        receiptV4()
      )
    ).toThrow("did not advertise receipt v4");
    // Request v3 still accepts every earlier receipt.
    expect(
      validateChangelogTransaction(requestV3(), receipt("prepared"))
    ).toMatchObject({ schemaVersion: 2 });
  });

  test("requires the release tag field and allows a null tag", () => {
    const tagged = receiptV4();
    const { tag: _tag, ...untaggedRelease } = tagged.release ?? {};
    const missing = { ...tagged, release: untaggedRelease };
    expect(() => validateChangelogTransaction(requestV3(), missing)).toThrow(
      "Invalid changelog-receipt"
    );
    expect(
      validateChangelogTransaction(requestV3(), receiptV4("prepared", null))
    ).toMatchObject({ release: { tag: null } });
  });

  test("binds the tag name to the version", () => {
    const accepted: [string, string][] = [
      ["v1.2.0", "1.2.0"],
      ["1.2.0", "1.2.0"],
      ["@acme/sdk@1.2.0", "1.2.0"],
      ["release-2026-10-07", "2026-10-07"],
      ["v1!2.0", "1!2.0"],
      ["v2.0.0-rc.1", "2.0.0-rc.1"],
    ];
    for (const [name, version] of accepted) {
      expect(
        validateChangelogTransaction(
          withVersion(version),
          receiptV4("prepared", { message: `Acme ${version}`, name }, version)
        )
      ).toMatchObject({ release: { tag: { name } } });
    }
    for (const name of ["v11.2.0", "v1.2.0-45", "1.1.2.0", "v1.2.1"]) {
      expect(() =>
        validateChangelogTransaction(
          withVersion("1.2.0"),
          receiptV4("prepared", { message: "Acme 1.2.0", name }, "1.2.0")
        )
      ).toThrow("must be 1.2.0 or end with it");
    }
  });

  test("refuses every ref-name failure class, as Git does", () => {
    const structural: [string, string][] = [
      ["a..b/1.2.0", "1.2.0"],
      ["a@{b/1.2.0", "1.2.0"],
      ["a//1.2.0", "1.2.0"],
      [".hidden/1.2.0", "1.2.0"],
      ["release.lock/1.2.0", "1.2.0"],
      ["/v1.2.0", "1.2.0"],
      ["v1.2.0/", "1.2.0/"],
      ["v1.2.0.", "1.2.0."],
    ];
    for (const [name, version] of structural) {
      const gitCheck = spawnSync([
        "git",
        "check-ref-format",
        `refs/tags/${name}`,
      ]);
      expect({ git: gitCheck.exitCode !== 0, name }).toEqual({
        git: true,
        name,
      });
      expect(() =>
        validateChangelogTransaction(
          withVersion(version),
          receiptV4("prepared", { message: "Acme", name }, version)
        )
      ).toThrow(`Release tag ${name} must not`);
    }
    // Git allows a leading dash under refs/tags/, but a name must never read
    // as an option.
    expect(() =>
      validateChangelogTransaction(
        withVersion("1.2.0"),
        receiptV4("prepared", { message: "Acme", name: "-1.2.0" }, "1.2.0")
      )
    ).toThrow("must not start with -");
    for (const name of [
      "v 1.2.0",
      "v~1.2.0",
      "v^1.2.0",
      "v:1.2.0",
      "v?1.2.0",
      "v*1.2.0",
      "v[1.2.0",
      "v\\1.2.0",
      "v\u007f1.2.0",
      "v\t1.2.0",
    ]) {
      expect(() =>
        validateChangelogTransaction(
          withVersion("1.2.0"),
          receiptV4("prepared", { message: "Acme", name }, "1.2.0")
        )
      ).toThrow("Invalid changelog-receipt");
    }
    for (const message of ["Two\nlines", "", "x".repeat(201), "Tab\there"]) {
      expect(() =>
        validateChangelogTransaction(
          requestV3(),
          receiptV4("prepared", { message, name: "v0.10.0" })
        )
      ).toThrow("Invalid changelog-receipt");
    }
  });

  test("keeps the tag unchanged from prepare to verify", () => {
    const prior = receiptV4("prepared");
    const verify = requestV3("verify", {
      priorReceiptDigest: changelogReceiptDigest(prior),
    });
    expect(
      inspectChangelogTransaction(verify, receiptV4("verified"), prior).receipt
    ).toMatchObject({ release: { tag: TAG } });
    for (const tag of [
      null,
      { ...TAG, name: "release-0.10.0" },
      { ...TAG, message: "Another message" },
    ]) {
      expect(() =>
        inspectChangelogTransaction(verify, receiptV4("verified", tag), prior)
      ).toThrow("The release tag changed after prepare");
    }
    // A receipt v3 after a tagged v4 prior drops the tag.
    const verifiedV3: ChangelogReceiptV3 = {
      ...receipt("verified"),
      releaseSetTrains: null,
      schemaVersion: 3,
      versionDecision: {
        ...(receipt("verified").versionDecision as VersionDecision),
        versionLine: null,
      },
    };
    expect(() =>
      inspectChangelogTransaction(verify, verifiedV3, prior)
    ).toThrow("The release tag changed after prepare");
    // A tag cannot appear after an untagged prepare either.
    const untagged = receiptV4("prepared", null);
    const afterUntagged = requestV3("verify", {
      priorReceiptDigest: changelogReceiptDigest(untagged),
    });
    expect(() =>
      inspectChangelogTransaction(
        afterUntagged,
        receiptV4("verified"),
        untagged
      )
    ).toThrow("The release tag changed after prepare");
    // A blocked receipt without a release record keeps its routing.
    const blockedReceipt = receiptV4("blocked");
    blockedReceipt.phase = "verify";
    blockedReceipt.sourceRevision = revisionC;
    blockedReceipt.paths = [];
    blockedReceipt.revisionLineage = {
      finalizedTargetRevision: revisionC,
      inputTargetRevision: revisionA,
      reconciliationHeadRevision: revisionB,
    };
    blockedReceipt.reasonCode = "final-verification-failed";
    blockedReceipt.requiredAction = "review-finalization";
    blockedReceipt.reason = "The finalized target lacks the release.";
    blockedReceipt.versionDecision = {
      ...(blockedReceipt.versionDecision as VersionDecisionV3),
      resolution: "blocked",
      selectedVersion: "0.10.0",
    };
    expect(
      inspectChangelogTransaction(verify, blockedReceipt, prior).receipt
    ).toMatchObject({ status: "blocked" });
  });

  test("gates a v4 receipt exactly like v3", () => {
    expect(
      decideReleaseGate({
        alreadyLive: false,
        productionAuthorized: true,
        productionDeploy: "allow",
        receipt: receiptV4(),
        request: requestV3(),
        versionAuthorized: false,
      })
    ).toMatchObject({ action: "merge-reconciliation" });
  });

  test("checks mixed v3 and v4 release sets and refuses one tag for two trains", () => {
    const member = (
      train: string,
      schemaVersion: 3 | 4,
      tag: ReleaseTag | null
    ): ChangelogReceiptV3 | ChangelogReceiptV4 => {
      const base = receiptV4("prepared", tag);
      const decision = base.versionDecision as VersionDecisionV3;
      const shared = {
        ...base,
        releaseSetId: "set-1",
        releaseSetTrains: ["ios", "web"],
        transactionId: `release-${train}`,
        versionDecision: { ...decision, releaseTrain: train },
      };
      if (schemaVersion === 4) {
        return shared;
      }
      const { release, ...rest } = shared;
      return {
        ...rest,
        release: release
          ? {
              date: release.date,
              targetContainedUnreleased: release.targetContainedUnreleased,
              version: release.version,
            }
          : null,
        schemaVersion: 3,
      };
    };
    expect(
      validateChangelogReleaseSet([
        member("web", 4, { message: "Web 0.10.0", name: "web@0.10.0" }),
        member("ios", 3, null),
      ])
    ).toMatchObject({ missingTrains: [], receipts: 2 });
    expect(
      validateChangelogReleaseSet([
        member("web", 4, { message: "Web 0.10.0", name: "web@0.10.0" }),
        member("ios", 4, { message: "iOS 0.10.0", name: "ios@0.10.0" }),
      ])
    ).toMatchObject({ receipts: 2 });
    expect(() =>
      validateChangelogReleaseSet([
        member("web", 4, TAG),
        member("ios", 4, { ...TAG, message: "iOS 0.10.0" }),
      ])
    ).toThrow("Release tag v0.10.0 is named by both web and ios");
    expect(() =>
      validateChangelogReleaseSet([receipt("prepared"), member("ios", 4, null)])
    ).toThrow("needs receipt v3 or v4");
  });

  test("applies the version-line checks and digest binding to v4", () => {
    const lined = (sharedVersion: string): ChangelogReceiptV4 => {
      const base = receiptV4("prepared", TAG, "0.10.0");
      return {
        ...base,
        versionDecision: {
          ...(base.versionDecision as VersionDecisionV3),
          currentVersion: "0.9.0",
          versionLine: {
            members: ["ios", "web"],
            memberVersions: { ios: sharedVersion, web: "0.9.0" },
            mode: "catch-up",
            outcome: "catch-up",
            sharedVersion,
            sharedVersionTrains: ["ios"],
          },
        },
      };
    };
    expect(
      validateChangelogTransaction(requestV3(), lined("0.10.0"))
    ).toMatchObject({ schemaVersion: 4 });
    const mismatched = lined("0.10.0");
    if (mismatched.versionDecision?.versionLine) {
      mismatched.versionDecision.versionLine.sharedVersion = "0.11.0";
    }
    expect(() => validateChangelogTransaction(requestV3(), mismatched)).toThrow(
      "sharedVersion must be the highest"
    );
    const prior = lined("0.10.0");
    prior.status = "decision-required";
    prior.phase = "classify";
    prior.paths = [];
    prior.release = null;
    prior.reasonCode = "version-direction-required";
    prior.requiredAction = "choose-version";
    prior.reason = "Choose.";
    prior.sourceRevision = revisionA;
    prior.revisionLineage = {
      finalizedTargetRevision: null,
      inputTargetRevision: revisionA,
      reconciliationHeadRevision: null,
    };
    if (prior.versionDecision) {
      prior.versionDecision.policyAction = "ask";
      prior.versionDecision.resolution = "approval-required";
      prior.versionDecision.selectedVersion = null;
    }
    const prepare = requestV3("prepare", {
      priorReceiptDigest: changelogReceiptDigest(prior),
    });
    const moved = lined("0.10.0");
    if (moved.versionDecision?.versionLine) {
      moved.versionDecision.versionLine.memberVersions.web = "0.9.1";
    }
    expect(() => inspectChangelogTransaction(prepare, moved, prior)).toThrow(
      "the digest must cover the line state"
    );
  });
});
