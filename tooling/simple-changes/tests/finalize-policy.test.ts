import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  finalizeLoop,
  startLoop,
} from "../../../skills/simple-changes/scripts/lib/loop-lease.ts";
import {
  DEFAULT_POLICY,
  loadPolicy,
  writeRepositoryPolicyTrustReceipt,
} from "../../../skills/simple-changes/scripts/lib/policy.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(
  Number(process.env.SIMPLE_CHANGES_TEST_TIMEOUT_MS ?? "") || 60_000
);

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

const repository = (): TestRepository => {
  const fixture = createTestRepository();
  repositories.push(fixture);
  return fixture;
};

const withOrigin = (root: string): void => {
  git(root, [
    "remote",
    "add",
    "origin",
    "https://example.invalid/canonical.git",
  ]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(root, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
};

// Commits files on a detached HEAD and moves origin/main there, leaving the
// local main branch and the primary checkout where they were.
const advanceTarget = (root: string, files: Record<string, string>): string => {
  git(root, ["checkout", "--quiet", "--detach"]);
  for (const [path, contents] of Object.entries(files)) {
    writeFixture(root, path, contents);
    git(root, ["add", path]);
  }
  git(root, ["commit", "--quiet", "-m", "Advance target"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const target = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "--quiet", "main"]);
  return target;
};

const policyText = (value: object): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const openingPolicy = policyText(DEFAULT_POLICY);
const approvedPolicy = policyText({
  ...DEFAULT_POLICY,
  migrationHandling: "auto-apply-reviewed-routine",
  migrationTargets: [
    { environment: "production", project: "primary-db", provider: "supabase" },
  ],
});

// The primary's HEAD carries the opening policy; the target carries the
// approved migration policy, which the primary's working tree already holds
// with a trust receipt bound to those exact bytes.
const approvedPolicyFixture = (): TestRepository => {
  const fixture = repository();
  writeFixture(fixture.root, ".simple-changes.json", openingPolicy);
  git(fixture.root, ["add", ".simple-changes.json"]);
  git(fixture.root, ["commit", "--quiet", "-m", "Add opening policy"]);
  withOrigin(fixture.root);
  advanceTarget(fixture.root, {
    ".simple-changes.json": approvedPolicy,
    "README.md": "# Current target\n",
  });
  writeFixture(fixture.root, ".simple-changes.json", approvedPolicy);
  writeFixture(fixture.root, "README.md", "# Current target\n");
  writeRepositoryPolicyTrustReceipt(
    fixture.root,
    resolve(fixture.root, ".git"),
    "user",
    "Approve the migration policy"
  );
  expect(
    loadPolicy(fixture.root, {
      commonGitDirectory: resolve(fixture.root, ".git"),
    }).trust
  ).toBe("trusted");
  return fixture;
};

const policyTrust = (root: string): string =>
  loadPolicy(root, { commonGitDirectory: resolve(root, ".git") }).trust;

// The policy file's identity and modification time: equal values mean
// finalization never wrote it.
const policyFileStamp = (root: string): string => {
  const status = statSync(join(root, ".simple-changes.json"));
  return `${status.ino}:${status.mtimeMs}`;
};

describe("finalization keeps approved repository policy", () => {
  test("keeps approved policy bytes and trust when the primary cannot synchronize, and still normalizes other paths", () => {
    const fixture = approvedPolicyFixture();
    // Unrelated unique work keeps the primary from synchronizing.
    writeFixture(fixture.root, "notes.txt", "unrelated draft\n");
    const stamp = policyFileStamp(fixture.root);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The primary still holds unrelated work."
    );

    expect(policyFileStamp(fixture.root)).toBe(stamp);
    expect(finalized.outcome).toBe("relinquished");
    expect(
      readFileSync(join(fixture.root, ".simple-changes.json"), "utf8")
    ).toBe(approvedPolicy);
    expect(policyTrust(fixture.root)).toBe("trusted");
    expect(finalized.cleanup.cleanedPrimaryPaths).toEqual(["README.md"]);
    expect(readFileSync(join(fixture.root, "README.md"), "utf8")).toBe(
      "# Fixture\n"
    );
    expect(finalized.cleanup.notes).toContainEqual(
      expect.stringContaining("Kept .simple-changes.json")
    );
    expect(readFileSync(join(fixture.root, "notes.txt"), "utf8")).toBe(
      "unrelated draft\n"
    );
  });

  test("carries approved policy through the fast-forward without rewriting it", () => {
    const fixture = approvedPolicyFixture();
    const stamp = policyFileStamp(fixture.root);
    const lease = startLoop(fixture.root, "controller", "integrate");

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "Synchronize the primary."
    );

    expect(finalized).toMatchObject({ blockers: [], outcome: "completed" });
    expect(finalized.cleanup.cleanedPrimaryPaths).toEqual(["README.md"]);
    expect(finalized.cleanup.notes).toContainEqual(
      expect.stringContaining("Carried .simple-changes.json")
    );
    expect(git(fixture.root, ["status", "--short"])).toBe("");
    expect(git(fixture.root, ["rev-parse", "main"])).toBe(
      git(fixture.root, ["rev-parse", "origin/main"])
    );
    expect(policyFileStamp(fixture.root)).toBe(stamp);
    expect(
      readFileSync(join(fixture.root, ".simple-changes.json"), "utf8")
    ).toBe(approvedPolicy);
    expect(policyTrust(fixture.root)).toBe("trusted");
  });

  test("keeps approved policy and its index entry when the fast-forward fails", () => {
    const fixture = approvedPolicyFixture();
    const stamp = policyFileStamp(fixture.root);
    const lease = startLoop(fixture.root, "controller", "integrate");
    // Every reference update fails, so the fast-forward cannot land.
    const hook = join(fixture.root, ".git", "hooks", "reference-transaction");
    writeFileSync(hook, '#!/bin/sh\n[ "$1" = prepared ] && exit 1\nexit 0\n');
    chmodSync(hook, 0o755);

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The fast-forward is refused."
    );

    expect(finalized.outcome).toBe("relinquished");
    expect(
      readFileSync(join(fixture.root, ".simple-changes.json"), "utf8")
    ).toBe(approvedPolicy);
    expect(policyTrust(fixture.root)).toBe("trusted");
    expect(policyFileStamp(fixture.root)).toBe(stamp);
    expect(finalized.cleanup.cleanedPrimaryPaths).toEqual(["README.md"]);
    expect(finalized.cleanup.notes).toContainEqual(
      expect.stringContaining("Kept .simple-changes.json")
    );
    // The entry staged for the fast-forward returned to the HEAD entry.
    expect(git(fixture.root, ["diff", "--cached", "--name-only"])).toBe("");
  });

  test("keeps approved policy when the primary would need a switch to a lagging local target", () => {
    const fixture = repository();
    writeFixture(fixture.root, ".simple-changes.json", openingPolicy);
    git(fixture.root, ["add", ".simple-changes.json"]);
    git(fixture.root, ["commit", "--quiet", "-m", "Add opening policy"]);
    git(fixture.root, ["branch", "work"]);
    const intermediatePolicy = policyText({
      ...DEFAULT_POLICY,
      productionDeploy: "deny",
    });
    writeFixture(fixture.root, ".simple-changes.json", intermediatePolicy);
    git(fixture.root, ["commit", "--quiet", "-am", "Intermediate policy"]);
    withOrigin(fixture.root);
    advanceTarget(fixture.root, {
      ".simple-changes.json": approvedPolicy,
      "README.md": "# Current target\n",
    });
    git(fixture.root, ["switch", "--quiet", "work"]);
    writeFixture(fixture.root, ".simple-changes.json", approvedPolicy);
    writeFixture(fixture.root, "README.md", "# Current target\n");
    const stamp = policyFileStamp(fixture.root);
    writeRepositoryPolicyTrustReceipt(
      fixture.root,
      resolve(fixture.root, ".git"),
      "user",
      "Approve the migration policy"
    );
    const lease = startLoop(fixture.root, "controller", "integrate");
    // Even if a switch happened, the fast-forward to the unsigned refreshed
    // target would be refused.
    git(fixture.root, ["config", "merge.verifySignatures", "true"]);

    const finalized = finalizeLoop(
      fixture.root,
      lease.runId,
      "controller",
      "The primary would need a switch."
    );

    expect(finalized.outcome).toBe("relinquished");
    expect(git(fixture.root, ["branch", "--show-current"])).toBe("work");
    expect(policyFileStamp(fixture.root)).toBe(stamp);
    expect(
      readFileSync(join(fixture.root, ".simple-changes.json"), "utf8")
    ).toBe(approvedPolicy);
    expect(policyTrust(fixture.root)).toBe("trusted");
    expect(finalized.cleanup.notes).toContainEqual(
      expect.stringContaining("Kept .simple-changes.json")
    );
  });
});
