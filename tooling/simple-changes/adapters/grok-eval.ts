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

const RUNTIME_IDENTITY = "Grok Build";

const configuredModel = (): string =>
  process.env.SIMPLE_CHANGES_GROK_MODEL?.trim() || "grok-build";

const configuredEffort = (): string | undefined => {
  const effort = process.env.SIMPLE_CHANGES_GROK_REASONING_EFFORT?.trim();
  return effort || undefined;
};

export const buildGrokEvalCommand = (
  request: RunnerRequest,
  prompt: string,
  executable = "grok",
  model = configuredModel(),
  effort = configuredEffort()
): string[] => [
  executable,
  "--single",
  prompt,
  "--output-format",
  "json",
  "--cwd",
  request.repository,
  "--model",
  model,
  ...(effort ? ["--reasoning-effort", effort] : []),
  "--sandbox",
  "strict",
  "--always-approve",
  "--check",
  "--no-memory",
  "--no-subagents",
  "--disable-web-search",
  "--no-plan",
  "--verbatim",
  "--max-turns",
  "90",
  "--deny",
  "Bash(git push*)",
  "--deny",
  "Bash(ssh *)",
  "--deny",
  "Bash(curl *)",
  "--deny",
  "Bash(wget *)",
];

export const extractGrokFinalResponse = (text: string): RunnerResponse => {
  const envelope = JSON.parse(text) as {
    message?: unknown;
    text?: unknown;
    type?: unknown;
  };
  if (envelope.type === "error") {
    throw new Error(
      typeof envelope.message === "string"
        ? envelope.message
        : "Grok Build returned an error"
    );
  }
  if (typeof envelope.text !== "string") {
    throw new Error("Grok Build result envelope has no final response");
  }
  return parseRunnerResponse(envelope.text);
};

export const runGrokEvalAdapter = async (
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
      cmd: buildGrokEvalCommand(isolatedRequest, prompt),
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
    return extractGrokFinalResponse(result.stdout);
  } finally {
    await snapshot.cleanup();
  }
};

if (import.meta.main) {
  process.exitCode = await runAdapterEntrypoint(
    RUNTIME_IDENTITY,
    runGrokEvalAdapter
  );
}
