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
bun run simple-changes initialize --mode sync
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
- Treats `sync`, `pull latest`, and `get us in line with main` as a guarded
  local-only mode: exact-target fetch, fast-forward-only target updates, and
  conflict-preflighted feature-branch integration without push or history
  rewrite.
- Detects first write-capable use and requires onboarding when neither
  repository nor personal preferences exist.
- Detects changelog relevance separately from compatible skill availability and
  coordinates delegation through a closed, digest-bound handoff receipt.
- Treats every Web production deployment as a product release, requires the
  delegated workflow to version and integrate target-contained pending work,
  and deploys only after that reconciliation is merged into a refreshed target.
- Inventories branches, stashes, local changes, worktrees, policy, and Git
  capabilities using argument-array subprocess calls.
- Takes two read-only snapshots and preserves work that appeared or changed
  between them.
- Holds one atomic active-loop lease for write-capable integration runs,
  persists a content-sensitive opening worktree manifest, runs local mutations
  under the lock from preflight through post-verification, recovers only locks
  whose recorded owner is proven dead, and prepares one resumable isolated
  worktree for each new authoring agent from a pinned revision.
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
- Starts Ship runs with a concise proceed-without-waiting scope brief when
  authority already exists, then closes with exact shipped receipts and any
  review-driven changes made after the original proposal head.
- Emits human-readable or JSON reports with stable exit codes.

The deterministic CLI creates only explicitly requested, lease-registered
authoring branches and worktrees. `loop exec` can run one explicitly supplied
local argument-array command while the lease lock is held, but it does not
decide to commit, push, merge, deploy, apply migrations, change secrets, update
DNS, or clean branches. Those decisions remain capability- and authority-gated
extensions followed by agents and provider adapters.

## CLI

```text
simple-changes initialize --mode MODE
  [--ready] [--handoff ask|automatic|user-signaled]
  [--instruction-pointer add|leave] [--instruction-file PATH]
  [--ui-artifacts]
  [--ui-versioning repository|number-and-date|date-only|number-only]
  [--changelog delegate-if-available|preserve-and-report|ask]
  [--production ask|allow|deny]
  [--questions blocking-only|always|never]
  [--scope user|repository|run] [--yes] [--json] [--repo PATH]
simple-changes setup [--finish review|integrate|ship]
  [--handoff ask|automatic|user-signaled]
  [--instruction-pointer add|leave] [--instruction-file PATH]
  [--ui-artifacts]
  [--ui-versioning repository|number-and-date|date-only|number-only]
  [--changelog delegate-if-available|preserve-and-report|ask]
  [--production ask|allow|deny]
  [--questions blocking-only|always|never]
  [--scope user|repository|run] [--yes] [--json] [--repo PATH]
simple-changes inventory [--json] [--repo PATH]
simple-changes preview [--json] [--repo PATH] [--settle-ms N]
simple-changes loop start --mode MODE --agent-id ID [--json] [--repo PATH]
simple-changes loop status [--json] [--repo PATH]
simple-changes loop verify --run-id ID [--json] [--repo PATH]
simple-changes loop guard --run-id ID --agent-id ID [--json] [--repo PATH]
simple-changes loop exec --run-id ID --agent-id ID [--json] [--repo PATH]
  -- COMMAND [ARG ...]
simple-changes loop recover --agent-id ID [--json] [--repo PATH]
simple-changes loop allow --run-id ID --agent-id ID --worktree PATH
  --status-digest SHA256 --approved-by ID --reason TEXT [--json] [--repo PATH]
simple-changes loop end --run-id ID --agent-id ID [--json] [--repo PATH]
simple-changes prepare-agent --run-id ID --agent-id ID --purpose SLUG
  [--json] [--repo PATH]
simple-changes release-notes [--check] [--json] [--repo PATH] [--version VERSION]
simple-changes validate KIND FILE [--json]
simple-changes verify-markdown FILE [--json]
simple-changes help
```

`KIND` is one of `repo-policy`, `changelog-receipt`, `initialization`,
`inventory`, `change-plan`, `run-state`, `provider-receipt`,
`release-consistency`, `release-notes`, or `loop-lease`.

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
repository or personal policy exists, except Sync: it uses fixed local-only
guardrails and never starts workflow-preference onboarding. Run the same
checkpoint directly:

```sh
bun run simple-changes initialize --mode queue
```

Or establish global personal defaults explicitly, including outside a Git
repository:

```sh
bun run simple-changes setup --scope user
```

It asks the following questions and explains the effect of every option as it
goes:

1. **How far should I usually take ready work?** Stop with a checked proposal,
   merge after approval, or also deploy and verify.
2. For shipping, **What should happen with production?** Confirm first, deploy
   automatically when repository rules permit it, or stop before production.
3. When relevant, **How should changelog work be handled?** Delegate when a
   compatible skill exists, preserve and report the work, or ask first.
4. When saving multiple UI artifact iterations, **How should their version
   names be chosen?** Follow the repository convention (recommended), use a
   number and ISO date, use an ISO date only, or use a number only.
5. **When should I ask for permission or help?** Only when blocked, before major
   steps, or skip unauthorized work without interrupting.
6. **For what scope should I save these preferences?** Personal defaults,
   repository policy, or this run without writing a policy file.
7. When that scope has an existing instruction file, whether to add a short,
   managed Simple Changes pointer to the exact file.
8. When adding the pointer, whether to ask if completed work is ready
   (recommended), hand it off automatically after implementation and checks, or
   wait until the user says it is ready.

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
  "handoffTiming": "confirm-ready",
  "uiArtifactVersioning": "repository-convention",
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

Instruction setup edits only an existing exact `AGENTS.md`, `CLAUDE.md`, or
runtime-established global instruction file after confirmation. It never
creates a missing file or duplicates its managed block. The recommended pointer
asks whether implementation and checks are complete before Simple Changes takes
over. A completed-work agent can inspect the saved behavior with
`initialize --mode handoff`; after confirmation, `--ready` resolves the normal
queue, integrate, ship, or preview boundary.

UI iteration naming is conditional and applies only to deliberately preserved
screenshots, design exports, static previews, or similar artifacts. Repository
conventions always win. It does not rename UI source files or set Git,
deployment, package, or release versions.

For non-interactive setup:

```sh
bun run simple-changes setup \
  --finish ship \
  --changelog delegate-if-available \
  --production ask \
  --questions blocking-only \
  --scope user \
  --instruction-file /exact/existing/AGENTS.md \
  --instruction-pointer add \
  --handoff ask \
  --yes
```

For a task that will preserve multiple UI iterations, add `--ui-artifacts` and
`--ui-versioning repository|number-and-date|date-only|number-only`.

Even an automatic ship preference does not authorize remote migrations,
backfills, secrets or environment changes, DNS changes, store releases, or
history rewrites. Those operations still require explicit, exact-target
permission.

Before an authorized Ship run mutates repository or provider state, the agent
summarizes the ready scope, planned checks/merge/release/deploy path, separate
authority boundaries, and preserved work. This update is delivered while the
run proceeds; it does not add a redundant permission prompt. The final response
reports what actually shipped and identifies every material change made during
review, including the new exact head and re-verification.

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
