# Changelog

## 0.33.0 - 2026-10-24

- Finishing a run no longer leaves merged branches on your Git host while
  saying cleanup is complete. In 0.31.0 and 0.32.0, every branch on the
  host was kept, even one a merged merge request had already shipped, and
  `loop finalize` still reported `cleanupStatus: complete`. Now the final
  `remote-inventory build` proposes deleting a host branch when the host
  proves it finished: a merged merge request recorded exactly its head,
  its head did not move during the run, it is unprotected and not the
  target, and no open merge request, live worktree, or claim uses it. The
  build lists these under `deletionProposals`. Nothing is deleted
  automatically: each proposal still goes through `loop guard`, an exact
  deletion on the host, and `loop verify`, and the next final inventory
  records it as `deleted-merged`. In a shallow clone the build proposes
  nothing and asks you to run `git fetch --unshallow`, because the check
  needs the full history.
- `loop finalize` now reports `cleanupStatus: pending` whenever it kept a
  host branch that is provably finished, because a merged merge request
  recorded exactly its final head or because Git proves the target already
  contains that head. The finalization receipt names each such branch, its
  head, and its proof under `remoteBranches.pending`. A branch that is
  finished but still in use, because an open merge request targets it, a
  worktree has it checked out, a local branch tracks it, an unreleased
  claim holds it, or a live branch was cut from its head, is listed under
  `remoteBranches.held` with its reasons and does not make cleanup pending;
  the next finalize after that use ends reports it. When Git cannot settle
  whether a branch is finished, for example because its head is missing
  locally or a Git command failed, that is an error that also keeps
  cleanup pending, so missing evidence never reads as clean. A pending
  status never blocks delivery or the next shipment.
- To approve deleting a branch whose work the target already contains but
  that no merged merge request covers, add an entry for it to the
  `--decisions` file you already use. The build then lists it as a
  deletion proposal with basis `decision`, and after the guarded deletion
  the same entry records it. The build refuses that entry when the branch
  is the target or protected, when its head moved during the run, when an
  open merge request comes from it or goes into it, when live work holds
  it, or when it is a merged head, which needs no entry.
- A branch on your Git host that someone else deleted during a run no
  longer stops the run from finishing. Before, when a branch from the
  opening inventory disappeared and no merged merge request proved it
  finished, the final `remote-inventory build` refused, so the run could
  not record its host branches or end. Now the build records the branch as
  deleted outside the run, and never counts it as delivered, merged, or
  obsolete. `loop reconcile-remote-branches` keeps the branch's last
  commit reachable under `refs/simple-changes/external/` when that commit
  is on this machine, so the work can still be recovered. `loop finalize`
  names the branch under `remoteBranches.deletedExternally` and in its
  plain output, with a note giving its last commit, keeps `cleanupStatus`
  at `pending`, and still closes the run. The kept reference is removed
  the next time `loop finalize` closes a run, once 14 days have passed
  since it was made. A branch deleted while its merge request is still
  open still stops the build.
- Commands that record review and shipment details can now wait for a
  busy lock instead of failing at once. When another Simple Changes command
  is in the middle of writing, these commands used to exit 5 right away.
  Pass `--wait-lock`, optionally with `--timeout-ms <n>` (default 60000,
  at most 600000), to `author attest`, `proposal record-authors`,
  `proposal record-review`, `proposal waive-coverage`, `loop record-scope`,
  `loop refresh-scope`, `loop record-outcome`, or
  `worktree release --ready-receipt`. The command then waits while a live
  process holds the lock and runs once when it is free. A wait never
  breaks or takes over a lock. It ends early, with exit 5 and nothing
  written, when the process holding the lock is gone on this machine (only
  `loop recover` may clear that lock) or when the command runs inside that
  process, such as inside `loop exec`. With `--json`, the error gains a
  `lockWait` object that says why the wait ended and that nothing ran.
  Without the flag, nothing changes. `initialize --mode preview` already
  checks the reviewer without taking the lock, so a busy lock never blocks
  it.
- A unit can now be held back truthfully after a run's shipment scope
  froze, for example when an independent review found defects in it. Run
  `simple-changes loop hold-unit --run-id <run> --agent-id <you> --unit
  <unit ID> --reason <text> --readiness-evidence "<unit ID>: <evidence>"`.
  Without approval flags it changes nothing and prints exactly what it
  saw: the unit's files, its checkout, branch, head, claim, the target,
  and a digest of that observation. After you approve that exact
  observation, the agent runs the same command again with `--approved-by`,
  `--approval-reference`, and `--observation-digest`. The approver must be
  neither the controller nor the agent that owns the work, and any change
  since the observation refuses.
- A held unit is never reported as delivered or as already in the target.
  `loop record-outcome` refuses it and no longer requires it, and
  `loop draft-outcome` warns about it instead of suggesting an outcome,
  including when another unit changed a file it shares, such as a shared
  changelog. `loop finalize` lists it under `heldUnits` and a "Held, not
  delivered" line, never touches its checkout, branch, claim, or files,
  and lets the other units close as verified delivery. Its head is kept
  reachable at `refs/simple-changes/held/<run>/<unit>`. `worktree cleanup`
  keeps a held checkout's claim even after the run ends, and
  `loop retire-absent-worktree` refuses to retire a held checkout. A run
  that held every unit closes with its held work in place and delivery
  unverified; `loop close-equivalent` and `loop recover-post-cleanup`
  refuse a run with a held unit.
- Holding a unit adds a `heldUnits` key to that run's lease, so copies of
  Simple Changes older than 0.33.0 refuse that run entirely: they cannot
  record, finish, end, archive, or clean it. Use 0.33.0 or later for every
  step of a held run. Runs without holds keep their exact lease shape.
- A delivered unit can now close the run while its source checkout stays
  exactly as it is, uncommitted changes included, whether that checkout is
  detached or on a branch. Before, there was no truthful way to record
  that. `loop record-outcome` accepts a `preservedSourceHandoff` on such a
  unit. It names the original owner's claim and accepted
  `worktree pause --disposition preserve-in-place` receipt, the source's
  exact files, the commit that copied those exact bytes into the target,
  an independent reviewer's check of the final target files, and your
  approval to keep the source in place, given through the existing
  `--approved-by` and `--approval-reference` flags. Simple Changes reads
  every file in the source directly rather than trusting `git status`, and
  the unit must cover every change in it. The run then finishes as
  verified delivery and leaves the source checkout, its files, and its
  claim untouched.
- The handoff is refused, with exit 3 when it is recorded or as a
  completion blocker later, when the owner, the claim, or the pause does
  not match; when the source changed after the pause, holds a change
  outside the unit (even one Git status is told to hide), a rename, a
  conflict, a submodule, a nested repository, or an untracked folder; when
  the copy's bytes differ, the copy commit has more than one parent or
  changes outside the unit, or the copy is not in the final target; when
  the reviewer or the approval is missing, stale, or given by the owner or
  the controller; or when the target no longer holds the reviewed files.
  The handoff lives in its own new file, which older copies cannot read,
  so they refuse to finish, end, or archive such a run. A handoff reads
  every tracked file in the source each time it is checked, so a very
  large source takes longer.
- `loop replan` and `loop archive-recorded` no longer lose your approval
  only because another agent finished its own work and released its claim
  while you were approving. Before, any change to the coordination state
  made the approval stale. Now, when the state changed, replan works out
  exactly what changed. The approval still stands when every difference is
  an agent releasing its own live claim with `worktree release` or a
  handoff, recording exactly the checkout state you approved, and the
  source and the target are unchanged. Any other difference refuses as
  before, and the refusal now prints exactly what changed, such as a new,
  removed, or reassigned claim, a takeover, a release by another agent, a
  changed source, or a moved target, so you can review it and approve
  again from a new `loop replan-status`. A replan that accepted a change
  says so and names each release, and its `--json` output adds
  `approvalDelta`. An approval seen by an older `loop replan-status` is not
  on record, so it still refuses as before.
- New read-only `simple-changes reviewer room` checks, before you start an
  author, whether independent review will still be possible once that
  author has written its part. Before, you found out only afterwards, when
  the review check reported `reviewer-not-distinct`. Pass each author you
  are about to start with `--would-author <harness id>/<model ID>`, plus
  `--base` and `--head` or `--proposal` when the work exists. It counts
  every recorded author, checks the review model at the effort review
  needs now and at the higher effort a later round may need, and for each
  possible reviewer says whether it stays eligible and which authors and
  commits rule it out. It never assumes a reviewer is available: a route
  counts only after the controller reports a real run of that model at
  that effort with `--verified-route <harness id>/<model ID>@<effort>`,
  and sign-in or status text never counts. A display name instead of a
  model ID, or an ID that differs only by an effort word such as `xhigh`,
  leaves the answer `unknown`. The room is `open`, exit 0, only when the
  configured reviewer stays eligible and a real run proves it at both
  efforts; `unverified`, `alternative-only`, `closed`, and `unknown` exit
  3. It writes nothing.
- When one coding agent starts another, each one is now recorded as
  itself. The agent that was started can see its parent's session variable
  beside its own, and Simple Changes used to pick one by a fixed order, so
  the child could be recorded as its parent and then pass review of its
  own work. Now, when the environment shows the sessions of two coding
  tools, such as Codex started from Claude Code, every command that
  records or checks which session is running stops with exit 2, before it
  takes a lock or writes anything, and asks for `--harness <id>` naming
  the tool it runs in (`claude-code` or `codex`). These are
  `author attest`, `proposal record-authors`, `worktree claim`,
  `takeover`, `pause`, `detach`, `attach`, and `release`,
  `initialize --mode handoff --agent-id`, every `loop start`,
  `loop takeover`, a direct `loop turn-check`, and `workdir` inside a run.
  A `--harness` that names a harness with no session here exits 5. With
  only one session in view, nothing changes.
- A harness, or a wrapper around it, can instead pass
  `--identity-receipt <JSON or @file>`, which states the harness, the
  session, the model ID, and optionally the agent instance and the parent
  session. It must agree with the environment, and with `--harness`,
  `--session`, `--agent`, and `--instance` on any command; otherwise the
  command stops with exit 2 and does nothing. It is never stored. It fixes
  a confused identity; it does not prove anything against a forged one.
- Review independence for the review check is now decided per agent
  instance. The same model, even in the same harness, may review work as
  long as it is a different instance, and the same instance never may,
  even when its records name different sessions, harnesses, or models. A
  record that shows neither an instance nor a session is still refused.
  None of the checks became more permissive. In setup, naming the author's
  own model under "A different model in the same agent" still asks for a
  different model, but the message no longer calls that self-review: it
  says a separate session of that model is an independent reviewer under
  "Any independent reviewer".
- Finishing a run no longer undoes approved repository settings. When the
  primary checkout had uncommitted changes and already held the target's
  `.simple-changes.json`, for example an approved migration setting,
  `loop finalize` and `loop close-equivalent` used to put the file back to
  the checkout's older committed copy. That undid the approved setting and
  invalidated its trust record until you ran `setup` again. Now finishing
  never rewrites the bytes of that file, or of any file its trust record
  covers: when the checkout can move forward to the target, the file goes
  along unchanged, and otherwise it is kept byte for byte. A note says
  which happened. A target that committed different settings is still
  adopted, and because trust covers exact bytes, the sensitive settings
  stay reduced until `setup` confirms them.
- `loop retire-absent-worktree` can now account for a removed checkout
  that the run itself created, when its kept branch's work reached the
  target inside a larger commit. Before, such a checkout failed every
  containment check, `loop close-equivalent` refused with "the obligated
  worktree is missing", and the retirement refused every checkout a run
  created. Now, once you approve removing the checkout and its branch is
  kept, the retirement is accepted when every file the branch's commits
  touched is byte for byte identical in the current target. The branch
  stays, and automatic cleanup keeps it; a branch that moves or is deleted
  ends the retirement. It refuses, recording nothing, when the branch is
  missing, checked out, or shared, when a touched file differs, or when
  the branch holds a merge commit or more than 200 commits. It deletes
  nothing.
- A checkout that `loop rebaseline` added to a run as a late arrival is no
  longer removed when `loop end`, `loop finalize`, or
  `loop close-equivalent` cleans up, even when it is clean and the target
  already holds its work, and it no longer stops the run from ending. The
  recovery guide already promised this. A later run that registers the
  checkout when it starts treats it like any other checkout.
- Simple Changes no longer writes its records to the wrong place when Git
  gives a wrong or empty answer. Under heavy load, Git sometimes printed
  nothing when asked where the repository's shared Git folder is, and that
  empty answer pointed at the checkout itself, so a review record and a
  lock could be written into your project as untracked files. Now every
  command checks that answer before it takes a lock or writes anything.
  It refuses, with exit 4 and nothing written, when the answer is empty,
  points at a missing path or the checkout itself, is not a repository's
  Git folder, or belongs to another repository. The refusal ends with a
  short `Diagnostics:` line that shows what Git answered, so you can retry
  or report it. When Git succeeds but prints nothing to a question that
  always has an answer, Simple Changes asks once more and then refuses
  with a retryable error. Every folder under
  `<shared Git folder>/simple-changes` is now created one level at a time,
  and a symbolic link anywhere on that path is refused instead of
  followed.
- The checks added in this release that compare files with the target,
  list a source checkout's files, or read one file from the target now
  also tell a real "nothing there" from an answer Git lost, and refuse
  instead of treating a lost answer as proof.
- A repository can keep its own changelog helper under a folder name of
  its choosing in its skill folders, such as
  `.agents/skills/team-changelog-maintainer`, as long as that folder holds
  a valid `changelog-provider.json` marker and really lives inside the
  repository. Simple Changes now finds it, prefers it to a changelog skill
  installed for every repository, and compares the repository's saved
  guidance version with that helper's version, so `initialize` no longer
  shows a false "Simple Changelogs has recently been updated" notice from
  a global install the repository never chose. A renamed folder without
  the marker, with a marker for another provider, or that links outside
  the repository is ignored, and a helper that can only be discovered
  never outranks one that can take the release handoff.
- A clean checkout whose work shipped as reworked commits can now be
  removed, and the removal can be undone. When review refines a change,
  the commits that ship differ from the originals, so `prune` and
  `worktree cleanup` used to keep the old checkout forever. Now
  `prune --agent-id <you> --lineage-receipt <file>` and
  `worktree cleanup --lineage-receipt <file>` remove that one checkout when
  the receipt maps every original commit the target lacks to the reworked
  commits in it, an independent reviewer checked the mapping, and you
  approved it afterwards, within 24 hours. The removal is reported as
  `reviewed-replacement`. Without `--lineage-receipt`, both commands
  remove exactly what they removed before. `prune --dry-run` with a
  receipt shows the archive's size, when it would expire, and what else
  the run would prune, and changes nothing.
- Before anything is removed, the checkout and its private Git folder are
  copied whole into an archive under
  `<shared Git folder>/simple-changes/archives/<archive ID>/`, with a
  `manifest.json` listing every file and its checksum, and the commit and
  every other object the checkout refers to, such as a saved stash, are
  kept reachable under `refs/simple-changes/archives/<archive ID>/`. The
  branch's settings, such as its description and upstream, are saved in
  the manifest. Right before removal, the live checkout is compared with
  the copy, and Git must still list it at the reviewed commit and branch.
  Any difference keeps the checkout, and keeps the complete archive until
  it expires. If the archive cannot be completed, it is removed again and
  the refusal says so. A Git state file in the checkout's private folder
  larger than 1 MiB, such as a `FETCH_HEAD` grown by repeated fetches,
  refuses the removal and leaves no archive, naming the file and its size,
  because Simple Changes cannot read every commit such a file names.
  Commits only the checkout's reflogs still remember, such as one replaced
  by `git commit --amend`, are kept reachable too, and a checkout with
  more than 2,000 of them is kept, not removed.
- `simple-changes worktree restore-archive --archive <archive ID>` puts
  the checkout and its branch back exactly as they were and confirms that
  Git sees the checkout clean at the recorded commit. It refuses, changing
  nothing, when anything is in the way. `--extract-to <folder>` copies the
  archive to an empty folder instead, for when the original location is
  taken, and `simple-changes worktree archives` lists every archive with
  its size and expiry. A restore that stops part way leaves a marker, and
  automatic pruning leaves that archive alone until a restore succeeds.
- Archives clean themselves up. Each one expires after 14 days, and all
  archives together are kept under 2 GiB; set `archiveRetention.days` and
  `archiveRetention.maxTotalBytes` in `.simple-changes.json` to change
  that. A value that is not a whole number in range falls back to the
  default, and the output says so. `prune`, `worktree cleanup`, and a
  `loop finalize` that closes its run prune archives at the end of a run
  whose own removals succeeded, never the archive that run made. While
  the archives are over the size limit, the oldest goes first, whatever
  its expiry. An archive that cannot be pruned, for example because Git
  left a lock file behind, frees nothing, so the next oldest goes instead
  until the total fits; then the expired archives go. An archive whose
  reworked commits the target no longer holds, or reverted, or whose kept
  references cannot all be deleted, stays whole for your attention, named
  with its restore command in every report, and is tried again next time.
  Each pruned archive is recorded in `archives/prune-log.json`, and the
  output says how many bytes the archives hold and which limit applied.
  To prune by hand, run
  `simple-changes worktree prune-archives --archive <archive ID>` or
  `--older-than <days>`, with `--approved-by` and `--reason`, and
  `--dry-run` to preview. A repository whose `.simple-changes.json` sets
  `archiveRetention` needs 0.33.0 or later.
- The removal of a reworked checkout runs every Git command with hooks,
  file-system monitors, and filter programs switched off, and refuses a
  checkout with submodules, a partial clone, or a hook set through
  `hook.*`. This is hardening only: programs your Git configuration runs
  stay trusted, as on every other removal. The archive keeps what Git
  keeps, so extended file attributes, resource forks, and access lists
  are not archived, and only Git's own `This reverts commit` message is
  recognized as a revert.
- Agents now load less text for the same rules: rules that several
  references repeated now live in one place, and the others link to it.
  No behavior, setting, default, or check changed. `SKILL.md` is 218 bytes
  smaller and the packaged references 13,587 bytes smaller.
- `SECURITY.md` now states the threat model. Simple Changes protects
  people who may know a lot or very little about Git, running many agents
  at once on one machine, from accidents: lost work, shipping the wrong
  thing, agents getting in each other's way, an agent reviewing its own
  work, Git or host commands that fail or return partial answers, leftover
  branches, worktrees, and records, and text in branches, commits, or
  issues that tries to give instructions. It trusts your machine, your Git
  configuration and the programs it runs, its own records in the Git
  folder, and your Git host. It also states the design principles every
  change follows: a reversible step beats a hard proof, missing evidence
  keeps the work, anything kept for safety cleans itself up at a natural
  point without your help, and commands explain outcomes in plain words
  and ask only for decisions you can make. Reviews of Simple Changes now
  grade findings against it.
- Choosing "This run only" during setup now lets the agent finish the
  request you started it for. Before, run-only setup saved nothing and
  told the agent nothing, so every later check in the same run still said
  setup was required and `loop start --changelog-required` stopped with
  exit 5. Now setup prints the exact value to pass on, under `runRequest`
  in its output, and the agent passes it as `--policy-request` to each
  later `initialize` and `loop start` of that run. It applies only when no
  repository or personal policy is saved, is never written anywhere, and
  never turns on automatic pushes, production deploys, non-standard
  shipping, or automatic migrations; those fall back to their safe
  settings, such as asking first or standard shipping. A saved policy
  always wins. A malformed or out-of-date value is refused with exit 2 and
  changes nothing. The next run asks the setup questions again, as before.
  Older copies reject `--policy-request` as unknown.
- Sharing a repository with an older release: the lease, coordination,
  review ledger, and authoring files keep their shapes, except a held
  run's lease, described above. Every other new record is a new file that
  older copies ignore, which leaves them stricter, not looser: they cannot
  finish a run with a handoff, they still refuse an approval that only a
  verified release changed, they treat a renamed changelog helper as
  absent, and an older `loop end` refuses a run whose host branch was
  deleted outside it. They reject the new flags and commands, such as
  `--wait-lock`, `--identity-receipt`, and `reviewer room`, as unknown,
  and an older builder rejects proposal pages that list
  `openProposalTargets`. Older copies still remove a clean rebaselined
  checkout.
- Older copies also still record whichever harness session comes first in
  their fixed order, which for an agent started by another agent may be
  its parent's, so update every copy that such agents use. A claim one of
  them made that way is bound to the parent's session: with 0.33.0 the
  started agent passes `--harness` and is refused as another session, and
  the existing approved `worktree takeover` moves the claim. A review that
  an older copy accepted from the author's own instance under another
  session is refused when 0.33.0 resumes the run.
- Filed for a later release:
  - soundsystems/simple-changes#19: a local branch with more than one
    `branch.<name>.merge` value, which only a hand edit or
    `git config --add` writes, can make the build propose deleting the
    host branch it really tracks. The deletion still needs the guarded
    steps.
  - soundsystems/simple-changes#20: during the removal of a reworked
    checkout, a filter program whose name Simple Changes cannot read back
    exactly, such as an empty name or one that is not valid UTF-8, is not
    switched off.
  - soundsystems/simple-changes#21: keep all Simple Changes records in one
    versioned store, and expire the details of old runs.
  - soundsystems/simple-changes#22: let a run finish on its own by
    recording the outcome, reconciling host branches, and removing proven
    worktrees inside `loop finalize`.
  - soundsystems/simple-changes#23: keep a small local log of refusals, so
    it is clear which safety checks fire and how often.
  - soundsystems/simple-changes#24: judge reviewer independence by agent
    instance, not only by agent ID, in the receipts for removing a
    reworked checkout and for preserved sources.
  - soundsystems/simple-changes#25: follow-ups for host branches deleted
    outside a run, such as expiring their records with their kept
    references and pruning those references in `loop close-equivalent`.
- The guidance 33 update notice asks agents started by other agents to
  pass `--harness`, and describes held units, finished host branches, the
  reviewer room, and archived removals of reworked checkouts. It needs no
  answer.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 high" at="2026-10-24T01:34:00-05:00" -->

## 0.32.0 - 2026-10-20

- `prepare-agent` now creates each agent's worktree directly beside the
  primary checkout, as
  `.simple-changes-<repository>--<run>--<purpose>--<agent>`, instead of
  under `.simple-changes-worktrees/<repository>/`. The folder that holds
  the primary checkout already exists, so Git creates only the worktree's
  own folder and Simple Changes creates no parent folder; removing the
  worktree at cleanup leaves nothing behind. Each part of the name is
  reduced to lowercase letters, digits, and hyphens, so it cannot leave
  that folder, and `prepare-agent` refuses, creating nothing, when anything
  already holds the path, even a dangling symbolic link. The branch name is
  unchanged. Agents that claim a worktree of their own are now told to
  create it beside the primary checkout too, as
  `.simple-changes-<repository>--<name>`, never in a folder made for it.
- Worktrees an older release made under `.simple-changes-worktrees/` keep
  working, because every command finds a run's worktrees by the paths the
  run recorded. A preparation an older release recorded there resumes only
  while its folder still exists; if the folder is gone, `prepare-agent`
  asks you to restore it instead of creating it. Simple Changes never
  removes a worktree's parent folder. When `loop finalize`,
  `loop close-equivalent`, `worktree cleanup`, or `prune` leaves one of
  those older folders empty, it names the folder in an informational note
  in its JSON `notes`, also printed after `loop finalize`, `worktree
  cleanup`, and `prune`, and leaves it for you. A note never blocks
  completion.
- Keep uncommitted work in Git: commit it on a branch of its own and have
  its owner record a `worktree pause --disposition preserve-in-place`
  receipt. When a file copy is unavoidable, the agent puts it in a
  read-only `preservation-copy` directory at the top of its work directory,
  with a `manifest.json`. A clean `loop finalize` or `loop end`, and the
  next `loop start`, now keep a work directory that holds
  `preservation-copy` and report it with the `chmod -R u+w` and
  `simple-changes workdir remove` commands to run once the target or a
  pushed branch holds that work. The check only sees that the directory
  exists. Its read-only files also stop an older release's cleanup run as
  an ordinary user, but not a process running as root, so commit the work
  to a branch when that can happen.
- The optional scratch-file rule that setup writes to AGENTS.md or
  CLAUDE.md now also tells agents to preserve uncommitted work in Git
  rather than as loose copies, to keep an unavoidable file copy only in
  that read-only `preservation-copy` directory until a pushed branch or the
  target contains the work, and to create worktrees where their brief or a
  Simple Changes run puts them, never in a folder made beside your
  repositories, removing any such folder they made with `rmdir` once its
  worktrees are gone. Because the rule's text changed, `initialize` reports
  a copy an earlier release wrote as `stale` and offers
  `simple-changes scratch-file-rule refresh --instruction-file <path>`,
  which rewrites only that block.
- A run whose shipment scope froze, for example because the turn-end
  finalize relinquished it, can now add a changelog-only author to a unit
  the frozen scope already registers:
  `simple-changes prepare-agent --run-id <run> --agent-id <new ID>
  --purpose changelog --unit <unit ID>`. It creates no unit, widens no
  scope, and needs no new approval. The author may change only the release
  surfaces the primary checkout held when it was prepared, out of
  `CHANGELOG.md`, `DEVELOPER_CHANGELOG.md`, `CMS_CHANGELOG.json`, and the
  Simple Changelogs policy files; the new `changelogAuthor` output lists
  them. `--unit` is refused before the scope freezes, for any other
  purpose, for a unit the scope does not register, for an agent ID already
  registered another way, and in a repository with no release surface.
  Without `--unit`, a frozen run still refuses every new author.
- Any other change by that author, whether uncommitted, on its branch even
  after its checkout is removed, or in a commit it attested, makes
  `loop verify` report the new `changelog-author-outside-release-surfaces`
  violation and the unit stale. An attested commit stays in the review
  ledger, so that unit then stays stale for the run; replan it or ship the
  work in a fresh loop. The author's checkout never becomes the
  controller's: `loop start --mode resume` and an approved `loop takeover`
  run from it are refused. Its attestation changes the unit's authors
  digest, so reviews recorded before it stop counting and the head needs a
  fresh review.
- An owner whose pause the controller accepted can now release its claim
  as finished work with `worktree release` or `initialize --mode handoff`,
  without claiming and pausing again. While the release recorded the
  checkout's exact path, branch, HEAD, and status digest, that state
  matches the accepted pause and the registered baseline, and no newer
  claim holds the checkout, `loop verify` stays clean and the run keeps
  shipping. Before, that release made every guarded step fail with
  `coordination-claim-stale`, which on an adopted checkout now says which
  of these no longer holds.
- `worktree resume-ready` now works in a run that replaced another through
  an approved `loop replan`, using the owner's pause receipt for the
  replaced run, while the checkout is unchanged. When it still refuses, it
  prints the owner's exact `worktree pause` command for the current run.
- A resumed run no longer reports a worktree its own finalization removed
  as missing. Before, once a guarded fetch moved the target, that path was
  reported as `missing-preserved-worktree` and needed a
  `retire-absent-worktree` approval. A removal that finalization recorded
  as completed now stays accepted after the target moves; a removal that
  is only intended still holds only at the target revision its audit used.
- Simple Changes now records a branch only by its exact name, which fixes
  the known limit 0.31.1 listed. Git output is read as UTF-8, so a branch
  name that is not valid UTF-8, or that contains U+FFFD, can read the same
  as another one. `worktree claim`, `worktree pause`,
  `worktree release --ready-receipt`, `loop rebaseline`,
  `loop adopt-worktree`, `loop accept-paused-change`,
  `loop dispose-worktree`, and `loop retain-worktree` refuse such a branch
  with exit 5, name the checkout, and write nothing, and `loop start`
  refuses while any worktree of the repository is on one. Rename the
  branch to a valid UTF-8 name and retry. `loop finalize` reports such a
  branch as a cleanup error, leaves that claim, registration, and checkout
  as they are, and never deletes a branch whose name is not exact.
  Releasing such a claim stays allowed but records no checkout state, and
  `loop status` and `loop verify` no longer admit an older claim on such a
  branch as a concurrent author; verification names the worktree by path
  instead. Records an older release wrote keep their names until they are
  released or replaced.
- The review ledger and the authoring file now have an `extensions`
  object, at the ledger root, on each attestation, completion, and review
  attempt, and on each role in the authoring file. A later Simple Changes
  can add a field there without 0.32.0 or later reading the file as
  malformed: a reader accepts its members without interpreting them, and
  only a field whose absence leaves a reader stricter goes there. An
  unknown key beside it now says a newer Simple Changes may have written
  it and to update this runtime. Nothing writes `extensions` yet, so files
  0.32.0 writes keep the shape 0.31.x reads, but releases before 0.32.0
  reject a ledger or authoring file that holds it.
- A ledger or authoring file that holds extensions must spell its JSON the
  way Simple Changes writes it, which usually matters only after a hand
  edit. A number, string escape, key order, or repeated key spelled
  otherwise, or a byte that is not valid UTF-8, makes the file malformed,
  and such a ledger blocks acceptance and ledger writes until it is
  restored; an authoring answer spelled that way is refused. A ledger write
  keeps every extension byte for byte, and a ledger holding extensions
  that differs only in spacing is read but never rewritten. A write to the
  authoring file keeps every extension value but may change its spacing.
- The GitLab provider reference now describes how a repository adapter
  recovers a hosted CI run that passed but whose result it failed to
  publish: it records a `partial` provider receipt naming the exact
  pipeline and attempt, and recovery checks that exact pipeline again and
  republishes its result without starting another run or adopting an
  unrelated passing one. The GitHub reference points to the same contract.
  Simple Changes runs no CI itself, so its behavior is unchanged.
- Sharing a repository with an older release: it ignores the new
  `changelog-author` record, so it treats a changelog-only author as an
  ordinary prepared author without the release-surface limit, and it
  rejects `prepare-agent --unit` as an unknown option. The lease,
  coordination, ledger, and outcome formats are unchanged.
- The guidance 32 update notice describes the worktree layout, the stale
  scratch-file rule, the changelog-only author, and the extension point,
  and needs no answer.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 high" at="2026-10-20T13:31:42-05:00" -->

## 0.31.1 - 2026-10-17

- **Bug Fixes & Improvements**:
  - `worktree takeover` now compares the branch, HEAD, and status digest an
    approval names exactly as given, which fixes the first takeover limit
    0.31.0 listed. Before, it trimmed `--branch`, and inventory could drop
    the same trailing space from the branch it observed, so a branch name
    ending in a non-breaking space (U+00A0), which Git allows, was not
    matched exactly: an approval could match a branch that differed from it
    only by that space, or refuse the exact branch. `--head` must now be
    `none` or the full commit ID, and `--status-digest` the status digest,
    exactly, with no surrounding space, or the command exits 2. Before,
    surrounding space on either was trimmed away, and a digest of the wrong
    shape was refused as a changed worktree.
  - A takeover that reassigns a claim now refuses, with exit 5, when the
    approved or the observed branch name is not valid UTF-8. Simple Changes
    reads such a name with its invalid bytes replaced, so two different
    names can read the same, and an approval of one could have matched the
    other. Rename the branch to a UTF-8 name, observe the checkout again,
    and retry. A takeover with `--release` still retires such a claim,
    including after its checkout is gone, and the refusal says so.
  - A ready-work refusal from another session for a removed checkout now
    prints the exact takeover that would be accepted, with the claim's
    recorded branch and status digest, such as the `--release` form for a
    checkout that can no longer be reattached. This fixes the other
    takeover limit 0.31.0 listed. Before, it printed `<sha>`, `<name>`, and
    `<digest>` placeholders, and for a checkout that could only be released
    it offered a reassign that would be refused.
  - Publishing and withdrawing a shipment hold now push with
    `--no-follow-tags`, as `release-tag` already did, so your
    `push.followTags` setting can no longer send a tag along with a hold
    ref. Before, a publish followed that setting, so an annotated tag on the
    hold's commit could be pushed with it. The README's Security model now
    says both pushes pass the flag.
  - Known limit, tracked for a later release: other checks that compare a
    recorded branch with the one Git reports, such as claims, pause and
    ready receipts, and the checkouts a run registers, still read a branch
    name that is not valid UTF-8 with its invalid bytes replaced, so two
    such names can look the same. This predates 0.31.1, and such names are
    rare: on macOS the file system refuses them as ref files, so Git can
    keep them only as packed refs.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-17T16:31:06-05:00" -->

## 0.31.0 - 2026-10-17

- Canonical model IDs are here, as 0.30.1 said they would be: adversarial
  review now compares the model IDs coding agents report, such as
  `model-5-5`, and 0.30.1's interim name matching is gone. A model ID is
  lowercase, with no spaces, effort word, or note, and two IDs match only
  when they are equal after ignoring case and one `provider/` prefix; a
  display name such as `Model 5.5 high` is not an ID. Within one coding
  agent, a name that is not an ID on either side now fails closed with
  `author-identity-missing` or `reviewer-identity-missing`, and the new
  `reviewer-model-id-missing` stops a review before dispatch when the
  configured reviewer model is not an ID. Across coding agents a reported
  name is still enough, and signatures still name the reported model.
  Setup's reviewer model question now takes only a model ID that differs
  from the author's.
- Pass the model ID to `author attest --agent`. An attestation that
  recorded a display name now blocks adversarial review within its coding
  agent until a reviewer from another coding agent reviews, or its author
  completes it from the same session with `author attest --commit <sha>
  --agent-id <id> --agent <model ID> --complete-identity`, adding
  `--instance` when the earlier record has one. `initialize`,
  `proposal record-review`, and `loop start --mode resume` print that step
  and say when it does not apply. A completion now stands only while no
  two records from its session, coding agent, and agent ID disagree.
  Completions written by 0.30.x stay valid.
- Update every copy of Simple Changes that shares a repository to 0.31.0
  before you complete a display-name attestation with a model ID or record
  graded review findings. Earlier copies read a review ledger holding either
  as malformed and block review until they are updated, and they reject an
  authoring file that records `reviewLoop`, which setup's recommended
  answers never write.
- Reviews can now grade each finding as blocking, should-fix, or nit, as
  `severities` counts in the receipt passed to `proposal record-review`.
  By default only blocking or should-fix findings raise later reviews of
  that change to the escalation effort; nit-only findings keep the first
  effort, and findings recorded without grades escalate as before.
- `initialize --proposal <id> --head <sha>` now reports where the review
  loop stands, as `reviewer.loop` in JSON and a `Review loop:` line in text.
  After 2 rounds in a row with blocking or should-fix findings, it tells the
  agent to question the approach before the next fix when those findings
  sit in one area. After 4 more rounds following the first such finding
  without a clean review, it tells the agent to ask you whether to ship with
  the open findings filed as issues, change the design, or keep reviewing. An
  accepted clean review starts the count over, and neither check approves
  or skips a review.
- Setup now asks the review loop questions for every reviewer choice: the
  effort for a change's first review (`high` recommended), whether later
  reviews escalate to xhigh after blocking or should-fix findings
  (recommended), after any finding, or never, and whether the agent stops
  to check with you as above (recommended) or never. Existing setups are
  not asked again, because without a `reviewLoop` setting the recommended
  loop applies.
- Setup can also add an optional review-loop rule to AGENTS.md or CLAUDE.md
  in its own managed block, offered after the scratch-file rule or added
  with `--review-loop-rule add`. It tells agents how to run review rounds in
  Simple Changes runs with your review settings. `initialize` reports a
  copy an earlier release wrote as stale, and
  `simple-changes review-loop-rule refresh --instruction-file <path>`
  rewrites just that block.
- A worktree claim now belongs to the coding agent session that made it.
  From any other session, or one that reports no session, its agent ID can
  no longer refresh, pause, detach, attach, or release the claim, record
  ready work or a handoff for it, attest commits through it, or start
  another claim while it is live. Each refusal prints the exact
  `worktree takeover` that, with your approval, moves the claim to the
  asking session. A claim made before this release, or without a session,
  binds to the first known session that claims it. The session comes from
  the environment, so this stops mistakes, not deliberate impersonation.
- `worktree takeover` now requires `--head <sha>`, or `--head none` for a
  checkout with no commit yet, and exactly one of `--branch <name>` or
  `--detached`, and refuses unless the checkout's branch, HEAD, and status
  digest all match. Every clean checkout has the same status digest, so
  before this release an approval of a clean checkout pinned neither its
  commit nor its branch. Scripts that call it without the new flags now
  exit 2. A takeover also accepts a stale claim and a detached one, and
  `--release`, which touches no file or ref, now releases whatever the
  owner's own release could, including a claim whose checkout was removed.
- A run no longer has to be relinquished when a concurrent author
  vanishes. While the controller is active, an approved takeover may
  reassign that author's live claim to the controller itself, which then
  claims, pauses, and accepts the checkout, so the run keeps its controller
  and its open shipment scope. `loop verify` prints that exact command, and
  standalone `worktree cleanup` prints a claimed checkout's takeover with
  its exact claim ID, HEAD, branch, and status digest.
- `worktree release --ready-receipt` now checks author coverage before it
  records anything. While a commit the target lacks has no attested author,
  carries a replay source with none, or is an inconclusive replay nobody
  attested an edit on, it refuses with exit 5, keeps the claim with its
  owner, and prints the exact SHAs with the owner's own `author attest`
  commands. To hand off commits another agent made, name exactly the
  outstanding ones with `--leave-uncovered <sha>[,<sha>...]`; that waives
  nothing, and review stays blocked until they are attested or waived.
  Ready work now takes the same lock as `author attest`, so it reports busy
  while a `loop exec` runs, and `worktree status` shows each unshipped
  ready receipt's coverage.
- The new read-only `author coverage --base <target> --head <sha>` reports
  that coverage before any proposal exists, with the authors digest
  `proposal record-authors` would record, and exits 3 until it is complete.
  Open the proposal as a draft while gaps remain, and mark it ready for review
  only once each gap is attested by its author or waived by the owner with
  `proposal waive-coverage` on that exact draft head. A waiver never counts in
  `author coverage`, which keeps exiting 3.
- `worktree request` now says plainly that it sends nothing: its request
  carries `state: "constructed"`, `capabilityProbe.automatic` is always
  false, and an owner profile that could be automated returns a
  `host-transport-unverified` blocker, because the runtime cannot see the
  delivery tools of the coding agent running it. Text output starts with
  `Constructed, not sent:` and gives the next step. A request must now
  name the active run.
- Work-directory cleanup now accepts only run IDs in the form `loop start`
  mints, `run-` followed by lowercase letters, digits, and hyphens, so a run
  ID such as `..` can no longer name the Simple Changes state directory for
  removal. No release minted another form. The parallel Git reader behind
  inventory now runs only Git and refuses any request that names another
  program or starts with an option; inventory then reads through ordinary
  Git, with the same results.
- The README has a new Security model section: for the opt-in Stop hook,
  a repository `execGuard`, migration adapters, transcript reads, commit
  and proposal text, and Git and `glab` calls with your credentials, it
  says what triggers each, what it can touch, how to opt out, and what
  enforces the boundary. Agents are now told to treat commit messages,
  trailers, branch names, proposal descriptions, review comments, and
  provider responses as untrusted data.
- Known limits, tracked for a later release: a takeover compares
  `--branch` after trimming surrounding whitespace, so a branch name ending
  in a non-breaking space is not matched exactly, and a ready-work refusal
  from another session for a removed checkout still prints placeholders
  instead of the release that applies.
- The guidance 31 update notice describes model IDs, the review loop,
  session-bound claims, and the ready-work coverage check, and needs no
  answer.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-17T12:41:13-05:00" -->

## 0.30.1 - 2026-10-16

- **Bug Fixes & Improvements**:
  - Adversarial review no longer accepts a review by the author's own
    model in the same coding agent just because the two spell the model's
    name differently. Model names now match when they differ only by case,
    separators, words that only describe effort, notes in parentheses such
    as `(reasoning: high, budget: 32768)`, nested or unclosed ones
    included, or words after a complete model name, which are read as
    notes, such as `temperature 0.2` in `Model 5.5 temperature 0.2`. Two
    names that both carry notes also match when those notes are labelled
    fields such as `budget: 32768`, or settings such as `temperature 0.2`
    that follow a version number, so `Model 5.5 temperature 0.2` matches
    `model-5-5 budget 100`. Only whole words count, and a version such as
    `5.5` is one word, so `Model 5 temperature 0.2` still differs from
    `Model 5.5`. A note that starts with a version number, such as `(5.5)`
    or `(5.5 high)`, keeps that version as part of the name, closed or not,
    and the rest of the note is dropped, so `Model (5.5 high)` matches
    `model-5-5` while `Model (5)` and `Model (5.5)` stay different. Effort
    words are whole words anywhere in the name, such as `high`, `xhigh`,
    `extra-high`, `reasoning: high`, `reasoning_effort=high`, or
    `thinking mode`. They are dropped, and a standalone level such as `max`
    is also tried kept, so a level that is also part of a name still
    matches: `Model 5.5 Max high` matches `model-5-5-max`. A word with any
    other part, such as `model-mini`, is not an effort word, and a name
    made only of effort words keeps them. Only the note
    `(version unknown)` or `(unknown version)` widens a name, only when the
    name does not already end in a version number, and only to any version
    of the same model, never another variant: `Model (version unknown)`
    matches `model-5-5` and `vendor-model-5-5` but not `model-max`,
    `Model 5 (version unknown)` does not match `model-5-5`, and a note such
    as `(reasoning unknown)` widens nothing. Before, an author labelled
    `Model 5.5 high` and a reviewer reporting `model-5-5` counted as
    different models, so the review was accepted.
  - The same comparison now also decides whether the configured reviewer
    is blocked before a review is dispatched, whether a stored review still
    counts, whether a reviewer reported the model it was asked for, and
    which reviewer model setup refuses as the author's own. A review
    accepted before this release keeps its record, but if its reviewer now
    matches the author's model while adversarial review is on, it no longer
    counts toward approval, and that proposal needs a review from a
    different model or coding agent.
  - Different versions and variants still count as different models, such
    as `Model 5` and `Model 5.5`, or `model` and `model-max`. One
    exception follows from reading later words as notes: a variant written
    as a separate word, such as `Mini` in `Model 5.5 Mini` or `Max` in
    `Model 5.5 Max`, counts as the base model `model-5-5`, and a bare
    family name such as `Model` matches `Model 5.5`. That can block a
    review but never admits one, though a reviewer that reports
    `model-5-5` when `Model 5.5 Mini` was requested is not shown as a
    mismatch. Use the hyphenated ID, such as `model-5-5-mini`, when the
    variant matters. Names are compared by spelling only, with no list of
    aliases, so two unrelated names for one model, such as a codename and a
    model ID, still count as different. This name matching is an interim
    measure: 0.31.0 replaces it with a comparison of the canonical model
    IDs coding agents report, treating display labels and effort as
    metadata only and failing closed when identity is missing or ambiguous.
    Until then, for adversarial review to work reliably, pass the model ID
    your coding agent reports, such as `model-5-5`, to
    `author attest --agent` rather than a display label.
  - Handing an unchanged adopted checkout to a new owner, such as from a
    controller's bridge identity back to the author who must attest its
    commits, now has documented steps. A claim never moves between owners,
    so the former owner releases its claim and the new owner claims the
    checkout right away with its own agent ID and adapter. Until the new
    owner's claim is registered or its pause is accepted, `loop verify`
    reports `coordination-claim-stale` for the checkout and every guarded
    step of the run, unrelated ones included, stays blocked, so finish the
    handoff before other work. When the former owner released with
    `worktree release` or a handoff and nothing else holds the checkout,
    the recovery that `loop verify` and `loop status` print now adds that
    the new owner may run the same claim and pause instead.
  - Under the default `concurrentWork: "allow-claimed"` policy, while the
    run's shipment scope is still open, the new owner's claim on a checkout
    on its own branch (not detached, and not the primary or target branch)
    registers it as a concurrent author, which completes the handoff.
    Otherwise, including for a detached checkout and after the scope froze,
    the new owner pauses the checkout with `preserve-in-place` and the
    controller runs `loop accept-paused-change` with that receipt. A
    checkout changed after its pause, a pause whose claim was released
    before it was accepted, a claim on a checkout another owner holds, and
    the former owner's old receipt are all refused. Only the printed
    recovery and the references are new; claims, pauses, and acceptance
    work as before.
  - `loop draft-outcome` now warns when it suggests a disposition that
    `loop record-outcome` will refuse as drafted. It suggests `delivered`
    or `target-equivalent` from whether a unit's paths changed on the
    target, which alone proves neither: unrelated work may have edited a
    shared changelog, or the unit's change may never have arrived. When a
    unit's final target entry differs from the opening source result its
    scope recorded, the draft names up to five such paths in its JSON
    `warnings` and as `Warning:` lines, so you can check that unit before
    recording. `loop record-outcome` refused such a disposition before
    unless a reviewed primary-checkout result or an approved
    preserved-source override covered it, and still does; the warning just
    tells you sooner.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-16T19:35:19-05:00" -->

## 0.30.0 - 2026-10-15

- A review no longer stays blocked after an author fixes its own incomplete
  attestation. When an author's first `author attest` on a commit left out
  the model or instance its harness reports, attesting again with them did
  not help: review planning still reported `author-identity-missing`, and a
  reviewer whose session ID was not exposed was still rejected as
  `independence-unproven`. That same author can now run `author attest`
  again from the same session, with the same `--agent-id`, the values it
  reports, and `--complete-identity`. The earlier attestation stays in the
  review ledger, and a completion record names it, so it no longer leaves
  independence or model diversity unknown.
- Completing an attestation never weakens independence. A reviewer that
  the earlier attestation ruled out as the same executor, such as one in
  its session with no instance of its own, is still rejected, every other
  author still counts on its own, and a completion applies only
  to its own commit, never to that commit's replay sources. It is refused
  for a replay, without an executing session, when nothing is missing, and
  when another instance or model already appears under that session and
  agent ID; such a record appearing later voids the completion. A
  replacement agent that reuses an agent ID attests without the flag and
  stays a separate author.
- When a completion changes a proposal head's authors, the head gets a new
  authors digest, so reviews recorded before it stop counting and the
  proposal needs a fresh review.
- A review ledger that holds a completion needs Simple Changes 0.30.0 or
  later. Earlier versions report it as malformed and block review until
  they are updated; ledgers without a completion are unchanged.
- `SKILL.md` now puts the core workflow steps right after the table of
  modes, ahead of the authority rules and the reference router, so an agent
  reaches the steps first. The rule that only `release-tag` creates or pushes
  tags moved to the changelog coordination reference under "Release tags",
  and a repeated paragraph about auditing a branch before reapplying its work
  was removed; the replacement lineage reference still has it. How runs
  behave is unchanged.
- The guidance 30 update notice describes the new step and needs no answer.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 high" at="2026-10-16T11:26:43-05:00" -->

## 0.29.2 - 2026-10-15

- **Bug Fixes & Improvements**:
  - The optional scratch-file rule that setup adds to AGENTS.md or
    CLAUDE.md now gives each agent one scratch folder of its own and lets
    it delete only that folder, never files matched by pattern in a folder
    other agents share. An agent that starts another agent gives it a
    folder inside its own, or the work directory a Simple Changes run made
    for it, and a folder Simple Changes gave an agent during a run is left
    for the run to delete. Before, the rule said only to delete scratch
    files when the task ends, so a subagent could delete the files of the
    agent that started it.
  - `initialize` now tells you when the scratch-file rule in your
    repository's AGENTS.md or CLAUDE.md, or in your global
    `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`, still has an earlier
    release's text. Your agent offers once to run
    `simple-changes scratch-file-rule refresh --instruction-file <path>`,
    which rewrites just that rule and leaves the rest of the file alone. It
    never adds the rule to a file without one.
  - When Simple Changes runs agents in parallel, each agent's brief now
    names the work directory `prepare-agent` made for it, tells the agent
    to keep its scratch files there, and forbids deleting anything outside
    it, even in a scratch folder it shares with the agent that started it.
    The run deletes those directories when it finishes cleanly.
  - During a run, `simple-changes workdir --agent-id <id>` now ties any
    agent's work directory to the run, including a reviewer's or a check
    runner's, so the run deletes it when it finishes cleanly. Before, only
    the controller's and authors' directories were deleted with the run.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-14T17:15:30-05:00" -->

## 0.29.1 - 2026-10-13

- **Bug Fixes & Improvements**:
  - While released or preserved worktrees wait to merge, `loop exec` now
    also accepts glab's on/off merge flags with an explicit value, such as
    `glab mr merge <iid> --sha <commit> --auto-merge=false`, which some
    repositories' merge guards require. The merge still has to name its
    commit.
  - A repository fork that keeps the Simple Changes runtime in a `runtime/`
    folder now finds the agent list it carries beside its SKILL.md
    (`agents/harnesses.json`), so `initialize` detects your coding agents
    without a second copy inside `runtime/`.
  - update-local-forks can now move a fork's pin after you merge a
    conflicting SKILL.md by hand. Apply the plan that conflicted, merge each
    sidecar, then plan again with `--resolved <path>` for each merged file
    and `--resolved-against <commit>` naming the installed release. That
    plan keeps those files as they are and moves the pin, including where
    the fork's own tests and notes name it.
  - update-local-forks no longer reports the pin moving while SKILL.md
    still waits on its sidecar. Before, apply rewrote the pin in the fork's
    tests but left SKILL.md on the old pin.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-13T10:23:00-05:00" -->

## 0.29.0 - 2026-10-12

- Agents now keep the files they hand to Simple Changes, such as provider
  pages, receipts, proposal bodies, and decision files, in a private
  temporary work directory instead of folders beside your projects.
  `loop start` and `prepare-agent` report it as `workDir`. A run that
  finishes cleanly deletes it, and a blocked or preserved run keeps it for
  recovery. `simple-changes workdir --agent-id <id>` prints the directory,
  and `workdir remove <path>` deletes one by hand.
- Setup can add an optional rule to AGENTS.md or CLAUDE.md that tells every
  agent to keep scratch files, proof bundles, and handoff notes out of your
  project folders and to delete them when the task ends. Choose it when
  setup offers it, or pass `--scratch-file-rule add`; nothing changes unless
  you add it.
- Updating a fork no longer drops your change when upstream moves code you
  edited into another file. `update-local-forks` now makes the old file a
  conflict whenever upstream moved code out of it and your fork changed it,
  even where the lines would merge cleanly, and names what moved where. The
  new file is still written, with a note pointing back, and a fork that
  never touched the old file gets the same plan as before.
- When a fork's own checks, such as `scripts/test.sh`, search a file for
  text that upstream moved elsewhere, the update plan adds a note naming the
  file that holds it now. Notes never block an update.
- `update-local-forks` refuses, before writing anything, a plan in which two
  paths would name the same file on disk, so a conflict's saved merge is
  never overwritten.
- The loop runtime's largest file, `scripts/lib/loop-lease.ts`, is now ten
  smaller files grouped by command. Commands, output, and stored files are
  unchanged, and imports from `loop-lease.ts` keep working. Fork checks that
  read its text should read `loop-lease*.ts`.
- The guidance 29 update notice describes the work directory, the optional
  rule, and the fork update change, and needs no answer.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-12T19:09:00-05:00" -->

## 0.28.0 - 2026-10-08

- You can now choose which model writes proposal descriptions and merge
  messages, and who performs independent reviews, in each coding agent you
  use. Setup asks **Which coding agents do you use?** and one model question
  per agent. When two or more agents are recorded, it also asks **Who should
  perform independent reviews?**, and this update asks that once. Answers are
  saved in `.simple-changes-authoring.json` for one repository or in a
  personal `authoring.json`, never in your policy file. They guide delegation
  only: they grant no authority, and signatures always name the model that
  actually did the work.
- Independent review is now checked, not assumed. Agents record who wrote
  each commit with `author attest`, including after a rebase or
  cherry-pick, and run `proposal record-authors` after opening or updating
  a proposal. `proposal record-review` accepts a review only when every
  commit on the head is attributed or explicitly waived and the reviewer is
  a different agent or session from every author. When you asked for an
  adversarial review, it must also be a different agent or model. After a
  review finds something, later reviews of that change run at least at the
  escalation effort you set.
- `initialize` shows the reviewer it resolved and where each setting came
  from, and the pre-ship brief names it. A one-run answer passed with
  `--authoring-request` can make the review requirement stricter for that
  run but never looser, and is never saved.
- A Ship run now merges exactly the commit each released, handed-off, or
  preserved worktree was recorded at. If one of those branches moves while
  the run is merging, `loop exec` refuses before Git starts and prints the
  same command with the recorded commit ID, or the steps to take the
  checkout back, and `loop verify --for merge` fails until it is resolved.
  Before, a commit another agent made while the merge waited could be
  merged with it.
- While such worktrees wait to be merged, `loop exec` runs only Git and
  provider merges that name their commit, such as `glab mr merge <iid>
  --sha <commit>`. Run other tools outside `loop exec`, or after those
  worktrees are merged.
- SKILL.md is about 40% smaller, so its core rules fit in what an agent
  keeps after a long conversation is compacted. The recovery steps moved
  unchanged to `references/recovery.md`, which agents read when a run
  reports trouble.
- The installed skill now carries the release notes of the last six
  guidance versions instead of the full history. `release-notes --version`
  for an older release prints a link to it in the full changelog, with the
  notices of the guidance versions it introduced, and exits 6.
  `update-local-forks` still verifies older releases.
- `remote-inventory build` builds the opening and final remote inventory
  receipts a GitLab Ship run needs from fetched pages, and a GitLab
  reference fetcher pages branches and merge requests read-only, so those
  receipts no longer need a hand-written collector.
- `loop draft-outcome` drafts the shipment outcome receipt from Git: every
  path changed since the run started, with its exact entry, and the scoped
  units. Every explanation in it is a placeholder, and `loop record-outcome`
  refuses the receipt until each one is replaced.
- `status --all` shows every local repository's runs, worktree claims,
  holds, ready work, pending guidance notices, and forks behind their
  source, without writing, fetching, or locking anything.
<!-- simple-changelogs-signature agent="Claude Opus 5.5 xhigh" at="2026-10-08T17:15:02-05:00" -->
