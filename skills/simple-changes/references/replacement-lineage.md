# Replacement lineage and old source branches

An old branch can have unique commits even when its feature is already shipped.
Rebasing with conflict resolutions, moving a shipment to a replacement branch,
or relocating release notes can change its patch ID. Neither an unmatched patch
nor an absent MR for the original branch proves that work remains to ship.

## Audit before reapplying

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
commits. Cleanup continues to require its existing ancestry or patch proofs.
This command neither changes that decision nor supplies an equivalence receipt.
When semantic review establishes already-shipped work but mechanical cleanup
still refuses it, preserve the source and report that distinction. Do not
fabricate a patch match or bypass the guard with forced branch/worktree removal.

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

After merge, verify the replacement SHA is reachable from the refreshed target,
review differences introduced during transplantation, and account for source
commits added afterward. Follow ordinary reviewed cleanup; a lineage claim
must never erase newer work, dirty files, or an active author's checkout.
