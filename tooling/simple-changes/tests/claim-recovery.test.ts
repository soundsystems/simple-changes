import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  acceptPausedWorktreeChange,
  adoptPausedWorktree,
  loopLeasePath,
  prepareAgentWorktree,
  readLoopLease,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import type {
  LoopViolation,
  WorktreeInventory,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  pauseClaimedWorktree,
  readWorktreeCoordination,
  readWorktreeTakeovers,
  releaseWorktreeClaim,
  takeoverWorktreeClaim,
  type WorktreeTakeoverOptions,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// Recovery of a concurrent author whose owner vanished while the run's
// controller stays active (#8), and the exact branch and HEAD a takeover
// approval binds.

setDefaultTimeout(60_000);

const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);

let repositories: TestRepository[] = [];

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const commit = (cwd: string, path: string, contents: string): void => {
  writeFixture(cwd, path, contents);
  git(cwd, ["add", path]);
  git(cwd, ["commit", "-m", `Write ${path}`]);
};

const worktreeAt = (root: string, path: string): WorktreeInventory => {
  const current = captureInventory(root).worktrees.find(
    (worktree) => worktree.path === path
  );
  if (!current?.headSha) {
    throw new Error(`Expected a checkout with a commit at ${path}`);
  }
  return current;
};

const staleViolation = (
  root: string,
  path: string
): LoopViolation | undefined =>
  verifyLoop(root).violations.find(
    (violation) =>
      violation.code === "coordination-claim-stale" && violation.path === path
  );

// Every ref and every checkout's exact state, to prove a step edits nothing.
const repositorySnapshot = (root: string): string =>
  JSON.stringify({
    refs: git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    worktrees: captureInventory(root).worktrees.map((worktree) => ({
      branch: worktree.branch,
      changeDigest: worktree.changeDigest,
      headSha: worktree.headSha,
      path: worktree.path,
    })),
  });

interface StaleAuthor {
  authorPath: string;
  claimId: string;
  fixture: TestRepository;
  runId: string;
}

/**
 * A run whose opening concurrent author left its checkout on a branch its
 * claim does not record, then vanished: the claim is stale and no owner
 * remains to refresh it.
 */
const staleConcurrentAuthor = (
  shape: "switched-branch" | "detached-contained" | "unborn"
): StaleAuthor => {
  const fixture = repository();
  const authorPath = join(fixture.base, "vanished-author");
  git(fixture.root, ["worktree", "add", "-b", "author-work", authorPath]);
  commit(authorPath, "feature.ts", "export const feature = 1;\n");
  if (shape === "detached-contained") {
    // The author's work already reached the target branch.
    git(fixture.root, ["merge", "--ff-only", "author-work"]);
  }
  const claim = claimWorktree(
    fixture.root,
    "vanished-author",
    authorPath,
    "claude-code",
    "gone-session"
  );
  const lease = startLoop(fixture.root, "controller", "integrate");
  expect(lease.worktrees).toContainEqual(
    expect.objectContaining({
      agentId: "vanished-author",
      claimId: claim.claimId,
      path: authorPath,
      role: "concurrent-author",
    })
  );
  if (shape === "detached-contained") {
    git(authorPath, ["checkout", "--detach"]);
  } else if (shape === "unborn") {
    git(authorPath, ["checkout", "--orphan", "author-unborn"]);
  } else {
    git(authorPath, ["checkout", "-b", "author-work-continued"]);
    commit(authorPath, "feature.ts", "export const feature = 2;\n");
  }
  return {
    authorPath,
    claimId: claim.claimId,
    fixture,
    runId: lease.runId,
  };
};

const takeoverOptions = (
  author: StaleAuthor,
  current: WorktreeInventory,
  overrides: Partial<WorktreeTakeoverOptions> = {}
): WorktreeTakeoverOptions => ({
  action: "reassign",
  approvedBy: "the-user",
  claimId: author.claimId,
  expectedBranch: current.branch,
  expectedHeadSha: current.headSha ?? "",
  expectedStatusDigest: current.changeDigest,
  newAgentId: "controller",
  reason: "The concurrent author's session ended and cannot be contacted.",
  repositoryPath: author.fixture.root,
  ...overrides,
});

// The printed controller steps after the takeover, run as printed.
const claimPauseAccept = (author: StaleAuthor): void => {
  const { authorPath, fixture, runId } = author;
  const stale = staleViolation(fixture.root, authorPath);
  expect(stale?.nextCommands).toEqual([
    `simple-changes worktree claim --agent-id controller --worktree ${authorPath} --adapter claude-code --owner-ref takeover:the-user --repo ${fixture.root}`,
    `simple-changes worktree pause --agent-id controller --worktree ${authorPath} --run-id ${runId} --disposition preserve-in-place --reason <why> --repo ${fixture.root}`,
    `simple-changes loop accept-paused-change --run-id ${runId} --agent-id controller --pause-receipt <pause-receipt-id> --repo ${fixture.root}`,
  ]);
  claimWorktree(
    fixture.root,
    "controller",
    authorPath,
    "claude-code",
    "takeover:the-user"
  );
  const receipt = pauseClaimedWorktree(
    fixture.root,
    "controller",
    authorPath,
    runId,
    "preserve-in-place",
    "Record the vanished author's exact state for this run."
  );
  acceptPausedWorktreeChange(
    fixture.root,
    runId,
    "controller",
    receipt.receiptId
  );
};

const expectScopeOpenAndOneController = (author: StaleAuthor): void => {
  const lease = readLoopLease(author.fixture.root);
  expect(lease?.ownerAgentId).toBe("controller");
  expect(lease?.controller?.status ?? "active").toBe("active");
  expect(lease?.controller?.handoffs ?? []).toEqual([]);
  expect(lease?.shipmentScopeFrozenAt ?? null).toBeNull();
};

describe("active-controller recovery of a vanished concurrent author", () => {
  test("hands a current-branch checkout's stale claim to the controller without freezing scope", () => {
    const author = staleConcurrentAuthor("switched-branch");
    const { authorPath, fixture, runId } = author;
    const current = worktreeAt(fixture.root, authorPath);

    const stale = staleViolation(fixture.root, authorPath);
    expect(stale?.message).toContain(
      `If vanished-author no longer exists, ask the user to approve \`simple-changes worktree takeover --claim-id ${author.claimId} --agent-id controller --head ${current.headSha} --branch author-work-continued --status-digest ${current.changeDigest} --approved-by <user> --reason <why> --repo ${fixture.root}\``
    );
    expect(stale?.message).toContain("without relinquishing the run");
    // The approval needs the user, so the takeover is never a printed step.
    expect(stale?.nextCommands?.join("\n")).not.toContain("worktree takeover");

    const before = repositorySnapshot(fixture.root);
    const leaseBefore = readFileSync(
      loopLeasePath(
        captureInventory(fixture.root).repository.commonGitDirectory
      ),
      "utf8"
    );
    const result = takeoverWorktreeClaim(takeoverOptions(author, current));

    // The claim now records the exact state the approval named.
    expect(result.claim).toMatchObject({
      branch: "author-work-continued",
      changeDigest: current.changeDigest,
      claimId: author.claimId,
      headSha: current.headSha,
      owner: {
        adapter: "claude-code",
        agentId: "controller",
        ownerRef: "takeover:the-user",
      },
    });
    expect(result.receipt).toMatchObject({
      action: "reassign",
      approvedBy: "the-user",
      branch: "author-work-continued",
      changeDigest: current.changeDigest,
      headSha: current.headSha,
      newAgentId: "controller",
      phase: "completed",
      previousOwner: { agentId: "vanished-author", ownerRef: "gone-session" },
    });
    // The takeover touches no file, ref, or lease field.
    expect(repositorySnapshot(fixture.root)).toBe(before);
    expect(
      readFileSync(
        loopLeasePath(
          captureInventory(fixture.root).repository.commonGitDirectory
        ),
        "utf8"
      )
    ).toBe(leaseBefore);
    expect(readFileSync(join(authorPath, "feature.ts"), "utf8")).toBe(
      "export const feature = 2;\n"
    );

    claimPauseAccept(author);

    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(readLoopLease(fixture.root)?.worktrees).toContainEqual(
      expect.objectContaining({
        baselineHeadSha: current.headSha,
        branch: "author-work-continued",
        claimId: author.claimId,
        coordinationState: "adopted-preserved",
        path: authorPath,
        role: "preserved",
      })
    );
    expect(repositorySnapshot(fixture.root)).toBe(before);
    expectScopeOpenAndOneController(author);
    // The run still prepares new authors for this shipment.
    expect(
      prepareAgentWorktree(fixture.root, runId, "next-author", "follow-up")
    ).toMatchObject({ agentId: "next-author" });
  });

  test("names the takeover for a checkout with no commit, with --head none", () => {
    const author = staleConcurrentAuthor("unborn");
    const { authorPath, fixture } = author;
    const current = captureInventory(fixture.root).worktrees.find(
      (worktree) => worktree.path === authorPath
    );
    expect(current?.headSha).toBeNull();
    expect(staleViolation(fixture.root, authorPath)?.message).toContain(
      `--agent-id controller --head none --branch author-unborn --status-digest ${current?.changeDigest}`
    );
  });

  test("recovers a clean detached checkout whose work the target already contains", () => {
    const author = staleConcurrentAuthor("detached-contained");
    const { authorPath, fixture } = author;
    const current = worktreeAt(fixture.root, authorPath);
    expect(current.branch).toBeNull();
    expect(current.changes).toEqual([]);

    expect(staleViolation(fixture.root, authorPath)?.message).toContain(
      `--agent-id controller --head ${current.headSha} --detached --status-digest ${current.changeDigest}`
    );
    // The approval named a branch, but the checkout is detached now.
    expect(() =>
      takeoverWorktreeClaim(
        takeoverOptions(author, current, { expectedBranch: "author-work" })
      )
    ).toThrow("re-observe the worktree");

    const before = repositorySnapshot(fixture.root);
    const result = takeoverWorktreeClaim(takeoverOptions(author, current));
    expect(result.claim).toMatchObject({
      branch: null,
      headSha: current.headSha,
      owner: { agentId: "controller" },
    });
    claimPauseAccept(author);

    expect(verifyLoop(fixture.root).ok).toBe(true);
    expect(repositorySnapshot(fixture.root)).toBe(before);
    expectScopeOpenAndOneController(author);
  });

  test("refuses any other agent, a release, and a checkout the owner moved after approval", () => {
    const author = staleConcurrentAuthor("switched-branch");
    const { authorPath, fixture, runId } = author;
    const current = worktreeAt(fixture.root, authorPath);
    const onlyController = `Run ${runId} registers ${authorPath} as a concurrent author, so while its controller is active this claim may only be reassigned to that controller`;

    expect(() =>
      takeoverWorktreeClaim(
        takeoverOptions(author, current, { newAgentId: "rescuer" })
      )
    ).toThrow(onlyController);
    expect(() =>
      takeoverWorktreeClaim(
        takeoverOptions(author, current, { action: "release" })
      )
    ).toThrow(onlyController);

    // The owner is still working: it commits after the user approved. A
    // clean checkout keeps the same status digest, so only the HEAD binding
    // refuses the approval.
    commit(authorPath, "feature.ts", "export const feature = 3;\n");
    const moved = worktreeAt(fixture.root, authorPath);
    expect(moved.changeDigest).toBe(current.changeDigest);
    expect(() =>
      takeoverWorktreeClaim(takeoverOptions(author, current))
    ).toThrow(
      `it is now on branch author-work-continued at ${moved.headSha} with status digest ${moved.changeDigest}`
    );
    // The owner switched branches at the same commit.
    git(authorPath, ["checkout", "-b", "author-work-third"]);
    expect(() => takeoverWorktreeClaim(takeoverOptions(author, moved))).toThrow(
      "re-observe the worktree"
    );
    // The owner left uncommitted work.
    writeFixture(authorPath, "draft.ts", "export const draft = true;\n");
    const third = worktreeAt(fixture.root, authorPath);
    expect(() =>
      takeoverWorktreeClaim(
        takeoverOptions(author, third, {
          expectedStatusDigest: current.changeDigest,
        })
      )
    ).toThrow("re-observe the worktree");

    const claim = readWorktreeCoordination(fixture.root).claims.find(
      (item) => item.claimId === author.claimId
    );
    expect(claim?.owner).toEqual({
      adapter: "claude-code",
      agentId: "vanished-author",
      ownerRef: "gone-session",
    });
    expect(
      readWorktreeTakeovers(
        captureInventory(fixture.root).repository.commonGitDirectory
      )
    ).toEqual([]);
    expectScopeOpenAndOneController(author);
  });

  test("keeps every other registered path protected, even from the controller", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const adoptedPath = join(fixture.base, "adopted");
    git(fixture.root, ["worktree", "add", "-b", "adopted-work", adoptedPath]);
    const claim = claimWorktree(
      fixture.root,
      "vanished-owner",
      adoptedPath,
      "codex",
      "gone-thread"
    );
    const receipt = pauseClaimedWorktree(
      fixture.root,
      "vanished-owner",
      adoptedPath,
      lease.runId,
      "preserve-in-place",
      "Paused before the owner disappeared"
    );
    adoptPausedWorktree(
      fixture.root,
      lease.runId,
      "controller",
      receipt.receiptId
    );
    const current = worktreeAt(fixture.root, adoptedPath);

    expect(() =>
      takeoverWorktreeClaim({
        action: "reassign",
        approvedBy: "the-user",
        claimId: claim.claimId,
        expectedBranch: current.branch,
        expectedHeadSha: current.headSha ?? "",
        expectedStatusDigest: current.changeDigest,
        newAgentId: "controller",
        reason: "Owner disappeared mid-loop",
        repositoryPath: fixture.root,
      })
    ).toThrow("An active loop lease still requires this claimed worktree");
  });

  test("completes a takeover interrupted after its durable intent", () => {
    const author = staleConcurrentAuthor("switched-branch");
    const { fixture } = author;
    const current = worktreeAt(fixture.root, author.authorPath);
    const options = takeoverOptions(author, current);
    process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT = author.claimId;
    try {
      expect(() => takeoverWorktreeClaim(options)).toThrow(
        "durable takeover intent"
      );
    } finally {
      Reflect.deleteProperty(
        process.env,
        "SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT"
      );
    }
    const { commonGitDirectory } = captureInventory(fixture.root).repository;
    expect(readWorktreeTakeovers(commonGitDirectory)).toEqual([
      expect.objectContaining({ claimId: author.claimId, phase: "intent" }),
    ]);
    // A retry that names another HEAD is a different approval, not this one.
    expect(() =>
      takeoverWorktreeClaim({
        ...options,
        expectedHeadSha: "0".repeat(40),
      })
    ).toThrow("re-observe the worktree");

    const recovered = takeoverWorktreeClaim(options);
    expect(recovered.receipt.phase).toBe("completed");
    expect(readWorktreeTakeovers(commonGitDirectory)).toEqual([
      recovered.receipt,
    ]);
    claimPauseAccept(author);
    expect(verifyLoop(fixture.root).ok).toBe(true);
    expectScopeOpenAndOneController(author);
  });
});

describe("takeover intent recovery", () => {
  test("a second takeover by the same agent and approver is not mistaken for the first", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "taken-twice");
    git(fixture.root, ["worktree", "add", "-b", "taken-twice", worktree]);
    const claim = claimWorktree(
      fixture.root,
      "vanished-owner",
      worktree,
      "codex",
      "gone-thread"
    );
    const optionsAt = (
      current: WorktreeInventory
    ): WorktreeTakeoverOptions => ({
      action: "reassign",
      approvedBy: "the-user",
      claimId: claim.claimId,
      expectedBranch: current.branch,
      expectedHeadSha: current.headSha ?? "",
      expectedStatusDigest: current.changeDigest,
      newAgentId: "rescuer",
      reason: "The owner no longer exists.",
      repositoryPath: fixture.root,
    });
    const first = worktreeAt(fixture.root, worktree);
    takeoverWorktreeClaim(optionsAt(first));

    // The checkout moves, and a second approved takeover of the new state is
    // interrupted after its durable intent.
    commit(worktree, "later.ts", "export const later = true;\n");
    const second = worktreeAt(fixture.root, worktree);
    process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT = claim.claimId;
    try {
      expect(() => takeoverWorktreeClaim(optionsAt(second))).toThrow(
        "durable takeover intent"
      );
    } finally {
      Reflect.deleteProperty(
        process.env,
        "SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT"
      );
    }

    // If the checkout moves again, the retry is refused: the earlier
    // takeover's owner marker does not prove this one applied.
    commit(worktree, "again.ts", "export const again = true;\n");
    expect(() => takeoverWorktreeClaim(optionsAt(second))).toThrow(
      "re-observe the worktree"
    );
    git(worktree, ["reset", "--hard", "HEAD~1"]);

    const retried = takeoverWorktreeClaim(optionsAt(second));
    expect(retried.receipt).toMatchObject({
      headSha: second.headSha,
      phase: "completed",
    });
    expect(
      readWorktreeCoordination(fixture.root).claims.find(
        (item) => item.claimId === claim.claimId
      )
    ).toMatchObject({ headSha: second.headSha, owner: { agentId: "rescuer" } });
    expect(
      readWorktreeTakeovers(
        captureInventory(fixture.root).repository.commonGitDirectory
      ).map((receipt) => [receipt.headSha, receipt.phase])
    ).toEqual([
      [first.headSha, "completed"],
      [second.headSha, "completed"],
    ]);
  });

  test("a release intent completes only when a takeover released the claim", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "released-meanwhile");
    git(fixture.root, [
      "worktree",
      "add",
      "-b",
      "released-meanwhile",
      worktree,
    ]);
    const claim = claimWorktree(fixture.root, "owner", worktree, "codex");
    const current = worktreeAt(fixture.root, worktree);
    const options: WorktreeTakeoverOptions = {
      action: "release",
      approvedBy: "the-user",
      claimId: claim.claimId,
      expectedBranch: current.branch,
      expectedHeadSha: current.headSha ?? "",
      expectedStatusDigest: current.changeDigest,
      newAgentId: "rescuer",
      reason: "The owner no longer exists.",
      repositoryPath: fixture.root,
    };
    process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT = claim.claimId;
    try {
      expect(() => takeoverWorktreeClaim(options)).toThrow(
        "durable takeover intent"
      );
    } finally {
      Reflect.deleteProperty(
        process.env,
        "SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT"
      );
    }
    // The owner turned out to be alive and released the claim itself.
    releaseWorktreeClaim(fixture.root, "owner", claim.claimId);
    expect(() => takeoverWorktreeClaim(options)).toThrow(
      "only a live claim can be taken over"
    );
    expect(
      readWorktreeTakeovers(
        captureInventory(fixture.root).repository.commonGitDirectory
      ).map((receipt) => receipt.phase)
    ).toEqual(["intent"]);
  });
});

describe("worktree takeover command", () => {
  const run = (cwd: string, args: string[]) => {
    const result = spawnSync(["bun", cliPath, ...args], {
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

  test("needs the exact HEAD and exactly one of --branch or --detached", () => {
    const fixture = repository();
    const worktree = join(fixture.base, "abandoned");
    git(fixture.root, ["worktree", "add", "-b", "abandoned-work", worktree]);
    const claim = claimWorktree(
      fixture.root,
      "vanished-owner",
      worktree,
      "codex"
    );
    const current = worktreeAt(fixture.root, worktree);
    const base = [
      "worktree",
      "takeover",
      "--claim-id",
      claim.claimId,
      "--agent-id",
      "rescuer",
      "--status-digest",
      current.changeDigest,
      "--approved-by",
      "the-user",
      "--reason",
      "The owner no longer exists.",
      "--repo",
      fixture.root,
    ];
    const head = ["--head", current.headSha ?? ""];

    const missingHead = run(fixture.root, [
      ...base,
      "--branch",
      "abandoned-work",
    ]);
    expect(missingHead.exitCode).toBe(2);
    expect(missingHead.stderr).toContain("--head");
    for (const branch of [[], ["--branch", "abandoned-work", "--detached"]]) {
      const result = run(fixture.root, [...base, ...head, ...branch]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "exactly one of --branch NAME or --detached"
      );
    }
    const detached = run(fixture.root, [...base, ...head, "--detached"]);
    expect(detached.exitCode).toBe(5);
    expect(detached.stderr).toContain("re-observe the worktree");
    const shortHead = run(fixture.root, [
      ...base,
      "--head",
      (current.headSha ?? "").slice(0, 12),
      "--branch",
      "abandoned-work",
    ]);
    expect(shortHead.exitCode).toBe(2);
    expect(shortHead.stderr).toContain("full commit ID");

    const reassigned = run(fixture.root, [
      ...base,
      ...head,
      "--branch",
      "abandoned-work",
      "--json",
    ]);
    expect(reassigned.exitCode).toBe(0);
    expect(JSON.parse(reassigned.stdout)).toMatchObject({
      claim: { owner: { agentId: "rescuer", ownerRef: "takeover:the-user" } },
      receipt: { branch: "abandoned-work", headSha: current.headSha },
    });
  });
});
