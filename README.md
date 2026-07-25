# Simple Changes

**Keep working. Merge when ready.**

Simple Changes is an open-source, agent-neutral skill that turns ready work in a
Git repository into focused, verified change proposals while preserving paused
and concurrent work. Its first release provides a credential-free vertical
slice: inspect a repository, classify stable and changing work, propose focused
units, and validate the result without mutating Git or contacting a provider.

## Quick start

Requires [Bun](https://bun.sh/) 1.2 or later and Git.

```sh
bun install
bun run simple-changes initialize --mode queue
bun run simple-changes preview
bun run simple-changes preview --json
bun run simple-changes release-notes
bun run simple-changes release-notes --check --repo .
```

Install it for Codex:

```sh
cp -R skills/simple-changes ~/.codex/skills/simple-changes
```

Other agents that use the portable Skills directory convention can install the
same directory under `~/.agents/skills/simple-changes`.

The installed directory is self-contained. Its release-note surface is
read-only: `release-notes` displays Simple Changes' packaged public history. It
does not author changelogs or provide release-writing guidance to users'
agents, and does not contain the repository's release harness or model
adapters. When `simple-changelogs` is available, Simple Changes can delegate a
focused changelog unit and validate its handoff receipt; the changelog skill
still owns classification and writing.

## Repository-specific forks

A repository-local fork can specialize providers, commands, verification, and
release policy while remaining auditable against the canonical package. Put a
provenance line directly below its title:

```md
Forked from `simple-changes` @ `<short-sha>`. <project>-specific deltas:
<provider boundaries, local commands, release surfaces, ...>
```

In a source checkout, check that pin against the canonical default branch:

```sh
tooling/simple-changes/check-fork-sync.sh \
  path/to/fork/SKILL.md /path/to/simple-changes origin/main
```

Port applicable changes, preserve the documented local deltas, run canonical
and fork-native checks, and update the pin only after reviewing the complete
upstream range. Repository maintainers can invoke
`skills/publish-skill` for the complete canonical, fork, and consumer
propagation workflow.
Repository names and paths are discovered at runtime and are not embedded in
the public package.

Install that workflow project-locally from a source checkout:

```sh
bunx skills add . --skill publish-skill --agent codex -y
```

Skill repositories may bundle the same generic `publish-skill` workflow. Use
the project-local copy from the canonical repository being published so
discovery and the production release map stay scoped to that repository.

## What the current source provides

- Resolves the canonical primary checkout across linked worktrees.
- Detects first write-capable use and requires onboarding when neither
  repository nor personal preferences exist.
- Detects changelog relevance separately from compatible skill availability and
  coordinates delegation through a closed, digest-bound handoff receipt.
- Inventories branches, stashes, local changes, worktrees, policy, and Git
  capabilities using argument-array subprocess calls.
- Takes two read-only snapshots and preserves work that appeared or changed
  between them.
- Builds a deterministic preview plan for stable work and validates path
  conservation, authority, and closed JSON schemas.
- Classifies database and data-system changes without prescribing a provider,
  ORM, query language, or migration tool.
- Audits proposal Markdown, including accidentally escaped newlines.
- Displays Simple Changes' packaged public release notes without exposing
  private HTML comments, unreleased notes, or developer history.
- Checks that the latest public and developer release headings agree with the
  root package version in source-repository maintainer mode.
- Normalizes forge and deployment evidence without assuming a numeric PR/MR ID
  or a particular delivery model.
- Requires production receipts to cover the complete configured canonical-target
  inventory, then uses a bounded promote/recheck/provider-managed-target
  recovery sequence for verified artifacts instead of creating duplicate
  deployments.
- Records explicit parity dispositions for repository-defined counterpart
  surfaces without forcing platform-identical interfaces or inferring separate
  release authority.
- Treats requests for all proposals as complete-corpus operations that must
  paginate every relevant provider state.
- Emits human-readable or JSON reports with stable exit codes.

The deterministic CLI does **not** create, push, merge, deploy, apply
migrations, change secrets, update DNS, or clean branches. Those mutations
remain capability- and authority-gated extensions of the v1 contract followed
by agents and provider adapters.

## CLI

```text
simple-changes initialize --mode MODE
  [--changelog delegate-if-available|preserve-and-report|ask]
  [--production ask|allow|deny]
  [--questions blocking-only|always|never]
  [--scope user|repository|run] [--yes] [--json] [--repo PATH]
simple-changes setup [--finish review|integrate|ship]
  [--changelog delegate-if-available|preserve-and-report|ask]
  [--production ask|allow|deny]
  [--questions blocking-only|always|never]
  [--scope user|repository|run] [--yes] [--json] [--repo PATH]
simple-changes inventory [--json] [--repo PATH]
simple-changes preview [--json] [--repo PATH] [--settle-ms N]
simple-changes release-notes [--check] [--json] [--repo PATH] [--version VERSION]
simple-changes validate KIND FILE [--json]
simple-changes verify-markdown FILE [--json]
simple-changes help
```

`KIND` is one of `repo-policy`, `changelog-receipt`, `initialization`,
`inventory`, `change-plan`, `run-state`, `provider-receipt`,
`release-consistency`, or `release-notes`.

Exit codes are stable: `0` success, `2` usage, `3` invalid input or contract,
`4` inventory failure, and `5` unsafe repository state.

`release-notes` renders the latest released section of the packaged Simple
Changes `CHANGELOG.md` and omits pending `Unreleased` content and HTML comments.
Use `--version VERSION` for an older published release or `--json` for
automation. An explicit `--repo PATH` may read another checkout without writing
it. The source-maintainer-only `--check` mode requires `--repo PATH` and
validates the latest public changelog, developer changelog, and root package
version without changing them.

## Policy

Write-capable Simple Changes tasks automatically initialize onboarding when no
repository or personal policy exists. Run the same checkpoint directly:

```sh
bun run simple-changes initialize --mode queue
```

Or establish global personal defaults explicitly, including outside a Git
repository:

```sh
bun run simple-changes setup --scope user
```

It asks:

1. **How far should I usually take ready work?**
2. For shipping, **What should happen with production?**
3. When relevant, **How should changelog work be handled?**
4. **When should I ask for permission or help?**
5. **For what scope should I save these preferences?**

Personal preferences are saved under the platform configuration directory and
apply only when the repository has no policy. Teams may commit
`.simple-changes.json`:

```json
{
  "schemaVersion": 1,
  "guidance": {
    "version": 1
  },
  "changelogHandling": "delegate-if-available",
  "defaultFinish": "open-change-request",
  "questions": "blocking-only",
  "review": "repository-policy",
  "productionDeploy": "ask",
  "concurrentWork": "preserve"
}
```

The active request overrides repository policy, repository policy overrides
personal preferences, and personal preferences override the safe defaults.
Run-only setup writes no file. Policy stores decisions, never credentials or
transient run state. Resumable state for future mutation adapters belongs under
`.git/simple-changes/`.

For non-interactive setup:

```sh
bun run simple-changes setup \
  --finish ship \
  --changelog delegate-if-available \
  --production ask \
  --questions blocking-only \
  --scope user \
  --yes
```

Even an automatic ship preference does not authorize remote migrations,
backfills, secrets or environment changes, DNS changes, store releases, or
history rewrites. Those operations still require explicit, exact-target
permission.

## Development

```sh
bun run typecheck
bun run lint
bun run test
bun run eval
```

Check the bundled release-note fork against its Simple Changelogs source:

```sh
sh tooling/simple-changes/check-release-notes-fork-sync.sh \
  /path/to/simple-changelogs origin/main
```

`bun run eval` is deterministic and credential-free. The optional authenticated
behavior harness runs the five release-note fixtures through a selected agent:

```sh
bun run behavior --adapter tooling/simple-changes/adapters/codex-eval.ts
bun run behavior --adapter tooling/simple-changes/adapters/claude-eval.ts
bun run behavior --adapter tooling/simple-changes/adapters/hermes-eval.ts
bun run behavior --adapter tooling/simple-changes/adapters/cursor-eval.ts
bun run behavior --adapter tooling/simple-changes/adapters/grok-eval.ts
```

See [tooling/simple-changes/EVAL.md](tooling/simple-changes/EVAL.md) for
isolation, authentication, model selection, and case-filtering details.

This repository is the production, open-source Simple Changes package. The
portable skill, CLI, schemas, and references are tracked under
`skills/simple-changes`. Fixtures, release-writing guidance, fork maintenance,
and Codex, Claude Code, Hermes, Cursor, and Grok Build adapters are tracked under
`tooling/simple-changes` for this repository's maintainers only. They are not
packaged or installed with the public skill. Only interrupted adapter scratch
files are ignored. The Simple Changelogs provenance pin and drift check provide
a deliberate upstream mirror boundary without importing its app-specific
surfaces.

Core contracts remain forge-, database-, and hosting-provider agnostic.
Provider references translate those contracts into discoverable capabilities;
they do not make any named provider, domain, branch convention, database,
deployment command, or release channel mandatory.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.
