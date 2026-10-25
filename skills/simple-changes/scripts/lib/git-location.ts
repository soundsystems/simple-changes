import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { gitExecutable } from "./process.ts";

// Simple Changes keeps its shared state (review ledger, loop lease and lock,
// coordination, ship holds, work-directory bindings) under
// `<common Git directory>/simple-changes`, and every command finds that
// directory through Git. A wrong answer from Git would put the state somewhere
// else: once, under load, `rev-parse --git-common-dir` printed nothing, the
// empty answer resolved to the checkout root, and a review ledger was written
// to `<checkout>/simple-changes` as untracked files. These checks refuse a
// wrong answer before any lock or state file is created.

const STATE_DIRECTORY = "simple-changes";
const DIAGNOSTIC_LIMIT = 240;
const LINE_ENDS = /[\r\n]+$/u;
const GITDIR_PREFIX = "gitdir: ";

/** What a refusal reports about where the command looked. */
export interface GitLocationContext {
  /** Each raw Git answer read so far, keyed by the question asked. */
  answers?: Record<string, string>;
  /** The directory the command was asked to act on. */
  repository: string;
}

const bounded = (value: string): string =>
  value.length > DIAGNOSTIC_LIMIT
    ? `${JSON.stringify(value.slice(0, DIAGNOSTIC_LIMIT))} (first ${DIAGNOSTIC_LIMIT} of ${value.length} characters)`
    : JSON.stringify(value);

const attempt = (read: () => string): string => {
  try {
    return read();
  } catch {
    return "(unavailable)";
  }
};

/**
 * One line naming the Git executable, the working directory, the repository
 * asked about and each raw Git answer, each quoted and cut to a bounded
 * length, so a refusal shows what was asked and what came back.
 */
export const gitLocationDiagnostics = (context: GitLocationContext): string => {
  const fields: [string, string][] = [
    ["git executable", attempt(gitExecutable)],
    ["working directory", attempt(() => process.cwd())],
    ["repository", context.repository],
    ...Object.entries(context.answers ?? {}).map(
      ([question, answer]): [string, string] => [
        `rev-parse ${question} answer`,
        answer,
      ]
    ),
  ];
  return `Diagnostics: ${fields
    .map(([name, value]) => `${name} ${bounded(value)}`)
    .join("; ")}.`;
};

const refuse = (reason: string, context: GitLocationContext): never => {
  throw new SimpleChangesError(
    `${reason} Refusing to use it for Simple Changes state; nothing was written. ${gitLocationDiagnostics(context)}`,
    EXIT_CODES.inventory
  );
};

/**
 * Git answers a path question with a path. An empty answer resolves to the
 * working directory (or, joined to a checkout, to that checkout), which is
 * some other place, so it is refused, as is one no file system path can be.
 */
export const gitReportedPath = (
  output: string,
  question: string,
  context: GitLocationContext = { repository: "(not given)" }
): string => {
  const path = output.replace(LINE_ENDS, "");
  if (path === "") {
    refuse(
      `git rev-parse ${question} printed no path; refusing to resolve the working directory in its place.`,
      context
    );
  }
  if (path.includes("\0")) {
    refuse(
      `git rev-parse ${question} printed a path with a NUL byte, which no file system path has.`,
      context
    );
  }
  return path;
};

const existingPath = (
  root: string,
  answer: string,
  question: string,
  context: GitLocationContext
): string => {
  const path = gitReportedPath(answer, question, context);
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  try {
    return realpathSync(absolute);
  } catch {
    return refuse(
      `git rev-parse ${question} named ${bounded(absolute)}, which does not exist.`,
      context
    );
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const realpathOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Whether `path` is a repository's own Git directory: it has `HEAD`,
 * `objects` and `refs`, and no `commondir` file, which only a linked
 * worktree's private Git directory has.
 */
export const isCommonGitDirectory = (path: string): boolean =>
  isDirectory(path) &&
  isFile(join(path, "HEAD")) &&
  isDirectory(join(path, "objects")) &&
  isDirectory(join(path, "refs")) &&
  !isFile(join(path, "commondir"));

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? "unknown error";

// The entry at `path` without following a link: null only when it does not
// exist; any other failure to look refuses, since an entry that cannot be
// inspected cannot be shown to stay inside the Git directory.
const inspectedEntry = (
  path: string,
  context: GitLocationContext
): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    return refuse(
      `Could not inspect ${bounded(path)} (${errorCode(error)}).`,
      context
    );
  }
};

/**
 * Refuses unless `commonGitDirectory` is a repository's own Git directory and
 * its `simple-changes` state directory, when it exists, is a plain directory
 * there rather than a link. Callers run it before they take a lock; each write
 * then creates its own directory with `ensureStateDirectory`.
 */
export const assertStateDestination = (
  commonGitDirectory: string,
  context: GitLocationContext
): void => {
  if (!isCommonGitDirectory(commonGitDirectory)) {
    refuse(
      `${bounded(commonGitDirectory)} is not a repository's Git directory (it needs HEAD, objects and refs, and no commondir file).`,
      context
    );
  }
  const stateDirectory = join(commonGitDirectory, STATE_DIRECTORY);
  const entry = inspectedEntry(stateDirectory, context);
  if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) {
    refuse(
      `${bounded(stateDirectory)} is not a plain directory inside the Git directory, so state written there would land somewhere else.`,
      context
    );
  }
};

/**
 * Creates `directory`, which must lie in `<commonGitDirectory>/simple-changes`,
 * one component at a time without following links, and refuses unless every
 * component from the common Git directory down is a plain directory: a
 * symbolic link at any depth, an entry that is not a directory, or an entry
 * that cannot be inspected would let the write land outside the Git
 * directory. Every state writer creates its directory through this instead of
 * a recursive `mkdir`, which follows links. Returns the directory's path.
 */
export const ensureStateDirectory = (
  commonGitDirectory: string,
  directory: string
): string => {
  const context: GitLocationContext = { repository: commonGitDirectory };
  assertStateDestination(commonGitDirectory, context);
  const offset = relative(resolve(commonGitDirectory), resolve(directory));
  const segments = offset.split(sep);
  if (
    offset === "" ||
    isAbsolute(offset) ||
    segments[0] !== STATE_DIRECTORY ||
    segments.includes("..")
  ) {
    refuse(
      `${bounded(directory)} is not inside ${bounded(join(commonGitDirectory, STATE_DIRECTORY))}.`,
      context
    );
  }
  let current = resolve(commonGitDirectory);
  for (const segment of segments) {
    current = join(current, segment);
    let entry = inspectedEntry(current, context);
    if (entry === null) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          refuse(
            `Could not create ${bounded(current)} (${errorCode(error)}).`,
            context
          );
        }
      }
      entry = inspectedEntry(current, context);
    }
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
      refuse(
        `${bounded(current)} is not a plain directory, so state written through it would land somewhere else.`,
        context
      );
    }
  }
  return current;
};

/**
 * `ensureStateDirectory` for a writer that knows only its directory: the
 * common Git directory is the nearest ancestor holding a `simple-changes`
 * directory on the way to it that is a repository's Git directory.
 */
export const ensureStateDirectoryOf = (directory: string): string => {
  let current = resolve(directory);
  while (dirname(current) !== current) {
    const parent = dirname(current);
    if (basename(current) === STATE_DIRECTORY && isCommonGitDirectory(parent)) {
      return ensureStateDirectory(parent, directory);
    }
    current = parent;
  }
  return refuse(
    `${bounded(directory)} is not inside a repository's Simple Changes state directory.`,
    { repository: directory }
  );
};

// Where the checkout's `.git` entry points: its own real path when it is a
// directory, the path after `gitdir: ` when it is a file, null when there is
// none. Like Git, only trailing line ends are removed, so a path with a line
// break inside it is kept whole.
const checkoutMarkerTarget = (
  root: string,
  context: GitLocationContext
): string | null => {
  const marker = join(root, ".git");
  try {
    lstatSync(marker);
  } catch {
    return null;
  }
  if (isDirectory(marker)) {
    return realpathOrNull(marker);
  }
  const text = readText(marker) ?? "";
  const pointer = text.startsWith(GITDIR_PREFIX)
    ? text.slice(GITDIR_PREFIX.length).replace(LINE_ENDS, "")
    : "";
  const target = pointer ? realpathOrNull(resolve(root, pointer)) : null;
  return (
    target ??
    refuse(`${bounded(marker)} names no existing Git directory.`, context)
  );
};

export interface VerifiedGitDirectories {
  commonGitDirectory: string;
  gitDirectory: string;
}

/**
 * Turns Git's raw answers to `--absolute-git-dir` and `--git-common-dir` for
 * the checkout at `root` into real paths, and refuses unless they name one
 * repository this checkout belongs to: the common directory is a real Git
 * directory, not the checkout; the checkout's Git directory is the common
 * directory, or a linked worktree's directory whose `commondir` names it; and
 * the checkout's `.git` entry, when it has one, points at that Git directory.
 * A refusal names what Git answered and creates nothing.
 */
export const verifiedGitDirectories = (
  root: string,
  answers: { commonGitDirectory: string; gitDirectory: string },
  repository: string
): VerifiedGitDirectories => {
  const context: GitLocationContext = {
    answers: {
      "--absolute-git-dir": answers.gitDirectory,
      "--git-common-dir": answers.commonGitDirectory,
    },
    repository,
  };
  const commonGitDirectory = existingPath(
    root,
    answers.commonGitDirectory,
    "--git-common-dir",
    context
  );
  const gitDirectory = existingPath(
    root,
    answers.gitDirectory,
    "--absolute-git-dir",
    context
  );
  if (commonGitDirectory === root) {
    refuse(
      `git rev-parse --git-common-dir named the checkout ${bounded(root)} itself, not its Git directory.`,
      context
    );
  }
  assertStateDestination(commonGitDirectory, context);
  if (!(isDirectory(gitDirectory) && isFile(join(gitDirectory, "HEAD")))) {
    refuse(
      `git rev-parse --absolute-git-dir named ${bounded(gitDirectory)}, which is not a Git directory.`,
      context
    );
  }
  if (gitDirectory !== commonGitDirectory) {
    const pointer = readText(join(gitDirectory, "commondir"))?.replace(
      LINE_ENDS,
      ""
    );
    const pointed = pointer
      ? realpathOrNull(resolve(gitDirectory, pointer))
      : null;
    if (pointed !== commonGitDirectory) {
      refuse(
        `The checkout's Git directory ${bounded(gitDirectory)} does not belong to ${bounded(commonGitDirectory)}: its commondir file names ${pointed === null ? "no existing directory" : bounded(pointed)}.`,
        context
      );
    }
  }
  const markerTarget = checkoutMarkerTarget(root, context);
  if (markerTarget !== null && markerTarget !== gitDirectory) {
    refuse(
      `The checkout's .git entry points at ${bounded(markerTarget)}, not at the Git directory ${bounded(gitDirectory)} that Git reported.`,
      context
    );
  }
  return { commonGitDirectory, gitDirectory };
};
