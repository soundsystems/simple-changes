import { afterEach, describe, expect, test } from "bun:test";
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

    const result = inspect(fixture);
    expect(result).toMatchObject({
      capabilityAvailable: true,
      relevant: true,
    });
    expect(result.providers[0]).toEndWith("/skills/simple-changelogs/SKILL.md");
  });
});
