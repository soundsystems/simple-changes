# Merge Verification

Use this reference for proposal integrity, merge proof, and cleanup.

## Description Integrity

Write MR or PR descriptions using a file or a structured API payload so Markdown
contains real newline characters. Avoid shell strings that can reinterpret
backticks, backslashes, or `\n` text.

Immediately re-read the provider's stored description. Check:

- paragraphs and lists render as separate lines;
- inline code remains intact;
- no literal escape sequences or shell-expanded fragments appear;
- links and commit identifiers point to the intended repositories and refs.

Correct malformed text before review or merge.

## Pipeline And Merge State

Distinguish these outcomes:

- **passed**: every required job completed successfully;
- **manual optional**: only explicitly optional jobs remain manual;
- **provider blocked**: jobs could not start because of quota or provider state;
- **failed**: a required job ran and failed;
- **running**: completion is still pending.

Do not translate provider-blocked, manual, or running into passed. Enable
auto-merge only when policy permits it, then continue polling until the MR or PR
actually becomes merged or a real blocker is established.

## Remote-State Proof

After merge, fetch the target default branch and inspect files from that remote
ref. Verify semantic state, not only commit ancestry:

- the canonical package contains the intended files;
- each fork header names the canonical merged commit;
- guidance or backfill policy has the expected value;
- the consumer lock or manifest has the installed package identity;
- stale skill directories are absent when cleanup was in scope.

Record the provider URL and merge commit for every repository.

## Cleanup

Stop or finish all polling and development sessions used by the loop. Remove
only temporary worktrees and files created during the run, then prune worktree
metadata. Verify the temporary paths no longer exist.

Never remove an original checkout, unrelated branch, user-authored file, or
distinct skill. If cleanup would be destructive or its ownership is uncertain,
leave it in place and report it.

An active worktree, open MR or PR, unmerged commit, unpushed commit, dirty tree,
or branch owned by another task is not stale. Do not rebase, push, merge, clean,
delete, or delegate it without an explicit handoff naming that exact work.
Recheck ownership immediately before cleanup; an earlier classification can
expire when another task advances the branch.

## Final Matrix

Use one row per repository:

| Repository role | Default-branch commit | MR or PR | Validation | Final state |
| --- | --- | --- | --- | --- |

Add concise notes for:

- historical-audit ranges and disposition;
- semantic candidates intentionally left unchanged;
- CI jobs skipped or blocked and the exact reason;
- installation tree comparison, installed self-check, and deletion result;
- original dirty checkouts preserved.
- externally-owned work preserved, its ownership evidence, and the exact
  handoff needed before anyone may mutate it.
