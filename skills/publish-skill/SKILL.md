---
name: publish-skill
description: Publish a canonical skill-package update through upstream validation, default-branch merge, downstream fork synchronization and guidance backfills, concurrent Skills CLI reinstallation across every discovered local consumer, merge-request verification, and final remote-state cleanup. Use when asked to run or rerun a skill production loop, propagate a skill update across maintained forks, discover or update local skill installs, validate that a complete skill and its references install correctly, update consumer skill locks, or prove that all related changes reached each repository's default branch.
---

# Publish Skill

Publish one canonical skill update and carry it through every maintained fork
and discovered consumer without overwriting local adaptations or disturbing
unrelated work.

## Establish The Release Map

Read repository instructions and
[references/release-map.md](references/release-map.md). Discover from local
remotes, fork provenance, lockfiles, prior production MRs or PRs, and sibling
repositories:

- the canonical repository, skill directory, remote, and default branch;
- each downstream fork repository, fork path, local adaptations, and checks;
- every local consumer with an exact-source lock entry or matching installed
  package, including validation-only and lock-only consumers;
- the provider CLI, merge policy, and repository-native validation commands.

Do not ask for values that repository evidence resolves. Ask one concise
question when a required target or release authority remains genuinely
ambiguous.

## Protect Existing Work

- Inspect every original checkout and capture an ownership baseline before
  changing anything. Include its branch, HEAD, porcelain status, worktree list,
  relevant local and remote refs, open proposal source SHA and update time, and
  any live task claiming an exact target.
- Treat dirty or unrelated original checkouts as preserved baseline state:
  leave them untouched, but do not classify the repository or its maintained
  forks as externally owned and do not stop the publication loop. Continue
  from an isolated worktree based on the latest remote default branch.
- Classify an exact branch, worktree, or MR or PR as **externally-owned active
  work** only when new activity is observed after the baseline or a live agent,
  task, or person explicitly claims that exact target. New activity includes a
  changed HEAD or ref, a changed tracked, staged, or untracked status
  fingerprint, a new commit or proposal update, or a live task advancing it.
- A dirty tree, unrelated branch, existing worktree, pre-existing unpushed
  commit, or open proposal observed only at baseline is not by itself active
  ownership evidence. Preserve that exact pre-existing artifact and continue
  the loop independently.
- Do not rebase, merge, push, force-push, commit, clean, delete, or delegate
  externally-owned active work. Read-only inspection is allowed. Mutation
  requires an explicit handoff from the user or current owner that names the
  exact work.
- Broad terminal requests such as "ship everything", "finish the loop", or
  "leave no stale branches" do not transfer ownership of active work.
- Repeat the ownership check immediately before every branch, worktree, or MR
  mutation by comparing it with the captured baseline. Stop only the exact
  target with observed external activity and report the activity evidence in
  the outstanding-work ledger; do not turn static dirty state or mere
  uncertainty into repository-wide external ownership.
- Create isolated worktrees from the latest remote default branches for edits.
- Keep one branch and MR or PR per repository unless local policy requires a
  different grouping.
- Never call the loop complete merely because branches were pushed. Required
  changes must be merged and verified on every intended default branch.

## Run The Loop

Read [references/production-loop.md](references/production-loop.md), then:

1. Validate the canonical skill package after its final edit. Run its complete
   tests, contract or behavior checks, typecheck, and repository formatter or
   linter as applicable.
2. Update the canonical repository's customer and developer histories only as
   its changelog policy requires. Use the release-note model and attribution
   rules required by repository instructions.
3. Commit, push, open the canonical MR or PR, re-read its rendered description,
   wait for required checks, merge it, and fetch the remote default branch.
4. Freeze the canonical **merged default-branch commit** as the downstream
   provenance target. Do not pin forks to an unmerged feature commit.
5. Synchronize each maintained fork independently. Port applicable upstream
   changes, preserve documented local deltas, update the provenance pin, run
   the fork's tests and native checks, and perform any guidance-version history
   audit required by the fork's changelog policy.
6. Open, verify, and merge every downstream MR or PR. Focused changes may use
   separate MRs or PRs; all required work still has to reach the default branch.
7. Run
   `scripts/discover-local-consumers.ts` for the canonical source and every
   published skill name. Reconcile its results with repository instructions,
   remotes, prior production changes, and duplicate worktrees. Do not reduce the
   inventory to one convenient validation repository.
8. From the canonical merged ref, reinstall every confirmed local consumer with
   the Skills CLI in independent isolated worktrees. For every discovered
   symlink, resolve it, update its real target, and leave the symlink in place.
   Ordinary directories update directly. Run consumers concurrently with
   bounded parallelism and collect every result; one failure must not cancel or
   hide the others.
9. Validate each complete installed package, execute its installed self-check
   when available, and apply its declared retention mode. Preserve maintained
   installs, remove temporary validation-only installs, and leave intentional
   pins unchanged with an explicit report.
10. Repair a stale lock or remove a stale duplicate only when its identity,
    intended retention mode, and obsolescence are proven. Never remove a
    distinct skill merely because its name is similar.
11. Open, verify, and merge one consumer MR or PR per changed repository. Fetch
    every target default branch and prove the expected pins, policy versions,
    lock hashes, and retained files exist there.

Never absorb externally-owned active work into this loop merely because it
overlaps a target repository. Continue independent work when safe; otherwise
leave only the actively changing target outstanding until an explicit handoff
occurs.

## Validate Installation

Use a non-interactive Skills CLI command supported by the repository, for
example:

```bash
bunx skills add <canonical-git-url> --skill <skill-name> --agent codex -y
```

Compare the installed directory with the canonical skill directory using:

```bash
<publish-skill-directory>/scripts/verify-installed-package.sh \
  <canonical-skill-directory> <installed-skill-directory>
```

The verifier requires identical file paths and contents, exactly one
discoverable `SKILL.md`, and no symlinks. Installation is not validated by a
lockfile hash or the root `SKILL.md` alone.

## Verify MRs And Completion

Read
[references/merge-verification.md](references/merge-verification.md). Create MR
or PR descriptions with real Markdown newlines, preferably from a file or API
payload. Re-read the saved description after creation and correct malformed
rendering immediately.

Do not leave required pipeline, merge, or polling sessions running at handoff.
When CI cannot execute because of quota or provider failure, report that exact
limitation and use local evidence only where repository policy or explicit
authority permits the merge.

## Clean Up And Report

Remove only worktrees, branches where requested by the provider flow, temporary
installations, patches, and logs created by this run. Preserve original dirty
checkouts and user files.

Report a compact repository matrix containing:

- canonical merged commit;
- each downstream pin and merged MR or PR;
- guidance audit outcome and any semantic candidate left unchanged;
- every discovered consumer, its classification and retention mode,
  installation result, lock or manifest result, and cleanup status;
- required CI and local validation outcomes;
- final remote default-branch verification.

Separate the finished response into published and verified results, preserved
baseline state, and genuinely outstanding work. Preserved dirty checkouts,
branches, worktrees, commits, and proposals are informational and do not become
outstanding merely because they existed before the loop. List an
externally-owned branch, worktree, or MR or PR as outstanding only with the new
activity observed during the run, why that exact target was preserved, and what
authority is still needed.
