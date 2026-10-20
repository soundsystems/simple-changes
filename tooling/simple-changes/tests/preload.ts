import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// Authoring detection reads home-directory roots by existence, the personal
// Simple Changes sidecar beside preferences.json, and the Simple Changelogs
// personal sidecar for the onboarding pre-fill. Point all three at an empty
// private directory so the developer's machine never decides a test's
// outcome; tests that cover detection or personal files set their own.
const isolatedAuthoringRoots = mkdtempSync(
  join(tmpdir(), "simple-changes-harness-roots-")
);
process.env.SIMPLE_CHANGES_HARNESS_ROOTS = isolatedAuthoringRoots;
process.env.SIMPLE_CHANGES_CONFIG_DIR = isolatedAuthoringRoots;
process.env.SIMPLE_CHANGELOGS_CONFIG_DIR = isolatedAuthoringRoots;

// Agent work directories default to the system temporary directory; keep the
// ones loop and prepare-agent create in tests out of the developer's.
process.env.SIMPLE_CHANGES_WORK_ROOT = mkdtempSync(
  join(tmpdir(), "simple-changes-work-root-")
);

// Every test names its repository. Run them from an empty directory outside
// any repository, with Git's discovery stopped above it and no inherited Git
// location variables, so a command that falls back to the working directory
// fails instead of reading or writing the repository `bun test` started in:
// often this one, or a worktree that shares its `.git` and its live state.
for (const name of [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
]) {
  delete process.env[name];
}
const isolatedWorkingDirectory = realpathSync(
  mkdtempSync(join(tmpdir(), "simple-changes-test-cwd-"))
);
process.env.GIT_CEILING_DIRECTORIES = dirname(isolatedWorkingDirectory);
process.chdir(isolatedWorkingDirectory);
