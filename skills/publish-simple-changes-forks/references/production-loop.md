# Production loop

## Canonical source

1. Re-read repository instructions and current status.
2. Validate the final canonical skill, maintainer tooling, tests, typecheck, and
   formatter or linter.
3. Integrate through the repository's required commit, review, and provider
   workflow.
4. Re-read the stored proposal description after creation.
5. When a remote exists, merge and fetch its default branch.
6. Freeze that committed default-branch revision as the downstream target.

Never pin downstream forks to a dirty tree, uncommitted change, or unmerged
remote feature revision.

## Downstream forks

Process every fork independently:

1. Run the canonical drift checker.
2. Review the entire canonical range from the old pin to the target.
3. Preserve the fork's name, audience, provider choices, authority boundaries,
   commands, deployment/data rules, release surfaces, and documented
   intentional omissions.
4. Port portable behavior and adapt locally overridden behavior.
5. Update the provenance pin only after the review.
6. Run canonical contract checks that apply plus the fork's own tests and
   repository-native verification.
7. Integrate through that repository's required provider and review workflow.
8. Re-read the stored proposal description and verify the final default branch.

Do not rewrite historical changelog entries merely because a fork or skill was
renamed. Follow the target repository's changelog policy when a synchronization
entry is actually required.

## Consumer installation

When installation verification is requested:

1. Install from the canonical committed ref consumers will use.
2. Compare the complete installed tree with
   `scripts/verify-installed-package.sh`.
3. Run the installed package's deterministic checks when available.
4. Remove only the temporary installation created for verification.
5. Preserve distinct skills and unrelated lockfile entries.

## Final convergence

Refresh every available remote default branch. Verify:

- canonical target revision and package files;
- every downstream provenance pin and local delta statement;
- canonical and fork-native checks;
- proposal state, required pipeline state, and stored Markdown;
- original dirty checkouts and unrelated work remain intact.
