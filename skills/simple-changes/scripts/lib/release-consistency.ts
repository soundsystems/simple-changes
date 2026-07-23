import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { extractReleaseNotes } from "./release-notes.ts";

const EMPTY_UNRELEASED_PATTERN =
  /^##[ \t]+Unreleased[ \t]*\n(?:[ \t]*\n|<!--[\s\S]*?-->[ \t]*\n)*(?=##[ \t]+|(?![\s\S]))/imu;

export interface ReleaseVersionRecord {
  date: string | null;
  path: string;
  role: "customer-history" | "developer-history" | "package";
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

const hasEmptyUnreleased = (markdown: string): boolean =>
  EMPTY_UNRELEASED_PATTERN.test(markdown);

const inspectHistory = (
  path: string,
  role: "customer-history" | "developer-history",
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
  if (hasEmptyUnreleased(markdown)) {
    issues.push(`${basename(path)} contains an empty Unreleased section.`);
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

  const publicVersion = versions.find(
    (record) => record.role === "customer-history"
  );
  for (const record of versions) {
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
