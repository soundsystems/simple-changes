import { sha256Json } from "./hash.ts";
import type {
  WorktreeClaim,
  WorktreeCoordinationDocument,
  WorktreeCoordinationEvent,
  WorktreeInventory,
} from "./types.ts";
import {
  isLiveClaimState,
  releaseEventRecordedState,
} from "./worktree-coordination.ts";

/**
 * What `loop replan-status` shows and a replan approval binds by its digest:
 * the full coordination document, the source inventory digest, and the
 * current target revision.
 */
export interface ReplanObservation {
  coordination: WorktreeCoordinationDocument;
  inventoryDigest: string;
  targetRevision: string;
}

/** A claim its own owner released, exactly as the approval observed it. */
export interface ReplanAcceptedRelease {
  branch: string | null;
  changeDigest: string;
  claimId: string;
  eventId: string;
  headSha: string | null;
  ownerAgentId: string;
  path: string;
  releaseReason: "owner-release" | "handoff";
}

export interface ReplanApprovalDelta {
  acceptedReleases: ReplanAcceptedRelease[];
  approvedCoordinationDigest: string;
  currentCoordinationDigest: string;
  /** Every difference that a verified owner release does not explain. */
  refusals: string[];
}

// A release may change only these claim fields: the state, its reason, its
// time, and the checkout evidence the release recorded.
const RELEASE_FIELDS = new Set([
  "branch",
  "changeDigest",
  "headSha",
  "releaseReason",
  "state",
  "updatedAt",
]);
const COMPLETED_RELEASE_REASONS = new Set(["owner-release", "handoff"]);

const same = (left: unknown, right: unknown): boolean =>
  sha256Json(left ?? null) === sha256Json(right ?? null);

const shown = (value: string | null | undefined): string => value ?? "none";

const claimsById = (
  claims: WorktreeClaim[],
  label: string,
  refusals: string[]
): Map<string, WorktreeClaim> => {
  const map = new Map<string, WorktreeClaim>();
  for (const claim of claims) {
    if (map.has(claim.claimId)) {
      refusals.push(
        `The ${label} coordination repeats claim ${claim.claimId}.`
      );
    }
    map.set(claim.claimId, claim);
  }
  return map;
};

const changedClaimFields = (
  approved: WorktreeClaim,
  current: WorktreeClaim
): string[] =>
  [...new Set([...Object.keys(approved), ...Object.keys(current)])]
    .filter(
      (key) =>
        !same(
          approved[key as keyof WorktreeClaim],
          current[key as keyof WorktreeClaim]
        )
    )
    .sort((left, right) => left.localeCompare(right));

type ClaimReleaseResult =
  | { refusal: string }
  | { event: WorktreeCoordinationEvent; release: ReplanAcceptedRelease };

// The checkout evidence and holder checks of a release whose claim and event
// are already proven to be the owner's own completed release.
const releasedCheckout = (
  label: string,
  approved: WorktreeClaim,
  current: WorktreeClaim,
  event: WorktreeCoordinationEvent,
  coordination: WorktreeCoordinationDocument,
  worktrees: WorktreeInventory[]
): ClaimReleaseResult => {
  const checkout = worktrees.find(
    (worktree) => worktree.path === approved.path && !worktree.prunable
  );
  if (
    !checkout ||
    checkout.branch !== current.branch ||
    checkout.headSha !== current.headSha ||
    checkout.changeDigest !== current.changeDigest
  ) {
    const observed = checkout
      ? `branch ${shown(checkout.branch)}, head ${shown(checkout.headSha)}, status digest ${checkout.changeDigest}`
      : "absent";
    return {
      refusal: `${label} release recorded branch ${shown(current.branch)}, head ${shown(current.headSha)}, status digest ${current.changeDigest}, but the checkout the approval observed is ${observed}.`,
    };
  }
  const holder = coordination.claims.find(
    (claim) =>
      claim.claimId !== approved.claimId &&
      claim.path === approved.path &&
      isLiveClaimState(claim.state)
  );
  if (holder) {
    return {
      refusal: `${label} was released, but claim ${holder.claimId} of ${holder.owner.agentId} now holds that checkout.`,
    };
  }
  return {
    event,
    release: {
      branch: current.branch,
      changeDigest: current.changeDigest,
      claimId: approved.claimId,
      eventId: event.eventId,
      headSha: current.headSha,
      ownerAgentId: approved.owner.agentId,
      path: approved.path,
      releaseReason: current.releaseReason as "owner-release" | "handoff",
    },
  };
};

// One changed claim: accepted only as its owner's own completed release that
// recorded exactly the checkout the approval observed.
const claimRelease = (
  approved: WorktreeClaim,
  current: WorktreeClaim,
  appended: WorktreeCoordinationEvent[],
  coordination: WorktreeCoordinationDocument,
  worktrees: WorktreeInventory[]
): ClaimReleaseResult => {
  const label = `Claim ${approved.claimId} on ${approved.path} (owner ${approved.owner.agentId})`;
  const other = changedClaimFields(approved, current).filter(
    (field) => !RELEASE_FIELDS.has(field)
  );
  if (other.length > 0) {
    return {
      refusal: `${label} changed ${other.join(", ")}, so it was reassigned or rewritten, not released by its owner.`,
    };
  }
  if (
    !isLiveClaimState(approved.state) ||
    current.state !== "released" ||
    !COMPLETED_RELEASE_REASONS.has(current.releaseReason ?? "")
  ) {
    return {
      refusal: `${label} changed from ${approved.state} to ${current.state} (reason ${shown(current.releaseReason)}); only its owner's own owner-release or handoff of a live claim is accepted.`,
    };
  }
  const events = appended.filter((item) => item.claimId === approved.claimId);
  const [event] = events;
  if (events.length !== 1 || !event) {
    return {
      refusal: `${label} has ${events.length} new coordination events; a verified release has exactly one.`,
    };
  }
  if (event.actorAgentId !== approved.owner.agentId) {
    return {
      refusal: `${label} was released by ${event.actorAgentId}, not by its owner.`,
    };
  }
  if (
    !releaseEventRecordedState(approved.claimId)(event) ||
    event.createdAt !== current.updatedAt
  ) {
    return {
      refusal: `${label} was released without recording the checkout's state at release time.`,
    };
  }
  return releasedCheckout(
    label,
    approved,
    current,
    event,
    coordination,
    worktrees
  );
};

const appendedEvents = (
  approved: WorktreeCoordinationDocument,
  current: WorktreeCoordinationDocument,
  refusals: string[]
): WorktreeCoordinationEvent[] => {
  if (
    current.events.length < approved.events.length ||
    !same(current.events.slice(0, approved.events.length), approved.events)
  ) {
    refusals.push(
      "Coordination events the approval observed were removed or rewritten."
    );
    return [];
  }
  return current.events.slice(approved.events.length);
};

// Appended events that no accepted release explains and that no claim
// refusal already reports. Events match by identity, not ID, so a repeated
// event ID cannot pass an unrelated event off as a release.
const unexplainedEvents = (
  appended: WorktreeCoordinationEvent[],
  explained: Set<WorktreeCoordinationEvent>,
  reported: Set<string>
): string[] =>
  appended
    .filter((event) => !(explained.has(event) || reported.has(event.claimId)))
    .map(
      (event) =>
        `New coordination event ${event.eventId}: ${event.actorAgentId} set claim ${event.claimId} to ${event.state}, which no verified release explains.`
    );

const duplicateEventIds = (
  document: WorktreeCoordinationDocument
): string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const event of document.events) {
    if (seen.has(event.eventId)) {
      repeated.add(event.eventId);
    }
    seen.add(event.eventId);
  }
  return [...repeated].map(
    (eventId) => `The current coordination repeats event ${eventId}.`
  );
};

// A release moves its claim to the end of the claims list, in release order;
// every other claim keeps the position the approval observed.
const claimOrderRefusal = (
  approved: WorktreeCoordinationDocument,
  current: WorktreeCoordinationDocument,
  appended: WorktreeCoordinationEvent[],
  explained: Set<WorktreeCoordinationEvent>
): string[] => {
  const releasedIds = appended
    .filter((event) => explained.has(event))
    .map((event) => event.claimId);
  const released = new Set(releasedIds);
  const expected = [
    ...approved.claims
      .map((claim) => claim.claimId)
      .filter((claimId) => !released.has(claimId)),
    ...releasedIds,
  ];
  return same(
    expected,
    current.claims.map((claim) => claim.claimId)
  )
    ? []
    : ["Claims were reordered beyond what the verified releases explain."];
};

const claimDelta = (
  approved: WorktreeCoordinationDocument,
  current: WorktreeCoordinationDocument,
  appended: WorktreeCoordinationEvent[],
  worktrees: WorktreeInventory[],
  refusals: string[]
): ReplanAcceptedRelease[] => {
  const before = claimsById(approved.claims, "approved", refusals);
  const after = claimsById(current.claims, "current", refusals);
  const releases: ReplanAcceptedRelease[] = [];
  const explained = new Set<WorktreeCoordinationEvent>();
  // Claims already reported as removed, new, or not a verified release.
  const reported = new Set<string>();
  for (const [claimId, claim] of before) {
    if (!after.has(claimId)) {
      reported.add(claimId);
      refusals.push(
        `Claim ${claimId} on ${claim.path} (owner ${claim.owner.agentId}) was removed.`
      );
    }
  }
  for (const [claimId, claim] of after) {
    const earlier = before.get(claimId);
    if (!earlier) {
      reported.add(claimId);
      const reason = claim.releaseReason ? `, ${claim.releaseReason}` : "";
      refusals.push(
        `New claim ${claimId} on ${claim.path} (owner ${claim.owner.agentId}, ${claim.state}${reason}).`
      );
    } else if (!same(earlier, claim)) {
      const result = claimRelease(earlier, claim, appended, current, worktrees);
      if ("refusal" in result) {
        reported.add(claimId);
        refusals.push(result.refusal);
      } else {
        explained.add(result.event);
        releases.push(result.release);
      }
    }
  }
  refusals.push(
    ...duplicateEventIds(current),
    ...unexplainedEvents(appended, explained, reported)
  );
  if (reported.size === 0) {
    refusals.push(...claimOrderRefusal(approved, current, appended, explained));
  }
  return releases.sort((left, right) =>
    left.claimId.localeCompare(right.claimId)
  );
};

/**
 * The exact difference between the observation a replan approval bound and
 * the current one. It accepts only verified monotonic owner releases: the
 * owner itself released its own live claim for a completed reason
 * (owner-release or handoff), recording exactly the checkout state the
 * approval observed, and no other claim now holds that checkout. A changed
 * source inventory or target, a new, removed, or reassigned claim, a takeover,
 * or a release by anyone else or with other evidence is a refusal.
 *
 * `worktrees` is the current inventory; when the inventory digest is
 * unchanged, it is the inventory the approval observed.
 */
export const replanApprovalDelta = (
  approved: ReplanObservation,
  current: ReplanObservation,
  worktrees: WorktreeInventory[]
): ReplanApprovalDelta => {
  const refusals: string[] = [];
  if (approved.inventoryDigest !== current.inventoryDigest) {
    refusals.push(
      `The source inventory digest changed from ${approved.inventoryDigest} to ${current.inventoryDigest}.`
    );
  }
  if (approved.targetRevision !== current.targetRevision) {
    refusals.push(
      `The target moved from ${approved.targetRevision} to ${current.targetRevision}.`
    );
  }
  const before = approved.coordination;
  const after = current.coordination;
  if (
    before.repositoryId !== after.repositoryId ||
    before.schemaVersion !== after.schemaVersion
  ) {
    refusals.push("The coordination state belongs to another repository.");
  }
  if (!same(before.receipts, after.receipts)) {
    refusals.push("Pause receipts changed.");
  }
  const appended = appendedEvents(before, after, refusals);
  const acceptedReleases = claimDelta(
    before,
    after,
    appended,
    worktrees,
    refusals
  );
  return {
    acceptedReleases,
    approvedCoordinationDigest: sha256Json(before),
    currentCoordinationDigest: sha256Json(after),
    refusals,
  };
};

/** Whether the approval may stand: only verified owner releases differ. */
export const replanDeltaAccepted = (delta: ReplanApprovalDelta): boolean =>
  delta.refusals.length === 0 && delta.acceptedReleases.length > 0;

const describedRelease = (release: ReplanAcceptedRelease): string =>
  `${release.ownerAgentId} released its own claim ${release.claimId} on ${release.path} (${release.releaseReason}) at branch ${shown(release.branch)}, head ${shown(release.headSha)}, status digest ${release.changeDigest}, exactly as approved.`;

/** The delta as lines a user reviews before a fresh approval. */
export const describeReplanDelta = (delta: ReplanApprovalDelta): string =>
  [
    `Approved coordination digest ${delta.approvedCoordinationDigest}; current ${delta.currentCoordinationDigest}.`,
    ...delta.refusals.map((line) => `- Refused: ${line}`),
    ...delta.acceptedReleases.map(
      (release) => `- Verified owner release: ${describedRelease(release)}`
    ),
  ].join("\n");
