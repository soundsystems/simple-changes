import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import { SimpleChangesError } from "../../../skills/simple-changes/scripts/lib/errors.ts";
import { locateRepository } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  loopLeasePath,
  prepareAgentWorktree,
  readControllerBinding,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  type Attestation,
  attestCommits,
  emptyReviewLedger,
  evaluateReviewAcceptance,
  headCoverage,
  type ReviewLedger,
  type RuntimeIdentity,
  reviewLedgerPath,
} from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import { turnCheck } from "../../../skills/simple-changes/scripts/lib/turn-guard.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import { readWorktreeCoordination } from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// Independent review means a different agent instance: a model may review
// the same model, never the same instance. A harness started from another
// inherits the parent's session variable, so identity must never be read by
// a fixed order between two harnesses' variables.

setDefaultTimeout(180_000);

const decoder = new TextDecoder();
const cliPath = resolve(
  import.meta.dir,
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const SESSION_VARIABLES = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"];

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
  for (const name of SESSION_VARIABLES) {
    Reflect.deleteProperty(process.env, name);
  }
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

// A parent session in one harness, and a child started from it in the other
// harness, which still sees the parent's variable beside its own.
const sessions = () => {
  const parent = `parent-${randomUUID()}`;
  const child = `child-${randomUUID()}`;
  return {
    child,
    childOnly: { CODEX_THREAD_ID: child },
    nested: { CLAUDE_CODE_SESSION_ID: parent, CODEX_THREAD_ID: child },
    parent,
    parentOnly: { CLAUDE_CODE_SESSION_ID: parent },
  };
};

const exitCodeOf = (step: () => unknown): number | null => {
  try {
    step();
    return null;
  } catch (error) {
    return error instanceof SimpleChangesError ? error.exitCode : -1;
  }
};

const withSession = <T>(
  environment: Record<string, string>,
  step: () => T
): T => {
  for (const name of SESSION_VARIABLES) {
    Reflect.deleteProperty(process.env, name);
  }
  Object.assign(process.env, environment);
  try {
    return step();
  } finally {
    for (const name of SESSION_VARIABLES) {
      Reflect.deleteProperty(process.env, name);
    }
  }
};

const cli = (
  root: string,
  environment: Record<string, string>,
  args: string[]
) => {
  const result = spawnSync([process.execPath, cliPath, ...args], {
    cwd: root,
    env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "", ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

const commitFile = (root: string, file: string, contents: string): string => {
  writeFixture(root, file, contents);
  git(root, ["add", file]);
  git(root, ["commit", "-m", `Update ${file}`]);
  return git(root, ["rev-parse", "HEAD"]);
};

const commonDirectory = (root: string): string =>
  locateRepository(root).repository.commonGitDirectory;

// The ledger file's bytes, or null when no write has created it.
const ledgerBytes = (root: string): string | null => {
  const path = reviewLedgerPath(commonDirectory(root));
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

const attestationsOf = (root: string, commit: string): Attestation[] => {
  const bytes = ledgerBytes(root);
  return bytes
    ? ((JSON.parse(bytes) as ReviewLedger).attestations[commit] ?? [])
    : [];
};

// A run with a prepared author worktree, started with no harness session.
const preparedRun = () => {
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

describe("recording the executing agent instance", () => {
  test("a child harness that sees its parent's session is refused without --harness, and recorded as itself with it", () => {
    const { child, nested } = sessions();
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    const input = {
      agent: "model-child",
      commits: [commit],
      environment: nested,
      logicalId: "author-a",
      repositoryPath: run.author,
    };
    expect(exitCodeOf(() => attestCommits(input))).toBe(2);
    expect(attestationsOf(run.root, commit)).toEqual([]);
    const recorded = attestCommits({ ...input, harness: "codex" });
    expect(recorded.identity).toEqual({
      agent: "model-child",
      harness: "codex",
      instance: null,
      logicalId: "author-a",
      session: child,
    });
    expect(attestationsOf(run.root, commit)).toEqual([
      expect.objectContaining({ harness: "codex", session: child }),
    ]);
  });

  test("a single harness session is read as before, and a --harness naming another is refused", () => {
    const { child, childOnly, parent, parentOnly } = sessions();
    const run = preparedRun();
    const first = commitFile(run.author, "a.txt", "a\n");
    expect(
      attestCommits({
        commits: [first],
        environment: parentOnly,
        logicalId: "author-a",
        repositoryPath: run.author,
      }).identity
    ).toMatchObject({ harness: "claude-code", session: parent });
    const second = commitFile(run.author, "b.txt", "b\n");
    expect(
      attestCommits({
        commits: [second],
        environment: childOnly,
        logicalId: "author-a",
        repositoryPath: run.author,
      }).identity
    ).toMatchObject({ harness: "codex", session: child });
    expect(() =>
      attestCommits({
        commits: [second],
        environment: childOnly,
        harness: "claude-code",
        logicalId: "author-a",
        repositoryPath: run.author,
      })
    ).toThrow("disagrees with the executing harness");
  });

  test("the command line passes --harness to author attest and proposal record-authors", () => {
    const { child, nested } = sessions();
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    const attest = ["author", "attest", "--commit", commit];
    const tail = ["--agent-id", "author-a", "--json", "--repo", run.author];
    const refused = cli(run.author, nested, [...attest, ...tail]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("--harness");
    expect(ledgerBytes(run.root)).toBeNull();
    const attested = cli(run.author, nested, [
      ...attest,
      "--harness",
      "codex",
      ...tail,
    ]);
    expect(attested.exitCode).toBe(0);
    expect(JSON.parse(attested.stdout).identity).toMatchObject({
      harness: "codex",
      session: child,
    });
    const receipt = join(run.root, "..", "copy-authors.json");
    writeFileSync(
      receipt,
      JSON.stringify({ copyAuthors: [{ source: "direct" }] })
    );
    const record = [
      "proposal",
      "record-authors",
      "--proposal",
      "group/project!7",
      "--base",
      run.base,
      "--head",
      commit,
      "--receipt",
      receipt,
      "--json",
      "--repo",
      run.author,
    ];
    const before = ledgerBytes(run.root);
    expect(cli(run.author, nested, record).exitCode).toBe(2);
    expect(ledgerBytes(run.root)).toBe(before);
    const recorded = cli(run.author, nested, [...record, "--harness", "codex"]);
    expect(recorded.exitCode).toBe(0);
    expect(JSON.parse(recorded.stdout).copyAuthors).toEqual([
      expect.objectContaining({
        harness: "codex",
        session: child,
        source: "direct",
      }),
    ]);
  });
});

describe("identity receipts", () => {
  test("a receipt that agrees with the environment decides the harness and reports the model and instance", () => {
    const { child, nested, parent } = sessions();
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    const recorded = attestCommits({
      commits: [commit],
      environment: nested,
      identityReceipt: {
        harness: "codex",
        instance: "child-agent-1",
        model: "model-child",
        parentSession: parent,
        schemaVersion: 1,
        session: child,
      },
      logicalId: "author-a",
      repositoryPath: run.author,
    } as Parameters<typeof attestCommits>[0]);
    expect(recorded.identity).toEqual({
      agent: "model-child",
      harness: "codex",
      instance: "child-agent-1",
      logicalId: "author-a",
      session: child,
    });
  });

  test("a conflicting or invalid receipt exits 2 and writes nothing", () => {
    const { child, childOnly, nested, parent } = sessions();
    const run = preparedRun();
    const commit = commitFile(run.author, "a.txt", "a\n");
    const receiptPath = join(run.root, "..", "identity.json");
    const good = {
      harness: "codex",
      instance: "child-agent-1",
      model: "model-child",
      parentSession: parent,
      schemaVersion: 1,
      session: child,
    };
    const attest = (
      receipt: unknown,
      environment: Record<string, string> = nested,
      extra: string[] = []
    ) => {
      writeFileSync(receiptPath, JSON.stringify(receipt));
      return cli(run.author, environment, [
        "author",
        "attest",
        "--commit",
        commit,
        "--agent-id",
        "author-a",
        "--identity-receipt",
        `@${receiptPath}`,
        ...extra,
        "--json",
        "--repo",
        run.author,
      ]);
    };
    const refusals: [unknown, Record<string, string>, string[]][] = [
      // The environment reports another session for the receipt's harness.
      [{ ...good, session: "another-thread" }, nested, []],
      // The receipt's harness has no session here.
      [{ ...good, harness: "claude-code", session: parent }, childOnly, []],
      // Arguments beside it disagree with it.
      [good, nested, ["--harness", "claude-code"]],
      [good, nested, ["--agent", "model-other"]],
      [good, nested, ["--instance", "another-agent"]],
      // Invalid receipts.
      [{ ...good, effort: "high" }, nested, []],
      [{ ...good, model: "Model Child" }, nested, []],
      [{ ...good, model: "most-capable" }, nested, []],
      [{ ...good, parentSession: child }, nested, []],
      [{ ...good, schemaVersion: 2 }, nested, []],
      [{ harness: "codex", schemaVersion: 1, session: child }, nested, []],
    ];
    for (const [index, [receipt, environment, extra]] of refusals.entries()) {
      const result = attest(receipt, environment, extra);
      expect({ exitCode: result.exitCode, index }).toEqual({
        exitCode: 2,
        index,
      });
      expect(ledgerBytes(run.root)).toBeNull();
    }
    writeFileSync(receiptPath, "{not json");
    expect(
      cli(run.author, nested, [
        "worktree",
        "status",
        "--identity-receipt",
        `@${receiptPath}`,
        "--repo",
        run.root,
      ]).exitCode
    ).toBe(2);
    // The matching receipt, with agreeing arguments, is recorded.
    const accepted = attest(good, nested, [
      "--harness",
      "codex",
      "--agent",
      "MODEL-CHILD",
      "--instance",
      "child-agent-1",
    ]);
    expect(accepted.exitCode).toBe(0);
    expect(attestationsOf(run.root, commit)).toEqual([
      expect.objectContaining({
        agent: "model-child",
        harness: "codex",
        instance: "child-agent-1",
        session: child,
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Independence per agent instance

const STAMP = "2026-10-23T12:00:00.000Z";
const PROPOSAL = "group/project!8";
const HEAD = "a".repeat(40);

const decision = (
  author: RuntimeIdentity,
  reviewer: RuntimeIdentity,
  adversarial = false
) => {
  const ledger = emptyReviewLedger();
  ledger.attestations[HEAD] = [
    { ...author, logicalId: "author", recordedAt: STAMP },
  ];
  const coverage = headCoverage(ledger, [HEAD]);
  ledger.proposals[PROPOSAL] = {
    attempts: [],
    heads: {
      [HEAD]: {
        authorsDigest: coverage.authorsDigest,
        base: "b".repeat(40),
        commits: [HEAD],
        copyAuthors: [],
        gaps: coverage.gaps,
        unattributed: coverage.unattributed,
        waivers: [],
      },
    },
  };
  return evaluateReviewAcceptance({
    adversarial,
    attempt: { headRevision: HEAD, verdict: "clean", verified: reviewer },
    currentHead: HEAD,
    ledger,
    proposalId: PROPOSAL,
    repairRequired: false,
  });
};

const AUTHOR: RuntimeIdentity = {
  agent: "model-shared",
  harness: "harness-one",
  instance: "agent-author",
  session: "session-author",
};

describe("independence per agent instance", () => {
  test("the same model in the same harness reviews as a different instance", () => {
    // Another session of the same model.
    expect(
      decision(AUTHOR, {
        ...AUTHOR,
        instance: "agent-reviewer",
        session: "session-reviewer",
      })
    ).toMatchObject({ acceptanceReason: null, accepted: true });
    // Another agent in the author's own session.
    expect(
      decision(AUTHOR, { ...AUTHOR, instance: "agent-reviewer" })
    ).toMatchObject({ acceptanceReason: null, accepted: true });
    // Another session, where neither names an instance.
    expect(
      decision(
        { ...AUTHOR, instance: null },
        { ...AUTHOR, instance: null, session: "session-reviewer" }
      )
    ).toMatchObject({ accepted: true });
  });

  test("the same instance is never independent, even recorded under another harness, model and session", () => {
    const sameInstance: RuntimeIdentity = {
      agent: "model-other",
      harness: "harness-two",
      instance: AUTHOR.instance,
      session: "session-child",
    };
    for (const adversarial of [false, true]) {
      expect(decision(AUTHOR, sameInstance, adversarial)).toMatchObject({
        acceptanceReason: "reviewer-not-independent",
        accepted: false,
      });
    }
    // Negative control: another instance with that record passes, and
    // passes diversity too, since its harness differs.
    for (const adversarial of [false, true]) {
      expect(
        decision(
          AUTHOR,
          { ...sameInstance, instance: "agent-reviewer" },
          adversarial
        )
      ).toMatchObject({ accepted: true });
    }
    // One session with no second instance named is the same agent.
    expect(
      decision(AUTHOR, { ...AUTHOR, harness: "harness-two", instance: null })
    ).toMatchObject({ acceptanceReason: "reviewer-not-independent" });
  });

  test("an instance the records cannot tell is refused, never guessed", () => {
    const unknown: RuntimeIdentity = {
      agent: "model-other",
      harness: "harness-two",
      instance: null,
      session: null,
    };
    expect(decision(AUTHOR, unknown)).toMatchObject({
      acceptanceReason: "independence-unproven",
      accepted: false,
    });
    expect(
      decision(
        { ...AUTHOR, instance: null, session: null },
        { ...AUTHOR, instance: "agent-reviewer", session: "session-reviewer" }
      )
    ).toMatchObject({ acceptanceReason: "independence-unproven" });
    // One record names only an instance and the other only a session.
    expect(
      decision(
        { ...AUTHOR, session: null },
        { ...AUTHOR, instance: null, session: "session-reviewer" }
      )
    ).toMatchObject({ acceptanceReason: "independence-unproven" });
  });
});

// ---------------------------------------------------------------------------
// Claims, the controller binding and the turn-end guard

const addWorktree = (fixture: TestRepository, name: string): string => {
  const path = join(fixture.base, name);
  git(fixture.root, ["worktree", "add", "-b", name, path]);
  return path;
};

const liveClaims = (root: string) =>
  readWorktreeCoordination(root).claims.filter(
    (claim) => claim.state !== "released"
  );

describe("claim sessions with two harness sessions in view", () => {
  test("a claim needs --harness, binds the child's own session, and the parent cannot act on it", () => {
    const { childOnly, nested, parentOnly } = sessions();
    const fixture = repository();
    const path = addWorktree(fixture, "child-work");
    const claim = [
      "worktree",
      "claim",
      "--agent-id",
      "child-agent",
      "--worktree",
      path,
      "--adapter",
      "codex",
      "--json",
      "--repo",
      fixture.root,
    ];
    const refused = cli(fixture.root, nested, claim);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("--harness");
    expect(liveClaims(fixture.root)).toEqual([]);
    const claimed = cli(fixture.root, nested, [...claim, "--harness", "codex"]);
    expect(claimed.exitCode).toBe(0);
    const { claimId } = (
      JSON.parse(claimed.stdout) as { claim: { claimId: string } }
    ).claim;
    const release = [
      "worktree",
      "release",
      "--agent-id",
      "child-agent",
      "--claim-id",
      claimId,
      "--json",
      "--repo",
      fixture.root,
    ];
    // The parent session, whose variable the child inherited, does not hold
    // the child's claim.
    const fromParent = cli(fixture.root, parentOnly, release);
    expect(fromParent.exitCode).toBe(5);
    expect(fromParent.stderr).toContain("belongs to another harness session");
    // Under both variables the command must say which session it is.
    expect(cli(fixture.root, nested, release).exitCode).toBe(2);
    expect(cli(fixture.root, childOnly, release).exitCode).toBe(0);
    expect(liveClaims(fixture.root)).toEqual([]);
  });

  test("an unbound claim needs no session, so two in view do not block it", () => {
    const { nested } = sessions();
    const fixture = repository();
    const path = addWorktree(fixture, "unbound-work");
    const claimed = cli(fixture.root, {}, [
      "worktree",
      "claim",
      "--agent-id",
      "plain-agent",
      "--worktree",
      path,
      "--adapter",
      "codex",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(claimed.exitCode).toBe(0);
    const { claimId } = (
      JSON.parse(claimed.stdout) as { claim: { claimId: string } }
    ).claim;
    const released = cli(fixture.root, nested, [
      "worktree",
      "release",
      "--agent-id",
      "plain-agent",
      "--claim-id",
      claimId,
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(released.exitCode).toBe(0);
  });
});

describe("the controller binding and the turn-end guard", () => {
  test("loop start needs --harness with two sessions in view, and binds the child's own", () => {
    const { child, nested } = sessions();
    const fixture = repository();
    const start = [
      "loop",
      "start",
      "--mode",
      "integrate",
      "--agent-id",
      "child-controller",
      "--json",
      "--repo",
      fixture.root,
    ];
    const leasePath = loopLeasePath(commonDirectory(fixture.root));
    const refused = cli(fixture.root, nested, start);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("--harness");
    expect(existsSync(leasePath)).toBe(false);
    expect(
      cli(fixture.root, nested, [...start, "--harness", "codex"]).exitCode
    ).toBe(0);
    const lease = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
    expect(readControllerBinding(lease)?.session).toMatchObject({
      harness: "codex",
      sessionId: child,
    });
  });

  test("a child's turn never ends on its parent's run when the hook names no session", () => {
    const { nested, parent, parentOnly } = sessions();
    const fixture = repository();
    withSession(parentOnly, () =>
      startLoop(fixture.root, "parent-controller", "integrate")
    );
    // The hook reads session pointers from the isolated configuration
    // directory the run recorded them in.
    const hook = (variables: Record<string, string>) => ({
      SIMPLE_CHANGES_CONFIG_DIR: process.env.SIMPLE_CHANGES_CONFIG_DIR,
      ...variables,
    });
    // Negative controls: the parent's own session, read from its variable or
    // named by the hook, still blocks.
    expect(
      turnCheck({ sessionId: null, stopHookActive: false }, hook(parentOnly))
        .decision
    ).toBe("block");
    expect(
      turnCheck({ sessionId: parent, stopHookActive: false }, hook(nested))
        .decision
    ).toBe("block");
    expect(
      turnCheck({ sessionId: null, stopHookActive: false }, hook(nested))
    ).toMatchObject({ decision: "allow", runs: [], sessionId: null });
    // Run directly, the check must know which session it reports on.
    const direct = ["loop", "turn-check", "--json"];
    expect(cli(fixture.root, nested, direct).exitCode).toBe(2);
    const named = cli(fixture.root, nested, [
      ...direct,
      "--harness",
      "claude-code",
    ]);
    expect(named.exitCode).toBe(0);
    expect(JSON.parse(named.stdout)).toMatchObject({
      decision: "block",
      sessionId: parent,
    });
  });
});
