---
name: update-local-forks
description: Use when a user asks to update, sync, or refresh their repository-specific forks of Simple Changes from the globally installed skill, apply upstream guidance updates to a fork, bump a fork's provenance pin, or check which local forks are behind. Preserves every fork's own behavior; never commits, pushes, or runs fork code on its own. Do not use to publish the canonical Simple Changes package or to edit the global install.
---

# Update Local Forks

Bring every repository-specific fork of Simple Changes on this machine up to
the globally installed version while keeping what the fork changed on
purpose. Requires Git and Bun 1.2 or later. In commands below,
`update-local-forks` means `bun <skill-root>/scripts/update-local-forks.ts`.

A fork announces itself with one line under its title:

```md
Forked from `simple-changes` @ `<sha>`. <project>-specific deltas: ...
```

That pin is the merge base. The installed skill is the target. The helper
compares base, target, and fork for every file, applies what only upstream
changed, keeps what only the fork changed, three-way merges what both changed,
and reports anything it cannot decide. It writes nothing until you apply a
saved plan, and it never commits, pushes, or runs a fork's scripts.

## Workflow

1. **Discover.** Run `update-local-forks discover [--root <dir> ...] --json`.
   It lists installed sources and forks under global skill roots, conventional
   project folders, and any root you pass, with each fork's pin and layout.
   Skip forks flagged as a linked Git
   worktree; update the primary checkout of that repository instead. If no
   source is installed, stop and tell the user to install Simple Changes
   globally first (see [fork sync](references/fork-sync.md)).
2. **Plan each fork.** Run
   `update-local-forks plan --fork <dir> --json > <plan.json>` once per fork,
   saving a separate plan file for each, and read every summary. The plan
   pins the fork to the exact upstream release commit only when the installed
   source is byte-identical to that release; otherwise it says why the pin
   stays. Use `--upstream <checkout>` when a canonical source
   checkout is on this machine; without it, the pinned base is fetched into a
   local cache from the canonical repository.
3. **Explain before writing.** Tell the user, in plain language, how many
   files update, merge, get added or deleted, how many fork edits and
   fork-only files stay untouched, which files conflict, and which upstream
   changes the fork omits and should be re-checked. Show the literal rewrites
   (provenance pin, guidance version, upstream version) the plan will make in
   the fork's own tests and notes. Present every fork's plan together, with
   the step 7 handoff (queue, integrate, or ship) proposed for each
   repository, so the user can approve all, none, or named forks and their
   handoffs in one reply. Wait for approval; a plan with conflicts still
   applies everything else, leaves each conflicting file exactly as it was,
   and writes the marked three-way merge beside it as `<file>.upstream-merge`.
4. **Apply.** Run `update-local-forks apply --plan <plan.json>`. It fails
   closed if any file it would write changed after the plan was made.
5. **Resolve the rest by hand.** Conflicts are usually the fork's rewritten
   `SKILL.md` or `SPEC.md`; read the `.upstream-merge` sidecar, merge the
   upstream change into the fork's prose keeping its stricter local rules,
   then delete the sidecar. Until it is deleted, every later plan reports the
   file as unresolved. Review items are upstream files the fork
   deliberately omits; confirm each omission still holds, or port the change.
   A review item on a fork-owned script or manifest means that file gates the
   runtime behind its own list of commands and does not name one this update
   added; extend the gate, or record why the fork withholds that command.
   Follow the fork's classification rules in
   [fork sync](references/fork-sync.md).
6. **Verify.** Run the fork's own checks (commonly `scripts/test.sh` beside
   the fork), its runtime's `simple-changes skill check` when the runtime
   has that command, and the fork repository's native checks. Fix any literal the
   fork pins that the plan did not know about, then re-run `plan` and expect
   no remaining actions.
7. **Record and hand off.** Append a short section to the fork's
   `references/fork-maintenance.md` (or the fork's equivalent) naming the
   upstream range and what was ported, kept, or omitted. Then hand the fork
   repository change to Simple Changes to queue, integrate, or ship under that
   repository's own policy. This skill never commits or pushes.

## Several forks at once

Forks in different repositories share no writable state except the upstream
fetch cache once their plans are approved.
When the host can start isolated agents and learn when each one finishes, run
steps 4 through 7 for each approved repository in its own agent, all
together, so the sweep takes about as long as its slowest fork. Without that
host support, work through the forks one at a time.

- Discover, plan, and explain yourself; start agents only after approval.
- Assign one agent per repository. Forks in the same repository share one
  Simple Changes controller, so that agent updates them in turn.
- Give each agent its fork directories, saved plan files, and the handoff the
  user approved for that repository in step 3. The boundaries below apply to
  every agent unchanged.
- Pass the same `--upstream <checkout>` to every agent's step 6 re-plan when
  a canonical checkout exists; without it, overlapping fetches into the
  shared base cache can fail and must be retried.
- An agent that cannot resolve a conflict without weakening a documented fork
  rule, cannot make a failing check pass inside the fork, or needs a decision
  beyond its handoff stops and reports it. Ask the user, then resume that
  fork; the others continue.
- Stagger repositories whose native checks are heavy.
- Report per fork once every agent has finished, including any fork that
  stopped and why.

## Boundaries

- Only the fork directory named in the plan is written. The global install,
  the canonical checkout, and other forks are read-only.
- A provenance pin advances only to a verified upstream release commit, never
  to a guess, an uncommitted tree, or a commit the installed source does not
  match byte for byte.
- Fork-only files, fork edits to unchanged upstream files, conflicts, and
  review items are never overwritten.
- Runtime files under `scripts/` and `evals/` (or the fork's `runtime/`
  directory) are added when new upstream; new upstream references are
  reported for review, because forks omit references on purpose.
- Nothing here grants merge, push, release, or deployment authority; the
  fork repository's Simple Changes policy decides how the update ships.

## Reports

Report per fork: the pin movement, counts by action, every conflict and
review item with its reason, the literal rewrites made, and the exact next
command. Say plainly when a fork was skipped as a linked worktree or left
untouched because the plan was not applied.
