import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  buildRemoteInventory,
  type RemoteInventoryPages,
} from "../../../skills/simple-changes/scripts/lib/remote-inventory.ts";
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
  version?: string
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
    },
    (cleanup) => cleanups.push(cleanup)
  );

describe("exact-byte target proof with a lost Git answer", () => {
  // The author's tip changes a.txt, and the target holds a different a.txt,
  // so the true answer is a refusal naming a.txt.
  const differingFixture = () => {
    const fixture = repository();
    const base = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["switch", "--quiet", "-c", "author"]);
    writeFixture(fixture.root, "a.txt", "alpha\n");
    git(fixture.root, ["add", "a.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Author a"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["switch", "--quiet", "main"]);
    writeFixture(fixture.root, "a.txt", "beta\n");
    git(fixture.root, ["add", "a.txt"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Target a"]);
    const target = git(fixture.root, ["rev-parse", "HEAD"]);
    return { base, head, root: fixture.root, target };
  };

  const prove = (flag: string, lost: number) => {
    const setup = differingFixture();
    return runInChild(
      `import { proveExactByteTargetContainment } from ${JSON.stringify(libraryPath("exact-byte-proof.ts"))};
console.log(JSON.stringify(proveExactByteTargetContainment(${JSON.stringify(setup.root)}, {
  sourceHead: ${JSON.stringify(setup.head)},
  targetRevision: ${JSON.stringify(setup.target)},
})));
`,
      flag,
      lost
    );
  };

  test("with every answer kept, the differing path refuses (control)", () => {
    const { remaining, reply } = prove("--reverse", 0);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({
      differingPaths: ["a.txt"],
      status: "refused",
    });
  });

  test.each([
    ["the commit listing", "--reverse", "listed no commits"],
    [
      "a commit's touched paths",
      "--no-commit-id",
      "listed no paths for commit",
    ],
    ["the tip-to-target difference", "--no-ext-diff", "but they differ"],
  ])("a lost answer for %s refuses instead of proving", (_what, flag, text) => {
    const { remaining, reply } = prove(flag, 1);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({ status: "refused" });
    const { reason } = reply as { reason: string };
    expect(reason).toContain(text);
    expect(reason).toContain("retry the command");
  });
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
  const entry = (path: string, lost: number) => {
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
      lost
    );
  };

  test("with every answer kept, a present path has its entry and an absent one none (control)", () => {
    const present = entry("a.txt", 0);
    expect(present.remaining).toBe(0);
    expect((present.reply as { entry: string }).entry).toMatch(ENTRY_PATTERN);
    expect(entry("missing.txt", 0).reply).toEqual({ entry: null });
  });

  test("a lost listing for a present path refuses instead of reading it as absent", () => {
    const { remaining, reply } = entry("a.txt", 1);
    expect(remaining).toBe(0);
    expect(reply).toMatchObject({ exitCode: 4 });
    expect((reply as { error: string }).error).toContain(
      "its answer was lost; retry the command"
    );
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
      `import { countedRevisionList } from ${JSON.stringify(libraryPath("process.ts"))};
try {
  console.log(JSON.stringify({ commits: countedRevisionList(${JSON.stringify(fixture.root)}, ["--reverse", "HEAD~3..HEAD"]).length }));
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

describe("an upstream hold read from a lost upstream line", () => {
  // fix/live tracks origin/kept, which it holds by name. The branch's remote
  // cannot be read from its configuration, so the hold comes from the
  // branch's upstream line instead.
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
      "--format=%(upstream)",
      lost,
      "branch.fix/live.remote"
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
