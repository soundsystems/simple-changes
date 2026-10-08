# Contributing

Thanks for helping make repository integration safer and easier to understand.

1. Open an issue for contract changes so provider-neutral behavior can be
   discussed before an adapter depends on it. Check `.out-of-scope/` first:
   it records requests already declined and why, so a proposal to reverse one
   should answer the recorded reason.
2. Install dependencies with `bun install`.
3. Keep normative workflow rules in one canonical reference. Link to them from
   provider notes instead of copying them.
4. Add a credential-free fixture and test for every behavior change.
5. Run `bun run check` before opening a change proposal.

Provider support is evidence-based. A provider becomes first-class only after it
passes the shared capability suite; documentation and fixtures alone mean
experimental support.

Use real Markdown newlines in proposal descriptions and re-read the stored body
after creation. Never include credentials, environment values, or customer data
in fixtures, logs, or receipts.

## Merge gate

This repository has no CI and no Git hooks, so a passing `bun run check` on the
exact commit being merged is the merge evidence, and a local gate enforces it
for merges the Simple Changes controller runs.

1. Commit the change, then run `bun run check:receipt` on a clean checkout of
   that commit. It runs `bun run check` and, only when it exits 0 and leaves the
   checkout clean at the same commit, writes a receipt for that HEAD.
2. Run every merge through `simple-changes loop exec`, for example
   `loop exec --run-id <run> --agent-id <controller> -- glab api
   projects/<id>/merge_requests/<iid>/merge -X PUT -f sha=<head>`. The
   `execGuard` in `.simple-changes.json` runs
   `tooling/merge-gate/exec-guard.ts` first and refuses a merge-like command
   unless a receipt exists for the exact commit it would ship.

The guard reads `git`, `glab`, and `gh` argv with a closed grammar. It gates
a non-GET `glab api` or `gh api` call to a merge request or pull request
`merge` endpoint (it needs `sha=<head>`), `glab mr merge --sha <head>`, `gh pr
merge --match-head-commit <head>`, `git push <remote> <refspec>...` to `main`,
and `git merge` or `git pull` while `main` is checked out. A provider merge
also needs the merged head to contain the fetched `origin/main`, so the merge
result is exactly the checked tree; fetch right before merging, because the
provider can still merge onto a `main` that moved after the fetch. On `main`,
`git merge` and `git pull` need `--ff-only`: to a commit `origin/main` already
contains (a sync), to one receipted commit, or, for `git pull`, from `main`'s
own upstream; `git merge --abort` and `--quit` pass.

Anything outside the supported forms is refused rather than guessed at: a
merge that names no exact SHA; `git push` without a remote and refspecs (a
tags-only `git push <remote> --tags` passes), to a mirroring remote, with an
unsupported option, with a pattern or matching (`:`) refspec, or with a
colonless refspec when `remote.<name>.push` maps refs (an abbreviated
destination such as `heads/main` counts as `main`); a `gh api` or `glab api`
option outside the supported set or with an attached value such as `-XPUT`; git global options
other than `-C`, paging, and `--no-optional-locks` (so no `-c`, `--git-dir`,
`--work-tree`, or `--exec-path`); `GIT_*` environment assignments; a git
subcommand that is not a known built-in (aliases, `git-*` programs, `send-pack`,
`http-push`, `subtree`); `git rebase --exec` or `-x` in any form, `git
submodule foreach`, and `git bisect run`; `git merge` or `git pull` options outside the supported set on
`main`, including `--continue`; and a shell `-c` script that runs git, glab, gh,
or its own arguments. Every other command passes.

The enforcement boundary is `loop exec` with these plain argv forms: run every
merge that way. The guard sees only the argv `loop exec` runs, so a merge run
any other way, or by a program that runs other programs (an interpreter, a
build tool, `xargs`), is not gated. It is a convenience gate for this
repository's controller, not a security boundary.

A receipt is `<git common dir>/check-receipts/<head SHA>.json`:

```json
{
  "schemaVersion": 1,
  "kind": "check-receipt",
  "command": ["bun", "run", "check"],
  "exitCode": 0,
  "headSha": "<40-hex commit>",
  "treeSha": "<40-hex tree of that commit>",
  "startedAt": "<ISO time>",
  "finishedAt": "<ISO time>",
  "runtime": "bun <version>"
}
```

The guard accepts it only when it has exactly these fields and every one
matches: schema version 1, kind `check-receipt`, the exact `bun run check`
command, exit code 0, the head and tree of the commit being merged, ISO start
and finish times in order, and a nonblank runtime. Receipts are never written for a failing
check, so a missing file means no passing run is recorded for that commit.
