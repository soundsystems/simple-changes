import { EXIT_CODES, SimpleChangesError } from "../lib/errors.ts";
import { auditMarkdown } from "../lib/markdown.ts";
import { redactSecrets } from "../lib/redact.ts";
import { validateSchema } from "../lib/schema.ts";
import type { ProviderReceipt, ProviderStatus } from "../lib/types.ts";

export interface ForgeReceiptInput {
  action: string;
  approvalRevision: string | null;
  baseRevision: string;
  body: string;
  evidence: string[];
  headRevision: string;
  objectId: string;
  provider: string;
  renderedBody: string;
  status: ProviderStatus;
  url: string | null;
}

export const normalizeForgeReceipt = (
  input: ForgeReceiptInput
): ProviderReceipt => {
  const { status: inputStatus } = input;
  const sourceAudit = auditMarkdown(input.body);
  const renderedAudit = auditMarkdown(input.renderedBody);
  const evidence = [
    ...input.evidence,
    ...sourceAudit.issues,
    ...renderedAudit.issues.map((issue) => `Rendered body: ${issue}`),
  ].map(redactSecrets);
  let status = inputStatus;
  if (
    inputStatus === "succeeded" &&
    !(sourceAudit.valid && renderedAudit.valid)
  ) {
    status = "failed";
  }
  if (input.approvalRevision && input.approvalRevision !== input.headRevision) {
    status = "failed";
    evidence.push(
      "Approval revision does not match the current head revision."
    );
  }
  const receipt: ProviderReceipt = {
    action: input.action,
    approvalRevision: input.approvalRevision,
    baseRevision: input.baseRevision,
    canonicalTargets: [],
    deliveryModel: null,
    environment: null,
    evidence,
    expectedCanonicalTargets: [],
    headRevision: input.headRevision,
    immutableResultId: null,
    intendedRevision: null,
    kind: "forge",
    objectId: input.objectId,
    observedAt: new Date().toISOString(),
    observedRevision: null,
    project: null,
    provider: input.provider,
    providerReady: null,
    schemaVersion: 1,
    smoke: null,
    status,
    url: input.url,
  };
  return validateSchema<ProviderReceipt>("provider-receipt", receipt);
};

export const assertApprovalFresh = (receipt: ProviderReceipt): void => {
  if (receipt.kind !== "forge") {
    throw new SimpleChangesError(
      "Approval freshness applies only to forge receipts",
      EXIT_CODES.validation
    );
  }
  if (
    !(receipt.headRevision && receipt.approvalRevision) ||
    receipt.headRevision !== receipt.approvalRevision
  ) {
    throw new SimpleChangesError(
      "Approval is missing or stale for the current proposal revision",
      EXIT_CODES.validation
    );
  }
};

export interface FakeForgeAdapter {
  createProposal: (
    input: Omit<ForgeReceiptInput, "provider">
  ) => ProviderReceipt;
  readonly provider: string;
}

export const createFakeForgeAdapter = (provider: string): FakeForgeAdapter => ({
  createProposal: (input) =>
    normalizeForgeReceipt({
      ...input,
      provider,
    }),
  provider,
});

export const unsupportedForgeReceipt = (
  provider: string,
  detail: string
): ProviderReceipt =>
  normalizeForgeReceipt({
    action: "discover",
    approvalRevision: null,
    baseRevision: "unknown",
    body: "Unsupported capability",
    evidence: [detail],
    headRevision: "unknown",
    objectId: `${provider}:unsupported`,
    provider,
    renderedBody: "Unsupported capability",
    status: "unsupported",
    url: null,
  });
