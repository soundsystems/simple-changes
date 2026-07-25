# Production Loop

## 1. Canonical Source

Inspect the final diff and decide whether the canonical source already contains
the requested update. If it does, verify that exact default-branch state instead
of creating an empty MR or PR.

For a real update:

1. Work from the latest remote default branch.
2. Make the smallest complete package change.
3. Update package tests, contracts, fixtures, and interface metadata when their
   behavior changed.
4. Run all package checks after the final edit.
5. Update changelogs according to the repository's changelog skill and policy.
6. Commit, push, and open an MR or PR with a description file or structured API
   payload.
7. Re-read the stored title and description.
8. Wait for required checks, merge, fetch, and record the merge commit now on
   the remote default branch.

Use that merged commit as the synchronization target even when the provider
retains the feature commit in history.

## 2. Downstream Forks

Process forks independently so one blocked repository does not corrupt another.

For each fork:

1. Run the canonical fork-drift checker when one is bundled.
2. Review the entire canonical diff from the old pin through the new merged pin.
3. Apply package changes while preserving the fork's name, audience, release
   authorities, commands, surfaces, and documented local policies.
4. Update the provenance pin only after the review is complete.
5. Run package checks and repository-native changelog or release verification.
6. If the canonical guidance version changed, follow the fork's policy to audit
   released customer notes, developer history, generated surfaces, and version
   metadata. Record inspected ranges and outcomes.
7. Apply deterministic backfill repairs. Leave semantic or destructive
   candidates unchanged without the authority required by the changelog skill.
8. Write developer history for the fork sync when policy requires it. Do not
   invent customer-facing news for an internal maintainer workflow.
9. Commit, push, verify the MR or PR description, merge, and verify the remote
   default branch contains the new pin and policy state.

Use a repository-required writing model for raw release-note or changelog text.
If delegation is required, give that writer the actual diff and evidence, then
verify its output against repository policy before committing it.

## 3. Consumer Installations

Inventory every exact-source consumer with
`scripts/discover-local-consumers.ts`. Reconcile duplicate worktrees, aliases,
unlocked installs, and lock-only records before writing. Do not select only one
consumer for convenience.

For every confirmed consumer:

1. Determine its retention mode from repository instructions and prior
   production evidence:
   - **maintained**: keep the reinstalled package and updated lock;
   - **validation-only**: reinstall, validate, then remove the package while
     retaining only the intended lock or manifest state;
   - **intentional-pin**: do not update without explicit authority;
   - **stale**: repair or remove only after proving obsolescence.
2. Base an independent isolated worktree on the consumer's latest remote default
   branch. Never reinstall in the original checkout merely because it is clean.
3. Start Skills CLI reinstallations concurrently with bounded parallelism.
   Capture each exit status independently and wait for all consumers to finish;
   one failure must not cancel the remaining validations.
4. Install from the canonical merged default branch with the Skills CLI.
5. Compare the source and installed trees with
   `<publish-skill-directory>/scripts/verify-installed-package.sh`,
   resolving the directory from this skill's loaded `SKILL.md` path.
6. Confirm references, scripts, schemas, and agents metadata are present, not
   merely the root instruction file.
7. Run the installed skill's validation or contract command from the installed
   directory when available.
8. Apply the declared retention mode. Delete only validation-only or proven
   stale package directories; preserve maintained installs.
9. Confirm no unintended copy remains and inspect the consumer diff. Investigate
   changes outside the declared install directory, lock, or manifest.
10. Commit, push, re-read the MR or PR description, merge, and verify the remote
    default branch records the new canonical package identity.

Do not validate against a local unmerged source tree when the purpose is to
prove public installation. Install from the same remote ref consumers will use.
Do not call consumer convergence complete while an inventory row is unclassified
or lacks a recorded outcome.

## 4. Final Convergence

After all merges, fetch each remote default branch again. Verify state from the
remote objects rather than from feature worktrees:

- canonical package commit and guidance version;
- every fork provenance pin and local policy version;
- required backfill records and changelog entries;
- every consumer lock or manifest identity;
- retained maintained installs and absence of temporary validation-only
  installs;
- MR or PR state and required pipeline status.

Only then remove temporary worktrees and artifacts.
