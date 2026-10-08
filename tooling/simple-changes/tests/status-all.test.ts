import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  controllerBindingPath,
  finalizeLoop,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { runGit } from "../../../skills/simple-changes/scripts/lib/process.ts";
import { withReadOnlyGit } from "../../../skills/simple-changes/scripts/lib/read-only-git.ts";
import { recordReadyWork } from "../../../skills/simple-changes/scripts/lib/ready-work.ts";
import { addShipHold } from "../../../skills/simple-changes/scripts/lib/ship-holds.ts";
import {
  GLOBAL_SKILL_ROOTS,
  PROJECT_ROOTS,
} from "../../../skills/simple-changes/scripts/lib/skill-roots.ts";
import {
  isUnknown,
  type StatusRepository,
  statusAll,
} from "../../../skills/simple-changes/scripts/lib/status-all.ts";
import {
  claimWorktree,
  releaseWorktreeClaim,
  worktreeCoordinationPath,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import { discover } from "../../../skills/update-local-forks/scripts/update-local-forks.ts";
import { git, writeFixture } from "./helpers.ts";

setDefaultTimeout(60_000);

let homes: string[] = [];
afterEach(() => {
  for (const home of homes) {
    rmSync(home, { force: true, recursive: true });
  }
  homes = [];
});

const temporaryHome = (): string => {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), "simple-changes-status-"))
  );
  homes.push(home);
  return home;
};

const initRepository = (path: string): string => {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.name", "Status Tests"]);
  git(path, ["config", "user.email", "status@simple-changes.invalid"]);
  writeFixture(path, "README.md", "# Fixture\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-q", "-m", "Initial fixture"]);
  return path;
};

const policy = (version: number): string =>
  `${JSON.stringify({
    changelogHandling: "preserve-and-report",
    concurrentWork: "allow-claimed",
    defaultFinish: "open-change-request",
    gitPushAuthorization: "ask",
    guidance: { disposition: "accepted", version },
    handoffTiming: "confirm-ready",
    migrationHandling: "ask-after-review",
    migrationTargets: [],
    productionDeploy: "ask",
    proposalScheduling: "balanced",
    proposalSignatures: "agent-and-version",
    questions: "blocking-only",
    review: "repository-policy",
    schemaVersion: 1,
    shippingMode: "standard",
    uiArtifactVersioning: "repository-convention",
  })}\n`;

const writeSkill = (
  directory: string,
  frontmatter: string,
  body: string,
  runtime: { guidance: number; version: string }
): void => {
  mkdirSync(directory, { recursive: true });
  writeFixture(directory, "SKILL.md", `---\n${frontmatter}\n---\n\n${body}\n`);
  writeFixture(
    directory,
    "scripts/simple-changes.ts",
    `const VERSION = "${runtime.version}";\n`
  );
  writeFixture(
    directory,
    "scripts/lib/guidance-updates.ts",
    `export const CURRENT_GUIDANCE_VERSION = ${runtime.guidance};\n`
  );
};

/** Every file under `root` with its size, mode, mtime, and content digest. */
const snapshot = (root: string): Map<string, string> => {
  const files = new Map<string, string>();
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.set(`${path}/`, "directory");
        visit(path);
      } else if (entry.isFile()) {
        const stats = statSync(path);
        files.set(
          path,
          `${stats.size}:${stats.mode}:${stats.mtimeMs}:${createHash("sha256")
            .update(readFileSync(path))
            .digest("hex")}`
        );
      }
    }
  };
  visit(root);
  return files;
};

const statusOf = (
  repositories: readonly StatusRepository[],
  path: string
): StatusRepository => {
  const status = repositories.find((item) => item.repository === path);
  if (!status) {
    throw new Error(`missing status for ${path}`);
  }
  return status;
};

describe("simple-changes status --all", () => {
  test("scans the roots update-local-forks scans", () => {
    const home = temporaryHome();
    for (const root of [...GLOBAL_SKILL_ROOTS, ...PROJECT_ROOTS]) {
      mkdirSync(join(home, root), { recursive: true });
    }
    expect(
      statusAll({
        home,
        runtime: { skillDirectory: home, version: "0.0.0" },
      }).roots
    ).toEqual(discover({ home, roots: [] }).roots);
  });

  test("reports leases, claims, holds, guidance, and forks without writing anything", () => {
    const home = temporaryHome();
    const shipping = initRepository(join(home, "Developer", "shipping"));
    writeFixture(shipping, ".simple-changes.json", policy(26));
    git(shipping, ["add", ".simple-changes.json"]);
    git(shipping, ["commit", "-q", "-m", "Add policy"]);
    const authorPath = join(home, "Developer", "shipping-author");
    git(shipping, ["worktree", "add", "-q", "-b", "author", authorPath]);
    claimWorktree(authorPath, "author-agent", authorPath, "codex");
    writeFixture(authorPath, "draft.txt", "in progress\n");
    const finishedPath = join(home, "Developer", "shipping-finished");
    git(shipping, ["worktree", "add", "-q", "-b", "finished", finishedPath]);
    const finished = claimWorktree(
      finishedPath,
      "finished-agent",
      finishedPath,
      "codex"
    );
    releaseWorktreeClaim(finishedPath, "finished-agent", finished.claimId);
    const lease = startLoop(shipping, "controller", "ship");
    addShipHold(shipping, {
      adapter: "claude-code",
      agentId: "migration-agent",
      reason: "A migration is mid-flight.",
      scope: "deploy",
      severity: "delay",
    });
    initRepository(join(home, "Developer", "unrelated"));
    writeSkill(
      join(home, ".agents", "skills", "simple-changes"),
      'name: simple-changes\nmetadata:\n  version: "0.27.1"',
      "# Simple Changes",
      { guidance: 27, version: "0.27.1" }
    );
    const forkPath = join(
      home,
      "Developer",
      "shipping",
      "skills",
      "shipping-simple-changes"
    );
    writeSkill(
      forkPath,
      "name: shipping-simple-changes",
      `Forked from \`simple-changes\` @ \`${"a".repeat(40)}\`.`,
      { guidance: 26, version: "0.25.1" }
    );
    // Make the index stat-dirty, so a Git status that may write would.
    const readme = join(shipping, "README.md");
    utimesSync(readme, new Date(), new Date(Date.now() + 5000));
    const before = snapshot(home);

    const report = statusAll({
      home,
      runtime: { skillDirectory: join(home, "missing"), version: "0.27.1" },
    });

    expect(snapshot(home)).toEqual(before);
    expect(report.repositories.map((item) => item.repository)).toEqual([
      shipping,
    ]);
    const status = statusOf(report.repositories, shipping);
    expect(status.lease).toMatchObject({
      controllerStatus: "active",
      mode: "ship",
      ownerAgentId: "controller",
      runId: lease.runId,
    });
    expect(status.claims).toEqual([
      expect.objectContaining({
        agentId: "author-agent",
        // Status compares HEAD only; it never runs git status.
        checkout: "at-claimed-head",
        path: authorPath,
        state: "active",
      }),
    ]);
    expect(status.releasedClaims).toBe(1);
    expect(status.holds).toEqual([
      expect.objectContaining({
        owner: "migration-agent",
        scope: "deploy",
        status: "active",
      }),
    ]);
    expect(status.readyWork).toEqual([]);
    expect(status.guidance).toMatchObject({
      state: "update-available",
      storedVersion: 26,
    });
    expect(report.upstream).toMatchObject({ version: "0.27.1" });
    expect(report.forks).toEqual([
      expect.objectContaining({
        guidanceVersion: 26,
        name: "shipping-simple-changes",
        runtimeVersion: "0.25.1",
        state: "behind",
      }),
    ]);
  });

  test("read-only Git never lazily fetches a missing object", () => {
    const home = temporaryHome();
    const source = initRepository(join(home, "source"));
    git(source, ["config", "uploadpack.allowFilter", "true"]);
    const blob = git(source, ["rev-parse", "HEAD:README.md"]);
    const clone = join(home, "partial");
    git(home, [
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      `file://${source}`,
      clone,
    ]);
    const present = () =>
      runGit(clone, ["cat-file", "-e", blob], true, {
        GIT_NO_LAZY_FETCH: "1",
      }).exitCode === 0;
    expect(present()).toBe(false);

    const read = withReadOnlyGit(() =>
      runGit(clone, ["cat-file", "-p", blob], true)
    );

    expect(read.exitCode).not.toBe(0);
    expect(present()).toBe(false);
  });

  test("never starts a filesystem monitor", () => {
    const home = temporaryHome();
    const repository = initRepository(join(home, "Developer", "monitored"));
    writeFixture(repository, ".simple-changes.json", policy(27));
    const marker = join(home, "fsmonitor-ran");
    const hook = join(home, "fsmonitor-hook");
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    git(repository, ["config", "core.fsmonitor", hook]);
    // Git itself runs the hook for a status outside the read-only settings.
    git(repository, ["status", "--porcelain"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    statusAll({ home, runtime: { skillDirectory: home, version: "0.27.1" } });

    expect(existsSync(marker)).toBe(false);
  });

  test("reports absent checkouts, unreadable claims, and unreadable bindings", () => {
    const home = temporaryHome();
    const repository = initRepository(join(home, "Developer", "absent"));
    writeFixture(repository, ".simple-changes.json", policy(27));
    const gone = join(home, "Developer", "absent-author");
    git(repository, ["worktree", "add", "-q", "-b", "gone", gone]);
    claimWorktree(gone, "gone-agent", gone, "codex");
    rmSync(gone, { force: true, recursive: true });
    startLoop(repository, "controller", "ship");
    const common = join(repository, ".git");
    writeFileSync(controllerBindingPath(common), "{ not json");

    const [status] = statusAll({
      home,
      runtime: { skillDirectory: home, version: "0.27.1" },
    }).repositories;

    expect(status?.claims).toEqual([
      expect.objectContaining({ checkout: "absent", path: gone }),
    ]);
    const lease = status?.lease as { awaitingUser: unknown } | undefined;
    expect(isUnknown(lease?.awaitingUser)).toBe(true);

    // A checkout replaced by a symlink loop cannot be observed.
    symlinkSync(gone, gone);
    const [looped] = statusAll({
      home,
      runtime: { skillDirectory: home, version: "0.27.1" },
    }).repositories;
    expect(looped?.claims).toEqual([
      expect.objectContaining({ checkout: "unknown", path: gone }),
    ]);

    writeFileSync(worktreeCoordinationPath(common), "{ not json");
    const [unreadable] = statusAll({
      home,
      runtime: { skillDirectory: home, version: "0.27.1" },
    }).repositories;
    expect(isUnknown(unreadable?.claims)).toBe(true);
    expect(unreadable?.releasedClaims).toBeNull();

    // A state file that cannot be looked up is unknown, never empty.
    rmSync(worktreeCoordinationPath(common));
    symlinkSync(
      worktreeCoordinationPath(common),
      worktreeCoordinationPath(common)
    );
    const [lookup] = statusAll({
      home,
      runtime: { skillDirectory: home, version: "0.27.1" },
    }).repositories;
    expect(isUnknown(lookup?.claims)).toBe(true);
  });

  test("reports ready receipts, their checkouts, and awaited questions", () => {
    const home = temporaryHome();
    const repository = initRepository(join(home, "Developer", "ready"));
    writeFixture(repository, ".simple-changes.json", policy(27));
    git(repository, ["add", ".simple-changes.json"]);
    git(repository, ["commit", "-q", "-m", "Add policy"]);
    const ready = (name: string): string => {
      const path = join(home, "Developer", name);
      git(repository, ["worktree", "add", "-q", "-b", name, path]);
      const claim = claimWorktree(path, `${name}-agent`, path, "codex");
      writeFixture(path, `${name}.txt`, "finished\n");
      git(path, ["add", `${name}.txt`]);
      git(path, ["commit", "-q", "-m", `Finish ${name}`]);
      recordReadyWork(path, `${name}-agent`, claim.claimId, {
        checks: [{ command: "bun run check", note: null, result: "passed" }],
        deploymentConstraints: [],
        migrations: [],
        releaseImpact: "patch",
        scope: `Finish ${name}.`,
        unresolvedAuthority: [],
      });
      return path;
    };
    ready("kept");
    rmSync(ready("removed"), { force: true, recursive: true });
    const lease = startLoop(repository, "controller", "ship");
    finalizeLoop(
      repository,
      lease.runId,
      "controller",
      "Waiting on the user.",
      {
        awaitingUser: ["Ship the kept work now?"],
      }
    );

    const [status] = statusAll({
      home,
      runtime: { skillDirectory: home, version: "0.27.1" },
    }).repositories;

    const readyWork = (status?.readyWork ?? []) as Array<{
      branch: string;
      checkoutPresent: unknown;
    }>;
    const byBranch = Object.fromEntries(
      readyWork.map((item) => [item.branch, item.checkoutPresent])
    );
    expect(byBranch).toEqual({ kept: true, removed: false });
    expect(status?.lease).toMatchObject({
      awaitingUser: ["Ship the kept work now?"],
    });

    // A binding from another controller tenure awaits nothing.
    const common = join(repository, ".git");
    const binding = JSON.parse(
      readFileSync(controllerBindingPath(common), "utf8")
    ) as Record<string, unknown>;
    writeFileSync(
      controllerBindingPath(common),
      JSON.stringify({ ...binding, runId: "run-another-tenure" })
    );
    const [later] = statusAll({
      home,
      runtime: { skillDirectory: home, version: "0.27.1" },
    }).repositories;
    expect(later?.lease).toMatchObject({ awaitingUser: null });
  });

  test("shows unreadable state as unknown and keeps going", () => {
    const home = temporaryHome();
    const broken = initRepository(join(home, "Developer", "broken"));
    mkdirSync(join(broken, ".git", "simple-changes"), { recursive: true });
    writeFileSync(
      join(broken, ".git", "simple-changes", "active-loop.json"),
      "{ not json"
    );

    const report = statusAll({
      home,
      runtime: { skillDirectory: home, version: "0.27.1" },
    });

    const status = statusOf(report.repositories, broken);
    expect(isUnknown(status.lease)).toBe(true);
    expect(status.claims).toEqual([]);
    expect(status.guidance).toMatchObject({ state: "not-configured" });
  });

  test("the CLI prints the same view for the home it runs under", () => {
    const home = temporaryHome();
    const repository = initRepository(join(home, "Developer", "solo"));
    writeFixture(repository, ".simple-changes.json", policy(27));
    const cliPath = fileURLToPath(
      new URL(
        "../../../skills/simple-changes/scripts/simple-changes.ts",
        import.meta.url
      )
    );
    const run = (args: string[]) => {
      const result = spawnSync([process.execPath, cliPath, ...args], {
        cwd: repository,
        env: { ...process.env, HOME: home, SIMPLE_CHANGES_SKILL_ROOTS: "" },
        stderr: "pipe",
        stdout: "pipe",
      });
      return {
        exitCode: result.exitCode,
        stderr: new TextDecoder().decode(result.stderr),
        stdout: new TextDecoder().decode(result.stdout),
      };
    };
    const all = run(["status", "--all", "--json"]);
    expect(all.stderr).toBe("");
    expect(all.exitCode).toBe(0);
    expect(
      (JSON.parse(all.stdout) as { repositories: StatusRepository[] })
        .repositories
    ).toEqual([expect.objectContaining({ lease: null, repository })]);
    const single = run(["status"]);
    expect(single.exitCode).toBe(0);
    expect(single.stdout).toContain(`${repository}\n  Nothing in flight.`);
    expect(single.stdout).toContain("Read-only: nothing was fetched");
    expect(run(["status", "--root", home]).exitCode).toBe(2);
  });
});
