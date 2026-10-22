import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256Json } from "./hash.ts";
import {
  HELD_UNITS_DIRECTORY,
  readImmutableRecoveryEvent,
  readReceiptSidecar,
  recoveryHistoryDirectory,
} from "./loop-lease-core.ts";
import { validateSchema } from "./schema.ts";
import type {
  ChangeUnit,
  HeldUnitHold,
  HeldUnitsRecord,
  LoopLease,
} from "./types.ts";

/**
 * After a run's shipment scope froze, `loop hold-unit` may move one scoped
 * unit to an explicit hold: its exact source stays preserved and the run
 * reports it as held, never as delivered or target-equivalent. Holds live in
 * a sidecar beside the lease, with immutable history events and a pinned
 * head. The lease of a run with holds also carries a `heldUnits` key bound to
 * them, which runtimes before 0.33.0 do not know, so they refuse that lease
 * entirely; a lease without holds keeps its earlier shape.
 */
export const HELD_UNIT_REASON_PREFIX = "Held by loop hold-unit: ";

type HeldUnitLease = Pick<
  LoopLease,
  "commonGitDirectory" | "heldUnits" | "runId" | "shipmentScope"
>;

/**
 * The digest the lease's `heldUnits` key carries: every hold's digest, in
 * record order. The key exists only on a run with holds, so a runtime that
 * predates holds refuses that lease, and a lease without holds keeps its
 * exact earlier shape and digest.
 */
export const heldUnitsDigest = (holds: readonly HeldUnitHold[]): string =>
  sha256Json(holds.map((hold) => hold.holdDigest));

const HELD_UNIT_EVENT_PATTERN = /^held-unit-([0-9a-f]{64})\.json$/u;

/** The immutable history event a hold writes when it is recorded. */
export interface HeldUnitEvent {
  holdDigest: string;
  kind: "held-unit";
  recordedAt: string;
  runId: string;
  unitId: string;
}

/**
 * Where a hold's immutable history event lives. Every event must name a hold
 * in the sidecar, so removing or replacing the sidecar fails closed.
 */
export const heldUnitEventPath = (
  commonGitDirectory: string,
  runId: string,
  holdDigest: string
): string =>
  resolve(
    recoveryHistoryDirectory(commonGitDirectory, runId),
    `held-unit-${holdDigest}.json`
  );

/**
 * The ref that keeps a held source head reachable, so no branch deletion, by
 * any runtime, can orphan the held commit. It is kept afterward.
 */
export const heldUnitPinRef = (runId: string, unitId: string): string =>
  `refs/simple-changes/held/${runId}/${unitId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Every hold event this run's history records, verified against its name.
const heldUnitEvents = (lease: HeldUnitLease): HeldUnitEvent[] => {
  const directory = recoveryHistoryDirectory(
    lease.commonGitDirectory,
    lease.runId
  );
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => HELD_UNIT_EVENT_PATTERN.test(name))
    .sort()
    .map((name) => {
      const event = readImmutableRecoveryEvent<object>(
        resolve(directory, name)
      );
      const digest = HELD_UNIT_EVENT_PATTERN.exec(name)?.[1];
      if (
        !(
          isRecord(event) &&
          event.kind === "held-unit" &&
          event.runId === lease.runId &&
          event.holdDigest === digest &&
          typeof event.unitId === "string" &&
          typeof event.recordedAt === "string"
        )
      ) {
        throw new SimpleChangesError(
          `The held-unit history event ${name} for ${lease.runId} is not one loop hold-unit wrote. Restore the run's history; never edit a hold.`,
          EXIT_CODES.unsafe
        );
      }
      return event as unknown as HeldUnitEvent;
    });
};

/** The held unit's paths in the shape of the scope's plan exclusions. */
export const heldUnitExclusions = (
  unit: Pick<ChangeUnit, "paths" | "sourceWorktree">,
  reason: string
): HeldUnitHold["exclusions"] =>
  unit.paths.map((path) => ({
    path,
    reason: `${HELD_UNIT_REASON_PREFIX}${reason}`,
    worktreePath: unit.sourceWorktree,
  }));

/** The digest a hold carries over every other field it records. */
export const heldUnitHoldDigest = (
  hold: Omit<HeldUnitHold, "holdDigest">
): string => sha256Json(hold);

const sameJson = (left: unknown, right: unknown): boolean =>
  sha256Json(left) === sha256Json(right);

const tampered = (runId: string, unitId: string, detail: string): never => {
  throw new SimpleChangesError(
    `The held-unit record for ${runId} is not the one loop hold-unit wrote for unit ${unitId}: ${detail}. Restore the record this run wrote; never edit or copy a hold.`,
    EXIT_CODES.unsafe
  );
};

// A hold is immutable: every field must still recompose into its own
// digests, and it must name exactly the frozen unit it held.
const assertHoldIntact = (lease: HeldUnitLease, hold: HeldUnitHold): void => {
  const { holdDigest, ...rest } = hold;
  const unitId = hold.unit.id;
  if (heldUnitHoldDigest(rest) !== holdDigest) {
    tampered(lease.runId, unitId, "its hold digest does not match");
  }
  if (sha256Json(hold.observation) !== hold.observationDigest) {
    tampered(lease.runId, unitId, "its observation digest does not match");
  }
  const { observation } = hold;
  const approver = hold.authorization.approvedBy.trim();
  if (
    approver === observation.controllerAgentId.trim() ||
    approver === observation.claim?.ownerAgentId.trim()
  ) {
    tampered(
      lease.runId,
      unitId,
      "its approver is the controller or the claim owner, not the user"
    );
  }
  if (
    observation.runId !== lease.runId ||
    observation.unitId !== unitId ||
    observation.unitDigest !== sha256Json(hold.unit) ||
    observation.source.worktree !== hold.unit.sourceWorktree ||
    !sameJson(
      observation.paths.map((item) => item.path),
      hold.unit.paths
    ) ||
    !sameJson(
      hold.exclusions,
      heldUnitExclusions(hold.unit, observation.reason)
    )
  ) {
    tampered(
      lease.runId,
      unitId,
      "it does not bind its own run, unit, source, and paths"
    );
  }
  const scoped = lease.shipmentScope?.plan.units.find(
    (unit) => unit.id === unitId
  );
  if (lease.shipmentScope && !(scoped && sameJson(scoped, hold.unit))) {
    tampered(
      lease.runId,
      unitId,
      "it does not match a unit of this run's frozen shipment scope"
    );
  }
};

/**
 * This run's holds, each verified intact; none when no sidecar exists. Throws
 * when the record names another run, repeats a unit, or no longer matches
 * what `loop hold-unit` recorded.
 */
export const readHeldUnits = (lease: HeldUnitLease): HeldUnitHold[] => {
  const holds = readHeldUnitRecord(lease);
  const events = heldUnitEvents(lease);
  // Each hold wrote an immutable history event when it was recorded, and
  // the two must match both ways: a removed, replaced, or truncated sidecar
  // no longer covers every event, and a hold added by hand has no event.
  for (const hold of holds) {
    if (
      !events.some(
        (event) =>
          event.holdDigest === hold.holdDigest && event.unitId === hold.unit.id
      )
    ) {
      tampered(
        lease.runId,
        hold.unit.id,
        "the run's history has no event for this hold"
      );
    }
  }
  for (const event of events) {
    if (
      !holds.some(
        (hold) =>
          hold.holdDigest === event.holdDigest && hold.unit.id === event.unitId
      )
    ) {
      throw new SimpleChangesError(
        `Unit ${event.unitId} was held in ${lease.runId} at ${event.recordedAt}, but the held-unit record no longer contains that hold. Restore the record this run wrote; nothing is cleaned or closed until then.`,
        EXIT_CODES.unsafe
      );
    }
  }
  // The lease carries the holds digest exactly when the run holds a unit.
  const marker = lease.heldUnits?.holdsDigest;
  if (
    holds.length === 0
      ? marker !== undefined
      : marker !== heldUnitsDigest(holds)
  ) {
    throw new SimpleChangesError(
      `The lease of ${lease.runId} and its held-unit record disagree about which units are held. Restore the record and lease this run wrote; nothing is cleaned or closed until then.`,
      EXIT_CODES.unsafe
    );
  }
  return holds;
};

const readHeldUnitRecord = (lease: HeldUnitLease): HeldUnitHold[] => {
  const stored = readReceiptSidecar(
    lease.commonGitDirectory,
    HELD_UNITS_DIRECTORY,
    lease.runId
  );
  if (stored === null) {
    return [];
  }
  const record = validateSchema<HeldUnitsRecord>("held-units", stored);
  if (record.runId !== lease.runId) {
    throw new SimpleChangesError(
      `The held-unit record for ${lease.runId} names run ${record.runId}. Restore the record this run wrote; do not copy another run's.`,
      EXIT_CODES.unsafe
    );
  }
  const seen = new Set<string>();
  for (const hold of record.holds) {
    if (seen.has(hold.unit.id)) {
      tampered(lease.runId, hold.unit.id, "it holds the unit twice");
    }
    seen.add(hold.unit.id);
    assertHoldIntact(lease, hold);
  }
  return record.holds;
};

/**
 * Refuses a recovery that closes a run as a whole when the run held a unit,
 * or its hold record cannot be read: such a close would report the held work
 * as equivalent or finished instead of held.
 */
export const assertNoHeldUnits = (
  lease: HeldUnitLease,
  action: string
): void => {
  const holds = readHeldUnits(lease);
  if (holds.length > 0) {
    throw new SimpleChangesError(
      `Loop ${lease.runId} held ${holds.map((hold) => hold.unit.id).join(", ")}, so ${action} cannot close it: that would report held work as finished. Record its outcome and run \`simple-changes loop finalize\`, which reports held units apart from delivered work, or replan the run.`,
      EXIT_CODES.unsafe
    );
  }
};

/** The IDs of this run's held units. */
export const heldUnitIds = (holds: readonly HeldUnitHold[]): Set<string> =>
  new Set(holds.map((hold) => hold.unit.id));

const key = (worktreePath: string, path: string): string =>
  `${worktreePath}\0${path}`;

/**
 * Proves that the frozen scope, with every held unit moved to its
 * exclusions, still accounts for every original path of every worktree
 * exactly once: delivered (a unit that is not held), preserved, or excluded.
 * Paths are keyed by worktree, so the same filename in two checkouts counts
 * once in each. A scope exclusion without a worktree covers the one opening
 * change with that path.
 */
export const assertHeldScopeConservation = (
  scope: NonNullable<LoopLease["shipmentScope"]>,
  holds: readonly HeldUnitHold[]
): void => {
  const held = heldUnitIds(holds);
  const exclusionKeys = (exclusion: {
    path: string;
    worktreePath?: string;
  }): string[] => {
    if (exclusion.worktreePath) {
      return [key(exclusion.worktreePath, exclusion.path)];
    }
    const matches = scope.openingChanges.filter(
      (change) => change.path === exclusion.path
    );
    return matches.length === 1 && matches[0]
      ? [key(matches[0].worktreePath, exclusion.path)]
      : [key("(unbound)", exclusion.path)];
  };
  const original = [
    ...scope.plan.units.flatMap((unit) =>
      unit.paths.map((path) => key(unit.sourceWorktree, path))
    ),
    ...scope.plan.preserved.flatMap((item) =>
      item.paths.map((path) => key(item.worktreePath, path))
    ),
    ...scope.plan.exclusions.flatMap(exclusionKeys),
  ];
  const accounted = [
    ...scope.plan.units
      .filter((unit) => !held.has(unit.id))
      .flatMap((unit) =>
        unit.paths.map((path) => key(unit.sourceWorktree, path))
      ),
    ...scope.plan.preserved.flatMap((item) =>
      item.paths.map((path) => key(item.worktreePath, path))
    ),
    ...scope.plan.exclusions.flatMap(exclusionKeys),
    ...holds.flatMap((hold) => hold.exclusions.flatMap(exclusionKeys)),
  ];
  const seen = new Set<string>();
  for (const item of accounted) {
    if (seen.has(item)) {
      throw new SimpleChangesError(
        `Holding would account for ${item.replace("\0", ":")} more than once; a held unit's paths must leave the delivered set and join the exclusions exactly once.`,
        EXIT_CODES.unsafe
      );
    }
    seen.add(item);
  }
  const expected = new Set(original);
  const missing = [...expected].filter((item) => !seen.has(item));
  const unexpected = [...seen].filter((item) => !expected.has(item));
  if (
    expected.size !== original.length ||
    missing.length > 0 ||
    unexpected.length > 0
  ) {
    const [first] = [...missing, ...unexpected];
    throw new SimpleChangesError(
      `Holding would not conserve the frozen scope's paths${first ? `: ${first.replace("\0", ":")}` : ""}. Every original path must stay delivered, preserved, or excluded exactly once.`,
      EXIT_CODES.unsafe
    );
  }
};
