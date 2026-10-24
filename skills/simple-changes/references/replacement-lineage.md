# Replacement lineage and old source branches

Contents:

- Audit before reapplying
- Remove a reviewed replaced checkout
- Restore an archived checkout
- Archive retention
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
removal is reversible: the checkout is archived before it is removed, and
`worktree restore-archive` brings it back (below). The receipt
(`evals/schemas/replacement-lineage-receipt.schema.json`) names:

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

Build it from `branch audit` and the reviewer's verdict. Before asking for
the approval, tell the user what the removal keeps and for how long: the
checkout is archived whole, and the archive expires after the repository
policy's `archiveRetention.days` (default 14) or sooner once the archives
together exceed `archiveRetention.maxTotalBytes` (default 2 GiB), so the
approval covers that. Then run `prune --dry-run` with the receipt: its plan
confirms the archive's size and expiry before anything is written. The command checks every fact against
live Git and refuses, writing nothing, when the checkout is dirty, locked,
claimed (any claim not released), or registered by an open lease; another
checkout has its branch checked out; its branch or head differs from the
receipt (for example, it moved after the review); the clone is shallow; the
target already contains the head (cleanup then removes it as
`target-contained` or `patch-equivalent`, with no receipt); a unique commit is
unmapped or the mapping names a commit that is not unique; a replacement is not
in the reviewed target or is an ancestor of the head; the current target no
longer contains the reviewed target; the archive would exceed
`--max-archive-bytes` (default 2 GiB) or the free space; the environment sets
`GIT_INDEX_FILE`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` or
`GIT_NAMESPACE`; or the approval predates the review, is in the future, or
is more than 24 hours old.

The reviewer must be independent, and so must the approver: neither may be
the controller, the declared author, the recorded owner of any claim on the
checkout's path or branch (released claims included), either side of a
reassign takeover of such a claim, or an attested author of a unique commit,
including an author inherited from a replay record's sources; the approver
may not be the reviewer. The agent that only carried out a release takeover
never owned the claim and may review. A claim whose owner reference says
`takeover:` or whose release reason is `takeover` while the takeover history
holds no matching receipt refuses, because its earlier owners cannot be
read. The check is proportionate because the removal is reversible: a
mistake restores.

Byte identity is recorded, not required. The command runs the exact-byte
proof against the reviewed target and reports `byteProof`: `proven` when every
path the source touched equals the target, or `not-proven` with the differing
paths when the replacement refined the bytes during review. In that case the
reviewed mapping, the review, and the approval are the evidence.

What the removal does, in order, under the cleanup locks: it reads the
checkout inside the hardened boundary (status, head, branch, its private Git
directory, the objects its own refs and pseudo-refs name, the commits only
its reflogs keep, its branch configuration); copies the checkout folder and
its private Git directory, never following a link, into
`<git common dir>/simple-changes/archives/<archive id>/` with a manifest
that records every file's mode, size and SHA-256 and verifies the copy;
pins the head and every object the checkout named under
`refs/simple-changes/archives/<archive id>/` (`head` and `objects/<id>`),
so an autostash, a rebase's original head or a per-worktree ref stays
reachable; pins the same way every commit that its HEAD's reflog, its
branch's reflog or its own refs' reflogs name and that no ref reaches
(Simple Changes' own expiring pins do not count), because the removal
deletes those reflogs and an amended-away or reset-away commit would
otherwise be left to `git gc`; writes an intent record; compares the live
files with the manifest once more, with no Git command in the checkout in
between, and checks that Git still registers the reviewed head and branch
there; when
anything changed it refuses and keeps the checkout, and the complete archive
stays with its pins, named by the completion record, until retention prunes
it or `worktree prune-archives --archive <id>` does; removes the checkout
with plain `git worktree remove`; deletes
the branch only while no checkout uses it and it still points at the pinned
head, with its configuration section (the manifest keeps the entries for
restore); and writes a completion record, both under
`<git common dir>/simple-changes/replacement-lineage/`. It forces nothing.
A failure before the archive is complete leaves no archive; a failure after
it keeps the archive; a removal Git could not finish is reported as "not
removed by this run" with the restore command.

The hardened boundary is unchanged: from the check before the archive
through the branch deletion, every Git command runs with `--no-pager
--no-lazy-fetch --no-optional-locks -c core.hooksPath=/dev/null -c
core.fsmonitor=false`, with every filter driver either checkout's effective
configuration defines emptied and read back, and the command refuses a
source with submodules, a partial clone, a hook configured through
`hook.*`, `core.virtualFilesystem`, and a Git state file in the checkout's
private directory larger than the 1 MiB the object scan reads (such as a
`FETCH_HEAD` grown by repeated `git fetch --append`), because the objects
it names could not all be pinned. It also refuses, and keeps the checkout,
when its reflogs keep more than 2,000 commits that no ref reaches, rather
than archive it with part of that history; put the work still needed on a
branch first. These settings are hardening, not a
guarantee. As on the other removal paths, programs that the repository or
the user configures are trusted (a filter driver whose name the command
cannot read back exactly is a known case, tracked as issue #20). A run with
a receipt also keeps `git status` from refreshing any index, so a refusal
that says nothing was written is exact.

The removal runs before every other removal and before `worktree cleanup`
writes its history. If the checkout was not removed, the run stops there:
no other checkout is removed and no cleanup history is written. It is
reported as method `reviewed-replacement` in `reviewedReplacement` and in
prune's plan, with the archive ID, size, expiry and pins; `worktree
cleanup` keeps it out of its cleanup history, which older runtimes validate
strictly. The archive does not keep extended attributes, resource forks or
ACLs: it keeps what Git keeps.

## Restore an archived checkout

`simple-changes worktree restore-archive --archive <id>` recreates the
checkout at its recorded path from the archive and the pins: it verifies the
archive against its manifest, refuses when anything exists at the path or at
the private Git directory, when Git still lists the path, when the parent
folder is gone, when the head commit is no longer in the repository, or when
the branch exists at another commit or is checked out elsewhere; recreates
the branch at the pinned head and its configuration section when absent;
copies the files back; and confirms Git lists a clean checkout there. A
restore that stops half way leaves a `restoring.json` marker in the archive,
so automatic pruning keeps it until a restore succeeds or it is pruned by
ID. `--extract-to <folder>` copies the verified archive into an empty folder
instead, for manual recovery. `worktree archives` lists every archive with
its expiry and pins.

## Archive retention

Archives never need managing. Each expires after the repository policy's
`archiveRetention.days` (default 14), or sooner, oldest first, once the
archives together exceed `archiveRetention.maxTotalBytes` (default 2 GiB);
an archive that is kept, because a pin is blocked or its deletion fails
when tried, frees nothing, so the next-oldest is chosen until the total is
under the cap (a dry run plans from the pin values it reads, so it cannot
foresee a deletion that fails only when tried).
`prune`, `worktree cleanup` and `loop finalize` prune expired archives
automatically, at the end of a run whose removals succeeded (never the
archive that run made, and never on a run that refused), and report what
they pruned and what they kept. A prune deletes the archive's pins first,
all in one Git transaction, and removes the folder only once every pin is
gone; an archive with a pin that cannot be deleted (it moved, became a
symbolic ref, or Git refused, as over a stale lock) keeps its folder,
manifest and every one of its pins, its head's included, and is reported,
so the next prune retries it. An archive is pruned only when its
target still contains every replacement commit its receipt named and
reverts none of them (Git's own revert message is recognized; a hand-written
revert message is not); otherwise it is kept for attention and named in
every report with the restore command, until the user restores or prunes
it. Every prune is recorded in
`<git common dir>/simple-changes/archives/prune-log.json`. A policy value
that is not a whole number in range (0, a negative number, a fraction, a
string) falls back to the default and is reported; a repository whose policy
sets `archiveRetention` needs 0.33.0 or later. `worktree prune-archives
--archive <id>` or `--older-than <days>`, with `--approved-by` and
`--reason`, is the optional manual prune.

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
