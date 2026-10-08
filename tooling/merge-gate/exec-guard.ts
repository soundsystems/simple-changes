#!/usr/bin/env bun

/**
 * This repository's `execGuard` (see `.simple-changes.json` and
 * CONTRIBUTING.md). Simple Changes runs `[...execGuard, ...command]` before
 * every `loop exec` child; this guard exits 0 for every command it does not
 * gate and refuses a merge-like command unless a passing `bun run check`
 * receipt exists for the exact commit it would ship:
 *
 * - a provider merge: `glab mr merge --sha <sha>`, a non-GET `glab api` or
 *   `gh api` call to a merge request or pull request `merge` endpoint with
 *   `sha=<sha>`, or `gh pr merge --match-head-commit <sha>`; a merge that
 *   names no exact SHA is refused;
 * - a `git push` whose destination is a target branch;
 * - a `git merge` or `git pull` while a target branch is checked out, which
 *   must be `--ff-only` to a published or receipted commit.
 *
 * It accepts a narrow grammar and refuses what it cannot check: repository,
 * ref, alias, or remote overrides, merge aliases, raw transports, matching or
 * pattern refspecs, and shell `-c` scripts that mention a merge. It sees only
 * the argv `loop exec` runs; a merge run outside `loop exec` is not gated at
 * all. It is a convenience gate for this repository's own controller, not a
 * security boundary.
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
const MERGE_TEXT_PATTERN =
  /\b(?:git\b[^\n;&|]*\b(?:push|merge|pull)\b|glab\b[^\n;&|]*\b(?:merge|accept)\b|gh\b[^\n;&|]*\bmerge\b)/u;
const ALIAS_MERGE_PATTERN = /\b(?:push|merge|pull)\b/u;
const ROUTING_CONFIG_PATTERN = /^(?:push|remote|branch|alias|url)\./iu;
const WHITESPACE_PATTERN = /\s+/u;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SHELL_COMMAND_FLAG_PATTERN = /^-[A-Za-z]*c[A-Za-z]*$/u;
const LEADING_SLASHES_PATTERN = /^\/+/u;
const MERGE_ENDPOINT_PATTERN =
  /(?:^|\/)(?:merge_requests|pulls)\/\d+\/merge(?:_when_pipeline_succeeds)?$/u;
const GRAPHQL_MERGE_PATTERN =
  /\b(?:mergeRequestAccept|mergeRequestSetAutoMerge|mergePullRequest|enablePullRequestAutoMerge)\b/u;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/u;
const PUSH_FLAG_CLUSTER_PATTERN = /^-[fuqvnd46]+$/u;
const GLOB_SPECIAL_PATTERN = /[.+?^${}()|[\]\\]/gu;

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
 * exactly the checked tree only when `sha` already contains every fetched
 * copy of the target, so require that as well as the receipt. The provider
 * can still merge onto a target that moved after the last fetch; fetch right
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
  const refs = context.targets.map((target) =>
    publishedRef(context.cwd, target)
  );
  if (refs.some((ref) => ref === null)) {
    return refuse(
      `${what}: no fetched remote copy of ${context.targets.join(" or ")} exists, so the guard cannot prove the merge ships exactly ${sha}; fetch the target first`
    );
  }
  const missing = (refs as string[]).filter(
    (ref) =>
      git(context.cwd, ["merge-base", "--is-ancestor", ref, commit])
        .exitCode !== 0
  );
  return missing.length > 0
    ? refuse(
        `${what}: ${sha} does not contain ${missing.join(", ")}, so the merge would ship a tree no receipt covers; update the branch from the target, check it again, then merge`
      )
    : checked;
};

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

// ------------------------------------------------------------------- git

interface GitInvocation {
  args: string[];
  cwd: string;
  /**
   * Global options that change which repository, refs, aliases, or remotes
   * git uses, so the guard's own reads would not see what git does.
   */
  overrides: string[];
  subcommand: string;
}

const GIT_VALUED_GLOBALS = [
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
];
const GIT_REPOSITORY_OVERRIDES = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--bare",
]);

const applyGitGlobal = (
  invocation: GitInvocation,
  name: string,
  value: string
): void => {
  if (name === "-C") {
    invocation.cwd = resolve(invocation.cwd, value);
  } else if (GIT_REPOSITORY_OVERRIDES.has(name)) {
    invocation.overrides.push(name);
  } else if (
    (name === "-c" || name === "--config-env") &&
    ROUTING_CONFIG_PATTERN.test(value)
  ) {
    invocation.overrides.push(`${name} ${value}`);
  }
};

const parseGit = (
  argv: readonly string[],
  cwd: string
): GitInvocation | null => {
  const invocation: GitInvocation = {
    args: [],
    cwd,
    overrides: [],
    subcommand: "",
  };
  let index = 1;
  while ((argv[index] ?? "").startsWith("-")) {
    const argument = argv[index] ?? "";
    const equals = argument.indexOf("=");
    if (argument.startsWith("--") && equals > 0) {
      applyGitGlobal(
        invocation,
        argument.slice(0, equals),
        argument.slice(equals + 1)
      );
      index += 1;
    } else if (GIT_VALUED_GLOBALS.includes(argument)) {
      applyGitGlobal(invocation, argument, argv[index + 1] ?? "");
      index += 2;
    } else {
      applyGitGlobal(invocation, argument, "");
      index += 1;
    }
  }
  const subcommand = argv[index];
  if (!subcommand) {
    return null;
  }
  invocation.subcommand = subcommand;
  invocation.args = argv.slice(index + 1);
  return invocation;
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

const globMatches = (pattern: string, value: string): boolean =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(GLOB_SPECIAL_PATTERN, "\\$&"))
      .join(".*")}$`,
    "u"
  ).test(value);

const refExists = (invocation: GitInvocation, ref: string): boolean =>
  gitIn(invocation, ["show-ref", "--verify", "--quiet", ref]).exitCode === 0;

/** Source and destination of one push refspec, or null for a tag push. */
const refspecParts = (
  invocation: GitInvocation,
  refspec: string,
  deleting: boolean
): { destination: string; source: string } | null => {
  if (deleting) {
    return { destination: refspec, source: "" };
  }
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
  deleting: boolean
): GuardDecision | null => {
  const parts = refspecParts(
    invocation,
    spec.startsWith("+") ? spec.slice(1) : spec,
    deleting
  );
  if (!parts) {
    return null;
  }
  const { destination, source } = parts;
  if (!(destination || source)) {
    return refuse(
      `the refspec ${spec} pushes every matching branch, which can move a target branch; push one exact refspec instead`
    );
  }
  if (destination.includes("*")) {
    const reachesTarget = context.targets.some(
      (target) =>
        globMatches(destination, target) ||
        globMatches(destination, `refs/heads/${target}`)
    );
    return reachesTarget
      ? refuse(
          `the pattern refspec ${spec} could push a target branch; push one exact refspec instead`
        )
      : null;
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

const pushRefspecs = (
  invocation: GitInvocation,
  context: GuardContext,
  refspecs: readonly string[],
  deleting: boolean
): GuardDecision => {
  for (const spec of refspecs) {
    const decision = pushRefspec(invocation, context, spec, deleting);
    if (decision && !decision.allow) {
      return decision;
    }
  }
  return allow("git push: every target refspec has a passing check receipt");
};

const pushRemoteFor = (
  invocation: GitInvocation,
  branch: string | null,
  remote: string | null
): string => {
  if (remote) {
    return remote;
  }
  const configured = branch
    ? gitConfig(invocation, `branch.${branch}.pushRemote`) ||
      gitConfig(invocation, "remote.pushDefault") ||
      gitConfig(invocation, `branch.${branch}.remote`)
    : "";
  return configured || "origin";
};

/** A push without refspecs: configured remote refspecs, then push.default. */
const defaultPushDecision = (
  invocation: GitInvocation,
  context: GuardContext,
  remote: string | null
): GuardDecision => {
  const branch = currentBranch(invocation);
  const remoteRefspecs = gitIn(invocation, [
    "config",
    "--get-all",
    `remote.${pushRemoteFor(invocation, branch, remote)}.push`,
  ])
    .stdout.split("\n")
    .filter(Boolean);
  if (remoteRefspecs.length > 0) {
    return pushRefspecs(invocation, context, remoteRefspecs, false);
  }
  if (gitConfig(invocation, "push.default") === "matching") {
    return refuse(
      "push.default is matching, so a bare git push can move a target branch; name an exact refspec"
    );
  }
  if (!branch) {
    return allow();
  }
  const pushRef = gitIn(invocation, [
    "rev-parse",
    "--symbolic-full-name",
    `${branch}@{push}`,
  ]).stdout;
  const pushBranch = pushRef.startsWith("refs/remotes/")
    ? pushRef.split("/").slice(3).join("/")
    : null;
  const destination = [branch, pushBranch].find(
    (name) => name !== null && context.targets.includes(name)
  );
  return destination
    ? requireReceipt(context, "HEAD", `git push to ${destination}`)
    : allow();
};

const PUSH_VALUED = [
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
];
const PUSH_WHOLESALE = ["--all", "--branches", "--mirror", "--prune"];

const gitPush = (
  invocation: GitInvocation,
  context: GuardContext
): GuardDecision => {
  const scanned = scan(invocation.args, PUSH_VALUED);
  const wholesale = PUSH_WHOLESALE.find((name) => hasOption(scanned, [name]));
  if (wholesale) {
    return refuse(
      `git push ${wholesale} can move or delete a target branch; push one exact refspec instead`
    );
  }
  const clusters = scanned.options
    .map((option) => option.name)
    .filter((name) => PUSH_FLAG_CLUSTER_PATTERN.test(name))
    .join("");
  if (hasOption(scanned, ["--dry-run"]) || clusters.includes("n")) {
    return allow("git push --dry-run moves nothing");
  }
  const deleting = hasOption(scanned, ["--delete"]) || clusters.includes("d");
  const positional = [...scanned.positional];
  const remote = lastValue(scanned, ["--repo"]) ?? positional.shift() ?? null;
  if (positional.length === 0 && hasOption(scanned, ["--tags"])) {
    return allow("git push --tags without refspecs pushes only tags");
  }
  return positional.length === 0
    ? defaultPushDecision(invocation, context, remote)
    : pushRefspecs(invocation, context, positional, deleting);
};

const MERGE_VALUED = [
  "-m",
  "--message",
  "-F",
  "--file",
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
  "--into-name",
];
const CONCLUDING_FLAGS = ["--abort", "--quit", "--continue"];

const FAST_FORWARD_ONLY = ["--ff-only"];

/**
 * `git pull --ff-only` on a target branch from its own upstream: the result
 * is the published target, which every merge into it already passed.
 */
const gitPullOnTarget = (
  invocation: GitInvocation,
  branch: string,
  scanned: Scanned
): GuardDecision => {
  if (!hasOption(scanned, FAST_FORWARD_ONLY)) {
    return refuse(
      `git pull on ${branch} can create a merge commit no receipt covers; use git pull --ff-only`
    );
  }
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
  const commits = sources.map((source) =>
    resolveCommit(invocation.cwd, source)
  );
  const [only] = commits;
  if (
    !(only && commits.length === 1 && hasOption(scanned, FAST_FORWARD_ONLY))
  ) {
    return refuse(
      `git merge into ${branch} must fast-forward (--ff-only) to one local commit, so the result is exactly a published or checked commit`
    );
  }
  return publishedContains(invocation.cwd, branch, only)
    ? allow(`git merge only syncs ${branch} with its published remote`)
    : requireReceipt(context, only, `git merge into ${branch}`);
};

const gitMerge = (
  invocation: GitInvocation,
  context: GuardContext,
  pulling: boolean
): GuardDecision => {
  const branch = currentBranch(invocation);
  if (!(branch && context.targets.includes(branch))) {
    return allow();
  }
  const scanned = scan(invocation.args, MERGE_VALUED);
  if (hasOption(scanned, CONCLUDING_FLAGS)) {
    return allow("concluding a merge adds no new commit");
  }
  return pulling
    ? gitPullOnTarget(invocation, branch, scanned)
    : gitMergeOnTarget(invocation, context, branch, scanned);
};

const GIT_TRANSPORTS = new Set(["send-pack", "http-push"]);
const ALIAS_DEPTH_LIMIT = 10;

/** Refuses a git alias that expands, directly or through others, to a merge. */
const aliasDecision = (invocation: GitInvocation): GuardDecision => {
  const seen = new Set<string>();
  let name = invocation.subcommand;
  while (!seen.has(name) && seen.size < ALIAS_DEPTH_LIMIT) {
    seen.add(name);
    const alias = gitConfig(invocation, `alias.${name}`);
    if (!alias) {
      return allow();
    }
    if (ALIAS_MERGE_PATTERN.test(alias)) {
      return refuse(
        `git ${invocation.subcommand} is an alias for "${alias}"; run the expanded command so the guard can check it`
      );
    }
    if (alias.startsWith("!")) {
      return allow();
    }
    name = alias.trim().split(WHITESPACE_PATTERN)[0] ?? "";
  }
  return refuse(
    `git ${invocation.subcommand} is an alias chain the guard cannot resolve; run the expanded command`
  );
};

const analyzeGit = (
  argv: readonly string[],
  context: GuardContext
): GuardDecision => {
  const invocation = parseGit(argv, context.cwd);
  if (!invocation) {
    return allow();
  }
  const { subcommand } = invocation;
  if (invocation.overrides.length > 0) {
    return refuse(
      `git ${invocation.overrides.join(", ")} changes which repository, refs, aliases, or remotes git uses, so the guard cannot check what it does; run git without it`
    );
  }
  if (
    GIT_TRANSPORTS.has(subcommand) ||
    (subcommand === "subtree" && invocation.args.includes("push"))
  ) {
    return refuse(
      `git ${subcommand} can update remote refs outside git push; use git push with one exact refspec`
    );
  }
  const scoped = { ...context, cwd: invocation.cwd };
  if (subcommand === "push") {
    return gitPush(invocation, scoped);
  }
  if (subcommand === "merge" || subcommand === "pull") {
    return gitMerge(invocation, scoped, subcommand === "pull");
  }
  return aliasDecision(invocation);
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

const GLAB_MERGE_VALUED = [
  "--sha",
  "-m",
  "--message",
  "--squash-message",
  "-R",
  "--repo",
];

const analyzeGlab = (
  argv: readonly string[],
  context: GuardContext
): GuardDecision => {
  if (argv[1] === "api") {
    return apiMerge(argv.slice(2), context, "glab");
  }
  if (!(argv[1] === "mr" && (argv[2] === "merge" || argv[2] === "accept"))) {
    return allow();
  }
  const sha = lastValue(scan(argv.slice(3), GLAB_MERGE_VALUED), ["--sha"]);
  if (!sha) {
    return refuse(
      "glab mr merge names no --sha; pass --sha <exact head> so the merge is bound to a checked commit"
    );
  }
  return SHA_PATTERN.test(sha)
    ? requireProviderMerge(context, sha, "glab mr merge")
    : refuse(`glab mr merge --sha ${sha} is not a commit SHA`);
};

const GH_MERGE_VALUED = [
  "--match-head-commit",
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-t",
  "--subject",
  "-R",
  "--repo",
  "-A",
  "--author-email",
];

const analyzeGh = (
  argv: readonly string[],
  context: GuardContext
): GuardDecision => {
  if (argv[1] === "api") {
    return apiMerge(argv.slice(2), context, "gh");
  }
  if (!(argv[1] === "pr" && argv[2] === "merge")) {
    return allow();
  }
  const sha = lastValue(scan(argv.slice(3), GH_MERGE_VALUED), [
    "--match-head-commit",
  ]);
  return sha
    ? requireProviderMerge(context, sha, "gh pr merge")
    : refuse(
        "gh pr merge names no --match-head-commit; pass the exact head so the merge is bound to a checked commit"
      );
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

const ANALYZERS: Record<
  string,
  (argv: readonly string[], context: GuardContext) => GuardDecision
> = {
  gh: analyzeGh,
  git: analyzeGit,
  glab: analyzeGlab,
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
    return script !== null && MERGE_TEXT_PATTERN.test(script)
      ? refuse(
          `the ${executable} -c script mentions a merge-like command; run it as a plain argv through loop exec so the guard can check it`
        )
      : allow();
  }
  const analyzer = ANALYZERS[executable];
  return analyzer ? analyzer(argv, { ...context, cwd }) : allow();
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
