import { describe, expect, test } from "bun:test";
import {
  createReleaseDeliveryReceipt,
  nextDeploymentReconciliation,
  normalizeDeploymentReceipt,
  verifyDeploymentReceipt,
} from "../../../skills/simple-changes/scripts/adapters/deployment.ts";
import {
  assertApprovalFresh,
  createFakeForgeAdapter,
  normalizeForgeReceipt,
  unsupportedForgeReceipt,
} from "../../../skills/simple-changes/scripts/adapters/forge.ts";
import type { ChangelogReceiptV2 } from "../../../skills/simple-changes/scripts/lib/types.ts";

const proposalInput = {
  action: "create",
  approvalRevision: "2".repeat(40),
  baseRevision: "1".repeat(40),
  body: "## Summary\n\n- Focused outcome\n",
  evidence: ["Created from a structured Markdown payload."],
  headRevision: "2".repeat(40),
  objectId: "proposal:17",
  renderedBody: "## Summary\n\n- Focused outcome\n",
  status: "succeeded" as const,
  url: "https://forge.invalid/proposals/17",
};

describe("normalized forge contract", () => {
  test("fake GitHub and GitLab adapters produce the same core shape", () => {
    const github =
      createFakeForgeAdapter("github").createProposal(proposalInput);
    const gitlab =
      createFakeForgeAdapter("gitlab").createProposal(proposalInput);
    expect(github.status).toBe("succeeded");
    expect(gitlab.status).toBe("succeeded");
    expect({ ...github, observedAt: "time", provider: "provider" }).toEqual({
      ...gitlab,
      observedAt: "time",
      provider: "provider",
    });
    expect(() => assertApprovalFresh(github)).not.toThrow();
  });

  test("invalidates approval after the head changes", () => {
    const receipt = normalizeForgeReceipt({
      ...proposalInput,
      headRevision: "3".repeat(40),
      provider: "fake",
    });
    expect(receipt.status).toBe("failed");
    expect(() => assertApprovalFresh(receipt)).toThrow("stale");
  });

  test("represents an unsupported future forge honestly", () => {
    const receipt = unsupportedForgeReceipt(
      "origin",
      "No public capability contract exists."
    );
    expect(receipt.status).toBe("unsupported");
    expect(receipt.objectId).toBe("origin:unsupported");
  });
});

describe("normalized deployment contract", () => {
  test("requires immutable revision, live target, and smoke evidence", () => {
    const receipt = normalizeDeploymentReceipt({
      action: "deploy",
      canonicalTargets: [
        {
          resolvedResultId: "deployment-42",
          url: "https://app.invalid",
        },
      ],
      deliveryModel: "atomic-artifact",
      deploymentId: "deployment-42",
      environment: "production",
      evidence: ["Ready"],
      expectedCanonicalTargets: ["https://app.invalid"],
      observedRevision: "4".repeat(40),
      project: "simple-changes",
      provider: "fixture",
      providerReady: true,
      smoke: { journey: "preview", passed: true },
      status: "succeeded",
      targetRevision: "4".repeat(40),
      url: "https://deployment.invalid",
    });
    expect(receipt.status).toBe("succeeded");
    expect(verifyDeploymentReceipt(receipt)).toEqual({
      issues: [],
      valid: true,
    });
  });

  test("binds a verified Web release to the observed deployment revision", () => {
    const targetRevision = "4".repeat(40);
    const deployment = normalizeDeploymentReceipt({
      action: "deploy",
      canonicalTargets: [
        {
          resolvedResultId: "deployment-42",
          url: "https://app.invalid",
        },
      ],
      deliveryModel: "atomic-artifact",
      deploymentId: "deployment-42",
      environment: "production",
      evidence: ["Ready"],
      expectedCanonicalTargets: ["https://app.invalid"],
      observedRevision: targetRevision,
      project: "simple-changes",
      provider: "fixture",
      providerReady: true,
      smoke: { journey: "release", passed: true },
      status: "succeeded",
      targetRevision,
      url: "https://deployment.invalid",
    });
    const releaseReceipt: ChangelogReceiptV2 = {
      checks: ["Final release verified."],
      decisionDigest: "d".repeat(64),
      effectivePolicyDigest: "e".repeat(64),
      evidence: ["Reconciliation is contained in the target."],
      observedAt: new Date().toISOString(),
      paths: [],
      phase: "verify",
      provider: "simple-changelogs",
      reason: null,
      reasonCode: null,
      release: {
        date: "2026-08-10",
        targetContainedUnreleased: "integrated",
        version: "0.10.0",
      },
      releaseImpact: "minor",
      releaseSetId: null,
      requiredAction: null,
      revisionLineage: {
        finalizedTargetRevision: targetRevision,
        inputTargetRevision: "1".repeat(40),
        reconciliationHeadRevision: "2".repeat(40),
      },
      schemaVersion: 2,
      sourceRevision: targetRevision,
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
    };
    const receipt = createReleaseDeliveryReceipt(
      { receipt: releaseReceipt, releaseTrain: "web", version: "0.10.0" },
      deployment
    );
    expect(receipt).toMatchObject({
      deployedRevision: targetRevision,
      finalizedTargetRevision: targetRevision,
      status: "complete",
      transactionId: "release-01",
      version: "0.10.0",
    });

    // A legacy receipt carries no lineage: refused cleanly, never a crash.
    const legacy = {
      checks: [],
      evidence: [],
      observedAt: new Date().toISOString(),
      paths: [],
      provider: "simple-changelogs",
      reason: null,
      release: null,
      releaseImpact: "none",
      schemaVersion: 1,
      sourceRevision: targetRevision,
      status: "not-applicable",
    } as unknown as ChangelogReceiptV2;
    const legacyBinding = {
      receipt: legacy,
      releaseTrain: "web",
      version: "0.10.0",
    };
    expect(verifyDeploymentReceipt(deployment, legacyBinding).issues).toEqual([
      "Web production requires a verified changelog receipt.",
    ]);
    expect(() =>
      createReleaseDeliveryReceipt(legacyBinding, deployment)
    ).toThrow("requires a changelog receipt v2 or later");
  });

  test("rejects a live deployment behind the latest target revision", () => {
    const receipt = normalizeDeploymentReceipt({
      action: "inspect",
      canonicalTargets: [
        {
          resolvedResultId: "deployment-42",
          url: "https://app.invalid",
        },
      ],
      deliveryModel: "git-connected",
      deploymentId: "deployment-42",
      environment: "production",
      evidence: ["Ready production deployment inspected after merge."],
      expectedCanonicalTargets: ["https://app.invalid"],
      observedRevision: "4".repeat(40),
      project: "simple-changes",
      provider: "fixture",
      providerReady: true,
      smoke: { journey: "production", passed: true },
      status: "succeeded",
      targetRevision: "5".repeat(40),
      url: "https://deployment.invalid",
    });

    expect(receipt.intendedRevision).toBe("5".repeat(40));
    expect(receipt.status).toBe("partial");
    expect(receipt.evidence.join(" ")).toContain(
      "Observed deployment revision does not match the intended revision"
    );
    expect(
      nextDeploymentReconciliation(receipt, {
        managedTargetReconciliationAttempts: 0,
        managedTargetReconciliationSupported: true,
        productionDeployAuthorized: true,
        promotionAttempts: 0,
        promotionSupported: true,
        providerReportsCurrent: false,
        targetOwnershipProven: true,
      }).action
    ).toBe("blocked");
  });

  test("does not accept ready status behind a stale canonical target", () => {
    const receipt = normalizeDeploymentReceipt({
      action: "deploy",
      canonicalTargets: [
        {
          resolvedResultId: "deployment-old",
          url: "https://app.invalid",
        },
      ],
      deliveryModel: "git-connected",
      deploymentId: "deployment-42",
      environment: "production",
      evidence: ["Ready"],
      expectedCanonicalTargets: ["https://app.invalid"],
      observedRevision: "4".repeat(40),
      project: "simple-changes",
      provider: "fixture",
      providerReady: true,
      smoke: { journey: "preview", passed: true },
      status: "succeeded",
      targetRevision: "4".repeat(40),
      url: "https://deployment.invalid",
    });
    expect(receipt.status).toBe("partial");
    expect(receipt.evidence.join(" ")).toContain(
      "Canonical production targets are stale"
    );
  });

  test("rejects incomplete canonical target coverage", () => {
    const receipt = normalizeDeploymentReceipt({
      action: "deploy",
      canonicalTargets: [
        {
          resolvedResultId: "deployment-42",
          url: "https://app.invalid",
        },
      ],
      deliveryModel: "atomic-artifact",
      deploymentId: "deployment-42",
      environment: "production",
      evidence: ["Ready"],
      expectedCanonicalTargets: ["https://app.invalid", "https://www.invalid"],
      observedRevision: "4".repeat(40),
      project: "simple-changes",
      provider: "fixture",
      providerReady: true,
      smoke: { journey: "production", passed: true },
      status: "succeeded",
      targetRevision: "4".repeat(40),
      url: "https://deployment.invalid",
    });

    expect(receipt.status).toBe("partial");
    expect(receipt.evidence.join(" ")).toContain(
      "Canonical production target coverage differs"
    );
  });

  test("uses bounded promotion before same-project target reconciliation", () => {
    const receipt = normalizeDeploymentReceipt({
      action: "deploy",
      canonicalTargets: [
        {
          resolvedResultId: "deployment-old",
          url: "https://app.invalid",
        },
      ],
      deliveryModel: "git-connected",
      deploymentId: "deployment-42",
      environment: "production",
      evidence: ["Ready"],
      expectedCanonicalTargets: ["https://app.invalid"],
      observedRevision: "4".repeat(40),
      project: "simple-changes",
      provider: "fixture",
      providerReady: true,
      smoke: { journey: "production", passed: false },
      status: "succeeded",
      targetRevision: "4".repeat(40),
      url: "https://deployment.invalid",
    });

    expect(
      nextDeploymentReconciliation(receipt, {
        managedTargetReconciliationAttempts: 0,
        managedTargetReconciliationSupported: true,
        productionDeployAuthorized: true,
        promotionAttempts: 0,
        promotionSupported: true,
        providerReportsCurrent: false,
        targetOwnershipProven: true,
      }).action
    ).toBe("promote-existing");
    expect(
      nextDeploymentReconciliation(receipt, {
        managedTargetReconciliationAttempts: 0,
        managedTargetReconciliationSupported: true,
        productionDeployAuthorized: true,
        promotionAttempts: 1,
        promotionSupported: true,
        providerReportsCurrent: true,
        targetOwnershipProven: true,
      }).action
    ).toBe("reconcile-managed-targets");
    expect(
      nextDeploymentReconciliation(receipt, {
        managedTargetReconciliationAttempts: 1,
        managedTargetReconciliationSupported: true,
        productionDeployAuthorized: true,
        promotionAttempts: 1,
        promotionSupported: true,
        providerReportsCurrent: true,
        targetOwnershipProven: true,
      }).action
    ).toBe("blocked");
  });

  test("does not reconcile targets without authority and ownership proof", () => {
    const receipt = normalizeDeploymentReceipt({
      action: "deploy",
      canonicalTargets: [
        {
          resolvedResultId: "deployment-old",
          url: "https://app.invalid",
        },
      ],
      deliveryModel: "git-connected",
      deploymentId: "deployment-42",
      environment: "production",
      evidence: ["Ready"],
      expectedCanonicalTargets: ["https://app.invalid"],
      observedRevision: "4".repeat(40),
      project: "simple-changes",
      provider: "fixture",
      providerReady: true,
      smoke: { journey: "production", passed: false },
      status: "succeeded",
      targetRevision: "4".repeat(40),
      url: "https://deployment.invalid",
    });

    const unauthorized = nextDeploymentReconciliation(receipt, {
      managedTargetReconciliationAttempts: 0,
      managedTargetReconciliationSupported: true,
      productionDeployAuthorized: false,
      promotionAttempts: 0,
      promotionSupported: true,
      providerReportsCurrent: false,
      targetOwnershipProven: true,
    });
    expect(unauthorized.action).toBe("blocked");
    expect(unauthorized.requiredAuthority).toEqual(["production-deploy"]);

    const unowned = nextDeploymentReconciliation(receipt, {
      managedTargetReconciliationAttempts: 0,
      managedTargetReconciliationSupported: true,
      productionDeployAuthorized: true,
      promotionAttempts: 1,
      promotionSupported: true,
      providerReportsCurrent: true,
      targetOwnershipProven: false,
    });
    expect(unowned.action).toBe("blocked");
  });

  test("does not reconcile before expected target discovery is complete", () => {
    const receipt = normalizeDeploymentReceipt({
      action: "deploy",
      canonicalTargets: [
        {
          resolvedResultId: "deployment-old",
          url: "https://app.invalid",
        },
      ],
      deliveryModel: "git-connected",
      deploymentId: "deployment-42",
      environment: "production",
      evidence: ["Ready"],
      observedRevision: "4".repeat(40),
      project: "simple-changes",
      provider: "fixture",
      providerReady: true,
      smoke: { journey: "production", passed: false },
      status: "succeeded",
      targetRevision: "4".repeat(40),
      url: "https://deployment.invalid",
    });

    const decision = nextDeploymentReconciliation(receipt, {
      managedTargetReconciliationAttempts: 0,
      managedTargetReconciliationSupported: true,
      productionDeployAuthorized: true,
      promotionAttempts: 0,
      promotionSupported: true,
      providerReportsCurrent: false,
      targetOwnershipProven: true,
    });
    expect(decision.action).toBe("blocked");
    expect(decision.reason).toContain("expected canonical-target inventory");
  });
});
