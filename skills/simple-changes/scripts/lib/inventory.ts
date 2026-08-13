import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { inspectChangelogCoordination } from "./changelog-coordination.ts";
import { sha256 } from "./hash.ts";
import { assertSafeRelativePath } from "./path-safety.ts";
import { loadPolicy } from "./policy.ts";
import { runGit } from "./process.ts";
import { validateSchema } from "./schema.ts";
import type {
  BranchInventory,
  Capability,
  GitChange,
  RemoteBinding,
  RepositoryInventory,
  SnapshotComparison,
  StashInventory,
  WorktreeInventory,
} from "./types.ts";

interface RawWorktree {
  bare: boolean;
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  locked: boolean;
  path: string;
  prunable: boolean;
}

const ZERO_SHA_PATTERN = /^0+$/u;
const WORKTREE_BLOCK_PATTERN = /\n\n+/u;
const AHEAD_PATTERN = /ahead ([0-9]+)/u;
const BEHIND_PATTERN = /behind ([0-9]+)/u;
const HTTP_REMOTE_CREDENTIAL_PATTERN = /^(https?:\/\/)[^/@]+@/iu;
const SCP_REMOTE_PATTERN = /^[^@]+@([^:]+):/u;
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const nullableSha = (value: string | undefined): string | null => {
  if (!value || ZERO_SHA_PATTERN.test(value)) {
    return null;
  }
  return value;
};

const absoluteGitPath = (root: string, value: string): string =>
  realpathSync(isAbsolute(value) ? value : resolve(root, value));

const parseWorktreeList = (output: string): RawWorktree[] =>
  output
    .trim()
    .split(WORKTREE_BLOCK_PATTERN)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const pathLine = lines.find((line) => line.startsWith("worktree "));
      if (!pathLine) {
        throw new Error("Git worktree record is missing its path");
      }
      const listedPath = pathLine.slice("worktree ".length);
      const headLine = lines.find((line) => line.startsWith("HEAD "));
      const branchLine = lines.find((line) => line.startsWith("branch "));
      return {
        bare: lines.includes("bare"),
        branch: branchLine
          ? branchLine.slice("branch refs/heads/".length)
          : null,
        detached: lines.includes("detached"),
        headSha: nullableSha(headLine?.slice("HEAD ".length)),
        locked: lines.some((line) => line.startsWith("locked")),
        path: existsSync(listedPath)
          ? realpathSync(listedPath)
          : resolve(listedPath),
        prunable: lines.some((line) => line.startsWith("prunable")),
      };
    });

const parseStatus = (worktreePath: string, output: string): GitChange[] => {
  const records = output.split("\0");
  const changes: GitChange[] = [];
  let recordIndex = 0;
  while (recordIndex < records.length) {
    const record = records[recordIndex];
    recordIndex += 1;
    if (!record) {
      continue;
    }
    const status = record.slice(0, 2);
    const path = record.slice(3);
    let originalPath: string | null = null;
    if (status.includes("R") || status.includes("C")) {
      originalPath = records[recordIndex] || null;
      recordIndex += 1;
    }
    const safePath = assertSafeRelativePath(worktreePath, path);
    if (originalPath) {
      assertSafeRelativePath(worktreePath, originalPath);
    }
    changes.push({
      conflicted: CONFLICT_CODES.has(status),
      indexStatus: status[0] ?? " ",
      originalPath,
      path,
      symlink: safePath.symlink,
      untracked: status === "??",
      worktreePath,
      worktreeStatus: status[1] ?? " ",
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
};

/* biome-ignore-start lint/suspicious/noBitwiseOperators: fs.open requires an OS flag bit mask */
const SAFE_REGULAR_FILE_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
/* biome-ignore-end lint/suspicious/noBitwiseOperators: flag mask ends here */

const digestRegularFile = (path: string): string => {
  const digest = createHash("sha256");
  const descriptor = openSync(path, SAFE_REGULAR_FILE_OPEN_FLAGS);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    if (!fstatSync(descriptor).isFile()) {
      return "not-regular-after-open";
    }
    let count = readSync(descriptor, buffer, 0, buffer.length, null);
    while (count > 0) {
      digest.update(buffer.subarray(0, count));
      count = readSync(descriptor, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
};

const filesystemIdentity = (path: string): string => {
  if (!existsSync(path)) {
    return "missing";
  }
  const status = lstatSync(path);
  if (status.isSymbolicLink()) {
    return `symlink:${sha256(readlinkSync(path))}`;
  }
  if (status.isFile()) {
    return `file:${digestRegularFile(path)}`;
  }
  let kind = "special";
  if (status.isDirectory()) {
    kind = "directory";
  } else if (status.isFIFO()) {
    kind = "fifo";
  } else if (status.isSocket()) {
    kind = "socket";
  } else if (status.isCharacterDevice()) {
    kind = "character-device";
  } else if (status.isBlockDevice()) {
    kind = "block-device";
  }
  return `${kind}:${status.mode}:${status.size}`;
};

const inventoryWorktree = (
  worktree: RawWorktree,
  primaryPath: string,
  currentPath: string
): WorktreeInventory => {
  let changes: GitChange[] = [];
  let changeDigest = sha256("");
  if (!(worktree.bare || worktree.prunable) && existsSync(worktree.path)) {
    const status = runGit(worktree.path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]).stdout;
    changes = parseStatus(worktree.path, status);
    const contentIdentities = changes.map((change) => {
      const safePath = assertSafeRelativePath(worktree.path, change.path);
      const index = runGit(
        worktree.path,
        ["rev-parse", "--verify", `:${change.path}`],
        true
      );
      return {
        indexObjectId:
          index.exitCode === 0 && index.stdout.trim()
            ? index.stdout.trim()
            : null,
        path: change.path,
        worktreeIdentity: filesystemIdentity(safePath.absolutePath),
      };
    });
    changeDigest = sha256(JSON.stringify({ changes, contentIdentities }));
  }
  return {
    ...worktree,
    changeDigest,
    changes,
    isCurrent: worktree.path === currentPath,
    isPrimary: worktree.path === primaryPath,
  };
};

const parseTracking = (tracking: string): { ahead: number; behind: number } => {
  const aheadMatch = AHEAD_PATTERN.exec(tracking);
  const behindMatch = BEHIND_PATTERN.exec(tracking);
  return {
    ahead: Number(aheadMatch?.[1] ?? 0),
    behind: Number(behindMatch?.[1] ?? 0),
  };
};

const inventoryBranches = (root: string): BranchInventory[] => {
  const format = [
    "%(refname:short)",
    "%(objectname)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(worktreepath)",
    "%(HEAD)",
  ].join("%00");
  const output = runGit(root, [
    "for-each-ref",
    `--format=${format}`,
    "refs/heads",
  ]).stdout;
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, upstream, tracking, worktreePath, head] =
        line.split("\0");
      const counts = parseTracking(tracking ?? "");
      return {
        ahead: counts.ahead,
        behind: counts.behind,
        current: head === "*",
        name: name ?? "",
        sha: sha ?? "",
        upstream: upstream || null,
        worktreePath: worktreePath || null,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
};

const inventoryStashes = (root: string): StashInventory[] => {
  const output = runGit(
    root,
    ["stash", "list", "--format=%gd%x00%H%x00%gs"],
    true
  ).stdout;
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, subject] = line.split("\0");
      return {
        ref: ref ?? "",
        sha: sha ?? "",
        subject: subject ?? "",
      };
    });
};

const providerFromRemote = (remoteUrl: string): string => {
  const normalized = remoteUrl.toLowerCase();
  if (normalized.includes("github.com")) {
    return "github";
  }
  if (normalized.includes("gitlab")) {
    return "gitlab";
  }
  if (normalized.includes("codeberg.org")) {
    return "codeberg";
  }
  if (normalized.startsWith("rad://")) {
    return "radicle";
  }
  try {
    return new URL(remoteUrl).hostname || "generic-forge";
  } catch {
    const scpHost = SCP_REMOTE_PATTERN.exec(remoteUrl)?.[1];
    return scpHost ?? "generic-forge";
  }
};

const remoteUrls = (root: string, remote: string, push: boolean): string[] => {
  const result = runGit(
    root,
    ["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote],
    true
  );
  return result.exitCode === 0
    ? [...new Set(result.stdout.split("\n").filter(Boolean))].sort()
    : [];
};

export const credentialFreeRemoteUrl = (remoteUrl: string): string => {
  try {
    const parsed = new URL(remoteUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return remoteUrl.replace(HTTP_REMOTE_CREDENTIAL_PATTERN, "$1");
  }
};

const inventoryRemoteBindings = (root: string): RemoteBinding[] =>
  runGit(root, ["remote"], true)
    .stdout.split("\n")
    .filter(Boolean)
    .sort()
    .map((name) => {
      const fetchUrls = remoteUrls(root, name, false).map(
        credentialFreeRemoteUrl
      );
      const pushUrls = remoteUrls(root, name, true).map(
        credentialFreeRemoteUrl
      );
      return {
        fetchUrls,
        name,
        provider: providerFromRemote(pushUrls[0] ?? fetchUrls[0] ?? ""),
        pushUrls,
      };
    });

export interface CaptureInventoryOptions {
  changelogEnvironment?: Record<string, string | undefined>;
  changelogHomeDirectory?: string;
}

const discoverCapabilities = (
  root: string,
  options: CaptureInventoryOptions
): Capability[] => {
  const capabilities: Capability[] = [
    {
      category: "git",
      detail: "Local Git inventory is available.",
      provider: "git",
      status: "supported",
    },
  ];
  const remotes = runGit(root, ["remote"], true)
    .stdout.split("\n")
    .filter(Boolean);
  if (remotes.length === 0) {
    capabilities.push({
      category: "forge",
      detail:
        "No Git remote is configured; provider operations are unavailable.",
      provider: "unconfigured",
      status: "configuration",
    });
  } else {
    const providers = new Set<string>();
    for (const remote of remotes) {
      const url = runGit(
        root,
        ["remote", "get-url", remote],
        true
      ).stdout.trim();
      if (url) {
        providers.add(providerFromRemote(url));
      }
    }
    for (const provider of [...providers].sort()) {
      capabilities.push({
        category: "forge",
        detail:
          "Provider was discovered from Git; authentication was not contacted during read-only inventory.",
        provider,
        status: "configuration",
      });
    }
  }

  const deploymentMarkers: [string, string][] = [
    ["vercel.json", "vercel"],
    ["railway.json", "railway"],
    ["fly.toml", "fly"],
    ["wrangler.toml", "cloudflare"],
    ["netlify.toml", "netlify"],
    ["render.yaml", "render"],
  ];
  const discoveredDeployments = deploymentMarkers
    .filter(([filename]) => existsSync(resolve(root, filename)))
    .map(([, provider]) => provider);
  if (discoveredDeployments.length === 0) {
    capabilities.push({
      category: "deployment",
      detail: "No supported deployment marker was discovered.",
      provider: "repository-native",
      status: "unsupported",
    });
  } else {
    for (const provider of discoveredDeployments) {
      capabilities.push({
        category: "deployment",
        detail:
          "Repository configuration was discovered; credentials and remote targets were not inspected.",
        provider,
        status: "configuration",
      });
    }
  }
  const changelog = inspectChangelogCoordination(root, {
    ...(options.changelogEnvironment
      ? { environment: options.changelogEnvironment }
      : {}),
    ...(options.changelogHomeDirectory
      ? { homeDirectory: options.changelogHomeDirectory }
      : {}),
  });
  let changelogDetail =
    "No changelog surfaces or compatible changelog skill were discovered.";
  let changelogProvider = "repository-native";
  let changelogStatus: Capability["status"] = "unsupported";
  if (changelog.relevant) {
    changelogDetail =
      "Changelog surfaces were discovered, but no compatible changelog skill is available.";
    changelogStatus = "configuration";
  }
  if (changelog.capabilityAvailable) {
    changelogDetail = `Compatible changelog capability discovered at ${changelog.providers.length} path(s).`;
    changelogProvider = "simple-changelogs";
    changelogStatus = "supported";
  }
  capabilities.push({
    category: "changelog",
    detail: changelogDetail,
    provider: changelogProvider,
    status: changelogStatus,
  });
  return capabilities;
};

const resolveTargetRef = (root: string, branch: string | null): string => {
  const remotes = runGit(root, ["remote"], true)
    .stdout.split("\n")
    .filter(Boolean);
  const configuredRemote = branch
    ? runGit(
        root,
        ["config", "--get", `branch.${branch}.remote`],
        true
      ).stdout.trim()
    : "";
  const preferredRemotes = [
    ...(configuredRemote && configuredRemote !== "." ? [configuredRemote] : []),
    ...(remotes.includes("origin") ? ["origin"] : []),
    ...remotes,
  ].filter((remote, index, candidates) => candidates.indexOf(remote) === index);
  for (const remote of preferredRemotes) {
    const symbolic = runGit(
      root,
      ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
      true
    );
    if (symbolic.exitCode === 0 && symbolic.stdout.trim()) {
      return symbolic.stdout.trim();
    }
  }
  for (const candidate of ["main", "master"]) {
    if (
      runGit(
        root,
        ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
        true
      ).exitCode === 0
    ) {
      return candidate;
    }
  }
  return branch ?? "main";
};

const targetRemoteFor = (
  root: string,
  branch: string | null,
  targetRef: string,
  bindings: RemoteBinding[]
): string | null => {
  const [prefix] = targetRef.split("/", 1);
  if (prefix && bindings.some((binding) => binding.name === prefix)) {
    return prefix;
  }
  const configured = branch
    ? runGit(
        root,
        ["config", "--get", `branch.${branch}.remote`],
        true
      ).stdout.trim()
    : "";
  if (configured && bindings.some((binding) => binding.name === configured)) {
    return configured;
  }
  const onlyBinding = bindings.at(0);
  if (bindings.length === 1 && onlyBinding) {
    return onlyBinding.name;
  }
  return null;
};

export const captureInventory = (
  directory: string,
  options: CaptureInventoryOptions = {}
): RepositoryInventory => {
  const rootOutput = runGit(directory, ["rev-parse", "--show-toplevel"]).stdout;
  const root = realpathSync(rootOutput.trim());
  const currentCheckout = root;
  const bare =
    runGit(root, ["rev-parse", "--is-bare-repository"]).stdout.trim() ===
    "true";
  const gitDirectory = absoluteGitPath(
    root,
    runGit(root, ["rev-parse", "--absolute-git-dir"]).stdout.trim()
  );
  const commonGitDirectory = absoluteGitPath(
    root,
    runGit(root, ["rev-parse", "--git-common-dir"]).stdout.trim()
  );
  const rawWorktrees = parseWorktreeList(
    runGit(root, ["worktree", "list", "--porcelain"]).stdout
  );
  const primaryCheckout =
    rawWorktrees.find((worktree) => !worktree.bare)?.path ?? root;
  const worktrees = rawWorktrees.map((worktree) =>
    inventoryWorktree(worktree, primaryCheckout, currentCheckout)
  );
  const headResult = runGit(root, ["rev-parse", "--verify", "HEAD"], true);
  const branchResult = runGit(
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    true
  );
  const headSha =
    headResult.exitCode === 0 ? nullableSha(headResult.stdout.trim()) : null;
  const branch =
    branchResult.exitCode === 0 && branchResult.stdout.trim()
      ? branchResult.stdout.trim()
      : null;
  const branches = inventoryBranches(root);
  const stashes = inventoryStashes(root);
  const localChanges = worktrees.flatMap((worktree) => worktree.changes);
  const targetRef = resolveTargetRef(root, branch);
  const remoteBindings = inventoryRemoteBindings(primaryCheckout);
  const targetRemote = targetRemoteFor(
    primaryCheckout,
    branch,
    targetRef,
    remoteBindings
  );
  const capabilities = discoverCapabilities(primaryCheckout, options);
  const policy = loadPolicy(primaryCheckout, { commonGitDirectory });
  const digestInput = JSON.stringify({
    branches,
    capabilities,
    localChanges,
    policy,
    repository: {
      bare,
      branch,
      commonGitDirectory,
      currentCheckout,
      gitDirectory,
      headSha,
      primaryCheckout,
      remoteBindings,
      root,
      targetRemote,
    },
    stashes,
    targetRef,
    worktrees,
  });
  const inventory: RepositoryInventory = {
    baselineDigest: sha256(digestInput),
    branches,
    capabilities,
    generatedAt: new Date().toISOString(),
    localChanges,
    policy,
    proposals: [],
    repository: {
      bare,
      branch,
      commonGitDirectory,
      currentCheckout,
      gitDirectory,
      headSha,
      primaryCheckout,
      remoteBindings,
      root,
      targetRemote,
    },
    schemaVersion: 1,
    stashes,
    targetRef,
    worktrees,
  };
  return validateSchema<RepositoryInventory>("inventory", inventory);
};

export const compareSnapshots = (
  opening: RepositoryInventory,
  current: RepositoryInventory
): SnapshotComparison => {
  const openingByPath = new Map(
    opening.worktrees.map((worktree) => [worktree.path, worktree])
  );
  const stableWorktrees: WorktreeInventory[] = [];
  const concurrentWorktrees: WorktreeInventory[] = [];
  const activelyChangingWorktrees: WorktreeInventory[] = [];
  for (const worktree of current.worktrees) {
    const original = openingByPath.get(worktree.path);
    if (!original) {
      concurrentWorktrees.push(worktree);
      continue;
    }
    if (
      original.headSha !== worktree.headSha ||
      original.changeDigest !== worktree.changeDigest
    ) {
      activelyChangingWorktrees.push(worktree);
      continue;
    }
    stableWorktrees.push(worktree);
  }
  return {
    activelyChangingWorktrees,
    concurrentWorktrees,
    stableWorktrees,
  };
};
