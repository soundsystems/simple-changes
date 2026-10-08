#!/usr/bin/env bun

/**
 * `bun run check:receipt`: runs `bun run check` on a clean checkout and, only
 * when it exits 0 and leaves the checkout clean at the same commit, records a
 * check receipt for that exact HEAD under the Git common directory. The
 * repository's execGuard (`tooling/merge-gate/exec-guard.ts`) requires one
 * before a merge-like `loop exec` command. See CONTRIBUTING.md.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "bun";
import {
  CHECK_COMMAND,
  type CheckReceipt,
  commonGitDirectory,
  git,
  receiptPath,
  resolveCommit,
} from "./merge-gate.ts";

class CheckReceiptRefusal extends Error {}

const fail = (message: string): never => {
  throw new CheckReceiptRefusal(message);
};

const dirtyPaths = (root: string): string[] => {
  const status = git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0) {
    return fail(
      `git status failed (exit ${status.exitCode}), so the checkout cannot be shown clean; no receipt was recorded.`
    );
  }
  return status.stdout.split("\n").filter(Boolean);
};

const assertClean = (root: string, when: string): void => {
  const dirty = dirtyPaths(root);
  if (dirty.length > 0) {
    fail(
      `the checkout is not clean ${when} (${dirty.slice(0, 5).join("; ")}${dirty.length > 5 ? "; ..." : ""}). A receipt covers only a committed, unchanged tree: commit or set aside every change, then run again.`
    );
  }
};

export const runCheckReceipt = (cwd: string): number => {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) {
    return fail("run this inside the repository checkout.");
  }
  const root = top.stdout;
  const common = commonGitDirectory(root) ?? fail("no Git common directory.");
  const head = resolveCommit(root, "HEAD") ?? fail("HEAD is not a commit.");
  const treeRead = git(root, ["rev-parse", "--verify", `${head}^{tree}`]);
  const tree =
    treeRead.exitCode === 0 && treeRead.stdout
      ? treeRead.stdout
      : fail(`the tree of ${head} could not be read.`);
  assertClean(root, "before the check");
  const startedAt = new Date().toISOString();
  const check = spawnSync([...CHECK_COMMAND], {
    cwd: root,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  const exitCode = check.exitCode ?? 1;
  if (exitCode !== 0) {
    process.stderr.write(
      `check:receipt: \`${CHECK_COMMAND.join(" ")}\` exited ${exitCode}; no receipt was recorded for ${head}.\n`
    );
    return exitCode;
  }
  if (resolveCommit(root, "HEAD") !== head) {
    return fail(
      `HEAD moved from ${head} during the check; no receipt was recorded.`
    );
  }
  assertClean(root, "after the check");
  const receipt: CheckReceipt = {
    command: [...CHECK_COMMAND],
    exitCode: 0,
    finishedAt: new Date().toISOString(),
    headSha: head,
    kind: "check-receipt",
    runtime: `bun ${process.versions.bun}`,
    schemaVersion: 1,
    startedAt,
    treeSha: tree,
  };
  const path = receiptPath(common, head);
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
  process.stdout.write(
    `check:receipt: recorded a passing \`${CHECK_COMMAND.join(" ")}\` for ${head} at ${path}.\n`
  );
  return 0;
};

if (import.meta.main) {
  try {
    process.exitCode = runCheckReceipt(process.cwd());
  } catch (error) {
    if (!(error instanceof CheckReceiptRefusal)) {
      throw error;
    }
    process.stderr.write(`check:receipt: ${error.message}\n`);
    process.exitCode = 1;
  }
}
