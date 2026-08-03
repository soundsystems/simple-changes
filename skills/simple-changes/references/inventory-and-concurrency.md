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
- the opening inventory digest and canonical target ref;
- every worktree's exact path, branch, head, and status digest;
- whether the worktree is controller-owned, author-owned, or preserved; and
- exact user-approved overrides, when any exist.

The lock directory prevents two agents from updating the manifest at once. A
second controller cannot replace an active lease. Do not remove or rewrite the
state file by hand to bypass a conflict.

Run `loop guard` immediately before a mutation from the checkout that will
change. The guard requires that the caller's agent ID owns that registered
controller or author worktree. It also rejects any new unregistered worktree,
any missing baseline worktree, and any head or status change in a preserved
worktree. Run `loop verify` before merge, deployment, cleanup, and completion
even when every earlier guard passed.

## New agents during an active loop

An authoring agent must begin with `prepare-agent`. The command creates a unique
branch and sibling worktree from the recorded canonical target, registers the
worktree with the active run, and returns the exact path. Use that path as the
agent's working directory before it edits, formats, generates, stages, or
commits files. Repeating the command for the same agent ID returns the existing
registration instead of creating another branch.

Read-only review can inspect commit objects or provider diffs without an
authoring worktree. The moment a reviewer needs to make a change, it becomes an
author and must prepare an isolated worktree first.

## Exact overrides

An override is an exceptional user handoff, not a way to suppress the guard.
Record it through `loop allow` only after the user explicitly names the work to
include. The command verifies and stores the preserved worktree's absolute
path, current status digest, current head, approver identity, and reason. It
does not accept a wildcard, repository-wide permission, or stale digest. A
later edit or commit changes the evidence and blocks the loop again.

After all run-created worktrees are removed, `loop end` performs one last
manifest verification and releases the lease. It refuses to end while any
run-created worktree remains or any manifest violation is unresolved.
