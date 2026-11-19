# Changelog

## 0.33.2 - 2026-11-19

- **Bug Fixes & Improvements**:
  - In Ultra-Simple Mode, agents no longer treat "ask before uploads" as a
    prompt your computer will show. The person answers, in the
    conversation. A request such as "put this up" counts as the answer for
    one upload, your change's own copy sent for review. Any other upload
    gets one plain question first, and nothing is uploaded straight onto
    the main version without a yes that names it.
  - When a project has nowhere to open a review link, an agent in the mode
    now stops after saving and sending your change as its own copy. It does
    not add the change to the project, with or without Autopilot, until a
    review link exists or the owner says to add it without one.
  - Guidance stays 33, so no repository is asked anything by this update.
<!-- simple-changelogs-signature agent="Claude Fable 5.2 xhigh" at="2026-11-19T10:32:00-06:00" -->

## 0.33.1 - 2026-11-18

- **Bug Fixes & Improvements**:
  - New: Ultra-Simple Mode, for people who want the result and not the
    tooling. In it, your agent uses no Git or tool terms unless you use
    them first, keeps updates short, and asks only when your answer changes
    what happens. It opens every finished delivery with one of three
    labels, so "done" always means the same thing: ready for review, added
    to the project, or live. A run that finished only part of the request
    says exactly what did and did not happen. Say "details" at any time for
    the exact branches, revisions, and commands.
  - Turn the mode on for a project with `simple-changes setup
    --communication ultra-simple --scope repository --confirm`, then commit
    the new `.simple-changes-communication.json` to make it the project's
    default. Teammates then get the mode with no setup of their own, unless
    their own setting says otherwise. `--scope personal` saves it for you
    in every project, and `--communication standard` turns it off. Your own
    setting outranks the project's, so you can set a project to
    Ultra-Simple for a team and keep full detail yourself.
  - The mode never changes what Simple Changes may do. That command writes
    only that one file and refuses any other setup option in the same call,
    so it cannot change your policy or its trust receipt. Setup, checks,
    and review run as before, and going live, database changes, removing
    work, and every other required stop still ask, in plain words.
  - In the mode, when a checked, low-risk database update needs your
    approval, the question names the exact provider, project, and
    environment and offers to save the existing routine automatic setting
    for that one target. Later updates of that kind there then run without
    asking and are reported each time. The wider automatic tier is never
    offered there, and "ship it" is never database permission.
  - `initialize` reports `communication`: the style in effect, where it
    came from, and the file that set it. When Simple Changes has no
    setting, it follows the project's Simple Changelogs setting
    (`.simple-changelogs-communication.json`). Copies of Simple Changes
    before 0.33.1 ignore the new file and keep the standard voice.
  - **Autopilot** is now the plain name for two settings you already had:
    the **Ship when approved** finish with **Deploy automatically**. With
    both saved, a request to ship goes live without a question about going
    live, while a request that asks for less still stops where it says.
    What happens before going live still follows your saved shipping
    order: checks and review come first under the standard and expedited
    orders. It is a permission, separate from Ultra-Simple Mode and never
    turned on by it, and each person confirms it on their own computer
    before it takes effect there. Database changes keep their own setting.
  - Agents following the skill now say less. A message is sent only when it
    would change what you do or think, and it skips the request restated,
    plans the agent can simply carry out, steps that worked, repeated
    cautions, and closing offers.
  - Agents ask less: nothing your request, saved policy, or repository
    already answers, no "should I continue?", and nothing twice while
    nothing has changed. A saved **At major steps** or **Don't interrupt
    me** setting still decides how often you are asked.
  - One waiting decision no longer holds up the rest. When one change needs
    your answer, the agent asks right away, keeps going with everything
    that does not depend on it, and ends its turn on the question only when
    nothing else can proceed. How a run closes and how a unit is held out
    of a shipment are unchanged.
  - Messages from one agent to another (an author, a reviewer, a decider)
    are written as briefs: the goal, the exact scope, what is decided, what
    not to touch, and what to return. A reviewer gets the code and the
    rules, never the conclusion.
  - A result now gives the preview link when your host built a preview for
    that exact change, and shows a before and after picture of a visible
    change when the agent has a browser tool. Simple Changes reports a
    preview that exists; it does not create one.
  - Branches an agent names itself follow one default,
    `<kind>/<short-outcome>` such as `fix/contact-form-email`, unless your
    repository has its own convention.
  - Releasing a shipment hold now records the withdrawal correctly under
    Git 2.53 and later, which word a lost delete race differently. Before,
    a hold whose ref was already gone was reported as a failed withdrawal.
    A rejected delete now counts as withdrawn only when Git itself says the
    ref was already gone and `git ls-remote --exit-code` then proves it,
    and only for a remote with one destination for fetch and push. Anything
    else stays pending, a delete your host declined included, and the next
    `hold release` retries it.
  - The final remote inventory no longer proposes deleting a host branch
    that live local work still tracks. It read a local branch's upstream
    from the last `branch.<name>.merge` value, while Git uses the first.
    Now it holds the upstream Git uses and every merge value the branch
    lists, takes live branches from the worktree listing, the branch
    listing, and unreleased claims together, and holds every merged branch
    when those disagree or an upstream cannot be read.
  - Removing a reworked checkout now keeps it whenever its own refs cannot
    be confirmed, and refuses a filter driver whose name is empty, is not
    valid UTF-8, or holds a line break or `=`, since it could not switch
    that driver off exactly.
  - Guidance stays 33, so no repository is asked anything by this update,
    and the release is 0.33.1.
<!-- simple-changelogs-signature agent="Claude Fable 5.2 xhigh" at="2026-11-18T23:06:00-06:00" -->

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
- Finishing a run no longer overwrites local edits to files Git hides
  from `git status`. Before 0.33.0, when `loop finalize` or
  `loop close-equivalent` brought the primary checkout up to the target,
  its check for special entries in Git's index never matched what Git
  printed, so every entry looked ordinary. A file marked skip-worktree or
  assume-unchanged, whose edits Git does not report, could then look as
  if it already held the target's bytes and have your local edits
  replaced. Intent-to-add and conflicted entries were not recognized
  either. Now finishing reads those markings and leaves any such file
  exactly as it is, and when Git's answer about a file is lost or cut
  short, it leaves that file as it is too.
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
