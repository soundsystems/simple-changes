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

The guard gates a non-GET `glab api` or `gh api` call to a merge request or
pull request `merge` endpoint (it needs `sha=<head>`), `glab mr merge --sha
<head>`, `gh pr merge --match-head-commit <head>`, a `git push` whose
destination is `main`, and a `git merge` or `git pull` while `main` is checked
out (it needs `--ff-only` to one receipted commit, except a pure sync with the
published `origin/main`). A merge that names no exact SHA is refused, as is a
shell `-c` script that mentions a merge-like command, so run merges as plain
argv. Every other command passes. The guard sees only `loop exec` commands: a
merge run any other way is not gated, so it is a convenience gate for this
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

The guard accepts it only when every field matches: schema version 1, kind
`check-receipt`, the exact `bun run check` command, exit code 0, and the head
and tree of the commit being merged. Receipts are never written for a failing
check, so a missing file means no passing run is recorded for that commit.
