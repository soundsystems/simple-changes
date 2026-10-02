import { verifyDeploymentReceipt } from "../adapters/deployment.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { validateChangelogRequest } from "./release-gate.ts";
import { validateSchema } from "./schema.ts";
import type {
  ChangelogReceipt,
  ModernChangelogReceipt,
  ProviderReceipt,
  ReleaseDeliveryReceipt,
} from "./types.ts";

export interface ReleaseDeliveryInput {
  changelogReceipt: unknown;
  providerReceipt: unknown;
  request?: unknown;
}

const invalid = (message: string): never => {
  throw new SimpleChangesError(
    `Cannot build a release delivery receipt: ${message}`,
    EXIT_CODES.validation
  );
};

type VerifiedChangelogReceipt = ModernChangelogReceipt & {
  release: NonNullable<ModernChangelogReceipt["release"]>;
  revisionLineage: {
    finalizedTargetRevision: string;
    inputTargetRevision: string;
    reconciliationHeadRevision: string;
  };
};

const verifiedChangelogReceipt = (input: unknown): VerifiedChangelogReceipt => {
  const receipt = validateSchema<ChangelogReceipt>("changelog-receipt", input);
  if (receipt.schemaVersion === 1) {
    return invalid(
      "the changelog receipt must be schema version 2 or later; legacy receipts carry no revision lineage"
    );
  }
  if (receipt.status !== "verified" || !receipt.release) {
    return invalid(
      `the changelog receipt must be a verified release, not ${receipt.status}`
    );
  }
  if (receipt.release.targetContainedUnreleased !== "integrated") {
    return invalid(
      "the verified receipt must report the reconciliation as integrated"
    );
  }
  const { finalizedTargetRevision, inputTargetRevision } =
    receipt.revisionLineage;
  const { reconciliationHeadRevision } = receipt.revisionLineage;
  if (!(finalizedTargetRevision && reconciliationHeadRevision)) {
    return invalid(
      "the verified receipt must name the reconciliation head and finalized target revisions"
    );
  }
  return {
    ...receipt,
    release: receipt.release,
    revisionLineage: {
      finalizedTargetRevision,
      inputTargetRevision,
      reconciliationHeadRevision,
    },
  };
};

const releaseTrainFor = (
  receipt: VerifiedChangelogReceipt,
  requestInput: unknown
): string => {
  if (requestInput !== undefined) {
    const request = validateChangelogRequest(requestInput);
    if (request.transactionId !== receipt.transactionId) {
      return invalid(
        `the request transaction ${request.transactionId} does not match receipt transaction ${receipt.transactionId}`
      );
    }
    if (
      receipt.versionDecision &&
      receipt.versionDecision.releaseTrain !== request.releaseTrain
    ) {
      return invalid(
        "the request release train does not match the receipt version decision"
      );
    }
    return request.releaseTrain;
  }
  if (receipt.versionDecision) {
    return receipt.versionDecision.releaseTrain;
  }
  return invalid(
    "the release train is unknown; pass the delegated request or a receipt with a version decision"
  );
};

const productionDeploymentReceipt = (input: unknown): ProviderReceipt => {
  const receipt = validateSchema<ProviderReceipt>("provider-receipt", input);
  if (receipt.kind !== "deployment") {
    return invalid("the provider receipt must describe a deployment");
  }
  if (receipt.environment !== "production") {
    return invalid(
      `the deployment must be production, not ${receipt.environment ?? "an unknown environment"}`
    );
  }
  return receipt;
};

/**
 * Compose the release delivery receipt from the verified changelog receipt and
 * the production deployment receipt instead of copying identity fields by
 * hand. Every identity field is derived, so the composite cannot disagree with
 * its sources, and the status is decided only from the observed deployment
 * revision against the verified finalized target.
 */
export const buildReleaseDeliveryReceipt = (
  input: ReleaseDeliveryInput
): ReleaseDeliveryReceipt => {
  const changelog = verifiedChangelogReceipt(input.changelogReceipt);
  const releaseTrain = releaseTrainFor(changelog, input.request);
  const deployment = productionDeploymentReceipt(input.providerReceipt);
  const { finalizedTargetRevision } = changelog.revisionLineage;
  const deploymentVerification = verifyDeploymentReceipt(deployment, {
    receipt: changelog,
    releaseTrain,
    version: changelog.release.version,
  });
  const revisionMatches =
    deployment.observedRevision === finalizedTargetRevision &&
    deployment.intendedRevision === finalizedTargetRevision;
  let outcome: Pick<
    ReleaseDeliveryReceipt,
    "reasonCode" | "requiredAction" | "status"
  > = {
    reasonCode: "provider-observation-incomplete",
    requiredAction: "retry-observation",
    status: "partial",
  };
  if (!revisionMatches && deployment.observedRevision !== null) {
    outcome = {
      reasonCode: "deployment-revision-mismatch",
      requiredAction: "inspect-deployment",
      status: "blocked",
    };
  } else if (deploymentVerification.valid) {
    outcome = { reasonCode: null, requiredAction: null, status: "complete" };
  }
  return validateSchema<ReleaseDeliveryReceipt>("release-delivery-receipt", {
    decisionDigest: changelog.decisionDigest,
    deployedRevision: deployment.observedRevision,
    deploymentReceiptId: deployment.objectId,
    finalizedTargetRevision,
    inputTargetRevision: changelog.revisionLineage.inputTargetRevision,
    reconciliationHeadRevision:
      changelog.revisionLineage.reconciliationHeadRevision,
    releaseSetId: changelog.releaseSetId,
    releaseTrain,
    schemaVersion: 1,
    transactionId: changelog.transactionId,
    version: changelog.release.version,
    ...outcome,
  } satisfies ReleaseDeliveryReceipt);
};
