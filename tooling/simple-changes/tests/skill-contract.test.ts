import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const skillPath = new URL(
  "../../../skills/simple-changes/SKILL.md",
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
      "Verify the live deployment observes that revision, even when no deployment was created during this run"
    );
    expect(normalizedSource).toContain(
      "A Ship or resumed Ship loop is incomplete when the live revision differs from the latest canonical target revision"
    );
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
