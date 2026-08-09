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

export interface ChangelogCoordination {
  capabilityAvailable: boolean;
  providers: string[];
  releaseSurfaces: string[];
  relevant: boolean;
}

export interface RepoPolicy {
  changelogHandling: ChangelogHandling;
  concurrentWork: "allow-claimed" | "strict" | "preserve";
  defaultFinish: "open-change-request" | "integrate" | "ship" | "preview";
  guidance: {
    version: 1;
  };
  handoffTiming: HandoffTiming;
  productionDeploy: "ask" | "allow" | "deny";
  questions: "blocking-only" | "always" | "never";
  review: "repository-policy" | "independent" | "provider-policy";
  schemaVersion: 1;
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

export interface RepositoryInventory {
  baselineDigest: string;
  branches: BranchInventory[];
  capabilities: Capability[];
  generatedAt: string;
  localChanges: GitChange[];
  policy: {
    source: PolicySource;
    path: string | null;
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

export interface ChangelogReceipt {
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

export interface SnapshotComparison {
  activelyChangingWorktrees: WorktreeInventory[];
  concurrentWorktrees: WorktreeInventory[];
  stableWorktrees: WorktreeInventory[];
}

export type LoopWorktreeRole =
  | "controller"
  | "author"
  | "concurrent-author"
  | "preserved";

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
  role: LoopWorktreeRole;
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
  finalInventoryComplete: true;
  initialBranchCount: number;
  initialInventoryComplete: true;
  observedAt: string;
  project: string;
  provider: string;
  schemaVersion: 1;
  targetBranch: string;
  targetRevision: string;
}

export interface LoopLease {
  baselineDigest: string;
  commonGitDirectory: string;
  concurrentWork?: "allow-claimed" | "strict";
  createdAt: string;
  dispositions?: LoopWorktreeDisposition[];
  mode: Exclude<RequestMode, "pause" | "preview" | "sync">;
  overrides: LoopOverride[];
  ownerAgentId: string;
  preparations: LoopWorktreePreparation[];
  primaryCheckout: string;
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
    | "incomplete-worktree-preparation"
    | "preserved-worktree-changed"
    | "coordination-claim-stale"
    | "registered-worktree-branch-changed"
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
  | "changelog-receipt"
  | "initialization"
  | "inventory"
  | "change-plan"
  | "run-state"
  | "provider-receipt"
  | "remote-branch-reconciliation"
  | "release-consistency"
  | "release-notes"
  | "loop-lease"
  | "worktree-coordination";
