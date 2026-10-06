# GitLab adapter

Support tier: **beta target**.

Discover project identity, target branch, and actor through an authenticated
connector, REST/GraphQL API, or `glab`. Paginate merge requests, approvals,
discussions, and pipelines. Normalize IID as provider metadata; project identity
plus exact head SHA is the portable revision identity.

Create descriptions with real Markdown newlines, then fetch the stored
description and rendered result. Collect required pipeline jobs, approval rules,
unresolved discussions, draft state, conflicts, merge status, dependencies, and
the canonical merge commit.

Distinguish a skipped required job from success. When policy requires a
non-author reviewer/merger, route accordingly and invalidate approval after any
head change.

For cleanup, paginate the project branch endpoint and the complete MR corpus;
do not treat local `refs/remotes/*`, the project
`remove_source_branch_after_merge` default, or an individual MR's
`should_remove_source_branch` value as proof that the source branch was removed.
Correlate each branch name and `commit.id` with all matching `source_branch`
records and their current `state` and `sha`. Preserve the default branch, every
protected branch, any branch used by an open MR, and any branch whose head
changes between inventories.

Delete through the exact URL-encoded project/branch API target only after the
generic cleanup contract proves that exact head obsolete. A merged MR proves
obsolescence only when its recorded `sha` equals the current branch head and no
open MR uses the branch. Audit closed/unmerged and no-MR branches as separate
classes; preserve them unless target containment or an empty provider diff is
proven. After every bounded deletion, refresh evidence, then paginate all
branches again and record the final remote-branch reconciliation receipt. The
receipt's `project`, `targetBranch`, and `targetRevision` must describe the
refreshed project target exactly.

## Gate merges on hosted CI

A repository can refuse a merge whose hosted pipeline has not passed by
declaring an [`execGuard`](../setup-and-policy.md) in `.simple-changes.json` and
running merges through `loop exec`:

```json
{ "execGuard": ["sh", "scripts/exec-guard.sh"] }
```

The guard receives the exec argv after its own and lets every command it does
not gate pass:

```sh
#!/bin/sh
# Gate only `glab mr merge <iid>`; every other command passes.
if [ "$1" != glab ] || [ "$2" != mr ] || [ "$3" != merge ]; then
  exit 0
fi
status=$(glab mr view "$4" -F json --jq '.head_pipeline.status')
if [ "$status" != success ]; then
  echo "exec guard: the head pipeline of !$4 is ${status:-missing}" >&2
  exit 1
fi
```

Then `simple-changes loop exec --run-id <run> --agent-id <controller> -- glab mr
merge <iid> --sha <head>` merges only after the guard exits 0. A refusal leaves
the merge unstarted. A real guard also binds the pipeline to the exact `--sha`
being merged and decides how to treat skipped or manual jobs; it never replaces
the provider's own merge checks.
