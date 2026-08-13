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
