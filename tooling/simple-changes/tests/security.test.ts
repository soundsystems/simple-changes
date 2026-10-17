import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controllerSessionIndexDirectory,
  listControllerSessionEntries,
  recordControllerSession,
} from "../../../skills/simple-changes/scripts/lib/harness-session.ts";
import {
  REMOTE_BRANCH_ANCESTRY_DIRECTORY,
  readReceiptSidecar,
  recoveryHistoryDirectory,
} from "../../../skills/simple-changes/scripts/lib/loop-lease-core.ts";
import { assertSafeRelativePath } from "../../../skills/simple-changes/scripts/lib/path-safety.ts";
import { redactSecrets } from "../../../skills/simple-changes/scripts/lib/redact.ts";
import { RUN_ID_PATTERN } from "../../../skills/simple-changes/scripts/lib/run-id.ts";
import type { LoopControllerSession } from "../../../skills/simple-changes/scripts/lib/types.ts";
import { createTestRepository, type TestRepository } from "./helpers.ts";

let repositories: TestRepository[] = [];
let scratch: string[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  for (const directory of scratch) {
    rmSync(directory, { force: true, recursive: true });
  }
  repositories = [];
  scratch = [];
});

// Run IDs that must never become a path segment: dot-only names reach the
// parent or the directory itself, and the rest are outside the grammar
// `loop start` mints.
const NOT_RUN_IDS = [".", "..", "...", "run-a/..", "run.a", "RUN-A", ""];

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

describe("run IDs in paths", () => {
  test("the shared run-ID grammar is the one the loop-lease schema pins", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../../skills/simple-changes/evals/schemas/loop-lease.schema.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { properties: { runId: { pattern: string } } };
    expect(RUN_ID_PATTERN.source).toBe(schema.properties.runId.pattern);
    for (const runId of NOT_RUN_IDS) {
      expect(RUN_ID_PATTERN.test(runId)).toBe(false);
    }
    expect(RUN_ID_PATTERN.test("run-mgtk3f0a-1b2c3d4e")).toBe(true);
  });

  test("loop history and receipt paths refuse a run ID outside the grammar", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const common = join(fixture.root, ".git");
    for (const runId of NOT_RUN_IDS) {
      expect(() => recoveryHistoryDirectory(common, runId)).toThrow("run ID");
      expect(() =>
        readReceiptSidecar(common, REMOTE_BRANCH_ANCESTRY_DIRECTORY, runId)
      ).toThrow("run ID");
    }
    expect(recoveryHistoryDirectory(common, "run-a")).toBe(
      join(realpathSync(common), "simple-changes", "history", "run-a")
    );
    expect(
      readReceiptSidecar(common, REMOTE_BRANCH_ANCESTRY_DIRECTORY, "run-a")
    ).toBe(null);
  });

  test("the controller-session index never records a run ID outside the grammar", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const configuration = mkdtempSync(join(tmpdir(), "run-id-sessions-"));
    scratch.push(configuration);
    const environment = { SIMPLE_CHANGES_CONFIG_DIR: configuration };
    const session: LoopControllerSession = {
      harness: "claude-code",
      hostname: "fixture-host",
      hostPid: null,
      sessionId: "fixture-session",
    };
    const common = join(fixture.root, ".git");
    for (const runId of NOT_RUN_IDS) {
      recordControllerSession(session, common, runId, environment);
    }
    expect(existsSync(controllerSessionIndexDirectory(environment))).toBe(
      false
    );

    recordControllerSession(session, common, "run-a", environment);
    expect(
      listControllerSessionEntries(session.sessionId, environment).map(
        (entry) => entry.runId
      )
    ).toEqual(["run-a"]);
  });
});
