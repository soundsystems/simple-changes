# Changelog

## 0.12.5 - 2026-08-15

- Every GitLab Queue, Sweep, Integrate, Ship, Reconcile, and Resume run now
  saves its complete opening branch and proposal inventory before any provider
  mutation. A legacy record without that evidence can close only through the
  explicit post-cleanup recovery path; ordinary reconciliation, ending, or
  finalization cannot bypass it.
- With explicit user approval, Simple Changes can repair and close an old
  bookkeeping record when cleanup already finished, but only after two matching
  complete post-cleanup inventories, two ordered worktree-claim observations
  with matching digests and zero active claims, and clean current state prove
  that no open proposal or cleanup action remains. Blank approval or audit
  reasons are rejected.
- Post-cleanup recovery can only close bookkeeping: it cannot move refs, remove
  worktrees or branches, change provider state, push, merge, or deploy.
  Worktree claims remain locked from final verification through the auditable
  close, removed-worktree history no longer blocks future runs, and an
  interrupted recovery can be retried safely.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-15T08:15:36-05:00" -->

## 0.12.4 - 2026-08-14

- Simple Changes now explains user-facing status in plain language first: what
  happened, what it means, and what happens next. Most routine progress updates
  stay within one to three short sentences, while exact revisions, paths,
  commands, providers, and workflow states remain available when they affect
  safety, authority, verification, or a user decision, and whenever the user
  asks for technical detail.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-14T21:04:28-05:00" -->

## 0.12.3 - 2026-08-14

- Integrate, Ship, Reconcile, and Resume now finish their own proven local
  cleanup: unchanged clean target-contained opening and run-created worktrees
  are removed, stale worktree metadata is pruned, and only target-contained
  branches proven unchanged by their opening name-and-SHA ledger or owned by
  the run are deleted. Finalization holds its controller and worktree
  coordination locks, rechecks each worktree's branch, head, digest, and claim
  immediately before removal, and durably records that exact automatic removal
  intent before destructive Git worktree removal or metadata pruning. Late or
  moved branches remain protected.
- A clean primary checkout is restored and fast-forwarded to the refreshed
  target. A tracked dirty-primary path is normalized first only when its current
  bytes exactly match that target, every index entry has ordinary flags, and
  the index is recoverable from current HEAD or the target using
  intent-to-add-visible comparison. Intent-to-add or other nonordinary index
  state, unique staged content, conflicts, untracked or divergent paths,
  retained exclusions, active claims, late arrivals, dirty non-primary
  worktrees, and branches with unique commits remain protected; cleanup reports
  every normalized path.
- Incomplete finalization now exits nonzero after preserving resumable state,
  so a dirty or stale primary checkout cannot be reported as a completed run.
- If finalization is killed after an automatic removal, recovery can clear only
  the matching stale loop and coordination locks owned by the same dead local
  PID. The persisted exact removal intent then lets cleanup resume without
  treating the already removed preserved worktree as an unresolvable blocker.
- Multiple historical preserved-worktree overrides can now be approved and
  persisted one path at a time. Each exact valid path-and-digest override is
  saved even while another preserved path remains blocked, avoiding an
  impossible all-at-once authorization deadlock.
- Simple Changelogs discovery now matches an installed provider's exact
  distribution instead of mistaking a full installation's compatibility
  warning for `skill-repository` support. Repository and global skill roots now
  enumerate the mapped full, mobile, skill-repository, Web, and Web CMS
  installation names rather than looking only for the full distribution.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-14T01:53:58-05:00" -->

## 0.12.2 - 2026-08-13

- Preserved concurrent worktrees can now hand off an exact stable pause without
  deadlocking a shipment, including worktrees previously retained or promoted
  to active authors. Obsolete opening worktrees are audited against the
  refreshed canonical target while rewritten targets still fail closed.
- Active loops bind Git fetch and push destinations without persisting URL
  usernames, passwords, query strings, or fragments and apply provider-specific
  cleanup only to the selected target remote. Legacy controllers remain
  inspectable but fail closed for guarded mutation until relinquished and
  restarted; older reconciliation evidence also requires a fresh receipt.
- Repository policy can no longer silently grant persistent push, automatic
  migration, break-glass, or production authority. Consequential settings
  require a private digest-bound local trust receipt, and symlinked policy files
  are rejected.
- Automatic migration decisions now bind the exact target, fresh remote ledger,
  absolute adapter executable and digest, argument-vector command, nonce, and
  expiration window. Apply snapshots the verified executable, consumes the
  one-time authorization, then launches the snapshot without a shell; changed,
  stale, broader, or replayed plans require fresh evidence and authority.
- Worktree inventory hashes large files incrementally through a no-follow file
  descriptor check and identifies FIFOs and other special files without opening
  them, avoiding unbounded binary-diff memory use and blocking reads.
- GitLab reconciliation separately accounts for branches and proposals in the
  opening and final inventories, requires complete cursor chains and proposal
  states, and binds every ordered page-digest list into the consolidated
  matching-phase ledger digest.
- Setup now asks about push authorization for every workflow that can push,
  honors the repository's changelog distribution when selecting a provider,
  summarizes every missed guidance version, and uses synchronized guidance for
  retained cleanup and current defaults.
- Installed update prompts now explain practical new abilities first and
  recommend reviewing what changed. Repository auto-push setup now writes its
  digest-bound trust receipt after confirmation and requires noninteractive
  callers to acknowledge the exact one-repository push scope and its complete
  non-authorities.
- Ship can render every currently knowable unresolved permission together as a
  deterministic exact-target checklist with stable IDs and one-reply
  instructions for approving all, approving named IDs, or declining. Every
  supported operation has a closed authority mapping; the checklist grants
  nothing by itself, covers no future actions, and cannot bypass harness
  enforcement.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-13T17:03:01-05:00" -->

## 0.12.1 - 2026-08-13

- Ship setup now supports harness-aware Git push authorization.
  `gitPushAuthorization` defaults to `ask`; users can instead configure a narrow
  repository-scoped harness rule or prevent pushes entirely.
- Clean, target-contained worktrees can now remain in place as exact unchanged
  shipment exclusions. Any later change pauses integration until the worktree
  is claimed by its owner or paused at a stable boundary.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-13T12:26:50-05:00" -->

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
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T14:53:08-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T19:46:10-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T20:35:29-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T20:51:48-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T21:00:27-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T21:10:13-05:00" -->

## 0.11.4 - 2026-08-12

- Terminal completion now refuses to close until the primary checkout is clean
  and restored to the refreshed local target and all clean merged branches and
  worktrees are removed. Dirty non-primary worktrees, branches with unique
  commits, and actively claimed concurrent work remain preserved.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T13:36:26-05:00" -->

## 0.11.3 - 2026-08-12

- Break-glass runtime guidance now identifies the deploy-first revision as the
  exact candidate, without implying that focused checks ran before deployment.
  Delivery behavior is unchanged.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T12:54:03-05:00" -->

## 0.11.2 - 2026-08-12

- Internal-only, developer-only, preview, staging, and developer-experience
  changes no longer prompt for an unused public version.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T10:57:28-05:00" -->

- Explicitly authorized break-glass delivery now uses known native provider
  rollback capability to deploy immediately without a blocking current-
  production lookup, then verifies health, runs focused checks, and completes
  review, reconciliation, and canonical verification.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T10:59:18-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T11:01:37-05:00" -->

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
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T00:06:06-05:00" -->

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
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-11T15:17:59-05:00" -->

- Changelog capability negotiation now accepts compatible producer capability
  supersets while selecting only features shared with Simple Changes.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-11T16:08:07-05:00" -->

- Emergency Ship now persists and resumes its exact delivery ledger under the
  active loop, and refuses loop completion while emergency delivery remains
  incomplete.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-11T17:11:06-05:00" -->

## 0.10.1 - 2026-08-10

- `loop status` is now genuinely read-only. It reports the effective active
  lease and newly eligible concurrent authors without acquiring the
  active-loop lock or writing Simple Changes Git metadata, so inspection still
  works when that state is readable but not writable.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-10T19:11:21-05:00" -->

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
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-10T18:28:40-05:00" -->

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
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-09T00:42:26-05:00" -->

## 0.8.2 - 2026-08-07

- Runtime sources now pass current Biome and Ultracite checks across consuming
  repositories without stale or version-sensitive suppression diagnostics.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-07T21:05:24-05:00" -->

## 0.8.1 - 2026-08-07

- Worktrees on the integration target branch can no longer become concurrent
  authors. Claimed worktrees that arrive after a loop starts are now durably
  bound to their exact claim and owner at first guarded observation, so later
  claim release or reassignment blocks integration instead of inheriting the
  replacement claim. Concurrent authors may keep making ordinary local edits
  and commits, but cannot use the guarded integration executor even when they
  know the active run ID.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-07T19:42:35-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-07T19:53:09-05:00" -->

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
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-08-07T18:58:51-05:00" -->

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
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-08-07T17:44:36-05:00" -->

## 0.6.1 - 2026-08-06

- Opening worktrees that are proven clean, contain no commits beyond the
  pinned target, and receive explicit user approval can now be recorded as
  obsolete and removed without invalidating the active-loop manifest. The
  disposition is bound to the worktree's exact path, branch, revision, and
  content; dirty, changed, uniquely committed, unapproved, or canonical primary
  worktrees remain protected. The CLI now reports the matching 0.6.1 package
  version.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-08-06T14:59:06-05:00" -->

## 0.6.0 - 2026-08-03

- Write-capable integration runs now hold one exclusive active-loop lease and
  keep local mutations, including asynchronous operations, guarded from
  preflight through post-verification. New authoring agents receive isolated,
  branch-bound worktrees through `prepare-agent`, with interrupted setup
  resuming only from the pinned clean state. Worktree approvals track actual
  staged, unstaged, and untracked content. Guarded commands stop and reject
  lingering same-group background work before lock release; if cleanup cannot
  be proven, the lock remains for explicit recovery.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-08-03T13:54:04-05:00" -->

- Added a guarded Sync mode for requests to update from the canonical remote
  target. It refreshes only the resolved target, safely updates clean local
  branches when possible, preserves unsafe checkout state, and never treats
  synchronization as permission to push, rewrite history, deploy, or change
  remote data.
- Authorized Ship runs now begin with a concise scope and delivery-path brief
  while work proceeds, then finish with exact delivery receipts, review-driven
  changes, re-verification, and preserved or blocked work.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-29T13:30:44-05:00" -->

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
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-28T09:15:09-05:00" -->

## 0.4.0 - 2026-07-27

- Web production deployments now require a complete product release: Simple
  Changes reconciles target-contained pending work into a dated, versioned
  release, deploys only the refreshed reconciled target, and reports the product
  version.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-27T22:12:07-05:00" -->

- Skill publishing now distinguishes preserved baseline state from active
  external work. Dirty or unrelated original checkouts and pre-existing
  worktrees, commits, or proposals stay untouched but do not block publication
  through an isolated remote-default worktree. Only activity observed after
  the baseline or a live claim on the exact target is treated as externally
  owned active work, and finished reports separately list published results,
  preserved baseline information, and genuinely outstanding targets.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-27T09:17:52-05:00" -->

- Skill publishing now preserves branches, worktrees, and merge or pull
  requests owned by another active agent, task, or person. Broad requests to
  ship, integrate, or prune do not transfer ownership: mutation requires an
  exact explicit handoff, ownership is rechecked immediately beforehand, and
  protected work is reported with the authority still needed.
- Consumer discovery now treats compatibility paths that resolve to one
  physical skill package as a single installation while continuing to flag
  distinct copies for reconciliation.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-27T02:48:43-05:00" -->

## 0.3.0 - 2026-07-27

- Onboarding now explains the consequence of every available option before a
  user chooses how far to take work, handle production and changelogs, request
  help, or save preferences.
- Ship and resumed Ship runs now refresh the canonical remote target after all
  merges and refuse to report completion when the live deployment revision
  differs from that target.
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-27T01:40:57-05:00" -->

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
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-24T15:47:44-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-25T03:51:17-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-25T11:15:46-05:00" -->

## 0.1.0 - 2026-07-23

<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-23T18:15:57-0500" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol" at="2026-07-23T18:24:58-0500" -->
<!-- simple-changelogs-signature agent="Codex" at="2026-07-23T18:21:26-05:00" -->

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
