import { existsSync } from "node:fs";
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

interface ChangelogDiscoveryOptions {
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
}

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
  return {
    capabilityAvailable: providers.length > 0,
    providers,
    releaseSurfaces: [...releaseSurfaces],
    relevant: releaseSurfaces.length > 0 || providers.length > 0,
  };
};
