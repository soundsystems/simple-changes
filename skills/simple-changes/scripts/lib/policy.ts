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

const parsePolicyText = (text: string): RepoPolicy => {
  const parsed = JSON.parse(text) as unknown;
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

const parsePolicyFile = (path: string): RepoPolicy => {
  assertReadablePolicyFile(path);
  return parsePolicyText(readFileSync(path, "utf8"));
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

const replacePolicyFileText = (
  path: string,
  text: string,
  privateFile: boolean
): void => {
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
  writeFileSync(temporaryPath, text, {
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
};

export const writePolicyFile = (
  path: string,
  policy: RepoPolicy,
  privateFile = false
): void => {
  const validated = validateSchema<RepoPolicy>("repo-policy", policy);
  replacePolicyFileText(
    path,
    `${JSON.stringify(validated, null, 2)}\n`,
    privateFile
  );
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

/**
 * Setup rebuilds a policy from its answers and never asks about `execGuard`,
 * so a rewrite keeps the guard already saved in that same file, unchanged.
 */
export const withSavedExecGuard = (
  path: string,
  policy: RepoPolicy
): RepoPolicy => {
  if (!existsSync(path)) {
    return policy;
  }
  const { execGuard } = parsePolicyFile(path);
  return execGuard ? { ...policy, execGuard } : policy;
};

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const JSON_SCALAR_DELIMITERS = new Set([",", "}", "]", ...JSON_WHITESPACE]);

interface JsonMemberSpan {
  key: string;
  keyEnd: number;
  keyStart: number;
  valueEnd: number;
  valueStart: number;
}

interface TextEdit {
  end: number;
  start: number;
  text: string;
}

const unlocatedGuidance = (): SimpleChangesError =>
  new SimpleChangesError(
    "Cannot locate the guidance fields in the saved policy text; nothing was written.",
    EXIT_CODES.validation
  );

const skipJsonWhitespace = (text: string, start: number): number => {
  let cursor = start;
  while (JSON_WHITESPACE.has(text.charAt(cursor))) {
    cursor += 1;
  }
  return cursor;
};

const jsonStringEnd = (text: string, start: number): number => {
  if (text.charAt(start) !== '"') {
    throw unlocatedGuidance();
  }
  let cursor = start + 1;
  while (cursor < text.length) {
    const character = text.charAt(cursor);
    if (character === '"') {
      return cursor + 1;
    }
    cursor += character === "\\" ? 2 : 1;
  }
  throw unlocatedGuidance();
};

const jsonContainerEnd = (text: string, start: number): number => {
  let depth = 0;
  let cursor = start;
  while (cursor < text.length) {
    const character = text.charAt(cursor);
    if (character === '"') {
      cursor = jsonStringEnd(text, cursor);
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  throw unlocatedGuidance();
};

const jsonValueEnd = (text: string, start: number): number => {
  const opening = text.charAt(start);
  if (opening === '"') {
    return jsonStringEnd(text, start);
  }
  if (opening === "{" || opening === "[") {
    return jsonContainerEnd(text, start);
  }
  let cursor = start;
  while (
    cursor < text.length &&
    !JSON_SCALAR_DELIMITERS.has(text.charAt(cursor))
  ) {
    cursor += 1;
  }
  if (cursor === start) {
    throw unlocatedGuidance();
  }
  return cursor;
};

/** Source spans of each member of the JSON object that opens at `start`. */
const jsonObjectMembers = (text: string, start: number): JsonMemberSpan[] => {
  if (text.charAt(start) !== "{") {
    throw unlocatedGuidance();
  }
  const members: JsonMemberSpan[] = [];
  let cursor = skipJsonWhitespace(text, start + 1);
  if (text.charAt(cursor) === "}") {
    return members;
  }
  while (cursor < text.length) {
    const keyStart = cursor;
    const keyEnd = jsonStringEnd(text, keyStart);
    const colon = skipJsonWhitespace(text, keyEnd);
    if (text.charAt(colon) !== ":") {
      throw unlocatedGuidance();
    }
    const valueStart = skipJsonWhitespace(text, colon + 1);
    const valueEnd = jsonValueEnd(text, valueStart);
    members.push({
      key: JSON.parse(text.slice(keyStart, keyEnd)) as string,
      keyEnd,
      keyStart,
      valueEnd,
      valueStart,
    });
    const separator = skipJsonWhitespace(text, valueEnd);
    if (text.charAt(separator) === "}") {
      return members;
    }
    if (text.charAt(separator) !== ",") {
      throw unlocatedGuidance();
    }
    cursor = skipJsonWhitespace(text, separator + 1);
  }
  throw unlocatedGuidance();
};

// JSON.parse keeps the last duplicate, so edit the member it actually reads.
const lastJsonMember = (
  members: JsonMemberSpan[],
  key: string
): JsonMemberSpan | undefined =>
  members.filter((member) => member.key === key).at(-1);

const applyTextEdits = (text: string, edits: TextEdit[]): string =>
  [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, edit) =>
        `${current.slice(0, edit.start)}${edit.text}${current.slice(edit.end)}`,
      text
    );

// A missing `disposition` goes before the first guidance member in the
// object's own spacing: its line break and indent when it spans lines,
// otherwise the space style of its `key: value` separator.
const dispositionInsertion = (
  text: string,
  guidanceStart: number,
  firstMember: JsonMemberSpan,
  version: JsonMemberSpan,
  dispositionText: string
): TextEdit => {
  const keySeparator = text.slice(version.keyEnd, version.valueStart);
  const leading = text.slice(guidanceStart + 1, firstMember.keyStart);
  const memberSeparator = leading || (keySeparator.endsWith(" ") ? " " : "");
  return {
    end: firstMember.keyStart,
    start: firstMember.keyStart,
    text: `"disposition"${keySeparator}${dispositionText},${memberSeparator}`,
  };
};

const expectedAcknowledgedPolicy = (
  saved: Record<string, unknown>,
  guidance: RepoPolicy["guidance"]
): Record<string, unknown> => {
  const savedGuidance = saved.guidance as Record<string, unknown>;
  return {
    ...saved,
    guidance: Object.hasOwn(savedGuidance, "disposition")
      ? { ...savedGuidance, ...guidance }
      : {
          disposition: guidance.disposition,
          ...savedGuidance,
          version: guidance.version,
        },
  };
};

/**
 * Returns saved policy `text` with only the `guidance` member's `disposition`
 * and `version` values replaced, the bytes a careful hand edit would produce.
 * Every other byte is kept, including key order, formatting, and settings an
 * untrusted repository policy cannot exercise on this clone. It throws unless
 * the result parses to the saved object with only those two values changed.
 */
export const withAcknowledgedGuidanceText = (
  text: string,
  guidance: RepoPolicy["guidance"]
): string => {
  const saved = JSON.parse(text) as Record<string, unknown>;
  const guidanceMember = lastJsonMember(
    jsonObjectMembers(text, skipJsonWhitespace(text, 0)),
    "guidance"
  );
  if (!guidanceMember) {
    throw unlocatedGuidance();
  }
  const guidanceMembers = jsonObjectMembers(text, guidanceMember.valueStart);
  const version = lastJsonMember(guidanceMembers, "version");
  const disposition = lastJsonMember(guidanceMembers, "disposition");
  const [firstMember] = guidanceMembers;
  if (!(version && firstMember)) {
    throw unlocatedGuidance();
  }
  const dispositionText = JSON.stringify(guidance.disposition);
  const edits: TextEdit[] = [
    {
      end: version.valueEnd,
      start: version.valueStart,
      text: String(guidance.version),
    },
    disposition
      ? {
          end: disposition.valueEnd,
          start: disposition.valueStart,
          text: dispositionText,
        }
      : dispositionInsertion(
          text,
          guidanceMember.valueStart,
          firstMember,
          version,
          dispositionText
        ),
  ];
  const edited = applyTextEdits(text, edits);
  if (
    JSON.stringify(JSON.parse(edited)) !==
    JSON.stringify(expectedAcknowledgedPolicy(saved, guidance))
  ) {
    throw unlocatedGuidance();
  }
  return edited;
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

// `policyText` checks candidate bytes for `policyPath` before they are written.
const trustedRepositoryPolicy = (
  primaryCheckout: string,
  policyPath: string,
  commonGitDirectory: string | undefined,
  policyText?: string
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
      receipt.policyDigest ===
        sha256(policyText ?? readFileSync(policyPath, "utf8"))
    );
  } catch {
    return false;
  }
};

const repositoryPolicyTrust = (
  value: RepoPolicy,
  primaryCheckout: string,
  policyPath: string,
  commonGitDirectory: string | undefined,
  policyText?: string
): LoadedPolicy["trust"] => {
  if (!requiresRepositoryTrust(value)) {
    return "not-required";
  }
  return trustedRepositoryPolicy(
    primaryCheckout,
    policyPath,
    commonGitDirectory,
    policyText
  )
    ? "trusted"
    : "untrusted";
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

/** Where an acknowledgement is saved, and where a repository's receipt lives. */
export type GuidanceAcknowledgementTarget =
  | { source: "user" }
  | {
      commonGitDirectory: string;
      primaryCheckout: string;
      source: "repository";
    };

// Only setup may lift reduced authority. A guidance edit that restores the
// exact bytes a still-present receipt confirmed would re-enable consequential
// settings without confirmation, so the edit is checked before it is written.
const acknowledgementRaisesTrust = (
  path: string,
  text: string,
  edited: string,
  target: Extract<GuidanceAcknowledgementTarget, { source: "repository" }>
): boolean => {
  const trustOf = (policyText: string): LoadedPolicy["trust"] =>
    repositoryPolicyTrust(
      parsePolicyText(policyText),
      target.primaryCheckout,
      path,
      target.commonGitDirectory,
      policyText
    );
  return trustOf(text) !== "trusted" && trustOf(edited) === "trusted";
};

/**
 * Records a guidance acknowledgement in the saved policy file itself. The
 * loaded policy is default-filled and, for an unconfirmed repository policy,
 * trust-reduced, so it is never written back: only the guidance values change.
 * This neither creates nor renews a repository trust receipt; changing the
 * bytes leaves an existing receipt unmatched, exactly as any other edit does.
 * An edit that would instead make a stale receipt match again, raising an
 * unconfirmed repository policy to trusted, is refused with nothing written.
 */
export const writeGuidanceAcknowledgement = (
  path: string,
  guidance: RepoPolicy["guidance"],
  target: GuidanceAcknowledgementTarget
): void => {
  assertReadablePolicyFile(path);
  const saved = readFileSync(path);
  const text = saved.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(saved)) {
    throw new SimpleChangesError(
      `Refusing to rewrite a policy that is not valid UTF-8: ${path}`,
      EXIT_CODES.validation
    );
  }
  const edited = withAcknowledgedGuidanceText(text, guidance);
  parsePolicyText(edited);
  if (
    target.source === "repository" &&
    acknowledgementRaisesTrust(path, text, edited, target)
  ) {
    throw new SimpleChangesError(
      `Refusing to acknowledge the guidance update in ${path}: the result would match the trust receipt of an earlier copy of this policy and re-enable its consequential settings without confirmation. Nothing was written. Run \`simple-changes setup\` to confirm this repository policy; setup also records the current guidance.`,
      EXIT_CODES.unsafe
    );
  }
  replacePolicyFileText(path, edited, target.source === "user");
  if (readFileSync(path, "utf8") !== edited) {
    throw new SimpleChangesError(
      `Policy verification failed after writing: ${path}`,
      EXIT_CODES.validation
    );
  }
};

export const loadPolicy = (
  primaryCheckout: string,
  options: LoadPolicyOptions = {}
): LoadedPolicy => {
  const policyPath = resolve(primaryCheckout, ".simple-changes.json");
  if (existsSync(policyPath)) {
    const value = parsePolicyFile(policyPath);
    const trust = repositoryPolicyTrust(
      value,
      primaryCheckout,
      policyPath,
      options.commonGitDirectory
    );
    return {
      path: policyPath,
      source: "repository",
      trust,
      value:
        trust === "untrusted"
          ? withoutUntrustedConsequentialAuthority(value)
          : value,
    };
  }
  const personalPolicyPath =
    options.personalPolicyPath ?? resolvePersonalPolicyPath();
  return loadPersonalPolicy(personalPolicyPath);
};
