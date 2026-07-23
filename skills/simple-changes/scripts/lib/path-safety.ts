import { existsSync, lstatSync, realpathSync } from "node:fs";
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
