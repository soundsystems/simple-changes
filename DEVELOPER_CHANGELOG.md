# Developer changelog

## 0.11.1 - 2026-08-12

- Added explicit terminal lifecycle and controller-transfer contracts to the
  active-loop lease:
  - `loop finalize` applies the completion gates, deletes a fully reconciled
    lease, or persists an incomplete lease as `relinquished` with its reason
    and blockers while revoking the prior controller's mutation authority.
  - Resume adopts the same relinquished run, transfers controller ownership
    from a registered worktree, preserves the original mode and run ID, and
    appends a durable handoff record.
  - `loop takeover` requires an explicit approver and reason plus the exact
    current run ID and SHA-256 digest of the raw stored lease. Relinquished
    manifests remain immutable; status projects late concurrent-author
    admission only while the controller is active, so stale takeover evidence
    fails without rewriting relinquished state.
  - Controller lifecycle data remains optional in the closed lease schema for
    compatibility with older leases. Added regressions for complete and
    incomplete finalization, resume, post-relinquishment mutation blocking,
    legacy projection, late claims, and stale-versus-current takeover digests.
- Added end-to-end routine shipping preferences:
  - Policy and onboarding now support `standard` and `expedited`; legacy policy
    defaults to `standard`, while validated `break-glass` remains an advanced
    manual value.
  - Initialization returns the effective `shippingMode`, its closed schema
    requires the field, and trigger classification threads it into Emergency
    Ship selection only for Ship requests.
  - Advanced break-glass policy records `authoritySource: "advanced-policy"`
    while retaining separate production authority, rollback, focused-check,
    review, reconciliation, verification, and cleanup gates.
  - Onboarding now presents a workflow primer, includes shipping mode in its
    confirmation receipt, and advances installed guidance to version 4. Added
    policy-to-initialization-to-classifier, onboarding, schema, trigger, and
    skill-contract coverage.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T00:06:06-05:00" -->

## 0.11.0 - 2026-08-11

- Added run-only Emergency Ship classification and a resumable delivery state
  machine:
  - Trigger classification distinguishes urgency, active user impact, tested
    production readiness, and explicit deploy-before-review direction. It
    selects expedited shipping conservatively, grants break-glass only from
    explicit current authority, and persists closed evidence labels instead of
    raw request text.
  - A closed emergency-shipping ledger records exact candidate, deployed, and
    canonical revisions and artifacts alongside production authority, rollback
    evidence, focused checks, review, merge, changelog reconciliation,
    conditional redeployment, final verification, and cleanup state.
  - The decision engine preserves review-before-deploy ordering for expedited
    runs, routes rejected live break-glass candidates to rollback or correction,
    and avoids a second deployment only for an already-live canonical revision
    or proven immutable artifact equivalence.
  - Advanced installed guidance to version 3 and added schema, trigger,
    state-machine, contract, CLI, initialization, and behavioral evaluation
    coverage for the emergency workflow and its incomplete-state guarantees.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-11T15:17:59-05:00" -->

- Extended the closed changelog capability schema and TypeScript union with
  `guidance-update-notices`, plus a regression proving negotiation accepts a
  producer superset and returns only shared features. The paired Simple
  Changelogs producer fix canonicalizes schema JSON before hashing instead of
  deriving protocol digests from raw file text.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-11T16:08:07-05:00" -->

- Integrated the Emergency Ship ledger with the active-loop lease through new
  emergency record and status CLI operations, durable lease persistence,
  monotonic evidence and identity checks, a loop-end incomplete-delivery gate,
  and full completion-invariant derivation. Added rejection-first routing and
  loop persistence, resume, identity, and completion regressions. The paired
  canonical Simple Changelogs fix is merged at
  `bb795dd642a49690eceb0f45d3cbde7b3b740057` in MR !37, with canonical JSON
  schema hashing and coherent capability advertisement.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-11T17:11:06-05:00" -->

- Hardened emergency-ledger transitions so an expedited run can promote to
  break-glass before deployment only through explicit confirmation,
  `candidateArtifactId` and `authoritySource` become immutable once recorded,
  evidence labels are append-only, and `rollbackSupported` can move only
  monotonically to `true`. Added CLI and lease regressions for each invariant.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-11T17:21:49-05:00" -->

## 0.10.1 - 2026-08-10

- Split concurrent-author admission into an in-memory projection and a guarded
  persistence path. `loop status` now computes effective current admissions
  without taking the state lock or rewriting the lease, while mutation-capable
  observations continue to persist admissions under the existing lock. Added a
  regression that verifies active status with `.git/simple-changes` restricted
  to read and traversal permissions.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-10T19:11:21-05:00" -->

## 0.10.0 - 2026-08-10

- Added a provider-negotiated public-release transaction for Ship workflows:
  - New closed capability, request, receipt-v2, and release-delivery contracts
    negotiate exact schema digests and supported protocol versions before
    delegation. Legacy receipts remain limited to non-release or already
    reconciled compatibility paths.
  - Release classification, release-file preparation, and final read-only
    verification share a transaction ID, decision digest, effective-policy
    digest, release train, and complete input/reconciliation/finalized revision
    lineage. Structured reason and action codes drive approval, retry, and
    blocker behavior without parsing provider prose.
  - Version approval and production authority compose without becoming the
    same permission. The release gate invalidates stale decisions, prevents a
    new version on an unchanged deployment retry, and requires a verified
    target before the deployment adapter emits a composite delivery receipt.
  - Added coordinated onboarding primitives that retain separate policy owners
    and destinations, preserve successful partial writes, and resume only the
    incomplete owner. Added protocol CLI commands, closed schema coverage,
    release-gate and deployment regressions, and updated behavioral guidance.
- Added a versioned installed-guidance checkpoint for Simple Changes:
  - Repository and personal policy now persist a guidance version plus an
    `accepted`, `reviewed`, or `deferred` disposition. Policies written before
    the disposition field remain compatible, while newly initialized policies
    start at the current guidance version.
  - Write-capable initialization emits a structured notice for meaningful
    behavior, onboarding, or integration updates and blocks mutation until the
    user records an actual choice through `acknowledge-update`; read-only modes
    remain unblocked, and already-acknowledged write-capable runs continue.
  - The notice exposes practical settings actions and read-only Simple Changes
    release notes. A Simple Changelogs settings or history review appears only
    as a separately owned handoff when that capability is discovered, preserving
    the boundary that Simple Changes never authors or audits changelog history.
  - Added closed initialization and policy schema coverage plus focused runtime,
    CLI, onboarding, and skill-contract regressions for one-time persistence,
    absent-provider behavior, and mutation gating.
- Closed the opening-worktree claim race under `allow-claimed`: a qualifying
  active claim now promotes an existing preserved lease entry to
  `concurrent-author` at the next guarded observation, binds the exact claim and
  owner, and rejects redundant user overrides. Documentation and lease tests
  now require claiming a newly created independent worktree before any project
  inspection or mutation.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-10T18:28:40-05:00" -->

## 0.9.0 - 2026-08-09

- Added durable conversational onboarding for first write-capable use:
  - The onboarding contract now presents a request-aware first screen with
    recommended, customized, and run-only paths before collecting preferences.
    Recommended setup uses the resolved finish boundary, safe production and
    changelog defaults, and repository-first storage when a primary checkout is
    available; customized setup explains and asks only unresolved decisions.
  - Added explicit setup-style output, presentation hooks, workflow and storage
    diagrams, repository-versus-personal scope language, confirmation receipts,
    CLI coverage, behavioral evaluation expectations, and packaged guidance.
- Added a fail-closed GitLab remote-branch reconciliation completion gate:
  - Introduced a closed receipt schema and semantic validator over the union of
    complete initial and final provider inventories. Exact proposal heads,
    protected and target status, concurrent movement, audit evidence, and
    per-branch dispositions determine whether work is preserved or proven
    obsolete.
  - Integration, Ship, Reconcile, and resumed GitLab loops now carry explicit
    remote-branch deletion authority, persist a target-bound reconciliation
    receipt, and refuse to end when the receipt is missing, unsafe, stale, or
    names a project other than the exact project parsed from the selected target
    remote. Added CLI, lease, schema, contract, documentation, evaluation, and
    focused regression coverage for the gate, including wrong-project receipt
    rejection.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-09T00:42:26-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-09T00:57:18-05:00" -->

## 0.8.2 - 2026-08-07

- Removed version-sensitive inline Biome suppression dependencies from the
  distributed runtime:
  - Reworked process-group exit waiting into deadline-bound recursive polling,
    preserving sequential bounded termination checks without
    `noAwaitInLoops`.
  - Added `SimpleChangesError.withCause` and used it for lease and coordination
    lock failures, preserving error causes without the unsupported
    `lint/style/useErrorCause` category.
  - Added direct regression coverage for cause and exit-code preservation plus
    contract coverage forbidding obsolete suppression markers. Current
    Ultracite lint now validates the distributed sources without those
    diagnostics.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-07T21:05:24-05:00" -->

## 0.8.1 - 2026-08-07

- Closed three fail-closed gaps in concurrent-author admission and authority:
  - The runtime now resolves the target branch from the symbolic target ref,
    including local and remote-tracking refs, and excludes that branch from
    concurrent-author eligibility even when the integration controller is
    running on a separate feature branch.
  - A qualifying late claimed worktree is admitted once and persisted into the
    loop lease with its exact claim ID and owner. Subsequent verification uses
    that durable registration; an unregistered claimed worktree no longer
    receives an unbound pass, and claim release or reassignment fails closed.
  - Guarded integration mutation now explicitly requires the `controller` or a
    run-prepared `author` role in addition to matching agent and worktree
    authority. A `concurrent-author` may continue ordinary local edits and
    commits, but cannot invoke `loop guard` or `loop exec` even with the run ID.
  - Added regressions for a feature-branch controller with a claimed `main`
    target worktree, late claim reassignment from owner A to owner B, and
    guarded-executor rejection from a concurrent-author worktree. Updated the
    behavioral contract, evaluation expectation, documentation, package
    version, and CLI version for the 0.8.1 correction.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-07T19:42:35-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-07T19:53:09-05:00" -->

## 0.8.0 - 2026-08-07

- Split independent authoring from shared integration serialization:
  - Loop manifests add an `allow-claimed` or `strict` concurrency mode and a
    `concurrent-author` worktree role. One integration-controller lease still
    serializes shared target, proposal, merge, deployment, and cleanup work;
    it no longer acts as a repository-wide authoring mutex by default.
  - Opening and newly arrived non-primary worktrees become concurrent authors
    only when an active coordination claim matches their exact repository,
    path, branch, owner, and claim identity. Their HEAD and content may change
    normally, while claim release or reassignment, branch switches, primary or
    target-branch collisions, unclaimed worktrees, and competing controllers
    continue to block integration.
  - Concurrent-author worktrees remain outside the current package, merge, and
    cleanup scope unless explicitly handed off. The existing preserved-worktree
    pause, receipt, adoption, override, and audited-removal paths remain
    available for strict mode and genuine ownership collisions.
  - Repository and onboarding policy now defaults to `allow-claimed` and exposes
    `--concurrent-work allow-claimed|strict`. The legacy `preserve` policy value
    remains accepted and resolves to the concurrent default; existing lease
    documents without the optional mode remain schema-compatible.
  - Added runtime and manifest regressions for opening and late claimed authors,
    continued content drift, released claims, and strict serialization, plus
    behavioral eval coverage for both concurrent-default and strict workflows.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-08-07T18:58:51-05:00" -->

## 0.7.0 - 2026-08-07

- Added a provider-neutral cross-thread worktree coordination protocol:
  - Claims and append-only transition events are written atomically beneath the
    common Git directory with mode `0600`. Exact canonical path, Git directory,
    branch or detached identity, HEAD, and content digest evidence bind owner
    pauses, preserved adoption, changed-baseline acceptance, resume readiness,
    release, and stale-state detection.
  - Active-loop leases can adopt an owner-paused concurrent checkout without
    granting mutation authority, accept an opening preserved checkout only from
    its exact new receipt, and invalidate linked leases when claims or evidence
    become stale.
  - Clean non-primary worktrees with unique commits can be detached without
    force or branch deletion and reattached only when their recorded path,
    branch, and HEAD still match. Active-loop path requirements prevent unsafe
    detach or attach transitions.
  - Added capability profiles and bounded request construction for Codex
    desktop, same-host Claude Code, Cursor Cloud/SDK, Hermes gateway, and Grok
    Build controller scopes. Profiles require exact owner references and expose
    actionable manual blockers when discovery, delivery, waiting, scope, or
    worktree identity cannot be proven.
  - Added closed coordination and lease schemas, CLI commands, repository and
    behavioral documentation, eval journeys, and regression coverage for dirty
    preservation, exact adoption, changed opening state, detach/attach, stale
    claims, credential rejection, file permissions, and capability gating.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-08-07T17:44:36-05:00" -->

## 0.6.1 - 2026-08-06

- Added an explicit audited-removal disposition for opening worktrees:
  - `loop dispose-worktree` verifies loop ownership, a clean exact content
    digest, the original preserved role, a non-primary path, and zero commits
    beyond the lease's pinned target revision before recording user approval.
  - Loop leases now persist optional exact path, branch, head, digest, target,
    audit, reason, and approval evidence. Existing leases remain schema-valid.
  - Manifest verification accepts a missing preserved worktree only when that
    exact opening state was disposed. Any later branch, revision, or content
    change invalidates the disposition while the worktree exists.
  - Removal audits now compare against the lease's pinned target revision, and
    preflight/postflight accept disposition target evidence only when both its
    ref and revision exactly match the lease.
  - Added runtime, CLI, schema, contract, and behavior-evaluation coverage for
    approved cleanup and the protected dirty, unique-commit, unapproved, and
    canonical-primary cases.
  - Bound the CLI's reported version to this 0.6.1 release and added a
    package-to-CLI consistency regression test.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-08-06T15:27:26-05:00" -->

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
  - When a guarded command leader exits while same-group descendants remain,
    `loop exec` attempts bounded process-group termination and rejects the
    command even when cleanup succeeds. If descendants cannot be proven
    terminated, the mutation callback retains the lock and requires explicit
    recovery instead of releasing concurrent mutation.
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
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-08-03T13:54:04-05:00" -->

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
