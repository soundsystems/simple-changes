#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { sleep, stdin } from "bun";
import {
  type AuthoringSidecar,
  authoringPaths,
  changelogsHarnessPrefill,
  detectHarnesses,
  loadHarnessDefinitions,
  parseAuthoringAnswer,
  parseAuthoringRequest,
  type RepositoryAuthoring,
  recordAuthoringAnswer,
  resolveRepositoryAuthoring,
  writeAuthoringSidecar,
} from "./lib/authoring.ts";
import {
  type AuthoringOnboardingContext,
  authoringReviewNoticeQuestion,
} from "./lib/authoring-onboarding.ts";
import { auditBranchReplacements } from "./lib/branch-audit.ts";
import { inspectChangelogCoordination } from "./lib/changelog-coordination.ts";
import {
  buildCoordinationRequest,
  type CoordinationCapabilityProbe,
  probeCoordinationAdapter,
} from "./lib/coordination-adapter.ts";
import { EXIT_CODES, SimpleChangesError } from "./lib/errors.ts";
import { createFork } from "./lib/fork.ts";
import {
  acknowledgedGuidance,
  CURRENT_GUIDANCE_VERSION,
  type GuidanceUpdateAction,
  type GuidanceUpdateContext,
} from "./lib/guidance-updates.ts";
import { currentHarnessSession } from "./lib/harness-session.ts";
import {
  type InitializationStatus,
  inspectInitialization,
} from "./lib/initialization.ts";
import {
  captureInventory,
  compareSnapshots,
  locateRepository,
} from "./lib/inventory.ts";
import {
  acceptPausedWorktreeChange,
  adoptPausedWorktree,
  authorizeWorktreeRemoval,
  closeLoopTargetEquivalent,
  emergencyShippingStatus,
  endLoop,
  executeLoopMutation,
  finalizeLoop,
  grantLoopOverride,
  guardLoopMutation,
  type LoopEquivalenceEvidence,
  loopManifestDigest,
  loopReplanStatus,
  loopStatus,
  markWorktreeResumeReady,
  prepareAgentWorktree,
  readControllerBinding,
  readLoopLease,
  rebaselineLoopWorktrees,
  recordEmergencyShipping,
  recordRemoteBranchReconciliation,
  recordShipmentOutcome,
  recordShipmentScope,
  recoverLoopLock,
  recoverPostCleanupLoop,
  recoverStaleLoopLease,
  replanLoop,
  retainExcludedWorktree,
  retireAbsentWorktree,
  staleClaimRecoveryCommands,
  startLoop,
  takeoverLoop,
  turnEndReminder,
  verifyLoop,
  withLoopMutationLease,
  withLoopStateLock,
} from "./lib/loop-lease.ts";
import { auditMarkdown } from "./lib/markdown.ts";
import {
  applyMigrationAuthorization,
  decideMigrationAutomation,
  type MigrationApplyPlan,
  type MigrationAutomationDecision,
  type MigrationOperationSet,
  type MigrationReview,
  migrationAuthorizationConsumed,
} from "./lib/migration-automation.ts";
import {
  changelogInstallOfferApplies,
  collectOnboardingSelection,
  type OnboardingChoice,
  type OnboardingInputs,
  type OnboardingPrompter,
  parseMigrationTargets,
  pendingChangelogInstallOffer,
  type SetupScope,
} from "./lib/onboarding.ts";
import { assertSafeRelativePath } from "./lib/path-safety.ts";
import {
  buildPermissionBundle,
  renderPermissionBundle,
} from "./lib/permission-bundle.ts";
import { buildPreviewPlan } from "./lib/planner.ts";
import {
  loadPersonalPolicy,
  resolvePersonalPolicyPath,
  withSavedExecGuard,
  writeGuidanceAcknowledgement,
  writePolicyFile,
  writeRepositoryPolicyTrustReceipt,
} from "./lib/policy.ts";
import { runGit } from "./lib/process.ts";
import { auditProposalBody, type ProposalAudit } from "./lib/proposal-audit.ts";
import {
  buildProposalSignatureBlock,
  type ProposalSignatureRole,
} from "./lib/proposal-signatures.ts";
import {
  parseReadyWorkInput,
  type ReadyWorkStatus,
  readyWorkStatus,
  recordReadyWork,
} from "./lib/ready-work.ts";
import { redactSecrets } from "./lib/redact.ts";
import {
  checkReleaseConsistency,
  type ReleaseConsistencyReport,
  renderReleaseConsistency,
} from "./lib/release-consistency.ts";
import { buildReleaseDeliveryReceipt } from "./lib/release-delivery.ts";
import {
  decideReleaseGate,
  inspectChangelogTransaction,
  negotiateChangelogProtocol,
  validateChangelogReleaseSet,
} from "./lib/release-gate.ts";
import type { ReleaseNotesPointer } from "./lib/release-history.ts";
import {
  releaseNotesPointer,
  renderReleaseNotesPointer,
} from "./lib/release-history.ts";
import type { ReleaseNotes } from "./lib/release-notes.ts";
import { extractReleaseNotes } from "./lib/release-notes.ts";
import { runReleaseTag } from "./lib/release-tag.ts";
import { renderInventory, renderPlan } from "./lib/report.ts";
import {
  discoverInstructionTargets,
  writeInstructionPointer,
} from "./lib/repository-instructions.ts";
import {
  type AuthorAttestResult,
  attestCommits,
  type CommitGaps,
  type RecordAuthorsResult,
  type RecordReviewResult,
  type ReviewLedgerResumeState,
  recordProposalAuthors,
  recordReviewAttempt,
  resolveReviewer,
  type WaiveCoverageResult,
  waiveProposalCoverage,
} from "./lib/review-ledger.ts";
import {
  type RuntimeFreshness,
  runtimeFreshness,
} from "./lib/runtime-freshness.ts";
import { SCHEMA_NAMES, validateSchema } from "./lib/schema.ts";
import {
  addShipHold,
  assertShipHoldsClear,
  checkShipHolds,
  publishShipHold,
  type RecordedShipHolds,
  recordedShipHolds,
  releaseShipHold,
  SHIP_HOLD_ACTIONS,
  SHIP_HOLD_SCOPES,
  SHIP_HOLD_SEVERITIES,
  type ShipHoldReadOptions,
  type ShipHoldReport,
  waiveShipHold,
} from "./lib/ship-holds.ts";
import { checkSkill, type SkillCheckReport } from "./lib/skill-check.ts";
import { isForkRuntime, skillRootOf } from "./lib/skill-roots.ts";
import {
  hookInstallScript,
  parseTurnCheckHookInput,
  type StopHookStatus,
  stopHookStatus,
  type TurnGuardHarness,
  turnCheck,
  turnCheckHookOutput,
} from "./lib/turn-guard.ts";
import type {
  ChangelogCoordination,
  ChangelogInstallDecision,
  ChangelogReceipt,
  ChangelogRequest,
  InitializationMode,
  LoopLease,
  ReleaseTagReceipt,
  RepoPolicy,
  RequestMode,
  SchemaName,
  ShipHoldAction,
  ShipHoldScope,
  ShipHoldSeverity,
} from "./lib/types.ts";
import {
  attachClaimedWorktree,
  claimWorktree,
  detachClaimedWorktree,
  observeWorktreeClaims,
  pauseClaimedWorktree,
  readCoordinationDocumentFromCommonDirectory,
  readWorktreeCoordination,
  releaseHandoffWorktreeClaim,
  releaseWorktreeClaim,
  takeoverWorktreeClaim,
} from "./lib/worktree-coordination.ts";
import { auditWorktreeEquivalence } from "./lib/worktree-equivalence.ts";
import {
  type PruneReport,
  pruneRepository,
  refreshWorktreeIndex,
  standaloneWorktreeCleanup,
} from "./lib/worktree-maintenance.ts";

const VERSION = "0.27.1";
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const PLAIN_SHELL_WORD_PATTERN = /^[\w./-]+$/u;
const PACKAGE_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const SCHEMA_KIND_LINE_LIMIT = 78;
const schemaKindLines = SCHEMA_NAMES.reduce<string[]>((lines, name) => {
  const current = lines.at(-1);
  if (current && `${current}, ${name}`.length <= SCHEMA_KIND_LINE_LIMIT) {
    lines[lines.length - 1] = `${current}, ${name}`;
    return lines;
  }
  lines.push(`  ${name}`);
  return lines;
}, []).join(",\n");
const HELP = `Simple Changes ${VERSION}

Usage:
  simple-changes fork create --name NAME --deltas TEXT
    [--destination PATH] [--upstream PATH] [--json] [--repo PATH]
  simple-changes initialize --mode MODE
    [--ready]
    [--changelog-required]
    [--changelog delegate-if-available|preserve-and-report|ask]
    [--changelog-install now|after-shipment|later|decline]
    [--concurrent-work allow-claimed|strict]
    [--proposal-scheduling balanced|consecutive|parallel]
    [--proposal-signatures agent-and-version|none]
    [--handoff ask|automatic|user-signaled]
    [--instruction-pointer add|leave] [--instruction-file PATH]
    [--ui-artifacts]
    [--ui-versioning repository|number-and-date|date-only|number-only]
    [--production ask|allow|deny]
    [--shipping-mode standard|expedited|break-glass]
    [--git-push-authorization configure-harness|ask|never]
    [--migration-handling ask-after-review|auto-apply-reviewed-routine|auto-apply-reviewed|never]
    [--migration-target provider:project:environment]
    [--questions blocking-only|always|never]
    [--scope user|repository|run] [--acknowledge-push-scope]
    [--proposal ID --head SHA] [--authoring-request JSON|@FILE]
    [--agent-id ID] [--yes] [--json] [--repo PATH]
  simple-changes setup [--finish review|integrate|ship]
    [--changelog delegate-if-available|preserve-and-report|ask]
    [--changelog-install now|after-shipment|later|decline]
    [--concurrent-work allow-claimed|strict]
    [--proposal-scheduling balanced|consecutive|parallel]
    [--proposal-signatures agent-and-version|none]
    [--handoff ask|automatic|user-signaled]
    [--instruction-pointer add|leave] [--instruction-file PATH]
    [--ui-artifacts]
    [--ui-versioning repository|number-and-date|date-only|number-only]
    [--production ask|allow|deny]
    [--shipping-mode standard|expedited|break-glass]
    [--git-push-authorization configure-harness|ask|never]
    [--migration-handling ask-after-review|auto-apply-reviewed-routine|auto-apply-reviewed|never]
    [--migration-target provider:project:environment]
    [--questions blocking-only|always|never]
    [--scope user|repository|run] [--acknowledge-push-scope]
    [--agent-id ID] [--yes] [--json] [--repo PATH]
  simple-changes setup --authoring JSON|@FILE --scope repository|personal
    --confirm [--agent-id ID] [--json] [--repo PATH]
  simple-changes acknowledge-update --guidance-decision accepted|reviewed|deferred
    [--agent-id ID] [--json] [--repo PATH]
  simple-changes migration decision --state REVIEW_FILE --pending PENDING_FILE --apply-plan APPLY_PLAN_FILE [--json] [--repo PATH]
  simple-changes migration apply --state REVIEW_FILE --pending PENDING_FILE --apply-plan APPLY_PLAN_FILE [--json] [--repo PATH]
  simple-changes permissions bundle REQUESTS_FILE [--json]
  simple-changes inventory [--json] [--repo PATH]
  simple-changes preview [--json] [--repo PATH] [--settle-ms N]
  simple-changes loop start --mode MODE --agent-id ID [--changelog-required]
    [--opening-remote-inventory FILE] [--authoring-request JSON|@FILE]
    [--json] [--repo PATH]
  simple-changes loop status [--json] [--repo PATH]
  simple-changes loop replan-status [--json] [--repo PATH]
  simple-changes loop archive-recorded --run-id ID --agent-id ID
    --manifest-digest SHA256 --status-digest SHA256
    --approved-by ID --reason TEXT [--json] [--repo PATH]
  simple-changes loop replan --run-id ID --agent-id ID
    --manifest-digest SHA256 --status-digest SHA256
    --approved-by ID --reason TEXT [--json] [--repo PATH]
  simple-changes loop verify --run-id ID [--for merge|deploy|migrations]
    [--remote NAME | --local-only] [--json] [--repo PATH]
  simple-changes loop guard --run-id ID --agent-id ID [--json] [--repo PATH]
  simple-changes loop record-scope --run-id ID --agent-id ID
    --receipt CHANGE_PLAN_FILE [--json] [--repo PATH]
  simple-changes loop refresh-scope --run-id ID --agent-id ID
    --receipt CHANGE_PLAN_FILE [--json] [--repo PATH]
  simple-changes loop record-outcome --run-id ID --agent-id ID
    --receipt SHIPMENT_OUTCOME_FILE
    [--approved-by USER --approval-reference REFERENCE]
    [--json] [--repo PATH]
  simple-changes loop exec --run-id ID --agent-id ID [--json] [--repo PATH]
    -- COMMAND [ARG ...]
  simple-changes loop recover --agent-id ID [--json] [--repo PATH]
  simple-changes loop recover --stale-lease --run-id ID --agent-id ID
    --approved-by ID --reason TEXT [--json] [--repo PATH]
  simple-changes loop takeover --run-id ID --agent-id ID
    --manifest-digest SHA256 --approved-by ID --reason TEXT [--json] [--repo PATH]
  simple-changes loop rebaseline --run-id ID --agent-id ID
    --approved-by ID --reason TEXT [--json] [--repo PATH]
  simple-changes loop allow --run-id ID --agent-id ID --worktree PATH
    --status-digest SHA256 --approved-by ID --reason TEXT [--json] [--repo PATH]
  simple-changes loop dispose-worktree --run-id ID --agent-id ID --worktree PATH
    --status-digest SHA256 --approved-by ID --reason TEXT [--json] [--repo PATH]
  simple-changes loop retain-worktree --run-id ID --agent-id ID --worktree PATH
    --status-digest SHA256 --approved-by ID --reason TEXT [--json] [--repo PATH]
  simple-changes loop retire-absent-worktree --run-id ID --agent-id ID
    --worktree PATH --approved-by ID --reason TEXT [--json] [--repo PATH]
  simple-changes loop adopt-worktree --run-id ID --agent-id ID
    --pause-receipt ID [--json] [--repo PATH]
  simple-changes loop accept-paused-change --run-id ID --agent-id ID
    --pause-receipt ID [--json] [--repo PATH]
  simple-changes loop reconcile-remote-branches --run-id ID --agent-id ID
    --receipt FILE [--json] [--repo PATH]
  simple-changes loop recover-post-cleanup --run-id ID --agent-id ID
    --receipt FILE [--json] [--repo PATH]
  simple-changes loop close-equivalent --run-id ID --agent-id ID
    --approved-by ID --reason TEXT [--evidence FILE ...] [--json] [--repo PATH]
  simple-changes loop emergency status --run-id ID [--json] [--repo PATH]
  simple-changes loop emergency record --run-id ID --agent-id ID --state FILE
    [--json] [--repo PATH]
  simple-changes loop end --run-id ID --agent-id ID [--reason TEXT]
    [--json] [--repo PATH]
  simple-changes loop finalize --run-id ID --agent-id ID --reason TEXT
    [--awaiting-user TEXT ...] [--json] [--repo PATH]
  simple-changes loop turn-check [--hook] [--json]
  simple-changes harness stop-hook [--harness claude-code|codex] [--write]
    [--json]
  simple-changes worktree status [--json] [--repo PATH]
  simple-changes worktree observe [--json] [--repo PATH]
  simple-changes worktree request --claim-id ID --run-id ID
    --request-action request-pause|request-detach|notify-resume
    [--json] [--repo PATH]
  simple-changes worktree claim --agent-id ID --worktree PATH --adapter ID
    [--owner-ref REF] [--json] [--repo PATH]
  simple-changes worktree pause --agent-id ID --worktree PATH --run-id ID
    --disposition preserve-in-place|detach-clean-checkout --reason TEXT
    [--json] [--repo PATH]
  simple-changes worktree detach --agent-id ID --worktree PATH
    --pause-receipt ID [--json] [--repo PATH]
  simple-changes worktree attach --agent-id ID --claim-id ID [--json] [--repo PATH]
  simple-changes worktree resume-ready --run-id ID --agent-id ID --claim-id ID
    [--json] [--repo PATH]
  simple-changes worktree release --agent-id ID --claim-id ID
    [--ready-receipt FILE] [--json] [--repo PATH]
  simple-changes worktree takeover --claim-id ID --agent-id NEW_OWNER
    --status-digest SHA256 --approved-by ID --reason TEXT [--release]
    [--json] [--repo PATH]
  simple-changes branch audit --head REF --target REF [--json] [--repo PATH]
  simple-changes worktree equivalence --worktree PATH [--target REF]
    [--json] [--repo PATH]
  simple-changes worktree refresh-index [--json] [--repo PATH]
  simple-changes worktree cleanup --agent-id ID --approved-by ID --reason TEXT
    [--target REF] [--json] [--repo PATH]
  simple-changes hold add --agent-id ID --adapter ID
    --hold-scope ship|deploy|migrations --severity delay|halt --reason TEXT
    [--until-merged BRANCH] [--owner-ref REF] [--json] [--repo PATH]
  simple-changes hold status [--remote NAME | --local-only] [--json] [--repo PATH]
  simple-changes hold check --for merge|deploy|migrations [--run-id ID]
    [--remote NAME | --local-only] [--json] [--repo PATH]
  simple-changes hold release --agent-id ID --hold-id ID
    [--approved-by ID --reason TEXT [--override-halt]] [--remote NAME]
    [--json] [--repo PATH]
  simple-changes hold waive --run-id ID --agent-id ID --hold-id ID
    --approved-by ID --reason TEXT [--override-halt]
    [--remote NAME | --local-only] [--json] [--repo PATH]
  simple-changes hold publish --agent-id ID --hold-id ID [--remote NAME]
    [--json] [--repo PATH]
  simple-changes prune --approved-by ID --reason TEXT [--target REF]
    [--dry-run] [--json] [--repo PATH]
  simple-changes prepare-agent --run-id ID --agent-id ID --purpose SLUG
    [--json] [--repo PATH]
  simple-changes release-notes [--check] [--json] [--repo PATH] [--version VERSION]
  simple-changes negotiate-changelog CAPABILITIES_FILE [--json]
  simple-changes validate-changelog-transaction REQUEST_FILE RECEIPT_FILE [--prior-receipt FILE] [--json]
  simple-changes validate-changelog-release-set RECEIPT_FILE RECEIPT_FILE... [--json]
  simple-changes release-gate --request FILE --receipt FILE [--prior-receipt FILE]
    --production ask|allow|deny [--already-live] [--production-authorized]
    [--version-authorized] [--json]
  simple-changes release-delivery --changelog-receipt FILE --provider-receipt FILE
    [--request FILE] [--json]
  simple-changes release-tag --run-id ID --agent-id ID --request FILE
    --receipt FILE [--prior-receipt FILE] --production ask|allow|deny
    [--production-authorized] [--already-live] [--tag-automation-authorized]
    [--dry-run] [--json] [--repo PATH]
  simple-changes proposal-signatures --agent NAME --role authored|reviewed|merged
    [--base REF --head REF] [--changelog-receipt FILE] [--json] [--repo PATH]
  simple-changes proposal audit --file FILE [--template FILE] [--json]
  simple-changes proposal record-authors --proposal ID --base SHA --head SHA
    [--receipt COPY_AUTHORS_FILE] [--instance ID] [--agent NAME]
    [--json] [--repo PATH]
  simple-changes proposal record-review --proposal ID --head SHA
    --attempt-id UUID --receipt ATTEMPT_FILE [--authoring-request JSON|@FILE]
    [--json] [--repo PATH]
  simple-changes proposal waive-coverage --proposal ID --head SHA
    --authors-digest SHA256 --receipt WAIVER_FILE [--json] [--repo PATH]
  simple-changes author attest --commit SHA [--commit SHA ...] [--agent-id ID]
    [--contribution implementation] [--replays SHA[,SHA ...]]
    [--worktree PATH] [--instance ID] [--agent NAME] [--json] [--repo PATH]
  simple-changes skill check [--skill-dir PATH] [--json]
  simple-changes validate KIND FILE [--json]
  simple-changes verify-markdown FILE [--json]
  simple-changes help

Schema kinds:
${schemaKindLines}

Exit codes:
  0 success, 2 usage, 3 invalid contract, 4 inventory failure, 5 unsafe state,
  6 release notes older than the packaged window (printed a link instead)
`;

interface CliOptions {
  acknowledgePushScope: boolean;
  adapter?: string;
  agentId?: string;
  agentName?: string;
  alreadyLive: boolean;
  applyPlanPath?: string;
  approvalReference?: string;
  approvedBy?: string;
  attemptId?: string;
  // setup --authoring: the authoring answer as JSON or @path.
  authoring?: string;
  // initialize and proposal record-review --authoring-request: the current
  // request's sidecar object as JSON or @path, applied and never written.
  authoringRequest?: string;
  authorsDigest?: string;
  awaitingUser: string[];
  baseRef?: string;
  changelogHandling?: RepoPolicy["changelogHandling"];
  changelogInstall?: ChangelogInstallDecision;
  changelogReceiptPath?: string;
  changelogRequired: boolean;
  check: boolean;
  claimId?: string;
  commits: string[];
  concurrentWork?: RepoPolicy["concurrentWork"];
  contribution?: "implementation";
  defaultFinish?: "open-change-request" | "integrate" | "ship";
  disposition?: "preserve-in-place" | "detach-clean-checkout";
  dryRun: boolean;
  evidencePaths: string[];
  filePath?: string;
  forkDeltas?: string;
  forkDestination?: string;
  forkName?: string;
  forkUpstream?: string;
  gitPushAuthorization?: RepoPolicy["gitPushAuthorization"];
  guidanceDecision?: RepoPolicy["guidance"]["disposition"];
  handoffTiming?: RepoPolicy["handoffTiming"];
  harness?: TurnGuardHarness;
  headRef?: string;
  help: boolean;
  holdAction?: ShipHoldAction;
  holdId?: string;
  holdScope?: ShipHoldScope;
  holdSeverity?: ShipHoldSeverity;
  hook: boolean;
  instanceId?: string;
  instructionFile?: string;
  instructionPointer?: "add" | "leave";
  json: boolean;
  localOnly: boolean;
  manifestDigest?: string;
  migrationHandling?: RepoPolicy["migrationHandling"];
  migrationTargets: RepoPolicy["migrationTargets"];
  mode?: InitializationMode;
  openingRemoteInventoryPath?: string;
  overrideHalt: boolean;
  ownerRef?: string;
  pauseReceiptId?: string;
  pendingPath?: string;
  positional: string[];
  priorReceiptPath?: string;
  productionAuthorized: boolean;
  productionDeploy?: RepoPolicy["productionDeploy"];
  proposalId?: string;
  proposalScheduling?: RepoPolicy["proposalScheduling"];
  proposalSignatures?: RepoPolicy["proposalSignatures"];
  providerReceiptPath?: string;
  purpose?: string;
  questions?: RepoPolicy["questions"];
  ready: boolean;
  readyReceiptPath?: string;
  reason?: string;
  receiptPath?: string;
  releaseClaim: boolean;
  releaseVersion?: string;
  remoteName?: string;
  replays?: string[];
  repo: string;
  repoProvided: boolean;
  requestAction?: "request-pause" | "request-detach" | "notify-resume";
  requestPath?: string;
  runId?: string;
  scope?: SetupScope;
  sessionId?: string;
  settleMs: number;
  shippingMode?: RepoPolicy["shippingMode"];
  signatureRole?: ProposalSignatureRole;
  skillDirectory?: string;
  staleLease: boolean;
  statePath?: string;
  statusDigest?: string;
  tagAutomationAuthorized: boolean;
  targetRef?: string;
  templatePath?: string;
  uiArtifacts: boolean;
  uiArtifactVersioning?: RepoPolicy["uiArtifactVersioning"];
  untilMerged?: string;
  versionAuthorized: boolean;
  worktreePath?: string;
  write: boolean;
  yes: boolean;
}

const VALUED_OPTIONS = new Set([
  "--name",
  "--authoring",
  "--authoring-request",
  "--deltas",
  "--destination",
  "--upstream",
  "--adapter",
  "--apply-plan",
  "--agent-id",
  "--approval-reference",
  "--approved-by",
  "--awaiting-user",
  "--changelog",
  "--changelog-install",
  "--concurrent-work",
  "--agent",
  "--base",
  "--changelog-receipt",
  "--claim-id",
  "--head",
  "--role",
  "--disposition",
  "--evidence",
  "--file",
  "--finish",
  "--for",
  "--handoff",
  "--harness",
  "--guidance-decision",
  "--git-push-authorization",
  "--hold-id",
  "--hold-scope",
  "--instruction-file",
  "--instruction-pointer",
  "--manifest-digest",
  "--migration-handling",
  "--migration-target",
  "--mode",
  "--owner-ref",
  "--opening-remote-inventory",
  "--pending",
  "--pause-receipt",
  "--prior-receipt",
  "--production",
  "--provider-receipt",
  "--proposal-scheduling",
  "--proposal-signatures",
  "--purpose",
  "--questions",
  "--ready-receipt",
  "--reason",
  "--receipt",
  "--remote",
  "--request",
  "--request-action",
  "--repo",
  "--run-id",
  "--scope",
  "--shipping-mode",
  "--settle-ms",
  "--severity",
  "--skill-dir",
  "--status-digest",
  "--state",
  "--target",
  "--template",
  "--ui-versioning",
  "--until-merged",
  "--version",
  "--worktree",
  // Review ledger: author attest and the proposal ledger subcommands.
  "--attempt-id",
  "--authors-digest",
  "--commit",
  "--contribution",
  "--instance",
  "--proposal",
  "--replays",
  "--session",
]);

const BOOLEAN_OPTIONS = new Set([
  "--already-live",
  "--production-authorized",
  "--version-authorized",
  "--acknowledge-push-scope",
  "--changelog-required",
  "--check",
  "--dry-run",
  "--hook",
  "--json",
  "--local-only",
  "--override-halt",
  "--ready",
  "--release",
  "--stale-lease",
  "--tag-automation-authorized",
  "--ui-artifacts",
  "--write",
  "--yes",
  // setup --authoring confirms with --confirm (the same as --yes).
  "--confirm",
]);

const requiredOptionValue = (
  args: string[],
  index: number,
  option: string
): string => {
  const value = args[index + 1];
  if (!value) {
    throw new SimpleChangesError(
      `${option} requires a value`,
      EXIT_CODES.usage
    );
  }
  return value;
};

const changelogHandlingValue = (
  value: string
): RepoPolicy["changelogHandling"] => {
  if (
    !["delegate-if-available", "preserve-and-report", "ask"].includes(value)
  ) {
    throw new SimpleChangesError(
      "--changelog must be delegate-if-available, preserve-and-report, or ask",
      EXIT_CODES.usage
    );
  }
  return value as RepoPolicy["changelogHandling"];
};

const CHANGELOG_INSTALL_FLAG_VALUES: Record<string, ChangelogInstallDecision> =
  {
    "after-shipment": "install-after-shipment",
    decline: "declined",
    later: "install-later",
    now: "install-now",
  };

const changelogInstallValue = (value: string): ChangelogInstallDecision => {
  const decision = CHANGELOG_INSTALL_FLAG_VALUES[value];
  if (!decision) {
    throw new SimpleChangesError(
      "--changelog-install must be now, after-shipment, later, or decline",
      EXIT_CODES.usage
    );
  }
  return decision;
};

const applyShippingModeOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option !== "--shipping-mode") {
    return false;
  }
  if (
    !(value === "standard" || value === "expedited" || value === "break-glass")
  ) {
    throw new SimpleChangesError(
      "--shipping-mode must be standard, expedited, or break-glass",
      EXIT_CODES.usage
    );
  }
  options.shippingMode = value;
  return true;
};

const applyFinishOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option !== "--finish") {
    return false;
  }
  const finishAliases = {
    integrate: "integrate",
    merge: "integrate",
    "open-change-request": "open-change-request",
    review: "open-change-request",
    ship: "ship",
  } as const;
  const finish = finishAliases[value as keyof typeof finishAliases];
  if (!finish) {
    throw new SimpleChangesError(
      "--finish must be review, integrate, or ship",
      EXIT_CODES.usage
    );
  }
  options.defaultFinish = finish;
  return true;
};

const applyHandoffOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option !== "--handoff") {
    return false;
  }
  const timingAliases = {
    ask: "confirm-ready",
    automatic: "automatic",
    "confirm-ready": "confirm-ready",
    "user-signaled": "user-signaled",
  } as const;
  const timing = timingAliases[value as keyof typeof timingAliases];
  if (!timing) {
    throw new SimpleChangesError(
      "--handoff must be ask, automatic, or user-signaled",
      EXIT_CODES.usage
    );
  }
  options.handoffTiming = timing;
  return true;
};

const applyMigrationOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option === "--migration-handling") {
    const values: RepoPolicy["migrationHandling"][] = [
      "ask-after-review",
      "auto-apply-reviewed-routine",
      "auto-apply-reviewed",
      "never",
    ];
    if (!values.includes(value as RepoPolicy["migrationHandling"])) {
      throw new SimpleChangesError(
        `--migration-handling must be one of ${values.join(", ")}`,
        EXIT_CODES.usage
      );
    }
    options.migrationHandling = value as RepoPolicy["migrationHandling"];
    return true;
  }
  if (option !== "--migration-target") {
    return false;
  }
  try {
    options.migrationTargets = [
      ...options.migrationTargets,
      ...parseMigrationTargets(value),
    ];
  } catch (error) {
    throw SimpleChangesError.withCause(
      error instanceof Error ? error.message : "Invalid migration target.",
      EXIT_CODES.usage,
      error
    );
  }
  return true;
};

const applySignatureRoleOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option !== "--role") {
    return false;
  }
  const roles: ProposalSignatureRole[] = ["authored", "reviewed", "merged"];
  if (!roles.includes(value as ProposalSignatureRole)) {
    throw new SimpleChangesError(
      `--role must be one of ${roles.join(", ")}`,
      EXIT_CODES.usage
    );
  }
  options.signatureRole = value as ProposalSignatureRole;
  return true;
};

const applyProposalSignaturesOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option !== "--proposal-signatures") {
    return false;
  }
  const values: RepoPolicy["proposalSignatures"][] = [
    "agent-and-version",
    "none",
  ];
  if (!values.includes(value as RepoPolicy["proposalSignatures"])) {
    throw new SimpleChangesError(
      `--proposal-signatures must be one of ${values.join(", ")}`,
      EXIT_CODES.usage
    );
  }
  options.proposalSignatures = value as RepoPolicy["proposalSignatures"];
  return true;
};

const applyProposalSchedulingOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option !== "--proposal-scheduling") {
    return false;
  }
  const values: RepoPolicy["proposalScheduling"][] = [
    "balanced",
    "consecutive",
    "parallel",
  ];
  if (!values.includes(value as RepoPolicy["proposalScheduling"])) {
    throw new SimpleChangesError(
      `--proposal-scheduling must be one of ${values.join(", ")}`,
      EXIT_CODES.usage
    );
  }
  options.proposalScheduling = value as RepoPolicy["proposalScheduling"];
  return true;
};

const applyAuthoringValuedOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option !== "--authoring") {
    return false;
  }
  options.authoring = value;
  return true;
};

const applySetupValuedOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option === "--git-push-authorization") {
    const values: RepoPolicy["gitPushAuthorization"][] = [
      "configure-harness",
      "ask",
      "never",
    ];
    if (!values.includes(value as RepoPolicy["gitPushAuthorization"])) {
      throw new SimpleChangesError(
        `--git-push-authorization must be one of ${values.join(", ")}`,
        EXIT_CODES.usage
      );
    }
    options.gitPushAuthorization = value as RepoPolicy["gitPushAuthorization"];
    return true;
  }
  if (option === "--changelog") {
    options.changelogHandling = changelogHandlingValue(value);
    return true;
  }
  if (option === "--changelog-install") {
    options.changelogInstall = changelogInstallValue(value);
    return true;
  }
  if (option === "--concurrent-work") {
    if (!["allow-claimed", "strict"].includes(value)) {
      throw new SimpleChangesError(
        "--concurrent-work must be allow-claimed or strict",
        EXIT_CODES.usage
      );
    }
    options.concurrentWork = value as "allow-claimed" | "strict";
    return true;
  }
  if (
    applyProposalSchedulingOption(options, option, value) ||
    applyProposalSignaturesOption(options, option, value) ||
    applySignatureRoleOption(options, option, value) ||
    applyFinishOption(options, option, value) ||
    applyHandoffOption(options, option, value) ||
    applyMigrationOption(options, option, value)
  ) {
    return true;
  }
  if (option === "--guidance-decision") {
    if (
      !(["accepted", "reviewed", "deferred"] as const).includes(
        value as RepoPolicy["guidance"]["disposition"]
      )
    ) {
      throw new SimpleChangesError(
        "--guidance-decision must be accepted, reviewed, or deferred",
        EXIT_CODES.usage
      );
    }
    options.guidanceDecision = value as RepoPolicy["guidance"]["disposition"];
    return true;
  }
  if (option === "--instruction-file") {
    options.instructionFile = value;
    return true;
  }
  if (option === "--instruction-pointer") {
    if (!["add", "leave"].includes(value)) {
      throw new SimpleChangesError(
        "--instruction-pointer must be add or leave",
        EXIT_CODES.usage
      );
    }
    options.instructionPointer = value as "add" | "leave";
    return true;
  }
  if (option === "--ui-versioning") {
    const versioningAliases = {
      "date-only": "date-only",
      "number-and-date": "number-and-date",
      "number-only": "number-only",
      repository: "repository-convention",
      "repository-convention": "repository-convention",
    } as const;
    const versioning =
      versioningAliases[value as keyof typeof versioningAliases];
    if (!versioning) {
      throw new SimpleChangesError(
        "--ui-versioning must be repository, number-and-date, date-only, or number-only",
        EXIT_CODES.usage
      );
    }
    options.uiArtifacts = true;
    options.uiArtifactVersioning = versioning;
    return true;
  }
  return false;
};

const applyLoopValuedOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  const textOptions: Record<string, keyof CliOptions> = {
    "--adapter": "adapter",
    "--agent": "agentName",
    "--agent-id": "agentId",
    "--apply-plan": "applyPlanPath",
    "--approval-reference": "approvalReference",
    "--approved-by": "approvedBy",
    "--authoring-request": "authoringRequest",
    "--base": "baseRef",
    "--changelog-receipt": "changelogReceiptPath",
    "--claim-id": "claimId",
    "--deltas": "forkDeltas",
    "--destination": "forkDestination",
    "--file": "filePath",
    "--head": "headRef",
    "--hold-id": "holdId",
    "--manifest-digest": "manifestDigest",
    "--name": "forkName",
    "--opening-remote-inventory": "openingRemoteInventoryPath",
    "--owner-ref": "ownerRef",
    "--pause-receipt": "pauseReceiptId",
    "--pending": "pendingPath",
    "--prior-receipt": "priorReceiptPath",
    "--provider-receipt": "providerReceiptPath",
    "--purpose": "purpose",
    "--reason": "reason",
    "--receipt": "receiptPath",
    "--remote": "remoteName",
    "--request": "requestPath",
    "--run-id": "runId",
    "--skill-dir": "skillDirectory",
    "--state": "statePath",
    "--status-digest": "statusDigest",
    "--template": "templatePath",
    "--until-merged": "untilMerged",
    "--upstream": "forkUpstream",
  };
  const key = textOptions[option];
  if (key) {
    Object.assign(options, { [key]: value });
    return true;
  }
  if (option === "--worktree") {
    options.worktreePath = resolve(value);
    return true;
  }
  if (option === "--target") {
    options.targetRef = value;
    return true;
  }
  if (option === "--evidence") {
    options.evidencePaths.push(resolve(value));
    return true;
  }
  if (option === "--awaiting-user") {
    options.awaitingUser.push(value);
    return true;
  }
  if (option === "--harness") {
    if (value !== "claude-code" && value !== "codex") {
      throw new SimpleChangesError(
        "--harness must be claude-code or codex",
        EXIT_CODES.usage
      );
    }
    options.harness = value;
    return true;
  }
  if (option === "--ready-receipt") {
    options.readyReceiptPath = resolve(value);
    return true;
  }
  if (option === "--disposition") {
    if (!["preserve-in-place", "detach-clean-checkout"].includes(value)) {
      throw new SimpleChangesError(
        "--disposition must be preserve-in-place or detach-clean-checkout",
        EXIT_CODES.usage
      );
    }
    options.disposition = value as
      | "preserve-in-place"
      | "detach-clean-checkout";
    return true;
  }
  if (option === "--request-action") {
    if (!["request-pause", "request-detach", "notify-resume"].includes(value)) {
      throw new SimpleChangesError(
        "--request-action must be request-pause, request-detach, or notify-resume",
        EXIT_CODES.usage
      );
    }
    options.requestAction = value as NonNullable<CliOptions["requestAction"]>;
    return true;
  }
  return false;
};

const enumOption = <T extends string>(
  option: string,
  value: string,
  allowed: readonly T[]
): T => {
  if (!allowed.includes(value as T)) {
    throw new SimpleChangesError(
      `${option} must be ${allowed.slice(0, -1).join(", ")}${allowed.length > 2 ? "," : ""} or ${allowed.at(-1)}`,
      EXIT_CODES.usage
    );
  }
  return value as T;
};

const applyHoldValuedOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  if (option === "--for") {
    options.holdAction = enumOption(option, value, SHIP_HOLD_ACTIONS);
    return true;
  }
  if (option === "--hold-scope") {
    options.holdScope = enumOption(option, value, SHIP_HOLD_SCOPES);
    return true;
  }
  if (option === "--severity") {
    options.holdSeverity = enumOption(option, value, SHIP_HOLD_SEVERITIES);
    return true;
  }
  return false;
};

const LEDGER_TEXT_OPTIONS: Record<string, keyof CliOptions> = {
  "--attempt-id": "attemptId",
  "--authors-digest": "authorsDigest",
  "--instance": "instanceId",
  "--proposal": "proposalId",
  "--session": "sessionId",
};

const applyLedgerValuedOption = (
  options: CliOptions,
  option: string,
  value: string
): boolean => {
  const key = LEDGER_TEXT_OPTIONS[option];
  if (key) {
    Object.assign(options, { [key]: value });
    return true;
  }
  if (option === "--commit") {
    options.commits.push(value);
    return true;
  }
  if (option === "--replays") {
    options.replays = [
      ...(options.replays ?? []),
      ...value.split(",").map((source) => source.trim()),
    ];
    return true;
  }
  if (option === "--contribution") {
    if (value !== "implementation") {
      throw new SimpleChangesError(
        "--contribution must be implementation",
        EXIT_CODES.usage
      );
    }
    options.contribution = value;
    return true;
  }
  return false;
};

const applyValuedOption = (
  options: CliOptions,
  option: string,
  value: string
): void => {
  if (
    applyShippingModeOption(options, option, value) ||
    applySetupValuedOption(options, option, value) ||
    applyAuthoringValuedOption(options, option, value) ||
    applyLoopValuedOption(options, option, value) ||
    applyHoldValuedOption(options, option, value) ||
    applyLedgerValuedOption(options, option, value)
  ) {
    return;
  }
  if (option === "--mode") {
    const modes: InitializationMode[] = [
      "handoff",
      "preview",
      "sync",
      "queue",
      "sweep",
      "integrate",
      "ship",
      "reconcile",
      "resume",
      "pause",
    ];
    if (!modes.includes(value as InitializationMode)) {
      throw new SimpleChangesError(
        `--mode must be one of ${modes.join(", ")}`,
        EXIT_CODES.usage
      );
    }
    options.mode = value as InitializationMode;
    return;
  }
  if (option === "--production") {
    if (!["ask", "allow", "deny"].includes(value)) {
      throw new SimpleChangesError(
        "--production must be ask, allow, or deny",
        EXIT_CODES.usage
      );
    }
    options.productionDeploy = value as RepoPolicy["productionDeploy"];
    return;
  }
  if (option === "--questions") {
    if (!["blocking-only", "always", "never"].includes(value)) {
      throw new SimpleChangesError(
        "--questions must be blocking-only, always, or never",
        EXIT_CODES.usage
      );
    }
    options.questions = value as RepoPolicy["questions"];
    return;
  }
  if (option === "--repo") {
    options.repo = resolve(value);
    options.repoProvided = true;
    return;
  }
  if (option === "--scope") {
    // `personal` names the same private scope as `user`.
    if (!["user", "personal", "repository", "run"].includes(value)) {
      throw new SimpleChangesError(
        "--scope must be user (or personal), repository, or run",
        EXIT_CODES.usage
      );
    }
    options.scope = (value === "personal" ? "user" : value) as SetupScope;
    return;
  }
  if (option === "--version") {
    options.releaseVersion = value;
    return;
  }
  const settleMs = Number(value);
  if (!(Number.isInteger(settleMs) && settleMs >= 0 && settleMs <= 60_000)) {
    throw new SimpleChangesError(
      "--settle-ms must be an integer from 0 to 60000",
      EXIT_CODES.usage
    );
  }
  options.settleMs = settleMs;
};

const applyTurnGuardBooleanOption = (
  options: CliOptions,
  option: string
): boolean => {
  if (option === "--hook") {
    options.hook = true;
    return true;
  }
  if (option === "--write") {
    options.write = true;
    return true;
  }
  return false;
};

const applyBooleanOption = (options: CliOptions, option: string): void => {
  if (option === "--acknowledge-push-scope") {
    options.acknowledgePushScope = true;
  } else if (option === "--already-live") {
    options.alreadyLive = true;
  } else if (option === "--production-authorized") {
    options.productionAuthorized = true;
  } else if (option === "--version-authorized") {
    options.versionAuthorized = true;
  } else if (option === "--json") {
    options.json = true;
  } else if (option === "--local-only") {
    options.localOnly = true;
  } else if (option === "--override-halt") {
    options.overrideHalt = true;
  } else if (option === "--changelog-required") {
    options.changelogRequired = true;
  } else if (option === "--check") {
    options.check = true;
  } else if (option === "--dry-run") {
    options.dryRun = true;
  } else if (option === "--stale-lease") {
    options.staleLease = true;
  } else if (option === "--tag-automation-authorized") {
    options.tagAutomationAuthorized = true;
  } else if (option === "--ready") {
    options.ready = true;
  } else if (option === "--release") {
    options.releaseClaim = true;
  } else if (option === "--ui-artifacts") {
    options.uiArtifacts = true;
  } else {
    options.yes = true;
  }
};

const parseOptions = (args: string[]): CliOptions => {
  const options: CliOptions = {
    acknowledgePushScope: false,
    alreadyLive: false,
    awaitingUser: [],
    changelogRequired: false,
    check: false,
    commits: [],
    dryRun: false,
    evidencePaths: [],
    help: false,
    hook: false,
    json: false,
    localOnly: false,
    migrationTargets: [],
    overrideHalt: false,
    positional: [],
    productionAuthorized: false,
    ready: false,
    releaseClaim: false,
    repo: process.cwd(),
    repoProvided: false,
    settleMs: 0,
    staleLease: false,
    tagAutomationAuthorized: false,
    uiArtifacts: false,
    versionAuthorized: false,
    write: false,
    yes: false,
  };
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === "--") {
      options.positional.push(...args.slice(index + 1));
      break;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      index += 1;
      continue;
    }
    if (argument && BOOLEAN_OPTIONS.has(argument)) {
      if (!applyTurnGuardBooleanOption(options, argument)) {
        applyBooleanOption(options, argument);
      }
      index += 1;
      continue;
    }
    if (argument && VALUED_OPTIONS.has(argument)) {
      applyValuedOption(
        options,
        argument,
        requiredOptionValue(args, index, argument)
      );
      index += 2;
      continue;
    }
    if (argument?.startsWith("--")) {
      throw new SimpleChangesError(
        `Unknown option: ${argument}. Run 'simple-changes help' for usage.`,
        EXIT_CODES.usage
      );
    }
    if (argument) {
      options.positional.push(argument);
    }
    index += 1;
  }
  return options;
};

const writeOutput = (value: unknown, json: boolean, text: string): void => {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
};

const runInventory = (options: CliOptions): void => {
  const inventory = captureInventory(options.repo);
  writeOutput(inventory, options.json, renderInventory(inventory));
};

const runPreview = async (options: CliOptions): Promise<void> => {
  const opening = captureInventory(options.repo);
  if (options.settleMs > 0) {
    await sleep(options.settleMs);
  }
  const current = captureInventory(options.repo);
  const comparison = compareSnapshots(opening, current);
  const plan = buildPreviewPlan(opening, current, comparison);
  writeOutput(plan, options.json, renderPlan(plan));
};

const defaultChoiceIndex = (
  choices: readonly OnboardingChoice[],
  defaultValue: string
): number => {
  const index = choices.findIndex((choice) => choice.value === defaultValue);
  return index >= 0 ? index : 0;
};

const createCliPrompter = (
  options: CliOptions
): {
  close: () => void;
  prompter: OnboardingPrompter;
} => {
  const output = options.json ? process.stderr : process.stdout;
  const reader = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  const choose = (
    question: string,
    choices: readonly OnboardingChoice[],
    defaultValue: string
  ): Promise<string> => {
    const selectedDefault = defaultChoiceIndex(choices, defaultValue);
    output.write(`\n${question}\n\n`);
    for (const [index, choice] of choices.entries()) {
      const recommendation = index === selectedDefault ? " (Recommended)" : "";
      output.write(`  ${index + 1}. ${choice.label}${recommendation}\n`);
      for (const line of choice.description.split("\n")) {
        output.write(`     ${line}\n`);
      }
    }
    const askForChoice = async (): Promise<string> => {
      const answer = (
        await reader.question(
          `\nChoose 1-${choices.length} [${selectedDefault + 1}]: `
        )
      ).trim();
      if (!answer) {
        return choices[selectedDefault]?.value ?? choices[0]?.value ?? "";
      }
      const selectedIndex = Number(answer) - 1;
      const selected = choices[selectedIndex];
      if (selected && Number.isInteger(selectedIndex)) {
        return selected.value;
      }
      output.write(`Please choose a number from 1 to ${choices.length}.\n`);
      return askForChoice();
    };
    return askForChoice();
  };
  return {
    close: () => reader.close(),
    prompter: {
      choose,
      confirm: async (summary: string): Promise<boolean> => {
        if (options.yes) {
          return true;
        }
        output.write(`\n${summary}\n`);
        const answer = (
          await reader.question("\nConfirm these preferences? [Y/n]: ")
        )
          .trim()
          .toLowerCase();
        return answer === "" || answer === "y" || answer === "yes";
      },
      input: (question: string): Promise<string> =>
        reader.question(`\n${question}\n> `).then((answer) => answer.trim()),
      present: (message: string): void => {
        output.write(`\n${message}\n`);
      },
    },
  };
};

const setupNeedsPrompt = (
  options: CliOptions,
  changelogRelevant: boolean,
  instructionTargetCount: number,
  changelogInstallOffered = false
): boolean =>
  !(
    options.defaultFinish &&
    (!changelogRelevant || options.changelogHandling) &&
    (!changelogInstallOffered || options.changelogInstall) &&
    options.questions &&
    options.scope &&
    options.gitPushAuthorization &&
    (options.defaultFinish !== "ship" ||
      (options.productionDeploy && options.shippingMode)) &&
    (!(
      options.migrationHandling &&
      ["auto-apply-reviewed-routine", "auto-apply-reviewed"].includes(
        options.migrationHandling
      )
    ) ||
      options.migrationTargets.length > 0) &&
    (!options.uiArtifacts || options.uiArtifactVersioning) &&
    (instructionTargetCount === 0 ||
      options.instructionPointer === "leave" ||
      (instructionTargetCount === 1 &&
        options.instructionPointer === "add" &&
        options.handoffTiming)) &&
    options.yes
  );

const setupPolicyPath = (
  scope: SetupScope,
  primaryCheckout: string | null
): string | null => {
  if (scope === "repository") {
    if (!primaryCheckout) {
      throw new SimpleChangesError(
        "Repository-scoped setup requires a Git repository.",
        EXIT_CODES.usage
      );
    }
    return resolve(primaryCheckout, ".simple-changes.json");
  }
  if (scope === "user") {
    return resolvePersonalPolicyPath();
  }
  return null;
};

const setupOutcome = (
  confirmed: boolean,
  written: boolean,
  path: string | null
): string => {
  if (!confirmed) {
    return "Preferences were not saved.";
  }
  if (written) {
    return `Saved preferences to ${path}.`;
  }
  return "Selected these preferences for this run; no file was written.";
};

const describeChangelogCapability = (
  coordination: ChangelogCoordination
): string => {
  if (coordination.capabilityAvailable) {
    return "available";
  }
  return coordination.capabilityStatus === "not-applicable"
    ? `not applicable (${coordination.providerDistribution ?? "discovery-only"} distribution owns no public release files)`
    : "not available";
};

const setupContext = (
  repositoryPath: string
): {
  changelog: ReturnType<typeof inspectChangelogCoordination>;
  existingPersonalDefaults: RepoPolicy | null;
  forgeProvider: string | null;
  policy: RepoPolicy;
  primaryCheckout: string | null;
} => {
  const personalPolicy = loadPersonalPolicy();
  const probe = runGit(repositoryPath, ["rev-parse", "--show-toplevel"], true);
  if (probe.exitCode !== 0) {
    return {
      changelog: inspectChangelogCoordination(null),
      existingPersonalDefaults:
        personalPolicy.source === "user" ? personalPolicy.value : null,
      forgeProvider: null,
      policy: personalPolicy.value,
      primaryCheckout: null,
    };
  }
  const inventory = captureInventory(repositoryPath);
  const targetBinding = inventory.repository.remoteBindings.find(
    (binding) => binding.name === inventory.repository.targetRemote
  );
  return {
    changelog: inspectChangelogCoordination(
      inventory.repository.primaryCheckout
    ),
    existingPersonalDefaults:
      personalPolicy.source === "user" ? personalPolicy.value : null,
    forgeProvider: targetBinding?.provider ?? null,
    policy: inventory.policy.value,
    primaryCheckout: inventory.repository.primaryCheckout,
  };
};

const SETUP_INPUT_KEYS = [
  "changelogHandling",
  "changelogInstall",
  "concurrentWork",
  "defaultFinish",
  "gitPushAuthorization",
  "handoffTiming",
  "instructionFile",
  "instructionPointer",
  "migrationHandling",
  "proposalScheduling",
  "proposalSignatures",
  "productionDeploy",
  "questions",
  "scope",
  "shippingMode",
  "uiArtifactVersioning",
] as const satisfies readonly (keyof OnboardingInputs & keyof CliOptions)[];

const buildOnboardingInputs = (
  options: CliOptions,
  needsPrompt: boolean
): OnboardingInputs => {
  const inputs: OnboardingInputs = {};
  for (const key of SETUP_INPUT_KEYS) {
    const value = options[key];
    if (value !== undefined) {
      Object.assign(inputs, { [key]: value });
    }
  }
  if (options.migrationTargets.length > 0) {
    inputs.migrationTargets = options.migrationTargets;
  }
  if (
    !(inputs.migrationHandling || needsPrompt) &&
    options.defaultFinish === "ship"
  ) {
    inputs.migrationHandling = "ask-after-review";
  }
  return inputs;
};

// Writes under the lock setup already uses: the active loop's mutation lease
// when a loop runs, otherwise the loop state lock of the repository.
const withSetupWriteLock = async <T>(
  repositoryPath: string,
  commonGitDirectory: string,
  agentId: string | undefined,
  operation: string,
  write: () => T
): Promise<T> => {
  const activeLoop = readLoopLease(repositoryPath);
  if (activeLoop) {
    return (
      await withLoopMutationLease(
        repositoryPath,
        activeLoop.runId,
        requireCliOption(
          agentId,
          "--agent-id while an integration loop is active"
        ),
        operation,
        write
      )
    ).result;
  }
  return withLoopStateLock(commonGitDirectory, operation, write);
};

const AUTHORING_EXCLUSIVE_INPUTS = SETUP_INPUT_KEYS.filter(
  (key) => key !== "scope"
);

/**
 * `setup --authoring <json-or-@path> --scope <repository|personal> --confirm`
 * records the authoring answer as its own transaction: only the sidecar is
 * written, independent of the guidance acknowledgement.
 */
const runAuthoringSetup = async (
  options: CliOptions,
  answerText: string
): Promise<void> => {
  const mixed = AUTHORING_EXCLUSIVE_INPUTS.filter(
    (key) => options[key] !== undefined
  );
  if (mixed.length > 0) {
    throw new SimpleChangesError(
      `setup --authoring is a standalone transaction; record ${mixed.join(", ")} in a separate setup.`,
      EXIT_CODES.usage
    );
  }
  if (options.scope !== "repository" && options.scope !== "user") {
    throw new SimpleChangesError(
      "setup --authoring requires --scope repository or --scope personal; a run-only answer writes nothing.",
      EXIT_CODES.usage
    );
  }
  if (!options.yes) {
    throw new SimpleChangesError(
      "setup --authoring requires --confirm before writing.",
      EXIT_CODES.usage
    );
  }
  const answer = parseAuthoringAnswer(answerText);
  const { repository } = captureInventory(options.repo);
  const scope = options.scope === "user" ? "personal" : "repository";
  const recorded = await withSetupWriteLock(
    options.repo,
    repository.commonGitDirectory,
    options.agentId,
    "authoring setup write",
    () =>
      recordAuthoringAnswer({
        answer,
        primaryCheckout: repository.primaryCheckout,
        scope,
      })
  );
  const after = resolveRepositoryAuthoring(repository.primaryCheckout);
  writeOutput(
    {
      authoring: { path: recorded.path, scope, written: recorded.written },
      authoringQuestion: after.authoringQuestion,
      summary: recorded.summary,
    },
    options.json,
    `${recorded.summary}\n`
  );
};

// Detection and pre-fill for the interactive authoring questions; none when
// the harness data file is unreadable (the questions are then skipped).
const interactiveAuthoringContext = (
  primaryCheckout: string | null
): Omit<AuthoringOnboardingContext, "setupStyle"> | null => {
  try {
    const definitions = loadHarnessDefinitions();
    const { detected, running } = detectHarnesses(definitions);
    return {
      definitions,
      detected,
      prefill: changelogsHarnessPrefill(primaryCheckout),
      runningHarness: running,
    };
  } catch (error) {
    // Failed detection is not an empty result: say so instead of skipping.
    process.stderr.write(
      `Skipping the authoring questions, and recording none: ${(error as Error).message}\n`
    );
    return null;
  }
};

const runSetup = async (options: CliOptions): Promise<void> => {
  if (options.authoring !== undefined) {
    await runAuthoringSetup(options, options.authoring);
    return;
  }
  const context = setupContext(options.repo);
  const instructionTargets = options.scope
    ? discoverInstructionTargets(
        options.scope,
        context.primaryCheckout,
        options.instructionFile
      )
    : [];
  const needsPrompt = setupNeedsPrompt(
    options,
    context.changelog.relevant,
    instructionTargets.length,
    changelogInstallOfferApplies(context.changelog)
  );
  if (needsPrompt && !process.stdin.isTTY) {
    throw new SimpleChangesError(
      "Interactive setup requires a terminal. Supply --finish, --questions, --scope, --git-push-authorization for every pushing finish, --production and --shipping-mode when shipping, --migration-handling and --migration-target for automatic migration apply, --changelog when relevant, --changelog-install after offering the Simple Changelogs install when changelog work is relevant but no compatible provider is installed, --ui-versioning with --ui-artifacts, --instruction-pointer when an instruction file exists, --handoff when adding the pointer, --instruction-file when selecting among targets, and --yes.",
      EXIT_CODES.usage
    );
  }
  if (
    !process.stdin.isTTY &&
    options.gitPushAuthorization === "configure-harness" &&
    !options.acknowledgePushScope
  ) {
    throw new SimpleChangesError(
      "Non-interactive automatic Git push setup requires --acknowledge-push-scope after reviewing that it covers only ordinary git push to one verified repository and remote and grants no credentials, network, force-push, protection-bypass, proposal, merge, deploy, or other-destination authority.",
      EXIT_CODES.usage
    );
  }
  const inputs = buildOnboardingInputs(options, needsPrompt);
  const interactive = createCliPrompter(options);
  try {
    const selection = await collectOnboardingSelection(
      context.policy,
      inputs,
      interactive.prompter,
      context.changelog,
      context.primaryCheckout,
      options.uiArtifacts,
      {
        authoring: process.stdin.isTTY
          ? interactiveAuthoringContext(context.primaryCheckout)
          : null,
        existingPersonalDefaults: context.existingPersonalDefaults,
        forgeProvider: context.forgeProvider,
        showFirstScreen: process.stdin.isTTY,
      }
    );
    const path = setupPolicyPath(selection.scope, context.primaryCheckout);
    const written = selection.confirmed && path !== null;
    // Setup never asks about `execGuard`; rewriting a policy keeps its guard.
    const policy =
      written && path
        ? withSavedExecGuard(path, selection.policy)
        : selection.policy;
    // The authoring answer is saved beside the policy for the same scope;
    // run-only setup asked but writes nothing.
    let authoringWrite: { path: string; written: boolean } | null = null;
    const authoringTarget =
      selection.confirmed && selection.authoring && selection.scope !== "run"
        ? (() => {
            const paths = authoringPaths(
              context.primaryCheckout ?? options.repo
            );
            return selection.scope === "repository"
              ? paths.repository
              : paths.personal;
          })()
        : null;
    const applyWrites = (): {
      instructionPointerChanged: boolean;
      instructionPointerWritten: boolean;
    } => {
      if (authoringTarget && selection.authoring) {
        authoringWrite = writeAuthoringSidecar(
          authoringTarget,
          selection.authoring,
          selection.scope === "user"
        );
      }
      let instructionPointerWritten = false;
      let instructionPointerChanged = false;
      if (
        selection.confirmed &&
        selection.instructionPointer.action === "add" &&
        selection.instructionPointer.target
      ) {
        const pointerResult = writeInstructionPointer(
          selection.instructionPointer.target,
          selection.policy.handoffTiming
        );
        instructionPointerWritten = pointerResult.written;
        instructionPointerChanged = pointerResult.changed;
      }
      if (written && path) {
        writePolicyFile(path, policy, selection.scope === "user");
        if (selection.scope === "repository" && context.primaryCheckout) {
          writeRepositoryPolicyTrustReceipt(
            context.primaryCheckout,
            locateRepository(context.primaryCheckout).repository
              .commonGitDirectory,
            "confirmed-setup-user",
            "User confirmed these exact consequential repository settings in Simple Changes setup."
          );
        }
      }
      return { instructionPointerChanged, instructionPointerWritten };
    };
    const activeLoop = context.primaryCheckout
      ? readLoopLease(options.repo)
      : null;
    let writeResult: ReturnType<typeof applyWrites>;
    if (activeLoop) {
      writeResult = (
        await withLoopMutationLease(
          options.repo,
          activeLoop.runId,
          requireCliOption(
            options.agentId,
            "--agent-id while an integration loop is active"
          ),
          "setup write",
          applyWrites
        )
      ).result;
    } else if (context.primaryCheckout) {
      // The loop's state lock, which the mutation lease also holds: a policy
      // and its trust receipt never land inside an acknowledgement's checks.
      writeResult = withLoopStateLock(
        locateRepository(context.primaryCheckout).repository.commonGitDirectory,
        "setup write",
        applyWrites
      );
    } else {
      writeResult = applyWrites();
    }
    const result = {
      // `authoring` is the persistence receipt (null for run-only, which
      // writes nothing); `authoringAnswer` is the confirmed answer itself,
      // which a run-only setup applies to the current request only.
      authoring: authoringWrite,
      authoringAnswer: selection.confirmed ? selection.authoring : null,
      changelogCoordination: context.changelog,
      changelogInstall: selection.changelogInstall,
      confirmed: selection.confirmed,
      instructionPointer: {
        ...selection.instructionPointer,
        changed: writeResult.instructionPointerChanged,
        written: writeResult.instructionPointerWritten,
      },
      path,
      policy,
      scope: selection.scope,
      setupStyle: selection.setupStyle,
      summary: selection.summary,
      uiArtifactsRelevant: options.uiArtifacts,
      written,
    };
    const outcome = setupOutcome(selection.confirmed, written, path);
    writeOutput(result, options.json, `${selection.summary}\n\n${outcome}\n`);
  } finally {
    interactive.close();
  }
};

const appendSimpleChangesUpdate = (
  lines: string[],
  status: InitializationStatus,
  combinedUpdate: boolean
): void => {
  if (status.guidanceUpdate.status !== "update-available") {
    return;
  }
  const update = status.guidanceUpdate;
  const appendQuestion = (
    heading: string,
    question: (typeof update.requiredAnswers)[number]
  ): void => {
    lines.push("", heading, question.question, question.reason, "Choose one:");
    for (const choice of question.choices) {
      lines.push(`- ${choice.label}: ${choice.description}`);
    }
  };
  lines.push(
    "",
    update.headline,
    "Your existing settings, repository files, and current work have not been changed."
  );
  for (const question of update.requiredAnswers) {
    appendQuestion("Answer required before continuing:", question);
  }
  for (const question of update.recommendedChanges) {
    appendQuestion("Recommended change:", question);
  }
  if (update.requiredAnswers.length === 0) {
    lines.push(
      "",
      update.recommendedChanges.length === 0
        ? "No new settings answers are required."
        : "No answer is mandatory; the recommendation above is optional."
    );
  }
  lines.push("", "What matters:");
  for (const summary of update.summaryBullets) {
    lines.push(`- ${summary}`);
  }
  if (!combinedUpdate) {
    if (update.requiredAnswers.length > 0) {
      lines.push(
        "",
        "Resolve the required answers above first. Afterward, Simple Changes will offer the short summary, expanded walkthrough, or full release notes."
      );
    } else {
      const recommended = (action: GuidanceUpdateAction): string =>
        update.recommendedAction === action ? " (Recommended)" : "";
      lines.push(
        "",
        update.walkthroughQuestion,
        "Choose one:",
        `- Continue with current settings${recommended("keep-current-settings")}: ${update.actionDescriptions["keep-current-settings"]}`,
        `- Short walkthrough${recommended("review-settings")}: ${update.actionDescriptions["review-settings"]}`,
        `- Expanded walkthrough: ${update.actionDescriptions["expanded-walkthrough"]}`,
        `- View full release notes: ${update.actionDescriptions["view-release-notes"]}`,
        `- Decide later: ${update.actionDescriptions.defer}`
      );
    }
  }
  lines.push(`Release notes: ${update.releaseNotes.command}`);
};

const appendSimpleChangelogsUpdate = (
  lines: string[],
  status: InitializationStatus,
  combinedUpdate: boolean
): void => {
  const update = status.changelogCoordination.guidanceUpdate;
  if (update.status !== "update-available") {
    return;
  }
  lines.push("", update.headline);
  for (const summary of update.summaryBullets) {
    lines.push(`- ${summary}`);
  }
  lines.push(
    "Simple Changelogs owns the practical update summary, settings review, and any history decision.",
    "Its saved settings and released history have not been changed."
  );
  if (!combinedUpdate) {
    lines.push(
      update.walkthroughQuestion,
      "Choose one:",
      "- Walk me through it: Explain the recent Simple Changelogs updates.",
      "- Continue for now: Leave its settings and released history unchanged.",
      "- View full release notes: Show its owner-controlled update details."
    );
  }
  if (update.detailsPath) {
    lines.push(`Release notes: ${update.detailsPath}`);
  }
  if (status.changelogRequired) {
    lines.push(
      "Resolve this owner-controlled update before starting the Simple Changes shipment loop."
    );
  }
};

const appendCombinedUpdateChoice = (
  lines: string[],
  status: InitializationStatus
): void => {
  if (
    status.guidanceUpdate.status !== "update-available" ||
    status.changelogCoordination.guidanceUpdate.status !== "update-available"
  ) {
    return;
  }
  const actionRequired =
    status.guidanceUpdate.requiredAnswers.length > 0 ||
    status.changelogRequired;
  lines.push(
    "",
    actionRequired
      ? "Resolve the required update choice before continuing."
      : "No new Simple Changes setting answer is required.",
    "How would you like to continue?",
    "Choose one:",
    actionRequired
      ? "- Resolve required choices (Recommended): Ask only the unanswered multiple-choice questions, starting with the recommended answer."
      : "- Continue with current settings (Recommended): Acknowledge both updates without changing confirmed choices.",
    "- Short walkthrough: Show only required answers, recommended changes, and the main practical improvements.",
    "- Expanded walkthrough: Explain every intervening behavior, example, consequence, setting, and safety boundary.",
    "- View full release notes: Show the detailed owner-controlled notes for both skills.",
    "- Decide later: Leave the update unresolved and ask again next time."
  );
};

const appendFirstUseWalkthroughOffer = (
  lines: string[],
  status: InitializationStatus
): void => {
  const nonblockingFirstUseMode = ["preview", "pause", "sync"].includes(
    status.mode
  );
  if (
    status.firstUseWalkthroughAvailable &&
    !status.onboardingRequired &&
    nonblockingFirstUseMode
  ) {
    lines.push(
      "",
      "New to Simple Changes? I can give you a quick walkthrough of everything it can do."
    );
  }
};

const renderTurnEndGuard = (
  guard: NonNullable<InitializationStatus["turnEndGuard"]>
): string => {
  if (guard.current) {
    return `Turn-end guard: installed for ${guard.harness}`;
  }
  const state = guard.installed ? "outdated" : "not installed";
  return guard.installCommand
    ? `Turn-end guard: ${state} for ${guard.harness}; with the user's agreement, run \`${guard.installCommand}\``
    : `Turn-end guard: ${state} for ${guard.harness}; this copy cannot be installed from here, so install it from the globally installed Simple Changes`;
};

const describeReviewer = (
  reviewer: NonNullable<InitializationStatus["reviewer"]>
): string => {
  const target = reviewer.harness
    ? `${reviewer.model ?? "unknown model"} in ${reviewer.harness} at ${reviewer.effort ?? "unknown effort"}${reviewer.effortSource === "escalation" ? " (escalated after findings)" : ""}`
    : "no target";
  const reason = reviewer.reason ? `, ${reviewer.reason}` : "";
  return `Reviewer (${reviewer.mode}${reviewer.adversarial ? ", different author model or agent required" : ""}): ${reviewer.status}, ${target}${reason}`;
};

// The authoring preference state: pending questions, a sidecar to repair, and
// the resolved reviewer the pre-ship brief names.
const appendAuthoring = (
  lines: string[],
  status: InitializationStatus
): void => {
  for (const error of status.authoringErrors ?? []) {
    lines.push(
      `Authoring data error: ${error} Detection reports nothing and no authoring answer can be recorded until the package is reinstalled.`
    );
  }
  const question = status.authoringQuestion;
  if (question) {
    const pending = Object.entries(question)
      .filter(([, state]) => state === "pending" || state === "repair")
      .map(([id, state]) => `${id} ${state}`);
    if (pending.length > 0) {
      lines.push(
        `Authoring questions: ${pending.join(", ")}; see references/onboarding.md ("Agents, models, and reviews").`
      );
    }
  }
  const review = status.authoringReviewQuestion;
  if (review) {
    lines.push(
      "",
      review.question,
      ...review.choices.map(
        (choice) =>
          `- ${choice.label}${choice.recommended && !choice.label.includes("Recommended") ? " (Recommended)" : ""}: ${choice.description}`
      ),
      "Record the answer with `simple-changes setup --authoring` (references/onboarding.md)."
    );
  }
  if (status.reviewer) {
    lines.push(describeReviewer(status.reviewer));
  }
  const requested = requestedAuthoringFields(status);
  if (requested.length > 0) {
    lines.push(
      `Authoring request applied to this invocation only (nothing saved): ${requested.join(", ")}.`
    );
  }
};

// The fields the current request supplied (`--authoring-request`), so a
// run-only answer that changed the reviewer or tightened the gate is visible.
const requestedAuthoringFields = (status: InitializationStatus): string[] => {
  const source = status.authoring?.source;
  if (!source) {
    return [];
  }
  const fields: string[] = [];
  for (const [role, layers] of Object.entries(source)) {
    for (const [field, layer] of Object.entries(layers)) {
      if (layer === "request") {
        fields.push(`${role}.${field}`);
      }
    }
  }
  return fields;
};

const renderInitialization = (status: InitializationStatus): string => {
  const lines = [
    "Simple Changes initialization",
    `Mode: ${status.mode}`,
    `Write-capable: ${status.writeCapable ? "yes" : "no"}`,
    `Mutation allowed: ${status.mutationAllowed ? "yes" : "no"}`,
    `Policy: ${status.policySource}`,
    `Policy trust: ${status.policyTrust}`,
    `Production deploy: ${status.productionDeploy}`,
    `Changelog coordination: ${
      status.changelogCoordination.relevant ? "relevant" : "not detected"
    }`,
    `Changelog capability: ${describeChangelogCapability(
      status.changelogCoordination
    )}`,
    `Simple Changes update: ${status.guidanceUpdate.status}`,
    `Simple Changelogs update: ${status.changelogCoordination.guidanceUpdate.status}`,
    `Changelog required for this request: ${status.changelogRequired ? "yes" : "no"}`,
    `Action required before loop start: ${status.preLoopActionRequired ? "yes" : "no"}`,
    `Onboarding required: ${status.onboardingRequired ? "yes" : "no"}`,
    `First-use walkthrough available: ${status.firstUseWalkthroughAvailable ? "yes" : "no"}`,
    `Migration handling: ${status.migrationHandling}`,
    `Automatic migration targets: ${status.migrationTargets.length > 0 ? status.migrationTargets.map((target) => `${target.provider}:${target.project}:${target.environment}`).join(", ") : "none"}`,
    `Handoff action: ${status.handoffAction}`,
    `Reason: ${status.reason}`,
  ];
  if (status.turnEndGuard) {
    lines.push(renderTurnEndGuard(status.turnEndGuard));
  }
  if (status.runtimeFreshness?.message) {
    lines.push(`Warning: ${status.runtimeFreshness.message}`);
  }
  if (status.handoffClaimRelease) {
    lines.push(
      `Released worktree claim ${status.handoffClaimRelease.claimId} on ${status.handoffClaimRelease.path}; this finished work is now shippable by any controller.`
    );
  }
  if (status.policyTrust === "untrusted") {
    lines.push(
      "Repository policy requests consequential authority but has not been confirmed on this clone; running with reduced authority until setup confirms it."
    );
  }
  if (status.inferredDefaultFinish) {
    lines.push(`Inferred finish: ${status.inferredDefaultFinish}`);
  }
  if (status.resolvedMode) {
    lines.push(`Resolved mode: ${status.resolvedMode}`);
  }
  const combinedUpdate =
    status.guidanceUpdate.status === "update-available" &&
    status.changelogCoordination.guidanceUpdate.status === "update-available";
  appendSimpleChangesUpdate(lines, status, combinedUpdate);
  appendSimpleChangelogsUpdate(lines, status, combinedUpdate);
  appendCombinedUpdateChoice(lines, status);
  appendFirstUseWalkthroughOffer(lines, status);
  appendAuthoring(lines, status);
  return `${lines.join("\n")}\n`;
};

// Reported, never installed, by initialize: a Stop hook is persistent harness
// configuration the user agrees to first. Unreadable settings report nothing.
const initializationTurnEndGuard = (): InitializationStatus["turnEndGuard"] => {
  const harness = currentHarnessSession()?.harness;
  if (!harness) {
    return null;
  }
  try {
    const script = hookInstallScript(SCRIPT_FILE, VERSION);
    const status = stopHookStatus(
      harness,
      script ?? SCRIPT_FILE,
      VERSION,
      false
    );
    return {
      current: status.current,
      harness,
      installCommand: script
        ? `${shellWord(process.execPath)} ${shellWord(script)} harness stop-hook --harness ${harness} --write`
        : null,
      installed: status.installed,
      path: status.path,
    };
  } catch {
    return null;
  }
};

const AUTHORING_MODES = new Set<InitializationMode>([
  "handoff",
  "queue",
  "sweep",
  "integrate",
  "ship",
  "reconcile",
  "resume",
]);

// Authoring preferences for initialization: Preview, Pause, guarded Sync and
// read-only modes are not applicable (onboarding runs only for write-capable
// requests other than Sync), and no setup style is in progress, so the review
// question follows the recommended column of the truth table.
const initializationAuthoring = (
  primaryCheckout: string,
  mode: InitializationMode,
  request: AuthoringSidecar | null
): {
  fields: Pick<
    InitializationStatus,
    | "authoring"
    | "authoringErrors"
    | "authoringFiles"
    | "authoringQuestion"
    | "authoringReviewQuestion"
    | "detectedHarnesses"
  >;
  guidanceContext: GuidanceUpdateContext;
  resolution: RepositoryAuthoring;
} => {
  const resolution = resolveRepositoryAuthoring(primaryCheckout, {
    request,
    writeCapable: AUTHORING_MODES.has(mode),
  });
  const questions: GuidanceUpdateContext["questions"] = {};
  if (resolution.authoringQuestion.review === "pending") {
    try {
      const question = authoringReviewNoticeQuestion({
        definitions: loadHarnessDefinitions(),
        detected: resolution.detectedHarnesses,
        modelsPending: resolution.authoringQuestion.models === "pending",
        recordedHarnesses: [
          resolution.authoringFiles.repository,
          resolution.authoringFiles.personal,
        ].flatMap((file) => Object.keys(file.value?.harnesses ?? {})),
        runningHarness: resolution.runningHarness,
      });
      if (question) {
        questions["authoring-review"] = question;
      }
    } catch {
      // A broken harness data file leaves the notice without the question.
    }
  }
  return {
    fields: {
      authoring: { effective: resolution.effective, source: resolution.source },
      authoringErrors: resolution.harnessDataError
        ? [resolution.harnessDataError]
        : [],
      authoringFiles: resolution.authoringFiles,
      authoringQuestion: resolution.authoringQuestion,
      // Asked at every write-capable initialization while it is pending,
      // whatever the guidance version: acknowledgement never answers it.
      authoringReviewQuestion: questions["authoring-review"] ?? null,
      detectedHarnesses: resolution.detectedHarnesses,
    },
    guidanceContext: {
      authoringQuestion: resolution.authoringQuestion,
      detectedHarnesses: resolution.detectedHarnesses,
      questions,
    },
    resolution,
  };
};

const runInitialize = async (options: CliOptions): Promise<void> => {
  if (!options.mode) {
    throw new SimpleChangesError(
      "initialize requires --mode",
      EXIT_CODES.usage
    );
  }
  if (options.ready && options.mode !== "handoff") {
    throw new SimpleChangesError(
      "--ready is valid only with --mode handoff",
      EXIT_CODES.usage
    );
  }
  // The request layer is validated before anything is read or changed: an
  // invalid --authoring-request is a usage error that leaves every claim
  // where it was.
  const authoringRequest =
    options.authoringRequest === undefined
      ? null
      : parseAuthoringRequest(options.authoringRequest);
  const inventory = captureInventory(options.repo);
  const activeLoop = readLoopLease(options.repo);
  if (activeLoop && !["preview", "pause", "handoff"].includes(options.mode)) {
    const agentId = requireCliOption(
      options.agentId,
      "--agent-id while an integration loop is active"
    );
    guardLoopMutation(options.repo, activeLoop.runId, agentId);
  }
  const changelogCoordination = inspectChangelogCoordination(
    inventory.repository.primaryCheckout
  );
  const authoring = initializationAuthoring(
    inventory.repository.primaryCheckout,
    options.mode,
    authoringRequest
  );
  const inspected = inspectInitialization(
    options.mode,
    inventory.policy,
    changelogCoordination,
    {
      changelogRequired: options.changelogRequired,
      guidanceContext: authoring.guidanceContext,
      readinessConfirmed: options.ready,
    }
  );
  // Resolved before anything changes: an invalid --proposal or --head is a
  // usage error that must leave the handoff claim where it was.
  const reviewer = resolveReviewer({
    authoring: authoring.resolution,
    repositoryRoot: inventory.repository.primaryCheckout,
    ...(options.proposalId === undefined
      ? {}
      : { proposalId: options.proposalId }),
    ...(options.headRef === undefined ? {} : { head: options.headRef }),
  });
  // A proceeding handoff declares the current checkout finished: release the
  // author's own claim there so the work becomes an ordinary stable unit that
  // any controller may ship, instead of a concurrent-author exclusion.
  const handoffClaimRelease =
    inspected.handoffAction === "proceed" && options.agentId
      ? releaseHandoffWorktreeClaim(options.repo, options.agentId)
      : null;
  const status = validateSchema<InitializationStatus>("initialization", {
    ...inspected,
    ...authoring.fields,
    changelogInstall: pendingChangelogInstallOffer(changelogCoordination),
    handoffClaimRelease: handoffClaimRelease
      ? { claimId: handoffClaimRelease.claimId, path: handoffClaimRelease.path }
      : null,
    reviewer,
    runtimeFreshness: runtimeFreshness(
      {
        targetRef: inventory.targetRef,
        worktreePaths: inventory.worktrees.map((worktree) => worktree.path),
      },
      VERSION,
      SCRIPT_FILE
    ),
    turnEndGuard: initializationTurnEndGuard(),
  });
  if (!status.onboardingRequired) {
    writeOutput(status, options.json, renderInitialization(status));
    return;
  }
  const setupOptions: CliOptions = {
    ...options,
    ...(status.inferredDefaultFinish
      ? { defaultFinish: status.inferredDefaultFinish }
      : {}),
  };
  if (
    process.stdin.isTTY ||
    !setupNeedsPrompt(
      setupOptions,
      changelogCoordination.relevant,
      setupOptions.scope
        ? discoverInstructionTargets(
            setupOptions.scope,
            inventory.repository.primaryCheckout,
            setupOptions.instructionFile
          ).length
        : 0,
      changelogInstallOfferApplies(changelogCoordination)
    )
  ) {
    await runSetup(setupOptions);
    return;
  }
  writeOutput(status, options.json, renderInitialization(status));
};

const runAcknowledgeUpdate = async (options: CliOptions): Promise<void> => {
  const disposition = requireCliOption(
    options.guidanceDecision,
    "--guidance-decision"
  ) as RepoPolicy["guidance"]["disposition"];
  const inventory = captureInventory(options.repo);
  if (!(inventory.policy.path && inventory.policy.source !== "default")) {
    throw new SimpleChangesError(
      "No saved Simple Changes policy exists; finish first-use setup instead of acknowledging an update.",
      EXIT_CODES.usage
    );
  }
  const previousVersion = inventory.policy.value.guidance.version;
  // Edit only the saved guidance values. The loaded policy is default-filled
  // and, when unconfirmed, trust-reduced; writing it back changes settings.
  const guidance = acknowledgedGuidance(disposition);
  let written = false;
  const applyWrite = (): void => {
    written = writeGuidanceAcknowledgement(
      inventory.policy.path as string,
      guidance,
      inventory.policy.source === "repository"
        ? {
            commonGitDirectory: inventory.repository.commonGitDirectory,
            primaryCheckout: inventory.repository.primaryCheckout,
            source: "repository",
          }
        : { source: "user" }
    );
  };
  const activeLoop = readLoopLease(options.repo);
  if (activeLoop) {
    await withLoopMutationLease(
      options.repo,
      activeLoop.runId,
      requireCliOption(
        options.agentId,
        "--agent-id while an integration loop is active"
      ),
      "guidance update acknowledgement",
      applyWrite
    );
  } else {
    // Setup saves a policy and its receipt under this same lock, so neither
    // can land between this acknowledgement's checks and its write.
    withLoopStateLock(
      inventory.repository.commonGitDirectory,
      "guidance update acknowledgement",
      applyWrite
    );
  }
  const result = {
    currentVersion: CURRENT_GUIDANCE_VERSION,
    disposition,
    path: inventory.policy.path,
    previousVersion,
    source: inventory.policy.source,
    written,
  };
  writeOutput(
    result,
    options.json,
    written
      ? `Recorded Simple Changes guidance ${CURRENT_GUIDANCE_VERSION} as ${disposition} in ${inventory.policy.path}.\n`
      : `Simple Changes guidance ${CURRENT_GUIDANCE_VERSION} is already recorded as ${disposition} in ${inventory.policy.path}; nothing was written.\n`
  );
};

const runValidation = (options: CliOptions): void => {
  const [schemaName, filename] = options.positional;
  if (!(schemaName && filename)) {
    throw new SimpleChangesError(
      "validate requires KIND and FILE",
      EXIT_CODES.usage
    );
  }
  const value = JSON.parse(readFileSync(resolve(filename), "utf8")) as unknown;
  const validated = validateSchema(schemaName as SchemaName, value);
  writeOutput(
    { schema: schemaName, valid: true, value: validated },
    options.json,
    `${filename} is valid ${schemaName} data.\n`
  );
};

const migrationDecisionForOptions = (
  options: CliOptions
): {
  commonGitDirectory: string;
  decision: MigrationAutomationDecision;
} => {
  const reviewPath = requireCliOption(options.statePath, "--state");
  const pendingPath = requireCliOption(options.pendingPath, "--pending");
  const applyPlanPath = requireCliOption(options.applyPlanPath, "--apply-plan");
  const review = validateSchema<MigrationReview>(
    "migration-review",
    readJsonFile(reviewPath)
  );
  const pending = validateSchema<MigrationOperationSet>(
    "migration-pending",
    readJsonFile(pendingPath)
  );
  const applyPlan = validateSchema<MigrationApplyPlan>(
    "migration-apply-plan",
    readJsonFile(applyPlanPath)
  );
  for (const operation of pending.operations) {
    const safePath = assertSafeRelativePath(options.repo, operation.revision);
    if (safePath.symlink) {
      throw new SimpleChangesError(
        `Pending migration revision contains a symlink: ${operation.revision}`,
        EXIT_CODES.validation
      );
    }
    const actualDigest = createHash("sha256")
      .update(readFileSync(safePath.absolutePath))
      .digest("hex");
    if (actualDigest !== operation.contentDigest) {
      throw new SimpleChangesError(
        `Pending migration content changed after evidence capture: ${operation.revision}`,
        EXIT_CODES.validation
      );
    }
  }
  const inventory = captureInventory(options.repo);
  const policy = inventory.policy.value;
  const decision = decideMigrationAutomation(
    policy,
    review,
    pending,
    applyPlan
  );
  if (
    decision.action === "auto-apply" &&
    decision.authorizationDigest &&
    migrationAuthorizationConsumed(
      inventory.repository.commonGitDirectory,
      decision.authorizationDigest
    )
  ) {
    throw new SimpleChangesError(
      "This migration authorization has already been consumed; regenerate fresh pending, review, ledger, nonce, and command evidence.",
      EXIT_CODES.unsafe
    );
  }
  return {
    commonGitDirectory: inventory.repository.commonGitDirectory,
    decision,
  };
};

const runMigrationCommand = (options: CliOptions): void => {
  const [action] = options.positional;
  if (action !== "decision") {
    throw new SimpleChangesError(
      `Unknown migration action: ${action ?? "(missing)"}`,
      EXIT_CODES.usage
    );
  }
  const { decision } = migrationDecisionForOptions(options);
  writeOutput(
    decision,
    options.json,
    `${decision.action}: ${decision.reason}\n`
  );
};

const runMigrationApplyCommand = (options: CliOptions): void => {
  const { commonGitDirectory, decision } = migrationDecisionForOptions(options);
  assertShipHoldsClear(
    checkShipHolds(options.repo, {
      ...holdReadOptions(options),
      action: "migrations",
    })
  );
  if (
    decision.authorizationDigest &&
    migrationAuthorizationConsumed(
      commonGitDirectory,
      decision.authorizationDigest
    )
  ) {
    throw new SimpleChangesError(
      "This migration authorization has already been consumed.",
      EXIT_CODES.unsafe
    );
  }
  const result = applyMigrationAuthorization(
    commonGitDirectory,
    options.repo,
    decision
  );
  writeOutput(
    result,
    options.json,
    `Applied migration authorization ${decision.authorizationDigest}.\n`
  );
};

const runPermissionCommand = (options: CliOptions): void => {
  const [action, filename] = options.positional;
  if (action !== "bundle" || !filename) {
    throw new SimpleChangesError(
      "permissions requires bundle REQUESTS_FILE",
      EXIT_CODES.usage
    );
  }
  const input = readJsonFile(filename);
  if (!Array.isArray(input)) {
    throw new SimpleChangesError(
      "Permission bundle input must be an array of exact request objects.",
      EXIT_CODES.validation
    );
  }
  const bundle = buildPermissionBundle(input);
  writeOutput(bundle, options.json, `${renderPermissionBundle(bundle)}\n`);
};

const readJsonFile = (filename: string): unknown =>
  JSON.parse(readFileSync(resolve(filename), "utf8")) as unknown;

const runChangelogNegotiation = (options: CliOptions): void => {
  const [filename] = options.positional;
  if (!filename) {
    throw new SimpleChangesError(
      "negotiate-changelog requires CAPABILITIES_FILE",
      EXIT_CODES.usage
    );
  }
  const result = negotiateChangelogProtocol(readJsonFile(filename));
  writeOutput(
    result,
    options.json,
    result.compatible
      ? `Negotiated changelog request v${result.requestVersion} and receipt v${result.receiptVersion} (schema digests: ${result.schemaDigestStatus}).\n`
      : `Changelog negotiation failed: ${result.reasonCode} (${result.requiredAction}).\n`
  );
  if (!result.compatible) {
    throw new SimpleChangesError(
      "Changelog protocol negotiation failed",
      EXIT_CODES.validation
    );
  }
};

const runReleaseGate = (options: CliOptions): void => {
  const requestPath = requireCliOption(options.requestPath, "--request");
  const receiptPath = requireCliOption(options.receiptPath, "--receipt");
  const productionDeploy = requireCliOption(
    options.productionDeploy,
    "--production"
  ) as RepoPolicy["productionDeploy"];
  const decision = decideReleaseGate({
    alreadyLive: options.alreadyLive,
    ...(options.priorReceiptPath === undefined
      ? {}
      : {
          priorReceipt: readJsonFile(
            options.priorReceiptPath
          ) as ChangelogReceipt,
        }),
    productionAuthorized: options.productionAuthorized,
    productionDeploy,
    receipt: readJsonFile(receiptPath) as ChangelogReceipt,
    request: readJsonFile(requestPath) as ChangelogRequest,
    versionAuthorized: options.versionAuthorized,
  });
  writeOutput(
    decision,
    options.json,
    `Release gate: ${decision.action}${decision.selectedVersion ? ` (version ${decision.selectedVersion})` : ""}. ${decision.reason}\n`
  );
};

const RELEASE_TAG_SUMMARIES: Record<ReleaseTagReceipt["status"], string> = {
  "already-present": "is already published",
  blocked: "is blocked",
  created: "was created and pushed",
  "not-applicable": "does not apply",
  ready: "is ready",
};

const renderReleaseTag = (receipt: ReleaseTagReceipt): string => {
  const lines = [
    `Release tag ${receipt.name ?? `for ${receipt.releaseTrain}`} ${RELEASE_TAG_SUMMARIES[receipt.status]}${receipt.reasonCode ? ` (${receipt.reasonCode}; ${receipt.requiredAction})` : ""}.`,
  ];
  if (receipt.reason) {
    lines.push(receipt.reason);
  }
  if (receipt.manualCommands.length > 0) {
    lines.push("To publish it yourself:", ...receipt.manualCommands);
  }
  if (receipt.ciConfigurationFiles.length > 0) {
    lines.push(
      `CI configuration at the target (a reminder; review what a tag push starts): ${receipt.ciConfigurationFiles.join(", ")}`
    );
  }
  return `${lines.join("\n")}\n`;
};

// Exit 0 for ready, created, already-present, and not-applicable; a blocked
// tag exits 5 so the deployment it gates cannot proceed by accident.
const runReleaseTagCommand = async (options: CliOptions): Promise<number> => {
  const receipt = await runReleaseTag({
    agentId: requireCliOption(options.agentId, "--agent-id"),
    alreadyLive: options.alreadyLive,
    dryRun: options.dryRun,
    ...(options.priorReceiptPath === undefined
      ? {}
      : { priorReceipt: readJsonFile(options.priorReceiptPath) }),
    productionAuthorized: options.productionAuthorized,
    productionDeploy: requireCliOption(
      options.productionDeploy,
      "--production"
    ) as RepoPolicy["productionDeploy"],
    receipt: readJsonFile(requireCliOption(options.receiptPath, "--receipt")),
    repositoryPath: options.repo,
    request: readJsonFile(requireCliOption(options.requestPath, "--request")),
    runId: requireCliOption(options.runId, "--run-id"),
    tagAutomationAuthorized: options.tagAutomationAuthorized,
  });
  writeOutput(receipt, options.json, renderReleaseTag(receipt));
  return receipt.status === "blocked" ? EXIT_CODES.unsafe : EXIT_CODES.success;
};

const runProposalSignatures = (options: CliOptions): void => {
  const agent = requireCliOption(options.agentName, "--agent");
  const role = requireCliOption(
    options.signatureRole,
    "--role"
  ) as ProposalSignatureRole;
  if ((options.baseRef === undefined) !== (options.headRef === undefined)) {
    throw new SimpleChangesError(
      "--base and --head must be given together",
      EXIT_CODES.usage
    );
  }
  const changelogPaths =
    options.changelogReceiptPath === undefined
      ? []
      : (
          validateSchema<ChangelogReceipt>(
            "changelog-receipt",
            readJsonFile(options.changelogReceiptPath)
          ).paths ?? []
        ).map((entry) => entry.path);
  const result = buildProposalSignatureBlock({
    changelogPaths,
    repositoryPath: options.repo,
    self: { agent, role },
    ...(options.baseRef !== undefined && options.headRef !== undefined
      ? { baseRef: options.baseRef, headRef: options.headRef }
      : {}),
  });
  writeOutput(result, options.json, `${result.block}\n`);
};

const runReleaseDelivery = (options: CliOptions): void => {
  const changelogReceiptPath = requireCliOption(
    options.changelogReceiptPath,
    "--changelog-receipt"
  );
  const providerReceiptPath = requireCliOption(
    options.providerReceiptPath,
    "--provider-receipt"
  );
  const receipt = buildReleaseDeliveryReceipt({
    changelogReceipt: readJsonFile(changelogReceiptPath),
    providerReceipt: readJsonFile(providerReceiptPath),
    ...(options.requestPath === undefined
      ? {}
      : { request: readJsonFile(options.requestPath) }),
  });
  writeOutput(
    receipt,
    options.json,
    `Release delivery ${receipt.status}: ${receipt.releaseTrain} ${receipt.version} finalized at ${receipt.finalizedTargetRevision}, deployed revision ${receipt.deployedRevision ?? "unobserved"}${receipt.reasonCode ? ` (${receipt.reasonCode}; ${receipt.requiredAction})` : ""}.\n`
  );
  if (receipt.status !== "complete") {
    throw new SimpleChangesError(
      `Release delivery is ${receipt.status}: ${receipt.requiredAction}`,
      EXIT_CODES.validation
    );
  }
};

const runChangelogTransactionValidation = (options: CliOptions): void => {
  const [requestFilename, receiptFilename] = options.positional;
  if (!(requestFilename && receiptFilename)) {
    throw new SimpleChangesError(
      "validate-changelog-transaction requires REQUEST_FILE and RECEIPT_FILE",
      EXIT_CODES.usage
    );
  }
  const { priorReceiptDigestStatus, receipt } = inspectChangelogTransaction(
    readJsonFile(requestFilename),
    readJsonFile(receiptFilename),
    options.priorReceiptPath === undefined
      ? undefined
      : readJsonFile(options.priorReceiptPath)
  );
  writeOutput(
    { priorReceiptDigestStatus, receipt, valid: true },
    options.json,
    `${receiptFilename} matches ${requestFilename} (prior receipt digest: ${priorReceiptDigestStatus}).\n`
  );
};

// Receipts v3 from one multi-train release set, each already validated against
// its own request, checked together for one number per version line.
const runChangelogReleaseSetValidation = (options: CliOptions): void => {
  if (options.positional.length < 2) {
    throw new SimpleChangesError(
      "validate-changelog-release-set requires at least two RECEIPT_FILE arguments",
      EXIT_CODES.usage
    );
  }
  const result = validateChangelogReleaseSet(
    options.positional.map((filename) => readJsonFile(filename))
  );
  writeOutput(
    { ...result, valid: true },
    options.json,
    `${result.receipts} receipts agree for release set ${result.releaseSetId}${result.lines
      .map(
        (line) =>
          `; ${line.members.join(", ")} at ${line.selectedVersion ?? "no selected version yet"}`
      )
      .join("")}${
      result.missingTrains.length > 0
        ? `; no receipt yet for ${result.missingTrains.join(", ")}`
        : ""
    }.\n`
  );
};

const runMarkdownAudit = (options: CliOptions): void => {
  const [filename] = options.positional;
  if (!filename) {
    throw new SimpleChangesError(
      "verify-markdown requires FILE",
      EXIT_CODES.usage
    );
  }
  const audit = auditMarkdown(readFileSync(resolve(filename), "utf8"));
  writeOutput(
    audit,
    options.json,
    audit.valid
      ? `${filename} contains valid multiline Markdown.\n`
      : `${filename}: ${audit.issues.join(" ")}\n`
  );
  if (!audit.valid) {
    throw new SimpleChangesError(
      "Markdown audit failed",
      EXIT_CODES.validation
    );
  }
};

type ProposalAuditReport = ProposalAudit & {
  file: string;
  template: string | null;
};

const renderProposalAudit = (report: ProposalAuditReport): string =>
  report.valid
    ? `${report.file} matches the proposal body shape (door: ${report.door ?? "no Merge danger section"}; signature block: ${report.signatureBlock}).\n`
    : `${report.file} does not match the proposal body shape:\n${report.issues
        .map((issue) => `- ${issue}`)
        .join("\n")}\n`;

const renderGaps = (gaps: Record<string, CommitGaps>): string =>
  Object.entries(gaps)
    .map(
      ([commit, gap]) =>
        `Gap on ${commit}: unresolved sources [${gap.unresolvedSources.join(", ")}], uncovered edits [${gap.uncoveredEdits.join(", ")}]\n`
    )
    .join("");

const renderRecordedAuthors = (result: RecordAuthorsResult): string =>
  `${result.status === "unchanged" ? "Already recorded" : "Recorded"} authors for ${result.proposalId} at ${result.head} (${result.commits.length} commits, ${result.fullyCovered ? "fully covered" : "partial coverage"}).\nAuthors digest: ${result.authorsDigest}\n${
    result.unattributed.length > 0
      ? `Unattributed: ${result.unattributed.join(", ")}\n`
      : ""
  }${renderGaps(result.gaps)}`;

// Acceptance when the attempt was recorded is history; whether it counts now
// is decided again against the current head, digest, coverage and settings.
const renderRecordedReview = (result: RecordReviewResult): string => {
  const { attempt, currentValidity } = result;
  const recorded = `${result.status === "unchanged" ? "Already recorded" : "Recorded"} review attempt ${attempt.attemptId} at ${attempt.headRevision}: verdict ${attempt.verdict}, ${
    attempt.accepted
      ? "accepted when recorded"
      : `not accepted when recorded (${attempt.acceptanceReason})`
  }.`;
  let now = "Now: does not count toward approval (its verdict is not clean).";
  if (!currentValidity.valid) {
    now = `Now: does not count (${currentValidity.reason}); ask the owner before reviewing again.`;
  } else if (result.approvalCandidate) {
    now = "Now: counts toward approval of this head.";
  }
  return `${recorded}\n${now}\n${result.disclosure.message ? `Disclosure: ${result.disclosure.message}\n` : ""}`;
};

const renderWaiver = (result: WaiveCoverageResult): string =>
  `${result.status === "unchanged" ? "Already recorded" : "Recorded"} coverage waiver ${result.waiver.waiverId} by ${result.waiver.approvedBy}, bound to ${result.waiver.authorsDigest}.\n${
    result.covers
      ? "It covers every outstanding item on this head.\n"
      : `Still outstanding: ${result.outstanding.unattributed.join(", ") || "no unattributed commits"}\n${renderGaps(result.outstanding.gaps)}`
  }`;

const runProposalLedgerCommand = (
  action: string,
  options: CliOptions
): void => {
  const proposalId = requireCliOption(options.proposalId, "--proposal");
  const head = requireCliOption(options.headRef, "--head");
  // Validated before the receipt is read: an invalid request is a usage
  // error before anything else happens.
  const request =
    options.authoringRequest === undefined
      ? undefined
      : parseAuthoringRequest(options.authoringRequest);
  if (action === "record-authors") {
    const result = recordProposalAuthors({
      base: requireCliOption(options.baseRef, "--base"),
      head,
      proposalId,
      repositoryPath: options.repo,
      ...(options.receiptPath === undefined
        ? {}
        : { copyAuthorsReceipt: readJsonFile(options.receiptPath) }),
      ...(options.agentName === undefined ? {} : { agent: options.agentName }),
      ...(options.instanceId === undefined
        ? {}
        : { instance: options.instanceId }),
    });
    writeOutput(result, options.json, renderRecordedAuthors(result));
    return;
  }
  const receipt = readJsonFile(
    requireCliOption(options.receiptPath, "--receipt")
  );
  if (action === "record-review") {
    const result = recordReviewAttempt({
      attemptId: requireCliOption(options.attemptId, "--attempt-id"),
      head,
      proposalId,
      receipt,
      repositoryPath: options.repo,
      ...(request === undefined ? {} : { request }),
    });
    writeOutput(result, options.json, renderRecordedReview(result));
    return;
  }
  const result = waiveProposalCoverage({
    authorsDigest: requireCliOption(options.authorsDigest, "--authors-digest"),
    head,
    proposalId,
    receipt,
    repositoryPath: options.repo,
  });
  writeOutput(result, options.json, renderWaiver(result));
};

const renderAttestation = (result: AuthorAttestResult): string => {
  const who = `${result.identity.logicalId} (${result.identity.agent ?? "model not reported"}, harness ${result.identity.harness ?? "not reported"}, session ${result.identity.session ?? "not reported"})`;
  const lines = result.attestations.map(
    ({ commit, status }) =>
      `${status === "not-attested" ? "Not attested (replay only)" : `Attested (${status})`}: ${commit} for ${who}`
  );
  const { replay } = result;
  if (replay) {
    lines.push(
      `Replay ${replay.status}: ${replay.destination} from ${replay.sources.join(", ")} is ${replay.verification} (${replay.detail}).`
    );
    if (replay.ownGaps.uncoveredEdit) {
      lines.push(
        "The replay is inconclusive and nobody attested an edit on it: if you changed the implementation, attest it with --contribution implementation."
      );
    }
    if (replay.ownGaps.unresolvedSources.length > 0) {
      lines.push(
        `Sources with no attested author: ${replay.ownGaps.unresolvedSources.join(", ")}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

// `author attest` is a public command that takes the loop lock itself, so it
// runs after `loop exec` returns and never inside it.
const runAuthorCommand = (options: CliOptions): void => {
  if (options.positional.length !== 1 || options.positional[0] !== "attest") {
    throw new SimpleChangesError("author requires attest", EXIT_CODES.usage);
  }
  const result = attestCommits({
    commits: options.commits,
    repositoryPath: options.repo,
    ...(options.agentId === undefined ? {} : { logicalId: options.agentId }),
    ...(options.agentName === undefined ? {} : { agent: options.agentName }),
    ...(options.instanceId === undefined
      ? {}
      : { instance: options.instanceId }),
    ...(options.sessionId === undefined ? {} : { session: options.sessionId }),
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.contribution === undefined
      ? {}
      : { contribution: options.contribution }),
    ...(options.replays === undefined ? {} : { replays: options.replays }),
    ...(options.worktreePath === undefined
      ? {}
      : { worktreePath: options.worktreePath }),
  });
  writeOutput(result, options.json, renderAttestation(result));
};

const PROPOSAL_LEDGER_ACTIONS = new Set([
  "record-authors",
  "record-review",
  "waive-coverage",
]);

// The audit is a check: its report goes to stdout either way, and a failing
// body exits with the validation code instead of an error message.
const runProposalCommand = (options: CliOptions): number => {
  const [action] = options.positional;
  // Checked before any subcommand runs, the audit included.
  if (options.authoringRequest !== undefined && action !== "record-review") {
    throw new SimpleChangesError(
      "--authoring-request applies to proposal record-review only.",
      EXIT_CODES.usage
    );
  }
  if (
    options.positional.length === 1 &&
    action !== undefined &&
    PROPOSAL_LEDGER_ACTIONS.has(action)
  ) {
    runProposalLedgerCommand(action, options);
    return EXIT_CODES.success;
  }
  if (options.positional.length !== 1 || action !== "audit") {
    throw new SimpleChangesError(
      "proposal requires audit, record-authors, record-review, or waive-coverage",
      EXIT_CODES.usage
    );
  }
  const file = requireCliOption(options.filePath, "--file");
  const template = options.templatePath;
  const report = validateSchema<ProposalAuditReport>("proposal-audit", {
    file,
    template: template ?? null,
    ...auditProposalBody({
      body: readFileSync(resolve(file), "utf8"),
      template:
        template === undefined
          ? undefined
          : readFileSync(resolve(template), "utf8"),
    }),
  });
  writeOutput(report, options.json, renderProposalAudit(report));
  return report.valid ? EXIT_CODES.success : EXIT_CODES.validation;
};

const renderSkillCheck = (report: SkillCheckReport): string =>
  report.valid
    ? `${report.name} at ${report.skillDirectory} passes the skill check: frontmatter, invocation parity, and ${report.linksChecked} relative links.\n`
    : `${report.skillDirectory} fails the skill check:\n${report.issues
        .map((issue) => `- ${issue.path}: ${issue.message}`)
        .join("\n")}\n`;

// Without --skill-dir, check the skill that ships this runtime, which is how a
// fork checks itself.
const runSkillCommand = (options: CliOptions): number => {
  if (options.positional.length !== 1 || options.positional[0] !== "check") {
    throw new SimpleChangesError("skill requires check", EXIT_CODES.usage);
  }
  const report = checkSkill(
    options.skillDirectory === undefined
      ? (skillRootOf(SCRIPT_FILE) ?? PACKAGE_ROOT)
      : resolve(options.skillDirectory)
  );
  writeOutput(report, options.json, renderSkillCheck(report));
  return report.valid ? EXIT_CODES.success : EXIT_CODES.validation;
};

const requireCliOption = (
  value: string | undefined,
  option: string
): string => {
  if (!value?.trim()) {
    throw new SimpleChangesError(
      `${option} is required for this command`,
      EXIT_CODES.usage
    );
  }
  return value;
};

const renderLoopVerification = (
  result: ReturnType<typeof verifyLoop>
): string => {
  const lines = [
    `Active loop: ${result.active ? "yes" : "no"}`,
    `Run: ${result.runId ?? "none"}`,
    `Manifest: ${result.ok ? "clean" : "blocked"}`,
  ];
  for (const violation of result.violations) {
    lines.push(
      `- ${violation.code}: ${violation.path} (${violation.changeDigest ?? "no digest"})`
    );
  }
  return `${lines.join("\n")}\n`;
};

// `loop status` lists the same commands in its guidance.
const renderViolationNextCommands = (
  result: ReturnType<typeof verifyLoop>
): string =>
  staleClaimRecoveryCommands(result.violations)
    .map((command) => `  Next: ${command}\n`)
    .join("");

const runLoopRecovery = (options: CliOptions): void => {
  if (options.staleLease) {
    const receipt = recoverStaleLoopLease(
      options.repo,
      requireCliOption(options.runId, "--run-id"),
      requireCliOption(options.agentId, "--agent-id"),
      requireCliOption(options.approvedBy, "--approved-by"),
      requireCliOption(options.reason, "--reason")
    );
    writeOutput(
      receipt,
      options.json,
      `Cleared stale lease ${receipt.runId} (last heartbeat ${receipt.liveness.lastUpdatedAt}) and archived it in the run history.\nEvery worktree, branch, claim, and receipt was preserved: ${receipt.preservedWorktreePaths.length} registered checkout(s) are untouched.\n`
    );
    return;
  }
  const recovery = recoverLoopLock(
    options.repo,
    requireCliOption(options.agentId, "--agent-id")
  );
  writeOutput(
    recovery,
    options.json,
    `Recovered dead active-loop lock owned by PID ${recovery.staleOwner.pid}.\n`
  );
};

const runLoopExec = async (
  options: CliOptions,
  runId: string,
  agentId: string,
  turnEnd: string
): Promise<void> => {
  const result = await executeLoopMutation(
    options.repo,
    runId,
    agentId,
    options.positional.slice(1)
  );
  if (options.json) {
    writeOutput({ ...result, turnEnd }, true, "");
    return;
  }
  if (result.result.stdout) {
    process.stdout.write(result.result.stdout);
  }
  if (result.result.stderr) {
    process.stderr.write(result.result.stderr);
  }
  process.stdout.write(
    `Loop mutation completed under ${runId}; manifest is clean.\n${turnEnd}\n`
  );
};

const runLoopFinalizationAction = (
  action: string,
  options: CliOptions,
  runId: string,
  agentId: string
): boolean => {
  if (action === "accept-paused-change") {
    const updated = acceptPausedWorktreeChange(
      options.repo,
      runId,
      agentId,
      requireCliOption(options.pauseReceiptId, "--pause-receipt")
    );
    writeOutput(
      { lease: updated, manifestDigest: loopManifestDigest(updated) },
      options.json,
      `Accepted the exact owner-paused state into ${runId}.\n`
    );
    return true;
  }
  if (action === "reconcile-remote-branches") {
    const receiptPath = requireCliOption(options.receiptPath, "--receipt");
    const receipt = JSON.parse(
      readFileSync(resolve(receiptPath), "utf8")
    ) as unknown;
    const updated = recordRemoteBranchReconciliation(
      options.repo,
      runId,
      agentId,
      receipt
    );
    writeOutput(
      { lease: updated, manifestDigest: loopManifestDigest(updated) },
      options.json,
      `Recorded a complete GitLab remote-branch reconciliation for ${updated.remoteBranchReconciliation.project}.\nManifest: ${loopManifestDigest(updated)}\n`
    );
    return true;
  }
  if (action === "end") {
    const ended = endLoop(options.repo, runId, agentId, options.reason ?? null);
    writeOutput(
      ended,
      options.json,
      ended.closedWithoutMutation
        ? `Closed ${runId} without changing anything; it owed no shipment scope, reconciliation, or cleanup. Start a fresh loop for a new baseline.\nReceipt: ${ended.closedWithoutMutation.receiptPath}\n`
        : `Ended ${runId} after a clean manifest verification.\n`
    );
    return true;
  }
  if (action === "finalize") {
    const result = finalizeLoop(
      options.repo,
      runId,
      agentId,
      requireCliOption(options.reason, "--reason"),
      { awaitingUser: options.awaitingUser }
    );
    if (result.outcome === "relinquished" && options.awaitingUser.length > 0) {
      writeOutput(
        {
          ...result,
          manifestDigest: result.lease
            ? loopManifestDigest(result.lease)
            : null,
        },
        options.json,
        `Paused ${runId} until the user answers: ${options.awaitingUser.join(" | ")}\nWhen they answer, resume it with \`simple-changes loop start --mode resume --agent-id <you>\`; its scope and safety checks stay in force.\n`
      );
      return true;
    }
    if (result.outcome === "relinquished") {
      throw new SimpleChangesError(
        `Relinquished ${runId} with durable state; the shipment is incomplete. Automatic cleanup normalized ${result.cleanup.cleanedPrimaryPaths.length} target-equivalent primary path(s), removed ${result.cleanup.removedWorktrees.length} worktree(s) and ${result.cleanup.removedBranches.length} branch(es), pruned ${result.cleanup.prunedWorktreeMetadata} stale worktree record(s), and released ${result.cleanup.releasedClaims.length} finished or orphaned worktree claim(s). Remaining: ${result.blockers.join(" ")}`,
        EXIT_CODES.unsafe
      );
    }
    if (result.closedWithoutMutation) {
      writeOutput(
        { ...result, manifestDigest: null },
        options.json,
        `Closed ${runId} without changing anything: the repository changed after the loop started, so its shipment scope could not be recorded. Start a fresh loop for a new baseline.\nReceipt: ${result.closedWithoutMutation.receiptPath}\n`
      );
      return true;
    }
    writeOutput(
      {
        ...result,
        manifestDigest: result.lease ? loopManifestDigest(result.lease) : null,
      },
      options.json,
      `Completed and released ${runId}. Normalized ${result.cleanup.cleanedPrimaryPaths.length} target-equivalent primary path(s), removed ${result.cleanup.removedWorktrees.length} worktree(s) and ${result.cleanup.removedBranches.length} branch(es); pruned ${result.cleanup.prunedWorktreeMetadata} stale worktree record(s); released ${result.cleanup.releasedClaims.length} finished or orphaned worktree claim(s).\n`
    );
    return true;
  }
  return false;
};

const runLoopEmergencyAction = async (
  options: CliOptions,
  runId: string
): Promise<boolean> => {
  if (options.positional[0] !== "emergency") {
    return false;
  }
  if (options.positional[1] === "status") {
    const status = emergencyShippingStatus(options.repo, runId);
    writeOutput(
      status,
      options.json,
      `${status.decision.action}: ${status.decision.reason}\n`
    );
    return true;
  }
  if (options.positional[1] === "record") {
    const agentId = requireCliOption(options.agentId, "--agent-id");
    const statePath = requireCliOption(options.statePath, "--state");
    const result = await recordEmergencyShipping(
      options.repo,
      runId,
      agentId,
      readJsonFile(statePath)
    );
    const { decision } = emergencyShippingStatus(options.repo, runId);
    writeOutput(
      { decision, state: result.result, verification: result.verification },
      options.json,
      `${decision.action}: ${decision.reason}\n`
    );
    return true;
  }
  throw new SimpleChangesError(
    "loop emergency requires status or record",
    EXIT_CODES.usage
  );
};

const runLoopTakeover = (
  action: string,
  options: CliOptions,
  runId: string,
  agentId: string
): boolean => {
  if (action !== "takeover") {
    return false;
  }
  const updated = takeoverLoop(
    options.repo,
    runId,
    agentId,
    requireCliOption(options.manifestDigest, "--manifest-digest"),
    requireCliOption(options.approvedBy, "--approved-by"),
    requireCliOption(options.reason, "--reason")
  );
  writeOutput(
    { lease: updated, manifestDigest: loopManifestDigest(updated) },
    options.json,
    `Transferred ${runId} to ${agentId} under explicit takeover authority.\n`
  );
  return true;
};

const runLoopRebaseline = (
  action: string,
  options: CliOptions,
  runId: string,
  agentId: string
): boolean => {
  if (action !== "rebaseline") {
    return false;
  }
  const result = rebaselineLoopWorktrees(
    options.repo,
    runId,
    agentId,
    requireCliOption(options.approvedBy, "--approved-by"),
    requireCliOption(options.reason, "--reason")
  );
  writeOutput(
    { ...result, manifestDigest: loopManifestDigest(result.lease) },
    options.json,
    `Re-baselined ${runId}: registered ${result.rebaseline.registered.length} late worktree(s) as preserved at their exact current state.\nManifest: ${loopManifestDigest(result.lease)}\n${renderLoopVerification(result.verification)}`
  );
  return true;
};

const runLoopStart = (options: CliOptions): void => {
  const agentId = requireCliOption(options.agentId, "--agent-id");
  if (!options.mode) {
    throw new SimpleChangesError(
      "loop start requires --mode",
      EXIT_CODES.usage
    );
  }
  // The request layer is checked and validated before any other input is
  // read: an invalid request is a usage error that changes nothing.
  if (options.authoringRequest !== undefined && options.mode !== "resume") {
    throw new SimpleChangesError(
      "--authoring-request applies to loop start --mode resume only.",
      EXIT_CODES.usage
    );
  }
  const request =
    options.authoringRequest === undefined
      ? undefined
      : parseAuthoringRequest(options.authoringRequest);
  if (options.changelogRequired) {
    const inventory = captureInventory(options.repo);
    const changelogCoordination = inspectChangelogCoordination(
      inventory.repository.primaryCheckout
    );
    const initialization = inspectInitialization(
      options.mode,
      inventory.policy,
      changelogCoordination,
      { changelogRequired: true }
    );
    if (initialization.preLoopActionRequired) {
      throw new SimpleChangesError(
        "Complete Simple Changes initialization and every required update choice before loop start.",
        EXIT_CODES.unsafe
      );
    }
  }
  const openingRemoteInventory = options.openingRemoteInventoryPath
    ? (JSON.parse(
        readFileSync(resolve(options.openingRemoteInventoryPath), "utf8")
      ) as unknown)
    : undefined;
  let reviewLedger: ReviewLedgerResumeState | null = null;
  const lease = startLoop(
    options.repo,
    agentId,
    options.mode as RequestMode,
    openingRemoteInventory,
    {
      onReviewLedger: (state) => {
        reviewLedger = state.state === "absent" ? null : state;
      },
      ...(request === undefined ? {} : { request }),
    }
  );
  const holds = informationalHolds(options.repo);
  const freshness = leaseRuntimeFreshness(lease);
  const resumedQuestions = resumedAwaitingUser(lease);
  writeOutput(
    {
      holds,
      inheritedAwaitingUser: resumedQuestions,
      lease,
      manifestDigest: loopManifestDigest(lease),
      ...(reviewLedger ? { reviewLedger } : {}),
      runtimeFreshness: freshness,
    },
    options.json,
    `Started ${lease.runId} for ${lease.ownerAgentId}.\nManifest: ${loopManifestDigest(lease)}\n${
      resumedQuestions
        ? `The previous controller paused for the user's answer to: ${resumedQuestions.join(" | ")}. Confirm their answer before continuing.\n`
        : ""
    }${renderResumedReviews(reviewLedger)}${renderFreshnessWarning(freshness)}${renderRecordedHolds(holds)}`
  );
};

// Accepted reviews that no longer pass the gate on resume need a fresh review.
const renderResumedReviews = (
  state: ReviewLedgerResumeState | null
): string => {
  if (!state) {
    return "";
  }
  if (state.state === "malformed") {
    return `Warning: the review ledger at ${state.path} is malformed (${state.reason}); no review counts until it is repaired.\n`;
  }
  return state.proposals
    .flatMap((proposal) =>
      proposal.attempts
        .filter((attempt) => attempt.accepted && !attempt.revalidated)
        .map(
          (attempt) =>
            `Review ${attempt.attemptId} of ${proposal.proposalId} no longer counts (${attempt.revalidationReason}); request a fresh review.\n`
        )
    )
    .join("");
};

// A freshly resumed controller sees what its predecessor was waiting on.
const resumedAwaitingUser = (lease: LoopLease): string[] | null => {
  const { controller } = lease;
  const latest = controller?.handoffs.at(-1);
  return latest && latest.at === controller?.acquiredAt
    ? (readControllerBinding(lease)?.inheritedAwaitingUser ?? null)
    : null;
};

const leaseRuntimeFreshness = (lease: LoopLease): RuntimeFreshness =>
  runtimeFreshness(
    {
      targetRef: lease.targetRef,
      worktreePaths: lease.worktrees.map((worktree) => worktree.path),
    },
    VERSION,
    SCRIPT_FILE
  );

const renderFreshnessWarning = (freshness: RuntimeFreshness | null): string =>
  freshness?.message ? `Warning: ${freshness.message}\n` : "";

const runLoopStatus = (options: CliOptions): void => {
  const status = loopStatus(options.repo);
  const guidanceLines = [
    ...(status.liveness
      ? [
          `Liveness: ${status.liveness.state} (last activity ${status.liveness.lastUpdatedAt}; owner process ${status.liveness.ownerProcessProvable ? "running" : "unprovable"}${status.liveness.ownerSessionEnded ? "; owner session has exited" : ""})`,
        ]
      : []),
    status.guidance.headline,
    ...status.guidance.nextCommands.map((command) => `  Next: ${command}`),
  ];
  const holds = informationalHolds(options.repo);
  const freshness = status.lease ? leaseRuntimeFreshness(status.lease) : null;
  writeOutput(
    {
      ...status,
      holds,
      manifestDigest: status.lease ? loopManifestDigest(status.lease) : null,
      runtimeFreshness: freshness,
    },
    options.json,
    `${renderLoopVerification(status.verification)}${guidanceLines.join("\n")}\n${renderFreshnessWarning(freshness)}${renderRecordedHolds(holds)}`
  );
};

const runLoopOpeningAction = (action: string, options: CliOptions): boolean => {
  if (action === "start") {
    runLoopStart(options);
    return true;
  }
  if (action === "status") {
    runLoopStatus(options);
    return true;
  }
  if (action === "recover") {
    runLoopRecovery(options);
    return true;
  }
  return false;
};

const runLoopCloseEquivalent = (options: CliOptions): void => {
  const evidence: LoopEquivalenceEvidence[] = options.evidencePaths.map(
    (path) => {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        receipt?: unknown;
        worktreePath?: unknown;
      };
      if (typeof parsed.worktreePath !== "string" || !parsed.receipt) {
        throw new SimpleChangesError(
          `--evidence file ${path} must contain { "worktreePath": "...", "receipt": <worktree-equivalence result> }`,
          EXIT_CODES.usage
        );
      }
      return { receipt: parsed.receipt, worktreePath: parsed.worktreePath };
    }
  );
  const result = closeLoopTargetEquivalent(
    options.repo,
    requireCliOption(options.runId, "--run-id"),
    requireCliOption(options.agentId, "--agent-id"),
    requireCliOption(options.approvedBy, "--approved-by"),
    requireCliOption(options.reason, "--reason"),
    evidence
  );
  writeOutput(
    result,
    options.json,
    `Closed ${result.runId} as target-equivalent: the registered work is already contained in the target, so nothing shipped and only proven-safe local cleanup ran.\n`
  );
};

const runLoopRecoveryAction = (
  action: string,
  options: CliOptions
): boolean => {
  if (action === "replan-status") {
    const status = loopReplanStatus(options.repo);
    writeOutput(status, options.json, `${JSON.stringify(status, null, 2)}\n`);
    return true;
  }
  if (action === "replan" || action === "archive-recorded") {
    const result = replanLoop(options.repo, {
      ...(action === "archive-recorded"
        ? { archiveRecordedOutcome: true as const }
        : {}),
      agentId: requireCliOption(options.agentId, "--agent-id"),
      approvedBy: requireCliOption(options.approvedBy, "--approved-by"),
      manifestDigest: requireCliOption(
        options.manifestDigest,
        "--manifest-digest"
      ),
      reason: requireCliOption(options.reason, "--reason"),
      runId: requireCliOption(options.runId, "--run-id"),
      statusDigest: requireCliOption(options.statusDigest, "--status-digest"),
    });
    writeOutput(
      result,
      options.json,
      result.outcome === "archived-unfinished"
        ? `Archived ${result.request.runId} (${result.outcome}); this transition did not ship or clean work. All historical receipts are preserved. Start a fresh loop through the normal workflow and reconcile current provider state.\n`
        : `Replanned ${result.request.runId}; the original lease is archived, this transition did not ship or clean work. Start a fresh loop through the normal workflow.\n`
    );
    return true;
  }
  if (action === "close-equivalent") {
    runLoopCloseEquivalent(options);
    return true;
  }
  if (action === "recover-post-cleanup") {
    const result = recoverPostCleanupLoop(
      options.repo,
      requireCliOption(options.runId, "--run-id"),
      requireCliOption(options.agentId, "--agent-id"),
      JSON.parse(
        readFileSync(
          resolve(requireCliOption(options.receiptPath, "--receipt")),
          "utf8"
        )
      ) as unknown
    );
    writeOutput(
      result,
      options.json,
      "Cleanup was already complete; Simple Changes repaired and closed its old bookkeeping record.\n"
    );
    return true;
  }
  return false;
};

const runLoopVerifyAction = (
  action: string,
  options: CliOptions,
  turnEnd: string
): boolean => {
  if (action !== "verify") {
    return false;
  }
  const verification = verifyLoop(options.repo);
  // `--for` names the shipping step about to run, so holds covering it gate
  // the same verification every controller already runs before that step.
  const holds = options.holdAction
    ? checkShipHolds(options.repo, {
        action: options.holdAction,
        localOnly: options.localOnly,
        remote: options.remoteName,
      })
    : null;
  writeOutput(
    { ...verification, ...(holds ? { holds } : {}), turnEnd },
    options.json,
    `${renderLoopVerification(verification)}${renderViolationNextCommands(verification)}${holds ? renderHoldReport(holds) : ""}${turnEnd}\n`
  );
  if (!verification.ok) {
    throw new SimpleChangesError(
      "Active-loop manifest verification failed.",
      EXIT_CODES.unsafe
    );
  }
  if (holds) {
    assertShipHoldsClear(holds);
  }
  return true;
};

const HOOK_INPUT_TIMEOUT_MS = 2000;

const readHookInput = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    return "";
  }
  return await Promise.race([
    stdin.text(),
    sleep(HOOK_INPUT_TIMEOUT_MS).then(() => ""),
  ]);
};

/**
 * Run as a harness Stop hook, this never fails the harness: any error allows
 * the turn to end, and the process exits explicitly so an unread stdin cannot
 * keep it alive. Run directly, it reports what this session still controls.
 */
const runLoopTurnCheck = async (options: CliOptions): Promise<void> => {
  if (!options.hook) {
    const result = turnCheck({ sessionId: null, stopHookActive: false });
    writeOutput(
      result,
      options.json,
      result.decision === "allow"
        ? "No Simple Changes run is waiting on this session to finalize.\n"
        : `${result.reason}\n`
    );
    return;
  }
  let output = "";
  try {
    output = turnCheckHookOutput(
      turnCheck(parseTurnCheckHookInput(await readHookInput()))
    );
  } catch {
    output = "";
  }
  if (output) {
    writeSync(1, output);
  }
  process.exit(0);
};

const runLoopCommand = async (options: CliOptions): Promise<void> => {
  const [action] = options.positional;
  if (!action) {
    throw new SimpleChangesError(
      "loop requires start, status, verify, record-scope, refresh-scope, record-outcome, guard, exec, recover, recover-post-cleanup, close-equivalent, replan-status, replan, archive-recorded, takeover, rebaseline, allow, dispose-worktree, retain-worktree, retire-absent-worktree, adopt-worktree, accept-paused-change, reconcile-remote-branches, emergency, end, finalize, or turn-check",
      EXIT_CODES.usage
    );
  }
  if (runLoopOpeningAction(action, options)) {
    return;
  }
  if (runLoopRecoveryAction(action, options)) {
    return;
  }
  const runId = requireCliOption(options.runId, "--run-id");
  const lease = readLoopLease(options.repo);
  if (!lease || lease.runId !== runId) {
    throw new SimpleChangesError(
      `Active loop does not match ${runId}.`,
      EXIT_CODES.unsafe
    );
  }
  if (runLoopVerifyAction(action, options, turnEndReminder(lease))) {
    return;
  }
  if (await runLoopEmergencyAction(options, runId)) {
    return;
  }
  const agentId = requireCliOption(options.agentId, "--agent-id");
  if (action === "record-scope" || action === "refresh-scope") {
    const receipt = recordShipmentScope(
      options.repo,
      runId,
      agentId,
      readJsonFile(requireCliOption(options.receiptPath, "--receipt")),
      action === "refresh-scope"
    );
    writeOutput(receipt, options.json, `${receipt.summary}\n`);
    return;
  }
  if (action === "record-outcome") {
    const outcome = recordShipmentOutcome(
      options.repo,
      runId,
      agentId,
      readJsonFile(requireCliOption(options.receiptPath, "--receipt")),
      {
        approvalReference: options.approvalReference,
        approvedBy: options.approvedBy,
      }
    );
    writeOutput(outcome, options.json, `${outcome.summary}\n`);
    return;
  }
  if (runLoopTakeover(action, options, runId, agentId)) {
    return;
  }
  if (runLoopRebaseline(action, options, runId, agentId)) {
    return;
  }
  if (action === "guard") {
    const verification = guardLoopMutation(options.repo, runId, agentId);
    const turnEnd = turnEndReminder(lease);
    writeOutput(
      { ...verification, turnEnd },
      options.json,
      `Mutation guard passed for ${agentId} in ${lease.runId}.\n${turnEnd}\n`
    );
    return;
  }
  if (action === "exec") {
    await runLoopExec(options, runId, agentId, turnEndReminder(lease));
    return;
  }
  if (action === "allow") {
    const updated = grantLoopOverride(
      options.repo,
      runId,
      agentId,
      requireCliOption(options.worktreePath, "--worktree"),
      requireCliOption(options.statusDigest, "--status-digest"),
      requireCliOption(options.approvedBy, "--approved-by"),
      requireCliOption(options.reason, "--reason")
    );
    writeOutput(
      { lease: updated, manifestDigest: loopManifestDigest(updated) },
      options.json,
      `Recorded an exact override for ${options.worktreePath}.\nManifest: ${loopManifestDigest(updated)}\n`
    );
    return;
  }
  if (action === "dispose-worktree") {
    const updated = authorizeWorktreeRemoval(
      options.repo,
      runId,
      agentId,
      requireCliOption(options.worktreePath, "--worktree"),
      requireCliOption(options.statusDigest, "--status-digest"),
      requireCliOption(options.approvedBy, "--approved-by"),
      requireCliOption(options.reason, "--reason")
    );
    writeOutput(
      { lease: updated, manifestDigest: loopManifestDigest(updated) },
      options.json,
      `Recorded an audited removal disposition for ${options.worktreePath}.\nManifest: ${loopManifestDigest(updated)}\n`
    );
    return;
  }
  if (action === "retire-absent-worktree") {
    const updated = retireAbsentWorktree(
      options.repo,
      runId,
      agentId,
      requireCliOption(options.worktreePath, "--worktree"),
      requireCliOption(options.approvedBy, "--approved-by"),
      requireCliOption(options.reason, "--reason")
    );
    writeOutput(
      { lease: updated, manifestDigest: loopManifestDigest(updated) },
      options.json,
      `Retired absent worktree ${options.worktreePath}; nothing was deleted and no delivery was proven.\nManifest: ${loopManifestDigest(updated)}\n`
    );
    return;
  }
  if (action === "retain-worktree") {
    const updated = retainExcludedWorktree(
      options.repo,
      runId,
      agentId,
      requireCliOption(options.worktreePath, "--worktree"),
      requireCliOption(options.statusDigest, "--status-digest"),
      requireCliOption(options.approvedBy, "--approved-by"),
      requireCliOption(options.reason, "--reason")
    );
    writeOutput(
      { lease: updated, manifestDigest: loopManifestDigest(updated) },
      options.json,
      `Retained ${options.worktreePath} as an exact unchanged exclusion from this shipment.\nManifest: ${loopManifestDigest(updated)}\n`
    );
    return;
  }
  if (action === "adopt-worktree") {
    const updated = adoptPausedWorktree(
      options.repo,
      runId,
      agentId,
      requireCliOption(options.pauseReceiptId, "--pause-receipt")
    );
    writeOutput(
      { lease: updated, manifestDigest: loopManifestDigest(updated) },
      options.json,
      `Adopted the exact paused worktree into ${runId} as preserved state.\n`
    );
    return;
  }
  if (runLoopFinalizationAction(action, options, runId, agentId)) {
    return;
  }
  throw new SimpleChangesError(
    `Unknown loop action: ${action}`,
    EXIT_CODES.usage
  );
};

const automationSummary = (probe: CoordinationCapabilityProbe): string => {
  if (!probe.automatic) {
    return "manual fallback required";
  }
  if (probe.capabilities.conditions.length > 0) {
    return "available once the host verifies the probe conditions";
  }
  return "available";
};

const runWorktreeRequest = (options: CliOptions): void => {
  const state = readWorktreeCoordination(options.repo);
  const claimId = requireCliOption(options.claimId, "--claim-id");
  const claim = state.claims.find((item) => item.claimId === claimId);
  if (!claim) {
    throw new SimpleChangesError(
      `Unknown worktree claim: ${claimId}`,
      EXIT_CODES.unsafe
    );
  }
  const { requestAction } = options;
  if (!requestAction) {
    throw new SimpleChangesError(
      "--request-action is required for this command",
      EXIT_CODES.usage
    );
  }
  const capabilityProbe = probeCoordinationAdapter(
    claim.owner.adapter,
    claim.owner.ownerRef
  );
  const request = buildCoordinationRequest(
    requestAction,
    claim,
    requireCliOption(options.runId, "--run-id")
  );
  writeOutput(
    { capabilityProbe, request },
    options.json,
    capabilityProbe.automatic
      ? `${request.safeMessage}\n`
      : `${capabilityProbe.blocker?.manualNextAction}\n`
  );
};

const runWorktreeClaim = (options: CliOptions, agentId: string): void => {
  const adapter = requireCliOption(options.adapter, "--adapter");
  const claim = claimWorktree(
    options.repo,
    agentId,
    requireCliOption(options.worktreePath, "--worktree"),
    adapter,
    options.ownerRef
  );
  const capabilityProbe = probeCoordinationAdapter(
    claim.owner.adapter,
    claim.owner.ownerRef
  );
  writeOutput(
    { capabilityProbe, claim },
    options.json,
    `Claimed ${claim.path} as ${claim.claimId}.\nAdapter automation: ${automationSummary(capabilityProbe)}.\n`
  );
};

const runWorktreeMaintenance = (
  action: string,
  options: CliOptions
): boolean => {
  if (action === "refresh-index") {
    const result = refreshWorktreeIndex(options.repo);
    writeOutput(
      result,
      options.json,
      `Refreshed the Git worktree inventory: pruned ${result.prunedPaths.length} stale record(s); ${result.remainingWorktreePaths.length} worktree(s) remain.\n${result.notes.join("\n")}\n`
    );
    return true;
  }
  if (action === "cleanup") {
    const receipt = standaloneWorktreeCleanup({
      agentId: requireCliOption(options.agentId, "--agent-id"),
      approvedBy: requireCliOption(options.approvedBy, "--approved-by"),
      reason: requireCliOption(options.reason, "--reason"),
      repositoryPath: options.repo,
      targetRef: options.targetRef,
    });
    writeOutput(
      receipt,
      options.json,
      `Standalone cleanup ${receipt.cleanupId} vs ${receipt.targetRef}: removed ${receipt.removed.length} proven worktree(s), pruned ${receipt.prunedPaths.length} stale record(s), released ${(receipt.releasedClaims ?? []).length} orphaned claim(s), preserved ${receipt.preserved.length}.\n${receipt.preserved.map((entry) => `- preserved ${entry.path}: ${entry.reason}`).join("\n")}${receipt.preserved.length > 0 ? "\n" : ""}`
    );
    return true;
  }
  return false;
};

const runWorktreeStatus = (options: CliOptions): void => {
  const inventory = captureInventory(options.repo);
  const state = readCoordinationDocumentFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  let readyWork: ReadyWorkStatus[] | { error: string };
  try {
    readyWork = readyWorkStatus(inventory);
  } catch (error) {
    readyWork = { error: (error as Error).message };
  }
  writeOutput(
    { ...state, readyWork },
    options.json,
    `Worktree claims: ${state.claims.length}\nPause receipts: ${state.receipts.length}\n${renderReadyWork(readyWork)}`
  );
};

const runWorktreeReadyRelease = (
  options: CliOptions,
  agentId: string
): void => {
  const readyReceiptPath = requireCliOption(
    options.readyReceiptPath,
    "--ready-receipt"
  );
  const result = recordReadyWork(
    options.repo,
    agentId,
    requireCliOption(options.claimId, "--claim-id"),
    parseReadyWorkInput(readJsonFile(readyReceiptPath))
  );
  writeOutput(
    result,
    options.json,
    `Released ${result.claim.claimId} as ready work ${result.receipt.receiptId} on ${result.receipt.branch} at ${result.receipt.headSha}.\n`
  );
};

const runWorktreeRelease = (options: CliOptions, agentId: string): void => {
  if (options.readyReceiptPath) {
    runWorktreeReadyRelease(options, agentId);
    return;
  }
  const claim = releaseWorktreeClaim(
    options.repo,
    agentId,
    requireCliOption(options.claimId, "--claim-id")
  );
  writeOutput(
    claim,
    options.json,
    `Released ${claim.claimId} without deleting work.\n`
  );
};

const runWorktreeCommand = (options: CliOptions): void => {
  const [action] = options.positional;
  if (!action) {
    throw new SimpleChangesError(
      "worktree requires status, observe, equivalence, refresh-index, cleanup, request, claim, pause, detach, attach, resume-ready, release, or takeover",
      EXIT_CODES.usage
    );
  }
  if (action === "status") {
    runWorktreeStatus(options);
    return;
  }
  if (action === "observe") {
    const observation = observeWorktreeClaims(options.repo);
    writeOutput(
      observation,
      options.json,
      `Worktree claim observation: ${observation.digest}\nActive claims: ${observation.activeClaimCount}\n`
    );
    return;
  }
  if (action === "request") {
    runWorktreeRequest(options);
    return;
  }
  if (action === "equivalence") {
    const report = auditWorktreeEquivalence({
      targetRef: options.targetRef ?? captureInventory(options.repo).targetRef,
      worktreePath: requireCliOption(options.worktreePath, "--worktree"),
    });
    writeOutput(
      report,
      options.json,
      `Equivalence vs ${report.targetRef}: ${report.equivalence} (${report.commits.length} commits, ${report.paths.length} dirty paths audited).\n${report.disclaimer}\n`
    );
    return;
  }
  if (runWorktreeMaintenance(action, options)) {
    return;
  }
  const agentId = requireCliOption(options.agentId, "--agent-id");
  if (action === "claim") {
    runWorktreeClaim(options, agentId);
    return;
  }
  if (action === "pause") {
    const receipt = pauseClaimedWorktree(
      options.repo,
      agentId,
      requireCliOption(options.worktreePath, "--worktree"),
      requireCliOption(options.runId, "--run-id"),
      options.disposition ??
        (() => {
          throw new SimpleChangesError(
            "--disposition is required for this command",
            EXIT_CODES.usage
          );
        })(),
      requireCliOption(options.reason, "--reason")
    );
    writeOutput(
      receipt,
      options.json,
      `Paused exact worktree state as ${receipt.receiptId}.\n`
    );
    return;
  }
  if (action === "detach") {
    const claim = detachClaimedWorktree(
      options.repo,
      agentId,
      requireCliOption(options.worktreePath, "--worktree"),
      requireCliOption(options.pauseReceiptId, "--pause-receipt")
    );
    writeOutput(
      claim,
      options.json,
      `Detached ${claim.path}; branch ${claim.branch} remains at ${claim.headSha}.\n`
    );
    return;
  }
  if (action === "attach") {
    const claim = attachClaimedWorktree(
      options.repo,
      agentId,
      requireCliOption(options.claimId, "--claim-id")
    );
    writeOutput(
      claim,
      options.json,
      `Attached ${claim.path} on ${claim.branch}.\n`
    );
    return;
  }
  if (action === "resume-ready") {
    const result = markWorktreeResumeReady(
      options.repo,
      requireCliOption(options.runId, "--run-id"),
      agentId,
      requireCliOption(options.claimId, "--claim-id")
    );
    writeOutput(
      result,
      options.json,
      `Marked ${result.claimId} resume-ready at ${result.targetRef} ${result.targetSha}.\n`
    );
    return;
  }
  if (action === "release") {
    runWorktreeRelease(options, agentId);
    return;
  }
  if (action === "takeover") {
    const result = takeoverWorktreeClaim({
      action: options.releaseClaim ? "release" : "reassign",
      approvedBy: requireCliOption(options.approvedBy, "--approved-by"),
      claimId: requireCliOption(options.claimId, "--claim-id"),
      expectedStatusDigest: requireCliOption(
        options.statusDigest,
        "--status-digest"
      ),
      newAgentId: agentId,
      reason: requireCliOption(options.reason, "--reason"),
      repositoryPath: options.repo,
    });
    writeOutput(
      result,
      options.json,
      options.releaseClaim
        ? `Released stale claim ${result.receipt.claimId} with audit receipt ${result.receipt.takeoverId}; the worktree itself is untouched.\n`
        : `Reassigned claim ${result.receipt.claimId} to ${agentId} with audit receipt ${result.receipt.takeoverId}; the worktree itself is untouched.\n`
    );
    return;
  }
  throw new SimpleChangesError(
    `Unknown worktree action: ${action}`,
    EXIT_CODES.usage
  );
};

const renderReadyWork = (
  readyWork: readonly ReadyWorkStatus[] | { error: string }
): string =>
  "error" in readyWork
    ? `Ready-work receipts: unreadable (${readyWork.error})\n`
    : [
        `Ready-work receipts: ${readyWork.length}`,
        ...readyWork.map(
          (item) =>
            `- ${item.receipt.branch} (${item.receipt.owner.agentId}) ${item.freshness}: ${item.receipt.scope}`
        ),
        "",
      ].join("\n");

// Loop start and status only list recorded holds: they must keep working when
// the holds file is unreadable, and the `--for` gates do the full evaluation.
const informationalHolds = (
  repositoryPath: string
): RecordedShipHolds | { error: string } => {
  try {
    return recordedShipHolds(repositoryPath);
  } catch (error) {
    return { error: (error as Error).message };
  }
};

const renderRecordedHolds = (
  holds: RecordedShipHolds | { error: string }
): string => {
  if ("error" in holds) {
    return `Shipment holds: unreadable (${holds.error}); gates fail closed until this is fixed.\n`;
  }
  if (holds.active.length === 0) {
    return "";
  }
  return `${[
    `Shipment holds: ${holds.active.length} recorded here; run loop verify --for <step> before each covered step.`,
    ...holds.active.map(
      (hold) =>
        `- ${hold.holdId}: ${hold.severity} ${hold.scope} by ${hold.owner.agentId}: ${hold.reason}`
    ),
  ].join("\n")}\n`;
};

const REMOTE_HOLD_SUMMARIES: Record<
  ShipHoldReport["remote"]["status"],
  (report: ShipHoldReport) => string
> = {
  "no-remote": () => "no target remote",
  read: (report) =>
    `${report.remote.refCount} published on ${report.remote.name}`,
  skipped: () => "remote not read",
  unavailable: (report) =>
    `unreadable on ${report.remote.name}: ${report.remote.error}`,
};

const renderHoldReport = (report: ShipHoldReport): string => {
  const remote = REMOTE_HOLD_SUMMARIES[report.remote.status](report);
  const lines = [
    report.action
      ? `Shipment holds for ${report.action}: ${report.clear ? "clear" : "blocked"} (${remote})`
      : `Shipment holds: ${report.active.length} active (${remote})`,
    ...report.holds.map(
      (item) =>
        `- ${item.hold.holdId} ${item.status}: ${item.hold.severity} ${item.hold.scope} by ${item.hold.owner.agentId}: ${item.hold.reason}`
    ),
    ...report.nextSteps.map((step) => `  Next: ${step}`),
  ];
  return `${lines.join("\n")}\n`;
};

const holdReadOptions = (options: CliOptions): ShipHoldReadOptions => ({
  localOnly: options.localOnly,
  remote: options.remoteName,
  runId: options.runId,
});

const requiredHoldValue = <T>(value: T | undefined, option: string): T => {
  if (value === undefined) {
    throw new SimpleChangesError(
      `${option} is required for this command`,
      EXIT_CODES.usage
    );
  }
  return value;
};

const runHoldMutation = (
  action: string,
  options: CliOptions,
  agentId: string
): boolean => {
  if (action === "add") {
    const hold = addShipHold(options.repo, {
      adapter: requireCliOption(options.adapter, "--adapter"),
      agentId,
      ownerRef: options.ownerRef,
      reason: requireCliOption(options.reason, "--reason"),
      scope: requiredHoldValue(options.holdScope, "--hold-scope"),
      severity: requiredHoldValue(options.holdSeverity, "--severity"),
      untilMerged: options.untilMerged,
    });
    writeOutput(
      hold,
      options.json,
      `Added ${hold.severity} ${hold.scope} hold ${hold.holdId}. Agents in any harness on this machine see it now; run hold publish to share it through the remote.\n`
    );
    return true;
  }
  if (action === "waive") {
    const waiver = waiveShipHold(options.repo, {
      ...holdReadOptions(options),
      agentId,
      approvedBy: requireCliOption(options.approvedBy, "--approved-by"),
      holdId: requireCliOption(options.holdId, "--hold-id"),
      overrideHalt: options.overrideHalt,
      reason: requireCliOption(options.reason, "--reason"),
      runId: requireCliOption(options.runId, "--run-id"),
    });
    writeOutput(
      waiver,
      options.json,
      `Waived ${waiver.holdId} for ${waiver.runId} with approval from ${waiver.approvedBy}.\n`
    );
    return true;
  }
  if (action === "publish") {
    const hold = publishShipHold(options.repo, {
      agentId,
      holdId: requireCliOption(options.holdId, "--hold-id"),
      remote: options.remoteName,
    });
    const remote = hold.publication?.remote ?? "";
    // Other clones judge --until-merged from their remote-tracking branch, so
    // an unpushed branch can only be cleared there by its owner's release.
    const unpushedBranch =
      hold.untilMerged &&
      runGit(
        options.repo,
        [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/${remote}/${hold.untilMerged}`,
        ],
        true
      ).exitCode !== 0
        ? `Note: ${hold.untilMerged} is not on ${remote}, so other clones cannot see it merge; release this hold yourself once it lands.\n`
        : "";
    writeOutput(
      hold,
      options.json,
      `Published ${hold.holdId} as ${hold.publication?.ref} on ${remote}.\n${unpushedBranch}`
    );
    return true;
  }
  return false;
};

const runHoldRelease = (options: CliOptions, agentId: string): void => {
  const result = releaseShipHold(options.repo, {
    agentId,
    approvedBy: options.approvedBy,
    holdId: requireCliOption(options.holdId, "--hold-id"),
    overrideHalt: options.overrideHalt,
    reason: options.reason,
    remote: options.remoteName,
  });
  const { publication } = result.hold;
  const withdrawal =
    result.withdrawal.attempted && publication
      ? `${result.withdrawal.ok ? "Withdrew" : "Could not withdraw"} ${publication.ref} from ${publication.remote}.\n`
      : "";
  writeOutput(
    result,
    options.json,
    `Released ${result.hold.holdId}.\n${withdrawal}`
  );
  if (!result.withdrawal.ok) {
    throw new SimpleChangesError(
      `The hold is released locally, but its published ref is still on the remote: ${result.withdrawal.error} Rerun hold release to retry the withdrawal.`,
      EXIT_CODES.inventory
    );
  }
};

const runHoldCommand = (options: CliOptions): void => {
  const [action] = options.positional;
  if (action === "status" || action === "check") {
    const holdAction =
      action === "check"
        ? requiredHoldValue(options.holdAction, "--for")
        : undefined;
    const report = checkShipHolds(options.repo, {
      ...holdReadOptions(options),
      action: holdAction,
    });
    writeOutput(report, options.json, renderHoldReport(report));
    if (holdAction) {
      assertShipHoldsClear(report);
    }
    return;
  }
  if (!action) {
    throw new SimpleChangesError(
      "hold requires add, status, check, release, waive, or publish",
      EXIT_CODES.usage
    );
  }
  const agentId = requireCliOption(options.agentId, "--agent-id");
  if (action === "release") {
    runHoldRelease(options, agentId);
    return;
  }
  if (!runHoldMutation(action, options, agentId)) {
    throw new SimpleChangesError(
      `Unknown hold action: ${action}`,
      EXIT_CODES.usage
    );
  }
};

const renderPrune = (report: PruneReport): string => {
  const verb = report.dryRun ? "Would remove" : "Removed";
  const lines = [
    `Prune vs ${report.targetRef} at ${report.targetRevision}${report.dryRun ? " (dry run; nothing was changed)" : ""}.`,
    `Plan: ${report.plannedRemovals.length} worktree(s), ${report.plannedPrunePaths.length} stale record(s), ${report.plannedBranchRemovals.length} branch(es).`,
  ];
  for (const candidate of report.plannedRemovals) {
    lines.push(
      `- ${verb} worktree ${candidate.path} (${candidate.containment})`
    );
  }
  for (const path of report.plannedPrunePaths) {
    lines.push(`- ${verb} stale worktree record ${path}`);
  }
  for (const branch of report.plannedBranchRemovals) {
    lines.push(`- ${verb} branch ${branch.branch} (${branch.method})`);
  }
  if (!report.dryRun) {
    lines.push(
      `Applied: removed ${report.removed.length} worktree(s), pruned ${report.prunedPaths.length} stale record(s), deleted ${report.removedBranches.length} branch(es).`
    );
  }
  for (const entry of report.preserved) {
    lines.push(`- preserved ${entry.path}: ${entry.reason}`);
  }
  for (const entry of report.preservedBranches) {
    lines.push(`- preserved branch ${entry.branch}: ${entry.reason}`);
  }
  lines.push(...report.notes, ...report.errors.map((error) => `! ${error}`));
  return `${lines.join("\n")}\n`;
};

const runPrune = (options: CliOptions): void => {
  const report = pruneRepository({
    approvedBy: options.approvedBy,
    dryRun: options.dryRun,
    reason: options.reason,
    repositoryPath: options.repo,
    targetRef: options.targetRef,
  });
  writeOutput(report, options.json, renderPrune(report));
};

const runPrepareAgent = (options: CliOptions): void => {
  const prepared = prepareAgentWorktree(
    options.repo,
    requireCliOption(options.runId, "--run-id"),
    requireCliOption(options.agentId, "--agent-id"),
    requireCliOption(options.purpose, "--purpose")
  );
  // Commit attestation is a required step of every author's workflow: the
  // review ledger cannot reconstruct who wrote a commit after the fact.
  const shellWord = (value: string): string =>
    PLAIN_SHELL_WORD_PATTERN.test(value)
      ? value
      : `'${value.replaceAll("'", "'\\''")}'`;
  const afterEveryCommit = `simple-changes author attest --commit <sha> --agent-id ${shellWord(prepared.agentId)} --repo ${shellWord(prepared.path)} --json`;
  writeOutput(
    { ...prepared, afterEveryCommit },
    options.json,
    `${prepared.created ? "Created" : "Reused"} ${prepared.path}\nBranch: ${prepared.branch}\nRun: ${prepared.runId}\nRequired after every commit: ${afterEveryCommit}\n`
  );
};

const runReleaseNotes = (options: CliOptions): number => {
  if (options.check) {
    if (options.releaseVersion) {
      throw new SimpleChangesError(
        "--check and --version cannot be combined",
        EXIT_CODES.usage
      );
    }
    if (!options.repoProvided) {
      throw new SimpleChangesError(
        "--check requires an explicit --repo PATH",
        EXIT_CODES.usage
      );
    }
    const report = validateSchema<ReleaseConsistencyReport>(
      "release-consistency",
      checkReleaseConsistency(options.repo)
    );
    writeOutput(report, options.json, renderReleaseConsistency(report));
    return report.valid ? EXIT_CODES.success : EXIT_CODES.validation;
  }
  const releaseRoot = options.repoProvided ? options.repo : PACKAGE_ROOT;
  const changelogPath = resolve(releaseRoot, "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");
  // The packaged notes cover recent guidance versions only; an older
  // published release gets a pointer to the canonical changelog instead.
  const pointer =
    !options.repoProvided && options.releaseVersion
      ? releaseNotesPointer(changelog, options.releaseVersion)
      : null;
  if (pointer) {
    writeOutput(
      validateSchema<ReleaseNotesPointer>("release-notes-pointer", pointer),
      options.json,
      renderReleaseNotesPointer(pointer)
    );
    return EXIT_CODES.outsideWindow;
  }
  const notes = validateSchema<ReleaseNotes>(
    "release-notes",
    extractReleaseNotes(changelog, changelogPath, options.releaseVersion)
  );
  writeOutput(notes, options.json, notes.markdown);
  return EXIT_CODES.success;
};

const renderStopHookStatus = (status: StopHookStatus): string => {
  if (status.written) {
    return `Installed the Simple Changes turn-end guard for ${status.harness} in ${status.path}. New sessions pick it up${status.harness === "codex" ? "; Codex may ask you to trust the hook the first time it runs" : ""}.\n`;
  }
  if (status.current) {
    return `The Simple Changes turn-end guard is installed for ${status.harness} in ${status.path}.\n`;
  }
  if (status.installed) {
    return `An older Simple Changes turn-end guard is installed for ${status.harness} in ${status.path}. With the user's agreement, rerun with --write to update it to:\n  ${status.command}\n`;
  }
  return `The Simple Changes turn-end guard is not installed for ${status.harness}. With the user's agreement, run \`simple-changes harness stop-hook --harness ${status.harness} --write\` to add this Stop hook to ${status.path}:\n  ${status.command}\n`;
};

const NOT_INSTALLABLE_HERE =
  "This Simple Changes copy lives in a linked worktree with no matching primary-checkout copy that supports the turn check, so a user-level hook pointing here would break when the worktree is removed. Install the turn-end guard from the globally installed Simple Changes instead.";

const NOT_INSTALLABLE_FROM_FORK =
  "This Simple Changes copy is a repository fork, and no globally installed Simple Changes at least as new supports the turn check, so a user-level hook here would run this one repository's runtime in every session. Install or update the global Simple Changes, then install the turn-end guard from it.";

const notInstallableHere = (): string =>
  isForkRuntime(SCRIPT_FILE) ? NOT_INSTALLABLE_FROM_FORK : NOT_INSTALLABLE_HERE;

const resolveHarness = (options: CliOptions): TurnGuardHarness => {
  const harness = options.harness ?? currentHarnessSession()?.harness;
  if (!harness) {
    throw new SimpleChangesError(
      "No harness session detected; pass --harness claude-code or --harness codex.",
      EXIT_CODES.usage
    );
  }
  return harness;
};

const shellWord = (value: string): string =>
  PLAIN_SHELL_WORD_PATTERN.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;

const runHarnessCommand = (options: CliOptions): void => {
  if (options.positional[0] !== "stop-hook") {
    throw new SimpleChangesError(
      "harness requires stop-hook",
      EXIT_CODES.usage
    );
  }
  const script = hookInstallScript(SCRIPT_FILE, VERSION);
  if (!script && options.write) {
    throw new SimpleChangesError(notInstallableHere(), EXIT_CODES.unsafe);
  }
  const status = stopHookStatus(
    resolveHarness(options),
    script ?? SCRIPT_FILE,
    VERSION,
    options.write
  );
  writeOutput(
    { ...status, installable: script !== null },
    options.json,
    script || status.current
      ? renderStopHookStatus(status)
      : `${notInstallableHere()}\n`
  );
};

const executeCommand = async (
  command: string,
  options: CliOptions
): Promise<number> => {
  if (options.help) {
    process.stdout.write(HELP);
    return EXIT_CODES.success;
  }
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return EXIT_CODES.success;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return EXIT_CODES.success;
    case "fork": {
      if (
        options.positional.length !== 1 ||
        options.positional[0] !== "create"
      ) {
        throw new SimpleChangesError("fork requires create", EXIT_CODES.usage);
      }
      const result = createFork({
        deltas: requireCliOption(options.forkDeltas, "--deltas"),
        destination: options.forkDestination,
        name: requireCliOption(options.forkName, "--name"),
        repositoryPath: options.repo,
        sourcePath: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        upstreamPath: options.forkUpstream,
      });
      writeOutput(
        result,
        options.json,
        `Created ${result.name} at ${result.destination}\nUpstream: ${result.upstreamCommit}\nDescription: ${result.description}\nCustomize SKILL.md, keeping a description that names this fork in place of the global simple-changes skill, run the fork's own skill check, then verify and commit the fork in its repository.\n`
      );
      return EXIT_CODES.success;
    }
    case "inventory":
      runInventory(options);
      return EXIT_CODES.success;
    case "initialize":
      await runInitialize(options);
      return EXIT_CODES.success;
    case "setup":
      await runSetup(options);
      return EXIT_CODES.success;
    case "acknowledge-update":
      await runAcknowledgeUpdate(options);
      return EXIT_CODES.success;
    case "migration":
      if (options.positional[0] === "apply") {
        runMigrationApplyCommand(options);
      } else {
        runMigrationCommand(options);
      }
      return EXIT_CODES.success;
    case "permissions":
      runPermissionCommand(options);
      return EXIT_CODES.success;
    case "preview":
      await runPreview(options);
      return EXIT_CODES.success;
    case "loop":
      await (options.positional[0] === "turn-check"
        ? runLoopTurnCheck(options)
        : runLoopCommand(options));
      return EXIT_CODES.success;
    case "branch": {
      if (options.positional[0] !== "audit") {
        throw new SimpleChangesError("branch requires audit", EXIT_CODES.usage);
      }
      const report = auditBranchReplacements({
        headRef: requireCliOption(options.headRef, "--head"),
        repositoryRoot: options.repo,
        targetRef: requireCliOption(options.targetRef, "--target"),
      });
      writeOutput(report, options.json, `${JSON.stringify(report, null, 2)}\n`);
      return EXIT_CODES.success;
    }
    case "worktree":
      runWorktreeCommand(options);
      return EXIT_CODES.success;
    case "hold":
      runHoldCommand(options);
      return EXIT_CODES.success;
    case "harness":
      runHarnessCommand(options);
      return EXIT_CODES.success;
    case "prune":
      runPrune(options);
      return EXIT_CODES.success;
    case "prepare-agent":
      runPrepareAgent(options);
      return EXIT_CODES.success;
    case "author":
      runAuthorCommand(options);
      return EXIT_CODES.success;
    case "release-notes":
      return runReleaseNotes(options);
    case "negotiate-changelog":
      runChangelogNegotiation(options);
      return EXIT_CODES.success;
    case "validate-changelog-transaction":
      runChangelogTransactionValidation(options);
      return EXIT_CODES.success;
    case "validate-changelog-release-set":
      runChangelogReleaseSetValidation(options);
      return EXIT_CODES.success;
    case "release-gate":
      runReleaseGate(options);
      return EXIT_CODES.success;
    case "release-delivery":
      runReleaseDelivery(options);
      return EXIT_CODES.success;
    case "release-tag":
      return runReleaseTagCommand(options);
    case "proposal-signatures":
      runProposalSignatures(options);
      return EXIT_CODES.success;
    case "proposal":
      return runProposalCommand(options);
    case "skill":
      return runSkillCommand(options);
    case "validate":
      runValidation(options);
      return EXIT_CODES.success;
    case "verify-markdown":
      runMarkdownAudit(options);
      return EXIT_CODES.success;
    default:
      throw new SimpleChangesError(
        `Unknown command: ${command}. Run 'simple-changes help' for usage.`,
        EXIT_CODES.usage
      );
  }
};

export const runCli = async (args: string[]): Promise<number> => {
  const [command = "help", ...rest] = args;
  try {
    return await executeCommand(command, parseOptions(rest));
  } catch (error) {
    const simpleError =
      error instanceof SimpleChangesError
        ? error
        : new SimpleChangesError(
            error instanceof Error ? error.message : String(error),
            EXIT_CODES.validation,
            error instanceof Error ? { cause: error } : undefined
          );
    const wantsJson = args.includes("--json");
    const message = redactSecrets(simpleError.message);
    process.stderr.write(
      wantsJson
        ? `${JSON.stringify({ error: message, exitCode: simpleError.exitCode, ok: false })}\n`
        : `simple-changes: ${message}\n`
    );
    return simpleError.exitCode;
  }
};

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
