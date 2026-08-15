# Simple Changes behavioral specification

## Triggers

- Explicit requests to sync with the canonical Git target, package, queue,
  integrate, merge, ship, reconcile, or preview repository changes.
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
- For public releases, negotiated changelog protocol evidence, phased
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

- Existing and concurrent work is preserved unless ownership and scope are
  proven.
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
- Local mutations hold the lease lock across fresh preflight inventory, one
  bounded argument-array command or awaited asynchronous callback, and
  post-mutation verification. Guarded child/process-group identity remains
  recorded while commands run. Background descendants are terminated and the
  command rejected before lease release, or the lock is retained when the
  process group cannot be stopped. Change digests include actual staged,
  unstaged, and untracked contents.
- New authoring agents receive an isolated, run-registered worktree before
  editing. Worktree creation is resumable only from a clean pinned branch and
  target revision; switching branches invalidates mutation authority. A stale
  lock is recoverable only after proof that every recorded local process died.
  Exact user overrides bind to one path, head, and content digest and become
  invalid after another change.
- Unchanged clean opening worktrees are automatic cleanup candidates only when
  unclaimed, unretained, and target-contained. Finalization serializes against
  coordination mutations, rechecks exact head and content evidence immediately
  before removal, and records the disposition only after successful removal.
  Changed opening work still requires an exact user-approved disposition; late
  worktrees and branches remain protected.
- A worktree owner can persist an opaque local claim. Under the default
  `allow-claimed` policy, its distinct non-primary branch may continue changing
  while integration proceeds; the controller must exclude it from packaging,
  merge, and cleanup. Branch switches, claim release, ownership changes, and
  target/primary collisions re-block integration. Under `strict`, an owner may
  acknowledge a pause only for its exact path, branch, HEAD, and content digest,
  and the controller adopts that state only as mutation-forbidden preserved
  work.
- Clean non-primary claimed worktrees may be detached only from an exact
  detach receipt, without force or branch deletion. Reattachment requires the
  absent recorded path and the same local branch at the same HEAD; an active
  loop blocks reattachment.
- GitLab Integrate, Ship, Reconcile, and resumed integration runs cannot finish
  without a target-bound remote-branch reconciliation receipt covering the
  union of complete initial and final provider inventories. The canonical
  target, protected branches, open-MR branches, concurrent movement, and
  ambiguous work are preserved. Merged source branches are deleted only at the
  exact recorded merged head; closed/unmerged and no-MR branches require a
  separate audit and exact obsolescence proof.
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
- Public-version preferences remain exclusively owned by Simple Changelogs.
  Version direction is distinct from a blocker, approvals are digest- and
  revision-bound, and final deployment requires the verified reconciliation
  lineage rather than a prepared-file receipt.

## Forbidden behaviors

- Treating implementation completion as production, migration, secret, DNS,
  store-release, or history-rewrite authority.
- Automatically handing off planning, diagnosis, blocked work, no-change work,
  or another agent's work.
- Starting a competing integration loop, mutating another owner's checkout,
  running controller/target integration mutations outside the atomic executor,
  or bypassing an active manifest with a blanket exception.
- Removing an opening worktree without its exact audited disposition, or using
  that disposition to force deletion, delete a branch, or remove the primary
  checkout.
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
- Applying any migration before review, applying to an unbound target, or
  treating an automatic tier as authority for a hard-excluded migration.
- Directly authoring changelogs, release notes, version fields, or release
  policy.
- Calling a Simple Changes update checkpoint a changelog backfill, presenting a
  changelog-history action when Simple Changelogs is absent, or performing that
  companion skill's settings/history review directly.
- Starting a shipment loop and then pausing it to explain or resolve a known,
  required Simple Changelogs update.
