import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { EXIT_CODES, SimpleChangesError } from "./errors.ts";
import { proseLines } from "./markdown.ts";

export type SkillCheckCode =
  | "skill-file-missing"
  | "frontmatter-missing"
  | "frontmatter-yaml"
  | "name-invalid"
  | "name-mismatch"
  | "description-invalid"
  | "openai-yaml"
  | "invocation-mismatch"
  | "link-broken"
  | "link-escapes";

export interface SkillCheckIssue {
  code: SkillCheckCode;
  message: string;
  /** The file the issue is in, relative to the skill directory. */
  path: string;
}

export interface SkillCheckOptions {
  /**
   * Also require every relative link to stay inside the skill directory, as
   * an installed copy of a packaged skill carries only that directory. A
   * repository fork may link to its repository's other files.
   */
  selfContained?: boolean;
}

export interface SkillCheckReport {
  issues: SkillCheckIssue[];
  linksChecked: number;
  name: string | null;
  schemaVersion: 1;
  skillDirectory: string;
  valid: boolean;
}

// Agent Skills specification limits for discoverable frontmatter.
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const SKILL_FILE = "SKILL.md";
const OPENAI_METADATA = "agents/openai.yaml";
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Lowercase letters, digits, and single hyphens, at most 64 characters. */
export const isValidSkillName = (name: string): boolean =>
  name.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_PATTERN.test(name);
const INLINE_LINK_PATTERN = /\]\(\s*(<[^>\n]+>|[^\s)]+)[^)\n]*\)/gu;
const REFERENCE_DEFINITION_PATTERN =
  /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]+>|\S+)/u;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;

interface YamlParser {
  parse: (source: string) => unknown;
}

// Read Bun.YAML from the global at call time, so a Bun without it fails this
// command with a clear message instead of failing every command at import.
const yamlParser = (): YamlParser => {
  const parser = (globalThis as { Bun?: { YAML?: YamlParser } }).Bun?.YAML;
  if (!parser) {
    throw new SimpleChangesError(
      "This Bun has no YAML parser (Bun.YAML); upgrade Bun to run the skill check.",
      EXIT_CODES.usage
    );
  }
  return parser;
};

type YamlResult = { ok: true; value: unknown } | { error: string; ok: false };

const parseYaml = (source: string): YamlResult => {
  const parser = yamlParser();
  try {
    return { ok: true, value: parser.parse(source) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const inside = (root: string, path: string): boolean => {
  const delta = relative(root, path);
  return (
    delta === "" ||
    !(delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta))
  );
};

const markdownFiles = (directory: string): string[] => {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return markdownFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    })
    .sort();
};

/** A relative file target, or null for anchors, URLs, and other schemes. */
const relativeTarget = (raw: string): string | null => {
  const unwrapped = raw.startsWith("<") ? raw.slice(1, -1) : raw;
  if (
    !unwrapped ||
    unwrapped.startsWith("#") ||
    unwrapped.startsWith("//") ||
    URI_SCHEME_PATTERN.test(unwrapped)
  ) {
    return null;
  }
  const [withoutFragment = ""] = unwrapped.split("#");
  const [path = ""] = withoutFragment.split("?");
  try {
    return decodeURIComponent(path) || null;
  } catch {
    return path || null;
  }
};

/** Link targets outside code, in document order. */
const linkTargets = (markdown: string): string[] =>
  proseLines(markdown).flatMap((line) => [
    ...[...line.matchAll(INLINE_LINK_PATTERN)].map((match) => match[1] ?? ""),
    ...(REFERENCE_DEFINITION_PATTERN.exec(line)?.slice(1, 2) ?? []),
  ]);

interface LinkCheck {
  checked: number;
  issues: SkillCheckIssue[];
}

const checkLinks = (
  root: string,
  files: readonly string[],
  selfContained: boolean
): LinkCheck => {
  const realRoot = realpathSync(root);
  const issues: SkillCheckIssue[] = [];
  let checked = 0;
  for (const file of files) {
    const path = relative(root, file);
    for (const raw of linkTargets(readFileSync(file, "utf8"))) {
      const target = relativeTarget(raw);
      if (target === null) {
        continue;
      }
      checked += 1;
      const resolved = resolve(dirname(file), target);
      const escapes =
        selfContained &&
        (!inside(root, resolved) ||
          (existsSync(resolved) && !inside(realRoot, realpathSync(resolved))));
      if (escapes) {
        issues.push({
          code: "link-escapes",
          message: `link ${raw} points outside the skill directory, which an installed copy does not carry`,
          path,
        });
      } else if (!existsSync(resolved)) {
        issues.push({
          code: "link-broken",
          message: `link ${raw} does not resolve to a file`,
          path,
        });
      }
    }
  }
  return { checked, issues };
};

interface Frontmatter {
  issues: SkillCheckIssue[];
  metadata: Record<string, unknown> | null;
}

const readFrontmatter = (skill: string): Frontmatter => {
  const source = FRONTMATTER_PATTERN.exec(skill)?.[1];
  if (source === undefined) {
    return {
      issues: [
        {
          code: "frontmatter-missing",
          message: "SKILL.md must open with a --- YAML frontmatter block",
          path: SKILL_FILE,
        },
      ],
      metadata: null,
    };
  }
  const parsed = parseYaml(source);
  if (!parsed.ok) {
    return {
      issues: [
        {
          code: "frontmatter-yaml",
          message: `frontmatter is not valid YAML (${parsed.error}); quote any value that contains ": "`,
          path: SKILL_FILE,
        },
      ],
      metadata: null,
    };
  }
  // A document that parses to null (an empty block) is checked as missing
  // fields rather than skipped.
  return { issues: [], metadata: asRecord(parsed.value) };
};

const LINE_BREAK_PATTERN = /\r?\n/u;
const METADATA_KEY_PATTERN = /^metadata:[ \t]*$/u;
const LEADING_SPACE_PATTERN = /^[ \t]*/u;
const METADATA_VERSION_PATTERN =
  /^version:[ \t]*(?:"([^"\\]*)"|'([^']*)'|([^\s"'#][^#]*?))[ \t]*(?:#.*)?$/u;

/**
 * The release a SKILL.md states in frontmatter `metadata.version`, or null.
 * Read without a YAML parser, so it works on every supported Bun: the
 * `metadata:` block mapping's direct `version:` entry, as a plain, single-,
 * or double-quoted scalar. Any other shape reads as no version.
 */
export const skillMetadataVersion = (skill: string): string | null => {
  const frontmatter = FRONTMATTER_PATTERN.exec(skill)?.[1];
  if (frontmatter === undefined) {
    return null;
  }
  const lines = frontmatter.split(LINE_BREAK_PATTERN);
  const start = lines.findIndex((line) => METADATA_KEY_PATTERN.test(line));
  let indent: string | null = null;
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (line.trim() === "") {
      continue;
    }
    const lead = LEADING_SPACE_PATTERN.exec(line)?.[0] ?? "";
    if (lead === "") {
      break;
    }
    indent ??= lead;
    const entry =
      lead === indent
        ? METADATA_VERSION_PATTERN.exec(line.slice(lead.length))
        : null;
    if (entry) {
      return entry[1] ?? entry[2] ?? entry[3] ?? null;
    }
  }
  return null;
};

const checkIdentity = (
  metadata: Record<string, unknown>,
  directoryName: string
): SkillCheckIssue[] => {
  const issues: SkillCheckIssue[] = [];
  const { description, name } = metadata;
  if (!(typeof name === "string" && isValidSkillName(name))) {
    issues.push({
      code: "name-invalid",
      message: `name must be lowercase letters, digits, and single hyphens, at most ${MAX_SKILL_NAME_LENGTH} characters`,
      path: SKILL_FILE,
    });
  } else if (name !== directoryName) {
    issues.push({
      code: "name-mismatch",
      message: `name ${name} must match its directory, ${directoryName}`,
      path: SKILL_FILE,
    });
  }
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    description.length > MAX_SKILL_DESCRIPTION_LENGTH
  ) {
    issues.push({
      code: "description-invalid",
      message: `description must be a non-empty string of at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters`,
      path: SKILL_FILE,
    });
  }
  return issues;
};

// A user-invoked skill must be user-invoked in every harness: Claude Code's
// disable-model-invocation and Codex's agents/openai.yaml policy move
// together. Without the Codex file, Codex allows implicit invocation.
const checkInvocationParity = (
  root: string,
  metadata: Record<string, unknown>
): SkillCheckIssue[] => {
  const openaiPath = resolve(root, OPENAI_METADATA);
  let codexUserInvoked = false;
  if (existsSync(openaiPath)) {
    const parsed = parseYaml(readFileSync(openaiPath, "utf8"));
    if (!parsed.ok) {
      return [
        {
          code: "openai-yaml",
          message: `not valid YAML (${parsed.error})`,
          path: OPENAI_METADATA,
        },
      ];
    }
    codexUserInvoked =
      asRecord(asRecord(parsed.value).policy).allow_implicit_invocation ===
      false;
  }
  const claudeUserInvoked = metadata["disable-model-invocation"] === true;
  if (claudeUserInvoked === codexUserInvoked) {
    return [];
  }
  return [
    {
      code: "invocation-mismatch",
      message: claudeUserInvoked
        ? `disable-model-invocation is true, so ${OPENAI_METADATA} must set policy.allow_implicit_invocation: false`
        : `${OPENAI_METADATA} sets policy.allow_implicit_invocation: false, so SKILL.md must set disable-model-invocation: true`,
      path: SKILL_FILE,
    },
  ];
};

/**
 * Check one skill directory the way skill discovery reads it: strict YAML
 * frontmatter, a spec name matching the directory, a 1 to 1,024 character
 * description, the same invocation policy for Claude Code and Codex, and
 * every relative link in SKILL.md and references/ resolving, inside the skill
 * directory too when the skill must be self-contained.
 */
export const checkSkill = (
  skillDirectory: string,
  options: SkillCheckOptions = {}
): SkillCheckReport => {
  const root = resolve(skillDirectory);
  const skillPath = resolve(root, SKILL_FILE);
  if (!existsSync(skillPath)) {
    return {
      issues: [
        {
          code: "skill-file-missing",
          message: "the directory has no SKILL.md",
          path: SKILL_FILE,
        },
      ],
      linksChecked: 0,
      name: null,
      schemaVersion: 1,
      skillDirectory: root,
      valid: false,
    };
  }
  const frontmatter = readFrontmatter(readFileSync(skillPath, "utf8"));
  const issues = [...frontmatter.issues];
  if (frontmatter.metadata) {
    issues.push(
      ...checkIdentity(frontmatter.metadata, basename(root)),
      ...checkInvocationParity(root, frontmatter.metadata)
    );
  }
  const links = checkLinks(
    root,
    [skillPath, ...markdownFiles(resolve(root, "references"))],
    options.selfContained ?? false
  );
  issues.push(...links.issues);
  const name = frontmatter.metadata?.name;
  return {
    issues,
    linksChecked: links.checked,
    name: typeof name === "string" ? name : null,
    schemaVersion: 1,
    skillDirectory: root,
    valid: issues.length === 0,
  };
};
