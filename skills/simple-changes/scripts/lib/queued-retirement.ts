import { targetContainmentAudit } from "./cleanup-core.ts";
import { completeObjectId } from "./git-complete.ts";
import {
  captureInventory,
  isLossyName,
  locateRepository,
} from "./inventory.ts";
import { readLeaseFromCommonDirectory } from "./loop-lease-core.ts";
import { worktreeSourceEntry } from "./loop-lease-shipment.ts";
import { liveClaimFor } from "./loop-lease-verify.ts";
import {
  filesBeyondHead,
  ignoredFilesNote,
  type QueuedWorktreesRecord,
  readQueuedWorktreesRecords,
  writeQueuedWorktreesRecord,
} from "./queued-completion.ts";
import { sourceWorktreeDelta } from "./source-worktree-delta.ts";
import type { RepositoryInventory, WorktreeInventory } from "./types.ts";
import {
  assertNoGitOperation,
  readCoordinationDocumentFromCommonDirectory,
} from "./worktree-coordination.ts";
import {
  type CleanupClassification,
  removeProvenWorktrees,
  withCleanupLocks,
} from "./worktree-maintenance.ts";

/** What a Queue or Sweep start did with earlier runs' kept worktrees. */
export interface QueuedRetirementReport {
  /** Merged worktrees left in place, each with the check that kept it. */
  kept: { path: string; reason: string }[];
  /** Why nothing, or not everything, could be checked. Never a failure. */
  notes: string[];
  removed: string[];
}

type Removable = CleanupClassification["removable"][number];

type Verdict =
  | { removable: Removable }
  | { reason: string }
  // Not due: its work is not in the target yet, so it is not reported.
  | "waiting"
  // No longer the checkout the run left: forgotten, never removed.
  | "gone";

interface RetirementContext {
  inventory: RepositoryInventory;
  targetRevision: string;
}

/**
 * Why a clean checkout whose work the target contains still holds something
 * that exists nowhere else, or null. Each check is proven; one that cannot
 * be read keeps the checkout.
 */
const unsafeToRemove = (
  worktree: WorktreeInventory,
  headSha: string
): string | null => {
  try {
    assertNoGitOperation(worktree.path);
  } catch {
    return "A Git operation is in progress in it, or its state could not be read.";
  }
  const delta = sourceWorktreeDelta(worktree.path, headSha, (path) =>
    worktreeSourceEntry(worktree.path, path)
  );
  if ("failure" in delta) {
    return `Its files could not be compared with its commit: ${delta.failure}.`;
  }
  if (delta.entries.size > 0) {
    return `It holds changes Git's status does not show (${[...delta.entries.keys()].slice(0, 5).join(", ")}).`;
  }
  const extras = filesBeyondHead(worktree.path, headSha);
  if (extras === null) {
    return "Its files could not be listed.";
  }
  return extras.length > 0 ? ignoredFilesNote(worktree.path, extras) : null;
};

const verdictFor = (
  { inventory, targetRevision }: RetirementContext,
  recorded: QueuedWorktreesRecord["worktrees"][number]
): Verdict => {
  const { commonGitDirectory, primaryCheckout } = inventory.repository;
  const worktree = inventory.worktrees.find(
    (item) => item.path === recorded.path
  );
  // A path that is gone, or now holds another branch, is not this run's
  // registration any more; a foreign checkout is never touched.
  if (
    !worktree ||
    worktree.isPrimary ||
    worktree.prunable ||
    worktree.branch !== recorded.branch ||
    isLossyName(worktree.branch)
  ) {
    return "gone";
  }
  if (!worktree.headSha) {
    return { reason: "Its commit could not be read." };
  }
  let containment: Removable["containment"] | null;
  try {
    containment = targetContainmentAudit(
      primaryCheckout,
      targetRevision,
      worktree.headSha
    ).method;
  } catch {
    containment = null;
  }
  if (!containment) {
    return "waiting";
  }
  if (
    liveClaimFor(
      readCoordinationDocumentFromCommonDirectory(commonGitDirectory),
      commonGitDirectory,
      worktree.path
    )
  ) {
    return { reason: "A worktree claim holds it." };
  }
  if (worktree.changes.length > 0) {
    return { reason: "It has uncommitted changes." };
  }
  const unsafe = unsafeToRemove(worktree, worktree.headSha);
  return unsafe
    ? { reason: unsafe }
    : {
        removable: {
          containment,
          worktree: { ...worktree, headSha: worktree.headSha },
        },
      };
};

const retireUnderLocks = (
  repositoryPath: string,
  records: readonly QueuedWorktreesRecord[],
  report: QueuedRetirementReport
): void => {
  const inventory = captureInventory(repositoryPath);
  const { commonGitDirectory, primaryCheckout } = inventory.repository;
  if (readLeaseFromCommonDirectory(commonGitDirectory)) {
    // A loop record exists, so clean-up belongs to that loop's lifecycle.
    return;
  }
  let targetRevision: string | null;
  try {
    targetRevision = completeObjectId(
      primaryCheckout,
      `${inventory.targetRef}^{commit}`
    );
  } catch {
    targetRevision = null;
  }
  if (!targetRevision) {
    report.notes.push(
      `${inventory.targetRef} could not be read, so no earlier worktree was checked or removed.`
    );
    return;
  }
  const context: RetirementContext = { inventory, targetRevision };
  const removable: Removable[] = [];
  const forgotten = new Set<string>();
  for (const recorded of records.flatMap((record) => record.worktrees)) {
    const verdict = verdictFor(context, recorded);
    if (verdict === "gone") {
      forgotten.add(recorded.path);
    } else if (verdict !== "waiting" && "reason" in verdict) {
      report.kept.push({ path: recorded.path, reason: verdict.reason });
    } else if (verdict !== "waiting") {
      removable.push(verdict.removable);
    }
  }
  // The same removal `prune` and `worktree cleanup` use: it reads each
  // checkout again, removes it without force, and deletes its branch only
  // while that still points at the removed head.
  const removed = removeProvenWorktrees(
    repositoryPath,
    inventory.targetRef,
    removable,
    report.notes
  );
  for (const { path } of removed) {
    report.removed.push(path);
    forgotten.add(path);
  }
  for (const record of records) {
    const worktrees = record.worktrees.filter(
      (item) => !forgotten.has(item.path)
    );
    if (worktrees.length !== record.worktrees.length) {
      writeQueuedWorktreesRecord(commonGitDirectory, { ...record, worktrees });
    }
  }
};

/**
 * Before a Queue or Sweep run starts, removes the worktrees that earlier
 * Queue and Sweep runs created and kept, once the target contains their
 * work. A worktree goes only when every check proves nothing in it exists
 * only there: it is still that run's checkout on the same branch, no claim
 * holds it, its head is in the freshly read target, its status is clean, no
 * Git operation is in progress, its files equal its commit even where
 * status is told not to look, and it holds no file Git ignores. Anything
 * else, or anything that cannot be read, keeps the worktree and says why.
 * This never throws and never stops the run that follows.
 */
export const retireMergedQueuedWorktrees = (
  repositoryPath: string
): QueuedRetirementReport => {
  const report: QueuedRetirementReport = { kept: [], notes: [], removed: [] };
  try {
    const { commonGitDirectory } = locateRepository(repositoryPath).repository;
    const records = readQueuedWorktreesRecords(commonGitDirectory);
    if (records.length > 0) {
      withCleanupLocks(commonGitDirectory, "retire queued worktrees", () =>
        retireUnderLocks(repositoryPath, records, report)
      );
    }
  } catch (error) {
    report.notes.push(
      `Earlier runs' worktrees were not checked: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return report;
};
