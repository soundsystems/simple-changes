import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { PATCH_EQUIVALENCE_MAX_COMMITS } from "./cleanup-core.ts";
import {
  type ConfigEntry,
  completeConfigListing,
  completeLine,
  completeMergeBase,
  completeRemoteNames,
  LostGitAnswerError,
} from "./git-complete.ts";
import { runGit } from "./process.ts";
import { isExternalDeletionShape } from "./remote-branch-reconciliation.ts";
import { RUN_ID_PATTERN } from "./run-id.ts";
import type {
  RemoteBranchOpenProposalTarget,
  RemoteBranchReconciliationEntry,
  RemoteBranchReconciliationReceipt,
  RepositoryInventory,
  WorktreeClaim,
} from "./types.ts";
import { commitEquivalenceAgainstTarget } from "./worktree-equivalence.ts";

/**
 * Remote branches a reconciliation receipt preserves but that the evidence
 * says are finished. Nothing here deletes anything or writes state: the
 * builder turns merged-proposal heads into deletion proposals that still go
 * through `loop guard`, an exact provider deletion, `loop verify`, and a fresh
 * final inventory, and `loop finalize` reports what is left as pending.
 */

const HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Dispositions that preserve a branch nobody has proven live or finished. */
const UNCERTAIN_DISPOSITIONS: ReadonlySet<
  RemoteBranchReconciliationEntry["disposition"]
> = new Set(["preserved-ambiguous", "preserved-audited"]);

const finalProposals = (entry: RemoteBranchReconciliationEntry) =>
  entry.proposals.filter((proposal) => proposal.observedFinally !== false);

/**
 * A preserved branch the provider proves finished: present at the same head
 * in the opening and final inventories, unprotected, not the target, no
 * proposal open from it in the final inventory, and a final merged proposal
 * recorded at exactly that head. Holds (open proposals that target it, live
 * leases and claims) are checked separately.
 */
export const mergedHeadDeletionCandidate = (
  entry: RemoteBranchReconciliationEntry,
  targetBranch: string
): { headRevision: string; proposalObjectId: string } | null => {
  const head = entry.finalHeadRevision;
  if (
    !head ||
    entry.initialHeadRevision !== head ||
    entry.name === targetBranch ||
    entry.protected ||
    !UNCERTAIN_DISPOSITIONS.has(entry.disposition)
  ) {
    return null;
  }
  const records = finalProposals(entry);
  if (records.some((proposal) => proposal.state === "open")) {
    return null;
  }
  const merged = records.find(
    (proposal) => proposal.state === "merged" && proposal.headRevision === head
  );
  return merged
    ? { headRevision: head, proposalObjectId: merged.objectId }
    : null;
};

/** Whether a branch entry is one the cleanup report may consider at all. */
const reportable = (
  entry: RemoteBranchReconciliationEntry,
  targetBranch: string
): entry is RemoteBranchReconciliationEntry & { finalHeadRevision: string } =>
  entry.finalHeadRevision !== null &&
  entry.name !== targetBranch &&
  !entry.protected &&
  UNCERTAIN_DISPOSITIONS.has(entry.disposition) &&
  !finalProposals(entry).some((proposal) => proposal.state === "open");

/**
 * Local evidence that a remote branch is still in use: by name (checked out
 * in a worktree, held by an unreleased claim, a claim's resume target, or the
 * upstream of a live branch) and by revision (the exact point where a live
 * branch forked from the target, which is how a fresh integration branch that
 * still equals the target is recognized). A lease's own registrations are not
 * holds: a worktree the run removed stays registered, and a branch the
 * target already contains must not stay hidden behind it.
 */
export interface RemoteBranchHolds {
  byName: Map<string, string[]>;
  byRevision: Map<string, string[]>;
}

const addHold = (
  holds: Map<string, string[]>,
  key: string | null | undefined,
  reason: string
): void => {
  if (!key) {
    return;
  }
  const reasons = holds.get(key) ?? [];
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
  holds.set(key, reasons);
};

const branchNameForRef = (
  ref: string,
  targetRemote: string | null
): string | null => {
  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length) || null;
  }
  if (ref.startsWith("refs/remotes/")) {
    const rest = ref.slice("refs/remotes/".length);
    const separator = rest.indexOf("/");
    return separator === -1 ? null : rest.slice(separator + 1) || null;
  }
  if (targetRemote && ref.startsWith(`${targetRemote}/`)) {
    return ref.slice(targetRemote.length + 1) || null;
  }
  return ref || null;
};

export interface RemoteBranchHoldInput {
  claims: readonly WorktreeClaim[];
  inventory: Pick<RepositoryInventory, "branches" | "repository" | "worktrees">;
  targetBranch: string;
  targetRevision: string;
}

// A checkout path as the inventory's worktree records hold it.
const checkoutPath = (path: string): string =>
  existsSync(path) ? realpathSync(path) : resolve(path);

/**
 * Holds by name, and the live local branches whose upstreams and fork points
 * also hold: every branch checked out in a worktree, by the worktree listing
 * or by the branch listing's own `worktreePath`, or held by an unreleased
 * claim, which includes a stale claim whose owner may still return.
 */
const nameHolds = (
  input: RemoteBranchHoldInput,
  byName: Map<string, string[]>
): Map<string, string> => {
  const { claims, inventory } = input;
  const live = new Map<string, string>();
  const checkedOut = (branch: string, path: string): void => {
    addHold(byName, branch, `checked out in ${path}`);
    if (!live.has(branch)) {
      live.set(branch, `checked out in ${path}`);
    }
  };
  for (const worktree of inventory.worktrees) {
    if (worktree.branch) {
      checkedOut(worktree.branch, worktree.path);
    }
  }
  const bare = bareCheckouts(inventory);
  for (const branch of inventory.branches) {
    const path = branch.worktreePath && checkoutPath(branch.worktreePath);
    if (path && !bare.has(path)) {
      checkedOut(branch.exactName, path);
    }
  }
  for (const claim of claims) {
    if (claim.state === "released") {
      continue;
    }
    const owner = `claim ${claim.claimId} (${claim.owner.agentId}, ${claim.state})`;
    if (claim.branch) {
      addHold(byName, claim.branch, `held by ${owner}`);
      live.set(claim.branch, `held by ${owner}`);
    }
    if (claim.resumeTarget) {
      addHold(
        byName,
        branchNameForRef(
          claim.resumeTarget.targetRef,
          inventory.repository.targetRemote
        ),
        `resume target of ${owner}`
      );
    }
  }
  return live;
};

// A bare repository's record has no branch, but the branch listing still
// gives its HEAD branch the repository's path, which is not a checkout.
const bareCheckouts = (
  inventory: RemoteBranchHoldInput["inventory"]
): Set<string> =>
  new Set(
    inventory.worktrees
      .filter((worktree) => worktree.bare)
      .map((worktree) => worktree.path)
  );

/**
 * Whether a local branch exists, by `show-ref --verify`'s exit code, which a
 * lost answer cannot fake. It names exactly `refs/heads/<name>`, where
 * `rev-parse` would fall back to another ref when the branch has none, such
 * as a tag named `refs/heads/<name>`. Any failure other than "no such
 * branch", a branch whose commit is missing included, throws.
 */
const branchExists = (repositoryPath: string, branch: string): boolean => {
  const answer = runGit(
    repositoryPath,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    true
  );
  if (answer.exitCode === 0 || answer.exitCode === 1) {
    return answer.exitCode === 0;
  }
  throw new Error(
    `cannot tell whether ${branch} exists: ${answer.stderr.trim() || `exit ${answer.exitCode}`}`
  );
};

/**
 * Where the sources of checkouts disagree. The worktree listing and the
 * branch listing are separate Git reads, and each is checked only to end
 * whole, so one cut between two complete records still parses and leaves
 * out a checkout, and with it the holds its branch gives. So every checkout
 * one listing names must be in the other with the same branch, and a branch
 * a checkout or an unreleased claim names must be in the branch listing
 * unless Git confirms it does not exist (a branch with no commit yet, or a
 * claim's branch not created or already deleted). A claim may name a
 * checkout not made yet or already removed, so its path alone is not
 * compared. Both listings losing the same checkout cannot be seen here.
 * Branches are compared by `exactName`, the name the other two sources use;
 * the display name reads `heads/<name>` when a tag shares the name.
 */
const checkoutDisagreements = (input: RemoteBranchHoldInput): string[] => {
  const { claims, inventory } = input;
  const { primaryCheckout } = inventory.repository;
  if (inventory.worktrees.length === 0) {
    return ["the worktree listing names no checkout, not even the main one"];
  }
  // Each branch the worktree listing has checked out, with every path.
  const listed = new Map<string, string[]>();
  for (const worktree of inventory.worktrees) {
    if (worktree.branch) {
      listed.set(worktree.branch, [
        ...(listed.get(worktree.branch) ?? []),
        worktree.path,
      ]);
    }
  }
  const bare = bareCheckouts(inventory);
  const branches = new Map(
    inventory.branches.map((branch) => [branch.exactName, branch])
  );
  const leftOut = (name: string): boolean =>
    !branches.has(name) && branchExists(primaryCheckout, name);
  return [
    ...inventory.branches.flatMap((branch) => {
      const path = branch.worktreePath && checkoutPath(branch.worktreePath);
      const paths = listed.get(branch.exactName) ?? [];
      return path && !bare.has(path) && !paths.includes(path)
        ? [
            `the branch listing has ${branch.exactName} checked out in ${path}, but the worktree listing ${paths.length > 0 ? `has it in ${paths.join(", ")}` : "does not"}`,
          ]
        : [];
    }),
    ...[...listed].flatMap(([name, paths]) => {
      const where = `the worktree listing has ${name} checked out in ${paths.join(", ")}`;
      if (branches.get(name)?.worktreePath === null) {
        return [`${where}, but the branch listing has it checked out nowhere`];
      }
      return leftOut(name)
        ? [`${where}, but the branch listing leaves the branch out`]
        : [];
    }),
    ...claims.flatMap((claim) =>
      claim.state !== "released" &&
      claim.branch &&
      !listed.has(claim.branch) &&
      leftOut(claim.branch)
        ? [
            `claim ${claim.claimId} holds ${claim.branch}, but the branch listing leaves the branch out`,
          ]
        : []
    ),
  ];
};

/**
 * Whether Git could be missing history here. Anything other than an explicit
 * "false" counts as shallow, so an old Git or a failed check never reads as
 * full history.
 */
export const mayBeShallow = (repositoryPath: string): boolean =>
  runGit(
    repositoryPath,
    ["rev-parse", "--is-shallow-repository"],
    true
  ).stdout.trim() !== "false";

const SHALLOW_ADVICE =
  "the clone is shallow, so Git cannot prove what the target does or does not contain; run `git fetch --unshallow` and try again";

// Each line names its local ref first, because a pattern also matches the
// refs below it: `refs/heads/planned` lists `refs/heads/planned/child`, and
// only that, while planned has no commit yet.
const UPSTREAM_FORMAT =
  "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)";

// The first Git whose `for-each-ref` knows `%(upstream:remotename)` and
// `%(upstream:remoteref)`.
const UPSTREAM_ATOMS_SINCE = { major: 2, minor: 16 };

const GIT_VERSION = /^git version ([0-9]+)\.([0-9]+)(?:[.\s]|$)/u;

// How a Git older than 2.16 refuses either atom, by name.
const UPSTREAM_ATOM_REFUSAL = /^fatal: unrecognized .*\bremote(?:name|ref)\b/mu;

/**
 * Whether a failed upstream read is an older Git refusing the atoms, not a
 * read that failed. Both must say so: Git's own refusal naming an atom
 * (`unrecognized format: %(upstream:remotename)` before 2.13, then
 * `unrecognized %(upstream) argument: remotename`), and a whole `git
 * version` line older than 2.16. Anything else, such as an I/O error, a
 * newer Git, or a version that cannot be read, is a failure.
 */
const refusesUpstreamAtoms = (
  repositoryPath: string,
  failure: { exitCode: number; stderr: string }
): boolean => {
  if (failure.exitCode !== 128 || !UPSTREAM_ATOM_REFUSAL.test(failure.stderr)) {
    return false;
  }
  const version = GIT_VERSION.exec(
    completeLine(repositoryPath, ["version"], GIT_VERSION).line ?? ""
  );
  if (!version) {
    return false;
  }
  const [major, minor] = [Number(version[1]), Number(version[2])];
  return (
    major < UPSTREAM_ATOMS_SINCE.major ||
    (major === UPSTREAM_ATOMS_SINCE.major && minor < UPSTREAM_ATOMS_SINCE.minor)
  );
};

/**
 * Git's own upstream of a local branch: the remote and the remote's ref,
 * which Git takes from the first `branch.<name>.merge` value. Null when Git
 * gives none: it tracks nothing, Git maps no remote-tracking branch to it
 * (a remote that is not configured, a fetch refspec that leaves the branch
 * out, or a merge value without `refs/heads/`), the branch has no commit
 * yet, or a Git older than 2.16 refuses the atoms. Any other failure
 * throws, so a read that failed never reads as no upstream. Git prints one
 * whole line per ref the pattern matches, the branch's own and any below
 * it, and only the line naming exactly `refs/heads/<name>` answers. An
 * answer cut short (no line break at its end) is asked once more and then
 * refused, so a cut name never names another remote or branch. An answer
 * without the branch's own line is settled by whether the branch exists: a
 * branch that exists makes it a lost answer, which throws rather than read
 * as no upstream, and one that does not has no upstream of its own.
 */
const canonicalUpstream = (
  repositoryPath: string,
  branch: string
): { ref: string; remote: string } | null => {
  const ask = () =>
    runGit(
      repositoryPath,
      ["for-each-ref", UPSTREAM_FORMAT, `refs/heads/${branch}`],
      true
    );
  const whole = (reply: { exitCode: number; stdout: string }): boolean =>
    reply.exitCode !== 0 || reply.stdout.endsWith("\n");
  const first = ask();
  const answer = whole(first) ? first : ask();
  if (!whole(answer) && (first.stdout !== "" || answer.stdout !== "")) {
    throw new LostGitAnswerError(
      `cannot read the upstream of ${branch}: Git twice printed an upstream line cut short, so its answer was lost.`
    );
  }
  if (answer.exitCode !== 0) {
    if (refusesUpstreamAtoms(repositoryPath, answer)) {
      return null;
    }
    throw new Error(
      `cannot read the upstream of ${branch}: ${answer.stderr.trim() || `exit ${answer.exitCode}`}`
    );
  }
  const own = `refs/heads/${branch}\0`;
  const line = answer.stdout.split("\n").find((each) => each.startsWith(own));
  if (line === undefined) {
    if (branchExists(repositoryPath, branch)) {
      throw new Error(
        `cannot read the upstream of ${branch}: Git's answer left out a branch that exists, so its answer was lost; retry the command`
      );
    }
    return null;
  }
  const [remote = "", ref = "", ...extra] = line.slice(own.length).split("\0");
  return remote && ref && extra.length === 0 ? { ref, remote } : null;
};

const providerBranchName = (ref: string | null): string | null =>
  ref === null
    ? null
    : (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref) ||
      null;

/**
 * The provider branches a local branch may track on the target remote: the
 * upstream Git resolves for it, and every `branch.<name>.merge` value its
 * configuration lists. Git uses one merge value where several are set, and
 * a pull merges them all, so each is held; an older Git, a merge value Git
 * does not use, or one it cannot map to a remote-tracking branch holds too
 * many branches, never too few. A remote that is neither the target, this
 * repository (`.`), nor one of the configured `remotes` is unknown, so the
 * branch it names is held as if it were the target's: Git's upstream holds
 * when its remote is the target or unknown, and the merge values hold when
 * any `branch.<name>.remote` value is. A read that fails, unless a Git
 * older than 2.16 refuses the atoms, and an answer that cannot be read
 * throw, so an unknown upstream never reads as none.
 */
const trackedProviderBranches = (
  repositoryPath: string,
  branch: string,
  targetRemote: string,
  remotes: () => readonly string[],
  configuration: () => readonly ConfigEntry[]
): string[] => {
  const targets = (remote: string | null): boolean =>
    remote === null ||
    remote === targetRemote ||
    !(remote === "." || remotes().includes(remote));
  const upstream = canonicalUpstream(repositoryPath, branch);
  const values = (key: "merge" | "remote") =>
    configuration()
      .filter((entry) => entry.key === `branch.${branch}.${key}`)
      .map((entry) => entry.value);
  const tracked = [
    upstream && targets(upstream.remote) ? upstream.ref : null,
    ...(values("remote").some(targets) ? values("merge") : []),
  ]
    .map(providerBranchName)
    .filter((name): name is string => name !== null);
  return [...new Set(tracked)];
};

/**
 * Holds that need no history: checkouts, claims, resume targets, and the
 * upstream of every live branch, the target's included (a target checkout
 * tracking another provider branch keeps that branch). When the sources of
 * checkouts disagree, this throws, so a caller deciding deletions withholds
 * every proposal instead of trusting holds built from a listing cut short.
 */
export const remoteBranchNameHolds = (
  input: RemoteBranchHoldInput
): { byName: Map<string, string[]>; live: Map<string, string> } => {
  const { inventory, targetBranch } = input;
  const { primaryCheckout, targetRemote } = inventory.repository;
  const disagreements = checkoutDisagreements(input);
  if (disagreements.length > 0) {
    throw new LostGitAnswerError(
      `The worktree listing, the branch listing and the claims disagree about what is checked out (${disagreements.join("; ")}), so a listing was cut short or a checkout changed between the reads.`
    );
  }
  const byName = new Map<string, string[]>();
  const live = nameHolds(input, byName);
  // Each is read once, and only when a branch needs it.
  let configured: string[] | undefined;
  const remotes = (): readonly string[] => {
    configured ??= completeRemoteNames(
      primaryCheckout,
      targetRemote ? [targetRemote] : []
    );
    return configured;
  };
  let configuration: ConfigEntry[] | undefined;
  const entries = (): readonly ConfigEntry[] => {
    configuration ??= completeConfigListing(primaryCheckout);
    return configuration;
  };
  for (const [branch, why] of live) {
    const upstreams = targetRemote
      ? trackedProviderBranches(
          primaryCheckout,
          branch,
          targetRemote,
          remotes,
          entries
        )
      : [];
    for (const upstream of upstreams) {
      if (upstream !== targetBranch) {
        addHold(byName, upstream, `upstream of ${branch}, ${why}`);
      }
    }
  }
  return { byName, live };
};

/**
 * Where a live branch forked from the target. No shared history means no fork
 * point; any other Git failure throws, because a hold that cannot be computed
 * must not read as no hold. So does an answer lost or cut short, which
 * git-complete.ts asks once more and then refuses.
 */
const forkPoint = (
  repositoryPath: string,
  branch: string,
  head: string,
  targetRevision: string
): string | null => {
  const answer = completeMergeBase(
    repositoryPath,
    `${head}^{commit}`,
    `${targetRevision}^{commit}`
  );
  if ("failure" in answer) {
    throw new Error(
      `cannot find where ${branch} forked from target ${targetRevision}: ${answer.failure}`
    );
  }
  return answer.mergeBase;
};

/**
 * Collects the holds. Fork points need full history: in a shallow clone, or
 * when a fork point cannot be computed, this throws, so a caller deciding
 * deletions withholds every proposal instead of proposing one it could not
 * check.
 */
export const remoteBranchHolds = (
  input: RemoteBranchHoldInput
): RemoteBranchHolds => {
  const { inventory, targetBranch, targetRevision } = input;
  const { primaryCheckout } = inventory.repository;
  if (mayBeShallow(primaryCheckout)) {
    throw new Error(`fork points cannot be computed: ${SHALLOW_ADVICE}`);
  }
  const { byName, live } = remoteBranchNameHolds(input);
  const byRevision = new Map<string, string[]>();
  for (const [branch, why] of live) {
    // The target forks from itself; only its upstream (above) holds.
    if (branch === targetBranch) {
      continue;
    }
    const local = inventory.branches.find((item) => item.exactName === branch);
    const head =
      local?.sha ??
      inventory.worktrees.find((worktree) => worktree.branch === branch)
        ?.headSha;
    const point = head
      ? forkPoint(primaryCheckout, branch, head, targetRevision)
      : null;
    addHold(byRevision, point, `fork point of ${branch}, ${why}`);
  }
  return { byName, byRevision };
};

/** Every reason a branch at a head must not be deleted or reported pending. */
export const holdReasons = (
  name: string,
  headRevision: string,
  holds: RemoteBranchHolds,
  openTargets: readonly RemoteBranchOpenProposalTarget[] | null
): string[] => [
  ...(holds.byName.get(name) ?? []),
  ...(holds.byRevision.get(headRevision) ?? []),
  ...(openTargets ?? [])
    .filter((target) => target.targetBranch === name)
    .map((target) => `target of open proposal ${target.objectId}`),
];

/** Where a run pins the last head of a branch deleted outside it. */
export const EXTERNAL_DELETION_REF_PREFIX = "refs/simple-changes/external/";

/**
 * How long a pin keeps a branch deleted outside a run recoverable. A later
 * completed finalization removes it once this has passed.
 */
export const EXTERNAL_DELETION_PIN_RETENTION_DAYS = 14;

export const EXTERNAL_DELETION_PIN_RETENTION_MS =
  EXTERNAL_DELETION_PIN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * The pin ref: `refs/simple-changes/external/<runId>/<head>/<ms>`. The time
 * the pin was made is part of its name, so the ref and its age are created
 * together in one atomic `update-ref`, and nothing else records either.
 */
export const externalDeletionPinRef = (
  runId: string,
  head: string,
  pinnedAtMs: number
): string => `${EXTERNAL_DELETION_REF_PREFIX}${runId}/${head}/${pinnedAtMs}`;

export interface ExternalDeletionPin {
  head: string;
  pinnedAtMs: number;
  ref: string;
  runId: string;
}

const PIN_TIME_PATTERN = /^[0-9]{1,15}$/u;

/**
 * One `for-each-ref` line (`<refname> <objectname>`), when it is a pin this
 * module makes: exactly `<prefix><runId>/<head>/<ms>`, with a valid run ID
 * and head, pointing at that head. Anything else is not ours.
 */
export const parseExternalDeletionPin = (
  line: string
): ExternalDeletionPin | null => {
  const [ref = "", value, ...extra] = line.split(" ");
  if (!ref.startsWith(EXTERNAL_DELETION_REF_PREFIX) || extra.length > 0) {
    return null;
  }
  const [runId = "", head = "", time = "", ...rest] = ref
    .slice(EXTERNAL_DELETION_REF_PREFIX.length)
    .split("/");
  if (
    rest.length > 0 ||
    value !== head ||
    !RUN_ID_PATTERN.test(runId) ||
    !HEAD_PATTERN.test(head) ||
    !PIN_TIME_PATTERN.test(time)
  ) {
    return null;
  }
  return { head, pinnedAtMs: Number(time), ref, runId };
};

/**
 * The pins under a prefix of `refs/simple-changes/external/`. It throws when
 * Git cannot list them, so a failed listing never reads as no pin.
 */
export const listExternalDeletionPins = (
  repositoryPath: string,
  prefix: string = EXTERNAL_DELETION_REF_PREFIX
): ExternalDeletionPin[] => {
  const listed = runGit(
    repositoryPath,
    ["for-each-ref", "--format=%(refname) %(objectname)", prefix],
    true
  );
  if (listed.exitCode !== 0) {
    throw new Error(
      `cannot list pins under ${prefix}: ${listed.stderr.trim() || `exit ${listed.exitCode}`}`
    );
  }
  return listed.stdout
    .split("\n")
    .filter(Boolean)
    .map(parseExternalDeletionPin)
    .filter((pin): pin is ExternalDeletionPin => pin !== null);
};

/** The newest pin that exists now for this run and head, if any. */
export const liveExternalDeletionPin = (
  repositoryPath: string,
  runId: string,
  head: string
): ExternalDeletionPin | null =>
  listExternalDeletionPins(
    repositoryPath,
    `${EXTERNAL_DELETION_REF_PREFIX}${runId}/${head}/`
  )
    .filter((pin) => pin.runId === runId && pin.head === head)
    .reduce<ExternalDeletionPin | null>(
      (newest, pin) =>
        newest === null || pin.pinnedAtMs > newest.pinnedAtMs ? pin : newest,
      null
    );

/**
 * A branch deleted outside the run. It is never delivered or obsolete: it
 * always keeps cleanup pending so the user sees it, and it never blocks the
 * run from closing.
 */
export interface RemoteBranchExternallyDeletedItem {
  lastHeadRevision: string;
  name: string;
  note: string;
  /** When a later finalization removes the pin, when it is known. */
  pinExpiresAt?: string;
  /** The ref that keeps the last head, or null when nothing pins it. */
  pinRef: string | null;
}

export type RemoteBranchCleanupProof =
  | "merged-proposal-head"
  | "target-contained"
  | "patch-equivalent";

export interface RemoteBranchCleanupItem {
  headRevision: string;
  /** Present when the head moved or arrived during the run. */
  movedDuringRun?: true;
  name: string;
  proof: RemoteBranchCleanupProof;
  proposalObjectId?: string;
}

/**
 * What `loop finalize` reports about preserved provider branches. `pending`
 * is cleanup the user or controller can approve; `held` would be pending but
 * is still in use, so it is reported and never counted.
 */
export interface RemoteBranchCleanupReport {
  /** Present only when the receipt records a branch deleted outside the run. */
  deletedExternally?: RemoteBranchExternallyDeletedItem[];
  errors: string[];
  held: Array<RemoteBranchCleanupItem & { reasons: string[] }>;
  openProposalTargets: "recorded" | "unknown";
  pending: RemoteBranchCleanupItem[];
}

export interface RemoteBranchCleanupInput {
  claims: readonly WorktreeClaim[];
  inventory: Pick<RepositoryInventory, "branches" | "repository" | "worktrees">;
  openTargets: RemoteBranchOpenProposalTarget[] | null;
  receipt: RemoteBranchReconciliationReceipt;
  /** The run whose pins to check; without it no pin is claimed. */
  runId?: string;
}

const headIsLocal = (repositoryPath: string, head: string): boolean =>
  runGit(repositoryPath, ["cat-file", "-e", `${head}^{commit}`], true)
    .exitCode === 0;

const keepNote = (
  repositoryPath: string,
  head: string,
  pinRef: string | null,
  pinExpiresAt: string | undefined
): string => {
  if (pinRef) {
    return `Its last head is pinned at ${pinRef}${pinExpiresAt ? ` until ${pinExpiresAt}` : ""}, so the work stays recoverable; restore the branch from that ref if it is still needed.`;
  }
  if (headIsLocal(repositoryPath, head)) {
    return `Nothing pins its last head, so Git may remove it; create a branch or tag at ${head} if the work is still needed.`;
  }
  return "Its last head is not present locally, so nothing pins it; fetch it (GitLab keeps a merge request's head at refs/merge-requests/<iid>/head) if the work is still needed.";
};

/**
 * Branches the receipt records as deleted outside the run, with whether a pin
 * keeps each last head right now. The pin is checked live, so a pin that was
 * never made, failed, or was removed is never claimed.
 */
const externallyDeletedItems = (
  input: RemoteBranchCleanupInput,
  repositoryPath: string
): RemoteBranchExternallyDeletedItem[] =>
  input.receipt.branches.flatMap((entry) => {
    const head = entry.initialHeadRevision;
    if (
      !(
        head &&
        entry.finalHeadRevision === null &&
        isExternalDeletionShape(entry)
      )
    ) {
      return [];
    }
    const pin =
      input.runId === undefined
        ? null
        : liveExternalDeletionPin(repositoryPath, input.runId, head);
    const pinRef = pin?.ref ?? null;
    const pinExpiresAt = pin
      ? new Date(
          pin.pinnedAtMs + EXTERNAL_DELETION_PIN_RETENTION_MS
        ).toISOString()
      : undefined;
    return [
      {
        lastHeadRevision: head,
        name: entry.name,
        note: `This branch was deleted outside this run; its last head was ${head}. It is not counted as delivered or obsolete. ${keepNote(repositoryPath, head, pinRef, pinExpiresAt)}`,
        pinRef,
        ...(pinExpiresAt ? { pinExpiresAt } : {}),
      },
    ];
  });

// The merge base the report hands the patch audit: a commit, null when the
// head and the target share no history, or why Git could not settle it,
// including an answer git-complete.ts refused as lost or cut short.
const reportMergeBase = (
  repositoryPath: string,
  commit: string,
  target: string
): { mergeBase: string | null } | { failure: string } => {
  try {
    const answer = completeMergeBase(repositoryPath, commit, target);
    return "failure" in answer
      ? { failure: `Git could not find a merge base (${answer.failure}).` }
      : answer;
  } catch (error) {
    return {
      failure: `Git could not find a merge base (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
};

// Whether every commit of the head outside the target has a patch-id match
// in it, from the settled merge base. Every Git call on this path throws on
// failure instead of reading as "not contained", every listing is checked
// whole against Git's count, and patch evidence is used only when it is
// whole, so a lost or cut-short answer is an error, never a settled match
// or miss.
const patchEquivalence = (
  repositoryPath: string,
  head: string,
  targetRevision: string,
  mergeBase: string,
  patchIdCache: Map<string, Map<string, string>>
): boolean | "too-many" => {
  const audit = commitEquivalenceAgainstTarget(
    repositoryPath,
    head,
    targetRevision,
    {
      maxCommits: PATCH_EQUIVALENCE_MAX_COMMITS,
      mergeBase,
      targetPatchIdCache: patchIdCache,
    }
  );
  if (audit.exceededMaxCommits) {
    return "too-many";
  }
  return audit.commitCount > 0 && audit.fullyMatched;
};

/**
 * The finished-branch proof for one reportable entry, or null when Git proves
 * the target does not contain it. Reporting judges the final head alone, so a
 * branch that moved or arrived still counts when a final merged MR recorded
 * that head. A head Git cannot audit (missing locally, or too far ahead for
 * patch equivalence) is recorded as an error, which keeps cleanup pending:
 * unknown never reads as clean.
 */
const cleanupItem = (
  entry: RemoteBranchReconciliationEntry & { finalHeadRevision: string },
  receipt: RemoteBranchReconciliationReceipt,
  repositoryPath: string,
  patchIdCache: Map<string, Map<string, string>>,
  errors: string[],
  shallow: boolean
): RemoteBranchCleanupItem | null => {
  const head = entry.finalHeadRevision;
  const moved =
    entry.initialHeadRevision === head ? {} : { movedDuringRun: true as const };
  const merged = finalProposals(entry).find(
    (proposal) => proposal.state === "merged" && proposal.headRevision === head
  );
  if (merged) {
    return {
      headRevision: head,
      ...moved,
      name: entry.name,
      proof: "merged-proposal-head",
      proposalObjectId: merged.objectId,
    };
  }
  const unsettled = (why: string): null => {
    errors.push(`${entry.name} at ${head}: ${why}`);
    return null;
  };
  // Git's "no" needs full history; only a positive proof survives a shallow
  // clone.
  const notContained = (): null =>
    shallow ? unsettled(`${SHALLOW_ADVICE}.`) : null;
  if (!headIsLocal(repositoryPath, head)) {
    return unsettled(
      "the head is not present locally, so its containment could not be checked; fetch the branch and finalize again."
    );
  }
  const commit = `${head}^{commit}`;
  const target = `${receipt.targetRevision}^{commit}`;
  // The cleanup audit reads any Git failure as "not contained", which keeps a
  // local branch safely but would let a report read unknown as clean, so the
  // report settles ancestry and the merge base itself and hands that base to
  // the patch audit.
  const ancestry = runGit(
    repositoryPath,
    ["merge-base", "--is-ancestor", commit, target],
    true
  );
  if (ancestry.exitCode === 0) {
    return {
      headRevision: head,
      ...moved,
      name: entry.name,
      proof: "target-contained",
    };
  }
  if (ancestry.exitCode !== 1) {
    return unsettled(
      `Git could not check ancestry (${ancestry.stderr.trim() || `exit ${ancestry.exitCode}`}).`
    );
  }
  const base = reportMergeBase(repositoryPath, commit, target);
  if ("failure" in base) {
    return unsettled(base.failure);
  }
  if (base.mergeBase === null) {
    // No shared history: definitively not contained, given full history.
    return notContained();
  }
  try {
    const proof = patchEquivalence(
      repositoryPath,
      head,
      receipt.targetRevision,
      base.mergeBase,
      patchIdCache
    );
    if (proof === "too-many") {
      return unsettled(
        `more than ${PATCH_EQUIVALENCE_MAX_COMMITS} commits lie outside the target, too many to prove by patch equivalence; classify it yourself.`
      );
    }
    return proof
      ? {
          headRevision: head,
          ...moved,
          name: entry.name,
          proof: "patch-equivalent",
        }
      : notContained();
  } catch (error) {
    return unsettled(
      `its containment could not be checked (${error instanceof Error ? error.message : String(error)}).`
    );
  }
};

/**
 * Builds the report from the recorded receipt and fresh local evidence. A
 * preserved branch counts as pending when a final merged MR recorded its
 * final head, or when Git proves the target contains that head by exact
 * ancestry or full patch-id equivalence. Holds are applied first and move a
 * proven branch to `held`; a held branch whose audit cannot settle is left
 * out, because it is in use and not proven finished. For an unheld branch,
 * evidence Git cannot settle is an error, which keeps cleanup pending, and an
 * error computing the holds leaves every branch unheld: unknown evidence
 * reports more as pending, never fewer.
 */
export const remoteBranchCleanupReport = (
  input: RemoteBranchCleanupInput
): RemoteBranchCleanupReport => {
  const { claims, inventory, openTargets, receipt } = input;
  const repositoryPath = inventory.repository.primaryCheckout;
  const errors: string[] = [];
  const holdInput = {
    claims,
    inventory,
    targetBranch: receipt.targetBranch,
    targetRevision: receipt.targetRevision,
  };
  let holds: RemoteBranchHolds = { byName: new Map(), byRevision: new Map() };
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  try {
    holds = remoteBranchHolds(holdInput);
  } catch (error) {
    // Holds by name need no history; only fork-point holds are lost, which
    // reports more as pending, never fewer. When the holds by name cannot
    // be read either, such as when the sources of checkouts disagree, none
    // is kept at all.
    try {
      holds = {
        byName: remoteBranchNameHolds(holdInput).byName,
        byRevision: new Map(),
      };
      errors.push(
        `Fork-point holds could not be computed, so none is applied: ${message(error)}`
      );
    } catch (nameError) {
      errors.push(
        `Holds could not be computed, so none is applied: ${message(nameError)}`
      );
    }
  }
  const shallow = mayBeShallow(repositoryPath);
  const deletedExternally = externallyDeletedItems(input, repositoryPath);
  const report: RemoteBranchCleanupReport = {
    ...(deletedExternally.length > 0 ? { deletedExternally } : {}),
    errors,
    held: [],
    openProposalTargets: openTargets === null ? "unknown" : "recorded",
    pending: [],
  };
  const patchIdCache = new Map<string, Map<string, string>>();
  for (const entry of receipt.branches) {
    if (!reportable(entry, receipt.targetBranch)) {
      continue;
    }
    // Holds come first: a branch in use never counts, so what its audit
    // could not settle is not an error either.
    const reasons = holdReasons(
      entry.name,
      entry.finalHeadRevision,
      holds,
      openTargets
    );
    const item = cleanupItem(
      entry,
      receipt,
      repositoryPath,
      patchIdCache,
      reasons.length > 0 ? [] : errors,
      shallow
    );
    if (!item) {
      continue;
    }
    if (reasons.length > 0) {
      report.held.push({ ...item, reasons });
    } else {
      report.pending.push(item);
    }
  }
  return report;
};
