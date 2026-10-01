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
