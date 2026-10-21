import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import {
  acceptPausedWorktreeChange,
  loopLeasePath,
  loopReplanStatus,
  replanLoop,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { replannedRegistrations } from "../../../skills/simple-changes/scripts/lib/replan-history.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  pauseClaimedWorktree,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

// The completed-replan archive that `worktree resume-ready` trusts (#3) is
// read only when it is exactly what `loop replan` wrote.

setDefaultTimeout(120_000);

let repositories: TestRepository[] = [];
afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

interface ReplanArchive {
  attempt: string;
  claimId: string;
  common: string;
  fixture: TestRepository;
  path: string;
  receiptId: string;
  runDirectory: string;
  runId: string;
}

// A frozen run that adopted one checkout, replaced through an approved replan.
const replanArchive = (): ReplanArchive => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  const path = join(fixture.base, "adopted");
  git(fixture.root, ["worktree", "add", "-b", "adopted-work", path]);
  writeFixture(path, "adopted.ts", "export const adopted = 1;\n");
  git(path, ["add", "adopted.ts"]);
  git(path, ["commit", "-m", "Adopted work"]);
  const lease = startLoop(fixture.root, "controller", "ship");
  const claim = claimWorktree(path, "owner", path, "claude-code");
  const receipt = pauseClaimedWorktree(
    path,
    "owner",
    path,
    lease.runId,
    "preserve-in-place",
    "Pause the finished checkout for the run."
  );
  acceptPausedWorktreeChange(
    fixture.root,
    lease.runId,
    "controller",
    receipt.receiptId
  );
  const leasePath = loopLeasePath(lease.commonGitDirectory);
  const stored = JSON.parse(readFileSync(leasePath, "utf8")) as LoopLease;
  stored.shipmentScopeFrozenAt = new Date().toISOString();
  writeFileSync(leasePath, `${JSON.stringify(stored, null, 2)}\n`);
  const status = loopReplanStatus(fixture.root);
  replanLoop(fixture.root, {
    agentId: status.agentId,
    approvedBy: "the-user",
    manifestDigest: status.manifestDigest,
    reason: "Replan the frozen shipment and preserve every checkout.",
    runId: status.runId,
    statusDigest: status.statusDigest,
  });
  const runDirectory = join(
    lease.commonGitDirectory,
    "simple-changes",
    "history",
    lease.runId
  );
  const [attempt] = readdirSync(runDirectory).filter((name) =>
    name.startsWith("replan-")
  );
  if (!attempt) {
    throw new Error("Expected a replan attempt directory");
  }
  return {
    attempt: join(runDirectory, attempt),
    claimId: claim.claimId,
    common: lease.commonGitDirectory,
    fixture,
    path,
    receiptId: receipt.receiptId,
    runDirectory,
    runId: lease.runId,
  };
};

const adoptedRegistration = (archive: ReplanArchive) =>
  expect.objectContaining({
    claimId: archive.claimId,
    path: archive.path,
    pauseReceiptId: archive.receiptId,
    role: "preserved",
  });

describe("completed replan archives", () => {
  test("reads the registrations of an intact archive and nothing else", () => {
    const archive = replanArchive();
    const read = () => replannedRegistrations(archive.common, archive.runId);
    expect(read()).toContainEqual(adoptedRegistration(archive));
    expect(replannedRegistrations(archive.common, "../history")).toEqual([]);
    expect(replannedRegistrations(archive.common, "run-unknown-1")).toEqual([]);

    const archived = join(archive.attempt, "replan-lease.json");
    const intent = join(archive.attempt, "replan.json");
    const archivedBytes = readFileSync(archived, "utf8");
    const intentBytes = readFileSync(intent, "utf8");
    const elsewhere = join(archive.fixture.base, "elsewhere");
    mkdirSync(elsewhere);
    const restore = (): void => {
      rmSync(archive.runDirectory, { force: true, recursive: true });
      mkdirSync(archive.attempt, { recursive: true });
      writeFileSync(archived, archivedBytes);
      writeFileSync(intent, intentBytes);
      expect(read()).toContainEqual(adoptedRegistration(archive));
    };

    // An intent alone does not prove the replan completed.
    rmSync(archived);
    expect(read()).toEqual([]);
    restore();

    // A linked archive, intent, attempt, or run directory is not followed.
    for (const [linkPath, target] of [
      [archived, join(elsewhere, "replan-lease.json")],
      [intent, join(elsewhere, "replan.json")],
    ] as const) {
      cpSync(linkPath, target);
      rmSync(linkPath);
      symlinkSync(target, linkPath);
      expect(read()).toEqual([]);
      restore();
    }
    for (const directory of [archive.attempt, archive.runDirectory]) {
      const copy = join(elsewhere, `copy-${directory.length}`);
      cpSync(directory, copy, { recursive: true });
      rmSync(directory, { recursive: true });
      symlinkSync(copy, directory);
      expect(read()).toEqual([]);
      rmSync(directory);
      restore();
    }

    // A FIFO in place of the archive is refused without blocking.
    rmSync(archived);
    expect(spawnSync(["mkfifo", archived]).exitCode).toBe(0);
    expect(read()).toEqual([]);
    restore();

    // An archive-recorded attempt, or an intent of that kind, is not a replan.
    const recorded = archive.attempt.replace("/replan-", "/archive-recorded-");
    renameSync(archive.attempt, recorded);
    expect(read()).toEqual([]);
    restore();
    writeFileSync(
      intent,
      intentBytes.replace(
        '"kind": "loop-replan"',
        '"kind": "loop-archive-recorded"'
      )
    );
    expect(read()).toEqual([]);
    restore();
  });

  test("refuses an archive recorded for another run or repository", () => {
    const archive = replanArchive();
    // The same attempt copied under another run's history.
    const otherRun = join(archive.runDirectory, "..", "run-other-1");
    cpSync(archive.runDirectory, otherRun, { recursive: true });
    expect(replannedRegistrations(archive.common, "run-other-1")).toEqual([]);

    // The same history copied into another repository's state.
    const other = createTestRepository();
    repositories.push(other);
    const otherCommon = join(other.root, ".git");
    cpSync(
      join(archive.common, "simple-changes", "history"),
      join(otherCommon, "simple-changes", "history"),
      { recursive: true }
    );
    expect(replannedRegistrations(otherCommon, archive.runId)).toEqual([]);
    expect(
      replannedRegistrations(archive.common, archive.runId)
    ).toContainEqual(adoptedRegistration(archive));
  });
});
