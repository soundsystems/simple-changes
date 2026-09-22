# Changelog

## 0.18.0 - 2026-09-22

- Account for a preserved worktree that its owning task deleted mid-run with the
  new `loop retire-absent-worktree` command. On named approval, and only when
  the path is gone from both the filesystem and Git's worktree list, it records
  the absence so the run can continue instead of being blocked by a
  missing-worktree violation or forced to recreate the deleted checkout. It
  deletes nothing, proves no delivery, and never authorizes branch cleanup.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-09-22T16:17:07-05:00" -->

## 0.17.1 - 2026-09-16

- Shipments whose work was packaged from a dirty primary checkout and then
  changed by review can now record their outcome and close. Delivery is proven
  when that checkout is unchanged from its baseline, its head is contained in
  the target, and every remaining changed path was delivered, preserved, or
  excluded; the checkout's bytes stay in place instead of blocking closure.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-09-16T19:29:27-05:00" -->

## 0.17.0 - 2026-09-11

- Check old branches for work already shipped through a rebased or squashed
  replacement with the new read-only `branch audit` command. It reports
  candidates for independent review before reapplying work, and guidance now
  preserves original commit lineage when preparing replacements. Candidate
  matches do not authorize cleanup.
<!-- simple-changelogs-signature agent="gpt-6-astra" at="2026-09-11T14:09:32-05:00" -->

## 0.16.2 - 2026-09-09

- Finished shipments can now close while unchanged local work explicitly excluded from the shipment stays safely in place.
<!-- simple-changelogs-signature agent="Astra medium" at="2026-09-09T17:57:46+00:00" -->

## 0.16.1 - 2026-09-08

- Cleanup preserves missing-worktree records until every record affected by pruning is freshly checked. It recognizes its own verified primary-checkout synchronization and keeps failed closure attempts retryable without recording completion.
<!-- simple-changelogs-signature agent="GPT-6 Astra medium" at="2026-09-08T18:04:48+00:00" -->

## 0.16.0 - 2026-09-08

- Fork synchronization now flags fork-owned command lists that may hide newly
  added upstream commands. Review identifies the missing commands so maintainers
  can expose them or confirm that the omission is intentional.
- Target discovery now respects the remote configured for the repository's
  integration branch when the working branch has no remote of its own,
  preventing an `origin` mirror from taking precedence.
<!-- simple-changelogs-signature agent="gpt-6-astra medium" at="2026-09-07T12:49:08-05:00" -->

- Recover a frozen shipment whose scope no longer covers the work to integrate.
  With the current owner's explicit user approval and exact inventory evidence,
  `loop replan` archives the old run so a fresh shipment can be planned. It keeps
  every file, commit, worktree, claim, and prior receipt in place.
- Finish a reviewed clean-branch integration after its exact target changes are
  reconciled, while preserving unrelated local work and other authors' claims.
<!-- simple-changelogs-signature agent="gpt-6-astra medium" at="2026-09-08T08:53:51-05:00" -->

## 0.15.2 - 2026-09-04

- Standalone cleanup now preserves every checkout and branch registered by an
  open shipment, even when its heartbeat is stale. Cleanup also waits for shared
  integration operations, preventing concurrent work from losing its registration.
<!-- simple-changelogs-signature agent="gpt-6-astra medium" at="2026-09-04T20:23:24-05:00" -->

## 0.15.1 - 2026-09-04

- Fork synchronization now recognizes an already-current provenance pin and
  verifies the reviewed plan before reporting success.
- Verified shipments can now close while unrelated local work remains preserved,
  without requiring that work to be merged or discarded.
<!-- simple-changelogs-signature agent="Astra medium" at="2026-09-04T23:38:58+00:00" -->

## 0.15.0 - 2026-09-04

- Local cleanup no longer depends on a shipment run reaching finalization. The
  new `prune` command runs the same proven-safe pass finalization already ran,
  without holding a controller lease, so an agent that merged its work and then
  stopped no longer leaves merged worktrees and branches piling up:
  - It removes unchanged clean checkouts the refreshed target already contains,
    worktree records whose directory is gone, and eligible local branches.
    Containment is proven by exact ancestry or by matching every commit's
    patch, and each removal records which proof was used.
  - The complete plan is always reported before anything is removed, and
    `--dry-run` reports that plan and changes nothing.
  - Dirty, claimed, preserved, and retained work is never touched, and anything
    registered by a lease that is not provably stale is left alone.
- An abandoned shipment lease no longer blocks every other agent in the
  repository. Leases now record a heartbeat, `loop status` reports whether a
  lease is live, stale, or unknown, and `loop recover --stale-lease` clears a
  stale lease with your explicit approval, records a recovery receipt, and
  preserves every worktree, branch, claim, and durable record. It clears the
  bookkeeping record only, never your work. A lease counts as stale only when
  its owner cannot be proven alive and its last heartbeat is more than four
  hours old; a lease whose state cannot be proven is never treated as stale.
  Recording a heartbeat never affects `loop takeover`, which still compares the
  same safety-relevant manifest and still refuses when it genuinely changed.
<!-- simple-changelogs-signature agent="claude-opus-5 medium" at="2026-09-04T10:05:00-05:00" -->

## 0.14.0 - 2026-09-02

- Repository-specific Simple Changes forks can now be updated from the global
  installation with the new `update-local-forks` skill. It plans each fork
  against its provenance pin, preserves local behavior, and reports conflicts
  or omitted references for review without committing or pushing.
- CMS-only changelog handoffs now advance relevant operator-history changes
  from classification to preparation without requesting a public version or
  production approval. Shipped coordination guidance documents the complete
  handoff.
- The CLI now reports the installed `0.14.0` package version correctly.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-09-02T16:07:42-05:00" -->

## 0.13.0 - 2026-09-02

- Change proposals can now carry clear agent-and-model attribution for authored,
  reviewed, and merged work. Attribution documents the action but never replaces
  review or merge approval.
- Production release delivery now combines verified changelog and deployment
  evidence, so an incomplete or blocked release cannot be presented as fully
  delivered.
- Worktree claims now release through owner action, completed-work handoff, or
  finalization evidence, preventing finished work from needlessly blocking an
  active shipment.
- Setup now recognizes CMS-only changelog work and offers the compatible Simple
  Changelogs setup when it is needed. Non-interactive runs must opt into that
  installation explicitly.
- Production migrations now check installed-client compatibility before they can
  proceed.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-09-02T18:08:00-05:00" -->

## 0.12.19 - 2026-08-26

- Release checks now use the repository's pinned formatting tools, keeping
  verification reproducible across installations.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-26T18:27:18-05:00" -->

## 0.12.18 - 2026-08-26

- Standalone cleanup now preserves local worktrees for target branches
  referenced through remotes and stops safely if cleanup conditions change.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-26T17:29:43-05:00" -->

## 0.12.17 - 2026-08-26

- Published Simple Changes forks now pass downstream lint checks without
  changing worktree-coordination behavior.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-26T16:48:35-05:00" -->

## 0.12.16 - 2026-08-26

- A busy repository no longer deadlocks a shipment run. When other agents
  create worktrees after a loop starts, the controller can now re-baseline the
  manifest with one exact user approval: `loop rebaseline` registers every
  late arrival as preserved at its exact current state, untouched and still
  owner-controlled, so the run can proceed or close instead of wedging between
  a stale manifest, owner pause receipts it cannot produce, and a
  reconciliation gate it cannot reach. Re-baselined worktrees never become
  shipment obligations.
- `loop status` now tells you what to do next. Alongside the verification
  report it names the exact next recoverable command for the state it found:
  re-baseline for late worktrees, an exact override for a changed preserved
  checkout, takeover or target-equivalent close for a relinquished run, and
  the normal scope, outcome, and finalize steps for a healthy one.
- Orphaned worktrees in a repository with no loop record can now be cleaned
  without reopening a shipment. `worktree cleanup` runs one audited,
  user-approved pass that removes only proven-safe checkouts (unclaimed,
  clean, and fully contained in the refreshed target by ancestry or complete
  patch equivalence) plus stale metadata for missing directories, preserves
  everything else with the exact next command, and records an append-only
  receipt.
- `worktree refresh-index` re-syncs cached editor and desktop worktree views
  from the authoritative Git inventory, pruning only metadata for directories
  that no longer exist and explaining, per coordination adapter, what
  refreshes and what is audit history that stays.
- A relinquished run no longer freezes stale-claim recovery on its own
  registered paths. `worktree takeover` now judges "a lease still requires
  this worktree" by controller lifecycle instead of bare path membership: an
  active loop still protects every registered path, but once a run
  relinquishes, only an adopted claim-and-pause linkage stays protected. This
  removes the self-inflicted deadlock where a run's own opening registrations
  blocked releasing claims whose owners no longer exist.
- `worktree equivalence` reports now include advisory residue hints for
  unmatched work: which paths an unmatched commit touched and whether their
  end state already matches the target, and whether a differing dirty file
  differs only in whitespace. Hints guide independent review; they never
  change the classification and are never proof.
<!-- simple-changelogs-signature agent="claude-fable-5" at="2026-08-26T16:10:00-05:00" -->

## 0.12.15 - 2026-08-26

- Finished work no longer piles up locally after a shipment:
  - Automatic branch cleanup keeps its existing eligibility rules but now
    proves containment by exact ancestry or by matching every unique commit's
    patch, so squash-merged and rebase-merged branches are deleted instead of
    accumulating. Each removal records how it was proven. A branch with any
    unmatched commit, or one too far ahead to audit cheaply, is preserved and
    named.
  - Several paused straggler worktrees can now be adopted one at a time in any
    order. A sibling worktree holding its own valid current pause receipt no
    longer counts as a blocking violation, so receipted stragglers stop
    deadlocking against each other.
  - `loop dispose-worktree` now also accepts a worktree adopted mid-run through
    `adopt-worktree` or `accept-paused-change`, under the same evidence bar,
    and treats a commit whose exact patch the target already contains as not
    unique. A squash-merged straggler can be removed through the audited path
    instead of a raw `git worktree remove`.
- Ship receipts now open by naming the shipped change in plain language, what
  is different now and for whom, before merge, check, and deployment evidence.
  That opening is required even when no changelog entry was written and no
  customer notes apply. Receipts also no longer carry internal cross-references
  that resolve nowhere or lists of evidence that was deliberately not relied
  on.
- A harness that forbids an agent from editing its own permission or allowlist
  file is now documented as correct behavior rather than a failure: Simple
  Changes gives you the exact file and lines to add yourself and continues the
  work that needs no new permission.
<!-- simple-changelogs-signature agent="claude-opus-5 medium" at="2026-08-26T10:35:00-05:00" -->

## 0.12.14 - 2026-08-25

- Inherited shipment state now has audited recovery paths:
  - `worktree takeover` can reassign or release a stale claim when its owner no
    longer exists. Approval remains bound to the checkout's current status, and
    a durable recoverable intent protects the audit trail without changing the
    worktree itself.
  - Read-only `worktree equivalence` issues a report only when the checkout's
    opening and final commit and status digest still match, then compares commit
    patches, worktree bytes, staged content, file modes, and Git links. Unique,
    changing, or unverifiable state remains blocking, while semantic equivalence
    remains a review decision.
  - `loop close-equivalent` can safely close relinquished, frozen-scope, and
    legacy close-only loops only after every obligated worktree is present and
    proven, verification and cleanup finish, and any required GitLab branch and
    proposal reconciliation is complete. It never reports that work as shipped
    and leaves claimed, preserved, and retained worktrees untouched.
  - Recovery failures now identify the exact next command, and the recovery
    close record is available through `simple-changes validate`. The recovery
    guide also explains how to refresh external worktree lists without deleting
    session or task history.
- Loop starts and stale-claim takeovers now share ordered coordination so a new
  loop cannot adopt a claim while its ownership is being reassigned or released.
- Installed update guidance now names `proposalScheduling` and explains that
  existing policies without the setting use the **Balanced** default.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-25T13:28:22-05:00" -->

## 0.12.13 - 2026-08-24

- Setup now lets you choose how multiple independent PRs or MRs are scheduled:
  **Balanced** works consecutively by default and parallelizes when it
  meaningfully saves time or isolation is necessary, **Save space** prefers
  consecutive work, and **Save time** prefers parallel claimed worktrees.
  Parallel work remains isolated, completed worktrees are cleaned up only after
  proven integration, and standalone clones cannot bypass active coordination
  or cleanup state.
- User-facing terminology now follows the detected forge: GitHub workflows say
  **PR**, GitLab workflows say **MR**, and provider-neutral **change proposal**
  wording is reserved for unknown or differently named forges.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-24T13:23:14-05:00" -->

## 0.12.12 - 2026-08-23

- Completed, verified work blocked only by another task’s active shipment now
  stays preserved while Simple Changes asks:
  > Do you want me to ask that agent to fold this work into the active shipment,
  > or should I wait until that shipment finishes and ship this separately
  > afterward?
- No agent is contacted before that explicit choice. An approved handoff carries
  an exact ready-work receipt without granting ownership, merge, deployment,
  migration, or cleanup authority; when the active owner is unknown, Simple
  Changes provides the receipt for manual delivery instead.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-23T12:33:09-05:00" -->

## 0.12.11 - 2026-08-23

- Shipment-loop boundaries are now explicit:
  - Starting `ship`, `integrate`, or another shipment mode no longer silently
    resumes a matching relinquished loop. Continuing that loop requires an
    explicit **Resume** action.
  - The first incomplete finalization freezes the shipment's author and
    worktree acquisition boundary. A resumed or taken-over controller can
    finish registered or preparing work and complete reconciliation, review,
    merge, deployment, cleanup, and closure, but later shipment work must begin
    in a fresh loop. Existing preservation guarantees remain unchanged.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-23T11:28:39-05:00" -->

## 0.12.10 - 2026-08-21

- Close-only recovery can now clear legacy bookkeeping for an already-absent
  temporary checkout that the run created and later reclassified as preserved,
  but only when its audited baseline is fully contained in the finalized
  target. Nonmatching, unverifiable, or unique work remains blocking.
  Recovery can also accept a clean primary checkout already at the exact
  finalized target branch and revision.
- Skill publishing now automatically finds per-user global installations under
  `~/.agents/skills`, `~/.codex/skills`, `~/.claude/skills`, and
  `~/.cursor/skills`, so normal publishes update them without a manual root.
  Symlinked aliases resolve to one physical installation.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-21T16:19:23-05:00" -->

## 0.12.9 - 2026-08-21

- Legacy cleanup can now close while unrelated active claimed work remains
  preserved, provided two ordered claim inventories match exactly. Any changed
  claim count or inventory still blocks the close-only recovery.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-21T16:00:15-05:00" -->

## 0.12.8 - 2026-08-21

- Multiple stale preserved-checkout handoffs can now be repaired sequentially
  without deadlocking each other. Each replacement still requires exact paused
  evidence for an unchanged checkout, and unique, unverified, or otherwise
  unsafe work remains blocking.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-21T15:37:07-05:00" -->

## 0.12.7 - 2026-08-21

- Ship responses for a finalized public release now end with a concise
  **Latest customer notes** recap: two to five deduplicated bullets drawn from
  that exact version's public release notes and grouped under customer-facing
  surface headings when useful. Each customer-note item renders as a Markdown
  blockquote beneath its surface heading, visually distinct from ordinary
  operational shipment bullets. The operational receipt and any blocker stay
  first, so a reconciled release may show its notes while deployment is blocked
  without implying that it is live. Preview-only, unfinished, internal-only,
  and `release:none` work omits the recap, and developer notes, signatures, and
  notes from newer versions never appear.
- Temporary shipment and deployment checkouts now enter the run as cleanup
  artifacts instead of retained work. If a previously retained clean checkout
  is already gone, finalization can clear its stale bookkeeping without another
  confirmation only when its last audited clean revision and current local
  branch both still exist, are fully included in the finalized target, and have
  no active claim. Missing branch evidence or unique work remains blocking.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-21T15:10:50-05:00" -->

## 0.12.6 - 2026-08-20

- Installed-update prompts now put any required multiple-choice answers first,
  before offering a walkthrough. The recommended answer and its practical
  consequence appear first, and optional recommended setting changes are shown
  near the top instead of being buried in a feature tour.
- When nothing needs a decision, Simple Changes says plainly that no new
  settings answers are required and recommends continuing with the current
  settings. The default walkthrough highlights at most three practical points;
  an expanded walkthrough and the full release notes remain available on
  request.
- Update notices now explicitly preserve existing settings, repository files,
  and current work. Reviewing or acknowledging an update does not broaden push,
  merge, release, deployment, migration, data, or other authority.
- Ship runs that open with local changes now record one complete, non-mutating
  shipment scope before guarded work or completion. It accounts for every
  changed path across every worktree; a preserved worktree is protected from
  deletion, but its finished work is not silently excluded from shipment.
  `record-scope` preserves the immutable opening source-tree identity for each
  worktree and path using Git path-aware clean/text-filter hashing with a `--`
  delimiter for regular files and raw literal target bytes for symlinks,
  avoiding false outcome rejection with `.gitattributes`, LFS-style filters,
  broken links, or leading-dash filenames. Agent preparation is blocked until
  the required scope exists, and exclusions can identify the worktree and path
  together when several worktrees contain the same filename.
- The generated pre-ship brief names every included work item, its outcome,
  branch or detached revision, and source worktree, with preserved and excluded
  work listed separately. User-facing review communication now lists every
  finding as its own bullet instead of replacing the findings with a count and,
  when applicable, deep-links each finding's primary local file and line.
- After review and integration, `loop record-outcome` binds every scoped unit to
  the exact final revision and accepts only its exact opening source result or a
  target-equivalent result. Review-driven source changes require a fresh scope;
  they are re-previewed to refresh their exact source identities within the
  original shipment path scope before further mutation, while the superseded
  scope receipt remains in lease history. Controller-authored receipt data cannot
  impersonate independent review.
- Each unit's final paths must exactly equal its scoped paths. Rename originals
  are mandatory, owned by their scoped unit, and can never be classified
  through `additionalPaths`. Only release-generated or external-target-change
  paths can be added, and each must be a real remaining opening-to-final target
  delta with its classification and reason; unchanged or non-delta extras are
  rejected. Completion rechecks the receipt and any moved target without
  another user approval step, while existing lease and disposition safety still
  governs cleanup.
- Guarded execution now rejects branch-changing `git switch` and `git checkout`
  for registered controller and author checkouts. Known global options such as
  `-C`, `-c`, `--git-dir`, `--work-tree`, and `--no-pager` remain parsed, while
  unrecognized global options fail closed so flags such as
  `--literal-pathspecs` cannot hide a branch switch. Path-only checkout
  restoration remains allowed. Plans that change a package manifest or
  lockfile—including nested monorepo manifests and locks—also require a frozen
  install and production build in an isolated clean checkout.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T17:35:51-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T18:10:46-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T18:19:51-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T18:31:54-05:00" -->

## 0.12.5 - 2026-08-15

- Every GitLab Queue, Sweep, Integrate, Ship, Reconcile, and Resume run now
  saves its complete opening branch and proposal inventory before any provider
  mutation. A legacy record without that evidence cannot prepare author
  worktrees and can close only through the explicit post-cleanup recovery path;
  ordinary reconciliation, ending, or finalization cannot bypass it.
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
- Before retiring an already absent paused or adopted worktree claim, recovery
  saves an immutable deterministic retirement plan. A crash after retirement
  safely reuses that exact plan, while linked or non-regular `intent.json` and
  `completed.json` audit files are rejected.
- Authors in separate prepared or claimed worktrees can keep editing,
  generating files, formatting, testing, staging, and committing at the same
  time. The short shared controller lock is only for integration work such as
  moving the target, integrating commits, pushing, opening or merging a
  proposal, deploying, managing worktrees or branches, and cleanup.
- A busy controller lock pauses only that shared integration step; it does not
  require other authors to stop, export patches, clean their worktrees, or hand
  back the whole run. `EPERM`, `EACCES`, and `EROFS` mean the harness or file
  system denied access, not that another agent owns the lock.
- When a compatible Simple Changelogs installation is available, onboarding
  recommends delegating changelog work to it. If the skill is relevant but not
  installed, Simple Changes explains what it does, asks before installing it,
  and—only after consent—asks whether to set it up now, after this shipment, or
  later. It never installs or configures the skill silently.
- Delaying setup preserves the changelog work already in progress. If the
  current shipment needs a release boundary now, Simple Changes explains that
  the user must either set up Simple Changelogs now or stop before release.
  Delegation, installation, and setup timing never grant version, release,
  publication, deployment, or data authority.
- Before the main setup questions, Simple Changes now detects existing private
  personal defaults and asks whether to use them unchanged for this run. Saying
  no simply continues onboarding. Save choices clearly distinguish repository
  team policy, a private global personal fallback, and run-only settings that
  write no policy file; choosing the global option warns when it will update or
  overwrite existing personal defaults.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T13:57:40-05:00" -->

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
