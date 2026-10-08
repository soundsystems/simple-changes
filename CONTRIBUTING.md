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
   that commit: no changed or untracked path, and no tracked path marked
   assume-unchanged or skip-worktree, whose edits `git status` hides, in the
   repository or any initialized submodule at any depth, each checked on its
   own so neither ignore settings nor a module's status settings hide a
   change. It runs
   `bun run check` and, only when it exits 0 and leaves the checkout clean at
   the same commit, writes a receipt for that HEAD.
2. Fetch, then run every merge through `simple-changes loop exec`, for
   example `loop exec --run-id <run> --agent-id <controller> -- glab api
   projects/84768068/merge_requests/<iid>/merge -X PUT -f sha=<head>`. The
   `execGuard` in `.simple-changes.json` runs
   `tooling/merge-gate/exec-guard.ts` first and refuses a merge-like command
   unless a receipt exists for the exact commit it would ship.

The guard reads `git`, `glab`, and `gh` argv with a closed grammar and refuses
any form it does not support rather than guessing what it does. It gates:

- a provider merge in one of the configured projects (`--project` in the
  policy: `84768068` and `soundsystems/simple-changes`): `glab api
  projects/<project>/merge_requests/<iid>/merge -X PUT -f sha=<head>` (or the
  GitHub `repos/<owner>/<repo>/pulls/<n>/merge` equivalent) with exactly one
  `sha` and no `--input` body, `glab mr merge <iid> -R <project> --sha
  <head>`, or `gh pr merge <n> -R <owner/repo> --match-head-commit <head>`
  (`-R` is required, because otherwise `GITLAB_REPO`, `GH_REPO`, or the
  checkout's remotes choose the project; the proposal is named by number
  only, never by URL or branch). The merged head must also contain every fetched copy
  of `main` (`refs/remotes/<remote>/main` for each remote, since the guard
  cannot tell which remote a project number means; a copy that exists but
  cannot be read, including a malformed ref, refuses, which needs Git 2.43 or
  later for `show-ref --exists`), so the merge result is
  exactly the checked tree; fetch right before merging, because the provider can still merge onto a `main` that
  moved after the fetch. The guard and `check:receipt` read real history:
  replacement refs and graft files, which can show a commit with another
  tree or other parents than a push or merge transfers, are ignored.
- `git push <remote> <source>:<destination>...` whose destination is `main`
  (abbreviations such as `heads/main` count).
- `git merge --ff-only` and `git pull --ff-only` while `main` is checked out:
  to a commit `origin/main` already contains (a sync), to one receipted
  commit, or, for `git pull`, from `main`'s own upstream. `git merge --abort`
  and `--quit` pass.

Everything else that could move `main` is refused: a merge that names no
exact SHA or names another project; any other `gh api` or `glab api` mutation
except creating, updating, or commenting on a proposal and deleting a
non-target branch (so no GraphQL mutation, no `merge-async`, no repository
commit API); a provider mutation that names its own host with `--hostname` or a
full URL; a provider option outside the supported set, or with an
attached value such as `-XPUT` or `-Rother/project`, or a short cluster such
as `-sd`; any `git push` with a push option (`-o`, `--push-option`) or with
`push.pushOption` configured, since GitLab push options such as
`merge_request.auto_merge` can schedule a merge the guard cannot check; `git
push` without a remote, with a colonless refspec (configuration such as
`push.default`, upstreams, or `remote.<name>.push` would choose its
destination), to a remote whose mirroring is not confirmed off, with an
unsupported option, or with a
pattern or matching (`:`) refspec, except `git push <remote> --tags`; a short
option cluster or attached short value anywhere (Git reads `-on` as `-o n`),
so write each option on its own; git global
options other than `-C`, paging, and `--no-optional-locks` (so no `-c`,
`--git-dir`, `--work-tree`, or `--exec-path`), and a `-C` directory the guard
cannot resolve (it follows each `-C` through the filesystem as Git does, so
`link/..` is the link target's parent); any other program that receives
git, glab, gh, or a shell as an argument (`env`, `nohup`, `xargs`, `sudo`,
`timeout`, and the rest), since it could run them with arguments the guard
cannot read; `env -S`; a git subcommand that is not a known built-in
(aliases, `git-*` programs, `send-pack`, `http-push`, `subtree`); `git rebase
--exec` or `-x` in any form, `git submodule foreach`, and `git bisect run`; `git
merge` or `git pull` options outside the supported set on `main`, including
`--continue`; `gh repo sync`; and a shell `-c` script that runs git, glab, gh,
or its own arguments. Every other command passes. Push feature branches as
`git push -u origin <branch>:<branch>`.

The enforcement boundary is `loop exec` with these plain argv forms, with git,
glab, or gh as the command itself: run every merge that way. The guard sees only the argv `loop exec` runs and the
controller's own environment and glab or gh host configuration, so a merge run
any other way, or by a program that runs other programs (an interpreter, a
build tool, `xargs`), is not gated. It is a convenience gate for this
repository's controller, not a security boundary.

A receipt is `<git common dir>/check-receipts/<40-hex HEAD>.json`, shared by
every worktree and never tracked. Simple Changelogs' merge gate writes and
reads the same format:

```json
{
  "command": "bun run check",
  "exitCode": 0,
  "finishedAt": "<UTC ISO 8601, such as 2026-10-08T17:04:05Z>",
  "head": "<40-hex commit>",
  "schemaVersion": 1
}
```

The guard accepts it only when it has exactly these fields and every one
matches: the `bun run check` command, exit code 0, a UTC ISO 8601 finish time
(with or without milliseconds), `head` equal to the commit being merged and to
the file name, and schema version 1. A commit names exactly one tree, so
`head` pins the checked contents. Receipts are never written for a failing
check, so a missing file means no passing run is recorded for that commit.
