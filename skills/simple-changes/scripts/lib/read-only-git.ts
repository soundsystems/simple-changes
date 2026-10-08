/**
 * Read-only Git for commands that promise never to write, fetch, or lock.
 */

import { withDirectGitOnly } from "./process.ts";

/**
 * Git settings that keep every read from writing or fetching: no optional
 * index lock or refresh, no lazy fetch of missing objects in a partial clone,
 * no filesystem-monitor daemon, which writes cookie files, and no signature
 * verification under `log.showSignature`, which writes the signature to a
 * temporary file for the verifier. These override repository configuration.
 */
const readOnlyGitEnvironment = (
  environment: NodeJS.ProcessEnv
): Record<string, string> => {
  const count = Number.parseInt(environment.GIT_CONFIG_COUNT ?? "0", 10);
  const next = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  return {
    GIT_CONFIG_COUNT: String(next + 2),
    [`GIT_CONFIG_KEY_${next}`]: "core.fsmonitor",
    [`GIT_CONFIG_VALUE_${next}`]: "false",
    [`GIT_CONFIG_KEY_${next + 1}`]: "log.showSignature",
    [`GIT_CONFIG_VALUE_${next + 1}`]: "false",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
};

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
  Object.assign(process.env, overrides);
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
