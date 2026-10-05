import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256Json } from "./hash.ts";
import { validateSchema } from "./schema.ts";
import type {
  LoopOpeningWorktree,
  LoopWorktreeLease,
  PreservedSourceOverrideReceipt,
  PreservedSourceOverrideRecord,
  ShipmentOutcomePath,
  ShipmentOutcomeReceipt,
  WorktreeClaim,
  WorktreeInventory,
} from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Splits a `loop record-outcome` receipt into the original receipt shape the
 * lease stores and the user-approved overrides its units carry. Older clients
 * strictly validate the lease, so overrides live in a sidecar beside it.
 */
export const splitShipmentOutcomeInput = (
  value: unknown
): {
  overrides: PreservedSourceOverrideReceipt[];
  receipt: ShipmentOutcomeReceipt;
} => {
  if (!(isRecord(value) && Array.isArray(value.units))) {
    return {
      overrides: [],
      receipt: validateSchema<ShipmentOutcomeReceipt>(
        "shipment-outcome",
        value
      ),
    };
  }
  const overrides: unknown[] = [];
  const units = value.units.map((unit: unknown) => {
    if (!(isRecord(unit) && "preservedSourceOverride" in unit)) {
      return unit;
    }
    const { preservedSourceOverride, ...entry } = unit;
    if (
      !isRecord(preservedSourceOverride) ||
      preservedSourceOverride.unitId !== entry.unitId
    ) {
      throw new SimpleChangesError(
        `Invalid shipment outcome: the preservedSourceOverride on unit ${String(entry.unitId)} must be an object naming that unit.`,
        EXIT_CODES.validation
      );
    }
    overrides.push(preservedSourceOverride);
    return entry;
  });
  const receipt = validateSchema<ShipmentOutcomeReceipt>("shipment-outcome", {
    ...value,
    units,
  });
  if (overrides.length === 0) {
    return { overrides: [], receipt };
  }
  return {
    overrides: validateSchema<PreservedSourceOverrideRecord>(
      "preserved-source-override",
      {
        overrides,
        receiptDigest: sha256Json(receipt),
        runId: receipt.runId,
        schemaVersion: 1,
      }
    ).overrides,
    receipt,
  };
};

/**
 * Re-joins an override sidecar with the exact outcome it was recorded for. A
 * sidecar for another run or receipt fails closed instead of being ignored.
 */
export const validatePreservedSourceOverrideRecord = (
  value: unknown,
  runId: string,
  receiptDigest: string
): PreservedSourceOverrideReceipt[] => {
  const record = validateSchema<PreservedSourceOverrideRecord>(
    "preserved-source-override",
    value
  );
  if (record.runId !== runId || record.receiptDigest !== receiptDigest) {
    throw new SimpleChangesError(
      "Preserved-source overrides do not match this run's recorded shipment outcome; record the outcome again.",
      EXIT_CODES.unsafe
    );
  }
  return record.overrides;
};

export interface PreservedSourceOverrideContext {
  claim: WorktreeClaim | undefined;
  controllerAgentId: string;
  current: WorktreeInventory | undefined;
  disposition: "delivered" | "target-equivalent";
  finalPaths: readonly ShipmentOutcomePath[];
  opening: LoopOpeningWorktree | undefined;
  openingEntries: ReadonlyMap<string, string | null>;
  originalPaths: readonly ShipmentOutcomePath[];
  override: PreservedSourceOverrideReceipt | undefined;
  registered: LoopWorktreeLease | undefined;
  runId: string;
  scopePaths: readonly string[];
  sourceEntry: (path: string) => string | null;
  sourceWorktree: string;
  targetEntry: (path: string) => string | null;
  targetRevision: string;
  unitId: string;
}

const preservedPathEvidenceFailure = (
  context: PreservedSourceOverrideContext & {
    override: PreservedSourceOverrideReceipt;
  }
): string | null => {
  const { finalPaths, openingEntries, override, scopePaths } = context;
  const scoped = new Set(scopePaths);
  const reviewed = new Map(override.paths.map((item) => [item.path, item]));
  const final = new Map(finalPaths.map((item) => [item.path, item.entry]));
  if (
    scoped.size !== scopePaths.length ||
    reviewed.size !== override.paths.length ||
    reviewed.size !== scoped.size ||
    final.size !== finalPaths.length ||
    final.size !== scoped.size
  ) {
    return "preserved-source override paths must cover every scoped target path exactly once";
  }
  for (const path of scopePaths) {
    const item = reviewed.get(path);
    if (!(item && openingEntries.has(path) && final.has(path))) {
      return `preserved-source override is missing exact path evidence for ${path}`;
    }
    const openingEntry = openingEntries.get(path) ?? null;
    const finalEntry = final.get(path) ?? null;
    if (
      item.sourceEntry !== openingEntry ||
      context.sourceEntry(path) !== openingEntry ||
      item.targetEntry !== finalEntry ||
      context.targetEntry(path) !== finalEntry
    ) {
      return `preserved source or final target entry changed for ${path}`;
    }
  }
  return null;
};

/** A manually approved dirty source remains in its author's claimed checkout. */
export const preservedSourceOverrideFailure = (
  context: PreservedSourceOverrideContext,
  recordedAt: string
): string | null => {
  const {
    claim,
    controllerAgentId,
    current,
    opening,
    originalPaths,
    registered,
    override,
    runId,
    sourceWorktree,
    targetRevision,
    unitId,
  } = context;
  if (!override) {
    return "manual user approval for the preserved source is missing";
  }
  if (
    context.disposition !== "target-equivalent" ||
    originalPaths.length > 0 ||
    !current ||
    current.isPrimary ||
    current.changes.length === 0 ||
    !registered ||
    registered.role !== "concurrent-author" ||
    !registered.claimId ||
    !registered.agentId ||
    !opening
  ) {
    return "preserved-source override requires a dirty, claimed, non-primary author source with no rename originals";
  }
  if (
    current.path !== sourceWorktree ||
    registered.path !== sourceWorktree ||
    opening.path !== sourceWorktree ||
    current.branch !== registered.branch ||
    current.branch !== opening.branch ||
    current.headSha !== registered.baselineHeadSha ||
    current.headSha !== opening.headSha ||
    current.changeDigest !== registered.baselineChangeDigest ||
    current.changeDigest !== opening.changeDigest
  ) {
    return "preserved source no longer matches its exact frozen branch, head, and status digest";
  }
  if (
    claim?.state !== "active" ||
    claim.claimId !== registered.claimId ||
    claim.path !== sourceWorktree ||
    claim.owner.agentId !== registered.agentId ||
    claim.branch !== current.branch
  ) {
    return "preserved source no longer has its unchanged active author claim";
  }
  const approvalTime = Date.parse(override.approvedAt);
  const reviewTime = Date.parse(override.reviewedAt);
  const recordTime = Date.parse(recordedAt);
  if (
    !(
      Number.isFinite(approvalTime) &&
      Number.isFinite(reviewTime) &&
      Number.isFinite(recordTime)
    ) ||
    approvalTime < reviewTime ||
    approvalTime > recordTime ||
    recordTime - approvalTime > 60 * 60 * 1000 ||
    !override.approvedBy.trim() ||
    !override.approvalReference.trim() ||
    !override.approvalReason.trim() ||
    override.approvedBy === controllerAgentId ||
    override.approvedBy === registered.agentId
  ) {
    return "manual user approval is missing, stale, or predates independent review";
  }
  if (
    !(current.branch && current.headSha) ||
    override.decision !== "semantically-equivalent" ||
    override.reviewerAgentId === controllerAgentId ||
    override.reviewerAgentId === registered.agentId ||
    !override.reviewerAgentId.trim() ||
    !override.reviewReference.trim() ||
    override.runId !== runId ||
    override.unitId !== unitId ||
    override.claimId !== registered.claimId ||
    override.sourceWorktree !== sourceWorktree ||
    override.sourceBranch !== current.branch ||
    override.sourceHeadRevision !== current.headSha ||
    override.sourceChangeDigest !== current.changeDigest ||
    override.targetRevision !== targetRevision
  ) {
    return "preserved-source override process evidence or exact run/source/target binding does not match";
  }
  return preservedPathEvidenceFailure({ ...context, override });
};
