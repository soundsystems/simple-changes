import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { startLoop } from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import { changelogReceiptDigest } from "../../../skills/simple-changes/scripts/lib/release-gate.ts";
import {
  type ReleaseTagInput,
  runReleaseTag,
} from "../../../skills/simple-changes/scripts/lib/release-tag.ts";
import {
  addShipHold,
  waiveShipHold,
} from "../../../skills/simple-changes/scripts/lib/ship-holds.ts";
import type {
  ChangelogReceiptV2,
  ChangelogReceiptV3,
  ChangelogReceiptV4,
  ChangelogRequest,
  ReleaseBoundary,
  ReleaseTag,
} from "../../../skills/simple-changes/scripts/lib/types.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(60_000);
const decoder = new TextDecoder();
const cliPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/simple-changes/scripts/simple-changes.ts"
);
const fixtures: TestRepository[] = [];
const restoredEnvironment: Record<string, string | undefined> = {};

afterEach(() => {
  for (const fixture of fixtures) {
    fixture.cleanup();
  }
  fixtures.length = 0;
  for (const [name, value] of Object.entries(restoredEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    delete restoredEnvironment[name];
  }
});

const setEnvironment = (name: string, value: string): void => {
  if (!(name in restoredEnvironment)) {
    restoredEnvironment[name] = process.env[name];
  }
  process.env[name] = value;
};

const digest = "d".repeat(64);
const TAG = { message: "Acme Web 1.4.0", name: "v1.4.0" };
const CONTROLLER = "controller";

// Records each argv it sees outside the repository and refuses, or runs a
// side effect, only when the test asks for it.
const GUARD_SCRIPT = `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
appendFileSync(process.env.RELEASE_TAG_GUARD_RECORD, JSON.stringify(argv) + "\\n");
const refuse = process.env.RELEASE_TAG_GUARD_REFUSE;
if (refuse && argv.includes(refuse)) {
  process.exit(7);
}
const before = process.env.RELEASE_TAG_GUARD_BEFORE_PUSH;
if (before && argv[1] === "push") {
  const result = spawnSync("sh", ["-c", before], { stdio: "inherit" });
  if (result.status !== 0) process.exit(9);
}
if (process.env.RELEASE_TAG_GUARD_KILL_ON_PUSH && argv[1] === "push") {
  process.kill(process.ppid, "SIGKILL");
  process.exit(0);
}
process.exit(0);
`;

interface Fixture extends TestRepository {
  bare: string;
  guardRecords: () => string[][];
  input: string;
  target: string;
}

interface FixtureOptions {
  execGuard?: boolean;
  policy?: Record<string, unknown>;
}

const remoteTags = (bare: string): Record<string, string> =>
  Object.fromEntries(
    git(bare, [
      "for-each-ref",
      "--format=%(refname:strip=2) %(objectname)",
      "refs/tags",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ") as [string, string])
  );

const localTagRef = (root: string, name: string): string | null => {
  const result = spawnSync(
    [
      "git",
      "-C",
      root,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/tags/${name}`,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  return result.exitCode === 0 ? decoder.decode(result.stdout).trim() : null;
};

const peel = (bare: string, name: string): string =>
  git(bare, ["rev-parse", `refs/tags/${name}^{commit}`]);

/**
 * A repository with a bare `origin`, an input commit, and a released commit
 * on `main`, both pushed, with an active Ship controller lease.
 */
const releaseFixture = (options: FixtureOptions = {}): Fixture => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  const bare = join(fixture.base, "origin.git");
  git(fixture.base, ["init", "--bare", "-b", "main", bare]);
  git(fixture.root, ["remote", "add", "origin", bare]);
  const recordPath = join(fixture.base, "guard-record.jsonl");
  setEnvironment("RELEASE_TAG_GUARD_RECORD", recordPath);
  if (options.execGuard) {
    writeFixture(fixture.root, "scripts/release-tag-guard.ts", GUARD_SCRIPT);
  }
  if (options.execGuard || options.policy) {
    writeFixture(
      fixture.root,
      ".simple-changes.json",
      `${JSON.stringify(
        {
          ...DEFAULT_POLICY,
          ...(options.execGuard
            ? {
                execGuard: [process.execPath, "scripts/release-tag-guard.ts"],
              }
            : {}),
          ...options.policy,
        },
        null,
        2
      )}\n`
    );
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Add policy"]);
  }
  const input = git(fixture.root, ["rev-parse", "HEAD"]);
  writeFixture(fixture.root, "CHANGELOG.md", "# Changelog\n\n## 1.4.0\n");
  git(fixture.root, ["add", "CHANGELOG.md"]);
  git(fixture.root, ["commit", "-m", "chore(release): 1.4.0"]);
  const target = git(fixture.root, ["rev-parse", "HEAD"]);
  git(fixture.root, ["push", "-u", "origin", "main"]);
  const guardRecords = (): string[][] =>
    existsSync(recordPath)
      ? readFileSync(recordPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
      : [];
  return { ...fixture, bare, guardRecords, input, target };
};

const startController = (fixture: Fixture) =>
  startLoop(fixture.root, CONTROLLER, "ship");

const requestV3 = (
  fixture: Fixture,
  phase: "prepare" | "verify",
  overrides: Partial<ChangelogRequest> = {}
): ChangelogRequest => ({
  approvedDecisionDigest: digest,
  approvedVersion: "1.4.0",
  boundary: "web-production",
  finalizedTargetRevision: phase === "verify" ? fixture.target : null,
  inputTargetRevision: fixture.input,
  mutationScope: phase === "prepare" ? "prepare-release-files" : "read-only",
  phase,
  priorReceiptDigest: null,
  releaseSetId: null,
  releaseSetTrains: null,
  releaseTrain: "web",
  schemaVersion: 3,
  supportedReceiptVersions: [1, 2, 3, 4],
  transactionId: "release-1.4.0",
  ...overrides,
});

const receiptV4 = (
  fixture: Fixture,
  status: "prepared" | "verified",
  boundary: ReleaseBoundary = "web-production",
  tag: ReleaseTag | null = TAG
): ChangelogReceiptV4 => ({
  checks: ["Inspected the exact target."],
  decisionDigest: digest,
  effectivePolicyDigest: "e".repeat(64),
  evidence: ["Customer-visible change."],
  observedAt: "2026-10-07T12:00:00-05:00",
  paths:
    status === "prepared"
      ? [{ digest: "f".repeat(64), path: "CHANGELOG.md" }]
      : [],
  phase: status === "prepared" ? "prepare" : "verify",
  provider: "simple-changelogs",
  reason: null,
  reasonCode: null,
  release: {
    date: "2026-10-07",
    tag,
    targetContainedUnreleased:
      status === "prepared" ? "prepared" : "integrated",
    version: "1.4.0",
  },
  releaseImpact: "minor",
  releaseSetId: null,
  releaseSetTrains: null,
  requiredAction: null,
  revisionLineage: {
    finalizedTargetRevision: status === "verified" ? fixture.target : null,
    inputTargetRevision: fixture.input,
    reconciliationHeadRevision: fixture.target,
  },
  schemaVersion: 4,
  sourceRevision: status === "verified" ? fixture.target : fixture.input,
  status,
  transactionId: "release-1.4.0",
  versionDecision: {
    boundary,
    bumpLevel: "minor",
    currentVersion: "1.3.0",
    policyAction: "automatic",
    releaseTrain: "web",
    resolution: "automatic",
    selectedVersion: "1.4.0",
    source: "repository-policy",
    suggestedVersion: "1.4.0",
    versionLine: null,
  },
});

interface Phase {
  priorReceipt?: unknown;
  receipt: unknown;
  request: unknown;
}

const prepared = (
  fixture: Fixture,
  boundary: ReleaseBoundary = "web-production",
  tag: ReleaseTag | null = TAG
): Phase => ({
  receipt: receiptV4(fixture, "prepared", boundary, tag),
  request: requestV3(fixture, "prepare", { boundary }),
});

const verified = (
  fixture: Fixture,
  boundary: ReleaseBoundary = "web-production",
  tag: ReleaseTag | null = TAG
): Phase => {
  const prior = receiptV4(fixture, "prepared", boundary, tag);
  return {
    priorReceipt: prior,
    receipt: receiptV4(fixture, "verified", boundary, tag),
    request: requestV3(fixture, "verify", {
      boundary,
      priorReceiptDigest: changelogReceiptDigest(prior),
    }),
  };
};

const releaseTag = (
  fixture: Fixture,
  phase: Phase,
  overrides: Partial<ReleaseTagInput> = {}
) =>
  runReleaseTag({
    agentId: CONTROLLER,
    alreadyLive: false,
    dryRun: false,
    productionAuthorized: true,
    productionDeploy: "ask",
    repositoryPath: fixture.root,
    runId: overrides.runId ?? "",
    tagAutomationAuthorized: true,
    ...phase,
    ...overrides,
  });

const withRun = (fixture: Fixture) => {
  const lease = startController(fixture);
  return (phase: Phase, overrides: Partial<ReleaseTagInput> = {}) =>
    releaseTag(fixture, phase, { runId: lease.runId, ...overrides });
};

/** Publish a tag on the remote from a separate clone, as another writer. */
const publishElsewhere = (
  fixture: Fixture,
  name: string,
  revision: string,
  message = "Elsewhere"
): void => {
  const clone = join(fixture.base, `writer-${name.replaceAll("/", "-")}`);
  if (!existsSync(clone)) {
    git(fixture.base, ["clone", "--quiet", fixture.bare, clone]);
    git(clone, ["config", "user.name", "Other Writer"]);
    git(clone, ["config", "user.email", "other@simple-changes.invalid"]);
  }
  git(clone, ["fetch", "--quiet", "origin"]);
  git(clone, ["tag", "-a", name, "-m", message, revision]);
  git(clone, ["push", "--quiet", "origin", `refs/tags/${name}`]);
};

const installHook = (fixture: Fixture, hook: string, body: string): void => {
  const path = join(fixture.bare, "hooks", hook);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

const REJECT_TAGS_HOOK = `while read old new ref; do
  case "$ref" in
    refs/tags/*) echo "tag pushes are protected: $ref" >&2; exit 1 ;;
  esac
done
exit 0`;

const objectCount = (root: string): string =>
  git(root, ["count-objects", "-v"])
    .split("\n")
    .filter((line) => line.startsWith("count") || line.startsWith("in-pack"))
    .join(";");

const runCli = (
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
) => {
  const result = spawnSync([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
};

const writePhaseFiles = (fixture: Fixture, phase: Phase): string[] => {
  writeFileSync(
    join(fixture.base, "request.json"),
    JSON.stringify(phase.request)
  );
  writeFileSync(
    join(fixture.base, "receipt.json"),
    JSON.stringify(phase.receipt)
  );
  const args = [
    "--request",
    join(fixture.base, "request.json"),
    "--receipt",
    join(fixture.base, "receipt.json"),
  ];
  if (phase.priorReceipt !== undefined) {
    writeFileSync(
      join(fixture.base, "prior.json"),
      JSON.stringify(phase.priorReceipt)
    );
    args.push("--prior-receipt", join(fixture.base, "prior.json"));
  }
  return args;
};

describe("release-tag dry run before the merge", () => {
  test("reports a free name as ready and writes nothing", async () => {
    const fixture = releaseFixture();
    const run = withRun(fixture);
    const refsBefore = git(fixture.root, ["for-each-ref"]);
    const objectsBefore = objectCount(fixture.root);
    const receipt = await run(prepared(fixture), { dryRun: true });
    expect(receipt).toMatchObject({
      mode: "dry-run",
      name: "v1.4.0",
      reasonCode: null,
      remote: "origin",
      status: "ready",
      tagObject: null,
      target: null,
      version: "1.4.0",
    });
    expect(git(fixture.root, ["for-each-ref"])).toBe(refsBefore);
    expect(objectCount(fixture.root)).toBe(objectsBefore);
    expect(remoteTags(fixture.bare)).toEqual({});
  });

  test("catches a taken version on the remote before anything merges", async () => {
    const fixture = releaseFixture();
    publishElsewhere(fixture, "v1.4.0", fixture.input);
    const run = withRun(fixture);
    const receipt = await run(prepared(fixture), { dryRun: true });
    expect(receipt).toMatchObject({
      reasonCode: "tag-exists-elsewhere",
      requiredAction: "resolve-tag-conflict",
      status: "blocked",
    });
    expect(receipt.reason).toContain("version 1.4.0 is taken");
  });

  test("refuses a local-only tag of the same name and never pushes it", async () => {
    const fixture = releaseFixture();
    git(fixture.root, ["tag", "-a", "v1.4.0", "-m", "local", fixture.target]);
    const run = withRun(fixture);
    const dryRun = await run(verified(fixture), { dryRun: true });
    expect(dryRun).toMatchObject({
      reasonCode: "local-tag-conflict",
      status: "blocked",
    });
    const apply = await run(verified(fixture));
    expect(apply).toMatchObject({
      reasonCode: "local-tag-conflict",
      requiredAction: "resolve-tag-conflict",
      status: "blocked",
    });
    expect(remoteTags(fixture.bare)).toEqual({});
  });

  test("treats hierarchical names as taken on either side", async () => {
    const parent = releaseFixture();
    publishElsewhere(parent, "release", parent.input);
    const parentRun = withRun(parent);
    const child = { message: "Acme Web 1.4.0", name: "release/1.4.0" };
    expect(
      await parentRun(prepared(parent, "web-production", child), {
        dryRun: true,
      })
    ).toMatchObject({ reasonCode: "tag-exists-elsewhere", status: "blocked" });

    const descendant = releaseFixture();
    git(descendant.root, ["tag", "v1.4.0/build45", descendant.input]);
    const descendantRun = withRun(descendant);
    const result = await descendantRun(verified(descendant));
    expect(result).toMatchObject({
      reasonCode: "tag-exists-elsewhere",
      status: "blocked",
    });
    expect(result.reason).toContain("v1.4.0/build45 exists locally");
    expect(remoteTags(descendant.bare)).toEqual({});
  });
});

describe("release-tag apply", () => {
  test("creates an annotated tag on the target, reads it back, and installs the local ref", async () => {
    const fixture = releaseFixture();
    const run = withRun(fixture);
    const receipt = await run(verified(fixture));
    expect(receipt).toMatchObject({
      mode: "apply",
      name: "v1.4.0",
      remote: "origin",
      status: "created",
      target: fixture.target,
      version: "1.4.0",
    });
    const published = remoteTags(fixture.bare);
    expect(Object.keys(published)).toEqual(["v1.4.0"]);
    expect(receipt.tagObject).toBe(published["v1.4.0"] as string);
    expect(git(fixture.bare, ["cat-file", "-t", "refs/tags/v1.4.0"])).toBe(
      "tag"
    );
    expect(peel(fixture.bare, "v1.4.0")).toBe(fixture.target);
    const body = git(fixture.bare, ["cat-file", "tag", "refs/tags/v1.4.0"]);
    expect(body).toContain("tag v1.4.0");
    expect(body).toContain(
      "tagger Simple Changes Tests <tests@simple-changes.invalid>"
    );
    expect(body.endsWith("Acme Web 1.4.0")).toBe(true);
    expect(localTagRef(fixture.root, "v1.4.0")).toBe(receipt.tagObject);

    // Final verification and Resume are idempotent: nothing more is pushed.
    const final = await run(verified(fixture), { dryRun: true });
    expect(final).toMatchObject({
      status: "already-present",
      tagObject: receipt.tagObject,
    });
    const rerun = await run(verified(fixture));
    expect(rerun).toMatchObject({
      status: "already-present",
      tagObject: receipt.tagObject,
    });
    expect(remoteTags(fixture.bare)).toEqual(published);
  });

  test("reports a lightweight or differently worded tag on the target as already present", async () => {
    const fixture = releaseFixture();
    publishElsewhere(fixture, "v1.4.0", fixture.target, "Hand-made notes");
    git(fixture.root, [
      "fetch",
      "--quiet",
      "origin",
      "refs/tags/v1.4.0:refs/tags/v1.4.0",
    ]);
    const before = remoteTags(fixture.bare);
    const run = withRun(fixture);
    const receipt = await run(verified(fixture));
    expect(receipt.status).toBe("already-present");
    expect(receipt.reason).toContain("with another message (Hand-made notes)");
    expect(remoteTags(fixture.bare)).toEqual(before);
  });

  test("never moves a tag that names another commit", async () => {
    const fixture = releaseFixture();
    publishElsewhere(fixture, "v1.4.0", fixture.input);
    const before = remoteTags(fixture.bare);
    const run = withRun(fixture);
    const receipt = await run(verified(fixture));
    expect(receipt).toMatchObject({
      reasonCode: "tag-exists-elsewhere",
      requiredAction: "resolve-tag-conflict",
      status: "blocked",
    });
    expect(receipt.reason).toContain("never moved");
    expect(remoteTags(fixture.bare)).toEqual(before);
    expect(localTagRef(fixture.root, "v1.4.0")).toBeNull();
  });

  test("waits for the public boundary and for tag automation review", async () => {
    const fixture = releaseFixture();
    writeFixture(fixture.root, ".github/workflows/release.yml", "on: push\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Add CI"]);
    git(fixture.root, ["push", "--quiet", "origin", "main"]);
    const withCi = {
      ...fixture,
      target: git(fixture.root, ["rev-parse", "HEAD"]),
    };
    const run = withRun(withCi);
    const unapproved = await run(verified(withCi), {
      productionAuthorized: false,
    });
    expect(unapproved).toMatchObject({
      reasonCode: "release-not-crossed",
      requiredAction: "await-release-authority",
      status: "blocked",
    });
    const denied = await run(verified(withCi), { productionDeploy: "deny" });
    expect(denied.reasonCode).toBe("release-not-crossed");
    const unreviewed = await run(verified(withCi), {
      tagAutomationAuthorized: false,
    });
    expect(unreviewed).toMatchObject({
      ciConfigurationFiles: [".github/workflows/release.yml"],
      reasonCode: "tag-automation-unreviewed",
      requiredAction: "review-tag-automation",
      status: "blocked",
    });
    expect(remoteTags(withCi.bare)).toEqual({});
    expect(localTagRef(withCi.root, "v1.4.0")).toBeNull();
  });

  test("requires tag automation review even with no CI configuration", async () => {
    const fixture = releaseFixture();
    const run = withRun(fixture);
    const receipt = await run(verified(fixture), {
      tagAutomationAuthorized: false,
    });
    expect(receipt).toMatchObject({
      ciConfigurationFiles: [],
      reasonCode: "tag-automation-unreviewed",
      status: "blocked",
    });
  });

  test("blocks a Web release whose target moved after verification, with no write", async () => {
    const fixture = releaseFixture();
    const run = withRun(fixture);
    const clone = join(fixture.base, "mover");
    git(fixture.base, ["clone", "--quiet", fixture.bare, clone]);
    git(clone, ["config", "user.name", "Mover"]);
    git(clone, ["config", "user.email", "mover@simple-changes.invalid"]);
    writeFixture(clone, "later.txt", "later\n");
    git(clone, ["add", "."]);
    git(clone, ["commit", "-m", "Later work"]);
    git(clone, ["push", "--quiet", "origin", "main"]);
    const objectsBefore = objectCount(fixture.root);
    const receipt = await run(verified(fixture));
    expect(receipt).toMatchObject({
      reasonCode: "target-moved",
      requiredAction: "refresh-and-reclassify",
      status: "blocked",
    });
    expect(remoteTags(fixture.bare)).toEqual({});
    expect(objectCount(fixture.root)).toBe(objectsBefore);
  });

  test("tags a skill release on its verified commit after the branch moved on", async () => {
    const fixture = releaseFixture();
    const run = withRun(fixture);
    const clone = join(fixture.base, "mover");
    git(fixture.base, ["clone", "--quiet", fixture.bare, clone]);
    git(clone, ["config", "user.name", "Mover"]);
    git(clone, ["config", "user.email", "mover@simple-changes.invalid"]);
    writeFixture(clone, "later.txt", "later\n");
    git(clone, ["add", "."]);
    git(clone, ["commit", "-m", "Later work"]);
    git(clone, ["push", "--quiet", "origin", "main"]);
    const receipt = await run(verified(fixture, "release-bearing-merge"), {
      productionDeploy: "allow",
    });
    expect(receipt).toMatchObject({
      status: "created",
      target: fixture.target,
    });
    expect(peel(fixture.bare, "v1.4.0")).toBe(fixture.target);
  });

  test("refuses a target the refreshed branch no longer contains", async () => {
    const fixture = releaseFixture();
    const run = withRun(fixture);
    git(fixture.bare, ["update-ref", "refs/heads/main", fixture.input]);
    const receipt = await run(verified(fixture, "release-bearing-merge"));
    expect(receipt).toMatchObject({
      reasonCode: "target-not-contained",
      requiredAction: "refresh-and-reverify",
      status: "blocked",
    });
    expect(remoteTags(fixture.bare)).toEqual({});
  });

  test("verifies an already-live release by containment", async () => {
    const fixture = releaseFixture();
    const run = withRun(fixture);
    const clone = join(fixture.base, "mover");
    git(fixture.base, ["clone", "--quiet", fixture.bare, clone]);
    git(clone, ["config", "user.name", "Mover"]);
    git(clone, ["config", "user.email", "mover@simple-changes.invalid"]);
    writeFixture(clone, "later.txt", "later\n");
    git(clone, ["add", "."]);
    git(clone, ["commit", "-m", "Later work"]);
    git(clone, ["push", "--quiet", "origin", "main"]);
    const receipt = await run(verified(fixture), { alreadyLive: true });
    expect(receipt.status).toBe("created");
  });

  test("returns not-applicable for an older receipt and lets the release continue", async () => {
    const fixture = releaseFixture();
    const run = withRun(fixture);
    const prior4 = receiptV4(fixture, "prepared");
    const { release: _priorRelease, ...priorRest } = prior4;
    const priorV3: ChangelogReceiptV3 = {
      ...priorRest,
      release: {
        date: "2026-10-07",
        targetContainedUnreleased: "prepared",
        version: "1.4.0",
      },
      schemaVersion: 3,
    };
    const verified4 = receiptV4(fixture, "verified");
    const { release: _verifiedRelease, ...verifiedRest } = verified4;
    const verifiedV3: ChangelogReceiptV3 = {
      ...verifiedRest,
      release: {
        date: "2026-10-07",
        targetContainedUnreleased: "integrated",
        version: "1.4.0",
      },
      schemaVersion: 3,
    };
    const receipt = await run({
      priorReceipt: priorV3,
      receipt: verifiedV3,
      request: requestV3(fixture, "verify", {
        priorReceiptDigest: changelogReceiptDigest(priorV3),
        schemaVersion: 2,
        supportedReceiptVersions: [1, 2, 3],
      }),
    });
    expect(receipt).toMatchObject({
      name: null,
      status: "not-applicable",
      version: "1.4.0",
    });
    expect(receipt.reason).toContain("Receipt v3 names no release tag");
    const { releaseSetTrains: _trains, ...v2Base } = verifiedV3;
    const verifiedV2: ChangelogReceiptV2 = {
      ...v2Base,
      schemaVersion: 2,
      versionDecision: verifiedV3.versionDecision
        ? {
            boundary: verifiedV3.versionDecision.boundary,
            bumpLevel: verifiedV3.versionDecision.bumpLevel,
            currentVersion: verifiedV3.versionDecision.currentVersion,
            policyAction: verifiedV3.versionDecision.policyAction,
            releaseTrain: verifiedV3.versionDecision.releaseTrain,
            resolution: verifiedV3.versionDecision.resolution,
            selectedVersion: verifiedV3.versionDecision.selectedVersion,
            source: verifiedV3.versionDecision.source,
            suggestedVersion: verifiedV3.versionDecision.suggestedVersion,
          }
        : null,
    };
    const { releaseSetTrains: _requestTrains, ...v1Request } = requestV3(
      fixture,
      "verify"
    );
    expect(
      await run({
        receipt: verifiedV2,
        request: {
          ...v1Request,
          schemaVersion: 1,
          supportedReceiptVersions: [1, 2],
        },
      })
    ).toMatchObject({ name: null, status: "not-applicable", version: "1.4.0" });
    const untagged = await run(verified(fixture, "web-production", null));
    expect(untagged).toMatchObject({ name: null, status: "not-applicable" });
    expect(remoteTags(fixture.bare)).toEqual({});
  });

  test("pushes only the release tag even with push.followTags", async () => {
    const fixture = releaseFixture();
    git(fixture.root, ["config", "push.followTags", "true"]);
    git(fixture.root, [
      "tag",
      "-a",
      "unrelated",
      "-m",
      "Unrelated",
      fixture.target,
    ]);
    const run = withRun(fixture);
    expect((await run(verified(fixture))).status).toBe("created");
    expect(Object.keys(remoteTags(fixture.bare))).toEqual(["v1.4.0"]);
  });
});

describe("release-tag destinations", () => {
  test("refuses a remote with two push URLs before any write", async () => {
    const fixture = releaseFixture();
    const mirror = join(fixture.base, "mirror.git");
    git(fixture.base, ["init", "--bare", "-b", "main", mirror]);
    git(fixture.root, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      fixture.bare,
    ]);
    git(fixture.root, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      mirror,
    ]);
    const run = withRun(fixture);
    const expectRefused = (receipt: Awaited<ReturnType<typeof run>>) => {
      expect(receipt).toMatchObject({
        reasonCode: "remote-not-single-url",
        requiredAction: "push-manually",
        status: "blocked",
      });
      expect(receipt.manualCommands).toEqual([
        `git tag -a v1.4.0 -m 'Acme Web 1.4.0' ${fixture.target}`,
        "git push --no-follow-tags origin refs/tags/v1.4.0",
      ]);
    };
    expectRefused(await run(verified(fixture), { dryRun: true }));
    expectRefused(await run(verified(fixture)));
    expect(remoteTags(fixture.bare)).toEqual({});
    expect(remoteTags(mirror)).toEqual({});
  });

  test("refuses a push URL that differs from the fetch URL", async () => {
    const fixture = releaseFixture();
    const other = join(fixture.base, "other.git");
    git(fixture.base, ["clone", "--quiet", "--bare", fixture.bare, other]);
    git(fixture.root, ["remote", "set-url", "--push", "origin", other]);
    const run = withRun(fixture);
    const receipt = await run(verified(fixture));
    expect(receipt.reasonCode).toBe("remote-not-single-url");
    expect(remoteTags(fixture.bare)).toEqual({});
    expect(remoteTags(other)).toEqual({});
  });

  test("refuses a remote rebound after the run started", async () => {
    const fixture = releaseFixture();
    const run = withRun(fixture);
    const other = join(fixture.base, "other.git");
    git(fixture.base, ["clone", "--quiet", "--bare", fixture.bare, other]);
    git(fixture.root, ["remote", "set-url", "origin", other]);
    const dryRun = await run(verified(fixture), { dryRun: true });
    expect(dryRun.reasonCode).toBe("remote-not-single-url");
    expect(dryRun.reason).toContain("no longer matches");
    await expect(run(verified(fixture))).rejects.toThrow(
      "remote-destination-changed"
    );
    expect(remoteTags(other)).toEqual({});
  });

  test("re-reads the remote's URLs live, not only the run's binding", async () => {
    const added = releaseFixture();
    const addedRun = withRun(added);
    const mirror = join(added.base, "mirror.git");
    git(added.base, ["init", "--bare", "-b", "main", mirror]);
    git(added.root, [
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      added.bare,
    ]);
    git(added.root, ["remote", "set-url", "--add", "--push", "origin", mirror]);
    const addedReceipt = await addedRun(verified(added), { dryRun: true });
    expect(addedReceipt.reasonCode).toBe("remote-not-single-url");
    expect(addedReceipt.reason).toContain("1 fetch and 2 push URL(s)");

    const split = releaseFixture();
    const splitRun = withRun(split);
    const other = join(split.base, "other.git");
    git(split.base, ["clone", "--quiet", "--bare", split.bare, other]);
    git(split.root, ["remote", "set-url", "--push", "origin", other]);
    const splitReceipt = await splitRun(verified(split), { dryRun: true });
    expect(splitReceipt.reasonCode).toBe("remote-not-single-url");
    expect(splitReceipt.reason).toContain("the same for fetch and push");
    await expect(splitRun(verified(split))).rejects.toThrow(
      "remote-destination-changed"
    );
    expect(remoteTags(other)).toEqual({});
  });

  test("blocks a protected tag push, surfaces Git's error, and leaves no local ref", async () => {
    const fixture = releaseFixture();
    installHook(fixture, "pre-receive", REJECT_TAGS_HOOK);
    const run = withRun(fixture);
    const receipt = await run(verified(fixture));
    expect(receipt).toMatchObject({
      reasonCode: "push-rejected",
      requiredAction: "retry-after-fix",
      status: "blocked",
    });
    expect(receipt.reason).toContain(
      "tag pushes are protected: refs/tags/v1.4.0"
    );
    expect(receipt.manualCommands).toHaveLength(2);
    expect(remoteTags(fixture.bare)).toEqual({});
    expect(localTagRef(fixture.root, "v1.4.0")).toBeNull();

    // A later branch push with push.followTags publishes no stray tag.
    rmHook(fixture, "pre-receive");
    git(fixture.root, ["config", "push.followTags", "true"]);
    writeFixture(fixture.root, "later.txt", "later\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Later"]);
    git(fixture.root, ["push", "--quiet", "origin", "main"]);
    expect(remoteTags(fixture.bare)).toEqual({});
  });

  test("reports a push that the remote did not keep as a failed readback", async () => {
    const fixture = releaseFixture();
    installHook(
      fixture,
      "post-receive",
      'while read old new ref; do git update-ref -d "$ref"; done'
    );
    const run = withRun(fixture);
    const receipt = await run(verified(fixture));
    expect(receipt).toMatchObject({
      reasonCode: "readback-failed",
      requiredAction: "retry-after-fix",
      status: "blocked",
    });
    expect(localTagRef(fixture.root, "v1.4.0")).toBeNull();
  });

  test("never publishes from Sync, without a lease, or as a delegated author", async () => {
    const fixture = releaseFixture();
    await expect(
      releaseTag(fixture, verified(fixture), { runId: "run-missing" })
    ).rejects.toThrow("No active Simple Changes integration loop");
    expect(() => startLoop(fixture.root, CONTROLLER, "sync")).toThrow();
    const lease = startController(fixture);
    await expect(
      releaseTag(fixture, verified(fixture), {
        agentId: "delegated-author",
        runId: lease.runId,
      })
    ).rejects.toThrow("Only the controller");
    expect(remoteTags(fixture.bare)).toEqual({});
  });

  test("refuses before any write when policy never lets agents push", async () => {
    const fixture = releaseFixture({
      policy: { gitPushAuthorization: "never" },
    });
    const run = withRun(fixture);
    const receipt = await run(verified(fixture));
    expect(receipt).toMatchObject({
      reasonCode: "push-not-authorized",
      requiredAction: "push-manually",
      status: "blocked",
    });
    expect(receipt.manualCommands).toEqual([
      `git tag -a v1.4.0 -m 'Acme Web 1.4.0' ${fixture.target}`,
      "git push --no-follow-tags origin refs/tags/v1.4.0",
    ]);
    expect(remoteTags(fixture.bare)).toEqual({});
  });
});

describe("release-tag holds and the guarded executor", () => {
  const holdThenWaive = async (scope: "deploy" | "migrations") => {
    const fixture = releaseFixture();
    const lease = startController(fixture);
    const hold = addShipHold(fixture.root, {
      adapter: "codex",
      agentId: "other-agent",
      reason: `Hold ${scope} for a test`,
      scope,
      severity: "delay",
    });
    const blockedReceipt = await releaseTag(fixture, verified(fixture), {
      runId: lease.runId,
    });
    expect(blockedReceipt).toMatchObject({
      reasonCode: "shipment-hold",
      requiredAction: "resolve-hold",
      status: "blocked",
    });
    expect(blockedReceipt.reason).toContain(hold.holdId);
    expect(remoteTags(fixture.bare)).toEqual({});
    waiveShipHold(fixture.root, {
      agentId: CONTROLLER,
      approvedBy: "user",
      holdId: hold.holdId,
      overrideHalt: false,
      reason: "The user approved continuing",
      runId: lease.runId,
    });
    const waived = await releaseTag(fixture, verified(fixture), {
      runId: lease.runId,
    });
    expect(waived.status).toBe("created");
  };

  test("a deploy hold blocks the tag, and a waived hold passes", async () => {
    await holdThenWaive("deploy");
  });

  test("a migrations hold blocks the tag, and a waived hold passes", async () => {
    await holdThenWaive("migrations");
  });

  test("runs mktag, push, and update-ref through the execGuard with their exact argv", async () => {
    const fixture = releaseFixture({ execGuard: true });
    const run = withRun(fixture);
    const receipt = await run(verified(fixture));
    expect(receipt.status).toBe("created");
    const object = receipt.tagObject as string;
    expect(fixture.guardRecords()).toEqual([
      ["git", "mktag"],
      [
        "git",
        "push",
        "--no-follow-tags",
        "origin",
        `${object}:refs/tags/v1.4.0`,
      ],
      ["git", "update-ref", "refs/tags/v1.4.0", object, ""],
    ]);
  });

  test("a refused mktag or push leaves no ref anywhere", async () => {
    const mktag = releaseFixture({ execGuard: true });
    setEnvironment("RELEASE_TAG_GUARD_REFUSE", "mktag");
    const mktagRun = withRun(mktag);
    expect(await mktagRun(verified(mktag))).toMatchObject({
      reasonCode: "tag-create-failed",
      status: "blocked",
    });
    expect(remoteTags(mktag.bare)).toEqual({});
    expect(localTagRef(mktag.root, "v1.4.0")).toBeNull();

    const push = releaseFixture({ execGuard: true });
    setEnvironment("RELEASE_TAG_GUARD_REFUSE", "--no-follow-tags");
    const pushRun = withRun(push);
    expect(await pushRun(verified(push))).toMatchObject({
      reasonCode: "push-rejected",
      status: "blocked",
    });
    expect(remoteTags(push.bare)).toEqual({});
    expect(localTagRef(push.root, "v1.4.0")).toBeNull();
  });

  test("a lost race reports already-present and installs no local ref", async () => {
    const fixture = releaseFixture({ execGuard: true });
    // The other writer publishes the same tag name on the same commit while
    // this run sits between its checks and its push.
    const writer = join(fixture.base, "racer");
    git(fixture.base, ["clone", "--quiet", fixture.bare, writer]);
    git(writer, ["config", "user.name", "Racer"]);
    git(writer, ["config", "user.email", "racer@simple-changes.invalid"]);
    setEnvironment(
      "RELEASE_TAG_GUARD_BEFORE_PUSH",
      `git -C '${writer}' tag -a v1.4.0 -m 'Racer' ${fixture.target} && git -C '${writer}' push --quiet origin refs/tags/v1.4.0`
    );
    const run = withRun(fixture);
    const receipt = await run(verified(fixture));
    const published = remoteTags(fixture.bare)["v1.4.0"];
    expect(receipt).toMatchObject({
      status: "already-present",
      tagObject: published as string,
    });
    expect(localTagRef(fixture.root, "v1.4.0")).toBeNull();
    expect(peel(fixture.bare, "v1.4.0")).toBe(fixture.target);
  });

  test("a run killed between build and push leaves nothing a follow-tags push publishes", () => {
    const fixture = releaseFixture({ execGuard: true });
    const lease = startController(fixture);
    const phaseArgs = writePhaseFiles(fixture, verified(fixture));
    const result = runCli(
      fixture.root,
      [
        "release-tag",
        "--run-id",
        lease.runId,
        "--agent-id",
        CONTROLLER,
        "--production",
        "allow",
        "--tag-automation-authorized",
        ...phaseArgs,
        "--json",
      ],
      { RELEASE_TAG_GUARD_KILL_ON_PUSH: "1" }
    );
    expect(result.exitCode).not.toBe(0);
    expect(fixture.guardRecords().map((argv) => argv[1])).toEqual([
      "mktag",
      "push",
    ]);
    expect(remoteTags(fixture.bare)).toEqual({});
    expect(localTagRef(fixture.root, "v1.4.0")).toBeNull();
    git(fixture.root, ["config", "push.followTags", "true"]);
    writeFixture(fixture.root, "later.txt", "later\n");
    git(fixture.root, ["add", "."]);
    git(fixture.root, ["commit", "-m", "Later"]);
    git(fixture.root, ["push", "--quiet", "origin", "main"]);
    expect(remoteTags(fixture.bare)).toEqual({});
  });
});

describe("release-tag CLI", () => {
  test("exits 0 when created or not applicable and 5 when blocked", () => {
    const fixture = releaseFixture();
    installHook(fixture, "pre-receive", REJECT_TAGS_HOOK);
    const lease = startController(fixture);
    const phaseArgs = writePhaseFiles(fixture, verified(fixture));
    const base = [
      "release-tag",
      "--run-id",
      lease.runId,
      "--agent-id",
      CONTROLLER,
      "--production",
      "allow",
      ...phaseArgs,
    ];
    const rejected = runCli(fixture.root, [
      ...base,
      "--tag-automation-authorized",
      "--json",
    ]);
    expect(rejected.exitCode).toBe(5);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      reasonCode: "push-rejected",
      status: "blocked",
    });
    rmHook(fixture, "pre-receive");
    const text = runCli(fixture.root, [...base, "--tag-automation-authorized"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("Release tag v1.4.0 was created and pushed.");
    const final = runCli(fixture.root, [...base, "--dry-run", "--json"]);
    expect(final.exitCode).toBe(0);
    expect(JSON.parse(final.stdout).status).toBe("already-present");
    const unverified = runCli(fixture.root, [
      "release-tag",
      "--run-id",
      lease.runId,
      "--agent-id",
      CONTROLLER,
      "--production",
      "allow",
      ...phaseArgs.slice(0, 4),
      "--dry-run",
    ]);
    expect(unverified.exitCode).toBe(3);
    expect(unverified.stderr).toContain("--prior-receipt");
  });
});

const rmHook = (fixture: Fixture, hook: string): void => {
  writeFileSync(join(fixture.bare, "hooks", hook), "#!/bin/sh\nexit 0\n");
};
