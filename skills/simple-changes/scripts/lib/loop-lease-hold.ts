import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256Json } from "./hash.ts";
import {
  assertHeldScopeConservation,
  type HeldUnitEvent,
  heldUnitEventPath,
  heldUnitExclusions,
  heldUnitHoldDigest,
  heldUnitIds,
  heldUnitPinRef,
  heldUnitsDigest,
  readHeldUnits,
} from "./held-units.ts";
import {
  assertExactBranch,
  captureInventory,
  locateRepository,
} from "./inventory.ts";
import {
  assertControllerActive,
  assertMatchingRun,
  currentTargetRevision,
  DIGEST_PATTERN,
  HELD_UNITS_DIRECTORY,
  requiredRunId,
  requiredText,
  requireLease,
  withStateLock,
  writeImmutableRecoveryEvent,
  writeLease,
  writeReceiptSidecar,
} from "./loop-lease-core.ts";
import {
  OUTCOME_DRAFT_MARKER,
  targetTreeEntry,
  worktreeSourceEntry,
} from "./loop-lease-shipment.ts";
import { liveClaimFor } from "./loop-lease-verify.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";
import type {
  ChangeUnit,
  HeldUnitHold,
  HeldUnitObservation,
  HeldUnitsRecord,
  LoopLease,
  RepositoryInventory,
} from "./types.ts";
import {
  readCoordinationDocumentFromCommonDirectory,
  withWorktreeCoordinationLock,
} from "./worktree-coordination.ts";

const MAX_TEXT_LENGTH = 500;

const MAX_READINESS_EVIDENCE = 20;

const SAFE_SHELL_WORD = /^[A-Za-z0-9._:/@%+=,-]+$/u;

const shellWord = (value: string): string =>
  SAFE_SHELL_WORD.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

// Whether `text` names `id` as a whole unit ID: not inside a longer ID, a
// path, or a filename, though a sentence may end right after it.
const namesUnitId = (text: string, id: string): boolean =>
  new RegExp(
    `(^|[^A-Za-z0-9_./~-])${id.replace(REGEX_SPECIAL, "\\$&")}(?![A-Za-z0-9_/~-]|\\.[A-Za-z0-9_~-])`,
    "iu"
  ).test(text);

const boundedText = (value: string, name: string): string => {
  const text = requiredText(value, name);
  if ([...text].length > MAX_TEXT_LENGTH) {
    throw new SimpleChangesError(
      `${name} must be at most ${MAX_TEXT_LENGTH} characters.`,
      EXIT_CODES.usage
    );
  }
  if (text.includes(OUTCOME_DRAFT_MARKER)) {
    throw new SimpleChangesError(
      `${name} still carries a ${OUTCOME_DRAFT_MARKER} placeholder; write the reviewed text.`,
      EXIT_CODES.validation
    );
  }
  return text;
};

/**
 * Why the cited readiness evidence cannot establish that this unit, and only
 * this unit, failed its readiness condition, or null. Attribution is
 * structured, never inferred from filenames: each item starts with the held
 * unit's exact ID and a colon, then states the evidence, and the evidence
 * names no other scoped unit. A shared filename such as a changelog, or
 * evidence about several units, does not say which unit is not ready.
 */
export const readinessEvidenceFailure = (
  unit: Pick<ChangeUnit, "id">,
  scopedUnits: readonly Pick<ChangeUnit, "id">[],
  evidence: readonly string[]
): string | null => {
  if (evidence.length === 0) {
    return "no readiness evidence was cited";
  }
  if (evidence.length > MAX_READINESS_EVIDENCE) {
    return `at most ${MAX_READINESS_EVIDENCE} readiness evidence items may be cited`;
  }
  const prefix = `${unit.id}:`;
  const others = scopedUnits.filter((item) => item.id !== unit.id);
  for (const [index, item] of evidence.entries()) {
    const label = `readiness evidence ${index + 1}`;
    const body = item.startsWith(prefix)
      ? item.slice(prefix.length).trim()
      : "";
    if (!body) {
      return `${label} must start with "${unit.id}: " and then state the evidence, so it says which unit it is about`;
    }
    const other = others.find((candidate) => namesUnitId(body, candidate.id));
    if (other) {
      return `${label} also names scoped unit ${other.id}, so it does not say which unit failed`;
    }
  }
  return null;
};

export interface HoldUnitApproval {
  approvalReference?: string | undefined;
  approvedBy?: string | undefined;
  observationDigest?: string | undefined;
}

export interface HoldUnitRequest {
  agentId: string;
  approval?: HoldUnitApproval;
  readinessEvidence: readonly string[];
  reason: string;
  runId: string;
  unitId: string;
}

export interface HoldUnitResult {
  approvalCommand: string;
  hold: HeldUnitHold | null;
  observation: HeldUnitObservation;
  observationDigest: string;
  status: "approval-required" | "held";
  summary: string;
}

// Independence compares agent IDs without surrounding whitespace, so a
// padded controller or author ID cannot pass as the approving user.
const sameAgent = (left: string, right: string): boolean =>
  left.trim() === right.trim();

const approvalInputs = (
  approval: HoldUnitApproval | undefined
): {
  approvalReference: string;
  approvedBy: string;
  observationDigest: string;
} | null => {
  const given = [
    approval?.approvedBy,
    approval?.approvalReference,
    approval?.observationDigest,
  ].filter((value) => value !== undefined);
  if (given.length === 0) {
    return null;
  }
  if (given.length !== 3) {
    throw new SimpleChangesError(
      "Holding a unit needs the user's fresh approval of its exact observed state: pass --approved-by, --approval-reference, and --observation-digest together, or none of them to see the observation the user must approve.",
      EXIT_CODES.usage
    );
  }
  const observationDigest = requiredText(
    approval?.observationDigest ?? "",
    "observation digest"
  );
  if (!DIGEST_PATTERN.test(observationDigest)) {
    throw new SimpleChangesError(
      "--observation-digest must be the 64-character digest loop hold-unit printed.",
      EXIT_CODES.usage
    );
  }
  return {
    approvalReference: boundedText(
      approval?.approvalReference ?? "",
      "approval reference"
    ),
    approvedBy: requiredText(approval?.approvedBy ?? "", "approver"),
    observationDigest,
  };
};

const refuse = (message: string): never => {
  throw new SimpleChangesError(message, EXIT_CODES.unsafe);
};

/** Everything `loop hold-unit` refuses before it observes the source. */
const heldUnitCandidate = (
  lease: LoopLease,
  unitId: string,
  holds: readonly HeldUnitHold[]
): { scope: NonNullable<LoopLease["shipmentScope"]>; unit: ChangeUnit } => {
  const scope = lease.shipmentScope;
  if (!scope) {
    return refuse(
      `Loop ${lease.runId} has no recorded shipment scope, so it has no frozen unit to hold. Record the scope first; a unit that was never scoped needs no hold.`
    );
  }
  if (lease.shipmentOutcome) {
    return refuse(
      `Loop ${lease.runId} already recorded its shipment outcome at ${lease.shipmentOutcome.recordedAt}, which reports every unit it did not hold. A hold never reinterprets a recorded outcome; replan the run for a new decision.`
    );
  }
  const unit = scope.plan.units.find((item) => item.id === unitId);
  if (!unit) {
    return refuse(
      `Unit ${unitId} is not in the frozen shipment scope of ${lease.runId}. A hold moves only a scoped unit; new scope needs a new shipment run.`
    );
  }
  const held = heldUnitIds(holds);
  if (held.has(unit.id)) {
    return refuse(
      `Unit ${unit.id} is already held in ${lease.runId}; a hold is immutable and is never recorded twice.`
    );
  }
  const dependent = scope.plan.units.find(
    (item) => !held.has(item.id) && item.dependencies.includes(unit.id)
  );
  if (dependent) {
    return refuse(
      `Scoped unit ${dependent.id} depends on ${unit.id}, so ${unit.id} cannot be held while ${dependent.id} may still ship. Hold ${dependent.id} first.`
    );
  }
  return { scope, unit };
};

const observeHeldUnit = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  scope: NonNullable<LoopLease["shipmentScope"]>,
  unit: ChangeUnit,
  reason: string,
  readinessEvidence: string[]
): HeldUnitObservation => {
  const source = inventory.worktrees.find(
    (worktree) => worktree.path === unit.sourceWorktree
  );
  if (!source) {
    return refuse(
      `Source checkout ${unit.sourceWorktree} of unit ${unit.id} is missing, so there is no exact source to preserve. Restore it, or replan the run.`
    );
  }
  // The observation digest binds the branch name as Git decodes it, so two
  // raw-byte names that decode alike would share one approval. Only an exact
  // name can be observed, approved, and pinned.
  assertExactBranch(source.branch, `the held-unit observation of ${unit.id}`);
  const claim = liveClaimFor(
    readCoordinationDocumentFromCommonDirectory(lease.commonGitDirectory),
    lease.commonGitDirectory,
    source.path
  );
  const openingEntry = (path: string): string | null => {
    const matches = scope.openingChanges.filter(
      (change) =>
        change.worktreePath === unit.sourceWorktree && change.path === path
    );
    return matches.length === 1 ? (matches[0]?.sourceEntry ?? null) : null;
  };
  return {
    claim: claim
      ? {
          branch: claim.branch,
          claimId: claim.claimId,
          ownerAgentId: claim.owner.agentId,
          state: claim.state,
        }
      : null,
    controllerAgentId: lease.ownerAgentId,
    paths: unit.paths.map((path) => ({
      openingEntry: openingEntry(path),
      path,
      sourceEntry: worktreeSourceEntry(source.path, path),
    })),
    readinessEvidence,
    reason,
    runId: lease.runId,
    scopePlanDigest: scope.planDigest,
    source: {
      branch: source.branch,
      changeDigest: source.changeDigest,
      headSha: source.headSha,
      isPrimary: source.isPrimary,
      worktree: source.path,
    },
    target: { ref: lease.targetRef, revision: currentTargetRevision(lease) },
    unitDigest: sha256Json(unit),
    unitId: unit.id,
  };
};

/**
 * Whether the target already has the unit's exact opening result. A rename's
 * result includes its original path's removal, so the unit's own rename
 * originals must also be absent from the target.
 */
const openingResultInTarget = (
  lease: LoopLease,
  scope: NonNullable<LoopLease["shipmentScope"]>,
  unit: ChangeUnit,
  observation: HeldUnitObservation
): boolean => {
  const ownedPaths = new Set(unit.paths);
  const renameOriginals = scope.openingChanges.flatMap((change) =>
    change.worktreePath === unit.sourceWorktree &&
    ownedPaths.has(change.path) &&
    change.originalPath &&
    !ownedPaths.has(change.originalPath)
      ? [change.originalPath]
      : []
  );
  const inTarget = (path: string): string | null =>
    targetTreeEntry(lease.primaryCheckout, observation.target.revision, path);
  return (
    observation.paths.every(
      (item) => inTarget(item.path) === item.openingEntry
    ) && renameOriginals.every((path) => inTarget(path) === null)
  );
};

const entryLabel = (entry: string | null): string =>
  entry === null ? "absent" : entry;

/** The plain statement of what the user approves. */
const observationSummary = (
  observation: HeldUnitObservation,
  unit: ChangeUnit,
  digest: string
): string => {
  const { claim, source, target } = observation;
  return [
    `Hold unit ${unit.id} (${unit.title}) in ${observation.runId}: keep its exact source preserved and report it as held, never as delivered or target-equivalent.`,
    `Source: ${source.worktree}${source.isPrimary ? " (primary checkout)" : ""} on ${source.branch ?? "(detached)"} at ${source.headSha ?? "(no commit)"}, status digest ${source.changeDigest}.`,
    "Paths:",
    ...observation.paths.map(
      (item) =>
        `- ${item.path}: source ${entryLabel(item.sourceEntry)}; opening ${entryLabel(item.openingEntry)}`
    ),
    `Claim: ${claim ? `${claim.claimId} owned by ${claim.ownerAgentId} (${claim.state})` : "none"}.`,
    `Target: ${target.ref} at ${target.revision}.`,
    `Reason: ${observation.reason}`,
    "Readiness evidence:",
    ...observation.readinessEvidence.map((item) => `- ${item}`),
    `Observation digest: ${digest}`,
  ].join("\n");
};

const approvalCommand = (
  observation: HeldUnitObservation,
  digest: string
): string =>
  [
    "simple-changes loop hold-unit",
    `--run-id ${shellWord(observation.runId)}`,
    `--agent-id ${shellWord(observation.controllerAgentId)}`,
    `--unit ${shellWord(observation.unitId)}`,
    `--reason ${shellWord(observation.reason)}`,
    ...observation.readinessEvidence.map(
      (item) => `--readiness-evidence ${shellWord(item)}`
    ),
    "--approved-by <user> --approval-reference <where the user approved>",
    `--observation-digest ${digest}`,
  ].join(" ");

const recordHold = (
  lease: LoopLease,
  scope: NonNullable<LoopLease["shipmentScope"]>,
  holds: readonly HeldUnitHold[],
  unit: ChangeUnit,
  observation: HeldUnitObservation,
  observationDigest: string,
  approval: { approvalReference: string; approvedBy: string }
): HeldUnitHold => {
  const recordedAt = new Date().toISOString();
  const content: Omit<HeldUnitHold, "holdDigest"> = {
    authorization: {
      approvalReference: approval.approvalReference,
      approvedAt: recordedAt,
      approvedBy: approval.approvedBy,
    },
    exclusions: heldUnitExclusions(unit, observation.reason),
    observation,
    observationDigest,
    recordedAt,
    unit,
  };
  const hold: HeldUnitHold = {
    ...content,
    holdDigest: heldUnitHoldDigest(content),
  };
  const next = [...holds, hold];
  assertHeldScopeConservation(scope, next);
  const record = validateSchema<HeldUnitsRecord>("held-units", {
    holds: next,
    runId: lease.runId,
    schemaVersion: 1,
  });
  // First keep the held head reachable, then mark the lease, then record the
  // hold, then bind it durably in the run's history. A failure after the pin
  // leaves a state every reader refuses until it is restored, never a hold
  // that a reader could ignore.
  const head = observation.source.headSha;
  if (head) {
    const pinned = runGit(
      lease.primaryCheckout,
      [
        "update-ref",
        "-m",
        `simple-changes: pin held unit ${unit.id}`,
        heldUnitPinRef(lease.runId, unit.id),
        head,
      ],
      true
    );
    if (pinned.exitCode !== 0) {
      throw new SimpleChangesError(
        `Could not pin held head ${head} of unit ${unit.id}: ${pinned.stderr.trim()}. Nothing was held.`,
        EXIT_CODES.unsafe
      );
    }
  }
  // The lease key makes runtimes that predate holds refuse this run from
  // now on; it is written before the record, so a failure between them
  // fails closed rather than leaving holds an older runtime could ignore.
  writeLease({
    ...lease,
    heldUnits: { holdsDigest: heldUnitsDigest(next) },
    updatedAt: recordedAt,
  });
  writeReceiptSidecar(lease, HELD_UNITS_DIRECTORY, record);
  writeImmutableRecoveryEvent<HeldUnitEvent>(
    heldUnitEventPath(lease.commonGitDirectory, lease.runId, hold.holdDigest),
    {
      holdDigest: hold.holdDigest,
      kind: "held-unit",
      recordedAt,
      runId: lease.runId,
      unitId: unit.id,
    }
  );
  return hold;
};

/**
 * Moves one frozen scoped unit to an explicit, immutable hold. Without an
 * approval it only observes, and returns the exact state and digest the
 * user must approve. With one, it observes again under the loop and
 * coordination locks and records the hold only when the approval names that
 * same digest, so a changed source head, status, content, path, claim, or
 * target since the user approved refuses. Earlier instructions never stand
 * in for this approval. Nothing in the repository, branch, or claim changes.
 */
export const holdScopedUnit = (
  repositoryPath: string,
  request: HoldUnitRequest
): HoldUnitResult => {
  const runId = requiredRunId(request.runId);
  const agentId = requiredText(request.agentId, "agent ID");
  const unitId = requiredText(request.unitId, "unit ID");
  const reason = boundedText(request.reason, "hold reason");
  const readinessEvidence = request.readinessEvidence.map((item, index) =>
    boundedText(item, `readiness evidence ${index + 1}`)
  );
  const approval = approvalInputs(request.approval);
  const { commonGitDirectory } = locateRepository(repositoryPath).repository;
  return withStateLock(commonGitDirectory, "hold unit", () =>
    withWorktreeCoordinationLock(commonGitDirectory, "hold unit", () => {
      const inventory = captureInventory(repositoryPath);
      const lease = requireLease(inventory);
      assertMatchingRun(lease, runId);
      if (lease.ownerAgentId !== agentId) {
        refuse(
          `Only the controller ${lease.ownerAgentId} may hold a unit of ${lease.runId}.`
        );
      }
      assertControllerActive(lease);
      const holds = readHeldUnits(lease);
      const { scope, unit } = heldUnitCandidate(lease, unitId, holds);
      const evidenceFailure = readinessEvidenceFailure(
        unit,
        scope.plan.units,
        readinessEvidence
      );
      if (evidenceFailure) {
        throw new SimpleChangesError(
          `Readiness evidence for unit ${unit.id} is missing or ambiguous: ${evidenceFailure}. Cite the independent evidence that this unit failed its readiness condition as --readiness-evidence "${unit.id}: <evidence>".`,
          EXIT_CODES.validation
        );
      }
      const observation = observeHeldUnit(
        lease,
        inventory,
        scope,
        unit,
        reason,
        readinessEvidence
      );
      // A unit whose exact opening result is already in the target is
      // delivered or target-equivalent, never held.
      if (openingResultInTarget(lease, scope, unit, observation)) {
        refuse(
          `Every path of unit ${unit.id} already has its exact opening source result in ${lease.targetRef} at ${observation.target.revision}, so nothing is left to hold. Record it in the outcome as delivered or target-equivalent instead.`
        );
      }
      const observationDigest = sha256Json(observation);
      const summary = observationSummary(observation, unit, observationDigest);
      const command = approvalCommand(observation, observationDigest);
      if (!approval) {
        return {
          approvalCommand: command,
          hold: null,
          observation,
          observationDigest,
          status: "approval-required" as const,
          summary,
        };
      }
      if (approval.observationDigest !== observationDigest) {
        refuse(
          `The approved observation ${approval.observationDigest} is not the current state of unit ${unit.id}: its source, status, content, paths, claim, target, reason, or evidence changed. Nothing was held. Ask the user to approve the current observation instead:\n${summary}`
        );
      }
      if (
        sameAgent(approval.approvedBy, lease.ownerAgentId) ||
        (observation.claim &&
          sameAgent(approval.approvedBy, observation.claim.ownerAgentId))
      ) {
        refuse(
          `A hold needs the user's approval; ${approval.approvedBy} is the controller or the claim owner of unit ${unit.id}, not the approving user.`
        );
      }
      const hold = recordHold(
        lease,
        scope,
        holds,
        unit,
        observation,
        observationDigest,
        approval
      );
      return {
        approvalCommand: command,
        hold,
        observation,
        observationDigest,
        status: "held" as const,
        summary,
      };
    })
  );
};
