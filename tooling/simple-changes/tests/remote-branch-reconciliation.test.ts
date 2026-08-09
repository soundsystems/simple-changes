import { describe, expect, test } from "bun:test";
import { validateRemoteBranchReconciliation } from "../../../skills/simple-changes/scripts/lib/remote-branch-reconciliation.ts";
import type { RemoteBranchReconciliationReceipt } from "../../../skills/simple-changes/scripts/lib/types.ts";

const SHA = {
  feature: "b".repeat(40),
  target: "a".repeat(40),
};

const receipt = (): RemoteBranchReconciliationReceipt => ({
  branches: [
    {
      classification: "canonical-target",
      disposition: "preserved-target",
      evidence: [
        "Final GitLab branch inventory returned main at the target SHA.",
      ],
      finalHeadRevision: SHA.target,
      initialHeadRevision: SHA.target,
      name: "main",
      obsoleteProof: null,
      proposals: [],
      protected: true,
    },
    {
      classification: "merged-obsolete",
      disposition: "deleted-merged",
      evidence: [
        "MR !12 is merged and its exact source head has no later commits.",
      ],
      finalHeadRevision: null,
      initialHeadRevision: SHA.feature,
      name: "feature/merged",
      obsoleteProof: "merged-proposal-head",
      proposals: [
        {
          headRevision: SHA.feature,
          objectId: "12",
          state: "merged",
        },
      ],
      protected: false,
    },
    {
      classification: "no-proposal",
      disposition: "preserved-audited",
      evidence: ["No MR exists and target equivalence is not proven."],
      finalHeadRevision: "c".repeat(40),
      initialHeadRevision: "c".repeat(40),
      name: "build/manual",
      obsoleteProof: null,
      proposals: [],
      protected: false,
    },
  ],
  finalBranchCount: 2,
  finalInventoryComplete: true,
  initialBranchCount: 3,
  initialInventoryComplete: true,
  observedAt: new Date().toISOString(),
  project: "group/project",
  provider: "gitlab",
  schemaVersion: 1,
  targetBranch: "main",
  targetRevision: SHA.target,
});

describe("remote branch reconciliation", () => {
  test("accepts a complete conservative branch ledger", () => {
    const value = receipt();
    expect(validateRemoteBranchReconciliation(value)).toEqual(value);
  });

  test("rejects deletion of an open proposal branch", () => {
    const value = receipt();
    const [, branch] = value.branches;
    if (!branch) {
      throw new Error("missing fixture branch");
    }
    branch.proposals.push({
      headRevision: branch.initialHeadRevision,
      objectId: "13",
      state: "open",
    });
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "open proposal branch must be classified as open"
    );
  });

  test("requires concurrently moved branches to remain preserved as ambiguous", () => {
    const value = receipt();
    const [, , branch] = value.branches;
    if (!branch) {
      throw new Error("missing fixture branch");
    }
    branch.finalHeadRevision = "d".repeat(40);
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "moved branch must be classified as ambiguous"
    );
  });

  test("requires the canonical target in the final inventory", () => {
    const value = receipt();
    value.branches = value.branches.filter((branch) => branch.name !== "main");
    value.initialBranchCount -= 1;
    value.finalBranchCount -= 1;
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "canonical target is missing"
    );
  });

  test("requires inventory counts to match the accounted ledger", () => {
    const value = receipt();
    value.finalBranchCount += 1;
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "inventory counts must match"
    );
  });
});
