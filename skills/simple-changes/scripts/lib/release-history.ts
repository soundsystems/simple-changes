import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { guidanceNotice } from "./guidance-updates.ts";
import { releaseSections } from "./release-notes.ts";

/** One published Simple Changes release and the guidance version it shipped. */
export interface ReleaseRecord {
  date: string;
  guidance: number;
  version: string;
}

/** Where `release-notes` points for a release older than the packaged notes. */
export interface ReleaseNotesPointer {
  anchor: string;
  date: string;
  guidance: number;
  /** The notice of each guidance version this release introduced. */
  guidanceNotice: Array<{ guidance: number; summaries: string[] }>;
  packaged: { newest: string; oldest: string };
  repository: string;
  schemaVersion: 1;
  status: "outside-packaged-window";
  url: string;
  version: string;
}

/**
 * The installed skill carries the release notes of the releases that shipped
 * the newest release's guidance version and the five before it. Older notes
 * stay in the canonical repository's CHANGELOG.md.
 */
export const PACKAGED_GUIDANCE_WINDOW = 6;

export const CANONICAL_REPOSITORY_URL =
  "https://gitlab.com/soundsystems/simple-changes";
export const CANONICAL_CHANGELOG_URL = `${CANONICAL_REPOSITORY_URL}/-/blob/main/CHANGELOG.md`;

/** The release history packaged beside this module. */
export const RELEASE_HISTORY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "release-history.json"
);

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const RELEASE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TRAILING_NEWLINES_PATTERN = /\n+$/u;
const SLUG_DROP_PATTERN = /[^\p{L}\p{N}\s_-]/gu;
const WHITESPACE_CHARACTER_PATTERN = /\s/gu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parse a release history: newest first, one record per release, each with
 * a plain `X.Y.Z` version, an ISO date, and a positive integer guidance
 * version that never rises from a newer release to an older one.
 */
export const parseReleaseHistory = (
  text: string,
  source: string
): ReleaseRecord[] => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw SimpleChangesError.withCause(
      `${basename(source)} is not valid JSON`,
      EXIT_CODES.validation,
      error
    );
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new SimpleChangesError(
      `${basename(source)} must be a nonempty array of releases`,
      EXIT_CODES.validation
    );
  }
  const records: ReleaseRecord[] = [];
  for (const entry of value) {
    const keys = isRecord(entry) ? Object.keys(entry).sort().join(",") : "";
    if (
      !isRecord(entry) ||
      keys !== "date,guidance,version" ||
      typeof entry.version !== "string" ||
      !RELEASE_VERSION_PATTERN.test(entry.version) ||
      typeof entry.date !== "string" ||
      !RELEASE_DATE_PATTERN.test(entry.date) ||
      !Number.isSafeInteger(entry.guidance) ||
      (entry.guidance as number) < 1
    ) {
      throw new SimpleChangesError(
        `${basename(source)} entry ${records.length + 1} must be exactly { date, guidance, version }`,
        EXIT_CODES.validation
      );
    }
    const previous = records.at(-1);
    if (previous && (entry.guidance as number) > previous.guidance) {
      throw new SimpleChangesError(
        `${basename(source)} gives ${entry.version} a newer guidance version than ${previous.version}`,
        EXIT_CODES.validation
      );
    }
    if (records.some((record) => record.version === entry.version)) {
      throw new SimpleChangesError(
        `${basename(source)} lists ${entry.version} twice`,
        EXIT_CODES.validation
      );
    }
    records.push({
      date: entry.date,
      guidance: entry.guidance as number,
      version: entry.version,
    });
  }
  return records;
};

/** The packaged release history, or null when it is missing or unreadable. */
export const readReleaseHistory = (
  path: string = RELEASE_HISTORY_PATH
): ReleaseRecord[] | null => {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return parseReleaseHistory(readFileSync(path, "utf8"), path);
  } catch {
    return null;
  }
};

/** Render a release history the way the repository stores it. */
export const renderReleaseHistory = (history: ReleaseRecord[]): string =>
  `[\n${history
    .map(
      (record) =>
        `  { "date": "${record.date}", "guidance": ${record.guidance}, "version": "${record.version}" }`
    )
    .join(",\n")}\n]\n`;

/**
 * Why a release history does not describe a changelog: it must list exactly
 * the changelog's released headings, versions and dates, in the same order.
 */
export const releaseHistoryIssues = (
  changelog: string,
  history: ReleaseRecord[]
): string[] => {
  const headings = releaseSections(changelog).map(
    (section) => `${section.version} ${section.date ?? "undated"}`
  );
  const recorded = history.map((record) => `${record.version} ${record.date}`);
  const issues: string[] = [];
  const length = Math.max(headings.length, recorded.length);
  for (let index = 0; index < length; index += 1) {
    if (headings[index] !== recorded[index]) {
      issues.push(
        `release ${index + 1} is ${headings[index] ?? "missing"} in the changelog but ${recorded[index] ?? "missing"} in the release history`
      );
      break;
    }
  }
  return issues;
};

/**
 * The releases the installed skill carries: those whose guidance version is
 * within the newest release's last PACKAGED_GUIDANCE_WINDOW guidance versions.
 */
export const packagedReleases = (history: ReleaseRecord[]): ReleaseRecord[] => {
  const newest = history[0]?.guidance ?? 0;
  return history.filter(
    (record) => record.guidance > newest - PACKAGED_GUIDANCE_WINDOW
  );
};

/**
 * The packaged CHANGELOG.md: the root changelog, byte for byte, up to the
 * first release heading outside the window, ending in one newline.
 */
export const packagedChangelog = (
  changelog: string,
  history: ReleaseRecord[]
): string => {
  const window = new Set(packagedReleases(history).map((r) => r.version));
  const outside = releaseSections(changelog).find(
    (section) => !window.has(section.version)
  );
  return outside
    ? changelog
        .slice(0, outside.headingStart)
        .replace(TRAILING_NEWLINES_PATTERN, "\n")
    : changelog;
};

/** The heading anchor GitHub and GitLab give `## <version> - <date>`. */
export const releaseAnchor = (record: ReleaseRecord): string =>
  `${record.version} - ${record.date}`
    .toLowerCase()
    .replace(SLUG_DROP_PATTERN, "")
    .replace(WHITESPACE_CHARACTER_PATTERN, "-");

/**
 * A pointer to the canonical changelog for a published release older than
 * every release the packaged notes carry, or null for any other version,
 * including one the history does not know or a release newer than the notes.
 */
export const releaseNotesPointer = (
  packagedNotes: string,
  version: string,
  history: ReleaseRecord[] | null = readReleaseHistory()
): ReleaseNotesPointer | null => {
  const sections = releaseSections(packagedNotes);
  const newest = sections[0]?.version;
  const oldest = sections.at(-1)?.version;
  const recordIndex =
    history?.findIndex((entry) => entry.version === version) ?? -1;
  const oldestIndex =
    history?.findIndex((entry) => entry.version === oldest) ?? -1;
  const record = history?.[recordIndex];
  if (
    !(record && newest && oldest) ||
    oldestIndex < 0 ||
    recordIndex <= oldestIndex ||
    sections.some((section) => section.version === version)
  ) {
    return null;
  }
  const anchor = releaseAnchor(record);
  // The guidance versions after the next older release's, up to this one's.
  const introducedAfter = history?.[recordIndex + 1]?.guidance ?? 0;
  const notices: ReleaseNotesPointer["guidanceNotice"] = [];
  for (
    let guidance = introducedAfter + 1;
    guidance <= record.guidance;
    guidance += 1
  ) {
    const summaries = guidanceNotice(guidance);
    if (summaries.length > 0) {
      notices.push({ guidance, summaries });
    }
  }
  return {
    anchor,
    date: record.date,
    guidance: record.guidance,
    guidanceNotice: notices,
    packaged: { newest, oldest },
    repository: CANONICAL_REPOSITORY_URL,
    schemaVersion: 1,
    status: "outside-packaged-window",
    url: `${CANONICAL_CHANGELOG_URL}#${anchor}`,
    version: record.version,
  };
};

export const renderReleaseNotesPointer = (
  pointer: ReleaseNotesPointer
): string => {
  const lines = [
    `Simple Changes ${pointer.version} (${pointer.date}) is older than the release notes this installation carries (${pointer.packaged.oldest} through ${pointer.packaged.newest}).`,
    `Read it in the full changelog: ${pointer.url}`,
  ];
  for (const notice of pointer.guidanceNotice) {
    lines.push(
      "",
      `Simple Changes guidance ${notice.guidance}, introduced in this release:`,
      ...notice.summaries.map((summary) => `- ${summary}`)
    );
  }
  return `${lines.join("\n")}\n`;
};
