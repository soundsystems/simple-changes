# Inventory and concurrency

Capture the opening inventory before mutation:

- canonical primary and current checkout;
- common Git directory and target ref;
- local and remote branches with revision IDs;
- all worktrees, including dirty state and branch/detached identity;
- existing stashes without applying or modifying them;
- staged, unstaged, untracked, renamed, deleted, conflicted, and symlink paths;
- open proposals and provider capabilities when available;
- policy sources and a stable baseline digest.

Before interpreting unique commits on an old branch as new work, run
`branch audit --head <source-ref> --target <ref> --json` from the primary
checkout. Resolve any replacement candidates before creating an author
worktree or reapplying the branch. See [replacement lineage](replacement-lineage.md).

Before assigning several independent authors, apply `proposalScheduling`:

- `balanced`: prefer consecutive work, but parallelize when it saves meaningful
  time or isolation is necessary; ask only when the tradeoff is substantial;
- `consecutive`: schedule one PR or MR at a time unless isolation is necessary;
- `parallel`: use distinct claimed worktrees for independent PRs or MRs, but
  confirm unusually expensive fan-out.

Once parallel authoring is selected, every author still requires a distinct
claimed worktree. After verified integration, ordinary finalization removes
proven-safe completed worktrees, including their local dependencies and build
artifacts. Never delete dependencies from an active, retained, or uncertain
worktree merely to reclaim space.

Do not substitute a standalone clone for a claimed worktree. Its separate
common Git directory cannot see this repository's controller and claims, so it
can advance the same remote target while leaving stale local bookkeeping. Close
or safely resume the existing controller before another shipment moves that
target.

Resolve the canonical primary checkout from `git worktree list --porcelain`, not
from the current directory. Record the primary path and return to that exact
checkout after mutations.

Take another snapshot before packaging. Compare evidence:

- A worktree first seen after the opening baseline is a concurrent arrival.
- A pre-existing worktree whose head or change digest differs is actively
  changing.
- Work unchanged across snapshots is stable by default, even when its branch
  name contains `wip`.
- Objects created by this run are attributed by the run ledger and are not
  concurrent arrivals.

Preserve concurrent or active work. Continue independent stable units. If an
ambiguous item truly blocks one unit, defer the question until safe independent
work is complete.

Treat a pause in the current request as authoritative. On resume, re-read the
newest request and fresh repository evidence instead of carrying an old pause
forward forever or silently reviving it. Resume preserved work only when the
user clearly releases the pause or current evidence and policy resolve the
named condition.

The read-only preview takes repeated snapshots without writing
`.git/simple-changes/`. Mutation modes may keep resumable state there, but must
reconstruct truth from fresh Git/provider evidence on every resume.

## Integration-controller lease and concurrent authors

Queue, Sweep, Integrate, Ship, Reconcile, and Resume use one active
integration-controller lease stored
as `simple-changes/active-loop.json` beneath the repository's common Git
directory. `loop start` creates it atomically and records:

- the run and controller identities;
- the opening inventory digest, canonical target ref, and exact target revision;
- every worktree's exact path, branch, head, and content-sensitive change
  digest, including staged and unstaged patches plus untracked contents;
- whether the worktree is controller-owned, run-author-owned,
  concurrent-author-owned, or preserved; and
- exact user-approved overrides and audited removal dispositions, when any
  exist.

The lock directory prevents two integration operations from updating shared
manifest, target, proposal, merge, deployment, or cleanup state at once. It is
not a repository-wide authoring mutex. A second controller cannot replace an
active lease without an exact, user-authorized takeover, but run-prepared and
independently claimed authors may continue normal edits and commits in distinct
registered worktrees. Do not remove or rewrite the lock or state file by hand.

`loop guard` is a moment-in-time read-only preflight. It does not reserve a
future mutation. Use `loop exec` only for operations that change shared
integration state, so the same atomic lock covers a fresh manifest check, one
argument-array command, and a fresh post-command check. The reusable callback
awaits asynchronous work under that same boundary. It requires that the
caller's agent ID owns the exact registered controller or run-author worktree on
its recorded branch. It rejects any new unclaimed worktree, branch switch,
incomplete preparation, missing baseline worktree, or head/content change in a
preserved worktree. Run `loop verify` before merge, deployment, cleanup, and
completion even when every earlier operation passed.

For a Ship lease whose opening inventory contains local changes, first record
the conserved preview plan with `loop record-scope --receipt <file>`. The
command rechecks the exact unchanged opening digest and every changed path in
every worktree, persists the plan digest, and returns the pre-ship scope summary.
Until then, `loop guard`, `loop exec`, and completion fail closed. Do not infer
shipment exclusion from a `preserved` lease role: it means only that the
checkout cannot be changed or removed by the controller.
If independent review requires source changes, generate a new non-mutating
preview from the exact current inventory and record it with
`loop refresh-scope --receipt <change-plan.json>` before another mutation. This
controller-only action is rejected after an outcome exists and preserves the
superseded scope digest and timestamps in the lease history. `loop exec` also
rejects `git switch` and `git checkout` before Git can move a registered
checkout; prepare the correct branch-bound worktree before the loop instead.

Use these boundaries after an author is registered:

| Author-local and concurrent | Shared integration and serialized |
| --- | --- |
| Edit, generate, format, and run repository-local checks inside the author's worktree | Create, remove, detach, attach, or prune worktrees |
| `git add` and `git commit` on the author's distinct registered branch | Switch branches or move/update the canonical target or integration branch |
| Read Git/provider state | Merge, cherry-pick, or rebase work into the integration branch |
| Write normal worktree-local caches or build output | Push, mutate proposals, merge remotely, deploy, or clean repository objects |

Git already uses separate per-worktree indexes and atomic locks for distinct
branch refs and object writes. Simple Changes should not add a repository-wide
mutex around that ordinary authoring. Authors must still avoid shared Git
maintenance/configuration, stashes, tags, branch deletion, history rewrites,
provider writes, and any command that targets another worktree or branch unless
the matching integration boundary and authority apply.

When a genuine integration lock is busy, wait or retry only that short shared
operation; unrelated authors continue. Never pause them, demand a lease-null
handoff, export patches, or clean worktrees merely to free the lock. When lock
creation instead fails with `EPERM`, `EACCES`, `EROFS`, or another
permission-denied result, treat it as a local harness/filesystem authorization
failure. It is not evidence of a live lock owner, so do not run recovery or
coordinate an owner pause until actual lock metadata proves contention.

The default `concurrentWork: "allow-claimed"` policy recognizes an active owner
claim on a distinct non-primary branch as `concurrent-author`. The author may
keep editing and committing without a pause receipt, both when present at loop
start, when claimed after the opening manifest recorded it as `preserved`, and
when arriving later. The next guarded observation promotes a qualifying opening
`preserved` entry and binds its exact claim ID and owner. Head and content-digest
drift are expected for that role. The controller excludes it from the current
integration and cleanup. Verification still fails closed if the claim is
absent, released, reassigned, or branch-mismatched, or if the worktree is
primary or on the primary target branch. Use `concurrentWork: "strict"` for the
older repository-wide serialized behavior. Legacy `preserve` policy values
follow `allow-claimed`.

An external provider mutation that cannot execute inside `loop exec` uses the
narrow fallback: `loop guard` immediately before the call and `loop verify`
immediately after it. Never describe that fallback as an atomic local mutation
lock.

If a process crashes, `loop recover` removes the loop lock only when its ownership
metadata is valid, it is older than the recovery boundary, the recorded host is
the current host, the controller PID is provably dead, child launch is fully
recorded, every recorded child/process group is inactive, and the caller owns
the active lease. When the same dead PID also owns a stale worktree-coordination
lock, recovery removes that exact matching lock in the same transaction; a
mismatched coordination owner fails closed. A live, remote-host, young,
ownerless, malformed, unresolved, or still-running process-group lock remains a
blocker.

The transient lock and persistent controller lease have different recovery
paths. `loop recover` never transfers the persistent lease. A controller that
reaches the end of its agent turn must run `loop finalize`: a fully reconciled
run closes and deletes the lease, while an incomplete run records its blockers,
marks the controller `relinquished`, disables its mutation authority, and keeps
all ledger evidence. The next controller starts with mode `resume` (or the same
original mode), adopts that exact run ID, and continues from fresh evidence.
Relinquishment is not a repository-wide authoring pause: registered authors may
continue ordinary author-local work, and no controller should destructively
park or clean their work merely to manufacture a lease-null interval.

If a controller disappears before finalization, do not delete the state file or
infer abandonment from elapsed time. Re-read `loop status`, obtain explicit user
authority, and run `loop takeover` with the exact current run ID and manifest
digest, approver, and reason. Any intervening manifest change invalidates the
takeover evidence.

Normal command completion is also process-group scoped. A direct command
leader that exits while background descendants remain does not complete the
guarded mutation. Terminate those descendants and reject the command before
releasing the lock. If the process group cannot be terminated, retain the lock
so explicit recovery must prove the remaining processes inactive.

## New agents during an active loop

An agent joining the same integration unit must begin with `prepare-agent`. The command records a
pending preparation before creating a unique branch and sibling worktree from
the pinned target revision, then registers the completed worktree with the
active run and returns its exact path. Use that path as the agent's working
directory before it edits, formats, generates, stages, or commits files.
Repeating the command for the same agent ID returns the existing registration;
if creation stopped partway through, the same command validates and resumes the
recorded preparation instead of guessing or creating another branch. It refuses
to adopt staged, unstaged, or untracked content, and a registered author loses
mutation authority after switching away from the recorded branch.

An independent feature agent instead creates its own isolated worktree and runs
`worktree claim` as the immediate next command. Do not inspect project files
from the new checkout, install dependencies, format, generate, edit, stage, or
commit there before the claim succeeds. It does not acquire a second integration
lease and does not need `prepare-agent` unless its work is being assigned into
the active integration run.

Read-only review can inspect commit objects or provider diffs without an
authoring worktree. The moment a reviewer needs to make a change, it becomes an
author and must prepare an isolated worktree first.

## Ready work blocked by another shipping controller

When a separate task already owns the active shipping controller, finished and
verified work must remain on its exact worktree, branch, and commit. Do not
start a competing shipment. Offer the user two choices in plain language:

- **Fold into the active shipment:** with explicit approval, contact the exact
  owning task and send a ready-work receipt containing the repository,
  worktree, branch, commit, scope, completed checks, release impact, migrations,
  deployment constraints, and any unresolved authority.
- **Ship separately afterward:** preserve the claim and work unchanged, wait
  for the active shipment to close, then begin a fresh shipment.

Do not message another task or imply that it accepted, integrated, shipped, or
deployed the work before confirmation. A ready-work receipt is coordination,
not authority to take ownership, merge, deploy, apply migrations, or clean up.
If the host cannot identify and contact the exact owning task, give the user a
manual receipt to forward; never guess the recipient.

## Owner claims and safe pauses

Every owner-created worktree should be claimed immediately with `worktree
claim`. The claim lives beneath the common Git directory, binds the canonical
path, repository identity, branch, HEAD, content-sensitive digest, owner agent,
adapter slug, and opaque `ownerRef`, and is written atomically with mode `0600`.
Do not put titles, prompts, message bodies, credentials, or tokens in the owner
reference.

Release the claim when the work is done. An active claim excludes its
checkout from packaging, merge, and cleanup, so a finished branch stays
unshippable until its owner runs `worktree release --claim-id <id>` or hands
the work off with `initialize --mode handoff --agent-id <owner>`, which
releases the owner's own claim on the current checkout the moment the handoff
proceeds. Do not release a claim to "free" a lock or to make a controller's
inventory smaller; release it because the work is complete, verified, and
committed on its branch. `worktree status --json` lists every claim, pause
receipt, and recorded release reason; `worktree request` builds the
adapter-shaped pause, detach, or resume message for one exact owner and sends
nothing by itself.

Finalization also releases claims by evidence, never by elapsed time: the
controller's own active claim on a clean checkout whose exact head the
refreshed target already contains (`releaseReason: "shipped"`), and any live
non-detached claim whose worktree directory no longer exists
(`releaseReason: "worktree-absent"`). A detached claim keeps its branch and is
never released this way. Another owner's live claim on an existing checkout is
untouched.

A claim whose recorded owner no longer exists and whose worktree is still
present is not released by guessing the owner identity; use the audited
`worktree takeover` recovery in
[cleanup and completion](cleanup-and-completion.md).

Under `allow-claimed`, a healthy distinct active claim does not block the loop;
its owner keeps working and the controller excludes it. A valid active claim
also promotes an opening `preserved` registration automatically. Do not ask for
user approval or call `loop allow` for ordinary claimed concurrency. When strict
policy or a real collision blocks a loop, contact only the exact claimed owner.
The owner runs `worktree pause` at a safe boundary. `preserve-in-place` accepts
dirty work but rejects active Git operations and conflicts;
`detach-clean-checkout` additionally requires no changes. The resulting receipt
is evidence, not permission to edit the worktree.

Use `loop adopt-worktree` for a paused worktree that appeared after loop start.
Use `loop accept-paused-change` for an opening preserved worktree whose owner
changed it before pausing. Both commands require the receipt's run, repository,
path, branch, HEAD, digest, claim owner, and current state to match, register the
worktree as preserved with `mutationAllowed: false`, and reject the update when
any unrelated manifest violation remains. A sibling unregistered worktree that
holds its own valid current pause receipt does not count as a blocking
violation, so several receipted stragglers can be adopted one at a time in any
order instead of deadlocking against each other. `loop allow` remains the separate
exceptional user-approved override path.

Harness support is not uniform. The host orchestration layer must probe exact
discovery, delivery, waiting, scope, and worktree-identity capabilities before
sending a request. Missing capability returns the structured manual next step;
it never selects an owner from a title or weak hint.

## Exact overrides

An override is an exceptional user handoff, not a way to suppress the guard.
When several preserved worktrees each need an override, record each exact
path-and-digest approval independently. The controller persists a valid
per-path override even while other paths remain blocked, so the sequence cannot
deadlock on an impossible all-at-once lease update.
Record it through `loop allow` only after the user explicitly names the work to
include. The command verifies and stores the preserved worktree's absolute
path, current content-sensitive change digest, current head, approver identity,
and reason. It does not accept a wildcard, repository-wide permission, or stale
digest. A later edit or commit changes the evidence and blocks the loop again.

`loop end` is the strict non-mutating completed-run primitive. At the terminal
boundary use `loop finalize` instead: in integration/reconciliation modes it
first removes unchanged clean target-contained worktrees and branches, prunes
stale worktree metadata, normalizes recoverable tracked primary paths already
identical to the target, and restores the primary. It then performs the
same completion gates and releases the lease when they pass, or relinquishes
the controller with a nonzero exit while preserving the incomplete run.

The opening lease records exact local branch names and revisions. Automatic
branch deletion accepts only an unchanged opening branch or a branch created by
the current run; an unattached branch that appears or moves later is preserved.
Final cleanup holds both loop and worktree-coordination locks, re-reads each
candidate's branch, head, digest, and claim state immediately before removal,
and durably records the exact opening-worktree removal intent before invoking
Git. If the controller dies after removal, that intent authorizes only the
matching absence so stale-lock recovery can resume without weakening any other
preserved-worktree check.

## Opening-worktree dispositions

Do not reinterpret changed, dirty, claimed, retained, late-arriving, or unique
opening work as cleanup. An opening worktree that remains unchanged across the
run, is clean and unclaimed, and has an exact head already contained in the
refreshed target is a normal automatic cleanup candidate. Use
`loop retain-worktree` when that checkout should stay. For exceptional changed
opening work, and for a worktree adopted into the lease mid-run through
`adopt-worktree` or `accept-paused-change`, `loop dispose-worktree` records a
manual removal disposition under the active lease; never fall back to raw
`git worktree remove` for lease-registered state. If such a preserved worktree
has already disappeared because its owning task removed it, `loop
retire-absent-worktree` records the absence instead: it accepts only a path
missing from disk and from the live worktree list, needs the loop owner and a
named approver, and leaves branches, claims, and delivery proof untouched. The command accepts only the
exact current path and content-sensitive status digest, requires the loop
owner and named approver, rejects the canonical primary checkout, and audits
that the worktree is clean and its head has zero unique commits outside the
lease's pinned canonical target revision, where a commit whose exact patch the
target already contains (a squash- or rebase-merged straggler) counts as not
unique and the proving method is recorded. The manifest records its branch,
head, digest, target ref and revision, approver, reason, and
zero-unique-commit result before deletion.

The disposition permits only that opening worktree's absence. It does not
remove the path, authorize `--force`, delete its branch, suppress other
violations, survive an intervening worktree change, or match when its recorded
target ref or revision differs from the active lease. Run the exact removal
through `loop exec` so preflight sees the recorded disposition and postflight
proves only the authorized path disappeared.

Concurrent cleanup must preserve every path and branch registered by an open
loop, including prepared authors, released claims, and stale or relinquished
runs. Run `prune` to clean eligible unrelated state; its deferred items belong
to the controller or a later pass after closure. Do not remove a registered
checkout through raw Git, filesystem deletion, or editor cleanup. The
controller's exact removal disposition already lets verification accept the
authorized absence without a separate repair. A missing path without that
evidence still requires investigation; a formerly clean HEAD does not prove
that no uncommitted work was lost.

## Exact retained exclusions

When the user explicitly wants a clean, target-contained, non-primary worktree
left in place and outside the shipment, use `loop retain-worktree` with its exact
current path and status digest. This records role `retained`, keeps mutation
disabled, and exempts the unchanged worktree from completed-run cleanup. It
does not remove, modify, include, push, or merge that worktree.

Any HEAD or digest change invalidates retention. If the worktree becomes active,
its owner must create or refresh an active claim; the lease then promotes it to
`concurrent-author`. Use harness owner discovery and delivery before asking the
user to pause another task. Without an active claim or stable pause, the moving
worktree remains a blocker.
