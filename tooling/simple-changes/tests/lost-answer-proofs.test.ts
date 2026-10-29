import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { startLoop } from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { DEFAULT_ARCHIVE_TOTAL_BYTES } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import {
  buildRemoteInventory,
  type RemoteInventoryPages,
} from "../../../skills/simple-changes/scripts/lib/remote-inventory.ts";
import {
  archivePinNamespace,
  copyWorktreeIntoArchive,
  newArchiveId,
  writeWorktreeArchiveManifest,
} from "../../../skills/simple-changes/scripts/lib/worktree-archive.ts";
import { type FakeGitLoss, runWithFakeGit } from "./fake-git.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(
  Number(process.env.SIMPLE_CHANGES_TEST_TIMEOUT_MS ?? "") || 60_000
);

// Proofs added in 0.33.0 read Git listings that may be legitimately empty, so
// the runner's lost-answer retry cannot cover them. These tests lose one such
// answer (exit 0, no output, as seen under heavy load) and check that each
// proof refuses rather than reading the lost answer as "nothing there".

const ENTRY_PATTERN = /^100644:blob:[0-9a-f]{40}$/u;
let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.reverse()) {
    cleanup();
  }
  cleanups = [];
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  cleanups.push(fixture.cleanup);
  return fixture;
};

const libraryPath = (name: string): string =>
  fileURLToPath(
    new URL(
      `../../../skills/simple-changes/scripts/lib/${name}`,
      import.meta.url
    )
  );

// Runs `body` in a child whose Git is a fake on PATH (see fake-git.ts), with
// `lost` answers to calls naming `flag` lost first (`mode`), calls naming
// `failFlag` failing, and `git version` printing `version` when given, and
// returns what the child printed.
const runInChild = (
  body: string,
  flag: string,
  lost: number,
  failFlag = "",
  mode: FakeGitLoss = "empty",
  skip = 0,
  version?: string,
  failure?: { exitCode: number; stderr: string }
): { remaining: number; reply: unknown } =>
  runWithFakeGit(
    {
      body,
      failFlag,
      flag,
      lost,
      mode,
      skip,
      ...(version === undefined ? {} : { version }),
      ...(failure === undefined ? {} : { failure }),
    },
    (cleanup) => cleanups.push(cleanup)
  );

describe("exact-byte target proof with a listing lost or cut short", () => {
  // The source's first commit, A, changes a.txt; its second, B, gives
  // a.txt the content the target shipped and adds the unshipped z.txt. The
  // target also adds main.txt, so the paths where the tip and the target
  // differ are main.txt and then z.txt. The true answer refuses on z.txt.
  // A commit listing cut after A, B's path listing cut after a.txt, or the
  // difference cut after main.txt each hide z.txt, so each, read as whole,
  // would prove the source shipped.
  const shippedPartFixture = () => {
    const { root } = repository();
    git(root, ["switch", "--quiet", "-c", "author"]);
    writeFixture(root, "a.txt", "draft\n");
    git(root, ["add", "a.txt"]);
    git(root, ["commit", "--quiet", "-m", "A"]);
    writeFixture(root, "a.txt", "shipped\n");
    writeFixture(root, "z.txt", "unshipped\n");
    git(root, ["add", "a.txt", "z.txt"]);
    git(root, ["commit", "--quiet", "-m", "B"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "--quiet", "main"]);
    writeFixture(root, "a.txt", "shipped\n");
    writeFixture(root, "main.txt", "main\n");
    git(root, ["add", "a.txt", "main.txt"]);
    git(root, ["commit", "--quiet", "-m", "Ship a"]);
    const target = git(root, ["rev-parse", "HEAD"]);
    return { head, root, target };
  };

  type Setup = ReturnType<typeof shippedPartFixture>;

  // Each answer the proof reads: the Git call that answers it, how many
  // such calls come before it, and how to cut its answer short at a
  // boundary that still parses. Path listings and file counts are read for
  // A, then B, then the tip-to-target difference.
  const listings: [string, (setup: Setup) => string, FakeGitLoss, number][] = [
    [
      "the source tip",
      (setup) => `--verify --quiet ${setup.head}^{commit}`,
      "bytes:20",
      0,
    ],
    [
      "the target revision",
      (setup) => `--verify --quiet ${setup.target}^{commit}`,
      "bytes:20",
      0,
    ],
    [
      "the merge base",
      (setup) => `merge-base ${setup.head} ${setup.target}`,
      "bytes:20",
      0,
    ],
    [
      "the commit listing",
      () => "rev-list --reverse --parents",
      "first-line",
      0,
    ],
    ["the commit count", () => "rev-list --count --reverse", "bytes:1", 0],
    ["B's touched paths", () => "--name-only", "nul:1", 1],
    ["B's per-path counts", () => "--numstat", "nul:1", 1],
    ["B's file count", () => "--shortstat", "bytes:3", 1],
    ["the tip-to-target difference", () => "--name-only", "nul:1", 2],
    ["the tip-to-target per-path counts", () => "--numstat", "nul:1", 2],
    ["the tip-to-target file count", () => "--shortstat", "bytes:3", 2],
  ];

  const prove = (
    flag: (setup: Setup) => string,
    lost: number,
    mode: FakeGitLoss,
    skip = 0
  ) => {
    const setup = shippedPartFixture();
    return runInChild(
      `import { proveExactByteTargetContainment } from ${JSON.stringify(libraryPath("exact-byte-proof.ts"))};
console.log(JSON.stringify(proveExactByteTargetContainment(${JSON.stringify(setup.root)}, {
  sourceHead: ${JSON.stringify(setup.head)},
  targetRevision: ${JSON.stringify(setup.target)},
})));
`,
      flag(setup),
      lost,
      "",
      mode,
      skip
    );
  };

  test("with every answer kept, the unshipped path refuses (control)", () => {
    const { remaining, reply } = prove(() => "rev-list --reverse", 0, "empty");
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({
      differingPaths: ["z.txt"],
      status: "refused",
    });
  });

  // Both of B's listings, names and per-path counts, cut after a.txt agree
  // with each other, so only Git's own file count shows z.txt is missing.
  // Read as whole, they would prove the source shipped.
  test("both of B's listings cut after a.txt are asked again, never proven by agreeing", () => {
    // Every `-z` call: A's two listings, then B's.
    const { remaining, reply } = prove(() => "-z", 2, "nul:1", 2);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({
      differingPaths: ["z.txt"],
      status: "refused",
    });
  });

  test("both of B's listings cut after a.txt twice refuse as a lost answer, never proven", () => {
    const { remaining, reply } = prove(() => "-z", 4, "nul:1", 2);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({ differingPaths: [], status: "refused" });
    expect((reply as { reason: string }).reason).toContain("retry the command");
  });

  test.each(listings)(
    "%s cut short once is asked again, so the unshipped path still refuses",
    (_what, flag, cut, skip) => {
      const { remaining, reply } = prove(flag, 1, cut, skip);
      expect(remaining).toBe(0);
      expect(reply).toMatchObject({
        differingPaths: ["z.txt"],
        status: "refused",
      });
    }
  );

  for (const loss of ["empty", "cut"] as const) {
    test.each(listings)(
      `%s ${loss === "empty" ? "lost" : "cut short"} twice refuses as a lost answer, never proven`,
      (_what, flag, cut, skip) => {
        const { remaining, reply } = prove(
          flag,
          2,
          loss === "empty" ? "empty" : cut,
          skip
        );
        expect(remaining).toBe(0);
        expect(reply).toMatchObject({ differingPaths: [], status: "refused" });
        expect((reply as { reason: string }).reason).toContain(
          "retry the command"
        );
      }
    );
  }
});

describe("source worktree delta with a lost Git answer", () => {
  const delta = (lost: number) => {
    const fixture = repository();
    writeFixture(fixture.root, "a.txt", "tracked\n");
    git(fixture.root, ["add", "a.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Track a"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFixture(fixture.root, "a.txt", "edited\n");
    writeFixture(fixture.root, "extra.txt", "untracked\n");
    return runInChild(
      `import { sourceWorktreeDelta } from ${JSON.stringify(libraryPath("source-worktree-delta.ts"))};
const result = sourceWorktreeDelta(${JSON.stringify(fixture.root)}, ${JSON.stringify(head)}, () => null);
console.log(JSON.stringify("entries" in result ? { paths: [...result.entries.keys()].sort() } : result));
`,
      "--exclude-standard",
      lost
    );
  };

  test("with every answer kept, the untracked file is a change (control)", () => {
    const { remaining, reply } = delta(0);
    expect(remaining).toBe(0);
    expect(reply).toEqual({ paths: ["a.txt", "extra.txt"] });
  });

  test("a lost file listing refuses instead of hiding the untracked file", () => {
    const { remaining, reply } = delta(1);
    expect(remaining).toBe(0);
    expect(reply).toEqual({ failure: "its index cannot be read" });
  });
});

describe("target tree entry with a lost Git answer", () => {
  // A present path read as absent counts a deleted path as delivered, so a
  // listing lost, cut short, or failed is asked again and then refused.
  const entry = (
    path: string,
    lost: number,
    mode: FakeGitLoss = "empty",
    failFlag = ""
  ) => {
    const fixture = repository();
    writeFixture(fixture.root, "a.txt", "tracked\n");
    git(fixture.root, ["add", "a.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Track a"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    return runInChild(
      `import { targetTreeEntry } from ${JSON.stringify(libraryPath("loop-lease-shipment.ts"))};
try {
  console.log(JSON.stringify({ entry: targetTreeEntry(${JSON.stringify(fixture.root)}, ${JSON.stringify(head)}, ${JSON.stringify(path)}) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, exitCode: error.exitCode }));
}
`,
      "ls-tree",
      lost,
      failFlag,
      mode
    );
  };

  const expectRefused = (reply: unknown): void => {
    expect(reply).toMatchObject({ exitCode: 4 });
    expect((reply as { error: string }).error).toContain(
      "its answer was lost; retry the command"
    );
  };

  test("with every answer kept, a present path has its entry and an absent one none (control)", () => {
    const present = entry("a.txt", 0);
    expect(present.remaining).toBe(0);
    expect((present.reply as { entry: string }).entry).toMatch(ENTRY_PATTERN);
    expect(entry("missing.txt", 0).reply).toEqual({ entry: null });
  });

  test("a listing lost or cut short once for a present path is asked again", () => {
    for (const mode of ["empty", "bytes:10"] as const) {
      const { remaining, reply } = entry("a.txt", 1, mode);
      expect(remaining).toBe(0);
      expect((reply as { entry: string }).entry).toMatch(ENTRY_PATTERN);
    }
  });

  test("a listing lost or cut short twice for a present path refuses instead of reading it as absent", () => {
    for (const mode of ["empty", "bytes:10"] as const) {
      const { remaining, reply } = entry("a.txt", 2, mode);
      expect(remaining).toBe(0);
      expectRefused(reply);
    }
  });

  test("a listing that fails for a present path refuses instead of reading it as absent", () => {
    expectRefused(entry("a.txt", 0, "empty", "ls-tree").reply);
  });

  test("a lost listing for an absent path is still an absence", () => {
    const { remaining, reply } = entry("missing.txt", 1);
    expect(remaining).toBe(0);
    expect(reply).toEqual({ entry: null });
  });
});

// The remote branch holds and the cleanup report read Git answers that are
// never empty when Git succeeds (a merge base, a branch's upstream line). A
// lost one is asked again, and a second refuses, so a branch in use is never
// proposed for deletion and an unsettled branch is never read as settled.

type RemoteBranch =
  RemoteInventoryPages["branchPages"][number]["branches"][number];
type RemoteProposal =
  RemoteInventoryPages["proposalPages"][number]["proposals"][number];

const remotePages = (
  observedAt: string,
  branches: RemoteBranch[],
  proposals: RemoteProposal[]
): RemoteInventoryPages => ({
  branchPages: [{ branches, cursorIn: null, cursorOut: null }],
  observedAt,
  project: "group/project",
  proposalPages: [
    {
      cursorIn: null,
      cursorOut: null,
      openProposalTargets: proposals
        .filter((proposal) => proposal.state === "open")
        .map((proposal) => ({
          objectId: proposal.objectId,
          targetBranch: "main",
        })),
      proposals,
    },
  ],
  provider: "gitlab",
  schemaVersion: 1,
  targetBranch: "main",
});

// The inventory a child reads, captured here with the real Git, so only the
// calls under test go through the fake one.
const inventoryFor = (root: string) =>
  JSON.stringify(captureInventory(root, { skipWorktreeStatus: true }));

describe("a fork-point hold with a lost merge base", () => {
  // MR !96 merged release/1 at the target's own head, and the provider kept
  // the branch. With `builder`, a live checkout forked at that head, which
  // must hold release/1.
  const build = (builder: boolean, lost: number) => {
    const fixture = repository();
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    if (builder) {
      const path = join(fixture.base, "builder");
      git(fixture.root, ["worktree", "add", "-b", "fix/builder", path, head]);
      writeFixture(path, "work.txt", "started\n");
      git(path, ["add", "work.txt"]);
      git(path, ["commit", "--quiet", "-m", "Start"]);
    }
    const branches = [
      { headRevision: head, name: "main", protected: true },
      { headRevision: head, name: "release/1", protected: false },
    ];
    const proposal = (state: RemoteProposal["state"]): RemoteProposal => ({
      headRevision: head,
      objectId: "96",
      sourceBranch: "release/1",
      state,
    });
    const opening = remotePages("2026-10-21T10:00:00.000Z", branches, [
      proposal("open"),
    ]);
    const final = remotePages("2026-10-21T11:00:00.000Z", branches, [
      proposal("merged"),
    ]);
    return runInChild(
      `import { remoteBranchHolds } from ${JSON.stringify(libraryPath("remote-branch-prune.ts"))};
import { buildRemoteInventory } from ${JSON.stringify(libraryPath("remote-inventory.ts"))};
const inventory = ${inventoryFor(fixture.root)};
const built = buildRemoteInventory(${JSON.stringify(final)}, {
  opening: buildRemoteInventory(${JSON.stringify(opening)}).receipt,
  resolveHolds: (targetBranch, targetRevision) =>
    remoteBranchHolds({ claims: [], inventory, targetBranch, targetRevision }),
});
console.log(JSON.stringify({
  held: built.summary.heldBranches.map((branch) => [branch.name, branch.reasons.join(" ")]),
  proposed: built.summary.deletionProposals.map((branch) => branch.name),
}));
`,
      "merge-base",
      lost
    );
  };

  test("with every answer kept, the live checkout holds the branch, and without it the branch is proposed (control)", () => {
    const held = build(true, 0);
    expect(held.reply).toMatchObject({ proposed: [] });
    const [entry] = (held.reply as { held: [string, string][] }).held;
    expect(entry?.[0]).toBe("release/1");
    expect(entry?.[1]).toContain("fork point of fix/builder");
    expect(build(false, 0).reply).toEqual({
      held: [],
      proposed: ["release/1"],
    });
  });

  test("a lost merge base is asked again, so the hold stays", () => {
    const { remaining, reply } = build(true, 1);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({ proposed: [] });
    const [entry] = (reply as { held: [string, string][] }).held;
    expect(entry?.[1]).toContain("fork point of fix/builder");
  });

  test("a merge base lost twice withholds the proposal instead of dropping the hold", () => {
    const { remaining, reply } = build(true, 2);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({ proposed: [] });
    const [entry] = (reply as { held: [string, string][] }).held;
    expect(entry?.[0]).toBe("release/1");
    expect(entry?.[1]).toContain(
      "live worktrees and claims could not be checked"
    );
    expect(entry?.[1]).toContain("retry the command");
  });
});

// side's only commit was cherry-picked onto main after another commit, so
// the report proves it finished by patch equivalence, which needs the merge
// base, the target's and side's commit listings, and each commit's patch ID.
const patchEquivalentFixture = (change: "text" | "mode" = "text") => {
  const fixture = repository();
  const { root } = fixture;
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "--quiet", "-c", "side"]);
  if (change === "text") {
    writeFixture(root, "side.txt", "side\n");
    git(root, ["add", "side.txt"]);
  } else {
    // A mode change only: a diff without a hunk.
    chmodSync(join(root, "README.md"), 0o755);
    git(root, ["add", "README.md"]);
  }
  git(root, ["commit", "--quiet", "-m", "Side"]);
  const side = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "--quiet", "main"]);
  writeFixture(root, "main.txt", "main\n");
  git(root, ["add", "main.txt"]);
  git(root, ["commit", "--quiet", "-m", "Main"]);
  git(root, ["cherry-pick", side]);
  const head = git(root, ["rev-parse", "HEAD"]);
  const snapshot = remotePages(
    "2026-10-21T10:00:00.000Z",
    [
      { headRevision: head, name: "main", protected: true },
      { headRevision: side, name: "side", protected: false },
    ],
    []
  );
  const { receipt } = buildRemoteInventory(snapshot, {
    opening: buildRemoteInventory(snapshot).receipt,
    resolveHolds: () => ({ byName: new Map(), byRevision: new Map() }),
  });
  return { base, head, receipt, root, side };
};

// The report for `fixture` in a child whose Git loses `lost` answers to
// calls naming `flag`.
const reportInChild = (
  fixture: ReturnType<typeof patchEquivalentFixture>,
  flag: string,
  lost: number,
  mode: FakeGitLoss = "empty",
  skip = 0,
  version?: string
) =>
  runInChild(
    `import { remoteBranchCleanupReport } from ${JSON.stringify(libraryPath("remote-branch-prune.ts"))};
const result = remoteBranchCleanupReport({
  claims: [],
  inventory: ${inventoryFor(fixture.root)},
  openTargets: [],
  receipt: ${JSON.stringify(fixture.receipt)},
});
console.log(JSON.stringify({ errors: result.errors, pending: result.pending }));
`,
    flag,
    lost,
    "",
    mode,
    skip,
    version
  );

// Every patch-ID calculation reads the commit's diff and then pipes it into
// `git patch-id`, target commits first (main's own commit, then the
// cherry-pick), so side's commit is the third call of each; the diff call
// names --full-index in this and in earlier versions.
const SIDE_DIFF = { flag: "--full-index", skip: 2 } as const;
const SIDE_PATCH_ID = { flag: "patch-id --stable", skip: 2 } as const;

describe("the cleanup report with a lost merge base", () => {
  const report = (lost: number) => {
    const fixture = patchEquivalentFixture();
    return {
      side: fixture.side,
      // Only the merge-base question, not the ancestry check before it.
      ...reportInChild(fixture, `merge-base ${fixture.side}^{commit}`, lost),
    };
  };

  const expectPatchEquivalent = (lost: number): void => {
    const { remaining, reply, side } = report(lost);
    expect(remaining).toBe(0);
    expect(reply).toEqual({
      errors: [],
      pending: [
        { headRevision: side, name: "side", proof: "patch-equivalent" },
      ],
    });
  };

  test("with every answer kept, the branch is pending as patch-equivalent (control)", () => {
    expectPatchEquivalent(0);
  });

  test("a lost merge base is asked again, so the branch is still pending as patch-equivalent", () => {
    expectPatchEquivalent(1);
  });

  test("a merge base lost twice is an error that keeps cleanup pending, never a settled answer", () => {
    const { remaining, reply, side } = report(2);
    expect(remaining).toBe(0);
    const { errors, pending } = reply as {
      errors: string[];
      pending: unknown[];
    };
    expect(pending).toEqual([]);
    expect(errors.join(" ")).toContain(
      `side at ${side}: Git could not find a merge base`
    );
    expect(errors.join(" ")).toContain("retry the command");
  });
});

describe("the cleanup report with a target listing lost or cut short", () => {
  // The target range lists main's own commit first, then the cherry-pick,
  // so a listing cut to its first line leaves side's commit unmatched.
  const expectPatchEquivalent = (
    lost: number,
    mode: "empty" | "first-line"
  ): void => {
    const fixture = patchEquivalentFixture();
    const { remaining, reply } = reportInChild(
      fixture,
      `rev-list --reverse ${fixture.base}..${fixture.head}`,
      lost,
      mode
    );
    expect(remaining).toBe(0);
    expect(reply).toEqual({
      errors: [],
      pending: [
        { headRevision: fixture.side, name: "side", proof: "patch-equivalent" },
      ],
    });
  };

  test("with every answer kept, the branch is pending as patch-equivalent (control)", () => {
    expectPatchEquivalent(0, "empty");
  });

  test("a target listing cut short is asked again, so the branch is still pending", () => {
    expectPatchEquivalent(1, "first-line");
  });

  test("a lost target listing is asked again, so the branch is still pending", () => {
    expectPatchEquivalent(1, "empty");
  });

  test("a target listing cut short twice is an error that keeps cleanup pending, never settled", () => {
    const fixture = patchEquivalentFixture();
    const { remaining, reply } = reportInChild(
      fixture,
      `rev-list --reverse ${fixture.base}..${fixture.head}`,
      2,
      "first-line"
    );
    expect(remaining).toBe(0);
    const { errors, pending } = reply as {
      errors: string[];
      pending: unknown[];
    };
    expect(pending).toEqual([]);
    expect(errors.join(" ")).toContain(
      `side at ${fixture.side}: its containment could not be checked`
    );
    expect(errors.join(" ")).toContain("retry the command");
  });
});

describe("the cleanup report with a lost diff or patch ID", () => {
  // Patch evidence is used only when it is whole, so a lost answer for
  // side's commit is asked again, and a second loss is an error, never a
  // settled miss.
  const run = (
    change: "text" | "mode",
    loss: { flag: string; skip: number },
    lost: number
  ) => {
    const fixture = patchEquivalentFixture(change);
    return {
      side: fixture.side,
      ...reportInChild(fixture, loss.flag, lost, "empty", loss.skip),
    };
  };

  const expectPatchEquivalent = (
    change: "text" | "mode",
    loss: { flag: string; skip: number },
    lost: number
  ): void => {
    const { remaining, reply, side } = run(change, loss, lost);
    expect(remaining).toBe(0);
    expect(reply).toEqual({
      errors: [],
      pending: [
        { headRevision: side, name: "side", proof: "patch-equivalent" },
      ],
    });
  };

  const expectError = (
    change: "text" | "mode",
    loss: { flag: string; skip: number }
  ): void => {
    const { remaining, reply, side } = run(change, loss, 2);
    expect(remaining).toBe(0);
    const { errors, pending } = reply as {
      errors: string[];
      pending: unknown[];
    };
    expect(pending).toEqual([]);
    expect(errors.join(" ")).toContain(
      `side at ${side}: its containment could not be checked`
    );
    expect(errors.join(" ")).toContain("retry the command");
  };

  test("with every answer kept, a text or a mode-only change is pending as patch-equivalent (control)", () => {
    expectPatchEquivalent("text", SIDE_DIFF, 0);
    expectPatchEquivalent("mode", SIDE_PATCH_ID, 0);
  });

  test("a lost diff is asked again, so the branch is still pending", () => {
    expectPatchEquivalent("text", SIDE_DIFF, 1);
  });

  test("a diff lost twice is an error that keeps cleanup pending, never a settled miss", () => {
    expectError("text", SIDE_DIFF);
  });

  test("a lost patch ID for a diff without a hunk is asked again, so the branch is still pending", () => {
    expectPatchEquivalent("mode", SIDE_PATCH_ID, 1);
  });

  test("a patch ID lost twice for a diff without a hunk is an error, never a settled miss", () => {
    expectError("mode", SIDE_PATCH_ID);
  });
});

describe("an empty patch ID beside a Git version cut short", () => {
  // A version answer cut short ("git version 2.5" for 2.54) once read as a
  // Git that gives no patch ID to a diff without a hunk, so a lost patch ID
  // for side's mode-only commit settled as a miss and the report dropped
  // the branch. An empty patch ID for a non-empty diff is now always asked
  // again and then refused, whatever the version says.
  const CUT_VERSION = "git version 2.5";

  const report = (lost: number) => {
    const fixture = patchEquivalentFixture("mode");
    return {
      side: fixture.side,
      ...reportInChild(
        fixture,
        SIDE_PATCH_ID.flag,
        lost,
        "empty",
        SIDE_PATCH_ID.skip,
        CUT_VERSION
      ),
    };
  };

  const audit = (lost: number) => {
    const fixture = patchEquivalentFixture("mode");
    return runInChild(
      `import { targetContainmentAudit } from ${JSON.stringify(libraryPath("cleanup-core.ts"))};
try {
  console.log(JSON.stringify({ method: targetContainmentAudit(${JSON.stringify(fixture.root)}, ${JSON.stringify(fixture.head)}, ${JSON.stringify(fixture.side)}).method }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      SIDE_PATCH_ID.flag,
      lost,
      "",
      "empty",
      SIDE_PATCH_ID.skip,
      CUT_VERSION
    );
  };

  test("with every patch ID whole, the mode-only change is still pending as patch-equivalent (control)", () => {
    const { remaining, reply, side } = report(0);
    expect(remaining).toBe(0);
    expect(reply).toEqual({
      errors: [],
      pending: [
        { headRevision: side, name: "side", proof: "patch-equivalent" },
      ],
    });
    expect(audit(0).reply).toEqual({ method: "patch-equivalent" });
  });

  test("a lost patch ID is asked again instead of settling as a miss, so the branch is still pending", () => {
    const { remaining, reply, side } = report(1);
    expect(remaining).toBe(0);
    expect(reply).toEqual({
      errors: [],
      pending: [
        { headRevision: side, name: "side", proof: "patch-equivalent" },
      ],
    });
  });

  test("a patch ID lost twice is an error that keeps cleanup pending, never a settled miss", () => {
    const { remaining, reply, side } = report(2);
    expect(remaining).toBe(0);
    const { errors, pending } = reply as {
      errors: string[];
      pending: unknown[];
    };
    expect(pending).toEqual([]);
    expect(errors.join(" ")).toContain(
      `side at ${side}: its containment could not be checked`
    );
    expect(errors.join(" ")).toContain("was twice lost or cut short");
  });

  test("local cleanup's proof refuses after a retry instead of reading a lost patch ID as unmatched", () => {
    const { remaining, reply } = audit(2);
    expect(remaining).toBe(0);
    expect((reply as { error: string }).error).toContain(
      "was twice lost or cut short"
    );
    expect((reply as { error: string }).error).toContain("retry the command");
  });
});

describe("patch equivalence with a listing lost or cut short", () => {
  // side holds S1, which main cherry-picked, and S2, which it did not, so
  // the true answer is "not patch-equivalent". Every answer the audit
  // reads, lost or cut short twice, must refuse instead of settling either
  // way.
  const halfShippedFixture = () => {
    const { root } = repository();
    const base = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "--quiet", "-c", "side"]);
    for (const name of ["s1", "s2"]) {
      writeFixture(root, `${name}.txt`, `${name}\n`);
      git(root, ["add", `${name}.txt`]);
      git(root, ["commit", "--quiet", "-m", name]);
    }
    const side = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "--quiet", "main"]);
    writeFixture(root, "main.txt", "main\n");
    git(root, ["add", "main.txt"]);
    git(root, ["commit", "--quiet", "-m", "Main"]);
    git(root, ["cherry-pick", "side~1"]);
    const target = git(root, ["rev-parse", "HEAD"]);
    return { base, root, side, target };
  };

  type Setup = ReturnType<typeof halfShippedFixture>;

  // The target's two commits are read first, then S1, so S2's diff and
  // patch ID are the fourth of each.
  const listings: [string, (setup: Setup) => string, FakeGitLoss, number][] = [
    [
      "the merge base",
      (setup) => `merge-base ${setup.side} ${setup.target}`,
      "bytes:20",
      0,
    ],
    [
      "the commit count",
      (setup) => `rev-list --count ${setup.base}..${setup.side}`,
      "bytes:1",
      0,
    ],
    [
      "the target's commit listing",
      (setup) => `rev-list --reverse ${setup.base}..${setup.target}`,
      "first-line",
      0,
    ],
    [
      "the head's commit listing",
      (setup) => `rev-list --reverse ${setup.base}..${setup.side}`,
      "first-line",
      0,
    ],
    ["S2's diff", () => "--full-index", "lines:3", 3],
    ["S2's patch ID", () => "patch-id --stable", "bytes:10", 3],
  ];

  const audit = (
    flag: (setup: Setup) => string,
    lost: number,
    mode: FakeGitLoss,
    skip: number
  ) => {
    const setup = halfShippedFixture();
    return runInChild(
      `import { targetContainmentAudit } from ${JSON.stringify(libraryPath("cleanup-core.ts"))};
try {
  console.log(JSON.stringify({ method: targetContainmentAudit(${JSON.stringify(setup.root)}, ${JSON.stringify(setup.target)}, ${JSON.stringify(setup.side)}).method }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      flag(setup),
      lost,
      "",
      mode,
      skip
    );
  };

  test("with every answer kept, the half-shipped branch is not patch-equivalent (control)", () => {
    expect(audit(() => "rev-list --reverse", 0, "empty", 0).reply).toEqual({
      method: null,
    });
  });

  for (const loss of ["empty", "cut"] as const) {
    test.each(listings)(
      `%s ${loss === "empty" ? "lost" : "cut short"} twice refuses, never settled`,
      (_what, flag, cut, skip) => {
        const { remaining, reply } = audit(
          flag,
          2,
          loss === "empty" ? "empty" : cut,
          skip
        );
        expect(remaining).toBe(0);
        expect((reply as { error?: string }).error).toContain(
          "retry the command"
        );
      }
    );
  }
});

describe("local cleanup's patch proof with a diff cut short", () => {
  // The target carries part of the source commit: the same change to a.txt
  // without b.txt, or the same mode change to f without its new binary
  // contents. A source diff cut after that part has a valid patch ID equal
  // to the target commit's, which would prove unshipped work shipped.
  const audit = (change: "text" | "binary", lost: number) => {
    const fixture = repository();
    const { root } = fixture;
    if (change === "binary") {
      writeFileSync(join(root, "f"), Buffer.from([0, 1, 2]));
      git(root, ["add", "f"]);
      git(root, ["commit", "--quiet", "-m", "Add binary f"]);
    }
    git(root, ["switch", "--quiet", "-c", "source"]);
    if (change === "text") {
      writeFixture(root, "a.txt", "shipped\n");
      writeFixture(root, "b.txt", "unshipped\n");
      git(root, ["add", "a.txt", "b.txt"]);
    } else {
      writeFileSync(join(root, "f"), Buffer.from([0, 9, 9]));
      chmodSync(join(root, "f"), 0o755);
      git(root, ["add", "f"]);
    }
    git(root, ["commit", "--quiet", "-m", "Change the source"]);
    const source = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "--quiet", "main"]);
    writeFixture(root, "main.txt", "main\n");
    git(root, ["add", "main.txt"]);
    git(root, ["commit", "--quiet", "-m", "Main"]);
    if (change === "text") {
      writeFixture(root, "a.txt", "shipped\n");
      git(root, ["add", "a.txt"]);
    } else {
      chmodSync(join(root, "f"), 0o755);
      git(root, ["add", "f"]);
    }
    git(root, ["commit", "--quiet", "-m", "Ship part of it"]);
    const target = git(root, ["rev-parse", "HEAD"]);
    // The diff as the intercepted answer starts: the commit's ID line, then
    // its diff.
    const diff = git(root, [
      "diff-tree",
      "--patch",
      "--full-index",
      source,
    ]).split("\n");
    expect(diff[0]).toBe(source);
    // The lines of the part the target carries, from the ID line: through
    // a.txt's final line, or through f's new mode.
    const kept =
      change === "text"
        ? diff.findIndex((line) => line.startsWith("diff --git a/b.txt"))
        : diff.findIndex((line) => line.startsWith("new mode")) + 1;
    expect(kept).toBeGreaterThan(0);
    return runInChild(
      `import { targetContainmentAudit } from ${JSON.stringify(libraryPath("cleanup-core.ts"))};
try {
  console.log(JSON.stringify({ method: targetContainmentAudit(${JSON.stringify(root)}, ${JSON.stringify(target)}, ${JSON.stringify(source)}).method }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      SIDE_DIFF.flag,
      lost,
      "",
      `lines:${kept}`,
      SIDE_DIFF.skip
    );
  };

  for (const change of ["text", "binary"] as const) {
    test(`with every answer whole, the partly shipped ${change} commit is not patch-equivalent (control)`, () => {
      expect(audit(change, 0).reply).toEqual({ method: null });
    });

    test(`a ${change} diff cut short once is asked again, so the commit is still not patch-equivalent`, () => {
      const { remaining, reply } = audit(change, 1);
      expect(remaining).toBe(0);
      expect(reply).toEqual({ method: null });
    });

    test(`a ${change} diff cut short twice refuses instead of proving unshipped work shipped`, () => {
      const { remaining, reply } = audit(change, 2);
      expect(remaining).toBe(0);
      expect((reply as { error: string }).error).toContain(
        "was twice lost or cut short"
      );
      expect((reply as { error: string }).error).toContain("retry the command");
    });
  }
});

describe("a rev-list listing checked whole against its count", () => {
  const listing = (lost: number, mode: "empty" | "first-line") => {
    const fixture = repository();
    for (const name of ["one", "two", "three"]) {
      writeFixture(fixture.root, `${name}.txt`, `${name}\n`);
      git(fixture.root, ["add", `${name}.txt`]);
      git(fixture.root, ["commit", "--quiet", "-m", name]);
    }
    return runInChild(
      `import { completeRevisionList } from ${JSON.stringify(libraryPath("git-complete.ts"))};
try {
  console.log(JSON.stringify({ commits: completeRevisionList(${JSON.stringify(fixture.root)}, ["--reverse", "HEAD~3..HEAD"]).length }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, exitCode: error.exitCode }));
}
`,
      "rev-list --reverse",
      lost,
      "",
      mode
    );
  };

  test("a whole listing is returned (control)", () => {
    expect(listing(0, "empty").reply).toEqual({ commits: 3 });
  });

  test("a listing lost or cut short once is asked again", () => {
    for (const mode of ["empty", "first-line"] as const) {
      const { remaining, reply } = listing(1, mode);
      expect(remaining).toBe(0);
      expect(reply).toEqual({ commits: 3 });
    }
  });

  test("a listing lost or cut short twice refuses with a retryable error", () => {
    for (const mode of ["empty", "first-line"] as const) {
      const { remaining, reply } = listing(2, mode);
      expect(remaining).toBe(0);
      expect(reply).toMatchObject({ exitCode: 4 });
      expect((reply as { error: string }).error).toContain(
        "did not match its own count"
      );
    }
  });
});

describe("the cleanup report with a lost commit listing", () => {
  // side has two commits and only the first was cherry-picked onto main, so
  // the truth is "not finished": the patch audit must list both commits.
  const report = (lost: number) => {
    const fixture = repository();
    const { root } = fixture;
    const base = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "--quiet", "-c", "side"]);
    for (const name of ["one", "two"]) {
      writeFixture(root, `${name}.txt`, `${name}\n`);
      git(root, ["add", `${name}.txt`]);
      git(root, ["commit", "--quiet", "-m", `Side ${name}`]);
    }
    const side = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "--quiet", "main"]);
    writeFixture(root, "main.txt", "main\n");
    git(root, ["add", "main.txt"]);
    git(root, ["commit", "--quiet", "-m", "Main"]);
    git(root, ["cherry-pick", "side~1"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const snapshot = remotePages(
      "2026-10-21T10:00:00.000Z",
      [
        { headRevision: head, name: "main", protected: true },
        { headRevision: side, name: "side", protected: false },
      ],
      []
    );
    const { receipt } = buildRemoteInventory(snapshot, {
      opening: buildRemoteInventory(snapshot).receipt,
      resolveHolds: () => ({ byName: new Map(), byRevision: new Map() }),
    });
    return {
      side,
      ...runInChild(
        `import { remoteBranchCleanupReport } from ${JSON.stringify(libraryPath("remote-branch-prune.ts"))};
const result = remoteBranchCleanupReport({
  claims: [],
  inventory: ${inventoryFor(root)},
  openTargets: [],
  receipt: ${JSON.stringify(receipt)},
});
console.log(JSON.stringify({ errors: result.errors, pending: result.pending }));
`,
        // Only the listing of side's own commits, not the target's.
        `rev-list --reverse ${base}..${side}`,
        lost
      ),
    };
  };

  const expectNotFinished = (lost: number): void => {
    const { remaining, reply } = report(lost);
    expect(remaining).toBe(0);
    expect(reply).toEqual({ errors: [], pending: [] });
  };

  test("with every answer kept, the half-shipped branch is not pending (control)", () => {
    expectNotFinished(0);
  });

  test("a lost commit listing is asked again, so the branch never reads as fully matched", () => {
    expectNotFinished(1);
  });

  test("a commit listing lost twice is an error that keeps cleanup pending", () => {
    const { remaining, reply, side } = report(2);
    expect(remaining).toBe(0);
    const { errors, pending } = reply as {
      errors: string[];
      pending: unknown[];
    };
    expect(pending).toEqual([]);
    expect(errors.join(" ")).toContain(
      `side at ${side}: its containment could not be checked`
    );
    expect(errors.join(" ")).toContain("retry the command");
  });
});

// Git's own upstream of a live branch, fix/live: its remote and the
// remote's ref.
const UPSTREAM_FORMAT =
  "--format=%(upstream:remotename)%00%(upstream:remoteref)";
const LIVE_UPSTREAM = `${UPSTREAM_FORMAT} refs/heads/fix/live`;

describe("an upstream hold read from a lost upstream line", () => {
  // fix/live tracks origin/kept, which it holds by name, read from Git's
  // own upstream line.
  const holds = (lost: number) => {
    const fixture = repository();
    const { root } = fixture;
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    const path = join(fixture.base, "live");
    git(root, ["worktree", "add", "-b", "fix/live", path]);
    git(root, ["config", "branch.fix/live.remote", "origin"]);
    git(root, ["config", "branch.fix/live.merge", "refs/heads/kept"]);
    const inventory = JSON.parse(inventoryFor(root)) as {
      repository: { targetRemote: string | null };
    };
    inventory.repository.targetRemote = "origin";
    return runInChild(
      `import { remoteBranchNameHolds } from ${JSON.stringify(libraryPath("remote-branch-prune.ts"))};
try {
  const { byName } = remoteBranchNameHolds({
    claims: [],
    inventory: ${JSON.stringify(inventory)},
    targetBranch: "main",
    targetRevision: ${JSON.stringify(git(root, ["rev-parse", "HEAD"]))},
  });
  console.log(JSON.stringify({ kept: byName.get("kept") ?? [] }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      LIVE_UPSTREAM,
      lost
    );
  };

  const expectUpstreamHold = (lost: number): void => {
    const { remaining, reply } = holds(lost);
    expect(remaining).toBe(0);
    expect((reply as { kept: string[] }).kept.join(" ")).toContain(
      "upstream of fix/live"
    );
  };

  test("with every answer kept, the upstream holds (control)", () => {
    expectUpstreamHold(0);
  });

  test("a lost upstream line is asked again, so the upstream still holds", () => {
    expectUpstreamHold(1);
  });

  test("an upstream line lost twice for a branch that exists refuses instead of reading as no upstream", () => {
    const { remaining, reply } = holds(2);
    expect(remaining).toBe(0);
    expect((reply as { error: string }).error).toContain(
      "cannot read the upstream of fix/live"
    );
    expect((reply as { error: string }).error).toContain("retry the command");
  });
});

// The decisions below delete, prune, or keep work on one Git read each.
// Each read, lost or cut short once, is asked again; twice, it refuses or
// keeps the work, and never deletes, prunes, or proves anything.

const DAY = 86_400_000;

// Whether Git's answer, as the child reported it, refused with a retryable
// error.
const refusedForRetry = (reply: unknown): boolean =>
  typeof (reply as { error?: unknown }).error === "string" &&
  (reply as { error: string }).error.includes("retry the command");

describe("an archive re-check with a revert listing lost or cut short", () => {
  // An expired archive whose replacement shipped on main. With `revert`,
  // main then reverted it, so the archive must be kept for attention. An
  // empty revert listing is also what a lost answer looks like, which once
  // read as "no revert" and pruned the archive and its pins.
  const archiveFixture = (revert: boolean) => {
    const fixture = repository();
    const { base, root } = fixture;
    const common = realpathSync(
      git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    );
    writeFixture(root, "shipped.ts", "export const shipped = 1;\n");
    git(root, ["add", "shipped.ts"]);
    git(root, ["commit", "--quiet", "-m", "Ship the reviewed replacement"]);
    const replacement = git(root, ["rev-parse", "HEAD"]);
    const path = join(base, "archived");
    git(root, ["worktree", "add", "--quiet", "-b", "archived", path, "main"]);
    writeFixture(path, "work.ts", "export const work = 1;\n");
    git(path, ["add", "work.ts"]);
    git(path, ["commit", "--quiet", "-m", "Archived work"]);
    const headSha = git(path, ["rev-parse", "HEAD"]);
    const privateGitDirectory = realpathSync(
      git(path, ["rev-parse", "--absolute-git-dir"])
    );
    const createdAt = new Date(Date.now() - 20 * DAY);
    const archiveId = newArchiveId(createdAt, "a".repeat(64));
    const copy = copyWorktreeIntoArchive({
      archiveId,
      checkoutPath: path,
      commonGitDirectory: common,
      privateGitDirectory,
    });
    const namespace = archivePinNamespace(archiveId);
    const pinRefs = [
      { object: headSha, ref: `${namespace}/head` },
      { object: replacement, ref: `${namespace}/objects/${replacement}` },
    ];
    for (const pin of pinRefs) {
      git(root, ["update-ref", "--no-deref", pin.ref, pin.object]);
    }
    writeWorktreeArchiveManifest(copy.directory, {
      archiveId,
      branchConfig: [],
      checkout: copy.checkout,
      commonGitDirectory: common,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(Date.now() - 6 * DAY).toISOString(),
      gitDirectory: copy.gitDirectory,
      kind: "worktree-archive",
      pinRefs,
      privateGitDirectory,
      receiptDigest: "a".repeat(64),
      removalId: "lineage-12345678-1234-4234-8234-123456789abc",
      replacementCommits: [replacement],
      repositoryId: "c".repeat(64),
      retention: { days: 14, maxTotalBytes: DEFAULT_ARCHIVE_TOTAL_BYTES },
      schemaVersion: 1,
      source: {
        branch: "archived",
        changeDigest: "b".repeat(64),
        headSha,
        path,
      },
      targetRef: "main",
    });
    git(root, ["worktree", "remove", "--force", path]);
    git(root, ["branch", "--quiet", "-D", "archived"]);
    if (revert) {
      git(root, ["revert", "--no-edit", replacement]);
    }
    return { common, directory: copy.directory, pinRefs, replacement, root };
  };

  type Archive = ReturnType<typeof archiveFixture>;

  const prune = (
    archive: Archive,
    flag: string,
    lost: number,
    mode: FakeGitLoss = "empty"
  ) =>
    runInChild(
      `import { pruneWorktreeArchives } from ${JSON.stringify(libraryPath("worktree-archive.ts"))};
try {
  const result = pruneWorktreeArchives({
    command: "prune",
    commonGitDirectory: ${JSON.stringify(archive.common)},
    dryRun: false,
    now: new Date(),
    primaryCheckout: ${JSON.stringify(archive.root)},
    retention: { days: 14, maxTotalBytes: ${DEFAULT_ARCHIVE_TOTAL_BYTES} },
  });
  console.log(JSON.stringify({
    kept: result.keptForAttention.map((item) => item.reason),
    pruned: result.pruned.map((item) => item.archiveId),
  }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      flag,
      lost,
      "",
      mode
    );

  const expectWhole = (archive: Archive): void => {
    expect(existsSync(archive.directory)).toBe(true);
    for (const pin of archive.pinRefs) {
      expect(git(archive.root, ["rev-parse", pin.ref])).toBe(pin.object);
    }
  };

  const expectKeptForAttention = (
    archive: Archive,
    reply: unknown,
    reason: string
  ): void => {
    expect(reply).toMatchObject({ pruned: [] });
    expect((reply as { kept: string[] }).kept.join(" ")).toContain(reason);
    expectWhole(archive);
  };

  const REVERTS = "--fixed-strings";

  test("with every answer kept, the reverted archive is kept for attention and the other is pruned (control)", () => {
    const reverted = archiveFixture(true);
    const { remaining, reply } = prune(reverted, REVERTS, 0);
    expect(remaining).toBe(0);
    expectKeptForAttention(
      reverted,
      reply,
      `main reverts replacement ${reverted.replacement}`
    );
    const shipped = archiveFixture(false);
    expect(prune(shipped, REVERTS, 0).reply).toMatchObject({ kept: [] });
    expect(existsSync(shipped.directory)).toBe(false);
  });

  test("a revert listing lost or cut short once is asked again, so the reverted archive is still kept", () => {
    for (const mode of ["empty", "bytes:10"] as const) {
      const reverted = archiveFixture(true);
      const { remaining, reply } = prune(reverted, REVERTS, 1, mode);
      expect(remaining).toBe(0);
      expectKeptForAttention(
        reverted,
        reply,
        `main reverts replacement ${reverted.replacement}`
      );
    }
  });

  test("a revert listing and its count lost or cut short twice keep the archive for attention, never prune it", () => {
    for (const mode of ["empty", "bytes:10"] as const) {
      const reverted = archiveFixture(true);
      const { remaining, reply } = prune(reverted, REVERTS, 4, mode);
      expect(remaining).toBe(0);
      expectKeptForAttention(
        reverted,
        reply,
        `could not check whether main reverts replacement ${reverted.replacement}`
      );
      expect((reply as { kept: string[] }).kept.join(" ")).toContain(
        "retry the command"
      );
    }
  });

  // The other reads the prune rests on, for an archive the true answers
  // prune: the target's commit, and the listing of the archive's pins. A
  // pin listing lost entirely is not asked again: each pin it leaves out is
  // confirmed gone or present by exit code instead.
  const otherReads: [string, string, FakeGitLoss][] = [
    ["the target's commit", "main^{commit}", "bytes:20"],
    [
      "the archive's pins",
      "--format=%(refname)%00%(objectname)%00%(symref)",
      "bytes:30",
    ],
  ];

  for (const loss of ["empty", "cut"] as const) {
    test.each(otherReads)(
      `%s ${loss === "empty" ? "lost" : "cut short"} twice keeps the archive whole, never prunes it`,
      (_what, flag, cut) => {
        const archive = archiveFixture(false);
        const { remaining, reply } = prune(
          archive,
          flag,
          2,
          loss === "empty" ? "empty" : cut
        );
        expect(remaining).toBeLessThan(2);
        expect((reply as { pruned?: string[] }).pruned ?? []).toEqual([]);
        expectWhole(archive);
      }
    );
  }
});

// How Git 2.13 to 2.15 refuse the upstream atoms.
const OLDER_GIT_REFUSAL = {
  exitCode: 128,
  stderr: "fatal: unrecognized %(upstream) argument: remotename",
};

describe("an upstream hold read from a remote name or merge ref cut short", () => {
  // fix/live tracks kept on the target remote, which holds kept by name. A
  // remote name cut from `origin` to `ori`, a merge ref cut from
  // `refs/heads/kept` to `refs/heads/ke`, or an upstream line cut the same
  // way once read as another remote or another branch and dropped the
  // hold, which made the merged branch a deletion proposal. So would a
  // configuration listing cut at an entry's end before the merge value,
  // which an older Git without the upstream atoms reads instead.
  const holds = (
    flag: string,
    lost: number,
    cut: FakeGitLoss | "before-merge" = "empty",
    options: { failFlag?: string; remote?: string } = {}
  ) => {
    const fixture = repository();
    const { root } = fixture;
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, [
      "remote",
      "add",
      "upstream",
      "https://example.invalid/upstream.git",
    ]);
    const path = join(fixture.base, "live");
    git(root, ["worktree", "add", "-b", "fix/live", path]);
    git(root, ["config", "branch.fix/live.remote", options.remote ?? "origin"]);
    git(root, ["config", "branch.fix/live.merge", "refs/heads/kept"]);
    const inventory = JSON.parse(inventoryFor(root)) as {
      repository: { targetRemote: string | null };
    };
    inventory.repository.targetRemote = "origin";
    // The merge value is the last file entry, so a listing of one entry
    // fewer ends whole right before it, with the command-line entry gone.
    const entries = git(root, ["config", "--list"]).split("\n").length;
    return runInChild(
      `import { remoteBranchNameHolds } from ${JSON.stringify(libraryPath("remote-branch-prune.ts"))};
try {
  const { byName } = remoteBranchNameHolds({
    claims: [],
    inventory: ${JSON.stringify(inventory)},
    targetBranch: "main",
    targetRevision: ${JSON.stringify(git(root, ["rev-parse", "HEAD"]))},
  });
  console.log(JSON.stringify({ kept: byName.get("kept") ?? [] }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      flag,
      lost,
      options.failFlag ?? "",
      cut === "before-merge" ? `nul:${entries - 1}` : cut,
      0,
      // A failing upstream read is Git 2.15 refusing the atoms.
      options.failFlag ? "git version 2.15.4" : undefined,
      options.failFlag ? OLDER_GIT_REFUSAL : undefined
    );
  };

  const held = (reply: unknown): boolean =>
    ((reply as { kept?: string[] }).kept ?? [])
      .join(" ")
      .includes("upstream of fix/live");

  // The read, the Git call that answers it, and the cut that would read as
  // another remote or branch, or as no upstream. The configuration is read
  // when Git gives no upstream line, as a Git older than 2.16 does by
  // refusing the atoms.
  const reads: [string, string, FakeGitLoss | "before-merge", string][] = [
    ["the upstream line", LIVE_UPSTREAM, "bytes:3", ""],
    ["the upstream line without its line break", LIVE_UPSTREAM, "bytes:22", ""],
    ["the configuration", "--list", "before-merge", UPSTREAM_FORMAT],
  ];

  test.each(reads)(
    "with every answer kept, the upstream holds when %s is read (control)",
    (_what, flag, _cut, failFlag) => {
      const { remaining, reply } = holds(flag, 0, "empty", { failFlag });
      expect(remaining).toBe(0);
      expect(held(reply)).toBe(true);
    }
  );

  test.each(reads)(
    "%s cut short once is asked again, so the upstream still holds",
    (_what, flag, cut, failFlag) => {
      const { remaining, reply } = holds(flag, 1, cut, { failFlag });
      expect(remaining).toBe(0);
      expect(held(reply)).toBe(true);
    }
  );

  for (const loss of ["empty", "cut"] as const) {
    test.each(reads)(
      `%s ${loss === "empty" ? "lost" : "cut short"} twice refuses, never drops the hold`,
      (_what, flag, cut, failFlag) => {
        const { remaining, reply } = holds(
          flag,
          2,
          loss === "empty" ? "empty" : cut,
          { failFlag }
        );
        expect(remaining).toBe(0);
        expect(refusedForRetry(reply)).toBe(true);
      }
    );
  }

  test("a branch tracking a remote that is not configured holds its branch", () => {
    const unknown = holds("branch.fix/live.remote", 0, "empty", {
      remote: "elsewhere",
    });
    expect(held(unknown.reply)).toBe(true);
    // Control: another configured remote's branch, or this repository's,
    // is not the target's.
    for (const remote of ["upstream", "."]) {
      expect(
        holds("branch.fix/live.remote", 0, "empty", { remote }).reply
      ).toEqual({ kept: [] });
    }
  });

  test("the list of configured remotes lost or cut short twice refuses, never reads the remote as unknown or known", () => {
    for (const mode of ["empty", "bytes:3"] as const) {
      const once = holds("remote", 1, mode, { remote: "upstream" });
      expect(once.remaining).toBe(0);
      expect(once.reply).toEqual({ kept: [] });
      const twice = holds("remote", 2, mode, { remote: "upstream" });
      expect(twice.remaining).toBe(0);
      expect(refusedForRetry(twice.reply)).toBe(true);
    }
  });
});

describe("the local target branch with a lost or cut remote answer", () => {
  // origin/main stands for local main, which cleanup never removes. A lost
  // listing of remotes once read origin/main as a local branch name, which
  // left main unprotected.
  const targetBranch = (lost: number, mode: FakeGitLoss) => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/repo.git",
    ]);
    return runInChild(
      `import { localBranchForTargetRef } from ${JSON.stringify(libraryPath("cleanup-core.ts"))};
try {
  console.log(JSON.stringify({ branch: localBranchForTargetRef(${JSON.stringify(fixture.root)}, "origin/main") }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      "remote",
      lost,
      "",
      mode
    );
  };

  test("with every answer kept, origin/main stands for main (control)", () => {
    expect(targetBranch(0, "empty").reply).toEqual({ branch: "main" });
  });

  test("a remote answer lost once is asked again, and lost twice refuses, never reading origin/main as a local branch", () => {
    const once = targetBranch(1, "empty");
    expect(once.remaining).toBe(0);
    expect(once.reply).toEqual({ branch: "main" });
    const twice = targetBranch(2, "empty");
    expect(twice.remaining).toBe(0);
    expect(refusedForRetry(twice.reply)).toBe(true);
  });

  test("a remote answer cut short still names origin as a remote, by its exit code", () => {
    const { remaining, reply } = targetBranch(2, "bytes:3");
    expect(remaining).toBeLessThan(2);
    expect(reply).toEqual({ branch: "main" });
  });
});

describe("cleanup's target revision lost or cut short", () => {
  // `done` is a clean checkout main already contains, so prune removes it,
  // judged against the target's commit ID.
  const pruneDone = (lost: number, mode: FakeGitLoss) => {
    const fixture = repository();
    const path = join(fixture.base, "done");
    git(fixture.root, ["worktree", "add", "--quiet", "-b", "done", path]);
    return {
      path,
      ...runInChild(
        `import { pruneRepository } from ${JSON.stringify(libraryPath("worktree-maintenance.ts"))};
try {
  const report = pruneRepository({
    approvedBy: "the-user",
    dryRun: false,
    reason: "Clean up finished work.",
    repositoryPath: ${JSON.stringify(fixture.root)},
  });
  console.log(JSON.stringify({ removed: report.removed.map((item) => item.path) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
        "main^{commit}",
        lost,
        "",
        mode
      ),
    };
  };

  test("with every answer kept, the contained checkout is removed (control)", () => {
    const { path, reply } = pruneDone(0, "empty");
    expect(reply).toEqual({ removed: [path] });
  });

  test("the target's commit lost or cut short twice refuses, never removes anything", () => {
    for (const mode of ["empty", "bytes:20"] as const) {
      const { path, remaining, reply } = pruneDone(2, mode);
      expect(remaining).toBe(0);
      expect(refusedForRetry(reply)).toBe(true);
      expect(existsSync(path)).toBe(true);
    }
  });
});

describe("primary normalization with index flags lost or cut short", () => {
  // Finalization restores a dirty primary path to HEAD when its file
  // already has the target's bytes and its index entry is ordinary. A
  // skip-worktree entry makes Git compare the index instead of the file,
  // so `local edits` look like the target's bytes; the flags read from
  // `ls-files --debug` must show that, and a flags answer lost or cut
  // short must keep the file rather than read as ordinary.
  const normalize = (
    skipWorktree: boolean,
    lost: number,
    mode: FakeGitLoss = "empty"
  ) => {
    const fixture = repository();
    const { root } = fixture;
    writeFixture(root, "f.txt", "v1\n");
    git(root, ["add", "f.txt"]);
    git(root, ["commit", "--quiet", "-m", "Add f"]);
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, ["checkout", "--quiet", "--detach"]);
    writeFixture(root, "f.txt", "v2\n");
    git(root, ["commit", "--quiet", "-am", "Ship v2"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    git(root, ["checkout", "--quiet", "main"]);
    const lease = startLoop(root, "controller", "integrate");
    if (skipWorktree) {
      const blob = git(root, ["rev-parse", "origin/main:f.txt"]);
      git(root, ["update-index", "--cacheinfo", `100644,${blob},f.txt`]);
      git(root, ["update-index", "--skip-worktree", "f.txt"]);
      writeFixture(root, "f.txt", "local edits\n");
    } else {
      writeFixture(root, "f.txt", "v2\n");
    }
    const { remaining, reply } = runInChild(
      `import { finalizeLoop } from ${JSON.stringify(libraryPath("loop-lease.ts"))};
try {
  const result = finalizeLoop(${JSON.stringify(root)}, ${JSON.stringify(lease.runId)}, "controller", "The work is in the target.");
  console.log(JSON.stringify({ cleaned: result.cleanup.cleanedPrimaryPaths }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      "--debug",
      lost,
      "",
      mode
    );
    return {
      bytes: readFileSync(join(root, "f.txt"), "utf8"),
      remaining,
      reply,
    };
  };

  test("with every answer kept, an ordinary path with the target's bytes is normalized (control)", () => {
    const { reply } = normalize(false, 0);
    expect(reply).toEqual({ cleaned: ["f.txt"] });
  });

  test("a skip-worktree path keeps its local edits, which Git compared as the target's bytes", () => {
    const { bytes, reply } = normalize(true, 0);
    expect(reply).toEqual({ cleaned: [] });
    expect(bytes).toBe("local edits\n");
  });

  test("index flags lost or cut short twice keep the path, never read it as ordinary", () => {
    for (const skipWorktree of [false, true]) {
      for (const mode of ["empty", "lines:3"] as const) {
        const { bytes, remaining, reply } = normalize(skipWorktree, 2, mode);
        expect(remaining).toBe(0);
        expect(reply).toEqual({ cleaned: [] });
        expect(bytes).toBe(skipWorktree ? "local edits\n" : "v2\n");
      }
    }
  });
});

describe("a reviewed replacement removal with a lineage read lost or cut short", () => {
  // source-unit's two commits shipped on main as reviewed replacements with
  // other patch IDs, so a lineage receipt removes it, archived. Each read
  // below decides what the archive keeps or whether the branch may go.
  // The sibling checkout `source` has a private Git directory whose name is
  // a prefix of the source's, and work of its own, so cleanup keeps it.
  const lineage = () => {
    const fixture = repository();
    const { base, root } = fixture;
    const sibling = join(base, "source");
    git(root, ["worktree", "add", "--quiet", "-b", "sibling", sibling]);
    writeFixture(sibling, "sibling.ts", "export const sibling = 1;\n");
    git(sibling, ["add", "."]);
    git(sibling, ["commit", "--quiet", "-m", "Sibling work"]);
    const path = join(base, "source-unit");
    git(root, ["worktree", "add", "--quiet", "-b", "source-unit", path]);
    for (const name of ["a", "b"]) {
      writeFixture(path, `${name}.ts`, `export const ${name} = 1;\n`);
      git(path, ["add", "."]);
      git(path, ["commit", "--quiet", "-m", `Add ${name}`]);
    }
    const commits = git(path, ["rev-list", "--reverse", "main..HEAD"]).split(
      "\n"
    );
    const headSha = git(path, ["rev-parse", "HEAD"]);
    // What the archive must keep besides the head: an object a pseudo-ref
    // and one the checkout's own refs name, and the branch's configuration.
    git(path, ["update-ref", "ORIG_HEAD", commits[0] ?? ""]);
    git(path, ["update-ref", "refs/worktree/kept", commits[0] ?? ""]);
    git(root, ["config", "branch.source-unit.description", "Reviewed work"]);
    const replacements: string[] = [];
    for (const name of ["a", "b"]) {
      writeFixture(root, `${name}.ts`, `export const ${name} = 2;\n`);
      git(root, ["add", "."]);
      git(root, ["commit", "--quiet", "-m", `Ship reviewed ${name}`]);
      replacements.push(git(root, ["rev-parse", "HEAD"]));
    }
    const now = Date.now();
    const receipt = {
      approval: {
        approvalReference: "chat message approving removal",
        approvedAt: new Date(now - 5 * 60_000).toISOString(),
        approvedBy: "the-user",
        reason: "The source shipped through reviewed replacements.",
      },
      commits: commits.map((sourceCommit, index) => ({
        replacementCommits: [replacements[index] ?? ""],
        sourceCommit,
      })),
      kind: "replacement-lineage-receipt",
      review: {
        decision: "replaced-in-target",
        reviewedAt: new Date(now - 10 * 60_000).toISOString(),
        reviewerAgentId: "reviewer-agent",
        reviewReference: "review log for the source range",
      },
      schemaVersion: 1,
      source: {
        authorAgentId: "author-agent",
        branch: "source-unit",
        changeDigest:
          captureInventory(root).worktrees.find(
            (worktree) => worktree.path === path
          )?.changeDigest ?? "",
        headRevision: headSha,
        path,
      },
      targetRef: "main",
      targetRevision: git(root, ["rev-parse", "HEAD"]),
    };
    // Cut five bytes short, the source's private Git directory names the
    // sibling's.
    const privateDirectory = git(path, ["rev-parse", "--absolute-git-dir"]);
    return { path, privateDirectory, receipt, root };
  };

  type Lineage = ReturnType<typeof lineage>;

  const remove = (
    setup: Lineage,
    flag: string,
    lost: number,
    mode: FakeGitLoss
  ) =>
    runInChild(
      `import { pruneRepository } from ${JSON.stringify(libraryPath("worktree-maintenance.ts"))};
try {
  const report = pruneRepository({
    agentId: "controller-agent",
    approvedBy: "the-user",
    dryRun: false,
    lineageReceipt: ${JSON.stringify(setup.receipt)},
    reason: "Remove the reviewed obsolete source.",
    repositoryPath: ${JSON.stringify(setup.root)},
  });
  console.log(JSON.stringify({
    branchDeleted: report.reviewedReplacement?.branchDeleted ?? false,
    errors: report.errors,
    removed: report.reviewedReplacement?.worktreeRemoved ?? false,
  }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      flag,
      lost,
      "",
      mode
    );

  const branchExists = (setup: Lineage): boolean =>
    git(setup.root, ["branch", "--list", "source-unit"]) !== "";

  const expectNothingRemoved = (setup: Lineage, reply: unknown): void => {
    expect(refusedForRetry(reply)).toBe(true);
    expect(existsSync(setup.path)).toBe(true);
    expect(branchExists(setup)).toBe(true);
    expect(
      git(setup.root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/simple-changes/",
      ])
    ).toBe("");
  };

  test("with every answer kept, the source is archived and removed with its branch (control)", () => {
    const setup = lineage();
    const { reply } = remove(setup, "rev-parse --absolute-git-dir", 0, "empty");
    expect(reply).toMatchObject({ branchDeleted: true, removed: true });
    expect(existsSync(setup.path)).toBe(false);
  });

  // The read, the Git call that answers it, and a cut that still parses
  // into an answer that once let the removal go on.
  const reads: [string, string, (setup: Lineage) => FakeGitLoss][] = [
    [
      "the checkout's private Git directory",
      "rev-parse --absolute-git-dir",
      (setup) => `bytes:${setup.privateDirectory.length - "-unit".length}`,
    ],
    ["ORIG_HEAD", "--verify --quiet ORIG_HEAD", () => "bytes:20"],
    ["the branch's configuration", "-z --get-regexp", () => "bytes:20"],
  ];

  test.each(reads)(
    "%s cut short once is asked again, so the removal goes on whole",
    (_what, flag, cut) => {
      const setup = lineage();
      const { remaining, reply } = remove(setup, flag, 1, cut(setup));
      expect(remaining).toBe(0);
      expect(reply).toMatchObject({ branchDeleted: true, removed: true });
    }
  );

  for (const loss of ["empty", "cut"] as const) {
    test.each(reads)(
      `%s ${loss === "empty" ? "lost" : "cut short"} twice refuses before anything is written`,
      (_what, flag, cut) => {
        const setup = lineage();
        const { remaining, reply } = remove(
          setup,
          flag,
          2,
          loss === "empty" ? "empty" : cut(setup)
        );
        expect(remaining).toBe(0);
        expectNothingRemoved(setup, reply);
      }
    );
  }

  test("the checkout's own refs cut inside a line twice refuse before anything is written", () => {
    // Git gives no count for this listing, so only a cut inside a line,
    // which would drop the object as unparsable, can be seen.
    const setup = lineage();
    const { remaining, reply } = remove(
      setup,
      "--format=%(refname)%00%(objectname)",
      2,
      "bytes:30"
    );
    expect(remaining).toBe(0);
    expectNothingRemoved(setup, reply);
  });

  test("where the branch is checked out, lost twice, keeps the branch after the archived removal", () => {
    const setup = lineage();
    const { remaining, reply } = remove(
      setup,
      "--format=%(worktreepath)",
      2,
      "empty"
    );
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({ branchDeleted: false, removed: true });
    expect((reply as { errors: string[] }).errors.join(" ")).toContain(
      "Kept branch source-unit"
    );
    expect(branchExists(setup)).toBe(true);
  });
});

describe("inventory listings cut inside an entry", () => {
  // Every cleanup decision starts from the inventory's worktree records and
  // branch lines. A record cut before its branch line read a checkout as
  // detached, which dropped the hold its branch gives; a branch line cut
  // before its worktree path read a checked-out branch as free to delete.
  const liveHold = (lost: number, mode: FakeGitLoss) => {
    const fixture = repository();
    const path = join(fixture.base, "live");
    git(fixture.root, ["worktree", "add", "--quiet", "-b", "fix/live", path]);
    return runInChild(
      `import { captureInventory } from ${JSON.stringify(libraryPath("inventory.ts"))};
import { remoteBranchNameHolds } from ${JSON.stringify(libraryPath("remote-branch-prune.ts"))};
try {
  const inventory = captureInventory(${JSON.stringify(fixture.root)}, { skipWorktreeStatus: true });
  const { byName } = remoteBranchNameHolds({
    claims: [],
    inventory,
    targetBranch: "main",
    targetRevision: ${JSON.stringify(git(fixture.root, ["rev-parse", "HEAD"]))},
  });
  console.log(JSON.stringify({ held: byName.get("fix/live") ?? [] }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      "list --porcelain",
      lost,
      "",
      mode
    );
  };

  // The primary's record is four lines with its blank line, so six lines
  // stop after the live checkout's HEAD, before its branch.
  const RECORD_CUT = "lines:6";

  test("with every answer kept, the checked-out branch is held (control)", () => {
    const { reply } = liveHold(0, "empty");
    expect((reply as { held: string[] }).held.join(" ")).toContain(
      "checked out in"
    );
  });

  test("a worktree record cut short once is asked again, so the branch is still held", () => {
    const { remaining, reply } = liveHold(1, RECORD_CUT);
    expect(remaining).toBe(0);
    expect((reply as { held: string[] }).held.join(" ")).toContain(
      "checked out in"
    );
  });

  test("worktree records lost or cut short twice refuse, never drop the hold", () => {
    for (const mode of ["empty", RECORD_CUT] as const) {
      const { remaining, reply } = liveHold(2, mode);
      expect(remaining).toBe(0);
      expect(refusedForRetry(reply)).toBe(true);
    }
  });

  // Issue #27: a listing cut right after the primary's whole record still
  // ends whole, so it once left the unclaimed checkout out, and its merged
  // branch became a deletion proposal. The branch listing still names the
  // checkout, so the two disagree and every proposal is withheld.
  test("worktree records cut between two whole records withhold every proposal, never drop the hold", () => {
    const fixture = repository();
    const { root } = fixture;
    const path = join(fixture.base, "live");
    git(root, ["worktree", "add", "--quiet", "-b", "fix/live", path]);
    writeFixture(path, "work.txt", "work\n");
    git(path, ["add", "work.txt"]);
    git(path, ["commit", "--quiet", "-m", "Work"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const liveHead = git(path, ["rev-parse", "HEAD"]);
    const branches = [
      { headRevision: head, name: "main", protected: true },
      { headRevision: liveHead, name: "fix/live", protected: false },
    ];
    const proposal = (state: RemoteProposal["state"]): RemoteProposal => ({
      headRevision: liveHead,
      objectId: "51",
      sourceBranch: "fix/live",
      state,
    });
    const opening = buildRemoteInventory(
      remotePages("2026-10-21T10:00:00.000Z", branches, [proposal("open")])
    ).receipt;
    const final = remotePages("2026-10-21T11:00:00.000Z", branches, [
      proposal("merged"),
    ]);
    const build = (lost: number) =>
      runInChild(
        `import { captureInventory } from ${JSON.stringify(libraryPath("inventory.ts"))};
import { remoteBranchHolds } from ${JSON.stringify(libraryPath("remote-branch-prune.ts"))};
import { buildRemoteInventory } from ${JSON.stringify(libraryPath("remote-inventory.ts"))};
const built = buildRemoteInventory(${JSON.stringify(final)}, {
  opening: ${JSON.stringify(opening)},
  resolveHolds: (targetBranch, targetRevision) =>
    remoteBranchHolds({
      claims: [],
      inventory: captureInventory(${JSON.stringify(root)}, { skipWorktreeStatus: true }),
      targetBranch,
      targetRevision,
    }),
});
console.log(JSON.stringify({
  held: built.summary.heldBranches.map((branch) => branch.reasons.join(" ")),
  proposed: built.summary.deletionProposals.map((branch) => branch.name),
}));
`,
        "list --porcelain",
        lost,
        "",
        "lines:4"
      );
    expect(build(0).reply).toEqual({
      held: [`checked out in ${path}`],
      proposed: [],
    });
    const { remaining, reply } = build(1);
    expect(remaining).toBe(0);
    const { held, proposed } = reply as { held: string[]; proposed: string[] };
    expect(proposed).toEqual([]);
    expect(held.join(" ")).toContain(
      `the branch listing has fix/live checked out in ${path}, but the worktree listing does not`
    );
    expect(held.join(" ")).toContain("retry the command");
  });

  const BRANCH_FORMAT =
    "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(worktreepath)%00%(HEAD)";

  // zz-busy is checked out in a dirty checkout, so prune keeps both; its
  // line sorts last, and the cut stops it right after its commit ID.
  const pruneBusy = (lost: number, cut: boolean) => {
    const fixture = repository();
    const { root } = fixture;
    const path = join(fixture.base, "busy");
    git(root, ["worktree", "add", "--quiet", "-b", "zz-busy", path]);
    writeFixture(path, "draft.txt", "uncommitted\n");
    const listing = git(root, ["for-each-ref", BRANCH_FORMAT, "refs/heads"]);
    const last = listing.slice(listing.lastIndexOf("\n") + 1);
    const [name = "", sha = ""] = last.split("\0");
    const kept = listing.length - last.length + name.length + sha.length + 2;
    const { remaining, reply } = runInChild(
      `import { pruneRepository } from ${JSON.stringify(libraryPath("worktree-maintenance.ts"))};
try {
  const report = pruneRepository({
    approvedBy: "the-user",
    dryRun: false,
    reason: "Clean up finished work.",
    repositoryPath: ${JSON.stringify(root)},
  });
  console.log(JSON.stringify({ removedBranches: report.removedBranches.map((item) => item.branch) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`,
      BRANCH_FORMAT,
      lost,
      "",
      cut ? `bytes:${kept}` : "empty"
    );
    return {
      exists: git(root, ["branch", "--list", "zz-busy"]) !== "",
      remaining,
      reply,
    };
  };

  test("with every answer kept, the checked-out branch is kept (control)", () => {
    const { exists, reply } = pruneBusy(0, false);
    expect(reply).toEqual({ removedBranches: [] });
    expect(exists).toBe(true);
  });

  test("a branch line cut short once is asked again, so the checked-out branch is kept", () => {
    const { exists, remaining, reply } = pruneBusy(1, true);
    expect(remaining).toBe(0);
    expect(reply).toEqual({ removedBranches: [] });
    expect(exists).toBe(true);
  });

  test("branch lines lost or cut short twice never delete the checked-out branch", () => {
    const lost = pruneBusy(2, false);
    expect(lost.exists).toBe(true);
    expect(
      (lost.reply as { removedBranches?: string[] }).removedBranches ?? []
    ).toEqual([]);
    const cut = pruneBusy(2, true);
    expect(cut.remaining).toBe(0);
    expect(refusedForRetry(cut.reply)).toBe(true);
    expect(cut.exists).toBe(true);
  });
});
