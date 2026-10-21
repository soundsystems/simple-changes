import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  executeLoopMutation,
  finalizeLoop,
  loopLeasePath,
  readLoopLease,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// A resumed run must recognize the worktree its own interrupted finalization
// removed (#18), even after a guarded fetch moves the target past the
// revision the removal audited.

setDefaultTimeout(120_000);

const fixtures: TestRepository[] = [];
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
});

interface InterruptedRemoval extends TestRepository {
  common: string;
  removed: string;
  runId: string;
  upstream: string;
}

/**
 * An integrate run tracking `origin/main` whose finalization removed an
 * unchanged opening worktree the target already contains, then failed to
 * archive, so it relinquished with the removal recorded as completed.
 */
const interruptedRemoval = (): InterruptedRemoval => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  const origin = join(fixture.base, "origin.git");
  git(fixture.base, ["init", "--bare", "-b", "main", origin]);
  git(fixture.root, ["remote", "add", "origin", origin]);
  git(fixture.root, ["push", "origin", "main"]);
  git(fixture.root, ["fetch", "origin"]);
  git(fixture.root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  const upstream = join(fixture.base, "upstream");
  git(fixture.base, ["clone", origin, upstream]);
  git(upstream, ["config", "user.name", "Simple Changes Tests"]);
  git(upstream, ["config", "user.email", "tests@simple-changes.invalid"]);
  const removed = join(fixture.base, "already-merged");
  git(fixture.root, ["worktree", "add", "-b", "already-merged", removed]);
  const lease = startLoop(fixture.root, "controller", "integrate");
  expect(lease.targetRef).toBe("origin/main");
  const history = join(lease.commonGitDirectory, "simple-changes", "history");
  writeFileSync(history, "archive unavailable\n");
  expect(() =>
    finalizeLoop(fixture.root, lease.runId, "controller", "Finish cleanup.")
  ).toThrow();
  rmSync(history);
  const retained = readLoopLease(fixture.root);
  expect(retained?.controller?.status).toBe("relinquished");
  expect(existsSync(removed)).toBe(false);
  expect(retained?.dispositions).toContainEqual(
    expect.objectContaining({
      outcome: "remove-after-audit",
      path: removed,
      status: "completed",
      targetRevision: lease.targetRevision,
    })
  );
  expect(retained?.worktrees).toContainEqual(
    expect.objectContaining({ path: removed, role: "preserved" })
  );
  return {
    ...fixture,
    common: lease.commonGitDirectory,
    removed,
    runId: lease.runId,
    upstream,
  };
};

// Someone else lands a commit on the remote target.
const advanceUpstream = (fixture: InterruptedRemoval): string => {
  writeFixture(fixture.upstream, "upstream.txt", "landed elsewhere\n");
  git(fixture.upstream, ["add", "upstream.txt"]);
  git(fixture.upstream, ["commit", "-m", "Land upstream work"]);
  git(fixture.upstream, ["push", "origin", "main"]);
  return git(fixture.upstream, ["rev-parse", "HEAD"]);
};

const fetchThroughLoop = (fixture: InterruptedRemoval) =>
  executeLoopMutation(fixture.root, fixture.runId, "next-controller", [
    "git",
    "fetch",
    "origin",
  ]);

describe("resumed finalization removals", () => {
  test("a completed removal stays accepted after a resume and a guarded fetch move the target", async () => {
    const fixture = interruptedRemoval();
    const landed = advanceUpstream(fixture);
    expect(startLoop(fixture.root, "next-controller", "resume").runId).toBe(
      fixture.runId
    );
    expect(verifyLoop(fixture.root)).toMatchObject({ ok: true });

    const fetched = await fetchThroughLoop(fixture);
    expect(git(fixture.root, ["rev-parse", "origin/main"])).toBe(landed);
    expect(fetched.verification).toMatchObject({ ok: true, violations: [] });
    expect(verifyLoop(fixture.root)).toMatchObject({
      ok: true,
      violations: [],
    });
    expect(
      finalizeLoop(
        fixture.root,
        fixture.runId,
        "next-controller",
        "Finish after the resumed fetch."
      ).outcome
    ).toBe("completed");
    expect(readLoopLease(fixture.root)).toBeNull();
  });

  test("an intended removal at an old target still reports the missing worktree", async () => {
    const fixture = interruptedRemoval();
    // The same absence backed only by an unfinished intent, as if the run had
    // stopped between removing the path and recording the removal.
    const path = loopLeasePath(fixture.common);
    const stored = JSON.parse(readFileSync(path, "utf8")) as LoopLease;
    stored.dispositions = (stored.dispositions ?? []).map((disposition) => {
      if (disposition.path !== fixture.removed) {
        return disposition;
      }
      const { completedAt: _completedAt, ...intent } = disposition;
      return { ...intent, status: "intended" as const };
    });
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
    advanceUpstream(fixture);
    startLoop(fixture.root, "next-controller", "resume");
    // At the audited target revision the intent still covers the absence.
    expect(verifyLoop(fixture.root)).toMatchObject({ ok: true });

    await expect(fetchThroughLoop(fixture)).rejects.toThrow(
      `missing-preserved-worktree:${fixture.removed}`
    );
    expect(verifyLoop(fixture.root).violations).toContainEqual(
      expect.objectContaining({
        code: "missing-preserved-worktree",
        path: fixture.removed,
      })
    );
  });
});
