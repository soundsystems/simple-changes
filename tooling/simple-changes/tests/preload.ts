// Tests must never bind a loop to the harness session running them: that
// would write controller pointers into the developer's real configuration
// directory and make liveness depend on the live session. Tests that cover
// session binding set these variables, and an isolated config directory,
// explicitly.
for (const name of [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
  "CODEX_THREAD_ID",
]) {
  delete process.env[name];
}
