// Runs read-only Git commands concurrently on behalf of a synchronous caller.
// `runGitConcurrently` in process.ts starts this file with the current Bun
// executable, writes one JSON request to stdin, and reads one JSON reply. The
// reply carries raw stdout bytes so the caller decodes them exactly as it
// decodes its own Git output. It imports only Bun and the request checks to
// keep startup cheap.

import { spawn, stdin } from "bun";
import { type GitWorkerInput, gitWorkerRefusal } from "./git-worker-request.ts";

interface GitWorkerResult {
  exitCode: number;
  stdout: string;
}

// The worker runs only Git, as `git -C <cwd> <subcommand> ...`. A request
// that names another program, or puts an option where the subcommand
// belongs, runs nothing: the worker exits 2, and the caller runs every
// request through `runGit` instead.
const received: unknown = await stdin.json();
const refusal = gitWorkerRefusal(received);
if (refusal) {
  // Exit only once the reason is written: a pipe may not flush otherwise.
  await new Promise((written) =>
    process.stderr.write(
      `Git worker refused its request: ${refusal}.\n`,
      written
    )
  );
  process.exit(2);
}
const input = received as GitWorkerInput;
const results: GitWorkerResult[] = Array.from<GitWorkerResult>({
  length: input.requests.length,
});

// A request that cannot start or finish reading (for example, a missing
// directory) is reported as failed so the caller re-runs it directly and
// raises its usual error.
const FAILED: GitWorkerResult = { exitCode: -1, stdout: "" };

const runRequest = async (index: number): Promise<void> => {
  const request = input.requests[index];
  if (!request) {
    return;
  }
  try {
    const child = spawn(
      [input.executable, "-C", request.cwd, ...request.args],
      { cwd: request.cwd, stderr: "ignore", stdout: "pipe" }
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      child.exited,
    ]);
    results[index] = {
      exitCode,
      stdout: Buffer.from(stdout).toString("base64"),
    };
  } catch {
    results[index] = FAILED;
  }
};

const laneCount = Math.max(
  1,
  Math.min(input.concurrency, input.requests.length)
);
const lanes = Array.from({ length: laneCount }, (_, lane) =>
  input.requests
    .map((_request, index) => index)
    .filter((index) => index % laneCount === lane)
    .reduce(
      (previous, index) => previous.then(() => runRequest(index)),
      Promise.resolve()
    )
);
await Promise.all(lanes);
process.stdout.write(JSON.stringify(results));
