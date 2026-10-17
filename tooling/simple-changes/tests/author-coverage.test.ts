import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { authorCoverage } from "../../../skills/simple-changes/scripts/lib/author-coverage.ts";
import { locateRepository } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  startLoop,
  verifyLoop,
  withLoopStateLock,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  parseReadyWorkInput,
  readyReceiptsPath,
  recordReadyWork,
} from "../../../skills/simple-changes/scripts/lib/ready-work.ts";
import {
  attestCommits,
  recordProposalAuthors,
  reviewLedgerPath,
  waiveProposalCoverage,
} from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import {
  claimWorktree,
  readWorktreeCoordination,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(120_000);

const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);

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

const READY = parseReadyWorkInput({
  checks: [{ command: "bun test", result: "passed" }],
  releaseImpact: "patch",
  scope: "Adds one unit.",
});

const commitFile = (path: string, file: string, contents: string): string => {
  writeFixture(path, file, contents);
  git(path, ["add", file]);
  git(path, ["commit", "-m", `Update ${file}`]);
  return git(path, ["rev-parse", "HEAD"]);
};

interface ClaimedCheckout {
  claimId: string;
  path: string;
}

const claimedCheckout = (
  fixture: TestRepository,
  name: string,
  agentId: string,
  from = "main"
): ClaimedCheckout => {
  const path = join(fixture.base, name);
  git(fixture.root, ["worktree", "add", "-b", name, path, from]);
  const claim = claimWorktree(path, agentId, path, "test-adapter");
  return { claimId: claim.claimId, path };
};

const attest = (path: string, agentId: string, commits: string[]) =>
  attestCommits({ commits, logicalId: agentId, repositoryPath: path });

const commonDirectory = (path: string): string =>
  locateRepository(path).repository.commonGitDirectory;

const claimState = (path: string, claimId: string): string | undefined =>
  readWorktreeCoordination(path).claims.find((item) => item.claimId === claimId)
    ?.state;

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected a refusal");
};

const runCli = (
  args: string[]
): { exitCode: number; stderr: string; stdout: string } => {
  const result = spawnSync([process.execPath, cliPath, ...args], {
    env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

describe("ready-work author coverage preflight", () => {
  test("refuses an unattested commit with its exact SHA and the owner's own command, then accepts the owner's self-attestation", () => {
    const fixture = repository();
    const { claimId, path } = claimedCheckout(fixture, "unit", "author");
    const commit = commitFile(path, "unit.txt", "unit\n");

    const message = refusal(() =>
      recordReadyWork(path, "author", claimId, READY)
    );
    expect(message).toContain(`- ${commit}: no attested author`);
    expect(message).toContain(
      `simple-changes author attest --commit ${commit} --agent-id author --repo ${path}`
    );
    expect(message).toContain("never attest it for them");
    // Nothing was recorded and the claim the author attests through remains.
    expect(existsSync(readyReceiptsPath(commonDirectory(path)))).toBe(false);
    expect(claimState(path, claimId)).toBe("active");

    // A controller that holds no claim on the checkout cannot attest for it.
    expect(() => attest(fixture.root, "controller", [commit])).toThrow(
      "holds no live worktree claim"
    );

    attest(path, "author", [commit]);
    const result = recordReadyWork(path, "author", claimId, READY);
    expect(result.coverage).toMatchObject({
      commits: [commit],
      outstanding: [],
      status: "covered",
    });
    expect(result.leftUncovered).toEqual([]);
    expect(result.claim.state).toBe("released");
    // After the handoff the author's claim has ended, so it could no longer
    // attest a missed commit: the preflight is the last chance.
    expect(() => attest(path, "author", [commit])).toThrow(
      "holds no live worktree claim"
    );
  });

  test("names a replay source with no attested author and an inconclusive replay nobody attested an edit on", () => {
    const fixture = repository();
    const { claimId, path } = claimedCheckout(fixture, "replays", "author");
    const first = commitFile(path, "a.txt", "a\n");
    const second = commitFile(path, "b.txt", "b\n");
    attest(path, "author", [first]);
    git(path, ["reset", "--soft", "HEAD~2"]);
    git(path, ["commit", "-m", "Squash a and b"]);
    const squashed = git(path, ["rev-parse", "HEAD"]);
    expect(
      attestCommits({
        commits: [squashed],
        logicalId: "author",
        replays: [first, second],
        repositoryPath: path,
      }).replay?.verification
    ).toBe("verified");

    const sourceRefusal = refusal(() =>
      recordReadyWork(path, "author", claimId, READY)
    );
    expect(sourceRefusal).toContain(
      `- ${second}: replayed by ${squashed} but has no attested author`
    );
    expect(sourceRefusal).not.toContain(`- ${squashed}: no attested author`);
    expect(claimState(path, claimId)).toBe("active");

    // A squash that also changed the code is inconclusive until its edit is attested.
    const edited = claimedCheckout(fixture, "edited", "editor");
    const one = commitFile(edited.path, "c.txt", "c\n");
    const two = commitFile(edited.path, "d.txt", "d\n");
    attest(edited.path, "editor", [one, two]);
    git(edited.path, ["reset", "--soft", "HEAD~2"]);
    writeFixture(edited.path, "c.txt", "c changed while squashing\n");
    git(edited.path, ["add", "c.txt"]);
    git(edited.path, ["commit", "-m", "Squash c and d"]);
    const replayed = git(edited.path, ["rev-parse", "HEAD"]);
    expect(
      attestCommits({
        commits: [replayed],
        logicalId: "editor",
        replays: [one, two],
        repositoryPath: edited.path,
      }).replay?.verification
    ).toBe("inconclusive");
    const editRefusal = refusal(() =>
      recordReadyWork(edited.path, "editor", edited.claimId, READY)
    );
    expect(editRefusal).toContain(
      `- ${replayed}: an inconclusive replay of ${one}, ${two} that nobody attested an edit on`
    );
    expect(editRefusal).toContain(
      `simple-changes author attest --commit ${replayed} --replays ${one},${two} --contribution implementation --agent-id editor`
    );
    attestCommits({
      commits: [replayed],
      contribution: "implementation",
      logicalId: "editor",
      replays: [one, two],
      repositoryPath: edited.path,
    });
    expect(
      recordReadyWork(edited.path, "editor", edited.claimId, READY).coverage
        .status
    ).toBe("covered");
  });

  test("hands off another author's exact uncovered commits only when named, recording nothing in the ledger", () => {
    const fixture = repository();
    const other = claimedCheckout(fixture, "other", "other-author");
    const theirs = commitFile(other.path, "other.txt", "other\n");
    const stacked = claimedCheckout(fixture, "stacked", "owner", "other");
    const mine = commitFile(stacked.path, "mine.txt", "mine\n");
    attest(stacked.path, "owner", [mine]);
    const ledgerPath = reviewLedgerPath(commonDirectory(stacked.path));
    const ledgerBefore = readFileSync(ledgerPath, "utf8");

    expect(
      refusal(() =>
        recordReadyWork(stacked.path, "owner", stacked.claimId, READY)
      )
    ).toContain(`- ${theirs}: no attested author`);
    // A covered commit, an abbreviated SHA, or a partial list never passes.
    expect(() =>
      recordReadyWork(stacked.path, "owner", stacked.claimId, READY, {
        leaveUncovered: [theirs, mine],
      })
    ).toThrow(`not outstanding in ${git(fixture.root, ["rev-parse", "main"])}`);
    expect(() =>
      recordReadyWork(stacked.path, "owner", stacked.claimId, READY, {
        leaveUncovered: [theirs.slice(0, 12)],
      })
    ).toThrow("full commit SHAs");
    expect(claimState(stacked.path, stacked.claimId)).toBe("active");

    const result = recordReadyWork(
      stacked.path,
      "owner",
      stacked.claimId,
      READY,
      { leaveUncovered: [theirs] }
    );
    expect(result.coverage.status).toBe("incomplete");
    expect(result.leftUncovered).toEqual([
      {
        carriedBy: [theirs],
        kind: "unattributed",
        replaySources: [],
        sha: theirs,
      },
    ]);
    // Naming them is not a waiver and attests nothing.
    expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);

    // The controller still sees the gap, without a command to attest it.
    const status = runCli([
      "worktree",
      "status",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(JSON.parse(status.stdout).readyWork).toMatchObject([
      {
        coverage: {
          outstanding: [{ kind: "unattributed", sha: theirs }],
          status: "incomplete",
        },
        freshness: "current",
      },
    ]);
    const text = runCli(["worktree", "status", "--repo", fixture.root]).stdout;
    expect(text).toContain(
      "author coverage: incomplete; ask each commit's author to attest it, or the owner to decide"
    );
    expect(text).toContain(`- ${theirs}: no attested author`);
    expect(text).not.toContain("author attest --commit");

    // An owner waiver stays bound to its proposal head and digest: it never
    // counts as coverage here, and an attestation since makes it stale.
    const recorded = recordProposalAuthors({
      base: git(fixture.root, ["rev-parse", "main"]),
      head: git(stacked.path, ["rev-parse", "HEAD"]),
      proposalId: "group/project!7",
      repositoryPath: stacked.path,
    });
    expect(recorded.unattributed).toEqual([theirs]);
    const waived = waiveProposalCoverage({
      authorsDigest: recorded.authorsDigest,
      head: recorded.head,
      proposalId: "group/project!7",
      receipt: {
        approvedBy: "owner-user",
        gaps: {},
        reason: "Historical commit from an ended session.",
        unattributed: [theirs],
      },
      repositoryPath: stacked.path,
    });
    expect(waived.covers).toBe(true);
    const afterWaiver = authorCoverage(stacked.path, "main", recorded.head);
    expect(afterWaiver.status).toBe("incomplete");
    expect(afterWaiver.authorsDigest).toBe(recorded.authorsDigest);
    attest(other.path, "other-author", [theirs]);
    const attested = authorCoverage(stacked.path, "main", recorded.head);
    expect(attested.status).toBe("covered");
    expect(attested.authorsDigest).not.toBe(waived.waiver.authorsDigest);
  });

  test("leaves an active loop and other owners' ready work unaffected by one refusal", () => {
    const fixture = repository();
    startLoop(fixture.root, "controller", "integrate");
    const blocked = claimedCheckout(fixture, "blocked", "blocked-author");
    commitFile(blocked.path, "blocked.txt", "blocked\n");
    const ready = claimedCheckout(fixture, "ready", "ready-author");
    const readyCommit = commitFile(ready.path, "ready.txt", "ready\n");
    attest(ready.path, "ready-author", [readyCommit]);
    // The controller admits both claimed authors before either hands off.
    expect(verifyLoop(fixture.root).ok).toBe(true);

    expect(() =>
      recordReadyWork(blocked.path, "blocked-author", blocked.claimId, READY)
    ).toThrow("no attested author");
    expect(
      recordReadyWork(ready.path, "ready-author", ready.claimId, READY).claim
        .state
    ).toBe("released");
    expect(claimState(blocked.path, blocked.claimId)).toBe("active");
    expect(verifyLoop(fixture.root).ok).toBe(true);
  });

  test("holds the loop lock every ledger write takes, so no attestation lands between the check and the release", () => {
    const fixture = repository();
    const { claimId, path } = claimedCheckout(fixture, "locked", "author");
    attest(path, "author", [commitFile(path, "a.txt", "a\n")]);
    const common = commonDirectory(path);
    withLoopStateLock(common, "author attest", () => {
      expect(() => recordReadyWork(path, "author", claimId, READY)).toThrow(
        "Active-loop state is busy"
      );
    });
    expect(existsSync(readyReceiptsPath(common))).toBe(false);
    expect(claimState(path, claimId)).toBe("active");
    expect(recordReadyWork(path, "author", claimId, READY).claim.state).toBe(
      "released"
    );
  });

  test("never suggests completing an attestation a replay inherits from its source", () => {
    const fixture = repository();
    const { claimId, path } = claimedCheckout(fixture, "inherited", "author");
    const source = commitFile(path, "a.txt", "a\n");
    attestCommits({
      commits: [source],
      environment: { CLAUDE_CODE_SESSION_ID: "session-a" },
      logicalId: "author",
      repositoryPath: path,
    });
    git(path, ["commit", "--amend", "-m", "Reworded"]);
    const replayed = git(path, ["rev-parse", "HEAD"]);
    attestCommits({
      commits: [replayed],
      environment: { CLAUDE_CODE_SESSION_ID: "session-a" },
      logicalId: "author",
      replays: [source],
      repositoryPath: path,
    });
    const later = commitFile(path, "b.txt", "b\n");
    expect(authorCoverage(path, "main", later)).toMatchObject({
      incompleteIdentities: [],
      outstanding: [{ kind: "unattributed", sha: later }],
    });
    const message = refusal(() =>
      recordReadyWork(path, "author", claimId, READY)
    );
    expect(message).toContain(`- ${later}: no attested author`);
    expect(message).not.toContain("--complete-identity");
  });

  test("suggests completing the owner's own model-less attestations and refuses a malformed ledger", () => {
    const fixture = repository();
    const { claimId, path } = claimedCheckout(fixture, "identity", "author");
    const first = commitFile(path, "a.txt", "a\n");
    attestCommits({
      commits: [first],
      environment: { CLAUDE_CODE_SESSION_ID: "session-a" },
      logicalId: "author",
      repositoryPath: path,
    });
    const second = commitFile(path, "b.txt", "b\n");
    const message = refusal(() =>
      recordReadyWork(path, "author", claimId, READY)
    );
    expect(message).toContain(`- ${second}: no attested author`);
    expect(message).not.toContain(`- ${first}:`);
    expect(message).toContain(
      `Attestations under your agent id on ${first} report no model.`
    );
    expect(message).toContain(
      `simple-changes author attest --commit ${first} --agent-id author --repo ${path} --agent "<model> <version>" [--instance <id>] --complete-identity`
    );

    writeFileSync(reviewLedgerPath(commonDirectory(path)), "{ not json");
    expect(() => recordReadyWork(path, "author", claimId, READY)).toThrow(
      "is malformed ("
    );
    expect(() =>
      recordReadyWork(path, "author", claimId, READY, {
        leaveUncovered: [second],
      })
    ).toThrow("cannot be shown");
    expect(claimState(path, claimId)).toBe("active");
  });
});

describe("author coverage command", () => {
  test("reports exact outstanding commits read-only and the digest record-authors would record", () => {
    const fixture = repository();
    const { path } = claimedCheckout(fixture, "unit", "author");
    const first = commitFile(path, "a.txt", "a\n");
    const ledgerPath = reviewLedgerPath(commonDirectory(path));

    const incomplete = runCli([
      "author",
      "coverage",
      "--base",
      "main",
      "--head",
      "unit",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(incomplete.exitCode).toBe(3);
    expect(JSON.parse(incomplete.stdout)).toMatchObject({
      base: git(fixture.root, ["rev-parse", "main"]),
      commits: [first],
      ledger: { state: "absent" },
      outstanding: [{ kind: "unattributed", sha: first }],
      status: "incomplete",
      unattributed: [first],
    });
    // Read-only: no ledger appears.
    expect(existsSync(ledgerPath)).toBe(false);
    const text = runCli([
      "author",
      "coverage",
      "--base",
      "main",
      "--head",
      "unit",
      "--repo",
      fixture.root,
    ]);
    expect(text.exitCode).toBe(3);
    expect(text.stdout).toContain("incomplete; not ready for review");
    expect(text.stdout).toContain(`- ${first}: no attested author`);
    expect(text.stdout).toContain("Never attest another agent's commits.");
    expect(text.stdout).not.toContain("--agent-id");

    attest(path, "author", [first]);
    // The target moving on does not widen the range: it starts where the
    // head leaves the base.
    commitFile(fixture.root, "main.txt", "main\n");
    const covered = runCli([
      "author",
      "coverage",
      "--base",
      "main",
      "--head",
      "unit",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(covered.exitCode).toBe(0);
    const report = JSON.parse(covered.stdout) as {
      authorsDigest: string;
      base: string;
      status: string;
    };
    expect(report.status).toBe("covered");
    expect(report.authorsDigest).toBe(
      recordProposalAuthors({
        base: report.base,
        head: first,
        proposalId: "group/project!1",
        repositoryPath: path,
      }).authorsDigest
    );

    expect(
      runCli(["author", "coverage", "--head", "unit", "--repo", fixture.root])
        .exitCode
    ).toBe(2);
    writeFileSync(ledgerPath, "[]");
    const unreadable = runCli([
      "author",
      "coverage",
      "--base",
      "main",
      "--head",
      "unit",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(unreadable.exitCode).toBe(3);
    expect(JSON.parse(unreadable.stdout)).toMatchObject({
      authorsDigest: null,
      status: "ledger-unreadable",
    });
  });

  test("prints the owner's exact command through worktree release and rejects --leave-uncovered without a ready receipt", () => {
    const fixture = repository();
    const { claimId, path } = claimedCheckout(fixture, "unit", "author");
    const commit = commitFile(path, "a.txt", "a\n");
    const inputPath = join(fixture.base, "ready.json");
    writeFileSync(
      inputPath,
      `${JSON.stringify({
        checks: [{ command: "bun test", result: "passed" }],
        releaseImpact: "patch",
        scope: "Adds one unit.",
      })}\n`
    );
    const release = (extra: string[]) =>
      runCli([
        "worktree",
        "release",
        "--agent-id",
        "author",
        "--claim-id",
        claimId,
        ...extra,
        "--repo",
        path,
      ]);

    expect(release(["--leave-uncovered", commit]).exitCode).toBe(2);
    const refused = release(["--ready-receipt", inputPath]);
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain(
      `simple-changes author attest --commit ${commit} --agent-id author --repo ${path}`
    );
    attest(path, "author", [commit]);
    const released = release(["--ready-receipt", inputPath]);
    expect(released.exitCode).toBe(0);
    expect(released.stdout).toContain(
      "Author coverage: complete (1 commit the target lacks)."
    );
  });
});
