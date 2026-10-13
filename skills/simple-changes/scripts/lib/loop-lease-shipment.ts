import { createHash } from "node:crypto";
import { lstatSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { targetContainsRevision } from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256Json } from "./hash.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import {
  assertControllerActive,
  controllerLifecycle,
  currentTargetRevision,
  effectiveShipmentScopeFrozenAt,
  matchingOverride,
  ownerProcessEvidence,
  PRESERVED_SOURCE_OVERRIDE_DIRECTORY,
  requiredRunId,
  requiredText,
  requireLease,
  resolvedCurrentTargetRevision,
  scopeInvariantDigest,
  withMutationEvidence,
  withStateLock,
  writeLease,
  writeReceiptSidecar,
} from "./loop-lease-core.ts";
import {
  registeredController,
  unmutatedCloseReady,
  verificationAgainst,
} from "./loop-lease-verify.ts";
import { assertSafeRelativePath } from "./path-safety.ts";
import { validatePlanConservation } from "./planner.ts";
import {
  preservedSourceOverrideFailure,
  splitShipmentOutcomeInput,
} from "./preserved-source-override.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";
import type {
  ChangePlan,
  LoopLease,
  LoopVerification,
  PreservedSourceOverrideReceipt,
  RepositoryInventory,
  ShipmentOutcomeReceipt,
} from "./types.ts";
import {
  readCoordinationDocumentFromCommonDirectory,
  withWorktreeCoordinationLock,
} from "./worktree-coordination.ts";

export const LS_TREE_ENTRY_PATTERN = /^(\d+)\s+(blob|commit)\s+([0-9a-f]+)\t/u;

export interface ShipmentScopeReceipt {
  includedPaths: number;
  planDigest: string;
  preservedPaths: number;
  recordedAt: string;
  runId: string;
  summary: string;
}

const shipmentScopeSummary = (
  plan: ChangePlan,
  inventory: RepositoryInventory
): string => {
  const includedPaths = plan.units.reduce(
    (count, unit) => count + unit.paths.length,
    0
  );
  const preservedPaths = plan.preserved.reduce(
    (count, item) => count + item.paths.length,
    0
  );
  const branchFor = (worktreePath: string): string => {
    const worktree = inventory.worktrees.find(
      (candidate) => candidate.path === worktreePath
    );
    return (
      worktree?.branch ??
      (worktree?.headSha
        ? `detached@${worktree.headSha.slice(0, 8)}`
        : "detached")
    );
  };
  const lines = [
    `Pre-ship scope: ${plan.units.length} work item(s), ${includedPaths} changed path(s).`,
    "Included:",
    ...plan.units.map(
      (unit) =>
        `- ${unit.title}: ${unit.outcome} Branch ${branchFor(unit.sourceWorktree)}; worktree ${unit.sourceWorktree}.`
    ),
  ];
  if (plan.preserved.length > 0) {
    lines.push(
      "Preserved:",
      ...plan.preserved.map(
        (item) =>
          `- ${item.reason} Branch ${branchFor(item.worktreePath)}; worktree ${item.worktreePath}.`
      )
    );
  }
  if (plan.exclusions.length > 0) {
    lines.push(
      "Excluded:",
      ...plan.exclusions.map(
        (item) =>
          `- ${item.path}: ${item.reason}${item.worktreePath ? ` Worktree ${item.worktreePath}.` : ""}`
      )
    );
  }
  lines.push(
    `${preservedPaths} path(s) preserved; ${plan.exclusions.length} path(s) explicitly excluded. No changed path is unaccounted for.`
  );
  return lines.join("\n");
};

const worktreeSourceEntry = (
  worktreePath: string,
  path: string
): string | null => {
  assertSafeRelativePath(worktreePath, path);
  const absolutePath = resolve(worktreePath, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (stat.isDirectory()) {
    const revision = runGit(absolutePath, ["rev-parse", "HEAD"], true);
    return revision.exitCode === 0
      ? `160000:commit:${revision.stdout.trim()}`
      : null;
  }
  let objectId: string;
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolutePath, { encoding: "buffer" });
    const objectFormat = runGit(worktreePath, [
      "rev-parse",
      "--show-object-format",
    ]).stdout.trim();
    objectId = createHash(objectFormat)
      .update(`blob ${target.byteLength}\0`)
      .update(target)
      .digest("hex");
  } else {
    objectId = runGit(worktreePath, [
      "hash-object",
      `--path=${path}`,
      "--",
      path,
    ]).stdout.trim();
  }
  const executable = stat.mode
    .toString(8)
    .slice(-3)
    .split("")
    .some((digit) => Number(digit) % 2 === 1);
  let mode = "100644";
  if (stat.isSymbolicLink()) {
    mode = "120000";
  } else if (executable) {
    mode = "100755";
  }
  return `${mode}:blob:${objectId}`;
};

const shortRevision = (revision: string | null): string =>
  revision ? revision.slice(0, 12) : "(unresolved)";

// A lease records these at `loop start`. Without them it predates scoped
// record-scope checks, and its first scope keeps the whole-inventory rule.
const hasScopedOpeningInvariants = (
  lease: LoopLease
): lease is LoopLease & {
  openingInvariantDigest: string;
  openingWorktrees: NonNullable<LoopLease["openingWorktrees"]>;
} => Boolean(lease.openingInvariantDigest && lease.openingWorktrees);

// A first scope can still be recorded only by an active controller of a run
// that owes one and has not frozen it by relinquishing.
const owesFirstScope = (lease: LoopLease): boolean =>
  lease.shipmentScopeRequired === true &&
  !lease.shipmentScope &&
  !effectiveShipmentScopeFrozenAt(lease) &&
  controllerLifecycle(lease).status === "active";

/**
 * Describes how a worktree differs from the exact state `loop start` saw, or
 * returns null when its branch, head, and content digest are all unchanged.
 * A first shipment scope may only package bytes that were present then.
 */
const openingWorktreeDrift = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  path: string
): string | null => {
  const opening = lease.openingWorktrees?.find(
    (worktree) => worktree.path === path
  );
  if (!opening) {
    return "it was not in the loop-start inventory";
  }
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === path
  );
  if (!current) {
    return "it is missing";
  }
  if (current.branch !== opening.branch) {
    return `its branch moved from ${opening.branch ?? "(detached)"} to ${current.branch ?? "(detached)"}`;
  }
  if (current.headSha !== opening.headSha) {
    return `its head moved from ${shortRevision(opening.headSha)} to ${shortRevision(current.headSha)}`;
  }
  if (current.changeDigest !== opening.changeDigest) {
    return "its staged, unstaged, or untracked content changed";
  }
  return null;
};

/**
 * The first plan-independent reason a first shipment scope can no longer be
 * recorded, or null. Unrelated changes (claimed authors' edits and commits,
 * other branches, stashes, late claimed worktrees) do not count: the plan
 * accounts for them from the current inventory. What still counts is a moved
 * target, changed policy, capabilities, remote bindings or target binding, and
 * a changed controller checkout. A lease that predates these invariants keeps
 * the old rule: the whole-repository inventory must equal its opening digest.
 */
const openingScopeFailure = (
  lease: LoopLease,
  inventory: RepositoryInventory
): string | null => {
  if (!hasScopedOpeningInvariants(lease)) {
    return inventory.baselineDigest === lease.baselineDigest
      ? null
      : `Shipment scope must match the exact unchanged opening repository inventory: loop ${lease.runId} predates scoped record-scope checks, and the repository changed after it started.`;
  }
  const targetRevision = resolvedCurrentTargetRevision(lease);
  if (targetRevision !== lease.targetRevision) {
    return `Target ${lease.targetRef} moved from ${shortRevision(lease.targetRevision)} to ${shortRevision(targetRevision)} after loop ${lease.runId} started, so a first shipment scope can no longer be recorded against the pinned target revision.`;
  }
  if (scopeInvariantDigest(inventory) !== lease.openingInvariantDigest) {
    return `Repository policy, discovered capabilities, remote bindings, or the target binding changed after loop ${lease.runId} started, so a first shipment scope can no longer be recorded.`;
  }
  const controller = registeredController(lease);
  const controllerDrift = controller
    ? openingWorktreeDrift(lease, inventory, controller.path)
    : "no controller checkout is registered";
  if (controllerDrift) {
    return `Controller checkout ${controller?.path ?? "(none)"} changed after loop ${lease.runId} started: ${controllerDrift}. Scoped source bytes must be the ones registered at loop start.`;
  }
  return null;
};

// The next step after a first scope is refused for a reason the plan cannot
// fix. Only a run with no mutation evidence may close through `loop end`; any
// other run must relinquish through finalization and be replanned.
const firstScopeRecoveryStep = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification
): string => {
  if (unmutatedCloseReady(lease, inventory, verification)) {
    return ` This run has not changed anything yet, so if the scope can no longer be recorded, close it with \`simple-changes loop end --run-id ${lease.runId} --agent-id ${lease.ownerAgentId}\`, then run \`simple-changes loop start --mode ${lease.mode} --agent-id ${lease.ownerAgentId}\` to take a new baseline.`;
  }
  if (lease.firstMutationAt === null) {
    return " This run has not changed anything yet, but `loop end` cannot close it yet; run `simple-changes loop status` for the exact next commands.";
  }
  const evidence =
    lease.firstMutationAt === undefined
      ? "This lease predates mutation tracking and cannot prove it changed nothing"
      : "This run has already recorded mutation evidence";
  return ` ${evidence}, so \`loop end\` cannot close it. If the scope can no longer be recorded, finalize it with \`simple-changes loop finalize --run-id ${lease.runId} --agent-id ${lease.ownerAgentId} --reason <why>\`, which relinquishes its controller, then replan it with \`simple-changes loop replan-status\` and an approved \`simple-changes loop replan\`.`;
};

const refuseFirstScope = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification,
  reason: string
): never => {
  throw new SimpleChangesError(
    `${reason}${firstScopeRecoveryStep(lease, inventory, verification)}`,
    EXIT_CODES.unsafe
  );
};

/**
 * A first scope must describe the repository as it is now and package only
 * source bytes the run registered at loop start. Beyond the plan matching the
 * current inventory, that requires: the controller runs it from its own
 * checkout; the pinned target has not moved; policy, capabilities, remote
 * bindings, and the target binding are unchanged; manifest verification
 * passes (so a changed unclaimed opening worktree needs an explicit `loop
 * allow`, while claimed concurrent authors keep editing); and the controller
 * checkout and every unit source worktree still match their loop-start state.
 */
const assertFirstScopeInvariants = (
  lease: LoopLease,
  plan: ChangePlan,
  inventory: RepositoryInventory
): void => {
  const verification = verificationAgainst(lease, inventory);
  const controller = registeredController(lease);
  if (
    hasScopedOpeningInvariants(lease) &&
    controller &&
    inventory.repository.currentCheckout !== controller.path
  ) {
    throw new SimpleChangesError(
      `Record shipment scope from the controller checkout ${controller.path}; this command ran from ${inventory.repository.currentCheckout}. Generate the preview there too.`,
      EXIT_CODES.unsafe
    );
  }
  const failure = openingScopeFailure(lease, inventory);
  if (failure) {
    refuseFirstScope(lease, inventory, verification, failure);
  }
  if (!hasScopedOpeningInvariants(lease)) {
    return;
  }
  if (!verification.ok) {
    const alternative = unmutatedCloseReady(lease, inventory, verification)
      ? ` Because this run has not changed anything yet, \`simple-changes loop end --run-id ${lease.runId} --agent-id ${lease.ownerAgentId}\` can instead close it for a fresh \`loop start\`.`
      : "";
    throw new SimpleChangesError(
      `Shipment scope cannot be recorded while loop ${lease.runId} verification fails: ${verification.violations
        .map((violation) => `${violation.code}:${violation.path}`)
        .join(
          ", "
        )}. Run \`simple-changes loop status\` for the exact next commands; a changed unclaimed opening worktree needs a user-approved \`loop allow\` before scope is recorded.${alternative}`,
      EXIT_CODES.unsafe
    );
  }
  const sources = [
    ...new Set(plan.units.map((unit) => unit.sourceWorktree)),
  ].sort((left, right) => left.localeCompare(right));
  for (const source of sources) {
    const drift = openingWorktreeDrift(lease, inventory, source);
    if (drift) {
      refuseFirstScope(
        lease,
        inventory,
        verification,
        `Scoped source worktree ${source} changed after loop ${lease.runId} started: ${drift}. Scoped source bytes must be the ones registered at loop start; keep its paths preserved or excluded in the plan instead.`
      );
    }
  }
};

const assertShipmentScopeRecordable = (
  lease: LoopLease,
  plan: ChangePlan,
  inventory: RepositoryInventory,
  refresh: boolean
): void => {
  if (plan.mode !== "preview" || plan.mutationsAllowed) {
    throw new SimpleChangesError(
      "Shipment scope must come from a non-mutating Simple Changes preview plan.",
      EXIT_CODES.validation
    );
  }
  if (refresh && !lease.shipmentScope) {
    throw new SimpleChangesError(
      "Shipment scope refresh requires an existing recorded scope.",
      EXIT_CODES.validation
    );
  }
  if (!refresh && lease.shipmentScope) {
    throw new SimpleChangesError(
      "Shipment scope is already recorded. Use loop refresh-scope after review-driven source changes.",
      EXIT_CODES.unsafe
    );
  }
  if (refresh && lease.shipmentOutcome) {
    throw new SimpleChangesError(
      "Shipment scope cannot be refreshed after an outcome is recorded.",
      EXIT_CODES.unsafe
    );
  }
  // The plan must describe the repository exactly as it is now, so the
  // returned pre-ship brief is current. This holds for first and refreshed
  // scopes alike; only the comparison with loop start differs.
  if (
    !(
      plan.repositoryRoot === inventory.repository.root &&
      plan.baselineDigest === inventory.baselineDigest
    )
  ) {
    throw new SimpleChangesError(
      refresh
        ? "Refreshed shipment scope must match the exact current repository inventory."
        : "Shipment scope must come from a preview of the exact current repository inventory. Re-run preview and record the new plan.",
      EXIT_CODES.unsafe
    );
  }
  if (!refresh) {
    assertFirstScopeInvariants(lease, plan, inventory);
  }
  if (plan.questions.length > 0) {
    throw new SimpleChangesError(
      "Resolve every shipment-scope question before guarded mutation.",
      EXIT_CODES.unsafe
    );
  }
  validatePlanConservation(plan, inventory);
  const existingScope = lease.shipmentScope;
  if (refresh && existingScope) {
    const scoped = new Set(
      existingScope.openingChanges.map(
        (change) => `${change.worktreePath}\0${change.path}`
      )
    );
    const preservedElsewhere = refreshPreservedPaths(existingScope.plan, plan);
    const added = inventory.localChanges.find((change) => {
      if (
        scoped.has(`${change.worktreePath}\0${change.path}`) ||
        preservedElsewhere.has(`${change.worktreePath}\0${change.path}`)
      ) {
        return false;
      }
      const entry = worktreeSourceEntry(change.worktreePath, change.path);
      return !existingScope.openingChanges.some(
        (scopedChange) =>
          scopedChange.path === change.path &&
          worktreeSourceEntry(scopedChange.worktreePath, scopedChange.path) ===
            entry
      );
    });
    if (added) {
      throw new SimpleChangesError(
        `Shipment scope refresh cannot add a new path: ${added.path}. Start a new shipment run for expanded scope.`,
        EXIT_CODES.unsafe
      );
    }
  }
};

/**
 * Paths the refreshed plan preserves outside every worktree the scope ships
 * from. Another agent's actively changing worktree keeps adding paths while a
 * run waits on review, and those paths are never shipped, so a refresh accepts
 * them as preserved instead of refusing them as expanded scope. A new path in a
 * scoped source worktree still needs a new shipment run.
 */
const refreshPreservedPaths = (
  scopedPlan: ChangePlan,
  refreshedPlan: ChangePlan
): Set<string> => {
  const sources = new Set(scopedPlan.units.map((unit) => unit.sourceWorktree));
  return new Set(
    refreshedPlan.preserved
      .filter((item) => !sources.has(item.worktreePath))
      .flatMap((item) =>
        item.paths.map((path) => `${item.worktreePath}\0${path}`)
      )
  );
};

/**
 * The preserved list a refresh records. Entries in scoped source worktrees
 * stay as first scoped. Elsewhere, every previously preserved path that is
 * still changed stays preserved, and the refreshed plan's preserved paths are
 * added, keyed by worktree; a path the first scope excluded stays excluded
 * rather than being counted twice.
 */
const refreshedPreserved = (
  { openingChanges, plan: scopedPlan }: NonNullable<LoopLease["shipmentScope"]>,
  refreshedPlan: ChangePlan,
  inventory: RepositoryInventory
): ChangePlan["preserved"] => {
  const sources = new Set(scopedPlan.units.map((unit) => unit.sourceWorktree));
  const changed = new Set(
    inventory.localChanges.map(
      (change) => `${change.worktreePath}\0${change.path}`
    )
  );
  // A pathless exclusion covered the one opening change with that path, so it
  // keeps excluding only that worktree's path.
  const excluded = new Set(
    scopedPlan.exclusions.flatMap((exclusion) => {
      const worktrees = exclusion.worktreePath
        ? [exclusion.worktreePath]
        : openingChanges
            .filter((change) => change.path === exclusion.path)
            .map((change) => change.worktreePath);
      return worktrees.map((worktree) => `${worktree}\0${exclusion.path}`);
    })
  );
  const merged = new Map<string, ChangePlan["preserved"][number]>();
  for (const item of [...scopedPlan.preserved, ...refreshedPlan.preserved]) {
    if (sources.has(item.worktreePath)) {
      continue;
    }
    const prior = merged.get(item.worktreePath);
    const paths = [...(prior?.paths ?? []), ...item.paths].filter(
      (path, index, all) =>
        all.indexOf(path) === index &&
        changed.has(`${item.worktreePath}\0${path}`) &&
        !excluded.has(`${item.worktreePath}\0${path}`)
    );
    merged.set(item.worktreePath, { ...item, paths });
  }
  return [
    ...scopedPlan.preserved.filter((item) => sources.has(item.worktreePath)),
    ...[...merged.values()].filter((item) => item.paths.length > 0),
  ];
};

// The inventory a scope's opening changes came from. A refresh keeps the
// first scope's value, because it keeps that scope's opening changes. A scope
// recorded before this field existed was recorded at the unchanged opening
// inventory, so the lease's opening digest stands in for it.
const scopeOpeningInventoryDigest = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  refresh: boolean
): string => {
  if (refresh && lease.shipmentScope) {
    return lease.shipmentScope.openingInventoryDigest ?? lease.baselineDigest;
  }
  return inventory.baselineDigest;
};

export const recordShipmentScope = (
  repositoryPath: string,
  runIdInput: string,
  agentIdInput: string,
  planInput: unknown,
  refresh = false
): ShipmentScopeReceipt => {
  const runId = requiredRunId(runIdInput);
  const agentId = requiredText(agentIdInput, "agent ID");
  const plan = validateSchema<ChangePlan>("change-plan", planInput);
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "record shipment scope",
    () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertControllerActive(lease);
      if (lease.runId !== runId || lease.ownerAgentId !== agentId) {
        throw new SimpleChangesError(
          `Only ${lease.ownerAgentId} may record shipment scope for ${lease.runId}.`,
          EXIT_CODES.unsafe
        );
      }
      const frozenAt = effectiveShipmentScopeFrozenAt(lease);
      if (frozenAt && !lease.shipmentScope) {
        throw new SimpleChangesError(
          `Shipment scope for ${lease.runId} froze when its controller relinquished at ${frozenAt}. A resumed controller cannot record a first scope from later repository state. Next: if this work is already contained in the target, run \`simple-changes loop close-equivalent --run-id ${lease.runId} --approved-by <you> --reason <why>\`; otherwise close this loop and start a fresh shipment.`,
          EXIT_CODES.unsafe
        );
      }
      assertShipmentScopeRecordable(lease, plan, inventory, refresh);
      const recordedAt = new Date().toISOString();
      const priorScope = lease.shipmentScope;
      // A refresh keeps the scoped units and exclusions. Outside scoped
      // source worktrees, a path stays preserved while it is still changed,
      // whatever the refreshed preview proposes for it, and the refreshed
      // plan may preserve new paths there.
      const activePlan =
        refresh && priorScope
          ? {
              ...priorScope.plan,
              baselineDigest: plan.baselineDigest,
              generatedAt: plan.generatedAt,
              preserved: refreshedPreserved(priorScope, plan, inventory),
            }
          : plan;
      const openingChanges =
        refresh && priorScope
          ? priorScope.openingChanges.map(
              ({ originalPath, path, worktreePath }) => ({
                originalPath,
                path,
                sourceEntry: worktreeSourceEntry(worktreePath, path),
                worktreePath,
              })
            )
          : inventory.localChanges.map(
              ({ originalPath, path, worktreePath }) => ({
                originalPath,
                path,
                sourceEntry: worktreeSourceEntry(worktreePath, path),
                worktreePath,
              })
            );
      const planDigest = refresh
        ? sha256Json({ openingChanges, plan: activePlan })
        : sha256Json(activePlan);
      const openingInventoryDigest = scopeOpeningInventoryDigest(
        lease,
        inventory,
        refresh
      );
      const shipmentScopeHistory = lease.shipmentScope
        ? [
            ...(lease.shipmentScopeHistory ?? []),
            {
              planDigest: lease.shipmentScope.planDigest,
              recordedAt: lease.shipmentScope.recordedAt,
              supersededAt: recordedAt,
            },
          ]
        : lease.shipmentScopeHistory;
      writeLease({
        ...withMutationEvidence(lease, recordedAt),
        ...(shipmentScopeHistory ? { shipmentScopeHistory } : {}),
        ownerProcess: ownerProcessEvidence(recordedAt),
        shipmentScope: {
          openingChanges,
          openingInventoryDigest,
          plan: activePlan,
          planDigest,
          recordedAt,
        },
        updatedAt: recordedAt,
      });
      const includedPaths = activePlan.units.reduce(
        (count, unit) => count + unit.paths.length,
        0
      );
      const preservedPaths = activePlan.preserved.reduce(
        (count, item) => count + item.paths.length,
        0
      );
      return {
        includedPaths,
        planDigest,
        preservedPaths,
        recordedAt,
        runId,
        summary: shipmentScopeSummary(activePlan, inventory),
      };
    }
  );
};

export interface ShipmentOutcomeRecord {
  receiptDigest: string;
  recordedAt: string;
  summary: string;
}

export const targetDiffPaths = (
  repositoryPath: string,
  openingRevision: string,
  finalRevision: string
): string[] =>
  runGit(repositoryPath, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    // A changed gitlink is a final-target change even where configuration
    // or .gitmodules says to ignore submodules.
    "--ignore-submodules=none",
    openingRevision,
    finalRevision,
    "--",
  ])
    .stdout.split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

export const targetRenameOriginals = (
  repositoryPath: string,
  openingRevision: string,
  finalRevision: string
): Map<string, string> => {
  const fields = runGit(repositoryPath, [
    "diff",
    "--name-status",
    "-z",
    "-M",
    "--ignore-submodules=none",
    openingRevision,
    finalRevision,
    "--",
  ]).stdout.split("\0");
  const originals = new Map<string, string>();
  for (let index = 0; index < fields.length; ) {
    const status = fields[index] ?? "";
    index += 1;
    if (!status) {
      continue;
    }
    const firstPath = fields[index] ?? "";
    index += 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      const destinationPath = fields[index] ?? "";
      index += 1;
      if (firstPath && destinationPath) {
        originals.set(destinationPath, firstPath);
      }
    }
  }
  return originals;
};

const assertShipmentOutcomeEntry = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  path: string,
  entry: string | null,
  label: string
): void => {
  assertSafeRelativePath(lease.primaryCheckout, path);
  if (
    targetTreeEntry(lease.primaryCheckout, receipt.targetRevision, path) !==
    entry
  ) {
    throw new SimpleChangesError(
      `${label} does not match final target: ${path}`,
      EXIT_CODES.validation
    );
  }
};

type OutcomeUnit = ShipmentOutcomeReceipt["units"][number];

type PlannedUnit = ChangePlan["units"][number];

type OpeningShipmentChange = NonNullable<
  LoopLease["shipmentScope"]
>["openingChanges"][number];

const validateOutcomeUnitFinalPaths = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  expected: PlannedUnit
): Set<string> => {
  const names = unit.finalPaths.map((item) => item.path);
  if (new Set(names).size !== names.length) {
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} repeats a final path.`,
      EXIT_CODES.validation
    );
  }
  const missing = expected.paths.filter((path) => !names.includes(path));
  const unexpected = names.filter((path) => !expected.paths.includes(path));
  if (missing.length > 0 || unexpected.length > 0) {
    const detail =
      missing.length > 0
        ? `omits scoped path ${missing[0]}`
        : `includes unscoped final path ${unexpected[0]}`;
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} ${detail}.`,
      EXIT_CODES.validation
    );
  }
  for (const item of unit.finalPaths) {
    assertShipmentOutcomeEntry(
      lease,
      receipt,
      item.path,
      item.entry,
      "Shipment outcome entry"
    );
  }
  return new Set(names);
};

const validateOutcomeUnitOriginalPaths = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  expected: PlannedUnit,
  targetDeltaPaths: Set<string>,
  renameOriginals: Map<string, string>
): Set<string> => {
  const names = unit.originalPaths.map((item) => item.path);
  const allowed = new Set(
    expected.paths
      .map((path) => renameOriginals.get(path))
      .filter((path): path is string => Boolean(path))
  );
  if (new Set(names).size !== names.length) {
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} repeats an original path.`,
      EXIT_CODES.validation
    );
  }
  const missing = [...allowed].filter(
    (path) => targetDeltaPaths.has(path) && !names.includes(path)
  );
  if (missing.length > 0) {
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} omits rename original path ${missing[0]}.`,
      EXIT_CODES.validation
    );
  }
  for (const item of unit.originalPaths) {
    if (!(allowed.has(item.path) && targetDeltaPaths.has(item.path))) {
      throw new SimpleChangesError(
        `Shipment outcome unit ${unit.unitId} includes an unrelated original path ${item.path}.`,
        EXIT_CODES.validation
      );
    }
    assertShipmentOutcomeEntry(
      lease,
      receipt,
      item.path,
      item.entry,
      "Shipment rename original entry"
    );
  }
  return new Set(names);
};

/**
 * A unit packaged from the dirty primary checkout may ship a reviewed result
 * whose bytes differ from the frozen opening copy. That is accepted only while
 * the primary is provably untouched since the run's baseline and its HEAD is
 * contained in the bound target, so the outcome cannot launder controller
 * edits made in the primary itself.
 */
const primaryReviewedResultAllowed = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  expected: PlannedUnit
): boolean => {
  if (
    unit.disposition !== "delivered" ||
    expected.sourceWorktree !== lease.primaryCheckout
  ) {
    return false;
  }
  const primary = inventory.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === lease.primaryCheckout
  );
  if (!(primary?.isPrimary && primary.headSha && registered)) {
    return false;
  }
  const baselineDigest =
    matchingOverride(lease, primary)?.changeDigest ??
    registered.baselineChangeDigest;
  return (
    primary.branch === registered.branch &&
    primary.changeDigest === baselineDigest &&
    (primary.headSha === registered.baselineHeadSha ||
      primary.headSha === receipt.targetRevision) &&
    targetContainsRevision(
      lease.primaryCheckout,
      receipt.targetRevision,
      primary.headSha
    )
  );
};

/**
 * Rechecks a user-approved preserved-source override against the live claim,
 * the frozen source checkout, and the exact target tree. Reads the claim
 * document, so callers hold the worktree-coordination lock.
 */
const preservedSourceOverrideIssue = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  override: PreservedSourceOverrideReceipt | undefined,
  expected: PlannedUnit,
  recordedAt: string
): string | null => {
  const { sourceWorktree } = expected;
  const registered = lease.worktrees.find(
    (worktree) => worktree.path === sourceWorktree
  );
  const { claims } = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const openingEntries = new Map(
    (lease.shipmentScope?.openingChanges ?? [])
      .filter((change) => change.worktreePath === sourceWorktree)
      .map((change) => [change.path, change.sourceEntry])
  );
  return preservedSourceOverrideFailure(
    {
      claim: claims.find((item) => item.claimId === registered?.claimId),
      controllerAgentId: lease.ownerAgentId,
      current: inventory.worktrees.find((item) => item.path === sourceWorktree),
      disposition: unit.disposition,
      finalPaths: unit.finalPaths,
      opening: lease.openingWorktrees?.find(
        (worktree) => worktree.path === sourceWorktree
      ),
      openingEntries,
      originalPaths: unit.originalPaths,
      override,
      registered,
      runId: lease.runId,
      scopePaths: expected.paths,
      sourceEntry: (path) => worktreeSourceEntry(sourceWorktree, path),
      sourceWorktree,
      targetEntry: (path) =>
        targetTreeEntry(lease.primaryCheckout, receipt.targetRevision, path),
      targetRevision: receipt.targetRevision,
      unitId: unit.unitId,
    },
    recordedAt
  );
};

const assertDirectOutcomeMatchesSource = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  receipt: ShipmentOutcomeReceipt,
  unit: OutcomeUnit,
  override: PreservedSourceOverrideReceipt | undefined,
  expected: PlannedUnit,
  openingChanges: OpeningShipmentChange[],
  recordedAt: string
): void => {
  let reviewedPrimaryResultAllowed: boolean | null = null;
  let preservedSourceOverrideAllowed = false;
  if (override) {
    const issue = preservedSourceOverrideIssue(
      lease,
      inventory,
      receipt,
      unit,
      override,
      expected,
      recordedAt
    );
    if (issue) {
      throw new SimpleChangesError(
        `Shipment outcome unit ${unit.unitId} has invalid manual preserved-source override: ${issue}.`,
        EXIT_CODES.validation
      );
    }
    preservedSourceOverrideAllowed = true;
  }
  for (const item of unit.finalPaths) {
    const sources = openingChanges.filter(
      (change) =>
        change.worktreePath === expected.sourceWorktree &&
        change.path === item.path
    );
    if (sources.length === 1 && sources[0]?.sourceEntry === item.entry) {
      continue;
    }
    reviewedPrimaryResultAllowed ??= primaryReviewedResultAllowed(
      lease,
      inventory,
      receipt,
      unit,
      expected
    );
    if (sources.length === 1 && reviewedPrimaryResultAllowed) {
      continue;
    }
    if (sources.length === 1 && preservedSourceOverrideAllowed) {
      continue;
    }
    throw new SimpleChangesError(
      `Shipment outcome unit ${unit.unitId} does not match its exact opening source result for ${item.path}.${
        expected.sourceWorktree === lease.primaryCheckout
          ? " A reviewed result for work packaged from the primary checkout is accepted only while that checkout is unchanged from its baseline and its HEAD is contained in the bound target."
          : ""
      }`,
      EXIT_CODES.validation
    );
  }
};

const validateShipmentOutcomeUnits = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  receipt: ShipmentOutcomeReceipt,
  targetDeltaPaths: Set<string>,
  renameOriginals: Map<string, string>,
  overrides: readonly PreservedSourceOverrideReceipt[],
  recordedAt: string
): { accountedPaths: Set<string>; scopedPaths: Set<string> } => {
  const scope = lease.shipmentScope;
  if (!scope) {
    throw new SimpleChangesError(
      "Record shipment scope before reconciling its exact outcome.",
      EXIT_CODES.unsafe
    );
  }
  const expectedUnits = new Map(
    scope.plan.units.map((unit) => [unit.id, unit])
  );
  const seenUnits = new Set<string>();
  const accountedPaths = new Set<string>();
  for (const unit of receipt.units) {
    const expected = expectedUnits.get(unit.unitId);
    if (!expected || seenUnits.has(unit.unitId)) {
      throw new SimpleChangesError(
        `Shipment outcome has an unknown or duplicate unit: ${unit.unitId}`,
        EXIT_CODES.validation
      );
    }
    seenUnits.add(unit.unitId);
    requiredText(unit.summary, `summary for ${unit.unitId}`);
    for (const item of unit.evidence) {
      requiredText(item, `evidence for ${unit.unitId}`);
    }
    for (const path of validateOutcomeUnitFinalPaths(
      lease,
      receipt,
      unit,
      expected
    )) {
      accountedPaths.add(path);
    }
    const originalPaths = validateOutcomeUnitOriginalPaths(
      lease,
      receipt,
      unit,
      expected,
      targetDeltaPaths,
      renameOriginals
    );
    for (const path of originalPaths) {
      accountedPaths.add(path);
    }
    assertDirectOutcomeMatchesSource(
      lease,
      inventory,
      receipt,
      unit,
      overrides.find((item) => item.unitId === unit.unitId),
      expected,
      scope.openingChanges,
      recordedAt
    );
  }
  const missing = [...expectedUnits.keys()].filter(
    (unitId) => !seenUnits.has(unitId)
  );
  if (missing.length > 0) {
    throw new SimpleChangesError(
      `Shipment outcome omits scoped units: ${missing.join(", ")}`,
      EXIT_CODES.validation
    );
  }
  return {
    accountedPaths,
    scopedPaths: new Set(scope.plan.units.flatMap((unit) => unit.paths)),
  };
};

const validateAdditionalShipmentPaths = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  accountedPaths: Set<string>,
  scopedPaths: Set<string>,
  targetDeltaPaths: Set<string>
): void => {
  for (const item of receipt.additionalPaths) {
    requiredText(item.reason, `reason for ${item.path}`);
    if (scopedPaths.has(item.path)) {
      throw new SimpleChangesError(
        `Scoped path must be reconciled through its unit, not additionalPaths: ${item.path}`,
        EXIT_CODES.validation
      );
    }
    if (accountedPaths.has(item.path)) {
      throw new SimpleChangesError(
        `Additional shipment path is already accounted for: ${item.path}`,
        EXIT_CODES.validation
      );
    }
    if (!targetDeltaPaths.has(item.path)) {
      throw new SimpleChangesError(
        `Additional shipment path is not part of the final target delta: ${item.path}`,
        EXIT_CODES.validation
      );
    }
    assertShipmentOutcomeEntry(
      lease,
      receipt,
      item.path,
      item.entry,
      "Additional shipment path entry"
    );
    accountedPaths.add(item.path);
  }
};

const assertCompleteTargetDelta = (
  lease: LoopLease,
  receipt: ShipmentOutcomeReceipt,
  accountedPaths: Set<string>
): void => {
  const missing = targetDiffPaths(
    lease.primaryCheckout,
    lease.targetRevision,
    receipt.targetRevision
  ).filter((path) => !accountedPaths.has(path));
  if (missing.length > 0) {
    throw new SimpleChangesError(
      `Shipment outcome omits final target delta paths: ${missing.join(", ")}`,
      EXIT_CODES.validation
    );
  }
};

export interface PreservedSourceApproval {
  approvalReference?: string | undefined;
  approvedBy?: string | undefined;
}

/**
 * The approval flags on `loop record-outcome` must restate every
 * preserved-source override exactly, and are refused when no override exists.
 */
const assertPreservedSourceApproval = (
  overrides: readonly PreservedSourceOverrideReceipt[],
  approval: PreservedSourceApproval | undefined
): void => {
  if (overrides.length === 0) {
    if (approval?.approvedBy || approval?.approvalReference) {
      throw new SimpleChangesError(
        "Manual approval flags require a preserved-source override in the outcome.",
        EXIT_CODES.validation
      );
    }
    return;
  }
  const approvedBy = requiredText(
    approval?.approvedBy ?? "",
    "manual preserved-source approver"
  );
  const approvalReference = requiredText(
    approval?.approvalReference ?? "",
    "manual preserved-source approval reference"
  );
  if (
    overrides.some(
      (item) =>
        item.approvedBy !== approvedBy ||
        item.approvalReference !== approvalReference
    )
  ) {
    throw new SimpleChangesError(
      "Manual preserved-source approval flags must match every exact outcome override.",
      EXIT_CODES.validation
    );
  }
};

/**
 * Every placeholder `loop draft-outcome` writes starts with this marker, and
 * `loop record-outcome` refuses any receipt text that still contains it, so
 * a draft cannot be recorded until each placeholder has been replaced.
 */
export const OUTCOME_DRAFT_MARKER = "SIMPLE-CHANGES-DRAFT:";

/**
 * The `draftReview` field every draft carries. No shipment-outcome schema
 * accepts it, so a draft is unrecordable, even by an older runtime, until a
 * reviewer deletes it.
 */
export const OUTCOME_DRAFT_REVIEW = `${OUTCOME_DRAFT_MARKER} review every entry, replace each placeholder, then delete this draftReview field before loop record-outcome.`;

type DraftTextPath = Array<number | string>;

const LEADING_DOT_PATTERN = /^\./u;

/** Every location in the raw receipt whose text carries the draft marker. */
const draftTextPaths = (
  value: unknown,
  path: DraftTextPath = []
): DraftTextPath[] => {
  if (typeof value === "string") {
    return value.includes(OUTCOME_DRAFT_MARKER) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      draftTextPaths(item, [...path, index])
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      draftTextPaths(item, [...path, key])
    );
  }
  return [];
};

const fieldOf = (value: unknown, path: DraftTextPath): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null
        ? (current as Record<number | string, unknown>)[key]
        : undefined,
    value
  );

/** A reader's name for a draft text location, such as "reason for SPEC.md". */
const draftTextLabel = (receipt: unknown, path: DraftTextPath): string => {
  const [list, index, field] = path;
  if (list === "units" && (field === "summary" || field === "evidence")) {
    return `${field} of unit ${String(fieldOf(receipt, ["units", index ?? 0, "unitId"]))}`;
  }
  if (list === "additionalPaths" && field === "reason") {
    return `reason for ${String(fieldOf(receipt, ["additionalPaths", index ?? 0, "path"]))}`;
  }
  return path
    .map((key) => (typeof key === "number" ? `[${key}]` : `.${key}`))
    .join("")
    .replace(LEADING_DOT_PATTERN, "");
};

/**
 * Reads the raw input, every string anywhere in it including any
 * preserved-source override, so a placeholder is refused even in a receipt
 * the schema would reject for another reason.
 */
const assertNoOutcomeDraftPlaceholders = (receipt: unknown): void => {
  const drafts = draftTextPaths(receipt);
  const [first] = drafts;
  if (first) {
    throw new SimpleChangesError(
      `Shipment outcome still carries ${drafts.length} draft placeholder(s), starting with the ${draftTextLabel(receipt, first)}. Replace every ${OUTCOME_DRAFT_MARKER} placeholder with the reviewed text, check each classification and disposition, then record it again.`,
      EXIT_CODES.validation
    );
  }
};

export const recordShipmentOutcome = (
  repositoryPath: string,
  runIdInput: string,
  agentIdInput: string,
  receiptInput: unknown,
  approval?: PreservedSourceApproval
): ShipmentOutcomeRecord => {
  const runId = requiredRunId(runIdInput);
  const agentId = requiredText(agentIdInput, "agent ID");
  if (
    typeof receiptInput === "object" &&
    receiptInput !== null &&
    "draftReview" in receiptInput
  ) {
    throw new SimpleChangesError(
      "This shipment outcome is still an unreviewed loop draft-outcome draft. Review every entry, replace each placeholder, delete the draftReview field, then record it.",
      EXIT_CODES.validation
    );
  }
  // Placeholders are refused before anything else reads the receipt, with
  // or without preserved-source overrides.
  assertNoOutcomeDraftPlaceholders(receiptInput);
  // Overrides ride on the receipt's units but are stored beside the lease;
  // the recorded digest covers the complete receipt, overrides included.
  const { overrides, receipt, receiptDigest } =
    splitShipmentOutcomeInput(receiptInput);
  assertPreservedSourceApproval(overrides, approval);
  const opening = locateRepository(repositoryPath);
  // The coordination lock keeps the claim a preserved-source override binds
  // from changing between validation and the lease write.
  return withStateLock(
    opening.repository.commonGitDirectory,
    "record shipment outcome",
    () =>
      withWorktreeCoordinationLock(
        opening.repository.commonGitDirectory,
        "record shipment outcome",
        () => {
          const inventory = captureInventory(repositoryPath);
          const lease = requireLease(inventory);
          assertControllerActive(lease);
          if (
            lease.runId !== runId ||
            receipt.runId !== runId ||
            lease.ownerAgentId !== agentId
          ) {
            throw new SimpleChangesError(
              `Only ${lease.ownerAgentId} may reconcile the exact outcome for ${lease.runId}.`,
              EXIT_CODES.unsafe
            );
          }
          const finalTargetRevision = currentTargetRevision(lease);
          if (receipt.targetRevision !== finalTargetRevision) {
            throw new SimpleChangesError(
              `Shipment outcome must bind current target ${finalTargetRevision}.`,
              EXIT_CODES.unsafe
            );
          }
          const targetDeltaPaths = new Set(
            targetDiffPaths(
              lease.primaryCheckout,
              lease.targetRevision,
              receipt.targetRevision
            )
          );
          const renameOriginals = targetRenameOriginals(
            lease.primaryCheckout,
            lease.targetRevision,
            receipt.targetRevision
          );
          const recordedAt = new Date().toISOString();
          const { accountedPaths, scopedPaths } = validateShipmentOutcomeUnits(
            lease,
            inventory,
            receipt,
            targetDeltaPaths,
            renameOriginals,
            overrides,
            recordedAt
          );
          validateAdditionalShipmentPaths(
            lease,
            receipt,
            accountedPaths,
            scopedPaths,
            targetDeltaPaths
          );
          assertCompleteTargetDelta(lease, receipt, accountedPaths);
          // A null record removes a sidecar left by an earlier outcome.
          writeReceiptSidecar(
            lease,
            PRESERVED_SOURCE_OVERRIDE_DIRECTORY,
            overrides.length === 0
              ? null
              : {
                  overrides,
                  receiptDigest,
                  runId: lease.runId,
                  schemaVersion: 1,
                }
          );
          writeLease({
            ...withMutationEvidence(lease, recordedAt),
            ownerProcess: ownerProcessEvidence(recordedAt),
            shipmentOutcome: { receipt, receiptDigest, recordedAt },
            updatedAt: recordedAt,
          });
          return {
            receiptDigest,
            recordedAt,
            summary: `Reviewed shipment outcome: ${receipt.units.length} scoped work item(s) and ${receipt.additionalPaths.length} additional final-target path(s) accounted at ${receipt.targetRevision}.`,
          };
        }
      )
  );
};

export const targetTreeEntry = (
  repositoryPath: string,
  targetRevision: string,
  path: string
): string | null => {
  try {
    // A literal pathspec, so a file named like pathspec magic (`:README.md`)
    // reads its own entry rather than another file's.
    const output = runGit(repositoryPath, [
      "--literal-pathspecs",
      "ls-tree",
      targetRevision,
      "--",
      path,
    ]).stdout.trim();
    const match = LS_TREE_ENTRY_PATTERN.exec(output);
    return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
  } catch {
    return null;
  }
};

export {
  openingScopeFailure,
  owesFirstScope,
  preservedSourceOverrideIssue,
  worktreeSourceEntry,
};
