# Changelog

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
