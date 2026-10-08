import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { extractReleaseNotes } from "./release-notes.ts";
import { skillMetadataVersion } from "./skill-check.ts";

const EMPTY_UNRELEASED_PATTERN =
  /^##[ \t]+Unreleased[ \t]*\n(?:[ \t]*\n|<!--[\s\S]*?-->[ \t]*\n)*(?=##[ \t]+|(?![\s\S]))/imu;
const RELEASE_HEADING_PATTERN = /^##[ \t]+(.*?)[ \t]*$/gmu;
const UNRELEASED_HEADING_PATTERN = /^\[?unreleased\]?$/iu;

export interface ReleaseVersionRecord {
  date: string | null;
  path: string;
  role:
    | "customer-history"
    | "developer-history"
    | "package"
    | "packaged-history"
    | "skill-metadata";
  version: string;
}

export interface ReleaseConsistencyReport {
  issues: string[];
  schemaVersion: 1;
  valid: boolean;
  versions: ReleaseVersionRecord[];
}

const readJsonVersion = (path: string, issues: string[]): string | null => {
  if (!existsSync(path)) {
    issues.push(`${basename(path)} is missing.`);
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
    };
    if (typeof value.version === "string" && value.version.length > 0) {
      return value.version;
    }
    issues.push(`${basename(path)} has no string version.`);
  } catch (error) {
    issues.push(
      `${basename(path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return null;
};

// One empty `## Unreleased` heading, placed first, is the prepend anchor that
// Simple Changelogs keeps after every reconciled release. An empty heading
// anywhere else, or a second Unreleased heading, means a release absorbed it.
const unreleasedIssues = (markdown: string, name: string): string[] => {
  const headings = [...markdown.matchAll(RELEASE_HEADING_PATTERN)];
  const unreleased = headings.filter((heading) =>
    UNRELEASED_HEADING_PATTERN.test(heading[1] ?? "")
  );
  const issues: string[] = [];
  if (unreleased.length > 1) {
    issues.push(`${name} contains more than one Unreleased section.`);
  }
  const empty = EMPTY_UNRELEASED_PATTERN.exec(markdown);
  if (empty && empty.index !== headings[0]?.index) {
    issues.push(`${name} contains an empty Unreleased section.`);
  }
  return issues;
};

const inspectHistory = (
  path: string,
  role: "customer-history" | "developer-history" | "packaged-history",
  issues: string[],
  versions: ReleaseVersionRecord[]
): void => {
  if (!existsSync(path)) {
    issues.push(`${basename(path)} is missing.`);
    return;
  }
  const markdown = readFileSync(path, "utf8");
  try {
    const notes = extractReleaseNotes(markdown, path);
    versions.push({
      date: notes.date,
      path,
      role,
      version: notes.version,
    });
  } catch (error) {
    issues.push(
      error instanceof Error
        ? error.message
        : `${basename(path)} has invalid release history.`
    );
  }
  issues.push(...unreleasedIssues(markdown, basename(path)));
};

const PACKAGED_SKILL = "skills/simple-changes";

/**
 * A repository that packages the Simple Changes skill also states the release
 * in the packaged CHANGELOG.md and in SKILL.md `metadata.version`, which must
 * equal that changelog's top release and the package version.
 */
const inspectPackagedSkill = (
  repository: string,
  packageVersion: string | null,
  issues: string[],
  versions: ReleaseVersionRecord[]
): void => {
  const skillPath = resolve(repository, PACKAGED_SKILL, "SKILL.md");
  if (!existsSync(skillPath)) {
    return;
  }
  const packagedPath = resolve(repository, PACKAGED_SKILL, "CHANGELOG.md");
  const before = versions.length;
  inspectHistory(packagedPath, "packaged-history", issues, versions);
  const packaged = versions.length > before ? versions.at(-1) : undefined;
  let metadataVersion: string | null = null;
  try {
    metadataVersion = skillMetadataVersion(readFileSync(skillPath, "utf8"));
  } catch (error) {
    issues.push(
      `${PACKAGED_SKILL}/SKILL.md frontmatter could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  if (!metadataVersion) {
    issues.push(`${PACKAGED_SKILL}/SKILL.md has no metadata.version string.`);
    return;
  }
  versions.push({
    date: null,
    path: skillPath,
    role: "skill-metadata",
    version: metadataVersion,
  });
  if (packaged && packaged.version !== metadataVersion) {
    issues.push(
      `${PACKAGED_SKILL}/SKILL.md metadata.version ${metadataVersion} does not match the packaged CHANGELOG.md release ${packaged.version}.`
    );
  }
  if (packageVersion && packageVersion !== metadataVersion) {
    issues.push(
      `${PACKAGED_SKILL}/SKILL.md metadata.version ${metadataVersion} does not match package.json version ${packageVersion}.`
    );
  }
};

export const checkReleaseConsistency = (
  repository: string
): ReleaseConsistencyReport => {
  const issues: string[] = [];
  const versions: ReleaseVersionRecord[] = [];
  const changelogPath = resolve(repository, "CHANGELOG.md");
  const developerPath = resolve(repository, "DEVELOPER_CHANGELOG.md");
  const packagePath = resolve(repository, "package.json");

  inspectHistory(changelogPath, "customer-history", issues, versions);
  inspectHistory(developerPath, "developer-history", issues, versions);

  const packageVersion = readJsonVersion(packagePath, issues);
  if (packageVersion) {
    versions.push({
      date: null,
      path: packagePath,
      role: "package",
      version: packageVersion,
    });
  }

  inspectPackagedSkill(repository, packageVersion, issues, versions);

  const publicVersion = versions.find(
    (record) => record.role === "customer-history"
  );
  for (const record of versions) {
    // SKILL.md metadata is compared with the packaged changelog and the
    // package above, so one disagreement is reported once.
    if (record.role === "skill-metadata") {
      continue;
    }
    if (publicVersion && record.version !== publicVersion.version) {
      issues.push(
        `${record.role} version ${record.version} does not match public release ${publicVersion.version}.`
      );
    }
    if (
      publicVersion?.date &&
      record.role === "developer-history" &&
      record.date !== publicVersion.date
    ) {
      issues.push(
        `developer-history date ${record.date ?? "missing"} does not match public release ${publicVersion.date}.`
      );
    }
  }

  return {
    issues,
    schemaVersion: 1,
    valid: issues.length === 0,
    versions,
  };
};

export const renderReleaseConsistency = (
  report: ReleaseConsistencyReport
): string => {
  const lines = [
    `Release consistency: ${report.valid ? "valid" : "invalid"}`,
    ...report.versions.map(
      (record) =>
        `${record.role}: ${record.version}${record.date ? ` (${record.date})` : ""}`
    ),
  ];
  for (const issue of report.issues) {
    lines.push(`Issue: ${issue}`);
  }
  return `${lines.join("\n")}\n`;
};
