# Review and merge

Contents:

- What an agent review examines
- Review identity and the review ledger
- Review rounds
- Signing reviews and merges

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

## Review identity and the review ledger

Two requirements apply. **Executor independence** is the rule above: the
reviewer is a separate agent or session from every author of the change.
When the review role sets `adversarial: true`, review also needs
**diversity**: a different harness, or the same harness with a different
model ID, from every author. Model IDs are what harnesses report, such as
`model-5-5`, compared exactly after folding case and one `provider/`
prefix; a display name, an effort label, or a note is not an ID. Within one
harness a missing or non-ID name on either side fails closed
(`author-identity-missing`, `reviewer-identity-missing`, or, before
dispatch, `reviewer-model-id-missing`) with the next step; across harnesses
a reported name is enough. Before a proposal is named, the author is the
configured `proposals` model, so a missing author ID there is fixed with
`setup --authoring`; after, it is a recorded attestation, which its author
completes. Diversity adds to executor independence and never
replaces it.

The evidence lives in `review-ledger.json` under `<common git
dir>/simple-changes/`, beside the loop lease. Each write takes the loop lock,
validates the whole file, and replaces it atomically. A malformed ledger is
reported, never repaired silently, and blocks acceptance until the owner
repairs it.

The ledger root, each attestation, each completion, and each review attempt
may carry an `extensions` object for fields a newer Simple Changes adds. A
reader accepts any members in it without interpreting them, every write keeps
them byte for byte, and a new ledger has none. A ledger holding extensions
spelled otherwise than Simple Changes writes JSON (a number, string escape,
key order, repeated key, or a byte that is not valid UTF-8), for example after
a hand edit, reads as malformed, since no write could keep them exactly; one
that differs only in spacing is read but never rewritten, and no write drops
or changes an extensions object the file holds. A field goes there only when
a reader that ignores it can only be stricter, never looser, the way findings
without `severities` still escalate. A field that could loosen a gate goes
outside `extensions`: a runtime that does not know it reads the ledger as
malformed and says a newer Simple Changes may have written it, so update that
runtime. Runtimes before 0.32.0 reject `extensions` too.

- **Attestation.** Authors attest every commit, and replays link rewritten
  commits to their sources ([ledger steps](change-requests.md#review-ledger-steps)).
  Effective authors follow those links at read time, so a later attestation
  anywhere in a commit's ancestry counts at once. An author may complete its
  own earlier attestation that lacked an instance or model ID, a display
  name included (`--complete-identity`); the earlier record stays in the
  ledger and still rules out any reviewer it ruled out as the same executor,
  but its missing instance or model ID no longer leaves independence or
  diversity unknown. No
  other commit or replay source changes. A completion an earlier runtime
  wrote under its rule, which compared reported names, stays valid; a
  display name it added is still not a model ID.
  A runtime before 0.31.0 reads a ledger holding a completion that adds a
  model ID to a display-name record as malformed, so update every runtime
  that shares the repository before completing one.
- **Coverage.** `proposal record-authors` binds a head to the effective
  authors of its range and computes `authorsDigest`. A commit with no author,
  a replay source with none, and an inconclusive replay nobody attested are
  gaps; a head with no gaps is fully covered. `author coverage --base
  <target> --head <sha>` reads the same coverage and digest before any
  proposal exists, writes nothing, and never counts a waiver.
- **Before dispatch.** `initialize --proposal <id> --head <sha>
  [--authoring-request <json-or-@path>]` resolves the reviewer against that
  head, with the current request's answer on top when one is passed;
  incomplete coverage is `unresolved` under either setting. Under `adversarial: true`, a `blocked` or `unresolved`
  reviewer stops the review step: ask the owner, and never review your own
  proposal to fill the gap.
- **Before dispatching an author.** Under `adversarial: true`, run
  `reviewer room --would-author <harness id>/<model ID>` before starting any
  author, a fix author after findings and one whose release notes will be
  copied into implementation commits included. Pass `--base <target> --head
  <sha>` for the commits so far and `--proposal <id>` once one exists, plus
  the run's `--authoring-request`. It writes nothing. It counts every attested
  author of the range and of the proposal's latest recorded head, adds each
  would-be author, and checks the review model at the effort the escalation
  floor requires now (`required.effort`) and after escalating findings
  (`required.escalationEffort`). Each route, the configured one, other
  detected harnesses, and any harness a reported run names, shows its
  `eligibility`, the conflicting authors with the commits that introduced
  them, and `ruledOutByWouldAuthor`. `status` is `open` (exit 0) only when the
  configured reviewer stays eligible; `alternative-only` means only another
  harness running the same model would, which the owner must choose;
  `closed` means this author would leave no eligible reviewer; `unknown`
  means evidence is missing, such as a display name or effort label instead
  of a model ID, an unattributed commit, or an unreadable ledger, and counts
  as closed. An effort label, even inside an ID such as `model-5-5-xhigh`, is
  never a different model, and a coverage waiver does not count here. For
  anything but `open`, pick another author model or harness, or ask the
  owner, before dispatching.
  A route counts as available only after a real run of that model at that
  effort, never from credential, sign-in, or status text; report such a run
  with `--verified-route <harness id>/<model ID>@<effort>`, and otherwise
  availability stays `unknown`.
- **Coverage waivers.** Only the owner waives, before dispatch:
  `proposal waive-coverage --proposal <id> --head <sha> --authors-digest
  <digest> --receipt <waiver.json>` with `{"approvedBy", "reason",
  "unattributed": [<sha>], "gaps": {<commit>: {"unresolvedSources",
  "uncoveredEdits"}}}` naming exactly the outstanding items. A waiver covers
  only what it names and goes stale when the digest changes.
- **Post-return gate.** Record every returned review with `proposal
  record-review --proposal <id> --head <sha> --attempt-id <uuid> --receipt
  <attempt.json>` holding `requested` (`harness`, `model`, `effort`),
  `verified` (`instance`, `session`, `harness`, `agent` as the delegate
  reported them, `null` when not), `effort`, `effortSource`, `verdict`
  (`findings`, `clean`, `failed`), and `findingsCount`, plus `severities`
  (`blocking`, `shouldFix`, `nit` counts adding up to `findingsCount`) when
  the reviewer graded its findings. Pass the same
  `--authoring-request` as `initialize`: a request can make the gate
  adversarial for this run and never loosens a saved setting. It is accepted
  only when the head is covered or waived, the reviewer's instance or
  session differs from every author's, and, when adversarial, its harness or
  model differs too. Missing evidence rejects; a `clean` verdict never proves
  independence; a rejected attempt stays rejected. Disclose a reported
  identity that differs from the target.
- **Approval.** Reviewed means an accepted `clean` attempt on the current
  head whose digest still matches, plus the fresh evidence above. Resume
  (`loop start --mode resume`, with the run's `--authoring-request`)
  revalidates accepted attempts under the run's gate; one that no longer
  passes needs a fresh review.
- **Escalation as a floor.** With `escalateOnFindings` set, once a review of
  a proposal reports escalating findings, later reviews of it, replacement
  revisions included, run at least at that effort. Escalating findings are
  blocking or should-fix ones, or any finding under `reviewLoop.escalateOn:
  "any"`; findings recorded without `severities` always escalate. It never
  lowers an effort and never reaches `max` by itself; a `max` the user asks
  for is recorded with `effortSource: "request"`.

## Review rounds

Run review as a loop at the exact head, rounds counted per proposal:

- Ask the reviewer to give each finding a severity, **blocking**,
  **should-fix**, or **nit**, with its file and line, the inputs, and the wrong
  result, and record them as `severities`. Fix nits too; by default only
  blocking and should-fix findings escalate (`reviewLoop.escalateOn: "any"`
  escalates on every finding).
- After the first round, scope each re-review to the fixes, the boundary they
  protect (what must never break), and what they touched. Before merge, run
  one full-range review at the final head. A clean review counts only for the
  head it read.
- Tell the reviewer which findings the user deferred or accepted, so it does
  not report them again.
- `initialize --proposal <id> --head <sha>` reports `reviewer.loop`:
  `consecutiveEscalatingRounds`, `roundsSinceEscalation`, the
  `convergenceCheck` (`due` at `reviewLoop.convergenceRounds`, default 2), and
  the `roundCap` (`reached` at `reviewLoop.roundCap`, default 4), with a
  `message`. A round is a review with findings, accepted or not, or an
  accepted clean review, which starts the loop over; failed reviews and clean
  reviews the gate rejected are no round. When the check is due and those findings sit in one area, stop
  patching: say whether the approach is the problem and propose an
  alternative before the next fix. When the cap is reached, stop and ask the
  user whether to ship with the open findings filed as issues, change the
  design, or keep reviewing. The runtime counts rounds; judging the area is
  yours, and neither signal approves or skips a review.

## Signing reviews and merges

When `proposalSignatures` is `agent-and-version` (the default), the agent that
completes an independent review appends `[[Reviewed by <model name>
<version>]]` to the proposal's signature block, and the agent that merges
appends `[[Merged by <model name> <version>]]` immediately before the merge,
both in the format defined in
[change proposals](change-requests.md). Post the same review line as the
review comment or approval body when the provider supports one, and add the
trailer `Merged-By-Agent: <model name> <version>` to the merge commit message
when the provider lets the merger set it. A delegated review is signed with
the model the reviewer reported, never the configured preference. Author and
reviewer signatures from
the same model name and version still do not make a review independent; the
independence rule above is decided by executor identity, not by signatures.
