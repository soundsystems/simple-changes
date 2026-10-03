# Simple Changes behavioral specification

## Triggers

- Explicit requests to sync with the canonical Git target, package, queue,
  sweep, integrate, merge, ship, reconcile, pause, or preview repository
  changes.
- A managed completed-work pointer after attributable implementation and
  proportionate verification.
- A user signal that completed implementation is ready to put up, merge, ship,
  finish, or reconcile.
- Urgent shipping language in an established change-integration context,
  including an explicit request to deploy before independent review.

## Non-triggers

- Read-only review, explanation, planning, or diagnosis.
- Blocked or incomplete implementation, failing required checks, or work that
  changed no repository files.
- Commit-message-only, changelog-only, or release-note-only requests.
- UI generation without a request to package or integrate the resulting work.
- Completion of a Simple Changes run or work owned by another active agent.

## Inputs

- The current user request and authority.
- Repository and directory-scoped instructions.
- Repository policy, then personal preferences, then safe defaults.
- Fresh Git, provider, deployment, changelog, and verification evidence.
- For Sync, the exact canonical remote target, original local HEAD, status, and
  ahead/behind/ancestry evidence.
- For completed-work handoff, the closed initialization status and attributable
  implementation scope.
- For saved preferences, the stored Simple Changes guidance version and
  disposition plus the selected Simple Changelogs provider and its installed
  and repository-recorded guidance versions.
- When multiple UI iterations will be saved, the repository convention or
  closed fallback artifact-naming preference.
- When multiple independent proposals will be authored, the saved
  `proposalScheduling` preference (`balanced`, `consecutive`, or `parallel`).

## Outputs

- A validated initialization status before mutation.
- For meaningful installed updates, a clear one-time Simple Changes notice and,
  when proven, a separately owned Simple Changelogs update notice.
- A focused plan and explicit outstanding-work ledger.
- Verified proposals, merges, deployments, or preserved work within the
  authorized finish boundary.
- For Sync, the fetched target and resulting or preserved local branch state.
- For Ship, a pre-mutation scope brief and a final shipped-state receipt with
  review-driven deltas.
- For public releases, negotiated changelog protocol evidence (shared
  request/receipt versions plus advisory `schemaDigestStatus`), phased
  classification/preparation/verification receipts, and a composite delivery
  receipt binding version identity to the deployed revision.
- For Emergency Ship, a run-only urgency classification, revision-bound
  incomplete-state ledger, known rollback capability for break-glass, and a
  conditional final deployment decision based on canonical revision or proven
  immutable artifact equivalence.
- For migrations, a completed technical review, exact target identity, the
  effective automation tier, and post-apply verification evidence.
- Exact receipts for policy and managed instruction-pointer writes.

## Guarantees

- Finalization closes an exact verified shipment independently of unrelated
  cleanup. Scoped source checkouts must be clean and contained in the current
  target, or have completed audited removals. Only an unchanged primary whose
  dirty paths were explicitly preserved or delivered as reviewed results now in
  the target, and unrelated late arrivals, may remain without holding the
  shipment open. A reviewed result for work packaged from the primary is accepted
  only while that primary matches its baseline and its HEAD is contained in the
  bound target. Ordinary mutation verification is unchanged.
  Finalization persists a receipt reporting shipment, controller, delivery,
  cleanup, blockers, and preserved worktrees before closing the run. If an
  unexpected error prevents finalization after ownership and lock checks, it
  relinquishes the latest writable lease with the failure reason and preserves
  the incomplete run; an untouched Ship run stays active instead, so its
  unrecorded scope is never frozen. An unwritable lease is reported beside the
  original error as an explicit blocker. A relinquished
  controller is resumed without takeover approval; frozen scope still applies.
  `loop finalize --awaiting-user` pauses a run for a user decision: it
  relinquishes even when nothing else blocks closure, records the questions
  beside the lease and in the receipt, exits zero, and hands them to the
  resuming controller. An untouched Ship run still closes instead.
- A controller records the harness session that started, resumed, or last
  commanded it, when the harness exports one. That binding and any paused
  questions live in a file beside the lease, never in it, so runtimes that
  validate the lease strictly can still read leases written by newer ones. A
  user-installed Stop hook (`loop turn-check
  --hook`) blocks a turn from ending once while that session still controls an
  active run, then warns instead so it can never trap a session; it reads each
  lease again and never grants or removes authority. A live run that a still
  running background subagent of the same session drives only advises.
  Guard, exec, and verify
  output repeat the finalize step. Initialization reports whether the hook is
  installed and never installs it.
- When the running runtime lives inside a checkout of the repository it
  operates on and the target branch carries a newer version of the same file,
  initialization, `loop start`, and `loop status` report it as
  `behind-target`.
- A first shipment scope (`loop record-scope`) requires a non-mutating preview
  plan generated from the exact current inventory, with no open questions and
  every changed path accounted for once; the controller's own checkout; the
  pinned target revision; unchanged policy, discovered capabilities, remote
  bindings, and target binding since loop start; passing manifest
  verification; and the controller checkout and every unit source worktree at
  their exact loop-start branch, head, and content digest. Other changes after
  loop start, including claimed authors' edits and commits, other branches, and
  stashes, do not block it. A lease that predates these recorded invariants
  still requires the exact unchanged opening inventory.
- A Ship run that owed a shipment scope (`shipmentScopeRequired`), never
  recorded it, and changed nothing, with a controller that is still active and
  was never handed off, may close without it: `loop end` and finalization both
  close it, whether or not the repository moved, writing an immutable
  `abort-unmutated.json` receipt and removing only the lease. Any recorded
  mutation evidence, or any violation other than a changed unclaimed opening
  checkout or a lapsed concurrent claim, keeps every ordinary completion gate.
- Existing and concurrent work is preserved unless ownership and scope are
  proven. A preserved worktree that its owner removed mid-run can be retired
  only with named approval and proof that it is absent from disk and from the
  worktree list; retirement deletes nothing and proves no delivery.
- Write-capable integration modes hold one atomic integration-controller lease
  with an opening worktree manifest. A second controller, unclaimed worktree,
  target/primary collision, lost claim, branch switch, or changed preserved
  worktree blocks integration. By default, distinct actively claimed
  non-primary, non-target-branch worktrees remain concurrent-author worktrees
  and may keep changing without pausing. The first guarded observation binds a
  late author's exact claim ID and owner into the lease, promoting an opening
  `preserved` registration when its owner claims it after loop start, so
  reassignment fails closed. This ordinary transition requires neither user
  approval nor an exact override. Concurrent authors may not use the guarded
  integration executor; only the controller and its run-prepared authors may do
  so.
- Run-prepared and independently claimed authors perform ordinary worktree-local
  edits, generation, formatting, checks, staging, and commits concurrently on
  their distinct registered branches. Shared integration mutations (not normal
  authoring) hold the lease lock across fresh preflight inventory, one bounded
  argument-array command or awaited asynchronous callback, and
  post-mutation verification. Guarded child/process-group identity remains
  recorded while commands run. Background descendants are terminated and the
  command rejected before lease release, or the lock is retained when the
  process group cannot be stopped. Change digests include actual staged,
  unstaged, and untracked contents.
- Lock-busy evidence and local permission failure are distinct. Only an
  existing lock with valid ownership evidence justifies waiting or recovery;
  `EPERM`, `EACCES`, `EROFS`, or another denied state write is a harness or
  filesystem authorization problem and never justifies pausing authors,
  exporting patches, cleaning worktrees, or demanding a lease-null handback.
- New authoring agents receive an isolated, run-registered worktree before
  editing. Worktree creation is resumable only from a clean pinned branch and
  target revision; switching branches invalidates mutation authority. A stale
  lock is recoverable only after proof that every recorded local process died.
  Exact user overrides bind to one path, head, and content digest and become
  invalid after another change.
- Unchanged clean opening worktrees are automatic cleanup candidates only when
  unclaimed, unretained, and target-contained. Finalization serializes against
  coordination mutations, rechecks exact head and content evidence immediately
  before removal, records exact intent first, and marks it completed only after
  successful removal. Run-created removals receive the same terminal audit
  state.
  Changed opening work still requires an exact user-approved disposition; late
  worktrees and branches remain protected.
- A worktree owner can persist an opaque local claim. Under the default
  `allow-claimed` policy, its distinct non-primary branch may continue changing
  while integration proceeds; the controller must exclude it from packaging,
  merge, and cleanup. Branch switches, claim release, ownership changes, and
  target/primary collisions re-block integration. Under `strict`, an owner may
  acknowledge a pause only for its exact path, branch, HEAD, and content digest,
  and the controller adopts that state only as mutation-forbidden preserved
  work. A claim is released by its owner, by a proceeding completed-work
  handoff for that checkout, or by finalization evidence: the controller's own
  active claim on a clean checkout whose exact head the target contains, or
  any live non-detached claim whose worktree directory no longer exists. Every
  release records its reason; no claim is released by elapsed time or by
  guessing its owner.
- Ready-work receipts and shipment holds let agents in different harnesses
  coordinate a shipment through the shared coordination directory without
  messaging each other. Only a claim's owner
  records a ready-work receipt, and only for its clean, attached, committed
  checkout; the runtime binds the claim, owner, branch, exact head, and content
  digest, and releases the claim as a completed-work handoff carrying that
  exact evidence so an active loop keeps integrating. A receipt reads `stale`
  once its branch or checkout moves and `shipped` once the target contains it,
  and it grants no merge, deploy, migration, or cleanup authority.
- Shipment holds are local records beside the claims, optionally published as
  `refs/simple-changes/holds/<id>` for other clones. A `ship` hold covers
  merges, deployments, and migrations; `deploy` and `migrations` holds cover
  their own step. A hold ends only by its owner, by a user-approved release, or
  by `--until-merged` containment evidence, never by elapsed time.
  `loop verify --for`, `hold check --for`, and `migration apply` fail closed on
  an active covering hold or on published holds they cannot read. A waiver
  binds one run and the hold's exact content digest, is recorded only by that
  run's active controller with user approval, applies only while that
  controller holds control, and a halt additionally requires an explicit
  override, as does another agent's release of a halt.
- Clean non-primary claimed worktrees may be detached only from an exact
  detach receipt, without force or branch deletion. Reattachment requires the
  absent recorded path and the same local branch at the same HEAD; an active
  loop blocks reattachment.
- GitLab Integrate, Ship, Reconcile, and resumed integration runs cannot finish
  without a target-bound remote-branch reconciliation receipt covering the
  union of complete initial and final provider inventories. The canonical
  target, protected branches, open-MR branches, concurrent movement, and
  ambiguous work are preserved. Merged source branches are deleted only at the
  exact recorded merged head, or with Git-verified merged-head ancestry when
  the same MR was open at the opening head and merged at a descendant.
  Closed/unmerged and no-MR branches require a separate audit and Git or
  provider obsolescence proof; `target-contains-head` is verified with Git
  (exact ancestry or full per-commit patch equivalence, whose patch IDs ignore
  whitespace) when the receipt is recorded. Such a branch deleted while the
  target contains neither its head nor patch-equivalent commits, and without
  provider evidence of an empty diff, may close only with an explicitly
  user-approved supersession naming the deleted head, a reason, and replacement
  target commits; Git verifies it, the deleted head is pinned under
  `refs/simple-changes/superseded/`, and the approval lives in a sidecar beside
  the lease, never in it.
- GitLab loops persist a complete unchanged opening provider inventory at lease
  creation and reject integration mutations when legacy state lacks it. A
  distinct explicitly approved post-cleanup recovery may close only a clean,
  current, mutation-free legacy ledger from two matching final inventories and
  matching zero-active-claim digests. It holds coordination through closure,
  archives the evidence, and never claims those snapshots were opening history.
- Harness automation is capability-gated. An unsupported discovery, delivery,
  wait, scope, or owner-reference requirement produces a structured manual
  blocker and no repository mutation. Vendor APIs and credentials never enter
  the upstream runtime or durable coordination metadata.
- Missing onboarding defaults to checked proposal creation and confirmation
  before completed-work handoff.
- A meaningful guidance-version change blocks the next write-capable mutation
  until the user reviews, accepts, or defers it. The recorded disposition
  suppresses repeat prompting for that version without granting changelog
  authority.
- A required changelog update blocks loop creation until Simple Changelogs owns
  and records the user's disposition. The shipment loop, lease, and pre-ship
  brief begin only afterward.
- Instruction setup updates only an existing exact file after confirmation,
  rejects symlinks and malformed managed blocks, and never creates a missing
  instruction file.
- Completed-work handoff cannot mutate while readiness confirmation is pending.
- When another task owns the active shipment, completed verified work remains
  preserved until the user chooses either an approved ready-work handoff to
  that exact task or a separate shipment after the active one closes. The
  handoff request grants no additional shipping authority.
- UI artifact naming never overrides an established repository convention and
  never controls source, Git, deployment, package, or release versions.
- Sync never pushes, guesses an ambiguous remote, stashes dirty work, rewrites
  shared history, or leaves the checkout conflicted.
- Authorized Ship runs communicate scope before mutation without adding a
  redundant permission gate, then account for review-driven revisions.
- User-facing messages default to plain language: state what happened, what it
  means, and what happens next before internal workflow terminology. Exact
  technical evidence remains available when it affects safety, authority,
  verification, or a requested detailed explanation.
- Urgency alone selects only expedited shipping. Active user impact or a tested
  production-ready claim may recommend break-glass. Explicit current-request
  direction or saved break-glass policy authorizes the ordering. When saved
  automatic production authority is also effective, “Ship” is sufficient and
  no redundant authorization prompt is added. Break-glass still requires known
  rollback capability; checks, review, canonical Git and release
  reconciliation, final live verification, and cleanup run immediately and
  remain required for completion.
- Every migration is technically reviewed before apply. Target-bound automatic
  tiers may authorize reviewed routine or broader eligible work, but never
  destructive, irreversible, unbounded, lock-heavy, unprotected, or
  target-mismatched operations. Other high-risk actions retain independent
  authority checks.
- Automatic local-branch cleanup keeps its eligibility gates but proves
  containment by exact ancestry or by full per-commit patch equivalence, so
  squash- and rebase-merged branches stop accumulating; any unmatched commit
  preserves the branch. Adopting one pause-receipted straggler is never
  blocked by a sibling worktree that also holds a valid current pause receipt,
  and an adopted clean worktree with no unique work can be disposed through
  the same audited disposition as opening work; raw worktree removal is never
  the sanctioned path for lease-registered state.
- Inherited broken state has explicit audited recovery paths instead of
  dead ends: `worktree takeover` reassigns or releases a stale claim only with
  a named approver, reason, and exact current status digest, and never mutates
  the worktree; `worktree equivalence` produces read-only patch-id and byte
  containment evidence and never asserts semantic equivalence; and
  `loop close-equivalent` closes a relinquished, frozen-scope, or legacy
  close-only loop only when every obligated worktree is proven contained in
  the refreshed target, records a terminal `target-equivalent` outcome that is
  never reported as shipped, performs only proven-safe local cleanup, and
  requires final verification plus any GitLab branch/proposal reconciliation
  bound to the current target. For providers without that GitLab gate, it
  records that the reconciliation was not applicable. Frozen shipment scope
  blocks new authoring, not the target-equivalent close.
- A lease records a heartbeat: every operation that already writes lease state
  refreshes `updatedAt` and the owner process identity. A lease is `live` while
  its recorded owner process is provably running or its heartbeat is recent,
  `stale` when the harness session process bound to the controller has
  provably exited on this host and the heartbeat is older than a ten-minute
  grace period, or when the owner cannot be proven alive and the heartbeat is
  older than the published two-hour threshold, and `unknown`
  when its timestamp cannot be read. A running session process alone never
  keeps an idle run live. `loop status` reports that state directly. `loop
  recover --stale-lease` clears a stale lease with a named approver and reason,
  refuses a live one, archives the complete cleared lease beside its receipt
  in the run history, and preserves every
  worktree, branch, claim, and durable receipt; it clears the bookkeeping
  record only, never user work.
- A stale opening manifest is recoverable without abandoning the run:
  `loop rebaseline` lets the active or resumed controller register every
  worktree that appeared after loop start as preserved at its exact current
  state, with a named approver and reason recorded on the lease. Registered
  late arrivals stay owner-controlled and untouched, still fail verification
  if they change afterward, and never become shipment obligations of a later
  target-equivalent close. `loop status` names the exact next recoverable
  command for the state it observes. When no loop record exists at all,
  `worktree cleanup` performs one audited, user-approved standalone pass that
  removes only unclaimed clean worktrees proven contained in the refreshed
  target (by exact ancestry or full per-commit patch equivalence) plus stale
  metadata, preserves everything else with the exact next command, and
  records an append-only receipt; it is refused while any loop record exists.
  `prune` runs that same proven-safe pass with no lease of its own, so an
  agent that merged its work and stopped without finalizing still leaves no
  residue: it removes unclaimed clean target-contained checkouts, stale
  metadata, and local branches whose unique commits the refreshed target
  contains by ancestry or full per-commit patch equivalence, naming the
  containment method for each. It requires an approver and a reason, supports
  `--dry-run`, always reports the exact plan before applying it, and refuses to
  touch any path or branch an open lease registers, including pending authors,
  opening branches, and stale or relinquished runs. An old heartbeat or
  released claim does not reduce protection. Registered cleanup belongs to
  the controller's exact disposition and guarded removal, or a later pass
  after closure. It never edits lease state, claims, or recorded receipts.
  Standalone cleanup, prune, and metadata refresh acquire the short integration
  lock before the coordination lock and re-read inventory under both locks.
  `worktree refresh-index` prunes only missing-directory metadata so cached
  editor and desktop surfaces re-sync from the authoritative Git inventory,
  deferring global metadata pruning when any missing registration belongs to
  an open loop; prune applies the same deferral. Unexplained worktree deletion
  still fails verification; a clean opening HEAD is not proof of safe removal.
  Equivalence reports may carry advisory residue hints that never change
  the classification. Claim protection under `worktree takeover` follows the
  controller lifecycle: an active loop protects every registered path, while
  a relinquished loop protects only adopted claim-and-pause linkages, so a
  dead run's own registrations cannot freeze stale-claim recovery.
- `proposalScheduling` controls only whether independent proposals are
  authored consecutively or in parallel claimed worktrees. It never shares a
  checkout, weakens controller guards or worktree isolation, changes cleanup
  safety, or grants provider mutation authority.
- Parallel agents author only inside worktrees the controller prepared with
  `prepare-agent` under a distinct agent ID that is never the controller's
  own; a host-created checkout is an unregistered worktree that blocks guarded
  operations. Delegated agents never run loop commands, push, call providers,
  merge, release, deploy, or clean up, and the controller confirms each
  reported commit against the registered branch before integrating it
  serially. Pinned read-only work (independent review and check reproduction
  in the registered worktree) may run in parallel against one exact head; no
  agent reviews its own unit, and inventory snapshots are never split across
  agents.
- Changelog compatibility is decided by request/receipt version overlap plus
  local schema validation at use time; advertised schema digests are recorded
  as advisory `schemaDigestStatus` and never block a version-compatible peer.
  Provider identity prefers the machine-readable `changelog-provider.json`
  marker; marker-less discovery is reported as `providerEvidence: "inferred"`,
  never presented as a declaration.
- Public-version preferences remain exclusively owned by Simple Changelogs.
  Version direction is distinct from a blocker, approvals are digest- and
  revision-bound, and final deployment requires the verified reconciliation
  lineage rather than a prepared-file receipt.
- `proposalSignatures` defaults to `agent-and-version`: each agent that
  authors, reviews, or merges a proposal appends its model name and version to
  the proposal's signature block. A signature is attribution only; it never
  approves, satisfies independent review, or authorizes a merge, and `none`
  suppresses new signatures without removing existing ones.
- Work that can affect separately released installed clients records exactly
  one installed-client compatibility result (`compatible`,
  `release-recommended`, `incompatible`, or `unverified`) with evidence.
  `incompatible` or `unverified` blocks the affected migration, API, backend,
  or production deployment; a new client release alone never makes a breaking
  rollout safe, because older binaries remain installed until an enforced
  support boundary exists.

## Forbidden behaviors

- Treating implementation completion as production, migration, secret, DNS,
  store-release, or history-rewrite authority.
- Automatically handing off planning, diagnosis, blocked work, no-change work,
  or another agent's work.
- Releasing or waiving another agent's shipment hold without user approval,
  or treating an unreadable published hold as absent.
- Starting a competing integration loop, mutating another owner's checkout,
  running controller/target integration mutations outside the atomic executor,
  or bypassing an active manifest with a blanket exception.
- Removing an opening worktree without its exact audited disposition, or using
  that disposition to force deletion, delete a branch, or remove the primary
  checkout.
- Reporting a `target-equivalent` close as a shipment, taking over a claim or
  closing a loop as equivalent without a named approver and fresh evidence,
  treating patch/byte equivalence output as semantic proof, or deleting
  external session/task history to make a worktree list look clean.
- Manufacturing a pause receipt, adopting a stale receipt, guessing an owner
  from a session title, treating eval-adapter support as live-session API
  support, detaching dirty work, or concurrently resuming a live harness
  session.
- Creating an instruction file, guessing a global instruction path, or
  duplicating the managed pointer.
- Treating a generic Sync request as push, reset, rebase, proposal, deployment,
  or data-write authority.
- Reporting the original Ship plan as delivered without reconciling review
  changes and final provider evidence.
- Leading routine user updates with controller, lease, ledger, digest, or other
  internal bookkeeping when a short plain-language explanation would preserve
  the same accuracy.
- Treating emotional urgency, active impact, or a tested claim as implicit
  authority to deploy before review; treating break-glass policy without
  production authority as deploy permission; or marking `live-unreviewed` or
  `live-unreconciled` work complete.
- Passing `release-gate` a flag its documented source does not support
  (effective policy, a matching user decision, or fresh provider evidence),
  treating its printed decision as authority, or routing on its exit code
  instead of its `action`.
- Applying any migration before review, applying to an unbound target, or
  treating an automatic tier as authority for a hard-excluded migration.
- Directly authoring changelogs, release notes, version fields, or release
  policy.
- Calling a Simple Changes update checkpoint a changelog backfill, presenting a
  changelog-history action when Simple Changelogs is absent, or performing that
  companion skill's settings/history review directly.
- Starting a shipment loop and then pausing it to explain or resolve a known,
  required Simple Changelogs update.
