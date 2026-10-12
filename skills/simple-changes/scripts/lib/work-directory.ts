import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { locateRepository } from "./inventory.ts";
import { runGit } from "./process.ts";

// Agents write provider pages, receipts, proposal bodies, and decision files
// that the CLI reads once. A checkout is the wrong home (untracked files make
// it dirty) and so is the Git common directory (the CLI's own state), so each
// agent gets one private directory per repository under the system temporary
// directory. The CLI removes it when a run closes cleanly, and the operating
// system sweeps whatever an abandoned run leaves behind.

export const WORK_ROOT_ENVIRONMENT = "SIMPLE_CHANGES_WORK_ROOT";

export interface WorkDirectoryRepository {
  commonGitDirectory: string;
  currentCheckout: string;
}

export const locateWorkDirectoryRepository = (
  directory: string
): WorkDirectoryRepository => ({
  commonGitDirectory: locateRepository(directory).repository.commonGitDirectory,
  currentCheckout: realpathSync(
    runGit(directory, ["rev-parse", "--show-toplevel"]).stdout.trim()
  ),
});

// The checkout that owns `<checkout>/.git`; a bare repository is its own.
const owningCheckout = (commonGitDirectory: string): string =>
  basename(commonGitDirectory) === ".git"
    ? dirname(commonGitDirectory)
    : commonGitDirectory;

const slug = (value: string, fallback: string): string => {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return normalized || fallback;
};

const workRoot = (environment: NodeJS.ProcessEnv): string => {
  const override = environment[WORK_ROOT_ENVIRONMENT]?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new SimpleChangesError(
        `${WORK_ROOT_ENVIRONMENT} must be an absolute path: ${override}`,
        EXIT_CODES.usage
      );
    }
    return override;
  }
  return join(tmpdir(), `simple-changes-${process.getuid?.() ?? "user"}`);
};

/** The directory's path, created or not; the agent ID is hashed into it. */
export const workDirectoryPath = (
  repository: WorkDirectoryRepository,
  agentId: string,
  environment: NodeJS.ProcessEnv = process.env
): string =>
  join(
    workRoot(environment),
    `${slug(basename(owningCheckout(repository.commonGitDirectory)), "repository")}-${sha256(
      repository.commonGitDirectory
    ).slice(0, 12)}`,
    `${slug(agentId, "agent")}-${sha256(agentId).slice(0, 8)}`
  );

// The real path of `path`, resolved through its deepest existing ancestor so
// a directory that does not exist yet still compares against real checkouts.
const canonicalPath = (path: string): string => {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      break;
    }
    missing.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...missing);
};

const isWithin = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path));
};

const assertOutsideRepository = (
  repository: WorkDirectoryRepository,
  path: string
): void => {
  const candidate = canonicalPath(path);
  for (const protectedPath of new Set([
    owningCheckout(repository.commonGitDirectory),
    repository.commonGitDirectory,
    repository.currentCheckout,
  ])) {
    if (isWithin(canonicalPath(protectedPath), candidate)) {
      throw new SimpleChangesError(
        `Refusing a work directory inside ${protectedPath}: ${path}. Set ${WORK_ROOT_ENVIRONMENT} to a private directory outside every checkout.`,
        EXIT_CODES.unsafe
      );
    }
  }
};

// The group-write (0o020) and other-write (0o002) permission bits.
const writableByOthers = (mode: number): boolean =>
  Math.floor(mode / 0o20) % 2 === 1 || Math.floor(mode / 0o2) % 2 === 1;

// Another user could otherwise pre-create the shared temporary path and read
// or plant the files an agent passes to the CLI.
const assertPrivateDirectory = (path: string): void => {
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (uid !== undefined && metadata.uid !== uid) ||
    writableByOthers(metadata.mode)
  ) {
    throw new SimpleChangesError(
      `Refusing a work directory that is a symlink, not a directory, owned by another user, or writable by others: ${path}. Remove it or set ${WORK_ROOT_ENVIRONMENT}.`,
      EXIT_CODES.unsafe
    );
  }
};

const directoryChain = (path: string, environment: NodeJS.ProcessEnv) => {
  const root = workRoot(environment);
  return [root, dirname(path), path];
};

/** Creates the agent's work directory when missing and returns its path. */
export const ensureWorkDirectory = (
  repository: WorkDirectoryRepository,
  agentId: string,
  environment: NodeJS.ProcessEnv = process.env
): { created: boolean; path: string } => {
  const path = workDirectoryPath(repository, agentId, environment);
  assertOutsideRepository(repository, path);
  const created = !existsSync(path);
  mkdirSync(path, { mode: 0o700, recursive: true });
  for (const directory of directoryChain(path, environment)) {
    assertPrivateDirectory(directory);
  }
  return { created, path };
};

/**
 * Removes the agent's work directory, and its repository directory once
 * empty. Returns the removed path, or null when there was nothing to remove.
 */
export const removeWorkDirectory = (
  repository: WorkDirectoryRepository,
  agentId: string,
  environment: NodeJS.ProcessEnv = process.env
): string | null => {
  const path = workDirectoryPath(repository, agentId, environment);
  if (!existsSync(path)) {
    return null;
  }
  assertOutsideRepository(repository, path);
  for (const directory of directoryChain(path, environment)) {
    assertPrivateDirectory(directory);
  }
  rmSync(path, { force: true, recursive: true });
  try {
    rmdirSync(dirname(path));
  } catch {
    // Another agent's directory for the same repository is still there.
  }
  return path;
};
