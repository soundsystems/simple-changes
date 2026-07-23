---
name: publish-simple-changes-forks
description: Publish a canonical Simple Changes skill update through validation, default-branch integration, downstream fork synchronization, provenance updates, change-proposal verification, and final convergence checks. Use when asked to propagate or automate a Simple Changes update across maintained repository-specific forks, check or repair fork drift, validate a complete installed package, or prove that canonical and downstream default branches contain one reviewed update.
---

# Publish Simple Changes Forks

Carry one canonical Simple Changes update through every maintained downstream
fork without weakening or overwriting its documented local adaptations.

## Build the release map

Read [release-map.md](references/release-map.md). Discover repository names,
paths, remotes, default branches, fork headers, local delta summaries, native
checks, provider tools, and review policy from current evidence. Never embed one
organization's downstream topology in the canonical package.

Treat each downstream `SKILL.md` provenance line as the synchronization link:

```md
Forked from `simple-changes` @ `<sha>`. <project>-specific deltas: ...
```

Resolve the checker from the canonical source checkout and run it before
editing:

```sh
tooling/simple-changes/check-fork-sync.sh \
  <fork-SKILL.md> <canonical-repository> <canonical-default-ref>
```

## Protect active work

- Capture every original checkout's branch, HEAD, worktrees, and complete
  status.
- Preserve unrelated, paused, or changing work.
- Prefer isolated worktrees from verified default-branch refs for publishable
  changes. If the canonical repository has no remote yet, require a committed
  local default-branch baseline and report that local-only limitation.
- Process downstream repositories independently so one blocked fork does not
  corrupt another.
- Do not bump a pin to an uncommitted tree or, once a canonical remote exists, a
  revision absent from its default branch.

## Run the update

Read [production-loop.md](references/production-loop.md), then:

1. Validate the final canonical package and maintainer tooling.
2. Integrate the canonical change according to repository policy.
3. Freeze the canonical committed default-branch revision as the provenance
   target.
4. For each fork, review the complete canonical range from its old pin and
   classify each change as portable, locally overridden, not applicable, or an
   upstream candidate.
5. Port applicable behavior, preserve the documented local identity and
   provider boundaries, update the pin, and run both canonical and fork-native
   checks.
6. Integrate each downstream change according to its provider and review
   policy.
7. Fetch or refresh every target default branch and prove the canonical
   revision, downstream pins, tests, and stored change-proposal descriptions
   converge.

## Verify package installation

When installation is in scope, install from the same canonical ref consumers
will use. Compare the complete trees:

```sh
<this-skill-directory>/scripts/verify-installed-package.sh \
  <canonical-skill-directory> <installed-skill-directory>
```

The verifier requires identical paths and contents, exactly one discoverable
`SKILL.md`, and no symlinks.

## Verify proposals and completion

Read [merge-verification.md](references/merge-verification.md). Write change
proposal descriptions with real Markdown newlines through a file or structured
payload, then re-read the stored source and rendered result.

Do not report completion from local copies alone when remotes exist. Verify the
actual remote default-branch objects and every fork's exact pin. Report local
bootstrap status explicitly when a canonical remote is not configured.

## Report

Return a compact matrix with the canonical target revision, each downstream
pin, local and provider validation, proposal URL or local-only status, preserved
work, and any blocked fork.
