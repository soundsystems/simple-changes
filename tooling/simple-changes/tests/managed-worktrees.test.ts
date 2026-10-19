import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  createWorktreeParent,
  managedDirectoryRecordsPath,
  managedWorktreeDirectories,
  removeEmptyManagedWorktreeDirectories,
} from "../../../skills/simple-changes/scripts/lib/managed-worktrees.ts";
import { createTestRepository, type TestRepository } from "./helpers.ts";

const RUN_ID = "run-managed-directories";

let fixtures: TestRepository[] = [];

afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures = [];
});

const managedFixture = (primaryCheckout?: (base: string) => string) => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  const primary = primaryCheckout?.(fixture.base) ?? fixture.root;
  const common = captureInventory(fixture.root).repository.commonGitDirectory;
  const { repository, root } = managedWorktreeDirectories(primary);
  return { base: fixture.base, common, primary, repository, root };
};

const recordedPaths = (common: string): string[] => {
  const file = managedDirectoryRecordsPath(common);
  return existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8")).directories.map(
        (record: { path: string }) => record.path
      )
    : [];
};

describe("managed worktree directory records", () => {
  test("records exactly the levels prepare-agent makes, with their identity", () => {
    const fresh = managedFixture();
    createWorktreeParent(fresh.common, fresh.primary, fresh.repository, RUN_ID);
    expect(recordedPaths(fresh.common)).toEqual([fresh.root, fresh.repository]);
    const [record] = JSON.parse(
      readFileSync(managedDirectoryRecordsPath(fresh.common), "utf8")
    ).directories;
    const identity = lstatSync(fresh.root, { bigint: true });
    expect(record).toEqual({
      createdAt: expect.any(String),
      device: identity.dev.toString(),
      inode: identity.ino.toString(),
      path: fresh.root,
      runId: RUN_ID,
    });

    const reusedRoot = managedFixture();
    mkdirSync(reusedRoot.root);
    createWorktreeParent(
      reusedRoot.common,
      reusedRoot.primary,
      reusedRoot.repository,
      RUN_ID
    );
    expect(recordedPaths(reusedRoot.common)).toEqual([reusedRoot.repository]);

    const reusedBoth = managedFixture();
    mkdirSync(reusedBoth.repository, { recursive: true });
    createWorktreeParent(
      reusedBoth.common,
      reusedBoth.primary,
      reusedBoth.repository,
      RUN_ID
    );
    expect(existsSync(managedDirectoryRecordsPath(reusedBoth.common))).toBe(
      false
    );

    // A parent outside the managed layout is created but never recorded.
    const other = managedFixture();
    const elsewhere = join(other.base, "elsewhere", "nested");
    createWorktreeParent(other.common, other.primary, elsewhere, RUN_ID);
    expect(existsSync(elsewhere)).toBe(true);
    expect(recordedPaths(other.common)).toEqual([]);
  });

  test("removes recorded directories only once empty, innermost first", () => {
    const fixture = managedFixture();
    createWorktreeParent(
      fixture.common,
      fixture.primary,
      fixture.repository,
      RUN_ID
    );
    writeFileSync(join(fixture.repository, "keep.txt"), "keep\n");
    expect(
      removeEmptyManagedWorktreeDirectories(fixture.common, fixture.primary)
    ).toEqual({ notes: [], removed: [] });
    expect(recordedPaths(fixture.common)).toEqual([
      fixture.root,
      fixture.repository,
    ]);

    rmSync(join(fixture.repository, "keep.txt"));
    expect(
      removeEmptyManagedWorktreeDirectories(fixture.common, fixture.primary)
    ).toEqual({ notes: [], removed: [fixture.repository, fixture.root] });
    expect(existsSync(fixture.root)).toBe(false);
    expect(existsSync(managedDirectoryRecordsPath(fixture.common))).toBe(false);
  });

  test("never removes through a symbolically linked root, even one it created", () => {
    const fixture = managedFixture();
    createWorktreeParent(
      fixture.common,
      fixture.primary,
      fixture.repository,
      RUN_ID
    );
    // The recorded root moves aside, keeping its identity and its empty
    // repository directory, and a link to it takes its place.
    const moved = join(fixture.base, "moved-root");
    renameSync(fixture.root, moved);
    symlinkSync(moved, fixture.root);

    const cleanup = removeEmptyManagedWorktreeDirectories(
      fixture.common,
      fixture.primary
    );

    expect(cleanup.removed).toEqual([]);
    expect(cleanup.notes).toEqual([
      expect.stringContaining(
        `Kept ${fixture.repository}: ${fixture.root} is a symbolic link`
      ),
      expect.stringContaining(
        `Kept ${fixture.root}: ${fixture.root} is a symbolic link`
      ),
    ]);
    expect(existsSync(join(moved, "repo"))).toBe(true);
    expect(lstatSync(fixture.root).isSymbolicLink()).toBe(true);
    expect(recordedPaths(fixture.common)).toEqual([
      fixture.root,
      fixture.repository,
    ]);
  });

  test("keeps a recorded directory whose own level became a symbolic link", () => {
    const fixture = managedFixture();
    createWorktreeParent(
      fixture.common,
      fixture.primary,
      fixture.repository,
      RUN_ID
    );
    rmdirSync(fixture.repository);
    const outside = join(fixture.base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, fixture.repository);

    const cleanup = removeEmptyManagedWorktreeDirectories(
      fixture.common,
      fixture.primary
    );

    expect(cleanup.removed).toEqual([]);
    expect(cleanup.notes).toEqual([
      expect.stringContaining(`${fixture.repository} is a symbolic link`),
    ]);
    expect(existsSync(outside)).toBe(true);
    expect(lstatSync(fixture.repository).isSymbolicLink()).toBe(true);
  });

  test("refuses when the primary's parent resolves through a symbolic link", () => {
    const fixture = managedFixture((base) => {
      symlinkSync(base, join(base, "alias"));
      return join(base, "alias", "repo");
    });
    createWorktreeParent(
      fixture.common,
      fixture.primary,
      fixture.repository,
      RUN_ID
    );

    const cleanup = removeEmptyManagedWorktreeDirectories(
      fixture.common,
      fixture.primary
    );

    expect(cleanup.removed).toEqual([]);
    expect(cleanup.notes).toHaveLength(2);
    for (const note of cleanup.notes) {
      expect(note).toContain("resolves through a symbolic link");
    }
    expect(existsSync(fixture.repository)).toBe(true);
  });

  test("drops the record of a directory already gone", () => {
    const fixture = managedFixture();
    createWorktreeParent(
      fixture.common,
      fixture.primary,
      fixture.repository,
      RUN_ID
    );
    rmdirSync(fixture.repository);
    rmdirSync(fixture.root);

    expect(
      removeEmptyManagedWorktreeDirectories(fixture.common, fixture.primary)
    ).toEqual({ notes: [], removed: [] });
    expect(existsSync(managedDirectoryRecordsPath(fixture.common))).toBe(false);
  });

  test("leaves unreadable records alone and removes nothing", () => {
    const fixture = managedFixture();
    const file = managedDirectoryRecordsPath(fixture.common);
    mkdirSync(join(fixture.common, "simple-changes"), { recursive: true });
    writeFileSync(file, '{"schemaVersion":2,"directories":[]}\n');
    createWorktreeParent(
      fixture.common,
      fixture.primary,
      fixture.repository,
      RUN_ID
    );
    expect(readFileSync(file, "utf8")).toBe(
      '{"schemaVersion":2,"directories":[]}\n'
    );

    const cleanup = removeEmptyManagedWorktreeDirectories(
      fixture.common,
      fixture.primary
    );

    expect(cleanup.removed).toEqual([]);
    expect(cleanup.notes).toEqual([expect.stringContaining("is unreadable")]);
    expect(existsSync(fixture.repository)).toBe(true);
  });
});
