// Holds the loop state lock from its own process, as another live command
// would, until RELEASE_FILE exists or HOLD_MS passes. With a command after
// `--`, it runs that command while it holds the lock (a command nested inside
// the owner) and writes its result to RESULT_FILE.
//
//   bun holder.ts COMMON_GIT_DIR OPERATION RELEASE_FILE HOLD_MS [RESULT_FILE -- ARGV...]
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "bun";
import { withLoopStateLock } from "../../../../../skills/simple-changes/scripts/lib/loop-lease.ts";

const [commonGitDirectory, operation, releaseFile, holdMs, resultFile] =
  process.argv.slice(2);
const separator = process.argv.indexOf("--");
const nested = separator >= 0 ? process.argv.slice(separator + 1) : [];
const pause = new Int32Array(new SharedArrayBuffer(4));

withLoopStateLock(commonGitDirectory as string, operation as string, () => {
  if (nested.length > 0 && resultFile) {
    const result = spawnSync(nested, { stderr: "pipe", stdout: "pipe" });
    writeFileSync(
      resultFile,
      JSON.stringify({
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
    );
    return;
  }
  const deadline = Date.now() + Number(holdMs);
  while (!existsSync(releaseFile as string) && Date.now() < deadline) {
    Atomics.wait(pause, 0, 0, 20);
  }
});
