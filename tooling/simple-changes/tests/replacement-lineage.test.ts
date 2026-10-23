import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { SimpleChangesError } from "../../../skills/simple-changes/scripts/lib/errors.ts";
import {
  captureInventory,
  parseWorktreeList,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import { startLoop } from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import {
  GIT_ENVIRONMENT_REDIRECTS,
  type ReplacementLineageOutcome,
  type ReplacementLineageReceipt,
  replacementLineageDirectory,
} from "../../../skills/simple-changes/scripts/lib/replacement-lineage.ts";
import {
  applyReplayRecord,
  emptyReviewLedger,
  reviewLedgerPath,
} from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import {
  ARCHIVE_ID_PATTERN,
  type ArchivePinRef,
  compareTrees,
  listWorktreeArchives,
  readArchivePruneLog,
  readWorktreeArchiveManifest,
  restoringMarkerPath,
  scanTree,
  worktreeArchivesRoot,
} from "../../../skills/simple-changes/scripts/lib/worktree-archive.ts";
import {
  claimWorktree,
  releaseWorktreeClaim,
  takeoverWorktreeClaim,
  worktreeTakeoversPath,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  pruneRepository,
  readWorktreeCleanups,
  restoreArchivedWorktree,
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
const AUTHOR = "author-agent";
const REVIEWER = "reviewer-agent";
const APPROVER = "the-user";
const MINUTE = 60_000;
const decoder = new TextDecoder();
const CLI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const PIN_REF_PATTERN =
  /^refs\/simple-changes\/archives\/archive-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}-[0-9a-f]{8}\/head$/u;
const AGENT_REQUIRED_PATTERN =
  /agent ID \(with a lineage receipt\) is required/u;
const UNPROVEN_HEAD_PATTERN = /neither contained in nor patch-equivalent/u;
const DIRTY_PATTERN = /uncommitted changes/u;
const CLAIMED_PATTERN = /claim .* still covers the checkout/u;
const LEASE_REGISTERED_PATTERN = /open loop lease registers the checkout/u;
const HEAD_MOVED_PATTERN = /moved after the review/u;
const SHALLOW_PATTERN = /shallow clone/u;
const REPLACEMENT_OUTSIDE_TARGET_PATTERN =
  /is not contained in reviewed target/u;
const REPLACEMENT_IS_ANCESTOR_PATTERN = /already an ancestor of source head/u;
const UNMAPPED_PATTERN = /have no reviewed replacement/u;
const REVIEWER_IS_AUTHOR_PATTERN = /is an author of the source/u;
const REVIEWER_IS_CONTROLLER_PATTERN =
  /is the controller running this cleanup/u;
const APPROVAL_BEFORE_REVIEW_PATTERN = /predates the review/u;
const STALE_APPROVAL_PATTERN = /hours old/u;
const OTHER_APPROVER_PATTERN = /runs on approval from the-user/u;
const UNKNOWN_FIELD_PATTERN = /Invalid replacement-lineage-receipt/u;
const EXTRA_MAPPING_PATTERN = /does not describe this history/u;
const EDITED_BRANCH_PATTERN = /not the reviewed other-branch/u;
const ALREADY_CONTAINED_PATTERN = /\(target-contained\)/u;
const SHARED_BRANCH_PATTERN = /also has branch source-unit checked out/u;
const APPROVER_IS_AUTHOR_PATTERN =
  /approver the-user is the reviewer, the controller, or an author/u;
const STOPPED_PATTERN = /Stopped before any other removal/u;
const NOT_REVIEWED_HEAD_PATTERN = /not the reviewed [0-9a-f]{40}/u;
const UNOVERRIDABLE_PATTERN = /cannot be overridden on the command line/u;
const SUBMODULE_PATTERN = /it has submodules/u;
const VIRTUAL_FILESYSTEM_PATTERN = /sets core\.virtualFilesystem/u;
const PARTIAL_CLONE_PATTERN = /is a partial clone/u;
const CONFIGURED_HOOK_PATTERN =
  /configures a hook through hook\.audit\.command/u;
const STAMP = "2026-10-08T12:00:00.000Z";
const PATH_EXISTS_PATTERN = /already exists/u;
const NO_ARCHIVE_PATTERN =
  /no archive was made.*partial archive .* and its pins were removed/u;
const MARKER_UNREADABLE_PATTERN = /not a restore marker/u;
const DAY = 86_400_000;
const ADAPTER = "test-adapter";
const HEAD_PIN_PATTERN = /\/head$/u;
const CHANGED_AFTER_ARCHIVE_PATTERN = /changed after it was archived/u;
const ONE_BYTE_CAP_PATTERN = /more than the 1-byte limit/u;
const PATH_TAKEN_PATTERN = /already exists/u;
const BRANCH_ELSEWHERE_PATTERN = /now points at [0-9a-f]{40}/u;
const MISSING_REASSIGN_PATTERN = /holds no reassign receipt/u;
const REDIRECTED_GIT_PATTERN =
  /would make Git read or remove something other than the checkout itself/u;
const DAYS_FALLBACK_PATTERN = /^archiveRetention\.days 0 /u;

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

interface LineageFixture {
  commits: string[];
  fixture: TestRepository;
  headSha: string;
  merged: string;
  path: string;
  replacements: string[];
  targetRevision: string;
}

const commonDirectory = (root: string): string =>
  captureInventory(root).repository.commonGitDirectory;

/**
 * A clean source checkout with two commits, shipped on main through
 * replacement commits whose patch IDs differ. With `sameBytes`, one broader
 * replacement carries the source's exact bytes plus another file; otherwise
 * two replacements change the bytes the review refined. A merged side
 * checkout is the normal cleanup's control.
 */
const lineageFixture = (sameBytes: boolean): LineageFixture => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  const mergedPath = join(fixture.base, "merged-unit");
  git(fixture.root, ["worktree", "add", "-b", "merged-unit", mergedPath]);
  writeFixture(mergedPath, "merged.ts", "export const merged = 1;\n");
  git(mergedPath, ["add", "."]);
  git(mergedPath, ["commit", "-m", "Merged work"]);
  git(fixture.root, [
    "merge",
    "--no-ff",
    "-m",
    "Merge merged-unit",
    "merged-unit",
  ]);

  const path = join(fixture.base, "source-unit");
  git(fixture.root, ["worktree", "add", "-b", "source-unit", path]);
  writeFixture(path, "a.ts", "export const a = 1;\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "Add a"]);
  writeFixture(path, "b.ts", "export const b = 1;\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "Add b"]);
  const commits = git(path, ["rev-list", "--reverse", "main..HEAD"]).split(
    "\n"
  );
  const headSha = git(path, ["rev-parse", "HEAD"]);

  const replacements: string[] = [];
  if (sameBytes) {
    writeFixture(fixture.root, "a.ts", "export const a = 1;\n");
    writeFixture(fixture.root, "b.ts", "export const b = 1;\n");
    writeFixture(fixture.root, "c.ts", "export const c = 1;\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Ship a and b with c"]);
    replacements.push(git(fixture.root, ["rev-parse", "HEAD"]));
  } else {
    writeFixture(fixture.root, "a.ts", "export const a = 2;\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Ship reviewed a"]);
    replacements.push(git(fixture.root, ["rev-parse", "HEAD"]));
    writeFixture(fixture.root, "b.ts", "export const b = 2;\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Ship reviewed b"]);
    replacements.push(git(fixture.root, ["rev-parse", "HEAD"]));
  }
  return {
    commits,
    fixture,
    headSha,
    merged: mergedPath,
    path,
    replacements,
    targetRevision: git(fixture.root, ["rev-parse", "HEAD"]),
  };
};

// The clean status digest a controller reads from the live inventory.
const liveDigest = (lineage: LineageFixture): string =>
  captureInventory(lineage.fixture.root).worktrees.find(
    (worktree) => worktree.path === lineage.path
  )?.changeDigest ?? "";

const receiptFor = (
  lineage: LineageFixture,
  now = Date.now()
): ReplacementLineageReceipt => ({
  approval: {
    approvalReference: "chat message approving removal",
    approvedAt: new Date(now - 5 * MINUTE).toISOString(),
    approvedBy: APPROVER,
    reason: "The source shipped through reviewed replacements.",
  },
  commits: lineage.commits.map((sourceCommit, index) => ({
    replacementCommits: [
      lineage.replacements[Math.min(index, lineage.replacements.length - 1)] ??
        "",
    ],
    sourceCommit,
  })),
  kind: "replacement-lineage-receipt",
  review: {
    decision: "replaced-in-target",
    reviewedAt: new Date(now - 10 * MINUTE).toISOString(),
    reviewerAgentId: REVIEWER,
    reviewReference: "review log for the source range",
  },
  schemaVersion: 1,
  source: {
    authorAgentId: AUTHOR,
    branch: "source-unit",
    changeDigest: liveDigest(lineage),
    headRevision: lineage.headSha,
    path: lineage.path,
  },
  targetRef: "main",
  targetRevision: lineage.targetRevision,
});

const prune = (
  lineage: LineageFixture,
  receipt: unknown,
  options: { dryRun?: boolean; now?: Date | undefined } = {}
) =>
  pruneRepository({
    agentId: CONTROLLER,
    approvedBy: APPROVER,
    dryRun: options.dryRun ?? false,
    lineageReceipt: receipt,
    now: options.now,
    reason: "Remove the reviewed obsolete source.",
    repositoryPath: lineage.fixture.root,
  });

const worktreePaths = (root: string): string[] =>
  captureInventory(root).worktrees.map((worktree) => worktree.path);

const pinRefs = (root: string): string =>
  git(root, ["for-each-ref", "--format=%(refname)", "refs/simple-changes/"]);

const branchExists = (root: string, branch: string): boolean =>
  git(root, ["branch", "--list", branch]) !== "";

const expectNothingWritten = (lineage: LineageFixture): void => {
  const { root } = lineage.fixture;
  const paths = worktreePaths(root);
  expect(paths).toContain(lineage.path);
  expect(paths).toContain(lineage.merged);
  expect(branchExists(root, "source-unit")).toBe(true);
  expect(branchExists(root, "merged-unit")).toBe(true);
  expect(pinRefs(root)).toBe("");
  const common = commonDirectory(root);
  expect(existsSync(replacementLineageDirectory(common))).toBe(false);
  expect(existsSync(worktreeArchivesRoot(common))).toBe(false);
  expect(readWorktreeCleanups(common)).toEqual([]);
};

/**
 * Seeds the review ledger so the first unique commit is a replay of an
 * earlier source commit, which `replaySourceAuthor` attested. The unique
 * commit's own attestation names only the declared author, so only the
 * replay provenance makes the other agent an author.
 */
const seedReplayAuthor = (
  lineage: LineageFixture,
  replaySourceAuthor: string
): void => {
  const { root } = lineage.fixture;
  const replaySource = git(root, [
    "commit-tree",
    "HEAD^{tree}",
    "-m",
    "Earlier source the unique commit replays",
  ]);
  const unique = lineage.commits[0] ?? "";
  const identity = (logicalId: string) => ({
    agent: `model-${logicalId}`,
    harness: "claude-code",
    instance: `instance-${logicalId}`,
    logicalId,
    recordedAt: STAMP,
    session: `session-${logicalId}`,
  });
  const ledger = emptyReviewLedger();
  ledger.attestations[replaySource] = [identity(replaySourceAuthor)];
  ledger.attestations[unique] = [identity(AUTHOR)];
  applyReplayRecord(
    ledger,
    unique,
    {
      detail: "test",
      orderedSources: [replaySource],
      verification: "verified",
    },
    STAMP
  );
  const path = reviewLedgerPath(commonDirectory(root));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
};

const UNSET_GIT_ENV =
  "env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_PREFIX -u GIT_COMMON_DIR";

/**
 * Installs one repository-configured program that acts once, when `when`
 * (a shell condition) holds, by running `action` (a shell command). Its
 * marker file shows whether it ever acted. `kind` picks a hook in
 * core.hooksPath or the fsmonitor hook.
 */
const installCallback = (
  lineage: LineageFixture,
  kind: "reference-transaction" | "fsmonitor",
  when: string,
  action: string
): string => {
  const { base, root } = lineage.fixture;
  const hooks = join(base, "hooks");
  mkdirSync(hooks, { recursive: true });
  const marker = join(base, `${kind}-acted`);
  const script = join(hooks, kind === "fsmonitor" ? "fsmonitor-watch" : kind);
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      kind === "fsmonitor" ? "" : "input=$(cat)",
      `[ -e '${marker}' ] && exit ${kind === "fsmonitor" ? 1 : 0}`,
      `${when} || exit ${kind === "fsmonitor" ? 1 : 0}`,
      `touch '${marker}'`,
      `${UNSET_GIT_ENV} ${action} >/dev/null 2>&1`,
      `exit ${kind === "fsmonitor" ? 1 : 0}`,
      "",
    ].join("\n")
  );
  chmodSync(script, 0o755);
  if (kind === "fsmonitor") {
    git(root, ["config", "core.fsmonitor", script]);
  } else {
    git(root, ["config", "core.hooksPath", hooks]);
  }
  return marker;
};

// A clean commit on the source checkout, which moves its head (detached or
// on its branch) to work nobody reviewed.
// It never needs the index, which a running status holds locked.
const moveSource = (lineage: LineageFixture): string =>
  `sh -c 'B=$(git -C "${lineage.path}" commit-tree "HEAD^{tree}" -p HEAD -m "Clean unreviewed work") && git -C "${lineage.path}" update-ref HEAD "$B"'`;

const pinExists = (lineage: LineageFixture): string =>
  `[ -d '${join(commonDirectory(lineage.fixture.root), "refs", "simple-changes")}' ] && [ -d '${lineage.path}' ]`;

const detachedReceipt = (
  lineage: LineageFixture
): ReplacementLineageReceipt => {
  git(lineage.path, ["checkout", "-q", "--detach"]);
  const receipt = receiptFor(lineage);
  receipt.source.branch = null;
  receipt.source.changeDigest = liveDigest(lineage);
  return receipt;
};

// Every hook name githooks(5) documents for Git 2.50.
const HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
] as const;

/**
 * A program that, once the pin exists, marks that it ran and moves the
 * source head, then exits; as a clean filter it passes content through.
 */
const actingScript = (
  lineage: LineageFixture,
  name: string,
  tail: string
): { marker: string; script: string } => {
  const directory = join(lineage.fixture.base, "programs");
  mkdirSync(directory, { recursive: true });
  const marker = join(lineage.fixture.base, `${name}-acted`);
  const script = join(directory, name);
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `if ${pinExists(lineage)} && [ ! -e '${marker}' ]; then`,
      `  touch '${marker}'`,
      `  ${UNSET_GIT_ENV} ${moveSource(lineage)} >/dev/null 2>&1`,
      "fi",
      tail,
      "",
    ].join("\n")
  );
  chmodSync(script, 0o755);
  return { marker, script };
};

// A long-running filter-process program (Git's pkt-line protocol, clean
// only) that acts like `actingScript` before answering each request.
const actingProcessFilter = (
  lineage: LineageFixture
): { marker: string; script: string } => {
  const { marker, script: act } = actingScript(lineage, "process-act", "");
  const script = join(lineage.fixture.base, "programs", "process-filter");
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
let buffer = Buffer.alloc(0);
const readExact = (length) => {
  while (buffer.length < length) {
    const chunk = Buffer.alloc(65536);
    let read = 0;
    try { read = fs.readSync(0, chunk, 0, chunk.length, null); }
    catch (error) { if (error.code === "EAGAIN") { continue; } throw error; }
    if (read === 0) { process.exit(0); }
    buffer = Buffer.concat([buffer, chunk.subarray(0, read)]);
  }
  const out = buffer.subarray(0, length);
  buffer = buffer.subarray(length);
  return out;
};
const readPacket = () => {
  const length = Number.parseInt(readExact(4).toString(), 16);
  return length === 0 ? null : readExact(length - 4);
};
const readList = () => {
  const items = [];
  for (let packet = readPacket(); packet !== null; packet = readPacket()) { items.push(packet); }
  return items;
};
const write = (data) => {
  const bytes = Buffer.from(data);
  fs.writeSync(1, (bytes.length + 4).toString(16).padStart(4, "0"));
  fs.writeSync(1, bytes);
};
const flush = () => fs.writeSync(1, "0000");
readList(); write("git-filter-server\\n"); write("version=2\\n"); flush();
readList(); write("capability=clean\\n"); flush();
for (;;) {
  readList();
  const content = readList();
  execFileSync(${JSON.stringify(act)});
  write("status=success\\n"); flush();
  for (const packet of content) { write(packet); }
  flush(); flush();
}
`
  );
  chmodSync(script, 0o755);
  return { marker, script };
};

// Keeps a tracked source file stat-dirty, so every status rehashes it
// through whatever filter its attributes name.
const keepRehashing = (lineage: LineageFixture): void => {
  const future = new Date(Date.now() + 365 * 24 * 60 * MINUTE);
  utimesSync(join(lineage.path, "a.ts"), future, future);
};

const infoAttributes = (lineage: LineageFixture, line: string): void => {
  const info = join(commonDirectory(lineage.fixture.root), "info");
  mkdirSync(info, { recursive: true });
  writeFileSync(join(info, "attributes"), `${line}\n`);
};

// Runs `run` with extra process environment, restoring it afterwards.
const withEnvironment = <T>(extra: Record<string, string>, run: () => T): T => {
  const saved = Object.fromEntries(
    Object.keys(extra).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, extra);
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
};

/**
 * `firstOwner` claims the source checkout, approved takeovers hand the claim
 * along `chain`, and the last owner releases it, so only the takeover
 * history still names the earlier owners.
 */
const claimThroughTakeovers = (
  lineage: LineageFixture,
  firstOwner: string,
  chain: readonly string[]
): void => {
  const { root } = lineage.fixture;
  const claim = claimWorktree(root, firstOwner, lineage.path, "claude-code");
  let owner = firstOwner;
  for (const next of chain) {
    const current = captureInventory(root).worktrees.find(
      (worktree) => worktree.path === lineage.path
    );
    takeoverWorktreeClaim({
      action: "reassign",
      approvedBy: APPROVER,
      claimId: claim.claimId,
      expectedBranch: current?.branch ?? null,
      expectedHeadSha: current?.headSha ?? null,
      expectedStatusDigest: current?.changeDigest ?? "",
      newAgentId: next,
      reason: "The first session ended and cannot be contacted.",
      repositoryPath: root,
    });
    owner = next;
  }
  releaseWorktreeClaim(root, owner, claim.claimId);
};

const expectRefusal = (run: () => unknown, pattern: RegExp): void => {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SimpleChangesError);
  expect((caught as Error).message).toMatch(pattern);
};

const lineageRecords = (root: string): Record<string, unknown>[] => {
  const directory = replacementLineageDirectory(commonDirectory(root));
  return readdirSync(directory)
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(resolve(directory, name), "utf8")) as Record<
          string,
          unknown
        >
    );
};

// The checkout's private Git directory, `<common>/worktrees/<name>`.
const privateGitDirectoryOf = (path: string): string =>
  realpathSync(git(path, ["rev-parse", "--absolute-git-dir"]));

// Every value of one key in the shared local configuration; none when unset.
const configValues = (root: string, key: string): string[] => {
  const result = spawnSync(
    ["git", "-C", root, "config", "--local", "--get-all", key],
    { stderr: "pipe", stdout: "pipe" }
  );
  const output = decoder.decode(result.stdout).trim();
  return result.exitCode === 0 && output !== "" ? output.split("\n") : [];
};

// The archive a reviewed removal reports having written.
const reportedArchive = (report: {
  reviewedReplacement: ReplacementLineageOutcome | null;
}): { archiveId: string; path: string } => {
  const archive = report.reviewedReplacement?.archive;
  if (!(archive?.archiveId && archive.path)) {
    throw new Error("Expected the reviewed removal to name its archive");
  }
  return { archiveId: archive.archiveId, path: archive.path };
};

const restoreLineage = (lineage: LineageFixture, archiveId: string) =>
  restoreArchivedWorktree({ archiveId, repositoryPath: lineage.fixture.root });

// A repository policy file in the primary checkout with this retention.
const writeRetentionPolicy = (
  lineage: LineageFixture,
  archiveRetention: Record<string, unknown>
): void => {
  writeFileSync(
    join(lineage.fixture.root, ".simple-changes.json"),
    `${JSON.stringify({ ...DEFAULT_POLICY, archiveRetention }, null, 2)}\n`
  );
};

// An archive keeps a read-only folder's mode, which a plain recursive
// removal of the fixture cannot delete; this makes every folder writable.
const makeTreeWritable = (path: string): void => {
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return;
  }
  chmodSync(path, 0o755);
  for (const name of readdirSync(path)) {
    makeTreeWritable(join(path, name));
  }
};

describe("reviewed replacement lineage cleanup", () => {
  test("without a receipt, prune keeps the replaced source and names branch audit", () => {
    const lineage = lineageFixture(false);
    const report = pruneRepository({
      approvedBy: APPROVER,
      dryRun: false,
      reason: "Ordinary prune.",
      repositoryPath: lineage.fixture.root,
    });
    expect(report.reviewedReplacement).toBeNull();
    expect(report.removed.map((entry) => entry.path)).toEqual([lineage.merged]);
    expect(
      report.preserved.find((entry) => entry.path === lineage.path)?.reason
    ).toMatch(UNPROVEN_HEAD_PATTERN);
    expect(worktreePaths(lineage.fixture.root)).toContain(lineage.path);
    expect(pinRefs(lineage.fixture.root)).toBe("");
  });

  test("prune removes a reviewed source, pins its head, and records the lineage", () => {
    const lineage = lineageFixture(false);
    const receipt = receiptFor(lineage);
    const report = prune(lineage, receipt);
    const { root } = lineage.fixture;

    expect(report.errors).toEqual([]);
    expect(report.plannedRemovals).toContainEqual({
      branch: "source-unit",
      containment: "reviewed-replacement",
      headSha: lineage.headSha,
      path: lineage.path,
    });
    expect(
      report.removed.map((entry) => [entry.path, entry.containment])
    ).toEqual(
      [
        [lineage.merged, "target-contained"],
        [lineage.path, "reviewed-replacement"],
      ].sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""))
    );
    expect(report.reviewedReplacement).toMatchObject({
      branchDeleted: true,
      byteProof: { differingPaths: ["a.ts", "b.ts"], status: "not-proven" },
      uniqueCommits: lineage.commits,
      worktreeRemoved: true,
    });
    expect(worktreePaths(root)).not.toContain(lineage.path);
    expect(existsSync(lineage.path)).toBe(false);
    expect(branchExists(root, "source-unit")).toBe(false);
    const pin = report.reviewedReplacement?.pinRefs[0] ?? "";
    expect(pin).toMatch(PIN_REF_PATTERN);
    expect(git(root, ["rev-parse", pin])).toBe(lineage.headSha);
    expect(git(root, ["rev-list", "--count", `main..${pin}`])).toBe("2");

    const records = lineageRecords(root);
    expect(
      records
        .map((record) => String(record.phase))
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(["completed", "intent"]);
    for (const record of records) {
      validateSchema("replacement-lineage-removal", record);
      expect(record).toMatchObject({
        approvedBy: APPROVER,
        cleanupId: null,
        command: "prune",
        controllerAgentId: CONTROLLER,
        pinRefs: expect.arrayContaining([
          { object: lineage.headSha, ref: pin },
        ]),
        receipt,
      });
    }
    expect(
      records.find((record) => record.phase === "completed")?.outcome
    ).toEqual({ branchDeleted: true, errors: [], worktreeRemoved: true });
  });

  test("an exact-byte replacement records the byte proof", () => {
    const lineage = lineageFixture(true);
    const report = prune(lineage, receiptFor(lineage));
    expect(report.reviewedReplacement).toMatchObject({
      byteProof: { status: "proven", touchedPaths: ["a.ts", "b.ts"] },
      worktreeRemoved: true,
    });
  });

  test("a dry run verifies and plans the removal but changes nothing", () => {
    const lineage = lineageFixture(false);
    const report = prune(lineage, receiptFor(lineage), { dryRun: true });
    expect(report.plannedRemovals.map((entry) => entry.containment)).toContain(
      "reviewed-replacement"
    );
    expect(report.reviewedReplacement).toMatchObject({
      recordPaths: [],
      removalId: null,
      worktreeRemoved: false,
    });
    expect(report.removed).toEqual([]);
    expectNothingWritten(lineage);
  });

  test("worktree cleanup removes a reviewed source and keeps the strict receipt history unchanged in shape", () => {
    const lineage = lineageFixture(false);
    const receipt = receiptFor(lineage);
    const result = standaloneWorktreeCleanup({
      agentId: CONTROLLER,
      approvedBy: APPROVER,
      lineageReceipt: receipt,
      reason: "Remove the reviewed obsolete source.",
      repositoryPath: lineage.fixture.root,
    });
    const { root } = lineage.fixture;
    expect(result.reviewedReplacement).toMatchObject({
      branchDeleted: true,
      worktreeRemoved: true,
    });
    expect(worktreePaths(root)).not.toContain(lineage.path);
    expect(
      git(root, ["rev-parse", result.reviewedReplacement?.pinRefs[0] ?? ""])
    ).toBe(lineage.headSha);
    const history = readWorktreeCleanups(commonDirectory(root));
    expect(history.map((entry) => entry.phase)).toEqual([
      "intent",
      "completed",
    ]);
    for (const entry of history) {
      for (const removal of [
        ...entry.removed,
        ...(entry.plannedRemovals ?? []),
      ]) {
        expect(removal.path).not.toBe(lineage.path);
      }
      expect(entry.preserved.map((item) => item.path)).not.toContain(
        lineage.path
      );
    }
    const records = lineageRecords(root);
    expect(
      records.every((record) => record.cleanupId === result.cleanupId)
    ).toBe(true);
    expect(
      records.every((record) => record.command === "worktree-cleanup")
    ).toBe(true);
  });

  test("a receipt refused by worktree cleanup writes no cleanup history", () => {
    const lineage = lineageFixture(false);
    const receipt = receiptFor(lineage);
    receipt.review.reviewerAgentId = CONTROLLER;
    expectRefusal(
      () =>
        standaloneWorktreeCleanup({
          agentId: CONTROLLER,
          approvedBy: APPROVER,
          lineageReceipt: receipt,
          reason: "Remove the reviewed obsolete source.",
          repositoryPath: lineage.fixture.root,
        }),
      REVIEWER_IS_CONTROLLER_PATTERN
    );
    expectNothingWritten(lineage);
  });

  interface RefusalOverrides {
    now?: Date;
    receipt?: unknown;
  }

  const refusals: Array<{
    name: string;
    pattern: RegExp;
    /** Returns the clock or the edited document to run with, if any. */
    setUp: (
      lineage: LineageFixture,
      receipt: ReplacementLineageReceipt
    ) => RefusalOverrides;
  }> = [
    {
      name: "a dirty checkout",
      pattern: DIRTY_PATTERN,
      setUp: (lineage) => {
        writeFixture(lineage.path, "wip.ts", "export const wip = 1;\n");
        return {};
      },
    },
    {
      name: "a claimed checkout",
      pattern: CLAIMED_PATTERN,
      setUp: (lineage) => {
        claimWorktree(
          lineage.fixture.root,
          AUTHOR,
          lineage.path,
          "claude-code"
        );
        return {};
      },
    },
    {
      name: "a checkout an open lease registers",
      pattern: LEASE_REGISTERED_PATTERN,
      setUp: (lineage) => {
        startLoop(lineage.fixture.root, "loop-controller", "integrate");
        return {};
      },
    },
    {
      name: "a head that moved after the review",
      pattern: HEAD_MOVED_PATTERN,
      setUp: (lineage) => {
        writeFixture(lineage.path, "later.ts", "export const later = 1;\n");
        git(lineage.path, ["add", "."]);
        git(lineage.path, ["commit", "-m", "Later work"]);
        return {};
      },
    },
    {
      name: "a shallow clone",
      pattern: SHALLOW_PATTERN,
      setUp: (lineage) => {
        const root = git(lineage.fixture.root, [
          "rev-list",
          "--max-parents=0",
          "HEAD",
        ]);
        writeFileSync(
          join(commonDirectory(lineage.fixture.root), "shallow"),
          `${root}\n`
        );
        return {};
      },
    },
    {
      name: "a replacement the target does not contain",
      pattern: REPLACEMENT_OUTSIDE_TARGET_PATTERN,
      setUp: (lineage, receipt) => {
        const outside = git(lineage.fixture.root, [
          "commit-tree",
          "HEAD^{tree}",
          "-p",
          "HEAD",
          "-m",
          "Never merged",
        ]);
        receipt.commits[0] = {
          replacementCommits: [outside],
          sourceCommit: receipt.commits[0]?.sourceCommit ?? "",
        };
        return {};
      },
    },
    {
      name: "a replacement that is an ancestor of the source head",
      pattern: REPLACEMENT_IS_ANCESTOR_PATTERN,
      setUp: (lineage, receipt) => {
        const initial = git(lineage.fixture.root, [
          "rev-list",
          "--max-parents=0",
          "HEAD",
        ]);
        receipt.commits[1] = {
          replacementCommits: [initial],
          sourceCommit: receipt.commits[1]?.sourceCommit ?? "",
        };
        return {};
      },
    },
    {
      name: "an unmapped unique commit",
      pattern: UNMAPPED_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.commits.pop();
        return {};
      },
    },
    {
      name: "a reviewer who is the declared author",
      pattern: REVIEWER_IS_AUTHOR_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.review.reviewerAgentId = ` ${AUTHOR} `;
        return {};
      },
    },
    {
      name: "a reviewer who once claimed the checkout",
      pattern: REVIEWER_IS_AUTHOR_PATTERN,
      setUp: (lineage) => {
        const claim = claimWorktree(
          lineage.fixture.root,
          REVIEWER,
          lineage.path,
          "claude-code"
        );
        releaseWorktreeClaim(lineage.fixture.root, REVIEWER, claim.claimId);
        return {};
      },
    },
    {
      name: "a reviewer a takeover chain replaced as the checkout's owner",
      pattern: REVIEWER_IS_AUTHOR_PATTERN,
      setUp: (lineage) => {
        claimThroughTakeovers(lineage, REVIEWER, ["middle-agent", AUTHOR]);
        return {};
      },
    },
    {
      name: "an approver a takeover replaced as the checkout's owner",
      pattern: APPROVER_IS_AUTHOR_PATTERN,
      setUp: (lineage) => {
        claimThroughTakeovers(lineage, APPROVER, [AUTHOR]);
        return {};
      },
    },
    {
      name: "a reviewer who is the controller",
      pattern: REVIEWER_IS_CONTROLLER_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.review.reviewerAgentId = CONTROLLER;
        return {};
      },
    },
    {
      name: "an approval before the review",
      pattern: APPROVAL_BEFORE_REVIEW_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.approval.approvedAt = new Date(
          Date.parse(receipt.review.reviewedAt) - MINUTE
        ).toISOString();
        return {};
      },
    },
    {
      name: "a stale approval",
      pattern: STALE_APPROVAL_PATTERN,
      setUp: () => ({ now: new Date(Date.now() + 25 * 60 * MINUTE) }),
    },
    {
      name: "an approval for a different approver",
      pattern: OTHER_APPROVER_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.approval.approvedBy = "someone-else";
        return {};
      },
    },
    {
      name: "an edited receipt with an unknown field",
      pattern: UNKNOWN_FIELD_PATTERN,
      setUp: (_lineage, receipt) => ({
        receipt: { ...receipt, waiver: true },
      }),
    },
    {
      name: "an edited mapping naming a commit the target already has",
      pattern: EXTRA_MAPPING_PATTERN,
      setUp: (lineage, receipt) => {
        const initial = git(lineage.fixture.root, [
          "rev-list",
          "--max-parents=0",
          "HEAD",
        ]);
        receipt.commits.push({
          replacementCommits: [lineage.replacements[0] ?? ""],
          sourceCommit: initial,
        });
        return {};
      },
    },
    {
      name: "a reviewer who authored a replay source of a unique commit",
      pattern: REVIEWER_IS_AUTHOR_PATTERN,
      setUp: (lineage) => {
        seedReplayAuthor(lineage, REVIEWER);
        return {};
      },
    },
    {
      name: "an approver who authored a replay source of a unique commit",
      pattern: APPROVER_IS_AUTHOR_PATTERN,
      setUp: (lineage) => {
        seedReplayAuthor(lineage, APPROVER);
        return {};
      },
    },
    {
      name: "a second checkout on the source branch",
      pattern: SHARED_BRANCH_PATTERN,
      setUp: (lineage) => {
        git(lineage.fixture.root, [
          "worktree",
          "add",
          "--force",
          join(lineage.fixture.base, "source-unit-copy"),
          "source-unit",
        ]);
        return {};
      },
    },
    {
      name: "an edited branch name",
      pattern: EDITED_BRANCH_PATTERN,
      setUp: (_lineage, receipt) => {
        receipt.source.branch = "other-branch";
        return {};
      },
    },
  ];

  for (const refusal of refusals) {
    test(`refuses ${refusal.name} and writes nothing`, () => {
      const lineage = lineageFixture(false);
      const receipt = receiptFor(lineage);
      const overrides = refusal.setUp(lineage, receipt);
      expectRefusal(
        () =>
          prune(lineage, overrides.receipt ?? receipt, { now: overrides.now }),
        refusal.pattern
      );
      expectNothingWritten(lineage);
    });
  }

  test("a takeover history of unrelated agents leaves the reviewer and approver eligible", () => {
    const lineage = lineageFixture(false);
    claimThroughTakeovers(lineage, "former-owner", ["middle-agent", AUTHOR]);
    const report = prune(lineage, receiptFor(lineage), { dryRun: true });
    expect(report.reviewedReplacement?.path).toBe(lineage.path);
    expectNothingWritten(lineage);
  });

  test("a seeded ledger whose replay sources the declared author wrote is accepted", () => {
    const lineage = lineageFixture(false);
    seedReplayAuthor(lineage, AUTHOR);
    const report = prune(lineage, receiptFor(lineage), { dryRun: true });
    expect(report.reviewedReplacement?.path).toBe(lineage.path);
  });

  const expectReviewedHeadRemoved = (
    lineage: LineageFixture,
    report: { reviewedReplacement: { pinRefs: string[] } | null },
    marker: string
  ): void => {
    const { root } = lineage.fixture;
    expect(existsSync(marker)).toBe(false);
    expect(worktreePaths(root)).not.toContain(lineage.path);
    const pin = report.reviewedReplacement?.pinRefs[0] ?? "";
    expect(git(root, ["rev-parse", pin])).toBe(lineage.headSha);
    // Nothing but the reviewed head was ever checked out there: no commit
    // outside the target other than the two reviewed ones exists.
    expect(
      git(root, ["log", "--all", "--format=%s", "--grep=Clean unreviewed"])
    ).toBe("");
  };

  test("prune runs no fsmonitor hook between its last read and the removal", () => {
    const lineage = lineageFixture(false);
    const receipt = detachedReceipt(lineage);
    const marker = installCallback(
      lineage,
      "fsmonitor",
      pinExists(lineage),
      moveSource(lineage)
    );
    const report = prune(lineage, receipt);
    expect(report.errors).toEqual([]);
    expectReviewedHeadRemoved(lineage, report, marker);
  });

  test("prune runs no reference-transaction hook when it pins the head", () => {
    const lineage = lineageFixture(false);
    const receipt = detachedReceipt(lineage);
    const marker = installCallback(
      lineage,
      "reference-transaction",
      `[ "$1" = committed ] && printf '%s' "$input" | grep -q ' refs/simple-changes/'`,
      moveSource(lineage)
    );
    const report = prune(lineage, receipt);
    expect(report.errors).toEqual([]);
    expectReviewedHeadRemoved(lineage, report, marker);
  });

  test("worktree cleanup runs no reference-transaction hook when it deletes the branch", () => {
    const lineage = lineageFixture(false);
    const copy = join(lineage.fixture.base, "source-unit-attached");
    const marker = installCallback(
      lineage,
      "reference-transaction",
      `[ "$1" = prepared ] && printf '%s' "$input" | grep -q ' 0\\{40\\} refs/heads/source-unit$'`,
      `git -C '${lineage.fixture.root}' worktree add --force '${copy}' source-unit`
    );
    const result = standaloneWorktreeCleanup({
      agentId: CONTROLLER,
      approvedBy: APPROVER,
      lineageReceipt: receiptFor(lineage),
      reason: "Remove the reviewed obsolete source.",
      repositoryPath: lineage.fixture.root,
    });
    expect(result.errors).toEqual([]);
    expect(result.reviewedReplacement?.branchDeleted).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(copy)).toBe(false);
    expect(branchExists(lineage.fixture.root, "source-unit")).toBe(false);
  });

  test("a head an fsmonitor hook moves during verification is refused before anything is written", () => {
    const lineage = lineageFixture(false);
    const receipt = detachedReceipt(lineage);
    const marker = installCallback(
      lineage,
      "fsmonitor",
      "true",
      moveSource(lineage)
    );
    expectRefusal(() => prune(lineage, receipt), NOT_REVIEWED_HEAD_PATTERN);
    expect(existsSync(marker)).toBe(true);
    expectNothingWritten(lineage);
  });

  test("an unconfirmed boundary refuses before anything is written", () => {
    const lineage = lineageFixture(false);
    // A driver name Git cannot take back on the command line.
    git(lineage.fixture.root, ["config", "filter.a=b.clean", "cat"]);
    expectRefusal(
      () => prune(lineage, receiptFor(lineage)),
      UNOVERRIDABLE_PATTERN
    );
    expectNothingWritten(lineage);
  });

  test("no hook of any name runs from the pin through branch deletion", () => {
    const lineage = lineageFixture(false);
    const hooks = join(lineage.fixture.base, "all-hooks");
    mkdirSync(hooks, { recursive: true });
    const markers: string[] = [];
    for (const name of HOOK_NAMES) {
      const { marker, script } = actingScript(
        lineage,
        name,
        "cat >/dev/null 2>&1; exit 0"
      );
      writeFileSync(join(hooks, name), readFileSync(script));
      chmodSync(join(hooks, name), 0o755);
      markers.push(marker);
    }
    git(lineage.fixture.root, ["config", "core.hooksPath", hooks]);
    const report = prune(lineage, receiptFor(lineage));
    expect(report.errors).toEqual([]);
    expect(report.reviewedReplacement?.branchDeleted).toBe(true);
    expect(markers.filter((marker) => existsSync(marker))).toEqual([]);
  });

  test("a hooks path set through GIT_CONFIG_* environment does not run", () => {
    const lineage = lineageFixture(false);
    const hooks = join(lineage.fixture.base, "env-hooks");
    mkdirSync(hooks, { recursive: true });
    const { marker, script } = actingScript(
      lineage,
      "env-reference-transaction",
      "cat >/dev/null 2>&1; exit 0"
    );
    writeFileSync(join(hooks, "reference-transaction"), readFileSync(script));
    chmodSync(join(hooks, "reference-transaction"), 0o755);
    const receipt = receiptFor(lineage);
    const report = withEnvironment(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: hooks,
      },
      () => prune(lineage, receipt)
    );
    expect(report.errors).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  const filterScopes: Array<{
    name: string;
    /** Configures the acting filter and returns the environment to run in. */
    setUp: (lineage: LineageFixture, filter: string) => Record<string, string>;
  }> = [
    {
      name: "the shared local config, named in info/attributes",
      setUp: (lineage, filter) => {
        git(lineage.fixture.root, ["config", "filter.watch.clean", filter]);
        infoAttributes(lineage, "a.ts filter=watch");
        return {};
      },
    },
    {
      name: "only the source's config.worktree",
      setUp: (lineage, filter) => {
        git(lineage.fixture.root, [
          "config",
          "extensions.worktreeConfig",
          "true",
        ]);
        git(lineage.path, [
          "config",
          "--worktree",
          "filter.watch.clean",
          filter,
        ]);
        infoAttributes(lineage, "a.ts filter=watch");
        return {};
      },
    },
    {
      name: "an includeIf onbranch file only the source sees, named in core.attributesFile",
      setUp: (lineage, filter) => {
        const included = join(lineage.fixture.base, "source-only.gitconfig");
        writeFileSync(included, `[filter "watch"]\n\tclean = ${filter}\n`);
        git(lineage.fixture.root, [
          "config",
          "includeIf.onbranch:source-unit.path",
          included,
        ]);
        const attributes = join(lineage.fixture.base, "attributes");
        writeFileSync(attributes, "a.ts filter=watch\n");
        git(lineage.fixture.root, [
          "config",
          "core.attributesFile",
          attributes,
        ]);
        return {};
      },
    },
    {
      name: "a global config file named by GIT_CONFIG_GLOBAL",
      setUp: (lineage, filter) => {
        const global = join(lineage.fixture.base, "global.gitconfig");
        writeFileSync(global, `[filter "watch"]\n\tclean = ${filter}\n`);
        infoAttributes(lineage, "a.ts filter=watch");
        return { GIT_CONFIG_GLOBAL: global };
      },
    },
    {
      name: "GIT_CONFIG_* environment",
      setUp: (lineage, filter) => {
        infoAttributes(lineage, "a.ts filter=watch");
        return {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "filter.watch.clean",
          GIT_CONFIG_VALUE_0: filter,
        };
      },
    },
  ];

  for (const scope of filterScopes) {
    test(`a clean filter from ${scope.name} does not run inside the boundary`, () => {
      const lineage = lineageFixture(false);
      const { marker, script } = actingScript(
        lineage,
        "clean-filter",
        "exec cat"
      );
      const environment = scope.setUp(lineage, script);
      keepRehashing(lineage);
      const report = withEnvironment(environment, () => {
        const receipt = receiptFor(lineage);
        return prune(lineage, receipt);
      });
      expect(report.errors).toEqual([]);
      expect(report.reviewedReplacement?.worktreeRemoved).toBe(true);
      expect(existsSync(marker)).toBe(false);
    });
  }

  test("a filter-process program does not run inside the boundary", () => {
    const lineage = lineageFixture(false);
    const { marker, script } = actingProcessFilter(lineage);
    git(lineage.fixture.root, ["config", "filter.watch.process", script]);
    infoAttributes(lineage, "a.ts filter=watch");
    keepRehashing(lineage);
    const report = prune(lineage, receiptFor(lineage));
    expect(report.errors).toEqual([]);
    expect(report.reviewedReplacement?.worktreeRemoved).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("the acting clean filter runs in an ordinary status outside the boundary (control)", () => {
    const lineage = lineageFixture(false);
    const { marker, script } = actingScript(
      lineage,
      "clean-filter",
      "exec cat"
    );
    git(lineage.fixture.root, ["config", "filter.watch.clean", script]);
    infoAttributes(lineage, "a.ts filter=watch");
    keepRehashing(lineage);
    // Once the pin exists, an ordinary status outside the boundary runs it.
    mkdirSync(
      join(commonDirectory(lineage.fixture.root), "refs", "simple-changes"),
      {
        recursive: true,
      }
    );
    git(lineage.path, ["status", "--porcelain"]);
    expect(existsSync(marker)).toBe(true);
  });

  test("the acting filter-process program runs in an ordinary status outside the boundary (control)", () => {
    const lineage = lineageFixture(false);
    const { marker, script } = actingProcessFilter(lineage);
    git(lineage.fixture.root, ["config", "filter.watch.process", script]);
    infoAttributes(lineage, "a.ts filter=watch");
    keepRehashing(lineage);
    mkdirSync(
      join(commonDirectory(lineage.fixture.root), "refs", "simple-changes"),
      { recursive: true }
    );
    expect(git(lineage.path, ["status", "--porcelain"])).toBe("");
    expect(existsSync(marker)).toBe(true);
  });

  test("refuses a source with a submodule and writes nothing", () => {
    const lineage = lineageFixture(false);
    const initial = git(lineage.fixture.root, [
      "rev-list",
      "--max-parents=0",
      "HEAD",
    ]);
    git(lineage.path, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${initial},sub`,
    ]);
    git(lineage.path, ["commit", "-q", "-m", "Add a submodule"]);
    // An uninitialized submodule's empty folder keeps the checkout clean.
    mkdirSync(join(lineage.path, "sub"));
    lineage.commits = git(lineage.path, [
      "rev-list",
      "--reverse",
      "main..HEAD",
    ]).split("\n");
    lineage.headSha = git(lineage.path, ["rev-parse", "HEAD"]);
    expectRefusal(() => prune(lineage, receiptFor(lineage)), SUBMODULE_PATTERN);
    expectNothingWritten(lineage);
  });

  test("refuses a valueless promisor remote and writes nothing", () => {
    const lineage = lineageFixture(false);
    const config = join(commonDirectory(lineage.fixture.root), "config");
    writeFileSync(
      config,
      `${readFileSync(config, "utf8")}[remote "origin"]\n\tpromisor\n`
    );
    expectRefusal(
      () => prune(lineage, receiptFor(lineage)),
      PARTIAL_CLONE_PATTERN
    );
    expectNothingWritten(lineage);
  });

  test("refuses a partial clone and writes nothing", () => {
    const lineage = lineageFixture(false);
    git(lineage.fixture.root, ["config", "remote.origin.promisor", "true"]);
    expectRefusal(
      () => prune(lineage, receiptFor(lineage)),
      PARTIAL_CLONE_PATTERN
    );
    expectNothingWritten(lineage);
  });

  test("refuses a configured virtual filesystem program and writes nothing", () => {
    const lineage = lineageFixture(false);
    git(lineage.fixture.root, [
      "config",
      "core.virtualFilesystem",
      "/bin/true",
    ]);
    expectRefusal(
      () => prune(lineage, receiptFor(lineage)),
      VIRTUAL_FILESYSTEM_PATTERN
    );
    expectNothingWritten(lineage);
  });

  test("refuses a hook configured through hook.* and writes nothing", () => {
    const lineage = lineageFixture(false);
    git(lineage.path, ["config", "hook.audit.command", "true"]);
    expectRefusal(
      () => prune(lineage, receiptFor(lineage)),
      CONFIGURED_HOOK_PATTERN
    );
    expectNothingWritten(lineage);
  });

  // A checkout whose ignored, read-only folder `git worktree remove` cannot
  // delete: the reviewed removal fails without any callback.
  const unremovableSource = (lineage: LineageFixture): (() => void) => {
    mkdirSync(join(commonDirectory(lineage.fixture.root), "info"), {
      recursive: true,
    });
    writeFileSync(
      join(commonDirectory(lineage.fixture.root), "info", "exclude"),
      "kept/\n"
    );
    const kept = join(lineage.path, "kept");
    mkdirSync(kept);
    writeFileSync(join(kept, "file"), "kept\n");
    chmodSync(kept, 0o555);
    return () => chmodSync(kept, 0o755);
  };

  const expectStoppedAfterPin = (lineage: LineageFixture): void => {
    const { root } = lineage.fixture;
    expect(worktreePaths(root)).toContain(lineage.merged);
    expect(branchExists(root, "merged-unit")).toBe(true);
    expect(branchExists(root, "source-unit")).toBe(true);
    expect(readWorktreeCleanups(commonDirectory(root))).toEqual([]);
    const pins = pinRefs(root).split("\n");
    const head = pins.find((pin) => pin.endsWith("/head")) ?? "";
    expect(head).toMatch(PIN_REF_PATTERN);
    expect(git(root, ["rev-parse", head])).toBe(lineage.headSha);
    expect(existsSync(worktreeArchivesRoot(commonDirectory(root)))).toBe(true);
    const completed = lineageRecords(root).find(
      (record) => record.phase === "completed"
    );
    expect(completed?.outcome).toMatchObject({
      branchDeleted: false,
      worktreeRemoved: false,
    });
  };

  test("prune stops before any other removal when the reviewed removal fails", () => {
    const lineage = lineageFixture(false);
    const restore = unremovableSource(lineage);
    try {
      expectRefusal(() => prune(lineage, receiptFor(lineage)), STOPPED_PATTERN);
      expectStoppedAfterPin(lineage);
    } finally {
      restore();
    }
  });

  test("worktree cleanup writes no cleanup history when the reviewed removal fails", () => {
    const lineage = lineageFixture(false);
    const restore = unremovableSource(lineage);
    try {
      expectRefusal(
        () =>
          standaloneWorktreeCleanup({
            agentId: CONTROLLER,
            approvedBy: APPROVER,
            lineageReceipt: receiptFor(lineage),
            reason: "Remove the reviewed obsolete source.",
            repositoryPath: lineage.fixture.root,
          }),
        STOPPED_PATTERN
      );
      expectStoppedAfterPin(lineage);
    } finally {
      restore();
    }
  });

  test("refuses a head the target already contains, naming target-contained", () => {
    const lineage = lineageFixture(false);
    git(lineage.fixture.root, [
      "merge",
      "--no-ff",
      "-X",
      "theirs",
      "-m",
      "Merge the source too",
      "source-unit",
    ]);
    const receipt = receiptFor(lineage);
    receipt.targetRevision = git(lineage.fixture.root, ["rev-parse", "HEAD"]);
    expectRefusal(() => prune(lineage, receipt), ALREADY_CONTAINED_PATTERN);
    expectNothingWritten(lineage);
  });

  test("the prune command reads --lineage-receipt and plans the reviewed removal", () => {
    const lineage = lineageFixture(false);
    const receiptPath = join(lineage.fixture.base, "lineage-receipt.json");
    writeFileSync(receiptPath, JSON.stringify(receiptFor(lineage)));
    const result = spawnSync(
      [
        process.execPath,
        CLI_PATH,
        "prune",
        "--agent-id",
        CONTROLLER,
        "--approved-by",
        APPROVER,
        "--lineage-receipt",
        receiptPath,
        "--dry-run",
        "--json",
        "--repo",
        lineage.fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(decoder.decode(result.stdout)) as {
      reviewedReplacement: { method: string; path: string } | null;
    };
    expect(report.reviewedReplacement).toMatchObject({
      method: "reviewed-replacement",
      path: lineage.path,
    });
    expectNothingWritten(lineage);
  });

  test("a lineage receipt requires the controller's agent ID", () => {
    const lineage = lineageFixture(false);
    expectRefusal(
      () =>
        pruneRepository({
          approvedBy: APPROVER,
          dryRun: true,
          lineageReceipt: receiptFor(lineage),
          repositoryPath: lineage.fixture.root,
        }),
      AGENT_REQUIRED_PATTERN
    );
    expectNothingWritten(lineage);
  });

  // The archive copies a read-only folder with its mode, so a checkout that
  // held one (the stopped-run tests above) leaves an archive the fixture's
  // plain recursive removal cannot delete. Runs before the file's cleanup.
  afterEach(() => {
    for (const fixture of repositories) {
      makeTreeWritable(fixture.base);
    }
  });

  test("an archived reviewed source restores byte for byte on its recreated branch", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    // The receipt reads the live status first; hash only what the removal sees.
    const receipt = receiptFor(lineage);
    const privateDirectory = privateGitDirectoryOf(lineage.path);
    const before = {
      checkout: scanTree(lineage.path),
      git: scanTree(privateDirectory),
    };

    const report = prune(lineage, receipt);

    expect(report.errors).toEqual([]);
    const archive = reportedArchive(report);
    expect(archive.archiveId).toMatch(ARCHIVE_ID_PATTERN);
    expect(report.reviewedReplacement?.pinRefs[0] ?? "").toMatch(
      HEAD_PIN_PATTERN
    );
    expect(existsSync(lineage.path)).toBe(false);
    expect(existsSync(privateDirectory)).toBe(false);
    expect(branchExists(root, "source-unit")).toBe(false);
    const manifest = readWorktreeArchiveManifest(archive.path);
    expect(manifest).toMatchObject({
      archiveId: archive.archiveId,
      privateGitDirectory: privateDirectory,
      source: {
        branch: "source-unit",
        headSha: lineage.headSha,
        path: lineage.path,
      },
    });

    const restored = restoreLineage(lineage, archive.archiveId);
    // Hashed before any status of the test's own could refresh the index.
    const after = {
      checkout: scanTree(lineage.path),
      git: scanTree(privateDirectory),
    };

    expect(compareTrees(before.checkout, after.checkout)).toEqual([]);
    expect(compareTrees(before.git, after.git)).toEqual([]);
    expect(restored).toMatchObject({
      archiveId: archive.archiveId,
      branch: "source-unit",
      branchCreated: true,
      extracted: false,
      headSha: lineage.headSha,
      path: lineage.path,
    });
    expect(
      parseWorktreeList(git(root, ["worktree", "list", "--porcelain"])).find(
        (worktree) => worktree.path === lineage.path
      )
    ).toMatchObject({ branch: "source-unit", headSha: lineage.headSha });
    expect(git(root, ["rev-parse", "refs/heads/source-unit"])).toBe(
      lineage.headSha
    );
    expect(
      git(lineage.path, ["--no-optional-locks", "status", "--porcelain"])
    ).toBe("");
  });

  test("an autostash the checkout holds is archived, pinned and restored", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const other = git(root, [
      "commit-tree",
      "main^{tree}",
      "-p",
      "main",
      "-m",
      "Diverging work on another branch",
    ]);
    git(root, ["branch", "other", other]);
    writeFixture(lineage.path, "a.ts", "export const a = 'stashed';\n");
    git(lineage.path, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "merge",
      "--squash",
      "--autostash",
      "-s",
      "ours",
      "other",
    ]);
    expect(git(lineage.path, ["status", "--porcelain"])).toBe("");
    const privateDirectory = privateGitDirectoryOf(lineage.path);
    const stash = readFileSync(
      join(privateDirectory, "MERGE_AUTOSTASH"),
      "utf8"
    ).trim();
    expect(git(root, ["cat-file", "-t", stash])).toBe("commit");

    const report = prune(lineage, receiptFor(lineage));

    expect(report.errors).toEqual([]);
    expect(report.reviewedReplacement?.worktreeRemoved).toBe(true);
    const archive = reportedArchive(report);
    expect(
      readFileSync(join(archive.path, "git", "MERGE_AUTOSTASH"), "utf8").trim()
    ).toBe(stash);
    const pin = `refs/simple-changes/archives/${archive.archiveId}/objects/${stash}`;
    expect(report.reviewedReplacement?.pinRefs).toContain(pin);
    expect(git(root, ["rev-parse", pin])).toBe(stash);

    restoreLineage(lineage, archive.archiveId);

    expect(
      readFileSync(join(privateDirectory, "MERGE_AUTOSTASH"), "utf8").trim()
    ).toBe(stash);
  });

  test("a change between the archive copy and the final comparison stops the run and keeps the archive", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const receipt = receiptFor(lineage);

    expectRefusal(
      () =>
        withEnvironment(
          {
            NODE_ENV: "test",
            SIMPLE_CHANGES_TEST_MUTATE_AFTER_ARCHIVE: join(
              lineage.path,
              "a.ts"
            ),
          },
          () => prune(lineage, receipt)
        ),
      STOPPED_PATTERN
    );

    expect(existsSync(lineage.path)).toBe(true);
    expect(worktreePaths(root)).toContain(lineage.path);
    expect(worktreePaths(root)).toContain(lineage.merged);
    expect(branchExists(root, "source-unit")).toBe(true);
    expect(branchExists(root, "merged-unit")).toBe(true);
    expect(readWorktreeCleanups(commonDirectory(root))).toEqual([]);
    const archives = listWorktreeArchives(commonDirectory(root));
    expect(archives).toHaveLength(1);
    const manifest = readWorktreeArchiveManifest(archives[0]?.directory ?? "");
    expect(manifest.source.headSha).toBe(lineage.headSha);
    expect(manifest.pinRefs.length).toBeGreaterThan(0);
    for (const pin of manifest.pinRefs) {
      expect(git(root, ["rev-parse", pin.ref])).toBe(pin.object);
    }
    const completed = lineageRecords(root).find(
      (record) => record.phase === "completed"
    );
    const outcome = completed?.outcome as
      | { errors: string[]; worktreeRemoved: boolean }
      | undefined;
    expect(outcome?.worktreeRemoved).toBe(false);
    expect(outcome?.errors[0] ?? "").toMatch(CHANGED_AFTER_ARCHIVE_PATTERN);
    expect(completed?.archive).toMatchObject({
      archiveId: manifest.archiveId,
    });
  });

  test("an archive over the per-archive size cap is refused before anything is copied", () => {
    const lineage = lineageFixture(false);
    const receipt = receiptFor(lineage);
    expectRefusal(
      () =>
        pruneRepository({
          agentId: CONTROLLER,
          approvedBy: APPROVER,
          dryRun: false,
          lineageReceipt: receipt,
          maxArchiveBytes: 1,
          reason: "Remove the reviewed obsolete source.",
          repositoryPath: lineage.fixture.root,
        }),
      ONE_BYTE_CAP_PATTERN
    );
    expectNothingWritten(lineage);
  });

  test("restore refuses a path that exists again and writes nothing", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const privateDirectory = privateGitDirectoryOf(lineage.path);
    const archive = reportedArchive(prune(lineage, receiptFor(lineage)));
    mkdirSync(lineage.path);

    expectRefusal(
      () => restoreLineage(lineage, archive.archiveId),
      PATH_TAKEN_PATTERN
    );

    expect(existsSync(restoringMarkerPath(archive.path))).toBe(false);
    expect(readdirSync(lineage.path)).toEqual([]);
    expect(existsSync(privateDirectory)).toBe(false);
    expect(branchExists(root, "source-unit")).toBe(false);
    expect(worktreePaths(root)).not.toContain(lineage.path);
  });

  test("restore refuses a branch that now points at another commit and writes nothing", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const privateDirectory = privateGitDirectoryOf(lineage.path);
    const archive = reportedArchive(prune(lineage, receiptFor(lineage)));
    git(root, ["branch", "source-unit", "main"]);

    expectRefusal(
      () => restoreLineage(lineage, archive.archiveId),
      BRANCH_ELSEWHERE_PATTERN
    );

    expect(existsSync(lineage.path)).toBe(false);
    expect(existsSync(privateDirectory)).toBe(false);
    expect(existsSync(restoringMarkerPath(archive.path))).toBe(false);
    expect(git(root, ["rev-parse", "refs/heads/source-unit"])).toBe(
      git(root, ["rev-parse", "main"])
    );
  });

  test("a reviewer who released the author's claim by takeover stays eligible", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const claim = claimWorktree(root, AUTHOR, lineage.path, ADAPTER);
    const current = captureInventory(root).worktrees.find(
      (worktree) => worktree.path === lineage.path
    );
    takeoverWorktreeClaim({
      action: "release",
      approvedBy: APPROVER,
      claimId: claim.claimId,
      expectedBranch: current?.branch ?? null,
      expectedHeadSha: current?.headSha ?? null,
      expectedStatusDigest: current?.changeDigest ?? "",
      newAgentId: REVIEWER,
      reason: "The author's session ended and cannot be contacted.",
      repositoryPath: root,
    });

    const report = prune(lineage, receiptFor(lineage), { dryRun: true });

    expect(report.reviewedReplacement?.path).toBe(lineage.path);
    expectNothingWritten(lineage);
  });

  test("a claim handed over by a takeover the history no longer holds is refused", () => {
    const lineage = lineageFixture(false);
    claimThroughTakeovers(lineage, "former-owner", [AUTHOR]);
    rmSync(worktreeTakeoversPath(commonDirectory(lineage.fixture.root)));

    expectRefusal(
      () => prune(lineage, receiptFor(lineage)),
      MISSING_REASSIGN_PATTERN
    );

    expectNothingWritten(lineage);
  });

  test("a takeover chain whose history is present keeps its earlier owner from reviewing", () => {
    const lineage = lineageFixture(false);
    claimThroughTakeovers(lineage, "former-owner", [AUTHOR]);

    const report = prune(lineage, receiptFor(lineage), { dryRun: true });
    expect(report.reviewedReplacement?.path).toBe(lineage.path);

    const receipt = receiptFor(lineage);
    receipt.review.reviewerAgentId = "former-owner";
    expectRefusal(() => prune(lineage, receipt), REVIEWER_IS_AUTHOR_PATTERN);
    expectNothingWritten(lineage);
  });

  test("the prune command refuses a missing receipt file, naming it, and writes nothing", () => {
    const lineage = lineageFixture(false);
    const missing = "/nonexistent.json";
    expect(existsSync(missing)).toBe(false);
    const result = spawnSync(
      [
        process.execPath,
        CLI_PATH,
        "prune",
        "--agent-id",
        CONTROLLER,
        "--approved-by",
        APPROVER,
        "--lineage-receipt",
        missing,
        "--dry-run",
        "--json",
        "--repo",
        lineage.fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).not.toBe(0);
    const lastLine =
      decoder.decode(result.stderr).trim().split("\n").at(-1) ?? "";
    const failure = JSON.parse(lastLine) as { error: string; ok: boolean };
    expect(failure.ok).toBe(false);
    expect(failure.error).toContain(missing);
    expectNothingWritten(lineage);
  });

  // A value Git can still run with, so the refusal comes from the environment
  // check itself: this repository's own folders for the three variables that
  // locate the repository, an empty folder for the others.
  const redirectFor = (
    lineage: LineageFixture,
    variable: (typeof GIT_ENVIRONMENT_REDIRECTS)[number]
  ): string => {
    const { base, root } = lineage.fixture;
    if (variable === "GIT_DIR") {
      return join(root, ".git");
    }
    if (variable === "GIT_WORK_TREE") {
      return root;
    }
    if (variable === "GIT_COMMON_DIR") {
      return commonDirectory(root);
    }
    const folder = join(base, "redirected");
    mkdirSync(folder, { recursive: true });
    return folder;
  };

  for (const variable of GIT_ENVIRONMENT_REDIRECTS) {
    test(`refuses the reviewed removal while ${variable} is set and writes nothing`, () => {
      const lineage = lineageFixture(false);
      const receipt = receiptFor(lineage);
      const redirect = redirectFor(lineage, variable);
      expectRefusal(
        () =>
          withEnvironment({ [variable]: redirect }, () =>
            prune(lineage, receipt)
          ),
        REDIRECTED_GIT_PATTERN
      );
      expectNothingWritten(lineage);
    });
  }

  // The environment is checked before any Git command runs, so even a
  // redirect that names no repository refuses in plain words.
  for (const variable of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
  ] as const) {
    test(`refuses in plain words while ${variable} names a folder that holds no repository`, () => {
      const lineage = lineageFixture(false);
      const receipt = receiptFor(lineage);
      const redirect = join(lineage.fixture.base, "redirected");
      mkdirSync(redirect);
      expectRefusal(
        () =>
          withEnvironment({ [variable]: redirect }, () =>
            prune(lineage, receipt)
          ),
        REDIRECTED_GIT_PATTERN
      );
      expectNothingWritten(lineage);
    });
  }

  test("a per-worktree ref to a commit nothing else reaches is pinned and restored", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const rescue = git(lineage.path, [
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "HEAD",
      "-m",
      "Work only a per-worktree ref keeps",
    ]);
    git(lineage.path, ["update-ref", "refs/worktree/rescue", rescue]);

    const report = prune(lineage, receiptFor(lineage));

    expect(report.errors).toEqual([]);
    const archive = reportedArchive(report);
    const pin = `refs/simple-changes/archives/${archive.archiveId}/objects/${rescue}`;
    expect(git(root, ["rev-parse", pin])).toBe(rescue);
    expect(existsSync(lineage.path)).toBe(false);

    restoreLineage(lineage, archive.archiveId);

    expect(git(lineage.path, ["rev-parse", "refs/worktree/rescue"])).toBe(
      rescue
    );
  });

  test("a branch description goes with the removed branch and comes back with it", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const key = "branch.source-unit.description";
    git(root, ["config", key, "Keep me"]);

    const archive = reportedArchive(prune(lineage, receiptFor(lineage)));
    expect(configValues(root, key)).toEqual([]);
    expect(readWorktreeArchiveManifest(archive.path).branchConfig).toEqual([
      { key, value: "Keep me" },
    ]);

    restoreLineage(lineage, archive.archiveId);
    expect(configValues(root, key)).toEqual(["Keep me"]);
  });

  test("restore leaves a branch section written after the removal as it is", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const key = "branch.source-unit.description";
    git(root, ["config", key, "Keep me"]);
    const archive = reportedArchive(prune(lineage, receiptFor(lineage)));
    git(root, ["config", key, "Written after the removal"]);

    restoreLineage(lineage, archive.archiveId);

    expect(configValues(root, key)).toEqual(["Written after the removal"]);
  });

  test("the dry run states the archive's size, expiry and retention in force", () => {
    const lineage = lineageFixture(false);
    const now = new Date();
    const plannedArchive = () =>
      prune(lineage, receiptFor(lineage, now.getTime()), { dryRun: true, now })
        .reviewedReplacement?.archive;
    const inDays = (days: number): string =>
      new Date(now.getTime() + days * DAY).toISOString();

    const standard = plannedArchive();
    expect(standard).toMatchObject({
      archiveId: null,
      expiresAt: inDays(14),
      path: null,
      retention: { days: 14, maxTotalBytes: 2 * 1024 ** 3 },
      retentionFallbacks: [],
    });
    expect(standard?.bytes ?? 0).toBeGreaterThan(0);

    writeRetentionPolicy(lineage, { days: 3 });
    expect(plannedArchive()).toMatchObject({
      expiresAt: inDays(3),
      retention: { days: 3 },
      retentionFallbacks: [],
    });

    writeRetentionPolicy(lineage, { days: 0 });
    const fallback = plannedArchive();
    expect(fallback).toMatchObject({
      expiresAt: inDays(14),
      retention: { days: 14 },
    });
    expect(fallback?.retentionFallbacks).toHaveLength(1);
    expect(fallback?.retentionFallbacks[0] ?? "").toMatch(
      DAYS_FALLBACK_PATTERN
    );
    expectNothingWritten(lineage);
  });

  test("the removed checkout leaves the inventory and both records name the archive and its pins", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const report = prune(lineage, receiptFor(lineage));
    const outcome = report.reviewedReplacement;
    const archive = reportedArchive(report);
    const namespace = `refs/simple-changes/archives/${archive.archiveId}/`;

    expect(worktreePaths(root)).not.toContain(lineage.path);
    expect(outcome?.pinRefs.length ?? 0).toBeGreaterThan(0);
    const records = lineageRecords(root);
    expect(
      records
        .map((record) => String(record.phase))
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(["completed", "intent"]);
    for (const record of records) {
      validateSchema("replacement-lineage-removal", record);
      expect(record.archive).toMatchObject({
        archiveId: archive.archiveId,
        bytes: outcome?.archive.bytes,
        expiresAt: outcome?.archive.expiresAt,
        path: archive.path,
      });
      const pins = record.pinRefs as ArchivePinRef[];
      expect(pins.length).toBeGreaterThan(0);
      expect(pins.every((pin) => pin.ref.startsWith(namespace))).toBe(true);
      expect(pins.map((pin) => pin.ref)).toEqual(outcome?.pinRefs ?? []);
      expect(pins).toContainEqual({
        object: lineage.headSha,
        ref: `${namespace}head`,
      });
    }
  });

  // Automatic pruning runs at the end of a successful run, so a refusal
  // earlier in the run prunes nothing.
  test("a reviewed removal the boundary refuses prunes no expired archive", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    // A removal approved 15 days ago left an archive that has now expired.
    const past = new Date(Date.now() - 15 * DAY);
    const first = reportedArchive(
      prune(lineage, receiptFor(lineage, past.getTime()), { now: past })
    );
    restoreLineage(lineage, first.archiveId);
    git(root, ["config", "filter.a=b.clean", "cat"]);

    expectRefusal(
      () => prune(lineage, receiptFor(lineage)),
      UNOVERRIDABLE_PATTERN
    );

    expect(existsSync(first.path)).toBe(true);
    expect(readArchivePruneLog(commonDirectory(root))).toEqual([]);
  });

  test("a valueless branch setting is restored with its meaning", () => {
    const lineage = lineageFixture(false);
    const { root } = lineage.fixture;
    const config = join(commonDirectory(root), "config");
    writeFileSync(
      config,
      `${readFileSync(config, "utf8")}[branch "source-unit"]\n\trebase\n`
    );
    expect(git(root, ["config", "--bool", "branch.source-unit.rebase"])).toBe(
      "true"
    );
    const archive = reportedArchive(prune(lineage, receiptFor(lineage)));
    expect(configValues(root, "branch.source-unit.rebase")).toEqual([]);
    expect(
      readWorktreeArchiveManifest(archive.path).branchConfig
    ).toContainEqual({ key: "branch.source-unit.rebase", value: null });
    restoreLineage(lineage, archive.archiveId);
    expect(git(root, ["config", "--bool", "branch.source-unit.rebase"])).toBe(
      "true"
    );
  });

  test("a restore that refuses keeps the marker an earlier restore left", () => {
    const lineage = lineageFixture(false);
    const archive = reportedArchive(prune(lineage, receiptFor(lineage)));
    const marker = restoringMarkerPath(archive.path);
    writeFileSync(marker, `${JSON.stringify({ pid: 1, startedAt: STAMP })}\n`);
    mkdirSync(lineage.path);
    expectRefusal(
      () => restoreLineage(lineage, archive.archiveId),
      PATH_EXISTS_PATTERN
    );
    expect(existsSync(marker)).toBe(true);
  });

  test("a manifest that cannot be written leaves no archive and no pins", () => {
    const lineage = lineageFixture(false);
    const receipt = receiptFor(lineage);
    expectRefusal(
      () =>
        withEnvironment(
          {
            NODE_ENV: "test",
            SIMPLE_CHANGES_TEST_FAIL_ARCHIVE_MANIFEST: lineage.path,
          },
          () => prune(lineage, receipt)
        ),
      NO_ARCHIVE_PATTERN
    );
    const { root } = lineage.fixture;
    expect(worktreePaths(root)).toContain(lineage.path);
    expect(pinRefs(root)).toBe("");
    expect(listWorktreeArchives(commonDirectory(root))).toEqual([]);
    expect(readWorktreeCleanups(commonDirectory(root))).toEqual([]);
  });

  test("a restore that refuses has refreshed no live index", () => {
    const lineage = lineageFixture(false);
    const archive = reportedArchive(prune(lineage, receiptFor(lineage)));
    const { root } = lineage.fixture;
    // The primary checkout's index needs a stat refresh, which an ordinary
    // status would write back.
    const future = new Date(Date.now() + 365 * 24 * 60 * MINUTE);
    utimesSync(join(root, "README.md"), future, future);
    const indexPath = join(commonDirectory(root), "index");
    const before = readFileSync(indexPath);
    mkdirSync(lineage.path);
    expectRefusal(
      () => restoreLineage(lineage, archive.archiveId),
      PATH_EXISTS_PATTERN
    );
    expect(readFileSync(indexPath).equals(before)).toBe(true);
  });

  test("worktree archives names a restore marker it cannot read", () => {
    const lineage = lineageFixture(false);
    const archive = reportedArchive(prune(lineage, receiptFor(lineage)));
    writeFileSync(restoringMarkerPath(archive.path), "{}\n");
    const result = spawnSync(
      [
        process.execPath,
        CLI_PATH,
        "worktree",
        "archives",
        "--repo",
        lineage.fixture.root,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).toBe(0);
    expect(decoder.decode(result.stdout)).toMatch(MARKER_UNREADABLE_PATTERN);
  });
});
