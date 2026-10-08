# Release Map

Contents:

- Discover Targets
- Classify Ownership Before Scope
- Discover Every Consumer
- Resolve Default Branches
- Read Fork Provenance
- Isolate Work

Use this reference to discover the complete production topology.

Build the release map before creating a worktree or editing a changelog.

## Discover Targets

Inspect local repository instructions, remotes, default branches, recent merge
history, skill lockfiles, and fork headers. Record:

| Role | Required evidence |
| --- | --- |
| Canonical source | Repository, skill directory, remote default branch, package checks |
| Downstream fork | Repository, fork directory, provenance pin, documented local deltas, native checks |
| Consumer | Repository, Skills CLI target, install directory, lock or manifest file, retention mode |
| Provider | Authenticated CLI, MR or PR command, pipeline command, merge policy |

Repository names and paths are runtime data. Do not bake one organization's
topology into this public skill.

## Classify Ownership Before Scope

Classify every discovered branch, worktree, and open MR or PR before deciding
whether it belongs to this run:

| Ownership | Evidence | Allowed action |
| --- | --- | --- |
| Current loop | Created by this run, or explicitly handed off by the user or current owner | Mutate within the authorized publication scope |
| Preserved baseline | Dirty checkout, unrelated branch, existing worktree, unpushed commit, or open proposal present at the first observation but not observed changing | Leave the exact artifact untouched; continue publication from an independent remote-default worktree |
| Externally-owned active | Its HEAD, ref, status fingerprint, commits, or proposal changed after the baseline; or a live agent, task, or person explicitly claims and advances the exact target | Read-only audit and outstanding-work report for that exact target only |
| Proven stale | No active owner, no unmerged or unpushed commits, no open proposal, and obsolescence is established against the remote default branch | Remove only when cleanup is in scope |

Capture a baseline before classifying scope:

- current branch and HEAD;
- `git status --porcelain=v2` including staged, tracked, and untracked paths;
- worktree inventory and relevant local and remote refs;
- each open proposal's source SHA and update time;
- any live agent or task assignment naming an exact branch, worktree, or
  proposal.

Compare the same evidence immediately before mutation. Active ownership requires
new activity observed after that baseline or a real-time claim from a live
owner. A dirty tree, worktree, recent commit, unpushed commit, or open proposal
that merely existed at baseline is preserved state, not proof that work is
currently being made. Do not reinterpret preserved or active state as cleanup
evidence. A broad request to ship, finish, integrate, prune, or remove stale
branches does not hand off externally-owned active work. Handoff must identify
the exact branch, worktree, or proposal.

Repeat this classification immediately before mutation because another task can
claim or advance work after initial discovery. Ignore changes made by the
current loop itself when comparing its owned worktree. If no new external
activity is observed, continue the loop rather than escalating static dirty
state into repository-wide ownership.

## Discover Every Consumer

Resolve the canonical source identity exactly as recorded by the Skills CLI,
then run the bundled inventory script. Pass every published distribution name
and every workspace root that may contain consumers:

```bash
bun <publish-skill-directory>/scripts/discover-local-consumers.ts \
  --source <owner/repository> \
  --skill <skill-name> \
  --root <workspace-root> \
  --json
```

Repeat `--skill` and `--root` as needed. The inventory includes exact-source
lock entries and matching installed directories under `.agents/skills`,
`.codex/skills`, `.claude/skills`, and `.cursor/skills`. It automatically
includes those four paths beneath the current user's home directory, so global
installations are not missed when no workspace root contains them. Classify
each result:

- `installed`: lock and one installed package both exist;
- `multiple-installs`: one lock resolves to more than one distinct physical
  package; symlinked paths to the same package remain one installation;
- `lock-only`: no installed directory exists; determine whether this is a
  validation-only consumer, an intentional lock, or stale state;
- `unlocked-install`: an installed package exists without a matching lock;
  verify its identity before changing it.
- `superseded-install`: repository policy selects `web-cms` and the matching
  combined package is present, so a standalone CMS package is redundant by
  default. Keep `.simple-changelogs-cms.json`; it is the combined package's CMS
  policy. Retain both packages only when repository instructions explicitly
  identify them as independently maintained consumers.

Do not infer source identity from a similar name. Compare the complete package
when an unlocked install or alias lacks provenance. The standard global skill roots
are already part of the inventory; pass additional roots explicitly only for
nonstandard locations.

Group duplicate checkouts and worktrees by repository identity before creating
changes. Record divergent copies as a conflict to reconcile, not as independent
consumers. The final release map must account for every inventory row, including
rows intentionally left unchanged.

Do not reconcile by taking over externally-owned active work. Preserve it and
either continue from an independent remote-default worktree or mark only that
exact target outstanding. Treat baseline-only dirty copies as preserved
informational state and continue independently.

## Resolve Default Branches

Prefer the selected remote's symbolic default branch. Fall back only to an
existing remote `main` or `master`. Fetch before branching and before final
verification. Never treat the original checkout's current branch as the
production baseline without evidence that it is the remote default branch.

## Read Fork Provenance

Find the canonical skill name and pinned upstream commit in each fork's
`SKILL.md`. Read its local-delta summary before applying upstream changes.

Classify each upstream change as:

- **portable**: port it to every fork;
- **locally overridden**: preserve the fork behavior and adapt surrounding
  upstream changes;
- **not applicable**: omit it and retain evidence explaining why;
- **candidate for upstream**: keep the local behavior and propose the general
  improvement to the canonical source separately.

An updated pin means the entire upstream range was reviewed, not blindly copied.

## Isolate Work

Use a uniquely named temporary worktree based on the fetched remote default
branch for each repository. Keep the original checkout read-only when it is
dirty, behind, or on unrelated work.

Before editing, capture:

- original status and branch;
- remote default-branch commit;
- current canonical or fork pin;
- baseline test outcome when practical.

Do not stash, reset, switch, clean, or amend the user's original checkout to
make the loop convenient.
