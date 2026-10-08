import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import type {
  RepositoryAuthoring,
  ResolvedAuthoringRole,
  ResolvedReviewRole,
} from "../../../skills/simple-changes/scripts/lib/authoring.ts";
import {
  captureInventory,
  locateRepository,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  executeLoopMutation,
  finalizeLoop,
  loopLeasePath,
  loopLockPath,
  prepareAgentWorktree,
  startLoop,
  withLoopStateLock,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  DEFAULT_POLICY,
  writePolicyFile,
} from "../../../skills/simple-changes/scripts/lib/policy.ts";
import {
  type AcceptanceDecision,
  type Attestation,
  applyReplayRecord,
  attestCommits,
  type CoverageWaiver,
  emptyReviewLedger,
  escalatedEffort,
  evaluateReviewAcceptance,
  headCoverage,
  heldLoopLock,
  loadReviewLedgerForResume,
  type ReplayCheck,
  type ReviewLedger,
  type ReviewLedgerResumeState,
  type RuntimeIdentity,
  readReviewLedger,
  recordProposalAuthors,
  recordReviewAttempt,
  resolveEffectiveAuthors,
  resolveReviewer,
  reviewApproval,
  reviewLedgerPath,
  validateReviewLedger,
  verifyReplay,
  waiveProposalCoverage,
  writeReviewLedger,
} from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import {
  validateSchema,
  validateSchemaDocument,
} from "../../../skills/simple-changes/scripts/lib/schema.ts";
import {
  claimWorktree,
  releaseWorktreeClaim,
  worktreeCoordinationPath,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(120_000);

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
const schemaPath = fileURLToPath(
  new URL(
    "../../../skills/simple-changes/evals/schemas/review-ledger.schema.json",
    import.meta.url
  )
);
const initializationSchemaPath = fileURLToPath(
  new URL(
    "../../../skills/simple-changes/evals/schemas/initialization.schema.json",
    import.meta.url
  )
);
const decoder = new TextDecoder();

// The reviewer block initialization reports must fit its closed schema.
const reviewerShape = <T>(value: T): T => {
  const schema = JSON.parse(readFileSync(initializationSchemaPath, "utf8")) as {
    properties: { reviewer: Record<string, unknown> };
  };
  return validateSchemaDocument<T>(
    "initialization reviewer",
    schema.properties.reviewer,
    value
  );
};
const STAMP = "2026-10-08T12:00:00.000Z";
const PROPOSAL = "group/project!42";

// Harness sessions the adapter recognizes; the test harness strips the real
// ones in its preload, so each test names the session it runs as.
const ENV_A = { CLAUDE_CODE_SESSION_ID: "session-a" };
const ENV_B = { CODEX_THREAD_ID: "thread-b" };

const fakeSha = (value: number): string => value.toString(16).padStart(40, "0");

const author = (
  name: string,
  overrides: Partial<Attestation> = {}
): Attestation => ({
  agent: `model-${name}`,
  harness: "claude-code",
  instance: `instance-${name}`,
  logicalId: `agent-${name}`,
  recordedAt: STAMP,
  session: `session-${name}`,
  ...overrides,
});

const asReviewer = (attestation: Attestation): RuntimeIdentity => ({
  agent: attestation.agent,
  harness: attestation.harness,
  instance: attestation.instance,
  session: attestation.session,
});

const attestInMemory = (
  ledger: ReviewLedger,
  commit: string,
  attestation: Attestation
): void => {
  ledger.attestations[commit] = [
    ...(ledger.attestations[commit] ?? []),
    attestation,
  ];
};

const replayInMemory = (
  ledger: ReviewLedger,
  destination: string,
  sources: string[],
  verification: ReplayCheck["verification"]
) =>
  applyReplayRecord(
    ledger,
    destination,
    { detail: "test", orderedSources: sources, verification },
    STAMP
  );

const addHead = (
  ledger: ReviewLedger,
  head: string,
  commits: string[],
  proposalId = PROPOSAL
): void => {
  const coverage = headCoverage(ledger, commits);
  const proposal = ledger.proposals[proposalId] ?? { attempts: [], heads: {} };
  ledger.proposals[proposalId] = proposal;
  Reflect.deleteProperty(proposal.heads, head);
  proposal.heads[head] = {
    authorsDigest: coverage.authorsDigest,
    base: fakeSha(999),
    commits,
    copyAuthors: [],
    gaps: coverage.gaps,
    unattributed: coverage.unattributed,
    waivers: [],
  };
};

const decide = (
  ledger: ReviewLedger,
  head: string,
  reviewer: RuntimeIdentity,
  options: {
    adversarial?: boolean;
    proposalId?: string;
    verdict?: "clean" | "findings" | "failed";
    waiverId?: string | null;
  } = {}
): AcceptanceDecision =>
  evaluateReviewAcceptance({
    adversarial: options.adversarial ?? false,
    attempt: {
      headRevision: head,
      verdict: options.verdict ?? "clean",
      verified: reviewer,
    },
    currentHead: head,
    ledger,
    proposalId: options.proposalId ?? PROPOSAL,
    repairRequired: false,
    ...(options.waiverId === undefined ? {} : { waiverId: options.waiverId }),
  });

const waiverFor = (
  ledger: ReviewLedger,
  head: string,
  named: Pick<CoverageWaiver, "gaps" | "unattributed">,
  proposalId = PROPOSAL
): CoverageWaiver => {
  const record = ledger.proposals[proposalId]?.heads[head];
  if (!record) {
    throw new Error("head not recorded");
  }
  const waiver: CoverageWaiver = {
    ...named,
    approvedBy: "owner",
    authorsDigest: headCoverage(ledger, record.commits).authorsDigest,
    reason: "Imported vendor commit reviewed by the owner.",
    recordedAt: STAMP,
    waiverId: randomUUID(),
  };
  record.waivers.push(waiver);
  return waiver;
};

const stubAuthoring = (
  review: Partial<ResolvedReviewRole> = {},
  proposals: Partial<ResolvedAuthoringRole> = {},
  repairRequired = false
): RepositoryAuthoring =>
  ({
    effective: {
      proposals: {
        effort: "xhigh",
        harness: "claude-code",
        model: "model-alpha",
        status: "resolved",
        ...proposals,
      },
      review: {
        adversarial: false,
        effort: "xhigh",
        escalateOnFindings: null,
        harness: "codex",
        model: "model-beta",
        status: "resolved",
        ...review,
      },
    },
    repairRequired,
  }) as unknown as RepositoryAuthoring;

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const commitFile = (
  root: string,
  file: string,
  contents: string,
  extra: string[] = []
): string => {
  writeFixture(root, file, contents);
  git(root, ["add", file]);
  git(root, ["commit", "-m", `Update ${file}`, ...extra]);
  return git(root, ["rev-parse", "HEAD"]);
};

const commonDirectory = (root: string): string =>
  locateRepository(root).repository.commonGitDirectory;

interface PreparedRun {
  author: string;
  base: string;
  fixture: TestRepository;
  root: string;
  runId: string;
}

const preparedRun = (seed?: (root: string) => void): PreparedRun => {
  const fixture = repository();
  seed?.(fixture.root);
  const base = git(fixture.root, ["rev-parse", "HEAD"]);
  const lease = startLoop(fixture.root, "controller", "integrate");
  const prepared = prepareAgentWorktree(
    fixture.root,
    lease.runId,
    "author-a",
    "unit"
  );
  return {
    author: prepared.path,
    base,
    fixture,
    root: fixture.root,
    runId: lease.runId,
  };
};

const attestAsA = (cwd: string, commits: string[]) =>
  attestCommits({
    agent: "model-alpha",
    commits,
    environment: ENV_A,
    instance: "instance-a",
    logicalId: "author-a",
    repositoryPath: cwd,
  });

const reviewReceipt = (
  verified: RuntimeIdentity,
  overrides: Record<string, unknown> = {}
) => ({
  effort: "xhigh",
  effortSource: "configured",
  findingsCount: 0,
  requested: { effort: "xhigh", harness: "codex", model: "model-beta" },
  verdict: "clean",
  verified,
  ...overrides,
});

const REVIEWER_B: RuntimeIdentity = {
  agent: "model-beta",
  harness: "codex",
  instance: "reviewer-b",
  session: "thread-b",
};

const lines = (count: number, changed?: number): string =>
  Array.from({ length: count }, (_, index) =>
    index === changed ? `line ${index} changed` : `line ${index}`
  ).join("\n");

describe("author attest", () => {
  test("fills session and harness from the executing session, refuses disagreeing arguments, and appends only new identities", () => {
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    const base = {
      commits: [commit],
      environment: ENV_A,
      logicalId: "author-a",
      repositoryPath: run.author,
    };
    expect(() => attestCommits({ ...base, session: "session-z" })).toThrow(
      "disagrees with the executing session"
    );
    expect(() => attestCommits({ ...base, harness: "codex" })).toThrow(
      "disagrees with the executing harness"
    );
    const first = attestCommits({
      ...base,
      harness: "claude-code",
      session: "session-a",
    });
    expect(first.identity).toEqual({
      agent: null,
      harness: "claude-code",
      instance: null,
      logicalId: "author-a",
      session: "session-a",
    });
    expect(first.attestations).toEqual([{ commit, status: "recorded" }]);
    expect(first.eligibility).toEqual({
      basis: "registration",
      worktree: run.author,
    });
    expect(attestCommits(base).attestations).toEqual([
      { commit, status: "unchanged" },
    ]);
    // A co-author in another harness and a replacement agent reusing the
    // same logical id each keep their own identity.
    expect(
      attestCommits({
        ...base,
        agent: "model-beta",
        environment: ENV_B,
      }).attestations
    ).toEqual([{ commit, status: "recorded" }]);
    expect(
      attestCommits({ ...base, instance: "replacement-1" }).attestations
    ).toEqual([{ commit, status: "recorded" }]);
    const { ledger } = readReviewLedger(commonDirectory(run.root));
    expect(
      ledger.attestations[commit]?.map((entry) => [
        entry.harness,
        entry.session,
        entry.instance,
        entry.logicalId,
      ])
    ).toEqual([
      ["claude-code", "session-a", null, "author-a"],
      ["codex", "thread-b", null, "author-a"],
      ["claude-code", "session-a", "replacement-1", "author-a"],
    ]);
  });

  test("requires a live claim or a prepared registration, a reachable commit, and one outside the pinned baseline", () => {
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    expect(() =>
      attestCommits({
        commits: [commit],
        environment: ENV_A,
        repositoryPath: run.author,
      })
    ).toThrow("pass --agent-id or set AGENT_ID");
    expect(() =>
      attestCommits({
        commits: [commit],
        environment: ENV_A,
        logicalId: "stranger",
        repositoryPath: run.author,
      })
    ).toThrow("holds no live worktree claim");
    expect(() =>
      attestCommits({
        commits: [run.base],
        environment: { ...ENV_A, AGENT_ID: "author-a" },
        repositoryPath: run.author,
      })
    ).toThrow("pinned baseline");
    const dropped = commitFile(run.author, "dropped.txt", "gone\n");
    git(run.author, ["reset", "--hard", "HEAD~1"]);
    expect(() => attestAsA(run.author, [dropped])).toThrow("not reachable");
    expect(
      attestCommits({
        commits: [commit],
        environment: { ...ENV_A, AGENT_ID: "author-a" },
        repositoryPath: run.author,
      }).attestations
    ).toEqual([{ commit, status: "recorded" }]);

    // A claimed checkout qualifies its owner; an old author date is ignored.
    const claimedPath = join(run.fixture.base, "claimed");
    git(run.root, ["worktree", "add", "-b", "claimed-branch", claimedPath]);
    claimWorktree(run.root, "claimer", claimedPath, "test-adapter");
    const old = commitFile(claimedPath, "claimed.txt", "claimed\n", [
      "--date=2001-01-01T00:00:00",
    ]);
    const claimed = attestCommits({
      commits: [old],
      environment: ENV_B,
      logicalId: "claimer",
      repositoryPath: claimedPath,
    });
    expect(claimed.eligibility.basis).toBe("claim");
    expect(claimed.attestations).toEqual([{ commit: old, status: "recorded" }]);
  });

  test("links a replay without copying, verifies exact trees, and adds the replayer only by its own contribution", () => {
    const run = preparedRun((root) => {
      commitFile(root, "lib.txt", `${lines(20)}\n`);
    });
    const original = commitFile(run.author, "lib.txt", `${lines(20, 15)}\n`);
    attestAsA(run.author, [original]);
    // The target moves around the change; an unchanged rebase is verified.
    commitFile(run.root, "lib.txt", `top 1\ntop 2\ntop 3\n${lines(20)}\n`);
    git(run.author, ["rebase", "main"]);
    const rebased = git(run.author, ["rev-parse", "HEAD"]);
    const controllerReplay = {
      agent: "model-beta",
      environment: ENV_B,
      logicalId: "controller",
      repositoryPath: run.root,
      worktreePath: run.author,
    };
    const replayed = attestCommits({
      ...controllerReplay,
      commits: [rebased],
      replays: [original],
    });
    expect(replayed.attestations).toEqual([
      { commit: rebased, status: "not-attested" },
    ]);
    expect(replayed.replay).toMatchObject({
      destination: rebased,
      ownGaps: { uncoveredEdit: false, unresolvedSources: [] },
      sources: [original],
      status: "recorded",
      verification: "verified",
    });
    let { ledger } = readReviewLedger(commonDirectory(run.root));
    expect(Object.keys(ledger.proposals)).toEqual([]);
    expect(ledger.attestations[original]).toHaveLength(1);
    expect(ledger.attestations[rebased]).toBeUndefined();
    expect(
      resolveEffectiveAuthors(ledger, rebased).authors.map(
        (entry) => entry.logicalId
      )
    ).toEqual(["author-a"]);

    // A whitespace-only edit during a replay is inconclusive and leaves an
    // uncovered edit until the replayer attests its own contribution.
    const spaced = commitFile(run.author, "w.txt", "x = 1\n");
    attestAsA(run.author, [spaced]);
    writeFixture(run.author, "w.txt", "x = 1 \n");
    git(run.author, ["commit", "-a", "--amend", "--no-edit"]);
    const edited = git(run.author, ["rev-parse", "HEAD"]);
    const inconclusive = attestCommits({
      ...controllerReplay,
      commits: [edited],
      replays: [spaced],
    });
    expect(inconclusive.replay).toMatchObject({
      ownGaps: { uncoveredEdit: true },
      verification: "inconclusive",
    });
    ({ ledger } = readReviewLedger(commonDirectory(run.root)));
    expect(headCoverage(ledger, [edited]).gaps[edited]).toEqual({
      uncoveredEdits: [edited],
      unresolvedSources: [],
    });
    const contributed = attestCommits({
      ...controllerReplay,
      commits: [edited],
      contribution: "implementation",
      replays: [spaced],
    });
    expect(contributed.attestations).toEqual([
      { commit: edited, status: "recorded" },
    ]);
    expect(contributed.replay).toMatchObject({
      ownGaps: { uncoveredEdit: false },
      status: "unchanged",
    });
    ({ ledger } = readReviewLedger(commonDirectory(run.root)));
    expect(headCoverage(ledger, [edited]).fullyCovered).toBe(true);
    expect(
      resolveEffectiveAuthors(ledger, edited)
        .authors.map((entry) => entry.logicalId ?? "")
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(["author-a", "controller"]);
  });

  test("refuses self-links, duplicate or missing sources, and any mapping that would create a cycle", () => {
    const run = preparedRun();
    const first = commitFile(run.author, "x.txt", "same\n");
    attestAsA(run.author, [first]);
    git(run.author, ["revert", "--no-edit", "HEAD"]);
    const second = commitFile(run.author, "x.txt", "same\n");
    const replay = (commit: string, sources: string[]) =>
      attestCommits({
        commits: [commit],
        environment: ENV_A,
        logicalId: "author-a",
        replays: sources,
        repositoryPath: run.author,
      });
    expect(() => replay(second, [second])).toThrow("replay-cycle");
    expect(() => replay(second, [first, first])).toThrow("more than once");
    expect(() => replay(second, ["deadbeef"])).toThrow("not a commit object");
    // Two distinct commits adding the identical change link one way only.
    expect(replay(second, [first]).replay?.verification).toBe("verified");
    expect(() => replay(first, [second])).toThrow("replay-cycle");
  });

  test("rejects merges, non-contiguous sets, root commits and empty diffs as unsupported", () => {
    const fixture = repository();
    const { root } = fixture;
    const initial = git(root, ["rev-parse", "HEAD"]);
    const one = commitFile(root, "one.txt", "1\n");
    const two = commitFile(root, "two.txt", "2\n");
    const three = commitFile(root, "three.txt", "3\n");
    git(root, ["commit", "--allow-empty", "-m", "Empty"]);
    const empty = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-b", "side", initial]);
    commitFile(root, "side.txt", "side\n");
    git(root, ["checkout", "main"]);
    git(root, ["merge", "--no-ff", "-m", "Merge side", "side"]);
    const merge = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-b", "squash", initial]);
    writeFixture(root, "one.txt", "1\n");
    git(root, ["add", "one.txt"]);
    const squashed = commitFile(root, "two.txt", "2\n");
    const destination = squashed;
    expect(verifyReplay(root, destination, [two, one])).toMatchObject({
      orderedSources: [one, two],
      verification: "verified",
    });
    for (const [sources, detail] of [
      [[merge], "merge commit"],
      [[one, three], "contiguous"],
      [[initial], "root commit"],
      [[empty], "empty diff"],
    ] as const) {
      const check = verifyReplay(root, destination, sources);
      expect(check.verification).toBe("inconclusive");
      expect(check.detail).toContain(detail);
    }
  });

  test("accepts a controller replay only for a released or handed-off delegated worktree and only outside loop exec", async () => {
    const run = preparedRun();
    const original = commitFile(run.author, "a.txt", "a\n");
    attestAsA(run.author, [original]);
    const claim = claimWorktree(run.root, "author-a", run.author, "test");
    commitFile(run.root, "target.txt", "moved\n");
    git(run.author, ["rebase", "main"]);
    const rebased = git(run.author, ["rev-parse", "HEAD"]);
    const controllerReplay = {
      commits: [rebased],
      environment: ENV_B,
      logicalId: "controller",
      replays: [original],
      repositoryPath: run.root,
    };
    // Without --worktree the controller qualifies only for its own checkout.
    expect(() => attestCommits(controllerReplay)).toThrow("not reachable");
    expect(() =>
      attestCommits({ ...controllerReplay, worktreePath: run.author })
    ).toThrow("still claimed by author-a");
    expect(() =>
      attestCommits({
        ...controllerReplay,
        logicalId: "author-b",
        worktreePath: run.author,
      })
    ).toThrow("only from the active loop's own controller");
    releaseWorktreeClaim(run.root, "author-a", claim.claimId);
    const inside = await executeLoopMutation(
      run.root,
      run.runId,
      "controller",
      [
        process.execPath,
        cliPath,
        "author",
        "attest",
        "--commit",
        rebased,
        "--replays",
        original,
        "--worktree",
        run.author,
        "--agent-id",
        "controller",
        "--repo",
        run.root,
      ]
    ).catch((error: unknown) => error as Error);
    expect(inside).toBeInstanceOf(Error);
    expect(String((inside as Error).message)).toContain(
      "after loop exec returns"
    );
    expect(
      attestCommits({ ...controllerReplay, worktreePath: run.author }).replay
    ).toMatchObject({ status: "recorded", verification: "verified" });
  });
});

describe("effective authors and gaps", () => {
  const [A, U, S, T, V, X] = [1, 2, 3, 4, 5, 6].map(fakeSha) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const alpha = author("alpha");
  const beta = author("beta", { harness: "codex" });
  const gamma = author("gamma", { harness: "codex" });

  test("records as own gaps only sources whose effective authors are empty", () => {
    const ledger = emptyReviewLedger();
    attestInMemory(ledger, A, alpha);
    replayInMemory(ledger, S, [A], "verified");
    replayInMemory(ledger, T, [S], "verified");
    expect(ledger.replays[S]?.ownGaps).toEqual({
      uncoveredEdit: false,
      unresolvedSources: [],
    });
    expect(ledger.replays[T]?.ownGaps.unresolvedSources).toEqual([]);
    expect(headCoverage(ledger, [T])).toMatchObject({
      fullyCovered: true,
      gaps: {},
      unattributed: [],
    });
  });

  test("inherits gaps transitively and closes them only by attestation or waiver", () => {
    const ledger = emptyReviewLedger();
    attestInMemory(ledger, A, alpha);
    replayInMemory(ledger, S, [A, U], "verified");
    replayInMemory(ledger, T, [S], "verified");
    expect(ledger.replays[S]?.ownGaps.unresolvedSources).toEqual([U]);
    expect(ledger.replays[T]?.inheritedGaps.unresolvedSources).toEqual([U]);
    addHead(ledger, T, [T]);
    expect(headCoverage(ledger, [T])).toMatchObject({
      fullyCovered: false,
      gaps: { [T]: { uncoveredEdits: [], unresolvedSources: [U] } },
      unattributed: [],
    });
    // An independent reviewer still cannot be accepted on the mixed squash.
    for (const adversarial of [false, true]) {
      expect(
        decide(ledger, T, asReviewer(gamma), { adversarial }).acceptanceReason
      ).toBe("coverage-incomplete");
    }
    const waiver = waiverFor(ledger, T, {
      gaps: { [T]: { uncoveredEdits: [], unresolvedSources: [U] } },
      unattributed: [],
    });
    expect(decide(ledger, T, asReviewer(gamma))).toMatchObject({
      accepted: true,
      coverageWaiverId: waiver.waiverId,
    });
    // Approval re-checks coverage with the waiver an attempt referenced: one
    // that referenced none fails on the unnamed gap.
    ledger.proposals[PROPOSAL]?.attempts.push({
      acceptanceReason: null,
      accepted: true,
      attemptId: randomUUID(),
      authorsDigest: waiver.authorsDigest,
      coverageWaiverId: null,
      effort: "xhigh",
      effortSource: "configured",
      findingsCount: 0,
      headRevision: T,
      recordedAt: STAMP,
      requested: { effort: "xhigh", harness: "codex", model: "model-gamma" },
      verdict: "clean",
      verified: asReviewer(gamma),
    });
    expect(
      reviewApproval({
        adversarial: false,
        currentHead: T,
        freshEvidence: {
          checks: true,
          discussions: true,
          providerApproval: true,
        },
        ledger,
        proposalId: PROPOSAL,
        repairRequired: false,
      }).reasons
    ).toEqual(["coverage-incomplete"]);
    // A later attestation of U reaches T through the links: U's author is
    // now an effective author of T and cannot review it.
    const upsilon = author("upsilon");
    attestInMemory(ledger, U, upsilon);
    addHead(ledger, T, [T]);
    expect(
      resolveEffectiveAuthors(ledger, T)
        .authors.map((entry) => entry.logicalId ?? "")
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(["agent-alpha", "agent-upsilon"]);
    expect(headCoverage(ledger, [T]).fullyCovered).toBe(true);
    expect(decide(ledger, T, asReviewer(upsilon)).acceptanceReason).toBe(
      "reviewer-not-independent"
    );
  });

  test("a contribution attestation on an inconclusive replay makes the replayer an effective author of every later replay", () => {
    const ledger = emptyReviewLedger();
    attestInMemory(ledger, A, alpha);
    replayInMemory(ledger, S, [A], "inconclusive");
    replayInMemory(ledger, T, [S], "verified");
    expect(headCoverage(ledger, [T]).gaps[T]).toEqual({
      uncoveredEdits: [S],
      unresolvedSources: [],
    });
    attestInMemory(ledger, S, beta);
    addHead(ledger, T, [T]);
    expect(headCoverage(ledger, [T]).fullyCovered).toBe(true);
    expect(
      resolveEffectiveAuthors(ledger, T)
        .authors.map((entry) => entry.logicalId ?? "")
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(["agent-alpha", "agent-beta"]);
    expect(decide(ledger, T, asReviewer(beta)).acceptanceReason).toBe(
      "reviewer-not-independent"
    );
  });

  test("a corrected mapping supersedes the destination's own verification but never its inherited gaps", () => {
    const ledger = emptyReviewLedger();
    attestInMemory(ledger, A, alpha);
    replayInMemory(ledger, X, [V], "verified");
    expect(replayInMemory(ledger, S, [X], "inconclusive").status).toBe(
      "recorded"
    );
    expect(ledger.replays[S]).toMatchObject({
      inheritedGaps: { unresolvedSources: [V] },
      ownGaps: { uncoveredEdit: true },
    });
    const corrected = replayInMemory(ledger, S, [A], "verified");
    expect(corrected).toMatchObject({
      ownGaps: { uncoveredEdit: false, unresolvedSources: [] },
      sources: [A],
      status: "superseded",
      verification: "verified",
    });
    expect(ledger.replays[S]?.inheritedGaps.unresolvedSources).toEqual([V]);
    expect(headCoverage(ledger, [S]).gaps[S]?.unresolvedSources).toEqual([V]);
    expect(replayInMemory(ledger, S, [A], "verified").status).toBe("unchanged");
  });

  test("a replayed commit without --replays stays unattributed, and a replayer's edit stays uncovered", () => {
    // A implements, B rebases without --replays, A reviews: rejected.
    const rebasedLedger = emptyReviewLedger();
    attestInMemory(rebasedLedger, A, alpha);
    addHead(rebasedLedger, S, [S]);
    expect(headCoverage(rebasedLedger, [S]).unattributed).toEqual([S]);
    expect(decide(rebasedLedger, S, asReviewer(alpha)).acceptanceReason).toBe(
      "coverage-incomplete"
    );
    // A implements, B edits whitespace during replay, B reviews: rejected
    // until B attests, and then B is an author.
    const editedLedger = emptyReviewLedger();
    attestInMemory(editedLedger, A, alpha);
    replayInMemory(editedLedger, S, [A], "inconclusive");
    addHead(editedLedger, S, [S]);
    expect(decide(editedLedger, S, asReviewer(beta)).acceptanceReason).toBe(
      "coverage-incomplete"
    );
    attestInMemory(editedLedger, S, beta);
    addHead(editedLedger, S, [S]);
    expect(decide(editedLedger, S, asReviewer(beta)).acceptanceReason).toBe(
      "reviewer-not-independent"
    );
  });

  test("resolves a deep shared ancestry with each commit visited once", () => {
    const ledger = emptyReviewLedger();
    let level = [fakeSha(1000), fakeSha(1001)];
    for (const commit of level) {
      attestInMemory(ledger, commit, alpha);
    }
    let next = 2000;
    for (let depth = 0; depth < 40; depth += 1) {
      const upper = [fakeSha(next), fakeSha(next + 1)];
      next += 2;
      for (const commit of upper) {
        replayInMemory(ledger, commit, level, "verified");
      }
      level = upper;
    }
    const top = level[0] as string;
    const { authors, visited } = resolveEffectiveAuthors(ledger, top);
    expect(new Set(visited).size).toBe(visited.length);
    expect(visited.length).toBe(1 + 40 * 2);
    expect(authors.map((entry) => entry.logicalId)).toEqual(["agent-alpha"]);
    expect(headCoverage(ledger, [top]).fullyCovered).toBe(true);
  });

  test("reports a cycle in a loaded ledger as ledger-cycle", () => {
    const ledger = emptyReviewLedger();
    const record = (sources: string[]) => ({
      inheritedGaps: { uncoveredEdits: [], unresolvedSources: [] },
      ownGaps: { uncoveredEdit: false, unresolvedSources: [] },
      recordedAt: STAMP,
      sources,
      verification: "verified" as const,
    });
    ledger.replays[S] = record([T]);
    ledger.replays[T] = record([S]);
    expect(validateReviewLedger(ledger).reason).toBe("ledger-cycle");
  });
});

describe("post-return gate and approval", () => {
  const C1 = fakeSha(11);
  const C2 = fakeSha(12);

  test("executor independence compares instances and sessions, never logical ids", () => {
    const parent = author("parent", { logicalId: "shared" });
    const ledger = emptyReviewLedger();
    attestInMemory(ledger, C1, parent);
    addHead(ledger, C1, [C1]);
    const accepted = (reviewer: RuntimeIdentity) =>
      decide(ledger, C1, reviewer).acceptanceReason;
    // A background subagent: own instance, the parent's session.
    expect(
      accepted({ ...asReviewer(parent), instance: "subagent-instance" })
    ).toBeNull();
    // A separate session reusing the same logical id.
    expect(
      accepted({
        ...asReviewer(parent),
        instance: null,
        session: "other-session",
      })
    ).toBeNull();
    expect(accepted(asReviewer(parent))).toBe("reviewer-not-independent");
    expect(
      accepted({
        agent: "model-x",
        harness: "codex",
        instance: null,
        session: null,
      })
    ).toBe("independence-unproven");
    // Different logical ids in one session with no instance are not
    // independent: logical ids are never compared.
    const sameSession = emptyReviewLedger();
    attestInMemory(
      sameSession,
      C1,
      author("one", { instance: null, logicalId: "one", session: "s" })
    );
    addHead(sameSession, C1, [C1]);
    expect(
      decide(sameSession, C1, {
        agent: "model-two",
        harness: "claude-code",
        instance: null,
        session: "s",
      }).acceptanceReason
    ).toBe("reviewer-not-independent");
  });

  test("an unattributed commit fails without a waiver and passes with a waiver naming exactly that commit", () => {
    const ledger = emptyReviewLedger();
    attestInMemory(ledger, C1, author("alpha"));
    addHead(ledger, C2, [C1, C2]);
    const reviewer = asReviewer(author("gamma"));
    expect(decide(ledger, C2, reviewer).acceptanceReason).toBe(
      "coverage-incomplete"
    );
    waiverFor(ledger, C2, { gaps: {}, unattributed: [C1] });
    expect(decide(ledger, C2, reviewer).acceptanceReason).toBe(
      "coverage-incomplete"
    );
    const waiver = waiverFor(ledger, C2, { gaps: {}, unattributed: [C2] });
    expect(decide(ledger, C2, reviewer)).toMatchObject({
      accepted: true,
      coverageWaiverId: waiver.waiverId,
    });
  });

  test("diversity applies only under adversarial review, and missing model identity rejects only there", () => {
    const ledger = emptyReviewLedger();
    attestInMemory(ledger, C1, author("alpha", { agent: null }));
    addHead(ledger, C1, [C1]);
    const sameModelOtherSession = {
      agent: null,
      harness: "claude-code",
      instance: null,
      session: "session-other",
    };
    expect(decide(ledger, C1, sameModelOtherSession).accepted).toBe(true);
    expect(
      decide(ledger, C1, sameModelOtherSession, { adversarial: true })
        .acceptanceReason
    ).toBe("reviewer-identity-missing");
    expect(
      decide(
        ledger,
        C1,
        { ...sameModelOtherSession, agent: "model-beta" },
        { adversarial: true }
      ).acceptanceReason
    ).toBe("author-identity-missing");
    const named = emptyReviewLedger();
    attestInMemory(named, C1, author("alpha", { agent: "Example Model 5.5" }));
    addHead(named, C1, [C1]);
    const variant = {
      agent: "example-model-5-5",
      harness: "claude-code",
      instance: null,
      session: "session-other",
    };
    expect(
      decide(named, C1, variant, { adversarial: true }).acceptanceReason
    ).toBe("reviewer-not-distinct");
    expect(
      decide(named, C1, { ...variant, harness: "codex" }, { adversarial: true })
        .accepted
    ).toBe(true);
  });

  test("a clean verdict with missing evidence is not accepted, and a failed review never is", () => {
    const ledger = emptyReviewLedger();
    attestInMemory(
      ledger,
      C1,
      author("alpha", { instance: null, session: null })
    );
    addHead(ledger, C1, [C1]);
    expect(decide(ledger, C1, REVIEWER_B).acceptanceReason).toBe(
      "independence-unproven"
    );
    const known = emptyReviewLedger();
    attestInMemory(known, C1, author("alpha"));
    addHead(known, C1, [C1]);
    expect(
      decide(known, C1, REVIEWER_B, { verdict: "failed" }).acceptanceReason
    ).toBe("review-failed");
  });

  test("the approval predicate needs a current accepted clean attempt and still requires the fresh-evidence checks", () => {
    const ledger = emptyReviewLedger();
    attestInMemory(ledger, C1, author("alpha"));
    addHead(ledger, C1, [C1]);
    const decision = decide(ledger, C1, REVIEWER_B);
    const attemptId = randomUUID();
    ledger.proposals[PROPOSAL]?.attempts.push({
      acceptanceReason: null,
      accepted: true,
      attemptId,
      authorsDigest: decision.authorsDigest as string,
      coverageWaiverId: null,
      effort: "xhigh",
      effortSource: "configured",
      findingsCount: 0,
      headRevision: C1,
      recordedAt: STAMP,
      requested: { effort: "xhigh", harness: "codex", model: "model-beta" },
      verdict: "clean",
      verified: REVIEWER_B,
    });
    const approval = (
      fresh: Partial<{
        checks: boolean;
        discussions: boolean;
        providerApproval: boolean;
      }> = {},
      currentHead = C1
    ) =>
      reviewApproval({
        adversarial: true,
        currentHead,
        freshEvidence: {
          checks: true,
          discussions: true,
          providerApproval: true,
          ...fresh,
        },
        ledger,
        proposalId: PROPOSAL,
        repairRequired: false,
      });
    expect(approval()).toEqual({ approved: true, attemptId, reasons: [] });
    expect(approval({ checks: false })).toMatchObject({
      approved: false,
      reasons: ["checks-not-fresh"],
    });
    expect(
      approval({ discussions: false, providerApproval: false })
    ).toMatchObject({
      approved: false,
      reasons: ["discussions-unresolved", "provider-approval-missing"],
    });
    // A late co-author changes the digest: the attempt no longer counts.
    attestInMemory(ledger, C1, author("late"));
    addHead(ledger, C1, [C1]);
    expect(approval()).toMatchObject({
      approved: false,
      reasons: ["authors-digest-changed"],
    });
    // A new head makes the old one stale.
    addHead(ledger, C2, [C1, C2]);
    expect(approval({}, C1).approved).toBe(false);
  });

  test("escalation is a floor driven by verdict, never above xhigh by itself", () => {
    const findings = [{ verdict: "findings" as const }];
    expect(escalatedEffort("xhigh", "high", findings)).toEqual({
      effort: "xhigh",
      effortSource: "configured",
    });
    expect(escalatedEffort("high", "xhigh", findings)).toEqual({
      effort: "xhigh",
      effortSource: "escalation",
    });
    expect(escalatedEffort("high", "xhigh", [{ verdict: "clean" }])).toEqual({
      effort: "high",
      effortSource: "configured",
    });
    expect(escalatedEffort("medium", null, findings)).toEqual({
      effort: "medium",
      effortSource: "configured",
    });
    expect(escalatedEffort("max", "xhigh", findings).effort).toBe("max");
  });
});

describe("reviewer resolution before dispatch", () => {
  test("provisional resolution compares only under adversarial review", () => {
    const resolve = (
      review: Partial<ResolvedReviewRole>,
      proposals: Partial<ResolvedAuthoringRole> = {},
      repairRequired = false
    ) =>
      reviewerShape(
        resolveReviewer({
          authoring: stubAuthoring(review, proposals, repairRequired),
          repositoryRoot: process.cwd(),
        })
      );
    const same = { harness: "claude-code", model: "model-alpha" };
    expect(resolve(same)).toMatchObject({
      effort: "xhigh",
      effortSource: "configured",
      harness: "claude-code",
      mode: "provisional",
      model: "model-alpha",
      reason: null,
      status: "resolved",
    });
    expect(resolve({ ...same, adversarial: true })).toMatchObject({
      reason: "reviewer-not-distinct",
      status: "blocked",
    });
    expect(
      resolve({
        adversarial: true,
        harness: "claude-code",
        model: "model-beta",
      }).status
    ).toBe("resolved");
    expect(resolve({ adversarial: true }).status).toBe("resolved");
    expect(
      resolve({
        adversarial: true,
        harness: "claude-code",
        model: "most-capable",
        status: "most-capable",
      }).reason
    ).toBe("most-capable-unresolved");
    expect(resolve({ harness: "unknown", status: "unresolved" }).reason).toBe(
      "running-harness-unknown"
    );
    expect(
      resolve({ adversarial: true, status: "no-delegation" })
    ).toMatchObject({ reason: "reviewer-not-distinct", status: "blocked" });
    expect(resolve({ status: "no-delegation" }).reason).toBe("no-delegation");
    expect(resolve({}, {}, true)).toMatchObject({
      reason: "authoring-repair",
      status: "unresolved",
    });
    expect(() =>
      resolveReviewer({
        authoring: stubAuthoring(),
        proposalId: PROPOSAL,
        repositoryRoot: process.cwd(),
      })
    ).toThrow("given together");
  });
});

describe("proposal ledger commands", () => {
  test("record-authors enumerates the range, binds attestations, reports partial coverage, and keeps copy authors apart", () => {
    const run = preparedRun();
    const attested = commitFile(run.author, "a.txt", "a\n");
    attestAsA(run.author, [attested]);
    const imported = commitFile(run.author, "vendor.txt", "vendor\n");
    const verified = () =>
      resolveReviewer({
        authoring: stubAuthoring({ adversarial: true }),
        head: imported,
        proposalId: PROPOSAL,
        repositoryRoot: run.author,
      });
    expect(verified()).toMatchObject({
      mode: "verified",
      reason: "authors-not-recorded",
      status: "unresolved",
    });
    expect(() =>
      recordReviewAttempt({
        attemptId: randomUUID(),
        authoring: stubAuthoring(),
        head: imported,
        proposalId: PROPOSAL,
        receipt: reviewReceipt(REVIEWER_B),
        repositoryPath: run.author,
      })
    ).toThrow("authors-not-recorded");
    const record = (copyAuthorsReceipt?: unknown) =>
      recordProposalAuthors({
        agent: "model-alpha",
        base: run.base,
        environment: ENV_A,
        head: imported,
        proposalId: PROPOSAL,
        repositoryPath: run.author,
        ...(copyAuthorsReceipt === undefined ? {} : { copyAuthorsReceipt }),
      });
    expect(() =>
      record({ copyAuthors: [{ session: "session-z", source: "direct" }] })
    ).toThrow("disagrees with the executing session");
    expect(() => record({ copyAuthors: [], extra: true })).toThrow(
      "copy authors only"
    );
    const first = record({
      copyAuthors: [
        { source: "direct" },
        { agent: "model-delta", source: "delegated" },
      ],
    });
    expect(first).toMatchObject({
      commits: [attested, imported],
      fullyCovered: false,
      status: "recorded",
      unattributed: [imported],
    });
    expect(
      first.copyAuthors.map(({ recordedAt: _recordedAt, ...rest }) => rest)
    ).toEqual([
      {
        agent: "model-alpha",
        harness: "claude-code",
        instance: null,
        session: "session-a",
        source: "direct",
      },
      {
        agent: "model-delta",
        harness: null,
        instance: null,
        session: null,
        source: "delegated",
      },
    ]);
    expect(record()).toMatchObject({
      authorsDigest: first.authorsDigest,
      status: "unchanged",
    });
    // The description's author never counts as a change author: B wrote
    // the description, A wrote the change, so A cannot review.
    attestAsA(run.author, [imported]);
    const { ledger } = readReviewLedger(commonDirectory(run.root));
    const refreshed = ledger.proposals[PROPOSAL]?.heads[imported];
    expect(refreshed?.authorsDigest).not.toBe(first.authorsDigest);
    expect(refreshed?.unattributed).toEqual([]);
    const second = record();
    expect(second).toMatchObject({ fullyCovered: true, status: "unchanged" });
    expect(second.authorsDigest).toBe(refreshed?.authorsDigest as string);
    const blocked = resolveReviewer({
      authoring: stubAuthoring({
        adversarial: true,
        harness: "claude-code",
        model: "model-alpha",
      }),
      head: imported,
      proposalId: PROPOSAL,
      repositoryRoot: run.author,
    });
    expect(blocked).toMatchObject({
      reason: "reviewer-not-distinct",
      status: "blocked",
    });
    expect(
      resolveReviewer({
        authoring: stubAuthoring({
          harness: "claude-code",
          model: "model-alpha",
        }),
        head: imported,
        proposalId: PROPOSAL,
        repositoryRoot: run.author,
      }).status
    ).toBe("resolved");
    expect(verified()).toMatchObject({
      harness: "codex",
      proposal: { fullyCovered: true, head: imported, proposalId: PROPOSAL },
      reason: null,
      status: "resolved",
    });
    // A new commit is a new head; the newest recorded head is current.
    const next = commitFile(run.author, "b.txt", "b\n");
    attestAsA(run.author, [next]);
    const updated = recordProposalAuthors({
      base: run.base,
      environment: ENV_A,
      head: next,
      proposalId: PROPOSAL,
      repositoryPath: run.author,
    });
    expect(updated.commits).toEqual([attested, imported, next]);
    expect(updated.authorsDigest).not.toBe(second.authorsDigest);
  });

  test("record-authors runs regardless of proposalSignatures: none", () => {
    const fixture = repository();
    writePolicyFile(join(fixture.root, ".simple-changes.json"), {
      ...DEFAULT_POLICY,
      proposalSignatures: "none",
    });
    git(fixture.root, ["add", ".simple-changes.json"]);
    git(fixture.root, ["commit", "-m", "Policy"]);
    const base = git(fixture.root, ["rev-parse", "HEAD"]);
    const head = commitFile(fixture.root, "a.txt", "a\n");
    expect(captureInventory(fixture.root).policy.value.proposalSignatures).toBe(
      "none"
    );
    expect(
      recordProposalAuthors({
        base,
        environment: {},
        head,
        proposalId: "17",
        repositoryPath: fixture.root,
      })
    ).toMatchObject({ status: "recorded", unattributed: [head] });
    expect(() =>
      recordProposalAuthors({
        base,
        environment: {},
        head,
        proposalId: "bad id with spaces",
        repositoryPath: fixture.root,
      })
    ).toThrow("stable proposal id");
  });

  test("record-review is idempotent on attemptId, refuses a conflicting payload, and keeps requested and verified apart", () => {
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    attestAsA(run.author, [commit]);
    recordProposalAuthors({
      base: run.base,
      environment: ENV_A,
      head: commit,
      proposalId: PROPOSAL,
      repositoryPath: run.author,
    });
    const attemptId = randomUUID();
    const receipt = reviewReceipt(REVIEWER_B, {
      effort: "high",
      findingsCount: 2,
      requested: { effort: "high", harness: "codex", model: "model-beta" },
      verdict: "findings",
    });
    const record = (body: unknown, id = attemptId) =>
      recordReviewAttempt({
        attemptId: id,
        authoring: stubAuthoring({ adversarial: true }),
        head: commit,
        proposalId: PROPOSAL,
        receipt: body,
        repositoryPath: run.author,
      });
    const first = record(receipt);
    expect(first).toMatchObject({
      approvalCandidate: false,
      attempt: {
        acceptanceReason: null,
        accepted: true,
        findingsCount: 2,
        requested: { effort: "high", harness: "codex", model: "model-beta" },
        verdict: "findings",
        verified: REVIEWER_B,
      },
      disclosure: { mismatch: false },
      status: "recorded",
    });
    const again = record(receipt);
    expect(again.status).toBe("unchanged");
    expect(again.attempt.recordedAt).toBe(first.attempt.recordedAt);
    expect(() => record({ ...receipt, findingsCount: 3 })).toThrow(
      "different payload"
    );
    // A delegate that reports another identity than the target is disclosed
    // and gated: here it reports the author's own model and harness.
    const mismatch = record(
      reviewReceipt({
        agent: "model-alpha",
        harness: "claude-code",
        instance: "delegate",
        session: "session-delegate",
      }),
      randomUUID()
    );
    expect(mismatch.disclosure).toMatchObject({
      fields: ["harness", "model"],
      mismatch: true,
    });
    expect(mismatch.attempt).toMatchObject({
      acceptanceReason: "reviewer-not-distinct",
      accepted: false,
    });
    const requestMax = record(
      reviewReceipt(REVIEWER_B, { effort: "max", effortSource: "request" }),
      randomUUID()
    );
    expect(requestMax.attempt).toMatchObject({
      effort: "max",
      effortSource: "request",
    });
    expect(() =>
      record(
        reviewReceipt(REVIEWER_B, {
          effort: "max",
          effortSource: "escalation",
        }),
        randomUUID()
      )
    ).toThrow("escalation");
  });

  test("waive-coverage refuses a stale digest, enables dispatch on a partial head, and goes stale when the digest changes", () => {
    const run = preparedRun();
    const one = commitFile(run.author, "one.txt", "1\n");
    const two = commitFile(run.author, "two.txt", "2\n");
    const record = () =>
      recordProposalAuthors({
        base: run.base,
        environment: ENV_A,
        head: two,
        proposalId: PROPOSAL,
        repositoryPath: run.author,
      });
    const recorded = record();
    const resolution = (adversarial: boolean) =>
      reviewerShape(
        resolveReviewer({
          authoring: stubAuthoring({ adversarial }),
          head: two,
          proposalId: PROPOSAL,
          repositoryRoot: run.author,
        })
      );
    for (const adversarial of [false, true]) {
      expect(resolution(adversarial)).toMatchObject({
        proposal: { fullyCovered: false, unattributed: [one, two].sort() },
        reason: "coverage-incomplete",
        status: "unresolved",
      });
    }
    const waive = (authorsDigest: string, unattributed: string[]) =>
      waiveProposalCoverage({
        authorsDigest,
        head: two,
        proposalId: PROPOSAL,
        receipt: {
          approvedBy: "owner",
          gaps: {},
          reason: "Generated files the owner accepts.",
          unattributed,
        },
        repositoryPath: run.author,
      });
    expect(() => waive("0".repeat(64), [one, two])).toThrow(
      "not the head's current digest"
    );
    expect(() => waive(recorded.authorsDigest, [run.base])).toThrow(
      "not outstanding"
    );
    const waived = waive(recorded.authorsDigest, [one, two]);
    expect(waived).toMatchObject({ covers: true, status: "recorded" });
    expect(waive(recorded.authorsDigest, [one, two]).status).toBe("unchanged");
    expect(resolution(false)).toMatchObject({
      proposal: { coverageWaiverId: waived.waiver.waiverId },
      status: "resolved",
    });
    const accepted = recordReviewAttempt({
      attemptId: randomUUID(),
      authoring: stubAuthoring(),
      head: two,
      proposalId: PROPOSAL,
      receipt: reviewReceipt(REVIEWER_B),
      repositoryPath: run.author,
    });
    expect(accepted.attempt).toMatchObject({
      accepted: true,
      coverageWaiverId: waived.waiver.waiverId,
    });
    // An attestation changes the digest: the waiver is stale.
    attestAsA(run.author, [one]);
    const stale = recordReviewAttempt({
      attemptId: randomUUID(),
      authoring: stubAuthoring(),
      head: two,
      proposalId: PROPOSAL,
      receipt: reviewReceipt(REVIEWER_B),
      repositoryPath: run.author,
    });
    expect(stale.attempt).toMatchObject({
      acceptanceReason: "coverage-incomplete",
      accepted: false,
      coverageWaiverId: null,
    });
    const current = record();
    expect(current.unattributed).toEqual([two]);
    const renewed = waive(current.authorsDigest, [two]);
    const after = recordReviewAttempt({
      attemptId: randomUUID(),
      authoring: stubAuthoring(),
      head: two,
      proposalId: PROPOSAL,
      receipt: reviewReceipt(REVIEWER_B),
      repositoryPath: run.author,
    });
    expect(after.attempt).toMatchObject({
      accepted: true,
      coverageWaiverId: renewed.waiver.waiverId,
    });
    const { ledger } = readReviewLedger(commonDirectory(run.root));
    expect(
      Object.keys(ledger.proposals[PROPOSAL]?.attempts[0] ?? {})
    ).not.toContain("waiver");
  });

  test("escalation follows findings across a replacement revision and stays per proposal", () => {
    const run = preparedRun();
    const first = commitFile(run.author, "a.txt", "a\n");
    attestAsA(run.author, [first]);
    const recordHead = (head: string, proposalId = PROPOSAL) =>
      recordProposalAuthors({
        base: run.base,
        environment: ENV_A,
        head,
        proposalId,
        repositoryPath: run.author,
      });
    recordHead(first);
    recordHead(first, "other!7");
    const escalating = stubAuthoring({
      effort: "high",
      escalateOnFindings: "xhigh",
    });
    // A rejected attempt with findings still raises the floor.
    const rejected = recordReviewAttempt({
      attemptId: randomUUID(),
      authoring: escalating,
      head: first,
      proposalId: PROPOSAL,
      receipt: reviewReceipt(
        { ...REVIEWER_B, instance: null, session: null },
        {
          effort: "high",
          findingsCount: 1,
          verdict: "findings",
        }
      ),
      repositoryPath: run.author,
    });
    expect(rejected.attempt.accepted).toBe(false);
    const replacement = commitFile(run.author, "fix.txt", "fix\n");
    attestAsA(run.author, [replacement]);
    recordHead(replacement);
    const resolve = (
      authoring: RepositoryAuthoring,
      proposalId: string,
      head: string
    ) =>
      resolveReviewer({
        authoring,
        head,
        proposalId,
        repositoryRoot: run.author,
      });
    expect(resolve(escalating, PROPOSAL, replacement)).toMatchObject({
      effort: "xhigh",
      effortSource: "escalation",
    });
    expect(resolve(escalating, "other!7", first)).toMatchObject({
      effort: "high",
      effortSource: "configured",
    });
    expect(
      resolve(
        stubAuthoring({ effort: "high", escalateOnFindings: null }),
        PROPOSAL,
        replacement
      )
    ).toMatchObject({ effort: "high", effortSource: "configured" });
  });
});

describe("ledger state, locking, resume and finalization", () => {
  test("writes are refused without the loop lock and leave the ledger intact on failure", () => {
    const fixture = repository();
    const common = commonDirectory(fixture.root);
    const lock = { commonGitDirectory: common, operation: "test" };
    expect(() => writeReviewLedger(lock, emptyReviewLedger())).toThrow(
      "holds the loop lock"
    );
    const ledger = emptyReviewLedger();
    attestInMemory(ledger, fakeSha(1), author("alpha"));
    withLoopStateLock(common, "test", () => {
      writeReviewLedger(heldLoopLock(common, "test"), ledger);
    });
    const path = reviewLedgerPath(common);
    const before = readFileSync(path, "utf8");
    withLoopStateLock(common, "test", () => {
      const held = heldLoopLock(common, "test");
      expect(() =>
        writeReviewLedger(held, {
          ...ledger,
          schemaVersion: 2,
        } as unknown as ReviewLedger)
      ).toThrow("invalid review ledger");
      chmodSync(dirname(path), 0o500);
      try {
        expect(() => writeReviewLedger(held, emptyReviewLedger())).toThrow(
          "previous ledger is unchanged"
        );
      } finally {
        chmodSync(dirname(path), 0o700);
      }
    });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(
      readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
  });

  test("a malformed or cyclic ledger is reported, never repaired, and blocks acceptance", () => {
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    attestAsA(run.author, [commit]);
    recordProposalAuthors({
      base: run.base,
      environment: ENV_A,
      head: commit,
      proposalId: PROPOSAL,
      repositoryPath: run.author,
    });
    const common = commonDirectory(run.root);
    const path = reviewLedgerPath(common);
    const valid = readFileSync(path, "utf8");
    const parsed = JSON.parse(valid) as ReviewLedger;
    const record = (sources: string[]) => ({
      inheritedGaps: { uncoveredEdits: [], unresolvedSources: [] },
      ownGaps: { uncoveredEdit: false, unresolvedSources: [] },
      recordedAt: STAMP,
      sources,
      verification: "verified",
    });
    for (const [contents, reason] of [
      ["{ not json", "ledger-malformed"],
      [JSON.stringify({ ...parsed, extra: true }), "ledger-malformed"],
      [
        JSON.stringify({
          ...parsed,
          replays: {
            [fakeSha(1)]: record([fakeSha(2)]),
            [fakeSha(2)]: record([fakeSha(1)]),
          },
        }),
        "ledger-cycle",
      ],
    ] as const) {
      writeFileSync(path, contents);
      expect(readReviewLedger(common)).toMatchObject({
        reason,
        state: "malformed",
      });
      expect(() => attestAsA(run.author, [commit])).toThrow("malformed");
      expect(
        resolveReviewer({
          authoring: stubAuthoring(),
          head: commit,
          proposalId: PROPOSAL,
          repositoryRoot: run.author,
        })
      ).toMatchObject({ reason, status: "unresolved" });
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
    writeFileSync(path, valid);
  });

  test("resume loads the ledger under the held lock and voids attempts on a stale head or a changed digest; finalization lists attempts", () => {
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    attestAsA(run.author, [commit]);
    const recordHead = (head: string, proposalId: string) =>
      recordProposalAuthors({
        base: run.base,
        environment: ENV_A,
        head,
        proposalId,
        repositoryPath: run.author,
      });
    recordHead(commit, "digest!1");
    recordHead(commit, "stale!2");
    const review = (proposalId: string, overrides = {}) =>
      recordReviewAttempt({
        attemptId: randomUUID(),
        authoring: stubAuthoring({ escalateOnFindings: "xhigh" }),
        head: commit,
        proposalId,
        receipt: reviewReceipt(REVIEWER_B, overrides),
        repositoryPath: run.author,
      }).attempt;
    const digestAttempt = review("digest!1");
    const staleAttempt = review("stale!2", {
      findingsCount: 1,
      verdict: "findings",
    });
    expect([digestAttempt.accepted, staleAttempt.accepted]).toEqual([
      true,
      true,
    ]);
    const finalized = finalizeLoop(
      run.root,
      run.runId,
      "controller",
      "Pause for the owner",
      { awaitingUser: ["Merge both proposals?"] }
    );
    expect(finalized.receipt.reviewAttempts?.proposals).toEqual([
      {
        attempts: [
          expect.objectContaining({
            accepted: true,
            attemptId: digestAttempt.attemptId,
            verdict: "clean",
          }),
        ],
        proposalId: "digest!1",
      },
      {
        attempts: [
          expect.objectContaining({
            attemptId: staleAttempt.attemptId,
            findingsCount: 1,
            verdict: "findings",
          }),
        ],
        proposalId: "stale!2",
      },
    ]);
    // A co-author's late attestation changes the digest of both heads; a
    // new head on the second proposal makes its attempt stale.
    attestCommits({
      agent: "model-epsilon",
      commits: [commit],
      environment: { CLAUDE_CODE_SESSION_ID: "session-e" },
      logicalId: "author-a",
      repositoryPath: run.author,
    });
    const next = commitFile(run.author, "b.txt", "b\n");
    attestAsA(run.author, [next]);
    recordHead(next, "stale!2");
    const common = commonDirectory(run.root);
    let loaded: ReviewLedgerResumeState | null = null;
    let lockHeld = false;
    startLoop(run.root, "controller-2", "resume", undefined, {
      onReviewLedger: (resumed) => {
        lockHeld = existsSync(loopLockPath(common));
        loaded = resumed;
      },
    });
    expect(lockHeld).toBe(true);
    const state = loaded as unknown as ReviewLedgerResumeState;
    expect(state.state).toBe("valid");
    const byId = Object.fromEntries(
      state.proposals.map((proposal) => [proposal.proposalId, proposal])
    );
    expect(byId["digest!1"]).toMatchObject({
      attempts: [
        { revalidated: false, revalidationReason: "authors-digest-changed" },
      ],
      findingsRecorded: false,
      reviewedAttemptId: null,
    });
    expect(byId["stale!2"]).toMatchObject({
      attempts: [{ revalidated: false, revalidationReason: "stale-head" }],
      findingsRecorded: true,
      latestHead: next,
    });
    expect(() =>
      loadReviewLedgerForResume(
        { commonGitDirectory: common, operation: "x" },
        run.root
      )
    ).toThrow("holds the loop lock");
  });

  test("an older copy's state files are untouched by the ledger's presence", () => {
    const run = preparedRun();
    const claimedPath = join(run.fixture.base, "claimed");
    git(run.root, ["worktree", "add", "-b", "claimed-branch", claimedPath]);
    claimWorktree(run.root, "claimer", claimedPath, "test-adapter");
    const common = commonDirectory(run.root);
    const leaseBytes = readFileSync(loopLeasePath(common), "utf8");
    const coordinationBytes = readFileSync(
      worktreeCoordinationPath(common),
      "utf8"
    );
    const stateEntries = readdirSync(join(common, "simple-changes")).sort();
    const commit = commitFile(run.author, "a.txt", "a\n");
    attestAsA(run.author, [commit]);
    recordProposalAuthors({
      base: run.base,
      environment: ENV_A,
      head: commit,
      proposalId: PROPOSAL,
      repositoryPath: run.author,
    });
    recordReviewAttempt({
      attemptId: randomUUID(),
      authoring: stubAuthoring(),
      head: commit,
      proposalId: PROPOSAL,
      receipt: reviewReceipt(REVIEWER_B),
      repositoryPath: run.author,
    });
    expect(readFileSync(loopLeasePath(common), "utf8")).toBe(leaseBytes);
    expect(readFileSync(worktreeCoordinationPath(common), "utf8")).toBe(
      coordinationBytes
    );
    expect(readdirSync(join(common, "simple-changes")).sort()).toEqual(
      [...stateEntries, "review-ledger.json"].sort()
    );
    expect(() =>
      validateSchema("loop-lease", JSON.parse(leaseBytes))
    ).not.toThrow();
    expect(() =>
      validateSchema("worktree-coordination", JSON.parse(coordinationBytes))
    ).not.toThrow();
  });
});

describe("schema parity and the command line", () => {
  test("the packaged schema and the hand-written validator agree", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<
      string,
      unknown
    >;
    const ledger = emptyReviewLedger();
    const [A, S] = [fakeSha(1), fakeSha(2)];
    attestInMemory(ledger, A, author("alpha"));
    replayInMemory(ledger, S, [A], "inconclusive");
    addHead(ledger, S, [S]);
    const waiver = waiverFor(ledger, S, {
      gaps: { [S]: { uncoveredEdits: [S], unresolvedSources: [] } },
      unattributed: [],
    });
    ledger.proposals[PROPOSAL]?.attempts.push({
      acceptanceReason: null,
      accepted: true,
      attemptId: randomUUID(),
      authorsDigest: waiver.authorsDigest,
      coverageWaiverId: waiver.waiverId,
      effort: "xhigh",
      effortSource: "escalation",
      findingsCount: 2,
      headRevision: S,
      recordedAt: STAMP,
      requested: { effort: "xhigh", harness: "codex", model: "model-beta" },
      verdict: "findings",
      verified: REVIEWER_B,
    });
    const both = (value: unknown) => {
      let schemaValid = true;
      try {
        validateSchemaDocument("review-ledger", schema, value);
      } catch {
        schemaValid = false;
      }
      return [schemaValid, validateReviewLedger(value).reason === null];
    };
    expect(both(ledger)).toEqual([true, true]);
    const attempt = ledger.proposals[PROPOSAL]?.attempts[0];
    const variants: unknown[] = [
      { ...ledger, extra: 1 },
      { ...ledger, schemaVersion: 2 },
      { ...ledger, attestations: { [A]: [] } },
      {
        ...ledger,
        attestations: { [A]: [{ ...author("alpha"), agent: "" }] },
      },
      {
        ...ledger,
        replays: {
          [S]: { ...ledger.replays[S], verification: "verified" },
        },
      },
      ...[
        { verdict: "clean" },
        { accepted: false },
        { effort: "max" },
        { acceptanceReason: "Not A Code", accepted: false },
        { findingsCount: -1 },
      ].map((change) => ({
        ...ledger,
        proposals: {
          [PROPOSAL]: {
            ...ledger.proposals[PROPOSAL],
            attempts: [{ ...attempt, ...change }],
          },
        },
      })),
    ];
    for (const variant of variants) {
      expect(both(variant)).toEqual([false, false]);
    }
  });

  test("the commands write the ledger end to end, and prepare-agent lists author attest after every commit", () => {
    const fixture = repository();
    const config = mkdtempSync(join(tmpdir(), "simple-changes-ledger-config-"));
    const environment = {
      ...process.env,
      AGENT_ID: "unit-author",
      CLAUDE_CODE_SESSION_ID: "session-cli",
      SIMPLE_CHANGES_CONFIG_DIR: config,
      SIMPLE_CHANGES_HARNESS_ROOTS: config,
      SIMPLE_CHANGES_SKILL_ROOTS: "",
    };
    const cli = (args: string[]) => {
      const result = spawnSync([process.execPath, cliPath, ...args], {
        cwd: fixture.root,
        env: environment,
        stderr: "pipe",
        stdout: "pipe",
      });
      return {
        exitCode: result.exitCode,
        stderr: decoder.decode(result.stderr),
        stdout: decoder.decode(result.stdout),
      };
    };
    const base = git(fixture.root, ["rev-parse", "HEAD"]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const prepared = cli([
      "prepare-agent",
      "--run-id",
      lease.runId,
      "--agent-id",
      "unit-author",
      "--purpose",
      "unit",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(prepared.exitCode).toBe(0);
    const preparation = JSON.parse(prepared.stdout) as {
      afterEveryCommit: string;
      path: string;
    };
    expect(preparation.afterEveryCommit).toBe(
      `simple-changes author attest --commit <sha> --agent-id unit-author --repo ${preparation.path} --json`
    );
    const commit = commitFile(preparation.path, "a.txt", "a\n");
    const refused = cli([
      "author",
      "attest",
      "--commit",
      commit,
      "--session",
      "another-session",
      "--json",
      "--repo",
      preparation.path,
    ]);
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain("disagrees with the executing session");
    const attested = cli([
      "author",
      "attest",
      "--commit",
      commit,
      "--agent",
      "model-alpha",
      "--instance",
      "instance-cli",
      "--json",
      "--repo",
      preparation.path,
    ]);
    expect(attested.exitCode).toBe(0);
    expect(JSON.parse(attested.stdout)).toMatchObject({
      attestations: [{ commit, status: "recorded" }],
      identity: {
        agent: "model-alpha",
        harness: "claude-code",
        instance: "instance-cli",
        logicalId: "unit-author",
        session: "session-cli",
      },
    });
    const recorded = cli([
      "proposal",
      "record-authors",
      "--proposal",
      PROPOSAL,
      "--base",
      base,
      "--head",
      commit,
      "--json",
      "--repo",
      preparation.path,
    ]);
    expect(recorded.exitCode).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({
      fullyCovered: true,
      status: "recorded",
    });
    const receiptPath = join(config, "attempt.json");
    writeFileSync(receiptPath, JSON.stringify(reviewReceipt(REVIEWER_B)));
    const reviewed = cli([
      "proposal",
      "record-review",
      "--proposal",
      PROPOSAL,
      "--head",
      commit,
      "--attempt-id",
      randomUUID(),
      "--receipt",
      receiptPath,
      "--repo",
      preparation.path,
    ]);
    expect(reviewed.exitCode).toBe(0);
    expect(reviewed.stdout).toContain("verdict clean, accepted");
    const usage = cli(["proposal"]);
    expect(usage.stderr).toContain(
      "proposal requires audit, record-authors, record-review, or waive-coverage"
    );
  });
});
