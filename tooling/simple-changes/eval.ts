#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
import { extractReleaseNotes } from "../../skills/simple-changes/scripts/lib/release-notes.ts";
import {
  classifyRequestMode,
  shouldTrigger,
} from "../../skills/simple-changes/scripts/lib/triggers.ts";
import { validateToolingSchema } from "./schema.ts";

interface TriggerCase {
  expected: boolean;
  id: string;
  prompt: string;
}

interface JourneyCase {
  authority: string[];
  expectedBehaviors: string[];
  id: string;
  mode:
    | "preview"
    | "sync"
    | "queue"
    | "sweep"
    | "integrate"
    | "ship"
    | "reconcile"
    | "resume"
    | "pause";
  prompt: string;
}

interface ReleaseBehaviorCase {
  assertions: Array<{
    contains: string[];
    exists: boolean;
    notContains: string[];
    path: string;
  }>;
  fixture: string;
  id: string;
  prompt: string;
}

interface EvalManifest {
  journeys: JourneyCase[];
  releaseCases: ReleaseBehaviorCase[];
  schemaVersion: 1;
  skillName: "simple-changes";
  triggers: TriggerCase[];
}

// Agent Skills specification limits for discoverable frontmatter.
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, "../..");
const skillDirectory = resolve(repositoryRoot, "skills/simple-changes");
const manifestPath = resolve(moduleDirectory, "evals/cases.json");
const manifest = validateToolingSchema<EvalManifest>(
  "eval-manifest",
  JSON.parse(readFileSync(manifestPath, "utf8")) as unknown
);
const failures: string[] = [];

// Case IDs are the only handle failure messages have, so they must be unique
// across every array, and journeys must carry real behavior expectations even
// though only the model-backed behavior eval can execute them.
const caseIds = [
  ...manifest.triggers,
  ...manifest.journeys,
  ...manifest.releaseCases,
].map((entry) => entry.id);
for (const duplicate of caseIds.filter(
  (id, index) => caseIds.indexOf(id) !== index
)) {
  failures.push(`${duplicate}: case ID is reused across the manifest`);
}
for (const journey of manifest.journeys) {
  if (journey.expectedBehaviors.length === 0) {
    failures.push(`${journey.id}: journey declares no expected behaviors`);
  }
}

for (const triggerCase of manifest.triggers) {
  const contextEstablished = triggerCase.id.includes("resume");
  const actual = shouldTrigger(triggerCase.prompt, contextEstablished);
  if (actual !== triggerCase.expected) {
    failures.push(
      `${triggerCase.id}: trigger was ${actual}, expected ${triggerCase.expected}`
    );
  }
}

for (const journey of manifest.journeys) {
  const contextEstablished = journey.mode === "resume";
  const actual = classifyRequestMode(journey.prompt, contextEstablished);
  if (actual !== journey.mode) {
    failures.push(
      `${journey.id}: mode was ${actual}, expected ${journey.mode}`
    );
  }
}

const requiredSkillFiles = [
  "SKILL.md",
  "SPEC.md",
  "CHANGELOG.md",
  "scripts/simple-changes.ts",
  "evals/schemas/changelog-receipt.schema.json",
  "evals/schemas/repo-policy.schema.json",
  "evals/schemas/inventory.schema.json",
  "evals/schemas/change-plan.schema.json",
  "evals/schemas/run-state.schema.json",
  "evals/schemas/loop-lease.schema.json",
  "evals/schemas/provider-receipt.schema.json",
  "evals/schemas/release-consistency.schema.json",
  "evals/schemas/release-notes.schema.json",
  "references/changelog-coordination.md",
  "references/ship-communication.md",
  "references/sync.md",
];
for (const filename of requiredSkillFiles) {
  if (!existsSync(resolve(skillDirectory, filename))) {
    failures.push(`Package is missing ${filename}`);
  }
}

const requiredToolingFiles = [
  "EVAL.md",
  "behavior-eval.ts",
  "adapters/claude-eval.ts",
  "adapters/codex-eval.ts",
  "adapters/cursor-eval.ts",
  "adapters/eval-shared.ts",
  "adapters/grok-eval.ts",
  "adapters/hermes-eval.ts",
  "evals/cases.json",
  "check-fork-sync.sh",
  "check-release-notes-fork-sync.sh",
  "release-notes/release-notes.md",
  "release-notes/release-setup-and-history.md",
  "release-notes/release-lifecycle.md",
  "release-notes/major-releases.md",
  "release-notes/release-guidance-updates.md",
  "evals/schemas/eval-manifest.schema.json",
  "evals/schemas/runner-request.schema.json",
  "evals/schemas/runner-response.schema.json",
];
for (const filename of requiredToolingFiles) {
  if (!existsSync(resolve(moduleDirectory, filename))) {
    failures.push(`Maintainer tooling is missing ${filename}`);
  }
}

const forbiddenSkillFiles = [
  "EVAL.md",
  "scripts/behavior-eval.ts",
  "scripts/tests",
  "evals/fixtures",
  "references/release-notes.md",
  "references/release-setup-and-history.md",
  "references/release-lifecycle.md",
  "references/major-releases.md",
  "references/release-guidance-updates.md",
];
for (const filename of forbiddenSkillFiles) {
  if (existsSync(resolve(skillDirectory, filename))) {
    failures.push(`Public package contains maintainer-only ${filename}`);
  }
}

for (const releaseCase of manifest.releaseCases) {
  if (
    !existsSync(resolve(moduleDirectory, "evals/fixtures", releaseCase.fixture))
  ) {
    failures.push(
      `${releaseCase.id}: fixture does not exist: ${releaseCase.fixture}`
    );
  }
  for (const assertion of releaseCase.assertions) {
    if (
      assertion.path.startsWith("/") ||
      assertion.path === ".." ||
      assertion.path.startsWith("../") ||
      assertion.path.includes("/../")
    ) {
      failures.push(
        `${releaseCase.id}: unsafe assertion path: ${assertion.path}`
      );
    }
  }
}

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
const discoverableSkills = walk(skillDirectory).filter((path) =>
  path.endsWith("/SKILL.md")
);
if (discoverableSkills.length !== 1) {
  failures.push(
    `Installed package must contain one SKILL.md; found ${discoverableSkills.length}`
  );
}
const toolingSkills = walk(moduleDirectory).filter((path) =>
  path.endsWith("/SKILL.md")
);
if (toolingSkills.length !== 0) {
  failures.push(
    `Maintainer tooling must not be discoverable as a skill; found ${toolingSkills.length} SKILL.md file(s)`
  );
}

// Skill discovery silently skips a SKILL.md whose frontmatter is not valid YAML
// (an unquoted colon-space in a description is enough), so every skill in this
// repository must parse and carry a spec-conformant name and description. A
// user-invoked skill must be user-invoked in every harness: Claude Code's
// disable-model-invocation and Codex's agents/openai.yaml policy move together.
// Returns undefined after recording a parse failure, so a document that parses
// to null (an empty frontmatter block) is still checked as missing fields.
const parseYaml = (label: string, source: string): unknown => {
  try {
    return YAML.parse(source);
  } catch (error) {
    failures.push(`${label}: not valid YAML (${String(error)})`);
    return undefined;
  }
};

const checkSkillFrontmatter = (skillPath: string): void => {
  const label = relative(repositoryRoot, skillPath);
  const frontmatter = FRONTMATTER_PATTERN.exec(
    readFileSync(skillPath, "utf8")
  )?.[1];
  if (frontmatter === undefined) {
    failures.push(`${label}: missing YAML frontmatter`);
    return;
  }
  const parsed = parseYaml(`${label} frontmatter`, frontmatter);
  if (parsed === undefined) {
    return;
  }
  const metadata = (
    parsed !== null && typeof parsed === "object" ? parsed : {}
  ) as Record<string, unknown>;
  const { description, name } = metadata;
  if (
    typeof name !== "string" ||
    name.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_PATTERN.test(name) ||
    name !== basename(dirname(skillPath))
  ) {
    failures.push(
      `${label}: name must be a lowercase hyphenated identifier matching its directory`
    );
  }
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    description.length > MAX_SKILL_DESCRIPTION_LENGTH
  ) {
    failures.push(
      `${label}: description must be a non-empty string of at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters`
    );
  }
  const openaiPath = resolve(dirname(skillPath), "agents/openai.yaml");
  if (!existsSync(openaiPath)) {
    return;
  }
  const openai = parseYaml(
    relative(repositoryRoot, openaiPath),
    readFileSync(openaiPath, "utf8")
  ) as { policy?: { allow_implicit_invocation?: unknown } } | null | undefined;
  const claudeUserInvoked = metadata["disable-model-invocation"] === true;
  const codexUserInvoked = openai?.policy?.allow_implicit_invocation === false;
  if (claudeUserInvoked !== codexUserInvoked) {
    failures.push(
      `${label}: disable-model-invocation and agents/openai.yaml policy.allow_implicit_invocation disagree`
    );
  }
};

for (const skillPath of walk(resolve(repositoryRoot, "skills")).filter((path) =>
  path.endsWith("/SKILL.md")
)) {
  checkSkillFrontmatter(skillPath);
}

const skillBody = readFileSync(resolve(skillDirectory, "SKILL.md"), "utf8");
const relativeLinks = [
  ...skillBody.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]+)?\)/gu),
]
  .map((match) => match[1])
  .filter((link): link is string => Boolean(link));
for (const link of relativeLinks) {
  if (!existsSync(resolve(skillDirectory, link))) {
    failures.push(`SKILL.md link does not exist: ${link}`);
  }
}

const canonicalNotes = extractReleaseNotes(
  readFileSync(resolve(repositoryRoot, "CHANGELOG.md"), "utf8"),
  "CHANGELOG.md"
);
const packagedNotes = extractReleaseNotes(
  readFileSync(resolve(skillDirectory, "CHANGELOG.md"), "utf8"),
  "skills/simple-changes/CHANGELOG.md"
);
if (
  canonicalNotes.version !== packagedNotes.version ||
  canonicalNotes.markdown !== packagedNotes.markdown
) {
  failures.push(
    "Packaged release-note history does not match the canonical root CHANGELOG.md"
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `Simple Changes eval failed (${failures.length}):\n${failures
      .map((failure) => `- ${failure}`)
      .join("\n")}\n`
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Simple Changes eval passed: ${manifest.triggers.length} trigger cases, ${manifest.journeys.length} integration journeys, ${manifest.releaseCases.length} maintainer release behavior cases, closed manifest, lean one-skill package, and isolated maintainer tooling.\n`
  );
}
