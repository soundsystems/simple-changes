import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Subprocess, sleep, spawn } from "bun";
import { EXIT_CODES } from "../../../skills/simple-changes/scripts/lib/errors.ts";
import { locateRepository } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  LoopLockWaitError,
  loopLockPath,
  readLoopLease,
  withLoopStateLockBounded,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { reviewLedgerPath } from "../../../skills/simple-changes/scripts/lib/review-ledger.ts";
import {
  claimWorktree,
  readWorktreeCoordination,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(180_000);

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(
  testDirectory,
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const holderPath = resolve(testDirectory, "fixtures/lock-wait/holder.ts");
const environment = { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" };

let repositories: TestRepository[] = [];
let holders: Subprocess[] = [];

afterEach(() => {
  for (const holder of holders) {
    holder.kill("SIGKILL");
  }
  holders = [];
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const runCli = async (args: string[]): Promise<CliResult> => {
  const child = spawn([process.execPath, cliPath, ...args], {
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

interface Checkout {
  claimId: string;
  commit: string;
  common: string;
  fixture: TestRepository;
  path: string;
}

// A claimed checkout with one commit its author has not attested yet.
const claimedCommit = (): Checkout => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  const path = join(fixture.base, "unit");
  git(fixture.root, ["worktree", "add", "-b", "unit", path, "main"]);
  const { claimId } = claimWorktree(path, "author", path, "test-adapter");
  writeFixture(path, "unit.txt", "unit\n");
  git(path, ["add", "unit.txt"]);
  git(path, ["commit", "-m", "Add unit"]);
  return {
    claimId,
    commit: git(path, ["rev-parse", "HEAD"]),
    common: locateRepository(path).repository.commonGitDirectory,
    fixture,
    path,
  };
};

const ownerFile = (common: string): string =>
  join(loopLockPath(common), "owner.json");

const readOwner = (common: string): Record<string, unknown> | null =>
  existsSync(ownerFile(common))
    ? (JSON.parse(readFileSync(ownerFile(common), "utf8")) as Record<
        string,
        unknown
      >)
    : null;

// Polls by recursion, one check at a time.
const until = async (
  condition: () => boolean,
  what: string,
  deadline = Date.now() + 60_000
): Promise<void> => {
  if (condition()) {
    return;
  }
  if (Date.now() > deadline) {
    throw new Error(`Timed out waiting for ${what}`);
  }
  await sleep(20);
  return until(condition, what, deadline);
};

interface Holder {
  child: Subprocess;
  pid: number;
  release: () => Promise<void>;
}

// Another live process holding the loop lock until it is released.
const holdLock = async (
  checkout: Checkout,
  operation = "test holder"
): Promise<Holder> => {
  const releaseFile = join(
    checkout.fixture.base,
    `release-${holders.length}.flag`
  );
  const child = spawn(
    [
      process.execPath,
      holderPath,
      checkout.common,
      operation,
      releaseFile,
      "170000",
    ],
    { env: environment, stderr: "inherit", stdout: "ignore" }
  );
  holders.push(child);
  await until(
    () => readOwner(checkout.common)?.pid === child.pid,
    "the holder to take the lock"
  );
  return {
    child,
    pid: child.pid,
    release: async () => {
      writeFileSync(releaseFile, "");
      expect(await child.exited).toBe(0);
    },
  };
};

const attestArgs = (checkout: Checkout, ...extra: string[]): string[] => [
  "author",
  "attest",
  "--commit",
  checkout.commit,
  "--agent-id",
  "author",
  "--repo",
  checkout.path,
  "--json",
  ...extra,
];

const ledgerAttestations = (checkout: Checkout): unknown[] => {
  const path = reviewLedgerPath(checkout.common);
  if (!existsSync(path)) {
    return [];
  }
  const ledger = JSON.parse(readFileSync(path, "utf8")) as {
    attestations: Record<string, unknown[]>;
  };
  return ledger.attestations[checkout.commit] ?? [];
};

interface ErrorReport {
  error: string;
  exitCode: number;
  lockWait?: {
    executed: boolean;
    operation: string;
    outcome: string;
    owner: Record<string, unknown> | null;
    timeoutMs: number;
    waitedMs: number;
  };
  ok: boolean;
}

const errorReport = (result: { stderr: string }): ErrorReport =>
  JSON.parse(result.stderr.trim()) as ErrorReport;

describe("bounded loop-lock waits for metadata writers", () => {
  test("without --wait-lock a held lock still refuses at once and writes nothing", async () => {
    const checkout = claimedCommit();
    const holder = await holdLock(checkout);
    const refused = await runCli(attestArgs(checkout));
    expect(refused.exitCode).toBe(EXIT_CODES.unsafe);
    const report = errorReport(refused);
    expect(report.error).toContain("Active-loop state is busy");
    expect(report).not.toHaveProperty("lockWait");
    expect(ledgerAttestations(checkout)).toEqual([]);
    await holder.release();
    // The same command succeeds once the lock is free.
    expect((await runCli(attestArgs(checkout))).exitCode).toBe(0);
    expect(ledgerAttestations(checkout)).toHaveLength(1);
  });

  test("waits for a live holder, then each waiter runs once and the commit is attested once", async () => {
    const checkout = claimedCommit();
    const holder = await holdLock(checkout);
    let settled = 0;
    const waiters = [0, 1].map(() =>
      runCli(
        attestArgs(checkout, "--wait-lock", "--timeout-ms", "120000")
      ).then((result) => {
        settled += 1;
        return result;
      })
    );
    // Both are still waiting while the holder lives, and nothing is written.
    await sleep(1500);
    expect(settled).toBe(0);
    expect(ledgerAttestations(checkout)).toEqual([]);
    await holder.release();
    const results = await Promise.all(waiters);
    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    }
    const statuses = results
      .map(
        (result) =>
          (
            JSON.parse(result.stdout) as {
              attestations: Array<{ status: string }>;
            }
          ).attestations[0]?.status
      )
      .sort();
    expect(statuses).toEqual(["recorded", "unchanged"]);
    expect(ledgerAttestations(checkout)).toHaveLength(1);
    expect(existsSync(loopLockPath(checkout.common))).toBe(false);
  });

  test("times out with executed=false and the owner's details, writing nothing and leaving the lock its owner's", async () => {
    const checkout = claimedCommit();
    const holder = await holdLock(checkout);
    const before = readOwner(checkout.common);
    const timedOut = await runCli(
      attestArgs(checkout, "--wait-lock", "--timeout-ms", "800")
    );
    expect(timedOut.exitCode).toBe(EXIT_CODES.unsafe);
    const report = errorReport(timedOut);
    expect(report.error).toContain("Active-loop state is busy");
    expect(report.error).toContain("did not run, and wrote nothing");
    expect(report.lockWait).toMatchObject({
      executed: false,
      operation: "author attest",
      outcome: "timed-out",
      owner: {
        hostname: hostname(),
        operation: "test holder",
        pid: holder.pid,
      },
      timeoutMs: 800,
    });
    expect(report.lockWait?.waitedMs).toBeGreaterThanOrEqual(800);
    expect(report.lockWait?.owner).not.toHaveProperty("token");
    expect(readOwner(checkout.common)).toEqual(before);
    expect(existsSync(reviewLedgerPath(checkout.common))).toBe(false);
    await holder.release();
  });

  test("never recovers a dead owner's lock: the wait ends at once and the stale-lock rules still apply", async () => {
    const checkout = claimedCommit();
    const holder = await holdLock(checkout);
    holder.child.kill("SIGKILL");
    await holder.child.exited;
    const stale = readOwner(checkout.common);
    expect(stale?.pid).toBe(holder.pid);
    const refused = await runCli(
      attestArgs(checkout, "--wait-lock", "--timeout-ms", "120000")
    );
    expect(refused.exitCode).toBe(EXIT_CODES.unsafe);
    const report = errorReport(refused);
    expect(report.lockWait).toMatchObject({
      executed: false,
      outcome: "owner-not-running",
      owner: { pid: holder.pid },
    });
    // It stopped well before its bound instead of waiting on a lock no one
    // will release, and the lock is exactly as the dead owner left it.
    expect(report.lockWait?.waitedMs).toBeLessThan(60_000);
    expect(report.error).toContain("A wait never recovers a lock");
    expect(readOwner(checkout.common)).toEqual(stale);
    expect(ledgerAttestations(checkout)).toEqual([]);
  });

  test("waits out another process's loop exec, which a plain ledger write refuses", async () => {
    const checkout = claimedCommit();
    const holder = await holdLock(checkout, "loop exec");
    const refused = await runCli(attestArgs(checkout));
    expect(refused.exitCode).toBe(EXIT_CODES.unsafe);
    expect(errorReport(refused).error).toContain(
      "cannot be written while loop exec holds the loop lock"
    );
    const waiting = runCli(
      attestArgs(checkout, "--wait-lock", "--timeout-ms", "120000")
    );
    await sleep(1000);
    expect(ledgerAttestations(checkout)).toEqual([]);
    await holder.release();
    expect((await waiting).exitCode).toBe(0);
    expect(ledgerAttestations(checkout)).toHaveLength(1);
  });

  test("refuses at once a wait for an owner the command runs inside", async () => {
    const checkout = claimedCommit();
    const resultFile = join(checkout.fixture.base, "nested.json");
    const holder = spawn(
      [
        process.execPath,
        holderPath,
        checkout.common,
        "loop exec",
        join(checkout.fixture.base, "unused.flag"),
        "0",
        resultFile,
        "--",
        process.execPath,
        cliPath,
        ...attestArgs(checkout, "--wait-lock", "--timeout-ms", "120000"),
      ],
      { env: environment, stderr: "inherit", stdout: "ignore" }
    );
    holders.push(holder);
    expect(await holder.exited).toBe(0);
    const nested = JSON.parse(readFileSync(resultFile, "utf8")) as {
      exitCode: number;
      stderr: string;
    };
    expect(nested.exitCode).toBe(EXIT_CODES.unsafe);
    const report = errorReport(nested);
    expect(report.lockWait).toMatchObject({
      executed: false,
      outcome: "caller-inside-owner",
      owner: { operation: "loop exec", pid: holder.pid },
    });
    expect(report.lockWait?.waitedMs).toBeLessThan(60_000);
    expect(ledgerAttestations(checkout)).toEqual([]);
  });

  test("proposal record-authors waits the same way and records once", async () => {
    const checkout = claimedCommit();
    expect((await runCli(attestArgs(checkout))).exitCode).toBe(0);
    const base = git(checkout.path, ["rev-parse", "main"]);
    const record = (...extra: string[]) =>
      runCli([
        "proposal",
        "record-authors",
        "--proposal",
        "lock-wait",
        "--base",
        base,
        "--head",
        checkout.commit,
        "--repo",
        checkout.path,
        "--json",
        ...extra,
      ]);
    const holder = await holdLock(checkout);
    expect((await record()).exitCode).toBe(EXIT_CODES.unsafe);
    const timedOut = await record("--wait-lock", "--timeout-ms", "300");
    expect(timedOut.exitCode).toBe(EXIT_CODES.unsafe);
    expect(errorReport(timedOut).lockWait).toMatchObject({
      executed: false,
      operation: "proposal record-authors",
      outcome: "timed-out",
    });
    const waiting = record("--wait-lock");
    await sleep(1000);
    await holder.release();
    const recorded = await waiting;
    expect(recorded.stderr).toBe("");
    expect(recorded.exitCode).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({
      proposalId: "lock-wait",
      status: "recorded",
    });
  });

  test("loop record-scope, a controller metadata step, waits for the lock", async () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "src/ready.ts", "export const ready = true;\n");
    const preview = await runCli(["preview", "--json", "--repo", fixture.root]);
    const planPath = join(fixture.base, "plan.json");
    writeFileSync(planPath, preview.stdout);
    const started = await runCli([
      "loop",
      "start",
      "--mode",
      "ship",
      "--agent-id",
      "controller",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(started.exitCode).toBe(0);
    const runId = readLoopLease(fixture.root)?.runId as string;
    const recordScope = (...extra: string[]) =>
      runCli([
        "loop",
        "record-scope",
        "--run-id",
        runId,
        "--agent-id",
        "controller",
        "--receipt",
        planPath,
        "--repo",
        fixture.root,
        "--json",
        ...extra,
      ]);
    const checkout: Checkout = {
      claimId: "",
      commit: "",
      common: locateRepository(fixture.root).repository.commonGitDirectory,
      fixture,
      path: fixture.root,
    };
    const holder = await holdLock(checkout);
    const refused = await recordScope();
    expect(refused.exitCode).toBe(EXIT_CODES.unsafe);
    expect(errorReport(refused)).not.toHaveProperty("lockWait");
    expect(readLoopLease(fixture.root)?.shipmentScope).toBeFalsy();
    const waiting = recordScope("--wait-lock", "--timeout-ms", "120000");
    await sleep(1000);
    expect(readLoopLease(fixture.root)?.shipmentScope).toBeFalsy();
    await holder.release();
    expect((await waiting).exitCode).toBe(0);
    expect(readLoopLease(fixture.root)?.shipmentScope).toBeTruthy();
  });

  test("worktree release --ready-receipt waits for the lock, then hands off once", async () => {
    const checkout = claimedCommit();
    expect((await runCli(attestArgs(checkout))).exitCode).toBe(0);
    const receiptPath = join(checkout.fixture.base, "ready.json");
    writeFileSync(
      receiptPath,
      JSON.stringify({
        checks: [{ command: "bun test", result: "passed" }],
        releaseImpact: "patch",
        scope: "Adds one unit.",
      })
    );
    const release = (...extra: string[]) =>
      runCli([
        "worktree",
        "release",
        "--agent-id",
        "author",
        "--claim-id",
        checkout.claimId,
        "--ready-receipt",
        receiptPath,
        "--repo",
        checkout.path,
        "--json",
        ...extra,
      ]);
    const claimState = () =>
      readWorktreeCoordination(checkout.path).claims.find(
        (claim) => claim.claimId === checkout.claimId
      )?.state;
    const holder = await holdLock(checkout);
    expect((await release()).exitCode).toBe(EXIT_CODES.unsafe);
    expect(claimState()).toBe("active");
    const waiting = release("--wait-lock", "--timeout-ms", "120000");
    await sleep(1000);
    expect(claimState()).toBe("active");
    await holder.release();
    const released = await waiting;
    expect(released.stderr).toBe("");
    expect(released.exitCode).toBe(0);
    expect(claimState()).toBe("released");
  });

  test("an operation that fails under the lock runs once and is never retried", () => {
    const checkout = claimedCommit();
    let calls = 0;
    expect(() =>
      withLoopStateLockBounded(
        checkout.common,
        "test failure",
        () => {
          calls += 1;
          throw new Error("partial write");
        },
        { timeoutMs: 5000 }
      )
    ).toThrow("partial write");
    expect(calls).toBe(1);
    expect(existsSync(loopLockPath(checkout.common))).toBe(false);
    // A wait whose owner is this very process never waits on itself.
    const nested = withLoopStateLockBounded(checkout.common, "outer", () => {
      try {
        withLoopStateLockBounded(checkout.common, "inner", () => 1, {
          timeoutMs: 60_000,
        });
      } catch (error) {
        return error;
      }
      return null;
    });
    expect(nested).toBeInstanceOf(LoopLockWaitError);
    expect((nested as LoopLockWaitError).lockWait).toMatchObject({
      executed: false,
      operation: "inner",
      outcome: "caller-inside-owner",
    });
  });

  test("refuses the flags where they cannot apply", async () => {
    const checkout = claimedCommit();
    const refusals = await Promise.all(
      [
        attestArgs(checkout, "--timeout-ms", "100"),
        attestArgs(checkout, "--wait-lock", "--timeout-ms", "600001"),
        attestArgs(checkout, "--wait-lock", "--timeout-ms", "1.5"),
        ["inventory", "--wait-lock", "--repo", checkout.path],
        [
          "worktree",
          "release",
          "--agent-id",
          "author",
          "--claim-id",
          "claim-x",
          "--wait-lock",
          "--repo",
          checkout.path,
        ],
      ].map((args) => runCli(args))
    );
    for (const refused of refusals) {
      expect(refused.exitCode).toBe(EXIT_CODES.usage);
    }
    expect(ledgerAttestations(checkout)).toEqual([]);
  });

  test("initialize --mode preview resolves the reviewer while another process holds the lock", async () => {
    const checkout = claimedCommit();
    const holder = await holdLock(checkout);
    const before = readOwner(checkout.common);
    const preview = await runCli([
      "initialize",
      "--mode",
      "preview",
      "--proposal",
      "lock-wait",
      "--head",
      checkout.commit,
      "--repo",
      checkout.path,
      "--json",
    ]);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toHaveProperty("reviewer.status");
    expect(readOwner(checkout.common)).toEqual(before);
    expect(existsSync(reviewLedgerPath(checkout.common))).toBe(false);
    await holder.release();
  });
});
