export type RequestMode =
  | "preview"
  | "sync"
  | "queue"
  | "sweep"
  | "integrate"
  | "ship"
  | "reconcile"
  | "resume"
  | "pause";

export type EmergencyShippingMode = "standard" | "expedited" | "break-glass";

export type EmergencyShippingEvidence =
  | "urgency-language"
  | "active-user-impact"
  | "tested-ready-for-production"
  | "deploy-before-review";

export interface EmergencyShippingIntent {
  breakGlassAuthorized: boolean;
  evidence: EmergencyShippingEvidence[];
  mode: EmergencyShippingMode;
  recommendedMode: EmergencyShippingMode;
  requiresBreakGlassConfirmation: boolean;
}

export type InitializationMode = RequestMode | "handoff";

export type HandoffTiming = "confirm-ready" | "automatic" | "user-signaled";

export type UiArtifactVersioning =
  | "repository-convention"
  | "number-and-date"
  | "date-only"
  | "number-only";

export type CapabilityStatus =
  | "supported"
  | "unsupported"
  | "configuration"
  | "unavailable"
  | "partial";

export type ChangelogHandling =
  | "delegate-if-available"
  | "preserve-and-report"
  | "ask";

export type ChangelogInstallDecision =
  | "install-now"
  | "install-after-shipment"
  | "install-later"
  | "declined";

// Outcome of the Simple Changelogs install offer. It is a per-run consent
// record, never a saved preference: installation grants no version, release,
// publication, deployment, or data-write authority.
export interface ChangelogInstallOffer {
  command: string | null;
  decision: ChangelogInstallDecision | null;
  distribution: string | null;
  offered: boolean;
}

export type MigrationHandling =
  | "ask-after-review"
  | "auto-apply-reviewed-routine"
  | "auto-apply-reviewed"
  | "never";

export type GitPushAuthorization = "configure-harness" | "ask" | "never";

export interface MigrationTarget {
  environment: string;
  project: string;
  provider: string;
}

export interface ChangelogCoordination {
  capabilityAvailable: boolean;
  capabilityHelpers: string[];
  // `not-applicable`: a provider was discovered, but every discovered
  // installation declares a discovery-only marker (empty request or receipt
  // versions) and implements no release handoff, so delegation cannot run.
  capabilityStatus: "absent" | "not-applicable" | "unverified";
  guidanceUpdate: {
    actions: Array<"walkthrough" | "continue" | "view-release-notes">;
    detailsPath: string | null;
    headline: "**Simple Changelogs has recently been updated.**";
    installedVersion: number | null;
    owner: "simple-changelogs" | null;
    policyPath: string | null;
    provider: string | null;
    status:
      | "absent"
      | "unconfigured"
      | "current"
      | "update-available"
      | "unknown";
    storedVersion: number | null;
    summaryBullets: string[];
    walkthroughQuestion: "Would you like me to walk you through the recent Simple Changelogs updates before I continue?";
  };
  // Distribution of the selected provider (`full`, `web`, `cms`, ...) from
  // its marker or installation name; null when unselected or prose-only.
  providerDistribution: string | null;
  providerEvidence: "marker" | "inferred" | "none";
  providers: string[];
  releaseSurfaces: string[];
  relevant: boolean;
}

export interface RepoPolicy {
  changelogHandling: ChangelogHandling;
  concurrentWork: "allow-claimed" | "strict" | "preserve";
  defaultFinish: "open-change-request" | "integrate" | "ship" | "preview";
  gitPushAuthorization: GitPushAuthorization;
  guidance: {
    disposition: "accepted" | "reviewed" | "deferred";
    version: number;
  };
  handoffTiming: HandoffTiming;
  migrationHandling: MigrationHandling;
  migrationTargets: MigrationTarget[];
  productionDeploy: "ask" | "allow" | "deny";
  proposalScheduling: "balanced" | "consecutive" | "parallel";
  proposalSignatures: "agent-and-version" | "none";
  questions: "blocking-only" | "always" | "never";
  review: "repository-policy" | "independent" | "provider-policy";
  schemaVersion: 1;
  shippingMode: EmergencyShippingMode;
  uiArtifactVersioning: UiArtifactVersioning;
}

export type PolicySource = "default" | "user" | "repository";

export interface GitChange {
  conflicted: boolean;
  indexStatus: string;
  originalPath: string | null;
  path: string;
  symlink: boolean;
  untracked: boolean;
  worktreePath: string;
  worktreeStatus: string;
}

export interface WorktreeInventory {
  bare: boolean;
  branch: string | null;
  changeDigest: string;
  changes: GitChange[];
  detached: boolean;
  headSha: string | null;
  isCurrent: boolean;
  isPrimary: boolean;
  locked: boolean;
  path: string;
  prunable: boolean;
}

export interface BranchInventory {
  ahead: number;
  behind: number;
  current: boolean;
  name: string;
  sha: string;
  upstream: string | null;
  worktreePath: string | null;
}

export interface StashInventory {
  ref: string;
  sha: string;
  subject: string;
}

export interface ProposalInventory {
  baseRevision: string | null;
  headRevision: string;
  objectId: string;
  provider: string;
  state: "open" | "closed" | "merged" | "draft";
  url: string | null;
}

export interface Capability {
  category: "git" | "forge" | "deployment" | "changelog";
  detail: string;
  provider: string;
  status: CapabilityStatus;
}

export interface RemoteBinding {
  fetchUrls: string[];
  name: string;
  provider: string;
  pushUrls: string[];
}

export interface RepositoryInventory {
  baselineDigest: string;
  branches: BranchInventory[];
  capabilities: Capability[];
  generatedAt: string;
  localChanges: GitChange[];
  policy: {
    source: PolicySource;
    path: string | null;
    trust: "not-required" | "trusted" | "untrusted";
    value: RepoPolicy;
  };
  proposals: ProposalInventory[];
  repository: {
    root: string;
    gitDirectory: string;
    commonGitDirectory: string;
    primaryCheckout: string;
    currentCheckout: string;
    headSha: string | null;
    branch: string | null;
    bare: boolean;
    remoteBindings: RemoteBinding[];
    targetRemote: string | null;
  };
  schemaVersion: 1;
  stashes: StashInventory[];
  targetRef: string;
  worktrees: WorktreeInventory[];
}

export type Authority =
  | "local-write"
  | "local-sync"
  | "proposal-write"
  | "merge"
  | "remote-branch-delete"
  | "preview-deploy"
  | "production-deploy"
  | "remote-data-write"
  | "secret-env-write"
  | "dns-write"
  | "store-release"
  | "history-rewrite";

export type PlannedOperation =
  | "fetch-target"
  | "fast-forward-target"
  | "merge-target"
  | "branch"
  | "commit"
  | "push"
  | "open-proposal"
  | "update-proposal"
  | "merge"
  | "deploy-preview"
  | "deploy-production"
  | "promote-deployment"
  | "reconcile-managed-targets"
  | "reconcile-remote-branches"
  | "audit-migration"
  | "apply-migration"
  | "cleanup";

export interface ChangeUnit {
  checks: string[];
  dependencies: string[];
  id: string;
  operations: PlannedOperation[];
  outcome: string;
  paths: string[];
  releaseImpact: "none" | "patch" | "minor" | "major" | "unknown";
  requiredAuthority: Authority[];
  sourceWorktree: string;
  status: "ready" | "blocked" | "paused";
  title: string;
}

export interface PreservedWork {
  classification:
    | "concurrent-arrival"
    | "actively-changing"
    | "paused"
    | "unsafe";
  paths: string[];
  reason: string;
  worktreePath: string;
}

export interface ChangePlan {
  baselineDigest: string;
  exclusions: Array<{ path: string; reason: string; worktreePath?: string }>;
  generatedAt: string;
  mode: RequestMode;
  mutationCount: number;
  mutationsAllowed: boolean;
  preserved: PreservedWork[];
  questions: string[];
  repositoryRoot: string;
  request: string;
  schemaVersion: 1;
  units: ChangeUnit[];
  warnings: string[];
}

export interface ShipmentOutcomePath {
  entry: string | null;
  path: string;
}

export interface ShipmentOutcomeReceipt {
  additionalPaths: Array<
    ShipmentOutcomePath & {
      classification: "external-target-change" | "release-generated";
      reason: string;
    }
  >;
  runId: string;
  schemaVersion: 1;
  targetRevision: string;
  units: Array<{
    disposition: "delivered" | "target-equivalent";
    evidence: string[];
    finalPaths: ShipmentOutcomePath[];
    originalPaths: ShipmentOutcomePath[];
    summary: string;
    unitId: string;
  }>;
}

export interface PermissionRequestInput {
  authority: Authority;
  consequence: string;
  operation: PlannedOperation | "select-release-version";
  reason: string;
  target: string;
}

export interface PermissionRequest extends PermissionRequestInput {
  id: string;
}

export interface PermissionBundle {
  generatedAt: string;
  mode: "ship";
  requests: PermissionRequest[];
  responseInstruction: string;
  schemaVersion: 1;
}

export type ProviderStatus =
  | "succeeded"
  | "failed"
  | "unsupported"
  | "configuration"
  | "unavailable"
  | "partial";

export type DeliveryModel =
  | "git-connected"
  | "atomic-artifact"
  | "container-rollout"
  | "edge-publish"
  | "self-hosted-control-plane";

export interface ProviderReceipt {
  action: string;
  approvalRevision: string | null;
  baseRevision: string | null;
  canonicalTargets: Array<{
    url: string;
    resolvedResultId: string;
    matches: boolean;
  }>;
  deliveryModel: DeliveryModel | null;
  environment: "preview" | "staging" | "production" | null;
  evidence: string[];
  expectedCanonicalTargets?: string[];
  headRevision: string | null;
  immutableResultId: string | null;
  intendedRevision: string | null;
  kind: "forge" | "deployment";
  objectId: string;
  observedAt: string;
  observedRevision: string | null;
  project: string | null;
  provider: string;
  providerReady?: boolean | null;
  schemaVersion: 1;
  smoke: { journey: string; passed: boolean } | null;
  status: ProviderStatus;
  url: string | null;
}

export type ReleaseBoundary =
  | "release-bearing-merge"
  | "web-production"
  | "package-publication"
  | "store-release"
  | "other-public-release"
  | "none";

export type ReleasePhase = "classify" | "prepare" | "verify";

export type ReleaseReasonCode =
  | "version-direction-required"
  | "target-moved"
  | "policy-changed"
  | "release-train-ambiguous"
  | "version-owner-ambiguous"
  | "unsupported-protocol"
  | "unsupported-consumer"
  | "schema-digest-mismatch"
  | "malformed-request"
  | "malformed-policy"
  | "invalid-version-direction"
  | "final-verification-failed";

export type ReleaseRequiredAction =
  | "choose-version"
  | "refresh-and-reclassify"
  | "resolve-release-train"
  | "resolve-version-owner"
  | "upgrade-producer"
  | "upgrade-consumer"
  | "repair-integration"
  | "repair-request"
  | "repair-policy"
  | "review-finalization";

/** Changelog features this consumer understands. */
export type ChangelogFeature =
  | "public-version-policy"
  | "classify-prepare-verify"
  | "multi-train-receipts"
  | "guidance-update-notices"
  | "shared-version-lines";

/**
 * A provider's advertised capabilities. Versions and features are open: a
 * provider may advertise ones this consumer does not know, and negotiation
 * ignores them.
 */
export interface ChangelogCapabilities {
  distribution: string;
  features: string[];
  guidanceVersion: number;
  provider: "simple-changelogs";
  receiptVersions: number[];
  requestVersions: number[];
  schemaDigests?: {
    changelogReceipt: string;
    changelogRequest: string;
  };
  schemaVersion: 1;
}

export interface ChangelogRequest {
  approvedDecisionDigest: string | null;
  approvedVersion: string | null;
  // Informational only: the provider validates these when present but never
  // stores, echoes, or keys retries on them. Transaction identity is the
  // transaction ID, phase, revisions, and prior receipt digest.
  attempt?: number;
  boundary: ReleaseBoundary;
  environment?: string;
  finalizedTargetRevision: string | null;
  inputTargetRevision: string;
  mutationScope: "read-only" | "prepare-release-files";
  phase: ReleasePhase;
  priorReceiptDigest: string | null;
  releaseSetId: string | null;
  /**
   * Request v2: every release train released together from one input target
   * revision under `releaseSetId`, or null. Absent from request v1.
   */
  releaseSetTrains?: string[] | null;
  releaseTrain: string;
  schemaVersion: 1 | 2;
  /** Request v1 advertises receipts 1 and 2; request v2 may add 3. */
  supportedReceiptVersions: Array<1 | 2 | 3>;
  transactionId: string;
}

export interface VersionDecision {
  boundary: ReleaseBoundary;
  bumpLevel: "none" | "patch" | "minor" | "major" | "unknown";
  currentVersion: string | null;
  policyAction: "ask" | "automatic" | "not-applicable";
  releaseTrain: string;
  resolution:
    | "not-required"
    | "automatic"
    | "explicit-direction"
    | "repository-automation"
    | "approval-required"
    | "blocked";
  selectedVersion: string | null;
  source:
    | "current-request"
    | "repository-policy"
    | "run-only"
    | "repository-convention";
  suggestedVersion: string | null;
}

/**
 * Receipt v3: how a release relates to the shared public version line its
 * train belongs to. `members` is the line's trains, sorted; `memberVersions`
 * is each member's latest stable public version at the input target revision
 * (null before its first stable release); `sharedVersion` (H) is their
 * highest, held by `sharedVersionTrains`.
 */
export interface VersionLine {
  members: string[];
  memberVersions: Record<string, string | null>;
  mode: "catch-up" | "bump-shared";
  outcome: "catch-up" | "advance";
  sharedVersion: string | null;
  sharedVersionTrains: string[];
}

export interface VersionDecisionV3 extends VersionDecision {
  versionLine: VersionLine | null;
}

export interface ChangelogReceiptV1 {
  checks: string[];
  evidence: string[];
  observedAt: string;
  paths: Array<{
    digest: string;
    path: string;
  }>;
  provider: string;
  reason: string | null;
  release?: {
    date: string;
    targetContainedUnreleased: "integrated";
    version: string;
  } | null;
  releaseImpact: "none" | "patch" | "minor" | "major" | "unknown";
  schemaVersion: 1;
  sourceRevision: string | null;
  status: "prepared" | "not-applicable" | "blocked";
}

export interface ChangelogReceiptV2 {
  checks: string[];
  decisionDigest: string;
  effectivePolicyDigest: string;
  evidence: string[];
  observedAt: string;
  paths: Array<{
    digest: string;
    path: string;
  }>;
  phase: ReleasePhase;
  provider: "simple-changelogs";
  reason: string | null;
  reasonCode: ReleaseReasonCode | null;
  release: {
    date: string;
    targetContainedUnreleased: "prepared" | "integrated";
    version: string;
  } | null;
  releaseImpact: "none" | "patch" | "minor" | "major" | "unknown";
  releaseSetId: string | null;
  requiredAction: ReleaseRequiredAction | null;
  revisionLineage: {
    finalizedTargetRevision: string | null;
    inputTargetRevision: string;
    reconciliationHeadRevision: string | null;
  };
  schemaVersion: 2;
  sourceRevision: string;
  status:
    | "decision-required"
    | "classified"
    | "prepared"
    | "verified"
    | "not-applicable"
    | "blocked";
  transactionId: string;
  versionDecision: VersionDecision | null;
}

export interface ChangelogReceiptV3
  extends Omit<ChangelogReceiptV2, "schemaVersion" | "versionDecision"> {
  /** Echoes the request's release set; null outside a multi-train set. */
  releaseSetTrains: string[] | null;
  schemaVersion: 3;
  versionDecision: VersionDecisionV3 | null;
}

/** Receipts that carry revision lineage and a decision digest. */
export type ModernChangelogReceipt = ChangelogReceiptV2 | ChangelogReceiptV3;

export type ChangelogReceipt = ChangelogReceiptV1 | ModernChangelogReceipt;

export interface ReleaseDeliveryReceipt {
  decisionDigest: string;
  deployedRevision: string | null;
  deploymentReceiptId: string | null;
  finalizedTargetRevision: string;
  inputTargetRevision: string;
  reasonCode:
    | "deployment-revision-mismatch"
    | "provider-observation-incomplete"
    | null;
  reconciliationHeadRevision: string;
  releaseSetId: string | null;
  releaseTrain: string;
  requiredAction: "inspect-deployment" | "retry-observation" | null;
  schemaVersion: 1;
  status: "complete" | "partial" | "blocked";
  transactionId: string;
  version: string;
}

export interface ReleaseDecisionLedgerEntry {
  approval: {
    productionAuthorized: boolean;
    versionAuthorized: boolean;
  };
  attempt: number;
  boundary: ReleaseBoundary;
  compositeReceipt: ReleaseDeliveryReceipt | null;
  currentVersion: string | null;
  decisionDigest: string;
  deployedRevision: string | null;
  effectivePolicyDigest: string;
  finalizedTargetRevision: string | null;
  inputTargetRevision: string;
  lastCompletedBoundary: string;
  phase: ReleasePhase;
  priorReceiptDigest: string | null;
  reasonCode: ReleaseReasonCode | null;
  receiptSchemaDigest: string;
  receiptVersion: 1 | 2;
  reconciliationHeadRevision: string | null;
  releaseSetId: string | null;
  releaseTrain: string;
  requestSchemaDigest: string;
  requestVersion: 1;
  requiredAction: ReleaseRequiredAction | null;
  selectedVersion: string | null;
  status: ChangelogReceiptV2["status"];
  suggestedVersion: string | null;
  transactionId: string;
}

export type EmergencyShippingStatus =
  | "ready"
  | "live-unreconciled"
  | "live-unreviewed"
  | "reviewed"
  | "canonicalized"
  | "rollback-required"
  | "complete"
  | "blocked";

export interface EmergencyShippingLedgerEntry {
  artifactEquivalenceProven: boolean;
  authoritySource:
    | "advanced-policy"
    | "explicit-current-request"
    | "confirmed-run-only"
    | null;
  breakGlassAuthorized: boolean;
  candidateArtifactId: string | null;
  candidateRevision: string;
  candidateVerifiedHealthy: boolean;
  canonicalArtifactId: string | null;
  canonicalRevision: string | null;
  changelogReconciled: boolean;
  cleanupCompleted: boolean;
  deployedArtifactId: string | null;
  deployedRevision: string | null;
  evidence: EmergencyShippingEvidence[];
  finalVerificationPassed: boolean;
  focusedChecksPassed: boolean;
  independentReview: "pending" | "approved" | "changes-requested";
  mergeCompleted: boolean;
  mode: Exclude<EmergencyShippingMode, "standard">;
  previousProductionRevision: string | null;
  productionAuthorized: boolean;
  redeployDecision:
    | "pending"
    | "not-required"
    | "verify-equivalent-artifact"
    | "deploy-canonical";
  rollbackAnchorRecorded: boolean;
  rollbackSupported: boolean;
  status: EmergencyShippingStatus;
}

export interface SnapshotComparison {
  activelyChangingWorktrees: WorktreeInventory[];
  concurrentWorktrees: WorktreeInventory[];
  stableWorktrees: WorktreeInventory[];
}

export type LoopWorktreeRole =
  | "controller"
  | "author"
  | "concurrent-author"
  | "preserved"
  | "retained";

export interface LoopWorktreeRetention {
  approvedBy: string;
  createdAt: string;
  reason: string;
}

export interface LoopWorktreeLease {
  agentId: string | null;
  baselineChangeDigest: string;
  baselineHeadSha: string | null;
  branch: string | null;
  claimId?: string;
  coordinationState?: "adopted-preserved" | "resume-ready";
  createdByRun: boolean;
  mutationAllowed: boolean;
  path: string;
  pauseReceiptId?: string;
  retention?: LoopWorktreeRetention;
  role: LoopWorktreeRole;
}

export interface LoopOpeningWorktree {
  branch: string | null;
  changeDigest: string;
  headSha: string | null;
  path: string;
}

export interface LoopControllerHandoff {
  approvedBy: string | null;
  at: string;
  fromAgentId: string;
  kind: "resume" | "takeover";
  reason: string;
  toAgentId: string;
}

/** The harness session that started or adopted a controller. */
export interface LoopControllerSession {
  harness: "claude-code" | "codex";
  hostname: string;
  /** The session's own process when the harness reports it, else null. */
  hostPid: number | null;
  sessionId: string;
}

/** Decisions a paused controller needs from the user before it can continue. */
export interface LoopAwaitingUser {
  questions: string[];
  recordedAt: string;
}

/**
 * Advisory controller facts kept beside the lease rather than in it, so older
 * runtimes that validate the lease strictly can still read it: the harness
 * session that controls the run, and the questions a paused controller left.
 * It counts only while its run and owner match the lease.
 */
export interface LoopControllerBinding {
  awaitingUser: LoopAwaitingUser | null;
  /** The controller tenure this binding belongs to. */
  controllerAcquiredAt: string;
  /** Questions the previous controller paused on, kept for its successor. */
  inheritedAwaitingUser: string[] | null;
  ownerAgentId: string;
  runId: string;
  schemaVersion: 1;
  session: LoopControllerSession | null;
  updatedAt: string;
}

export interface LoopRebaselineRegistration {
  changeDigest: string;
  headSha: string | null;
  path: string;
}

/**
 * Records that a preserved registration's checkout is gone from disk and from
 * Git's worktree list, with named approval. It accounts for the absence only;
 * it proves neither delivery nor cleanup and never authorizes deletion.
 */
export interface LoopWorktreeRetirement {
  absenceCheckedAt: string;
  actorAgentId: string;
  approvedBy: string;
  baselineChangeDigest: string;
  baselineHeadSha: string | null;
  branch: string | null;
  createdAt: string;
  path: string;
  reason: string;
  registration: "opening" | "rebaseline" | "adopted";
  targetRef: string;
  targetRevision: string;
}

export interface LoopRebaselineRecord {
  approvedBy: string;
  reason: string;
  recordedAt: string;
  registered: LoopRebaselineRegistration[];
}

export interface LoopControllerLifecycle {
  acquiredAt: string;
  handoffs: LoopControllerHandoff[];
  reason: string | null;
  relinquishedAt: string | null;
  status: "active" | "relinquished";
}

export type WorktreeCoordinationState =
  | "active"
  | "pause-requested"
  | "paused"
  | "detach-requested"
  | "adopted-preserved"
  | "detached"
  | "attached"
  | "resume-ready"
  | "blocked"
  | "released"
  | "stale";

export type WorktreeClaimReleaseReason =
  | "owner-release"
  | "handoff"
  | "shipped"
  | "worktree-absent"
  | "takeover"
  | "post-cleanup-recovery";

export interface WorktreeClaimOwner {
  adapter: string;
  agentId: string;
  ownerRef: string | null;
}

export interface WorktreeResumeTarget {
  createdAt: string;
  runId: string;
  targetRef: string;
  targetSha: string;
}

export interface WorktreeClaim {
  branch: string | null;
  changeDigest: string;
  claimId: string;
  commonGitDirectory: string;
  createdAt: string;
  headSha: string | null;
  owner: WorktreeClaimOwner;
  path: string;
  releaseReason?: WorktreeClaimReleaseReason;
  repositoryId: string;
  resumeTarget?: WorktreeResumeTarget;
  schemaVersion: 1;
  state: WorktreeCoordinationState;
  updatedAt: string;
}

export interface WorktreePauseReceipt {
  acknowledgedAt: string;
  branch: string | null;
  changeDigest: string;
  claimId: string;
  disposition: "preserve-in-place" | "detach-clean-checkout";
  headSha: string | null;
  ownerAgentId: string;
  path: string;
  reason: string;
  receiptId: string;
  requestingRunId: string;
  schemaVersion: 1;
}

export interface WorktreeCoordinationEvent {
  actorAgentId: string;
  claimId: string;
  createdAt: string;
  eventId: string;
  state: WorktreeCoordinationState;
}

export interface WorktreeCoordinationDocument {
  claims: WorktreeClaim[];
  events: WorktreeCoordinationEvent[];
  receipts: WorktreePauseReceipt[];
  repositoryId: string;
  schemaVersion: 1;
}

export interface ReadyWorkCheck {
  command: string;
  note: string | null;
  result: "passed" | "failed" | "skipped";
}

export type ReadyWorkReleaseImpact =
  | "none"
  | "patch"
  | "minor"
  | "major"
  | "unknown";

export interface ReadyWorkReceipt {
  branch: string;
  changeDigest: string;
  checks: ReadyWorkCheck[];
  claimId: string;
  deploymentConstraints: string[];
  headSha: string;
  migrations: string[];
  owner: WorktreeClaimOwner;
  path: string;
  receiptId: string;
  recordedAt: string;
  releaseImpact: ReadyWorkReleaseImpact;
  schemaVersion: 1;
  scope: string;
  unresolvedAuthority: string[];
}

export type ShipHoldScope = "ship" | "deploy" | "migrations";
export type ShipHoldSeverity = "delay" | "halt";
export type ShipHoldAction = "merge" | "deploy" | "migrations";
export type ShipHoldReleaseReason =
  | "owner-release"
  | "merged"
  | "approved-release";

/** The immutable part of a hold: what is published and what a waiver binds. */
export interface ShipHoldIdentity {
  createdAt: string;
  holdId: string;
  owner: WorktreeClaimOwner;
  reason: string;
  schemaVersion: 1;
  scope: ShipHoldScope;
  severity: ShipHoldSeverity;
  untilMerged: string | null;
}

export interface ShipHoldRelease {
  approvedBy: string | null;
  note: string | null;
  reason: ShipHoldReleaseReason;
  releasedAt: string;
  releasedBy: string;
}

export interface ShipHoldPublication {
  commitSha: string;
  /** Null while the push is recorded as intent but not yet confirmed. */
  publishedAt: string | null;
  ref: string;
  remote: string;
  withdrawnAt: string | null;
}

export interface ShipHold extends ShipHoldIdentity {
  publication: ShipHoldPublication | null;
  release: ShipHoldRelease | null;
  source: "local" | "remote";
  state: "active" | "released";
  updatedAt: string;
}

export interface ShipHoldWaiver {
  approvedBy: string;
  holdDigest: string;
  holdId: string;
  overrideHalt: boolean;
  reason: string;
  runId: string;
  waivedAt: string;
  waivedBy: string;
}

export interface ShipHoldDocument {
  holds: ShipHold[];
  repositoryId: string;
  schemaVersion: 1;
  waivers: ShipHoldWaiver[];
}

export type CoordinationDiscoveryCapability =
  | "exact-ref"
  | "enumerate-local"
  | "enumerate-account"
  | "none";
export type CoordinationDeliveryCapability =
  | "live-bidirectional"
  | "follow-up"
  | "interactive-manual"
  | "none";
export type CoordinationWaitCapability = "event" | "poll" | "none";
export type CoordinationScope =
  | "same-process"
  | "same-host"
  | "account-remote"
  | "manual";

export interface CoordinationAdapterCapabilities {
  adapter: string;
  conditions: string[];
  delivery: CoordinationDeliveryCapability;
  discovery: CoordinationDiscoveryCapability;
  scope: CoordinationScope;
  wait: CoordinationWaitCapability;
  worktreeIdentity: "native" | "claim-only";
}

export interface CoordinationRequest {
  action: "request-pause" | "request-detach" | "notify-resume";
  claimId: string;
  owner: WorktreeClaimOwner;
  repository: {
    commonGitDirectory: string;
    worktreePath: string;
  };
  runId: string;
  safeMessage: string;
}

export interface CoordinationBlocker {
  adapter: string;
  capability: "discovery" | "delivery" | "wait" | "scope" | "owner-ref";
  code: "manual-coordination-required" | "unsupported-capability";
  manualNextAction: string;
  scope: CoordinationScope;
}

export interface LoopOverride {
  approvedBy: string;
  changeDigest: string;
  createdAt: string;
  headSha: string | null;
  path: string;
  reason: string;
}

export interface LoopWorktreeDisposition {
  approvedBy: string;
  branch: string | null;
  changeDigest: string;
  completedAt?: string;
  containmentMethod?: "target-contained" | "patch-equivalent";
  createdAt: string;
  headSha: string;
  outcome: "remove-after-audit";
  path: string;
  reason: string;
  status?: "intended" | "completed";
  targetRef: string;
  targetRevision: string;
  uniqueCommitCount: 0;
}

export interface PostCleanupRecoveryReceipt {
  approvedBy: string;
  authority: "close-only";
  firstClaimObservation: WorktreeClaimObservation;
  firstFinalInventory: RemoteBranchReconciliationReceipt;
  openingEvidenceUnavailableReason: string;
  project: string;
  provider: "gitlab";
  reason: string;
  schemaVersion: 1;
  secondClaimObservation: WorktreeClaimObservation;
  secondFinalInventory: RemoteBranchReconciliationReceipt;
  targetBranch: string;
  targetRevision: string;
}

export interface WorktreeClaimObservation {
  activeClaimCount: number;
  digest: string;
  observedAt: string;
}

export interface LoopWorktreePreparation {
  agentId: string;
  baseRevision: string;
  branch: string;
  createdAt: string;
  path: string;
  purpose: string;
}

export interface RemoteBranchProposalEvidence {
  headRevision: string | null;
  objectId: string;
  observedFinally?: boolean;
  observedInitially?: boolean;
  state: "open" | "merged" | "closed";
}

/**
 * Merged-head ancestry proof for a deleted-merged branch: the same proposal
 * was open at the initial head and merged at a head equal to or descending
 * from it. Persisted in a sidecar beside the lease (never inside the lease) so
 * older clients can still read the lease; the recorder verifies ancestry and
 * target containment with git.
 */
export interface RemoteBranchAncestryProof {
  branch: string;
  initialHeadRevision: string;
  mergedHeadRevision: string;
  proposalObjectId: string;
}

export interface RemoteBranchAncestryRecord {
  proofs: RemoteBranchAncestryProof[];
  receiptDigest: string;
  runId: string;
  schemaVersion: 1;
}

/**
 * User-approved supersession for a deleted closed-unmerged or no-proposal
 * branch whose head the target does not contain: the named user judged its
 * work replaced by the named target commits. Persisted in a sidecar beside the
 * lease (never inside the lease) so older clients can still read the lease;
 * the recorder verifies with git that the deleted head is still present
 * locally and that every replacement is in the target after the branch forked.
 */
export interface RemoteBranchSupersession {
  approvedBy: string;
  branch: string;
  initialHeadRevision: string;
  reason: string;
  replacementRevisions: string[];
}

export interface RemoteBranchSupersessionRecord {
  receiptDigest: string;
  runId: string;
  schemaVersion: 1;
  supersessions: RemoteBranchSupersession[];
}

export interface RemoteBranchReconciliationEntry {
  classification:
    | "canonical-target"
    | "protected"
    | "open-proposal"
    | "merged-obsolete"
    | "closed-unmerged"
    | "no-proposal"
    | "ambiguous";
  disposition:
    | "preserved-target"
    | "preserved-protected"
    | "preserved-open-proposal"
    | "preserved-audited"
    | "preserved-ambiguous"
    | "deleted-merged"
    | "deleted-proven-obsolete";
  evidence: string[];
  finalHeadRevision: string | null;
  initialHeadRevision: string | null;
  name: string;
  obsoleteProof:
    | "merged-proposal-head"
    | "target-contains-head"
    | "provider-diff-empty"
    | null;
  proposals: RemoteBranchProposalEvidence[];
  protected: boolean;
}

export interface RemoteBranchReconciliationReceipt {
  branches: RemoteBranchReconciliationEntry[];
  finalBranchCount: number;
  finalCoverage: RemoteInventoryCoverage;
  finalInventoryComplete: true;
  initialBranchCount: number;
  initialCoverage: RemoteInventoryCoverage;
  initialInventoryComplete: true;
  observedAt: string;
  project: string;
  provider: string;
  schemaVersion: 1;
  targetBranch: string;
  targetRevision: string;
}

export interface RemoteInventoryCoverage {
  branches: RemotePaginationProof;
  proposalStates: readonly ["closed", "merged", "open"];
  proposals: RemotePaginationProof;
}

export interface RemotePaginationProof {
  ledgerDigest: string;
  pages: Array<{
    cursorIn: string | null;
    cursorOut: string | null;
    itemCount: number;
    responseDigest: string;
  }>;
}

export interface LoopCloseEquivalentWorktreeProof {
  headSha: string;
  method: "equivalence-receipt" | "target-ancestry";
  path: string;
  receiptDigest?: string;
}

export interface LoopCloseEquivalentOutcome {
  approvedBy: string;
  outcome: "target-equivalent";
  reason: string;
  recordedAt: string;
  remoteReconciliationSkipped: string;
  targetRevision: string;
  worktrees: LoopCloseEquivalentWorktreeProof[];
}

export interface LoopOwnerProcess {
  hostname: string;
  pid: number;
  recordedAt: string;
}

export interface LoopLease {
  baselineDigest: string;
  closeEquivalentOutcome?: LoopCloseEquivalentOutcome;
  commonGitDirectory: string;
  concurrentWork?: "allow-claimed" | "strict";
  controller?: LoopControllerLifecycle;
  createdAt: string;
  dispositions?: LoopWorktreeDisposition[];
  emergencyShipping?: EmergencyShippingLedgerEntry;
  /**
   * When the run first changed shared state or recorded run evidence. A lease
   * started by this version holds `null` until then; a lease without the field
   * predates it and cannot prove that it never mutated.
   */
  firstMutationAt?: string | null;
  mode: Exclude<RequestMode, "pause" | "preview" | "sync">;
  openingBranches?: Array<{ name: string; sha: string }>;
  /**
   * Digest of the repository facts a first shipment scope depends on besides
   * worktree bytes: policy, discovered capabilities, remote bindings, and the
   * target binding, as captured at `loop start`. A lease without it predates
   * scoped record-scope checks and still needs the exact opening inventory.
   */
  openingInvariantDigest?: string;
  openingRemoteInventory?: RemoteBranchReconciliationReceipt;
  /**
   * Every worktree exactly as `loop start` saw it. Unlike `worktrees`, whose
   * baselines move when a claim is admitted, a paused change is accepted, or a
   * late worktree is re-baselined, this record never changes, so a first scope
   * can prove that its source bytes are the ones present at loop start.
   */
  openingWorktrees?: LoopOpeningWorktree[];
  overrides: LoopOverride[];
  ownerAgentId: string;
  ownerProcess?: LoopOwnerProcess;
  preparations: LoopWorktreePreparation[];
  primaryCheckout: string;
  rebaselines?: LoopRebaselineRecord[];
  remoteBindings?: RemoteBinding[];
  remoteBranchReconciliation?: RemoteBranchReconciliationReceipt;
  retirements?: LoopWorktreeRetirement[];
  runId: string;
  schemaVersion: 1;
  shipmentOutcome?: {
    receipt: ShipmentOutcomeReceipt;
    receiptDigest: string;
    recordedAt: string;
  };
  shipmentScope?: {
    /**
     * The whole-repository inventory digest when this scope's opening changes
     * were recorded. Absent on scopes recorded before record-scope tolerated
     * unrelated changes; those were recorded at `baselineDigest` exactly.
     */
    openingInventoryDigest?: string;
    openingChanges: Array<{
      originalPath: string | null;
      path: string;
      sourceEntry: string | null;
      worktreePath: string;
    }>;
    plan: ChangePlan;
    planDigest: string;
    recordedAt: string;
  };
  shipmentScopeFrozenAt?: string | null;
  shipmentScopeHistory?: Array<{
    planDigest: string;
    recordedAt: string;
    supersededAt: string;
  }>;
  shipmentScopeRequired?: boolean;
  targetRef: string;
  targetRevision: string;
  updatedAt: string;
  worktrees: LoopWorktreeLease[];
}

export interface LoopViolation {
  changeDigest: string | null;
  code:
    | "common-git-directory-mismatch"
    | "missing-preserved-worktree"
    | "missing-retained-worktree"
    | "incomplete-worktree-preparation"
    | "preserved-worktree-changed"
    | "retained-worktree-authorization-missing"
    | "retained-worktree-changed"
    | "coordination-claim-stale"
    | "registered-worktree-branch-changed"
    | "remote-destination-changed"
    | "remote-destination-rebind-required"
    | "unregistered-worktree";
  headSha: string | null;
  message: string;
  path: string;
}

export interface LoopVerification {
  active: boolean;
  checkedAt: string;
  currentBaselineDigest: string | null;
  ok: boolean;
  runId: string | null;
  violations: LoopViolation[];
}

export type { SchemaName } from "./schema.ts";
