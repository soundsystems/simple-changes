import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import {
  CHANGELOG_AUTHOR_DIRECTORY,
  readReceiptSidecar,
  resolvedCurrentTargetRevision,
  writeReceiptSidecar,
} from "./loop-lease-core.ts";
import { runGit } from "./process.ts";
import { readReviewLedger } from "./review-ledger.ts";
import { validateSchema } from "./schema.ts";
import type {
  ChangelogAuthorBinding,
  ChangelogAuthorRecord,
  LoopLease,
  LoopViolation,
  RepositoryInventory,
  WorktreeInventory,
} from "./types.ts";

/**
 * After a run's shipment scope froze, `prepare-agent --unit <id>` may add one
 * kind of author to an already registered unit: a changelog author, prepared
 * with this purpose, that changes only the repository's release surfaces.
 * Its binding lives in a sidecar beside the lease, because older runtimes
 * validate the lease strictly.
 */
export const CHANGELOG_AUTHOR_PURPOSE = "changelog";

// The most offending paths a violation lists before it summarizes the rest.
const MAX_LISTED_PATHS = 10;

/** This run's changelog-author bindings; none when no sidecar exists. */
export const readChangelogAuthors = (
  lease: Pick<LoopLease, "commonGitDirectory" | "runId">
): ChangelogAuthorBinding[] => {
  const stored = readReceiptSidecar(
    lease.commonGitDirectory,
    CHANGELOG_AUTHOR_DIRECTORY,
    lease.runId
  );
  if (stored === null) {
    return [];
  }
  const record = validateSchema<ChangelogAuthorRecord>(
    "changelog-author",
    stored
  );
  if (record.runId !== lease.runId) {
    throw new SimpleChangesError(
      `The changelog author record for ${lease.runId} names run ${record.runId}. Restore the record this run wrote; do not copy another run's.`,
      EXIT_CODES.unsafe
    );
  }
  return record.authors;
};

/**
 * Replaces this run's bindings. The caller holds the loop state lock; an
 * empty list removes the sidecar.
 */
export const writeChangelogAuthors = (
  lease: LoopLease,
  authors: ChangelogAuthorBinding[]
): void => {
  writeReceiptSidecar(
    lease,
    CHANGELOG_AUTHOR_DIRECTORY,
    authors.length === 0
      ? null
      : validateSchema<ChangelogAuthorRecord>("changelog-author", {
          authors,
          runId: lease.runId,
          schemaVersion: 1,
        })
  );
};

// Whether the run still registers, or is preparing, the binding's author at
// its path. A binding left by a preparation that stopped before the lease
// recorded it binds nobody.
const bindingIsLive = (
  lease: LoopLease,
  binding: ChangelogAuthorBinding
): boolean =>
  lease.worktrees.some(
    (worktree) =>
      worktree.agentId === binding.agentId &&
      worktree.path === binding.path &&
      worktree.role === "author"
  ) ||
  lease.preparations.some(
    (preparation) =>
      preparation.agentId === binding.agentId &&
      preparation.path === binding.path
  );

const nulSeparated = (output: string): string[] =>
  output.split("\0").filter(Boolean);

// The paths the author's branch and uncommitted changes change relative to
// where its branch meets the current target, or null when Git cannot say.
const worktreePaths = (
  binding: ChangelogAuthorBinding,
  worktree: WorktreeInventory,
  targetRevision: string | null
): string[] | null => {
  const uncommitted = worktree.changes.flatMap((change) =>
    change.originalPath ? [change.path, change.originalPath] : [change.path]
  );
  if (!worktree.headSha) {
    return uncommitted;
  }
  let from = binding.baseRevision;
  if (targetRevision) {
    const meeting = runGit(
      worktree.path,
      ["merge-base", worktree.headSha, targetRevision],
      true
    );
    if (meeting.exitCode === 0 && meeting.stdout.trim()) {
      from = meeting.stdout.trim();
    }
  }
  const committed = runGit(
    worktree.path,
    ["diff", "--name-only", "-z", "--no-renames", from, worktree.headSha],
    true
  );
  return committed.exitCode === 0
    ? [...uncommitted, ...nulSeparated(committed.stdout)]
    : null;
};

const isAncestor = (cwd: string, commit: string, of: string): boolean =>
  runGit(cwd, ["merge-base", "--is-ancestor", commit, of], true).exitCode === 0;

// The paths each commit the author attested changes itself: for a merge,
// only paths that differ from every parent. Commits already in the base the
// author started from, and commits this repository no longer has, are not
// its work in this run.
const attestedPaths = (
  lease: LoopLease,
  binding: ChangelogAuthorBinding
): { commits: string[]; paths: string[] } | { error: string } => {
  const state = readReviewLedger(lease.commonGitDirectory);
  if (state.state === "malformed") {
    return {
      error: `the review ledger at ${state.path} cannot be read (${state.errors.join("; ")}), so the commits it attested cannot be checked`,
    };
  }
  const commits: string[] = [];
  const paths: string[] = [];
  for (const [commit, attestations] of Object.entries(
    state.ledger.attestations
  )) {
    if (
      !attestations.some(
        (attestation) => attestation.logicalId === binding.agentId
      ) ||
      runGit(
        lease.primaryCheckout,
        ["cat-file", "-e", `${commit}^{commit}`],
        true
      ).exitCode !== 0 ||
      isAncestor(lease.primaryCheckout, commit, binding.baseRevision)
    ) {
      continue;
    }
    const changed = runGit(
      lease.primaryCheckout,
      [
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--name-only",
        "-z",
        "-c",
        "--root",
        commit,
      ],
      true
    );
    if (changed.exitCode !== 0) {
      return { error: `Git could not list the paths ${commit} changes` };
    }
    const outside = nulSeparated(changed.stdout).filter(
      (path) => !binding.releaseSurfaces.includes(path)
    );
    if (outside.length > 0) {
      commits.push(commit);
      paths.push(...outside);
    }
  }
  return { commits, paths };
};

const listed = (paths: readonly string[]): string => {
  const shown = paths
    .slice(0, MAX_LISTED_PATHS)
    .map((path) => JSON.stringify(path));
  const more = paths.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
};

const sortedUnique = (paths: Iterable<string>): string[] =>
  [...new Set(paths)].sort((left, right) => left.localeCompare(right));

// What the author's present worktree changes outside its release surfaces.
const worktreeProblems = (
  binding: ChangelogAuthorBinding,
  worktree: WorktreeInventory | undefined,
  targetRevision: string | null
): string[] => {
  if (!worktree) {
    return [];
  }
  const changed = worktreePaths(binding, worktree, targetRevision);
  if (changed === null) {
    return ["Git could not list what its branch changes"];
  }
  const outside = sortedUnique(changed).filter(
    (path) => !binding.releaseSurfaces.includes(path)
  );
  return outside.length > 0 ? [`its worktree changes ${listed(outside)}`] : [];
};

// What the commits the author attested change outside its release surfaces.
const attestationProblems = (
  lease: LoopLease,
  binding: ChangelogAuthorBinding
): string[] => {
  const attested = attestedPaths(lease, binding);
  if ("error" in attested) {
    return [attested.error];
  }
  return attested.commits.length > 0
    ? [
        `commits it attested (${attested.commits.join(", ")}) change ${listed(sortedUnique(attested.paths))}`,
      ]
    : [];
};

/**
 * One violation for each changelog author whose branch, uncommitted changes,
 * or attested commits change anything but the release surfaces recorded when
 * it was prepared. Its unit is stale until no such change remains; a commit
 * it attested stays in the ledger, so that unit stays stale for this run.
 */
export const changelogAuthorViolations = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopViolation[] => {
  const bindings = readChangelogAuthors(lease).filter((binding) =>
    bindingIsLive(lease, binding)
  );
  if (bindings.length === 0) {
    return [];
  }
  const targetRevision = resolvedCurrentTargetRevision(lease);
  const violations: LoopViolation[] = [];
  for (const binding of bindings) {
    const worktree = inventory.worktrees.find(
      (item) => item.path === binding.path && !item.prunable
    );
    const problems = [
      ...worktreeProblems(binding, worktree, targetRevision),
      ...attestationProblems(lease, binding),
    ];
    if (problems.length === 0) {
      continue;
    }
    violations.push({
      changeDigest: worktree?.changeDigest ?? null,
      code: "changelog-author-outside-release-surfaces",
      headSha: worktree?.headSha ?? null,
      message: `Changelog author ${binding.agentId} joined unit ${binding.unitId} after the shipment scope froze and may change only the release surfaces ${listed(binding.releaseSurfaces)}, but ${problems.join(", and ")}. Unit ${binding.unitId} is stale until no such change remains: restore those paths in ${binding.path} and integrate no commit that changes them. A commit the author attested stays in the review ledger, so that unit stays stale for this run; replan it, or ship that work in a fresh loop.`,
      path: binding.path,
    });
  }
  return violations;
};
