import { afterEach, describe, expect, test } from "bun:test";
import { assertSafeRelativePath } from "../../../skills/simple-changes/scripts/lib/path-safety.ts";
import { redactSecrets } from "../../../skills/simple-changes/scripts/lib/redact.ts";
import { createTestRepository, type TestRepository } from "./helpers.ts";

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("security boundaries", () => {
  test("rejects absolute and traversing paths", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    expect(() => assertSafeRelativePath(fixture.root, "../outside")).toThrow(
      "Unsafe"
    );
    expect(() => assertSafeRelativePath(fixture.root, "/tmp/outside")).toThrow(
      "Unsafe"
    );
  });

  test("redacts common provider credentials", () => {
    const message =
      "Authorization: Bearer abcdef123456 token=glpat-supersecretvalue";
    const redacted = redactSecrets(message);
    expect(redacted).not.toContain("abcdef123456");
    expect(redacted).not.toContain("glpat-supersecretvalue");
    expect(redacted).toContain("[REDACTED]");
  });
});
