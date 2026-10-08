---
name: simple-changes
description: Use when a user asks to sync with remote main, package, queue, publish, integrate, review, merge, ship, reconcile, or clean local Git changes, branches, worktrees, proposals, or deployments. Preserve concurrent work, create focused proposals, satisfy checks and review, merge current approved heads, verify authorized deployment, and reconcile proven cleanup. Do not use to author changelogs or release notes directly, for non-Git synchronization, or for read-only code review.
license: Apache-2.0
compatibility: Requires Git and Bun 1.2 or later
metadata:
  version: "0.27.1"
---

# Simple Changes

Contents:

- Create a repository-specific fork
- Classify the request
- Initialize before mutation
- Communicate in plain language
- Communicate Ship scope
- Check for already-shipped work
- Hold one controller lease
- Shipment holds
- Completed-work handoff
- Core workflow
- Authority and invariants
- Reference router
- Reports

Turn ready repository work into focused, verified proposals without disturbing
active work. Requires Git for repository work; deterministic helpers require
Bun 1.2 or later. In commands below, `simple-changes` means
`bun <skill-root>/scripts/simple-changes.ts` (or an installed `simple-changes`
bin); use the same invocation everywhere.

## Create a repository-specific fork

Use repository policy and instructions for supported preferences and project
context. For behavior that requires changing the skill, run
`simple-changes fork create --name <project>-simple-changes --deltas "<intended custom behavior>"`
from the owning repository. This copies the complete installed skill into
`.agents/skills/<project>-simple-changes`, verifies and records its upstream
commit, and refuses existing destinations. The copy's description starts with
its name and tells agents to use it instead of the global `simple-changes`
skill in that repository, and its Codex metadata invokes the fork; keep both
when customizing. It does not change the global install or commit the new
copy. Use `--destination` for another path inside the repository and
`--upstream` for an offline source checkout.
Customize and verify the fork, including the fork runtime's own
`simple-changes skill check`, then use `update-local-forks` for future updates.

## Classify the request

| Intent | Mode | Boundary |
| --- | --- | --- |
| Sync or pull latest | Sync | Guarded local update; never push |
| Put this up | Queue | Open proposals; do not merge |
| Open everything ready | Sweep | Queue every ready unit |
| Merge ready work | Integrate | Merge eligible current heads |
| Ship ready work | Ship | Integrate, release, deploy, verify |
| Clean the repo | Reconcile | Integrate/report, then proven cleanup |
| Show a plan | Preview | Read-only |
| Again or continue | Resume | Reconstruct from fresh evidence |
| Leave a checkout alone | Pause | Preserve it |

Urgency can infer `expedited`; it never grants production authority or waives
independent review. Saved break-glass plus automatic production means “Ship” is
enough for the documented rollback-protected ordering. A bare Sync request
authorizes exact-target fetch and a guarded local update only. Queue does not
mean report-only: maintain an outstanding-work ledger for every discovered
stable unit, including clean branches and separate worktrees.

## Initialize before mutation

Run `simple-changes initialize --mode <mode> [--changelog-required] --json`
before every write-capable mutation or controller lease. The JSON result is not
user-facing onboarding copy. When onboarding is required, explain the workflow,
then follow [onboarding](references/onboarding.md): ask one question at a time,
show every option with its one-sentence consequence, and use that reference's
exact option copy. When private global personal defaults already exist,
disclose them before the main questions and ask whether to use them unchanged
for this run.

When compatible Simple Changelogs is installed, default changelog handling to
**Delegate when available**. When changelog work is relevant but the skill is
not installed or compatible, offer installation and setup timing per
[onboarding](references/onboarding.md); never install it silently, and
installation grants no version, release, publication, deployment, or
data-write authority.

Resolve installed update choices before acquiring a loop. When changelog work
is required, resolve the Simple Changelogs notice and the user's
owner-controlled walkthrough, continue, defer, or release-notes choice before
`loop start`. Do not start a Ship loop, send the pre-ship brief, acquire a
lease, then pause it for this explanation. Continue only after initialization
returns `preLoopActionRequired: false`. Present update notices per
[installed guidance updates](references/guidance-updates.md). Repository policy
that grants push, automatic migration, break-glass, or production authority is
effective only with the private digest-bound local trust receipt described in
[setup and policy](references/setup-and-policy.md); a repository policy symlink
is unsafe.

When initialization reports `turnEndGuard` as not installed or outdated, offer
once to install it with its `installCommand` when it has one: a harness Stop hook that blocks
ending a turn while this session still controls an active run. It is persistent
harness configuration, so ask first; declining changes nothing. When it has no
`installCommand`, as from a fork with no current global install, tell the user
to install the guard from the globally installed Simple Changes. When it reports
`runtimeFreshness` as `behind-target`, you are running an older copy of this
runtime than the target branch carries; run the target's copy, or update the
checkout, before integrating or shipping. See
[cleanup and completion](references/cleanup-and-completion.md#turn-end-guard).

## Communicate in plain language

Default every user-facing message to plain language, even when the underlying
workflow is technical. Lead with what happened, what it means for the user, and
what happens next. Keep most progress updates to one to three short sentences.
Do not lead with internal terms such as controller, lease, ledger, digest,
relinquished, target-contained, or mutation path. Translate them into ordinary
language first.

Include exact revisions, paths, commands, provider identities, or durable state
names when they affect safety, authority, verification, or the user's next
decision, but place them after the simple explanation. Expand into full
technical detail when the user asks. Never expose raw machine output or internal
bookkeeping as the explanation itself. Follow
[plain-language communication](references/user-communication.md).

## Communicate Ship scope

After initialization and planning, but before the first consequential Ship
mutation, send a concise pre-ship brief in the same assistant turn. State scope,
checks, proposal/merge/release/deploy path, consequential boundaries, and
preserved work. Explain that this is an interruption window rather than a
permission gate when existing authority already covers the run. Follow
[ship communication](references/ship-communication.md).
A clean Ship start automatically records a non-mutating empty opening scope
under the existing integration and coordination locks. Its empty units do not
prove delivery: committed-source and release-generated target changes must still
be accounted for in the exact outcome's `additionalPaths`, including rename
originals, removals, and tree entries. It does not retroactively repair old runs.
When a Ship run opens with any local changes, generate one non-mutating preview
plan from the current inventory, record it with
`loop record-scope --receipt <change-plan.json>`, and present the returned
pre-ship scope before any `loop guard` or `loop exec`. Unrelated changes since
`loop start`, such as a claimed author's edits, are accounted for in that plan;
a moved target, changed policy, failing verification, or a changed controller or
scoped source worktree still blocks it. A worktree marked
`preserved` in the safety lease is protected from deletion; that label never
excludes its finished changes from shipment scope by itself. If independent
review requires source changes, record a fresh preview with
`loop refresh-scope` before another mutation; see
[inventory and concurrency](references/inventory-and-concurrency.md).
When permission is still required, inventory every unresolved boundary already
knowable from the validated plan and present them together in one exact-target
checklist. Let the user approve all, decline all, or approve named items in one
reply. Never stretch that bundle to unknown future actions; ask again only for
a newly discovered boundary or invalidated target.

## Check for already-shipped work

Before creating a worktree, rebasing, cherry-picking, or merging an old local
branch, run `simple-changes branch audit --head <branch> --target <ref> --json`
against the refreshed target. A unique SHA or a missing MR on that branch name
does not establish unshipped work. Resolve replacement candidates against merged
proposals and independent review first; follow
[replacement lineage](references/replacement-lineage.md). Record original SHAs
in replacement commits when moving work to a different branch. Discovery hints
never permit deletion or waive the existing cleanup proofs.

## Hold one controller lease

For Queue, Sweep, Integrate, Ship, Reconcile, and Resume, start one active loop
only after initialization returns `preLoopActionRequired: false`. Start the
loop before the first integration mutation and retain its run ID. A second
controller is rejected; independent authors use distinct claimed worktrees.
When the target is GitLab, first paginate the complete opening remote inventory
(every branch and every open, merged, and closed proposal), then pass that
unchanged receipt through `loop start --opening-remote-inventory <file>`. A
legacy GitLab run without this evidence is close-only; see
[cleanup and completion](references/cleanup-and-completion.md).

When an active loop assigns a new author into that same integration unit, run
`simple-changes prepare-agent` before edits. Independent agents create an
isolated worktree and immediately run `worktree claim`. A claim is the lock:
while it is active, no controller packages, merges, or cleans that checkout.
When the work is complete and verified, the same owner unlocks it with
`worktree release`, or with `initialize --mode handoff`, which releases the
author's own claim on that checkout as it proceeds; released work becomes an
ordinary stable unit that this or any later controller may ship. After registration,
both run-prepared and independently claimed authors edit, generate, format,
test, stage, and commit normally and concurrently in their own distinct
worktrees and branches; those author-local operations do not use the global
controller lock. Run only shared integration mutations through `loop exec`,
including target movement, integration merges or cherry-picks, pushes,
worktree/branch lifecycle changes, and cleanup. Use `loop guard` only for
external provider calls and verify immediately afterward. Before merge,
deployment, cleanup, and completion, run `loop verify`; immediately before a
merge, deployment, or migration, add `--for merge`, `--for deploy`, or `--for
migrations` so [shipment holds](#shipment-holds) gate that step. When it
fails, resolve exactly what it reports and run it again; proceed only on a
passing result.
After review and integration settle, record one exact
`loop record-outcome --receipt <shipment-outcome.json>` receipt before
completion; see [focused units](references/focused-units.md). This controller
audit step is not another user decision.

When scheduling allows parallel authoring and the host can start isolated
agents, delegate independent units instead of authoring them one after
another: the controller prepares every agent's worktree with `prepare-agent`
under a new agent ID, each agent edits and checks only inside its own, and the
controller alone pushes, merges, and finalizes. Follow
[parallel agents](references/inventory-and-concurrency.md#parallel-agents).

A busy lock blocks only the named short integration operation; it is never a
reason to pause unrelated authors, demand a lease-null handback, export patches,
or clean their worktrees. A permission-denied error while creating controller
state is a harness/filesystem permission problem, not lock contention: preserve
work in place, fix that exact permission boundary, and keep unrelated authoring
active.

When completed, verified work is ready but another task already owns the active
shipping controller, preserve its exact worktree, branch, commit, checks,
release impact, and constraints instead of starting a second shipment. Ask:
**Do you want me to ask that agent to fold this work into the active shipment,
or should I wait until that shipment finishes and ship this separately
afterward?** Do not contact the other task until the user chooses the first
option. If approved, record the receipt with `worktree release --ready-receipt
<file>`; the active controller reads it without a message. The receipt requests
integration but grants no ownership, merge, deploy, migration, or cleanup
authority. If the user chooses the second option, leave the work untouched and
wait for the active shipment to close.

Claims allow healthy concurrent-author edits without pausing. A strict collision
requires an exact owner claim/pause exchange. Retain a clean unrelated checkout
rather than removing it. An unchanged clean opening checkout is automatically
removed at finalization when it is unclaimed, unretained, and its exact head is
already contained in the refreshed target. For changed opening work that later
becomes obsolete, use `loop dispose-worktree` only after proving it clean with
zero unique commits. When a preserved checkout, including one registered by
`loop rebaseline`, has been removed by its owning task, record that absence with
`loop retire-absent-worktree` on named approval; it requires the path to be gone
from disk and from Git's worktree list, deletes nothing, and proves no delivery.

Remote fetch and push URLs are lease-bound. A destination change invalidates
the loop; re-verify repository ownership and start a new lease.
`configure-harness` requests only the narrowest verified repository-scoped push
rule; see
[harness-aware push authorization](references/harness-push-authorization.md).

The lock records process-group evidence. If recovery is proven safe, use `loop
recover --agent-id "$AGENT_ID"`; never delete state by hand. Before every
terminal assistant response after a loop has started, including a blocked or
failed handoff, run `loop finalize --reason "<why the turn ends>" --json`, then
`loop status --json` and verify
that your controller is released or relinquished. When the turn ends on a
question the run needs answered, such as a migration, deployment, or cleanup
approval, add `--awaiting-user "<question>"` once per question: the run pauses,
records the questions, exits zero, and resumes with `loop start --mode resume`
after the answer. A nonzero exit alone does not
prove release; if state cannot be written, report that exact blocker. Finalization
performs the proven-safe cleanup described in
[cleanup and completion](references/cleanup-and-completion.md) and releases
completed state. An exact verified shipment can close while unrelated work
remains preserved; its durable finalization receipt reports delivery and cleanup
separately. If delivery or safety blockers remain, it relinquishes durable state
and exits nonzero. The exception is an untouched Ship run, one that owed a
scope, recorded none, and changed nothing: finalization closes it instead of
freezing its scope, so ending a turn on a scope question never strands it.
`loop end` closes it the same way; then start a fresh loop for a new baseline. Resume a relinquished run with `loop start --mode resume`;
takeover approval is only needed to replace an active controller.
Takeover requires the exact current run ID and manifest digest plus approver and reason.

If an older relinquished run already finished cleanup but lacks opening remote
evidence, never relabel later observations as its opening inventory; use the
explicitly approved `loop recover-post-cleanup` path in
[cleanup and completion](references/cleanup-and-completion.md). For other
inherited broken state, the same reference defines the authorized recovery
paths: `worktree takeover` for a claim whose owner no longer exists,
read-only `worktree equivalence` for patch/byte containment evidence with
advisory residue hints, `loop close-equivalent` to close a relinquished or
frozen-scope loop whose work is already contained in the target, `loop
rebaseline` to register worktrees that appeared after loop start as preserved
and untouched when a stale opening manifest deadlocks a run, and `worktree
cleanup` for one audited standalone pass when no loop record exists. A
target-equivalent close is never reported as shipped. `loop status` names the
exact next recoverable command for whatever state it finds and reports lease
liveness (`live`, `stale`, or `unknown`), and `worktree refresh-index`
re-syncs cached editor and desktop worktree views from the authoritative Git
inventory.

Cleanup is not tied to finalization. When work is merged but no loop will
finalize it, run `prune --approved-by "$USER" --reason "$WHY"` (add
`--dry-run` to see the plan first): it applies the same proven-safe audit
without a lease, naming the containment method for every removal, and defers
anything registered by an open lease to that run's controller. A stale heartbeat
or released author claim never authorizes removing its registrations. Use the
controller's audited removal path or wait for closure; never bypass this with
raw Git removal or filesystem deletion. When a lease
itself is stale, `loop recover --stale-lease --run-id "$RUN_ID" --agent-id
"$AGENT_ID" --approved-by "$USER" --reason "$WHY"` clears the bookkeeping
record on explicit user authority while preserving every worktree and receipt.
Reuse session authority that already covers this recovery. A dead helper PID or
old heartbeat alone does not establish that the owning agent has stopped.

Follow [inventory and concurrency](references/inventory-and-concurrency.md).

## Shipment holds

Agents in different harnesses coordinate shipments through the shared
coordination directory without messaging each other. A finished author records
its handoff with `worktree release --ready-receipt <file>`; controllers read
every receipt and its freshness in `worktree status --json`. Any agent whose
task could break, or be broken by, the next merge, deployment, or migration
records a hold with `hold add --hold-scope ship|deploy|migrations --severity
delay|halt --reason <why>`, optionally `--until-merged <branch>`, and releases
it the moment the reason ends; `hold publish` shares one with clones elsewhere.
Release another agent's hold only with the user's explicit approval, adding
`--override-halt` for a halt. For a blocking `delay`, ask:
**<owner> asked to delay <step> because <reason>. Should I wait, or continue
without it?** Record approval with `hold waive`. Waive a `halt` only when the
user explicitly approves overriding that exact hold. Follow
[ready-work receipts](references/inventory-and-concurrency.md#ready-work-receipts)
and [shipment holds](references/inventory-and-concurrency.md#shipment-holds).

## Completed-work handoff

For an instruction-pointer handoff, run:

```sh
simple-changes initialize \
  --mode handoff \
  --agent-id "$AGENT_ID" \
  --json
```

If confirmation is required, ask: **The implementation and checks are complete.
Is this ready for Simple Changes, or do you want more changes first?** Continue
only when `mutationAllowed` is true. Do not invoke it after planning, diagnosis,
read-only work, or incomplete verification.

## Core workflow

1. Read repository instructions and [setup and policy](references/setup-and-policy.md).
2. Initialize, resolve companion notices, capture the canonical primary
   checkout, capture the complete GitLab opening remote inventory when
   applicable, then start the required controller lease with that evidence.
3. Refresh the intended target before diff-derived decisions. Preserve dirty,
   conflicted, detached, mid-operation, active, and unclaimed state. Inventory
   hashes changed regular files in bounded chunks and records special files
   without reading FIFOs, sockets, or devices.
4. Group stable work by outcome, dependency, data boundary, ownership, and
   parity. For work that can affect separately released installed clients,
   record the installed-client compatibility result from
   [high-risk actions](references/migrations-and-high-risk-actions.md). Every
   path belongs to one unit or an explicit preserved set.
5. Run proportionate repository-native checks and distinguish introduced from
   pre-existing failures; fix what an introduced failure reports and re-run
   the checks until they pass.
6. Coordinate changelog ownership without authoring release text. Negotiate
   supported versions and features from the provider's declared marker when
   present (inferred discovery is reported as inferred), and accept only
   current locally validated receipts.
7. Create/update neutral proposals in the summary, evidence, and merge-danger
   body shape from [change proposals](references/change-requests.md#body-shape),
   with real Markdown newlines; re-read stored source/rendering, resolve
   checks/discussions/review, and merge only the exact approved head. Under the
   default `proposalSignatures` policy, the agent
   that authors, reviews, or merges a proposal appends its model name and
   version to the proposal's signature block; see
   [change proposals](references/change-requests.md).
8. Audit every detected migration before any apply. Apply only through
   `simple-changes migration decision` and `simple-changes migration apply`
   with the closed evidence described in
   [high-risk actions](references/migrations-and-high-risk-actions.md). Broad
   apply-all, stale, replayed, target-mismatched, or command-changed plans
   require new review/authority. Do not apply a migration while installed-client
   compatibility is `incompatible` or `unverified`.
9. Treat every production Web deployment as a product release. Prepare release
   reconciliation, refresh the canonical remote target branch (normally
   `main`), require a read-only `verified` receipt, and deploy only that exact
   finalized target. Verify the live deployment observes the same revision,
   even when no deployment was created during this run. A Ship or resumed Ship
   loop is incomplete when the live revision differs from the latest canonical
   target revision. When the receipt names a release tag, run `release-tag
   --dry-run` before the release merge, publish it with `release-tag` before
   any deployment, and require `already-present` at final verification, even
   with no deployment; see
   [release tags](references/changelog-coordination.md#release-tags).
10. Run final local/provider inventory and clean only proven objects. A dirty
    primary requires classification before completion. Finalization safely normalizes tracked target-identical paths;
    classify every remaining path against the refreshed target, ship genuine
    newer work, and prune proven obsolete or generated entries. For a target
    GitLab remote, complete the remote-branch reconciliation gate across every
    paginated branch before completion. Delete proven-obsolete remote branches
    only after exact evidence; preserve uncertainty.
11. Restore the exact original primary checkout clean at the refreshed target,
    retain exact authorized exclusions, verify again, and finalize the lease.
    Finalization automatically removes proven safe worktrees, stale metadata,
    and merged local branches. An exact verified shipment may close with an
    unchanged primary explicitly preserved in its scope, an unchanged primary
    whose scoped dirty paths shipped as reviewed results now in the target, or
    unrelated late arrivals. Report pending cleanup separately and use guarded `prune` when
    safe; do not keep a delivered shipment open solely for that housekeeping.

For Ship, Integrate, and Reconcile, carry these steps as a checklist in the
reply: list them once in plain language, tick a step only after its evidence
exists, and leave a failed step unticked. Fix what the failure reports and run
that step again until it passes. When the fix changed source, return to step 4
(in Ship, record the fresh preview with `loop refresh-scope`); when the
target, policy, controller checkout, or a scoped source worktree changed,
return to step 3. Other modes follow the same order without the written
checklist.

## Authority and invariants

Current user direction outranks repository and personal policy. Discovery is
not authority. Never invent remote, deployment, migration, credential, or
provider facts. Never use destructive reset, cleanup stash, force deletion,
force push, protection bypass, or secret export without exact authority.
Authoring and review model preferences guide delegation only.

Public release versioning and release-note authorship belong to a compatible
changelog owner. Database automatic modes apply only to the exact saved
provider/project/environment target and exclude destructive or data-deleting,
irreversible, unbounded, lock-heavy, target-mismatched, or unprotected changes.
An installed-client compatibility finding of `incompatible` or `unverified`
blocks the affected migration, API, backend, or production deployment. A new
client release alone does not make a breaking rollout safe because older
binaries may remain installed.

Create or push a Git tag only through `release-tag`, and only the tag a
verified receipt names, under the release's existing approval and reviewed tag
automation, to the run's own single-URL target remote. Never move, replace,
or delete a tag, and never tag from Sync or as a delegated author.

GitLab cleanup is required only when the selected target remote is GitLab, not
merely because an auxiliary GitLab remote exists.

## Reference router

Read the references needed for the active mode:

- [setup and policy](references/setup-and-policy.md)
- [onboarding](references/onboarding.md)
- [installed guidance updates](references/guidance-updates.md)
- [harness-aware push authorization](references/harness-push-authorization.md)
- [plain-language communication](references/user-communication.md)
- [sync](references/sync.md)
- [inventory and concurrency](references/inventory-and-concurrency.md)
- [focused units](references/focused-units.md)
- [surface parity](references/surface-parity.md)
- [verification](references/verification.md)
- [changelog coordination](references/changelog-coordination.md)
- [change proposals](references/change-requests.md)
- [review and merge](references/review-and-merge.md)
- [data changes](references/data-changes.md)
- [high-risk actions](references/migrations-and-high-risk-actions.md)
- [deployments](references/deployments.md)
- [ship communication](references/ship-communication.md)
- [cleanup and completion](references/cleanup-and-completion.md)
- [fork maintenance](references/fork-maintenance.md)

Read the matching provider reference only after provider discovery. Unsupported
capabilities are blockers, never guessed success.

## Reports

Report queued, merged, deployed, preserved, and blocked items separately. Queue
must include **Outstanding work** for every omitted discovered unit, including
its location, current revision/state, why it was deferred, and the next action;
it may not silently omit it. For GitLab reconciliation, report every disposition
and every preserved uncertain branch. When the installed-client gate applies,
report `Installed-client compatibility: <state> (<evidence and reason>)` and
name any required client release or phased rollout. A Ship receipt opens by
naming the actual shipped change in plain language, what is different now and
for whom, before merge, check, and deployment evidence, even when no changelog
entry was written. For Ship, compare the pre-ship brief with
the result and report review-driven changes or explicitly state none. Never
claim completion until final inventory proves requested scope and primary state.
When Ship finalizes or reconciles a public release, end with concise **Latest
customer notes** sourced from that exact version's public release notes; omit
them for preview-only, internal-only, or `release:none` work. Follow
[plain-language communication](references/user-communication.md) for the
version-binding, blockquote presentation, and content rules.

Preview may run `simple-changes preview` and must create no branch, commit,
stash, ledger, proposal, or deployment.


For a frozen shipment whose scope cannot cover later work, use the explicitly
approved, owner-bound [replan recovery](references/cleanup-and-completion.md#replan-a-frozen-shipment-without-cleanup).
It archives the old run without cleanup; fresh inventory and normal authority
checks still govern the next shipment. A run that already recorded its shipment
outcome but cannot finish uses the same approval through
[`loop archive-recorded`](references/cleanup-and-completion.md#archive-a-recorded-run-that-cannot-finish),
whose `archived-unfinished` result is never reported as shipped.
