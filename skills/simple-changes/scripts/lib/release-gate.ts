import { readFileSync } from "node:fs";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256Json } from "./hash.ts";
import { schemaPath, validateSchema } from "./schema.ts";
import type {
  ChangelogCapabilities,
  ChangelogFeature,
  ChangelogReceipt,
  ChangelogRequest,
  LineCarryingChangelogReceipt,
  ModernChangelogReceipt,
  ReleaseReasonCode,
  ReleaseRequiredAction,
  ReleaseTag,
} from "./types.ts";
import {
  assertReleaseSetConsistency,
  assertReleaseSetTrains,
  assertVersionLine,
  type ReleaseSetConsistency,
  sameLineState,
} from "./version-line.ts";

export interface ChangelogConsumerCapabilities {
  features: ChangelogFeature[];
  receiptVersions: Array<1 | 2 | 3 | 4>;
  requestVersions: Array<1 | 2 | 3>;
  schemaDigests: NonNullable<ChangelogCapabilities["schemaDigests"]>;
}

export interface NegotiatedChangelogProtocol {
  compatible: boolean;
  features: ChangelogFeature[];
  reasonCode: "unsupported-protocol" | null;
  receiptVersion: 1 | 2 | 3 | 4 | null;
  requestVersion: 1 | 2 | 3 | null;
  requiredAction: "upgrade-producer" | null;
  schemaDigestStatus: "match" | "differs" | "unadvertised";
}

export const packagedChangelogProtocol = (): ChangelogConsumerCapabilities => ({
  features: [
    "public-version-policy",
    "classify-prepare-verify",
    "multi-train-receipts",
    "guidance-update-notices",
    "shared-version-lines",
  ],
  receiptVersions: [1, 2, 3, 4],
  requestVersions: [1, 2, 3],
  schemaDigests: {
    changelogReceipt: sha256Json(
      JSON.parse(readFileSync(schemaPath("changelog-receipt"), "utf8"))
    ),
    changelogRequest: sha256Json(
      JSON.parse(readFileSync(schemaPath("changelog-request"), "utf8"))
    ),
  },
});

// The highest version both sides support. A producer may advertise versions
// this consumer does not know; they never match.
const highestOverlap = <Version extends number>(
  producer: number[],
  consumer: Version[]
): Version | null =>
  consumer
    .filter((version) => producer.includes(version))
    .sort((a, b) => b - a)[0] ?? null;

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

// The highest receipt version each request version may advertise: request v1
// allows receipts 1 and 2, request v2 adds 3, and request v3 adds 4.
const RECEIPT_CAP_BY_REQUEST = { 1: 2, 2: 3, 3: 4 } as const;

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
  // The receipt is the highest shared version the chosen request may
  // advertise, so request v1 never pairs with receipt v3 or v4. Without a
  // shared request the pair is incompatible, and the uncapped receipt
  // overlap is reported only as a diagnostic.
  const receiptCap = requestVersion
    ? RECEIPT_CAP_BY_REQUEST[requestVersion]
    : Number.POSITIVE_INFINITY;
  const receiptVersion = highestOverlap(
    producer.receiptVersions,
    consumer.receiptVersions.filter((version) => version <= receiptCap)
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
    // Unknown producer features are ignored, so a provider can advertise a
    // newer feature without breaking this consumer.
    features: producer.features.filter((feature): feature is ChangelogFeature =>
      consumer.features.includes(feature as ChangelogFeature)
    ),
    reasonCode: null,
    receiptVersion,
    requestVersion,
    requiredAction: null,
    schemaDigestStatus,
  };
};

const protocolMismatchFor = (message: string): never =>
  protocolMismatch(message);

export const validateChangelogRequest = (input: unknown): ChangelogRequest => {
  const request = validateSchema<ChangelogRequest>("changelog-request", input);
  assertReleaseSetTrains(request, protocolMismatchFor);
  return request;
};

export const createChangelogRequest = (
  input: ChangelogRequest
): ChangelogRequest => validateChangelogRequest(input);

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

const assertPublicReleaseDecision = (receipt: ModernChangelogReceipt): void => {
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
  receipt: ModernChangelogReceipt
): void => {
  if (
    receipt.status !== "classified" &&
    receipt.status !== "prepared" &&
    receipt.status !== "verified"
  ) {
    return;
  }
  const entryOnly = request.boundary === "none";
  if (receipt.status === "classified" && receipt.release !== null) {
    protocolMismatch(
      "Classification must not name a prepared or integrated release."
    );
  }
  if (
    receipt.status !== "classified" &&
    (receipt.release === null) !== entryOnly
  ) {
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
      versionDecision.selectedVersion !== null ||
      versionDecision.policyAction !== "not-applicable" ||
      versionDecision.suggestedVersion !== null)
  ) {
    protocolMismatch(
      "An entry-only handoff must not select or bump a version."
    );
  }
};

// The request must have advertised the receipt's version; v3 and v4 also
// echo the release set and carry the version line, and v4 names the tag.
const assertReceiptVersion = (
  request: ChangelogRequest,
  receipt: ModernChangelogReceipt
): void => {
  if (!request.supportedReceiptVersions.includes(receipt.schemaVersion)) {
    protocolMismatch(
      `The delegated request did not advertise receipt v${receipt.schemaVersion}.`
    );
  }
  if (receipt.schemaVersion === 3 || receipt.schemaVersion === 4) {
    assertVersionLine(request, receipt, protocolMismatchFor);
  }
  if (receipt.schemaVersion === 4 && receipt.release?.tag) {
    assertReleaseTag(receipt.release.tag, receipt.release.version);
  }
};

// A resolved decision names its version, and an ask policy resolves only by
// the user's explicit direction: an automatic or repository-automation
// resolution would skip the version decision the policy requires.
const assertVersionResolution = (
  versionDecision: ModernChangelogReceipt["versionDecision"]
): void => {
  if (
    versionDecision?.policyAction === "ask" &&
    (versionDecision.resolution === "automatic" ||
      versionDecision.resolution === "repository-automation")
  ) {
    protocolMismatch(
      "An ask version policy resolves only by explicit direction."
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
};

// The structural ref-name rules the schema's character class cannot express,
// matching `git check-ref-format refs/tags/<name>`, plus a leading `-` so a
// name can never read as an option.
const tagNameProblem = (name: string): string | null => {
  if (name.startsWith("-")) {
    return "must not start with -";
  }
  if (name.startsWith("/") || name.endsWith("/")) {
    return "must not start or end with /";
  }
  if (name.endsWith(".")) {
    return "must not end with .";
  }
  for (const sequence of ["..", "@{", "//"]) {
    if (name.includes(sequence)) {
      return `must not contain ${sequence}`;
    }
  }
  if (
    name
      .split("/")
      .some(
        (component) => component.startsWith(".") || component.endsWith(".lock")
      )
  ) {
    return "must not have a component that starts with . or ends with .lock";
  }
  return null;
};

const VERSION_BOUNDARY_PATTERN = /[0-9.]$/u;

/**
 * A release tag is the version itself, or a literal prefix plus the version
 * whose last character is neither a digit nor `.`, so `v1` plus `1.2.0` can
 * never pass as `v11.2.0`.
 */
export const assertReleaseTag = (tag: ReleaseTag, version: string): void => {
  const problem = tagNameProblem(tag.name);
  if (problem) {
    protocolMismatch(`Release tag ${tag.name} ${problem}.`);
  }
  const prefix = tag.name.slice(0, tag.name.length - version.length);
  if (
    !tag.name.endsWith(version) ||
    (prefix !== "" && VERSION_BOUNDARY_PATTERN.test(prefix))
  ) {
    protocolMismatch(
      `Release tag ${tag.name} must be ${version} or end with it after a character other than a digit or ".".`
    );
  }
};

// Receipts v2, v3, and v4 share every binding below.
const validateModernTransaction = (
  request: ChangelogRequest,
  receipt: ModernChangelogReceipt
): ChangelogReceipt => {
  assertReceiptVersion(request, receipt);
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
  assertVersionResolution(versionDecision);
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

// The decision digest must cover the version line's state: a later phase that
// keeps the approved digest cannot carry a different state. The outcome may
// change, because an approved direction can turn a catch-up into an advance.
const carriesVersionLine = (
  receipt: ChangelogReceipt
): receipt is LineCarryingChangelogReceipt =>
  receipt.schemaVersion === 3 || receipt.schemaVersion === 4;

const assertDigestCoversVersionLine = (
  prior: ChangelogReceipt,
  receipt: ChangelogReceipt
): void => {
  if (
    carriesVersionLine(prior) &&
    carriesVersionLine(receipt) &&
    prior.decisionDigest === receipt.decisionDigest &&
    !sameLineState(
      prior.versionDecision?.versionLine ?? null,
      receipt.versionDecision?.versionLine ?? null
    )
  ) {
    protocolMismatch(
      "The version line's state changed while the decision digest stayed the same; the digest must cover the line state."
    );
  }
};

// The tag a receipt's release record names: a v4 release's tag, or null for a
// release from an earlier receipt version, which cannot name one.
const releaseTagOf = (receipt: ChangelogReceipt): ReleaseTag | null =>
  receipt.schemaVersion === 4 ? (receipt.release?.tag ?? null) : null;

const sameTag = (left: ReleaseTag | null, right: ReleaseTag | null): boolean =>
  left === null || right === null
    ? left === right
    : left.name === right.name && left.message === right.message;

// Once a prepared v4 release names its tag (or no tag), every later receipt
// that carries the release names exactly the same one: the pre-merge dry run
// checked that name, so a dropped, added, or changed tag fails closed. A
// receipt without a release record (an entry-only or blocked receipt) has
// nothing to compare.
const assertTagUnchanged = (
  prior: ChangelogReceipt,
  receipt: ChangelogReceipt
): void => {
  if (
    prior.schemaVersion !== 4 ||
    prior.release === null ||
    receipt.schemaVersion === 1 ||
    receipt.release === null
  ) {
    return;
  }
  if (!sameTag(releaseTagOf(prior), releaseTagOf(receipt))) {
    protocolMismatch(
      "The release tag changed after prepare; a later receipt must name exactly the prior receipt's release.tag."
    );
  }
};

export const inspectChangelogTransaction = (
  requestInput: unknown,
  receiptInput: unknown,
  priorReceiptInput?: unknown
): ChangelogTransactionValidation => {
  const request = validateChangelogRequest(requestInput);
  const receipt = validateSchema<ChangelogReceipt>(
    "changelog-receipt",
    receiptInput
  );
  const priorReceiptDigestStatus = verifyPriorReceiptDigest(
    request,
    priorReceiptInput
  );
  if (priorReceiptDigestStatus === "verified") {
    const prior = validateSchema<ChangelogReceipt>(
      "changelog-receipt",
      priorReceiptInput
    );
    assertDigestCoversVersionLine(prior, receipt);
    assertTagUnchanged(prior, receipt);
  }
  return {
    priorReceiptDigestStatus,
    receipt:
      receipt.schemaVersion === 1
        ? validateLegacyTransaction(request, receipt)
        : validateModernTransaction(request, receipt),
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
  receipt: ModernChangelogReceipt | null,
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
  receipt: ModernChangelogReceipt
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
  receipt: ModernChangelogReceipt
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

const decideModernReceipt = (
  context: ReleaseGateContext,
  receipt: ModernChangelogReceipt
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
    case "classified":
      return decision(
        "re-delegate",
        receipt,
        "The entry is relevant; prepare it against the same decision digest."
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
      receipt.schemaVersion === 1 ? null : receipt,
      "The later release phase is not bound to its prior receipt. Pass the exact prior receipt before authorizing merge or deployment.",
      "malformed-request",
      "repair-request"
    );
  }
  if (receipt.schemaVersion === 1) {
    return decideLegacyReceipt(receipt);
  }
  return decideModernReceipt(context, receipt);
};

// Two trains in one release set must never claim one tag name; the changelog
// workflow's prefix-free templates already prevent it, and this is the cheap
// backstop.
const assertDistinctReleaseTags = (
  receipts: LineCarryingChangelogReceipt[]
): void => {
  const claimed = new Map<string, string>();
  for (const receipt of receipts) {
    const name = releaseTagOf(receipt)?.name;
    if (!name) {
      continue;
    }
    const train =
      receipt.versionDecision?.releaseTrain ?? receipt.transactionId;
    const other = claimed.get(name);
    if (other !== undefined && other !== train) {
      protocolMismatch(
        `Release tag ${name} is named by both ${other} and ${train}; each train needs its own tag.`
      );
    }
    claimed.set(name, train);
  }
};

/**
 * Checks the receipts of one multi-train release set together: shared release
 * set, input target, and train list, one number per version line, and one tag
 * per train. Each receipt must be a receipt v3 or v4; a v1 or v2 receipt
 * carries no release-set echo or version line to compare.
 */
export const validateChangelogReleaseSet = (
  receiptInputs: unknown[]
): ReleaseSetConsistency => {
  const receipts = receiptInputs.map((input) => {
    const receipt = validateSchema<ChangelogReceipt>(
      "changelog-receipt",
      input
    );
    if (!carriesVersionLine(receipt)) {
      return protocolMismatch(
        "A release-set check needs receipt v3 or v4, which echo the release set."
      );
    }
    return receipt;
  });
  const consistency = assertReleaseSetConsistency(
    receipts,
    protocolMismatchFor
  );
  assertDistinctReleaseTags(receipts);
  return consistency;
};
