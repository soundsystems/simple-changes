#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractReleaseNotes } from "../../skills/simple-changes/scripts/lib/release-notes.ts";
import { checkSkill } from "../../skills/simple-changes/scripts/lib/skill-check.ts";
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
// repository passes the same check forks run with `simple-changes skill
// check`: strict frontmatter, a spec name and description, matching Claude
// Code and Codex invocation settings, and relative links that resolve. An
// installed copy carries only its skill directory, so links must also stay
// inside it.
for (const skillPath of walk(resolve(repositoryRoot, "skills")).filter((path) =>
  path.endsWith("/SKILL.md")
)) {
  const skillRoot = dirname(skillPath);
  for (const issue of checkSkill(skillRoot, { selfContained: true }).issues) {
    failures.push(
      `${relative(repositoryRoot, resolve(skillRoot, issue.path))}: ${issue.message}`
    );
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
