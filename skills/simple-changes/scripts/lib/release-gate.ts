import { readFileSync } from "node:fs";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256Json } from "./hash.ts";
import { schemaPath, validateSchema } from "./schema.ts";
import type {
  ChangelogCapabilities,
  ChangelogReceipt,
  ChangelogReceiptV2,
  ChangelogRequest,
  ReleaseReasonCode,
  ReleaseRequiredAction,
} from "./types.ts";

export interface ChangelogConsumerCapabilities {
  features: ChangelogCapabilities["features"];
  receiptVersions: Array<1 | 2>;
  requestVersions: 1[];
  schemaDigests: NonNullable<ChangelogCapabilities["schemaDigests"]>;
}

export interface NegotiatedChangelogProtocol {
  compatible: boolean;
  features: ChangelogCapabilities["features"];
  reasonCode: "unsupported-protocol" | null;
  receiptVersion: 1 | 2 | null;
  requestVersion: 1 | null;
  requiredAction: "upgrade-producer" | null;
  schemaDigestStatus: "match" | "differs" | "unadvertised";
}

export const packagedChangelogProtocol = (): ChangelogConsumerCapabilities => ({
  features: [
    "public-version-policy",
    "classify-prepare-verify",
    "multi-train-receipts",
    "guidance-update-notices",
  ],
  receiptVersions: [1, 2],
  requestVersions: [1],
  schemaDigests: {
    changelogReceipt: sha256Json(
      JSON.parse(readFileSync(schemaPath("changelog-receipt"), "utf8"))
    ),
    changelogRequest: sha256Json(
      JSON.parse(readFileSync(schemaPath("changelog-request"), "utf8"))
    ),
  },
});

const highestOverlap = <Version extends number>(
  left: Version[],
  right: Version[]
): Version | null =>
  left.filter((version) => right.includes(version)).sort((a, b) => b - a)[0] ??
  null;

// Advisory only: wire compatibility is decided by version overlap, and every
// inbound request/receipt is validated against the packaged schema at use time.
// Digest equality would additionally reject peers over cosmetic schema edits.
const compareSchemaDigests = (
  producer: ChangelogCapabilities,
  consumer: ChangelogConsumerCapabilities
): NegotiatedChangelogProtocol["schemaDigestStatus"] => {
  if (!producer.schemaDigests) {
    return "unadvertised";
  }
  return producer.schemaDigests.changelogRequest ===
    consumer.schemaDigests.changelogRequest &&
    producer.schemaDigests.changelogReceipt ===
      consumer.schemaDigests.changelogReceipt
    ? "match"
    : "differs";
};

export const negotiateChangelogProtocol = (
  input: unknown,
  consumer: ChangelogConsumerCapabilities = packagedChangelogProtocol()
): NegotiatedChangelogProtocol => {
  const producer = validateSchema<ChangelogCapabilities>(
    "changelog-capabilities",
    input
  );
  const requestVersion = highestOverlap(
    producer.requestVersions,
    consumer.requestVersions
  );
  const receiptVersion = highestOverlap(
    producer.receiptVersions,
    consumer.receiptVersions
  );
  const schemaDigestStatus = compareSchemaDigests(producer, consumer);
  if (!(requestVersion && receiptVersion)) {
    return {
      compatible: false,
      features: [],
      reasonCode: "unsupported-protocol",
      receiptVersion,
      requestVersion,
      requiredAction: "upgrade-producer",
      schemaDigestStatus,
    };
  }
  return {
    compatible: true,
    features: producer.features.filter((feature) =>
      consumer.features.includes(feature)
    ),
    reasonCode: null,
    receiptVersion,
    requestVersion,
    requiredAction: null,
    schemaDigestStatus,
  };
};

export const createChangelogRequest = (
  input: ChangelogRequest
): ChangelogRequest => validateSchema("changelog-request", input);

export const changelogReceiptDigest = (receipt: unknown): string =>
  sha256Json(validateSchema<ChangelogReceipt>("changelog-receipt", receipt));

const protocolMismatch = (message: string): never => {
  throw new SimpleChangesError(message, EXIT_CODES.validation);
};

export type PriorReceiptDigestStatus =
  | "not-applicable"
  | "unverified"
  | "verified";

export interface ChangelogTransactionValidation {
  priorReceiptDigestStatus: PriorReceiptDigestStatus;
  receipt: ChangelogReceipt;
}

// A phase after the first names the receipt it builds on. When that receipt
// is available, its digest must bind exactly; when it is not, the transaction
// still validates but reports the digest as unverified rather than proven.
const verifyPriorReceiptDigest = (
  request: ChangelogRequest,
  priorReceiptInput: unknown
): PriorReceiptDigestStatus => {
  if (request.priorReceiptDigest === null) {
    if (priorReceiptInput !== undefined) {
      protocolMismatch(
        "A prior receipt was supplied, but the delegated request names no prior receipt digest."
      );
    }
    return "not-applicable";
  }
  if (priorReceiptInput === undefined) {
    return "unverified";
  }
  if (
    changelogReceiptDigest(priorReceiptInput) !== request.priorReceiptDigest
  ) {
    protocolMismatch(
      "Prior receipt digest does not match the delegated request."
    );
  }
  return "verified";
};

const validateLegacyTransaction = (
  request: ChangelogRequest,
  receipt: Extract<ChangelogReceipt, { schemaVersion: 1 }>
): ChangelogReceipt => {
  if (!request.supportedReceiptVersions.includes(1)) {
    protocolMismatch("The delegated request did not advertise receipt v1.");
  }
  if (
    request.phase !== "classify" ||
    (receipt.sourceRevision &&
      receipt.sourceRevision !== request.inputTargetRevision)
  ) {
    protocolMismatch(
      "Legacy receipt is not bound to the delegated classification target."
    );
  }
  return receipt;
};

const assertPublicReleaseDecision = (receipt: ChangelogReceiptV2): void => {
  const { versionDecision } = receipt;
  if (receipt.releaseImpact === "none" && receipt.status !== "not-applicable") {
    protocolMismatch(
      "Internal-only or non-public work must not request a public version."
    );
  }
  if (
    receipt.status === "decision-required" &&
    (receipt.releaseImpact === "none" ||
      versionDecision?.boundary === "none" ||
      versionDecision?.bumpLevel === "none")
  ) {
    protocolMismatch(
      "Version approval is valid only for a proven public release boundary."
    );
  }
};

// An operator-history handoff (`boundary: "none"`) prepares and verifies an
// entry, never a version, so its receipts carry no release record. The receipt
// does not name the boundary itself, so the schema only permits the null
// record; this binding is what ties it to the delegated boundary.
const assertEntryOnlyBinding = (
  request: ChangelogRequest,
  receipt: ChangelogReceiptV2
): void => {
  if (receipt.status !== "prepared" && receipt.status !== "verified") {
    return;
  }
  const entryOnly = request.boundary === "none";
  if ((receipt.release === null) !== entryOnly) {
    protocolMismatch(
      entryOnly
        ? "An entry-only handoff on the none boundary must not name a release."
        : "Prepared or verified work on a public boundary must name the release."
    );
  }
  const { versionDecision } = receipt;
  if (
    entryOnly &&
    versionDecision &&
    (versionDecision.bumpLevel !== "none" ||
      versionDecision.resolution !== "not-required" ||
      versionDecision.selectedVersion !== null)
  ) {
    protocolMismatch(
      "An entry-only handoff must not select or bump a version."
    );
  }
};

const validateV2Transaction = (
  request: ChangelogRequest,
  receipt: ChangelogReceiptV2
): ChangelogReceipt => {
  if (!request.supportedReceiptVersions.includes(2)) {
    protocolMismatch("The delegated request did not advertise receipt v2.");
  }
  const expectedSourceRevision =
    request.phase === "verify"
      ? request.finalizedTargetRevision
      : request.inputTargetRevision;
  if (
    receipt.transactionId !== request.transactionId ||
    receipt.releaseSetId !== request.releaseSetId ||
    receipt.phase !== request.phase ||
    receipt.revisionLineage.inputTargetRevision !==
      request.inputTargetRevision ||
    receipt.sourceRevision !== expectedSourceRevision
  ) {
    protocolMismatch(
      "Receipt transaction, phase, release set, or revision does not match the delegated request."
    );
  }
  assertPublicReleaseDecision(receipt);
  assertEntryOnlyBinding(request, receipt);
  const { versionDecision } = receipt;
  if (
    versionDecision &&
    (versionDecision.releaseTrain !== request.releaseTrain ||
      versionDecision.boundary !== request.boundary)
  ) {
    protocolMismatch(
      "Receipt release train or boundary does not match the delegated request."
    );
  }
  if (
    versionDecision &&
    (versionDecision.resolution === "automatic" ||
      versionDecision.resolution === "explicit-direction" ||
      versionDecision.resolution === "repository-automation") &&
    !versionDecision.selectedVersion
  ) {
    protocolMismatch(
      "Resolved public version direction must include the selected version."
    );
  }
  if (
    versionDecision?.bumpLevel === "unknown" &&
    versionDecision.resolution !== "blocked"
  ) {
    protocolMismatch("Unknown release impact must remain blocked.");
  }
  if (
    receipt.release &&
    receipt.release.version !== versionDecision?.selectedVersion
  ) {
    protocolMismatch(
      "Prepared or verified release version does not match the selected version."
    );
  }
  if (
    request.approvedDecisionDigest &&
    receipt.decisionDigest !== request.approvedDecisionDigest
  ) {
    protocolMismatch("Receipt decision digest does not match the approval.");
  }
  if (
    request.approvedVersion &&
    versionDecision?.selectedVersion !== request.approvedVersion
  ) {
    protocolMismatch("Receipt selected version does not match the approval.");
  }
  if (
    request.phase === "verify" &&
    receipt.revisionLineage.finalizedTargetRevision !==
      request.finalizedTargetRevision
  ) {
    protocolMismatch(
      "Verified receipt does not name the delegated finalized target."
    );
  }
  return receipt;
};

export const inspectChangelogTransaction = (
  requestInput: unknown,
  receiptInput: unknown,
  priorReceiptInput?: unknown
): ChangelogTransactionValidation => {
  const request = validateSchema<ChangelogRequest>(
    "changelog-request",
    requestInput
  );
  const receipt = validateSchema<ChangelogReceipt>(
    "changelog-receipt",
    receiptInput
  );
  const priorReceiptDigestStatus = verifyPriorReceiptDigest(
    request,
    priorReceiptInput
  );
  return {
    priorReceiptDigestStatus,
    receipt:
      receipt.schemaVersion === 1
        ? validateLegacyTransaction(request, receipt)
        : validateV2Transaction(request, receipt),
  };
};

export const validateChangelogTransaction = (
  requestInput: unknown,
  receiptInput: unknown,
  priorReceiptInput?: unknown
): ChangelogReceipt =>
  inspectChangelogTransaction(requestInput, receiptInput, priorReceiptInput)
    .receipt;

export type ReleaseGateAction =
  | "continue"
  | "request-version-approval"
  | "request-production-approval"
  | "request-combined-approval"
  | "merge-reconciliation"
  | "verify-existing-production"
  | "deploy"
  | "stop-after-integration"
  | "re-delegate"
  | "block";

export interface ReleaseGateContext {
  alreadyLive: boolean;
  priorReceipt?: ChangelogReceipt;
  productionAuthorized: boolean;
  productionDeploy: "ask" | "allow" | "deny";
  receipt: ChangelogReceipt;
  request: ChangelogRequest;
  versionAuthorized: boolean;
}

export interface ReleaseGateDecision {
  action: ReleaseGateAction;
  decisionDigest: string | null;
  reason: string;
  reasonCode: ReleaseReasonCode | null;
  requiredAction: ReleaseRequiredAction | null;
  selectedVersion: string | null;
}

const decision = (
  action: ReleaseGateAction,
  receipt: ChangelogReceiptV2 | null,
  reason: string,
  reasonCode: ReleaseReasonCode | null = null,
  requiredAction: ReleaseRequiredAction | null = null
): ReleaseGateDecision => ({
  action,
  decisionDigest: receipt ? receipt.decisionDigest : null,
  reason,
  reasonCode,
  requiredAction,
  selectedVersion: receipt?.versionDecision?.selectedVersion ?? null,
});

const decideLegacyReceipt = (
  receipt: Extract<ChangelogReceipt, { schemaVersion: 1 }>
): ReleaseGateDecision =>
  receipt.status === "not-applicable"
    ? decision("continue", null, "No public release gate applies.")
    : decision(
        "block",
        null,
        "Receipt v2 is required to form a new public version.",
        "unsupported-protocol",
        "upgrade-producer"
      );

const decidePreparedReceipt = (
  context: ReleaseGateContext,
  receipt: ChangelogReceiptV2
): ReleaseGateDecision => {
  if (context.request.boundary === "none") {
    return decision(
      "merge-reconciliation",
      receipt,
      "Operator-history entry is prepared without a version; merge the reconciliation."
    );
  }
  if (context.productionDeploy === "deny") {
    return decision(
      "stop-after-integration",
      receipt,
      "Production policy denies crossing the public release boundary."
    );
  }
  if (
    receipt.versionDecision?.boundary === "release-bearing-merge" &&
    context.productionDeploy === "ask" &&
    !context.productionAuthorized
  ) {
    return decision(
      "request-production-approval",
      receipt,
      "Production authority is required before the release-bearing merge."
    );
  }
  return decision(
    "merge-reconciliation",
    receipt,
    "Prepared release reconciliation is ready for an authorized merge."
  );
};

const decideVerifiedReceipt = (
  context: ReleaseGateContext,
  receipt: ChangelogReceiptV2
): ReleaseGateDecision => {
  if (context.request.boundary === "none") {
    return decision(
      "continue",
      receipt,
      "Operator-history entry is integrated in the finalized target; no deployment gate applies."
    );
  }
  if (context.productionDeploy === "deny") {
    return decision(
      "stop-after-integration",
      receipt,
      "The release is verified, but production deployment is denied."
    );
  }
  if (context.productionDeploy === "ask" && !context.productionAuthorized) {
    return decision(
      "request-production-approval",
      receipt,
      "The finalized release is verified and awaits production authority."
    );
  }
  return decision(
    context.alreadyLive ? "verify-existing-production" : "deploy",
    receipt,
    context.alreadyLive
      ? "The exact verified target is already live; verify without redeploying."
      : "Deploy the exact verified finalized target."
  );
};

const decideV2Receipt = (
  context: ReleaseGateContext,
  receipt: ChangelogReceiptV2
): ReleaseGateDecision => {
  switch (receipt.status) {
    case "blocked":
      return decision(
        "block",
        receipt,
        receipt.reason ?? "Changelog release work is blocked.",
        receipt.reasonCode,
        receipt.requiredAction
      );
    case "not-applicable":
      return decision("continue", receipt, "No public release gate applies.");
    case "decision-required":
      if (context.versionAuthorized) {
        return decision(
          "re-delegate",
          receipt,
          "Version direction is available; prepare against the same decision digest."
        );
      }
      return decision(
        context.productionDeploy === "ask"
          ? "request-combined-approval"
          : "request-version-approval",
        receipt,
        receipt.reason ?? "An exact public version direction is required.",
        receipt.reasonCode,
        receipt.requiredAction
      );
    case "prepared":
      return decidePreparedReceipt(context, receipt);
    case "verified":
      return decideVerifiedReceipt(context, receipt);
    default:
      return protocolMismatch("Receipt has an unsupported release status.");
  }
};

export const decideReleaseGate = (
  context: ReleaseGateContext
): ReleaseGateDecision => {
  const validation = inspectChangelogTransaction(
    context.request,
    context.receipt,
    context.priorReceipt
  );
  const { receipt } = validation;
  if (validation.priorReceiptDigestStatus === "unverified") {
    return decision(
      "block",
      receipt.schemaVersion === 2 ? receipt : null,
      "The later release phase is not bound to its prior receipt. Pass the exact prior receipt before authorizing merge or deployment.",
      "malformed-request",
      "repair-request"
    );
  }
  if (receipt.schemaVersion === 1) {
    return decideLegacyReceipt(receipt);
  }
  return decideV2Receipt(context, receipt);
};
