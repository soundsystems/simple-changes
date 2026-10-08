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

## What an agent review examines

When an agent performs the independent review, first pin the exact base and
head revisions and confirm the diff between them is non-empty; a bad revision
or empty diff stops the review before any reviewer is dispatched. Then review
on two separate axes:

- **Standards**: does the change follow the repository's documented
  standards (contributing guides, coding standards, agent instructions)? Cite
  the file and rule for each finding, and skip what tooling already enforces.
- **Spec**: does the change do what its originating issue or spec asked?
  Find the source from the proposal description, commit trailers such as
  `Closes #42`, the branch name, or the issue tracker. Report requirements
  that are missing or partial, behavior nobody asked for, and requirements
  that look implemented but behave wrongly, quoting the spec line for each.
  When no source exists, report `no spec available` rather than inferring
  one from the diff.

Run the axes as separate reviewers when the host can start them, so neither
shapes the other. Report each axis under its own heading with its worst
finding, without merging or reranking across axes: a change can follow every
standard and still build the wrong thing. A requirement deliberately left
out belongs in the proposal's Summary as out of scope; otherwise a Spec
finding is actionable like any other.

Emergency Ship does not weaken merge policy. `expedited` completes independent
review before merge and initial deployment. Current-request or saved-policy
authorized `break-glass`
may deploy one exact candidate before focused checks and independent review,
but it does not merge through protected branches early or represent the
deployment as approval. Request review of the exact deployed revision
immediately after its health verification and focused checks. If review
requests changes, move to `rollback-required` and either restore the recorded
production revision or produce a separately checked corrective revision.
Never merge or release-reconcile a rejected live candidate as though it passed.

Address actionable findings inside the intended unit, rerun relevant checks,
push the new revision, and request/re-run review against that revision. Keep
unrelated findings out of the unit unless they are required for correctness.
For Ship, record each material review-driven change against the proposal's
original reviewed head: the request or discussion, resulting commit and
behavioral delta, checks rerun, approval invalidation, and approval obtained for
the replacement head. This evidence feeds the final shipped-state summary; when
review changed nothing, record that explicitly instead of inventing a delta.

Merge in dependency order only when the current revision satisfies policy.
Integrate a released, handed-off, or preserved unit locally by its recorded
commit ID, never its branch name, which `loop exec` refuses; see
[inventory and concurrency](inventory-and-concurrency.md#integration-controller-lease-and-concurrent-authors).
Return the canonical merged commit/revision and refresh downstream units after
their base changes. Missing authentication, unavailable reviewers, and
unsupported provider capabilities are blockers with distinct statuses, not
guessed success.

When repository or provider policy requires the merger to be independent from
the author, record the approved revision and executor identity separately and
re-check both immediately before merge. Do not convert a policy-required
non-author merge into an author merge merely because an independent review
already exists.

## Signing reviews and merges

When `proposalSignatures` is `agent-and-version` (the default), the agent that
completes an independent review appends `[[Reviewed by <model name>
<version>]]` to the proposal's signature block, and the agent that merges
appends `[[Merged by <model name> <version>]]` immediately before the merge,
both in the format defined in
[change proposals](change-requests.md). Post the same review line as the
review comment or approval body when the provider supports one, and add the
trailer `Merged-By-Agent: <model name> <version>` to the merge commit message
when the provider lets the merger set it. Author and reviewer signatures from
the same model name and version still do not make a review independent; the
independence rule above is decided by executor identity, not by signatures.
