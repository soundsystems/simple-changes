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

const RUNTIME_IDENTITY = "Cursor Agent";
const TRUE_VALUE_PATTERN = /^(?:1|true|yes)$/iu;

const configuredModel = (): string | undefined => {
  const model = process.env.SIMPLE_CHANGES_CURSOR_MODEL?.trim();
  return model || undefined;
};

const forceAllowed = (): boolean =>
  TRUE_VALUE_PATTERN.test(
    process.env.SIMPLE_CHANGES_CURSOR_FORCE?.trim() ?? ""
  );

export const buildCursorEvalCommand = (
  prompt: string,
  executable = "cursor-agent",
  model = configuredModel(),
  force = forceAllowed()
): string[] => [
  executable,
  "--print",
  "--output-format",
  "text",
  ...(model ? ["--model", model] : []),
  ...(force ? ["--force"] : []),
  prompt,
];

export const runCursorEvalAdapter = async (
  request: RunnerRequest
): Promise<RunnerResponse> => {
  const snapshot = await createReadOnlyGuidanceSnapshot(
    request.guidanceDirectory,
    request.repository
  );
  try {
    const isolatedRequest = { ...request, guidanceDirectory: snapshot.path };
    const { prompt } = await loadEvalPrompt(isolatedRequest, RUNTIME_IDENTITY);
    const result = await runVendorProcess({
      cmd: buildCursorEvalCommand(prompt),
      cwd: request.repository,
      input: "",
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
    return parseRunnerResponse(result.stdout);
  } finally {
    await snapshot.cleanup();
  }
};

if (import.meta.main) {
  process.exitCode = await runAdapterEntrypoint(
    RUNTIME_IDENTITY,
    runCursorEvalAdapter
  );
}
