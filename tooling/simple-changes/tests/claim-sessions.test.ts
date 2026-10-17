import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { attestCommits } from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import type { WorktreeInventory } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  attachClaimedWorktree,
  claimWorktree,
  detachClaimedWorktree,
  pauseClaimedWorktree,
  readWorktreeCoordination,
  readWorktreeTakeovers,
  releaseHandoffWorktreeClaim,
  releaseWorktreeClaim,
  takeoverWorktreeClaim,
  type WorktreeTakeoverOptions,
  worktreeCoordinationPath,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// An agent ID acts on its claims, and attests through them, only from the
// harness session that holds them (#9).

setDefaultTimeout(60_000);

const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const SESSION_VARIABLES = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"];
const ANOTHER_SESSION = "belongs to another harness session of author-1";
// The old recovery wording, which read as an instruction to run the owner's
// steps under its agent ID.
const OWNER_RUNS_PATTERN = /(?:^|\. )Owner author-1 runs/u;

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
  for (const name of SESSION_VARIABLES) {
    Reflect.deleteProperty(process.env, name);
  }
});

type Session = Record<string, string>;
const SESSION_A: Session = { CLAUDE_CODE_SESSION_ID: "session-a" };
const SESSION_B: Session = { CLAUDE_CODE_SESSION_ID: "session-b" };
const THREAD_C: Session = { CODEX_THREAD_ID: "thread-c" };
const NO_SESSION: Session = {};

// Runs `step` as if the harness session `session` executed it.
const as = <T>(session: Session, step: () => T): T => {
  const saved = SESSION_VARIABLES.map((name) => [name, process.env[name]]);
  for (const name of SESSION_VARIABLES) {
    Reflect.deleteProperty(process.env, name);
  }
  Object.assign(process.env, session);
  try {
    return step();
  } finally {
    for (const [name, value] of saved) {
      if (name && value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else if (name && value !== undefined) {
        process.env[name] = value;
      }
    }
  }
};

const commit = (cwd: string, path: string, contents: string): string => {
  writeFixture(cwd, path, contents);
  git(cwd, ["add", path]);
  git(cwd, ["commit", "-m", `Write ${path}`]);
  return git(cwd, ["rev-parse", "HEAD"]);
};

const worktreeAt = (root: string, path: string): WorktreeInventory => {
  const current = captureInventory(root).worktrees.find(
    (worktree) => worktree.path === path
  );
  if (!current) {
    throw new Error(`Expected a checkout at ${path}`);
  }
  return current;
};

const addWorktree = (fixture: TestRepository, name: string): string => {
  const path = join(fixture.base, name);
  git(fixture.root, ["worktree", "add", "-b", name, path]);
  return path;
};

const claimOf = (root: string, claimId: string) =>
  readWorktreeCoordination(root).claims.find(
    (claim) => claim.claimId === claimId
  );

const takeoverOptions = (
  fixture: TestRepository,
  claimId: string,
  current: WorktreeInventory,
  newAgentId: string
): WorktreeTakeoverOptions => ({
  action: "reassign",
  approvedBy: "the-user",
  claimId,
  expectedBranch: current.branch,
  expectedHeadSha: current.headSha ?? "",
  expectedStatusDigest: current.changeDigest,
  newAgentId,
  reason: "The first session ended and cannot be contacted.",
  repositoryPath: fixture.root,
});

describe("claims belong to the session that made them", () => {
  test("the same session re-claims, pauses, and releases its own claim", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "own-work");
    as(SESSION_A, () => {
      const claim = claimWorktree(
        fixture.root,
        "author-1",
        path,
        "claude-code"
      );
      writeFixture(path, "draft.ts", "export const draft = 1;\n");
      expect(
        claimWorktree(fixture.root, "author-1", path, "claude-code")
      ).toMatchObject({ claimId: claim.claimId, state: "active" });
      expect(
        pauseClaimedWorktree(
          fixture.root,
          "author-1",
          path,
          "run-own",
          "preserve-in-place",
          "Safe boundary."
        )
      ).toMatchObject({ claimId: claim.claimId });
      expect(
        releaseWorktreeClaim(fixture.root, "author-1", claim.claimId)
      ).toMatchObject({ releaseReason: "owner-release", state: "released" });
    });
  });

  test("another session cannot claim, pause, release, or hand off under the owner's agent ID", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "owned-work");
    const claim = as(SESSION_A, () =>
      claimWorktree(fixture.root, "author-1", path, "claude-code", "task-1")
    );
    const before = readWorktreeCoordination(fixture.root);

    for (const session of [SESSION_B, THREAD_C, NO_SESSION]) {
      as(session, () => {
        expect(() =>
          claimWorktree(fixture.root, "author-1", path, "claude-code", "task-1")
        ).toThrow(ANOTHER_SESSION);
        // A different owner reference is still the session refusal, never
        // the advice to release the claim first.
        expect(() =>
          claimWorktree(fixture.root, "author-1", path, "claude-code")
        ).toThrow(ANOTHER_SESSION);
        expect(() =>
          pauseClaimedWorktree(
            fixture.root,
            "author-1",
            path,
            "run-other",
            "preserve-in-place",
            "Acting for the owner."
          )
        ).toThrow(ANOTHER_SESSION);
        expect(() =>
          releaseWorktreeClaim(fixture.root, "author-1", claim.claimId)
        ).toThrow(ANOTHER_SESSION);
        expect(() => releaseHandoffWorktreeClaim(path, "author-1")).toThrow(
          ANOTHER_SESSION
        );
      });
    }
    expect(() =>
      as(NO_SESSION, () =>
        claimWorktree(fixture.root, "author-1", path, "claude-code", "task-1")
      )
    ).toThrow("this command reports no harness session");

    const current = worktreeAt(fixture.root, path);
    expect(() =>
      as(SESSION_B, () =>
        claimWorktree(fixture.root, "author-1", path, "claude-code", "task-1")
      )
    ).toThrow(
      `ask the user to approve \`simple-changes worktree takeover --claim-id ${claim.claimId} --agent-id <you> --head ${current.headSha} --branch owned-work --status-digest ${current.changeDigest} --approved-by <user> --reason <why>\``
    );
    // Nothing was recorded by any refused step.
    expect(readWorktreeCoordination(fixture.root)).toEqual(before);
  });

  test("another session cannot take up the agent ID elsewhere or reclaim its released checkout", () => {
    const fixture = repository();
    const first = addWorktree(fixture, "first-work");
    const second = addWorktree(fixture, "second-work");
    const claim = as(SESSION_A, () =>
      claimWorktree(fixture.root, "author-1", first, "claude-code")
    );

    expect(() =>
      as(SESSION_B, () =>
        claimWorktree(fixture.root, "author-1", second, "claude-code")
      )
    ).toThrow(
      `Agent author-1 still holds claim ${claim.claimId} on ${first} in another harness session`
    );
    as(SESSION_A, () =>
      releaseWorktreeClaim(fixture.root, "author-1", claim.claimId)
    );
    expect(() =>
      as(SESSION_B, () =>
        claimWorktree(fixture.root, "author-1", first, "claude-code")
      )
    ).toThrow(
      `Agent author-1's earlier claim ${claim.claimId} on ${first} (released: owner-release) belongs to another harness session`
    );
    // The checkout passes to the new session under its own agent ID, and
    // the released agent ID may start unrelated work elsewhere.
    as(SESSION_B, () => {
      expect(
        claimWorktree(fixture.root, "author-2", first, "claude-code").owner
          .agentId
      ).toBe("author-2");
      expect(
        claimWorktree(fixture.root, "author-1", second, "claude-code").path
      ).toBe(second);
    });
  });

  test("an unbound claim refuses no one, and the first known session binds it", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "unbound-work");
    const claim = as(NO_SESSION, () =>
      claimWorktree(fixture.root, "author-1", path, "codex")
    );
    // A claim made before session marks existed, or without a session,
    // keeps working for the next command.
    as(NO_SESSION, () =>
      expect(
        claimWorktree(fixture.root, "author-1", path, "codex").claimId
      ).toBe(claim.claimId)
    );
    const eventsBefore = readWorktreeCoordination(fixture.root).events.length;
    as(THREAD_C, () =>
      expect(
        claimWorktree(fixture.root, "author-1", path, "codex").claimId
      ).toBe(claim.claimId)
    );
    expect(readWorktreeCoordination(fixture.root).events).toHaveLength(
      eventsBefore + 1
    );
    expect(() =>
      as(SESSION_B, () =>
        pauseClaimedWorktree(
          fixture.root,
          "author-1",
          path,
          "run-other",
          "preserve-in-place",
          "Acting for the owner."
        )
      )
    ).toThrow(ANOTHER_SESSION);
    as(THREAD_C, () =>
      expect(
        releaseWorktreeClaim(fixture.root, "author-1", claim.claimId).state
      ).toBe("released")
    );
  });

  test("an approved takeover moves the claim to the replacement session", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "replaced-work");
    const claim = as(SESSION_A, () =>
      claimWorktree(fixture.root, "author-1", path, "claude-code", "task-1")
    );
    const current = worktreeAt(fixture.root, path);
    as(SESSION_B, () =>
      takeoverWorktreeClaim(
        takeoverOptions(fixture, claim.claimId, current, "author-1")
      )
    );

    expect(() =>
      as(SESSION_A, () =>
        claimWorktree(
          fixture.root,
          "author-1",
          path,
          "claude-code",
          "takeover:the-user"
        )
      )
    ).toThrow(ANOTHER_SESSION);
    as(SESSION_B, () => {
      writeFixture(path, "more.ts", "export const more = 1;\n");
      expect(
        claimWorktree(
          fixture.root,
          "author-1",
          path,
          "claude-code",
          "takeover:the-user"
        ).changeDigest
      ).toBe(worktreeAt(fixture.root, path).changeDigest);
      expect(
        pauseClaimedWorktree(
          fixture.root,
          "author-1",
          path,
          "run-replacement",
          "preserve-in-place",
          "Safe boundary."
        ).ownerAgentId
      ).toBe("author-1");
    });
  });

  test("only the latest claim on a checkout decides, so an approved takeover's history counts", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "history-work");
    const second = as(SESSION_A, () => {
      const first = claimWorktree(
        fixture.root,
        "author-1",
        path,
        "claude-code"
      );
      releaseWorktreeClaim(fixture.root, "author-1", first.claimId);
      return claimWorktree(fixture.root, "author-1", path, "claude-code");
    });
    const current = worktreeAt(fixture.root, path);
    as(SESSION_B, () => {
      takeoverWorktreeClaim(
        takeoverOptions(fixture, second.claimId, current, "author-1")
      );
      releaseWorktreeClaim(fixture.root, "author-1", second.claimId);
      // Session A's older released claim on this checkout does not count.
      expect(
        claimWorktree(fixture.root, "author-1", path, "claude-code").owner
          .agentId
      ).toBe("author-1");
    });
  });

  test("a stale claim passes to a replacement session only through an approved takeover", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "stale-work");
    const releasable = addWorktree(fixture, "stale-releasable");
    const [claim, other] = as(SESSION_A, () => [
      claimWorktree(fixture.root, "author-1", path, "claude-code"),
      claimWorktree(fixture.root, "author-1", releasable, "claude-code"),
    ]);
    // The owner's pause finds its checkouts moved and marks the claims
    // stale, then its session ends.
    for (const checkout of [path, releasable]) {
      commit(checkout, "moved.ts", "export const moved = true;\n");
      expect(() =>
        as(SESSION_A, () =>
          pauseClaimedWorktree(
            fixture.root,
            "author-1",
            checkout,
            "run-stale",
            "preserve-in-place",
            "Safe boundary."
          )
        )
      ).toThrow("The claim is stale");
    }
    expect(claimOf(fixture.root, claim.claimId)?.state).toBe("stale");
    expect(() =>
      as(SESSION_B, () =>
        claimWorktree(fixture.root, "author-1", path, "claude-code")
      )
    ).toThrow(ANOTHER_SESSION);

    const current = worktreeAt(fixture.root, path);
    as(SESSION_B, () => {
      takeoverWorktreeClaim(
        takeoverOptions(fixture, claim.claimId, current, "author-1")
      );
      expect(
        claimWorktree(
          fixture.root,
          "author-1",
          path,
          "claude-code",
          "takeover:the-user"
        ).state
      ).toBe("active");
      expect(
        pauseClaimedWorktree(
          fixture.root,
          "author-1",
          path,
          "run-stale",
          "preserve-in-place",
          "Safe boundary."
        ).headSha
      ).toBe(current.headSha);
      expect(
        takeoverWorktreeClaim({
          ...takeoverOptions(
            fixture,
            other.claimId,
            worktreeAt(fixture.root, releasable),
            "rescuer"
          ),
          action: "release",
        }).claim.state
      ).toBe("released");
    });
  });

  test("a detached claim passes to a replacement session through a takeover of its recorded branch", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "detached-work");
    const claim = as(SESSION_A, () => {
      const made = claimWorktree(fixture.root, "author-1", path, "claude-code");
      const receipt = pauseClaimedWorktree(
        fixture.root,
        "author-1",
        path,
        "run-detach",
        "detach-clean-checkout",
        "Detach to free the disk."
      );
      detachClaimedWorktree(fixture.root, "author-1", path, receipt.receiptId);
      return made;
    });
    const recorded = {
      branch: "detached-work",
      changeDigest: claim.changeDigest,
      headSha: claim.headSha,
    };

    expect(() =>
      as(SESSION_B, () =>
        attachClaimedWorktree(fixture.root, "author-1", claim.claimId)
      )
    ).toThrow(
      `--head ${claim.headSha} --branch detached-work --status-digest ${claim.changeDigest}`
    );
    const options = takeoverOptions(
      fixture,
      claim.claimId,
      recorded as WorktreeInventory,
      "author-1"
    );
    // The preserved branch moved after detach: the approval no longer covers it.
    const moved = commit(fixture.root, "main-only.ts", "export const x = 1;\n");
    git(fixture.root, ["branch", "-f", "detached-work", moved]);
    expect(() => as(SESSION_B, () => takeoverWorktreeClaim(options))).toThrow(
      `but the branch now points at ${moved}`
    );
    git(fixture.root, ["branch", "-f", "detached-work", claim.headSha ?? ""]);

    as(SESSION_B, () => {
      expect(takeoverWorktreeClaim(options).claim).toMatchObject({
        owner: { agentId: "author-1", ownerRef: "takeover:the-user" },
        state: "detached",
      });
      expect(
        attachClaimedWorktree(fixture.root, "author-1", claim.claimId).state
      ).toBe("attached");
    });
    expect(worktreeAt(fixture.root, path).headSha).toBe(claim.headSha);
  });

  test("a takeover recorded by an older client leaves the claim unbound for its new owner", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "old-client-work");
    const claim = as(SESSION_A, () =>
      claimWorktree(fixture.root, "author-1", path, "claude-code")
    );
    // An older client reassigns the claim and marks no session.
    const coordinationPath = worktreeCoordinationPath(
      captureInventory(fixture.root).repository.commonGitDirectory
    );
    const document = JSON.parse(readFileSync(coordinationPath, "utf8")) as {
      claims: { claimId: string; owner: Record<string, unknown> }[];
      events: Record<string, unknown>[];
    };
    for (const item of document.claims) {
      if (item.claimId === claim.claimId) {
        item.owner = {
          adapter: "claude-code",
          agentId: "rescuer",
          ownerRef: "takeover:the-user",
        };
      }
    }
    document.events.push({
      actorAgentId: "rescuer",
      claimId: claim.claimId,
      createdAt: new Date().toISOString(),
      eventId: "event-00000000-0000-4000-8000-000000000000",
      state: "active",
    });
    writeFileSync(coordinationPath, `${JSON.stringify(document)}\n`);

    // Session A's mark was the old owner's, so it binds the new owner to
    // nothing; the new owner's first known session binds the claim.
    as(SESSION_B, () =>
      claimWorktree(
        fixture.root,
        "rescuer",
        path,
        "claude-code",
        "takeover:the-user"
      )
    );
    expect(() =>
      as(SESSION_A, () =>
        releaseWorktreeClaim(fixture.root, "rescuer", claim.claimId)
      )
    ).toThrow("belongs to another harness session of rescuer");
    as(SESSION_B, () =>
      expect(
        releaseWorktreeClaim(fixture.root, "rescuer", claim.claimId).state
      ).toBe("released")
    );
  });

  test("a takeover retried from another session is not taken as already applied", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "retried-work");
    const claim = as(SESSION_A, () =>
      claimWorktree(fixture.root, "author-1", path, "claude-code")
    );
    const current = worktreeAt(fixture.root, path);
    const options = takeoverOptions(fixture, claim.claimId, current, "rescuer");
    as(SESSION_A, () => takeoverWorktreeClaim(options));

    // The same approval again, from session B, interrupted after its intent.
    process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT = claim.claimId;
    try {
      expect(() => as(SESSION_B, () => takeoverWorktreeClaim(options))).toThrow(
        "durable takeover intent"
      );
    } finally {
      Reflect.deleteProperty(
        process.env,
        "SIMPLE_CHANGES_TEST_FAIL_AFTER_TAKEOVER_INTENT"
      );
    }
    as(SESSION_B, () => takeoverWorktreeClaim(options));
    expect(
      readWorktreeTakeovers(
        captureInventory(fixture.root).repository.commonGitDirectory
      ).map((receipt) => receipt.phase)
    ).toEqual(["completed", "completed"]);
    // The claim now belongs to session B.
    expect(() =>
      as(SESSION_A, () =>
        releaseWorktreeClaim(fixture.root, "rescuer", claim.claimId)
      )
    ).toThrow("belongs to another harness session of rescuer");
    as(SESSION_B, () =>
      expect(
        releaseWorktreeClaim(fixture.root, "rescuer", claim.claimId).state
      ).toBe("released")
    );
  });
});

describe("attestation belongs to the session that holds the claim", () => {
  test("another session cannot attest under the claim owner's agent ID", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "attested-work");
    as(SESSION_A, () =>
      claimWorktree(fixture.root, "author-1", path, "claude-code")
    );
    const sha = commit(path, "feature.ts", "export const feature = 1;\n");

    for (const environment of [SESSION_B, THREAD_C, NO_SESSION]) {
      expect(() =>
        attestCommits({
          commits: [sha],
          environment,
          logicalId: "author-1",
          repositoryPath: path,
        })
      ).toThrow("Attest from the session that made the commits. Claim");
    }
    expect(
      attestCommits({
        commits: [sha],
        environment: SESSION_A,
        logicalId: "author-1",
        repositoryPath: path,
      }).attestations
    ).toEqual([{ commit: sha, status: "recorded" }]);
  });
});

describe("the reproducer from #9", () => {
  test("a second session cannot claim and pause a vanished author's checkout under its ID", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "author-work");
    commit(path, "feature.ts", "export const feature = 1;\n");
    as(SESSION_A, () =>
      claimWorktree(fixture.root, "author-1", path, "claude-code", "task-1")
    );
    const lease = startLoop(fixture.root, "controller", "integrate");
    // The author leaves its checkout on another branch and its session ends.
    git(path, ["checkout", "-b", "author-work-continued"]);

    const stale = verifyLoop(fixture.root).violations.find(
      (violation) =>
        violation.code === "coordination-claim-stale" && violation.path === path
    );
    expect(stale?.message).toContain(
      "Ask owner author-1 to run `simple-changes worktree claim --agent-id author-1"
    );
    expect(stale?.message).toContain(
      "Do not run the owner's steps under its agent ID from another session."
    );
    expect(stale?.message).toContain(
      "If author-1 no longer exists, ask the user to approve `simple-changes worktree takeover"
    );
    expect(stale?.message).not.toMatch(OWNER_RUNS_PATTERN);

    as(SESSION_B, () => {
      expect(() =>
        claimWorktree(fixture.root, "author-1", path, "claude-code", "task-1")
      ).toThrow(ANOTHER_SESSION);
      expect(() =>
        pauseClaimedWorktree(
          fixture.root,
          "author-1",
          path,
          lease.runId,
          "preserve-in-place",
          "Acting for the owner."
        )
      ).toThrow(ANOTHER_SESSION);
    });
    expect(readWorktreeCoordination(fixture.root).receipts).toEqual([]);
  });

  test("the CLI refuses a second session's claim under the first session's agent ID", () => {
    const fixture = repository();
    const path = addWorktree(fixture, "cli-work");
    const run = (session: Session) => {
      const result = spawnSync(
        [
          "bun",
          cliPath,
          "worktree",
          "claim",
          "--agent-id",
          "author-1",
          "--worktree",
          path,
          "--adapter",
          "claude-code",
          "--repo",
          fixture.root,
        ],
        {
          cwd: fixture.root,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) => !SESSION_VARIABLES.includes(name)
              )
            ),
            ...session,
            SIMPLE_CHANGES_SKILL_ROOTS: "",
          },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      return {
        exitCode: result.exitCode,
        stderr: decoder.decode(result.stderr),
      };
    };
    expect(run(SESSION_A).exitCode).toBe(0);
    expect(run(SESSION_A).exitCode).toBe(0);
    const refused = run(SESSION_B);
    expect(refused.exitCode).toBe(5);
    expect(refused.stderr).toContain(ANOTHER_SESSION);
    const [claim] = readWorktreeCoordination(fixture.root).claims;
    expect(claimOf(fixture.root, claim?.claimId ?? "")?.owner.agentId).toBe(
      "author-1"
    );
  });
});
