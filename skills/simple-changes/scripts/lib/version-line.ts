import type {
  ChangelogRequest,
  LineCarryingChangelogReceipt,
  VersionLine,
} from "./types.ts";

const STABLE_VERSION = /^([0-9]+(?:\.[0-9]+){0,2})(?:\+[0-9A-Za-z.-]+)?$/u;

/**
 * A stable public version as three numeric components: one to three dotted
 * numbers, zero-padded (`1.2` is `1.2.0`), with `+build` metadata ignored.
 * Calendar-style numbers such as `2026.10.2` order the same way. Anything
 * else, including a prerelease, is not a stable version and returns null.
 */
export const parseStableVersion = (version: string): bigint[] | null => {
  const core = STABLE_VERSION.exec(version)?.[1];
  if (!core) {
    return null;
  }
  const parts = core.split(".").map((part) => BigInt(part));
  while (parts.length < 3) {
    parts.push(0n);
  }
  return parts;
};

/** Orders two stable versions; null when either is not a stable version. */
export const compareStableVersions = (
  left: string,
  right: string
): -1 | 0 | 1 | null => {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!(a && b)) {
    return null;
  }
  for (const [index, part] of a.entries()) {
    const other = b[index] ?? 0n;
    if (part !== other) {
      return part < other ? -1 : 1;
    }
  }
  return 0;
};

const sameList = (left: string[], right: string[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/** Code-unit order, the order `members` and `sharedVersionTrains` use. */
const sorted = (values: string[]): string[] =>
  [...values].sort((left, right) => (left < right ? -1 : Number(left > right)));

// The line head H and the members holding it, recomputed from memberVersions.
const lineHead = (
  line: VersionLine
): { head: string | null; holders: string[] } => {
  let head: string | null = null;
  for (const member of line.members) {
    const version = line.memberVersions[member] ?? null;
    if (version !== null && (head === null || compare(version, head) > 0)) {
      head = version;
    }
  }
  const holders =
    head === null
      ? []
      : line.members.filter((member) => {
          const version = line.memberVersions[member] ?? null;
          return version !== null && compare(version, head ?? version) === 0;
        });
  return { head, holders: sorted(holders) };
};

// Only called on values already proven stable.
const compare = (left: string, right: string): -1 | 0 | 1 =>
  compareStableVersions(left, right) ?? 0;

const assertMembers = (
  line: VersionLine,
  releaseTrain: string,
  fail: (message: string) => never
): void => {
  if (
    !(
      sameList(line.members, sorted(line.members)) &&
      new Set(line.members).size === line.members.length &&
      line.members.length >= 2 &&
      line.members.includes(releaseTrain)
    )
  ) {
    fail(
      "A version line's members must be its trains, sorted and unique, including the releasing train."
    );
  }
  const keys = Object.keys(line.memberVersions);
  if (!sameList(sorted(keys), line.members)) {
    fail("A version line's memberVersions must name exactly its members.");
  }
  for (const member of line.members) {
    const version = line.memberVersions[member] ?? null;
    if (version !== null && parseStableVersion(version) === null) {
      fail(
        `memberVersions for ${member} must be a stable dotted version or null, not ${version}.`
      );
    }
  }
};

const assertHead = (
  line: VersionLine,
  fail: (message: string) => never
): void => {
  const { head, holders } = lineHead(line);
  const sharedMatches =
    head === null
      ? line.sharedVersion === null
      : line.sharedVersion !== null &&
        parseStableVersion(line.sharedVersion) !== null &&
        compare(line.sharedVersion, head) === 0;
  if (!(sharedMatches && sameList(line.sharedVersionTrains, holders))) {
    fail(
      "A version line's sharedVersion must be the highest memberVersions value, held by exactly sharedVersionTrains (sorted), or null with no holders."
    );
  }
};

const assertOutcome = (
  line: VersionLine,
  releaseTrain: string,
  candidate: string | null,
  fail: (message: string) => never
): void => {
  if (line.mode === "bump-shared" && line.outcome !== "advance") {
    fail("A bump-shared line only ever advances.");
  }
  const own = line.memberVersions[releaseTrain] ?? null;
  const head = line.sharedVersion;
  if (
    line.outcome === "catch-up" &&
    (head === null || (own !== null && compare(own, head) >= 0))
  ) {
    fail("Only a train behind the line head can catch up to it.");
  }
  if (candidate === null) {
    return;
  }
  if (parseStableVersion(candidate) === null) {
    fail(
      `A release on a shared version line must select a stable dotted version, not ${candidate}.`
    );
  }
  if (own !== null && compare(candidate, own) <= 0) {
    fail(
      `A release must exceed its train's previous public version ${own}; ${candidate} does not.`
    );
  }
  if (
    line.outcome === "catch-up" &&
    head !== null &&
    compare(candidate, head) !== 0
  ) {
    fail(
      `A catch-up release must take the line head ${head}, not ${candidate}.`
    );
  }
  if (
    line.outcome === "advance" &&
    head !== null &&
    compare(candidate, head) <= 0
  ) {
    fail(
      `An advancing release must exceed the line head ${head}; ${candidate} does not.`
    );
  }
};

// A stable currentVersion (the version owner's value, which can be ahead of
// the train's last public release, or already bumped to the number being
// released) is never lowered. Strict growth is the line entry's job.
const assertAboveCurrentVersion = (
  currentVersion: string | null,
  candidate: string | null,
  fail: (message: string) => never
): void => {
  if (
    candidate === null ||
    currentVersion === null ||
    parseStableVersion(currentVersion) === null ||
    parseStableVersion(candidate) === null
  ) {
    return;
  }
  if (compare(candidate, currentVersion) < 0) {
    fail(
      `A release must not go below its train's current version ${currentVersion}; ${candidate} does.`
    );
  }
};

// The version a receipt proposes: the suggestion while approval is pending,
// the selection once one is made, and none for a blocked or not-applicable
// receipt, which keeps its closed-code routing.
const candidateOf = (receipt: LineCarryingChangelogReceipt): string | null => {
  const decision = receipt.versionDecision;
  if (!decision) {
    return null;
  }
  if (receipt.status === "decision-required") {
    return decision.suggestedVersion;
  }
  return receipt.status === "classified" ||
    receipt.status === "prepared" ||
    receipt.status === "verified"
    ? decision.selectedVersion
    : null;
};

/**
 * Checks a receipt v3's version line against itself and the request. Every
 * status gets the structural checks; the proposed version is checked only
 * while it is suggested for approval or once it is selected.
 */
export const assertVersionLine = (
  request: ChangelogRequest,
  receipt: LineCarryingChangelogReceipt,
  fail: (message: string) => never
): void => {
  if (
    !sameList(receipt.releaseSetTrains ?? [], request.releaseSetTrains ?? []) ||
    (receipt.releaseSetTrains === null) !==
      ((request.releaseSetTrains ?? null) === null)
  ) {
    fail("Receipt releaseSetTrains must echo the delegated request.");
  }
  const decision = receipt.versionDecision;
  const line = decision?.versionLine;
  if (!(decision && line)) {
    return;
  }
  assertMembers(line, decision.releaseTrain, fail);
  assertHead(line, fail);
  const candidate = candidateOf(receipt);
  assertOutcome(line, decision.releaseTrain, candidate, fail);
  assertAboveCurrentVersion(decision.currentVersion, candidate, fail);
};

/**
 * Two version lines describe the same line state: mode, members, member
 * versions, and head. The outcome is the release's own decision, which an
 * approved direction may change under the same decision digest.
 */
export const sameLineState = (
  left: VersionLine | null,
  right: VersionLine | null
): boolean => {
  if (left === null || right === null) {
    return left === right;
  }
  const sameVersion = (a: string | null, b: string | null): boolean =>
    a === null || b === null ? a === b : compareStableVersions(a, b) === 0;
  return (
    left.mode === right.mode &&
    sameList(left.members, right.members) &&
    left.members.every((member) =>
      sameVersion(
        left.memberVersions[member] ?? null,
        right.memberVersions[member] ?? null
      )
    ) &&
    sameVersion(left.sharedVersion, right.sharedVersion)
  );
};

/**
 * Request v2's release set: when it names trains, it names a release set,
 * and the releasing train is one of them.
 */
export const assertReleaseSetTrains = (
  request: ChangelogRequest,
  fail: (message: string) => never
): void => {
  const trains = request.releaseSetTrains ?? null;
  if (trains === null) {
    return;
  }
  if (request.releaseSetId === null || !trains.includes(request.releaseTrain)) {
    fail(
      "releaseSetTrains requires a releaseSetId and must include the releasing train."
    );
  }
};

export interface ReleaseSetConsistency {
  /** One entry per version line, keyed by its sorted members. */
  lines: Array<{ members: string[]; selectedVersion: string | null }>;
  /** Trains in releaseSetTrains with no receipt yet; sets are non-atomic. */
  missingTrains: string[];
  receipts: number;
  releaseSetId: string;
}

// A receipt without a version decision (for example one blocked on an
// ambiguous version owner) names no train, so it skips the per-train checks.
const trainOf = (receipt: LineCarryingChangelogReceipt): string | null =>
  receipt.versionDecision?.releaseTrain ?? null;

// Every receipt names the same release set, input target, and train list (in
// any order), once per train, and its own train is in that list.
const assertSharedReleaseSet = (
  receipts: LineCarryingChangelogReceipt[],
  first: LineCarryingChangelogReceipt,
  fail: (message: string) => never
): string[] => {
  const trains = sorted(first.releaseSetTrains ?? []);
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const train = trainOf(receipt);
    if (receipt.releaseSetTrains === null) {
      fail(
        `The receipt for ${train ?? receipt.transactionId} names no releaseSetTrains, so it cannot be checked as part of a multi-train release set.`
      );
    }
    if (
      receipt.releaseSetId !== first.releaseSetId ||
      receipt.revisionLineage.inputTargetRevision !==
        first.revisionLineage.inputTargetRevision ||
      !sameList(sorted(receipt.releaseSetTrains ?? []), trains)
    ) {
      fail(
        "Every receipt in a release set must share its releaseSetId, input target revision, and releaseSetTrains."
      );
    }
    if (train === null) {
      continue;
    }
    if (!trains.includes(train)) {
      fail(`Train ${train} is not in the release set's releaseSetTrains.`);
    }
    if (seen.has(train)) {
      fail(`The release set has more than one receipt for ${train}.`);
    }
    seen.add(train);
  }
  return trains.filter((train) => !seen.has(train));
};

// Each train belongs to at most one line: every line that lists a train must
// be the same line, and that train's own receipt must carry it.
const assertLineMembership = (
  receipts: LineCarryingChangelogReceipt[],
  fail: (message: string) => never
): void => {
  const claims = new Map<string, string>();
  const keyOf = (line: VersionLine): string => line.members.join(", ");
  for (const receipt of receipts) {
    const line = receipt.versionDecision?.versionLine;
    if (!line) {
      continue;
    }
    for (const member of line.members) {
      const claimed = claims.get(member);
      if (claimed !== undefined && claimed !== keyOf(line)) {
        fail(
          `Receipts disagree about the line ${member} belongs to: [${claimed}] and [${keyOf(line)}].`
        );
      }
      claims.set(member, keyOf(line));
    }
  }
  for (const receipt of receipts) {
    const train = trainOf(receipt);
    if (train === null) {
      continue;
    }
    const claimed = claims.get(train);
    const line = receipt.versionDecision?.versionLine ?? null;
    if (line && !line.members.includes(train)) {
      fail(`The receipt for ${train} carries a line that does not include it.`);
    }
    if (claimed !== undefined && (line === null || keyOf(line) !== claimed)) {
      fail(
        `Another receipt places ${train} on the line [${claimed}], but its own receipt does not.`
      );
    }
  }
};

// Within one release set, each version line has one state and one published
// version string.
const lineSelections = (
  receipts: LineCarryingChangelogReceipt[],
  fail: (message: string) => never
): Map<string, { line: VersionLine; selectedVersion: string | null }> => {
  const lines = new Map<
    string,
    { line: VersionLine; selectedVersion: string | null }
  >();
  for (const receipt of receipts) {
    const decision = receipt.versionDecision;
    const line = decision?.versionLine;
    if (!(decision && line)) {
      continue;
    }
    const key = line.members.join("\0");
    const seen = lines.get(key);
    if (!seen) {
      lines.set(key, { line, selectedVersion: decision.selectedVersion });
      continue;
    }
    if (!sameLineState(seen.line, line)) {
      fail(
        "Receipts on one version line in one release set must share the line's mode, memberVersions, and sharedVersion."
      );
    }
    if (
      seen.selectedVersion !== null &&
      decision.selectedVersion !== null &&
      seen.selectedVersion !== decision.selectedVersion
    ) {
      fail(
        `Trains on one version line released together must take one number, not ${seen.selectedVersion} and ${decision.selectedVersion}.`
      );
    }
    seen.selectedVersion ??= decision.selectedVersion;
  }
  return lines;
};

/**
 * Receipts from one multi-train release set: they share the release set,
 * input target, and train list, each train has at most one receipt and
 * belongs to at most one line, and every receipt on one line agrees on the
 * line state and publishes one version string, because one release set
 * releases a line's trains together under one number. Trains without a
 * receipt yet are reported, not refused: the set is non-atomic.
 */
export const assertReleaseSetConsistency = (
  receipts: LineCarryingChangelogReceipt[],
  fail: (message: string) => never
): ReleaseSetConsistency => {
  const [first] = receipts;
  if (!first?.releaseSetId) {
    return fail("A release-set check needs receipts that name a release set.");
  }
  const missingTrains = assertSharedReleaseSet(receipts, first, fail);
  assertLineMembership(receipts, fail);
  return {
    lines: [...lineSelections(receipts, fail).values()].map(
      ({ line, selectedVersion }) => ({
        members: line.members,
        selectedVersion,
      })
    ),
    missingTrains,
    receipts: receipts.length,
    releaseSetId: first.releaseSetId,
  };
};
