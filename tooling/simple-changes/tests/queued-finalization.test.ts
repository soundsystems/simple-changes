import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  QUEUED_FOR_REVIEW,
  queuedWorkNotices,
  readQueuedWorkRecords,
} from "../../../skills/simple-changes/scripts/lib/queued-completion.ts";
import { recordProposalAuthors } from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import { claimWorktree } from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
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
  proposalId = "example/project!7"
): void => {
  recordProposalAuthors({
    base: run.lease.targetRevision,
    head,
    proposalId,
    repositoryPath: run.root,
  });
};

const finalize = (run: OpenRun, noProposal?: string) =>
  finalizeLoop(
    run.root,
    run.lease.runId,
    "controller",
    "The change is up for review.",
    noProposal === undefined ? {} : { noProposal }
  );

const primaryState = (root: string) => ({
  branch: git(root, ["branch", "--show-current"]),
  bytes: readFileSync(join(root, "README.md"), "utf8"),
  head: git(root, ["rev-parse", "HEAD"]),
  stashes: git(root, ["stash", "list"]),
  status: git(root, ["status", "--porcelain=v1"]),
});

describe("Queue and Sweep finalization", () => {
  test("closes a Queue run whose branch is pushed with a recorded proposal, and the next request starts", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head);
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
      status: QUEUED_FOR_REVIEW,
      units: [
        {
          branch: unit.branch,
          headSha: unit.head,
          primaryCopies: ["README.md"],
          proposalIds: ["example/project!7"],
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
    // The person's uncommitted source is exactly as they left it.
    expect(primaryState(run.root)).toEqual(before);
    expect(before.status).toBe("M README.md");
    // The clean, pushed worktree is removed; its branch keeps the work.
    expect(existsSync(unit.path)).toBe(false);
    expect(result.queuedWorktrees).toEqual({ kept: [], removed: [unit.path] });
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
    expect(existsSync(silentUnit.path)).toBe(true);

    const run = openRun({});
    const unit = queueUnit(run);
    const result = finalize(run, "The shared folder remote has no reviews.");
    expect(result.outcome).toBe("completed");
    expect(result.receipt.blocksNextShipment).toBe(false);
    expect(result.receipt.queued?.units).toMatchObject([
      {
        branch: unit.branch,
        proposalIds: [],
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
    expect(first.blockers.join("\n")).toContain("proposal record-authors");
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
    const unit = queueUnit(run);
    recordProposal(run, unit.head);
    const later = `${PERSON_EDIT}Typed while the change went up.\n`;
    writeFixture(run.root, "README.md", later);

    const result = finalize(run);

    expect(result.outcome).toBe("completed");
    // The branch no longer carries a copy of what is in the checkout now.
    expect(result.receipt.queued?.units[0]?.primaryCopies).toEqual([]);
    expect(readFileSync(join(run.root, "README.md"), "utf8")).toBe(later);
    expect(queuedWorkNotices(run.root)).toEqual([]);
  });

  test("keeps a queued worktree its author still claims, and closes all the same", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head);
    claimWorktree(run.root, "author", unit.path, "test");

    const result = finalize(run);

    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.queuedWorktrees).toEqual({
      kept: [{ path: unit.path, reason: "A worktree claim still holds it." }],
      removed: [],
    });
    expect(existsSync(unit.path)).toBe(true);
    expect(startLoop(run.root, "second-agent", "queue").runId).not.toBe(
      run.lease.runId
    );
  });

  test("never removes the checkout a resumed run is controlled from", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    expect(finalize(run).outcome).toBe("relinquished");
    recordProposal(run, unit.head);
    // The next controller resumes from the run's own prepared worktree.
    startLoop(unit.path, "second-agent", "resume");

    const result = finalizeLoop(
      unit.path,
      run.lease.runId,
      "second-agent",
      "The proposal is recorded now."
    );

    expect(result.blockers).toEqual([]);
    expect(result.outcome).toBe("completed");
    expect(result.queuedWorktrees).toEqual({
      kept: [
        {
          path: unit.path,
          reason: "It is the checkout this run was controlled from.",
        },
      ],
      removed: [],
    });
    expect(existsSync(unit.path)).toBe(true);
  });

  test("closes a Sweep run with every unit queued", () => {
    const run = openRun({ forge: true, mode: "sweep" });
    const first = queueUnit(run, { agentId: "first" });
    const second = queueUnit(run, { agentId: "second", file: "notes.md" });
    recordProposal(run, first.head, "example/project!1");
    recordProposal(run, second.head, "example/project!2");

    const result = finalize(run);

    expect(result.outcome).toBe("completed");
    expect(
      result.receipt.queued?.units.map((unit) => unit.proposalIds)
    ).toEqual([["example/project!1"], ["example/project!2"]]);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });

  test("removes a run-created worktree that queued nothing, with its branch", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run, { commit: false });
    git(unit.path, ["checkout", "--", "README.md"]);

    const result = finalize(run);

    expect(result.outcome).toBe("completed");
    expect(result.receipt.queued?.units).toEqual([]);
    expect(result.receipt.queued?.summary).toContain("nothing was queued");
    expect(existsSync(unit.path)).toBe(false);
    expect(git(run.root, ["branch", "--list", unit.branch])).toBe("");
  });
});

describe("what still blocks a Queue run", () => {
  test("uncommitted work in the queued worktree", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run, { commit: false });

    const result = finalize(run);

    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join("\n")).toContain("uncommitted");
    expect(result.receipt.queued).toBeUndefined();
    expect(readFileSync(join(unit.path, "README.md"), "utf8")).toBe(
      PERSON_EDIT
    );
  });

  test("commits that were never pushed", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run, { push: false });
    recordProposal(run, unit.head);

    const result = finalize(run);

    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join("\n")).toContain("not pushed");
    expect(existsSync(unit.path)).toBe(true);
    expect(git(unit.path, ["rev-parse", "HEAD"])).toBe(unit.head);
  });

  test("a commit made after the push", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head);
    writeFixture(unit.path, "later.md", "later\n");
    git(unit.path, ["add", "later.md"]);
    git(unit.path, ["commit", "-m", "Later"]);

    const result = finalize(run);

    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join("\n")).toContain("not pushed");
    expect(existsSync(join(unit.path, "later.md"))).toBe(true);
  });

  test("a proposal never opened where one is possible, whatever the controller says", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);

    const result = finalize(run, "No time to open one.");

    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join("\n")).toContain("github can open proposals");
    expect(existsSync(unit.path)).toBe(true);
  });

  test("a target that moved so the queued branch no longer merges", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head);
    const other = join(run.base, "other");
    git(run.base, ["clone", run.remote, other]);
    git(other, ["config", "user.name", "Someone Else"]);
    git(other, ["config", "user.email", "else@simple-changes.invalid"]);
    writeFixture(other, "README.md", "# Fixture\n\nA different sentence.\n");
    git(other, ["commit", "-am", "Conflicting change"]);
    git(other, ["push", "origin", "main:main"]);
    git(run.root, ["fetch", "origin"]);

    const result = finalize(run);

    expect(result.outcome).toBe("relinquished");
    expect(result.blockers.join("\n")).toContain("no longer merges");
    expect(existsSync(unit.path)).toBe(true);
  });

  test("a target that moved without touching the queued work does not", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head);
    const other = join(run.base, "other");
    git(run.base, ["clone", run.remote, other]);
    git(other, ["config", "user.name", "Someone Else"]);
    git(other, ["config", "user.email", "else@simple-changes.invalid"]);
    writeFixture(other, "unrelated.md", "unrelated\n");
    git(other, ["add", "unrelated.md"]);
    git(other, ["commit", "-m", "Unrelated change"]);
    git(other, ["push", "origin", "main:main"]);
    git(run.root, ["fetch", "origin"]);

    expect(finalize(run).outcome).toBe("completed");
  });

  test("a pause for the user's answer", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head);

    const result = finalizeLoop(
      run.root,
      run.lease.runId,
      "controller",
      "Waiting on the person.",
      { awaitingUser: ["Should the footer change go up too?"] }
    );

    expect(result.outcome).toBe("relinquished");
    expect(result.receipt.blocksNextShipment).toBe(true);
    expect(existsSync(unit.path)).toBe(true);
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
      const unit = queueUnit(run);
      recordProposal(run, unit.head);
      const before = primaryState(run.root);

      const result = finalize(run, "Not a Queue run.");

      expect(result.outcome).toBe("relinquished");
      expect(result.receipt).toMatchObject({
        blocksNextShipment: true,
        shipmentStatus: "open",
      });
      expect(result.receipt.queued).toBeUndefined();
      expect(result.queuedWorktrees).toBeUndefined();
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
      expect(readQueuedWorkRecords(run.root)).toEqual([]);
      expect(() => startLoop(run.root, "second-agent", "queue")).toThrow(
        "was relinquished"
      );
    });
  }
});

describe("content a closed Queue run already put up", () => {
  test("is named when a later run starts with the same uncommitted bytes", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head);
    finalize(run);

    expect(readQueuedWorkRecords(run.root)).toMatchObject([
      { runId: run.lease.runId, units: [{ headSha: unit.head }] },
    ]);
    const notices = queuedWorkNotices(run.root);
    expect(notices).toMatchObject([
      {
        branch: unit.branch,
        headSha: unit.head,
        paths: ["README.md"],
        proposalIds: ["example/project!7"],
        runId: run.lease.runId,
      },
    ]);
    expect(notices[0]?.message).toContain("already queued for review");

    startLoop(run.root, "second-agent", "queue");
    const status = loopStatus(run.root);
    expect(status.alreadyQueued).toEqual(notices);
    expect(status.guidance.headline).toContain("already queued for review");
  });

  test("is not named once the person changes those bytes", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head);
    finalize(run);
    writeFixture(run.root, "README.md", `${PERSON_EDIT}One more line.\n`);

    expect(queuedWorkNotices(run.root)).toEqual([]);
  });

  test("is forgotten once the target contains the queued head", () => {
    const run = openRun({ forge: true });
    const unit = queueUnit(run);
    recordProposal(run, unit.head);
    finalize(run);
    git(run.root, ["push", "origin", `${unit.head}:main`]);
    git(run.root, ["fetch", "origin"]);

    expect(queuedWorkNotices(run.root)).toEqual([]);
    startLoop(run.root, "second-agent", "queue");
    expect(readQueuedWorkRecords(run.root)).toEqual([]);
  });
});

describe("loop status for a Queue run", () => {
  test("says the run ends queued for review, not merged", () => {
    const run = openRun({ forge: true });
    queueUnit(run);

    const { guidance } = loopStatus(run.root);

    expect(guidance.headline).toContain("queued for review, not merged");
    expect(guidance.headline).not.toContain("record its outcome");
    expect(guidance.nextCommands.join("\n")).toContain("loop finalize");
  });
});

describe("the command line", () => {
  test("reports a closed Queue run in its own words and names its content to the next run", () => {
    const run = openRun({});
    const unit = queueUnit(run);
    const cli = (args: string[]) => {
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

    const closed = cli([
      "loop",
      "finalize",
      "--run-id",
      run.lease.runId,
      "--agent-id",
      "controller",
      "--reason",
      "The change is up.",
      "--no-proposal",
      "A shared folder has no reviews.",
    ]);

    expect(closed.stderr).toBe("");
    expect(closed.exitCode).toBe(0);
    expect(closed.stdout).toContain("Queued for review, not merged");
    expect(closed.stdout).toContain(
      `Queued, not merged: ${unit.branch} at ${unit.head} on origin, pushed without a proposal (A shared folder has no reviews.)`
    );
    expect(closed.stdout).toContain(
      "it carries a copy of the primary checkout's uncommitted README.md"
    );
    expect(closed.stdout).toContain(
      `Removed its clean, pushed worktree ${unit.path}.`
    );
    expect(closed.stdout).not.toContain("Completed and released");
    expect(existsSync(unit.path)).toBe(false);

    const next = cli([
      "loop",
      "start",
      "--mode",
      "queue",
      "--agent-id",
      "second-agent",
      "--json",
    ]);
    expect(next.exitCode).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({
      alreadyQueued: [{ branch: unit.branch, paths: ["README.md"] }],
    });
  });
});
