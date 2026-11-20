import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  finalizeLoop,
  loopStatus,
  prepareAgentWorktree,
  readLoopLease,
  recordShipmentScope,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import {
  assessQueuedWork,
  QUEUED_FOR_REVIEW,
  queuedDeclarations,
} from "../../../skills/simple-changes/scripts/lib/queued-completion.ts";
import { recordProposalAuthors } from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const fixtures: TestRepository[] = [];
setDefaultTimeout(120_000);
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
});

const PERSON_EDIT = "# Fixture\n\nA sentence the person typed.\n";
const PROPOSAL = "example/project!7";

type Mode = "integrate" | "queue" | "ship" | "sweep";

interface QueuedFixtureOptions {
  /**
   * Host the bare remote under a `github.com` folder, so provider discovery
   * reads it as a forge that can always open a proposal.
   */
  forge?: boolean;
  mode?: Mode;
}

/**
 * A repository as a person left it before saying "put my change up": a
 * pushed target, an old local branch the target already contains, and one
 * uncommitted edit in the primary checkout. The run then starts in the
 * primary checkout, as the person's own agent session does.
 */
const openRun = ({ forge = false, mode = "queue" }: QueuedFixtureOptions) => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  const remote = forge
    ? join(fixture.base, "github.com", "example", "project.git")
    : join(fixture.base, "remote.git");
  mkdirSync(dirname(remote), { recursive: true });
  git(fixture.base, ["init", "--bare", "-b", "main", remote]);
  git(fixture.root, ["remote", "add", "origin", remote]);
  git(fixture.root, ["push", "-u", "origin", "main:main"]);
  git(fixture.root, ["remote", "set-head", "origin", "main"]);
  // A branch from before the run whose work the target already contains.
  git(fixture.root, ["branch", "old-merged"]);
  writeFixture(fixture.root, "README.md", PERSON_EDIT);
  const lease = startLoop(fixture.root, "controller", mode);
  return { ...fixture, lease, remote };
};

type OpenRun = ReturnType<typeof openRun>;

interface QueuedUnitOptions {
  agentId?: string;
  commit?: boolean;
  file?: string;
  push?: boolean;
}

/** Packages the person's edit in a run-prepared worktree, as Queue does. */
const queueUnit = (
  run: OpenRun,
  {
    agentId = "author",
    commit = true,
    file = "README.md",
    push = true,
  }: QueuedUnitOptions = {}
) => {
  const prepared = prepareAgentWorktree(
    run.root,
    run.lease.runId,
    agentId,
    `put up ${agentId}`
  );
  writeFixture(prepared.path, file, PERSON_EDIT);
  if (commit) {
    git(prepared.path, ["add", file]);
    git(prepared.path, ["commit", "-m", `Put up ${file}`]);
  }
  if (commit && push) {
    git(prepared.path, [
      "push",
      "-u",
      "origin",
      `${prepared.branch}:${prepared.branch}`,
    ]);
  }
  return { ...prepared, head: git(prepared.path, ["rev-parse", "HEAD"]) };
};

const recordProposal = (
  run: OpenRun,
  head: string,
  proposalId = PROPOSAL,
  base = run.lease.targetRevision,
  sourceBranch?: string
) =>
  recordProposalAuthors({
    base,
    head,
    proposalId,
    repositoryPath: run.root,
    ...(sourceBranch === undefined ? {} : { sourceBranch }),
  });

interface FinalizeOptions {
  noProposal?: string;
  /** `<branch>=<proposal id>` entries, as `--queued-proposal` takes them. */
  proposals?: string[];
}

const finalize = (
  run: OpenRun,
  { noProposal, proposals = [] }: FinalizeOptions = {}
) =>
  finalizeLoop(
    run.root,
    run.lease.runId,
    "controller",
    "The change is up for review.",
    {
      ...(noProposal === undefined ? {} : { noProposal }),
      queuedProposals: proposals,
    }
  );

/**
 * A unit pushed with its proposal recorded. Its branch is the only one at
 * that head, so the record names it as the proposal's source by itself.
 */
const proposedUnit = (run: OpenRun, options: QueuedUnitOptions = {}) => {
  const unit = queueUnit(run, options);
  recordProposal(run, unit.head);
  return { ...unit, named: [`${unit.branch}=${PROPOSAL}`] };
};

const primaryState = (root: string) => ({
  branch: git(root, ["branch", "--show-current"]),
  bytes: readFileSync(join(root, "README.md"), "utf8"),
  head: git(root, ["rev-parse", "HEAD"]),
  stashes: git(root, ["stash", "list"]),
  status: git(root, ["status", "--porcelain=v1"]),
});

/** Someone else lands a change on the target, and the run fetches it. */
const moveTarget = (run: OpenRun, file: string, contents: string): void => {
  const other = join(run.base, "other");
  git(run.base, ["clone", run.remote, other]);
  git(other, ["config", "user.name", "Someone Else"]);
  git(other, ["config", "user.email", "else@simple-changes.invalid"]);
  writeFixture(other, file, contents);
  git(other, ["add", file]);
  git(other, ["commit", "-m", "Another change"]);
  git(other, ["push", "origin", "main:main"]);
  git(run.root, ["fetch", "origin"]);
};

describe("Queue and Sweep finalization", () => {
  test("closes a Queue run whose branch is pushed with its proposal recorded, with no flag, and the next request starts", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    expect(recordProposal(run, unit.head).sourceBranch).toBe(unit.branch);
    const before = primaryState(run.root);

    const result = finalize(run);

    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.receipt).toMatchObject({
      blocksNextShipment: false,
      controllerStatus: "released",
      // Queued work is never reported as delivered or merged.
      deliveryStatus: "unverified",
      shipmentStatus: "closed",
      targetRevision: null,
    });
    expect(result.receipt.queued).toMatchObject({
      keptWorktrees: [unit.path],
      status: QUEUED_FOR_REVIEW,
      units: [
        {
          branch: unit.branch,
          headSha: unit.head,
          proposalId: PROPOSAL,
          remote: "origin",
          remoteBranch: unit.branch,
          withoutProposal: null,
          worktree: unit.path,
        },
      ],
    });
    expect(result.receipt.queued?.summary).toContain(
      "Queued for review, not merged"
    );
    expect(result.receipt.queued?.summary).toContain(
      `The run's worktree was kept for now: ${unit.path}. A later Queue or Sweep run clears a kept worktree by itself once the remote confirms its work is merged and nothing in it exists only there.`
    );
    // The person's uncommitted source is exactly as they left it.
    expect(primaryState(run.root)).toEqual(before);
    expect(before.status).toBe("M README.md");
    // Finalization deletes nothing: the run's own worktree is kept.
    expect(existsSync(unit.path)).toBe(true);
    expect(result.cleanup.removedWorktrees).toEqual([]);
    expect(result.cleanup.removedBranches).toEqual([]);
    expect(git(run.root, ["rev-parse", unit.branch])).toBe(unit.head);
    expect(git(run.remote, ["rev-parse", unit.branch])).toBe(unit.head);
    // Nothing was merged, and the old branch is neither deleted nor a blocker.
    expect(git(run.remote, ["rev-parse", "main"])).toBe(
      run.lease.targetRevision
    );
    expect(git(run.root, ["rev-parse", "old-merged"])).toBe(
      run.lease.targetRevision
    );
    expect(result.receipt.cleanupStatus).toBe("pending");
    expect(result.cleanup.notes.join("\n")).toContain("old-merged");
    expect(readLoopLease(run.root)).toBeNull();

    const next = startLoop(run.root, "second-agent", "queue");
    expect(next.runId).not.toBe(run.lease.runId);
  });

  test("closes against a remote with nowhere to open a proposal only when the controller says so", () => {
    const silent = openRun({});
    const silentUnit = queueUnit(silent);
    const refused = finalize(silent);
    expect(refused.outcome).toBe("relinquished");
    expect(refused.receipt.blocksNextShipment).toBe(true);
    expect(refused.blockers.join("\n")).toContain("--no-proposal");
    expect(refused.blockers.join("\n")).toContain(silentUnit.branch);

    const run = openRun({});
    const unit = queueUnit(run);
    const result = finalize(run, {
      noProposal: "The shared folder remote has no reviews.",
    });
    expect(result.outcome).toBe("completed");
    expect(result.receipt.blocksNextShipment).toBe(false);
    expect(result.receipt.queued?.units).toMatchObject([
      {
        branch: unit.branch,
        proposalId: null,
        withoutProposal: "The shared folder remote has no reviews.",
      },
    ]);
    expect(result.receipt.queued?.summary).toContain("without a proposal");
    expect(startLoop(run.root, "second-agent", "queue").runId).not.toBe(
      run.lease.runId
    );
  });

  test("a relinquished Queue run closes after its proposal is recorded and it is resumed", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    const first = finalize(run);
    expect(first.outcome).toBe("relinquished");
    expect(first.blockers.join("\n")).toContain(
      `proposal record-authors --proposal <id> --base ${run.lease.targetRevision} --head ${unit.head} --source-branch ${unit.branch}`
    );
    expect(() => startLoop(run.root, "second-agent", "queue")).toThrow(
      "was relinquished"
    );

    recordProposal(run, unit.head);
    const resumed = startLoop(run.root, "second-agent", "resume");
    expect(resumed.mode).toBe("queue");
    const second = finalizeLoop(
      run.root,
      run.lease.runId,
      "second-agent",
      "The proposal is recorded now."
    );
    expect(second.outcome).toBe("completed");
    expect(second.receipt.queued?.units).toHaveLength(1);
    expect(startLoop(run.root, "third-agent", "queue").runId).not.toBe(
      run.lease.runId
    );
  });

  test("the person may keep editing their checkout while the run is open", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    const later = `${PERSON_EDIT}Typed while the change went up.\n`;
    writeFixture(run.root, "README.md", later);

    const result = finalize(run, { proposals: unit.named });

    expect(result.outcome).toBe("completed");
    expect(readFileSync(join(run.root, "README.md"), "utf8")).toBe(later);
  });

  test("never removes a queued worktree, so a file Git ignores there survives", () => {
    const run = openRun({ forge: true });
    appendFileSync(join(run.root, ".git", "info", "exclude"), ".env.local\n");
    const unit = proposedUnit(run);
    writeFixture(unit.path, ".env.local", "TOKEN=only-copy\n");
    expect(git(unit.path, ["status", "--porcelain=v1"])).toBe("");

    const result = finalize(run, { proposals: unit.named });

    expect(result.outcome).toBe("completed");
    expect(result.receipt.queued?.keptWorktrees).toEqual([unit.path]);
    expect(readFileSync(join(unit.path, ".env.local"), "utf8")).toBe(
      "TOKEN=only-copy\n"
    );
    expect(git(unit.path, ["rev-parse", "HEAD"])).toBe(unit.head);
  });

  test("closes a Sweep run with every unit queued", () => {
    const run = openRun({ forge: true, mode: "sweep" });
    const first = queueUnit(run, { agentId: "first" });
    const second = queueUnit(run, { agentId: "second", file: "notes.md" });
    recordProposal(run, first.head, "example/project!1");
    recordProposal(run, second.head, "example/project!2");

    const result = finalize(run);

    expect(result.outcome).toBe("completed");
    expect(result.receipt.queued?.units.map((unit) => unit.proposalId)).toEqual(
      ["example/project!1", "example/project!2"]
    );
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });

  test("keeps a run-created worktree that queued nothing, with its branch", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run, { commit: false });
    git(unit.path, ["checkout", "--", "README.md"]);

    const result = finalize(run);

    expect(result.outcome).toBe("completed");
    expect(result.receipt.queued?.units).toEqual([]);
    expect(result.receipt.queued?.keptWorktrees).toEqual([unit.path]);
    expect(result.receipt.queued?.summary).toContain("nothing was queued");
    expect(existsSync(unit.path)).toBe(true);
    expect(git(run.root, ["rev-parse", unit.branch])).toBe(
      run.lease.targetRevision
    );
  });

  test("a queued branch whose checkout is already gone still counts", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    git(run.root, ["worktree", "remove", unit.path]);

    const result = finalize(run, { proposals: unit.named });

    expect(result.outcome).toBe("completed");
    expect(result.receipt.queued).toMatchObject({
      keptWorktrees: [],
      units: [{ branch: unit.branch, headSha: unit.head, worktree: null }],
    });
  });
});

describe("what still blocks a Queue run", () => {
  const blocked = (
    run: OpenRun,
    options: FinalizeOptions,
    message: string
  ): void => {
    const result = finalize(run, options);
    expect(result.blockers.join("\n")).toContain(message);
    expect(result.outcome).toBe("relinquished");
    expect(result.receipt.blocksNextShipment).toBe(true);
    expect(result.receipt.queued).toBeUndefined();
  };

  test("uncommitted work in the queued worktree", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run, { commit: false });

    blocked(run, {}, "uncommitted");

    expect(readFileSync(join(unit.path, "README.md"), "utf8")).toBe(
      PERSON_EDIT
    );
  });

  test("commits that were never pushed", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run, { push: false });

    blocked(run, { proposals: unit.named }, "is not pushed");

    expect(git(unit.path, ["rev-parse", "HEAD"])).toBe(unit.head);
  });

  test("a commit made after the push", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    writeFixture(unit.path, "later.md", "later\n");
    git(unit.path, ["add", "later.md"]);
    git(unit.path, ["commit", "-m", "Later"]);

    blocked(run, { proposals: unit.named }, "is not pushed");

    expect(existsSync(join(unit.path, "later.md"))).toBe(true);
  });

  test("commits in a prepared worktree that was removed before they were pushed", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run, { push: false });
    git(run.root, ["worktree", "remove", unit.path]);

    blocked(run, {}, `Queued branch ${unit.branch} at ${unit.head}`);

    // The branch, and the unpushed commit on it, are still there.
    expect(git(run.root, ["rev-parse", unit.branch])).toBe(unit.head);
  });

  test("a prepared worktree and its branch both gone", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run, { push: false });
    git(run.root, ["worktree", "remove", unit.path]);
    git(run.root, ["branch", "-D", unit.branch]);

    blocked(run, {}, "cannot be read");
  });

  test("a branch the server deleted after the push, whatever the local record says", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    git(run.remote, ["update-ref", "-d", `refs/heads/${unit.branch}`]);
    // The remote-tracking ref still names the pushed commit.
    expect(git(run.root, ["rev-parse", `origin/${unit.branch}`])).toBe(
      unit.head
    );

    blocked(run, { proposals: unit.named }, "has no such branch");

    expect(existsSync(unit.path)).toBe(true);
  });

  test("a branch the server now has at another commit", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    git(run.remote, [
      "update-ref",
      `refs/heads/${unit.branch}`,
      run.lease.targetRevision,
    ]);

    blocked(
      run,
      { proposals: unit.named },
      `is at ${run.lease.targetRevision}`
    );
  });

  test("a remote that gives no answer", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    renameSync(run.remote, `${run.remote}.offline`);

    blocked(run, { proposals: unit.named }, "Could not confirm");

    expect(existsSync(unit.path)).toBe(true);
  });

  test("a proposal never opened where one is possible, whatever the controller says", () => {
    const run = openRun({ forge: true });
    queueUnit(run);

    blocked(
      run,
      { noProposal: "No time to open one." },
      "github can open proposals"
    );
  });

  test("a proposal recorded at another head of the branch", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    writeFixture(unit.path, "later.md", "later\n");
    git(unit.path, ["add", "later.md"]);
    git(unit.path, ["commit", "-m", "Later"]);
    git(unit.path, ["push", "origin", `${unit.branch}:${unit.branch}`]);

    blocked(
      run,
      {},
      `No proposal is recorded from queued branch ${unit.branch}`
    );
    startLoop(run.root, "controller", "resume");
    blocked(
      run,
      { proposals: unit.named },
      `(it is recorded from ${unit.branch} at ${unit.head})`
    );
  });

  test("a proposal that the ledger does not record", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);

    blocked(
      run,
      { proposals: [`${unit.branch}=${PROPOSAL}`] },
      `Proposal ${PROPOSAL} is not recorded as opened from ${unit.branch}`
    );
  });

  test("a proposal recorded against a base the target does not contain", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run, { push: false });
    writeFixture(unit.path, "second.md", "second\n");
    git(unit.path, ["add", "second.md"]);
    git(unit.path, ["commit", "-m", "Second"]);
    git(unit.path, ["push", "-u", "origin", `${unit.branch}:${unit.branch}`]);
    const head = git(unit.path, ["rev-parse", "HEAD"]);
    // Recorded as a proposal onto the unit's own first commit, not the target.
    recordProposal(run, head, PROPOSAL, unit.head);

    blocked(
      run,
      { proposals: [`${unit.branch}=${PROPOSAL}`] },
      "not a proposal into this run's target"
    );
  });

  /** Two prepared branches at one commit, both pushed. */
  const twinBranches = (run: OpenRun) => {
    const first = queueUnit(run, { agentId: "first" });
    const second = prepareAgentWorktree(
      run.root,
      run.lease.runId,
      "second",
      "put up second"
    );
    git(second.path, ["merge", "--ff-only", first.head]);
    git(second.path, [
      "push",
      "-u",
      "origin",
      `${second.branch}:${second.branch}`,
    ]);
    return { first, head: first.head, second };
  };

  test("a proposal whose source branch the head alone cannot name", () => {
    const run = openRun({ forge: true, mode: "sweep" });
    const { first, head } = twinBranches(run);

    // Two branches point at the head, so nothing is recorded as the source.
    expect(recordProposal(run, head).sourceBranch).toBeNull();

    blocked(
      run,
      {},
      `No proposal is recorded from queued branch ${first.branch}`
    );
  });

  test("two proposals at one head cannot be swapped between their branches", () => {
    const run = openRun({ forge: true, mode: "sweep" });
    const { first, head, second } = twinBranches(run);
    const base = run.lease.targetRevision;
    recordProposal(run, head, "example/project!7", base, first.branch);
    recordProposal(run, head, "example/project!8", base, second.branch);

    blocked(
      run,
      {
        proposals: [
          `${first.branch}=example/project!8`,
          `${second.branch}=example/project!7`,
        ],
      },
      `Proposal example/project!8 is not recorded as opened from ${first.branch}`
    );

    // With no flag, each branch finds its own proposal.
    startLoop(run.root, "controller", "resume");
    const result = finalize(run);
    expect(result.outcome).toBe("completed");
    expect(
      result.receipt.queued?.units.map((unit) => [unit.branch, unit.proposalId])
    ).toEqual([
      [first.branch, "example/project!7"],
      [second.branch, "example/project!8"],
    ]);
  });

  test("two proposals recorded from one branch at one head, until one is named", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head, "example/project!7");
    recordProposal(run, unit.head, "example/project!8");

    blocked(
      run,
      {},
      `2 proposals are recorded from queued branch ${unit.branch} at ${unit.head} (example/project!7, example/project!8)`
    );

    startLoop(run.root, "controller", "resume");
    const result = finalize(run, {
      proposals: [`${unit.branch}=example/project!8`],
    });
    expect(result.outcome).toBe("completed");
    expect(result.receipt.queued?.units[0]?.proposalId).toBe(
      "example/project!8"
    );
  });

  test("a source branch named at a commit it does not point at is refused", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);

    expect(() =>
      recordProposal(
        run,
        unit.head,
        PROPOSAL,
        run.lease.targetRevision,
        "old-merged"
      )
    ).toThrow("--source-branch old-merged does not point at --head");
  });

  test("an edit Git's status is told not to see, in a queued worktree", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    git(unit.path, ["update-index", "--assume-unchanged", "README.md"]);
    writeFixture(unit.path, "README.md", "An edit status does not show.\n");
    expect(git(unit.path, ["status", "--porcelain=v1"])).toBe("");

    blocked(run, {}, "holds changes Git's status does not show (README.md)");

    expect(readFileSync(join(unit.path, "README.md"), "utf8")).toBe(
      "An edit status does not show.\n"
    );
  });

  test("the same hidden edit in a worktree that queued nothing", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run, { commit: false });
    git(unit.path, ["update-index", "--skip-worktree", "README.md"]);
    expect(git(unit.path, ["status", "--porcelain=v1"])).toBe("");

    blocked(run, {}, "holds changes Git's status does not show (README.md)");
  });

  test("a remote with more than one push destination", () => {
    const run = openRun({ forge: true });
    queueUnit(run);
    git(run.root, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      run.remote,
    ]);
    git(run.root, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      `${run.remote}.second`,
    ]);

    blocked(run, {}, "origin has no single push destination to ask");
  });

  test("a proposal named for a branch the run did not create", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);

    blocked(
      run,
      { proposals: [...unit.named, "old-merged=example/project!9"] },
      "old-merged, which is not a branch this run created"
    );
  });

  test("a target that cannot be resolved is a blocker, never an empty result", () => {
    const run = openRun({ forge: true });
    queueUnit(run, { push: false });
    const lease = readLoopLease(run.root) as LoopLease;
    const inventory = captureInventory(run.root);
    git(run.root, ["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]);
    git(run.root, ["update-ref", "-d", "refs/remotes/origin/main"]);

    const assessment = assessQueuedWork(
      lease,
      inventory,
      queuedDeclarations(undefined)
    );

    expect(assessment.units).toEqual([]);
    expect(assessment.blockers).toHaveLength(1);
    expect(assessment.blockers[0]).toContain("could not be resolved");
  });

  test("a target that moved so the queued branch no longer merges", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    moveTarget(run, "README.md", "# Fixture\n\nA different sentence.\n");

    blocked(run, { proposals: unit.named }, "no longer merges");
  });

  test("a target that moved without touching the queued work does not", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);
    moveTarget(run, "unrelated.md", "unrelated\n");

    expect(finalize(run, { proposals: unit.named }).outcome).toBe("completed");
  });

  test("a pause for the user's answer", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);

    const result = finalizeLoop(
      run.root,
      run.lease.runId,
      "controller",
      "Waiting on the person.",
      {
        awaitingUser: ["Should the footer change go up too?"],
        queuedProposals: unit.named,
      }
    );

    expect(result.outcome).toBe("relinquished");
    expect(result.receipt.blocksNextShipment).toBe(true);
  });

  test("a malformed proposal name is refused before anything is decided", () => {
    const run = openRun({ forge: true });
    queueUnit(run);

    expect(() => finalize(run, { proposals: ["no-separator"] })).toThrow(
      "--queued-proposal must be <branch>=<proposal id>"
    );
    expect(readLoopLease(run.root)?.controller?.status).toBe("active");
  });
});

describe("Ship and Integrate finalization of the same situation", () => {
  for (const mode of ["ship", "integrate"] as const) {
    test(`${mode} still requires merged work and a clean primary at the target`, () => {
      const run = openRun({ forge: true, mode });
      if (mode === "ship") {
        // A Ship run owes its scope before any author is prepared.
        const opening = captureInventory(run.root);
        recordShipmentScope(
          run.root,
          run.lease.runId,
          "controller",
          buildPreviewPlan(opening, opening, compareSnapshots(opening, opening))
        );
      }
      const unit = proposedUnit(run);
      const before = primaryState(run.root);

      const result = finalize(run, {
        noProposal: "Not a Queue run.",
        proposals: unit.named,
      });

      expect(result.outcome).toBe("relinquished");
      expect(result.receipt).toMatchObject({
        blocksNextShipment: true,
        shipmentStatus: "open",
      });
      expect(result.receipt.queued).toBeUndefined();
      const blockers = result.blockers.join("\n");
      expect(blockers).toContain(
        `Remove run-created worktrees before ending the loop: ${unit.path}`
      );
      expect(blockers).toContain(`Clean primary checkout ${run.root}`);
      // These modes clean up as before: the old branch the target already
      // contains is deleted, which a Queue run never does.
      expect(result.cleanup.removedBranches).toMatchObject([
        { branch: "old-merged" },
      ]);
      expect(git(run.root, ["branch", "--list", "old-merged"])).toBe("");
      expect(existsSync(unit.path)).toBe(true);
      expect(primaryState(run.root)).toEqual(before);
      expect(() => startLoop(run.root, "second-agent", "queue")).toThrow(
        "was relinquished"
      );
    });
  }
});

describe("loop status for a Queue run", () => {
  test("says the run ends queued for review, not merged, and what to record", () => {
    const run = openRun({ forge: true });
    queueUnit(run);

    const { guidance } = loopStatus(run.root);

    expect(guidance.headline).toContain("queued for review, not merged");
    expect(guidance.headline).not.toContain("record its outcome");
    expect(guidance.headline).toContain(
      "Finalize finds each branch's proposal from that record"
    );
    expect(guidance.nextCommands).toEqual([
      "simple-changes proposal record-authors --proposal <id> --base <sha> --head <sha>",
      `simple-changes loop finalize --run-id ${run.lease.runId} --agent-id controller --reason <why>`,
    ]);
  });
});

describe("the command line", () => {
  const cli = (run: OpenRun, args: string[]) => {
    const result = spawnSync(
      [process.execPath, cliPath, ...args, "--repo", run.root],
      { env: { ...process.env }, stderr: "pipe", stdout: "pipe" }
    );
    return {
      exitCode: result.exitCode,
      stderr: decoder.decode(result.stderr),
      stdout: decoder.decode(result.stdout),
    };
  };
  const finalizeArguments = (run: OpenRun) => [
    "loop",
    "finalize",
    "--run-id",
    run.lease.runId,
    "--agent-id",
    "controller",
    "--reason",
    "The change is up.",
  ];

  test("reports a closed Queue run in its own words, and the next run starts", () => {
    const run = openRun({});
    const unit = queueUnit(run);

    const closed = cli(run, [
      ...finalizeArguments(run),
      "--no-proposal",
      "A shared folder has no reviews.",
    ]);

    expect(closed.stderr).toBe("");
    expect(closed.exitCode).toBe(0);
    expect(closed.stdout).toContain("Queued for review, not merged");
    expect(closed.stdout).toContain(
      `Queued, not merged: ${unit.branch} at ${unit.head} on origin, pushed without a proposal (A shared folder has no reviews.)`
    );
    expect(closed.stdout).toContain(`Kept worktree ${unit.path}.`);
    expect(closed.stdout).not.toContain("Completed and released");
    expect(existsSync(unit.path)).toBe(true);

    const next = cli(run, [
      "loop",
      "start",
      "--mode",
      "queue",
      "--agent-id",
      "second-agent",
      "--json",
    ]);
    expect(next.exitCode).toBe(0);
  });

  test("takes each branch's proposal with --queued-proposal", () => {
    const run = openRun({ forge: true });
    const unit = proposedUnit(run);

    const closed = cli(run, [
      ...finalizeArguments(run),
      "--queued-proposal",
      unit.named[0] ?? "",
    ]);

    expect(closed.stderr).toBe("");
    expect(closed.exitCode).toBe(0);
    expect(closed.stdout).toContain(
      `Queued, not merged: ${unit.branch} at ${unit.head} on origin, proposal ${PROPOSAL}.`
    );
  });
});
