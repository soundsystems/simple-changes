import { describe, expect, test } from "bun:test";
import {
  classifyRequestMode,
  shouldTrigger,
} from "../../../skills/simple-changes/scripts/lib/triggers.ts";

describe("trigger classification", () => {
  test("recognizes integration requests", () => {
    expect(shouldTrigger("Put this up as a focused change.")).toBe(true);
    expect(shouldTrigger("Ship everything ready.")).toBe(true);
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
  });

  test("uses established context for resume", () => {
    expect(shouldTrigger("again", false)).toBe(false);
    expect(shouldTrigger("again", true)).toBe(true);
    expect(classifyRequestMode("again", true)).toBe("resume");
  });
});
