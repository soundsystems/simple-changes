import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "bun";

/**
 * This repository's merge gate. It has no CI and no Git hooks, so a passing
 * `bun run check` is the merge evidence. `bun run check:receipt` records that
 * evidence for one exact commit, and the `execGuard` in `.simple-changes.json`
 * refuses a merge-like `loop exec` command unless a receipt exists for the
 * exact commit it would ship. See CONTRIBUTING.md.
 *
 * Receipt (schemaVersion 1), one per commit, written only for exit 0:
 *   <git common dir>/check-receipts/<40-hex head SHA>.json
 *   { schemaVersion: 1, kind: "check-receipt", command: ["bun", "run",
 *     "check"], exitCode: 0, headSha, treeSha, startedAt, finishedAt,
 *     runtime }
 */

export const CHECK_COMMAND = ["bun", "run", "check"] as const;
export const RECEIPT_DIRECTORY = "check-receipts";
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const decoder = new TextDecoder();

export interface CheckReceipt {
  command: string[];
  exitCode: 0;
  finishedAt: string;
  headSha: string;
  kind: "check-receipt";
  runtime: string;
  schemaVersion: 1;
  startedAt: string;
  treeSha: string;
}

export const git = (
  cwd: string,
  args: readonly string[]
): { exitCode: number; stdout: string } => {
  const result = spawnSync(["git", "-C", cwd, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: decoder.decode(result.stdout).trim(),
  };
};

export const commonGitDirectory = (cwd: string): string | null => {
  const result = git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return result.exitCode === 0 && isAbsolute(result.stdout)
    ? result.stdout
    : null;
};

export const receiptPath = (common: string, headSha: string): string =>
  join(common, RECEIPT_DIRECTORY, `${headSha}.json`);

export const resolveCommit = (cwd: string, revision: string): string | null => {
  const result = git(cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  return result.exitCode === 0 && FULL_SHA_PATTERN.test(result.stdout)
    ? result.stdout
    : null;
};

/**
 * Null when `cwd`'s repository holds a passing receipt for exactly
 * `revision`; otherwise why not, phrased for the person who must fix it.
 */
export const receiptProblem = (
  cwd: string,
  revision: string
): string | null => {
  const sha = resolveCommit(cwd, revision);
  if (!sha) {
    return `${revision} is not a commit in this repository, so no check receipt can cover it.`;
  }
  const common = commonGitDirectory(cwd);
  if (!common) {
    return "the Git common directory could not be found.";
  }
  const path = receiptPath(common, sha);
  let receipt: Partial<CheckReceipt>;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8")) as Partial<CheckReceipt>;
  } catch {
    return `no passing \`bun run check\` receipt exists for ${sha}. Check out that exact commit cleanly and run \`bun run check:receipt\`, then retry.`;
  }
  const tree = git(cwd, ["rev-parse", "--verify", `${sha}^{tree}`]).stdout;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "check-receipt" ||
    receipt.exitCode !== 0 ||
    receipt.headSha !== sha ||
    receipt.treeSha !== tree ||
    JSON.stringify(receipt.command) !== JSON.stringify(CHECK_COMMAND)
  ) {
    return `the check receipt at ${path} does not record a passing \`bun run check\` for ${sha}; run \`bun run check:receipt\` on that commit again.`;
  }
  return null;
};
