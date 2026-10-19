import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptPausedWorktreeChange,
  loopLeasePath,
  loopReplanStatus,
  markWorktreeResumeReady,
  replanLoop,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import type {
  LoopLease,
  WorktreeClaim,
  WorktreePauseReceipt,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  markCoordinationResumeReady,
  pauseClaimedWorktree,
  readWorktreeCoordination,
  worktreeCoordinationPath,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// `worktree resume-ready` after an approved replan (#3): the owner's pause
// receipt for the replaced run carries over when that run's archived lease
// registered it and the checkout is still exactly that state.

setDefaultTimeout(120_000);

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

const committedWorktree = (fixture: TestRepository, name: string): string => {
  const path = join(fixture.base, name);
  git(fixture.root, ["worktree", "add", "-b", `${name}-work`, path]);
  writeFixture(path, `${name}.ts`, `export const ${name} = 1;\n`);
  git(path, ["add", `${name}.ts`]);
  git(path, ["commit", "-m", `Write ${name}`]);
  return path;
};

const pauseFor = (
  path: string,
  owner: string,
  runId: string
): WorktreePauseReceipt =>
  pauseClaimedWorktree(
    path,
    owner,
    path,
    runId,
    "preserve-in-place",
    "Pause the finished checkout for the run."
  );

const claimState = (root: string, claimId: string): WorktreeClaim | undefined =>
  readWorktreeCoordination(root).claims.find(
    (claim) => claim.claimId === claimId
  );

const editLease = (common: string, edit: (lease: LoopLease) => void): void => {
  const path = loopLeasePath(common);
  const lease = JSON.parse(readFileSync(path, "utf8")) as LoopLease;
  edit(lease);
  writeFileSync(path, `${JSON.stringify(lease, null, 2)}\n`);
};

interface ReplannedRun {
  adopted: string;
  claim: WorktreeClaim;
  common: string;
  fixture: TestRepository;
  replacedRunId: string;
  unaccepted: string;
  unacceptedClaim: WorktreeClaim;
}

/**
 * A frozen Ship run that accepted one owner's pause, while another owner
 * paused for it without being accepted, replaced through an approved replan.
 */
const replannedRun = (): ReplannedRun => {
  const fixture = repository();
  const adopted = committedWorktree(fixture, "adopted");
  const unaccepted = committedWorktree(fixture, "unaccepted");
  const first = startLoop(fixture.root, "controller", "ship");
  const claim = claimWorktree(adopted, "owner", adopted, "claude-code");
  const receipt = pauseFor(adopted, "owner", first.runId);
  acceptPausedWorktreeChange(
    fixture.root,
    first.runId,
    "controller",
    receipt.receiptId
  );
  const unacceptedClaim = claimWorktree(
    unaccepted,
    "other-owner",
    unaccepted,
    "codex"
  );
  pauseFor(unaccepted, "other-owner", first.runId);
  expect(verifyLoop(fixture.root)).toMatchObject({ ok: true });
  editLease(first.commonGitDirectory, (lease) => {
    lease.shipmentScopeFrozenAt = new Date().toISOString();
  });
  const status = loopReplanStatus(fixture.root);
  expect(
    replanLoop(fixture.root, {
      agentId: status.agentId,
      approvedBy: "the-user",
      manifestDigest: status.manifestDigest,
      reason: "Replan the frozen shipment and preserve every checkout.",
      runId: status.runId,
      statusDigest: status.statusDigest,
    }).outcome
  ).toBe("replanned");
  return {
    adopted,
    claim,
    common: first.commonGitDirectory,
    fixture,
    replacedRunId: first.runId,
    unaccepted,
    unacceptedClaim,
  };
};

const REFUSAL =
  "Resume-ready requires an owner pause receipt for this exact run";

describe("resume-ready receipts across an approved replan", () => {
  test("the next run marks the adopted claim resume-ready from the inherited receipt", () => {
    const run = replannedRun();
    const { fixture } = run;
    const next = startLoop(fixture.root, "next-controller", "ship");
    expect(next.runId).not.toBe(run.replacedRunId);
    expect(next.worktrees).toContainEqual(
      expect.objectContaining({ path: run.adopted, role: "preserved" })
    );
    expect(verifyLoop(fixture.root)).toMatchObject({ ok: true });

    const marked = markWorktreeResumeReady(
      fixture.root,
      next.runId,
      "next-controller",
      run.claim.claimId
    );
    expect(marked.targetSha).toBe(git(fixture.root, ["rev-parse", "main"]));
    expect(claimState(fixture.root, run.claim.claimId)).toMatchObject({
      resumeTarget: { runId: next.runId, targetSha: marked.targetSha },
      state: "resume-ready",
    });
  });

  test("a receipt the replaced run never accepted is refused with the owner's pause", () => {
    const run = replannedRun();
    const { fixture } = run;
    const next = startLoop(fixture.root, "next-controller", "ship");
    let refusal = "";
    try {
      markWorktreeResumeReady(
        fixture.root,
        next.runId,
        "next-controller",
        run.unacceptedClaim.claimId
      );
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain(REFUSAL);
    expect(refusal).toContain(
      `simple-changes worktree pause --agent-id other-owner --worktree ${run.unaccepted} --run-id ${next.runId} --disposition preserve-in-place`
    );
    expect(claimState(fixture.root, run.unacceptedClaim.claimId)?.state).toBe(
      "paused"
    );

    // The printed owner pause for this run is enough.
    pauseFor(run.unaccepted, "other-owner", next.runId);
    expect(
      markWorktreeResumeReady(
        fixture.root,
        next.runId,
        "next-controller",
        run.unacceptedClaim.claimId
      ).claimId
    ).toBe(run.unacceptedClaim.claimId);
  });

  test("an archive that does not match its approved intent proves nothing", () => {
    const run = replannedRun();
    const { fixture } = run;
    const next = startLoop(fixture.root, "next-controller", "ship");
    const runHistory = join(
      run.common,
      "simple-changes",
      "history",
      run.replacedRunId
    );
    const [attempt] = readdirSync(runHistory).filter((name) =>
      name.startsWith("replan-")
    );
    const archive = join(runHistory, attempt ?? "", "replan-lease.json");
    const original = readFileSync(archive, "utf8");
    writeFileSync(archive, `${original}\n`);
    expect(() =>
      markWorktreeResumeReady(
        fixture.root,
        next.runId,
        "next-controller",
        run.claim.claimId
      )
    ).toThrow(REFUSAL);
    writeFileSync(archive, original);
    expect(
      markWorktreeResumeReady(
        fixture.root,
        next.runId,
        "next-controller",
        run.claim.claimId
      ).claimId
    ).toBe(run.claim.claimId);
  });

  test("a checkout that changed after its pause is refused", () => {
    const run = replannedRun();
    const { fixture } = run;
    // The next run registers the changed checkout as its own baseline, so
    // verification passes, but the inherited receipt no longer describes it.
    writeFixture(run.adopted, "late.ts", "export const late = 1;\n");
    const next = startLoop(fixture.root, "next-controller", "ship");
    expect(verifyLoop(fixture.root)).toMatchObject({ ok: true });
    expect(() =>
      markWorktreeResumeReady(
        fixture.root,
        next.runId,
        "next-controller",
        run.claim.claimId
      )
    ).toThrow(REFUSAL);
    expect(claimState(fixture.root, run.claim.claimId)?.state).toBe(
      "adopted-preserved"
    );
  });
});

describe("resume-ready receipts the active lease registered", () => {
  // A lease whose adopted registration names a receipt its owner gave an
  // earlier run, rather than this one.
  const earlierRunReceipt = () => {
    const fixture = repository();
    const registeredPath = committedWorktree(fixture, "registered");
    const otherPath = committedWorktree(fixture, "other");
    const lease = startLoop(fixture.root, "controller", "integrate");
    const claim = claimWorktree(
      registeredPath,
      "owner",
      registeredPath,
      "claude-code"
    );
    const receipt = pauseFor(registeredPath, "owner", "run-earlier-1");
    const other = claimWorktree(otherPath, "other-owner", otherPath, "codex");
    const otherReceipt = pauseFor(otherPath, "other-owner", "run-earlier-1");
    const register = (
      path: string,
      claimId: string,
      pauseReceiptId: string
    ): void =>
      editLease(lease.commonGitDirectory, (stored) => {
        stored.worktrees = stored.worktrees.map((worktree) =>
          worktree.path === path
            ? {
                ...worktree,
                claimId,
                coordinationState: "adopted-preserved",
                pauseReceiptId,
              }
            : worktree
        );
      });
    const markDirectly = (claimId: string) =>
      markCoordinationResumeReady(
        lease.commonGitDirectory,
        claimId,
        "controller",
        lease.runId,
        lease.targetRef,
        git(fixture.root, ["rev-parse", "main"])
      );
    return {
      claim,
      fixture,
      lease,
      markDirectly,
      other,
      otherPath,
      otherReceipt,
      receipt,
      register,
      registeredPath,
    };
  };

  test("accepts the exact earlier receipt the lease registered for the claim", () => {
    const run = earlierRunReceipt();
    run.register(run.registeredPath, run.claim.claimId, run.receipt.receiptId);
    expect(verifyLoop(run.fixture.root)).toMatchObject({ ok: true });
    // The other owner's receipt is not registered anywhere.
    expect(() =>
      markWorktreeResumeReady(
        run.fixture.root,
        run.lease.runId,
        "controller",
        run.other.claimId
      )
    ).toThrow(REFUSAL);
    expect(
      markWorktreeResumeReady(
        run.fixture.root,
        run.lease.runId,
        "controller",
        run.claim.claimId
      ).claimId
    ).toBe(run.claim.claimId);
    expect(claimState(run.fixture.root, run.claim.claimId)?.state).toBe(
      "resume-ready"
    );
  });

  test("refuses another claim's receipt and a receipt that no longer describes its claim", () => {
    const run = earlierRunReceipt();
    // A registration that names the claim with another claim's receipt
    // vouches for neither claim.
    run.register(
      run.registeredPath,
      run.claim.claimId,
      run.otherReceipt.receiptId
    );
    expect(() => run.markDirectly(run.claim.claimId)).toThrow(REFUSAL);
    expect(() => run.markDirectly(run.other.claimId)).toThrow(REFUSAL);

    // The registered receipt must still describe the claim exactly.
    run.register(run.registeredPath, run.claim.claimId, run.receipt.receiptId);
    const coordinationPath = worktreeCoordinationPath(
      run.lease.commonGitDirectory
    );
    const original = readFileSync(coordinationPath, "utf8");
    const document = JSON.parse(original) as {
      claims: Record<string, unknown>[];
    };
    document.claims = document.claims.map((item) =>
      item.claimId === run.claim.claimId
        ? { ...item, headSha: "0".repeat(40) }
        : item
    );
    writeFileSync(coordinationPath, `${JSON.stringify(document)}\n`);
    expect(() => run.markDirectly(run.claim.claimId)).toThrow(REFUSAL);
    writeFileSync(coordinationPath, original);
    expect(run.markDirectly(run.claim.claimId).state).toBe("resume-ready");
  });
});
