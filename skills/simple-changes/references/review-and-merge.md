# Review and merge

Review eligibility comes from fresh provider and repository evidence:

- exact current head or patch revision;
- required checks and their conclusions;
- required reviewers and independent-review rules;
- approvals bound to that revision;
- unresolved blocking discussions;
- draft state, conflicts, mergeability, and dependencies.

Any new commit, rebase, conflict resolution, or dependency refresh invalidates
approval for the previous revision. Re-fetch checks and discussions as well.
Self-review is never represented as independent review.

Address actionable findings inside the intended unit, rerun relevant checks,
push the new revision, and request/re-run review against that revision. Keep
unrelated findings out of the unit unless they are required for correctness.
For Ship, record each material review-driven change against the proposal's
original reviewed head: the request or discussion, resulting commit and
behavioral delta, checks rerun, approval invalidation, and approval obtained for
the replacement head. This evidence feeds the final shipped-state summary; when
review changed nothing, record that explicitly instead of inventing a delta.

Merge in dependency order only when the current revision satisfies policy.
Return the canonical merged commit/revision and refresh downstream units after
their base changes. Missing authentication, unavailable reviewers, and
unsupported provider capabilities are blockers with distinct statuses—not
guessed success.

When repository or provider policy requires the merger to be independent from
the author, record the approved revision and executor identity separately and
re-check both immediately before merge. Do not convert a policy-required
non-author merge into an author merge merely because an independent review
already exists.
