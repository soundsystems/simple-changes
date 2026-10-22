import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { SimpleChangesError } from "../../../skills/simple-changes/scripts/lib/errors.ts";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { startLoop } from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  type ReplacementLineageReceipt,
  replacementLineageDirectory,
} from "../../../skills/simple-changes/scripts/lib/replacement-lineage.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import {
  claimWorktree,
  releaseWorktreeClaim,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  pruneRepository,
  readWorktreeCleanups,
  standaloneWorktreeCleanup,
} from "../../../skills/simple-changes/scripts/lib/worktree-maintenance.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(180_000);

const CONTROLLER = "controller-agent";
const AUTHOR = "author-agent";
const REVIEWER = "reviewer-agent";
const APPROVER = "the-user";
const MINUTE = 60_000;
const decoder = new TextDecoder();
const CLI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const PIN_REF_PATTERN =
  /^refs\/simple-changes\/superseded\/replacement-lineage-[0-9a-f]{64}\/[0-9a-f]{40}$/u;
const AGENT_REQUIRED_PATTERN =
  /agent ID \(with a lineage receipt\) is required/u;
const UNPROVEN_HEAD_PATTERN = /neither contained in nor patch-equivalent/u;
const DIRTY_PATTERN = /uncommitted changes/u;
const CLAIMED_PATTERN = /claim .* still covers the checkout/u;
const LEASE_REGISTERED_PATTERN = /open loop lease registers the checkout/u;
const HEAD_MOVED_PATTERN = /moved after the review/u;
const SHALLOW_PATTERN = /shallow clone/u;
const REPLACEMENT_OUTSIDE_TARGET_PATTERN =
  /is not contained in reviewed target/u;
const REPLACEMENT_IS_ANCESTOR_PATTERN = /already an ancestor of source head/u;
const UNMAPPED_PATTERN = /have no reviewed replacement/u;
const REVIEWER_IS_AUTHOR_PATTERN = /is an author of the source/u;
const REVIEWER_IS_CONTROLLER_PATTERN =
  /is the controller running this cleanup/u;
const APPROVAL_BEFORE_REVIEW_PATTERN = /predates the review/u;
const STALE_APPROVAL_PATTERN = /hours old/u;
const OTHER_APPROVER_PATTERN = /runs on approval from the-user/u;
const UNKNOWN_FIELD_PATTERN = /Invalid replacement-lineage-receipt/u;
const EXTRA_MAPPING_PATTERN = /does not describe this history/u;
const EDITED_BRANCH_PATTERN = /not the reviewed other-branch/u;
const ALREADY_CONTAINED_PATTERN = /\(target-contained\)/u;

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

interface LineageFixture {
  commits: string[];
  fixture: TestRepository;
  headSha: string;
  merged: string;
  path: string;
  replacements: string[];
  targetRevision: string;
}

const commonDirectory = (root: string): string =>
  captureInventory(root).repository.commonGitDirectory;

/**
 * A clean source checkout with two commits, shipped on main through
 * replacement commits whose patch IDs differ. With `sameBytes`, one broader
 * replacement carries the source's exact bytes plus another file; otherwise
 * two replacements change the bytes the review refined. A merged side
 * checkout is the normal cleanup's control.
 */
const lineageFixture = (sameBytes: boolean): LineageFixture => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  const mergedPath = join(fixture.base, "merged-unit");
  git(fixture.root, ["worktree", "add", "-b", "merged-unit", mergedPath]);
  writeFixture(mergedPath, "merged.ts", "export const merged = 1;\n");
  git(mergedPath, ["add", "."]);
  git(mergedPath, ["commit", "-m", "Merged work"]);
  git(fixture.root, [
    "merge",
    "--no-ff",
    "-m",
    "Merge merged-unit",
    "merged-unit",
  ]);

  const path = join(fixture.base, "source-unit");
  git(fixture.root, ["worktree", "add", "-b", "source-unit", path]);
  writeFixture(path, "a.ts", "export const a = 1;\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "Add a"]);
  writeFixture(path, "b.ts", "export const b = 1;\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "Add b"]);
  const commits = git(path, ["rev-list", "--reverse", "main..HEAD"]).split(
    "\n"
  );
  const headSha = git(path, ["rev-parse", "HEAD"]);

  const replacements: string[] = [];
  if (sameBytes) {
    writeFixture(fixture.root, "a.ts", "export const a = 1;\n");
    writeFixture(fixture.root, "b.ts", "export const b = 1;\n");
    writeFixture(fixture.root, "c.ts", "export const c = 1;\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Ship a and b with c"]);
    replacements.push(git(fixture.root, ["rev-parse", "HEAD"]));
  } else {
    writeFixture(fixture.root, "a.ts", "export const a = 2;\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Ship reviewed a"]);
    replacements.push(git(fixture.root, ["rev-parse", "HEAD"]));
    writeFixture(fixture.root, "b.ts", "export const b = 2;\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Ship reviewed b"]);
    replacements.push(git(fixture.root, ["rev-parse", "HEAD"]));
  }
  return {
    commits,
    fixture,
    headSha,
    merged: mergedPath,
    path,
    replacements,
    targetRevision: git(fixture.root, ["rev-parse", "HEAD"]),
  };
};

// The clean status digest a controller reads from the live inventory.
const liveDigest = (lineage: LineageFixture): string =>
  captureInventory(lineage.fixture.root).worktrees.find(
    (worktree) => worktree.path === lineage.path
  )?.changeDigest ?? "";

const receiptFor = (
  lineage: LineageFixture,
  now = Date.now()
): ReplacementLineageReceipt => ({
  approval: {
    approvalReference: "chat message approving removal",
    approvedAt: new Date(now - 5 * MINUTE).toISOString(),
    approvedBy: APPROVER,
    reason: "The source shipped through reviewed replacements.",
  },
  commits: lineage.commits.map((sourceCommit, index) => ({
    replacementCommits: [
      lineage.replacements[Math.min(index, lineage.replacements.length - 1)] ??
        "",
    ],
    sourceCommit,
  })),
  kind: "replacement-lineage-receipt",
  review: {
    decision: "replaced-in-target",
    reviewedAt: new Date(now - 10 * MINUTE).toISOString(),
    reviewerAgentId: REVIEWER,
    reviewReference: "review log for the source range",
  },
  schemaVersion: 1,
  source: {
    authorAgentId: AUTHOR,
    branch: "source-unit",
    changeDigest: liveDigest(lineage),
    headRevision: lineage.headSha,
    path: lineage.path,
  },
  targetRef: "main",
  targetRevision: lineage.targetRevision,
});

const prune = (
  lineage: LineageFixture,
  receipt: unknown,
  options: { dryRun?: boolean; now?: Date | undefined } = {}
) =>
  pruneRepository({
    agentId: CONTROLLER,
    approvedBy: APPROVER,
    dryRun: options.dryRun ?? false,
    lineageReceipt: receipt,
    now: options.now,
    reason: "Remove the reviewed obsolete source.",
    repositoryPath: lineage.fixture.root,
  });

const worktreePaths = (root: string): string[] =>
  captureInventory(root).worktrees.map((worktree) => worktree.path);

const pinRefs = (root: string): string =>
  git(root, ["for-each-ref", "--format=%(refname)", "refs/simple-changes/"]);

const branchExists = (root: string, branch: string): boolean =>
  git(root, ["branch", "--list", branch]) !== "";

const expectNothingWritten = (lineage: LineageFixture): void => {
  const { root } = lineage.fixture;
  const paths = worktreePaths(root);
  expect(paths).toContain(lineage.path);
  expect(paths).toContain(lineage.merged);
  expect(branchExists(root, "source-unit")).toBe(true);
  expect(branchExists(root, "merged-unit")).toBe(true);
  expect(pinRefs(root)).toBe("");
  const common = commonDirectory(root);
  expect(existsSync(replacementLineageDirectory(common))).toBe(false);
  expect(readWorktreeCleanups(common)).toEqual([]);
};

const expectRefusal = (run: () => unknown, pattern: RegExp): void => {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SimpleChangesError);
  expect((caught as Error).message).toMatch(pattern);
};

const lineageRecords = (root: string): Record<string, unknown>[] => {
  const directory = replacementLineageDirectory(commonDirectory(root));
  return readdirSync(directory)
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(resolve(directory, name), "utf8")) as Record<
          string,
          unknown
        >
    );
};

describe("reviewed replacement lineage cleanup", () => {
  test("without a receipt, prune keeps the replaced source and names branch audit", () => {
    const lineage = lineageFixture(false);
    const report = pruneRepository({
      approvedBy: APPROVER,
      dryRun: false,
      reason: "Ordinary prune.",
      repositoryPath: lineage.fixture.root,
    });
    expect(report.reviewedReplacement).toBeNull();
    expect(report.removed.map((entry) => entry.path)).toEqual([lineage.merged]);
    expect(
      report.preserved.find((entry) => entry.path === lineage.path)?.reason
    ).toMatch(UNPROVEN_HEAD_PATTERN);
    expect(worktreePaths(lineage.fixture.root)).toContain(lineage.path);
    expect(pinRefs(lineage.fixture.root)).toBe("");
  });

  test("prune removes a reviewed source, pins its head, and records the lineage", () => {
    const lineage = lineageFixture(false);
    const receipt = receiptFor(lineage);
    const report = prune(lineage, receipt);
    const { root } = lineage.fixture;

    expect(report.errors).toEqual([]);
    expect(report.plannedRemovals).toContainEqual({
      branch: "source-unit",
      containment: "reviewed-replacement",
      headSha: lineage.headSha,
      path: lineage.path,
    });
    expect(
      report.removed.map((entry) => [entry.path, entry.containment])
    ).toEqual(
      [
        [lineage.merged, "target-contained"],
        [lineage.path, "reviewed-replacement"],
      ].sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""))
    );
    expect(report.reviewedReplacement).toMatchObject({
      branchDeleted: true,
      byteProof: { differingPaths: ["a.ts", "b.ts"], status: "not-proven" },
      uniqueCommits: lineage.commits,
      worktreeRemoved: true,
    });
    expect(worktreePaths(root)).not.toContain(lineage.path);
    expect(existsSync(lineage.path)).toBe(false);
    expect(branchExists(root, "source-unit")).toBe(false);
    const pin = report.reviewedReplacement?.pinRef ?? "";
    expect(pin).toMatch(PIN_REF_PATTERN);
    expect(git(root, ["rev-parse", pin])).toBe(lineage.headSha);
    expect(git(root, ["rev-list", "--count", `main..${pin}`])).toBe("2");

    const records = lineageRecords(root);
    expect(
      records
        .map((record) => String(record.phase))
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(["completed", "intent"]);
    for (const record of records) {
      validateSchema("replacement-lineage-removal", record);
      expect(record).toMatchObject({
        approvedBy: APPROVER,
        cleanupId: null,
        command: "prune",
        controllerAgentId: CONTROLLER,
        pinRef: pin,
        receipt,
      });
    }
    expect(
      records.find((record) => record.phase === "completed")?.outcome
    ).toEqual({ branchDeleted: true, errors: [], worktreeRemoved: true });
  });

  test("an exact-byte replacement records the byte proof", () => {
    const lineage = lineageFixture(true);
    const report = prune(lineage, receiptFor(lineage));
    expect(report.reviewedReplacement).toMatchObject({
      byteProof: { status: "proven", touchedPaths: ["a.ts", "b.ts"] },
      worktreeRemoved: true,
    });
  });

  test("a dry run verifies and plans the removal but changes nothing", () => {
    const lineage = lineageFixture(false);
    const report = prune(lineage, receiptFor(lineage), { dryRun: true });
    expect(report.plannedRemovals.map((entry) => entry.containment)).toContain(
      "reviewed-replacement"
    );
    expect(report.reviewedReplacement).toMatchObject({
      recordPaths: [],
      removalId: null,
      worktreeRemoved: false,
    });
    expect(report.removed).toEqual([]);
    expectNothingWritten(lineage);
  });

  test("worktree cleanup removes a reviewed source and keeps the strict receipt history unchanged in shape", () => {
    const lineage = lineageFixture(false);
    const receipt = receiptFor(lineage);
    const result = standaloneWorktreeCleanup({
      agentId: CONTROLLER,
      approvedBy: APPROVER,
      lineageReceipt: receipt,
      reason: "Remove the reviewed obsolete source.",
      repositoryPath: lineage.fixture.root,
    });
    const { root } = lineage.fixture;
    expect(result.reviewedReplacement).toMatchObject({
      branchDeleted: true,
      worktreeRemoved: true,
    });
    expect(worktreePaths(root)).not.toContain(lineage.path);
    expect(
      git(root, ["rev-parse", result.reviewedReplacement?.pinRef ?? ""])
    ).toBe(lineage.headSha);
    const history = readWorktreeCleanups(commonDirectory(root));
    expect(history.map((entry) => entry.phase)).toEqual([
      "intent",
      "completed",
    ]);
    for (const entry of history) {
      for (const removal of [
        ...entry.removed,
        ...(entry.plannedRemovals ?? []),
      ]) {
        expect(removal.path).not.toBe(lineage.path);
      }
      expect(entry.preserved.map((item) => item.path)).not.toContain(
        lineage.path
      );
    }
    const records = lineageRecords(root);
    expect(
      records.every((record) => record.cleanupId === result.cleanupId)
    ).toBe(true);
    expect(
      records.every((record) => record.command === "worktree-cleanup")
    ).toBe(true);
  });

  test("a receipt refused by worktree cleanup writes no cleanup history", () => {
    const lineage = lineageFixture(false);
    const receipt = receiptFor(lineage);
    receipt.review.reviewerAgentId = CONTROLLER;
    expectRefusal(
      () =>
        standaloneWorktreeCleanup({
          agentId: CONTROLLER,
          approvedBy: APPROVER,
          lineageReceipt: receipt,
          reason: "Remove the reviewed obsolete source.",
          repositoryPath: lineage.fixture.root,
        }),
      REVIEWER_IS_CONTROLLER_PATTERN
    );
    expectNothingWritten(lineage);
  });

  interface RefusalOverrides {
    now?: Date;
    receipt?: unknown;
  }

  const refusals: Array<{
    name: string;
    pattern: RegExp;
    /** Returns the clock or the edited document to run with, if any. */
    setUp: (
      lineage: LineageFixture,
      receipt: ReplacementLineageReceipt
    ) => RefusalOverrides;
  }> = [
    {
      name: "a dirty checkout",
      pattern: DIRTY_PATTERN,
      setUp: (lineage) => {
        writeFixture(lineage.path, "wip.ts", "export const wip = 1;\n");
        return {};
      },
    },
    {
      name: "a claimed checkout",
      pattern: CLAIMED_PATTERN,
      setUp: (lineage) => {
        claimWorktree(
          lineage.fixture.root,
          AUTHOR,
          lineage.path,
          "claude-code"
        );
        return {};
      },
    },
    {
      name: "a checkout an open lease registers",
      pattern: LEASE_REGISTERED_PATTERN,
      setUp: (lineage) => {
        startLoop(lineage.fixture.root, "loop-controller", "integrate");
        return {};
      },
    },
    {
      name: "a head that moved after the review",
      pattern: HEAD_MOVED_PATTERN,
      setUp: (lineage) => {
        writeFixture(lineage.path, "later.ts", "export const later = 1;\n");
        git(lineage.path, ["add", "."]);
        git(lineage.path, ["commit", "-m", "Later work"]);
        return {};
      },
    },
    {
      name: "a shallow clone",
      pattern: SHALLOW_PATTERN,
      setUp: (lineage) => {
        const root = git(lineage.fixture.root, [
          "rev-list",
          "--max-parents=0",
          "HEAD",
        ]);
        writeFileSync(
          join(commonDirectory(lineage.fixture.root), "shallow"),
          `${root}\n`
        );
        return {};
      },
    },
    {
      name: "a replacement the target does not contain",
      pattern: REPLACEMENT_OUTSIDE_TARGET_PATTERN,
      setUp: (lineage, receipt) => {
        const outside = git(lineage.fixture.root, [
          "commit-tree",
          "HEAD^{tree}",
          "-p",
          "HEAD",
          "-m",
          "Never merged",
        ]);
        receipt.commits[0] = {
          replacementCommits: [outside],
          sourceCommit: receipt.commits[0]?.sourceCommit ?? "",
        };
        return {};
      },
    },
    {
      name: "a replacement that is an ancestor of the source head",
      pattern: REPLACEMENT_IS_ANCESTOR_PATTERN,
      setUp: (lineage, receipt) => {
        const initial = git(lineage.fixture.root, [
          "rev-list",
          "--max-parents=0",
          "HEAD",
        ]);
        receipt.commits[1] = {
          replacementCommits: [initial],
          sourceCommit: receipt.commits[1]?.sourceCommit ?? "",
        };
        return {};
      },
    },
    {
      name: "an unmapped unique commit",
      pattern: UNMAPPED_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.commits.pop();
        return {};
      },
    },
    {
      name: "a reviewer who is the declared author",
      pattern: REVIEWER_IS_AUTHOR_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.review.reviewerAgentId = ` ${AUTHOR} `;
        return {};
      },
    },
    {
      name: "a reviewer who once claimed the checkout",
      pattern: REVIEWER_IS_AUTHOR_PATTERN,
      setUp: (lineage) => {
        const claim = claimWorktree(
          lineage.fixture.root,
          REVIEWER,
          lineage.path,
          "claude-code"
        );
        releaseWorktreeClaim(lineage.fixture.root, REVIEWER, claim.claimId);
        return {};
      },
    },
    {
      name: "a reviewer who is the controller",
      pattern: REVIEWER_IS_CONTROLLER_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.review.reviewerAgentId = CONTROLLER;
        return {};
      },
    },
    {
      name: "an approval before the review",
      pattern: APPROVAL_BEFORE_REVIEW_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.approval.approvedAt = new Date(
          Date.parse(receipt.review.reviewedAt) - MINUTE
        ).toISOString();
        return {};
      },
    },
    {
      name: "a stale approval",
      pattern: STALE_APPROVAL_PATTERN,
      setUp: () => ({ now: new Date(Date.now() + 25 * 60 * MINUTE) }),
    },
    {
      name: "an approval for a different approver",
      pattern: OTHER_APPROVER_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.approval.approvedBy = "someone-else";
        return {};
      },
    },
    {
      name: "an edited receipt with an unknown field",
      pattern: UNKNOWN_FIELD_PATTERN,
      setUp: (_lineage, receipt) => ({
        receipt: { ...receipt, waiver: true },
      }),
    },
    {
      name: "an edited mapping naming a commit the target already has",
      pattern: EXTRA_MAPPING_PATTERN,
      setUp: (lineage, receipt) => {
        const initial = git(lineage.fixture.root, [
          "rev-list",
          "--max-parents=0",
          "HEAD",
        ]);
        receipt.commits.push({
          replacementCommits: [lineage.replacements[0] ?? ""],
          sourceCommit: initial,
        });
        return {};
      },
    },
    {
      name: "an edited branch name",
      pattern: EDITED_BRANCH_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.source.branch = "other-branch";
        return {};
      },
    },
  ];

  for (const refusal of refusals) {
    test(`refuses ${refusal.name} and writes nothing`, () => {
      const lineage = lineageFixture(false);
      const receipt = receiptFor(lineage);
      const overrides = refusal.setUp(lineage, receipt);
      expectRefusal(
        () =>
          prune(lineage, overrides.receipt ?? receipt, { now: overrides.now }),
        refusal.pattern
      );
      expectNothingWritten(lineage);
    });
  }

  test("refuses a head the target already contains, naming target-contained", () => {
    const lineage = lineageFixture(false);
    git(lineage.fixture.root, [
      "merge",
      "--no-ff",
      "-X",
      "theirs",
      "-m",
      "Merge the source too",
      "source-unit",
    ]);
    const receipt = receiptFor(lineage);
    receipt.targetRevision = git(lineage.fixture.root, ["rev-parse", "HEAD"]);
    expectRefusal(() => prune(lineage, receipt), ALREADY_CONTAINED_PATTERN);
    expectNothingWritten(lineage);
  });

  test("the prune command reads --lineage-receipt and plans the reviewed removal", () => {
    const lineage = lineageFixture(false);
    const receiptPath = join(lineage.fixture.base, "lineage-receipt.json");
    writeFileSync(receiptPath, JSON.stringify(receiptFor(lineage)));
    const result = spawnSync(
      [
        process.execPath,
        CLI_PATH,
        "prune",
        "--agent-id",
        CONTROLLER,
        "--approved-by",
        APPROVER,
        "--lineage-receipt",
        receiptPath,
        "--dry-run",
        "--json",
        "--repo",
        lineage.fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(decoder.decode(result.stdout)) as {
      reviewedReplacement: { method: string; path: string } | null;
    };
    expect(report.reviewedReplacement).toMatchObject({
      method: "reviewed-replacement",
      path: lineage.path,
    });
    expectNothingWritten(lineage);
  });

  test("a lineage receipt requires the controller's agent ID", () => {
    const lineage = lineageFixture(false);
    expectRefusal(
      () =>
        pruneRepository({
          approvedBy: APPROVER,
          dryRun: true,
          lineageReceipt: receiptFor(lineage),
          repositoryPath: lineage.fixture.root,
        }),
      AGENT_REQUIRED_PATTERN
    );
    expectNothingWritten(lineage);
  });
});
