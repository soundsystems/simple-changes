import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

const testsDirectory = join(import.meta.dir, "tests");
const testFiles = (await readdir(testsDirectory))
  .filter((file) => file.endsWith(".check.ts"))
  .sort()
  .map((file) => join(testsDirectory, file));

if (testFiles.length === 0) {
  throw new Error(`No publish-skill checks found in ${testsDirectory}`);
}

// Bun's 5s default per-test timeout is too tight on machines with slow process
// creation, so this runner uses the same default, override variable, and
// ceiling as tooling/simple-changelogs/scripts/test.ts. An empty variable means
// unset; the ceiling is the JavaScript timer maximum.
const DEFAULT_TEST_TIMEOUT_MS = 30_000;
const MAX_TEST_TIMEOUT_MS = 2_147_483_647;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

const resolveTimeoutMs = (variable: string): number => {
  const raw = process.env[variable]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_TEST_TIMEOUT_MS;
  }
  if (
    !POSITIVE_INTEGER_PATTERN.test(raw) ||
    Number(raw) > MAX_TEST_TIMEOUT_MS
  ) {
    throw new Error(
      `${variable} must be a positive integer of milliseconds no greater than ${MAX_TEST_TIMEOUT_MS}; received ${JSON.stringify(raw)}`
    );
  }
  return Number(raw);
};

const timeoutMs = resolveTimeoutMs("SIMPLE_CHANGELOGS_TEST_TIMEOUT_MS");

const subprocess = spawn({
  cmd: [process.execPath, "test", "--timeout", String(timeoutMs), ...testFiles],
  stderr: "inherit",
  stdin: "inherit",
  stdout: "inherit",
});
process.exitCode = await subprocess.exited;
