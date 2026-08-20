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
const changelogRequestSchemaPath = new URL(
  "../../../skills/simple-changes/evals/schemas/changelog-request.schema.json",
  import.meta.url
);
const releaseDeliverySchemaPath = new URL(
  "../../../skills/simple-changes/evals/schemas/release-delivery-receipt.schema.json",
  import.meta.url
);
const runStateSchemaPath = new URL(
  "../../../skills/simple-changes/evals/schemas/run-state.schema.json",
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
const userCommunicationPath = new URL(
  "../../../skills/simple-changes/references/user-communication.md",
  import.meta.url
);
const inventoryConcurrencyPath = new URL(
  "../../../skills/simple-changes/references/inventory-and-concurrency.md",
  import.meta.url
);
const onboardingPath = new URL(
  "../../../skills/simple-changes/references/onboarding.md",
  import.meta.url
);
const guidanceUpdatesPath = new URL(
  "../../../skills/simple-changes/references/guidance-updates.md",
  import.meta.url
);
const migrationActionsPath = new URL(
  "../../../skills/simple-changes/references/migrations-and-high-risk-actions.md",
  import.meta.url
);
const cleanupCompletionPath = new URL(
  "../../../skills/simple-changes/references/cleanup-and-completion.md",
  import.meta.url
);
const gitlabProviderPath = new URL(
  "../../../skills/simple-changes/references/providers/gitlab.md",
  import.meta.url
);
const runtimeSourcePaths = [
  "process.ts",
  "loop-lease.ts",
  "worktree-coordination.ts",
].map(
  (file) =>
    new URL(
      `../../../skills/simple-changes/scripts/lib/${file}`,
      import.meta.url
    )
);

describe("Simple Changes skill contract", () => {
  test("keeps the primary skill as a compact router", async () => {
    const skill = await readFile(skillPath, "utf8");
    expect(skill.split("\n").length).toBeLessThanOrEqual(500);
  });

  test("first-use onboarding explains the workflow before preference questions", async () => {
    const [skill, onboarding] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(onboardingPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedOnboarding = onboarding.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "The JSON result is not user-facing onboarding copy"
    );
    expect(normalizedOnboarding).toContain(
      "Use recommended setup — Recommended"
    );
    expect(normalizedOnboarding).toContain("Walk me through it");
    expect(normalizedOnboarding).toContain("Sync with main");
    expect(normalizedOnboarding).toContain("Open changes for everything ready");
    expect(normalizedOnboarding).toContain("Ask one question at a time");
    expect(normalizedOnboarding).toContain(
      "This choice controls only where the workflow is remembered"
    );
    expect(normalizedOnboarding).toContain(
      "Never expose the raw handshake as though it were the onboarding question"
    );
    expect(normalizedOnboarding).toContain(
      "How should routine Ship requests run?"
    );
    expect(normalizedOnboarding).toContain("Break-glass by default — Advanced");
    expect(normalizedOnboarding).toContain(
      "How should reviewed database migrations be handled during Ship?"
    );
  });

  test("installed update notices use clear copy before any shipment loop", async () => {
    const [skill, guidance] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(guidanceUpdatesPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedGuidance = guidance.replace(/\s+/g, " ");

    expect(normalizedGuidance).toContain(
      "**Simple Changes has recently been updated.**"
    );
    expect(normalizedGuidance).toContain(
      "Would you like me to walk you through all recent updates to the skill?"
    );
    expect(normalizedGuidance).toContain(
      "**Simple Changelogs has recently been updated.**"
    );
    expect(normalizedGuidance).toContain(
      "Would you like me to walk you through all recent updates to both skills?"
    );
    expect(normalizedSkill).toContain(
      "resolve the Simple Changelogs notice and the user's owner-controlled walkthrough, continue, defer, or release-notes choice before `loop start`"
    );
    expect(normalizedSkill).toContain(
      "Do not start a Ship loop, send the pre-ship brief, acquire a lease, then pause it for this explanation"
    );
    expect(normalizedGuidance).toContain(
      "Start the loop only after initialization returns `preLoopActionRequired: false`"
    );
    expect(normalizedGuidance).toContain(
      "Recommend reviewing the new abilities; never mark keeping settings, skipping, continuing, or deferring as Recommended"
    );
    expect(normalizedGuidance).toContain(
      "It does not grant credentials, > network access, force-push, branch-protection bypass"
    );
  });

  test("Ship requests bundle every knowable permission without broadening authority", async () => {
    const [skill, communication] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(shipCommunicationPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedCommunication = communication.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "present them together in one exact-target checklist"
    );
    expect(normalizedCommunication).toContain(
      "Present one permission checklist rather than serial prompts"
    );
    expect(normalizedCommunication).toContain(
      "Let the user approve all listed items, decline all, or approve named IDs in one reply"
    );
    expect(normalizedCommunication).toContain(
      "Host sandbox and network approval dialogs may still be enforced separately"
    );
  });

  test("terminal loop lifecycle releases or relinquishes every controller", async () => {
    const [skill, inventory, cleanup] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(inventoryConcurrencyPath, "utf8"),
      readFile(cleanupCompletionPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedInventory = inventory.replace(/\s+/g, " ");
    const normalizedCleanup = cleanup.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "Before every terminal assistant response after a loop has started"
    );
    expect(normalizedSkill).toContain("loop finalize");
    expect(normalizedSkill).toContain(
      "automatically removes proven safe worktrees, stale metadata, and merged local branches"
    );
    expect(normalizedSkill).toContain(
      "any unresolved dirty-primary path keeps the run incomplete"
    );
    expect(normalizedSkill).toContain(
      "exact current run ID and manifest digest plus approver and reason"
    );
    expect(normalizedInventory).toContain(
      "marks the controller `relinquished`"
    );
    expect(normalizedCleanup).toContain(
      "It releases a complete lease or relinquishes an incomplete one"
    );
    expect(normalizedCleanup).toContain(
      "Incomplete finalization relinquishes durable state and exits nonzero"
    );
  });

  test("runtime sources do not carry obsolete Biome suppressions", async () => {
    const sources = await Promise.all(
      runtimeSourcePaths.map((path) => readFile(path, "utf8"))
    );
    const combinedSource = sources.join("\n");

    expect(combinedSource).not.toContain("noAwaitInLoops");
    expect(combinedSource).not.toContain("lint/style/useErrorCause");
  });

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

  test("Web production requires negotiated phased release verification", async () => {
    const [
      skill,
      coordination,
      deployment,
      receiptSchema,
      requestSchema,
      deliverySchema,
    ] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(changelogCoordinationPath, "utf8"),
      readFile(deploymentPath, "utf8"),
      readFile(changelogReceiptSchemaPath, "utf8"),
      readFile(changelogRequestSchemaPath, "utf8"),
      readFile(releaseDeliverySchemaPath, "utf8"),
    ]);

    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedCoordination = coordination.replace(/\s+/g, " ");
    const normalizedDeployment = deployment.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain("read-only `verified` receipt");
    expect(normalizedSkill).toContain(
      "Treat every production Web deployment as a product release"
    );
    expect(normalizedSkill).toContain(
      "Negotiate supported versions/features and exact schema digests"
    );
    expect(normalizedCoordination).toContain(
      'targetContainedUnreleased: "integrated"'
    );
    expect(normalizedCoordination).toContain(
      "Deploy only that verified finalized target"
    );
    expect(normalizedDeployment).toContain(
      "require a v2 `verified` changelog receipt"
    );
    expect(normalizedDeployment).toContain(
      "composite `release-delivery-receipt`"
    );
    expect(requestSchema).toContain('"prepare-release-files"');
    expect(receiptSchema).toContain('"targetContainedUnreleased"');
    expect(receiptSchema).toContain('"const": "integrated"');
    expect(receiptSchema).toContain('"decision-required"');
    expect(deliverySchema).toContain('"deployedRevision"');
  });

  test("Onboarding explains the consequence of every option", async () => {
    const source = await readFile(skillPath, "utf8");
    const normalizedSource = source.replace(/\s+/g, " ");
    const onboarding = (await readFile(onboardingPath, "utf8")).replace(
      /\s+/g,
      " "
    );

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
      "**Delegate when available — Recommended when installed:** Use a compatible changelog skill when present;"
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
    expect(onboarding).toContain(
      "Would you like me to install Simple Changelogs now?"
    );
    expect(onboarding).toContain(
      "When should I set up Simple Changelogs: now, after this shipment, or later?"
    );
    expect(onboarding).toContain("Never install it silently");
    expect(onboarding).toContain(
      "grant no version, release, publication, deployment, or data-write authority"
    );
    expect(normalizedSource).toContain(
      "When private global personal defaults already exist, disclose them before the main questions"
    );
    expect(onboarding).toContain(
      "I found existing global personal defaults. Would you like to use them for this run?"
    );
    expect(onboarding).toContain("Update global personal defaults");
    expect(onboarding).toContain("updated and overwritten");
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

  test("GitLab integration cleanup accounts for every remote branch", async () => {
    const [skill, cleanup, gitlab] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(cleanupCompletionPath, "utf8"),
      readFile(gitlabProviderPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedCleanup = cleanup.replace(/\s+/g, " ");
    const normalizedGitlab = gitlab.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "complete the remote-branch reconciliation gate across every paginated branch before completion"
    );
    expect(normalizedSkill).toContain("Delete proven-obsolete remote branches");
    expect(normalizedCleanup).toContain(
      "union of the initial and final inventories"
    );
    expect(normalizedCleanup).toContain(
      "preserve the canonical target, protected branches, branches used by any open MR"
    );
    expect(normalizedCleanup).toContain(
      "Audit closed/unmerged branches separately from branches with no MR"
    );
    expect(normalizedCleanup).toContain("loop reconcile-remote-branches");
    expect(normalizedCleanup).toContain(
      "`loop end` refuses a detected GitLab integration/reconciliation run"
    );
    expect(normalizedGitlab).toContain(
      "`should_remove_source_branch` value as proof"
    );
    expect(normalizedGitlab).toContain(
      "paginate all branches again and record the final remote-branch reconciliation receipt"
    );
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

  test("user-facing messages default to simple language before technical evidence", async () => {
    const [skill, communication] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(userCommunicationPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedCommunication = communication.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "Lead with what happened, what it means for the user, and what happens next"
    );
    expect(normalizedSkill).toContain(
      "Keep most progress updates to one to three short sentences"
    );
    expect(normalizedCommunication).toContain(
      "The user usually needs the outcome and consequence, not the names of the internal mechanisms"
    );
    expect(normalizedCommunication).toContain(
      "Do not lead with controller, lease, ledger, manifest, digest"
    );
    expect(normalizedCommunication).toContain(
      "I’m reopening that run, applying only the setting you approved"
    );
    expect(normalizedCommunication).toContain("there—nothing will be shipped");
    expect(normalizedCommunication).toContain(
      "Put dense audit details last, under a clearly optional technical section"
    );
  });

  test("Emergency Ship keeps urgency separate from break-glass authority", async () => {
    const [skill, communication, deployment, runStateSchema] =
      await Promise.all([
        readFile(skillPath, "utf8"),
        readFile(shipCommunicationPath, "utf8"),
        readFile(deploymentPath, "utf8"),
        readFile(runStateSchemaPath, "utf8"),
      ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedCommunication = communication.replace(/\s+/g, " ");
    const normalizedDeployment = deployment.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "Urgency can infer `expedited`; it never grants production authority or waives independent review"
    );
    expect(normalizedSkill).toContain(
      "Saved break-glass plus automatic production means “Ship” is enough"
    );
    expect(normalizedDeployment).toContain(
      "Emergency Ship is a narrow exception to the normal ordering"
    );
    expect(normalizedDeployment).toContain(
      "Do not create a second deployment merely because reconciliation produced a new Git revision"
    );
    expect(normalizedCommunication).toContain("`live-unreviewed`");
    expect(normalizedCommunication).toContain("`live-unreconciled`");
    expect(runStateSchema).toContain('"emergencyShipping"');
    expect(runStateSchema).not.toContain('"rawPrompt"');
  });

  test("migration automation always follows review and exact target binding", async () => {
    const [skill, migrationActions] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(migrationActionsPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedActions = migrationActions.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "Audit every detected migration before any apply"
    );
    expect(normalizedActions).toContain("auto-apply-reviewed-routine");
    expect(normalizedActions).toContain("auto-apply-reviewed");
    expect(normalizedActions).toContain("simple-changes migration decision");
    expect(normalizedActions).toContain("provider/project/environment target");
    expect(normalizedActions).toContain(
      "destructive or data-deleting, irreversible, unbounded, lock-heavy, target-mismatched, or unprotected changes"
    );
  });

  test("Active loops serialize integration while allowing claimed authors", async () => {
    const [skill, concurrency] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(inventoryConcurrencyPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedConcurrency = concurrency.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "start one active loop only after initialization returns `preLoopActionRequired: false`"
    );
    expect(normalizedSkill).toContain(
      "Start the loop before the first integration mutation"
    );
    expect(normalizedSkill).toContain("simple-changes.ts prepare-agent");
    expect(normalizedSkill).toContain(
      "When an active loop assigns a new author into that same integration unit"
    );
    expect(normalizedSkill).toContain(
      "both run-prepared and independently claimed authors edit, generate, format, test, stage, and commit normally and concurrently"
    );
    expect(normalizedSkill).toContain(
      "Run only shared integration mutations through `loop exec`"
    );
    expect(normalizedSkill).toContain(
      "A busy lock blocks only the named short integration operation"
    );
    expect(normalizedSkill).toContain(
      'use `loop recover --agent-id "$AGENT_ID"`'
    );
    expect(normalizedSkill).toContain(
      "Before merge, deployment, cleanup, and completion, run `loop verify`"
    );
    expect(normalizedConcurrency).toContain(
      "A second controller cannot replace an active lease"
    );
    expect(normalizedConcurrency).toContain(
      "It rejects any new unclaimed worktree, branch switch, incomplete preparation"
    );
    expect(normalizedConcurrency).toContain(
      "The author may keep editing and committing without a pause receipt"
    );
    expect(normalizedConcurrency).toContain(
      "Git already uses separate per-worktree indexes and atomic locks"
    );
    expect(normalizedConcurrency).toContain(
      "When a genuine integration lock is busy, wait or retry only that short shared operation"
    );
    expect(normalizedConcurrency).toContain(
      "treat it as a local harness/filesystem authorization failure"
    );
    expect(normalizedConcurrency).not.toContain(
      "Run local Git and repository commands through `loop exec`"
    );
    expect(normalizedConcurrency).toContain(
      "the same command validates and resumes the recorded preparation"
    );
    expect(normalizedConcurrency).toContain(
      "It refuses to adopt staged, unstaged, or untracked content"
    );
    expect(normalizedConcurrency).toContain(
      "every recorded child/process group is inactive"
    );
    expect(normalizedConcurrency).toContain(
      "background descendants remain does not complete the guarded mutation"
    );
    expect(normalizedConcurrency).toContain(
      "An override is an exceptional user handoff, not a way to suppress the guard"
    );
    expect(normalizedSkill).toContain("loop dispose-worktree");
    expect(normalizedSkill).toContain(
      "proving it clean with zero unique commits"
    );
    expect(normalizedConcurrency).toContain(
      "The disposition permits only that opening worktree's absence"
    );
    expect(normalizedConcurrency).toContain(
      "target ref or revision differs from the active lease"
    );
  });
});
