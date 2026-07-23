import type { RequestMode } from "./types.ts";

const INTEGRATION_PATTERN =
  /\b(package|queue|publish|integrate|merge|ship|reconcile)\b|\bput (?:this|it) up\b|\bfocused (?:pr|prs|mr|mrs|change|changes)\b|\brun the (?:integration )?loop\b/iu;
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
const SWEEP_MODE_PATTERN =
  /\beverything\b|\ball (?:ready|changes|work)\b|\bfocused changes\b/iu;

export const shouldTrigger = (
  prompt: string,
  integrationContextEstablished = false
): boolean => {
  const normalized = prompt.trim();
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
    CLEAN_REPOSITORY_PATTERN.test(normalized) ||
    COMPLETE_PROPOSAL_PATTERN.test(normalized) ||
    PREVIEW_TRIGGER_PATTERN.test(normalized)
  );
};

export const classifyRequestMode = (
  prompt: string,
  integrationContextEstablished = false
): RequestMode => {
  const normalized = prompt.trim();
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
  if (SHIP_MODE_PATTERN.test(normalized)) {
    return "ship";
  }
  if (INTEGRATE_MODE_PATTERN.test(normalized)) {
    return "integrate";
  }
  if (RECONCILE_MODE_PATTERN.test(normalized)) {
    return "reconcile";
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
