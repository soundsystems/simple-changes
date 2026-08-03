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
const syncPath = new URL(
  "../../../skills/simple-changes/references/sync.md",
  import.meta.url
);
const shipCommunicationPath = new URL(
  "../../../skills/simple-changes/references/ship-communication.md",
  import.meta.url
);
const inventoryConcurrencyPath = new URL(
  "../../../skills/simple-changes/references/inventory-and-concurrency.md",
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
    expect(normalizedSource).toContain(
      "**Ask if it's ready:** Recommended. Ask whether the implementation is ready"
    );
    expect(normalizedSource).toContain(
      "**Automatically after implementation:** Hand off completed, verified implementation work immediately"
    );
    expect(normalizedSource).toContain(
      "**When I say it's ready:** Wait for the user to ask to put up, merge, ship"
    );
    expect(normalizedSource).toContain(
      "**Follow repository convention:** Recommended. Use the established format"
    );
    expect(normalizedSource).toContain(
      "**Number and date:** Use zero-padded sequence and ISO date names"
    );
    expect(normalizedSource).toContain(
      "Ordinary UI source files, Git revisions, deployment identities, package versions, and release versions do not use this preference"
    );
  });

  test("Completed-work handoff requires the configured readiness gate", async () => {
    const source = await readFile(skillPath, "utf8");
    const normalizedSource = source.replace(/\s+/g, " ");

    expect(normalizedSource).toContain(
      "initialize \\ --mode handoff \\ --json"
    );
    expect(normalizedSource).toContain(
      "Is this ready for Simple Changes, or do you want more changes first?"
    );
    expect(normalizedSource).toContain(
      "Continue only when `mutationAllowed` is true"
    );
    expect(normalizedSource).toContain(
      "Do not invoke it after planning, diagnosis, read-only work"
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

  test("Sync is local-only and preserves unsafe checkout state", async () => {
    const [skill, sync] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(syncPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedSync = sync.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "A bare Sync request authorizes exact-target fetch and a guarded local update"
    );
    expect(normalizedSync).toContain(
      "Do not select an unrelated remote because it is alphabetically first"
    );
    expect(normalizedSync).toContain(
      "Dirty, conflicted, detached, or mid-operation"
    );
    expect(normalizedSync).toContain(
      "Fast-forward only to the refreshed target"
    );
    expect(normalizedSync).toContain(
      "Generic Sync never authorizes a force push or rewriting shared history"
    );
  });

  test("Ship communicates scope before mutation and review deltas after", async () => {
    const [skill, communication] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(shipCommunicationPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedCommunication = communication.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "before the first consequential Ship mutation, send a concise pre-ship brief in the same assistant turn"
    );
    expect(normalizedSkill).toContain(
      "this is an interruption window rather than a permission gate"
    );
    expect(normalizedCommunication).toContain(
      "state that the run is proceeding and continue in the same assistant turn"
    );
    expect(normalizedCommunication).toContain(
      "Record the proposal's original reviewed head"
    );
    expect(normalizedCommunication).toContain(
      "If review caused no code or behavior change, say so explicitly"
    );
    expect(normalizedCommunication).toContain(
      "The final response compares the pre-ship brief with the observed result"
    );
  });

  test("Active loops enforce exclusive leases and isolated agent worktrees", async () => {
    const [skill, concurrency] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(inventoryConcurrencyPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedConcurrency = concurrency.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "start one active loop before the first mutation"
    );
    expect(normalizedSkill).toContain("simple-changes.ts prepare-agent");
    expect(normalizedSkill).toContain(
      "When an active loop exists, a new authoring agent's first action is to prepare its own isolated worktree"
    );
    expect(normalizedSkill).toContain(
      "Before merge, deployment, cleanup, and completion, run `loop verify`"
    );
    expect(normalizedConcurrency).toContain(
      "A second controller cannot replace an active lease"
    );
    expect(normalizedConcurrency).toContain(
      "It also rejects any new unregistered worktree"
    );
    expect(normalizedConcurrency).toContain(
      "An override is an exceptional user handoff, not a way to suppress the guard"
    );
  });
});
