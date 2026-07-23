# Release map

Discover the topology before editing.

| Role | Required evidence |
| --- | --- |
| Canonical source | Repository, `skills/simple-changes`, committed default branch, remote when present, package checks |
| Downstream fork | Repository, fork directory, provenance pin, documented local deltas, native checks |
| Provider | Remote, authenticated proposal tool, default branch, required review and pipeline policy |
| Consumer | Install source/ref, destination directory, lock or manifest when installation is in scope |

Repository names and paths are runtime evidence. Do not place maintained-fork
identities in the public canonical skill.

## Resolve the canonical target

Fetch the selected remote before using it as evidence. Prefer its symbolic
default branch, then an existing remote `main` or `master`. If no remote exists,
use only a committed local default branch and label the result as a local
bootstrap rather than a published convergence.

## Discover downstream forks

Search candidate repository roots for `SKILL.md` files containing:

```md
Forked from `simple-changes` @ `<sha>`.
```

Read the remainder of that paragraph as the fork's delta contract. Confirm the
repository's instructions route matching work to the local fork.

Classify every canonical change:

- **portable**: port it to every maintained fork;
- **locally overridden**: preserve stricter local behavior and adapt compatible
  surrounding changes;
- **not applicable**: omit behavior outside the fork's documented scope;
- **upstream candidate**: keep the fork behavior and propose the reusable idea
  to the canonical source separately.

Updating a pin asserts that the complete canonical range was reviewed.

## Isolate repositories

Record each original checkout's branch, HEAD, worktrees, and untracked,
unstaged, and staged paths. Prefer a uniquely named worktree based on the
verified default branch when a clean publishable change is required. Never
stash, reset, switch, clean, amend, or overwrite a dirty original checkout for
convenience.
