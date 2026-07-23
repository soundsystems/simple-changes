import { describe, expect, test } from "bun:test";
import {
  extractReleaseNotes,
  type ReleaseNotes,
} from "../../../skills/simple-changes/scripts/lib/release-notes.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";

const changelog = `# Changelog

## Unreleased

- This is not public yet.

## 0.2.0 - 2026-07-23

<!-- private-release-metadata source="test" -->
- Added public CLI release notes.

## [0.1.0] - 2026-07-01

- Added the initial preview command.
`;

describe("release notes", () => {
  test("renders the latest released section without private comments", () => {
    const notes = extractReleaseNotes(changelog, "/repo/CHANGELOG.md");

    expect(notes.version).toBe("0.2.0");
    expect(notes.date).toBe("2026-07-23");
    expect(notes.markdown).toBe(
      "## 0.2.0 - 2026-07-23\n\n- Added public CLI release notes.\n"
    );
    expect(notes.markdown).not.toContain("private-release-metadata");
    expect(notes.markdown).not.toContain("not public yet");
    expect(validateSchema<ReleaseNotes>("release-notes", notes)).toEqual(notes);
  });

  test("selects a requested historical version", () => {
    const notes = extractReleaseNotes(changelog, "/repo/CHANGELOG.md", "0.1.0");

    expect(notes.version).toBe("0.1.0");
    expect(notes.markdown).toContain("initial preview command");
  });

  test("rejects an unknown version", () => {
    expect(() => {
      extractReleaseNotes(changelog, "/repo/CHANGELOG.md", "9.9.9");
    }).toThrow("CHANGELOG.md has no release 9.9.9");
  });
});
