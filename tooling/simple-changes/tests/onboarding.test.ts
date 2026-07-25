import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectOnboardingSelection,
  ONBOARDING_QUESTIONS,
  type OnboardingChoice,
  renderOnboardingSummary,
} from "../../../skills/simple-changes/scripts/lib/onboarding.ts";
import {
  DEFAULT_POLICY,
  loadPersonalPolicy,
  loadPolicy,
  resolvePersonalPolicyPath,
  writePolicyFile,
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
      value: personalPolicy,
    });
    expect(
      loadPolicy(fixture.root, { personalPolicyPath: personalPath })
    ).toEqual({
      path: personalPath,
      source: "user",
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
      value: repositoryPolicy,
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
      value: DEFAULT_POLICY,
    });
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
  });
});

describe("onboarding conversation", () => {
  test("uses the final permission and scope question copy", () => {
    expect(ONBOARDING_QUESTIONS.permission).toBe(
      "When should I ask for permission or help?"
    );
    expect(ONBOARDING_QUESTIONS.scope).toBe(
      "For what scope should I save these preferences?"
    );
  });

  test("asks about production only when shipping is selected", async () => {
    const questions: string[] = [];
    const answers = new Map<string, string>([
      [ONBOARDING_QUESTIONS.finish, "open-change-request"],
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
      ONBOARDING_QUESTIONS.permission,
      ONBOARDING_QUESTIONS.scope,
    ]);
    expect(selection.policy.productionDeploy).toBe("ask");
    expect(selection.scope).toBe("user");
  });

  test("asks the changelog question only when coordination is relevant", async () => {
    const questions: string[] = [];
    const answers = new Map<string, string>([
      [ONBOARDING_QUESTIONS.finish, "open-change-request"],
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
        providers: [],
        releaseSurfaces: ["CHANGELOG.md"],
        relevant: true,
      }
    );

    expect(questions).toEqual([
      ONBOARDING_QUESTIONS.finish,
      ONBOARDING_QUESTIONS.changelog,
      ONBOARDING_QUESTIONS.permission,
      ONBOARDING_QUESTIONS.scope,
    ]);
    expect(selection.policy.changelogHandling).toBe("delegate-if-available");
    expect(selection.summary).toContain(
      "otherwise it will be preserved and reported"
    );
  });

  test("builds and confirms the full ship workflow", async () => {
    const questions: string[] = [];
    const answers = new Map<string, string>([
      [ONBOARDING_QUESTIONS.finish, "ship"],
      [ONBOARDING_QUESTIONS.production, "allow"],
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
            summary.includes("explicit, exact-target authorization")
          ),
      }
    );

    expect(questions).toEqual([
      ONBOARDING_QUESTIONS.finish,
      ONBOARDING_QUESTIONS.production,
      ONBOARDING_QUESTIONS.permission,
      ONBOARDING_QUESTIONS.scope,
    ]);
    expect(selection).toMatchObject({
      confirmed: true,
      policy: {
        defaultFinish: "ship",
        productionDeploy: "allow",
        questions: "never",
      },
      scope: "repository",
    });
    expect(selection.summary).toContain(
      "Your workflow is set to Ship when approved."
    );
    expect(selection.summary).toContain(
      "Remote migrations, backfills, secrets, DNS changes"
    );
  });

  test("renders a review-only summary without production language", () => {
    const summary = renderOnboardingSummary(DEFAULT_POLICY, "run");

    expect(summary).toContain("Your workflow is set to Put it up for review.");
    expect(summary).not.toContain("Production deployment");
    expect(summary).toContain("Preference scope: This run only.");
  });
});
