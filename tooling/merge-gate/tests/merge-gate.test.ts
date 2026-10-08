import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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

let bases: string[] = [];
afterEach(() => {
  for (const base of bases) {
    rmSync(base, { force: true, recursive: true });
  }
  bases = [];
});

const run = (cwd: string, argv: string[]) => {
  const result = spawnSync(argv, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.join(" ")} failed: ${decoder.decode(result.stderr)}`
    );
  }
  return decoder.decode(result.stdout).trim();
};

const git = (cwd: string, args: string[]) =>
  run(cwd, ["git", "-C", cwd, ...args]);

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
    const now = new Date().toISOString();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        command: ["bun", "run", "check"],
        exitCode: 0,
        finishedAt: now,
        headSha: sha,
        kind: "check-receipt",
        runtime: "bun test",
        schemaVersion: 1,
        startedAt: now,
        treeSha: git(root, ["rev-parse", `${sha}^{tree}`]),
        ...overrides,
      })
    );
  };
  return { base, feature, published, root, writeReceipt };
};

const decide = (cwd: string, command: string[]) =>
  evaluateCommand(command, { cwd, targets: ["main"] });

describe("merge gate exec guard", () => {
  test("lets every ungated command through", () => {
    const { root } = repository();
    for (const command of [
      ["bun", "run", "check"],
      ["git", "status"],
      ["git", "push", "-u", "origin", "feat/x"],
      ["git", "push", "origin", "HEAD:refs/heads/feat/y"],
      ["git", "push", "origin", "v1.0.0"],
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
      ["glab", "api", "projects/1/merge_requests/5"],
      [
        "glab",
        "api",
        "projects/1/merge_requests/5/cancel_merge_when_pipeline_succeeds",
        "-X",
        "POST",
      ],
      ["sh", "-c", "echo shipped"],
      ["simple-changes", "loop", "status"],
    ]) {
      expect({ command, ...decide(root, command) }).toMatchObject({
        allow: true,
        command,
      });
    }
  });

  test("binds provider merges to a passing receipt for the exact SHA", () => {
    const { feature, root, writeReceipt } = repository();
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
      ["glab", "mr", "accept", "86", `--sha=${feature}`],
      ["gh", "pr", "merge", "7", "--match-head-commit", feature],
      [
        "gh",
        "api",
        "repos/o/r/pulls/7/merge",
        "-X",
        "PUT",
        "-f",
        `sha=${feature}`,
      ],
      [
        "env",
        "GITLAB_HOST=gitlab.com",
        "glab",
        "mr",
        "merge",
        "86",
        "--sha",
        feature,
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

  test("refuses a provider merge whose head does not contain the published target", () => {
    const { root, writeReceipt } = repository();
    const orphan = git(root, [
      "commit-tree",
      git(root, ["rev-parse", "feat/x^{tree}"]),
      "-m",
      "Detached from main",
    ]);
    writeReceipt(orphan);
    const merge = ["glab", "mr", "merge", "86", "--sha", orphan];
    expect(decide(root, merge).reason).toContain(
      "does not contain refs/remotes/origin/main"
    );
    git(root, ["remote", "remove", "origin"]);
    expect(decide(root, merge).reason).toContain("no fetched upstream copy");
  });

  test("refuses a receipt that does not record a passing check of that tree", () => {
    const { feature, root, writeReceipt } = repository();
    const command = ["glab", "mr", "merge", "86", "--sha", feature];
    for (const overrides of [
      { exitCode: 1 },
      { treeSha: "0".repeat(40) },
      { command: ["bun", "test"] },
      { headSha: "1".repeat(40) },
      { startedAt: "not a time" },
      { finishedAt: "2000-01-01T00:00:00.000Z" },
      { runtime: " " },
      { reviewer: "someone" },
      { startedAt: "October 8, 2026" },
    ]) {
      writeReceipt(feature, overrides);
      expect(decide(root, command).reason).toContain(
        "does not record a passing"
      );
    }
  });

  test("gates every git push that moves main", () => {
    const { feature, published, root, writeReceipt } = repository();
    git(root, ["merge", "-q", "--ff-only", "feat/x"]);
    // An alias chain that ends in push is still a push.
    git(root, ["config", "alias.ship", "deliver"]);
    git(root, ["config", "alias.deliver", "push"]);
    const pushes = [
      ["git", "push", "origin", "main"],
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
      ["git", "push", "-f", "origin", "main"],
      ["git", "push", "-fu", "origin", "main"],
      ["git", "-C", root, "push", "origin", "main"],
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
      ["git", "push", "--tags"],
      ["git", "push", "--dry-run", "--no-dry-run", "origin", "HEAD:main"],
      ["git", "push", "origin", "--tags", "--no-tags"],
      ["git", "push", "--repo=origin", "main"],
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
    git(root, ["config", "remote.origin.mirror", "true"]);
    expect(decide(root, ["git", "push", "origin", "feat/x"]).allow).toBe(false);
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
    ).toEqual({ command: ["git", "push"], targets: ["main"] });
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
    const merge = ["glab", "mr", "merge", "86", "--sha", feature];
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
    expect(receipt).toMatchObject({
      command: ["bun", "run", "check"],
      exitCode: 0,
      headSha: head,
      kind: "check-receipt",
      schemaVersion: 1,
      treeSha: git(root, ["rev-parse", "HEAD^{tree}"]),
    });
    expect(
      decide(root, ["glab", "mr", "merge", "1", "--sha", head]).allow
    ).toBe(true);
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
    expect(corrupt.stderr).toContain("git status failed");
    expect(
      existsSync(receiptPath(join(unreadable.root, ".git"), unreadable.head))
    ).toBe(false);

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
