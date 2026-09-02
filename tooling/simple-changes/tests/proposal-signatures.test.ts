import { afterEach, describe, expect, test } from "bun:test";
import {
  buildProposalSignatureBlock,
  normalizeAgentName,
  signatureLine,
} from "../../../skills/simple-changes/scripts/lib/proposal-signatures.ts";
import {
  createTestRepository,
  git,
  type TestRepository,
  writeFixture,
} from "./helpers.ts";

let repositories: TestRepository[] = [];

afterEach(() => {
  for (const fixture of repositories) {
    fixture.cleanup();
  }
  repositories = [];
});

describe("proposal signatures", () => {
  test("normalizes harness and trailer identities to the public model name", () => {
    expect(normalizeAgentName("Claude Fable 5.1 <noreply@anthropic.com>")).toBe(
      "Fable 5.1"
    );
    expect(normalizeAgentName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(signatureLine("merged", "Opus 5")).toBe("[[Merged by Opus 5]]");
  });

  test("credits co-authors from commit trailers and changelog signers from the receipt paths", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      '# Changelog\n\n## 0.0.1\n\n- Historical.\n<!-- simple-changelogs-signature agent="historical-agent" at="2026-08-01T09:00:00-05:00" -->\n'
    );
    git(fixture.root, ["add", "CHANGELOG.md"]);
    git(fixture.root, ["commit", "-m", "docs: Historical release notes"]);
    git(fixture.root, ["checkout", "-b", "feature"]);
    writeFixture(fixture.root, "src.ts", "export const value = 1;\n");
    git(fixture.root, ["add", "src.ts"]);
    git(fixture.root, [
      "commit",
      "-m",
      "feat: Add value\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
    ]);
    writeFixture(
      fixture.root,
      "CHANGELOG.md",
      '# Changelog\n\n## 0.1.0 - 2026-09-02\n\n- Added value.\n<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-09-02T09:00:00-05:00" -->\n\n## 0.0.1\n\n- Historical.\n<!-- simple-changelogs-signature agent="historical-agent" at="2026-08-01T09:00:00-05:00" -->\n'
    );
    git(fixture.root, ["add", "CHANGELOG.md"]);
    git(fixture.root, [
      "commit",
      "-m",
      "docs: Release notes\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>",
    ]);

    const result = buildProposalSignatureBlock({
      baseRef: "main",
      changelogPaths: ["CHANGELOG.md", "missing/DEVELOPER_CHANGELOG.md"],
      headRef: "feature",
      repositoryPath: fixture.root,
      self: { agent: "Fable 5.1", role: "authored" },
    });

    expect(result.block).toBe(
      [
        "[[Authored by Fable 5.1]]",
        "[[Co-authored by Opus 5]]",
        "[[Changelog by gpt-5.6-sol]]",
      ].join("\n")
    );
    expect(result.credits.map((credit) => credit.role)).toEqual([
      "authored",
      "co-authored",
      "changelog",
    ]);
    expect(result.block).not.toContain("historical-agent");
  });

  test("signs a review without commit or changelog evidence", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    expect(
      buildProposalSignatureBlock({
        repositoryPath: fixture.root,
        self: { agent: "Claude Opus 5", role: "reviewed" },
      }).block
    ).toBe("[[Reviewed by Opus 5]]");
    expect(() =>
      buildProposalSignatureBlock({
        baseRef: "--output=/tmp/x",
        headRef: "feature",
        repositoryPath: fixture.root,
      })
    ).toThrow("plain Git reference");
    expect(() =>
      buildProposalSignatureBlock({
        changelogPaths: ["CHANGELOG.md"],
        repositoryPath: fixture.root,
      })
    ).toThrow("base and head refs are required");
    expect(() =>
      buildProposalSignatureBlock({
        baseRef: "main",
        changelogPaths: ["../outside.md"],
        headRef: "HEAD",
        repositoryPath: fixture.root,
      })
    ).toThrow("Unsafe repository path");
  });
});
