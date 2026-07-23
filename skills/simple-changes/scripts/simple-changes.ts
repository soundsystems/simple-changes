#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "bun";
import { EXIT_CODES, SimpleChangesError } from "./lib/errors.ts";
import { captureInventory, compareSnapshots } from "./lib/inventory.ts";
import { auditMarkdown } from "./lib/markdown.ts";
import { buildPreviewPlan } from "./lib/planner.ts";
import { redactSecrets } from "./lib/redact.ts";
import {
  checkReleaseConsistency,
  type ReleaseConsistencyReport,
  renderReleaseConsistency,
} from "./lib/release-consistency.ts";
import type { ReleaseNotes } from "./lib/release-notes.ts";
import { extractReleaseNotes } from "./lib/release-notes.ts";
import { renderInventory, renderPlan } from "./lib/report.ts";
import { validateSchema } from "./lib/schema.ts";
import type { SchemaName } from "./lib/types.ts";

const VERSION = "0.1.0";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELP = `Simple Changes ${VERSION}

Usage:
  simple-changes inventory [--json] [--repo PATH]
  simple-changes preview [--json] [--repo PATH] [--settle-ms N]
  simple-changes release-notes [--check] [--json] [--repo PATH] [--version VERSION]
  simple-changes validate KIND FILE [--json]
  simple-changes verify-markdown FILE [--json]
  simple-changes help

Schema kinds:
  repo-policy, inventory, change-plan, run-state, provider-receipt,
  release-consistency, release-notes

Exit codes:
  0 success, 2 usage, 3 invalid contract, 4 inventory failure, 5 unsafe state
`;

interface CliOptions {
  check: boolean;
  json: boolean;
  positional: string[];
  releaseVersion?: string;
  repo: string;
  repoProvided: boolean;
  settleMs: number;
}

const VALUED_OPTIONS = new Set(["--repo", "--settle-ms", "--version"]);

const requiredOptionValue = (
  args: string[],
  index: number,
  option: string
): string => {
  const value = args[index + 1];
  if (!value) {
    throw new SimpleChangesError(
      `${option} requires a value`,
      EXIT_CODES.usage
    );
  }
  return value;
};

const applyValuedOption = (
  options: CliOptions,
  option: string,
  value: string
): void => {
  if (option === "--repo") {
    options.repo = resolve(value);
    options.repoProvided = true;
    return;
  }
  if (option === "--version") {
    options.releaseVersion = value;
    return;
  }
  const settleMs = Number(value);
  if (!(Number.isInteger(settleMs) && settleMs >= 0 && settleMs <= 60_000)) {
    throw new SimpleChangesError(
      "--settle-ms must be an integer from 0 to 60000",
      EXIT_CODES.usage
    );
  }
  options.settleMs = settleMs;
};

const parseOptions = (args: string[]): CliOptions => {
  const options: CliOptions = {
    check: false,
    json: false,
    positional: [],
    repo: process.cwd(),
    repoProvided: false,
    settleMs: 0,
  };
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === "--json" || argument === "--check") {
      options[argument === "--json" ? "json" : "check"] = true;
      index += 1;
      continue;
    }
    if (argument && VALUED_OPTIONS.has(argument)) {
      applyValuedOption(
        options,
        argument,
        requiredOptionValue(args, index, argument)
      );
      index += 2;
      continue;
    }
    if (argument?.startsWith("--")) {
      throw new SimpleChangesError(
        `Unknown option: ${argument}`,
        EXIT_CODES.usage
      );
    }
    if (argument) {
      options.positional.push(argument);
    }
    index += 1;
  }
  return options;
};

const writeOutput = (value: unknown, json: boolean, text: string): void => {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
};

const runInventory = (options: CliOptions): void => {
  const inventory = captureInventory(options.repo);
  writeOutput(inventory, options.json, renderInventory(inventory));
};

const runPreview = async (options: CliOptions): Promise<void> => {
  const opening = captureInventory(options.repo);
  if (options.settleMs > 0) {
    await sleep(options.settleMs);
  }
  const current = captureInventory(options.repo);
  const comparison = compareSnapshots(opening, current);
  const plan = buildPreviewPlan(opening, current, comparison);
  writeOutput(plan, options.json, renderPlan(plan));
};

const runValidation = (options: CliOptions): void => {
  const [schemaName, filename] = options.positional;
  if (!(schemaName && filename)) {
    throw new SimpleChangesError(
      "validate requires KIND and FILE",
      EXIT_CODES.usage
    );
  }
  const value = JSON.parse(readFileSync(resolve(filename), "utf8")) as unknown;
  const validated = validateSchema(schemaName as SchemaName, value);
  writeOutput(
    { schema: schemaName, valid: true, value: validated },
    options.json,
    `${filename} is valid ${schemaName} data.\n`
  );
};

const runMarkdownAudit = (options: CliOptions): void => {
  const [filename] = options.positional;
  if (!filename) {
    throw new SimpleChangesError(
      "verify-markdown requires FILE",
      EXIT_CODES.usage
    );
  }
  const audit = auditMarkdown(readFileSync(resolve(filename), "utf8"));
  writeOutput(
    audit,
    options.json,
    audit.valid
      ? `${filename} contains valid multiline Markdown.\n`
      : `${filename}: ${audit.issues.join(" ")}\n`
  );
  if (!audit.valid) {
    throw new SimpleChangesError(
      "Markdown audit failed",
      EXIT_CODES.validation
    );
  }
};

const runReleaseNotes = (options: CliOptions): number => {
  if (options.check) {
    if (options.releaseVersion) {
      throw new SimpleChangesError(
        "--check and --version cannot be combined",
        EXIT_CODES.usage
      );
    }
    if (!options.repoProvided) {
      throw new SimpleChangesError(
        "--check requires an explicit --repo PATH",
        EXIT_CODES.usage
      );
    }
    const report = validateSchema<ReleaseConsistencyReport>(
      "release-consistency",
      checkReleaseConsistency(options.repo)
    );
    writeOutput(report, options.json, renderReleaseConsistency(report));
    return report.valid ? EXIT_CODES.success : EXIT_CODES.validation;
  }
  const releaseRoot = options.repoProvided ? options.repo : PACKAGE_ROOT;
  const changelogPath = resolve(releaseRoot, "CHANGELOG.md");
  const notes = validateSchema<ReleaseNotes>(
    "release-notes",
    extractReleaseNotes(
      readFileSync(changelogPath, "utf8"),
      changelogPath,
      options.releaseVersion
    )
  );
  writeOutput(notes, options.json, notes.markdown);
  return EXIT_CODES.success;
};

export const runCli = async (args: string[]): Promise<number> => {
  const [command = "help", ...rest] = args;
  try {
    const options = parseOptions(rest);
    if (command === "help" || command === "--help" || command === "-h") {
      process.stdout.write(HELP);
      return EXIT_CODES.success;
    }
    if (command === "version" || command === "--version" || command === "-v") {
      process.stdout.write(`${VERSION}\n`);
      return EXIT_CODES.success;
    }
    if (command === "inventory") {
      runInventory(options);
      return EXIT_CODES.success;
    }
    if (command === "preview") {
      await runPreview(options);
      return EXIT_CODES.success;
    }
    if (command === "release-notes") {
      return runReleaseNotes(options);
    }
    if (command === "validate") {
      runValidation(options);
      return EXIT_CODES.success;
    }
    if (command === "verify-markdown") {
      runMarkdownAudit(options);
      return EXIT_CODES.success;
    }
    throw new SimpleChangesError(
      `Unknown command: ${command}`,
      EXIT_CODES.usage
    );
  } catch (error) {
    const simpleError =
      error instanceof SimpleChangesError
        ? error
        : new SimpleChangesError(
            error instanceof Error ? error.message : String(error),
            EXIT_CODES.validation,
            error instanceof Error ? { cause: error } : undefined
          );
    const wantsJson = args.includes("--json");
    const message = redactSecrets(simpleError.message);
    process.stderr.write(
      wantsJson
        ? `${JSON.stringify({ error: message, exitCode: simpleError.exitCode, ok: false })}\n`
        : `simple-changes: ${message}\n`
    );
    return simpleError.exitCode;
  }
};

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
