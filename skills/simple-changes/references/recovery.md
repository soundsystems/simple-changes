# Recovery

Contents:

- Start from loop status
- Locks and stale leases
- Controller handoff and takeover
- Released claims and paused changes
- Absent and obsolete worktrees
- Repair bookkeeping after cleanup
- Inherited or broken state
- Cleanup without a loop
- Replan a frozen shipment without cleanup
- Archive a recorded run that cannot finish

Read this reference when `loop status`, `loop verify`, or finalization reports
a blocker, a stale, relinquished, or frozen run, a released or orphaned claim,
or a missing, late, or changed worktree; when merged work or orphaned worktrees
have no loop to clean them up; and when an editor's or desktop app's worktree
list is stale after cleanup. Every path here preserves uncertain work. None replaces the normal
lifecycle in `SKILL.md`: initialize, hold one lease, mutate through `loop exec`,
verify, and finalize before every terminal response.

## Start from loop status

`loop status` names the exact next recoverable command for whatever state it
finds and reports lease liveness (`live`, `stale`, or `unknown`), and `worktree
refresh-index` re-syncs cached editor and desktop worktree views from the
authoritative Git inventory.

If a controller disappears before finalization, do not delete the state file or
infer abandonment from elapsed time or a dead helper PID: helper commands exit
between agent steps. Re-read `loop status` and follow its recovery guidance using
explicit session authority. A stale lease can use `loop recover --stale-lease`;
an active takeover requires the exact current run ID and manifest digest,
approver, and reason. Any intervening manifest change invalidates takeover evidence.

If an older relinquished run already finished cleanup but lacks opening remote
evidence, never relabel later observations as its opening inventory; use the
explicitly approved `loop recover-post-cleanup` path in
[repair bookkeeping after cleanup](#repair-bookkeeping-after-cleanup).
For a frozen shipment whose scope cannot cover later work, use the explicitly
approved, owner-bound [replan recovery](#replan-a-frozen-shipment-without-cleanup).
It archives the old run without cleanup; fresh inventory and normal authority
checks still govern the next shipment. A run that already recorded its shipment
outcome but cannot finish uses the same approval through
[`loop archive-recorded`](#archive-a-recorded-run-that-cannot-finish),
whose `archived-unfinished` result is never reported as shipped.

Fail-closed preservation protects uncertain work; these paths resolve it
without abandoning the safety model. Write-capable takeover and closure require
a named approver and reason and record audit receipts. Read-only equivalence
needs no approval. None mutates worktree files, provider state, or branches
beyond its stated scope.

## Locks and stale leases

The lock records process-group evidence. If recovery is proven safe, use `loop
recover --agent-id "$AGENT_ID"`; never delete state by hand.

If a process crashes, `loop recover` removes the loop lock only when its ownership
metadata is valid, it is older than the recovery boundary, the recorded host is
the current host, the controller PID is provably dead, child launch is fully
recorded, every recorded child/process group is inactive, and the caller owns
the active lease. When the same dead PID also owns a stale worktree-coordination
lock, recovery removes that exact matching lock in the same transaction; a
mismatched coordination owner fails closed. A live, remote-host, young,
ownerless, malformed, unresolved, or still-running process-group lock remains a
blocker.

Finalization persists each automatic removal intent before the destructive
Git operation, and records a preserved primary's baseline before synchronizing
it; [cleanup and completion](cleanup-and-completion.md#complete-and-finalize)
describes how `loop recover` and the next finalization attempt account for
either after a process dies.

When a lease
itself is stale, `loop recover --stale-lease --run-id "$RUN_ID" --agent-id
"$AGENT_ID" --approved-by "$USER" --reason "$WHY"` clears the bookkeeping
record on explicit user authority while preserving every worktree and receipt.
Reuse session authority that already covers this recovery. A dead helper PID or
old heartbeat alone does not establish that the owning agent has stopped.

**Stale lease recovery.** A lease whose owner died mid-run used to block every
other agent in the repository until a human-approved `loop takeover`. Each
operation that already writes lease state now records a heartbeat: the lease's
`updatedAt` plus the owner process identity. A lease is `live` while that
process is provably running or the heartbeat is recent, `stale` only when the
owner cannot be proven alive and the heartbeat is older than the published
threshold, and `unknown` when its timestamp cannot be parsed. `loop status`
reports that state, so no caller has to compare timestamps itself. `loop
recover --stale-lease --run-id <id> --agent-id <you> --approved-by <who>
--reason <why>` clears a stale lease on explicit user authority: it refuses a
live lease, archives the cleared record into the run history like other
terminal records, and preserves every worktree, branch, claim, and durable
receipt. It clears the bookkeeping record only, never user work; run `prune`
afterward to reconcile whatever local cleanup the dead owner never finished.
(`loop recover --agent-id <you>` still recovers a dead *lock*; run it first if
one remains.)
Do not clear another task's run merely to complete a concurrent prune request.
If that task is still shipping, defer its cleanup; recover the run only on
explicit recovery authority after checking its owner.

## Controller handoff and takeover

Resume a relinquished run with `loop start --mode resume`;
takeover approval is only needed to replace an active controller.
Takeover requires the exact current run ID and manifest digest plus approver and reason.

## Released claims and paused changes

A released claim is never refreshed, so `loop verify` and `loop
status` then print the exact recovery: the owner claims and pauses the checkout
with `preserve-in-place`, and the controller runs `loop accept-paused-change`.

Use `loop adopt-worktree` for a paused worktree that appeared after loop start.
Use `loop accept-paused-change` for an opening preserved worktree whose owner
changed it before pausing. Both commands require the receipt's run, repository,
path, branch, HEAD, digest, claim owner, and current state to match, register the
worktree as preserved with `mutationAllowed: false`, and reject the update when
any unrelated manifest violation remains. A sibling worktree that either
command could record next, and whose exact current state its own valid current
pause receipt for this run covers, does not count as a blocking violation, so
several receipted checkouts can be adopted or accepted one at a time in any
order instead of deadlocking against each other. `loop allow` remains the separate
exceptional user-approved override path.

## Absent and obsolete worktrees

For changed opening work that later becomes obsolete, use `loop dispose-worktree`
only after proving it clean with zero unique commits. When a preserved checkout,
including one registered by `loop rebaseline`, has been removed by its owning
task, record that absence with `loop retire-absent-worktree` on named approval;
it requires the path to be gone from disk and from Git's worktree list, deletes
nothing, and proves no delivery.

If a preserved worktree the run did not create, whether registered at loop
start, adopted, or added by `loop rebaseline`, has already disappeared because
its owning task removed it, `loop retire-absent-worktree` records the absence
instead. It
accepts only a path missing from disk and from the live worktree list, needs
the loop owner and a named approver, binds to the exact registered baseline,
and leaves branches, claims, and delivery proof untouched.

When a
preserved checkout has already been removed by its owning task, whether it
was registered at loop start, adopted, or added by `loop rebaseline`, record
`loop retire-absent-worktree` with a named approver and reason. It requires
the path to be absent from both the filesystem and `git worktree list`,
binds to the exact registered baseline, writes an immutable retirement
receipt, and clears only the missing-worktree violation. It never deletes
anything, never proves a scoped unit was delivered, and never authorizes
branch cleanup; do not recreate a deleted checkout merely to satisfy the
record.

## Repair bookkeeping after cleanup

A legacy ledger may lack persisted opening evidence even though cleanup already
finished. Do not fabricate an initial inventory from later observations.
`loop recover-post-cleanup` is the recovery for already-complete cleanup (and
`loop close-equivalent` below for work already contained in the target): it
needs explicit approval,
two complete matching final inventories observed at increasing times, exact
current target/project binding, no open proposals, clean current primary state,
two matching zero-active-claim observations from `worktree observe --json`, and
no remaining cleanup action. It holds the coordination lock from its final
claim digest check through closure, archives the old lease plus both snapshots,
retires only already-absent non-active claims, and removes the active ledger
without authorizing any Git or provider mutation. It cannot push, merge,
deploy, move refs, or remove anything. Afterward say: **Cleanup was already
complete; Simple Changes repaired and closed its old bookkeeping record.**

## Inherited or broken state

For other
inherited broken state, these are the authorized recovery
paths: `worktree takeover` for a claim whose owner no longer exists,
read-only `worktree equivalence` for patch/byte containment evidence with
advisory residue hints, `loop close-equivalent` to close a relinquished or
frozen-scope loop whose work is already contained in the target, `loop
rebaseline` to register worktrees that appeared after loop start as preserved
and untouched when a stale opening manifest deadlocks a run, and `worktree
cleanup` for one audited standalone pass when no loop record exists. A
target-equivalent close is never reported as shipped.

**Stale claim takeover.** When a claim's recorded owner no longer exists, use
`worktree takeover --claim-id <id> --agent-id <new-owner> --approved-by <who>
--reason <why> [--release]`. It binds to the worktree's exact current status
digest (re-observe on mismatch), and either reassigns ownership or releases
the claim. It refuses claims a loop still requires, judged by lifecycle rather
than bare path membership: an active loop protects every registered path, but
a relinquished loop preserves work through the worktrees themselves, so its
registered paths no longer freeze takeover; only an adopted coordination
linkage (a preserved registration bound to a claim and pause receipt) stays
protected for the resumed controller to verify. It never edits, removes, or
repairs the worktree itself.

**Equivalence evidence.** `worktree equivalence --worktree <path>
[--target <ref>] --json` is read-only: it compares each commit ahead of the
merge base by stable patch-id and dirty or untracked state against the target.
It binds staged object IDs, index and filesystem modes, Git links, and file
bytes, and requires matching opening/final HEAD and status digests so a
concurrent edit invalidates the audit. It classifies the whole checkout
`contained`, `partial`, or `divergent`. This is patch, object, mode, and byte
evidence only; a textually different but semantically equivalent change still
reports unmatched, and deciding that residue is review work, not tooling
output. When unmatched work remains, the report adds advisory `residue` hints
for review: each unmatched commit's touched paths and whether their end state
already matches the target byte-for-byte, and whether a differing dirty path
differs only in whitespace. Hints narrow the review; they never upgrade the
classification and are never proof.

**Nothing-to-ship close.** When a relinquished, frozen-scope, or legacy
close-only loop's registered work is already contained in the refreshed
target, `loop close-equivalent --run-id <id> --approved-by <who> --reason
<why>` closes it without the full scope, pre-ship brief, and shipped-outcome
lifecycle. Every obligated worktree, including every scoped source worktree,
must be proven: a clean checkout whose head the target contains, a current
`contained` equivalence receipt for that exact path and head, or, for a
worktree this run removed itself, its completed `remove-after-audit`
disposition when the refreshed target contains both the audited target and the
removed head. Actively claimed and preserved/retained worktrees are excluded
and untouched; after the scope freezes, an unrelated checkout (unclaimed,
unpaused, not a scoped source, and not the primary checkout) no longer blocks
final verification when it is a preserved checkout that went missing or
changed, or a retained checkout that went missing. A changed retained
checkout still blocks, because its owner must claim or pause it, and claim,
authorization, and coordination violations still block. On success
it records
a terminal `target-equivalent` outcome (never reportable as shipped) in its
immutable archive after the normal proven-safe local cleanup and final
verification succeed. It then releases the lease. A failed cleanup or archive
write leaves the run open without adding a terminal outcome; completed removal
intents remain available for a verified retry. For a GitLab target, a complete final
branch/proposal reconciliation bound to the current target revision is required
before closure; the command never infers that provider mutation did not occur.
For providers without that gate, the closure records that GitLab reconciliation
was not applicable. One missing or unproven path blocks the close and is named
exactly.

**Manifest re-baseline.** In a repository where other agents keep creating
worktrees, the opening manifest can go stale mid-run: verification blocks every
guarded mutation on the late arrivals, registering them needs owner pause
receipts the controller cannot produce, and the same block reaches the
reconciliation that `loop end` or `loop close-equivalent` requires. The escape
is `loop rebaseline --run-id <id> --agent-id <owner> --approved-by <who>
--reason <why>`: with one exact user approval, the active (or resumed)
controller registers every worktree that appeared after loop start as
preserved at its exact current head and status digest, recorded on the lease
as an audited re-baseline. Registered late arrivals stay owner-controlled and
untouched; if one changes afterward, verification blocks again until its owner
coordinates or an exact `loop allow` override is approved. Re-baseline grants
no mutation, cleanup, or shipping authority over the registered worktrees and
never obligates them in a later `close-equivalent` proof.

**Standalone cleanup.** When no loop record exists at all and orphaned
worktrees remain, `worktree cleanup --agent-id <you> --approved-by <who>
--reason <why> [--target <ref>]` runs one audited pass without reopening a
shipment. It removes only what is proven safe right now: an unclaimed clean
worktree whose head the refreshed target contains by exact ancestry or
complete per-commit patch equivalence, and stale metadata whose directory no
longer exists; it then releases orphaned claims whose worktree is gone and
records them as `releasedClaims` on the receipt. Every live claim on an
existing checkout, dirty checkout, or unmatched head is
preserved and named with the exact next command (equivalence audit, claim
takeover, or loop lifecycle). The whole pass is recorded as an append-only
receipt, and the command refuses to run while any loop record exists, active
or relinquished; those repositories recover through `loop status` guidance
instead.

## Cleanup without a loop

Cleanup is not tied to finalization. When work is merged but no loop will
finalize it, run `prune --approved-by "$USER" --reason "$WHY"` (add
`--dry-run` to see the plan first): it applies the same proven-safe audit
without a lease, naming the containment method for every removal, and defers
anything registered by an open lease to that run's controller. A stale heartbeat
or released author claim never authorizes removing its registrations. Use the
controller's audited removal path or wait for closure; never bypass this with
raw Git removal or filesystem deletion.

**Lease-less prune.** Cleanup that only ever runs inside `loop finalize`
leaves residue whenever an agent merges its work and stops, merges outside a
loop, or relinquishes on blockers. `prune --approved-by <who> --reason <why>
[--target <ref>] [--dry-run]` runs the same proven-safe audit with no lease of
its own. It removes an unclaimed clean worktree whose head the refreshed target
contains by exact ancestry or complete per-commit patch equivalence, stale
metadata whose directory no longer exists, and a local branch that is not the
target, not attached to a worktree, and whose unique commits the target
contains by the same two proofs. Each disposition names its containment method
(`target-contained` or `patch-equivalent`), and everything preserved is named
with its reason: the primary checkout, the target branch, any dirty or
actively claimed checkout, every path or branch registered by an open lease,
and any branch beyond the patch-equivalence commit bound. Prune defers the
lease's registered work to its controller, even when the run is stale or
relinquished, and cleans only eligible unrelated state. An old heartbeat or
released claim is not removal authority. For registered cleanup, use the
controller's exact disposition and guarded removal or wait for closure; never
fall back to raw Git removal or filesystem deletion. `--dry-run`
changes nothing; the destructive form still reports the exact plan before
applying it. Prune never edits lease state, worktree claims, or recorded
receipts, and unlike `worktree cleanup` it does not release claims.
Cleanup and metadata refresh take the same short integration lock before the
coordination lock, then re-read inventory and registrations. If an integration
operation is busy, retry cleanup after it finishes; leave the shipment running.

**External UI caches.** Editor and desktop surfaces (for example Codex
Desktop) cache their own view of worktrees outside this workflow's ownership.
After cleanup, `worktree refresh-index` prunes only metadata for worktree
directories that no longer exist and reports, per coordination adapter,
whether a cached surface view re-syncs from the refreshed Git inventory. If
any missing checkout is registered by an open loop, metadata pruning is
deferred because Git prunes registrations together; the current inventory is
still returned. Prune uses the same deferral. Never substitute raw
`git worktree prune` for this protection. Their session and task
history are audit records, not live registrations; never delete them to make a
list look clean.

## Replan a frozen shipment without cleanup

When a frozen scope cannot represent later work, the exact current controller
may use `loop replan` with explicit named user approval. This applies to active
and relinquished frozen runs. A different agent must obtain the existing
supported controller handoff or takeover first; replan never transfers authority.
Do not edit the lease or widen its frozen scope by hand.

1. Stop guarded operations and observe with
   `simple-changes loop replan-status --repo <checkout> --json`.
2. Review that exact inventory, coordination state and current target with the
   user. Record their approver identity and reason. Run
   `simple-changes loop replan --repo <same-checkout> --run-id <observed-run>`
   `--agent-id <observed-owner> --manifest-digest <observed-manifest>`
   `--status-digest <observed-status> --approved-by <user> --reason <reason>`.
   Both commands must use the same checkout: inventory digests include checkout
   identity. Any change to the bound evidence requires a fresh observation and
   approval. An earlier approval to ship does not by itself authorize replan.
3. Keep the returned `replanned` receipt and start a fresh loop through the normal
   workflow. Inventory and reconcile all remaining work and provider truth;
   replan does not prove that earlier merge or deployment actions never occurred.

Replan takes the existing state lock before the coordination lock and never
recovers held locks. It refuses unfinished author preparations, recorded shipment
or target-equivalent outcomes, and emergency shipping ledgers; a run with a
recorded shipment outcome has its own
[approved archival](#archive-a-recorded-run-that-cannot-finish). Changed files and
stale claims may be archived as observed; this does not mark verification passed
or alter those claims. It runs no Git cleanup, reference, index, worktree, claim,
provider, or deployment mutations.

Each exact approved request has an immutable attempt directory at
`<common-git-dir>/simple-changes/history/<run-id>/replan-<request-digest>/`.
`replan.json` is the durable intent and receipt metadata; **intent alone does not
prove completion**. The atomic move of the complete original lease into
`replan-lease.json` completes the transition. Existing evidence directories stay
in place. A matching retry verifies this archive and returns the receipt without
touching a newer active loop. A crash before the move can retry the exact request;
if work changed meanwhile, a newly approved request creates a separate attempt
and preserves the earlier intent. Never delete or modify an intent to retry.

## Archive a recorded run that cannot finish

`loop replan` refuses a run that already recorded a shipment outcome. When such
a frozen run can no longer finish, for example because its outcome no longer
matches the current target or cleanup it depended on cannot happen, its exact
owner may archive it with `loop archive-recorded` after explicit named user
approval. A different agent first takes over through the supported controller
handoff, as for replan. `loop status` names this command for a relinquished run
with a recorded outcome, and `loop replan-status` returns it as `nextCommand`.

1. Stop guarded operations and every external provider operation; a prior
   `loop guard` holds no lock for work started outside the runtime, though the
   state and coordination locks still exclude an active `loop exec`. Observe
   with `simple-changes loop replan-status --repo <checkout> --json`.
2. Review that exact inventory, coordination state, current target, and the
   recorded outcome with the user, and record their approver identity and
   reason. Run `simple-changes loop archive-recorded --repo <same-checkout>`
   `--run-id <observed-run> --agent-id <observed-owner>`
   `--manifest-digest <observed-manifest> --status-digest <observed-status>`
   `--approved-by <user> --reason <reason>`.
3. Keep the returned receipt and start a fresh loop through the normal
   workflow. Reconcile current provider truth before any new mutation.

It requires an intact, nonempty historical receipt: the receipt's run ID matches
the lease, its digest matches the recorded one (together with any
[preserved-source overrides](focused-units.md#preserved-source-override) stored
beside the lease, which must be present and unchanged), every recorded path's entry
matches the receipt's target tree, and the current target contains that target
revision. It still refuses unfinished author preparations, target-equivalent
outcomes, and emergency shipping ledgers, and binds the current inventory and
claims to the approval exactly as replan does.

The transition is replan's: the same locks, the same atomic move of every
original lease byte, and no Git, claim, provider, or deployment mutation. Its
attempt directory is
`<common-git-dir>/simple-changes/history/<run-id>/archive-recorded-<request-digest>/`,
and its record has kind `loop-archive-recorded` and outcome
`archived-unfinished`. That outcome is never completion and never counts as a
shipment or delivery; report it as archived bookkeeping. All historical
receipts, refs, claims, and worktrees stay as they were, and a matching retry
never removes a successor run.
