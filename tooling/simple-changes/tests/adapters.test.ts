import { describe, expect, test } from "bun:test";
import {
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
