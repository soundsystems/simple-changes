#!/usr/bin/env bun

/**
 * Reference GitLab fetcher for `simple-changes remote-inventory build`. It
 * pages through every project branch and every open, merged, and closed merge
 * request with read-only `glab api` GET calls and writes the normalized pages
 * the core builder reads. It is the only part of the remote inventory that
 * talks to GitLab; nothing in the core calls a provider API.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import { EXIT_CODES, SimpleChangesError } from "../lib/errors.ts";
import type { RemoteInventoryPages } from "../lib/remote-inventory.ts";
import { validateSchema } from "../lib/schema.ts";

const PER_PAGE = 100;
const PAGE_LIMIT = 1000;
const decoder = new TextDecoder();

const USAGE = `Usage: bun gitlab-remote-inventory.ts --project GROUP/PROJECT
  --target-branch BRANCH --output PAGES_FILE [--raw-dir DIR] [--hostname HOST]

Writes normalized remote-inventory pages for one complete GitLab snapshot.
--project is the project path from the target remote URL, not a local path or
numeric ID. --raw-dir keeps every raw API page; each page's responseDigest is
the SHA-256 of its saved bytes. Then run:
  simple-changes remote-inventory build --pages PAGES_FILE --output FILE
`;

export interface FetchOptions {
  /** The glab executable; tests pass a fake one. Defaults to `glab`. */
  glab?: string;
  hostname?: string;
  output: string;
  project: string;
  rawDirectory?: string;
  targetBranch: string;
}

interface GitLabBranch {
  commit?: { id?: unknown };
  name?: unknown;
  protected?: unknown;
}

interface GitLabMergeRequest {
  iid?: unknown;
  sha?: unknown;
  source_branch?: unknown;
  source_project_id?: unknown;
  state?: unknown;
  target_project_id?: unknown;
}

const fail = (message: string): never => {
  throw new SimpleChangesError(message, EXIT_CODES.inventory);
};

const parseArguments = (args: readonly string[]): FetchOptions | null => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? "";
    if (flag === "--help" || flag === "-h") {
      return null;
    }
    const value = args[index + 1];
    if (
      ![
        "--project",
        "--target-branch",
        "--output",
        "--raw-dir",
        "--hostname",
      ].includes(flag) ||
      value === undefined
    ) {
      throw new SimpleChangesError(
        `Unknown or incomplete option ${flag}.\n${USAGE}`,
        EXIT_CODES.usage
      );
    }
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string =>
    values.get(flag) ?? fail(`${flag} is required.\n${USAGE}`);
  const hostname = values.get("--hostname");
  const rawDirectory = values.get("--raw-dir");
  return {
    ...(hostname ? { hostname } : {}),
    output: resolve(required("--output")),
    project: required("--project"),
    ...(rawDirectory ? { rawDirectory: resolve(rawDirectory) } : {}),
    targetBranch: required("--target-branch"),
  };
};

const glabGet = (options: FetchOptions, endpoint: string): Uint8Array => {
  const result = spawnSync(
    [
      options.glab ?? "glab",
      "api",
      ...(options.hostname ? ["--hostname", options.hostname] : []),
      endpoint,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  if (result.exitCode !== 0) {
    fail(
      `glab api ${endpoint} failed: ${decoder.decode(result.stderr).trim() || `exit ${result.exitCode}`}`
    );
  }
  return result.stdout;
};

const fetchPages = <T>(
  options: FetchOptions,
  kind: "branches" | "merge-requests",
  endpoint: (page: number) => string
): Array<{
  cursorIn: string | null;
  cursorOut: string | null;
  responseDigest: string;
  rows: T[];
}> => {
  const pages: Array<{
    cursorIn: string | null;
    cursorOut: string | null;
    responseDigest: string;
    rows: T[];
  }> = [];
  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const bytes = glabGet(options, endpoint(page));
    const rows = JSON.parse(decoder.decode(bytes)) as unknown;
    if (!Array.isArray(rows)) {
      fail(`GitLab returned a non-list ${kind} page ${page}.`);
    }
    if (options.rawDirectory) {
      writeFileSync(join(options.rawDirectory, `${kind}-${page}.json`), bytes);
    }
    const cursorOut =
      (rows as unknown[]).length === PER_PAGE ? String(page + 1) : null;
    pages.push({
      cursorIn: page === 1 ? null : String(page),
      cursorOut,
      responseDigest: createHash("sha256").update(bytes).digest("hex"),
      rows: rows as T[],
    });
    if (cursorOut === null) {
      return pages;
    }
  }
  return fail(
    `GitLab ${kind} pagination did not end within ${PAGE_LIMIT} pages.`
  );
};

const PROPOSAL_STATES: Record<string, "open" | "merged" | "closed"> = {
  closed: "closed",
  // A locked merge request is mid-merge: count it as open, which preserves
  // its branch, until a later inventory sees it merged.
  locked: "open",
  merged: "merged",
  opened: "open",
};

const normalizeBranch = (branch: GitLabBranch) => {
  if (
    typeof branch.name !== "string" ||
    typeof branch.commit?.id !== "string" ||
    typeof branch.protected !== "boolean"
  ) {
    return fail(
      "GitLab returned a branch without a name, commit, or protection flag."
    );
  }
  return {
    headRevision: branch.commit.id,
    name: branch.name,
    protected: branch.protected,
  };
};

const normalizeMergeRequest = (request: GitLabMergeRequest) => {
  const state =
    typeof request.state === "string"
      ? PROPOSAL_STATES[request.state]
      : undefined;
  if (
    typeof request.iid !== "number" ||
    typeof request.source_branch !== "string" ||
    !state
  ) {
    return fail(
      `GitLab returned a merge request without an IID, source branch, or known state (${String(request.state)}).`
    );
  }
  return {
    headRevision: typeof request.sha === "string" ? request.sha : null,
    objectId: String(request.iid),
    sourceBranch: request.source_branch,
    state,
  };
};

export const fetchGitLabRemoteInventory = (
  options: FetchOptions
): RemoteInventoryPages => {
  if (options.rawDirectory) {
    mkdirSync(options.rawDirectory, { recursive: true });
  }
  const project = encodeURIComponent(options.project);
  const branchPages = fetchPages<GitLabBranch>(
    options,
    "branches",
    (page) =>
      `projects/${project}/repository/branches?per_page=${PER_PAGE}&page=${page}`
  );
  // Oldest first, so a merge request opened mid-listing lands on a later page
  // instead of shifting the pages already read.
  const requestPages = fetchPages<GitLabMergeRequest>(
    options,
    "merge-requests",
    (page) =>
      `projects/${project}/merge_requests?state=all&scope=all&order_by=created_at&sort=asc&per_page=${PER_PAGE}&page=${page}`
  );
  const pages: RemoteInventoryPages = {
    branchPages: branchPages.map(({ rows, ...page }) => ({
      ...page,
      branches: rows.map(normalizeBranch),
    })),
    ...(options.rawDirectory
      ? {
          evidence: [
            `Raw GitLab pages are saved in ${options.rawDirectory}; each page's responseDigest is the SHA-256 of its saved bytes.`,
          ],
        }
      : {}),
    observedAt: new Date().toISOString(),
    project: options.project,
    // Merge requests from forks name the fork's branches, not this project's.
    proposalPages: requestPages.map(({ rows, ...page }) => ({
      ...page,
      proposals: rows
        .filter(
          (request) => request.source_project_id === request.target_project_id
        )
        .map(normalizeMergeRequest),
    })),
    provider: "gitlab",
    schemaVersion: 1,
    targetBranch: options.targetBranch,
  };
  return validateSchema<RemoteInventoryPages>("remote-inventory-pages", pages);
};

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options) {
      const pages = fetchGitLabRemoteInventory(options);
      writeFileSync(options.output, `${JSON.stringify(pages, null, 2)}\n`);
      process.stdout.write(
        `Fetched ${pages.branchPages.reduce((total, page) => total + page.branches.length, 0)} branch(es) and ${pages.proposalPages.reduce((total, page) => total + page.proposals.length, 0)} merge request(s) from ${options.project}; wrote ${options.output}.\n`
      );
    } else {
      process.stdout.write(USAGE);
    }
  } catch (error) {
    const exitCode =
      error instanceof SimpleChangesError
        ? error.exitCode
        : EXIT_CODES.inventory;
    process.stderr.write(
      `gitlab-remote-inventory: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = exitCode;
  }
}
