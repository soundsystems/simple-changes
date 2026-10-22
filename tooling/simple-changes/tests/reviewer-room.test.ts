import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  type AuthoringSidecar,
  REVIEW_LOOP_DEFAULTS,
  type RepositoryAuthoring,
  type ResolvedReviewRole,
} from "../../../skills/simple-changes/scripts/lib/authoring.ts";
import { locateRepository } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  prepareAgentWorktree,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  attestCommits,
  type ReviewLedger,
  recordProposalAuthors,
  recordReviewAttempt,
  reviewLedgerPath,
} from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import {
  parseVerifiedRoute,
  parseWouldAuthor,
  type ReviewerRoom,
  type RoomIdentity,
  reviewerRoom,
} from "../../../skills/simple-changes/scripts/lib/reviewer-room.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(180_000);

const decoder = new TextDecoder();
const cliPath = fileURLToPath(
  new URL(
    "../../../skills/simple-changes/scripts/simple-changes.ts",
    import.meta.url
  )
);

// Harness sessions the adapter recognizes; the preload strips the real ones.
// The first harness is the configured reviewer's; the second is another one.
const SAME = "claude-code";
const OTHER = "codex";
const ENV_SAME = { CLAUDE_CODE_SESSION_ID: "session-a" };
const ENV_SAME_SECOND = { CLAUDE_CODE_SESSION_ID: "session-c" };
const ENV_OTHER = { CODEX_THREAD_ID: "thread-b" };
const PROPOSAL = "group/project!17";
const REVIEW_MODEL = "model-review";

let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  cleanups.push(fixture.cleanup);
  return fixture;
};

const commitFile = (root: string, file: string, contents: string): string => {
  writeFixture(root, file, contents);
  git(root, ["add", file]);
  git(root, ["commit", "-m", `Update ${file}`]);
  return git(root, ["rev-parse", "HEAD"]);
};

interface Run {
  author: string;
  base: string;
  root: string;
}

const preparedRun = (): Run => {
  const fixture = repository();
  const base = git(fixture.root, ["rev-parse", "HEAD"]);
  const lease = startLoop(fixture.root, "controller", "integrate");
  const prepared = prepareAgentWorktree(
    fixture.root,
    lease.runId,
    "author-a",
    "unit"
  );
  return { author: prepared.path, base, root: fixture.root };
};

const attestAs = (
  run: Run,
  commit: string,
  agent: string,
  environment: Record<string, string>,
  instance: string
) =>
  attestCommits({
    agent,
    commits: [commit],
    environment,
    instance,
    logicalId: "author-a",
    repositoryPath: run.author,
  });

const stubAuthoring = (
  review: Partial<ResolvedReviewRole> = {},
  detected: string[] = []
): RepositoryAuthoring =>
  ({
    authoringFiles: {
      personal: { errors: [], path: "/absent/personal", state: "absent" },
      repository: { errors: [], path: "/absent/repository", state: "absent" },
    },
    detectedHarnesses: detected.map((id) => ({ evidence: [], id, name: id })),
    effective: {
      proposals: {
        effort: "xhigh",
        harness: SAME,
        model: "model-alpha",
        status: "resolved",
      },
      review: {
        adversarial: true,
        effort: "high",
        escalateOnFindings: "xhigh",
        harness: SAME,
        model: REVIEW_MODEL,
        reviewLoop: REVIEW_LOOP_DEFAULTS,
        status: "resolved",
        ...review,
      },
    },
    repairRequired: false,
  }) as unknown as RepositoryAuthoring;

const room = (
  run: Run,
  wouldAuthors: RoomIdentity[],
  options: {
    authoring?: RepositoryAuthoring;
    head?: string;
    proposal?: boolean;
    range?: boolean;
    request?: AuthoringSidecar;
    verified?: string[];
  } = {}
): ReviewerRoom =>
  reviewerRoom({
    authoring: options.authoring ?? stubAuthoring(),
    repositoryRoot: run.author,
    verifiedRoutes: (options.verified ?? []).map(parseVerifiedRoute),
    wouldAuthors,
    ...(options.range === false
      ? {}
      : { base: run.base, head: options.head ?? "HEAD" }),
    ...(options.proposal ? { proposalId: PROPOSAL } : {}),
    ...(options.request ? { request: options.request } : {}),
  });

const configured = (result: ReviewerRoom) => {
  const [candidate] = result.candidates;
  if (candidate?.route !== "configured") {
    throw new Error("Expected the configured route first.");
  }
  return candidate;
};

// A proposal whose first review reported a should-fix finding, so the floor
// now requires the review model at xhigh.
const escalatedProposal = (): { commit: string; run: Run } => {
  const run = preparedRun();
  const commit = commitFile(run.author, "a.txt", "a\n");
  attestAs(run, commit, "model-beta", ENV_OTHER, "instance-b");
  recordProposalAuthors({
    base: run.base,
    environment: ENV_OTHER,
    head: commit,
    proposalId: PROPOSAL,
    repositoryPath: run.author,
  });
  recordReviewAttempt({
    attemptId: randomUUID(),
    authoring: stubAuthoring(),
    head: commit,
    proposalId: PROPOSAL,
    receipt: {
      effort: "high",
      effortSource: "configured",
      findingsCount: 1,
      requested: { effort: "high", harness: SAME, model: REVIEW_MODEL },
      severities: { blocking: 0, nit: 0, shouldFix: 1 },
      verdict: "findings",
      verified: {
        agent: REVIEW_MODEL,
        harness: SAME,
        instance: "reviewer",
        session: "session-r",
      },
    },
    repositoryPath: run.author,
  });
  return { commit, run };
};

describe("reviewer room", () => {
  test("a would-be author running the only allowed escalation reviewer's model ID leaves no eligible reviewer", () => {
    const { commit, run } = escalatedProposal();
    const closed = room(run, [parseWouldAuthor(`${SAME}/${REVIEW_MODEL}`)], {
      proposal: true,
    });
    expect(closed.status).toBe("closed");
    expect(closed.reason).toBe("reviewer-not-distinct");
    expect(closed.message).toContain(
      "This author would leave no eligible reviewer"
    );
    expect(closed.required).toEqual({
      effort: "xhigh",
      effortSource: "escalation",
      escalationEffort: null,
      harness: SAME,
      model: REVIEW_MODEL,
      modelId: REVIEW_MODEL,
    });
    expect(closed.candidates).toHaveLength(1);
    const route = configured(closed);
    expect(route).toMatchObject({
      availability: { effort: "unknown", escalationEffort: null },
      effort: "xhigh",
      eligibility: "ruled-out",
      reason: "reviewer-not-distinct",
      ruledOutByWouldAuthor: true,
    });
    expect(route.conflicts).toEqual([
      expect.objectContaining({
        agent: REVIEW_MODEL,
        commits: [],
        harness: SAME,
        source: "would-author",
        verdict: "same",
      }),
    ]);
    // The attested author in another harness is considered and is no conflict.
    expect(closed.authors).toContainEqual(
      expect.objectContaining({
        agent: "model-beta",
        commits: [commit],
        harness: OTHER,
        source: "attested",
      })
    );
    // Negative control: a different model ID in the same harness keeps it open.
    const open = room(run, [parseWouldAuthor(`${SAME}/model-gamma`)], {
      proposal: true,
    });
    expect(open.status).toBe("unverified");
    expect(configured(open)).toMatchObject({
      conflicts: [],
      eligibility: "eligible",
      ruledOutByWouldAuthor: false,
    });
    // Without the proposal no findings are known, so only the configured
    // effort is required, with the escalation floor named for later rounds.
    const fresh = room(run, [parseWouldAuthor(`${SAME}/model-gamma`)]);
    expect(fresh.required).toMatchObject({
      effort: "high",
      effortSource: "configured",
      escalationEffort: "xhigh",
    });
  });

  test("a cross-harness reviewer keeps the room open, and availability needs a reported real run at that effort", () => {
    const { run } = escalatedProposal();
    const author = parseWouldAuthor(`${SAME}/${REVIEW_MODEL}`);
    const crossHarness = room(run, [author], {
      authoring: stubAuthoring({ harness: OTHER }),
      proposal: true,
    });
    expect(crossHarness.status).toBe("unverified");
    expect(configured(crossHarness)).toMatchObject({
      availability: { effort: "unknown" },
      eligibility: "eligible",
      harness: OTHER,
    });
    // The configured route is ruled out, but a detected harness running the
    // same model stays eligible; only the owner can choose it.
    const alternative = room(run, [author], {
      authoring: stubAuthoring({}, [SAME, OTHER]),
      proposal: true,
    });
    expect(alternative.status).toBe("alternative-only");
    expect(alternative.candidates.map((item) => item.harness)).toEqual([
      SAME,
      OTHER,
    ]);
    expect(alternative.candidates[1]).toMatchObject({
      availability: { effort: "unknown" },
      eligibility: "eligible",
      route: "detected",
    });
    // A reported run at a lower effort proves nothing at xhigh; one at xhigh does.
    const lower = room(run, [author], {
      authoring: stubAuthoring({}, [SAME, OTHER]),
      proposal: true,
      verified: [`${OTHER}/${REVIEW_MODEL}@high`],
    });
    expect(lower.candidates[1]?.availability.effort).toBe("unknown");
    const proven = room(run, [author], {
      authoring: stubAuthoring({}, [SAME, OTHER]),
      proposal: true,
      verified: [`${OTHER}/${REVIEW_MODEL}@xhigh`],
    });
    expect(proven.candidates[1]?.availability.effort).toBe(
      "controller-verified"
    );
    // The room opens only once a real run proves the configured route at
    // every effort the floor can require.
    const fresh = (verified: string[]) =>
      room(run, [author], {
        authoring: stubAuthoring({ harness: OTHER }),
        verified,
      });
    expect([fresh([]).status, fresh([]).reason]).toEqual([
      "unverified",
      "availability-unverified",
    ]);
    expect(fresh([`${OTHER}/${REVIEW_MODEL}@high`]).status).toBe("unverified");
    expect(fresh([`${OTHER}/${REVIEW_MODEL}@xhigh`]).status).toBe("unverified");
    expect(
      fresh([`${OTHER}/${REVIEW_MODEL}@high`, `${OTHER}/${REVIEW_MODEL}@xhigh`])
        .status
    ).toBe("open");
    // At the escalated floor one run at xhigh proves it.
    expect(
      room(run, [author], {
        authoring: stubAuthoring({ harness: OTHER }),
        proposal: true,
        verified: [`${OTHER}/${REVIEW_MODEL}@xhigh`],
      }).status
    ).toBe("open");
    // The owner's "do not guide this harness" rules the alternative out.
    const refused = room(run, [author], {
      authoring: stubAuthoring({}, [SAME, OTHER]),
      proposal: true,
      request: { harnesses: { [OTHER]: null }, roles: {}, schemaVersion: 1 },
    });
    expect(refused.status).toBe("closed");
    expect(refused.candidates[1]).toMatchObject({
      eligibility: "ruled-out",
      reason: "no-delegation",
    });
    // Without detection or a reported run, no other harness is invented.
    expect(room(run, [author], { proposal: true }).candidates).toHaveLength(1);
    // A route for another model is refused rather than read as availability.
    expect(() => parseVerifiedRoute(`${OTHER}/Model Review@xhigh`)).toThrow(
      "must name a model ID"
    );
    expect(() =>
      room(run, [author], { verified: [`${OTHER}/model-other@xhigh`] })
    ).toThrow("checks only the review model");
  });

  test("a display-name author fails closed as unknown in the reviewer's harness", () => {
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    attestAs(run, commit, "model-beta", ENV_OTHER, "instance-b");
    const wouldBe = room(run, [parseWouldAuthor(`${SAME}/Model Review`)]);
    expect(wouldBe.status).toBe("unknown");
    expect(wouldBe.reason).toBe("author-identity-missing");
    expect(configured(wouldBe)).toMatchObject({
      eligibility: "unknown",
      reason: "author-identity-missing",
    });
    expect(configured(wouldBe).conflicts).toEqual([
      expect.objectContaining({ modelId: null, verdict: "unknown-author" }),
    ]);
    // An attested display-name author in the reviewer's harness does the same.
    const second = commitFile(run.author, "b.txt", "b\n");
    attestAs(run, second, "Model Gamma", ENV_SAME, "instance-g");
    const attested = room(run, [parseWouldAuthor(`${OTHER}/model-delta`)]);
    expect(attested.status).toBe("unknown");
    expect(configured(attested).conflicts).toEqual([
      expect.objectContaining({
        agent: "Model Gamma",
        commits: [second],
        source: "attested",
        verdict: "unknown-author",
      }),
    ]);
    // Negative control: across harnesses a reported name is enough.
    const across = room(run, [parseWouldAuthor(`${OTHER}/Model Review`)], {
      head: commit,
    });
    expect(across.status).toBe("unverified");
  });

  test("a reviewer model that is not an ID proves no route, even across harnesses", () => {
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    attestAs(run, commit, "model-beta", ENV_OTHER, "instance-b");
    const author = [parseWouldAuthor(`${OTHER}/model-delta`)];
    for (const [model, reason] of [
      ["most-capable", "most-capable-unresolved"],
      ["Model Review", "reviewer-model-id-missing"],
      [`${REVIEW_MODEL} xhigh`, "reviewer-model-id-missing"],
    ] as const) {
      const result = room(run, author, {
        authoring: stubAuthoring({ model }),
      });
      expect([model, result.status, result.reason]).toEqual([
        model,
        "unknown",
        reason,
      ]);
      expect(configured(result).eligibility).toBe("unknown");
    }
    // Negative control: the same cross-harness route with a model ID is open.
    expect(room(run, author).status).toBe("unverified");
    // Without adversarial review the model is not compared.
    expect(
      room(run, author, {
        authoring: stubAuthoring({ adversarial: false, model: "most-capable" }),
      }).status
    ).toBe("unverified");
  });

  test("an attested author with neither instance nor session leaves independence unproven", () => {
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    attestAs(run, commit, "model-beta", ENV_OTHER, "instance-b");
    const author = [parseWouldAuthor(`${OTHER}/model-delta`)];
    // Negative control: the recorded instance and session prove independence.
    expect(room(run, author).status).toBe("unverified");
    const path = reviewLedgerPath(
      locateRepository(run.root).repository.commonGitDirectory
    );
    const ledger = JSON.parse(readFileSync(path, "utf8")) as ReviewLedger;
    for (const attestation of ledger.attestations[commit] ?? []) {
      attestation.instance = null;
      attestation.session = null;
    }
    writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
    for (const adversarial of [true, false]) {
      const result = room(run, author, {
        authoring: stubAuthoring({ adversarial }),
      });
      expect([adversarial, result.status, result.reason]).toEqual([
        adversarial,
        "unknown",
        "independence-unproven",
      ]);
      expect(configured(result).conflicts).toEqual([
        expect.objectContaining({
          agent: "model-beta",
          commits: [commit],
          verdict: "executor-unknown",
        }),
      ]);
    }
  });

  test("an effort label never counts as a different model", () => {
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    attestAs(run, commit, "model-beta", ENV_OTHER, "instance-b");
    for (const [model, reason] of [
      [`${REVIEW_MODEL} xhigh`, "author-identity-missing"],
      [`${REVIEW_MODEL}-xhigh`, "model-differs-only-by-effort"],
      [`${REVIEW_MODEL}.high`, "model-differs-only-by-effort"],
      ["xhigh", "author-identity-missing"],
    ] as const) {
      const result = room(run, [parseWouldAuthor(`${SAME}/${model}`)]);
      expect([model, result.status, result.reason]).toEqual([
        model,
        "unknown",
        reason,
      ]);
    }
    // Stacked labels on either side are no different model either.
    for (const [reviewer, wouldBe] of [
      [`${REVIEW_MODEL}-high`, `${REVIEW_MODEL}-high-xhigh`],
      [`${REVIEW_MODEL}-high-xhigh`, `${REVIEW_MODEL}-high`],
      [REVIEW_MODEL, `${REVIEW_MODEL}-high.xhigh`],
    ] as const) {
      const stacked = room(run, [parseWouldAuthor(`${SAME}/${wouldBe}`)], {
        authoring: stubAuthoring({ model: reviewer }),
      });
      expect([reviewer, wouldBe, stacked.status, stacked.reason]).toEqual([
        reviewer,
        wouldBe,
        "unknown",
        "model-differs-only-by-effort",
      ]);
    }
    // A reviewer model carrying the label is no different either.
    const labelled = room(run, [parseWouldAuthor(`${SAME}/${REVIEW_MODEL}`)], {
      authoring: stubAuthoring({ model: `${REVIEW_MODEL}-max` }),
    });
    expect(labelled.reason).toBe("model-differs-only-by-effort");
    // Negative control: a different ID that is not an effort label is diverse.
    expect(
      room(run, [parseWouldAuthor(`${SAME}/${REVIEW_MODEL}-mini`)]).status
    ).toBe("unverified");
  });

  test("considers every attested author of the range and the proposal's recorded head", () => {
    const run = preparedRun();
    const first = commitFile(run.author, "a.txt", "a\n");
    attestAs(run, first, "model-beta", ENV_OTHER, "instance-b");
    const second = commitFile(run.author, "b.txt", "b\n");
    attestAs(run, second, REVIEW_MODEL, ENV_SAME_SECOND, "instance-c");
    attestAs(run, second, "model-beta", ENV_OTHER, "instance-b");
    const author = parseWouldAuthor(`${OTHER}/model-delta`);
    const closed = room(run, [author]);
    expect(closed.status).toBe("closed");
    expect(closed.message).toContain(
      "No eligible reviewer remains even without this author"
    );
    expect(
      closed.authors.map((item) => [item.source, item.agent, item.commits])
    ).toEqual([
      ["attested", "model-beta", [first, second]],
      ["attested", REVIEW_MODEL, [second]],
      ["would-author", "model-delta", []],
    ]);
    expect(configured(closed)).toMatchObject({
      reason: "reviewer-not-distinct",
      ruledOutByWouldAuthor: false,
    });
    expect(configured(closed).conflicts).toEqual([
      expect.objectContaining({
        agent: REVIEW_MODEL,
        commits: [second],
        verdict: "same",
      }),
    ]);
    // Negative control: a range that stops before the conflicting commit.
    expect(room(run, [author], { head: first }).status).toBe("unverified");
    // A named proposal with no recorded head and no range has unknown authors.
    const unrecorded = room(run, [author], {
      authoring: stubAuthoring({ harness: OTHER, model: "model-epsilon" }),
      proposal: true,
      range: false,
    });
    expect([unrecorded.status, unrecorded.reason]).toEqual([
      "unknown",
      "authors-not-recorded",
    ]);
    // The proposal's recorded head counts even when no range is passed.
    recordProposalAuthors({
      base: run.base,
      environment: ENV_OTHER,
      head: second,
      proposalId: PROPOSAL,
      repositoryPath: run.author,
    });
    expect(room(run, [author], { proposal: true, range: false }).status).toBe(
      "closed"
    );
    // A commit nobody attested leaves the room unknown, never open.
    commitFile(run.author, "c.txt", "c\n");
    const partial = room(run, [author], {
      authoring: stubAuthoring({ harness: OTHER, model: "model-epsilon" }),
    });
    expect([partial.status, partial.reason]).toEqual([
      "unknown",
      "coverage-incomplete",
    ]);
    // No route reads eligible while the room is not provably open.
    expect(configured(partial)).toMatchObject({
      eligibility: "unknown",
      reason: "coverage-incomplete",
    });
    expect(configured(unrecorded)).toMatchObject({
      eligibility: "unknown",
      reason: "authors-not-recorded",
    });
    // The same holds for a recorded head that carries the unattested commit.
    const third = git(run.author, ["rev-parse", "HEAD"]);
    recordProposalAuthors({
      base: run.base,
      environment: ENV_OTHER,
      head: third,
      proposalId: PROPOSAL,
      repositoryPath: run.author,
    });
    const recorded = room(run, [author], {
      authoring: stubAuthoring({ harness: OTHER, model: "model-epsilon" }),
      proposal: true,
      range: false,
    });
    expect([recorded.status, configured(recorded).eligibility]).toEqual([
      "unknown",
      "unknown",
    ]);
    // A proven conflict still closes the room while coverage is incomplete.
    const stillClosed = room(run, [author]);
    expect(stillClosed.status).toBe("closed");
    expect(configured(stillClosed).eligibility).toBe("ruled-out");
  });
});

// The runtime's own transpiler cache, which is not Simple Changes state.
const RUNTIME_CACHE = /[/\\](?:Library[/\\]Caches|\.cache)[/\\]bun[/\\]/u;

// Every file under a directory with its bytes and modification time.
const snapshot = (directory: string): Record<string, string> => {
  const files: Record<string, string> = {};
  if (!existsSync(directory)) {
    return files;
  }
  for (const entry of readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && !RUNTIME_CACHE.test(path)) {
      files[path] =
        `${statSync(path).mtimeMs}:${readFileSync(path).toString("base64")}`;
    }
  }
  return files;
};

describe("reviewer room command", () => {
  test("reports the room, exits by its status, and writes nothing", () => {
    const { commit, run } = escalatedProposal();
    const home = mkdtempSync(join(tmpdir(), "simple-changes-room-home-"));
    cleanups.push(() => rmSync(home, { force: true, recursive: true }));
    const sidecar = join(run.root, ".simple-changes-authoring.json");
    writeFileSync(
      sidecar,
      `${JSON.stringify({
        harnesses: {},
        roles: {
          review: {
            adversarial: true,
            effort: "high",
            escalateOnFindings: "xhigh",
            harness: SAME,
            model: REVIEW_MODEL,
          },
        },
        schemaVersion: 1,
      })}\n`
    );
    const { commonGitDirectory } = locateRepository(run.root).repository;
    const before = {
      git: snapshot(commonGitDirectory),
      home: snapshot(home),
      sidecar: readFileSync(sidecar, "utf8"),
      status: git(run.author, ["status", "--porcelain"]),
    };
    const cli = (wouldAuthor: string, json = true, extra: string[] = []) => {
      const result = spawnSync(
        [
          process.execPath,
          cliPath,
          "reviewer",
          "room",
          "--would-author",
          wouldAuthor,
          "--base",
          run.base,
          "--head",
          commit,
          "--proposal",
          PROPOSAL,
          "--repo",
          run.author,
          ...extra,
          ...(json ? ["--json"] : []),
        ],
        {
          env: {
            ...process.env,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            HOME: home,
            SIMPLE_CHANGES_SKILL_ROOTS: "",
            XDG_CONFIG_HOME: join(home, ".config"),
          },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      return {
        exitCode: result.exitCode,
        stderr: decoder.decode(result.stderr),
        stdout: decoder.decode(result.stdout),
      };
    };
    const closed = cli(`${SAME}/${REVIEW_MODEL}`);
    expect(closed.stderr).toBe("");
    expect(closed.exitCode).toBe(3);
    const report = JSON.parse(closed.stdout) as ReviewerRoom;
    expect(report).toMatchObject({
      required: { effort: "xhigh", effortSource: "escalation" },
      status: "closed",
    });
    const unverified = cli(`${SAME}/model-gamma`);
    expect(unverified.exitCode).toBe(3);
    expect((JSON.parse(unverified.stdout) as ReviewerRoom).status).toBe(
      "unverified"
    );
    const open = cli(`${SAME}/model-gamma`, false, [
      "--verified-route",
      `${SAME}/${REVIEW_MODEL}@xhigh`,
    ]);
    expect(open.exitCode).toBe(0);
    expect(open.stdout).toContain("Reviewer room: open");
    expect(open.stdout).toContain("Nothing was written.");
    const usage = cli("no-slash");
    expect(usage.exitCode).toBe(2);
    expect({
      git: snapshot(commonGitDirectory),
      home: snapshot(home),
      sidecar: readFileSync(sidecar, "utf8"),
      status: git(run.author, ["status", "--porcelain"]),
    }).toEqual(before);
  });
});
