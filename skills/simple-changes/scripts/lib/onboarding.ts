import {
  discoverInstructionTargets,
  type InstructionTarget,
  renderInstructionPointer,
} from "./repository-instructions.ts";
import type { ChangelogCoordination, RepoPolicy } from "./types.ts";

export type SetupScope = "user" | "repository" | "run";
export type SetupStyle = "recommended" | "customize" | "run";

export interface OnboardingChoice {
  description: string;
  label: string;
  value: string;
}

export interface OnboardingPrompter {
  choose: (
    question: string,
    choices: readonly OnboardingChoice[],
    defaultValue: string
  ) => Promise<string>;
  confirm: (summary: string) => Promise<boolean>;
  present?: (message: string) => void;
}

export interface OnboardingInputs {
  changelogHandling?: RepoPolicy["changelogHandling"];
  concurrentWork?: RepoPolicy["concurrentWork"];
  defaultFinish?: RepoPolicy["defaultFinish"];
  handoffTiming?: RepoPolicy["handoffTiming"];
  instructionFile?: string;
  instructionPointer?: "add" | "leave";
  productionDeploy?: RepoPolicy["productionDeploy"];
  questions?: RepoPolicy["questions"];
  scope?: SetupScope;
  uiArtifactVersioning?: RepoPolicy["uiArtifactVersioning"];
}

export interface OnboardingSelection {
  confirmed: boolean;
  instructionPointer: {
    action: "add" | "leave" | "unavailable";
    block: string | null;
    target: InstructionTarget | null;
  };
  policy: RepoPolicy;
  scope: SetupScope;
  setupStyle: SetupStyle;
  summary: string;
}

export interface OnboardingConversationOptions {
  showFirstScreen?: boolean;
}

export const ONBOARDING_QUESTIONS = {
  changelog: "How should changelog work be handled?",
  finish: "How far should I usually take ready work?",
  handoff:
    "When an agent finishes implementation and verification, when should Simple Changes take over?",
  instructionFile: "Which instruction file should Simple Changes update?",
  instructionPointer: (path: string) =>
    `Should I add a short Simple Changes instruction to \`${path}\`?`,
  permission: "When should I ask for permission or help?",
  production: "What should happen with production?",
  scope: "Where should these preferences live?",
  start:
    "Simple Changes can set up the workflow before continuing. Choose one:",
  uiArtifactVersioning:
    "When I save multiple UI iterations, how should their version names be chosen?",
} as const;

const DEFAULT_CHANGELOG_CONTEXT: ChangelogCoordination = {
  capabilityAvailable: false,
  providers: [],
  releaseSurfaces: [],
  relevant: false,
};

export const FINISH_CHOICES = [
  {
    description: "Create focused MRs, run checks, and stop.",
    label: "Put it up for review",
    value: "open-change-request",
  },
  {
    description: "Also merge once checks and required reviews have passed.",
    label: "Merge when approved",
    value: "integrate",
  },
  {
    description: "Also deploy and verify the merged work.",
    label: "Ship when approved",
    value: "ship",
  },
] as const satisfies readonly OnboardingChoice[];

export const PRODUCTION_CHOICES = [
  {
    description: "Merge automatically, but confirm before production.",
    label: "Ask me first",
    value: "ask",
  },
  {
    description: "Deploy when repository rules allow it.",
    label: "Deploy automatically",
    value: "allow",
  },
  {
    description: "Stop after merge or preview deployment.",
    label: "Never deploy production",
    value: "deny",
  },
] as const satisfies readonly OnboardingChoice[];

export const PERMISSION_CHOICES = [
  {
    description: "Keep working unless a decision is genuinely required.",
    label: "Only when blocked",
    value: "blocking-only",
  },
  {
    description: "Confirm before consequential workflow steps.",
    label: "At major steps",
    value: "always",
  },
  {
    description: "Skip anything that lacks authority and report it afterward.",
    label: "Don't interrupt me",
    value: "never",
  },
] as const satisfies readonly OnboardingChoice[];

export const CHANGELOG_CHOICES = [
  {
    description:
      "Use a compatible changelog skill when present; otherwise preserve and report the work.",
    label: "Delegate when available",
    value: "delegate-if-available",
  },
  {
    description:
      "Leave changelog destinations untouched and report the remaining work.",
    label: "Preserve and report",
    value: "preserve-and-report",
  },
  {
    description: "Ask before handing changelog work to a compatible skill.",
    label: "Ask before delegating",
    value: "ask",
  },
] as const satisfies readonly OnboardingChoice[];

export const SCOPE_CHOICES = [
  {
    description:
      "Save a visible .simple-changes.json beside the project so teammates and future agents use the same workflow.",
    label: "This repository",
    value: "repository",
  },
  {
    description:
      "Save private personal defaults that apply only when a repository has no Simple Changes policy.",
    label: "All my repositories",
    value: "user",
  },
  {
    description:
      "Use the choices for the current task, write no preference file, and show onboarding again next time.",
    label: "This run only",
    value: "run",
  },
] as const satisfies readonly OnboardingChoice[];

const finishPath = (finish: RepoPolicy["defaultFinish"]): string => {
  const proposal = "ready work -> focused proposal -> checks";
  if (finish === "ship") {
    return `${proposal} -> required approval -> merge -> authorized deploy -> live verification`;
  }
  if (finish === "integrate") {
    return `${proposal} -> required approval -> merge -> STOP`;
  }
  return `${proposal} -> STOP for review`;
};

const recommendedScope = (primaryCheckout: string | null): SetupScope =>
  primaryCheckout ? "repository" : "user";

const renderScopeDiagram = (primaryCheckout: string | null): string => {
  const repositoryPath = primaryCheckout
    ? `${primaryCheckout}/.simple-changes.json`
    : ".simple-changes.json (requires a Git repository)";
  return [
    "This choice controls where the answers are remembered; it does not change how far the current task is allowed to go.",
    "",
    `This repository  -> ${repositoryPath} -> shared project policy`,
    "All repositories -> private preferences.json         -> personal fallback",
    "This run only    -> no file                          -> ask again next time",
  ].join("\n");
};

const renderFirstScreenIntroduction = (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  context: ChangelogCoordination,
  primaryCheckout: string | null
): string => {
  const finish = inputs.defaultFinish ?? preferredFinish(defaults);
  const location = primaryCheckout
    ? `I found the repository at ${primaryCheckout}.`
    : "No Git repository is active, so repository-level preferences are unavailable.";
  let changelog = "No changelog decision is needed for this setup.";
  if (context.relevant && context.capabilityAvailable) {
    changelog =
      "A compatible changelog workflow is available; the safe default is to preserve changelog work for that workflow.";
  } else if (context.relevant) {
    changelog =
      "Changelog surfaces were found, but no compatible changelog workflow is available; the safe default is to preserve and report that work.";
  }
  return [
    "This is first-use onboarding inside your original Simple Changes task. It decides the normal stopping point, when I interrupt you, and where those answers are remembered. It does not itself create a branch, push, merge, or deploy anything.",
    "",
    location,
    changelog,
    "",
    "Recommended workflow for this request:",
    finishPath(finish),
    "Ask only when blocked. Production remains a separate confirmation unless you explicitly change it. High-risk operations such as migrations, secrets, DNS, store releases, and history rewrites always remain separately gated.",
  ].join("\n");
};

const onboardingStyleChoices = (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  primaryCheckout: string | null
): readonly OnboardingChoice[] => {
  const finish = inputs.defaultFinish ?? preferredFinish(defaults);
  const scope = recommendedScope(primaryCheckout);
  const scopeDescription =
    scope === "repository"
      ? "save the result as visible repository policy"
      : "save the result as private personal defaults";
  return [
    {
      description: `Use ${finishLabel(finish)}, ask only when blocked, keep production confirmation in place, preserve changelog work for its owning workflow, and ${scopeDescription}. You will see a full receipt before anything is written.`,
      label: "Use recommended setup",
      value: "recommended",
    },
    {
      description:
        "Explain each unresolved preference one at a time, then show the complete result before saving it.",
      label: "Customize",
      value: "customize",
    },
    {
      description:
        "Use the same recommended workflow for the current task without writing repository or personal preferences; onboarding will appear again next time.",
      label: "Use recommended setup for this run only",
      value: "run",
    },
  ];
};

export const INSTRUCTION_POINTER_CHOICES = [
  {
    description:
      "Add or update one managed pointer so agents know when Simple Changes should take over.",
    label: "Add the pointer",
    value: "add",
  },
  {
    description:
      "Do not change the instruction file; rely on explicit requests or skill discovery.",
    label: "Leave instructions unchanged",
    value: "leave",
  },
] as const satisfies readonly OnboardingChoice[];

export const HANDOFF_CHOICES = [
  {
    description:
      "Ask whether the implementation is ready or whether more changes are needed before handing it off.",
    label: "Ask if it's ready",
    value: "confirm-ready",
  },
  {
    description:
      "Hand off completed, verified implementation work immediately, subject to the current request and policy.",
    label: "Automatically after implementation",
    value: "automatic",
  },
  {
    description:
      "Wait until I ask to put up, merge, ship, finish, or reconcile the completed work.",
    label: "When I say it's ready",
    value: "user-signaled",
  },
] as const satisfies readonly OnboardingChoice[];

export const UI_ARTIFACT_VERSIONING_CHOICES = [
  {
    description:
      "Use the repository's established format; if none exists, ask before choosing one.",
    label: "Follow repository convention",
    value: "repository-convention",
  },
  {
    description:
      "Use zero-padded sequence and ISO date names such as v003-2026-07-28.",
    label: "Number and date",
    value: "number-and-date",
  },
  {
    description:
      "Use ISO dates such as 2026-07-28, adding a sequence for same-day versions.",
    label: "Date only",
    value: "date-only",
  },
  {
    description: "Use zero-padded sequential names such as v003.",
    label: "Number only",
    value: "number-only",
  },
] as const satisfies readonly OnboardingChoice[];

const choiceValue = <Value extends string>(
  value: string,
  choices: readonly OnboardingChoice[],
  question: string
): Value => {
  if (!choices.some((choice) => choice.value === value)) {
    throw new Error(`Invalid response for "${question}": ${value}`);
  }
  return value as Value;
};

const preferredFinish = (
  policy: RepoPolicy
): "open-change-request" | "integrate" | "ship" =>
  policy.defaultFinish === "preview"
    ? "open-change-request"
    : policy.defaultFinish;

const finishLabel = (finish: RepoPolicy["defaultFinish"]): string =>
  FINISH_CHOICES.find((choice) => choice.value === finish)?.label ??
  "Preview only";

const permissionLabel = (questions: RepoPolicy["questions"]): string =>
  PERMISSION_CHOICES.find((choice) => choice.value === questions)?.label ??
  questions;

const scopeLabel = (scope: SetupScope): string =>
  SCOPE_CHOICES.find((choice) => choice.value === scope)?.label ?? scope;

const handoffLabel = (timing: RepoPolicy["handoffTiming"]): string =>
  HANDOFF_CHOICES.find((choice) => choice.value === timing)?.label ?? timing;

const uiArtifactVersioningLabel = (
  versioning: RepoPolicy["uiArtifactVersioning"]
): string =>
  UI_ARTIFACT_VERSIONING_CHOICES.find((choice) => choice.value === versioning)
    ?.label ?? versioning;

const changelogSummary = (
  policy: RepoPolicy,
  context: ChangelogCoordination
): string | null => {
  if (!context.relevant) {
    return null;
  }
  if (policy.changelogHandling === "delegate-if-available") {
    return context.capabilityAvailable
      ? "Changelog work will be delegated to a compatible skill and accepted only with a verified handoff receipt."
      : "Changelog work will be delegated when a compatible skill is available; otherwise it will be preserved and reported.";
  }
  if (policy.changelogHandling === "ask") {
    return "I'll ask before delegating changelog work to a compatible skill.";
  }
  return "Changelog destinations will be preserved and reported for a separate workflow.";
};

export const renderOnboardingSummary = (
  policy: RepoPolicy,
  scope: SetupScope,
  context: ChangelogCoordination = DEFAULT_CHANGELOG_CONTEXT,
  instructionPointer: OnboardingSelection["instructionPointer"] = {
    action: "unavailable",
    block: null,
    target: null,
  },
  uiArtifactsRelevant = false
): string => {
  let actions =
    "I'll create focused MRs, run checks, and stop with the work ready for review.";
  if (policy.defaultFinish === "integrate") {
    actions =
      "I'll create focused MRs, run checks, wait for required approval, and merge the exact approved revisions.";
  } else if (policy.defaultFinish === "ship") {
    actions =
      "I'll create focused MRs, run checks, wait for required approval, merge the exact approved revisions, deploy authorized targets, and verify the live application.";
  }
  let production: string | null = null;
  if (policy.defaultFinish === "ship") {
    production = "I'll ask before deploying production.";
    if (policy.productionDeploy === "allow") {
      production =
        "Production deployment is pre-approved when repository rules allow it.";
    } else if (policy.productionDeploy === "deny") {
      production = "I won't deploy production.";
    }
  }
  let pointerSummary =
    "No existing instruction file was selected, so no instruction pointer will be written.";
  if (instructionPointer.action === "leave") {
    pointerSummary = "Agent instructions will remain unchanged.";
  } else if (instructionPointer.action === "add" && instructionPointer.target) {
    pointerSummary = `Instruction pointer: update ${instructionPointer.target.scope} file ${instructionPointer.target.path}.\nProposed managed pointer:\n${instructionPointer.block}`;
  }
  return [
    `Your workflow is set to ${finishLabel(policy.defaultFinish)}.`,
    actions,
    production,
    changelogSummary(policy, context),
    policy.concurrentWork === "strict"
      ? "Concurrent worktrees: strict repository-wide serialization; claimed owners must pause before integration continues."
      : "Concurrent worktrees: independent agents may keep working in distinct actively claimed worktrees while integration stays single-controller.",
    uiArtifactsRelevant
      ? `Saved UI iteration naming: ${uiArtifactVersioningLabel(policy.uiArtifactVersioning)}. Repository conventions still take precedence.`
      : null,
    `Permission and help: ${permissionLabel(policy.questions)}.`,
    `Preference scope: ${scopeLabel(scope)}.`,
    scope === "run" ? null : pointerSummary,
    instructionPointer.action === "add"
      ? `Completed-work handoff: ${handoffLabel(policy.handoffTiming)}.`
      : null,
    "Remote migrations, backfills, secrets, DNS changes, store releases, and history rewrites still require explicit, exact-target authorization.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};

const selectInstructionPointer = async (
  inputs: OnboardingInputs,
  scope: SetupScope,
  prompter: OnboardingPrompter,
  primaryCheckout: string | null
): Promise<{
  handoffTiming: RepoPolicy["handoffTiming"];
  instructionPointer: OnboardingSelection["instructionPointer"];
}> => {
  const targets = discoverInstructionTargets(
    scope,
    primaryCheckout,
    inputs.instructionFile
  );
  let target: InstructionTarget | null = targets[0] ?? null;
  if (targets.length > 1 && inputs.instructionPointer !== "leave") {
    const firstTarget = targets[0] as InstructionTarget;
    const targetChoices = targets.map((candidate) => ({
      description: `Update only ${candidate.path}.`,
      label: candidate.path,
      value: candidate.path,
    }));
    const selectedPath = choiceValue<string>(
      await prompter.choose(
        ONBOARDING_QUESTIONS.instructionFile,
        targetChoices,
        firstTarget.path
      ),
      targetChoices,
      ONBOARDING_QUESTIONS.instructionFile
    );
    target =
      targets.find((candidate) => candidate.path === selectedPath) ?? null;
  }
  let pointerChoice: "add" | "leave" = "leave";
  if (target) {
    pointerChoice =
      inputs.instructionPointer ??
      choiceValue<"add" | "leave">(
        await prompter.choose(
          ONBOARDING_QUESTIONS.instructionPointer(target.path),
          INSTRUCTION_POINTER_CHOICES,
          "add"
        ),
        INSTRUCTION_POINTER_CHOICES,
        ONBOARDING_QUESTIONS.instructionPointer(target.path)
      );
  }
  let handoffTiming: RepoPolicy["handoffTiming"] = "confirm-ready";
  if (pointerChoice === "add") {
    handoffTiming =
      inputs.handoffTiming ??
      choiceValue<RepoPolicy["handoffTiming"]>(
        await prompter.choose(
          ONBOARDING_QUESTIONS.handoff,
          HANDOFF_CHOICES,
          "confirm-ready"
        ),
        HANDOFF_CHOICES,
        ONBOARDING_QUESTIONS.handoff
      );
  }
  let instructionPointer: OnboardingSelection["instructionPointer"];
  if (!target) {
    instructionPointer = {
      action: "unavailable",
      block: null,
      target: null,
    };
  } else if (pointerChoice === "add") {
    instructionPointer = {
      action: "add",
      block: renderInstructionPointer(target.scope, handoffTiming),
      target,
    };
  } else {
    instructionPointer = { action: "leave", block: null, target };
  }
  return { handoffTiming, instructionPointer };
};

const selectUiArtifactVersioning = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  relevant: boolean
): Promise<RepoPolicy["uiArtifactVersioning"]> => {
  if (!relevant) {
    return defaults.uiArtifactVersioning;
  }
  return (
    inputs.uiArtifactVersioning ??
    choiceValue<RepoPolicy["uiArtifactVersioning"]>(
      await prompter.choose(
        ONBOARDING_QUESTIONS.uiArtifactVersioning,
        UI_ARTIFACT_VERSIONING_CHOICES,
        defaults.uiArtifactVersioning
      ),
      UI_ARTIFACT_VERSIONING_CHOICES,
      ONBOARDING_QUESTIONS.uiArtifactVersioning
    )
  );
};

const selectSetupStyle = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  context: ChangelogCoordination,
  primaryCheckout: string | null,
  showFirstScreen: boolean
): Promise<SetupStyle> => {
  if (!showFirstScreen) {
    return "customize";
  }
  prompter.present?.(
    renderFirstScreenIntroduction(defaults, inputs, context, primaryCheckout)
  );
  const choices = onboardingStyleChoices(defaults, inputs, primaryCheckout);
  return choiceValue<SetupStyle>(
    await prompter.choose(ONBOARDING_QUESTIONS.start, choices, "recommended"),
    choices,
    ONBOARDING_QUESTIONS.start
  );
};

const selectDefaultFinish = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  customize: boolean
): Promise<"open-change-request" | "integrate" | "ship"> => {
  if (inputs.defaultFinish) {
    return choiceValue<"open-change-request" | "integrate" | "ship">(
      inputs.defaultFinish,
      FINISH_CHOICES,
      ONBOARDING_QUESTIONS.finish
    );
  }
  if (!customize) {
    return preferredFinish(defaults);
  }
  prompter.present?.(
    [
      "This sets the normal finish line for ready work. Checks and required review still apply at every level.",
      "",
      `Review: ${finishPath("open-change-request")}`,
      `Merge:  ${finishPath("integrate")}`,
      `Ship:   ${finishPath("ship")}`,
    ].join("\n")
  );
  return choiceValue<"open-change-request" | "integrate" | "ship">(
    await prompter.choose(
      ONBOARDING_QUESTIONS.finish,
      FINISH_CHOICES,
      preferredFinish(defaults)
    ),
    FINISH_CHOICES,
    ONBOARDING_QUESTIONS.finish
  );
};

const selectProductionDeploy = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  customize: boolean,
  finish: RepoPolicy["defaultFinish"]
): Promise<RepoPolicy["productionDeploy"]> => {
  if (inputs.productionDeploy) {
    return inputs.productionDeploy;
  }
  if (finish !== "ship") {
    return "ask";
  }
  if (!customize) {
    return defaults.productionDeploy;
  }
  return choiceValue<RepoPolicy["productionDeploy"]>(
    await prompter.choose(
      ONBOARDING_QUESTIONS.production,
      PRODUCTION_CHOICES,
      defaults.productionDeploy
    ),
    PRODUCTION_CHOICES,
    ONBOARDING_QUESTIONS.production
  );
};

const selectChangelogHandling = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  context: ChangelogCoordination,
  customize: boolean
): Promise<RepoPolicy["changelogHandling"]> => {
  if (inputs.changelogHandling) {
    return inputs.changelogHandling;
  }
  if (!(context.relevant && customize)) {
    return defaults.changelogHandling;
  }
  return choiceValue<RepoPolicy["changelogHandling"]>(
    await prompter.choose(
      ONBOARDING_QUESTIONS.changelog,
      CHANGELOG_CHOICES,
      defaults.changelogHandling
    ),
    CHANGELOG_CHOICES,
    ONBOARDING_QUESTIONS.changelog
  );
};

const selectQuestions = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  customize: boolean
): Promise<RepoPolicy["questions"]> => {
  if (inputs.questions) {
    return inputs.questions;
  }
  if (!customize) {
    return defaults.questions;
  }
  return choiceValue<RepoPolicy["questions"]>(
    await prompter.choose(
      ONBOARDING_QUESTIONS.permission,
      PERMISSION_CHOICES,
      defaults.questions
    ),
    PERMISSION_CHOICES,
    ONBOARDING_QUESTIONS.permission
  );
};

const selectScope = async (
  setupStyle: SetupStyle,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  primaryCheckout: string | null,
  showFirstScreen: boolean
): Promise<SetupScope> => {
  if (setupStyle === "run") {
    return "run";
  }
  if (inputs.scope) {
    return inputs.scope;
  }
  if (setupStyle === "recommended") {
    return recommendedScope(primaryCheckout);
  }
  prompter.present?.(renderScopeDiagram(primaryCheckout));
  const choices =
    primaryCheckout || !showFirstScreen
      ? SCOPE_CHOICES
      : SCOPE_CHOICES.filter((choice) => choice.value !== "repository");
  return choiceValue<SetupScope>(
    await prompter.choose(
      ONBOARDING_QUESTIONS.scope,
      choices,
      recommendedScope(primaryCheckout)
    ),
    choices,
    ONBOARDING_QUESTIONS.scope
  );
};

export const collectOnboardingSelection = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  context: ChangelogCoordination = DEFAULT_CHANGELOG_CONTEXT,
  primaryCheckout: string | null = null,
  uiArtifactsRelevant = false,
  conversation: OnboardingConversationOptions = {}
): Promise<OnboardingSelection> => {
  const setupStyle = await selectSetupStyle(
    defaults,
    inputs,
    prompter,
    context,
    primaryCheckout,
    conversation.showFirstScreen ?? false
  );
  const customize = setupStyle === "customize";
  const defaultFinish = await selectDefaultFinish(
    defaults,
    inputs,
    prompter,
    customize
  );
  const productionDeploy = await selectProductionDeploy(
    defaults,
    inputs,
    prompter,
    customize,
    defaultFinish
  );
  const changelogHandling = await selectChangelogHandling(
    defaults,
    inputs,
    prompter,
    context,
    customize
  );
  const uiArtifactVersioning =
    customize || inputs.uiArtifactVersioning
      ? await selectUiArtifactVersioning(
          defaults,
          inputs,
          prompter,
          uiArtifactsRelevant
        )
      : defaults.uiArtifactVersioning;
  const questions = await selectQuestions(
    defaults,
    inputs,
    prompter,
    customize
  );
  const scope = await selectScope(
    setupStyle,
    inputs,
    prompter,
    primaryCheckout,
    conversation.showFirstScreen ?? false
  );
  const { handoffTiming, instructionPointer } = await selectInstructionPointer(
    inputs,
    scope,
    prompter,
    primaryCheckout
  );
  const policy: RepoPolicy = {
    changelogHandling,
    concurrentWork: inputs.concurrentWork ?? defaults.concurrentWork,
    defaultFinish,
    guidance: {
      version: 1,
    },
    handoffTiming,
    productionDeploy,
    questions,
    review: defaults.review,
    schemaVersion: 1,
    uiArtifactVersioning,
  };
  const summary = renderOnboardingSummary(
    policy,
    scope,
    context,
    instructionPointer,
    uiArtifactsRelevant
  );
  return {
    confirmed: await prompter.confirm(summary),
    instructionPointer,
    policy,
    scope,
    setupStyle,
    summary,
  };
};
