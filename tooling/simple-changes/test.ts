import { join } from "node:path";
import { spawn } from "bun";
import { resolveTestTimeoutMs } from "../test-timeout.ts";

// The Simple Changes and merge-gate suites, discovered by `bun test` as
// before; only the per-test timeout is new.
const root = join(import.meta.dir, "..", "..");
const directories = [
  join(root, "tooling", "simple-changes", "tests"),
  join(root, "tooling", "merge-gate", "tests"),
];

const subprocess = spawn({
  cmd: [
    process.execPath,
    "test",
    "--timeout",
    String(resolveTestTimeoutMs()),
    ...directories,
  ],
  cwd: root,
  stderr: "inherit",
  stdin: "inherit",
  stdout: "inherit",
});
process.exitCode = await subprocess.exited;
