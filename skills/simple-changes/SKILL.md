---
name: simple-changes
description: Use when a user asks to sync with remote main, package, queue, publish, integrate, review, merge, ship, reconcile, or clean local Git changes, branches, worktrees, proposals, or deployments. Preserve concurrent work, create focused proposals, satisfy checks and review, merge current approved heads, verify authorized deployment, and reconcile proven cleanup. Do not use to author changelogs or release notes directly, for non-Git synchronization, or for read-only code review.
---

# Simple Changes

Turn ready repository work into focused, verified proposals without disturbing
active work. Requires Git for repository work; deterministic helpers require
Bun 1.2 or later. In commands below, `simple-changes` means
`bun <skill-root>/scripts/simple-changes.ts` (or an installed `simple-changes`
bin); use the same invocation everywhere.

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
When a Ship run opens with any local changes, generate one non-mutating preview
plan from that unchanged opening inventory, record it with
`loop record-scope --receipt <change-plan.json>`, and present the returned
pre-ship scope before any `loop guard` or `loop exec`. A worktree marked
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
deployment, cleanup, and completion, run `loop verify`.
After review and integration settle, record one exact
`loop record-outcome --receipt <shipment-outcome.json>` receipt before
completion; see [focused units](references/focused-units.md). This controller
audit step is not another user decision.

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
option. If approved, send an exact ready-work receipt; that receipt requests
integration but grants no ownership, merge, deploy, migration, or cleanup
authority. If the user chooses the second option, leave the work untouched and
wait for the active shipment to close.

Claims allow healthy concurrent-author edits without pausing. A strict collision
requires an exact owner claim/pause exchange. Retain a clean unrelated checkout
rather than removing it. An unchanged clean opening checkout is automatically
removed at finalization when it is unclaimed, unretained, and its exact head is
already contained in the refreshed target. For changed opening work that later
becomes obsolete, use `loop dispose-worktree` only after proving it clean with
zero unique commits.

Remote fetch and push URLs are lease-bound. A destination change invalidates
the loop; re-verify repository ownership and start a new lease.
`configure-harness` requests only the narrowest verified repository-scoped push
rule; see
[harness-aware push authorization](references/harness-push-authorization.md).

The lock records process-group evidence. If recovery is proven safe, use `loop
recover --agent-id "$AGENT_ID"`; never delete state by hand. Before every
terminal assistant response after a loop has started, run `loop finalize`. It
performs the proven-safe cleanup described in
[cleanup and completion](references/cleanup-and-completion.md) and releases
completed state. An exact verified shipment can close while unrelated work
remains preserved; its durable finalization receipt reports delivery and cleanup
separately. If delivery or safety blockers remain, it relinquishes durable state
and exits nonzero. Resume a relinquished run with `loop start --mode resume`;
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
without a lease, naming the containment method for every removal, and refuses
to touch anything a lease that is not provably stale registers. When a lease
itself is stale, `loop recover --stale-lease --run-id "$RUN_ID" --agent-id
"$AGENT_ID" --approved-by "$USER" --reason "$WHY"` clears the bookkeeping
record on explicit user authority while preserving every worktree and receipt.

Follow [inventory and concurrency](references/inventory-and-concurrency.md).

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
   pre-existing failures.
6. Coordinate changelog ownership without authoring release text. Negotiate
   supported versions and features from the provider's declared marker when
   present (inferred discovery is reported as inferred), and accept only
   current locally validated receipts.
7. Create/update neutral proposals with real Markdown newlines, re-read stored
   source/rendering, resolve checks/discussions/review, and merge only the exact
   approved head. Under the default `proposalSignatures` policy, the agent
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
   target revision.
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
    unchanged primary explicitly preserved in its scope, or unrelated late
    arrivals. Report pending cleanup separately and use guarded `prune` when
    safe; do not keep a delivered shipment open solely for that housekeeping.

## Authority and invariants

Current user direction outranks repository and personal policy. Discovery is
not authority. Never invent remote, deployment, migration, credential, or
provider facts. Never use destructive reset, cleanup stash, force deletion,
force push, protection bypass, or secret export without exact authority.

Public release versioning and release-note authorship belong to a compatible
changelog owner. Database automatic modes apply only to the exact saved
provider/project/environment target and exclude destructive or data-deleting,
irreversible, unbounded, lock-heavy, target-mismatched, or unprotected changes.
An installed-client compatibility finding of `incompatible` or `unverified`
blocks the affected migration, API, backend, or production deployment. A new
client release alone does not make a breaking rollout safe because older
binaries may remain installed.

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
