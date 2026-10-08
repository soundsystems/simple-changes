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

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { git, receiptProblem, resolveCommit } from "./merge-gate.ts";

export interface GuardDecision {
  allow: boolean;
  reason: string;
}

interface GuardContext {
  cwd: string;
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
const MERGE_ENDPOINT_PATTERN =
  /(?:^|\/)(?:merge_requests|pulls)\/\d+\/merge(?:_when_pipeline_succeeds)?$/u;
const GRAPHQL_MERGE_PATTERN =
  /\b(?:mergeRequestAccept|mergeRequestSetAutoMerge|mergePullRequest|enablePullRequestAutoMerge)\b/u;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/u;

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
  what: string
): GuardDecision => {
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

/** Option names with short clusters such as `-fu` split into `-f`, `-u`. */
const flagNames = (scanned: Scanned): string[] =>
  scanned.options.flatMap(({ name }) =>
    SHORT_CLUSTER_PATTERN.test(name)
      ? [...name.slice(1)].map((letter) => `-${letter}`)
      : [name]
  );

/** The first option outside `supported`, which the guard refuses. */
const unsupportedFlag = (
  scanned: Scanned,
  supported: ReadonlySet<string>
): string | undefined =>
  flagNames(scanned).find((name) => !supported.has(name));

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

const branchName = (ref: string): string | null => {
  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length);
  }
  return ref.startsWith("refs/") ? null : ref;
};

const refExists = (invocation: GitInvocation, ref: string): boolean =>
  gitIn(invocation, ["show-ref", "--verify", "--quiet", ref]).exitCode === 0;

/** A git subcommand form that runs other programs the guard cannot see. */
const runsOtherCommands = (invocation: GitInvocation): boolean => {
  const { args, subcommand } = invocation;
  return (
    (subcommand === "rebase" &&
      args.some((arg) => arg === "-x" || arg.startsWith("--exec"))) ||
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

/** Source and destination of one push refspec, or null for a tag push. */
const refspecParts = (
  invocation: GitInvocation,
  refspec: string
): { destination: string; source: string } | null => {
  const separator = refspec.indexOf(":");
  if (separator !== -1) {
    return {
      destination: refspec.slice(separator + 1),
      source: refspec.slice(0, separator),
    };
  }
  if (refspec === "HEAD") {
    return { destination: currentBranch(invocation) ?? "HEAD", source: "HEAD" };
  }
  const tagOnly =
    !(
      refspec.startsWith("refs/") ||
      refExists(invocation, `refs/heads/${refspec}`)
    ) && refExists(invocation, `refs/tags/${refspec}`);
  return tagOnly ? null : { destination: refspec, source: refspec };
};

/** One refspec's verdict, or null when it cannot move a target branch. */
const pushRefspec = (
  invocation: GitInvocation,
  context: GuardContext,
  spec: string,
  options: { deleting: boolean; mapped: boolean }
): GuardDecision | null => {
  const refspec = spec.startsWith("+") ? spec.slice(1) : spec;
  if (refspec.includes("*")) {
    return refuse(
      `the pattern refspec ${spec} can push many branches; push one exact refspec instead`
    );
  }
  if (options.deleting) {
    const branch = branchName(refspec);
    return branch && context.targets.includes(branch)
      ? refuse(`git push would delete target branch ${branch}`)
      : null;
  }
  if (options.mapped && !refspec.includes(":")) {
    return refuse(
      `this remote maps pushed refs through remote.<name>.push, so ${spec} may update another branch; write it as <source>:<destination>`
    );
  }
  const parts = refspecParts(invocation, refspec);
  if (!parts) {
    return null;
  }
  const { destination, source } = parts;
  if (!(destination || source)) {
    return refuse(
      `the refspec ${spec} pushes every matching branch; push one exact refspec instead`
    );
  }
  const branch = branchName(destination);
  if (!(branch && context.targets.includes(branch))) {
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
  const options = {
    deleting: flags.includes("-d") || flags.includes("--delete"),
    mapped:
      gitIn(invocation, ["config", "--get-all", `remote.${remote}.push`])
        .stdout !== "",
  };
  for (const spec of refspecs) {
    const decision = pushRefspec(invocation, context, spec, options);
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

/** The SHA a merge call binds, from its fields, query, or JSON body. */
const apiMergeSha = (
  scanned: Scanned,
  query: string,
  cwd: string
): string | GuardDecision | null => {
  const field = valuesOf(scanned, FIELD_OPTIONS).find((value) =>
    value.startsWith("sha=")
  );
  const sha =
    field?.slice("sha=".length) ?? new URLSearchParams(query).get("sha");
  const input = lastValue(scanned, ["--input"]);
  if (sha || input === null) {
    return sha;
  }
  if (input === "-") {
    return refuse(
      "the merge call reads its body from stdin, which the guard cannot see; pass sha=<exact head> as a field"
    );
  }
  try {
    const body = JSON.parse(readFileSync(resolve(cwd, input), "utf8")) as {
      sha?: unknown;
    };
    return typeof body.sha === "string" ? body.sha : null;
  } catch {
    return refuse("the merge call's --input body could not be read");
  }
};

const apiMerge = (
  args: readonly string[],
  context: GuardContext,
  tool: string
): GuardDecision => {
  const scanned = scan(args, API_VALUED);
  const [endpoint] = scanned.positional;
  if (!endpoint) {
    return allow();
  }
  const fields = valuesOf(scanned, FIELD_OPTIONS);
  if (
    endpoint.replace(LEADING_SLASHES_PATTERN, "") === "graphql" &&
    fields.some((field) => GRAPHQL_MERGE_PATTERN.test(field))
  ) {
    return refuse(
      `${tool} api graphql merge mutations are not bound to a checked commit here; use the REST merge endpoint with sha=<exact head>`
    );
  }
  const [path = "", query = ""] = endpoint.split("?");
  const method =
    lastValue(scanned, ["-X", "--method"])?.toUpperCase() ??
    (fields.length > 0 || hasOption(scanned, ["--input"]) ? "POST" : "GET");
  if (!MERGE_ENDPOINT_PATTERN.test(path) || method === "GET") {
    return allow();
  }
  const sha = apiMergeSha(scanned, query, context.cwd);
  if (sha !== null && typeof sha === "object") {
    return sha;
  }
  return sha && SHA_PATTERN.test(sha)
    ? requireProviderMerge(context, sha, `${tool} api merge of ${path}`)
    : refuse(
        `${tool} api merge of ${path} names no exact sha; pass sha=<exact head> so the merge is bound to a checked commit`
      );
};

/**
 * A provider CLI merge, wherever its global flags put the subcommand words,
 * bound to the head named by `shaFlag`.
 */
const cliMerge = (
  argv: readonly string[],
  context: GuardContext,
  what: string,
  shaFlag: string
): GuardDecision => {
  const sha = lastValue(scan(argv.slice(1), [shaFlag]), [shaFlag]);
  if (!sha) {
    return refuse(
      `${what} names no ${shaFlag}; pass the exact head so the merge is bound to a checked commit`
    );
  }
  return SHA_PATTERN.test(sha)
    ? requireProviderMerge(context, sha, what)
    : refuse(`${what} ${shaFlag} ${sha} is not a commit SHA`);
};

const analyzeProvider = (
  argv: readonly string[],
  context: GuardContext
): GuardDecision => {
  const tool = basename(argv[0] ?? "");
  const words = new Set(argv.slice(1));
  if (
    tool === "glab" &&
    words.has("mr") &&
    (words.has("merge") || words.has("accept"))
  ) {
    return cliMerge(argv, context, "glab mr merge", "--sha");
  }
  if (tool === "gh" && words.has("pr") && words.has("merge")) {
    return cliMerge(argv, context, "gh pr merge", "--match-head-commit");
  }
  const api = argv.indexOf("api");
  return api > 0 ? apiMerge(argv.slice(api + 1), context, tool) : allow();
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

/** Strips `env`, `command`, and `nohup` wrappers, tracking `env -C`. */
const unwrap = (
  argv: readonly string[],
  cwd: string
): { argv: string[]; cwd: string } | GuardDecision => {
  let index = 0;
  let directory = cwd;
  for (;;) {
    const executable = basename(argv[index] ?? "");
    if (executable === "command" || executable === "nohup") {
      index += 1;
    } else if (executable === "env") {
      const skipped = skipEnv(argv, index + 1, directory);
      if ("allow" in skipped) {
        return skipped;
      }
      ({ cwd: directory, index } = skipped);
    } else {
      return { argv: argv.slice(index), cwd: directory };
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
  const { argv, cwd } = unwrapped;
  const executable = basename(argv[0] ?? "");
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
): { command: string[]; targets: string[] } => {
  const targets: string[] = [];
  let index = 0;
  while (index < args.length && args[index] !== "--") {
    if (args[index] === "--target-branch" && args[index + 1]) {
      targets.push(args[index + 1] as string);
      index += 2;
      continue;
    }
    throw new Error(
      `unknown guard option ${args[index]}; the policy must end the guard's own arguments with --`
    );
  }
  return {
    command: args.slice(index + 1),
    targets: targets.length > 0 ? targets : ["main"],
  };
};

if (import.meta.main) {
  try {
    const { command, targets } = parseGuardArguments(process.argv.slice(2));
    const decision = evaluateCommand(command, {
      cwd: process.env.SIMPLE_CHANGES_REPOSITORY ?? process.cwd(),
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
