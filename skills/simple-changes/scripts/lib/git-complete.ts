import { spawnSync } from "bun";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { gitExecutable, runGit, runGitWithInput } from "./process.ts";
import { redactSecrets } from "./redact.ts";

// The one way a Git answer that decides whether something is deleted,
// pruned, released, retired or counted as delivered is read: a commit
// listing, a changed-path listing, a commit count, a merge base, a patch
// ID, one line such as a configuration value or an object ID, or the list
// of configured remotes. Under heavy load an answer has been seen to arrive
// empty or cut short with exit 0, and a partial answer that still parses
// would settle a decision on evidence Git never gave: a cut commit listing
// proves a range that leaves a commit out, a cut path listing hides a path,
// a lost patch ID reads as a miss, and a cut remote name reads as another
// remote. So every answer here is checked against an independent count or a
// self-checking form, asked once more when it fails the check, and then
// refused with a LostGitAnswerError. Callers treat that refusal as
// "unknown, keep it", never as proven and never as a settled miss.

/** A Git answer that was twice lost or cut short; retrying may succeed. */
export class LostGitAnswerError extends SimpleChangesError {
  constructor(message: string) {
    super(
      `${message} Refusing to act on a partial answer; retry the command.`,
      EXIT_CODES.inventory
    );
  }
}

const ANSWER_LIMIT = 240;

const quoted = (value: string): string =>
  value.length > ANSWER_LIMIT
    ? `${JSON.stringify(value.slice(0, ANSWER_LIMIT))} (first ${ANSWER_LIMIT} of ${value.length} characters)`
    : JSON.stringify(value);

const LOST_IN_TRANSIT = "on its way to this process (seen under heavy load).";

const COUNT_ANSWER = /^[0-9]+\n$/u;
const MERGE_BASE_ANSWER = /^([0-9a-f]{40}|[0-9a-f]{64})\n$/u;
const ONE_LINE_ANSWER = /^[^\n]*\n$/u;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
// The summary `--shortstat` prints: how many files changed, counted by Git
// apart from any listing. Git prints nothing when nothing changed.
const SHORTSTAT_ANSWER =
  /^ ([0-9]+) files? changed(?:, [0-9]+ insertions?\(\+\))?(?:, [0-9]+ deletions?\(-\))?\n$/u;
// One listed commit, followed by its parents when `--parents` asked for them.
const LISTED_COMMIT =
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?: (?:[0-9a-f]{40}|[0-9a-f]{64}))*$/u;
const PATCH_ID_ANSWER = /^([0-9a-f]{40}|[0-9a-f]{64}) [0-9a-f]{40,64}\n$/u;
// One `--numstat -z` entry without renames: added, deleted, path.
const NUMSTAT_ENTRY = /^(?:[0-9]+|-)\t(?:[0-9]+|-)\t([\s\S]+)$/u;

/**
 * How many commits `range` holds. Git always prints digits and a line break
 * for this, so anything else is asked once more and then refused.
 */
export const completeRevisionCount = (cwd: string, range: string): number => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const counted = runGit(cwd, ["rev-list", "--count", range]).stdout;
    if (COUNT_ANSWER.test(counted)) {
      return Number.parseInt(counted, 10);
    }
  }
  throw new LostGitAnswerError(
    `git rev-list --count ${range} twice printed no whole count, so its answer was lost ${LOST_IN_TRANSIT}`
  );
};

/**
 * The lines a `rev-list` question lists, checked whole. Git is asked the
 * same question with `--count`; the listing must end with a line break,
 * hold one full object ID per line (followed by its parents' when
 * `--parents` is asked), and have exactly as many lines as the count. A
 * listing that fails is asked once more and then refused, so a partial
 * listing never reads as "these are all of them". `question` is everything
 * after `rev-list`; `gitOptions` go before it, and `stdin` feeds `--stdin`.
 */
export const completeRevisionList = (
  cwd: string,
  question: readonly string[],
  options: { gitOptions?: readonly string[]; stdin?: string } = {}
): string[] => {
  const ask = (count: boolean): string => {
    const args = [
      ...(options.gitOptions ?? []),
      "rev-list",
      ...(count ? ["--count"] : []),
      ...question,
    ];
    return (
      options.stdin === undefined
        ? runGit(cwd, args)
        : runGitWithInput(cwd, args, options.stdin)
    ).stdout;
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const listed = ask(false);
    const counted = ask(true);
    const lines = listed.split("\n");
    // A whole listing ends with a line break, which leaves one empty item.
    const ended = lines.pop() === "";
    if (
      COUNT_ANSWER.test(counted) &&
      ended &&
      lines.length === Number.parseInt(counted, 10) &&
      lines.every((line) => LISTED_COMMIT.test(line))
    ) {
      return lines;
    }
  }
  throw new LostGitAnswerError(
    `git rev-list ${quoted(question.join(" "))} twice gave a listing that did not match its own count, so the answer was lost or cut short ${LOST_IN_TRANSIT}`
  );
};

export type MergeBaseAnswer =
  | { mergeBase: string }
  /** Git found no common commit: exit 1 with nothing printed. */
  | { mergeBase: null }
  /** Git could not answer, with its reason. */
  | { failure: string };

/**
 * The merge base of `left` and `right`. A whole answer is one full object ID
 * and a line break; exit 1 with nothing printed means no common commit.
 * Anything else that exits 0 is asked once more and then refused.
 */
export const completeMergeBase = (
  cwd: string,
  left: string,
  right: string,
  gitOptions: readonly string[] = []
): MergeBaseAnswer => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = runGit(
      cwd,
      [...gitOptions, "merge-base", left, right],
      true
    );
    if (result.exitCode === 0) {
      const mergeBase = MERGE_BASE_ANSWER.exec(result.stdout)?.[1];
      if (mergeBase) {
        return { mergeBase };
      }
      continue;
    }
    if (
      result.exitCode === 1 &&
      result.stdout === "" &&
      result.stderr.trim() === ""
    ) {
      return { mergeBase: null };
    }
    return { failure: result.stderr.trim() || `exit ${result.exitCode}` };
  }
  throw new LostGitAnswerError(
    `git merge-base ${left} ${right} twice gave an answer that is not one whole commit ID, so it was lost or cut short ${LOST_IN_TRANSIT}`
  );
};

// The entries of a NUL-terminated listing, or null when it does not end
// with a NUL and so was cut short.
const nulEntries = (output: string): string[] | null => {
  if (output === "") {
    return [];
  }
  return output.endsWith("\0") ? output.slice(0, -1).split("\0") : null;
};

// How many files `--shortstat` says changed, or null when its line was cut.
const shortstatCount = (output: string): number | null => {
  if (output === "") {
    return 0;
  }
  const counted = SHORTSTAT_ANSWER.exec(output)?.[1];
  return counted === undefined ? null : Number.parseInt(counted, 10);
};

/**
 * The paths a `diff` or `diff-tree` question changes, checked whole. Git is
 * asked for the names (`--name-only -z`), for the per-path counts
 * (`--numstat -z`), and for how many files changed (`--shortstat`), a
 * number that does not depend on either listing's length. Both listings
 * must end with a NUL, list the same paths in the same order, and hold as
 * many paths as that number, so two listings cut at the same entry never
 * agree into a whole answer. When everything is empty, the diff's exit code
 * alone (`--quiet`), which a lost answer cannot fake, must agree that
 * nothing changed. Anything else is asked once more and then refused, so a
 * listing cut short never hides a path. `options` must turn renames off.
 */
export const completeChangedPaths = (
  cwd: string,
  subcommand: "diff" | "diff-tree",
  options: readonly string[],
  revisions: readonly string[]
): string[] => {
  const ask = (format: readonly string[]): string =>
    runGit(cwd, [subcommand, ...options, ...format, ...revisions]).stdout;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const names = nulEntries(ask(["--name-only", "-z"]));
    const statPaths = nulEntries(ask(["--numstat", "-z"]))?.map(
      (entry) => NUMSTAT_ENTRY.exec(entry)?.[1] ?? null
    );
    const counted = shortstatCount(ask(["--shortstat"]));
    if (
      !(names && statPaths) ||
      counted !== names.length ||
      names.length !== statPaths.length ||
      names.some((name, index) => name === "" || name !== statPaths[index])
    ) {
      continue;
    }
    if (names.length > 0) {
      return names;
    }
    const quiet = runGit(
      cwd,
      [subcommand, ...options, "--quiet", ...revisions],
      true
    );
    if (quiet.exitCode === 0) {
      return [];
    }
    if (quiet.exitCode !== 1) {
      throw new SimpleChangesError(
        `git ${subcommand} --quiet failed: ${quiet.stderr.trim() || `exit ${quiet.exitCode}`}`,
        EXIT_CODES.inventory
      );
    }
  }
  throw new LostGitAnswerError(
    `git ${subcommand} ${quoted(revisions.join(" "))} twice listed changed paths that its own counts did not confirm, so the answer was lost or cut short ${LOST_IN_TRANSIT}`
  );
};

export type LineAnswer =
  | { exitCode: 0; line: string }
  | { exitCode: number; line: null; stderr: string };

/**
 * A question Git answers, when it succeeds, with exactly one line: a
 * configuration value, an object ID, a path, a branch's upstream. A whole
 * answer ends with its line break (and matches `form`, when given), so an
 * answer lost or cut short is asked once more and then refused. A failure
 * is returned with its exit code for the caller to read, such as 1 for an
 * unset `config --get` key; a lost answer cannot fake an exit code.
 */
export const completeLine = (
  cwd: string,
  args: readonly string[],
  form?: RegExp
): LineAnswer => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = runGit(cwd, args, true);
    if (result.exitCode !== 0) {
      return { exitCode: result.exitCode, line: null, stderr: result.stderr };
    }
    if (ONE_LINE_ANSWER.test(result.stdout)) {
      const line = result.stdout.slice(0, -1);
      if (!form || form.test(line)) {
        return { exitCode: 0, line };
      }
    }
  }
  throw new LostGitAnswerError(
    `git ${quoted(args.join(" "))} twice gave an answer that is not one whole line, so it was lost or cut short ${LOST_IN_TRANSIT}`
  );
};

/**
 * The full object ID `revision` names (`rev-parse --verify --quiet`), or
 * null when Git exits with a failure, which a lost answer cannot fake. An
 * ID lost or cut short is asked once more and then refused.
 */
export const completeObjectId = (
  cwd: string,
  revision: string,
  gitOptions: readonly string[] = []
): string | null => {
  const answer = completeLine(
    cwd,
    [...gitOptions, "rev-parse", "--verify", "--quiet", revision],
    OBJECT_ID
  );
  return answer.line;
};

/**
 * A listing whose entries each end with `terminator`, such as a
 * `for-each-ref` line, a `config -z` entry, or a `worktree list
 * --porcelain` record (a blank line). Git gives no count for these, so this
 * checks only the end: an answer cut inside an entry, which could still
 * parse as a shorter one, is asked once more and then refused. A listing
 * lost entirely, or cut at an entry's end, still reads as whole, so a
 * caller uses this only where a missing entry keeps something, or confirms
 * each absence that would decide otherwise by an exit code. A failure is
 * returned as is, or thrown without `allowFailure`.
 */
export const completeListing = (
  cwd: string,
  args: readonly string[],
  terminator: "\0" | "\n" | "\n\n",
  allowFailure = true
): { exitCode: number; stderr: string; stdout: string } => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = runGit(cwd, args, allowFailure);
    if (
      result.exitCode !== 0 ||
      result.stdout === "" ||
      result.stdout.endsWith(terminator)
    ) {
      return result;
    }
  }
  throw new LostGitAnswerError(
    `git ${quoted(args.join(" "))} twice gave a listing that stops inside an entry, so it was cut short ${LOST_IN_TRANSIT}`
  );
};

/**
 * The configured remotes (`git remote`), checked whole: one name per line,
 * ending with a line break, and naming every remote in `known`, which the
 * caller knows is configured, so a listing lost or cut short is asked once
 * more and then refused. A listing cut at a line's end can still leave out
 * another remote, so a caller treats a name it does not find as unknown and
 * keeps whatever that name would decide.
 */
export const completeRemoteNames = (
  cwd: string,
  known: readonly string[]
): string[] => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const listed = runGit(cwd, ["remote"]).stdout;
    const names = listed.split("\n");
    if (
      names.pop() === "" &&
      names.every(Boolean) &&
      known.every((name) => names.includes(name))
    ) {
      return names;
    }
  }
  throw new LostGitAnswerError(
    `git remote twice listed remotes without ${quoted(known.join(" "))} or without its final line break, so the answer was lost or cut short ${LOST_IN_TRANSIT}`
  );
};

/**
 * Whether `name` is a configured remote, answered by the exit code of
 * `git remote get-url`: 0 for a configured remote, 2 for none. A lost or
 * cut answer cannot change an exit code; any other failure throws, so an
 * unknown answer never reads as "not a remote".
 */
export const remoteIsConfigured = (cwd: string, name: string): boolean => {
  const result = runGit(cwd, ["remote", "get-url", name], true);
  if (result.exitCode === 0 || result.exitCode === 2) {
    return result.exitCode === 0;
  }
  throw new SimpleChangesError(
    `Could not tell whether ${name} is a configured remote: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    EXIT_CODES.inventory
  );
};

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// Git with bytes in and out, for diffs that must reach patch-id unchanged.
const binaryGit = (
  cwd: string,
  args: readonly string[],
  stdin: Uint8Array
): Uint8Array => {
  const result = spawnSync([gitExecutable(), "-C", cwd, ...args], {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
    stderr: "pipe",
    stdin,
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = redactSecrets(
      textDecoder.decode(result.stderr).trim() ||
        textDecoder.decode(result.stdout).trim()
    );
    throw new SimpleChangesError(
      `git ${args[0] ?? ""} failed${detail ? `: ${detail}` : ""}`,
      EXIT_CODES.inventory
    );
  }
  return new Uint8Array(result.stdout);
};

// A commit's diff, asked for twice in one answer. `diff-tree --stdin
// --always` prints the commit's ID line and then its diff for each line it
// reads, so a whole answer is the same block twice, and an answer lost or
// cut short anywhere is not, since no line of a diff can be the bare ID of
// the commit it shows. The diff is what `diff-tree --patch --no-commit-id`
// prints: nothing for a root commit, a merge, or a commit with its
// parent's tree. Null when the answer was not whole.
const wholeDiff = (cwd: string, sha: string): Buffer | null => {
  const answer = Buffer.from(
    binaryGit(
      cwd,
      ["diff-tree", "--stdin", "--always", "--patch", "--full-index"],
      textEncoder.encode(`${sha}\n${sha}\n`)
    )
  );
  const header = Buffer.from(`${sha}\n`);
  const half = answer.length / 2;
  if (!Number.isInteger(half) || half < header.length) {
    return null;
  }
  const first = answer.subarray(0, half);
  return first.subarray(0, header.length).equals(header) &&
    first.equals(answer.subarray(half))
    ? first.subarray(header.length)
    : null;
};

// A commit's patch ID, null when its diff is empty, or undefined when an
// answer it rests on was not whole. The diff fed to patch-id is the whole
// one, so a diff cut short, whose patch ID would be a valid ID of the part
// that arrived and could match a target commit that changed only that part,
// never reaches it; patch-id's own answer must be one whole line. A
// non-empty diff always needs that line: no answer is never read as "this
// diff has no patch ID", whatever Git's version says, since a version
// answer can itself arrive cut short. Git before 2.39 does give no patch ID
// for a diff without a hunk, such as a mode-only change; that is unknown
// evidence too, so it is refused like a lost answer and the branch is kept,
// never settled as a miss.
const wholePatchId = (cwd: string, sha: string): string | null | undefined => {
  const diff = wholeDiff(cwd, sha);
  if (diff === null) {
    return;
  }
  if (diff.length === 0) {
    return null;
  }
  const output = textDecoder.decode(
    binaryGit(cwd, ["patch-id", "--stable"], diff)
  );
  return PATCH_ID_ANSWER.exec(output)?.[1];
};

/**
 * A commit's stable patch ID, or null when the commit shows no diff (a
 * root commit, a merge, or a commit with its parent's tree). Patch evidence
 * is accepted only when it is whole; anything else is asked once more and
 * then refused, so lost or cut-short evidence never settles as a match or
 * as a miss.
 */
export const completePatchId = (cwd: string, sha: string): string | null => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const patchId = wholePatchId(cwd, sha);
    if (patchId !== undefined) {
      return patchId;
    }
  }
  throw new LostGitAnswerError(
    `Git's diff or patch ID for commit ${sha} was twice lost or cut short ${LOST_IN_TRANSIT} If it fails again, this Git may give no patch ID for a change without a hunk, such as a mode change (Git before 2.39); update Git.`
  );
};
