// Bun's 5s default per-test timeout fails spawn-heavy tests spuriously when
// process creation is slow, and on a machine busy with other agents it often
// is. Every test runner here passes `bun test --timeout` with this generous
// default instead; a genuinely hung test still fails, only later. One
// variable overrides it for every runner. An empty variable means unset, and
// the ceiling is the JavaScript timer maximum, the longest wait a per-test
// timeout can represent. A file's own `setDefaultTimeout` still wins.
export const TEST_TIMEOUT_VARIABLE = "SIMPLE_CHANGES_TEST_TIMEOUT_MS";
export const DEFAULT_TEST_TIMEOUT_MS = 30_000;
export const MAX_TEST_TIMEOUT_MS = 2_147_483_647;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;

export const resolveTestTimeoutMs = (
  environment: Record<string, string | undefined> = process.env
): number => {
  const raw = environment[TEST_TIMEOUT_VARIABLE]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_TEST_TIMEOUT_MS;
  }
  if (
    !POSITIVE_INTEGER_PATTERN.test(raw) ||
    Number(raw) > MAX_TEST_TIMEOUT_MS
  ) {
    throw new Error(
      `${TEST_TIMEOUT_VARIABLE} must be a positive integer of milliseconds no greater than ${MAX_TEST_TIMEOUT_MS}; received ${JSON.stringify(raw)}`
    );
  }
  return Number(raw);
};
