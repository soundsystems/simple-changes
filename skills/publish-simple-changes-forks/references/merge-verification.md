# Merge verification

## Description integrity

Create change-proposal descriptions from a file or structured API payload with
real newline characters. Immediately re-read the stored source and, when
available, rendered output. Reject literal `\n`, shell-expanded fragments,
broken inline code, and links or revisions that target the wrong repository.

## Review and pipeline state

Distinguish passed, optional manual, provider-blocked, failed, and running jobs.
Never report non-passed states as passed. Bind review to the exact head revision
and invalidate it after any new commit, rebase, or conflict resolution.

## Default-branch proof

When a remote exists, fetch it after merge and inspect its objects rather than
trusting a feature worktree. Verify:

- the canonical package contains the intended revision;
- every downstream header pins that revision;
- each fork retains its documented local delta;
- required tests and provider checks correspond to the integrated head.

For a local-only bootstrap, verify the committed local default branch and state
that remote publication remains outstanding.

## Cleanup

Remove only temporary worktrees, installations, patches, and logs created by
the synchronization run. Preserve original checkouts, unrelated branches,
untracked work, and distinct skills.
