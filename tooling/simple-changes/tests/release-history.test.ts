import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CURRENT_GUIDANCE_VERSION } from "../../../skills/simple-changes/scripts/lib/guidance-updates.ts";
import {
  CANONICAL_CHANGELOG_URL,
  PACKAGED_GUIDANCE_WINDOW,
  packagedChangelog,
  packagedReleases,
  parseReleaseHistory,
  type ReleaseNotesPointer,
  type ReleaseRecord,
  readReleaseHistory,
  releaseAnchor,
  releaseHistoryIssues,
  releaseNotesPointer,
  renderReleaseHistory,
  renderReleaseNotesPointer,
} from "../../../skills/simple-changes/scripts/lib/release-history.ts";
import { releaseSections } from "../../../skills/simple-changes/scripts/lib/release-notes.ts";
import { validateSchema } from "../../../skills/simple-changes/scripts/lib/schema.ts";
import { skillMetadataVersion } from "../../../skills/simple-changes/scripts/lib/skill-check.ts";

const repositoryFile = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

// Nine releases across guidance 1 to 9; with a six-version window the
// newest release's guidance 9 keeps guidance 4 through 9.
const history: ReleaseRecord[] = [
  { date: "2026-09-09", guidance: 9, version: "0.9.0" },
  { date: "2026-09-08", guidance: 8, version: "0.8.1" },
  { date: "2026-09-07", guidance: 8, version: "0.8.0" },
  { date: "2026-09-06", guidance: 6, version: "0.6.0" },
  { date: "2026-09-04", guidance: 4, version: "0.4.0" },
  { date: "2026-09-03", guidance: 3, version: "0.3.0" },
  { date: "2026-09-02", guidance: 2, version: "0.2.0" },
  { date: "2026-09-01", guidance: 1, version: "0.1.1" },
  { date: "2026-08-31", guidance: 1, version: "0.1.0" },
];
const changelogOf = (records: ReleaseRecord[]): string =>
  `# Changelog\n\n${records
    .map(
      (record) =>
        `## ${record.version} - ${record.date}\n\n- Notes for ${record.version}.\n<!-- signature -->\n`
    )
    .join("\n")}`;
const changelog = changelogOf(history);

describe("packaged release-note window", () => {
  test("keeps the newest release's guidance version and the five before it", () => {
    expect(PACKAGED_GUIDANCE_WINDOW).toBe(6);
    expect(packagedReleases(history).map((record) => record.version)).toEqual([
      "0.9.0",
      "0.8.1",
      "0.8.0",
      "0.6.0",
      "0.4.0",
    ]);
  });

  test("cuts the root changelog verbatim before the first older release", () => {
    const packaged = packagedChangelog(changelog, history);
    expect(changelog.startsWith(packaged)).toBe(true);
    expect(packaged.endsWith("- Notes for 0.4.0.\n<!-- signature -->\n")).toBe(
      true
    );
    expect(packaged).not.toContain("## 0.3.0");
    expect(releaseSections(packaged).map((section) => section.version)).toEqual(
      ["0.9.0", "0.8.1", "0.8.0", "0.6.0", "0.4.0"]
    );
    // A history entirely inside the window packages everything.
    const recent = history.slice(3, 6);
    expect(packagedChangelog(changelogOf(recent), recent)).toBe(
      changelogOf(recent)
    );
  });

  test("names every root release, in order, with its date", () => {
    expect(releaseHistoryIssues(changelog, history)).toEqual([]);
    expect(releaseHistoryIssues(changelog, history.slice(1))).toEqual([
      "release 1 is 0.9.0 2026-09-09 in the changelog but 0.8.1 2026-09-08 in the release history",
    ]);
    const redated = history.map((record) =>
      record.version === "0.6.0" ? { ...record, date: "2026-09-05" } : record
    );
    expect(releaseHistoryIssues(changelog, redated)).toEqual([
      "release 4 is 0.6.0 2026-09-06 in the changelog but 0.6.0 2026-09-05 in the release history",
    ]);
  });

  test("parses only well-formed, newest-first histories", () => {
    const text = renderReleaseHistory(history);
    expect(parseReleaseHistory(text, "release-history.json")).toEqual(history);
    for (const [bad, message] of [
      ["[]", "must be a nonempty array"],
      [
        '[{ "date": "2026-09-09", "guidance": 0, "version": "0.9.0" }]',
        "entry 1",
      ],
      [
        '[{ "date": "2026-09-09", "guidance": 1, "version": "v0.9.0" }]',
        "entry 1",
      ],
      [
        '[{ "date": "2026-09-09", "guidance": 1, "version": "0.9.0", "x": 1 }]',
        "entry 1",
      ],
      [
        '[{ "date": "2026-09-08", "guidance": 1, "version": "0.8.0" }, { "date": "2026-09-07", "guidance": 2, "version": "0.7.0" }]',
        "newer guidance version",
      ],
      [
        '[{ "date": "2026-09-08", "guidance": 1, "version": "0.8.0" }, { "date": "2026-09-07", "guidance": 1, "version": "0.8.0" }]',
        "twice",
      ],
    ] as const) {
      expect(() => parseReleaseHistory(bad, "release-history.json")).toThrow(
        message
      );
    }
  });

  test("anchors a release the way GitHub and GitLab slug its heading", () => {
    expect(
      releaseAnchor({ date: "2026-10-01", guidance: 22, version: "0.20.0" })
    ).toBe("0200---2026-10-01");
  });
});

describe("release notes pointer", () => {
  const packaged = packagedChangelog(changelog, history);

  test("points at the canonical changelog for a release older than the window", () => {
    const pointer = releaseNotesPointer(packaged, "0.2.0", history);
    expect(pointer).toEqual({
      anchor: "020---2026-09-02",
      date: "2026-09-02",
      guidance: 2,
      guidanceNotice: [
        {
          guidance: 2,
          summaries: expect.arrayContaining([
            expect.stringContaining("behavior updates now appear once"),
          ]),
        },
      ],
      packaged: { newest: "0.9.0", oldest: "0.4.0" },
      repository: "https://gitlab.com/soundsystems/simple-changes",
      schemaVersion: 1,
      status: "outside-packaged-window",
      url: `${CANONICAL_CHANGELOG_URL}#020---2026-09-02`,
      version: "0.2.0",
    });
    expect(
      validateSchema<ReleaseNotesPointer>(
        "release-notes-pointer",
        pointer as ReleaseNotesPointer
      )
    ).toEqual(pointer as ReleaseNotesPointer);
    const text = renderReleaseNotesPointer(pointer as ReleaseNotesPointer);
    expect(text).toContain(
      "Simple Changes 0.2.0 (2026-09-02) is older than the release notes this installation carries (0.4.0 through 0.9.0)."
    );
    expect(text).toContain(`${CANONICAL_CHANGELOG_URL}#020---2026-09-02`);
    expect(text).toContain(
      "Simple Changes guidance 2, introduced in this release:"
    );
  });

  test("lists the notice of every guidance version the release introduced", () => {
    const jump: ReleaseRecord[] = [
      { date: "2026-08-02", guidance: 9, version: "0.9.0" },
      { date: "2026-08-01", guidance: 6, version: "0.6.0" },
      { date: "2026-07-31", guidance: 4, version: "0.4.0" },
      { date: "2026-07-30", guidance: 2, version: "0.2.0" },
    ];
    const notes = "# Changelog\n\n## 0.9.0 - 2026-08-02\n\n- New.\n";
    expect(
      releaseNotesPointer(notes, "0.6.0", jump)?.guidanceNotice.map(
        (notice) => notice.guidance
      )
    ).toEqual([5, 6]);
    // A release that introduced no guidance version carries no notice.
    const patch: ReleaseRecord[] = [
      { date: "2026-08-02", guidance: 9, version: "0.9.0" },
      { date: "2026-08-01", guidance: 4, version: "0.4.1" },
      { date: "2026-07-31", guidance: 4, version: "0.4.0" },
    ];
    expect(releaseNotesPointer(notes, "0.4.1", patch)?.guidanceNotice).toEqual(
      []
    );
  });

  test("returns null for packaged, unknown, newer, or unrecorded releases", () => {
    expect(releaseNotesPointer(packaged, "0.6.0", history)).toBeNull();
    expect(releaseNotesPointer(packaged, "0.5.0", history)).toBeNull();
    expect(releaseNotesPointer(packaged, "v0.2.0", history)).toBeNull();
    expect(releaseNotesPointer(packaged, "0.2.0", null)).toBeNull();
    // A packaged changelog older than the history, as in a fork that kept
    // the notes it was created with, never calls a newer release older.
    const older = changelogOf(history.slice(4, 7));
    expect(releaseNotesPointer(older, "0.9.0", history)).toBeNull();
    expect(releaseNotesPointer(older, "0.1.0", history)?.version).toBe("0.1.0");
  });
});

describe("the packaged Simple Changes changelog", () => {
  const root = repositoryFile("CHANGELOG.md");
  const packaged = repositoryFile("skills/simple-changes/CHANGELOG.md");
  const recorded = readReleaseHistory();

  test("is the generated window of the root changelog", () => {
    expect(recorded).not.toBeNull();
    const releases = recorded ?? [];
    expect(releaseHistoryIssues(root, releases)).toEqual([]);
    expect(packaged).toBe(packagedChangelog(root, releases));
    expect(root.startsWith(packaged)).toBe(true);
    expect(releases[0]?.guidance ?? 0).toBeLessThanOrEqual(
      CURRENT_GUIDANCE_VERSION
    );
    const oldestPackaged = releaseSections(packaged).at(-1)?.version;
    const oldestRecord = releases.find(
      (record) => record.version === oldestPackaged
    );
    expect(oldestRecord?.guidance ?? 0).toBeGreaterThan(
      (releases[0]?.guidance ?? 0) - PACKAGED_GUIDANCE_WINDOW
    );
  });

  test("opens with the release SKILL.md metadata.version names", () => {
    expect(releaseSections(packaged)[0]?.version).toBe(
      skillMetadataVersion(repositoryFile("skills/simple-changes/SKILL.md")) ??
        "missing"
    );
  });
});
