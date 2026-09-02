import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { CURRENT_GUIDANCE_VERSION } from "./guidance-updates.ts";
import { sha256 } from "./hash.ts";
import { assertNoSymlinkAncestors } from "./path-safety.ts";
import { validateSchema } from "./schema.ts";
import type { PolicySource, RepoPolicy } from "./types.ts";

export const DEFAULT_POLICY: RepoPolicy = {
  changelogHandling: "preserve-and-report",
  concurrentWork: "allow-claimed",
  defaultFinish: "open-change-request",
  gitPushAuthorization: "ask",
  guidance: {
    disposition: "accepted",
    version: CURRENT_GUIDANCE_VERSION,
  },
  handoffTiming: "confirm-ready",
  migrationHandling: "ask-after-review",
  migrationTargets: [],
  productionDeploy: "ask",
  proposalScheduling: "balanced",
  proposalSignatures: "agent-and-version",
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
  | "gitPushAuthorization"
  | "handoffTiming"
  | "migrationHandling"
  | "migrationTargets"
  | "proposalScheduling"
  | "proposalSignatures"
  | "shippingMode"
  | "uiArtifactVersioning"
> & {
  changelogHandling?: RepoPolicy["changelogHandling"];
  guidance: {
    disposition?: RepoPolicy["guidance"]["disposition"];
    version: number;
  };
  gitPushAuthorization?: RepoPolicy["gitPushAuthorization"];
  handoffTiming?: RepoPolicy["handoffTiming"];
  migrationHandling?: RepoPolicy["migrationHandling"];
  migrationTargets?: RepoPolicy["migrationTargets"];
  proposalScheduling?: RepoPolicy["proposalScheduling"];
  proposalSignatures?: RepoPolicy["proposalSignatures"];
  shippingMode?: RepoPolicy["shippingMode"];
  uiArtifactVersioning?: RepoPolicy["uiArtifactVersioning"];
};

interface PersonalPolicyPathOptions {
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

interface LoadPolicyOptions {
  commonGitDirectory?: string;
  personalPolicyPath?: string;
}

export interface LoadedPolicy {
  path: string | null;
  source: PolicySource;
  trust: "not-required" | "trusted" | "untrusted";
  value: RepoPolicy;
}

interface RepositoryPolicyTrustReceipt {
  approvedBy: string;
  createdAt: string;
  policyDigest: string;
  policyPath: string;
  reason: string;
  repository: string;
  schemaVersion: 1;
}

const repositoryPolicyTrustPath = (commonGitDirectory: string): string =>
  assertNoSymlinkAncestors(
    commonGitDirectory,
    "simple-changes/policy-trust.json"
  );

const requiresRepositoryTrust = (policy: RepoPolicy): boolean =>
  policy.gitPushAuthorization === "configure-harness" ||
  policy.productionDeploy === "allow" ||
  policy.shippingMode !== "standard" ||
  policy.migrationHandling.startsWith("auto-apply-");

const withoutUntrustedConsequentialAuthority = (
  policy: RepoPolicy
): RepoPolicy => ({
  ...policy,
  gitPushAuthorization:
    policy.gitPushAuthorization === "configure-harness"
      ? "ask"
      : policy.gitPushAuthorization,
  migrationHandling: policy.migrationHandling.startsWith("auto-apply-")
    ? "ask-after-review"
    : policy.migrationHandling,
  migrationTargets: policy.migrationHandling.startsWith("auto-apply-")
    ? []
    : policy.migrationTargets,
  productionDeploy:
    policy.productionDeploy === "allow" ? "ask" : policy.productionDeploy,
  shippingMode: "standard",
});

const assertReadablePolicyFile = (path: string): void => {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new SimpleChangesError(
      `Refusing to load a policy that is not a regular file: ${path}`,
      EXIT_CODES.unsafe
    );
  }
};

const parsePolicyFile = (path: string): RepoPolicy => {
  assertReadablePolicyFile(path);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const validated = validateSchema<StoredRepoPolicy>("repo-policy", parsed);
  return {
    ...validated,
    changelogHandling:
      validated.changelogHandling ?? DEFAULT_POLICY.changelogHandling,
    gitPushAuthorization:
      validated.gitPushAuthorization ?? DEFAULT_POLICY.gitPushAuthorization,
    guidance: {
      disposition: validated.guidance.disposition ?? "accepted",
      version: validated.guidance.version,
    },
    handoffTiming: validated.handoffTiming ?? DEFAULT_POLICY.handoffTiming,
    migrationHandling:
      validated.migrationHandling ?? DEFAULT_POLICY.migrationHandling,
    migrationTargets:
      validated.migrationTargets ?? DEFAULT_POLICY.migrationTargets,
    proposalScheduling:
      validated.proposalScheduling ?? DEFAULT_POLICY.proposalScheduling,
    proposalSignatures:
      validated.proposalSignatures ?? DEFAULT_POLICY.proposalSignatures,
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
      trust: "not-required",
      value: parsePolicyFile(personalPolicyPath),
    };
  }
  return {
    path: null,
    source: "default",
    trust: "not-required",
    value: DEFAULT_POLICY,
  };
};

const trustedRepositoryPolicy = (
  primaryCheckout: string,
  policyPath: string,
  commonGitDirectory: string | undefined
): boolean => {
  if (!commonGitDirectory) {
    return false;
  }
  const receiptPath = repositoryPolicyTrustPath(commonGitDirectory);
  if (!existsSync(receiptPath)) {
    return false;
  }
  try {
    assertReadablePolicyFile(receiptPath);
    if (process.platform !== "win32" && statSync(receiptPath).mode % 64 !== 0) {
      return false;
    }
    const receipt = JSON.parse(
      readFileSync(receiptPath, "utf8")
    ) as RepositoryPolicyTrustReceipt;
    return (
      receipt.schemaVersion === 1 &&
      Boolean(receipt.approvedBy.trim()) &&
      Boolean(receipt.reason.trim()) &&
      receipt.repository === realpathSync(primaryCheckout) &&
      receipt.policyPath === realpathSync(policyPath) &&
      receipt.policyDigest === sha256(readFileSync(policyPath, "utf8"))
    );
  } catch {
    return false;
  }
};

export const writeRepositoryPolicyTrustReceipt = (
  primaryCheckout: string,
  commonGitDirectory: string,
  approvedBy: string,
  reason: string
): string => {
  const policyPath = resolve(primaryCheckout, ".simple-changes.json");
  if (!(approvedBy.trim() && reason.trim())) {
    throw new SimpleChangesError(
      "Repository policy trust requires an approver and reason.",
      EXIT_CODES.usage
    );
  }
  if (!existsSync(policyPath)) {
    throw new SimpleChangesError(
      `Repository policy does not exist: ${policyPath}`,
      EXIT_CODES.validation
    );
  }
  assertReadablePolicyFile(policyPath);
  const receipt: RepositoryPolicyTrustReceipt = {
    approvedBy: approvedBy.trim(),
    createdAt: new Date().toISOString(),
    policyDigest: sha256(readFileSync(policyPath, "utf8")),
    policyPath: realpathSync(policyPath),
    reason: reason.trim(),
    repository: realpathSync(primaryCheckout),
    schemaVersion: 1,
  };
  const receiptPath = repositoryPolicyTrustPath(commonGitDirectory);
  mkdirSync(dirname(receiptPath), { mode: 0o700, recursive: true });
  if (existsSync(receiptPath)) {
    const status = lstatSync(receiptPath);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new SimpleChangesError(
        `Refusing to replace a policy trust receipt that is not a regular file: ${receiptPath}`,
        EXIT_CODES.unsafe
      );
    }
  }
  const temporaryPath = resolve(
    dirname(receiptPath),
    `.${randomUUID()}.policy-trust.tmp`
  );
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporaryPath, receiptPath);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
  return receiptPath;
};

export const loadPolicy = (
  primaryCheckout: string,
  options: LoadPolicyOptions = {}
): LoadedPolicy => {
  const policyPath = resolve(primaryCheckout, ".simple-changes.json");
  if (existsSync(policyPath)) {
    const value = parsePolicyFile(policyPath);
    const consequential = requiresRepositoryTrust(value);
    const trusted =
      !consequential ||
      trustedRepositoryPolicy(
        primaryCheckout,
        policyPath,
        options.commonGitDirectory
      );
    let trust: LoadedPolicy["trust"] = "not-required";
    if (consequential) {
      trust = trusted ? "trusted" : "untrusted";
    }
    return {
      path: policyPath,
      source: "repository",
      trust,
      value: trusted ? value : withoutUntrustedConsequentialAuthority(value),
    };
  }
  const personalPolicyPath =
    options.personalPolicyPath ?? resolvePersonalPolicyPath();
  return loadPersonalPolicy(personalPolicyPath);
};
