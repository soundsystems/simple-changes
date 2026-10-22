import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  executeLoopMutation,
  finalizeLoop,
  recordRemoteBranchReconciliation,
  recordShipmentOutcome,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  type RemoteBranchHolds,
  remoteBranchCleanupReport,
  remoteBranchHolds,
} from "../../../skills/simple-changes/scripts/lib/remote-branch-prune.ts";
import {
  buildRemoteInventory,
  type RemoteInventoryPages,
} from "../../../skills/simple-changes/scripts/lib/remote-inventory.ts";
import type { ShipmentOutcomeReceipt } from "../../../skills/simple-changes/scripts/lib/types.ts";
import { readCoordinationDocumentFromCommonDirectory } from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(60_000);

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const SHA = {
  feature: "f".repeat(40),
  moved: "e".repeat(40),
  other: "3".repeat(40),
  release: "2".repeat(40),
  target: "a".repeat(40),
};

type Branch = RemoteInventoryPages["branchPages"][number]["branches"][number];
type Proposal =
  RemoteInventoryPages["proposalPages"][number]["proposals"][number];
interface Target {
  objectId: string;
  targetBranch: string;
}

const pages = (
  observedAt: string,
  branches: Branch[],
  proposals: Proposal[],
  targets: Target[] | null
): RemoteInventoryPages => ({
  branchPages: [{ branches, cursorIn: null, cursorOut: null }],
  observedAt,
  project: "group/project",
  proposalPages: [
    {
      cursorIn: null,
      cursorOut: null,
      ...(targets ? { openProposalTargets: targets } : {}),
      proposals,
    },
  ],
  provider: "gitlab",
  schemaVersion: 1,
  targetBranch: "main",
});

const OPENED = "2026-10-21T10:00:00.000Z";
const CLOSED = "2026-10-21T11:00:00.000Z";

const main = (headRevision = SHA.target): Branch => ({
  headRevision,
  name: "main",
  protected: true,
});

const release = (headRevision = SHA.release, isProtected = false): Branch => ({
  headRevision,
  name: "release/1",
  protected: isProtected,
});

const mr = (
  objectId: string,
  sourceBranch: string,
  state: Proposal["state"],
  headRevision: string | null
): Proposal => ({ headRevision, objectId, sourceBranch, state });

const noHolds = (): RemoteBranchHolds => ({
  byName: new Map(),
  byRevision: new Map(),
});

/**
 * MR !96 is open from release/1 at the opening inventory and merged at the
 * same head by the final one, and the provider kept its source branch: the
 * 0.32.0 ship, where finalization then reported clean cleanup.
 */
const openingSnapshot = (extra: Branch[] = [], proposals: Proposal[] = []) =>
  pages(
    OPENED,
    [main(), release(), ...extra],
    [mr("96", "release/1", "open", SHA.release), ...proposals],
    [
      { objectId: "96", targetBranch: "main" },
      ...proposals
        .filter((proposal) => proposal.state === "open")
        .map((proposal) => ({
          objectId: proposal.objectId,
          targetBranch: "main",
        })),
    ]
  );

const finalBuild = (
  opening: RemoteInventoryPages,
  final: RemoteInventoryPages,
  options: Parameters<typeof buildRemoteInventory>[1] = {}
) =>
  buildRemoteInventory(final, {
    opening: buildRemoteInventory(opening).receipt,
    resolveHolds: noHolds,
    ...options,
  });

describe("remote-inventory build deletion proposals", () => {
  test("proposes deleting a merged proposal's surviving source branch", () => {
    const built = finalBuild(
      openingSnapshot(),
      pages(
        CLOSED,
        [main(), release()],
        [mr("96", "release/1", "merged", SHA.release)],
        []
      )
    );
    expect(built.summary.deletionProposals).toEqual([
      {
        basis: "merged-proposal-head",
        headRevision: SHA.release,
        name: "release/1",
        proof: "merged-proposal-head",
        proposalObjectId: "96",
      },
    ]);
    expect(built.summary.heldBranches).toEqual([]);
    // Only a proposal: the receipt still preserves the branch it names.
    expect(
      built.receipt.branches.find((branch) => branch.name === "release/1")
    ).toMatchObject({ disposition: "preserved-ambiguous" });
    expect(built.receipt.openProposalTargets).toEqual([]);
  });

  test("proposes a branch whose MR merged before the run at its exact head", () => {
    const merged = [mr("94", "release/1", "merged", SHA.release)];
    const built = finalBuild(
      pages(OPENED, [main(), release()], merged, []),
      pages(CLOSED, [main(), release()], merged, [])
    );
    expect(built.summary.deletionProposals.map((item) => item.name)).toEqual([
      "release/1",
    ]);
  });

  test("never proposes a branch with an open MR from it", () => {
    const built = finalBuild(
      openingSnapshot(),
      pages(
        CLOSED,
        [main(), release()],
        [
          mr("96", "release/1", "merged", SHA.release),
          mr("98", "release/1", "open", SHA.release),
        ],
        [{ objectId: "98", targetBranch: "main" }]
      )
    );
    expect(built.summary.deletionProposals).toEqual([]);
    expect(built.summary.heldBranches).toEqual([]);
  });

  test("never proposes a protected branch", () => {
    const opening = pages(
      OPENED,
      [main(), release(SHA.release, true)],
      [mr("96", "release/1", "open", SHA.release)],
      [{ objectId: "96", targetBranch: "main" }]
    );
    const built = finalBuild(
      opening,
      pages(
        CLOSED,
        [main(), release(SHA.release, true)],
        [mr("96", "release/1", "merged", SHA.release)],
        []
      )
    );
    expect(built.summary.deletionProposals).toEqual([]);
  });

  test("never proposes a branch whose head moved after the merge", () => {
    const built = finalBuild(
      openingSnapshot(),
      pages(
        CLOSED,
        [main(), release(SHA.moved)],
        [mr("96", "release/1", "merged", SHA.release)],
        []
      )
    );
    expect(built.summary.deletionProposals).toEqual([]);
    expect(built.summary.movedBranches).toEqual(["release/1"]);
  });

  test("never proposes a head other than the merged MR's recorded head", () => {
    const merged = [mr("94", "release/1", "merged", SHA.release)];
    const built = finalBuild(
      pages(OPENED, [main(), release(SHA.moved)], merged, []),
      pages(CLOSED, [main(), release(SHA.moved)], merged, [])
    );
    expect(built.summary.deletionProposals).toEqual([]);
  });

  test("holds a merged head that an open MR targets", () => {
    const feature: Branch = {
      headRevision: SHA.feature,
      name: "fix/next",
      protected: false,
    };
    const next = mr("97", "fix/next", "open", SHA.feature);
    const built = finalBuild(
      pages(
        OPENED,
        [main(), release(), feature],
        [mr("96", "release/1", "open", SHA.release), next],
        [
          { objectId: "96", targetBranch: "main" },
          { objectId: "97", targetBranch: "release/1" },
        ]
      ),
      pages(
        CLOSED,
        [main(), release(), feature],
        [mr("96", "release/1", "merged", SHA.release), next],
        [{ objectId: "97", targetBranch: "release/1" }]
      )
    );
    expect(built.summary.deletionProposals).toEqual([]);
    expect(built.summary.heldBranches).toEqual([
      {
        headRevision: SHA.release,
        name: "release/1",
        reasons: ["target of open proposal 97"],
      },
    ]);
  });

  test("holds every merged head when the pages do not list open MR targets", () => {
    const built = finalBuild(
      openingSnapshot(),
      pages(
        CLOSED,
        [main(), release()],
        [mr("96", "release/1", "merged", SHA.release)],
        null
      )
    );
    expect(built.summary.deletionProposals).toEqual([]);
    expect(built.summary.heldBranches[0]?.reasons.join(" ")).toContain(
      "do not list open proposal targets"
    );
    expect(built.receipt).not.toHaveProperty("openProposalTargets");
  });

  test("holds merged heads that live local work uses, or that it cannot check", () => {
    const final = pages(
      CLOSED,
      [main(), release()],
      [mr("96", "release/1", "merged", SHA.release)],
      []
    );
    const byName = finalBuild(openingSnapshot(), final, {
      resolveHolds: () => ({
        byName: new Map([["release/1", ["checked out in /work/release"]]]),
        byRevision: new Map(),
      }),
    });
    const byRevision = finalBuild(openingSnapshot(), final, {
      resolveHolds: () => ({
        byName: new Map(),
        byRevision: new Map([[SHA.release, ["fork point of fix/builder"]]]),
      }),
    });
    const unreadable = finalBuild(openingSnapshot(), final, {
      resolveHolds: () => {
        throw new Error("coordination state is unreadable");
      },
    });
    const unavailable = buildRemoteInventory(final, {
      opening: buildRemoteInventory(openingSnapshot()).receipt,
    });
    for (const [built, reason] of [
      [byName, "checked out in /work/release"],
      [byRevision, "fork point of fix/builder"],
      [unreadable, "coordination state is unreadable"],
      [unavailable, "no repository was available"],
    ] as const) {
      expect(built.summary.deletionProposals).toEqual([]);
      expect(built.summary.heldBranches[0]?.reasons.join(" ")).toContain(
        reason
      );
    }
  });

  test("refuses pages whose open MR targets omit an open MR on the page", () => {
    expect(() =>
      finalBuild(
        openingSnapshot(),
        pages(
          CLOSED,
          [main(), release()],
          [
            mr("96", "release/1", "merged", SHA.release),
            mr("98", "release/1", "open", SHA.release),
          ],
          []
        )
      )
    ).toThrow("missing from that page's openProposalTargets");
  });

  test("never proposes a contained branch with no MR", () => {
    const docs: Branch = {
      headRevision: SHA.other,
      name: "docs/old",
      protected: false,
    };
    const built = finalBuild(
      openingSnapshot([docs]),
      pages(
        CLOSED,
        [main(), release(), docs],
        [mr("96", "release/1", "merged", SHA.release)],
        []
      )
    );
    expect(built.summary.deletionProposals.map((item) => item.name)).toEqual([
      "release/1",
    ]);
  });
});

describe("remote-inventory build decisions still win", () => {
  const docs: Branch = {
    headRevision: SHA.other,
    name: "docs/old",
    protected: false,
  };
  const decisions = (name: string, extra: object = {}) => ({
    deletedBranches: [
      {
        evidence: [
          "The user approved deleting it after finalization proved it contained.",
        ],
        name,
        obsoleteProof: "target-contains-head",
        ...extra,
      },
    ],
    schemaVersion: 1,
  });
  const final = (branches: Branch[]) =>
    pages(CLOSED, branches, [mr("96", "release/1", "merged", SHA.release)], []);

  test("a decision for a present branch proposes its deletion, and records it once deleted", () => {
    const opening = openingSnapshot([docs]);
    const approved = finalBuild(opening, final([main(), release(), docs]), {
      decisions: decisions("docs/old"),
    });
    expect(approved.summary.deletionProposals).toContainEqual({
      basis: "decision",
      headRevision: SHA.other,
      name: "docs/old",
      proof: "target-contains-head",
    });
    expect(
      approved.receipt.branches.find((branch) => branch.name === "docs/old")
    ).toMatchObject({ disposition: "preserved-ambiguous" });
    const recorded = finalBuild(opening, final([main(), release()]), {
      decisions: decisions("docs/old"),
    });
    expect(
      recorded.receipt.branches.find((branch) => branch.name === "docs/old")
    ).toMatchObject({
      classification: "no-proposal",
      disposition: "deleted-proven-obsolete",
      obsoleteProof: "target-contains-head",
    });
  });

  test("a decision never overrides what keeps a branch", () => {
    const moved = { ...docs, headRevision: SHA.moved };
    expect(() =>
      finalBuild(openingSnapshot([docs]), final([main(), release(), moved]), {
        decisions: decisions("docs/old"),
      })
    ).toThrow("moved");
    expect(() =>
      finalBuild(openingSnapshot([docs]), final([main(), release(), docs]), {
        decisions: decisions("docs/old"),
        resolveHolds: () => ({
          byName: new Map([["docs/old", ["held by claim c-1"]]]),
          byRevision: new Map(),
        }),
      })
    ).toThrow("held by claim c-1");
    expect(() =>
      finalBuild(openingSnapshot([docs]), final([main(), release(), docs]), {
        decisions: decisions("main"),
      })
    ).toThrow("canonical target or a protected branch");
    const superseded = (supersession: object) => ({
      deletedBranches: [
        {
          evidence: ["The user judged it repackaged into main."],
          name: "docs/old",
          supersession: {
            approvedBy: "user",
            initialHeadRevision: SHA.other,
            reason: "Repackaged into main.",
            replacementRevisions: [SHA.target],
            ...supersession,
          },
        },
      ],
      schemaVersion: 1,
    });
    expect(
      finalBuild(openingSnapshot([docs]), final([main(), release(), docs]), {
        decisions: superseded({}),
      }).summary.deletionProposals
    ).toContainEqual({
      basis: "decision",
      headRevision: SHA.other,
      name: "docs/old",
      proof: "supersession",
    });
    // The receipt would refuse these once the branch is gone, so the build
    // refuses them before anyone deletes it.
    expect(() =>
      finalBuild(openingSnapshot([docs]), final([main(), release(), docs]), {
        decisions: superseded({ replacementRevisions: [SHA.other] }),
      })
    ).toThrow("other than the deleted head");
    expect(() =>
      finalBuild(openingSnapshot([docs]), final([main(), release(), docs]), {
        decisions: superseded({ approvedBy: " " }),
      })
    ).toThrow("nonblank approver and reason");
    expect(() =>
      finalBuild(
        openingSnapshot([docs], [mr("99", "docs/old", "open", SHA.other)]),
        pages(
          CLOSED,
          [main(), release(), docs],
          [
            mr("96", "release/1", "merged", SHA.release),
            mr("99", "docs/old", "closed", SHA.other),
          ],
          []
        ),
        { decisions: superseded({}) }
      )
    ).toThrow("an open proposal branch cannot be deleted");
    // A closed MR seen only at the opening still counts for a supersession,
    // so the receipt would refuse it once the branch is gone.
    expect(() =>
      finalBuild(
        openingSnapshot([docs], [mr("99", "docs/old", "closed", SHA.other)]),
        final([main(), release(), docs]),
        { decisions: superseded({}) }
      )
    ).toThrow("once it is deleted, the receipt would refuse it");
    // A merged-proposal head needs no decision, exactly as after deletion.
    expect(() =>
      finalBuild(openingSnapshot([docs]), final([main(), release(), docs]), {
        decisions: decisions("release/1"),
      })
    ).toThrow("remove its decision");
  });
});

const treeEntry = (root: string, revision: string, path: string): string => {
  const [mode, type, object] = git(root, ["ls-tree", revision, "--", path])
    .split("\t")[0]
    ?.split(" ") ?? ["", "", ""];
  return `${mode}:${type}:${object}`;
};

const localHolds =
  (root: string) =>
  (targetBranch: string, targetRevision: string): RemoteBranchHolds => {
    const inventory = captureInventory(root, { skipWorktreeStatus: true });
    return remoteBranchHolds({
      claims: readCoordinationDocumentFromCommonDirectory(
        inventory.repository.commonGitDirectory
      ).claims,
      inventory,
      targetBranch,
      targetRevision,
    });
  };

/**
 * Ships release/1 through MR !96 into main during a GitLab Ship run. With
 * `deleteSource` the provider deleted the source branch; otherwise it
 * survives. `docs/old` is an old branch with no MR whose head main contains.
 */
const shipMergedProposal = async (options: {
  deleteSource: boolean;
  withContainedBranch: boolean;
}) => {
  const fixture = repository();
  const { root } = fixture;
  git(root, ["remote", "add", "origin", "git@gitlab.com:group/project.git"]);
  const opening = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "-c", "release/1"]);
  writeFixture(root, "release.txt", "release\n");
  git(root, ["add", "release.txt"]);
  git(root, ["commit", "-m", "Release"]);
  const releaseHead = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "main"]);
  const docs: Branch[] = options.withContainedBranch
    ? [{ headRevision: opening, name: "docs/old", protected: false }]
    : [];
  if (options.withContainedBranch) {
    git(root, ["branch", "docs/old", opening]);
  }
  const openingReceipt = buildRemoteInventory(
    pages(
      new Date().toISOString(),
      [
        main(opening),
        { headRevision: releaseHead, name: "release/1", protected: false },
        ...docs,
      ],
      [mr("96", "release/1", "open", releaseHead)],
      [{ objectId: "96", targetBranch: "main" }]
    )
  ).receipt;
  const lease = startLoop(root, "controller", "ship", openingReceipt);
  const merged = await executeLoopMutation(root, lease.runId, "controller", [
    "git",
    "merge",
    "--no-ff",
    "-m",
    "Merge release/1 (!96)",
    "release/1",
  ]);
  expect(merged.result.exitCode).toBe(0);
  const target = git(root, ["rev-parse", "main"]);
  const outcome: ShipmentOutcomeReceipt = {
    additionalPaths: [
      {
        classification: "external-target-change",
        entry: treeEntry(root, target, "release.txt"),
        path: "release.txt",
        reason: "MR !96 merged the reviewed release branch.",
      },
    ],
    runId: lease.runId,
    schemaVersion: 1,
    targetRevision: target,
    units: [],
  };
  recordShipmentOutcome(root, lease.runId, "controller", outcome);
  const built = buildRemoteInventory(
    pages(
      new Date(Date.now() + 1000).toISOString(),
      [
        main(target),
        ...(options.deleteSource
          ? []
          : [
              {
                headRevision: releaseHead,
                name: "release/1",
                protected: false,
              },
            ]),
        ...docs,
      ],
      [mr("96", "release/1", "merged", releaseHead)],
      []
    ),
    { opening: openingReceipt, resolveHolds: localHolds(root) }
  );
  recordRemoteBranchReconciliation(
    root,
    lease.runId,
    "controller",
    built.receipt
  );
  const finalized = finalizeLoop(
    root,
    lease.runId,
    "controller",
    "Shipped release/1 through MR !96."
  );
  return { built, finalized, opening, releaseHead };
};

describe("loop finalize never reports a surviving merged branch as clean", () => {
  test("a merged MR's surviving source branch is proposed and reported pending", async () => {
    const { built, finalized, releaseHead } = await shipMergedProposal({
      deleteSource: false,
      withContainedBranch: false,
    });
    expect(built.summary.deletionProposals).toEqual([
      {
        basis: "merged-proposal-head",
        headRevision: releaseHead,
        name: "release/1",
        proof: "merged-proposal-head",
        proposalObjectId: "96",
      },
    ]);
    expect(finalized.outcome).toBe("completed");
    expect(finalized.receipt.cleanupStatus).toBe("pending");
    expect(finalized.receipt.remoteBranches).toEqual({
      errors: [],
      held: [],
      openProposalTargets: "recorded",
      pending: [
        {
          headRevision: releaseHead,
          name: "release/1",
          proof: "merged-proposal-head",
          proposalObjectId: "96",
        },
      ],
    });
  }, 180_000);

  test("a merged MR's deleted source branch is recorded with proof and reports clean", async () => {
    const { built, finalized } = await shipMergedProposal({
      deleteSource: true,
      withContainedBranch: false,
    });
    expect(built.summary.deletedBranches).toEqual(["release/1"]);
    expect(
      built.receipt.branches.find((branch) => branch.name === "release/1")
    ).toMatchObject({
      disposition: "deleted-merged",
      obsoleteProof: "merged-proposal-head",
    });
    expect(finalized.outcome).toBe("completed");
    expect(finalized.receipt.cleanupStatus).toBe("complete");
    expect(finalized.receipt.remoteBranches?.pending).toEqual([]);
  }, 180_000);

  test("a contained branch with no MR is reported pending, never deleted", async () => {
    const { built, finalized, opening } = await shipMergedProposal({
      deleteSource: true,
      withContainedBranch: true,
    });
    expect(built.summary.deletionProposals).toEqual([]);
    expect(
      built.receipt.branches.find((branch) => branch.name === "docs/old")
    ).toMatchObject({ disposition: "preserved-ambiguous" });
    expect(finalized.outcome).toBe("completed");
    expect(finalized.receipt.cleanupStatus).toBe("pending");
    expect(finalized.receipt.remoteBranches?.pending).toEqual([
      { headRevision: opening, name: "docs/old", proof: "target-contained" },
    ]);
  }, 180_000);
});

describe("remote branch cleanup report never reads unknown as clean", () => {
  const finalReceipt = (
    opening: RemoteInventoryPages,
    final: RemoteInventoryPages
  ) =>
    buildRemoteInventory(final, {
      opening: buildRemoteInventory(opening).receipt,
      resolveHolds: noHolds,
    }).receipt;
  const report = (root: string, receipt: ReturnType<typeof finalReceipt>) =>
    remoteBranchCleanupReport({
      claims: [],
      inventory: captureInventory(root, { skipWorktreeStatus: true }),
      openTargets: [],
      receipt,
    });

  test("a moved or arrived branch merged at its final head is pending even when its head is not local", () => {
    const { root } = repository();
    const head = git(root, ["rev-parse", "HEAD"]);
    const arrived: Branch = {
      headRevision: SHA.feature,
      name: "fix/late",
      protected: false,
    };
    const receipt = finalReceipt(
      pages(
        OPENED,
        [main(head), release()],
        [mr("96", "release/1", "open", SHA.release)],
        [{ objectId: "96", targetBranch: "main" }]
      ),
      pages(
        CLOSED,
        [main(head), release(SHA.moved), arrived],
        [
          mr("96", "release/1", "merged", SHA.moved),
          mr("97", "fix/late", "merged", SHA.feature),
        ],
        []
      )
    );
    expect(report(root, receipt)).toEqual({
      errors: [],
      held: [],
      openProposalTargets: "recorded",
      pending: [
        {
          headRevision: SHA.moved,
          movedDuringRun: true,
          name: "release/1",
          proof: "merged-proposal-head",
          proposalObjectId: "96",
        },
        {
          headRevision: SHA.feature,
          movedDuringRun: true,
          name: "fix/late",
          proof: "merged-proposal-head",
          proposalObjectId: "97",
        },
      ],
    });
  });

  test("a held branch's unsettled audit is neither pending nor an error", () => {
    const { root } = repository();
    const head = git(root, ["rev-parse", "HEAD"]);
    const snapshot = pages(
      OPENED,
      [
        main(head),
        { headRevision: SHA.other, name: "release/next", protected: false },
      ],
      [],
      []
    );
    const receipt = finalReceipt(snapshot, snapshot);
    const held = remoteBranchCleanupReport({
      claims: [],
      inventory: captureInventory(root, { skipWorktreeStatus: true }),
      openTargets: [{ objectId: "97", targetBranch: "release/next" }],
      receipt,
    });
    expect(held).toEqual({
      errors: [],
      held: [],
      openProposalTargets: "recorded",
      pending: [],
    });
    // Unheld, the same missing head is an error.
    expect(report(root, receipt).errors).toHaveLength(1);
  });

  test("a head missing locally or too far ahead to audit is an error, which keeps cleanup pending", () => {
    const { root } = repository();
    const head = git(root, ["rev-parse", "HEAD"]);
    // 201 commits past the target, more than patch equivalence audits.
    const stream = [
      ...Array.from({ length: 201 }, (_, index) =>
        [
          "commit refs/heads/long",
          `mark :${index + 1}`,
          "committer Simple Changes Tests <tests@simple-changes.invalid> 0 +0000",
          "data 1",
          "c",
          index === 0 ? `from ${head}` : `from :${index}`,
          "",
        ].join("\n")
      ),
      "",
    ].join("\n");
    const imported = spawnSync(["git", "-C", root, "fast-import", "--quiet"], {
      stdin: new TextEncoder().encode(stream),
    });
    expect(imported.exitCode).toBe(0);
    const long = git(root, ["rev-parse", "long"]);
    const branches: Branch[] = [
      main(head),
      { headRevision: long, name: "long", protected: false },
      { headRevision: SHA.other, name: "not-fetched", protected: false },
    ];
    const snapshot = pages(OPENED, branches, [], []);
    const result = report(root, finalReceipt(snapshot, snapshot));
    expect(result.pending).toEqual([]);
    expect(result.errors.join(" ")).toContain(
      "too many to prove by patch equivalence"
    );
    expect(result.errors.join(" ")).toContain(
      `Head ${SHA.other} of not-fetched is not present locally`
    );
  }, 120_000);
});

describe("remote branch cleanup report holds", () => {
  test("a contained integration branch is held while a live branch forks from it", () => {
    const fixture = repository();
    const { root } = fixture;
    const head = git(root, ["rev-parse", "HEAD"]);
    const snapshot = pages(
      OPENED,
      [
        main(head),
        { headRevision: head, name: "release/next", protected: false },
      ],
      [],
      []
    );
    const { receipt } = buildRemoteInventory(snapshot, {
      opening: buildRemoteInventory(snapshot).receipt,
      resolveHolds: noHolds,
    });
    const report = (openTargets: Target[] | null) => {
      const inventory = captureInventory(root, { skipWorktreeStatus: true });
      return remoteBranchCleanupReport({
        claims: [],
        inventory,
        openTargets,
        receipt,
      });
    };
    // Nothing uses it yet, so it is cleanup to decide.
    expect(report([]).pending).toEqual([
      { headRevision: head, name: "release/next", proof: "target-contained" },
    ]);
    // An open MR into it holds it.
    expect(
      report([{ objectId: "97", targetBranch: "release/next" }]).held
    ).toEqual([
      {
        headRevision: head,
        name: "release/next",
        proof: "target-contained",
        reasons: ["target of open proposal 97"],
      },
    ]);
    // So does a builder branch cut from it.
    const builder = `${fixture.base}/builder`;
    git(root, ["worktree", "add", "-b", "fix/builder", builder, head]);
    writeFixture(builder, "work.txt", "started\n");
    git(builder, ["add", "work.txt"]);
    git(builder, ["commit", "-m", "Start"]);
    const held = report([]);
    expect(held.pending).toEqual([]);
    expect(held.held[0]?.reasons.join(" ")).toContain(
      "fork point of fix/builder"
    );
    // Unknown targets are said so, never read as none.
    expect(report(null).openProposalTargets).toBe("unknown");
  });
});
