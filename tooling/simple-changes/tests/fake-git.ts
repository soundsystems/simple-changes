import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, which } from "bun";

const decoder = new TextDecoder();

export type FakeGitLoss =
  | "empty"
  | "first-line"
  | `bytes:${number}`
  | `lines:${number}`
  | `nul:${number}`;

export interface FakeGitRun {
  /** A child Bun script that prints one JSON value. */
  body: string;
  /** Calls whose arguments fail with exit 3 when they contain this. */
  failFlag?: string;
  /** How a `failFlag` call fails instead: its exit code and stderr line. */
  failure?: { exitCode: number; stderr: string };
  /**
   * Calls whose arguments contain this (one argument, or several in a row)
   * lose their answer while lost answers remain.
   */
  flag: string;
  /** How many answers to lose. */
  lost: number;
  /**
   * `empty`: exit 0 with no output. `first-line`, `lines:<n>`, `nul:<n>`
   * and `bytes:<n>`: exit 0 with only the first line, the first n lines,
   * the first n NUL-terminated entries, or the first n bytes of the real
   * answer, an answer cut short.
   */
  mode?: FakeGitLoss;
  /** How many calls naming `flag` to answer truthfully before losing any. */
  skip?: number;
  /** When given, `git version` prints this line instead of the real one. */
  version?: string;
}

// A Git on PATH that answers truthfully, except as the environment says:
// a call whose arguments contain FAKE_GIT_EMPTY_FLAG first uses up a skip
// token and answers truthfully, then, while loss tokens remain, claims one
// and loses its answer (FAKE_GIT_EMPTY_MODE); a call whose arguments
// contain FAKE_GIT_FAIL_FLAG fails with exit 3 (or FAKE_GIT_FAIL_EXIT,
// printing FAKE_GIT_FAIL_STDERR); and `git version` prints
// FAKE_GIT_VERSION when it is set. A claim moves the token into the
// `-taken` folder beside its own: a rename succeeds for exactly one of
// several Git processes racing for the same token, while macOS `rm` can
// report success to two of them.
const fakeGitDirectory = (register: (cleanup: () => void) => void): string => {
  const realGit = which("git");
  if (!realGit) {
    throw new Error("git is not on PATH");
  }
  const bin = mkdtempSync(join(tmpdir(), "simple-changes-fake-git-"));
  register(() => rmSync(bin, { force: true, recursive: true }));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
real='${realGit}'
if [ -n "$FAKE_GIT_VERSION" ]; then
  for last in "$@"; do :; done
  if [ "$last" = version ]; then
    printf '%s\\n' "$FAKE_GIT_VERSION"
    exit 0
  fi
fi
if [ -n "$FAKE_GIT_FAIL_FLAG" ]; then
  case " $* " in
    *" $FAKE_GIT_FAIL_FLAG "*)
      printf '%s\\n' "\${FAKE_GIT_FAIL_STDERR:-error: simulated failure}" >&2
      exit "\${FAKE_GIT_FAIL_EXIT:-3}"
      ;;
  esac
fi
if [ -n "$FAKE_GIT_EMPTY_FLAG" ] && [ -d "$FAKE_GIT_EMPTY_TOKENS" ]; then
  case " $* " in
    *" $FAKE_GIT_EMPTY_FLAG "*)
      for token in "$FAKE_GIT_SKIP_TOKENS"/*; do
        mv "$token" "$FAKE_GIT_SKIP_TOKENS-taken/" 2>/dev/null && exec "$real" "$@"
      done
      for token in "$FAKE_GIT_EMPTY_TOKENS"/*; do
        if mv "$token" "$FAKE_GIT_EMPTY_TOKENS-taken/" 2>/dev/null; then
          case "$FAKE_GIT_EMPTY_MODE" in
            first-line) "$real" "$@" | head -n 1 ;;
            lines:*) "$real" "$@" | head -n "\${FAKE_GIT_EMPTY_MODE#lines:}" ;;
            nul:*) "$real" "$@" | perl -0 -ne 'print if $. <= '"\${FAKE_GIT_EMPTY_MODE#nul:}" ;;
            bytes:*) "$real" "$@" | head -c "\${FAKE_GIT_EMPTY_MODE#bytes:}" ;;
          esac
          exit 0
        fi
      done
      ;;
  esac
fi
exec "$real" "$@"
`
  );
  chmodSync(join(bin, "git"), 0o755);
  return bin;
};

/**
 * Runs `run.body` in a child whose Git is the fake one, and returns what the
 * child printed and how many lost answers were left unused. `register`
 * receives the cleanup of each temporary folder.
 */
export const runWithFakeGit = (
  run: FakeGitRun,
  register: (cleanup: () => void) => void
): { remaining: number; reply: unknown } => {
  const bin = fakeGitDirectory(register);
  // `count` token files, and the folder a claimed token moves into.
  const tokenDirectory = (prefix: string, count: number): string => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(`${directory}-taken`);
    register(() => {
      rmSync(directory, { force: true, recursive: true });
      rmSync(`${directory}-taken`, { force: true, recursive: true });
    });
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(directory, `token-${index}`), "");
    }
    return directory;
  };
  const tokens = tokenDirectory("simple-changes-lost-", run.lost);
  const skips = tokenDirectory("simple-changes-skip-", run.skip ?? 0);
  const script = join(bin, "child.ts");
  writeFileSync(script, run.body);
  const result = spawnSync([process.execPath, script], {
    env: {
      ...process.env,
      FAKE_GIT_EMPTY_FLAG: run.flag,
      FAKE_GIT_EMPTY_MODE: run.mode ?? "empty",
      FAKE_GIT_EMPTY_TOKENS: tokens,
      FAKE_GIT_FAIL_EXIT: String(run.failure?.exitCode ?? 3),
      FAKE_GIT_FAIL_FLAG: run.failFlag ?? "",
      FAKE_GIT_FAIL_STDERR: run.failure?.stderr ?? "error: simulated failure",
      FAKE_GIT_SKIP_TOKENS: skips,
      FAKE_GIT_VERSION: run.version ?? "",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = decoder.decode(result.stdout);
  if (result.exitCode !== 0) {
    throw new Error(`child failed: ${decoder.decode(result.stderr)}${stdout}`);
  }
  return { remaining: readdirSync(tokens).length, reply: JSON.parse(stdout) };
};
