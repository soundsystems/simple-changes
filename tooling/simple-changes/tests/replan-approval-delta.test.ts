import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256Json } from "../../../skills/simple-changes/scripts/lib/hash.ts";
import { captureInventory } from "../../../skills/simple-changes/scripts/lib/inventory.ts";
import {
  type LoopReplanRequest,
  loopLeasePath,
  loopReplanStatus,
  replanLoop,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  describeReplanDelta,
  type ReplanObservation,
  replanApprovalDelta,
  replanDeltaAccepted,
} from "../../../skills/simple-changes/scripts/lib/replan-approval-delta.ts";
import type {
  LoopLease,
  WorktreeClaim,
  WorktreeCoordinationDocument,
  WorktreeCoordinationEvent,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  claimWorktree,
  releaseHandoffWorktreeClaim,
  releaseWorktreeClaim,
} from "../../../skills/simple-changes/scripts/lib/worktree-coordination.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(120_000);
const fixtures: TestRepository[] = [];
afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
});

const OWNER = "author-agent";

// A frozen run plus a concurrent author's claimed checkout, approved for
// replan before the author releases its claim.
const racedFixture = () => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  const lease = startLoop(fixture.root, "controller", "ship");
  const common = captureInventory(fixture.root).repository.commonGitDirectory;
  const activePath = loopLeasePath(common);
  const stored = JSON.parse(readFileSync(activePath, "utf8")) as LoopLease;
  stored.shipmentScopeFrozenAt = new Date().toISOString();
  writeFileSync(activePath, `${JSON.stringify(stored, null, 2)}\n`);
  const author = join(fixture.base, "author");
  git(fixture.root, ["worktree", "add", "-b", "author-work", author]);
  writeFixture(author, "feature.txt", "reviewed work\n");
  git(author, ["add", "."]);
  git(author, ["commit", "-m", "Reviewed feature"]);
  const claim = claimWorktree(author, OWNER, author, "fixture");
  const statePath = join(
    common,
    "simple-changes",
    "worktree-coordination",
    "state.json"
  );
  const status = loopReplanStatus(fixture.root);
  const request: LoopReplanRequest = {
    agentId: status.agentId,
    approvedBy: "fixture-user",
    manifestDigest: status.manifestDigest,
    reason: "Replan while a concurrent author finishes",
    runId: status.runId,
    statusDigest: status.statusDigest,
  };
  const attempt = join(
    common,
    "simple-changes",
    "history",
    lease.runId,
    `replan-${sha256Json(request)}`
  );
  const observationPath = join(
    common,
    "simple-changes",
    "history",
    lease.runId,
    "status-observations",
    `${status.statusDigest}.json`
  );
  const readState = () =>
    JSON.parse(readFileSync(statePath, "utf8")) as WorktreeCoordinationDocument;
  const writeState = (document: WorktreeCoordinationDocument) =>
    writeFileSync(statePath, `${JSON.stringify(document, null, 2)}\n`);
  return {
    ...fixture,
    activePath,
    attempt,
    author,
    claim,
    common,
    observationPath,
    readState,
    request,
    statePath,
    writeState,
  };
};

type Raced = ReturnType<typeof racedFixture>;

const ownerRelease = (fixture: Raced) =>
  releaseWorktreeClaim(fixture.author, OWNER, fixture.claim.claimId);

// Refuses with the exact delta, and changes nothing.
const expectRefusedDelta = (fixture: Raced, ...expected: string[]) => {
  const lease = readFileSync(fixture.activePath);
  const state = readFileSync(fixture.statePath);
  let message = "";
  try {
    replanLoop(fixture.root, fixture.request);
  } catch (error) {
    ({ message } = error as Error);
  }
  expect(message).toContain("digest changed");
  expect(message).toContain("exact delta from the approved observation");
  expect(message).toContain("Approved coordination digest");
  expect(message).toContain("loop replan-status --json");
  for (const text of expected) {
    expect(message).toContain(text);
  }
  expect(readFileSync(fixture.activePath)).toEqual(lease);
  expect(readFileSync(fixture.statePath)).toEqual(state);
  expect(existsSync(fixture.attempt)).toBe(false);
  return message;
};

test("replan-status records the observation it showed under its digest", () => {
  const fixture = racedFixture();
  const stored = JSON.parse(readFileSync(fixture.observationPath, "utf8"));
  expect(sha256Json(stored)).toBe(fixture.request.statusDigest);
  // Observing again is idempotent and repairs a file that no longer hashes
  // to its name.
  writeFileSync(fixture.observationPath, "{}\n");
  expect(loopReplanStatus(fixture.root).statusDigest).toBe(
    fixture.request.statusDigest
  );
  expect(
    sha256Json(JSON.parse(readFileSync(fixture.observationPath, "utf8")))
  ).toBe(fixture.request.statusDigest);
});

test.each(["owner-release", "handoff"] as const)(
  "an owner's %s with exactly the approved state keeps the approval and records both digests",
  (reason) => {
    const fixture = racedFixture();
    if (reason === "owner-release") {
      ownerRelease(fixture);
    } else {
      expect(releaseHandoffWorktreeClaim(fixture.author, OWNER)?.claimId).toBe(
        fixture.claim.claimId
      );
    }
    const state = readFileSync(fixture.statePath);
    const result = replanLoop(fixture.root, fixture.request);
    expect(result.outcome).toBe("replanned");
    expect(existsSync(fixture.activePath)).toBe(false);
    // Replan itself never touches claims.
    expect(readFileSync(fixture.statePath)).toEqual(state);
    const delta = result.approvalDelta;
    expect(delta?.approvedStatusDigest).toBe(fixture.request.statusDigest);
    expect(delta?.approvedCoordinationDigest).not.toBe(
      delta?.currentCoordinationDigest
    );
    expect(delta?.currentCoordinationDigest).toBe(
      sha256Json(JSON.parse(state.toString()))
    );
    expect(delta?.acceptedReleases).toEqual([
      expect.objectContaining({
        branch: "author-work",
        claimId: fixture.claim.claimId,
        ownerAgentId: OWNER,
        path: fixture.author,
        releaseReason: reason,
      }),
    ]);
    const recorded = JSON.parse(
      readFileSync(join(fixture.attempt, "replan-approval-delta.json"), "utf8")
    );
    expect(recorded).toEqual(delta);
    // The intent keeps its strict format and the approved observation, so
    // older runtimes still validate it.
    const intent = JSON.parse(
      readFileSync(join(fixture.attempt, "replan.json"), "utf8")
    );
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
    expect(sha256Json(intent.observation)).toBe(fixture.request.statusDigest);
    expect(sha256Json(intent.observation.coordination)).toBe(
      delta?.approvedCoordinationDigest ?? ""
    );
    // A completed retry returns the same receipt and never removes a successor.
    expect(replanLoop(fixture.root, fixture.request)).toEqual(result);
    startLoop(fixture.root, "next-controller", "ship");
    const successor = readFileSync(fixture.activePath);
    expect(replanLoop(fixture.root, fixture.request)).toEqual(result);
    expect(readFileSync(fixture.activePath)).toEqual(successor);
  }
);

test("a release with different evidence than the approved checkout refuses", () => {
  const fixture = racedFixture();
  ownerRelease(fixture);
  const document = fixture.readState();
  const claim = document.claims.find(
    (item) => item.claimId === fixture.claim.claimId
  );
  if (!claim) {
    throw new Error("missing claim");
  }
  claim.headSha = git(fixture.root, ["rev-parse", "HEAD"]).trim();
  fixture.writeState(document);
  expectRefusedDelta(fixture, "release recorded branch author-work, head");
});

test("a release that did not record the checkout's state refuses", () => {
  const fixture = racedFixture();
  ownerRelease(fixture);
  const document = fixture.readState();
  const event = document.events.at(-1);
  if (!event) {
    throw new Error("missing event");
  }
  event.eventId = "event-plain-release";
  fixture.writeState(document);
  expectRefusedDelta(fixture, "without recording the checkout's state");
});

test("a release by another agent refuses", () => {
  const fixture = racedFixture();
  ownerRelease(fixture);
  const document = fixture.readState();
  const event = document.events.at(-1);
  if (!event) {
    throw new Error("missing event");
  }
  event.actorAgentId = "other-agent";
  fixture.writeState(document);
  expectRefusedDelta(fixture, "was released by other-agent, not by its owner");
});

test("a new claim refuses", () => {
  const fixture = racedFixture();
  const other = join(fixture.base, "other");
  git(fixture.root, ["worktree", "add", "-b", "other-work", other]);
  // A new checkout changes the inventory; approve that, then claim it.
  const status = loopReplanStatus(fixture.root);
  const request = { ...fixture.request, statusDigest: status.statusDigest };
  claimWorktree(other, "other-agent", other, "fixture");
  const lease = readFileSync(fixture.activePath);
  expect(() => replanLoop(fixture.root, request)).toThrow("New claim claim-");
  expect(readFileSync(fixture.activePath)).toEqual(lease);
});

test("an owner release beside a new claim still refuses", () => {
  const fixture = racedFixture();
  ownerRelease(fixture);
  claimWorktree(fixture.root, "controller", fixture.root, "fixture");
  const message = expectRefusedDelta(
    fixture,
    "New claim",
    `on ${fixture.root}`,
    "Verified owner release:"
  );
  expect(message).toContain(fixture.claim.claimId);
});

test("a takeover refuses", () => {
  const fixture = racedFixture();
  const document = fixture.readState();
  const claim = document.claims.find(
    (item) => item.claimId === fixture.claim.claimId
  );
  if (!claim) {
    throw new Error("missing claim");
  }
  const now = new Date().toISOString();
  document.claims = [
    { ...claim, releaseReason: "takeover", state: "released", updatedAt: now },
    {
      ...claim,
      claimId: "claim-taken-over",
      createdAt: now,
      owner: { ...claim.owner, agentId: "taker" },
      updatedAt: now,
    },
  ];
  document.events.push(
    {
      actorAgentId: "taker",
      claimId: claim.claimId,
      createdAt: now,
      eventId: "event-takeover-release",
      state: "released",
    },
    {
      actorAgentId: "taker",
      claimId: "claim-taken-over",
      createdAt: now,
      eventId: "event-takeover-claim",
      state: "active",
    }
  );
  fixture.writeState(document);
  expectRefusedDelta(
    fixture,
    "(reason takeover)",
    "New claim claim-taken-over"
  );
});

test("a reassigned claim refuses", () => {
  const fixture = racedFixture();
  ownerRelease(fixture);
  const document = fixture.readState();
  const claim = document.claims.find(
    (item) => item.claimId === fixture.claim.claimId
  );
  if (!claim) {
    throw new Error("missing claim");
  }
  claim.owner = { ...claim.owner, agentId: "other-agent" };
  fixture.writeState(document);
  expectRefusedDelta(fixture, "changed owner, so it was reassigned");
});

test("a source change refuses even with a verified release", () => {
  const fixture = racedFixture();
  ownerRelease(fixture);
  writeFixture(fixture.root, "later.txt", "new work\n");
  expectRefusedDelta(
    fixture,
    "The source inventory digest changed",
    "Verified owner release:"
  );
});

test("a target move refuses even with a verified release", () => {
  const fixture = racedFixture();
  ownerRelease(fixture);
  git(fixture.root, ["commit", "--allow-empty", "-m", "Target advanced"]);
  expectRefusedDelta(fixture, "The target moved from");
});

test("an approved observation that is missing or altered gives no delta", () => {
  const fixture = racedFixture();
  ownerRelease(fixture);
  const lease = readFileSync(fixture.activePath);
  const bytes = readFileSync(fixture.observationPath);
  rmSync(fixture.observationPath);
  expect(() => replanLoop(fixture.root, fixture.request)).toThrow(
    "approved observation is not on record"
  );
  const altered = JSON.parse(bytes.toString());
  altered.coordination.claims = [];
  writeFileSync(fixture.observationPath, JSON.stringify(altered));
  expect(() => replanLoop(fixture.root, fixture.request)).toThrow(
    "approved observation is not on record"
  );
  expect(readFileSync(fixture.activePath)).toEqual(lease);
  expect(existsSync(fixture.attempt)).toBe(false);
});

test("a crash before the move retries the recorded delta, and a later change refuses", () => {
  const fixture = racedFixture();
  ownerRelease(fixture);
  const result = replanLoop(fixture.root, fixture.request);
  const archive = join(fixture.attempt, "replan-lease.json");
  writeFileSync(fixture.activePath, readFileSync(archive));
  rmSync(archive);
  expect(replanLoop(fixture.root, fixture.request)).toEqual(result);
  writeFileSync(fixture.activePath, readFileSync(archive));
  rmSync(archive);
  // Work that changed after the recorded delta refuses the retry.
  writeFixture(fixture.root, "later.txt", "new work\n");
  expect(() => replanLoop(fixture.root, fixture.request)).toThrow(
    "The source inventory digest changed"
  );
  expect(existsSync(fixture.activePath)).toBe(true);
  expect(existsSync(archive)).toBe(false);
});

test("a stray delta file refuses an exact or unmatched replan", () => {
  const fixture = racedFixture();
  const lease = readFileSync(fixture.activePath);
  mkdirSync(fixture.attempt, { recursive: true });
  writeFileSync(join(fixture.attempt, "replan-approval-delta.json"), "{}\n");
  expect(() => replanLoop(fixture.root, fixture.request)).toThrow(
    "no matching intent"
  );
  expect(readFileSync(fixture.activePath)).toEqual(lease);
  expect(readdirSync(fixture.attempt)).toEqual(["replan-approval-delta.json"]);
});

const claimFixture = (
  overrides: Partial<WorktreeClaim> = {}
): WorktreeClaim => ({
  branch: "work",
  changeDigest: "c".repeat(64),
  claimId: "claim-one",
  commonGitDirectory: "/repo/.git",
  createdAt: "2026-10-21T00:00:00.000Z",
  headSha: "a".repeat(40),
  owner: { adapter: "fixture", agentId: OWNER, ownerRef: null },
  path: "/repo-work",
  repositoryId: "repository",
  schemaVersion: 1,
  state: "active",
  updatedAt: "2026-10-21T00:00:00.000Z",
  ...overrides,
});

const observationFixture = (
  claims: WorktreeClaim[],
  events: WorktreeCoordinationEvent[] = []
): ReplanObservation => ({
  coordination: {
    claims,
    events,
    receipts: [],
    repositoryId: "repository",
    schemaVersion: 1,
  },
  inventoryDigest: "d".repeat(64),
  targetRevision: "b".repeat(40),
});

const checkout = {
  bare: false,
  branch: "work",
  changeDigest: "c".repeat(64),
  changes: [],
  detached: false,
  headSha: "a".repeat(40),
  isCurrent: false,
  isPrimary: false,
  locked: false,
  path: "/repo-work",
  prunable: false,
};

const releasedAt = "2026-10-21T01:00:00.000Z";
const releaseEvent = (
  overrides: Partial<WorktreeCoordinationEvent> = {}
): WorktreeCoordinationEvent => ({
  actorAgentId: OWNER,
  claimId: "claim-one",
  createdAt: releasedAt,
  eventId: "event-released-state-1",
  state: "released",
  ...overrides,
});
const released = claimFixture({
  releaseReason: "owner-release",
  state: "released",
  updatedAt: releasedAt,
});

test("the pure delta accepts exactly one owner release and refuses each other difference", () => {
  const approved = observationFixture([claimFixture()]);
  const accepted = replanApprovalDelta(
    approved,
    observationFixture([released], [releaseEvent()]),
    [checkout]
  );
  expect(accepted.refusals).toEqual([]);
  expect(replanDeltaAccepted(accepted)).toBe(true);
  expect(describeReplanDelta(accepted)).toContain("Verified owner release:");
  // No difference at all is not a delta to accept.
  expect(replanDeltaAccepted(replanApprovalDelta(approved, approved, []))).toBe(
    false
  );
  const refused = (
    current: ReplanObservation,
    worktrees = [checkout],
    from = approved
  ) => {
    const delta = replanApprovalDelta(from, current, worktrees);
    expect(replanDeltaAccepted(delta)).toBe(false);
    return delta.refusals.join("\n");
  };
  expect(refused(observationFixture([], [releaseEvent()]))).toContain(
    "was removed"
  );
  expect(
    refused(
      observationFixture(
        [released],
        [releaseEvent(), releaseEvent({ eventId: "event-released-state-2" })]
      )
    )
  ).toContain("has 2 new coordination events");
  expect(
    refused(observationFixture([released], [releaseEvent()]), [], approved)
  ).toContain("the checkout the approval observed is absent");
  expect(
    refused(
      observationFixture([released], [releaseEvent()]),
      [checkout],
      observationFixture(
        [claimFixture()],
        [releaseEvent({ eventId: "event-earlier", state: "active" })]
      )
    )
  ).toContain("removed or rewritten");
  expect(
    refused(
      observationFixture(
        [released, claimFixture({ claimId: "claim-two" })],
        [releaseEvent()]
      )
    )
  ).toContain("now holds that checkout");
  expect(
    refused(
      observationFixture(
        [claimFixture({ releaseReason: "shipped", state: "released" })],
        [releaseEvent({ actorAgentId: "controller" })]
      )
    )
  ).toContain("(reason shipped)");
  expect(
    refused(
      observationFixture([claimFixture()], [releaseEvent({ state: "paused" })])
    )
  ).toContain("set unchanged claim claim-one to paused");
  const withReceipt = observationFixture([released], [releaseEvent()]);
  withReceipt.coordination.receipts = [
    {
      acknowledgedAt: releasedAt,
      branch: "work",
      changeDigest: "c".repeat(64),
      claimId: "claim-one",
      disposition: "preserve-in-place",
      headSha: "a".repeat(40),
      ownerAgentId: OWNER,
      path: "/repo-work",
      reason: "fixture",
      receiptId: "receipt-one",
      requestingRunId: "run",
      schemaVersion: 1,
    },
  ];
  expect(refused(withReceipt)).toContain("Pause receipts changed.");
});
