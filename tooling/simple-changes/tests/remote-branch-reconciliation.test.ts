import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  validatePostCleanupRecovery,
  validateRemoteBranchReconciliation,
} from "../../../skills/simple-changes/scripts/lib/remote-branch-reconciliation.ts";
import type { RemoteBranchReconciliationReceipt } from "../../../skills/simple-changes/scripts/lib/types.ts";

const SHA = {
  feature: "b".repeat(40),
  target: "a".repeat(40),
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const coverage = (branchEntries: unknown[], proposalEntries: unknown[]) => ({
  branches: {
    ledgerDigest: digest({
      entryDigest: digest(branchEntries),
      pageDigests: [digest(branchEntries)],
    }),
    pages: [
      {
        cursorIn: null,
        cursorOut: null,
        itemCount: branchEntries.length,
        responseDigest: digest(branchEntries),
      },
    ],
  },
  proposalStates: ["closed", "merged", "open"] as const,
  proposals: {
    ledgerDigest: digest({
      entryDigest: digest(proposalEntries),
      pageDigests: [digest(proposalEntries)],
    }),
    pages: [
      {
        cursorIn: null,
        cursorOut: null,
        itemCount: proposalEntries.length,
        responseDigest: digest(proposalEntries),
      },
    ],
  },
});

const receipt = (): RemoteBranchReconciliationReceipt => {
  const branches: RemoteBranchReconciliationReceipt["branches"] = [
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
  ];
  const branchEntries = (phase: "initial" | "final") =>
    branches
      .filter((branch) =>
        phase === "initial"
          ? branch.initialHeadRevision !== null
          : branch.finalHeadRevision !== null
      )
      .map((branch) => ({
        headRevision:
          phase === "initial"
            ? branch.initialHeadRevision
            : branch.finalHeadRevision,
        name: branch.name,
      }));
  const proposalEntries = branches.flatMap((branch) =>
    branch.proposals.map((proposal) => ({
      branch: branch.name,
      headRevision: proposal.headRevision,
      objectId: proposal.objectId,
      state: proposal.state,
    }))
  );
  return {
    branches,
    finalBranchCount: 2,
    finalCoverage: coverage(branchEntries("final"), proposalEntries),
    finalInventoryComplete: true,
    initialBranchCount: 3,
    initialCoverage: coverage(branchEntries("initial"), proposalEntries),
    initialInventoryComplete: true,
    observedAt: new Date().toISOString(),
    project: "group/project",
    provider: "gitlab",
    schemaVersion: 1,
    targetBranch: "main",
    targetRevision: SHA.target,
  };
};

const snapshot = (
  observedAt = new Date().toISOString()
): RemoteBranchReconciliationReceipt => {
  const branches: RemoteBranchReconciliationReceipt["branches"] = [
    {
      classification: "canonical-target",
      disposition: "preserved-target",
      evidence: ["Complete inventory includes protected main."],
      finalHeadRevision: SHA.target,
      initialHeadRevision: SHA.target,
      name: "main",
      obsoleteProof: null,
      proposals: [],
      protected: true,
    },
  ];
  const entries = [{ headRevision: SHA.target, name: "main" }];
  return {
    branches,
    finalBranchCount: 1,
    finalCoverage: coverage(entries, []),
    finalInventoryComplete: true,
    initialBranchCount: 1,
    initialCoverage: coverage(entries, []),
    initialInventoryComplete: true,
    observedAt,
    project: "group/project",
    provider: "gitlab",
    schemaVersion: 1,
    targetBranch: "main",
    targetRevision: SHA.target,
  };
};

const postCleanupReceipt = (
  firstFinalInventory: RemoteBranchReconciliationReceipt,
  secondFinalInventory: RemoteBranchReconciliationReceipt
) => ({
  approvedBy: "user",
  authority: "close-only" as const,
  firstClaimObservation: {
    activeClaimCount: 0,
    digest: "d".repeat(64),
    observedAt: firstFinalInventory.observedAt,
  },
  firstFinalInventory,
  openingEvidenceUnavailableReason:
    "The legacy controller did not persist opening provider evidence.",
  project: "group/project",
  provider: "gitlab" as const,
  reason: "Cleanup is complete; close bookkeeping only.",
  schemaVersion: 1 as const,
  secondClaimObservation: {
    activeClaimCount: 0,
    digest: "d".repeat(64),
    observedAt: secondFinalInventory.observedAt,
  },
  secondFinalInventory,
  targetBranch: "main",
  targetRevision: SHA.target,
});

describe("remote branch reconciliation", () => {
  test("accepts two matching ordered post-cleanup snapshots", () => {
    const first = snapshot("2026-08-15T12:00:00.000Z");
    const second = snapshot("2026-08-15T12:01:00.000Z");
    expect(
      validatePostCleanupRecovery(postCleanupReceipt(first, second))
    ).toMatchObject({ approvedBy: "user", authority: "close-only" });
  });

  test("rejects differing post-cleanup inventories", () => {
    const first = snapshot("2026-08-15T12:00:00.000Z");
    const second = snapshot("2026-08-15T12:01:00.000Z");
    const [main] = second.branches;
    if (!main) {
      throw new Error("missing main");
    }
    main.protected = false;
    expect(() =>
      validatePostCleanupRecovery(postCleanupReceipt(first, second))
    ).toThrow("matching complete inventories");
  });

  test("rejects blank approval and audit reasons", () => {
    const first = snapshot("2026-08-15T12:00:00.000Z");
    const second = snapshot("2026-08-15T12:01:00.000Z");
    for (const field of [
      "approvedBy",
      "openingEvidenceUnavailableReason",
      "reason",
    ] as const) {
      expect(() =>
        validatePostCleanupRecovery({
          ...postCleanupReceipt(first, second),
          [field]: "   ",
        })
      ).toThrow("nonblank approver and audit reasons");
    }
  });

  test("rejects changed worktree-claim observations", () => {
    const first = snapshot("2026-08-15T12:00:00.000Z");
    const second = snapshot("2026-08-15T12:01:00.000Z");
    const value = postCleanupReceipt(first, second);
    value.secondClaimObservation.digest = "e".repeat(64);
    expect(() => validatePostCleanupRecovery(value)).toThrow(
      "matching ordered worktree-claim observations"
    );
  });

  test("rejects post-cleanup recovery with an open proposal", () => {
    const first = snapshot("2026-08-15T12:00:00.000Z");
    const second = snapshot("2026-08-15T12:01:00.000Z");
    for (const value of [first, second]) {
      const [main] = value.branches;
      if (!main) {
        throw new Error("missing main");
      }
      main.proposals.push({
        headRevision: SHA.target,
        objectId: "99",
        state: "open",
      });
      const proposalEntries = [
        {
          branch: "main",
          headRevision: SHA.target,
          objectId: "99",
          state: "open",
        },
      ];
      value.initialCoverage = coverage(
        [{ headRevision: SHA.target, name: "main" }],
        proposalEntries
      );
      value.finalCoverage = value.initialCoverage;
    }
    expect(() =>
      validatePostCleanupRecovery(postCleanupReceipt(first, second))
    ).toThrow("open proposal");
  });
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
    const [initialProposalPage] = value.initialCoverage.proposals.pages;
    const [finalProposalPage] = value.finalCoverage.proposals.pages;
    if (!(initialProposalPage && finalProposalPage)) {
      throw new Error("missing pagination fixture");
    }
    initialProposalPage.itemCount = 2;
    finalProposalPage.itemCount = 2;
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "coverage digest does not bind"
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
      "coverage digest does not bind"
    );
  });

  test("requires the canonical target in the final inventory", () => {
    const value = receipt();
    value.branches = value.branches.filter((branch) => branch.name !== "main");
    value.initialBranchCount -= 1;
    value.finalBranchCount -= 1;
    const [initialBranchPage] = value.initialCoverage.branches.pages;
    const [finalBranchPage] = value.finalCoverage.branches.pages;
    if (!(initialBranchPage && finalBranchPage)) {
      throw new Error("missing pagination fixture");
    }
    initialBranchPage.itemCount = value.initialBranchCount;
    finalBranchPage.itemCount = value.finalBranchCount;
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "coverage digest does not bind"
    );
  });

  test("requires inventory counts to match the accounted ledger", () => {
    const value = receipt();
    value.finalBranchCount += 1;
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "inventory counts must match"
    );
  });

  test("accounts for a proposal that appears between inventories", () => {
    const value = receipt();
    const [, branch] = value.branches;
    if (!branch) {
      throw new Error("missing fixture branch");
    }
    branch.proposals.push({
      headRevision: branch.initialHeadRevision,
      objectId: "13",
      observedFinally: true,
      observedInitially: false,
      state: "closed",
    });
    const initialEntries = value.branches.flatMap((entry) =>
      entry.proposals
        .filter((proposal) => proposal.observedInitially !== false)
        .map((proposal) => ({
          branch: entry.name,
          headRevision: proposal.headRevision,
          objectId: proposal.objectId,
          state: proposal.state,
        }))
    );
    const finalEntries = value.branches.flatMap((entry) =>
      entry.proposals
        .filter((proposal) => proposal.observedFinally !== false)
        .map((proposal) => ({
          branch: entry.name,
          headRevision: proposal.headRevision,
          objectId: proposal.objectId,
          state: proposal.state,
        }))
    );
    value.initialCoverage.proposals.pages[0] = {
      cursorIn: null,
      cursorOut: null,
      itemCount: initialEntries.length,
      responseDigest: digest(initialEntries),
    };
    value.initialCoverage.proposals.ledgerDigest = digest({
      entryDigest: digest(initialEntries),
      pageDigests: [digest(initialEntries)],
    });
    value.finalCoverage.proposals.pages[0] = {
      cursorIn: null,
      cursorOut: null,
      itemCount: finalEntries.length,
      responseDigest: digest(finalEntries),
    };
    value.finalCoverage.proposals.ledgerDigest = digest({
      entryDigest: digest(finalEntries),
      pageDigests: [digest(finalEntries)],
    });
    expect(validateRemoteBranchReconciliation(value)).toEqual(value);
  });

  test("rejects incomplete pagination and missing proposal states", () => {
    const value = receipt();
    value.initialCoverage.branches.pages[0] = {
      cursorIn: null,
      cursorOut: "next-page",
      itemCount: 3,
      responseDigest: "f".repeat(64),
    };
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "pagination must start at the first page and terminate"
    );
  });

  test("binds multi-page response identities into the ledger proof", () => {
    const value = receipt();
    const proof = value.initialCoverage.branches;
    const originalDigest = proof.pages[0]?.responseDigest;
    if (!originalDigest) {
      throw new Error("missing pagination fixture");
    }
    proof.pages = [
      {
        cursorIn: null,
        cursorOut: "next",
        itemCount: 1,
        responseDigest: "0".repeat(64),
      },
      {
        cursorIn: "next",
        cursorOut: null,
        itemCount: 2,
        responseDigest: "1".repeat(64),
      },
    ];
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "coverage digest does not bind"
    );
    proof.ledgerDigest = digest({
      entryDigest: originalDigest,
      pageDigests: proof.pages.map((page) => page.responseDigest),
    });
    expect(validateRemoteBranchReconciliation(value)).toEqual(value);
  });
});
