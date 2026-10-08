import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
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
 * names such a unit's branch is refused before it starts, and the refusal
 * prints the command with the recorded commit ID, which cannot move.
 *
 * The check is bounded and fails closed. It reads the argument array, never a
 * shell: it does not expand aliases or parse wrapper scripts. A merge-like Git
 * command (anything that is not a known read-only or index-only subcommand)
 * is refused when an argument mentions a pinned branch in any form (local,
 * remote-tracking, full ref, revision expression, range, any letter case), a
 * pinned checkout, or an indirect name that could resolve to one: reflog,
 * upstream, and previous-branch syntax, `FETCH_HEAD`, another worktree's
 * refs, message search, and every-branch options. Configuration that could
 * stand in for a name (an upstream, a matching push, a remote or URL rewrite
 * that points into a pinned checkout, an alias, a replace ref, or a graft) is
 * refused the same way. Git run through a shell or other command runner is
 * refused outright while units are pinned, because the runner hides what Git
 * will read; any other program is opaque. Refusing a legitimate command is
 * accepted, because the form that names the recorded commit always works.
 * The run's controller and its own prepared authors are not pinned.
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
  branch: string;
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

/** Git facts read in the same directory and `-C`/`-c` context as the command. */
export interface PinnedGitFacts {
  config: (globals: readonly string[], pattern: string) => [string, string][];
  grafted: () => boolean;
  hasAlias: (globals: readonly string[], name: string) => boolean;
  refs: (globals: readonly string[]) => GitRefRecord[];
  resolveRef: (
    globals: readonly string[],
    token: string
  ) => { commit: string; name: string } | null;
  /**
   * The current branch's configured upstream and every `merge` value, which
   * `git merge` and `git pull` read when no revision is named.
   */
  upstreams: (globals: readonly string[]) => string[];
}

export interface PinnedCommandContext {
  /** The checkout the command runs in. */
  checkout: string;
  facts: PinnedGitFacts;
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
  "clone",
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
  "remote",
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

const GIT_EXECUTABLES: ReadonlySet<string> = new Set(["git", "git.exe"]);
const EXE_SUFFIX = /\.exe$/u;
const NAME_CHARACTER = /[\p{L}\p{N}_-]/u;
const MESSAGE_SEARCH_PATTERN = /(?:^|\.\.|[\^:=+]):\//u;
const OTHER_WORKTREE_PATTERN =
  /(?:^|\.\.|[\^:=+])(?:main-worktree|worktrees\/[^/]+)\//u;
const FETCH_HEAD_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])fetch_head(?:$|[^\p{L}\p{N}_-])/u;
const WRAPPER_WORD_SEPARATOR = /[\s;&|()<>'"`$\\=]+/u;
const WHOLE_REF_TOKEN = /^[^\s~^:?*[\\@{}]+$/u;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const EVERY_BRANCH_OPTIONS: ReadonlySet<string> = new Set([
  "--all",
  "--branches",
  "--glob",
  "--mirror",
  "--remotes",
]);
const EVERY_BRANCH_PREFIXES = ["--branches=", "--glob=", "--remotes="];
const CONTINUATION_OPTIONS: ReadonlySet<string> = new Set([
  "--abort",
  "--continue",
  "--quit",
  "--skip",
]);

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
const PUSH_FLAGS: ReadonlySet<string> = new Set([
  "-4",
  "-6",
  "-f",
  "-n",
  "-q",
  "-u",
  "-v",
  "--atomic",
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
]);
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-o",
  "--exec",
  "--push-option",
  "--receive-pack",
  "--recurse-submodules",
  "--repo",
]);
const PUSH_ATTACHED_PREFIXES = [
  "--exec=",
  "--force-with-lease=",
  "--push-option=",
  "--receive-pack=",
  "--recurse-submodules=",
  "--repo=",
  "--signed=",
];
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

/**
 * The indirect form `token` uses, or null. `everyBranchOptions` is false for
 * a fetch, whose `--all` means every remote and writes no local branch.
 */
export const indirectForm = (
  token: string,
  everyBranchOptions = true
): string | null => {
  const folded = fold(token);
  if (token === "--stdin") {
    return "`--stdin`, whose input loop exec cannot see";
  }
  if (folded.includes("@{")) {
    return "reflog, upstream, push, or previous-branch syntax (`@{...}`)";
  }
  if (token === "-") {
    return "the previous branch (`-`)";
  }
  if (MESSAGE_SEARCH_PATTERN.test(token)) {
    return "a commit-message search (`:/...`)";
  }
  if (FETCH_HEAD_PATTERN.test(folded)) {
    return "`FETCH_HEAD`, which can hold any fetched branch";
  }
  if (OTHER_WORKTREE_PATTERN.test(folded)) {
    return "another worktree's refs";
  }
  if (
    everyBranchOptions &&
    (EVERY_BRANCH_OPTIONS.has(token) ||
      EVERY_BRANCH_PREFIXES.some((prefix) => token.startsWith(prefix)))
  ) {
    return `${token}, which can include every branch`;
  }
  return null;
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
  /** The part checked for names: a refspec contributes only its source. */
  text: string;
  token: string;
}

const scanned = (
  token: string,
  {
    everyBranch = false,
    names = true,
    path = !token.startsWith("-"),
    text = token,
  } = {}
): ScannedToken => ({ everyBranch, names, path, text, token });

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
        : [scanned(token, { text: lease.slice(separator + 1) })];
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

// A fetch writes a local ref only through an explicit `<src>:<dst>`; a
// colon-less fetch updates remote-tracking refs and `FETCH_HEAD`, which
// merge-like commands cannot then name. Its repository may still point into
// a pinned checkout.
const fetchTokens = (args: readonly string[]): ScannedToken[] =>
  args.flatMap((token): ScannedToken[] => {
    if (token.startsWith("-")) {
      return [scanned(token)];
    }
    const separator = token.indexOf(":");
    const writesLocalRef = separator !== -1 && separator < token.length - 1;
    return [
      scanned(token, {
        everyBranch: writesLocalRef && carriesEveryBranch(token),
        names: writesLocalRef,
        text: refspecSource(token),
      }),
    ];
  });

const isBranchDeletion = (args: readonly string[]): boolean =>
  args.some((token) => DELETION_OPTIONS.has(token)) &&
  args.every(
    (token) => !token.startsWith("-") || BRANCH_DELETION_COMPANIONS.has(token)
  );

const isKnownPushOption = (token: string): boolean =>
  PUSH_FLAGS.has(token) ||
  PUSH_ATTACHED_PREFIXES.some((prefix) => token.startsWith(prefix));

// A push that deletes, read with every option understood, so `-d` is never
// the value of another option.
const isPushDeletion = (args: readonly string[]): boolean => {
  let deletes = false;
  let index = 0;
  while (index < args.length) {
    const token = args[index] as string;
    index += 1;
    if (PUSH_VALUE_OPTIONS.has(token)) {
      index += 1;
    } else if (token === "-d" || token === "--delete") {
      deletes = true;
    } else if (token === "--") {
      return deletes;
    } else if (token.startsWith("-") && !isKnownPushOption(token)) {
      return false;
    }
  }
  return deletes;
};

/** Forms of a merge-like subcommand that integrate nothing. */
const integratesNothing = (
  subcommand: string,
  args: readonly string[]
): boolean => {
  if (subcommand === "worktree") {
    return args[0] !== "add";
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
  if (subcommand === "pull") {
    return args.map((token) =>
      scanned(token, {
        everyBranch: !token.startsWith("-") && token.includes("*"),
      })
    );
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
  ...invocation.globalValues.map((value) => scanned(value, { path: false })),
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

/** The checkout that owns `path`: the deepest listed worktree containing it. */
const owningCheckout = (
  path: string,
  worktreePaths: readonly string[]
): string | null => {
  let owner: string | null = null;
  for (const candidate of worktreePaths) {
    if (
      (path === candidate || path.startsWith(`${candidate}${sep}`)) &&
      (owner === null || candidate.length > owner.length)
    ) {
      owner = candidate;
    }
  }
  return owner;
};

const canonicalPath = (path: string): string => {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
};

const pinnedCheckoutFor = (
  candidate: string,
  directory: string,
  context: PinnedCommandContext
): PinnedUnit | null => {
  const text = candidate.startsWith("file://")
    ? candidate.slice("file://".length)
    : candidate;
  if (
    !text ||
    text.includes("://") ||
    (!isAbsolute(text) && text.includes(":"))
  ) {
    return null;
  }
  const owner = owningCheckout(
    canonicalPath(resolve(directory, text)),
    context.worktreePaths
  );
  return context.pins.find((unit) => unit.path === owner) ?? null;
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
  `${unit.branch} of ${unit.path} (${PINNED_UNIT_STATE_TEXT[unit.state]}${unit.owner ? ` by ${unit.owner}` : ""})`;

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
  const unit = item.path
    ? pinnedCheckoutFor(item.token, directory, context)
    : null;
  if (unit) {
    found.push(
      refusal(
        "checkout",
        `${item.token} points into the pinned checkout ${unit.path}`,
        item.token,
        unit
      )
    );
  }
  return found;
};

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
    (subcommand === "merge" ||
      subcommand === "pull" ||
      subcommand === "rebase") &&
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
    subcommand === "pull" ||
    subcommand === "push"
  ) {
    found.push(...remoteConfigRefusals(invocation, mentionsPin, context));
  }
  return found;
};

const remoteConfigRefusals = (
  invocation: GitInvocation,
  mentionsPin: (value: string) => PinnedUnit | null,
  context: PinnedCommandContext
): PinnedRefusal[] => {
  const found: PinnedRefusal[] = [];
  const entries = context.facts.config(
    invocation.globals,
    "^(push\\.default|remote\\..*\\.(url|pushurl|fetch|push)|url\\..*\\.(insteadof|pushinsteadof))$"
  );
  const implicitPush =
    invocation.subcommand === "push" &&
    !hasExplicitRefspec(invocation.arguments);
  for (const [key, value] of entries) {
    const lowered = key.toLowerCase();
    const location = repositoryLocation(key, value);
    if (location !== null) {
      const unit = pinnedCheckoutFor(location, invocation.directory, context);
      if (unit) {
        found.push(
          refusal(
            "configured",
            `remote setting ${key} points into the pinned checkout ${unit.path}`,
            null,
            unit
          )
        );
      }
      continue;
    }
    const unit =
      lowered.endsWith(".fetch") || lowered.endsWith(".push")
        ? mentionsPin(value)
        : null;
    if (unit) {
      found.push(
        refusal(
          "configured",
          `remote setting ${key} names ${describeUnit(unit)}`,
          null,
          unit
        )
      );
    } else if (implicitPush && pushesEveryBranch(lowered, value)) {
      found.push(
        refusal(
          "configured",
          `this push names no refspec, so ${key} = ${value} can push every branch`
        )
      );
    }
  }
  return found;
};

const URL_REWRITE_SUFFIXES = [".insteadof", ".pushinsteadof"];

// The repository location a remote or URL-rewrite setting names: a remote's
// URL, or the base `url.<base>.insteadOf` rewrites other URLs to, which may
// stand for any remote whatever it is called.
const repositoryLocation = (key: string, value: string): string | null => {
  const lowered = key.toLowerCase();
  if (lowered.endsWith(".url") || lowered.endsWith(".pushurl")) {
    return value;
  }
  const suffix = URL_REWRITE_SUFFIXES.find((item) => lowered.endsWith(item));
  return lowered.startsWith("url.") && suffix
    ? key.slice("url.".length, key.length - suffix.length)
    : null;
};

const pushesEveryBranch = (key: string, value: string): boolean =>
  key === "push.default"
    ? value.toLowerCase() === "matching"
    : key.endsWith(".push") &&
      (value === ":" || value === "+:" || value.includes("*"));

// Whether a push names its refspecs, so configuration does not choose them.
// Any option this parser does not know makes the answer no.
const hasExplicitRefspec = (args: readonly string[]): boolean => {
  let positionals = 0;
  let index = 0;
  while (index < args.length) {
    const token = args[index] as string;
    index += 1;
    if (PUSH_VALUE_OPTIONS.has(token)) {
      index += 1;
    } else if (token.startsWith("-")) {
      if (!isKnownPushOption(token)) {
        return false;
      }
    } else {
      positionals += 1;
    }
  }
  return positionals >= 2;
};

// Whether a merge, pull, or rebase names what it integrates, so no upstream
// stands in for it. Only a fully understood merge counts; a pull needs a
// refspec after its repository, and a rebase always reads its upstream.
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
  if (
    READ_ONLY_SUBCOMMANDS.has(subcommand) ||
    integratesNothing(subcommand, invocation.arguments)
  ) {
    return [];
  }
  const found: PinnedRefusal[] = [];
  if (invocation.redirected) {
    found.push(
      refusal(
        "checkout",
        "--git-dir or --work-tree hides which checkout's HEAD it uses"
      )
    );
  }
  const directoryUnit = pinnedCheckoutFor(
    invocation.directory,
    context.checkout,
    context
  );
  if (directoryUnit) {
    found.push(
      refusal(
        "checkout",
        `it runs in the pinned checkout ${directoryUnit.path}, where HEAD is that unit's moving branch`,
        null,
        directoryUnit
      )
    );
  }
  if (
    !MERGE_LIKE_BUILTINS.has(subcommand) &&
    context.facts.hasAlias(invocation.globals, subcommand)
  ) {
    found.push(
      refusal(
        "alias",
        `git ${subcommand} is an alias, which loop exec does not expand while units are pinned`,
        subcommand
      )
    );
  }
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
  for (const item of tokensFor(invocation)) {
    found.push(
      ...tokenRefusals(
        // Inside a pinned checkout every relative path is in it; that
        // checkout is already refused once.
        directoryUnit ? { ...item, path: false } : item,
        names,
        invocation.directory,
        context,
        subcommand !== "fetch"
      )
    );
  }
  found.push(...configuredRefusals(invocation, names, context));
  return found;
};

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
  "yash",
  "zsh",
]);

const programName = (path: string): string =>
  basename(path).toLowerCase().replace(EXE_SUFFIX, "");

const wrappedRefusals = (argv: readonly string[]): PinnedRefusal[] => {
  const [command = ""] = argv;
  if (!COMMAND_RUNNERS.has(programName(command))) {
    return [];
  }
  const runsGit = argv
    .slice(1)
    .flatMap((arg) => arg.split(WRAPPER_WORD_SEPARATOR))
    .some((word) => programName(word) === "git");
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

interface OptionGrammar {
  flags: ReadonlySet<string>;
  /** Options that carry a value, attached or in the next argument. */
  values: ReadonlySet<string>;
}

const OPTION_GRAMMARS: Readonly<Record<string, OptionGrammar>> = {
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

const isAttachedValue = (token: string, grammar: OptionGrammar): boolean =>
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
  const grammar = OPTION_GRAMMARS[subcommand];
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
