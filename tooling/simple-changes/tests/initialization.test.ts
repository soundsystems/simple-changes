import { describe, expect, test } from "bun:test";
import { inspectInitialization } from "../../../skills/simple-changes/scripts/lib/initialization.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";

describe("first-run initialization", () => {
  test("requires onboarding for write-capable modes without saved policy", () => {
    expect(
      inspectInitialization("queue", {
        path: null,
        source: "default",
      })
    ).toMatchObject({
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
        currentVersion: 3,
        status: "update-available",
        storedVersion: 1,
      },
      mutationAllowed: false,
      onboardingRequired: false,
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
