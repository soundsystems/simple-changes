import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "bun";
import { SimpleChangesError } from "../../../skills/simple-changes/scripts/lib/errors.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import {
  ARCHIVE_FREE_SPACE_MARGIN_BYTES,
  ARCHIVE_ID_PATTERN,
  type ArchiveBranchConfig,
  type ArchivePinRef,
  type ArchivePruneInput,
  type ArchivePruneRecord,
  type ArchiveTree,
  archivePinNamespace,
  archivePruneLogPath,
  assertArchiveCapacity,
  compareLiveWithManifest,
  compareTrees,
  copyTree,
  copyWorktreeIntoArchive,
  extractWorktreeArchive,
  listWorktreeArchives,
  measureTree,
  newArchiveId,
  OBJECT_SCAN_LIMIT,
  objectIdCandidates,
  pruneWorktreeArchives,
  readArchivePruneLog,
  readRestoringMarker,
  readWorktreeArchiveManifest,
  restoreWorktreeArchive,
  restoringMarkerPath,
  scanTree,
  verifyWorktreeArchive,
  type WorktreeArchiveManifest,
  worktreeArchiveDirectory,
  worktreeArchivesRoot,
  writeWorktreeArchiveManifest,
} from "../../../skills/simple-changes/scripts/lib/worktree-archive.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(180_000);

const RECEIPT_DIGEST = "a".repeat(64);
const CHANGE_DIGEST = "b".repeat(64);
const REPOSITORY_ID = "c".repeat(64);
const REMOVAL_ID = "lineage-12345678-1234-4234-8234-123456789abc";
const DAY = 86_400_000;
const NOW = new Date("2026-10-22T12:00:00.000Z");
const LARGE_CAP = 1_000_000_000;
const APPROVER = "the-user";

const NAMED_PIPE_PATTERN = /is a named pipe \(FIFO\)/u;
const SYMBOLIC_LINK_PATTERN = /is a symbolic link/u;
const ALREADY_EXISTS_PATTERN = /something already exists/u;
const OVER_CAP_PATTERN = /would hold 10 bytes, more than the 5-byte limit/u;
const FREE_SPACE_PATTERN = /bytes free, and the archive needs/u;
const UNKNOWN_KEY_PATTERN =
  /Invalid worktree-archive: \/surprise contains additional properties/u;
const PATH_EXISTS_PATTERN = /already exists, so archive .* cannot be restored/u;
const PRIVATE_EXISTS_PATTERN =
  /Git's folder for this checkout, .* already exists/u;
const BRANCH_MOVED_PATTERN = /Branch feature now points at [0-9a-f]{40}/u;
const PARENT_MISSING_PATTERN = /that held the checkout no longer exists/u;
const INCOMPLETE_PATTERN = /The restore of archive .* is incomplete/u;
const NOT_EMPTY_PATTERN = /is not empty\. Nothing was copied/u;
const REVERTED_PATTERN = /main reverts replacement [0-9a-f]{40} in commit/u;
const LOST_PATTERN = /main no longer contains replacement [0-9a-f]{40}/u;
const RESTORING_PATTERN = /A restore started .* has not finished/u;
const UNPARSABLE_PATTERN = /Its state does not parse/u;
const RECHECK_FAILED_PATTERN =
  /The re-check failed and the archive was pruned/u;
const MOVED_PIN_PATTERN = /now points at [0-9a-f]{40}, not the pinned/u;
const LOCKED_PIN_PATTERN =
  /Its pins could not all be deleted \(refs\/simple-changes\/archives\/[^)]+\/head\): .*could not be deleted: .*lock.*The archive stays whole/u;
const OVERSIZED_COPY_PATTERN =
  /The copied private Git directory holds FETCH_HEAD \([0-9]+ bytes\), larger than the [0-9]+ bytes the object scan reads.*The partial archive was removed/u;
const STAYS_WHOLE_PATTERN =
  /The archive stays whole so the next prune retries it/u;
const OUTSIDE_NAMESPACE_PATTERN = /is outside the archive's namespace/u;
const SYMBOLIC_PIN_PATTERN = /is now a symbolic ref to refs\/heads\/main/u;
const UNLISTED_PINS_PATTERN =
  /deleted at the values they held, because the manifest that lists them did not parse/u;
const LOG_NOT_LIST_PATTERN = /not an append-only record list/u;
const NO_ARCHIVE_PATTERN = /There is no archive/u;

let repositories: TestRepository[] = [];
let folders: string[] = [];

// Read-only folders made by the tests would stop their own cleanup.
const makeWritable = (path: string): void => {
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return;
  }
  chmodSync(path, 0o755);
  for (const name of readdirSync(path)) {
    makeWritable(join(path, name));
  }
};

afterEach(() => {
  for (const fixture of repositories) {
    makeWritable(fixture.base);
    fixture.cleanup();
  }
  for (const folder of folders) {
    makeWritable(folder);
    rmSync(folder, { force: true, recursive: true });
  }
  repositories = [];
  folders = [];
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const temporaryFolder = (): string => {
  const folder = realpathSync(
    mkdtempSync(join(tmpdir(), "simple-changes-archive-test-"))
  );
  folders.push(folder);
  return folder;
};

// Unlike `writeFixture`, creates the parent folder even when the path has
// no folder part, for roots that do not exist yet.
const writeTreeFile = (
  root: string,
  relativePath: string,
  contents: string
): void => {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

const digestOf = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const makeFifo = (path: string): void => {
  const result = spawnSync(["mkfifo", path]);
  if (result.exitCode !== 0) {
    throw new Error(`mkfifo ${path} failed`);
  }
};

const expectRefusal = (
  action: () => unknown,
  pattern: RegExp
): SimpleChangesError => {
  let caught: unknown = null;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SimpleChangesError);
  const refusal = caught as SimpleChangesError;
  expect(refusal.message).toMatch(pattern);
  return refusal;
};

const commonDirectoryOf = (root: string): string =>
  realpathSync(
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  );

const refsUnder = (root: string, prefix: string): string[] => {
  const output = git(root, ["for-each-ref", "--format=%(refname)", prefix]);
  return output === "" ? [] : output.split("\n");
};

const branchCommit = (root: string, branch: string): string | null => {
  const result = spawnSync(
    [
      "git",
      "-C",
      root,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  return result.exitCode === 0
    ? new TextDecoder().decode(result.stdout).trim()
    : null;
};

const listedWorktreePaths = (root: string): string[] =>
  git(root, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

const archiveFolders = (common: string): string[] =>
  existsSync(worktreeArchivesRoot(common))
    ? readdirSync(worktreeArchivesRoot(common)).filter((name) =>
        ARCHIVE_ID_PATTERN.test(name)
      )
    : [];

interface LinkedCheckout {
  branch: string;
  common: string;
  fixture: TestRepository;
  headSha: string;
  path: string;
  privateGitDirectory: string;
}

/** A linked checkout with one commit of its own, under `parent`. */
const linkedCheckout = (
  fixture: TestRepository,
  name: string,
  parent: string
): LinkedCheckout => {
  mkdirSync(parent, { recursive: true });
  const path = join(parent, name);
  git(fixture.root, ["worktree", "add", "-b", name, path]);
  writeFixture(path, `${name}.txt`, `work on ${name}\n`);
  writeFixture(path, "nested/deeper/notes.md", "# Notes\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", `Add ${name}`]);
  return {
    branch: name,
    common: commonDirectoryOf(fixture.root),
    fixture,
    headSha: git(path, ["rev-parse", "HEAD"]),
    path,
    privateGitDirectory: realpathSync(
      git(path, ["rev-parse", "--absolute-git-dir"])
    ),
  };
};

interface ManifestInput {
  archiveId: string;
  branch: string | null;
  branchConfig: ArchiveBranchConfig[];
  checkout: ArchiveTree;
  common: string;
  createdAt: Date;
  expiresAt: Date;
  gitDirectory: ArchiveTree;
  headSha: string;
  path: string;
  pinRefs: ArchivePinRef[];
  privateGitDirectory: string;
  replacementCommits: string[];
}

const manifestFor = (input: ManifestInput): WorktreeArchiveManifest => ({
  archiveId: input.archiveId,
  branchConfig: input.branchConfig,
  checkout: input.checkout,
  commonGitDirectory: input.common,
  createdAt: input.createdAt.toISOString(),
  expiresAt: input.expiresAt.toISOString(),
  gitDirectory: input.gitDirectory,
  kind: "worktree-archive",
  pinRefs: input.pinRefs,
  privateGitDirectory: input.privateGitDirectory,
  receiptDigest: RECEIPT_DIGEST,
  removalId: REMOVAL_ID,
  replacementCommits: input.replacementCommits,
  repositoryId: REPOSITORY_ID,
  retention: { days: 14, maxTotalBytes: 2 * 1024 ** 3 },
  schemaVersion: 1,
  source: {
    branch: input.branch,
    changeDigest: CHANGE_DIGEST,
    headSha: input.headSha,
    path: input.path,
  },
  targetRef: "main",
});

interface ArchivedCheckout {
  archiveId: string;
  directory: string;
  manifest: WorktreeArchiveManifest;
  objectIdCandidates: string[];
}

/** Archives a live linked checkout and writes its manifest, as removal does. */
const archiveCheckout = (
  checkout: LinkedCheckout,
  branchConfig: ArchiveBranchConfig[] = []
): ArchivedCheckout => {
  const replacement = git(checkout.fixture.root, ["rev-parse", "main"]);
  const archiveId = newArchiveId(new Date(), RECEIPT_DIGEST);
  const copy = copyWorktreeIntoArchive({
    archiveId,
    checkoutPath: checkout.path,
    commonGitDirectory: checkout.common,
    privateGitDirectory: checkout.privateGitDirectory,
  });
  const manifest = manifestFor({
    archiveId,
    branch: checkout.branch,
    branchConfig,
    checkout: copy.checkout,
    common: checkout.common,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 14 * DAY),
    gitDirectory: copy.gitDirectory,
    headSha: checkout.headSha,
    path: checkout.path,
    pinRefs: [],
    privateGitDirectory: checkout.privateGitDirectory,
    replacementCommits: [replacement],
  });
  writeWorktreeArchiveManifest(copy.directory, manifest);
  return {
    archiveId,
    directory: copy.directory,
    manifest,
    objectIdCandidates: copy.objectIdCandidates,
  };
};

const restore = (checkout: LinkedCheckout, archiveId: string) =>
  restoreWorktreeArchive({
    archiveId,
    commonGitDirectory: checkout.common,
    primaryCheckout: checkout.fixture.root,
  });

describe("tree scan, copy and comparison", () => {
  const buildTree = (root: string): void => {
    writeFixture(root, "a/b/c.txt", "nested\n");
    mkdirSync(join(root, "empty"));
    writeFixture(root, "run.sh", "#!/bin/sh\necho hi\n");
    chmodSync(join(root, "run.sh"), 0o755);
    writeFixture(root, "ro/inside.txt", "inside\n");
    chmodSync(join(root, "ro"), 0o555);
    symlinkSync("a/b/c.txt", join(root, "link-to-file"));
    symlinkSync("missing-target", join(root, "dangling"));
  };

  test("copies files, folders, modes and links exactly and compares by path", () => {
    const base = temporaryFolder();
    const source = join(base, "source");
    buildTree(source);
    const scanned = scanTree(source);

    expect(scanned.entries.map((entry) => entry.path)).toEqual([
      "a",
      "a/b",
      "a/b/c.txt",
      "dangling",
      "empty",
      "link-to-file",
      "ro",
      "ro/inside.txt",
      "run.sh",
    ]);
    const byPath = new Map(scanned.entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("a/b/c.txt")).toEqual({
      linkTarget: null,
      // biome-ignore lint/suspicious/noBitwiseOperators: permission bits are a bit mask.
      mode: statSync(join(source, "a/b/c.txt")).mode & 0o7777,
      path: "a/b/c.txt",
      sha256: digestOf("nested\n"),
      size: 7,
      type: "file",
    });
    expect(byPath.get("run.sh")?.mode).toBe(0o755);
    expect(byPath.get("ro")).toMatchObject({ mode: 0o555, type: "directory" });
    expect(byPath.get("empty")).toMatchObject({
      sha256: null,
      type: "directory",
    });
    expect(byPath.get("link-to-file")).toEqual({
      linkTarget: "a/b/c.txt",
      mode: 0,
      path: "link-to-file",
      sha256: null,
      size: 0,
      type: "symlink",
    });
    expect(byPath.get("dangling")?.linkTarget).toBe("missing-target");
    expect(scanned.bytes).toBe(7 + 7 + "#!/bin/sh\necho hi\n".length);
    expect(scanned.count).toBe(9);
    expect(measureTree(source)).toEqual({
      bytes: scanned.bytes,
      count: scanned.count,
    });

    const copy = join(base, "copy");
    expect(copyTree(source, copy)).toEqual(scanned);
    expect(scanTree(copy)).toEqual(scanned);
    expect(compareTrees(scanned, scanTree(copy))).toEqual([]);
    expect(lstatSync(join(copy, "dangling")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(copy, "dangling"))).toBe("missing-target");
    expect(statSync(join(copy, "ro")).mode % 0o1000).toBe(0o555);
    // The source is never modified.
    expect(scanTree(source)).toEqual(scanned);
  });

  test("names each changed path once: a byte, a mode, a link target, an extra file", () => {
    const base = temporaryFolder();
    const source = join(base, "source");
    buildTree(source);
    const scanned = scanTree(source);
    const changedCopy = (name: string, change: (root: string) => void) => {
      const root = join(base, name);
      copyTree(source, root);
      change(root);
      return compareTrees(scanned, scanTree(root));
    };

    const byte = changedCopy("byte", (root) =>
      writeFileSync(join(root, "a/b/c.txt"), "nestex\n")
    );
    expect(byte).toHaveLength(1);
    expect(byte[0]).toContain("a/b/c.txt");
    expect(byte[0]).toContain("contents differ");

    const mode = changedCopy("mode", (root) =>
      chmodSync(join(root, "run.sh"), 0o644)
    );
    expect(mode).toHaveLength(1);
    expect(mode[0]).toContain("run.sh: mode 0755 is now 0644");

    const link = changedCopy("link", (root) => {
      unlinkSync(join(root, "link-to-file"));
      symlinkSync("empty", join(root, "link-to-file"));
    });
    expect(link).toHaveLength(1);
    expect(link[0]).toContain("link-to-file: link target");

    const extra = changedCopy("extra", (root) =>
      writeFileSync(join(root, "extra.txt"), "x")
    );
    expect(extra).toEqual(["extra.txt: an extra file that was not recorded"]);
  });

  test("refuses a named pipe and a root that is a symbolic link, writing nothing", () => {
    const base = temporaryFolder();
    const withPipe = join(base, "with-pipe");
    writeTreeFile(withPipe, "first.txt", "1\n");
    writeFixture(withPipe, "inner/second.txt", "2\n");
    makeFifo(join(withPipe, "inner/pipe"));

    const scanRefusal = expectRefusal(
      () => scanTree(withPipe),
      NAMED_PIPE_PATTERN
    );
    expect(scanRefusal.message).toContain(join(withPipe, "inner/pipe"));
    const destination = join(base, "pipe-copy");
    const copyRefusal = expectRefusal(
      () => copyTree(withPipe, destination),
      NAMED_PIPE_PATTERN
    );
    expect(copyRefusal.message).toContain(join(withPipe, "inner/pipe"));
    expect(existsSync(destination)).toBe(false);

    const source = join(base, "source");
    buildTree(source);
    const linkedRoot = join(base, "linked-root");
    symlinkSync(source, linkedRoot);
    expectRefusal(() => scanTree(linkedRoot), SYMBOLIC_LINK_PATTERN);
    expectRefusal(() => measureTree(linkedRoot), SYMBOLIC_LINK_PATTERN);
    const linkCopy = join(base, "link-copy");
    expectRefusal(() => copyTree(linkedRoot, linkCopy), SYMBOLIC_LINK_PATTERN);
    expect(existsSync(linkCopy)).toBe(false);

    const occupied = join(base, "occupied");
    writeTreeFile(occupied, "keep.txt", "keep\n");
    expectRefusal(() => copyTree(source, occupied), ALREADY_EXISTS_PATTERN);
    expect(readdirSync(occupied)).toEqual(["keep.txt"]);
  });
});

describe("archiving a linked checkout", () => {
  test("finds object IDs in state files but not in the index, reflogs or large files", () => {
    const root = temporaryFolder();
    const autostash = "1".repeat(40);
    const origHead = "2".repeat(40);
    const rebaseAutostash = "3".repeat(64);
    const inIndex = "4".repeat(40);
    const inReflog = "5".repeat(40);
    const inLargeFile = "6".repeat(40);
    writeFixture(root, "MERGE_AUTOSTASH", `${autostash}\n`);
    writeFixture(root, "ORIG_HEAD", `${origHead}\n`);
    writeFixture(root, "rebase-merge/autostash", `${rebaseAutostash}\n`);
    writeFixture(root, "index", `DIRC${inIndex}`);
    writeFixture(root, "logs/HEAD", `${inReflog} ${origHead} x\n`);
    writeFixture(root, "large", `${"x".repeat(1024 ** 2)}${inLargeFile}\n`);
    writeFixture(root, "not-an-id", `${"7".repeat(41)} ${"8".repeat(39)}\n`);

    expect(objectIdCandidates(root)).toEqual([
      autostash,
      origHead,
      rebaseAutostash,
    ]);
  });

  test("copies the checkout and its private Git directory and verifies the copy", () => {
    const fixture = repository();
    const checkout = linkedCheckout(
      fixture,
      "feature",
      join(fixture.base, "parent")
    );
    const initial = git(fixture.root, ["rev-parse", "main"]);
    const reflogOnly = "5".repeat(40);
    writeFileSync(
      join(checkout.privateGitDirectory, "ORIG_HEAD"),
      `${checkout.headSha}\n`
    );
    writeFileSync(
      join(checkout.privateGitDirectory, "MERGE_AUTOSTASH"),
      `${initial}\n`
    );
    mkdirSync(join(checkout.privateGitDirectory, "logs"), { recursive: true });
    appendFileSync(
      join(checkout.privateGitDirectory, "logs", "HEAD"),
      `${reflogOnly}\n`
    );
    const liveCheckout = scanTree(checkout.path);
    const liveGit = scanTree(checkout.privateGitDirectory);
    const archiveId = newArchiveId(new Date(), RECEIPT_DIGEST);

    const copy = copyWorktreeIntoArchive({
      archiveId,
      checkoutPath: checkout.path,
      commonGitDirectory: checkout.common,
      privateGitDirectory: checkout.privateGitDirectory,
    });

    expect(copy.directory).toBe(
      worktreeArchiveDirectory(checkout.common, archiveId)
    );
    expect(statSync(copy.directory).mode % 0o1000).toBe(0o700);
    expect(copy.checkout).toEqual(liveCheckout);
    expect(copy.gitDirectory).toEqual(liveGit);
    expect(copy.checkout.entries.map((entry) => entry.path)).toContain(".git");
    expect(copy.gitDirectory.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["HEAD", "MERGE_AUTOSTASH", "ORIG_HEAD", "gitdir"])
    );
    expect(copy.objectIdCandidates).toContain(checkout.headSha);
    expect(copy.objectIdCandidates).toContain(initial);
    expect(copy.objectIdCandidates).not.toContain(reflogOnly);
    expect(compareTrees(liveCheckout, scanTree(checkout.path))).toEqual([]);
    expect(
      compareTrees(liveGit, scanTree(checkout.privateGitDirectory))
    ).toEqual([]);
  });

  test("removes the whole archive when the copy fails part way", () => {
    const fixture = repository();
    const checkout = linkedCheckout(
      fixture,
      "feature",
      join(fixture.base, "parent")
    );
    makeFifo(join(checkout.path, "nested", "pipe"));
    const archiveId = newArchiveId(new Date(), RECEIPT_DIGEST);

    const refusal = expectRefusal(
      () =>
        copyWorktreeIntoArchive({
          archiveId,
          checkoutPath: checkout.path,
          commonGitDirectory: checkout.common,
          privateGitDirectory: checkout.privateGitDirectory,
        }),
      NAMED_PIPE_PATTERN
    );

    expect(refusal.message).toContain(join(checkout.path, "nested", "pipe"));
    expect(
      existsSync(worktreeArchiveDirectory(checkout.common, archiveId))
    ).toBe(false);
    expect(archiveFolders(checkout.common)).toEqual([]);
    expect(lstatSync(join(checkout.path, "nested", "pipe")).isFIFO()).toBe(
      true
    );
  });

  test("refuses a copy whose Git tree holds a state file too large to scan, and discards it", () => {
    const fixture = repository();
    const checkout = linkedCheckout(
      fixture,
      "feature",
      join(fixture.base, "parent")
    );
    const fetchHead = join(checkout.privateGitDirectory, "FETCH_HEAD");
    const line = `${checkout.headSha}\t\tbranch 'main' of ${fixture.root}\n`;
    writeFileSync(
      fetchHead,
      line.repeat(Math.ceil((OBJECT_SCAN_LIMIT + 1) / line.length))
    );
    const input = {
      archiveId: newArchiveId(new Date(), RECEIPT_DIGEST),
      checkoutPath: checkout.path,
      commonGitDirectory: checkout.common,
      privateGitDirectory: checkout.privateGitDirectory,
    };

    expectRefusal(() => copyWorktreeIntoArchive(input), OVERSIZED_COPY_PATTERN);

    expect(
      existsSync(join(worktreeArchivesRoot(checkout.common), input.archiveId))
    ).toBe(false);
    // Control: under the limit the file is scanned, and the commit it names
    // is an object candidate.
    writeFileSync(fetchHead, line);
    const copy = copyWorktreeIntoArchive(input);
    expect(copy.objectIdCandidates).toContain(checkout.headSha);
  });

  test("refuses an archive over the cap or without the free space, naming the numbers", () => {
    const base = temporaryFolder();
    const root = join(base, "not-yet", "archives");

    expectRefusal(
      () => assertArchiveCapacity({ bytes: 10, maxArchiveBytes: 5, root }),
      OVER_CAP_PATTERN
    );
    const huge = 2 ** 52;
    const refusal = expectRefusal(
      () =>
        assertArchiveCapacity({
          bytes: huge,
          maxArchiveBytes: Number.MAX_SAFE_INTEGER,
          root,
        }),
      FREE_SPACE_PATTERN
    );
    expect(refusal.message).toContain(String(huge));
    expect(refusal.message).toContain(String(ARCHIVE_FREE_SPACE_MARGIN_BYTES));
    expect(() =>
      assertArchiveCapacity({ bytes: 1024, maxArchiveBytes: 4096, root })
    ).not.toThrow();
    expect(existsSync(join(base, "not-yet"))).toBe(false);
  });
});

describe("manifests", () => {
  test("round-trips, verifies, reports an edited file and refuses an unknown key", () => {
    const fixture = repository();
    const checkout = linkedCheckout(
      fixture,
      "feature",
      join(fixture.base, "parent")
    );
    const archived = archiveCheckout(checkout);
    const manifestPath = join(archived.directory, "manifest.json");
    const written = readFileSync(manifestPath, "utf8");

    expect(readWorktreeArchiveManifest(archived.directory)).toEqual(
      archived.manifest
    );
    expect(
      verifyWorktreeArchive(archived.directory, archived.manifest)
    ).toEqual([]);

    expectRefusal(
      () =>
        writeWorktreeArchiveManifest(archived.directory, {
          ...archived.manifest,
          surprise: true,
        } as WorktreeArchiveManifest),
      UNKNOWN_KEY_PATTERN
    );
    expect(readFileSync(manifestPath, "utf8")).toBe(written);
    expect(readdirSync(archived.directory).sort()).toEqual([
      "checkout",
      "git",
      "manifest.json",
    ]);

    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...archived.manifest, surprise: true }, null, 2)}\n`
    );
    expectRefusal(
      () => readWorktreeArchiveManifest(archived.directory),
      UNKNOWN_KEY_PATTERN
    );
    writeFileSync(manifestPath, written);

    writeFileSync(
      join(archived.directory, "checkout", "feature.txt"),
      "edited in the archive\n"
    );
    const differences = verifyWorktreeArchive(
      archived.directory,
      archived.manifest
    );
    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain("checkout/feature.txt");
  });

  test("compares the live checkout with the manifest", () => {
    const fixture = repository();
    const checkout = linkedCheckout(
      fixture,
      "feature",
      join(fixture.base, "parent")
    );
    const archived = archiveCheckout(checkout);

    expect(compareLiveWithManifest(archived.manifest)).toEqual([]);

    writeFileSync(join(checkout.path, "feature.txt"), "touched after\n");
    const differences = compareLiveWithManifest(archived.manifest);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toContain(join(checkout.path, "feature.txt"));
  });
});

describe("restore and extract", () => {
  test("restores a removed checkout byte for byte on its recreated branch", () => {
    const fixture = repository();
    const checkout = linkedCheckout(
      fixture,
      "feature",
      join(fixture.base, "parent")
    );
    const archived = archiveCheckout(checkout);
    git(fixture.root, ["worktree", "remove", checkout.path]);
    git(fixture.root, ["branch", "-D", "feature"]);
    expect(existsSync(checkout.privateGitDirectory)).toBe(false);

    const result = restore(checkout, archived.archiveId);

    expect(result).toEqual({
      archiveId: archived.archiveId,
      branch: "feature",
      branchCreated: true,
      headSha: checkout.headSha,
      path: checkout.path,
      privateGitDirectory: checkout.privateGitDirectory,
    });
    expect(
      compareTrees(archived.manifest.checkout, scanTree(checkout.path))
    ).toEqual([]);
    expect(
      compareTrees(
        archived.manifest.gitDirectory,
        scanTree(checkout.privateGitDirectory)
      )
    ).toEqual([]);
    expect(git(fixture.root, ["worktree", "list", "--porcelain"])).toContain(
      `worktree ${checkout.path}\nHEAD ${checkout.headSha}\nbranch refs/heads/feature`
    );
    expect(
      git(checkout.path, ["--no-optional-locks", "status", "--porcelain"])
    ).toBe("");
    expect(readRestoringMarker(archived.directory)).toBeNull();
    expect(
      verifyWorktreeArchive(archived.directory, archived.manifest)
    ).toEqual([]);
  });

  test("refuses an existing path, an existing private directory, a moved branch and a missing parent", () => {
    const fixture = repository();
    const parent = join(fixture.base, "parent");
    const checkout = linkedCheckout(fixture, "feature", parent);
    const archived = archiveCheckout(checkout);
    git(fixture.root, ["worktree", "remove", checkout.path]);
    const untouched = (): void => {
      expect(readRestoringMarker(archived.directory)).toBeNull();
      expect(
        verifyWorktreeArchive(archived.directory, archived.manifest)
      ).toEqual([]);
      expect(listedWorktreePaths(fixture.root)).not.toContain(checkout.path);
    };

    mkdirSync(checkout.path);
    expectRefusal(
      () => restore(checkout, archived.archiveId),
      PATH_EXISTS_PATTERN
    );
    expect(readdirSync(checkout.path)).toEqual([]);
    expect(existsSync(checkout.privateGitDirectory)).toBe(false);
    expect(branchCommit(fixture.root, "feature")).toBe(checkout.headSha);
    untouched();
    rmSync(checkout.path, { recursive: true });

    mkdirSync(checkout.privateGitDirectory, { recursive: true });
    expectRefusal(
      () => restore(checkout, archived.archiveId),
      PRIVATE_EXISTS_PATTERN
    );
    expect(readdirSync(checkout.privateGitDirectory)).toEqual([]);
    expect(existsSync(checkout.path)).toBe(false);
    untouched();
    rmSync(checkout.privateGitDirectory, { recursive: true });

    const initial = git(fixture.root, ["rev-parse", "main"]);
    git(fixture.root, ["branch", "-f", "feature", initial]);
    expectRefusal(
      () => restore(checkout, archived.archiveId),
      BRANCH_MOVED_PATTERN
    );
    expect(branchCommit(fixture.root, "feature")).toBe(initial);
    expect(existsSync(checkout.path)).toBe(false);
    expect(existsSync(checkout.privateGitDirectory)).toBe(false);
    untouched();
    git(fixture.root, ["branch", "-f", "feature", checkout.headSha]);

    rmSync(parent, { recursive: true });
    expectRefusal(
      () => restore(checkout, archived.archiveId),
      PARENT_MISSING_PATTERN
    );
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(checkout.privateGitDirectory)).toBe(false);
    untouched();
  });

  test("keeps the marker and what was copied when the restore stops part way", () => {
    const fixture = repository();
    const parent = join(fixture.base, "parent");
    const checkout = linkedCheckout(fixture, "feature", parent);
    const archived = archiveCheckout(checkout);
    git(fixture.root, ["worktree", "remove", checkout.path]);

    chmodSync(parent, 0o555);
    try {
      const refusal = expectRefusal(
        () => restore(checkout, archived.archiveId),
        INCOMPLETE_PATTERN
      );
      expect(refusal.message).toContain(checkout.path);
      expect(refusal.message).toContain(checkout.privateGitDirectory);
    } finally {
      chmodSync(parent, 0o755);
    }

    const marker = readRestoringMarker(archived.directory);
    expect(marker?.pid).toBe(process.pid);
    expect(existsSync(restoringMarkerPath(archived.directory))).toBe(true);
    expect(existsSync(checkout.path)).toBe(false);
    expect(existsSync(checkout.privateGitDirectory)).toBe(true);
    expect(
      verifyWorktreeArchive(archived.directory, archived.manifest)
    ).toEqual([]);
  });

  test("recreates the branch description when the section is gone, and leaves an existing section alone", () => {
    const fixture = repository();
    const parent = join(fixture.base, "parent");
    const described = linkedCheckout(fixture, "described", parent);
    git(fixture.root, [
      "config",
      "branch.described.description",
      "Notes for the described branch",
    ]);
    const describedArchive = archiveCheckout(described, [
      {
        key: "branch.described.description",
        value: "Notes for the described branch",
      },
    ]);
    git(fixture.root, ["worktree", "remove", described.path]);
    git(fixture.root, ["branch", "-D", "described"]);
    expect(
      spawnSync([
        "git",
        "-C",
        fixture.root,
        "config",
        "--get",
        "branch.described.description",
      ]).exitCode
    ).toBe(1);

    expect(restore(described, describedArchive.archiveId).branchCreated).toBe(
      true
    );
    expect(
      git(fixture.root, ["config", "--get", "branch.described.description"])
    ).toBe("Notes for the described branch");

    const edited = linkedCheckout(fixture, "edited", parent);
    git(fixture.root, ["config", "branch.edited.description", "Original"]);
    const editedArchive = archiveCheckout(edited, [
      { key: "branch.edited.description", value: "Original" },
    ]);
    git(fixture.root, ["worktree", "remove", edited.path]);
    git(fixture.root, ["update-ref", "-d", "refs/heads/edited"]);
    git(fixture.root, ["config", "branch.edited.description", "Edited since"]);

    expect(restore(edited, editedArchive.archiveId).branchCreated).toBe(true);
    expect(
      git(fixture.root, ["config", "--get-all", "branch.edited.description"])
    ).toBe("Edited since");
  });

  test("extracts into an empty or absent folder and refuses a non-empty one", () => {
    const fixture = repository();
    const checkout = linkedCheckout(
      fixture,
      "feature",
      join(fixture.base, "parent")
    );
    const archived = archiveCheckout(checkout);
    const manifestText = readFileSync(
      join(archived.directory, "manifest.json"),
      "utf8"
    );
    const expectedBytes =
      Buffer.byteLength(manifestText) +
      archived.manifest.checkout.bytes +
      archived.manifest.gitDirectory.bytes;
    const extract = (destination: string) =>
      extractWorktreeArchive({
        archiveId: archived.archiveId,
        commonGitDirectory: checkout.common,
        destination,
      });
    const expectExtracted = (destination: string): void => {
      expect(readdirSync(destination).sort()).toEqual([
        "checkout",
        "git",
        "manifest.json",
      ]);
      expect(readFileSync(join(destination, "manifest.json"), "utf8")).toBe(
        manifestText
      );
      expect(
        compareTrees(
          archived.manifest.checkout,
          scanTree(join(destination, "checkout"))
        )
      ).toEqual([]);
      expect(
        compareTrees(
          archived.manifest.gitDirectory,
          scanTree(join(destination, "git"))
        )
      ).toEqual([]);
    };

    const empty = join(fixture.base, "extract-empty");
    mkdirSync(empty);
    expect(extract(empty)).toEqual({
      bytes: expectedBytes,
      destination: empty,
    });
    expectExtracted(empty);

    const absent = join(fixture.base, "extract-new", "nested");
    expect(extract(absent)).toEqual({
      bytes: expectedBytes,
      destination: absent,
    });
    expectExtracted(absent);

    const occupied = join(fixture.base, "extract-occupied");
    writeTreeFile(occupied, "keep.txt", "keep\n");
    expectRefusal(() => extract(occupied), NOT_EMPTY_PATTERN);
    expect(readdirSync(occupied)).toEqual(["keep.txt"]);
    expect(readRestoringMarker(archived.directory)).toBeNull();
    expect(listedWorktreePaths(fixture.root)).toContain(checkout.path);
  });
});

interface SyntheticArchive {
  archiveId: string;
  directory: string;
  manifest: WorktreeArchiveManifest;
}

interface SyntheticOptions {
  createdAt: Date;
  expiresAt: Date;
  payloadBytes: number;
  pins?: "head" | "head-and-object";
  replacement: string;
}

let syntheticCount = 0;

/** A small archive with a manifest written directly, plus its pins in Git. */
const syntheticArchive = (
  fixture: TestRepository,
  options: SyntheticOptions
): SyntheticArchive => {
  syntheticCount += 1;
  const common = commonDirectoryOf(fixture.root);
  const archiveId = newArchiveId(options.createdAt, RECEIPT_DIGEST);
  const name = `gone-${syntheticCount}`;
  const source = join(fixture.base, "sources", name);
  const gitSource = join(fixture.base, "sources", `${name}-git`);
  writeTreeFile(source, "payload.bin", "x".repeat(options.payloadBytes));
  writeTreeFile(gitSource, "HEAD", `ref: refs/heads/${name}\n`);
  const directory = worktreeArchiveDirectory(common, archiveId);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const checkout = copyTree(source, join(directory, "checkout"));
  const gitDirectory = copyTree(gitSource, join(directory, "git"));
  const namespace = archivePinNamespace(archiveId);
  const pinRefs: ArchivePinRef[] = [];
  if (options.pins) {
    pinRefs.push({ object: options.replacement, ref: `${namespace}/head` });
  }
  if (options.pins === "head-and-object") {
    pinRefs.push({
      object: options.replacement,
      ref: `${namespace}/objects/${options.replacement}`,
    });
  }
  for (const pin of pinRefs) {
    git(fixture.root, ["update-ref", pin.ref, pin.object]);
  }
  const manifest = manifestFor({
    archiveId,
    branch: name,
    branchConfig: [],
    checkout,
    common,
    createdAt: options.createdAt,
    expiresAt: options.expiresAt,
    gitDirectory,
    headSha: options.replacement,
    path: join(fixture.base, name),
    pinRefs,
    privateGitDirectory: join(common, "worktrees", name),
    replacementCommits: [options.replacement],
  });
  writeWorktreeArchiveManifest(directory, manifest);
  return { archiveId, directory, manifest };
};

const archiveBytes = (archive: SyntheticArchive): number =>
  archive.manifest.checkout.bytes + archive.manifest.gitDirectory.bytes;

const prune = (
  fixture: TestRepository,
  overrides: Partial<ArchivePruneInput> = {}
) =>
  pruneWorktreeArchives({
    command: "prune",
    commonGitDirectory: commonDirectoryOf(fixture.root),
    dryRun: false,
    now: NOW,
    primaryCheckout: fixture.root,
    retention: { days: 14, maxTotalBytes: LARGE_CAP },
    ...overrides,
  });

const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

describe("pruning", () => {
  test("prunes expired archives with their pins and records each one", () => {
    const fixture = repository();
    const common = commonDirectoryOf(fixture.root);
    const replacement = git(fixture.root, ["rev-parse", "main"]);
    const expired = syntheticArchive(fixture, {
      createdAt: ago(20),
      expiresAt: ago(6),
      payloadBytes: 100,
      pins: "head-and-object",
      replacement,
    });
    const current = syntheticArchive(fixture, {
      createdAt: ago(10),
      expiresAt: ago(-4),
      payloadBytes: 200,
      pins: "head",
      replacement,
    });
    const recent = syntheticArchive(fixture, {
      createdAt: ago(1),
      expiresAt: ago(-13),
      payloadBytes: 300,
      pins: "head",
      replacement,
    });
    const before =
      archiveBytes(expired) + archiveBytes(current) + archiveBytes(recent);

    const result = prune(fixture);

    expect(result.pruned).toEqual([
      {
        archiveId: expired.archiveId,
        bytes: archiveBytes(expired),
        cause: "expired",
        notes: [],
        pinRefsDeleted: expired.manifest.pinRefs.map((pin) => pin.ref),
      },
    ]);
    expect(result.keptForAttention).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.totalBytesBefore).toBe(before);
    expect(result.totalBytesAfter).toBe(before - archiveBytes(expired));
    expect(result.recordPath).toBe(archivePruneLogPath(common));
    expect(existsSync(expired.directory)).toBe(false);
    expect(existsSync(current.directory)).toBe(true);
    expect(existsSync(recent.directory)).toBe(true);
    expect(refsUnder(fixture.root, "refs/simple-changes/archives/")).toEqual(
      [current, recent].map(
        (archive) => `${archivePinNamespace(archive.archiveId)}/head`
      )
    );
    const log = readArchivePruneLog(common);
    expect(log).toEqual([
      {
        approvedBy: null,
        archiveId: expired.archiveId,
        bytes: archiveBytes(expired),
        cause: "expired",
        command: "prune",
        createdAt: expired.manifest.createdAt,
        expiresAt: expired.manifest.expiresAt,
        kind: "worktree-archive-prune",
        pinRefsDeleted: expired.manifest.pinRefs.map((pin) => pin.ref),
        prunedAt: NOW.toISOString(),
        reason: null,
        receiptDigest: RECEIPT_DIGEST,
        schemaVersion: 1,
        source: {
          branch: expired.manifest.source.branch,
          headSha: replacement,
          path: expired.manifest.source.path,
        },
      },
    ]);
    expect(() =>
      validateSchema<ArchivePruneRecord>("worktree-archive-prune", log[0])
    ).not.toThrow();
  });

  test("prunes oldest first while the archives are over the size cap", () => {
    const fixture = repository();
    const replacement = git(fixture.root, ["rev-parse", "main"]);
    const archives = [20, 10, 1].map((days) =>
      syntheticArchive(fixture, {
        createdAt: ago(days),
        expiresAt: ago(-30),
        payloadBytes: 100 * (days + 1),
        pins: "head",
        replacement,
      })
    );
    const [oldest, middle, newest] = archives;
    if (!(oldest && middle && newest)) {
      throw new Error("Expected three archives");
    }

    const result = prune(fixture, {
      retention: { days: 14, maxTotalBytes: archiveBytes(newest) },
    });

    expect(result.pruned.map((item) => [item.archiveId, item.cause])).toEqual([
      [oldest.archiveId, "size-cap"],
      [middle.archiveId, "size-cap"],
    ]);
    expect(result.totalBytesAfter).toBe(archiveBytes(newest));
    expect(existsSync(newest.directory)).toBe(true);
    expect(readArchivePruneLog(commonDirectoryOf(fixture.root))).toHaveLength(
      2
    );
  });

  // Two unexpired archives whose sum is over a 1 MiB cap; pruning the oldest
  // alone brings the total under it.
  const twoUnexpiredOverCap = () => {
    const fixture = repository();
    const replacement = git(fixture.root, ["rev-parse", "main"]);
    const unexpired = {
      expiresAt: ago(-30),
      payloadBytes: 600 * 1024,
      pins: "head" as const,
      replacement,
    };
    const oldest = syntheticArchive(fixture, {
      ...unexpired,
      createdAt: ago(5),
    });
    const newer = syntheticArchive(fixture, {
      ...unexpired,
      createdAt: ago(2),
    });
    return {
      fixture,
      newer,
      oldest,
      retention: { days: 14, maxTotalBytes: 1024 * 1024 },
    };
  };

  // The healthy control: the oldest alone brings the total under the cap,
  // and the newer archive stays.
  const expectOldestAlonePruned = (): void => {
    const healthy = twoUnexpiredOverCap();
    const control = prune(healthy.fixture, { retention: healthy.retention });
    expect(control.pruned.map((item) => [item.archiveId, item.cause])).toEqual([
      [healthy.oldest.archiveId, "size-cap"],
    ]);
    expect(control.keptForAttention).toEqual([]);
    expect(control.totalBytesAfter).toBe(archiveBytes(healthy.newer));
    expect(existsSync(healthy.newer.directory)).toBe(true);
  };

  test("advances past an archive whose pin deletion fails when tried under the size cap", () => {
    const stalled = twoUnexpiredOverCap();
    const common = commonDirectoryOf(stalled.fixture.root);
    const pin = `${archivePinNamespace(stalled.oldest.archiveId)}/head`;
    // A stale lock file, as an interrupted Git leaves behind: the pin reads
    // fine, so the plan finds it deletable, and only the deletion fails.
    writeFileSync(join(common, `${pin}.lock`), "");

    const result = prune(stalled.fixture, { retention: stalled.retention });

    expect(result.pruned.map((item) => [item.archiveId, item.cause])).toEqual([
      [stalled.newer.archiveId, "size-cap"],
    ]);
    expect(result.keptForAttention.map((item) => item.archiveId)).toEqual([
      stalled.oldest.archiveId,
    ]);
    expect(result.keptForAttention[0]?.reason).toMatch(LOCKED_PIN_PATTERN);
    expect(result.totalBytesAfter).toBe(archiveBytes(stalled.oldest));
    expect(existsSync(join(stalled.oldest.directory, "manifest.json"))).toBe(
      true
    );
    expect(existsSync(stalled.newer.directory)).toBe(false);
    expect(git(stalled.fixture.root, ["rev-parse", pin])).toBe(
      stalled.oldest.manifest.pinRefs[0]?.object ?? ""
    );
    expect(readArchivePruneLog(common)).toHaveLength(1);

    expectOldestAlonePruned();
  });

  test("selects the next-oldest when a kept archive frees nothing under the size cap", () => {
    const blocked = twoUnexpiredOverCap();
    writeFixture(blocked.fixture.root, "other.txt", "other\n");
    git(blocked.fixture.root, ["add", "."]);
    git(blocked.fixture.root, ["commit", "-m", "Another commit"]);
    const other = git(blocked.fixture.root, ["rev-parse", "HEAD"]);
    const movedPin = `${archivePinNamespace(blocked.oldest.archiveId)}/head`;
    git(blocked.fixture.root, ["update-ref", movedPin, other]);

    const planned = prune(blocked.fixture, {
      dryRun: true,
      retention: blocked.retention,
    });
    expect(planned.pruned.map((item) => [item.archiveId, item.cause])).toEqual([
      [blocked.newer.archiveId, "size-cap"],
    ]);
    expect(planned.keptForAttention.map((item) => item.archiveId)).toEqual([
      blocked.oldest.archiveId,
    ]);
    expect(existsSync(blocked.newer.directory)).toBe(true);

    const result = prune(blocked.fixture, { retention: blocked.retention });
    expect(result.pruned.map((item) => [item.archiveId, item.cause])).toEqual([
      [blocked.newer.archiveId, "size-cap"],
    ]);
    expect(result.keptForAttention.map((item) => item.archiveId)).toEqual([
      blocked.oldest.archiveId,
    ]);
    expect(result.keptForAttention[0]?.reason).toMatch(MOVED_PIN_PATTERN);
    expect(result.totalBytesAfter).toBe(archiveBytes(blocked.oldest));
    expect(existsSync(blocked.oldest.directory)).toBe(true);
    expect(existsSync(blocked.newer.directory)).toBe(false);
    expect(git(blocked.fixture.root, ["rev-parse", movedPin])).toBe(other);

    expectOldestAlonePruned();
  });

  test("keeps archives whose target reverted or lost a replacement, until pruned by ID", () => {
    const fixture = repository();
    const common = commonDirectoryOf(fixture.root);
    const initial = git(fixture.root, ["rev-parse", "main"]);
    writeFixture(fixture.root, "reverted.txt", "shipped then reverted\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, [
      "commit",
      "-m",
      "Ship the replacement that is reverted",
    ]);
    const reverted = git(fixture.root, ["rev-parse", "HEAD"]);
    writeFixture(fixture.root, "lost.txt", "shipped then rewound\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Ship the replacement that is lost"]);
    const lost = git(fixture.root, ["rev-parse", "HEAD"]);
    const expired = { createdAt: ago(20), expiresAt: ago(6), payloadBytes: 10 };
    const revertedArchive = syntheticArchive(fixture, {
      ...expired,
      pins: "head",
      replacement: reverted,
    });
    const lostArchive = syntheticArchive(fixture, {
      ...expired,
      pins: "head",
      replacement: lost,
    });
    const control = syntheticArchive(fixture, {
      ...expired,
      replacement: initial,
    });
    git(fixture.root, ["reset", "--hard", "HEAD~1"]);
    git(fixture.root, ["revert", "--no-edit", reverted]);

    const result = prune(fixture);

    expect(result.pruned.map((item) => item.archiveId)).toEqual([
      control.archiveId,
    ]);
    const kept = new Map(
      result.keptForAttention.map((item) => [item.archiveId, item])
    );
    expect(kept.get(revertedArchive.archiveId)?.reason).toMatch(
      REVERTED_PATTERN
    );
    expect(kept.get(revertedArchive.archiveId)?.reason).toContain(reverted);
    expect(kept.get(lostArchive.archiveId)?.reason).toMatch(LOST_PATTERN);
    expect(kept.get(lostArchive.archiveId)?.reason).toContain(lost);
    expect(kept.get(lostArchive.archiveId)?.restoreCommand).toBe(
      `simple-changes worktree restore-archive --archive ${lostArchive.archiveId}`
    );
    expect(existsSync(revertedArchive.directory)).toBe(true);
    expect(existsSync(lostArchive.directory)).toBe(true);
    expect(
      refsUnder(fixture.root, "refs/simple-changes/archives/")
    ).toHaveLength(2);

    const manual = prune(fixture, {
      command: "prune-archives",
      manual: {
        approvedBy: APPROVER,
        archiveId: revertedArchive.archiveId,
        reason: "The revert was deliberate.",
      },
    });

    expect(manual.pruned).toHaveLength(1);
    expect(manual.pruned[0]?.cause).toBe("manual");
    expect(manual.pruned[0]?.notes.join(" ")).toMatch(RECHECK_FAILED_PATTERN);
    expect(manual.pruned[0]?.pinRefsDeleted).toEqual([
      `${archivePinNamespace(revertedArchive.archiveId)}/head`,
    ]);
    expect(existsSync(revertedArchive.directory)).toBe(false);
    expect(existsSync(lostArchive.directory)).toBe(true);
    const log = readArchivePruneLog(common);
    expect(log.map((record) => [record.archiveId, record.cause])).toEqual([
      [control.archiveId, "expired"],
      [revertedArchive.archiveId, "manual"],
    ]);
    expect(log[1]).toMatchObject({
      approvedBy: APPROVER,
      command: "prune-archives",
      reason: "The revert was deliberate.",
    });
  });

  test("skips an archive being restored and one whose manifest does not parse", () => {
    const fixture = repository();
    const common = commonDirectoryOf(fixture.root);
    const replacement = git(fixture.root, ["rev-parse", "main"]);
    const expired = {
      createdAt: ago(20),
      expiresAt: ago(6),
      payloadBytes: 10,
      replacement,
    };
    const restoring = syntheticArchive(fixture, expired);
    writeFileSync(
      restoringMarkerPath(restoring.directory),
      `${JSON.stringify({ pid: 4242, startedAt: ago(1).toISOString() })}\n`
    );
    const unreadable = syntheticArchive(fixture, { ...expired, pins: "head" });
    writeFileSync(join(unreadable.directory, "manifest.json"), "{ not json");

    const listings = new Map(
      listWorktreeArchives(common).map((listing) => [
        listing.archiveId,
        listing,
      ])
    );
    expect(listings.get(restoring.archiveId)?.restoring).toEqual({
      pid: 4242,
      startedAt: ago(1).toISOString(),
    });
    expect(listings.get(unreadable.archiveId)?.manifest).toBeNull();
    expect(listings.get(unreadable.archiveId)?.error).toContain(
      "not valid JSON"
    );

    const result = prune(fixture);

    expect(result.pruned).toEqual([]);
    expect(result.recordPath).toBeNull();
    const skipped = new Map(
      result.skipped.map((item) => [item.archiveId, item.reason])
    );
    expect(skipped.get(restoring.archiveId)).toMatch(RESTORING_PATTERN);
    expect(skipped.get(unreadable.archiveId)).toMatch(UNPARSABLE_PATTERN);
    expect(existsSync(restoring.directory)).toBe(true);
    expect(existsSync(unreadable.directory)).toBe(true);
    expect(existsSync(archivePruneLogPath(common))).toBe(false);

    const manual = prune(fixture, {
      command: "prune-archives",
      manual: {
        approvedBy: APPROVER,
        archiveId: unreadable.archiveId,
        reason: "A damaged archive nobody needs.",
      },
    });

    // Without a manifest there is no recorded value, so the pins in the
    // archive's own namespace are deleted at the values they hold.
    const pin = `${archivePinNamespace(unreadable.archiveId)}/head`;
    expect(manual.pruned).toHaveLength(1);
    expect(manual.pruned[0]?.pinRefsDeleted).toEqual([pin]);
    expect(manual.pruned[0]?.notes.join(" ")).toMatch(UNLISTED_PINS_PATTERN);
    expect(refsUnder(fixture.root, pin)).toEqual([]);
    expect(existsSync(unreadable.directory)).toBe(false);
    expect(readArchivePruneLog(common)).toEqual([
      expect.objectContaining({
        approvedBy: APPROVER,
        archiveId: unreadable.archiveId,
        cause: "manual",
        createdAt: null,
        receiptDigest: null,
        source: null,
      }),
    ]);
  });

  test("a dry run returns the plan and changes nothing", () => {
    const fixture = repository();
    const common = commonDirectoryOf(fixture.root);
    const replacement = git(fixture.root, ["rev-parse", "main"]);
    const expired = syntheticArchive(fixture, {
      createdAt: ago(20),
      expiresAt: ago(6),
      payloadBytes: 10,
      pins: "head",
      replacement,
    });
    const pin = `${archivePinNamespace(expired.archiveId)}/head`;

    const result = prune(fixture, { dryRun: true });

    expect(result.pruned).toEqual([
      {
        archiveId: expired.archiveId,
        bytes: archiveBytes(expired),
        cause: "expired",
        notes: [],
        pinRefsDeleted: [pin],
      },
    ]);
    expect(result.recordPath).toBeNull();
    expect(result.totalBytesAfter).toBe(0);
    expect(existsSync(expired.directory)).toBe(true);
    expect(verifyWorktreeArchive(expired.directory, expired.manifest)).toEqual(
      []
    );
    expect(refsUnder(fixture.root, pin)).toEqual([pin]);
    expect(existsSync(archivePruneLogPath(common))).toBe(false);
  });

  test("keeps an archive whole when a pin moved, became a symbolic ref, or lies outside the namespace", () => {
    const fixture = repository();
    const common = commonDirectoryOf(fixture.root);
    const main = git(fixture.root, ["rev-parse", "main"]);
    writeFixture(fixture.root, "other.txt", "other\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Another commit"]);
    const other = git(fixture.root, ["rev-parse", "HEAD"]);
    const expired = {
      createdAt: ago(20),
      expiresAt: ago(6),
      payloadBytes: 10,
      replacement: main,
    };
    // Two pins: the head pin moves, the object pin stays deletable and must
    // survive with it.
    const moved = syntheticArchive(fixture, {
      ...expired,
      pins: "head-and-object",
    });
    const movedPin = `${archivePinNamespace(moved.archiveId)}/head`;
    git(fixture.root, ["update-ref", movedPin, other]);
    const movedPins = moved.manifest.pinRefs.map((pin) => pin.ref);

    const symbolic = syntheticArchive(fixture, expired);
    const symbolicPin = `${archivePinNamespace(symbolic.archiveId)}/head`;
    git(fixture.root, ["symbolic-ref", symbolicPin, "refs/heads/main"]);
    git(fixture.root, ["branch", "outside-pin", main]);
    const manifest: WorktreeArchiveManifest = {
      ...symbolic.manifest,
      pinRefs: [
        { object: main, ref: "refs/heads/outside-pin" },
        { object: other, ref: symbolicPin },
      ],
    };
    writeWorktreeArchiveManifest(symbolic.directory, manifest);

    const result = prune(fixture);

    expect(result.pruned).toEqual([]);
    expect(result.recordPath).toBeNull();
    const kept = new Map(
      result.keptForAttention.map((item) => [item.archiveId, item.reason])
    );
    expect(kept.get(moved.archiveId)).toMatch(MOVED_PIN_PATTERN);
    expect(kept.get(moved.archiveId)).toMatch(STAYS_WHOLE_PATTERN);
    expect(kept.get(symbolic.archiveId)).toMatch(OUTSIDE_NAMESPACE_PATTERN);
    expect(kept.get(symbolic.archiveId)).toMatch(SYMBOLIC_PIN_PATTERN);
    expect(git(fixture.root, ["rev-parse", movedPin])).toBe(other);
    expect(
      refsUnder(fixture.root, archivePinNamespace(moved.archiveId))
    ).toEqual(movedPins);
    expect(git(fixture.root, ["symbolic-ref", symbolicPin])).toBe(
      "refs/heads/main"
    );
    expect(git(fixture.root, ["rev-parse", "refs/heads/main"])).toBe(other);
    expect(git(fixture.root, ["rev-parse", "refs/heads/outside-pin"])).toBe(
      main
    );
    expect(existsSync(join(moved.directory, "manifest.json"))).toBe(true);
    expect(existsSync(join(symbolic.directory, "manifest.json"))).toBe(true);
    expect(existsSync(archivePruneLogPath(common))).toBe(false);
  });

  test("a manual prune by age uses the given age instead of the expiry", () => {
    const fixture = repository();
    const replacement = git(fixture.root, ["rev-parse", "main"]);
    const older = syntheticArchive(fixture, {
      createdAt: ago(10),
      expiresAt: ago(-30),
      payloadBytes: 10,
      replacement,
    });
    const newer = syntheticArchive(fixture, {
      createdAt: ago(2),
      expiresAt: ago(-30),
      payloadBytes: 10,
      replacement,
    });

    const result = prune(fixture, {
      command: "prune-archives",
      manual: { approvedBy: APPROVER, olderThanDays: 5, reason: "Disk space." },
    });

    expect(result.pruned.map((item) => [item.archiveId, item.cause])).toEqual([
      [older.archiveId, "manual"],
    ]);
    expect(existsSync(newer.directory)).toBe(true);
  });

  test("refuses before touching anything when the prune log is damaged or the ID is unknown", () => {
    const fixture = repository();
    const common = commonDirectoryOf(fixture.root);
    const replacement = git(fixture.root, ["rev-parse", "main"]);
    const expired = syntheticArchive(fixture, {
      createdAt: ago(20),
      expiresAt: ago(6),
      payloadBytes: 10,
      pins: "head",
      replacement,
    });
    const pin = `${archivePinNamespace(expired.archiveId)}/head`;
    writeFileSync(archivePruneLogPath(common), "{}\n");

    expectRefusal(() => prune(fixture), LOG_NOT_LIST_PATTERN);
    expect(existsSync(expired.directory)).toBe(true);
    expect(refsUnder(fixture.root, pin)).toEqual([pin]);
    expect(readFileSync(archivePruneLogPath(common), "utf8")).toBe("{}\n");

    rmSync(archivePruneLogPath(common));
    expectRefusal(
      () =>
        prune(fixture, {
          command: "prune-archives",
          manual: {
            approvedBy: APPROVER,
            archiveId: newArchiveId(NOW, RECEIPT_DIGEST),
            reason: "Typo in the ID.",
          },
        }),
      NO_ARCHIVE_PATTERN
    );
    expect(existsSync(expired.directory)).toBe(true);
    expect(refsUnder(fixture.root, pin)).toEqual([pin]);
    expect(existsSync(archivePruneLogPath(common))).toBe(false);
  });
});
