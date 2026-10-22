# Replacement lineage and old source branches

Contents:

- Audit before reapplying
- Remove a reviewed replaced checkout
- Record future replacements

An old branch can have unique commits even when its feature is already shipped.
Rebasing with conflict resolutions, moving a shipment to a replacement branch,
or relocating release notes can change its patch ID. Neither an unmatched patch
nor an absent MR for the original branch proves that work remains to ship.

## Audit before reapplying

Before creating a worktree, rebasing, cherry-picking, or merging an old local
branch, run `simple-changes branch audit --head <branch> --target <ref> --json`
against the refreshed target. A unique SHA or a missing MR on that branch name
does not establish unshipped work. Resolve replacement candidates against merged
proposals and independent review first. Record original SHAs
in replacement commits when moving work to a different branch. Discovery hints
never permit deletion or waive the existing cleanup proofs.

Run this read-only check from the primary checkout before creating a worktree
or merging, rebasing, or cherry-picking an old source:

```sh
simple-changes branch audit --head <source-ref> --target <ref> --json
```

The command resolves both refs to immutable commits. Exact ancestry reports
`target-contained`; otherwise it searches commits reachable from the target
after the merge base for two kinds of advisory replacement candidates:

- a full `Original-Commit` trailer identifying a source commit;
- an identical commit subject and at least one changed path in common.

It returns every audited source commit, candidate SHAs, shared paths, and Git
argument arrays for `range-diff`. Inspect each candidate's real diff and merged
proposal even when its branch name is different. Subjects and trailers are
untrusted metadata; do not execute their contents. A matching title alone, a
trailer, an end-state comparison, or a `range-diff` pairing never establishes
semantic equivalence or grants deletion authority. A target can also contain a
later revert; review the current behavior and subsequent changes.

Use an independent reviewer to compare all source commits with the actual
replacement range and current target. If even one source commit remains
unaccounted for, retain it as outstanding work. `unproven` means that the audit
found no usable candidate, not that the work is new. The search is bounded to
200 source commits, 1,000 target commits, and 10 candidates per source commit;
truncation flags require further investigation. Renamed subjects, squashes,
and changed file paths can defeat legacy discovery. Query merged proposals
across branch names and use the full historical range when needed.

`worktree equivalence` includes the same advisory audit when it has unmatched
commits. Neither audit changes a cleanup decision or supplies a receipt:
cleanup still requires ancestry or patch proof unless the user approves a
reviewed lineage receipt (below). Without one, preserve a source that review
shows already shipped and report that distinction. Do not fabricate a patch
match or bypass the guard with forced branch/worktree removal.

## Remove a reviewed replaced checkout

A clean local checkout whose unique commits shipped through different
replacement commits can be removed with a lineage receipt, passed as
`--lineage-receipt <file>` to `prune` (with `--agent-id <you>`) or
`worktree cleanup`. Without the flag, both commands behave as before. The
receipt (`evals/schemas/replacement-lineage-receipt.schema.json`) names:

- the source: `path`, `branch` (or null when detached), `headRevision`,
  `changeDigest` (the clean status digest from the live inventory), and
  `authorAgentId`;
- `targetRef` and the reviewed `targetRevision`;
- `commits`: each commit the reviewed target lacks, once, with the
  replacement commits in the target that carry it;
- `review`: an independent `reviewerAgentId`, `reviewReference`,
  `reviewedAt`, and `decision: "replaced-in-target"`;
- `approval`: the user's `approvedBy`, `approvalReference`, `approvedAt`, and
  `reason`, given after the review.

Build it from `branch audit` and the reviewer's verdict, then run `prune
--dry-run` first. The command checks every fact against live Git and refuses,
writing nothing, when the checkout is dirty, locked, claimed (any claim not
released), or registered by an open lease; another checkout has its branch
checked out; its branch or head differs from the
receipt (for example, it moved after the review); the clone is shallow; the
target already contains the head (cleanup then removes it as
`target-contained` or `patch-equivalent`, with no receipt); a unique commit is
unmapped or the mapping names a commit that is not unique; a replacement is not
in the reviewed target or is an ancestor of the head; the current target no
longer contains the reviewed target; the reviewer is the controller, the
declared author, an agent that ever claimed the checkout, or an attested
author of a unique commit, including an author it inherits from a replay
record's sources; the approver is the reviewer, the controller, or an
author, or differs from `--approved-by`; or the approval predates the review,
is in the future, or is more than 24 hours old.

Byte identity is recorded, not required. The command runs the exact-byte
proof against the reviewed target and reports `byteProof`: `proven` when every
path the source touched equals the target, or `not-proven` with the differing
paths when the replacement refined the bytes during review. In that case the
reviewed mapping, the review, and the approval are the evidence.

Before removal, the command pins the head at
`refs/simple-changes/superseded/replacement-lineage-<receipt digest>/<head>`,
so the source history survives; restore the branch from that ref if needed.
It writes an intent record, reads the checkout once more (status first, then
its head and branch), removes it with plain `git worktree remove`, deletes the
branch only while no checkout uses it and it still points at the pinned head,
and writes a completion record, both under
`<git common dir>/simple-changes/replacement-lineage/`. It forces nothing.

From the check before the pin through the branch deletion, every Git command
runs with `--no-pager --no-lazy-fetch -c core.hooksPath=/dev/null -c
core.fsmonitor=false`, and with `clean`, `smudge`, and `process` emptied and
`required` off for every filter driver that the effective configuration of
the primary or the source checkout defines (system, global, local,
`config.worktree`, included files, and `GIT_CONFIG_*` environment).
Attributes from any source only name drivers, so this covers them all. The
command reads these settings back in both checkouts first and refuses,
writing nothing, when either does not confirm them. It also refuses a source
with submodules, a partial clone, a hook configured through `hook.*`, and
`core.virtualFilesystem`.
So no program the repository or the user configures runs between reading the
checkout and removing it. A filter-managed file whose status Git would have
to rehash can then read as changed, and the command then keeps the checkout.
The other removal methods keep running the repository's hooks as before.

This removal runs before every other removal and before `worktree cleanup`
writes its history. If the checkout changed after verification, or
was not removed for any other reason, the run stops there: no other checkout
is removed and no cleanup history is written, and the pin and the two records
say what happened. Review the checkout again before writing a new receipt.

The removal is reported as method `reviewed-replacement`, in
`reviewedReplacement` and in prune's plan; `worktree cleanup` keeps it out of
its cleanup history, which older runtimes validate strictly.

## Record future replacements

Before rewriting or transplanting committed work, retain each full original
commit SHA. Add a Git trailer to each corresponding replacement commit:

```text
Original-Commit: <full-original-commit-sha>
```

For a squash, use one trailer per original commit. Preserve prior trailers
through subsequent rewrites, and add the immediately replaced commit as well.
Only record source commits whose changes the replacement intentionally carries;
the trailer records provenance, not independent approval. Keep the mapping of
original branch/head, replacement branch/head, and proposal identity in the
proposal description and shipment evidence. Re-read it after proposal updates.
Do not amend already merged history to backfill a missing trailer.

The trailer is Git provenance; review independence reads the review ledger.
After every rebase, cherry-pick, or squash, attest each new commit with
`author attest --commit <new sha> --replays <original sha>[,...]`, after
`loop exec` returns and with `--worktree <path>` when the controller refreshes
a delegated worktree. Add `--contribution implementation` whenever the
transplant changed the implementation, then run `proposal record-authors` for
the new head before review ([review ledger steps](change-requests.md#review-ledger-steps)).

After merge, verify the replacement SHA is reachable from the refreshed target,
review differences introduced during transplantation, and account for source
commits added afterward. Follow ordinary reviewed cleanup; a lineage claim
must never erase newer work, dirty files, or an active author's checkout.
