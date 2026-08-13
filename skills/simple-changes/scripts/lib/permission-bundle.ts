import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { validateSchema } from "./schema.ts";
import type {
  PermissionBundle,
  PermissionRequest,
  PermissionRequestInput,
} from "./types.ts";

const RESPONSE_INSTRUCTION =
  "Reply once to approve all listed permissions, decline all, or name the request IDs you approve. Unlisted future actions are not authorized.";
const OPERATION_AUTHORITY = {
  "apply-migration": "remote-data-write",
  "audit-migration": "local-write",
  branch: "local-write",
  cleanup: "local-write",
  commit: "local-write",
  "deploy-preview": "preview-deploy",
  "deploy-production": "production-deploy",
  "fast-forward-target": "local-sync",
  "fetch-target": "local-sync",
  merge: "merge",
  "merge-target": "local-write",
  "open-proposal": "proposal-write",
  "promote-deployment": "production-deploy",
  push: "proposal-write",
  "reconcile-managed-targets": "production-deploy",
  "reconcile-remote-branches": "remote-branch-delete",
  "select-release-version": "store-release",
  "update-proposal": "proposal-write",
} as const satisfies Record<
  PermissionRequestInput["operation"],
  PermissionRequestInput["authority"]
>;

const normalizedField = (value: string, label: string): string => {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    throw new SimpleChangesError(
      `Permission ${label} must be explicit`,
      EXIT_CODES.validation
    );
  }
  return normalized;
};

const requestId = (request: PermissionRequestInput): string =>
  `permission-${sha256(JSON.stringify(request)).slice(0, 12)}`;

export const buildPermissionBundle = (
  inputs: PermissionRequestInput[],
  generatedAt = new Date().toISOString()
): PermissionBundle => {
  const requests = new Map<string, PermissionRequest>();
  for (const input of inputs) {
    const normalized: PermissionRequestInput = {
      authority: input.authority,
      consequence: normalizedField(input.consequence, "consequence"),
      operation: input.operation,
      reason: normalizedField(input.reason, "reason"),
      target: normalizedField(input.target, "target"),
    };
    const expected =
      OPERATION_AUTHORITY[
        normalized.operation as keyof typeof OPERATION_AUTHORITY
      ];
    if (!expected) {
      throw new SimpleChangesError(
        `Permission operation ${normalized.operation} has no closed authority mapping`,
        EXIT_CODES.validation
      );
    }
    if (normalized.authority !== expected) {
      throw new SimpleChangesError(
        `Permission operation ${normalized.operation} requires authority ${expected}, not ${normalized.authority}`,
        EXIT_CODES.validation
      );
    }
    const id = requestId(normalized);
    requests.set(id, { id, ...normalized });
  }
  const bundle: PermissionBundle = {
    generatedAt,
    mode: "ship",
    requests: [...requests.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    responseInstruction: RESPONSE_INSTRUCTION,
    schemaVersion: 1,
  };
  return validateSchema<PermissionBundle>("permission-bundle", bundle);
};

export const renderPermissionBundle = (bundle: PermissionBundle): string => {
  validateSchema<PermissionBundle>("permission-bundle", bundle);
  if (bundle.requests.length === 0) {
    return "No unresolved shipping permissions are known.";
  }
  return [
    "Before shipping continues, please decide every currently known permission in one reply:",
    ...bundle.requests.map(
      (request) =>
        `- ${request.id}: ${request.operation} on ${request.target} (${request.authority}). ${request.consequence} Reason: ${request.reason}`
    ),
    bundle.responseInstruction,
  ].join("\n");
};
