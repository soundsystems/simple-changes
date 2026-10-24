import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";
import { CURRENT_GUIDANCE_VERSION } from "../../../skills/simple-changes/scripts/lib/guidance-updates.ts";
import { DEFAULT_POLICY } from "../../../skills/simple-changes/scripts/lib/policy.ts";
import { decideReleaseGate } from "../../../skills/simple-changes/scripts/lib/release-gate.ts";
import type {
  ChangelogReceiptV2,
  ChangelogRequest,
  RepoPolicy,
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

const repositories: TestRepository[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) {
    repository.cleanup();
  }
});

interface Run {
  code: number;
  json: Record<string, unknown>;
  stderr: string;
  stdout: string;
}

interface Fixture {
  configuration: string;
  repository: TestRepository;
  run: (args: string[], env?: Record<string, string>) => Run;
}

// Each fixture gets its own empty configuration directory, so no personal
// policy exists unless a test writes one.
const fixture = (): Fixture => {
  const repository = createTestRepository();
  repositories.push(repository);
  const configuration = join(repository.base, "configuration");
  mkdirSync(configuration);
  const run = (args: string[], env: Record<string, string> = {}): Run => {
    const result = spawnSync([process.execPath, cliPath, ...args], {
      env: {
        ...process.env,
        SIMPLE_CHANGES_CONFIG_DIR: configuration,
        SIMPLE_CHANGES_SKILL_ROOTS: "",
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const stdout = decoder.decode(result.stdout);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      // Text output or an error.
    }
    return {
      code: result.exitCode ?? -1,
      json,
      stderr: decoder.decode(result.stderr),
      stdout,
    };
  };
  return { configuration, repository, run };
};

const RUN_ONLY_SETUP = [
  "setup",
  "--finish",
  "review",
  "--questions",
  "blocking-only",
  "--scope",
  "run",
  "--git-push-authorization",
  "ask",
  "--yes",
  "--json",
];

const runOnlySetup = (
  { repository, run }: Fixture,
  extra: string[] = []
): RepoPolicy => {
  const setup = run([...RUN_ONLY_SETUP, ...extra, "--repo", repository.root]);
  expect(setup.code).toBe(0);
  expect(setup.json).toMatchObject({
    confirmed: true,
    path: null,
    scope: "run",
    written: false,
  });
  return setup.json.policy as RepoPolicy;
};

// Every path under a directory, so a test can prove nothing was created.
const listPaths = (root: string): string[] => {
  if (!existsSync(root)) {
    return [];
  }
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      paths.push(path);
      if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
  return paths.sort((left, right) => left.localeCompare(right));
};

const initialize = (
  { repository, run }: Fixture,
  mode: string,
  extra: string[] = []
): Run =>
  run([
    "initialize",
    "--mode",
    mode,
    ...extra,
    "--json",
    "--repo",
    repository.root,
  ]);

const claimWorktree = (
  { repository, run }: Fixture,
  agentId: string
): { claimId: string; worktree: string } => {
  const worktree = resolve(repository.base, `${agentId}-feature`);
  git(repository.root, [
    "worktree",
    "add",
    "-b",
    `${agentId}-feature`,
    worktree,
  ]);
  const claimed = run([
    "worktree",
    "claim",
    "--agent-id",
    agentId,
    "--worktree",
    worktree,
    "--adapter",
    "claude-code",
    "--json",
    "--repo",
    repository.root,
  ]);
  expect(claimed.code).toBe(0);
  return {
    claimId: (claimed.json.claim as { claimId: string }).claimId,
    worktree,
  };
};

const claimStates = ({ repository, run }: Fixture): string[] =>
  (
    run(["worktree", "status", "--json", "--repo", repository.root]).json
      .claims as Array<{ state: string }>
  ).map(({ state }) => state);

const activeLoopPath = (repository: TestRepository): string =>
  resolve(repository.root, ".git/simple-changes/active-loop.json");

const revisionA = "a".repeat(40);

const classifyRequest = (): ChangelogRequest => ({
  approvedDecisionDigest: null,
  approvedVersion: null,
  attempt: 1,
  boundary: "web-production",
  environment: "production",
  finalizedTargetRevision: null,
  inputTargetRevision: revisionA,
  mutationScope: "read-only",
  phase: "classify",
  priorReceiptDigest: null,
  releaseSetId: null,
  releaseTrain: "web",
  schemaVersion: 1,
  supportedReceiptVersions: [1, 2],
  transactionId: "release-01",
});

const decisionRequiredReceipt = (): ChangelogReceiptV2 => ({
  checks: ["Inspected exact target."],
  decisionDigest: "d".repeat(64),
  effectivePolicyDigest: "e".repeat(64),
  evidence: ["Aggregate impact is minor."],
  observedAt: "2026-08-10T12:00:00-05:00",
  paths: [],
  phase: "classify",
  provider: "simple-changelogs",
  reason: "Choose the proposed version.",
  reasonCode: "version-direction-required",
  release: null,
  releaseImpact: "minor",
  releaseSetId: null,
  requiredAction: "choose-version",
  revisionLineage: {
    finalizedTargetRevision: null,
    inputTargetRevision: revisionA,
    reconciliationHeadRevision: null,
  },
  schemaVersion: 2,
  sourceRevision: revisionA,
  status: "decision-required",
  transactionId: "release-01",
  versionDecision: {
    boundary: "web-production",
    bumpLevel: "minor",
    currentVersion: "0.9.0",
    policyAction: "ask",
    releaseTrain: "web",
    resolution: "approval-required",
    selectedVersion: null,
    source: "repository-policy",
    suggestedVersion: "0.10.0",
  },
});

// The release gate, given the production value initialization reported.
const gateFor = (productionDeploy: unknown, productionAuthorized = false) =>
  decideReleaseGate({
    alreadyLive: false,
    productionAuthorized,
    productionDeploy: productionDeploy as RepoPolicy["productionDeploy"],
    receipt: decisionRequiredReceipt(),
    request: classifyRequest(),
    versionAuthorized: false,
  }).action;

describe("run-only setup and --policy-request", () => {
  test("a plain initialize after run-only setup still requires onboarding", () => {
    const current = fixture();
    runOnlySetup(current);
    // Pins the designed next-run behavior: run-only setup saves nothing.
    expect(initialize(current, "queue").json).toMatchObject({
      mutationAllowed: false,
      onboardingRequired: true,
      policySource: "default",
      preLoopActionRequired: true,
    });
  });

  test("initialize with setup's policy continues the run and writes nothing", () => {
    const current = fixture();
    const policy = runOnlySetup(current);
    const before = [
      ...listPaths(current.configuration),
      ...listPaths(current.repository.root),
    ];
    const request = JSON.stringify(policy);
    const first = initialize(current, "queue", ["--policy-request", request]);
    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({
      mutationAllowed: true,
      onboardingRequired: false,
      policyPath: null,
      policyRequest: { status: "applied" },
      policySource: "request",
      policyTrust: "not-required",
      preLoopActionRequired: false,
    });
    // An @path request reads the same object, and repeating it is stable.
    const requestFile = join(current.repository.base, "policy-request.json");
    writeFileSync(requestFile, request);
    const stable = (status: Record<string, unknown>) => ({
      gitPushAuthorization: status.gitPushAuthorization,
      mutationAllowed: status.mutationAllowed,
      onboardingRequired: status.onboardingRequired,
      policyRequest: status.policyRequest,
      policySource: status.policySource,
      policyTrust: status.policyTrust,
      preLoopActionRequired: status.preLoopActionRequired,
      productionDeploy: status.productionDeploy,
      reason: status.reason,
    });
    const fromFile = initialize(current, "queue", [
      "--policy-request",
      `@${requestFile}`,
    ]);
    expect(stable(fromFile.json)).toEqual(stable(first.json));
    const repeated = initialize(current, "queue", [
      "--policy-request",
      request,
    ]);
    expect(stable(repeated.json)).toEqual(stable(first.json));
    // No policy file, sidecar, or preference appeared anywhere.
    expect([
      ...listPaths(current.configuration),
      ...listPaths(current.repository.root),
    ]).toEqual(before);
    // Negative control: without the request the same repository still blocks.
    expect(initialize(current, "queue").json).toMatchObject({
      mutationAllowed: false,
      onboardingRequired: true,
    });
  });

  test("the setup hand-off prints the resulting status and the request to pass on", () => {
    const current = fixture();
    const handOff = current.run([
      "initialize",
      "--mode",
      "queue",
      "--finish",
      "review",
      "--questions",
      "blocking-only",
      "--scope",
      "run",
      "--git-push-authorization",
      "ask",
      "--yes",
      "--json",
      "--repo",
      current.repository.root,
    ]);
    expect(handOff.code).toBe(0);
    const runRequest = handOff.json.runRequest as {
      authoringRequest: string | null;
      policyRequest: string;
    };
    expect(JSON.parse(runRequest.policyRequest)).toEqual(handOff.json.policy);
    expect(handOff.json.initialization).toMatchObject({
      mutationAllowed: true,
      onboardingRequired: false,
      policySource: "request",
    });
    expect(
      initialize(current, "queue", [
        "--policy-request",
        runRequest.policyRequest,
      ]).json
    ).toMatchObject({ mutationAllowed: true, policySource: "request" });
    const text = current.run([
      ...RUN_ONLY_SETUP.filter((argument) => argument !== "--json"),
      "--repo",
      current.repository.root,
    ]);
    expect(text.stdout).toContain(
      "Pass this to every later initialize and loop start in this run:"
    );
    expect(text.stdout).toContain(
      `--policy-request '${runRequest.policyRequest}'`
    );
    // Negative control: a saved setup hands nothing on.
    const saved = current.run([
      ...RUN_ONLY_SETUP.map((argument) =>
        argument === "run" ? "repository" : argument
      ),
      "--instruction-pointer",
      "leave",
      "--repo",
      current.repository.root,
    ]);
    expect(saved.json).toMatchObject({ runRequest: null, written: true });
  });

  test("a ready handoff with the request proceeds and releases the claim", () => {
    const current = fixture();
    const policy = runOnlySetup(current);
    const { claimId, worktree } = claimWorktree(current, "feature-author");
    const handoff = (agentId: string, extra: string[]) =>
      current.run([
        "initialize",
        "--mode",
        "handoff",
        "--ready",
        "--agent-id",
        agentId,
        ...extra,
        "--json",
        "--repo",
        worktree,
      ]);
    // Negative control: without the request the handoff is not allowed.
    expect(handoff("someone-else", []).json).toMatchObject({
      handoffAction: "proceed",
      mutationAllowed: false,
      onboardingRequired: true,
    });
    const proceeded = handoff("feature-author", [
      "--policy-request",
      JSON.stringify(policy),
    ]);
    expect(proceeded.code).toBe(0);
    expect(proceeded.json).toMatchObject({
      handoffAction: "proceed",
      handoffClaimRelease: { claimId, path: realpathSync(worktree) },
      mutationAllowed: true,
      resolvedMode: "queue",
    });
  });

  test("loop start --changelog-required starts only with the request", () => {
    const current = fixture();
    const policy = runOnlySetup(current);
    const start = (extra: string[]) =>
      current.run([
        "loop",
        "start",
        "--mode",
        "queue",
        "--agent-id",
        "controller",
        "--changelog-required",
        ...extra,
        "--json",
        "--repo",
        current.repository.root,
      ]);
    const blocked = start([]);
    expect(blocked.code).toBe(5);
    expect(blocked.stderr).toContain("before loop start");
    expect(existsSync(activeLoopPath(current.repository))).toBe(false);
    const started = start(["--policy-request", JSON.stringify(policy)]);
    expect(started.code).toBe(0);
    expect(existsSync(activeLoopPath(current.repository))).toBe(true);
  });

  test("a request never carries consequential authority", () => {
    const current = fixture();
    const consequential: RepoPolicy = {
      ...runOnlySetup(current),
      defaultFinish: "ship",
      gitPushAuthorization: "configure-harness",
      migrationHandling: "auto-apply-reviewed",
      migrationTargets: [
        { environment: "production", project: "app", provider: "supabase" },
      ],
      productionDeploy: "allow",
      shippingMode: "break-glass",
    };
    const status = initialize(current, "ship", [
      "--policy-request",
      JSON.stringify(consequential),
    ]);
    expect(status.code).toBe(0);
    expect(status.json).toMatchObject({
      gitPushAuthorization: "ask",
      migrationHandling: "ask-after-review",
      migrationTargets: [],
      onboardingRequired: false,
      policySource: "request",
      policyTrust: "untrusted",
      productionDeploy: "ask",
      shippingMode: "standard",
    });
    // The release gate takes the reported value and still asks.
    expect(gateFor(status.json.productionDeploy)).toBe(
      "request-combined-approval"
    );
    // Negative control: the same settings saved as personal defaults, which
    // need no repository trust, keep their authority.
    writeFixture(
      current.configuration,
      "simple-changes/preferences.json",
      `${JSON.stringify(consequential, null, 2)}\n`
    );
    const saved = initialize(current, "ship");
    expect(saved.json).toMatchObject({
      policySource: "user",
      productionDeploy: "allow",
      shippingMode: "break-glass",
    });
    expect(gateFor(saved.json.productionDeploy)).toBe(
      "request-version-approval"
    );
  });

  test("a saved repository or personal policy always wins over a request", () => {
    const current = fixture();
    const request: RepoPolicy = {
      ...runOnlySetup(current),
      gitPushAuthorization: "ask",
      handoffTiming: "automatic",
      productionDeploy: "ask",
    };
    const personal: RepoPolicy = {
      ...DEFAULT_POLICY,
      gitPushAuthorization: "never",
      productionDeploy: "deny",
    };
    writeFixture(
      current.configuration,
      "simple-changes/preferences.json",
      `${JSON.stringify(personal, null, 2)}\n`
    );
    const underPersonal = initialize(current, "handoff", [
      "--policy-request",
      JSON.stringify(request),
    ]);
    expect(underPersonal.code).toBe(0);
    expect(underPersonal.json).toMatchObject({
      gitPushAuthorization: "never",
      handoffAction: "confirm-readiness",
      mutationAllowed: false,
      policyRequest: { status: "ignored" },
      policySource: "user",
      productionDeploy: "deny",
    });
    writeFixture(
      current.repository.root,
      ".simple-changes.json",
      `${JSON.stringify({ ...personal, gitPushAuthorization: "ask" }, null, 2)}\n`
    );
    const underRepository = initialize(current, "handoff", [
      "--policy-request",
      JSON.stringify({ ...request, gitPushAuthorization: "never" }),
    ]);
    expect(underRepository.json).toMatchObject({
      gitPushAuthorization: "ask",
      handoffAction: "confirm-readiness",
      policyRequest: { status: "ignored" },
      policySource: "repository",
      productionDeploy: "deny",
    });
    expect(
      (underRepository.json.policyRequest as { reason: string }).reason
    ).toContain("cannot override or loosen it");
    // Negative control: with nothing saved the same request applies.
    expect(
      initialize(fixture(), "handoff", [
        "--policy-request",
        JSON.stringify(request),
      ]).json
    ).toMatchObject({ handoffAction: "proceed", policySource: "request" });
  });

  test("an invalid or stale request is a usage error that changes nothing", () => {
    const current = fixture();
    const policy = runOnlySetup(current);
    const { worktree } = claimWorktree(current, "feature-author");
    const withGuidance = (version: number) =>
      JSON.stringify({
        ...policy,
        guidance: { disposition: "reviewed", version },
      });
    const invalidRequests = [
      "not json",
      "{}",
      JSON.stringify({ ...policy, unknown: true }),
      withGuidance(CURRENT_GUIDANCE_VERSION - 1),
      withGuidance(CURRENT_GUIDANCE_VERSION + 1),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(policy).filter(([key]) => key !== "handoffTiming")
        )
      ),
      JSON.stringify({ ...policy, execGuard: ["git push"] }),
      `@${join(current.repository.base, "missing.json")}`,
    ];
    const before = [
      ...listPaths(current.configuration),
      ...listPaths(current.repository.root),
    ];
    for (const invalid of invalidRequests) {
      const handoff = current.run([
        "initialize",
        "--mode",
        "handoff",
        "--ready",
        "--agent-id",
        "feature-author",
        "--policy-request",
        invalid,
        "--json",
        "--repo",
        worktree,
      ]);
      expect(handoff.code).toBe(2);
      expect(handoff.stderr).toContain("--policy-request");
      const loop = current.run([
        "loop",
        "start",
        "--mode",
        "queue",
        "--agent-id",
        "controller",
        "--policy-request",
        invalid,
        "--json",
        "--repo",
        current.repository.root,
      ]);
      expect(loop.code).toBe(2);
      expect(loop.stderr).toContain("--policy-request");
    }
    expect(claimStates(current)).not.toContain("released");
    expect(existsSync(activeLoopPath(current.repository))).toBe(false);
    expect([
      ...listPaths(current.configuration),
      ...listPaths(current.repository.root),
    ]).toEqual(before);
    // Negative control: the valid request releases the same claim.
    const valid = current.run([
      "initialize",
      "--mode",
      "handoff",
      "--ready",
      "--agent-id",
      "feature-author",
      "--policy-request",
      JSON.stringify(policy),
      "--json",
      "--repo",
      worktree,
    ]);
    expect(valid.code).toBe(0);
    expect(claimStates(current)).toContain("released");
  });

  test("explicit denials in run-only setup pass through unchanged", () => {
    const current = fixture();
    const denied = runOnlySetup(current, [
      "--finish",
      "ship",
      "--production",
      "deny",
      "--shipping-mode",
      "standard",
      "--git-push-authorization",
      "never",
      "--migration-handling",
      "never",
    ]);
    expect(denied).toMatchObject({
      gitPushAuthorization: "never",
      migrationHandling: "never",
      productionDeploy: "deny",
    });
    const status = initialize(current, "ship", [
      "--policy-request",
      JSON.stringify(denied),
    ]);
    expect(status.json).toMatchObject({
      gitPushAuthorization: "never",
      migrationHandling: "never",
      policySource: "request",
      policyTrust: "not-required",
      productionDeploy: "deny",
    });
    // A denial stays a denial at the gate, even with production authority.
    expect(gateFor(status.json.productionDeploy, true)).toBe(
      "request-version-approval"
    );
    expect(listPaths(current.configuration)).toEqual([]);
  });

  test("unrelated holds still block with the request", () => {
    const current = fixture();
    const request = JSON.stringify(runOnlySetup(current));
    // Readiness: a handoff without --ready still asks first.
    expect(
      initialize(current, "handoff", ["--policy-request", request]).json
    ).toMatchObject({
      handoffAction: "confirm-readiness",
      mutationAllowed: false,
      policySource: "request",
    });
    // A Simple Changelogs update still blocks a changelog shipment loop.
    const skillRoot = resolve(current.repository.base, "global-skills");
    writeFixture(
      current.repository.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"guidance":{"version":8,"backfillStatus":"deferred"}}\n'
    );
    writeFixture(
      skillRoot,
      "simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n\nCurrent guidance version: 9\n"
    );
    writeFixture(
      skillRoot,
      "simple-changelogs/references/guidance-updates.md",
      "# Guidance Updates\n\n## Guidance 9\n\nProduction Web deployment is now a release boundary. Deployed work must leave Unreleased first. Exact retries reuse the same release version.\n"
    );
    const env = { SIMPLE_CHANGES_SKILL_ROOTS: skillRoot };
    expect(
      current.run(
        [
          "initialize",
          "--mode",
          "ship",
          "--changelog-required",
          "--policy-request",
          request,
          "--json",
          "--repo",
          current.repository.root,
        ],
        env
      ).json
    ).toMatchObject({
      mutationAllowed: false,
      onboardingRequired: false,
      preLoopActionRequired: true,
    });
    const blocked = current.run(
      [
        "loop",
        "start",
        "--mode",
        "ship",
        "--agent-id",
        "controller",
        "--changelog-required",
        "--policy-request",
        request,
        "--repo",
        current.repository.root,
      ],
      env
    );
    expect(blocked.code).toBe(5);
    expect(existsSync(activeLoopPath(current.repository))).toBe(false);
    // Ownership: another agent's loop still refuses a new author.
    const started = current.run([
      "loop",
      "start",
      "--mode",
      "integrate",
      "--agent-id",
      "controller",
      "--json",
      "--repo",
      current.repository.root,
    ]);
    expect(started.code).toBe(0);
    const intruder = initialize(current, "queue", [
      "--agent-id",
      "new-author",
      "--policy-request",
      request,
    ]);
    expect(intruder.code).toBe(5);
    expect(intruder.stderr).toContain(
      "not allowed to run guarded integration mutations"
    );
    expect(
      JSON.parse(readFileSync(activeLoopPath(current.repository), "utf8"))
    ).toMatchObject({ ownerAgentId: "controller" });
  });
});
