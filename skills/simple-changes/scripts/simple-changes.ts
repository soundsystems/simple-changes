#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { sleep } from "bun";
import { inspectChangelogCoordination } from "./lib/changelog-coordination.ts";
import { EXIT_CODES, SimpleChangesError } from "./lib/errors.ts";
import {
  type InitializationStatus,
  inspectInitialization,
} from "./lib/initialization.ts";
import { captureInventory, compareSnapshots } from "./lib/inventory.ts";
import { auditMarkdown } from "./lib/markdown.ts";
import {
  collectOnboardingSelection,
  type OnboardingChoice,
  type OnboardingInputs,
  type OnboardingPrompter,
  type SetupScope,
} from "./lib/onboarding.ts";
import { buildPreviewPlan } from "./lib/planner.ts";
import {
  loadPersonalPolicy,
  resolvePersonalPolicyPath,
  writePolicyFile,
} from "./lib/policy.ts";
import { runGit } from "./lib/process.ts";
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
import type { RepoPolicy, RequestMode, SchemaName } from "./lib/types.ts";

const VERSION = "0.4.0";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELP = `Simple Changes ${VERSION}

Usage:
  simple-changes initialize --mode MODE
    [--changelog delegate-if-available|preserve-and-report|ask]
    [--production ask|allow|deny]
    [--questions blocking-only|always|never]
    [--scope user|repository|run] [--yes] [--json] [--repo PATH]
  simple-changes setup [--finish review|integrate|ship]
    [--changelog delegate-if-available|preserve-and-report|ask]
    [--production ask|allow|deny]
    [--questions blocking-only|always|never]
    [--scope user|repository|run] [--yes] [--json] [--repo PATH]
  simple-changes inventory [--json] [--repo PATH]
  simple-changes preview [--json] [--repo PATH] [--settle-ms N]
  simple-changes release-notes [--check] [--json] [--repo PATH] [--version VERSION]
  simple-changes validate KIND FILE [--json]
  simple-changes verify-markdown FILE [--json]
  simple-changes help

Schema kinds:
  repo-policy, changelog-receipt, initialization, inventory, change-plan,
  run-state, provider-receipt, release-consistency, release-notes

Exit codes:
  0 success, 2 usage, 3 invalid contract, 4 inventory failure, 5 unsafe state
`;

interface CliOptions {
  changelogHandling?: RepoPolicy["changelogHandling"];
  check: boolean;
  defaultFinish?: "open-change-request" | "integrate" | "ship";
  json: boolean;
  mode?: RequestMode;
  positional: string[];
  productionDeploy?: RepoPolicy["productionDeploy"];
  questions?: RepoPolicy["questions"];
  releaseVersion?: string;
  repo: string;
  repoProvided: boolean;
  scope?: SetupScope;
  settleMs: number;
  yes: boolean;
}

const VALUED_OPTIONS = new Set([
  "--changelog",
  "--finish",
  "--mode",
  "--production",
  "--questions",
  "--repo",
  "--scope",
  "--settle-ms",
  "--version",
]);

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

const changelogHandlingValue = (
  value: string
): RepoPolicy["changelogHandling"] => {
  if (
    !["delegate-if-available", "preserve-and-report", "ask"].includes(value)
  ) {
    throw new SimpleChangesError(
      "--changelog must be delegate-if-available, preserve-and-report, or ask",
      EXIT_CODES.usage
    );
  }
  return value as RepoPolicy["changelogHandling"];
};

const applyValuedOption = (
  options: CliOptions,
  option: string,
  value: string
): void => {
  if (option === "--changelog") {
    options.changelogHandling = changelogHandlingValue(value);
    return;
  }
  if (option === "--finish") {
    const finishAliases = {
      integrate: "integrate",
      merge: "integrate",
      "open-change-request": "open-change-request",
      review: "open-change-request",
      ship: "ship",
    } as const;
    const finish = finishAliases[value as keyof typeof finishAliases];
    if (!finish) {
      throw new SimpleChangesError(
        "--finish must be review, integrate, or ship",
        EXIT_CODES.usage
      );
    }
    options.defaultFinish = finish;
    return;
  }
  if (option === "--mode") {
    const modes: RequestMode[] = [
      "preview",
      "queue",
      "sweep",
      "integrate",
      "ship",
      "reconcile",
      "resume",
      "pause",
    ];
    if (!modes.includes(value as RequestMode)) {
      throw new SimpleChangesError(
        `--mode must be one of ${modes.join(", ")}`,
        EXIT_CODES.usage
      );
    }
    options.mode = value as RequestMode;
    return;
  }
  if (option === "--production") {
    if (!["ask", "allow", "deny"].includes(value)) {
      throw new SimpleChangesError(
        "--production must be ask, allow, or deny",
        EXIT_CODES.usage
      );
    }
    options.productionDeploy = value as RepoPolicy["productionDeploy"];
    return;
  }
  if (option === "--questions") {
    if (!["blocking-only", "always", "never"].includes(value)) {
      throw new SimpleChangesError(
        "--questions must be blocking-only, always, or never",
        EXIT_CODES.usage
      );
    }
    options.questions = value as RepoPolicy["questions"];
    return;
  }
  if (option === "--repo") {
    options.repo = resolve(value);
    options.repoProvided = true;
    return;
  }
  if (option === "--scope") {
    if (!["user", "repository", "run"].includes(value)) {
      throw new SimpleChangesError(
        "--scope must be user, repository, or run",
        EXIT_CODES.usage
      );
    }
    options.scope = value as SetupScope;
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
    yes: false,
  };
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (
      argument === "--json" ||
      argument === "--check" ||
      argument === "--yes"
    ) {
      if (argument === "--json") {
        options.json = true;
      } else if (argument === "--check") {
        options.check = true;
      } else {
        options.yes = true;
      }
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

const defaultChoiceIndex = (
  choices: readonly OnboardingChoice[],
  defaultValue: string
): number => {
  const index = choices.findIndex((choice) => choice.value === defaultValue);
  return index >= 0 ? index : 0;
};

const createCliPrompter = (
  options: CliOptions
): {
  close: () => void;
  prompter: OnboardingPrompter;
} => {
  const output = options.json ? process.stderr : process.stdout;
  const reader = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  const choose = (
    question: string,
    choices: readonly OnboardingChoice[],
    defaultValue: string
  ): Promise<string> => {
    const selectedDefault = defaultChoiceIndex(choices, defaultValue);
    output.write(`\n${question}\n\n`);
    for (const [index, choice] of choices.entries()) {
      const recommendation = index === selectedDefault ? " (Recommended)" : "";
      output.write(
        `  ${index + 1}. ${choice.label}${recommendation}\n     ${choice.description}\n`
      );
    }
    const askForChoice = async (): Promise<string> => {
      const answer = (
        await reader.question(
          `\nChoose 1-${choices.length} [${selectedDefault + 1}]: `
        )
      ).trim();
      if (!answer) {
        return choices[selectedDefault]?.value ?? choices[0]?.value ?? "";
      }
      const selectedIndex = Number(answer) - 1;
      const selected = choices[selectedIndex];
      if (selected && Number.isInteger(selectedIndex)) {
        return selected.value;
      }
      output.write(`Please choose a number from 1 to ${choices.length}.\n`);
      return askForChoice();
    };
    return askForChoice();
  };
  return {
    close: () => reader.close(),
    prompter: {
      choose,
      confirm: async (summary: string): Promise<boolean> => {
        if (options.yes) {
          return true;
        }
        output.write(`\n${summary}\n`);
        const answer = (
          await reader.question("\nConfirm these preferences? [Y/n]: ")
        )
          .trim()
          .toLowerCase();
        return answer === "" || answer === "y" || answer === "yes";
      },
    },
  };
};

const setupNeedsPrompt = (
  options: CliOptions,
  changelogRelevant: boolean
): boolean =>
  !(
    options.defaultFinish &&
    (!changelogRelevant || options.changelogHandling) &&
    options.questions &&
    options.scope &&
    (options.defaultFinish !== "ship" || options.productionDeploy) &&
    options.yes
  );

const setupPolicyPath = (
  scope: SetupScope,
  primaryCheckout: string | null
): string | null => {
  if (scope === "repository") {
    if (!primaryCheckout) {
      throw new SimpleChangesError(
        "Repository-scoped setup requires a Git repository.",
        EXIT_CODES.usage
      );
    }
    return resolve(primaryCheckout, ".simple-changes.json");
  }
  if (scope === "user") {
    return resolvePersonalPolicyPath();
  }
  return null;
};

const setupOutcome = (
  confirmed: boolean,
  written: boolean,
  path: string | null
): string => {
  if (!confirmed) {
    return "Preferences were not saved.";
  }
  if (written) {
    return `Saved preferences to ${path}.`;
  }
  return "Selected these preferences for this run; no file was written.";
};

const setupContext = (
  repositoryPath: string
): {
  changelog: ReturnType<typeof inspectChangelogCoordination>;
  policy: RepoPolicy;
  primaryCheckout: string | null;
} => {
  const probe = runGit(repositoryPath, ["rev-parse", "--show-toplevel"], true);
  if (probe.exitCode !== 0) {
    return {
      changelog: inspectChangelogCoordination(null),
      policy: loadPersonalPolicy().value,
      primaryCheckout: null,
    };
  }
  const inventory = captureInventory(repositoryPath);
  return {
    changelog: inspectChangelogCoordination(
      inventory.repository.primaryCheckout
    ),
    policy: inventory.policy.value,
    primaryCheckout: inventory.repository.primaryCheckout,
  };
};

const runSetup = async (options: CliOptions): Promise<void> => {
  const context = setupContext(options.repo);
  if (
    setupNeedsPrompt(options, context.changelog.relevant) &&
    !process.stdin.isTTY
  ) {
    throw new SimpleChangesError(
      "Interactive setup requires a terminal. Supply --finish, --questions, --scope, --production when shipping, --changelog when relevant, and --yes.",
      EXIT_CODES.usage
    );
  }
  const inputs: OnboardingInputs = {
    ...(options.changelogHandling
      ? { changelogHandling: options.changelogHandling }
      : {}),
    ...(options.defaultFinish ? { defaultFinish: options.defaultFinish } : {}),
    ...(options.productionDeploy
      ? { productionDeploy: options.productionDeploy }
      : {}),
    ...(options.questions ? { questions: options.questions } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  };
  const interactive = createCliPrompter(options);
  try {
    const selection = await collectOnboardingSelection(
      context.policy,
      inputs,
      interactive.prompter,
      context.changelog
    );
    const path = setupPolicyPath(selection.scope, context.primaryCheckout);
    const written = selection.confirmed && path !== null;
    if (written && path) {
      writePolicyFile(path, selection.policy, selection.scope === "user");
    }
    const result = {
      changelogCoordination: context.changelog,
      confirmed: selection.confirmed,
      path,
      policy: selection.policy,
      scope: selection.scope,
      summary: selection.summary,
      written,
    };
    const outcome = setupOutcome(selection.confirmed, written, path);
    writeOutput(result, options.json, `${selection.summary}\n\n${outcome}\n`);
  } finally {
    interactive.close();
  }
};

const renderInitialization = (
  status: ReturnType<typeof inspectInitialization>
): string => {
  const lines = [
    "Simple Changes initialization",
    `Mode: ${status.mode}`,
    `Write-capable: ${status.writeCapable ? "yes" : "no"}`,
    `Policy: ${status.policySource}`,
    `Changelog coordination: ${
      status.changelogCoordination.relevant ? "relevant" : "not detected"
    }`,
    `Changelog capability: ${
      status.changelogCoordination.capabilityAvailable
        ? "available"
        : "not available"
    }`,
    `Onboarding required: ${status.onboardingRequired ? "yes" : "no"}`,
    `Reason: ${status.reason}`,
  ];
  if (status.inferredDefaultFinish) {
    lines.push(`Inferred finish: ${status.inferredDefaultFinish}`);
  }
  return `${lines.join("\n")}\n`;
};

const runInitialize = async (options: CliOptions): Promise<void> => {
  if (!options.mode) {
    throw new SimpleChangesError(
      "initialize requires --mode",
      EXIT_CODES.usage
    );
  }
  const inventory = captureInventory(options.repo);
  const changelogCoordination = inspectChangelogCoordination(
    inventory.repository.primaryCheckout
  );
  const status = validateSchema<InitializationStatus>(
    "initialization",
    inspectInitialization(options.mode, inventory.policy, changelogCoordination)
  );
  if (!status.onboardingRequired) {
    writeOutput(status, options.json, renderInitialization(status));
    return;
  }
  const setupOptions: CliOptions = {
    ...options,
    ...(status.inferredDefaultFinish
      ? { defaultFinish: status.inferredDefaultFinish }
      : {}),
  };
  if (
    process.stdin.isTTY ||
    !setupNeedsPrompt(setupOptions, changelogCoordination.relevant)
  ) {
    await runSetup(setupOptions);
    return;
  }
  writeOutput(status, options.json, renderInitialization(status));
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

const executeCommand = async (
  command: string,
  options: CliOptions
): Promise<number> => {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return EXIT_CODES.success;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return EXIT_CODES.success;
    case "inventory":
      runInventory(options);
      return EXIT_CODES.success;
    case "initialize":
      await runInitialize(options);
      return EXIT_CODES.success;
    case "setup":
      await runSetup(options);
      return EXIT_CODES.success;
    case "preview":
      await runPreview(options);
      return EXIT_CODES.success;
    case "release-notes":
      return runReleaseNotes(options);
    case "validate":
      runValidation(options);
      return EXIT_CODES.success;
    case "verify-markdown":
      runMarkdownAudit(options);
      return EXIT_CODES.success;
    default:
      throw new SimpleChangesError(
        `Unknown command: ${command}`,
        EXIT_CODES.usage
      );
  }
};

export const runCli = async (args: string[]): Promise<number> => {
  const [command = "help", ...rest] = args;
  try {
    return await executeCommand(command, parseOptions(rest));
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
