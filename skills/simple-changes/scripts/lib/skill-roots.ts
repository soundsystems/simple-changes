import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { isValidSkillName } from "./skill-check.ts";

/** User-level skill roots a global installation lives under. */
export const GLOBAL_SKILL_ROOTS = [
  ".agents/skills",
  ".codex/skills",
  ".claude/skills",
  ".cursor/skills",
] as const;

/**
 * Conventional project folders under the home directory. Together with
 * `GLOBAL_SKILL_ROOTS` these are the roots `update-local-forks discover`
 * scans, and `simple-changes status --all` scans the same ones.
 */
export const PROJECT_ROOTS = ["Developer", "Projects", "Code", "src"] as const;

export interface SkillRootOptions {
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
}

const RUNTIME_PATH = ["simple-changes", "scripts", "simple-changes.ts"];
const FORK_PROVENANCE_PATTERN =
  /Forked from `simple-changes` @ `[0-9a-f]{7,40}`/u;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/u;
const NAME_LINE_PATTERN = /^name:(.*)$/mu;
const DOUBLE_QUOTED_PATTERN = /^"([^"\\]*)"(?:[ \t]+#.*)?$/u;
const SINGLE_QUOTED_PATTERN = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/u;
const PLAIN_COMMENT_PATTERN = /(?:^|[ \t])#.*$/u;

/**
 * The user-level skill roots to search, in order. SIMPLE_CHANGES_SKILL_ROOTS,
 * when set, replaces them with its own path list; set and empty means none.
 */
export const globalSkillRoots = (options: SkillRootOptions = {}): string[] => {
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

/**
 * The skill directory that ships `script`: `<root>/scripts/<file>` in place,
 * or `<root>/runtime/scripts/<file>` in a fork that keeps the upstream runtime
 * under `runtime/`. Null when neither directory holds a SKILL.md.
 */
export const skillRootOf = (script: string): string | null => {
  const scripts = dirname(resolve(script));
  for (const candidate of [dirname(scripts), dirname(dirname(scripts))]) {
    if (existsSync(resolve(candidate, "SKILL.md"))) {
      return candidate;
    }
  }
  return null;
};

/** The SKILL.md of the skill that ships `script`, or null when unreadable. */
const skillDocumentOf = (script: string): string | null => {
  const root = skillRootOf(script);
  if (!root) {
    return null;
  }
  try {
    return readFileSync(resolve(root, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
};

/**
 * The complete `name:` scalar of a SKILL.md frontmatter, quoted or plain,
 * trimmed and without a trailing comment; undefined when absent or when a
 * quoted value does not close.
 */
const declaredSkillName = (skill: string): string | undefined => {
  const value = NAME_LINE_PATTERN.exec(
    FRONTMATTER_PATTERN.exec(skill)?.[1] ?? ""
  )?.[1]?.trim();
  if (value === undefined) {
    return;
  }
  if (value.startsWith('"')) {
    return DOUBLE_QUOTED_PATTERN.exec(value)?.[1];
  }
  if (value.startsWith("'")) {
    return SINGLE_QUOTED_PATTERN.exec(value)?.[1]?.replaceAll("''", "'");
  }
  return value.replace(PLAIN_COMMENT_PATTERN, "").trim() || undefined;
};

/**
 * Whether `script` ships inside a repository fork of Simple Changes rather
 * than Simple Changes itself: its skill carries the fork provenance line or
 * names a skill other than simple-changes.
 */
export const isForkRuntime = (script: string): boolean => {
  const skill = skillDocumentOf(script);
  if (skill === null) {
    return false;
  }
  const name = declaredSkillName(skill);
  return (
    FORK_PROVENANCE_PATTERN.test(skill) ||
    (name !== undefined && name !== "simple-changes")
  );
};

/**
 * The skill name `script` runs as: the `name:` its SKILL.md declares, in the
 * plain `<skill>/scripts` layout or a fork's `<skill>/runtime/scripts`, and
 * `simple-changes` when that name is missing or not a plain skill name.
 */
export const runningSkillName = (script: string): string => {
  const skill = skillDocumentOf(script);
  const name = skill === null ? undefined : declaredSkillName(skill);
  return name && isValidSkillName(name) ? name : "simple-changes";
};

/**
 * Every globally installed Simple Changes runtime script as a real path, in
 * root order, each installation once even when several roots link to it.
 */
export const globalRuntimeScripts = (
  options: SkillRootOptions = {}
): string[] => [
  ...new Set(
    globalSkillRoots(options)
      .map((root) => resolve(root, ...RUNTIME_PATH))
      .filter((candidate) => existsSync(candidate))
      .map((candidate) => realpathSync(candidate))
  ),
];
