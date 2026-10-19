import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  emptyManagedWorktreeFolderNotes,
  managedWorktreeDirectories,
} from "../../../skills/simple-changes/scripts/lib/managed-worktrees.ts";
import { createTestRepository, type TestRepository } from "./helpers.ts";

let fixtures: TestRepository[] = [];

afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures = [];
});

const managedFixture = () => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  return {
    base: fixture.base,
    primary: fixture.root,
    ...managedWorktreeDirectories(fixture.root),
  };
};

describe("empty managed worktree folder notes", () => {
  test("names the empty folders, deepest first, and removes nothing", () => {
    const both = managedFixture();
    mkdirSync(both.repository, { recursive: true });
    expect(emptyManagedWorktreeFolderNotes(both.primary)).toEqual([
      `Kept the empty managed worktree folders ${both.repository} and ${both.root}: Simple Changes never removes a worktree's parent folder.`,
    ]);
    expect(existsSync(both.repository)).toBe(true);

    const shared = managedFixture();
    mkdirSync(shared.repository, { recursive: true });
    mkdirSync(join(shared.root, "other-repository"));
    expect(emptyManagedWorktreeFolderNotes(shared.primary)).toEqual([
      `Kept the empty managed worktree folder ${shared.repository}: Simple Changes never removes a worktree's parent folder.`,
    ]);

    const rootOnly = managedFixture();
    mkdirSync(rootOnly.root);
    expect(emptyManagedWorktreeFolderNotes(rootOnly.primary)).toEqual([
      `Kept the empty managed worktree folder ${rootOnly.root}: Simple Changes never removes a worktree's parent folder.`,
    ]);
  });

  test("suggests no command, even for a path a shell would split", () => {
    const fixture = createTestRepository();
    fixtures.push(fixture);
    const spaced = join(fixture.base, "it's a $(dir)");
    mkdirSync(spaced);
    const primary = join(spaced, "repo");
    const { repository } = managedWorktreeDirectories(primary);
    mkdirSync(repository, { recursive: true });
    const notes = emptyManagedWorktreeFolderNotes(primary);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(repository);
    expect(notes[0]).not.toContain("rmdir");
  });

  test("says nothing about folders that hold anything or do not exist", () => {
    const missing = managedFixture();
    expect(emptyManagedWorktreeFolderNotes(missing.primary)).toEqual([]);

    const holding = managedFixture();
    mkdirSync(holding.repository, { recursive: true });
    writeFileSync(join(holding.repository, "notes.txt"), "keep\n");
    expect(emptyManagedWorktreeFolderNotes(holding.primary)).toEqual([]);
  });

  test("never names a folder reached through a symbolic link", () => {
    const linkedRoot = managedFixture();
    const shared = join(linkedRoot.base, "shared");
    mkdirSync(join(shared, "repo"), { recursive: true });
    symlinkSync(shared, linkedRoot.root);
    expect(emptyManagedWorktreeFolderNotes(linkedRoot.primary)).toEqual([]);

    const linkedRepository = managedFixture();
    const outside = join(linkedRepository.base, "outside");
    mkdirSync(outside);
    mkdirSync(linkedRepository.root);
    symlinkSync(outside, linkedRepository.repository);
    expect(emptyManagedWorktreeFolderNotes(linkedRepository.primary)).toEqual(
      []
    );

    const aliased = managedFixture();
    mkdirSync(aliased.repository, { recursive: true });
    symlinkSync(aliased.base, join(aliased.base, "alias"));
    expect(
      emptyManagedWorktreeFolderNotes(join(aliased.base, "alias", "repo"))
    ).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "reports a managed folder it cannot inspect instead of throwing",
    () => {
      const fixture = managedFixture();
      mkdirSync(fixture.repository, { recursive: true });
      chmodSync(fixture.root, 0o000);
      let notes: string[];
      try {
        notes = emptyManagedWorktreeFolderNotes(fixture.primary);
      } finally {
        chmodSync(fixture.root, 0o755);
      }
      expect(notes).toEqual([
        expect.stringContaining(
          `Could not inspect the managed worktree folders under ${fixture.root}:`
        ),
      ]);
      expect(existsSync(fixture.repository)).toBe(true);
    }
  );
});
