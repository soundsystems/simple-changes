import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  endLoop,
  startLoop,
  verifyLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import {
  parseReadyWorkInput,
  readyReceiptsPath,
  readyWorkStatus,
  recordReadyWork,
} from "../../../skills/simple-changes/scripts/lib/ready-work.ts";
import {
  addShipHold,
  checkShipHolds,
  HOLD_REF_PREFIX,
  publishShipHold,
  releaseShipHold,
  shipHoldsPath,
  waiveShipHold,
} from "../../../skills/simple-changes/scripts/lib/ship-holds.ts";
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

setDefaultTimeout(60_000);
const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);

let repositories: TestRepository[] = [];

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const READY_INPUT = {
  checks: [{ command: "bun test", result: "passed" }],
  deploymentConstraints: ["Deploy after the 17:00 freeze lifts."],
  migrations: [],
  releaseImpact: "patch",
  scope: "Adds the feature module.",
};

const featureWorktree = (
  fixture: TestRepository,
  name: string
): { branch: string; path: string } => {
  const path = join(fixture.base, name);
  const branch = `feat/${name}`;
  git(fixture.root, ["worktree", "add", "-b", branch, path]);
  writeFixture(path, `${name}.ts`, `export const ${name} = true;\n`);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", `Add ${name}`]);
  return { branch, path };
};

const withOrigin = (fixture: TestRepository): string => {
  const origin = join(fixture.base, "origin.git");
  git(fixture.base, ["init", "--bare", origin]);
  git(fixture.root, ["remote", "add", "origin", origin]);
  git(fixture.root, ["push", "origin", "main"]);
  git(fixture.root, ["fetch", "origin"]);
  return origin;
};

const runCli = (
  args: string[]
): { exitCode: number; stderr: string; stdout: string } => {
  const result = spawnSync([process.execPath, cliPath, ...args], {
    env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

describe("ready-work receipts", () => {
  test("bind the clean claimed head, release the claim, and track freshness", () => {
    const fixture = repository();
    const { branch, path } = featureWorktree(fixture, "ready");
    const claim = claimWorktree(path, "codex-author", path, "codex-desktop");
    const input = parseReadyWorkInput(READY_INPUT);

    expect(() =>
      recordReadyWork(path, "intruder", claim.claimId, input)
    ).toThrow("Only the exact claim owner");
    writeFixture(path, "ready.ts", "export const ready = false;\n");
    expect(() =>
      recordReadyWork(path, "codex-author", claim.claimId, input)
    ).toThrow("commit every change first");
    git(path, ["checkout", "--", "ready.ts"]);

    const { claim: released, receipt } = recordReadyWork(
      path,
      "codex-author",
      claim.claimId,
      input
    );
    expect(released).toMatchObject({
      headSha: git(path, ["rev-parse", "HEAD"]),
      releaseReason: "handoff",
      state: "released",
    });
    expect(receipt).toMatchObject({
      branch,
      claimId: claim.claimId,
      headSha: git(path, ["rev-parse", "HEAD"]),
      owner: { adapter: "codex-desktop", agentId: "codex-author" },
      releaseImpact: "patch",
    });
    const common = captureInventory(path).repository.commonGitDirectory;
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits require a bit mask.
    expect(statSync(readyReceiptsPath(common)).mode & 0o777).toBe(0o600);
    // The coordination document keeps a release reason older clients accept.
    expect(
      readWorktreeCoordination(path).claims.map((item) => item.releaseReason)
    ).toEqual(["handoff"]);
    expect(
      readyWorkStatus(captureInventory(fixture.root)).map(
        (item) => item.freshness
      )
    ).toEqual(["current"]);

    writeFixture(path, "later.ts", "export const later = true;\n");
    git(path, ["add", "."]);
    git(path, ["commit", "-m", "Later work"]);
    expect(readyWorkStatus(captureInventory(fixture.root))[0]).toMatchObject({
      freshness: "stale",
    });

    git(fixture.root, ["merge", "--no-ff", branch, "-m", "Merge ready"]);
    expect(readyWorkStatus(captureInventory(fixture.root))[0]).toMatchObject({
      freshness: "shipped",
    });
  });

  test("report squash-merged ready work as shipped", () => {
    const fixture = repository();
    const { branch, path } = featureWorktree(fixture, "squashed");
    const claim = claimWorktree(path, "author", path, "codex-desktop");
    recordReadyWork(
      path,
      "author",
      claim.claimId,
      parseReadyWorkInput(READY_INPUT)
    );
    git(fixture.root, ["merge", "--squash", branch]);
    git(fixture.root, ["commit", "-m", "Squash squashed"]);
    expect(readyWorkStatus(captureInventory(fixture.root))[0]).toMatchObject({
      freshness: "shipped",
    });
  });

  test("hand off to an active loop without blocking its integration", () => {
    const fixture = repository();
    const lease = startLoop(fixture.root, "controller", "integrate");
    const { path } = featureWorktree(fixture, "midloop");
    const claim = claimWorktree(path, "late-author", path, "codex-desktop");
    expect(verifyLoop(fixture.root).ok).toBe(true);
    writeFixture(path, "midloop.ts", "export const midloop = 2;\n");
    git(path, ["commit", "-am", "Finish midloop"]);
    expect(verifyLoop(fixture.root).ok).toBe(true);

    recordReadyWork(
      path,
      "late-author",
      claim.claimId,
      parseReadyWorkInput(READY_INPUT)
    );
    const verification = verifyLoop(fixture.root);
    expect(verification.violations).toEqual([]);
    expect(verification.ok).toBe(true);
    endLoop(fixture.root, lease.runId, "controller");
  });

  test("reject runtime-owned fields, bad values, and secrets in author input", () => {
    expect(() =>
      parseReadyWorkInput({ ...READY_INPUT, headSha: "a".repeat(40) })
    ).toThrow("unsupported field(s): headSha");
    expect(() =>
      parseReadyWorkInput({ ...READY_INPUT, releaseImpact: "huge" })
    ).toThrow("releaseImpact must be");
    expect(() =>
      parseReadyWorkInput({
        ...READY_INPUT,
        scope: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      })
    ).toThrow("must not contain credentials");
    expect(parseReadyWorkInput(READY_INPUT)).toMatchObject({
      checks: [{ note: null, result: "passed" }],
      unresolvedAuthority: [],
    });
  });
});

describe("shipment holds", () => {
  test("block only the steps their scope covers until the owner releases them", () => {
    const fixture = repository();
    const hold = addShipHold(fixture.root, {
      adapter: "claude-code",
      agentId: "migration-owner",
      reason: "Production backfill is running.",
      scope: "deploy",
      severity: "halt",
    });
    const common = captureInventory(fixture.root).repository.commonGitDirectory;
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits require a bit mask.
    expect(statSync(shipHoldsPath(common)).mode & 0o777).toBe(0o600);

    const merge = checkShipHolds(fixture.root, { action: "merge" });
    expect(merge.clear).toBe(true);
    expect(merge.advisory.map((item) => item.hold.holdId)).toEqual([
      hold.holdId,
    ]);
    const deploy = checkShipHolds(fixture.root, { action: "deploy" });
    expect(deploy.clear).toBe(false);
    expect(deploy.nextSteps[0]).toContain("Stop:");
    expect(checkShipHolds(fixture.root, { action: "migrations" }).clear).toBe(
      true
    );

    expect(() =>
      releaseShipHold(fixture.root, {
        agentId: "shipper",
        holdId: hold.holdId,
      })
    ).toThrow("Only migration-owner may release");
    expect(() =>
      releaseShipHold(fixture.root, {
        agentId: "shipper",
        approvedBy: "jaay",
        holdId: hold.holdId,
        reason: "Backfill finished; owner session is closed.",
      })
    ).toThrow("--override-halt");
    const approved = releaseShipHold(fixture.root, {
      agentId: "shipper",
      approvedBy: "jaay",
      holdId: hold.holdId,
      overrideHalt: true,
      reason: "Backfill finished; owner session is closed.",
    });
    expect(approved.hold.release).toMatchObject({
      approvedBy: "jaay",
      reason: "approved-release",
      releasedBy: "shipper",
    });
    expect(checkShipHolds(fixture.root, { action: "deploy" }).clear).toBe(true);
  });

  test("bind waivers to one controller run and require an explicit halt override", () => {
    const fixture = repository();
    const delay = addShipHold(fixture.root, {
      adapter: "codex-desktop",
      agentId: "release-owner",
      reason: "Wait for the companion API change.",
      scope: "ship",
      severity: "delay",
    });
    const halt = addShipHold(fixture.root, {
      adapter: "codex-desktop",
      agentId: "incident-owner",
      reason: "Incident in progress.",
      scope: "ship",
      severity: "halt",
    });
    expect(() =>
      waiveShipHold(fixture.root, {
        agentId: "controller",
        approvedBy: "jaay",
        holdId: delay.holdId,
        overrideHalt: false,
        reason: "Ship without the companion change.",
        runId: "run-missing",
      })
    ).toThrow("Only the active controller");

    const lease = startLoop(fixture.root, "controller", "integrate");
    const waive = (
      holdId: string,
      overrideHalt: boolean,
      agentId = "controller",
      runId = lease.runId
    ) =>
      waiveShipHold(fixture.root, {
        agentId,
        approvedBy: "jaay",
        holdId,
        overrideHalt,
        reason: "User approved proceeding.",
        runId,
      });
    expect(() => waive(delay.holdId, false, "someone-else")).toThrow(
      "Only the active controller"
    );
    waive(delay.holdId, false);
    expect(() => waive(halt.holdId, false)).toThrow("--override-halt");
    let report = checkShipHolds(fixture.root, { action: "merge" });
    expect(report.blocking.map((item) => item.hold.holdId)).toEqual([
      halt.holdId,
    ]);
    waive(halt.holdId, true);
    report = checkShipHolds(fixture.root, { action: "merge" });
    expect(report.clear).toBe(true);
    expect(report.holds.map((item) => item.status)).toEqual([
      "waived",
      "waived",
    ]);
    // A caller cannot name an old run to revive its waivers.
    expect(() =>
      checkShipHolds(fixture.root, { action: "merge", runId: "run-old" })
    ).toThrow("is not the active controller run");
    endLoop(fixture.root, lease.runId, "controller");
    // With the run closed its waivers no longer apply, and the next run's
    // first write drops them.
    expect(
      checkShipHolds(fixture.root, { action: "merge" }).blocking
    ).toHaveLength(2);
    const next = startLoop(fixture.root, "controller", "integrate");
    expect(
      checkShipHolds(fixture.root, { action: "merge" }).blocking
    ).toHaveLength(2);
    waive(delay.holdId, false, "controller", next.runId);
    const common = captureInventory(fixture.root).repository.commonGitDirectory;
    const stored = JSON.parse(readFileSync(shipHoldsPath(common), "utf8")) as {
      waivers: Array<{ runId: string }>;
    };
    expect(stored.waivers.map((waiver) => waiver.runId)).toEqual([next.runId]);
    endLoop(fixture.root, next.runId, "controller");
  });

  test("clear by merge evidence and persist that release", () => {
    const fixture = repository();
    const { branch } = featureWorktree(fixture, "companion");
    expect(() =>
      addShipHold(fixture.root, {
        adapter: "claude-code",
        agentId: "owner",
        reason: "Ship with the companion branch.",
        scope: "ship",
        severity: "delay",
        untilMerged: "missing-branch",
      })
    ).toThrow("does not exist");
    const hold = addShipHold(fixture.root, {
      adapter: "claude-code",
      agentId: "owner",
      reason: "Ship with the companion branch.",
      scope: "ship",
      severity: "delay",
      untilMerged: branch,
    });
    expect(checkShipHolds(fixture.root, { action: "merge" }).clear).toBe(false);

    git(fixture.root, ["merge", "--no-ff", branch, "-m", "Merge companion"]);
    const merged = checkShipHolds(fixture.root, { action: "merge" });
    expect(merged.clear).toBe(true);
    expect(merged.holds[0]).toMatchObject({ status: "satisfied" });
    expect(checkShipHolds(fixture.root).holds).toEqual([]);
    expect(() =>
      addShipHold(fixture.root, {
        adapter: "claude-code",
        agentId: "owner",
        reason: "Already merged.",
        scope: "ship",
        severity: "delay",
        untilMerged: branch,
      })
    ).toThrow("already contains");
    const common = captureInventory(fixture.root).repository.commonGitDirectory;
    const stored = JSON.parse(readFileSync(shipHoldsPath(common), "utf8")) as {
      holds: Array<{ holdId: string; release: { reason: string } | null }>;
    };
    expect(
      stored.holds.find((item) => item.holdId === hold.holdId)?.release?.reason
    ).toBe("merged");
  });

  test("publish to the remote for other clones and withdraw on release", () => {
    const fixture = repository();
    const origin = withOrigin(fixture);
    const hold = addShipHold(fixture.root, {
      adapter: "claude-code",
      agentId: "owner",
      reason: "Hold every shipment during the schema cutover.",
      scope: "ship",
      severity: "halt",
    });
    expect(() =>
      publishShipHold(fixture.root, {
        agentId: "intruder",
        holdId: hold.holdId,
      })
    ).toThrow("Only the owner");
    const published = publishShipHold(fixture.root, {
      agentId: "owner",
      holdId: hold.holdId,
    });
    expect(published.publication).toMatchObject({
      ref: `${HOLD_REF_PREFIX}${hold.holdId}`,
      remote: "origin",
      withdrawnAt: null,
    });

    const other = join(fixture.base, "other-machine");
    git(fixture.base, ["clone", origin, other]);
    const remote = checkShipHolds(other, { action: "merge" });
    expect(remote.clear).toBe(false);
    expect(remote.remote).toMatchObject({ refCount: 1, status: "read" });
    expect(remote.blocking[0]?.hold).toMatchObject({
      holdId: hold.holdId,
      owner: { agentId: "owner" },
      source: "remote",
    });
    expect(
      checkShipHolds(other, { action: "merge", localOnly: true }).clear
    ).toBe(true);

    const released = releaseShipHold(fixture.root, {
      agentId: "owner",
      holdId: hold.holdId,
    });
    expect(released.withdrawal).toMatchObject({ attempted: true, ok: true });
    expect(released.hold.publication?.withdrawnAt).not.toBeNull();
    expect(
      git(fixture.root, ["ls-remote", "origin", `${HOLD_REF_PREFIX}*`])
    ).toBe("");
    expect(checkShipHolds(other, { action: "merge" }).clear).toBe(true);
  });

  test("fail closed for a gate when published holds cannot be read", () => {
    const fixture = repository();
    git(fixture.root, [
      "remote",
      "add",
      "origin",
      join(fixture.base, "missing-origin.git"),
    ]);
    git(fixture.root, ["config", "branch.main.remote", "origin"]);
    const gate = checkShipHolds(fixture.root, {
      action: "merge",
      remote: "origin",
    });
    expect(gate.remote.status).toBe("unavailable");
    expect(gate.clear).toBe(false);
    expect(gate.nextSteps.join("\n")).toContain("--local-only");
    expect(checkShipHolds(fixture.root, { remote: "origin" }).clear).toBe(true);
  });

  test("never clear a published hold from a same-named local branch", () => {
    const fixture = repository();
    const origin = withOrigin(fixture);
    const { branch } = featureWorktree(fixture, "fix");
    git(fixture.root, ["push", "origin", branch]);
    const hold = addShipHold(fixture.root, {
      adapter: "claude-code",
      agentId: "owner",
      reason: "Hold until the fix lands.",
      scope: "ship",
      severity: "halt",
      untilMerged: branch,
    });
    publishShipHold(fixture.root, { agentId: "owner", holdId: hold.holdId });

    const other = join(fixture.base, "other-clone");
    git(fixture.base, ["clone", origin, other]);
    git(other, ["branch", branch, "origin/main"]);
    const report = checkShipHolds(other, { action: "merge" });
    expect(report.clear).toBe(false);
    expect(report.blocking[0]?.evidence?.method).toBeNull();
  });

  test("fail closed when published holds cannot be located", () => {
    const fixture = repository();
    const first = join(fixture.base, "first.git");
    const second = join(fixture.base, "second.git");
    git(fixture.base, ["init", "--bare", first]);
    git(fixture.base, ["init", "--bare", second]);
    git(fixture.root, ["remote", "add", "first", first]);
    git(fixture.root, ["remote", "add", "second", second]);
    expect(captureInventory(fixture.root).repository.targetRemote).toBeNull();
    const gate = checkShipHolds(fixture.root, { action: "merge" });
    expect(gate.remote.status).toBe("unavailable");
    expect(gate.clear).toBe(false);
    expect(
      checkShipHolds(fixture.root, { action: "merge", remote: "first" }).clear
    ).toBe(true);
  });

  test("keep a gate's decision when the merge-evidence write is busy", () => {
    const fixture = repository();
    const { branch } = featureWorktree(fixture, "busy");
    const hold = addShipHold(fixture.root, {
      adapter: "claude-code",
      agentId: "owner",
      reason: "Wait for busy.",
      scope: "ship",
      severity: "delay",
      untilMerged: branch,
    });
    git(fixture.root, ["merge", "--no-ff", branch, "-m", "Merge busy"]);
    const common = captureInventory(fixture.root).repository.commonGitDirectory;
    const lock = join(common, "simple-changes", "worktree-coordination.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      `${JSON.stringify({
        createdAt: new Date().toISOString(),
        hostname: hostname(),
        operation: "test holder",
        pid: process.pid,
        token: "busy",
      })}\n`
    );
    try {
      expect(checkShipHolds(fixture.root, { action: "merge" }).clear).toBe(
        true
      );
    } finally {
      rmSync(lock, { force: true, recursive: true });
    }
    const stored = JSON.parse(readFileSync(shipHoldsPath(common), "utf8")) as {
      holds: Array<{ holdId: string; state: string }>;
    };
    expect(
      stored.holds.find((item) => item.holdId === hold.holdId)?.state
    ).toBe("active");
  });

  test("retry a failed publish with the same commit and withdraw on release", () => {
    const fixture = repository();
    const origin = withOrigin(fixture);
    const hold = addShipHold(fixture.root, {
      adapter: "claude-code",
      agentId: "owner",
      reason: "Cutover.",
      scope: "ship",
      severity: "halt",
    });
    git(fixture.root, [
      "remote",
      "set-url",
      "origin",
      join(fixture.base, "missing.git"),
    ]);
    expect(() =>
      publishShipHold(fixture.root, { agentId: "owner", holdId: hold.holdId })
    ).toThrow("Retry hold publish");
    const common = captureInventory(fixture.root).repository.commonGitDirectory;
    const intent = (
      JSON.parse(readFileSync(shipHoldsPath(common), "utf8")) as {
        holds: Array<{
          publication: { commitSha: string; publishedAt: string | null };
        }>;
      }
    ).holds[0]?.publication;
    expect(intent?.publishedAt).toBeNull();

    git(fixture.root, ["remote", "set-url", "origin", origin]);
    const published = publishShipHold(fixture.root, {
      agentId: "owner",
      holdId: hold.holdId,
    });
    expect(published.publication?.commitSha).toBe(intent?.commitSha ?? "");
    expect(published.publication?.publishedAt).not.toBeNull();
    const released = releaseShipHold(fixture.root, {
      agentId: "owner",
      holdId: hold.holdId,
    });
    expect(released.withdrawal.ok).toBe(true);
    expect(
      git(fixture.root, ["ls-remote", "origin", `${HOLD_REF_PREFIX}*`])
    ).toBe("");
  });

  test("refuse to publish when push authorization is never", () => {
    const fixture = repository();
    withOrigin(fixture);
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify({ ...DEFAULT_POLICY, gitPushAuthorization: "never" })}\n`
    );
    const hold = addShipHold(fixture.root, {
      adapter: "claude-code",
      agentId: "owner",
      reason: "Local only.",
      scope: "ship",
      severity: "delay",
    });
    expect(() =>
      publishShipHold(fixture.root, { agentId: "owner", holdId: hold.holdId })
    ).toThrow("push authorization is never");
    expect(
      git(fixture.root, ["ls-remote", "origin", `${HOLD_REF_PREFIX}*`])
    ).toBe("");
  });

  test("treat a published payload from a newer format as unreadable", () => {
    const fixture = repository();
    withOrigin(fixture);
    writeFixture(
      fixture.base,
      "hold.json",
      `${JSON.stringify({
        createdAt: new Date().toISOString(),
        holdId: "hold-future",
        owner: { adapter: "codex", agentId: "future", ownerRef: null },
        priority: "urgent",
        reason: "From a newer client.",
        schemaVersion: 2,
        scope: "ship",
        severity: "halt",
        untilMerged: null,
      })}\n`
    );
    const blob = git(fixture.root, [
      "hash-object",
      "-w",
      join(fixture.base, "hold.json"),
    ]);
    const tree = spawnSync(["git", "-C", fixture.root, "mktree"], {
      stdin: new TextEncoder().encode(`100644 blob ${blob}\thold.json\n`),
      stdout: "pipe",
    });
    const commit = git(fixture.root, [
      "commit-tree",
      decoder.decode(tree.stdout).trim(),
      "-m",
      "future",
    ]);
    git(fixture.root, [
      "push",
      "origin",
      `${commit}:${HOLD_REF_PREFIX}hold-future`,
    ]);
    const gate = checkShipHolds(fixture.root, { action: "merge" });
    expect(gate.clear).toBe(false);
    expect(gate.remote.error).toContain("cannot read");
  });

  test("keep loop status working when the holds file is unreadable", () => {
    const fixture = repository();
    addShipHold(fixture.root, {
      adapter: "claude-code",
      agentId: "owner",
      reason: "Anything.",
      scope: "ship",
      severity: "delay",
    });
    const common = captureInventory(fixture.root).repository.commonGitDirectory;
    const document = JSON.parse(readFileSync(shipHoldsPath(common), "utf8"));
    writeFileSync(
      shipHoldsPath(common),
      `${JSON.stringify({ ...document, futureField: true })}\n`
    );
    const status = runCli(["loop", "status", "--json", "--repo", fixture.root]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).holds.error).toContain("additional");
    expect(
      runCli(["hold", "check", "--for", "merge", "--repo", fixture.root])
        .exitCode
    ).not.toBe(0);
  });

  test("gate the CLI check and loop verify with a nonzero exit", () => {
    const fixture = repository();
    const added = runCli([
      "hold",
      "add",
      "--agent-id",
      "owner",
      "--adapter",
      "claude-code",
      "--hold-scope",
      "deploy",
      "--severity",
      "delay",
      "--reason",
      "Wait for the release window.",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(added.exitCode).toBe(0);
    const { holdId } = JSON.parse(added.stdout) as { holdId: string };

    const status = runCli(["hold", "status", "--repo", fixture.root]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(holdId);
    expect(
      runCli(["hold", "check", "--for", "merge", "--repo", fixture.root])
        .exitCode
    ).toBe(0);
    const blocked = runCli([
      "hold",
      "check",
      "--for",
      "deploy",
      "--repo",
      fixture.root,
    ]);
    expect(blocked.exitCode).toBe(5);
    expect(blocked.stderr).toContain(`Shipment holds block deploy: ${holdId}`);
    expect(
      runCli(["hold", "check", "--for", "launch", "--repo", fixture.root])
        .exitCode
    ).toBe(2);

    const lease = startLoop(fixture.root, "controller", "integrate");
    const verify = runCli([
      "loop",
      "verify",
      "--run-id",
      lease.runId,
      "--for",
      "deploy",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(verify.exitCode).toBe(5);
    expect(JSON.parse(verify.stdout)).toMatchObject({
      holds: { action: "deploy", clear: false },
      ok: true,
    });
    const status2 = runCli([
      "loop",
      "status",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(JSON.parse(status2.stdout).holds.active).toHaveLength(1);
    expect(
      runCli([
        "hold",
        "waive",
        "--run-id",
        lease.runId,
        "--agent-id",
        "controller",
        "--hold-id",
        holdId,
        "--approved-by",
        "jaay",
        "--reason",
        "Release window opened early.",
        "--repo",
        fixture.root,
      ]).exitCode
    ).toBe(0);
    expect(
      runCli([
        "loop",
        "verify",
        "--run-id",
        lease.runId,
        "--for",
        "deploy",
        "--repo",
        fixture.root,
      ]).exitCode
    ).toBe(0);
    endLoop(fixture.root, lease.runId, "controller");
  });

  test("release a claim with a ready receipt through the CLI", () => {
    const fixture = repository();
    const { path } = featureWorktree(fixture, "cli");
    const claim = claimWorktree(path, "author", path, "cursor-cloud");
    const inputPath = join(fixture.base, "ready.json");
    writeFileSync(inputPath, `${JSON.stringify(READY_INPUT)}\n`);
    const released = runCli([
      "worktree",
      "release",
      "--agent-id",
      "author",
      "--claim-id",
      claim.claimId,
      "--ready-receipt",
      inputPath,
      "--json",
      "--repo",
      path,
    ]);
    expect(released.exitCode).toBe(0);
    expect(JSON.parse(released.stdout)).toMatchObject({
      claim: { state: "released" },
      receipt: { owner: { adapter: "cursor-cloud", agentId: "author" } },
    });
    const status = runCli([
      "worktree",
      "status",
      "--json",
      "--repo",
      fixture.root,
    ]);
    expect(JSON.parse(status.stdout).readyWork).toMatchObject([
      { freshness: "current", receipt: { claimId: claim.claimId } },
    ]);
  });
});
