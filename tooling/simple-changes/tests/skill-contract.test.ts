import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const skillPath = new URL(
  "../../../skills/simple-changes/SKILL.md",
  import.meta.url
);
const changelogCoordinationPath = new URL(
  "../../../skills/simple-changes/references/changelog-coordination.md",
  import.meta.url
);
const deploymentPath = new URL(
  "../../../skills/simple-changes/references/deployments.md",
  import.meta.url
);
const changelogReceiptSchemaPath = new URL(
  "../../../skills/simple-changes/evals/schemas/changelog-receipt.schema.json",
  import.meta.url
);

describe("Simple Changes skill contract", () => {
  test("Ship loops prove production matches the refreshed target head", async () => {
    const source = await readFile(skillPath, "utf8");
    const normalizedSource = source.replace(/\s+/g, " ");

    expect(normalizedSource).toContain(
      "refresh the canonical remote target branch (normally `main`)"
    );
    expect(normalizedSource).toContain(
      "Verify the live deployment observes the same revision, even when no deployment was created during this run"
    );
    expect(normalizedSource).toContain(
      "A Ship or resumed Ship loop is incomplete when the live revision differs from the latest canonical target revision"
    );
  });

  test("Web production requires merged versioned release reconciliation", async () => {
    const [skill, coordination, deployment, receiptSchema] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(changelogCoordinationPath, "utf8"),
      readFile(deploymentPath, "utf8"),
      readFile(changelogReceiptSchemaPath, "utf8"),
    ]);

    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedCoordination = coordination.replace(/\s+/g, " ");
    const normalizedDeployment = deployment.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "A production Web deployment always requires a dated, versioned release receipt"
    );
    expect(normalizedSkill).toContain(
      "Treat every production Web deployment as a product release"
    );
    expect(normalizedCoordination).toContain(
      'targetContainedUnreleased: "integrated"'
    );
    expect(normalizedCoordination).toContain(
      "Deploy only that refreshed reconciled target"
    );
    expect(normalizedDeployment).toContain(
      "An unresolved version, unavailable or blocked delegation, preserve-and-report disposition, unmerged reconciliation, or target-contained pending item blocks production"
    );
    expect(receiptSchema).toContain('"targetContainedUnreleased"');
    expect(receiptSchema).toContain('"const": "integrated"');
  });

  test("Onboarding explains the consequence of every option", async () => {
    const source = await readFile(skillPath, "utf8");
    const normalizedSource = source.replace(/\s+/g, " ");

    expect(normalizedSource).toContain(
      "show every option with its one-sentence consequence"
    );
    expect(normalizedSource).toContain(
      "**Put it up for review:** Create focused proposals, run checks, and stop."
    );
    expect(normalizedSource).toContain(
      "**Ask me first:** Merge automatically, but confirm before production."
    );
    expect(normalizedSource).toContain(
      "**Delegate when available:** Use a compatible changelog skill when present;"
    );
    expect(normalizedSource).toContain(
      "**Only when blocked:** Keep working unless a decision is genuinely required."
    );
    expect(normalizedSource).toContain(
      "**This run only:** Use the choices now without writing a policy file."
    );
  });

  test("Queue mode reports every discovered deferred unit", async () => {
    const source = await readFile(skillPath, "utf8");
    const normalizedSource = source.replace(/\s+/g, " ");

    expect(normalizedSource).toContain("Queue does not mean");
    expect(normalizedSource).toContain("outstanding-work ledger");
    expect(normalizedSource).toContain("may not silently omit it");
    expect(normalizedSource).toContain("**Outstanding work**");
    expect(normalizedSource).toContain(
      "including clean branches and separate worktrees"
    );
    expect(normalizedSource).toContain("current revision/state");
    expect(normalizedSource).toContain("why it was deferred");
    expect(normalizedSource).toContain("the next action");
  });
});
