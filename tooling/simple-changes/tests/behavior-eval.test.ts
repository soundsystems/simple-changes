import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeEvalCommand,
  extractClaudeFinalResponse,
} from "../adapters/claude-eval.ts";
import { buildCodexEvalCommand } from "../adapters/codex-eval.ts";
import { buildCursorEvalCommand } from "../adapters/cursor-eval.ts";
import { createReadOnlyGuidanceSnapshot } from "../adapters/eval-shared.ts";
import {
  buildGrokEvalCommand,
  extractGrokFinalResponse,
} from "../adapters/grok-eval.ts";
import {
  buildHermesEvalInvocation,
  buildHermesPromptRequest,
} from "../adapters/hermes-eval.ts";
import { inspectAssertions } from "../behavior-eval.ts";

const request = {
  caseId: "case",
  guidanceDirectory: "/tmp/guidance",
  prompt: "prompt",
  readOnly: false,
  repository: "/tmp/repository",
  responseSchema: "/tmp/response.schema.json",
  schemaVersion: 1 as const,
};

describe("model behavior evaluation", () => {
  test("inspects fixture files independently of adapter claims", () => {
    const directory = mkdtempSync(join(tmpdir(), "simple-changes-assertions-"));
    try {
      writeFileSync(join(directory, "CHANGELOG.md"), "## 1.0.0\n\n- Ready.\n");

      expect(
        inspectAssertions(directory, [
          {
            contains: ["## 1.0.0"],
            exists: true,
            notContains: ["## Unreleased"],
            path: "CHANGELOG.md",
          },
        ])
      ).toEqual([]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("builds the Codex command as an argument array", () => {
    const command = buildCodexEvalCommand(
      request,
      "/tmp/output.json",
      "codex-test"
    );

    expect(command[0]).toBe("codex-test");
    expect(command).toContain("--ephemeral");
    expect(command).toContain("--ignore-user-config");
    expect(command).toContain("--ignore-rules");
    expect(command).toContain("--output-schema");
    expect(command).toContain("/tmp/response.schema.json");
    expect(command.at(-1)).toBe("-");
  });

  test("builds a sandboxed Claude Code command", () => {
    const command = buildClaudeEvalCommand(
      request,
      '{"type":"object"}',
      "claude-test",
      "claude-model"
    );

    expect(command[0]).toBe("claude-test");
    expect(command).toContain("--safe-mode");
    expect(command).toContain("--no-session-persistence");
    expect(command).toContain("claude-model");
    expect(command).toContain('{"type":"object"}');
  });

  test("extracts Claude structured output", () => {
    expect(
      extractClaudeFinalResponse(
        JSON.stringify({
          is_error: false,
          structured_output: {
            caseId: "case",
            errors: [],
            plan: null,
            report: "done",
            schemaVersion: 1,
            status: "passed",
          },
          type: "result",
        })
      )
    ).toMatchObject({ caseId: "case", status: "passed" });
  });

  test("builds an isolated Hermes Docker invocation", () => {
    const invocation = buildHermesEvalInvocation(
      request,
      "prompt",
      "/tmp/repository/.simple-changes-guidance-test",
      {
        executable: "hermes-test",
        model: "model",
        provider: "provider",
      }
    );

    expect(invocation.cmd[0]).toBe("hermes-test");
    expect(invocation.cmd).toContain("--ignore-user-config");
    expect(invocation.cmd).toContain("provider");
    expect(invocation.env?.TERMINAL_ENV).toBe("docker");
    expect(invocation.env?.TERMINAL_DOCKER_NETWORK).toBe("false");
    expect(
      buildHermesPromptRequest(
        request,
        "/tmp/repository/.simple-changes-guidance-test"
      )
    ).toMatchObject({
      guidanceDirectory: "./.simple-changes-guidance-test",
      repository: ".",
    });
  });

  test("builds Cursor commands with explicit force opt-in", () => {
    const safe = buildCursorEvalCommand(
      "prompt",
      "cursor-test",
      "cursor-model",
      false
    );
    const forced = buildCursorEvalCommand(
      "prompt",
      "cursor-test",
      "cursor-model",
      true
    );

    expect(safe[0]).toBe("cursor-test");
    expect(safe).not.toContain("--force");
    expect(forced).toContain("--force");
    expect(forced.at(-1)).toBe("prompt");
  });

  test("builds a strict, nonpersistent Grok Build command", () => {
    const command = buildGrokEvalCommand(
      request,
      "prompt",
      "grok-test",
      "grok-build",
      "medium"
    );

    expect(command[0]).toBe("grok-test");
    expect(command).toContain("grok-build");
    expect(command).toContain("--sandbox");
    expect(command).toContain("strict");
    expect(command).toContain("--no-memory");
    expect(command).toContain("--no-subagents");
    expect(command).toContain("--disable-web-search");
  });

  test("extracts Grok Build JSON output", () => {
    const response: ReturnType<typeof extractGrokFinalResponse> = {
      caseId: "case",
      errors: [],
      plan: null,
      report: "done",
      schemaVersion: 1,
      status: "passed",
    };

    expect(
      extractGrokFinalResponse(
        JSON.stringify({ text: JSON.stringify(response) })
      )
    ).toEqual(response);
  });

  test("copies a permission-locked guidance snapshot and removes it", async () => {
    const base = mkdtempSync(join(tmpdir(), "simple-changes-snapshot-test-"));
    const guidance = join(base, "guidance");
    const repository = join(base, "repository");
    mkdirSync(guidance);
    mkdirSync(repository);
    writeFileSync(join(guidance, "release-notes.md"), "guidance");

    try {
      const snapshot = await createReadOnlyGuidanceSnapshot(
        guidance,
        repository
      );
      expect(
        readFileSync(join(snapshot.path, "release-notes.md"), "utf8")
      ).toBe("guidance");
      expect(statSync(snapshot.path).mode.toString(8)).toEndWith("555");
      expect(
        statSync(join(snapshot.path, "release-notes.md")).mode.toString(8)
      ).toEndWith("444");
      await snapshot.cleanup();
      expect(() => statSync(snapshot.path)).toThrow();
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });
});
