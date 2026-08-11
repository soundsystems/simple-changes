import { describe, expect, test } from "bun:test";
import {
  classifyEmergencyShipping,
  classifyRequestMode,
  shouldTrigger,
} from "../../../skills/simple-changes/scripts/lib/triggers.ts";

describe("trigger classification", () => {
  test("recognizes integration requests", () => {
    expect(shouldTrigger("Put this up as a focused change.")).toBe(true);
    expect(shouldTrigger("Put these generated UI surface iterations up.")).toBe(
      true
    );
    expect(shouldTrigger("Ship everything ready.")).toBe(true);
    expect(shouldTrigger("sync")).toBe(true);
    expect(shouldTrigger("Sync with remote main.")).toBe(true);
    expect(shouldTrigger("Get us inline with main.")).toBe(true);
    expect(shouldTrigger("Pull the latest changes from origin.")).toBe(true);
    expect(classifyRequestMode("sync")).toBe("sync");
    expect(classifyRequestMode("Sync with remote main.")).toBe("sync");
    expect(classifyRequestMode("Get us in line with main.")).toBe("sync");
    expect(classifyRequestMode("Sync with main, then ship it.")).toBe("ship");
    expect(
      shouldTrigger(
        "Audit every change proposal in every state for malformed newlines."
      )
    ).toBe(true);
    expect(
      classifyRequestMode(
        "Audit every change proposal in every state for malformed newlines."
      )
    ).toBe("preview");
    expect(
      classifyRequestMode("Fix all merge requests with malformed summaries.")
    ).toBe("sweep");
  });

  test("does not activate on near misses", () => {
    expect(shouldTrigger("Review this PR and give feedback.")).toBe(false);
    expect(shouldTrigger("Write a commit message.")).toBe(false);
    expect(shouldTrigger("Deploy production.")).toBe(false);
    expect(shouldTrigger("Curate the public CLI release notes.")).toBe(false);
    expect(
      shouldTrigger("Generate three UI surface iterations for comparison.")
    ).toBe(false);
    expect(shouldTrigger("Sync the customer records to the CRM.")).toBe(false);
    expect(shouldTrigger("Sync the database schema.")).toBe(false);
  });

  test("uses established context for resume", () => {
    expect(shouldTrigger("again", false)).toBe(false);
    expect(shouldTrigger("again", true)).toBe(true);
    expect(classifyRequestMode("again", true)).toBe("resume");
  });

  test("infers expedited shipping from urgency without waiving review", () => {
    expect(classifyEmergencyShipping("Ship this fast.")).toEqual({
      breakGlassAuthorized: false,
      evidence: ["urgency-language"],
      mode: "expedited",
      recommendedMode: "expedited",
      requiresBreakGlassConfirmation: false,
    });
    expect(classifyRequestMode("Make this quick.", true)).toBe("ship");
    expect(shouldTrigger("Make this quick.", false)).toBe(false);
  });

  test("recommends break-glass for active impact or tested live work", () => {
    expect(
      classifyEmergencyShipping(
        "Users cannot log in and this needs to ship ASAP."
      )
    ).toMatchObject({
      breakGlassAuthorized: false,
      evidence: ["urgency-language", "active-user-impact"],
      mode: "expedited",
      recommendedMode: "break-glass",
      requiresBreakGlassConfirmation: true,
    });
    expect(
      classifyEmergencyShipping("This has been tested and needs to go live.")
    ).toMatchObject({
      breakGlassAuthorized: false,
      mode: "expedited",
      recommendedMode: "break-glass",
      requiresBreakGlassConfirmation: true,
    });
  });

  test("treats deploy-before-review wording as explicit break-glass", () => {
    expect(
      classifyEmergencyShipping("Deploy first and review afterward.")
    ).toEqual({
      breakGlassAuthorized: true,
      evidence: ["deploy-before-review"],
      mode: "break-glass",
      recommendedMode: "break-glass",
      requiresBreakGlassConfirmation: false,
    });
    expect(shouldTrigger("Deploy first and review afterward.")).toBe(true);
    expect(classifyRequestMode("Deploy first and review afterward.")).toBe(
      "ship"
    );
  });
});
