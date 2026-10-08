import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  currentHarnessSession,
  SESSION_HARNESS_IDS,
} from "./harness-session.ts";
import { resolvePersonalPolicyPath } from "./policy.ts";

// Authoring and review preferences: which agent and model should write each
// kind of text, recorded per coding harness in a sidecar beside the policy.
// The sidecar is a preference, never authority or identity. It never joins
// the policy file (whose closed schema older copies enforce), stores no model
// list and no launch mechanics, and names no harness: the harnesses this
// package knows, and how to detect them, are data in agents/harnesses.json.

export type AuthoringEffort = "low" | "medium" | "high" | "xhigh" | "max";
// `request`: the current request (`--authoring-request`), applied for one
// invocation and never written.
export type AuthoringLayer = "request" | "repository" | "personal" | "default";
export type AuthoringRoleId = "proposals" | "review";
export type AuthoringQuestionState =
  | "pending"
  | "answered"
  | "repair"
  | "not-applicable";
export type AuthoringSetupStyle =
  | "recommended"
  | "walkthrough"
  | "customize"
  | "run";

export const EFFORT_LEVELS: readonly AuthoringEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const DEFAULT_EFFORT: AuthoringEffort = "xhigh";
export const MOST_CAPABLE = "most-capable";
export const RUNNING_HARNESS = "running";
export const UNKNOWN_HARNESS = "unknown";
export const REPOSITORY_AUTHORING_FILENAME = ".simple-changes-authoring.json";
export const CHANGELOGS_REPOSITORY_AUTHORING_FILENAME =
  ".simple-changelogs-authoring.json";
const PERSONAL_AUTHORING_FILENAME = "authoring.json";
const ROLE_IDS: readonly AuthoringRoleId[] = ["proposals", "review"];
const CHANGELOGS_ROLE_IDS = ["release-notes"] as const;
const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const MODEL_MAX_LENGTH = 120;
// A relative path: no leading separator or drive letter and no `..` segment.
const HOME_ROOT = /^(?![/\\])(?![A-Za-z]:)(?!(?:.*[/\\])?\.\.(?:[/\\]|$)).+$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const HARNESS_NAME_MAX_LENGTH = 60;
const ESCALATION_LEVELS = ["high", "xhigh"] as const;
const MODEL_KEY_SEPARATORS = /[^a-z0-9]+/gu;

type Environment = Record<string, string | undefined>;

export interface AuthoringHarnessEntry {
  effort?: AuthoringEffort;
  model: string;
}

export interface AuthoringRoleEntry {
  adversarial?: boolean;
  effort?: AuthoringEffort;
  escalateOnFindings?: "high" | "xhigh" | null;
  harness: string;
  model?: string;
}

export interface AuthoringSidecar {
  harnesses: Record<string, AuthoringHarnessEntry | null>;
  roles: Record<string, AuthoringRoleEntry>;
  schemaVersion: 1;
}

export interface AuthoringFileState {
  errors: string[];
  path: string;
  state: "absent" | "valid" | "malformed";
  value?: AuthoringSidecar;
}

export interface HarnessDefinition {
  homeRoots: string[];
  id: string;
  name: string;
  sessionEnv: string[];
}

export interface DetectedHarness {
  evidence: string[];
  id: string;
  name: string;
}

export interface ResolvedAuthoringRole {
  effort: AuthoringEffort;
  // A concrete harness id, or "unknown" when the role targets the running
  // harness and it cannot be identified.
  harness: string;
  // A model name or the "most-capable" sentinel, which the agent resolves at
  // run time from what the target harness reports; scripts never rank models.
  model: string;
  status: "resolved" | "most-capable" | "unresolved" | "no-delegation";
}

export interface ResolvedReviewRole extends ResolvedAuthoringRole {
  adversarial: boolean;
  escalateOnFindings: "high" | "xhigh" | null;
}

export interface AuthoringFieldSource {
  effort: AuthoringLayer;
  harness: AuthoringLayer;
  model: AuthoringLayer;
  // The file of the highest file layer that supplied any of the role's
  // fields, or null when every field is the built-in default or the request.
  path: string | null;
}

// The review role's gate fields can come from a lower layer than the rest of
// the role: a request only tightens them (design 2.3 rule 6).
export interface AuthoringReviewFieldSource extends AuthoringFieldSource {
  adversarial: AuthoringLayer;
  escalateOnFindings: AuthoringLayer;
}

export interface RepositoryAuthoring {
  authoringFiles: {
    personal: AuthoringFileState;
    repository: AuthoringFileState;
  };
  authoringQuestion: {
    models: AuthoringQuestionState;
    review: AuthoringQuestionState;
  };
  detectedHarnesses: DetectedHarness[];
  effective: { proposals: ResolvedAuthoringRole; review: ResolvedReviewRole };
  // Set when the harness data file is missing or malformed: detection then
  // reports nothing and sidecar writes are refused.
  harnessDataError: string | null;
  // True when either sidecar exists but is malformed. Fail closed: a review
  // that depends on the review role is never accepted until it is repaired.
  repairRequired: boolean;
  runningHarness: string | null;
  source: {
    proposals: AuthoringFieldSource;
    review: AuthoringReviewFieldSource;
  };
}

// C0 controls (newlines included), DEL, and C1 controls.
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEffort = (value: unknown): value is AuthoringEffort =>
  typeof value === "string" &&
  (EFFORT_LEVELS as readonly string[]).includes(value);

export const isHarnessId = (value: unknown): value is string =>
  typeof value === "string" && HARNESS_ID_PATTERN.test(value);

// Lengths count Unicode characters (code points), as JSON Schema does.
const characterCount = (value: string): number => [...value].length;

export const isModelName = (value: unknown): value is string =>
  typeof value === "string" &&
  characterCount(value) >= 1 &&
  characterCount(value) <= MODEL_MAX_LENGTH &&
  !hasControlCharacter(value);

const modelKey = (value: string): string =>
  value.toLowerCase().replace(MODEL_KEY_SEPARATORS, "");

/**
 * Whether two reported model names may name the same model. Harnesses report
 * names in different shapes (a display name with a family prefix, or an id
 * with hyphens), so names compare case-insensitively without separators, and
 * a name that ends with the other counts as the same. This heuristic fails
 * toward "same": a possible match never passes a diversity check.
 */
export const sameModelName = (left: string, right: string): boolean => {
  const leftKey = modelKey(left);
  const rightKey = modelKey(right);
  if (!(leftKey && rightKey)) {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
  }
  return (
    leftKey === rightKey ||
    leftKey.endsWith(rightKey) ||
    rightKey.endsWith(leftKey)
  );
};

/** The higher of two effort levels on the shared ladder. */
export const higherEffort = (
  left: AuthoringEffort,
  right: AuthoringEffort
): AuthoringEffort =>
  EFFORT_LEVELS.indexOf(left) >= EFFORT_LEVELS.indexOf(right) ? left : right;

const unknownKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): string[] =>
  Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${path}.${key} is not allowed`);

const missingKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  path: string
): string[] =>
  required
    .filter((key) => !Object.hasOwn(value, key))
    .map((key) => `${path}.${key} is required`);

const modelErrors = (value: unknown, path: string): string[] =>
  isModelName(value)
    ? []
    : [
        `${path} must be a model name of 1 to ${MODEL_MAX_LENGTH} characters without control characters`,
      ];

const effortErrors = (value: unknown, path: string): string[] =>
  value === undefined || isEffort(value)
    ? []
    : [`${path} must be one of ${EFFORT_LEVELS.join(", ")}`];

const roleErrors = (
  role: string,
  value: unknown,
  reviewFlags: boolean
): string[] => {
  const path = `roles.${role}`;
  if (!isRecord(value)) {
    return [`${path} must be an object`];
  }
  const review = reviewFlags && role === "review";
  const errors = [
    ...missingKeys(value, ["harness"], path),
    ...unknownKeys(
      value,
      review
        ? ["harness", "model", "effort", "adversarial", "escalateOnFindings"]
        : ["harness", "model", "effort"],
      path
    ),
  ];
  const { harness } = value;
  if (
    Object.hasOwn(value, "harness") &&
    !(harness === RUNNING_HARNESS || isHarnessId(harness))
  ) {
    errors.push(`${path}.harness must be "running" or a harness id`);
  }
  if (Object.hasOwn(value, "model")) {
    errors.push(...modelErrors(value.model, `${path}.model`));
    if (harness === RUNNING_HARNESS) {
      errors.push(
        `${path}.model requires a concrete harness id, never "running"`
      );
    }
  }
  errors.push(...effortErrors(value.effort, `${path}.effort`));
  if (
    review &&
    value.adversarial !== undefined &&
    typeof value.adversarial !== "boolean"
  ) {
    errors.push(`${path}.adversarial must be true or false`);
  }
  if (
    review &&
    Object.hasOwn(value, "escalateOnFindings") &&
    value.escalateOnFindings !== null &&
    !(ESCALATION_LEVELS as readonly unknown[]).includes(
      value.escalateOnFindings
    )
  ) {
    errors.push(`${path}.escalateOnFindings must be high, xhigh, or null`);
  }
  return errors;
};

const harnessEntryErrors = (id: string, value: unknown): string[] => {
  const path = `harnesses.${id}`;
  const errors = isHarnessId(id)
    ? []
    : [`${path} is not a harness id (${HARNESS_ID_PATTERN.source})`];
  if (value === null) {
    return errors;
  }
  if (!isRecord(value)) {
    return [...errors, `${path} must be null or an object`];
  }
  errors.push(
    ...missingKeys(value, ["model"], path),
    ...unknownKeys(value, ["model", "effort"], path)
  );
  if (Object.hasOwn(value, "model")) {
    errors.push(...modelErrors(value.model, `${path}.model`));
  }
  errors.push(...effortErrors(value.effort, `${path}.effort`));
  return errors;
};

const rolesErrors = (
  value: Record<string, unknown>,
  roleIds: readonly string[],
  skill: "simple-changes" | "simple-changelogs"
): string[] => {
  if (!Object.hasOwn(value, "roles")) {
    return [];
  }
  if (!isRecord(value.roles)) {
    return ["sidecar.roles must be an object"];
  }
  return Object.entries(value.roles).flatMap(([role, entry]) =>
    roleIds.includes(role)
      ? roleErrors(role, entry, skill === "simple-changes")
      : [`roles.${role} is not a role of ${skill} (${roleIds.join(", ")})`]
  );
};

const harnessesErrors = (value: Record<string, unknown>): string[] => {
  if (!Object.hasOwn(value, "harnesses")) {
    return [];
  }
  if (!isRecord(value.harnesses)) {
    return ["sidecar.harnesses must be an object"];
  }
  return Object.entries(value.harnesses).flatMap(([id, entry]) =>
    harnessEntryErrors(id, entry)
  );
};

/**
 * Validates one sidecar on its own (section 6.3 of the design): exact keys at
 * every level, closed role ids for the skill, harness ids by pattern, model
 * shape only, the effort enum (an explicitly chosen `max` included), and the
 * review-only flags. Every error names its path.
 */
export const validateAuthoringSidecar = (
  value: unknown,
  skill: "simple-changes" | "simple-changelogs" = "simple-changes"
): { errors: string[]; value?: AuthoringSidecar } => {
  if (!isRecord(value)) {
    return { errors: ["The authoring sidecar must be a JSON object"] };
  }
  const roleIds: readonly string[] =
    skill === "simple-changes" ? ROLE_IDS : CHANGELOGS_ROLE_IDS;
  const errors = [
    ...missingKeys(value, ["schemaVersion", "roles", "harnesses"], "sidecar"),
    ...unknownKeys(value, ["schemaVersion", "roles", "harnesses"], "sidecar"),
  ];
  if (Object.hasOwn(value, "schemaVersion") && value.schemaVersion !== 1) {
    errors.push("sidecar.schemaVersion must be 1");
  }
  errors.push(...rolesErrors(value, roleIds, skill), ...harnessesErrors(value));
  return errors.length === 0
    ? { errors, value: value as unknown as AuthoringSidecar }
    : { errors };
};

/** Reads and validates one sidecar; a symlink or other non-file is malformed. */
export const readAuthoringFile = (
  path: string,
  skill: "simple-changes" | "simple-changelogs" = "simple-changes"
): AuthoringFileState => {
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { errors: [], path, state: "absent" };
    }
    return {
      errors: [`Could not inspect ${path}: ${(error as Error).message}`],
      path,
      state: "malformed",
    };
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    return {
      errors: [`${path} must be a regular file, not a symlink or directory`],
      path,
      state: "malformed",
    };
  }
  try {
    const result = validateAuthoringSidecar(
      JSON.parse(readFileSync(path, "utf8")),
      skill
    );
    return result.value
      ? { errors: [], path, state: "valid", value: result.value }
      : { errors: result.errors, path, state: "malformed" };
  } catch (error) {
    return {
      errors: [`Could not parse ${path}: ${(error as Error).message}`],
      path,
      state: "malformed",
    };
  }
};

const packagedHarnessDataPath = (): string =>
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "agents",
    "harnesses.json"
  );

const harnessDefinitionErrors = (id: string, value: unknown): string[] => {
  const path = `harnesses.${id}`;
  if (!isHarnessId(id)) {
    return [`${path} is not a harness id`];
  }
  if (!isRecord(value)) {
    return [`${path} must be an object`];
  }
  const errors = [
    ...missingKeys(value, ["name", "homeRoots", "sessionEnv"], path),
    ...unknownKeys(value, ["name", "homeRoots", "sessionEnv"], path),
  ];
  if (
    !(
      typeof value.name === "string" &&
      characterCount(value.name) >= 1 &&
      characterCount(value.name) <= HARNESS_NAME_MAX_LENGTH &&
      !hasControlCharacter(value.name)
    )
  ) {
    errors.push(
      `${path}.name must be 1 to ${HARNESS_NAME_MAX_LENGTH} characters`
    );
  }
  if (
    !(
      Array.isArray(value.homeRoots) &&
      new Set(value.homeRoots).size === value.homeRoots.length &&
      value.homeRoots.every(
        (root) => typeof root === "string" && HOME_ROOT.test(root)
      )
    )
  ) {
    errors.push(`${path}.homeRoots must be distinct relative paths without ..`);
  }
  if (
    !(
      Array.isArray(value.sessionEnv) &&
      new Set(value.sessionEnv).size === value.sessionEnv.length &&
      value.sessionEnv.every(
        (name) =>
          typeof name === "string" && ENVIRONMENT_NAME_PATTERN.test(name)
      )
    )
  ) {
    errors.push(
      `${path}.sessionEnv must list distinct environment variable names`
    );
  }
  return errors;
};

/**
 * Reads the packaged harness data file. It fails closed: a missing or
 * malformed file throws a clear error instead of returning partial data.
 */
export const loadHarnessDefinitions = (
  path: string = packagedHarnessDataPath()
): HarnessDefinition[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw SimpleChangesError.withCause(
      `The harness data file ${path} is missing or unreadable; reinstall the package.`,
      EXIT_CODES.validation,
      error
    );
  }
  const errors: string[] = [];
  if (
    isRecord(parsed) &&
    parsed.schemaVersion === 1 &&
    isRecord(parsed.harnesses) &&
    Object.keys(parsed).every((key) =>
      ["schemaVersion", "harnesses"].includes(key)
    )
  ) {
    for (const [id, value] of Object.entries(parsed.harnesses)) {
      errors.push(...harnessDefinitionErrors(id, value));
    }
  } else {
    errors.push("it must contain exactly schemaVersion 1 and harnesses");
  }
  if (errors.length > 0 || !isRecord(parsed) || !isRecord(parsed.harnesses)) {
    throw new SimpleChangesError(
      `The harness data file ${path} is malformed: ${errors.join("; ")}`,
      EXIT_CODES.validation
    );
  }
  return Object.entries(parsed.harnesses).map(([id, value]) => {
    const entry = value as Omit<HarnessDefinition, "id">;
    return {
      homeRoots: entry.homeRoots,
      id,
      name: entry.name,
      sessionEnv: entry.sessionEnv,
    };
  });
};

/**
 * The running harness: the session adapter decides for the harnesses it
 * integrates with, and the data file's session variables identify any other.
 * Null when nothing identifies it.
 */
export const runningHarnessFrom = (
  definitions: HarnessDefinition[],
  environment: Environment = process.env
): string | null => {
  const session = currentHarnessSession(environment);
  if (session) {
    return session.harness;
  }
  const other = definitions.find(
    (definition) =>
      !SESSION_HARNESS_IDS.includes(definition.id) &&
      definition.sessionEnv.some((name) => Boolean(environment[name]?.trim()))
  );
  return other?.id ?? null;
};

/**
 * Read-only detection: the running harness from its session variables, then
 * existence of each data-file home root (nothing inside is read). Tests and
 * automation point the home roots elsewhere with SIMPLE_CHANGES_HARNESS_ROOTS.
 * No network, process list, or other tool's configuration is consulted.
 */
export const detectHarnesses = (
  definitions: HarnessDefinition[],
  options: { environment?: Environment; homeDirectory?: string } = {}
): { detected: DetectedHarness[]; running: string | null } => {
  const environment = options.environment ?? process.env;
  const override = environment.SIMPLE_CHANGES_HARNESS_ROOTS?.trim();
  const base = override
    ? resolve(override)
    : (options.homeDirectory ?? homedir());
  const running = runningHarnessFrom(definitions, environment);
  const detected: DetectedHarness[] = [];
  for (const definition of definitions) {
    const evidence: string[] = [];
    if (definition.id === running) {
      const variable = definition.sessionEnv.find((name) =>
        Boolean(environment[name]?.trim())
      );
      evidence.push(
        variable ? `running session (${variable})` : "running session"
      );
    }
    for (const root of definition.homeRoots) {
      if (existsSync(join(base, root))) {
        evidence.push(
          override
            ? `harness root (${join(base, root)})`
            : `home directory (~/${root})`
        );
      }
    }
    if (evidence.length > 0) {
      detected.push({ evidence, id: definition.id, name: definition.name });
    }
  }
  return { detected, running };
};

/** Both sidecar paths: the repository file and the personal file. */
export const authoringPaths = (
  primaryCheckout: string,
  options: {
    environment?: Environment;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {}
): { personal: string; repository: string } => ({
  personal: join(
    dirname(resolvePersonalPolicyPath(options)),
    PERSONAL_AUTHORING_FILENAME
  ),
  repository: resolve(primaryCheckout, REPOSITORY_AUTHORING_FILENAME),
});

/**
 * The Simple Changelogs personal sidecar, by that skill's own resolver: an
 * override directory holds the file directly; otherwise the platform
 * configuration directory plus `simple-changelogs/authoring.json`.
 */
export const changelogsPersonalAuthoringPath = (
  options: {
    environment?: Environment;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {}
): string => {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const override = environment.SIMPLE_CHANGELOGS_CONFIG_DIR;
  if (override) {
    return join(resolve(override), PERSONAL_AUTHORING_FILENAME);
  }
  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "simple-changelogs",
      PERSONAL_AUTHORING_FILENAME
    );
  }
  if (platform === "win32") {
    return join(
      environment.APPDATA ?? join(home, "AppData", "Roaming"),
      "simple-changelogs",
      PERSONAL_AUTHORING_FILENAME
    );
  }
  return join(
    environment.XDG_CONFIG_HOME ?? join(home, ".config"),
    "simple-changelogs",
    PERSONAL_AUTHORING_FILENAME
  );
};

/**
 * The harness list a Simple Changelogs sidecar already records, for the
 * onboarding pre-fill: the repository sidecar first, then the personal one.
 * Optional and read-only; a missing or malformed file counts as absent and
 * imports no authority.
 */
export const changelogsHarnessPrefill = (
  primaryCheckout: string | null,
  options: {
    environment?: Environment;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {}
): { harnesses: string[]; path: string } | null => {
  const candidates = [
    ...(primaryCheckout
      ? [resolve(primaryCheckout, CHANGELOGS_REPOSITORY_AUTHORING_FILENAME)]
      : []),
    changelogsPersonalAuthoringPath(options),
  ];
  for (const path of candidates) {
    const file = readAuthoringFile(path, "simple-changelogs");
    const harnesses = Object.keys(file.value?.harnesses ?? {});
    if (file.state === "valid" && harnesses.length > 0) {
      return { harnesses, path };
    }
  }
  return null;
};

interface Layer {
  layer: Exclude<AuthoringLayer, "default">;
  // null for the request layer, which comes from no file.
  path: string | null;
  value: AuthoringSidecar;
}

const validLayers = (
  repository: AuthoringFileState,
  personal: AuthoringFileState
): Layer[] =>
  [
    { file: repository, layer: "repository" as const },
    { file: personal, layer: "personal" as const },
  ].flatMap(({ file, layer }) =>
    file.state === "valid" && file.value
      ? [{ layer, path: file.path, value: file.value }]
      : []
  );

interface SourceRef {
  layer: AuthoringLayer;
  path: string | null;
}

const DEFAULT_SOURCE: SourceRef = { layer: "default", path: null };

const LAYER_RANK: Record<AuthoringLayer, number> = {
  default: 0,
  personal: 1,
  repository: 2,
  request: 3,
};

// The file of the highest file layer among the sources; the request layer
// has no file and never hides the file below it.
const highestPath = (sources: SourceRef[]): string | null =>
  sources.reduce(
    (best, candidate) =>
      candidate.path !== null &&
      LAYER_RANK[candidate.layer] > LAYER_RANK[best.layer]
        ? candidate
        : best,
    DEFAULT_SOURCE
  ).path;

const FLOOR_RANK = { high: 1, null: 0, xhigh: 2 } as const;

const floorRank = (floor: "high" | "xhigh" | null): number =>
  FLOOR_RANK[floor ?? "null"];

/**
 * Section 2.3 resolution. Roles replace whole and harness entries replace
 * whole, per id, at the highest layer that defines them; `running` resolves
 * to the running harness (or `unknown`); the model and effort come from the
 * role, else the target's entry, else `most-capable` at `xhigh`; a `null`
 * entry means no delegation. Every field reports its layer.
 */
export const resolveAuthoringRole = (
  role: AuthoringRoleId,
  layers: Layer[],
  runningHarness: string | null
): { effective: ResolvedReviewRole; source: AuthoringReviewFieldSource } => {
  const roleLayer = layers.find((layer) =>
    Object.hasOwn(layer.value.roles, role)
  );
  const entry: AuthoringRoleEntry = roleLayer?.value.roles[role] ?? {
    harness: RUNNING_HARNESS,
  };
  const roleSource: SourceRef = roleLayer
    ? { layer: roleLayer.layer, path: roleLayer.path }
    : DEFAULT_SOURCE;
  // null when the role targets the running harness and nothing identifies
  // it; a concrete id (even one spelled "unknown") is always looked up.
  const target =
    entry.harness === RUNNING_HARNESS ? runningHarness : entry.harness;
  const harness = target ?? UNKNOWN_HARNESS;
  const harnessLayer =
    target === null
      ? undefined
      : layers.find((layer) => Object.hasOwn(layer.value.harnesses, target));
  // undefined: no layer defines the id; null: "do not guide this harness".
  const harnessEntry =
    target === null ? undefined : harnessLayer?.value.harnesses[target];
  const harnessSource: SourceRef = harnessLayer
    ? { layer: harnessLayer.layer, path: harnessLayer.path }
    : DEFAULT_SOURCE;
  let modelSource = DEFAULT_SOURCE;
  if (entry.model !== undefined) {
    modelSource = roleSource;
  } else if (harnessEntry !== undefined) {
    modelSource = harnessSource;
  }
  let effortSource = DEFAULT_SOURCE;
  if (entry.effort !== undefined) {
    effortSource = roleSource;
  } else if (harnessEntry === null || harnessEntry?.effort !== undefined) {
    effortSource = harnessSource;
  }
  const model = entry.model ?? harnessEntry?.model ?? MOST_CAPABLE;
  let status: ResolvedAuthoringRole["status"] = "resolved";
  if (target === null) {
    status = "unresolved";
  } else if (harnessEntry === null) {
    status = "no-delegation";
  } else if (model === MOST_CAPABLE) {
    status = "most-capable";
  }
  const effective: ResolvedReviewRole = {
    adversarial: entry.adversarial ?? false,
    effort: entry.effort ?? harnessEntry?.effort ?? DEFAULT_EFFORT,
    escalateOnFindings: entry.escalateOnFindings ?? null,
    harness,
    model,
    status,
  };
  return {
    effective,
    source: {
      adversarial: roleSource.layer,
      effort: effortSource.layer,
      escalateOnFindings: roleSource.layer,
      harness: roleSource.layer,
      model: modelSource.layer,
      path: highestPath([effortSource, roleSource, modelSource]),
    },
  };
};

/**
 * Resolves one role over the file layers (rules 1 to 4), then applies the
 * request layer (design 2.3 rule 6): the request supplies the role and
 * harness entries like any other layer, except that `adversarial` and
 * `escalateOnFindings` take the stricter of the request's value and the
 * saved resolution's value. A request can therefore tighten the review gate
 * for one invocation and never loosen a saved setting; the provenance of
 * those two fields names the layer whose value is in force.
 */
export const resolveRequestedRole = (
  role: AuthoringRoleId,
  fileLayers: Layer[],
  request: AuthoringSidecar | null,
  runningHarness: string | null
): { effective: ResolvedReviewRole; source: AuthoringReviewFieldSource } => {
  const saved = resolveAuthoringRole(role, fileLayers, runningHarness);
  if (!request) {
    return saved;
  }
  const requested = resolveAuthoringRole(
    role,
    [{ layer: "request", path: null, value: request }, ...fileLayers],
    runningHarness
  );
  const requestRole = Object.hasOwn(request.roles, role)
    ? request.roles[role]
    : undefined;
  const loosensAdversarial =
    saved.effective.adversarial && !requested.effective.adversarial;
  const loosensFloor =
    floorRank(requested.effective.escalateOnFindings) <
    floorRank(saved.effective.escalateOnFindings);
  // A gate field the request leaves out, or would loosen, stays the saved
  // value with the saved layer's provenance.
  const keepsAdversarial =
    loosensAdversarial || requestRole?.adversarial === undefined;
  const keepsFloor =
    loosensFloor || requestRole?.escalateOnFindings === undefined;
  return {
    effective: {
      ...requested.effective,
      adversarial:
        requested.effective.adversarial || saved.effective.adversarial,
      escalateOnFindings: loosensFloor
        ? saved.effective.escalateOnFindings
        : requested.effective.escalateOnFindings,
    },
    source: {
      ...requested.source,
      adversarial: keepsAdversarial
        ? saved.source.adversarial
        : requested.source.adversarial,
      escalateOnFindings: keepsFloor
        ? saved.source.escalateOnFindings
        : requested.source.escalateOnFindings,
      // A gate field kept from a saved file names that file too.
      path:
        requested.source.path ??
        (keepsAdversarial || keepsFloor ? saved.source.path : null),
    },
  };
};

/**
 * The 5.1.4 truth table, from validated sidecar contents and current
 * detection only, never from the guidance acknowledgement. Read-only and
 * preservation-only requests are not applicable. The review question follows
 * its own trigger: always pending with two or more detected harnesses, and
 * otherwise only in Customize and the walkthrough.
 */
export const authoringQuestionState = (input: {
  detectedCount: number;
  personal: AuthoringFileState;
  repository: AuthoringFileState;
  setupStyle?: AuthoringSetupStyle;
  writeCapable: boolean;
}): { models: AuthoringQuestionState; review: AuthoringQuestionState } => {
  if (!input.writeCapable) {
    return { models: "not-applicable", review: "not-applicable" };
  }
  const files = [input.repository, input.personal];
  if (files.some((file) => file.state === "malformed")) {
    return { models: "repair", review: "repair" };
  }
  const valid = files.filter((file) => file.state === "valid");
  const models = valid.length > 0 ? "answered" : "pending";
  if (
    valid.some(
      (file) => file.value && Object.hasOwn(file.value.roles, "review")
    )
  ) {
    return { models, review: "answered" };
  }
  const asksInStyle =
    input.setupStyle === "customize" || input.setupStyle === "walkthrough";
  return {
    models,
    review:
      input.detectedCount >= 2 || asksInStyle ? "pending" : "not-applicable",
  };
};

/**
 * Everything initialization reports about authoring for one repository: the
 * detected harnesses, both sidecar states, the effective roles with
 * provenance, and the question state. Pass the primary checkout.
 */
export const resolveRepositoryAuthoring = (
  primaryCheckout: string,
  options: {
    environment?: Environment;
    harnessDataPath?: string;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
    // The current request's validated sidecar object (`--authoring-request`):
    // the top layer for this resolution only. It never answers a question.
    request?: AuthoringSidecar | null;
    setupStyle?: AuthoringSetupStyle;
    writeCapable?: boolean;
  } = {}
): RepositoryAuthoring => {
  const environment = options.environment ?? process.env;
  let definitions: HarnessDefinition[] = [];
  let harnessDataError: string | null = null;
  try {
    definitions = loadHarnessDefinitions(options.harnessDataPath);
  } catch (error) {
    harnessDataError = (error as Error).message;
  }
  const location = {
    environment,
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  };
  const { detected, running } = detectHarnesses(definitions, location);
  const runningHarness = harnessDataError
    ? (currentHarnessSession(environment)?.harness ?? null)
    : running;
  const paths = authoringPaths(primaryCheckout, location);
  const repository = readAuthoringFile(paths.repository);
  const personal = readAuthoringFile(paths.personal);
  const layers = validLayers(repository, personal);
  const request = options.request ?? null;
  const proposals = resolveRequestedRole(
    "proposals",
    layers,
    request,
    runningHarness
  );
  const review = resolveRequestedRole(
    "review",
    layers,
    request,
    runningHarness
  );
  const proposalsRole: ResolvedAuthoringRole = {
    effort: proposals.effective.effort,
    harness: proposals.effective.harness,
    model: proposals.effective.model,
    status: proposals.effective.status,
  };
  const proposalsSource: AuthoringFieldSource = {
    effort: proposals.source.effort,
    harness: proposals.source.harness,
    model: proposals.source.model,
    path: proposals.source.path,
  };
  return {
    authoringFiles: { personal, repository },
    authoringQuestion: authoringQuestionState({
      detectedCount: detected.length,
      personal,
      repository,
      ...(options.setupStyle === undefined
        ? {}
        : { setupStyle: options.setupStyle }),
      writeCapable: options.writeCapable ?? true,
    }),
    detectedHarnesses: detected,
    effective: { proposals: proposalsRole, review: review.effective },
    harnessDataError,
    repairRequired: [repository, personal].some(
      (file) => file.state === "malformed"
    ),
    runningHarness,
    source: { proposals: proposalsSource, review: review.source },
  };
};

// What a sidecar path holds right now, compared before the rename so a change
// made after the writer looked (by any process) is refused, never replaced.
const sidecarSnapshot = (path: string): string => {
  try {
    const status = lstatSync(path);
    return status.isFile()
      ? `file:${readFileSync(path, "utf8")}`
      : `other:${status.mode}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "absent";
    }
    throw error;
  }
};

interface SidecarLockOwner {
  hostname?: unknown;
  pid?: unknown;
  token?: unknown;
}

const sidecarLockOwner = (lockPath: string): SidecarLockOwner | null => {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as SidecarLockOwner;
  } catch {
    return null;
  }
};

const createSidecarLock = (lockPath: string, body: string): boolean => {
  try {
    writeFileSync(lockPath, body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
};

const describeLockOwner = (owner: SidecarLockOwner | null): string =>
  typeof owner?.pid === "number" && typeof owner.hostname === "string"
    ? ` (PID ${owner.pid} on ${owner.hostname})`
    : "";

/**
 * Serializes writers of one sidecar path, whichever repository or scope they
 * write from: a personal sidecar is shared by every repository, so the
 * repository locks callers hold do not order its writers. A lock is never
 * recovered automatically: no check of its owner can be made atomic with
 * taking it over, so a lock left by an exited writer is removed by the owner.
 */
const acquireSidecarLock = (path: string): (() => void) => {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  const body = `${JSON.stringify({ hostname: hostname(), pid: process.pid, token })}\n`;
  if (!createSidecarLock(lockPath, body)) {
    throw new SimpleChangesError(
      `Another authoring write holds ${lockPath}${describeLockOwner(sidecarLockOwner(lockPath))}. Retry after it finishes; if that process has exited, remove the file and retry.`,
      EXIT_CODES.unsafe
    );
  }
  return () => {
    if (sidecarLockOwner(lockPath)?.token === token) {
      rmSync(lockPath, { force: true });
    }
  };
};

const writeLockedSidecar = (
  path: string,
  text: string,
  privateFile: boolean
): { path: string; written: boolean } => {
  const snapshot = sidecarSnapshot(path);
  const current = readAuthoringFile(path);
  if (current.state === "malformed") {
    throw new SimpleChangesError(
      `Refusing to overwrite ${path}: ${current.errors.join("; ")} Repair or remove it first.`,
      EXIT_CODES.unsafe
    );
  }
  if (current.state === "valid" && snapshot === `file:${text}`) {
    return { path, written: false };
  }
  const temporaryPath = resolve(
    dirname(path),
    `.${randomUUID()}.simple-changes-authoring.tmp`
  );
  // Everything fallible happens on the staged file; the rename is the last
  // step, so a failure leaves the existing sidecar untouched.
  try {
    writeFileSync(temporaryPath, text, {
      encoding: "utf8",
      flag: "wx",
      mode: privateFile ? 0o600 : 0o644,
    });
    chmodSync(temporaryPath, privateFile ? 0o600 : 0o644);
    if (readAuthoringFile(temporaryPath).state !== "valid") {
      throw new SimpleChangesError(
        `The staged authoring sidecar did not validate: ${temporaryPath}`,
        EXIT_CODES.validation
      );
    }
    // Cooperating writers hold the lock; this compare also refuses any other
    // edit that lands before the rename, short of the instant between the
    // compare and the rename itself, which no rename-based write can close.
    if (sidecarSnapshot(path) !== snapshot) {
      throw new SimpleChangesError(
        `${path} changed while this answer was being written; nothing was replaced. Inspect it and retry.`,
        EXIT_CODES.unsafe
      );
    }
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new SimpleChangesError(
        `Refusing to replace a symlink: ${path}`,
        EXIT_CODES.unsafe
      );
    }
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return { path, written: true };
};

/**
 * Writes one sidecar as a standalone transaction: validated first, never over
 * a malformed file (the owner repairs or removes it), never through a symlink,
 * through a temporary file renamed into place, and never over a file that
 * changed after the writer read it. Writers of one path are serialized by a
 * lock beside it. A failed write leaves the existing file untouched.
 */
export const writeAuthoringSidecar = (
  path: string,
  value: unknown,
  privateFile: boolean
): { path: string; written: boolean } => {
  const validation = validateAuthoringSidecar(value);
  if (!validation.value) {
    throw new SimpleChangesError(
      `The authoring answer is invalid: ${validation.errors.join("; ")}`,
      EXIT_CODES.validation
    );
  }
  const text = `${JSON.stringify(validation.value, null, 2)}\n`;
  mkdirSync(dirname(path), {
    mode: privateFile ? 0o700 : 0o755,
    recursive: true,
  });
  const release = acquireSidecarLock(path);
  try {
    return writeLockedSidecar(path, text, privateFile);
  } finally {
    release();
  }
};

// The guidance checkpoint that introduced authoring preferences; Simple
// Changes versions as 0.<guidance>.<patch>, so 0.28.0 is the first release
// that honors the sidecar.
export const AUTHORING_GUIDANCE = 28;

/** Parses `setup --authoring`: JSON text, or `@path` to a JSON file. */
export const parseAuthoringAnswer = (
  text: string,
  option = "--authoring"
): unknown => {
  try {
    return JSON.parse(
      text.startsWith("@") ? readFileSync(resolve(text.slice(1)), "utf8") : text
    ) as unknown;
  } catch (error) {
    throw SimpleChangesError.withCause(
      `${option} must be JSON or @path to a JSON file: ${(error as Error).message}`,
      EXIT_CODES.usage,
      error
    );
  }
};

/**
 * Parses and validates `--authoring-request`: a complete sidecar object
 * checked exactly as a file would be (design 6.3). An invalid request is a
 * usage error raised before any other input is acted on; a valid one is the
 * request layer for one invocation and is never written.
 */
export const parseAuthoringRequest = (text: string): AuthoringSidecar => {
  const validation = validateAuthoringSidecar(
    parseAuthoringAnswer(text, "--authoring-request")
  );
  if (!validation.value) {
    throw new SimpleChangesError(
      `--authoring-request is invalid: ${validation.errors.join("; ")}`,
      EXIT_CODES.usage
    );
  }
  return validation.value;
};

/**
 * `setup --authoring --scope <repository|personal> --confirm`: a standalone
 * transaction that writes only the chosen sidecar. It refuses while the
 * harness data file is broken (fail closed) and never overwrites a malformed
 * sidecar. The caller holds the loop state lock.
 */
export const recordAuthoringAnswer = (input: {
  answer: unknown;
  environment?: Environment;
  harnessDataPath?: string;
  primaryCheckout: string;
  scope: "personal" | "repository";
}): { path: string; summary: string; written: boolean } => {
  loadHarnessDefinitions(input.harnessDataPath);
  const paths = authoringPaths(
    input.primaryCheckout,
    input.environment ? { environment: input.environment } : {}
  );
  const repository = input.scope === "repository";
  const result = writeAuthoringSidecar(
    repository ? paths.repository : paths.personal,
    input.answer,
    !repository
  );
  const commit = repository ? " Commit this file with your policy." : "";
  return {
    ...result,
    summary: result.written
      ? `Saved authoring preferences to ${result.path}.${commit} Simple Changes 0.${AUTHORING_GUIDANCE}.0 or later honors them; older copies write with the running model.`
      : `Authoring preferences in ${result.path} already match; nothing was written.`,
  };
};
