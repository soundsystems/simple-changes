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

## Executable lease and manifest

Queue, Sweep, Integrate, Ship, Reconcile, and Resume use one active lease stored
as `simple-changes/active-loop.json` beneath the repository's common Git
directory. `loop start` creates it atomically and records:

- the run and controller identities;
- the opening inventory digest, canonical target ref, and exact target revision;
- every worktree's exact path, branch, head, and content-sensitive change
  digest, including staged and unstaged patches plus untracked contents;
- whether the worktree is controller-owned, author-owned, or preserved; and
- exact user-approved overrides and audited removal dispositions, when any
  exist.

The lock directory prevents two cooperating agents from updating the manifest
or performing guarded local mutations at once. It records the owning PID, host,
operation, start time, random token, unresolved child-launch state, and any
guarded child/process-group identity. A second controller cannot replace an
active lease. Do not remove or rewrite the lock or state file by hand.

`loop guard` is a moment-in-time read-only preflight. It does not reserve a
future mutation. Run local Git and repository commands through `loop exec` so
the same atomic lock covers a fresh manifest check, one argument-array command,
and a fresh post-command check. The reusable callback awaits asynchronous work
under that same boundary. The operation requires that the caller's agent ID owns
the exact registered controller or author worktree on its recorded branch. It
rejects any new unregistered worktree, branch switch, incomplete preparation,
missing baseline worktree, or head/content change in a preserved worktree. Run
`loop verify` before merge, deployment, cleanup, and completion even when every
earlier operation passed.

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

Normal command completion is also process-group scoped. A direct command
leader that exits while background descendants remain does not complete the
guarded mutation. Terminate those descendants and reject the command before
releasing the lock. If the process group cannot be terminated, retain the lock
so explicit recovery must prove the remaining processes inactive.

## New agents during an active loop

An authoring agent must begin with `prepare-agent`. The command records a
pending preparation before creating a unique branch and sibling worktree from
the pinned target revision, then registers the completed worktree with the
active run and returns its exact path. Use that path as the agent's working
directory before it edits, formats, generates, stages, or commits files.
Repeating the command for the same agent ID returns the existing registration;
if creation stopped partway through, the same command validates and resumes the
recorded preparation instead of guessing or creating another branch. It refuses
to adopt staged, unstaged, or untracked content, and a registered author loses
mutation authority after switching away from the recorded branch.

Read-only review can inspect commit objects or provider diffs without an
authoring worktree. The moment a reviewer needs to make a change, it becomes an
author and must prepare an isolated worktree first.

## Exact overrides

An override is an exceptional user handoff, not a way to suppress the guard.
Record it through `loop allow` only after the user explicitly names the work to
include. The command verifies and stores the preserved worktree's absolute
path, current content-sensitive change digest, current head, approver identity,
and reason. It does not accept a wildcard, repository-wide permission, or stale
digest. A later edit or commit changes the evidence and blocks the loop again.

After all run-created worktrees are removed, `loop end` performs one last
manifest verification and releases the lease. It refuses to end while any
run-created worktree remains or any manifest violation is unresolved.

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
