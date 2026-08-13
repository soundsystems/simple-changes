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
active lease without an exact, user-authorized takeover, but independent agents may continue normal edits and commits in
distinct actively claimed worktrees. Do not remove or rewrite the lock or state
file by hand.

`loop guard` is a moment-in-time read-only preflight. It does not reserve a
future mutation. Run local Git and repository commands through `loop exec` so
the same atomic lock covers a fresh manifest check, one argument-array command,
and a fresh post-command check. The reusable callback awaits asynchronous work
under that same boundary. The operation requires that the caller's agent ID owns
the exact registered controller or run-author worktree on its recorded branch.
It rejects any new unclaimed worktree, branch switch, incomplete preparation,
missing baseline worktree, or head/content change in a preserved worktree. Run
`loop verify` before merge, deployment, cleanup, and completion even when every
earlier operation passed.

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

If a process crashes, `loop recover` removes a lock only when its ownership
metadata is valid, it is older than the recovery boundary, the recorded host is
the current host, the controller PID is provably dead, child launch is fully
recorded, every recorded child/process group is inactive, and the caller owns
the active lease. A live, remote-host, young, ownerless, malformed, unresolved,
or still-running process-group lock remains a blocker.

The transient lock and persistent controller lease have different recovery
paths. `loop recover` never transfers the persistent lease. A controller that
reaches the end of its agent turn must run `loop finalize`: a fully reconciled
run closes and deletes the lease, while an incomplete run records its blockers,
marks the controller `relinquished`, disables its mutation authority, and keeps
all ledger evidence. The next controller starts with mode `resume` (or the same
original mode), adopts that exact run ID, and continues from fresh evidence.

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

## Owner claims and safe pauses

Every owner-created worktree should be claimed immediately with `worktree
claim`. The claim lives beneath the common Git directory, binds the canonical
path, repository identity, branch, HEAD, content-sensitive digest, owner agent,
adapter slug, and opaque `ownerRef`, and is written atomically with mode `0600`.
Do not put titles, prompts, message bodies, credentials, or tokens in the owner
reference.

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
any unrelated manifest violation remains. `loop allow` remains the separate
exceptional user-approved override path.

Harness support is not uniform. The host orchestration layer must probe exact
discovery, delivery, waiting, scope, and worktree-identity capabilities before
sending a request. Missing capability returns the structured manual next step;
it never selects an owner from a title or weak hint.

## Exact overrides

An override is an exceptional user handoff, not a way to suppress the guard.
Record it through `loop allow` only after the user explicitly names the work to
include. The command verifies and stores the preserved worktree's absolute
path, current content-sensitive change digest, current head, approver identity,
and reason. It does not accept a wildcard, repository-wide permission, or stale
digest. A later edit or commit changes the evidence and blocks the loop again.

`loop end` is the strict completed-run primitive. At the terminal boundary use
`loop finalize` instead: it performs the same completion gates and releases the
lease when they pass, or relinquishes the controller while preserving the
incomplete run when they do not.

## Opening-worktree dispositions

Do not reinterpret an opening preserved worktree as run-created cleanup. It
remains protected until `loop dispose-worktree` records a removal disposition
under the active lease. The command accepts only the exact current path and
content-sensitive status digest, requires the loop owner and named approver,
rejects the canonical primary checkout, and audits that the worktree is clean
and its head has zero commits outside the lease's pinned canonical target
revision. The manifest records its branch, head, digest, target ref and revision,
approver, reason, and zero-unique-commit result before deletion.

The disposition permits only that opening worktree's absence. It does not
remove the path, authorize `--force`, delete its branch, suppress other
violations, survive an intervening worktree change, or match when its recorded
target ref or revision differs from the active lease. Run the exact removal
through `loop exec` so preflight sees the recorded disposition and postflight
proves only the authorized path disappeared.

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
