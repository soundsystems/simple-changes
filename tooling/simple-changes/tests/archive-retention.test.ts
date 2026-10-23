import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  finalizeLoop,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  archiveRetentionPolicy,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  DEFAULT_ARCHIVE_TOTAL_BYTES,
  DEFAULT_POLICY,
} from "../../../skills/simple-changes/scripts/lib/policy.ts";
import type { ArchiveRetentionSetting } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  type ArchivePinRef,
  type ArchivePruneRecord,
  type ArchivePruneResult,
  archivePinNamespace,
  copyWorktreeIntoArchive,
  newArchiveId,
  readArchivePruneLog,
  restoringMarkerPath,
  type WorktreeArchiveManifest,
  writeWorktreeArchiveManifest,
} from "../../../skills/simple-changes/scripts/lib/worktree-archive.ts";
import {
  pruneArchivedWorktrees,
  pruneRepository,
  standaloneWorktreeCleanup,
} from "../../../skills/simple-changes/scripts/lib/worktree-maintenance.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(180_000);

const CONTROLLER = "controller-agent";
const APPROVER = "the-user";
const REASON = "Clean up after the finished work.";
const RECEIPT_DIGEST = "a".repeat(64);
const CHANGE_DIGEST = "b".repeat(64);
const REPOSITORY_ID = "c".repeat(64);
const REMOVAL_ID = "lineage-12345678-1234-4234-8234-123456789abc";
const DAY = 86_400_000;
const RETENTION_DAYS_NOTE_PATTERN = /archiveRetention\.days/u;
const DEFAULT_POLICY_SUMMARY_PATTERN =
  /by the current repository policy a new archive expires after 14 day\(s\), and an existing one keeps the expiry its manifest records/u;
const CHANGED_POLICY_SUMMARY_PATTERN =
  /a new archive expires after 3 day\(s\), and an existing one keeps the expiry its manifest records/u;
const MIB = 1024 ** 2;
const decoder = new TextDecoder();
const CLI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const RESTORE_STARTED_PATTERN = /A restore started .* has not finished/u;
const RECHECK_OVERRIDDEN_PATTERN =
  /The re-check failed and the archive was pruned anyway/u;

let repositories: TestRepository[] = [];

// The archives copy folder modes; make every folder removable first.
const makeTreeWritable = (path: string): void => {
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return;
  }
  chmodSync(path, 0o755);
  for (const name of readdirSync(path)) {
    makeTreeWritable(join(path, name));
  }
};

afterEach(() => {
  for (const fixture of repositories) {
    makeTreeWritable(fixture.base);
    fixture.cleanup();
  }
  repositories = [];
});

interface RetentionFixture {
  /** The target commit before the replacement shipped. */
  beforeReplacement: string;
  common: string;
  fixture: TestRepository;
  /** The commit on main every synthetic archive's receipt named. */
  replacement: string;
  root: string;
}

/**
 * A repository whose main carries one replacement commit, optionally with a
 * committed repository policy that sets `archiveRetention`.
 */
const retentionFixture = (
  archiveRetention?: Record<string, unknown>
): RetentionFixture => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  const { root } = fixture;
  if (archiveRetention) {
    writePolicy(root, archiveRetention);
  }
  const beforeReplacement = git(root, ["rev-parse", "HEAD"]);
  writeFixture(root, "shipped.ts", "export const shipped = 1;\n");
  git(root, ["add", "shipped.ts"]);
  git(root, ["commit", "-q", "-m", "Ship the reviewed replacement"]);
  return {
    beforeReplacement,
    common: realpathSync(
      git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ),
    fixture,
    replacement: git(root, ["rev-parse", "HEAD"]),
    root,
  };
};

// Commits a repository policy file with this retention to main.
const writePolicy = (
  root: string,
  archiveRetention: Record<string, unknown>
): void => {
  writeFixture(
    root,
    ".simple-changes.json",
    `${JSON.stringify({ ...DEFAULT_POLICY, archiveRetention }, null, 2)}\n`
  );
  git(root, ["add", ".simple-changes.json"]);
  git(root, ["commit", "-q", "-m", "Set the archive retention"]);
};

interface SyntheticArchive {
  archiveId: string;
  bytes: number;
  directory: string;
  headSha: string;
  manifest: WorktreeArchiveManifest;
  pinRefs: ArchivePinRef[];
}

interface SyntheticOptions {
  /** Bytes of an untracked file written into the checkout before the copy. */
  bytesHint?: number;
  createdAt: Date;
  expiresAt: Date;
}

let syntheticCount = 0;

/**
 * An archive as a reviewed removal leaves it, built without one: a linked
 * checkout with a commit of its own is copied into the archive, pinned under
 * the archive's namespace (its head, and the replacement as a named object),
 * given a manifest with the chosen dates, then removed with its branch.
 */
const syntheticArchive = (
  retention: RetentionFixture,
  options: SyntheticOptions
): SyntheticArchive => {
  syntheticCount += 1;
  const { common, root } = retention;
  const name = `archived-${syntheticCount}`;
  const path = join(retention.fixture.base, name);
  git(root, ["worktree", "add", "-q", "-b", name, path, "main"]);
  writeFixture(path, `${name}.ts`, `export const work = ${syntheticCount};\n`);
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", `Work on ${name}`]);
  if (options.bytesHint !== undefined) {
    writeFixture(path, "payload.bin", "x".repeat(options.bytesHint));
  }
  const headSha = git(path, ["rev-parse", "HEAD"]);
  const privateGitDirectory = realpathSync(
    git(path, ["rev-parse", "--absolute-git-dir"])
  );
  const archiveId = newArchiveId(options.createdAt, RECEIPT_DIGEST);
  const copy = copyWorktreeIntoArchive({
    archiveId,
    checkoutPath: path,
    commonGitDirectory: common,
    privateGitDirectory,
  });
  const namespace = archivePinNamespace(archiveId);
  const pinRefs: ArchivePinRef[] = [
    { object: headSha, ref: `${namespace}/head` },
    {
      object: retention.replacement,
      ref: `${namespace}/objects/${retention.replacement}`,
    },
  ];
  for (const pin of pinRefs) {
    git(root, ["update-ref", "--no-deref", pin.ref, pin.object]);
  }
  const manifest: WorktreeArchiveManifest = {
    archiveId,
    branchConfig: [],
    checkout: copy.checkout,
    commonGitDirectory: common,
    createdAt: options.createdAt.toISOString(),
    expiresAt: options.expiresAt.toISOString(),
    gitDirectory: copy.gitDirectory,
    kind: "worktree-archive",
    pinRefs,
    privateGitDirectory,
    receiptDigest: RECEIPT_DIGEST,
    removalId: REMOVAL_ID,
    replacementCommits: [retention.replacement],
    repositoryId: REPOSITORY_ID,
    retention: { days: 14, maxTotalBytes: DEFAULT_ARCHIVE_TOTAL_BYTES },
    schemaVersion: 1,
    source: { branch: name, changeDigest: CHANGE_DIGEST, headSha, path },
    targetRef: "main",
  };
  writeWorktreeArchiveManifest(copy.directory, manifest);
  git(root, ["worktree", "remove", "--force", path]);
  git(root, ["branch", "-q", "-D", name]);
  return {
    archiveId,
    bytes: copy.checkout.bytes + copy.gitDirectory.bytes,
    directory: copy.directory,
    headSha,
    manifest,
    pinRefs,
  };
};

const daysFromNow = (days: number): Date => new Date(Date.now() + days * DAY);

const expired = (retention: RetentionFixture): SyntheticArchive =>
  syntheticArchive(retention, {
    createdAt: daysFromNow(-20),
    expiresAt: daysFromNow(-6),
  });

const refExists = (root: string, ref: string): boolean =>
  spawnSync(["git", "-C", root, "rev-parse", "--verify", "--quiet", ref], {
    stderr: "pipe",
    stdout: "pipe",
  }).exitCode === 0;

const expectArchiveKept = (
  retention: RetentionFixture,
  archive: SyntheticArchive
): void => {
  expect(existsSync(archive.directory)).toBe(true);
  for (const pin of archive.pinRefs) {
    expect(git(retention.root, ["rev-parse", pin.ref])).toBe(pin.object);
  }
};

const expectArchiveGone = (
  retention: RetentionFixture,
  archive: SyntheticArchive
): void => {
  expect(existsSync(archive.directory)).toBe(false);
  for (const pin of archive.pinRefs) {
    expect(refExists(retention.root, pin.ref)).toBe(false);
  }
};

// The one prune record a run wrote for this archive.
const expectRecorded = (
  retention: RetentionFixture,
  archive: SyntheticArchive,
  expected: Pick<
    ArchivePruneRecord,
    "approvedBy" | "cause" | "command" | "reason"
  >
): void => {
  const log = readArchivePruneLog(retention.common);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    ...expected,
    archiveId: archive.archiveId,
    bytes: archive.bytes,
    createdAt: archive.manifest.createdAt,
    expiresAt: archive.manifest.expiresAt,
    kind: "worktree-archive-prune",
    pinRefsDeleted: archive.pinRefs.map((pin) => pin.ref),
    receiptDigest: RECEIPT_DIGEST,
    source: {
      branch: archive.manifest.source.branch,
      headSha: archive.headSha,
      path: archive.manifest.source.path,
    },
  });
};

// An automatic prune that removed exactly this expired archive.
const expectExpiredPruned = (
  retention: RetentionFixture,
  pruning: ArchivePruneResult | null,
  archive: SyntheticArchive,
  command: ArchivePruneRecord["command"]
): void => {
  expect(pruning?.pruned).toEqual([
    {
      archiveId: archive.archiveId,
      bytes: archive.bytes,
      cause: "expired",
      notes: [],
      pinRefsDeleted: archive.pinRefs.map((pin) => pin.ref),
      pinRefsKept: [],
    },
  ]);
  expect(pruning?.recordPath).not.toBeNull();
  expectArchiveGone(retention, archive);
  expectRecorded(retention, archive, {
    approvedBy: null,
    cause: "expired",
    command,
    reason: null,
  });
};

const finalizeOneLoop = (retention: RetentionFixture) => {
  const lease = startLoop(retention.root, CONTROLLER, "integrate");
  const result = finalizeLoop(
    retention.root,
    lease.runId,
    CONTROLLER,
    "The run is finished."
  );
  expect(result.outcome).not.toBe("relinquished");
  return result;
};

const cleanUp = (retention: RetentionFixture) =>
  standaloneWorktreeCleanup({
    agentId: CONTROLLER,
    approvedBy: APPROVER,
    reason: REASON,
    repositoryPath: retention.root,
  });

const pruneNow = (retention: RetentionFixture, dryRun = false) =>
  pruneRepository({
    approvedBy: APPROVER,
    dryRun,
    reason: REASON,
    repositoryPath: retention.root,
  });

const runCli = (args: string[]): { exitCode: number; stdout: string } => {
  const result = spawnSync([process.execPath, CLI_PATH, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
  };
};

describe("worktree archive retention at natural cleanup points", () => {
  test("loop finalize prunes an expired archive with its pins, records it, and leaves another archive's pins alone", () => {
    const retention = retentionFixture();
    const old = expired(retention);
    const recent = syntheticArchive(retention, {
      createdAt: daysFromNow(-1),
      expiresAt: daysFromNow(13),
    });

    const result = finalizeOneLoop(retention);

    expectExpiredPruned(
      retention,
      result.archivePruning?.result ?? null,
      old,
      "loop-finalize"
    );
    expectArchiveKept(retention, recent);
    expect(result.archivePruning?.result?.totalBytesAfter).toBe(recent.bytes);
  });

  test("worktree cleanup prunes an expired archive with its pins and records it", () => {
    const retention = retentionFixture();
    const old = expired(retention);

    const result = cleanUp(retention);

    expectExpiredPruned(
      retention,
      result.archivePruning,
      old,
      "worktree-cleanup"
    );
  });

  test("prune prunes an expired archive and records it, and its dry run only plans that", () => {
    const retention = retentionFixture();
    const old = expired(retention);

    const planned = pruneNow(retention, true);
    expect(planned.archivePruning?.pruned).toEqual([
      {
        archiveId: old.archiveId,
        bytes: old.bytes,
        cause: "expired",
        notes: [],
        pinRefsDeleted: old.pinRefs.map((pin) => pin.ref),
        pinRefsKept: [],
      },
    ]);
    expect(planned.archivePruning?.recordPath).toBeNull();
    expectArchiveKept(retention, old);
    expect(readArchivePruneLog(retention.common)).toEqual([]);

    const result = pruneNow(retention);

    expectExpiredPruned(retention, result.archivePruning, old, "prune");
  });

  test("an archive that expires tomorrow survives finalize, cleanup and prune", () => {
    const retention = retentionFixture();
    const tomorrow = syntheticArchive(retention, {
      createdAt: daysFromNow(-13),
      expiresAt: daysFromNow(1),
    });

    const results = [
      finalizeOneLoop(retention).archivePruning?.result ?? null,
      cleanUp(retention).archivePruning,
      pruneNow(retention).archivePruning,
    ];

    for (const pruning of results) {
      expect(pruning).toMatchObject({
        keptForAttention: [],
        pruned: [],
        recordPath: null,
        skipped: [],
        totalBytesAfter: tomorrow.bytes,
      });
    }
    expectArchiveKept(retention, tomorrow);
    expect(readArchivePruneLog(retention.common)).toEqual([]);
  });

  test("the size cap prunes the oldest archive first, until the total fits", () => {
    const retention = retentionFixture();
    const archives = [
      { ageDays: 3, bytesHint: 2 * MIB },
      { ageDays: 2, bytesHint: 3 * MIB },
      { ageDays: 1, bytesHint: 4 * MIB },
    ].map(({ ageDays, bytesHint }) =>
      syntheticArchive(retention, {
        bytesHint,
        createdAt: daysFromNow(-ageDays),
        expiresAt: daysFromNow(30),
      })
    );
    const [oldest, middle, newest] = archives;
    if (!(oldest && middle && newest)) {
      throw new Error("Expected three archives");
    }
    const total = oldest.bytes + middle.bytes + newest.bytes;
    const maxTotalBytes = total - 1;
    writePolicy(retention.root, { maxTotalBytes });

    const result = pruneNow(retention);

    expect(
      result.archivePruning?.pruned.map((item) => [item.archiveId, item.cause])
    ).toEqual([[oldest.archiveId, "size-cap"]]);
    expect(result.archivePruning?.totalBytesBefore).toBe(total);
    expect(result.archivePruning?.totalBytesAfter).toBe(total - oldest.bytes);
    expect(result.archivePruning?.totalBytesAfter ?? total).toBeLessThanOrEqual(
      maxTotalBytes
    );
    expectArchiveGone(retention, oldest);
    expectArchiveKept(retention, middle);
    expectArchiveKept(retention, newest);
    expectRecorded(retention, oldest, {
      approvedBy: null,
      cause: "size-cap",
      command: "prune",
      reason: null,
    });
  });

  test("an expired archive whose replacement the target reverted is kept for attention", () => {
    const retention = retentionFixture();
    const old = expired(retention);
    git(retention.root, ["revert", "--no-edit", retention.replacement]);

    const result = pruneNow(retention);

    expect(result.archivePruning?.pruned).toEqual([]);
    expect(result.archivePruning?.keptForAttention).toHaveLength(1);
    const [kept] = result.archivePruning?.keptForAttention ?? [];
    expect(kept?.archiveId).toBe(old.archiveId);
    expect(kept?.reason ?? "").toContain(
      `reverts replacement ${retention.replacement}`
    );
    expect(kept?.restoreCommand).toBe(
      `simple-changes worktree restore-archive --archive ${old.archiveId}`
    );
    expectArchiveKept(retention, old);
    expect(readArchivePruneLog(retention.common)).toEqual([]);
  });

  test("an expired archive whose target was rewritten without its replacement is kept for attention", () => {
    const retention = retentionFixture();
    const old = expired(retention);
    git(retention.root, ["reset", "-q", "--hard", retention.beforeReplacement]);

    const result = pruneNow(retention);

    expect(result.archivePruning?.pruned).toEqual([]);
    const [kept] = result.archivePruning?.keptForAttention ?? [];
    expect(kept?.archiveId).toBe(old.archiveId);
    expect(kept?.reason ?? "").toContain(
      `no longer contains replacement ${retention.replacement}`
    );
    expectArchiveKept(retention, old);
    expect(readArchivePruneLog(retention.common)).toEqual([]);
  });

  test("an expired archive with a restore marker is skipped", () => {
    const retention = retentionFixture();
    const old = expired(retention);
    writeFileSync(
      restoringMarkerPath(old.directory),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
    );

    const result = pruneNow(retention);

    expect(result.archivePruning?.pruned).toEqual([]);
    expect(result.archivePruning?.skipped).toHaveLength(1);
    const [skipped] = result.archivePruning?.skipped ?? [];
    expect(skipped?.archiveId).toBe(old.archiveId);
    expect(skipped?.reason ?? "").toMatch(RESTORE_STARTED_PATTERN);
    expectArchiveKept(retention, old);
    expect(existsSync(restoringMarkerPath(old.directory))).toBe(true);
  });

  test("invalid retention values fall back to the defaults, and cleanup says so and keeps a current archive", () => {
    const invalid = { days: 0, maxTotalBytes: "big" };
    const policy = archiveRetentionPolicy({
      archiveRetention: invalid as unknown as ArchiveRetentionSetting,
    });
    expect(policy).toMatchObject({
      days: DEFAULT_ARCHIVE_RETENTION_DAYS,
      maxTotalBytes: DEFAULT_ARCHIVE_TOTAL_BYTES,
    });
    expect(policy.fallbacks).toHaveLength(2);
    expect(
      archiveRetentionPolicy({
        archiveRetention: { days: -3, maxTotalBytes: MIB + 0.5 },
      })
    ).toMatchObject({
      days: DEFAULT_ARCHIVE_RETENTION_DAYS,
      fallbacks: [expect.any(String), expect.any(String)],
      maxTotalBytes: DEFAULT_ARCHIVE_TOTAL_BYTES,
    });
    const retention = retentionFixture(invalid);
    const current = syntheticArchive(retention, {
      createdAt: daysFromNow(-4),
      expiresAt: daysFromNow(10),
    });

    const result = cleanUp(retention);

    for (const fallback of policy.fallbacks) {
      expect(result.notes).toContain(`Archive retention: ${fallback}.`);
    }
    expect(result.archivePruning?.pruned).toEqual([]);
    expectArchiveKept(retention, current);
  });

  test("a manual prune by ID removes an archive kept for attention and records the approver and reason", () => {
    const retention = retentionFixture();
    const old = expired(retention);
    git(retention.root, ["revert", "--no-edit", retention.replacement]);
    expect(
      pruneNow(retention).archivePruning?.keptForAttention.map(
        (item) => item.archiveId
      )
    ).toEqual([old.archiveId]);

    const result = pruneArchivedWorktrees({
      approvedBy: APPROVER,
      archiveId: old.archiveId,
      dryRun: false,
      reason: "The reverted work is not wanted back.",
      repositoryPath: retention.root,
    });

    expect(result.pruned).toHaveLength(1);
    const [pruned] = result.pruned;
    expect(pruned).toMatchObject({
      archiveId: old.archiveId,
      cause: "manual",
      pinRefsDeleted: old.pinRefs.map((pin) => pin.ref),
    });
    expect(pruned?.notes.join("\n") ?? "").toMatch(RECHECK_OVERRIDDEN_PATTERN);
    expectArchiveGone(retention, old);
    expectRecorded(retention, old, {
      approvedBy: APPROVER,
      cause: "manual",
      command: "prune-archives",
      reason: "The reverted work is not wanted back.",
    });
  });

  test("a manual prune by age removes an archive that has not expired", () => {
    const retention = retentionFixture();
    const current = syntheticArchive(retention, {
      createdAt: daysFromNow(-2),
      expiresAt: daysFromNow(12),
    });

    const result = pruneArchivedWorktrees({
      approvedBy: APPROVER,
      dryRun: false,
      olderThanDays: 0,
      reason: "Free the space now.",
      repositoryPath: retention.root,
    });

    expect(result.pruned.map((item) => [item.archiveId, item.cause])).toEqual([
      [current.archiveId, "manual"],
    ]);
    expectArchiveGone(retention, current);
    expectRecorded(retention, current, {
      approvedBy: APPROVER,
      cause: "manual",
      command: "prune-archives",
      reason: "Free the space now.",
    });
  });

  test("the worktree archives command lists an archive with its expiry and prune-archives prunes it by ID", () => {
    const retention = retentionFixture();
    const current = syntheticArchive(retention, {
      createdAt: daysFromNow(-2),
      expiresAt: daysFromNow(12),
    });

    const listed = runCli([
      "worktree",
      "archives",
      "--json",
      "--repo",
      retention.root,
    ]);
    expect(listed.exitCode).toBe(0);
    const archives = JSON.parse(listed.stdout) as Array<{
      archiveId: string;
      error: string | null;
      manifest: { expiresAt: string } | null;
      restoring: unknown;
    }>;
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({
      archiveId: current.archiveId,
      error: null,
      manifest: { expiresAt: current.manifest.expiresAt },
      restoring: null,
    });

    // The summary names the current policy for new archives; an existing
    // archive keeps the expiry its manifest records, whatever the policy
    // says now.
    const dryRun = (): string =>
      runCli([
        "worktree",
        "prune-archives",
        "--older-than",
        "30",
        "--approved-by",
        "u",
        "--reason",
        "r",
        "--dry-run",
        "--repo",
        retention.root,
      ]).stdout;
    expect(dryRun()).toMatch(DEFAULT_POLICY_SUMMARY_PATTERN);
    writePolicy(retention.root, { days: 3 });
    expect(dryRun()).toMatch(CHANGED_POLICY_SUMMARY_PATTERN);
    const relisted = JSON.parse(
      runCli(["worktree", "archives", "--json", "--repo", retention.root])
        .stdout
    ) as Array<{ manifest: { expiresAt: string } | null }>;
    expect(relisted[0]?.manifest?.expiresAt).toBe(current.manifest.expiresAt);

    const pruned = runCli([
      "worktree",
      "prune-archives",
      "--archive",
      current.archiveId,
      "--approved-by",
      "u",
      "--reason",
      "r",
      "--json",
      "--repo",
      retention.root,
    ]);
    expect(pruned.exitCode).toBe(0);
    const result = JSON.parse(pruned.stdout) as ArchivePruneResult;
    expect(result.pruned.map((item) => [item.archiveId, item.cause])).toEqual([
      [current.archiveId, "manual"],
    ]);
    expectArchiveGone(retention, current);
    expectRecorded(retention, current, {
      approvedBy: "u",
      cause: "manual",
      command: "prune-archives",
      reason: "r",
    });
  });

  test("an invalid retention value leaves the finalization receipt as persisted", () => {
    const retention = retentionFixture({ days: 0 });
    const result = finalizeOneLoop(retention);
    expect(result.archivePruning?.notes.join(" ")).toMatch(
      RETENTION_DAYS_NOTE_PATTERN
    );
    const persisted = JSON.parse(readFileSync(result.receiptPath, "utf8")) as {
      receipt: unknown;
    };
    expect(JSON.stringify(persisted.receipt)).toBe(
      JSON.stringify(result.receipt)
    );
  });
});
