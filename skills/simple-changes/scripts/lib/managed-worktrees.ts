import { existsSync, realpathSync, rmdirSync } from "node:fs";
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
// `<parent of the primary>/.simple-changes-worktrees/<repository slug>/`, and
// nothing else creates that namespace, so an empty directory there is one a
// run made.
export const managedWorktreeDirectories = (
  primaryCheckout: string
): { repository: string; root: string } => {
  const root = resolve(dirname(primaryCheckout), ".simple-changes-worktrees");
  return {
    repository: resolve(root, slug(basename(primaryCheckout), "repository")),
    root,
  };
};

const samePath = (left: string, right: string): boolean => {
  if (left === right) {
    return true;
  }
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
};

export const isManagedWorktreePath = (
  primaryCheckout: string,
  path: string
): boolean =>
  samePath(
    dirname(path),
    managedWorktreeDirectories(primaryCheckout).repository
  );

// Removes the managed repository and root directories once each is empty,
// innermost first. `rmdirSync` never removes a non-empty directory, so a
// sibling worktree, another repository's namespace, or anything a person put
// there keeps both in place.
export const removeEmptyManagedWorktreeDirectories = (
  primaryCheckout: string
): string[] => {
  const { repository, root } = managedWorktreeDirectories(primaryCheckout);
  const removed: string[] = [];
  for (const directory of [repository, root]) {
    if (!existsSync(directory)) {
      continue;
    }
    try {
      rmdirSync(directory);
      removed.push(directory);
    } catch {
      break;
    }
  }
  return removed;
};
