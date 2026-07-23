import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSchema } from "./schema.ts";
import type { RepoPolicy } from "./types.ts";

export const DEFAULT_POLICY: RepoPolicy = {
  concurrentWork: "preserve",
  defaultFinish: "open-change-request",
  guidance: {
    version: 1,
  },
  productionDeploy: "ask",
  questions: "blocking-only",
  review: "repository-policy",
  schemaVersion: 1,
};

export const loadPolicy = (
  primaryCheckout: string
): {
  source: "default" | "repository";
  path: string | null;
  value: RepoPolicy;
} => {
  const policyPath = resolve(primaryCheckout, ".simple-changes.json");
  if (!existsSync(policyPath)) {
    return {
      path: null,
      source: "default",
      value: DEFAULT_POLICY,
    };
  }
  const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as unknown;
  return {
    path: policyPath,
    source: "repository",
    value: validateSchema<RepoPolicy>("repo-policy", parsed),
  };
};
