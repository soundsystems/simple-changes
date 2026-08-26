#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { sleep } from "bun";
import { inspectChangelogCoordination } from "./lib/changelog-coordination.ts";
import {
  buildCoordinationRequest,
  type CoordinationCapabilityProbe,
  probeCoordinationAdapter,
} from "./lib/coordination-adapter.ts";
import { EXIT_CODES, SimpleChangesError } from "./lib/errors.ts";
import {
  acknowledgeGuidanceUpdate,
  CURRENT_GUIDANCE_VERSION,
  type GuidanceUpdateAction,
} from "./lib/guidance-updates.ts";
import {
  type InitializationStatus,
  inspectInitialization,
} from "./lib/initialization.ts";
import { captureInventory, compareSnapshots } from "./lib/inventory.ts";
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
  loopStatus,
  markWorktreeResumeReady,
  prepareAgentWorktree,
  readLoopLease,
  rebaselineLoopWorktrees,
  recordEmergencyShipping,
  recordRemoteBranchReconciliation,
  recordShipmentOutcome,
  recordShipmentScope,
  recoverLoopLock,
  recoverPostCleanupLoop,
  retainExcludedWorktree,
  startLoop,
  takeoverLoop,
  verifyLoop,
  withLoopMutationLease,
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
  collectOnboardingSelection,
  type OnboardingChoice,
  type OnboardingInputs,
  type OnboardingPrompter,
  parseMigrationTargets,
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
  writePolicyFile,
  writeRepositoryPolicyTrustReceipt,
} from "./lib/policy.ts";
import { runGit } from "./lib/process.ts";
import { redactSecrets } from "./lib/redact.ts";
import {
  checkReleaseConsistency,
  type ReleaseConsistencyReport,
  renderReleaseConsistency,
} from "./lib/release-consistency.ts";
import {
  negotiateChangelogProtocol,
  validateChangelogTransaction,
} from "./lib/release-gate.ts";
import type { ReleaseNotes } from "./lib/release-notes.ts";
import { extractReleaseNotes } from "./lib/release-notes.ts";
import { renderInventory, renderPlan } from "./lib/report.ts";
import {
  discoverInstructionTargets,
  writeInstructionPointer,
} from "./lib/repository-instructions.ts";
import { SCHEMA_NAMES, validateSchema } from "./lib/schema.ts";
import type {
  InitializationMode,
  RepoPolicy,
  RequestMode,
  SchemaName,
} from "./lib/types.ts";
import {
  attachClaimedWorktree,
  claimWorktree,
  detachClaimedWorktree,
  observeWorktreeClaims,
  pauseClaimedWorktree,
  readWorktreeCoordination,
  releaseWorktreeClaim,
  takeoverWorktreeClaim,
} from "./lib/worktree-coordination.ts";
import { auditWorktreeEquivalence } from "./lib/worktree-equivalence.ts";
import {
  refreshWorktreeIndex,
  standaloneWorktreeCleanup,
} from "./lib/worktree-maintenance.ts";

const VERSION = "0.12.19";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  simple-changes initialize --mode MODE
    [--ready]
    [--changelog-required]
    [--changelog delegate-if-available|preserve-and-report|ask]
    [--concurrent-work allow-claimed|strict]
    [--proposal-scheduling balanced|consecutive|parallel]
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
  simple-changes setup [--finish review|integrate|ship]
    [--changelog delegate-if-available|preserve-and-report|ask]
    [--concurrent-work allow-claimed|strict]
    [--proposal-scheduling balanced|consecutive|parallel]
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
  simple-changes acknowledge-update --guidance-decision accepted|reviewed|deferred
    [--agent-id ID] [--json] [--repo PATH]
  simple-changes migration decision --state REVIEW_FILE --pending PENDING_FILE --apply-plan APPLY_PLAN_FILE [--json] [--repo PATH]
  simple-changes migration apply --state REVIEW_FILE --pending PENDING_FILE --apply-plan APPLY_PLAN_FILE [--json] [--repo PATH]
  simple-changes permissions bundle REQUESTS_FILE [--json]
  simple-changes inventory [--json] [--repo PATH]
  simple-changes preview [--json] [--repo PATH] [--settle-ms N]
  simple-changes loop start --mode MODE --agent-id ID [--changelog-required]
    [--opening-remote-inventory FILE]
    [--json] [--repo PATH]
  simple-changes loop status [--json] [--repo PATH]
  simple-changes loop verify --run-id ID [--json] [--repo PATH]
  simple-changes loop guard --run-id ID --agent-id ID [--json] [--repo PATH]
  simple-changes loop record-scope --run-id ID --agent-id ID
    --receipt CHANGE_PLAN_FILE [--json] [--repo PATH]
  simple-changes loop refresh-scope --run-id ID --agent-id ID
    --receipt CHANGE_PLAN_FILE [--json] [--repo PATH]
  simple-changes loop record-outcome --run-id ID --agent-id ID
    --receipt SHIPMENT_OUTCOME_FILE [--json] [--repo PATH]
  simple-changes loop exec --run-id ID --agent-id ID [--json] [--repo PATH]
    -- COMMAND [ARG ...]
  simple-changes loop recover --agent-id ID [--json] [--repo PATH]
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
  simple-changes loop end --run-id ID --agent-id ID [--json] [--repo PATH]
  simple-changes loop finalize --run-id ID --agent-id ID --reason TEXT
    [--json] [--repo PATH]
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
  simple-changes worktree release --agent-id ID --claim-id ID [--json] [--repo PATH]
  simple-changes worktree takeover --claim-id ID --agent-id NEW_OWNER
    --status-digest SHA256 --approved-by ID --reason TEXT [--release]
    [--json] [--repo PATH]
  simple-changes worktree equivalence --worktree PATH [--target REF]
    [--json] [--repo PATH]
  simple-changes worktree refresh-index [--json] [--repo PATH]
  simple-changes worktree cleanup --agent-id ID --approved-by ID --reason TEXT
    [--target REF] [--json] [--repo PATH]
  simple-changes prepare-agent --run-id ID --agent-id ID --purpose SLUG
    [--json] [--repo PATH]
  simple-changes release-notes [--check] [--json] [--repo PATH] [--version VERSION]
  simple-changes negotiate-changelog CAPABILITIES_FILE [--json]
  simple-changes validate-changelog-transaction REQUEST_FILE RECEIPT_FILE [--json]
  simple-changes validate KIND FILE [--json]
  simple-changes verify-markdown FILE [--json]
  simple-changes help

Schema kinds:
${schemaKindLines}

Exit codes:
  0 success, 2 usage, 3 invalid contract, 4 inventory failure, 5 unsafe state
`;

interface CliOptions {
  acknowledgePushScope: boolean;
  adapter?: string;
  agentId?: string;
  applyPlanPath?: string;
  approvedBy?: string;
  changelogHandling?: RepoPolicy["changelogHandling"];
  changelogRequired: boolean;
  check: boolean;
  claimId?: string;
  concurrentWork?: RepoPolicy["concurrentWork"];
  defaultFinish?: "open-change-request" | "integrate" | "ship";
  disposition?: "preserve-in-place" | "detach-clean-checkout";
  evidencePaths: string[];
  gitPushAuthorization?: RepoPolicy["gitPushAuthorization"];
  guidanceDecision?: RepoPolicy["guidance"]["disposition"];
  handoffTiming?: RepoPolicy["handoffTiming"];
  help: boolean;
  instructionFile?: string;
  instructionPointer?: "add" | "leave";
  json: boolean;
  manifestDigest?: string;
  migrationHandling?: RepoPolicy["migrationHandling"];
  migrationTargets: RepoPolicy["migrationTargets"];
  mode?: InitializationMode;
  openingRemoteInventoryPath?: string;
  ownerRef?: string;
  pauseReceiptId?: string;
  pendingPath?: string;
  positional: string[];
  productionDeploy?: RepoPolicy["productionDeploy"];
  proposalScheduling?: RepoPolicy["proposalScheduling"];
  purpose?: string;
  questions?: RepoPolicy["questions"];
  ready: boolean;
  reason?: string;
  receiptPath?: string;
  releaseClaim: boolean;
  releaseVersion?: string;
  repo: string;
  repoProvided: boolean;
  requestAction?: "request-pause" | "request-detach" | "notify-resume";
  runId?: string;
  scope?: SetupScope;
  settleMs: number;
  shippingMode?: RepoPolicy["shippingMode"];
  statePath?: string;
  statusDigest?: string;
  targetRef?: string;
  uiArtifacts: boolean;
  uiArtifactVersioning?: RepoPolicy["uiArtifactVersioning"];
  worktreePath?: string;
  yes: boolean;
}

const VALUED_OPTIONS = new Set([
  "--adapter",
  "--apply-plan",
  "--agent-id",
  "--approved-by",
  "--changelog",
  "--concurrent-work",
  "--claim-id",
  "--disposition",
  "--evidence",
  "--finish",
  "--handoff",
  "--guidance-decision",
  "--git-push-authorization",
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
  "--production",
  "--proposal-scheduling",
  "--purpose",
  "--questions",
  "--reason",
  "--receipt",
  "--request-action",
  "--repo",
  "--run-id",
  "--scope",
  "--shipping-mode",
  "--settle-ms",
  "--status-digest",
  "--state",
  "--target",
  "--ui-versioning",
  "--version",
  "--worktree",
]);

const BOOLEAN_OPTIONS = new Set([
  "--acknowledge-push-scope",
  "--changelog-required",
  "--check",
  "--json",
  "--ready",
  "--release",
  "--ui-artifacts",
  "--yes",
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
    "--agent-id": "agentId",
    "--apply-plan": "applyPlanPath",
    "--approved-by": "approvedBy",
    "--claim-id": "claimId",
    "--manifest-digest": "manifestDigest",
    "--opening-remote-inventory": "openingRemoteInventoryPath",
    "--owner-ref": "ownerRef",
    "--pause-receipt": "pauseReceiptId",
    "--pending": "pendingPath",
    "--purpose": "purpose",
    "--reason": "reason",
    "--receipt": "receiptPath",
    "--run-id": "runId",
    "--state": "statePath",
    "--status-digest": "statusDigest",
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

const applyValuedOption = (
  options: CliOptions,
  option: string,
  value: string
): void => {
  if (
    applyShippingModeOption(options, option, value) ||
    applySetupValuedOption(options, option, value) ||
    applyLoopValuedOption(options, option, value)
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
    if (!["user", "repository", "run"].includes(value)) {
      throw new SimpleChangesError(
        "--scope must be user, repository, or run",
        EXIT_CODES.usage
      );
    }
    options.scope = value as SetupScope;
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

const applyBooleanOption = (options: CliOptions, option: string): void => {
  if (option === "--acknowledge-push-scope") {
    options.acknowledgePushScope = true;
  } else if (option === "--json") {
    options.json = true;
  } else if (option === "--changelog-required") {
    options.changelogRequired = true;
  } else if (option === "--check") {
    options.check = true;
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
    changelogRequired: false,
    check: false,
    evidencePaths: [],
    help: false,
    json: false,
    migrationTargets: [],
    positional: [],
    ready: false,
    releaseClaim: false,
    repo: process.cwd(),
    repoProvided: false,
    settleMs: 0,
    uiArtifacts: false,
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
      applyBooleanOption(options, argument);
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
  instructionTargetCount: number
): boolean =>
  !(
    options.defaultFinish &&
    (!changelogRelevant || options.changelogHandling) &&
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
  "concurrentWork",
  "defaultFinish",
  "gitPushAuthorization",
  "handoffTiming",
  "instructionFile",
  "instructionPointer",
  "migrationHandling",
  "proposalScheduling",
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

const runSetup = async (options: CliOptions): Promise<void> => {
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
    instructionTargets.length
  );
  if (needsPrompt && !process.stdin.isTTY) {
    throw new SimpleChangesError(
      "Interactive setup requires a terminal. Supply --finish, --questions, --scope, --git-push-authorization for every pushing finish, --production and --shipping-mode when shipping, --migration-handling and --migration-target for automatic migration apply, --changelog when relevant, --ui-versioning with --ui-artifacts, --instruction-pointer when an instruction file exists, --handoff when adding the pointer, --instruction-file when selecting among targets, and --yes.",
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
        existingPersonalDefaults: context.existingPersonalDefaults,
        forgeProvider: context.forgeProvider,
        showFirstScreen: process.stdin.isTTY,
      }
    );
    const path = setupPolicyPath(selection.scope, context.primaryCheckout);
    const written = selection.confirmed && path !== null;
    const applyWrites = (): {
      instructionPointerChanged: boolean;
      instructionPointerWritten: boolean;
    } => {
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
        writePolicyFile(path, selection.policy, selection.scope === "user");
        if (selection.scope === "repository" && context.primaryCheckout) {
          const trustedInventory = captureInventory(context.primaryCheckout);
          writeRepositoryPolicyTrustReceipt(
            context.primaryCheckout,
            trustedInventory.repository.commonGitDirectory,
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
    const writeResult = activeLoop
      ? (
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
        ).result
      : applyWrites();
    const result = {
      changelogCoordination: context.changelog,
      confirmed: selection.confirmed,
      instructionPointer: {
        ...selection.instructionPointer,
        changed: writeResult.instructionPointerChanged,
        written: writeResult.instructionPointerWritten,
      },
      path,
      policy: selection.policy,
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

const renderInitialization = (status: InitializationStatus): string => {
  const lines = [
    "Simple Changes initialization",
    `Mode: ${status.mode}`,
    `Write-capable: ${status.writeCapable ? "yes" : "no"}`,
    `Mutation allowed: ${status.mutationAllowed ? "yes" : "no"}`,
    `Policy: ${status.policySource}`,
    `Policy trust: ${status.policyTrust}`,
    `Changelog coordination: ${
      status.changelogCoordination.relevant ? "relevant" : "not detected"
    }`,
    `Changelog capability: ${
      status.changelogCoordination.capabilityAvailable
        ? "available"
        : "not available"
    }`,
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
  return `${lines.join("\n")}\n`;
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
  const inventory = captureInventory(options.repo);
  const activeLoop = readLoopLease(options.repo);
  if (activeLoop && !["preview", "pause"].includes(options.mode)) {
    const agentId = requireCliOption(
      options.agentId,
      "--agent-id while an integration loop is active"
    );
    guardLoopMutation(options.repo, activeLoop.runId, agentId);
  }
  const changelogCoordination = inspectChangelogCoordination(
    inventory.repository.primaryCheckout
  );
  const status = validateSchema<InitializationStatus>(
    "initialization",
    inspectInitialization(
      options.mode,
      inventory.policy,
      changelogCoordination,
      {
        changelogRequired: options.changelogRequired,
        readinessConfirmed: options.ready,
      }
    )
  );
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
        : 0
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
  const policy = acknowledgeGuidanceUpdate(inventory.policy.value, disposition);
  const applyWrite = (): void => {
    writePolicyFile(
      inventory.policy.path as string,
      policy,
      inventory.policy.source === "user"
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
    applyWrite();
  }
  const result = {
    currentVersion: CURRENT_GUIDANCE_VERSION,
    disposition,
    path: inventory.policy.path,
    previousVersion,
    source: inventory.policy.source,
    written: true,
  };
  writeOutput(
    result,
    options.json,
    `Recorded Simple Changes guidance ${CURRENT_GUIDANCE_VERSION} as ${disposition} in ${inventory.policy.path}.\n`
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

const runChangelogTransactionValidation = (options: CliOptions): void => {
  const [requestFilename, receiptFilename] = options.positional;
  if (!(requestFilename && receiptFilename)) {
    throw new SimpleChangesError(
      "validate-changelog-transaction requires REQUEST_FILE and RECEIPT_FILE",
      EXIT_CODES.usage
    );
  }
  const receipt = validateChangelogTransaction(
    readJsonFile(requestFilename),
    readJsonFile(receiptFilename)
  );
  writeOutput(
    { receipt, valid: true },
    options.json,
    `${receiptFilename} matches ${requestFilename}.\n`
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

const runLoopRecovery = (options: CliOptions): void => {
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
  agentId: string
): Promise<void> => {
  const result = await executeLoopMutation(
    options.repo,
    runId,
    agentId,
    options.positional.slice(1)
  );
  if (options.json) {
    writeOutput(result, true, "");
    return;
  }
  if (result.result.stdout) {
    process.stdout.write(result.result.stdout);
  }
  if (result.result.stderr) {
    process.stderr.write(result.result.stderr);
  }
  process.stdout.write(
    `Loop mutation completed under ${runId}; manifest is clean.\n`
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
    const verification = endLoop(options.repo, runId, agentId);
    writeOutput(
      verification,
      options.json,
      `Ended ${runId} after a clean manifest verification.\n`
    );
    return true;
  }
  if (action === "finalize") {
    const result = finalizeLoop(
      options.repo,
      runId,
      agentId,
      requireCliOption(options.reason, "--reason")
    );
    if (result.outcome === "relinquished") {
      throw new SimpleChangesError(
        `Relinquished ${runId} with durable state; the shipment is incomplete. Automatic cleanup normalized ${result.cleanup.cleanedPrimaryPaths.length} target-equivalent primary path(s), removed ${result.cleanup.removedWorktrees.length} worktree(s) and ${result.cleanup.removedBranches.length} branch(es), and pruned ${result.cleanup.prunedWorktreeMetadata} stale worktree record(s). Remaining: ${result.blockers.join(" ")}`,
        EXIT_CODES.unsafe
      );
    }
    writeOutput(
      {
        ...result,
        manifestDigest: result.lease ? loopManifestDigest(result.lease) : null,
      },
      options.json,
      `Completed and released ${runId}. Normalized ${result.cleanup.cleanedPrimaryPaths.length} target-equivalent primary path(s), removed ${result.cleanup.removedWorktrees.length} worktree(s) and ${result.cleanup.removedBranches.length} branch(es); pruned ${result.cleanup.prunedWorktreeMetadata} stale worktree record(s).\n`
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

const runLoopOpeningAction = (action: string, options: CliOptions): boolean => {
  if (action === "start") {
    const agentId = requireCliOption(options.agentId, "--agent-id");
    if (!options.mode) {
      throw new SimpleChangesError(
        "loop start requires --mode",
        EXIT_CODES.usage
      );
    }
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
    const lease = startLoop(
      options.repo,
      agentId,
      options.mode as RequestMode,
      openingRemoteInventory
    );
    writeOutput(
      { lease, manifestDigest: loopManifestDigest(lease) },
      options.json,
      `Started ${lease.runId} for ${lease.ownerAgentId}.\nManifest: ${loopManifestDigest(lease)}\n`
    );
    return true;
  }
  if (action === "status") {
    const status = loopStatus(options.repo);
    const guidanceLines = [
      status.guidance.headline,
      ...status.guidance.nextCommands.map((command) => `  Next: ${command}`),
    ];
    writeOutput(
      {
        ...status,
        manifestDigest: status.lease ? loopManifestDigest(status.lease) : null,
      },
      options.json,
      `${renderLoopVerification(status.verification)}${guidanceLines.join("\n")}\n`
    );
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

const runLoopVerifyAction = (action: string, options: CliOptions): boolean => {
  if (action !== "verify") {
    return false;
  }
  const verification = verifyLoop(options.repo);
  writeOutput(verification, options.json, renderLoopVerification(verification));
  if (!verification.ok) {
    throw new SimpleChangesError(
      "Active-loop manifest verification failed.",
      EXIT_CODES.unsafe
    );
  }
  return true;
};

const runLoopCommand = async (options: CliOptions): Promise<void> => {
  const [action] = options.positional;
  if (!action) {
    throw new SimpleChangesError(
      "loop requires start, status, verify, record-scope, refresh-scope, record-outcome, guard, exec, recover, recover-post-cleanup, close-equivalent, takeover, rebaseline, allow, dispose-worktree, retain-worktree, adopt-worktree, accept-paused-change, end, or finalize",
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
  if (runLoopVerifyAction(action, options)) {
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
      readJsonFile(requireCliOption(options.receiptPath, "--receipt"))
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
    writeOutput(
      verification,
      options.json,
      `Mutation guard passed for ${agentId} in ${lease.runId}.\n`
    );
    return;
  }
  if (action === "exec") {
    await runLoopExec(options, runId, agentId);
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
      `Standalone cleanup ${receipt.cleanupId} vs ${receipt.targetRef}: removed ${receipt.removed.length} proven worktree(s), pruned ${receipt.prunedPaths.length} stale record(s), preserved ${receipt.preserved.length}.\n${receipt.preserved.map((entry) => `- preserved ${entry.path}: ${entry.reason}`).join("\n")}${receipt.preserved.length > 0 ? "\n" : ""}`
    );
    return true;
  }
  return false;
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
    const state = readWorktreeCoordination(options.repo);
    writeOutput(
      state,
      options.json,
      `Worktree claims: ${state.claims.length}\nPause receipts: ${state.receipts.length}\n`
    );
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

const runPrepareAgent = (options: CliOptions): void => {
  const prepared = prepareAgentWorktree(
    options.repo,
    requireCliOption(options.runId, "--run-id"),
    requireCliOption(options.agentId, "--agent-id"),
    requireCliOption(options.purpose, "--purpose")
  );
  writeOutput(
    prepared,
    options.json,
    `${prepared.created ? "Created" : "Reused"} ${prepared.path}\nBranch: ${prepared.branch}\nRun: ${prepared.runId}\n`
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
  const notes = validateSchema<ReleaseNotes>(
    "release-notes",
    extractReleaseNotes(
      readFileSync(changelogPath, "utf8"),
      changelogPath,
      options.releaseVersion
    )
  );
  writeOutput(notes, options.json, notes.markdown);
  return EXIT_CODES.success;
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
      await runLoopCommand(options);
      return EXIT_CODES.success;
    case "worktree":
      runWorktreeCommand(options);
      return EXIT_CODES.success;
    case "prepare-agent":
      runPrepareAgent(options);
      return EXIT_CODES.success;
    case "release-notes":
      return runReleaseNotes(options);
    case "negotiate-changelog":
      runChangelogNegotiation(options);
      return EXIT_CODES.success;
    case "validate-changelog-transaction":
      runChangelogTransactionValidation(options);
      return EXIT_CODES.success;
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
