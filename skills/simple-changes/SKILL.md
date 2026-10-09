---
name: simple-changes
description: Use when a user asks to sync with remote main, package, queue, publish, integrate, review, merge, ship, reconcile, or clean local Git changes, branches, worktrees, proposals, or deployments. Preserve concurrent work, create focused proposals, satisfy checks and review, merge current approved heads, verify authorized deployment, and reconcile proven cleanup. Do not use to author changelogs or release notes directly, for non-Git synchronization, or for read-only code review.
license: Apache-2.0
compatibility: Requires Git and Bun 1.2 or later
metadata:
  version: "0.28.0"
---

# Simple Changes

Turn ready repository work into focused, verified proposals without disturbing
active work. In commands below, `simple-changes` means
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

## Authority and invariants

Current user direction outranks repository and personal policy. Discovery is
not authority. Never invent remote, deployment, migration, credential, or
provider facts. Never use destructive reset, cleanup stash, force deletion,
force push, protection bypass, or secret export without exact authority.
Authoring and review model preferences guide delegation only.
Never delete loop or coordination state by hand.

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

## Reference router

- **Setup:** [setup and policy](references/setup-and-policy.md),
  [onboarding](references/onboarding.md),
  [installed guidance updates](references/guidance-updates.md), and
  [harness-aware push authorization](references/harness-push-authorization.md).
- **Messages:** [plain-language communication](references/user-communication.md)
  and, for Ship, [ship communication](references/ship-communication.md).
- **Sync:** [sync](references/sync.md).
- **Loops and authors:** [inventory and concurrency](references/inventory-and-concurrency.md),
  [focused units](references/focused-units.md),
  [surface parity](references/surface-parity.md),
  [verification](references/verification.md), and
  [replacement lineage](references/replacement-lineage.md).
- **Proposals and releases:** [change proposals](references/change-requests.md),
  [review and merge](references/review-and-merge.md), and
  [changelog coordination](references/changelog-coordination.md).
- **Data and production:** [data changes](references/data-changes.md),
  [high-risk actions](references/migrations-and-high-risk-actions.md), and
  [deployments](references/deployments.md).
- **Finishing:** [cleanup and completion](references/cleanup-and-completion.md).
- **Recovery:** when `loop status`, `loop verify`, or finalization reports a
  blocker, a stale, relinquished, or frozen run, a released or orphaned claim,
  or a missing, late, or changed worktree; when merged work or orphaned
  worktrees have no loop to clean them up; or when an editor's or desktop app's
  worktree list is stale, read [recovery](references/recovery.md) before acting.
- **Forks:** for behavior that requires changing the skill, follow
  [fork maintenance](references/fork-maintenance.md).
- **Providers, only after provider discovery:** [GitHub](references/providers/github.md),
  [GitLab](references/providers/gitlab.md),
  [Bitbucket](references/providers/bitbucket.md),
  [Azure DevOps](references/providers/azure-devops.md),
  [Radicle](references/providers/radicle.md),
  [origin](references/providers/origin.md),
  [Vercel](references/providers/vercel.md),
  [Cloudflare](references/providers/cloudflare.md),
  [Fly](references/providers/fly.md), and
  [Railway](references/providers/railway.md).
  Unsupported capabilities are blockers, never guessed success.

## Initialize before mutation

Run `simple-changes initialize --mode <mode> [--changelog-required] --json`
before every write-capable mutation or controller lease. The JSON result is not
user-facing onboarding copy. When onboarding is required, explain the workflow,
then follow [onboarding](references/onboarding.md): ask one question at a time,
show every option with its one-sentence consequence, and use that reference's
exact option copy. When private global personal defaults already exist,
disclose them before the main questions and ask whether to use them unchanged
for this run.

When changelog work is required, resolve the Simple Changelogs notice and the user's
owner-controlled walkthrough, continue, defer, or release-notes choice before
`loop start`. Do not start a Ship loop, send the pre-ship brief, acquire a
lease, then pause it for this explanation. Continue only after initialization
returns `preLoopActionRequired: false`. Present update notices per
[installed guidance updates](references/guidance-updates.md). Repository policy that grants push,
automatic migration, break-glass, or production authority is effective only
with the private digest-bound local trust receipt described in
[setup and policy](references/setup-and-policy.md); a repository policy symlink
is unsafe.

When initialization reports `turnEndGuard` as not installed or outdated, offer
once to install it with its `installCommand` when it has one: a harness Stop hook that blocks
ending a turn while this session still controls an active run. It is persistent
harness configuration, so ask first; declining changes nothing. When it reports
`runtimeFreshness` as `behind-target`, run the target branch's newer copy, or
update the checkout, before integrating or shipping.

## Communicate

Default every user-facing message to plain language, even when the underlying
workflow is technical. Lead with what happened, what it means for the user, and
what happens next. Keep most progress updates to one to three short sentences.

After initialization and planning, but before the first consequential Ship
mutation, send a concise pre-ship brief in the same assistant turn. State scope,
checks, proposal/merge/release/deploy path, consequential boundaries, and
preserved work. Explain that this is an interruption window rather than a
permission gate when existing authority already covers the run.
When a Ship run opens with any local changes, generate one non-mutating preview
plan from the current inventory, record it with
`loop record-scope --receipt <change-plan.json>`, and present the returned
pre-ship scope before any `loop guard` or `loop exec`.
When permission is still required, inventory every unresolved boundary already
knowable from the validated plan and present them together in one exact-target
checklist. Let the user approve all, decline all, or approve named items in one
reply. Never stretch that bundle to unknown future actions; ask again only for
a newly discovered boundary or invalidated target.

## Hold one controller lease

Before reapplying an old local branch, run `branch audit` per
[replacement lineage](references/replacement-lineage.md); a unique SHA or a
missing MR on that branch name does not establish unshipped work.

For Queue, Sweep, Integrate, Ship, Reconcile, and Resume, start one active loop
only after initialization returns `preLoopActionRequired: false`. Start the
loop before the first integration mutation and retain its run ID. A second
controller is rejected; independent authors use distinct claimed worktrees.
When the target is GitLab, first paginate the complete opening remote inventory
(every branch and every open, merged, and closed proposal), then pass that
unchanged receipt, built by `remote-inventory build`, through `loop start
--opening-remote-inventory <file>`.

When an active loop assigns a new author into that same integration unit, run
`simple-changes prepare-agent` before edits. Independent agents create an
isolated worktree and immediately run `worktree claim`. A claim is the lock:
while it is active, no controller packages, merges, or cleans that checkout.
After registration,
both run-prepared and independently claimed authors edit, generate, format,
test, stage, and commit normally and concurrently in their own distinct
worktrees and branches. Run only shared integration mutations through `loop
exec`. Use `loop guard` only for
external provider calls and verify immediately afterward. Before merge,
deployment, cleanup, and completion, run `loop verify`; immediately before a
merge, deployment, or migration, add `--for merge`, `--for deploy`, or `--for
migrations` so [shipment holds](#shipment-holds) gate that step. Proceed
only on a passing result. After review and integration settle, record one exact
`loop record-outcome --receipt <shipment-outcome.json>` receipt, drafted by
`loop draft-outcome`, before completion. A busy lock blocks only the named
short integration operation, never unrelated authors.

When scheduling allows parallel authoring and the host can start isolated
agents, delegate independent units per
[parallel agents](references/inventory-and-concurrency.md#parallel-agents):
the controller prepares every agent's worktree with `prepare-agent`, and the
controller alone pushes, merges, and finalizes.

Before every
terminal assistant response after a loop has started, including a blocked or
failed handoff, run `loop finalize --reason "<why the turn ends>" --json`, then
`loop status --json` and verify
that your controller is released or relinquished. When the turn ends on a
question the run needs answered, such as a migration, deployment, or cleanup
approval, add `--awaiting-user "<question>"` once per question: the run pauses,
records the questions, exits zero, and resumes with `loop start --mode resume`
after the answer. A nonzero exit alone does not
prove release; if state cannot be written, report that exact blocker. If
delivery or safety blockers remain, finalization relinquishes durable state and
exits nonzero.

## Shipment holds

Agents in different harnesses coordinate shipments through the shared
coordination directory without messaging each other. Any agent whose
task could break, or be broken by, the next merge, deployment, or migration
records a hold with `hold add`, and releases
it the moment the reason ends.
Release another agent's hold only with the user's explicit approval, adding
`--override-halt` for a halt. Waive a `halt` only when the
user explicitly approves overriding that exact hold.

When completed, verified work is ready but another task already owns the active
shipping controller, do not start a second shipment. Ask: **Do you want me to
ask that agent to fold this work into the active shipment, or should I wait
until that shipment finishes and ship this separately afterward?** If approved,
record the receipt with `worktree release --ready-receipt
<file>`; the active controller reads it without a message.

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
   conflicted, detached, mid-operation, active, and unclaimed state.
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
   present, and accept only current locally validated receipts.
7. Create or update neutral proposals per
   [change proposals](references/change-requests.md); resolve
   checks, discussions, and review, and merge only the exact approved head.
8. Audit every detected migration before any apply. Apply only through
   `simple-changes migration decision` and `simple-changes migration apply`
   per [high-risk actions](references/migrations-and-high-risk-actions.md).
9. Treat every production Web deployment as a product release. Prepare release
   reconciliation, refresh the canonical remote target branch (normally
   `main`), require a read-only `verified` receipt, and deploy only that exact
   finalized target. Verify the live deployment observes the same revision,
   even when no deployment was created during this run. A Ship or resumed Ship
   loop is incomplete when the live revision differs from the latest canonical
   target revision.
10. Run final local/provider inventory and clean only proven objects. For a target
    GitLab remote, complete the remote-branch reconciliation gate across every
    paginated branch before completion. Delete proven-obsolete remote branches
    only after exact evidence; preserve uncertainty.
11. Restore the exact original primary checkout clean at the refreshed target,
    retain exact authorized exclusions, verify again, and finalize the lease.
    Finalization automatically removes proven safe worktrees, stale metadata,
    and merged local branches. An exact verified shipment may close with an
    unchanged primary explicitly preserved in its scope; see
    [cleanup and completion](references/cleanup-and-completion.md).

For Ship, Integrate, and Reconcile, carry these steps as a checklist in the
reply: list them once in plain language, tick a step only after its evidence
exists, and leave a failed step unticked. Fix what the failure reports and run
that step again until it passes. When the fix changed source, return to step 4
(in Ship, record the fresh preview with `loop refresh-scope`); when the
target, policy, controller checkout, or a scoped source worktree changed,
return to step 3. Other modes follow the same order without the written
checklist.

## Reports

Report queued, merged, deployed, preserved, and blocked items separately. Queue
must include **Outstanding work** for every omitted discovered unit, including
its location, current revision/state, why it was deferred, and the next action;
it may not silently omit it. When the installed-client gate applies,
report `Installed-client compatibility: <state> (<evidence and reason>)` and
name any required client release or phased rollout. A Ship receipt opens by
naming the actual shipped change in plain language, what is different now and
for whom, before merge, check, and deployment evidence, even when no changelog
entry was written. Never
claim completion until final inventory proves requested scope and primary state.
When Ship finalizes or reconciles a public release, end with concise **Latest
customer notes** sourced from that exact version's public release notes; see
[plain-language communication](references/user-communication.md).

Preview may run `simple-changes preview` and must create no branch, commit,
stash, ledger, proposal, or deployment.
