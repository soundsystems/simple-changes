import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { auditBranchReplacements } from "../../../skills/simple-changes/scripts/lib/branch-audit.ts";
import { targetContainmentAudit } from "../../../skills/simple-changes/scripts/lib/cleanup-core.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

setDefaultTimeout(30_000);
const fixtures: TestRepository[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup();
  }
});
const commit = (
  root: string,
  path: string,
  body: string,
  message: string
): string => {
  writeFixture(root, path, body);
  git(root, ["add", path]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
};
const fixtureWithSource = () => {
  const fixture = createTestRepository();
  fixtures.push(fixture);
  git(fixture.root, ["switch", "-c", "old-source"]);
  const source = commit(
    fixture.root,
    "actions.ts",
    "export const label = 'View';\n",
    "Add record actions"
  );
  git(fixture.root, ["switch", "main"]);
  return { ...fixture, source };
};
const audit = (root: string) =>
  auditBranchReplacements({
    headRef: "old-source",
    repositoryRoot: root,
    targetRef: "main",
  });

const appendEmptyHistory = (root: string, branch: string, count: number) => {
  const parent = git(root, ["rev-parse", branch]);
  const stream = Array.from({ length: count }, (_, index) => {
    const message = `Unrelated ${branch} history ${index}`;
    return [
      `commit refs/heads/${branch}`,
      `committer Fixture <fixture@example.invalid> ${1_700_000_000 + index} +0000`,
      `data ${message.length}`,
      message,
      ...(index === 0 ? [`from ${parent}`] : []),
      "",
    ].join("\n");
  }).join("\n");
  const result = spawnSync(["git", "-C", root, "fast-import", "--quiet"], {
    stderr: "pipe",
    stdin: new TextEncoder().encode(`${stream}\ndone\n`),
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(0);
};

describe("replacement branch audit", () => {
  test("finds legacy rebased work before creating a checkout, without permitting cleanup", () => {
    const fixture = fixtureWithSource();
    const replacement = commit(
      fixture.root,
      "actions.ts",
      "export const label = 'Location history';\n",
      "Add record actions"
    );
    commit(
      fixture.root,
      "actions.ts",
      "export const label = 'Location history';\nexport const dismiss = true;\n",
      "Fix dismissal"
    );
    const before = git(fixture.root, ["status", "--porcelain"]);
    const result = audit(fixture.root);
    expect(result.status).toBe("review-required");
    expect(result.commits[0]?.candidates).toEqual([
      {
        basis: "subject-and-paths",
        rangeDiffArgs: [
          "range-diff",
          "--no-color",
          `${fixture.source}^!`,
          `${replacement}^!`,
        ],
        sharedPaths: ["actions.ts"],
        targetSha: replacement,
      },
    ]);
    expect(
      targetContainmentAudit(
        fixture.root,
        result.targetRevision,
        fixture.source
      ).method
    ).toBeNull();
    expect(git(fixture.root, ["status", "--porcelain"])).toBe(before);
    expect(git(fixture.root, ["branch", "--show-current"])).toBe("main");
    expect(existsSync(join(fixture.root, ".git/simple-changes"))).toBe(false);
  });

  test("finds recorded lineage even when replacement changes title and files", () => {
    const fixture = fixtureWithSource();
    const replacement = commit(
      fixture.root,
      "renamed-actions.ts",
      "export const label = 'View';\n",
      `Consolidate actions\n\nOriginal-Commit: ${fixture.source}`
    );
    const result = audit(fixture.root);
    expect(result.commits[0]?.candidates[0]).toMatchObject({
      basis: "original-commit-trailer",
      sharedPaths: [],
      targetSha: replacement,
    });
    expect(result.status).toBe("review-required");
    expect(
      targetContainmentAudit(
        fixture.root,
        result.targetRevision,
        fixture.source
      ).method
    ).toBeNull();
  });

  test("does not treat matching subjects on different paths or abbreviated trailers as evidence", () => {
    const fixture = fixtureWithSource();
    commit(
      fixture.root,
      "other.ts",
      "unrelated\n",
      `Add record actions\n\nOriginal-Commit: ${fixture.source.slice(0, 8)}`
    );
    expect(audit(fixture.root).status).toBe("unproven");
    expect(audit(fixture.root).commits[0]?.candidates).toEqual([]);
  });

  test("accounts for multiple original commits recorded by a squash", () => {
    const fixture = fixtureWithSource();
    git(fixture.root, ["switch", "old-source"]);
    const second = commit(
      fixture.root,
      "second.ts",
      "second\n",
      "Add another action"
    );
    git(fixture.root, ["switch", "main"]);
    const replacement = commit(
      fixture.root,
      "combined.ts",
      "combined\n",
      `Squash actions\n\nOriginal-Commit: ${fixture.source}\nOriginal-Commit: ${second}`
    );
    const result = audit(fixture.root);
    expect(result.commits).toHaveLength(2);
    for (const source of result.commits) {
      expect(source.candidates).toMatchObject([
        { basis: "original-commit-trailer", targetSha: replacement },
      ]);
    }
    expect(result.status).toBe("review-required");
  });

  test("reports truncated histories instead of claiming an exhaustive search", () => {
    const fixture = fixtureWithSource();
    commit(fixture.root, "actions.ts", "reworked\n", "Add record actions");
    appendEmptyHistory(fixture.root, "old-source", 201);
    appendEmptyHistory(fixture.root, "main", 1001);
    const result = audit(fixture.root);
    expect(result).toMatchObject({
      sourceHistoryTruncated: true,
      status: "unproven",
      targetHistoryTruncated: true,
    });
    expect(result.commits).toHaveLength(200);
    expect(result.commits.some((source) => source.sha === fixture.source)).toBe(
      false
    );
  });

  test("only discovers replacements reachable from the selected target", () => {
    const fixture = fixtureWithSource();
    git(fixture.root, ["switch", "-c", "unmerged-replacement"]);
    commit(
      fixture.root,
      "actions.ts",
      "reworked\n",
      `Replacement\n\nOriginal-Commit: ${fixture.source}`
    );
    git(fixture.root, ["switch", "main"]);
    expect(audit(fixture.root).status).toBe("unproven");
  });

  test("preserves an extra source commit even when an earlier commit has a candidate", () => {
    const fixture = fixtureWithSource();
    commit(fixture.root, "actions.ts", "reworked\n", "Add record actions");
    git(fixture.root, ["switch", "old-source"]);
    const extra = commit(
      fixture.root,
      "new.ts",
      "not shipped\n",
      "New feature"
    );
    git(fixture.root, ["switch", "main"]);
    const result = audit(fixture.root);
    expect(
      result.commits.find((item) => item.sha === extra)?.candidates
    ).toEqual([]);
    expect(
      targetContainmentAudit(fixture.root, result.targetRevision, extra).method
    ).toBeNull();
  });

  test("reports containment only from exact ancestry", () => {
    const fixture = fixtureWithSource();
    git(fixture.root, ["merge", "--ff-only", "old-source"]);
    expect(audit(fixture.root)).toMatchObject({
      commits: [],
      sourceHistoryTruncated: false,
      status: "target-contained",
      targetHistoryTruncated: false,
    });
  });

  test("limits ambiguous candidates without claiming completeness", () => {
    const fixture = fixtureWithSource();
    for (let index = 0; index < 12; index += 1) {
      commit(
        fixture.root,
        "actions.ts",
        `revision ${index}\n`,
        "Add record actions"
      );
    }
    const result = audit(fixture.root);
    expect(result.commits[0]?.candidates).toHaveLength(10);
    expect(result.commits[0]?.candidatesTruncated).toBe(true);
  });

  test("CLI audits the named branch without switching or changing worktrees", () => {
    const fixture = fixtureWithSource();
    commit(fixture.root, "actions.ts", "reworked\n", "Add record actions");
    const cli = join(
      import.meta.dir,
      "../../../skills/simple-changes/scripts/simple-changes.ts"
    );
    const result = spawnSync(
      [
        "bun",
        cli,
        "branch",
        "audit",
        "--head",
        "old-source",
        "--target",
        "main",
        "--repo",
        fixture.root,
        "--json",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout)).status).toBe(
      "review-required"
    );
    expect(git(fixture.root, ["branch", "--show-current"])).toBe("main");
  });
});
