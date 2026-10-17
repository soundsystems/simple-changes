# Setup and policy

Contents:

- Discovery order
- Automatic initialization checkpoint
- Completed-work handoff checkpoint
- Capability status
- Authoring preferences

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

When initialization reports `turnEndGuard` as not installed or outdated and
it has no `installCommand`, as from a fork with no current global install, tell
the user to install the guard from the globally installed Simple Changes; see
[turn-end guard](cleanup-and-completion.md#turn-end-guard).

When it reports `scratchFileRule`, each listed instruction file (the
repository's `AGENTS.md` or `CLAUDE.md`, and the global `~/.codex/AGENTS.md`
or `~/.claude/CLAUDE.md`) carries the scratch-file block as `current`,
`stale`, `absent`, or `invalid`. A `stale` block was written by an earlier
release. Offer once to run its `refreshCommand`
(`simple-changes scratch-file-rule refresh --instruction-file <path>`), which
rewrites exactly that block in place and nothing else; declining changes
nothing. It never adds the rule to a file without one, which stays a setup
choice, and an `invalid` block (duplicated or crossed markers) is repaired by
hand. While a Simple Changes run holds the repository, even a paused one, it
refuses a file in any of the repository's checkouts with exit 5, because the
run preserves them: offer it again after the run ends. A global file outside
every checkout can be refreshed at any time. `reviewLoopRule` reports the
optional review-loop block the same way, refreshed with
`simple-changes review-loop-rule refresh --instruction-file <path>` under the
same rules.

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
preferences, finish the Simple Changes questions first, then hand off to the
provider's own owner-controlled setup as a separate step; each canonical helper
writes only its own policy file, and neither setup is rolled back because the
other has not run yet. Do not ask public-version questions in Simple Changes
at all, and do not ask them when the changelog workflow reports that no
version-owning release train applies.

Ask **When I save multiple UI iterations, how should their version names be
chosen?** only when the current task will preserve multiple UI artifacts and no
repository convention already answers it. Offer repository convention
(recommended), number and ISO date, ISO date only, or zero-padded number only.
This preference applies to saved screenshots, design exports, and static
previews, not source files, Git revisions, deployments, packages, or releases.

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
  "guidance": { "disposition": "accepted", "version": "<CURRENT_GUIDANCE_VERSION>" },
  "changelogHandling": "preserve-and-report",
  "defaultFinish": "open-change-request",
  "gitPushAuthorization": "ask",
  "handoffTiming": "confirm-ready",
  "migrationHandling": "ask-after-review",
  "migrationTargets": [],
  "proposalScheduling": "balanced",
  "proposalSignatures": "agent-and-version",
  "uiArtifactVersioning": "repository-convention",
  "questions": "blocking-only",
  "review": "repository-policy",
  "productionDeploy": "ask",
  "shippingMode": "standard",
  "concurrentWork": "allow-claimed"
}
```

Replace the guidance-version placeholder with the currently installed value
(`CURRENT_GUIDANCE_VERSION` in `scripts/lib/guidance-updates.ts`); do not copy
a stale literal from documentation.

`shippingMode` accepts `standard`, `expedited`, or `break-glass`. Onboarding and
`--shipping-mode` expose all three, with break-glass clearly labeled Advanced.
When `break-glass` is paired with `productionDeploy: "allow"`, a normal Ship
request supplies both saved ordering and production authority, so do not ask
for a redundant break-glass phrase. Rollback evidence, focused checks, later
review, forward reconciliation, verification, and cleanup remain mandatory.
Initialization returns the effective `shippingMode`; the agent must pass that
closed value into emergency classification instead of re-defaulting it. It
likewise returns the effective `productionDeploy`, which is where
`release-gate --production` starts (see
[changelog coordination](changelog-coordination.md)) instead of a value read
from the policy file.

`proposalSignatures` accepts `agent-and-version` or `none` and defaults to
`agent-and-version`: every agent that authors, reviews, or merges a PR or MR
appends its model name and version to the proposal description as described in
[change proposals](change-requests.md) and
[review and merge](review-and-merge.md). A signature records attribution only;
it never substitutes for review, approval, merge, or deployment authority.

`proposalScheduling` accepts `balanced`, `consecutive`, or `parallel` and
defaults to `balanced`. It decides whether independent PRs or MRs are normally
authored one at a time or in separate claimed worktrees. It never permits two
authors to share a checkout, weakens controller guards, or authorizes provider
mutations. A necessary isolation worktree may still be used under `consecutive`;
briefly explain why. Ask again only for a material deviation or unusually
expensive fan-out.

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

`execGuard` is optional and read only from the repository's
`.simple-changes.json`; personal preferences never supply one. It is a
non-empty JSON array of strings, never a shell string, for example
`["bun", "scripts/exec-guard.ts"]`. Inside the lease of every `loop exec`, after
all other lease checks and immediately before the child starts, the runtime
runs `[...execGuard, ...command]` from the checkout the command runs in, with
`SIMPLE_CHANGES_RUN_ID` set to the run and `SIMPLE_CHANGES_REPOSITORY` set to
that checkout. The guard's stdout and stderr go to stderr, so `--json` output
stays parseable. Exit 0 lets the command start; any other exit, or a guard that
cannot start, refuses it with an error naming the guard argv and exit code, and
the child never starts. The guard decides which commands it gates and must exit
0 for every other command. A guard only restricts, so it applies without the
policy trust receipt, but it is repository code that runs with the agent's
permissions, like repository checks: review a guard as you would any script the
agent runs. It gates only commands run through `loop exec`, so route the
commands it protects, such as merges, through `loop exec`. Setup and
`acknowledge-update` keep a saved guard unchanged. Runtimes without
`execGuard` support reject a policy that names it as an unknown field, so add it
only after every Simple Changes copy that reads the repository, including
repository forks, supports it. See the
[GitLab example](providers/gitlab.md#gate-merges-on-hosted-ci).

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

Offer:

- **Ask if it's ready (Recommended):** Ask whether the implementation is ready
  or whether more changes are needed before handing it off.
- **Automatically after implementation:** Hand off completed, verified
  implementation work immediately, subject to current authority.
- **When I say it's ready:** Wait for the user to ask to put up, merge, ship,
  finish, or reconcile the completed work.

The repository block names the skill that runs setup, so a repository fork's
setup points agents at the fork by its own `SKILL.md` name; a personal block
keeps generic wording because it spans repositories. The start and end markers
never change, so an existing block is found and replaced in place.

Whenever a target exists, also ask whether to add the optional scratch-file
rule, whatever the pointer answer was. It is a second managed block with its
own `<!-- simple-changes:scratch-files:start -->` and `:end -->` markers, so
rewriting the pointer never removes it. It tells every agent, not only Simple
Changes runs, to keep scratch files, captured command output, proof bundles,
and handoff notes in one scratch folder of its own, never inside or next to a
checkout: the folder its brief names, the work directory a Simple Changes run
reports, or a new folder it creates under the session's scratch directory or
the system temporary directory. An agent that starts another agent gives it a
folder of its own and names it in the brief, and when the task ends it deletes
exactly its own folder, never another agent's and never by pattern across a
shared directory, unless the user asks to keep it or a Simple Changes run
reported it, which the run's clean finalization removes. Offer **Add the rule**
first and **Leave it out** second. Non-interactive setup adds it only with
`--scratch-file-rule add`; omitting the flag leaves the file as it is, and
adding the rule needs exactly one target. The markers never change, so
`initialize` reports a block an earlier release wrote as `stale`, and
`scratch-file-rule refresh`, or setup run again, rewrites it in place.

Then offer the optional review-loop rule for the same file, in its own
`<!-- simple-changes:review-loop:start -->` and `:end -->` markers. It applies
only to reviews in Simple Changes runs and names no agent or model: review in
rounds at the exact head with the reviewer, efforts, and limits from the
authoring preferences; have the reviewer grade findings blocking, should-fix,
or nit; review the fixes and what they touched, then one full review at the
final head before merge; pass on findings the user deferred or accepted; and
question the approach or ask the user when `initialize` says the convergence
check is due or the round cap is reached (see
[review rounds](review-and-merge.md#review-rounds)). Declining it changes
nothing, and Simple Changes still applies the review settings in its own runs.
Offer **Add the rule** first and **Leave it out** second; non-interactive
setup adds it only with `--review-loop-rule add`, and
`review-loop-rule refresh` rewrites a `stale` copy in place.

The confirmation summary must
show the exact target path and each proposed managed block. Apply an authorized edit
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
  --scratch-file-rule add \
  --review-loop-rule add \
  --yes
```

For `--finish ship`, also supply `--production ask|allow|deny`; use
`--shipping-mode standard|expedited` when automation must select the routine
shipping order explicitly.
For a task that will save multiple UI artifact iterations, also supply
`--ui-artifacts` and
`--ui-versioning repository|number-and-date|date-only|number-only`.
When a run will author multiple independent proposals, supply
`--proposal-scheduling balanced|consecutive|parallel` to select the saved
scheduling preference.
`SIMPLE_CHANGES_CONFIG_DIR` may override the personal configuration root for
isolated automation and tests.

## Completed-work handoff checkpoint

An automatic or confirmation-based instruction pointer starts with:

```sh
simple-changes initialize --mode handoff --agent-id "$AGENT_ID" --json
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
are **Ready, hand it off** and **More changes first**.

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

## Authoring preferences

An optional sidecar records which agent and model write proposal text
(`proposals`) and perform reviews (`review`):
`<primary-checkout>/.simple-changes-authoring.json` for the repository, or
`authoring.json` beside the personal `preferences.json`. It is committed shared
configuration like `.simple-changes.json`; until committed it is ordinary
untracked work. It never joins the policy file, whose closed schema older
copies enforce, so they ignore it and write with the running model. Repository
scope writes the repository file, personal scope the personal file, run-only
nothing; `setup --authoring <json-or-@path> --scope <repository|personal>
--confirm` records an answer without touching the policy. A write holds
`<sidecar>.lock` beside the file and refuses while another write holds it,
naming its process; if that process has exited, the owner removes the lock.
A sidecar that changes while an answer is being written is never replaced.

```json
{
  "schemaVersion": 1,
  "roles": {
    "proposals": { "harness": "running" },
    "review": { "harness": "<agent id>", "adversarial": true, "escalateOnFindings": "xhigh" }
  },
  "harnesses": { "<agent id>": { "model": "most-capable", "effort": "xhigh" } }
}
```

Precedence, highest first: the current request, the repository sidecar, the
personal sidecar, then the running agent's most capable model at `xhigh`.
The current request reaches the CLI as `--authoring-request <json-or-@path>`
(a complete sidecar object) on `initialize`, `proposal record-review`, and
`loop start --mode resume`: validated like a file, applied to that invocation,
never written, never an answer. It replaces roles and agent entries like any
layer, except that `review.adversarial`, `review.escalateOnFindings`, and
`review.reviewLoop` combine with the saved result by the stricter value, so a
request tightens the review gate and never loosens it; pass the same request
to every one of those commands in a run. Roles and agent entries replace whole; an empty
sidecar answers the models question and defines nothing; a role-level
`model` needs an agent id, never `running`; `null` means "do not guide this
agent". `initialize` reports `authoring.effective` with each field's layer
(`request`, `repository`, `personal`, or `default`) in `authoring.source`,
and the `reviewer` it resolves. A reviewer `model` of `most-capable` is resolved from
what the target agent reports before dispatch; if that is impossible, treat
the reviewer as unresolved and ask the owner. `max` effort comes only from an explicit owner choice
and is never reached by a default, `most-capable`, or escalation.

The review role may also carry `reviewLoop`, whose fields are all optional and
default to the recommended loop: `escalateOn` (`blocking-or-should-fix`, or
`any` to escalate on nits too), `convergenceRounds` (consecutive rounds with
escalating findings before the approach is questioned, 1 to 10, default 2, or
`null` for no check), and `roundCap` (rounds after the first escalating
finding without a clean review before the owner is asked, 1 to 20, default 4,
or `null` for no cap). For the stricter value, `any` beats
`blocking-or-should-fix` and a smaller number beats a larger one or `null`.
Runtimes before 0.31.0 reject a sidecar holding `reviewLoop`, so it is written
only for answers other than the recommended ones. See
[review rounds](review-and-merge.md#review-rounds).

Before writing, resolve the role; `most-capable` is the most capable model the
target agent itself reports, never ranked from memory. Use the nearest effort
the target offers, never above the configured level. Write directly when the
target agent and model are the running ones and the effort matches or cannot
be changed; otherwise delegate only through a mechanism the running agent
already has, asking before the first launch of another tool in a session.
Keep the requested target and the identity the delegate reports apart; a
mismatch is disclosed and signed with the reported identity, and for a review
goes through the post-return gate in `references/review-and-merge.md`. When the target is
`unknown` or `null`, the model cannot be resolved, or nothing can delegate,
write with the running model and say which role was configured, what wrote
instead, and why. Signatures always name the writer the runtime reported. The
sidecar is a preference, never authority or identity: it grants no merge,
push, deployment, migration, publication, release, or credential authority and
stores no credentials or launch commands.
