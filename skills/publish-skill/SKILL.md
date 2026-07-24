---
name: publish-skill
description: Publish a canonical skill-package update through upstream validation, default-branch merge, downstream fork synchronization and guidance backfills, real Skills CLI consumer installation, merge-request verification, and final remote-state cleanup. Use when asked to run or rerun a skill production loop, propagate a skill update across maintained forks, validate that a complete skill and its references install correctly, update a consumer repository's skill lock, or prove that all related changes reached each repository's default branch.
---

# Publish Skill

Publish one canonical skill update and carry it through every maintained fork and
consumer without overwriting local adaptations or disturbing unrelated work.

## Establish The Release Map

Read repository instructions and
[references/release-map.md](references/release-map.md). Discover from local
remotes, fork provenance, lockfiles, prior production MRs or PRs, and sibling
repositories:

- the canonical repository, skill directory, remote, and default branch;
- each downstream fork repository, fork path, local adaptations, and checks;
- one consumer repository used for a real Skills CLI installation;
- the provider CLI, merge policy, and repository-native validation commands.

Do not ask for values that repository evidence resolves. Ask one concise
question when a required target or release authority remains genuinely
ambiguous.

## Protect Existing Work

- Inspect every original checkout before changing anything.
- Treat dirty or unrelated branches as user-owned and leave them untouched.
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
7. From the canonical merged ref, install the skill into the consumer with the
   Skills CLI. Validate the complete installed package, execute its installed
   self-check when available, remove the temporary installation, and retain only
   the intended lock or manifest update.
8. Remove stale duplicate copies of the same skill from the consumer only when
   their identity and obsolescence are proven. Never remove a distinct skill
   merely because its name is similar.
9. Open, verify, and merge the consumer MR or PR. Fetch every target default
   branch and prove the expected pins, policy versions, lock hashes, and files
   exist there.

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
- consumer installation result, lock or manifest result, and cleanup status;
- required CI and local validation outcomes;
- final remote default-branch verification.
