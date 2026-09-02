import { describe, expect, test } from "bun:test";
import { buildReleaseDeliveryReceipt } from "../../../skills/simple-changes/scripts/lib/release-delivery.ts";
import type {
  ChangelogReceiptV2,
  ChangelogRequest,
  ProviderReceipt,
} from "../../../skills/simple-changes/scripts/lib/types.ts";

const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const revisionC = "c".repeat(40);
const digest = "d".repeat(64);

const verifiedReceipt = (
  overrides: Partial<ChangelogReceiptV2> = {}
): ChangelogReceiptV2 => ({
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
    inputTargetRevision: revisionA,
    reconciliationHeadRevision: revisionB,
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
  ...overrides,
});

const deployment = (
  overrides: Partial<ProviderReceipt> = {}
): ProviderReceipt => ({
  action: "deploy-production",
  approvalRevision: null,
  baseRevision: null,
  canonicalTargets: [
    { matches: true, resolvedResultId: "dpl_1", url: "https://example.test" },
  ],
  deliveryModel: "git-connected",
  environment: "production",
  evidence: ["vercel inspect dpl_1"],
  expectedCanonicalTargets: ["https://example.test"],
  headRevision: revisionC,
  immutableResultId: "dpl_1",
  intendedRevision: revisionC,
  kind: "deployment",
  objectId: "dpl_1",
  observedAt: "2026-09-02T12:05:00-05:00",
  observedRevision: revisionC,
  project: "web",
  provider: "vercel",
  providerReady: true,
  schemaVersion: 1,
  smoke: { journey: "checkout", passed: true },
  status: "succeeded",
  url: "https://example.test",
  ...overrides,
});

const request = (): ChangelogRequest => ({
  approvedDecisionDigest: digest,
  approvedVersion: "0.10.0",
  attempt: 1,
  boundary: "web-production",
  environment: "production",
  finalizedTargetRevision: revisionC,
  inputTargetRevision: revisionA,
  mutationScope: "read-only",
  phase: "verify",
  priorReceiptDigest: null,
  releaseSetId: null,
  releaseTrain: "web",
  schemaVersion: 1,
  supportedReceiptVersions: [1, 2],
  transactionId: "release-01",
});

describe("release delivery receipt", () => {
  test("derives every identity field from the verified receipt and deployment", () => {
    const receipt = buildReleaseDeliveryReceipt({
      changelogReceipt: verifiedReceipt(),
      providerReceipt: deployment(),
      request: request(),
    });

    expect(receipt).toEqual({
      decisionDigest: digest,
      deployedRevision: revisionC,
      deploymentReceiptId: "dpl_1",
      finalizedTargetRevision: revisionC,
      inputTargetRevision: revisionA,
      reasonCode: null,
      reconciliationHeadRevision: revisionB,
      releaseSetId: null,
      releaseTrain: "web",
      requiredAction: null,
      schemaVersion: 1,
      status: "complete",
      transactionId: "release-01",
      version: "0.10.0",
    });
  });

  test("blocks when the deployed revision is not the finalized target", () => {
    const receipt = buildReleaseDeliveryReceipt({
      changelogReceipt: verifiedReceipt(),
      providerReceipt: deployment({ observedRevision: revisionB }),
    });

    expect(receipt).toMatchObject({
      deployedRevision: revisionB,
      reasonCode: "deployment-revision-mismatch",
      requiredAction: "inspect-deployment",
      status: "blocked",
    });
  });

  test("reports partial delivery when the provider observation is incomplete", () => {
    const receipt = buildReleaseDeliveryReceipt({
      changelogReceipt: verifiedReceipt(),
      providerReceipt: deployment({
        observedRevision: null,
        status: "partial",
      }),
    });

    expect(receipt).toMatchObject({
      deployedRevision: null,
      reasonCode: "provider-observation-incomplete",
      requiredAction: "retry-observation",
      status: "partial",
    });
  });

  test("does not complete without immutable, ready, target, and smoke proof", () => {
    const receipt = buildReleaseDeliveryReceipt({
      changelogReceipt: verifiedReceipt(),
      providerReceipt: deployment({
        canonicalTargets: [],
        expectedCanonicalTargets: [],
        immutableResultId: null,
        providerReady: null,
        smoke: null,
      }),
    });

    expect(receipt).toMatchObject({
      reasonCode: "provider-observation-incomplete",
      requiredAction: "retry-observation",
      status: "partial",
    });
  });

  test("refuses unverified, legacy, preview, or mismatched inputs", () => {
    expect(() =>
      buildReleaseDeliveryReceipt({
        changelogReceipt: {
          checks: [],
          evidence: [],
          observedAt: "2026-09-02T12:00:00-05:00",
          paths: [],
          provider: "simple-changelogs",
          reason: null,
          release: null,
          releaseImpact: "none",
          schemaVersion: 1,
          sourceRevision: revisionA,
          status: "not-applicable",
        },
        providerReceipt: deployment(),
      })
    ).toThrow("must be schema version 2");
    expect(() =>
      buildReleaseDeliveryReceipt({
        changelogReceipt: verifiedReceipt(),
        providerReceipt: deployment({ environment: "preview" }),
      })
    ).toThrow("must be production");
    expect(() =>
      buildReleaseDeliveryReceipt({
        changelogReceipt: verifiedReceipt(),
        providerReceipt: deployment({ kind: "forge" }),
      })
    ).toThrow("must describe a deployment");
    expect(() =>
      buildReleaseDeliveryReceipt({
        changelogReceipt: verifiedReceipt(),
        providerReceipt: deployment(),
        request: { ...request(), transactionId: "release-02" },
      })
    ).toThrow("does not match receipt transaction");
    expect(() =>
      buildReleaseDeliveryReceipt({
        changelogReceipt: verifiedReceipt({ versionDecision: null }),
        providerReceipt: deployment(),
      })
    ).toThrow("release train is unknown");
  });
});
