import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CURRENT_GUIDANCE_VERSION } from "./guidance-updates.ts";
import { captureInventory, locateRepository } from "./inventory.ts";
import {
  controllerBindingPath,
  type LeaseLiveness,
  leaseLiveness,
  loopLeasePath,
  readControllerBinding,
  readLeaseFromCommonDirectory,
} from "./loop-lease.ts";
import { resolvePersonalPolicyPath } from "./policy.ts";
import { runGit } from "./process.ts";
import { withReadOnlyGit } from "./read-only-git.ts";
import { readReadyReceipts, readyReceiptsPath } from "./ready-work.ts";
import {
  evaluateShipHolds,
  type ShipHoldEvaluation,
  shipHoldsPath,
} from "./ship-holds.ts";
import { GLOBAL_SKILL_ROOTS, PROJECT_ROOTS } from "./skill-roots.ts";
import type { RepositoryInventory } from "./types.ts";
import {
  readCoordinationDocumentFromCommonDirectory,
  worktreeCoordinationPath,
} from "./worktree-coordination.ts";

/**
 * A read-only view of Simple Changes state across every repository and fork
 * under the roots `update-local-forks discover` scans. It never writes,
 * fetches, or takes a lock: it never runs `git status` (so no filter,
 * filesystem monitor, or index refresh runs), other Git reads run with
 * optional locks and lazy fetches off, holds are read locally only, and
 * state files are read without their locks, so a section another process is
 * rewriting may read as unknown. Anything that cannot be read is reported as
 * unknown with the reason, never guessed.
 */

const MAX_DEPTH = 6;
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".cache",
  "Library",
  ".Trash",
  "dist",
  "coverage",
]);
const PROVENANCE_PATTERN = /Forked from `simple-changes` @ `([0-9a-f]{7,40})`/u;
const SKILL_NAME_PATTERN = /^name:\s*(\S+)\s*$/mu;
const VERSION_CONSTANT_PATTERN = /^const VERSION = "(\d+\.\d+\.\d+)";$/mu;
const GUIDANCE_PATTERN = /CURRENT_GUIDANCE_VERSION = (\d+);/u;
const METADATA_VERSION_PATTERN =
  /^metadata:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+version:[ \t]*["']?(\d+\.\d+\.\d+)["']?/mu;
const CHANGELOG_VERSION_PATTERN = /^## (\d+\.\d+\.\d+)\b/mu;
const GITDIR_PATTERN = /^gitdir:\s*(.+)$/mu;

interface Unknown {
  error: string;
  state: "unknown";
}

const unknown = (error: unknown): Unknown => ({
  error: error instanceof Error ? error.message : String(error),
  state: "unknown",
});

export const isUnknown = (value: unknown): value is Unknown =>
  typeof value === "object" &&
  value !== null &&
  (value as { state?: unknown }).state === "unknown" &&
  typeof (value as { error?: unknown }).error === "string";

export interface StatusLease {
  /** Questions the run paused on; unknown when the binding is unreadable. */
  awaitingUser: string[] | null | Unknown;
  controllerStatus: "active" | "relinquished";
  liveness: Pick<LeaseLiveness, "ageMs" | "lastUpdatedAt" | "state">;
  mode: string;
  ownerAgentId: string;
  runId: string;
  targetRef: string;
}

export interface StatusClaim {
  adapter: string;
  agentId: string;
  branch: string | null;
  /**
   * How the checkout's HEAD compares with the claim; contents are never
   * compared, and unknown means the checkout could not be observed.
   */
  checkout: "absent" | "at-claimed-head" | "moved" | "unknown";
  claimId: string;
  path: string;
  state: string;
  updatedAt: string;
}

export interface StatusRepository {
  claims: StatusClaim[] | Unknown;
  commonGitDirectory: string;
  guidance:
    | {
        currentVersion: number;
        disposition: string | null;
        source: string;
        state: "current" | "deferred" | "not-configured" | "update-available";
        storedVersion: number | null;
      }
    | Unknown;
  holds:
    | Array<{
        holdId: string;
        owner: string;
        reason: string;
        scope: string;
        severity: string;
        status: string;
        untilMerged: string | null;
      }>
    | Unknown;
  lease: StatusLease | null | Unknown;
  readyWork:
    | Array<{
        branch: string;
        /** Whether the receipted checkout exists; null when unknowable. */
        checkoutPresent: boolean | null;
        detail: string;
        freshness: "current" | "shipped" | "stale" | "unknown";
        headSha: string;
        owner: string;
        path: string;
      }>
    | Unknown;
  /** Released claims kept as history; null when the claims are unreadable. */
  releasedClaims: number | null;
  repository: string;
}

export interface StatusFork {
  guidanceVersion: number | null;
  linkedWorktree: boolean;
  name: string;
  path: string;
  pin: string;
  runtimeVersion: string | null;
  state: "ahead" | "behind" | "current" | "unknown";
}

export interface StatusSource {
  guidanceVersion: number | null;
  linkedWorktree: boolean;
  path: string;
  version: string | null;
}

export interface StatusReport {
  forks: StatusFork[];
  generatedAt: string;
  readOnly: true;
  repositories: StatusRepository[];
  roots: string[];
  runtime: { guidanceVersion: number; version: string };
  sources: StatusSource[];
  upstream: StatusSource | null;
}

export interface StatusOptions {
  home?: string;
  roots?: readonly string[];
  runtime: { skillDirectory: string; version: string };
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const safeEntries = (directory: string): Dirent[] => {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

interface Discovered {
  repositories: Map<string, { linked: boolean; path: string }>;
  skills: string[];
}

/** The common Git directory a `.git` entry points to, read from its files. */
const commonDirectoryOf = (
  directory: string
): { common: string; linked: boolean } | null => {
  const dotGit = join(directory, ".git");
  try {
    if (statSync(dotGit).isDirectory()) {
      return { common: realpathSync(dotGit), linked: false };
    }
    const pointer = GITDIR_PATTERN.exec(readText(dotGit) ?? "")?.[1]?.trim();
    if (!pointer) {
      return null;
    }
    const gitDirectory = resolve(directory, pointer);
    const commonPointer = readText(join(gitDirectory, "commondir"))?.trim();
    const common = commonPointer
      ? resolve(gitDirectory, commonPointer)
      : gitDirectory;
    return { common: realpathSync(common), linked: true };
  } catch {
    return null;
  }
};

const walk = (
  directory: string,
  depth: number,
  found: Discovered,
  linkedAncestor: boolean
): void => {
  if (depth > MAX_DEPTH) {
    return;
  }
  const entries = safeEntries(directory);
  let linked = linkedAncestor;
  if (entries.some((entry) => entry.name === ".git")) {
    const located = commonDirectoryOf(directory);
    if (located) {
      ({ linked } = located);
      const known = found.repositories.get(located.common);
      if (!known || (known.linked && !located.linked)) {
        found.repositories.set(located.common, {
          linked: located.linked,
          path: directory,
        });
      }
    }
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    found.skills.push(`${linked ? "linked:" : ""}${directory}`);
  }
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !SKIP_DIRECTORIES.has(entry.name) &&
      (depth === 0 || !entry.name.startsWith(".") || entry.name === ".agents")
    ) {
      walk(join(directory, entry.name), depth + 1, found, linked);
    }
  }
};

const versionParts = (version: string): number[] =>
  version.split(".").map(Number);

const compareVersions = (left: string, right: string): number => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
};

const runtimeFile = (skill: string, ...path: string[]): string | null =>
  readText(join(skill, "runtime", "scripts", ...path)) ??
  readText(join(skill, "scripts", ...path));

const guidanceOf = (text: string | null): number | null => {
  const match = text ? GUIDANCE_PATTERN.exec(text)?.[1] : undefined;
  return match ? Number(match) : null;
};

const inspectSkill = (
  marked: string
): { fork: StatusFork } | { source: StatusSource } | null => {
  const linkedWorktree = marked.startsWith("linked:");
  const directory = linkedWorktree ? marked.slice("linked:".length) : marked;
  const skill = readText(join(directory, "SKILL.md"));
  const name = skill ? SKILL_NAME_PATTERN.exec(skill)?.[1] : undefined;
  if (!(skill && name)) {
    return null;
  }
  const pin = PROVENANCE_PATTERN.exec(skill)?.[1];
  const path = realpathSync(directory);
  if (pin) {
    return {
      fork: {
        guidanceVersion: guidanceOf(
          runtimeFile(directory, "lib", "guidance-updates.ts")
        ),
        linkedWorktree,
        name,
        path,
        pin,
        runtimeVersion:
          VERSION_CONSTANT_PATTERN.exec(
            runtimeFile(directory, "simple-changes.ts") ?? ""
          )?.[1] ?? null,
        state: "unknown",
      },
    };
  }
  if (name !== "simple-changes") {
    return null;
  }
  return {
    source: {
      guidanceVersion: guidanceOf(
        readText(join(directory, "scripts", "lib", "guidance-updates.ts"))
      ),
      linkedWorktree,
      path,
      version:
        METADATA_VERSION_PATTERN.exec(skill)?.[1] ??
        CHANGELOG_VERSION_PATTERN.exec(
          readText(join(directory, "CHANGELOG.md")) ?? ""
        )?.[1] ??
        null,
    },
  };
};

// A copy in a linked worktree may be unreleased work, so installed sources
// and primary checkouts decide the comparison whenever one exists.
const newestSource = (
  candidates: readonly StatusSource[]
): StatusSource | null => {
  const readable = candidates.filter(
    (source) => source.version && source.guidanceVersion !== null
  );
  const primary = readable.filter((source) => !source.linkedWorktree);
  return newestOf(primary.length > 0 ? primary : readable);
};

const newestOf = (sources: readonly StatusSource[]): StatusSource | null =>
  sources.reduce<StatusSource | null>((best, source) => {
    if (!best) {
      return source;
    }
    const guidance =
      (source.guidanceVersion ?? 0) - (best.guidanceVersion ?? 0);
    if (guidance !== 0) {
      return guidance > 0 ? source : best;
    }
    return compareVersions(source.version ?? "0.0.0", best.version ?? "0.0.0") >
      0
      ? source
      : best;
  }, null);

const forkState = (
  fork: StatusFork,
  upstream: StatusSource | null
): StatusFork["state"] => {
  if (
    !(upstream?.version && fork.runtimeVersion) ||
    upstream.guidanceVersion === null ||
    fork.guidanceVersion === null
  ) {
    return "unknown";
  }
  const guidance = fork.guidanceVersion - upstream.guidanceVersion;
  const version = compareVersions(fork.runtimeVersion, upstream.version);
  if (guidance < 0 || (guidance === 0 && version < 0)) {
    return "behind";
  }
  return guidance > 0 || version > 0 ? "ahead" : "current";
};

const section = <T>(read: () => T): T | Unknown => {
  try {
    return read();
  } catch (error) {
    return unknown(error);
  }
};

/**
 * Whether a state file exists, following symlinks: absent only on ENOENT or
 * ENOTDIR, unknown on any other failure (a loop, no permission), so a reader
 * that treats a missing file as empty state never turns an unreadable file
 * into a fact.
 */
const probeFile = (path: string): "absent" | "present" | Unknown => {
  try {
    statSync(path);
    return "present";
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : unknown(error);
  }
};

/** Reads a state section only once its file is known present or absent. */
const stateSection = <T>(path: string, read: () => T): T | Unknown => {
  const probed = probeFile(path);
  return isUnknown(probed) ? probed : section(read);
};

/**
 * The binding is advisory: a missing one, or one for another controller
 * tenure, means nothing is awaited, but one that cannot be read is unknown.
 */
const awaitingUserStatus = (
  lease: Parameters<typeof readControllerBinding>[0]
): StatusLease["awaitingUser"] => {
  const path = controllerBindingPath(lease.commonGitDirectory);
  const probed = probeFile(path);
  if (probed !== "present") {
    return probed === "absent" ? null : probed;
  }
  return section(() => {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    > | null;
    const questions = readControllerBinding(lease)?.awaitingUser?.questions;
    if (questions) {
      return questions;
    }
    // The advisory reader drops a malformed awaiting-user record; for this
    // controller's own binding that is unreadable, not "nothing awaited".
    const sameTenure =
      raw?.schemaVersion === 1 &&
      raw.runId === lease.runId &&
      raw.ownerAgentId === lease.ownerAgentId &&
      raw.controllerAcquiredAt ===
        (lease.controller?.acquiredAt ?? lease.createdAt);
    if (
      sameTenure &&
      raw.awaitingUser !== null &&
      raw.awaitingUser !== undefined
    ) {
      throw new Error(
        "the controller binding's awaiting-user record is malformed"
      );
    }
    return null;
  });
};

const leaseStatus = (commonGitDirectory: string): StatusLease | null => {
  const lease = readLeaseFromCommonDirectory(commonGitDirectory);
  if (!lease) {
    return null;
  }
  const liveness = leaseLiveness(lease);
  return {
    awaitingUser: awaitingUserStatus(lease),
    controllerStatus: lease.controller?.status ?? "active",
    liveness: {
      ageMs: liveness.ageMs,
      lastUpdatedAt: liveness.lastUpdatedAt,
      state: liveness.state,
    },
    mode: lease.mode,
    ownerAgentId: lease.ownerAgentId,
    runId: lease.runId,
    targetRef: lease.targetRef,
  };
};

/**
 * Whether a checkout exists, following symlinks: false only on ENOENT or
 * ENOTDIR, null when the filesystem cannot tell (a loop, no permission).
 */
const pathPresence = (path: string): boolean | null => {
  const probed = probeFile(path);
  return isUnknown(probed) ? null : probed === "present";
};

/**
 * Claims compare the checkout's HEAD only. Status never runs `git status`,
 * so it never compares contents and never reports a checkout as unchanged.
 */
const claimStatus = (
  inventory: RepositoryInventory
): { claims: StatusClaim[]; released: number } => {
  const document = readCoordinationDocumentFromCommonDirectory(
    inventory.repository.commonGitDirectory
  );
  const open = document.claims.filter((claim) => claim.state !== "released");
  return {
    claims: open.map((claim) => {
      const worktree = inventory.worktrees.find(
        (item) => item.path === claim.path
      );
      const present = pathPresence(claim.path);
      let checkout: StatusClaim["checkout"] = "at-claimed-head";
      if (present === false) {
        checkout = "absent";
      } else if (present === null || !worktree?.headSha || worktree.prunable) {
        checkout = "unknown";
      } else if (worktree.headSha !== claim.headSha) {
        checkout = "moved";
      }
      return {
        adapter: claim.owner.adapter,
        agentId: claim.owner.agentId,
        branch: claim.branch,
        checkout,
        claimId: claim.claimId,
        path: claim.path,
        state: claim.state,
        updatedAt: claim.updatedAt,
      };
    }),
    released: document.claims.length - open.length,
  };
};

const commitOf = (root: string, ref: string): string | null => {
  const result = runGit(
    root,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    true
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
};

/**
 * Whether a ref exists: `show-ref --exists` exits 2 only when it does not, so
 * a malformed or unreadable ref (which `show-ref --verify` also reports as
 * missing) is null, never absent. A Git without `--exists` reads null too.
 */
const refPresence = (root: string, ref: string): boolean | null => {
  const { exitCode } = runGit(root, ["show-ref", "--exists", ref], true);
  if (exitCode === 0) {
    return true;
  }
  return exitCode === 2 ? false : null;
};

/**
 * The target commit, read through its full ref. The inventory names the
 * target short (`origin/main` or `main`), and Git resolves a short name to a
 * same-named tag before a branch, so a tag could stand in for the target.
 * Null when the target ref does not exist; unknown when it cannot be read.
 */
const targetCommit = (
  inventory: RepositoryInventory
): string | null | Unknown => {
  const { targetRef } = inventory;
  const remote = inventory.repository.targetRemote;
  let full = `refs/heads/${targetRef}`;
  if (targetRef.startsWith("refs/")) {
    full = targetRef;
  } else if (remote && targetRef.startsWith(`${remote}/`)) {
    full = `refs/remotes/${targetRef}`;
  }
  const root = inventory.repository.primaryCheckout;
  const present = refPresence(root, full);
  if (present === null) {
    return unknown(new Error(`the target ${full} cannot be read`));
  }
  if (!present) {
    return null;
  }
  return (
    commitOf(root, full) ??
    unknown(new Error(`the target ${full} does not name a readable commit`))
  );
};

type ReadyFreshness = "current" | "shipped" | "stale" | "unknown";

/**
 * Whether the target contains `head`, by exact ancestry or patch
 * equivalence, as `revisionContainmentMethod` decides it, but with a failed
 * history read kept distinct from "not contained".
 */
const readyContainment = (
  root: string,
  target: string,
  head: string
): "patch-equivalent" | "target-contained" | null | Unknown => {
  const ancestry = runGit(
    root,
    ["merge-base", "--is-ancestor", `${head}^{commit}`, `${target}^{commit}`],
    true
  );
  if (ancestry.exitCode === 0) {
    return "target-contained";
  }
  if (ancestry.exitCode !== 1) {
    return unknown(new Error("the target's history could not be read"));
  }
  // A shallow clone cuts history, so "not an ancestor" may only mean the
  // connecting commits were never fetched.
  const shallow = runGit(root, ["rev-parse", "--is-shallow-repository"], true);
  if (shallow.exitCode !== 0 || shallow.stdout.trim() !== "false") {
    return unknown(
      new Error("this clone is shallow, so the target's history is incomplete")
    );
  }
  const unmatched = runGit(
    root,
    [
      "rev-list",
      "--cherry-pick",
      "--right-only",
      "--count",
      `${target}...${head}`,
    ],
    true
  );
  if (unmatched.exitCode !== 0) {
    return unknown(new Error("the target's history could not be read"));
  }
  return unmatched.stdout.trim() === "0" ? "patch-equivalent" : null;
};

/**
 * Ready-work freshness from refs alone: shipped once the target contains the
 * receipted head, stale once the branch moved or no longer exists, current
 * at the receipted head (contents not compared), and unknown whenever a ref
 * or commit cannot be read rather than shown absent.
 */
const readyFreshness = (
  root: string,
  target: string | null | Unknown,
  targetRef: string,
  branch: string,
  head: string
): { detail: string; freshness: ReadyFreshness } => {
  if (isUnknown(target)) {
    return {
      detail: `Whether ${targetRef} contains ${head} cannot be read here: ${target.error}.`,
      freshness: "unknown",
    };
  }
  const headPresent =
    runGit(root, ["cat-file", "-e", `${head}^{commit}`], true).exitCode === 0;
  if (!(target && headPresent)) {
    return {
      detail: target
        ? `The receipted commit ${head} cannot be read here.`
        : `The target ${targetRef} cannot be resolved here.`,
      freshness: "unknown",
    };
  }
  const method = readyContainment(root, target, head);
  if (isUnknown(method)) {
    return {
      detail: `Whether ${targetRef} contains ${head} cannot be read here: ${method.error}.`,
      freshness: "unknown",
    };
  }
  if (method) {
    return {
      detail: `${targetRef} already contains ${head} (${method}).`,
      freshness: "shipped",
    };
  }
  const exists = refPresence(root, `refs/heads/${branch}`);
  if (exists === false) {
    return {
      detail: `Branch ${branch} no longer exists locally.`,
      freshness: "stale",
    };
  }
  const branchHead = exists ? commitOf(root, `refs/heads/${branch}`) : null;
  if (!branchHead) {
    return {
      detail: `Branch ${branch} cannot be read here.`,
      freshness: "unknown",
    };
  }
  return branchHead === head
    ? {
        detail: `Branch ${branch} is still at the receipted commit; contents were not compared.`,
        freshness: "current",
      }
    : {
        detail: `Branch ${branch} moved to ${branchHead} after the receipt.`,
        freshness: "stale",
      };
};

const readyStatus = (
  inventory: RepositoryInventory,
  target: string | null | Unknown
): Exclude<StatusRepository["readyWork"], Unknown> => {
  const root = inventory.repository.primaryCheckout;
  return readReadyReceipts(inventory.repository.commonGitDirectory).map(
    (receipt) => ({
      ...readyFreshness(
        root,
        target,
        inventory.targetRef,
        receipt.branch,
        receipt.headSha
      ),
      branch: receipt.branch,
      checkoutPresent: pathPresence(receipt.path),
      headSha: receipt.headSha,
      owner: receipt.owner.agentId,
      path: receipt.path,
    })
  );
};

/**
 * The policy that decides guidance is the repository's file, else the
 * personal one; a lookup failure on either is unknown, never a fallback.
 */
const policyProbe = (primaryCheckout: string): Unknown | null => {
  for (const path of [
    resolve(primaryCheckout, ".simple-changes.json"),
    resolvePersonalPolicyPath(),
  ]) {
    const probed = probeFile(path);
    if (isUnknown(probed)) {
      return probed;
    }
    if (probed === "present") {
      return null;
    }
  }
  return null;
};

/**
 * A hold waiting for a branch to merge, judged again against the target's
 * full ref (the ordinary evaluation reads the target by its short name, which
 * a same-named tag can answer) with history-aware containment: satisfied when
 * the target contains the branch head, active when it does not, and unknown
 * when the target cannot be read, its history cannot be read, or the clone is
 * shallow (where cut history can make distinct tips with identical trees
 * look patch-equivalent). Other holds keep their evaluated status.
 */
const holdStatus = (
  inventory: RepositoryInventory,
  item: ShipHoldEvaluation,
  target: string | null | Unknown
): string => {
  const head = item.evidence?.branchHead;
  if (!((item.status === "active" || item.status === "satisfied") && head)) {
    return item.status;
  }
  if (target === null || isUnknown(target)) {
    return "unknown";
  }
  const contained = readyContainment(
    inventory.repository.primaryCheckout,
    target,
    head
  );
  if (isUnknown(contained)) {
    return "unknown";
  }
  return contained === null ? "active" : "satisfied";
};

const guidanceStatus = (
  inventory: RepositoryInventory
): Exclude<StatusRepository["guidance"], Unknown> => {
  const { source, value } = inventory.policy;
  const storedVersion = source === "default" ? null : value.guidance.version;
  let state: "current" | "deferred" | "not-configured" | "update-available" =
    "current";
  if (storedVersion === null) {
    state = "not-configured";
  } else if (storedVersion < CURRENT_GUIDANCE_VERSION) {
    state = "update-available";
  } else if (value.guidance.disposition === "deferred") {
    state = "deferred";
  }
  return {
    currentVersion: CURRENT_GUIDANCE_VERSION,
    disposition: source === "default" ? null : value.guidance.disposition,
    source,
    state,
    storedVersion,
  };
};

const repositoryStatus = (
  directory: string,
  commonGitDirectory: string
): StatusRepository => {
  const captured = section(() =>
    captureInventory(directory, { skipWorktreeStatus: true })
  );
  const lease = stateSection(loopLeasePath(commonGitDirectory), () =>
    leaseStatus(commonGitDirectory)
  );
  if (isUnknown(captured)) {
    return {
      claims: captured,
      commonGitDirectory,
      guidance: captured,
      holds: captured,
      lease,
      readyWork: captured,
      releasedClaims: null,
      repository: directory,
    };
  }
  const inventory = captured;
  const target = targetCommit(inventory);
  const claims = stateSection(
    worktreeCoordinationPath(commonGitDirectory),
    () => claimStatus(inventory)
  );
  return {
    claims: isUnknown(claims) ? claims : claims.claims,
    commonGitDirectory,
    guidance:
      policyProbe(inventory.repository.primaryCheckout) ??
      section(() => guidanceStatus(inventory)),
    holds: stateSection(shipHoldsPath(commonGitDirectory), () =>
      evaluateShipHolds(inventory, { localOnly: true }).holds.map((item) => ({
        holdId: item.hold.holdId,
        owner: item.hold.owner.agentId,
        reason: item.hold.reason,
        scope: item.hold.scope,
        severity: item.hold.severity,
        status: holdStatus(inventory, item, target),
        untilMerged: item.hold.untilMerged,
      }))
    ),
    lease,
    readyWork: stateSection(readyReceiptsPath(commonGitDirectory), () =>
      readyStatus(inventory, target)
    ),
    releasedClaims: isUnknown(claims) ? null : claims.released,
    repository: inventory.repository.primaryCheckout,
  };
};

/**
 * A repository is listed unless every Simple Changes marker is confirmed
 * absent; one that cannot be looked up is listed, so its state shows as
 * unknown instead of the repository disappearing.
 */
const usesSimpleChanges = (directory: string, common: string): boolean =>
  [
    join(common, "simple-changes"),
    join(directory, ".simple-changes.json"),
    join(dirname(common), ".simple-changes.json"),
  ].some((path) => probeFile(path) !== "absent");

/** One repository's status, for `simple-changes status` without `--all`. */
export const repositoryStatusFor = (directory: string): StatusRepository =>
  withReadOnlyGit(() => {
    const located = section(
      () => locateRepository(directory).repository.commonGitDirectory
    );
    return repositoryStatus(
      directory,
      isUnknown(located) ? directory : located
    );
  });

export const statusAll = (options: StatusOptions): StatusReport =>
  withReadOnlyGit(() => {
    const home = options.home ?? homedir();
    const roots = [
      ...GLOBAL_SKILL_ROOTS.map((root) => join(home, root)),
      ...PROJECT_ROOTS.map((root) => join(home, root)),
      ...(options.roots ?? []).map((root) => resolve(root)),
    ].filter(
      (root, index, all) => existsSync(root) && all.indexOf(root) === index
    );
    const found: Discovered = { repositories: new Map(), skills: [] };
    for (const root of roots) {
      walk(root, 0, found, false);
    }
    const seenSkills = new Set<string>();
    const forks: StatusFork[] = [];
    const sources: StatusSource[] = [];
    for (const marked of [...found.skills, options.runtime.skillDirectory]) {
      const inspected = inspectSkill(marked);
      const path =
        inspected && "fork" in inspected
          ? inspected.fork.path
          : inspected?.source.path;
      if (!(inspected && path) || seenSkills.has(path)) {
        continue;
      }
      seenSkills.add(path);
      if ("fork" in inspected) {
        forks.push(inspected.fork);
      } else {
        sources.push(inspected.source);
      }
    }
    const upstream = newestSource(sources);
    const repositories = [...found.repositories.entries()]
      .filter(([common, { path }]) => usesSimpleChanges(path, common))
      .map(([common, { path }]) => repositoryStatus(path, common))
      .sort((left, right) => left.repository.localeCompare(right.repository));
    return {
      forks: forks
        .map((fork) => ({ ...fork, state: forkState(fork, upstream) }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      generatedAt: new Date().toISOString(),
      readOnly: true,
      repositories,
      roots,
      runtime: {
        guidanceVersion: CURRENT_GUIDANCE_VERSION,
        version: options.runtime.version,
      },
      sources,
      upstream,
    };
  });
