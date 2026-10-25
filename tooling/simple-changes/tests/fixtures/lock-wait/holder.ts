// Holds the loop state lock from its own process, as another live command
// would, until RELEASE_FILE exists or HOLD_MS passes. With a command after
// `--`, it instead runs that command while it holds the lock, as `loop exec`
// does: through two shell wrappers, recording the outer one as its child, and
// writes the command's result to RESULT_FILE.
//
//   bun holder.ts COMMON_GIT_DIR OPERATION RELEASE_FILE HOLD_MS [RESULT_FILE -- ARGV...]
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "bun";
import { withLoopStateLock } from "../../../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { withAsyncStateLock } from "../../../../../skills/simple-changes/scripts/lib/loop-lease-core.ts";

const [commonGitDirectory, operation, releaseFile, holdMs, resultFile] =
  process.argv.slice(2) as [string, string, string, string, string?];
const separator = process.argv.indexOf("--");
const nested = separator >= 0 ? process.argv.slice(separator + 1) : [];

// Each shell runs its command and then exits, so neither replaces itself
// with the command and both stay between the holder and the command.
const WRAPPED = [
  "/bin/sh",
  "-c",
  `/bin/sh -c '"$@"; exit $?' sh "$@"; exit $?`,
  "sh",
];

if (nested.length > 0 && resultFile) {
  await withAsyncStateLock(commonGitDirectory, operation, async (lock) => {
    lock.update({ childStarting: true });
    const child = spawn([...WRAPPED, ...nested], {
      env: process.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    lock.update({ childProcessId: child.pid, childStarting: false });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    writeFileSync(resultFile, JSON.stringify({ exitCode, stderr, stdout }));
  });
} else {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  withLoopStateLock(commonGitDirectory, operation, () => {
    const deadline = Date.now() + Number(holdMs);
    while (!existsSync(releaseFile) && Date.now() < deadline) {
      Atomics.wait(pause, 0, 0, 20);
    }
  });
}
