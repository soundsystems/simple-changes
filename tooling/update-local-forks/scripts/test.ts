import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

const testsDirectory = join(import.meta.dir, "tests");
const testFiles = (await readdir(testsDirectory))
  .filter((file) => file.endsWith(".check.ts"))
  .sort()
  .map((file) => join(testsDirectory, file));

if (testFiles.length === 0) {
  throw new Error(`No update-local-forks checks found in ${testsDirectory}`);
}

const subprocess = spawn({
  cmd: [process.execPath, "test", ...testFiles],
  stderr: "inherit",
  stdin: "inherit",
  stdout: "inherit",
});
process.exitCode = await subprocess.exited;
