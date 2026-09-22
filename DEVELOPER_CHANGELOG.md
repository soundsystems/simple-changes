# Developer changelog

## Unreleased

- Move the `loop retire-absent-worktree` sentences in
  `references/inventory-and-concurrency.md` out of the middle of the
  `loop dispose-worktree` paragraph, which had made the disposition's
  digest-and-audit requirements read as if they applied to retirement. Prose
  only; no runtime, schema, or version change.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-09-22T16:57:57-05:00" -->

## 0.18.0 - 2026-09-22

- Add `retirements` to the loop lease and `retireAbsentWorktree`: bound to the
  exact registered baseline head and change digest, accepted only for a
  preserved registration the run did not create, refused for the primary
  checkout, a live checkout, a dangling symlink, or a path Git still lists as
  live; idempotent per registration; writes an immutable
  `worktree-retirement-<digest>.json` receipt in the run's recovery history.
- Verification skips a retired path only while nothing is at it and Git shows
  no live entry, so a recreated checkout is audited against the baseline again.
  Retirement creates no disposition, so delivery proof, absent-removal intents,
  and reconciled-branch deletion are unaffected. `loop status` names the
  command for `missing-preserved-worktree`.
- Canonicalize a deleted path through its nearest existing ancestor so spelling
  such as `/var` versus `/private/var` matches the lease. Cover rebaselined,
  stale-metadata, reappearance, and refusal cases. Keep guidance at 22.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-09-22T16:17:07-05:00" -->

## 0.17.1 - 2026-09-16

- Add the read-only `primaryDeliveryProof` predicate and share it between
  `loop record-outcome` (`primaryReviewedResultAllowed`) and finalization
  (`preservesUnchangedPrimary`, `hasVerifiedDelivery`). A delivered unit
  sourced from the primary may bind the reviewed target entry instead of its
  frozen opening entry only while the primary's branch and change digest match
  the baseline and its HEAD is contained in the bound target.
- Skip target-equivalent normalization when it would only partially clean a
  proven delivered mixed-source primary, preserving its bytes and index so the
  proof still holds at closure.
- Cover the predicate with unit cases and add an end-to-end finalization test
  that rejects rewritten history and a primary edited after scope opening
  before closing the reviewed shipment. Keep Simple Changes guidance at 22.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-09-16T19:29:27-05:00" -->

## 0.17.0 - 2026-09-11

- Add the `branch-audit` CLI and schema with resolved commit identities,
  target-reachable candidates from full `Original-Commit` trailers or matching
  subjects and shared paths, comparison arguments, and explicit truncation
  flags. Include advisory replacement evidence in worktree-equivalence reports
  with unmatched commits while retaining existing containment decisions.
- Cover replacement discovery, squash lineage, incomplete searches, target
  reachability, newer source work, and read-only CLI behavior. Add shipment and
  reconciliation evals requiring independent review without weakening cleanup
  authorization.
<!-- simple-changelogs-signature agent="gpt-6-astra" at="2026-09-11T14:09:32-05:00" -->

## 0.16.2 - 2026-09-09

- Accept explicitly excluded primary-checkout paths alongside preserved paths during finalization. Retain exact change-digest, head, branch, delivery, source, and target checks.
- Cover unchanged excluded work and unrelated claims, rejection of drift and missing removal evidence, and recovery after an audited run-created worktree removal while the primary remains behind the target.
- Keep Simple Changes guidance at 22: this compatible fix restores the existing preservation guarantee without new settings or authority.
<!-- simple-changelogs-signature agent="Astra medium" at="2026-09-09T17:57:46+00:00" -->

## 0.16.1 - 2026-09-08

- Defer global worktree pruning unless every affected registration passes a fresh containment and preservation audit. Record exact primary synchronization intent and recovery evidence so an interrupted finalizer can distinguish its own change from unrelated work.
- Persist removal dispositions for retry, but record terminal closure only after cleanup, verification, and archival succeed. Four regressions reproduce the original failures; this does not automatically repair every historical interrupted record.
<!-- simple-changelogs-signature agent="GPT-6 Astra medium" at="2026-09-08T18:04:48+00:00" -->

- Cut package 0.16.1 and align CLI and packaged public notes. Guidance remains 22 because these corrections restore existing cleanup and retry guarantees without new settings or authority.
<!-- simple-changelogs-signature agent="GPT-6 Astra medium" at="2026-09-08T19:53:19+00:00" -->

## 0.16.0 - 2026-09-08

- Compare upstream CLI commands at the fork's provenance pin with the installed
  source, using help text and dispatch cases. Promote fork-owned scripts and
  manifests from `keep-fork-only` to `review` when a concentrated command list
  omits an added command. Preserve the file for maintainer review; document
  heuristic limits and cover command additions, complete gates, and scattered
  mentions.
- Prefer the current branch's configured remote, then the local integration
  branch's remote, before `origin` and other remotes during target discovery.
  Add regression coverage for repositories that integrate through a remote
  other than their `origin` mirror.
- Advance the package, CLI, and packaged public history to 0.16.0. Simple Changes
  guidance remains 22: target selection repairs existing behavior, and command
  parity findings use the existing fork-review workflow without introducing
  settings or an onboarding decision.
<!-- simple-changelogs-signature agent="gpt-6-astra medium" at="2026-09-07T12:49:08-05:00" -->

- Add owner-bound `loop replan-status` and `loop replan` recovery for active or
  relinquished frozen runs. Bind approval to the manifest, current checkout
  inventory, worktree coordination, and resolved target under the shared state
  then coordination locks. Preserve stale claims and changed work for the next
  run to reconcile; do not claim that ordinary verification passed.
- Persist an immutable request-specific intent and atomically archive the exact
  original lease bytes. Exact retries preserve successor runs; changed evidence
  requires a fresh observation and approval in a separate immutable attempt.
  Replan performs no shipment, cleanup, claim transfer, or provider operation.
- Recognize nonempty reconciled additional target paths as verified delivery in
  finalization, alongside scoped units. Keep exact target and tree-entry checks,
  scoped-source containment, unchanged-primary preservation, and claim ownership
  checks. Empty outcomes do not qualify as delivery.
- Cover preservation, ownership and evidence drift, held locks, invalid terminal
  states, symlink and audit corruption, interrupted attempts, and successor
  protection. Keep normal refresh and guard semantics and guidance version 22.
<!-- simple-changelogs-signature agent="gpt-6-astra medium" at="2026-09-08T08:53:51-05:00" -->

- Keep the fork provenance pin pending while new-command gate review remains
  unresolved. Cover apply followed by replanning and pin advancement after the
  gate includes the added command.
- Consolidate the prepared fork and target-discovery work with the reviewed
  workflow recovery repairs in the 0.16.0 release. No 0.15.3 release was published.
<!-- simple-changelogs-signature agent="gpt-6-astra medium" at="2026-09-08T10:00:38-05:00" -->

## 0.15.2 - 2026-09-04

- Share the controller state lock with standalone maintenance, taking it before
  the worktree coordination lock so inventory and cleanup cannot race guarded
  integration or registration changes.
- Preserve all worktrees, prepared paths, and opening branches registered by an
  open loop regardless of heartbeat liveness, including later checkouts attached
  to those protected branches. Defer Git metadata pruning when
  its global operation would remove a protected registration.
- Add regression coverage for stale open-loop protection, shared integration
  locking, opening branches, and protected missing-worktree metadata. Retain
  the existing controller ownership and explicit recovery boundaries.
- Advance package, CLI, and packaged public notes to 0.15.2. Guidance remains 22;
  these safety corrections restore the existing preservation contract.
<!-- simple-changelogs-signature agent="gpt-6-astra medium" at="2026-09-04T20:23:24-05:00" -->

## 0.15.1 - 2026-09-04

- Check the current fork pin before reconstructing the prior upstream version,
  allowing repeat application of an already-current reviewed synchronization plan.
- Finalization now accepts the shipped target recorded by a verified shipment
  outcome while preserving unrelated opening branches and dirty worktrees.
  Conflicting shipment evidence and unverified outcomes still block closure.
- Added fork-pin and finalization regression coverage and updated the CLI contract
  assertion for the verified shipment completion path.
- Advanced the package, CLI, and packaged public notes to 0.15.1. Guidance remains
  at version 22 because these corrections restore existing workflow behavior.
<!-- simple-changelogs-signature agent="Astra medium" at="2026-09-04T23:38:58+00:00" -->

## 0.15.0 - 2026-09-04

- Extracted the proven-safe cleanup core into `scripts/lib/cleanup-core.ts` and
  reused it from loop finalization, `standaloneWorktreeCleanup`, and the new
  prune path: `targetContainsRevision` and `targetContainmentAudit` (exact
  ancestry first, then full per-commit patch equivalence under
  `PATCH_EQUIVALENCE_MAX_COMMITS`), `localBranchForTargetRef`, and
  `deleteTargetContainedBranches`. The three callers now share one
  implementation instead of parallel copies, and no safety check was weakened
  or relaxed in the move.
- Added `pruneRepository` and `prune --approved-by ID --reason TEXT
  [--target REF] [--dry-run] [--json] [--repo PATH]`, a cleanup pass that holds
  no controller lease of its own:
  - It computes the complete plan (`plannedRemovals`, `plannedPrunePaths`,
    `plannedBranchRemovals`) and reports it before any mutation, so the
    destructive form and `--dry-run` produce the same plan.
  - Each disposition carries its containment method, `target-contained` or
    `patch-equivalent`, and each candidate is re-audited against fresh
    inventory immediately before removal.
  - Preserved entries carry a reason: the primary checkout, the target branch,
    dirty or actively claimed checkouts, anything registered `preserved` or
    `retained` in a lease, and branches beyond the patch-equivalence commit
    bound.
  - When a lease exists and is not provably stale, prune refuses to touch what
    that lease registers and prunes only what is outside the manifest. It never
    edits lease state, worktree claims, or recorded receipts, and unlike
    `worktree cleanup` it does not release claims.
- Added lease liveness. `LoopLease` gained an optional `ownerProcess`
  (`hostname`, `pid`, `recordedAt`) written alongside `updatedAt` by the
  operations that already persist lease state, with a matching closed object in
  `loop-lease.schema.json`. Exported `LEASE_STALE_AFTER_MS` (4 hours) and
  `leaseLiveness`, which reports `live` when the owner process is provably
  running or the heartbeat is recent, `stale` only when `ownerProcessProvable`
  is false and the heartbeat age exceeds the threshold, and `unknown` when the
  timestamp cannot be read. `loopStatus` returns the liveness object and the
  CLI prints it above the existing guidance block, so no caller compares
  timestamps itself.
- Added `recoverStaleLoopLease` and `loop recover --stale-lease --run-id ID
  --agent-id ID --approved-by ID --reason TEXT`. It refuses any lease not
  proven stale, archives the cleared lease into the run history like other
  terminal records, and emits a new `stale-lease-recovery` receipt
  (`schemaVersion: 1`, registered in `SCHEMA_NAMES`) pinning
  `liveness.state: "stale"`, `liveness.ownerProcessProvable: false`, the
  observed `staleAfterMs` and lease digest, and every preserved worktree path.
  `unknown` liveness is deliberately never recoverable, so an unparseable
  heartbeat can never be escalated into a clearance.
- Fixed `loopManifestDigest`, which hashed the whole lease and so covered
  bookkeeping fields despite its name. `loop takeover` compares that digest
  exactly, so any lease write between reading the digest and taking over
  invalidated it; the new heartbeat made that constant and would have turned a
  read-only-looking `loop verify` into a tamper-shaped failure for a safe
  operation. The digest now excludes only `ownerProcess` and `updatedAt` and
  still covers every safety-relevant field, so a genuine manifest change still
  trips takeover.
- Added `tooling/simple-changes/tests/prune-and-liveness.test.ts` covering
  prune planning and dry-run, both containment proofs, lease-registered skips,
  preservation reasons, liveness classification against the named threshold,
  stale-lease recovery and its refusals, and a regression test pinning that a
  guarded mutation advances the heartbeat without moving the manifest digest.
  Documented the new commands and schema in the README, `SKILL.md`, `SPEC.md`,
  and `references/cleanup-and-completion.md`.
- Advanced the package and CLI to 0.15.0. Simple Changes guidance stays at
  version 22: this release adds capability without changing how any existing
  command behaves for a user, introduces no setting, and requires no user
  decision, and the guidance policy reserves a bump for installed releases that
  materially change behavior, onboarding, settings, or companion integration.
  The new commands reach agents through the shipped `SKILL.md` and reference
  documentation, which install with the package regardless of guidance version.
<!-- simple-changelogs-signature agent="claude-opus-5 medium" at="2026-09-04T10:05:00-05:00" -->

## 0.14.0 - 2026-09-02

- Added the installable `update-local-forks` skill for synchronizing
  repository-specific forks from one global Simple Changes installation:
  - Discovery scans global skill roots and conventional `Developer`,
    `Projects`, `Code`, and `src` project folders, accepts additional `--root`
    locations, identifies provenance pins and layouts, and skips linked
    worktrees in favor of each repository's primary checkout.
  - Planning compares the pinned base, installed target, and fork file by file;
    applies upstream-only changes; preserves fork deltas and fork-only files;
    maps runtime files into supported fork layouts; and three-way merges shared
    edits.
  - Conflicts leave live files untouched and produce durable
    `.upstream-merge` sidecars, while intentionally omitted upstream references
    remain explicit review items. A `SKILL.md` conflict keeps the provenance pin
    pending until the conflict is resolved instead of reporting it as advanced.
  - Apply validates the complete saved-plan structure, rechecks fork identity,
    constrains every target path to the fork, rejects symlink traversal during
    planning and immediately before apply, and fails closed when planned
    updates, deletions, literal rewrites, live conflicted files, or their
    sidecars drift. It never executes fork code and advances provenance only to
    a release commit whose packaged tree byte-matches the installed source.
    Exact provenance, guidance-version, and upstream-version literals are
    reconciled with the verified target.
  - Integrated the planner into fork-maintenance and publishing guidance,
    package contents, type checking, and dedicated discovery, merge, conflict,
    stale-plan, hostile-path, symlink-escape, literal, conflicted-file and
    sidecar drift, pending-pin, pin-verification, CLI, and packaging coverage.
- Added consumer support for the CMS entry-only `classified` receipt. The
  receipt-v2 schema requires a classify-phase, pathless, non-versioned result
  with `release: null`; transaction validation binds it to
  `boundary: "none"`; and the release gate returns `re-delegate` with the
  decision digest so preparation proceeds without version authorization or
  production approval. End-to-end coverage validates the receipt and this gate
  path.
- Closed the reviewer-identified instruction gap by adding `classified` to the
  shipped classification outcomes and receipt-status inventory, documenting
  the direct classify-to-prepare handoff, and asserting that guidance in the
  skill contract.
- Corrected the stale shipped CLI version constant from `0.12.19` to the
  then-current `0.13.0` package version after the full suite exposed the
  mismatch, then reconciled both package and CLI versions to `0.14.0`.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-09-02T16:38:19-05:00" -->

## 0.13.0 - 2026-09-02

- Added the `proposalSignatures` repository policy with the
  `agent-and-version` default and `none` opt-out. Proposal signatures record
  each agent author, review, or merge action using provider-appropriate PR/MR
  wording; review attribution is carried in the approval body and providers
  that support it receive a `Merged-By-Agent` trailer. Attribution remains
  informational and grants no review or merge authority.
- Completed the release-delivery protocol:
  - Exposed `release-gate` through the CLI and made the Web production boundary
    evaluate delegated release requests and verified receipts.
  - Added `release-delivery`, which composes delivery identity from verified
    changelog and production-deployment receipts instead of copied fields and
    exits nonzero for partial or blocked delivery.
  - Made changelog-request `attempt` and `environment` optional informational
    fields and resynchronized the contract across bundled providers.
- Hardened worktree-claim lifecycle handling. A claim can now release through
  its owner, a proceeding completed-work handoff, or finalization evidence;
  handoff ownership is resolved explicitly, and completed handoffs clear their
  coordination residue without weakening active-loop protection.
- Added installed-client compatibility gating for production migrations, before
  any production schema change proceeds.
- Recognize `simple-changelogs-cms` repositories and their policy when
  delegating changelog work, report CMS-only release handling as not applicable
  instead of silently omitting it, and offer compatible Simple Changelogs
  installation through setup. Removed the unwired coordinated onboarding path
  and pinned the specification to the implemented request modes and guarantees.
- Advanced Simple Changes guidance to version 22, covering proposal signatures,
  claim-release lifecycle, changelog installation, CMS discovery, and the
  release commands.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-09-02T18:08:00-05:00" -->

## 0.12.19 - 2026-08-26

- Replaced `bunx ultracite` package scripts with the lockfile-installed
  Ultracite binary so release gates cannot fetch a moving latest version.
  Reconciled the Biome development dependency, configuration schema, and
  lockfile to `2.5.10`. Runtime behavior and guidance are unchanged.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-26T18:27:18-05:00" -->

## 0.12.18 - 2026-08-26

- Hardened standalone worktree cleanup with durable exact-plan intent receipts,
  remote-ref target protection, and last-moment prune-plan verification. New
  intent and completion receipts use `schemaVersion: 2`; completed
  `schemaVersion: 1` receipts remain valid and are preserved exactly without
  inferred plan evidence.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-26T17:29:43-05:00" -->

## 0.12.17 - 2026-08-26

- Replaced `Array.prototype.reverse()` on the copied takeover-history array
  with an explicit reverse-index scan to satisfy `unicorn/no-array-reverse`
  under the package's ES2022 TypeScript target while preserving newest-first
  matching behavior and byte-identical fork publication.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-26T16:48:35-05:00" -->

## 0.12.16 - 2026-08-26

- Closed the stale-opening-manifest deadlock reported twice from live runs in
  a multi-agent repository:
  - New `rebaselineLoopWorktrees` / `loop rebaseline --run-id --agent-id
    --approved-by --reason`. An active or resumed controller registers every
    current `unregistered-worktree` violation path as a `preserved` lease
    entry at its exact current head and change digest (`createdByRun: false`,
    `mutationAllowed: false`), appends an audited `rebaselines` record
    (approver, reason, timestamp, exact registrations) to the lease, and
    returns the post-rebaseline verification. Owner-only, refuses when no late
    arrivals exist, and never touches the registered worktrees. The loop-lease
    schema gained the optional `rebaselines` field. Because
    `closeEquivalentObligatedPaths` only obligates controller, author, and
    run-created worktrees, re-baselined late arrivals never block or join a
    later `close-equivalent` proof; the recovery chain for a relinquished run
    is takeover/resume, rebaseline, reconcile, then close.
  - `loopStatus` now returns a `guidance` object (`headline`,
    `nextCommands`) mapping the observed state to the exact next recoverable
    commands: rebaseline for `unregistered-worktree`, `loop allow` with the
    exact path and digest for `preserved-worktree-changed`, disposal for
    missing preserved/retained paths, takeover and close-equivalent for a
    relinquished lease (ordered by whether a first scope was recorded), and
    record-scope/record-outcome/finalize for a healthy lease. The CLI prints
    the guidance after the verification block.
- New `worktree-maintenance.ts` module:
  - `standaloneWorktreeCleanup` / `worktree cleanup --agent-id --approved-by
    --reason [--target REF]`: refuses while any loop record exists (active or
    relinquished), then removes only unclaimed clean worktrees whose head is
    target-contained by exact ancestry or full per-commit patch equivalence
    (200-commit cap, shared patch-id cache), re-auditing each candidate
    against fresh inventory immediately before `git worktree remove`. Deletes
    a removed worktree's branch only when its tip equals the removed head.
    Prunes stale metadata for missing directories and verifies it is gone.
    Live-claimed, dirty, unresolved, or unmatched worktrees are preserved with
    a reason and exact next command. Appends a schema-validated receipt
    (new `worktree-cleanup` schema) to
    `simple-changes/worktree-coordination/cleanups.json`.
  - `refreshWorktreeIndex` / `worktree refresh-index`: prunes only stale
    worktree metadata under the coordination lock and reports per-adapter
    notes driven by the `worktreeIdentity` capability (native surfaces re-sync
    from Git; claim-only adapters have no cached index), plus the pruned and
    remaining paths.
- `auditWorktreeEquivalence` computes optional `residue` hints when unmatched
  commits or differing paths remain: per unmatched commit, the sorted touched
  paths and whether every touched path's HEAD blob equals the target blob;
  per differing dirty path, whether it differs only in whitespace. Residue is
  computed before the closing evidence re-check, carries an explicit
  advisory-only note, and never affects the `contained`/`partial`/`divergent`
  classification. The report schema gained the optional `residue` field.
- `activeLoopNeedsPath` in `worktree-coordination.ts` now consults the lease's
  controller lifecycle and the registered entry instead of bare path
  membership: with an active controller every registered path still refuses
  `worktree takeover`, but under a relinquished controller only a `preserved`
  registration carrying a `claimId` (an adopted coordination linkage the
  resumed controller must verify) stays protected. Field-reported regression:
  a run's own opening `concurrent-author` registrations froze the release of
  three stale claims even after the run relinquished.
- Guidance version 21 records the re-baseline, status-guidance, standalone
  cleanup, index refresh, residue-hint, and lifecycle-aware takeover
  behaviors.

## 0.12.15 - 2026-08-26

- Closed three cleanup accumulation gaps reported from field runs:
  - `loop finalize` branch deletion keeps its eligibility gates (not the
    target, not attached to a worktree, and an unchanged opening branch,
    run-owned, or reconciled-absent) but now accepts containment by exact
    ancestry or by full per-commit patch equivalence, capped at 200 commits
    ahead. A branch with any unmatched commit, or one over the cap, is
    preserved and named instead of deleted. Each removal records
    `target-contained` or `patch-equivalent` as its containment method.
  - `adopt-worktree` and `accept-paused-change` no longer treat a sibling
    unregistered worktree that holds a valid current same-run pause receipt as
    a blocking manifest violation. That removes a deadlock where two or more
    receipted stragglers could not be adopted in any order.
  - `loop dispose-worktree` now accepts a worktree adopted into the lease
    mid-run through `adopt-worktree` or `accept-paused-change` under the same
    path, digest, owner, approver, cleanliness, and zero-unique-commit bar as
    exceptional changed opening work, and counts a commit whose exact patch the
    pinned canonical target already contains as not unique. The recorded
    disposition names the proving method.
  - `LoopWorktreeDisposition` and the loop-lease schema gained the optional
    `containmentMethod` field (`target-contained` or `patch-equivalent`).
    Regression coverage spans patch-equivalent and over-cap branch cleanup,
    sibling-receipt adoption ordering, and adopted-worktree disposition.
- Ship receipts are contract-bound to lead with the shipped outcome. `SKILL.md`
  and `references/ship-communication.md` require the first line after the
  status to name the change in plain language from each shipped unit's recorded
  outcome, before merge, check, and deployment evidence, and even when no
  changelog entry was written. The reference adds an avoid/prefer receipt
  example and bans dangling internal cross-references and lists of evidence
  that was deliberately not relied on. `tests/skill-contract.test.ts` pins the
  new prose.
- Replaced every em dash in the skill (documentation, guidance copy, and
  CLI-facing strings) with the grammatically appropriate equivalent:
  parentheses for paired asides and label qualifiers, commas for contrastive
  and appositive clauses, colons for option label-description separators, and a
  semicolon between independent clauses. This changes user-visible onboarding
  and update option copy punctuation, so contract and onboarding test pins were
  updated with it. Released changelog history was deliberately left untouched.
- Documented the harness self-permission guard in
  `references/harness-push-authorization.md`: a harness that forbids an agent
  from editing its own permission or allowlist file is correct behavior that
  user approval in chat does not lift, and the agent hands over the exact file
  and lines instead.
- Advanced the package and CLI to 0.12.15. Simple Changes guidance stays at
  version 20: this release introduces no setting and requires no user decision,
  and the guidance policy reserves a bump for installed releases that
  materially change behavior, onboarding, settings, or companion integration.
<!-- simple-changelogs-signature agent="claude-opus-5 medium" at="2026-08-26T10:35:00-05:00" -->

## 0.12.14 - 2026-08-25

- Added audited recovery contracts for inherited broken shipment state:
  - Worktree claim takeover requires an exact current status digest, named
    approver, and reason; persists an `intent` receipt before changing claim
    state; recovers an applied intent after interruption; refuses claims still
    required by a live lease; and completes reassignment or release without
    mutating the checkout. Loop start and takeover acquire the loop-state lock
    before the coordination lock, serializing lease creation with claim changes.
  - Worktree equivalence records stable patch-id matches for commits and
    compares worktree bytes plus staged object IDs, executable modes, and Git
    links against the target. Evidence captures opening and final HEAD plus
    `changeDigest`, refuses a receipt unless both snapshots match, classifies the
    checkout as `contained`, `partial`, or `divergent`, and explicitly reserves
    semantic equivalence for human review.
  - Target-equivalent loop closure accepts only ancestry or current
    digest-bound `contained` evidence for every obligated worktree. Missing
    registered or preparing worktrees, final manifest violations, and cleanup
    errors remain blocking; GitLab targets also require a complete final
    branch/proposal reconciliation for the current target revision before the
    immutable `target-equivalent` outcome can release the lease.
- Added closed schemas and CLI validation for takeover, equivalence, and
  close-equivalent receipts, including public `validate loop-close-equivalent`
  support; synchronized the skill contract, help, README, and recovery guidance;
  and added regression coverage for stale digests, unique staged state, mode
  changes, Git links, equivalence-audit races, missing obligations, recoverable
  takeover intents, and clean closure.
- Guidance 19 now names `proposalScheduling`, documents `balanced` as the
  backward-compatible default for policies without the setting, and has focused
  upgrade coverage for stored guidance versions 18 and 19.
- Advanced the package and CLI to 0.12.14 and installed Simple Changes guidance
  to version 20 so existing installations receive the audited inherited-state
  recovery paths.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-25T13:28:22-05:00" -->

## 0.12.13 - 2026-08-24

- Added the backward-compatible `proposalScheduling` repository policy and
  setup flag with `balanced`, `consecutive`, and `parallel` values. Existing
  policies default to `balanced`; the schema, stored-policy parser, onboarding
  types, CLI validation, setup documentation, and focused tests cover the new
  preference.
- Setup now derives the target forge from the selected remote binding and
  threads it through the first-use introduction, finish paths and choices,
  scheduling prompt, and confirmation summary. Rendering consistently maps
  GitHub to PR/PRs, GitLab to MR/MRs, and unknown providers to change
  proposal/change proposals while internal proposal schemas remain
  provider-neutral.
- Documented that parallel authors require distinct claimed worktrees under the
  existing common Git directory, that cleanup removes dependencies and build
  artifacts only with a proven-safe completed worktree, and that a standalone
  clone must not bypass an active controller or advance the same remote target
  outside its lease.
- Advanced Simple Changes guidance to version 19 so existing installations
  receive the proposal-scheduling and forge-aware terminology behavior.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-24T13:23:14-05:00" -->

## 0.12.12 - 2026-08-23

- Added an explicit ready-work handoff boundary for completed, verified work
  blocked only by another task’s active shipment:
  - The agent preserves the exact work and asks whether to request inclusion in
    the active shipment or wait and ship separately afterward. It cannot contact
    the active owner before the user chooses.
  - An approved handoff receipt identifies the exact repository, worktree,
    branch, commit, completed checks, release impact, migrations, and deployment
    constraints. The receipt grants no ownership, merge, deployment, migration,
    cleanup, or other shipment authority.
  - When the active shipment owner cannot be resolved, the agent emits the same
    bounded receipt for manual delivery rather than guessing a recipient.
- Added an evaluation journey covering the ready-work choice, the no-contact
  boundary, approved receipt contents, and unknown-owner fallback.
- Advanced the package and CLI to 0.12.12 and installed Simple Changes guidance
  to version 18 so existing installations receive the explicit handoff
  boundary.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-23T12:33:09-05:00" -->

## 0.12.11 - 2026-08-23

- Tightened shipment-loop lifecycle boundaries:
  - Mode-matching startup no longer treats a relinquished loop as implicitly
    resumable; continuation requires the explicit resume path.
  - The first incomplete finalization permanently freezes author/worktree
    acquisition for that loop. Resumed and replacement controllers retain full
    authority to finish already registered or preparing work and complete the
    existing shipment, but cannot prepare an author for unrelated later work or
    record a first scope from later repository state.
  - Explicit Resume and Takeover backfill the freeze timestamp for legacy
    pre-0.12.11 relinquished leases before continuation.
  - Frozen loops neither admit nor report late actively claimed concurrent
    worktrees as manifest violations. Those worktrees remain external and
    preserved while the older shipment finishes and closes.
  - Added focused regression coverage for explicit resume, registered-author
    continuation, later-author refusal, first-scope refusal after freeze, and
    late-claim exclusion.
  - Advanced the package and CLI to 0.12.11 and installed Simple Changes
    guidance to version 17 so existing installations receive the explicit
    resume and frozen-acquisition behavior without weakening work preservation.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-23T11:28:39-05:00" -->

## 0.12.10 - 2026-08-21

- Added a narrow post-cleanup recovery exception for
  `missing-preserved-worktree`: the absent lease entry must be run-created,
  currently preserved, and bound to a recorded baseline revision contained in
  the finalized target. Only those exact violations are filtered; every other
  manifest violation remains blocking.
- Completion now supplies the filtered recovery verification to the ordinary
  cleanup-blocker calculation, so a qualifying legacy artifact cannot reappear
  as a generic blocker after passing the stricter evidence check.
- Added an end-to-end recovery fixture for an absent, target-contained prepared
  checkout reclassified as preserved. Existing gates continue to reject
  nonmatching, unverifiable, or unique checkout state.
- Added a second narrow post-cleanup exception for
  `registered-worktree-branch-changed`: it applies only to the primary checkout
  when that checkout is clean and its current branch and revision exactly match
  the finalized target. Any mismatch remains blocking.
- Extended local-consumer discovery with the four standard per-user global
  skill roots. Discovered paths are canonicalized by physical target before
  deduplication, preventing symlink aliases from producing duplicate consumers
  while ensuring globally installed copies participate in every normal publish.
- Advanced the package and CLI to 0.12.10 and installed Simple Changes guidance
  to version 16 so existing installations receive the narrowly bounded legacy
  cleanup behavior.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-21T16:19:23-05:00" -->

## 0.12.9 - 2026-08-21

- Generalized close-only post-cleanup recovery evidence without weakening its
  stability gate:
  - `activeClaimCount` in the recovery schema is now a nonnegative integer
    instead of the constant zero, allowing unrelated active claims to remain
    preserved during legacy bookkeeping closure.
  - Validation now requires the active-claim count and claim-inventory digest
    to match across both ordered observations. A changed count, changed digest,
    or non-increasing observation time still rejects recovery.
  - Focused tests accept two stable observations containing 18 unrelated active
    claims and reject a count change between observations.
- Advanced the package and CLI to 0.12.9 and installed Simple Changes guidance
  to version 15 so existing installations receive the stable-claim recovery
  behavior.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-21T16:00:15-05:00" -->

## 0.12.8 - 2026-08-21

- Narrowed `acceptPausedWorktreeChange` verification so one exact replacement
  pause and claim may be persisted when every remaining violation is an
  unrelated `coordination-claim-stale` on another path. Any violation for the
  accepted path, or any non-stale coordination, inventory, content, or safety
  violation, still rejects the operation.
- Added a lease fixture with two unchanged preserved worktrees whose ownership
  changed after their original pauses. It proves the controller can bind each
  replacement receipt in sequence, leaving only the other stale claim after the
  first acceptance and a clean verification result after the second.
- Advanced the package and CLI to 0.12.8 and installed Simple Changes guidance
  to version 14 so existing installations receive the sequential stale-handoff
  repair behavior.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-21T15:37:07-05:00" -->

## 0.12.7 - 2026-08-21

- Tightened the temporary-checkout cleanup ledger and finalization path:
  - Shipment and deployment guidance now routes temporary checkouts through
    `prepare-agent`, which records them as run-created cleanup artifacts rather
    than retained worktrees.
  - Automatic-cleanup modes reconcile an already-missing retained worktree only
    when its recorded branch and audited clean head are present, both revisions
    are contained in the finalized target, and no active claim remains. The
    completed removal disposition is bound to the exact target revision and can
    retire the now-unreferenced contained branch; ordinary verification accepts
    the absent path only after that disposition exists.
  - Lease tests cover safe reconciliation of a contained clean branch and the
    blocking case where the absent branch still has unique work. Skill-contract
    tests preserve the `prepare-agent` requirement and the no-confirmation
    safety boundary.
- Advanced the package and CLI to 0.12.7 and installed Simple Changes guidance
  to version 13 so existing installations receive the response-recap and
  temporary-checkout cleanup behavior.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-21T15:10:50-05:00" -->

## 0.12.6 - 2026-08-20

- Reworked installed-guidance notices around explicit decision priority:
  - `GuidanceUpdateNotice` now exposes `presentationOrder`, `requiredAnswers`,
    and `recommendedChanges`. Required questions are rendered first as short
    multiple-choice prompts, with the recommended choice and its consequence
    first, before any walkthrough action is offered.
  - Optional setting recommendations are shown immediately after required
    answers. When neither is pending, initialization says that no new settings
    answer is required and makes continuing with confirmed settings the
    recommended action.
  - Default summaries select at most three prioritized practical bullets across
    skipped guidance versions. Short and expanded walkthroughs are distinct,
    and detailed release notes remain a separate read-only option.
  - Standalone and combined Simple Changes/Simple Changelogs notices preserve
    existing settings, repository files, and current work, and retain required
    owner-controlled decisions ahead of optional update detail.
  - The presentation changes add no push, merge, release, publication,
    deployment, migration, data-write, credential, or other authority.
- Advanced the package and CLI to 0.12.6 and installed Simple Changes guidance
  to version 12 so existing installations receive the shorter decision-first
  update notice.
- Added a conserved Ship-scope gate for runs whose opening inventory contains
  local changes:
  - `loop start` sets `shipmentScopeRequired`; `loop record-scope` accepts only
    a non-mutating preview for the exact unchanged opening `baselineDigest`,
    requires all plan questions to be resolved, validates path conservation
    across every worktree, and persists the plan digest, opening changes, and
    immutable opening source-tree identity for every worktree-plus-path unit.
    Regular-file identities use `git hash-object --path <path> -- <path>` so
    Git applies path-aware clean/text conversion while the delimiter protects
    leading-dash filenames from option parsing. Symlink identities hash the raw
    literal target bytes, including for broken links. This prevents
    `.gitattributes`, LFS-style filters, and unusual leading-dash filenames from
    falsely invalidating an otherwise matching outcome.
  - `loop guard`, `loop exec`, and completion fail closed until that receipt
    exists. `prepare-agent` is also blocked until the required shipment scope
    exists. A `preserved` lease role continues to protect a worktree from
    controller mutation or deletion, but does not imply shipment exclusion.
  - Exclusions can bind both `worktreePath` and `path`, so the same relative
    filename in multiple worktrees can be scoped independently.
  - The generated receipt renders every included unit with its title, outcome,
    branch or detached revision, and source worktree, followed by distinct
    preserved and excluded sections.
  - Controller-only `loop refresh-scope` requires an existing shipment scope and
    no recorded outcome. It accepts only a non-mutating preview that matches the
    exact current inventory, resolves every question, and conserves every current
    dirty change. The refresh preserves the original full shipment path scope
    while recomputing each exact source entry. It rejects genuinely new paths,
    but permits an integration checkout to materialize a path only when the same
    relative path and content are already scoped from another worktree. The
    superseded plan digest and its recorded and superseded timestamps remain in
    `shipmentScopeHistory`.
- After review and integration, the controller records one
  `loop record-outcome` receipt bound to the exact final revision:
  - Shipment outcomes accept only the exact immutable opening source result
    recorded for that worktree and path or a target-equivalent result.
    Review-driven source changes require a fresh scope; controller-authored
    fields such as `reviewerAgentId`, `reconciled`, or review-delta metadata do
    not prove or impersonate independent review.
  - Each unit's final path set must exactly equal its scoped path set. Every
    rename original is mandatory, owned by its scoped unit, and rejected if it
    is instead routed through `additionalPaths`.
  - Only `release-generated` or `external-target-change` additional paths are
    accepted. Each must be an exact, real remaining opening-to-final target
    delta with its classification and reason; unchanged paths and other
    non-delta extras are rejected.
  - Completion re-resolves the final target, rechecks every recorded result,
    and rejects a moved target or stale receipt until a new controller-recorded
    receipt binds the exact final revision. Recording adds no user approval
    boundary. Cleanup authority remains unchanged: existing lease and
    disposition safety still governs removal, and dirty source worktrees do not
    become automatically removable.
- User-facing review communication now emits every independent-review finding
  as an explicit bullet rather than abstracting the result to a numeric count;
  when a finding has a primary local source location, its summary deep-links
  that file and line.
- `loop exec` rejects `git switch` and branch-changing `git checkout` for
  registered controller or author checkouts before starting the guarded child
  process. Known global options—`-C`, `-c`, `--git-dir`, `--work-tree`, and
  `--no-pager`, including separate-value forms—are parsed before command
  classification. Unrecognized global options fail closed, so flags such as
  `--literal-pathspecs` cannot shift parsing to hide checkout branch switching,
  while path-only `git checkout ... -- <paths>` restoration remains allowed.
- Planner checks for root or nested-monorepo `package.json` files and supported
  dependency lockfiles now add isolated-clean-checkout verification with a
  frozen install and production build; the manifest, lease schema, CLI,
  contract, and loop tests cover the new scope, outcome-receipt, and
  verification contracts.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T17:35:51-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T18:10:46-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T18:19:51-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T18:31:54-05:00" -->

## 0.12.5 - 2026-08-15

- Bound GitLab integration loops to truthful opening provider evidence:
  - Queue, Sweep, Integrate, Ship, Reconcile, and Resume persist a complete,
    unchanged branch plus open/merged/closed proposal inventory atomically with
    lease creation, before the first provider mutation.
  - Opening evidence binds the exact GitLab project, target branch, and target
    revision. Legacy leases in all six modes remain inspectable but cannot
    prepare author worktrees, cross mutation guards, or perform cleanup
    mutations; Queue and Sweep receive the same fail-closed treatment as
    Integrate, Ship, Reconcile, and Resume.
  - Ordinary reconciliation receipt recording, `loop end`, and finalization all
    preserve the missing-opening blocker, so none can relabel later evidence or
    bypass the dedicated post-cleanup recovery path.
- Added explicit close-only recovery for legacy cleanup that already finished:
  - `loop recover-post-cleanup` requires a nonblank approver and audit reasons,
    the exact old run, project, branch, and current target revision, two complete
    matching post-cleanup inventories observed in order, and two ordered
    worktree-claim observations with the same document digest and zero active
    claims.
  - Recovery revalidates the current claim-document digest, rejects claims
    changed during or after the observation window, and requires a clean current
    primary, no open proposals, and no remaining cleanup blockers.
  - Recovery archives immutable intent and completion events and retires only
    inactive claims whose worktrees are already absent. It cannot move refs,
    remove worktrees or branches, change provider state, push, merge, or deploy.
  - The worktree-coordination lock is held continuously from final inventory and
    claim verification through immutable audit writes, already-absent stale
    claim retirement, completion recording, and active-lease removal.
  - Before retiring an already absent paused or adopted claim, recovery persists
    an immutable deterministic plan containing the coordination document's
    before digest, expected after digest, retirement time, and sorted retired
    claim IDs. Before writing, a retry recomputes and validates the exact
    projection; it accepts only the exact before state or the already-applied
    after digest, so a crash after claim retirement resumes idempotently without
    replaying a different mutation.
  - Existing `intent.json` and `completed.json` recovery events are opened
    without following links and must pass file-descriptor regular-file checks;
    symlinks, directories, devices, and other non-regular audit objects fail
    closed instead of being parsed as immutable evidence.
  - Completed worktree-removal dispositions now retain explicit intended and
    completed states. Already removed worktrees remain auditable but stop
    blocking later finalization, and a crash after recovery intent can clear
    only matching stale locks before safely retrying the same receipt.
  - Added closed-schema and unit coverage for matching inventories and claim
    observations, blank approval fields, open proposals, local cleanup blockers,
    changed or active claims, moved targets, mutation-free closure, preserved
    removal history, Queue/Sweep author-preparation rejection, linked audit
    events, and a process death immediately after paused-claim retirement. CLI
    end-to-end coverage exercises the explicit recovery command plus process
    death, stale loop and coordination lock recovery, and idempotent retry.
- Narrowed the global controller lock to shared integration mutations:
  - Run-prepared and independently claimed authors may edit, generate, format,
    test, stage, and commit concurrently in distinct worktrees and branches.
  - Target movement, integration merge or cherry-pick, push, proposal creation
    or merge, deployment, worktree or branch lifecycle changes, and cleanup
    remain serialized through the short controller lock.
  - Lock contention pauses only the named shared operation. It must not trigger
    a repository-wide author pause, patch export, destructive cleanup, or a
    lease-null handback.
  - `EPERM`, `EACCES`, and `EROFS` failures while creating controller state are
    reported as harness or file-system permission failures rather than being
    misdiagnosed as another agent holding the lock.
- Refined Simple Changelogs onboarding and consent boundaries:
  - A compatible discovered installation makes Delegate when available the
    recommended and default onboarding choice.
  - When Simple Changelogs is relevant but unavailable, onboarding first
    explains the skill and requests explicit installation consent. Only after
    acceptance does it ask whether setup should happen now, after the current
    shipment, or later; installation and configuration never happen silently.
  - Delayed setup preserves current changelog work. When the current shipment
    requires a release boundary, the prompt explains that setup now or stopping
    before release is required instead of discarding or bypassing that work.
  - Delegation, installation consent, and setup timing grant no version,
    release, publication, deployment, or data authority.
- Clarified how onboarding reuses and stores settings:
  - Before the main walkthrough, setup detects an existing private global
    personal policy and asks whether to use it unchanged for the current run;
    declining continues through normal onboarding without changing it.
  - Storage choices now explicitly label repository policy as team-shared,
    global personal policy as a private fallback, and run-only settings as
    writing no policy file.
  - When private global defaults already exist, selecting global personal
    storage explicitly states that setup will update or overwrite those
    defaults before asking for confirmation.
- Advanced the package and CLI to 0.12.5 and installed Simple Changes guidance
  to version 11 so existing installations receive one practical update notice.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-20T13:57:40-05:00" -->

## 0.12.4 - 2026-08-14

- Established a plain-language-first contract for all user communication:
  - Messages lead with the outcome, practical meaning, and next action instead
    of making users decode controller, lease, ledger, digest, or mutation-path
    terminology.
  - Routine updates default to one to three short sentences. Exact revisions,
    paths, commands, provider identities, durable workflow states, and other
    evidence follow the simple explanation when safety, authority,
    verification, or the user's next decision depends on them; full technical
    detail remains available on request.
  - Ship briefs and final receipts inherit the same ordering while retaining
    every required scope, permission, review, deployment, and audit fact.
  - Added a dedicated communication reference, specification rules, contract
    coverage, and an evaluation fixture that records the expected
    plain-language behavior for resuming a safely ended run without expanding
    its approved scope. The fixture defines evaluation criteria; it does not
    execute or certify model responses.
- Advanced the package and CLI to 0.12.4 and installed Simple Changes guidance
  to version 10 so existing installations receive one practical update notice.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-14T21:04:28-05:00" -->

## 0.12.3 - 2026-08-14

- Restored proof-bound automatic cleanup during finalization:
  - Integrate, Ship, Reconcile, and Resume identify registered non-primary
    worktrees that are clean, unclaimed, unretained, unchanged from their
    opening baseline or created by the run, and exactly contained in the
    refreshed target.
  - Finalization records automatic dispositions for eligible opening
    worktrees, removes live candidates, prunes eligible stale worktree
    metadata, and restores or fast-forwards a clean primary checkout.
  - The lease captures every opening branch's exact name and SHA. Automatic
    branch deletion is limited to a target-contained branch still matching that
    opening tuple or a branch owned by a run-created worktree or preparation;
    checked-out, late-arriving, or moved opening branches are preserved.
  - Finalization holds both the loop-state and worktree-coordination locks.
    Immediately before each live worktree removal it recomputes eligibility and
    requires the same path, branch, head SHA, content-sensitive change digest,
    and unclaimed status. It then persists the candidate's exact automatic
    opening-worktree removal disposition before invoking destructive
    `git worktree remove` or `git worktree prune`, providing a durable intent
    across process death.
  - Before fast-forwarding, tracked dirty-primary paths are normalized only
    when their worktree bytes exactly match the refreshed target and their
    index has only zero-flag ordinary entries whose intent-to-add-visible cached
    diff matches either current HEAD or that target. Finalization rechecks the
    complete primary change digest before restoring eligible paths from current
    HEAD into both index and worktree.
  - Intent-to-add and other nonordinary index flags, unique staged content,
    conflicts, untracked or target-divergent primary paths, active claims,
    retained and concurrent-author roles, changed or dirty non-primary
    worktrees, unregistered late arrivals, checked-out branches, rewritten
    targets, and branches with unique commits continue to fail closed or remain
    preserved.
  - Cleanup results report normalized primary paths, removed worktrees and
    branches, pruned metadata, a primary update, and any cleanup errors before
    final inventory is verified.
- Made terminal finalization outcomes unambiguous:
  - A completed cleanup releases the lease only after the final inventory and
    manifest pass every completion gate.
  - Remaining blockers atomically relinquish durable controller state and the
    CLI exits with the unsafe nonzero status instead of returning a successful
    `relinquished` result that could be mistaken for completion.
  - Loop-lock recovery also inspects the coordination lock and removes it only
    when its host and PID match the stale loop owner, its minimum stale age has
    elapsed, and that local PID is dead. Active, mismatched, remote-host, young,
    or malformed ownership evidence still fails closed.
  - After recovery, the persisted exact removal intent lets finalization accept
    the already absent preserved worktree and resume cleanup instead of
    deadlocking on a missing-preserved violation.
- Removed the atomic deadlock from historical preserved-worktree overrides:
  - `loop allow` now validates whether the proposed exact path-and-digest
    override resolves violations for that path, then persists it even when
    unrelated preserved paths still have their own blockers.
  - Multiple historical overrides can therefore be recorded sequentially;
    stale or insufficient evidence for the named path still fails closed.
- Tightened Simple Changelogs distribution discovery:
  - Known installation directory names map to one exact distribution, and the
    fallback accepts only an explicit current-distribution marker rather than
    loose prose that may describe an incompatible distribution.
  - Repository-local and configured global skill roots enumerate
    `simple-changelogs`, `simple-changelogs-mobile`,
    `simple-changelogs-skill-maintainer`, `simple-changelogs-web`, and
    `simple-changelogs-web-cms`, making each mapped distribution discoverable.
  - Added regression coverage for automatic branch/worktree cleanup, stale
    metadata pruning, opening-ledger and late-branch protection, lock-held
    worktree candidate revalidation, pre-mutation durable removal intents,
    target-equivalent primary normalization and fast-forward, intent-to-add and
    unique staged/index protection, clean primary restoration, detached
    worktrees, late-arrival preservation, dirty/unique-work preservation,
    sequential historical overrides, nonzero relinquishment, a real child
    process receiving `SIGKILL` immediately after Git worktree removal followed
    by stale-lock recovery and successful resumed finalization, and mapped
    distribution discovery.
- Advanced the package and CLI to 0.12.3 and installed Simple Changes guidance
  to version 9.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-14T01:53:58-05:00" -->

## 0.12.2 - 2026-08-13

- Closed retained/concurrent pause handoff deadlocks:
  - `loop accept-paused-change` now accepts opening `preserved`, `retained`, and
    `concurrent-author` worktrees that provide exact claim and pause evidence.
  - Acceptance reconstructs immutable preserved state from the paused snapshot,
    clears stale retention metadata, and keeps mutation authority disabled.
  - Added regressions for pauses recorded both before and after retained
    worktree promotion.
- Made opening-worktree disposal follow the refreshed target safely:
  - Removal audits and stored dispositions now compare against the current
    resolved target revision instead of the loop's pinned opening revision.
  - The refreshed target must descend from the pinned revision; rewritten or
    divergent targets fail closed.
  - Added coverage for target advancement that absorbs an opening worktree and
    for non-descendant target rejection.
- Bound active loops to exact Git remote destinations:
  - Inventory records every remote's effective sorted fetch and push URLs,
    provider, and selected target remote after removing URL userinfo, query,
    and fragment data from persisted bindings.
  - Loop leases persist those bindings and emit `remote-destination-changed`
    when any destination changes after start.
  - `remoteBindings` remains schema-optional for pre-0.12.2 active leases, but
    verification emits `remote-destination-rebind-required`; the legacy
    controller cannot pass a guarded mutation and must finalize as relinquished
    before a current controller starts with a real opening destination snapshot.
  - Legacy reconciliation receipts without current coverage fields are removed
    on read so the active lease remains recoverable but must collect fresh
    reconciliation evidence before completion.
  - Added regression coverage for credentials, changed push URLs, old bindings,
    and old reconciliation receipts.
- Restricted repository policy authority to locally trusted bytes:
  - Repository policy symlinks and other non-regular files are rejected.
  - Persistent push authorization, automatic migration modes, break-glass
    ordering, and automatic production deployment are downgraded to safe
    ask/standard behavior unless a private `0600` receipt beneath the common
    Git directory binds the real repository path, real policy path, exact
    policy digest, approver, and reason.
  - Policy byte or repository-path changes invalidate the receipt. Inventory
    now exposes whether trust is `trusted`, `untrusted`, or `not-required`.
  - Policy-trust and migration-authorization paths reject symlinks in any
    existing ancestor beneath the common Git directory before reading or
    writing private state.
- Strengthened exact migration execution authority:
  - The apply-plan schema now requires an adapter, absolute executable argv,
    executable SHA-256 digest, exact target, nonce, issue and expiry times, and
    a fresh target-bound remote ledger containing the same canonical operation
    set.
  - Decisions reject stale ledgers, expired or overlong windows, future
    evidence, changed targets, changed commands, and mismatched operations.
  - Successful automatic decisions return the exact argv, absolute executable
    identity and digest, canonical operations, and deterministic authorization
    digest.
  - `migration apply` recomputes the current decision, snapshots the exact
    digest-matching executable into private state, atomically consumes the
    authorization before execution, and launches that exact-byte snapshot with
    `shell: false`. Later decisions and apply attempts reject the consumed
    authorization even if the process fails after consumption.
- Scoped forge cleanup to the selected target provider:
  - GitLab remote-branch reconciliation is required only when the resolved
    target remote is GitLab, rather than whenever any auxiliary GitLab remote
    exists.
  - Added coverage for a GitHub canonical target with a separate GitLab mirror.
- Replaced unbounded dirty-worktree capture:
  - Inventory no longer loads complete binary diffs or untracked files into
    memory.
  - Changed paths now bind their index object ID and filesystem identity;
    regular files are opened with read-only, nonblocking, no-follow flags,
    verified again through `fstat`, and SHA-256 hashed in fixed-size chunks;
    symlink targets are hashed without following them, while directories,
    FIFOs, sockets, and devices use nonblocking type metadata.
  - Added a large-binary/FIFO regression proving bounded, nonblocking capture.
- Added pagination-completeness evidence to remote reconciliation:
  - Initial and final receipts now include separate branch and proposal page
    chains with input/output cursors, item counts, and response digests.
  - Validation requires first-page and terminal cursors, continuous cursor
    chains, ledger-matching counts, and explicit coverage of closed, merged,
    and open proposal states.
  - Proposal evidence can record whether it appeared initially, finally, or in
    both phases, so a proposal arriving between inventories is counted only in
    the matching phase.
  - Every branch and proposal coverage object now includes a consolidated
    ledger digest over both the canonical matching-phase entry digest and the
    ordered response-digest list for every page, binding single- and multi-page
    provider identities into the phase ledger without reconstructing page
    contents.
  - Incomplete pagination, missing states, phase-count mismatch, and changed
    consolidated ledger evidence now fail closed.
- Reconciled skill and onboarding guidance:
  - Push-authorization setup is now offered for every non-preview finish that
    may push, including review and integration boundaries instead of Ship only.
  - Changelog discovery reads the repository's selected distribution and
    refuses an incompatible full-distribution provider for a
    `skill-repository` policy.
  - Corrected the setup default from guidance version 6 to 8 and clarified that
    an exact unchanged retained worktree is a valid terminal state.
  - Reduced the primary skill router from 796 to 227 lines by moving detailed
    contracts to existing references while retaining the behavioral gates.
  - Expanded closed schemas and focused CLI, policy, onboarding, inventory,
    lease, migration, reconciliation, changelog-coordination, and contract
    regression coverage for all changes above.
- Advanced installed guidance to version 8 with informed update dispositions:
  - Update notices expose practical behavior summaries before their choices,
    recommend `review-settings`, and provide consequence-bearing descriptions
    for review, release-note, keep-current, and defer actions.
  - Neither the standalone nor combined walkthrough marks skipping or keeping
    settings as recommended before the new abilities are understood.
  - Guidance inspection now aggregates every pending version rather than
    summarizing only the latest definition, preserving all missed behavior,
    onboarding, and integration changes in category-grouped bullets.
  - Selecting `configure-harness` or colloquial “auto push” requires a precise
    confirmation explaining that persistent permission is limited to ordinary
    `git push` for one verified repository and remote across Codex, Claude Code,
    and other harnesses. It does not grant credentials, network access,
    force-push, protection bypass, proposal, merge, deploy, or other-destination
    authority, and unsupported harnesses continue to ask.
  - Repository setup now writes the policy first and then creates the private,
    digest-bound trust receipt in the common Git directory, making a confirmed
    consequential repository policy effective on the next inventory. The
    noninteractive CLI requires `--acknowledge-push-scope`; a bare option value
    cannot silently persist auto-push authority.
- Added bundled Ship permission preflight:
  - The closed `permission-bundle` contract normalizes and deduplicates every
    currently knowable unresolved permission from the validated plan, assigns
    each exact operation/authority/target/consequence/reason tuple a stable
    digest-derived ID, and renders the complete checklist in deterministic
    order.
  - The reachable `permissions bundle REQUESTS_FILE` CLI validates the closed
    request array, exhaustively maps every `PlannedOperation` plus release
    version selection to one authority, rejects any unmapped or mismatched
    operation, and renders one message instructing the user to approve all,
    decline all, or name exact request IDs. It deliberately does not parse or
    persist the reply itself.
  - The rendered checklist states that unlisted future actions are unauthorized;
    sandbox, network, credential, provider, and harness enforcement remain
    separate and intact.
  - Updated initialization output, schemas, runtime routing, Ship communication,
    onboarding, guidance-update references, CLI coverage, and contract tests.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-13T17:03:01-05:00" -->

## 0.12.1 - 2026-08-13

- Added harness-aware Git push authorization:
  - Repository policy, initialization, onboarding, schemas, CLI setup, and
    documentation now carry `gitPushAuthorization` end to end.
  - The closed values are `configure-harness`, `ask`, and `never`. New and
    legacy policies default to `ask`.
  - Ship onboarding explains each choice. Persistent authorization is limited
    to the narrowest verified repository- and remote-scoped mechanism supported
    by the current harness and cannot override sandbox, network, credential,
    administrator, branch-protection, or provider policy.
- Added exact retained-worktree exclusions:
  - `loop retain-worktree` records a clean non-primary worktree as `retained`
    only when its supplied status digest matches, its HEAD is auditable, and
    that HEAD is contained in the active loop target.
  - Retained worktrees remain mutation-disabled, stay outside shipment and
    completed-run cleanup, and preserve the approver, reason, and creation time
    in the closed lease schema.
  - A changed or missing retained worktree fails verification. A later valid
    owner claim promotes changed retained work to `concurrent-author`; dirty
    work otherwise requires an active claim or stable pause.
  - Updated completion and concurrency guidance and added policy,
    initialization, onboarding, CLI, lease-schema, retention, invalidation, and
    concurrent-claim regression coverage.
- Advanced installed guidance to version 7 for the new push-authorization
  preference and retained-worktree behavior.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-13T12:26:50-05:00" -->

## 0.12.0 - 2026-08-12

- Added review-bound migration automation preferences and an executable
  decision surface:
  - Repository policy and onboarding now support `ask-after-review`,
    `auto-apply-reviewed-routine`, `auto-apply-reviewed`, and `never`, with
    automatic authority bound to exact provider, project, and environment
    targets.
  - The closed `migration-review` and `migration-pending` schemas bind saved
    reviews and freshly observed pending operations to an immutable SHA-256
    digest of their sorted canonical operation records, where every record
    contains the revision path and SHA-256 content digest. The new closed
    `migration-apply-plan` schema adds `scope: "exact-listed-operations"`, and
    `simple-changes migration decision` requires the review, fresh pending set,
    and exact apply plan.
  - Before policy evaluation, the CLI re-hashes every referenced file from the
    current repository through symlink-safe relative-path validation and
    requires the review, pending, and apply-plan identities to match. Missing or
    malformed identity, symlinked paths, replayed pending evidence, changed
    operation membership, and same-path content edits all fail closed.
  - An automatic decision returns authority only for the canonical operations
    listed in the exact apply plan. Provider-native commands that apply every
    pending migration, or any other broader or changed apply command, require
    fresh review and explicit authority.
  - The decision remains fail-closed for destructive, irreversible, unbounded,
    lock-heavy, unprotected, or target-mismatched operations.
  - Setup, initialization, policy schemas, CLI help, references, and regression
    coverage carry the migration choices and exact targets end to end.
- Expanded onboarding and installed-update guidance:
  - First use can now walk through every main Simple Changes workflow and each
    preference in plain language, including the advanced break-glass option.
  - Update notices use practical headlines and summaries, detect Simple
    Changelogs guidance independently, and offer a combined walkthrough only
    when both skills have meaningful updates.
  - Changelog-required initialization now resolves owner-controlled update
    choices before loop start, keeping the shipment lease and pre-ship brief
    behind that decision boundary.
- Advanced guidance version 6 and added initialization, onboarding, migration,
  changelog-coordination, schema, trigger, CLI, and skill-contract regressions
  for the new behavior.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T20:35:29-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T20:51:48-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T21:00:27-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T21:10:13-05:00" -->

## 0.11.4 - 2026-08-12

- Added fail-closed local reconciliation gates to `loop end` and
  `loop finalize`:
  - Completion now requires the local target branch to exist at the refreshed
    target revision and the primary checkout to be restored to that branch with
    no unfinished changes.
  - Target-contained clean worktrees and merged local branches without a
    checkout are reported as cleanup blockers, while dirty worktrees, branches
    with unique commits, and actively claimed concurrent authors remain
    preserved.
  - Updated completion guidance and added regressions for stale targets, dirty
    or unrestored primary checkouts, merged branches and worktrees, and
    preserved work.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T13:36:26-05:00" -->

## 0.11.3 - 2026-08-12

- Corrected the Emergency Ship runtime reason from “exact checked candidate” to
  “exact candidate” for explicit break-glass deployment. The guidance now
  matches the existing deploy-before-focused-checks transition order; runtime
  behavior is unchanged.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T12:54:03-05:00" -->

## 0.11.2 - 2026-08-12

- Added fail-closed consumer validation for delegated changelog receipts:
  `releaseImpact: "none"` must be `not-applicable`, and `decision-required`
  remains valid only for a proven public boundary with a non-`none` bump.
  Regression coverage rejects producer receipts that request version approval
  for internal-only work.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T10:57:28-05:00" -->

- Corrected break-glass transition ordering: explicit production authority plus
  known native provider rollback capability is sufficient to deploy the
  candidate immediately. No blocking pre-deploy lookup or exact current-
  production anchor capture is required. Candidate health verification follows
  deployment, then focused checks, independent review, merge and release
  reconciliation, and final canonical verification complete the guarded
  sequence. Updated the decision-engine regression to lock this ordering.
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T10:59:18-05:00" -->
<!-- simple-changelogs-signature agent="gpt-5.6-sol medium" at="2026-08-12T11:01:37-05:00" -->

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
