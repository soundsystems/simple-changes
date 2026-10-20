import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REVIEW_LOOP_DEFAULTS,
  type RepositoryAuthoring,
} from "../../../skills/simple-changes/scripts/lib/authoring.ts";
import { readChangelogAuthors } from "../../../skills/simple-changes/scripts/lib/changelog-authors.ts";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  finalizeLoop,
  loopLeasePath,
  prepareAgentWorktree,
  readLoopLease,
  recordShipmentScope,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import {
  attestCommits,
  readReviewLedger,
  recordProposalAuthors,
  recordReviewAttempt,
  reviewApproval,
  waiveProposalCoverage,
} from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import type {
  ChangePlan,
  LoopLease,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// After a run's shipment scope freezes, prepare-agent may add a
// changelog-only author to a registered unit and nothing else (#18 item 2).

setDefaultTimeout(120_000);

const fixtures: TestRepository[] = [];
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
});

const AUTHOR = "changelog-author";
const ENVIRONMENT = { CLAUDE_CODE_SESSION_ID: "changelog-session" };
const PROPOSAL = "group/project!18";
const STALE = "changelog-author-outside-release-surfaces";
const FREEZE_REFUSAL = "cannot prepare a new author for a later shipment";
const INEXACT_PLAN = "exact current repository inventory";

const commitFile = (root: string, file: string, contents: string): string => {
  writeFixture(root, file, contents);
  git(root, ["add", file]);
  git(root, ["commit", "-m", `Update ${file}`]);
  return git(root, ["rev-parse", "HEAD"]);
};

const refusalOf = (step: () => unknown): string => {
  try {
    step();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the step to be refused");
};

interface ScopedRun {
  fixture: TestRepository;
  lease: LoopLease;
  unitId: string;
}

// A Ship run whose scope records one unit from the primary's dirty work.
// With `changelog`, the repository tracks CHANGELOG.md, a release surface.
const scopedRun = (changelog = true): ScopedRun => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  if (changelog) {
    commitFile(fixture.root, "CHANGELOG.md", "# Changelog\n");
  }
  writeFixture(fixture.root, "feature.txt", "shipped feature\n");
  const lease = startLoop(fixture.root, "controller", "ship");
  const scopedPlan = (): ChangePlan => {
    const opening = captureInventory(fixture.root);
    const preview = buildPreviewPlan(
      opening,
      opening,
      compareSnapshots(opening, opening)
    );
    return {
      ...preview,
      units: preview.units.map((item) => ({
        ...item,
        operations: ["commit"],
        requiredAuthority: ["local-write"],
      })),
    };
  };
  // Under heavy machine load a Git read inside one inventory capture can
  // fail and change its digest, so the exact-inventory check is retried with
  // a fresh preview, as an agent would.
  let plan = scopedPlan();
  for (let attempt = 1; ; attempt += 1) {
    try {
      recordShipmentScope(fixture.root, lease.runId, "controller", plan);
      break;
    } catch (error) {
      if (attempt >= 3 || !(error as Error).message.includes(INEXACT_PLAN)) {
        throw error;
      }
      plan = scopedPlan();
    }
  }
  const [unit] = plan.units;
  if (!unit) {
    throw new Error("Expected a unit for the primary's work");
  }
  return { fixture, lease, unitId: unit.id };
};

// The turn ends before the shipment finishes, freezing its scope, and the
// next controller resumes the run.
const freezeAndResume = ({ fixture, lease }: ScopedRun): LoopLease => {
  const finalized = finalizeLoop(
    fixture.root,
    lease.runId,
    "controller",
    "The turn ended before the shipment finished."
  );
  expect(finalized.outcome).toBe("relinquished");
  expect(finalized.lease?.shipmentScopeFrozenAt).toEqual(expect.any(String));
  return startLoop(fixture.root, "next-controller", "resume");
};

const prepareChangelogAuthor = (
  run: ScopedRun,
  options: { agentId?: string; purpose?: string; unitId?: string } = {}
) =>
  prepareAgentWorktree(
    run.fixture.root,
    run.lease.runId,
    options.agentId ?? AUTHOR,
    options.purpose ?? "changelog",
    undefined,
    options.unitId ?? run.unitId
  );

const attestAsAuthor = (cwd: string, commits: string[]) =>
  attestCommits({
    agent: "model-changelog",
    commits,
    environment: ENVIRONMENT,
    instance: "changelog-instance",
    logicalId: AUTHOR,
    repositoryPath: cwd,
  });

const violationsAt = (root: string, path: string) =>
  verifyLoop(root).violations.filter((violation) => violation.path === path);

describe("a changelog-only author after the shipment scope froze", () => {
  test("is prepared for a registered unit without widening the scope", () => {
    const run = scopedRun();
    const resumed = freezeAndResume(run);
    const scopeBefore = resumed.shipmentScope;
    const prepared = prepareChangelogAuthor(run);
    expect(prepared).toMatchObject({
      agentId: AUTHOR,
      changelogAuthor: {
        releaseSurfaces: ["CHANGELOG.md"],
        unitId: run.unitId,
      },
      created: true,
    });
    const lease = readLoopLease(run.fixture.root);
    expect(lease?.shipmentScope).toEqual(scopeBefore);
    expect(lease?.shipmentScopeFrozenAt).toBe(resumed.shipmentScopeFrozenAt);
    expect(
      lease?.worktrees.find((worktree) => worktree.path === prepared.path)
    ).toMatchObject({ agentId: AUTHOR, role: "author" });
    expect(readChangelogAuthors(resumed)).toEqual([
      expect.objectContaining({
        agentId: AUTHOR,
        baseRevision: resumed.targetRevision,
        branch: prepared.branch,
        path: prepared.path,
        releaseSurfaces: ["CHANGELOG.md"],
        unitId: run.unitId,
      }),
    ]);
    // Its first use claims the same registration.
    expect(prepareChangelogAuthor(run)).toMatchObject({
      changelogAuthor: { unitId: run.unitId },
      created: false,
      path: prepared.path,
    });
    // A changelog-only commit, attested by the author, keeps the unit current.
    const entry = commitFile(
      prepared.path,
      "CHANGELOG.md",
      "# Changelog\n\n- Shipped feature.\n"
    );
    expect(attestAsAuthor(prepared.path, [entry]).attestations).toEqual([
      { commit: entry, status: "recorded" },
    ]);
    expect(violationsAt(run.fixture.root, prepared.path)).toEqual([]);
  });

  test("is refused for an unknown unit, another purpose, an unfrozen scope, or a repository without release surfaces", () => {
    const run = scopedRun();
    const leasePath = loopLeasePath(run.lease.commonGitDirectory);
    // Before the freeze the ordinary preparation applies, so --unit is refused.
    const unfrozen = refusalOf(() => prepareChangelogAuthor(run));
    expect(unfrozen).toContain("scope has not frozen");
    freezeAndResume(run);
    const before = readFileSync(leasePath);
    const unknown = refusalOf(() =>
      prepareChangelogAuthor(run, { unitId: "unit-that-was-never-scoped" })
    );
    expect(unknown).toContain("is not registered in the frozen shipment scope");
    expect(unknown).toContain(run.unitId);
    const purpose = refusalOf(() =>
      prepareChangelogAuthor(run, { purpose: "follow-up fix" })
    );
    expect(purpose).toContain("--purpose changelog");
    // Without --unit, a frozen run refuses every new author as before.
    expect(
      refusalOf(() =>
        prepareAgentWorktree(
          run.fixture.root,
          run.lease.runId,
          AUTHOR,
          "changelog"
        )
      )
    ).toContain(FREEZE_REFUSAL);
    expect(readFileSync(leasePath)).toEqual(before);
    expect(readChangelogAuthors(run.lease)).toEqual([]);
    expect(
      git(run.fixture.root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/simple-changes/",
      ])
    ).toBe("");

    const bare = scopedRun(false);
    freezeAndResume(bare);
    expect(refusalOf(() => prepareChangelogAuthor(bare))).toContain(
      "no release surface"
    );
    expect(readChangelogAuthors(bare.lease)).toEqual([]);
  });

  test("a change outside the release surfaces makes the unit stale", () => {
    const run = scopedRun();
    freezeAndResume(run);
    const prepared = prepareChangelogAuthor(run);
    const { root } = run.fixture;

    // An uncommitted edit to any other file.
    writeFixture(prepared.path, "feature.txt", "changed by the changelog\n");
    const [uncommitted] = violationsAt(root, prepared.path);
    expect(uncommitted).toMatchObject({ code: STALE, path: prepared.path });
    expect(uncommitted?.message).toContain(`Unit ${run.unitId} is stale`);
    expect(uncommitted?.message).toContain('"feature.txt"');
    git(prepared.path, ["checkout", "--", "."]);
    git(prepared.path, ["clean", "-fd"]);
    expect(violationsAt(root, prepared.path)).toEqual([]);

    // A committed one, attested by the author, stays in the ledger: removing
    // it from the branch does not make the unit current again.
    const before = git(prepared.path, ["rev-parse", "HEAD"]);
    const outside = commitFile(prepared.path, "src/other.ts", "export {};\n");
    expect(violationsAt(root, prepared.path)).toEqual([
      expect.objectContaining({ code: STALE }),
    ]);
    attestAsAuthor(prepared.path, [outside]);
    git(prepared.path, ["reset", "--hard", before]);
    const [attested] = violationsAt(root, prepared.path);
    expect(attested?.code).toBe(STALE);
    expect(attested?.message).toContain(outside);
    expect(attested?.message).toContain('"src/other.ts"');
    expect(verifyLoop(root, { forMerge: true }).ok).toBe(false);
  });

  test("reviews recorded before the changelog author attests stop counting", () => {
    const run = scopedRun();
    freezeAndResume(run);
    const prepared = prepareChangelogAuthor(run);
    const base = run.lease.targetRevision;
    const head = commitFile(
      prepared.path,
      "CHANGELOG.md",
      "# Changelog\n\n- Shipped feature.\n"
    );
    const recordAuthors = () =>
      recordProposalAuthors({
        base,
        environment: ENVIRONMENT,
        head,
        proposalId: PROPOSAL,
        repositoryPath: prepared.path,
      });
    const unattested = recordAuthors();
    expect(unattested.fullyCovered).toBe(false);
    waiveProposalCoverage({
      authorsDigest: unattested.authorsDigest,
      head,
      proposalId: PROPOSAL,
      receipt: {
        approvedBy: "the-user",
        gaps: {},
        reason: "Reviewed before the changelog author attested.",
        unattributed: [head],
      },
      repositoryPath: prepared.path,
    });
    const review = recordReviewAttempt({
      attemptId: randomUUID(),
      authoring: {
        effective: {
          proposals: {
            effort: "xhigh",
            harness: "claude-code",
            model: "model-alpha",
            status: "resolved",
          },
          review: {
            adversarial: false,
            effort: "xhigh",
            escalateOnFindings: null,
            harness: "codex",
            model: "model-beta",
            reviewLoop: REVIEW_LOOP_DEFAULTS,
            status: "resolved",
          },
        },
        repairRequired: false,
      } as unknown as RepositoryAuthoring,
      head,
      proposalId: PROPOSAL,
      receipt: {
        effort: "xhigh",
        effortSource: "configured",
        findingsCount: 0,
        requested: { effort: "xhigh", harness: "codex", model: "model-beta" },
        verdict: "clean",
        verified: {
          agent: "model-beta",
          harness: "codex",
          instance: "reviewer-b",
          session: "thread-b",
        },
      },
      repositoryPath: prepared.path,
    });
    expect(review.attempt.accepted).toBe(true);
    const approval = () =>
      reviewApproval({
        adversarial: false,
        currentHead: head,
        freshEvidence: {
          checks: true,
          discussions: true,
          providerApproval: true,
        },
        ledger: readReviewLedger(run.lease.commonGitDirectory).ledger,
        proposalId: PROPOSAL,
        repairRequired: false,
      });
    expect(approval().approved).toBe(true);

    // The author attests through its registration on the frozen run, which
    // changes the head's authors digest.
    attestAsAuthor(prepared.path, [head]);
    const attested = recordAuthors();
    expect(attested.fullyCovered).toBe(true);
    expect(attested.authorsDigest).not.toBe(unattested.authorsDigest);
    expect(approval()).toMatchObject({
      approved: false,
      reasons: ["authors-digest-changed"],
    });
    expect(existsSync(join(prepared.path, "CHANGELOG.md"))).toBe(true);
  });
});
