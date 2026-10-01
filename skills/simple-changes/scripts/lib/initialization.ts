import {
  type GuidanceUpdateNotice,
  inspectGuidanceUpdate,
} from "./guidance-updates.ts";
import type {
  ChangelogCoordination,
  ChangelogInstallOffer,
  InitializationMode,
  PolicySource,
  RepoPolicy,
  RequestMode,
} from "./types.ts";

export type HandoffAction =
  | "not-applicable"
  | "confirm-readiness"
  | "wait-for-user"
  | "proceed";

export type PolicyTrust = "not-required" | "trusted" | "untrusted";

export interface InitializationStatus {
  changelogCoordination: ChangelogCoordination;
  // Pending Simple Changelogs install offer (command only; `offered` stays
  // false until onboarding asks). Absent or null when no offer applies.
  changelogInstall?: ChangelogInstallOffer | null;
  changelogRequired: boolean;
  firstUseWalkthroughAvailable: boolean;
  gitPushAuthorization: RepoPolicy["gitPushAuthorization"];
  guidanceUpdate: GuidanceUpdateNotice;
  handoffAction: HandoffAction;
  handoffClaimRelease: { claimId: string; path: string } | null;
  handoffTiming: RepoPolicy["handoffTiming"] | null;
  inferredDefaultFinish: Exclude<RepoPolicy["defaultFinish"], "preview"> | null;
  migrationHandling: RepoPolicy["migrationHandling"];
  migrationTargets: RepoPolicy["migrationTargets"];
  mode: InitializationMode;
  mutationAllowed: boolean;
  onboardingRequired: boolean;
  policyPath: string | null;
  policySource: PolicySource;
  policyTrust: PolicyTrust;
  preLoopActionRequired: boolean;
  readinessConfirmed: boolean;
  reason: string;
  resolvedMode: RequestMode | null;
  /** Whether the running runtime is older than the target branch's copy. */
  runtimeFreshness?: {
    message: string | null;
    path: string | null;
    runningVersion: string;
    status: "current" | "behind-target" | "not-applicable";
    targetRef: string | null;
    targetVersion: string | null;
  };
  shippingMode: RepoPolicy["shippingMode"];
  /** The detected harness's turn-end Stop hook, or null outside a harness. */
  turnEndGuard?: {
    current: boolean;
    harness: "claude-code" | "codex";
    installCommand: string | null;
    installed: boolean;
    path: string;
  } | null;
  writeCapable: boolean;
}

const WRITE_CAPABLE_MODES = new Set<InitializationMode>([
  "handoff",
  "sync",
  "queue",
  "sweep",
  "integrate",
  "ship",
  "reconcile",
  "resume",
]);

const inferredFinishForMode = (
  mode: InitializationMode
): Exclude<RepoPolicy["defaultFinish"], "preview"> | null => {
  if (mode === "queue" || mode === "sweep") {
    return "open-change-request";
  }
  if (mode === "integrate" || mode === "reconcile") {
    return "integrate";
  }
  if (mode === "ship") {
    return "ship";
  }
  return null;
};

const modeForFinish = (finish: RepoPolicy["defaultFinish"]): RequestMode => {
  if (finish === "integrate") {
    return "integrate";
  }
  if (finish === "ship") {
    return "ship";
  }
  if (finish === "preview") {
    return "preview";
  }
  return "queue";
};

interface HandoffState {
  action: HandoffAction;
  finish: Exclude<RepoPolicy["defaultFinish"], "preview"> | null;
  resolvedMode: RequestMode | null;
  timing: RepoPolicy["handoffTiming"] | null;
}

const inspectHandoff = (
  mode: InitializationMode,
  value: RepoPolicy | undefined,
  readinessConfirmed: boolean
): HandoffState => {
  if (mode !== "handoff") {
    return {
      action: "not-applicable",
      finish: inferredFinishForMode(mode),
      resolvedMode: null,
      timing: null,
    };
  }
  const timing = value ? value.handoffTiming : "confirm-ready";
  const defaultFinish = value ? value.defaultFinish : "open-change-request";
  if (timing === "automatic" || readinessConfirmed) {
    return {
      action: "proceed",
      finish: defaultFinish === "preview" ? null : defaultFinish,
      resolvedMode: modeForFinish(defaultFinish),
      timing,
    };
  }
  return {
    action: timing === "confirm-ready" ? "confirm-readiness" : "wait-for-user",
    finish: defaultFinish === "preview" ? null : defaultFinish,
    resolvedMode: null,
    timing,
  };
};

const initializationReason = (
  mode: InitializationMode,
  writeCapable: boolean,
  onboardingRequired: boolean,
  updateActionRequired: boolean,
  changelogUpdateActionRequired: boolean,
  handoff: HandoffState
): string => {
  if (!writeCapable) {
    return "This mode is read-only or preservation-only.";
  }
  if (onboardingRequired) {
    return "No repository or personal preferences exist; onboarding must finish before mutation.";
  }
  if (updateActionRequired && changelogUpdateActionRequired) {
    return "Simple Changes and Simple Changelogs both have recent updates; resolve both notices before the required changelog shipment loop begins.";
  }
  if (updateActionRequired) {
    return "A meaningful Simple Changes update changed behavior, onboarding, or integration guidance; review or defer it once before mutation.";
  }
  if (changelogUpdateActionRequired) {
    return "This request requires changelog work and Simple Changelogs has a recent update; resolve its owner-controlled notice before any shipment loop begins.";
  }
  if (mode === "sync") {
    return "Sync uses fixed local-only preservation guardrails and does not require workflow preference onboarding.";
  }
  if (handoff.action === "confirm-readiness") {
    return "Ask whether the implementation and checks are complete before handing work to Simple Changes.";
  }
  if (handoff.action === "wait-for-user") {
    return "Wait until the user indicates that the completed work is ready for Simple Changes.";
  }
  if (handoff.action === "proceed" && handoff.resolvedMode) {
    return `The handoff may proceed in ${handoff.resolvedMode} mode after confirming the completed assignment is attributable and verified.`;
  }
  return "Saved preferences are available.";
};

export const inspectInitialization = (
  mode: InitializationMode,
  policy: {
    path: string | null;
    source: PolicySource;
    trust?: PolicyTrust;
    value?: RepoPolicy;
  },
  changelogCoordination: ChangelogCoordination = {
    capabilityAvailable: false,
    capabilityHelpers: [],
    capabilityStatus: "absent",
    guidanceUpdate: {
      actions: [],
      detailsPath: null,
      headline: "**Simple Changelogs has recently been updated.**",
      installedVersion: null,
      owner: null,
      policyPath: null,
      provider: null,
      status: "absent",
      storedVersion: null,
      summaryBullets: [],
      walkthroughQuestion:
        "Would you like me to walk you through the recent Simple Changelogs updates before I continue?",
    },
    providerDistribution: null,
    providerEvidence: "none",
    providers: [],
    releaseSurfaces: [],
    relevant: false,
  },
  options: {
    changelogRequired?: boolean;
    readinessConfirmed?: boolean;
  } = {}
): InitializationStatus => {
  const writeCapable = WRITE_CAPABLE_MODES.has(mode);
  const onboardingRequired =
    writeCapable && mode !== "sync" && policy.source === "default";
  const guidanceUpdate = inspectGuidanceUpdate(
    policy.source === "default" ? null : (policy.value ?? null),
    changelogCoordination
  );
  const updateActionRequired =
    writeCapable && guidanceUpdate.status === "update-available";
  const changelogRequired = options.changelogRequired ?? false;
  const changelogUpdateActionRequired =
    writeCapable &&
    changelogRequired &&
    changelogCoordination.guidanceUpdate.status === "update-available";
  const readinessConfirmed = options.readinessConfirmed ?? false;
  const handoff = inspectHandoff(mode, policy.value, readinessConfirmed);
  const mutationAllowed =
    writeCapable &&
    !onboardingRequired &&
    !updateActionRequired &&
    !changelogUpdateActionRequired &&
    (mode !== "handoff" ||
      (handoff.action === "proceed" && handoff.resolvedMode !== "preview"));
  return {
    changelogCoordination,
    changelogRequired,
    firstUseWalkthroughAvailable: policy.source === "default",
    gitPushAuthorization: policy.value
      ? policy.value.gitPushAuthorization
      : "ask",
    guidanceUpdate,
    handoffAction: handoff.action,
    handoffClaimRelease: null,
    handoffTiming: handoff.timing,
    inferredDefaultFinish: handoff.finish,
    migrationHandling: policy.value
      ? policy.value.migrationHandling
      : "ask-after-review",
    migrationTargets: policy.value ? policy.value.migrationTargets : [],
    mode,
    mutationAllowed,
    onboardingRequired,
    policyPath: policy.path,
    policySource: policy.source,
    policyTrust: policy.trust ?? "not-required",
    preLoopActionRequired:
      onboardingRequired ||
      updateActionRequired ||
      changelogUpdateActionRequired,
    readinessConfirmed,
    reason: initializationReason(
      mode,
      writeCapable,
      onboardingRequired,
      updateActionRequired,
      changelogUpdateActionRequired,
      handoff
    ),
    resolvedMode: handoff.resolvedMode,
    shippingMode: policy.value ? policy.value.shippingMode : "standard",
    writeCapable,
  };
};
