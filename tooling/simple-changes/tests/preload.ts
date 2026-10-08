import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// Authoring detection reads home-directory roots by existence and the
// Simple Changelogs personal sidecar for the onboarding pre-fill. Point both
// at an empty private directory so the developer's machine never decides a
// test's outcome; tests that cover detection set their own roots.
const isolatedAuthoringRoots = mkdtempSync(
  join(tmpdir(), "simple-changes-harness-roots-")
);
process.env.SIMPLE_CHANGES_HARNESS_ROOTS = isolatedAuthoringRoots;
process.env.SIMPLE_CHANGELOGS_CONFIG_DIR = isolatedAuthoringRoots;
