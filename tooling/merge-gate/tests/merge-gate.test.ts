import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  executeLoopMutation,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import { evaluateCommand, parseGuardArguments } from "../exec-guard.ts";
import { receiptPath } from "../merge-gate.ts";

setDefaultTimeout(60_000);

const here = dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = resolve(here, "../exec-guard.ts");
const CHECK_RECEIPT_PATH = resolve(here, "../check-receipt.ts");
const decoder = new TextDecoder();
const SECONDS_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

let bases: string[] = [];
afterEach(() => {
  for (const base of bases) {
    rmSync(base, { force: true, recursive: true });
  }
  bases = [];
});

const run = (cwd: string, argv: string[], allowFailure = false) => {
  const result = spawnSync(argv, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(
      `${argv.join(" ")} failed: ${decoder.decode(result.stderr)}`
    );
  }
  return decoder.decode(result.stdout).trim();
};

const git = (cwd: string, args: string[], allowFailure = false) =>
  run(cwd, ["git", "-C", cwd, ...args], allowFailure);

const commit = (root: string, path: string, contents: string): string => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
  git(root, ["add", path]);
  git(root, ["commit", "-q", "-m", `Update ${path}`]);
  return git(root, ["rev-parse", "HEAD"]);
};

/** A repository on main with a published origin and a feature branch. */
const repository = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "merge-gate-")));
  bases.push(base);
  const origin = join(base, "origin.git");
  const root = join(base, "repo");
  run(base, ["git", "init", "-q", "--bare", "-b", "main", origin]);
  run(base, ["git", "init", "-q", "-b", "main", root]);
  git(root, ["config", "user.name", "Merge Gate Tests"]);
  git(root, ["config", "user.email", "gate@simple-changes.invalid"]);
  const published = commit(root, "README.md", "# Fixture\n");
  git(root, ["remote", "add", "origin", origin]);
  git(root, ["push", "-q", "-u", "origin", "main"]);
  git(root, ["switch", "-q", "-c", "feat/x"]);
  const feature = commit(root, "feature.txt", "feature\n");
  git(root, ["switch", "-q", "main"]);
  git(root, ["tag", "v1.0.0"]);
  const common = join(root, ".git");
  const writeReceipt = (
    sha: string,
    overrides: Record<string, unknown> = {}
  ) => {
    const path = receiptPath(common, sha);
    mkdirSync(dirname(path), { recursive: true });
    // The shared Simple Changes and Simple Changelogs receipt format.
    writeFileSync(
      path,
      JSON.stringify({
        command: "bun run check",
        exitCode: 0,
        finishedAt: "2026-10-08T17:04:05Z",
        head: sha,
        schemaVersion: 1,
        ...overrides,
      })
    );
  };
  return { base, feature, published, root, writeReceipt };
};

const PROJECTS = ["84768068", "1", "a/b", "o/r"];

const decide = (cwd: string, command: string[]) =>
  evaluateCommand(command, { cwd, projects: PROJECTS, targets: ["main"] });

describe("merge gate exec guard", () => {
  test("lets every ungated command through", () => {
    const { root } = repository();
    for (const command of [
      ["bun", "run", "check"],
      ["git", "status"],
      ["git", "push", "-u", "origin", "feat/x:feat/x"],
      ["git", "push", "origin", "HEAD:refs/heads/feat/y"],
      ["git", "push", "origin", "refs/tags/v1.0.0:refs/tags/v1.0.0"],
      ["git", "push", "origin", "--delete", "feat/x"],
      ["git", "push", "--dry-run", "origin", "main"],
      ["git", "push", "origin", "--tags"],
      ["git", "push", "--no-follow-tags", "origin", "abc123:refs/tags/v1.1.0"],
      ["git", "fetch", "--no-tags", "origin", "refs/heads/main"],
      ["git", "mktag"],
      ["git", "update-ref", "refs/tags/v1.1.0", "abc123", ""],
      ["git", "merge", "--ff-only"],
      ["git", "merge", "--abort"],
      ["glab", "mr", "view", "5"],
      ["glab", "mr", "note", "86", "--message", "merge"],
      ["glab", "mr", "create", "--title", "accept", "--description", "api"],
      ["gh", "pr", "create", "--head", "merge", "--title", "sync"],
      ["gh", "-R", "o/r", "pr", "view", "7"],
      ["glab", "api", "projects/1/merge_requests/5"],
      ["glab", "api", "projects/1/merge_requests", "--input", "payload.json"],
      ["glab", "api", "-X", "PUT", "projects/1/merge_requests/5", "-f", "x=y"],
      ["glab", "api", "-X", "POST", "projects/1/merge_requests/5/notes"],
      [
        "glab",
        "api",
        "-X",
        "DELETE",
        "projects/1/repository/branches/feat%2Fx",
      ],
      ["gh", "api", "-X", "PATCH", "repos/o/r/pulls/7", "-f", "body=x"],
      ["gh", "api", "-X", "DELETE", "repos/o/r/git/refs/heads/feat/x"],
      ["sh", "-c", "echo shipped"],
      ["simple-changes", "loop", "status"],
      ["env", "FOO=1", "bun", "run", "check"],
      ["nohup", "bun", "run", "check"],
    ]) {
      expect({ command, ...decide(root, command) }).toMatchObject({
        allow: true,
        command,
      });
    }
  });

  test("binds provider merges to a passing receipt for the exact SHA", () => {
    const { feature, root, writeReceipt } = repository();
    // `glab mr merge` without -R merges in the origin project.
    git(root, ["remote", "set-url", "origin", "git@gitlab.com:a/b.git"]);
    const merges = [
      [
        "glab",
        "api",
        "projects/84768068/merge_requests/86/merge",
        "-X",
        "PUT",
        "-f",
        `sha=${feature}`,
      ],
      [
        "glab",
        "api",
        `projects/a%2Fb/merge_requests/86/merge?sha=${feature}`,
        "--method=PUT",
      ],
      ["glab", "mr", "merge", "86", "--sha", feature],
      ["glab", "mr", "accept", "86", `--sha=${feature}`, "-R", "a/b"],
      ["gh", "pr", "merge", "7", "--match-head-commit", feature, "-R", "o/r"],
      [
        "gh",
        "api",
        "repos/o/r/pulls/7/merge",
        "-X",
        "PUT",
        "-f",
        `sha=${feature}`,
      ],
    ];
    for (const command of merges) {
      const decision = decide(root, command);
      expect({ allow: decision.allow, command }).toEqual({
        allow: false,
        command,
      });
      expect(decision.reason).toContain("no passing `bun run check` receipt");
    }
    writeReceipt(feature);
    for (const command of merges) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: true,
        command,
      });
    }
    for (const command of [
      ["glab", "mr", "merge", "86"],
      ["glab", "mr", "merge", "86", "--sha", feature, "-R", "other/project"],
      [
        "env",
        "GITLAB_HOST=example.com",
        "glab",
        "mr",
        "merge",
        "86",
        "--sha",
        feature,
      ],
      ["env", "HOME=/elsewhere", "git", "push", "origin", "HEAD:feat/x"],
      ["gh", "repo", "sync"],
      [
        "gh",
        "pr",
        "merge",
        "7",
        "--match-head-commit",
        feature,
        "-Rother/project",
      ],
      ["gh", "pr", "merge", "7", "--match-head-commit", feature, "-sd"],
      ["glab", "mr", "merge", "86", "--sha", feature, "-Rother/project"],
      ["glab", "mr", "merge", "86", "--sha", feature, "--unknown-flag"],
      // A URL or branch selector can name a proposal in another project.
      [
        "gh",
        "pr",
        "merge",
        "https://github.com/other/repo/pull/7",
        "-R",
        "o/r",
        "--merge",
        "--match-head-commit",
        feature,
      ],
      ["glab", "mr", "merge", "feat/x", "--sha", feature, "-R", "a/b"],
      ["glab", "mr", "merge", "--sha", feature, "-R", "a/b"],
      ["gh", "pr", "merge", "7", "8", "--match-head-commit", feature],
      ["gh", "api", "-X", "POST", "repos/o/r/pulls/7/merge-async"],
      ["glab", "api", "-X", "POST", "graphql", "--input", "query.json"],
      [
        "glab",
        "api",
        "-X",
        "POST",
        "projects/1/merge_requests/5/cancel_merge_when_pipeline_succeeds",
      ],
      [
        "glab",
        "api",
        "-X",
        "POST",
        "projects/1/repository/commits",
        "-f",
        "branch=main",
      ],
      ["glab", "api", "-X", "DELETE", "projects/1/repository/branches/main"],
      [
        "glab",
        "api",
        "projects/1/merge_requests/86/merge",
        "-X",
        "PUT",
        "-f",
        `sha=${feature}`,
        "-f",
        "sha=0000000",
      ],
      [
        "glab",
        "api",
        "projects/1/merge_requests/86/merge",
        "-X",
        "PUT",
        "--input",
        "body.json",
      ],
      ["glab", "api", "projects/1/merge_requests/86/merge", "-X", "PUT"],
      ["gh", "pr", "merge", "7"],
      [
        "glab",
        "api",
        "graphql",
        "-f",
        "query=mutation { mergeRequestAccept(input: {}) { errors } }",
      ],
      [
        "glab",
        "api",
        "projects/1/merge_requests/86/merge",
        "-X",
        "PUT",
        "--input",
        "-",
      ],
    ]) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: false,
        command,
      });
    }
  });

  test("binds provider merges to every fetched copy of the target", () => {
    const { base, feature, published, root, writeReceipt } = repository();
    writeReceipt(feature);
    const forms = [
      [
        "glab",
        "api",
        "projects/84768068/merge_requests/86/merge",
        "-X",
        "PUT",
        "-f",
        `sha=${feature}`,
      ],
      ["glab", "mr", "merge", "86", "--sha", feature, "-R", "a/b"],
      ["gh", "pr", "merge", "7", "--match-head-commit", feature, "-R", "o/r"],
      [
        "gh",
        "api",
        "repos/o/r/pulls/7/merge",
        "-X",
        "PUT",
        "-f",
        `sha=${feature}`,
      ],
    ];
    for (const command of forms) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: true,
        command,
      });
    }
    // origin's main moved on to a commit the feature lacks, while a stale
    // backup remote, configured as main's remote, still has the old main.
    const moved = git(root, [
      "commit-tree",
      `${published}^{tree}`,
      "-p",
      published,
      "-m",
      "Moved on",
    ]);
    git(root, ["update-ref", "refs/remotes/origin/main", moved]);
    git(root, ["remote", "add", "backup", join(base, "backup.git")]);
    git(root, ["update-ref", "refs/remotes/backup/main", published]);
    git(root, ["config", "branch.main.remote", "backup"]);
    for (const command of forms) {
      const decision = decide(root, command);
      expect({ allow: decision.allow, command }).toEqual({
        allow: false,
        command,
      });
      expect(decision.reason).toContain(
        "does not contain refs/remotes/origin/main"
      );
    }
  });

  test("refuses a provider merge whose head does not contain the published target", () => {
    const { root, writeReceipt } = repository();
    const orphan = git(root, [
      "commit-tree",
      git(root, ["rev-parse", "feat/x^{tree}"]),
      "-m",
      "Detached from main",
    ]);
    writeReceipt(orphan);
    const merge = ["glab", "mr", "merge", "86", "--sha", orphan, "-R", "a/b"];
    expect(decide(root, merge).reason).toContain(
      "does not contain refs/remotes/origin/main"
    );
    // Replacement refs and grafts can give the orphan the published target
    // as a parent for plain Git, but not for what a merge transfers.
    const published = git(root, ["rev-parse", "refs/remotes/origin/main"]);
    const contains = () =>
      spawnSync([
        "git",
        "-C",
        root,
        "merge-base",
        "--is-ancestor",
        published,
        orphan,
      ]).exitCode;
    git(root, ["replace", "--graft", orphan, published]);
    expect(contains()).toBe(0);
    expect(decide(root, merge).reason).toContain(
      "does not contain refs/remotes/origin/main"
    );
    git(root, ["replace", "-d", orphan]);
    writeFileSync(
      join(root, ".git", "info", "grafts"),
      `${orphan} ${published}\n`
    );
    expect(contains()).toBe(0);
    expect(decide(root, merge).reason).toContain(
      "does not contain refs/remotes/origin/main"
    );
    rmSync(join(root, ".git", "info", "grafts"));
    git(root, ["remote", "remove", "origin"]);
    expect(decide(root, merge).reason).toContain("no fetched upstream copy");
  });

  test("refuses a receipt that does not record a passing check of that commit", () => {
    const { feature, root, writeReceipt } = repository();
    const command = [
      "glab",
      "mr",
      "merge",
      "86",
      "--sha",
      feature,
      "-R",
      "a/b",
    ];
    for (const overrides of [
      { exitCode: 1 },
      { command: ["bun", "run", "check"] },
      { command: "bun test" },
      { head: "1".repeat(40) },
      { head: undefined },
      { finishedAt: undefined },
      { finishedAt: "not a time" },
      { finishedAt: "October 8, 2026" },
      { finishedAt: "2026-10-08T19:04:05+02:00" },
      { finishedAt: "2026-02-30T17:04:05Z" },
      { finishedAt: "2026-10-08T24:04:05.000Z" },
      { reviewer: "someone" },
      { treeSha: "0".repeat(40) },
      { schemaVersion: 2 },
    ]) {
      writeReceipt(feature, overrides);
      expect(decide(root, command).reason).toContain(
        "does not record a passing"
      );
    }
    // Both writers' finish times: seconds, and Date#toISOString milliseconds.
    for (const finishedAt of [
      "2026-10-08T17:04:05Z",
      "2026-10-08T17:04:05.123Z",
    ]) {
      writeReceipt(feature, { finishedAt });
      expect(decide(root, command).allow).toBe(true);
    }
  });

  test("follows -C through symlinks the way git does", () => {
    const receipted = repository();
    const other = repository();
    git(receipted.root, ["switch", "-q", "feat/x"]);
    receipted.writeReceipt(receipted.feature);
    git(other.root, ["switch", "-q", "feat/x"]);
    const unreceipted = commit(other.root, "other.txt", "other\n");
    mkdirSync(join(other.root, "nested"));
    // receipted/link -> other/nested, so `-C link -C ..` lands in other.
    symlinkSync(join(other.root, "nested"), join(receipted.root, "link"));
    const push = ["push", "origin", "HEAD:refs/heads/main"];
    expect(
      decide(receipted.base, ["git", "-C", receipted.root, ...push]).allow
    ).toBe(true);
    const traversed = decide(receipted.base, [
      "git",
      "-C",
      join(receipted.root, "link"),
      "-C",
      "..",
      ...push,
    ]);
    expect(traversed.allow).toBe(false);
    expect(traversed.reason).toContain(unreceipted);
    // The same in one operand, which lexical normalization would erase.
    const single = decide(receipted.base, [
      "git",
      "-C",
      `${receipted.root}/link/..`,
      ...push,
    ]);
    expect(single.allow).toBe(false);
    expect(single.reason).toContain(unreceipted);
    expect(
      decide(receipted.base, [
        "git",
        "-C",
        join(receipted.base, "missing"),
        ...push,
      ]).reason
    ).toContain("cannot resolve");
  });

  test("gates every git push that moves main", () => {
    const { feature, published, root, writeReceipt } = repository();
    git(root, ["merge", "-q", "--ff-only", "feat/x"]);
    // An alias chain that ends in push is still a push.
    git(root, ["config", "alias.ship", "deliver"]);
    git(root, ["config", "alias.deliver", "push"]);
    const pushes = [
      ["git", "push", "origin", "main:main"],
      ["git", "push", "origin", "HEAD:main"],
      ["git", "push", "origin", "HEAD:heads/main"],
      [
        "glab",
        "api",
        "projects/1/merge_requests/2/merge/",
        "-X",
        "put",
        "-f",
        `sha=${feature}`,
      ],
      [
        "glab",
        "api",
        `projects/a%2Fb/merge_requests/2/%6Derge?sha=${feature}`,
        "--method",
        "PUT",
      ],
      ["git", "push", "origin", "+feat/x:refs/heads/main"],
      ["git", "push", "-f", "origin", "main:main"],
      ["git", "-C", root, "push", "origin", "HEAD:main"],
    ];
    for (const command of pushes) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: false,
        command,
      });
    }
    writeReceipt(feature);
    for (const command of pushes) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: true,
        command,
      });
    }
    for (const command of [
      ["git", "push", "origin", ":main"],
      ["git", "push", "origin", "--delete", "main"],
      ["git", "push", "--all", "origin"],
      ["git", "push", "--mirror", "origin"],
      ["git", "push", "origin", ":"],
      ["git", "push", "origin", "+:"],
      ["git", "-c", "alias.ship=push", "ship", "origin", "main"],
      ["git", "--git-dir=/elsewhere/.git", "push", "origin", "HEAD:main"],
      ["git", "--work-tree", "/elsewhere", "merge", "--ff-only", "feat/x"],
      ["git", "--bare", "push", "origin", "main"],
      ["env", "GIT_DIR=/elsewhere/.git", "git", "push", "origin", "main"],
      ["git", "send-pack", "origin", "main"],
      ["git", "subtree", "push", "--prefix=lib", "origin", "main"],
      ["git", "ship", "origin", "main"],
      ["git", "push", "origin", "refs/heads/*:refs/heads/*"],
      ["git", "-c", "push.default=matching", "push"],
      ["sh", "-c", "git push origin main"],
      ["bash", "-lc", "glab mr merge 5"],
      ["env", "-S", "git push origin main"],
      ["git", "push"],
      ["git", "push", "origin"],
      ["nohup", "--", "git", "push", "origin", "HEAD:refs/heads/main"],
      ["nohup", "glab", "mr", "merge", "86", "--sha", feature, "-R", "a/b"],
      ["xargs", "git", "push", "origin"],
      ["sudo", "-u", "someone", "git", "push", "origin", "HEAD:main"],
      ["timeout", "5", "sh", "-c", "echo"],
      ["command", "git", "push", "origin", "HEAD:main"],
      ["/usr/bin/env", "git", "status"],
      ["git", "push", "-on", "origin", "HEAD:main"],
      ["git", "push", "-od", "origin", "HEAD:main"],
      ["git", "push", "-fu", "origin", "main:refs/heads/main"],
      ["glab", "mr", "--yes", "merge", "86", "--sha", feature],
      ["git", "push", "--tags"],
      ["git", "push", "--dry-run", "--no-dry-run", "origin", "HEAD:main"],
      ["git", "push", "origin", "--tags", "--no-tags"],
      ["git", "push", "--repo=origin", "main"],
      ["git", "push", "origin", "main"],
      ["git", "push", "origin", "HEAD"],
      ["git", "-c", "include.path=/elsewhere/config", "status"],
      ["git", "--exec-path=/elsewhere", "status"],
      ["bash", "-c", 'exec git "$@"', "--", "push", "origin", "HEAD:main"],
      ["sh", "-c", 'exec "$0" "$@"', "git", "push", "origin", "HEAD:main"],
      ["gh", "-R", "group/repo", "pr", "merge", "7"],
      ["glab", "-R", "group/repo", "mr", "merge", "7"],
      ["git", "rebase", "--exec", "git push origin HEAD:main", "main"],
      ["git", "submodule", "foreach", "git push origin HEAD:main"],
      ["git", "rebase", "-xgit push origin HEAD:main", "main"],
      ["git", "rebase", "-ix", "git push origin HEAD:main", "main"],
      ["git", "push", "origin", ":heads/main"],
      ["git", "push", "origin", "--delete", "heads/main"],
      ["gh", "api", "repos/o/r/pulls/7/merge", "-XPUT"],
      ["glab", "api", "projects/1/merge_requests/2/merge", "-fsha=abc1234"],
    ]) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: false,
        command,
      });
    }
    expect(published).not.toBe(feature);
  });

  test("refuses pushes that configuration can redirect", () => {
    const { root } = repository();
    git(root, [
      "config",
      "remote.origin.push",
      "refs/heads/feat/x:refs/heads/main",
    ]);
    expect(decide(root, ["git", "push", "origin", "feat/x"]).allow).toBe(false);
    expect(
      decide(root, ["git", "push", "origin", "feat/x:refs/heads/feat/x"]).allow
    ).toBe(true);
    git(root, ["config", "--unset", "remote.origin.push"]);
    // push.default=upstream sends a colonless branch to its upstream.
    git(root, ["config", "push.default", "upstream"]);
    git(root, ["config", "branch.feat/x.merge", "refs/heads/main"]);
    git(root, ["config", "branch.feat/x.remote", "origin"]);
    expect(decide(root, ["git", "push", "origin", "feat/x"]).allow).toBe(false);
    git(root, ["config", "remote.origin.mirror", "true"]);
    expect(
      decide(root, ["git", "push", "origin", "feat/x:refs/heads/feat/x"]).allow
    ).toBe(false);
  });

  test("treats every true spelling of remote mirroring as mirroring", () => {
    const { root } = repository();
    for (const value of ["yes", "on", "1", null]) {
      git(root, ["config", "--unset-all", "remote.origin.mirror"], true);
      if (value === null) {
        writeFileSync(
          join(root, ".git", "config"),
          `${readFileSync(join(root, ".git", "config"), "utf8")}[remote "origin"]\n\tmirror\n`
        );
      } else {
        git(root, ["config", "remote.origin.mirror", value]);
      }
      expect({
        allow: decide(root, ["git", "push", "origin", "--tags"]).allow,
        value,
      }).toEqual({ allow: false, value });
    }
    git(root, ["config", "--unset-all", "remote.origin.mirror"]);
    git(root, ["config", "remote.origin.mirror", "no"]);
    expect(decide(root, ["git", "push", "origin", "--tags"]).allow).toBe(true);
  });

  test("finds main even when a tag is also named main", () => {
    const { root } = repository();
    git(root, ["tag", "main"]);
    for (const command of [
      ["git", "merge", "--ff-only", "feat/x"],
      ["git", "pull", "--ff-only", "origin", "feat/x"],
    ]) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: false,
        command,
      });
    }
  });

  test("refuses a provider mutation that names its own host", () => {
    const { feature, root, writeReceipt } = repository();
    writeReceipt(feature);
    for (const command of [
      [
        "glab",
        "api",
        "--hostname",
        "other.example",
        "projects/84768068/merge_requests/7/merge",
        "-X",
        "PUT",
        "-f",
        `sha=${feature}`,
      ],
      [
        "glab",
        "api",
        "https://other.example/api/v4/projects/1/merge_requests/2/merge",
        "-X",
        "PUT",
        "-f",
        `sha=${feature}`,
      ],
    ]) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: false,
        command,
      });
    }
  });

  test("allows syncing main with its published remote and gates real merges", () => {
    const { feature, root, writeReceipt } = repository();
    for (const command of [
      ["git", "merge", "--ff-only", "origin/main"],
      ["git", "pull", "--ff-only"],
      ["git", "pull", "--ff-only", "origin", "main"],
      ["git", "merge", "--abort"],
    ]) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: true,
        command,
      });
    }
    for (const command of [
      ["git", "merge", "feat/x"],
      ["git", "merge", "--ff-only", "feat/x"],
      ["git", "merge", "origin/main"],
      ["git", "merge", "--ff-only", "--no-ff", "origin/main"],
      ["git", "merge", "--continue"],
      ["git", "pull", "origin", "main"],
      ["git", "pull", "--rebase"],
      ["git", "pull", "--ff-only", "origin", "feat/x"],
      ["git", "pull", "--ff-only", "mirror", "main"],
    ]) {
      expect({ allow: decide(root, command).allow, command }).toEqual({
        allow: false,
        command,
      });
    }
    writeReceipt(feature);
    expect(decide(root, ["git", "merge", "--ff-only", "feat/x"]).allow).toBe(
      true
    );
    expect(decide(root, ["git", "merge", "--no-ff", "feat/x"]).allow).toBe(
      false
    );
    git(root, ["switch", "-q", "feat/x"]);
    expect(decide(root, ["git", "merge", "main"]).allow).toBe(true);
  });

  test("reads its own arguments only up to --", () => {
    expect(
      parseGuardArguments(["--target-branch", "main", "--", "git", "push"])
    ).toEqual({ command: ["git", "push"], projects: [], targets: ["main"] });
    expect(
      parseGuardArguments(["--project", "84768068", "--", "glab"]).projects
    ).toEqual(["84768068"]);
    expect(parseGuardArguments(["--", "ls"]).targets).toEqual(["main"]);
    expect(() => parseGuardArguments(["git", "push"])).toThrow(
      "end the guard's own arguments with --"
    );
  });

  test("loop exec refuses a merge before it starts and runs everything else", async () => {
    const { feature, root, writeReceipt } = repository();
    writeFileSync(
      join(root, ".simple-changes.json"),
      `${JSON.stringify(
        {
          ...DEFAULT_POLICY,
          execGuard: [
            process.execPath,
            GUARD_PATH,
            "--target-branch",
            "main",
            "--",
          ],
        },
        null,
        2
      )}\n`
    );
    git(root, ["add", ".simple-changes.json"]);
    git(root, ["commit", "-q", "-m", "Add the merge gate policy"]);
    const lease = startLoop(root, "controller", "ship");
    const marker = join(root, "..", "merged.txt");
    const merge = ["glab", "mr", "merge", "86", "--sha", feature, "-R", "a/b"];
    await expect(
      executeLoopMutation(root, lease.runId, "controller", merge)
    ).rejects.toThrow("exited 1");
    const allowed = await executeLoopMutation(root, lease.runId, "controller", [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
    ]);
    expect(allowed.result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
    writeReceipt(feature);
    expect(decide(root, merge).allow).toBe(true);
  });
});

describe("bun run check:receipt", () => {
  const checkRepository = (checkScript: string) => {
    const { base, root } = repository();
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "fixture", scripts: { check: checkScript } })}\n`
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "-q", "-m", "Add the check script"]);
    return { base, head: git(root, ["rev-parse", "HEAD"]), root };
  };
  const runCheckReceipt = (root: string) => {
    const result = spawnSync([process.execPath, CHECK_RECEIPT_PATH], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stderr: decoder.decode(result.stderr),
      stdout: decoder.decode(result.stdout),
    };
  };

  test("records a receipt for a clean checkout whose check passes", () => {
    const { head, root } = checkRepository("true");
    const result = runCheckReceipt(root);
    expect(result.exitCode).toBe(0);
    const receipt = JSON.parse(
      readFileSync(receiptPath(join(root, ".git"), head), "utf8")
    ) as Record<string, unknown>;
    expect(receipt).toEqual({
      command: "bun run check",
      exitCode: 0,
      finishedAt: expect.stringMatching(SECONDS_UTC_PATTERN),
      head,
      schemaVersion: 1,
    });
    expect(
      decide(root, ["glab", "mr", "merge", "1", "--sha", head, "-R", "a/b"])
        .allow
    ).toBe(true);
  });

  test("counts submodule changes that ignore settings, module settings, or index flags hide", () => {
    const identity = [
      "-c",
      "user.name=Merge Gate Tests",
      "-c",
      "user.email=gate@simple-changes.invalid",
    ];
    const allowFile = ["-c", "protocol.file.allow=always"];
    const library = (base: string, name: string, path: string): string => {
      const root = join(base, name);
      run(base, ["git", "init", "-q", "-b", "main", root]);
      git(root, ["config", "user.name", "Merge Gate Tests"]);
      git(root, ["config", "user.email", "gate@simple-changes.invalid"]);
      commit(root, path, `${name}\n`);
      return root;
    };
    for (const change of [
      "moved",
      "edited",
      "hidden",
      "nested",
      "untracked",
    ] as const) {
      const fixture = checkRepository("true");
      // lib is a module of the checkout, and deep is a module of lib.
      const deep = library(fixture.base, "deep-source", "deep.txt");
      const lib = library(fixture.base, "lib-source", "lib.txt");
      git(lib, [...allowFile, "submodule", "add", "-q", deep, "deep"]);
      git(lib, ["commit", "-q", "-m", "Add deep"]);
      git(fixture.root, [...allowFile, "submodule", "add", "-q", lib, "lib"]);
      git(fixture.root, [
        ...allowFile,
        "submodule",
        "update",
        "-q",
        "--init",
        "--recursive",
      ]);
      git(fixture.root, ["commit", "-q", "-m", "Add the library"]);
      git(fixture.root, ["config", "submodule.lib.ignore", "all"]);
      const head = git(fixture.root, ["rev-parse", "HEAD"]);
      const module = join(fixture.root, "lib");
      if (change === "moved") {
        git(module, [
          ...identity,
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "Move the module",
        ]);
      } else if (change === "edited" || change === "hidden") {
        if (change === "hidden") {
          git(module, ["update-index", "--assume-unchanged", "lib.txt"]);
        }
        writeFileSync(join(module, "lib.txt"), "edited\n");
      } else if (change === "nested") {
        // lib ignores deep, so lib's own status hides deep's new commit.
        git(module, ["config", "submodule.deep.ignore", "all"]);
        git(join(module, "deep"), [
          ...identity,
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "Move the nested module",
        ]);
      } else {
        git(module, ["config", "status.showUntrackedFiles", "no"]);
        writeFileSync(join(module, "untracked.txt"), "stray\n");
      }
      expect(git(fixture.root, ["status", "--porcelain"])).toBe("");
      if (change === "nested" || change === "untracked") {
        // The checkout's own flags do not reach a module's internal status.
        expect(
          git(fixture.root, [
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
          ])
        ).toBe("");
      }
      const result = runCheckReceipt(fixture.root);
      expect({ change, exitCode: result.exitCode }).toEqual({
        change,
        exitCode: 1,
      });
      expect(result.stderr).toContain("the checkout is not clean");
      expect(existsSync(receiptPath(join(fixture.root, ".git"), head))).toBe(
        false
      );
    }
  });

  test("checks the real HEAD, never a replacement checked out in its place", () => {
    const fixture = checkRepository("true");
    const { head, root } = fixture;
    git(root, ["switch", "-q", "-c", "replacement"]);
    writeFileSync(join(root, "README.md"), "# Replaced contents\n");
    git(root, ["commit", "-q", "-am", "Replacement"]);
    const replacement = git(root, ["rev-parse", "HEAD"]);
    git(root, ["switch", "-q", "main"]);
    git(root, ["replace", head, replacement]);
    git(root, ["reset", "-q", "--hard"]);
    // Plain Git now shows the replacement's contents as a clean HEAD.
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(
      "# Replaced contents\n"
    );
    expect(git(root, ["status", "--porcelain"])).toBe("");
    const result = runCheckReceipt(root);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("the checkout is not clean");
    expect(existsSync(receiptPath(join(root, ".git"), head))).toBe(false);
  });

  test("runs the check against real history, never replaced or grafted parents", () => {
    for (const rewrite of ["replace", "graft"] as const) {
      // The check passes only when Git shows HEAD's real parent.
      const { head, root } = checkRepository(
        "git rev-parse --verify -q HEAD~1"
      );
      if (rewrite === "replace") {
        git(root, ["replace", "--graft", head]);
      } else {
        writeFileSync(join(root, ".git", "info", "grafts"), `${head}\n`);
      }
      // Plain Git now shows HEAD with no parent; the tree is unchanged.
      expect(
        spawnSync(["git", "-C", root, "rev-parse", "--verify", "-q", "HEAD~1"])
          .exitCode
      ).not.toBe(0);
      const result = runCheckReceipt(root);
      expect({ exitCode: result.exitCode, rewrite }).toEqual({
        exitCode: 0,
        rewrite,
      });
      expect(existsSync(receiptPath(join(root, ".git"), head))).toBe(true);
    }
  });

  test("records nothing for a failing check, a dirty checkout, or a check that edits files", () => {
    const failing = checkRepository("exit 3");
    expect(runCheckReceipt(failing.root).exitCode).toBe(3);
    expect(
      existsSync(receiptPath(join(failing.root, ".git"), failing.head))
    ).toBe(false);

    const dirty = checkRepository("true");
    writeFileSync(join(dirty.root, "untracked.txt"), "stray\n");
    const refused = runCheckReceipt(dirty.root);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(
      "the checkout is not clean before the check"
    );
    expect(existsSync(receiptPath(join(dirty.root, ".git"), dirty.head))).toBe(
      false
    );

    const unreadable = checkRepository("true");
    writeFileSync(join(unreadable.root, ".git", "index"), "not an index");
    const corrupt = runCheckReceipt(unreadable.root);
    expect(corrupt.exitCode).toBe(1);
    expect(corrupt.stderr).toContain("git status failed in");
    expect(
      existsSync(receiptPath(join(unreadable.root, ".git"), unreadable.head))
    ).toBe(false);

    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const hidden = checkRepository("true");
      git(hidden.root, ["update-index", flag, "README.md"]);
      writeFileSync(join(hidden.root, "README.md"), "edited out of sight\n");
      expect(git(hidden.root, ["status", "--porcelain"])).toBe("");
      const result = runCheckReceipt(hidden.root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("README.md (hidden from git status)");
      expect(
        existsSync(receiptPath(join(hidden.root, ".git"), hidden.head))
      ).toBe(false);
    }

    const moving = checkRepository("git commit -q --allow-empty -m moved");
    const moved = runCheckReceipt(moving.root);
    expect(moved.exitCode).toBe(1);
    expect(moved.stderr).toContain("HEAD moved");
    expect(
      existsSync(receiptPath(join(moving.root, ".git"), moving.head))
    ).toBe(false);

    const editing = checkRepository("echo changed >> README.md");
    const edited = runCheckReceipt(editing.root);
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toContain("after the check");
    expect(
      existsSync(receiptPath(join(editing.root, ".git"), editing.head))
    ).toBe(false);
  });
});
