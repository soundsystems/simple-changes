import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "bun";
import {
  loopLeasePath,
  readLoopLease,
} from "../../../skills/simple-changes/scripts/lib/loop-lease-core.ts";
import {
  type PreparedAgentWorktree,
  prepareAgentWorktree,
} from "../../../skills/simple-changes/scripts/lib/loop-lease-worktrees.ts";
import { slug } from "../../../skills/simple-changes/scripts/lib/managed-worktrees.ts";

const decoder = new TextDecoder();

export const git = (cwd: string, args: string[]): string => {
  const result = spawnSync(["git", "-C", cwd, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout.trim();
};

export interface TestRepository {
  base: string;
  cleanup: () => void;
  root: string;
}

export const createTestRepository = (): TestRepository => {
  const temporaryBase = mkdtempSync(join(tmpdir(), "simple-changes-test-"));
  const base = realpathSync(temporaryBase);
  const repositoryPath = join(base, "repo");
  mkdirSync(repositoryPath);
  const root = realpathSync(repositoryPath);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Simple Changes Tests"]);
  git(root, ["config", "user.email", "tests@simple-changes.invalid"]);
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "Initial fixture"]);
  return {
    base,
    cleanup: () => rmSync(temporaryBase, { force: true, recursive: true }),
    root,
  };
};

export const writeFixture = (
  root: string,
  relativePath: string,
  contents: string
): void => {
  const path = join(root, relativePath);
  const separator = relativePath.lastIndexOf("/");
  if (separator >= 0) {
    mkdirSync(join(root, relativePath.slice(0, separator)), {
      recursive: true,
    });
  }
  writeFileSync(path, contents);
};

/**
 * The older managed layout's path for an agent's prepared worktree:
 * `<parent of the primary>/.simple-changes-worktrees/<repository>/<run>-<purpose>-<agent>`.
 */
export const legacyPreparedWorktreePath = (
  primaryCheckout: string,
  runId: string,
  agentId: string,
  purpose: string
): string =>
  join(
    dirname(primaryCheckout),
    ".simple-changes-worktrees",
    slug(basename(primaryCheckout), "repository"),
    `${runId.slice(4, 16)}-${slug(purpose, "work")}-${slug(agentId, "agent")}`
  );

/**
 * Records a pending preparation in the older managed layout, as an older
 * runtime that stopped after writing it would leave it, then lets
 * `prepare-agent` resume it. With `createParents`, the older runtime's
 * parent folders exist first, as that runtime made them before Git ran.
 */
export const prepareLegacyLayoutAgentWorktree = (
  repositoryPath: string,
  runId: string,
  agentId: string,
  purpose: string,
  createParents = true
): PreparedAgentWorktree => {
  const lease = readLoopLease(repositoryPath);
  if (!lease) {
    throw new Error("Expected an active loop lease");
  }
  const path = legacyPreparedWorktreePath(
    lease.primaryCheckout,
    runId,
    agentId,
    purpose
  );
  if (createParents) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const purposeSlug = slug(purpose, "work");
  writeFileSync(
    loopLeasePath(lease.commonGitDirectory),
    `${JSON.stringify(
      {
        ...lease,
        preparations: [
          ...lease.preparations,
          {
            agentId,
            baseRevision: lease.targetRevision,
            branch: `simple-changes/${purposeSlug}-${slug(agentId, "agent")}-${runId.slice(4, 16)}`,
            createdAt: new Date().toISOString(),
            path,
            purpose: purposeSlug,
          },
        ],
      },
      null,
      2
    )}\n`
  );
  return prepareAgentWorktree(repositoryPath, runId, agentId, purpose);
};
