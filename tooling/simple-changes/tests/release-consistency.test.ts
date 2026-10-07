import { describe, expect, test } from "bun:test";
import {
  checkReleaseConsistency,
  renderReleaseConsistency,
} from "../../../skills/simple-changes/scripts/lib/release-consistency.ts";
import { createTestRepository, writeFixture } from "./helpers.ts";

describe("release consistency", () => {
  test("accepts aligned public, developer, and package versions", () => {
    const fixture = createTestRepository();
    try {
      writeFixture(
        fixture.root,
        "CHANGELOG.md",
        "# Changelog\n\n## 1.2.0 - 2026-07-23\n\n- Public outcome.\n"
      );
      writeFixture(
        fixture.root,
        "DEVELOPER_CHANGELOG.md",
        "# Developer changelog\n\n## 1.2.0 - 2026-07-23\n\n- Technical outcome.\n"
      );
      writeFixture(
        fixture.root,
        "package.json",
        '{ "name": "fixture", "version": "1.2.0" }\n'
      );

      const report = checkReleaseConsistency(fixture.root);

      expect(report.valid).toBe(true);
      expect(report.issues).toEqual([]);
      expect(renderReleaseConsistency(report)).toContain(
        "Release consistency: valid"
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("accepts a nonempty pending section", () => {
    const fixture = createTestRepository();
    try {
      writeFixture(
        fixture.root,
        "CHANGELOG.md",
        "# Changelog\n\n## Unreleased\n\n- Pending public outcome.\n\n## 0.2.0 - 2026-07-23\n\n- Public notes.\n"
      );
      writeFixture(
        fixture.root,
        "DEVELOPER_CHANGELOG.md",
        "# Developer changelog\n\n## Unreleased\n\n<!-- audit metadata -->\n\n- Pending technical outcome.\n\n## 0.2.0 - 2026-07-23\n\n- Developer notes.\n"
      );
      writeFixture(
        fixture.root,
        "package.json",
        '{ "name": "fixture", "version": "0.2.0" }\n'
      );

      expect(checkReleaseConsistency(fixture.root)).toMatchObject({
        issues: [],
        valid: true,
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("accepts one leading empty Unreleased anchor and rejects a duplicate", () => {
    const fixture = createTestRepository();
    try {
      writeFixture(
        fixture.root,
        "CHANGELOG.md",
        "# Changelog\n\n## Unreleased\n\n## 1.2.0 - 2026-07-23\n\n- Public outcome.\n"
      );
      writeFixture(
        fixture.root,
        "DEVELOPER_CHANGELOG.md",
        "# Developer changelog\n\n## Unreleased\n\n## 1.2.0 - 2026-07-23\n\n- Technical outcome.\n\n## Unreleased\n\n- Absorbed.\n"
      );
      writeFixture(
        fixture.root,
        "package.json",
        '{ "name": "fixture", "version": "1.2.0" }\n'
      );

      expect(checkReleaseConsistency(fixture.root).issues).toEqual([
        "DEVELOPER_CHANGELOG.md contains more than one Unreleased section.",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects version drift and empty pending sections", () => {
    const fixture = createTestRepository();
    try {
      writeFixture(
        fixture.root,
        "CHANGELOG.md",
        "# Changelog\n\n## 1.2.0 - 2026-07-23\n\n- Public outcome.\n\n## Unreleased\n\n## 1.1.0 - 2026-07-22\n\n- Earlier outcome.\n"
      );
      writeFixture(
        fixture.root,
        "DEVELOPER_CHANGELOG.md",
        "# Developer changelog\n\n## 1.1.0 - 2026-07-22\n\n- Technical outcome.\n"
      );
      writeFixture(
        fixture.root,
        "package.json",
        '{ "name": "fixture", "version": "1.1.0" }\n'
      );

      const report = checkReleaseConsistency(fixture.root);

      expect(report.valid).toBe(false);
      expect(report.issues).toContain(
        "CHANGELOG.md contains an empty Unreleased section."
      );
      expect(
        report.issues.some((issue) => issue.includes("does not match"))
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("reports missing or malformed release inputs without throwing", () => {
    const fixture = createTestRepository();
    try {
      writeFixture(fixture.root, "CHANGELOG.md", "# Changelog\n");
      writeFixture(fixture.root, "package.json", "{not-json}\n");

      const report = checkReleaseConsistency(fixture.root);

      expect(report.valid).toBe(false);
      expect(report.issues).toContain(
        "CHANGELOG.md contains no released sections"
      );
      expect(report.issues).toContain("DEVELOPER_CHANGELOG.md is missing.");
      expect(
        report.issues.some((issue) =>
          issue.startsWith("package.json is not valid JSON:")
        )
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("packaged skill version identity", () => {
  // A repository that packages the skill, every version at `version` except
  // the overrides.
  const packagedRepository = (
    overrides: {
      metadata?: string | null;
      packaged?: string;
      packageVersion?: string;
    } = {}
  ) => {
    const fixture = createTestRepository();
    const version = "0.27.0";
    const history = (title: string, release: string) =>
      `# ${title}\n\n## ${release} - 2026-10-07\n\n- Notes.\n`;
    writeFixture(fixture.root, "CHANGELOG.md", history("Changelog", version));
    writeFixture(
      fixture.root,
      "DEVELOPER_CHANGELOG.md",
      history("Developer changelog", version)
    );
    writeFixture(
      fixture.root,
      "package.json",
      `{ "name": "simple-changes", "version": "${overrides.packageVersion ?? version}" }\n`
    );
    writeFixture(
      fixture.root,
      "skills/simple-changes/CHANGELOG.md",
      history("Changelog", overrides.packaged ?? version)
    );
    const metadata =
      overrides.metadata === null
        ? ""
        : `  version: "${overrides.metadata ?? version}"\n`;
    writeFixture(
      fixture.root,
      "skills/simple-changes/SKILL.md",
      `---\nname: simple-changes\ndescription: Ships changes.\nmetadata:\n  models: Claude Opus 5.5\n${metadata}---\n\n# Simple Changes\n`
    );
    return fixture;
  };

  test("accepts metadata.version equal to the packaged changelog and package", () => {
    const fixture = packagedRepository();
    try {
      const report = checkReleaseConsistency(fixture.root);
      expect(report.issues).toEqual([]);
      expect(report.versions.map((record) => record.role)).toEqual([
        "customer-history",
        "developer-history",
        "package",
        "packaged-history",
        "skill-metadata",
      ]);
      expect(renderReleaseConsistency(report)).toContain(
        "skill-metadata: 0.27.0"
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses metadata.version that disagrees with the packaged changelog", () => {
    const fixture = packagedRepository({ metadata: "0.26.0" });
    try {
      const report = checkReleaseConsistency(fixture.root);
      expect(report.valid).toBe(false);
      expect(report.issues).toEqual([
        "skills/simple-changes/SKILL.md metadata.version 0.26.0 does not match the packaged CHANGELOG.md release 0.27.0.",
        "skills/simple-changes/SKILL.md metadata.version 0.26.0 does not match package.json version 0.27.0.",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses a packaged changelog or package that moved without metadata.version", () => {
    const packaged = packagedRepository({ packaged: "0.28.0" });
    const packageOnly = packagedRepository({ packageVersion: "0.28.0" });
    try {
      expect(checkReleaseConsistency(packaged.root).issues).toEqual([
        "skills/simple-changes/SKILL.md metadata.version 0.27.0 does not match the packaged CHANGELOG.md release 0.28.0.",
        "packaged-history version 0.28.0 does not match public release 0.27.0.",
      ]);
      expect(checkReleaseConsistency(packageOnly.root).issues).toEqual([
        "skills/simple-changes/SKILL.md metadata.version 0.27.0 does not match package.json version 0.28.0.",
        "package version 0.28.0 does not match public release 0.27.0.",
      ]);
    } finally {
      packaged.cleanup();
      packageOnly.cleanup();
    }
  });

  test("requires metadata.version once the skill is packaged", () => {
    const fixture = packagedRepository({ metadata: null });
    try {
      expect(checkReleaseConsistency(fixture.root)).toMatchObject({
        issues: [
          "skills/simple-changes/SKILL.md has no metadata.version string.",
        ],
        valid: false,
      });
    } finally {
      fixture.cleanup();
    }
  });
});
