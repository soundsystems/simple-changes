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
import { toolingSchemaPath } from "../schema.ts";

// `codex exec --output-schema` sends the schema to OpenAI Structured Outputs
// in strict mode, which rejects the whole request for any keyword outside its
// subset: on 2026-10-07 a live probe through Codex CLI 0.160.1 accepted the
// runner response schema and returned HTTP 400 once `uniqueItems` was added.
// Keywords are allowlisted from that probe and the documented supported
// subset, so a new keyword fails here until it has been checked; enforce any
// other constraint after parsing instead.
const STRICT_OUTPUT_SCHEMA_KEYWORDS = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "anyOf",
  "const",
  "description",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "multipleOf",
  "pattern",
  "properties",
  "required",
  "title",
  "type",
]);

const strictOutputSchemaProblems = (
  schema: Record<string, unknown>,
  path = "#"
): string[] => {
  const problems = Object.keys(schema)
    .filter((keyword) => !STRICT_OUTPUT_SCHEMA_KEYWORDS.has(keyword))
    .map((keyword) => `${path}/${keyword} is not allowed in strict mode`);
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    if (schema.additionalProperties !== false) {
      problems.push(`${path} must set additionalProperties: false`);
    }
    const required = new Set((schema.required ?? []) as string[]);
    for (const name of Object.keys(properties)) {
      if (!required.has(name)) {
        problems.push(`${path}/properties/${name} must be required`);
      }
    }
  }
  const children: [string, unknown][] = [
    ...Object.entries(properties).map(([name, child]): [string, unknown] => [
      `properties/${name}`,
      child,
    ]),
    ...Object.entries(
      (schema.$defs ?? {}) as Record<string, Record<string, unknown>>
    ).map(([name, child]): [string, unknown] => [`$defs/${name}`, child]),
    ...((schema.anyOf ?? []) as unknown[]).map(
      (child, index): [string, unknown] => [`anyOf/${index}`, child]
    ),
    ["items", schema.items],
  ];
  for (const [childPath, child] of children) {
    if (child !== null && typeof child === "object") {
      problems.push(
        ...strictOutputSchemaProblems(
          child as Record<string, unknown>,
          `${path}/${childPath}`
        )
      );
    }
  }
  return problems;
};

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

  test("keeps the Codex output schema inside strict Structured Outputs", () => {
    const schema = JSON.parse(
      readFileSync(toolingSchemaPath("runner-response"), "utf8")
    ) as Record<string, unknown>;

    expect(strictOutputSchemaProblems(schema)).toEqual([]);
    expect(
      strictOutputSchemaProblems({
        additionalProperties: false,
        properties: {
          errors: {
            items: { type: "string" },
            type: "array",
            uniqueItems: true,
          },
          note: { type: "string" },
        },
        required: ["errors"],
        type: "object",
      })
    ).toEqual([
      "#/properties/note must be required",
      "#/properties/errors/uniqueItems is not allowed in strict mode",
    ]);
    expect(
      strictOutputSchemaProblems({
        properties: {
          nested: {
            properties: { value: { type: "string" } },
            type: ["object", "null"],
          },
        },
        required: ["nested"],
        type: "object",
      })
    ).toEqual([
      "# must set additionalProperties: false",
      "#/properties/nested must set additionalProperties: false",
      "#/properties/nested/properties/value must be required",
    ]);
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
