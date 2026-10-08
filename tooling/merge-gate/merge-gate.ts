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
 * Receipt (schemaVersion 1), one per commit, written only for exit 0, in the
 * same format as Simple Changelogs' merge gate so both repositories read it
 * alike:
 *   <git common dir>/check-receipts/<40-hex HEAD>.json
 *   { "command": "bun run check", "exitCode": 0,
 *     "finishedAt": "<UTC ISO 8601>", "head": "<40-hex HEAD>",
 *     "schemaVersion": 1 }
 * A commit names exactly one tree, so `head` pins the checked contents.
 */

export const CHECK_COMMAND = ["bun", "run", "check"] as const;
export const RECEIPT_COMMAND = "bun run check";
export const RECEIPT_DIRECTORY = "check-receipts";
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const decoder = new TextDecoder();

export interface CheckReceipt {
  command: typeof RECEIPT_COMMAND;
  exitCode: 0;
  finishedAt: string;
  head: string;
  schemaVersion: 1;
}

/**
 * Git sees real objects and history only: no replacement refs and no legacy
 * graft file, either of which can show a commit with another tree or other
 * parents than the ones a push or a provider merge actually transfers.
 */
export const REAL_HISTORY_ENVIRONMENT = {
  GIT_GRAFT_FILE: "/dev/null/no-grafts",
  GIT_NO_REPLACE_OBJECTS: "1",
} as const;

export const git = (
  cwd: string,
  args: readonly string[]
): { exitCode: number; stdout: string } => {
  const result = spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      ...REAL_HISTORY_ENVIRONMENT,
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
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

export const receiptPath = (common: string, head: string): string =>
  join(common, RECEIPT_DIRECTORY, `${head}.json`);

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

const RECEIPT_KEYS = [
  "command",
  "exitCode",
  "finishedAt",
  "head",
  "schemaVersion",
].join(",");

const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MILLISECONDS_PATTERN = /\.\d{3}Z$/u;

/**
 * A real UTC ISO 8601 time, as `Date#toISOString` writes it, with or without
 * milliseconds. Parsing normalizes an impossible date such as February 30,
 * so the input must equal the canonical form of the time it parses to.
 */
const isUtcTime = (value: unknown): boolean => {
  if (typeof value !== "string" || !ISO_TIME_PATTERN.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return false;
  }
  const canonical = new Date(time).toISOString();
  return (
    value === canonical ||
    value === canonical.replace(MILLISECONDS_PATTERN, "Z")
  );
};

/** The receipt's finish time: UTC ISO 8601 at seconds precision. */
export const receiptTime = (date: Date): string =>
  date.toISOString().replace(MILLISECONDS_PATTERN, "Z");

/** The complete receipt shape, bound to exactly this commit. */
const isPassingReceipt = (
  receipt: Partial<CheckReceipt>,
  sha: string
): boolean =>
  Object.keys(receipt).sort().join(",") === RECEIPT_KEYS &&
  receipt.schemaVersion === 1 &&
  receipt.command === RECEIPT_COMMAND &&
  receipt.exitCode === 0 &&
  receipt.head === sha &&
  isUtcTime(receipt.finishedAt);

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return `no passing \`bun run check\` receipt exists for ${sha}. Check out that exact commit cleanly and run \`bun run check:receipt\`, then retry.`;
  }
  const receipt =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Partial<CheckReceipt>)
      : {};
  if (!isPassingReceipt(receipt, sha)) {
    return `the check receipt at ${path} does not record a passing \`bun run check\` for ${sha}; run \`bun run check:receipt\` on that commit again.`;
  }
  return null;
};
