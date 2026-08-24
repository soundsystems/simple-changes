import { createHash } from "node:crypto";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const canonicalize = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => {
    if (left < right) {
      return -1;
    }
    return left > right ? 1 : 0;
  });
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
};

export const sha256 = (value: JsonValue | string): string => {
  const input = typeof value === "string" ? value : canonicalize(value);
  return createHash("sha256").update(input).digest("hex");
};

export const sha256Json = (value: unknown): string =>
  sha256(JSON.parse(JSON.stringify(value)) as JsonValue);
