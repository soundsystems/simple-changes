import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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
});
