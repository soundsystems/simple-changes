import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { CURRENT_GUIDANCE_VERSION } from "./guidance-updates.ts";
import { validateSchema } from "./schema.ts";
import type { PolicySource, RepoPolicy } from "./types.ts";

export const DEFAULT_POLICY: RepoPolicy = {
  changelogHandling: "preserve-and-report",
  concurrentWork: "allow-claimed",
  defaultFinish: "open-change-request",
  guidance: {
    disposition: "accepted",
    version: CURRENT_GUIDANCE_VERSION,
  },
  handoffTiming: "confirm-ready",
  productionDeploy: "ask",
  questions: "blocking-only",
  review: "repository-policy",
  schemaVersion: 1,
  shippingMode: "standard",
  uiArtifactVersioning: "repository-convention",
};

type StoredRepoPolicy = Omit<
  RepoPolicy,
  | "changelogHandling"
  | "guidance"
  | "handoffTiming"
  | "shippingMode"
  | "uiArtifactVersioning"
> & {
  changelogHandling?: RepoPolicy["changelogHandling"];
  guidance: {
    disposition?: RepoPolicy["guidance"]["disposition"];
    version: number;
  };
  handoffTiming?: RepoPolicy["handoffTiming"];
  shippingMode?: RepoPolicy["shippingMode"];
  uiArtifactVersioning?: RepoPolicy["uiArtifactVersioning"];
};

interface PersonalPolicyPathOptions {
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

interface LoadPolicyOptions {
  personalPolicyPath?: string;
}

export interface LoadedPolicy {
  path: string | null;
  source: PolicySource;
  value: RepoPolicy;
}

const parsePolicyFile = (path: string): RepoPolicy => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const validated = validateSchema<StoredRepoPolicy>("repo-policy", parsed);
  return {
    ...validated,
    changelogHandling:
      validated.changelogHandling ?? DEFAULT_POLICY.changelogHandling,
    guidance: {
      disposition: validated.guidance.disposition ?? "accepted",
      version: validated.guidance.version,
    },
    handoffTiming: validated.handoffTiming ?? DEFAULT_POLICY.handoffTiming,
    shippingMode: validated.shippingMode ?? DEFAULT_POLICY.shippingMode,
    uiArtifactVersioning:
      validated.uiArtifactVersioning ?? DEFAULT_POLICY.uiArtifactVersioning,
  };
};

export const resolvePersonalPolicyPath = (
  options: PersonalPolicyPathOptions = {}
): string => {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const configuredDirectory =
    environment.SIMPLE_CHANGES_CONFIG_DIR?.trim() ||
    environment.XDG_CONFIG_HOME?.trim();
  if (configuredDirectory) {
    return resolve(configuredDirectory, "simple-changes", "preferences.json");
  }
  if (platform === "win32" && environment.APPDATA?.trim()) {
    return resolve(environment.APPDATA, "simple-changes", "preferences.json");
  }
  const configurationDirectory =
    platform === "darwin"
      ? resolve(homeDirectory, "Library", "Application Support")
      : resolve(homeDirectory, ".config");
  return resolve(configurationDirectory, "simple-changes", "preferences.json");
};

const assertWritablePolicyPath = (path: string): void => {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new SimpleChangesError(
      `Refusing to replace a policy symlink: ${path}`,
      EXIT_CODES.unsafe
    );
  }
};

export const writePolicyFile = (
  path: string,
  policy: RepoPolicy,
  privateFile = false
): void => {
  const validated = validateSchema<RepoPolicy>("repo-policy", policy);
  assertWritablePolicyPath(path);
  const directory = dirname(path);
  mkdirSync(directory, {
    mode: privateFile ? 0o700 : 0o755,
    recursive: true,
  });
  const temporaryPath = resolve(
    directory,
    `.${randomUUID()}.simple-changes.tmp`
  );
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: privateFile ? 0o600 : 0o644,
  });
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
  const persisted = validateSchema<RepoPolicy>(
    "repo-policy",
    JSON.parse(readFileSync(path, "utf8")) as unknown
  );
  if (JSON.stringify(persisted) !== JSON.stringify(validated)) {
    throw new SimpleChangesError(
      `Policy verification failed after writing: ${path}`,
      EXIT_CODES.validation
    );
  }
};

export const loadPersonalPolicy = (
  personalPolicyPath = resolvePersonalPolicyPath()
): LoadedPolicy => {
  if (existsSync(personalPolicyPath)) {
    return {
      path: personalPolicyPath,
      source: "user",
      value: parsePolicyFile(personalPolicyPath),
    };
  }
  return {
    path: null,
    source: "default",
    value: DEFAULT_POLICY,
  };
};

export const loadPolicy = (
  primaryCheckout: string,
  options: LoadPolicyOptions = {}
): LoadedPolicy => {
  const policyPath = resolve(primaryCheckout, ".simple-changes.json");
  if (existsSync(policyPath)) {
    return {
      path: policyPath,
      source: "repository",
      value: parsePolicyFile(policyPath),
    };
  }
  const personalPolicyPath =
    options.personalPolicyPath ?? resolvePersonalPolicyPath();
  return loadPersonalPolicy(personalPolicyPath);
};
