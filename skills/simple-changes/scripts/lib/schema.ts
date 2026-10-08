import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";

type JsonSchema = Record<string, unknown>;

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const schemaDirectory = resolve(moduleDirectory, "../../evals/schemas");
// Single source of truth for packaged schema names; `SchemaName` is derived
// from it so the runtime registry and the type can never drift apart.
export const SCHEMA_NAMES = [
  "branch-audit",
  "repo-policy",
  "changelog-capabilities",
  "changelog-request",
  "changelog-receipt",
  "initialization",
  "inventory",
  "change-plan",
  "permission-bundle",
  "emergency-shipping",
  "migration-review",
  "migration-pending",
  "migration-apply-plan",
  "run-state",
  "provider-receipt",
  "release-delivery-receipt",
  "release-tag-receipt",
  "post-cleanup-recovery",
  "shipment-outcome",
  "preserved-source-override",
  "remote-branch-reconciliation",
  "remote-branch-ancestry",
  "remote-branch-supersession",
  "release-consistency",
  "release-notes",
  "release-notes-pointer",
  "proposal-audit",
  "loop-lease",
  "loop-close-equivalent",
  "worktree-coordination",
  "worktree-takeover",
  "ready-work-receipt",
  "ship-holds",
  "worktree-equivalence",
  "worktree-cleanup",
  "stale-lease-recovery",
] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];
const schemas = new Map<string, JsonSchema>();

for (const schemaName of SCHEMA_NAMES) {
  const filename = `${schemaName}.schema.json`;
  const schema = JSON.parse(
    readFileSync(resolve(schemaDirectory, filename), "utf8")
  ) as JsonSchema;
  schemas.set(filename, schema);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const decodePointerPart = (value: string): string =>
  value.replaceAll("~1", "/").replaceAll("~0", "~");

const resolvePointer = (
  schema: JsonSchema,
  pointer: string
): JsonSchema | null => {
  let current: unknown = schema;
  for (const part of pointer.split("/").slice(1).map(decodePointerPart)) {
    if (!(isRecord(current) && part in current)) {
      return null;
    }
    current = current[part];
  }
  return isRecord(current) ? current : null;
};

const resolveReference = (
  reference: string,
  rootSchema: JsonSchema
): { root: JsonSchema; schema: JsonSchema } | null => {
  if (reference.startsWith("#/")) {
    const schema = resolvePointer(rootSchema, reference.slice(1));
    return schema ? { root: rootSchema, schema } : null;
  }
  const [filename, fragment] = reference.split("#");
  const externalRoot = filename ? schemas.get(filename) : rootSchema;
  if (!externalRoot) {
    return null;
  }
  if (!fragment) {
    return { root: externalRoot, schema: externalRoot };
  }
  const schema = resolvePointer(externalRoot, fragment);
  return schema ? { root: externalRoot, schema } : null;
};

const typeMatches = (value: unknown, type: string): boolean => {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
};

const validateString = (
  value: string,
  schema: JsonSchema,
  path: string,
  errors: string[]
): void => {
  // JSON Schema lengths count Unicode characters (code points).
  const characters = [...value].length;
  if (typeof schema.minLength === "number" && characters < schema.minLength) {
    errors.push(`${path} must have at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === "number" && characters > schema.maxLength) {
    errors.push(`${path} must have at most ${schema.maxLength} characters`);
  }
  if (
    typeof schema.pattern === "string" &&
    !new RegExp(schema.pattern, "u").test(value)
  ) {
    errors.push(`${path} must match ${schema.pattern}`);
  }
  if (
    schema.format === "date-time" &&
    (Number.isNaN(Date.parse(value)) || !value.includes("T"))
  ) {
    errors.push(`${path} must be a date-time`);
  }
  if (schema.format === "uri" && !URL.canParse(value)) {
    errors.push(`${path} must be a URI`);
  }
};

const validateArray = (
  value: unknown[],
  schema: JsonSchema,
  rootSchema: JsonSchema,
  path: string,
  errors: string[]
): void => {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push(`${path} must contain at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push(`${path} must contain at most ${schema.maxItems} items`);
  }
  if (
    schema.uniqueItems === true &&
    new Set(value.map((item) => JSON.stringify(item))).size !== value.length
  ) {
    errors.push(`${path} must contain unique items`);
  }
  if (isRecord(schema.items)) {
    for (const [index, item] of value.entries()) {
      validateValue(item, schema.items, rootSchema, `${path}/${index}`, errors);
    }
  }
};

// Every property name must satisfy `propertyNames`, for maps keyed by ids.
const validatePropertyNames = (
  value: Record<string, unknown>,
  schema: JsonSchema,
  rootSchema: JsonSchema,
  path: string,
  errors: string[]
): void => {
  if (!isRecord(schema.propertyNames)) {
    return;
  }
  for (const key of Object.keys(value)) {
    validateValue(
      key,
      schema.propertyNames,
      rootSchema,
      `${path}/${key} (name)`,
      errors
    );
  }
};

const validateObject = (
  value: Record<string, unknown>,
  schema: JsonSchema,
  rootSchema: JsonSchema,
  path: string,
  errors: string[]
): void => {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      errors.push(`${path}/${key} is required`);
    }
  }
  if (
    typeof schema.minProperties === "number" &&
    Object.keys(value).length < schema.minProperties
  ) {
    errors.push(
      `${path} must have at least ${schema.minProperties} properties`
    );
  }
  validatePropertyNames(value, schema, rootSchema, path, errors);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const additional = schema.additionalProperties;
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) {
      continue;
    }
    if (additional === false) {
      errors.push(`${path}/${key} contains additional properties`);
    } else if (isRecord(additional)) {
      validateValue(
        value[key],
        additional,
        rootSchema,
        `${path}/${key}`,
        errors
      );
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key) && isRecord(propertySchema)) {
      validateValue(
        value[key],
        propertySchema,
        rootSchema,
        `${path}/${key}`,
        errors
      );
    }
  }
};

const validateAllOf = (
  value: unknown,
  candidates: unknown[],
  rootSchema: JsonSchema,
  path: string,
  errors: string[]
): void => {
  for (const candidate of candidates) {
    if (isRecord(candidate)) {
      validateValue(value, candidate, rootSchema, path, errors);
    }
  }
};

const validateConditional = (
  value: unknown,
  schema: JsonSchema,
  rootSchema: JsonSchema,
  path: string,
  errors: string[]
): void => {
  if (!isRecord(schema.if)) {
    return;
  }
  const conditionErrors: string[] = [];
  validateValue(value, schema.if, rootSchema, path, conditionErrors);
  let branch: JsonSchema | null = null;
  if (conditionErrors.length === 0 && isRecord(schema.then)) {
    branch = schema.then;
  } else if (conditionErrors.length > 0 && isRecord(schema.else)) {
    branch = schema.else;
  }
  if (branch) {
    validateValue(value, branch, rootSchema, path, errors);
  }
};

const matchesAnyOf = (
  value: unknown,
  candidates: unknown[],
  rootSchema: JsonSchema,
  path: string
): boolean =>
  candidates.some((candidate) => {
    if (!isRecord(candidate)) {
      return false;
    }
    const candidateErrors: string[] = [];
    validateValue(value, candidate, rootSchema, path, candidateErrors);
    return candidateErrors.length === 0;
  });

const validateValue = (
  value: unknown,
  schema: JsonSchema,
  rootSchema: JsonSchema,
  path: string,
  errors: string[]
): void => {
  if (typeof schema.$ref === "string") {
    const resolvedReference = resolveReference(schema.$ref, rootSchema);
    if (!resolvedReference) {
      errors.push(`${path} references an unknown schema: ${schema.$ref}`);
      return;
    }
    validateValue(
      value,
      resolvedReference.schema,
      resolvedReference.root,
      path,
      errors
    );
    return;
  }

  if (Array.isArray(schema.allOf)) {
    validateAllOf(value, schema.allOf, rootSchema, path, errors);
  }

  validateConditional(value, schema, rootSchema, path, errors);

  if (
    Array.isArray(schema.anyOf) &&
    !matchesAnyOf(value, schema.anyOf, rootSchema, path)
  ) {
    errors.push(`${path} must match one allowed schema`);
  }

  if ("const" in schema && !deepEqual(value, schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => deepEqual(item, value))
  ) {
    errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
  }

  if (typeof schema.type === "string" && !typeMatches(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }
  if (typeof value === "string") {
    validateString(value, schema, path, errors);
  } else if (Array.isArray(value)) {
    validateArray(value, schema, rootSchema, path, errors);
  } else if (isRecord(value)) {
    validateObject(value, schema, rootSchema, path, errors);
  } else if (
    typeof value === "number" &&
    typeof schema.minimum === "number" &&
    value < schema.minimum
  ) {
    errors.push(`${path} must be at least ${schema.minimum}`);
  }
};

export const validateSchema = <T>(
  schemaName: SchemaName,
  value: unknown
): T => {
  const filename = `${schemaName}.schema.json`;
  const schema = schemas.get(filename);
  if (!schema) {
    throw new SimpleChangesError(
      `Unknown schema: ${schemaName}`,
      EXIT_CODES.validation
    );
  }
  return validateSchemaDocument(schemaName, schema, value);
};

export const validateSchemaDocument = <T>(
  schemaName: string,
  schema: Record<string, unknown>,
  value: unknown
): T => {
  const errors: string[] = [];
  validateValue(value, schema, schema, "", errors);
  if (errors.length > 0) {
    throw new SimpleChangesError(
      `Invalid ${schemaName}: ${errors.join("; ")}`,
      EXIT_CODES.validation
    );
  }
  return value as T;
};

export const schemaPath = (schemaName: SchemaName): string =>
  resolve(schemaDirectory, `${schemaName}.schema.json`);
