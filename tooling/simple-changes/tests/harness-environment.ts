// Every variable through which the runtime learns which harness session is
// running it, which agent it is, or where that harness keeps its settings:
// the session IDs and the harness's own PID (`lib/harness-session.ts`, read
// by `lib/turn-guard.ts`, `lib/worktree-coordination.ts`,
// `lib/identity-receipt.ts` and authoring detection), the harness settings
// directories (`lib/turn-guard.ts`, `lib/repository-instructions.ts`), and
// the executing agent's ID (`lib/review-ledger.ts`). The test preload clears
// them all so the agent session running the suite never decides a test's
// outcome; a test that covers one sets it explicitly. test-isolation.test.ts
// fails when the runtime reads one that is missing here.
export const HARNESS_ENVIRONMENT_VARIABLES = [
  "AGENT_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PID",
  "CODEX_HOME",
  "CODEX_THREAD_ID",
] as const;
