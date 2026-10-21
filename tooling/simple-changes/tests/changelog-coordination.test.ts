import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
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
      providerDistribution: null,
      providerEvidence: "none",
      providers: [],
      releaseSurfaces: [],
      relevant: false,
    });
  });

  test("recognizes CMS-only release surfaces without a provider", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      ".simple-changelogs-cms.json",
      '{"schemaVersion":1,"guidance":{"version":4,"backfillStatus":"completed"},"changelogPath":"CMS_CHANGELOG.json"}\n'
    );
    writeFixture(
      fixture.root,
      "CMS_CHANGELOG.json",
      '{"schemaVersion":1,"title":"CMS Changelog","entries":[]}\n'
    );

    expect(inspect(fixture)).toMatchObject({
      capabilityAvailable: false,
      capabilityStatus: "absent",
      guidanceUpdate: {
        policyPath: join(fixture.root, ".simple-changelogs-cms.json"),
        status: "absent",
        storedVersion: 4,
      },
      providerDistribution: null,
      providers: [],
      releaseSurfaces: [".simple-changelogs-cms.json", "CMS_CHANGELOG.json"],
      relevant: true,
    });
  });

  test("reports a CMS-only provider as a handoff-capable participant", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "skills/simple-changelogs-cms/SKILL.md",
      "---\nname: simple-changelogs-cms\ndescription: CMS-only distribution.\n---\n\nCurrent guidance version: 5\n"
    );
    writeFixture(
      fixture.root,
      "skills/simple-changelogs-cms/changelog-provider.json",
      `${JSON.stringify({
        distribution: "cms",
        features: ["classify-prepare-verify", "guidance-update-notices"],
        guidanceVersion: 5,
        provider: "simple-changelogs",
        receiptVersions: [1, 2],
        requestVersions: [1],
        schemaDigests: {
          changelogReceipt: "a".repeat(64),
          changelogRequest: "b".repeat(64),
        },
        schemaVersion: 1,
      })}\n`
    );
    writeFixture(
      fixture.root,
      "skills/simple-changelogs-cms/scripts/setup.ts",
      "export {};\n"
    );
    writeFixture(
      fixture.root,
      "skills/simple-changelogs-cms/references/guidance-updates.md",
      "# Guidance Updates\n\n## Guidance 5\n\nOperator history validation changed.\n"
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs-cms.json",
      '{"schemaVersion":1,"guidance":{"version":4,"backfillStatus":"completed"},"changelogPath":"CMS_CHANGELOG.json"}\n'
    );
    writeFixture(
      fixture.root,
      "CMS_CHANGELOG.json",
      '{"schemaVersion":1,"title":"CMS Changelog","entries":[]}\n'
    );

    const result = inspect(fixture);
    expect(result).toMatchObject({
      capabilityAvailable: true,
      capabilityStatus: "unverified",
      guidanceUpdate: {
        installedVersion: 5,
        owner: "simple-changelogs",
        policyPath: join(fixture.root, ".simple-changelogs-cms.json"),
        status: "update-available",
        storedVersion: 4,
        summaryBullets: ["Operator history validation changed."],
      },
      providerDistribution: "cms",
      providerEvidence: "marker",
      providers: [join(fixture.root, "skills/simple-changelogs-cms/SKILL.md")],
      releaseSurfaces: [".simple-changelogs-cms.json", "CMS_CHANGELOG.json"],
      relevant: true,
    });
    expect(result.capabilityHelpers).toEqual([
      join(fixture.root, "skills/simple-changelogs-cms/scripts/setup.ts"),
    ]);
  });

  test("reports a provider whose marker advertises no protocol as not applicable", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "skills/simple-changelogs-web/SKILL.md",
      "---\nname: simple-changelogs-web\ndescription: Web distribution.\n---\n\nCurrent guidance version: 9\n"
    );
    writeFixture(
      fixture.root,
      "skills/simple-changelogs-web/changelog-provider.json",
      `${JSON.stringify({
        distribution: "web",
        features: ["guidance-update-notices"],
        guidanceVersion: 9,
        provider: "simple-changelogs",
        receiptVersions: [],
        requestVersions: [],
        schemaVersion: 1,
      })}\n`
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"distribution":"web","guidance":{"version":9}}\n'
    );

    expect(inspect(fixture)).toMatchObject({
      capabilityAvailable: false,
      capabilityStatus: "not-applicable",
      providerDistribution: "web",
      providerEvidence: "marker",
      providers: [join(fixture.root, "skills/simple-changelogs-web/SKILL.md")],
      relevant: true,
    });
  });

  test("infers the CMS distribution from the installation name without a marker", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "skills/simple-changelogs-cms/SKILL.md",
      "---\nname: simple-changelogs-cms\ndescription: CMS-only distribution.\n---\n\nCurrent guidance version: 5\n"
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs-cms.json",
      '{"schemaVersion":1,"guidance":{"version":5,"backfillStatus":"completed"}}\n'
    );

    expect(inspect(fixture)).toMatchObject({
      capabilityAvailable: true,
      capabilityStatus: "unverified",
      guidanceUpdate: {
        installedVersion: 5,
        status: "current",
        storedVersion: 5,
      },
      providerDistribution: "cms",
      providerEvidence: "inferred",
      relevant: true,
    });
  });

  test("prefers a handoff-capable provider over a CMS-only installation for a standard policy", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    for (const installation of ["simple-changelogs-cms", "simple-changelogs"]) {
      writeFixture(
        fixture.root,
        `skills/${installation}/SKILL.md`,
        `---\nname: ${installation}\ndescription: ${installation} fixture.\n---\n\nCurrent guidance version: 9\n`
      );
    }
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"guidance":{"version":9,"backfillStatus":"completed"}}\n'
    );

    const result = inspect(fixture);
    expect(result).toMatchObject({
      capabilityAvailable: true,
      capabilityStatus: "unverified",
      providerDistribution: "full",
      releaseSurfaces: [".simple-changelogs.json"],
      relevant: true,
    });
    expect(result.providers).toEqual([
      join(fixture.root, "skills/simple-changelogs/SKILL.md"),
      join(fixture.root, "skills/simple-changelogs-cms/SKILL.md"),
    ]);
    expect(result.guidanceUpdate.provider).toBe(
      join(fixture.root, "skills/simple-changelogs/SKILL.md")
    );
  });

  test("excludes a CMS-only installation from a repository that selects another distribution", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    writeFixture(
      fixture.root,
      "skills/simple-changelogs-cms/SKILL.md",
      "---\nname: simple-changelogs-cms\ndescription: CMS-only distribution.\n---\n"
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      '{"schemaVersion":1,"distribution":"web","guidance":{"version":9}}\n'
    );

    expect(inspect(fixture)).toMatchObject({
      capabilityAvailable: false,
      capabilityStatus: "absent",
      providerDistribution: null,
      providers: [],
      relevant: true,
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

describe("repository-owned renamed changelog providers", () => {
  const RENAMED = ".agents/skills/hash-changelog-maintainer";
  const markerFor = (overrides: Record<string, unknown> = {}): string =>
    `${JSON.stringify({
      distribution: "full",
      features: ["classify-prepare-verify", "guidance-update-notices"],
      guidanceVersion: 9,
      provider: "simple-changelogs",
      receiptVersions: [1, 2],
      requestVersions: [1],
      schemaVersion: 1,
      ...overrides,
    })}\n`;
  const writeProvider = (
    root: string,
    folder: string,
    marker: string | null,
    guidanceVersion = 9
  ): void => {
    writeFixture(
      root,
      `${folder}/SKILL.md`,
      `---\nname: ${folder.split("/").at(-1)}\ndescription: Test fixture.\n---\n\nCurrent guidance version: ${guidanceVersion}\n`
    );
    if (marker !== null) {
      writeFixture(root, `${folder}/changelog-provider.json`, marker);
    }
  };
  // The reported failure: a newer global install would otherwise be selected
  // and demand a guidance update the repository never chose.
  const withNewerGlobal = (fixture: TestRepository): string => {
    const skillRoot = join(fixture.base, "global-skills");
    writeProvider(
      skillRoot,
      "simple-changelogs",
      markerFor({ guidanceVersion: 12 }),
      12
    );
    writeFixture(
      skillRoot,
      "simple-changelogs/references/guidance-updates.md",
      "# Guidance Updates\n\n## Guidance 12\n\nGlobal behavior changed.\n"
    );
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      `${JSON.stringify({ distribution: "full", guidance: { version: 9 }, schemaVersion: 1 })}\n`
    );
    return skillRoot;
  };
  const inspectWith = (fixture: TestRepository, skillRoot: string) =>
    inspectChangelogCoordination(fixture.root, {
      environment: { SIMPLE_CHANGES_SKILL_ROOTS: skillRoot },
    });
  const globalWins = (fixture: TestRepository, skillRoot: string): void => {
    const result = inspectWith(fixture, skillRoot);
    const globalProvider = join(skillRoot, "simple-changelogs/SKILL.md");
    // Compared by real path: a repository skill root linked to the global
    // root reaches the same global installation by its installation name.
    expect(result.providers.map((path) => realpathSync(path))).toEqual([
      globalProvider,
    ]);
    expect(result.guidanceUpdate).toMatchObject({
      installedVersion: 12,
      status: "update-available",
    });
    expect(realpathSync(result.guidanceUpdate.provider ?? "")).toBe(
      globalProvider
    );
  };

  test("selects a renamed repository folder with a valid marker over a newer global install", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = withNewerGlobal(fixture);
    writeProvider(fixture.root, RENAMED, markerFor());
    writeFixture(fixture.root, `${RENAMED}/scripts/setup.ts`, "export {};\n");

    const result = inspectWith(fixture, skillRoot);
    expect(result).toMatchObject({
      capabilityAvailable: true,
      capabilityStatus: "unverified",
      guidanceUpdate: {
        actions: [],
        detailsPath: null,
        installedVersion: 9,
        provider: join(fixture.root, `${RENAMED}/SKILL.md`),
        status: "current",
        storedVersion: 9,
      },
      providerDistribution: "full",
      providerEvidence: "marker",
      relevant: true,
    });
    expect(result.providers).toEqual([
      join(fixture.root, `${RENAMED}/SKILL.md`),
      join(skillRoot, "simple-changelogs/SKILL.md"),
    ]);
    expect(result.capabilityHelpers[0]).toBe(
      join(fixture.root, `${RENAMED}/scripts/setup.ts`)
    );
  });

  test("discovers a renamed repository folder linked to another folder inside the repository", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = withNewerGlobal(fixture);
    writeProvider(fixture.root, "tools/hash-changelog-maintainer", markerFor());
    mkdirSync(join(fixture.root, ".agents/skills"), { recursive: true });
    symlinkSync(
      join(fixture.root, "tools/hash-changelog-maintainer"),
      join(fixture.root, RENAMED),
      "dir"
    );

    expect(inspectWith(fixture, skillRoot).guidanceUpdate).toMatchObject({
      provider: join(fixture.root, `${RENAMED}/SKILL.md`),
      status: "current",
    });
  });

  test("keeps an installation-name repository provider ahead of a renamed one", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = withNewerGlobal(fixture);
    writeProvider(fixture.root, RENAMED, markerFor());
    writeProvider(fixture.root, "skills/simple-changelogs", null);

    expect(inspectWith(fixture, skillRoot).providers).toEqual([
      join(fixture.root, "skills/simple-changelogs/SKILL.md"),
      join(fixture.root, `${RENAMED}/SKILL.md`),
      join(skillRoot, "simple-changelogs/SKILL.md"),
    ]);
  });

  test("ignores a renamed repository folder without a marker", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = withNewerGlobal(fixture);
    writeProvider(fixture.root, RENAMED, null);

    globalWins(fixture, skillRoot);
  });

  test("ignores a renamed repository folder whose marker names another provider or schema", () => {
    for (const marker of [
      markerFor({ provider: "hash-changelogs" }),
      markerFor({ schemaVersion: 2 }),
      "{not json\n",
    ]) {
      const fixture = createTestRepository();
      repositories.push(fixture);
      const skillRoot = withNewerGlobal(fixture);
      writeProvider(fixture.root, RENAMED, marker);

      globalWins(fixture, skillRoot);
    }
  });

  test("never discovers a renamed folder in a global skill root", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = join(fixture.base, "global-skills");
    writeProvider(skillRoot, "hash-changelog-maintainer", markerFor());
    writeFixture(
      fixture.root,
      ".simple-changelogs.json",
      `${JSON.stringify({ distribution: "full", guidance: { version: 9 }, schemaVersion: 1 })}\n`
    );

    expect(inspectWith(fixture, skillRoot)).toMatchObject({
      capabilityAvailable: false,
      capabilityStatus: "absent",
      guidanceUpdate: { provider: null, status: "absent" },
      providers: [],
    });
  });

  test("ignores a renamed repository folder whose real path leaves the repository", () => {
    const outsideLinks = [
      // The folder itself links to an installation outside the repository.
      (fixture: TestRepository, skillRoot: string) => {
        writeProvider(skillRoot, "hash-changelog-maintainer", markerFor());
        mkdirSync(join(fixture.root, ".agents/skills"), { recursive: true });
        symlinkSync(
          join(skillRoot, "hash-changelog-maintainer"),
          join(fixture.root, RENAMED),
          "dir"
        );
      },
      // The whole repository skill root links to a global root.
      (fixture: TestRepository, skillRoot: string) => {
        writeProvider(skillRoot, "hash-changelog-maintainer", markerFor());
        mkdirSync(join(fixture.root, ".agents"), { recursive: true });
        symlinkSync(skillRoot, join(fixture.root, ".agents/skills"), "dir");
      },
      // The folder and marker are inside, but SKILL.md links outside.
      (fixture: TestRepository) => {
        writeFixture(
          fixture.root,
          `${RENAMED}/changelog-provider.json`,
          markerFor()
        );
        writeFixture(
          fixture.base,
          "outside/SKILL.md",
          "---\nname: outside\ndescription: Test fixture.\n---\n"
        );
        symlinkSync(
          join(fixture.base, "outside/SKILL.md"),
          join(fixture.root, `${RENAMED}/SKILL.md`)
        );
      },
      // The folder links outside, though its SKILL.md and marker link back in.
      (fixture: TestRepository) => {
        writeProvider(fixture.root, "tools/inside-copy", markerFor());
        writeFixture(fixture.base, "outside/scripts/setup.ts", "export {};\n");
        for (const file of ["SKILL.md", "changelog-provider.json"]) {
          symlinkSync(
            join(fixture.root, `tools/inside-copy/${file}`),
            join(fixture.base, `outside/${file}`)
          );
        }
        mkdirSync(join(fixture.root, ".agents/skills"), { recursive: true });
        symlinkSync(
          join(fixture.base, "outside"),
          join(fixture.root, RENAMED),
          "dir"
        );
      },
      // The folder is inside, but its marker links outside.
      (fixture: TestRepository) => {
        writeProvider(fixture.root, RENAMED, null);
        writeFixture(
          fixture.base,
          "outside/changelog-provider.json",
          markerFor()
        );
        symlinkSync(
          join(fixture.base, "outside/changelog-provider.json"),
          join(fixture.root, `${RENAMED}/changelog-provider.json`)
        );
      },
    ];
    for (const link of outsideLinks) {
      const fixture = createTestRepository();
      repositories.push(fixture);
      const skillRoot = withNewerGlobal(fixture);
      link(fixture, skillRoot);

      globalWins(fixture, skillRoot);
    }
  });

  test("does not let a discovery-only renamed provider shadow a handoff-capable one", () => {
    const fixture = createTestRepository();
    repositories.push(fixture);
    const skillRoot = withNewerGlobal(fixture);
    writeProvider(
      fixture.root,
      RENAMED,
      markerFor({ receiptVersions: [], requestVersions: [] })
    );

    const result = inspectWith(fixture, skillRoot);
    expect(result.providers).toEqual([
      join(skillRoot, "simple-changelogs/SKILL.md"),
      join(fixture.root, `${RENAMED}/SKILL.md`),
    ]);
    expect(result).toMatchObject({
      capabilityAvailable: true,
      guidanceUpdate: {
        provider: join(skillRoot, "simple-changelogs/SKILL.md"),
        status: "update-available",
      },
    });
  });
});
