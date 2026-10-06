import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256Json } from "./hash.ts";
import { validateSchema } from "./schema.ts";
import type {
  LoopOpeningWorktree,
  LoopWorktreeLease,
  PreservedSourceOverrideReceipt,
  PreservedSourceOverrideRecord,
  ShipmentOutcomeInput,
  ShipmentOutcomePath,
  ShipmentOutcomeReceipt,
  WorktreeClaim,
  WorktreeInventory,
} from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const OVERRIDES_UNBOUND =
  "Preserved-source overrides do not match this run's recorded shipment outcome; record the outcome again.";

/**
 * The receipt exactly as `loop record-outcome` received it: each override back
 * on the one unit it names. The recorded outcome digest is this receipt's
 * digest, so every override field, not only the receipt the lease stores, is
 * bound to the lease. Without overrides it is the stored receipt itself.
 */
export const composeShipmentOutcome = (
  receipt: ShipmentOutcomeReceipt,
  overrides: readonly PreservedSourceOverrideReceipt[]
): ShipmentOutcomeInput => {
  const byUnit = new Map(overrides.map((item) => [item.unitId, item]));
  if (
    byUnit.size !== overrides.length ||
    overrides.some(
      (item) =>
        receipt.units.filter((unit) => unit.unitId === item.unitId).length !== 1
    )
  ) {
    throw new SimpleChangesError(
      "Invalid shipment outcome: each preservedSourceOverride must name exactly one recorded unit, at most once.",
      EXIT_CODES.validation
    );
  }
  return {
    ...receipt,
    units: receipt.units.map((unit) => {
      const override = byUnit.get(unit.unitId);
      return override ? { ...unit, preservedSourceOverride: override } : unit;
    }),
  };
};

/**
 * Splits a `loop record-outcome` receipt into the original receipt shape the
 * lease stores and the user-approved overrides its units carry, and digests
 * the complete receipt. Older clients strictly validate the lease, so
 * overrides live in a sidecar beside it.
 */
export const splitShipmentOutcomeInput = (
  value: unknown
): {
  overrides: PreservedSourceOverrideReceipt[];
  receipt: ShipmentOutcomeReceipt;
  receiptDigest: string;
} => {
  if (!(isRecord(value) && Array.isArray(value.units))) {
    const receipt = validateSchema<ShipmentOutcomeReceipt>(
      "shipment-outcome",
      value
    );
    return { overrides: [], receipt, receiptDigest: sha256Json(receipt) };
  }
  const overrides: PreservedSourceOverrideReceipt[] = [];
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
    // Its shape is validated with the sidecar record below.
    overrides.push(
      preservedSourceOverride as unknown as PreservedSourceOverrideReceipt
    );
    return entry;
  });
  const receipt = validateSchema<ShipmentOutcomeReceipt>("shipment-outcome", {
    ...value,
    units,
  });
  if (overrides.length === 0) {
    return { overrides: [], receipt, receiptDigest: sha256Json(receipt) };
  }
  const receiptDigest = sha256Json(composeShipmentOutcome(receipt, overrides));
  const record = validateSchema<PreservedSourceOverrideRecord>(
    "preserved-source-override",
    { overrides, receiptDigest, runId: receipt.runId, schemaVersion: 1 }
  );
  return { overrides: record.overrides, receipt, receiptDigest };
};

/**
 * Re-joins the override sidecar with the exact outcome it was recorded for.
 * The stored receipt and the sidecar's overrides must recompose into the
 * complete receipt the recorded digest names, so editing any override field,
 * substituting another run's sidecar, or removing the sidecar of an outcome
 * recorded with overrides fails closed. `sidecar` is null when no file exists.
 */
export const recordedPreservedSourceOverrides = (
  sidecar: unknown,
  runId: string,
  receipt: ShipmentOutcomeReceipt,
  receiptDigest: string
): PreservedSourceOverrideReceipt[] => {
  if (sidecar === null) {
    if (sha256Json(receipt) !== receiptDigest) {
      throw new SimpleChangesError(
        `Shipment outcome for ${runId} was recorded with preserved-source overrides whose sidecar is missing; record the outcome again.`,
        EXIT_CODES.unsafe
      );
    }
    return [];
  }
  const record = validateSchema<PreservedSourceOverrideRecord>(
    "preserved-source-override",
    sidecar
  );
  let recomposed: string | null = null;
  try {
    recomposed = sha256Json(composeShipmentOutcome(receipt, record.overrides));
  } catch {
    // An override that names no recorded unit cannot be this outcome's.
  }
  if (
    record.runId !== runId ||
    record.receiptDigest !== receiptDigest ||
    recomposed !== receiptDigest
  ) {
    throw new SimpleChangesError(OVERRIDES_UNBOUND, EXIT_CODES.unsafe);
  }
  return record.overrides;
};

// Independence compares agent IDs without surrounding whitespace, so a padded
// controller or author ID cannot pass as another reviewer or approver.
const sameAgent = (left: string, right: string): boolean =>
  left.trim() === right.trim();

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
    sameAgent(override.approvedBy, controllerAgentId) ||
    sameAgent(override.approvedBy, registered.agentId)
  ) {
    return "manual user approval is missing, stale, or predates independent review";
  }
  if (
    !(current.branch && current.headSha) ||
    override.decision !== "semantically-equivalent" ||
    sameAgent(override.reviewerAgentId, controllerAgentId) ||
    sameAgent(override.reviewerAgentId, registered.agentId) ||
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
