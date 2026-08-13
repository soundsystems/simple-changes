# Changelog

## 0.12.2 - 2026-08-13

- Preserved concurrent worktrees can now hand off an exact stable pause without
  deadlocking a shipment, including worktrees previously retained or promoted
  to active authors. Obsolete opening worktrees are audited against the
  refreshed canonical target while rewritten targets still fail closed.
- Active loops now bind exact Git fetch and push destinations and apply
  provider-specific cleanup only to the selected target remote. GitLab branch
  reconciliation also proves complete initial and final pagination for branches
  and proposals before cleanup can finish.
- Repository policy can no longer silently grant persistent push, automatic
  migration, break-glass, or production authority. Consequential settings
  require a private digest-bound local trust receipt, and symlinked policy files
  are rejected.
- Automatic migration decisions now bind the exact target, fresh remote ledger,
  adapter, argument-vector command, nonce, and expiration window. Changed,
  replayed, stale, or broader execution plans require fresh review and
  authority.
- Worktree inventory now hashes large files incrementally and identifies FIFOs
  and other special files without opening them, avoiding unbounded binary-diff
  memory use and blocking reads.
- Setup now asks about push authorization for every workflow that can push,
  honors the repository's changelog distribution when selecting a provider,
  and uses synchronized guidance for retained cleanup and current defaults.
- Installed update prompts now explain practical new abilities first and
  recommend reviewing what changed. Saving automatic Git pushes requires a
  precise cross-harness explanation and confirmation of its single verified
  repository-and-remote scope and the authority it does not grant.
- Ship now presents every currently knowable unresolved permission together as
  an exact-target checklist with stable IDs. Users can approve all listed
  items, approve selected IDs, or decline them without granting authority for
  unlisted future actions or bypassing host security enforcement.

## 0.12.1 - 2026-08-13

- Ship setup now supports harness-aware Git push authorization.
  `gitPushAuthorization` defaults to `ask`; users can instead configure a narrow
  repository-scoped harness rule or prevent pushes entirely.
- Clean, target-contained worktrees can now remain in place as exact unchanged
  shipment exclusions. Any later change pauses integration until the worktree
  is claimed by its owner or paused at a stable boundary.

## 0.12.0 - 2026-08-12

- Update notices now use clear headlines and short practical summaries, while
  first-use onboarding walks through every main Simple Changes workflow.
- Simple Changes now separately detects when an installed Simple Changelogs
  skill is newer than the repository's recorded guidance.
- When a shipment requires changelog work, any Simple Changelogs update choice
  is completed before the shipment loop, lease, or pre-ship brief begins.
- Saved `shippingMode: "break-glass"` with `productionDeploy: "allow"` now
  makes an ordinary Ship request sufficient, without a redundant authorization
  phrase. Proven rollback and full post-deployment completion remain mandatory.
- Migration setup now offers `ask-after-review`,
  `auto-apply-reviewed-routine`, `auto-apply-reviewed`, and `never` modes,
  bound to exact saved provider, project, and environment targets.
- Every migration is technically reviewed before an apply decision. The new
  migration decision command requires the saved review, a fresh pending set,
  and an exact apply plan. It binds them to the SHA-256 identity of canonical
  operation records containing each revision path and content digest, rejects
  symlinked paths, and re-hashes the current repository files before policy
  evaluation. Automatic authority covers only the exact listed operations;
  replayed evidence, same-path content edits, and broad native apply-all
  commands fail closed and require explicit authority, as do other safety-gate
  failures.

## 0.11.4 - 2026-08-12

- Terminal completion now refuses to close until the primary checkout is clean
  and restored to the refreshed local target and all clean merged branches and
  worktrees are removed. Dirty non-primary worktrees, branches with unique
  commits, and actively claimed concurrent work remain preserved.

## 0.11.3 - 2026-08-12

- Break-glass runtime guidance now identifies the deploy-first revision as the
  exact candidate, without implying that focused checks ran before deployment.
  Delivery behavior is unchanged.

## 0.11.2 - 2026-08-12

- Internal-only, developer-only, preview, staging, and developer-experience
  changes no longer prompt for an unused public version.

- Explicitly authorized break-glass delivery now uses known native provider
  rollback capability to deploy immediately without a blocking current-
  production lookup, then verifies health, runs focused checks, and completes
  review, reconciliation, and canonical verification.

## 0.11.1 - 2026-08-12

- Integration controllers now finish every terminal turn with `loop finalize`:
  - Complete runs close and release their lease; incomplete runs preserve their
    exact reconciliation evidence, record remaining blockers, relinquish
    controller authority, and reject further mutations from that controller.
  - A later controller can resume the same relinquished run. An active
    controller that disappeared without finalizing can be replaced only through
    explicit takeover bound to the exact run and current stored manifest.
  - Existing leases without controller-lifecycle metadata remain compatible
    and continue as active leases.
- First-use onboarding now explains the inventory, focused-change, review,
  delivery-verification, and safe-cleanup workflow before asking questions.
  Routine Ship requests can use standard or expedited delivery by default;
  break-glass remains an advanced manual setting with separate production
  authority and rollback requirements.

## 0.11.0 - 2026-08-11

- Emergency Ship now provides two run-only paths for urgent production changes:
  - Urgency can select expedited shipping, which keeps focused checks and
    independent review before merge and deployment, then finishes release
    reconciliation, remaining verification, and cleanup.
  - Only explicit deploy-before-review direction authorizes break-glass.
    Active user impact or a tested production-ready claim can recommend it but
    cannot waive review. Break-glass records rollback evidence, deploys one
    exact checked candidate, and remains incomplete until independent review,
    canonical Git and release reconciliation, production verification, and
    cleanup finish.
  - A second deployment is required only when the final canonical runtime
    result differs. An already-live canonical revision or proven immutable
    artifact equivalence is verified without creating a duplicate deployment.

- Changelog capability negotiation now accepts compatible producer capability
  supersets while selecting only features shared with Simple Changes.

- Emergency Ship now persists and resumes its exact delivery ledger under the
  active loop, and refuses loop completion while emergency delivery remains
  incomplete.

## 0.10.1 - 2026-08-10

- `loop status` is now genuinely read-only. It reports the effective active
  lease and newly eligible concurrent authors without acquiring the
  active-loop lock or writing Simple Changes Git metadata, so inspection still
  works when that state is readable but not writable.

## 0.10.0 - 2026-08-10

- Public releases now use a negotiated, revision-bound handoff with Simple
  Changelogs:
  - Ship runs verify the provider's exact protocol and schema capabilities,
    then carry each release train through read-only classification,
    release-file preparation, and final target verification.
  - Version direction and production approval remain independent decisions,
    stale approvals fail closed when their policy, decision, schema, or target
    changes, and completed deployments carry a composite receipt that binds the
    selected version to the observed live revision.
- Meaningful installed guidance updates now pause the next write-capable run
  once before mutation. Users can review affected Simple Changes settings, keep
  their current choices, defer that guidance version, or view its detailed
  release notes. Any Simple Changelogs settings or history review remains a
  separate, optional owner-controlled handoff.
- Independent agents can now claim a worktree immediately after creating it
  even when an active loop first recorded that checkout as preserved. The next
  guarded observation recognizes the claimed concurrent author automatically,
  without a pause, adoption, override, or extra approval.

## 0.9.0 - 2026-08-09

- First-use onboarding now opens with a request-aware explanation of why setup
  appeared, the recommended workflow and storage behavior, and the assurance
  that nothing has been written or sent. Users can accept the recommendation,
  customize unresolved preferences one at a time, or use the recommendation
  for only the current run before confirming a complete receipt.
- GitLab integration runs now reconcile every remote branch before completion.
  The final ledger preserves canonical, protected, open-proposal, concurrent,
  and ambiguous work, and removes only branches whose exact provider evidence
  proves them obsolete.

## 0.8.2 - 2026-08-07

- Runtime sources now pass current Biome and Ultracite checks across consuming
  repositories without stale or version-sensitive suppression diagnostics.

## 0.8.1 - 2026-08-07

- Worktrees on the integration target branch can no longer become concurrent
  authors. Claimed worktrees that arrive after a loop starts are now durably
  bound to their exact claim and owner at first guarded observation, so later
  claim release or reassignment blocks integration instead of inheriting the
  replacement claim. Concurrent authors may keep making ordinary local edits
  and commits, but cannot use the guarded integration executor even when they
  know the active run ID.

## 0.8.0 - 2026-08-07

- Independent agents can now keep editing and committing in distinct, actively
  claimed non-primary worktrees while one integration controller handles shared
  push, proposal, merge, deployment, target, and cleanup operations. The
  controller excludes concurrent-author worktrees unless their owners hand
  them off, while lost claims, branch changes, target collisions, and competing
  integration controllers still fail closed.
- Concurrent claimed worktrees are enabled by default. Repositories that need
  the previous repository-wide pause behavior can select `strict` through
  `--concurrent-work strict` or repository policy.

## 0.7.0 - 2026-08-07

- Added coordinated ownership for worktrees shared across agent tasks. Owners
  can bind a checkout to exact local evidence, pause with a content-sensitive
  receipt, and let an active loop adopt that checkout as immutable preserved
  state. Controllers can also accept an exact paused update, mark the work safe
  to resume, or temporarily detach and later restore a clean checkout while
  retaining its branch and unique commits.
- Coordination adapters now report their proven discovery, delivery, waiting,
  scope, and worktree-identity capabilities before automating contact with
  another task. Unsupported host modes fail closed with a structured manual
  next action, and durable coordination records exclude prompts, message
  bodies, credentials, and provider tokens.

## 0.6.1 - 2026-08-06

- Opening worktrees that are proven clean, contain no commits beyond the
  pinned target, and receive explicit user approval can now be recorded as
  obsolete and removed without invalidating the active-loop manifest. The
  disposition is bound to the worktree's exact path, branch, revision, and
  content; dirty, changed, uniquely committed, unapproved, or canonical primary
  worktrees remain protected. The CLI now reports the matching 0.6.1 package
  version.

## 0.6.0 - 2026-08-03

- Write-capable integration runs now hold one exclusive active-loop lease and
  keep local mutations, including asynchronous operations, guarded from
  preflight through post-verification. New authoring agents receive isolated,
  branch-bound worktrees through `prepare-agent`, with interrupted setup
  resuming only from the pinned clean state. Worktree approvals track actual
  staged, unstaged, and untracked content. Guarded commands stop and reject
  lingering same-group background work before lock release; if cleanup cannot
  be proven, the lock remains for explicit recovery.

- Added a guarded Sync mode for requests to update from the canonical remote
  target. It refreshes only the resolved target, safely updates clean local
  branches when possible, preserves unsafe checkout state, and never treats
  synchronization as permission to push, rewrite history, deploy, or change
  remote data.
- Authorized Ship runs now begin with a concise scope and delivery-path brief
  while work proceeds, then finish with exact delivery receipts, review-driven
  changes, re-verification, and preserved or blocked work.

## 0.5.0 - 2026-07-28

- Onboarding can now add or update a managed Simple Changes pointer in an exact
  existing agent instruction file and save whether completed, verified work
  should wait for confirmation, hand off automatically, or wait for an explicit
  user signal. The new `initialize --mode handoff` workflow reports the
  readiness gate and resolved review, integration, ship, or preview boundary;
  `--ready` records confirmation when required.
- Tasks that preserve multiple UI iterations can now save a fallback artifact
  naming preference with `--ui-artifacts` and `--ui-versioning`. Repository
  conventions remain authoritative, and the preference never controls source,
  Git, deployment, package, or release versions.

## 0.4.0 - 2026-07-27

- Web production deployments now require a complete product release: Simple
  Changes reconciles target-contained pending work into a dated, versioned
  release, deploys only the refreshed reconciled target, and reports the product
  version.

- Skill publishing now distinguishes preserved baseline state from active
  external work. Dirty or unrelated original checkouts and pre-existing
  worktrees, commits, or proposals stay untouched but do not block publication
  through an isolated remote-default worktree. Only activity observed after
  the baseline or a live claim on the exact target is treated as externally
  owned active work, and finished reports separately list published results,
  preserved baseline information, and genuinely outstanding targets.

- Skill publishing now preserves branches, worktrees, and merge or pull
  requests owned by another active agent, task, or person. Broad requests to
  ship, integrate, or prune do not transfer ownership: mutation requires an
  exact explicit handoff, ownership is rechecked immediately beforehand, and
  protected work is reported with the authority still needed.
- Consumer discovery now treats compatibility paths that resolve to one
  physical skill package as a single installation while continuing to flag
  distinct copies for reconciliation.

## 0.3.0 - 2026-07-27

- Onboarding now explains the consequence of every available option before a
  user chooses how far to take work, handle production and changelogs, request
  help, or save preferences.
- Ship and resumed Ship runs now refresh the canonical remote target after all
  merges and refuse to report completion when the live deployment revision
  differs from that target.

## 0.2.0 - 2026-07-25

- Skill publishing:
  - The generic `publish-skill` workflow now carries canonical updates through
    maintained forks and every discovered exact-source local consumer.
  - Consumer installs are validated independently while maintained installs and
    intentional pins retain their declared behavior.
- Changelog coordination:
  - Simple Changes now asks how changelogs should be handled only when a
    changelog surface or compatible workflow is available.
  - Delegated changelog changes are accepted only when a source- and
    digest-bound receipt proves the current files and their release impact.
- Queue mode now accounts for every stable unit discovered at the start of a
  run and reports each deferred branch or worktree with its current state,
  reason, and next action.

## 0.1.0 - 2026-07-23


- Production deployment verification now checks the complete configured set of
  canonical endpoints against the immutable deployment, rather than accepting a
  Ready artifact or one correct hostname.
- Stale provider-managed routing now follows a bounded recovery sequence that
  promotes the existing verified artifact, refreshes every endpoint, and
  reconciles only proven same-project targets without creating duplicate
  deployments or treating DNS changes as ordinary deploys.
- Multi-surface changes now carry explicit parity dispositions for related
  clients, roles, locales, and interfaces while preserving platform-native
  behavior and separate release authority.
- Requests to audit every change proposal now require complete pagination across
  relevant provider states.

- Added the portable Simple Changes skill and CLI for turning repository state
  into focused, verified change proposals while preserving paused and
  concurrent work.
- Added read-only `inventory` and `preview` commands that resolve the canonical
  primary checkout, inspect worktrees, branches, stashes, local changes, policy,
  and available delivery capabilities, then account for every changed path.
- Repeated snapshots distinguish stable work from work that appears or changes
  during a run, so active work remains preserved instead of being swept into a
  proposal.
- Added a strictly read-only `release-notes` command for displaying the latest
  Simple Changes release or a selected version in text or JSON.
- Release-note display defaults to the packaged Simple Changes changelog
  regardless of the current working directory, and an explicit `--repo` can
  inspect another checkout without changing it.
- Public release-note output omits pending `Unreleased` content, private HTML
  comments, and developer-only history.
- Maintainer consistency checking requires
  `release-notes --check --repo PATH`, making repository inspection an explicit
  choice while catching mismatched public, developer, and package releases.
- The installed skill contains no changelog-writing guidance, release behavior
  harness, or model adapters. It reports release impact for handoff but does not
  create or edit release history.
- Simple Changes can be installed alongside `simple-changelogs` without
  overlapping responsibilities: Simple Changes integrates ready work and
  displays its packaged notes, while `simple-changelogs` owns changelog
  authoring.
- Added portable Skills-directory installation and auditable guidance for
  repository-specific Simple Changes forks.
- Added provider-neutral guidance for safely classifying database and
  data-system changes, including migrations, schemas, queries, backfills,
  indexes, and projections, without granting remote-write authority.
- Added schema validation, multiline Markdown verification, human-readable and
  JSON reports, and stable exit codes.
- This initial credential-free release does not create commits, push branches,
  open or merge change proposals, deploy, apply migrations, or clean up Git
  state.
