# Setup and policy

## Discovery order

1. Read the user's current request; it is the highest authority for this run.
2. Read repository and directory-scoped agent instructions.
3. Load `.simple-changes.json` from the canonical primary checkout when present.
4. Otherwise load the user's saved Simple Changes preferences when present.
5. Discover Git, forge, changelog, review, CI, release, migration, and deployment
   capabilities from tracked repository evidence.
6. Treat remote/provider state as discovered fact, never durable policy.

Effective preference precedence is:

1. the user's current request;
2. repository `.simple-changes.json`;
3. saved user preferences;
4. safe defaults.

## Automatic initialization checkpoint

For the first screen, question-by-question presentation, diagrams, preference
storage explanation, and confirmation receipt, follow
[conversational onboarding](onboarding.md).

Classify the request mode and whether it requires changelog work, then run:

```sh
simple-changes initialize --mode <mode> [--changelog-required] --json
```

Sync, queue, sweep, integrate, ship, reconcile, resume, and handoff are
write-capable. Preview and pause are read-only or preservation-only. Sync uses
fixed local-only preservation guardrails and does not start workflow-preference
onboarding. When any other write-capable mode has policy source `default`,
onboarding is required before any local branch, commit, push, proposal, merge,
cleanup, or deployment mutation.

Start onboarding automatically; do not add a separate “would you like to set
this up?” gate. Explain that onboarding is available and offer recommended,
customized, and run-only setup. The request mode supplies the finish choice for
queue, sweep, integrate, reconcile, and ship. Ask only unresolved questions,
confirm the receipt, persist the selected scope, and continue the original task.

Ask **How should changelog work be handled?** only when established changelog
surfaces or a compatible changelog skill are discovered. Offer delegation when
available, preservation and reporting, or asking before delegation. The safe
fallback is preservation. When compatible Simple Changelogs is discovered,
delegation is the recommended default. When changelog surfaces exist without a
compatible installation, explain the skill and ask whether to install it. If
the user agrees, separately ask whether its owner-controlled setup should run
now, after the current shipment, or later; never silently combine installation
with setup. Setup never grants release, version, publication, deployment, or
data-write authority.

Public patch/minor/major behavior remains owned by Simple Changelogs and is
never stored in `.simple-changes.json`. When first Ship use needs both products'
preferences, Simple Changes may present one coordinated conversation using a
structured onboarding contribution from Simple Changelogs. The confirmation
names both owner-controlled destinations, then each canonical helper writes
only its own policy.

Persist coordinated setup as `pending`, `completed`, or `partial` with policy
and write-receipt digests rather than copied values. If one owner write fails,
preserve the valid write and resume only the incomplete owner after fresh
inspection. Do not ask public-version questions when the changelog workflow
reports that no version-owning release train applies.

Ask **When I save multiple UI iterations, how should their version names be
chosen?** only when the current task will preserve multiple UI artifacts and no
repository convention already answers it. Offer repository convention
(recommended), number and ISO date, ISO date only, or zero-padded number only.
This preference applies to saved screenshots, design exports, and static
previews—not source files, Git revisions, deployments, packages, or releases.

In an interactive terminal, `initialize` directly launches setup. In a
non-interactive agent runtime, it emits a closed machine-readable status. The
agent must translate that status into the same onboarding questions in chat,
then call `setup` with explicit flags. A valid repository or personal policy
suppresses repeat onboarding.

A saved policy with an older meaningful guidance version triggers the separate
installed-update checkpoint before write-capable mutation or loop creation. It
does not restart first-use onboarding. Present Simple Changes changes and
settings only and persist the user's reviewed, accepted, or deferred
disposition for that version. Detect Simple Changelogs updates separately. When
the current request requires changelog work, resolve its owner-controlled
disposition before starting an integration loop; never pause an already-created
shipment loop for that conversation.
Follow [installed guidance updates](guidance-updates.md).

Use these safe defaults when no committed policy exists:

```json
{
  "schemaVersion": 1,
  "guidance": { "disposition": "accepted", "version": 11 },
  "changelogHandling": "preserve-and-report",
  "defaultFinish": "open-change-request",
  "gitPushAuthorization": "ask",
  "handoffTiming": "confirm-ready",
  "migrationHandling": "ask-after-review",
  "migrationTargets": [],
  "uiArtifactVersioning": "repository-convention",
  "questions": "blocking-only",
  "review": "repository-policy",
  "productionDeploy": "ask",
  "shippingMode": "standard",
  "concurrentWork": "allow-claimed"
}
```

`shippingMode` accepts `standard`, `expedited`, or `break-glass`. Onboarding and
`--shipping-mode` expose all three, with break-glass clearly labeled Advanced.
When `break-glass` is paired with `productionDeploy: "allow"`, a normal Ship
request supplies both saved ordering and production authority, so do not ask
for a redundant break-glass phrase. Rollback evidence, focused checks, later
review, forward reconciliation, verification, and cleanup remain mandatory.
Initialization returns the effective `shippingMode`; the agent must pass that
closed value into emergency classification instead of re-defaulting it.

`gitPushAuthorization` accepts `configure-harness`, `ask`, or `never`.
Initialization returns the effective value. `configure-harness` directs the
agent to use the current harness's narrowest repository-scoped persistent rule
for the verified remote after user confirmation; it does not itself grant
permission or override host policy. Follow
[harness-aware Git push authorization](harness-push-authorization.md).
Repository policy cannot silently grant consequential authority. A repository
policy that requests persistent push permission, automatic migration apply,
break-glass ordering, or automatic production deploy is downgraded to safe
ask/standard behavior until the user creates a private, regular-file,
digest-bound trust receipt beneath the repository's common Git directory.
Changing the repository path or policy bytes invalidates that receipt. Reject
policy symlinks.

`migrationHandling` accepts `ask-after-review`,
`auto-apply-reviewed-routine`, `auto-apply-reviewed`, or `never`. Every mode
reviews migrations first. Automatic modes require at least one exact
`migrationTargets` entry containing provider, project, and environment. Their
saved authority applies only to matching targets and never to destructive,
irreversible, unbounded, lock-heavy, unprotected, or target-mismatched work.

`allow-claimed` is the default. It permits independent authoring in distinct,
actively claimed, non-primary worktrees while retaining one integration
controller for push, proposal, merge, deployment, target movement, and cleanup.
Use `strict` only when the team deliberately wants repository-wide
serialization. The legacy `preserve` value is accepted as an alias for the
concurrent default.

Validate policy with `evals/schemas/repo-policy.schema.json`. Reject unknown
fields so misspellings cannot silently weaken safeguards. Policy may record team
choices; it must not contain credentials, derived project IDs, transient branch
names, or run state.

Use `simple-changes setup` for interactive onboarding. It can save the same
closed policy contract for the user, in the platform configuration directory,
or for the repository, at the canonical primary checkout. Run-only setup writes
nothing. Personal and run-only setup can run outside Git; repository scope
requires a repository.

After scope is known, inspect for one established instruction target. Repository
scope checks existing root `AGENTS.md` and `CLAUDE.md`; if both exist, require an
exact choice. Personal scope accepts only the current runtime's explicitly
established global instruction path. Run-only scope offers no instruction edit.
Never guess a global path, create a missing instruction file, follow a symlink,
or append a duplicate managed block.

When a target exists, ask whether to add the managed pointer. Only after the
user chooses **Add the pointer**, ask:

> When an agent finishes implementation and verification, when should Simple
> Changes take over?

Offer **Ask if it's ready** as the recommended default, **Automatically after
implementation**, and **When I say it's ready**. The confirmation summary must
show the exact target path and proposed managed block. Apply an authorized edit
atomically, preserve existing content and newline style, and re-read it after
writing.

For deterministic agent or automation use, supply:

```sh
simple-changes setup \
  --finish review \
  --changelog preserve-and-report \
  --questions blocking-only \
  --scope user \
  --instruction-file /exact/existing/AGENTS.md \
  --instruction-pointer add \
  --handoff ask \
  --yes
```

For `--finish ship`, also supply `--production ask|allow|deny`; use
`--shipping-mode standard|expedited` when automation must select the routine
shipping order explicitly.
For a task that will save multiple UI artifact iterations, also supply
`--ui-artifacts` and
`--ui-versioning repository|number-and-date|date-only|number-only`.
`SIMPLE_CHANGES_CONFIG_DIR` may override the personal configuration root for
isolated automation and tests.

## Completed-work handoff checkpoint

An automatic or confirmation-based instruction pointer starts with:

```sh
simple-changes initialize --mode handoff --json
```

The closed status separates a write-capable mode from current mutation
permission:

- `confirm-readiness`: ask whether the implementation and checks are complete;
  when the user confirms, rerun with `--ready`;
- `wait-for-user`: do not hand off until the user signals readiness;
- `proceed`: continue only when `mutationAllowed` is true and use
  `resolvedMode` as the finish boundary.

The readiness question is: **The implementation and checks are complete. Is
this ready for Simple Changes, or do you want more changes first?** The choices
are **Ready—hand it off** and **More changes first**.

The pointer may be considered only after completed, attributable implementation
that changed repository files and passed proportionate verification. Planning,
diagnosis, read-only work, blocked or incomplete changes, no-change tasks,
changelog-only work, Simple Changes itself, and another agent's active work do
not qualify. Handoff timing never grants production or high-risk authority.

## Capability status

Represent each capability as one of:

- `supported`: discovered and available;
- `unsupported`: the adapter cannot provide it;
- `configuration`: the capability exists but CLI, authentication, or repository
  configuration is missing;
- `unavailable`: a temporary provider failure;
- `partial`: the operation produced incomplete evidence.

Never translate any non-supported status into success. Provider-specific
commands belong only in the matching provider reference or adapter.
