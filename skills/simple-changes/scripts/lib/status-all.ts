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
  type LeaseLiveness,
  leaseLiveness,
  readControllerBinding,
  readLeaseFromCommonDirectory,
} from "./loop-lease.ts";
import { readyWorkStatus } from "./ready-work.ts";
import { evaluateShipHolds } from "./ship-holds.ts";
import { GLOBAL_SKILL_ROOTS, PROJECT_ROOTS } from "./skill-roots.ts";
import type { RepositoryInventory } from "./types.ts";
import { readCoordinationDocumentFromCommonDirectory } from "./worktree-coordination.ts";

/**
 * A read-only view of Simple Changes state across every repository and fork
 * under the roots `update-local-forks discover` scans. It never writes,
 * fetches, or takes a lock: Git runs with `GIT_OPTIONAL_LOCKS=0`, holds are
 * read locally only, and state files are read without their locks, so a
 * section another process is rewriting may read as unknown. Anything that
 * cannot be read is reported as unknown with the reason, never guessed.
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
  awaitingUser: string[] | null;
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
  /** How the checkout compares with the claim: unknown when unreadable. */
  checkout: "absent" | "changed" | "matches" | "moved" | "unknown";
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
        detail: string;
        freshness: string;
        headSha: string;
        owner: string;
        path: string;
      }>
    | Unknown;
  releasedClaims: number;
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

const leaseStatus = (commonGitDirectory: string): StatusLease | null => {
  const lease = readLeaseFromCommonDirectory(commonGitDirectory);
  if (!lease) {
    return null;
  }
  const liveness = leaseLiveness(lease);
  return {
    awaitingUser: readControllerBinding(lease)?.awaitingUser?.questions ?? null,
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
      let checkout: StatusClaim["checkout"] = "matches";
      if (!worktree) {
        checkout = existsSync(claim.path) ? "unknown" : "absent";
      } else if (worktree.headSha !== claim.headSha) {
        checkout = "moved";
      } else if (worktree.changeDigest !== claim.changeDigest) {
        checkout = "changed";
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
  const captured = section(() => captureInventory(directory));
  const lease = section(() => leaseStatus(commonGitDirectory));
  if (isUnknown(captured)) {
    return {
      claims: captured,
      commonGitDirectory,
      guidance: captured,
      holds: captured,
      lease,
      readyWork: captured,
      releasedClaims: 0,
      repository: directory,
    };
  }
  const inventory = captured;
  const claims = section(() => claimStatus(inventory));
  return {
    claims: isUnknown(claims) ? claims : claims.claims,
    commonGitDirectory,
    guidance: section(() => guidanceStatus(inventory)),
    holds: section(() =>
      evaluateShipHolds(inventory, { localOnly: true }).holds.map((item) => ({
        holdId: item.hold.holdId,
        owner: item.hold.owner.agentId,
        reason: item.hold.reason,
        scope: item.hold.scope,
        severity: item.hold.severity,
        status: item.status,
        untilMerged: item.hold.untilMerged,
      }))
    ),
    lease,
    readyWork: section(() =>
      readyWorkStatus(inventory).map((item) => ({
        branch: item.receipt.branch,
        detail: item.detail,
        freshness: item.freshness,
        headSha: item.receipt.headSha,
        owner: item.receipt.owner.agentId,
        path: item.receipt.path,
      }))
    ),
    releasedClaims: isUnknown(claims) ? 0 : claims.released,
    repository: inventory.repository.primaryCheckout,
  };
};

const usesSimpleChanges = (directory: string, common: string): boolean =>
  existsSync(join(common, "simple-changes")) ||
  existsSync(join(directory, ".simple-changes.json")) ||
  existsSync(join(dirname(common), ".simple-changes.json"));

/** Runs `read` with Git's optional locks off, restoring the setting after. */
const withoutOptionalLocks = <T>(read: () => T): T => {
  const previous = process.env.GIT_OPTIONAL_LOCKS;
  process.env.GIT_OPTIONAL_LOCKS = "0";
  try {
    return read();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "GIT_OPTIONAL_LOCKS");
    } else {
      process.env.GIT_OPTIONAL_LOCKS = previous;
    }
  }
};

/** One repository's status, for `simple-changes status` without `--all`. */
export const repositoryStatusFor = (directory: string): StatusRepository =>
  withoutOptionalLocks(() => {
    const located = section(
      () => locateRepository(directory).repository.commonGitDirectory
    );
    return repositoryStatus(
      directory,
      isUnknown(located) ? directory : located
    );
  });

export const statusAll = (options: StatusOptions): StatusReport =>
  withoutOptionalLocks(() => {
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
