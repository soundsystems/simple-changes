import { describe, expect, test } from "bun:test";
import {
  coordinateOnboarding,
  pendingOnboardingOwners,
  recordOnboardingOwnerFailure,
  recordOnboardingOwnerWrite,
} from "../../../skills/simple-changes/scripts/lib/coordinated-onboarding.ts";

const contributions = [
  {
    destination: "/repo/.simple-changes.json",
    owner: "simple-changes" as const,
    policyDigest: "a".repeat(64),
    questions: [{ id: "production", prompt: "Production behavior?" }],
    summary: "Ask before production.",
  },
  {
    destination: "/repo/.simple-changelogs.json",
    owner: "simple-changelogs" as const,
    policyDigest: "b".repeat(64),
    questions: [{ id: "minor", prompt: "Minor version behavior?" }],
    summary: "Ask before public versions.",
  },
];

describe("coordinated onboarding", () => {
  test("presents one confirmation while retaining separate owners", () => {
    const plan = coordinateOnboarding("setup-01", contributions);
    expect(plan.questions).toHaveLength(2);
    expect(plan.confirmation).toContain(".simple-changes.json");
    expect(plan.confirmation).toContain(".simple-changelogs.json");
    expect(plan.transaction.status).toBe("pending");
  });

  test("resumes only an incomplete owner after a partial write", () => {
    const initial = coordinateOnboarding("setup-01", contributions).transaction;
    const changesWritten = recordOnboardingOwnerWrite(
      initial,
      "simple-changes",
      { written: true }
    );
    const partial = recordOnboardingOwnerFailure(
      changesWritten,
      "simple-changelogs"
    );
    expect(partial.status).toBe("partial");
    expect(pendingOnboardingOwners(partial)).toEqual(["simple-changelogs"]);

    const completed = recordOnboardingOwnerWrite(partial, "simple-changelogs", {
      written: true,
    });
    expect(completed.status).toBe("completed");
    expect(pendingOnboardingOwners(completed)).toEqual([]);
  });
});
