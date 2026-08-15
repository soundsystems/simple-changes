---
name: simple-changes
description: Use when a user asks to sync with remote main, package, queue, publish, integrate, review, merge, ship, reconcile, or clean local Git changes, branches, worktrees, proposals, or deployments. Preserve concurrent work, create focused proposals, satisfy checks and review, merge current approved heads, verify authorized deployment, and reconcile proven cleanup. Do not use to author changelogs or release notes directly, for non-Git synchronization, or for read-only code review.
---

# Simple Changes

Turn ready repository work into focused, verified proposals without disturbing
active work. Requires Git; deterministic helpers require Bun 1.2 or later.

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
then follow [onboarding](references/onboarding.md), ask one question at a time,
and show every option with its one-sentence consequence. Required consequence
copy includes:

- **Put it up for review:** Create focused proposals, run checks, and stop.
- **Ask me first:** Merge automatically, but confirm before production.
- **Delegate when available:** Use a compatible changelog skill when present;
  otherwise preserve and report the work.
- **Only when blocked:** Keep working unless a decision is genuinely required.
- **This run only:** Use the choices now without writing a policy file.
- **Ask if it's ready:** Recommended. Ask whether the implementation is ready
  or whether more changes are needed before handing it off.
- **Automatically after implementation:** Hand off completed, verified
  implementation work immediately, subject to current authority.
- **When I say it's ready:** Wait for the user to ask to put up, merge, ship,
  finish, or reconcile the completed work.
- **Follow repository convention:** Recommended. Use the established format;
  ask if none exists.
- **Number and date:** Use zero-padded sequence and ISO date names.

Ordinary UI source files, Git revisions, deployment identities, package
versions, and release versions do not use this preference.

Resolve installed update choices before acquiring a loop. When changelog work
is required, resolve the Simple Changelogs notice and the user's
owner-controlled walkthrough, continue, defer, or release-notes choice before
`loop start`. Do not start a Ship loop, send the pre-ship brief, acquire a
lease, then pause it for this explanation. Continue only after initialization
returns `preLoopActionRequired: false`. Repository policy that grants push,
automatic migration, break-glass, or production authority is effective only
with the private digest-bound local trust receipt described in
[setup and policy](references/setup-and-policy.md); a repository policy symlink
is unsafe.
Update notices must explain the new abilities before offering dispositions and
recommend reviewing what changed; never recommend keeping, skipping, or
deferring before the user understands the practical changes. A colloquial
“auto push” choice requires the exact scoped-push explanation and confirmation
from [installed guidance updates](references/guidance-updates.md) before saving.

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

When an active loop assigns a new author into that same integration unit, run
`simple-changes.ts prepare-agent` before edits. Independent agents create an
isolated worktree and immediately run `worktree claim`. Run each controller or
run-author integration mutation through `loop exec`; use `loop guard` only for
external calls and verify immediately afterward. Before merge, deployment,
cleanup, and completion, run `loop verify`.

Claims allow healthy concurrent-author edits without pausing. A strict collision
requires an exact owner claim/pause exchange. Preserved or retained worktrees
can accept an exact current pause receipt and become immutable preserved state;
later mutation invalidates the digest. Retain a clean unrelated checkout rather
than removing it. An unchanged clean opening checkout is automatically removed
at finalization when it is unclaimed, unretained, and its exact head is already
contained in the refreshed target. For changed opening work that later becomes
obsolete, use `loop dispose-worktree` only after proving it clean with zero
unique commits. Every disposition binds the exact target, path, branch, head,
and digest.

Remote fetch and push URLs are lease-bound. A destination change invalidates
the loop; re-verify repository ownership and start a new lease. `configure-harness`
may request only the narrowest verified repository-and-destination-scoped push
rule and never grants network, credentials, force push, or protection bypass.

The lock records process-group evidence. If recovery is proven safe, use `loop
recover --agent-id "$AGENT_ID"`; never delete state by hand. Before every
terminal assistant response after a loop has started, run `loop finalize`.
For Integrate, Ship, Reconcile, and Resume it first removes unchanged clean
target-contained worktrees, prunes stale worktree metadata, deletes exact
target-contained local branches, normalizes tracked primary paths whose current
bytes exactly match the refreshed target and whose index contains no unique
state, and restores or fast-forwards the primary under the controller lock. It
releases completed state. If blockers remain, it
relinquishes durable state and exits nonzero so preservation cannot be mistaken
for shipment completion. Takeover requires the exact current run ID and
manifest digest plus approver and reason.

Follow [inventory and concurrency](references/inventory-and-concurrency.md).

## Completed-work handoff

For an instruction-pointer handoff, run:

```sh
simple-changes initialize \
  --mode handoff \
  --json
```

If confirmation is required, ask: **Is this ready for Simple Changes, or do you
want more changes first?** Continue only when `mutationAllowed` is true. Do not
invoke it after planning, diagnosis, read-only work, or incomplete verification.

## Core workflow

1. Read repository instructions and [setup and policy](references/setup-and-policy.md).
2. Initialize, resolve companion notices, capture the canonical primary
   checkout, then start the required controller lease.
3. Refresh the intended target before diff-derived decisions. Preserve dirty,
   conflicted, detached, mid-operation, active, and unclaimed state. Inventory
   hashes changed regular files in bounded chunks and records special files
   without reading FIFOs, sockets, or devices.
4. Group stable work by outcome, dependency, data boundary, ownership, and
   parity. Every path belongs to one unit or an explicit preserved set.
5. Run proportionate repository-native checks and distinguish introduced from
   pre-existing failures.
6. Coordinate changelog ownership without authoring release text. Negotiate
   supported versions/features and exact schema digests. Accept only current
   validated receipts.
7. Create/update neutral proposals with real Markdown newlines, re-read stored
   source/rendering, resolve checks/discussions/review, and merge only the exact
   approved head.
8. Audit every detected migration before any apply. Run `simple-changes
   migration decision` with an exact reviewed target, current operation digests,
   fresh remote ledger, nonce/expiry, adapter, absolute executable path and
   executable digest. Run `simple-changes migration apply` with the same closed
   evidence so authorization consumption and shell-free execution are one
   operation; then refresh the remote ledger. Broad apply-all, stale, replayed,
   target-mismatched, or command-changed plans require new review/authority.
9. Treat every production Web deployment as a product release. Prepare release
   reconciliation, refresh the canonical remote target branch (normally
   `main`), require a read-only `verified` receipt, and deploy only that exact
   finalized target. Verify the live deployment observes the same revision,
   even when no deployment was created during this run. A Ship or resumed Ship
   loop is incomplete when the live revision differs from the latest canonical
   target revision.
10. Run final local/provider inventory and clean only proven objects. A dirty
    primary is an intermediate reconciliation blocker, never a valid completed
    Ship result. Finalization safely normalizes tracked target-identical paths;
    classify every remaining path against the refreshed target, ship genuine
    newer work, and prune proven obsolete or generated entries. For a
    target GitLab remote, complete the remote-branch reconciliation gate across
   every paginated branch before completion. Pagination evidence must include a
   consolidated ledger digest plus complete branch and open/merged/closed
   proposal page chains from initial and final inventories. Delete
   proven-obsolete remote branches only after exact
    evidence; preserve uncertainty.
11. Restore the exact original primary checkout clean at the refreshed target,
    retain exact authorized exclusions, verify again, and finalize the lease.
    Finalization automatically removes proven safe worktrees, stale metadata,
    and merged local branches; any unresolved dirty-primary path keeps the run
    incomplete.

## Authority and invariants

Current user direction outranks repository and personal policy. Discovery is
not authority. Never invent remote, deployment, migration, credential, or
provider facts. Never use destructive reset, cleanup stash, force deletion,
force push, protection bypass, or secret export without exact authority.

Public release versioning and release-note authorship belong to a compatible
changelog owner. Database automatic modes apply only to the exact saved
provider/project/environment target and exclude destructive or data-deleting,
irreversible, unbounded, lock-heavy, target-mismatched, or unprotected changes.

GitLab cleanup is required only when the selected target remote is GitLab, not
merely because an auxiliary GitLab remote exists. Reconciliation must prove a
terminal cursor chain and response digest for every page and every proposal
state.

## Reference router

Read the references needed for the active mode:

- [setup and policy](references/setup-and-policy.md)
- [onboarding](references/onboarding.md)
- [installed guidance updates](references/guidance-updates.md)
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
and every preserved uncertain branch. For Ship, compare the pre-ship brief with
the result and report review-driven changes or explicitly state none. Never
claim completion until final inventory proves requested scope and primary state.

Preview may run `simple-changes preview` and must create no branch, commit,
stash, ledger, proposal, or deployment.
