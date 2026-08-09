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
