import { basename } from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";

const RELEASE_HEADING_PATTERN =
  /^##[ \t]+(?:\[(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]|(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?))(?:[ \t]+-[ \t]+(\d{4}-\d{2}-\d{2}))?[ \t]*$/gmu;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;

export interface ReleaseNotes {
  date: string | null;
  markdown: string;
  schemaVersion: 1;
  source: string;
  version: string;
}

interface ReleaseSection {
  bodyStart: number;
  date: string | null;
  headingStart: number;
  version: string;
}

const releaseSections = (changelog: string): ReleaseSection[] => {
  const sections: ReleaseSection[] = [];
  for (const match of changelog.matchAll(RELEASE_HEADING_PATTERN)) {
    const version = match[1] ?? match[2];
    if (!(version && version.toLowerCase() !== "unreleased")) {
      continue;
    }
    sections.push({
      bodyStart: (match.index ?? 0) + match[0].length,
      date: match[3] ?? null,
      headingStart: match.index ?? 0,
      version,
    });
  }
  return sections;
};

const publicBody = (body: string): string =>
  body
    .replace(HTML_COMMENT_PATTERN, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

export const extractReleaseNotes = (
  changelog: string,
  source: string,
  requestedVersion?: string
): ReleaseNotes => {
  const sections = releaseSections(changelog);
  if (sections.length === 0) {
    throw new SimpleChangesError(
      `${basename(source)} contains no released sections`,
      EXIT_CODES.validation
    );
  }
  const selected = requestedVersion
    ? sections.find((section) => section.version === requestedVersion)
    : sections[0];
  if (!selected) {
    throw new SimpleChangesError(
      `${basename(source)} has no release ${requestedVersion}`,
      EXIT_CODES.validation
    );
  }
  const selectedIndex = sections.indexOf(selected);
  const next = sections[selectedIndex + 1];
  const body = publicBody(
    changelog.slice(selected.bodyStart, next?.headingStart ?? changelog.length)
  );
  if (!body) {
    throw new SimpleChangesError(
      `${basename(source)} release ${selected.version} has no public notes`,
      EXIT_CODES.validation
    );
  }
  const heading = selected.date
    ? `## ${selected.version} - ${selected.date}`
    : `## ${selected.version}`;
  return {
    date: selected.date,
    markdown: `${heading}\n\n${body}\n`,
    schemaVersion: 1,
    source,
    version: selected.version,
  };
};
