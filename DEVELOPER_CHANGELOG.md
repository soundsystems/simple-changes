# Developer changelog

## 0.33.3 - 2026-11-19

- Why: the owner asked for "autoclean 4 tha newbz". A Queue or Sweep run
  keeps the worktree `prepare-agent` made for it, and in 0.33.2 nothing
  removed it until someone asked for a cleanup they may not know exists.
  Automatic clearing was built twice for 0.33.2 and removed after two
  reviews by gpt-6.2-astra at high effort (the second found 3 blocking
  defects in `queued-retirement.ts` at 959dfe8). This release rebuilds it
  with each of those findings as a requirement.
- The record (`queued-worktrees.ts`, new). When a Queue or Sweep run
  closes as queued, `finalizeOwnedLoop` calls `recordKeptQueuedWorktrees`
  before it removes the lease. It writes
  `queued-worktrees/<run-id>.json` beside the loop state, validated by the
  new `queued-worktrees` schema, a file older runtimes never open. Each
  entry holds the worktree's path and branch, a registration ID, and the
  target binding. `ensureRegistrationId` writes the ID into the worktree's
  private Git directory
  (`<common>/worktrees/<name>/simple-changes-queued-worktree`), which Git
  deletes with the worktree. `queuedTargetBinding` resolves the lease's
  target to `refs/heads/<branch>` on one remote and that remote's single
  fetch address as Git resolved it (`singleFetchUrl`, `remote get-url
  --all`, one whole line), stored without credentials. A target that is
  not a remote branch, or a remote with several addresses, is not bound:
  finalization adds a cleanup note and those worktrees are never cleared
  automatically. Finalization still deletes nothing.
- The clearing (`queued-retirement.ts`, new;
  `retireMergedQueuedWorktrees`). `startLoop` now builds a fresh run in
  three steps: `openingTarget` (target and provider inventory),
  `openingLease` once on the validated inventory (it refuses a branch that
  cannot be recorded exactly), then `inventoryAfterQueuedRetirement`, and
  the lease again only when something was removed. So clearing runs inside
  the start's loop and coordination locks, after every start validation
  (harness session, existing run, target, opening remote inventory, exact
  branches) and before the baseline. It runs only for a fresh Queue or
  Sweep start. The report always reaches `LoopStartOptions
  .onQueuedRetirement`, and `loop start` prints it as
  `earlierQueuedWorktrees` (`removed`, `kept`, `notes`), even when empty.
  It never throws.
- Per worktree, in order (`retireOne`): `locate` finds it in the start's
  inventory and compares `readRegistrationId` with the record
  (`registrationOf`); a missing checkout or another registration drops the
  record entry, and the checkout the command runs in, another branch, or
  an unreadable ID waits. `mergedEvidence` asks the recorded address for
  the recorded ref (`askTarget` through `askRemoteRef`, the `ls-remote
  --exit-code` read split out of `remoteBranchHead` in
  `queued-completion.ts`), once per target per start, and only to sort
  merged from unmerged. When the answered commit is not local,
  `fetchTargetCommit` downloads that ref from that address with
  `--no-tags --no-write-fetch-head --no-recurse-submodules
  --no-auto-maintenance`, so only objects arrive and no ref moves; without
  this the feature would rarely fire, since a run starts before it
  refreshes its target. `containmentProof` accepts ancestry
  (`targetContainsRevision`) or `proveExactByteTargetContainment` with a
  nonempty `touchedPaths`. No patch IDs anywhere.
- Check then remove (`removeMerged`, `lastChecks`). `removeProvenWorktrees`
  in `worktree-maintenance.ts` is now exported, generic in its proof
  label, and takes an optional `beforeRemoval` guard that runs after its
  own fresh re-read and immediately before `git worktree remove`. Existing
  callers pass no guard and behave as before. Each worktree goes through
  it alone, one candidate per call, with `lastChecks` as the guard: the
  registration and branch again, a fresh `askTarget` (the proof is
  repeated if the target moved), `claimReason`, `privateGitState`, and
  last `contentBeyondCommit`. `privateGitState` calls
  `assertNoGitOperation` and then checks the `sequencer` directory and
  per-worktree refs itself; the shared `assertNoGitOperation` is
  unchanged, so pause, detach, and ready-work behave as before.
  `contentBeyondCommit` requires an empty `sourceWorktreeDelta` and then
  `filesBeyondHead`, a sorted disk walk against `ls-tree -r` that never
  follows a link, fails on a submodule, an unreadable folder, or a link or
  special file where the commit holds a file or folder, and names up to
  five extras. A link the commit tracks as a link is allowed and compared
  by the delta. The branch is deleted by the remover's existing rule: the
  worktree's own branch, still at the proven head, never the target's
  local branch (the recorded `refs/heads/<branch>` is passed as the
  protected target).
- Reporting. Unmerged worktrees are silent. A merged one that is kept
  gets one sentence in `kept`; for ignored files it is
  `ignoredFilesReason`, the owner's wording. An unanswered remote is one
  note per target. `queuedSummary` and the leftover note in
  `finalizeOwnedLoop` no longer say kept worktrees wait for the owner.
- Known limits, all on the keeping side. A worktree with installed
  packages or build output is reported, not removed. Exact-byte proof is
  against the remote's current target, so a squash merge followed by
  another change to the same paths keeps the worktree; ancestry merges
  are unaffected. A target without one remote address, a run closed by
  `loop end`, and a record that failed to write are never cleared. The
  worktree's own HEAD reflog goes with it, as with `prune`.
- Docs and pins: `cleanup-and-completion.md` gains "A later Queue or
  Sweep start clears merged kept worktrees"; `inventory-and-concurrency.md`
  and `ultra-simple-mode.md` ("Old copies") point at it; the README
  security model lists the behaviour; `skill-contract.test.ts` pins the
  new prose and no longer pins "They stay until the owner asks".
- Tests: `queued-retirement.test.ts` (30) covers removal by ancestry, at
  a Queue and at a Sweep start, and by identical squash; a squash edited
  in indentation; ignored files;
  assume-unchanged and skip-worktree edits; a sequencer left by an
  interrupted cherry-pick; a file or hidden edit written after the
  earlier checks; one worktree removed before the next is checked; a
  record for `upstream/main` against a fork's `origin/main`; a rewound
  remote behind a stale tracking ref; an unreachable remote, at first and
  between the two asks; a merge not fetched yet; a recreated checkout;
  records without the binding; refused starts; Integrate and Ship starts;
  and the command line. Three safeguards were switched off one at a time
  to confirm their tests fail.
- Review: not independently reviewed yet. Guidance stays 33.
<!-- simple-changelogs-signature agent="Claude Fable 5.2 high" at="2026-11-19T18:02:17-06:00" -->

## 0.33.2 - 2026-11-19

- Found by a live smoke of 0.33.1: six agents (Opus 5.5 at high, Sonnet 5.5
  at high, Fable 5.2 at medium, each with the safe defaults and with
  Autopilot) ran "put my change up" or "ship it" in a throwaway site with
  `gitPushAuthorization: "ask"` and a bare local remote. All six pushed
  without a question in chat, and two logged why: `ultra-simple-mode.md`
  told them to describe the upload "when the computer itself asks", which
  read as "the harness asks, so the agent need not". No prompt appeared.
  Under Autopilot, Fable recorded a real review and fast-forwarded `main`
  with no proposal, while Opus and Sonnet stopped.
- `references/ultra-simple-mode.md` Questions gains two paragraphs.
  **Uploads**: under `ask` the person answers in the conversation; a
  request to send a change for review is that answer for the one push of
  the change's own branch; any other push asks first; a harness prompt is
  never a substitute. **No review link**: with no proposal capability the
  run stops at the pushed branch and never integrates, Autopilot or not,
  unless the owner says to. Text only; `skill-contract.test.ts` pins both
  and one eval journey gains a behavior.
- Queue finalization, found the same day in a real repository (GitLab
  remote, finish `open-change-request`): a correct Queue run pushed its
  branch, opened its proposal, and then could not close. `loop finalize`
  had no mode-specific rule: `loopCompletionBlockers` applied the
  run-created-worktree blocker and `repositoryCleanupBlockers` in every
  mode, while `automaticFinalizationCleanup` runs only in
  `AUTOMATIC_CLEANUP_MODES` (integrate, ship, reconcile, resume). So the
  run was told to remove its own pushed worktree, clean the person's dirty
  primary, and delete a target-contained branch that finalization deletes
  by itself in those modes. It relinquished, and every later `loop start
  --mode queue` was refused until an approved `loop replan`.
  New `lib/queued-completion.ts`: `closesAsQueued` (mode queue or sweep
  with no shipment scope) selects the rule, and `assessQueuedWork` reads
  every author registration of the run, live checkout or not
  (`liveVerdict`, `absentVerdict`), as queued, as nothing to queue
  (target-contained), or as a blocker. Queued means: a clean checkout;
  the exact `refs/heads/<branch>` at the push destination answering
  `ls-remote --exit-code` with exactly the head (`remoteBranchHead`,
  `pushedBranch`; a remote-tracking ref only decides whether to ask, and
  no answer keeps the run open); when the target moved since `loop
  start`, a clean `git merge-tree --write-tree` (`movedTargetBlocker`);
  and a proposal bound to the unit (`proposalMismatch`). A live checkout
  must also equal its commit under `sourceWorktreeDelta`
  (`hiddenChanges`), which sees assume-unchanged and skip-worktree edits,
  and the remote must have exactly one push URL (`get-url --push --all`).
  Proposal binding needs no flag. The review ledger binds a proposal to
  commits only, and its head records are closed to unknown members, so
  `proposal record-authors` now also writes the source branch to a new
  file, `proposal-sources.json` (`lib/proposal-sources.ts`,
  `proposal-sources.schema.json`): the one local branch at the recorded
  head, or `--source-branch`, which must point at exactly that head, with
  the remote branch it tracked. `boundProposals` accepts the single
  proposal whose source is the queued branch at the queued head, whose
  `latestRecordedHead` in the ledger is exactly that head, and whose
  recorded base the target contains; none or several keeps the run open.
  `loop finalize --queued-proposal <branch>=<id>` (`queuedDeclarations`)
  names one explicitly and must pass the same checks, so two proposals at
  one head cannot be swapped and nothing matches by SHA alone or descent.
  `--no-proposal TEXT` covers a remote with nowhere to open one and is
  ignored when `proposalForge` finds a `github`, `gitlab`, or `codeberg`
  provider. An unresolved target is a blocker in the assessment itself.
  `finalizationDecision` hands the assessment to `loopCompletionBlockers`
  as a `CompletionBasis`: `runWorktreeBlockers` returns the assessment's
  blockers in place of the worktree blocker, and
  `repositoryCleanupBlockers` is skipped. That function is now
  `primaryAndTargetBlockers` plus `containedCleanupBlockers`; for a queued
  close the second becomes cleanup `notes` and `cleanupStatus: pending`
  (`queuedLeftovers`, `housekeepingPending`), and the first does not
  apply, so the primary checkout is never touched or required clean.
  Design choice: nothing in a Queue or Sweep start or finalize deletes a
  worktree, branch, or file. The run's own worktrees are kept and listed
  in the receipt's `queued.keptWorktrees`; they stay until the owner asks
  to clean the repository through Reconcile or `prune`, which ask first.
  Automatic clearing of merged queued copies was built twice (at
  finalize, then at the next `loop start`), failed review both times, and
  is deferred. No existing state file changes shape: the lease and the
  ledger are untouched, and the receipt gains an optional `queued` member
  (`status: queued-for-review-not-merged`, with `deliveryStatus` still
  `unverified`). `queuedRunGuidance` replaces "record its outcome" in
  `loop status` for these runs. Known gap: a later run can
  propose the same unchanged content from the primary checkout again
  without being told it is already queued. Ship, Integrate, Reconcile, a
  scoped Queue run, and `loop end` are unchanged. Covered by
  `queued-finalization.test.ts`: the Queue close and a second `loop
  start`, a proposal found with no flag, every case that still blocks, a
  kept worktree that holds an ignored file, and Integrate and Ship still
  relinquishing on the same repository.
- Review: the text rules above were not independently reviewed, because
  the owner ended review rounds for this line on 2026-11-18. Queue
  finalization had two reviews by gpt-6.2-astra at high effort; the first
  found 2 blocking and 9 should-fix, the second 3 blocking and 4
  should-fix, all blocking findings were in automatic removal, which was
  removed; the remaining fixes were not re-reviewed. Guidance stays 33.
<!-- simple-changelogs-signature agent="Claude Fable 5.2 high" at="2026-11-19T15:50:00-06:00" -->

## 0.33.1 - 2026-11-18

- Scope and numbering (issue soundsystems/simple-changes#35): this release
  ships from `main` ahead of the unmerged `release/0.34.0` branch, which
  dates from 2026-10-29. Releases are numbered `0.<guidance>.<patch>` and
  guidance stays 33 here, so this is 0.33.1 whatever it adds; the entry
  was drafted as 0.34.0 until a review pointed at that rule. The unmerged
  branch keeps its number and its guidance 34 and picks up this release
  when it merges `main`.
- Communication sidecar (new `lib/communication.ts`):
  `.simple-changes-communication.json` at the primary checkout or a
  personal `communication.json` beside `preferences.json`, holding
  `{ "schemaVersion": 1, "style": "ultra-simple" | "standard" }`. It is
  not a policy key because older copies enforce the policy file's closed
  schema; they ignore the sidecar and keep the standard voice.
  `readCommunicationFile` uses `lstat`, so a dangling symbolic link is an
  unusable file, never an absent one, and reads only the two members, so a
  later release can add one. `resolveCommunication` reads every layer,
  takes the first usable one of personal, repository, then `companion`
  (the repository's `.simple-changelogs-communication.json`), otherwise
  `standard`, and reports every unusable file in `errors`. The personal
  layer outranks the repository's, unlike policy, because the style grants
  nothing.
- Standalone setup (`runCommunicationSetup` in `simple-changes.ts`):
  `setup --communication <style> --scope repository|personal --confirm`
  refuses every other setup input, `--migration-target`, `--authoring`, a
  run-only scope, and a missing `--confirm` with exit 2, then calls
  `writeCommunication`: stage and install, 0644 for the repository and
  0600 for the personal file, no write when the style is already saved,
  and exit 5 for a file it cannot read or that is not a regular file. A
  file with members this version does not know is never rewritten:
  parsing and writing it back can alter a value, as it does an integer
  above 2^53. A new file is installed with
  `installWithoutReplacing` (`lib/path-safety.ts`: a hard link, or an
  exclusive copy where links are unavailable), so two first saves cannot
  both win; once installed the file is saved, and a failure to remove the
  staged name is not reported as a failed save. The command also refuses
  `--dry-run`, `--ui-artifacts`, and `--acknowledge-push-scope` before it
  resolves a destination or takes a lock, and every other command refuses
  `--communication` (`assertCommunicationApplies`), so `initialize` can
  never carry it into the setup writer. A repository write holds the same setup
  lock as `setup --authoring`; a personal write touches no repository
  state and takes none. Its summary says what was saved for the scope and,
  when another file decides, which one.
- `initialize` reports `communication` (`style`, `source`, `path`,
  `errors`) in every mode, and `initialization.schema.json` gains the
  property. Nothing else reads the style: a test asserts that
  `initialization.ts` (a type import) is the only library module that
  imports `lib/communication.ts`, so no rule can use it to decide what is
  allowed.
- No first-time shortcut. An outcome-led first screen whose one yes saved
  the recommended setup and the style was built three ways (a
  `setup --quick-start` command, a terminal first screen with a
  two-command recipe, then a `setup --first-use` precondition on the setup
  writer), and four review rounds found the same three kinds of defect in
  each: replacing a setup saved meanwhile, a partial save, and a failed
  Git probe read as "not a repository". A fresh claude-opus-5-5 decider at
  high effort judged the approach the problem: the setup writer saves the
  policy, its trust receipt, instruction files, and the style with no
  transaction, and personal saves share no lock, so no precondition makes
  that sequence all-or-nothing. The owner cut it. `lib/onboarding.ts`,
  `lib/policy.ts`, and the setup path of `simple-changes.ts` are
  byte-identical to 0.33.0, and soundsystems/simple-changes#37 records
  what a second attempt needs first.
- Guidance text: new `references/ultra-simple-mode.md`.
  `references/user-communication.md` gains Say less, Keep work moving, and
  Messages to other agents, its questions rules defer to the saved
  `questions` preference, and final responses report an existing preview
  link and a before and after picture. `references/onboarding.md` gains two
  pointers and is otherwise unchanged: setup is the same under the mode.
  `references/setup-and-policy.md` gains Communication preference,
  `change-requests.md` a default naming paragraph, and
  `migrations-and-high-risk-actions.md`, `ship-communication.md`, and
  `inventory-and-concurrency.md` one pointer each. Autopilot is text only: a
  name for `defaultFinish: "ship"` with `productionDeploy: "allow"`, saved
  through the existing setup and its trust receipt. Its text describes the
  saved `handoffTiming` (including `automatic`, which asks nothing) and the
  saved `shippingMode` (a break-glass order can deploy before review), and
  never promises more. In the mode the database question saves the existing
  `auto-apply-reviewed-routine` setting for one exact target; it offers no
  one-time apply, because `migration apply` accepts only an `auto-apply`
  decision. No decision or apply code changed.
- `SKILL.md` budget: 17,499 of 17,500 bytes. The Communicate section
  gained two sentences, paid for by shorter wording of the command alias
  in the introduction, the two anchor links in workflow step 2, the
  permission-checklist sentence, and by dropping "(see onboarding)" after
  the run-only `--policy-request` rule. No pinned sentence changed.
- Tests: new `communication.test.ts` covers resolution, unusable files,
  writes, and the command line. With a trusted policy that allows production
  and routine automatic migrations, turning the mode on leaves the policy
  and its trust receipt byte-identical and every authority field
  `initialize` reports unchanged; with the same policy untrusted, no trust
  receipt appears and authority stays reduced. `skill-contract.test.ts` pins
  the new copy in two tests, and nine journeys in `evals/cases.json` cover
  setup with the mode on, repeat use, a routine database update on a saved
  and on an unapproved target, a partial run, one unit waiting for approval,
  Autopilot reaching and not reaching Ship, and a visible change with a
  preview.
- Guidance stays 33. A bump would stop the next write-capable run in every
  configured repository with an update notice for a mode that is off by
  default and rules that need no decision.
- Lifted from the unmerged 0.34.0 line with `cherry-pick -x`: the Git 2.53
  fixture and ship-hold fixes (`fix/0-34-0-git-2-53-compat`: d83bd03,
  b03af77, f1c12b4), the lineage fixes for soundsystems/simple-changes#20
  and #26 (`fix/0-34-0-lineage-keeps-work`: 7143fbf, 5edd153), and the
  upstream hold fixes for #19 and #27 (`fix/0-34-0-remote-prune-holds`:
  76c46d3, 8770761, 98dbe3e, 5abf468, f04a224). All three branch from the
  same `main` commit as this release. Each makes cleanup keep more, never
  delete more. Without d83bd03, `bun run check` cannot pass on Git 2.53
  or later.
- Two lifted fixes changed during review, and the unmerged 0.34.0 line
  needs both changes when it merges `main`:
  - `deleteRemoteRef` (`lib/ship-holds.ts`): `goneBeforeDelete` replaces
    `refKept`. A failed delete is considered withdrawn only when the push
    itself says this exact ref was already gone. Git's own status line for
    the ref decides whenever there is one: `! [remote rejected] <ref>
    (reference does not exist)` is the only reason that counts, and any
    other reason, such as a declined hook, keeps the withdrawal pending
    whatever else the remote printed. Only without a status line may an
    older Git's bare `unable to resolve reference '<ref>'` count. The
    lifted rule
    treated every rejection except a short list as possibly gone and let
    `ls-remote` settle it, but a host can hide a ref from listings
    (`uploadpack.hideRefs`) and still decline its deletion, which read as
    withdrawn and was never retried. A declined delete now stays pending
    whatever the listing shows, and the retry settles it, because deleting
    a ref that is by then absent exits 0. The pattern matches only the
    status line, so the same words in a remote hook's message, which
    arrive behind `remote:`, prove nothing.
  - `trackedProviderBranches` (`lib/remote-branch-prune.ts`) returns Git's
    upstream and every configured `branch.<name>.merge` value together.
    The lifted fix returned only Git's upstream when Git gave one, so with
    two merge values the second branch, which 0.33.0 held, was proposed
    for deletion.
- Known gap, filed as soundsystems/simple-changes#36 and unchanged from
  0.33.0: upstreams and configuration are read from the primary checkout
  only, so an upstream that only a linked worktree's configuration defines
  (a branch-conditional include, or `extensions.worktreeConfig`) is not
  held.
- Review: gpt-6.2-astra at high effort. Round 1 found 2 blocking and 10
  should-fix defects. Round 2 found 1 blocking and 12 should-fix and
  reopened five round 1 items. Round 3, over the full range, found 12
  should-fix defects, eight of them in first-use setup. Round 4 found 9,
  five of them there again, which led to the decider and the cut above;
  the other four (the status-line rule, two Autopilot sentences, and the
  receipt wording that left with the cut) are fixed as described.
<!-- simple-changelogs-signature agent="Claude Fable 5.2 xhigh" at="2026-11-18T23:07:00-06:00" -->

## 0.33.0 - 2026-10-24

- Git location guard (new `lib/git-location.ts`, proposal "Fail closed on
  inconsistent shared review-ledger location"): `gitReportedPath(output,
  question, context?)` moved here from `inventory.ts` and also refuses a
  NUL byte. `verifiedGitDirectories(root, answers, repository)` turns
  Git's raw answers into real paths and refuses unless the common
  directory exists, is not the checkout root, and is a repository Git
  directory (`HEAD`, `objects`, `refs`, no `commondir`), the checkout's Git
  directory is the common directory or a linked worktree directory whose
  `commondir` resolves to it, and a `.git` entry, when present, points at
  that directory (parsed as Git does: the text after `gitdir: ` with only
  trailing line ends removed). `assertStateDestination` checks the common
  directory and that `<common>/simple-changes`, if present, is a plain
  directory; `ensureStateDirectory(common, directory)` and
  `ensureStateDirectoryOf(directory)` create state directories one
  component at a time without following links and refuse a link, a
  non-directory, an inspection error other than ENOENT, or a path outside
  `<common>/simple-changes`. Refusals exit 4 (`inventory`) and end with a
  `Diagnostics:` line (Git executable, working directory, repository, raw
  `--absolute-git-dir` and `--git-common-dir` answers, each JSON-quoted
  and cut to 240 characters). `isCommonGitDirectory` and
  `gitLocationDiagnostics` are exported.
- `inventory.ts`: `locateRepository` and `captureInventory` resolve
  through `repositoryDirectories`, which verifies every answer;
  `locateRepository` now asks `rev-parse --is-bare-repository
  --absolute-git-dir --git-common-dir` in one call (same call count), and
  answers lose only trailing line ends. Every state writer that used
  `mkdirSync(..., { recursive: true })` under the state directory now uses
  the contained helpers: the loop lock and lease, controller binding,
  receipt sidecars, recovery and replan history, coordination, takeovers,
  ready receipts, ship holds, cleanups, policy trust, work-directory
  bindings, migration authorizations, and the review ledger
  (`loop-lease-core.ts`, `loop-lease-recovery.ts`,
  `worktree-coordination.ts`, `ready-work.ts`, `ship-holds.ts`,
  `worktree-maintenance.ts`, `policy.ts`, `work-directory.ts`,
  `migration-automation.ts`, `review-ledger.ts`). `withLedgerTransaction`
  calls `assertStateDestination` before the loop lock. Left alone on
  purpose: `status --all` (reads `.git` files, read-only),
  `update-local-forks` (uses the answers only to detect a linked
  worktree), and `tooling/merge-gate` (already refuses a non-absolute
  answer). The remaining recursive `mkdirSync` calls (policy files,
  authoring sidecar, `harness-session.ts`, `turn-guard.ts`, `fork.ts`, the
  GitLab raw inventory) write outside `<common>/simple-changes`.
- Lost Git answers (`process.ts`): new `gitAnswerIsRequired(args)` names
  the read-only questions that always have an answer (`rev-parse` paths,
  booleans, and revisions, `symbolic-ref` reads, `config --get`,
  `remote get-url`, `worktree list`). `runGit` asks again once on exit 0
  with zero bytes and then throws a retryable `SimpleChangesError` (exit
  4) with bounded diagnostics; `runGitConcurrently` re-runs such worker
  results through `runGit`. The cause was seen under load (about 286 to
  386) but not reproduced: Bun 1.3.14 `spawnSync` reports a signal-killed
  child as `exitCode: null`, and 3,600 direct and 3,600 worker
  `rev-parse --show-toplevel` calls at load 386 returned no empty answer,
  so the change fails closed instead.
- Listings that may legitimately be empty, integration d28046f and
  4a5b668: `exact-byte-proof.ts` refuses an empty `rev-list base..head`
  when base differs from head, confirms an empty per-commit `diff-tree`
  with `diff-tree --quiet` and an empty tip-to-target `diff --name-only`
  with `diff --quiet`, refusing on exit 1; `source-worktree-delta.ts`
  fails "its index cannot be read" on an empty `ls-files --cached
  --others --exclude-standard` beside a non-empty HEAD tree;
  `targetTreeEntry` confirms an empty `ls-tree` with
  `rev-parse --verify --quiet <rev>:<path>` and refuses with exit 4 when
  the path exists. New `lost-answer-proofs.test.ts` (a fake Git on `PATH`
  loses one answer).
- Test isolation (08d4ae3, session sc-preserve-cleanup):
  `tooling/simple-changes/tests/preload.ts` clears inherited
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_DIR`,
  `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_QUARANTINE_PATH`, and
  `GIT_WORK_TREE`, sets `GIT_CEILING_DIRECTORIES`, and moves the test
  process into an empty temporary directory, so a test that falls back to
  the working directory fails instead of reading the host repository.
  `review-ledger.test.ts` (reviewer resolution) and
  `proposal-signatures.test.ts` use fixture repositories, and an empty
  `rev-parse --show-toplevel` is refused through `gitReportedPath`. New
  `test-isolation.test.ts` and `git-location.test.ts` (linked-worktree
  resolution, seven wrong `--git-common-dir` answers through a fake Git,
  a `.git` entry for another worktree, bounded diagnostics, symlinked and
  unreadable state directories, a line break inside a Git directory path,
  and the lost-answer table and re-asks).
- Finalize policy (`loop-lease-finalize.ts`, proposal "Preserve approved
  policy and retire semantically equivalent authors"): new
  `trustBoundPolicyPaths(primaryCheckout, commonGitDirectory)` in
  `policy.ts` returns `.simple-changes.json` plus any primary-relative
  `policyPath` the trust receipt names.
  `reconcileTargetEquivalentPrimaryChanges` takes `targetBranch` and
  returns `CarriedPolicyPaths | null`. `withoutPolicyPaths` always removes
  policy paths and their rename partners from the restore set; when every
  other dirty path normalizes and `primaryCanFastForwardInPlace`,
  `stagePolicyPathsAtTarget` (`git restore --source=<target> --staged`,
  index only) lets `fastForwardCleanPrimary` (now `--no-autostash`,
  optional `carried`) carry them unwritten, and `settleCarriedPolicyPaths`
  notes the result and returns an entry this run staged to its old HEAD
  entry when the fast-forward did not land. Every path-taking Git call in
  primary normalization (`diffMatchesRevision`,
  `indexHasOnlyOrdinaryEntries`, each `git restore`) runs with
  `--literal-pathspecs`. New non-blocking notes ("Kept <path> in the
  primary checkout byte for byte: ...", "Carried <path> through the
  fast-forward to <target> without rewriting it; ...") and a cleanup error
  when staging fails.
- Run-created retirement (new `lib/exact-byte-proof.ts` and
  `lib/run-created-retirement.ts`):
  `proveExactByteTargetContainment(repositoryPath, { sourceHead,
  targetRevision, sourceBase?, maxCommits? })` is read-only and proves
  that every path a commit in `sourceBase..sourceHead` touched has the
  same tree entry at the tip and the target (per-commit `diff-tree
  --no-renames`, one `diff --name-only --no-renames`); it refuses an
  unresolved revision, no merge base, a base that is not an ancestor of
  both, a merge commit, more than `EXACT_BYTE_PROOF_MAX_COMMITS` (200), or
  any differing path, and proves byte containment only, never origin.
  `retireAbsentWorktree` (`loop-lease-recovery.ts`) branches to
  `retireRunCreatedWorktree` for a run-created `author` or `preserved`
  registration and writes
  `history/<run>/run-created-retirement-<sha256>.json` (`kind:
  "run-created-retirement"`, `schemaVersion: 1`, `runId`, `retirement`
  with `proof { baseRevision, commits, method: "exact-byte-target",
  touchedPaths }`); a record applies only when its name matches its
  digest and the branch still points at `branchHeadSha`
  (`currentRunCreatedRetirement`). `proveNothingLeftToShip`,
  `recoverPostCleanup`, and `retiredAbsentPaths` (`loop-lease-verify.ts`)
  honor it; `removeTargetContainedBranches` and
  `repositoryCleanupBlockers` skip `retirementBackedBranches`. New
  `missingObligatedWorktree` message helper points close-equivalent at
  `loop retire-absent-worktree`. Integration 34e3344 refuses either kind
  of retirement for a held unit's source.
- Preserved-source handoff (new `lib/preserved-source-handoff.ts` and
  `lib/source-worktree-delta.ts`, proposal "Reconcile reviewed detached
  preserved source"): `preservedSourceHandoffFailure(context, recordedAt)`
  is the pure check (registration, supported-source contract, ownership,
  approval, review, binding, paths, copy provenance);
  `sourceWorktreeDelta(sourceWorktree, headRevision, symlinkEntry)` reads
  a checkout's changes against HEAD from the file system, hashing regular
  files with `git hash-object` in batches of 200 and taking modes from
  their own executable bits, never from status or index flags. In
  `preserved-source-override.ts`, `composeShipmentOutcome(receipt,
  overrides, handoffs = [])` allows one kind per unit,
  `splitShipmentOutcomeInput` also returns `handoffs`, and
  `recordedPreservedSourceOverrides` is replaced by
  `recordedPreservedSourceEvidence(overrideSidecar, handoffSidecar, runId,
  receipt, digest, holdDigests = [])` returning `{ handoffs, overrides }`.
  `loop-lease-shipment.ts` adds `handoffCopy` (`rev-list --parents`,
  `diff-tree`, `merge-base --is-ancestor`, `ls-tree`) and the exported
  `preservedSourceHandoffIssue`; the approval flags must match every
  override and handoff ("Manual approval flags require a preserved-source
  override or handoff in the outcome."). `storedPreservedSources` and
  `preservedSourceIssue` feed the completion blockers,
  `hasVerifiedDelivery`, and `recordedOutcomeIntact`. New
  `PRESERVED_SOURCE_HANDOFF_DIRECTORY`, types
  `PreservedSourceHandoffReceipt` and `PreservedSourceHandoffRecord`, and
  schema `preserved-source-handoff.schema.json`; the sidecar
  `<common>/simple-changes/preserved-source-handoff/<run>.json` is written
  only when the outcome has a handoff and removed otherwise. The outcome
  digest without handoffs is unchanged. Docs: "Preserved-source handoff"
  in `references/focused-units.md`.
- Bounded lock waits (`loop-lease-core.ts`): new
  `withLoopStateLockBounded(commonGitDirectory, operationName, operation,
  wait?)`, exactly `withLoopStateLock` without `wait`, and
  `LoopLockWait`, `LoopLockWaitOutcome`, `LoopLockWaitReport`,
  `LoopLockOwnerSummary`, `LoopLockWaitError` (exit 5, carries
  `lockWait`), `LOOP_LOCK_WAIT_DEFAULT_MS` (60000), and
  `LOOP_LOCK_WAIT_MAX_MS` (600000). It polls every 100 ms plus up to 100
  ms of jitter with an `Atomics.wait` sleep, checks the deadline before
  every acquisition, and ends early for a dead owner (only when the lock
  still holds that owner's token after the liveness check), for a caller
  inside the owner (owner or recorded child PID is an ancestor, or the
  same recorded process group, from one cached `ps -A -o pid=,ppid=,pgid=`
  read), and, when the process list cannot be read, for an owner running
  a child. `withLedgerTransaction` takes optional `wait` and skips
  `assertOutsideLoopExec` only then; `recordShipmentScope`,
  `recordShipmentOutcome`, and `ReadyWorkOptions` take `lockWait`. CLI:
  `--wait-lock` and `--timeout-ms` (`LOCK_WAIT_COMMANDS`,
  `assertLockWaitApplies`: usage exit 2 for `--timeout-ms` alone, another
  command, or `worktree release` without `--ready-receipt`), and `runCli`
  adds `lockWait` (`executed: false`, `operation`, `outcome` of
  `timed-out`, `owner-not-running`, `caller-inside-owner`, or
  `caller-ancestry-unknown`, `owner`, `timeoutMs`, `waitedMs`) to the JSON
  error. Test switch `SIMPLE_CHANGES_TEST_PROCESS_LIST=unavailable` under
  `NODE_ENV=test`. Docs: "Bounded lock waits" in
  `references/inventory-and-concurrency.md`.
- Held units (new `lib/held-units.ts` and `lib/loop-lease-hold.ts`, issue
  #4): `holdScopedUnit` observes, and with approval re-observes under the
  loop and coordination locks, pins the head at
  `refs/simple-changes/held/<run>/<unit>`, writes
  `<common>/simple-changes/held-units/<run>.json` (schema `held-units`,
  `HELD_UNITS_DIRECTORY`), the lease key `heldUnits: { holdsDigest }`, and
  an immutable `history/<run>/held-unit-<hold digest>.json` event.
  `readinessEvidenceFailure` requires `<unit id>:` attribution.
  `readHeldUnits` validates the sidecar, each hold's `holdDigest` and
  `observationDigest`, its unit, source, path, and exclusion binding, the
  unit against the frozen scope, every history event, and the lease key;
  `assertHeldScopeConservation` keeps every original scope path delivered,
  preserved, or excluded exactly once. `loop-lease.schema.json` gains
  optional `heldUnits` (user-approved exception to the new-file rule, for
  held runs only); the pinned 0.22.0 lease-schema test allows exactly that
  key. `boundOutcomeDigest` binds the holds into the outcome digest
  (unchanged without holds). `loop-lease-shipment.ts` refuses a held unit
  in `units` and requires only unheld ones; `shipment-outcome-draft.ts`
  omits held units and adds held-path warnings and `summary.heldUnits`.
  `loop-lease-finalize.ts` feeds `heldProtection` to every cleanup step,
  skips primary synchronization for a held primary, stops all automatic
  cleanup on an unreadable hold record or a changed outcome digest, adds
  held, omitted, and all-held pinned-target blockers, and adds optional
  receipt `heldUnits[]`. `assertNoHeldUnits` guards
  `closeLoopTargetEquivalent` and `recoverPostCleanupLoop`. CLI
  `loop hold-unit` with `--readiness-evidence` (repeatable, at most 20,
  500 characters each) and `--observation-digest`; record-scope,
  refresh-scope, record-outcome, and hold-unit dispatch moved into
  `runLoopShipmentAction`. Integration 7ddc71d adds
  `recordedHeldSourcePaths(commonGitDirectory)` and passes it as
  `keepPaths` from `standaloneWorktreeCleanup`, so a later
  `worktree cleanup` keeps a removed held checkout's claim; an unreadable
  record releases no absent claim and adds a cleanup error.
- Held-unit limits: the "already in the target" rule counts a unit only
  when every path matches its opening entry and each original path of its
  own renames that is not an opening change of its own is absent from the
  target, and `loop hold-unit` refuses and asks for a replan when such an
  original exists again (82400bd, 7b7fcd3, 5446e43). A unit that shares a
  non-primary source checkout with a held unit cannot be verified
  delivered while the held bytes keep it dirty. Deferred by the user:
  `loop record-outcome` still accepts `delivered` for an unheld
  primary-packaged unit whose reviewed target result differs from its
  opening bytes.
- Replan delta (new `lib/replan-approval-delta.ts`, issue #18 item 3):
  `ReplanObservation`, `replanApprovalDelta(approved, current,
  worktrees)`, `replanDeltaAccepted`, and `describeReplanDelta` compare
  claims by ID (a release moves its claim to the end), require events to
  extend the approved list exactly, and require receipts unchanged.
  `worktree-coordination.ts` exports `isLiveClaimState` and
  `releaseEventRecordedState(claimId)`. `loopReplanStatus` stores
  `history/<run>/status-observations/<status digest>.json` (content
  addressed); `createReplanIntent` checks the manifest digest first, then
  loads the stored approved observation, computes the delta, and refuses
  with it unless accepted; `archivePendingReplan` re-proves the delta at
  the move and publishes `replan-approval-delta.json` (also under
  `archive-recorded-<digest>/`) before the atomic lease move, and every
  later read re-derives `acceptedReleases` from the intent's observation,
  the recorded current observation, and the recorded inventory text
  (`inventoryDigestInput`, new in `inventory.ts`, same bytes as before).
  `replanLoop` returns `LoopReplanResult` with optional `approvalDelta`.
  Integration 5bce4f8 and fa117ae: `publishReplanFile(path,
  commonGitDirectory, value, replace = false)` creates its directory with
  `ensureStateDirectory`. Refusal prefixes are unchanged. Docs:
  `references/recovery.md`.
- Reviewer room (new `lib/reviewer-room.ts`, issue #17):
  `reviewerRoom(input)` reads Git, the ledger, and the authoring
  resolution and writes nothing; `parseWouldAuthor`,
  `parseVerifiedRoute`, and `renderReviewerRoom`. A route is ruled out
  only by a proven same model ID in the same harness; a display name, an
  ID differing only by trailing effort words (stacked ones included), a
  review model that is not an ID (`most-capable` included), an attested
  author with neither instance nor session, a named proposal with no
  recorded head and no range, an unattributed commit, a malformed ledger,
  or a sidecar needing repair leaves it `unknown`, and a `null` harness
  entry rules it out. `review-ledger.ts` exports `targetDistinctness`,
  `ReviewerTarget`, and `primaryCheckoutOf` unchanged. CLI
  `reviewer room` under `withReadOnlyGit`, with repeatable
  `--would-author` and `--verified-route`; `skill-check.ts` adds
  `reviewer-room.ts` to the vendor-neutral files. The room is stricter
  than the post-return gate (effort-word IDs, no coverage waivers), which
  is unchanged. Docs: `review-and-merge.md`,
  `inventory-and-concurrency.md` delegation step 1, and
  `setup-and-policy.md` (`--authoring-request`). 19efbf3 reads
  `git status --porcelain` outside the test's write snapshots, which
  removed a load flake from the "writes nothing" test.
- Agent instance identity (`harness-session.ts`, new
  `lib/identity-receipt.ts`, branch
  `fix/0-33-0-agent-instance-identity`): `currentHarnessSession` no longer
  picks by a fixed order. New `harnessSessionsIn`, `resolveHarnessSession`
  (statuses `none`, `detected`, `selected`, `ambiguous`, `mismatch`),
  `requireHarnessSession(command, environment, requested)` (exit 2 on
  ambiguity, exit 5 on a `--harness` with no session variable),
  `selectInvocationHarness` (kept in the process for one command, never in
  an environment variable a nested harness would inherit),
  `ambiguousSessionMessage`, `mismatchedSessionMessage`,
  `isSessionHarness`, and `isHarnessSessionId`. The CLI runs one identity
  preflight in `executeCommand` before dispatch (`invocationHarnessFor`,
  `checksSession`, `SESSION_COMMANDS`): `author attest`,
  `proposal record-authors`, `worktree claim`, `takeover`, `pause`,
  `detach`, `attach`, `release`, `initialize --mode handoff --agent-id`,
  every `loop start`, `loop takeover`, a `loop turn-check` without
  `--hook`, and `workdir` inside a run ask before any lock or directory.
  Elsewhere an unclear session counts as none: the Stop hook allows the
  turn and `refreshControllerSession` keeps the recorded binding.
  `--identity-receipt JSON|@FILE` (schema `identity-receipt`:
  `schemaVersion` 1, `harness`, `session`, `model`, optional `instance`
  and `parentSession`, no other keys) is checked by `parseIdentityReceipt`
  and `receiptSession` against the environment and every `StatedIdentity`
  argument (`--harness`, `--session`, `--agent`, `--instance`) on any
  command, exit 2 on conflict, and is never stored. `review-ledger.ts`:
  `executingIdentity` takes the command name and an optional
  `identityReceipt`, `proposal record-authors` now passes `--harness`, and
  `executorIndependence` compares instances first, then sessions, so the
  same instance is `reviewer-not-independent` under any session, harness,
  or model (also with `adversarial: true`), while the same model in
  another instance is independent. No check became more permissive; the
  setup reviewer-model question still refuses the author's own model under
  "A different model in the same agent", with new wording
  (`authoring-onboarding.ts`). `skill-check.ts` lists
  `identity-receipt.ts` and its schema as vendor neutral. Docs:
  `change-requests.md`, `inventory-and-concurrency.md`,
  `review-and-merge.md`, `onboarding.md`.
- Renamed changelog providers (`changelog-coordination.ts`): new
  `markedRepositoryProviders(repositoryRoot)` skips a
  `REPOSITORY_SKILL_ROOTS` entry whose real path leaves the repository,
  lists direct children of the rest except installation names, and keeps
  `<child>/SKILL.md` only when the folder, `SKILL.md`, and marker all stay
  inside the real repository root (`staysInside`, settled before any
  marker is read) and `readProviderMarker` accepts the marker.
  `inspectChangelogCoordination` appends them after installation-name
  repository candidates and before global ones, under the unchanged
  stable handoff-capable sort. `uniqueByRealPath` keys on the installation
  folder's real path, so two folders whose `SKILL.md` files link to one
  file stay two installations. `providerDistribution` falls back through
  `installationDistribution`, which reads only own keys of
  `DISTRIBUTION_BY_INSTALLATION` (a folder named `constructor`,
  `__proto__`, or `toString` reports `null`). Global roots still match by
  installation name only.
- Remote-branch prune gap (new `lib/remote-branch-prune.ts`):
  `mergedHeadDeletionCandidate(entry, targetBranch)`;
  `remoteBranchHolds({ claims, inventory, targetBranch, targetRevision })`
  collects holds by name and by fork-point revision and throws in a
  shallow clone; `remoteBranchNameHolds` holds the upstream of every live
  branch, the target's included, read by `trackedProviderBranch` from
  `branch.<name>.remote` and `branch.<name>.merge` (falling back to the
  full `%(upstream)` refname, never `%(upstream:short)`); `mayBeShallow`
  counts anything but an explicit "false" as shallow; and
  `remoteBranchCleanupReport` applies holds, settles ancestry and the
  merge base itself, then runs patch equivalence on that base
  (`commitEquivalenceAgainstTarget` takes an optional `mergeBase`).
  `remote-inventory.ts`: pages may carry `openProposalTargets` (known only
  when every page lists them and each names every open proposal it
  carries), the final build takes `resolveHolds` and adds
  `deletionProposals` and `heldBranches`, `presentDecisionProposal` builds
  the entry exactly as `deletedEntry` will record it and judges it with
  the receipt validator, and `assertDecisionsUsed` accepts approved
  present branches. `remote-branch-reconciliation.ts` splits and
  validates the top-level `openProposalTargets` and adds
  `openProposalTargetsForReceipt` and `validateLedgerBranchEntry`.
  `loop-lease-remote.ts` writes or removes
  `remote-branch-open-targets/<run>.json`, bound to the receipt digest.
  `finalizationDecision` adds receipt `remoteBranches` (`pending`,
  `held`, `openProposalTargets` of `recorded` or `unknown`, `errors`);
  any pending entry or error makes `cleanupStatus` `pending` without a
  blocker. The GitLab fetcher lists every open or locked MR with its
  `target_branch`, forks included. New schema
  `remote-branch-open-targets.schema.json`; `remote-inventory-pages`
  adds optional `openProposalTargets`. Docs: `cleanup-and-completion.md`
  ("Deletion proposals and held branches") and `providers/gitlab.md`.
- Known limit, issue #19: `trackedProviderBranch` reads the last of
  several `branch.<name>.merge` values while Git uses the first, so a
  hand-added second value can turn the really tracked branch into a
  deletion proposal and a pending report. The fix (use
  `%(upstream:remotename)` and `%(upstream:remoteref)`, falling back to
  holding every value) is in the issue.
- Branches deleted outside the run (branch
  `fix/0-33-0-rebaseline-and-external-deletes`): `deletedEntry` in
  `remote-inventory.ts` no longer throws for a deleted opening branch with
  no merged proof and no decision; it records classification `ambiguous`,
  disposition `deleted-proven-obsolete`, `obsoleteProof: null`, and the
  input key `externalDeletion: { lastHeadRevision }`, and the final build
  summary gains `externallyDeletedBranches` (`[]` on an opening build). A
  deletion while a proposal is still open still stops the build.
  `remote-branch-reconciliation.ts` adds `isExternalDeletionShape`,
  `validateExternalDeletion`, `externalDeletionsByBranch`,
  `externalDeletionsForReceipt`, `splitExternalDeletion`, and
  `splitSupersession`; `validateRemoteBranchReconciliation` takes
  `externalDeletions` as a fourth argument, and an external deletion must
  name the exact opening head, have no final ref or open final proposal,
  and cannot combine with ancestry proof or a supersession.
  `recordRemoteBranchReconciliation` (`loop-lease-remote.ts`) pins each
  last head `git cat-file -e` finds at
  `refs/simple-changes/external/<run>/<head>/<ms>` (`<ms>` is when the pin
  was made) unless a pin of the run already keeps it, then writes the
  immutable per-receipt record
  `remote-branch-external-deletions/<run>/<receipt digest>.json` (schema
  `remote-branch-external-deletions`); a failed `update-ref` refuses the
  record and leaves nothing. `receiptSidecarPath`, `readReceiptSidecar`,
  and `writeReceiptSidecar` take an optional receipt digest. The
  finalization receipt gains `remoteBranches.deletedExternally [{ name,
  lastHeadRevision, pinRef, pinExpiresAt?, note }]`, which makes
  `cleanupStatus` pending without blocking the close. `finalizeLoop` runs
  `pruneExpiredExternalDeletionPins` for every closed run and adds the
  unpersisted `expiredExternalDeletionPins { removed, errors }` when it
  touched a pin; `remote-branch-prune.ts` adds
  `EXTERNAL_DELETION_REF_PREFIX`, `EXTERNAL_DELETION_PIN_RETENTION_DAYS`
  (14, fixed), `externalDeletionPinRef`, `parseExternalDeletionPin`,
  `listExternalDeletionPins`, and `liveExternalDeletionPin`, which checks
  each pin live. `renderRemoteBranchCleanup` and the new
  `renderExpiredExternalDeletionPins` print the branches and removed pins
  in the plain finalize output. Test-only
  `SIMPLE_CHANGES_TEST_FAIL_BEFORE_RECONCILIATION_LEASE_WRITE` under
  `NODE_ENV=test`. Docs: `recovery.md` and `cleanup-and-completion.md`
  ("Branches deleted outside the run").
- Rebaselined late arrivals (`loop-lease-finalize.ts`): new
  `rebaselinedPaths(lease)`; `automaticCleanupCandidates` skips those
  paths (live removal, stale metadata pruning, finalize, and
  close-equivalent all use it) and `repositoryCleanupBlockers` skips them
  in the contained-worktree blocker, as `references/recovery.md` already
  promised. A rebaselined checkout whose directory is gone is not a
  candidate, so stale metadata pruning defers as for any unaudited missing
  checkout.
- Replacement lineage (new `lib/replacement-lineage.ts`, proposal
  "Support reviewed replacement lineage in worktree cleanup"):
  `parseReplacementLineageReceipt`, read-only `verifyReplacementLineage`
  (also plans the archive: private Git directory, size, cap, free space,
  expiry), `assertReviewedReplacementUnchanged`, and
  `removeReviewedReplacement` (measure, archive, pin, intent record, live
  comparison, `git worktree remove`, exact old-value branch deletion and
  `branch.<name>` section removal, completion record).
  `REPLACEMENT_LINEAGE_MAX_COMMITS` (200),
  `REPLACEMENT_LINEAGE_APPROVAL_MAX_AGE_MS` (24 hours), and
  `assertPlainGitEnvironment` over `GIT_ENVIRONMENT_REDIRECTS` (seven
  variables). The receipt (schema `replacement-lineage-receipt`) binds
  `source { path, branch, headRevision, changeDigest, authorAgentId }`,
  `targetRef`, `targetRevision`, `commits [{ sourceCommit,
  replacementCommits }]`, `review` (`decision: "replaced-in-target"`), and
  `approval`. Independence is proportionate: the reviewer and approver
  must not be the controller, the declared author, any recorded owner of
  a claim on the path or branch (released included), either side of a
  reassign takeover of such a claim, or an attested author of a unique
  commit. The exact-byte proof is reused and recorded as `byteProof`, not
  required. Records: `replacement-lineage/lineage-<uuid>-intent.json` and
  `-completed.json` (schema `replacement-lineage-removal`), both naming
  the archive and its pins. The boundary read refuses a state file in the
  private Git directory, other than the index and the reflogs, over the
  1 MiB the object scan reads, and the registry check, at the boundary
  read and at the final comparison, also compares the head and branch Git
  registers for the checkout. A difference at the final comparison runs
  the private `keepAfterDrift`, which deletes nothing: the checkout, the
  complete archive, and its pins stay, and the error names the archive,
  its pin count, its expiry, and the `prune-archives --archive` command.
  `deleteTrackedPins` catches anything a pin deletion throws, attempts
  every pin, and returns those it could not delete. Six test-only seams
  under `NODE_ENV=test` (`SIMPLE_CHANGES_TEST_MUTATE_AFTER_ARCHIVE`,
  `_FAIL_ARCHIVE_MANIFEST`, `_FAIL_PIN_READBACK`, `_THROW_PIN_DELETE`,
  `_COMMIT_BEFORE_ARCHIVE`, `_GROW_BEFORE_ARCHIVE`).
- Worktree archive (new `lib/worktree-archive.ts`): `scanTree`,
  `copyTree`, `compareTrees`, `copyWorktreeIntoArchive`,
  `compareLiveWithManifest` (no Git), `verifyWorktreeArchive`,
  `restoreWorktreeArchive`, `extractWorktreeArchive`,
  `listWorktreeArchives`, and `pruneWorktreeArchives`, plus
  `OBJECT_SCAN_LIMIT` (1048576) and `oversizedScanFiles`, so the copy
  refuses, and removes the whole archive folder, when its Git tree holds a
  state file the scan would have to skip. The archive
  `<common>/simple-changes/archives/<archive id>/` (mode 0700) holds
  `manifest.json` (schema `worktree-archive`), `checkout/`, `git/`, and
  during a restore `restoring.json`. The copy never follows a link, keeps
  modes, refuses a FIFO, socket, or device, and is re-walked and hashed.
  Pins: `refs/simple-changes/archives/<id>/head` and `objects/<oid>` for
  every object the per-worktree refs and pseudo-refs name (read through
  Git, confirmed with `cat-file -e`) and every 40 or 64 hex ID in the
  archived state files. `pinArchive` tracks a pin the moment `update-ref`
  exits 0, and the private `undoArchive` deletes exactly that list through
  `deleteTrackedPins` (exact value, `--no-deref`). Constants
  `DEFAULT_MAX_ARCHIVE_BYTES` (2147483648),
  `ARCHIVE_FREE_SPACE_MARGIN_BYTES` (64 MiB), and `ARCHIVE_ID_PATTERN`.
  Pruning re-checks each archive's target ref, replacement commits, and
  Git's own revert message, keeps a failing archive for attention, and
  skips one with a restore marker or an unparsable manifest.
  `automaticPlan` only classifies, into a creation-ordered queue with a
  `due` flag per item, and the private `runQueue` executes it: while the
  total is over `maxTotalBytes` it prunes the oldest for the size cap,
  crediting `freedBytes` only once the folder is gone, so an archive kept
  because a pin is blocked in the plan or its deletion fails when tried
  (such as a stale `head.lock`) frees nothing and the next-oldest goes;
  then every due archive. A dry run walks the same queue with the pin
  plans. Each prune deletes only the manifest's pins in its own namespace
  by exact value, and only once every pin is gone appends to
  `archives/prune-log.json` (schema `worktree-archive-prune`) and removes
  the folder; otherwise the archive stays whole in `keptForAttention`. A
  damaged prune log refuses only a run that would prune
  (`queueWouldPrune`). `ArchivePruneResult` gains `appliedRetention {
  days, maxTotalBytes }`, and `pruned[]` no longer carries `pinRefsKept`.
- Release-review fixes: lineage archives also pin, under `objects/`, the
  commits only the source's HEAD, branch, and own-ref reflogs keep (named
  with `rev-list --walk-reflogs`, refused above `REFLOG_PIN_LIMIT`, 2000);
  pruning deletes an archive's pins in one `update-ref --stdin`
  transaction (`applyRefTransaction`), all or none; `merge-base` without
  `--is-ancestor` is now a required answer, so a lost fork point withholds
  deletion proposals; those reflog reads and the patch audit's listings go
  through `completeRevisionList` in the new `git-complete.ts`, checked
  whole against Git's own count; and `completePatchId` asks `diff-tree
  --stdin --always` for each commit twice in one answer and uses the diff
  only when both copies match, so a cut-short diff can no longer make a
  false `patch-equivalent` proof.
- Complete reads (`git-complete.ts`): every Git read that decides a
  deletion, prune, release, retirement, or delivery now goes through it,
  retries once, then throws `LostGitAnswerError` and keeps the work.
  `completeChangedPaths` also needs the `--shortstat` file count; new
  `completeLine`, `completeObjectId`, `completeListing`,
  `completeRemoteNames`, and `remoteIsConfigured` cover the archive revert
  check, upstream holds (an unknown remote holds), lineage reads,
  `targetTreeEntry`, `localBranchForTargetRef`, and the index flags read
  before primary normalization (now parsed as hexadecimal).
- Index flags (`indexHasOnlyOrdinaryEntries` in `loop-lease-finalize.ts`):
  the old `^\s+flags:\s+(\d+)\s*$` never matched `ls-files --debug`,
  which prints `size: <n>\tflags: <hex>` on one line, so every entry read
  as ordinary and `targetEquivalentPrimaryPaths` could restore a
  skip-worktree or assume-unchanged path whose file differed from the
  index. New `debugEntryFlags` needs a trailing line break and six lines
  per entry and parses each entry's flags as hexadecimal; a conflict
  stage bit (`0x1000`, `0x2000`), assume-unchanged (`0x8000`),
  intent-to-add (`0x20000000`), or skip-worktree (`0x40000000`) keeps the
  path. A nonzero exit, a listing not whole twice, or an empty listing
  that `ls-files --error-unmatch` does not confirm with exit 1 also keeps
  it. Covered by "primary normalization with index flags lost or cut
  short" in `lost-answer-proofs.test.ts`.
- Lineage wiring: `policy.ts` adds `DEFAULT_ARCHIVE_RETENTION_DAYS` (14),
  `DEFAULT_ARCHIVE_TOTAL_BYTES` (2147483648), and
  `archiveRetentionPolicy(policy)` (`days` 1 to 3650, `maxTotalBytes` 1
  MiB to 1 TiB, otherwise the default plus a reported fallback, read
  whatever the policy's trust state); `RepoPolicy.archiveRetention` is
  optional and never written by setup. `worktree-maintenance.ts`:
  `PruneOptions` and `WorktreeCleanupOptions` gain `lineageReceipt`,
  `maxArchiveBytes`, and `now` (`PruneOptions` also `agentId`); a run with
  a receipt refuses the redirecting environment, runs under
  `GIT_OPTIONAL_LOCKS=0` (`withOptionalLocksOff`), removes the reviewed
  checkout first, and throws when it did not; new
  `pruneArchivesAtCleanup`, `restoreArchivedWorktree`,
  `pruneArchivedWorktrees`, and `listArchivedWorktrees`.
  `LoopFinalizationResult` gains `archivePruning`, pruned after the
  receipt is persisted and only for a closed run. `cleanup-core.ts` adds
  `REVIEWED_REPLACEMENT_METHOD` and `LocalRemovalMethod`. CLI:
  `--lineage-receipt`, `--max-archive-bytes`, `--archive`,
  `--extract-to`, `--older-than`, and `worktree archives`,
  `worktree restore-archive`, and `worktree prune-archives`. The
  persisted cleanup receipt and finalization receipt are unchanged. Docs:
  `references/replacement-lineage.md` and `references/recovery.md`.
- Lineage boundary: from the check before the archive through branch
  deletion, every Git command runs with `--no-pager --no-lazy-fetch
  --no-optional-locks -c core.hooksPath=/dev/null -c core.fsmonitor=false`
  and every filter driver either checkout defines emptied and not
  required, read back in both; a source with submodules, a partial clone
  (a valueless `remote.<name>.promisor` included), `hook.*`, or
  `core.virtualFilesystem` is refused. It is hardening under the threat
  model, not a guarantee. Known gap, issue #20: a filter driver whose name
  does not read back exactly (empty, containing U+2028 or U+2029, or not
  valid UTF-8) is not emptied. Tests: `worktree-archive.test.ts` (25),
  `archive-retention.test.ts` (14), and `replacement-lineage.test.ts`
  (94).
- Docs prune (`docs/0-33-0-prune-skill-docs`): rules repeated across
  references now live in one canonical section that the others link to,
  in `SKILL.md` and seventeen references. `SKILL.md` went from 17,499 to
  17,281 of its 17,500-byte budget and the packaged references from
  351,676 to 338,089 bytes. No heading, anchor, Contents list, or pinned
  test sentence changed. Two rules gained detail where they now live:
  finalization holds the loop and worktree-coordination locks and
  re-reads each candidate before persisting a removal intent, and the
  ready-work receipt's not-authority sentence names ownership. Forks that
  copied a removed duplicate see an ordinary text conflict on their next
  `update-local-forks` run.
- Threat model (`SECURITY.md`, `CONTRIBUTING.md`, b25e65e): in scope are
  losing work, shipping the wrong thing, agents interfering, self-review,
  unreliable tools, leftover state, and untrusted text; out of scope are
  the user's machine and tools, Git configuration and the programs it
  runs, Simple Changes' own state files, the provider, and a process
  deliberately racing a command. Design principles: reversible beats
  provable, fail toward keeping, clean up without being asked, and hide
  Git but not its safety. Independent reviews grade severity against it:
  a finding that needs a trusted part to be hostile is a nit or an issue.
- Integration (`integration/0.33.0`, merges 00e3fc5 through ca37532):
  `withLedgerTransaction` runs `assertStateDestination` first, then the
  bounded-lock body; `withLoopStateLockBounded` acquires through
  `acquireStateLock`, which already uses `ensureStateDirectory`. The
  hold-unit merge kept `targetEquivalentPrimaryPaths` with its held-path
  skip ahead of the policy decision, so a held path also keeps a policy
  file byte for byte, and fixed the handoff sidecar to bind the hold-bound
  `outcomeDigest` instead of the unbound receipt digest, without which a
  run with a handoff and a held sibling could never finalize (pinned by
  af52e2f). The three shipment commands moved into `runLoopShipmentAction`
  pass `lockWaitOption(options)`; `loop hold-unit` takes no lock wait.
- Compatibility: no key is added to the coordination state, review ledger,
  authoring sidecar, cleanup history, finalization receipt schema, or any
  shipped receipt, and the lease is unchanged except `heldUnits` on a run
  with holds, which runtimes before 0.33.0 reject. New files that older
  runtimes ignore: `held-units/`, `preserved-source-handoff/`,
  `run-created-retirement-*.json`, `status-observations/`,
  `replan-approval-delta.json`, `remote-branch-open-targets/`, and the
  `refs/simple-changes/held/` ref namespace. Older runtimes then fail
  stricter: a handoff outcome's digest cannot match without its sidecar,
  so they refuse to finish, end, or archive it (and a stale handoff file
  left by an older re-record is refused by 0.33.0 until it records again);
  a delta-accepted replan retried before the lease move refuses; an absent
  run-created checkout stays unproven; a missing open-targets sidecar
  reads as `unknown`, which counts more branches as pending. Older
  builders reject pages with `openProposalTargets`, a final receipt file
  holding it, and a present-branch decision. Older runtimes reject
  `--wait-lock`, `--timeout-ms`, `--would-author`, `--verified-route`,
  `--readiness-evidence`, and `--observation-digest` as unknown options,
  and they lack `reviewer room` and `loop hold-unit`.
- Identity and external-deletion compatibility: `--identity-receipt` is
  read for one command and never stored, and attestations, claims,
  leases, and controller bindings keep their shapes. Older runtimes reject
  `--identity-receipt`, ignore `--harness` outside `author attest`, and
  under two session variables still record and bind the first one; a
  claim a nested child made that way is bound to the parent's session, and
  the existing approved `worktree takeover` moves it. `loop start --mode
  resume` revalidates accepted attempts, so a review an older runtime
  accepted from an equal instance under another session is refused. The
  lease and embedded receipt keep their strict schemas; an older runtime
  rejects a receipt entry for a branch deleted outside the run (it expects
  `preserved-ambiguous` for an ambiguous branch, so `loop end` refuses),
  its `loop reconcile-remote-branches` rejects the `externalDeletion` key,
  and it ignores the new sidecar and never prunes the new refs. An older
  runtime still removes a clean contained rebaselined checkout.
- Lineage compatibility: the archives, the prune log, and the lineage
  records are new files under `<common>/simple-changes/`, and the pins are
  the new `refs/simple-changes/archives/` namespace, which older runtimes
  never read; they see one fewer checkout and branch, and the pins keep
  the objects reachable for every runtime and from `gc`. `archivePruning`
  and `reviewedReplacement` exist only in command results. Older runtimes
  reject `--lineage-receipt`, `--max-archive-bytes`, `--archive`,
  `--extract-to`, `--older-than`, and the new `worktree` actions, so a
  receipt is never silently ignored, and a policy that sets
  `archiveRetention` needs 0.33.0 or later.
- Run-only policy request: `policy.ts` adds `parsePolicyRequest` (JSON or
  @path, validated against `repo-policy.schema.json`, every
  `DEFAULT_POLICY` key and `guidance.disposition` required, no
  `execGuard`, guidance equal to `CURRENT_GUIDANCE_VERSION`, else exit 2)
  and `applyPolicyRequest`, which applies it only over a `default` policy
  as the new `PolicySource` `request` and runs it through
  `withoutUntrustedConsequentialAuthority`, reporting `policyTrust:
  untrusted` when `requiresRepositoryTrust` holds; over a saved policy it
  reports `ignored`. `initialize` and `loop start` take
  `--policy-request` and parse it before anything else is read, so no
  handoff claim is released on a bad value. The initialization status and
  schema gain `policyRequest` (`{ status, reason }` or null), and
  `inspectInitialization` gives source `request` its own reason;
  `onboardingRequired` stays `source === "default"`, so every other check
  is unchanged. `runSetup` is split into `performSetup`, and a confirmed
  run-only setup adds `runRequest` (`policyRequest`, `authoringRequest`)
  to its output; the `initialize` hand-off also prints `initialization`,
  the status `--policy-request` would give. Nothing is written. The
  inventory schema is unchanged because inventory never reports
  `request`. Tests: new `policy-request.test.ts` (10) and blocks in
  `initialization.test.ts` and `skill-contract.test.ts`.
- Tests: new `git-location.test.ts`, `test-isolation.test.ts`,
  `lost-answer-proofs.test.ts`, `finalize-policy.test.ts` (6),
  `run-created-retirement.test.ts` (8), `preserved-source-handoff.test.ts`
  (34), `lock-wait.test.ts` (14, holder fixture
  `fixtures/lock-wait/holder.ts`), `held-units.test.ts` (30 plus the
  integration cases), `replan-approval-delta.test.ts` (17 plus fa117ae),
  `reviewer-room.test.ts`, `remote-branch-prune.test.ts` (32, six of them
  "branches deleted outside the run"), and
  `agent-instance-identity.test.ts` (15), and new blocks in
  `changelog-coordination.test.ts` ("repository-owned renamed changelog
  providers"), `remote-inventory.test.ts`, `loop-lease.test.ts`,
  `worktree-maintenance.test.ts` (rebaselined checkouts survive finalize
  and close-equivalent), `turn-guard.test.ts` (session resolution), and
  `onboarding.test.ts` (reviewer-model wording). Each behavior test was
  confirmed to fail on the code before it. The last full suite on
  `integration/0.33.0` before the threat-model merge (7ddc71d, load up to
  about 214) passed: 1574 pass, 1 skip, publish-skill 19,
  update-local-forks 103.
- Filed for later: #19 (upstream hold reads the last `merge` value), #20
  (filter driver names that do not read back exactly), #21 (one versioned
  state store with history retention), #22 (record outcomes, reconcile
  branches, and remove proven worktrees inside finalize), #23 (a local
  refusal log to measure guard payoff), #24 (judge independence by agent
  instance in the lineage, override, and handoff receipts, which still
  compare agent IDs), and #25 (follow-ups for remote branches deleted
  outside a run: sidecar write ordering, a deletion with its proposal
  still open, pin pruning in close-equivalent, expiring the per-receipt
  records, and configurable pin retention).
- Guidance 33 adds behavior changes for the Git location guard, held
  units, the preserved-source handoff, bounded lock waits, replan deltas,
  the reviewer room, remote-branch deletion proposals and pending reports,
  archived reviewed removals with automatic expiry, agent instance
  identity, rebaselined late arrivals and branches deleted outside the
  run, and finalize policy preservation with run-created retirement, an
  integration change for renamed changelog providers, and an onboarding
  change for run-only policy requests. It has five notice bullets (nested
  agents passing `--harness`, held units, pending host branches, the
  reviewer room, and archived removals) and no required answer.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 high" at="2026-10-24T01:34:00-05:00" -->

## 0.32.0 - 2026-10-20

- Flat prepared layout (new `lib/managed-worktrees.ts`): `slug` moved here
  from `loop-lease-worktrees.ts`. `preparedWorktreePath(primaryCheckout,
  { agent, purpose, run })` builds `<parent of the primary>/` plus
  `.simple-changes-<repository>--<run>--<purpose>--<agent>`, re-slugs
  each field, trims a trailing hyphen that `slug`'s 48-character cut can
  leave (147f2b1; before it, a long field could join into `---`,
  fail validation, and refuse every `prepare-agent` in that repository),
  and throws `unsafe` unless the name matches
  `^\.simple-changes-<slug>(--<slug>){3}$`, is at most 255 bytes, and
  resolves to a direct child of the primary's parent. The branch is still
  `simple-changes/<purpose>-<agent>-<run>` with the run's 12-character
  slug.
- `prepareAgentWorktree` (`lib/loop-lease-worktrees.ts`) takes its path
  from `preparedWorktreePath` and drops `mkdirSync(..., { recursive })`.
  The pre-creation checks use the new local `pathEntryExists` (`lstat`),
  so a dangling link counts as taken. A resumed preparation needs its
  parent folder to be a directory before `git worktree add`, which would
  otherwise create missing parents, and refuses with "The folder <parent>
  that holds prepared path <path> is missing or is not a directory ...";
  the pending preparation stays recorded.
- Parent folders: c0b2363 made finalization and standalone cleanup
  `rmdir` the emptied `.simple-changes-worktrees/<repository>/` folder and
  its root. Review found that no removal by name can be bound to the folder
  it checked, through removal by records (98a05ba) and by pinned traversal
  with creation markers (8418c7e), so 14acd50 removed it again: no version
  in this release removes a parent folder. `managedWorktreeDirectories`
  names the older layout, and `emptyManagedWorktreeFolderNotes` returns at
  most one note naming the empty folder, and its root when that folder is
  all the root holds. It reads with `lstat` and `readdir`, requires the
  folder above the managed root to resolve to itself, skips anything
  behind a symbolic link, suggests no command, and never throws (a folder
  it cannot inspect becomes the note).
- Notes plumbing: `FinalizationCleanupResult` gains `notes: string[]`,
  which never become blockers; `automaticFinalizationCleanup` appends the
  note after its removals and metadata prune, so `loop finalize`,
  `loop close-equivalent`, and the finalization receipt carry it.
  `standaloneWorktreeCleanup` returns `WorktreeCleanupResult` (the receipt
  plus `notes`); `cleanups.json` still gets the unchanged receipt, which
  older runtimes validate strictly. `pruneRepository` appends the note to
  its `notes` outside a dry run. `simple-changes.ts` prints each as a
  `Note:` line after `loop finalize` and `worktree cleanup`
  (`renderCleanupNotes`).
- Preservation copies (`lib/work-directory.ts`): `PRESERVATION_COPY`
  (`preservation-copy`) and `assertNoPreservationCopy` in
  `removeRunWorkDirectories`, so finalize, `loop end`, and
  `removeFinishedRunWorkDirectories` at the next `loop start` keep a bound
  work directory that holds one, even as a dangling link, and report it in
  `kept` with shell-quoted `chmod -R u+w` and `simple-changes workdir
  remove` commands (`shellWord`). The check is existence only, and an
  explicit `workdir remove` still deletes the directory.
- Scratch-file rule (`lib/repository-instructions.ts`, 3ee021e, wording
  03989f9): `SCRATCH_FILE_RULE` adds two sentences, Git-first preservation
  with the `preservation-copy` directory and its `manifest.json` fields
  (repository path, remote URL, HEAD SHA, branch, `git status --porcelain`
  output, reason, time), removed only once a pushed branch or the target
  holds the work, and worktrees only where the brief or a run puts them,
  with `rmdir` for a parent an agent made. The markers are unchanged, so
  `inspectInstructionRule` reports every installed block as `stale` and
  `initialize` offers `scratch-file-rule refresh --instruction-file PATH`.
  The `add` choice text in `onboarding.ts`, the README, and
  `setup-and-policy.md` follow; `repository-instructions.test.ts` pins the
  new phrases.
- Changelog-only author (new `lib/changelog-authors.ts`, issue
  soundsystems/simple-changes#18 item 2): `prepareAgentWorktree` takes an
  optional sixth parameter `unitId` (CLI `--unit ID`, `CliOptions.unitId`).
  `changelogAuthorSurfaces` requires `--purpose changelog` (usage), a
  frozen scope (`effectiveShipmentScopeFrozenAt`), a unit in
  `shipmentScope.plan.units`, and a nonempty `releaseSurfacesIn(primary)`
  (new export from `changelog-coordination.ts`, used by
  `inspectChangelogCoordination` unchanged); otherwise `unsafe`.
  With `--unit`, `assertChangelogBinding` refuses an agent registered or
  pending without a matching binding. The binding
  (`ChangelogAuthorBinding`: agent, base, branch, path, `recordedAt`,
  surfaces, unit) is written to
  `<common dir>/simple-changes/changelog-author/<runId>.json`
  (`CHANGELOG_AUTHOR_DIRECTORY`, receipt-sidecar helpers, new
  `changelog-author.schema.json`, `SCHEMA_NAMES`) before the preparation
  enters the lease, so an author is never registered unbound; an ordinary
  new preparation drops a stale binding for its agent, and an empty list
  removes the file. `reusedRegistration` is extracted unchanged, and the
  result gains `changelogAuthor` plus a text line.
- `changelogAuthorViolations` (appended in `verificationAgainst`) reports
  `changelog-author-outside-release-surfaces` per live binding (a lease
  registration or preparation at its path, or its branch still exists)
  when any of these touch a path outside its surfaces: the worktree's
  uncommitted changes; `git diff --name-only` from the merge base with the
  current target (or the recorded base) to its HEAD; its branch tip, even
  without a checkout; and every commit the author attested at or after
  `recordedAt` that is not in its base, read with `diff-tree -c`, so a
  merge counts only paths that differ from every parent. A malformed
  ledger, a missing attested commit, or a Git failure is a violation, not
  a throw. `assertNotChangelogAuthorCheckout` refuses `loop start --mode
  resume` (`loop-lease-start.ts`) and an approved `loop takeover`
  (`loop-lease-recovery.ts`) before `transferController` into a bound
  checkout. `prepare-agent` without `--unit` keeps
  `assertNewAuthorPreparationAllowed` and its message.
- Accepted releases (`lib/loop-lease-verify.ts`, issue #3):
  `completedReleaseMatches` keeps its signature and delegates to
  `releaseAdmits(ownerAgentId, ...)`. The new `acceptedReleaseMatches`
  lets a `preserved` registration with `claimId` and `pauseReceiptId` pass
  the adopted-link check when its claim was released for `owner-release`
  or `handoff` by the receipt's owner with `releaseRecordedState`, the
  receipt, the release, and the registered branch and baseline all equal
  the present checkout, and no live claim holds the path;
  `preserved-worktree-changed` still runs. `claimContextFor` builds each
  checkout's context, now with `linkedReceipt`, and `staleAdoptedLinkCause`
  words the `coordination-claim-stale` message by cause.
- Resume-ready (`lib/worktree-coordination.ts`): `transitionClaim` takes
  an optional `assertAllowed`, run under the coordination lock before the
  claim lookup. `hasResumeReadyReceipt` accepts a receipt for this run, or
  an earlier one that still describes the claim (`receiptDescribesClaim`)
  when the active lease registers it (`registersReceipt`) or the run was
  replaced by an approved, completed `loop replan` whose archive registered
  it while the active lease registers the checkout unlinked at exactly the
  receipt's state (`inheritedThroughReplan`). The archive comes from the
  new `lib/replan-history.ts` `replannedRegistrations`, which reads
  `history/<run>/replan-*/` without following links or opening FIFOs and
  counts an attempt only when the archive equals the lease its intent
  recorded. `resumeReadyRefusal` keeps the old first sentence and adds the
  owner's `worktree pause --run-id <current run>` command, except for a
  detached claim.
- Completed removals (issue #18 item 1): `removalDispositionForPath`
  accepts a `remove-after-audit` disposition with `status: "completed"`
  at any target revision (still the lease's `targetRef`), for the
  `missing-preserved-worktree` and `missing-retained-worktree` checks. The
  new `currentRemovalDispositionForPath` keeps the current-revision rule
  for the merge-time pin in `registeredBranchViolations`, so a branch that
  moves after its checkout was removed is still reported.
- Exact branch names (issue #16; `lib/inventory.ts`):
  `LOSSY_NAME_CHARACTER`, `isLossyName`, `exactBranchRefusal`, and
  `assertExactBranch` (exit `unsafe`, "Branch <json> is not valid UTF-8 or
  contains the replacement character U+FFFD, so Simple Changes cannot name
  it exactly and will not record it in <what>. Rename the branch ...").
  Git decoding in `process.ts` is unchanged. The new
  `exactWorktreeLease` (`loop-lease-core.ts`) guards registrations in loop
  start (controller, concurrent author, preserved), rebaseline, adoption,
  acceptance, prepare-agent, and retain-worktree; `worktreeLease` itself
  stays unguarded. `claimWorktree` (including a no-op re-claim),
  `pauseClaimedWorktree`, `recordReadyWork`, `authorizeWorktreeRemoval`,
  and `resumePreparation` assert first. `withConcurrentAuthorAdmissions`
  skips a claim on a lossy branch instead of throwing, because
  `requireLease`, `loop status`, and `loop verify` all admit as they read.
  `releasedEvidence` returns nothing on a lossy branch, so a release
  writes no `event-released-state-` event and no loop admits it.
  `approvedTakeoverState` uses the helper for a reassign only, with the
  new wording; `REPLACEMENT_CHARACTER` is gone.
- Finalization (`lib/loop-lease-finalize.ts`):
  `reconcileConcurrentAuthorClaims` checks the branch before a handoff
  demotion or an obsolete-claim release (reason logic moved unchanged to
  `obsoleteClaimReleaseReason`) and reports a cleanup error instead; the
  new `keptClaims` set goes to the new `keep` parameter of
  `releaseAbsentWorktreeClaimsUnderLock`, so the absent-claim sweep keeps
  those claims. `automaticFinalizationCleanup`
  stops before primary synchronization on a lossy target branch and drops
  lossy cleanup candidates with an error, which also skips stale-metadata
  pruning. `completeAutomaticDispositions` and
  `reconcileAbsentRetainedWorktrees` record a lossy branch as null,
  `removeTargetContainedBranches` skips lossy names, and
  `reconcilePrimarySynchronization`, `bindAutomaticPrimaryBranchChange`,
  `preservesUnchangedPrimary`, and `releaseDeliveredSourceClaims` fail
  closed without an error.
- #16 residue, unchanged on purpose: comparisons of recorded and observed
  branches are as before, so a record an older runtime wrote with a lossy
  name can still match another raw-byte branch until it is released or
  replaced. `openingBranches` still records every local branch name, since
  refusing would block every loop start in a repository holding such a
  ref; its consumers fail safe. A takeover `--release` still records the
  branch in its receipt, and the `shipped` release condition compares HEAD
  and digest but not branch.
- Extensions (new `lib/extensions.ts`, issue #14): `EXTENSIONS_KEY`,
  `RecordExtensions`, `NEWER_RUNTIME_HINT`, `unknownKeyMessage`,
  `RESPELLED`, `spelledAsSerialized` (text spells the value as
  `JSON.stringify` does, apart from whitespace), `decodeUtf8`, and
  `keptExactly`. In `review-ledger.ts`, `Checker.keys` takes `extensible`
  and requires `extensions` to be an object without looking inside; the
  extensible levels are the root, attestations, completions, and attempts,
  and only their unknown-key errors carry the hint. Proposal records,
  heads, waivers, replays, `completes` items, an attempt's `requested`,
  `verified`, and `severities`, and the `record-review` receipt stay
  exact. `ReviewLedger`, `Attestation`, `IdentityCompletion`, and
  `ReviewAttempt` gain `extensions?`; `emptyReviewLedger()` has none.
- Ledger exactness: `readReviewLedger` reads raw bytes through
  `readLedgerFile` and reports a ledger holding extensions that is not
  `keptExactly` as `malformed`. `writeReviewLedger` and the transaction
  writer go through `assertReplaceable`, which refuses to replace a
  malformed ledger (new for direct callers), a ledger holding extensions
  whose text is not exactly `serializeLedger(parsed)` ("(its spacing
  differs)"), and any write that drops or changes an extensions object,
  matching records by commit and `identityKey`, by commit and
  `completionKey`, or by `attemptId`. The authors digest, identity,
  completion, and attempt keys read only named fields, so extensions never
  move a gate, and a `record-review` retry still returns `unchanged`.
- Authoring (`lib/authoring.ts`): `unknownKeys` takes `extensible`, and
  `roleErrors` makes `roles.<role>` extensible only in a Simple Changes
  sidecar; a Simple Changelogs sidecar, the root, `harnesses.<id>`, and
  `reviewLoop` stay exact. `parseAuthoringAnswer` (also behind
  `--authoring-request`) refuses an answer whose roles hold extensions
  unless `spelledAsSerialized` holds, and `readAuthoringFile` and the
  `@path` branch read raw bytes and report a sidecar that is not
  `keptExactly` as malformed, which `writeLockedSidecar` already refuses to
  overwrite. Setup writes whole answers and never reads and rewrites a
  sidecar; a write keeps values, not spacing (docs a5601d5). Schemas:
  `$defs.extensions` in `review-ledger.schema.json` (root, attestation,
  completion, attempt) and `authoring.schema.json` (`role`, `reviewRole`).
- CI recovery contract (docs only, issue #11, 36d4d33):
  `references/providers/gitlab.md` gains a Contents list and "Recover a
  passed pipeline whose publication failed": a two-phase adapter records a
  `forge` receipt with `status: partial` naming the pipeline id and attempt
  in `immutableResultId` and the exact `headRevision` and `baseRevision`;
  recovery re-reads that pipeline, re-checks project, merge request,
  revisions, run ownership, required jobs, and the head pipeline, and
  republishes idempotently. `providers/github.md` points to it.
- Compatibility: the lease, coordination document, receipts, review
  ledger, sidecar, outcome, and `cleanups.json` keep their schemas, and
  0.32.0 writes no `extensions`, so 0.31.x reads every file it writes. The
  new `changelog-author/<run>.json` sidecar is ignored by older runtimes,
  which then neither show nor enforce the release-surface bound and reject
  `--unit` as an unknown option. Runtimes before 0.32.0 reject a ledger or
  sidecar holding `extensions`; the point helps only from 0.32.0 on, and
  the 0.31.0 boundary (#14's original report) is unchanged. A pending flat
  preparation resumed by an older runtime runs `mkdir -p` on a folder that
  already exists. Older runtimes delete a work directory holding
  `preservation-copy`; the read-only bits stop that only when they run as
  an ordinary user.
- Tests: new `prepared-worktree-layout.test.ts`,
  `managed-worktrees.test.ts`, `changelog-author.test.ts`,
  `preserved-handoff.test.ts`, `resume-ready-receipts.test.ts`,
  `replan-history.test.ts`, and `finalized-removals.test.ts` (interrupted
  finalize, remote advance, resume, guarded fetch, finalize; an intended
  disposition at the old target still reports the path).
  `claim-sessions.test.ts` adds two describe blocks of nine tests each on
  a raw-byte packed-ref branch, with UTF-8 and U+00A0 positive controls.
  `review-ledger.test.ts` adds seven extension tests (both validators, the
  hint, end-to-end byte preservation, the respelling and invalid-UTF-8
  matrix, and the writer refusals); `authoring.test.ts` adds validation
  rows and an "authoring extensions" block. `finalization.test.ts`,
  `worktree-maintenance.test.ts`, `work-directory.test.ts`,
  `skill-contract.test.ts`, and `loop-lease.test.ts` follow the layout,
  notes, and preservation-copy changes; older-layout cases now prepare
  through a recorded older preparation (`legacyLayout`,
  `prepareLegacyLayoutAgentWorktree`).
- Reviews, all GPT-6.1 Sol. Worktree cleanup and ownership (c0b2363 to
  f1bc79f): round 1 at high on c0b2363 found two should-fix, that folder
  names do not prove who made a folder and that a symbolically linked root
  let `rmdir` act outside it. Rounds 2 to 4 at xhigh each found a
  should-fix race in parent removal, through removal by records (98a05ba)
  and by pinned traversal with creation markers (8418c7e), so the approach
  changed to keeping parent folders and reporting them (14acd50, 423b4dd).
  Round 5 at xhigh found one nit, and round 6, at xhigh over
  a9a23ed..f1bc79f, was clean. The user then chose the flat layout: its
  first full-range round at xhigh found the `---` should-fix fixed in
  147f2b1, and the scoped and final full-range rounds were clean.
- Reviews of #3 and #18 item 1 (89573c5): round 1 at high over the full
  range at c27b72a found no blocking or should-fix finding; one coverage
  note, treated as a nit, was answered with the `replan-history` tests.
  Round 2 at high, scoped, and round 3 at high over the full range at
  89573c5 were clean. The first #16 pass (2d45c2f) took one round at
  high over the full range, which was clean.
- Reviews of #18 item 2 and the remaining #16 sites (6de62a5): round 1 at
  high found five should-fix: a controller transfer into the author's
  checkout dropped its bound, a removed checkout hid its branch, an
  earlier use of the agent ID was held against the author, a missing
  attested commit was skipped, and absent-retained reconciliation recorded
  a lossy name. 01e0b50 fixed them. Round 2 at xhigh, scoped, found two
  should-fix in the same areas, so per the convergence rule the approach
  changed: a changelog author's checkout never becomes the controller's,
  and lossy names are guarded once, where a disposition completes and
  where branches are deleted (6de62a5). Round 3 at xhigh, scoped, and
  round 4 at xhigh over the full range at 6de62a5 were clean.
- Reviews of the rest: round 7 on #14 led to the sidecar-spacing docs fix
  (a5601d5). The #11 docs were clean at high, and the scratch-file rule
  drew one should-fix and one nit at high, then a clean round at xhigh.
- Still open for 0.33.0: #18 item 3 (a replan approval goes stale when a
  concurrent owner releases its claim), #4, and #17.
- Guidance 32 adds behavior changes for the layout, preservation copies,
  the changelog-only author, accepted releases with finished removals, and
  exact branch names, an onboarding change for the scratch-file rule, and
  integration changes for extensions and the CI contract, with four notice
  bullets and no required answer.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 high" at="2026-10-20T13:33:59-05:00" -->

## 0.31.1 - 2026-10-17

- Exact takeover evidence (`lib/worktree-coordination.ts`, issue
  soundsystems/simple-changes#15): `takeoverEvidence` no longer runs the
  approval through `requiredText`, which trimmed it and capped HEAD and the
  digest at 64 characters. The new `exactEvidence(value, name, shape?)`
  returns each value as given: an empty one is "<name> is required."
  (exit 2), and `--head` and `--status-digest` must match `SHA_PATTERN` and
  the new `STATUS_DIGEST_PATTERN` (`^[0-9a-f]{64}$`) untrimmed, or the
  refusal says the value "must be the checkout's full commit ID" or "must
  be the checkout's status digest", "exactly as Git reports it, with no
  surrounding space" (exit 2). Before, both were trimmed, and a digest of
  another shape within 64 characters reached the comparison and failed as
  a changed worktree (exit 5). The branch keeps no shape or length rule,
  and a whitespace-only `--branch` is now compared instead of refused as
  missing. `exactEvidence` keeps `requiredText`'s secret check (734e6b7):
  after the empty and shape checks, a value `redactSecrets` would change is
  refused with "<name> must not contain credentials or secrets." (exit 5),
  because the receipt records it. Only the branch can trip it, since HEAD
  and the digest must already be hex.
- Observed branch (`lib/inventory.ts`): the new `withoutLineEnds` removes
  only trailing `\r` and `\n` (`TRAILING_LINE_ENDS`). `parseWorktreeList`
  uses it in place of `output.trim()`, which ran over the whole
  `git worktree list --porcelain` output and so reached only the last
  listed worktree's last line, its `branch` line unless that worktree is
  locked or prunable. `captureInventory` reads `repository.branch`, the
  branch of the checkout inventory runs in, from
  `git symbolic-ref --quiet --short HEAD` the same way. With the approved
  side trimmed and the observed side sometimes trimmed, an approval could
  match a checkout whose branch differed only by a trailing U+00A0, and an
  exact approval of a branch Git listed untrimmed was refused. Other Git
  reads in inventory still trim, among them the remote HEAD and
  `branch.<name>.merge` in `resolveTargetRef`.
- Invalid UTF-8 branch names (ad4828f, from review round 1, and 734e6b7):
  `process.ts` decodes Git output with a non-fatal `TextDecoder`, so
  `release/\x80` and `release/\x81` both read `release/\uFFFD`.
  `approvedTakeoverState` now refuses a reassign (exit 5) when the observed
  branch from `claimTakeoverState` or the approved one contains
  `REPLACEMENT_CHARACTER` (U+FFFD), after the release-only reassign check
  and before the comparison. The message names the branch as a JSON
  string, asks for a UTF-8 name and fresh evidence, and adds "or release
  the claim with `--release`". A `--release` is not refused: it adopts
  nothing, and once the checkout is gone the claim keeps its recorded lossy
  name, which renaming the branch cannot change, so a release is the only
  takeover that can retire it. A release still compares the lossy names
  and retires only the claim its `--claim-id` names. A name that really
  contains U+FFFD reads the same and is refused for a reassign too.
- Ready-work refusal (`lib/ready-work.ts`): `readyClaim` passes
  `claimTakeoverState(inventory, claim)` to `assertClaimSession` instead of
  the listed worktree or null, as attach and release already did, so
  `claimSessionRefusal` prints exact values for a checkout Git no longer
  lists. A release-only state prints the claim's recorded branch and
  digest, the branch's tip or, once the branch is gone, the recorded HEAD,
  `--release`, and the route "which retires the claim: its checkout is
  gone"; a `detached` or `resume-ready` claim whose preserved branch still
  points at the recorded HEAD prints the reassign. Before, the null state
  made `takeoverCommand` print `<sha>`, `--branch <name>`, and `<digest>`,
  and the route advised a reassign, which `approvedTakeoverState` refuses
  for a release-only state.
- Hold pushes (`lib/ship-holds.ts`): `publishShipHold` and
  `deleteRemoteRef`, which withdraws a hold ref on `hold release` and after
  a release that raced a publish, now run `git push --no-follow-tags`, as
  `release-tag` does. The hold commit is a parentless `commit-tree` object,
  so under `push.followTags` only an annotated tag on that commit could
  have gone along. This resolves the push caveat 0.31.0 deferred. The
  README Security model ("Git and `glab` with the user's existing
  credentials") now says both pushes pass the flag, so `push.followTags`
  never adds another tag. The manual removal command printed under
  `gitPushAuthorization: never` is unchanged.
- Known limit (issue soundsystems/simple-changes#16, from review round 2):
  the U+FFFD refusal covers a takeover's reassign only. The other
  comparisons of a recorded branch with an observed one, in claims, pause
  and ready receipts, lease registrations, preserved-source overrides, and
  finalization, still see lossy names. For example, after a claim and pause
  receipt on `release/\x80`, switching the checkout to `release/\x81` at
  the same commit and status leaves `assertCurrentEvidence` accepting the
  receipt and `coordinationLinkIsCurrent` true. This predates 0.31.1. On
  macOS such a name can exist only as a packed ref, because the file system
  refuses it as a loose ref's file name. The issue proposes refusing to
  record evidence on a non-UTF-8 branch at one shared boundary, or reading
  Git's raw bytes losslessly.
- Tests: `claim-sessions.test.ts` adds five. "an approved takeover compares
  the branch, HEAD, and status digest exactly, untrimmed" checks out
  `release/long` plus U+00A0, sees inventory report the name whole,
  refuses an approval of `release/long` as a changed worktree, refuses a
  HEAD with a leading space and a digest with a trailing newline with their
  shape messages and an empty branch as missing, then accepts the exact
  name and records it. "an approval of a branch with trailing U+00A0 does
  not match the branch without it" covers the reverse. "an approved
  takeover refuses a branch name that is not valid UTF-8" appends
  `refs/heads/release/\x80` to `packed-refs`, points HEAD at it with
  `git symbolic-ref`, sees inventory report `release/\uFFFD`, and expects
  the reassign refusal; then it force-removes and prunes the worktree and
  releases the claim with a takeover naming its recorded state.
  "an approved takeover refuses evidence that carries a credential"
  expects the secret refusal for a `ghp_` branch name. "ready work
  refused from another session for a removed
  checkout prints the release takeover" force-removes and prunes the
  worktree and expects the recorded HEAD and digest, `--release`, "its
  checkout is gone", and no placeholder. `ship-holds.test.ts` adds "publish
  and withdraw without following tags, whatever push.followTags says": with
  an annotated tag on the hold commit and `push.followTags` true, a
  republish lands the hold ref and no tag, and a release leaves no tag on
  the remote. No new test covers `repository.branch` ending in U+00A0.
- Reviews, both GPT-6.1 Sol: round 1 at high on 10e41ee found one
  should-fix, the raw-byte branch collision, fixed in ad4828f; round 2 at
  xhigh on ad4828f found one should-fix in the same area that predates the
  patch, the pause-receipt comparison above. Two rounds in a row in one
  area tripped the convergence check, and the reviewer proposed a central
  fix; the user chose to ship 0.31.1 with it filed as #16. After round 2,
  the changelog writer's check of ad4828f found that the UTF-8 guard also
  refused `--release`, so a claim recorded under a lossy branch could never
  be retired once its checkout was gone, and that `exactEvidence` had
  dropped `requiredText`'s secret check; 734e6b7 fixed both.
- Guidance stays at 31, with no guidance entry and no update notice.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-17T16:31:06-05:00" -->

## 0.31.0 - 2026-10-17

- Canonical model IDs (`lib/authoring.ts`, issue
  soundsystems/simple-changes#10): the interim display-name matching that
  0.30.1 shipped and promised to replace in this release is removed
  entirely, with `sameModelName`, `modelForms`, `effortDrops`,
  `leadingWordsMatch`, `familyMatch`, `MAX_MODEL_FORMS`,
  `modelNameTooComplex`, and `MODEL_NAME_TOO_COMPLEX`. In their place,
  `canonicalModelId(value)` trims and lowercases a reported name, strips one
  provider segment (`MODEL_ID_PROVIDER_PREFIX`), and returns it only when it
  matches `MODEL_ID_PATTERN` (`^[a-z0-9][a-z0-9._-]*$`) and is neither the
  `most-capable` sentinel nor a bare effort level from `EFFORT_LEVELS`, so a
  display name, an effort label, a note, or a blank name is null.
  `MODEL_ID_ALIASES` maps one spelling to another and is empty; each future
  entry needs a stated reason. `MODEL_ID_REQUIRED` is
  the shared next step for a name that is not an ID.
- Review identity (`lib/review-ledger.ts`): `reportedModelId` reads the ID
  out of a reported identity. `diversity` now returns `distinct`, `same`,
  `unknown-author`, or `unknown-reviewer`: a different harness is distinct
  on reported names alone, and within one harness only equal or unequal IDs
  decide, so a non-ID on either side is missing evidence, never a different
  model. `targetDistinctness` adds `unknown-target`, which
  `adversarialOutcome` maps to the new `ReviewerReason`
  `"reviewer-model-id-missing"` after `reviewer-not-distinct` and
  `author-identity-missing` and before `most-capable-unresolved`.
  `reviewDisclosure` flags `model` unless both IDs are present and equal,
  appending `MODEL_ID_REQUIRED` when either name is not an ID.
  `reviewSignatureAgent` still signs with the reported name.
- Identity hints: the exported `identityReasonHint(reason, mode)` gives
  each missing-identity reason a next step that states its condition, since
  one reason has several causes. A provisional `author-identity-missing`
  points to `setup --authoring` for the configured `proposals` target; a
  verified one prints the `--complete-identity` command, with `--instance`
  whenever the earlier record has one, and says a record without a
  session, harness, or agent id cannot be completed and the owner decides.
  `describeReviewer` in `initialize` text, `renderRecordedReview`, and the
  now exported `renderResumedReviews` (resume asks for the repair before a
  fresh review) all print it.
- Completion compatibility: `refinesIdentity` holds under either of two
  readings through `keepsAndAdds(completer, earlier, model)`, by model ID
  (`reportedModelId`, so a completion may add the ID a display-name record
  lacked) or by reported name (`reportedModel`, the rule 0.30.x wrote
  completions under, so those ledgers stay readable). `compatibleModels`
  treats two IDs as compatible when equal, two non-IDs when identical, and
  an ID beside a non-ID as compatible. `anchorConflicts(own, completer)`
  returns every record under the completer's anchor that disagrees with the
  completer or with another record under it; `completionTargets` refuses
  when it is nonempty and `effectiveOwnAttestations` lets a completion
  stand only while it is empty. Before, each record was compared only with
  the completer, so two records that disagreed with each other could both
  pass a completer that reported too little to contradict either.
- Onboarding R3' (`reviewModelProblem` in `lib/authoring-onboarding.ts`)
  compares canonical IDs: it refuses a reviewer name that is not an ID, an
  ID equal to the author's recorded one, and any name while the recorded
  author model is not an ID. `initialization.schema.json` adds
  `reviewer-model-id-missing` to the reviewer reason enum; no ledger or
  sidecar key was added for #10. References: `change-requests.md`
  (`--agent <model ID>` replaces 0.30's `"<model> <version>"`, completion
  conflict rules), `review-and-merge.md` (diversity by ID, the fail-closed
  reasons, hint sources, completion compatibility, the runtime boundary),
  and `onboarding.md` (R3').
- Tests for #10: `authoring.test.ts` replaces the 0.30.1 "model identity"
  pair tables with `canonicalModelId` cases (ID-shaped names folded for
  case and one provider prefix; display names, effort labels, notes, and
  the sentinel are not IDs; different IDs stay different with no alias
  assumed). `review-ledger.test.ts` covers a display-name author failing
  closed in one harness until completed with its model ID, display names
  across harnesses still counting, a completion 0.30.x wrote with a display
  name keeping the ledger readable while the name still fails closed, a
  completion refused and one voided when two other records under its anchor
  disagree, provisional and verified hints, the resume hint, and the CLI
  refusal on a conflicting anchor. `onboarding.test.ts` covers R3' with
  cased and prefixed author IDs and a non-ID recorded author model.
  `proposal-signatures.test.ts` (19f0e8c) now expects a same-harness
  display name to fail closed as `reviewer-identity-missing` and the same
  model ID on both sides as `reviewer-not-distinct`, while signatures and
  disclosure still read the reported name.
- Severity-aware review loop (`lib/authoring.ts`, issue
  soundsystems/simple-changes#12): the review role may carry `reviewLoop`
  (`ReviewLoopSettings`: `escalateOn` of type `ReviewEscalationTrigger`,
  `"blocking-or-should-fix"` or `"any"`; `convergenceRounds` 1 to 10 or
  null; `roundCap` 1 to 20 or null), allowed on the review role only and
  checked by `reviewLoopErrors`. `resolveReviewLoop` fills each absent
  field from `REVIEW_LOOP_DEFAULTS` (2, `blocking-or-should-fix`, 4), and
  the field source is `"default"` when the key is absent.
  `stricterReviewLoop` combines a request with the saved loop field by
  field, keeping saved fields a request omits: `any` wins, the smaller
  number wins, and null loses, so `--authoring-request` only tightens it.
  `authoring.schema.json` lists the rounds as enums because the hand
  validator has no `maximum`.
- Ledger (`lib/review-ledger.ts`): an attempt and a `record-review` receipt
  may carry `severities` (`FindingSeverities`: `blocking`, `shouldFix`,
  `nit`), which `checkSeverities` requires to be non-negative integers that
  add up to `findingsCount` on a findings verdict only;
  `review-ledger.schema.json` adds the optional key with an `if`/`then` on
  the verdict, and `attemptPayloadKey` treats absent and graded findings
  as different payloads. `escalatingAttempt(attempt, escalateOn)`
  is any finding under `any`, otherwise a blocking or should-fix one or an
  ungraded findings verdict, so ledgers written before severities keep
  escalating. `escalatedEffort` takes `escalateOn` and uses it.
- Loop status: `reviewLoopStatus(attempts, loop)` reads attempts in ledger
  append order and never sorts by timestamp. A round is a findings attempt,
  accepted or not, or an accepted clean one, which ends the loop; failed
  attempts and rejected clean ones are no round. It reports
  `consecutiveEscalatingRounds`, `roundsSinceEscalation` (rounds after the
  first escalating one since the last accepted clean review),
  `convergenceCheck` (`due`, `not-due`, `off`), `roundCap` (`reached`,
  `not-reached`, `off`), and a `message` that tells the controller to
  question the approach when the findings sit in one area or to ask the
  user; judging the area stays the controller's. `ReviewerResolution.loop`
  is set only in verified mode (`--proposal --head`) and null otherwise.
  `initialization.schema.json` adds `$defs.resolvedReviewLoop`,
  `reviewer.loop`, `effective.review.reviewLoop`,
  `authoringReviewSource.reviewLoop`, and `reviewLoopRule`; `initialize`
  text adds a `Review loop:` line when a message is set.
- Setup (`lib/authoring-onboarding.ts`): new questions `reviewEffort`
  (asked unless the model question already asked an effort) and
  `loopChecks` (R5), and every reviewer choice, including **Any independent
  reviewer**, now goes through `askReviewLoop`. `reviewEffortChoices`
  recommends `high` through the new `effortChoices(recommended)` parameter;
  `DEFAULT_EFFORT` stays xhigh. `escalationChoices` gains
  `xhigh-any`; `loopCheckChoices(escalateOn)` words R5 for the chosen
  trigger. `reviewLoopAnswer` records `escalateOn: "any"` for `xhigh-any`
  and null rounds for **Never; review until clean**, and nothing for the
  recommended answers, so a sidecar that keeps the recommendations stays
  readable by 0.30.x. `reviewLoopSummary` adds the escalation and stop
  sentences to `renderAuthoringSummary`.
- Review-loop rule (`lib/repository-instructions.ts`): a third managed
  block, `REVIEW_LOOP_MARKERS` (`simple-changes:review-loop`) with
  `REVIEW_LOOP_RULE`, which names no agent or model. An `InstructionRule`
  registry (`review-loop`, `scratch-files`) backs `renderInstructionRule`,
  `writeInstructionRule`, and `inspectInstructionRule`, with the
  scratch-file wrappers kept. `managedBlockSpans` now refuses any nested or
  crossed pair among all three blocks. `lib/scratch-file-rule.ts` exports
  `refreshInstructionRule(repository, file, rule)` under the same run-held
  refusal as the scratch-file refresh. `lib/onboarding.ts` and
  `simple-changes.ts` add `--review-loop-rule add|leave` to `setup` and
  `initialize` (non-interactive default `leave`, interactive offer after the
  scratch-file rule with **Add the rule** pre-selected), the
  `review-loop-rule refresh` command, `initializationInstructionRule`,
  `RULE_REFRESH_COMMANDS`, and `InstructionRuleReport`. SKILL.md changed
  one sentence so a stale `reviewLoopRule` is offered its refresh once, like
  `scratchFileRule` (17,499 of 17,500 bytes).
- References for #12: `review-and-merge.md` adds "Review rounds" and
  rewords "Escalation as a floor", `onboarding.md` adds the loop questions
  and the rule offer, `setup-and-policy.md` documents `reviewLoop`, its
  stricter-value rule, the 0.31.0 boundary, and the rule block. Tests:
  `authoring.test.ts` ("the review loop settings": absent fields are
  defaults with their layer, a request only tightens),
  `review-ledger.test.ts` (only blocking or should-fix findings escalate
  and ungraded ones still do, a nit-only review does not escalate the next,
  loop status counts rounds since the last clean review, `record-review`
  stores graded findings, refuses counts that do not add up, and reports
  the loop), `onboarding.test.ts`, `repository-instructions.test.ts` (third
  block beside the other two, rule names no agent or model, nested or
  crossed third block refused), and `cli.test.ts` (the rule is added only
  when setup names it, and initialize reports and refreshes it).
- Author coverage preflight (new `lib/author-coverage.ts`, issue
  soundsystems/simple-changes#6): `authorCoverage(repositoryPath, base,
  head)` backs the read-only `author coverage` command over
  `merge-base(base, head)..head`, the range and order
  `proposal record-authors` uses, and reports `status` (`covered`,
  `incomplete`, `ledger-unreadable`), `outstanding` `CoverageItem`s (`kind`
  `unattributed`, `unresolved-source`, or `uncovered-edit`, with
  `carriedBy` and `replaySources`), `incompleteIdentities` (attestations
  without a model ID, so display names and effort labels count), and the
  `authorsDigest`; the owner's completion command asks for
  `--agent <model ID>`. `readyRangeCoverage(cwd, targetRef, head)` refuses an
  unresolvable target (exit 4) and unrelated history (exit 3).
  `assertReadyCoverage(coverage, owner, leaveUncovered)` refuses a
  malformed ledger (exit 5) even with `--leave-uncovered`, an abbreviated or
  malformed SHA (exit 2), a named SHA that is not outstanding (exit 3), and
  otherwise anything outstanding left unnamed (exit 5) with the owner's own
  commands, including `--replays ... --contribution implementation` for an
  inconclusive replay and `--complete-identity` only for model-less
  attestations among a commit's own effective attestations, never ones a
  replay inherits. The module only imports existing `review-ledger.ts`
  exports.
- Ready work (`lib/ready-work.ts`): `recordReadyWork(..., options)` takes
  `leaveUncovered` and now runs `withLoopStateLock` around the existing
  coordination lock, the established order, so no attestation lands
  between the coverage check and the release; it reports busy while
  another loop command holds the lock. `ReadyWorkRecordResult` adds
  `coverage` and `leftUncovered`; `ReadyWorkStatus.coverage` is derived at
  read time (`AuthorCoverage`, `{ status: "unknown", detail }`, or null
  once shipped), so the receipt schema is unchanged. `simple-changes.ts`:
  `author coverage` (`runAuthorCommand` now returns an exit code; 0
  covered, 3 incomplete or unreadable; the usage error now reads "author
  requires attest or coverage"), `--leave-uncovered` (comma list,
  repeatable, a usage error without `--ready-receipt`), an "Author
  coverage:" line on ready release, and an indented "author coverage:" line
  per receipt in `worktree status`, which names who decides and never an
  attest command. References: `change-requests.md` (draft until covered,
  attest and complete before releasing a claim),
  `inventory-and-concurrency.md` (delegated-unit check, ready-receipt
  preflight), `review-and-merge.md` (Coverage), and SPEC.md.
- Tests for #6: new `author-coverage.test.ts` (9 tests): the exact SHA and
  owner command on refusal with nothing recorded and the claim still
  active, then self-attestation; replay source and inconclusive replay
  gaps; `--leave-uncovered` exact naming with a byte-identical ledger and
  the gap still in status; one refusal leaving an active loop and other
  owners' ready work alone; the loop lock held across check and release;
  completion hints only for a commit's own attestations; a malformed
  ledger; and `author coverage` exit codes, JSON, read-only behavior, and a
  digest equal to `record-authors`. `ship-holds.test.ts` and
  `status-all.test.ts` ready-work fixtures now attest their commits first.
- Constructed coordination requests (`lib/coordination-adapter.ts`,
  `lib/types.ts`, issue soundsystems/simple-changes#7):
  `probeCoordinationAdapter(adapter, ownerRef, platform, environment)`
  returns `automatic: false` always, a `blocker` that is never null,
  `adapterSupportsAutomation`, and `host` (`harness` from
  `currentHarnessSession` only, `transport: "unverified"`); an automatable
  profile gets `{ capability: "transport", code:
  "host-transport-unverified" }` with a next step that says nothing was
  sent. Nothing probes host tools or binaries, and the profile table is
  unchanged. `CoordinationRequest.state` is always `"constructed"`.
  `buildCoordinationRequest` takes a required `lease` and refuses (exit 5)
  unless it is the active lease for the run. `runWorktreeRequest` prints
  `Constructed, not sent: <message>` and `Next: <step>`, and
  `automationSummary` in `worktree claim` text no longer says automation is
  available. Tests: `worktree-coordination.test.ts` (never automatic,
  owner profile kept apart from the host, active-run requirement) and a
  `cli.test.ts` cross-harness case in which a capable fake owner binary on
  PATH never runs and the coordination document stays byte-identical.
- Vanished concurrent author (`lib/worktree-coordination.ts`, issue
  soundsystems/simple-changes#8): `activeLoopTakeoverRefusal` replaces the
  bare `activeLoopNeedsPath` refusal in `takeoverWorktreeClaim`. Under an
  active controller, the live claim on a registered `concurrent-author`
  path may be reassigned to that controller only (never `--release`, never
  another agent, exit 5 with the exact rule); every other registered path,
  adopted preserved ones included, keeps the old refusal.
  `WorktreeTakeoverOptions` gains `expectedBranch` and `expectedHeadSha`;
  `takeoverEvidence` validates them, `approvedTakeoverState` compares
  branch, HEAD, and digest, and the mismatch message prints the current
  state. A reassign writes the approved branch, HEAD, and digest onto the
  claim. `matchingTakeoverIntent` also matches `branch` and `headSha`, and
  `recoverAppliedTakeoverIntent` counts a reassign as applied only when the
  claim records the intent's exact state (and, after #9, belongs to the
  retrying session), and a release only when a takeover released it; before,
  a second takeover of a moved checkout by the same agent and approver
  completed without recording the new HEAD (review round 1).
- Recovery text: `loop-lease-verify.ts` `concurrentTakeoverHint` appends
  the exact takeover to `coordination-claim-stale` for a non-primary
  concurrent author whose live claim the controller does not own, including
  a checkout with no commit (`--head none`, 29d4168); `nextCommands` are
  unchanged because it needs approval. `worktree-maintenance.ts`
  `liveClaimPaths` returns a claim-ID map and standalone cleanup prints
  `takeoverCommand(...)` with exact values. CLI: `--branch` (valued),
  `--detached` (boolean), `takeoverBranch` (exactly one, else exit 2),
  `takeoverHead` (`none` maps to null). Docs: `recovery.md` ("Stale claim
  takeover", new "Vanished concurrent author"),
  `inventory-and-concurrency.md`, README usage, SPEC.md. Tests: new
  `claim-recovery.test.ts` (9 tests: current-branch recovery end to end with
  the scope proven open by `prepare-agent`, `--head none` hint, clean
  detached checkout, refusal of another agent, `--release`, a commit or
  branch switch after approval with the same clean digest, protection of
  other registered paths, interrupted intent including a retry naming
  another HEAD, CLI flag rules); existing takeover tests pass the new
  fields and the cleanup test pins the exact command.
- Session-bound claims (`lib/worktree-coordination.ts`, issue
  soundsystems/simple-changes#9): a claim is bound to the harness session
  (`executingClaimSession`, `harness:sessionId` from the session variables
  `agents/harnesses.json` lists) through its coordination event IDs:
  `event-session-<32 hex>-<uuid>`, the first 32 hex of
  `sha256("claim-session:" + session)`, or `event-session-unbound-<uuid>`,
  both inside the existing `^event-[a-z0-9-]+$` pattern, so no schema
  changed. `claimSessionBinding` reads the latest marked event and ignores a
  mark whose actor no longer owns the claim, so a takeover by an older
  client leaves the claim unbound for its new owner. `claimWorktree`
  checks the session (`assertClaimantSession`, then `assertAgentSessionFree`
  for a new claim) before the adapter and owner-reference check, binds an
  unchanged unbound claim with one refresh event, and decides by the latest
  earlier claim on the checkout only (review round 2). Pause, detach,
  attach, release, handoff release, and `readyClaim` call
  `assertClaimSession`; `claimSessionRefusal` prints the takeover that would
  be accepted. A reassigning takeover writes a session mark for the session
  that ran it.
- Takeover states: `claimTakeoverState(inventory, claim)` returns the
  listed worktree, or for an absent checkout the recorded state, which is
  reassignable only for a `detached` or `resume-ready` claim whose
  preserved branch still points at the recorded HEAD and whose path is
  absent, and otherwise `releaseOnly` (the branch at its current tip, or
  the recorded HEAD once the branch is gone, with the recorded digest).
  `TAKEOVER_STATES` adds `stale`. Reassigning a release-only state is
  refused with the release that would be accepted. The takeover and the
  attach, release, claim-elsewhere, and attestation refusals read this
  state, so each prints the form that would be accepted; the claim, pause,
  and detach refusals, the `loop verify` hint, and cleanup print the listed
  worktree, which is what it returns for a present checkout. This rule
  (014f668) replaced the per-condition fixes of review rounds 2 to 4 after
  the convergence check. `expectedHeadSha` is `string | null`
  and printed takeovers show `--head none` for null. 29d4168 removed the
  255-character cap on the expected branch, which no Git branch or claim
  has, and made `readyClaim` pass the observed worktree so its refusal
  prints the real state.
- Attestation (`lib/review-ledger.ts`): `claimWorktreesFor` skips claims
  `claimHeldByAnotherSession` reports, and when no eligible basis remains
  and one was held elsewhere, `authorWorktrees` throws "Attest from the
  session that made the commits." with the takeover; `attestCommits` passes
  `harness:session` or null. Registration eligibility (`prepare-agent`
  authors, the controller) and controller replays are unchanged.
  `loop-lease-verify.ts` `staleClaimRecovery` addresses the owner's steps to
  the owner's own session, the controller's steps to the controller, and
  `handoffHint` also covers an unheld checkout whose owner vanished. Docs:
  `inventory-and-concurrency.md`, `recovery.md`, `change-requests.md`,
  SPEC.md. Tests: new `claim-sessions.test.ts` (same-session refresh,
  pause, release; other sessions and no session refused for each action
  with nothing recorded; agent ID reuse elsewhere; unbound claims;
  takeover to a replacement session; branch names over 255 characters;
  the ready-work refusal printing the real state; latest-claim rule;
  stale, detached, moved or deleted branch, and removed checkout recovery;
  older-client takeover; retry from another session; an eleven-condition
  release matrix; an unborn checkout through the CLI; attestation; the
  issue's reproducer; real session environment variables in the CLI).
  `loop-lease.test.ts` expects the reworded recovery text.
- Security hardening (issue soundsystems/simple-changes#13): new
  `lib/run-id.ts` exports `RUN_ID_PATTERN` (`^run-[a-z0-9-]+$`, the
  loop-lease schema's `runId`). `work-directory.ts` drops its
  `/^[\w.-]+$/u`, so `bindingsDirectory` refuses any other ID (error text
  now `Invalid run ID "<id>": it must match run-[a-z0-9-]+.`, still exit 3)
  and `boundRuns` skips other directory names in the finished-run sweep;
  `..` had named the Simple Changes state directory, which closing such a
  run would have removed recursively. `loop-lease-core.ts` and
  `harness-session.ts` import the shared pattern, and at integration
  (39d0ee2) so do `coordination-adapter.ts` and `worktree-coordination.ts`,
  so every run-ID check reads one grammar. New `lib/git-worker-request.ts`
  (imports only `node:path`): `isGitExecutable(executable, platform)`
  accepts bare `git` or an absolute path ending in `git` (on win32
  case-insensitive, `.exe` allowed), and `gitWorkerRefusal` also requires a
  positive integer `concurrency`, a request list, and per request a
  non-empty `cwd` and string `args` whose first entry is not an option.
  `git-worker.ts` checks first and on refusal writes the reason to stderr
  and exits 2 having started nothing; `runGitConcurrently` already falls
  back to `runGit` on a nonzero worker exit. `process.ts` types its payload
  with `satisfies GitWorkerInput`, and `GitRequest` aliases
  `GitWorkerRequest`.
- Security docs and tests: README `## Security model` (Stop hook,
  `execGuard`, migration adapters, transcript reads, commit and proposal
  text, Git and `glab` with the user's credentials), a `setup-and-policy.md`
  "Security model" section with the untrusted-data rule and an unanchored
  absolute README link (the contract test resolves anchored links as local
  files), and a SECURITY.md pointer. The README states the real `execGuard`
  rule (`execGuardFor` applies a repository guard without the trust
  receipt, since a guard can only refuse), correcting the issue text.
  Tests: `work-directory.test.ts` (dot-only and malformed IDs refused before
  any binding is touched; the sweep skips non-run-ID entries),
  `security.test.ts` "run IDs in paths", and `process.test.ts` "Git worker
  requests", including a spawned worker that refuses another program, a
  relative `bin/git`, a leading `-c core.fsmonitor=...`, and a leading `-C`
  without running a marker script. Deferred: hold publish and withdrawal
  pushes in `ship-holds.ts` do not pass `--no-follow-tags` (the README states
  the caveat); recheck the skills.sh audit after the release installs.
- Compatibility (issue soundsystems/simple-changes#14, accepted by the
  user as this release's boundary after the #10 review cap): a runtime
  before 0.31.0 reads a ledger holding a completion that adds a model ID to
  a display-name record, or an attempt with `severities`, as
  `ledger-malformed` and refuses every ledger operation, and rejects a
  sidecar holding `reviewLoop`. Recommended setup answers write no
  `reviewLoop` and an ungraded review writes no `severities`;
  `review-and-merge.md`, the schemas, and the guidance 31 notice state the
  boundary. A later fix may keep new state in files older runtimes never
  read, following the ship-holds precedent, or bump the ledger
  `schemaVersion`. Claims, takeovers, receipts, and coordination documents
  keep their shapes; an older runtime does not enforce session binding and
  still accepts a digest-only takeover.
- Open from the last #8/#9 review (issue soundsystems/simple-changes#15):
  `takeoverEvidence` passes `--branch` through `requiredText`, which trims,
  so a branch ending in U+00A0 is not compared exactly (a wrong match or a
  wrong refusal; should-fix), and a ready-work refusal from another session
  for a checkout Git no longer lists still prints placeholders and
  reassign advice instead of the release-only takeover (nit); the fix
  resolves that evidence through `claimTakeoverState`.
- Reviews, all GPT-6.1 Sol: #12 round 1 high and rounds 2 to 4 xhigh,
  round 4 clean, approach changed once under the convergence check
  (evidence-only rounds in append order). #10 round 1 high and rounds 2 to
  7 xhigh, approach changed twice (anchor-wide consistency;
  condition-stating hints); round 7 hit the cap with one open finding,
  which the user chose to document and ship (#14). #6 and #7 round 1 high
  (should-fix: the coverage check raced ledger writes, fixed with the loop
  lock; nit: inherited identity hints), round 2 xhigh (one nit, fixed), and
  round 3 xhigh full range clean. #8 and #9 round 1 high (interrupted
  takeover), rounds 2 to 5 xhigh (session recovery for stale, detached,
  reused, and unborn checkouts; the branch cap and two nits in round 5,
  fixed in 29d4168), then one more xhigh review of that fix at the user's
  choice, whose findings are #15. #13 round 1 high and rounds 2 to 5 xhigh,
  round 5 a full-range review at the final head, clean.
- Guidance 31 adds behavior, onboarding, and integration changes for
  model IDs, the review loop and its rule, coverage preflight, constructed
  requests, controller recovery, session-bound claims, and the security
  hardening, with three notice bullets, and needs no answer: an absent
  `reviewLoop` means the recommended loop, so no existing setup has a
  pending question.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-17T12:41:13-05:00" -->

## 0.30.1 - 2026-10-16

- Model identity (`lib/authoring.ts`, issue soundsystems/simple-changes#5):
  `sameModelName` now compares the forms `modelForms` derives from each
  name (`ModelForms.forms`). Each `ModelForm` holds its `tokens`, its
  `key`, and its word `prefixes`, the keys of its leading whole words
  short of the full form, both built once. `modelTokens` lowercases a name
  and splits it into alphanumeric runs, and a form's key is its tokens
  joined, which is what the removed `modelKey` computed. The forms are the
  whole name and, for each base, the base itself and the words left by
  each choice of effort words to drop (next bullet). The bases are the words
  (`splitWords`) once `withoutQualifiers` has removed parenthesised
  qualifiers; the words before the first `key:` or `key=` field label
  (`MODEL_FIELD_LABEL`), when it comes after at least one word; and each of
  those without trailing setting pairs (`withoutTrailingSettings`), a
  digit-free word followed by a value that starts with a digit, such as
  `budget 32768` or `temperature 0.2`, stripped from the end one pair at a
  time while at least three words remain and a word with a digit
  (`MODEL_DIGIT`) is left before the pair, so `Claude Opus 5` never
  shrinks to `claude`. `withoutQualifiers` strips
  `MODEL_QUALIFIER` matches innermost first, repeating until none is left,
  so a nested note such as `(reasoning (high))` goes whole, then treats
  an unclosed `(` and the rest of the name (`MODEL_UNCLOSED_QUALIFIER`) as
  one more note and drops any stray `)`, so a malformed note never leaves
  a fragment. Both a closed note and an unclosed tail go through
  `noteVersion`, which returns the leading run of the note's tokens that
  start with a digit (`MODEL_VERSION_TOKEN`), so a note that starts with a
  version leaves only that version in the name, as one dotted word so it
  never ends a leading-words match early, and a note that does not is
  stripped as a qualifier. So `(5.5)` and `(5.5 high)` leave `5.5`,
  `Claude Opus (5.5 high)` and `Claude Opus (5.5, budget 1000)` match
  `claude-opus-5-5`, `gpt-6.1-sol (reasoning: high, budget: 32768)`
  matches `gpt-6.1-sol`, and `Claude Opus (5)` and `Claude Opus (5.5)`
  stay distinct, as do `Claude Opus (5 high)` and
  `Claude Opus (5.5 high)`, and the unclosed `Claude Opus (5` and
  `Claude Opus (5.5`. Words split on whitespace, commas, semicolons,
  colons, and equals signs, and each loses the punctuation around it
  (`MODEL_WORD_EDGES`) before the effort check.
- Effort words (`effortWords` and `effortDrops`, replacing `EFFORT_WORDS`
  and its trailing-only pop): a word splits into parts on `-`, `_`, and
  `.` (`EFFORT_PART_SEPARATORS`), and only a word whose every part is in
  `EFFORT_PARTS` (`EFFORT_LEVELS` plus `extra`, `effort`, `reasoning`,
  `thinking`, `think`, `mode`, `level`, and `model`) can be an effort word.
  `effortWords` sorts those into two groups (`EffortWords`). `certain`
  holds words with an `EFFORT_MARKERS` part (`effort`, `reasoning`, or
  `thinking`) and helper words, such as `mode`, `level`, `think`, or
  `model-max`, next to one; every drop includes them. `variable` holds
  standalone levels, words made only of `EFFORT_LEVEL_PARTS`
  (`EFFORT_LEVELS` plus `extra`), such as `high`, `max`, `extra`, and
  `extra-high`, plus helper words next to a level but not next to a
  marker word, such as `Model` in `high Model 5.5 Max xhigh`. A helper
  word next to neither stays in the name. `effortDrops` returns a drop of
  every certain and variable word and, for each contiguous run of the
  variable words, a drop of the certain words and every variable word
  outside that run, so a name yields a quadratic number of forms, within
  the 128-reading limit (`MAX_MODEL_FORMS`, under "Cost bound" below), and
  a level that is also part of the name is tried kept wherever it sits
  among other effort words: `GPT-5.1 Codex Max high` matches
  `gpt-5.1-codex-max`, as do
  `GPT-5.1 Codex Max model reasoning effort extra high mode` and
  `high max xhigh GPT-5.1 Codex Max high max`;
  `xhigh GPT-5.1 Codex Max high` matches `openai/gpt-5.1-codex-max`;
  `high Model 5.5 Max xhigh` matches `model-5-5-max`; and
  `GPT-5.1 Codex Max reasoning: xhigh` matches `gpt-5.1-codex-max xhigh`.
  A drop that would leave no word yields no form, so a name made only of
  effort words, such as `high` against `max`, still compares by its own
  words. So `reasoning_effort=high`, `reasoning-effort: high`,
  `model_reasoning_effort=high`, a leading `xhigh`, `thinking mode`, and
  `reasoning mode: high` can all go, while `gpt-5.1-codex-max` and
  `coder-max`, which have parts outside `EFFORT_PARTS`, the lone `Model`
  in `Example Model 5.5`, and the lone `model-max` in `vendor model-max`
  are never dropped as effort.
- `formsMatch`: two forms match when their keys are equal or one ends with
  the other, as before, or through `leadingWordsMatch`, when one name's
  first whole words, before at least one later word, spell the other's
  full key, a family prefix allowed (the joined words end with that key).
  The words after them read as notes, so
  `gpt-6.1-sol reasoning: high, budget: 32768`,
  `Claude Opus 5.5 temperature 0.2`, and `openai/gpt-6.1-sol ctx 200k`
  match their base models without any list of runtime fields. A version is
  part of its word, so `gpt-6 budget 100` against `gpt-6.1-sol`,
  `Claude Opus 5 temperature 0.2` against `Claude Opus 5.5`, and
  `gpt-5.1-codex budget 100` against `gpt-5.1-codex-max` stay distinct.
  The field-label and trailing-settings bases let two names that both
  carry settings match: `gpt-6.1-sol budget: 32768` and
  `gpt-6.1-sol budget: 65536`, and `Claude Opus 5.5 temperature 0.2` and
  `claude-opus-5-5 budget 100`. A model word after a version is a name,
  never a setting, so `Claude 3 Opus` and `Claude 3 Sonnet`,
  `Claude Opus 5` and `Claude Sonnet 5`, and `Claude Opus 5 budget 100`
  and `Claude Sonnet 5 budget 100` stay distinct. Two notes that are
  plain words, such as `gpt-6.1-sol fast` against `gpt-6.1-sol preview`,
  and settings on a name with no digit, such as
  `Claude Opus temperature 0.2` against `Claude Opus budget 100`, still
  look distinct.
- Accepted tradeoff, now pinned by tests: a variant written as a separate
  word reads as a note on its base model. `Max` is also a standalone
  level, so `GPT-5.1 Codex Max` matches `gpt-5.1-codex` (beside
  `Claude Opus 5.5 max`, an effort label it cannot be told from by
  spelling), and through `leadingWordsMatch` any trailing variant word
  does too, so `vendor model-max` matches `vendor` (moved from the
  distinct pairs) and `GPT-5.1 Codex Mini` matches `gpt-5.1-codex`. A bare
  family name matches any name that starts with it, such as
  `Claude Sonnet 5.5` against `claude`. Hyphenated IDs stay distinct:
  `gpt-5.1-codex-max` against `gpt-5.1-codex`. In the diversity gate this
  only ever makes a review count as the same model, which blocks it and
  never admits one. `reviewDisclosure` reads the same comparison, so a
  reviewer reporting `gpt-5.1-codex` when `GPT-5.1 Codex Max` was
  requested is not flagged as a `model` mismatch.
- `familyMatch`: only a qualifier that is exactly
  `(version unknown)` or `(unknown version)` after lowercasing, with any
  spacing inside the parentheses (the anchored `MODEL_UNKNOWN_QUALIFIER`),
  sets `versionUnknown`, and then `familyMatch` also lets that name match
  one whose tokens hold all of its tokens as a consecutive run, after any
  prefix such as a vendor name, followed only by tokens that start with a
  digit (`MODEL_VERSION_TOKEN`). `familyMatch` never widens a name whose
  last token is already a version token. So `Opus (version unknown)`
  matches `claude-opus-5-5`, while `gpt-5.1-codex (version unknown)` does
  not match `gpt-5.1-codex-max`, `Fable (version unknown)` does not match
  `claude-fable-mini-5-1`, `Claude Opus 5 (version unknown)` does not match
  `claude-opus-5-5`, and `Fable 5.1 (version unknown)` does not match
  `Fable 5.1.2`. Any matching pair of forms counts, so the heuristic still
  fails toward "same".
- Cost bound: `modelForms` counts a name's readings before building them,
  one for the whole name plus, for each base, two and one per contiguous
  run of its variable words. A name past `MAX_MODEL_FORMS` (128) sets
  `overflow`, and `sameModelName` then returns true against any other
  name, so the diversity gate treats it as the same model, which only
  ever blocks a review; real names have a handful of readings. Checks
  that must not accept on "same" use the new exports
  `modelNameTooComplex` and `MODEL_NAME_TOO_COMPLEX` instead:
  `reviewDisclosure` flags `model` when the requested or the reported
  name is over the cap and appends "The model label is too complex to
  compare; pass the model ID the harness reports.", and
  `reviewModelProblem` (onboarding R3') refuses an over-cap reviewer name
  with the same message. `leadingWordsMatch` scans the precomputed
  `prefixes`, and forms are deduplicated on their key and prefixes. Two
  valid names of 114 and 110 characters packed with effort words and
  setting pairs took about 17 seconds to compare on the previous code;
  they now take milliseconds.
- Before, an author's display label `GPT-6.1 Sol high` and a reviewer's
  `gpt-6.1-sol` had different keys, so `diversity` returned `distinct`
  within one harness and an adversarial `record-review` accepted a
  same-model review. Pairs that stay distinct include `Claude Opus 5` and
  `Claude Opus 5.5`, `gpt-6-sol high` and `gpt-6.1-sol`,
  `gpt-5.1-codex-max` and `gpt-5.1-codex`, and
  `Fable 5.1 (version unknown)` and `Fable 5`. There is no alias registry,
  so names that share no form, such as `Astra medium` and `gpt-6.1-sol`,
  stay distinct. A follow-up commit makes the examples in the code comments
  vendor-neutral (`Model 5`, `model-max`).
- Review fixes, in nine rounds. Round 1: the first version stripped
  qualifiers in one pass, so `gpt-6.1-sol (reasoning (high))` kept a
  `reasoning` fragment and looked distinct from `gpt-6.1-sol`, and any
  qualifier containing the word `unknown` widened a name, so
  `gpt-6 (reasoning unknown)` matched `gpt-6.1-sol`; `withoutQualifiers`
  and the anchored `MODEL_UNKNOWN_QUALIFIER` fixed both. Round 2:
  `gpt-6.1-sol reasoning: high` kept `reasoning:` and looked distinct,
  fixed by the colon and equals separators and `MODEL_WORD_EDGES`, and a
  `(version unknown)` name matched any name whose key contained its own,
  so `gpt-5.1-codex (version unknown)` matched `gpt-5.1-codex-max`, fixed
  by the token forms and `familyMatch`. Round 2 also made
  `references/inventory-and-concurrency.md` say exactly when the handoff's
  block ends. Round 3: compound effort fields such as
  `reasoning_effort=high`, `reasoning-effort: high`, and
  `model_reasoning_effort=high` still made the same model look distinct,
  fixed by `namingWords` (since replaced by `effortWords` and
  `effortDrops`), which dropped every effort word wherever it appeared.
  That first round 3 rule counted every level as an effort marker,
  so `model-max`, split into the helper `model` and the level `max`, was
  dropped as its own word and `vendor model-max` matched `vendor`; a
  follow-up limited `EFFORT_MARKERS` to `effort`, `reasoning`, and
  `thinking` and added `EFFORT_LEVEL_PARTS` for words made only of levels.
  Round 3 also made `references/recovery.md` say that a claim alone
  completes the handoff only for a checkout on its own branch. Round 4:
  `Claude Opus 5 (version unknown)` matched `claude-opus-5-5`, because the
  written `5` counted as a family prefix of `5.5`, fixed by refusing to
  widen a name that already ends in a version token; round 4 also pinned
  the standalone level tradeoff with the `Claude Opus 5.5 max` and
  `GPT-5.1 Codex Max` pairs. Round 5 (blocking): `GPT-5.1 Codex Max high`
  dropped both `Max` and `high`, so it no longer matched its own ID
  `gpt-5.1-codex-max` and a same-model review could pass, fixed by trying
  every subset of effort words to drop, up to six such words. Round 5 also
  found that a note of version numbers alone was removed like any
  qualifier, so `Claude Opus (5)` matched `Claude Opus (5.5)`, fixed by
  keeping such a note's contents in the name. Round 6: above six effort
  words only dropping all of them was tried, so
  `GPT-5.1 Codex Max model reasoning effort extra high mode` lost `Max`
  and missed `gpt-5.1-codex-max`, fixed by always dropping the certain
  words and varying only the levels, without the six-word cap; and a note
  with a version beside other words, such as `(5.5 high)`, was still
  stripped, so
  `Claude Opus (5.5 high)` missed `claude-opus-5-5` and
  `Claude Opus (5 high)` matched `Claude Opus (5.5 high)`, fixed by
  keeping any note with a version token. After round 6, the changelog
  writer's check against the round 5 code found that levels were kept
  only as a leading or trailing run, so `xhigh GPT-5.1 Codex Max high`, a
  match for `openai/gpt-5.1-codex-max` under round 5, no longer matched
  it; the fix tries every contiguous run of variable words kept and makes
  a helper word beside only a level, such as `Model` in
  `high Model 5.5 Max xhigh`, variable instead of always dropped. Round 7
  (blocking): keeping any note with a number left runtime notes in the
  name, so `gpt-6.1-sol (reasoning: high, budget: 32768)` looked distinct
  from `gpt-6.1-sol`; and only closed notes kept their version, so the
  unclosed `Claude Opus (5` and `Claude Opus (5.5` both lost theirs and
  matched (should-fix). `noteVersion` fixed both by keeping only a note's
  leading version, closed or not. After round 7, the changelog writer's
  check found that the same runtime field without parentheses,
  `gpt-6.1-sol reasoning: high, budget: 32768`, still looked distinct
  from `gpt-6.1-sol`, because `budget` and `32768` stayed in the name;
  `leadingWordsMatch` fixed it structurally by reading words after a
  complete model name as notes, and `noteVersion` now keeps a note's
  version as one dotted word. Round 8 (blocking):
  `gpt-6.1-sol budget: 32768` and `gpt-6.1-sol budget: 65536` looked
  distinct, because `leadingWordsMatch` only compared an annotated name
  against a bare one, fixed by giving each name its field-label and
  trailing-settings bases, each passed through `effortDrops` like any
  other. Round 9 (should-fix, cost), the final review at xhigh: two valid
  names packed with effort words and setting pairs took seconds to
  compare, because their readings multiplied and every pair rebuilt word
  prefixes, fixed by the reading count, `overflow`, and the precomputed
  `key` and `prefixes`. A coordinator follow-up stopped an over-cap name
  from hiding a requested-versus-reported mismatch: `reviewDisclosure`
  now discloses it with the next step, and `reviewModelProblem` refuses
  it. Round 10 found one doc nit in this entry, which said `effortDrops`
  had no cap, now fixed.
- Every caller picks the new comparison up: `diversity` (acceptance in
  `record-review`), `targetDistinctness` in `resolveReviewer` before
  dispatch (now `reviewer-not-distinct` for a `gpt-6.1-sol xhigh` target
  against a `GPT-6.1 Sol high` author in one harness), current validity of
  stored attempts, `reviewDisclosure` (a reported name that differs from
  the requested one only by effort or qualifier is no longer a `model`
  mismatch), and `reviewModelProblem` in `lib/authoring-onboarding.ts`, the
  onboarding R3' check that rejects a reviewer model equal to the agent's
  recorded one; `references/onboarding.md` adds one clause saying so. A
  stored attempt keeps its recorded `accepted: true` and
  `acceptanceReason: null`, but `currentValidity` re-judges it as
  `reviewer-not-distinct`, so it is no longer an approval candidate.
  `refinesIdentity` (0.30.0's identity completion,
  soundsystems/simple-changes!91) still compares reported models exactly
  and is unchanged.
- Tests: `authoring.test.ts` "model identity" checks 42 same pairs and 28
  distinct pairs in both orders. The same pairs include
  `(unknown version)`, a nested note, an unclosed one, a stray `)`,
  `reasoning: high`, `, effort=xhigh.`, `reasoning_effort=high`,
  `reasoning-effort: high`, `model_reasoning_effort=high` against
  `gpt-6.1-sol xhigh`, a leading `xhigh`, `Claude Opus 5.5 thinking mode`,
  `reasoning mode: high`, `Claude Opus 5.5 max`, `GPT-5.1 Codex Max`
  against `gpt-5.1-codex`, `GPT-5.1 Codex Max high` against
  `gpt-5.1-codex-max`, `GPT-5.1 Codex Max reasoning: xhigh` against
  `gpt-5.1-codex-max xhigh`,
  `GPT-5.1 Codex Max model reasoning effort extra high mode` and
  `high max xhigh GPT-5.1 Codex Max high max` against `gpt-5.1-codex-max`,
  `xhigh GPT-5.1 Codex Max high` against `openai/gpt-5.1-codex-max`,
  `high Model 5.5 Max xhigh` against `model-5-5-max`,
  `Claude Opus (5.5 high)` against `claude-opus-5-5`,
  `gpt-6.1-sol (reasoning: high, budget: 32768)` and
  `gpt-6.1-sol reasoning: high, budget: 32768` against `gpt-6.1-sol`,
  `Claude Opus (5.5, budget 1000)` and `Claude Opus 5.5 temperature 0.2`
  against `claude-opus-5-5`, `openai/gpt-6.1-sol ctx 200k` against
  `gpt-6.1-sol`, `vendor model-max` against `vendor`,
  `gpt-6.1-sol budget: 32768` against `gpt-6.1-sol budget: 65536`,
  `gpt-6.1-sol, reasoning=high` against `GPT-6.1 Sol thinking: 4000`,
  `Claude Opus 5.5 temperature 0.2` against `claude-opus-5-5 budget 100`,
  and `Opus (version unknown)` against `claude-opus-5-5`. The distinct
  pairs
  include `gpt-6 (reasoning unknown)` and `gpt-6 (unknown effort)` against
  `gpt-6.1-sol`, `gpt-5.1-codex (version unknown)` against
  `gpt-5.1-codex-max`, `Claude Opus 5 (version unknown)` against
  `claude-opus-5-5`, `Fable 5.1 (version unknown)` against `Fable 5.1.2`,
  `Claude Opus (5)` against `Claude Opus (5.5)` and against
  `claude-opus-5-5`, `Claude Opus (5 high)` against
  `Claude Opus (5.5 high)`, `Claude Opus (5` against `Claude Opus (5.5`,
  `gpt-6 budget 100` against `gpt-6.1-sol`,
  `Claude Opus 5 temperature 0.2` against `Claude Opus 5.5`,
  `gpt-5.1-codex budget 100` against `gpt-5.1-codex-max`,
  `Claude 3 Opus` against `Claude 3 Sonnet`, `Claude Opus 5` against
  `Claude Sonnet 5`, `Claude Opus 5 budget 100` against
  `Claude Sonnet 5 budget 100`,
  `Fable (version unknown)` against `claude-fable-mini-5-1`,
  `gpt-5.1-codex-max high` against `gpt-5.1-codex xhigh`,
  `Example Model 5.5` against `Example 5.5`, and
  `vendor coder-max high` against `vendor coder`. A separate test, "a name
  with too many readings to compare cheaply counts as the same, fast",
  checks that the round 9 names match in both orders and that a name just
  under the cap, `model-5` with fourteen `high` words, still matches
  `model-5` and not `model-6`, all within one second.
- Tests: `onboarding.test.ts` adds `author-model xhigh` and
  `Author Model (version unknown)` to the variants `reviewModelProblem`
  rejects, and checks that it refuses the over-cap round 9 name with the
  model ID message. `review-ledger.test.ts` checks that `reviewDisclosure`
  flags `model` with that message when either the requested or the
  reported name is over the cap. It also blocks the `gpt-6.1-sol xhigh`
  target against a `GPT-6.1 Sol high` author and a
  `gpt-6.1-sol reasoning_effort=high` target against a `gpt-6.1-sol` author
  in reviewer resolution, and resolves `gpt-6-sol`. It records a
  same-model attempt accepted without adversarial review and sees it keep
  its acceptance but fail current validity once adversarial review is on,
  rejects new same-model attempts reported as
  `gpt-6.1-sol model_reasoning_effort=xhigh` and `gpt-6.1-sol xhigh` with
  `reviewer-not-distinct`, and accepts `Astra medium`.
- Interim: 0.30.1 ships this name matching as it stands, and 0.31.0
  replaces it with a comparison of the canonical model IDs the harness
  reports, with display labels and effort as metadata only and missing or
  ambiguous identity failing closed. Until then, authors who want
  adversarial review to hold should pass the harness-reported model ID,
  such as `author attest --agent model-5-5`, rather than a display label.
- Adopted checkout handoff (`lib/loop-lease-verify.ts`, issue
  soundsystems/simple-changes#3): `staleClaimRecovery` appends
  `handoffHint(primary, linkedClaim, liveClaim)` to the
  `coordination-claim-stale` text. For a checkout other than the primary
  one, with no live claim, whose linked claim is `released` for a
  `COMPLETED_RELEASE_REASONS` reason (`owner-release` from
  `worktree release`, or `handoff`), the hint says the new owner may run
  the same claim and pause with its own agent ID and adapter, and the
  controller accepts that receipt. `nextCommands` still name the former
  owner; once a new owner holds a live claim, the hint is gone and the
  commands name the new owner. No state, schema, or command changes.
- `references/recovery.md` ("Released claims and paused changes") adds the
  handoff: a claim never moves, so the former owner releases and the new
  owner claims; while the link is stale every guarded mutation of the run,
  unrelated ones included, stays blocked; under `allow-claimed` with the
  shipment scope open, the new owner's valid claim on a checkout on its own
  branch (not detached, and not the primary or target branch) registers it
  as a concurrent author, which completes the handoff; otherwise,
  including for a detached checkout and after the scope froze when a
  controller relinquished or handed off, the new owner pauses with
  `preserve-in-place` and the controller runs
  `loop accept-paused-change`; and a checkout changed after its pause, a
  claim released before acceptance, another owner's live claim, and the
  former owner's old receipt are refused.
  `references/inventory-and-concurrency.md` says the release blocks the
  run's guarded mutations until the new owner's claim is registered or its
  pause is accepted, so an adopted checkout's claim is released only to
  hand it to a new owner who claims it right away.
- Tests: `loop-lease.test.ts` "hands an unchanged adopted checkout from a
  released bridge owner to a new owner" runs with the scope open and again
  after a relinquish froze it and a new controller resumed. Releasing the
  bridge claim yields one `coordination-claim-stale` with the hint and the
  bridge owner in the first command, the bridge receipt is refused, and a
  third agent cannot claim over the new owner's live claim. With the scope
  open, verification passes with the new owner registered as
  `concurrent-author`. After the freeze, the recovery names the new owner
  without the hint, a pause whose claim was released before acceptance and
  a receipt whose checkout changed after the pause are refused, and the
  unchanged checkout is accepted as `adopted-preserved` and `preserved`
  with its opening HEAD and change digest.
- Draft warning (`lib/shipment-outcome-draft.ts`, part a of issue
  soundsystems/simple-changes#4): `buildDraft` computes each unit's
  disposition and `finalPaths` once and passes them to the new
  `sourceMismatchWarning(unit, disposition, finalPaths, openingChanges)`.
  It flags each final path unless exactly one `shipmentScope.openingChanges`
  record for the unit's `sourceWorktree` and that path has a `sourceEntry`
  equal to the final target entry, the case `loop record-outcome` refuses
  without a reviewed primary-checkout result or an approved preserved-source
  override. The warning names up to `MISMATCH_PATH_LIMIT` (5) paths, counts
  the rest, and joins the existing `warnings` array, which
  `runLoopDraftOutcome` already emits in JSON and as `Warning:` lines.
  Suggested dispositions and `record-outcome` are unchanged.
  `references/focused-units.md` adds one sentence describing the warning.
- Tests: `shipment-outcome-draft.test.ts` expects no warning when the
  shipped bytes are the opening source result, and the warning naming
  `notes.md` plus record-outcome's refusal when a revision never reached the
  target. The new "warns when a suggested delivery is not the scoped source
  result" has a held unit edit `CHANGELOG.md` and `held.ts` while unrelated
  merged work changes `CHANGELOG.md`: the draft suggests `delivered`, warns
  naming both paths, record-outcome refuses it, and the CLI exits 0 with the
  `Warning:` line on stderr.
- Guidance stays at 30, with no guidance entry and no update notice.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-16T21:18:19-05:00" -->

## 0.30.0 - 2026-10-15

- Identity completion (`lib/review-ledger.ts`, issue
  soundsystems/simple-changes#2): `attestCommits` takes
  `completeIdentity`, the CLI's `author attest --complete-identity`. For each
  commit, `completionTargets` refuses an unknown anchor (session from the
  executing process, harness, or agent id: `identity-completion-unanchored`),
  any record under the anchor that disagrees with the completer on a known
  instance or reported model (`identity-completion-conflict`), and a commit
  with nothing to complete (`identity-completion-unmatched`), all before
  anything is appended; `--replays` with it is a usage error. It then
  appends the completer as an ordinary attestation (`recorded` or
  `unchanged`) and an `IdentityCompletion` under the new optional top-level
  `completions[<sha>]`, naming the exact `AttestedIdentity` records it
  completes. The result gains `completion`, `null` without the flag.
- `refinesIdentity(completer, earlier)` holds when both share one non-null
  session, harness, and logical id, every instance and reported model of
  `earlier` is kept exactly, and a missing instance or reported model is
  added. `reportedModel` decides what counts as reported, so the
  `most-capable` sentinel and blank names never count as the addition, and
  two partial records are never merged into an identity nobody reported.
- Resolution: `effectiveOwnAttestations` drops from a commit's own list the
  records named by a standing completion on that commit. A completion
  stands while its completer is attested there and every record under its
  anchor is `compatibleIdentities` with it. Completions are applied per
  commit before the replay union, so they never reach a source or a
  destination. `ResolvedNode` and `HeadCoverage` also carry
  `recorded`/`recordedAuthors`, every raw attestation unioned through the
  same replay links and shared with the effective map when no completion is
  in the ancestry. `identityFailure` returns `reviewer-not-independent` when
  any recorded author is the same executor, then `independence-unproven`
  when any effective author is unknown; diversity, preflight
  `adversarialOutcome`, coverage, and the authors digest read the effective
  authors, so a completion that changes a head's effective authors moves
  its digest and earlier accepted attempts fail approval with
  `authors-digest-changed`. One that changes nothing (a replay source still
  contributes the completed identity) leaves the digest, and approval still
  rechecks the recorded vetoes.
- Validation: `validateReviewLedger` accepts `completions` only when
  present, and `emptyReviewLedger` still omits it, so a ledger without a
  completion keeps the shape 0.29.x reads. `checkCompletions` requires each
  completer and completed identity to be an attestation on that commit,
  `refinesIdentity` to hold for each, no repeated identity in an entry, and
  no repeated completion. `evals/schemas/review-ledger.schema.json` adds
  `completion` and `attestedIdentity`.
- Why explicit: the suite already treats a second instance reusing an agent
  id in one session as a replacement agent with its own identity, so a
  derived rule would erase that agent's unknown-executor veto. Accepted
  residual: the completion trusts the executing agent's own statement that
  the earlier record was its own, bound to the session and harness read
  from the process, its agent id, and the claim or registration `author
  attest` already requires.
- Tests (`review-ledger.test.ts`, "identity completion"): the issue's
  reproducer through real `resolveReviewer` preflight and
  `recordReviewAttempt`, before and after a completion, with a reviewer that
  has a known distinct instance and no session; digest invalidation through
  `reviewApproval`; the CLI flag; and negative controls for another or
  unknown session, harness, or agent id, conflicting model or instance,
  the sentinel, same instance, same session with or without a reviewer
  instance under both adversarial settings, same reported model, unknown
  reviewer executor, a replay source's author, a second author whose model
  matches the reviewer, a later conflicting record, a recorded veto reached
  through two replay links, and refusals, including one on the second of two
  commits, that leave the ledger file byte-identical.
- SKILL.md reorder, written in the "Split Simple Changes SKILL.md by tier"
  session and copied byte for byte: `## Core workflow` moved verbatim to
  directly after the mode table (Classify, Core workflow, Authority,
  Router, Initialize, ...). The Authority section's `release-tag` paragraph
  moved verbatim to `references/changelog-coordination.md` `## Release
  tags`, and the Lease section's branch-audit paragraph, a summary of the
  rule `references/replacement-lineage.md` `## Audit before
  reapplying` states in full, is gone. Four pointer sentences are the only new text.
  SKILL.md is 306 lines and 17,479 bytes, inside the 17,500-byte budget.
  `skill-contract.test.ts` pins four headings in order and expects the tag
  rule in changelog-coordination.md. Forks that edit SKILL.md heavily (Hash,
  Secure) get an `update-local-forks` conflict with a `.upstream-merge`
  sidecar that shows Core workflow as a move; drop their own copies of the
  tag and branch-audit paragraphs while merging.
- Guidance 30 adds one behavior change, one integration change for the
  SKILL.md reorder, and one notice bullet, and needs no answer.
- Review of the reorder: GPT-6.1 Sol round 5 (xhigh, 5b02ae1) was clean
  apart from one nit, that the removed paragraph summarized the
  replacement-lineage rule rather than repeating it word for word.
- Review: GPT-6.1 Sol round 1 (high) found one blocking issue, a completion
  removing the session veto for a reviewer with its own instance, fixed
  with `recordedAuthors`, plus a missing unknown-harness control. Round 2
  (xhigh) found no bypass; it corrected wording that said a reviewer in a
  completed record's session is always rejected (only the vetoes the record
  carried remain) and that every completion moves the digest, and asked for
  the replay-veto and multi-commit refusal tests. Round 3 (xhigh) was clean
  apart from one code comment repeating the session claim, now corrected.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 high" at="2026-10-16T11:26:43-05:00" -->

## 0.29.2 - 2026-10-15

- `lib/repository-instructions.ts`: `SCRATCH_FILE_RULE`, the body of the
  `simple-changes:scratch-files` managed block, now gives each agent one
  scratch folder (the folder its brief names, the `workDir` a run reports,
  or a `mktemp -d` folder under the session scratch directory or the system
  temporary directory), has a parent give each agent it starts a folder
  inside its own, or the work directory a Simple Changes run prepared for
  it, and limits cleanup to that folder by its path, never by pattern,
  extension, or age in a directory other agents share. A folder a Simple
  Changes run reported is left for the run to remove. Both run clauses
  match what `references/inventory-and-concurrency.md` requires of a run's
  agents: a delegated author's folder is the sibling `workDir`
  `prepare-agent` reported, and the run removes it. The markers are
  unchanged, so `writeScratchFileRule` replaces an older block in place.
  The rule is 736 bytes, up from 348. The first draft was 960 bytes; its
  sentences on shared parent directories, hand-off files, and folders you
  did not create moved to `references/inventory-and-concurrency.md`, since
  the rule's four guarantees imply them.
- Also in `lib/repository-instructions.ts`: `inspectScratchFileRule(target)`
  returns `current`, `stale`, `absent`, or `invalid`, comparing through the
  writer's newline formatting so `stale` means exactly that
  `writeScratchFileRule` would change the file.
  `discoverGlobalInstructionTargets(environment, home)` lists the existing,
  unlinked `$CODEX_HOME/AGENTS.md` and `$CLAUDE_CONFIG_DIR/CLAUDE.md`,
  defaulting to `.codex/` and `.claude/` under `SIMPLE_CHANGES_HARNESS_ROOTS`
  or the home directory. `discoverRepositoryInstructionTargets(primaryCheckout)`
  lists the repository's `AGENTS.md` and `CLAUDE.md`, checking each on its
  own, so a linked, escaping, or irregular one is left out without hiding
  the other; setup keeps `discoverInstructionTargets`, which refuses the
  whole repository scope. `locateInstructionTarget(path, primaryCheckout)`
  gives an explicit path repository scope inside the primary checkout and
  user scope elsewhere. `lib/onboarding.ts` rewords the setup question and
  the **Add the rule** description to match.
- `initialize` adds the optional closed `scratchFileRule` field
  (`evals/schemas/initialization.schema.json`), null when it inspects no
  instruction file: `targets[]` of `path`, `scope`, `status`, and, for a stale
  block, a `refreshCommand` that runs the running copy's
  `scratch-file-rule refresh --instruction-file <path> --repo <repo>`. Text
  output names only stale and invalid blocks. Each file is discovered and
  inspected on its own, so one that cannot be inspected, such as a
  `CLAUDE.md` linked to `AGENTS.md`, is left out without hiding the other
  or failing initialization.
- New `scratch-file-rule refresh --instruction-file PATH`, implemented as
  `refreshScratchFileRule(repository, file)` in new
  `lib/scratch-file-rule.ts`: takes the loop state lock, reads the
  registered checkouts (new `registeredCheckouts` in `lib/work-directory.ts`)
  and the lease again under it, locates and classifies the target there, so
  a checkout registered meanwhile, such as one `prepare-agent` adds, is
  seen, rewrites a stale block through `writeScratchFileRule`, reports a
  current one unchanged, and refuses an absent block with exit 2 naming
  `setup --scratch-file-rule add` and an invalid one with exit 5. While any
  loop lease exists, including a paused or relinquished one, it also
  refuses, with exit 5 and "refresh it after the run ends", a
  repository-scope target or any target inside a registered checkout or a
  path the lease records, whatever its scope, since the run preserves those
  checkouts; a global file outside every checkout is still refreshed.
- `workDirectoryFor` in `simple-changes.ts`: inside a run, any agent ID
  without a same-session binding now gets a directory bound to the run, not
  only the controller and prepared authors, so `removeRunWorkDirectories`
  removes reviewers' and check runners' directories at a clean close. The
  first known session to use an unclaimed binding claims it for any agent,
  so an ID another session already bound gets its own unbound directory.
  Another known session reusing the controller's agent ID never binds,
  claims, or uses the run's directory, even one the controller has not
  bound or claimed yet, and gets an unbound directory of its own. A
  directory the session already holds is returned without a lock. Every
  bind and claim is decided again under the loop state lock (operation
  `workdir`), after re-reading the lease and the binding, so two concurrent
  first requests never each bind a directory and lose one, and nothing
  binds to a run that closed in the meantime. A busy lock, such as a
  controller's `loop exec`, is waited out for up to 30 seconds, polling
  every 250 ms, with a one-line stderr notice; only then does `workdir`
  exit 5 with the usual busy error. Tests shorten the bound through
  `SIMPLE_CHANGES_TEST_WORKDIR_LOCK_WAIT_MS`, honored only when `NODE_ENV`
  is `test`.
- `lib/loop-lease-core.ts`: `withLoopStateLockWaiting(commonGitDirectory,
  operationName, operation, { intervalMs, onWait, waitMs })`, re-exported
  from `lib/loop-lease.ts`, retries only a busy state lock, by recursive
  polling, and reports it busy as `withLoopStateLock` does once `waitMs`
  has passed; a permission or filesystem failure still fails at once.
- `lib/loop-lease-worktrees.ts`: `prepareAgentWorktree` takes an optional
  `onPrepared(prepared)` callback that runs under its own state lock, for a
  new and a reused preparation alike, after re-reading the lease and
  confirming it still names the run. `prepare-agent` binds the author's work
  directory there instead of after the lock is released, so a concurrent
  `workdir` request cannot bind a second directory for the same agent ID
  and a run closed in between is never bound to.
- `SKILL.md` keeps scratch files in the agent's own `workdir` directory,
  deletes nothing outside it, offers a stale block's `refreshCommand` once,
  and says an unrelated author's `workdir` waits for a busy lock. To
  stay inside the 17,500-byte budget it drops "use the same invocation
  everywhere", shortens the parallel-agents opening clause, drops the
  "Present update notices per" sentence, whose link the reference router
  already carries, and drops "distinct" before "worktrees and branches".
- `references/inventory-and-concurrency.md`: "Agent work directories" says
  `workdir` binds any agent of the run, that the first known session claims
  any binding, that another session on the controller's agent ID always
  gets its own directory, and that binding and claiming take the loop state
  lock, which `workdir` waits up to 30 seconds for before exiting 5. It adds
  the ownership rule: the directory and
  its contents are the agent's alone, a harness scratch directory is
  shared, only the run or the owner removes a work directory, nothing is
  deleted by pattern, extension, or age in a shared directory, and a file
  another agent reads stays until finalization.
  "Parallel agents" step 2 adds the `workDir` to every brief and a second
  required clause (scratch only in that directory, delete nothing outside
  it, leave it in place); step 3 leaves the directory in place.
  `references/setup-and-policy.md` documents `scratchFileRule`, the refresh
  command and its refusal while a run holds the repository, and the rule's
  run-retention clause, and
  `references/onboarding.md` and the README describe the new rule and
  command.
- Guidance stays at 29, with no guidance entry and no update notice: the
  stale-block report and refresh reach users who added the old block.
- Tests: `repository-instructions.test.ts` pins the rule's ownership,
  run-prepared child folder, and run-retention phrases, rejects "Delete
  them when the task ends", and covers `inspectScratchFileRule` (absent,
  current, stale, CRLF, invalid),
  `discoverGlobalInstructionTargets` (harness roots, the home directory,
  `CODEX_HOME`, a linked file skipped, an empty root), and
  `discoverRepositoryInstructionTargets` (a linked `CLAUDE.md`, a directory
  named `AGENTS.md`); `cli.test.ts` runs `initialize` against a fixture home
  with a stale global block, refreshes it, sees it current, refuses a file
  without the rule, reports a stale `AGENTS.md` beside a linked `CLAUDE.md`
  with its `refreshCommand`, and, with a run started, refuses to refresh the
  primary and a linked checkout's `AGENTS.md` but rewrites the global one,
  and refuses a checkout registered after the repository was located;
  `work-directory.test.ts` binds a reviewer's directory inside a run and
  sees finalize remove it with the controller's, lets the first known
  session claim a helper binding made without one while a second session
  gets an unbound directory, keeps another session on the controller's
  agent ID off a missing or unclaimed controller binding, exits 5 for a new
  bind or claim only after a shortened wait while the state lock stays held
  but returns a held directory, binds once a held lock is released within
  the wait, binds `prepare-agent`'s directory under preparation's lock for a
  new and a reused preparation, and keeps exactly one bound directory
  across four concurrent first requests; `skill-contract.test.ts` pins the
  SKILL.md sentences and the brief requirements.
- `docs/plans/2026-10-14-per-agent-scratch-folders.md` records the incident,
  the root cause, the design, the exact replacement rule as a diff for the
  user's global AGENTS.md, the fork pickup path, and the decisions taken on
  its open questions.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-14T17:15:30-05:00" -->

## 0.29.1 - 2026-10-13

- `lib/pinned-heads.ts`: `glabMergeArgument` also accepts
  `--<flag>=true|false` for the long no-value flags in `GLAB_MERGE_FLAGS`
  (`--auto-merge`, `--rebase`, `--remove-source-branch`, `--squash`,
  `--yes`). Short flags, other long options, and any other value are still
  refused, and exactly one `--sha` must still name the commit. 0.29.0
  refused Hash's guarded `glab mr merge ... --auto-merge=false` whenever a
  worktree was registered.
- `lib/authoring.ts`: `packagedHarnessDataPath(packageRoot)` reads
  `<package root>/agents/harnesses.json` and, for a package directory named
  `runtime` without that file, the fork's own `agents/harnesses.json` one
  level up, only when that file and its `agents/` directory are not
  symbolic links, so the copy cannot point outside the fork; a missing file
  still names the package's own path. The Hash and
  Pulse forks had added a `runtime/agents/harnesses.json` copy so
  `initialize` would detect agents; they can drop it at their next sync.
- `references/inventory-and-concurrency.md` names the on/off merge flags in
  the pinned provider-merge form.
- update-local-forks pin advance (from `fix/ulf-pin-advance`):
  `planForkUpdate` accepts `resolved: { against, paths }`, and the CLI takes
  a repeatable `--resolved PATH` with `--resolved-against COMMIT`, each
  requiring the other. A named file must conflict, merge, or already match
  the installed upstream; it becomes `keep-fork-delta` (a `current` file
  stays `current`) with a note naming the commit. Naming is refused when the
  commit is not the installed source's verified release, the file still has
  its sidecar, the plan would update, add, delete, or keep the file
  unchanged, or an unnamed update, add, delete, or merge into new bytes is
  still pending, which means the conflicting plan was never applied.
- Every named file binds `sidecarDigest: null`; apply checks its digest, or
  that nothing exists at its path when it was bound absent, and that nothing
  exists at its sidecar path. Plan validation lets entries other than
  conflicts bind only `null`. `advanceProvenance` sets the pin only when
  SKILL.md's entry is one apply writes or leaves alone, and while SKILL.md
  holds the pin the reason names the exact `--resolved SKILL.md
  --resolved-against <commit>` command. update-local-forks SKILL.md step 5
  and fork-sync.md ("Settle a held pin") document it, and both now say never
  to move the pin by hand.
- Tests: the pinned grammar accepts `--auto-merge=false` and
  `--remove-source-branch=true` beside `-R` and `--sha`, and refuses
  `--auto-merge=maybe`, `--message=x`, `-y=false`, and `--repo=x/y`; the
  harness lookup covers the upstream package, a fork's `runtime/` package,
  a copy inside `runtime/` winning, a missing file, and a symlinked
  `agents/` directory or data file, which are not followed. Each new test
  fails without its fix.
- Reviews (GPT-6.1 Sol): the runtime fixes took one high round, whose
  should-fix (the fork-level copy followed symbolic links) added the symlink
  guard, and an xhigh round that approved them. The pin advance took five
  rounds, high then xhigh: four found one gap each (kept files not
  rechecked at apply, a named current file left unbound, a directory or
  dangling symlink read as an absent sidecar, and an unnamed clean merge
  that let the pin advance before apply), each fixed with tests, and round
  5 was clean. The exact-head release review is recorded in the merge
  request.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-13T10:23:00-05:00" -->

## 0.29.0 - 2026-10-12

- Release integration: `release/0.29.0` merges `refactor/split-loop-lease`,
  `feat/run-work-dir`, and `fix/ulf-moved-code`, each built and reviewed on
  its own branch. The release branch adds the contract-test and preload
  fixes below, the guidance 29 entry, and this repository's guidance
  acknowledgements (`.simple-changes.json` guidance 28;
  `.simple-changelogs.json` guidance 26 with `releaseTags: "v{version}"`).
- Loop runtime split: `lib/loop-lease.ts` is now a facade of `export ... from`
  lines with one file-level `noBarrelFile` suppression, re-exporting the same
  86 names (54 values, 32 types). Its 350 top-level statements moved
  byte-identical into `loop-lease-core`, `-start`, `-status`, `-verify`,
  `-remote`, `-shipment`, `-mutation`, `-worktrees`, `-finalize`, and
  `-recovery`; private helpers a sibling needs are exported from their new
  module only. `lib/review-ledger.ts` imports `loop-lease-core.ts` directly,
  which removes the only runtime import cycle. A TypeScript-API proof
  (statements, export set, 10,497 identifier bindings, imports, cycles) ran
  outside the repository.
- Agent work directories (`lib/work-directory.ts`): private 0700 directories
  under `<tmpdir>/simple-changes-<uid>/<repo-slug>-<sha12>/`, or under
  `SIMPLE_CHANGES_WORK_ROOT`. The root is refused inside any registered
  checkout or the Git common directory, as a symlink, when owned by another
  user, when writable by group or others, or when an ancestor could be
  replaced by another user; missing parents are created one at a time. Runs
  bind each directory in
  `<git-common-dir>/simple-changes/work-directories/<runId>/<sha16(agentId)>.json`
  with the path and harness session, and the lease schema is unchanged.
  `LoopStartOptions.onStarted`, `LoopFinalizationOptions.onClosed`, and an
  `onClosed` argument to `endLoop` bind, clean, and sweep finished runs
  under the loop locks. Cleanup removes only this repository's canonical
  private directories bound to the run, never one holding a registered
  checkout, and an author's binding is claimed by the author's own session.
  The CLI adds `workdir --agent-id ID` and `workdir remove PATH`; JSON gains
  `workDir` (loop start, prepare-agent), `removedWorkDirectories` (loop
  start, finalize, end), and `bound` (workdir).
- Scratch-file rule: `setup` and `initialize` accept `--scratch-file-rule
  add|leave`. The rule is its own managed block with
  `simple-changes:scratch-files` markers, both managed blocks are validated
  together, nested or crossed blocks are refused, and non-interactive setup
  defaults to `leave`. Guidance 29 lists it as an onboarding change, not a
  recommended change, because the notice has no check for an existing block.
- update-local-forks moved code: a code file P conflicts when a significant
  line (an identifier character and at least 8 non-blank characters,
  compared trimmed after UTF-8 decoding and splitting at every line
  terminator) removed from P since the pin is among the lines added to any
  other installed upstream file, including files the plan never carries,
  and the fork's P differs from the pin in any byte or is missing. The
  content is the sidecar header plus the merged content or upstream P, with
  `sidecarDigest: null`; a fork that omits P gets a content-less conflict,
  and a P whose earlier sidecar still waits gets a conflict bound to that
  sidecar that holds the pin. An untouched fork's plan is unchanged by
  construction. Column-0 declaration names only word the reason and header.
  Plan entries gain an optional `notes` field (validated, rendered, ignored
  by apply) for the advisory stale-probe note.
- update-local-forks apply: before writing, it refuses a plan whose
  sidecars collide with planned paths or each other after NFKD, mark
  removal, and two-way case folding, or in which a file it writes or
  deletes shares a device and inode with another such file, with any file
  it leaves untouched, or with any sidecar already waiting beside an entry;
  it reserves every new path with `wx`, writes every
  sidecar first and again last, so a regular-file write that fails after the
  sidecars are filled cannot leave a conflict without its record, and
  verifies every write and every file a conflict keeps.
- Documented limits: a move that rewrites every significant line it
  carries, a declaration renamed while it moves, a conflict for any fork
  change in a file code moved out of, a resolved move that conflicts again
  while the pin is held for another reason, and filesystem aliasing beyond
  the folds and identity checks above, which apply's write verification
  reports as a failure.
- Test hygiene: the preload now also isolates `SIMPLE_CHANGES_CONFIG_DIR`
  and `SIMPLE_CHANGES_WORK_ROOT`. Before, an owner's personal
  `authoring.json` reached in-process tests and failed two review-ledger
  tests. The suppression check in `skill-contract.test.ts` scans every
  `loop-lease*.ts` module and requires more than one. The authoring-notice
  tests store guidance 27, the version before the review question, instead
  of the current version minus one.
- Guidance 29: four changes (work directory, scratch-file rule, moved-code
  conflicts, the split) and three notice bullets, the first two at priority
  185 and the fork bullet at 180, with no required answer.
- Reviews (GPT-6.1 Sol): the split was clean at high (three notes, one of
  which added an import audit to the proof). The work directory took four
  rounds, high then xhigh, the last with no actionable findings.
  update-local-forks took 14 rounds, xhigh after the first:
  rounds 1 to 5 kept finding ways to fool a parser-free declaration scanner,
  so round 6 onward reviewed the file-level rule instead, and rounds 6 to 13
  found only apply-side alias and input cases, each fixed. Round 14 found
  nothing blocking and two should-fix cases, a failed apply that advanced
  the pin before filling a sidecar and a hard link to a file apply leaves
  untouched; both were fixed with tests, and the owner ended the loop there.
  The first exact-head release review (xhigh) found one more such case, a
  sidecar waiting beside a review file whose digest the plan does not bind,
  and a wording nit; both are fixed, with a test for the first.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-12T19:09:00-05:00" -->

## 0.28.0 - 2026-10-08

- Release integration: `release/0.28.0` merges `feat/lighter-guidance`,
  `feat/authoring`, `feat/loop-tooling`, and `fix/pin-released-heads`, each
  built on its own branch and reviewed separately. Both the guidance and
  authoring branches had added a guidance 28 entry; the release keeps one
  entry with the authoring, pin, tooling, and lighter-guidance changes in
  that order and three notice bullets at priority 180 (authoring, pins,
  lighter guidance).
- Authoring preferences, implementing revision 13 of the authoring design:
  - `lib/authoring.ts` validates the sidecars (`.simple-changes-authoring.json`
    and a personal `authoring.json`; never a policy key), detects harnesses
    read-only from `agents/harnesses.json`, and resolves the `proposals` and
    `review` roles with per-field provenance across the request, repository,
    personal, and default layers. `setup --authoring <json-or-@path> --scope
    <repository|personal> --confirm` writes one sidecar under a lock beside
    it (never taken over automatically) and refuses a target whose bytes
    changed since it was read.
  - `lib/review-ledger.ts` keeps `review-ledger.json` under the common Git
    directory, written only under the loop lock. `author attest` (with
    `--replays`), `proposal record-authors`, `proposal record-review`, and
    `proposal waive-coverage` record authorship, replay links, coverage,
    waivers, and review attempts. A corrected replay mapping may add sources
    and is refused with `replay-correction-drops-source` when it would drop
    one. The post-return gate requires coverage, executor independence from
    every effective author, and, for an adversarial review, a different
    harness or model; escalation is a floor capped at xhigh.
  - `--authoring-request` on `initialize`, `proposal record-review`, and
    `loop start --mode resume` applies a complete sidecar object as a
    request layer for that invocation only. It is validated before anything
    is read or changed, never saved, and can only tighten `adversarial` and
    `escalateOnFindings`.
  - `initialize` reports `detectedHarnesses`, `authoringFiles`,
    `authoringQuestion`, `authoringReviewQuestion`, `authoringErrors`,
    `authoring`, and `reviewer`; `--proposal <id> --head <sha>` resolves the
    reviewer against that head's recorded authors. The guidance 28 required
    answer applies only while the review question is pending.
- Pinned heads (`lib/pinned-heads.ts`, `analyzePinnedCommand`), the design
  the user chose for the 0.27.1 known limit:
  - Released and handed-off authors pin to their recorded release;
    preserved, adopted, and retained worktrees pin to their baseline plus
    any `loop allow` heads; detached worktrees pin by path and head. A claim
    or older-style release with no recorded head refuses every use of its
    branch name. The controller, its prepared authors, and the primary and
    target branches are never pinned.
  - `assertPinnedHeads` runs in `loop exec` before `execGuard`. While units
    are pinned, only `git` runs (subcommand and per-command option
    allowlists, symbolic-ref following, indirect-name, path, configuration,
    and containment checks within 1,000 commits) and `glab mr merge <iid>
    [-R <project>] --sha <full commit>`; every other program is refused with
    one message. A refusal prints the commit-ID command when it is certain
    (fast-forward merge, cherry-pick, reset), else the claim, pause, and
    accept steps. `verifyLoop` with `forMerge` adds the
    `registered-branch-moved` violation.
  - Reviews kept finding interpreter and Git spellings that resolved a
    branch late, so the module refuses every program it cannot classify and
    every Git form that names no revision, guesses a remote branch, or
    resumes saved sequencer instructions. The release accepts a separate
    `-R` project on pinned glab merges, which this repository's merge gate
    requires.
- Lighter guidance: SKILL.md went from 29,555 to 17,462 bytes with the
  request table, invariants, and reference router first; the recovery
  catalogue moved verbatim to `references/recovery.md`. The contract suite
  holds SKILL.md to 17,500 bytes, requires every reference to be linked, and
  requires a Contents list matching the `##` headings in every reference
  over 100 lines.
- Packaged release notes: `skills/simple-changes/CHANGELOG.md` is a verbatim
  prefix of the root changelog covering the newest release's guidance
  version and the five before it, and `scripts/lib/release-history.json`
  records every release's version, date, and guidance version. Both are
  generated by `tooling/simple-changes/package-changelog.ts` (`--check` for
  drift). `release-notes --version` for an older release prints its
  canonical anchor and guidance notices and exits 6 (`--json` uses the new
  `release-notes-pointer` schema). update-local-forks never takes a window
  trim commit for a release's entry.
- Loop tooling:
  - `remote-inventory build` (`lib/remote-inventory.ts`, schemas
    `remote-inventory-pages` and `remote-inventory-decisions`) builds the
    opening receipt and, given it, the final reconciliation receipt with the
    validator's own digests. Deletions come only from provider records (a
    merge at the exact opening head, or with merged-head ancestry); any
    other deletion needs a decisions file. The GitLab fetcher
    (`scripts/adapters/gitlab-remote-inventory.ts`) pages with read-only
    `glab api` GET calls; the core calls no forge API.
  - `loop draft-outcome` (`lib/shipment-outcome-draft.ts`) binds the current
    target and lists every path changed since loop start with its exact
    entry (null when deleted), classified `release-generated` only when a
    changelog receipt's `paths` names it. Every reason, summary, and
    evidence item carries `SIMPLE-CHANGES-DRAFT:`, which `recordShipmentOutcome`
    refuses.
  - `status --all` (`lib/status-all.ts`) never writes, fetches, or locks:
    it skips `git status`, runs Git read-only with a direct binary, and
    reports any ref, commit, or state file it cannot read as unknown.
  - The lease target now resolves through `refs/remotes/<target>` or
    `refs/heads/<target>`, so a tag named like the target cannot stand in
    for it, and both tree readers use `--literal-pathspecs`.
- This repository's merge gate: `bun run check:receipt` writes
  `<git common dir>/check-receipts/<HEAD>.json` in the five-field format
  Simple Changelogs also uses, and `.simple-changes.json` registers
  `tooling/merge-gate/exec-guard.ts` as `execGuard`. It gates provider
  merges (CLI merges need `-R`), `git merge` into `main`, and pushes that
  move `main`; CONTRIBUTING.md lists the supported forms.
- The installed skill grew from 1,766,961 to 2,229,521 bytes and from 123 to
  142 files, packaged notes included. The largest additions are
  `review-ledger.ts` (118 KB), `pinned-heads.ts` (92 KB), and `authoring.ts`
  (42 KB); the packaged notes went from 96,948 to 43,684 bytes.
- Reviews (GPT-6.1 Sol, xhigh after the first finding): lighter guidance 3
  rounds, authoring 9, loop tooling 23, and pinned heads 22, each ending
  with no blocking or should-fix findings.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-08T17:15:02-05:00" -->

## 0.27.1 - 2026-10-08

- Toolchain pinned exactly to TypeScript 7.0.2, Biome 2.5.10, and Ultracite
  7.9.4, matching Simple Changelogs. TypeScript 7 type-checks all 344 files
  with no errors and still reports a deliberate type error.
- Install docs use the GitHub mirror. Skills CLI 1.7.0 records `sourceUrl`,
  so the GitLab update problem now affects older CLI releases and lock
  entries without a recorded URL.
- Codex eval adapter: `runner-response.schema.json` has no `uniqueItems`. A
  live probe (Codex CLI 0.160.1 on gpt-6.1-sol) accepted it, and the same
  schema with `uniqueItems` got HTTP 400 in strict mode. A guard test keeps
  the schema to probed keywords, closed and fully required objects, an object
  root, and supported formats.
- Every SKILL.md carries `license: Apache-2.0` and `compatibility`; a contract
  test enforces both and forbids `model`, `effort`, and `metadata.models`, and
  another keeps publish-skill's `metadata.internal` a YAML boolean.
  publish-skill's compatibility line is identical to the Simple Changelogs
  copy, adding Node.js 22.20 or later for the Skills CLI.
- `SPEC.md` moved to `tooling/simple-changes/SPEC.md`; the eval requires it
  there and refuses it inside the package. Forks receive the removal as a
  delete, or as a review item where they edited it. The installed skill went
  from 1,780,152 to 1,766,961 bytes and from 124 to 123 files, packaged notes
  included.
- Released-author admission: an owner release admits the checkout like a
  handoff only when the release recorded the exact state (owner, path, branch,
  head, and digest) and no unreleased claim holds the path; ownership is
  checked under the coordination lock. `worktree release` and `initialize
  --mode handoff` record that state, marked in the release event ID because
  the claim record is closed to fields older clients would reject. Releases
  from older clients, or with the checkout gone, recover through pause and
  accept.
- Cleanup follows owner releases and refuses any checkout that another
  holder's unreleased claim holds; before, only active claims counted, so a
  paused holder's checkout could be removed. A checkout whose claim this run
  adopted can still be cleaned once it is unchanged and contained in the
  target.
- Stale-author violations carry `LoopViolation.nextCommands` (optional) with
  the claim, pause, and accept steps, including `--repo`, and `loop verify`
  and `loop status` print them; guard and exec refusals point to `loop
  status`. A shared `pauseBlocker` detects checkout states that block a pause
  (missing checkout, Git operation in progress, conflicts), and the recovery
  printer, `staleClaimRecovery`, prints the unblocking step first, including
  for a relinquished controller or a primary checkout held by another agent. Accept and adopt treat a sibling's per-checkout violation that its
  own receipt covers as non-blocking.
- Known limit, shared with handoff admission and unclaimed stable worktrees:
  a third party that claims a released checkout and commits while a guarded
  `loop exec` merge of its branch runs can have that commit merged, and
  closing verification reports it only afterwards.
- Tests rose from 1,012 to 1,043, including the 0.27.0 deadlock reproduced end
  to end through the CLI; the ship records log 69 targeted mutant runs, 60 of
  them killed. Reviews
  (GPT-6.1 Sol): round 1 at high and 13 xhigh rounds; the last found nothing.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-08T03:40:00-05:00" -->

## 0.27.0 - 2026-10-07

- Changelog negotiation adds request v3 and receipt v4.
  - A receipt v4 release record carries a required `tag`, either null or
    `{name, message}`. `validate-changelog-transaction` refuses names Git
    would reject, a leading `-`, and names not bound to the version, and
    requires the tag to stay identical from prepare to verify; adding,
    dropping, or changing it is a protocol mismatch.
  - Negotiation now caps the receipt by the chosen request (v1 up to 2, v2 up
    to 3, v3 up to 4), so request v1 never meets receipt v3. A provider that
    advertises no shared request still reports the uncapped receipt overlap
    and stays incompatible.
  - The release-set check accepts v3 and v4 together and refuses two release
    trains naming one tag.
- `release-tag` (`scripts/lib/release-tag.ts`, schema
  `release-tag-receipt`):
  - `--dry-run` on the prepared receipt runs before the release merge and
    stops a release whose tag name is already taken.
  - Apply runs only after the release gate allows publication and with
    `--tag-automation-authorized`, for the active controller only, never in
    Sync or for a delegated author. It honors deploy and migration holds and
    refuses under `gitPushAuthorization: "never"` before any hold read.
  - It builds the tag with `git mktag` (unsigned, no ref), pushes it by
    object id with `--no-follow-tags` to the run's single-URL target remote,
    reads it back, and only then installs the local tag, so an unpublished
    local tag cannot leak through a later push. It never moves or deletes a
    tag, and a re-run reports `already-present`.
  - Any failed tag push is `push-rejected`, whatever the host's message says,
    and blocks the deployment. Exit 0 covers ready, created, already-present,
    and not-applicable; exit 5 is blocked; an unverified prior receipt exits
    3. Final verification requires `already-present`.
  - Writes go through the guarded executor, which now accepts in-memory
    input. Hold reads gained a `fetchMissing` option and fetch missing
    objects only through that executor, partial-clone lazy fetches are
    blocked, and when containment needs a newer branch head, apply runs one
    guarded branch fetch after every refusal has passed.
  - The target remote must be the only bound remote that matches the run's
    target ref and the remote that holds and read-back follow. A multi-URL
    remote is refused and prints no push command.
  - A target remote whose URL depends on Git's working directory is refused
    with `remote-not-single-url` before any write, in the dry run and apply:
    a relative or `~` local path, a `file://` URL without an absolute path, a
    Windows path without its drive, or an `ext::` or `fd::` helper. Shipment
    holds are read from the primary checkout while the tag is pushed from the
    controller's, so such a URL could name two repositories. Helper names
    follow Git's grammar, and the refusal names only the helper so a command
    line is never echoed.
- `update-local-forks` tries the `v<version>` tag first. It uses the tag only
  when its tree is byte-identical to the installed release and its commit is
  on the branch's first-parent history, fetches with `--no-tags`, and
  otherwise falls back to the history search with the reason.
- `SKILL.md` frontmatter states the release in `metadata.version`.
  `release-notes --check` requires it to match the packaged changelog's top
  release and `package.json`, and `update-local-forks` reads the installed
  and pinned versions from it before falling back to the changelog. Both
  readers use a small strict line reader instead of `Bun.YAML`, which older
  supported Bun versions lack.
- The changelog request and receipt schemas ship minified
  (`JSON.stringify(JSON.parse(text))` plus a newline) so Simple Changelogs
  can vendor them byte for byte; Biome skips both files, a contract test
  keeps them minified, and their advertised digests are unchanged.
- Guidance 27 has no required answers. `SKILL.md`, `SPEC.md`, the README, and
  the changelog-coordination, deployments, ship-communication, sync, and
  push-authorization references describe the tag step in host-agnostic terms.
  `.out-of-scope/hosted-releases.md` records why hosted releases are out of
  scope.
- The design followed a reviewed spec. Its deviations, kept small and
  reviewed, include the exit-3 refusal, `push-rejected` for every failed push
  (host-agnostic), the both-ways tag-unchanged rule, and listing CI files at
  the reconciliation head during a dry run.
- Tests:
  - `release-tag.test.ts` has 42 tests: 41 real-Git tests on temporary
    repositories and bare remotes, and one table test of the URL classifier.
    They cover a protected-tag rejection simulated with a `pre-receive` hook,
    a lost race, holds and waivers, Sync, older receipts, multi-URL and
    rebound remotes, a killed run, `push.followTags`, partial clones, a
    lightweight tag already on the target, and a linked worktree whose
    relative remote would have bypassed a hold.
  - Protocol tests show an older fork negotiating as before.
  - `update-local-forks` adds tests for the tag-first lookup and
    `metadata.version` reads, and `release-consistency.test.ts` covers the
    `--check` version match.
  - Mutation runs killed all 49 recorded mutants of the tag guards, and the
    release fixes were mutation-tested the same way.
- Reviews (GPT-6.1 Sol):
  - Round 1 at high effort found two blocking and two should-fix issues.
  - Five xhigh rounds followed, and the last found only a nit, now covered by
    a test.
  - The first release review, at xhigh, found the relative-remote hold
    bypass (blocking). Four more xhigh rounds fixed it and the later
    findings: helper-name grammar, Windows drive-relative paths, a refusal
    that could echo an `ext::` command, and a dependence on `Bun.YAML`. The
    last round found no blocking or should-fix issue. Its two nits, in the
    `metadata.version` reader, affect only unusual YAML: a comment-only line
    can shift the detected `metadata` indentation, and `0.27.0#preview` reads
    as `0.27.0`.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-07T14:50:00-05:00" -->

## 0.25.2 - 2026-10-06

- `acknowledge-update` writes through a new `writeGuidanceAcknowledgement` in
  `policy.ts`, which edits only `guidance.disposition` and `guidance.version`
  in the file's own text. It used to serialize the loaded policy through
  `writePolicyFile`.
  - Loading fills in defaults for missing keys and, without a matching trust
    receipt, reduces elevated settings: push `configure-harness` to `ask`,
    automatic migration to `ask-after-review` with its targets cleared,
    production `allow` to `ask`, and shipping to `standard`. The old path
    saved those reduced values, and it appended the defaults even to trusted
    policies.
  - The editor scans the JSON so it edits the key `JSON.parse` reads (the last
    duplicate) and inserts a missing `disposition` before the first guidance
    key in that object's own spacing. It writes nothing unless the edited text
    parses to the saved object with only those two values changed and passes
    the schema. A file that is not valid UTF-8 is refused unchanged.
  - `acknowledgeGuidanceUpdate(policy, …)` is replaced by
    `acknowledgedGuidance(disposition)`, which returns only the guidance
    record. The trust receipt is not renewed, as before, and the file mode is
    still reset to `0644` (`0600` for personal preferences).
  - Against Pulse's file from before its acknowledgement, the command now
    produces the bytes of the hand edit in `8f3d332`, for both a trusted and an
    untrusted copy. Downstream forks recorded guidance 26 by hand because of
    this defect.
  - Preserving bytes made a new escalation possible: changing only the
    guidance version of a confirmed policy left it untrusted with its receipt
    in place, and acknowledging could write those confirmed bytes back and
    restore its authority without setup. For a repository policy with
    elevated settings, the writer now refuses, exiting 5 and writing nothing,
    whenever the receipt's digest could match the bytes it would write; an
    ordinary policy may still return to its confirmed bytes. An
    acknowledgement that changes nothing writes nothing and reports
    `written: false`,
    the policy is re-read just before the atomic replace and refused if it
    changed or was removed, and outside a loop setup and `acknowledge-update`
    take the repository lock the loop already uses, so a concurrent setup
    cannot publish a receipt mid-write. A receipt that cannot be read blocks
    an acknowledgement that requests elevated authority until setup rewrites
    it. No receipt is ever created, renewed, or removed by an
    acknowledgement, and `loadPolicy` keeps its 0.25.1 receipt check.
- `update-local-forks` drops automatic version-literal rewrites.
  - Each fork-owned line holding `Simple Changes <old>` or
    `CURRENT_GUIDANCE_VERSION = <old>` is listed with its line number, the line
    as written, and a suggested replacement. A file listed only for these
    becomes a `review` entry. A merge, update, or conflict entry keeps its
    action and carries the list in its reason, and a conflict reads the live
    file. The plan format and schema are unchanged.
  - Carried files, byte-identical to upstream at the pin or in the installed
    release, keep upstream's bytes and are never listed, including with a
    pending `.upstream-merge` sidecar. A line in a fork-edited file that
    repeats upstream's text is not listed either.
  - The pin rewrite matches 0.25.1 except that it skips carried files, and
    record detection is unchanged.
  - Apply refuses, before writing anything, a saved plan that rewrites a
    version literal or a file the plan marks `current`.
  - Re-pinning Patrick and Pulse from 0.25.0 to 0.25.1 had proposed changing
    the carried `references/focused-units.md` line "Simple Changes 0.25.0 or
    later". An attempt to recognize minimum-version wording was replaced by
    this listing after xhigh reviews kept finding new forms. A simulated
    0.25.1 to 0.25.2 plan lists one line each for Hash, Patrick, and Pulse,
    and two for Site Secure, which is still pinned at 0.23.1.
- Tests:
  - `tooling/simple-changes/tests/guidance-acknowledgement.test.ts` (19
    tests) covers:
    - untrusted elevated settings surviving byte for byte;
    - the stale-receipt refusal built with a real setup, and the receipt
      check refusing an unreadable receipt;
    - a deleted, edited, or concurrently replaced policy, the no-op path, and
      the lock against a real concurrent setup;
    - unchanged run authority;
    - formatting cases: tabs, CRLF, missing trailing newlines, key order,
      compact objects, duplicate keys, and look-alike strings;
    - trusted receipts;
    - personal preferences;
    - UTF-8 refusal.
  - The 36 `update-local-forks` checks cover:
    - carried files;
    - every listed form: CRLF, invalid UTF-8, indentation, merged content,
      conflicts, and raw-line records;
    - sidecars;
    - the old pin in a carried file;
    - saved-plan refusals;
    - the pin still moving.
  - Mutation runs killed every mutant of the new logic.
- Reviews (GPT-6.1 Sol):
  - The acknowledgement fix passed its high review with no findings. The
    release review then found the stale-receipt escalation, and four xhigh
    rounds narrowed it to the final design, approved with no findings.
  - The final xhigh review of the listing design found nothing.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-06T19:45:00-05:00" -->

## 0.25.1 - 2026-10-05

- `update-local-forks` `locateSourceCommit` no longer checks only the commit
  that added the release entry (`git log -S"## <version> "` on the packaged
  CHANGELOG).
  - It also searches that commit's descendants on the searched branch, up to
    but not including the next release entry, which is a commit whose
    packaged CHANGELOG has a different top version.
  - It pins the earliest byte-identical packaged tree on the branch's
    first-parent history (the merge commit). It falls back to a merged
    side-branch commit, and never pins a guess.
  - For 0.25.0 the old search returned the release-prep commit `d98bf0b`,
    which five later review fixes made unverifiable. The new search resolves
    0.25.0 to `eb21066`, and all four Simple Changes forks had been pinned
    there by hand.
  - Per-commit lookups run in batches of 64 and stop once no window commit
    has an undecided child. One `rev-list` still lists every descendant
    through the tip, and a merge with a window parent keeps the walk open.
    The cache fetch depth stays at 400.
- `treeDigest` now proves byte identity on raw blob bytes and raw filename
  bytes.
  - Blobs are read undecoded through one `git cat-file --batch` per candidate
    tree.
  - The `ls-tree -z` listing and the installed tree's names are read as
    bytes, compared and digested as byte strings, and sorted by byte order
    instead of `localeCompare`.
  - It previously hashed UTF-8-decoded Git output against the installed
    files' raw bytes, so a same-size install with different content (such as
    `EF BF BD` for `F0 9F 92`) or with a differently encoded filename could
    verify, and a release containing invalid UTF-8 never could.
  - The path and size pre-filter only prunes trees; the raw digest decides.
- Plan and apply handle every file's contents as raw bytes, so a tree
  accepted by raw bytes is also written by raw bytes. File names must be valid
  UTF-8: planning refuses an installed source or fork with any other path, and
  verification never accepts a release tree that names one. Both name the
  path in hex, and raw filename bytes are not carried through planning, apply,
  or the plan file.
  - Fork files, installed sources, and pinned upstream blobs are read raw,
    and `git merge-file` takes and returns raw bytes.
  - The provenance and version-literal rewrites replace only printable ASCII
    literals and leave every other byte as written.
  - A saved plan stores content as UTF-8 text when it is valid UTF-8, as
    before, and otherwise as a new `contentBase64` field. The validator
    accepts only strict base64 (whole quads, correct padding, exact
    re-encoding), rejects having both, and requires ASCII literals.
  - Apply's changed-since-plan checks hash raw bytes. A plan saved by an
    earlier `update-local-forks` hashed and stored decoded text.
    - It still applies where every incoming and fork file is valid UTF-8.
    - Apply refuses it when an existing fork file is not valid UTF-8, but it
      cannot detect incoming content such a plan already decoded.
    - `fork-sync.md` says to re-plan whenever any incoming or fork file holds
      invalid UTF-8.
  - Pinned-tree paths (`treeFiles`) are listed with
    `git ls-tree -r -z --name-only` and split on NUL. A non-ASCII name such
    as `café.txt` was quoted by Git and misparsed, so the update after such a
    release was pinned failed as an invalid plan entry.
  - Without this, a newly verifiable file containing `F0 9F 92` would have
    reached the fork as `EF BF BD`.
- The version-literal rewrite treats a fork's history as records, while
  current sections stay rewritable:
  - A `#` heading is a history entry when it names a commit, range, or date.
    A commit is a 7 to 40 character hex token in backticks, after `pin`,
    `pinned at/to`, `commit`, or `sha`, or alone or listed in parentheses.
    Elsewhere a bare token must mix digits and letters, so words and plain
    numbers do not count.
  - A release number or the old version alone no longer marks history.
  - Under a heading starting with "Current", outside a history section, the
    body lines are rewritten even when the heading names the pin, and that
    heading ends the history run beside it. Headings themselves are never
    rewritten.
  - Subject-only sections that continue a history log, such as
    `## Local Blacksmith CI bridge`, are records.
  - Fences are tracked like the omissions parser, so a longer fence wrapping
    a shorter one no longer hides later headings.
  - A trailing `\r` is dropped for matching only, so CRLF notes classify like
    LF notes and keep their line endings byte for byte.
  - Setext headings are out of scope, and `fork-sync.md` says so.
  - Across the Thor, Hashi, Patrick, and Pulse forks, the only change from
    0.25.0 is that two Hashi history lines are kept. Thor's rewritten 0.24.1
    entry came from the stale global install (2026-09-02).
- Tests cover each search case, raw-byte identity including invalid UTF-8,
  current versus history sections, bare SHAs, the bounded walk, and a
  maintenance note in each real fork's heading style, a filename-collision
  fixture, CRLF notes, and a plan, JSON round trip, and apply of invalid
  UTF-8 through add, update, merge, and literal rewrite. They also cover
  invalid-UTF-8 paths, malformed base64, earlier saved plans, and three
  successive updates that add, change, and delete a non-ASCII-named file.
  Every rule was mutation-checked (863 + 18 + 31 tests).
- GPT-6.1 Sol (high) reviewed `323d98c`.
  - Blocking: decoded-text byte identity.
  - Should-fixes: current sections treated as history, bare abbreviated SHAs
    unrecognized, and overstated notes.
  - All of these are fixed above.
- GPT-6.1 Sol (xhigh) reviewed `6b0d4ad`.
  - Blocking: lossy filename decoding could verify a different tree.
  - Should-fix: CRLF closing fences were not recognized.
  - It also flagged overstated "Current" heading wording.
  - All of these are fixed above.
- Its xhigh re-review of `e83a4e9` was blocking because plan and apply still
  decoded and wrote text, which would corrupt a newly accepted
  invalid-UTF-8 file. Fixed above.
- Its xhigh re-review of `a747181` raised three findings, all fixed above:
  - blocking: a verified invalid-UTF-8 file name was silently skipped while
    the pin advanced;
  - should-fix: loose base64 validation;
  - should-fix: an overstated claim about earlier saved plans.
- Its xhigh re-review of `b1ce3ac` found nothing blocking. Its two
  should-fixes are fixed above:
  - LF-delimited pinned-path listing broke non-ASCII names;
  - the earlier-plan claim was still overstated.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T22:00:40-05:00" -->

## 0.25.0 - 2026-10-05

- Upstreams the generic runtime deltas the Thor and Hashi forks carried, so
  both forks can drop them:
  - `execGuard` (repo-policy schema, `policy.ts`, new `exec-guard.ts`,
    `process.ts` `runGuardInProcessGroup`) is an optional argv of 1 to 64
    strings, read only from the repository `.simple-changes.json`.
    - `loop exec` runs `[...execGuard, ...argv]` inside the exec lease after
      every other check, in its own process group. The working directory is
      the exec checkout, with `SIMPLE_CHANGES_RUN_ID` and
      `SIMPLE_CHANGES_REPOSITORY` set, and output goes to stderr.
    - A nonzero exit or a spawn failure refuses with exit 5 before the child
      starts. A surviving guard process group keeps the lock, like an exec
      child.
    - `withSavedExecGuard` keeps the guard through setup and
      `acknowledge-update`. It needs no trust receipt, because it only
      restricts.
    - It replaces the forks' `guardHostedCiMerge` import, which they now
      express as `pnpm --silent <cli> ci guard-exec --`.
  - `loop archive-recorded` (from Thor) adds `archiveRecordedOutcome`, kept
    first in the request so retries compare byte for byte. The kind is
    `loop-archive-recorded`, the outcome is `archived-unfinished`, and the
    attempt directory is `archive-recorded-<sha256(request)>`.
    - It requires the recorded receipt's run ID and digest, nonempty paths,
      the current target containing the receipt target, and matching tree
      entries.
    - Archived-lease validation ignores Thor's legacy
      `openingScopeInvariantDigest`, so Site Secure's three existing records
      still pass the retry checks.
    - `loop replan-status` gains `nextCommand`. `loop status` names the
      command for a released run with a recorded outcome, whether or not it
      is paused on a user question.
  - Preserved-source override (from Thor's `preserved-source-override.ts`):
    - `preservedSourceOverride` on shipment-outcome units is stored in
      `preserved-source-override/<run-id>.json` beside the lease, with the new
      `preserved-source-override.schema.json`. The lease keeps the stripped
      receipt, because its schema stays frozen at 0.22.0 for older clients.
    - `shipmentOutcome.receiptDigest` is the digest of the complete submitted
      receipt, overrides included, which is also what the Thor fork recorded.
      Without overrides it equals the stripped receipt's digest.
    - `--approved-by` and `--approval-reference` must match every override
      and are refused without one.
    - Finalize, `loop end`, the verified-delivery check, and
      `loop archive-recorded` recompose the stored receipt with the sidecar.
      They fail closed when the result does not match that digest, so editing
      any approval or path field after recording, or losing the sidecar,
      blocks completion. Finalize and `loop end` also re-check the source,
      claim, and target entries.
    - A pending `loop archive-recorded` transition, whether a first attempt or
      a retry after a crash between the intent and the rename, re-proves the
      recorded outcome with its sidecar immediately before the rename. A
      completed retry still returns without touching a successor run.
    - Site Secure's two override-carrying finalization records match this
      digest rule.
    - `loop record-outcome` and `loop end` hold the worktree-coordination
      lock.
- `repository-instructions.ts` names the running skill from its `SKILL.md`
  (`runningSkillName` in `skill-roots.ts`), in both the `scripts/` and
  `runtime/scripts/` layouts.
  - It reads the complete quoted or plain `name:` value and falls back to
    `simple-changes` unless that value is a valid skill name.
  - It keeps the markers unchanged and leaves the personal block's wording
    generic.
- `fork.ts` (a reverse index loop; `toReversed()` is outside the ES2022 lib),
  `git-worker.ts`, `subagent-control.ts`, and `turn-guard.ts` take forms both
  Biome and oxlint accept. Site Secure's oxlint 1.83 reports nothing over
  `scripts/`.
- `runInProcessGroup` (shared by `loop exec` children and the guard)
  previously killed only the leader when registering the spawned process
  failed, so a descendant could outlive the released lock.
  `unregisteredCommandCleanup` now handles that case:
  - On Unix it terminates the leader's whole process group directly, without
    waiting on the leader. A group that survives, or that cannot be
    signalled, raises `GuardedProcessGroupStillAliveError`, so the lock is
    kept.
  - A late child `error` event can no longer settle the run first.
  - On Windows, where no process group can be proven empty, it attempts to
    kill the process tree with `taskkill /t /f`, bounded at 10 seconds, and
    always keeps the lock, even when `taskkill` cannot run.
  - A cleanup that itself fails, synchronously or not, also keeps the lock.
  - The cleanup and `runInProcessGroup` take injectable process controls,
    with production defaults unchanged. `process.test.ts` covers a real Unix
    descendant, surviving and unsignallable groups, the Windows branch, late
    child errors, and failing cleanups.
- Guidance 26. There are 83 new tests (780 to 863), and each new guard was
  mutation-checked.
- Not upstreamed, because canonical already covers them:
  - Thor's claimed-author opening digest: scoped opening invariants already
    admit claimed authors' edits and refuse a drifted scope source.
  - Thor's in-receipt advanced merged proof: `mergedHeadAncestry` covers it.
- GPT-6 Sol (high) reviewed `45ed850`.
  - Its blocking finding was that a registration failure could leave a
    guard's descendants running after the lock was released.
  - Its should-fix was that the archive hint was missing for a run paused
    with `--awaiting-user`.
  - Its re-review of `d98bf0b` found three gaps in the first fix: a failed
    leader kill could settle the run before group cleanup, Windows had no
    cleanup, and the leader wait had no deadline.
  - Its second re-review found that a `taskkill` that could not launch still
    released the lock.
  - All of these are fixed above.
- GPT-6.1 Sol (high) reviewed the whole branch at `ebf349e`.
  - Blocking: override approval evidence could be edited after recording
    without detection, because the sidecar was bound only to the stripped
    receipt.
  - Should-fixes: the Windows `taskkill` was unbounded, and the cleanup
    failure paths had no tests.
  - Nit: the skill-name parser accepted a prefix of an invalid `name:`.
  - All of these are fixed above.
- GPT-6.1 Sol (xhigh) reviewed the whole branch at `12dd6c4`. Its one finding
  was blocking: a pending `loop archive-recorded` retry after a crash skipped
  the override check, so an edited or deleted sidecar could still archive.
  It is fixed above, with crash-retry tests for intact, edited, and missing
  sidecars.
- GPT-6.1 Sol (xhigh) re-reviewed the whole branch at `195e97a` with nothing
  blocking. It raised two should-fixes and a nit, now fixed:
  - Independence compared untrimmed agent IDs, so a padded controller or
    author ID passed. Override checks now compare trimmed IDs.
  - A 0.24.1 runtime could finish an override-bearing run without the
    sidecar checks. `focused-units.md` now requires 0.25.0 or later to finish,
    end, or archive such a run.
  - `runningSkillName` accepted `fork-` and `fork--name`. It now shares
    `isValidSkillName` with `skill check`.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T19:22:39-05:00" -->

## 0.24.1 - 2026-10-05

- `release-gate.ts` adds `assertVersionResolution` (the new ask-policy
  pairing check plus the existing selected-version check, extracted to keep
  `validateModernTransaction` within its complexity limit); a mismatch is a
  protocol mismatch for every receipt status. Simple Changelogs refuses to
  emit the pairing since soundsystems/simple-changelogs!68; this is the
  controller-side check. `release-gate.test.ts` adds both forbidden pairs
  and the allowed ask plus explicit direction, and a mutation dropping the
  check fails it. `references/changelog-coordination.md` states the rule.
  GPT-6 Sol's review asked to narrow the customer note: the gate rejects the
  two pairings but still trusts a provider's explicit-direction claim.
- `update-local-forks` `renderPlan` lists `skip` rows; the CLI check
  asserts the `CHANGELOG.md` row in plain-text output.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T17:17:45-05:00" -->

## 0.24.0 - 2026-10-05

- `references/change-requests.md` gains `## Body shape`, placed before
  `## Agent signatures` so the replacement-lineage and pagination rules keep
  their place: a Summary, Evidence, and Merge danger template; the menu of
  summary views (Mermaid only where the provider renders it); a door rule
  bound to evidence the run already collects (destructive, irreversible, or
  unbounded migration or data change; `incompatible` or `unverified`
  installed-client compatibility; anything leaving the repository; a removed
  public interface; `unknown` when evidence is missing); repository proposal
  templates first; and a rewrite of affected sections when review or a rebase
  changes them. `SKILL.md` core-workflow step 7 now points at the section, and
  the README gains a Credits section for Matt Pocock's `pr` and `code-review`
  skills (v1.3.0, MIT) and Dex Horthy's `show-me`.
- `references/review-and-merge.md` gains `## What an agent review examines`:
  pin the exact revisions and a non-empty diff before dispatching any
  reviewer, run Standards and Spec as separate reviewers when the host can,
  and report them without merging or reranking.
- Guidance 25: `CURRENT_GUIDANCE_VERSION` is 25 with one closed definition
  (two `behavior` changes, notice-bullet priority 165,
  `changelogReviewRelevant: false`) whose strings Claude Fable 5.1 wrote.
  `initialization.test.ts` expects the two new versions and the new
  top-three bullet that displaces the `proposalSignatures` one.
- Shipped `lib/skill-check.ts` (`simple-changes skill check`) parses every
  `SKILL.md` frontmatter as strict YAML and requires a lowercase hyphenated
  name matching its directory (at most 64 characters), a 1 to 1,024
  character description, matching Claude Code and Codex invocation settings,
  and resolving relative links; `checkSkill(dir, { selfContained })` returns
  issues with closed codes. `tooling/simple-changes/eval.ts` runs it with
  `selfContained: true` for every skill under `skills/`, so installable links
  must also stay inside the package; forks such as thor that link into their
  own repository pass the shipped check. An unquoted colon-space, an empty
  frontmatter block, and an invocation mismatch each fail.
- `lib/proposal-audit.ts` reuses `auditMarkdown`, exports
  `SIGNATURE_LINE_PATTERN` (built from `ROLE_LABELS`), and validates output
  against a closed `proposal-audit` schema; `lib/markdown.ts` gains
  `proseLines` and `withoutHtmlComments`. Five fixture bodies cover the
  failures.
- `lib/fork.ts` adds `forkDescription`, replaces folded descriptions too,
  rewrites the fork's `agents/openai.yaml` (display name, short description,
  and `$<name>` in the default prompt), and adds `CreatedFork.description`.
- `lib/skill-roots.ts` now owns `globalSkillRoots` (moved from changelog
  coordination, behavior unchanged) and adds `skillRootOf`, `isForkRuntime`,
  and `globalRuntimeScripts`. `hookInstallScript` sends a fork to the first
  qualifying global runtime, and `stopHookStatus` refuses to write a hook
  that runs a fork's runtime; SPEC.md says the user-level hook never runs a
  fork's runtime.
- update-local-forks gains an `unrecorded-omission` action, an exported
  `intentionalOmissions` parser, a `holdPin` shared with command-gate review,
  and `ApplyReceipt.unrecordedOmissions`. Planned read-only against this
  branch, hashi, patrick, and pulse each hold on `change-requests.md` and
  `review-and-merge.md`, and thor on 11 files. A plan saved by the previous
  version fails validation on apply and must be re-planned.
- Guidance 25 gains a third behavior line for these changes; there is still
  one definition. Tests: 754 simple-changes (27 new), 17 publish-skill, and
  14 update-local-forks (2 new) pass.
- `evals/cases.json` adds three journeys (42 total):
  `queue-proposal-body-one-way-door`,
  `queue-proposal-body-repository-template`, and
  `integrate-two-axis-agent-review`.
- `publish-skill` is user-invoked (`disable-model-invocation: true` paired
  with `policy.allow_implicit_invocation: false`) and is a three-way merge
  with the Simple Changelogs copy from their shared base (`6ae4f5c` here,
  `7a1bf07e` there): the `superseded-install` consumer state, its
  combined-distribution topology rule, and its tests arrive, the production
  loop uses `update-local-forks` only when the canonical package bundles it,
  and `discover-local-consumers.check.ts` runs every spawn with an empty
  fixture `HOME` so real global installs cannot leak in. Skill and tooling
  trees are byte-identical across both repositories.
- `.out-of-scope/` records four declined requests (a general task scheduler,
  vendor agent API calls, changelog authoring and version choice, automatic
  rewrites of another task's worktree), each citing the plan and commit that
  decided it; `CONTRIBUTING.md` points to it.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T13:11:05-05:00" -->
- Changelog receipt schema (byte-identical to Simple Changelogs): a
  `classified` receipt's `versionDecision` is now `anyOf` the entry-only
  `none` decision or a resolved public decision (release-bearing boundary,
  `ask` or `automatic` policy, `automatic`, `explicit-direction`, or
  `repository-automation` resolution, non-empty `selectedVersion`), and
  `revisionLineage` must be null on both revisions. `release-gate.ts`
  rejects a classified receipt that names a release, and an entry-only
  handoff must also leave `policyAction` `not-applicable` and
  `suggestedVersion` null.
- `lib/schema.ts` no longer returns early after `anyOf`: a failed branch
  match is recorded and the node's sibling keywords (`const`, `type`,
  properties) are still validated, which the new `anyOf` beside
  `type: object` needs.
- `startLoop` sets `shipmentScopeRequired` for every Ship run and, on a clean
  start, writes `shipmentScope` from a `buildPreviewPlan` of the opening
  inventory against itself (empty `openingChanges`, the opening baseline
  digest, the plan and its digest) while the integration and coordination
  locks are held. Old runs are not repaired. `replan.test.ts` fixtures follow;
  loop-lease, release-gate, schema, and CLI tests add coverage (283 pass
  across the five files).
- Authored in a parallel Codex/Claude session on
  `fix/protocol-scope-20261005` and folded into this shipment by merge.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T13:48:48-05:00" -->
- `update-local-forks` literal rewrites go through an exported
  `rewriteLiteral(forkPath, content, from, to)` at both plan and apply time, so
  a plan lists a rewrite only when a current claim changes and apply rewrites
  exactly those lines. Records are kept: any line matching a SHA or semver
  range, and in Markdown (fence-aware) every heading plus every line under a
  heading stack where some heading names a range, a `YYYY-MM-DD` date, the old
  literal, or `history`. The plan format is unchanged. Found while
  re-baselining thor, whose short pin `628c66b` would have rewritten its
  `7ab67a1..628c66b` sync heading, a history bullet, and the `test.sh` line
  asserting that heading (3 occurrences before, 0 after). One new test (15
  pass).
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T14:14:40-05:00" -->
- Upstreamed from the Hash (`hashi-simple-changes`) and Site Secure
  (`thor-simple-changes`) forks, which carried these as runtime deltas from
  pin `7ab67a1` and hand-merged them on every sync.
  - `remote-branch-reconciliation.ts` adds `finalProposals` (records with
    `observedFinally !== false`), which both forks wrote independently.
    Open-branch protection, `validateDeletedMerged`, and
    `assertAuditedClassification` judge the final snapshot; supersession
    passes every observed state and keeps its all-record open check.
    `needsAncestryShape` in `loop-lease.ts` follows the same rule for its
    missing-sidecar hint, and `validateAncestryMerged` judges "another open
    proposal" from the final snapshot too. Behavior change: a same-head merge
    now validates without `mergedHeadAncestry` (the test that asserted the old
    rejection is rewritten), and the fast-forward shape now fails on the
    merged-head rule rather than the open-proposal rule. Because the sidecar
    was also where Git checked target containment, `assertRemoteBranchAncestry`
    now requires the target to contain the head of every `deleted-merged`
    branch whose proposal was open at the opening inventory and that has no
    sidecar, so a squash merge or a merge into another branch still fails
    closed.
  - `loop-lease.ts`: `closeEquivalentObligatedPaths` adds every
    `shipmentScope.plan.units[].sourceWorktree`; the new exported
    `completedRemovalProofForPath` proves a missing obligated path from a
    completed `remove-after-audit` disposition whose `targetRevision` and
    `headSha` the refreshed target contains; and the new exported
    `frozenRecoveryBlockingViolations` drops only
    `missing-preserved-worktree`, `missing-retained-worktree`, and
    `preserved-worktree-changed` for unclaimed, unpaused, non-obligated
    preserved or retained registrations other than the primary checkout
    once the scope is frozen. Site Secure's version lacked the primary
    exclusion, which `finalization-records.test.ts` caught: after an
    interrupted primary update, a close must not absorb new primary work.
  - `completedRemovalProofForPath` also requires the path to be gone from
    disk, checked with `lstat` so a dangling symlink recreated there counts
    as present. A patch-equivalent removal is not re-proven by it, so a close retry
    after one fails closed.
  - Tests: `remote-branch-reconciliation.test.ts` gains four cases and
    rewrites two (the behavior changes fail on the old code);
    `loop-lease.test.ts` adds a Git-backed same-head case that records when
    the target contains the head and refuses the squash shape; and the new
    `close-equivalent-recovery.test.ts` adapts Site Secure's twelve unit
    cases and adds primary-checkout and recreated-path cases. Mutations that
    drop the scope obligation, the containment check, or the final-snapshot
    ancestry rule each fail a test.
  - GPT-6 Sol (high) reviewed the port independently. Its one blocking
    finding (the missing containment check) and its should-fix findings (path
    presence, the ancestry-path rule, retained wording) are fixed above; the
    patch-equivalent retry limit is kept as fail-closed. A focused re-review
    confirmed the fixes and raised the dangling-symlink case, fixed above, and
    noted that a branch already merged at the opening inventory is still
    trusted from GitLab's merged state without a Git containment check; that
    rule predates this change and is what lets squash-merged branches be
    cleaned up, so it is unchanged.
  - Not upstreamed. Already canonical: hashi's `release-gate.ts` and
    receipt-schema changes (`6466606`), thor's claimed-author opening digest
    (the scoped first-scope check ignores authors' worktrees), thor's
    untouched-run close, and hashi's `worktree retire-missing-claim` (absent
    claims are released at finalize, handoff, and `worktree cleanup` since
    `91a8742`; Hash has no retirement receipts). Covered differently: thor's
    `merged-proposal-advanced-target-contained` proof
    (`mergedHeadAncestry`). Fork-specific: both Blacksmith merge guards and
    thor's lint-only rewrites. Policy decisions left in the fork: thor's
    manual `semantically-equivalent` preserved-source override (SPEC.md says
    equivalence evidence never asserts semantic equivalence) and its
    `loop archive-recorded` recovery.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T15:08:28-05:00" -->

- Fixes from GPT-6 Sol's exact-head review of soundsystems/simple-changes!80
  (no blocking findings; four should-fix):
  - `discover-local-consumers.ts` marks a standalone CMS install
    `superseded-install` only when `.simple-changelogs-cms.json` exists,
    which the combined package's cleanup rule requires; a new check case
    keeps both installs without it.
  - `references/changelog-coordination.md` no longer calls `classified`
    entry-only; it may carry the exact selected public version.
  - `proposal audit` with `--template` requires the template's headings and,
    when the template has none, a `## Merge danger` section; Summary and
    Evidence may still map to template sections.
  - `update-local-forks` skips every `*CHANGELOG*.md` in literal rewrites,
    and lists a fork's own root `CHANGELOG.md` once (as the `skip` entry)
    instead of also as `keep-fork-only`; the duplicate made `apply` reject
    the plan for any fork with a root changelog (none of the four current
    forks has one).
  - A focused re-review confirmed all four and found the docs behind:
    `production-loop.md` now keeps a standalone CMS install while the
    sidecar is missing, `change-requests.md` says a template never replaces
    Merge danger, and the text plan counts skipped fork-owned history.
  - Each fix has a case that fails when the fix is removed. The
    `publish-skill` change is byte-identical in Simple Changelogs.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T16:23:15-05:00" -->

## 0.23.1 - 2026-10-03

- `lib/initialization.ts`: `inspectInitialization` now returns
  `productionDeploy` from the loaded, trust-downgraded policy (default
  `ask`), and `renderInitialization` in `simple-changes.ts` prints
  "Production deploy: <value>"; `evals/schemas/initialization.schema.json`
  gains an optional `productionDeploy` enum (`ask`, `allow`, `deny`) whose
  description says it is effective after the repository trust downgrade and
  present from 0.23.1, so an absent value means an older runtime and output
  from earlier CLIs still validates. `references/setup-and-policy.md` says
  initialization returns the effective `productionDeploy`, which is where
  `release-gate --production` starts (see changelog coordination) instead of
  a value read from the policy file. `references/changelog-coordination.md`
  gains a paragraph after the release-gate decision rule: the gate takes its
  flags on trust and grants no authority, so no printed action is
  permission; each flag's only source (`--production` starts from the
  `productionDeploy` that `initialize --json` reports, which already applies
  the trust rule in setup-and-policy, a repository `allow` without its local
  trust receipt being `ask`; current user direction may lower it, for
  example to `deny`, and never raises it above `ask`, and a user's
  production approval goes in `--production-authorized`;
  `--production-authorized` is explicit current-request authority under
  SKILL.md and the ship-communication direction section;
  `--version-authorized` is a user decision bound to the decision digest;
  `--already-live` is fresh provider evidence for the exact verified
  finalized target); route on the printed `action` because every decision,
  including `block`, exits 0, and a nonzero exit means the inputs were
  rejected and nothing was decided, which blocks the boundary. Its "Shared
  version lines" section now says the negotiated versions alone decide
  availability, that the `shared-version-lines` feature is optional and
  informational, and that a provider may leave it out until it gates real
  behavior, replacing "advertises together with the `shared-version-lines`
  feature"; the rollout note now says 0.13.0 and later ignore unknown
  versions, earlier releases reject them (so advertising request v2 or
  receipt v3 needs every controller at 0.13.0 or later), and releases before
  0.23.0 reject unknown features. `references/deployments.md` says
  repository policy is effective only with its local trust receipt, per
  setup and policy, and that a `release-gate` decision is never that
  authority. `SPEC.md` adds a forbidden practice: passing `release-gate` a
  flag its documented source does not support (effective policy, a matching
  user decision, or fresh provider evidence), treating its printed decision
  as authority, or routing on its exit code instead of its `action`. The
  runtime holds no user-authenticated authority record to check the
  user-authority flags (`--production-authorized`, `--version-authorized`)
  against, so a required provenance argument would be another agent-written
  string and echoing the flags would repeat the command line; that is why
  those stay prose.
- Tests: `initialization.test.ts` adds "reports the effective production
  deploy policy" (default `ask`, trusted `allow`, and `deny`); the
  `cli.test.ts` unconfirmed-consequential-policy test now asserts
  `productionDeploy: "ask"` in JSON and "Production deploy: ask" in text,
  then `policyTrust: "trusted"` and `productionDeploy: "allow"` once the
  trust receipt is written;
  `skill-contract.test.ts` adds "release-gate flags come only from their
  sources and features stay informational", pinning the new sentences in
  `SPEC.md` and the three references, including the `initialize` sentences
  in changelog-coordination and setup-and-policy, and asserting the old
  "advertises together with" wording is gone; `protocol-cli.test.ts`
  extends the release-gate test to assert that the `deploy` call exits 0,
  that a request with an unverifiable `priorReceiptDigest` yields
  `action: "block"`, `reasonCode: "malformed-request"`, and exit code 0, and
  that a mismatched `--prior-receipt` exits 3 (validation) with no `action`
  and "Prior receipt digest does not match" on stderr. Full suite: 727
  tests. Independent review by Opus 5.5 (high) over five rounds: its
  findings are addressed in prose except two kept by design, the
  user-required "current-request" wording and "until it gates real
  behavior"; the M1 follow-up, reporting `productionDeploy` from
  `initialize`, is included in this release. Guidance stays at 24;
  `.simple-changes.json` is unchanged.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-03T14:33:42-05:00" -->

## 0.23.0 - 2026-10-03

- New `lib/version-line.ts`: `parseStableVersion` and `compareStableVersions`
  (one to three dotted numbers, zero-padded, `+build` ignored, anything else
  null); `assertVersionLine` with `assertMembers`, `assertHead`,
  `assertOutcome`, `assertAboveCurrentVersion`, and `candidateOf` (the
  suggestion on `decision-required`, the selection otherwise);
  `sameLineState`; `assertReleaseSetTrains`; and
  `assertReleaseSetConsistency` with `assertSharedReleaseSet`,
  `assertLineMembership`, and `lineSelections`. `lib/release-gate.ts`:
  `validateModernTransaction` replaces the v2-only `validateV2Transaction`
  and handles v2 and v3 receipts, `validateChangelogRequest` is exported,
  `assertDigestCoversVersionLine` fails closed when a prior v3 receipt with
  the same `decisionDigest` differs in `sameLineState` (`mode`, `members`,
  `memberVersions`, `sharedVersion`; `outcome` may change), new
  `validateChangelogReleaseSet(receipts)` returns `{ releaseSetId, receipts,
  lines, missingTrains }` and backs the `validate-changelog-release-set`
  command in `simple-changes.ts` (usage error below two files), and
  `negotiateChangelogProtocol` is open: unknown versions and features are
  ignored and the producer's order is kept. `lib/types.ts` adds
  `ChangelogFeature`, `VersionLine`, `VersionDecisionV3`,
  `ChangelogReceiptV3`, and `ModernChangelogReceipt`; `ChangelogCapabilities`
  is open (`number[]` and `string[]`), and `ChangelogRequest` gains
  `releaseSetTrains` and `schemaVersion: 1 | 2`.
- Schemas: `changelog-request` now has `$defs.v1` and `$defs.v2` with a shared
  `phaseRules`, dispatched by `if`/`then`/`else` on `schemaVersion` so an
  invalid request still gets field-level errors; `changelog-receipt` adds
  `$defs.v3`, `versionDecisionV3`, `versionLine`, and `stableVersion`, with
  the v1 and v2 definitions byte-identical to before; `changelog-capabilities`
  `features` is open strings. `lib/schema.ts` enforces `minProperties` and a
  schema-valued `additionalProperties` and uses `Object.hasOwn` for
  own-property lookups. `adapters/deployment.ts` gains a
  `releaseBindingIssues` helper that accepts receipt v2 or v3, and it and
  `lib/release-delivery.ts` refuse a `schemaVersion: 1` receipt with a
  message instead of crashing. `references/changelog-coordination.md` gains a
  "Shared version lines" section and the 0.23.0 rollout note;
  `references/deployments.md` now says "v2 or later".
- Tests: `release-gate.test.ts` grows from 22 to 42, `protocol-cli.test.ts`
  from 5 to 6, `schema.test.ts` from 18 to 19, `adapters.test.ts` gains
  legacy-receipt checks, and `skill-contract.test.ts` pins the new reference
  sentences. Full suite: 725 tests. Independent review by Opus 5.5 (high)
  over three rounds found release-set membership and duplicate gaps, request
  errors collapsed into one message, blocked receipts losing their routing, a
  bump-shared exception that let a train reuse a partner's number, an
  over-strict digest check that refused approved overrides, and an
  over-strict current-version check; all are fixed or reverted with
  regression tests. Guidance stays at 24; `.simple-changes.json` is
  unchanged.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T18:50:32-05:00" -->

## 0.22.5 - 2026-10-02

- `lib/subagent-control.ts`: new `expandLiteralAssignments(command)`, applied
  in `loopInvocations` to both parent and subagent transcripts, replaces
  `$NAME` and `${NAME}` with the literal the same command assigned to NAME.
  `characterContexts` marks each character's quote, comment, and heredoc
  context; `nameBindings` counts every binding of each name, the
  `LITERAL_ASSIGNMENT` form plus prefix, subshell, chained, conditional, and
  `+=` assignments and assigning builtins, and a name is expanded only when
  it has exactly one `LITERAL_ASSIGNMENT` at a `STATEMENT_START`, placed
  before the use, whose value matches `SAFE_VALUE` (no whitespace, quote,
  backtick, shell operator, `$`, backslash, or leading `-`). A command that
  matches `UNRESOLVABLE` (`eval`, `if`, `while`, `until`, `case`, or `{`) is
  left untouched, so the 0.22.2 `$` rejection in `AGENT_FLAG` and `RUN_FLAG`
  still applies to anything unresolved. The index gains `attribution(run)`,
  returning `{ control, uncredited }` with `uncredited: UncreditedSubagent |
  null` (`{ mayStillDrive, reason }`), and `controllerOf` is now
  `attribution(run).control`. `strongestDriver` picks the candidate among the
  running subagents that used the owner id, and `missingDriverReason`,
  `userEvidenceReason`, and `rejectedDriverReason` produce the reason: a
  shared id, a different run named, a failed command, no command in
  `repositoryRoots`, a later parent command, or a later lease write;
  `mayStillDrive` is false only when the evidence shows control moved away
  from that agent. `lib/turn-guard.ts`: `TurnCheckRun` gains `uncredited`,
  attribution is computed once per run instead of a separate `controllerOf`
  call, and the block message appends `<runId> is not credited to a
  background agent: <reason>.` plus a wait-for-the-agent sentence when
  `mayStillDrive`. `turn-guard.test.ts` grows from 35 to 38 tests; replaying
  the real hash 0.22.4 transcript, 0.22.4 credits nobody and 0.22.5 credits
  the subagent.
- `lib/loop-lease.ts`: new `refreshPreservedPaths(scopedPlan, refreshedPlan)`
  returns the paths the refreshed plan preserves in any worktree that is not
  a scoped unit's `sourceWorktree`, and `assertShipmentScopeRecordable` no
  longer rejects a changed path outside the first scope when it is in that
  set. New `refreshedPreserved(priorScope, refreshedPlan, inventory)` builds
  the merged `preserved` list that `recordShipmentScope` stores: every
  earlier preserved path outside scoped source worktrees stays while the
  inventory still shows it changed, whatever the refreshed preview proposes,
  and a pathless exclusion is resolved through the scope's `openingChanges`
  so it keeps excluding only the worktree it originally covered. Scoped
  units and exclusions are unchanged. `loop-lease.test.ts` grows from 132 to
  135 tests: a changing preserved worktree, a raw-preview refresh that keeps
  primary work, and a pathless exclusion.
  `references/inventory-and-concurrency.md` and
  `references/cleanup-and-completion.md` document both fixes, and
  `skill-contract.test.ts` pins four new sentences, two from each. Both
  fixes had independent review by Opus 5.5 (high) over three rounds, which
  found a refresh that dropped previously preserved primary work, a
  value-splicing hole that could hide evidence, shell forms the resolver
  misread, inaccurate reasons, and doc gaps; all are fixed with regression
  tests, two of which were confirmed to fail on the earlier code. Full
  suite: 703 tests. Guidance stays at 24; `.simple-changes.json` is
  unchanged.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T17:59:47-05:00" -->

## 0.22.4 - 2026-10-02

- `lib/loop-lease.ts`: new `assertTargetContainsDeletedHeads(repo, receipt,
  targetPatchIdCache)`, called from `recordRemoteBranchReconciliation` after
  the supersession check, walks every `deleted-proven-obsolete` branch with
  `obsoleteProof: "target-contains-head"`: the head must pass `git cat-file
  -e <head>^{commit}` and `targetContainmentAudit` must return a method
  (exact ancestry or full per-commit `git patch-id --stable` equivalence, the
  containment proof local cleanup shares, capped at
  `PATCH_EQUIVALENCE_MAX_COMMITS` = 200). A failure in a shallow clone names
  the shallow clone and says `git fetch --unshallow`; otherwise the refusal
  distinguishes the commit cap from a missing patch-equivalent commit and
  names the next step (fetch at `refs/merge-requests/<iid>/head`, record a
  supersession, or report the branch). It is not re-run at `loop end`, which
  already binds the receipt to the current target revision, so a receipt an
  older client recorded without the check cannot strand a run.
  `assertRemoteBranchSupersession` takes a required `check` argument,
  `{ phase: "record", targetPatchIdCache }` or `{ phase: "loop-end" }`: the
  "unnecessary" refusal uses `targetContainmentAudit` at record time, sharing
  one patch-ID cache with the new check and naming the method in the message,
  and stays `targetContainsRevision` exact ancestry at loop end.
  `provider-diff-empty` is untouched.
- `SPEC.md` now states the 0.22.1 merged-head ancestry proof, the Git-verified
  `target-contains-head` proof, and the 0.22.3 user-approved supersession;
  `references/cleanup-and-completion.md` step 5 and the supersession paragraph
  are updated. `skill-contract.test.ts` pins six new sentences (three from
  `SPEC.md`, three from the reference). `loop-lease.test.ts` adds a shared
  `deletedHeadFixture` and two Git-backed tests: target-contains-head
  verification (exact ancestry, a cherry-pick, unique work, a partial
  cherry-pick, a 201-commit branch built with `git fast-import`, a missing
  object, a shallow clone, `provider-diff-empty` without the object, and a
  head gc'd before `loop end`) and a 0.22.3 receipt whose supersession of a
  patch-equivalent head still ends at loop end. Full suite: 697 tests.
  Independent review by Opus 5.5 (high) found a loop-end regression for
  0.22.3 supersessions, a shallow-clone refusal that suggested lost work, and
  doc and test gaps; all are fixed and a re-review confirmed the fixes.
  Guidance stays at 24; `.simple-changes.json` is unchanged.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T16:17:10-05:00" -->

## 0.22.3 - 2026-10-02

- `skills/simple-changes/SKILL.md` gains a `metadata.models` frontmatter key
  (`Claude Opus 5.5, Claude Fable 5.1`). `fork create` (`FRONTMATTER_NAME`)
  and `update-local-forks` (`SKILL_NAME_PATTERN`) match the `name:` line
  only, so the extra key is inert for them; a top-level `model` key is
  avoided because Claude Code treats one as a runtime model selection. A
  `Contents:` list under the title mirrors the file's `##` headings; the Core
  workflow closes with a checklist paragraph scoped to Ship, Integrate, and
  Reconcile (source changed: return to step 4, with `loop refresh-scope` in
  Ship; target, policy, controller checkout, or scoped source worktree
  changed: return to step 3); step 5 and the `loop verify` sentence state the
  fix-and-re-run loop. The file is 468 lines against the 500-line cap in
  `tooling/simple-changes/tests/skill-contract.test.ts`.
- The eleven references over 100 lines (`changelog-coordination`,
  `cleanup-and-completion`, `data-changes`, `deployments`,
  `guidance-updates`, `inventory-and-concurrency`,
  `migrations-and-high-risk-actions`, `onboarding`, `setup-and-policy`,
  `ship-communication`, `user-communication`) open with a `Contents:` list
  generated from their `##`/`###` headings, and `references/verification.md`
  step 4 is a fix-and-re-run loop. `CURRENT_GUIDANCE_VERSION` stays 24: no
  setting, default, onboarding step, or companion integration changed.
<!-- simple-changelogs-signature agent="claude-fable-5-1" at="2026-10-02T13:39:48-05:00" -->
- `lib/types.ts` adds `RemoteBranchSupersession` (`branch`,
  `initialHeadRevision`, `replacementRevisions`, `approvedBy`, `reason`) and
  `RemoteBranchSupersessionRecord` (`schemaVersion: 1`, `runId`,
  `receiptDigest`, `supersessions`);
  `evals/schemas/remote-branch-supersession.schema.json` joins `SCHEMA_NAMES`
  in `lib/schema.ts`, and the README `KIND` list adds
  `remote-branch-supersession`, `ready-work-receipt`, and `ship-holds`.
  `lib/remote-branch-reconciliation.ts`: `splitRemoteBranchReconciliationInput`
  now also lifts `supersession` off each receipt branch entry and returns
  `supersessions` (values trimmed; a blank `approvedBy` or `reason` is a
  validation error), so the lease and embedded receipt keep the 0.22.0 schema
  that older CLIs strict-validate. `validateRemoteBranchReconciliation(value,
  ancestryProofs, supersessions)` routes a branch with a supersession through
  `validateSuperseded`: `deleted-proven-obsolete` with `obsoleteProof: null` at
  the exact `initialHeadRevision`; `assertAuditedClassification` is factored
  out of `validateAuditedBranch`, and `validateRemoteBranchSupersessionRecord`
  re-joins the sidecar by `runId` and `receiptDigest`.
- `lib/loop-lease.ts`: the ancestry sidecar read and write generalize into
  `readReceiptSidecar`/`writeReceiptSidecar`, which also keep
  `<commonGitDirectory>/simple-changes/remote-branch-supersession/<runId>.json`.
  `assertRemoteBranchSupersession` runs against `lease.primaryCheckout` at
  `loop reconcile-remote-branches` and again at `loop end`: it refuses a
  shallow clone, requires the deleted head object locally with shared history
  against `receipt.targetRevision`, says to record `target-contains-head`
  instead when the target already contains it, and requires every replacement
  to be in the target and not an ancestor of the deleted head.
  `pinSupersededHeads` writes `refs/simple-changes/superseded/<runId>/<head>`
  for each approved head on record. The loop-end missing-sidecar hint names
  only the proof a branch needs (`needsAncestryShape`/`isSupersededShape`).
  `references/cleanup-and-completion.md` step 5 and a new paragraph after the
  merged-head ancestry paragraph document the recipe, and
  `skill-contract.test.ts` pins five of its sentences.
  `remote-branch-reconciliation.test.ts` grows from 26 to 37 tests;
  `loop-lease.test.ts` adds two Git-backed tests (shallow clone, missing head
  object, forged replacements, the pin, stale-sidecar removal on re-record,
  sidecar tampering and removal at loop end, head already in the target) and
  its ancestry test now uses a shared module-level `remoteLedger` helper.
  Independent review by Opus 5.5 (high) found that a shallow fetch of the
  deleted head let the branch's fork point pass as a replacement and that the
  deleted head was never pinned; both are fixed with regression tests.
  Guidance stays at 24; `.simple-changes.json` is unchanged.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T15:10:30-05:00" -->

## 0.22.2 - 2026-10-02

- `lib/subagent-control.ts`: `AGENT_FLAG` and `RUN_FLAG` now reject values
  containing `$` and require a terminator after the value, so `--run-id "$R"`
  parses as no run id rather than a literal. `ownerLoopInvocations` is a
  filtered view of a new `loopInvocations(command, shellDirectory)` that also
  keeps read-only actions (flagged `readOnly`) and resolves each invocation's
  `directory`: a literal absolute `--repo`, else the last literal absolute
  `cd`/`pushd` before it, else the transcript entry's `cwd`; a `cd` to anything
  else makes it unknown. `OwnerCommand` gains `directory`, `failed`, and
  `readOnly`; a failed subagent command is kept (so it still proves the agent
  id was used) but never shows control.
- `RunToAttribute` gains `repositoryRoots`, and `turn-guard.ts` fills it from
  `lease.primaryCheckout` plus every `<common>/worktrees/*/gitdir` parent.
  `controllerOf` computes an `ownerIdDriver`: the one running subagent whose
  commands use the lease's `ownerAgentId` when the parent never used it. For
  that subagent, `driverOf` adds its successful, non-read-only owner commands
  that name no run to the named ones, but only when at least one of them ran
  `within` `repositoryRoots` (realpath-resolved); the merged activity is
  reported with `inFlight: false`, so a still-running command never excuses a
  lease write past `LEASE_WRITE_TOLERANCE_MS`. The parent-since and
  lease-write checks are unchanged.
- `references/cleanup-and-completion.md` documents the owner-id rule and
  `skill-contract.test.ts` pins three of its sentences; `turn-guard.test.ts`
  grows from 34 to 35 tests. Guidance stays at 24; `.simple-changes.json` is
  unchanged.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T13:46:03-05:00" -->

## 0.22.1 - 2026-10-02

- `lib/types.ts` adds `RemoteBranchAncestryProof` (`branch`,
  `proposalObjectId`, `initialHeadRevision`, `mergedHeadRevision`) and
  `RemoteBranchAncestryRecord` (`schemaVersion: 1`, `runId`, `receiptDigest`,
  `proofs`); `evals/schemas/remote-branch-ancestry.schema.json` joins
  `SCHEMA_NAMES` and the README schema list. Revisions are 40 to 64 hex
  characters and the digest 64; `proofs` needs at least one entry.
- `lib/remote-branch-reconciliation.ts`: `splitRemoteBranchReconciliationInput`
  lifts `mergedHeadAncestry` off each receipt branch entry (an object without
  its own `branch`, else a validation error) before the receipt is validated
  and embedded, so the lease keeps the receipt schema 0.22.0 clients
  strict-validate. `validateRemoteBranchReconciliation(value, ancestryProofs =
  [])` routes a branch with a proof through `validateLedgerBranch` and
  `validateAncestryMerged`: `merged-obsolete` classification, the
  `deleted-merged` shape, a proof starting at the exact `initialHeadRevision`,
  exactly one open evidence for the proof's `proposalObjectId` at the initial
  head with `observedFinally: false` and one merged evidence at the merged head
  with `observedInitially: false`, no other open proposal, never the canonical
  target or a protected branch, and each proof naming exactly one ledger
  branch. `remoteBranchReconciliationDigest` is `sha256Json(receipt)`;
  `validateRemoteBranchAncestryRecord` rejects a sidecar whose `runId` or
  `receiptDigest` differ with an `unsafe` exit.
- `lib/loop-lease.ts`: `assertRemoteBranchAncestry` runs
  `targetContainsRevision` against `lease.primaryCheckout` twice per proof
  (initial head within merged head, merged head within
  `receipt.targetRevision`) and fails `unsafe` with the branch, initial head,
  and proposal to report; missing objects fail closed. Recording writes
  `<commonGitDirectory>/simple-changes/remote-branch-ancestry/<runId>.json`
  (0700 directory, 0600 file, `wx` temporary then rename, symlink ancestors
  refused) under the state lock, or removes it when the receipt carries no
  proofs; the file is kept afterward as audit evidence. `loop end` reads it,
  re-joins it with the embedded receipt, re-validates, and re-verifies
  ancestry, and a validation failure with no sidecar says one may be missing
  and asks for the final reconciliation to be recorded again.
- `references/cleanup-and-completion.md` documents the `merged-proposal-head`
  recipe (list the MR twice, add `mergedHeadAncestry`, stop and report on
  rewritten, force-pushed, squashed, or rebased heads, never recreate a deleted
  branch); `tooling/simple-changes/tests/skill-contract.test.ts` pins four of
  its sentences. `remote-branch-reconciliation.test.ts` grows from 15 to 27
  tests and `loop-lease.test.ts` adds two (Git-verified ancestry kept out of
  the lease; the same proposal merged at the unchanged opening head).
- Add `lib/subagent-control.ts`: `parseHookBackgroundTasks` reads the Stop
  hook's `background_tasks`; `ownerLoopInvocations` parses Simple Changes
  `loop` commands that name `--agent-id` (a `loop` word counts only after the
  command named Simple Changes by script, bin, or a fork's runtime wrapper, and
  flags are read up to the next shell separator or `--`); run ids come from
  `--run-id` or, only for a successful `loop start` or `takeover`, the
  command's JSON output. `subagentControlIndex(transcriptPath,
  backgroundTasks).controllerOf({ runId, ownerAgentId, leaseUpdatedAt })`
  reads each transcript at most once per hook and names a still-running
  subagent only when it issued the owner command, the parent did not command
  the run since (parent entries without a readable time count as newest,
  sidechain entries are never the parent's, failed parent commands still
  count), and the lease was not written more than `LEASE_WRITE_TOLERANCE_MS`
  (60 s) after the subagent's last command. `TRANSCRIPT_SCAN_LIMITS` is 5 s and
  64 MiB inside the 15 s hook timeout; past either, nothing is proven and the
  guard blocks. Workflow agents are not considered.
- `lib/turn-guard.ts`: `TurnCheckInput` gains `backgroundTasks` and
  `transcriptPath` (from the hook's `background_tasks` and `transcript_path`),
  `TurnCheckRun` gains `drivenBy`, and the decision adds `advise`, returned
  when every run the session controls is live (`leaseLiveness(lease).state ===
  "live"`) and subagent-driven; it is emitted as a `systemMessage` like `warn`.
  A block that also has delegated runs lists them with a "Leave ... alone"
  line. `SPEC.md` and the cleanup reference describe the exception and
  `skill-contract.test.ts` pins two sentences; `turn-guard.test.ts` grows from
  23 to 34 tests. Guidance stays at 24; `.simple-changes.json` is unchanged.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T12:50:14-05:00" -->

## 0.22.0 - 2026-10-01

- Add `lib/fork.ts` with `createFork({ name, deltas, repositoryPath,
  sourcePath, destination?, upstreamPath? })`, wired to
  `simple-changes fork create` (`--name`, `--deltas`, `--destination`,
  `--upstream` join `VALUED_OPTIONS` and the loop valued-option map; any
  positional other than `create` is a usage error). The source is the skill
  root resolved from the running script, so a fork copies whichever install is
  executing.
- Verification snapshots the installed tree once (`snapshotSource`, sorted,
  `.DS_Store` ignored, symlinks and special files refused) so the verified
  bytes are the bytes copied. `verifySourceCommit` hashes every file as a Git
  blob and compares it with `git ls-tree -r -z <commit> -- skills/simple-changes`
  for `HEAD` and then each commit from `git log --format=%H HEAD --
  skills/simple-changes`; non-blob tree entries map to an impossible hash so a
  symlink or submodule upstream is a mismatch rather than dropped. Without
  `--upstream`, a bare `--filter=blob:none` clone of
  `https://gitlab.com/soundsystems/simple-changes.git` in a temporary directory
  is used and removed afterwards. A miss reports up to five `extra`,
  `missing`, or `changed` paths against the latest tree with an `unsafe` exit.
- Path safety: `repositoryRoot` resolves `git rev-parse --show-toplevel` through
  `realpathSync` and rejects a non-repository as usage; `separated` requires
  the destination inside the root and disjoint from the source; names must
  match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, be at most 64 characters, and not be
  `simple-changes` or any sibling directory of the installed skill.
  `reserveDestination` creates parents with `mkdirSync` one segment at a time,
  refusing symlinked parents, reserves the final directory exclusively (`EEXIST`
  is "already exists"), and re-checks separation on the real created path to
  catch case-insensitive aliases; `removeCreated` unwinds only what this call
  created. Files are written with `wx` and `chmod(mode % 0o1000)`. `SKILL.md`
  must start with frontmatter `name: simple-changes` and a `# Simple Changes`
  title, must not already carry a `Forked from` line, and must use LF (a CRLF
  file gets a dedicated `core.autocrlf` explanation); the rewrite replaces the
  name and inserts the provenance line with whitespace-collapsed deltas.
- `SKILL.md` gains a "Create a repository-specific fork" section; the README
  replaces the manual copy-and-rename instructions with a preferences versus
  instructions versus fork table, the create command, destination and offline
  options, the Claude Code `.claude/skills` note, and the CLI synopsis line.
- `tooling/simple-changes/tests/fork.test.ts` (16 tests) covers the verified
  pin and executable bits, existing-destination refusal, modified, untracked,
  and incomplete sources, committed updates between releases, a CLI-created
  fork that `update-local-forks discover` recognizes, name and deltas
  validation, traversal, overlap, and symlink refusals, explicit destinations,
  repository-root anchoring, the case-insensitive alias, mismatch naming with
  Finder metadata, sibling-name refusal, and the CRLF explanation. Guidance
  stays at 24; `.simple-changes.json` is unchanged.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-01T22:17:12-05:00" -->

## 0.21.1 - 2026-10-01

- Add `lib/harness-session.ts`: `currentHarnessSession` reads
  `CLAUDE_CODE_SESSION_ID` plus `CLAUDE_PID` (kept only when the PID is visible
  from this process, so a sandbox with its own namespace never records one) or
  `CODEX_THREAD_ID`. `recordControllerSession`, `forgetControllerSession`, and
  `listControllerSessionEntries` keep a best-effort per-user pointer index in
  `controller-sessions/<sha256(session)>/<runId>.json` beside the personal
  preferences file; a pointer names only a common Git directory and is never
  authority.
- Keep the new controller facts out of the lease. `loop-lease.ts` writes
  `active-loop-controller.json` (`LoopControllerBinding`, `schemaVersion: 1`)
  beside the lease with `session`, `awaitingUser`, and `inheritedAwaitingUser`;
  `readControllerBinding` honors it only while `runId`, `ownerAgentId`, and
  `controllerAcquiredAt` match the lease's current tenure, so a resume or
  takeover by a runtime that does not write bindings leaves the old one inert.
  `startLoop`, resume, takeover, and owner `guardLoopMutation` and
  `withLoopMutationLease` refresh it; finalization, unmutated closure, and stale
  recovery remove it. The lease schema, manifest digest, and
  `stale-lease-recovery` receipt are unchanged.
- `finalizeLoop` takes `{ awaitingUser }` (1-10 non-empty questions of at most
  500 characters, validated before any write): the questions become a
  finalization blocker, land in the receipt as `awaitingUser`, and
  `relinquishController` stores them in the binding with `session: null`; the
  CLI reports the pause and returns success. An untouched Ship run still closes.
  `transferController` copies the predecessor's questions into
  `inheritedAwaitingUser`, `loop start` prints and emits them, and
  `loopGuidanceFor` shows them for a relinquished lease.
- Add `lib/turn-guard.ts`: `turnCheck` re-reads every lease the session index
  points at, keeps only an active controller bound to this session, prunes the
  rest, and decides `block`, or `warn` when `stop_hook_active` is set;
  `turnCheckHookOutput` renders `{decision, reason}` or `{systemMessage}`.
  `loop turn-check --hook` reads stdin with a 2 s timeout, swallows every
  error, and exits 0 explicitly. `stopHookCommand` is
  `[ -f <script> ] || exit 0; '<bun>' '<script>' loop turn-check --hook || exit 0`
  with `which("bun")`. `stopHookStatus` merges into `~/.claude/settings.json`
  or `~/.codex/hooks.json` (honoring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`,
  writing through a symlink, keeping file mode and every other key), updates an
  older turn-check handler in place, treats another copy's hook as current
  while it ends fail-open and its script declares a version at least as new and
  contains `"turn-check"`, and refuses to write a path inside a linked worktree;
  `hookInstallScript` maps a worktree copy to the primary checkout's copy when
  that one qualifies. `initialize` reports `turnEndGuard` without installing,
  and `initialization.schema.json` gains `turnEndGuard` and `runtimeFreshness`.
- Add `lib/runtime-freshness.ts`: when the running script lives inside an
  inventory worktree, compare its `VERSION` with `git show <targetRef>:<path>`
  and report `behind-target`; a global install is `not-applicable`.
- Liveness: `LEASE_STALE_AFTER_MS` drops from four hours to two, and
  `SESSION_EXIT_GRACE_MS` (10 min) makes a quiet run stale once the bound
  session's recorded PID is gone on this host and the process can see its own
  `CLAUDE_PID`; `LeaseLiveness.ownerSessionEnded` surfaces it.
  `recoverStaleLoopLease` writes `stale-lease-recovery-lease.json` (lease,
  binding, `ownerSessionEnded`) beside the unchanged receipt.
- Harden hold withdrawal in `ship-holds.ts`. `refAlreadyGone` accepts a delete
  as already withdrawn only for a client-side `remote ref does not exist`
  naming this ref or a bare `unable to resolve reference '<ref>'` with no
  suffix, so `: reference broken` or `: Permission denied` stay failures. When
  a release beats `publishShipHold`'s clean-up delete and that delete fails,
  `markWithdrawalPending` resets `publication.withdrawnAt` so the next
  `hold release` retries, and a failed reset names the manual
  `git push <remote> :<ref>`. `evaluateShipHolds` adds `unpublishedElsewhere`
  (local holds that are neither released nor satisfied, confirmed published,
  not withdrawn, and absent from a successfully read remote) with a
  `nextSteps` line naming the owner's release command, and `publishShipHold`
  re-lists the remote before trusting a `publishedAt` record so the owner can
  republish after a withdrawal elsewhere. Four regressions in
  `ship-holds.test.ts` cover the lost delete race, the broken ref,
  republishing, and the owner's clone; `inventory-and-concurrency.md` says the
  gates report the withdrawal.
- Mark `skills/publish-skill/SKILL.md` `metadata.internal: true` and drop the
  README section that installed it with `bunx skills add . --skill
  publish-skill` and told skill repositories to bundle it. No tooling reads the
  flag; the publish-skill package-design and consumer-discovery checks and the
  lean one-skill package eval are unchanged.
- Bump guidance to 24 with three change entries and a notice bullet
  (`changelogReviewRelevant: false`). Add a `bunfig.toml` test preload that
  deletes the harness session variables so tests never bind to the session
  running them. `turn-guard.test.ts` covers detection, block-then-warn,
  inheritance, rebinding, pointer pruning, hook stdin, reminders, liveness, the
  archive, the installer, and freshness; `skill-contract.test.ts` pins the
  SKILL, SPEC, and cleanup prose; `initialization.test.ts` covers the guidance
  24 notice.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-01T20:10:14-05:00" -->

## 0.21.0 - 2026-10-01

- Add `lib/ready-work.ts` and `evals/schemas/ready-work-receipt.schema.json`:
  `worktree release --ready-receipt <file>` validates the author half (scope,
  checks, releaseImpact, migrations, deploymentConstraints,
  unresolvedAuthority), rejects runtime-bound fields and secrets, requires a
  clean attached checkout with no Git operation in progress, binds claim,
  owner, path, branch, exact head, and content digest, and releases the claim
  as a completed-work `handoff` in the same lock interval;
  `releaseWorktreeClaim` now accepts that current evidence so an active loop
  admits the handed-off state. `worktree status --json` reports `readyWork`
  freshness as `current`, `stale`, or `shipped` through the new one-pass
  `revisionContainmentMethod` in `cleanup-core.ts` (ancestry, then
  `rev-list --cherry-pick --right-only --count`).
- Add `lib/ship-holds.ts` and `evals/schemas/ship-holds.schema.json`:
  `hold add|status|check|release|waive|publish` keep `holds.json` beside the
  claims. `loop verify --for merge|deploy|migrations`, `hold check --for`, and
  `migration apply` fail closed on an active covering hold or on published
  holds they cannot read; `--local-only` opts out. A waiver binds the run ID
  and the hold's content digest, is recorded only by that run's active
  controller, and a halt needs `--override-halt`, as does another agent's
  release of one. `hold publish` builds a deterministic commit with the new
  `runGitWithInput` and pushes `refs/simple-changes/holds/<id>` with the
  publication intent recorded before the push; `runGitRemote` in
  `process.ts` disables terminal and credential-manager prompts, forces SSH
  batch mode unless the user configured an SSH command, and kills the command
  after 30 s, returning failures instead of throwing.
- Keep new state in new files (`holds.json`, `ready-receipts.json`) under the
  new `ready-work-receipt` and `ship-holds` schema names; `state.json` and
  the lease are untouched so installed 0.19/0.20 clients keep reading them.
  Document ready-work receipts and shipment holds in
  `references/inventory-and-concurrency.md`, add "Shipment holds" to
  `SKILL.md`, and pin the invariants and prohibitions in `SPEC.md`;
  `skill-contract.test.ts` pins the prose and `ship-holds.test.ts` covers
  the gates, waivers, publication, and remote failures. Bump guidance to 23
  with two change entries and a notice bullet; `.simple-changes.json` records
  it as accepted.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-01T16:10:25-05:00" -->

## 0.20.0 - 2026-10-01

- Cut inventory capture from one Git process per path and per worktree to a
  handful: resolve the real Git binary behind the `/usr/bin/git` xcrun shim
  once per process, batch per-path index lookups into a single
  `ls-files --stage`, read worktree statuses concurrently through the new
  `lib/git-worker.ts`, memoize repeated metadata reads, and use
  `locateRepository` where a command only needs the lock location. Digests
  are byte-identical to the previous implementation; a capture on a large
  repository drops from 8-17 s to 0.4-1 s. Cover batching, memoization, and
  shim resolution in `inventory.test.ts` and `process.test.ts`.
- Split `finalizeLoop` into `finalizeOwnedLoop` and
  `relinquishAfterFinalizationError`: after ownership and both locks are
  established, any error relinquishes the latest saved lease (never the
  opening snapshot) with the failure reason and rethrows; an unwritable lease
  is reported beside the original error. The untouched-run path still runs
  first, and wrong-owner or wrong-run requests change nothing. `startLoop`
  against a stale lease names `loop recover --stale-lease` with the run ID.
  Add finalization and liveness regressions for an unwritable recovery
  archive after cleanup, resume after relinquish, and the stale-lease message.
- Document "Parallel agents" in `references/inventory-and-concurrency.md`,
  route to it from `SKILL.md`, and pin the invariant in `SPEC.md`: delegated
  agents author only in `prepare-agent` worktrees under a distinct agent ID
  and never run loop, provider, push, merge, release, or cleanup commands;
  the controller integrates serially. Add "Parallel fork agents" to
  publish-skill and "Several forks at once" to update-local-forks. Contract
  tests and package-design checks pin the new prose. Keep guidance at 22: no
  setting or authority change.
- Replace `hasEmptyUnreleased` in `release-consistency.ts` with
  `unreleasedIssues`: an empty `## Unreleased` is allowed only as the first
  `##` heading (the Simple Changelogs guidance 13 prepend anchor); an empty one
  elsewhere reports "contains an empty Unreleased section." and two or more
  `Unreleased` headings report "contains more than one Unreleased section."
  `release-consistency.test.ts` covers the leading anchor and the duplicate.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-01T14:12:24-05:00" -->

## 0.19.0 - 2026-09-30

- Add `firstMutationAt` to the lease, stamped in the same write as the first
  guard, exec, prepare-agent, disposition, override, retention, retirement,
  adoption, rebaseline, scope, outcome, reconciliation, relinquish, takeover,
  or resume; it is excluded from the manifest digest. `endLoop` and
  `finalizeLoop` close a scope-required Ship run with no scope, no mutation
  stamp, and no run evidence of any kind, tolerating only
  `preserved-worktree-changed` and `coordination-claim-stale`, writing an
  immutable `abort-unmutated.json` receipt in the run's recovery history.
- Replace the whole-digest opening check in `recordShipmentScope` with
  explicit invariants: plan digest equals the current inventory, command runs
  from the controller checkout, `currentTargetRevision` equals the pinned
  target, `openingInvariantDigest` (capabilities, policy, remote bindings,
  target ref and remote) is unchanged, the controller and every unit source
  worktree match the new immutable `openingWorktrees` record, and manifest
  verification passes. Leases without the new fields keep the old rule.
  `shipmentScope.openingInventoryDigest` records the scope-time digest. Status
  guidance reuses the same checks. Keep guidance at 22: no setting changes.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-09-30T19:46:51-05:00" -->

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
