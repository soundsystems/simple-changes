import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import type { ChangelogCoordination } from "./types.ts";

const RELEASE_SURFACES = [
  ".simple-changelogs.json",
  "CHANGELOG.md",
  "DEVELOPER_CHANGELOG.md",
] as const;

const REPOSITORY_SKILL_PATHS = [
  "skills/simple-changelogs/SKILL.md",
  ".agents/skills/simple-changelogs/SKILL.md",
  ".codex/skills/simple-changelogs/SKILL.md",
  ".claude/skills/simple-changelogs/SKILL.md",
  ".cursor/skills/simple-changelogs/SKILL.md",
] as const;

const GLOBAL_SKILL_ROOTS = [
  ".agents/skills",
  ".codex/skills",
  ".claude/skills",
  ".cursor/skills",
] as const;
const CURRENT_GUIDANCE_VERSION_PATTERN =
  /^Current guidance version:\s*(\d+)\s*$/imu;

interface ChangelogDiscoveryOptions {
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
}

const SIMPLE_CHANGELOGS_HEADLINE =
  "**Simple Changelogs has recently been updated.**" as const;
const SIMPLE_CHANGELOGS_QUESTION =
  "Would you like me to walk you through the recent Simple Changelogs updates before I continue?" as const;

const positiveInteger = (value: unknown): number | null =>
  Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;

const installedGuidanceVersion = (provider: string | null): number | null => {
  if (!provider) {
    return null;
  }
  try {
    const source = readFileSync(provider, "utf8");
    const match = CURRENT_GUIDANCE_VERSION_PATTERN.exec(source);
    return match?.[1] ? positiveInteger(Number(match[1])) : null;
  } catch {
    return null;
  }
};

const guidanceSummaryBullets = (
  detailsPath: string | null,
  storedVersion: number | null,
  installedVersion: number | null
): string[] => {
  if (
    !detailsPath ||
    storedVersion === null ||
    installedVersion === null ||
    installedVersion <= storedVersion
  ) {
    return [];
  }
  try {
    const source = readFileSync(detailsPath, "utf8");
    const sections = [
      ...source.matchAll(
        /^## Guidance\s+(\d+)\s*$([\s\S]*?)(?=^## Guidance\s+\d+\s*$|(?![\s\S]))/gimu
      ),
    ];
    const relevant = sections
      .filter((section) => {
        const version = Number(section[1]);
        return version > storedVersion && version <= installedVersion;
      })
      .map((section) => section[2]?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n")
      .replace(/\s+/gu, " ");
    return (relevant.match(/[^.!?]+[.!?]+/gu) ?? [])
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    return [];
  }
};

const storedGuidanceVersion = (
  repositoryRoot: string | null
): { path: string | null; version: number | null } => {
  if (!repositoryRoot) {
    return { path: null, version: null };
  }
  const path = resolve(repositoryRoot, ".simple-changelogs.json");
  if (!existsSync(path)) {
    return { path: null, version: null };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      guidance?: { version?: unknown };
    };
    return { path, version: positiveInteger(value.guidance?.version) };
  } catch {
    return { path, version: null };
  }
};

const configuredSkillRoots = (options: ChangelogDiscoveryOptions): string[] => {
  const environment = options.environment ?? process.env;
  if (environment.SIMPLE_CHANGES_SKILL_ROOTS !== undefined) {
    return environment.SIMPLE_CHANGES_SKILL_ROOTS.split(delimiter)
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => resolve(path));
  }
  const homeDirectory = options.homeDirectory ?? homedir();
  return GLOBAL_SKILL_ROOTS.map((path) => resolve(homeDirectory, path));
};

export const inspectChangelogCoordination = (
  repositoryRoot: string | null,
  options: ChangelogDiscoveryOptions = {}
): ChangelogCoordination => {
  const releaseSurfaces = repositoryRoot
    ? RELEASE_SURFACES.filter((path) =>
        existsSync(resolve(repositoryRoot, path))
      )
    : [];
  const repositoryProviders = repositoryRoot
    ? REPOSITORY_SKILL_PATHS.map((path) =>
        resolve(repositoryRoot, path)
      ).filter(existsSync)
    : [];
  const globalProviders = configuredSkillRoots(options)
    .map((root) => resolve(root, "simple-changelogs", "SKILL.md"))
    .filter(existsSync);
  const providers = [...new Set([...repositoryProviders, ...globalProviders])];
  const provider = providers[0] ?? null;
  const capabilityHelpers = providers
    .map((candidate) => resolve(candidate, "..", "scripts", "setup.ts"))
    .filter(existsSync);
  const installedVersion = installedGuidanceVersion(provider);
  const stored = storedGuidanceVersion(repositoryRoot);
  const detailsCandidate = provider
    ? resolve(provider, "..", "references", "guidance-updates.md")
    : null;
  const detailsPath =
    detailsCandidate && existsSync(detailsCandidate) ? detailsCandidate : null;
  let guidanceStatus: ChangelogCoordination["guidanceUpdate"]["status"] =
    "absent";
  if (provider && stored.path === null) {
    guidanceStatus = "unconfigured";
  } else if (
    provider &&
    (installedVersion === null || stored.version === null)
  ) {
    guidanceStatus = "unknown";
  } else if (
    installedVersion !== null &&
    stored.version !== null &&
    installedVersion > stored.version
  ) {
    guidanceStatus = "update-available";
  } else if (provider) {
    guidanceStatus = "current";
  }
  const summaryBullets =
    guidanceStatus === "update-available"
      ? guidanceSummaryBullets(detailsPath, stored.version, installedVersion)
      : [];
  return {
    capabilityAvailable: providers.length > 0,
    capabilityHelpers,
    capabilityStatus: providers.length > 0 ? "unverified" : "absent",
    guidanceUpdate: {
      actions:
        guidanceStatus === "update-available"
          ? ["walkthrough", "continue", "view-release-notes"]
          : [],
      detailsPath,
      headline: SIMPLE_CHANGELOGS_HEADLINE,
      installedVersion,
      owner: provider ? "simple-changelogs" : null,
      policyPath: stored.path,
      provider,
      status: guidanceStatus,
      storedVersion: stored.version,
      summaryBullets,
      walkthroughQuestion: SIMPLE_CHANGELOGS_QUESTION,
    },
    providers,
    releaseSurfaces: [...releaseSurfaces],
    relevant: releaseSurfaces.length > 0 || providers.length > 0,
  };
};
