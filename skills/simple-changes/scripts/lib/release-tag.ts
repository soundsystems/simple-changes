import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { credentialFreeRemoteUrl } from "./inventory.ts";
import {
  type GuardedLoopCommand,
  readControllerLease,
  withGuardedLoopCommands,
} from "./loop-lease.ts";
import {
  type CommandResult,
  GuardedProcessGroupStillAliveError,
  nonInteractiveGitEnvironment,
  runGit,
  runGitRemote,
} from "./process.ts";
import { redactSecrets } from "./redact.ts";
import {
  decideReleaseGate,
  inspectChangelogTransaction,
  type ReleaseGateDecision,
} from "./release-gate.ts";
import { validateSchema } from "./schema.ts";
import { checkShipHolds, type ShipHoldReport } from "./ship-holds.ts";
import type {
  ChangelogReceipt,
  ChangelogRequest,
  LoopLease,
  ReleaseTag,
  ReleaseTagReasonCode,
  ReleaseTagReceipt,
  ReleaseTagRequiredAction,
  RepoPolicy,
  RepositoryInventory,
} from "./types.ts";

export interface ReleaseTagInput {
  agentId: string;
  alreadyLive: boolean;
  dryRun: boolean;
  priorReceipt?: unknown;
  productionAuthorized: boolean;
  productionDeploy: RepoPolicy["productionDeploy"];
  receipt: unknown;
  repositoryPath: string;
  request: unknown;
  runId: string;
  tagAutomationAuthorized: boolean;
}

const REQUIRED_ACTIONS: Record<ReleaseTagReasonCode, ReleaseTagRequiredAction> =
  {
    "local-tag-conflict": "resolve-tag-conflict",
    "push-not-authorized": "push-manually",
    "push-rejected": "retry-after-fix",
    "readback-failed": "retry-after-fix",
    "release-not-crossed": "await-release-authority",
    "remote-not-single-url": "push-manually",
    "shipment-hold": "resolve-hold",
    "tag-automation-unreviewed": "review-tag-automation",
    "tag-create-failed": "retry-after-fix",
    "tag-exists-elsewhere": "resolve-tag-conflict",
    "target-moved": "refresh-and-reclassify",
    "target-not-contained": "refresh-and-reverify",
  };

// Well-known CI configuration locations, read at the target as a reminder of
// what a tag push may start. Listing them proves nothing about any trigger;
// the controller's own inventory decides `--tag-automation-authorized`.
const CI_CONFIGURATION_PATHS = [
  ".appveyor.yml",
  ".azure-pipelines",
  ".buildkite",
  ".circleci",
  ".cirrus.yml",
  ".drone.yml",
  ".forgejo/workflows",
  ".gitea/workflows",
  ".github/workflows",
  ".gitlab-ci.yml",
  ".tekton",
  ".travis.yml",
  ".woodpecker",
  ".woodpecker.yml",
  "Jenkinsfile",
  "appveyor.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "buildspec.yml",
  "cloudbuild.yaml",
  "cloudbuild.yml",
] as const;

const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;
const PEELED_SUFFIX = "^{}";
const TAG_REF_PREFIX = "refs/tags/";
const PLAIN_SHELL_WORD_PATTERN = /^[\w./@+-]+$/u;

interface ResolvedTag {
  message: string;
  name: string;
  /** The finalized target; null for a prepared dry run before the merge. */
  target: string | null;
  version: string;
}

interface RemoteTag {
  object: string;
  /** The commit (or other object) the tag finally points to. */
  peeled: string;
}

type Outcome = Pick<
  ReleaseTagReceipt,
  "manualCommands" | "reason" | "reasonCode" | "requiredAction" | "status"
> & { tagObject?: string | null };

const outcome = (
  status: ReleaseTagReceipt["status"],
  reason: string | null,
  tagObject: string | null = null
): Outcome => ({
  manualCommands: [],
  reason,
  reasonCode: null,
  requiredAction: null,
  status,
  tagObject,
});

const blocked = (
  reasonCode: ReleaseTagReasonCode,
  reason: string,
  manualCommands: string[] = []
): Outcome => ({
  manualCommands,
  reason,
  reasonCode,
  requiredAction: REQUIRED_ACTIONS[reasonCode],
  status: "blocked",
  tagObject: null,
});

const shellWord = (value: string): string =>
  PLAIN_SHELL_WORD_PATTERN.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;

// What the user runs to publish the tag by hand: an annotated tag on the exact
// target, then that one ref, never `--tags` or a follow-tags push.
const manualCommandsFor = (
  tag: ResolvedTag,
  remote: string | null
): string[] =>
  tag.target === null
    ? []
    : [
        `git tag -a ${shellWord(tag.name)} -m ${shellWord(tag.message)} ${tag.target}`,
        `git push --no-follow-tags ${shellWord(remote ?? "<remote>")} ${shellWord(`${TAG_REF_PREFIX}${tag.name}`)}`,
      ];

const short = (revision: string): string => revision.slice(0, 12);

// A push through a remote with several URLs reaches every one of them, so no
// runnable push command is offered until the remote has one destination.
const SINGLE_URL_ADVICE =
  "Give the remote one URL for fetch and push and re-run release-tag, or publish the tag yourself to the one intended destination.";

const URL_CREDENTIALS_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu;

// Git's own words for the user, without secrets or URL credentials.
const redacted = (text: string): string =>
  redactSecrets(text).replace(URL_CREDENTIALS_PATTERN, "$1");

const gitDetail = (result: CommandResult): string =>
  redacted(result.stderr.trim() || result.stdout.trim()) ||
  `exit ${result.exitCode}`;

const errorDetail = (error: unknown): string =>
  redacted(error instanceof Error ? error.message : String(error));

/**
 * The receipt's release and tag, when this receipt drives tag work: receipt
 * v4, a prepared or verified release that names a tag, on a public boundary.
 * Anything else is not applicable and returns why.
 */
const applicableTag = (
  request: ChangelogRequest,
  receipt: ChangelogReceipt
): { reason: string } | { tag: ResolvedTag } => {
  if (receipt.schemaVersion !== 4) {
    return {
      reason: `Receipt v${receipt.schemaVersion} names no release tag; the changelog provider predates release tags.`,
    };
  }
  if (request.boundary === "none") {
    return {
      reason: "Operator-history entries on the none boundary are never tagged.",
    };
  }
  if (receipt.status !== "prepared" && receipt.status !== "verified") {
    return {
      reason: `Only prepared and verified receipts drive tag work; this receipt is ${receipt.status}.`,
    };
  }
  const tag: ReleaseTag | null = receipt.release?.tag ?? null;
  if (!(receipt.release && tag)) {
    return {
      reason:
        "The release names no tag; this repository does not tag releases.",
    };
  }
  return {
    tag: {
      message: tag.message,
      name: tag.name,
      target:
        receipt.status === "verified"
          ? receipt.revisionLineage.finalizedTargetRevision
          : null,
      version: receipt.release.version,
    },
  };
};

// The lease's target remote and branch, from the lease's own target ref and
// remote bindings; the longest bound remote name that prefixes the ref wins.
const leaseTarget = (
  lease: LoopLease
): { branch: string; remote: string } | null => {
  const names = (lease.remoteBindings ?? [])
    .map((binding) => binding.name)
    .filter((name) => lease.targetRef.startsWith(`${name}/`))
    .sort((left, right) => right.length - left.length);
  const [remote] = names;
  if (!remote) {
    return null;
  }
  const branch = lease.targetRef.slice(remote.length + 1);
  return branch ? { branch, remote } : null;
};

const liveRemoteUrls = (
  root: string,
  remote: string,
  push: boolean
): string[] => {
  const result = runGit(
    root,
    ["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote],
    true
  );
  return result.exitCode === 0 ? result.stdout.split("\n").filter(Boolean) : [];
};

/**
 * One destination only: the remote has exactly one URL, the same for fetch
 * and push, equal in credential-free form to the lease binding. Git pushes to
 * every push URL while readback, holds, and remote-tracking refs follow the
 * fetch URL, so anything else could publish somewhere no check covered.
 */
const singleUrlProblem = (
  root: string,
  lease: LoopLease,
  target: { remote: string } | null
): string | null => {
  if (!target) {
    return `The run's target ${lease.targetRef} names no bound remote, so there is no single destination to push the tag to.`;
  }
  const fetchUrls = liveRemoteUrls(root, target.remote, false);
  const pushUrls = liveRemoteUrls(root, target.remote, true);
  const [fetchUrl] = fetchUrls;
  if (
    !fetchUrl ||
    fetchUrls.length !== 1 ||
    pushUrls.length !== 1 ||
    pushUrls[0] !== fetchUrl
  ) {
    return `Remote ${target.remote} must have exactly one URL, the same for fetch and push; it has ${fetchUrls.length} fetch and ${pushUrls.length} push URL(s).`;
  }
  const binding = lease.remoteBindings?.find(
    (candidate) => candidate.name === target.remote
  );
  const bound = credentialFreeRemoteUrl(fetchUrl);
  if (
    binding?.fetchUrls.length !== 1 ||
    binding.pushUrls.length !== 1 ||
    binding.fetchUrls[0] !== bound ||
    binding.pushUrls[0] !== bound
  ) {
    return `Remote ${target.remote} no longer matches the URL this run is bound to.`;
  }
  return null;
};

/** Every remote tag and what it peels to, from one `ls-remote --tags`. */
const readRemoteTags = (
  root: string,
  remote: string
): Map<string, RemoteTag> | string => {
  const listing = runGitRemote(root, ["ls-remote", "--tags", remote]);
  if (listing.exitCode !== 0) {
    return gitDetail(listing);
  }
  const objects = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of listing.stdout.split("\n")) {
    const [object, ref] = line.split("\t");
    if (!(object && ref?.startsWith(TAG_REF_PREFIX))) {
      continue;
    }
    const name = ref.slice(TAG_REF_PREFIX.length);
    if (name.endsWith(PEELED_SUFFIX)) {
      peeled.set(name.slice(0, -PEELED_SUFFIX.length), object);
    } else {
      objects.set(name, object);
    }
  }
  return new Map(
    [...objects].map(([name, object]) => [
      name,
      { object, peeled: peeled.get(name) ?? object },
    ])
  );
};

const localTagNames = (root: string): string[] =>
  runGit(root, ["for-each-ref", "--format=%(refname)", TAG_REF_PREFIX])
    .stdout.split("\n")
    .filter((ref) => ref.startsWith(TAG_REF_PREFIX))
    .map((ref) => ref.slice(TAG_REF_PREFIX.length));

const TAG_MESSAGE_PATTERN = /\n\n([\s\S]*)$/u;

// How an existing tag on the target differs from the one this release names:
// a lightweight tag, or an annotated tag with another message when its object
// is available here. It is reported, never rewritten.
const describeExisting = (
  root: string,
  tag: ResolvedTag,
  existing: RemoteTag
): string => {
  if (existing.object === existing.peeled) {
    return " as a lightweight tag";
  }
  const body = runGit(root, ["cat-file", "tag", existing.object], true);
  if (body.exitCode !== 0) {
    return "";
  }
  const message = TAG_MESSAGE_PATTERN.exec(body.stdout)?.[1]?.trim() ?? "";
  return message === tag.message ? "" : ` with another message (${message})`;
};

// Tag names are hierarchical: `release` blocks `release/1.2.0`, and
// `v1.2.0/build45` blocks `v1.2.0`.
const hierarchyConflict = (name: string, existing: string): boolean =>
  existing.startsWith(`${name}/`) || name.startsWith(`${existing}/`);

/**
 * Decide from remote and local tag state alone: already on the target, taken,
 * a local-only conflict, or free (null).
 */
const classifyExisting = (
  root: string,
  tag: ResolvedTag,
  remoteTags: Map<string, RemoteTag>,
  localNames: string[]
): Outcome | null => {
  const exact = remoteTags.get(tag.name);
  if (exact) {
    if (tag.target !== null && exact.peeled === tag.target) {
      return outcome(
        "already-present",
        `${tag.name} is already on the remote at ${short(tag.target)}${describeExisting(root, tag, exact)}; nothing was pushed and it is never rewritten.`,
        exact.object
      );
    }
    return blocked(
      "tag-exists-elsewhere",
      tag.target === null
        ? `${tag.name} already exists on the remote at ${short(exact.peeled)}, so version ${tag.version} is taken; reclassify before merging.`
        : `${tag.name} already exists on the remote at ${short(exact.peeled)}, not the verified target ${short(tag.target)}; it is never moved. Stop and ask.`
    );
  }
  const remoteHierarchy = [...remoteTags.keys()].find((name) =>
    hierarchyConflict(tag.name, name)
  );
  const localHierarchy = localNames.find((name) =>
    hierarchyConflict(tag.name, name)
  );
  const hierarchy = remoteHierarchy ?? localHierarchy;
  if (hierarchy !== undefined) {
    return blocked(
      "tag-exists-elsewhere",
      `Tag ${hierarchy} ${remoteHierarchy === undefined ? "exists locally" : "exists on the remote"}, and Git cannot hold both it and ${tag.name}.`
    );
  }
  if (localNames.includes(tag.name)) {
    return blocked(
      "local-tag-conflict",
      `A local tag ${tag.name} exists but the remote has none; it is never pushed, replaced, or deleted. Resolve it by hand.`
    );
  }
  return null;
};

const ciConfigurationFiles = (
  root: string,
  revision: string | null
): string[] => {
  if (revision === null) {
    return [];
  }
  const listing = runGit(
    root,
    [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      revision,
      "--",
      ...CI_CONFIGURATION_PATHS,
    ],
    true
  );
  return listing.exitCode === 0
    ? listing.stdout.split("\0").filter(Boolean).sort()
    : [];
};

const commitIsLocal = (root: string, revision: string): boolean =>
  runGit(root, ["cat-file", "-e", `${revision}^{commit}`], true).exitCode === 0;

const remoteBranchHead = (
  root: string,
  remote: string,
  branch: string
): string | null | { error: string } => {
  const ref = `refs/heads/${branch}`;
  const listing = runGitRemote(root, ["ls-remote", remote, ref]);
  if (listing.exitCode !== 0) {
    return { error: gitDetail(listing) };
  }
  const line = listing.stdout
    .split("\n")
    .map((entry) => entry.split("\t"))
    .find(([, name]) => name === ref);
  return line?.[0] ?? null;
};

// A guard refusal or a failed start leaves the step undone; only a process
// group that survived must keep the lock for explicit recovery.
const guardedStep = async (
  runGuarded: GuardedLoopCommand,
  argv: string[],
  input?: { environment?: Record<string, string>; stdin?: string }
): Promise<CommandResult> => {
  try {
    return await runGuarded(argv, input);
  } catch (error) {
    if (error instanceof GuardedProcessGroupStillAliveError) {
      throw error;
    }
    return { exitCode: 1, stderr: errorDetail(error), stdout: "" };
  }
};

type TargetCheck =
  | { kind: "current" }
  | { kind: "blocked"; outcome: Outcome }
  | { head: string; kind: "needs-fetch" };

/**
 * The target is still current for its boundary, read without writing. A
 * release-bearing merge, or a release already live, crossed its public
 * boundary at the target, so the target only has to be contained in the
 * refreshed branch. Any other deploy is not public yet and must deploy the
 * freshly resolved head, so the target must equal it. A containment check
 * whose branch head is not local yet needs one fetch, which waits until every
 * refusal has passed.
 */
const readTargetCheck = (
  root: string,
  target: { branch: string; remote: string },
  revision: string,
  containmentSuffices: boolean
): TargetCheck => {
  const head = remoteBranchHead(root, target.remote, target.branch);
  if (head !== null && typeof head === "object") {
    return {
      kind: "blocked",
      outcome: blocked(
        "target-not-contained",
        `Could not read ${target.remote} ${target.branch}: ${head.error}`
      ),
    };
  }
  if (head === null) {
    return {
      kind: "blocked",
      outcome: blocked(
        "target-not-contained",
        `${target.remote} has no branch ${target.branch} to contain ${short(revision)}.`
      ),
    };
  }
  if (head === revision) {
    return { kind: "current" };
  }
  if (!containmentSuffices) {
    return {
      kind: "blocked",
      outcome: blocked(
        "target-moved",
        `${target.remote}/${target.branch} moved to ${short(head)} after verification of ${short(revision)}; the deployment must use the fresh head, so reclassify.`
      ),
    };
  }
  return commitIsLocal(root, head)
    ? containment(root, target, revision, head)
    : { head, kind: "needs-fetch" };
};

const containment = (
  root: string,
  target: { branch: string; remote: string },
  revision: string,
  head: string
): TargetCheck =>
  runGit(root, ["merge-base", "--is-ancestor", revision, head], true)
    .exitCode === 0
    ? { kind: "current" }
    : {
        kind: "blocked",
        outcome: blocked(
          "target-not-contained",
          `The verified target ${short(revision)} is not contained in ${target.remote}/${target.branch} at ${short(head)}.`
        ),
      };

// Fetch only the target branch, with no tags, then prove containment.
const fetchAndCheckContainment = async (
  root: string,
  runGuarded: GuardedLoopCommand,
  target: { branch: string; remote: string },
  revision: string,
  head: string
): Promise<Outcome | null> => {
  const fetched = await guardedStep(
    runGuarded,
    ["git", "fetch", "--no-tags", target.remote, `refs/heads/${target.branch}`],
    { environment: nonInteractiveGitEnvironment(root) }
  );
  if (fetched.exitCode !== 0 || !commitIsLocal(root, head)) {
    return blocked(
      "target-not-contained",
      `Could not refresh ${target.remote}/${target.branch} at ${short(head)}: ${gitDetail(fetched)}`
    );
  }
  const checked = containment(root, target, revision, head);
  return checked.kind === "blocked" ? checked.outcome : null;
};

const holdProblem = (reports: ShipHoldReport[]): Outcome | null => {
  const held = reports.filter((report) => !report.clear);
  if (held.length === 0) {
    return null;
  }
  const holds = [
    ...new Set(
      held.flatMap((report) => [
        ...report.blocking.map((item) => item.hold.holdId),
        ...(report.remote.status === "unavailable"
          ? [`unreadable holds on ${report.remote.name}`]
          : []),
      ])
    ),
  ];
  const steps = [...new Set(held.flatMap((report) => report.nextSteps))];
  return blocked(
    "shipment-hold",
    `A tag push can start a deployment or a migration, and shipment holds block them: ${holds.join(", ")}.${steps.length > 0 ? ` ${steps.join(" ")}` : ""}`
  );
};

const tagObjectInput = (tag: ResolvedTag, target: string, tagger: string) =>
  `object ${target}\ntype commit\ntag ${tag.name}\ntagger ${tagger}\n\n${tag.message}\n`;

const readbackOutcome = (
  root: string,
  remote: string,
  tag: ResolvedTag,
  target: string,
  objectId: string
): Outcome | null => {
  const remoteTags = readRemoteTags(root, remote);
  if (typeof remoteTags === "string") {
    return null;
  }
  const found = remoteTags.get(tag.name);
  if (!found || found.peeled !== target) {
    return null;
  }
  return found.object === objectId
    ? outcome(
        "created",
        `Tagged ${tag.name} on ${short(target)} and pushed it to ${remote}.`,
        objectId
      )
    : outcome(
        "already-present",
        `Another writer published ${tag.name} on ${short(target)} first; this run's tag was not used and no local tag was installed.`,
        found.object
      );
};

/**
 * Build the annotated tag object with no ref, push only that object to the
 * one remote, read it back, and only then install the local ref create-only.
 * No local tag ref exists until the remote has the tag, so nothing a failed
 * run leaves can be published later by a follow-tags branch push.
 */
const publishTag = async (
  root: string,
  runGuarded: GuardedLoopCommand,
  remote: string,
  tag: ResolvedTag,
  target: string
): Promise<Outcome> => {
  const tagger = runGit(root, ["var", "GIT_COMMITTER_IDENT"], true);
  if (tagger.exitCode !== 0 || !tagger.stdout.trim()) {
    return blocked(
      "tag-create-failed",
      `Git has no committer identity for the tagger: ${gitDetail(tagger)}`
    );
  }
  const built = await guardedStep(runGuarded, ["git", "mktag"], {
    stdin: tagObjectInput(tag, target, tagger.stdout.trim()),
  });
  const objectId = built.stdout.trim();
  if (built.exitCode !== 0 || !OBJECT_ID_PATTERN.test(objectId)) {
    return blocked(
      "tag-create-failed",
      `git mktag could not build ${tag.name}: ${gitDetail(built)}`
    );
  }
  const pushed = await guardedStep(
    runGuarded,
    [
      "git",
      "push",
      "--no-follow-tags",
      remote,
      `${objectId}:${TAG_REF_PREFIX}${tag.name}`,
    ],
    { environment: nonInteractiveGitEnvironment(root) }
  );
  // Any nonzero push is blocked with Git's own words, whatever the remote
  // shows now; a re-run reads the remote again and reports what is there.
  if (pushed.exitCode !== 0) {
    return blocked(
      "push-rejected",
      `${remote} rejected ${tag.name}; nothing local was installed. Git said: ${gitDetail(pushed)}`,
      manualCommandsFor(tag, remote)
    );
  }
  const readback = readbackOutcome(root, remote, tag, target, objectId);
  if (!readback) {
    return blocked(
      "readback-failed",
      `The push of ${tag.name} reported success, but ${remote} does not show it on ${short(target)}; no local tag was installed.`
    );
  }
  if (readback.status !== "created") {
    return readback;
  }
  const installed = await guardedStep(runGuarded, [
    "git",
    "update-ref",
    `${TAG_REF_PREFIX}${tag.name}`,
    objectId,
    "",
  ]);
  return installed.exitCode === 0
    ? readback
    : {
        ...readback,
        reason: `${readback.reason} The local ref was not installed (${gitDetail(installed)}); an ordinary fetch brings it.`,
      };
};

interface TagContext {
  gate: ReleaseGateDecision;
  input: ReleaseTagInput;
  request: ChangelogRequest;
  tag: ResolvedTag;
}

// Every refusal that must come before any write, in the documented order.
const preWriteProblem = async (
  context: TagContext,
  root: string,
  runGuarded: GuardedLoopCommand,
  target: { branch: string; remote: string },
  revision: string,
  inventory: RepositoryInventory
): Promise<Outcome | null> => {
  const { gate, input, request, tag } = context;
  const crossed =
    gate.action === "deploy" || gate.action === "verify-existing-production";
  const current = readTargetCheck(
    root,
    target,
    revision,
    request.boundary === "release-bearing-merge" ||
      gate.action === "verify-existing-production"
  );
  if (current.kind === "blocked") {
    return current.outcome;
  }
  if (!crossed) {
    return blocked(
      "release-not-crossed",
      `The release gate answers ${gate.action}, so the release has not crossed its public boundary and ${tag.name} waits for it.`
    );
  }
  if (!input.tagAutomationAuthorized) {
    return blocked(
      "tag-automation-unreviewed",
      `Pass --tag-automation-authorized only after listing every CI job a push of ${tag.name} can start and confirming each effect is authorized.`
    );
  }
  const holds = holdProblem(
    (["deploy", "migrations"] as const).map((action) =>
      checkShipHolds(root, { action, runId: input.runId })
    )
  );
  if (holds) {
    return holds;
  }
  if (inventory.policy.value.gitPushAuthorization === "never") {
    return blocked(
      "push-not-authorized",
      `This repository's policy never lets agents push, so publish ${tag.name} yourself with the commands below.`,
      manualCommandsFor(tag, target.remote)
    );
  }
  // The only write before the tag itself, after every refusal.
  return current.kind === "needs-fetch"
    ? await fetchAndCheckContainment(
        root,
        runGuarded,
        target,
        revision,
        current.head
      )
    : null;
};

const applyTag = async (
  context: TagContext,
  lease: LoopLease
): Promise<{ outcome: Outcome; remote: string | null }> => {
  const { input, tag } = context;
  const guarded = await withGuardedLoopCommands(
    input.repositoryPath,
    input.runId,
    input.agentId,
    "release-tag",
    async (runGuarded, inventory) => {
      const root = inventory.repository.currentCheckout;
      const target = leaseTarget(lease);
      const remote = target?.remote ?? null;
      const urlProblem = singleUrlProblem(root, lease, target);
      if (urlProblem || !target) {
        return {
          outcome: blocked(
            "remote-not-single-url",
            `${urlProblem ?? "No target remote."} ${SINGLE_URL_ADVICE}`
          ),
          remote,
        };
      }
      const revision = tag.target;
      if (revision === null) {
        return {
          outcome: blocked(
            "release-not-crossed",
            "Only a verified receipt names the commit to tag."
          ),
          remote,
        };
      }
      const existing = remoteAndLocal(root, target.remote, tag);
      if (existing) {
        return { outcome: existing, remote };
      }
      const problem = await preWriteProblem(
        context,
        root,
        runGuarded,
        target,
        revision,
        inventory
      );
      return {
        outcome:
          problem ??
          (await publishTag(root, runGuarded, target.remote, tag, revision)),
        remote,
      };
    },
    { controllerOnly: true }
  );
  return guarded.result;
};

const remoteAndLocal = (
  root: string,
  remote: string,
  tag: ResolvedTag
): Outcome | null => {
  const remoteTags = readRemoteTags(root, remote);
  if (typeof remoteTags === "string") {
    throw new SimpleChangesError(
      `Could not list tags on ${remote}, so nothing was decided: ${remoteTags}`,
      EXIT_CODES.inventory
    );
  }
  return classifyExisting(root, tag, remoteTags, localTagNames(root));
};

const dryRunTag = (
  context: TagContext,
  lease: LoopLease
): { outcome: Outcome; remote: string | null } => {
  const { input, tag } = context;
  const root = input.repositoryPath;
  const target = leaseTarget(lease);
  const remote = target?.remote ?? null;
  const urlProblem = singleUrlProblem(root, lease, target);
  if (urlProblem || !target) {
    return {
      outcome: blocked(
        "remote-not-single-url",
        `${urlProblem ?? "No target remote."} ${SINGLE_URL_ADVICE}`
      ),
      remote,
    };
  }
  return {
    outcome:
      remoteAndLocal(root, target.remote, tag) ??
      outcome(
        "ready",
        `${tag.name} is free on ${target.remote} and locally${tag.target === null ? "; the release can merge" : "; it has not been published yet"}.`
      ),
    remote,
  };
};

const assertTagNameFormat = (root: string, name: string): string | null => {
  const checked = runGit(
    root,
    ["check-ref-format", `${TAG_REF_PREFIX}${name}`],
    true
  );
  return checked.exitCode === 0
    ? null
    : `${name} is not a valid Git tag name (git check-ref-format refused it).`;
};

/**
 * Publish, or check, the release tag a receipt v4 names. Inputs are
 * validated exactly as `release-gate` validates them; only the active run's
 * own controller may run it, so it never runs in Sync or from a delegated
 * author. It never moves, replaces, or deletes a tag.
 */
export const runReleaseTag = async (
  input: ReleaseTagInput
): Promise<ReleaseTagReceipt> => {
  const validation = inspectChangelogTransaction(
    input.request,
    input.receipt,
    input.priorReceipt
  );
  if (validation.priorReceiptDigestStatus === "unverified") {
    throw new SimpleChangesError(
      "The later release phase is not bound to its prior receipt. Pass the exact prior receipt with --prior-receipt.",
      EXIT_CODES.validation
    );
  }
  const request = input.request as ChangelogRequest;
  const { receipt } = validation;
  const lease = readControllerLease(
    input.repositoryPath,
    input.runId,
    input.agentId
  );
  const mode = input.dryRun ? "dry-run" : "apply";
  const base = {
    releaseTrain: request.releaseTrain,
    schemaVersion: 1 as const,
    transactionId: request.transactionId,
  };
  const applicable = applicableTag(request, receipt);
  if ("reason" in applicable) {
    return validateSchema<ReleaseTagReceipt>("release-tag-receipt", {
      ...base,
      ciConfigurationFiles: [],
      manualCommands: [],
      mode,
      name: null,
      reason: applicable.reason,
      reasonCode: null,
      remote: null,
      requiredAction: null,
      status: "not-applicable",
      tagObject: null,
      target: null,
      version:
        receipt.schemaVersion === 1 ? null : (receipt.release?.version ?? null),
    });
  }
  const { tag } = applicable;
  const gate = decideReleaseGate({
    alreadyLive: input.alreadyLive,
    ...(input.priorReceipt === undefined
      ? {}
      : { priorReceipt: input.priorReceipt as ChangelogReceipt }),
    productionAuthorized: input.productionAuthorized,
    productionDeploy: input.productionDeploy,
    receipt,
    request,
    versionAuthorized: false,
  });
  const context: TagContext = { gate, input, request, tag };
  const formatProblem = assertTagNameFormat(input.repositoryPath, tag.name);
  const result = formatProblem
    ? { outcome: blocked("tag-create-failed", formatProblem), remote: null }
    : await (input.dryRun
        ? dryRunTag(context, lease)
        : applyTag(context, lease));
  const ciRevision =
    tag.target ??
    (receipt.schemaVersion === 1
      ? null
      : receipt.revisionLineage.reconciliationHeadRevision);
  return validateSchema<ReleaseTagReceipt>("release-tag-receipt", {
    ...base,
    ciConfigurationFiles: ciConfigurationFiles(
      input.repositoryPath,
      ciRevision
    ),
    manualCommands: result.outcome.manualCommands,
    mode,
    name: tag.name,
    reason: result.outcome.reason,
    reasonCode: result.outcome.reasonCode,
    remote: result.remote,
    requiredAction: result.outcome.requiredAction,
    status: result.outcome.status,
    tagObject: result.outcome.tagObject ?? null,
    target: tag.target,
    version: tag.version,
  });
};
