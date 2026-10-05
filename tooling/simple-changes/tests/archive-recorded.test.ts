import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import {
  sha256,
  sha256Json,
} from "../../../skills/simple-changes/scripts/lib/hash.ts";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  type LoopReplanRequest,
  loopLeasePath,
  loopLockPath,
  loopManifestDigest,
  loopReplanStatus,
  loopStatus,
  replanLoop,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

const ARCHIVE_RECORDED_FLAG = { archiveRecordedOutcome: true } as const;

// Ported from the Thoronath fork's recorded-recovery tests: Site Secure keeps
// `loop-archive-recorded` records on disk that this runtime must still read.
setDefaultTimeout(60_000);
const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const fixtures: TestRepository[] = [];
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
});

const recordedFixture = (relinquished = false) => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  writeFixture(fixture.root, "delivered.txt", "delivered\n");
  git(fixture.root, ["add", "delivered.txt"]);
  git(fixture.root, ["commit", "-m", "Delivered"]);
  const lease = startLoop(fixture.root, "owner", "queue");
  const common = captureInventory(fixture.root).repository.commonGitDirectory;
  const leasePath = loopLeasePath(common);
  const receipt = {
    additionalPaths: [
      {
        classification: "external-target-change" as const,
        entry: `100644:blob:${git(fixture.root, ["rev-parse", "HEAD:delivered.txt"])}`,
        path: "delivered.txt",
        reason: "Fixture historical delivery",
      },
    ],
    runId: lease.runId,
    schemaVersion: 1 as const,
    targetRevision: git(fixture.root, ["rev-parse", "HEAD"]),
    units: [],
  };
  const frozenAt = new Date().toISOString();
  lease.shipmentScopeFrozenAt = frozenAt;
  lease.shipmentOutcome = {
    receipt,
    receiptDigest: sha256Json(receipt),
    recordedAt: frozenAt,
  };
  if (relinquished && lease.controller) {
    lease.controller.status = "relinquished";
    lease.controller.relinquishedAt = frozenAt;
  }
  const save = () => writeFileSync(leasePath, JSON.stringify(lease));
  save();
  writeFixture(fixture.root, "user.txt", "unrelated user work\n");
  const request = (): LoopReplanRequest => {
    const status = loopReplanStatus(fixture.root);
    return {
      agentId: status.agentId,
      approvedBy: "user",
      archiveRecordedOutcome: true,
      manifestDigest: status.manifestDigest,
      reason: "Archive bookkeeping only",
      runId: status.runId,
      statusDigest: status.statusDigest,
    };
  };
  const attempt = (input: LoopReplanRequest) =>
    join(
      common,
      "simple-changes",
      "history",
      lease.runId,
      `archive-recorded-${sha256Json(input)}`
    );
  return { ...fixture, attempt, common, lease, leasePath, request, save };
};

test("archives exact historical evidence while preserving files and refs; retry leaves successor alone", () => {
  const fixture = recordedFixture();
  const request = fixture.request();
  const bytes = readFileSync(fixture.leasePath, "utf8");
  const head = git(fixture.root, ["rev-parse", "HEAD"]);
  const status = git(fixture.root, ["status", "--porcelain"]);
  const record = replanLoop(fixture.root, request);
  expect(record.outcome).toBe("archived-unfinished");
  expect(record.kind).toBe("loop-archive-recorded");
  expect(record.lease.shipmentOutcome).toEqual(fixture.lease.shipmentOutcome);
  expect(
    readFileSync(join(fixture.attempt(request), "replan-lease.json"), "utf8")
  ).toBe(bytes);
  expect(existsSync(fixture.leasePath)).toBe(false);
  expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(head);
  expect(git(fixture.root, ["status", "--porcelain"])).toBe(status);
  const next = startLoop(fixture.root, "owner", "queue");
  const nextBytes = readFileSync(fixture.leasePath, "utf8");
  expect(replanLoop(fixture.root, request)).toEqual(record);
  expect(readFileSync(fixture.leasePath, "utf8")).toBe(nextBytes);
  expect(next.runId).not.toBe(fixture.lease.runId);
});

test("keeps the record shape and directory that earlier fork records use", () => {
  const fixture = recordedFixture();
  const request = fixture.request();
  replanLoop(fixture.root, request);
  const intent = JSON.parse(
    readFileSync(join(fixture.attempt(request), "replan.json"), "utf8")
  ) as Record<string, unknown>;
  expect(Object.keys(intent).sort()).toEqual([
    "archivedAt",
    "fullLeaseDigest",
    "kind",
    "lease",
    "observation",
    "outcome",
    "request",
    "schemaVersion",
  ]);
  expect(intent.kind).toBe("loop-archive-recorded");
  expect(intent.outcome).toBe("archived-unfinished");
  // Retries compare the stored request byte for byte, so its key order is
  // part of the contract.
  expect(Object.keys(intent.request as object)).toEqual([
    "archiveRecordedOutcome",
    "agentId",
    "approvedBy",
    "manifestDigest",
    "reason",
    "runId",
    "statusDigest",
  ]);
});

test("reads back a record an earlier fork wrote around a lease with its opening digest", () => {
  const fixture = recordedFixture();
  // The Thoronath fork's leases carry `openingScopeInvariantDigest`, and Site
  // Secure's archive-recorded records embed such leases. Rebuild one exactly
  // as that fork wrote it, then retry its request with this runtime.
  const { observation } = loopReplanStatus(fixture.root);
  const lease = {
    ...fixture.lease,
    openingScopeInvariantDigest: "a".repeat(64),
  } as LoopLease;
  const bytes = JSON.stringify(lease);
  // The fork stored the flag first; retries compare the request's bytes.
  const request: LoopReplanRequest = {
    ...ARCHIVE_RECORDED_FLAG,
    agentId: lease.ownerAgentId,
    approvedBy: "user",
    manifestDigest: loopManifestDigest(lease),
    reason: "Archive bookkeeping only",
    runId: lease.runId,
    statusDigest: sha256Json(observation),
  };
  const record = {
    archivedAt: new Date().toISOString(),
    fullLeaseDigest: sha256(bytes),
    kind: "loop-archive-recorded",
    lease,
    observation,
    outcome: "archived-unfinished",
    request,
    schemaVersion: 1,
  };
  const directory = fixture.attempt(request);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "replan.json"),
    `${JSON.stringify(record, null, 2)}\n`
  );
  writeFileSync(join(directory, "replan-lease.json"), bytes);
  rmSync(fixture.leasePath);
  expect(replanLoop(fixture.root, request)).toEqual(
    JSON.parse(JSON.stringify(record))
  );
});

test("ordinary replan still refuses a historical outcome and status names archive-recorded", () => {
  const fixture = recordedFixture();
  const { archiveRecordedOutcome: _archive, ...request } = fixture.request();
  expect(() => replanLoop(fixture.root, request)).toThrow("exact owner");
  expect(existsSync(fixture.leasePath)).toBe(true);
  const status = loopReplanStatus(fixture.root);
  expect(status.nextCommand).toContain("loop archive-recorded");
  expect(status.nextCommand).toContain(
    `--status-digest ${status.statusDigest}`
  );
});

test("a relinquished run with a recorded outcome is pointed at archive-recorded", () => {
  const fixture = recordedFixture(true);
  const { guidance } = loopStatus(fixture.root);
  expect(guidance.headline).toContain("`loop archive-recorded`");
  expect(guidance.nextCommands).toContain(
    "simple-changes loop replan-status --json"
  );
  expect(
    guidance.nextCommands.some((command) =>
      command.startsWith(
        `simple-changes loop archive-recorded --run-id ${fixture.lease.runId} --agent-id owner`
      )
    )
  ).toBe(true);
});

test("a run without a recorded outcome keeps the ordinary replan command", () => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  startLoop(fixture.root, "owner", "ship");
  expect(loopReplanStatus(fixture.root).nextCommand).toContain(
    "simple-changes loop replan --run-id"
  );
});

test.each([
  "approval",
  "owner",
  "inventory",
  "digest",
  "run",
  "empty",
  "tree",
  "ancestry",
  "missing",
])("refuses invalid %s and preserves the active record", (condition) => {
  const fixture = recordedFixture();
  const outcome = fixture.lease.shipmentOutcome;
  const entry = outcome?.receipt.additionalPaths[0];
  if (!(outcome && entry)) {
    throw new Error("Fixture outcome missing");
  }
  if (condition === "digest") {
    outcome.receiptDigest = "0".repeat(64);
  } else if (condition === "run") {
    outcome.receipt.runId = "run-another";
    outcome.receiptDigest = sha256Json(outcome.receipt);
  } else if (condition === "empty") {
    outcome.receipt.additionalPaths = [];
    outcome.receiptDigest = sha256Json(outcome.receipt);
  } else if (condition === "tree") {
    entry.entry = `100644:blob:${"0".repeat(40)}`;
    outcome.receiptDigest = sha256Json(outcome.receipt);
  } else if (condition === "ancestry") {
    outcome.receipt.targetRevision = "0".repeat(40);
    outcome.receiptDigest = sha256Json(outcome.receipt);
  } else if (condition === "missing") {
    Reflect.deleteProperty(fixture.lease, "shipmentOutcome");
  }
  fixture.save();
  const request = fixture.request();
  if (condition === "approval") {
    request.approvedBy = "";
  } else if (condition === "owner") {
    request.agentId = "other";
  } else if (condition === "inventory") {
    writeFixture(fixture.root, "late.txt", "new work\n");
  }
  const bytes = readFileSync(fixture.leasePath, "utf8");
  expect(() => replanLoop(fixture.root, request)).toThrow();
  expect(readFileSync(fixture.leasePath, "utf8")).toBe(bytes);
  expect(existsSync(fixture.attempt(request))).toBe(false);
});

test("refuses an active integration lock without changing its owner", () => {
  const fixture = recordedFixture();
  const request = fixture.request();
  const lock = loopLockPath(fixture.common);
  mkdirSync(lock);
  const ownerPath = join(lock, "owner.json");
  const owner = JSON.stringify({
    childStarting: true,
    createdAt: new Date().toISOString(),
    hostname: hostname(),
    operation: "guarded deployment",
    pid: process.pid,
    token: "active-test",
  });
  writeFileSync(ownerPath, owner);
  const bytes = readFileSync(fixture.leasePath, "utf8");
  expect(() => replanLoop(fixture.root, request)).toThrow();
  expect(readFileSync(fixture.leasePath, "utf8")).toBe(bytes);
  expect(readFileSync(ownerPath, "utf8")).toBe(owner);
});

test("refuses an incomplete preparation without changing its record", () => {
  const fixture = recordedFixture();
  fixture.lease.preparations.push({
    agentId: "author",
    baseRevision: git(fixture.root, ["rev-parse", "HEAD"]),
    branch: "feature",
    createdAt: new Date().toISOString(),
    path: join(fixture.root, "pending"),
    purpose: "pending author",
  } as LoopLease["preparations"][number]);
  fixture.save();
  const request = fixture.request();
  const bytes = readFileSync(fixture.leasePath, "utf8");
  expect(() => replanLoop(fixture.root, request)).toThrow();
  expect(readFileSync(fixture.leasePath, "utf8")).toBe(bytes);
});

const runCli = (args: string[]) =>
  spawnSync([process.execPath, cliPath, ...args], {
    env: { ...process.env, SIMPLE_CHANGES_SKILL_ROOTS: "" },
    stderr: "pipe",
    stdout: "pipe",
  });

test("the CLI archives with the same flags as replan and never reports delivery", () => {
  const fixture = recordedFixture();
  // Observe and archive through the same CLI environment, as an agent would.
  const observed = runCli([
    "loop",
    "replan-status",
    "--json",
    "--repo",
    fixture.root,
  ]);
  expect(observed.exitCode).toBe(0);
  const status = JSON.parse(decoder.decode(observed.stdout)) as {
    agentId: string;
    manifestDigest: string;
    nextCommand: string;
    runId: string;
    statusDigest: string;
  };
  expect(status.nextCommand).toContain("loop archive-recorded");
  const result = runCli([
    "loop",
    "archive-recorded",
    "--run-id",
    status.runId,
    "--agent-id",
    status.agentId,
    "--manifest-digest",
    status.manifestDigest,
    "--status-digest",
    status.statusDigest,
    "--approved-by",
    "user",
    "--reason",
    "Archive bookkeeping only",
    "--repo",
    fixture.root,
  ]);
  expect(decoder.decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  const output = decoder.decode(result.stdout);
  expect(output).toContain(`Archived ${status.runId} (archived-unfinished)`);
  expect(output).toContain("did not ship or clean work");
  expect(existsSync(fixture.leasePath)).toBe(false);
});
