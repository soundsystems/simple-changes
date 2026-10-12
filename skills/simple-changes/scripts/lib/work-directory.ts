import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { locateRepository } from "./inventory.ts";
import { assertNoSymlinkAncestors } from "./path-safety.ts";
import { runGit } from "./process.ts";

// Agents write provider pages, receipts, proposal bodies, and decision files
// that the CLI reads once. A checkout is the wrong home (untracked files make
// it dirty) and so is the Git common directory (the CLI's own state), so each
// agent works in a private directory under the system temporary directory.
// Every directory is unique, and a run records the ones it uses so a clean
// close removes exactly those: two runs, or two sessions sharing an agent ID,
// never share or delete each other's files. The operating system sweeps
// whatever an abandoned run leaves behind.

export const WORK_ROOT_ENVIRONMENT = "SIMPLE_CHANGES_WORK_ROOT";

const BINDINGS_DIRECTORY = join("simple-changes", "work-directories");
const RUN_ID_PATTERN = /^[\w.-]+$/u;

export interface WorkDirectoryRepository {
  commonGitDirectory: string;
  currentCheckout: string;
}

interface WorkDirectoryBinding {
  agentId: string;
  path: string;
  schemaVersion: 1;
}

export interface RunWorkDirectoryRemoval {
  kept: { path: string; reason: string }[];
  removed: string[];
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

// Names this repository's directory under the root, readable and unique.
const repositoryKey = (repository: WorkDirectoryRepository): string =>
  `${slug(basename(owningCheckout(repository.commonGitDirectory)), "repository")}-${sha256(
    repository.commonGitDirectory
  ).slice(0, 12)}`;

const configuredRoot = (environment: NodeJS.ProcessEnv): string => {
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

// The deepest existing ancestor of `path` (or `path` itself), resolved.
const deepestExisting = (path: string): string => {
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      break;
    }
    existing = parent;
  }
  return realpathSync(existing);
};

// `path` with its deepest existing ancestor resolved, so a directory that does
// not exist yet still compares against real checkouts.
const canonicalPath = (path: string): string => {
  const existing = deepestExisting(path);
  let missing = path;
  const segments: string[] = [];
  while (!existsSync(missing)) {
    segments.unshift(basename(missing));
    missing = dirname(missing);
  }
  return join(existing, ...segments);
};

const isWithin = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path));
};

const unsafe = (message: string): SimpleChangesError =>
  new SimpleChangesError(
    `${message} Remove it or set ${WORK_ROOT_ENVIRONMENT} to a private directory outside every checkout.`,
    EXIT_CODES.unsafe
  );

const assertOutsideRepository = (
  repository: WorkDirectoryRepository,
  path: string
): void => {
  for (const protectedPath of new Set([
    owningCheckout(repository.commonGitDirectory),
    repository.commonGitDirectory,
    repository.currentCheckout,
  ])) {
    if (isWithin(realpathSync(protectedPath), path)) {
      throw unsafe(
        `Refusing a work directory inside ${protectedPath}: ${path}.`
      );
    }
  }
};

// The group-write (0o020) and other-write (0o002) permission bits.
const writableByOthers = (mode: number): boolean =>
  Math.floor(mode / 0o20) % 2 === 1 || Math.floor(mode / 0o2) % 2 === 1;

const isSticky = (mode: number): boolean => Math.floor(mode / 0o1000) % 2 === 1;

const currentUser = (): number | undefined => process.getuid?.();

// Another user could otherwise pre-create a shared temporary path and read or
// plant the files an agent passes to the CLI.
const assertPrivateDirectory = (path: string): void => {
  const metadata = lstatSync(path);
  const uid = currentUser();
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (uid !== undefined && metadata.uid !== uid) ||
    writableByOthers(metadata.mode)
  ) {
    throw unsafe(
      `Refusing a work directory that is a symlink, not a directory, owned by another user, or writable by others: ${path}.`
    );
  }
};

// Only this user or root may rename anything above the root, or replace it:
// a writable ancestor must be sticky, as /tmp is.
const assertTrustedAncestors = (realPath: string): void => {
  const uid = currentUser();
  let current = realPath;
  for (;;) {
    const metadata = lstatSync(current);
    if (
      !metadata.isDirectory() ||
      (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0) ||
      (writableByOthers(metadata.mode) && !isSticky(metadata.mode))
    ) {
      throw unsafe(
        `Refusing a work directory under ${current}, which another user could replace.`
      );
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
};

const ensurePrivateDirectory = (path: string): void => {
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  assertPrivateDirectory(path);
};

/**
 * Validates the root and this repository's directory under it, creating
 * them when missing, and returns the directory's real path.
 */
export const repositoryWorkDirectory = (
  repository: WorkDirectoryRepository,
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const configured = configuredRoot(environment);
  assertOutsideRepository(repository, canonicalPath(configured));
  // Resolve the ancestors, never the root itself: a root that is a symlink
  // must be refused, not followed.
  const parent = dirname(configured);
  assertTrustedAncestors(deepestExisting(parent));
  mkdirSync(parent, { mode: 0o700, recursive: true });
  const root = join(realpathSync(parent), basename(configured));
  ensurePrivateDirectory(root);
  const directory = join(root, repositoryKey(repository));
  ensurePrivateDirectory(directory);
  return directory;
};

const agentPrefix = (agentId: string): string =>
  `${slug(agentId, "agent")}-${sha256(agentId).slice(0, 8)}.`;

/** Creates a new, unique, private work directory for the agent. */
export const createWorkDirectory = (
  repository: WorkDirectoryRepository,
  agentId: string,
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const directory = repositoryWorkDirectory(repository, environment);
  const path = mkdtempSync(join(directory, agentPrefix(agentId)));
  assertPrivateDirectory(path);
  return path;
};

// A path is one of this repository's work directories only when it is a
// private directory, directly inside a private directory named for this
// repository, under a private root with trusted ancestors. Bindings are read
// from disk, so nothing else is ever removed.
const assertRepositoryWorkDirectory = (
  repository: WorkDirectoryRepository,
  path: string
): void => {
  const parent = dirname(path);
  const root = dirname(parent);
  if (!isAbsolute(path) || basename(parent) !== repositoryKey(repository)) {
    throw unsafe(`Not a work directory of this repository: ${path}.`);
  }
  assertTrustedAncestors(dirname(root));
  assertPrivateDirectory(root);
  assertPrivateDirectory(parent);
  assertPrivateDirectory(path);
  assertOutsideRepository(repository, path);
};

/** The work directory holding `filePath`, when it is in one. */
export const workDirectoryContaining = (
  repository: WorkDirectoryRepository,
  filePath: string
): string | null => {
  let current = dirname(realpathSync(filePath));
  for (;;) {
    if (basename(dirname(current)) === repositoryKey(repository)) {
      try {
        assertRepositoryWorkDirectory(repository, current);
        return current;
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

const bindingsRoot = (commonGitDirectory: string): string =>
  assertNoSymlinkAncestors(commonGitDirectory, BINDINGS_DIRECTORY);

const bindingsDirectory = (
  commonGitDirectory: string,
  runId: string
): string => {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new SimpleChangesError(
      `Invalid run ID: ${runId}`,
      EXIT_CODES.validation
    );
  }
  return assertNoSymlinkAncestors(
    commonGitDirectory,
    join(BINDINGS_DIRECTORY, runId)
  );
};

const bindingPath = (
  commonGitDirectory: string,
  runId: string,
  agentId: string
): string =>
  join(
    bindingsDirectory(commonGitDirectory, runId),
    `${sha256(agentId).slice(0, 16)}.json`
  );

const readBinding = (path: string): WorkDirectoryBinding | null => {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<WorkDirectoryBinding>;
    return typeof value.agentId === "string" &&
      typeof value.path === "string" &&
      value.schemaVersion === 1
      ? (value as WorkDirectoryBinding)
      : null;
  } catch {
    return null;
  }
};

// Every binding file a run holds, with its parsed binding when valid.
const runBindings = (
  commonGitDirectory: string,
  runId: string
): { binding: WorkDirectoryBinding | null; file: string }[] => {
  const directory = bindingsDirectory(commonGitDirectory, runId);
  if (!(existsSync(directory) && lstatSync(directory).isDirectory())) {
    return [];
  }
  return readdirSync(directory).map((name) => {
    const file = join(directory, name);
    return { binding: readBinding(file), file };
  });
};

// The runs that hold bindings, excluding malformed entries.
const boundRuns = (commonGitDirectory: string): string[] => {
  const root = bindingsRoot(commonGitDirectory);
  return existsSync(root)
    ? readdirSync(root).filter((runId) => RUN_ID_PATTERN.test(runId))
    : [];
};

/** The directory bound to this agent in this run, when it still exists. */
export const boundWorkDirectory = (
  repository: WorkDirectoryRepository,
  runId: string,
  agentId: string
): string | null => {
  const binding = readBinding(
    bindingPath(repository.commonGitDirectory, runId, agentId)
  );
  return binding && existsSync(binding.path) ? binding.path : null;
};

/**
 * Records the run's work directory for this agent and returns it: the one
 * already bound, else `candidate` (the directory holding the opening
 * inventory) when no other run holds it, else a new one.
 */
export const bindRunWorkDirectory = (
  repository: WorkDirectoryRepository,
  runId: string,
  agentId: string,
  candidate: string | null,
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const existing = boundWorkDirectory(repository, runId, agentId);
  if (existing) {
    assertRepositoryWorkDirectory(repository, existing);
    return existing;
  }
  if (candidate) {
    // Only one run is live, so a candidate another run still records belongs
    // to a finished run: move it here before that run's directories go.
    for (const otherRun of boundRuns(repository.commonGitDirectory)) {
      for (const { binding, file } of runBindings(
        repository.commonGitDirectory,
        otherRun
      )) {
        if (otherRun !== runId && binding?.path === candidate) {
          rmSync(file, { force: true });
        }
      }
    }
  }
  const path =
    candidate ?? createWorkDirectory(repository, agentId, environment);
  assertRepositoryWorkDirectory(repository, path);
  const target = bindingPath(repository.commonGitDirectory, runId, agentId);
  mkdirSync(dirname(target), { mode: 0o700, recursive: true });
  const binding: WorkDirectoryBinding = { agentId, path, schemaVersion: 1 };
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, target);
  return path;
};

/**
 * Removes every work directory bound to the run, then its bindings. A path
 * that fails validation is kept, reported, and never removed.
 */
export const removeRunWorkDirectories = (
  repository: WorkDirectoryRepository,
  runId: string
): RunWorkDirectoryRemoval => {
  const result: RunWorkDirectoryRemoval = { kept: [], removed: [] };
  for (const { binding } of runBindings(repository.commonGitDirectory, runId)) {
    if (!(binding && existsSync(binding.path))) {
      continue;
    }
    try {
      assertRepositoryWorkDirectory(repository, binding.path);
      rmSync(binding.path, { force: true, recursive: true });
      result.removed.push(binding.path);
    } catch (error) {
      result.kept.push({
        path: binding.path,
        reason: (error as Error).message,
      });
    }
  }
  rmSync(bindingsDirectory(repository.commonGitDirectory, runId), {
    force: true,
    recursive: true,
  });
  result.removed.sort((left, right) => left.localeCompare(right));
  return result;
};

/**
 * Removes the directories of every run other than `activeRunId`: only one
 * run is live in a repository, so the others closed, were archived, or were
 * replaced without a clean finalization.
 */
export const removeFinishedRunWorkDirectories = (
  repository: WorkDirectoryRepository,
  activeRunId: string
): RunWorkDirectoryRemoval => {
  const result: RunWorkDirectoryRemoval = { kept: [], removed: [] };
  for (const runId of boundRuns(repository.commonGitDirectory)) {
    if (runId === activeRunId) {
      continue;
    }
    const removal = removeRunWorkDirectories(repository, runId);
    result.removed.push(...removal.removed);
    result.kept.push(...removal.kept);
  }
  return result;
};

/** Removes one work directory of this repository unless a live run holds it. */
export const removeWorkDirectory = (
  repository: WorkDirectoryRepository,
  path: string,
  activeRunId: string | null
): string => {
  const real = realpathSync(path);
  assertRepositoryWorkDirectory(repository, real);
  if (
    activeRunId &&
    runBindings(repository.commonGitDirectory, activeRunId).some(
      ({ binding }) => binding?.path === real
    )
  ) {
    throw new SimpleChangesError(
      `${real} belongs to active run ${activeRunId}; its clean finalization removes it.`,
      EXIT_CODES.unsafe
    );
  }
  rmSync(real, { force: true, recursive: true });
  return real;
};
