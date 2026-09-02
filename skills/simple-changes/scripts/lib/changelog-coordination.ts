import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, resolve } from "node:path";
import type { ChangelogCoordination } from "./types.ts";

const POLICY_FILENAME = ".simple-changelogs.json";
// The CMS-only distribution keeps its policy in a separate file that never
// names a distribution; its presence alone selects the CMS distribution.
const CMS_POLICY_FILENAME = ".simple-changelogs-cms.json";
const RELEASE_SURFACES = [
  POLICY_FILENAME,
  "CHANGELOG.md",
  "DEVELOPER_CHANGELOG.md",
  CMS_POLICY_FILENAME,
  "CMS_CHANGELOG.json",
] as const;

const DISTRIBUTION_BY_INSTALLATION: Record<string, string> = {
  "simple-changelogs": "full",
  "simple-changelogs-cms": "cms",
  "simple-changelogs-mobile": "mobile",
  "simple-changelogs-skill-maintainer": "skill-repository",
  "simple-changelogs-web": "web",
  "simple-changelogs-web-cms": "web-cms",
};
const INSTALLATION_NAMES = Object.keys(DISTRIBUTION_BY_INSTALLATION);
const REPOSITORY_SKILL_ROOTS = [
  "skills",
  ".agents/skills",
  ".codex/skills",
  ".claude/skills",
  ".cursor/skills",
] as const;

const GLOBAL_SKILL_ROOTS = [
  ".agents/skills",
  ".codex/skills",
  ".claude/skills",
  ".cursor/skills",
] as const;
const PROVIDER_MARKER_FILENAME = "changelog-provider.json";
const CURRENT_GUIDANCE_VERSION_PATTERN =
  /^Current guidance version:\s*(\d+)\s*$/imu;
const FULL_DISTRIBUTION_PATTERN =
  /full (?:cross-surface )?simple changelogs distribution/iu;
const NARROWER_DISTRIBUTION_PATTERN = /narrower .* distribution/iu;
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

interface ProviderMarker {
  // A marker that advertises an empty request or receipt version list
  // declares itself discovery-only: identifiable, but implementing no
  // classify/prepare/verify handoff. It stays discoverable so its repository
  // is never reported as invisible, while delegation to it is not applicable
  // rather than merely unverified.
  discoveryOnly: boolean;
  distribution: string | null;
  guidanceVersion: number | null;
}

const advertisesNoVersions = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 0;

const readProviderMarker = (provider: string): ProviderMarker | null => {
  const markerPath = resolve(provider, "..", PROVIDER_MARKER_FILENAME);
  if (!existsSync(markerPath)) {
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(markerPath, "utf8")) as {
      distribution?: unknown;
      guidanceVersion?: unknown;
      provider?: unknown;
      receiptVersions?: unknown;
      requestVersions?: unknown;
      schemaVersion?: unknown;
    };
    if (value.provider !== "simple-changelogs" || value.schemaVersion !== 1) {
      return null;
    }
    return {
      discoveryOnly:
        advertisesNoVersions(value.requestVersions) ||
        advertisesNoVersions(value.receiptVersions),
      distribution:
        typeof value.distribution === "string" && value.distribution.length > 0
          ? value.distribution
          : null,
      guidanceVersion: positiveInteger(value.guidanceVersion),
    };
  } catch {
    return null;
  }
};

const providerEvidenceFor = (
  provider: string | null
): ChangelogCoordination["providerEvidence"] => {
  if (!provider) {
    return "none";
  }
  return readProviderMarker(provider) ? "marker" : "inferred";
};

const installedGuidanceVersion = (provider: string | null): number | null => {
  if (!provider) {
    return null;
  }
  const marker = readProviderMarker(provider);
  if (marker?.guidanceVersion) {
    return marker.guidanceVersion;
  }
  try {
    const source = readFileSync(provider, "utf8");
    const match = CURRENT_GUIDANCE_VERSION_PATTERN.exec(source);
    return match?.[1] ? positiveInteger(Number(match[1])) : null;
  } catch {
    return null;
  }
};

const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);
const WHITESPACE_PATTERN = /\s/u;

const endsSentenceAt = (text: string, index: number): boolean => {
  const next = text[index + 1];
  if (next === undefined) {
    return true;
  }
  // Keep runs of terminators ("?!", "...") together and never split on a
  // terminator glued to the following token (`scripts/query.ts`, "v1.2").
  return !SENTENCE_TERMINATORS.has(next) && WHITESPACE_PATTERN.test(next);
};

// Splits prose into terminated sentences while treating inline code spans
// (`CHANGELOG.md`) as opaque so their punctuation never ends a sentence.
const splitSentences = (text: string): string[] => {
  const sentences: string[] = [];
  let current = "";
  let insideCode = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    current += character;
    if (character === "`") {
      insideCode = !insideCode;
      continue;
    }
    if (
      insideCode ||
      !SENTENCE_TERMINATORS.has(character) ||
      !endsSentenceAt(text, index)
    ) {
      continue;
    }
    sentences.push(current.trim());
    current = "";
  }
  return sentences.filter(Boolean);
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
    return splitSentences(relevant).slice(0, 3);
  } catch {
    return [];
  }
};

interface StoredPolicy {
  distribution: string | null;
  path: string | null;
  version: number | null;
}

const readStoredPolicy = (
  path: string,
  impliedDistribution: string | null
): StoredPolicy => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      distribution?: unknown;
      guidance?: { version?: unknown };
    };
    return {
      distribution:
        typeof value.distribution === "string"
          ? value.distribution
          : impliedDistribution,
      path,
      version: positiveInteger(value.guidance?.version),
    };
  } catch {
    return { distribution: impliedDistribution, path, version: null };
  }
};

// The standard policy wins when both files exist (web-cms records both); the
// CMS policy is consulted only when it is the sole policy present.
const storedGuidanceVersion = (repositoryRoot: string | null): StoredPolicy => {
  if (!repositoryRoot) {
    return { distribution: null, path: null, version: null };
  }
  const path = resolve(repositoryRoot, POLICY_FILENAME);
  if (existsSync(path)) {
    return readStoredPolicy(path, null);
  }
  const cmsPath = resolve(repositoryRoot, CMS_POLICY_FILENAME);
  if (existsSync(cmsPath)) {
    return readStoredPolicy(cmsPath, "cms");
  }
  return { distribution: null, path: null, version: null };
};

// Declared marker first, then the installation directory name; null when
// only SKILL.md prose could say which distribution this is.
const providerDistribution = (provider: string): string | null =>
  readProviderMarker(provider)?.distribution ??
  DISTRIBUTION_BY_INSTALLATION[basename(resolve(provider, ".."))] ??
  null;

// Only a marker can declare a provider discovery-only; an installation without
// a marker is assumed handoff-capable and its capability record decides.
const supportsReleaseHandoff = (provider: string): boolean =>
  readProviderMarker(provider)?.discoveryOnly !== true;

const capabilityStatusFor = (
  providers: string[],
  capabilityAvailable: boolean
): ChangelogCoordination["capabilityStatus"] => {
  if (capabilityAvailable) {
    return "unverified";
  }
  return providers.length > 0 ? "not-applicable" : "absent";
};

const supportsDistribution = (
  provider: string,
  distribution: string | null
): boolean => {
  if (!distribution) {
    return true;
  }
  const knownDistribution = providerDistribution(provider);
  if (knownDistribution) {
    return knownDistribution === distribution;
  }
  try {
    const source = readFileSync(provider, "utf8");
    if (distribution === "full") {
      return !NARROWER_DISTRIBUTION_PATTERN.test(source);
    }
    return (
      source.includes(`"distribution": "${distribution}"`) ||
      source.includes(`Current distribution: ${distribution}`) ||
      !FULL_DISTRIBUTION_PATTERN.test(source)
    );
  } catch {
    return false;
  }
};

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// Symlinked skill roots (for example ~/.codex/skills -> ~/.agents/skills)
// expose one installed provider under several paths. Keep the first path seen
// for each real location so the same installation is never counted twice.
const uniqueByRealPath = (candidates: string[]): string[] => {
  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    const key = canonicalPath(candidate);
    if (!seen.has(key)) {
      seen.set(key, candidate);
    }
  }
  return [...seen.values()];
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
    ? REPOSITORY_SKILL_ROOTS.flatMap((root) =>
        INSTALLATION_NAMES.map((name) =>
          resolve(repositoryRoot, root, name, "SKILL.md")
        )
      ).filter(existsSync)
    : [];
  const globalProviders = configuredSkillRoots(options)
    .flatMap((root) =>
      INSTALLATION_NAMES.map((name) => resolve(root, name, "SKILL.md"))
    )
    .filter(existsSync);
  const stored = storedGuidanceVersion(repositoryRoot);
  const providers = uniqueByRealPath([
    ...repositoryProviders,
    ...globalProviders,
  ])
    .filter((candidate) => supportsDistribution(candidate, stored.distribution))
    // Handoff-capable providers come first so a discovery-only installation
    // never shadows one that can actually take the release delegation.
    .sort(
      (left, right) =>
        Number(supportsReleaseHandoff(right)) -
        Number(supportsReleaseHandoff(left))
    );
  const provider = providers[0] ?? null;
  const capabilityAvailable = providers.some(supportsReleaseHandoff);
  const capabilityStatus = capabilityStatusFor(providers, capabilityAvailable);
  const capabilityHelpers = providers
    .map((candidate) => resolve(candidate, "..", "scripts", "setup.ts"))
    .filter(existsSync);
  const installedVersion = installedGuidanceVersion(provider);
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
    capabilityAvailable,
    capabilityHelpers,
    capabilityStatus,
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
    providerDistribution: provider ? providerDistribution(provider) : null,
    providerEvidence: providerEvidenceFor(provider),
    providers,
    releaseSurfaces: [...releaseSurfaces],
    relevant: releaseSurfaces.length > 0 || providers.length > 0,
  };
};
