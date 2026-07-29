import type {
  ChangelogCoordination,
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

export interface InitializationStatus {
  changelogCoordination: ChangelogCoordination;
  handoffAction: HandoffAction;
  handoffTiming: RepoPolicy["handoffTiming"] | null;
  inferredDefaultFinish: Exclude<RepoPolicy["defaultFinish"], "preview"> | null;
  mode: InitializationMode;
  mutationAllowed: boolean;
  onboardingRequired: boolean;
  policyPath: string | null;
  policySource: PolicySource;
  readinessConfirmed: boolean;
  reason: string;
  resolvedMode: RequestMode | null;
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
  handoff: HandoffState
): string => {
  if (!writeCapable) {
    return "This mode is read-only or preservation-only.";
  }
  if (onboardingRequired) {
    return "No repository or personal preferences exist; onboarding must finish before mutation.";
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
    value?: RepoPolicy;
  },
  changelogCoordination: ChangelogCoordination = {
    capabilityAvailable: false,
    providers: [],
    releaseSurfaces: [],
    relevant: false,
  },
  options: {
    readinessConfirmed?: boolean;
  } = {}
): InitializationStatus => {
  const writeCapable = WRITE_CAPABLE_MODES.has(mode);
  const onboardingRequired =
    writeCapable && mode !== "sync" && policy.source === "default";
  const readinessConfirmed = options.readinessConfirmed ?? false;
  const handoff = inspectHandoff(mode, policy.value, readinessConfirmed);
  const mutationAllowed =
    writeCapable &&
    !onboardingRequired &&
    (mode !== "handoff" ||
      (handoff.action === "proceed" && handoff.resolvedMode !== "preview"));
  return {
    changelogCoordination,
    handoffAction: handoff.action,
    handoffTiming: handoff.timing,
    inferredDefaultFinish: handoff.finish,
    mode,
    mutationAllowed,
    onboardingRequired,
    policyPath: policy.path,
    policySource: policy.source,
    readinessConfirmed,
    reason: initializationReason(
      mode,
      writeCapable,
      onboardingRequired,
      handoff
    ),
    resolvedMode: handoff.resolvedMode,
    writeCapable,
  };
};
