/**
 * Read-only Git for commands that promise never to write, fetch, or lock.
 */

/**
 * Git settings that keep every read from writing or fetching: no optional
 * index lock or refresh, no lazy fetch of missing objects in a partial clone,
 * and no filesystem-monitor daemon, which writes cookie files.
 */
const readOnlyGitEnvironment = (
  environment: NodeJS.ProcessEnv
): Record<string, string> => {
  const count = Number.parseInt(environment.GIT_CONFIG_COUNT ?? "0", 10);
  const next = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  return {
    GIT_CONFIG_COUNT: String(next + 1),
    [`GIT_CONFIG_KEY_${next}`]: "core.fsmonitor",
    [`GIT_CONFIG_VALUE_${next}`]: "false",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
};

/** Runs `read` with read-only Git settings, restoring the environment after. */
export const withReadOnlyGit = <T>(read: () => T): T => {
  const overrides = readOnlyGitEnvironment(process.env);
  const previous = Object.keys(overrides).map(
    (name) => [name, process.env[name]] as const
  );
  Object.assign(process.env, overrides);
  try {
    return read();
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
