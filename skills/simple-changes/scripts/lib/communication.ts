import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { resolvePersonalPolicyPath } from "./policy.ts";

// How Simple Changes talks to a person: the words it uses and how often it
// asks (references/ultra-simple-mode.md). It is a display preference, never
// authority, so nothing here reads or writes the policy or its trust receipt.
// It lives in a sidecar of its own because older copies enforce the policy
// file's closed schema: they ignore this file and keep the standard voice.

export const COMMUNICATION_STYLES = ["ultra-simple", "standard"] as const;
export type CommunicationStyle = (typeof COMMUNICATION_STYLES)[number];

/**
 * Where the effective style came from. `companion` is the repository's
 * Simple Changelogs sidecar, followed only when Simple Changes has no
 * setting of its own.
 */
export type CommunicationSource =
  | "personal"
  | "repository"
  | "companion"
  | "default";

export const REPOSITORY_COMMUNICATION_FILENAME =
  ".simple-changes-communication.json";
export const CHANGELOGS_REPOSITORY_COMMUNICATION_FILENAME =
  ".simple-changelogs-communication.json";
const PERSONAL_COMMUNICATION_FILENAME = "communication.json";

export interface CommunicationReport {
  /** Sidecars that exist but could not be used; each was skipped. */
  errors: string[];
  /** The file the style came from, or null for the default. */
  path: string | null;
  source: CommunicationSource;
  style: CommunicationStyle;
}

interface PathOptions {
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

export const isCommunicationStyle = (
  value: unknown
): value is CommunicationStyle =>
  typeof value === "string" &&
  (COMMUNICATION_STYLES as readonly string[]).includes(value);

/** The sidecar paths: the personal file and the two repository files. */
export const communicationPaths = (
  primaryCheckout: string | null,
  options: PathOptions = {}
): {
  companion: string | null;
  personal: string;
  repository: string | null;
} => ({
  companion: primaryCheckout
    ? resolve(primaryCheckout, CHANGELOGS_REPOSITORY_COMMUNICATION_FILENAME)
    : null,
  personal: join(
    dirname(resolvePersonalPolicyPath(options)),
    PERSONAL_COMMUNICATION_FILENAME
  ),
  repository: primaryCheckout
    ? resolve(primaryCheckout, REPOSITORY_COMMUNICATION_FILENAME)
    : null,
});

type FileState =
  | { state: "absent" }
  | { error: string; state: "malformed" }
  | { state: "valid"; style: CommunicationStyle };

// Only `schemaVersion` and `style` are read. Other members are ignored, so a
// later release can add one without this copy refusing the whole file.
const readCommunicationFile = (path: string): FileState => {
  // lstat, not existsSync: a dangling symbolic link is a directory entry
  // that is not a regular file, never an absent sidecar a write may replace.
  let status: Stats;
  try {
    status = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent" };
    }
    return { error: `${path} cannot be inspected`, state: "malformed" };
  }
  if (!status.isFile()) {
    return { error: `${path} is not a regular file`, state: "malformed" };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return { error: `${path} is not valid JSON`, state: "malformed" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: `${path} must hold a JSON object`, state: "malformed" };
  }
  const { schemaVersion, style } = value as Record<string, unknown>;
  if (schemaVersion !== 1) {
    return { error: `${path}: schemaVersion must be 1`, state: "malformed" };
  }
  if (!isCommunicationStyle(style)) {
    return {
      error: `${path}: style must be ${COMMUNICATION_STYLES.join(" or ")}`,
      state: "malformed",
    };
  }
  return { state: "valid", style };
};

/**
 * The effective style, highest layer first: the person's own setting, the
 * project's, then the project's Simple Changelogs setting. A personal setting
 * outranks the project's because the style grants nothing. A file that cannot
 * be used is reported and skipped, never guessed at, so the worst outcome of
 * a broken sidecar is the next layer's style or the standard voice.
 */
export const resolveCommunication = (
  primaryCheckout: string | null,
  options: PathOptions = {}
): CommunicationReport => {
  const paths = communicationPaths(primaryCheckout, options);
  const layers: [CommunicationSource, string | null][] = [
    ["personal", paths.personal],
    ["repository", paths.repository],
    ["companion", paths.companion],
  ];
  // Every layer is read, so a broken sidecar is reported even when a higher
  // layer already decides the style: a person's own setting must not hide
  // the project file their teammates depend on.
  const errors: string[] = [];
  let chosen: Omit<CommunicationReport, "errors"> | null = null;
  for (const [source, path] of layers) {
    if (!path) {
      continue;
    }
    const file = readCommunicationFile(path);
    if (file.state === "malformed") {
      errors.push(file.error);
    } else if (file.state === "valid" && chosen === null) {
      chosen = { path, source, style: file.style };
    }
  }
  return {
    ...(chosen ?? { path: null, source: "default", style: "standard" }),
    errors,
  };
};

const replaceableCommunication = (path: string): FileState => {
  const current = readCommunicationFile(path);
  if (current.state === "malformed") {
    throw new SimpleChangesError(
      `Refusing to replace a communication setting that cannot be read (${current.error}); repair or remove it, then run setup again.`,
      EXIT_CODES.unsafe
    );
  }
  return current;
};

/**
 * Refuses, before anything else is written, when `writeCommunication` would
 * refuse this path: a setup that also saves the style checks every
 * destination first, so it never stops half saved.
 */
export const assertCommunicationWritable = (path: string): void => {
  replaceableCommunication(path);
};

/**
 * Records the style in one sidecar and nothing else. A file that is not a
 * regular file, or that this copy cannot read, is never replaced: the owner
 * repairs or removes it.
 */
export const writeCommunication = (
  path: string,
  style: CommunicationStyle,
  privateFile: boolean
): { changed: boolean; path: string } => {
  const current = replaceableCommunication(path);
  if (current.state === "valid" && current.style === style) {
    return { changed: false, path };
  }
  const directory = dirname(path);
  mkdirSync(directory, { mode: privateFile ? 0o700 : 0o755, recursive: true });
  const temporaryPath = resolve(
    directory,
    `.${randomUUID()}.simple-changes.tmp`
  );
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ schemaVersion: 1, style }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: privateFile ? 0o600 : 0o644 }
  );
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
  const persisted = readCommunicationFile(path);
  if (persisted.state !== "valid" || persisted.style !== style) {
    throw new SimpleChangesError(
      `Communication setting verification failed after writing: ${path}`,
      EXIT_CODES.validation
    );
  }
  return { changed: true, path };
};
