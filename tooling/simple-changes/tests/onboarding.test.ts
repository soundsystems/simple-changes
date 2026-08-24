import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectOnboardingSelection,
  GIT_PUSH_AUTHORIZATION_CHOICES,
  HANDOFF_CHOICES,
  MIGRATION_HANDLING_CHOICES,
  ONBOARDING_QUESTIONS,
  type OnboardingChoice,
  PROPOSAL_SCHEDULING_CHOICES,
  renderOnboardingSummary,
  SHIPPING_MODE_CHOICES,
  UI_ARTIFACT_VERSIONING_CHOICES,
} from "../../../skills/simple-changes/scripts/lib/onboarding.ts";
import {
  DEFAULT_POLICY,
  loadPersonalPolicy,
  loadPolicy,
  resolvePersonalPolicyPath,
  writePolicyFile,
  writeRepositoryPolicyTrustReceipt,
} from "../../../skills/simple-changes/scripts/lib/policy.ts";
import type { RepoPolicy } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const configuredPolicy = (changes: Partial<RepoPolicy> = {}): RepoPolicy => ({
  ...DEFAULT_POLICY,
  ...changes,
});

describe("preference storage", () => {
  test("uses the platform configuration directory for personal preferences", () => {
    expect(
      resolvePersonalPolicyPath({
        environment: {},
        homeDirectory: "/Users/example",
        platform: "darwin",
      })
    ).toBe(
      "/Users/example/Library/Application Support/simple-changes/preferences.json"
    );
    expect(
      resolvePersonalPolicyPath({
        environment: {
          SIMPLE_CHANGES_CONFIG_DIR: "/tmp/simple-changes-profile",
        },
        homeDirectory: "/ignored",
        platform: "linux",
      })
    ).toBe("/tmp/simple-changes-profile/simple-changes/preferences.json");
  });

  test("prefers repository policy, then personal policy, then safe defaults", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const personalPath = resolve(
      fixture.base,
      "profile",
      "simple-changes",
      "preferences.json"
    );
    const personalPolicy = configuredPolicy({
      defaultFinish: "integrate",
      questions: "never",
    });
    writePolicyFile(personalPath, personalPolicy, true);

    expect(loadPersonalPolicy(personalPath)).toEqual({
      path: personalPath,
      source: "user",
      trust: "not-required",
      value: personalPolicy,
    });
    expect(
      loadPolicy(fixture.root, { personalPolicyPath: personalPath })
    ).toEqual({
      path: personalPath,
      source: "user",
      trust: "not-required",
      value: personalPolicy,
    });

    const repositoryPath = resolve(fixture.root, ".simple-changes.json");
    const repositoryPolicy = configuredPolicy({
      defaultFinish: "ship",
      productionDeploy: "allow",
    });
    writePolicyFile(repositoryPath, repositoryPolicy);

    expect(
      loadPolicy(fixture.root, { personalPolicyPath: personalPath })
    ).toEqual({
      path: repositoryPath,
      source: "repository",
      trust: "untrusted",
      value: expect.objectContaining({
        gitPushAuthorization: "ask",
        productionDeploy: "ask",
        shippingMode: "standard",
      }),
    });

    expect(
      JSON.parse(readFileSync(repositoryPath, "utf8")) as RepoPolicy
    ).toEqual(repositoryPolicy);
  });

  test("returns safe defaults when no saved preference exists", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const personalPath = resolve(fixture.base, "missing.json");

    expect(
      loadPolicy(fixture.root, { personalPolicyPath: personalPath })
    ).toEqual({
      path: null,
      source: "default",
      trust: "not-required",
      value: DEFAULT_POLICY,
    });
  });

  test("requires a private digest-bound receipt for consequential repository policy", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const repositoryPath = resolve(fixture.root, ".simple-changes.json");
    const repositoryPolicy = configuredPolicy({
      gitPushAuthorization: "configure-harness",
      productionDeploy: "allow",
      shippingMode: "break-glass",
    });
    writePolicyFile(repositoryPath, repositoryPolicy);
    const commonGitDirectory = resolve(fixture.root, ".git");

    expect(loadPolicy(fixture.root, { commonGitDirectory }).trust).toBe(
      "untrusted"
    );
    writeRepositoryPolicyTrustReceipt(
      fixture.root,
      commonGitDirectory,
      "user",
      "Trust this exact repository policy"
    );
    expect(loadPolicy(fixture.root, { commonGitDirectory })).toMatchObject({
      trust: "trusted",
      value: repositoryPolicy,
    });

    writePolicyFile(repositoryPath, {
      ...repositoryPolicy,
      productionDeploy: "deny",
    });
    expect(loadPolicy(fixture.root, { commonGitDirectory }).trust).toBe(
      "untrusted"
    );
  });

  test("rejects repository policy symlinks", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const outside = resolve(fixture.base, "outside-policy.json");
    writePolicyFile(outside, DEFAULT_POLICY);
    symlinkSync(outside, resolve(fixture.root, ".simple-changes.json"));

    expect(() => loadPolicy(fixture.root)).toThrow("not a regular file");
  });

  test("rejects a symlinked common-Git state directory", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const repositoryPath = resolve(fixture.root, ".simple-changes.json");
    writePolicyFile(
      repositoryPath,
      configuredPolicy({ gitPushAuthorization: "configure-harness" })
    );
    const outside = resolve(fixture.base, "outside-state");
    mkdirSync(outside);
    symlinkSync(outside, resolve(fixture.root, ".git/simple-changes"));
    expect(() =>
      writeRepositoryPolicyTrustReceipt(
        fixture.root,
        resolve(fixture.root, ".git"),
        "user",
        "Trust exact policy"
      )
    ).toThrow("symlink ancestor");
  });

  test("normalizes legacy v1 policies to the safe changelog default", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify(
        {
          concurrentWork: "preserve",
          defaultFinish: "integrate",
          guidance: { version: 1 },
          productionDeploy: "ask",
          questions: "blocking-only",
          review: "repository-policy",
          schemaVersion: 1,
        },
        null,
        2
      )}\n`
    );

    expect(loadPolicy(fixture.root).value.changelogHandling).toBe(
      "preserve-and-report"
    );
    expect(loadPolicy(fixture.root).value.handoffTiming).toBe("confirm-ready");
    expect(loadPolicy(fixture.root).value.uiArtifactVersioning).toBe(
      "repository-convention"
    );
    expect(loadPolicy(fixture.root).value.shippingMode).toBe("standard");
    expect(loadPolicy(fixture.root).value.proposalScheduling).toBe("balanced");
    expect(loadPolicy(fixture.root).value.guidance).toEqual({
      disposition: "accepted",
      version: 1,
    });
  });
});

describe("onboarding conversation", () => {
  test("uses the final permission and scope question copy", () => {
    expect(ONBOARDING_QUESTIONS.permission).toBe(
      "When should I ask for permission or help?"
    );
    expect(ONBOARDING_QUESTIONS.scope).toBe(
      "Where should these preferences live?"
    );
  });

  test("offers existing global personal defaults before the main questions", async () => {
    const existing = configuredPolicy({ defaultFinish: "integrate" });
    const questions: string[] = [];
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {},
      {
        choose: (question: string) => {
          questions.push(question);
          return Promise.resolve("use");
        },
        confirm: () => Promise.resolve(true),
      },
      undefined,
      null,
      false,
      { existingPersonalDefaults: existing, showFirstScreen: true }
    );

    expect(questions).toEqual([ONBOARDING_QUESTIONS.existingPersonalDefaults]);
    expect(selection.policy).toEqual(existing);
    expect(selection.scope).toBe("run");
    expect(selection.summary).toContain(
      "No repository policy or personal preference file will be changed."
    );
  });

  test("warns before overwriting existing global personal defaults", async () => {
    let personalChoice: OnboardingChoice | undefined;
    await collectOnboardingSelection(
      DEFAULT_POLICY,
      {},
      {
        choose: (question: string, choices, defaultValue: string) => {
          if (question === ONBOARDING_QUESTIONS.existingPersonalDefaults) {
            return Promise.resolve("review");
          }
          if (question === ONBOARDING_QUESTIONS.start) {
            return Promise.resolve("customize");
          }
          if (question === ONBOARDING_QUESTIONS.scope) {
            personalChoice = choices.find((choice) => choice.value === "user");
            return Promise.resolve("user");
          }
          return Promise.resolve(defaultValue);
        },
        confirm: () => Promise.resolve(true),
      },
      undefined,
      "/repo",
      false,
      {
        existingPersonalDefaults: configuredPolicy(),
        showFirstScreen: true,
      }
    );

    expect(personalChoice?.label).toBe("Update global personal defaults");
    expect(personalChoice?.description).toContain("Update and overwrite");
  });

  test("starts with explained recommended, customized, and run-only setup", async () => {
    const messages: string[] = [];
    const choicesByQuestion = new Map<string, readonly OnboardingChoice[]>();
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      { defaultFinish: "integrate" },
      {
        choose: (question, choices) => {
          choicesByQuestion.set(question, choices);
          if (question === ONBOARDING_QUESTIONS.start) {
            return Promise.resolve("run");
          }
          return Promise.resolve(choices[0]?.value ?? "");
        },
        confirm: () => Promise.resolve(true),
        present: (message) => messages.push(message),
      },
      undefined,
      "/work/project",
      false,
      { showFirstScreen: true }
    );

    expect(messages.join("\n")).toContain(
      "This is first-use onboarding inside your original Simple Changes task."
    );
    expect(messages.join("\n")).toContain(
      "ready work -> focused change proposal -> checks -> required approval -> merge -> STOP"
    );
    expect(
      choicesByQuestion
        .get(ONBOARDING_QUESTIONS.start)
        ?.map((choice) => choice.label)
    ).toEqual([
      "Use recommended setup",
      "Walk me through it",
      "Customize",
      "Use recommended setup for this run only",
    ]);
    expect(selection).toMatchObject({ scope: "run", setupStyle: "run" });
  });

  test("honors an explicit scheduling input without prompting in non-interactive flows", async () => {
    const questions: string[] = [];
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {
        defaultFinish: "open-change-request",
        gitPushAuthorization: "ask",
        proposalScheduling: "parallel",
        questions: "blocking-only",
        scope: "run",
      },
      {
        choose: (question, _choices, defaultValue) => {
          questions.push(question);
          return Promise.resolve(defaultValue);
        },
        confirm: () => Promise.resolve(true),
      },
      undefined,
      "/work/project",
      false,
      { forgeProvider: "github", showFirstScreen: false }
    );

    expect(questions).not.toContain(
      "When there are multiple independent PRs, what should I optimize for?"
    );
    expect(selection.policy.proposalScheduling).toBe("parallel");
    expect(selection.summary).toContain("Multiple PRs");
  });

  test("uses provider-specific terms and neutral change proposals for scheduling", async () => {
    const run = async (forgeProvider: string | null) => {
      const questions: string[] = [];
      const choiceDescriptions: string[] = [];
      const selection = await collectOnboardingSelection(
        DEFAULT_POLICY,
        {
          defaultFinish: "open-change-request",
          gitPushAuthorization: "ask",
          questions: "blocking-only",
          scope: "run",
        },
        {
          choose: (question, choices, defaultValue) => {
            questions.push(question);
            choiceDescriptions.push(
              ...choices.map((choice) => choice.description)
            );
            return Promise.resolve(
              question === ONBOARDING_QUESTIONS.start
                ? "customize"
                : defaultValue
            );
          },
          confirm: () => Promise.resolve(true),
        },
        undefined,
        "/work/project",
        false,
        { forgeProvider, showFirstScreen: true }
      );
      return { choiceDescriptions, questions, selection };
    };

    const github = await run("github");
    expect(github.questions).toContain(
      "When there are multiple independent PRs, what should I optimize for?"
    );
    expect(github.selection.policy.proposalScheduling).toBe("balanced");
    expect(github.selection.summary).toContain("focused PRs");
    expect(github.selection.summary).toContain("Multiple PRs: Balanced.");
    expect(github.choiceDescriptions.join(" ")).toContain("independent PRs");

    const gitlab = await run("gitlab");
    expect(gitlab.questions).toContain(
      "When there are multiple independent MRs, what should I optimize for?"
    );
    expect(gitlab.selection.summary).toContain("focused MRs");
    expect(gitlab.selection.summary).toContain("Multiple MRs: Balanced.");
    expect(gitlab.choiceDescriptions.join(" ")).toContain("independent MRs");

    const unknown = await run("gitea");
    expect(unknown.questions).toContain(
      "When there are multiple independent change proposals, what should I optimize for?"
    );
    expect(unknown.selection.summary).toContain("focused change proposals");
    expect(unknown.selection.summary).toContain(
      "Multiple change proposals: Balanced."
    );
    expect(unknown.choiceDescriptions.join(" ")).toContain(
      "independent change proposals"
    );
    expect(PROPOSAL_SCHEDULING_CHOICES.map((choice) => choice.value)).toEqual([
      "balanced",
      "consecutive",
      "parallel",
    ]);
  });

  test("asks about push authorization for every finish that pushes", async () => {
    const questions: string[] = [];
    const answers = new Map<string, string>([
      [ONBOARDING_QUESTIONS.finish, "open-change-request"],
      [ONBOARDING_QUESTIONS.gitPushAuthorization, "ask"],
      [ONBOARDING_QUESTIONS.permission, "blocking-only"],
      [ONBOARDING_QUESTIONS.scope, "user"],
    ]);
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {},
      {
        choose: (question: string, _choices: readonly OnboardingChoice[]) => {
          questions.push(question);
          return Promise.resolve(answers.get(question) ?? "");
        },
        confirm: () => Promise.resolve(true),
      }
    );

    expect(questions).toEqual([
      ONBOARDING_QUESTIONS.finish,
      ONBOARDING_QUESTIONS.gitPushAuthorization,
      ONBOARDING_QUESTIONS.permission,
      ONBOARDING_QUESTIONS.scope,
    ]);
    expect(questions).not.toContain(ONBOARDING_QUESTIONS.uiArtifactVersioning);
    expect(selection.policy.productionDeploy).toBe("ask");
    expect(selection.scope).toBe("user");
  });

  test("asks the changelog question only when coordination is relevant", async () => {
    const questions: string[] = [];
    const answers = new Map<string, string>([
      [ONBOARDING_QUESTIONS.finish, "open-change-request"],
      [ONBOARDING_QUESTIONS.gitPushAuthorization, "ask"],
      [ONBOARDING_QUESTIONS.changelog, "delegate-if-available"],
      [ONBOARDING_QUESTIONS.permission, "blocking-only"],
      [ONBOARDING_QUESTIONS.scope, "repository"],
    ]);
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {},
      {
        choose: (question: string) => {
          questions.push(question);
          return Promise.resolve(answers.get(question) ?? "");
        },
        confirm: () => Promise.resolve(true),
      },
      {
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
        providerEvidence: "none",
        providers: [],
        releaseSurfaces: ["CHANGELOG.md"],
        relevant: true,
      }
    );

    expect(questions).toEqual([
      ONBOARDING_QUESTIONS.finish,
      ONBOARDING_QUESTIONS.gitPushAuthorization,
      ONBOARDING_QUESTIONS.changelog,
      ONBOARDING_QUESTIONS.permission,
      ONBOARDING_QUESTIONS.scope,
    ]);
    expect(selection.policy.changelogHandling).toBe("delegate-if-available");
    expect(selection.summary).toContain(
      "otherwise it will be preserved and reported"
    );
  });

  test("defaults to delegation when a compatible changelog skill is installed", async () => {
    let changelogDefault = "";
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {
        defaultFinish: "open-change-request",
        gitPushAuthorization: "ask",
        questions: "blocking-only",
        scope: "run",
      },
      {
        choose: (question: string, _choices, defaultValue: string) => {
          if (question === ONBOARDING_QUESTIONS.changelog) {
            changelogDefault = defaultValue;
          }
          return Promise.resolve(defaultValue);
        },
        confirm: () => Promise.resolve(true),
      },
      {
        capabilityAvailable: true,
        capabilityHelpers: ["/skills/simple-changelogs/scripts/protocol.ts"],
        capabilityStatus: "unverified",
        guidanceUpdate: {
          actions: [],
          detailsPath: null,
          headline: "**Simple Changelogs has recently been updated.**",
          installedVersion: null,
          owner: null,
          policyPath: null,
          provider: "simple-changelogs",
          status: "current",
          storedVersion: null,
          summaryBullets: [],
          walkthroughQuestion:
            "Would you like me to walk you through the recent Simple Changelogs updates before I continue?",
        },
        providerEvidence: "inferred",
        providers: ["/skills/simple-changelogs/SKILL.md"],
        releaseSurfaces: ["CHANGELOG.md"],
        relevant: true,
      }
    );

    expect(changelogDefault).toBe("delegate-if-available");
    expect(selection.policy.changelogHandling).toBe("delegate-if-available");
  });

  test("builds and confirms the full ship workflow", async () => {
    const questions: string[] = [];
    const presented: string[] = [];
    const answers = new Map<string, string>([
      [ONBOARDING_QUESTIONS.finish, "ship"],
      [ONBOARDING_QUESTIONS.production, "allow"],
      [ONBOARDING_QUESTIONS.shippingMode, "expedited"],
      [ONBOARDING_QUESTIONS.gitPushAuthorization, "configure-harness"],
      [ONBOARDING_QUESTIONS.migrationHandling, "ask-after-review"],
      [ONBOARDING_QUESTIONS.permission, "never"],
      [ONBOARDING_QUESTIONS.scope, "repository"],
    ]);
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {},
      {
        choose: (question: string) => {
          questions.push(question);
          return Promise.resolve(answers.get(question) ?? "");
        },
        confirm: (summary: string) =>
          Promise.resolve(
            summary.includes("explicit exact-target authorization")
          ),
        present: (message: string) => presented.push(message),
      }
    );

    expect(questions).toEqual([
      ONBOARDING_QUESTIONS.finish,
      ONBOARDING_QUESTIONS.production,
      ONBOARDING_QUESTIONS.shippingMode,
      ONBOARDING_QUESTIONS.gitPushAuthorization,
      ONBOARDING_QUESTIONS.migrationHandling,
      ONBOARDING_QUESTIONS.permission,
      ONBOARDING_QUESTIONS.scope,
    ]);
    expect(selection).toMatchObject({
      confirmed: true,
      policy: {
        defaultFinish: "ship",
        gitPushAuthorization: "configure-harness",
        migrationHandling: "ask-after-review",
        productionDeploy: "allow",
        questions: "never",
        shippingMode: "expedited",
      },
      scope: "repository",
    });
    expect(selection.summary).toContain(
      "Your workflow is set to Ship when approved."
    );
    expect(selection.summary).toContain(
      "Every migration is reviewed before apply"
    );
    expect(selection.summary).toContain(
      "Expedited shipping keeps review and merge before the first deployment"
    );
    expect(SHIPPING_MODE_CHOICES.map((choice) => choice.value)).toEqual([
      "standard",
      "expedited",
      "break-glass",
    ]);
    expect(
      GIT_PUSH_AUTHORIZATION_CHOICES.map((choice) => choice.value)
    ).toEqual(["configure-harness", "ask", "never"]);
    expect(selection.summary).toContain(
      "grants no credentials, network access, force push, branch-protection bypass"
    );
    expect(presented.join("\n")).toContain(
      "They grant no credentials, network access, force push, branch-protection bypass"
    );
  });

  test("offers target-bound reviewed migration automation tiers", async () => {
    const questions: string[] = [];
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {
        defaultFinish: "ship",
        migrationTargets: [
          {
            environment: "production",
            project: "primary-db",
            provider: "supabase",
          },
        ],
      },
      {
        choose: (question) => {
          questions.push(question);
          if (question === ONBOARDING_QUESTIONS.production) {
            return Promise.resolve("allow");
          }
          if (question === ONBOARDING_QUESTIONS.shippingMode) {
            return Promise.resolve("break-glass");
          }
          if (question === ONBOARDING_QUESTIONS.gitPushAuthorization) {
            return Promise.resolve("configure-harness");
          }
          if (question === ONBOARDING_QUESTIONS.migrationHandling) {
            return Promise.resolve("auto-apply-reviewed-routine");
          }
          if (question === ONBOARDING_QUESTIONS.permission) {
            return Promise.resolve("never");
          }
          if (question === ONBOARDING_QUESTIONS.scope) {
            return Promise.resolve("run");
          }
          return Promise.resolve("");
        },
        confirm: () => Promise.resolve(true),
      }
    );

    expect(questions).toContain(ONBOARDING_QUESTIONS.migrationHandling);
    expect(MIGRATION_HANDLING_CHOICES.map((choice) => choice.value)).toEqual([
      "ask-after-review",
      "auto-apply-reviewed-routine",
      "auto-apply-reviewed",
      "never",
    ]);
    expect(selection.policy).toMatchObject({
      migrationHandling: "auto-apply-reviewed-routine",
      productionDeploy: "allow",
      shippingMode: "break-glass",
    });
    expect(selection.policy.migrationTargets).toEqual([
      {
        environment: "production",
        project: "primary-db",
        provider: "supabase",
      },
    ]);
    expect(selection.summary).toContain(
      "Production deployment is pre-approved"
    );
    expect(selection.summary).toContain(
      "Auto-apply routine after review — Advanced"
    );
  });

  test("explains how to use the skill before asking onboarding questions", async () => {
    const events: string[] = [];
    await collectOnboardingSelection(
      DEFAULT_POLICY,
      { defaultFinish: "integrate" },
      {
        choose: (question, choices) => {
          events.push(`question:${question}`);
          return Promise.resolve(
            question === ONBOARDING_QUESTIONS.start
              ? "run"
              : (choices[0]?.value ?? "")
          );
        },
        confirm: () => Promise.resolve(true),
        present: (message) => events.push(`intro:${message}`),
      },
      undefined,
      "/work/project",
      false,
      { showFirstScreen: true }
    );

    expect(events[0]).toContain("inventory");
    expect(events[0]).toContain("Put this up");
    expect(events[0]).toContain("Ship what’s ready");
    expect(events[0]).toContain("Sync with main");
    expect(events[0]).toContain("Open changes for everything ready");
    expect(events[0]).toContain("Clean up the repo");
    expect(events[0]).toContain("Show me what you would do");
    expect(events[0]).toContain("Leave this work alone");
    expect(events[0]).toContain("Would you like a walkthrough");
    expect(events[0]).toContain("verify the exact delivered revision");
    expect(events[1]).toBe(`question:${ONBOARDING_QUESTIONS.start}`);
  });

  test("renders a review-only summary without production language", () => {
    const summary = renderOnboardingSummary(DEFAULT_POLICY, "run");

    expect(summary).toContain("Your workflow is set to Put it up for review.");
    expect(summary).not.toContain("Production deployment");
    expect(summary).toContain("Preference scope: This run only.");
  });

  test("asks how to name saved UI iterations only when they are relevant", async () => {
    const questions: string[] = [];
    const defaults: string[] = [];
    const answers = new Map<string, string>([
      [ONBOARDING_QUESTIONS.finish, "open-change-request"],
      [ONBOARDING_QUESTIONS.gitPushAuthorization, "ask"],
      [ONBOARDING_QUESTIONS.uiArtifactVersioning, "number-and-date"],
      [ONBOARDING_QUESTIONS.permission, "blocking-only"],
      [ONBOARDING_QUESTIONS.scope, "run"],
    ]);
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {},
      {
        choose: (question, _choices, defaultValue) => {
          questions.push(question);
          defaults.push(defaultValue);
          return Promise.resolve(answers.get(question) ?? "");
        },
        confirm: () => Promise.resolve(true),
      },
      undefined,
      null,
      true
    );

    expect(questions).toEqual([
      ONBOARDING_QUESTIONS.finish,
      ONBOARDING_QUESTIONS.gitPushAuthorization,
      ONBOARDING_QUESTIONS.uiArtifactVersioning,
      ONBOARDING_QUESTIONS.permission,
      ONBOARDING_QUESTIONS.scope,
    ]);
    expect(defaults[2]).toBe("repository-convention");
    expect(
      UI_ARTIFACT_VERSIONING_CHOICES.map((choice) => choice.value)
    ).toEqual([
      "repository-convention",
      "number-and-date",
      "date-only",
      "number-only",
    ]);
    expect(selection.policy.uiArtifactVersioning).toBe("number-and-date");
    expect(selection.summary).toContain(
      "Saved UI iteration naming: Number and date."
    );
    expect(selection.summary).toContain(
      "Repository conventions still take precedence."
    );
  });

  test("offers an existing instruction file and recommends asking if work is ready", async () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    const questions: string[] = [];
    const defaults: string[] = [];
    const pointerQuestion = ONBOARDING_QUESTIONS.instructionPointer(
      resolve(fixture.root, "AGENTS.md")
    );
    const answers = new Map<string, string>([
      [ONBOARDING_QUESTIONS.finish, "open-change-request"],
      [ONBOARDING_QUESTIONS.gitPushAuthorization, "ask"],
      [ONBOARDING_QUESTIONS.permission, "blocking-only"],
      [ONBOARDING_QUESTIONS.scope, "repository"],
      [pointerQuestion, "add"],
      [ONBOARDING_QUESTIONS.handoff, "confirm-ready"],
    ]);
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {},
      {
        choose: (question, _choices, defaultValue) => {
          questions.push(question);
          defaults.push(defaultValue);
          return Promise.resolve(answers.get(question) ?? "");
        },
        confirm: () => Promise.resolve(true),
      },
      undefined,
      fixture.root
    );

    expect(questions).toEqual([
      ONBOARDING_QUESTIONS.finish,
      ONBOARDING_QUESTIONS.gitPushAuthorization,
      ONBOARDING_QUESTIONS.permission,
      ONBOARDING_QUESTIONS.scope,
      pointerQuestion,
      ONBOARDING_QUESTIONS.handoff,
    ]);
    expect(defaults.at(-1)).toBe("confirm-ready");
    expect(HANDOFF_CHOICES.map((choice) => choice.value)).toEqual([
      "confirm-ready",
      "automatic",
      "user-signaled",
    ]);
    expect(selection.policy.handoffTiming).toBe("confirm-ready");
    expect(selection.instructionPointer).toMatchObject({
      action: "add",
      target: {
        path: resolve(fixture.root, "AGENTS.md"),
        scope: "repository",
      },
    });
    expect(selection.summary).toContain(
      "Is this ready for Simple Changes, or do you want more changes first?"
    );
  });

  test("skips handoff timing when instructions remain unchanged", async () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "AGENTS.md", "# Agent guidance\n");
    const questions: string[] = [];
    const pointerQuestion = ONBOARDING_QUESTIONS.instructionPointer(
      resolve(fixture.root, "AGENTS.md")
    );
    const answers = new Map<string, string>([
      [ONBOARDING_QUESTIONS.finish, "open-change-request"],
      [ONBOARDING_QUESTIONS.gitPushAuthorization, "ask"],
      [ONBOARDING_QUESTIONS.permission, "blocking-only"],
      [ONBOARDING_QUESTIONS.scope, "repository"],
      [pointerQuestion, "leave"],
    ]);
    const selection = await collectOnboardingSelection(
      DEFAULT_POLICY,
      {},
      {
        choose: (question) => {
          questions.push(question);
          return Promise.resolve(answers.get(question) ?? "");
        },
        confirm: () => Promise.resolve(true),
      },
      undefined,
      fixture.root
    );

    expect(questions).not.toContain(ONBOARDING_QUESTIONS.handoff);
    expect(selection.policy.handoffTiming).toBe("confirm-ready");
    expect(selection.instructionPointer.action).toBe("leave");
  });
});
