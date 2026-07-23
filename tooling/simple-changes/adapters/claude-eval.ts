#!/usr/bin/env bun

import {
  createReadOnlyGuidanceSnapshot,
  failureResponse,
  loadEvalPrompt,
  parseRunnerResponse,
  type RunnerRequest,
  type RunnerResponse,
  runAdapterEntrypoint,
  runVendorProcess,
  vendorFailureMessage,
} from "./eval-shared.ts";

const RUNTIME_IDENTITY = "Claude Code";

const configuredModel = (): string | undefined => {
  const model = process.env.SIMPLE_CHANGES_CLAUDE_MODEL?.trim();
  return model || undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodePointerSegment = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

const referencedSchema = (
  root: Record<string, unknown>,
  reference: string
): unknown => {
  if (!reference.startsWith("#/")) {
    throw new Error(
      `Claude schema supports only local references: ${reference}`
    );
  }
  let current: unknown = root;
  for (const segment of reference.slice(2).split("/")) {
    if (!isRecord(current)) {
      throw new Error(`Claude schema reference is invalid: ${reference}`);
    }
    current = current[decodePointerSegment(segment)];
  }
  if (current === undefined) {
    throw new Error(`Claude schema reference was not found: ${reference}`);
  }
  return current;
};

const dereferenceSchema = (root: Record<string, unknown>): unknown => {
  const visit = (value: unknown, activeReferences: Set<string>): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => visit(item, activeReferences));
    }
    if (!isRecord(value)) {
      return value;
    }

    const reference = typeof value.$ref === "string" ? value.$ref : undefined;
    if (reference) {
      if (activeReferences.has(reference)) {
        throw new Error(`Claude schema reference is circular: ${reference}`);
      }
      const resolved = visit(
        referencedSchema(root, reference),
        new Set(activeReferences).add(reference)
      );
      if (!isRecord(resolved)) {
        throw new Error(
          `Claude schema reference is not an object: ${reference}`
        );
      }
      const siblings = Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "$ref")
          .map(([key, item]) => [key, visit(item, activeReferences)])
      );
      return { ...resolved, ...siblings };
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["$defs", "$id", "$schema"].includes(key))
        .map(([key, item]) => [key, visit(item, activeReferences)])
    );
  };

  return visit(root, new Set());
};

export const prepareClaudeResponseSchema = (responseSchema: string): string => {
  const parsed: unknown = JSON.parse(responseSchema);
  if (!isRecord(parsed)) {
    throw new Error("Claude response schema must be a JSON object");
  }
  return JSON.stringify(dereferenceSchema(parsed));
};

export const buildClaudeSandboxSettings = (request: RunnerRequest): string =>
  JSON.stringify({
    sandbox: {
      allowUnsandboxedCommands: false,
      enabled: true,
      failIfUnavailable: true,
      filesystem: {
        allowRead: [request.repository, request.guidanceDirectory],
        allowWrite: [request.repository],
        denyRead: ["/"],
        denyWrite: [request.guidanceDirectory],
      },
    },
  });

export const buildClaudeEvalCommand = (
  request: RunnerRequest,
  responseSchema: string,
  executable = "claude",
  model = configuredModel()
): string[] => [
  executable,
  "--print",
  "--output-format",
  "json",
  "--safe-mode",
  "--no-session-persistence",
  "--no-chrome",
  ...(model ? ["--model", model] : []),
  "--permission-mode",
  "dontAsk",
  "--tools",
  "Edit,Write,Bash",
  "--allowedTools",
  "Edit,Write,Bash",
  "--settings",
  buildClaudeSandboxSettings(request),
  "--json-schema",
  responseSchema,
];

export const extractClaudeFinalResponse = (text: string): RunnerResponse => {
  const envelope: unknown = JSON.parse(text);
  if (
    !isRecord(envelope) ||
    envelope.type !== "result" ||
    envelope.is_error === true
  ) {
    throw new Error("Claude Code did not return a successful result envelope");
  }
  if (isRecord(envelope.structured_output)) {
    return parseRunnerResponse(JSON.stringify(envelope.structured_output));
  }
  if (typeof envelope.result !== "string") {
    throw new Error("Claude Code result envelope has no final response");
  }
  return parseRunnerResponse(envelope.result);
};

export const runClaudeEvalAdapter = async (
  request: RunnerRequest
): Promise<RunnerResponse> => {
  const snapshot = await createReadOnlyGuidanceSnapshot(
    request.guidanceDirectory,
    request.repository
  );
  try {
    const isolatedRequest = { ...request, guidanceDirectory: snapshot.path };
    const { prompt, responseSchema } = await loadEvalPrompt(
      isolatedRequest,
      RUNTIME_IDENTITY
    );
    const result = await runVendorProcess({
      cmd: buildClaudeEvalCommand(
        isolatedRequest,
        prepareClaudeResponseSchema(responseSchema)
      ),
      cwd: request.repository,
      input: `${prompt}\n`,
    });
    if (result.stderr.trim()) {
      process.stderr.write(result.stderr);
    }
    if (result.error || result.exitCode !== 0) {
      return failureResponse(
        request,
        RUNTIME_IDENTITY,
        vendorFailureMessage(RUNTIME_IDENTITY, result)
      );
    }
    return extractClaudeFinalResponse(result.stdout);
  } finally {
    await snapshot.cleanup();
  }
};

if (import.meta.main) {
  process.exitCode = await runAdapterEntrypoint(
    RUNTIME_IDENTITY,
    runClaudeEvalAdapter
  );
}
