import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { inspectChangelogCoordination } from "../../../skills/simple-changes/scripts/lib/changelog-coordination.ts";
import {
  createTestRepository,
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

const inspect = (fixture: TestRepository) =>
  inspectChangelogCoordination(fixture.root, {
    environment: {
      SIMPLE_CHANGES_SKILL_ROOTS: "",
    },
  });

describe("changelog coordination discovery", () => {
  test("does not invent changelog relevance for a plain repository", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);

    expect(inspect(fixture)).toEqual({
      capabilityAvailable: false,
      capabilityHelpers: [],
      capabilityStatus: "absent",
      guidanceUpdate: {
        actions: [],
        detailsPath: null,
        headline: "**Simple Changelogs has recently been updated.**",
        installedVersion: null,
        owner: null,
        policyPath: null,
        provider: null,
        status: "absent",
        storedVersion: null,
        summaryBullets: [],
        walkthroughQuestion:
          "Would you like me to walk you through the recent Simple Changelogs updates before I continue?",
      },
      providerEvidence: "none",
      providers: [],
      releaseSurfaces: [],
      relevant: false,
    });
  });

  test("distinguishes release surfaces from an available changelog skill", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(fixture.root, "CHANGELOG.md", "# Changelog\n");
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1}\n'
    );

    expect(inspect(fixture)).toMatchObject({
      capabilityAvailable: false,
      releaseSurfaces: [".simple-changelogs.json", "CHANGELOG.md"],
      relevant: true,
    });
  });

  test("discovers a repository-local compatible skill", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "skills/simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n"
    );
    writeFixture(
      fixture.root,
      "skills/simple-changelogs/scripts/setup.ts",
      "export {};\n"
    );

    const result = inspect(fixture);
    expect(result).toMatchObject({
      capabilityAvailable: true,
      capabilityStatus: "unverified",
      relevant: true,
    });
    expect(result.capabilityHelpers).toEqual([
      join(fixture.root, "skills/simple-changelogs/scripts/setup.ts"),
    ]);
    expect(result.providers[0]).toEndWith("/skills/simple-changelogs/SKILL.md");
  });

  test("discovers a compatible skill from configured global roots", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = join(fixture.base, "global-skills");
    writeFixture(
      skillRoot,
      "simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n"
    );

    const result = inspectChangelogCoordination(fixture.root, {
      environment: {
        SIMPLE_CHANGES_SKILL_ROOTS: skillRoot,
      },
    });

    expect(result).toMatchObject({
      capabilityAvailable: true,
      relevant: true,
    });
    expect(result.providers).toEqual([
      join(skillRoot, "simple-changelogs/SKILL.md"),
    ]);
  });

  test("counts a provider reachable through a symlinked root once", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = join(fixture.base, "global-skills");
    const linkedRoot = join(fixture.base, "linked-skills");
    writeFixture(
      skillRoot,
      "simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n"
    );
    writeFixture(
      skillRoot,
      "simple-changelogs/scripts/setup.ts",
      "export {};\n"
    );
    symlinkSync(skillRoot, linkedRoot, "dir");

    const result = inspectChangelogCoordination(fixture.root, {
      environment: {
        SIMPLE_CHANGES_SKILL_ROOTS: [linkedRoot, skillRoot].join(delimiter),
      },
    });

    expect(result.providers).toEqual([
      join(linkedRoot, "simple-changelogs/SKILL.md"),
    ]);
    expect(result.capabilityHelpers).toEqual([
      join(linkedRoot, "simple-changelogs/scripts/setup.ts"),
    ]);
  });

  test("rejects a full distribution for a skill-repository policy", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = join(fixture.base, "global-skills");
    writeFixture(
      skillRoot,
      "simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Full cross-surface Simple Changelogs distribution.\n---\n\nDo not use when a repository selects the skill-repository distribution.\n"
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"distribution":"skill-repository","guidance":{"version":8}}\n'
    );

    const result = inspectChangelogCoordination(fixture.root, {
      environment: { SIMPLE_CHANGES_SKILL_ROOTS: skillRoot },
    });

    expect(result).toMatchObject({
      capabilityAvailable: false,
      providers: [],
      relevant: true,
    });
  });

  test("discovers every exact narrower distribution installation", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const distributions = [
      ["mobile", "simple-changelogs-mobile"],
      ["skill-repository", "simple-changelogs-skill-maintainer"],
      ["web", "simple-changelogs-web"],
      ["web-cms", "simple-changelogs-web-cms"],
    ] as const;
    for (const [distribution, installation] of distributions) {
      writeFixture(
        fixture.root,
        `skills/${installation}/SKILL.md`,
        `---\nname: ${installation}\ndescription: ${distribution} distribution.\n---\n`
      );
      writeFixture(
        fixture.root,
        ".simple-changelogs.json",
        `${JSON.stringify({ distribution, guidance: { version: 9 }, schemaVersion: 1 })}\n`
      );

      expect(inspect(fixture)).toMatchObject({
        capabilityAvailable: true,
        providers: [join(fixture.root, `skills/${installation}/SKILL.md`)],
      });
    }
  });

  test("prefers the declared provider marker over installation-name and prose evidence", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "skills/simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: full cross-surface Simple Changelogs distribution.\n---\n\nCurrent guidance version: 3\n"
    );
    writeFixture(
      fixture.root,
      "skills/simple-changelogs/changelog-provider.json",
      `${JSON.stringify({
        distribution: "web",
        guidanceVersion: 12,
        provider: "simple-changelogs",
        schemaVersion: 1,
      })}\n`
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      `${JSON.stringify({ distribution: "web", guidance: { version: 9 }, schemaVersion: 1 })}\n`
    );

    expect(inspect(fixture)).toMatchObject({
      capabilityAvailable: true,
      guidanceUpdate: { installedVersion: 12, status: "update-available" },
      providerEvidence: "marker",
    });
  });

  test("falls back to inferred evidence when no marker is installed", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "skills/simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: full cross-surface Simple Changelogs distribution.\n---\n\nCurrent guidance version: 7\n"
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      `${JSON.stringify({ distribution: "full", guidance: { version: 7 }, schemaVersion: 1 })}\n`
    );

    expect(inspect(fixture)).toMatchObject({
      guidanceUpdate: { installedVersion: 7 },
      providerEvidence: "inferred",
    });
  });

  test("detects a newer installed Simple Changelogs guidance version", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = join(fixture.base, "global-skills");
    writeFixture(
      skillRoot,
      "simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n\n# Simple Changelogs\n\nCurrent guidance version: 9\n"
    );
    writeFixture(
      skillRoot,
      "simple-changelogs/references/guidance-updates.md",
      "# Guidance Updates\n\n## Guidance 9\n\nRelease behavior changed.\n"
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"guidance":{"version":8,"backfillStatus":"deferred"}}\n'
    );

    const result = inspectChangelogCoordination(fixture.root, {
      environment: {
        SIMPLE_CHANGES_SKILL_ROOTS: skillRoot,
      },
    });

    expect(result.guidanceUpdate).toEqual({
      actions: ["walkthrough", "continue", "view-release-notes"],
      detailsPath: join(
        skillRoot,
        "simple-changelogs/references/guidance-updates.md"
      ),
      headline: "**Simple Changelogs has recently been updated.**",
      installedVersion: 9,
      owner: "simple-changelogs",
      policyPath: join(fixture.root, ".simple-changelogs.json"),
      provider: join(skillRoot, "simple-changelogs/SKILL.md"),
      status: "update-available",
      storedVersion: 8,
      summaryBullets: ["Release behavior changed."],
      walkthroughQuestion:
        "Would you like me to walk you through the recent Simple Changelogs updates before I continue?",
    });
  });

  test("keeps inline code spans intact when summarizing guidance", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = join(fixture.base, "global-skills");
    writeFixture(
      skillRoot,
      "simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n\nCurrent guidance version: 9\n"
    );
    writeFixture(
      skillRoot,
      "simple-changelogs/references/guidance-updates.md",
      "# Guidance Updates\n\n## Guidance 9\n\nReleases now rewrite `CHANGELOG.md` in place! Run `scripts/query.ts` for history (v1.2 or later). Nothing else changed.\n"
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"guidance":{"version":8,"backfillStatus":"deferred"}}\n'
    );

    const result = inspectChangelogCoordination(fixture.root, {
      environment: { SIMPLE_CHANGES_SKILL_ROOTS: skillRoot },
    });

    expect(result.guidanceUpdate.summaryBullets).toEqual([
      "Releases now rewrite `CHANGELOG.md` in place!",
      "Run `scripts/query.ts` for history (v1.2 or later).",
      "Nothing else changed.",
    ]);
  });

  test("stays silent when Simple Changelogs is installed and current", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = join(fixture.base, "global-skills");
    writeFixture(
      skillRoot,
      "simple-changelogs/SKILL.md",
      "---\nname: simple-changelogs\ndescription: Test fixture.\n---\n\nCurrent guidance version: 9\n"
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"guidance":{"version":9,"backfillStatus":"completed"}}\n'
    );

    const result = inspectChangelogCoordination(fixture.root, {
      environment: { SIMPLE_CHANGES_SKILL_ROOTS: skillRoot },
    });

    expect(result.guidanceUpdate).toMatchObject({
      actions: [],
      installedVersion: 9,
      status: "current",
      storedVersion: 9,
      summaryBullets: [],
    });
  });
});
