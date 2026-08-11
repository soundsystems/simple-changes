import type {
  EmergencyShippingLedgerEntry,
  EmergencyShippingStatus,
} from "./types.ts";

export type EmergencyShippingAction =
  | "request-break-glass-approval"
  | "request-production-approval"
  | "record-rollback-anchor"
  | "run-focused-checks"
  | "request-independent-review"
  | "merge-reviewed-change"
  | "deploy-candidate"
  | "verify-candidate"
  | "rollback-or-correct"
  | "reconcile-git-and-release"
  | "verify-existing-production"
  | "verify-equivalent-artifact"
  | "deploy-canonical"
  | "complete-cleanup"
  | "complete"
  | "block";

export interface EmergencyShippingDecision {
  action: EmergencyShippingAction;
  reason: string;
  redeployDecision: EmergencyShippingLedgerEntry["redeployDecision"];
  redeployRequired: boolean;
  status: EmergencyShippingStatus;
}

const decision = (
  action: EmergencyShippingAction,
  status: EmergencyShippingStatus,
  reason: string,
  redeployRequired = false,
  redeployDecision: EmergencyShippingLedgerEntry["redeployDecision"] = "pending"
): EmergencyShippingDecision => ({
  action,
  reason,
  redeployDecision,
  redeployRequired,
  status,
});

export const deriveEmergencyShippingStatus = (
  state: EmergencyShippingLedgerEntry
): EmergencyShippingStatus => {
  if (state.independentReview === "changes-requested") {
    return "rollback-required";
  }
  if (state.finalVerificationPassed && state.cleanupCompleted) {
    return "complete";
  }
  if (state.canonicalRevision && state.changelogReconciled) {
    return "canonicalized";
  }
  if (
    state.deployedRevision &&
    state.mode === "break-glass" &&
    state.independentReview === "pending"
  ) {
    return "live-unreviewed";
  }
  if (state.deployedRevision && state.mode === "expedited") {
    return "live-unreconciled";
  }
  if (state.independentReview === "approved") {
    return "reviewed";
  }
  return "ready";
};

const artifactsEquivalent = (state: EmergencyShippingLedgerEntry): boolean =>
  Boolean(
    state.artifactEquivalenceProven &&
      state.deployedArtifactId &&
      state.canonicalArtifactId &&
      state.deployedArtifactId === state.canonicalArtifactId
  );

export const decideEmergencyShipping = (
  state: EmergencyShippingLedgerEntry
): EmergencyShippingDecision => {
  const status = deriveEmergencyShippingStatus(state);

  return (
    decideEmergencyAuthority(state, status) ??
    decideExpeditedPreparation(state, status) ??
    decideCandidateDeployment(state, status) ??
    decideBreakGlassReview(state) ??
    decideCanonicalDelivery(state, status)
  );
};

const decideEmergencyAuthority = (
  state: EmergencyShippingLedgerEntry,
  status: EmergencyShippingStatus
): EmergencyShippingDecision | null => {
  if (state.mode === "break-glass" && !state.breakGlassAuthorized) {
    return decision(
      "request-break-glass-approval",
      status,
      "Deploying before independent review requires explicit run-only direction."
    );
  }
  if (!state.productionAuthorized) {
    return decision(
      "request-production-approval",
      status,
      "Emergency urgency does not independently authorize production."
    );
  }
  if (
    state.mode === "break-glass" &&
    !(state.rollbackAnchorRecorded && state.rollbackSupported)
  ) {
    return decision(
      state.rollbackSupported ? "record-rollback-anchor" : "block",
      state.rollbackSupported ? status : "blocked",
      state.rollbackSupported
        ? "Record the exact previous production identity before the first emergency deployment."
        : "Break-glass deployment requires a proven rollback or corrective-release path."
    );
  }
  if (!state.focusedChecksPassed) {
    return decision(
      "run-focused-checks",
      status,
      "Run the smallest meaningful checks against the exact candidate revision."
    );
  }
  return null;
};

const decideExpeditedPreparation = (
  state: EmergencyShippingLedgerEntry,
  status: EmergencyShippingStatus
): EmergencyShippingDecision | null => {
  if (state.mode === "expedited") {
    if (state.independentReview === "pending") {
      return decision(
        "request-independent-review",
        status,
        "Expedited shipping preserves independent review before merge and deployment."
      );
    }
    if (state.independentReview === "changes-requested") {
      return decision(
        "block",
        "blocked",
        "The expedited candidate cannot ship while review requests changes."
      );
    }
    if (!state.mergeCompleted) {
      return decision(
        "merge-reviewed-change",
        status,
        "Merge the exact independently approved candidate before deploying it."
      );
    }
  }
  return null;
};

const decideCandidateDeployment = (
  state: EmergencyShippingLedgerEntry,
  status: EmergencyShippingStatus
): EmergencyShippingDecision | null => {
  if (!state.deployedRevision) {
    return decision(
      "deploy-candidate",
      status,
      state.mode === "break-glass"
        ? "Deploy the exact checked candidate under explicit break-glass authority."
        : "Deploy the exact checked, reviewed, and merged candidate."
    );
  }
  if (!state.candidateVerifiedHealthy) {
    return decision(
      "verify-candidate",
      status,
      "Verify readiness, canonical targets, and the focused production journey before continuing."
    );
  }
  return null;
};

const decideBreakGlassReview = (
  state: EmergencyShippingLedgerEntry
): EmergencyShippingDecision | null => {
  if (state.mode === "break-glass") {
    if (state.independentReview === "pending") {
      return decision(
        "request-independent-review",
        "live-unreviewed",
        "Production is live but the exact deployed candidate still requires independent review."
      );
    }
    if (state.independentReview === "changes-requested") {
      return decision(
        "rollback-or-correct",
        "rollback-required",
        "Review rejected the live candidate; roll back or ship a separately reviewed corrective revision."
      );
    }
  }
  return null;
};

const decideCanonicalDelivery = (
  state: EmergencyShippingLedgerEntry,
  status: EmergencyShippingStatus
): EmergencyShippingDecision => {
  if (!(state.mergeCompleted && state.changelogReconciled)) {
    return decision(
      "reconcile-git-and-release",
      status,
      "Reconcile the reviewed change into canonical Git and complete forward changelog/version work."
    );
  }
  if (!state.canonicalRevision) {
    return decision(
      "reconcile-git-and-release",
      status,
      "Refresh and record the final canonical revision after reconciliation."
    );
  }

  if (!state.finalVerificationPassed) {
    if (state.deployedRevision === state.canonicalRevision) {
      return decision(
        "verify-existing-production",
        "canonicalized",
        "The canonical revision is already live; verify it without another deployment.",
        false,
        "not-required"
      );
    }
    if (artifactsEquivalent(state)) {
      return decision(
        "verify-equivalent-artifact",
        "canonicalized",
        "The canonical revision resolves to the same proven immutable artifact; bind and verify it without rebuilding.",
        false,
        "verify-equivalent-artifact"
      );
    }
    return decision(
      "deploy-canonical",
      "canonicalized",
      "The canonical runtime result differs from the emergency deployment and must replace it.",
      true,
      "deploy-canonical"
    );
  }
  if (!state.cleanupCompleted) {
    return decision(
      "complete-cleanup",
      "canonicalized",
      "Final production is verified; finish the preserved cleanup ledger.",
      false,
      state.redeployDecision
    );
  }
  return decision(
    "complete",
    "complete",
    "Review, canonical reconciliation, final production verification, and cleanup are complete.",
    false,
    state.redeployDecision
  );
};
