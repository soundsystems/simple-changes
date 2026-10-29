import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  executeLoopMutation,
  finalizeLoop,
  recordRemoteBranchReconciliation,
  recordShipmentOutcome,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { pruneExpiredExternalDeletionPins } from "../../../skills/simple-changes/scripts/lib/loop-lease-remote.ts";
import {
  type RemoteBranchHolds,
  remoteBranchCleanupReport,
  remoteBranchHolds,
} from "../../../skills/simple-changes/scripts/lib/remote-branch-prune.ts";
import {
  buildRemoteInventory,
  type RemoteInventoryHoldResolver,
  type RemoteInventoryPages,
} from "../../../skills/simple-changes/scripts/lib/remote-inventory.ts";
import type {
  ShipmentOutcomeReceipt,
  WorktreeClaim,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import { readCoordinationDocumentFromCommonDirectory } from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import { commitEquivalenceAgainstTarget } from "../../../skills/simple-changes/scripts/lib/worktree-equivalence.ts";
import {
  renderExpiredExternalDeletionPins,
  renderRemoteBranchCleanup,
} from "../../../skills/simple-changes/scripts/simple-changes.ts";
import { runWithFakeGit } from "./fake-git.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(60_000);

let repositories: TestRepository[] = [];
let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
  for (const cleanup of cleanups.reverse()) {
    cleanup();
  }
  cleanups = [];
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
/** An extra provider branch: its opening head, and its final head or null. */
interface ExtraBranch {
  finalHead: string | null;
  name: string;
  openingHead: string;
}

const shipMergedProposal = async (options: {
  /** Runs before the first record; a refused first record is retried once. */
  beforeRecord?: (root: string, runId: string) => () => void;
  /** Runs after the record and before finalization. */
  beforeFinalize?: (context: {
    rebuild: () => ReturnType<typeof buildRemoteInventory>;
    root: string;
    runId: string;
  }) => void;
  deleteSource: boolean;
  extraBranches?: (root: string) => ExtraBranch[];
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
  const extras = options.extraBranches?.(root) ?? [];
  const openingReceipt = buildRemoteInventory(
    pages(
      new Date().toISOString(),
      [
        main(opening),
        { headRevision: releaseHead, name: "release/1", protected: false },
        ...docs,
        ...extras.map((extra) => ({
          headRevision: extra.openingHead,
          name: extra.name,
          protected: false,
        })),
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
  const buildFinal = (observedAt: string) =>
    buildRemoteInventory(
      pages(
        observedAt,
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
          ...extras.flatMap((extra) =>
            extra.finalHead
              ? [
                  {
                    headRevision: extra.finalHead,
                    name: extra.name,
                    protected: false,
                  },
                ]
              : []
          ),
        ],
        [mr("96", "release/1", "merged", releaseHead)],
        []
      ),
      { opening: openingReceipt, resolveHolds: localHolds(root) }
    );
  const built = buildFinal(new Date(Date.now() + 1000).toISOString());
  const record = () =>
    recordRemoteBranchReconciliation(
      root,
      lease.runId,
      "controller",
      built.receipt
    );
  let firstRecordError: unknown = null;
  if (options.beforeRecord) {
    const undo = options.beforeRecord(root, lease.runId);
    try {
      record();
    } catch (error) {
      firstRecordError = error;
    }
    undo();
  }
  if (!options.beforeRecord || firstRecordError) {
    record();
  }
  options.beforeFinalize?.({
    rebuild: () => buildFinal(new Date(Date.now() + 2000).toISOString()),
    root,
    runId: lease.runId,
  });
  const finalized = finalizeLoop(
    root,
    lease.runId,
    "controller",
    "Shipped release/1 through MR !96."
  );
  return {
    built,
    finalized,
    firstRecordError,
    opening,
    releaseHead,
    root,
    runId: lease.runId,
  };
};

const externalRecordDirectory = (root: string, runId: string): string =>
  join(
    captureInventory(root).repository.commonGitDirectory,
    "simple-changes",
    "remote-branch-external-deletions",
    runId
  );

/** Each external-deletion record file of a run, by name, with its bytes. */
const externalRecords = (root: string, runId: string): Map<string, string> => {
  const directory = externalRecordDirectory(root, runId);
  return existsSync(directory)
    ? new Map(
        readdirSync(directory)
          .sort()
          .map((name) => [name, readFileSync(join(directory, name), "utf8")])
      )
    : new Map();
};

/** A commit outside the target, reachable from no branch afterward. */
const danglingCommit = (root: string, name: string): string => {
  git(root, ["switch", "-c", name]);
  writeFixture(root, `${name.replaceAll("/", "-")}.txt`, `${name}\n`);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", `Work on ${name}`]);
  const head = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "main"]);
  git(root, ["branch", "-D", name]);
  return head;
};

const pinRefs = (root: string): string[] =>
  git(root, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/simple-changes/external/",
  ])
    .split("\n")
    .filter(Boolean);

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

const DAY = 24 * 60 * 60 * 1000;

/** The pins under the external prefix, as `<ref> <value>` lines. */
const pinTimeOf = (line: string | undefined): number =>
  Number(line?.split(" ")[0]?.split("/").at(-1));

describe("branches deleted outside the run", () => {
  test("an opening branch deleted externally lets the build and reconciliation complete, and finalize reports it pending and pinned", async () => {
    let goneHead = "";
    const before = Date.now();
    const { built, finalized, releaseHead, root, runId } =
      await shipMergedProposal({
        deleteSource: true,
        extraBranches: (repo) => {
          goneHead = danglingCommit(repo, "feature/gone");
          return [
            { finalHead: null, name: "feature/gone", openingHead: goneHead },
          ];
        },
        withContainedBranch: false,
      });
    const after = Date.now();
    expect(built.summary.externallyDeletedBranches).toEqual([
      { lastHeadRevision: goneHead, name: "feature/gone" },
    ]);
    // Control: the branch this run deleted after its merge is still proven.
    expect(
      built.receipt.branches.find((branch) => branch.name === "release/1")
    ).toMatchObject({
      disposition: "deleted-merged",
      initialHeadRevision: releaseHead,
      obsoleteProof: "merged-proposal-head",
    });
    // One pin, whose time is part of its name.
    const lines = pinRefs(root);
    expect(lines).toHaveLength(1);
    const pinnedAt = pinTimeOf(lines[0]);
    expect(pinnedAt).toBeGreaterThanOrEqual(before);
    expect(pinnedAt).toBeLessThanOrEqual(after);
    const pinRef = `refs/simple-changes/external/${runId}/${goneHead}/${pinnedAt}`;
    expect(lines).toEqual([`${pinRef} ${goneHead}`]);
    const records = [...externalRecords(root, runId)];
    expect(records).toHaveLength(1);
    const [name, bytes] = records[0] ?? ["", "{}"];
    const record = JSON.parse(bytes) as {
      deletions: unknown[];
      receiptDigest: string;
    };
    expect(name).toBe(`${record.receiptDigest}.json`);
    expect(record.deletions).toEqual([
      { branch: "feature/gone", lastHeadRevision: goneHead },
    ]);
    expect(finalized.outcome).toBe("completed");
    expect(finalized.blockers).toEqual([]);
    expect(finalized.receipt.cleanupStatus).toBe("pending");
    expect(finalized.receipt.deliveryStatus).toBe("verified");
    const [item, ...others] =
      finalized.receipt.remoteBranches?.deletedExternally ?? [];
    expect(others).toEqual([]);
    expect(item).toMatchObject({
      lastHeadRevision: goneHead,
      name: "feature/gone",
      pinExpiresAt: new Date(pinnedAt + 14 * DAY).toISOString(),
      pinRef,
    });
    expect(item?.note).toContain(
      `This branch was deleted outside this run; its last head was ${goneHead}.`
    );
    expect(item?.note).toContain("not counted as delivered or obsolete");
    expect(finalized.receipt.remoteBranches?.pending).toEqual([]);
    // It is the only cleanup left, and the text output still names it.
    expect(finalized.receipt.remoteBranches?.held).toEqual([]);
    expect(finalized.receipt.remoteBranches?.errors).toEqual([]);
    expect(renderRemoteBranchCleanup(finalized.receipt.remoteBranches)).toBe(
      `Remote branch deleted outside this run: feature/gone. ${item?.note}\n`
    );
    // Its own fresh pin is not pruned when the run closes.
    expect(finalized.expiredExternalDeletionPins).toBeUndefined();

    // A later run's pruning keeps the pin until 14 days after it was made.
    expect(
      pruneExpiredExternalDeletionPins(
        root,
        "run-later-00000000",
        pinnedAt + 14 * DAY - 1
      )
    ).toEqual({ errors: [], removed: [] });
    expect(pinRefs(root)).toHaveLength(1);
    expect(
      pruneExpiredExternalDeletionPins(
        root,
        "run-later-00000000",
        pinnedAt + 14 * DAY
      )
    ).toEqual({ errors: [], removed: [pinRef] });
    expect(pinRefs(root)).toEqual([]);
  }, 180_000);

  test("a pin that fails leaves no pin and no time, so the retry's pin starts its own retention", async () => {
    let goneHead = "";
    let failedAt = 0;
    const { finalized, firstRecordError, root, runId } =
      await shipMergedProposal({
        beforeRecord: (repo, run) => {
          // A ref at the head's own pin folder makes its pin fail.
          const blocker = `refs/simple-changes/external/${run}/${goneHead}`;
          git(repo, ["update-ref", blocker, goneHead]);
          return () => {
            expect(pinRefs(repo)).toEqual([`${blocker} ${goneHead}`]);
            expect(externalRecords(repo, run).size).toBe(0);
            git(repo, ["update-ref", "-d", blocker]);
            failedAt = Date.now();
          };
        },
        deleteSource: true,
        extraBranches: (repo) => {
          goneHead = danglingCommit(repo, "feature/gone");
          return [
            { finalHead: null, name: "feature/gone", openingHead: goneHead },
          ];
        },
        withContainedBranch: false,
      });
    expect(String(firstRecordError)).toContain(
      `Could not pin last head ${goneHead} of feature/gone`
    );
    const lines = pinRefs(root);
    expect(lines).toHaveLength(1);
    const pinnedAt = pinTimeOf(lines[0]);
    expect(pinnedAt).toBeGreaterThanOrEqual(failedAt);
    expect(finalized.outcome).toBe("completed");
    expect(
      finalized.receipt.remoteBranches?.deletedExternally?.[0]
    ).toMatchObject({
      pinRef: `refs/simple-changes/external/${runId}/${goneHead}/${pinnedAt}`,
    });
  }, 180_000);

  test("a record that fails before the lease write keeps the earlier receipt valid", async () => {
    let goneHead = "";
    let earlier = new Map<string, string>();
    let afterFailure = new Map<string, string>();
    const { finalized, root } = await shipMergedProposal({
      beforeFinalize: ({ rebuild, root: repo, runId: run }) => {
        earlier = externalRecords(repo, run);
        const later = rebuild();
        process.env.SIMPLE_CHANGES_TEST_FAIL_BEFORE_RECONCILIATION_LEASE_WRITE =
          "1";
        try {
          expect(() =>
            recordRemoteBranchReconciliation(
              repo,
              run,
              "controller",
              later.receipt
            )
          ).toThrow("Test failure before the reconciliation lease write.");
        } finally {
          Reflect.deleteProperty(
            process.env,
            "SIMPLE_CHANGES_TEST_FAIL_BEFORE_RECONCILIATION_LEASE_WRITE"
          );
        }
        afterFailure = externalRecords(repo, run);
      },
      deleteSource: true,
      extraBranches: (repo) => {
        goneHead = danglingCommit(repo, "feature/gone");
        return [
          { finalHead: null, name: "feature/gone", openingHead: goneHead },
        ];
      },
      withContainedBranch: false,
    });
    // The failed record added its own file and left the earlier one, which
    // the lease still names, byte for byte.
    expect(earlier.size).toBe(1);
    expect(afterFailure.size).toBe(2);
    for (const [name, bytes] of earlier) {
      expect(afterFailure.get(name)).toBe(bytes);
    }
    expect(finalized.outcome).toBe("completed");
    expect(finalized.blockers).toEqual([]);
    expect(finalized.receipt.remoteBranches?.deletedExternally).toHaveLength(1);
    // The failed record made no second pin.
    expect(pinRefs(root)).toHaveLength(1);
  }, 180_000);

  test("a branch deleted externally whose head is not local is reported, with no pin claimed", async () => {
    const missing = "9".repeat(40);
    const { built, finalized, root } = await shipMergedProposal({
      deleteSource: true,
      extraBranches: () => [
        { finalHead: null, name: "feature/remote-only", openingHead: missing },
      ],
      withContainedBranch: false,
    });
    expect(built.summary.externallyDeletedBranches).toEqual([
      { lastHeadRevision: missing, name: "feature/remote-only" },
    ]);
    expect(pinRefs(root)).toEqual([]);
    expect(finalized.outcome).toBe("completed");
    expect(finalized.receipt.cleanupStatus).toBe("pending");
    const items = finalized.receipt.remoteBranches?.deletedExternally ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      lastHeadRevision: missing,
      name: "feature/remote-only",
      pinRef: null,
    });
    expect(items[0]?.pinExpiresAt).toBeUndefined();
    expect(items[0]?.note).toContain("not present locally, so nothing pins it");
    expect(
      renderRemoteBranchCleanup(finalized.receipt.remoteBranches)
    ).toContain(
      `Remote branch deleted outside this run: feature/remote-only. This branch was deleted outside this run; its last head was ${missing}.`
    );
  }, 180_000);

  test("control: a branch that moved instead of being deleted stays preserved", async () => {
    let before = "";
    let after = "";
    const { built, finalized, root } = await shipMergedProposal({
      deleteSource: true,
      extraBranches: (repo) => {
        before = danglingCommit(repo, "feature/moving");
        after = danglingCommit(repo, "feature/moved");
        return [
          { finalHead: after, name: "feature/moving", openingHead: before },
        ];
      },
      withContainedBranch: false,
    });
    expect(built.summary.externallyDeletedBranches).toEqual([]);
    expect(built.summary.movedBranches).toEqual(["feature/moving"]);
    expect(
      built.receipt.branches.find((branch) => branch.name === "feature/moving")
    ).toMatchObject({
      classification: "ambiguous",
      disposition: "preserved-ambiguous",
      finalHeadRevision: after,
      initialHeadRevision: before,
    });
    expect(pinRefs(root)).toEqual([]);
    expect(finalized.outcome).toBe("completed");
    expect(finalized.receipt.remoteBranches?.deletedExternally).toBeUndefined();
    expect(finalized.receipt.cleanupStatus).toBe("complete");
  }, 180_000);

  test("pruning removes only expired pins of the exact shape it makes, from other runs", () => {
    const { root } = repository();
    const head = git(root, ["rev-parse", "HEAD"]);
    const now = Date.now();
    const pin = (run: string, time: number | string) =>
      `refs/simple-changes/external/${run}/${head}/${time}`;
    const expired = pin("run-old-aaaaaaaa", now - 20 * DAY);
    const fresh = pin("run-old-aaaaaaaa", now - 2 * DAY);
    const current = pin("run-current-cccccccc", now - 20 * DAY);
    const notATime = pin("run-old-aaaaaaaa", "later");
    const noTime = `refs/simple-changes/external/run-old-bbbbbbbb/${head}`;
    const wrongValue = `refs/simple-changes/external/run-old-aaaaaaaa/${"1".repeat(40)}/${now - 20 * DAY}`;
    for (const ref of [expired, fresh, current, notATime, noTime, wrongValue]) {
      git(root, ["update-ref", ref, head]);
    }
    const pruned = pruneExpiredExternalDeletionPins(
      root,
      "run-current-cccccccc",
      now
    );
    expect(pruned).toEqual({ errors: [], removed: [expired] });
    expect(renderExpiredExternalDeletionPins(pruned)).toBe(
      `Removed expired pin ${expired} of a branch deleted outside an earlier run.\n`
    );
    expect(renderExpiredExternalDeletionPins(undefined)).toBe("");
    expect(new Set(pinRefs(root).map((line) => line.split(" ")[0]))).toEqual(
      new Set([fresh, current, notATime, noTime, wrongValue])
    );
  });
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

  test("a Git failure while settling containment is an error, never clean", () => {
    const { root } = repository();
    const head = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "-c", "side"]);
    writeFixture(root, "side.txt", "one\n");
    git(root, ["add", "side.txt"]);
    git(root, ["commit", "-m", "Side one"]);
    const lost = git(root, ["rev-parse", "HEAD"]);
    writeFixture(root, "side.txt", "two\n");
    git(root, ["commit", "-am", "Side two"]);
    const side = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "main"]);
    // The head is readable, but an ancestor object is gone.
    rmSync(join(root, ".git", "objects", lost.slice(0, 2), lost.slice(2)));
    const snapshot = pages(
      OPENED,
      [main(head), { headRevision: side, name: "side", protected: false }],
      [],
      []
    );
    const receipt = finalReceipt(snapshot, snapshot);
    const unheld = report(root, receipt);
    expect(unheld.pending).toEqual([]);
    expect(unheld.errors.join(" ")).toContain(`side at ${side}: Git could not`);
    // Held, the same failure is neither pending nor an error.
    const held = remoteBranchCleanupReport({
      claims: [],
      inventory: captureInventory(root, { skipWorktreeStatus: true }),
      openTargets: [{ objectId: "97", targetBranch: "side" }],
      receipt,
    });
    expect(held).toEqual({
      errors: [],
      held: [],
      openProposalTargets: "recorded",
      pending: [],
    });
  });

  test("the patch audit consumes the settled merge base, so a Git failure is never a no", () => {
    const { root } = repository();
    const head = git(root, ["rev-parse", "HEAD"]);
    // Without the option the audit would find its own base and answer.
    expect(() =>
      commitEquivalenceAgainstTarget(root, head, head, {
        mergeBase: "0".repeat(40),
      })
    ).toThrow();
    // A blob missing under a branch commit fails the patch audit after the
    // merge base is settled; the report says so instead of reading clean.
    git(root, ["switch", "-c", "blobless"]);
    writeFixture(root, "lost.txt", "a blob that goes missing\n");
    git(root, ["add", "lost.txt"]);
    git(root, ["commit", "-m", "Add a blob"]);
    const branchHead = git(root, ["rev-parse", "HEAD"]);
    const blob = git(root, ["rev-parse", "HEAD:lost.txt"]);
    git(root, ["switch", "main"]);
    rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const snapshot = pages(
      OPENED,
      [
        main(head),
        { headRevision: branchHead, name: "blobless", protected: false },
      ],
      [],
      []
    );
    const result = report(root, finalReceipt(snapshot, snapshot));
    expect(result.pending).toEqual([]);
    expect(result.errors.join(" ")).toContain(
      `blobless at ${branchHead}: its containment could not be checked`
    );
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
      `not-fetched at ${SHA.other}: the head is not present locally`
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

describe("round 5: the target's upstream and shallow clones", () => {
  const commit = (root: string, file: string, text: string): string => {
    writeFixture(root, file, text);
    git(root, ["add", file]);
    git(root, ["commit", "-m", `Write ${file}`]);
    return git(root, ["rev-parse", "HEAD"]);
  };
  const mergedBuild = (
    head: string,
    name: string,
    branchHead: string,
    resolveHolds: RemoteInventoryHoldResolver
  ) => {
    const branches = [
      main(head),
      { headRevision: branchHead, name, protected: false },
    ];
    return buildRemoteInventory(
      pages(CLOSED, branches, [mr("50", name, "merged", branchHead)], []),
      {
        opening: buildRemoteInventory(
          pages(
            OPENED,
            branches,
            [mr("50", name, "open", branchHead)],
            [{ objectId: "50", targetBranch: "main" }]
          )
        ).receipt,
        resolveHolds,
      }
    );
  };

  test("a target checkout's upstream holds that branch", () => {
    const { root } = repository();
    git(root, ["remote", "add", "origin", "git@gitlab.com:group/project.git"]);
    git(root, ["switch", "-c", "kept"]);
    const keptHead = commit(root, "kept.txt", "kept\n");
    git(root, ["switch", "main"]);
    git(root, ["branch", "-D", "kept"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    git(root, ["update-ref", "refs/remotes/origin/kept", keptHead]);
    // Control: with main tracking nothing, the merged head is proposed.
    expect(
      mergedBuild(
        head,
        "kept",
        keptHead,
        localHolds(root)
      ).summary.deletionProposals.map((proposal) => proposal.name)
    ).toEqual(["kept"]);
    git(root, ["config", "branch.main.remote", "origin"]);
    git(root, ["config", "branch.main.merge", "refs/heads/kept"]);
    const held = mergedBuild(head, "kept", keptHead, localHolds(root));
    expect(held.summary.deletionProposals).toEqual([]);
    expect(held.summary.heldBranches).toEqual([
      {
        headRevision: keptHead,
        name: "kept",
        reasons: [`upstream of main, checked out in ${root}`],
      },
    ]);
  });

  test("an upstream is held by its canonical name when a local branch shares the tracking name", () => {
    const { root } = repository();
    git(root, ["remote", "add", "origin", "git@gitlab.com:group/project.git"]);
    git(root, ["switch", "-c", "kept"]);
    const keptHead = commit(root, "kept.txt", "kept\n");
    git(root, ["switch", "main"]);
    git(root, ["branch", "-D", "kept"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    git(root, ["update-ref", "refs/remotes/origin/kept", keptHead]);
    // A local branch literally named origin/kept makes Git lengthen the
    // abbreviated upstream.
    git(root, ["branch", "origin/kept", head]);
    // Control: with main tracking nothing, the merged head is proposed.
    expect(
      mergedBuild(
        head,
        "kept",
        keptHead,
        localHolds(root)
      ).summary.deletionProposals.map((proposal) => proposal.name)
    ).toEqual(["kept"]);
    git(root, ["config", "branch.main.remote", "origin"]);
    git(root, ["config", "branch.main.merge", "refs/heads/kept"]);
    expect(
      captureInventory(root, { skipWorktreeStatus: true }).branches.find(
        (branch) => branch.name === "main"
      )?.upstream
    ).toBe("remotes/origin/kept");
    const held = mergedBuild(head, "kept", keptHead, localHolds(root));
    expect(held.summary.deletionProposals).toEqual([]);
    expect(held.summary.heldBranches).toEqual([
      {
        headRevision: keptHead,
        name: "kept",
        reasons: [`upstream of main, checked out in ${root}`],
      },
    ]);
  });

  /**
   * A full source and a depth-2 clone of it: `side` (two commits deep) is
   * contained in `main` (five commits deep), but the clone cannot see the
   * history that joins them.
   */
  const shallowPair = () => {
    const source = repository();
    git(source.root, ["switch", "-c", "side"]);
    const sideHead = commit(source.root, "side.txt", "side\n");
    git(source.root, ["switch", "main"]);
    git(source.root, ["merge", "--ff-only", "side"]);
    commit(source.root, "two.txt", "two\n");
    commit(source.root, "three.txt", "three\n");
    const head = commit(source.root, "four.txt", "four\n");
    const clone = join(source.base, "shallow");
    git(source.base, [
      "clone",
      "--quiet",
      "--depth",
      "2",
      "--no-single-branch",
      `file://${source.root}`,
      clone,
    ]);
    expect(git(clone, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(git(clone, ["cat-file", "-t", sideHead])).toBe("commit");
    return { clone, head, sideHead, source: source.root };
  };

  test("a shallow clone withholds every merged-head proposal", () => {
    const { clone, head, sideHead, source } = shallowPair();
    // Control: with full history the same merged head is proposed.
    expect(
      mergedBuild(
        head,
        "side",
        sideHead,
        localHolds(source)
      ).summary.deletionProposals.map((proposal) => proposal.name)
    ).toEqual(["side"]);
    const built = mergedBuild(head, "side", sideHead, localHolds(clone));
    expect(built.summary.deletionProposals).toEqual([]);
    expect(built.summary.heldBranches[0]?.reasons.join(" ")).toContain(
      "git fetch --unshallow"
    );
  });

  test("a shallow clone cannot prove a branch is not contained", () => {
    const { clone, head, sideHead, source } = shallowPair();
    const snapshot = pages(
      OPENED,
      [main(head), { headRevision: sideHead, name: "side", protected: false }],
      [],
      []
    );
    const { receipt } = buildRemoteInventory(snapshot, {
      opening: buildRemoteInventory(snapshot).receipt,
      resolveHolds: noHolds,
    });
    const report = (root: string, openTargets: Target[]) =>
      remoteBranchCleanupReport({
        claims: [],
        inventory: captureInventory(root, { skipWorktreeStatus: true }),
        openTargets,
        receipt,
      });
    // Control: full history proves containment.
    expect(report(source, []).pending).toEqual([
      { headRevision: sideHead, name: "side", proof: "target-contained" },
    ]);
    const shallow = report(clone, []);
    expect(shallow.pending).toEqual([]);
    expect(shallow.errors).toContainEqual(
      expect.stringContaining(`side at ${sideHead}: the clone is shallow`)
    );
    // Held, the branch raises no error of its own; only the lost fork-point
    // holds are reported.
    const held = report(clone, [{ objectId: "97", targetBranch: "side" }]);
    expect(held.pending).toEqual([]);
    expect(held.errors.some((error) => error.includes("side at"))).toBe(false);
    expect(held.errors.join(" ")).toContain(
      "Fork-point holds could not be computed"
    );
  });
});

/** A provider branch with one commit of its own and no local branch. */
const providerOnlyBranch = (root: string, name: string): string => {
  git(root, ["switch", "--quiet", "-c", name]);
  writeFixture(root, `${name}.txt`, `${name}\n`);
  git(root, ["add", `${name}.txt`]);
  git(root, ["commit", "--quiet", "-m", `Write ${name}`]);
  const head = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "--quiet", "main"]);
  git(root, ["branch", "--quiet", "-D", name]);
  return head;
};

/**
 * Each provider branch beside main was merged by its own MR at its head, and
 * the provider kept it: the opening and final pages.
 */
const mergedPages = (head: string, heads: Record<string, string>) => {
  const branches = [
    main(head),
    ...Object.entries(heads).map(([name, headRevision]) => ({
      headRevision,
      name,
      protected: false,
    })),
  ];
  const proposals = (state: Proposal["state"]) =>
    Object.entries(heads).map(([name, headRevision], index) =>
      mr(String(50 + index), name, state, headRevision)
    );
  return {
    final: pages(CLOSED, branches, proposals("merged"), []),
    opening: pages(
      OPENED,
      branches,
      proposals("open"),
      proposals("open").map((proposal) => ({
        objectId: proposal.objectId,
        targetBranch: "main",
      }))
    ),
  };
};

const mergedHeads = (
  head: string,
  heads: Record<string, string>,
  resolveHolds: RemoteInventoryHoldResolver
) => {
  const { final, opening } = mergedPages(head, heads);
  return buildRemoteInventory(final, {
    opening: buildRemoteInventory(opening).receipt,
    resolveHolds,
  });
};

const libraryPath = (name: string): string =>
  join(import.meta.dir, `../../../skills/simple-changes/scripts/lib/${name}`);

// Git's own upstream of a branch, which an older Git refuses.
const UPSTREAM_FORMAT =
  "--format=%(upstream:remotename)%00%(upstream:remoteref)";

const outcome = (built: ReturnType<typeof buildRemoteInventory>) => ({
  held: built.summary.heldBranches.map((branch) => [
    branch.name,
    branch.reasons.join("; "),
  ]),
  proposed: built.summary.deletionProposals.map((branch) => branch.name),
});

describe("an upstream is read the way Git resolves it", () => {
  // Issue #19: main lists two merge values, kept and then other. Git's
  // upstream is the first, origin/kept, but reading the configuration by
  // hand took the last, so kept was proposed and other was held instead.
  const twoMerges = () => {
    const { root } = repository();
    git(root, ["remote", "add", "origin", "git@gitlab.com:group/project.git"]);
    const heads = {
      kept: providerOnlyBranch(root, "kept"),
      other: providerOnlyBranch(root, "other"),
    };
    return { head: git(root, ["rev-parse", "HEAD"]), heads, root };
  };

  test("with two merge values, the first one, which Git uses, holds", () => {
    const { head, heads, root } = twoMerges();
    // Control: with main tracking nothing, both merged heads are proposed.
    expect(outcome(mergedHeads(head, heads, localHolds(root)))).toEqual({
      held: [],
      proposed: ["kept", "other"],
    });
    git(root, ["config", "branch.main.remote", "origin"]);
    git(root, ["config", "--add", "branch.main.merge", "refs/heads/kept"]);
    git(root, ["config", "--add", "branch.main.merge", "refs/heads/other"]);
    expect(
      git(root, [
        "for-each-ref",
        "--format=%(upstream:short)",
        "refs/heads/main",
      ])
    ).toBe("origin/kept");
    const built = mergedHeads(head, heads, localHolds(root));
    expect(outcome(built)).toEqual({
      held: [["kept", `upstream of main, checked out in ${root}`]],
      proposed: ["other"],
    });
    // Finalize reports from the same holds: kept is held, other pending.
    const report = remoteBranchCleanupReport({
      claims: [],
      inventory: captureInventory(root, { skipWorktreeStatus: true }),
      openTargets: [],
      receipt: built.receipt,
    });
    expect(report.errors).toEqual([]);
    expect(report.held.map((branch) => [branch.name, branch.reasons])).toEqual([
      ["kept", [`upstream of main, checked out in ${root}`]],
    ]);
    expect(report.pending.map((branch) => branch.name)).toEqual(["other"]);
  });

  test("a merge value Git maps to no remote-tracking branch still holds", () => {
    // A single-branch clone fetches only main, so Git reports no upstream
    // for main, but its configuration still names kept on the target.
    const { head, heads, root } = twoMerges();
    git(root, [
      "config",
      "remote.origin.fetch",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    git(root, ["config", "branch.main.remote", "origin"]);
    git(root, ["config", "branch.main.merge", "refs/heads/kept"]);
    expect(
      git(root, ["for-each-ref", "--format=%(upstream)", "refs/heads/main"])
    ).toBe("");
    expect(outcome(mergedHeads(head, heads, localHolds(root)))).toEqual({
      held: [["kept", `upstream of main, checked out in ${root}`]],
      proposed: ["other"],
    });
  });

  test("a Git older than 2.16, which refuses the upstream atoms, holds every merge value", () => {
    const { head, root } = twoMerges();
    git(root, ["config", "branch.main.remote", "origin"]);
    git(root, ["config", "--add", "branch.main.merge", "refs/heads/kept"]);
    git(root, ["config", "--add", "branch.main.merge", "refs/heads/other"]);
    const run = (
      failure?: { exitCode: number; stderr: string },
      version?: string
    ) =>
      runWithFakeGit(
        {
          body: `import { captureInventory } from ${JSON.stringify(libraryPath("inventory.ts"))};
import { remoteBranchHolds } from ${JSON.stringify(libraryPath("remote-branch-prune.ts"))};
const inventory = captureInventory(${JSON.stringify(root)}, { skipWorktreeStatus: true });
try {
  const holds = remoteBranchHolds({ claims: [], inventory, targetBranch: "main", targetRevision: ${JSON.stringify(head)} });
  console.log(JSON.stringify(Object.fromEntries(holds.byName)));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
          failFlag: failure ? UPSTREAM_FORMAT : "",
          ...(failure ? { failure } : {}),
          flag: "",
          lost: 0,
          ...(version ? { version } : {}),
        },
        (cleanup) => cleanups.push(cleanup)
      ).reply;
    const reason = `upstream of main, checked out in ${root}`;
    // Control: a Git that knows the atoms holds only its upstream.
    expect(run()).toMatchObject({ kept: [reason] });
    expect(run()).not.toHaveProperty("other");
    // Git 2.13 to 2.15, and Git before 2.13, refuse the atoms in their own
    // words, so the configuration holds every value.
    const refused = {
      exitCode: 128,
      stderr: "fatal: unrecognized %(upstream) argument: remotename",
    };
    expect(run(refused, "git version 2.15.4")).toMatchObject({
      kept: [reason],
      other: [reason],
    });
    expect(
      run(
        {
          exitCode: 128,
          stderr: "fatal: unrecognized format: %(upstream:remotename)",
        },
        "git version 2.12.5"
      )
    ).toMatchObject({ kept: [reason], other: [reason] });
    // The same words from a Git that knows the atoms, or an older Git that
    // fails for another reason, are a failed read, never a missing upstream.
    for (const [failure, version] of [
      [refused, undefined],
      [refused, "git version 2.16.0"],
      [{ ...refused, exitCode: 3 }, "git version 2.15.4"],
      [
        {
          exitCode: 128,
          stderr: "fatal: unable to read refs/heads/main: Input/output error",
        },
        "git version 2.15.4",
      ],
    ] as const) {
      expect((run(failure, version) as { error?: string }).error).toStartWith(
        "cannot read the upstream of main: "
      );
    }
  });

  test("an upstream read that fails withholds every proposal", () => {
    // main tracks origin/kept; other is finished and unrelated. Git fails
    // to read the upstream while the configuration still reads, which once
    // fell back to the configuration as if Git had named no upstream.
    const { head, heads, root } = twoMerges();
    git(root, ["config", "branch.main.remote", "origin"]);
    git(root, ["config", "branch.main.merge", "refs/heads/kept"]);
    const { final, opening } = mergedPages(head, heads);
    const build = (failFlag: string) =>
      runWithFakeGit(
        {
          body: `import { captureInventory } from ${JSON.stringify(libraryPath("inventory.ts"))};
import { remoteBranchHolds } from ${JSON.stringify(libraryPath("remote-branch-prune.ts"))};
import { buildRemoteInventory } from ${JSON.stringify(libraryPath("remote-inventory.ts"))};
const built = buildRemoteInventory(${JSON.stringify(final)}, {
  opening: buildRemoteInventory(${JSON.stringify(opening)}).receipt,
  resolveHolds: (targetBranch, targetRevision) =>
    remoteBranchHolds({
      claims: [],
      inventory: captureInventory(${JSON.stringify(root)}, { skipWorktreeStatus: true }),
      targetBranch,
      targetRevision,
    }),
});
console.log(JSON.stringify({
  held: built.summary.heldBranches.map((branch) => [branch.name, branch.reasons.join("; ")]),
  proposed: built.summary.deletionProposals.map((branch) => branch.name),
}));
`,
          failFlag,
          failure: {
            exitCode: 128,
            stderr: "fatal: unable to read refs/heads/main: Input/output error",
          },
          flag: "",
          lost: 0,
        },
        (cleanup) => cleanups.push(cleanup)
      ).reply as ReturnType<typeof outcome>;
    // Control: with every read whole, kept is held and other proposed.
    expect(build("")).toEqual({
      held: [["kept", `upstream of main, checked out in ${root}`]],
      proposed: ["other"],
    });
    const { held, proposed } = build(UPSTREAM_FORMAT);
    expect(proposed).toEqual([]);
    expect(held.map(([name]) => name)).toEqual(["kept", "other"]);
    for (const [, reasons] of held) {
      expect(reasons).toContain(
        "live worktrees and claims could not be checked"
      );
      expect(reasons).toContain(
        "cannot read the upstream of main: fatal: unable to read refs/heads/main: Input/output error"
      );
    }
  });
});

describe("holds come from every source of checkouts, which must agree", () => {
  // Issue #27: fix/live is checked out in an unclaimed checkout, and MR !51
  // merged it at its head while the provider kept it; done is merged too.
  // A worktree listing cut between two complete records still ends whole,
  // so it once left the checkout out, and fix/live was proposed.
  const liveCheckout = () => {
    const fixture = repository();
    const { root } = fixture;
    const done = providerOnlyBranch(root, "done");
    const path = join(fixture.base, "live");
    git(root, ["worktree", "add", "--quiet", "-b", "fix/live", path]);
    writeFixture(path, "work.txt", "work\n");
    git(path, ["add", "work.txt"]);
    git(path, ["commit", "--quiet", "-m", "Work"]);
    const heads = { done, "fix/live": git(path, ["rev-parse", "HEAD"]) };
    return { fixture, head: git(root, ["rev-parse", "HEAD"]), heads, path };
  };

  type Inventory = ReturnType<typeof captureInventory>;
  const holdsFrom =
    (
      root: string,
      edit: (inventory: Inventory) => void,
      claims: WorktreeClaim[] = []
    ): RemoteInventoryHoldResolver =>
    (targetBranch, targetRevision) => {
      const inventory = captureInventory(root, { skipWorktreeStatus: true });
      edit(inventory);
      return remoteBranchHolds({
        claims,
        inventory,
        targetBranch,
        targetRevision,
      });
    };

  const claimOf = (
    root: string,
    branch: string,
    state: WorktreeClaim["state"] = "active"
  ): WorktreeClaim => ({
    branch,
    changeDigest: "0".repeat(64),
    claimId: `claim-${branch}`,
    commonGitDirectory: join(root, ".git"),
    createdAt: OPENED,
    headSha: null,
    owner: { adapter: "test", agentId: "builder", ownerRef: null },
    path: join(root, "..", branch),
    repositoryId: "test",
    schemaVersion: 1,
    state,
    updatedAt: OPENED,
  });

  // Every merged head is held with the disagreement, so none is proposed.
  const expectWithheld = (
    built: ReturnType<typeof buildRemoteInventory>,
    why: string
  ): void => {
    const { held, proposed } = outcome(built);
    expect(proposed).toEqual([]);
    expect(held.map(([name]) => name)).toEqual(["done", "fix/live"]);
    for (const [, reasons] of held) {
      expect(reasons).toContain("disagree about what is checked out");
      expect(reasons).toContain(why);
      expect(reasons).toContain("retry the command");
    }
  };

  test("a worktree listing that leaves out a checkout withholds every proposal", () => {
    const { fixture, head, heads, path } = liveCheckout();
    const { root } = fixture;
    // Control: the checkout holds fix/live, and done is proposed.
    expect(outcome(mergedHeads(head, heads, localHolds(root)))).toEqual({
      held: [["fix/live", `checked out in ${path}`]],
      proposed: ["done"],
    });
    const cut = (inventory: Inventory) => {
      inventory.worktrees = inventory.worktrees.filter(
        (worktree) => worktree.path !== path
      );
    };
    const built = mergedHeads(head, heads, holdsFrom(root, cut));
    expectWithheld(
      built,
      `the branch listing has fix/live checked out in ${path}, but the worktree listing does not`
    );
    // Finalize reports from the same holds: none can be applied, so both
    // finished branches stay pending, never held or clean.
    const cutInventory = captureInventory(root, { skipWorktreeStatus: true });
    cut(cutInventory);
    const report = remoteBranchCleanupReport({
      claims: [],
      inventory: cutInventory,
      openTargets: [],
      receipt: built.receipt,
    });
    expect(report.held).toEqual([]);
    expect(report.pending.map((branch) => branch.name)).toEqual([
      "done",
      "fix/live",
    ]);
    expect(report.errors.join(" ")).toContain(
      "Holds could not be computed, so none is applied"
    );
    // Control: once the checkout is really gone, fix/live is proposed.
    git(root, ["worktree", "remove", path]);
    expect(
      outcome(mergedHeads(head, heads, localHolds(root))).proposed
    ).toEqual(["done", "fix/live"]);
  });

  test("a branch listing that leaves out or misplaces a checkout's branch withholds every proposal", () => {
    const { fixture, head, heads, path } = liveCheckout();
    const { root } = fixture;
    expectWithheld(
      mergedHeads(
        head,
        heads,
        holdsFrom(root, (inventory) => {
          inventory.branches = inventory.branches.filter(
            (branch) => branch.name !== "fix/live"
          );
        })
      ),
      `the worktree listing has fix/live checked out in ${path}, but the branch listing leaves the branch out`
    );
    expectWithheld(
      mergedHeads(
        head,
        heads,
        holdsFrom(root, (inventory) => {
          for (const branch of inventory.branches) {
            if (branch.name === "fix/live") {
              branch.worktreePath = null;
            }
          }
        })
      ),
      `the worktree listing has fix/live checked out in ${path}, but the branch listing has it checked out nowhere`
    );
  });

  test("a claimed branch that exists but the branch listing leaves out withholds every proposal", () => {
    const { fixture, head, heads } = liveCheckout();
    const { root } = fixture;
    git(root, ["branch", "parked"]);
    const withoutParked = (inventory: Inventory) => {
      inventory.branches = inventory.branches.filter(
        (branch) => branch.name !== "parked"
      );
    };
    expectWithheld(
      mergedHeads(
        head,
        heads,
        holdsFrom(root, withoutParked, [claimOf(root, "parked")])
      ),
      "claim claim-parked holds parked, but the branch listing leaves the branch out"
    );
    // Control: a released claim, or a claim for a branch not created yet,
    // is no disagreement, and the planned branch is still held by name.
    const agreed = outcome(
      mergedHeads(
        head,
        { ...heads, planned: heads.done },
        holdsFrom(root, withoutParked, [
          claimOf(root, "parked", "released"),
          claimOf(root, "planned"),
        ])
      )
    );
    expect(agreed.proposed).toEqual(["done"]);
    expect(agreed.held).toContainEqual([
      "planned",
      "held by claim claim-planned (builder, active)",
    ]);
  });

  test("a tag named like a checked-out branch is no disagreement", () => {
    // Tags named main and fix/live make Git show each branch's short name
    // as heads/<name>, which the worktree listing and claims never use.
    const { fixture, head, heads, path } = liveCheckout();
    const { root } = fixture;
    git(root, ["tag", "main"]);
    git(root, ["tag", "fix/live", heads["fix/live"]]);
    expect(
      git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    ).toBe("heads/fix/live\nheads/main");
    // The checkout still holds fix/live, and the finished done is proposed.
    const built = mergedHeads(
      head,
      heads,
      holdsFrom(root, () => undefined, [claimOf(root, "fix/live")])
    );
    expect(outcome(built)).toEqual({
      held: [
        [
          "fix/live",
          `checked out in ${path}; held by claim claim-fix/live (builder, active)`,
        ],
      ],
      proposed: ["done"],
    });
    // The branch listing names each branch exactly, and finalize reports
    // from the same holds: fix/live held, done pending.
    const inventory = captureInventory(root, { skipWorktreeStatus: true });
    expect(inventory.branches.map((branch) => branch.name)).toEqual([
      "fix/live",
      "main",
    ]);
    const report = remoteBranchCleanupReport({
      claims: [],
      inventory,
      openTargets: [],
      receipt: built.receipt,
    });
    expect(report.errors).toEqual([]);
    expect(report.held.map((branch) => branch.name)).toEqual(["fix/live"]);
    expect(report.pending.map((branch) => branch.name)).toEqual(["done"]);
  });

  test("bare, unborn and prunable checkouts are no disagreement", () => {
    const { fixture, head, heads, path } = liveCheckout();
    const { base, root } = fixture;
    // A checkout whose branch has no commit yet is in the worktree listing
    // only, and one whose folder was deleted is in both.
    const unborn = join(base, "unborn");
    git(root, ["worktree", "add", "--quiet", "--detach", unborn]);
    git(unborn, ["switch", "--quiet", "--orphan", "fresh"]);
    const gone = join(base, "gone");
    git(root, ["worktree", "add", "--quiet", "-b", "fix/gone", gone]);
    rmSync(gone, { force: true, recursive: true });
    const holds = localHolds(root)("main", head);
    expect(holds.byName.get("fix/live")).toEqual([`checked out in ${path}`]);
    expect(holds.byName.get("fresh")).toEqual([`checked out in ${unborn}`]);
    expect(holds.byName.get("fix/gone")).toEqual([`checked out in ${gone}`]);
    expect(outcome(mergedHeads(head, heads, localHolds(root)))).toEqual({
      held: [["fix/live", `checked out in ${path}`]],
      proposed: ["done"],
    });
    // A bare repository's record has no branch, but the branch listing
    // gives its HEAD branch the repository's path.
    const bare = join(base, "bare.git");
    git(base, ["clone", "--quiet", "--bare", root, bare]);
    const linked = join(base, "linked");
    git(bare, ["worktree", "add", "--quiet", "-b", "fix/linked", linked]);
    const inventory = captureInventory(linked, { skipWorktreeStatus: true });
    expect(
      inventory.branches.find((branch) => branch.name === "main")?.worktreePath
    ).toBe(bare);
    const linkedHolds = remoteBranchHolds({
      claims: [],
      inventory,
      targetBranch: "main",
      targetRevision: head,
    });
    expect(linkedHolds.byName.get("fix/linked")).toEqual([
      `checked out in ${linked}`,
    ]);
    expect(linkedHolds.byName.has("main")).toBe(false);
  });
});
