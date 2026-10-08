#!/usr/bin/env bun

// Generate the installed skill's release notes at release time:
// skills/simple-changes/CHANGELOG.md is a verbatim prefix of the root
// CHANGELOG.md covering the releases of the newest release's guidance version
// and the five before it, and scripts/lib/release-history.json records every
// release's version, date, and guidance version so `release-notes --version`
// can point at the canonical changelog for an older one.
//
//   bun tooling/simple-changes/package-changelog.ts          # write both files
//   bun tooling/simple-changes/package-changelog.ts --check  # exit 1 on drift
//
// A release new to the history (a root heading the history does not list yet)
// takes the current CURRENT_GUIDANCE_VERSION, so run this during release prep,
// after the release heading is in the root CHANGELOG.md and before the
// guidance version moves again.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_GUIDANCE_VERSION } from "../../skills/simple-changes/scripts/lib/guidance-updates.ts";
import {
  packagedChangelog,
  parseReleaseHistory,
  type ReleaseRecord,
  releaseHistoryIssues,
  renderReleaseHistory,
} from "../../skills/simple-changes/scripts/lib/release-history.ts";
import { releaseSections } from "../../skills/simple-changes/scripts/lib/release-notes.ts";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const rootChangelogPath = resolve(repositoryRoot, "CHANGELOG.md");
const packagedChangelogPath = resolve(
  repositoryRoot,
  "skills/simple-changes/CHANGELOG.md"
);
const historyPath = resolve(
  repositoryRoot,
  "skills/simple-changes/scripts/lib/release-history.json"
);

const fail = (message: string): never => {
  process.stderr.write(`package-changelog: ${message}\n`);
  process.exit(1);
};

const changelog = readFileSync(rootChangelogPath, "utf8");
const recorded = existsSync(historyPath)
  ? parseReleaseHistory(readFileSync(historyPath, "utf8"), historyPath)
  : [];

// Carry every recorded release; only releases newer than all of them are new.
const headings = releaseSections(changelog);
const known = new Map(recorded.map((record) => [record.version, record]));
const headed = new Set(headings.map((heading) => heading.version));
for (const record of recorded) {
  if (!headed.has(record.version)) {
    fail(`recorded release ${record.version} is no longer in CHANGELOG.md`);
  }
}
const newReleases = headings.length - recorded.length;
const history: ReleaseRecord[] = [];
for (const [index, heading] of headings.entries()) {
  if (!heading.date) {
    fail(`release ${heading.version} has no date in CHANGELOG.md`);
  }
  const date = heading.date ?? "";
  const existing = known.get(heading.version);
  if (existing) {
    if (existing.date !== date) {
      fail(
        `release ${heading.version} is dated ${date} in CHANGELOG.md but ${existing.date} in the release history`
      );
    }
    history.push(existing);
  } else if (index < newReleases) {
    history.push({
      date,
      guidance: CURRENT_GUIDANCE_VERSION,
      version: heading.version,
    });
  } else {
    fail(
      `release ${heading.version} is missing from the release history but is older than a recorded release`
    );
  }
}
const issues = releaseHistoryIssues(changelog, history);
if (issues.length > 0 || history.length !== headings.length) {
  fail(issues.join("; ") || "the release history does not match CHANGELOG.md");
}

const expected = new Map([
  [historyPath, renderReleaseHistory(history)],
  [packagedChangelogPath, packagedChangelog(changelog, history)],
]);

if (process.argv.includes("--check")) {
  const stale = [...expected].filter(
    ([path, content]) =>
      !existsSync(path) || readFileSync(path, "utf8") !== content
  );
  if (stale.length > 0) {
    fail(
      `${stale.map(([path]) => path.slice(repositoryRoot.length + 1)).join(" and ")} must be regenerated: bun tooling/simple-changes/package-changelog.ts`
    );
  }
  process.stdout.write("Packaged changelog window is current.\n");
} else {
  for (const [path, content] of expected) {
    writeFileSync(path, content);
  }
  const packaged = releaseSections(expected.get(packagedChangelogPath) ?? "");
  process.stdout.write(
    `Packaged ${packaged.length} of ${history.length} releases (${packaged.at(-1)?.version} through ${packaged[0]?.version}).\n`
  );
}
