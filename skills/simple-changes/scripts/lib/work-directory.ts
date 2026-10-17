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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { locateRepository } from "./inventory.ts";
import { assertNoSymlinkAncestors } from "./path-safety.ts";
import { runGit } from "./process.ts";
import { RUN_ID_PATTERN } from "./run-id.ts";

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

export interface WorkDirectoryRepository {
  /** Every registered checkout; a work directory is never inside one. */
  checkouts: string[];
  commonGitDirectory: string;
}

interface WorkDirectoryBinding {
  agentId: string;
  path: string;
  schemaVersion: 1;
  /** The harness session that holds it (`harness:id`), when known. */
  session: string | null;
}

export interface RunWorkDirectoryBinding {
  path: string;
  session: string | null;
}

export interface RunWorkDirectoryRemoval {
  kept: { path: string; reason: string }[];
  removed: string[];
}

const WORKTREE_LINE = /^worktree (.+)$/u;

/** Every checkout Git has registered for the repository at `directory`. */
export const registeredCheckouts = (directory: string): string[] =>
  runGit(directory, ["worktree", "list", "--porcelain"])
    .stdout.split("\n")
    .map((line) => WORKTREE_LINE.exec(line)?.[1])
    .filter((path): path is string => path !== undefined);

export const locateWorkDirectoryRepository = (
  directory: string
): WorkDirectoryRepository => ({
  checkouts: registeredCheckouts(directory),
  commonGitDirectory: locateRepository(directory).repository.commonGitDirectory,
});

/** Sessions match unless both are known and differ. */
export const sameSession = (
  left: string | null,
  right: string | null
): boolean => left === null || right === null || left === right;

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

// `path` with its deepest existing ancestor resolved once, so a directory
// that does not exist yet still compares against real checkouts, and later
// steps never re-resolve a link another user could retarget.
const canonicalPath = (
  path: string
): { existing: string; missing: string[]; path: string } => {
  const existing = deepestExisting(path);
  let current = path;
  const missing: string[] = [];
  while (!existsSync(current)) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return { existing, missing, path: join(existing, ...missing) };
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

const protectedPaths = (repository: WorkDirectoryRepository): string[] => [
  ...new Set([
    owningCheckout(repository.commonGitDirectory),
    repository.commonGitDirectory,
    ...repository.checkouts,
  ]),
];

const assertOutsideRepository = (
  repository: WorkDirectoryRepository,
  path: string
): void => {
  for (const protectedPath of protectedPaths(repository)) {
    if (isWithin(canonicalPath(protectedPath).path, path)) {
      throw unsafe(
        `Refusing a work directory inside ${protectedPath}: ${path}.`
      );
    }
  }
};

// A checkout someone placed inside a work directory survives its removal.
const assertHoldsNoCheckout = (
  repository: WorkDirectoryRepository,
  path: string
): void => {
  for (const protectedPath of protectedPaths(repository)) {
    if (isWithin(path, canonicalPath(protectedPath).path)) {
      throw unsafe(`Refusing to remove ${path}, which holds ${protectedPath}.`);
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
// a writable ancestor must be sticky, as /tmp is. Each step is checked
// without following links, so a link swapped into the path is refused.
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
  // Resolve the ancestors once, never the root itself: a root that is a
  // symlink must be refused, not followed.
  const parent = canonicalPath(dirname(configured));
  const root = join(parent.path, basename(configured));
  assertOutsideRepository(repository, root);
  assertTrustedAncestors(parent.existing);
  // Create each missing parent alone and check it before descending, so a
  // link swapped in is refused before anything is made through it.
  let created = parent.existing;
  for (const segment of parent.missing) {
    created = join(created, segment);
    ensurePrivateDirectory(created);
  }
  assertTrustedAncestors(parent.path);
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
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path.endsWith(sep) ||
    basename(parent) !== repositoryKey(repository)
  ) {
    throw unsafe(`Not a work directory of this repository: ${path}.`);
  }
  assertTrustedAncestors(dirname(root));
  assertPrivateDirectory(root);
  assertPrivateDirectory(parent);
  assertPrivateDirectory(path);
  if (realpathSync(path) !== path) {
    throw unsafe(`Not a work directory of this repository: ${path}.`);
  }
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

// A run's bindings directory is removed recursively when the run closes, so
// its ID must name exactly one entry under the bindings root: `..` would
// name the Simple Changes state directory itself, and `.` every run's.
const bindingsDirectory = (
  commonGitDirectory: string,
  runId: string
): string => {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new SimpleChangesError(
      `Invalid run ID ${JSON.stringify(runId)}: it must match run-[a-z0-9-]+.`,
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
      ? {
          agentId: value.agentId,
          path: value.path,
          schemaVersion: 1,
          session: typeof value.session === "string" ? value.session : null,
        }
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
export const runWorkDirectoryBinding = (
  repository: WorkDirectoryRepository,
  runId: string,
  agentId: string
): RunWorkDirectoryBinding | null => {
  const binding = readBinding(
    bindingPath(repository.commonGitDirectory, runId, agentId)
  );
  return binding && existsSync(binding.path)
    ? { path: binding.path, session: binding.session }
    : null;
};

const writeBinding = (
  repository: WorkDirectoryRepository,
  runId: string,
  binding: WorkDirectoryBinding
): void => {
  const target = bindingPath(
    repository.commonGitDirectory,
    runId,
    binding.agentId
  );
  mkdirSync(dirname(target), { mode: 0o700, recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, target);
};

/**
 * Records the run's work directory for this agent and returns it: the one
 * already bound, else `candidate` (the directory holding the opening
 * inventory), else a new one. Callers bind the run's controller and authors,
 * and any other agent the run's `workdir` serves, so a clean close removes
 * every directory the run used; the binding follows the agent to `session`.
 */
export const bindRunWorkDirectory = (
  repository: WorkDirectoryRepository,
  runId: string,
  agentId: string,
  session: string | null,
  candidate: string | null,
  environment: NodeJS.ProcessEnv = process.env
): string => {
  const existing = runWorkDirectoryBinding(repository, runId, agentId);
  if (existing) {
    assertRepositoryWorkDirectory(repository, existing.path);
    if (session !== null && existing.session !== session) {
      writeBinding(repository, runId, {
        agentId,
        path: existing.path,
        schemaVersion: 1,
        session,
      });
    }
    return existing.path;
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
  writeBinding(repository, runId, { agentId, path, schemaVersion: 1, session });
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
      assertHoldsNoCheckout(repository, binding.path);
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
  assertHoldsNoCheckout(repository, real);
  rmSync(real, { force: true, recursive: true });
  return real;
};
