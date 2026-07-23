#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { toolingSchemaPath, validateToolingSchema } from "./schema.ts";

interface FileAssertion {
  contains: string[];
  exists: boolean;
  notContains: string[];
  path: string;
}

interface ReleaseBehaviorCase {
  assertions: FileAssertion[];
  fixture: string;
  id: string;
  prompt: string;
}

interface EvalManifest {
  releaseCases: ReleaseBehaviorCase[];
  schemaVersion: 1;
  skillName: "simple-changes";
}

interface RunnerRequest {
  caseId: string;
  guidanceDirectory: string;
  prompt: string;
  readOnly: boolean;
  repository: string;
  responseSchema: string;
  schemaVersion: 1;
}

interface RunnerResponse {
  caseId: string;
  errors: string[];
  plan: unknown;
  report: string;
  schemaVersion: 1;
  status: "passed" | "failed" | "blocked";
}

interface Options {
  adapter: string;
  cases: string[];
  keepFailures: boolean;
}

const decoder = new TextDecoder();
const SCRIPT_EXTENSION_PATTERN = /\.(?:[cm]?[jt]s)$/u;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const guidanceDirectory = resolve(moduleDirectory, "release-notes");
const manifest = validateToolingSchema<EvalManifest>(
  "eval-manifest",
  JSON.parse(
    readFileSync(resolve(moduleDirectory, "evals/cases.json"), "utf8")
  ) as unknown
);

const parseOptions = (args: string[]): Options => {
  const options: Options = { adapter: "", cases: [], keepFailures: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep-failures") {
      options.keepFailures = true;
      continue;
    }
    if (argument === "--adapter" || argument === "--case") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--adapter") {
        options.adapter = resolve(value);
      } else {
        options.cases.push(value);
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.adapter) {
    throw new Error("--adapter is required");
  }
  return options;
};

const adapterCommand = (adapter: string): string[] =>
  SCRIPT_EXTENSION_PATTERN.test(adapter)
    ? [process.execPath, adapter]
    : [adapter];

const initializeRepository = (repository: string): void => {
  const commands = [
    ["init", "-b", "main"],
    ["config", "user.name", "Simple Changes Eval"],
    ["config", "user.email", "eval@simple-changes.invalid"],
    ["add", "."],
    ["commit", "-m", "Evaluation fixture"],
  ];
  for (const args of commands) {
    const result = spawnSync(["git", "-C", repository, ...args], {
      stderr: "pipe",
      stdout: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args[0]} failed: ${decoder.decode(result.stderr).trim()}`
      );
    }
  }
};

const safeAssertionPath = (value: string): void => {
  if (
    isAbsolute(value) ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../")
  ) {
    throw new Error(`Unsafe assertion path: ${value}`);
  }
};

export const inspectAssertions = (
  repository: string,
  assertions: FileAssertion[]
): string[] => {
  const failures: string[] = [];
  for (const assertion of assertions) {
    safeAssertionPath(assertion.path);
    const path = resolve(repository, assertion.path);
    const exists = existsSync(path);
    if (exists !== assertion.exists) {
      failures.push(
        `${assertion.path} existence was ${exists}, expected ${assertion.exists}`
      );
      continue;
    }
    if (!exists) {
      continue;
    }
    const contents = readFileSync(path, "utf8");
    for (const expected of assertion.contains) {
      if (!contents.includes(expected)) {
        failures.push(
          `${assertion.path} is missing ${JSON.stringify(expected)}`
        );
      }
    }
    for (const forbidden of assertion.notContains) {
      if (contents.includes(forbidden)) {
        failures.push(
          `${assertion.path} contains forbidden ${JSON.stringify(forbidden)}`
        );
      }
    }
  }
  return failures;
};

const runCase = (
  behaviorCase: ReleaseBehaviorCase,
  options: Options
): { failures: string[]; retainedPath: string | null } => {
  const fixture = resolve(
    moduleDirectory,
    "evals/fixtures",
    behaviorCase.fixture
  );
  if (!existsSync(fixture)) {
    return {
      failures: [`Fixture does not exist: ${behaviorCase.fixture}`],
      retainedPath: null,
    };
  }
  const base = mkdtempSync(join(tmpdir(), "simple-changes-behavior-"));
  const repository = join(base, "repo");
  cpSync(fixture, repository, { recursive: true });
  const canonicalRepository = realpathSync(repository);
  initializeRepository(canonicalRepository);
  const request = validateToolingSchema<RunnerRequest>("runner-request", {
    caseId: behaviorCase.id,
    guidanceDirectory,
    prompt: behaviorCase.prompt,
    readOnly: false,
    repository: canonicalRepository,
    responseSchema: toolingSchemaPath("runner-response"),
    schemaVersion: 1,
  });
  const result = spawnSync(adapterCommand(options.adapter), {
    cwd: canonicalRepository,
    stderr: "pipe",
    stdin: Buffer.from(JSON.stringify(request)),
    stdout: "pipe",
  });
  const failures: string[] = [];
  if (result.exitCode === 0) {
    try {
      const response = validateToolingSchema<RunnerResponse>(
        "runner-response",
        JSON.parse(decoder.decode(result.stdout)) as unknown
      );
      if (response.caseId !== behaviorCase.id) {
        failures.push(
          `Adapter returned case ${response.caseId}, expected ${behaviorCase.id}`
        );
      }
      if (response.status !== "passed") {
        failures.push(
          `Adapter status was ${response.status}: ${response.errors.join("; ")}`
        );
      }
    } catch (error) {
      failures.push(
        `Adapter response was invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    failures.push(
      `Adapter exited ${result.exitCode}: ${decoder.decode(result.stderr).trim()}`
    );
  }
  failures.push(
    ...inspectAssertions(canonicalRepository, behaviorCase.assertions)
  );
  if (failures.length === 0 || !options.keepFailures) {
    rmSync(base, { force: true, recursive: true });
    return { failures, retainedPath: null };
  }
  return { failures, retainedPath: canonicalRepository };
};

const main = (): number => {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `simple-changes behavior eval: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 2;
  }
  const selected =
    options.cases.length === 0
      ? manifest.releaseCases
      : manifest.releaseCases.filter((behaviorCase) =>
          options.cases.includes(behaviorCase.id)
        );
  if (selected.length === 0) {
    process.stderr.write("simple-changes behavior eval: no cases selected\n");
    return 2;
  }
  let failed = 0;
  for (const behaviorCase of selected) {
    const result = runCase(behaviorCase, options);
    if (result.failures.length === 0) {
      process.stdout.write(`PASS ${behaviorCase.id}\n`);
      continue;
    }
    failed += 1;
    process.stdout.write(`FAIL ${behaviorCase.id}\n`);
    for (const failure of result.failures) {
      process.stdout.write(`  - ${failure}\n`);
    }
    if (result.retainedPath) {
      process.stdout.write(`  retained: ${result.retainedPath}\n`);
    }
  }
  process.stdout.write(
    `Release behavior eval: ${selected.length - failed} passed, ${failed} failed\n`
  );
  return failed === 0 ? 0 : 1;
};

if (import.meta.main) {
  process.exitCode = main();
}
