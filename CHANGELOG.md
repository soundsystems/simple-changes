# Changelog

## 0.25.1 - 2026-10-05

- `update-local-forks` now moves a fork's pin when a release received review
  fixes after its release notes were written. It pins a verified commit that
  carries exactly the installed release tree, instead of refusing and leaving
  the pin to be set by hand. It still never pins a guess: if the installed
  skill matches no commit of that release byte for byte, the plan keeps the
  pin and says how many commits it checked.
- The byte-for-byte check now compares raw file contents and file names. A
  release whose files contain invalid UTF-8 can now verify, and a look-alike
  install whose bytes or names differ no longer does. Applying a plan writes
  every file byte for byte, including merges and version rewrites.
- Pin updates no longer rewrite past release entries in a fork's maintenance
  notes when their `#` headings name a commit, range, or date, or when they
  continue the history log, including notes with Windows line endings. The
  lines under a heading that starts with "Current" are still updated.
  Underlined (Setext) headings are not recognized.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T22:00:40-05:00" -->

## 0.25.0 - 2026-10-05

- Your repository can now add an `execGuard` check to `.simple-changes.json`.
  Simple Changes runs it, with the command appended, before every
  `loop exec` command, and refuses the command when the check fails. For
  example, it can block a merge until hosted CI has passed for that exact
  commit; the check decides which commands it gates. Add it only once every
  copy of Simple Changes that reads your repository, forks included, is
  0.25.0 or later, because older copies reject the setting.
- A run that already recorded its shipment but can no longer finish can now
  be archived with your named approval through `loop archive-recorded`. Its
  records are kept, it is never reported as shipped, and `loop status` and
  `loop replan-status` point to it where `loop replan` refuses.
- When a teammate's in-progress checkout shipped in an equivalent but not
  identical form after an independent review, you can now approve keeping
  that checkout as it is. `loop record-outcome` takes your approval with
  `--approved-by` and `--approval-reference`, and the run checks again before
  it finishes that nothing in that checkout moved.
- Setup run from a repository's own fork of Simple Changes now names that fork
  in the instructions it writes to `AGENTS.md` or `CLAUDE.md`, instead of the
  general `simple-changes` skill.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T19:22:39-05:00" -->

## 0.24.1 - 2026-10-05

- The release gate now refuses a changelog receipt that pairs an ask version
  policy with an automatic or repository-automation resolution, so an ask
  policy can only be reported as resolved by your explicit direction. The
  gate still takes that report from the changelog provider.
- `update-local-forks plan` now lists each file it skips as fork-owned
  history, such as a fork's own `CHANGELOG.md`, instead of only counting
  them.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T17:17:45-05:00" -->

## 0.24.0 - 2026-10-05

- Proposal descriptions now follow one body shape
  (`references/change-requests.md#body-shape`). A Summary opens with the
  outcome and the smallest view that makes the change clear, Evidence shows a
  before and an after instead of only listing passing checks, and Merge
  danger names a one-way, two-way, or unknown door and the blast radius. The
  door comes from the run's own migration, installed-client compatibility,
  release, and rollback evidence rather than the size of the diff. A
  repository's own proposal template is filled first and keeps its headings,
  and the signature block stays last.
- An agent's independent review now pins the exact base and head, then
  checks two separate axes: the repository's documented standards, citing
  the rule, and the originating issue or spec, quoting it for missing
  requirements, unrequested behavior, and wrong implementations, or reporting
  `no spec available`. Each axis is reported on its own.
- Guidance moves to 25. The update notice needs no decision.
- `publish-skill` now runs only when you type `/publish-skill`. It now
  removes a standalone CMS changelog install that a selected Web and CMS
  package already covers once the repository's CMS policy file is in place,
  unless repository instructions keep both, and it matches the copy that
  ships with Simple Changelogs.
- `simple-changes proposal audit --file <body.md> [--template <path>]` checks
  a stored proposal description and exits 3 on escaped `\n` where line breaks
  were intended, a missing Summary, Evidence, or Merge danger section (with
  the repository's own template: a missing template heading, or a missing
  Merge danger section, which the template never replaces), a Merge danger
  section without a `**Door:**` line naming one-way, two-way, or unknown or
  without a `**Blast radius:**` line, and a signature block that is not
  last. Agents run it after creating or updating a proposal, before
  re-reading the rendering. `verify-markdown` no longer counts an escaped
  `\n` inside code.
- `simple-changes skill check [--skill-dir PATH]` reports whether skill
  discovery can load a skill or a fork: strict YAML frontmatter, a name that
  matches its directory, a 1 to 1,024 character description, matching Claude
  Code and Codex invocation settings, and relative links that resolve.
- Simple Changes now ships Codex metadata (`agents/openai.yaml`). `fork
  create` gives a new fork a description that starts with its name and says to
  use it instead of the global `simple-changes` skill in that repository, and
  points the fork's Codex metadata at the fork.
- From a fork, the turn-end guard is offered and installed from the globally
  installed Simple Changes runtime, so a user-level hook never runs one
  repository's fork. When no global copy is at least as new, initialization
  says to install the hook from the global skill.
- `update-local-forks` holds a fork's pin when an upstream reference added or
  changed since the pin is neither carried by the fork nor listed under
  `## Intentional omissions` in its `references/fork-maintenance.md`; `plan`
  and `apply` exit 3 until the fork carries or records it.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T13:11:05-05:00" -->
- Ship now accepts a Simple Changelogs classification that already names
  the exact public version, chosen automatically or by your direction, and
  carries it into preparation. Preparing and verifying the changelog still
  happen as separate later steps, and a version that still needs your answer
  is still asked about.
- A Ship run that starts with no local changes now records that empty
  starting point right away, so every Ship run has a fixed scope to check
  against. Committed and release-generated changes are still listed in the
  final outcome; an empty starting scope never counts as delivery.
- The skill now shows the full end-of-turn command,
  `loop finalize --reason "<why the turn ends>" --json`. The shorter form it
  showed before was rejected because `--reason` is required.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T13:48:48-05:00" -->
- When `update-local-forks` moves a fork's pin or upstream version, it
  now leaves the fork's own history as written. Its changelog files, a
  commit or version range, a Markdown heading, and anything in a history,
  dated, or range-named section keep the old value, so a sync record such as
  `7ab67a1..628c66b` and the test that checks it no longer change to the new
  pin.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T14:14:40-05:00" -->
- Remote branch cleanup now judges merge requests by their final state. A
  branch whose merge request was open when the run started and merged at that
  same head is recorded as merged without an extra ancestry proof, as long as
  the target contains that head, and one closed during the run is classified
  as closed rather than open. A merge request still open at the end still
  blocks deletion, a squash merge or a merge after a fast-forward is handled
  as before, and a deletion you approve as superseded still counts every
  merge request ever seen on the branch.
- `loop close-equivalent` accepts a worktree the run itself removed after an
  audited cleanup when the path is gone and the refreshed target still
  contains its head, and an unrelated preserved checkout that changed or went
  missing after the scope froze no longer blocks the close. The primary
  checkout and a changed retained checkout still block, and every scoped
  source worktree now has to be proven before the close.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-05T15:08:28-05:00" -->

## 0.23.1 - 2026-10-03

- The changelog coordination reference now names the only source of each
  `release-gate` flag. The gate takes its flags on trust and grants no
  authority, so no printed action, including `deploy`, is permission.
  `--production` starts from the `productionDeploy` that
  `simple-changes initialize --json` now reports, which already applies the
  trust rule (a repository `allow` without its local trust receipt is
  `ask`); current user direction may lower it, for example to `deny`, and
  never raises it above `ask`, and a user's production approval goes in
  `--production-authorized`, which is explicit production authority for this
  exact target from the current request under SKILL.md's
  production-authority rules and the ship-communication reference, never the
  agent's own inference. `--version-authorized` is an explicit user version
  decision bound to the receipt's decision digest, and `--already-live` is
  fresh provider evidence that the exact verified finalized target is live.
  Route on the printed `action`, not the exit code: every decision,
  including `block`, exits 0, and a nonzero exit means the inputs were
  rejected and nothing was decided, which blocks the boundary. The gate's
  behavior is unchanged; `initialize` gains the `productionDeploy` field
  (default `ask`; text output prints "Production deploy: <value>"), and its
  schema adds the field as optional, so output from earlier releases still
  validates.
- The shared version lines guidance is corrected: request v2 and receipt v3
  are enabled by the negotiated versions alone, and the `shared-version-lines`
  feature is optional and informational, so nothing gates on it and a
  changelog provider may leave it out until it gates real behavior. 0.23.0
  said a provider advertises v2 and v3 together with the feature. Simple
  Changes 0.13.0 and later ignore unknown protocol versions, and earlier
  releases reject them, so advertising request v2 or receipt v3 needs every
  controller at 0.13.0 or later; from 0.13.0 through 0.22.x only an unknown
  feature breaks negotiation, so a provider still must not advertise
  `shared-version-lines` in a repository until every Simple Changes copy
  there, including fork copies, is 0.23.0 or later.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-03T14:27:10-05:00" -->

## 0.23.0 - 2026-10-03

- The changelog companion protocol can now carry a shared version line, so a
  monorepo can keep two or more release trains (for example web, iOS, and
  Android) on one public version number. The changelog workflow still owns the
  policy and picks the number; Simple Changes adds a backward-compatible
  protocol revision that carries and checks the decision, which the workflow
  will adopt in a later release. Request v2 names every train released
  together from one input target revision as `releaseSetTrains`, including the
  request's own train, under one `releaseSetId`; request v1 is unchanged.
  Receipt v3 echoes that list and adds `versionDecision.versionLine`: whether
  the train is catching up to the line or bumping it, the line's members, each
  member's latest stable public version, the line head and the trains holding
  it, and the outcome. A train that skips a number releases nothing and has no
  receipt. `validate-changelog-transaction` checks a v3 receipt beyond the
  schema: it recomputes the head and its holders from the member versions; a
  catch-up must take exactly the head, and only a train below it may catch up;
  an advance must exceed the head, or the head is empty, and a shared bump
  always advances; the proposed version (the suggestion while a decision is
  required, the selection once one is made) must exceed the train's own
  previous public version and must not fall below a stable current version;
  and the decision digest must cover the line state, so a partner's release
  invalidates an outstanding approval, a later phase whose line state changed
  under the same digest fails closed, and a train that reclassifies after a
  partner released must advance past it or start a new release set, while an
  approved direction may still turn a catch-up into an advance. Versions
  compare as one to three dotted numbers, zero-padded (1.2 equals 1.2.0),
  with `+build` ignored, and anything else on a line fails closed. Blocked and
  not-applicable receipts keep their usual closed-code routing. The new
  `validate-changelog-release-set RECEIPT_FILE RECEIPT_FILE...` command then
  checks one release set's receipts together: they must share the release
  set, input target, and train list, in any order, with one receipt per train
  and each train on at most one line, carried by its own receipt, and every
  line must agree on one state and publish one identical version string.
  Trains with no receipt yet are reported as missing, not refused, because a
  multi-train release set stays non-atomic. The changelog coordination
  reference describes all of this.
- Capability negotiation is now open: Simple Changes ignores features and
  protocol versions it does not know and keeps the provider's order, so later
  additions no longer need a lockstep upgrade. It advertises request versions
  1 and 2, receipt versions 1 through 3, and the new `shared-version-lines`
  feature. Simple Changes before 0.23.0 rejects any unknown feature, so a
  changelog provider must not advertise `shared-version-lines` in a repository
  until every Simple Changes copy there, including fork copies, is 0.23.0 or
  later; older providers keep working unchanged at request v1 and receipt v2.
  Release delivery and the deployment adapter accept a v3 receipt alongside
  v2 and refuse a legacy v1 receipt with a clear message instead of crashing,
  and an invalid request still gets field-level errors whichever schema
  version it claims.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T18:50:32-05:00" -->

## 0.22.5 - 2026-10-02

- The turn-end guard now credits a Claude Code background subagent that drives
  a Ship run through a shell variable the same command assigned, such as
  `R=run-…; … loop exec --run-id $R` or `W=/path; cd $W`. 0.22.2 treated every
  value containing `$` as unknown, so a subagent that passed its agent id
  literally but kept the run id and directory in variables it had just
  assigned was never credited, and the guard kept telling the parent session
  to finalize a run the subagent was still driving; that is what happened in
  the hash 0.22.4 sync, and replaying its transcript, 0.22.4 credits nobody
  while 0.22.5 credits the subagent. A `$NAME` value counts as the literal
  only when the same command assigns NAME exactly once, as a plain token with
  no space, quote, shell operator, or leading `-`, as its own unconditional
  top-level statement, before using it. Anything else stays a variable: a
  prefix, subshell, chained, or conditional assignment, `+=`, a builtin that
  assigns (`for`, `read`, `unset`, `printf -v`, and the like), any command
  containing `eval` or an `if`, `while`, `until`, `case`, or `{ }` block, an
  assignment or use in a comment or heredoc, a `$(…)` value, or a value set by
  an earlier command. This is a conservative reading, not a shell, so pass ids
  literally when in doubt. When a running subagent used the run's owner agent
  id but still is not credited, the blocking message now names the exact
  cause: a shared id, a different run named, a failed command, no command in
  the run's repository, a later command by the session itself, or a later
  write to the run. Unless the evidence shows control moved away from that
  agent, it also asks the session to wait for the agent instead of finalizing.
- `loop refresh-scope` now accepts a changed path the first scope never
  recorded when the refreshed plan preserves it in a worktree that is not a
  scoped unit's source, such as another agent's actively changing checkout.
  Before, a refresh refused every unrecorded path, even one the plan
  preserved, so in the hash 0.22.4 sync, where main moved after review, the
  shipped changelog needed a merge resolution, and two Codex worktrees kept
  adding files, the refresh could never succeed and the run had to close as
  already-in-target instead of shipped. Outside scoped source worktrees, every
  path preserved earlier stays preserved while it is still changed, whatever
  the refreshed preview proposes for it, so recording a raw preview can no
  longer drop your preserved primary work, and a file-name-only exclusion
  keeps excluding only the worktree it originally covered. The scoped units
  and exclusions are unchanged: a new path in a scoped source worktree, or one
  only excluded elsewhere, still needs a new shipment run. A refresh does not
  excuse the change itself: `loop verify` still reports a changed registered
  worktree, so each change still needs a user-approved exact-state
  `loop allow`, and a worktree that appeared after loop start is still an
  `unregistered-worktree` violation. The concurrency reference describes all
  of this.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T17:59:47-05:00" -->

## 0.22.4 - 2026-10-02

- A GitLab Ship, Integrate, or Reconcile run can no longer record a deleted
  closed-unmerged or no-merge-request branch as proven obsolete because the
  target contains its head unless Git confirms that it does. Before, that
  proof in the final remote-branch reconciliation receipt was taken on the
  agent's word, so a mistaken receipt could close a run over a deleted branch's
  unique work with nobody approving it. Now `loop reconcile-remote-branches`
  requires the deleted head to be present locally and proves the target
  contains it, either by exact ancestry or by matching each of its unique
  commits to a patch-equivalent commit in the target: the same proof local
  cleanup already uses, which ignores whitespace as `git cherry` does, never
  matches a merge or empty commit, and gives up past 200 unique commits. When
  the check fails, the refusal names the next step: fetch the head at full
  depth (GitLab keeps a merge request's head at
  `refs/merge-requests/<iid>/head` after its branch is deleted); in a shallow
  clone, run `git fetch --unshallow` rather than being told the work was lost;
  if the branch is already gone and its work shipped another way, record your
  supersession approval from 0.22.3; otherwise report the branch to you. An
  empty provider diff stays provider evidence that Git cannot check, recorded
  only from GitLab's own compare result. The check runs where the receipt is
  recorded, not again when the run ends, so a run whose receipt an earlier
  version recorded still ends; the check that a supersession approval is
  unnecessary now uses the same containment proof at record time, so an
  approval cannot stand in for proof Git already has, while a 0.22.3 run that
  superseded a cherry-picked head still ends. `SPEC.md` and the cleanup
  reference now describe all three remote-branch deletion proofs: the
  merged-head ancestry proof from 0.22.1, the Git-verified
  target-contains-head proof, and the user-approved supersession from 0.22.3.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T16:17:10-05:00" -->

## 0.22.3 - 2026-10-02

- Every Simple Changes reference longer than a hundred lines, and `SKILL.md`
  itself, now opens with a short contents list naming its sections, so an
  agent that reads only the first hundred lines of a file still learns which
  rules it holds and where to find them. `SKILL.md` also records in its
  frontmatter that the skill is written for and run on Claude Opus 5.5 and
  Claude Fable 5.1.
- Ship, Integrate, and Reconcile runs now carry the core workflow as a
  checklist in the reply: each step is ticked only once its evidence exists,
  a failed step stays unticked while the agent fixes what the failure reports
  and runs the step again, a fix that changed source sends the run back to
  grouping (with a fresh scope preview in Ship), and a moved target or a
  changed policy, controller checkout, or source worktree sends it back to the
  target refresh. Repository checks and `loop verify` are stated as
  fix-and-re-run loops rather than one-shot checks. Other modes keep the same
  order without the written checklist, and no setting or default changed.
<!-- simple-changelogs-signature agent="claude-fable-5-1" at="2026-10-02T13:39:48-05:00" -->
- A GitLab Ship, Integrate, or Reconcile run can now close when a branch it
  listed at the start was deleted, by anyone or outside the run, while the
  target did not contain its head. Before, a closed-unmerged or
  no-merge-request branch in that state had no valid entry in the remote-branch
  reconciliation receipt, so the run could never end; the real case was a hash
  fork branch whose closed merge request's work had already shipped the same
  day as a differently packaged commit, so its patches did not match. Now, once
  you confirm the branch was superseded, the agent records it as deleted and
  proven obsolete with a `supersession` entry naming the deleted head, the
  target commits that replaced its work, you as the approver, and the reason.
  The agent must show you the branch, its deleted head, and the replacement
  commits and never make that judgment itself, and the entry is only for a
  branch that is already gone or that you explicitly asked to delete.
  `loop reconcile-remote-branches` checks with Git that the clone is not
  shallow, that the deleted head is still present locally (GitLab keeps merge
  request heads at `refs/merge-requests/<iid>/head`), shares history with the
  target, and is not already in it, and that every replacement is in the
  target and is not an ancestor of the deleted head; `loop end` checks again.
  The deleted head is pinned at `refs/simple-changes/superseded/<run-id>/<head>`
  so Git's garbage collection cannot lose the work or strand the run, and you
  can restore the branch from the pin. The approval is kept in a separate file,
  `simple-changes/remote-branch-supersession/<runId>.json` beside the run's
  lease under the repository's Git directory, so a 0.22.0 client can still
  read the lease; an older client cannot end a run whose receipt relies on it
  and stops instead.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T15:10:30-05:00" -->

## 0.22.2 - 2026-10-02

- The turn-end guard now also lets a Claude Code session end when its
  still-running background subagent drives a Ship run through a shell variable,
  such as `--run-id "$R"`. 0.22.1 only credited the subagent when one of its
  `loop` commands named the run literally or printed its id, so a subagent that
  kept the run id in a variable still blocked the parent. Now the subagent's
  successful Simple Changes `loop` owner commands count when they carry a
  literal `--agent-id` equal to the run's recorded owner, this session never
  used that agent id, no other running subagent uses it, at least one of those
  commands ran in the run's repository (by `--repo`, a literal `cd`, or the
  shell's own directory), and the run's record was not written after the
  subagent's last command finished. A value that contains `$` is a variable,
  not an id. Everything else still blocks. Give each agent its own agent id so
  the guard can tell them apart.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T13:46:03-05:00" -->

## 0.22.1 - 2026-10-02

- A branch that GitLab deleted after its merge request merged can now be
  recorded as merged and deleted, even when the Ship run moved it. Before, a
  branch whose merge request was already open when the run started, which the
  run fast-forwarded (or left as it was) before the request merged and GitLab
  removed the branch, could not be recorded at all, so the run could not end
  cleanly. Add `mergedHeadAncestry` to that branch in the reconciliation
  receipt, naming the merge request, the branch head when the run opened, and
  the head that merged; `loop reconcile-remote-branches` checks with Git that
  the merged head is the opening head or descends from it and that the target
  contains it, and `loop end` checks again. Squash merges and rebased merges
  still cannot be recorded: the tool stops and asks you to report the branch,
  its opening head, and the merge request.
- The proof is kept in a separate file,
  `simple-changes/remote-branch-ancestry/<runId>.json` beside the run's lease
  under the repository's Git directory, so a 0.22.0 client can still read the
  lease. A 0.22.0 client cannot end a run whose receipt relies on this proof,
  though: it reports a misleading "an open proposal branch cannot be deleted"
  error. Upgrade to 0.22.1 to end such runs.
- The turn-end guard no longer blocks a Claude Code session whose still-running
  background subagent is driving a Ship loop. A background subagent shares its
  parent's session identity, so the 0.21.1 Stop hook blocked the parent as if
  it controlled the run itself. Now, when Claude Code reports the subagent as
  still running, the subagent's own transcript issued the Simple Changes `loop`
  command that took the run, and nothing shows control moving back to the
  parent, the hook lets the turn end and shows you a note naming the run and
  the agent instead. Everything uncertain still blocks: a run the session
  controls itself, a subagent that has finished, workflow agents, a run that has
  gone stale, a transcript that is unreadable, larger than 64 MB, or slower
  than five seconds to scan, and loop commands that failed or did not take
  control.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-02T12:50:14-05:00" -->

## 0.22.0 - 2026-10-01

- Create a repository-specific fork of Simple Changes with one command. From
  the repository that will own it, run
  `simple-changes fork create --name <name> --deltas "<what you intend to
  customize>"`: the complete installed skill is copied into
  `.agents/skills/<name>` (or the path you pass with `--destination`), its
  skill identity is renamed, and a provenance line below its title records the
  exact upstream commit together with your customization notes, so
  `update-local-forks` can find and refresh it later. The global install is
  never touched, and the new copy is left uncommitted for you to customize,
  verify, and commit in its repository.
- The recorded upstream commit is verified, not guessed. The command compares
  every installed file byte for byte with upstream history (over the network
  by default, or offline with `--upstream /path/to/simple-changes`) and refuses
  to fork a modified or incomplete install, naming the files that differ;
  Finder `.DS_Store` files are ignored. A `SKILL.md` with Windows line endings
  is explained as such instead of being reported as a mismatch.
- Forks always land inside their repository. The destination is anchored at the
  Git repository root of the working directory or `--repo`, and the command
  refuses to run outside a repository, to overwrite an existing destination, to
  reuse the name of an installed sibling skill such as `update-local-forks`, and
  to write through traversal, symlinks, or a differently cased path that
  resolves into the source install. `--json` returns the destination, upstream
  commit, and file count for scripts.
- The README now explains when to adjust `.simple-changes.json` or repository
  instructions instead of forking, how to create, customize, commit, and update
  a fork, and that Claude Code loads project skills from `.claude/skills`, so a
  fork for Claude Code is created with `--destination .claude/skills/<name>`
  or linked there. The skill's own instructions carry the same guidance.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-01T22:17:12-05:00" -->

## 0.21.1 - 2026-10-01

- A controller that stops to ask the user something no longer leaves a
  live-looking run behind. When a shipment needs a decision, such as a
  migration, deployment, or cleanup approval, the controller runs
  `loop finalize --awaiting-user "<question>"` (once per question, up to ten):
  the run pauses and releases its controller even when nothing else blocks
  closure, the questions are recorded beside the lease and in the finalization
  receipt, and the command exits successfully. `loop status` shows what the run
  is waiting on, and `loop start --mode resume` hands the questions to the next
  controller as `inheritedAwaitingUser` so it confirms the answer first.
- An optional turn-end guard keeps a Claude Code or Codex session from ending
  its turn while it still controls an active run. `harness stop-hook` reports
  whether the user-level Stop hook is installed for the current harness, and
  `--write`, only after the user agrees, merges it into `~/.claude/settings.json`
  or `~/.codex/hooks.json` without touching other settings. The hook blocks the
  turn once with the exact finalize command, then only warns, so it can never
  trap a session; it lets the turn end when its script is missing or too old,
  never points into a linked worktree, and leaves another copy's hook alone
  while that copy is at least as new. `initialize` reports the guard as
  `turnEndGuard`, and `loop guard`, `loop exec`, and `loop verify` print the
  finalize step for the run (`turnEnd` in JSON).
- Abandoned runs go stale sooner. A run whose recorded harness session process
  has exited is stale after ten quiet minutes, and a run whose owner cannot be
  proven alive is stale after two quiet hours instead of four. `loop status`
  says when the owner's session has exited, and `loop recover --stale-lease`
  now archives the complete lease as `stale-lease-recovery-lease.json` beside
  its receipt, so the run's scope, outcome, and paused questions survive.
- `initialize`, `loop start`, and `loop status` warn with
  `runtimeFreshness: behind-target` when the running copy of Simple Changes is
  older than the copy on the target branch, so a stale checkout's guidance does
  not drive a shipment.
- Shipment holds withdraw and republish cleanly across clones. `hold release`
  counts a published ref as already withdrawn only when Git reports that exact
  ref absent, so a broken ref or a permission failure is still reported as a
  failure. When a release races `hold publish` and the clean-up delete fails,
  the withdrawal is reopened so the next `hold release` retries instead of
  trusting a withdrawal the push undid. `hold status`, `hold check`, and
  `loop verify --for` now tell an owner when a hold that still blocks here was
  withdrawn from another clone (`unpublishedElsewhere`), with the release
  command, and the owner can publish that hold again.
- `publish-skill` is now a maintainer-internal workflow: its frontmatter marks
  it `internal`, and the README no longer tells repository maintainers or skill
  repositories to install it project-locally. The `simple-changes` and
  `update-local-forks` packages the README installs are unchanged, and an
  existing project-local copy keeps working.
- Existing installations keep working. The session binding and paused
  questions live in a new file beside the lease, so 0.21.0 clients sharing a
  repository still read every lease and receipt. Simple Changes guidance moves
  to version 24 to explain the new abilities.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-01T20:10:14-05:00" -->

## 0.21.0 - 2026-10-01

- Hand off finished work without sending a message. An author whose checkout
  is clean and committed runs `worktree release --ready-receipt <file>` to
  record what the unit changes, which checks passed, its release impact,
  migrations, and deployment constraints against that exact head. Every
  controller in every harness on the machine sees the receipt in
  `worktree status --json`, marked current, stale, or shipped, so an active
  shipment picks the work up at its next planning point and nobody has to find
  the other agent's thread. A receipt is evidence, not authority: it never
  grants merge, deploy, migration, or cleanup permission.
- Pause or halt a shipment from any agent. `hold add` records a hold that
  delays or halts merges, deployments, or migrations, with a plain reason the
  user will read and an optional `--until-merged <branch>` that ends the hold
  once the target contains that branch. `loop verify --for merge`,
  `--for deploy`, or `--for migrations`, `hold check --for`, and
  `migration apply` stop on a covering hold: a delay asks the user whether to
  wait or continue, and a halt stops the step until the hold ends. Only the
  owner releases a hold without approval, a waiver applies to one run, and
  overriding a halt takes an explicit override.
- Share a hold with other machines. `hold publish` pushes it to the target
  remote as `refs/simple-changes/holds/<id>` so clones elsewhere, including
  cloud sandboxes, see it, and `hold release` withdraws it. Reading published
  holds never prompts for credentials and times out instead of hanging, and a
  gate that cannot read them fails closed rather than treating them as absent.
- Existing installations keep working. Receipts and holds live in new files
  beside the worktree claims, so 0.19 and 0.20 clients sharing a repository
  keep reading their state and leases unchanged. Simple Changes guidance moves
  to version 23 to explain the new abilities.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-01T16:10:25-05:00" -->

## 0.20.0 - 2026-10-01

- Inventory capture is much faster. Commands that read the repository
  inventory, including `loop start`, `loop status`, and `loop finalize`, now
  make far fewer Git calls, so a capture that took 8 to 17 seconds on a large
  macOS repository completes in about a second. Inventory digests are
  unchanged, so existing leases, plans, and receipts keep matching.
- Ship independent units in parallel. The new parallel agents guidance in
  Simple Changes explains how a controller prepares one worktree per unit with
  `prepare-agent`, lets each agent author and commit only inside its own
  worktree, and alone pushes, merges, and finalizes. `publish-skill` gains
  matching guidance for synchronizing several forks at once, and
  `update-local-forks` now plans every fork up front so one approval can cover
  all of them, then updates each repository in its own agent where the host
  supports isolated agents.
- A failed `loop finalize` no longer leaves a live controller behind. When
  finalization fails after ownership and locks are established, the run is
  relinquished with the failure reason and the original error is still
  reported, so the next agent can resume instead of facing a lease it can
  neither resume nor take over. An untouched Ship run still closes as before.
  `loop start` against a stale lease now names the exact stale-lease recovery
  command, and the skill tells controllers to confirm release with
  `loop status --json` after every finalize.
- `release-notes --check` now accepts one empty `## Unreleased` heading when it
  is the first heading in a changelog, the anchor Simple Changelogs keeps after
  every release, instead of reporting it as a failure. A second `Unreleased`
  heading, or an empty one anywhere else, is still reported.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-10-01T14:12:24-05:00" -->

## 0.19.0 - 2026-09-30

- A Ship run no longer dead-ends when something unrelated changes between
  `loop start` and `loop record-scope`. Recording the first scope now checks
  only what the shipment depends on: the plan must come from the current
  inventory, the target and the repository's policy and provider bindings must
  be unchanged, the controller checkout and every scoped source worktree must
  still match what the run registered at start, and verification must pass.
  Claimed authors may keep editing, and unrelated branch commits or stashes no
  longer block the run; each refusal names the exact cause and next step.
- A Ship run that recorded no scope and changed nothing can be closed cleanly
  with `loop end` or `loop finalize`, which writes an abort receipt and deletes
  the lease so a fresh `loop start` takes a new baseline. The lease now records
  when the run first mutated shared state, and any evidence of mutation keeps
  the existing finalize-and-replan path in force.
<!-- simple-changelogs-signature agent="Fable 5.1" at="2026-09-30T19:46:51-05:00" -->

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
