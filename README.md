# Simple Changes

**Keep working. Merge when ready.**

Simple Changes is an open-source, agent-neutral skill that turns ready work in a
Git repository into focused, verified change proposals while preserving paused
and concurrent work. Its first release provides a credential-free vertical
slice: inspect a repository, classify stable and changing work, propose focused
units, and validate the result without mutating Git or contacting a provider.

## Quick start

Requires [Bun](https://bun.sh/) 1.2 or later and Git. The CLI is a Bun
TypeScript entry point; Node alone cannot run it.

Clone this repository, then from its root:

```sh
git clone https://gitlab.com/soundsystems/simple-changes.git
cd simple-changes
bun install
bun run simple-changes initialize --mode sync
bun run simple-changes initialize --mode queue
bun run simple-changes preview
bun run simple-changes preview --json
bun run simple-changes release-notes
bun run simple-changes release-notes --check --repo .
```

Install it once in the portable global Skills directory:

```sh
mkdir -p ~/.agents/skills
cp -R skills/simple-changes ~/.agents/skills/simple-changes
```

Agents with their own global skill directory can point to that one installation
instead of keeping another copy. For example:

```sh
mkdir -p ~/.codex/skills ~/.claude/skills
ln -s ~/.agents/skills/simple-changes ~/.codex/skills/simple-changes
ln -s ~/.agents/skills/simple-changes ~/.claude/skills/simple-changes
```

Keep repository-local installations only for repository-specific forks. A
repository can still commit `.simple-changes.json`; repository policy is
independent of where the skill is installed and overrides global personal
preferences. Before creating a symlink, move or remove any existing copy at its
destination so an older installation is not left nested beneath it.

A compatible changelog provider declares itself with a machine-readable
`changelog-provider.json` beside its `SKILL.md` (distribution, guidance
version, and protocol capabilities); discovery falls back to installation-name
inference only when no marker is present.

The installed directory is self-contained. Its release-note surface is
read-only: `release-notes` displays Simple Changes' packaged public history. It
does not author changelogs or provide release-writing guidance to users'
agents, and does not contain the repository's release harness or model
adapters. When `simple-changelogs` is available, Simple Changes can delegate a
focused changelog unit and validate its handoff receipt; the changelog skill
still owns classification and writing.

## Repository-specific forks

Install Simple Changes globally once, and let every repository use that one
install. Fork it only when a repository needs stricter or product-specific
behavior: copy the installed skill into the repository (for example
`skills/<project>-simple-changes`), rename it, and put a provenance line
directly below its title:

```md
Forked from `simple-changes` @ `<sha>`. <project>-specific deltas:
<provider boundaries, local commands, release surfaces, ...>
```

Then keep the fork current with the `update-local-forks` skill, which ships
in this package and is meant for anyone who forked, not only maintainers:

```sh
bunx skills add https://gitlab.com/soundsystems/simple-changes --skill update-local-forks
```

Ask an agent to update your local forks, or run the helper directly. It scans
global skill roots and conventional project folders (`Developer`, `Projects`,
`Code`, and `src`); pass `--root` for forks elsewhere. It plans one fork at a
time against the fork's pinned upstream base and the global install, applies portable upstream
changes, keeps every fork-specific edit and file, three-way merges files both
sides changed, and reports conflicts and omitted references for review instead
of overwriting them. It also advances the provenance pin only to the exact
release commit the global install matches, and rewrites the pin, guidance
version, and upstream version literals the fork's own checks pin. It never
commits or pushes; the fork repository's own Simple Changes policy ships the
update. Guidance updates therefore reach a fork's users the same way they
reach everyone else: through the next write-capable run's one-time notice.

```sh
bun ~/.agents/skills/update-local-forks/scripts/update-local-forks.ts discover
bun ~/.agents/skills/update-local-forks/scripts/update-local-forks.ts plan \
  --fork path/to/fork --json > plan.json
bun ~/.agents/skills/update-local-forks/scripts/update-local-forks.ts apply --plan plan.json
```

In a source checkout, the maintainer drift checker still works for a quick
pin comparison:

```sh
tooling/simple-changes/check-fork-sync.sh \
  path/to/fork/SKILL.md /path/to/simple-changes origin/main
```

Repository maintainers can invoke `skills/publish-skill` for the complete
canonical, fork, and consumer propagation workflow; it reuses the same fork
update rules. Repository names and paths are discovered at runtime and are
not embedded in the public package.

Install that workflow project-locally from a source checkout, using the
third-party [`skills` CLI](https://www.npmjs.com/package/skills) (or copy the
skill directory manually as shown in Quick start):

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
- Detects changelog relevance separately from skill availability, negotiates
  exact protocol/schema capabilities, and coordinates delegation through
  closed `classify`, `prepare`, and final read-only `verify` transactions.
- Treats every Web production deployment as a product release, requires a
  digest-bound version decision and verified full revision lineage, and emits a
  composite receipt binding that release to the observed deployment revision.
- Recognizes run-only Emergency Ship intent: urgency selects an expedited path
  that preserves pre-deploy review, while only explicit deploy-before-review
  direction enables break-glass. Both retain durable reconciliation debt and
  avoid a second deployment only when the final canonical result is already
  live or immutable artifact equivalence is proven.
- Inventories branches, stashes, local changes, worktrees, policy, and Git
  capabilities using argument-array subprocess calls.
- Takes two read-only snapshots and preserves work that appeared or changed
  between them.
- Holds one atomic active-loop lease for write-capable integration runs,
  persists a content-sensitive opening worktree manifest, runs local mutations
  under the lock from preflight through post-verification, awaits asynchronous
  callbacks, tracks guarded command process groups, terminates and rejects
  background descendants before normal lease release, and recovers only locks
  whose recorded processes are proven dead. Each new authoring agent receives
  one branch-bound, resumable isolated worktree from a pinned clean revision.
- Records a lease heartbeat on every operation that already writes lease state,
  reports `live`, `stale`, or `unknown` liveness in `loop status`, and clears
  only a provably stale lease through an approved `loop recover --stale-lease`
  that preserves every worktree, branch, claim, and receipt.
- Prunes proven-obsolete local checkouts, stale worktree metadata, and merged
  local branches without a lease through `prune`, so cleanup no longer depends
  on a run reaching `loop finalize`. It requires an approver and reason,
  supports `--dry-run`, names the containment method for each removal, and
  refuses to touch anything a lease that is not provably stale registers.
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

The deterministic CLI creates only explicitly requested, lease-registered,
branch-bound authoring worktrees for agents assigned to the same integration
unit. Independent agents claim their own distinct worktrees and may keep editing
and committing concurrently by default; only shared integration actions remain
single-controller. Interrupted registration resumes only from a clean checkout
on the recorded branch and revision. `loop exec` can run one
explicitly supplied local argument-array command while the lease lock is held,
but it does not
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
  [--changelog-install now|after-shipment|later|decline]
  [--concurrent-work allow-claimed|strict]
  [--production ask|allow|deny]
  [--shipping-mode standard|expedited]
  [--proposal-scheduling balanced|consecutive|parallel]
  [--questions blocking-only|always|never]
  [--scope user|repository|run] [--yes] [--json] [--repo PATH]
simple-changes setup [--finish review|integrate|ship]
  [--handoff ask|automatic|user-signaled]
  [--instruction-pointer add|leave] [--instruction-file PATH]
  [--ui-artifacts]
  [--ui-versioning repository|number-and-date|date-only|number-only]
  [--changelog delegate-if-available|preserve-and-report|ask]
  [--changelog-install now|after-shipment|later|decline]
  [--concurrent-work allow-claimed|strict]
  [--production ask|allow|deny]
  [--shipping-mode standard|expedited]
  [--proposal-scheduling balanced|consecutive|parallel]
  [--questions blocking-only|always|never]
  [--scope user|repository|run] [--yes] [--json] [--repo PATH]
simple-changes acknowledge-update --guidance-decision accepted|reviewed|deferred
  [--agent-id ID] [--json] [--repo PATH]
simple-changes inventory [--json] [--repo PATH]
simple-changes preview [--json] [--repo PATH] [--settle-ms N]
simple-changes loop start --mode MODE --agent-id ID [--changelog-required]
  [--opening-remote-inventory FILE] [--json] [--repo PATH]
simple-changes loop status [--json] [--repo PATH]
simple-changes loop verify --run-id ID [--json] [--repo PATH]
simple-changes loop guard --run-id ID --agent-id ID [--json] [--repo PATH]
simple-changes loop record-scope --run-id ID --agent-id ID
  --receipt FILE [--json] [--repo PATH]
simple-changes loop refresh-scope --run-id ID --agent-id ID
  --receipt FILE [--json] [--repo PATH]
simple-changes loop record-outcome --run-id ID --agent-id ID
  --receipt FILE [--json] [--repo PATH]
simple-changes loop exec --run-id ID --agent-id ID [--json] [--repo PATH]
  -- COMMAND [ARG ...]
simple-changes loop recover --agent-id ID [--json] [--repo PATH]
simple-changes loop recover --stale-lease --run-id ID --agent-id ID
  --approved-by ID --reason TEXT [--json] [--repo PATH]
simple-changes loop takeover --run-id ID --agent-id ID
  --manifest-digest SHA256 --approved-by ID --reason TEXT [--json] [--repo PATH]
simple-changes loop allow --run-id ID --agent-id ID --worktree PATH
  --status-digest SHA256 --approved-by ID --reason TEXT [--json] [--repo PATH]
simple-changes loop dispose-worktree --run-id ID --agent-id ID --worktree PATH
  --status-digest SHA256 --approved-by ID --reason TEXT [--json] [--repo PATH]
simple-changes loop retain-worktree --run-id ID --agent-id ID --worktree PATH
  --status-digest SHA256 --approved-by ID --reason TEXT [--json] [--repo PATH]
simple-changes loop retire-absent-worktree --run-id ID --agent-id ID
  --worktree PATH --approved-by ID --reason TEXT [--json] [--repo PATH]
simple-changes loop adopt-worktree --run-id ID --agent-id ID
  --pause-receipt ID [--json] [--repo PATH]
simple-changes loop accept-paused-change --run-id ID --agent-id ID
  --pause-receipt ID [--json] [--repo PATH]
simple-changes loop reconcile-remote-branches --run-id ID --agent-id ID
  --receipt FILE [--json] [--repo PATH]
simple-changes loop recover-post-cleanup --run-id ID --agent-id ID
  --receipt FILE [--json] [--repo PATH]
simple-changes loop close-equivalent --run-id ID --agent-id ID
  --approved-by ID --reason TEXT [--evidence FILE ...] [--json] [--repo PATH]
simple-changes loop end --run-id ID --agent-id ID [--json] [--repo PATH]
simple-changes loop finalize --run-id ID --agent-id ID --reason TEXT
  [--json] [--repo PATH]
simple-changes worktree status [--json] [--repo PATH]
simple-changes worktree observe [--json] [--repo PATH]
simple-changes worktree request --claim-id ID --run-id ID
  --request-action request-pause|request-detach|notify-resume
  [--json] [--repo PATH]
simple-changes worktree claim --agent-id ID --worktree PATH --adapter ID
  [--owner-ref REF] [--json] [--repo PATH]
simple-changes worktree pause --agent-id ID --worktree PATH --run-id ID
  --disposition preserve-in-place|detach-clean-checkout --reason TEXT
  [--json] [--repo PATH]
simple-changes worktree detach --agent-id ID --worktree PATH
  --pause-receipt ID [--json] [--repo PATH]
simple-changes worktree attach --agent-id ID --claim-id ID [--json] [--repo PATH]
simple-changes worktree resume-ready --run-id ID --agent-id ID --claim-id ID
  [--json] [--repo PATH]
simple-changes worktree release --agent-id ID --claim-id ID [--json] [--repo PATH]
simple-changes worktree takeover --claim-id ID --agent-id NEW_OWNER
  --status-digest SHA256 --approved-by ID --reason TEXT [--release]
  [--json] [--repo PATH]
simple-changes worktree equivalence --worktree PATH [--target REF]
  [--json] [--repo PATH]
simple-changes branch audit --head REF --target REF [--json] [--repo PATH]
simple-changes prune --approved-by ID --reason TEXT [--target REF]
  [--dry-run] [--json] [--repo PATH]
simple-changes prepare-agent --run-id ID --agent-id ID --purpose SLUG
  [--json] [--repo PATH]
simple-changes release-notes [--check] [--json] [--repo PATH] [--version VERSION]
simple-changes negotiate-changelog CAPABILITIES_FILE [--json]
simple-changes validate-changelog-transaction REQUEST_FILE RECEIPT_FILE [--prior-receipt FILE] [--json]
simple-changes release-gate --request FILE --receipt FILE [--prior-receipt FILE]
  --production ask|allow|deny [--already-live] [--production-authorized]
  [--version-authorized] [--json]
simple-changes release-delivery --changelog-receipt FILE --provider-receipt FILE
  [--request FILE] [--json]
simple-changes proposal-signatures --agent NAME --role authored|reviewed|merged
  [--base REF --head REF] [--changelog-receipt FILE] [--json] [--repo PATH]
simple-changes validate KIND FILE [--json]
simple-changes verify-markdown FILE [--json]
simple-changes help
```

`KIND` is one of `repo-policy`, `changelog-capabilities`, `changelog-request`,
`changelog-receipt`, `emergency-shipping`, `initialization`, `inventory`,
`change-plan`, `run-state`, `permission-bundle`, `provider-receipt`,
`release-delivery-receipt`, `remote-branch-reconciliation`,
`release-consistency`, `release-notes`, `loop-lease`, `loop-close-equivalent`,
`migration-review`, `migration-pending`, `migration-apply-plan`,
`post-cleanup-recovery`, `shipment-outcome`, `stale-lease-recovery`,
`worktree-cleanup`, `worktree-coordination`, `worktree-takeover`,
`worktree-equivalence`, or `branch-audit` (the schema filenames under
`skills/simple-changes/evals/schemas/`).

Before reapplying an old branch, use `branch audit` from the primary checkout
to discover possible rebased or squashed replacements already reachable from
the target. Full `Original-Commit` trailers provide explicit lineage; legacy
discovery looks for matching subjects and shared paths. Results are advisory,
bounded, and require independent review—not cleanup permission. See
[replacement lineage](skills/simple-changes/references/replacement-lineage.md)
for preserving provenance and handling incomplete evidence.

Worktree claims and pause receipts are local, mode-`0600` coordination evidence
stored beneath the repository's common Git directory. A claim records only an
opaque provider-neutral owner reference; it never stores prompts, message
bodies, credentials, or provider tokens. `loop adopt-worktree` converts an
exact owner-paused concurrent worktree into immutable preserved state.
`loop accept-paused-change` refreshes an opening preserved baseline only from an
exact receipt. `worktree detach` is deliberately separate from disposal: it
allows a clean non-primary checkout with unique commits to be removed without
force while retaining its branch at the exact HEAD, and `worktree attach`
recreates only that recorded branch and path.

Host integrations must probe their capabilities before automating owner
contact. `worktree request` returns the portable bounded request, a capability
profile listing the exact conditions the host layer must verify before
automating, and any structured manual blocker, without changing coordination or
Git state. Codex desktop task tooling and qualifying same-host Claude Code
installations (cross-session messaging enabled on macOS or Linux) can support
exact discovery, delivery, and waiting once every probe condition is verified;
native-Windows and cross-machine Claude Code sessions return a manual blocker.
Cursor Cloud/SDK, Hermes TUI gateway, and controller-owned Grok Build sessions
are supported only within their proven scopes. Every other mode returns a
structured manual coordination blocker and leaves Git and the active lease
unchanged.

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

On first use, it explains why onboarding appeared, shows the exact recommended
workflow, and makes clear that nothing has been pushed, merged, deployed, or
saved yet. The first choice is:

1. **Use recommended setup**: Apply the safe, request-aware defaults and show a
   receipt before saving them.
2. **Customize**: Explain and ask only unresolved preferences, one at a time.
3. **Use recommended setup for this run only**: Continue without a preference
   file and ask again next time.

Customized setup uses small workflow and storage diagrams where they make a
boundary clearer. It then asks:

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
6. **Where should these preferences live?** Visible repository policy, private
   personal fallback defaults, or this run without writing a preference file.
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
    "disposition": "accepted",
    "version": 3
  },
  "changelogHandling": "delegate-if-available",
  "defaultFinish": "open-change-request",
  "handoffTiming": "confirm-ready",
  "proposalSignatures": "agent-and-version",
  "uiArtifactVersioning": "repository-convention",
  "questions": "blocking-only",
  "review": "repository-policy",
  "productionDeploy": "ask",
  "concurrentWork": "allow-claimed"
}
```

Meaningful installed-skill updates pause the next write-capable run once and
explain the practical Simple Changes behavior or setting changes. Users can
review the affected settings, keep their current choices, defer the update for
that guidance version, or view detailed Simple Changes release notes. The
decision is remembered so the same version does not prompt again.

When Simple Changelogs is also present, Simple Changes may offer a separate
handoff for that skill to review its own settings or existing release notes.
Simple Changes never performs that historical review itself, and no changelog
action appears when the companion skill is absent.

`allow-claimed` is the default: independent agents may keep editing and
committing on distinct, non-primary claimed worktrees while one integration
controller handles push, proposal, merge, deployment, and cleanup operations.
Create the claim immediately after `git worktree add` and before any project
inspection, setup, generation, formatting, or editing in the new checkout. If a
lease recorded the worktree as `preserved` before the claim appeared, its next
guarded observation promotes the valid active claim to `concurrent-author`;
ordinary claimed concurrency never requires `loop allow` or user approval.
Set `concurrentWork` to `strict` to require repository-wide pauses. The legacy
`preserve` value remains accepted and now follows the safe concurrent default.

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
`initialize --mode handoff --agent-id <owner>`; after confirmation, `--ready`
resolves the normal queue, integrate, ship, or preview boundary. The exact
claim owner identity lets a completed handoff release its own worktree claim.

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
