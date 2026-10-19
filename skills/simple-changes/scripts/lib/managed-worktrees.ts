import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";

export const slug = (value: string, fallback: string): string => {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || fallback;
};

// Slugs hold only lowercase letters, digits, and single hyphens between
// them, so `--` separates the fields of a prepared worktree's name without
// ambiguity: different fields always give different names.
const PREPARED_WORKTREE_NAME =
  /^\.simple-changes-[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*){3}$/u;
const MAX_NAME_BYTES = 255;

/**
 * Where `prepare-agent` creates an agent's worktree: directly beside the
 * primary checkout, as
 * `<parent of the primary>/.simple-changes-<repository>--<run>--<purpose>--<agent>`.
 * That parent already holds the primary checkout, so `git worktree add`
 * creates only this one directory and Simple Changes never creates a parent
 * folder. Every field is reduced to a slug, so the name holds no path
 * separator or `..` and cannot leave that parent.
 */
export const preparedWorktreePath = (
  primaryCheckout: string,
  fields: { agent: string; purpose: string; run: string }
): string => {
  const parent = dirname(primaryCheckout);
  const name = `.simple-changes-${[
    slug(basename(primaryCheckout), "repository"),
    slug(fields.run, "run"),
    slug(fields.purpose, "work"),
    slug(fields.agent, "agent"),
  ].join("--")}`;
  const path = resolve(parent, name);
  if (
    !PREPARED_WORKTREE_NAME.test(name) ||
    Buffer.byteLength(name) > MAX_NAME_BYTES ||
    dirname(path) !== parent ||
    basename(path) !== name
  ) {
    throw new SimpleChangesError(
      `Refusing to prepare an agent worktree named ${JSON.stringify(name)} beside ${primaryCheckout}.`,
      EXIT_CODES.unsafe
    );
  }
  return path;
};

// The older layout: `prepare-agent` placed each worktree under
// `<parent of the primary>/.simple-changes-worktrees/<repository slug>/`.
// Worktrees made there keep working, because every command finds a run's
// worktrees by the paths the run recorded. Simple Changes never removes
// these folders: their names do not prove who made them, and no removal by
// name can be bound to the folder it checked.
export const managedWorktreeDirectories = (
  primaryCheckout: string
): { repository: string; root: string } => {
  const root = resolve(dirname(primaryCheckout), ".simple-changes-worktrees");
  return {
    repository: resolve(root, slug(basename(primaryCheckout), "repository")),
    root,
  };
};

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

// The entries of `directory` when it is a real directory, not a symbolic
// link; null when it is missing or anything else.
const realDirectoryEntries = (directory: string): string[] | null => {
  try {
    return lstatSync(directory).isDirectory() ? readdirSync(directory) : null;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
};

// The empty managed folder, then the managed root when that folder is all it
// holds. A folder seen behind a symbolic link is skipped; the result only
// reports what was seen.
const emptyManagedFolders = (primaryCheckout: string): string[] => {
  const { repository, root } = managedWorktreeDirectories(primaryCheckout);
  const anchor = dirname(root);
  if (realpathSync(anchor) !== anchor) {
    return [];
  }
  const rootEntries = realDirectoryEntries(root);
  if (!rootEntries) {
    return [];
  }
  const repositoryEntries = realDirectoryEntries(repository);
  if (repositoryEntries === null) {
    return rootEntries.length === 0 ? [root] : [];
  }
  if (repositoryEntries.length > 0) {
    return [];
  }
  const onlyRepository =
    rootEntries.length === 1 && rootEntries[0] === basename(repository);
  return onlyRepository ? [repository, root] : [repository];
};

/**
 * A non-fatal, informational note naming the managed worktree folders a
 * cleanup left empty; Simple Changes removes none. It suggests no command:
 * a command built from inspected pathnames could act on a folder swapped in
 * after the inspection. Never throws: a folder it cannot inspect is a note.
 */
export const emptyManagedWorktreeFolderNotes = (
  primaryCheckout: string
): string[] => {
  let folders: string[];
  try {
    folders = emptyManagedFolders(primaryCheckout);
  } catch (error) {
    const { root } = managedWorktreeDirectories(primaryCheckout);
    return [
      `Could not inspect the managed worktree folders under ${root}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (folders.length === 0) {
    return [];
  }
  const [empty, parent] = folders;
  return [
    `Kept the empty managed worktree folder ${empty}${parent ? ` and its parent ${parent}, which holds only that folder` : ""}: Simple Changes never removes a worktree's parent folder.`,
  ];
};
