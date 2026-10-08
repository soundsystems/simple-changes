import { existsSync, readFileSync } from "node:fs";
import type { AuthoringSidecar } from "./authoring.ts";
import {
  type AuthoringOnboardingContext,
  collectAuthoringAnswers,
  renderAuthoringSummary,
} from "./authoring-onboarding.ts";
import { CURRENT_GUIDANCE_VERSION } from "./guidance-updates.ts";
import {
  discoverInstructionTargets,
  type InstructionTarget,
  renderInstructionPointer,
} from "./repository-instructions.ts";
import type {
  ChangelogCoordination,
  ChangelogInstallDecision,
  ChangelogInstallOffer,
  MigrationTarget,
  RepoPolicy,
} from "./types.ts";

export type SetupScope = "user" | "repository" | "run";
export type SetupStyle = "recommended" | "walkthrough" | "customize" | "run";

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
  input?: (question: string) => Promise<string>;
  present?: (message: string) => void;
}

export interface OnboardingInputs {
  changelogHandling?: RepoPolicy["changelogHandling"];
  changelogInstall?: ChangelogInstallDecision;
  concurrentWork?: RepoPolicy["concurrentWork"];
  defaultFinish?: RepoPolicy["defaultFinish"];
  gitPushAuthorization?: RepoPolicy["gitPushAuthorization"];
  handoffTiming?: RepoPolicy["handoffTiming"];
  instructionFile?: string;
  instructionPointer?: "add" | "leave";
  migrationHandling?: RepoPolicy["migrationHandling"];
  migrationTargets?: MigrationTarget[];
  productionDeploy?: RepoPolicy["productionDeploy"];
  proposalScheduling?: RepoPolicy["proposalScheduling"];
  proposalSignatures?: RepoPolicy["proposalSignatures"];
  questions?: RepoPolicy["questions"];
  scope?: SetupScope;
  shippingMode?: RepoPolicy["shippingMode"];
  uiArtifactVersioning?: RepoPolicy["uiArtifactVersioning"];
}

export interface OnboardingSelection {
  // The authoring answer: saved beside the policy for a repository or
  // personal scope, and applied to the current request only for run-only
  // scope. Null when the authoring questions did not run.
  authoring: AuthoringSidecar | null;
  changelogInstall: ChangelogInstallOffer;
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
  // Detection and pre-fill for the authoring questions; they run only when
  // this is supplied (the interactive setup does; agents use setup --authoring).
  authoring?: Omit<AuthoringOnboardingContext, "setupStyle"> | null;
  existingPersonalDefaults?: RepoPolicy | null;
  forgeProvider?: string | null;
  showFirstScreen?: boolean;
}

export const ONBOARDING_QUESTIONS = {
  changelog: "How should changelog work be handled?",
  changelogInstall: "Would you like me to install Simple Changelogs now?",
  changelogInstallTiming:
    "When should I set up Simple Changelogs: now, after this shipment, or later?",
  existingPersonalDefaults:
    "I found existing global personal defaults. Would you like to use them for this run?",
  finish: "How far should I usually take ready work?",
  gitPushAuthorization:
    "Should Simple Changes configure this harness for routine repository pushes?",
  handoff:
    "When an agent finishes implementation and verification, when should Simple Changes take over?",
  instructionFile: "Which instruction file should Simple Changes update?",
  instructionPointer: (path: string) =>
    `Should I add a short Simple Changes instruction to \`${path}\`?`,
  migrationHandling:
    "How should reviewed database migrations be handled during Ship?",
  migrationTarget:
    "Which exact database targets may use automatic migration apply?",
  permission: "When should I ask for permission or help?",
  production: "What should happen with production?",
  proposalScheduling:
    "When there are multiple independent change proposals, what should I optimize for?",
  proposalSignatures:
    "Should agents sign the change proposals they author, review, or merge?",
  scope: "Where should these preferences live?",
  shippingMode: "How should routine Ship requests run?",
  start:
    "Simple Changes can set up the workflow before continuing. Choose one:",
  uiArtifactVersioning:
    "When I save multiple UI iterations, how should their version names be chosen?",
} as const;

const DEFAULT_CHANGELOG_CONTEXT: ChangelogCoordination = {
  capabilityAvailable: false,
  capabilityHelpers: [],
  capabilityStatus: "absent",
  guidanceUpdate: {
    actions: [],
    detailsPath: null,
    headline: "**Simple Changelogs has recently been updated.**",
    installedVersion: null,
    owner: null,
    policyPath: null,
    provider: null,
    status: "absent",
    storedVersion: null,
    summaryBullets: [],
    walkthroughQuestion:
      "Would you like me to walk you through the recent Simple Changelogs updates before I continue?",
  },
  providerDistribution: null,
  providerEvidence: "none",
  providers: [],
  releaseSurfaces: [],
  relevant: false,
};

const FINISH_CHOICES = [
  {
    description: "Create focused change proposals, run checks, and stop.",
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

export const PROPOSAL_SIGNATURE_CHOICES = [
  {
    description:
      "Every agent appends a double-bracketed `Authored by`, `Reviewed by`, or `Merged by` line with its model name and version to the proposal description, and co-authors are credited from commit trailers and changelog signatures, so provider history shows which model did what.",
    label: "Sign with model name and version (Recommended)",
    value: "agent-and-version",
  },
  {
    description:
      "Proposals carry no agent signature; provider history shows only the account that acted.",
    label: "No signatures",
    value: "none",
  },
] as const;

export const PROPOSAL_SCHEDULING_CHOICES = [
  {
    description:
      "Usually work consecutively, but use parallel worktrees when they save meaningful time or isolation is necessary; ask again only when the tradeoff is substantial.",
    label: "Balanced",
    value: "balanced",
  },
  {
    description:
      "Prefer one change proposal at a time to minimize duplicate dependencies, build outputs, caches, and worktrees.",
    label: "Save space",
    value: "consecutive",
  },
  {
    description:
      "Prefer separate claimed worktrees for independent change proposals to finish sooner, while confirming unusually expensive fan-out.",
    label: "Save time",
    value: "parallel",
  },
] as const satisfies readonly OnboardingChoice[];

const PRODUCTION_CHOICES = [
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

export const SHIPPING_MODE_CHOICES = [
  {
    description:
      "Complete changelog and release reconciliation before the first production deployment.",
    label: "Standard shipping",
    value: "standard",
  },
  {
    description:
      "Keep checks, independent review, and merge before deployment, then finish release reconciliation, verification, and cleanup immediately afterward.",
    label: "Expedited by default",
    value: "expedited",
  },
  {
    description:
      "Deploy one exact candidate before independent review when production is pre-approved and rollback is verified, then immediately finish checks, review, reconciliation, and verification.",
    label: "Break-glass by default (Advanced)",
    value: "break-glass",
  },
] as const satisfies readonly OnboardingChoice[];

export const GIT_PUSH_AUTHORIZATION_CHOICES = [
  {
    description:
      "After an exact scope acknowledgement, allow ordinary git push only to one verified repository and remote. This grants no credentials, network access, force push, branch-protection bypass, proposal/merge/deploy authority, or other destination; host policy still wins.",
    label: "Configure this harness",
    value: "configure-harness",
  },
  {
    description:
      "Leave harness settings unchanged and request authorization at each Git push boundary.",
    label: "Ask for each push",
    value: "ask",
  },
  {
    description:
      "Never request or configure push access; stop with the local branch ready.",
    label: "Never push",
    value: "never",
  },
] as const satisfies readonly OnboardingChoice[];

export const MIGRATION_HANDLING_CHOICES = [
  {
    description:
      "Review every migration, then ask before applying it to the exact remote target.",
    label: "Ask after review",
    value: "ask-after-review",
  },
  {
    description:
      "After review, automatically apply only routine, reversible, bounded, lock-safe migrations to saved exact targets.",
    label: "Auto-apply routine after review (Advanced)",
    value: "auto-apply-reviewed-routine",
  },
  {
    description:
      "After review, automatically apply routine and other eligible safe migrations to saved exact targets; hard exclusions still require approval.",
    label: "Auto-apply eligible after review (Advanced)",
    value: "auto-apply-reviewed",
  },
  {
    description:
      "Review and report migrations, but never apply them automatically.",
    label: "Never apply automatically",
    value: "never",
  },
] as const satisfies readonly OnboardingChoice[];

const MIGRATION_TARGET_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
const MIGRATION_TARGET_PROJECT_PATTERN = /^[A-Za-z0-9._/-]+$/u;

export const parseMigrationTargets = (value: string): MigrationTarget[] => {
  const targets = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(":");
      const [provider, project, environment] = parts;
      if (
        parts.length !== 3 ||
        !provider ||
        !MIGRATION_TARGET_NAME_PATTERN.test(provider) ||
        !project ||
        !MIGRATION_TARGET_PROJECT_PATTERN.test(project) ||
        !environment ||
        !MIGRATION_TARGET_NAME_PATTERN.test(environment)
      ) {
        throw new Error(
          `Invalid migration target "${item}"; use provider:project:environment.`
        );
      }
      return { environment, project, provider };
    });
  return [
    ...new Map(
      targets.map((target) => [
        `${target.provider}:${target.project}:${target.environment}`,
        target,
      ])
    ).values(),
  ];
};

const PERMISSION_CHOICES = [
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

const CHANGELOG_CHOICES = [
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

export const CHANGELOG_INSTALL_CHOICES = [
  {
    description:
      "Install the Simple Changelogs skill after this consent; installation grants no version, release, publication, deployment, or data-write authority.",
    label: "Yes, install it",
    value: "install",
  },
  {
    description:
      "Do not install anything; leave changelog destinations untouched and report the remaining work for a separate workflow.",
    label: "No, keep changelog work preserved and reported",
    value: "decline",
  },
] as const satisfies readonly OnboardingChoice[];

export const CHANGELOG_INSTALL_TIMING_CHOICES = [
  {
    description:
      "Run its separate owner-controlled onboarding, rediscover compatibility, then return with delegation recommended.",
    label: "Now",
    value: "install-now",
  },
  {
    description:
      "Record a follow-up and preserve current changelog work; if this shipment requires changelog reconciliation before it can complete, setup must happen now or the shipment must stop at the safe pre-release boundary.",
    label: "After this shipment",
    value: "install-after-shipment",
  },
  {
    description:
      "Leave the skill installed but unconfigured and preserve/report changelog work until you ask to set it up.",
    label: "Later",
    value: "install-later",
  },
] as const satisfies readonly OnboardingChoice[];

const SIMPLE_CHANGELOGS_SOURCE =
  "https://gitlab.com/soundsystems/simple-changelogs";
const DEFAULT_CHANGELOG_INSTALLATION = "simple-changelogs";
// Inverse of the installation-name -> distribution mapping used by changelog
// discovery, so the offered command installs the distribution the repository's
// `.simple-changelogs.json` already declares.
const INSTALLATION_BY_DISTRIBUTION: Record<string, string> = {
  full: DEFAULT_CHANGELOG_INSTALLATION,
  mobile: "simple-changelogs-mobile",
  "skill-repository": "simple-changelogs-skill-maintainer",
  web: "simple-changelogs-web",
  "web-cms": "simple-changelogs-web-cms",
};

const NO_CHANGELOG_INSTALL_OFFER: ChangelogInstallOffer = {
  command: null,
  decision: null,
  distribution: null,
  offered: false,
};

const declaredChangelogDistribution = (
  policyPath: string | null
): string | null => {
  if (!(policyPath && existsSync(policyPath))) {
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(policyPath, "utf8")) as {
      distribution?: unknown;
    };
    return typeof value.distribution === "string" && value.distribution
      ? value.distribution
      : null;
  } catch {
    return null;
  }
};

export const changelogInstallOfferApplies = (
  context: ChangelogCoordination
): boolean => context.relevant && !context.capabilityAvailable;

// The exact install command for the repository's declared distribution. The
// agent may run it only after the user answers the install offer; nothing here
// installs anything.
export const resolveChangelogInstallCommand = (
  context: ChangelogCoordination
): { command: string; distribution: string | null } => {
  const distribution = declaredChangelogDistribution(
    context.guidanceUpdate.policyPath
  );
  const installation =
    (distribution ? INSTALLATION_BY_DISTRIBUTION[distribution] : undefined) ??
    DEFAULT_CHANGELOG_INSTALLATION;
  return {
    command: `bunx skills add ${SIMPLE_CHANGELOGS_SOURCE} --skill ${installation}`,
    distribution,
  };
};

// Describes the pending offer for a status report before any question has been
// asked; the command is informational until the user consents.
export const pendingChangelogInstallOffer = (
  context: ChangelogCoordination
): ChangelogInstallOffer | null =>
  changelogInstallOfferApplies(context)
    ? {
        ...NO_CHANGELOG_INSTALL_OFFER,
        ...resolveChangelogInstallCommand(context),
      }
    : null;

const SCOPE_CHOICES = [
  {
    description:
      "Save a visible .simple-changes.json beside the project so teammates and future agents use the same workflow.",
    label: "This repository",
    value: "repository",
  },
  {
    description:
      "Save private global personal defaults that apply only when a repository has no team policy.",
    label: "Global personal defaults",
    value: "user",
  },
  {
    description:
      "Use the choices for the current task, write no preference file, and show onboarding again next time.",
    label: "This run only",
    value: "run",
  },
] as const satisfies readonly OnboardingChoice[];

const existingPersonalDefaultChoices = [
  {
    description:
      "Apply the existing private fallback to this run without changing any preference file.",
    label: "Use global personal defaults",
    value: "use",
  },
  {
    description:
      "Continue through onboarding; choosing global personal storage later will overwrite the existing private fallback.",
    label: "Review or replace them",
    value: "review",
  },
] as const satisfies readonly OnboardingChoice[];

const scopeChoices = (
  existingPersonalDefaults: boolean
): readonly OnboardingChoice[] =>
  SCOPE_CHOICES.map((choice) =>
    choice.value === "user" && existingPersonalDefaults
      ? {
          ...choice,
          description:
            "Update and overwrite the existing private global personal defaults used when a repository has no team policy.",
          label: "Update global personal defaults",
        }
      : choice
  );

const finishPath = (
  finish: RepoPolicy["defaultFinish"],
  forgeProvider?: string | null
): string => {
  const proposal = `ready work -> focused ${proposalTerms(forgeProvider).singular} -> checks`;
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

const renderScopeDiagram = (
  primaryCheckout: string | null,
  existingPersonalDefaults: boolean
): string => {
  const repositoryPath = primaryCheckout
    ? `${primaryCheckout}/.simple-changes.json`
    : ".simple-changes.json (requires a Git repository)";
  return [
    "This choice controls where the answers are remembered; it does not change how far the current task is allowed to go.",
    "",
    `Repository               -> ${repositoryPath} -> team policy`,
    `Global personal defaults -> private preferences.json -> ${existingPersonalDefaults ? "update/overwrite private fallback" : "private fallback"}`,
    "This run                -> no file                  -> ask next time",
  ].join("\n");
};

const renderFirstScreenIntroduction = (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  context: ChangelogCoordination,
  primaryCheckout: string | null,
  forgeProvider?: string | null
): string => {
  const finish = inputs.defaultFinish ?? preferredFinish(defaults);
  const location = primaryCheckout
    ? `I found the repository at ${primaryCheckout}.`
    : "No Git repository is active, so repository-level preferences are unavailable.";
  let changelog = "No changelog decision is needed for this setup.";
  if (context.relevant && context.capabilityAvailable) {
    changelog =
      "A compatible Simple Changelogs workflow is available; delegation is the recommended default, while version and release authority remain separate.";
  } else if (context.relevant) {
    changelog =
      "Changelog surfaces were found, but no compatible changelog workflow is available; the safe default is to preserve and report that work.";
  }
  return [
    "Simple Changes begins with a repository inventory, separates stable work into focused change units, runs the relevant checks, obtains required review, and then stops, merges, or ships according to your preference. A shipping run will verify the exact delivered revision and clean up only work that is proven safe to remove.",
    "Here are the main ways you can use it:",
    "- “Sync with main”: Safely update your local checkout without pushing anything.",
    `- “Put this up”: Turn ready work into a focused ${proposalTerms(forgeProvider).singular} and stop for review.`,
    `- “Open changes for everything ready”: Create separate ${proposalTerms(forgeProvider).plural} for each ready piece of work.`,
    "- “Merge what’s ready”: Run checks and merge work that has the required approval.",
    "- “Ship what’s ready”: Merge, deploy when authorized, and verify exactly what went live.",
    "- “Clean up the repo”: Reconcile branches and worktrees, removing only things proven safe.",
    "- “Show me what you would do”: Preview the plan without changing anything.",
    "- “Continue”: Safely resume an unfinished Simple Changes run.",
    "- “Leave this work alone”: Preserve active work while handling independent changes.",
    "Simple Changes can also coordinate release-note work with Simple Changelogs when it is installed, but it does not write changelogs itself. Mention urgency when speed matters; reserve deploy-before-review direction for a real user-impacting emergency.",
    "This is first-use onboarding inside your original Simple Changes task. It decides the normal stopping point, when I interrupt you, and where those answers are remembered. It does not itself create a branch, push, merge, or deploy anything.",
    "",
    location,
    changelog,
    "",
    "Recommended workflow for this request:",
    finishPath(finish, forgeProvider),
    "Ask only when blocked. Production remains a separate confirmation unless you explicitly change it. High-risk operations such as migrations, secrets, DNS, store releases, and history rewrites always remain separately gated.",
    "Would you like a walkthrough before I continue? Choose “Walk me through it” below for every workflow and preference, one at a time.",
  ].join("\n");
};

const onboardingStyleChoices = (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  primaryCheckout: string | null,
  context: ChangelogCoordination
): readonly OnboardingChoice[] => {
  const finish = inputs.defaultFinish ?? preferredFinish(defaults);
  const scope = recommendedScope(primaryCheckout);
  const scopeDescription =
    scope === "repository"
      ? "save the result as visible repository policy"
      : "save the result as private global personal defaults";
  const changelogDescription =
    context.relevant && context.capabilityAvailable
      ? "delegate changelog work to the compatible installed workflow"
      : "preserve changelog work for its owning workflow";
  return [
    {
      description: `Use ${finishLabel(finish)}, ask only when blocked, keep production confirmation in place, ${changelogDescription}, and ${scopeDescription}. You will see a full receipt before anything is written.`,
      label: "Use recommended setup",
      value: "recommended",
    },
    {
      description:
        "Explain every main workflow and each preference in plain language, one at a time, before saving anything.",
      label: "Walk me through it",
      value: "walkthrough",
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

const INSTRUCTION_POINTER_CHOICES = [
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

const migrationHandlingLabel = (
  handling: RepoPolicy["migrationHandling"]
): string =>
  MIGRATION_HANDLING_CHOICES.find((choice) => choice.value === handling)
    ?.label ?? handling;

const proposalSchedulingLabel = (
  scheduling: RepoPolicy["proposalScheduling"]
): string =>
  PROPOSAL_SCHEDULING_CHOICES.find((choice) => choice.value === scheduling)
    ?.label ?? scheduling;

const proposalSignaturesLabel = (
  signatures: RepoPolicy["proposalSignatures"]
): string =>
  signatures === "agent-and-version"
    ? "signed with each agent's model name and version"
    : "unsigned";

const proposalTerms = (
  provider: string | null | undefined
): { plural: string; singular: string } => {
  if (provider === "github") {
    return { plural: "PRs", singular: "PR" };
  }
  if (provider === "gitlab") {
    return { plural: "MRs", singular: "MR" };
  }
  return { plural: "change proposals", singular: "change proposal" };
};

const migrationTargetLabel = (target: MigrationTarget): string =>
  `${target.provider}:${target.project}:${target.environment}`;

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

const changelogInstallTimingLabel = (
  decision: ChangelogInstallDecision
): string =>
  CHANGELOG_INSTALL_TIMING_CHOICES.find((choice) => choice.value === decision)
    ?.label ?? decision;

const changelogInstallSummary = (
  offer: ChangelogInstallOffer | null | undefined
): string | null => {
  if (!offer?.offered) {
    return null;
  }
  if (offer.decision === "declined" || offer.decision === null) {
    return "Simple Changelogs install: declined; changelog work stays preserved and reported for its owning workflow.";
  }
  const followUp =
    offer.decision === "install-now"
      ? "setup then continues with the provider's own owner-controlled onboarding"
      : "its setup is recorded as outstanding work";
  return `Simple Changelogs install: ${changelogInstallTimingLabel(offer.decision)}. I'll run \`${offer.command}\` only after this consent, and ${followUp}; installation grants no version, release, publication, deployment, or data-write authority.`;
};

const finishActionSummary = (
  policy: RepoPolicy,
  forgeProvider?: string | null
): string => {
  const { plural } = proposalTerms(forgeProvider);
  if (policy.defaultFinish === "integrate") {
    return `I'll create focused ${plural}, run checks, wait for required approval, and merge the exact approved revisions.`;
  }
  if (policy.defaultFinish === "ship") {
    return `I'll create focused ${plural}, run checks, wait for required approval, merge the exact approved revisions, deploy authorized targets, and verify the live application.`;
  }
  return `I'll create focused ${plural}, run checks, and stop with the work ready for review.`;
};

const shippingSummary = (
  policy: RepoPolicy
): { production: string | null; shippingMode: string | null } => {
  if (policy.defaultFinish !== "ship") {
    return { production: null, shippingMode: null };
  }
  let production = "I'll ask before deploying production.";
  if (policy.productionDeploy === "allow") {
    production =
      "Production deployment is pre-approved when repository rules allow it.";
  } else if (policy.productionDeploy === "deny") {
    production = "I won't deploy production.";
  }
  let shippingMode =
    "Standard shipping completes release reconciliation before the first production deployment.";
  if (policy.shippingMode === "expedited") {
    shippingMode =
      "Expedited shipping keeps review and merge before the first deployment, then completes release reconciliation, final verification, and cleanup immediately afterward.";
  } else if (policy.shippingMode === "break-glass") {
    shippingMode =
      policy.productionDeploy === "allow"
        ? "Break-glass ordering and production deployment are pre-approved: a Ship request may deploy one exact candidate before independent review after rollback is verified, then must immediately finish checks, review, reconciliation, and final verification."
        : "Break-glass ordering is the default, but production still requires approval; rollback evidence is also required before an early deployment.";
  }
  return { production, shippingMode };
};

const gitPushAuthorizationSummary = (policy: RepoPolicy): string | null => {
  if (policy.defaultFinish === "preview") {
    return null;
  }
  if (policy.gitPushAuthorization === "configure-harness") {
    return "Git pushes: allow ordinary git push only to one verified repository and remote. This grants no credentials, network access, force push, branch-protection bypass, proposal, merge, deployment, or other-destination authority; unsupported harnesses keep asking.";
  }
  if (policy.gitPushAuthorization === "never") {
    return "Git pushes: never request or configure push access; stop with local work ready.";
  }
  return "Git pushes: leave harness settings unchanged and ask at each push boundary.";
};

const instructionPointerSummary = (
  instructionPointer: OnboardingSelection["instructionPointer"]
): string => {
  if (instructionPointer.action === "leave") {
    return "Agent instructions will remain unchanged.";
  }
  if (instructionPointer.action === "add" && instructionPointer.target) {
    return `Instruction pointer: update ${instructionPointer.target.scope} file ${instructionPointer.target.path}.\nProposed managed pointer:\n${instructionPointer.block}`;
  }
  return "No existing instruction file was selected, so no instruction pointer will be written.";
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
  uiArtifactsRelevant = false,
  forgeProvider?: string | null,
  changelogInstall?: ChangelogInstallOffer | null
): string => {
  const actions = finishActionSummary(policy, forgeProvider);
  const { production, shippingMode } = shippingSummary(policy);
  const pointerSummary = instructionPointerSummary(instructionPointer);
  return [
    `Your workflow is set to ${finishLabel(policy.defaultFinish)}.`,
    actions,
    production,
    shippingMode,
    gitPushAuthorizationSummary(policy),
    policy.defaultFinish === "ship"
      ? `Migration handling: ${migrationHandlingLabel(policy.migrationHandling)}.`
      : null,
    policy.defaultFinish === "ship" && policy.migrationTargets.length > 0
      ? `Automatic migration targets: ${policy.migrationTargets.map(migrationTargetLabel).join(", ")}.`
      : null,
    changelogSummary(policy, context),
    changelogInstallSummary(changelogInstall),
    policy.concurrentWork === "strict"
      ? "Concurrent worktrees: strict repository-wide serialization; claimed owners must pause before integration continues."
      : "Concurrent worktrees: independent agents may keep working in distinct actively claimed worktrees while integration stays single-controller.",
    `Multiple ${proposalTerms(forgeProvider).plural}: ${proposalSchedulingLabel(policy.proposalScheduling)}.`,
    `${proposalTerms(forgeProvider).plural} agents author, review, or merge: ${proposalSignaturesLabel(policy.proposalSignatures)}.`,
    uiArtifactsRelevant
      ? `Saved UI iteration naming: ${uiArtifactVersioningLabel(policy.uiArtifactVersioning)}. Repository conventions still take precedence.`
      : null,
    `Permission and help: ${permissionLabel(policy.questions)}.`,
    `Preference scope: ${scopeLabel(scope)}.`,
    scope === "run" ? null : pointerSummary,
    instructionPointer.action === "add"
      ? `Completed-work handoff: ${handoffLabel(policy.handoffTiming)}.`
      : null,
    "Every migration is reviewed before apply. Destructive, irreversible, unbounded, lock-heavy, target-mismatched, or unprotected migrations still require explicit exact-target authorization; backfills, secrets, DNS changes, store releases, and history rewrites remain separately gated.",
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
  showFirstScreen: boolean,
  forgeProvider?: string | null
): Promise<SetupStyle> => {
  if (!showFirstScreen) {
    return "customize";
  }
  prompter.present?.(
    renderFirstScreenIntroduction(
      defaults,
      inputs,
      context,
      primaryCheckout,
      forgeProvider
    )
  );
  const choices = onboardingStyleChoices(
    defaults,
    inputs,
    primaryCheckout,
    context
  );
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
  customize: boolean,
  forgeProvider?: string | null
): Promise<"open-change-request" | "integrate" | "ship"> => {
  const terms = proposalTerms(forgeProvider);
  const finishChoices = FINISH_CHOICES.map((choice) =>
    choice.value === "open-change-request"
      ? {
          ...choice,
          description: `Create focused ${terms.plural}, run checks, and stop.`,
        }
      : choice
  );
  if (inputs.defaultFinish) {
    return choiceValue<"open-change-request" | "integrate" | "ship">(
      inputs.defaultFinish,
      finishChoices,
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
      `Review: ${finishPath("open-change-request", forgeProvider)}`,
      `Merge:  ${finishPath("integrate", forgeProvider)}`,
      `Ship:   ${finishPath("ship", forgeProvider)}`,
    ].join("\n")
  );
  return choiceValue<"open-change-request" | "integrate" | "ship">(
    await prompter.choose(
      ONBOARDING_QUESTIONS.finish,
      finishChoices,
      preferredFinish(defaults)
    ),
    finishChoices,
    ONBOARDING_QUESTIONS.finish
  );
};

const selectProposalSignatures = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  customize: boolean,
  forgeProvider?: string | null
): Promise<RepoPolicy["proposalSignatures"]> => {
  if (inputs.proposalSignatures) {
    return inputs.proposalSignatures;
  }
  if (!customize) {
    return defaults.proposalSignatures;
  }
  const terms = proposalTerms(forgeProvider);
  const question = `Should agents sign the ${terms.plural} they author, review, or merge?`;
  const choices = PROPOSAL_SIGNATURE_CHOICES.map((choice) => ({
    ...choice,
    description: choice.description.replaceAll("proposal", terms.singular),
  }));
  return choiceValue<RepoPolicy["proposalSignatures"]>(
    await prompter.choose(question, choices, defaults.proposalSignatures),
    choices,
    question
  );
};

const selectProposalScheduling = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  customize: boolean,
  forgeProvider?: string | null
): Promise<RepoPolicy["proposalScheduling"]> => {
  if (inputs.proposalScheduling) {
    return inputs.proposalScheduling;
  }
  if (!customize) {
    return defaults.proposalScheduling;
  }
  prompter.present?.(
    "Git history is shared across worktrees, but dependencies, build outputs, and caches may be duplicated. Completed worktrees are removed automatically only after their work is proven integrated; active or uncertain work stays untouched."
  );
  const terms = proposalTerms(forgeProvider);
  const question = `When there are multiple independent ${terms.plural}, what should I optimize for?`;
  const choices = PROPOSAL_SCHEDULING_CHOICES.map((choice) => ({
    ...choice,
    description: choice.description
      .replaceAll("change proposals", terms.plural)
      .replaceAll("change proposal", terms.singular),
  }));
  return choiceValue<RepoPolicy["proposalScheduling"]>(
    await prompter.choose(question, choices, defaults.proposalScheduling),
    choices,
    question
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

const selectShippingMode = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  customize: boolean,
  finish: RepoPolicy["defaultFinish"]
): Promise<RepoPolicy["shippingMode"]> => {
  if (inputs.shippingMode) {
    return inputs.shippingMode;
  }
  if (finish !== "ship" || !customize) {
    return defaults.shippingMode;
  }
  return choiceValue<RepoPolicy["shippingMode"]>(
    await prompter.choose(
      ONBOARDING_QUESTIONS.shippingMode,
      SHIPPING_MODE_CHOICES,
      defaults.shippingMode
    ),
    SHIPPING_MODE_CHOICES,
    ONBOARDING_QUESTIONS.shippingMode
  );
};

const selectGitPushAuthorization = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  customize: boolean,
  finish: RepoPolicy["defaultFinish"]
): Promise<RepoPolicy["gitPushAuthorization"]> => {
  if (inputs.gitPushAuthorization) {
    if (inputs.gitPushAuthorization === "configure-harness") {
      prompter.present?.(
        "Automatic Git pushes cover only ordinary git push to one verified repository and remote. They grant no credentials, network access, force push, branch-protection bypass, proposal, merge, deployment, or other-destination authority. If the harness cannot enforce that exact scope, it must keep asking."
      );
    }
    return inputs.gitPushAuthorization;
  }
  if (finish === "preview" || !customize) {
    return defaults.gitPushAuthorization;
  }
  const selected = choiceValue<RepoPolicy["gitPushAuthorization"]>(
    await prompter.choose(
      ONBOARDING_QUESTIONS.gitPushAuthorization,
      GIT_PUSH_AUTHORIZATION_CHOICES,
      defaults.gitPushAuthorization
    ),
    GIT_PUSH_AUTHORIZATION_CHOICES,
    ONBOARDING_QUESTIONS.gitPushAuthorization
  );
  if (selected === "configure-harness") {
    prompter.present?.(
      "Automatic Git pushes cover only ordinary git push to one verified repository and remote. They grant no credentials, network access, force push, branch-protection bypass, proposal, merge, deployment, or other-destination authority. If the harness cannot enforce that exact scope, it must keep asking."
    );
  }
  return selected;
};

const automaticMigrationHandling = (
  handling: RepoPolicy["migrationHandling"]
): boolean =>
  handling === "auto-apply-reviewed-routine" ||
  handling === "auto-apply-reviewed";

const selectMigrationHandling = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  customize: boolean,
  finish: RepoPolicy["defaultFinish"]
): Promise<RepoPolicy["migrationHandling"]> => {
  if (inputs.migrationHandling) {
    return inputs.migrationHandling;
  }
  if (finish !== "ship" || !customize) {
    return defaults.migrationHandling;
  }
  prompter.present?.(
    "Every tier reviews the exact pending migrations first. Automatic tiers apply only to saved exact targets and never cover destructive, irreversible, unbounded, lock-heavy, or unprotected changes."
  );
  return choiceValue<RepoPolicy["migrationHandling"]>(
    await prompter.choose(
      ONBOARDING_QUESTIONS.migrationHandling,
      MIGRATION_HANDLING_CHOICES,
      defaults.migrationHandling
    ),
    MIGRATION_HANDLING_CHOICES,
    ONBOARDING_QUESTIONS.migrationHandling
  );
};

const selectMigrationTargets = async (
  defaults: RepoPolicy,
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  handling: RepoPolicy["migrationHandling"]
): Promise<MigrationTarget[]> => {
  if (!automaticMigrationHandling(handling)) {
    return [];
  }
  if (inputs.migrationTargets && inputs.migrationTargets.length > 0) {
    return inputs.migrationTargets;
  }
  if (
    defaults.migrationHandling === handling &&
    defaults.migrationTargets.length > 0
  ) {
    return defaults.migrationTargets;
  }
  if (!prompter.input) {
    throw new Error(
      "Automatic migration apply requires --migration-target provider:project:environment."
    );
  }
  prompter.present?.(
    "Automatic migration authority must be bound to exact database targets. Enter one or more comma-separated targets as provider:project:environment."
  );
  const targets = parseMigrationTargets(
    await prompter.input(ONBOARDING_QUESTIONS.migrationTarget)
  );
  if (targets.length === 0) {
    throw new Error("Automatic migration apply requires at least one target.");
  }
  return targets;
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
  const recommendedHandling = context.capabilityAvailable
    ? "delegate-if-available"
    : defaults.changelogHandling;
  if (!(context.relevant && customize)) {
    return context.relevant ? recommendedHandling : defaults.changelogHandling;
  }
  return choiceValue<RepoPolicy["changelogHandling"]>(
    await prompter.choose(
      ONBOARDING_QUESTIONS.changelog,
      CHANGELOG_CHOICES,
      recommendedHandling
    ),
    CHANGELOG_CHOICES,
    ONBOARDING_QUESTIONS.changelog
  );
};

const CHANGELOG_INSTALL_EXPLANATION = [
  "Simple Changelogs owns release classification and release-note writing; Simple Changes never writes release notes itself.",
  "Changelog surfaces were found, but no compatible Simple Changelogs provider is installed, so changelog work is currently preserved and reported.",
  "Nothing is installed without your consent, and installation consent grants no version, release, publication, deployment, or data-write authority.",
].join("\n");

// Offered whenever changelog work is relevant and no compatible provider is
// available, regardless of setup style: the prose requires the offer, and it
// is never satisfied silently. A flag-supplied decision skips the prompt.
const selectChangelogInstall = async (
  inputs: OnboardingInputs,
  prompter: OnboardingPrompter,
  context: ChangelogCoordination
): Promise<ChangelogInstallOffer> => {
  if (!changelogInstallOfferApplies(context)) {
    return NO_CHANGELOG_INSTALL_OFFER;
  }
  const resolved = resolveChangelogInstallCommand(context);
  if (inputs.changelogInstall) {
    return { ...resolved, decision: inputs.changelogInstall, offered: true };
  }
  prompter.present?.(CHANGELOG_INSTALL_EXPLANATION);
  const consent = choiceValue<"install" | "decline">(
    await prompter.choose(
      ONBOARDING_QUESTIONS.changelogInstall,
      CHANGELOG_INSTALL_CHOICES,
      "install"
    ),
    CHANGELOG_INSTALL_CHOICES,
    ONBOARDING_QUESTIONS.changelogInstall
  );
  if (consent === "decline") {
    return { ...resolved, decision: "declined", offered: true };
  }
  const decision = choiceValue<ChangelogInstallDecision>(
    await prompter.choose(
      ONBOARDING_QUESTIONS.changelogInstallTiming,
      CHANGELOG_INSTALL_TIMING_CHOICES,
      "install-now"
    ),
    CHANGELOG_INSTALL_TIMING_CHOICES,
    ONBOARDING_QUESTIONS.changelogInstallTiming
  );
  return { ...resolved, decision, offered: true };
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
  showFirstScreen: boolean,
  existingPersonalDefaults: boolean
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
  prompter.present?.(
    renderScopeDiagram(primaryCheckout, existingPersonalDefaults)
  );
  const availableChoices = scopeChoices(existingPersonalDefaults);
  const choices =
    primaryCheckout || !showFirstScreen
      ? availableChoices
      : availableChoices.filter((choice) => choice.value !== "repository");
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

// The first-screen offer to reuse saved personal defaults for this run.
// Returns the run-only selection when the owner accepts it.
const reuseExistingPersonalDefaults = async (
  prompter: OnboardingPrompter,
  context: ChangelogCoordination,
  uiArtifactsRelevant: boolean,
  conversation: OnboardingConversationOptions
): Promise<OnboardingSelection | null> => {
  const existingPersonalDefaults =
    conversation.existingPersonalDefaults ?? null;
  if (!(conversation.showFirstScreen && existingPersonalDefaults)) {
    return null;
  }
  prompter.present?.(
    "Global personal defaults are a private fallback used only when a repository has no visible team policy. I found an existing saved set; no file has been changed."
  );
  const disposition = choiceValue<"use" | "review">(
    await prompter.choose(
      ONBOARDING_QUESTIONS.existingPersonalDefaults,
      existingPersonalDefaultChoices,
      "use"
    ),
    existingPersonalDefaultChoices,
    ONBOARDING_QUESTIONS.existingPersonalDefaults
  );
  if (disposition === "use") {
    const instructionPointer: OnboardingSelection["instructionPointer"] = {
      action: "unavailable",
      block: null,
      target: null,
    };
    // This run writes nothing, but the review question still follows its
    // own trigger: run-only setup asks it with two or more harnesses.
    const authoring = conversation.authoring
      ? await collectAuthoringAnswers(
          { ...conversation.authoring, setupStyle: "run" },
          prompter
        )
      : null;
    const summary = [
      "Use the existing global personal defaults for this run.",
      "No repository policy or personal preference file will be changed.",
      renderOnboardingSummary(
        existingPersonalDefaults,
        "run",
        context,
        instructionPointer,
        uiArtifactsRelevant,
        conversation.forgeProvider
      ),
      authoring
        ? renderAuthoringSummary(
            authoring,
            conversation.authoring?.definitions ?? []
          )
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");
    return {
      authoring,
      changelogInstall: NO_CHANGELOG_INSTALL_OFFER,
      confirmed: await prompter.confirm(summary),
      instructionPointer,
      policy: existingPersonalDefaults,
      scope: "run",
      setupStyle: "run",
      summary,
    };
  }
  return null;
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
  const existingPersonalDefaults =
    conversation.existingPersonalDefaults ?? null;
  const reused = await reuseExistingPersonalDefaults(
    prompter,
    context,
    uiArtifactsRelevant,
    conversation
  );
  if (reused) {
    return reused;
  }
  const setupStyle = await selectSetupStyle(
    defaults,
    inputs,
    prompter,
    context,
    primaryCheckout,
    conversation.showFirstScreen ?? false,
    conversation.forgeProvider
  );
  const customize = setupStyle === "customize" || setupStyle === "walkthrough";
  const defaultFinish = await selectDefaultFinish(
    defaults,
    inputs,
    prompter,
    customize,
    conversation.forgeProvider
  );
  // Prompted only in the full interactive walkthrough; agent-driven flows
  // resolve this in chat and pass --proposal-scheduling explicitly, which
  // selectProposalScheduling honors before the gate.
  const proposalScheduling = await selectProposalScheduling(
    defaults,
    inputs,
    prompter,
    customize && (conversation.showFirstScreen ?? false),
    conversation.forgeProvider
  );
  const proposalSignatures = await selectProposalSignatures(
    defaults,
    inputs,
    prompter,
    customize && (conversation.showFirstScreen ?? false),
    conversation.forgeProvider
  );
  const authoring = conversation.authoring
    ? await collectAuthoringAnswers(
        { ...conversation.authoring, setupStyle },
        prompter
      )
    : null;
  const productionDeploy = await selectProductionDeploy(
    defaults,
    inputs,
    prompter,
    customize,
    defaultFinish
  );
  const shippingMode = await selectShippingMode(
    defaults,
    inputs,
    prompter,
    customize,
    defaultFinish
  );
  const gitPushAuthorization = await selectGitPushAuthorization(
    defaults,
    inputs,
    prompter,
    customize,
    defaultFinish
  );
  const migrationHandling = await selectMigrationHandling(
    defaults,
    inputs,
    prompter,
    customize,
    defaultFinish
  );
  const migrationTargets = await selectMigrationTargets(
    defaults,
    inputs,
    prompter,
    migrationHandling
  );
  const changelogHandling = await selectChangelogHandling(
    defaults,
    inputs,
    prompter,
    context,
    customize
  );
  const changelogInstall = await selectChangelogInstall(
    inputs,
    prompter,
    context
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
    conversation.showFirstScreen ?? false,
    Boolean(existingPersonalDefaults)
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
    gitPushAuthorization,
    guidance: {
      disposition: customize ? "reviewed" : "accepted",
      version: CURRENT_GUIDANCE_VERSION,
    },
    handoffTiming,
    migrationHandling,
    migrationTargets,
    productionDeploy,
    proposalScheduling,
    proposalSignatures,
    questions,
    review: defaults.review,
    schemaVersion: 1,
    shippingMode,
    uiArtifactVersioning,
  };
  const summary = [
    renderOnboardingSummary(
      policy,
      scope,
      context,
      instructionPointer,
      uiArtifactsRelevant,
      conversation.forgeProvider,
      changelogInstall
    ),
    authoring
      ? renderAuthoringSummary(
          authoring,
          conversation.authoring?.definitions ?? []
        )
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
  return {
    authoring,
    changelogInstall,
    confirmed: await prompter.confirm(summary),
    instructionPointer,
    policy,
    scope,
    setupStyle,
    summary,
  };
};
