#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
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

const RUNTIME_IDENTITY = "Codex CLI";

export const buildCodexEvalCommand = (
  request: RunnerRequest,
  outputPath: string,
  executable = "codex"
): string[] => {
  const configuredModel = process.env.SIMPLE_CHANGES_CODEX_MODEL?.trim();
  const modelArguments = configuredModel ? ["--model", configuredModel] : [];
  return [
    executable,
    "exec",
    "--config",
    "mcp_servers={}",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    ...modelArguments,
    "--cd",
    request.repository,
    "--sandbox",
    "workspace-write",
    "--json",
    "--output-schema",
    request.responseSchema,
    "--output-last-message",
    outputPath,
    "-",
  ];
};

export const runCodexEvalAdapter = async (
  request: RunnerRequest
): Promise<RunnerResponse> => {
  const snapshot = await createReadOnlyGuidanceSnapshot(
    request.guidanceDirectory,
    request.repository
  );
  const outputPath = join(
    request.repository,
    `.simple-changes-codex-${randomUUID()}.json`
  );
  try {
    const isolatedRequest = { ...request, guidanceDirectory: snapshot.path };
    const { prompt } = await loadEvalPrompt(isolatedRequest, RUNTIME_IDENTITY);
    const result = await runVendorProcess({
      cmd: buildCodexEvalCommand(isolatedRequest, outputPath),
      cwd: request.repository,
      input: `${prompt}\n`,
    });
    if (result.stdout.trim()) {
      process.stderr.write(result.stdout);
    }
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
    return parseRunnerResponse(await readFile(outputPath, "utf8"));
  } finally {
    await rm(outputPath, { force: true }).catch(() => undefined);
    await snapshot.cleanup();
  }
};

if (import.meta.main) {
  process.exitCode = await runAdapterEntrypoint(
    RUNTIME_IDENTITY,
    runCodexEvalAdapter
  );
}
