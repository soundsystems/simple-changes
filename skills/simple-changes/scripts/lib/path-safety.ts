import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";

const ESCAPES_ROOT_PATTERN = /(^|[/\\])\.\.([/\\]|$)/u;

export const assertSafeRelativePath = (
  root: string,
  candidate: string
): { absolutePath: string; symlink: boolean } => {
  if (
    candidate.length === 0 ||
    isAbsolute(candidate) ||
    ESCAPES_ROOT_PATTERN.test(candidate) ||
    candidate.includes("\0")
  ) {
    throw new SimpleChangesError(
      `Unsafe repository path: ${JSON.stringify(candidate)}`,
      EXIT_CODES.unsafe
    );
  }

  const canonicalRoot = realpathSync(root);
  const absolutePath = resolve(canonicalRoot, candidate);
  const relativePath = relative(canonicalRoot, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new SimpleChangesError(
      `Path escapes repository root: ${JSON.stringify(candidate)}`,
      EXIT_CODES.unsafe
    );
  }

  const segments = relativePath.split(sep).filter(Boolean);
  let current = canonicalRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    if (!existsSync(current)) {
      break;
    }
    if (lstatSync(current).isSymbolicLink()) {
      return { absolutePath, symlink: true };
    }
  }
  return { absolutePath, symlink: false };
};

export const assertNoSymlinkAncestors = (
  root: string,
  relativePath: string
): string => {
  const safe = assertSafeRelativePath(root, relativePath);
  if (safe.symlink) {
    throw new SimpleChangesError(
      `Refusing state path with a symlink ancestor: ${safe.absolutePath}`,
      EXIT_CODES.unsafe
    );
  }
  return safe.absolutePath;
};

const alreadyExists = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "EEXIST";

/**
 * Puts a finished staged file at `path` only when nothing is there, a
 * dangling symbolic link included. Returns false, with `path` untouched,
 * when something is; the caller reports that as someone else's save. A hard
 * link installs the complete file in one step; a filesystem without hard
 * links gets an exclusive copy, which still never replaces a file. Once
 * installed, the file is saved: the staged name is removed here, and a
 * failure to remove it is never reported as a failed save. When this
 * returns false or throws, the staged file is the caller's to remove.
 */
export const installWithoutReplacing = (
  stagedPath: string,
  path: string
): boolean => {
  const installed = (): boolean => {
    try {
      unlinkSync(stagedPath);
    } catch {
      // The installed file is the save; a leftover staged name changes
      // nothing a later run reads.
    }
    return true;
  };
  try {
    linkSync(stagedPath, path);
    return installed();
  } catch (error) {
    if (alreadyExists(error)) {
      return false;
    }
  }
  try {
    copyFileSync(stagedPath, path, constants.COPYFILE_EXCL);
    return installed();
  } catch (error) {
    if (alreadyExists(error)) {
      return false;
    }
    throw error;
  }
};
