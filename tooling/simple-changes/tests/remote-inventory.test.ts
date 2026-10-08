import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { fetchGitLabRemoteInventory } from "../../../skills/simple-changes/scripts/adapters/gitlab-remote-inventory.ts";
import {
  remoteInventoryDigest,
  splitRemoteBranchReconciliationInput,
  validateOpeningRemoteInventory,
  validateRemoteBranchReconciliation,
} from "../../../skills/simple-changes/scripts/lib/remote-branch-reconciliation.ts";
import {
  buildRemoteInventory,
  type RemoteInventoryPages,
} from "../../../skills/simple-changes/scripts/lib/remote-inventory.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(30_000);

const SHA = {
  closed: "c".repeat(40),
  feature: "f".repeat(40),
  gone: "9".repeat(40),
  merged: "d".repeat(40),
  moved: "e".repeat(40),
  newcomer: "1".repeat(40),
  release: "2".repeat(40),
  target: "a".repeat(40),
  targetNext: "b".repeat(40),
};

const sha256 = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const openingPages = (): RemoteInventoryPages => ({
  branchPages: [
    {
      branches: [
        { headRevision: SHA.target, name: "main", protected: true },
        { headRevision: SHA.feature, name: "feat/open", protected: false },
      ],
      cursorIn: null,
      cursorOut: "2",
    },
    {
      branches: [
        { headRevision: SHA.closed, name: "old/closed", protected: false },
        { headRevision: SHA.release, name: "release/1", protected: true },
        { headRevision: SHA.merged, name: "fix/merged", protected: false },
      ],
      cursorIn: "2",
      cursorOut: null,
    },
  ],
  observedAt: "2026-10-08T10:00:00.000Z",
  project: "group/project",
  proposalPages: [
    {
      cursorIn: null,
      cursorOut: "2",
      proposals: [
        {
          headRevision: SHA.feature,
          objectId: "1",
          sourceBranch: "feat/open",
          state: "open",
        },
        {
          headRevision: SHA.gone,
          objectId: "2",
          sourceBranch: "deleted/long-ago",
          state: "merged",
        },
      ],
    },
    {
      cursorIn: "2",
      cursorOut: null,
      proposals: [
        {
          headRevision: SHA.closed,
          objectId: "3",
          sourceBranch: "old/closed",
          state: "closed",
        },
        {
          headRevision: SHA.merged,
          objectId: "4",
          sourceBranch: "fix/merged",
          state: "open",
        },
      ],
    },
  ],
  provider: "gitlab",
  schemaVersion: 1,
  targetBranch: "main",
});

// The provider merged MR !4 at its opening head and deleted fix/merged; main
// moved, feat/open moved, and a new branch arrived.
const finalPages = (): RemoteInventoryPages => ({
  branchPages: [
    {
      branches: [
        { headRevision: SHA.targetNext, name: "main", protected: true },
        { headRevision: SHA.moved, name: "feat/open", protected: false },
        { headRevision: SHA.closed, name: "old/closed", protected: false },
        { headRevision: SHA.release, name: "release/1", protected: true },
        { headRevision: SHA.newcomer, name: "feat/new", protected: false },
      ],
      cursorIn: null,
      cursorOut: null,
    },
  ],
  observedAt: "2026-10-08T11:00:00.000Z",
  project: "group/project",
  proposalPages: [
    {
      cursorIn: null,
      cursorOut: null,
      proposals: [
        {
          headRevision: SHA.moved,
          objectId: "1",
          sourceBranch: "feat/open",
          state: "open",
        },
        {
          headRevision: SHA.gone,
          objectId: "2",
          sourceBranch: "deleted/long-ago",
          state: "merged",
        },
        {
          headRevision: SHA.closed,
          objectId: "3",
          sourceBranch: "old/closed",
          state: "closed",
        },
        {
          headRevision: SHA.merged,
          objectId: "4",
          sourceBranch: "fix/merged",
          state: "merged",
        },
      ],
    },
  ],
  provider: "gitlab",
  schemaVersion: 1,
  targetBranch: "main",
});

describe("remote-inventory build", () => {
  test("computes the opening cursors, accounted counts, and ledger digests the validator checks", () => {
    const { receipt, phase, summary } = buildRemoteInventory(openingPages());

    expect(phase).toBe("opening");
    expect(validateOpeningRemoteInventory(receipt)).toEqual(receipt);
    expect(receipt.targetRevision).toBe(SHA.target);
    expect(receipt.initialCoverage).toEqual(receipt.finalCoverage);
    expect(receipt.initialCoverage.branches.pages).toEqual([
      {
        cursorIn: null,
        cursorOut: "2",
        itemCount: 2,
        responseDigest: sha256(openingPages().branchPages[0]?.branches),
      },
      {
        cursorIn: "2",
        cursorOut: null,
        itemCount: 3,
        responseDigest: sha256(openingPages().branchPages[1]?.branches),
      },
    ]);
    // MR !2's branch is gone, so its page accounts one proposal, not two.
    expect(
      receipt.initialCoverage.proposals.pages.map((page) => page.itemCount)
    ).toEqual([1, 2]);
    const branchEntries = receipt.branches.map((branch) => ({
      headRevision: branch.initialHeadRevision,
      name: branch.name,
    }));
    expect(receipt.initialCoverage.branches.ledgerDigest).toBe(
      sha256({
        entryDigest: sha256(branchEntries),
        pageDigests: receipt.initialCoverage.branches.pages.map(
          (page) => page.responseDigest
        ),
      })
    );
    expect(
      Object.fromEntries(
        receipt.branches.map((branch) => [
          branch.name,
          `${branch.classification}/${branch.disposition}`,
        ])
      )
    ).toEqual({
      "feat/open": "open-proposal/preserved-open-proposal",
      "fix/merged": "open-proposal/preserved-open-proposal",
      main: "canonical-target/preserved-target",
      "old/closed": "ambiguous/preserved-ambiguous",
      "release/1": "protected/preserved-protected",
    });
    expect(summary).toMatchObject({ branches: 5, proposals: 3 });
  });

  test("builds the final ledger over both inventories from the exact opening", () => {
    const opening = buildRemoteInventory(openingPages()).receipt;
    const { receipt, summary } = buildRemoteInventory(finalPages(), {
      opening,
    });
    const split = splitRemoteBranchReconciliationInput(receipt);
    const validated = validateRemoteBranchReconciliation(
      split.receipt,
      split.ancestryProofs,
      split.supersessions
    );

    expect(remoteInventoryDigest(validated, "initial")).toBe(
      remoteInventoryDigest(opening, "final")
    );
    expect(receipt.initialCoverage).toEqual(opening.initialCoverage);
    expect(receipt.targetRevision).toBe(SHA.targetNext);
    expect(summary).toMatchObject({
      arrivedBranches: ["feat/new"],
      deletedBranches: ["fix/merged"],
      movedBranches: ["feat/open"],
    });
    const byName = new Map(
      receipt.branches.map((branch) => [branch.name, branch])
    );
    expect(byName.get("fix/merged")).toMatchObject({
      classification: "merged-obsolete",
      disposition: "deleted-merged",
      finalHeadRevision: null,
      obsoleteProof: "merged-proposal-head",
      proposals: [
        {
          headRevision: SHA.merged,
          objectId: "4",
          observedFinally: false,
          state: "open",
        },
        {
          headRevision: SHA.merged,
          objectId: "4",
          observedInitially: false,
          state: "merged",
        },
      ],
    });
    expect(byName.get("feat/open")).toMatchObject({
      classification: "ambiguous",
      disposition: "preserved-ambiguous",
      initialHeadRevision: SHA.feature,
    });
    expect(byName.get("feat/new")).toMatchObject({
      classification: "ambiguous",
      initialHeadRevision: null,
    });
    // Opening branches keep their opening order; the arrival comes last.
    expect(receipt.branches.map((branch) => branch.name)).toEqual([
      ...opening.branches.map((branch) => branch.name),
      "feat/new",
    ]);
  });

  test("adds merged-head ancestry for a proposal merged after a fast-forward", () => {
    const opening = buildRemoteInventory(openingPages()).receipt;
    const final = finalPages();
    const merged = final.proposalPages[0]?.proposals.find(
      (proposal) => proposal.objectId === "4"
    );
    if (!merged) {
      throw new Error("missing fixture proposal");
    }
    merged.headRevision = SHA.targetNext;

    const entry = buildRemoteInventory(final, {
      opening,
    }).receipt.branches.find((branch) => branch.name === "fix/merged");

    expect(entry?.mergedHeadAncestry).toEqual({
      initialHeadRevision: SHA.merged,
      mergedHeadRevision: SHA.targetNext,
      proposalObjectId: "4",
    });
  });

  test("refuses an unproven deletion until a decision names its proof", () => {
    const opening = buildRemoteInventory(openingPages()).receipt;
    const final = finalPages();
    const [page] = final.branchPages;
    if (!page) {
      throw new Error("missing fixture page");
    }
    page.branches = page.branches.filter(
      (branch) => branch.name !== "old/closed"
    );

    expect(() => buildRemoteInventory(final, { opening })).toThrow(
      "old/closed (opening head"
    );
    const decided = buildRemoteInventory(final, {
      decisions: {
        deletedBranches: [
          {
            evidence: ["git merge-base --is-ancestor proves containment."],
            name: "old/closed",
            obsoleteProof: "target-contains-head",
          },
        ],
        schemaVersion: 1,
      },
      opening,
    });
    expect(
      decided.receipt.branches.find((branch) => branch.name === "old/closed")
    ).toMatchObject({
      classification: "closed-unmerged",
      disposition: "deleted-proven-obsolete",
      obsoleteProof: "target-contains-head",
    });
    const superseded = buildRemoteInventory(final, {
      decisions: {
        deletedBranches: [
          {
            evidence: ["The user approved the supersession."],
            name: "old/closed",
            supersession: {
              approvedBy: "user",
              initialHeadRevision: SHA.closed,
              reason: "Repackaged into main.",
              replacementRevisions: [SHA.targetNext],
            },
          },
        ],
        schemaVersion: 1,
      },
      opening,
    });
    const split = splitRemoteBranchReconciliationInput(superseded.receipt);
    expect(split.supersessions).toEqual([
      {
        approvedBy: "user",
        branch: "old/closed",
        initialHeadRevision: SHA.closed,
        reason: "Repackaged into main.",
        replacementRevisions: [SHA.targetNext],
      },
    ]);
    expect(() =>
      buildRemoteInventory(final, {
        decisions: {
          deletedBranches: [
            {
              evidence: ["Not deleted."],
              name: "feat/open",
              obsoleteProof: "target-contains-head",
            },
            {
              evidence: ["Contained."],
              name: "old/closed",
              obsoleteProof: "target-contains-head",
            },
          ],
          schemaVersion: 1,
        },
        opening,
      })
    ).toThrow("not deleted during the run: feat/open");
    const twice = {
      evidence: ["Contained."],
      name: "old/closed",
      obsoleteProof: "target-contains-head" as const,
    };
    expect(() =>
      buildRemoteInventory(final, {
        decisions: { deletedBranches: [twice, twice], schemaVersion: 1 },
        opening,
      })
    ).toThrow("each deleted branch may have only one decision");
  });

  test("the receipt validator also refuses a restarted page chain", () => {
    const { receipt } = buildRemoteInventory(openingPages());
    const restarted = structuredClone(receipt);
    for (const coverage of [
      restarted.initialCoverage,
      restarted.finalCoverage,
    ]) {
      coverage.branches.pages = coverage.branches.pages.map((page) => ({
        ...page,
        cursorIn: null,
        cursorOut: null,
      }));
    }
    expect(() => validateOpeningRemoteInventory(restarted)).toThrow(
      "pagination cursor chain is incomplete"
    );
  });

  test("refuses inconsistent pages instead of guessing", () => {
    const shifted = openingPages();
    shifted.branchPages[1]?.branches.push({
      headRevision: SHA.feature,
      name: "feat/open",
      protected: false,
    });
    expect(() => buildRemoteInventory(shifted)).toThrow("appears on two pages");

    const repeated = openingPages();
    repeated.proposalPages[1]?.proposals.push({
      headRevision: SHA.feature,
      objectId: "1",
      sourceBranch: "feat/open",
      state: "open",
    });
    expect(() => buildRemoteInventory(repeated)).toThrow(
      "proposal 1 appears twice"
    );

    const broken = openingPages();
    const [, second] = broken.branchPages;
    if (second) {
      second.cursorIn = "3";
    }
    expect(() => buildRemoteInventory(broken)).toThrow("does not continue");

    const noTarget = openingPages();
    noTarget.targetBranch = "trunk";
    expect(() => buildRemoteInventory(noTarget)).toThrow(
      "target branch trunk is not in the branch pages"
    );

    const opening = buildRemoteInventory(openingPages()).receipt;
    const openDeletion = finalPages();
    const [page] = openDeletion.branchPages;
    if (page) {
      page.branches = page.branches.filter(
        (branch) => branch.name !== "feat/open"
      );
    }
    expect(() => buildRemoteInventory(openDeletion, { opening })).toThrow(
      "still open"
    );

    const restarted = openingPages();
    const [ending, restarting] = restarted.branchPages;
    if (ending && restarting) {
      ending.cursorOut = null;
      restarting.cursorIn = null;
    }
    expect(() => buildRemoteInventory(restarted)).toThrow(
      "only the first page starts and only the last page ends"
    );

    for (const change of [
      { project: "group/other" },
      { provider: "github" },
      { targetBranch: "release/1" },
    ]) {
      expect(() =>
        buildRemoteInventory({ ...finalPages(), ...change }, { opening })
      ).toThrow("the opening inventory describes gitlab group/project main");
    }

    const orphanedOpen = openingPages();
    orphanedOpen.proposalPages[0]?.proposals.push({
      headRevision: SHA.gone,
      objectId: "9",
      sourceBranch: "vanished",
      state: "open",
    });
    expect(() => buildRemoteInventory(orphanedOpen)).toThrow(
      "proposal 9 is open on vanished, which no inventory lists"
    );
    const orphanedFinal = finalPages();
    orphanedFinal.proposalPages[0]?.proposals.push({
      headRevision: SHA.gone,
      objectId: "9",
      sourceBranch: "vanished",
      state: "open",
    });
    expect(() => buildRemoteInventory(orphanedFinal, { opening })).toThrow(
      "proposal 9 is open on vanished, which no inventory lists"
    );

    const reprotected = finalPages();
    const closed = reprotected.branchPages[0]?.branches.find(
      (branch) => branch.name === "old/closed"
    );
    if (closed) {
      closed.protected = true;
    }
    expect(() => buildRemoteInventory(reprotected, { opening })).toThrow(
      "changed protection"
    );
  });
});

describe("GitLab fetcher listing stability", () => {
  const encoder = new TextEncoder();
  const listing =
    (reads: () => { branches: unknown[]; requests: unknown[] }) =>
    (endpoint: string): Uint8Array => {
      const { branches, requests } = reads();
      return encoder.encode(
        JSON.stringify(
          endpoint.includes("repository/branches") ? branches : requests
        )
      );
    };
  const main = { commit: { id: SHA.target }, name: "main", protected: true };
  const options = {
    output: "unused.json",
    project: "group/project",
    targetBranch: "main",
  };

  test("reads again until two reads agree", () => {
    let calls = 0;
    const pages = fetchGitLabRemoteInventory(
      options,
      listing(() => {
        calls += 1;
        // The first read sees a branch that is gone by the second.
        return {
          branches:
            calls === 1
              ? [
                  main,
                  {
                    commit: { id: SHA.feature },
                    name: "gone",
                    protected: false,
                  },
                ]
              : [main],
          requests: [],
        };
      })
    );
    expect(pages.branchPages[0]?.branches.map((branch) => branch.name)).toEqual(
      ["main"]
    );
    expect(calls).toBe(6);
  });

  test("refuses a listing that never settles", () => {
    let calls = 0;
    expect(() =>
      fetchGitLabRemoteInventory(
        options,
        listing(() => {
          calls += 1;
          return {
            branches: [main],
            requests: [
              {
                iid: calls,
                sha: SHA.feature,
                source_branch: "main",
                source_project_id: 1,
                state: "opened",
                target_project_id: 1,
              },
            ],
          };
        })
      )
    ).toThrow("changed between every one of 4 reads");
  });
});

describe("remote inventory through the CLI and a loop", () => {
  let repositories: TestRepository[] = [];
  afterEach(() => {
    for (const fixture of repositories) {
      fixture.cleanup();
    }
    repositories = [];
  });

  const cliPath = fileURLToPath(
    new URL(
      "../../../skills/simple-changes/scripts/simple-changes.ts",
      import.meta.url
    )
  );
  const decoder = new TextDecoder();
  const runCli = (cwd: string, args: string[]) => {
    const result = spawnSync([process.execPath, cliPath, ...args], {
      cwd,
      env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stderr: decoder.decode(result.stderr),
      stdout: decoder.decode(result.stdout),
    };
  };

  test("loop start and reconcile-remote-branches accept built receipts unchanged", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const { root } = fixture;
    git(root, ["remote", "add", "origin", "git@gitlab.com:group/project.git"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "-c", "fix/shipped"]);
    writeFixture(root, "shipped.txt", "opening head\n");
    git(root, ["add", "shipped.txt"]);
    git(root, ["commit", "-m", "Opening head"]);
    const initialHead = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "main"]);
    git(root, ["merge", "--ff-only", "fix/shipped"]);
    writeFixture(root, "shipped.txt", "fast-forwarded head\n");
    git(root, ["commit", "-am", "Fast-forward"]);
    const target = git(root, ["rev-parse", "HEAD"]);
    git(root, ["branch", "-f", "fix/shipped", initialHead]);

    const pages = (
      observedAt: string,
      branches: RemoteInventoryPages["branchPages"][number]["branches"],
      proposals: RemoteInventoryPages["proposalPages"][number]["proposals"]
    ): RemoteInventoryPages => ({
      branchPages: [{ branches, cursorIn: null, cursorOut: null }],
      observedAt,
      project: "group/project",
      proposalPages: [{ cursorIn: null, cursorOut: null, proposals }],
      provider: "gitlab",
      schemaVersion: 1,
      targetBranch: "main",
    });
    const openingPath = join(fixture.base, "opening-pages.json");
    writeFileSync(
      openingPath,
      JSON.stringify(
        pages(
          new Date().toISOString(),
          [
            { headRevision: target, name: "main", protected: true },
            {
              headRevision: initialHead,
              name: "fix/shipped",
              protected: false,
            },
            { headRevision: base, name: "kept", protected: false },
          ],
          [
            {
              headRevision: initialHead,
              objectId: "70",
              sourceBranch: "fix/shipped",
              state: "open",
            },
          ]
        )
      )
    );
    const openingReceipt = join(fixture.base, "opening.json");
    const built = runCli(root, [
      "remote-inventory",
      "build",
      "--pages",
      openingPath,
      "--output",
      openingReceipt,
      "--json",
    ]);
    expect(built.stderr).toBe("");
    expect(built.exitCode).toBe(0);
    expect(JSON.parse(built.stdout)).toMatchObject({
      output: openingReceipt,
      phase: "opening",
    });
    const started = runCli(root, [
      "loop",
      "start",
      "--mode",
      "integrate",
      "--agent-id",
      "controller",
      "--opening-remote-inventory",
      openingReceipt,
      "--json",
    ]);
    expect(started.stderr).toBe("");
    expect(started.exitCode).toBe(0);
    const { lease } = JSON.parse(started.stdout) as {
      lease: { openingRemoteInventory: unknown; runId: string };
    };
    expect(lease.openingRemoteInventory).toEqual(
      JSON.parse(readFileSync(openingReceipt, "utf8"))
    );

    const finalPath = join(fixture.base, "final-pages.json");
    writeFileSync(
      finalPath,
      JSON.stringify(
        pages(
          new Date(Date.now() + 1000).toISOString(),
          [
            { headRevision: target, name: "main", protected: true },
            { headRevision: base, name: "kept", protected: false },
          ],
          [
            {
              headRevision: target,
              objectId: "70",
              sourceBranch: "fix/shipped",
              state: "merged",
            },
          ]
        )
      )
    );
    const finalReceipt = join(fixture.base, "final.json");
    const finalBuild = runCli(root, [
      "remote-inventory",
      "build",
      "--pages",
      finalPath,
      "--opening-remote-inventory",
      openingReceipt,
      "--output",
      finalReceipt,
    ]);
    expect(finalBuild.stderr).toBe("");
    expect(finalBuild.exitCode).toBe(0);
    expect(finalBuild.stdout).toContain("Deleted during the run: fix/shipped");
    const reconciled = runCli(root, [
      "loop",
      "reconcile-remote-branches",
      "--run-id",
      lease.runId,
      "--agent-id",
      "controller",
      "--receipt",
      finalReceipt,
      "--json",
    ]);
    expect(reconciled.stderr).toBe("");
    expect(reconciled.exitCode).toBe(0);
  }, 60_000);

  test("--output never overwrites an input under another name", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const pages = join(fixture.base, "pages.json");
    writeFileSync(pages, JSON.stringify(openingPages()));
    const original = readFileSync(pages, "utf8");
    const hardLink = join(fixture.base, "hard.json");
    linkSync(pages, hardLink);
    const softLink = join(fixture.base, "soft.json");
    symlinkSync(pages, softLink);
    for (const output of [pages, hardLink, softLink]) {
      const result = runCli(fixture.root, [
        "remote-inventory",
        "build",
        "--pages",
        pages,
        "--output",
        output,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--output");
    }
    expect(readFileSync(pages, "utf8")).toBe(original);
  });

  test("the GitLab fetcher pages read-only API calls into valid pages", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const fakeBin = join(fixture.base, "bin");
    const served = join(fixture.base, "served");
    mkdirSync(served);
    mkdirSync(fakeBin);
    const branches = Array.from({ length: 100 }, (_, index) => ({
      commit: { id: index.toString(16).padStart(40, "0") },
      name: `branch-${String(index).padStart(3, "0")}`,
      protected: false,
    }));
    writeFixture(served, "branches-1.json", JSON.stringify(branches));
    writeFixture(
      served,
      "branches-2.json",
      JSON.stringify([
        { commit: { id: SHA.target }, name: "main", protected: true },
      ])
    );
    writeFixture(
      served,
      "merge-requests-1.json",
      JSON.stringify([
        {
          iid: 5,
          sha: SHA.feature,
          source_branch: "branch-001",
          source_project_id: 7,
          state: "locked",
          target_project_id: 7,
        },
        {
          iid: 8,
          sha: null,
          source_branch: "branch-002",
          source_project_id: 7,
          state: "closed",
          target_project_id: 7,
        },
        {
          iid: 9,
          source_branch: "branch-003",
          source_project_id: 7,
          state: "merged",
          target_project_id: 7,
        },
        {
          iid: 6,
          sha: SHA.merged,
          source_branch: "main",
          source_project_id: 99,
          state: "opened",
          target_project_id: 7,
        },
      ])
    );
    const calls = join(fixture.base, "calls.log");
    writeFixture(
      fakeBin,
      "glab",
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nfor arg; do endpoint=$arg; done\npage=$(printf '%s' "$endpoint" | sed -n 's/.*[?&]page=\\([0-9]*\\).*/\\1/p')\ncase "$endpoint" in\n  *repository/branches*) cat '${served}'/branches-$page.json ;;\n  *merge_requests*) cat '${served}'/merge-requests-$page.json ;;\n  *) exit 1 ;;\nesac\n`
    );
    chmodSync(join(fakeBin, "glab"), 0o755);
    const pages = fetchGitLabRemoteInventory({
      glab: join(fakeBin, "glab"),
      output: join(fixture.base, "pages.json"),
      project: "group/project",
      rawDirectory: join(fixture.base, "raw"),
      targetBranch: "main",
    });
    expect(pages.branchPages.map((page) => page.cursorOut)).toEqual([
      "2",
      null,
    ]);
    expect(pages.branchPages[0]?.responseDigest).toBe(
      createHash("sha256")
        .update(readFileSync(join(fixture.base, "raw", "branches-1.json")))
        .digest("hex")
    );
    // A locked MR counts as open; a fork's MR names the fork's branch.
    expect(pages.proposalPages[0]?.proposals).toEqual([
      {
        headRevision: SHA.feature,
        objectId: "5",
        sourceBranch: "branch-001",
        state: "open",
      },
      // A null or missing sha stays null rather than becoming a guess.
      {
        headRevision: null,
        objectId: "8",
        sourceBranch: "branch-002",
        state: "closed",
      },
      {
        headRevision: null,
        objectId: "9",
        sourceBranch: "branch-003",
        state: "merged",
      },
    ]);
    expect(buildRemoteInventory(pages).summary).toMatchObject({
      branches: 101,
      proposals: 3,
    });
    const log = readFileSync(calls, "utf8").trim().split("\n");
    // Two full reads that normalize identically.
    expect(log).toHaveLength(6);
    for (const line of log) {
      expect(line.startsWith("api projects/group%2Fproject/")).toBe(true);
      expect(line).not.toContain("-X");
    }
  });
});
