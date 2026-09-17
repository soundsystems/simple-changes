/**
 * Read-only delivery proof for a shipment whose scoped work was packaged from a
 * dirty primary checkout and then reviewed elsewhere.
 *
 * Review may change the bytes that actually ship, so the primary's uncommitted
 * copy no longer equals the delivered result. The shipment is still proven
 * delivered when the primary itself is untouched since the run's baseline, its
 * HEAD is contained in the current target, and every scoped path has a
 * reviewed result in that target while every other dirty path was explicitly
 * preserved or excluded. Nothing here authorizes mutation; it only decides
 * whether preserved primary bytes must hold the shipment open.
 */
export interface PrimaryDeliveryProofInput {
  baselineBranch: string | null;
  baselineDigest: string;
  baselineHead: string | null;
  branch: string | null;
  changes: readonly {
    conflicted: boolean;
    originalPath: string | null;
    path: string;
  }[];
  /** Final target entry recorded for each delivered scoped or rename path. */
  delivered: ReadonlyMap<string, string | null>;
  digest: string;
  excluded: readonly string[];
  head: string | null;
  headContained: boolean;
  /** Tree entry at the primary HEAD, used for scoped paths no longer dirty. */
  headEntry: (path: string) => string | null;
  isPrimary: boolean;
  outcomeTarget: string | undefined;
  preserved: readonly string[];
  scoped: readonly string[];
  /** Current working-tree entry in the primary checkout. */
  sourceEntry: (path: string) => string | null;
  target: string;
  targetEntry: (path: string) => string | null;
}

export const primaryDeliveryProof = (
  input: PrimaryDeliveryProofInput
): boolean => {
  if (
    !input.isPrimary ||
    input.branch !== input.baselineBranch ||
    input.digest !== input.baselineDigest ||
    input.outcomeTarget !== input.target ||
    (input.scoped.length > 0 && !input.headContained) ||
    (input.head !== input.baselineHead && input.head !== input.target)
  ) {
    return false;
  }
  const preserved = new Set([...input.preserved, ...input.excluded]);
  const scoped = new Set(input.scoped);
  const dirty = new Set(
    input.changes.flatMap((change) =>
      [change.path, change.originalPath].filter(
        (path): path is string => path !== null
      )
    )
  );
  const delivered = (path: string): boolean => {
    if (!(scoped.has(path) && input.delivered.has(path))) {
      return false;
    }
    if (input.targetEntry(path) !== input.delivered.get(path)) {
      return false;
    }
    // A dirty scoped path may hold the pre-review bytes; the reviewed result
    // in the target is the delivery. A clean scoped path must already be the
    // contained HEAD content, or status alone would hide a later edit.
    return (
      dirty.has(path) ||
      (input.headContained && input.sourceEntry(path) === input.headEntry(path))
    );
  };
  // Status alone omits a scoped path reverted to HEAD; inspect all scoped paths.
  if (!input.scoped.every(delivered)) {
    return false;
  }
  return input.changes.every(
    (change) =>
      !change.conflicted &&
      [change.path, change.originalPath]
        .filter((path): path is string => path !== null)
        .every((path) =>
          scoped.has(path)
            ? delivered(path)
            : preserved.has(path) ||
              (input.delivered.has(path) &&
                input.targetEntry(path) === input.delivered.get(path))
        )
  );
};
