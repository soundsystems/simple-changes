import { describe, expect, test } from "bun:test";
import { inspectInitialization } from "../../../skills/simple-changes/scripts/lib/initialization.ts";

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
});
