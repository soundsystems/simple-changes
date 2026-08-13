import type {
  EmergencyShippingEvidence,
  EmergencyShippingIntent,
  EmergencyShippingMode,
  RepoPolicy,
  RequestMode,
} from "./types.ts";

export interface EmergencyShippingPolicyAuthority {
  authoritySource: "advanced-policy" | "explicit-current-request" | null;
  breakGlassAuthorized: boolean;
  productionAuthorized: boolean;
}

export const resolveEmergencyShippingPolicyAuthority = (
  intent: EmergencyShippingIntent,
  policy: RepoPolicy
): EmergencyShippingPolicyAuthority => {
  const explicitBreakGlass = intent.evidence.includes("deploy-before-review");
  const advancedBreakGlass =
    intent.mode === "break-glass" && policy.shippingMode === "break-glass";
  let authoritySource: EmergencyShippingPolicyAuthority["authoritySource"] =
    null;
  if (explicitBreakGlass) {
    authoritySource = "explicit-current-request";
  } else if (advancedBreakGlass) {
    authoritySource = "advanced-policy";
  }
  return {
    authoritySource,
    breakGlassAuthorized:
      intent.mode === "break-glass" &&
      (explicitBreakGlass || advancedBreakGlass),
    productionAuthorized: policy.productionDeploy === "allow",
  };
};

const INTEGRATION_PATTERN =
  /\b(package|queue|publish|integrate|merge|ship|reconcile)\b|\bput (?:this|it|these|them)(?:\s+\w+){0,6}\s+up\b|\bfocused (?:pr|prs|mr|mrs|change|changes)\b|\brun the (?:integration )?loop\b/iu;
const CLEAN_REPOSITORY_PATTERN =
  /\bclean(?: up)?\b.*\b(repo|repository|branches|worktrees?|changes?)\b/iu;
const READ_ONLY_REVIEW_PATTERN =
  /\b(read[- ]only )?(?:code )?review\b|\breview (?:this|the) (?:code|diff|pr|mr)\b/iu;
const COMMIT_MESSAGE_PATTERN = /\bcommit message\b/iu;
const DEPLOY_ONLY_PATTERN =
  /^(?:please )?(?:deploy|redeploy|promote)\b(?!.*\b(change|branch|commit|merge|integrat|ship)\b)/iu;
const ACTIONABLE_REVIEW_PATTERN = /\bmerge|integrat|ship|fix\b/iu;
const RESUME_CONTEXT_PATTERN = /^(again|continue|keep going)\b/iu;
const PREVIEW_TRIGGER_PATTERN =
  /\bshow me what you(?:'d| would) do\b.*\b(?:ready|changes?|repo)\b/iu;
const COMPLETE_PROPOSAL_PATTERN =
  /\b(?:audit|inspect|check|fix|repair)\b.*\b(?:all|every)\b.*\b(?:change proposals?|pull requests?|merge requests?|prs?|mrs?)\b/iu;
const PROPOSAL_REPAIR_PATTERN = /\b(?:fix|repair)\b/iu;
const PREVIEW_MODE_PATTERN =
  /\bshow me\b|\bpreview\b|\bwhat you(?:'d| would) do\b/iu;
const READ_ONLY_PROPOSAL_AUDIT_PATTERN =
  /\b(?:audit|inspect|check)\b.*\b(?:all|every)\b.*\b(?:change proposals?|pull requests?|merge requests?|prs?|mrs?)\b/iu;
const PAUSE_MODE_PATTERN = /^(?:please )?(?:leave\b.*\balone\b|pause\b)/iu;
const SHIP_MODE_PATTERN = /\bship\b/iu;
const INTEGRATE_MODE_PATTERN =
  /\bmerge\b(?!\s+requests?\b)|\bintegrate\b|\bfinish the open\b/iu;
const RECONCILE_MODE_PATTERN = /\breconcile\b|\bclean(?: up)?\b/iu;
const SYNC_MODE_PATTERN =
  /^(?:please\s+)?sync(?:\s+(?:us|this\s+(?:repo|repository)|the\s+(?:repo|repository)))?(?:\s+with\s+(?:(?:the\s+)?remote(?:\s+(?:main|master))?|origin(?:\/(?:main|master))?|upstream(?:\/(?:main|master))?|(?:main|master)|the\s+default\s+branch))?[.!]?$/iu;
const ALIGN_WITH_TARGET_PATTERN =
  /\bget us (?:in\s*line|aligned|up to date) with (?:(?:the )?remote(?:\s+(?:main|master))?|origin(?:\/(?:main|master))?|upstream(?:\/(?:main|master))?|(?:main|master)|the default branch)\b/iu;
const PULL_TARGET_PATTERN =
  /\bpull (?:the )?latest(?: changes)? from (?:origin|upstream|(?:remote )?(?:main|master)|the default branch)\b/iu;
const SWEEP_MODE_PATTERN =
  /\beverything\b|\ball (?:ready|changes|work)\b|\bfocused changes\b/iu;
const EXPLICIT_BREAK_GLASS_PATTERN =
  /\bdeploy first\b|\b(?:deploy|ship|put (?:this|it) live)\b.{0,48}\bbefore (?:an? |independent )?review\b|\b(?:independent )?review\b.{0,48}\bafter (?:the )?(?:deploy|deployment|release)\b|\bwithout (?:waiting for |an? )?(?:independent )?review\b/iu;
const SHIPPING_URGENCY_PATTERN =
  /\b(?:ship|deploy|release|publish|get|put)\b.{0,56}\b(?:asap|immediately|right now|fast|faster|quick|quickly|urgent(?:ly)?)\b|\b(?:asap|immediately|right now|fast|quickly|urgent(?:ly)?)\b.{0,56}\b(?:ship|deploy|release|publish|get (?:this|it) out|put (?:this|it) live)\b/iu;
const CONTEXTUAL_URGENCY_PATTERN =
  /\bmake (?:this|it) (?:fast|quick)\b|\bget (?:this|it) out\b/iu;
const ACTIVE_USER_IMPACT_PATTERN =
  /\b(?:production|prod|site|app|service)\b.{0,64}\b(?:down|outage|broken|failing|unavailable)\b|\b(?:users?|customers?)\b.{0,64}\b(?:cannot|can't|unable|blocked|affected|impacted|failing)\b|\b(?:affecting|impacting)\b.{0,32}\b(?:users?|customers?)\b/iu;
const TESTED_READY_PATTERN =
  /\b(?:tested|checks? passed|verified)\b.{0,64}\b(?:go live|production|deploy(?:ment)?)\b|\b(?:go live|production|deploy(?:ment)?)\b.{0,64}\b(?:tested|checks? passed|verified)\b/iu;

export const classifyEmergencyShipping = (
  prompt: string,
  integrationContextEstablished = false,
  defaultMode: EmergencyShippingMode = "standard"
): EmergencyShippingIntent => {
  const normalized = prompt.trim();
  const explicitBreakGlass = EXPLICIT_BREAK_GLASS_PATTERN.test(normalized);
  const urgent =
    SHIPPING_URGENCY_PATTERN.test(normalized) ||
    (integrationContextEstablished &&
      CONTEXTUAL_URGENCY_PATTERN.test(normalized));
  const activeUserImpact = ACTIVE_USER_IMPACT_PATTERN.test(normalized);
  const testedReady = TESTED_READY_PATTERN.test(normalized);
  const shippingInterest =
    explicitBreakGlass ||
    urgent ||
    testedReady ||
    SHIP_MODE_PATTERN.test(normalized);
  const configuredMode = shippingInterest ? defaultMode : "standard";
  const evidence: EmergencyShippingEvidence[] = [];
  if (urgent) {
    evidence.push("urgency-language");
  }
  if (activeUserImpact && shippingInterest) {
    evidence.push("active-user-impact");
  }
  if (testedReady) {
    evidence.push("tested-ready-for-production");
  }
  if (explicitBreakGlass) {
    evidence.push("deploy-before-review");
  }
  if (configuredMode === "break-glass") {
    return {
      breakGlassAuthorized: true,
      evidence,
      mode: "break-glass",
      recommendedMode: "break-glass",
      requiresBreakGlassConfirmation: false,
    };
  }
  if (explicitBreakGlass) {
    return {
      breakGlassAuthorized: true,
      evidence,
      mode: "break-glass",
      recommendedMode: "break-glass",
      requiresBreakGlassConfirmation: false,
    };
  }
  const recommendBreakGlass =
    shippingInterest && (activeUserImpact || testedReady);
  if (urgent || recommendBreakGlass || configuredMode === "expedited") {
    return {
      breakGlassAuthorized: false,
      evidence,
      mode: "expedited",
      recommendedMode: recommendBreakGlass ? "break-glass" : "expedited",
      requiresBreakGlassConfirmation: recommendBreakGlass,
    };
  }
  return {
    breakGlassAuthorized: false,
    evidence,
    mode: "standard",
    recommendedMode: "standard",
    requiresBreakGlassConfirmation: false,
  };
};

const isSyncRequest = (prompt: string): boolean =>
  SYNC_MODE_PATTERN.test(prompt) ||
  ALIGN_WITH_TARGET_PATTERN.test(prompt) ||
  PULL_TARGET_PATTERN.test(prompt);

export const shouldTrigger = (
  prompt: string,
  integrationContextEstablished = false,
  defaultShippingMode: EmergencyShippingMode = "standard"
): boolean => {
  const normalized = prompt.trim();
  const emergency = classifyEmergencyShipping(
    normalized,
    integrationContextEstablished,
    defaultShippingMode
  );
  if (emergency.mode !== "standard") {
    return true;
  }
  if (
    COMMIT_MESSAGE_PATTERN.test(normalized) ||
    DEPLOY_ONLY_PATTERN.test(normalized)
  ) {
    return false;
  }
  if (
    READ_ONLY_REVIEW_PATTERN.test(normalized) &&
    !ACTIONABLE_REVIEW_PATTERN.test(normalized)
  ) {
    return false;
  }
  if (
    RESUME_CONTEXT_PATTERN.test(normalized) &&
    integrationContextEstablished
  ) {
    return true;
  }
  return (
    INTEGRATION_PATTERN.test(normalized) ||
    isSyncRequest(normalized) ||
    CLEAN_REPOSITORY_PATTERN.test(normalized) ||
    COMPLETE_PROPOSAL_PATTERN.test(normalized) ||
    PREVIEW_TRIGGER_PATTERN.test(normalized)
  );
};

export const classifyRequestMode = (
  prompt: string,
  integrationContextEstablished = false,
  defaultShippingMode: EmergencyShippingMode = "standard"
): RequestMode => {
  const normalized = prompt.trim();
  const emergency = classifyEmergencyShipping(
    normalized,
    integrationContextEstablished,
    defaultShippingMode
  );
  if (
    PREVIEW_MODE_PATTERN.test(normalized) ||
    READ_ONLY_PROPOSAL_AUDIT_PATTERN.test(normalized)
  ) {
    return "preview";
  }
  if (PAUSE_MODE_PATTERN.test(normalized)) {
    return "pause";
  }
  if (
    RESUME_CONTEXT_PATTERN.test(normalized) &&
    integrationContextEstablished
  ) {
    return "resume";
  }
  if (emergency.mode !== "standard" || SHIP_MODE_PATTERN.test(normalized)) {
    return "ship";
  }
  if (INTEGRATE_MODE_PATTERN.test(normalized)) {
    return "integrate";
  }
  if (RECONCILE_MODE_PATTERN.test(normalized)) {
    return "reconcile";
  }
  if (isSyncRequest(normalized)) {
    return "sync";
  }
  if (
    COMPLETE_PROPOSAL_PATTERN.test(normalized) &&
    PROPOSAL_REPAIR_PATTERN.test(normalized)
  ) {
    return "sweep";
  }
  if (SWEEP_MODE_PATTERN.test(normalized)) {
    return "sweep";
  }
  return "queue";
};
