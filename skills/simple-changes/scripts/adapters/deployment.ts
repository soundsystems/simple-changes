import { redactSecrets } from "../lib/redact.ts";
import { validateSchema } from "../lib/schema.ts";
import type {
  Authority,
  ChangelogReceipt,
  DeliveryModel,
  ModernChangelogReceipt,
  ProviderReceipt,
  ProviderStatus,
  ReleaseDeliveryReceipt,
} from "../lib/types.ts";

const TRAILING_SLASH_PATTERN = /\/+$/u;

export interface DeploymentReceiptInput {
  action: string;
  canonicalTargets: Array<{
    url: string;
    resolvedResultId: string;
  }>;
  deliveryModel: DeliveryModel;
  deploymentId: string;
  environment: "preview" | "staging" | "production";
  evidence: string[];
  expectedCanonicalTargets?: string[];
  observedRevision: string | null;
  project: string;
  provider: string;
  providerReady?: boolean;
  smoke: { journey: string; passed: boolean } | null;
  status: ProviderStatus;
  targetRevision: string;
  url: string | null;
}

export interface DeploymentVerification {
  issues: string[];
  valid: boolean;
}

export interface ReleaseDeploymentBinding {
  receipt: ModernChangelogReceipt;
  releaseTrain: string;
  version: string;
}

export type DeploymentReconciliationAction =
  | "complete"
  | "promote-existing"
  | "reconcile-managed-targets"
  | "blocked";

export interface DeploymentReconciliationContext {
  managedTargetReconciliationAttempts: number;
  managedTargetReconciliationSupported: boolean;
  productionDeployAuthorized: boolean;
  promotionAttempts: number;
  promotionSupported: boolean;
  providerReportsCurrent: boolean | null;
  targetOwnershipProven: boolean;
}

export interface DeploymentReconciliationDecision {
  action: DeploymentReconciliationAction;
  reason: string;
  requiredAuthority: Authority[];
}

const canonicalTargetUrl = (value: string): string => {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  const path =
    parsed.pathname === "/"
      ? ""
      : parsed.pathname.replace(TRAILING_SLASH_PATTERN, "");
  return `${parsed.origin}${path}`;
};

const canonicalTargetIssues = (receipt: ProviderReceipt): string[] => {
  if (receipt.environment !== "production") {
    return [];
  }
  const issues: string[] = [];
  const expected = (receipt.expectedCanonicalTargets ?? []).map(
    canonicalTargetUrl
  );
  const observed = receipt.canonicalTargets.map((target) =>
    canonicalTargetUrl(target.url)
  );
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);

  if (expected.length === 0) {
    issues.push("Canonical production target inventory is missing.");
  }
  if (expectedSet.size !== expected.length) {
    issues.push("Canonical production target inventory contains duplicates.");
  }
  if (observedSet.size !== observed.length) {
    issues.push("Observed canonical production targets contain duplicates.");
  }

  const missing = [...expectedSet].filter((url) => !observedSet.has(url));
  const unexpected = [...observedSet].filter((url) => !expectedSet.has(url));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      unexpected.length > 0 ? `unexpected ${unexpected.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    issues.push(`Canonical production target coverage differs: ${details}.`);
  }

  const stale = receipt.canonicalTargets
    .filter((target) => expectedSet.has(canonicalTargetUrl(target.url)))
    .filter((target) => !target.matches)
    .map((target) => canonicalTargetUrl(target.url));
  if (stale.length > 0) {
    issues.push(`Canonical production targets are stale: ${stale.join(", ")}.`);
  }
  return issues;
};

// A deployment bound to a release must deploy that release's exact verified
// finalized target under its train and version. A legacy receipt carries no
// lineage or decision to bind, so it only earns the refusal.
const releaseBindingIssues = (
  receipt: ProviderReceipt,
  releaseBinding: ReleaseDeploymentBinding
): string[] => {
  const releaseReceipt = validateSchema<ChangelogReceipt>(
    "changelog-receipt",
    releaseBinding.receipt
  );
  if (releaseReceipt.schemaVersion === 1) {
    return ["Web production requires a verified changelog receipt."];
  }
  const issues: string[] = [];
  if (
    releaseReceipt.status !== "verified" ||
    releaseReceipt.phase !== "verify"
  ) {
    issues.push("Web production requires a verified changelog receipt.");
  }
  if (
    releaseReceipt.revisionLineage.finalizedTargetRevision !==
      receipt.intendedRevision ||
    releaseReceipt.revisionLineage.finalizedTargetRevision !==
      receipt.observedRevision
  ) {
    issues.push(
      "Deployment revision does not match the verified finalized release target."
    );
  }
  if (
    releaseReceipt.versionDecision?.releaseTrain !==
      releaseBinding.releaseTrain ||
    releaseReceipt.release?.version !== releaseBinding.version ||
    releaseReceipt.versionDecision?.selectedVersion !== releaseBinding.version
  ) {
    issues.push(
      "Deployment release train or version does not match the verified changelog receipt."
    );
  }
  return issues;
};

export const verifyDeploymentReceipt = (
  receipt: ProviderReceipt,
  releaseBinding?: ReleaseDeploymentBinding
): DeploymentVerification => {
  const issues: string[] = [];
  if (receipt.kind !== "deployment") {
    issues.push("Receipt is not a deployment receipt.");
  }
  if (!receipt.immutableResultId) {
    issues.push("Immutable deployment identity is missing.");
  }
  if (receipt.providerReady !== true) {
    issues.push("Provider did not prove the deployment reached Ready state.");
  }
  if (
    !receipt.intendedRevision ||
    receipt.intendedRevision !== receipt.observedRevision
  ) {
    issues.push(
      "Observed deployment revision does not match the intended revision."
    );
  }
  issues.push(...canonicalTargetIssues(receipt));
  if (!receipt.smoke?.passed) {
    issues.push("The focused smoke journey did not pass.");
  }
  if (receipt.status !== "succeeded") {
    issues.push(`Provider status is ${receipt.status}.`);
  }
  if (releaseBinding) {
    issues.push(...releaseBindingIssues(receipt, releaseBinding));
  }
  return {
    issues,
    valid: issues.length === 0,
  };
};

export const createReleaseDeliveryReceipt = (
  releaseBinding: ReleaseDeploymentBinding,
  deployment: ProviderReceipt
): ReleaseDeliveryReceipt => {
  const checked = validateSchema<ChangelogReceipt>(
    "changelog-receipt",
    releaseBinding.receipt
  );
  if (checked.schemaVersion === 1) {
    throw new Error(
      "A composite delivery receipt requires a changelog receipt v2 or later; a legacy receipt carries no revision lineage."
    );
  }
  const releaseReceipt: ModernChangelogReceipt = checked;
  const deploymentVerification = verifyDeploymentReceipt(
    deployment,
    releaseBinding
  );
  const lineage = releaseReceipt.revisionLineage;
  if (
    !(lineage.reconciliationHeadRevision && lineage.finalizedTargetRevision)
  ) {
    throw new Error(
      "A composite delivery receipt requires complete verified revision lineage."
    );
  }
  const revisionMismatch =
    deployment.observedRevision !== lineage.finalizedTargetRevision;
  let reasonCode: ReleaseDeliveryReceipt["reasonCode"] = null;
  let requiredAction: ReleaseDeliveryReceipt["requiredAction"] = null;
  if (!deploymentVerification.valid) {
    reasonCode = revisionMismatch
      ? "deployment-revision-mismatch"
      : "provider-observation-incomplete";
    requiredAction = revisionMismatch
      ? "inspect-deployment"
      : "retry-observation";
  }
  const receipt: ReleaseDeliveryReceipt = {
    decisionDigest: releaseReceipt.decisionDigest,
    deployedRevision: deployment.observedRevision,
    deploymentReceiptId: deployment.objectId || null,
    finalizedTargetRevision: lineage.finalizedTargetRevision,
    inputTargetRevision: lineage.inputTargetRevision,
    reasonCode,
    reconciliationHeadRevision: lineage.reconciliationHeadRevision,
    releaseSetId: releaseReceipt.releaseSetId,
    releaseTrain: releaseBinding.releaseTrain,
    requiredAction,
    schemaVersion: 1,
    status: deploymentVerification.valid ? "complete" : "partial",
    transactionId: releaseReceipt.transactionId,
    version: releaseBinding.version,
  };
  return validateSchema<ReleaseDeliveryReceipt>(
    "release-delivery-receipt",
    receipt
  );
};

export const nextDeploymentReconciliation = (
  receipt: ProviderReceipt,
  context: DeploymentReconciliationContext
): DeploymentReconciliationDecision => {
  const verification = verifyDeploymentReceipt(receipt);
  if (verification.valid) {
    return {
      action: "complete",
      reason:
        "Deployment identity, targets, readiness, and smoke are verified.",
      requiredAuthority: [],
    };
  }

  if (
    receipt.kind !== "deployment" ||
    receipt.environment !== "production" ||
    !receipt.immutableResultId ||
    receipt.providerReady !== true ||
    !receipt.intendedRevision ||
    receipt.intendedRevision !== receipt.observedRevision
  ) {
    return {
      action: "blocked",
      reason:
        "Only a Ready production deployment of the intended immutable revision can be reconciled.",
      requiredAuthority: [],
    };
  }

  const targetIssues = canonicalTargetIssues(receipt);
  if (targetIssues.length === 0) {
    return {
      action: "blocked",
      reason:
        "The remaining deployment failure is not a canonical-target mapping issue.",
      requiredAuthority: [],
    };
  }
  const expectedTargets = receipt.expectedCanonicalTargets ?? [];
  if (
    expectedTargets.length === 0 ||
    new Set(expectedTargets.map(canonicalTargetUrl)).size !==
      expectedTargets.length
  ) {
    return {
      action: "blocked",
      reason:
        "A complete unique expected canonical-target inventory is required before routing reconciliation.",
      requiredAuthority: [],
    };
  }
  if (!context.productionDeployAuthorized) {
    return {
      action: "blocked",
      reason:
        "Production deployment authority is required before promotion or managed-target reconciliation.",
      requiredAuthority: ["production-deploy"],
    };
  }
  if (
    context.promotionSupported &&
    context.promotionAttempts === 0 &&
    context.providerReportsCurrent !== true
  ) {
    return {
      action: "promote-existing",
      reason:
        "Promote the already-built verified artifact, then refresh every canonical target without creating another deployment.",
      requiredAuthority: ["production-deploy"],
    };
  }
  if (
    context.managedTargetReconciliationSupported &&
    context.managedTargetReconciliationAttempts === 0 &&
    context.targetOwnershipProven
  ) {
    return {
      action: "reconcile-managed-targets",
      reason:
        "Reconcile only configured provider-managed targets owned by the same project, then refresh the complete target inventory.",
      requiredAuthority: ["production-deploy"],
    };
  }
  return {
    action: "blocked",
    reason:
      "Bounded promotion and same-project managed-target reconciliation are exhausted, unsupported, or lack ownership proof.",
    requiredAuthority: [],
  };
};

export const normalizeDeploymentReceipt = (
  input: DeploymentReceiptInput
): ProviderReceipt => {
  const expectedCanonicalTargets = (input.expectedCanonicalTargets ?? []).map(
    canonicalTargetUrl
  );
  const canonicalTargets = input.canonicalTargets.map((target) => ({
    ...target,
    matches: target.resolvedResultId === input.deploymentId,
    url: canonicalTargetUrl(target.url),
  }));
  const receipt: ProviderReceipt = {
    action: input.action,
    approvalRevision: null,
    baseRevision: null,
    canonicalTargets,
    deliveryModel: input.deliveryModel,
    environment: input.environment,
    evidence: input.evidence.map(redactSecrets),
    expectedCanonicalTargets,
    headRevision: null,
    immutableResultId: input.deploymentId,
    intendedRevision: input.targetRevision,
    kind: "deployment",
    objectId: input.deploymentId,
    observedAt: new Date().toISOString(),
    observedRevision: input.observedRevision,
    project: input.project,
    provider: input.provider,
    providerReady: input.providerReady ?? input.status === "succeeded",
    schemaVersion: 1,
    smoke: input.smoke,
    status: input.status,
    url: input.url,
  };
  const validated = validateSchema<ProviderReceipt>(
    "provider-receipt",
    receipt
  );
  const verification = verifyDeploymentReceipt(validated);
  if (validated.status === "succeeded" && !verification.valid) {
    return {
      ...validated,
      evidence: [...validated.evidence, ...verification.issues],
      status: "partial",
    };
  }
  return validated;
};
