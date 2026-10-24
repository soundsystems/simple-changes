import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, which } from "bun";

const decoder = new TextDecoder();

export type FakeGitLoss = "empty" | "first-line" | `lines:${number}`;

export interface FakeGitRun {
  /** A child Bun script that prints one JSON value. */
  body: string;
  /** Calls whose arguments fail with exit 3 when they contain this. */
  failFlag?: string;
  /**
   * Calls whose arguments contain this (one argument, or several in a row)
   * lose their answer while lost answers remain.
   */
  flag: string;
  /** How many answers to lose. */
  lost: number;
  /**
   * `empty`: exit 0 with no output. `first-line` and `lines:<n>`: exit 0
   * with only the first line, or the first n lines, of the real answer, an
   * answer cut short.
   */
  mode?: FakeGitLoss;
}

// A Git on PATH that answers truthfully, except as the environment says:
// while token files remain, a call whose arguments contain
// FAKE_GIT_EMPTY_FLAG removes one token and loses its answer
// (FAKE_GIT_EMPTY_MODE), and a call whose arguments contain
// FAKE_GIT_FAIL_FLAG fails with exit 3.
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
if [ -n "$FAKE_GIT_FAIL_FLAG" ]; then
  case " $* " in
    *" $FAKE_GIT_FAIL_FLAG "*)
      echo "error: simulated failure" >&2
      exit 3
      ;;
  esac
fi
if [ -n "$FAKE_GIT_EMPTY_FLAG" ] && [ -d "$FAKE_GIT_EMPTY_TOKENS" ]; then
  case " $* " in
    *" $FAKE_GIT_EMPTY_FLAG "*)
      for token in "$FAKE_GIT_EMPTY_TOKENS"/*; do
        if rm "$token" 2>/dev/null; then
          case "$FAKE_GIT_EMPTY_MODE" in
            first-line) "$real" "$@" | head -n 1 ;;
            lines:*) "$real" "$@" | head -n "\${FAKE_GIT_EMPTY_MODE#lines:}" ;;
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
  const tokens = mkdtempSync(join(tmpdir(), "simple-changes-lost-"));
  register(() => rmSync(tokens, { force: true, recursive: true }));
  for (let index = 0; index < run.lost; index += 1) {
    writeFileSync(join(tokens, `token-${index}`), "");
  }
  const script = join(bin, "child.ts");
  writeFileSync(script, run.body);
  const result = spawnSync([process.execPath, script], {
    env: {
      ...process.env,
      FAKE_GIT_EMPTY_FLAG: run.flag,
      FAKE_GIT_EMPTY_MODE: run.mode ?? "empty",
      FAKE_GIT_EMPTY_TOKENS: tokens,
      FAKE_GIT_FAIL_FLAG: run.failFlag ?? "",
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
