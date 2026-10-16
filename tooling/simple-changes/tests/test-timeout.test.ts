import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TEST_TIMEOUT_MS,
  MAX_TEST_TIMEOUT_MS,
  resolveTestTimeoutMs,
  TEST_TIMEOUT_VARIABLE,
} from "../../test-timeout.ts";

const root = join(import.meta.dir, "..", "..", "..");
const resolve = (value: string | undefined) =>
  resolveTestTimeoutMs({ [TEST_TIMEOUT_VARIABLE]: value });

describe("test timeout", () => {
  test("defaults when the variable is unset or blank, and reads a positive integer", () => {
    expect(resolveTestTimeoutMs({})).toBe(DEFAULT_TEST_TIMEOUT_MS);
    expect(resolve(undefined)).toBe(DEFAULT_TEST_TIMEOUT_MS);
    expect(resolve("")).toBe(DEFAULT_TEST_TIMEOUT_MS);
    expect(resolve("  ")).toBe(DEFAULT_TEST_TIMEOUT_MS);
    expect(resolve("45000")).toBe(45_000);
    expect(resolve(" 45000 ")).toBe(45_000);
    expect(resolve(String(MAX_TEST_TIMEOUT_MS))).toBe(MAX_TEST_TIMEOUT_MS);
  });

  test("refuses anything that is not a positive integer within the timer limit", () => {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "1e5",
      "045000",
      "30s",
      "abc",
      String(MAX_TEST_TIMEOUT_MS + 1),
    ]) {
      expect(() => resolve(value)).toThrow(TEST_TIMEOUT_VARIABLE);
    }
  });

  test("bun run test goes only through runners that pass the timeout", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8")
    ) as { scripts: { test: string } };
    const runners = manifest.scripts.test.split(" && ");
    expect(runners).toEqual([
      "bun tooling/simple-changes/test.ts",
      "bun tooling/publish-skill/scripts/test.ts",
      "bun tooling/update-local-forks/scripts/test.ts",
    ]);
    for (const runner of runners) {
      const source = readFileSync(
        join(root, runner.replace("bun ", "")),
        "utf8"
      );
      expect(source).toContain('"--timeout"');
      expect(source).toContain("String(resolveTestTimeoutMs())");
    }
  });
});
