# Developer changelog

## 0.6.0 - 2026-08-03

- Added an executable active-loop lease and content-sensitive worktree-manifest
  contract:
  - Queue, Sweep, Integrate, Ship, Reconcile, and Resume runs atomically persist
    one controller lease beneath the common Git directory. Loop start resolves
    and records the target ref's exact `targetRevision`, then captures a fresh
    under-lock inventory of each worktree's path, branch, head, content digest,
    role, and mutation authority. Target discovery prefers the current branch's
    configured remote, then `origin`, before considering auxiliary remotes.
  - Worktree change digests cover staged binary diffs, unstaged binary diffs,
    and the contents or symlink targets of every untracked path. Exact
    user-approved overrides therefore become invalid when file contents change,
    even if the porcelain status shape remains the same.
  - Mutation-authorized worktrees are bound to their registered branch.
    Verification, mutation guards, and repeated `prepare-agent` calls reject a
    checkout that has switched branches.
  - Added `loop exec` and the reusable asynchronous
    `withLoopMutationLease` callback. Both retain the atomic loop lock across
    fresh preflight inventory, ownership and manifest validation, the complete
    awaited mutation, fresh post-mutation inventory, and closing verification.
  - `loop exec` marks child launch as unresolved before spawning, then records
    the guarded child PID and process-group ID while the command runs.
    `loop recover` refuses recovery while launch state is unresolved, the
    guarded process group remains alive, a recorded child remains alive, or the
    controller process is not proven dead.
  - Repository setup and instruction-pointer writes run through the same atomic
    mutation callback whenever a loop is active, instead of performing writes
    after a one-time advisory guard.
  - Agent worktree creation records a pending preparation before Git mutation,
    including the agent, path, branch, purpose, and pinned base revision. A
    repeated `prepare-agent` resumes interrupted setup only when the worktree
    still matches that exact branch and revision and contains no staged,
    unstaged, or untracked changes.
  - Added closed contract support and regression coverage for branch-bound
    authoring, clean interrupted preparation, awaited callback execution,
    guarded process groups, conservative dead-lock recovery, exact overrides,
    and cleanup.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-08-03T13:33:34-05:00" -->

- Added first-class Sync and two-stage Ship contracts:
  - Sync initialization bypasses workflow-preference onboarding and grants only
    the new `local-sync` authority for exact-target fetch, fast-forward, and
    conflict-preflighted local target integration operations.
  - Sync trigger classification distinguishes canonical Git target requests
    from non-Git synchronization, while closed schemas and run-state types now
    carry the new mode, authority, and operation vocabulary.
  - Ship guidance records a pre-mutation scope brief and a final delivery
    receipt, including material review deltas from each proposal's original
    head, approval invalidation, replacement heads, and re-verification.
  - Added CLI, initialization, planner, trigger, schema, skill-contract, and
    behavior-evaluation coverage for the local-only Sync boundary and the
    two-stage Ship communication contract.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-29T13:30:44-05:00" -->

## 0.5.0 - 2026-07-28

- Added completed-work onboarding and handoff contracts:
  - Repository and personal policy now carry closed `handoffTiming` and
    `uiArtifactVersioning` preferences, with schema validation and safe defaults
    for existing policy files.
  - Setup discovers only established repository or explicitly supplied global
    instruction files, rejects symlinks and malformed managed blocks, and
    atomically adds or updates one confirmed pointer without creating an
    instruction file.
  - Initialization now accepts `handoff` mode and returns closed readiness,
    action, mutation, and resolved-mode fields. Confirmation through `--ready`
    unlocks only the configured ordinary finish boundary; automatic and
    user-signaled timing retain the same attribution, verification, and
    independent high-risk authority gates.
  - Conditional UI artifact naming adds repository-convention, number-and-date,
    date-only, and number-only fallbacks without extending the preference to
    source, Git, deployment, package, or release versions.
  - Added a packaged behavioral specification plus CLI, schema, onboarding,
    instruction-file safety, skill-contract, and behavior-evaluation coverage
    for the new contracts.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-28T09:15:09-05:00" -->

## 0.4.0 - 2026-07-27

- Added the Web production release gate for 0.4.0:
  - After final feature merges, changelog reconciliation is delegated or
    re-delegated against the exact refreshed target. Every target-contained
    `Unreleased` item must enter a dated, versioned release with established Web
    mirrors and proven product-version metadata before deployment.
  - Extended the changelog receipt schema and TypeScript contract with a
    structured release record containing `version`, `date`, and
    `targetContainedUnreleased: "integrated"`. A prepared receipt must carry
    this record; `not-applicable` requires evidence that the exact target is
    already reconciled.
  - Blocked or unavailable delegation, preserve-and-report disposition, version
    ambiguity, unmerged reconciliation, and unaccounted target-contained
    pending work now block production without discarding independently
    completed integration work.
  - Deployment and completion contracts now require the refreshed reconciled
    target, bind deployment evidence to its product release version, and report
    that version alongside canonical and observed revisions.
  - Advanced canonical `simple-changelogs` provenance from `1a7a03a` to merged
    commit `6a94bbe`. Reviewed its onboarding-pointer and Web-production
    updates; product-surface onboarding remains inapplicable to this
    repository-only release module.
  - Added deterministic schema and skill-contract tests for structured release
    receipts, exact-target reconciliation, blocking conditions, and the
    production deployment boundary.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-27T22:12:07-05:00" -->

- Synchronized the bundled generic `publish-skill` workflow with canonical
  `simple-changelogs` merged commit `919a3d85`:
  - Ownership mapping now captures a concrete baseline and classifies dirty
    original checkouts plus pre-existing worktrees, commits, and proposals as
    preserved information rather than active ownership or publication blockers.
  - Production and cleanup gates classify only post-baseline activity or a live
    exact-target claim as externally owned active work, recheck before
    mutation, and continue unaffected canonical, fork, and consumer publication
    through isolated remote-default worktrees.
  - Final reporting and package-design regression coverage now separate
    published results, preserved baseline state, externally-owned active work,
    and other genuinely failed or blocked targets.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-27T09:17:52-05:00" -->

- Synchronized the bundled generic `publish-skill` workflow with canonical
  `simple-changelogs` merged state `0cc206f`:
  - Added ownership classification and pre-mutation gates across `SKILL.md`,
    release mapping, production execution, merge verification, cleanup, and
    agent metadata. Active external work requires an exact handoff, cannot be
    delegated into scope, and remains explicit in the outstanding-work ledger.
  - Consumer discovery now resolves installation paths to physical identities,
    reports `installationCount`, collapses compatibility symlinks into one
    install, and preserves distinct physical copies as `multiple-installs`.
  - Expanded scanner coverage distinguishes aliased and duplicate installs,
    while package-design regression checks protect ownership, handoff,
    revalidation, cleanup, reporting, and metadata contracts.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-27T02:48:43-05:00" -->

## 0.3.0 - 2026-07-27

- Made Ship completion evidence derive from a freshly resolved canonical target
  after all merges, including resumed runs and runs that did not create a new
  deployment, so stale, divergent, or ahead-of-target production revisions
  remain incomplete.
- Renamed `DeploymentReceiptInput.intendedRevision` to `targetRevision` so
  provider adapters distinguish the caller-supplied canonical target from the
  normalized receipt's intended revision.
- Added contract and evaluation coverage for consequence-aware onboarding,
  post-merge target refresh, live revision comparison, and stale production
  rejection.
- Synchronized the repository-only release-note guidance with
  `simple-changelogs` at `1a7a03a`, carrying forward complete
  accessible-history initial backfills and withholding completion until every
  range and established mirror is accounted for. Product UI, mobile, CMS, and
  store guidance remains outside this skill repository's release surface.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-27T01:40:57-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-27T01:44:10-05:00" -->

## 0.2.0 - 2026-07-25

- Replaced `publish-simple-changes-forks` with the generic `publish-skill`
  workflow:
  - Added deterministic consumer discovery that normalizes owner/repository,
    HTTPS, and SSH source identities and classifies installed, multiple-install,
    lock-only, and unlocked states.
  - Added concurrent isolated-worktree reinstalls with maintained,
    validation-only, intentional-pin, and stale retention modes and an
    independent result for every consumer.
  - Added focused scanner and package-design contract tests covering consumer
    states, supported install roots, bounded all-settled validation, and shared
    agent metadata.
- Added conditional changelog coordination while preserving the boundary that
  Simple Changes does not author release text:
  - Separated changelog relevance from compatible workflow availability and
    added delegation, preservation, and ask-first preferences to onboarding and
    repository policy.
  - Added a closed handoff receipt with provider status, source revision,
    SHA-256 file digests, checks, evidence, release impact, and blocking reason.
  - Added validation that prepared receipts belong to the current stable
    worktree and delegated unit, still match every recorded digest, and trigger
    fresh inventory before packaging.
  - Added CLI schema validation and focused coverage for capability discovery,
    conditional onboarding, preference precedence, and receipt parsing.
  - Made inventory capture accept explicit changelog environment and home inputs
    so fixtures and CLI subprocesses isolate installed skill roots while runtime
    global discovery remains enabled and covered.
- Strengthened Queue mode's stable-unit accounting contract:
  - Carries every unit from the opening inventory through an outstanding-work
    ledger with its location, revision or proposal, stability, disposition,
    evidence, and next action.
  - Requires final reports to identify every deferred unit, including clean
    branches and separate worktrees, instead of treating the queued unit as the
    complete scope.
  - Added focused skill-contract coverage that protects the required ledger and
    deferred-unit report fields.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-24T15:47:44-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-25T03:51:17-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-25T04:01:03-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-25T11:15:46-05:00" -->

## 0.1.0 - 2026-07-23

<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-23T18:15:57-0500" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-23T18:24:58-0500" -->
<!-- simple-changelogs-signature agent="Codex" at="2026-07-23T18:21:26-05:00" -->

- Expanded normalized deployment receipts with provider readiness and an
  explicit expected canonical-target inventory. Verification now detects
  missing, unexpected, duplicated, and stale target observations instead of
  trusting the deployment's attached-alias list as the expected set.
- Added a provider-neutral, bounded deployment reconciliation decision contract
  for existing-artifact promotion and same-project managed-target repair.
  Production authority, immutable revision, Ready state, target ownership, and
  single-attempt bounds are enforced before either action; DNS transfers and
  wildcard changes remain separate high-risk operations.
- Added planned operations for promotion and managed-target reconciliation,
  closed-schema support for the new receipt fields, adapter regressions, and
  behavior journeys covering incomplete target coverage, stale-routing
  recovery, missing authority, and missing ownership proof.
- Added portable surface-parity guidance, complete-corpus proposal pagination,
  current-request pause re-evaluation, policy-aware non-author merge execution,
  and evidence-rich preserved/blocked handoffs based on downstream fork gaps.

- Established the portable package architecture: `SKILL.md` routes agent
  behavior, focused references own detailed workflows, and Bun/TypeScript
  enforces deterministic inventory, planning, and validation contracts.
- Added argument-array Git inspection, canonical checkout resolution, repeated
  snapshot digests, repository path-containment checks, symlink detection,
  secret redaction, and plan-conservation validation.
- Added closed JSON Schema contracts for policy, inventory, change plans, run
  state, provider receipts, release consistency, public release notes, runner
  requests and responses, and evaluation manifests.
- Added provider-neutral receipt normalization, approval-revision checks,
  deployment-evidence verification, fake forge adapters, and fixtures without
  implementing authenticated provider mutations.
- Added provider-agnostic data-change guidance covering paired or generated
  histories, compatibility windows, immutable applied revisions, dry runs,
  backfill safety, and post-apply verification.
- Added deterministic path classification for migration histories, schema
  definitions, queries or routines, backfills or seeds, and indexes or
  projections, including data-context checks that avoid treating unrelated
  query-language examples as database changes.
- Added unit and CLI coverage plus trigger and behavior evaluations for the
  credential-free preview boundary, including its zero-mutation and stateless
  guarantees.
- Extended unit tests and behavior journeys for data-path classification,
  generated ORM migrations, non-relational index changes, bounded backfills,
  and remote-write authority boundaries.
- Moved the Simple Changelogs-derived release-writing module into the
  repository-only `tooling/simple-changes/release-notes/` maintainer boundary.
  It is plain linked guidance rather than a discoverable second `SKILL.md` and
  is excluded from the public skill.
- Adopted `.simple-changelogs.json` guidance v4 for maintainer changelog policy,
  including required developer history, existing-only release-note surfaces,
  audit disposition, and canonical `simple-changelogs-signature`
  agent/timestamp comments. `.simple-changes.json` remains scoped to public
  change-integration behavior.
- Maintainer guidance covers first-use setup, historical backfill authority,
  honest pending and released boundaries, merge reconciliation, stable-major
  and prerelease synthesis, and the distinction between complete changelogs and
  compact announcements.
- Added deterministic `CHANGELOG.md` extraction for the latest or selected
  released section, with pending-section exclusion, HTML-comment stripping,
  Markdown and structured JSON output, and explicit errors for missing or empty
  releases.
- Made installed `release-notes` rendering resolve the packaged root changelog
  by default instead of the caller's current directory. Explicit `--repo`
  remains a read-only inspection override, and `--check` rejects calls that do
  not provide it.
- Added a closed consistency-report contract for mismatched public, developer,
  and package versions or dates, malformed or missing sources, and empty pending
  sections.
- Kept release evaluation schemas, five fixtures, the neutral behavior harness,
  deterministic evals, and both Simple Changes and Simple Changelogs fork-drift
  checks under `tooling/simple-changes/` as development-only assets.
- Added Codex CLI, Claude Code, Hermes Agent, Cursor Agent, and Grok Build
  behavior adapters with shared permission-locked guidance snapshots and
  runtime-specific isolation. Grok uses a strict sandbox with memory,
  subagents, plan mode, and web search disabled; the existing adapters retain
  their ephemeral, sandboxed, or disposable repository boundaries.
- Kept authenticated, quota-consuming behavior runs outside the default check
  while covering adapter command construction, schema handling, isolation,
  cleanup, and assertion enforcement with credential-free tests.
- Added package-shape evaluation that rejects maintainer-only release guidance,
  fixtures, tests, behavior tooling, and adapters from the installed skill and
  verifies that maintainer tooling contains no discoverable `SKILL.md`.
- Reduced the public `skills/simple-changes` tree from roughly 560 KB to
  268 KB by moving repository-only assets into maintainer tooling while keeping
  the installed CLI, contracts, and operational references self-contained.
- Adopted Apache-2.0 and standardized development checks on Bun, TypeScript,
  Biome, and Ultracite.
