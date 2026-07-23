import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { spawn, stdin } from "bun";
import { validateToolingSchema } from "../schema.ts";

export interface RunnerRequest {
  caseId: string;
  guidanceDirectory: string;
  prompt: string;
  readOnly: boolean;
  repository: string;
  responseSchema: string;
  schemaVersion: 1;
}

export interface RunnerResponse {
  caseId: string;
  errors: string[];
  plan: null;
  report: string;
  schemaVersion: 1;
  status: "passed" | "failed" | "blocked";
}

export interface ReadOnlySkillSnapshot {
  cleanup: () => Promise<void>;
  path: string;
}

export interface VendorProcessSpec {
  cmd: string[];
  cwd: string;
  env?: Record<string, string>;
  input: string;
  removeEnvKeys?: string[];
  removeEnvPrefixes?: string[];
}

export interface VendorProcessResult {
  error?: unknown;
  exitCode?: number;
  stderr: string;
  stdout: string;
}

const AUTHENTICATION_FAILURE_PATTERN =
  /authenticat|not logged in|log[ -]?in required|unauthorized|api[ _-]?key|oauth|credential/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error.code === "string" ? error.code : undefined;

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
};

const setReadOnly = async (root: string): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill snapshots may not contain symlinks: ${path}`);
      }
      if (entry.isDirectory()) {
        await setReadOnly(path);
        return;
      }
      await chmod(path, 0o444);
    })
  );
  await chmod(root, 0o555);
};

const setWritable = async (root: string): Promise<void> => {
  await chmod(root, 0o700).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true }).catch(
    () => undefined
  );
  if (!entries) {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) {
        await rm(path, { force: true });
      } else if (entry.isDirectory()) {
        await setWritable(path);
      } else {
        await chmod(path, 0o600).catch(() => undefined);
      }
    })
  );
};

export const createReadOnlyGuidanceSnapshot = async (
  guidanceDirectory: string,
  repository: string
): Promise<ReadOnlySkillSnapshot> => {
  const [skillStat, repositoryStat] = await Promise.all([
    lstat(guidanceDirectory),
    lstat(repository),
  ]);
  if (skillStat.isSymbolicLink() || !skillStat.isDirectory()) {
    throw new Error(
      `Guidance directory must be a real directory: ${guidanceDirectory}`
    );
  }
  if (repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory()) {
    throw new Error(`Repository must be a real directory: ${repository}`);
  }
  const [source, canonicalRepository] = await Promise.all([
    realpath(guidanceDirectory),
    realpath(repository),
  ]);
  const sourceToRepository = relative(source, canonicalRepository);
  const repositoryToSource = relative(canonicalRepository, source);
  const pathsOverlap = [sourceToRepository, repositoryToSource].some(
    (path) =>
      path === "" ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
  if (pathsOverlap) {
    throw new Error(
      "Guidance directory and repository must not contain each other"
    );
  }

  const snapshot = join(
    canonicalRepository,
    `.simple-changes-guidance-${randomUUID()}`
  );
  const cleanup = async (): Promise<void> => {
    await setWritable(snapshot);
    await rm(snapshot, { force: true, recursive: true });
  };
  try {
    await cp(source, snapshot, { recursive: true });
    await setReadOnly(snapshot);
    return { cleanup, path: snapshot };
  } catch (error) {
    await cleanup();
    throw new Error("Unable to create a read-only guidance snapshot", {
      cause: error,
    });
  }
};

export const buildEvalPrompt = (
  request: RunnerRequest,
  responseSchema: string,
  runtimeIdentity: string
): string => `You are running one isolated Simple Changes release-note evaluation through ${runtimeIdentity}.

Use the repository-maintainer release module at
${request.guidanceDirectory}/release-notes.md. Read only the references it
routes you to. This module is not the public Simple Changes skill.

Work only inside this evaluation repository: ${request.repository}
Treat the guidance directory as read-only. Do not contact remotes, publish,
deploy, install software, or modify global agent configuration. If the release
policy calls for an agent signature, use "${runtimeIdentity}" as the agent
identity unless the runtime exposes a more exact model identity.

User request:
${request.prompt}

Complete the repository work and verify the resulting files. Then return
exactly one JSON object matching the response schema below. Set plan to null.
Put a concise ordinary handoff in report. Use status "passed" only when the
repository work and verification completed. The harness verifies file effects
independently, so do not treat self-reported mutations as proof.

Response schema:
${responseSchema}`;

export const loadEvalPrompt = async (
  request: RunnerRequest,
  runtimeIdentity: string
): Promise<{ prompt: string; responseSchema: string }> => {
  const responseSchema = await readFile(request.responseSchema, "utf8");
  return {
    prompt: buildEvalPrompt(request, responseSchema, runtimeIdentity),
    responseSchema,
  };
};

export const parseRunnerResponse = (text: string): RunnerResponse => {
  const trimmed = text.trim();
  let input: unknown;
  try {
    input = JSON.parse(trimmed);
  } catch (error) {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("Vendor final response is not valid JSON", {
        cause: error,
      });
    }
    input = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as unknown;
  }
  return validateToolingSchema<RunnerResponse>("runner-response", input);
};

export const failureResponse = (
  request: RunnerRequest,
  runtimeIdentity: string,
  message: string
): RunnerResponse => ({
  caseId: request.caseId,
  errors: [message],
  plan: null,
  report: `${runtimeIdentity}: ${message}`,
  schemaVersion: 1,
  status: "failed",
});

export const runVendorProcess = async (
  spec: VendorProcessSpec
): Promise<VendorProcessResult> => {
  try {
    const env = { ...process.env };
    for (const key of spec.removeEnvKeys ?? []) {
      delete env[key];
    }
    for (const key of Object.keys(env)) {
      if (spec.removeEnvPrefixes?.some((prefix) => key.startsWith(prefix))) {
        delete env[key];
      }
    }
    Object.assign(env, spec.env);
    const subprocess = spawn({
      cmd: spec.cmd,
      cwd: spec.cwd,
      env,
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
    });
    const stdout = new Response(subprocess.stdout).text();
    const stderr = new Response(subprocess.stderr).text();
    await subprocess.stdin.write(spec.input);
    await subprocess.stdin.end();
    const [exitCode, capturedStdout, capturedStderr] = await Promise.all([
      subprocess.exited,
      stdout,
      stderr,
    ]);
    return {
      exitCode,
      stderr: capturedStderr,
      stdout: capturedStdout,
    };
  } catch (error) {
    return { error, stderr: "", stdout: "" };
  }
};

export const vendorFailureMessage = (
  runtimeIdentity: string,
  result: VendorProcessResult
): string => {
  if (errorCode(result.error) === "ENOENT") {
    return `${runtimeIdentity} executable was not found`;
  }
  const detail = [result.stderr, result.stdout, errorMessage(result.error)]
    .filter(Boolean)
    .join("\n");
  if (AUTHENTICATION_FAILURE_PATTERN.test(detail)) {
    return `${runtimeIdentity} authentication is required`;
  }
  if (result.error) {
    return `${runtimeIdentity} could not be started: ${errorMessage(result.error)}`;
  }
  return `${runtimeIdentity} exited with status ${result.exitCode ?? "unknown"}`;
};

export const runAdapterEntrypoint = async (
  runtimeIdentity: string,
  execute: (request: RunnerRequest) => Promise<RunnerResponse>
): Promise<number> => {
  let request: RunnerRequest;
  try {
    request = validateToolingSchema<RunnerRequest>(
      "runner-request",
      JSON.parse(await stdin.text()) as unknown
    );
  } catch (error) {
    process.stderr.write(
      `${runtimeIdentity} adapter: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }

  try {
    const response = validateToolingSchema<RunnerResponse>(
      "runner-response",
      await execute(request)
    );
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        failureResponse(
          request,
          runtimeIdentity,
          error instanceof Error ? error.message : String(error)
        )
      )}\n`
    );
    return 0;
  }
};
