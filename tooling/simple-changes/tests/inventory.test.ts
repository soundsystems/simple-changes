import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  captureInventory,
  compareSnapshots,
  credentialFreeRemoteUrl,
  indexObjectIds,
  locateRepository,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

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
});

describe("Git inventory and concurrency", () => {
  test("removes embedded Git credentials while preserving destination identity", () => {
    expect(
      credentialFreeRemoteUrl(
        "https://oauth2:TOPSECRET@gitlab.example/group/repo.git"
      )
    ).toBe("https://gitlab.example/group/repo.git");
    expect(
      credentialFreeRemoteUrl("https://gitlab.example/group/repo.git")
    ).toBe("https://gitlab.example/group/repo.git");
    expect(
      credentialFreeRemoteUrl(
        "https://oauth2:p%40ss@gitlab.example/group/repo.git?private_token=TOPSECRET#SECONDSECRET"
      )
    ).toBe("https://gitlab.example/group/repo.git");
  });
  test("inventories dirty work without creating run state", () => {
    const fixture = repository();
    writeFixture(fixture.root, "src/change.ts", "export const ready = true;\n");
    const beforeStatus = git(fixture.root, ["status", "--porcelain=v1"]);
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current)
    );
    expect(opening.repository.primaryCheckout).toBe(fixture.root);
    expect(opening.localChanges.map((change) => change.path)).toContain(
      "src/change.ts"
    );
    expect(plan.units).toHaveLength(1);
    expect(plan.mutationCount).toBe(0);
    expect(git(fixture.root, ["status", "--porcelain=v1"])).toBe(beforeStatus);
    expect(existsSync(join(fixture.root, ".git/simple-changes"))).toBe(false);
  });

  test("inventories an uncommitted authoring sidecar as ordinary work and a committed one as clean", () => {
    const fixture = repository();
    const sidecar = `${JSON.stringify({ harnesses: {}, roles: {}, schemaVersion: 1 })}\n`;
    writeFixture(fixture.root, ".simple-changes-authoring.json", sidecar);
    const uncommitted = captureInventory(fixture.root);
    expect(uncommitted.localChanges.map((change) => change.path)).toContain(
      ".simple-changes-authoring.json"
    );
    git(fixture.root, ["add", ".simple-changes-authoring.json"]);
    git(fixture.root, ["commit", "-m", "Record authoring preferences"]);
    const committed = captureInventory(fixture.root);
    expect(committed.localChanges.map((change) => change.path)).not.toContain(
      ".simple-changes-authoring.json"
    );
  });

  test("streams large binary identities and never reads a FIFO", () => {
    const fixture = repository();
    const binaryPath = join(fixture.root, "large.bin");
    const fifoPath = join(fixture.root, "agent.pipe");
    writeFixture(fixture.root, "agent.pipe", "tracked placeholder\n");
    git(fixture.root, ["add", "agent.pipe"]);
    git(fixture.root, ["commit", "-m", "Track future pipe path"]);
    unlinkSync(fifoPath);
    writeFileSync(binaryPath, Buffer.alloc(8 * 1024 * 1024, 7));
    const fifo = spawnSync("mkfifo", [fifoPath]);
    if (fifo.status !== 0) {
      throw new Error(`mkfifo failed: ${fifo.stderr.toString()}`);
    }

    const opening = captureInventory(fixture.root);
    writeFileSync(binaryPath, Buffer.alloc(8 * 1024 * 1024, 8));
    const current = captureInventory(fixture.root);

    expect(opening.localChanges.map((change) => change.path)).toContain(
      "agent.pipe"
    );
    expect(current.baselineDigest).not.toBe(opening.baselineDigest);
  }, 15_000);

  test("prefers the branch remote over an alphabetically earlier auxiliary remote", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "auxiliary",
      "https://example.invalid/aux.git",
    ]);
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/canonical.git",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/auxiliary/main", "HEAD"]);
    git(fixture.root, [
      "symbolic-ref",
      "refs/remotes/auxiliary/HEAD",
      "refs/remotes/auxiliary/main",
    ]);
    git(fixture.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(fixture.root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    git(fixture.root, ["config", "branch.main.remote", "origin"]);
    git(fixture.root, ["config", "branch.main.merge", "refs/heads/main"]);

    const inventory = captureInventory(fixture.root);
    expect(inventory.targetRef).toBe("origin/main");
    expect(inventory.repository.targetRemote).toBe("origin");
    expect(inventory.repository.remoteBindings).toContainEqual({
      fetchUrls: ["https://example.invalid/canonical.git"],
      name: "origin",
      provider: "example.invalid",
      pushUrls: ["https://example.invalid/canonical.git"],
    });
  });

  test("targets the integration remote of the default branch from an unbound feature branch", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/mirror.git",
    ]);
    git(fixture.root, [
      "remote",
      "add",
      "gitlab",
      "https://example.invalid/canonical.git",
    ]);
    for (const remote of ["origin", "gitlab"]) {
      git(fixture.root, ["update-ref", `refs/remotes/${remote}/main`, "HEAD"]);
      git(fixture.root, [
        "symbolic-ref",
        `refs/remotes/${remote}/HEAD`,
        `refs/remotes/${remote}/main`,
      ]);
    }
    // The repository integrates through gitlab and keeps origin as a mirror.
    git(fixture.root, ["config", "branch.main.remote", "gitlab"]);
    git(fixture.root, ["config", "branch.main.merge", "refs/heads/main"]);
    // A feature branch cut before its first push binds no remote of its own.
    git(fixture.root, ["checkout", "-b", "feature/unbound"]);

    const inventory = captureInventory(fixture.root);
    expect(inventory.targetRef).toBe("gitlab/main");
    expect(inventory.repository.targetRemote).toBe("gitlab");

    git(fixture.root, ["symbolic-ref", "--delete", "refs/remotes/gitlab/HEAD"]);
    const withoutRemoteHead = captureInventory(fixture.root);
    expect(withoutRemoteHead.targetRef).toBe("gitlab/main");
    expect(withoutRemoteHead.repository.targetRemote).toBe("gitlab");
  });

  test("reports changelog relevance separately from skill availability", () => {
    const fixture = repository();
    writeFixture(fixture.root, "CHANGELOG.md", "# Changelog\n");
    const inventory = captureInventory(fixture.root, {
      changelogEnvironment: {
        SIMPLE_CHANGES_SKILL_ROOTS: "",
      },
    });

    expect(inventory.capabilities).toContainEqual(
      expect.objectContaining({
        category: "changelog",
        provider: "repository-native",
        status: "configuration",
      })
    );
  });

  test("reports a repository-local changelog skill as supported", () => {
    const fixture = repository();
    writeFixture(
      fixture.root,
      "skills/simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n"
    );
    const inventory = captureInventory(fixture.root);

    expect(inventory.capabilities).toContainEqual(
      expect.objectContaining({
        category: "changelog",
        provider: "simple-changelogs",
        status: "supported",
      })
    );
  });

  test("treats a stable wip-named worktree as ready", () => {
    const fixture = repository();
    const linked = join(fixture.base, "wip-linked");
    git(fixture.root, ["worktree", "add", "-b", "wip-stable", linked]);
    writeFixture(linked, "src/stable.ts", "export const stable = true;\n");
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const comparison = compareSnapshots(opening, current);
    const plan = buildPreviewPlan(opening, current, comparison);
    expect(comparison.stableWorktrees.map((item) => item.path)).toContain(
      linked
    );
    expect(plan.units.some((unit) => unit.sourceWorktree === linked)).toBe(
      true
    );
  });

  test("preserves a worktree created after the opening snapshot", () => {
    const fixture = repository();
    const opening = captureInventory(fixture.root);
    const linked = join(fixture.base, "concurrent-linked");
    git(fixture.root, ["worktree", "add", "-b", "concurrent-work", linked]);
    writeFixture(linked, "src/new.ts", "export const concurrent = true;\n");
    const current = captureInventory(fixture.root);
    const comparison = compareSnapshots(opening, current);
    const plan = buildPreviewPlan(opening, current, comparison);
    expect(comparison.concurrentWorktrees.map((item) => item.path)).toContain(
      linked
    );
    expect(plan.preserved).toContainEqual(
      expect.objectContaining({
        classification: "concurrent-arrival",
        worktreePath: linked,
      })
    );
  });

  test("preserves an existing worktree that changes between snapshots", () => {
    const fixture = repository();
    writeFixture(fixture.root, "src/first.ts", "export const first = true;\n");
    const opening = captureInventory(fixture.root);
    writeFixture(
      fixture.root,
      "src/second.ts",
      "export const second = true;\n"
    );
    const current = captureInventory(fixture.root);
    const comparison = compareSnapshots(opening, current);
    expect(comparison.activelyChangingWorktrees).toHaveLength(1);
    const plan = buildPreviewPlan(opening, current, comparison);
    expect(plan.units).toHaveLength(0);
    expect(plan.preserved[0]?.classification).toBe("actively-changing");
  });

  test("preserves symlink paths as unsafe", () => {
    const fixture = repository();
    symlinkSync("/tmp", join(fixture.root, "external-link"));
    const opening = captureInventory(fixture.root);
    const current = captureInventory(fixture.root);
    const plan = buildPreviewPlan(
      opening,
      current,
      compareSnapshots(opening, current)
    );
    expect(plan.units).toHaveLength(0);
    expect(plan.preserved[0]?.classification).toBe("unsafe");
  });

  test("inventories a pre-existing stash without changing it", () => {
    const fixture = repository();
    writeFixture(
      fixture.root,
      "src/stashed.ts",
      "export const stash = true;\n"
    );
    git(fixture.root, ["add", "src/stashed.ts"]);
    git(fixture.root, ["stash", "push", "-m", "existing fixture stash"]);
    writeFixture(fixture.root, "src/ready.ts", "export const ready = true;\n");
    const before = git(fixture.root, ["stash", "list", "--format=%gd:%gs"]);
    const inventory = captureInventory(fixture.root);
    const after = git(fixture.root, ["stash", "list", "--format=%gd:%gs"]);
    expect(inventory.stashes).toHaveLength(1);
    expect(inventory.stashes[0]?.subject).toContain("existing fixture stash");
    expect(after).toBe(before);
  });

  test("resolves index object IDs exactly as a per-path rev-parse would", () => {
    const fixture = repository();
    const { root } = fixture;
    for (const path of [
      "tracked.txt",
      "deleted-staged.txt",
      "deleted-unstaged.txt",
      "renamed-from.txt",
      "conflict.txt",
      "foo",
      "with space é.txt",
      "foo..",
      "tilde~1",
      "caret^",
      "reflog@{u}",
    ]) {
      writeFixture(root, path, `${path}\n`);
    }
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "Tracked fixtures"]);
    git(root, ["switch", "-c", "other"]);
    writeFixture(root, "conflict.txt", "other side\n");
    git(root, ["commit", "-am", "Other side"]);
    git(root, ["switch", "main"]);
    writeFixture(root, "conflict.txt", "main side\n");
    git(root, ["commit", "-am", "Main side"]);
    spawnSync("git", ["-C", root, "merge", "other"]);

    writeFixture(root, "tracked.txt", "unstaged edit\n");
    writeFixture(root, "with space é.txt", "staged edit\n");
    git(root, ["add", "with space é.txt"]);
    git(root, ["rm", "--quiet", "deleted-staged.txt"]);
    unlinkSync(join(root, "deleted-unstaged.txt"));
    git(root, ["mv", "renamed-from.txt", "renamed-to.txt"]);
    writeFixture(root, "untracked.txt", "untracked\n");
    writeFixture(root, "intent.txt", "intent to add\n");
    git(root, ["add", "--intent-to-add", "intent.txt"]);
    const submodule = git(root, ["rev-parse", "HEAD"]);
    const describeName = `v1-2-g${submodule.slice(0, 7)}`;
    writeFixture(root, describeName, "describe-shaped\n");
    git(root, ["add", "--", describeName]);
    const blob = spawnSync(
      "git",
      ["-C", root, "hash-object", "-w", "--stdin"],
      {
        input: "index only\n",
      }
    )
      .stdout.toString()
      .trim();
    // Store the decomposed name byte for byte, as a commit made on Linux
    // would, then let the repository precompose arguments as macOS does, so
    // a pathspec listing and `rev-parse` disagree about that name.
    git(root, [
      "-c",
      "core.precomposeunicode=false",
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},cafe\u0301.txt`,
    ]);
    git(root, ["config", "core.precomposeunicode", "true"]);
    git(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${submodule},vendor/module`,
    ]);

    const paths = [
      "conflict.txt",
      "deleted-staged.txt",
      "deleted-unstaged.txt",
      "intent.txt",
      "missing.txt",
      "renamed-from.txt",
      "renamed-to.txt",
      "tracked.txt",
      "untracked.txt",
      "vendor/module",
      "with space é.txt",
      // `:<stage>:<path>` revision syntax: these name stages of `foo` and
      // `conflict.txt`, which the batched lookup must reproduce.
      "0:foo",
      "1:conflict.txt",
      "2:conflict.txt",
      "3:conflict.txt",
      "1:",
      // Names `rev-parse` may read as range, ancestry, reflog, or `describe`
      // syntax, and both spellings of a name Git may precompose.
      "foo..",
      "tilde~1",
      "caret^",
      "reflog@{u}",
      describeName,
      "cafe\u0301.txt",
      "caf\u00e9.txt",
    ];
    const expected = new Map(
      paths.map((path) => {
        const result = spawnSync("git", [
          "-C",
          root,
          "rev-parse",
          "--verify",
          `:${path}`,
        ]);
        const output = result.stdout.toString().trim();
        return [path, result.status === 0 && output ? output : null];
      })
    );

    expect(indexObjectIds(root, paths)).toEqual(expected);
    // `rev-parse` reads `:foo..` as a range, so only the per-path fallback
    // reproduces its answer; the index entry itself holds a different ID.
    const [, listed] = git(root, ["ls-files", "--stage", "--", "foo.."]).split(
      " "
    );
    expect(listed).toBeDefined();
    expect(expected.get("foo..")).not.toBe(listed);
    expect(expected.get("conflict.txt")).toBeNull();
    expect(expected.get("2:conflict.txt")).not.toBeNull();
    expect(expected.get("vendor/module")).toBe(submodule);
    expect(indexObjectIds(root, [])).toEqual(new Map());
  }, 30_000);

  test("keeps per-path null object IDs when the index cannot be listed", () => {
    const fixture = repository();
    const notARepository = join(fixture.base, "not-a-repository");
    mkdirSync(notARepository);

    expect(indexObjectIds(notARepository, ["a.txt", "b.txt"])).toEqual(
      new Map([
        ["a.txt", null],
        ["b.txt", null],
      ])
    );
  });

  test("keeps each worktree's changes when statuses run concurrently", () => {
    const fixture = repository();
    const linked = ["one", "two", "three", "four"].map((name) => {
      const path = join(fixture.base, `linked-${name}`);
      git(fixture.root, ["worktree", "add", "-b", `work-${name}`, path]);
      writeFixture(path, `src/${name}.ts`, `export const ${name} = 1;\n`);
      return { name, path };
    });
    writeFixture(fixture.root, "src/primary.ts", "export const primary = 1;\n");

    const opening = captureInventory(fixture.root);
    for (const { name, path } of linked) {
      const worktree = opening.worktrees.find((item) => item.path === path);
      expect(worktree?.changes.map((change) => change.path)).toEqual([
        `src/${name}.ts`,
      ]);
    }
    expect(
      opening.worktrees
        .find((item) => item.isPrimary)
        ?.changes.map((change) => change.path)
    ).toEqual(["src/primary.ts"]);

    const [first, ...others] = linked;
    writeFixture(first?.path ?? "", "src/one.ts", "export const one = 2;\n");
    const current = captureInventory(fixture.root);
    const digest = (inventory: typeof opening, path: string) =>
      inventory.worktrees.find((item) => item.path === path)?.changeDigest;
    expect(digest(current, first?.path ?? "")).not.toBe(
      digest(opening, first?.path ?? "")
    );
    for (const { path } of others) {
      expect(digest(current, path)).toBe(digest(opening, path));
    }
  }, 30_000);

  test("locates the same common Git directory a full capture reports", () => {
    const fixture = repository();
    const linked = join(fixture.base, "linked-locate");
    git(fixture.root, ["worktree", "add", "-b", "locate", linked]);
    writeFixture(fixture.root, "nested/file.ts", "export const nested = 1;\n");

    for (const directory of [
      fixture.root,
      join(fixture.root, "nested"),
      linked,
    ]) {
      expect(locateRepository(directory).repository.commonGitDirectory).toBe(
        captureInventory(directory).repository.commonGitDirectory
      );
    }
  });
});
