# Sync with the canonical remote target

Sync is a narrow local Git operation. It updates remote-tracking evidence and,
when the checkout is safe, incorporates the canonical remote target into the
current local branch. It does not publish local work or broaden into proposal,
merge, deployment, data-write, or cleanup authority.

## Resolve the exact target

Capture the current checkout, branch, HEAD, status, in-progress Git operations,
worktrees, and configured remotes before contacting a remote.

Resolve the canonical target from repository instructions or policy first, then
the current branch's remote/upstream and that remote's default branch. Use
`origin/main` only when repository evidence establishes it. Do not select an
unrelated remote because it is alphabetically first, named by a forge helper,
or happens to expose a `main` branch. If the remote or target remains ambiguous,
fetch nothing and ask for the exact target.

Fetch only the resolved remote and target. Do not use a blind `git pull`, fetch
every remote, prune refs, update submodules, or fetch tags unless repository
policy requires it. Record the target revision before and after the fetch.

## Classify before changing the branch

After the fetch, compute exact ahead/behind and ancestry evidence for the current
HEAD and refreshed target.

| Checkout state | Safe Sync result |
| --- | --- |
| Dirty, conflicted, detached, or mid-operation | Fetch only; preserve the checkout and report the exact blocker |
| Canonical target, behind only | Fast-forward only to the refreshed target |
| Canonical target, current | No-op and report current evidence |
| Canonical target, ahead or diverged | Do not push, reset, rebase, or create a surprise merge; report the local commits and recommended recovery |
| Feature branch already containing the target | No-op and report current evidence |
| Clean feature branch missing target commits | Preflight the repository-approved update strategy; default to a normal local merge |

For a clean feature branch, inspect conflicts without changing the working tree
when Git supports a merge-tree preflight. If conflict risk is found, stop before
the merge and report the affected paths. Never leave a failed Sync in a
conflicted state.

Rebase only when the current request explicitly asks for it or an established
repository policy selects it and the branch is proven owned and unpublished.
Generic Sync never authorizes a force push or rewriting shared history.

## Authority boundary

A Sync request authorizes:

- read-only inventory and exact-target fetch;
- a fast-forward of a clean local canonical target;
- a conflict-preflighted local update of the clean current feature branch.

It does not authorize:

- pushing local commits or tags;
- opening, updating, approving, or merging a proposal;
- deploying or releasing;
- remote migrations, backfills, secrets, domains, or store actions;
- pruning uncertain refs, deleting branches, stashing work, resetting, or
  rewriting published history.

## Finish from evidence

Report the exact remote target, its fetched revision, the original and resulting
local HEADs, the ahead/behind relationship, the applied strategy, and whether
the worktree remained clean or was preserved unchanged. When a feature branch
was updated, run repository-native proportionate checks and distinguish
introduced failures from baseline failures. A fetch-only result is successful
remote refresh, not a fully synchronized checkout.
