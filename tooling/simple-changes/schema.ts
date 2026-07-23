import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchemaDocument } from "../../skills/simple-changes/scripts/lib/schema.ts";

export type ToolingSchemaName =
  | "eval-manifest"
  | "runner-request"
  | "runner-response";

const schemaDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "evals/schemas"
);

export const toolingSchemaPath = (schemaName: ToolingSchemaName): string =>
  resolve(schemaDirectory, `${schemaName}.schema.json`);

export const validateToolingSchema = <T>(
  schemaName: ToolingSchemaName,
  value: unknown
): T => {
  const schema = JSON.parse(
    readFileSync(toolingSchemaPath(schemaName), "utf8")
  ) as Record<string, unknown>;
  return validateSchemaDocument<T>(schemaName, schema, value);
};
