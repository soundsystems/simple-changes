import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { YAML } from "bun";

const skillPath = new URL(
  "../../../skills/simple-changes/SKILL.md",
  import.meta.url
);
const MODE_TABLE_PATTERN = /\| Intent \| Mode \| Boundary \|[\s\S]*?\n\n/u;
const MODE_ROW_PATTERN = /^\| [^|]+ \| ([A-Za-z]+) \|/gmu;
const specPath = new URL(
  "../../../skills/simple-changes/SPEC.md",
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
const setupAndPolicyPath = new URL(
  "../../../skills/simple-changes/references/setup-and-policy.md",
  import.meta.url
);
const harnessPushPath = new URL(
  "../../../skills/simple-changes/references/harness-push-authorization.md",
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
const codexMetadataPath = new URL(
  "../../../skills/simple-changes/agents/openai.yaml",
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
      "Use recommended setup (Recommended)"
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
    expect(normalizedOnboarding).toContain("Break-glass by default (Advanced)");
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
      "ask those questions immediately, one at a time, before asking whether the user wants any walkthrough"
    );
    expect(normalizedGuidance).toContain(
      "**Simple Changelogs has recently been updated.**"
    );
    expect(normalizedGuidance).toContain("Continue with current settings");
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
      "do not recommend the expanded walkthrough by default"
    );
    expect(normalizedGuidance).toContain(
      "When no answer is required, say so plainly and recommend continuing with current settings"
    );
    const normalizedHarnessPush = (
      await readFile(harnessPushPath, "utf8")
    ).replace(/\s+/g, " ");
    expect(normalizedHarnessPush).toContain(
      "It does not grant credentials, > network access, force-push, branch-protection bypass"
    );
    expect(normalizedGuidance).toContain(
      "scoped-push explanation and confirmation from [harness-aware Git push authorization](harness-push-authorization.md)"
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
      "An exact verified shipment may close with an unchanged primary explicitly preserved in its scope"
    );
    expect(normalizedSkill).toContain(
      "exact current run ID and manifest digest plus approver and reason"
    );
    expect(normalizedInventory).toContain(
      "marks the controller `relinquished`"
    );
    expect(normalizedInventory).toContain(
      "A refresh keeps the scoped units and cannot add a path to a scoped source worktree, but it accepts new paths that the refreshed plan lists in `preserved` for any other worktree"
    );
    expect(normalizedInventory).toContain(
      "every path preserved earlier stays preserved while it is still changed, whatever the refreshed preview proposes for it. A refresh does not excuse the change itself"
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
    expect(normalizedCoordination).toContain(
      "a provider must not advertise `shared-version-lines` in a repository until every Simple Changes controller there, including fork copies, is 0.23.0 or later"
    );
    expect(normalizedCoordination).toContain(
      "`catch-up` takes exactly H, and only for a train below H"
    );
    expect(normalizedCoordination).toContain(
      "The receipt's `decisionDigest` must cover the line state (`mode`, `members`, `memberVersions`, and `sharedVersion`)"
    );
    expect(normalizedCoordination).toContain(
      "A multi-train release set stays non-atomic"
    );
    const normalizedDeployment = deployment.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain("read-only `verified` receipt");
    expect(normalizedSkill).toContain(
      "Treat every production Web deployment as a product release"
    );
    expect(normalizedSkill).toContain(
      "Negotiate supported versions and features from the provider's declared marker"
    );
    expect(normalizedCoordination).toContain(
      "Advertised schema digests are advisory"
    );
    expect(normalizedCoordination).toContain(
      "machine-readable `changelog-provider.json` beside its `SKILL.md`"
    );
    expect(normalizedCoordination).toContain(
      'targetContainedUnreleased: "integrated"'
    );
    expect(normalizedCoordination).toContain(
      "Deploy only that verified finalized target"
    );
    expect(normalizedDeployment).toContain(
      "require a v2 or later `verified` changelog receipt"
    );
    expect(normalizedDeployment).toContain(
      "composite `release-delivery-receipt`"
    );
    expect(requestSchema).toContain('"prepare-release-files"');
    expect(receiptSchema).toContain('"targetContainedUnreleased"');
    expect(receiptSchema).toContain('"const":"integrated"');
    expect(receiptSchema).toContain('"decision-required"');
    expect(receiptSchema).toContain('"classified"');
    expect(normalizedCoordination).toContain(
      "An operator-relevant result returns `classified`"
    );
    expect(normalizedCoordination).toContain(
      "proceed to `prepare` without requesting version or production approval"
    );
    expect(deliverySchema).toContain('"deployedRevision"');
  });

  test("ships the vendored protocol schemas minified, byte for byte", async () => {
    // Simple Changelogs vendors these two files byte-identically; both repos
    // produce them as JSON.stringify(JSON.parse(text)) + "\n".
    const paths = [changelogRequestSchemaPath, changelogReceiptSchemaPath];
    const shipped = await Promise.all(
      paths.map((path) => readFile(path, "utf8"))
    );
    expect(
      shipped.map((text) => text === `${JSON.stringify(JSON.parse(text))}\n`)
    ).toEqual([true, true]);
  });

  test("release-gate flags come only from their sources and features stay informational", async () => {
    const [spec, coordination, deployment, setupPolicy] = await Promise.all([
      readFile(specPath, "utf8"),
      readFile(changelogCoordinationPath, "utf8"),
      readFile(deploymentPath, "utf8"),
      readFile(setupAndPolicyPath, "utf8"),
    ]);
    const normalizedSpec = spec.replace(/\s+/g, " ");
    const normalizedCoordination = coordination.replace(/\s+/g, " ");
    const normalizedDeployment = deployment.replace(/\s+/g, " ");

    for (const rule of [
      "The gate takes its flags on trust and grants no authority, so no printed action, including `deploy`, is permission",
      "`--production`: start from the `productionDeploy` that `initialize --json` reports, which already applies the trust rule in [setup and policy](setup-and-policy.md) (a repository `allow` without its local trust receipt is `ask`). Current user direction may lower it (for example to `deny`) and never raises it above `ask`; a user's production approval goes in `--production-authorized`",
      "`--production-authorized`: only explicit current-request production authority for this exact target, under the production-authority rules in this skill's [SKILL.md](../SKILL.md) and [ship communication](ship-communication.md#compose-version-and-production-direction), never your own inference",
      "`--version-authorized`: only an explicit user version decision bound to this receipt's decision digest",
      "`--already-live`: only fresh provider evidence that the exact verified finalized target is live",
      "Route on the printed `action`, not the exit code: every decision, including `block`, exits 0",
      "A nonzero exit means the inputs were rejected and nothing was decided, which blocks the boundary",
    ]) {
      expect(normalizedCoordination).toContain(rule);
    }
    expect(normalizedDeployment).toContain(
      "repository policy is effective only with its local trust receipt"
    );
    expect(setupPolicy.replace(/\s+/g, " ")).toContain(
      "It likewise returns the effective `productionDeploy`, which is where `release-gate --production` starts (see [changelog coordination](changelog-coordination.md)) instead of a value read from the policy file"
    );
    expect(normalizedDeployment).toContain(
      "A `release-gate` decision is never that authority"
    );
    expect(normalizedSpec).toContain(
      "Passing `release-gate` a flag its documented source does not support (effective policy, a matching user decision, or fresh provider evidence), treating its printed decision as authority, or routing on its exit code instead of its `action`"
    );

    // Versions alone enable shared version lines; the feature is informational.
    expect(normalizedCoordination).toContain(
      "It needs request v2 and receipt v3, and the negotiated versions alone decide whether it is available"
    );
    expect(normalizedCoordination).toContain(
      "The `shared-version-lines` feature is optional and informational: negotiation reports it, but nothing gates on it"
    );
    expect(normalizedCoordination).toContain(
      "A provider may leave it out until it gates real behavior"
    );
    expect(normalizedCoordination).toContain(
      "Simple Changes 0.13.0 and later ignore unknown versions (earlier releases reject them, so advertising request v2 or receipt v3 needs every controller at 0.13.0 or later), but releases before 0.23.0 reject any feature outside their closed list"
    );
    expect(normalizedCoordination).not.toContain(
      "advertises together with the `shared-version-lines` feature"
    );
  });

  test("blocks unsafe production changes for installed clients", async () => {
    const [skill, migrationActions] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(migrationActionsPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedMigrationActions = migrationActions.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "Installed-client compatibility: <state> (<evidence and reason>)"
    );
    expect(normalizedSkill).toContain(
      "A new client release alone does not make a breaking rollout safe"
    );
    expect(normalizedMigrationActions).toContain(
      "without an enforced minimum-version boundary, older installed clients may still use the production backend"
    );
    for (const state of [
      "`compatible`",
      "`release-recommended`",
      "`incompatible`",
      "`unverified`",
    ]) {
      expect(normalizedMigrationActions).toContain(state);
    }
    expect(normalizedMigrationActions).toContain(
      "Use an expand-and-contract sequence instead"
    );
  });

  test("Onboarding explains the consequence of every option", async () => {
    const source = await readFile(skillPath, "utf8");
    const normalizedSource = source.replace(/\s+/g, " ");
    const onboarding = (await readFile(onboardingPath, "utf8")).replace(
      /\s+/g,
      " "
    );
    const setupAndPolicy = (await readFile(setupAndPolicyPath, "utf8")).replace(
      /\s+/g,
      " "
    );

    expect(normalizedSource).toContain(
      "show every option with its one-sentence consequence"
    );
    expect(onboarding).toContain(
      "**Put it up for review**: Create focused proposals, run checks, and stop."
    );
    expect(onboarding).toContain(
      "**Ask me first (Recommended)**: Merge automatically, then confirm before a production deployment."
    );
    expect(onboarding).toContain(
      "**Delegate when available (Recommended when installed)**: Use a compatible changelog skill when present;"
    );
    expect(onboarding).toContain(
      "**Only when blocked (Recommended)**: Continue through already-authorized work"
    );
    expect(onboarding).toContain(
      "**This run only**: Write no preference file and ask again next time."
    );
    expect(setupAndPolicy).toContain(
      "**Ask if it's ready (Recommended):** Ask whether the implementation is ready"
    );
    expect(setupAndPolicy).toContain(
      "**Automatically after implementation:** Hand off completed, verified implementation work immediately"
    );
    expect(setupAndPolicy).toContain(
      "**When I say it's ready:** Wait for the user to ask to put up, merge, ship"
    );
    expect(onboarding).toContain(
      "**Follow repository convention (Recommended)**: Use the established format"
    );
    expect(onboarding).toContain(
      "**Number and date**: Use zero-padded sequence and ISO date names"
    );
    expect(onboarding).toContain(
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
      'initialize \\ --mode handoff \\ --agent-id "$AGENT_ID" \\ --json'
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

  test("public release receipts end with exact-version customer notes", async () => {
    const [skill, communication, shipCommunication] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(userCommunicationPath, "utf8"),
      readFile(shipCommunicationPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedCommunication = communication.replace(/\s+/g, " ");
    const normalizedShipCommunication = shipCommunication.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain("concise **Latest customer notes**");
    expect(normalizedCommunication).toContain(
      "public release notes for the exact version handled by this run"
    );
    expect(normalizedCommunication).toContain(
      "Do not paste the full changelog, developer-only notes, signatures"
    );
    expect(normalizedCommunication).toContain(
      "A reconciled public release may have customer notes even when its production deployment is blocked"
    );
    expect(normalizedCommunication).toContain(
      "Render each customer note as a Markdown blockquote (`>`)"
    );
    expect(normalizedShipCommunication).toContain(
      "two to five practical notes summarized from the public notes"
    );
    expect(normalizedShipCommunication).toContain(
      "rather than another operational bullet"
    );
    expect(normalizedShipCommunication).toContain(
      "Omit it for internal-only or `release:none` work"
    );
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
      "verifies with Git that the initial head is the merged head or its ancestor and that the target contains the merged head"
    );
    expect(normalizedCleanup).toContain(
      "the receipt cannot be recorded: the branch is already gone, so stop and report the branch, initial head, and MR to the user"
    );
    expect(normalizedCleanup).toContain(
      "Squash-merge projects, and GitLab rebase-merge projects whenever GitLab rebased the MR, always land there"
    );
    expect(normalizedCleanup).toContain(
      "Never recreate a deleted branch to make the ledger fit"
    );
    expect(normalizedCleanup).toContain(
      "never delete a branch on that basis without the user's explicit approval for that branch"
    );
    expect(normalizedCleanup).toContain(
      "never make that judgment yourself. Only when the user confirms the branch was superseded"
    );
    expect(normalizedCleanup).toContain(
      "every replacement is in the target and is not an ancestor of the deleted head"
    );
    expect(normalizedCleanup).toContain(
      "`loop reconcile-remote-branches` refuses a shallow clone"
    );
    expect(normalizedCleanup).toContain(
      "`loop reconcile-remote-branches` checks `target-contains-head` with Git: the deleted head must be present locally"
    );
    expect(normalizedCleanup).toContain(
      "Git cannot check `provider-diff-empty`; record it only from the provider's own compare result"
    );
    expect(normalizedCleanup).toContain(
      "When the check fails after the branch is already gone, ask the user whether its work shipped another way (supersession, below), or report it"
    );
    expect(normalizedCleanup).toContain(
      "that restores their work and is never a way to make the ledger fit"
    );
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
    expect(normalizedSkill).toContain(
      "record it with `loop record-scope --receipt <change-plan.json>`"
    );
    expect(normalizedSkill).toContain(
      "`loop record-outcome --receipt <shipment-outcome.json>`"
    );
    expect(normalizedCommunication).toContain(
      "Do not push an early subset and audit the other worktrees afterward"
    );
    expect(normalizedCommunication).toContain(
      "show a short feature/outcome description, its branch or detached revision, and its source worktree"
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
      "The final response then compares the pre-ship brief with the observed result"
    );
    expect(normalizedCommunication).toContain(
      "Open with what shipped, not with how it shipped"
    );
    expect(normalizedCommunication).toContain(
      "required even when no changelog entry was written"
    );
    expect(normalizedCommunication).toContain(
      "cannot answer “what is different now?” is incomplete"
    );
    expect(normalizedSkill).toContain(
      "A Ship receipt opens by naming the actual shipped change in plain language"
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
    expect(normalizedCommunication).toContain("there; nothing will be shipped");
    expect(normalizedCommunication).toContain(
      "Put dense audit details last, under a clearly optional technical section"
    );
    expect(normalizedCommunication).toContain(
      "list every finding as its own concise bullet"
    );
    expect(normalizedCommunication).toContain(
      "Do not replace the list with an abstract count"
    );
    expect(normalizedCommunication).toContain(
      "make its primary file and line a clickable Markdown link"
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
    expect(normalizedSkill).toContain("simple-changes prepare-agent");
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
      "Until then, `loop guard`, `loop exec`, and completion fail closed"
    );
    expect(normalizedConcurrency).toContain(
      "the run has changed nothing yet, `loop end` closes it with an `abort-unmutated.json` receipt, and a fresh `loop start` takes a new baseline"
    );
    expect(normalizedConcurrency).toContain(
      "Record-scope accepts unrelated changes made after `loop start`: claimed authors' edits and commits, other branches, stashes, and late claimed worktrees"
    );
    expect(normalizedConcurrency).toContain(
      "or when the controller checkout or any unit source worktree differs from its loop-start branch, head, or content"
    );
    expect(normalizedSkill).toContain(
      "generate one non-mutating preview plan from the current inventory"
    );
    expect(normalizedSkill).toContain(
      "one that owed a scope, recorded none, and changed nothing: finalization closes it instead of freezing its scope"
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
    expect(normalizedSkill).toContain("loop retire-absent-worktree");
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

  test("Parallel agents author in prepared worktrees and never integrate", async () => {
    const [skill, concurrency, spec] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(inventoryConcurrencyPath, "utf8"),
      readFile(specPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedConcurrency = concurrency.replace(/\s+/g, " ");
    const normalizedSpec = spec.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      "the controller prepares every agent's worktree with `prepare-agent`"
    );
    expect(normalizedSkill).toContain(
      "the controller alone pushes, merges, and finalizes"
    );
    expect(normalizedSkill).toContain(
      "references/inventory-and-concurrency.md#parallel-agents"
    );
    expect(normalizedConcurrency).toContain("## Parallel agents");
    expect(normalizedConcurrency).toContain(
      "When the host cannot start agents or report their completion, author the units consecutively"
    );
    expect(normalizedConcurrency).toContain(
      "Give each unit a new agent ID that is never the controller's own, and require `created: true` from its first call"
    );
    expect(normalizedConcurrency).toContain(
      "Never let the host create an agent's checkout, including through its own worktree isolation"
    );
    expect(normalizedConcurrency).toContain(
      "preparation is an `unregistered-worktree` violation: it blocks every guarded operation and further `prepare-agent`"
    );
    expect(normalizedConcurrency).toContain(
      "first confirm the earlier agent has ended"
    );
    expect(normalizedConcurrency).toContain(
      "Reproduce checks inside the unit's registered worktree after its author has returned, never in a new checkout"
    );
    expect(normalizedConcurrency).toContain(
      "A delegated agent runs no `initialize` or `loop` command, push, provider call, merge, release, deployment, or cleanup"
    );
    expect(normalizedConcurrency).toContain(
      "the controller confirms that the registered branch head equals the reported commit"
    );
    expect(normalizedConcurrency).toContain(
      "An agent never reviews a unit it authored"
    );
    expect(normalizedConcurrency).toContain(
      "A snapshot split across agents is not one baseline"
    );
    expect(normalizedSpec).toContain(
      "a host-created checkout is an unregistered worktree that blocks guarded operations"
    );
    expect(normalizedSpec).toContain(
      "inventory snapshots are never split across agents"
    );
  });

  test("Ready receipts and shipment holds coordinate without messaging", async () => {
    const [skill, concurrency, spec] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(inventoryConcurrencyPath, "utf8"),
      readFile(specPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedConcurrency = concurrency.replace(/\s+/g, " ");
    const normalizedSpec = spec.replace(/\s+/g, " ");

    expect(skill).toContain("## Shipment holds");
    expect(normalizedSkill).toContain(
      "Agents in different harnesses coordinate shipments through the shared coordination directory without messaging each other."
    );
    expect(normalizedSkill).toContain(
      "add `--for merge`, `--for deploy`, or `--for migrations` so [shipment holds](#shipment-holds) gate that step"
    );
    expect(normalizedSkill).toContain(
      "Release another agent's hold only with the user's explicit approval, adding `--override-halt` for a halt."
    );
    expect(normalizedSkill).toContain(
      "Waive a `halt` only when the user explicitly approves overriding that exact hold."
    );
    expect(normalizedSkill).toContain(
      "record the receipt with `worktree release --ready-receipt <file>`; the active controller reads it without a message"
    );
    expect(normalizedConcurrency).toContain("## Ready-work receipts");
    expect(normalizedConcurrency).toContain("## Shipment holds");
    expect(normalizedConcurrency).toContain(
      "releases the claim as a completed-work `handoff` that records the receipted evidence, so an active loop that admitted the author keeps integrating"
    );
    expect(normalizedConcurrency).toContain(
      "never ship newer commits on an old receipt"
    );
    expect(normalizedConcurrency).toContain(
      "`ship` covers merges, deployments, and migrations; `deploy` covers deployments; `migrations` covers migration applies"
    );
    expect(normalizedConcurrency).toContain(
      "if merging the target deploys or migrates automatically, treat it as blocking and ask the user"
    );
    expect(normalizedConcurrency).toContain(
      "Publishing is a push, so follow [harness push authorization](harness-push-authorization.md)"
    );
    expect(normalizedConcurrency).toContain(
      "No hold is released by elapsed time."
    );
    expect(normalizedConcurrency).toContain(
      "A gate fails closed when published holds cannot be read, including when remotes exist but none is the target; pass `--local-only` only after the user agrees."
    );
    expect(normalizedConcurrency).toContain(
      "Holds never block `loop finalize`"
    );
    expect(normalizedConcurrency).toContain(
      "Another clone judges a published `--until-merged` hold only from that remote's copy of the branch, never from a same-named local branch"
    );
    expect(normalizedConcurrency).toContain(
      "it applies only while that controller holds control"
    );
    expect(normalizedSpec).toContain(
      "releases the claim as a completed-work handoff carrying that exact evidence so an active loop keeps integrating"
    );
    expect(normalizedSpec).toContain(
      "A hold ends only by its owner, by a user-approved release, or by `--until-merged` containment evidence, never by elapsed time."
    );
    expect(normalizedSpec).toContain(
      "Releasing or waiving another agent's shipment hold without user approval, or treating an unreadable published hold as absent."
    );
  });

  test("Controllers finalize before replying, and a turn-end guard backs the rule", async () => {
    const [skill, cleanup, spec] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(cleanupCompletionPath, "utf8"),
      readFile(specPath, "utf8"),
    ]);
    const normalizedSkill = skill.replace(/\s+/g, " ");
    const normalizedCleanup = cleanup.replace(/\s+/g, " ");
    const normalizedSpec = spec.replace(/\s+/g, " ");

    expect(normalizedSkill).toContain(
      'add `--awaiting-user "<question>"` once per question: the run pauses, records the questions, exits zero, and resumes with `loop start --mode resume` after the answer'
    );
    expect(normalizedSkill).toContain(
      "When initialization reports `turnEndGuard` as not installed or outdated, offer once to install it with its `installCommand`"
    );
    expect(normalizedSkill).toContain(
      "It is persistent harness configuration, so ask first; declining changes nothing."
    );
    expect(normalizedSkill).toContain("`runtimeFreshness` as `behind-target`");
    expect(cleanup).toContain("## Turn-end guard");
    expect(normalizedCleanup).toContain(
      "if the agent tries to stop again, it only warns, so it never traps a session"
    );
    expect(normalizedCleanup).toContain(
      "Do not use it for questions about later work."
    );
    expect(normalizedCleanup).toContain(
      "do not finalize a run your running subagent drives."
    );
    expect(normalizedCleanup).toContain(
      "a still-running command never excuses a later lease write. If the session also controls a run of its own, the hook still blocks and names both. Once the subagent finishes, or its run goes stale, the hook blocks the parent again until the run is finalized. Workflow agents are not excused yet, and an unreadable, oversized, or slow transcript scan blocks."
    );
    expect(normalizedCleanup).toContain(
      "only if no parent command and no other running subagent ever used that ID; give each agent its own ID. At least one of them must have run in the run's checkout or one of its worktrees"
    );
    expect(normalizedCleanup).toContain(
      "A `$NAME` value counts as literal when the same command assigns NAME exactly once, as a plain token (no space, quote, shell operator, or leading `-`) that starts and ends an unconditional top-level statement, before using it"
    );
    expect(normalizedCleanup).toContain(
      "the blocking message says which condition failed and, unless control visibly moved back to this session, asks the session to wait for that agent instead of finalizing"
    );
    expect(normalizedSpec).toContain(
      "A live run that a still running background subagent of the same session drives only advises."
    );
    expect(normalizedSpec).toContain(
      "`loop finalize --awaiting-user` pauses a run for a user decision"
    );
    expect(normalizedSpec).toContain(
      "A running session process alone never keeps an idle run live."
    );
    expect(normalizedSpec).toContain(
      "Initialization reports whether the hook is installed and never installs it."
    );
  });

  test("SPEC.md stays bound to the skill it specifies", async () => {
    const [skill, spec] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(specPath, "utf8"),
    ]);
    const normalizedSpec = spec.replace(/\s+/g, " ");
    for (const heading of [
      "## Triggers",
      "## Non-triggers",
      "## Inputs",
      "## Outputs",
      "## Guarantees",
      "## Forbidden behaviors",
    ]) {
      expect(spec).toContain(heading);
    }
    // Remote-branch deletion proofs must match the runtime's verified set.
    for (const guarantee of [
      "or with Git-verified merged-head ancestry when the same MR was open at the opening head and merged at a descendant",
      "`target-contains-head` is verified with Git (exact ancestry or full per-commit patch equivalence, whose patch IDs ignore whitespace) when the receipt is recorded",
      "and without provider evidence of an empty diff, may close only with an explicitly user-approved supersession",
      "explicitly user-approved supersession naming the deleted head, a reason, and replacement target commits",
    ]) {
      expect(normalizedSpec).toContain(guarantee);
    }
    // Every request mode the skill classifies must be specified.
    const modeTable = skill.match(MODE_TABLE_PATTERN);
    expect(modeTable).not.toBeNull();
    const modes = [...(modeTable?.[0] ?? "").matchAll(MODE_ROW_PATTERN)]
      .map((match) => match[1])
      .filter((mode): mode is string => Boolean(mode) && mode !== "Mode");
    expect(modes.length).toBeGreaterThanOrEqual(9);
    for (const mode of modes) {
      expect(normalizedSpec.toLowerCase()).toContain(mode.toLowerCase());
    }
    // Guarantees that the skill and code rely on must not silently disappear.
    for (const guarantee of [
      "Existing and concurrent work is preserved unless ownership and scope are proven",
      "Write-capable integration modes hold one atomic integration-controller lease",
      "A worktree owner can persist an opaque local claim",
      "A claim is released by its owner, by a proceeding completed-work handoff for that checkout, or by finalization evidence",
      "no claim is released by elapsed time or by guessing its owner",
      "Completed-work handoff cannot mutate while readiness confirmation is pending",
      "Harness automation is capability-gated",
      "A required changelog update blocks loop creation until Simple Changelogs owns and records the user's disposition",
      "the controller checkout and every unit source worktree at their exact loop-start branch, head, and content digest",
    ]) {
      expect(normalizedSpec).toContain(guarantee);
    }
    // The readiness question is one contract in three places.
    expect(normalizedSpec).toContain("completed-work handoff");
    expect(skill.replace(/\s+/g, " ")).toContain(
      "Is this ready for Simple Changes, or do you want more changes first?"
    );
  });

  test("Codex metadata names the skill and keeps it model-invoked", async () => {
    const [skill, metadata] = await Promise.all([
      readFile(skillPath, "utf8"),
      readFile(codexMetadataPath, "utf8"),
    ]);
    const parsed = YAML.parse(metadata) as {
      interface?: Record<string, unknown>;
      policy?: unknown;
    };
    expect(parsed.interface?.display_name).toBe("Simple Changes");
    expect(String(parsed.interface?.short_description).length).toBeLessThan(65);
    expect(String(parsed.interface?.default_prompt)).toStartWith(
      "Use $simple-changes to "
    );
    // Model-invoked in both harnesses: no Codex policy block, and no Claude
    // Code disable-model-invocation.
    expect(parsed.policy).toBeUndefined();
    expect(skill).not.toContain("disable-model-invocation");
  });
});
