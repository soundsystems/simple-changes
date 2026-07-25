# Release Map

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
`.claude/skills`, and `.cursor/skills`. Classify each result:

- `installed`: lock and one installed package both exist;
- `multiple-installs`: one lock resolves to more than one local copy;
- `lock-only`: no installed directory exists; determine whether this is a
  validation-only consumer, an intentional lock, or stale state;
- `unlocked-install`: an installed package exists without a matching lock;
  verify its identity before changing it.

Do not infer source identity from a similar name. Compare the complete package
when an unlocked install or alias lacks provenance. Search global skill roots
explicitly when they are in scope.

Group duplicate checkouts and worktrees by repository identity before creating
changes. Record divergent copies as a conflict to reconcile, not as independent
consumers. The final release map must account for every inventory row, including
rows intentionally left unchanged.

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
