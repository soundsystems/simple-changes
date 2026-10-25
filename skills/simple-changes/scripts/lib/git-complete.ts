import { spawnSync } from "bun";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { gitExecutable, runGit, runGitWithInput } from "./process.ts";
import { redactSecrets } from "./redact.ts";

// The one way a proof reads a Git answer that must be complete: a commit
// listing, a changed-path listing, a commit count, a merge base or a patch
// ID. Under heavy load an answer has been seen to arrive empty or cut short
// with exit 0, and a partial answer that still parses would settle a proof
// on evidence Git never gave: a cut commit listing proves a range that
// leaves a commit out, a cut path listing hides a path, and a lost patch ID
// reads as a miss. So every answer here is checked against an independent
// count or a self-checking form, asked once more when it fails the check,
// and then refused with a LostGitAnswerError. Callers treat that refusal as
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

/**
 * The paths a `diff` or `diff-tree` question changes, checked whole. Git is
 * asked for the names (`--name-only -z`) and, independently, for the
 * per-path counts (`--numstat -z`); both must end with a NUL and list the
 * same paths in the same order. When both are empty, the diff's exit code
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
    if (
      !(names && statPaths) ||
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
