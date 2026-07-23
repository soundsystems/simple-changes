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
