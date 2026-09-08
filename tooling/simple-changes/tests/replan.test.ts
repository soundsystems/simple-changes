import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256Json } from "../../../skills/simple-changes/scripts/lib/hash.ts";
import {
  captureInventory,
  compareSnapshots,
} from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  type LoopReplanRequest,
  loopLeasePath,
  loopLockPath,
  loopReplanStatus,
  recordShipmentScope,
  replanLoop,
  startLoop,
  withLoopStateLock,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { buildPreviewPlan } from "../../../skills/simple-changes/scripts/lib/planner.ts";
import type { LoopLease } from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  withWorktreeCoordinationLock,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(60_000);
const fixtures: TestRepository[] = [];
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
});

const frozenFixture = (active = true) => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  const lease = startLoop(fixture.root, "controller", "ship");
  const inventory = captureInventory(fixture.root);
  recordShipmentScope(
    fixture.root,
    lease.runId,
    "controller",
    buildPreviewPlan(
      inventory,
      inventory,
      compareSnapshots(inventory, inventory)
    )
  );
  const common = inventory.repository.commonGitDirectory;
  const activePath = loopLeasePath(common);
  const stored = JSON.parse(readFileSync(activePath, "utf8")) as LoopLease;
  stored.shipmentScopeFrozenAt = new Date().toISOString();
  if (!active && stored.controller) {
    stored.controller.status = "relinquished";
    stored.controller.relinquishedAt = stored.shipmentScopeFrozenAt;
  }
  writeFileSync(activePath, `${JSON.stringify(stored, null, 2)}\n`);
  const observe = (): LoopReplanRequest => {
    const status = loopReplanStatus(fixture.root);
    return {
      agentId: status.agentId,
      approvedBy: "fixture-user",
      manifestDigest: status.manifestDigest,
      reason: "Replan the exact frozen inventory without cleanup",
      runId: status.runId,
      statusDigest: status.statusDigest,
    };
  };
  const attempt = (request: LoopReplanRequest) =>
    join(
      common,
      "simple-changes",
      "history",
      lease.runId,
      `replan-${sha256Json(request)}`
    );
  return { ...fixture, activePath, attempt, common, observe };
};

test.each([true, false])(
  "replan preserves unique commits, dirty index and claimed work for active=%s",
  (active) => {
    const fixture = frozenFixture(active);
    const author = join(fixture.base, "author");
    git(fixture.root, ["worktree", "add", "-b", "unique", author]);
    writeFixture(author, "feature.txt", "unique work\n");
    git(author, ["add", "."]);
    git(author, ["commit", "-m", "Unique feature"]);
    claimWorktree(author, "author", author, "codex");
    writeFixture(author, "late.txt", "claim intentionally stale\n");
    writeFixture(fixture.root, "primary.txt", "preserve staged\n");
    git(fixture.root, ["add", "primary.txt"]);
    const before = captureInventory(fixture.root);
    const refs = git(fixture.root, ["show-ref"]);
    const index = readFileSync(join(fixture.common, "index"));
    const leaseBytes = readFileSync(fixture.activePath);
    const claimsPath = join(
      fixture.common,
      "simple-changes",
      "worktree-coordination",
      "state.json"
    );
    const claimsBytes = readFileSync(claimsPath);
    const request = fixture.observe();
    const receipt = replanLoop(fixture.root, request);
    expect(receipt.outcome).toBe("replanned");
    expect(receipt.lease.shipmentScope?.plan.units).toHaveLength(0);
    expect(
      readFileSync(join(fixture.attempt(request), "replan-lease.json"))
    ).toEqual(leaseBytes);
    expect(existsSync(fixture.activePath)).toBe(false);
    expect(captureInventory(fixture.root).baselineDigest).toBe(
      before.baselineDigest
    );
    expect(git(fixture.root, ["show-ref"])).toBe(refs);
    expect(readFileSync(claimsPath)).toEqual(claimsBytes);
    expect(readFileSync(join(fixture.common, "index"))).toEqual(index);
    expect(replanLoop(fixture.root, request)).toEqual(receipt);
    const successor = startLoop(fixture.root, "next-controller", "ship");
    const successorBytes = readFileSync(fixture.activePath);
    expect(successor.runId).not.toBe(request.runId);
    expect(replanLoop(fixture.root, request)).toEqual(receipt);
    expect(readFileSync(fixture.activePath)).toEqual(successorBytes);
  }
);

test("wrong actor and stale inventory approval cannot clear the lease", () => {
  const fixture = frozenFixture();
  const request = fixture.observe();
  const before = readFileSync(fixture.activePath);
  expect(() =>
    replanLoop(fixture.root, { ...request, agentId: "other" })
  ).toThrow("exact owner");
  writeFixture(fixture.root, "later.txt", "new work\n");
  expect(() => replanLoop(fixture.root, request)).toThrow("digest changed");
  expect(readFileSync(fixture.activePath)).toEqual(before);
});

test("held state and coordination locks block replan without recovering or deleting locks", () => {
  const fixture = frozenFixture();
  const request = fixture.observe();
  const before = readFileSync(fixture.activePath);
  withLoopStateLock(fixture.common, "fixture guarded child", () => {
    expect(() => replanLoop(fixture.root, request)).toThrow();
    expect(existsSync(loopLockPath(fixture.common))).toBe(true);
  });
  withWorktreeCoordinationLock(fixture.common, "fixture coordination", () => {
    expect(() => replanLoop(fixture.root, request)).toThrow();
  });
  expect(readFileSync(fixture.activePath)).toEqual(before);
  expect(existsSync(fixture.attempt(request))).toBe(false);
});

test("crash before rename retries exactly and fresh approval survives intervening work", () => {
  const fixture = frozenFixture();
  const first = fixture.observe();
  const receipt = replanLoop(fixture.root, first);
  const archive = join(fixture.attempt(first), "replan-lease.json");
  writeFileSync(fixture.activePath, readFileSync(archive));
  rmSync(archive);
  writeFixture(fixture.root, "later.txt", "concurrent author work\n");
  expect(() => replanLoop(fixture.root, first)).toThrow("exact inventory");
  const second = fixture.observe();
  expect(second.statusDigest).not.toBe(first.statusDigest);
  expect(replanLoop(fixture.root, second).outcome).toBe("replanned");
  expect(
    readFileSync(join(fixture.attempt(first), "replan.json"), "utf8")
  ).toContain(receipt.fullLeaseDigest);
  const next = startLoop(fixture.root, "next", "ship");
  const bytes = readFileSync(fixture.activePath);
  expect(next.runId).not.toBe(first.runId);
  expect(() => replanLoop(fixture.root, first)).toThrow();
  expect(readFileSync(fixture.activePath)).toEqual(bytes);
  expect(replanLoop(fixture.root, second).outcome).toBe("replanned");
});

test("exact intent before rename can complete, divergent retry cannot", () => {
  const fixture = frozenFixture();
  const request = fixture.observe();
  const result = replanLoop(fixture.root, request);
  const archive = join(fixture.attempt(request), "replan-lease.json");
  writeFileSync(fixture.activePath, readFileSync(archive));
  rmSync(archive);
  expect(replanLoop(fixture.root, request)).toEqual(result);
  expect(() =>
    replanLoop(fixture.root, { ...request, approvedBy: "different-user" })
  ).toThrow();
});

test.each(["intent", "archive", "directory"])(
  "rejects dangling symlink %s",
  (kind) => {
    const fixture = frozenFixture();
    const request = fixture.observe();
    const directory = fixture.attempt(request);
    const before = readFileSync(fixture.activePath);
    if (kind === "directory") {
      mkdirSync(join(directory, ".."), { recursive: true });
      symlinkSync(join(fixture.base, "missing"), directory);
    } else {
      mkdirSync(directory, { recursive: true });
      symlinkSync(
        join(fixture.base, "missing"),
        join(directory, kind === "intent" ? "replan.json" : "replan-lease.json")
      );
    }
    expect(() => replanLoop(fixture.root, request)).toThrow();
    expect(readFileSync(fixture.activePath)).toEqual(before);
  }
);

test("archive corruption and unexpected intent fields fail closed", () => {
  const fixture = frozenFixture();
  const request = fixture.observe();
  replanLoop(fixture.root, request);
  const intent = join(fixture.attempt(request), "replan.json");
  const bytes = readFileSync(intent);
  const corrupt = JSON.parse(bytes.toString());
  corrupt.extra = true;
  writeFileSync(intent, JSON.stringify(corrupt));
  expect(() => replanLoop(fixture.root, request)).toThrow();
  writeFileSync(intent, bytes);
  writeFileSync(join(fixture.attempt(request), "replan-lease.json"), "{}\n");
  expect(() => replanLoop(fixture.root, request)).toThrow("integrity");
});

test.each(["manifest", "claim", "target"])(
  "rejects stale %s evidence independently",
  (kind) => {
    const fixture = frozenFixture();
    const request = fixture.observe();
    if (kind === "manifest") {
      const lease = JSON.parse(readFileSync(fixture.activePath, "utf8"));
      lease.mode = "sweep";
      writeFileSync(fixture.activePath, JSON.stringify(lease));
    } else if (kind === "claim") {
      claimWorktree(fixture.root, "controller", fixture.root, "codex");
    } else {
      git(fixture.root, ["commit", "--allow-empty", "-m", "Target advanced"]);
    }
    const bytes = readFileSync(fixture.activePath);
    expect(() => replanLoop(fixture.root, request)).toThrow("digest changed");
    expect(readFileSync(fixture.activePath)).toEqual(bytes);
  }
);

test.each(["unfrozen", "preparation", "outcome", "emergency"])(
  "refuses %s state without touching evidence",
  (kind) => {
    const fixture = frozenFixture();
    const lease = JSON.parse(
      readFileSync(fixture.activePath, "utf8")
    ) as LoopLease;
    if (kind === "unfrozen") {
      lease.shipmentScopeFrozenAt = null;
    } else if (kind === "preparation") {
      lease.preparations.push({
        agentId: "pending",
        baseRevision: lease.targetRevision,
        branch: "pending",
        createdAt: new Date().toISOString(),
        path: join(fixture.base, "pending"),
        purpose: "unfinished author",
      });
    } else if (kind === "outcome") {
      lease.shipmentOutcome = {
        receipt: {
          additionalPaths: [],
          runId: lease.runId,
          schemaVersion: 1,
          targetRevision: lease.targetRevision,
          units: [],
        },
        receiptDigest: "a".repeat(64),
        recordedAt: new Date().toISOString(),
      };
    } else {
      lease.emergencyShipping = {
        artifactEquivalenceProven: false,
        authoritySource: null,
        breakGlassAuthorized: false,
        candidateArtifactId: null,
        candidateRevision: lease.targetRevision,
        candidateVerifiedHealthy: false,
        canonicalArtifactId: null,
        canonicalRevision: null,
        changelogReconciled: false,
        cleanupCompleted: false,
        deployedArtifactId: null,
        deployedRevision: null,
        evidence: ["urgency-language"],
        finalVerificationPassed: false,
        focusedChecksPassed: false,
        independentReview: "pending",
        mergeCompleted: false,
        mode: "expedited",
        previousProductionRevision: null,
        productionAuthorized: false,
        redeployDecision: "pending",
        rollbackAnchorRecorded: false,
        rollbackSupported: false,
        status: "ready",
      };
    }
    writeFileSync(fixture.activePath, JSON.stringify(lease));
    const request = fixture.observe();
    const bytes = readFileSync(fixture.activePath);
    expect(() => replanLoop(fixture.root, request)).toThrow("exact owner");
    expect(readFileSync(fixture.activePath)).toEqual(bytes);
    expect(existsSync(fixture.attempt(request))).toBe(false);
  }
);
