import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { runGit } from "./process.ts";

/*
 * Pinned unit heads for `loop exec`.
 *
 * Boundary: no merge-like `loop exec` command can integrate a commit other
 * than a registered unit's recorded head.
 *
 * A run records the exact head of every unit it may ship but does not author
 * itself: the state an owner released or handed off, and the baseline of a
 * preserved, adopted, or retained checkout. A branch name can move while a
 * guarded command waits for its lock or guard, so a merge-like command that
 * could resolve a unit's moving name is refused before it starts, and the
 * refusal prints the command with the recorded commit ID, which cannot move.
 *
 * The check is bounded and fails closed. It reads the argument array, never a
 * shell. A merge-like Git command is any subcommand that is not a known
 * read-only or index-only one; while units are pinned only an allowlist of
 * them runs (`ALLOWED_WHILE_PINNED`), and one is refused when:
 *
 * - an argument mentions a pinned branch in any spelling (local,
 *   remote-tracking, full ref, symbolic ref, revision expression, range, any
 *   letter case), points into a pinned checkout, or uses a name that could
 *   resolve to one: reflog, upstream, and previous-branch syntax,
 *   `FETCH_HEAD`, another worktree's refs, message search, and every-branch
 *   or stdin options, including their abbreviations;
 * - it runs in a checkout the run does not author, whose HEAD can move;
 * - configuration could stand in for a name: an alias, an upstream naming a
 *   unit, a push or fetch mapping, a mirror or matching push, a legacy remote
 *   file, a replace ref, or a graft;
 * - an argument resolves to a commit that contains a commit a pinned unit
 *   gained after its recorded head (a copy of a moved branch, or its ID);
 * - it is `git pull`, which resolves its repository, refspecs, and upstream
 *   when it runs, or a push or fetch with an option this parser does not
 *   know, or a fetch that writes a local ref other than a remote-tracking one;
 * - it implicitly reads the shared stash.
 *
 * Every Git command, read-only ones included, is refused while units are
 * pinned when it uses `-c`, an option or subcommand that runs another command
 * (`rebase --exec`, `bisect run`, `--upload-pack`, ...), or writes
 * configuration that later commands would follow.
 *
 * Git run through a shell or other command runner is refused outright while
 * units are pinned, because the runner hides what Git will read; any other
 * program is opaque. Refusing a legitimate command is accepted, because the
 * form that names the recorded commit always works. The run's controller and
 * its own prepared authors are not pinned.
 */

export type PinnedUnitState =
  | "adopted"
  | "claimed"
  | "handed-off"
  | "preserved"
  | "released"
  | "retained"
  | "unrecorded";

export interface PinnedUnit {
  /** Null for a detached checkout, which is pinned by its path and head. */
  branch: string | null;
  /** The owner who recorded the head, or who still holds the checkout. */
  owner: string | null;
  path: string;
  /** Every commit the run recorded for this unit; empty when it has none. */
  recordedHeads: readonly string[];
  state: PinnedUnitState;
}

export type PinnedRefusalKind =
  | "alias"
  | "checkout"
  | "configured"
  | "indirect"
  | "moved"
  | "named"
  | "replaced"
  | "unclassified"
  | "wrapped";

export interface PinnedRefusal {
  detail: string;
  kind: PinnedRefusalKind;
  /** The argument that caused the refusal, when one did. */
  token: string | null;
  /** The pinned unit the argument names, when it names one. */
  unit: PinnedUnit | null;
}

export interface GitRefRecord {
  name: string;
  object: string;
  symref: string;
}

export interface UnrecordedCommit {
  commit: string;
  parents: string[];
}

/** Git facts read in the same directory and `-C`/`-c` context as the command. */
export interface PinnedGitFacts {
  config: (globals: readonly string[], pattern: string) => [string, string][];
  grafted: () => boolean;
  hasAlias: (globals: readonly string[], name: string) => boolean;
  /** Whether `ancestor` is `descendant` or one of its ancestors. */
  isAncestor: (
    globals: readonly string[],
    ancestor: string,
    descendant: string
  ) => boolean;
  /** Remotes defined by files under `remotes/` or `branches/`. */
  legacyRemotes: () => string[];
  /** The type of the object a revision names now, or null. */
  objectType: (globals: readonly string[], revision: string) => string | null;
  refs: (globals: readonly string[]) => GitRefRecord[];
  /** The commit a revision names now, or null. */
  resolveCommit: (
    globals: readonly string[],
    revision: string
  ) => string | null;
  resolveRef: (
    globals: readonly string[],
    token: string
  ) => { commit: string; name: string } | null;
  /**
   * Commits reachable from `tip` but from none of `recorded`, with their
   * parents, at most `limit + 1` of them; null when Git cannot list them.
   */
  unrecordedCommits: (
    globals: readonly string[],
    tip: string,
    recorded: readonly string[],
    limit: number
  ) => UnrecordedCommit[] | null;
  /**
   * The current branch's configured upstream and every `merge` value, which
   * `git merge` and `git rebase` read when no revision is named.
   */
  upstreams: (globals: readonly string[]) => string[];
}

export interface PinnedCommandContext {
  /** The checkout the command runs in. */
  checkout: string;
  /** Each listed checkout's current HEAD. */
  checkoutHeads: ReadonlyMap<string, string | null>;
  /** Linked worktrees keep their own Git directories under this one. */
  commonGitDirectory: string;
  facts: PinnedGitFacts;
  /**
   * Checkouts the run moves itself (its controller and prepared authors), in
   * which a command may run; any other checkout's HEAD can move under it.
   */
  ownCheckouts: readonly string[];
  pins: readonly PinnedUnit[];
  /** Every checkout Git lists, so each path is attributed to its own one. */
  worktreePaths: readonly string[];
}

export interface PinnedCommandAnalysis {
  /** The same argv naming recorded commits, only when it is certainly equivalent. */
  equivalent: string[] | null;
  refusals: PinnedRefusal[];
  /** The Git subcommand, when the command runs Git directly. */
  subcommand: string | null;
}

// Subcommands that never write a named revision into a branch, the index, or
// the working tree. Everything else is merge-like for this check.
const READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add",
  "annotate",
  "blame",
  "bugreport",
  "cat-file",
  "check-attr",
  "check-ignore",
  "check-mailmap",
  "check-ref-format",
  "cherry",
  "clean",
  "column",
  "commit",
  "commit-graph",
  "config",
  "count-objects",
  "credential",
  "describe",
  "diagnose",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "fsck",
  "gc",
  "grep",
  "hash-object",
  "help",
  "init",
  "interpret-trailers",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "maintenance",
  "merge-base",
  "mktag",
  "mktree",
  "multi-pack-index",
  "mv",
  "name-rev",
  "pack-refs",
  "patch-id",
  "prune",
  "range-diff",
  "reflog",
  "repack",
  "rerere",
  "rev-list",
  "rev-parse",
  "rm",
  "shortlog",
  "show",
  "show-branch",
  "show-ref",
  "sparse-checkout",
  "status",
  "stripspace",
  "var",
  "verify-commit",
  "verify-pack",
  "verify-tag",
  "version",
  "whatchanged",
  "write-tree",
]);

// Merge-like builtins. Git ignores an alias that shadows a builtin, so these
// skip the alias lookup; any other unknown subcommand may be an alias.
const MERGE_LIKE_BUILTINS: ReadonlySet<string> = new Set([
  "am",
  "apply",
  "archive",
  "bisect",
  "branch",
  "bundle",
  "checkout",
  "checkout-index",
  "cherry-pick",
  "commit-tree",
  "fast-export",
  "fast-import",
  "fetch",
  "fetch-pack",
  "format-patch",
  "merge",
  "merge-file",
  "merge-tree",
  "notes",
  "pull",
  "push",
  "read-tree",
  "rebase",
  "remote",
  "replace",
  "replay",
  "reset",
  "restore",
  "revert",
  "send-pack",
  "stash",
  "submodule",
  "switch",
  "symbolic-ref",
  "tag",
  "update-index",
  "update-ref",
  "worktree",
]);

// Programs that run another command from their arguments: shells, command
// prefixes, and script interpreters. Git run through one of them cannot be
// classified (its subcommand, upstream, and configuration are hidden), so
// while units are pinned it is refused whatever it names; run Git directly.
const COMMAND_RUNNERS: ReadonlySet<string> = new Set([
  "arch",
  "bash",
  "bun",
  "bunx",
  "busybox",
  "caffeinate",
  "chroot",
  "cmd",
  "command",
  "csh",
  "dash",
  "deno",
  "doas",
  "env",
  "eval",
  "exec",
  "fish",
  "flock",
  "gtimeout",
  "ionice",
  "ksh",
  "mksh",
  "nice",
  "node",
  "nohup",
  "npx",
  "osascript",
  "parallel",
  "perl",
  "php",
  "pnpx",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "runuser",
  "script",
  "setsid",
  "sh",
  "stdbuf",
  "su",
  "sudo",
  "taskset",
  "tcsh",
  "time",
  "timeout",
  "unbuffer",
  "watch",
  "xargs",
  "xcrun",
  "yash",
  "zsh",
]);

// The only merge-like subcommands loop exec runs while units are pinned, each
// with every argument checked. Any other one (`send-pack`, `submodule`,
// plumbing, `bisect`, `notes`, ...) is refused: its arguments and side
// effects are not classified here, and the integration flows do not need it.
const ALLOWED_WHILE_PINNED: ReadonlySet<string> = new Set([
  "am",
  "apply",
  "branch",
  "checkout",
  "cherry-pick",
  "fetch",
  "merge",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "stash",
  "tag",
  "update-ref",
  "worktree",
]);

const GIT_EXECUTABLES: ReadonlySet<string> = new Set(["git", "git.exe"]);
const EXE_SUFFIX = /\.exe$/u;
const DASHED_GIT_PROGRAM = /^git-([a-z][a-z0-9-]*)$/u;
const NAME_CHARACTER = /[\p{L}\p{N}_-]/u;
const OTHER_WORKTREE_PATTERN =
  /(?:^|\.\.|[\^:=+])(?:main-worktree|worktrees\/[^/]+)\//u;
const STASH_REF_PATTERN = /^(?:refs\/)?stash(?:$|[~^:@])/u;
const FETCH_HEAD_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])fetch_head(?:$|[^\p{L}\p{N}_-])/u;
const WRAPPER_WORD_SEPARATOR = /[\s;&|()<>'"`$\\=]+/u;
const WHOLE_REF_TOKEN = /^[^\s~^:?*[\\@{}]+$/u;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const RANGE_SEPARATOR = /\.{2,3}/u;
const REVISION_SUFFIX = /[~^:]/u;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const SCP_HOST = /^[^/]*:/u;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/iu;

// Options that read revisions from somewhere loop exec cannot see, or that
// carry every branch. Git also accepts any unambiguous prefix of a long
// option, so a prefix of one of these counts as the option itself.
const STDIN_OPTIONS = ["--stdin", "--refmap"];
const EVERY_BRANCH_OPTIONS = [
  "--all",
  "--branches",
  "--glob",
  "--mirror",
  "--remotes",
];
const MINIMUM_ABBREVIATION = 3;

const CONTINUATION_OPTIONS: ReadonlySet<string> = new Set([
  "--abort",
  "--continue",
  "--quit",
  "--skip",
]);

// The longest run of commits a moved unit may carry before every merge-like
// command is refused instead of checked against them.
const UNRECORDED_COMMIT_LIMIT = 1000;

const MERGE_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "-n",
  "-q",
  "-v",
  "--abort",
  "--allow-unrelated-histories",
  "--autostash",
  "--commit",
  "--continue",
  "--edit",
  "--ff",
  "--ff-only",
  "--log",
  "--no-allow-unrelated-histories",
  "--no-autostash",
  "--no-commit",
  "--no-edit",
  "--no-ff",
  "--no-gpg-sign",
  "--no-log",
  "--no-overwrite-ignore",
  "--no-progress",
  "--no-rerere-autoupdate",
  "--no-signoff",
  "--no-squash",
  "--no-stat",
  "--no-summary",
  "--no-verify",
  "--no-verify-signatures",
  "--overwrite-ignore",
  "--progress",
  "--quiet",
  "--quit",
  "--rerere-autoupdate",
  "--signoff",
  "--squash",
  "--stat",
  "--summary",
  "--verbose",
  "--verify",
  "--verify-signatures",
]);
const MERGE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-F",
  "-X",
  "-s",
  "--cleanup",
  "--file",
  "--into-name",
  "--strategy",
  "--strategy-option",
]);
// Long merge options whose value is attached with `=`, or short ones whose
// value is attached directly; the whole token is still checked.
const MERGE_ATTACHED_PREFIXES = [
  "--cleanup=",
  "--file=",
  "--gpg-sign",
  "--into-name=",
  "--log=",
  "--strategy=",
  "--strategy-option=",
  "-F",
  "-S",
  "-X",
  "-s",
];

interface OptionGrammar {
  /** Options with a value attached to the token (`--name=value`, `-Xvalue`). */
  attached: readonly string[];
  flags: ReadonlySet<string>;
  /** Options whose value may be the next argument. */
  values: ReadonlySet<string>;
}

const PUSH_GRAMMAR: OptionGrammar = {
  attached: [
    "--exec=",
    "--force-with-lease=",
    "--push-option=",
    "--receive-pack=",
    "--recurse-submodules=",
    "--repo=",
    "--signed=",
    "-o",
  ],
  flags: new Set([
    "-4",
    "-6",
    "-d",
    "-f",
    "-n",
    "-q",
    "-u",
    "-v",
    "--atomic",
    "--delete",
    "--dry-run",
    "--follow-tags",
    "--force",
    "--force-if-includes",
    "--force-with-lease",
    "--ipv4",
    "--ipv6",
    "--no-atomic",
    "--no-follow-tags",
    "--no-force-if-includes",
    "--no-force-with-lease",
    "--no-progress",
    "--no-recurse-submodules",
    "--no-signed",
    "--no-thin",
    "--no-verify",
    "--porcelain",
    "--progress",
    "--prune",
    "--quiet",
    "--set-upstream",
    "--signed",
    "--tags",
    "--thin",
    "--verbose",
    "--verify",
  ]),
  values: new Set([
    "-o",
    "--exec",
    "--push-option",
    "--receive-pack",
    "--recurse-submodules",
    "--repo",
  ]),
};

const FETCH_GRAMMAR: OptionGrammar = {
  attached: [
    "--deepen=",
    "--depth=",
    "--filter=",
    "--jobs=",
    "--negotiation-tip=",
    "--recurse-submodules=",
    "--recurse-submodules-default=",
    "--server-option=",
    "--shallow-exclude=",
    "--shallow-since=",
    "--upload-pack=",
    "-j",
    "-o",
  ],
  flags: new Set([
    "-4",
    "-6",
    "-a",
    "-f",
    "-k",
    "-n",
    "-P",
    "-p",
    "-q",
    "-t",
    "-u",
    "-v",
    "--all",
    "--append",
    "--atomic",
    "--auto-gc",
    "--auto-maintenance",
    "--dry-run",
    "--force",
    "--ipv4",
    "--ipv6",
    "--keep",
    "--multiple",
    "--no-auto-gc",
    "--no-auto-maintenance",
    "--no-progress",
    "--no-recurse-submodules",
    "--no-show-forced-updates",
    "--no-tags",
    "--no-write-commit-graph",
    "--no-write-fetch-head",
    "--porcelain",
    "--prefetch",
    "--progress",
    "--prune",
    "--prune-tags",
    "--quiet",
    "--refetch",
    "--set-upstream",
    "--show-forced-updates",
    "--tags",
    "--unshallow",
    "--update-head-ok",
    "--update-shallow",
    "--verbose",
    "--write-commit-graph",
    "--write-fetch-head",
  ]),
  values: new Set([
    "-j",
    "-o",
    "--deepen",
    "--depth",
    "--filter",
    "--jobs",
    "--negotiation-tip",
    "--recurse-submodules-default",
    "--server-option",
    "--shallow-exclude",
    "--shallow-since",
    "--upload-pack",
  ]),
};

const DELETION_OPTIONS: ReadonlySet<string> = new Set(["-D", "-d", "--delete"]);
const BRANCH_DELETION_COMPANIONS: ReadonlySet<string> = new Set([
  "-D",
  "-d",
  "-f",
  "-q",
  "-r",
  "--delete",
  "--force",
  "--quiet",
  "--remotes",
]);

// A fetch may write only remote-tracking refs, from the command line or from
// configuration (which may also follow tags); anything else it writes is a
// local ref that a later merge would read under a name this check never saw.
const REMOTE_TRACKING_PREFIX = "refs/remotes/";
const CONFIGURED_FETCH_PREFIXES = [REMOTE_TRACKING_PREFIX, "refs/tags/"];

const fold = (value: string): string => value.normalize("NFC").toLowerCase();

/**
 * Whether `text` mentions `name` as a whole ref name, ignoring letter case,
 * because a case-insensitive file system resolves loose refs in any case.
 * With `looseLeft`, any character may precede it, for a short-option token
 * whose value is attached (`-sfeat/x`).
 */
export const mentionsName = (
  text: string,
  name: string,
  looseLeft = false
): boolean => {
  const haystack = fold(text);
  const needle = fold(name);
  if (!needle) {
    return false;
  }
  for (
    let index = haystack.indexOf(needle);
    index !== -1;
    index = haystack.indexOf(needle, index + 1)
  ) {
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    if (
      (looseLeft || before === undefined || !NAME_CHARACTER.test(before)) &&
      (after === undefined || !NAME_CHARACTER.test(after))
    ) {
      return true;
    }
  }
  return false;
};

const isShortOption = (token: string): boolean =>
  token.startsWith("-") && !token.startsWith("--");

// The long option `token` spells, or abbreviates, among `options`.
const spelledOption = (
  token: string,
  options: readonly string[]
): string | null => {
  if (!token.startsWith("--")) {
    return null;
  }
  const [name = ""] = token.split("=", 1);
  return name.length < MINIMUM_ABBREVIATION
    ? null
    : (options.find((option) => option.startsWith(name)) ?? null);
};

// A revision part names something indirect: a reflog, upstream, or push
// entry, a message search, FETCH_HEAD, the stash, or another worktree's refs.
const indirectRevision = (part: string): string | null => {
  const folded = fold(part);
  if (folded.includes("@{")) {
    return "reflog, upstream, push, or previous-branch syntax (`@{...}`)";
  }
  if (part.startsWith(":/")) {
    return "a commit-message search (`:/...`)";
  }
  if (FETCH_HEAD_PATTERN.test(folded)) {
    return "`FETCH_HEAD`, which can hold any fetched branch";
  }
  if (STASH_REF_PATTERN.test(folded)) {
    return "the stash, which every checkout shares";
  }
  return OTHER_WORKTREE_PATTERN.test(folded) ? "another worktree's refs" : null;
};

/**
 * The indirect form `token` uses, or null: an option that reads names from
 * elsewhere or carries every branch (also when abbreviated), the previous
 * branch `-`, or an indirect name in any revision inside it. Every-branch
 * options do not count for a fetch, whose `--all` means every remote.
 */
export const indirectForm = (
  token: string,
  everyBranchOptions = true
): string | null => {
  const reading = spelledOption(token, STDIN_OPTIONS);
  if (reading) {
    return `${reading}, which reads names loop exec cannot see`;
  }
  if (token === "-") {
    return "the previous branch (`-`)";
  }
  const every = everyBranchOptions
    ? spelledOption(token, EVERY_BRANCH_OPTIONS)
    : null;
  if (every) {
    return `${every}, which can include every branch`;
  }
  return (
    revisionParts(token)
      .map((part) => indirectRevision(part))
      .find(Boolean) ?? null
  );
};

// The revisions inside one argument: a long option's value, a short option's
// attached value, and each side of a range, without a leading `^`.
const revisionParts = (text: string): string[] => {
  let values = [text];
  if (text.startsWith("--")) {
    const separator = text.indexOf("=");
    values = separator === -1 ? [] : [text.slice(separator + 1)];
  } else if (text.startsWith("-")) {
    // A cluster such as `-qsstash^1` may attach a value after any letter.
    values = [...text.slice(2)].map((_, index) => text.slice(index + 2));
  }
  return values
    .flatMap((value) => [value, ...value.split(RANGE_SEPARATOR)])
    .map((part) => (part.startsWith("^") ? part.slice(1) : part))
    .filter(Boolean);
};

interface GitInvocation {
  arguments: string[];
  /** The directory the command runs in after every `-C`. */
  directory: string;
  /** `-C`, `-c`, and `--no-pager` tokens, replayed when reading facts. */
  globals: string[];
  /** Values of `-C` and `-c`, which are checked like arguments. */
  globalValues: string[];
  /** `--git-dir` or `--work-tree` chose the repository or checkout. */
  redirected: boolean;
  /** Null when a global option cannot be classified. */
  subcommand: string | null;
}

const parseGitInvocation = (
  argv: readonly string[],
  checkout: string
): GitInvocation => {
  const tokens = argv.slice(1);
  const invocation: GitInvocation = {
    arguments: [],
    directory: checkout,
    globals: [],
    globalValues: [],
    redirected: false,
    subcommand: null,
  };
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    const value = tokens[index + 1] ?? "";
    if (token === "-C" || token === "-c") {
      if (token === "-C") {
        invocation.directory = resolve(invocation.directory, value);
      }
      invocation.globals.push(token, value);
      invocation.globalValues.push(value);
      index += 2;
    } else if (token === "--git-dir" || token === "--work-tree") {
      invocation.redirected = true;
      invocation.globalValues.push(value);
      index += 2;
    } else if (
      token.startsWith("--git-dir=") ||
      token.startsWith("--work-tree=")
    ) {
      invocation.redirected = true;
      invocation.globalValues.push(token);
      index += 1;
    } else if (token === "--no-pager") {
      invocation.globals.push(token);
      index += 1;
    } else {
      if (!token.startsWith("-")) {
        invocation.subcommand = token;
        invocation.arguments = tokens.slice(index + 1);
      }
      return invocation;
    }
  }
  return invocation;
};

interface ScannedToken {
  /** A matching or wildcard refspec, which can carry every branch. */
  everyBranch: boolean;
  /** Check the text for pinned names and indirect forms. */
  names: boolean;
  /** Check whether the token points into a pinned checkout. */
  path: boolean;
  /** Check whether the text names a commit a pinned unit gained later. */
  revision: boolean;
  /** The part checked: a refspec contributes only its source. */
  text: string;
  token: string;
}

const scanned = (
  token: string,
  {
    everyBranch = false,
    names = true,
    path = !token.startsWith("-"),
    revision = true,
    text = token,
  } = {}
): ScannedToken => ({ everyBranch, names, path, revision, text, token });

const isKnownMergeOption = (token: string): boolean =>
  MERGE_FLAGS.has(token) ||
  MERGE_ATTACHED_PREFIXES.some(
    (prefix) => token.startsWith(prefix) && token.length > prefix.length
  ) ||
  token === "-S" ||
  token === "--gpg-sign";

// A merge's own message may name the branch it merges. Exempt `-m` values
// only while every earlier option is one this parser knows, so a value is
// never mistaken for the message option or the other way round.
const mergeTokens = (args: readonly string[]): ScannedToken[] => {
  const result: ScannedToken[] = [];
  let exempting = true;
  let index = 0;
  while (index < args.length) {
    const token = args[index] as string;
    index += 1;
    if (!exempting) {
      result.push(scanned(token));
    } else if (token === "-m" || token === "--message") {
      index += 1;
    } else if (token.startsWith("--message=") || token.startsWith("-m")) {
      // An attached message: `-mText` or `--message=Text`.
    } else if (MERGE_VALUE_OPTIONS.has(token)) {
      result.push(scanned(token));
      if (index < args.length) {
        result.push(scanned(args[index] as string));
        index += 1;
      }
    } else {
      exempting = !token.startsWith("-") || isKnownMergeOption(token);
      result.push(scanned(token));
    }
  }
  return result;
};

const refspecSource = (token: string): string => {
  const separator = token.indexOf(":");
  const source = separator === -1 ? token : token.slice(0, separator);
  return source.startsWith("+") ? source.slice(1) : source;
};

const refspecDestination = (token: string): string | null => {
  const separator = token.indexOf(":");
  return separator === -1 ? null : token.slice(separator + 1);
};

const MATCHING_REFSPECS: ReadonlySet<string> = new Set([":", "+:"]);

const carriesEveryBranch = (token: string): boolean =>
  MATCHING_REFSPECS.has(token) || refspecSource(token).includes("*");

// A push writes only the destination named after `:`, so only the source can
// carry a moving name: `<commit>:refs/heads/<branch>` is the pinned form.
const pushTokens = (args: readonly string[]): ScannedToken[] =>
  args.flatMap((token): ScannedToken[] => {
    if (token.startsWith("--force-with-lease=")) {
      const lease = token.slice("--force-with-lease=".length);
      const separator = lease.indexOf(":");
      return separator === -1
        ? []
        : [
            scanned(token, {
              revision: false,
              text: lease.slice(separator + 1),
            }),
          ];
    }
    if (token.startsWith("-")) {
      return [scanned(token)];
    }
    return [
      scanned(token, {
        everyBranch: carriesEveryBranch(token),
        text: refspecSource(token),
      }),
    ];
  });

// A fetch source names the other repository's refs, so it is never resolved
// here. A colon-less fetch writes only remote-tracking refs and `FETCH_HEAD`,
// which later commands cannot name for a pinned unit, so only a source with
// a destination is checked for pinned names; the repository may still point
// into a pinned checkout.
const fetchTokens = (args: readonly string[]): ScannedToken[] =>
  args.map((token) => {
    if (token.startsWith("-")) {
      return scanned(token, { revision: false });
    }
    const writes = refspecDestination(token) !== null;
    return scanned(token, {
      everyBranch: writes && carriesEveryBranch(token),
      names: writes,
      revision: false,
      text: refspecSource(token),
    });
  });

const isBranchDeletion = (args: readonly string[]): boolean =>
  args.some((token) => DELETION_OPTIONS.has(token)) &&
  args.every(
    (token) => !token.startsWith("-") || BRANCH_DELETION_COMPANIONS.has(token)
  );

const isKnownOption = (token: string, grammar: OptionGrammar): boolean =>
  grammar.flags.has(token) ||
  grammar.values.has(token) ||
  grammar.attached.some(
    (prefix) => token.startsWith(prefix) && token.length > prefix.length
  );

// The options of a push or fetch that this parser does not know. Git accepts
// abbreviations and new options this table cannot classify, so each refuses.
const unknownOptions = (
  args: readonly string[],
  grammar: OptionGrammar
): string[] => {
  const unknown: string[] = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index] as string;
    index += 1;
    if (token === "--") {
      return unknown;
    }
    if (grammar.values.has(token)) {
      index += 1;
    } else if (token.startsWith("-") && !isKnownOption(token, grammar)) {
      unknown.push(token);
    }
  }
  return unknown;
};

// A push that deletes, read with every option understood, so `-d` is never
// the value of another option.
const isPushDeletion = (args: readonly string[]): boolean =>
  unknownOptions(args, PUSH_GRAMMAR).length === 0 &&
  operandsAndFlags(args, PUSH_GRAMMAR).flags.some(
    (token) => token === "-d" || token === "--delete"
  );

const operandsAndFlags = (
  args: readonly string[],
  grammar: OptionGrammar
): { flags: string[]; operands: string[] } => {
  const flags: string[] = [];
  const operands: string[] = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index] as string;
    index += 1;
    if (token === "--") {
      operands.push(...args.slice(index));
      break;
    }
    if (grammar.values.has(token)) {
      index += 1;
    } else if (token.startsWith("-")) {
      flags.push(token);
    } else {
      operands.push(token);
    }
  }
  return { flags, operands };
};

// A read-only command that writes a file (`git diff --output=<file>`) can
// carry a moved commit's content to a later `git apply`, so it is checked
// like a merge-like command.
const writesOutputFile = (args: readonly string[]): boolean =>
  args.some((token) => spelledOption(token, ["--output"]) !== null);

/** Forms of a merge-like subcommand that integrate nothing. */
const integratesNothing = (
  subcommand: string,
  args: readonly string[]
): boolean => {
  if (subcommand === "worktree") {
    return args[0] !== "add";
  }
  if (subcommand === "remote") {
    return REMOTE_READERS.has(args[0] ?? "-v");
  }
  if (subcommand === "stash") {
    return STASH_LISTERS.has(args[0] ?? "");
  }
  if (subcommand === "branch") {
    return isBranchDeletion(args);
  }
  if (subcommand === "push") {
    return isPushDeletion(args);
  }
  return false;
};

const ownTokens = (subcommand: string, args: readonly string[]) => {
  if (subcommand === "merge") {
    return mergeTokens(args);
  }
  if (subcommand === "push") {
    return pushTokens(args);
  }
  if (subcommand === "fetch") {
    return fetchTokens(args);
  }
  return args.map((token) => scanned(token));
};

// Global option values are checked for names only: `-C` is resolved
// separately, and a `-c` value is configuration, not a path.
const tokensFor = (invocation: GitInvocation): ScannedToken[] => [
  ...invocation.globalValues.map((value) =>
    scanned(value, { path: false, revision: false })
  ),
  ...ownTokens(invocation.subcommand ?? "", invocation.arguments),
];

const SHORT_REF_PREFIXES = [
  "refs/heads/",
  "refs/remotes/",
  "refs/tags/",
  "refs/",
];

// The name a command would use for a ref; the matcher also finds it inside
// every longer spelling.
const shortRefName = (name: string): string => {
  const prefix = SHORT_REF_PREFIXES.find((item) => name.startsWith(item));
  return prefix ? name.slice(prefix.length) : name;
};

// Names that resolve to a pinned branch: the branch itself and every
// symbolic ref whose target chain reaches its local or remote-tracking ref.
const pinnedNames = (
  pins: readonly PinnedUnit[],
  refs: readonly GitRefRecord[]
): Map<PinnedUnit, string[]> => {
  const names = new Map<PinnedUnit, string[]>();
  for (const unit of pins) {
    if (!unit.branch) {
      continue;
    }
    const aliases = new Set([unit.branch]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const ref of refs) {
        if (
          ref.symref &&
          !aliases.has(shortRefName(ref.name)) &&
          [...aliases].some((alias) => mentionsName(ref.symref, alias))
        ) {
          aliases.add(shortRefName(ref.name));
          // `<remote>` alone resolves to `refs/remotes/<remote>/HEAD`.
          if (
            ref.name.startsWith("refs/remotes/") &&
            ref.name.endsWith("/HEAD")
          ) {
            aliases.add(
              ref.name.slice("refs/remotes/".length, -"/HEAD".length)
            );
          }
          grew = true;
        }
      }
    }
    names.set(unit, [...aliases]);
  }
  return names;
};

// Paths compare without letter case or Unicode normalization differences,
// which a case-insensitive file system ignores.
const samePath = (left: string, right: string): boolean =>
  fold(left) === fold(right);

const isWithin = (path: string, directory: string): boolean =>
  samePath(path, directory) ||
  fold(path).startsWith(fold(`${directory}${sep}`));

/** The checkout that owns `path`: the deepest listed worktree containing it. */
const owningCheckout = (
  path: string,
  worktreePaths: readonly string[]
): string | null => {
  let owner: string | null = null;
  for (const candidate of worktreePaths) {
    if (
      isWithin(path, candidate) &&
      (owner === null || candidate.length > owner.length)
    ) {
      owner = candidate;
    }
  }
  return owner;
};

// The real path of `path`, resolving symbolic links in its deepest existing
// ancestor when the path itself does not exist yet.
const canonicalPath = (path: string): string => {
  const missing: string[] = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      return resolve(path);
    }
    missing.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...missing);
  } catch {
    return resolve(path);
  }
};

interface PinnedLocation {
  /** What the path reaches, for the refusal. */
  description: string;
  unit: PinnedUnit | null;
}

const checkoutCandidates = (context: PinnedCommandContext): string[] => [
  ...context.worktreePaths,
  ...context.pins.map((unit) => unit.path),
];

/**
 * Whether a local path reaches a pinned checkout: it lies in one, including
 * one whose checkout is absent now but could be restored while the command
 * waits, or Git would open it as one (Git also tries `<path>.git`), or it is
 * a linked worktree's own Git directory, whose HEAD is that worktree's.
 */
const pinnedLocation = (
  path: string,
  context: PinnedCommandContext
): PinnedLocation | null => {
  const worktreeGitDirectories = join(
    canonicalPath(context.commonGitDirectory),
    "worktrees"
  );
  for (const variant of [path, `${path}.git`]) {
    const canonical = canonicalPath(variant);
    if (isWithin(canonical, worktreeGitDirectories)) {
      return {
        description: `a linked worktree's Git directory under ${worktreeGitDirectories}`,
        unit: null,
      };
    }
    const owner = owningCheckout(canonical, checkoutCandidates(context));
    const unit = context.pins.find(
      (item) => owner !== null && samePath(item.path, owner)
    );
    if (unit) {
      return { description: `the pinned checkout ${unit.path}`, unit };
    }
  }
  return null;
};

/**
 * A checkout the run does not author that holds `path`: Git run there reads a
 * HEAD this command does not control, whether or not that checkout is pinned
 * (a pinned checkout may have been moved).
 */
const foreignCheckout = (
  path: string,
  context: PinnedCommandContext
): PinnedLocation | null => {
  const owner = owningCheckout(path, checkoutCandidates(context));
  return owner &&
    !context.ownCheckouts.some((checkout) => samePath(checkout, owner))
    ? {
        description: `the checkout ${owner}, which this run does not author`,
        unit: context.pins.find((unit) => samePath(unit.path, owner)) ?? null,
      }
    : null;
};

// The local path a token may name: a plain path, `~/...`, or a `file://` URL
// (with any host and percent encoding). Other URLs and `host:path` forms are
// not local paths.
const localPath = (token: string, directory: string): string | null => {
  let text = token;
  if (text.toLowerCase().startsWith("file://")) {
    const rest = text.slice("file://".length);
    text = rest.slice(
      rest.indexOf("/") === -1 ? rest.length : rest.indexOf("/")
    );
    if (PERCENT_ESCAPE.test(text)) {
      try {
        text = decodeURIComponent(text);
      } catch {
        return null;
      }
    }
  } else if (URL_SCHEME.test(text) || SCP_HOST.test(text)) {
    return null;
  }
  if (text === "~" || text.startsWith("~/")) {
    return join(homedir(), text.slice(1));
  }
  return text ? resolve(directory, text) : null;
};

// A token that may name a repository or a checkout path reaches a pinned one.
const pinnedLocationFor = (
  token: string,
  directory: string,
  context: PinnedCommandContext
): PinnedLocation | null => {
  const path = localPath(token, directory);
  return path === null ? null : pinnedLocation(path, context);
};

const refusal = (
  kind: PinnedRefusalKind,
  detail: string,
  token: string | null = null,
  unit: PinnedUnit | null = null
): PinnedRefusal => ({ detail, kind, token, unit });

const PINNED_UNIT_STATE_TEXT: Record<PinnedUnitState, string> = {
  adopted: "adopted after a pause",
  claimed: "still claimed",
  "handed-off": "handed off",
  preserved: "preserved",
  released: "released",
  retained: "retained",
  unrecorded: "registered without a recorded release",
};

/** A pinned unit as refusals and violations name it. */
export const describePinnedUnit = (unit: PinnedUnit): string =>
  `${unit.branch ? `${unit.branch} of ${unit.path}` : `the detached checkout ${unit.path}`} (${PINNED_UNIT_STATE_TEXT[unit.state]}${unit.owner ? ` by ${unit.owner}` : ""})`;

const describeUnit = (unit: PinnedUnit): string => {
  const recorded = unit.recordedHeads.at(-1);
  return `pinned branch ${describePinnedUnit(unit)}, ${recorded ? `recorded at ${recorded}` : "with no recorded head"}`;
};

const tokenRefusals = (
  item: ScannedToken,
  names: Map<PinnedUnit, string[]>,
  directory: string,
  context: PinnedCommandContext,
  everyBranchOptions: boolean
): PinnedRefusal[] => {
  const found: PinnedRefusal[] = [];
  if (item.names) {
    const looseLeft = isShortOption(item.text);
    for (const [unit, aliases] of names) {
      if (aliases.some((alias) => mentionsName(item.text, alias, looseLeft))) {
        found.push(
          refusal("named", `it names ${describeUnit(unit)}`, item.token, unit)
        );
      }
    }
    const indirect = indirectForm(item.text, everyBranchOptions);
    if (indirect) {
      found.push(
        refusal(
          "indirect",
          `${item.token} uses ${indirect}, which can name a pinned branch`,
          item.token
        )
      );
    }
  }
  if (item.everyBranch) {
    found.push(
      refusal(
        "indirect",
        `${item.token} is a matching or wildcard refspec, which can carry every branch`,
        item.token
      )
    );
  }
  const reached = item.path
    ? pinnedLocationFor(item.token, directory, context)
    : null;
  if (reached) {
    found.push(
      refusal(
        "checkout",
        `${item.token} points into ${reached.description}`,
        item.token,
        reached.unit
      )
    );
  }
  return found;
};

interface MovedUnit {
  /** The oldest commits the unit gained after its recorded heads. */
  firstCommits: string[];
  /** More commits than the limit, so they were not listed. */
  unbounded: boolean;
  unit: PinnedUnit;
}

// The commits each pinned unit gained after its recorded heads, wherever its
// local branch or its checkout now points. A remote's copy of the branch is
// another repository's ref; commands that name it are refused by name.
const movedUnits = (
  context: PinnedCommandContext,
  refs: readonly GitRefRecord[],
  globals: readonly string[]
): MovedUnit[] =>
  context.pins.flatMap((unit): MovedUnit[] => {
    if (unit.recordedHeads.length === 0) {
      return [];
    }
    const tips = new Set<string>();
    const head = context.checkoutHeads.get(unit.path);
    if (head) {
      tips.add(head);
    }
    for (const ref of unit.branch ? refs : []) {
      if (ref.name === `refs/heads/${unit.branch}`) {
        tips.add(ref.object);
      }
    }
    return [...tips]
      .filter((tip) => !unit.recordedHeads.includes(tip))
      .flatMap((tip): MovedUnit[] => {
        const commits = context.facts.unrecordedCommits(
          globals,
          tip,
          unit.recordedHeads,
          UNRECORDED_COMMIT_LIMIT
        );
        if (commits === null || commits.length > UNRECORDED_COMMIT_LIMIT) {
          return [{ firstCommits: [], unbounded: true, unit }];
        }
        const listed = new Set(commits.map((item) => item.commit));
        const firstCommits = commits
          .filter((item) => item.parents.every((parent) => !listed.has(parent)))
          .map((item) => item.commit);
        return firstCommits.length > 0
          ? [{ firstCommits, unbounded: false, unit }]
          : [];
      });
  });

// The commits a token may name: each revision part without its peel, path,
// or ancestry suffix, since the commit it starts from is what must not
// contain a moved commit.
const revisionCandidates = (text: string): string[] =>
  revisionParts(text)
    .map((part) => part.split(REVISION_SUFFIX, 1)[0] ?? "")
    .filter((part) => part && !part.startsWith("-"));

// Each revision a merge-like command may integrate: its arguments, and the
// upstream a merge or rebase reads when it names none.
const integratedRevisions = (
  invocation: GitInvocation,
  items: readonly ScannedToken[],
  facts: PinnedGitFacts
): { revision: string; token: string }[] => {
  const revisions = items
    .filter((item) => item.revision)
    .flatMap((item) =>
      revisionCandidates(item.text).map((revision) => ({
        revision,
        token: item.token,
      }))
    );
  if (
    (invocation.subcommand === "merge" || invocation.subcommand === "rebase") &&
    !hasExplicitRevision(invocation.subcommand, invocation.arguments)
  ) {
    for (const upstream of facts.upstreams(invocation.globals)) {
      revisions.push({ revision: upstream, token: upstream });
    }
  }
  return revisions;
};

// Why one revision would integrate a moved unit's later commit, or null.
const revisionContainment = (
  revision: string,
  token: string,
  moved: readonly MovedUnit[],
  invocation: GitInvocation,
  facts: PinnedGitFacts
): PinnedRefusal[] => {
  const type = facts.objectType(invocation.globals, revision);
  if (type === "tree" || type === "blob") {
    return [
      refusal(
        "moved",
        `${token} names a ${type}, which loop exec cannot prove does not come from a commit a pinned unit gained after its recorded head`,
        token
      ),
    ];
  }
  const commit = type
    ? facts.resolveCommit(invocation.globals, revision)
    : null;
  if (!commit) {
    return [];
  }
  return moved.flatMap((entry) => {
    if (entry.unbounded) {
      return [
        refusal(
          "moved",
          `${describeUnit(entry.unit)} carries more than ${UNRECORDED_COMMIT_LIMIT} commits after its recorded head, too many to check ${token} against`,
          token,
          entry.unit
        ),
      ];
    }
    const reached = entry.firstCommits.find((first) =>
      facts.isAncestor(invocation.globals, first, commit)
    );
    return reached
      ? [
          refusal(
            "moved",
            `${token} contains ${reached}, which ${describeUnit(entry.unit)} gained after its recorded head`,
            token,
            entry.unit
          ),
        ]
      : [];
  });
};

// A revision that contains a commit a pinned unit gained after its recorded
// head would integrate that commit, whatever name or ID reached it; so would a
// tree or blob, whose commit cannot be traced.
const containmentRefusals = (
  invocation: GitInvocation,
  items: readonly ScannedToken[],
  moved: readonly MovedUnit[],
  context: PinnedCommandContext
): PinnedRefusal[] =>
  moved.length === 0
    ? []
    : integratedRevisions(invocation, items, context.facts).flatMap(
        ({ revision, token }) =>
          revisionContainment(revision, token, moved, invocation, context.facts)
      );

const configuredRefusals = (
  invocation: GitInvocation,
  names: Map<PinnedUnit, string[]>,
  context: PinnedCommandContext
): PinnedRefusal[] => {
  const { arguments: args, globals, subcommand } = invocation;
  const found: PinnedRefusal[] = [];
  const mentionsPin = (value: string): PinnedUnit | null => {
    for (const [unit, aliases] of names) {
      if (aliases.some((alias) => mentionsName(value, alias))) {
        return unit;
      }
    }
    return null;
  };
  if (
    (subcommand === "merge" || subcommand === "rebase") &&
    !args.some((token) => CONTINUATION_OPTIONS.has(token)) &&
    !hasExplicitRevision(subcommand, args)
  ) {
    for (const upstream of context.facts.upstreams(globals)) {
      const unit = mentionsPin(upstream);
      if (unit) {
        found.push(
          refusal(
            "configured",
            `the current branch's upstream ${upstream} is ${describeUnit(unit)}, which git ${subcommand} uses when no revision is named`,
            null,
            unit
          )
        );
      }
    }
  }
  if (
    subcommand === "fetch" ||
    subcommand === "push" ||
    subcommand === "remote"
  ) {
    found.push(...remoteConfigRefusals(invocation, mentionsPin, context));
  }
  return found;
};

const configuredFetchWritesLocalRef = (value: string): boolean => {
  const destination = refspecDestination(value);
  return (
    destination !== null &&
    destination !== "" &&
    !CONFIGURED_FETCH_PREFIXES.some((prefix) => destination.startsWith(prefix))
  );
};

const remoteConfigRefusals = (
  invocation: GitInvocation,
  mentionsPin: (value: string) => PinnedUnit | null,
  context: PinnedCommandContext
): PinnedRefusal[] => {
  const found: PinnedRefusal[] = [];
  const fetching = invocation.subcommand !== "push";
  const implicitPush =
    invocation.subcommand === "push" &&
    operandsAndFlags(invocation.arguments, PUSH_GRAMMAR).operands.length < 2;
  for (const [key, value] of context.facts.config(
    invocation.globals,
    "^(push\\.default|remote\\..*\\.(fetch|push|mirror))$"
  )) {
    const lowered = key.toLowerCase();
    const unit = lowered.startsWith("remote.") ? mentionsPin(value) : null;
    let reason: string | null = null;
    if (unit) {
      reason = `names ${describeUnit(unit)}`;
    } else if (
      fetching &&
      lowered.endsWith(".fetch") &&
      configuredFetchWritesLocalRef(value)
    ) {
      reason = "writes a local ref other than a remote-tracking one";
    } else if (implicitPush && pushesEveryBranch(lowered, value)) {
      reason = "can push every branch when a push names no refspec";
    } else if (implicitPush && lowered.endsWith(".push")) {
      reason =
        "chooses what a push that names no refspec sends; name the refspec";
    }
    if (reason) {
      found.push(
        refusal("configured", `${key} = ${value} ${reason}`, null, unit)
      );
    }
  }
  if (fetching) {
    for (const name of context.facts.legacyRemotes()) {
      found.push(
        refusal(
          "configured",
          `the legacy remote file ${name} can map a fetch into a local branch`
        )
      );
    }
  }
  return found;
};

const pushesEveryBranch = (key: string, value: string): boolean => {
  if (key === "push.default") {
    return value.toLowerCase() === "matching";
  }
  if (key.endsWith(".mirror")) {
    return value.toLowerCase() !== "false" && value !== "0" && value !== "";
  }
  return (
    key.endsWith(".push") &&
    (value === ":" || value === "+:" || value.includes("*"))
  );
};

// Whether a merge or rebase names what it integrates, so no upstream stands
// in for it. Only a fully understood merge counts; a rebase always reads its
// upstream.
const hasExplicitRevision = (
  subcommand: string,
  args: readonly string[]
): boolean => {
  if (subcommand !== "merge") {
    return false;
  }
  let index = 0;
  while (index < args.length) {
    const token = args[index] as string;
    index += 1;
    if (token === "--") {
      return index < args.length;
    }
    if (
      token === "-m" ||
      token === "--message" ||
      MERGE_VALUE_OPTIONS.has(token)
    ) {
      index += 1;
    } else if (!token.startsWith("-")) {
      return true;
    } else if (
      !(
        isKnownMergeOption(token) ||
        token.startsWith("-m") ||
        token.startsWith("--message=")
      )
    ) {
      return false;
    }
  }
  return false;
};

// Git subcommands and options that run another command, which could run Git
// out of this check's sight, or that write configuration later commands
// would follow.
const EXECUTING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "difftool",
  "filter-branch",
  "instaweb",
  "mergetool",
  "web--browse",
]);
const EXECUTION_OPTIONS = ["--exec", "--receive-pack", "--upload-pack"];
const CONFIG_READ_OPTIONS: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-color",
  "--get-colorbool",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l",
]);

// Merge strategies Git implements itself; any other name runs the program
// `git-merge-<name>`.
const BUILTIN_STRATEGIES: ReadonlySet<string> = new Set([
  "octopus",
  "ort",
  "ours",
  "recursive",
  "resolve",
  "subtree",
]);
const STRATEGY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "cherry-pick",
  "merge",
  "rebase",
  "revert",
]);

// The merge strategies a command names, attached or in the next argument.
// Short options whose value is the rest of the token or the next argument,
// per subcommand; any other letter in a cluster such as `-qx` is a flag.
const SHORT_VALUE_LETTERS: Readonly<Record<string, string>> = {
  "cherry-pick": "mXS",
  merge: "mFsXS",
  rebase: "xsXCS",
  revert: "mXS",
};

// The short options a single-dash cluster spells, each with its value when
// it takes one: `-qx cmd` is `-q` and `-x cmd`, `-sours` is `-s ours`.
const shortOptions = (
  subcommand: string,
  token: string,
  next: string
): { letter: string; value: string | null }[] => {
  if (!token.startsWith("-") || token.startsWith("--")) {
    return [];
  }
  const valued = SHORT_VALUE_LETTERS[subcommand] ?? "";
  const options: { letter: string; value: string | null }[] = [];
  for (let index = 1; index < token.length; index += 1) {
    const letter = token[index] as string;
    if (valued.includes(letter)) {
      const rest = token.slice(index + 1);
      // `-S` takes its key only when attached.
      options.push({ letter, value: rest || (letter === "S" ? "" : next) });
      break;
    }
    options.push({ letter, value: null });
  }
  return options;
};

// The merge strategies a command names, in any spelling.
const strategies = (subcommand: string, args: readonly string[]): string[] =>
  args.flatMap((token, index) => {
    const next = args[index + 1] ?? "";
    if (spelledOption(token, ["--strategy"])) {
      const separator = token.indexOf("=");
      return [separator === -1 ? next : token.slice(separator + 1)];
    }
    // cherry-pick and revert spell signoff `-s`; they take only `--strategy`.
    return subcommand === "merge" || subcommand === "rebase"
      ? shortOptions(subcommand, token, next)
          .filter((option) => option.letter === "s")
          .map((option) => option.value ?? "")
      : [];
  });

// Short option letters that run a command, per subcommand, in any cluster.
const EXECUTING_LETTERS: Readonly<Record<string, string>> = {
  clone: "u",
  grep: "O",
  "ls-remote": "u",
  rebase: "ix",
};

const executesByLetter = (subcommand: string, token: string): boolean => {
  const letters = EXECUTING_LETTERS[subcommand];
  if (!(letters && token.startsWith("-")) || token.startsWith("--")) {
    return false;
  }
  if (SHORT_VALUE_LETTERS[subcommand]) {
    return shortOptions(subcommand, token, "").some((option) =>
      letters.includes(option.letter)
    );
  }
  // Without a table of this subcommand's value letters, any occurrence
  // counts, even inside a value.
  return [...token.slice(1)].some((letter) => letters.includes(letter));
};

const executes = (subcommand: string, args: readonly string[]): boolean => {
  if (EXECUTING_SUBCOMMANDS.has(subcommand)) {
    return true;
  }
  if (
    STRATEGY_SUBCOMMANDS.has(subcommand) &&
    strategies(subcommand, args).some((name) => !BUILTIN_STRATEGIES.has(name))
  ) {
    return true;
  }
  const option = (token: string, options: readonly string[]) =>
    spelledOption(token, options) !== null;
  return args.some(
    (token) =>
      option(token, EXECUTION_OPTIONS) ||
      executesByLetter(subcommand, token) ||
      (subcommand === "rebase" &&
        option(token, ["--interactive", "--edit-todo"])) ||
      (subcommand === "grep" && option(token, ["--open-files-in-pager"])) ||
      (subcommand === "bisect" && token === "run") ||
      (subcommand === "submodule" && token === "foreach")
  );
};

// A configuration write, or `git init`, which reinitializes this repository
// and can install hooks from a template.
const writesConfiguration = (
  subcommand: string,
  args: readonly string[]
): boolean =>
  subcommand === "init" || (subcommand === "config" && !isConfigRead(args));

// A `git config` read: its first argument is a read action. Anything else,
// including a read option after other options, whose values this does not
// parse, counts as a write.
const isConfigRead = (args: readonly string[]): boolean => {
  const [action = ""] = args;
  return (
    CONFIG_READ_OPTIONS.has(action) || action === "get" || action === "list"
  );
};

// Rules that hold for every Git command, read-only ones included: `-c` can
// make Git run a command (`core.fsmonitor`, `core.pager`) or read a name this
// check cannot see, and so can the execution forms above.
const commandRefusals = (invocation: GitInvocation): PinnedRefusal[] => {
  const { arguments: args, subcommand } = invocation;
  const found: PinnedRefusal[] = [];
  if (invocation.globals.includes("-c")) {
    found.push(
      refusal(
        "unclassified",
        "-c can make Git run a command or read a name loop exec cannot see; set configuration before the run"
      )
    );
  }
  if (subcommand && executes(subcommand, args)) {
    found.push(
      refusal(
        "unclassified",
        `git ${subcommand} would run another command, which could run Git out of sight`
      )
    );
  }
  if (subcommand && writesConfiguration(subcommand, args)) {
    found.push(
      refusal(
        "unclassified",
        `git ${subcommand} would write configuration that later commands follow; set it before the run`
      )
    );
  }
  return found;
};

const STASH_READERS: ReadonlySet<string> = new Set(["apply", "branch", "pop"]);
const STASH_LISTERS: ReadonlySet<string> = new Set(["list", "show"]);
// Stash actions that read only the working tree, or a commit they name.
const STASH_WRITERS: ReadonlySet<string> = new Set([
  "",
  "clear",
  "create",
  "drop",
  "push",
  "save",
  "store",
]);
const REMOTE_READERS: ReadonlySet<string> = new Set([
  "-v",
  "--verbose",
  "get-url",
  "show",
]);

// The stash is shared by every checkout, so another checkout's `git stash`
// moves the entry an implicit or numbered stash names. Only a full commit ID
// pins one.
const stashRefusals = (invocation: GitInvocation): PinnedRefusal[] => {
  const [first = "", ...others] = invocation.arguments;
  // `git stash -m <message>` and other bare options are `git stash push`.
  const action = first.startsWith("-") ? "" : first;
  const rest = first.startsWith("-") ? invocation.arguments : others;
  if (invocation.subcommand !== "stash" || STASH_WRITERS.has(action)) {
    return [];
  }
  if (!STASH_READERS.has(action)) {
    return [
      refusal(
        "unclassified",
        `git stash ${action} is not a stash action loop exec classifies while units are pinned`
      ),
    ];
  }
  const operands = rest.filter((token) => !token.startsWith("-"));
  const entry = operands.at(action === "branch" ? 1 : 0);
  return entry && isObjectId(entry)
    ? []
    : [
        refusal(
          "indirect",
          `git stash ${action} reads a stash entry that another checkout's git stash can replace; name the entry's full commit ID`
        ),
      ];
};

// A fetch writes through a symbolic ref, so a remote-tracking name that
// points outside `refs/remotes/` would let it update a local branch.
const symbolicDestinationRefusals = (
  refs: readonly GitRefRecord[]
): PinnedRefusal[] =>
  refs
    .filter(
      (ref) =>
        ref.symref &&
        ref.name.startsWith(REMOTE_TRACKING_PREFIX) &&
        !ref.symref.startsWith(REMOTE_TRACKING_PREFIX)
    )
    .map((ref) =>
      refusal(
        "configured",
        `${ref.name} is a symbolic ref to ${ref.symref}, so a fetch could write that ref`,
        ref.name
      )
    );

// Push and fetch rules that do not depend on any one argument's text.
const transferRefusals = (
  invocation: GitInvocation,
  refs: readonly GitRefRecord[]
): PinnedRefusal[] => {
  const { arguments: args, subcommand } = invocation;
  if (subcommand !== "push" && subcommand !== "fetch") {
    return [];
  }
  const grammar = subcommand === "push" ? PUSH_GRAMMAR : FETCH_GRAMMAR;
  const found = unknownOptions(args, grammar).map((token) =>
    refusal(
      "unclassified",
      `git ${subcommand} option ${token} is not one loop exec can classify; spell out a known option`,
      token
    )
  );
  if (subcommand === "push" && args.includes("--tags")) {
    found.push(
      refusal(
        "indirect",
        "--tags pushes every tag, including one another agent made on a moved unit",
        "--tags"
      )
    );
  }
  if (subcommand === "fetch") {
    found.push(...symbolicDestinationRefusals(refs));
    // The first operand is the repository; with --all or --multiple every
    // operand is a repository or group.
    const { flags, operands } = operandsAndFlags(args, grammar);
    const refspecs = flags.some(
      (flag) => flag === "--all" || flag === "--multiple"
    )
      ? []
      : operands.slice(1);
    for (const token of refspecs) {
      const destination = refspecDestination(token);
      const target = destination?.startsWith("+")
        ? destination.slice(1)
        : destination;
      if (target && !target.startsWith(REMOTE_TRACKING_PREFIX)) {
        found.push(
          refusal(
            "unclassified",
            `${token} writes ${target}, a local ref other than a remote-tracking one`,
            token
          )
        );
      }
    }
  }
  return found;
};

// One refusal per kind, argument, and unit: a token can be both a path and a
// name, and a revision can contain several moved commits.
const distinct = (refusals: readonly PinnedRefusal[]): PinnedRefusal[] => {
  const seen = new Set<string>();
  return refusals.filter((item) => {
    const key = [item.kind, item.token ?? "", item.unit?.path ?? ""].join("\0");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const locationRefusals = (
  invocation: GitInvocation,
  context: PinnedCommandContext
): PinnedRefusal[] => {
  const found: PinnedRefusal[] = [];
  if (invocation.redirected) {
    found.push(
      refusal(
        "checkout",
        "--git-dir or --work-tree hides which checkout's HEAD it uses"
      )
    );
  }
  const directory = canonicalPath(invocation.directory);
  const reached =
    pinnedLocation(directory, context) ?? foreignCheckout(directory, context);
  if (reached) {
    found.push(
      refusal(
        "checkout",
        `it runs in ${reached.description}, whose HEAD can move under it`,
        null,
        reached.unit
      )
    );
  } else if (!existsSync(invocation.directory)) {
    found.push(
      refusal(
        "checkout",
        `it runs in ${invocation.directory}, which does not exist yet and could become any checkout while the command waits`
      )
    );
  }
  return found;
};

const gitRefusals = (
  invocation: GitInvocation,
  context: PinnedCommandContext
): PinnedRefusal[] => {
  const { subcommand } = invocation;
  if (subcommand === null) {
    return [
      refusal(
        "unclassified",
        "a Git global option hides which subcommand runs"
      ),
    ];
  }
  const always = commandRefusals(invocation);
  if (
    (READ_ONLY_SUBCOMMANDS.has(subcommand) &&
      !writesOutputFile(invocation.arguments)) ||
    integratesNothing(subcommand, invocation.arguments)
  ) {
    return always;
  }
  if (!ALLOWED_WHILE_PINNED.has(subcommand)) {
    const alias =
      !MERGE_LIKE_BUILTINS.has(subcommand) &&
      context.facts.hasAlias(invocation.globals, subcommand);
    return [
      ...always,
      alias
        ? refusal(
            "alias",
            `git ${subcommand} is an alias, which loop exec does not expand while units are pinned`,
            subcommand
          )
        : refusal(
            "unclassified",
            subcommand === "pull"
              ? "git pull resolves its repository, refspecs, and upstream when it runs; fetch, then merge the recorded commit"
              : `git ${subcommand} is not one of the merge-like commands loop exec runs while units are pinned (${[...ALLOWED_WHILE_PINNED].join(", ")})`,
            subcommand
          ),
    ];
  }
  const found = [
    ...always,
    ...locationRefusals(invocation, context),
    ...transferRefusals(invocation, context.facts.refs(invocation.globals)),
    ...stashRefusals(invocation),
  ];
  const refs = context.facts.refs(invocation.globals);
  const replaced = refs.find((ref) => ref.name.startsWith("refs/replace/"));
  if (replaced || context.facts.grafted()) {
    found.push(
      refusal(
        "replaced",
        `${replaced ? `replace ref ${replaced.name}` : "a graft file"} can make a commit ID name another commit`
      )
    );
  }
  const names = pinnedNames(context.pins, refs);
  const items = tokensFor(invocation);
  const inPinnedCheckout = found.some((item) => item.kind === "checkout");
  for (const item of items) {
    found.push(
      ...tokenRefusals(
        // Inside a pinned checkout every relative path is in it; that
        // checkout is already refused once.
        inPinnedCheckout ? { ...item, path: false } : item,
        names,
        invocation.directory,
        context,
        subcommand !== "fetch"
      )
    );
  }
  found.push(
    ...configuredRefusals(invocation, names, context),
    ...containmentRefusals(
      invocation,
      items,
      movedUnits(context, refs, invocation.globals),
      context
    )
  );
  return distinct(found);
};

const programName = (path: string): string =>
  basename(path).toLowerCase().replace(EXE_SUFFIX, "");

// Git run by another program: a command runner whose arguments mention Git
// anywhere (a shell script, an interpreter's code), or any program given Git
// as a whole argument (`xcrun git`, `mise exec -- git`).
// `git`, or a dashed Git program such as `git-merge`.
const isGitProgram = (word: string): boolean =>
  programName(word) === "git" || DASHED_GIT_PROGRAM.test(programName(word));

const wrappedRefusals = (argv: readonly string[]): PinnedRefusal[] => {
  const [command = ""] = argv;
  const args = argv.slice(1);
  const runsGit =
    args.some((arg) => isGitProgram(arg)) ||
    (COMMAND_RUNNERS.has(programName(command)) &&
      args
        .flatMap((arg) => arg.split(WRAPPER_WORD_SEPARATOR))
        .some((word) => isGitProgram(word)));
  return runsGit
    ? [
        refusal(
          "wrapped",
          `it runs Git through ${command}, which hides the subcommand, upstream, and configuration Git will use; run Git directly`
        ),
      ]
    : [];
};

const FAST_FORWARD_MODES: ReadonlySet<string> = new Set([
  "--ff",
  "--ff-only",
  "--no-ff",
]);

// A merge that can only fast-forward creates no commit, so its result does
// not depend on how the commit was named. Every option must be understood,
// and the last fast-forward mode wins, as in Git.
const isFastForwardOnlyMerge = (args: readonly string[]): boolean => {
  let mode = "--ff";
  let index = 0;
  while (index < args.length) {
    const token = args[index] as string;
    index += 1;
    if (
      token === "-m" ||
      token === "--message" ||
      MERGE_VALUE_OPTIONS.has(token)
    ) {
      index += 1;
    } else if (FAST_FORWARD_MODES.has(token)) {
      mode = token;
    } else if (token === "--squash" || token === "--") {
      return false;
    } else if (
      token.startsWith("-") &&
      !(
        isKnownMergeOption(token) ||
        token.startsWith("-m") ||
        token.startsWith("--message=")
      )
    ) {
      return false;
    }
  }
  return mode === "--ff-only";
};

const CHERRY_PICK_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "-n",
  "-s",
  "-x",
  "--allow-empty",
  "--allow-empty-message",
  "--commit",
  "--edit",
  "--ff",
  "--keep-redundant-commits",
  "--no-commit",
  "--no-edit",
  "--no-ff",
  "--no-gpg-sign",
  "--no-rerere-autoupdate",
  "--no-signoff",
  "--rerere-autoupdate",
  "--signoff",
]);
const CHERRY_PICK_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-X",
  "-m",
  "--cleanup",
  "--empty",
  "--mainline",
  "--strategy",
  "--strategy-option",
]);
const RESET_FLAGS: ReadonlySet<string> = new Set([
  "-q",
  "--hard",
  "--keep",
  "--merge",
  "--mixed",
  "--no-refresh",
  "--quiet",
  "--refresh",
  "--soft",
]);

interface EquivalenceGrammar {
  flags: ReadonlySet<string>;
  /** Options that carry a value, attached or in the next argument. */
  values: ReadonlySet<string>;
}

const EQUIVALENCE_GRAMMARS: Readonly<Record<string, EquivalenceGrammar>> = {
  "cherry-pick": {
    flags: CHERRY_PICK_FLAGS,
    values: CHERRY_PICK_VALUE_OPTIONS,
  },
  merge: {
    flags: MERGE_FLAGS,
    values: new Set([...MERGE_VALUE_OPTIONS, "-m", "--message"]),
  },
  reset: { flags: RESET_FLAGS, values: new Set() },
};

const isAttachedValue = (token: string, grammar: EquivalenceGrammar): boolean =>
  [...grammar.values].some((option) =>
    option.startsWith("--")
      ? token.startsWith(`${option}=`)
      : token.startsWith(option) && token.length > option.length
  ) ||
  token.startsWith("-S") ||
  token.startsWith("--gpg-sign");

// The indexes of a fast-forward-only merge's, a cherry-pick's, or a reset's
// revision arguments, or null when any argument's role is uncertain: an
// option this table does not know, `--`, or a reset with more than one
// operand, which may be a pathspec.
const revisionIndexes = (
  subcommand: string,
  args: readonly string[]
): Set<number> | null => {
  const grammar = EQUIVALENCE_GRAMMARS[subcommand];
  if (!grammar) {
    return null;
  }
  const indexes = new Set<number>();
  let index = 0;
  while (index < args.length) {
    const token = args[index] as string;
    if (token === "--") {
      return null;
    }
    if (grammar.values.has(token)) {
      index += 2;
      continue;
    }
    if (!token.startsWith("-")) {
      indexes.add(index);
    } else if (!(grammar.flags.has(token) || isAttachedValue(token, grammar))) {
      return null;
    }
    index += 1;
  }
  return subcommand === "reset" && indexes.size !== 1 ? null : indexes;
};

// The same command with each named branch replaced by its recorded commit,
// only when the replacement cannot change what it does: a fast-forward-only
// merge, a cherry-pick, or a reset, where each refused argument is a revision
// argument and a whole branch name that resolves now to exactly a recorded
// head, and no file of that name could make a reset read it as a path.
const equivalentCommand = (
  argv: readonly string[],
  invocation: GitInvocation,
  refusals: readonly PinnedRefusal[],
  facts: PinnedGitFacts
): string[] | null => {
  const { arguments: args, subcommand } = invocation;
  const revisions =
    subcommand === null ||
    invocation.redirected ||
    (subcommand === "merge" && !isFastForwardOnlyMerge(args)) ||
    refusals.some((item) => item.kind !== "named" || !item.unit)
      ? null
      : revisionIndexes(subcommand, args);
  if (!revisions) {
    return null;
  }
  const replacements = new Map<number, string>();
  for (const item of refusals) {
    const token = item.token ?? "";
    const positions = args.flatMap((value, index) =>
      value === token ? [index] : []
    );
    const resolved = facts.resolveRef(invocation.globals, token);
    if (
      positions.length === 0 ||
      positions.some((index) => !revisions.has(index)) ||
      !WHOLE_REF_TOKEN.test(token) ||
      token.includes("..") ||
      (subcommand === "reset" &&
        existsSync(resolve(invocation.directory, token))) ||
      !(
        resolved &&
        (resolved.name.startsWith("refs/heads/") ||
          resolved.name.startsWith("refs/remotes/")) &&
        item.unit?.recordedHeads.includes(resolved.commit)
      )
    ) {
      return null;
    }
    for (const index of positions) {
      replacements.set(index, resolved.commit);
    }
  }
  const prefixLength = argv.length - args.length;
  return argv.map(
    (token, index) => replacements.get(index - prefixLength) ?? token
  );
};

/**
 * Classifies one guarded argv against the run's pinned units. An empty
 * refusal list lets the command start.
 */
export const analyzePinnedCommand = (
  argv: readonly string[],
  context: PinnedCommandContext
): PinnedCommandAnalysis => {
  const [command] = argv;
  if (!command || context.pins.length === 0) {
    return { equivalent: null, refusals: [], subcommand: null };
  }
  // A dashed Git program (`git-merge`) runs that subcommand.
  const dashed = DASHED_GIT_PROGRAM.exec(programName(command));
  if (dashed) {
    return analyzePinnedCommand(
      ["git", dashed[1] as string, ...argv.slice(1)],
      context
    );
  }
  if (!GIT_EXECUTABLES.has(basename(command).toLowerCase())) {
    return {
      equivalent: null,
      refusals: wrappedRefusals(argv),
      subcommand: null,
    };
  }
  const invocation = parseGitInvocation(argv, context.checkout);
  const refusals = gitRefusals(invocation, context);
  return {
    equivalent:
      refusals.length > 0
        ? equivalentCommand(argv, invocation, refusals, context.facts)
        : null,
    refusals,
    subcommand: invocation.subcommand,
  };
};

/** Whether `token` is a full commit ID, which no ref update can move. */
export const isObjectId = (token: string): boolean => OBJECT_ID.test(token);

const parseConfigEntries = (output: string): [string, string][] =>
  output
    .split("\0")
    .filter(Boolean)
    .map((entry): [string, string] => {
      const separator = entry.indexOf("\n");
      return separator === -1
        ? [entry, ""]
        : [entry.slice(0, separator), entry.slice(separator + 1)];
    });

// Remotes defined by files under `remotes/` and `branches/`, which Git still
// reads but `git remote` does not list.
const legacyRemoteNames = (commonGitDirectory: string): string[] =>
  ["remotes", "branches"].flatMap((directory) => {
    try {
      return readdirSync(join(commonGitDirectory, directory)).map((name) =>
        join(directory, name)
      );
    } catch {
      return [];
    }
  });

/** Facts read with the Git that runs the repository's own commands. */
export const gitFactsFor = (
  checkout: string,
  commonGitDirectory: string
): PinnedGitFacts => {
  const cache = new Map<string, unknown>();
  const memo = <T>(key: string, compute: () => T): T => {
    if (!cache.has(key)) {
      cache.set(key, compute());
    }
    return cache.get(key) as T;
  };
  const git = (globals: readonly string[], args: readonly string[]) =>
    runGit(checkout, [...globals, ...args], true);
  return {
    config: (globals, pattern) =>
      memo(`config\0${globals.join("\0")}\0${pattern}`, () =>
        parseConfigEntries(
          git(globals, ["config", "--null", "--get-regexp", pattern]).stdout
        )
      ),
    grafted: () => existsSync(join(commonGitDirectory, "info", "grafts")),
    hasAlias: (globals, name) =>
      git(globals, ["config", "--get", `alias.${name}`]).exitCode === 0,
    isAncestor: (globals, ancestor, descendant) =>
      memo(
        `ancestor\0${globals.join("\0")}\0${ancestor}\0${descendant}`,
        () =>
          git(globals, ["merge-base", "--is-ancestor", ancestor, descendant])
            .exitCode === 0
      ),
    legacyRemotes: () => legacyRemoteNames(commonGitDirectory),
    objectType: (globals, revision) =>
      memo(`type\0${globals.join("\0")}\0${revision}`, () => {
        const result = git(globals, ["cat-file", "-t", revision]);
        const type = result.stdout.trim();
        return result.exitCode === 0 && type ? type : null;
      }),
    refs: (globals) =>
      memo(`refs\0${globals.join("\0")}`, () =>
        git(globals, [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(symref)",
        ])
          .stdout.split("\n")
          .filter(Boolean)
          .map((line) => {
            const [name = "", object = "", symref = ""] = line.split("\0");
            return { name, object, symref };
          })
      ),
    resolveCommit: (globals, revision) =>
      memo(`commit\0${globals.join("\0")}\0${revision}`, () => {
        const result = git(globals, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${revision}^{commit}`,
        ]);
        const commit = result.stdout.trim();
        return result.exitCode === 0 && isObjectId(commit) ? commit : null;
      }),
    resolveRef: (globals, token) => {
      const name = git(globals, ["rev-parse", "--symbolic-full-name", token]);
      const commit = git(globals, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${token}^{commit}`,
      ]);
      const fullName = name.stdout.trim();
      const objectId = commit.stdout.trim();
      return name.exitCode === 0 &&
        commit.exitCode === 0 &&
        fullName &&
        !fullName.includes("\n") &&
        isObjectId(objectId)
        ? { commit: objectId, name: fullName }
        : null;
    },
    unrecordedCommits: (globals, tip, recorded, limit) => {
      const result = git(globals, [
        "rev-list",
        "--parents",
        `--max-count=${limit + 1}`,
        tip,
        "--not",
        ...recorded,
      ]);
      return result.exitCode === 0
        ? result.stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [commit = "", ...parents] = line.split(" ");
              return { commit, parents };
            })
        : null;
    },
    upstreams: (globals) => {
      const upstream = git(globals, [
        "rev-parse",
        "--symbolic-full-name",
        "@{upstream}",
      ]);
      const head = git(globals, ["symbolic-ref", "--quiet", "HEAD"]);
      const branch = head.stdout.trim();
      const merges = branch.startsWith("refs/heads/")
        ? git(globals, [
            "config",
            "--get-all",
            `branch.${branch.slice("refs/heads/".length)}.merge`,
          ]).stdout
        : "";
      return [
        ...(upstream.exitCode === 0 ? [upstream.stdout] : []),
        ...merges.split("\n"),
      ]
        .map((name) => name.trim())
        .filter(Boolean);
    },
  };
};
