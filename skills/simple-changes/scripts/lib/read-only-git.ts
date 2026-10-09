/**
 * Read-only Git for commands that promise never to write, fetch, or lock.
 */

import { withDirectGitOnly } from "./process.ts";

/**
 * Git's trace sinks. Each writes or appends to a file, directory, or socket
 * named in the environment or, for Trace2, in system or global configuration,
 * which these variables override; `0` turns a sink off. Inherited values are
 * dropped first, so only the configuration targets remain to override.
 */
const TRACE_SINKS = [
  "GIT_TRACE",
  "GIT_TRACE_CURL",
  "GIT_TRACE_FSMONITOR",
  "GIT_TRACE_PACK_ACCESS",
  "GIT_TRACE_PACKET",
  "GIT_TRACE_PACKFILE",
  "GIT_TRACE_PERFORMANCE",
  "GIT_TRACE_REFS",
  "GIT_TRACE_SETUP",
  "GIT_TRACE_SHALLOW",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
];

/**
 * The Git environment for read-only commands. Every inherited `GIT_*`
 * variable is dropped: one can make Git run another binary for its internal
 * commands (`GIT_EXEC_PATH`), add configuration after these settings
 * (`GIT_CONFIG_PARAMETERS`), write traces, or point Git at other
 * repositories, objects, or files, and read-only commands address each
 * repository by path. Then, overriding repository, global, and system
 * configuration: no optional index lock or refresh, no lazy fetch of missing
 * objects in a partial clone, no filesystem-monitor daemon (which writes
 * cookie files), no signature verification under `log.showSignature` (which
 * writes the signature to a temporary file for the verifier), and no trace
 * output. Child processes Git starts inherit the same environment.
 */
const readOnlyGitEnvironment = (
  environment: NodeJS.ProcessEnv
): Record<string, string | undefined> => ({
  ...Object.fromEntries(
    Object.keys(environment)
      .filter((name) => name.startsWith("GIT_"))
      .map((name) => [name, undefined])
  ),
  ...Object.fromEntries(TRACE_SINKS.map((name) => [name, "0"])),
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_KEY_1: "log.showSignature",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_VALUE_1: "false",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
});

/**
 * Runs `read` with read-only Git settings, restoring the environment after.
 * Git runs directly, never through xcrun or the macOS shim (see
 * `withDirectGitOnly`).
 */
export const withReadOnlyGit = <T>(read: () => T): T => {
  const overrides = readOnlyGitEnvironment(process.env);
  const previous = Object.keys(overrides).map(
    (name) => [name, process.env[name]] as const
  );
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
  try {
    return withDirectGitOnly(read);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }
};
