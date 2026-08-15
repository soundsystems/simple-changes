import { describe, expect, test } from "bun:test";
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
          "defer",
          "review-with-simple-changelogs",
          "view-release-notes",
        ],
        changelogHandoff: {
          available: true,
          owner: "simple-changelogs",
        },
        currentVersion: 10,
        headline: "**Simple Changes has recently been updated.**",
        recommendedAction: "review-settings",
        status: "update-available",
        storedVersion: 1,
        walkthroughQuestion:
          "Would you like me to walk you through all recent updates to the skill?",
      },
      mutationAllowed: false,
      onboardingRequired: false,
      preLoopActionRequired: true,
    });
    expect(status.guidanceUpdate.summaryBullets.join(" ")).toContain(
      "automatically remove unchanged clean target-contained worktrees"
    );
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
