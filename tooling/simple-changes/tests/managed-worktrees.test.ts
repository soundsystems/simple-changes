import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  createWorktreeParent,
  MANAGED_DIRECTORY_MARKER,
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

const managedFixture = () => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  const common = captureInventory(fixture.root).repository.commonGitDirectory;
  const { repository, root } = managedWorktreeDirectories(fixture.root);
  return {
    base: fixture.base,
    common,
    primary: fixture.root,
    repository,
    root,
  };
};

interface StoredRecord {
  createdAt: string;
  device: string;
  inode: string;
  path: string;
  runId: string;
  token: string;
}

const records = (common: string): StoredRecord[] => {
  const file = managedDirectoryRecordsPath(common);
  return existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8")).directories
    : [];
};

const recordedPaths = (common: string): string[] =>
  records(common).map((record) => record.path);

const marker = (directory: string): string =>
  readFileSync(join(directory, MANAGED_DIRECTORY_MARKER), "utf8").trim();

const created = () => {
  const fixture = managedFixture();
  createWorktreeParent(
    fixture.common,
    fixture.primary,
    fixture.repository,
    RUN_ID
  );
  return fixture;
};

const clean = (fixture: ReturnType<typeof managedFixture>, hooks = {}) =>
  removeEmptyManagedWorktreeDirectories(fixture.common, fixture.primary, hooks);

describe("managed worktree directory creation", () => {
  test("records and marks exactly the levels it makes", () => {
    const fresh = created();
    expect(recordedPaths(fresh.common)).toEqual([fresh.root, fresh.repository]);
    for (const record of records(fresh.common)) {
      const identity = lstatSync(record.path, { bigint: true });
      expect(record).toEqual({
        createdAt: expect.any(String),
        device: identity.dev.toString(),
        inode: identity.ino.toString(),
        path: record.path,
        runId: RUN_ID,
        token: marker(record.path),
      });
    }
    expect(marker(fresh.root)).not.toBe(marker(fresh.repository));

    const reusedRoot = managedFixture();
    mkdirSync(reusedRoot.root);
    createWorktreeParent(
      reusedRoot.common,
      reusedRoot.primary,
      reusedRoot.repository,
      RUN_ID
    );
    expect(recordedPaths(reusedRoot.common)).toEqual([reusedRoot.repository]);
    expect(readdirSync(reusedRoot.root)).toEqual(["repo"]);

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
    expect(readdirSync(reusedBoth.repository)).toEqual([]);

    // A parent outside the managed layout is created but never recorded.
    const other = managedFixture();
    const elsewhere = join(other.base, "elsewhere", "nested");
    createWorktreeParent(other.common, other.primary, elsewhere, RUN_ID);
    expect(existsSync(elsewhere)).toBe(true);
    expect(recordedPaths(other.common)).toEqual([]);
  });

  test("records nothing it makes through a symbolic link", () => {
    const linkedRoot = managedFixture();
    const shared = join(linkedRoot.base, "shared");
    mkdirSync(shared);
    symlinkSync(shared, linkedRoot.root);
    createWorktreeParent(
      linkedRoot.common,
      linkedRoot.primary,
      linkedRoot.repository,
      RUN_ID
    );
    expect(existsSync(join(shared, "repo"))).toBe(true);
    expect(recordedPaths(linkedRoot.common)).toEqual([]);

    const aliased = managedFixture();
    symlinkSync(aliased.base, join(aliased.base, "alias"));
    const primary = join(aliased.base, "alias", "repo");
    const { repository } = managedWorktreeDirectories(primary);
    createWorktreeParent(aliased.common, primary, repository, RUN_ID);
    expect(existsSync(aliased.repository)).toBe(true);
    expect(recordedPaths(aliased.common)).toEqual([]);
  });
});

describe("managed worktree directory removal", () => {
  test("removes recorded directories once only their marker is left", () => {
    const fixture = created();
    writeFileSync(join(fixture.repository, "keep.txt"), "keep\n");
    expect(clean(fixture)).toEqual({ notes: [], removed: [] });
    expect(recordedPaths(fixture.common)).toEqual([
      fixture.root,
      fixture.repository,
    ]);
    expect(existsSync(join(fixture.repository, MANAGED_DIRECTORY_MARKER))).toBe(
      true
    );

    rmSync(join(fixture.repository, "keep.txt"));
    expect(clean(fixture)).toEqual({
      notes: [],
      removed: [fixture.repository, fixture.root],
    });
    expect(existsSync(fixture.root)).toBe(false);
    expect(existsSync(managedDirectoryRecordsPath(fixture.common))).toBe(false);
  });

  test("keeps a directory that reuses the recorded identity but lacks the marker", () => {
    // A directory recreated on a file system that reuses inode numbers has
    // the recorded device and inode but not the marker; removing the marker
    // from the original reproduces exactly what cleanup then sees.
    const missing = created();
    rmSync(join(missing.repository, MANAGED_DIRECTORY_MARKER));
    const missingCleanup = clean(missing);
    expect(missingCleanup.removed).toEqual([]);
    expect(missingCleanup.notes).toEqual([
      expect.stringContaining(
        `Kept ${missing.repository}: ${missing.repository} lacks the marker Simple Changes wrote`
      ),
    ]);
    expect(existsSync(missing.repository)).toBe(true);
    expect(recordedPaths(missing.common)).toEqual([missing.root]);

    const forged = created();
    rmSync(join(forged.repository, MANAGED_DIRECTORY_MARKER));
    writeFileSync(
      join(forged.repository, MANAGED_DIRECTORY_MARKER),
      "00000000-0000-4000-8000-000000000000\n"
    );
    expect(clean(forged).removed).toEqual([]);
    expect(existsSync(forged.repository)).toBe(true);

    const linkedMarker = created();
    rmSync(join(linkedMarker.repository, MANAGED_DIRECTORY_MARKER));
    const token = records(linkedMarker.common).find(
      (record) => record.path === linkedMarker.repository
    )?.token;
    writeFileSync(join(linkedMarker.base, "token.txt"), `${token}\n`);
    symlinkSync(
      join(linkedMarker.base, "token.txt"),
      join(linkedMarker.repository, MANAGED_DIRECTORY_MARKER)
    );
    expect(clean(linkedMarker).removed).toEqual([]);
    expect(existsSync(linkedMarker.repository)).toBe(true);
  });

  test("keeps a directory replaced after it was created", () => {
    const fixture = created();
    renameSync(fixture.repository, join(fixture.base, "original"));
    mkdirSync(fixture.repository);
    const cleanup = clean(fixture);
    expect(cleanup.removed).toEqual([]);
    expect(cleanup.notes).toEqual([
      expect.stringContaining(
        `${fixture.repository} is no longer the directory Simple Changes created there`
      ),
    ]);
    expect(existsSync(fixture.repository)).toBe(true);
    expect(existsSync(join(fixture.base, "original"))).toBe(true);
  });

  test("never removes through a symbolically linked root, even one it created", () => {
    const fixture = created();
    // The recorded root moves aside, keeping its identity, its marker, and
    // its marked repository directory, and a link to it takes its place.
    const moved = join(fixture.base, "moved-root");
    renameSync(fixture.root, moved);
    symlinkSync(moved, fixture.root);

    const cleanup = clean(fixture);

    expect(cleanup.removed).toEqual([]);
    expect(cleanup.notes).toEqual([
      expect.stringContaining(
        `Kept ${fixture.repository}: ${fixture.root} is a symbolic link`
      ),
      expect.stringContaining(
        `Kept ${fixture.root}: ${fixture.root} is a symbolic link`
      ),
    ]);
    expect(existsSync(join(moved, "repo", MANAGED_DIRECTORY_MARKER))).toBe(
      true
    );
    expect(lstatSync(fixture.root).isSymbolicLink()).toBe(true);
    expect(recordedPaths(fixture.common)).toEqual([
      fixture.root,
      fixture.repository,
    ]);
  });

  test("a root swapped for a link after the checks cannot redirect the removal", () => {
    const fixture = created();
    const shared = join(fixture.base, "shared");
    mkdirSync(join(shared, "repo"), { recursive: true });
    const moved = join(fixture.base, "moved-root");
    let swapped = false;

    const cleanup = clean(fixture, {
      beforeRemove: (path: string) => {
        if (path === fixture.repository && !swapped) {
          swapped = true;
          renameSync(fixture.root, moved);
          symlinkSync(shared, fixture.root);
        }
      },
    });

    expect(swapped).toBe(true);
    // The pinned root was the real one, now at `moved`: its own repository
    // directory went, and the folder behind the link stayed.
    expect(existsSync(join(shared, "repo"))).toBe(true);
    expect(existsSync(join(moved, "repo"))).toBe(false);
    expect(cleanup.removed).toEqual([fixture.repository]);
    expect(cleanup.notes).toEqual([
      expect.stringContaining(
        `Kept ${fixture.root}: ${fixture.root} is a symbolic link`
      ),
    ]);
  });

  test("puts the marker back when something arrives before rmdir", () => {
    const fixture = created();
    const cleanup = clean(fixture, {
      beforeRemove: (path: string) => {
        if (path === fixture.repository) {
          writeFileSync(join(fixture.repository, "late.txt"), "late\n");
        }
      },
    });
    expect(cleanup).toEqual({ notes: [], removed: [] });
    expect(readFileSync(join(fixture.repository, "late.txt"), "utf8")).toBe(
      "late\n"
    );
    const token = records(fixture.common).find(
      (record) => record.path === fixture.repository
    )?.token;
    expect(marker(fixture.repository)).toBe(token ?? "");

    rmSync(join(fixture.repository, "late.txt"));
    expect(clean(fixture).removed).toEqual([fixture.repository, fixture.root]);
  });

  test("keeps a recorded directory whose own level became a symbolic link", () => {
    const fixture = created();
    rmSync(fixture.repository, { recursive: true });
    const outside = join(fixture.base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, fixture.repository);

    const cleanup = clean(fixture);

    expect(cleanup.removed).toEqual([]);
    expect(cleanup.notes).toEqual([
      expect.stringContaining(`${fixture.repository} is a symbolic link`),
    ]);
    expect(existsSync(outside)).toBe(true);
    expect(lstatSync(fixture.repository).isSymbolicLink()).toBe(true);
  });

  test("refuses a record whose path runs through a symbolic link", () => {
    const fixture = created();
    symlinkSync(fixture.base, join(fixture.base, "alias"));
    const alias = join(fixture.base, "alias");
    const file = managedDirectoryRecordsPath(fixture.common);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replaceAll(`${fixture.base}/`, `${alias}/`)
    );

    const cleanup = removeEmptyManagedWorktreeDirectories(
      fixture.common,
      join(alias, "repo")
    );

    expect(cleanup.removed).toEqual([]);
    expect(cleanup.notes).toHaveLength(2);
    for (const note of cleanup.notes) {
      expect(note).toContain("resolves through a symbolic link");
    }
    expect(existsSync(fixture.repository)).toBe(true);
  });

  test("drops the record of a directory already gone", () => {
    const fixture = created();
    rmSync(fixture.root, { recursive: true });

    expect(clean(fixture)).toEqual({ notes: [], removed: [] });
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

    const cleanup = clean(fixture);

    expect(cleanup.removed).toEqual([]);
    expect(cleanup.notes).toEqual([expect.stringContaining("is unreadable")]);
    expect(existsSync(fixture.repository)).toBe(true);
  });

  test("restores the working directory it started in", () => {
    const fixture = created();
    const before = process.cwd();
    clean(fixture);
    expect(process.cwd()).toBe(before);
  });
});
