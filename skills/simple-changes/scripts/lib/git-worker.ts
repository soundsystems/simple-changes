// Runs read-only Git commands concurrently on behalf of a synchronous caller.
// `runGitConcurrently` in process.ts starts this file with the current Bun
// executable, writes one JSON request to stdin, and reads one JSON reply. The
// reply carries raw stdout bytes so the caller decodes them exactly as it
// decodes its own Git output. It imports only Bun to keep startup cheap.

import { spawn, stdin } from "bun";

interface GitWorkerRequest {
  args: string[];
  cwd: string;
}

interface GitWorkerInput {
  concurrency: number;
  executable: string;
  requests: GitWorkerRequest[];
}

interface GitWorkerResult {
  exitCode: number;
  stdout: string;
}

const input = (await stdin.json()) as GitWorkerInput;
const results: GitWorkerResult[] = new Array(input.requests.length);

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
