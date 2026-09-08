import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  closeLoopTargetEquivalent,
  finalizeLoop,
  readLoopLease,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const fixtures: TestRepository[] = [];
setDefaultTimeout(300_000);
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup();
  }
});
const repository = () => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  return fixture;
};

describe("finalization record consistency", () => {
  test.each(["finalize", "close-equivalent"])(
    "%s preserves excluded stale registrations during global pruning",
    (operation) => {
      const fixture = repository();
      const merged = join(fixture.base, "merged");
      const unique = join(fixture.base, "unique");
      git(fixture.root, ["worktree", "add", "-b", "merged", merged]);
      git(fixture.root, ["worktree", "add", "-b", "unique", unique]);
      writeFixture(unique, "unique.txt", "Unpublished work\n");
      git(unique, ["add", "."]);
      git(unique, ["commit", "-m", "Unpublished work"]);
      const uniqueHead = git(unique, ["rev-parse", "HEAD"]);
      rmSync(merged, { recursive: true });
      rmSync(unique, { recursive: true });
      const lease = startLoop(fixture.root, "controller", "integrate");

      const result =
        operation === "finalize"
          ? finalizeLoop(
              fixture.root,
              lease.runId,
              "controller",
              "Finish cleanup"
            )
          : closeLoopTargetEquivalent(
              fixture.root,
              lease.runId,
              "controller",
              "user",
              "Already delivered"
            );

      expect(result.cleanup.prunedWorktreeMetadata).toBe(0);
      expect(
        captureInventory(fixture.root).worktrees.map(
          (worktree) => worktree.path
        )
      ).toContain(unique);
      expect(git(fixture.root, ["rev-parse", "unique"])).toBe(uniqueHead);
      if ("verification" in result) {
        expect(result.verification.ok).toBe(true);
        closeLoopTargetEquivalent(
          fixture.root,
          lease.runId,
          "controller",
          "user",
          "Close with protected registrations intact"
        );
      }
      expect(readLoopLease(fixture.root)).toBeNull();
    }
  );

  test.each([false, true])(
    "records its own fast-forward of a preserved primary (interrupted: %s)",
    (interrupted) => {
      const fixture = repository();
      git(fixture.root, [
        "remote",
        "add",
        "origin",
        "https://example.invalid/repo.git",
      ]);
      git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      git(fixture.root, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      ]);
      const author = join(fixture.base, "author");
      git(fixture.root, ["worktree", "add", "-b", "author", author]);
      writeFixture(author, "delivered.txt", "Delivered\n");
      git(author, ["add", "."]);
      git(author, ["commit", "-m", "Delivered change"]);
      git(author, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const lease = startLoop(author, "controller", "integrate");
      expect(
        lease.worktrees.find((worktree) => worktree.path === fixture.root)?.role
      ).toBe("preserved");

      if (interrupted) {
        process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_PRIMARY_SYNC = lease.runId;
        try {
          expect(() =>
            finalizeLoop(
              author,
              lease.runId,
              "controller",
              "Interrupted update"
            )
          ).toThrow("Injected failure after primary synchronization");
        } finally {
          delete process.env.SIMPLE_CHANGES_TEST_FAIL_AFTER_PRIMARY_SYNC;
        }
        const original = lease.worktrees.find(
          (worktree) => worktree.path === fixture.root
        );
        expect(
          readLoopLease(author)?.worktrees.find(
            (worktree) => worktree.path === fixture.root
          )
        ).toEqual(original);
        writeFixture(fixture.root, "personal.txt", "Unrelated new work\n");
        expect(() =>
          closeLoopTargetEquivalent(
            author,
            lease.runId,
            "controller",
            "user",
            "Do not absorb new work"
          )
        ).toThrow("final verification or cleanup is incomplete");
        expect(
          readLoopLease(author)?.worktrees.find(
            (worktree) => worktree.path === fixture.root
          )
        ).toEqual(original);
        rmSync(join(fixture.root, "personal.txt"));
      } else {
        const result = finalizeLoop(
          author,
          lease.runId,
          "controller",
          "Update primary after delivery"
        );
        expect(result).toMatchObject({
          cleanup: { primaryUpdated: true },
          verification: { ok: true },
        });
      }
      closeLoopTargetEquivalent(
        author,
        lease.runId,
        "controller",
        "user",
        "Close after verified synchronization"
      );
      expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(
        git(author, ["rev-parse", "HEAD"])
      );
      expect(readLoopLease(fixture.root)).toBeNull();
    }
  );

  test("archive failure leaves cleanup evidence and a retryable run", () => {
    const fixture = repository();
    const merged = join(fixture.base, "merged");
    git(fixture.root, ["worktree", "add", "-b", "merged", merged]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    const archivePath = join(
      lease.commonGitDirectory,
      "simple-changes",
      "history",
      lease.runId,
      "close-equivalent.json"
    );
    mkdirSync(archivePath, { recursive: true });

    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        lease.runId,
        "controller",
        "user",
        "Attempt archive"
      )
    ).toThrow();
    const remaining = readLoopLease(fixture.root);
    expect(remaining?.closeEquivalentOutcome).toBeUndefined();
    expect(remaining?.dispositions).toContainEqual(
      expect.objectContaining({ path: merged, status: "completed" })
    );
    rmSync(archivePath, { recursive: true });
    expect(
      closeLoopTargetEquivalent(
        fixture.root,
        lease.runId,
        "controller",
        "user",
        "Retry archive"
      ).outcome
    ).toBe("target-equivalent");
    expect(readLoopLease(fixture.root)).toBeNull();
  });

  test("failed closure does not record a terminal outcome", () => {
    const fixture = repository();
    const preserved = join(fixture.base, "preserved");
    git(fixture.root, ["worktree", "add", "-b", "preserved", preserved]);
    const lease = startLoop(fixture.root, "controller", "integrate");
    writeFixture(preserved, "unfinished.txt", "Still working\n");

    expect(() =>
      closeLoopTargetEquivalent(
        fixture.root,
        lease.runId,
        "controller",
        "user",
        "Attempt cleanup"
      )
    ).toThrow("final verification or cleanup is incomplete");
    expect(readLoopLease(fixture.root)?.closeEquivalentOutcome).toBeUndefined();
    rmSync(join(preserved, "unfinished.txt"));
    expect(
      closeLoopTargetEquivalent(
        fixture.root,
        lease.runId,
        "controller",
        "user",
        "Retry after work is reconciled"
      ).outcome
    ).toBe("target-equivalent");
    expect(readLoopLease(fixture.root)).toBeNull();
  });
});
