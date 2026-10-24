import { describe, expect, test } from "bun:test";
import {
  guidanceNotice,
  inspectGuidanceUpdate,
} from "../../../skills/simple-changes/scripts/lib/guidance-updates.ts";
import { inspectInitialization } from "../../../skills/simple-changes/scripts/lib/initialization.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import { classifyEmergencyShipping } from "../../../skills/simple-changes/scripts/lib/triggers.ts";
import type { ChangelogCoordination } from "../../../skills/simple-changes/scripts/lib/types.ts";

const absentChangelogUpdate: ChangelogCoordination["guidanceUpdate"] = {
  actions: [],
  detailsPath: null,
  headline: "**Simple Changelogs has recently been updated.**" as const,
  installedVersion: null,
  owner: null,
  policyPath: null,
  provider: null,
  status: "absent" as const,
  storedVersion: null,
  summaryBullets: [],
  walkthroughQuestion:
    "Would you like me to walk you through the recent Simple Changelogs updates before I continue?" as const,
};

const availableChangelogUpdate: ChangelogCoordination["guidanceUpdate"] = {
  actions: ["walkthrough", "continue", "view-release-notes"],
  detailsPath: "/skills/simple-changelogs/references/guidance-updates.md",
  headline: "**Simple Changelogs has recently been updated.**" as const,
  installedVersion: 9,
  owner: "simple-changelogs" as const,
  policyPath: "/repo/.simple-changelogs.json",
  provider: "/skills/simple-changelogs/SKILL.md",
  status: "update-available" as const,
  storedVersion: 8,
  summaryBullets: ["Production Web deployment is now a release boundary."],
  walkthroughQuestion:
    "Would you like me to walk you through the recent Simple Changelogs updates before I continue?" as const,
};

describe("first-run initialization", () => {
  test("explains proposalScheduling to version 18 and 19 upgrades", () => {
    const changelogCoordination: ChangelogCoordination = {
      capabilityAvailable: false,
      capabilityHelpers: [],
      capabilityStatus: "absent",
      guidanceUpdate: absentChangelogUpdate,
      providerDistribution: null,
      providerEvidence: "none",
      providers: [],
      releaseSurfaces: [],
      relevant: false,
    };
    const from18 = inspectGuidanceUpdate(
      {
        ...DEFAULT_POLICY,
        guidance: { disposition: "accepted", version: 18 },
      },
      changelogCoordination
    );
    expect(from18.changes.map((item) => item.version)).toContain(19);
    expect(from18.changes.map((item) => item.version)).toContain(20);
    expect(from18.changes.map((item) => item.summary).join(" ")).toContain(
      "`proposalScheduling`"
    );
    expect(from18.changes.map((item) => item.summary).join(" ")).toContain(
      "balanced default"
    );

    const from19 = inspectGuidanceUpdate(
      {
        ...DEFAULT_POLICY,
        guidance: { disposition: "accepted", version: 19 },
      },
      changelogCoordination
    );
    expect(from19.changes.map((item) => item.version)).toEqual([
      20, 20, 21, 21, 21, 22, 22, 22, 22, 23, 23, 24, 24, 24, 25, 25, 25, 26,
      26, 26, 27, 27, 27, 28, 28, 28, 28, 28, 28, 28, 29, 29, 29, 29, 30, 30,
      31, 31, 31, 31, 31, 31, 31, 31, 31, 32, 32, 32, 32, 32, 32, 32, 32, 33,
      33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33,
    ]);
    expect(
      from19.changes.filter((item) => item.version === 27).at(-1)?.summary
    ).toContain("`update-local-forks` tries the `v<version>` tag first");
    expect(
      from19.changes.filter((item) => item.version === 28).at(-1)?.summary
    ).toContain(
      "`release-notes --version` for an older release prints its link"
    );
    expect(
      from19.changes.filter((item) => item.version === 29).at(-1)?.summary
    ).toContain(
      "`scripts/lib/loop-lease.ts` is split into ten command-group modules"
    );
    expect(
      from19.changes.find((item) => item.version === 30)?.summary
    ).toContain("`author attest --complete-identity`");
    expect(
      from19.changes.filter((item) => item.version === 30).at(-1)?.summary
    ).toContain(
      "`SKILL.md` puts `## Core workflow` directly after the mode table"
    );
    expect(
      from19.changes.find((item) => item.version === 31)?.summary
    ).toContain("Adversarial review compares canonical model IDs");
    expect(
      from19.changes.filter((item) => item.version === 31).at(-1)?.summary
    ).toContain(
      "Every path built from a run ID requires the `run-[a-z0-9-]+` form"
    );
    expect(
      from19.changes.filter((item) => item.version === 32).at(-1)?.summary
    ).toContain(
      "The GitLab provider reference documents recovery of a passed hosted CI run"
    );
    expect(
      from19.changes.find((item) => item.version === 33)?.summary
    ).toContain(
      "checks Git's answer for the repository's common Git directory"
    );
    expect(from19.changes.at(-1)?.summary).toContain(
      "discovers a repository's own changelog provider under any folder name"
    );
    const from29 = inspectGuidanceUpdate(
      {
        ...DEFAULT_POLICY,
        guidance: { disposition: "accepted", version: 29 },
      },
      changelogCoordination
    );
    expect(from29.changes.map((item) => item.version)).toEqual([
      30, 30, 31, 31, 31, 31, 31, 31, 31, 31, 31, 32, 32, 32, 32, 32, 32, 32,
      32, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33,
    ]);
    expect(from29.summaryBullets.join(" ")).toContain(
      "`author attest --complete-identity`"
    );
    const from30 = inspectGuidanceUpdate(
      {
        ...DEFAULT_POLICY,
        guidance: { disposition: "accepted", version: 30 },
      },
      changelogCoordination
    );
    expect(from30.changes.map((item) => item.version)).toEqual([
      31, 31, 31, 31, 31, 31, 31, 31, 31, 32, 32, 32, 32, 32, 32, 32, 32, 33,
      33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33,
    ]);
    expect(from30.requiredAnswers).toEqual([]);
    const from31 = inspectGuidanceUpdate(
      {
        ...DEFAULT_POLICY,
        guidance: { disposition: "accepted", version: 31 },
      },
      changelogCoordination
    );
    expect(from31.changes.map((item) => item.version)).toEqual([
      32, 32, 32, 32, 32, 32, 32, 32, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33,
      33, 33, 33,
    ]);
    expect(from31.requiredAnswers).toEqual([]);
    expect(from31.summaryBullets.join(" ")).toContain(
      "`scratch-file-rule refresh`"
    );
    const from32 = inspectGuidanceUpdate(
      {
        ...DEFAULT_POLICY,
        guidance: { disposition: "accepted", version: 32 },
      },
      changelogCoordination
    );
    expect(from32.changes.map((item) => item.version)).toEqual([
      33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33,
    ]);
    expect(from32.requiredAnswers).toEqual([]);
    expect(from32.summaryBullets).toHaveLength(3);
    expect(from32.summaryBullets[0]).toContain("`--harness <id>`");
    expect(from32.summaryBullets.join(" ")).toContain("`loop hold-unit`");
    expect(from32.summaryBullets.join(" ")).toContain(
      "reports cleanup as pending"
    );
    expect(from32.summaryBullets.join(" ")).not.toContain("`reviewer room`");
    expect(guidanceNotice(33)).toHaveLength(5);
    expect(guidanceNotice(33).join(" ")).toContain("`reviewer room`");
    expect(guidanceNotice(33).join(" ")).toContain(
      "`worktree restore-archive`"
    );
    expect(from30.summaryBullets.join(" ")).toContain(
      "compares the model IDs your coding agents report"
    );
  });
  test("propagates the saved shipping preference into emergency classification", () => {
    for (const shippingMode of ["expedited", "break-glass"] as const) {
      const status = inspectInitialization("ship", {
        path: "/repo/.simple-changes.json",
        source: "repository",
        value: { ...DEFAULT_POLICY, shippingMode },
      });

      expect(status.shippingMode).toBe(shippingMode);
      expect(
        classifyEmergencyShipping("Ship it.", false, status.shippingMode)
      ).toMatchObject({
        breakGlassAuthorized: shippingMode === "break-glass",
        mode: shippingMode,
      });
    }
  });

  test("propagates harness-aware Git push authorization intent", () => {
    const status = inspectInitialization("ship", {
      path: "/repo/.simple-changes.json",
      source: "repository",
      value: {
        ...DEFAULT_POLICY,
        gitPushAuthorization: "configure-harness",
      },
    });

    expect(status.gitPushAuthorization).toBe("configure-harness");
  });

  test("requires onboarding for write-capable modes without saved policy", () => {
    expect(
      inspectInitialization("queue", {
        path: null,
        source: "default",
      })
    ).toMatchObject({
      firstUseWalkthroughAvailable: true,
      inferredDefaultFinish: "open-change-request",
      onboardingRequired: true,
      writeCapable: true,
    });
    expect(
      inspectInitialization("ship", {
        path: null,
        source: "default",
      })
    ).toMatchObject({
      inferredDefaultFinish: "ship",
      onboardingRequired: true,
      writeCapable: true,
    });
  });

  test("reports conditional changelog coordination evidence", () => {
    expect(
      inspectInitialization(
        "integrate",
        {
          path: null,
          source: "default",
        },
        {
          capabilityAvailable: false,
          capabilityHelpers: [],
          capabilityStatus: "absent",
          guidanceUpdate: absentChangelogUpdate,
          providerDistribution: null,
          providerEvidence: "none",
          providers: [],
          releaseSurfaces: ["CHANGELOG.md"],
          relevant: true,
        }
      )
    ).toMatchObject({
      changelogCoordination: {
        capabilityAvailable: false,
        capabilityHelpers: [],
        capabilityStatus: "absent",
        releaseSurfaces: ["CHANGELOG.md"],
        relevant: true,
      },
      onboardingRequired: true,
    });
  });

  test("does not onboard read-only or preservation-only modes", () => {
    for (const mode of ["preview", "pause"] as const) {
      expect(
        inspectInitialization(mode, {
          path: null,
          source: "default",
        })
      ).toMatchObject({
        firstUseWalkthroughAvailable: true,
        onboardingRequired: false,
        writeCapable: false,
      });
    }
  });

  test("uses fixed local-only guardrails for a first Sync run", () => {
    expect(
      inspectInitialization("sync", {
        path: null,
        source: "default",
      })
    ).toMatchObject({
      inferredDefaultFinish: null,
      mutationAllowed: true,
      onboardingRequired: false,
      reason:
        "Sync uses fixed local-only preservation guardrails and does not require workflow preference onboarding.",
      writeCapable: true,
    });
  });

  test("reports the repository policy trust state", () => {
    expect(
      inspectInitialization("ship", {
        path: "/repo/.simple-changes.json",
        source: "repository",
        trust: "untrusted",
        value: DEFAULT_POLICY,
      })
    ).toMatchObject({ policyTrust: "untrusted" });
    expect(
      inspectInitialization("ship", {
        path: "/repo/.simple-changes.json",
        source: "repository",
        trust: "trusted",
        value: { ...DEFAULT_POLICY, shippingMode: "expedited" },
      })
    ).toMatchObject({ policyTrust: "trusted" });
    expect(
      inspectInitialization("ship", {
        path: null,
        source: "default",
      })
    ).toMatchObject({ policyTrust: "not-required" });
  });

  test("reports the effective production deploy policy", () => {
    expect(
      inspectInitialization("ship", { path: null, source: "default" })
    ).toMatchObject({ productionDeploy: "ask" });
    for (const productionDeploy of ["allow", "deny"] as const) {
      expect(
        inspectInitialization("ship", {
          path: "/repo/.simple-changes.json",
          source: "repository",
          trust: productionDeploy === "allow" ? "trusted" : "not-required",
          value: { ...DEFAULT_POLICY, productionDeploy },
        })
      ).toMatchObject({ productionDeploy });
    }
  });

  test("does not repeat onboarding when personal or repository policy exists", () => {
    expect(
      inspectInitialization("integrate", {
        path: "/configuration/simple-changes/preferences.json",
        source: "user",
      })
    ).toMatchObject({
      onboardingRequired: false,
      policySource: "user",
    });
    expect(
      inspectInitialization("ship", {
        path: "/repo/.simple-changes.json",
        source: "repository",
      })
    ).toMatchObject({
      onboardingRequired: false,
      policySource: "repository",
    });
  });

  test("treats a run-only policy request as finished onboarding for the run", () => {
    const request = {
      path: null,
      source: "request" as const,
      value: DEFAULT_POLICY,
    };
    const status = inspectInitialization("queue", request);
    expect(status).toMatchObject({
      firstUseWalkthroughAvailable: false,
      guidanceUpdate: { status: "current" },
      mutationAllowed: true,
      onboardingRequired: false,
      policyPath: null,
      policySource: "request",
      preLoopActionRequired: false,
    });
    expect(status.reason).toContain("onboarding returns on the next run");
    // Readiness still gates a handoff, and an older guidance version in the
    // layer still pauses, exactly as for a saved policy.
    expect(inspectInitialization("handoff", request)).toMatchObject({
      handoffAction: "confirm-readiness",
      mutationAllowed: false,
    });
    expect(
      inspectInitialization("queue", {
        ...request,
        value: {
          ...DEFAULT_POLICY,
          guidance: { disposition: "accepted", version: 32 },
        },
      })
    ).toMatchObject({ mutationAllowed: false, preLoopActionRequired: true });
    // Negative control: the same value as the default layer still onboards.
    expect(
      inspectInitialization("queue", { ...request, source: "default" })
    ).toMatchObject({ mutationAllowed: false, onboardingRequired: true });
  });

  test("pauses once for a meaningful installed guidance update", () => {
    const status = inspectInitialization(
      "queue",
      {
        path: "/repo/.simple-changes.json",
        source: "repository",
        value: {
          ...DEFAULT_POLICY,
          guidance: { disposition: "accepted", version: 1 },
        },
      },
      {
        capabilityAvailable: true,
        capabilityHelpers: ["/skills/simple-changelogs/scripts/setup.ts"],
        capabilityStatus: "unverified",
        guidanceUpdate: availableChangelogUpdate,
        providerDistribution: "full",
        providerEvidence: "inferred",
        providers: ["/skills/simple-changelogs/SKILL.md"],
        releaseSurfaces: ["CHANGELOG.md"],
        relevant: true,
      }
    );

    expect(status).toMatchObject({
      guidanceUpdate: {
        actions: [
          "review-settings",
          "keep-current-settings",
          "expanded-walkthrough",
          "view-release-notes",
          "review-with-simple-changelogs",
          "defer",
        ],
        changelogHandoff: {
          available: true,
          owner: "simple-changelogs",
        },
        currentVersion: 33,
        headline: "**Simple Changes has recently been updated.**",
        presentationOrder: [
          "required-answers",
          "recommended-changes",
          "summary",
          "actions",
        ],
        recommendedAction: "review-settings",
        requiredAnswers: [],
        status: "update-available",
        storedVersion: 1,
        walkthroughQuestion: "How would you like to continue?",
      },
      mutationAllowed: false,
      onboardingRequired: false,
      preLoopActionRequired: true,
    });
    expect(status.guidanceUpdate.summaryBullets).toHaveLength(3);
    expect(status.guidanceUpdate.summaryBullets.join(" ")).toContain(
      "compares the model IDs your coding agents report"
    );
    expect(status.guidanceUpdate.summaryBullets.join(" ")).toContain(
      "Reviews can now grade findings as blocking, should-fix, or nit"
    );
    expect(status.guidanceUpdate.summaryBullets.join(" ")).toContain(
      "A worktree claim now belongs to the session that made it"
    );
    expect(status.guidanceUpdate.recommendedChanges[0]).toMatchObject({
      question: "How should changelog work be handled?",
      setting: "changelogHandling",
    });
  });

  test("puts a new recommendation before the optional walkthrough", () => {
    const status = inspectInitialization(
      "queue",
      {
        path: "/repo/.simple-changes.json",
        source: "repository",
        value: {
          ...DEFAULT_POLICY,
          changelogHandling: "preserve-and-report",
          guidance: { disposition: "accepted", version: 10 },
        },
      },
      {
        capabilityAvailable: true,
        capabilityHelpers: ["/skills/simple-changelogs/scripts/setup.ts"],
        capabilityStatus: "unverified",
        guidanceUpdate: {
          ...availableChangelogUpdate,
          status: "current",
        },
        providerDistribution: "full",
        providerEvidence: "inferred",
        providers: ["/skills/simple-changelogs/SKILL.md"],
        releaseSurfaces: ["CHANGELOG.md"],
        relevant: true,
      }
    );

    expect(status.guidanceUpdate.recommendedAction).toBe("review-settings");
    expect(status.guidanceUpdate.requiredAnswers).toEqual([]);
    expect(status.guidanceUpdate.recommendedChanges).toHaveLength(1);
    expect(status.guidanceUpdate.recommendedChanges[0]).toMatchObject({
      question: "How should changelog work be handled?",
      setting: "changelogHandling",
    });
    expect(
      status.guidanceUpdate.recommendedChanges[0]?.choices[0]
    ).toMatchObject({
      label: "Delegate when available (Recommended)",
      recommended: true,
      value: "delegate-if-available",
    });
  });

  test("resolves a required Simple Changelogs update before shipment loop creation", () => {
    const status = inspectInitialization(
      "ship",
      {
        path: "/repo/.simple-changes.json",
        source: "repository",
        value: DEFAULT_POLICY,
      },
      {
        capabilityAvailable: true,
        capabilityHelpers: ["/skills/simple-changelogs/scripts/setup.ts"],
        capabilityStatus: "unverified",
        guidanceUpdate: availableChangelogUpdate,
        providerDistribution: "full",
        providerEvidence: "inferred",
        providers: ["/skills/simple-changelogs/SKILL.md"],
        releaseSurfaces: ["CHANGELOG.md"],
        relevant: true,
      },
      { changelogRequired: true }
    );

    expect(status).toMatchObject({
      changelogRequired: true,
      guidanceUpdate: { status: "current" },
      mutationAllowed: false,
      preLoopActionRequired: true,
      reason:
        "This request requires changelog work and Simple Changelogs has a recent update; resolve its owner-controlled notice before any shipment loop begins.",
    });
  });

  test("keeps changelog review out of the update when its owner is absent", () => {
    const status = inspectInitialization("queue", {
      path: "/repo/.simple-changes.json",
      source: "repository",
      value: {
        ...DEFAULT_POLICY,
        guidance: { disposition: "deferred", version: 1 },
      },
    });

    expect(status.guidanceUpdate.actions).not.toContain(
      "review-with-simple-changelogs"
    );
    expect(status.guidanceUpdate.changelogHandoff).toMatchObject({
      available: false,
      owner: null,
    });
  });

  test("leaves resume finish unresolved for fresh conversational context", () => {
    expect(
      inspectInitialization("resume", {
        path: null,
        source: "default",
      })
    ).toMatchObject({
      inferredDefaultFinish: null,
      onboardingRequired: true,
    });
  });

  test("gates the recommended handoff until readiness is confirmed", () => {
    const policy = {
      path: "/repo/.simple-changes.json",
      source: "repository" as const,
      value: DEFAULT_POLICY,
    };
    expect(inspectInitialization("handoff", policy)).toMatchObject({
      handoffAction: "confirm-readiness",
      handoffTiming: "confirm-ready",
      mutationAllowed: false,
      resolvedMode: null,
    });
    expect(
      inspectInitialization("handoff", policy, undefined, {
        readinessConfirmed: true,
      })
    ).toMatchObject({
      handoffAction: "proceed",
      mutationAllowed: true,
      resolvedMode: "queue",
    });
  });

  test("supports automatic and user-signaled handoff timing", () => {
    expect(
      inspectInitialization("handoff", {
        path: "/repo/.simple-changes.json",
        source: "repository",
        value: { ...DEFAULT_POLICY, handoffTiming: "automatic" },
      })
    ).toMatchObject({
      handoffAction: "proceed",
      mutationAllowed: true,
      resolvedMode: "queue",
    });
    expect(
      inspectInitialization("handoff", {
        path: "/repo/.simple-changes.json",
        source: "repository",
        value: { ...DEFAULT_POLICY, handoffTiming: "user-signaled" },
      })
    ).toMatchObject({
      handoffAction: "wait-for-user",
      mutationAllowed: false,
      resolvedMode: null,
    });
  });

  test("keeps preview-only handoff read-only", () => {
    expect(
      inspectInitialization("handoff", {
        path: "/repo/.simple-changes.json",
        source: "repository",
        value: {
          ...DEFAULT_POLICY,
          defaultFinish: "preview",
          handoffTiming: "automatic",
        },
      })
    ).toMatchObject({
      handoffAction: "proceed",
      mutationAllowed: false,
      resolvedMode: "preview",
    });
  });
});
