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
  capabilityStatus: "absent" | "unverified";
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
  exclusions: Array<{ path: string; reason: string }>;
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

export interface ChangelogCapabilities {
  distribution: string;
  features: Array<
    | "public-version-policy"
    | "classify-prepare-verify"
    | "multi-train-receipts"
    | "guidance-update-notices"
  >;
  guidanceVersion: number;
  provider: "simple-changelogs";
  receiptVersions: Array<1 | 2>;
  requestVersions: 1[];
  schemaDigests: {
    changelogReceipt: string;
    changelogRequest: string;
  };
  schemaVersion: 1;
}

export interface ChangelogRequest {
  approvedDecisionDigest: string | null;
  approvedVersion: string | null;
  attempt: number;
  boundary: ReleaseBoundary;
  environment: string;
  finalizedTargetRevision: string | null;
  inputTargetRevision: string;
  mutationScope: "read-only" | "prepare-release-files";
  phase: ReleasePhase;
  priorReceiptDigest: string | null;
  releaseSetId: string | null;
  releaseTrain: string;
  schemaVersion: 1;
  supportedReceiptVersions: Array<1 | 2>;
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
    | "prepared"
    | "verified"
    | "not-applicable"
    | "blocked";
  transactionId: string;
  versionDecision: VersionDecision | null;
}

export type ChangelogReceipt = ChangelogReceiptV1 | ChangelogReceiptV2;

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

export interface LoopControllerHandoff {
  approvedBy: string | null;
  at: string;
  fromAgentId: string;
  kind: "resume" | "takeover";
  reason: string;
  toAgentId: string;
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
  | "adopted-preserved"
  | "detach-requested"
  | "detached"
  | "attached"
  | "resume-ready"
  | "released"
  | "stale"
  | "blocked";

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
  createdAt: string;
  headSha: string;
  outcome: "remove-after-audit";
  path: string;
  reason: string;
  targetRef: string;
  targetRevision: string;
  uniqueCommitCount: 0;
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
  state: "open" | "merged" | "closed";
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
  pages: Array<{
    cursorIn: string | null;
    cursorOut: string | null;
    itemCount: number;
    responseDigest: string;
  }>;
}

export interface LoopLease {
  baselineDigest: string;
  commonGitDirectory: string;
  concurrentWork?: "allow-claimed" | "strict";
  controller?: LoopControllerLifecycle;
  createdAt: string;
  dispositions?: LoopWorktreeDisposition[];
  emergencyShipping?: EmergencyShippingLedgerEntry;
  mode: Exclude<RequestMode, "pause" | "preview" | "sync">;
  overrides: LoopOverride[];
  ownerAgentId: string;
  preparations: LoopWorktreePreparation[];
  primaryCheckout: string;
  remoteBindings: RemoteBinding[];
  remoteBranchReconciliation?: RemoteBranchReconciliationReceipt;
  runId: string;
  schemaVersion: 1;
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

export type SchemaName =
  | "repo-policy"
  | "changelog-capabilities"
  | "changelog-request"
  | "changelog-receipt"
  | "initialization"
  | "inventory"
  | "change-plan"
  | "emergency-shipping"
  | "migration-review"
  | "migration-pending"
  | "migration-apply-plan"
  | "run-state"
  | "provider-receipt"
  | "release-delivery-receipt"
  | "remote-branch-reconciliation"
  | "release-consistency"
  | "release-notes"
  | "loop-lease"
  | "worktree-coordination";
