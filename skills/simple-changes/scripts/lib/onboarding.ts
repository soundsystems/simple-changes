import type { RepoPolicy } from "./types.ts";

export type SetupScope = "user" | "repository" | "run";

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
}

export interface OnboardingInputs {
  defaultFinish?: RepoPolicy["defaultFinish"];
  productionDeploy?: RepoPolicy["productionDeploy"];
  questions?: RepoPolicy["questions"];
  scope?: SetupScope;
}

export interface OnboardingSelection {
  confirmed: boolean;
  policy: RepoPolicy;
  scope: SetupScope;
  summary: string;
}

export const ONBOARDING_QUESTIONS = {
  finish: "How far should I usually take ready work?",
  permission: "When should I ask for permission or help?",
  production: "What should happen with production?",
  scope: "For what scope should I save these preferences?",
} as const;

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

export const SCOPE_CHOICES = [
  {
    description:
      "Use them as personal defaults when a repository has no policy.",
    label: "Just for me",
    value: "user",
  },
  {
    description: "Save a visible .simple-changes.json in the primary checkout.",
    label: "For this repository",
    value: "repository",
  },
  {
    description: "Use the choices now without writing a policy file.",
    label: "This run only",
    value: "run",
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

export const renderOnboardingSummary = (
  policy: RepoPolicy,
  scope: SetupScope
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
  return [
    `Your workflow is set to ${finishLabel(policy.defaultFinish)}.`,
    actions,
    production,
    `Permission and help: ${permissionLabel(policy.questions)}.`,
    `Preference scope: ${scopeLabel(scope)}.`,
    "Remote migrations, backfills, secrets, DNS changes, store releases, and history rewrites still require explicit, exact-target authorization.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};

export const collectOnboardingSelection = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter
): Promise<OnboardingSelection> => {
  const defaultFinish = inputs.defaultFinish
    ? choiceValue<"open-change-request" | "integrate" | "ship">(
        inputs.defaultFinish,
        FINISH_CHOICES,
        ONBOARDING_QUESTIONS.finish
      )
    : choiceValue<"open-change-request" | "integrate" | "ship">(
        await prompter.choose(
          ONBOARDING_QUESTIONS.finish,
          FINISH_CHOICES,
          preferredFinish(defaults)
        ),
        FINISH_CHOICES,
        ONBOARDING_QUESTIONS.finish
      );
  const productionDeploy =
    defaultFinish === "ship"
      ? (inputs.productionDeploy ??
        choiceValue<RepoPolicy["productionDeploy"]>(
          await prompter.choose(
            ONBOARDING_QUESTIONS.production,
            PRODUCTION_CHOICES,
            defaults.productionDeploy
          ),
          PRODUCTION_CHOICES,
          ONBOARDING_QUESTIONS.production
        ))
      : (inputs.productionDeploy ?? "ask");
  const questions =
    inputs.questions ??
    choiceValue<RepoPolicy["questions"]>(
      await prompter.choose(
        ONBOARDING_QUESTIONS.permission,
        PERMISSION_CHOICES,
        defaults.questions
      ),
      PERMISSION_CHOICES,
      ONBOARDING_QUESTIONS.permission
    );
  const scope =
    inputs.scope ??
    choiceValue<SetupScope>(
      await prompter.choose(ONBOARDING_QUESTIONS.scope, SCOPE_CHOICES, "user"),
      SCOPE_CHOICES,
      ONBOARDING_QUESTIONS.scope
    );
  const policy: RepoPolicy = {
    concurrentWork: "preserve",
    defaultFinish,
    guidance: {
      version: 1,
    },
    productionDeploy,
    questions,
    review: defaults.review,
    schemaVersion: 1,
  };
  const summary = renderOnboardingSummary(policy, scope);
  return {
    confirmed: await prompter.confirm(summary),
    policy,
    scope,
    summary,
  };
};
