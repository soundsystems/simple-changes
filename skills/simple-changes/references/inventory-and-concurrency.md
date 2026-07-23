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
