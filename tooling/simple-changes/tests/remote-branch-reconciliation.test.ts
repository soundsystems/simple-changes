import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  remoteBranchReconciliationDigest,
  splitRemoteBranchReconciliationInput,
  validatePostCleanupRecovery,
  validateRemoteBranchAncestryRecord,
  validateRemoteBranchReconciliation,
} from "../../../skills/simple-changes/scripts/lib/remote-branch-reconciliation.ts";
import type {
  RemoteBranchAncestryProof,
  RemoteBranchReconciliationReceipt,
} from "../../../skills/simple-changes/scripts/lib/types.ts";

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

const FAST_FORWARD = {
  initial: "1".repeat(40),
  merged: "2".repeat(40),
};

const recomputeCoverage = (
  value: RemoteBranchReconciliationReceipt
): RemoteBranchReconciliationReceipt => {
  const branchEntries = (phase: "initial" | "final") =>
    value.branches
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
  const proposalEntries = (phase: "initial" | "final") =>
    value.branches.flatMap((branch) =>
      branch.proposals
        .filter((proposal) =>
          phase === "initial"
            ? proposal.observedInitially !== false
            : proposal.observedFinally !== false
        )
        .map((proposal) => ({
          branch: branch.name,
          headRevision: proposal.headRevision,
          objectId: proposal.objectId,
          state: proposal.state,
        }))
    );
  value.initialBranchCount = branchEntries("initial").length;
  value.finalBranchCount = branchEntries("final").length;
  value.initialCoverage = coverage(
    branchEntries("initial"),
    proposalEntries("initial")
  );
  value.finalCoverage = coverage(
    branchEntries("final"),
    proposalEntries("final")
  );
  return value;
};

/**
 * The shipping MR !70 shape: the source branch was open at the initial head,
 * the controller fast-forwarded it, and GitLab merged and deleted it.
 */
const fastForwardReceipt = (): RemoteBranchReconciliationReceipt => {
  const value = receipt();
  value.branches = [
    ...value.branches.filter((branch) => branch.name !== "feature/merged"),
    {
      classification: "merged-obsolete",
      disposition: "deleted-merged",
      evidence: [
        "MR !70 was open at the opening head, fast-forwarded, merged, and its source branch deleted.",
      ],
      finalHeadRevision: null,
      initialHeadRevision: FAST_FORWARD.initial,
      name: "fix/shipped",
      obsoleteProof: "merged-proposal-head",
      proposals: [
        {
          headRevision: FAST_FORWARD.initial,
          objectId: "70",
          observedFinally: false,
          state: "open",
        },
        {
          headRevision: FAST_FORWARD.merged,
          objectId: "70",
          observedInitially: false,
          state: "merged",
        },
      ],
      protected: false,
    },
  ];
  return recomputeCoverage(value);
};

const ancestryProof = (
  mergedHeadRevision = FAST_FORWARD.merged
): RemoteBranchAncestryProof => ({
  branch: "fix/shipped",
  initialHeadRevision: FAST_FORWARD.initial,
  mergedHeadRevision,
  proposalObjectId: "70",
});

/** Same proposal open and merged at the unchanged initial head. */
const sameHeadReceipt = (): RemoteBranchReconciliationReceipt => {
  const value = fastForwardReceipt();
  const [, merged] = shippedBranch(value).proposals;
  if (!merged) {
    throw new Error("missing merged proposal");
  }
  merged.headRevision = FAST_FORWARD.initial;
  return recomputeCoverage(value);
};

const shippedBranch = (value: RemoteBranchReconciliationReceipt) => {
  const branch = value.branches.find((entry) => entry.name === "fix/shipped");
  if (!branch) {
    throw new Error("missing fast-forward fixture branch");
  }
  return branch;
};

describe("remote branch reconciliation", () => {
  test("accepts two matching ordered post-cleanup snapshots", () => {
    const first = snapshot("2026-08-15T12:00:00.000Z");
    const second = snapshot("2026-08-15T12:01:00.000Z");
    expect(
      validatePostCleanupRecovery(postCleanupReceipt(first, second))
    ).toMatchObject({ approvedBy: "user", authority: "close-only" });
  });

  test("accepts stable unrelated active claims during close-only recovery", () => {
    const first = snapshot("2026-08-15T12:00:00.000Z");
    const second = snapshot("2026-08-15T12:01:00.000Z");
    const recoveryReceipt = postCleanupReceipt(first, second);
    recoveryReceipt.firstClaimObservation.activeClaimCount = 18;
    recoveryReceipt.secondClaimObservation.activeClaimCount = 18;
    expect(validatePostCleanupRecovery(recoveryReceipt)).toMatchObject({
      firstClaimObservation: { activeClaimCount: 18 },
      secondClaimObservation: { activeClaimCount: 18 },
    });
  });

  test("rejects changed active-claim counts during close-only recovery", () => {
    const first = snapshot("2026-08-15T12:00:00.000Z");
    const second = snapshot("2026-08-15T12:01:00.000Z");
    const recoveryReceipt = postCleanupReceipt(first, second);
    recoveryReceipt.firstClaimObservation.activeClaimCount = 17;
    recoveryReceipt.secondClaimObservation.activeClaimCount = 18;
    expect(() => validatePostCleanupRecovery(recoveryReceipt)).toThrow(
      "matching ordered worktree-claim observations"
    );
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
  test("accepts a same-proposal fast-forward merge whose source branch was deleted", () => {
    const value = fastForwardReceipt();
    expect(
      validateRemoteBranchReconciliation(value, [ancestryProof()])
    ).toEqual(value);
  });

  test("accepts the same proposal merged at the unchanged initial head", () => {
    const value = sameHeadReceipt();
    expect(
      validateRemoteBranchReconciliation(value, [
        ancestryProof(FAST_FORWARD.initial),
      ])
    ).toEqual(value);
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "an open proposal branch must be classified as open"
    );
  });

  test("keeps the moved-and-deleted shape unrecordable without ancestry proof", () => {
    const value = fastForwardReceipt();
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "an open proposal branch must be classified as open"
    );
  });

  test("rejects ancestry proof that does not start at the exact initial head", () => {
    const value = fastForwardReceipt();
    const proof = { ...ancestryProof(), initialHeadRevision: "3".repeat(40) };
    expect(() => validateRemoteBranchReconciliation(value, [proof])).toThrow(
      "must start at the exact initial branch head"
    );
  });

  test("rejects ancestry proof across different proposals", () => {
    const value = fastForwardReceipt();
    const [, merged] = shippedBranch(value).proposals;
    if (!merged) {
      throw new Error("missing merged proposal");
    }
    merged.objectId = "71";
    recomputeCoverage(value);
    expect(() =>
      validateRemoteBranchReconciliation(value, [ancestryProof()])
    ).toThrow(
      "must bind the same proposal open at the initial head and merged at the proof head"
    );
  });

  test("rejects ancestry proof whose merged head differs from the proposal", () => {
    const value = fastForwardReceipt();
    expect(() =>
      validateRemoteBranchReconciliation(value, [ancestryProof(SHA.target)])
    ).toThrow(
      "must bind the same proposal open at the initial head and merged at the proof head"
    );
  });

  test("rejects ancestry deletion while an open proposal remains", () => {
    const value = fastForwardReceipt();
    shippedBranch(value).proposals.push({
      headRevision: FAST_FORWARD.merged,
      objectId: "72",
      observedInitially: false,
      state: "open",
    });
    recomputeCoverage(value);
    expect(() =>
      validateRemoteBranchReconciliation(value, [ancestryProof()])
    ).toThrow("an open proposal branch cannot be deleted");
  });

  test("rejects ancestry proof when the same proposal is still open finally", () => {
    const value = fastForwardReceipt();
    const [open] = shippedBranch(value).proposals;
    if (!open) {
      throw new Error("missing open proposal");
    }
    Reflect.deleteProperty(open, "observedFinally");
    recomputeCoverage(value);
    expect(() =>
      validateRemoteBranchReconciliation(value, [ancestryProof()])
    ).toThrow(
      "must bind the same proposal open at the initial head and merged at the proof head"
    );
  });

  test("rejects ancestry proof on preserved, target, remaining, or unknown branches", () => {
    const preserved = receipt();
    expect(() =>
      validateRemoteBranchReconciliation(preserved, [
        {
          branch: "build/manual",
          initialHeadRevision: "c".repeat(40),
          mergedHeadRevision: SHA.target,
          proposalObjectId: "1",
        },
      ])
    ).toThrow("requires a merged-obsolete classification");
    expect(() =>
      validateRemoteBranchReconciliation(receipt(), [
        {
          branch: "main",
          initialHeadRevision: SHA.target,
          mergedHeadRevision: SHA.target,
          proposalObjectId: "1",
        },
      ])
    ).toThrow("cannot apply to the canonical target or a protected branch");
    const remaining = fastForwardReceipt();
    shippedBranch(remaining).finalHeadRevision = FAST_FORWARD.merged;
    recomputeCoverage(remaining);
    expect(() =>
      validateRemoteBranchReconciliation(remaining, [ancestryProof()])
    ).toThrow("require deleted-merged, no final ref");
    expect(() =>
      validateRemoteBranchReconciliation(fastForwardReceipt(), [
        ancestryProof(),
        ancestryProof(),
      ])
    ).toThrow("must name exactly one ledger branch");
    expect(() =>
      validateRemoteBranchReconciliation(fastForwardReceipt(), [
        { ...ancestryProof(), branch: "missing" },
      ])
    ).toThrow("must name exactly one ledger branch");
  });

  test("splits input ancestry proof out of the embedded receipt", () => {
    const value = fastForwardReceipt();
    const input = structuredClone(value) as unknown as {
      branches: Record<string, unknown>[];
    };
    const shipped = input.branches.find(
      (branch) => branch.name === "fix/shipped"
    );
    if (!shipped) {
      throw new Error("missing input branch");
    }
    shipped.mergedHeadAncestry = {
      initialHeadRevision: FAST_FORWARD.initial,
      mergedHeadRevision: FAST_FORWARD.merged,
      proposalObjectId: "70",
    };
    expect(() => validateRemoteBranchReconciliation(input)).toThrow(
      "Invalid remote-branch-reconciliation"
    );
    const split = splitRemoteBranchReconciliationInput(input);
    expect(split.ancestryProofs).toEqual([ancestryProof()]);
    expect(split.receipt).toEqual(value);
    expect(
      validateRemoteBranchReconciliation(split.receipt, split.ancestryProofs)
    ).toEqual(value);

    shipped.mergedHeadAncestry = {
      initialHeadRevision: FAST_FORWARD.initial,
      mergedHeadRevision: FAST_FORWARD.merged,
      proposalObjectId: "70",
      verified: true,
    };
    expect(() => splitRemoteBranchReconciliationInput(input)).toThrow(
      "Invalid remote-branch-ancestry proof"
    );
    shipped.mergedHeadAncestry = { ...ancestryProof() };
    expect(() => splitRemoteBranchReconciliationInput(input)).toThrow(
      "must be an object naming proposalObjectId"
    );
  });

  test("re-joins ancestry sidecars only with the exact run and receipt", () => {
    const value = fastForwardReceipt();
    const record = {
      proofs: [ancestryProof()],
      receiptDigest: remoteBranchReconciliationDigest(value),
      runId: "run-abc",
      schemaVersion: 1,
    };
    expect(
      validateRemoteBranchAncestryRecord(record, "run-abc", value)
    ).toEqual([ancestryProof()]);
    expect(() =>
      validateRemoteBranchAncestryRecord(record, "run-other", value)
    ).toThrow("do not match this run's recorded reconciliation receipt");
    expect(() =>
      validateRemoteBranchAncestryRecord(record, "run-abc", receipt())
    ).toThrow("do not match this run's recorded reconciliation receipt");
  });

  test("validates receipts without ancestry proof exactly as before", () => {
    const value = receipt();
    expect(validateRemoteBranchReconciliation(value)).toEqual(value);
    expect(validateRemoteBranchReconciliation(value, [])).toEqual(value);
    const [, merged] = value.branches;
    const proposal = merged?.proposals[0];
    if (!proposal) {
      throw new Error("missing merged proposal");
    }
    proposal.headRevision = "e".repeat(40);
    recomputeCoverage(value);
    expect(() => validateRemoteBranchReconciliation(value)).toThrow(
      "merged deletion proof must bind a merged proposal to the exact initial branch head"
    );
  });
});
