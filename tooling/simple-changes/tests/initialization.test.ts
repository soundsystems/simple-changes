import { describe, expect, test } from "bun:test";
import { inspectGuidanceUpdate } from "../../../skills/simple-changes/scripts/lib/guidance-updates.ts";
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
      20, 20, 21, 21, 21, 22, 22, 22, 22, 23, 23, 24, 24, 24,
    ]);
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
        currentVersion: 24,
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
      "`loop finalize --awaiting-user`"
    );
    expect(status.guidanceUpdate.summaryBullets.join(" ")).toContain(
      "hand off ready work and hold a shipment"
    );
    expect(status.guidanceUpdate.summaryBullets.join(" ")).toContain(
      "`proposalSignatures` setting"
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
