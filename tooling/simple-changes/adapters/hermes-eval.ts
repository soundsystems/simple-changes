#!/usr/bin/env bun

import { basename, isAbsolute, relative, sep } from "node:path";
import {
  createReadOnlyGuidanceSnapshot,
  failureResponse,
  loadEvalPrompt,
  parseRunnerResponse,
  type RunnerRequest,
  type RunnerResponse,
  runAdapterEntrypoint,
  runVendorProcess,
  type VendorProcessSpec,
  vendorFailureMessage,
} from "./eval-shared.ts";

const RUNTIME_IDENTITY = "Hermes Agent";

const configuredValue = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value || undefined;
};

export interface HermesEvalOptions {
  executable?: string;
  model?: string;
  provider?: string;
  terminalBackend?: string;
}

export const buildHermesEnvironment = (
  repository: string,
  snapshotPath: string,
  terminalBackend = configuredValue("SIMPLE_CHANGES_HERMES_TERMINAL_ENV") ??
    "docker"
): Record<string, string> => {
  if (terminalBackend !== "docker") {
    throw new Error(
      "The Hermes adapter requires the Docker terminal backend for isolation"
    );
  }
  return {
    TERMINAL_CONTAINER_PERSISTENT: "false",
    TERMINAL_DOCKER_NETWORK: "false",
    TERMINAL_DOCKER_PERSIST_ACROSS_PROCESSES: "false",
    TERMINAL_DOCKER_VOLUMES: JSON.stringify([
      `${repository}:/workspace`,
      `${snapshotPath}:/workspace/${basename(snapshotPath)}:ro`,
    ]),
    TERMINAL_ENV: "docker",
  };
};

export const buildHermesPromptRequest = (
  request: RunnerRequest,
  snapshotPath: string
): RunnerRequest => {
  const localPath = relative(request.repository, snapshotPath)
    .split(sep)
    .join("/");
  if (
    localPath === "" ||
    isAbsolute(localPath) ||
    localPath === ".." ||
    localPath.startsWith("../")
  ) {
    throw new Error(
      "The Hermes guidance snapshot must remain inside the evaluation repository"
    );
  }
  return {
    ...request,
    guidanceDirectory: `./${localPath}`,
    repository: ".",
  };
};

export const buildHermesEvalInvocation = (
  request: RunnerRequest,
  prompt: string,
  snapshotPath: string,
  options: HermesEvalOptions = {}
): VendorProcessSpec => {
  const provider =
    options.provider ?? configuredValue("SIMPLE_CHANGES_HERMES_PROVIDER");
  const model = options.model ?? configuredValue("SIMPLE_CHANGES_HERMES_MODEL");
  return {
    cmd: [
      options.executable ?? "hermes",
      "chat",
      "--ignore-user-config",
      "--ignore-rules",
      "--quiet",
      "--toolsets",
      "terminal",
      "--source",
      "tool",
      "--max-turns",
      "90",
      ...(provider ? ["--provider", provider] : []),
      ...(model ? ["--model", model] : []),
      "--query",
      prompt,
    ],
    cwd: request.repository,
    env: buildHermesEnvironment(
      request.repository,
      snapshotPath,
      options.terminalBackend
    ),
    input: "",
    removeEnvKeys: ["HERMES_DOCKER_BINARY"],
    removeEnvPrefixes: ["TERMINAL_"],
  };
};

export const runHermesEvalAdapter = async (
  request: RunnerRequest
): Promise<RunnerResponse> => {
  const snapshot = await createReadOnlyGuidanceSnapshot(
    request.guidanceDirectory,
    request.repository
  );
  try {
    const promptRequest = buildHermesPromptRequest(request, snapshot.path);
    const { prompt } = await loadEvalPrompt(promptRequest, RUNTIME_IDENTITY);
    const result = await runVendorProcess(
      buildHermesEvalInvocation(request, prompt, snapshot.path)
    );
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
    runHermesEvalAdapter
  );
}
