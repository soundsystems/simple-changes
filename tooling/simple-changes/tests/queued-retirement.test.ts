import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  finalizeLoop,
  prepareAgentWorktree,
  readLoopLease,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import type {
  QueuedRetirementHooks,
  QueuedRetirementReport,
} from "../../../skills/simple-changes/scripts/lib/queued-retirement.ts";
import {
  type QueuedWorktreesRecord,
  queuedTargetBinding,
} from "../../../skills/simple-changes/scripts/lib/queued-worktrees.ts";
import type { RequestMode } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const fixtures: TestRepository[] = [];
setDefaultTimeout(120_000);
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
});

const REGISTRATION_ID = /^[0-9a-f-]{36}$/u;
const NO_REVIEWS = "The shared folder remote has no reviews.";
const APP = 'def greet():\n    print("hello")\n';
const QUEUED_LINE = '    print("queued")\n';

interface Project extends TestRepository {
  remote: string;
}

/**
 * A project as a newcomer has it: a pushed main branch that tracks a link
 * and ignores `.env.local`, with `origin` as its one remote.
 */
const createProject = (): Project => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  writeFixture(
    fixture.root,
    ".gitignore",
    ".env.local\nnode_modules/\n*.log\n"
  );
  writeFixture(fixture.root, "app.py", APP);
  symlinkSync("README.md", join(fixture.root, "README.link"));
  git(fixture.root, ["add", ".gitignore", "app.py", "README.link"]);
  git(fixture.root, ["commit", "-m", "Project files"]);
  const remote = join(fixture.base, "remote.git");
  git(fixture.base, ["init", "--bare", "-b", "main", remote]);
  git(fixture.root, ["remote", "add", "origin", remote]);
  git(fixture.root, ["push", "-u", "origin", "main:main"]);
  git(fixture.root, ["remote", "set-head", "origin", "main"]);
  return { ...fixture, remote };
};

interface Started {
  lease: ReturnType<typeof startLoop>;
  /** Undefined when the start did not run the clean-up at all. */
  report: QueuedRetirementReport | undefined;
}

const start = (
  project: Project,
  agentId: string,
  mode: RequestMode = "queue",
  hooks?: QueuedRetirementHooks,
  from = project.root
): Started => {
  const seen: { report?: QueuedRetirementReport } = {};
  const lease = startLoop(from, agentId, mode, undefined, {
    onQueuedRetirement: (report) => {
      seen.report = report;
    },
    ...(hooks ? { queuedRetirementHooks: hooks } : {}),
  });
  return { lease, report: seen.report };
};

interface PutUpOptions {
  contents?: string;
  file?: string;
  remote?: string;
}

/**
 * One finished "put my change up": a Queue run that packages an edit in its
 * own worktree, pushes the branch, and closes queued for review, keeping
 * the worktree.
 */
const putUp = (
  project: Project,
  name: string,
  {
    contents = `${APP}${QUEUED_LINE}`,
    file = "app.py",
    remote = "origin",
  }: PutUpOptions = {}
) => {
  const { lease } = start(project, `controller-${name}`);
  const prepared = prepareAgentWorktree(
    project.root,
    lease.runId,
    `author-${name}`,
    `put up ${name}`
  );
  writeFixture(prepared.path, file, contents);
  git(prepared.path, ["add", file]);
  git(prepared.path, ["commit", "-m", `Put up ${name}`]);
  git(prepared.path, [
    "push",
    "-u",
    remote,
    `${prepared.branch}:${prepared.branch}`,
  ]);
  const closed = finalizeLoop(
    project.root,
    lease.runId,
    `controller-${name}`,
    "The change is up for review.",
    { noProposal: NO_REVIEWS }
  );
  expect(closed.blockers).toEqual([]);
  expect(closed.outcome).toBe("completed");
  return {
    ...prepared,
    closed,
    head: git(prepared.path, ["rev-parse", "HEAD"]),
    runId: lease.runId,
  };
};

type Copy = ReturnType<typeof putUp>;

let clones = 0;

/**
 * A reviewer lands something on the remote's main. The project then
 * fetches, unless the test leaves this machine behind the remote.
 */
const landOnRemote = (
  project: Project,
  land: (clone: string) => void,
  remote = project.remote,
  fetch = true
): void => {
  clones += 1;
  const clone = join(project.base, `reviewer-${clones}`);
  git(project.base, ["clone", remote, clone]);
  git(clone, ["config", "user.name", "A Reviewer"]);
  git(clone, ["config", "user.email", "reviewer@simple-changes.invalid"]);
  land(clone);
  git(clone, ["push", "origin", "main:main"]);
  if (fetch) {
    git(project.root, ["fetch", "--all"]);
  }
};

const mergeBranches = (project: Project, ...copies: Copy[]): void =>
  landOnRemote(project, (clone) => {
    for (const copy of copies) {
      git(clone, [
        "merge",
        "--no-ff",
        "-m",
        `Merge ${copy.branch}`,
        `origin/${copy.branch}`,
      ]);
    }
  });

/** A squash merge, optionally edited in review before it lands. */
const squashMerge = (
  project: Project,
  copy: Copy,
  edit?: (clone: string) => void
): void =>
  landOnRemote(project, (clone) => {
    git(clone, ["merge", "--squash", `origin/${copy.branch}`]);
    edit?.(clone);
    git(clone, ["commit", "-m", `Squash ${copy.branch}`]);
  });

const recordPath = (project: Project, runId: string): string =>
  join(
    project.root,
    ".git",
    "simple-changes",
    "queued-worktrees",
    `${runId}.json`
  );

const readRecord = (project: Project, runId: string): QueuedWorktreesRecord =>
  JSON.parse(
    readFileSync(recordPath(project, runId), "utf8")
  ) as QueuedWorktreesRecord;

const privateGitDirectory = (copy: Copy): string =>
  git(copy.path, ["rev-parse", "--absolute-git-dir"]);

const branchExists = (project: Project, branch: string): boolean =>
  spawnSync([
    "git",
    "-C",
    project.root,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).exitCode === 0;

const NOTHING: QueuedRetirementReport = { kept: [], notes: [], removed: [] };

const ignoredMessage = (copy: Copy, names: string): string =>
  `This copy holds files Git ignores (${names}), so I left it in place. Remove it by hand, or with computer use, once you have what you need from them: ${copy.path}`;

/** The copy is exactly as the run left it, branch and all. */
const expectKept = (project: Project, copy: Copy): void => {
  expect(existsSync(copy.path)).toBe(true);
  expect(git(copy.path, ["rev-parse", "HEAD"])).toBe(copy.head);
  expect(git(project.root, ["rev-parse", copy.branch])).toBe(copy.head);
};

describe("what a closed Queue run records about the worktree it kept", () => {
  test("its branch, its target as one ref on one remote address, and an ID written into its private Git directory", () => {
    const project = createProject();
    const copy = putUp(project, "one");

    const record = readRecord(project, copy.runId);

    const id = readFileSync(
      join(privateGitDirectory(copy), "simple-changes-queued-worktree"),
      "utf8"
    ).trim();
    expect(id).toMatch(REGISTRATION_ID);
    expect(record).toMatchObject({
      kind: "queued-worktrees",
      mode: "queue",
      runId: copy.runId,
      schemaVersion: 1,
      worktrees: [
        {
          branch: copy.branch,
          path: copy.path,
          registrationId: id,
          target: {
            ref: "refs/heads/main",
            remote: "origin",
            url: project.remote,
          },
        },
      ],
    });
    expect(copy.closed.receipt.queued?.summary).toContain(
      "A later Queue or Sweep run clears a kept worktree by itself once the remote confirms its work is merged and nothing in it exists only there."
    );
    // Recording changes nothing Git tracks or reports.
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");
  });

  test("a target with more than one remote address is not bound, so its worktrees are never cleared", () => {
    const project = createProject();
    git(project.root, [
      "remote",
      "set-url",
      "--add",
      "origin",
      join(project.base, "mirror.git"),
    ]);

    expect(queuedTargetBinding(project.root, "origin/main")).toEqual({
      unbound: "origin does not have exactly one address to ask",
    });
    expect(queuedTargetBinding(project.root, "main")).toEqual({
      unbound: "main is not a branch on a remote",
    });
  });
});

describe("a Queue start clears an earlier run's merged worktree", () => {
  test("merged by ancestry and clean is removed with its branch", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);

    const { lease, report } = start(project, "next");

    expect(report).toEqual({
      kept: [],
      notes: [],
      removed: [
        {
          branch: copy.branch,
          branchDeleted: true,
          headSha: copy.head,
          path: copy.path,
          proof: "target-contained",
          target: {
            ref: "refs/heads/main",
            revision: git(project.remote, ["rev-parse", "main"]),
            url: project.remote,
          },
        },
      ],
    });
    expect(existsSync(copy.path)).toBe(false);
    expect(branchExists(project, copy.branch)).toBe(false);
    // The record is gone with its last worktree, and the new run's baseline
    // was taken after the removal.
    expect(existsSync(recordPath(project, copy.runId))).toBe(false);
    expect(lease.worktrees.map((item) => item.path)).toEqual([project.root]);
    expect(
      (lease.openingBranches ?? []).map((item) => item.name)
    ).not.toContain(copy.branch);
    // The remote branch and the merged work are untouched.
    expect(git(project.remote, ["rev-parse", copy.branch])).toBe(copy.head);
  });

  test("a Sweep start clears it as a Queue start does", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);

    const { report } = start(project, "sweeper", "sweep");

    expect(report?.removed).toMatchObject([
      { branchDeleted: true, path: copy.path, proof: "target-contained" },
    ]);
    expect(existsSync(copy.path)).toBe(false);
  });

  test("squash merge with identical bytes is removed", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    squashMerge(project, copy);
    // Not an ancestor: only the bytes match.
    expect(
      spawnSync([
        "git",
        "-C",
        project.root,
        "merge-base",
        "--is-ancestor",
        copy.head,
        "origin/main",
      ]).exitCode
    ).toBe(1);

    const { report } = start(project, "next");

    expect(report?.kept).toEqual([]);
    expect(report?.removed).toMatchObject([
      {
        branch: copy.branch,
        branchDeleted: true,
        path: copy.path,
        proof: "exact-byte-target",
      },
    ]);
    expect(existsSync(copy.path)).toBe(false);
    expect(branchExists(project, copy.branch)).toBe(false);
  });

  test("squash merge edited in review, with the same patch shape but different indentation, is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    squashMerge(project, copy, (clone) => {
      // The reviewer's version adds the same statement one level deeper.
      writeFixture(clone, "app.py", `${APP}    ${QUEUED_LINE}`);
      git(clone, ["add", "app.py"]);
    });

    const { report } = start(project, "next");

    // Its exact bytes are not in the target, so it reads as not merged.
    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
    expect(readFileSync(join(copy.path, "app.py"), "utf8")).toBe(
      `${APP}${QUEUED_LINE}`
    );
  });

  test("an unmerged queued copy is kept silently, and the report still arrives", () => {
    const project = createProject();
    const copy = putUp(project, "one");

    const { report } = start(project, "next");

    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
    expect(readRecord(project, copy.runId).worktrees).toHaveLength(1);
  });
});

describe("a merged worktree that still holds something is kept", () => {
  test("an ignored .env.local is kept with the message", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    writeFixture(copy.path, ".env.local", "SECRET=only-here\n");
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");
    mergeBranches(project, copy);

    const { report } = start(project, "next");

    expect(report).toEqual({
      kept: [{ path: copy.path, reason: ignoredMessage(copy, ".env.local") }],
      notes: [],
      removed: [],
    });
    expectKept(project, copy);
    expect(readFileSync(join(copy.path, ".env.local"), "utf8")).toBe(
      "SECRET=only-here\n"
    );
  });

  test("ignored files and folders are named, up to five, and an ignored folder is not looked into", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      writeFixture(copy.path, `${name}.log`, "");
    }
    mergeBranches(project, copy);

    expect(start(project, "next").report?.kept).toEqual([
      {
        path: copy.path,
        reason: ignoredMessage(copy, "a.log, b.log, c.log, d.log, e.log"),
      },
    ]);
    expectKept(project, copy);

    const packages = createProject();
    const installed = putUp(packages, "one");
    writeFixture(installed.path, "node_modules/left-pad/index.js", "");
    mergeBranches(packages, installed);

    expect(start(packages, "next").report?.kept).toEqual([
      {
        path: installed.path,
        reason: ignoredMessage(installed, "node_modules/"),
      },
    ]);
    expectKept(packages, installed);
  });

  test("an assume-unchanged edit is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    git(copy.path, ["update-index", "--assume-unchanged", "README.md"]);
    writeFixture(
      copy.path,
      "README.md",
      "# Fixture\n\nTyped after the push.\n"
    );
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");

    const { report } = start(project, "next");

    expect(report?.removed).toEqual([]);
    expect(report?.kept).toEqual([
      {
        path: copy.path,
        reason: `This copy holds changes Git's status does not show (README.md), so I left it in place: ${copy.path}`,
      },
    ]);
    expectKept(project, copy);
    expect(readFileSync(join(copy.path, "README.md"), "utf8")).toContain(
      "Typed after the push."
    );
  });

  test("a skip-worktree edit is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    git(copy.path, ["update-index", "--skip-worktree", "app.py"]);
    writeFixture(copy.path, "app.py", "# rewritten locally\n");
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");

    const { report } = start(project, "next");

    expect(report?.removed).toEqual([]);
    expect(report?.kept[0]?.reason).toBe(
      `This copy holds changes Git's status does not show (app.py), so I left it in place: ${copy.path}`
    );
    expectKept(project, copy);
  });

  test("an interrupted multi-commit cherry-pick, with a sequencer directory and clean status, is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    // Two commits to pick; the first conflicts with the copy's own edit.
    git(project.root, ["branch", "side", "main"]);
    const side = join(project.base, "side");
    git(project.root, ["worktree", "add", side, "side"]);
    writeFixture(side, "app.py", `${APP}    print("side")\n`);
    git(side, ["commit", "-am", "Side one"]);
    writeFixture(side, "notes.txt", "Side two\n");
    git(side, ["add", "notes.txt"]);
    git(side, ["commit", "-m", "Side two"]);
    const picks = [
      git(side, ["rev-parse", "HEAD~1"]),
      git(side, ["rev-parse", "HEAD"]),
    ];
    git(project.root, ["worktree", "remove", side]);
    git(project.root, ["branch", "-D", "side"]);
    expect(
      spawnSync(["git", "-C", copy.path, "cherry-pick", ...picks]).exitCode
    ).not.toBe(0);
    // The owner backs out of the conflict; the remaining pick stays queued
    // in the worktree's private Git directory.
    git(copy.path, ["reset", "--hard"]);
    const gitDirectory = privateGitDirectory(copy);
    expect(existsSync(join(gitDirectory, "sequencer"))).toBe(true);
    expect(existsSync(join(gitDirectory, "CHERRY_PICK_HEAD"))).toBe(false);
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");
    expect(git(copy.path, ["rev-parse", "HEAD"])).toBe(copy.head);

    const { report } = start(project, "next");

    expect(report?.removed).toEqual([]);
    expect(report?.kept).toEqual([
      {
        path: copy.path,
        reason: `This copy has an unfinished Git operation, so I left it in place: ${copy.path}`,
      },
    ]);
    expectKept(project, copy);
    expect(existsSync(join(gitDirectory, "sequencer"))).toBe(true);
  });

  test("uncommitted work in a merged copy is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    writeFixture(copy.path, "draft.txt", "A follow-up idea.\n");

    const { report } = start(project, "next");

    expect(report?.kept).toEqual([
      {
        path: copy.path,
        reason: `This copy has changes that are not saved in a commit, so I left it in place: ${copy.path}`,
      },
    ]);
    expectKept(project, copy);
  });

  test("the copy the command itself runs in is never removed", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);

    const { report } = start(project, "next", "queue", undefined, copy.path);

    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
  });
});

describe("every check runs for one worktree immediately before it is removed", () => {
  test("a file written into an already-checked copy before its removal is caught", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    const checked: string[] = [];

    const { report } = start(project, "next", "queue", {
      // The copy has passed every earlier check and the remover's own
      // re-read; an editor or build writes into it now.
      beforeLastChecks: (path) => {
        checked.push(path);
        writeFixture(path, ".env.local", "WRITTEN=late\n");
      },
    });

    expect(checked).toEqual([copy.path]);
    expect(report).toEqual({
      kept: [{ path: copy.path, reason: ignoredMessage(copy, ".env.local") }],
      notes: [],
      removed: [],
    });
    expectKept(project, copy);
    expect(existsSync(join(copy.path, ".env.local"))).toBe(true);
  });

  test("an edit Git's status does not show, made into an already-checked copy, is caught", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    git(copy.path, ["update-index", "--assume-unchanged", "README.md"]);

    const { report } = start(project, "next", "queue", {
      beforeLastChecks: (path) =>
        writeFixture(path, "README.md", "# Fixture\n\nTyped late.\n"),
    });

    expect(report?.removed).toEqual([]);
    expect(report?.kept[0]?.reason).toContain(
      "holds changes Git's status does not show (README.md)"
    );
    expectKept(project, copy);
  });

  test("each copy is checked and removed before the next is looked at, so a file written into the second while the first is cleared keeps the second", () => {
    const project = createProject();
    const first = putUp(project, "first", {
      contents: "First.\n",
      file: "first.txt",
    });
    const second = putUp(project, "second", {
      contents: "Second.\n",
      file: "second.txt",
    });
    mergeBranches(project, first, second);
    const firstExistedAtSecondCheck: boolean[] = [];

    const { report } = start(project, "next", "queue", {
      beforeLastChecks: (path) => {
        if (path === first.path) {
          writeFixture(second.path, ".env.local", "WRITTEN=meanwhile\n");
        } else {
          firstExistedAtSecondCheck.push(existsSync(first.path));
        }
      },
    });

    expect(report?.removed.map((item) => item.path)).toEqual([first.path]);
    expect(report?.kept).toEqual([
      { path: second.path, reason: ignoredMessage(second, ".env.local") },
    ]);
    // The first was already gone when the second's own checks began.
    expect(firstExistedAtSecondCheck).toEqual([false]);
    expect(existsSync(first.path)).toBe(false);
    expectKept(project, second);
  });
});

describe("the proof is about the recorded target on the recorded remote", () => {
  test("a record for target upstream/main is not satisfied by origin/main containing the head", () => {
    const project = createProject();
    // `origin` is the person's fork; `upstream` is the project they propose to.
    const upstream = join(project.base, "upstream.git");
    git(project.base, ["clone", "--bare", project.remote, upstream]);
    git(project.root, ["remote", "add", "upstream", upstream]);
    git(project.root, ["fetch", "upstream"]);
    git(project.root, ["branch", "-u", "upstream/main", "main"]);
    git(project.root, ["remote", "set-head", "upstream", "main"]);
    expect(captureInventory(project.root).targetRef).toBe("upstream/main");
    const copy = putUp(project, "one");
    expect(readRecord(project, copy.runId).worktrees[0]?.target).toEqual({
      ref: "refs/heads/main",
      remote: "upstream",
      url: upstream,
    });
    // The fork's main takes the work; the project's main does not.
    mergeBranches(project, copy);
    // A later run selects the fork as its target.
    git(project.root, ["branch", "-u", "origin/main", "main"]);
    git(project.root, ["remote", "set-head", "upstream", "--delete"]);
    expect(captureInventory(project.root).targetRef).toBe("origin/main");
    expect(
      spawnSync([
        "git",
        "-C",
        project.root,
        "merge-base",
        "--is-ancestor",
        copy.head,
        "origin/main",
      ]).exitCode
    ).toBe(0);

    const forkTargeted = start(project, "next");

    expect(forkTargeted.report).toEqual(NOTHING);
    expectKept(project, copy);

    // Once the project itself has the work, the same record clears it.
    expect(
      finalizeLoop(
        project.root,
        forkTargeted.lease.runId,
        "next",
        "Nothing to put up."
      ).outcome
    ).toBe("completed");
    landOnRemote(
      project,
      (clone) => git(clone, ["pull", "--no-rebase", project.remote, "main"]),
      upstream
    );
    const { report } = start(project, "after");
    expect(report?.removed).toMatchObject([
      { path: copy.path, target: { url: upstream } },
    ]);
    expect(existsSync(copy.path)).toBe(false);
  });

  test("work merged on the remote that this machine has not fetched yet is cleared, and no local ref moves", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    landOnRemote(
      project,
      (clone) =>
        git(clone, [
          "merge",
          "--no-ff",
          "-m",
          "Merge",
          `origin/${copy.branch}`,
        ]),
      project.remote,
      false
    );
    const refs = () =>
      git(project.root, ["for-each-ref", "--format=%(refname) %(objectname)"])
        .split("\n")
        .filter((line) => !line.startsWith(`refs/heads/${copy.branch} `));
    const before = refs();
    const merged = git(project.remote, ["rev-parse", "main"]);
    expect(before.join("\n")).not.toContain(merged);

    const { lease, report } = start(project, "next");

    expect(report?.notes).toEqual([]);
    expect(report?.removed).toMatchObject([
      {
        path: copy.path,
        proof: "target-contained",
        target: { revision: merged },
      },
    ]);
    expect(existsSync(copy.path)).toBe(false);
    // Only the target's commits arrived: every other ref is where it was,
    // and the run's own target is still the one this machine had.
    expect(refs()).toEqual(before);
    expect(existsSync(join(project.root, ".git", "FETCH_HEAD"))).toBe(false);
    expect(lease.targetRevision).toBe(
      git(project.root, ["rev-parse", "origin/main"])
    );
    expect(lease.targetRevision).not.toBe(merged);
  });

  test("a stale local tracking ref with a rewound remote keeps the copy", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    const before = git(project.remote, ["rev-parse", "main"]);
    mergeBranches(project, copy);
    // The merge is taken back on the server; this machine has not fetched.
    git(project.remote, ["update-ref", "refs/heads/main", before]);
    expect(
      spawnSync([
        "git",
        "-C",
        project.root,
        "merge-base",
        "--is-ancestor",
        copy.head,
        "origin/main",
      ]).exitCode
    ).toBe(0);

    const { report } = start(project, "next");

    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
  });

  test("a remote that is unreachable keeps the copy", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    renameSync(project.remote, `${project.remote}.away`);

    const { lease, report } = start(project, "next");

    expect(report?.removed).toEqual([]);
    expect(report?.kept).toEqual([]);
    expect(report?.notes).toHaveLength(1);
    expect(report?.notes[0]).toContain(
      `I could not ask ${project.remote} what has been merged`
    );
    expect(report?.notes[0]).toContain(
      "so earlier copies that wait on it were left in place."
    );
    expect(report?.notes[0]).not.toContain("\n");
    expectKept(project, copy);
    // The run itself starts all the same.
    expect(readLoopLease(project.root)?.runId).toBe(lease.runId);
  });

  test("a remote that stops answering between the first look and the removal keeps the copy", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);

    const { report } = start(project, "next", "queue", {
      beforeLastChecks: () =>
        renameSync(project.remote, `${project.remote}.away`),
    });

    expect(report?.removed).toEqual([]);
    expect(report?.kept).toEqual([
      {
        path: copy.path,
        reason: `I could not confirm with ${project.remote} that this copy's work is still in the project, so I left it in place: ${copy.path}`,
      },
    ]);
    expectKept(project, copy);
  });
});

describe("the record must be this registration's, with its binding", () => {
  test("a checkout recreated at the same path and branch is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    git(project.root, ["worktree", "remove", copy.path]);
    git(project.root, ["worktree", "add", copy.path, copy.branch]);
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");

    const { report } = start(project, "next");

    // Another registration: never removed on the old record, which is
    // dropped without a word.
    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
    expect(existsSync(recordPath(project, copy.runId))).toBe(false);
  });

  test("a record without the new binding is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    const record = readRecord(project, copy.runId);
    const [worktree] = record.worktrees;
    const withoutBinding = [
      // The shape an unreleased build wrote: path and branch only.
      { branch: copy.branch, path: copy.path },
      { ...worktree, target: undefined },
      { ...worktree, registrationId: undefined },
      { ...worktree, target: { ...worktree?.target, url: undefined } },
    ];
    for (const [index, stripped] of withoutBinding.entries()) {
      writeFileSync(
        recordPath(project, copy.runId),
        `${JSON.stringify({ ...record, worktrees: [stripped] }, null, 2)}\n`
      );

      const started = start(project, `next-${index}`);

      expect(started.report).toEqual(NOTHING);
      expectKept(project, copy);
      expect(
        finalizeLoop(
          project.root,
          started.lease.runId,
          started.lease.ownerAgentId,
          "Nothing to put up."
        ).outcome
      ).toBe("completed");
    }
  });
});

describe("clearing never runs outside a validated fresh Queue or Sweep start", () => {
  test("a failed start validation removes nothing", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    // The target now reads as GitLab, whose starts need an opening
    // inventory this start does not carry.
    git(project.root, [
      "remote",
      "set-url",
      "--push",
      "origin",
      join(project.base, "gitlab", "project.git"),
    ]);

    expect(() => start(project, "next")).toThrow("opening remote inventory");

    expectKept(project, copy);
    expect(readRecord(project, copy.runId).worktrees).toHaveLength(1);
    expect(readLoopLease(project.root)).toBeNull();

    // The same repository, once the start is valid, clears it.
    git(project.root, ["config", "--unset", "remote.origin.pushurl"]);
    expect(start(project, "next").report?.removed).toMatchObject([
      { path: copy.path },
    ]);
  });

  test("a start refused because another run is active removes nothing", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    const active = start(project, "holder");
    mergeBranches(project, copy);

    expect(() => start(project, "second")).toThrow("already active");
    // Starting the same run again returns it and clears nothing either.
    expect(start(project, "holder").report).toBeUndefined();

    expectKept(project, copy);
    expect(readLoopLease(project.root)?.runId).toBe(active.lease.runId);
  });

  for (const mode of ["integrate", "ship"] as const) {
    test(`a ${mode} start in the same repository behaves as before: it clears nothing and registers the kept worktree`, () => {
      const project = createProject();
      const copy = putUp(project, "one");
      mergeBranches(project, copy);

      const { lease, report } = start(project, "shipper", mode);

      expect(report).toBeUndefined();
      expectKept(project, copy);
      expect(readRecord(project, copy.runId).worktrees).toHaveLength(1);
      expect(
        lease.worktrees.find((item) => item.path === copy.path)
      ).toMatchObject({
        branch: copy.branch,
        createdByRun: false,
        role: "preserved",
      });
      expect((lease.openingBranches ?? []).map((item) => item.name)).toContain(
        copy.branch
      );
    });
  }
});

describe("the command line", () => {
  const cli = (project: Project, args: string[]) => {
    const result = spawnSync(
      [process.execPath, cliPath, ...args, "--repo", project.root],
      { env: { ...process.env }, stderr: "pipe", stdout: "pipe" }
    );
    return {
      exitCode: result.exitCode,
      stderr: decoder.decode(result.stderr),
      stdout: decoder.decode(result.stdout),
    };
  };
  const startArguments = (agentId: string) => [
    "loop",
    "start",
    "--mode",
    "queue",
    "--agent-id",
    agentId,
  ];

  test("reports the report as earlierQueuedWorktrees even when nothing was removed", () => {
    const project = createProject();
    putUp(project, "one");

    const started = cli(project, [...startArguments("next"), "--json"]);

    expect(started.exitCode).toBe(0);
    expect(
      (JSON.parse(started.stdout) as { earlierQueuedWorktrees: unknown })
        .earlierQueuedWorktrees
    ).toEqual(NOTHING);
  });

  test("says in plain words what it cleared and what it left", () => {
    const project = createProject();
    const cleared = putUp(project, "cleared", {
      contents: "Cleared.\n",
      file: "cleared.txt",
    });
    const left = putUp(project, "left", {
      contents: "Left.\n",
      file: "left.txt",
    });
    writeFixture(left.path, ".env.local", "SECRET=only-here\n");
    mergeBranches(project, cleared, left);

    const started = cli(project, startArguments("next"));

    expect(started.stderr).toBe("");
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain(
      `Cleared an earlier copy whose work is now in the project, with its branch ${cleared.branch}: ${cleared.path}\n`
    );
    expect(started.stdout).toContain(`${ignoredMessage(left, ".env.local")}\n`);
    expect(existsSync(cleared.path)).toBe(false);
    expect(existsSync(left.path)).toBe(true);
  });
});
