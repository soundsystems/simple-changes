import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  revisionContainmentMethod,
  type TargetContainmentMethod,
} from "./cleanup-core.ts";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { sha256Json } from "./hash.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import { readLeaseFromCommonDirectory } from "./loop-lease.ts";
import { runGit, runGitRemote, runGitWithInput } from "./process.ts";
import { redactSecrets } from "./redact.ts";
import { validateSchema } from "./schema.ts";
import type {
  RepositoryInventory,
  ShipHold,
  ShipHoldAction,
  ShipHoldDocument,
  ShipHoldIdentity,
  ShipHoldPublication,
  ShipHoldRelease,
  ShipHoldScope,
  ShipHoldSeverity,
  ShipHoldWaiver,
  WorktreeClaimOwner,
} from "./types.ts";
import {
  repositoryIdFor,
  withWorktreeCoordinationLock,
  worktreeCoordinationDirectory,
} from "./worktree-coordination.ts";

const HOLDS_FILENAME = "holds.json";
export const HOLD_REF_PREFIX = "refs/simple-changes/holds/";
const HOLD_PAYLOAD_PATH = "hold.json";
const ADAPTER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HOLD_ID_PATTERN = /^hold-[a-z0-9-]+$/u;
const MISSING_REMOTE_REF = /remote ref does not exist/iu;
const UNRESOLVED_REFERENCE = /unable to resolve reference '([^']+)'(:?)/giu;
const WHITESPACE = /\s+/u;
const SENTENCE_END = /[.!?]$/u;
// Pushes may run the user's pre-push hooks, so they get more time than reads.
const PUSH_TIMEOUT_MS = 120_000;
const MERGE_EVIDENCE_AGENT = "merge-evidence";
const IDENTITY_KEYS = [
  "createdAt",
  "holdId",
  "owner",
  "reason",
  "schemaVersion",
  "scope",
  "severity",
  "untilMerged",
] as const;
export const SHIP_HOLD_SCOPES: readonly ShipHoldScope[] = [
  "ship",
  "deploy",
  "migrations",
];
export const SHIP_HOLD_SEVERITIES: readonly ShipHoldSeverity[] = [
  "delay",
  "halt",
];
export const SHIP_HOLD_ACTIONS: readonly ShipHoldAction[] = [
  "merge",
  "deploy",
  "migrations",
];
// A `ship` hold covers every shipping step; narrower holds cover their own.
const BLOCKING_SCOPES: Record<ShipHoldAction, readonly ShipHoldScope[]> = {
  deploy: ["ship", "deploy"],
  merge: ["ship"],
  migrations: ["ship", "migrations"],
};
// Merging the target can trigger deployment or migrations automatically, so
// those holds are surfaced before a merge even though they do not block it.
const ADVISORY_SCOPES: Record<ShipHoldAction, readonly ShipHoldScope[]> = {
  deploy: [],
  merge: ["deploy", "migrations"],
  migrations: [],
};

export const shipHoldsPath = (commonGitDirectory: string): string =>
  resolve(worktreeCoordinationDirectory(commonGitDirectory), HOLDS_FILENAME);

const emptyDocument = (commonGitDirectory: string): ShipHoldDocument => ({
  holds: [],
  repositoryId: repositoryIdFor(commonGitDirectory),
  schemaVersion: 1,
  waivers: [],
});

export const readShipHoldDocument = (
  commonGitDirectory: string
): ShipHoldDocument => {
  const path = shipHoldsPath(commonGitDirectory);
  if (!existsSync(path)) {
    return emptyDocument(commonGitDirectory);
  }
  const document = validateSchema<ShipHoldDocument>(
    "ship-holds",
    JSON.parse(readFileSync(path, "utf8"))
  );
  if (document.repositoryId !== repositoryIdFor(commonGitDirectory)) {
    throw new SimpleChangesError(
      "Shipment holds belong to a different repository identity.",
      EXIT_CODES.unsafe
    );
  }
  return document;
};

/**
 * The run whose waivers apply: the active lease's run while its controller
 * holds control. A relinquished, missing, or unreadable lease (for example one
 * written by a newer client) leaves no run, so no waiver applies.
 */
const activeControllerRun = (commonGitDirectory: string): string | null => {
  try {
    const lease = readLeaseFromCommonDirectory(commonGitDirectory);
    return lease && lease.controller?.status !== "relinquished"
      ? lease.runId
      : null;
  } catch {
    return null;
  }
};

const writeShipHoldDocument = (
  commonGitDirectory: string,
  document: ShipHoldDocument
): void => {
  // Waivers never outlive their run, so every write drops the ones that no
  // longer belong to the active controller run.
  const run = activeControllerRun(commonGitDirectory);
  const validated = validateSchema<ShipHoldDocument>("ship-holds", {
    ...document,
    waivers: document.waivers.filter((waiver) => waiver.runId === run),
  });
  const root = worktreeCoordinationDirectory(commonGitDirectory);
  mkdirSync(root, { mode: 0o700, recursive: true });
  const temporaryPath = resolve(
    root,
    `${HOLDS_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  );
  writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, shipHoldsPath(commonGitDirectory));
};

const updateShipHolds = <T>(
  commonGitDirectory: string,
  operation: string,
  update: (document: ShipHoldDocument) => {
    document: ShipHoldDocument;
    result: T;
  }
): T =>
  withWorktreeCoordinationLock(commonGitDirectory, operation, () => {
    const { document, result } = update(
      readShipHoldDocument(commonGitDirectory)
    );
    writeShipHoldDocument(commonGitDirectory, document);
    return result;
  });

const replaceHold = (
  document: ShipHoldDocument,
  hold: ShipHold
): ShipHoldDocument => ({
  ...document,
  holds: [
    ...document.holds.filter((item) => item.holdId !== hold.holdId),
    hold,
  ],
});

const requiredText = (
  value: string | undefined,
  name: string,
  maximumLength = 500
): string => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new SimpleChangesError(`${name} is required.`, EXIT_CODES.usage);
  }
  if (trimmed.length > maximumLength) {
    throw new SimpleChangesError(
      `${name} must be at most ${maximumLength} characters.`,
      EXIT_CODES.usage
    );
  }
  if (redactSecrets(trimmed) !== trimmed) {
    throw new SimpleChangesError(
      `${name} must not contain credentials or secrets.`,
      EXIT_CODES.unsafe
    );
  }
  return trimmed;
};

const holdIdText = (value: string | undefined): string => {
  const holdId = requiredText(value, "hold ID", 128);
  if (!HOLD_ID_PATTERN.test(holdId)) {
    throw new SimpleChangesError(
      "hold ID must look like hold-<id>.",
      EXIT_CODES.usage
    );
  }
  return holdId;
};

export const shipHoldIdentity = (hold: ShipHoldIdentity): ShipHoldIdentity => ({
  createdAt: hold.createdAt,
  holdId: hold.holdId,
  owner: hold.owner,
  reason: hold.reason,
  schemaVersion: 1,
  scope: hold.scope,
  severity: hold.severity,
  untilMerged: hold.untilMerged,
});

/** Waivers bind this digest, so a different hold under a reused ID never inherits one. */
export const shipHoldDigest = (hold: ShipHoldIdentity): string =>
  sha256Json(shipHoldIdentity(hold));

const holdRef = (holdId: string): string => `${HOLD_REF_PREFIX}${holdId}`;

const resolveCommit = (root: string, ref: string): string | null => {
  const result = runGit(
    root,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    true
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
};

const configuredRemote = (
  inventory: RepositoryInventory,
  requested: string | undefined
): string | null => {
  const name = requested?.trim();
  if (!name) {
    return inventory.repository.targetRemote;
  }
  if (
    !inventory.repository.remoteBindings.some(
      (binding) => binding.name === name
    )
  ) {
    throw new SimpleChangesError(
      `Remote ${name} is not configured in this repository.`,
      EXIT_CODES.usage
    );
  }
  return name;
};

/**
 * A published hold judges `--until-merged` only from the remote-tracking
 * branch of the remote it came from: a same-named local branch in another
 * clone is unrelated work and must never clear it.
 */
const evidenceHead = (
  inventory: RepositoryInventory,
  hold: Pick<ShipHold, "publication" | "source">,
  branch: string
): string | null => {
  const root = inventory.repository.primaryCheckout;
  if (hold.source === "remote") {
    const remote = hold.publication?.remote;
    return remote
      ? resolveCommit(root, `refs/remotes/${remote}/${branch}`)
      : null;
  }
  const remote = inventory.repository.targetRemote;
  return (
    resolveCommit(root, `refs/heads/${branch}`) ??
    (remote ? resolveCommit(root, `refs/remotes/${remote}/${branch}`) : null)
  );
};

export interface ShipHoldEvidence {
  branch: string;
  branchHead: string | null;
  method: TargetContainmentMethod | null;
  targetRef: string;
  targetRevision: string | null;
}

const mergeEvidence = (
  inventory: RepositoryInventory,
  hold: Pick<ShipHold, "publication" | "source">,
  branch: string
): ShipHoldEvidence => {
  const root = inventory.repository.primaryCheckout;
  const head = evidenceHead(inventory, hold, branch);
  const target = resolveCommit(root, inventory.targetRef);
  return {
    branch,
    branchHead: head,
    method:
      head && target ? revisionContainmentMethod(root, target, head) : null,
    targetRef: inventory.targetRef,
    targetRevision: target,
  };
};

export interface RemoteHoldRead {
  error: string | null;
  name: string | null;
  refCount: number;
  status: "read" | "skipped" | "no-remote" | "unavailable";
}

interface RemoteHoldListing {
  holds: ShipHold[];
  read: RemoteHoldRead;
}

const unavailable = (name: string, error: string): RemoteHoldListing => ({
  holds: [],
  read: {
    error: redactSecrets(error.trim()) || "unknown error",
    name,
    refCount: 0,
    status: "unavailable",
  },
});

const listRemoteHoldRefs = (
  root: string,
  remote: string,
  pattern = `${HOLD_REF_PREFIX}*`
): Array<{ ref: string; sha: string }> | string => {
  const listing = runGitRemote(root, ["ls-remote", remote, pattern]);
  if (listing.exitCode !== 0) {
    return listing.stderr || listing.stdout;
  }
  return listing.stdout
    .split("\n")
    .map((line) => line.trim().split(WHITESPACE))
    .filter(
      (parts): parts is [string, string] =>
        parts.length === 2 && Boolean(parts[1]?.startsWith(HOLD_REF_PREFIX))
    )
    .map(([sha, ref]) => ({ ref, sha }));
};

// Without fetching, a published hold whose objects are not here is unreadable.
const missingHoldObjects = (
  root: string,
  refs: Array<{ ref: string; sha: string }>
): string | null => {
  const check = runGitWithInput(
    root,
    ["cat-file", "--batch-check"],
    `${refs.map((item) => item.sha).join("\n")}\n`
  );
  const missing = refs.filter((_item, index) =>
    check.stdout.split("\n")[index]?.endsWith("missing")
  );
  return missing.length === 0
    ? null
    : `Published holds ${missing.map((item) => item.ref).join(", ")} are not available locally and were not fetched.`;
};

const fetchMissingHoldObjects = (
  root: string,
  remote: string,
  refs: Array<{ ref: string; sha: string }>
): string | null => {
  const check = runGitWithInput(
    root,
    ["cat-file", "--batch-check"],
    `${refs.map((item) => item.sha).join("\n")}\n`
  );
  const missing = refs.filter((_item, index) =>
    check.stdout.split("\n")[index]?.endsWith("missing")
  );
  if (missing.length === 0) {
    return null;
  }
  const fetched = runGitRemote(root, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    remote,
    ...missing.map((item) => item.ref),
  ]);
  return fetched.exitCode === 0 ? null : fetched.stderr || fetched.stdout;
};

const remoteHold = (
  commonGitDirectory: string,
  remote: string,
  item: { ref: string; sha: string },
  payload: unknown
): ShipHold => {
  const record = payload as Record<string, unknown> | null;
  const keys = record && typeof record === "object" ? Object.keys(record) : [];
  if (
    record?.schemaVersion !== 1 ||
    keys.length !== IDENTITY_KEYS.length ||
    !keys.every((key) => (IDENTITY_KEYS as readonly string[]).includes(key))
  ) {
    throw new SimpleChangesError(
      "it was published in a format this Simple Changes cannot read; upgrade to evaluate it.",
      EXIT_CODES.validation
    );
  }
  const identity = payload as ShipHoldIdentity;
  const hold: ShipHold = {
    ...shipHoldIdentity(identity),
    publication: {
      commitSha: item.sha,
      publishedAt: identity.createdAt,
      ref: item.ref,
      remote,
      withdrawnAt: null,
    },
    release: null,
    source: "remote",
    state: "active",
    updatedAt: identity.createdAt,
  };
  // Validate through the document schema so a remote payload meets exactly
  // the same contract as a local hold.
  validateSchema<ShipHoldDocument>("ship-holds", {
    ...emptyDocument(commonGitDirectory),
    holds: [hold],
  });
  if (holdRef(hold.holdId) !== item.ref) {
    throw new SimpleChangesError(
      "its payload names a different hold ID.",
      EXIT_CODES.validation
    );
  }
  return hold;
};

/**
 * Read every hold published under `refs/simple-changes/holds/` on one remote.
 * Any listing, fetch, or payload failure is reported as `unavailable` so that
 * a gate fails closed instead of treating an unreadable hold as absent.
 */
const readRemoteHolds = (
  inventory: RepositoryInventory,
  remote: string,
  fetchMissing: boolean
): RemoteHoldListing => {
  const root = inventory.repository.primaryCheckout;
  const refs = listRemoteHoldRefs(root, remote);
  if (typeof refs === "string") {
    return unavailable(remote, refs);
  }
  if (refs.length > 0) {
    const fetchError = fetchMissing
      ? fetchMissingHoldObjects(root, remote, refs)
      : missingHoldObjects(root, refs);
    if (fetchError) {
      return unavailable(remote, fetchError);
    }
  }
  const holds: ShipHold[] = [];
  for (const item of refs) {
    // A partial clone may fetch the blob lazily, so read it without prompts.
    const shown = runGitRemote(root, [
      "show",
      `${item.sha}:${HOLD_PAYLOAD_PATH}`,
    ]);
    try {
      holds.push(
        remoteHold(
          inventory.repository.commonGitDirectory,
          remote,
          item,
          JSON.parse(shown.stdout)
        )
      );
    } catch (error) {
      return unavailable(
        remote,
        `Hold at ${item.ref} is unreadable: ${(error as Error).message}`
      );
    }
  }
  return {
    holds,
    read: { error: null, name: remote, refCount: refs.length, status: "read" },
  };
};

const combineRemoteReads = (
  listings: readonly RemoteHoldListing[]
): RemoteHoldListing => {
  const failed = listings.find(
    (listing) => listing.read.status === "unavailable"
  );
  return {
    holds: listings.flatMap((listing) => listing.holds),
    read: {
      error: failed?.read.error ?? null,
      name: listings.map((listing) => listing.read.name).join(", ") || null,
      refCount: listings.reduce(
        (total, listing) => total + listing.read.refCount,
        0
      ),
      status: failed ? "unavailable" : "read",
    },
  };
};

/**
 * Every remote that can carry published holds for this check: always the
 * target remote, plus any `--remote` named for it, so naming another remote
 * never skips the target's holds. When remotes exist but none is the target,
 * the published holds cannot be located and the read is unavailable.
 */
const remoteListing = (
  inventory: RepositoryInventory,
  options: ShipHoldReadOptions
): RemoteHoldListing => {
  if (options.localOnly) {
    return {
      holds: [],
      read: { error: null, name: null, refCount: 0, status: "skipped" },
    };
  }
  const requested = options.remote?.trim()
    ? configuredRemote(inventory, options.remote)
    : null;
  const remotes = [
    ...new Set(
      [inventory.repository.targetRemote, requested].filter(
        (name): name is string => Boolean(name)
      )
    ),
  ];
  if (remotes.length === 0) {
    return inventory.repository.remoteBindings.length > 0
      ? unavailable(
          "the configured remotes",
          "None of this repository's remotes is the target remote, so published holds cannot be located. Pass --remote NAME."
        )
      : {
          holds: [],
          read: { error: null, name: null, refCount: 0, status: "no-remote" },
        };
  }
  return combineRemoteReads(
    remotes.map((remote) =>
      readRemoteHolds(inventory, remote, options.fetchMissing ?? true)
    )
  );
};

export type ShipHoldStatus = "active" | "satisfied" | "waived" | "released";

export interface ShipHoldEvaluation {
  digest: string;
  evidence: ShipHoldEvidence | null;
  hold: ShipHold;
  status: ShipHoldStatus;
  waiver: ShipHoldWaiver | null;
}

export interface ShipHoldReport {
  action: ShipHoldAction | null;
  active: ShipHoldEvaluation[];
  advisory: ShipHoldEvaluation[];
  blocking: ShipHoldEvaluation[];
  checkedAt: string;
  clear: boolean;
  holds: ShipHoldEvaluation[];
  nextSteps: string[];
  pendingWithdrawals: ShipHold[];
  remote: RemoteHoldRead;
  runId: string | null;
  targetRef: string;
  /** Active here and confirmed published, but its ref is gone from the remote. */
  unpublishedElsewhere: ShipHold[];
}

export interface ShipHoldReadOptions {
  action?: ShipHoldAction | undefined;
  /**
   * Fetch published hold objects this clone lacks (the default). A caller
   * that must route every fetch through its own guard passes false, and a
   * missing object then makes the published holds unreadable.
   */
  fetchMissing?: boolean | undefined;
  localOnly?: boolean | undefined;
  remote?: string | undefined;
  /** When given, must name the active controller run; it never selects one. */
  runId?: string | undefined;
}

const matchingWaiver = (
  hold: ShipHold,
  digest: string,
  waivers: readonly ShipHoldWaiver[],
  runId: string | null
): ShipHoldWaiver | null =>
  (runId &&
    waivers.find(
      (waiver) =>
        waiver.holdId === hold.holdId &&
        waiver.runId === runId &&
        waiver.holdDigest === digest &&
        (hold.severity !== "halt" || waiver.overrideHalt)
    )) ||
  null;

const evaluateHold = (
  inventory: RepositoryInventory,
  hold: ShipHold,
  waivers: readonly ShipHoldWaiver[],
  runId: string | null
): ShipHoldEvaluation => {
  const digest = shipHoldDigest(hold);
  if (hold.state === "released") {
    return { digest, evidence: null, hold, status: "released", waiver: null };
  }
  const evidence = hold.untilMerged
    ? mergeEvidence(inventory, hold, hold.untilMerged)
    : null;
  if (evidence?.method) {
    return { digest, evidence, hold, status: "satisfied", waiver: null };
  }
  const waiver = matchingWaiver(hold, digest, waivers, runId);
  return {
    digest,
    evidence,
    hold,
    status: waiver ? "waived" : "active",
    waiver,
  };
};

// Hold reasons are free text, so end each one exactly once.
const sentence = (text: string): string =>
  SENTENCE_END.test(text) ? text : `${text}.`;

const describeHold = (hold: ShipHold): string =>
  sentence(
    `${hold.holdId} (${hold.severity} ${hold.scope}, ${hold.source}) by ${hold.owner.agentId}: ${hold.reason}`
  );

const nextStepFor = (
  evaluation: ShipHoldEvaluation,
  runId: string | null
): string => {
  const { hold } = evaluation;
  const run = runId ?? "<run-id>";
  const waive = `simple-changes hold waive --run-id ${run} --agent-id <controller> --hold-id ${hold.holdId} --approved-by <user> --reason "<why>"`;
  const evidence = hold.untilMerged
    ? ` It clears by itself once ${hold.untilMerged} is contained in the target.`
    : "";
  if (hold.severity === "halt") {
    return `Stop: ${describeHold(hold)} Wait for the owner to release it.${evidence} Proceed only if the user explicitly approves overriding this exact hold: ${waive} --override-halt`;
  }
  return `Ask the user whether to wait or proceed: ${describeHold(hold)}${evidence} To proceed with approval: ${waive}`;
};

const reportNextSteps = (
  blocking: readonly ShipHoldEvaluation[],
  advisory: readonly ShipHoldEvaluation[],
  remote: RemoteHoldRead,
  runId: string | null,
  action: ShipHoldAction | null
): string[] => {
  const steps = blocking.map((evaluation) => nextStepFor(evaluation, runId));
  if (action && remote.status === "unavailable") {
    steps.push(
      `Could not read shipment holds from ${remote.name}: ${remote.error} Fix remote access and retry, or with user approval rerun with --local-only.`
    );
  }
  for (const evaluation of advisory) {
    steps.push(
      `Advisory: ${describeHold(evaluation.hold)} If merging the target deploys or migrates automatically, treat this hold as blocking and ask the user.`
    );
  }
  if (blocking.length > 0 && !runId) {
    steps.push(
      "Waivers bind the active controller run; start or resume the controller's loop before waiving."
    );
  }
  return steps;
};

const mergedRelease = (
  hold: ShipHold,
  evidence: ShipHoldEvidence,
  now: string
): ShipHold => ({
  ...hold,
  release: {
    approvedBy: null,
    note: `${evidence.branch} at ${evidence.branchHead} is contained in ${evidence.targetRef} at ${evidence.targetRevision} (${evidence.method}).`,
    reason: "merged",
    releasedAt: now,
    releasedBy: MERGE_EVIDENCE_AGENT,
  },
  state: "released",
  updatedAt: now,
});

/**
 * Persist the merge evidence a gate observed, so a later branch move cannot
 * revive the hold. Best-effort: the gate's own decision never depends on this
 * write, so a busy lock or denied write leaves the hold to the next gate.
 */
const persistSatisfiedHolds = (
  commonGitDirectory: string,
  evaluations: readonly ShipHoldEvaluation[]
): void => {
  const satisfied = new Map(
    evaluations
      .filter(
        (item) =>
          item.status === "satisfied" &&
          item.hold.source === "local" &&
          item.evidence
      )
      .map((item) => [item.hold.holdId, item.evidence as ShipHoldEvidence])
  );
  if (satisfied.size === 0) {
    return;
  }
  const now = new Date().toISOString();
  try {
    updateShipHolds(commonGitDirectory, "release merged holds", (document) => ({
      document: {
        ...document,
        holds: document.holds.map((hold) => {
          const evidence = satisfied.get(hold.holdId);
          return evidence && hold.state === "active"
            ? mergedRelease(hold, evidence, now)
            : hold;
        }),
      },
      result: null,
    }));
  } catch {
    // Evidence is re-derived by every gate, so a skipped write loses nothing.
  }
};

const combinedHolds = (
  local: readonly ShipHold[],
  remote: readonly ShipHold[]
): ShipHold[] => {
  // The local record is authoritative for every hold it knows, including a
  // released one whose remote ref has not been withdrawn yet.
  const known = new Set(local.map((hold) => hold.holdId));
  return [...local, ...remote.filter((hold) => !known.has(hold.holdId))];
};

/**
 * Local holds still active here whose confirmed ref no longer appears on a
 * remote that was read successfully: someone withdrew them elsewhere, usually
 * through an approved release. The hold still blocks here (fail closed), but
 * its owner should learn that it was lifted for everyone else.
 */
const unpublishedHolds = (
  evaluations: readonly ShipHoldEvaluation[],
  listing: RemoteHoldListing
): ShipHold[] => {
  if (listing.read.status !== "read") {
    return [];
  }
  const readRemotes = new Set(
    (listing.read.name ?? "").split(", ").filter(Boolean)
  );
  const listed = new Set(listing.holds.map((hold) => hold.holdId));
  return evaluations
    .filter((item) => item.status !== "released" && item.status !== "satisfied")
    .map((item) => item.hold)
    .filter(
      (hold) =>
        hold.source === "local" &&
        hold.publication?.publishedAt &&
        hold.publication.withdrawnAt === null &&
        readRemotes.has(hold.publication.remote) &&
        !listed.has(hold.holdId)
    );
};

const awaitingWithdrawal = (evaluation: ShipHoldEvaluation): boolean => {
  const { hold } = evaluation;
  return (
    hold.source === "local" &&
    (hold.state === "released" || evaluation.status === "satisfied") &&
    hold.publication !== null &&
    hold.publication.withdrawnAt === null
  );
};

const waiverRun = (
  commonGitDirectory: string,
  expected: string | undefined
): string | null => {
  const run = activeControllerRun(commonGitDirectory);
  if (expected?.trim() && expected.trim() !== run) {
    throw new SimpleChangesError(
      `--run-id ${expected.trim()} is not the active controller run; waivers apply only to ${run ?? "an active controller run"}.`,
      EXIT_CODES.unsafe
    );
  }
  return run;
};

/**
 * Evaluate every local and published hold against fresh Git evidence. With an
 * `action`, the report says whether that shipping step may proceed: `clear`
 * is false while any covering hold is active or published holds are
 * unreadable. Waivers apply only for the active controller run.
 */
export const evaluateShipHolds = (
  inventory: RepositoryInventory,
  options: ShipHoldReadOptions = {}
): ShipHoldReport => {
  const { commonGitDirectory } = inventory.repository;
  const runId = waiverRun(commonGitDirectory, options.runId);
  const document = readShipHoldDocument(commonGitDirectory);
  const listing = remoteListing(inventory, options);
  const evaluations = combinedHolds(document.holds, listing.holds).map((hold) =>
    evaluateHold(inventory, hold, document.waivers, runId)
  );
  const action = options.action ?? null;
  if (action) {
    persistSatisfiedHolds(commonGitDirectory, evaluations);
  }
  const live = evaluations.filter((item) => item.status !== "released");
  const active = live.filter((item) => item.status === "active");
  const blocking = action
    ? active.filter((item) => BLOCKING_SCOPES[action].includes(item.hold.scope))
    : active;
  const advisory = action
    ? active.filter((item) => ADVISORY_SCOPES[action].includes(item.hold.scope))
    : [];
  // A hold released here (by its owner or by merge evidence) may still be
  // published; other clones keep honoring it until its owner withdraws it.
  const pendingWithdrawals = evaluations
    .filter(awaitingWithdrawal)
    .map((item) => item.hold);
  const unpublishedElsewhere = unpublishedHolds(evaluations, listing);
  return {
    action,
    active,
    advisory,
    blocking,
    checkedAt: new Date().toISOString(),
    clear:
      blocking.length === 0 &&
      !(action && listing.read.status === "unavailable"),
    holds: live,
    nextSteps: [
      ...reportNextSteps(blocking, advisory, listing.read, runId, action),
      ...pendingWithdrawals.map(
        (hold) =>
          `${hold.holdId} is released here but still published as ${hold.publication?.ref} on ${hold.publication?.remote}; withdraw it with: simple-changes hold release --agent-id ${hold.owner.agentId} --hold-id ${hold.holdId}`
      ),
      ...unpublishedElsewhere.map(
        (hold) =>
          `${hold.holdId} is still active here, but ${hold.publication?.ref} is gone from ${hold.publication?.remote}, so it was likely withdrawn elsewhere with approval. It keeps blocking here until its owner releases it: simple-changes hold release --agent-id ${hold.owner.agentId} --hold-id ${hold.holdId}`
      ),
    ],
    pendingWithdrawals,
    remote: listing.read,
    runId,
    targetRef: inventory.targetRef,
    unpublishedElsewhere,
  };
};

export const checkShipHolds = (
  repositoryPath: string,
  options: ShipHoldReadOptions = {}
): ShipHoldReport =>
  evaluateShipHolds(captureInventory(repositoryPath), options);

/** Throw a fail-closed error when holds block `action`; return the report otherwise. */
export const assertShipHoldsClear = (
  report: ShipHoldReport
): ShipHoldReport => {
  if (!report.clear) {
    const held = report.blocking.map((item) => item.hold.holdId);
    const remote =
      report.remote.status === "unavailable"
        ? [`unreadable holds on ${report.remote.name}`]
        : [];
    throw new SimpleChangesError(
      `Shipment holds block ${report.action ?? "shipping"}: ${[...held, ...remote].join(", ")}.\n${report.nextSteps.join("\n")}`,
      EXIT_CODES.unsafe
    );
  }
  return report;
};

export interface RecordedShipHolds {
  active: ShipHold[];
}

/**
 * The cheap, informational view used by `loop start` and `loop status`: the
 * recorded local holds that are still active, without evidence evaluation or
 * network reads. Gates remain the authoritative check.
 */
export const recordedShipHolds = (
  repositoryPath: string
): RecordedShipHolds => {
  const { commonGitDirectory } = locateRepository(repositoryPath).repository;
  return {
    active: readShipHoldDocument(commonGitDirectory).holds.filter(
      (hold) => hold.state === "active"
    ),
  };
};

export interface ShipHoldAddOptions {
  adapter: string;
  agentId: string;
  ownerRef?: string | undefined;
  reason: string;
  scope: ShipHoldScope;
  severity: ShipHoldSeverity;
  untilMerged?: string | undefined;
}

const holdOwner = (options: ShipHoldAddOptions): WorktreeClaimOwner => {
  const adapter = requiredText(options.adapter, "adapter", 64);
  if (!ADAPTER_PATTERN.test(adapter)) {
    throw new SimpleChangesError(
      "adapter must be a bounded lowercase slug.",
      EXIT_CODES.usage
    );
  }
  const ownerRef = options.ownerRef?.trim()
    ? requiredText(options.ownerRef, "owner reference", 512)
    : null;
  return {
    adapter,
    agentId: requiredText(options.agentId, "agent ID", 128),
    ownerRef,
  };
};

const assertUnmergedBranch = (
  inventory: RepositoryInventory,
  branch: string
): void => {
  const evidence = mergeEvidence(
    inventory,
    { publication: null, source: "local" },
    branch
  );
  if (!evidence.branchHead) {
    throw new SimpleChangesError(
      `--until-merged branch ${branch} does not exist locally or on the target remote.`,
      EXIT_CODES.usage
    );
  }
  if (evidence.method) {
    throw new SimpleChangesError(
      `${inventory.targetRef} already contains ${branch}; a hold until it merges would clear immediately. Commit the work it waits for first, or hold without --until-merged.`,
      EXIT_CODES.unsafe
    );
  }
};

export const addShipHold = (
  repositoryPath: string,
  options: ShipHoldAddOptions
): ShipHold => {
  if (!SHIP_HOLD_SCOPES.includes(options.scope)) {
    throw new SimpleChangesError(
      "--hold-scope must be ship, deploy, or migrations",
      EXIT_CODES.usage
    );
  }
  if (!SHIP_HOLD_SEVERITIES.includes(options.severity)) {
    throw new SimpleChangesError(
      "--severity must be delay or halt",
      EXIT_CODES.usage
    );
  }
  const owner = holdOwner(options);
  const reason = requiredText(options.reason, "hold reason");
  const untilMerged = options.untilMerged?.trim()
    ? requiredText(options.untilMerged, "--until-merged branch", 255)
    : null;
  const inventory = captureInventory(repositoryPath);
  if (untilMerged) {
    assertUnmergedBranch(inventory, untilMerged);
  }
  const now = new Date().toISOString();
  const hold: ShipHold = {
    createdAt: now,
    holdId: `hold-${randomUUID()}`,
    owner,
    publication: null,
    reason,
    release: null,
    schemaVersion: 1,
    scope: options.scope,
    severity: options.severity,
    source: "local",
    state: "active",
    untilMerged,
    updatedAt: now,
  };
  return updateShipHolds(
    inventory.repository.commonGitDirectory,
    "hold add",
    (document) => ({ document: replaceHold(document, hold), result: hold })
  );
};

export interface ShipHoldReleaseOptions {
  agentId: string;
  approvedBy?: string | undefined;
  holdId: string;
  overrideHalt?: boolean | undefined;
  reason?: string | undefined;
  remote?: string | undefined;
}

export interface ShipHoldWithdrawal {
  attempted: boolean;
  error: string | null;
  ok: boolean;
}

export interface ShipHoldReleaseResult {
  hold: ShipHold;
  withdrawal: ShipHoldWithdrawal;
}

const releaseRecord = (
  hold: ShipHold,
  options: ShipHoldReleaseOptions,
  agentId: string,
  now: string
): ShipHoldRelease => {
  if (hold.owner.agentId === agentId) {
    return {
      approvedBy: null,
      note: null,
      reason: "owner-release",
      releasedAt: now,
      releasedBy: agentId,
    };
  }
  if (!(options.approvedBy?.trim() && options.reason?.trim())) {
    throw new SimpleChangesError(
      `Only ${hold.owner.agentId} may release ${hold.holdId} on its own; another agent needs --approved-by and --reason from the user.`,
      EXIT_CODES.unsafe
    );
  }
  if (hold.severity === "halt" && !options.overrideHalt) {
    throw new SimpleChangesError(
      `${hold.holdId} is a halt owned by ${hold.owner.agentId}. Release it only when the user explicitly approves overriding this exact hold, and pass --override-halt.`,
      EXIT_CODES.unsafe
    );
  }
  return {
    approvedBy: requiredText(options.approvedBy, "--approved-by", 128),
    note: requiredText(options.reason, "--reason"),
    reason: "approved-release",
    releasedAt: now,
    releasedBy: agentId,
  };
};

const pushAuthorizationNever = (inventory: RepositoryInventory): boolean =>
  inventory.policy.value.gitPushAuthorization === "never";

/**
 * True only when Git reports this exact ref as already absent: either the
 * client-side "remote ref does not exist", or a lost delete race's bare
 * "unable to resolve reference '<ref>'". A suffixed form such as
 * "...: reference broken" or "...: Permission denied" is a real failure.
 */
const refAlreadyGone = (detail: string, ref: string): boolean =>
  (MISSING_REMOTE_REF.test(detail) && detail.includes(ref)) ||
  [...detail.matchAll(UNRESOLVED_REFERENCE)].some(
    ([, name, suffix]) => name === ref && suffix === ""
  );

const deleteRemoteRef = (
  root: string,
  remote: string,
  ref: string
): ShipHoldWithdrawal => {
  const pushed = runGitRemote(
    root,
    ["push", remote, `:${ref}`],
    PUSH_TIMEOUT_MS
  );
  const detail = pushed.stderr || pushed.stdout;
  if (pushed.exitCode === 0 || refAlreadyGone(detail, ref)) {
    return { attempted: true, error: null, ok: true };
  }
  return {
    attempted: true,
    error: redactSecrets(detail.trim()) || "push failed",
    ok: false,
  };
};

const withdrawPublication = (
  inventory: RepositoryInventory,
  publication: ShipHoldPublication
): ShipHoldWithdrawal => {
  if (pushAuthorizationNever(inventory)) {
    return {
      attempted: false,
      error: `This repository's push authorization is never, so remove the ref yourself: git push ${publication.remote} :${publication.ref}`,
      ok: false,
    };
  }
  return deleteRemoteRef(
    inventory.repository.primaryCheckout,
    publication.remote,
    publication.ref
  );
};

const markWithdrawn = (commonGitDirectory: string, holdId: string): ShipHold =>
  updateShipHolds(commonGitDirectory, "hold withdraw", (document) => {
    const current = document.holds.find((hold) => hold.holdId === holdId);
    if (!current?.publication) {
      throw new SimpleChangesError(
        `Hold ${holdId} has no publication to withdraw.`,
        EXIT_CODES.unsafe
      );
    }
    const now = new Date().toISOString();
    const withdrawn: ShipHold = {
      ...current,
      publication: { ...current.publication, withdrawnAt: now },
      updatedAt: now,
    };
    return { document: replaceHold(document, withdrawn), result: withdrawn };
  });

/**
 * Mark a publication as still awaiting withdrawal, so the next `hold release`
 * retries the delete instead of trusting an earlier withdrawal that a racing
 * push has since undone.
 */
const markWithdrawalPending = (
  commonGitDirectory: string,
  holdId: string
): void => {
  updateShipHolds(commonGitDirectory, "hold withdrawal pending", (document) => {
    const current = document.holds.find((hold) => hold.holdId === holdId);
    if (!current?.publication) {
      return { document, result: null };
    }
    const pending: ShipHold = {
      ...current,
      publication: { ...current.publication, withdrawnAt: null },
      updatedAt: new Date().toISOString(),
    };
    return { document: replaceHold(document, pending), result: null };
  });
};

const findHold = (
  inventory: RepositoryInventory,
  holdId: string,
  remote: string | undefined
): ShipHold => {
  const local = readShipHoldDocument(
    inventory.repository.commonGitDirectory
  ).holds.find((hold) => hold.holdId === holdId);
  if (local) {
    return local;
  }
  const listing = remoteListing(inventory, { remote });
  const found = listing.holds.find((hold) => hold.holdId === holdId);
  if (found) {
    return found;
  }
  if (listing.read.status === "unavailable") {
    throw new SimpleChangesError(
      `Hold ${holdId} is not local and holds on ${listing.read.name} could not be read: ${listing.read.error}`,
      EXIT_CODES.inventory
    );
  }
  throw new SimpleChangesError(
    `Unknown shipment hold: ${holdId}`,
    EXIT_CODES.unsafe
  );
};

/**
 * Release a hold by its owner, or by another agent with explicit user
 * approval (and an explicit override for a halt). A published hold is also
 * withdrawn from its remote; a failed withdrawal keeps the local release and
 * reports the retry.
 */
export const releaseShipHold = (
  repositoryPath: string,
  options: ShipHoldReleaseOptions
): ShipHoldReleaseResult => {
  const agentId = requiredText(options.agentId, "agent ID", 128);
  const holdId = holdIdText(options.holdId);
  const inventory = captureInventory(repositoryPath);
  const { commonGitDirectory } = inventory.repository;
  const candidate = findHold(inventory, holdId, options.remote);
  const now = new Date().toISOString();
  // Authorize against what was found, then release the record as it stands
  // under the lock, so a concurrent publish's intent is never lost.
  const release =
    candidate.state === "active"
      ? releaseRecord(candidate, options, agentId, now)
      : null;
  const released = updateShipHolds(
    commonGitDirectory,
    "hold release",
    (document) => {
      const current =
        document.holds.find((hold) => hold.holdId === holdId) ?? candidate;
      const next: ShipHold =
        current.state === "active" && release
          ? { ...current, release, state: "released", updatedAt: now }
          : current;
      return { document: replaceHold(document, next), result: next };
    }
  );
  const { publication } = released;
  if (!publication || publication.withdrawnAt) {
    return {
      hold: released,
      withdrawal: { attempted: false, error: null, ok: true },
    };
  }
  const withdrawal = withdrawPublication(inventory, publication);
  if (!withdrawal.ok) {
    return { hold: released, withdrawal };
  }
  return { hold: markWithdrawn(commonGitDirectory, holdId), withdrawal };
};

export interface ShipHoldPublishOptions {
  agentId: string;
  holdId: string;
  remote?: string | undefined;
}

/**
 * Build the hold's commit deterministically from its identity, so a retried
 * publish pushes the same object instead of a non-fast-forward replacement.
 */
const holdCommit = (root: string, hold: ShipHold): string => {
  const payload = `${JSON.stringify(shipHoldIdentity(hold), null, 2)}\n`;
  const blob = runGitWithInput(
    root,
    ["hash-object", "-w", "--stdin"],
    payload
  ).stdout.trim();
  const tree = runGitWithInput(
    root,
    ["mktree"],
    `100644 blob ${blob}\t${HOLD_PAYLOAD_PATH}\n`
  ).stdout.trim();
  // A fixed identity and the hold's own timestamp keep the commit independent
  // of local settings and of when it is pushed; the owner is in the payload.
  return runGitWithInput(
    root,
    ["commit-tree", "--no-gpg-sign", tree],
    `Simple Changes shipment hold ${hold.holdId}\n`,
    {
      GIT_AUTHOR_DATE: hold.createdAt,
      GIT_AUTHOR_EMAIL: "holds@simple-changes.invalid",
      GIT_AUTHOR_NAME: "Simple Changes",
      GIT_COMMITTER_DATE: hold.createdAt,
      GIT_COMMITTER_EMAIL: "holds@simple-changes.invalid",
      GIT_COMMITTER_NAME: "Simple Changes",
    }
  ).stdout.trim();
};

const publishableHold = (
  commonGitDirectory: string,
  holdId: string,
  agentId: string
): ShipHold => {
  const hold = readShipHoldDocument(commonGitDirectory).holds.find(
    (item) => item.holdId === holdId
  );
  if (hold?.source !== "local" || hold.owner.agentId !== agentId) {
    throw new SimpleChangesError(
      "Only the owner of a local hold may publish it.",
      EXIT_CODES.unsafe
    );
  }
  if (hold.state !== "active") {
    throw new SimpleChangesError(
      `Hold ${holdId} is released; there is nothing to publish.`,
      EXIT_CODES.unsafe
    );
  }
  return hold;
};

const recordPublicationIntent = (
  commonGitDirectory: string,
  holdId: string,
  publication: ShipHoldPublication
): void => {
  updateShipHolds(commonGitDirectory, "hold publish intent", (document) => {
    const current = document.holds.find((item) => item.holdId === holdId);
    if (current?.state !== "active") {
      throw new SimpleChangesError(
        `Hold ${holdId} was released before it was published.`,
        EXIT_CODES.unsafe
      );
    }
    const intended: ShipHold = {
      ...current,
      publication,
      updatedAt: new Date().toISOString(),
    };
    return { document: replaceHold(document, intended), result: null };
  });
};

const confirmPublication = (
  commonGitDirectory: string,
  holdId: string
): ShipHold | null =>
  updateShipHolds(commonGitDirectory, "hold publish", (document) => {
    const current = document.holds.find((item) => item.holdId === holdId);
    if (current?.state !== "active" || !current.publication) {
      return { document, result: null };
    }
    const now = new Date().toISOString();
    const published: ShipHold = {
      ...current,
      publication: { ...current.publication, publishedAt: now },
      updatedAt: now,
    };
    return { document: replaceHold(document, published), result: published };
  });

/**
 * Publish an owner's active hold as `refs/simple-changes/holds/<id>` on the
 * target remote so agents in other clones and on other machines see it with
 * plain Git. The intent is recorded before the push, so a release that races
 * the push still withdraws the ref, and a failed push can simply be retried.
 */
export const publishShipHold = (
  repositoryPath: string,
  options: ShipHoldPublishOptions
): ShipHold => {
  const agentId = requiredText(options.agentId, "agent ID", 128);
  const holdId = holdIdText(options.holdId);
  const inventory = captureInventory(repositoryPath);
  const { commonGitDirectory, primaryCheckout } = inventory.repository;
  if (pushAuthorizationNever(inventory)) {
    throw new SimpleChangesError(
      "This repository's push authorization is never, and publishing a hold is a push. Keep the hold local or ask the user to change the setting.",
      EXIT_CODES.unsafe
    );
  }
  const hold = publishableHold(commonGitDirectory, holdId, agentId);
  const { publication } = hold;
  if (publication?.publishedAt && !publication.withdrawnAt) {
    // Trust the record only while the remote still lists the ref; after a
    // withdrawal elsewhere the owner must be able to publish again.
    const listed = listRemoteHoldRefs(
      primaryCheckout,
      publication.remote,
      publication.ref
    );
    if (
      typeof listed === "string" ||
      listed.some((item) => item.ref === publication.ref)
    ) {
      return hold;
    }
  }
  const remote = configuredRemote(inventory, options.remote);
  if (!remote) {
    throw new SimpleChangesError(
      "This repository has no target remote; pass --remote NAME to publish the hold.",
      EXIT_CODES.usage
    );
  }
  const ref = holdRef(holdId);
  const commitSha = holdCommit(primaryCheckout, hold);
  recordPublicationIntent(commonGitDirectory, holdId, {
    commitSha,
    publishedAt: null,
    ref,
    remote,
    withdrawnAt: null,
  });
  const pushed = runGitRemote(
    primaryCheckout,
    ["push", remote, `${commitSha}:${ref}`],
    PUSH_TIMEOUT_MS
  );
  if (pushed.exitCode !== 0) {
    throw new SimpleChangesError(
      `Could not publish ${holdId} to ${remote}: ${redactSecrets((pushed.stderr || pushed.stdout).trim())} Retry hold publish; the hold stays local until then.`,
      EXIT_CODES.inventory
    );
  }
  const listed = listRemoteHoldRefs(primaryCheckout, remote, ref);
  if (typeof listed === "string" || !listed.some((item) => item.ref === ref)) {
    throw new SimpleChangesError(
      `${remote} accepted ${ref} but does not list it, so other clones cannot see the hold (the host may hide non-branch refs). Release the hold to remove it, and keep it local.`,
      EXIT_CODES.inventory
    );
  }
  const published = confirmPublication(commonGitDirectory, holdId);
  if (published) {
    return published;
  }
  // The hold was released while this push ran; take the ref back down.
  const withdrawal = deleteRemoteRef(primaryCheckout, remote, ref);
  if (withdrawal.ok) {
    markWithdrawn(commonGitDirectory, holdId);
    throw new SimpleChangesError(
      `Hold ${holdId} was released while it was being published; the pushed ref was withdrawn.`,
      EXIT_CODES.unsafe
    );
  }
  // A racing release may already have recorded a withdrawal that this push
  // undid; reopen it so `hold release` retries the delete. If even that write
  // fails, name the manual delete instead of hiding the stranded ref.
  let retry = "Rerun hold release to retry.";
  try {
    markWithdrawalPending(commonGitDirectory, holdId);
  } catch (error) {
    retry = `Recording the retry also failed (${(error as Error).message}); remove the ref yourself: git push ${remote} :${ref}`;
  }
  throw new SimpleChangesError(
    `Hold ${holdId} was released while it was being published and ${ref} could not be withdrawn: ${withdrawal.error} ${retry}`,
    EXIT_CODES.unsafe
  );
};

export interface ShipHoldWaiveOptions extends ShipHoldReadOptions {
  agentId: string;
  approvedBy: string;
  holdId: string;
  overrideHalt: boolean;
  reason: string;
  runId: string;
}

const assertWaivingController = (
  commonGitDirectory: string,
  runId: string,
  agentId: string
): void => {
  const lease = readLeaseFromCommonDirectory(commonGitDirectory);
  if (
    !lease ||
    lease.runId !== runId ||
    lease.ownerAgentId !== agentId ||
    lease.controller?.status === "relinquished"
  ) {
    throw new SimpleChangesError(
      "Only the active controller of this exact run may record a hold waiver.",
      EXIT_CODES.unsafe
    );
  }
};

/**
 * Record the user's decision to proceed past one hold for one run. A halt
 * additionally requires `overrideHalt`; the waiver binds the hold digest and
 * the active controller run, so it never carries over to another run.
 */
export const waiveShipHold = (
  repositoryPath: string,
  options: ShipHoldWaiveOptions
): ShipHoldWaiver => {
  const agentId = requiredText(options.agentId, "agent ID", 128);
  const runId = requiredText(options.runId, "run ID", 128);
  const holdId = holdIdText(options.holdId);
  const approvedBy = requiredText(options.approvedBy, "--approved-by", 128);
  const reason = requiredText(options.reason, "--reason");
  const inventory = captureInventory(repositoryPath);
  const { commonGitDirectory } = inventory.repository;
  assertWaivingController(commonGitDirectory, runId, agentId);
  const report = evaluateShipHolds(inventory, {
    localOnly: options.localOnly,
    remote: options.remote,
    runId,
  });
  const evaluation = report.holds.find((item) => item.hold.holdId === holdId);
  if (!evaluation || evaluation.status === "satisfied") {
    throw new SimpleChangesError(
      `Hold ${holdId} is not active; nothing to waive.`,
      EXIT_CODES.unsafe
    );
  }
  if (evaluation.hold.severity === "halt" && !options.overrideHalt) {
    throw new SimpleChangesError(
      `${holdId} is a halt. Waive it only when the user explicitly approves overriding this exact hold, and pass --override-halt.`,
      EXIT_CODES.unsafe
    );
  }
  const waiver: ShipHoldWaiver = {
    approvedBy,
    holdDigest: evaluation.digest,
    holdId,
    overrideHalt: options.overrideHalt,
    reason,
    runId,
    waivedAt: new Date().toISOString(),
    waivedBy: agentId,
  };
  return updateShipHolds(commonGitDirectory, "hold waive", (document) => ({
    document: {
      ...document,
      waivers: [
        ...document.waivers.filter(
          (item) => !(item.holdId === holdId && item.runId === runId)
        ),
        waiver,
      ],
    },
    result: waiver,
  }));
};
