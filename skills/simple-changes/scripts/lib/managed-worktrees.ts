import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const slug = (value: string, fallback: string): string => {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || fallback;
};

// `prepare-agent` places every worktree it creates under
// `<parent of the primary>/.simple-changes-worktrees/<repository slug>/`.
// Simple Changes never removes these folders: their names do not prove who
// made them, and no removal by name can be bound to the folder it checked.
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
