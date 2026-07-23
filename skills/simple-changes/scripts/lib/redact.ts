const SECRET_PATTERNS = [
  /\b(?:ghp|github_pat|glpat|xox[baprs]|sk_(?:live|test))_[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/giu,
  /\bBearer\s+\S+/giu,
] as const;

export const redactSecrets = (value: string): string => {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
};
