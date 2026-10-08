#!/usr/bin/env bun

/**
 * This repository's `execGuard` (see `.simple-changes.json` and
 * CONTRIBUTING.md). Simple Changes runs `[...execGuard, ...command]` before
 * every `loop exec` child. The guard reads `git`, `glab`, and `gh` argv with a
 * closed grammar: it refuses a merge-like command unless a passing
 * `bun run check` receipt exists for the exact commit it would ship, refuses
 * any form it does not support rather than guessing what it does, and exits
 * 0 for every other command:
 *
 * - a provider merge: `glab mr merge --sha <sha>`, a non-GET `glab api` or
 *   `gh api` call to a merge request or pull request `merge` endpoint with
 *   `sha=<sha>`, or `gh pr merge --match-head-commit <sha>`, whose head must
 *   also contain the fetched upstream target;
 * - `git push <remote> <refspec>...` to a target branch;
 * - `git merge --ff-only` or `git pull --ff-only` while a target branch is
 *   checked out, to a published or receipted commit.
 *
 * The enforcement boundary is `loop exec` with these plain argv forms. The
 * guard sees only the argv `loop exec` runs, so a merge run any other way, or
 * by a program that runs other programs (interpreters, build tools, `xargs`),
 * is outside it: it is a convenience gate for this repository's controller,
 * not a security boundary.
 */

import { basename, resolve } from "node:path";
import { git, receiptProblem, resolveCommit } from "./merge-gate.ts";

export interface GuardDecision {
  allow: boolean;
  reason: string;
}

interface GuardContext {
  cwd: string;
  /** Provider projects (path or ID) whose merges the guard may allow. */
  projects: readonly string[];
  targets: readonly string[];
}

const allow = (reason = "not a gated command"): GuardDecision => ({
  allow: true,
  reason,
});
const refuse = (reason: string): GuardDecision => ({ allow: false, reason });

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SHELL_RISK_PATTERN = /\b(?:git|glab|gh)\b|\$(?:[@*0-9]|\{)/u;
const SHELL_COMMAND_FLAG_PATTERN = /^-[A-Za-z]*c[A-Za-z]*$/u;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SHORT_CLUSTER_PATTERN = /^-[A-Za-z]{2,}$/u;
const LEADING_SLASHES_PATTERN = /^\/+/u;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/u;
const REBASE_EXEC_SHORT_PATTERN = /^-[A-Za-z]*x/u;
const SCP_REMOTE_PATTERN = /^[^/:]+@[^:]+:(.+)$/u;
const DOT_GIT_PATTERN = /\.git$/u;

// ------------------------------------------------------------- evidence

/** Gate one exact commit on its check receipt. */
const requireReceipt = (
  context: GuardContext,
  revision: string,
  what: string
): GuardDecision => {
  const problem = receiptProblem(context.cwd, revision);
  return problem
    ? refuse(`${what}: ${problem}`)
    : allow(`${what}: a passing check receipt covers ${revision}`);
};

/**
 * The published copy of `branch`: exactly `refs/remotes/<remote>/<branch>`
 * for the remote `branch` tracks (origin by default), never another remote's
 * branch of the same name or a remote branch such as `feature/main`.
 */
const publishedRef = (cwd: string, branch: string): string | null => {
  const remote =
    git(cwd, ["config", "--get", `branch.${branch}.remote`]).stdout || "origin";
  const ref = `refs/remotes/${remote}/${branch}`;
  return git(cwd, ["show-ref", "--verify", "--quiet", ref]).exitCode === 0
    ? ref
    : null;
};

const publishedContains = (
  cwd: string,
  branch: string,
  commit: string
): boolean => {
  const ref = publishedRef(cwd, branch);
  return (
    ref !== null &&
    git(cwd, ["merge-base", "--is-ancestor", commit, ref]).exitCode === 0
  );
};

/**
 * A provider merge ships the merge of `sha` into the target. That result is
 * exactly the checked tree only when `sha` already contains the fetched
 * upstream target, so require that as well as the receipt. The provider can
 * still merge onto a target that moved after the last fetch; fetch right
 * before merging.
 */
const requireProviderMerge = (
  context: GuardContext,
  sha: string,
  what: string,
  project: string | null
): GuardDecision => {
  if (!(project && context.projects.includes(project))) {
    return refuse(
      `${what}: project ${project ?? "(unknown)"} is not one the guard is configured for (--project), so it cannot tell which target the merge moves`
    );
  }
  const checked = requireReceipt(context, sha, what);
  const commit = resolveCommit(context.cwd, sha);
  if (!(checked.allow && commit)) {
    return checked;
  }
  for (const target of context.targets) {
    const ref = publishedRef(context.cwd, target);
    if (!ref) {
      return refuse(
        `${what}: no fetched upstream copy of ${target} exists, so the guard cannot prove the merge ships exactly ${sha}; fetch the target first`
      );
    }
    if (
      git(context.cwd, ["merge-base", "--is-ancestor", ref, commit])
        .exitCode !== 0
    ) {
      return refuse(
        `${what}: ${sha} does not contain ${ref}, so the merge would ship a tree no receipt covers; update the branch from the target, check it again, then merge`
      );
    }
  }
  return checked;
};

// ------------------------------------------------------- argument scanning

interface ScannedOption {
  name: string;
  value: string | null;
}

interface Scanned {
  options: ScannedOption[];
  positional: string[];
}

/** Splits arguments into options (with values for `valued`) and operands. */
const scan = (args: readonly string[], valued: readonly string[]): Scanned => {
  const options: ScannedOption[] = [];
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    const equals = argument.indexOf("=");
    if (!argument.startsWith("-") || argument === "-") {
      positional.push(argument);
    } else if (argument.startsWith("--") && equals > 0) {
      options.push({
        name: argument.slice(0, equals),
        value: argument.slice(equals + 1),
      });
    } else if (valued.includes(argument)) {
      options.push({ name: argument, value: args[index + 1] ?? "" });
      index += 1;
    } else {
      options.push({ name: argument, value: null });
    }
  }
  return { options, positional };
};

const valuesOf = (scanned: Scanned, names: readonly string[]): string[] =>
  scanned.options
    .filter((option) => names.includes(option.name) && option.value !== null)
    .map((option) => option.value as string);

const lastValue = (scanned: Scanned, names: readonly string[]): string | null =>
  valuesOf(scanned, names).at(-1) ?? null;

const hasOption = (scanned: Scanned, names: readonly string[]): boolean =>
  scanned.options.some((option) => names.includes(option.name));

/**
 * Option names exactly as written. Short options are never split as a
 * cluster: Git and the provider CLIs read `-on` as `-o` with the value `n`,
 * so a cluster or an attached short value is unsupported and refused.
 */
const flagNames = (scanned: Scanned): string[] =>
  scanned.options.map(({ name }) => name);

/** The first option outside `supported`, which the guard refuses. */
const unsupportedFlag = (
  scanned: Scanned,
  supported: ReadonlySet<string>
): string | undefined =>
  flagNames(scanned).find(
    (name) => SHORT_CLUSTER_PATTERN.test(name) || !supported.has(name)
  );

// ------------------------------------------------------------------- git

interface GitInvocation {
  args: string[];
  cwd: string;
  subcommand: string;
}

/** Global options that only change paging, locks, pathspecs, or advice. */
const GIT_GLOBAL_FLAGS = new Set([
  "--no-pager",
  "-P",
  "-p",
  "--paginate",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--no-advice",
]);

/**
 * Subcommands that cannot move a remote branch, besides `push`, `merge`, and
 * `pull`, which are checked. Anything else, including aliases and `git-*`
 * programs on the PATH, is refused.
 */
const GIT_SAFE_SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "archive",
  "blame",
  "branch",
  "bundle",
  "cat-file",
  "check-attr",
  "check-ignore",
  "checkout",
  "cherry",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "commit-tree",
  "config",
  "count-objects",
  "describe",
  "diff",
  "diff-tree",
  "fetch",
  "for-each-ref",
  "format-patch",
  "fsck",
  "gc",
  "grep",
  "hash-object",
  "help",
  "init",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "mktag",
  "mktree",
  "mv",
  "name-rev",
  "notes",
  "prune",
  "range-diff",
  "read-tree",
  "rebase",
  "reflog",
  "remote",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "revert",
  "rm",
  "shortlog",
  "show",
  "show-ref",
  "stash",
  "status",
  "switch",
  "symbolic-ref",
  "tag",
  "update-index",
  "update-ref",
  "var",
  "verify-commit",
  "verify-tag",
  "version",
  "worktree",
  "write-tree",
]);

/** Parses `git [-C dir] [safe global flags] <subcommand> <args>`. */
const parseGit = (
  argv: readonly string[],
  cwd: string
): GitInvocation | GuardDecision => {
  let directory = cwd;
  let index = 1;
  while ((argv[index] ?? "").startsWith("-")) {
    const argument = argv[index] ?? "";
    if (argument === "-C") {
      directory = resolve(directory, argv[index + 1] ?? "");
      index += 2;
    } else if (GIT_GLOBAL_FLAGS.has(argument)) {
      index += 1;
    } else {
      return refuse(
        `git ${argument} can change which repository, configuration, refs, or remotes git uses; run git without it`
      );
    }
  }
  const subcommand = argv[index];
  return subcommand
    ? { args: argv.slice(index + 1), cwd: directory, subcommand }
    : allow();
};

const gitIn = (invocation: GitInvocation, args: readonly string[]) =>
  git(invocation.cwd, args);

const gitConfig = (invocation: GitInvocation, key: string): string =>
  gitIn(invocation, ["config", "--get", key]).stdout;

const currentBranch = (invocation: GitInvocation): string | null => {
  const result = gitIn(invocation, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  return result.exitCode === 0 && result.stdout ? result.stdout : null;
};

/** Git's rules for completing an abbreviated push destination. */
const DESTINATION_RULES = [
  "%s",
  "refs/%s",
  "refs/tags/%s",
  "refs/heads/%s",
  "refs/remotes/%s",
  "refs/remotes/%s/HEAD",
];

/**
 * The target branch a push destination can update. An abbreviated
 * destination such as `main` or `heads/main` counts when any of Git's
 * completion rules turns it into the target's full ref.
 */
const targetOf = (
  destination: string,
  targets: readonly string[]
): string | null => {
  const candidates = destination.startsWith("refs/")
    ? [destination]
    : DESTINATION_RULES.map((rule) => rule.replace("%s", destination));
  return (
    targets.find((target) => candidates.includes(`refs/heads/${target}`)) ??
    null
  );
};

/** A git subcommand form that runs other programs the guard cannot see. */
const runsOtherCommands = (invocation: GitInvocation): boolean => {
  const { args, subcommand } = invocation;
  return (
    (subcommand === "rebase" &&
      args.some(
        (arg) => REBASE_EXEC_SHORT_PATTERN.test(arg) || arg.startsWith("--exec")
      )) ||
    (subcommand === "submodule" && args.includes("foreach")) ||
    (subcommand === "bisect" && args.includes("run"))
  );
};

const PUSH_FLAGS = new Set([
  "-u",
  "--set-upstream",
  "-f",
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--porcelain",
  "--no-verify",
  "--progress",
  "--no-progress",
  "--atomic",
  "--follow-tags",
  "--no-follow-tags",
  "--tags",
  "-d",
  "--delete",
  "-n",
  "--dry-run",
  "-o",
  "--push-option",
]);

/** One refspec's verdict, or null when it cannot move a target branch. */
const pushRefspec = (
  invocation: GitInvocation,
  context: GuardContext,
  spec: string,
  deleting: boolean
): GuardDecision | null => {
  const refspec = spec.startsWith("+") ? spec.slice(1) : spec;
  if (refspec.includes("*")) {
    return refuse(
      `the pattern refspec ${spec} can push many branches; push one exact refspec instead`
    );
  }
  if (deleting) {
    const branch = targetOf(refspec, context.targets);
    return branch
      ? refuse(`git push would delete target branch ${branch}`)
      : null;
  }
  const separator = refspec.indexOf(":");
  if (separator === -1) {
    return refuse(
      `the refspec ${spec} lets configuration (push.default, upstreams, remote push mappings) choose its destination; write it as <source>:<destination>`
    );
  }
  const source = refspec.slice(0, separator);
  const destination = refspec.slice(separator + 1);
  if (!(destination || source)) {
    return refuse(
      `the refspec ${spec} pushes every matching branch; push one exact refspec instead`
    );
  }
  const branch = targetOf(destination, context.targets);
  if (!branch) {
    return null;
  }
  if (!source) {
    return refuse(`git push would delete target branch ${branch}`);
  }
  const commit = resolveCommit(invocation.cwd, source);
  return commit
    ? requireReceipt(context, commit, `git push to ${branch}`)
    : refuse(
        `git push to ${branch} names ${source}, which is not a local commit`
      );
};

/**
 * `git push <remote> <refspec>...` only: a push without a remote or
 * refspecs, or to a mirroring remote, goes wherever configuration says.
 */
const gitPush = (
  invocation: GitInvocation,
  context: GuardContext
): GuardDecision => {
  const scanned = scan(invocation.args, ["-o", "--push-option"]);
  const unsupported = unsupportedFlag(scanned, PUSH_FLAGS);
  if (unsupported) {
    return refuse(
      `git push ${unsupported} is not a form the merge gate supports; push with an explicit remote and refspecs`
    );
  }
  const flags = flagNames(scanned);
  if (flags.includes("-n") || flags.includes("--dry-run")) {
    return allow("git push --dry-run moves nothing");
  }
  const [remote, ...refspecs] = scanned.positional;
  if (!remote) {
    return refuse(
      "git push without a remote goes wherever configuration says; name the remote and each refspec"
    );
  }
  if (gitConfig(invocation, `remote.${remote}.mirror`) === "true") {
    return refuse(
      `remote ${remote} mirrors every ref, so any push to it can move a target branch`
    );
  }
  if (refspecs.length === 0) {
    return flags.includes("--tags")
      ? allow("git push --tags without refspecs pushes only tags")
      : refuse(
          "git push without refspecs pushes whatever configuration says; name each refspec"
        );
  }
  const deleting = flags.includes("-d") || flags.includes("--delete");
  for (const spec of refspecs) {
    const decision = pushRefspec(invocation, context, spec, deleting);
    if (decision && !decision.allow) {
      return decision;
    }
  }
  return allow("git push: every target refspec has a passing check receipt");
};

const MERGE_FLAGS = new Set([
  "--ff-only",
  "--abort",
  "--quit",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--stat",
  "--no-stat",
  "-n",
  "--progress",
  "--no-progress",
]);
const PULL_FLAGS = new Set([
  "--ff-only",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "--stat",
  "--no-stat",
  "-n",
  "--progress",
  "--no-progress",
]);

/**
 * `git pull --ff-only` on a target branch from its own upstream: the result
 * is the published target, which every merge into it already passed.
 */
const gitPullOnTarget = (
  invocation: GitInvocation,
  branch: string,
  scanned: Scanned
): GuardDecision => {
  const upstreamRemote =
    gitConfig(invocation, `branch.${branch}.remote`) || "origin";
  const [remote, ...sources] = scanned.positional;
  const fromUpstream =
    remote === undefined ||
    (remote === upstreamRemote &&
      (sources.length === 0 ||
        (sources.length === 1 &&
          (sources[0] === branch || sources[0] === `refs/heads/${branch}`))));
  const upstream = gitIn(invocation, [
    "rev-parse",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  ]).stdout;
  return fromUpstream && upstream === publishedRef(invocation.cwd, branch)
    ? allow(`git pull --ff-only syncs ${branch} with its published remote`)
    : refuse(
        `git pull on ${branch} would bring in something other than the published ${branch}; fetch, then merge one checked commit with --ff-only`
      );
};

/**
 * `git merge --ff-only` on a target branch: to a commit the published target
 * already contains, or to one commit a receipt covers.
 */
const gitMergeOnTarget = (
  invocation: GitInvocation,
  context: GuardContext,
  branch: string,
  scanned: Scanned
): GuardDecision => {
  const sources =
    scanned.positional.length > 0
      ? scanned.positional
      : [`${branch}@{upstream}`];
  const [only] = sources.map((source) => resolveCommit(invocation.cwd, source));
  if (!only || sources.length !== 1) {
    return refuse(
      `git merge into ${branch} must fast-forward to exactly one local commit`
    );
  }
  return publishedContains(invocation.cwd, branch, only)
    ? allow(`git merge only syncs ${branch} with its published remote`)
    : requireReceipt(context, only, `git merge into ${branch}`);
};

const gitMerge = (
  invocation: GitInvocation,
  context: GuardContext
): GuardDecision => {
  const branch = currentBranch(invocation);
  if (!(branch && context.targets.includes(branch))) {
    return allow();
  }
  const pulling = invocation.subcommand === "pull";
  const scanned = scan(invocation.args, []);
  const unsupported = unsupportedFlag(
    scanned,
    pulling ? PULL_FLAGS : MERGE_FLAGS
  );
  if (unsupported) {
    return refuse(
      `git ${invocation.subcommand} ${unsupported} on ${branch} is not a form the merge gate supports; use --ff-only to a published or checked commit`
    );
  }
  const flags = flagNames(scanned);
  if (!pulling && (flags.includes("--abort") || flags.includes("--quit"))) {
    return allow("abandoning a merge adds no commit");
  }
  if (!flags.includes("--ff-only")) {
    return refuse(
      `git ${invocation.subcommand} on ${branch} can create a commit no receipt covers; use --ff-only`
    );
  }
  return pulling
    ? gitPullOnTarget(invocation, branch, scanned)
    : gitMergeOnTarget(invocation, context, branch, scanned);
};

const analyzeGit = (
  argv: readonly string[],
  context: GuardContext
): GuardDecision => {
  const parsed = parseGit(argv, context.cwd);
  if ("allow" in parsed) {
    return parsed;
  }
  const scoped = { ...context, cwd: parsed.cwd };
  const { subcommand } = parsed;
  if (subcommand === "push") {
    return gitPush(parsed, scoped);
  }
  if (subcommand === "merge" || subcommand === "pull") {
    return gitMerge(parsed, scoped);
  }
  if (!GIT_SAFE_SUBCOMMANDS.has(subcommand)) {
    return refuse(
      `git ${subcommand} is not a command the merge gate recognizes (an alias, a git-* program, or a raw transport could push); run a built-in git command`
    );
  }
  return runsOtherCommands(parsed)
    ? refuse(
        `git ${subcommand} runs other commands the guard cannot see; run them directly`
      )
    : allow();
};

// ------------------------------------------------------- provider merges

const API_VALUED = [
  "-X",
  "--method",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-H",
  "--header",
  "--hostname",
  "--input",
  "-R",
  "--repo",
  "-q",
  "--jq",
  "-t",
  "--template",
];
const FIELD_OPTIONS = ["-f", "--raw-field", "-F", "--field"];
const API_FLAGS = new Set([
  "-i",
  "--include",
  "--paginate",
  "--silent",
  "--slurp",
  "--verbose",
]);
const URL_PREFIX_PATTERN = /^[a-z]+:\/\/[^/]+\//iu;
const API_VERSION_PATTERN = /^api\/v\d+\//u;

interface ApiCall {
  method: string;
  /** The endpoint path split into percent-decoded segments. */
  segments: string[];
  /** Every `sha` the call carries, from fields and the query string. */
  shas: string[];
}

/** The decoded endpoint path segments, or null for invalid encoding. */
const endpointSegments = (path: string): string[] | null => {
  try {
    return path
      .replace(URL_PREFIX_PATTERN, "")
      .replace(LEADING_SLASHES_PATTERN, "")
      .replace(API_VERSION_PATTERN, "")
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
};

const parseApiCall = (
  args: readonly string[],
  tool: string
): ApiCall | GuardDecision => {
  const scanned = scan(args, API_VALUED);
  const unsupported = scanned.options.find(
    ({ name }) => !(API_VALUED.includes(name) || API_FLAGS.has(name))
  );
  if (unsupported) {
    return refuse(
      `${tool} api ${unsupported.name} is not a form the merge gate supports; pass each option and its value separately, such as -X PUT`
    );
  }
  const [endpoint = ""] = scanned.positional;
  const [path = "", query = ""] = endpoint.split("?");
  const segments = endpointSegments(path);
  if (!segments) {
    return refuse(`${tool} api endpoint ${path} is not valid percent-encoding`);
  }
  const fields = valuesOf(scanned, FIELD_OPTIONS);
  const input = hasOption(scanned, ["--input"]);
  return {
    method:
      lastValue(scanned, ["-X", "--method"])?.toUpperCase() ??
      (fields.length > 0 || input ? "POST" : "GET"),
    segments,
    shas: [
      ...fields
        .filter((field) => field.startsWith("sha="))
        .map((field) => field.slice("sha=".length)),
      ...new URLSearchParams(query).getAll("sha"),
      // A body read from a file or stdin can carry a sha the guard never sees.
      ...(input ? ["(--input body)"] : []),
    ],
  };
};

type ApiRoute = "allow" | "merge" | `delete:${string}`;

/**
 * The provider mutations the controller needs, by method and path after the
 * project: proposal create, update, and comments; the exact merge endpoint;
 * and branch deletion. Every other mutation, including GraphQL, is refused.
 */
const API_ROUTES: ReadonlyArray<{
  method: string;
  route: (rest: readonly string[]) => ApiRoute | null;
}> = [
  // GitLab: projects/<project>/...
  {
    method: "POST",
    route: (rest) =>
      rest.length === 1 && rest[0] === "merge_requests" ? "allow" : null,
  },
  {
    method: "PUT",
    route: (rest) =>
      rest.length === 2 && rest[0] === "merge_requests" ? "allow" : null,
  },
  {
    method: "POST",
    route: (rest) =>
      rest.length === 3 && rest[0] === "merge_requests" && rest[2] === "notes"
        ? "allow"
        : null,
  },
  {
    method: "PUT",
    route: (rest) =>
      rest.length === 3 &&
      (rest[0] === "merge_requests" || rest[0] === "pulls") &&
      rest[2] === "merge"
        ? "merge"
        : null,
  },
  {
    method: "DELETE",
    route: (rest) =>
      rest[0] === "repository" && rest[1] === "branches" && rest.length > 2
        ? `delete:${rest.slice(2).join("/")}`
        : null,
  },
  // GitHub: repos/<owner>/<repo>/...
  {
    method: "POST",
    route: (rest) =>
      rest.length === 1 && rest[0] === "pulls" ? "allow" : null,
  },
  {
    method: "PATCH",
    route: (rest) =>
      rest.length === 2 && rest[0] === "pulls" ? "allow" : null,
  },
  {
    method: "POST",
    route: (rest) =>
      rest.length === 3 && rest[0] === "issues" && rest[2] === "comments"
        ? "allow"
        : null,
  },
  {
    method: "DELETE",
    route: (rest) =>
      rest[0] === "git" && rest[1] === "refs" && rest[2] === "heads"
        ? `delete:${rest.slice(3).join("/")}`
        : null,
  },
];

/** The project a provider path names and the path after it. */
const projectOf = (
  segments: readonly string[]
): { project: string; rest: string[] } | null => {
  if (segments[0] === "projects" && segments[1]) {
    return { project: segments[1], rest: segments.slice(2) };
  }
  if (segments[0] === "repos" && segments[1] && segments[2]) {
    return {
      project: `${segments[1]}/${segments[2]}`,
      rest: segments.slice(3),
    };
  }
  return null;
};

const apiMerge = (
  args: readonly string[],
  context: GuardContext,
  tool: string
): GuardDecision => {
  const call = parseApiCall(args, tool);
  if ("allow" in call) {
    return call;
  }
  if (call.method === "GET") {
    return allow(`${tool} api GET reads only`);
  }
  const what = `${tool} api ${call.method} ${call.segments.join("/")}`;
  const scoped = projectOf(call.segments);
  const route = scoped
    ? API_ROUTES.filter((item) => item.method === call.method)
        .map((item) => item.route(scoped.rest))
        .find((found) => found !== null)
    : undefined;
  if (!(scoped && route)) {
    return refuse(
      `${what} is not a provider mutation the merge gate supports; it could move a target branch the guard cannot check`
    );
  }
  if (route.startsWith("delete:")) {
    const branch = route.slice("delete:".length);
    return context.targets.includes(branch)
      ? refuse(`${what} would delete target branch ${branch}`)
      : allow(`${what} deletes a non-target branch`);
  }
  if (route === "allow") {
    return allow(`${what} does not merge`);
  }
  const [sha] = call.shas;
  if (call.shas.length !== 1 || !sha || !SHA_PATTERN.test(sha)) {
    return refuse(
      `${what} must name exactly one sha=<exact head> field, with no --input body, so the merge is bound to one checked commit`
    );
  }
  return requireProviderMerge(context, sha, what, scoped.project);
};

/** The provider project an origin URL names, such as `group/project`. */
const originProject = (cwd: string): string | null => {
  const url = git(cwd, ["config", "--get", "remote.origin.url"]).stdout;
  const scpLike = SCP_REMOTE_PATTERN.exec(url)?.[1];
  let path = scpLike ?? "";
  if (!scpLike) {
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
  }
  return (
    path.replace(LEADING_SLASHES_PATTERN, "").replace(DOT_GIT_PATTERN, "") ||
    null
  );
};

/**
 * A provider CLI merge, wherever its global flags put the subcommand words,
 * bound to the head named by `shaFlag` and to its `-R` project or origin.
 */
interface CliMergeGrammar {
  flags: ReadonlySet<string>;
  shaFlag: string;
  valued: readonly string[];
  what: string;
}

/**
 * The options each CLI merge accepts, each written on its own: an attached
 * short value such as `-Rother/project` or a cluster such as `-sd` is
 * refused, so the guard reads the same project and head the CLI would.
 */
const GLAB_MERGE: CliMergeGrammar = {
  flags: new Set([
    "-s",
    "--squash",
    "-d",
    "--remove-source-branch",
    "-r",
    "--rebase",
    "-y",
    "--yes",
    "--auto-merge",
  ]),
  shaFlag: "--sha",
  valued: ["--sha", "-R", "--repo", "-m", "--message", "--squash-message"],
  what: "glab mr merge",
};
const GH_MERGE: CliMergeGrammar = {
  flags: new Set([
    "-m",
    "--merge",
    "-s",
    "--squash",
    "-r",
    "--rebase",
    "-d",
    "--delete-branch",
    "--auto",
    "--disable-auto",
    "--admin",
  ]),
  shaFlag: "--match-head-commit",
  valued: [
    "--match-head-commit",
    "-R",
    "--repo",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "-t",
    "--subject",
    "-A",
    "--author-email",
  ],
  what: "gh pr merge",
};

const cliMerge = (
  argv: readonly string[],
  context: GuardContext,
  grammar: CliMergeGrammar
): GuardDecision => {
  const { shaFlag, what } = grammar;
  const scanned = scan(argv.slice(1), grammar.valued);
  const unsupported = scanned.options.find(
    ({ name }) => !(grammar.valued.includes(name) || grammar.flags.has(name))
  );
  if (unsupported) {
    return refuse(
      `${what} ${unsupported.name} is not a form the merge gate supports; write each option on its own, with its value separate`
    );
  }
  const sha = lastValue(scanned, [shaFlag]);
  if (!sha) {
    return refuse(
      `${what} names no ${shaFlag}; pass the exact head so the merge is bound to a checked commit`
    );
  }
  if (!SHA_PATTERN.test(sha)) {
    return refuse(`${what} ${shaFlag} ${sha} is not a commit SHA`);
  }
  const project =
    lastValue(scanned, ["-R", "--repo"]) ?? originProject(context.cwd);
  return requireProviderMerge(context, sha, what, project);
};

const PROVIDER_GLOBAL_VALUED = ["-R", "--repo"];

/**
 * The command group and action words of a gh or glab command and the index
 * after the group, skipping only the global `-R` option and its value. Any
 * other option before the action could hide where the words are, so it is
 * refused.
 */
const providerWords = (
  argv: readonly string[]
):
  | { action: string | null; after: number; group: string | null }
  | GuardDecision => {
  const words: string[] = [];
  let after = argv.length;
  for (let index = 1; index < argv.length && words.length < 2; index += 1) {
    const argument = argv[index] ?? "";
    if (PROVIDER_GLOBAL_VALUED.includes(argument)) {
      index += 1;
    } else if (argument.startsWith("-")) {
      return refuse(
        `${basename(argv[0] ?? "")} ${argument} before the command's action is not a form the merge gate supports`
      );
    } else {
      words.push(argument);
      if (words.length === 1) {
        after = index + 1;
      }
      // `api` takes its own options and endpoint, read by the API grammar.
      if (argument === "api" && words.length === 1) {
        break;
      }
    }
  }
  return { action: words[1] ?? null, after, group: words[0] ?? null };
};

const analyzeProvider = (
  argv: readonly string[],
  context: GuardContext
): GuardDecision => {
  const tool = basename(argv[0] ?? "");
  const parsed = providerWords(argv);
  if ("allow" in parsed) {
    return parsed;
  }
  const { action, after, group } = parsed;
  if (
    tool === "glab" &&
    group === "mr" &&
    (action === "merge" || action === "accept")
  ) {
    return cliMerge(argv, context, GLAB_MERGE);
  }
  if (tool === "gh" && group === "pr" && action === "merge") {
    return cliMerge(argv, context, GH_MERGE);
  }
  if (tool === "gh" && group === "repo" && action === "sync") {
    return refuse(
      "gh repo sync can move a branch from another repository; the merge gate does not support it"
    );
  }
  return group === "api" ? apiMerge(argv.slice(after), context, tool) : allow();
};

// ---------------------------------------------------------------- entry

const ENV_VALUED = ["-u", "--unset", "-C", "--chdir"];

/**
 * One `env` argument: how many arguments it uses and any new directory, or
 * null at the command it wraps.
 */
const envArgument = (
  argv: readonly string[],
  index: number,
  cwd: string
): { cwd: string; used: number } | GuardDecision | null => {
  const argument = argv[index] ?? "";
  if (argument === "-S" || argument.startsWith("--split-string")) {
    return refuse(
      "env -S hides the command line from the guard; run the command as a plain argv"
    );
  }
  if (argument.startsWith("GIT_") && argument.includes("=")) {
    return refuse(
      `env ${argument.slice(0, argument.indexOf("="))}=... changes what git does, so the guard cannot check it; run the command without it`
    );
  }
  if (argument === "-C" || argument === "--chdir") {
    return { cwd: resolve(cwd, argv[index + 1] ?? ""), used: 2 };
  }
  if (argument.startsWith("--chdir=")) {
    return { cwd: resolve(cwd, argument.slice("--chdir=".length)), used: 1 };
  }
  if (ENV_VALUED.includes(argument)) {
    return { cwd, used: 2 };
  }
  return ENV_ASSIGNMENT_PATTERN.test(argument) || argument.startsWith("-")
    ? { cwd, used: 1 }
    : null;
};

/** Skips one `env` invocation's options and assignments. */
const skipEnv = (
  argv: readonly string[],
  start: number,
  cwd: string
): { cwd: string; index: number } | GuardDecision => {
  let index = start;
  let directory = cwd;
  while (index < argv.length) {
    if (argv[index] === "--") {
      return { cwd: directory, index: index + 1 };
    }
    const step = envArgument(argv, index, directory);
    if (step === null) {
      break;
    }
    if ("allow" in step) {
      return step;
    }
    directory = step.cwd;
    index += step.used;
  }
  return { cwd: directory, index };
};

/**
 * Strips `env`, `command`, and `nohup` wrappers, tracking `env -C`, and
 * whether an `env` changed the environment the wrapped command sees.
 */
const unwrap = (
  argv: readonly string[],
  cwd: string
):
  | { argv: string[]; cwd: string; environmentChanged: boolean }
  | GuardDecision => {
  let index = 0;
  let directory = cwd;
  let environmentChanged = false;
  for (;;) {
    const executable = basename(argv[index] ?? "");
    if (executable === "command" || executable === "nohup") {
      index += 1;
    } else if (executable === "env") {
      const skipped = skipEnv(argv, index + 1, directory);
      if ("allow" in skipped) {
        return skipped;
      }
      environmentChanged ||= skipped.index > index + 1;
      ({ cwd: directory, index } = skipped);
    } else {
      return { argv: argv.slice(index), cwd: directory, environmentChanged };
    }
  }
};

const shellScript = (argv: readonly string[]): string | null => {
  for (const [index, argument] of argv.slice(1).entries()) {
    if (SHELL_COMMAND_FLAG_PATTERN.test(argument)) {
      return argv[index + 2] ?? "";
    }
    if (!argument.startsWith("-")) {
      return null;
    }
  }
  return null;
};

export const evaluateCommand = (
  command: readonly string[],
  context: GuardContext
): GuardDecision => {
  const unwrapped = unwrap(command, context.cwd);
  if ("allow" in unwrapped) {
    return unwrapped;
  }
  const { argv, cwd, environmentChanged } = unwrapped;
  const executable = basename(argv[0] ?? "");
  if (environmentChanged && ["git", "glab", "gh"].includes(executable)) {
    return refuse(
      `env changes the environment ${executable} reads its configuration from (HOME, XDG_CONFIG_HOME, host variables), which the guard cannot check; run ${executable} without env`
    );
  }
  if (SHELLS.has(executable)) {
    const script = shellScript(argv);
    return script !== null && SHELL_RISK_PATTERN.test(script)
      ? refuse(
          `the ${executable} -c script runs git, glab, gh, or its own arguments, which the guard cannot check; run the command as a plain argv through loop exec`
        )
      : allow();
  }
  if (executable === "git") {
    return analyzeGit(argv, { ...context, cwd });
  }
  return executable === "glab" || executable === "gh"
    ? analyzeProvider(argv, { ...context, cwd })
    : allow();
};

export const parseGuardArguments = (
  args: readonly string[]
): { command: string[]; projects: string[]; targets: string[] } => {
  const targets: string[] = [];
  const projects: string[] = [];
  let index = 0;
  while (index < args.length && args[index] !== "--") {
    const value = args[index + 1];
    if (args[index] === "--target-branch" && value) {
      targets.push(value);
      index += 2;
      continue;
    }
    if (args[index] === "--project" && value) {
      projects.push(value);
      index += 2;
      continue;
    }
    throw new Error(
      `unknown guard option ${args[index]}; the policy must end the guard's own arguments with --`
    );
  }
  return {
    command: args.slice(index + 1),
    projects,
    targets: targets.length > 0 ? targets : ["main"],
  };
};

if (import.meta.main) {
  try {
    const { command, projects, targets } = parseGuardArguments(
      process.argv.slice(2)
    );
    const decision = evaluateCommand(command, {
      cwd: process.env.SIMPLE_CHANGES_REPOSITORY ?? process.cwd(),
      projects,
      targets,
    });
    if (!decision.allow) {
      process.stderr.write(
        `merge-gate: refused ${JSON.stringify(command)}: ${decision.reason}\n`
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `merge-gate: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
