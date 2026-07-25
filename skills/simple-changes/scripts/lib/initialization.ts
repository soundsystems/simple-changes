import type { PolicySource, RepoPolicy, RequestMode } from "./types.ts";

export interface InitializationStatus {
  inferredDefaultFinish: Exclude<RepoPolicy["defaultFinish"], "preview"> | null;
  mode: RequestMode;
  onboardingRequired: boolean;
  policyPath: string | null;
  policySource: PolicySource;
  reason: string;
  writeCapable: boolean;
}

const WRITE_CAPABLE_MODES = new Set<RequestMode>([
  "queue",
  "sweep",
  "integrate",
  "ship",
  "reconcile",
  "resume",
]);

const inferredFinishForMode = (
  mode: RequestMode
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

export const inspectInitialization = (
  mode: RequestMode,
  policy: {
    path: string | null;
    source: PolicySource;
  }
): InitializationStatus => {
  const writeCapable = WRITE_CAPABLE_MODES.has(mode);
  const onboardingRequired = writeCapable && policy.source === "default";
  let reason = "Saved preferences are available.";
  if (!writeCapable) {
    reason = "This mode is read-only or preservation-only.";
  } else if (onboardingRequired) {
    reason =
      "No repository or personal preferences exist; onboarding must finish before mutation.";
  }
  return {
    inferredDefaultFinish: inferredFinishForMode(mode),
    mode,
    onboardingRequired,
    policyPath: policy.path,
    policySource: policy.source,
    reason,
    writeCapable,
  };
};
