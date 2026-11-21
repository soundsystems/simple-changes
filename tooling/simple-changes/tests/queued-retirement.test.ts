import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  finalizeLoop,
  prepareAgentWorktree,
  readLoopLease,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  MOVED_GIT_DIRECTORY,
  type QueuedRetirementHooks,
  type QueuedRetirementReport,
} from "../../../skills/simple-changes/scripts/lib/queued-retirement.ts";
import {
  moveToTrash,
  systemTrashMover,
  type TrashMover,
} from "../../../skills/simple-changes/scripts/lib/queued-trash.ts";
import {
  type QueuedWorktreesRecord,
  queuedTargetBinding,
  safeTargetAddress,
} from "../../../skills/simple-changes/scripts/lib/queued-worktrees.ts";
import type {
  RepositoryInventory,
  RequestMode,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// This file moves folders "to the Trash". However it is run, with the
// preload or without it, that is a private temporary folder: the variable
// is set here as well, before any test starts, and every command line a
// test starts inherits it. No test here can reach the real Trash.
const TRASH_VARIABLE = "SIMPLE_CHANGES_TRASH_DIR";
const environmentTrash = realpathSync(
  mkdtempSync(join(tmpdir(), "simple-changes-test-trash-"))
);
process.env[TRASH_VARIABLE] = environmentTrash;

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
  // Only this file's own stand-in folder is emptied.
  for (const name of readdirSync(environmentTrash)) {
    rmSync(join(environmentTrash, name), { force: true, recursive: true });
  }
});

const REGISTRATION_ID = /^[0-9a-f-]{36}$/u;
const REGISTRATION_FILE = "simple-changes-queued-worktree";
const NO_REVIEWS = "The shared folder remote has no reviews.";
const APP = 'def greet():\n    print("hello")\n';
const QUEUED_LINE = '    print("queued")\n';
const DAY_MS = 86_400_000;

interface Project extends TestRepository {
  remote: string;
  /** This project's own stand-in for the Trash. */
  trash: string;
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
  return { ...fixture, remote, trash: join(fixture.base, "Trash") };
};

/** A Trash that is one folder: a move is one rename into it. */
const folderTrash =
  (directory: string): TrashMover =>
  (path) => {
    mkdirSync(directory, { recursive: true });
    const location = join(directory, basename(path));
    renameSync(path, location);
    return { location, moved: true };
  };

interface Started {
  lease: ReturnType<typeof startLoop>;
  /** Undefined when the start did not look at earlier copies at all. */
  report: QueuedRetirementReport | undefined;
}

interface StartOptions {
  from?: string;
  hooks?: QueuedRetirementHooks;
  mode?: RequestMode;
  readInventoryAfterRetirement?: (path: string) => RepositoryInventory;
}

const start = (
  project: Project,
  agentId: string,
  { from = project.root, hooks, mode = "queue", ...rest }: StartOptions = {}
): Started => {
  const seen: { report?: QueuedRetirementReport } = {};
  const lease = startLoop(from, agentId, mode, undefined, {
    onQueuedRetirement: (report) => {
      seen.report = report;
    },
    queuedRetirementHooks: {
      moveToTrash: folderTrash(project.trash),
      ...hooks,
    },
    ...rest,
  });
  return { lease, report: seen.report };
};

interface PutUpOptions {
  /** Runs after the push and before the run closes. */
  beforeClose?: (prepared: { branch: string; path: string }) => void;
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
    beforeClose,
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
  beforeClose?.(prepared);
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

const privateGitDirectory = (path: string): string =>
  git(path, ["rev-parse", "--absolute-git-dir"]);

const branchHead = (project: Project, branch: string): string | null => {
  const result = spawnSync([
    "git",
    "-C",
    project.root,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return result.exitCode === 0 ? decoder.decode(result.stdout).trim() : null;
};

const listedWorktrees = (project: Project): string[] =>
  git(project.root, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

const isAncestor = (project: Project, commit: string, of: string): boolean =>
  spawnSync([
    "git",
    "-C",
    project.root,
    "merge-base",
    "--is-ancestor",
    commit,
    of,
  ]).exitCode === 0;

// Every entry under a folder, with each file's contents.
const snapshot = (directory: string): Record<string, string> => {
  const found: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(directory, relative), {
      withFileTypes: true,
    })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path);
      } else {
        found[path] = entry.isFile()
          ? readFileSync(join(directory, path), "utf8")
          : "(link)";
      }
    }
  };
  walk("");
  return found;
};

const NOTHING: QueuedRetirementReport = {
  kept: [],
  movedToTrash: [],
  notes: [],
};

/** The copy is exactly as the run left it: folder, registration, branch. */
const expectKept = (project: Project, copy: Copy): void => {
  expect(existsSync(copy.path)).toBe(true);
  expect(git(copy.path, ["rev-parse", "HEAD"])).toBe(copy.head);
  expect(branchHead(project, copy.branch)).toBe(copy.head);
  expect(listedWorktrees(project)).toContain(copy.path);
};

/**
 * The copy is in the project's Trash folder, whole, with its private Git
 * directory inside it; Git no longer lists it, and its branch is kept.
 */
const expectInTrash = (project: Project, copy: Copy): string => {
  const location = join(project.trash, basename(copy.path));
  expect(existsSync(copy.path)).toBe(false);
  expect(existsSync(join(location, "app.py"))).toBe(true);
  expect(
    readFileSync(
      join(location, MOVED_GIT_DIRECTORY, REGISTRATION_FILE),
      "utf8"
    ).trim()
  ).toMatch(REGISTRATION_ID);
  expect(listedWorktrees(project)).not.toContain(copy.path);
  expect(branchHead(project, copy.branch)).toBe(copy.head);
  return location;
};

describe("what a Queue run records about the worktree it kept", () => {
  test("prepare-agent marks the worktree, and the closed run records that ID, the branch, and the target as one ref on one remote address", () => {
    const project = createProject();
    let markedAtPreparation = "";
    const copy = putUp(project, "one", {
      beforeClose: ({ path }) => {
        markedAtPreparation = readFileSync(
          join(privateGitDirectory(path), REGISTRATION_FILE),
          "utf8"
        ).trim();
      },
    });

    const record = readRecord(project, copy.runId);

    expect(markedAtPreparation).toMatch(REGISTRATION_ID);
    expect(record).toEqual({
      closedAt: record.closedAt,
      kind: "queued-worktrees",
      mode: "queue",
      runId: copy.runId,
      schemaVersion: 1,
      worktrees: [
        {
          branch: copy.branch,
          path: copy.path,
          registrationId: markedAtPreparation,
          target: {
            ref: "refs/heads/main",
            remote: "origin",
            url: project.remote,
          },
        },
      ],
    });
    expect(copy.closed.receipt.queued?.summary).toContain(
      "A later Queue or Sweep run moves a kept worktree to the Trash by itself once the remote confirms its work is merged and nothing in it is unsaved."
    );
    // Marking and recording change nothing Git tracks or reports.
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");
  });

  test("a target with more than one remote address is not bound, so its worktrees are never moved", () => {
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

  test("a tracking ref that two remotes could own is not bound", () => {
    const project = createProject();
    // `team/fork` has a branch `main`; `team` could as well have a branch
    // named `fork/main`, so `refs/remotes/team/fork/main` reads two ways.
    git(project.root, ["remote", "add", "team/fork", project.remote]);
    git(project.root, ["fetch", "team/fork"]);
    git(project.root, [
      "config",
      "remote.team.fetch",
      "+refs/heads/*:refs/remotes/team/*",
    ]);

    expect(queuedTargetBinding(project.root, "team/fork/main")).toEqual({
      unbound: "team/fork/main does not name one branch on exactly one remote",
    });
  });
});

describe("a remote address is recorded only in a form that is safe to keep", () => {
  test("a web address loses its user name and password, and nothing else", () => {
    expect(
      safeTargetAddress("https://alice:s3cret@example.com/team/repo.git")
    ).toBe("https://example.com/team/repo.git");
    expect(safeTargetAddress("https://token@example.com/team/repo.git")).toBe(
      "https://example.com/team/repo.git"
    );
    expect(safeTargetAddress("https://example.com/team/repo.git")).toBe(
      "https://example.com/team/repo.git"
    );
  });

  test("two SSH users stay two addresses, because the same path can be two repositories", () => {
    const alice = safeTargetAddress("ssh://alice@host.example/~/repo.git");
    const bob = safeTargetAddress("ssh://bob@host.example/~/repo.git");

    expect(alice).toBe("ssh://alice@host.example/~/repo.git");
    expect(bob).toBe("ssh://bob@host.example/~/repo.git");
    expect(safeTargetAddress("alice@host.example:repo.git")).toBe(
      "alice@host.example:repo.git"
    );
    expect(safeTargetAddress("bob@host.example:repo.git")).toBe(
      "bob@host.example:repo.git"
    );
  });

  test("an address that cannot be read safely is declined", () => {
    for (const address of [
      // A helper form hides its own address, here with a password in it.
      "https::https://user:password@host.example/repo.git",
      "ext::ssh -i key host.example repo",
      // A password where none belongs.
      "ssh://alice:s3cret@host.example/repo.git",
      "file://alice:s3cret@host.example/srv/repo.git",
      "user:s3cret@host.example:repo.git",
      // A query or fragment can carry a token.
      "https://host.example/repo.git?private_token=abc",
      "https://host.example/repo.git#abc",
      // A scheme this does not know.
      "codecommit://profile@repo",
      // A relative path, which Git could read as a remote's name.
      "upstream",
      "../repo.git",
      "team/fork",
      // An option, an empty address, a line break.
      "--upload-pack=touch /tmp/x",
      "",
      "https://host.example/repo.git\nhttps://other.example/x.git",
    ]) {
      expect(safeTargetAddress(address)).toBeNull();
    }
    expect(safeTargetAddress("/srv/git/repo.git")).toBe("/srv/git/repo.git");
    expect(safeTargetAddress("file:///srv/git/repo.git")).toBe(
      "file:///srv/git/repo.git"
    );
    expect(safeTargetAddress("git://host.example/repo.git")).toBe(
      "git://host.example/repo.git"
    );
  });

  test("a relative or helper address leaves the target unbound", () => {
    const project = createProject();
    git(project.root, ["remote", "set-url", "origin", "../remote.git"]);
    expect(queuedTargetBinding(project.root, "origin/main")).toEqual({
      unbound:
        "the address of origin is not in a form that can be recorded safely",
    });

    git(project.root, [
      "remote",
      "set-url",
      "origin",
      "https::https://user:password@host.example/repo.git",
    ]);
    expect(queuedTargetBinding(project.root, "origin/main")).toEqual({
      unbound:
        "the address of origin is not in a form that can be recorded safely",
    });
  });

  test("a password in the remote address reaches neither the record nor the report", () => {
    const project = createProject();
    // Fetches go to an address with a password in it, which nothing
    // listens on; pushes go to the shared folder.
    git(project.root, [
      "remote",
      "set-url",
      "origin",
      "http://alice:s3cret@127.0.0.1:1/team/repo.git",
    ]);
    git(project.root, [
      "remote",
      "set-url",
      "--push",
      "origin",
      project.remote,
    ]);
    const copy = putUp(project, "one");

    const recorded = readFileSync(recordPath(project, copy.runId), "utf8");
    expect(recorded).not.toContain("s3cret");
    expect(recorded).not.toContain("alice");
    expect(readRecord(project, copy.runId).worktrees[0]?.target.url).toBe(
      "http://127.0.0.1:1/team/repo.git"
    );

    const { report } = start(project, "next");

    // The remote cannot be asked, which is said once, without the password.
    expect(report?.movedToTrash).toEqual([]);
    expect(report?.notes).toHaveLength(1);
    expect(report?.notes[0]).toContain(
      "I could not ask http://127.0.0.1:1/team/repo.git what has been merged"
    );
    expect(JSON.stringify(report)).not.toContain("s3cret");
    expect(JSON.stringify(report)).not.toContain("alice");
    expectKept(project, copy);
  });
});

describe("a Queue start moves an earlier run's merged worktree to the Trash", () => {
  test("merged by ancestry and clean: the folder goes to the Trash, its branch stays, and nothing is deleted", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    const gitDirectory = privateGitDirectory(copy.path);
    const before = snapshot(copy.path);
    mergeBranches(project, copy);
    const now = new Date("2026-11-20T10:00:00.000Z");

    const { lease, report } = start(project, "next", {
      hooks: { now: () => now },
    });

    const location = expectInTrash(project, copy);
    const restore = `To get it back, move ${location} back to ${copy.path}, then move ${join(copy.path, MOVED_GIT_DIRECTORY)} to ${gitDirectory} (make the folder that holds it first if it is gone).`;
    expect(report).toEqual({
      kept: [],
      movedToTrash: [
        {
          branch: copy.branch,
          headSha: copy.head,
          location,
          path: copy.path,
          proof: "target-contained",
          registration: "moved-with-copy",
          restore,
          target: {
            ref: "refs/heads/main",
            revision: git(project.remote, ["rev-parse", "main"]),
            url: project.remote,
          },
          trashedAt: now.toISOString(),
        },
      ],
      notes: [],
    });
    // Every file is in the Trash as it was, beside the private Git
    // directory Git kept for the worktree.
    const moved = snapshot(location);
    for (const [path, contents] of Object.entries(before)) {
      expect(moved[path]).toBe(contents);
    }
    expect(existsSync(join(location, MOVED_GIT_DIRECTORY, "index"))).toBe(true);
    expect(
      existsSync(join(location, MOVED_GIT_DIRECTORY, "logs", "HEAD"))
    ).toBe(true);
    expect(existsSync(gitDirectory)).toBe(false);
    // The move is written into the record, and the new run's baseline was
    // taken after it: the worktree is not in it, the branch still is.
    expect(readRecord(project, copy.runId).worktrees).toEqual([
      {
        branch: copy.branch,
        path: copy.path,
        registrationId: readFileSync(
          join(location, MOVED_GIT_DIRECTORY, REGISTRATION_FILE),
          "utf8"
        ).trim(),
        target: {
          ref: "refs/heads/main",
          remote: "origin",
          url: project.remote,
        },
        trashed: {
          at: now.toISOString(),
          gitDirectory,
          headSha: copy.head,
          location,
          registration: "moved-with-copy",
        },
      },
    ]);
    expect(lease.worktrees.map((item) => item.path)).toEqual([project.root]);
    expect((lease.openingBranches ?? []).map((item) => item.name)).toContain(
      copy.branch
    );
    // The remote branch and the merged work are untouched.
    expect(git(project.remote, ["rev-parse", copy.branch])).toBe(copy.head);
  });

  test("a Sweep start moves it as a Queue start does", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);

    const { report } = start(project, "sweeper", { mode: "sweep" });

    expect(report?.movedToTrash).toMatchObject([
      { path: copy.path, proof: "target-contained" },
    ]);
    expectInTrash(project, copy);
  });

  test("squash merge with identical bytes is moved, and its branch stays", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    squashMerge(project, copy);
    // Not an ancestor: only the bytes match.
    expect(isAncestor(project, copy.head, "origin/main")).toBe(false);

    const { report } = start(project, "next");

    expect(report?.kept).toEqual([]);
    expect(report?.movedToTrash).toMatchObject([
      { branch: copy.branch, path: copy.path, proof: "exact-byte-target" },
    ]);
    expectInTrash(project, copy);
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

  test("files Git ignores go to the Trash with the copy", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    writeFixture(copy.path, ".env.local", "SECRET=only-here\n");
    writeFixture(copy.path, "node_modules/left-pad/index.js", "// installed\n");
    writeFixture(copy.path, "build.log", "built\n");
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");
    mergeBranches(project, copy);

    const { report } = start(project, "next");

    expect(report?.kept).toEqual([]);
    expect(report?.movedToTrash).toHaveLength(1);
    const location = expectInTrash(project, copy);
    expect(readFileSync(join(location, ".env.local"), "utf8")).toBe(
      "SECRET=only-here\n"
    );
    expect(
      readFileSync(join(location, "node_modules/left-pad/index.js"), "utf8")
    ).toBe("// installed\n");
    expect(readFileSync(join(location, "build.log"), "utf8")).toBe("built\n");
  });

  test("a moved copy is put back with two moves, works as before, and is never moved again", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    writeFixture(copy.path, ".env.local", "SECRET=only-here\n");
    mergeBranches(project, copy);
    const first = start(project, "next");
    const [move] = first.report?.movedToTrash ?? [];
    const trashed = readRecord(project, copy.runId).worktrees[0]?.trashed;
    expect(
      finalizeLoop(
        project.root,
        first.lease.runId,
        "next",
        "Nothing to put up."
      ).outcome
    ).toBe("completed");

    // Exactly what the report says: the folder, then its Git directory.
    renameSync(move?.location ?? "", copy.path);
    mkdirSync(dirname(trashed?.gitDirectory ?? ""), { recursive: true });
    renameSync(
      join(copy.path, MOVED_GIT_DIRECTORY),
      trashed?.gitDirectory ?? ""
    );

    expectKept(project, copy);
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");
    expect(readFileSync(join(copy.path, ".env.local"), "utf8")).toBe(
      "SECRET=only-here\n"
    );
    expect(git(copy.path, ["log", "-g", "--format=%H", "HEAD"])).toContain(
      copy.head
    );

    // The person wanted it back, so a later request leaves it alone.
    const { report } = start(project, "later");
    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
  });

  test("a private ref and an amended-away commit survive pruning and garbage collection", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    git(copy.path, [
      "commit",
      "--allow-empty",
      "-m",
      "only in the private reflog",
    ]);
    const old = git(copy.path, ["rev-parse", "HEAD"]);
    git(copy.path, ["reset", "--hard", copy.head]);
    writeFixture(copy.path, "build.log", "only in the private ref");
    const blob = git(copy.path, ["hash-object", "-w", "build.log"]);
    git(copy.path, ["update-ref", "refs/worktree/saved", blob]);
    mergeBranches(project, copy);
    const moved = start(project, "next").report?.movedToTrash[0];
    expect(moved?.registration).toBe("moved-with-copy");
    git(project.root, ["worktree", "prune", "--expire=now"]);
    git(project.root, ["reflog", "expire", "--expire=now", "--all"]);
    git(project.root, ["gc", "--prune=now"]);
    expect(git(project.root, ["cat-file", "-t", old])).toBe("commit");
    expect(git(project.root, ["cat-file", "-t", blob])).toBe("blob");
  });

  test("a move is remembered for thirty days, then its record entry is dropped", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    const movedAt = new Date("2026-11-20T10:00:00.000Z");
    const first = start(project, "next", { hooks: { now: () => movedAt } });
    expect(first.report?.movedToTrash).toHaveLength(1);
    const close = (started: Started): void => {
      expect(
        finalizeLoop(
          project.root,
          started.lease.runId,
          started.lease.ownerAgentId,
          "Nothing to put up."
        ).outcome
      ).toBe("completed");
    };
    close(first);

    close(
      start(project, "day-29", {
        hooks: { now: () => new Date(movedAt.getTime() + 29 * DAY_MS) },
      })
    );
    expect(readRecord(project, copy.runId).worktrees).toHaveLength(1);

    const later = start(project, "day-31", {
      hooks: { now: () => new Date(movedAt.getTime() + 31 * DAY_MS) },
    });
    expect(later.report).toEqual(NOTHING);
    expect(existsSync(recordPath(project, copy.runId))).toBe(false);
    // Only the record went: the folder is still in the Trash.
    expect(existsSync(join(project.trash, basename(copy.path)))).toBe(true);
  });
});

describe("a Trash that does not take the copy leaves it exactly as it was", () => {
  const refusals: [string, TrashMover, string][] = [
    [
      "a Trash that refuses",
      () => ({ moved: false, reason: "The volume has no Trash." }),
      "The volume has no Trash.",
    ],
    [
      "a Trash that fails outright",
      () => {
        throw new Error("the Trash tool crashed");
      },
      "the Trash tool crashed",
    ],
    [
      "a Trash that reports a move it did not make",
      () => ({ location: "/nowhere/copy", moved: true }),
      "the Trash reported a move, but the folder is still here",
    ],
  ];
  for (const [name, mover, reason] of refusals) {
    test(`${name} keeps the copy untouched and registered`, () => {
      const project = createProject();
      const copy = putUp(project, "one");
      writeFixture(copy.path, ".env.local", "SECRET=only-here\n");
      mergeBranches(project, copy);
      const before = snapshot(copy.path);
      const gitDirectory = privateGitDirectory(copy.path);
      const privateBefore = snapshot(gitDirectory);

      const { lease, report } = start(project, "next", {
        hooks: { moveToTrash: mover },
      });

      expect(report).toEqual({
        kept: [
          {
            path: copy.path,
            reason: `I could not move this copy to the Trash (${reason}), so I left it in place: ${copy.path}`,
          },
        ],
        movedToTrash: [],
        notes: [],
      });
      expectKept(project, copy);
      expect(snapshot(copy.path)).toEqual(before);
      // Git's own files for the worktree are where they were; only the
      // index may have been refreshed by Git's status.
      const privateAfter = snapshot(gitDirectory);
      expect(Object.keys(privateAfter)).toEqual(Object.keys(privateBefore));
      expect(readRecord(project, copy.runId).worktrees[0]?.trashed).toBe(
        undefined
      );
      expect(lease.worktrees.map((item) => item.path)).toContain(copy.path);
    });
  }

  test("a computer with no Trash to use keeps the copy; a test run never uses the real one", () => {
    const previous = process.env[TRASH_VARIABLE];
    Reflect.deleteProperty(process.env, TRASH_VARIABLE);
    try {
      // Nothing is at this path, so even a broken guard could move nothing.
      expect(
        systemTrashMover(join(environmentTrash, "nothing-is-here"))
      ).toEqual({
        moved: false,
        reason: "a test run never uses the real Trash",
      });
    } finally {
      process.env[TRASH_VARIABLE] = previous;
    }
  });

  test("the folder named by SIMPLE_CHANGES_TRASH_DIR stands in for the Trash, and a name already there is not overwritten", () => {
    const project = createProject();
    const one = join(project.base, "one", "copy");
    const two = join(project.base, "two", "copy");
    for (const [folder, contents] of [
      [one, "one\n"],
      [two, "two\n"],
    ] as const) {
      mkdirSync(folder, { recursive: true });
      writeFixture(folder, "a.txt", contents);
    }

    const first = moveToTrash(one);
    const second = moveToTrash(two);

    expect(first).toEqual({
      location: join(environmentTrash, "copy"),
      state: "moved",
    });
    expect(second.state).toBe("moved");
    const secondLocation = second.state === "moved" ? second.location : null;
    expect(secondLocation).not.toBe(join(environmentTrash, "copy"));
    expect(secondLocation?.startsWith(`${environmentTrash}${sep}copy `)).toBe(
      true
    );
    expect(readFileSync(join(environmentTrash, "copy", "a.txt"), "utf8")).toBe(
      "one\n"
    );
    expect(readFileSync(join(secondLocation ?? "", "a.txt"), "utf8")).toBe(
      "two\n"
    );
  });

  test("a place in the Trash that cannot be confirmed changes nothing else: Git's files for the copy stay where they are", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    const gitDirectory = privateGitDirectory(copy.path);
    const elsewhere = join(project.base, "elsewhere");
    mkdirSync(elsewhere);

    const { lease, report } = start(project, "next", {
      hooks: {
        // The folder does move, but the place reported is another folder.
        moveToTrash: (path) => {
          folderTrash(project.trash)(path);
          return { location: elsewhere, moved: true };
        },
      },
    });

    expect(report?.kept).toEqual([]);
    expect(report?.movedToTrash).toMatchObject([
      {
        location: null,
        path: copy.path,
        registration: "left-in-git",
        restore: `To get it back, find the folder named ${basename(copy.path)} in the Trash and move it back to ${copy.path}, then run git worktree unlock from the primary checkout with the restored path as its argument.`,
      },
    ]);
    expect(report?.notes).toEqual([
      `Git still lists the copy that was at ${copy.path}, because its place in the Trash could not be confirmed or its Git folder could not be moved along. Its Git registration is locked against pruning.`,
    ]);
    expect(existsSync(join(gitDirectory, "HEAD"))).toBe(true);
    expect(existsSync(join(elsewhere, MOVED_GIT_DIRECTORY))).toBe(false);
    expect(branchHead(project, copy.branch)).toBe(copy.head);
    expect(readRecord(project, copy.runId).worktrees[0]?.trashed).toMatchObject(
      { location: null, registration: "left-in-git" }
    );
    // The lease says what Git says: a listed worktree whose folder is gone.
    expect(readLoopLease(project.root)?.runId).toBe(lease.runId);

    git(project.root, ["worktree", "prune", "--expire=now"]);
    expect(existsSync(join(gitDirectory, "index"))).toBe(true);
    renameSync(join(project.trash, basename(copy.path)), copy.path);
    expectKept(project, copy);
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");
  });
});

describe("a merged worktree that still holds unsaved work is kept", () => {
  test("an untracked file that Git does not ignore keeps it", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    writeFixture(copy.path, "draft.txt", "A follow-up idea.\n");

    const { report } = start(project, "next");

    expect(report).toEqual({
      kept: [
        {
          path: copy.path,
          reason: `This copy has changes that are not saved in a commit, so I left it in place: ${copy.path}`,
        },
      ],
      movedToTrash: [],
      notes: [],
    });
    expectKept(project, copy);
    expect(readFileSync(join(copy.path, "draft.txt"), "utf8")).toBe(
      "A follow-up idea.\n"
    );
  });

  test("an edit to a tracked file keeps it", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    writeFixture(
      copy.path,
      "README.md",
      "# Fixture\n\nTyped after the push.\n"
    );

    const { report } = start(project, "next");

    expect(report?.movedToTrash).toEqual([]);
    expect(report?.kept[0]?.reason).toBe(
      `This copy has changes that are not saved in a commit, so I left it in place: ${copy.path}`
    );
    expectKept(project, copy);
  });

  test("an interrupted multi-commit cherry-pick, with a sequencer directory and clean status, keeps it", () => {
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
    const gitDirectory = privateGitDirectory(copy.path);
    expect(existsSync(join(gitDirectory, "sequencer"))).toBe(true);
    expect(existsSync(join(gitDirectory, "CHERRY_PICK_HEAD"))).toBe(false);
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");
    expect(git(copy.path, ["rev-parse", "HEAD"])).toBe(copy.head);

    const { report } = start(project, "next");

    expect(report?.movedToTrash).toEqual([]);
    expect(report?.kept).toEqual([
      {
        path: copy.path,
        reason: `This copy has an unfinished Git operation, so I left it in place: ${copy.path}`,
      },
    ]);
    expectKept(project, copy);
    expect(existsSync(join(gitDirectory, "sequencer"))).toBe(true);
  });

  test("a locked worktree is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    git(project.root, ["worktree", "lock", copy.path]);

    const { report } = start(project, "next");

    expect(report?.movedToTrash).toEqual([]);
    expect(report?.kept).toEqual([
      {
        path: copy.path,
        reason: `This copy is locked, so I left it in place: ${copy.path}`,
      },
    ]);
    expectKept(project, copy);
  });

  test("the copy the command itself runs in is never moved", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);

    const { report } = start(project, "next", { from: copy.path });

    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
  });
});

describe("every check runs for one worktree immediately before it is moved", () => {
  test("a file written into an already-checked copy before its move is caught", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    const checked: string[] = [];

    const { report } = start(project, "next", {
      hooks: {
        // The copy has passed every earlier check; someone saves a new
        // file into it now.
        beforeLastChecks: (path) => {
          checked.push(path);
          writeFixture(path, "draft.txt", "Written late.\n");
        },
      },
    });

    expect(checked).toEqual([copy.path]);
    expect(report).toEqual({
      kept: [
        {
          path: copy.path,
          reason: `This copy has changes that are not saved in a commit, so I left it in place: ${copy.path}`,
        },
      ],
      movedToTrash: [],
      notes: [],
    });
    expectKept(project, copy);
    expect(existsSync(join(copy.path, "draft.txt"))).toBe(true);
  });

  test("a commit made in an already-checked copy before its move is caught, and the commit is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    let later = "";

    const { report } = start(project, "next", {
      hooks: {
        beforeLastChecks: (path) => {
          writeFixture(path, "more.txt", "One more thing.\n");
          git(path, ["add", "more.txt"]);
          git(path, ["commit", "-m", "One more thing"]);
          later = git(path, ["rev-parse", "HEAD"]);
        },
      },
    });

    expect(report?.movedToTrash).toEqual([]);
    expect(report?.kept).toEqual([
      {
        path: copy.path,
        reason: `This copy changed while I was checking it, so I left it in place: ${copy.path}`,
      },
    ]);
    expect(existsSync(copy.path)).toBe(true);
    expect(git(copy.path, ["rev-parse", "HEAD"])).toBe(later);
    expect(branchHead(project, copy.branch)).toBe(later);
  });

  test("each copy is checked and moved before the next is looked at, so a file written into the second while the first is moved keeps the second", () => {
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

    const { report } = start(project, "next", {
      hooks: {
        beforeLastChecks: (path) => {
          if (path === first.path) {
            writeFixture(second.path, "draft.txt", "Written meanwhile.\n");
          } else {
            firstExistedAtSecondCheck.push(existsSync(first.path));
          }
        },
      },
    });

    expect(report?.movedToTrash.map((item) => item.path)).toEqual([first.path]);
    expect(report?.kept.map((item) => item.path)).toEqual([second.path]);
    // The first was already gone when the second's own checks began.
    expect(firstExistedAtSecondCheck).toEqual([false]);
    expect(existsSync(first.path)).toBe(false);
    expectKept(project, second);
    // Each move was written to its record at once.
    expect(
      readRecord(project, first.runId).worktrees[0]?.trashed
    ).toBeDefined();
    expect(readRecord(project, second.runId).worktrees[0]?.trashed).toBe(
      undefined
    );
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
    expect(isAncestor(project, copy.head, "origin/main")).toBe(true);

    const forkTargeted = start(project, "next");

    expect(forkTargeted.report).toEqual(NOTHING);
    expectKept(project, copy);

    // Once the project itself has the work, the same record moves it.
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
    expect(report?.movedToTrash).toMatchObject([
      { path: copy.path, target: { url: upstream } },
    ]);
    expect(existsSync(copy.path)).toBe(false);
  });

  test("work merged on the remote that this machine has not fetched yet is moved, and no local ref moves", () => {
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
      git(project.root, [
        "for-each-ref",
        "--exclude=refs/simple-changes/queued-trash",
        "--format=%(refname) %(objectname)",
      ]);
    const before = refs();
    const merged = git(project.remote, ["rev-parse", "main"]);
    expect(before).not.toContain(merged);

    const { lease, report } = start(project, "next");

    expect(report?.notes).toEqual([]);
    expect(report?.movedToTrash).toMatchObject([
      {
        path: copy.path,
        proof: "target-contained",
        target: { revision: merged },
      },
    ]);
    expect(existsSync(copy.path)).toBe(false);
    // Only the target's commits arrived: every ref, the remote-tracking
    // ones and the copy's own branch included, is where it was, and the
    // run's own target is still the one this machine had.
    expect(refs()).toBe(before);
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
    expect(isAncestor(project, copy.head, "origin/main")).toBe(true);

    const { report } = start(project, "next");

    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
  });

  test("a remote that is unreachable keeps the copy, and is asked once however many copies wait on it", () => {
    const project = createProject();
    const one = putUp(project, "one", { contents: "One.\n", file: "one.txt" });
    const two = putUp(project, "two", { contents: "Two.\n", file: "two.txt" });
    mergeBranches(project, one, two);
    renameSync(project.remote, `${project.remote}.away`);

    const { lease, report } = start(project, "next");

    expect(report?.movedToTrash).toEqual([]);
    expect(report?.kept).toEqual([]);
    expect(report?.notes).toHaveLength(1);
    expect(report?.notes[0]).toContain(
      `I could not ask ${project.remote} what has been merged`
    );
    expect(report?.notes[0]).toContain(
      "so earlier copies that wait on it were left in place."
    );
    expect(report?.notes[0]).not.toContain("\n");
    expectKept(project, one);
    expectKept(project, two);
    // The run itself starts all the same.
    expect(readLoopLease(project.root)?.runId).toBe(lease.runId);
  });
});

describe("the record must be this registration's, with its binding", () => {
  test("a checkout made again at the same path and branch after the run closed is kept", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    git(project.root, ["worktree", "remove", copy.path]);
    git(project.root, ["worktree", "add", copy.path, copy.branch]);
    expect(git(copy.path, ["status", "--porcelain=v1"])).toBe("");

    const { report } = start(project, "next");

    // Another registration: never moved on the old record, which is
    // dropped without a word.
    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
    expect(existsSync(recordPath(project, copy.runId))).toBe(false);
  });

  test("a checkout made again before the run closes does not inherit the mark, so it is never recorded or moved", () => {
    const project = createProject();
    const copy = putUp(project, "one", {
      // Someone removes the run's worktree and makes one again in its
      // place, same path, branch, and commit, before the run closes.
      beforeClose: ({ branch, path }) => {
        git(project.root, ["worktree", "remove", path]);
        git(project.root, ["worktree", "add", path, branch]);
      },
    });
    mergeBranches(project, copy);

    expect(
      existsSync(join(privateGitDirectory(copy.path), REGISTRATION_FILE))
    ).toBe(false);
    expect(existsSync(recordPath(project, copy.runId))).toBe(false);
    expect(copy.closed.cleanup.notes.join("\n")).toContain(
      `A later run will not move kept worktree ${copy.path} to the Trash by itself: it does not carry the mark this run's prepare-agent gives a worktree it creates`
    );

    const { report } = start(project, "next");

    expect(report).toEqual(NOTHING);
    expectKept(project, copy);
  });

  test("a worktree an earlier version prepared, which has no mark, is never recorded or moved", () => {
    const project = createProject();
    const copy = putUp(project, "one", {
      beforeClose: ({ path }) =>
        rmSync(join(privateGitDirectory(path), REGISTRATION_FILE)),
    });
    mergeBranches(project, copy);

    expect(existsSync(recordPath(project, copy.runId))).toBe(false);
    expect(start(project, "next").report).toEqual(NOTHING);
    expectKept(project, copy);
    // Closing made no mark of its own.
    expect(
      existsSync(join(privateGitDirectory(copy.path), REGISTRATION_FILE))
    ).toBe(false);
  });

  test("a record without the binding is kept", () => {
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

  test("a recorded address that was edited into an unsafe form is not asked", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    mergeBranches(project, copy);
    const record = readRecord(project, copy.runId);
    const [worktree] = record.worktrees;
    writeFileSync(
      recordPath(project, copy.runId),
      `${JSON.stringify(
        {
          ...record,
          worktrees: [
            { ...worktree, target: { ...worktree?.target, url: "origin" } },
          ],
        },
        null,
        2
      )}\n`
    );

    const { report } = start(project, "next");

    expect(report?.movedToTrash).toEqual([]);
    expect(report?.notes).toEqual([
      "I could not ask the recorded target what has been merged, so earlier copies that wait on it were left in place.",
    ]);
    expectKept(project, copy);
  });
});

describe("moving never runs outside a validated fresh Queue or Sweep start", () => {
  test("a failed start validation moves nothing", () => {
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
    expect(readRecord(project, copy.runId).worktrees[0]?.trashed).toBe(
      undefined
    );
    expect(readLoopLease(project.root)).toBeNull();

    // The same repository, once the start is valid, moves it.
    git(project.root, ["config", "--unset", "remote.origin.pushurl"]);
    expect(start(project, "next").report?.movedToTrash).toMatchObject([
      { path: copy.path },
    ]);
  });

  test("a start refused because another run is active moves nothing", () => {
    const project = createProject();
    const copy = putUp(project, "one");
    const active = start(project, "holder");
    mergeBranches(project, copy);

    expect(() => start(project, "second")).toThrow("already active");
    // Starting the same run again returns it and moves nothing either.
    expect(start(project, "holder").report).toBeUndefined();

    expectKept(project, copy);
    expect(readLoopLease(project.root)?.runId).toBe(active.lease.runId);
  });

  for (const mode of ["integrate", "ship"] as const) {
    test(`a ${mode} start in the same repository behaves as before: it moves nothing and registers the kept worktree`, () => {
      const project = createProject();
      const copy = putUp(project, "one");
      mergeBranches(project, copy);

      const { lease, report } = start(project, "shipper", { mode });

      expect(report).toBeUndefined();
      expectKept(project, copy);
      expect(readRecord(project, copy.runId).worktrees[0]?.trashed).toBe(
        undefined
      );
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

  test("an Integrate run's prepare-agent does not mark its worktree", () => {
    const project = createProject();
    const { lease } = start(project, "integrator", { mode: "integrate" });

    const prepared = prepareAgentWorktree(
      project.root,
      lease.runId,
      "author",
      "integrate work"
    );

    expect(
      existsSync(join(privateGitDirectory(prepared.path), REGISTRATION_FILE))
    ).toBe(false);
  });
});

describe("a problem after a copy has moved never stops the start", () => {
  test("when the project cannot be read again, the run still starts, and its lease and report do not describe the copy that is gone", () => {
    const project = createProject();
    const moved = putUp(project, "moved", {
      contents: "Moved.\n",
      file: "moved.txt",
    });
    const waiting = putUp(project, "waiting", {
      contents: "Waiting.\n",
      file: "waiting.txt",
    });
    mergeBranches(project, moved);
    let reads = 0;

    const { lease, report } = start(project, "next", {
      readInventoryAfterRetirement: () => {
        reads += 1;
        throw new Error("git worktree list failed: the disk is busy");
      },
    });

    expect(reads).toBe(1);
    expect(report?.movedToTrash.map((item) => item.path)).toEqual([moved.path]);
    expect(report?.notes).toEqual([
      "I could not read the project again after moving earlier copies (git worktree list failed: the disk is busy), so this request starts from what I read before, without them.",
    ]);
    // The run is started and written, without the moved worktree and with
    // everything else it read before, the moved copy's branch included.
    expect(readLoopLease(project.root)?.runId).toBe(lease.runId);
    expect(lease.worktrees.map((item) => item.path).sort()).toEqual(
      [project.root, waiting.path].sort()
    );
    expect(
      (lease.openingWorktrees ?? []).map((item) => item.path)
    ).not.toContain(moved.path);
    expect((lease.openingBranches ?? []).map((item) => item.name)).toContain(
      moved.branch
    );
    expectInTrash(project, moved);
    // The lease it wrote matches the repository as it really is now.
    const real = captureInventory(project.root);
    expect(lease.baselineDigest).toBe(real.baselineDigest);
  });
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

  test("reports the report as earlierQueuedWorktrees even when nothing was moved", () => {
    const project = createProject();
    putUp(project, "one");

    const started = cli(project, [...startArguments("next"), "--json"]);

    expect(started.exitCode).toBe(0);
    expect(
      (JSON.parse(started.stdout) as { earlierQueuedWorktrees: unknown })
        .earlierQueuedWorktrees
    ).toEqual(NOTHING);
  });

  test("says in plain words what it moved to the Trash, how to get it back, and what it left", () => {
    const project = createProject();
    const moved = putUp(project, "moved", {
      contents: "Moved.\n",
      file: "moved.txt",
    });
    const left = putUp(project, "left", {
      contents: "Left.\n",
      file: "left.txt",
    });
    const gitDirectory = privateGitDirectory(moved.path);
    writeFixture(moved.path, ".env.local", "SECRET=goes-along\n");
    writeFixture(left.path, "draft.txt", "Not saved yet.\n");
    mergeBranches(project, moved, left);
    // The command line has no Trash of its own to substitute, so it uses
    // the folder the environment names.
    const location = join(environmentTrash, basename(moved.path));

    const started = cli(project, startArguments("next"));

    expect(started.stderr).toBe("");
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain(
      `Moved an earlier copy to the Trash, because its work is now in the project: ${moved.path}. Nothing was deleted, and its branch ${moved.branch} was kept. To get it back, move ${location} back to ${moved.path}, then move ${join(moved.path, MOVED_GIT_DIRECTORY)} to ${gitDirectory} (make the folder that holds it first if it is gone).\n`
    );
    expect(started.stdout).toContain(
      `This copy has changes that are not saved in a commit, so I left it in place: ${left.path}\n`
    );
    expect(existsSync(moved.path)).toBe(false);
    expect(readFileSync(join(location, ".env.local"), "utf8")).toBe(
      "SECRET=goes-along\n"
    );
    expect(branchHead(project, moved.branch)).toBe(moved.head);
    expect(existsSync(left.path)).toBe(true);
  });
});
