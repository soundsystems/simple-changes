import { isLossyName } from "./inventory.ts";
import type {
  LoopOpeningWorktree,
  LoopWorktreeLease,
  PreservedSourceHandoffReceipt,
  ShipmentOutcomePath,
  WorktreeClaim,
  WorktreeInventory,
  WorktreePauseReceipt,
} from "./types.ts";

// Independence compares agent IDs without surrounding whitespace, so a padded
// controller or owner ID cannot pass as another reviewer or approver.
const sameAgent = (left: string, right: string): boolean =>
  left.trim() === right.trim();

const APPROVAL_WINDOW_MS = 60 * 60 * 1000;

/** The committed copy, read from Git only after the cheaper checks pass. */
export interface PreservedSourceHandoffCopy {
  /** Paths the copy commit changed against its only parent; null otherwise. */
  changedPaths: () => readonly string[] | null;
  /** Whether the copy commit is contained in the run's opening target. */
  containedInOpeningTarget: () => boolean;
  /** Whether the copy commit is contained in the bound final target. */
  containedInTarget: () => boolean;
  /** The copy commit's tree entry for a path. */
  entry: (path: string) => string | null;
}

export interface PreservedSourceHandoffContext {
  claim: WorktreeClaim | undefined;
  commonGitDirectory: string;
  controllerAgentId: string;
  copy: PreservedSourceHandoffCopy;
  current: WorktreeInventory | undefined;
  disposition: "delivered" | "target-equivalent";
  finalPaths: readonly ShipmentOutcomePath[];
  handoff: PreservedSourceHandoffReceipt | undefined;
  opening: LoopOpeningWorktree | undefined;
  openingEntries: ReadonlyMap<string, string | null>;
  originalPaths: readonly ShipmentOutcomePath[];
  pauseReceipt: WorktreePauseReceipt | undefined;
  registered: LoopWorktreeLease | undefined;
  runId: string;
  /** When the run started; the owner's claim must be older. */
  runStartedAt: string;
  scopePaths: readonly string[];
  sourceEntry: (path: string) => string | null;
  sourceWorktree: string;
  targetEntry: (path: string) => string | null;
  targetRevision: string;
  unitId: string;
}

type CheckedContext = PreservedSourceHandoffContext & {
  claim: WorktreeClaim;
  current: WorktreeInventory;
  handoff: PreservedSourceHandoffReceipt;
  pauseReceipt: WorktreePauseReceipt;
  registered: LoopWorktreeLease;
};

const registrationFailure = (
  context: PreservedSourceHandoffContext
): string | null => {
  const { current, opening, originalPaths, registered } = context;
  if (
    context.disposition !== "delivered" ||
    originalPaths.length > 0 ||
    !current ||
    current.isPrimary ||
    current.changes.length === 0 ||
    !registered ||
    registered.role !== "preserved" ||
    registered.createdByRun ||
    registered.coordinationState !== "adopted-preserved" ||
    !registered.claimId ||
    !registered.pauseReceiptId ||
    !opening
  ) {
    return "preserved-source handoff requires a delivered unit from a dirty, non-primary source the run registered as preserved through an accepted pause, with no rename originals";
  }
  if (
    current.path !== context.sourceWorktree ||
    registered.path !== context.sourceWorktree ||
    opening.path !== context.sourceWorktree ||
    isLossyName(current.branch) ||
    current.branch !== registered.branch ||
    current.branch !== opening.branch ||
    !current.headSha ||
    current.headSha !== registered.baselineHeadSha ||
    current.headSha !== opening.headSha ||
    current.changeDigest !== registered.baselineChangeDigest ||
    current.changeDigest !== opening.changeDigest
  ) {
    return "preserved source no longer matches its exact opening and accepted branch, head, and status digest";
  }
  return null;
};

// The owner's own preserve-in-place pause for this run, which the controller
// accepted, still records the source exactly, and the claim it paused is the
// owner's, older than the run, and still held as adopted-preserved.
const ownershipFailure = (context: CheckedContext): string | null => {
  const { claim, current, handoff, pauseReceipt, registered } = context;
  if (
    pauseReceipt.receiptId !== registered.pauseReceiptId ||
    pauseReceipt.claimId !== registered.claimId ||
    pauseReceipt.requestingRunId !== context.runId ||
    pauseReceipt.disposition !== "preserve-in-place" ||
    pauseReceipt.path !== current.path ||
    pauseReceipt.branch !== current.branch ||
    pauseReceipt.headSha !== current.headSha ||
    pauseReceipt.changeDigest !== current.changeDigest
  ) {
    return "the accepted preserve-in-place pause for this run no longer records this exact source";
  }
  const claimCreated = Date.parse(claim.createdAt);
  const runStarted = Date.parse(context.runStartedAt);
  if (
    claim.claimId !== registered.claimId ||
    claim.state !== "adopted-preserved" ||
    claim.commonGitDirectory !== context.commonGitDirectory ||
    claim.path !== current.path ||
    claim.branch !== current.branch ||
    claim.headSha !== current.headSha ||
    claim.changeDigest !== current.changeDigest ||
    !(Number.isFinite(claimCreated) && Number.isFinite(runStarted)) ||
    claimCreated > runStarted
  ) {
    return "preserved source no longer has its original owner's accepted claim";
  }
  if (
    claim.owner.agentId !== pauseReceipt.ownerAgentId ||
    handoff.ownerAgentId !== claim.owner.agentId ||
    !handoff.ownerAgentId.trim() ||
    sameAgent(handoff.ownerAgentId, context.controllerAgentId)
  ) {
    return "preserved-source handoff names a different owner than the one who claimed and paused the source";
  }
  return null;
};

const approvalFailure = (
  context: CheckedContext,
  recordedAt: string
): string | null => {
  const { controllerAgentId, handoff } = context;
  const approvalTime = Date.parse(handoff.approvedAt);
  const reviewTime = Date.parse(handoff.reviewedAt);
  const recordTime = Date.parse(recordedAt);
  if (
    !(
      Number.isFinite(approvalTime) &&
      Number.isFinite(reviewTime) &&
      Number.isFinite(recordTime)
    ) ||
    approvalTime < reviewTime ||
    approvalTime > recordTime ||
    recordTime - approvalTime > APPROVAL_WINDOW_MS ||
    handoff.preservation !== "keep-source-in-place" ||
    !handoff.approvedBy.trim() ||
    !handoff.approvalReference.trim() ||
    !handoff.approvalReason.trim() ||
    sameAgent(handoff.approvedBy, controllerAgentId) ||
    sameAgent(handoff.approvedBy, handoff.ownerAgentId)
  ) {
    return "manual user approval to keep the source in place is missing, stale, or predates independent review";
  }
  if (
    handoff.decision !== "reviewed-handoff" ||
    !handoff.reviewerAgentId.trim() ||
    !handoff.reviewReference.trim() ||
    sameAgent(handoff.reviewerAgentId, controllerAgentId) ||
    sameAgent(handoff.reviewerAgentId, handoff.ownerAgentId)
  ) {
    return "independent review of the handed-off target entries is missing";
  }
  return null;
};

const bindingFailure = (context: CheckedContext): string | null => {
  const { current, handoff, registered } = context;
  if (
    handoff.runId !== context.runId ||
    handoff.unitId !== context.unitId ||
    handoff.claimId !== registered.claimId ||
    handoff.pauseReceiptId !== registered.pauseReceiptId ||
    handoff.sourceWorktree !== context.sourceWorktree ||
    handoff.sourceBranch !== current.branch ||
    handoff.sourceHeadRevision !== current.headSha ||
    handoff.sourceChangeDigest !== current.changeDigest ||
    handoff.targetRevision !== context.targetRevision
  ) {
    return "preserved-source handoff does not bind this exact run, unit, claim, pause, source, and target";
  }
  return null;
};

const pathFailure = (context: CheckedContext): string | null => {
  const { copy, finalPaths, handoff, openingEntries, scopePaths } = context;
  const scoped = new Set(scopePaths);
  const reviewed = new Map(handoff.paths.map((item) => [item.path, item]));
  const final = new Map(finalPaths.map((item) => [item.path, item.entry]));
  if (
    scoped.size !== scopePaths.length ||
    reviewed.size !== handoff.paths.length ||
    reviewed.size !== scoped.size ||
    final.size !== finalPaths.length ||
    final.size !== scoped.size
  ) {
    return "preserved-source handoff paths must cover every scoped path exactly once, each with its reviewed target entry";
  }
  for (const path of scopePaths) {
    const item = reviewed.get(path);
    if (!(item && openingEntries.has(path) && final.has(path))) {
      return `preserved-source handoff is missing reviewed path evidence for ${path}`;
    }
    const openingEntry = openingEntries.get(path) ?? null;
    if (
      item.sourceEntry !== openingEntry ||
      context.sourceEntry(path) !== openingEntry
    ) {
      return `preserved source entry changed for ${path}`;
    }
    if (item.copyEntry !== openingEntry || copy.entry(path) !== openingEntry) {
      return `committed copy ${handoff.copyRevision} does not hold the preserved source bytes for ${path}`;
    }
    const finalEntry = final.get(path) ?? null;
    if (
      item.targetEntry !== finalEntry ||
      context.targetEntry(path) !== finalEntry
    ) {
      return `final target no longer holds the reviewed entry for ${path}`;
    }
  }
  return null;
};

// The copy commit is one this run shipped: its only changes are scoped paths
// of this unit, it is in the final target, and the opening target lacked it.
const provenanceFailure = (context: CheckedContext): string | null => {
  const { copy, handoff } = context;
  const scoped = new Set(context.scopePaths);
  const changed = copy.changedPaths();
  if (
    !changed ||
    changed.length === 0 ||
    changed.some((path) => !scoped.has(path))
  ) {
    return `committed copy ${handoff.copyRevision} must be a single-parent commit that changes only this unit's scoped paths`;
  }
  if (!copy.containedInTarget() || copy.containedInOpeningTarget()) {
    return `committed copy ${handoff.copyRevision} is not a commit this run delivered to the final target`;
  }
  return null;
};

/**
 * Why a user-approved handoff of a preserved source does not hold, or null
 * when it does. The source stays dirty in place, detached or on a branch,
 * under the original owner's claim and that owner's accepted
 * preserve-in-place pause for this run, while a committed copy of its exact
 * bytes and independently reviewed target entries account for the unit.
 */
export const preservedSourceHandoffFailure = (
  context: PreservedSourceHandoffContext,
  recordedAt: string
): string | null => {
  const { claim, current, handoff, pauseReceipt, registered } = context;
  if (!handoff) {
    return "manual user approval for the preserved-source handoff is missing";
  }
  const registration = registrationFailure(context);
  if (registration) {
    return registration;
  }
  if (!(current && registered)) {
    return "preserved-source handoff requires a registered source";
  }
  if (!(claim && pauseReceipt)) {
    return "preserved source no longer has its original owner's accepted claim and pause";
  }
  const checked: CheckedContext = {
    ...context,
    claim,
    current,
    handoff,
    pauseReceipt,
    registered,
  };
  return (
    ownershipFailure(checked) ??
    approvalFailure(checked, recordedAt) ??
    bindingFailure(checked) ??
    pathFailure(checked) ??
    provenanceFailure(checked)
  );
};
