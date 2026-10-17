import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import {
  concurrentClaimFor,
  controllerLifecycle,
  effectiveShipmentScopeFrozenAt,
  matchingOverride,
  matchingRemovalDisposition,
  nothingAtPath,
  ownerProcessEvidence,
  readLeaseFromCommonDirectory,
  resolvedCurrentTargetRevision,
  resolvePrimaryAndTargetBranches,
  retirementForRegistration,
  targetUsesGitLab,
  withConcurrentAuthorAdmissions,
  withStateLock,
  writeLease,
} from "./loop-lease-core.ts";
import {
  analyzePinnedCommand,
  describePinnedUnit,
  gitFactsFor,
  type PinnedCommandAnalysis,
  type PinnedGitFacts,
  type PinnedUnit,
  type PinnedUnitState,
} from "./pinned-heads.ts";
import { runGit } from "./process.ts";
import type {
  LoopLease,
  LoopVerification,
  LoopViolation,
  LoopWorktreeDisposition,
  LoopWorktreeLease,
  LoopWorktreePreparation,
  RepositoryInventory,
  WorktreeClaim,
  WorktreeClaimReleaseReason,
  WorktreeCoordinationDocument,
  WorktreeInventory,
} from "./types.ts";
import {
  coordinationLinkIsCurrent,
  pauseBlocker,
  readCoordinationDocumentFromCommonDirectory,
  releaseRecordedState,
} from "./worktree-coordination.ts";

const removalDispositionForPath = (
  lease: LoopLease,
  path: string
): LoopWorktreeDisposition | undefined =>
  (lease.dispositions ?? []).find(
    (disposition) =>
      disposition.outcome === "remove-after-audit" &&
      disposition.path === path &&
      disposition.targetRef === lease.targetRef &&
      disposition.targetRevision === resolvedCurrentTargetRevision(lease)
  );

// Absent means nothing is at the path and Git either no longer lists the
// worktree or only lists it as prunable metadata.
const worktreeIsAbsent = (
  inventory: RepositoryInventory,
  path: string
): boolean => {
  const current = inventory.worktrees.find(
    (worktree) => worktree.path === path
  );
  return nothingAtPath(path) && (!current || current.prunable);
};

const retiredAbsentPaths = (
  lease: LoopLease,
  inventory: RepositoryInventory
): Set<string> =>
  new Set(
    lease.worktrees
      .filter(
        (registered) =>
          registered.role === "preserved" &&
          retirementForRegistration(lease, registered) &&
          worktreeIsAbsent(inventory, registered.path)
      )
      .map((registered) => registered.path)
  );

// An author's own finished release, through `initialize --mode handoff`, a
// ready-work receipt, or a plain `worktree release`, makes its checkout
// ordinary stable work. Each records the exact state it released, so the
// release admits only that state, only when the release itself recorded it
// from the present checkout, and only while no newer live claim holds the
// checkout. Any other release goes through pause and accept. Callers find
// the claim by the registration's own claim ID.
const COMPLETED_RELEASE_REASONS: ReadonlySet<WorktreeClaimReleaseReason> =
  new Set(["handoff", "owner-release"]);

const completedReleaseMatches = (
  registered: LoopWorktreeLease,
  claim: WorktreeClaim | undefined,
  worktree: WorktreeInventory,
  { liveClaim, releaseRecorded }: ReleaseContext
): boolean =>
  claim?.state === "released" &&
  claim.releaseReason !== undefined &&
  COMPLETED_RELEASE_REASONS.has(claim.releaseReason) &&
  releaseRecorded &&
  claim.owner.agentId === registered.agentId &&
  claim.path === worktree.path &&
  claim.branch === worktree.branch &&
  claim.headSha === worktree.headSha &&
  claim.changeDigest === worktree.changeDigest &&
  liveClaim === undefined;

interface ReleaseContext {
  /** The unreleased claim that holds the checkout now, if any. */
  liveClaim: WorktreeClaim | undefined;
  /** The linked claim's release recorded the state from the present checkout. */
  releaseRecorded: boolean;
}

/** The claim that holds a checkout now: the one it has not released. */
const liveClaimFor = (
  document: WorktreeCoordinationDocument,
  commonGitDirectory: string,
  path: string
): WorktreeClaim | undefined =>
  document.claims.find(
    (claim) =>
      claim.commonGitDirectory === commonGitDirectory &&
      claim.path === path &&
      claim.state !== "released"
  );

interface WorktreeClaimContext extends ReleaseContext {
  /** The active claim that admits a concurrent author on this checkout. */
  concurrentClaim: WorktreeClaim | undefined;
  /** The claim the registration names, in any state. */
  linkedClaim: WorktreeClaim | undefined;
}

const SAFE_COMMAND_WORD_PATTERN = /^[A-Za-z0-9._:/@%+=,-]+$/u;

// Quote a value only when a POSIX shell would split or expand it.
const commandWord = (value: string): string =>
  SAFE_COMMAND_WORD_PATTERN.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;

interface StaleClaimRecovery {
  commands: string[];
  text: string;
}

const ACCEPT_PAUSED_CHANGE = "simple-changes loop accept-paused-change";

const LOOP_VERIFY = "simple-changes loop verify";

/**
 * Every stale link's recovery commands, ordered to run as printed: owners
 * claim and pause every checkout before the controller accepts any receipt,
 * because an acceptance refuses while a changed sibling still lacks its own
 * current receipt, and verification runs once at the end. Each acceptance is
 * bound to its path by the receipt it names.
 */
export const staleClaimRecoveryCommands = (
  violations: readonly LoopViolation[]
): string[] => {
  const ownerSteps: string[] = [];
  const accepts: string[] = [];
  const verifies = new Set<string>();
  for (const command of violations.flatMap(
    (violation) => violation.nextCommands ?? []
  )) {
    if (command.startsWith(`${ACCEPT_PAUSED_CHANGE} `)) {
      accepts.push(command);
    } else if (command.startsWith(`${LOOP_VERIFY} `)) {
      verifies.add(command);
    } else {
      ownerSteps.push(command);
    }
  }
  return [...ownerSteps, ...accepts, ...verifies];
};

/**
 * The exact recovery for one stale coordination link or changed retained
 * checkout. A released claim is never refreshed (a new claim gets a new ID),
 * so the live claim's owner, or the registered owner when nothing holds the
 * checkout, claims and pauses its exact current state, and the controller
 * accepts that pause receipt; this works from any claim state, and an author
 * who wants to keep working simply claims the checkout again afterwards.
 * While the checkout itself stops `worktree pause` (it is missing, mid Git
 * operation, or conflicted), or the controller that must accept has been
 * relinquished, the only steps are the ones that unblock it; verification
 * then prints the commands.
 */
const staleClaimRecovery = (
  lease: LoopLease,
  registered: LoopWorktreeLease,
  worktree: WorktreeInventory,
  { linkedClaim, liveClaim }: WorktreeClaimContext
): StaleClaimRecovery => {
  const repo = controllerRepo(lease);
  if (controllerLifecycle(lease).status !== "active") {
    const resume = `simple-changes loop start --mode resume --agent-id <you> --repo ${repo}`;
    const verify = `${LOOP_VERIFY} --run-id ${lease.runId} --repo ${repo}`;
    return {
      commands: [resume, verify],
      text: `Its controller has been relinquished, so nothing can accept a pause yet: resume the run with \`${resume}\`, then re-run \`${verify}\` for its exact recovery steps.`,
    };
  }
  const blocker = pauseBlocker(worktree);
  if (blocker) {
    const unblock = {
      absent: `Restore the checkout at ${worktree.path}${worktree.branch ? ` on branch ${worktree.branch}` : ""}`,
      conflicts: `Resolve the conflicts in ${worktree.path}`,
      "git-operation": `Finish or abort the Git operation in ${worktree.path}`,
    }[blocker];
    const step = `${unblock}, then re-run \`${LOOP_VERIFY} --run-id ${lease.runId} --repo ${repo}\` for its exact recovery steps.`;
    return {
      commands: [step],
      text: `It cannot be paused yet. ${step}`,
    };
  }
  const controller = commandWord(lease.ownerAgentId);
  const verify = `${LOOP_VERIFY} --run-id ${lease.runId} --repo ${repo}`;
  // Only the active controller may claim the primary checkout, so another
  // agent still holding it releases it first.
  const primary = worktree.isPrimary || worktree.path === lease.primaryCheckout;
  if (primary && liveClaim && liveClaim.owner.agentId !== lease.ownerAgentId) {
    const release = `simple-changes worktree release --agent-id ${commandWord(liveClaim.owner.agentId)} --claim-id ${liveClaim.claimId} --repo ${repo}`;
    return {
      commands: [release, verify],
      text: `Only the active controller ${controller} may claim the primary checkout, which ${liveClaim.owner.agentId} still holds: run \`${release}\`, then re-run \`${verify}\` for its exact recovery steps.`,
    };
  }
  const candidate = liveClaim?.owner ?? linkedClaim?.owner;
  const owner =
    primary && candidate?.agentId !== lease.ownerAgentId
      ? undefined
      : candidate;
  const ownerId = primary
    ? lease.ownerAgentId
    : (owner?.agentId ?? registered.agentId);
  const agent = ownerId ? commandWord(ownerId) : "<owner>";
  const path = commandWord(worktree.path);
  const claim = [
    `simple-changes worktree claim --agent-id ${agent} --worktree ${path}`,
    `--adapter ${owner ? commandWord(owner.adapter) : "<adapter>"}`,
    ...(owner?.ownerRef ? [`--owner-ref ${commandWord(owner.ownerRef)}`] : []),
    `--repo ${repo}`,
  ].join(" ");
  const pause = `simple-changes worktree pause --agent-id ${agent} --worktree ${path} --run-id ${lease.runId} --disposition preserve-in-place --reason <why> --repo ${repo}`;
  const accept = `${ACCEPT_PAUSED_CHANGE} --run-id ${lease.runId} --agent-id ${controller} --pause-receipt <pause-receipt-id> --repo ${repo}`;
  return {
    commands: [claim, pause, accept],
    text: `Owner ${agent} runs \`${claim}\`, then \`${pause}\`; controller ${controller} then runs \`${accept}\` with the receipt ID the pause prints.${handoffHint(primary, linkedClaim, liveClaim)}`,
  };
};

// A completed release with nothing holding the checkout may be an ownership
// handoff: no command moves a claim, so the new owner runs the same claim and
// pause under its own identity, and verification then names it.
const handoffHint = (
  primary: boolean,
  linkedClaim: WorktreeClaim | undefined,
  liveClaim: WorktreeClaim | undefined
): string =>
  !primary &&
  liveClaim === undefined &&
  linkedClaim?.state === "released" &&
  linkedClaim.releaseReason !== undefined &&
  COMPLETED_RELEASE_REASONS.has(linkedClaim.releaseReason)
    ? " If the checkout is passing to a new owner, the new owner runs the same claim and pause with its own agent ID and adapter instead, and the controller accepts that receipt."
    : "";

// A completed release that recorded its checkout's exact state: that state
// is the unit's recorded head, whoever holds the checkout now.
const recordedRelease = (
  registered: LoopWorktreeLease,
  claim: WorktreeClaim | undefined,
  coordination: WorktreeCoordinationDocument
): claim is WorktreeClaim =>
  claim?.state === "released" &&
  claim.releaseReason !== undefined &&
  COMPLETED_RELEASE_REASONS.has(claim.releaseReason) &&
  releaseRecordedState(coordination, claim.claimId) &&
  claim.owner.agentId === registered.agentId &&
  claim.path === registered.path;

/**
 * Every registered unit whose branch the run does not move itself, with the
 * heads the run recorded for it: the state its owner released or handed off,
 * or a preserved, adopted, or retained baseline plus any exact approved
 * override. The controller and its own prepared authors are not pinned, nor
 * is the primary or target branch. See `pinned-heads.ts` for the boundary.
 */
const pinnedUnitsFor = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  coordination: WorktreeCoordinationDocument
): PinnedUnit[] => {
  const { primaryBranch, targetBranch } = resolvePrimaryAndTargetBranches(
    lease,
    inventory
  );
  const units: PinnedUnit[] = [];
  for (const unit of lease.worktrees.flatMap((registered) =>
    registrationPins(lease, registered, coordination)
  )) {
    if (
      (unit.branch === null ||
        (unit.branch !== primaryBranch && unit.branch !== targetBranch)) &&
      !units.some(
        (existing) =>
          existing.branch === unit.branch && existing.path === unit.path
      )
    ) {
      units.push(unit);
    }
  }
  return units;
};

// One registration's pins. A concurrent author whose release recorded its
// exact state is pinned to that state; its registered branch, when it
// differs, and an author still holding its claim have no recorded head. A
// detached checkout is pinned by its path and head alone.
const registrationPins = (
  lease: LoopLease,
  registered: LoopWorktreeLease,
  coordination: WorktreeCoordinationDocument
): PinnedUnit[] => {
  const { branch, path } = registered;
  if (registered.role === "concurrent-author") {
    const claim = coordination.claims.find(
      (item) => item.claimId === registered.claimId
    );
    const pins: PinnedUnit[] = [];
    const released = recordedRelease(registered, claim, coordination);
    if (released) {
      pins.push({
        branch: claim.branch,
        owner: claim.owner.agentId,
        path,
        recordedHeads: claim.headSha ? [claim.headSha] : [],
        state: claim.releaseReason === "handoff" ? "handed-off" : "released",
      });
    }
    if (!released || (branch && branch !== claim.branch)) {
      pins.push({
        branch,
        owner: claim?.owner.agentId ?? registered.agentId,
        path,
        recordedHeads: [],
        state: claim && claim.state !== "released" ? "claimed" : "unrecorded",
      });
    }
    return pins;
  }
  if (!(registered.role === "preserved" || registered.role === "retained")) {
    return [];
  }
  return [
    {
      branch,
      owner: registered.agentId,
      path,
      recordedHeads: [
        registered.baselineHeadSha,
        ...lease.overrides
          .filter((override) => override.path === path)
          .map((override) => override.headSha),
      ].filter((head): head is string => Boolean(head)),
      state: pinnedBaselineState(registered),
    },
  ];
};

const pinnedBaselineState = (
  registered: LoopWorktreeLease
): PinnedUnitState => {
  if (registered.role === "retained") {
    return "retained";
  }
  return registered.claimId && registered.pauseReceiptId
    ? "adopted"
    : "preserved";
};

const absentWorktree = (registered: LoopWorktreeLease): WorktreeInventory => ({
  bare: false,
  branch: registered.branch,
  changeDigest: registered.baselineChangeDigest,
  changes: [],
  detached: false,
  headSha: null,
  isCurrent: false,
  isPrimary: false,
  locked: false,
  path: registered.path,
  prunable: true,
});

// The claim, pause, and accept steps that record a pinned unit's current
// state, exactly as a stale coordination link prints them.
const pinnedUnitRecovery = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  coordination: WorktreeCoordinationDocument,
  unit: PinnedUnit
): StaleClaimRecovery | null => {
  const registered = lease.worktrees.find((item) => item.path === unit.path);
  if (!registered) {
    return null;
  }
  const current =
    inventory.worktrees.find((item) => item.path === unit.path) ??
    absentWorktree(registered);
  return staleClaimRecovery(lease, registered, current, {
    concurrentClaim: undefined,
    linkedClaim: coordination.claims.find(
      (claim) => claim.claimId === registered.claimId
    ),
    liveClaim: liveClaimFor(coordination, lease.commonGitDirectory, unit.path),
    releaseRecorded: false,
  });
};

const localBranchHeads = (repositoryPath: string): Map<string, string> =>
  new Map(
    runGit(
      repositoryPath,
      ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/"],
      true
    )
      .stdout.split("\n")
      .filter(Boolean)
      .map((line): [string, string] => {
        const [name = "", head = ""] = line.split("\0");
        return [name.slice("refs/heads/".length), head];
      })
  );

const PINNED_BOUNDARY =
  "No merge-like `loop exec` command can integrate a commit other than a registered unit's recorded head, and a branch name can move while the command waits.";

// What to do about one pinned unit a refused command named: the commit to
// name instead, whether its branch has already moved, or why there is none.
const pinnedUnitGuidance = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  coordination: WorktreeCoordinationDocument,
  unit: PinnedUnit,
  current: string | null,
  subcommand: string | null
): string[] => {
  const recorded = unit.recordedHeads.at(-1);
  const recovery = pinnedUnitRecovery(lease, inventory, coordination, unit);
  const recoverySteps = (recovery?.commands ?? []).map(
    (command) => `  Next: ${command}`
  );
  if (!recorded) {
    return unit.state === "claimed"
      ? [
          `- ${describePinnedUnit(unit)} has no recorded head: the run integrates it only after its owner releases or hands it off, which records the exact commit.`,
        ]
      : [
          `- ${describePinnedUnit(unit)} has no recorded head. Record its current state first:`,
          ...recoverySteps,
        ];
  }
  if (current && !unit.recordedHeads.includes(current)) {
    return [
      `- ${describePinnedUnit(unit)} has moved from its recorded head ${recorded} to ${current}. Name ${recorded} to integrate the recorded commit, or record the newer one first:`,
      ...recoverySteps,
    ];
  }
  const notes = [
    `- ${describePinnedUnit(unit)}: replace the branch name with its recorded head ${recorded}.`,
  ];
  if (subcommand === "push" && unit.branch) {
    notes.push(
      `  A push names the destination in full: ${recorded}:refs/heads/${unit.branch}.`
    );
  }
  if (subcommand === "merge") {
    notes.push(
      "  A merge commit then names the commit ID instead of the branch; pass -m to keep a branch-named title."
    );
  }
  return notes;
};

const pinnedRefusalMessage = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  coordination: WorktreeCoordinationDocument,
  argv: readonly string[],
  analysis: PinnedCommandAnalysis,
  facts: PinnedGitFacts,
  invocation: { agentId: string; checkout: string; runId: string }
): string => {
  const heads = new Map(
    facts.refs([]).map((ref) => [ref.name, ref.object] as const)
  );
  const lines = [
    `loop exec refused ${JSON.stringify(argv)} before starting it. ${PINNED_BOUNDARY}`,
  ];
  for (const item of analysis.refusals) {
    lines.push(`- ${item.detail}.`);
  }
  const loopExec = `simple-changes loop exec --run-id ${invocation.runId} --agent-id ${commandWord(invocation.agentId)} --repo ${commandWord(invocation.checkout)} --`;
  if (analysis.equivalent) {
    lines.push(
      "Run the equivalent command, which names the recorded commit instead:",
      `  Next: ${loopExec} ${analysis.equivalent.map(commandWord).join(" ")}`
    );
    return lines.join("\n");
  }
  const named = [
    ...new Set(
      analysis.refusals.flatMap((item) => (item.unit ? [item.unit] : []))
    ),
  ];
  for (const unit of named) {
    // Where the unit is now: its branch, or its checkout when that moved.
    const current = [
      unit.branch ? heads.get(`refs/heads/${unit.branch}`) : undefined,
      inventory.worktrees.find((worktree) => worktree.path === unit.path)
        ?.headSha,
    ].filter((head): head is string => Boolean(head));
    lines.push(
      ...pinnedUnitGuidance(
        lease,
        inventory,
        coordination,
        unit,
        current.find((head) => !unit.recordedHeads.includes(head)) ??
          current[0] ??
          null,
        analysis.subcommand
      )
    );
  }
  if (named.length === 0) {
    lines.push(
      "Name each unit by its recorded commit ID instead; run the underlying Git subcommand directly, without an alias, wrapper, or indirect name."
    );
  }
  return lines.join("\n");
};

/**
 * Refuses a guarded command before it starts when it could integrate a
 * pinned unit's branch by name instead of by its recorded head.
 */
const assertPinnedHeads = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  argv: readonly string[],
  invocation: { agentId: string; checkout: string; runId: string }
): void => {
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const pins = pinnedUnitsFor(lease, inventory, coordination);
  if (pins.length === 0) {
    return;
  }
  const facts = gitFactsFor(invocation.checkout, lease.commonGitDirectory);
  const analysis = analyzePinnedCommand(argv, {
    checkout: invocation.checkout,
    checkoutHeads: new Map(
      inventory.worktrees.map((worktree) => [worktree.path, worktree.headSha])
    ),
    commonGitDirectory: lease.commonGitDirectory,
    facts,
    ownCheckouts: lease.worktrees
      .filter(
        (worktree) =>
          worktree.role === "controller" || worktree.role === "author"
      )
      .map((worktree) => worktree.path),
    pins,
    worktreePaths: inventory.worktrees.map((worktree) => worktree.path),
  });
  if (analysis.refusals.length > 0) {
    throw new SimpleChangesError(
      pinnedRefusalMessage(
        lease,
        inventory,
        coordination,
        argv,
        analysis,
        facts,
        invocation
      ),
      EXIT_CODES.unsafe
    );
  }
};

// States whose recorded head `loop verify --for merge` holds the branch to.
const MERGE_VERIFIED_STATES: ReadonlySet<PinnedUnitState> = new Set([
  "adopted",
  "handed-off",
  "preserved",
  "released",
]);

/**
 * Before a merge, each released, handed-off, preserved, or adopted unit's
 * local branch must still point at a head the run recorded. A checkout that
 * is still present and on its branch already fails verification when it
 * moves; this also covers a branch that moved without its checkout, such as
 * after the checkout was removed or switched to another branch.
 */
const registeredBranchViolations = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  existing: readonly LoopViolation[]
): LoopViolation[] => {
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const flagged = new Set(existing.map((violation) => violation.path));
  const retired = retiredAbsentPaths(lease, inventory);
  const heads = localBranchHeads(lease.primaryCheckout);
  const violations: LoopViolation[] = [];
  for (const unit of pinnedUnitsFor(lease, inventory, coordination)) {
    const head = unit.branch ? heads.get(unit.branch) : undefined;
    const recorded = unit.recordedHeads.at(-1);
    if (
      !(head && recorded && MERGE_VERIFIED_STATES.has(unit.state)) ||
      unit.recordedHeads.includes(head) ||
      flagged.has(unit.path) ||
      retired.has(unit.path) ||
      removalDispositionForPath(lease, unit.path)
    ) {
      continue;
    }
    const recovery = pinnedUnitRecovery(lease, inventory, coordination, unit);
    violations.push({
      changeDigest:
        inventory.worktrees.find((worktree) => worktree.path === unit.path)
          ?.changeDigest ?? null,
      code: "registered-branch-moved",
      headSha: head,
      message:
        `Branch ${describePinnedUnit(unit)} moved from its recorded head ${recorded} to ${head}, so a merge that names it would integrate a commit this run never recorded. ${recovery?.text ?? ""}`.trim(),
      ...(recovery ? { nextCommands: recovery.commands } : {}),
      path: unit.path,
    });
    flagged.add(unit.path);
  }
  return violations;
};

const staleConcurrentClaimCause = (
  registered: LoopWorktreeLease,
  { linkedClaim, liveClaim, releaseRecorded }: WorktreeClaimContext
): string => {
  const claimId = registered.claimId ?? "(none)";
  if (liveClaim && liveClaim.claimId !== registered.claimId) {
    return `This concurrent author worktree is now held by claim ${liveClaim.claimId} of ${liveClaim.owner.agentId}, not by its registered claim ${claimId}.`;
  }
  if (linkedClaim?.state === "released") {
    const reason = linkedClaim.releaseReason ?? "unrecorded";
    const never =
      "A released claim is never refreshed; a new claim gets a new ID.";
    if (
      !(
        linkedClaim.releaseReason &&
        COMPLETED_RELEASE_REASONS.has(linkedClaim.releaseReason)
      )
    ) {
      return `The registered claim ${claimId} of this concurrent author worktree was released (${reason}), which does not hand its work off. ${never}`;
    }
    return releaseRecorded
      ? `This concurrent author worktree no longer matches the exact state ${linkedClaim.owner.agentId} released under claim ${claimId} (${reason}). ${never}`
      : `The registered claim ${claimId} of this concurrent author worktree was released (${reason}) without recording the checkout's state at release, so no state is admitted. ${never}`;
  }
  if (linkedClaim) {
    return `The registered claim ${claimId} of this concurrent author worktree is ${linkedClaim.state} or records another branch.`;
  }
  return `The registered claim ${claimId} of this concurrent author worktree no longer exists.`;
};

const concurrentClaimViolations = (
  lease: LoopLease,
  registered: LoopWorktreeLease,
  claims: WorktreeClaimContext,
  worktree: WorktreeInventory
): LoopViolation[] => {
  const { concurrentClaim, linkedClaim } = claims;
  if (
    registered.role !== "concurrent-author" ||
    completedReleaseMatches(registered, linkedClaim, worktree, claims) ||
    (concurrentClaim &&
      concurrentClaim.claimId === registered.claimId &&
      concurrentClaim.owner.agentId === registered.agentId)
  ) {
    return [];
  }
  const recovery = staleClaimRecovery(lease, registered, worktree, claims);
  return [
    {
      changeDigest: worktree.changeDigest,
      code: "coordination-claim-stale",
      headSha: worktree.headSha,
      message: `${staleConcurrentClaimCause(registered, claims)} ${recovery.text}`,
      nextCommands: recovery.commands,
      path: worktree.path,
    },
  ];
};

const retainedWorktreeViolations = (
  lease: LoopLease,
  registered: LoopWorktreeLease,
  worktree: WorktreeInventory,
  claims: WorktreeClaimContext
): LoopViolation[] => {
  if (registered.role !== "retained") {
    return [];
  }
  const violations: LoopViolation[] = [];
  if (!registered.retention) {
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "retained-worktree-authorization-missing",
      headSha: worktree.headSha,
      message:
        "A retained excluded worktree has no approval receipt. Record exact retention evidence before cleanup can exempt it.",
      path: worktree.path,
    });
  }
  if (
    registered.baselineHeadSha !== worktree.headSha ||
    registered.baselineChangeDigest !== worktree.changeDigest
  ) {
    // Claiming promotes it only under allow-claimed, so print the pause and
    // accept steps, which work under every policy.
    const recovery = staleClaimRecovery(lease, registered, worktree, claims);
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "retained-worktree-changed",
      headSha: worktree.headSha,
      message: `A retained excluded worktree changed. ${recovery.text}`,
      nextCommands: recovery.commands,
      path: worktree.path,
    });
  }
  return violations;
};

const unregisteredWorktreeViolations = (
  lease: LoopLease,
  worktree: WorktreeInventory,
  preparation: LoopWorktreePreparation | undefined,
  concurrentClaim: WorktreeClaim | undefined
): LoopViolation[] => {
  if (
    preparation &&
    worktree.branch === preparation.branch &&
    worktree.headSha === preparation.baseRevision
  ) {
    return [];
  }
  if (effectiveShipmentScopeFrozenAt(lease) && concurrentClaim) {
    return [];
  }
  return [
    {
      changeDigest: worktree.changeDigest,
      code: "unregistered-worktree",
      headSha: worktree.headSha,
      message:
        "A worktree appeared after loop start without run registration. Preserve it and prepare an isolated agent worktree instead.",
      path: worktree.path,
    },
  ];
};

const currentWorktreeViolations = (
  lease: LoopLease,
  worktree: WorktreeInventory,
  registered: LoopWorktreeLease | undefined,
  preparation: LoopWorktreePreparation | undefined,
  claims: WorktreeClaimContext
): LoopViolation[] => {
  if (!registered) {
    return unregisteredWorktreeViolations(
      lease,
      worktree,
      preparation,
      claims.concurrentClaim
    );
  }
  const violations = concurrentClaimViolations(
    lease,
    registered,
    claims,
    worktree
  );
  violations.push(
    ...retainedWorktreeViolations(lease, registered, worktree, claims)
  );
  if (
    registered.role === "preserved" &&
    (registered.baselineHeadSha !== worktree.headSha ||
      registered.baselineChangeDigest !== worktree.changeDigest) &&
    !matchingOverride(lease, worktree) &&
    !matchingRemovalDisposition(lease, worktree)
  ) {
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "preserved-worktree-changed",
      headSha: worktree.headSha,
      message:
        "A baseline worktree changed after loop start. Its exact path and current status digest need a recorded user-approved override before integration continues.",
      path: worktree.path,
    });
  }
  if (
    registered.role === "preserved" &&
    registered.claimId &&
    registered.pauseReceiptId &&
    !coordinationLinkIsCurrent(
      lease.commonGitDirectory,
      registered.claimId,
      registered.pauseReceiptId,
      worktree
    )
  ) {
    const recovery = staleClaimRecovery(lease, registered, worktree, claims);
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "coordination-claim-stale",
      headSha: worktree.headSha,
      message: `The adopted worktree claim or pause receipt no longer matches current coordination and Git evidence. ${recovery.text}`,
      nextCommands: recovery.commands,
      path: worktree.path,
    });
  }
  if (
    registered.role === "preserved" &&
    ((registered.claimId && !registered.pauseReceiptId) ||
      (!registered.claimId && registered.pauseReceiptId))
  ) {
    const recovery = staleClaimRecovery(lease, registered, worktree, claims);
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "coordination-claim-stale",
      headSha: worktree.headSha,
      message: `The worktree lease has an incomplete coordination linkage. ${recovery.text}`,
      nextCommands: recovery.commands,
      path: worktree.path,
    });
  }
  if (registered.mutationAllowed && registered.branch !== worktree.branch) {
    violations.push({
      changeDigest: worktree.changeDigest,
      code: "registered-worktree-branch-changed",
      headSha: worktree.headSha,
      message: `A mutation-authorized worktree moved from registered branch ${registered.branch ?? "(detached)"} to ${worktree.branch ?? "(detached)"}. Resume only from its recorded branch.`,
      path: worktree.path,
    });
  }
  return violations;
};

const verificationAgainst = (
  lease: LoopLease,
  inventory: RepositoryInventory
): LoopVerification => {
  const violations: LoopViolation[] = [];
  if (inventory.repository.commonGitDirectory !== lease.commonGitDirectory) {
    violations.push({
      changeDigest: null,
      code: "common-git-directory-mismatch",
      headSha: inventory.repository.headSha,
      message:
        "The checkout belongs to a different common Git directory than the active loop.",
      path: inventory.repository.currentCheckout,
    });
  }
  if (!lease.remoteBindings) {
    violations.push({
      changeDigest: null,
      code: "remote-destination-rebind-required",
      headSha: inventory.repository.headSha,
      message:
        "This legacy controller predates remote destination binding. Relinquish it and start a current controller before any guarded remote mutation.",
      path: inventory.repository.currentCheckout,
    });
  } else if (
    JSON.stringify(inventory.repository.remoteBindings) !==
    JSON.stringify(lease.remoteBindings)
  ) {
    violations.push({
      changeDigest: null,
      code: "remote-destination-changed",
      headSha: inventory.repository.headSha,
      message:
        "A Git remote fetch or push destination changed after loop start. Re-verify the exact repository destination before starting a new controller lease.",
      path: inventory.repository.currentCheckout,
    });
  }
  const registeredByPath = new Map(
    lease.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const currentByPath = new Map(
    inventory.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const preparationByPath = new Map(
    lease.preparations.map((preparation) => [preparation.path, preparation])
  );
  const coordination = readCoordinationDocumentFromCommonDirectory(
    lease.commonGitDirectory
  );
  const { primaryBranch, targetBranch } = resolvePrimaryAndTargetBranches(
    lease,
    inventory
  );
  const retired = retiredAbsentPaths(lease, inventory);
  for (const worktree of inventory.worktrees) {
    if (retired.has(worktree.path)) {
      continue;
    }
    const concurrentClaim = concurrentClaimFor(
      lease,
      worktree,
      coordination,
      primaryBranch,
      targetBranch
    );
    const registered = registeredByPath.get(worktree.path);
    const linkedClaim = registered?.claimId
      ? coordination.claims.find(
          (claim) => claim.claimId === registered.claimId
        )
      : undefined;
    const liveClaim = liveClaimFor(
      coordination,
      lease.commonGitDirectory,
      worktree.path
    );
    violations.push(
      ...currentWorktreeViolations(
        lease,
        worktree,
        registered,
        preparationByPath.get(worktree.path),
        {
          concurrentClaim,
          linkedClaim,
          liveClaim,
          releaseRecorded:
            linkedClaim !== undefined &&
            releaseRecordedState(coordination, linkedClaim.claimId),
        }
      )
    );
  }
  for (const preparation of lease.preparations) {
    violations.push({
      changeDigest: currentByPath.get(preparation.path)?.changeDigest ?? null,
      code: "incomplete-worktree-preparation",
      headSha: currentByPath.get(preparation.path)?.headSha ?? null,
      message:
        "An agent worktree preparation did not finish registration. Resume prepare-agent for that agent before any other mutation.",
      path: preparation.path,
    });
  }
  for (const registered of lease.worktrees) {
    if (
      registered.role === "preserved" &&
      !currentByPath.has(registered.path) &&
      !removalDispositionForPath(lease, registered.path) &&
      !retired.has(registered.path)
    ) {
      violations.push({
        changeDigest: null,
        code: "missing-preserved-worktree",
        headSha: null,
        message:
          "A baseline worktree disappeared after loop start. The loop cannot assume that deletion was safe.",
        path: registered.path,
      });
    }
    if (
      registered.role === "retained" &&
      !currentByPath.has(registered.path) &&
      !removalDispositionForPath(lease, registered.path)
    ) {
      violations.push({
        changeDigest: null,
        code: "missing-retained-worktree",
        headSha: null,
        message:
          "A retained excluded worktree disappeared. The loop cannot assume its removal was safe.",
        path: registered.path,
      });
    }
  }
  return {
    active: true,
    checkedAt: new Date().toISOString(),
    // Reported evidence of the whole current inventory. It is not a scope
    // gate: record-scope checks its own narrower invariants.
    currentBaselineDigest: inventory.baselineDigest,
    ok: violations.length === 0,
    runId: lease.runId,
    violations,
  };
};

const registeredController = (lease: LoopLease): LoopWorktreeLease | null =>
  lease.worktrees.find((worktree) => worktree.role === "controller") ?? null;

// The controller checkout, quoted for a printed `--repo`, so a printed step
// runs from anywhere; `loop start` in particular makes the checkout it runs
// in the controller.
const controllerRepo = (lease: LoopLease): string =>
  commandWord(registeredController(lease)?.path ?? lease.primaryCheckout);

const emptyVerification = (
  inventory: RepositoryInventory
): LoopVerification => ({
  active: false,
  checkedAt: new Date().toISOString(),
  currentBaselineDigest: inventory.baselineDigest,
  ok: true,
  runId: null,
  violations: [],
});

export interface LoopVerifyOptions {
  /**
   * Also hold each released, handed-off, preserved, or adopted unit's branch
   * to its recorded head, as `loop verify --for merge` does.
   */
  forMerge?: boolean;
}

export const verifyLoop = (
  repositoryPath: string,
  options: LoopVerifyOptions = {}
): LoopVerification => {
  const opening = locateRepository(repositoryPath);
  return withStateLock(
    opening.repository.commonGitDirectory,
    "loop verify",
    () => {
      const inventory = captureInventory(repositoryPath);
      const storedLease = readLeaseFromCommonDirectory(
        inventory.repository.commonGitDirectory
      );
      if (!storedLease) {
        return emptyVerification(inventory);
      }
      const projected = withConcurrentAuthorAdmissions(storedLease, inventory);
      const lease =
        controllerLifecycle(storedLease).status === "active"
          ? writeLease({
              ...projected,
              ownerProcess: ownerProcessEvidence(new Date().toISOString()),
              updatedAt: new Date().toISOString(),
            })
          : projected;
      const verification = verificationAgainst(lease, inventory);
      if (!options.forMerge) {
        return verification;
      }
      const violations = [
        ...verification.violations,
        ...registeredBranchViolations(
          lease,
          inventory,
          verification.violations
        ),
      ];
      return { ...verification, ok: violations.length === 0, violations };
    }
  );
};

/**
 * A Ship run that still owes its first shipment scope may close without it
 * only when it provably did nothing. `firstMutationAt` must be explicitly
 * null, because a lease written before the field existed cannot prove that,
 * and the lease must carry no other evidence of action: no preparation,
 * disposition, override, rebaseline, retirement, Emergency Shipping state,
 * shipment outcome, remote reconciliation, target-equivalent outcome,
 * superseded or frozen scope, controller handoff or relinquishment, and no
 * worktree that the run created, retained, adopted, or marked resume-ready.
 */
const isUnmutatedScopelessRun = (lease: LoopLease): boolean => {
  const lifecycle = controllerLifecycle(lease);
  return (
    lease.shipmentScopeRequired === true &&
    !lease.shipmentScope &&
    lease.firstMutationAt === null &&
    lease.preparations.length === 0 &&
    (lease.dispositions ?? []).length === 0 &&
    lease.overrides.length === 0 &&
    (lease.rebaselines ?? []).length === 0 &&
    (lease.retirements ?? []).length === 0 &&
    !lease.emergencyShipping &&
    !lease.shipmentOutcome &&
    !lease.remoteBranchReconciliation &&
    !lease.closeEquivalentOutcome &&
    (lease.shipmentScopeHistory ?? []).length === 0 &&
    !effectiveShipmentScopeFrozenAt(lease) &&
    lifecycle.status === "active" &&
    lifecycle.handoffs.length === 0 &&
    lease.worktrees.every(
      (worktree) =>
        !worktree.createdByRun &&
        worktree.role !== "author" &&
        worktree.role !== "retained" &&
        worktree.retention === undefined &&
        worktree.pauseReceiptId === undefined &&
        worktree.coordinationState === undefined
    )
  );
};

// Violations an untouched run may still close over. Each describes a change
// that someone else made to a worktree this run never had authority over: an
// opening checkout its owner kept editing, or a concurrent author whose claim
// lapsed. Closing deletes nothing, and the next loop start re-baselines both.
// Every other code refuses the close. A new unregistered worktree, a missing
// opening worktree, a moved controller branch, or a changed remote destination
// may be this run acting outside the loop, and a wrong-repository or legacy
// binding cannot vouch for itself. Retained, preparation, and adopted-claim
// codes cannot arise without evidence that already disqualifies the run.
const UNMUTATED_CLOSE_COMPATIBLE_VIOLATIONS: ReadonlySet<
  LoopViolation["code"]
> = new Set(["coordination-claim-stale", "preserved-worktree-changed"]);

/**
 * Returns null when the untouched-run close does not apply, so the ordinary
 * completion gates decide. Otherwise returns the violations that still refuse
 * it; an empty list means the run may close without mutation.
 */
const unmutatedCloseBlockers = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification
): string[] | null => {
  if (
    !isUnmutatedScopelessRun(lease) ||
    (targetUsesGitLab(inventory) && !lease.openingRemoteInventory)
  ) {
    return null;
  }
  return verification.violations
    .filter(
      (violation) => !UNMUTATED_CLOSE_COMPATIBLE_VIOLATIONS.has(violation.code)
    )
    .map((violation) => `${violation.code}:${violation.path}`);
};

const unmutatedCloseReady = (
  lease: LoopLease,
  inventory: RepositoryInventory,
  verification: LoopVerification
): boolean =>
  unmutatedCloseBlockers(lease, inventory, verification)?.length === 0;

export type { ReleaseContext };
export {
  assertPinnedHeads,
  completedReleaseMatches,
  controllerRepo,
  emptyVerification,
  isUnmutatedScopelessRun,
  liveClaimFor,
  registeredController,
  unmutatedCloseReady,
  verificationAgainst,
};
