# Changelog

## 0.27.1 - 2026-10-08

- Install Simple Changes from its GitHub mirror,
  `https://github.com/soundsystems/simple-changes`, so `skills update` can
  refresh it in place. The README and the update-local-forks guide now use the
  mirror.
- A Ship run no longer stalls when an author releases its worktree with
  `worktree release` from Simple Changes 0.27.1 or later and leaves it exactly
  as released: the work ships and is cleaned up like a handoff.
- When a released or changed author worktree does block a run, `loop verify`
  and `loop status` now print the exact claim, pause, and accept commands that
  recover it, with the owner, path, and run filled in, instead of advice to
  refresh a claim that can no longer be refreshed.
- Final cleanup no longer removes a worktree that another agent still holds,
  except one this run adopted, which it cleans only once it is unchanged and
  already merged.
- Each skill now states its license and requirements and no longer names
  models, and the installed skill is about 13 KB smaller.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-08T03:40:00-05:00" -->

## 0.27.0 - 2026-10-07

- Releases can now get a Git tag on their exact commit. When Simple
  Changelogs names a tag for a release (Simple Changelogs 0.25.0 or later,
  once your repository chooses a tag style), the new `release-tag` command
  checks before the release merge that the name is free. When the release
  goes public, it creates an unsigned annotated tag on the verified commit,
  pushes only that tag to the repository's own remote, and reads it back. It
  never moves, replaces, or deletes a tag, and running it again is safe. A
  blocked tag push, such as one your Git host's tag protection rejects, stops
  the deployment, and final verification requires the tag.
- Pushing a tag uses the release's existing approval. Before the push, the
  agent lists what CI a push of that tag can start, and the push waits for
  that review. Deploy and migration holds also block it, Sync never tags, and
  a repository whose push setting is `never` is refused. A remote whose URL
  depends on the folder Git runs in, such as a relative local path, is
  refused before anything is written; use an absolute path or a network URL.
  Protecting your release tag pattern, such as `v*`, with your Git host's tag
  protection is recommended.
- `update-local-forks` now looks for the release's `v<version>` tag first
  when finding the commit a fork should pin. It still proves the tagged tree
  is byte-identical to the installed release and on the branch's history
  before using it, and otherwise searches history as before.
- The installed `SKILL.md` now states its release version, so a fork update
  reads the installed and pinned releases directly. Copies installed before
  0.27.0 are still read from their changelog.
- Simple Changes versions now follow its guidance number: 0.27.0 introduces
  guidance 27, and a fix that leaves guidance unchanged is a patch release
  such as 0.27.1. Until Simple Changelogs 0.25.0 is installed, nothing about
  your releases changes, because older Simple Changelogs names no tag. Hosted
  GitHub or GitLab Releases are out of scope.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-07T14:50:00-05:00" -->

## 0.25.2 - 2026-10-06

- `acknowledge-update` now records a guidance decision by changing only the
  `guidance` disposition and version in `.simple-changes.json`. Every other
  saved byte stays as written, including your settings, key order, spacing,
  and line endings. It used to save the settings in effect for that run, so a
  policy this clone had not confirmed lost its elevated settings (push
  `configure-harness` was saved as `ask`) and gained default fields such as
  `proposalScheduling`. Acknowledging still grants no authority. Repeating
  the decision already recorded writes nothing, so a confirmed policy stays
  confirmed. For a policy with elevated settings, a new decision changes the
  bytes its trust receipt covers, so setup must confirm it again, and one that
  would turn an unconfirmed file back into bytes an earlier receipt confirmed
  is refused, with nothing written; run setup to confirm the policy instead.
  Setup and `acknowledge-update` now take the repository lock outside a loop
  too, so either can fail as busy while the other runs.
- `update-local-forks` no longer rewrites version text in a fork. Each
  fork-owned line that names the previous Simple Changes release, or the
  previous `CURRENT_GUIDANCE_VERSION`, is listed in the plan with its line
  number and a suggested replacement, and you change it by hand. Most forks
  have one such line, in a test that checks the bundled version. Files the
  fork carries unchanged from upstream take upstream's new bytes and are never
  listed, so a carried line such as "Simple Changes 0.25.0 or later" keeps its
  meaning. Plan again instead of applying a plan saved by 0.25.1 that rewrites
  version text or a file it marks current; apply refuses it.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-06T19:45:00-05:00" -->

## 0.25.1 - 2026-10-05

- `update-local-forks` now moves a fork's pin when a release received review
  fixes after its release notes were written. It pins a verified commit that
  carries exactly the installed release tree, instead of refusing and leaving
  the pin to be set by hand. It still never pins a guess: if the installed
  skill matches no commit of that release byte for byte, the plan keeps the
  pin and says how many commits it checked.
- The byte-for-byte check now compares raw file contents and file names. A
  release whose file contents contain invalid UTF-8 can now verify, and a
  look-alike install whose bytes or names differ no longer does. Applying a
  plan made by this version writes every file's contents byte for byte,
  including merges and version rewrites. Plan again instead of applying a
  plan saved by an earlier version when any file involved holds invalid UTF-8.
  A release or install with a file name that is not valid UTF-8 is refused
  instead of pinned, and non-ASCII file names such as `café.txt` now update
  and delete cleanly after they are pinned.
- Pin updates no longer rewrite past release entries in a fork's maintenance
  notes when their `#` headings name a commit, range, or date, or when they
  continue the history log, including notes with Windows line endings. The
  lines under a heading that starts with "Current" are still updated when that
  heading is not inside a history section. Underlined (Setext) headings are
  not recognized.
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
