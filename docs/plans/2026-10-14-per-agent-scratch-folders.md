# Per-agent scratch folders

**Date:** 2026-10-14

**Status:** Implemented on `feat/per-agent-scratch-folders` (rule text,
stale-block report and refresh, run-bound helper directories, skill text,
tests, changelog) for a silent `0.29.2` with guidance staying at 29. The
global rule change below is a diff awaiting the user's approval; fork updates
follow the release.

**Scope:** The managed scratch-file rule, agent work directories, parallel-agent
briefs, and how the user's global instructions and repository forks pick the
change up

**Upstream baseline inspected:** `origin/main` at `f26ee3d` (0.29.1)

**Origin:** The Site Secure "Enterprise custom roles system" session, after a
subagent deleted shared scratch files. Written by Claude Fable 5.1.

## Outcome

Every agent writes its scratch files into one folder it owns and deletes only
that folder. A parent hands each child a folder. Nothing is ever deleted by
pattern in a directory several agents share. The model needs no new tool: the
work directories Simple Changes already reports, plus `mktemp -d` everywhere
else, are the mechanism; the rule and the briefs are what change.

## Incident

Twice in the Site Secure repository (`/Users/jaay/Developer/secure`):

- **2026-10-13.** A parent Claude Code session launched three background
  subagents with the Agent tool. They inherit the parent's scratchpad
  directory, `/private/tmp/claude-501/<project>/<session-id>/scratchpad/`.
  One subagent followed the global rule "Delete them when the task ends" by
  removing every `*.py`, `*.json`, `*.md`, `*.txt`, and `*.err` file in that
  shared directory. That deleted the parent's merge-request description draft
  (`ratchet-mr.md`) and other working files. A folder named `p12b` that
  belonged to someone else survived only because it was a directory.
- **2026-10-12**, ship run `run-mv5xr0mj-ce5daede`. A subagent "cleaned up"
  with `rm -rf <scratchpad>/*` and wiped the run's MR descriptions, merge
  brief, review logs, and opening remote inventory. The inventory was
  recovered from `.git/simple-changes/active-loop.json` and the descriptions
  from `glab api`. The parent's memory records it as "subagents can wipe the
  shared scratchpad".

## Root cause

The scratch rule in the user's global instructions, `~/.codex/AGENTS.md`
lines 39 to 41, which Claude also loads through the `@/Users/jaay/.codex/AGENTS.md`
line of `~/.claude/CLAUDE.md`. It is the managed block that
`simple-changes setup --scratch-file-rule add` writes, so its text lives in
this repository as `SCRATCH_FILE_RULE` in
`skills/simple-changes/scripts/lib/repository-instructions.ts`:

> Write scratch files, captured command output, proof bundles, and handoff
> notes to the session's scratch directory or a private folder under the
> system temporary directory, never inside or next to a repository checkout.
> During a Simple Changes run, use the work directory it reports. Delete them
> when the task ends unless the user asks to keep them.

Three gaps:

1. **No ownership.** "The session's scratch directory" is one directory
   shared by a parent and every subagent it starts: Claude Code hands a
   subagent the parent's scratchpad path verbatim. A Codex subagent in a new
   thread has no session scratchpad and falls back to "a private folder under
   the system temporary directory" with no naming rule, so nothing stops two
   agents from choosing the same one.
2. **Files, not a folder.** "Delete them" names files. An agent that cannot
   tell its own files from everyone else's deletes by pattern, and a pattern
   over a shared directory matches other agents' files.
3. **Briefs passed no folder.** Simple Changes 0.29.0 already gives every
   controller and author a private `workDir` and removes exactly the run's
   bound directories at a clean finalization. But the parallel-agent brief in
   `references/inventory-and-concurrency.md` listed the prepared path,
   branch, agent ID, scope, checks, boundary, and `author attest`, not the
   work directory, and `SKILL.md` said only to keep files passed to the CLI
   there. A delegated agent therefore kept its scratch in the harness
   scratchpad it shares with the controller, where the global rule told it to
   delete.

## Design

Ownership is a directory, created by its owner or handed to it. Cleanup is
the removal of exactly that recorded path, never a selection of files.

### Folder name

- **In a Simple Changes run:** the `workDir` the CLI reported. `loop start`
  binds the controller's, `prepare-agent` binds one per author, and
  `simple-changes workdir --agent-id "$AGENT_ID"` prints it. It is already
  unique and private:
  `<tmpdir>/simple-changes-<uid>/<repo-slug>-<sha12>/<agent-slug>-<sha8>.XXXXXX`,
  mode `0700`, made with `mkdtemp`.
- **Anywhere else:** the folder the agent's brief names; otherwise a new
  folder the agent creates with `mktemp -d` under the session's scratch
  directory when the harness gives one, else the system temporary directory.
  Give it a prefix a person can read, naming the task:
  `mktemp -d "$ROOT/<task-slug>.XXXXXX"`.
- **When the agent does not know its id:** nothing changes. Uniqueness comes
  from `mktemp -d`, not from knowing a session or agent id, so a subagent
  that cannot see its own id still gets a folder no one else has. Record the
  path once and use it for the whole task.
- A folder named only for the session, the project, or the run is never an
  agent's own: several agents share those.

### Parent and child

- A parent creates a folder for each child inside its own folder
  (`"$MY_SCRATCH/<child-name>"`) and names the path in the brief: "Your
  scratch folder is `<path>`. Write only there. When you finish, delete only
  that folder, and nothing else under `<parent>`." Because the child's folder
  is below the parent's, the child's cleanup can never reach the parent's
  files, and the parent's cleanup sweeps whatever a crashed child left.
- In a Simple Changes run the controller instead names the author's `workDir`
  from `prepare-agent`. That directory is a sibling bound to the run, not a
  child of the controller's, so the brief also says to leave it in place: the
  run's clean finalization removes it.

### Cleanup

- Delete exactly your own folder by its recorded path, after every agent you
  started has returned, unless the user asked to keep it.
- Never `rm <dir>/*.<ext>`, `find <dir> -delete`, or any sweep by pattern,
  extension, or age over a shared directory; never a folder you did not
  create or receive. An agent with no folder of its own deletes nothing.
- The CLI already enforces this for work directories: `workdir remove <path>`
  refuses a path that is not one of this repository's work directories and
  one a live run holds; `loop finalize` and `loop end` remove exactly the
  run's bound directories; the next `loop start` sweeps the directories of
  runs that ended without a clean close.

### Shared hand-off files

- A file another agent will read after you finish goes where your brief
  says: normally a path inside the parent's folder or the run's work
  directory, which the parent or the run deletes later.
- Without such a place, leave your folder in place and report the path. The
  parent removes it with its own folder, or `workdir remove` does.
- The parent's own drafts (MR descriptions, merge briefs, review logs) live
  in the parent's folder, the controller's `workDir` in a run, which no child
  may touch.
- Notes meant for a later session (parked work, handoffs) are not scratch.
  Write them where the next reader looks: the worklog, the proposal body, or
  the parking note.

### Crashes

- A child that crashes leaves its folder. It is inside the parent's, so the
  parent's end-of-task deletion removes it.
- A parent that crashes leaves its tree for the operating system's
  temporary-file cleanup, or for `workdir remove` when it is a work
  directory. Nobody deletes on a crashed agent's behalf by guessing which
  files were its own.
- A Simple Changes run that ends without a clean close keeps its directories
  for the resume; the next `loop start` removes the directories of every run
  other than the active one.

### Retention

- An agent keeps its folder until its final reply for the task, or longer
  when the user asks.
- A controller keeps its work directory until `loop finalize` completes
  cleanly; a paused or relinquished run keeps every bound directory.
- An author never deletes its `workDir`; the run does.

### Codex and Claude

- **Claude Code** gives a session one scratchpad directory and gives every
  Agent-tool subagent the same path. Subagents therefore make a `mktemp -d`
  folder under it, or use the folder the parent named.
- **Codex** has no session scratchpad. `codex exec` runs and new-thread
  subagents use the folder named in their prompt, else `mktemp -d` under the
  system temporary directory.
- In both, a Simple Changes `workDir` wins whenever one was reported.
- The rule names no path format, so it needs no harness detection.

### Why no new tool

`workdir --agent-id`, the `workDir` that `prepare-agent` reports, `workdir
remove`, and finalize already exist; outside a run, `mktemp -d` is the helper.
Two small additions came out of the decisions below: `workdir --agent-id`
inside a run now binds any agent's directory to the run, and
`scratch-file-rule refresh` rewrites a stale block that `initialize` reports.

## The global rule

The exact replacement, as a ready-to-apply diff against the user's file. It is
byte-identical to what the new `setup --scratch-file-rule add` writes, so a
later setup run finds the same text and reports no change. **Not applied by
this work; it waits on the user's approval.**

```diff
--- a/Users/jaay/.codex/AGENTS.md
+++ b/Users/jaay/.codex/AGENTS.md
@@ -37,5 +37,5 @@
 Use exact version/effort only if exposed. Date only; no time, timezone, duplicate footers, or invented values.
 
 <!-- simple-changes:scratch-files:start -->
-Write scratch files, captured command output, proof bundles, and handoff notes to the session's scratch directory or a private folder under the system temporary directory, never inside or next to a repository checkout. During a Simple Changes run, use the work directory it reports. Delete them when the task ends unless the user asks to keep them.
+Write scratch files, captured command output, proof bundles, and handoff notes only in one scratch folder of your own, never inside or next to a repository checkout: the folder your brief names, the work directory a Simple Changes run reports, or a new folder you create with `mktemp -d` under the session's scratch directory or the system temporary directory. When you start another agent, give it a folder inside yours and name the path in its brief. When the task ends, delete exactly your own folder by its path, unless the user asks to keep it; never delete by pattern, extension, or age in a directory other agents share.
 <!-- simple-changes:scratch-files:end -->
```

The diff was generated against the user's current file and replaces only the
managed block. `~/.claude/CLAUDE.md` needs no change: it includes the file.

Three ways to apply it:

1. **Paste the diff.** The markers are unchanged, so Simple Changes keeps
   managing the block.
2. **Run the refresh** once a release carrying this change is installed.
   `initialize` reports the global block as `stale` with a `refreshCommand`;
   with the user's agreement,
   `simple-changes scratch-file-rule refresh --instruction-file /Users/jaay/.codex/AGENTS.md`
   rewrites exactly that block.
3. **Run setup** once a release carrying this change is installed. The
   non-interactive form needs every answer the personal scope requires, and
   no personal `preferences.json` exists today (only `authoring.json`), so
   it would also create one from these answers:

   ```sh
   simple-changes setup --scope user \
     --finish review --questions blocking-only --git-push-authorization ask \
     --instruction-file /Users/jaay/.codex/AGENTS.md \
     --instruction-pointer leave --scratch-file-rule add --yes
   ```

   Interactive `simple-changes setup --scope user` asks the scratch-file
   question with **Add the rule** first and rewrites the block in place.

Until the global rule changes, the mitigation stays the one the parent's
memory already records: every subagent brief names the subagent's own
scratch folder and says to delete nothing else.

## Exact Simple Changes changes

All on `feat/per-agent-scratch-folders` in the canonical repository.

| File | Change |
| --- | --- |
| `skills/simple-changes/scripts/lib/repository-instructions.ts` | `SCRATCH_FILE_RULE` is the text in the diff above (627 bytes, up from 348). Markers unchanged, so `writeScratchFileRule` replaces an older block in place. New `inspectScratchFileRule` (`current`, `stale`, `absent`, `invalid`), `discoverGlobalInstructionTargets` (the global Codex and Claude files under the harness roots), and `locateInstructionTarget` for an explicit path. |
| `skills/simple-changes/scripts/lib/initialization.ts`, `evals/schemas/initialization.schema.json` | Optional `scratchFileRule.targets[]` (`path`, `scope`, `status`, `refreshCommand` for a stale block). |
| `skills/simple-changes/scripts/simple-changes.ts` | `initialize` fills `scratchFileRule` and names stale and invalid blocks in text output; new `scratch-file-rule refresh --instruction-file PATH` rewrites one stale block under the loop state lock and refuses an absent (exit 2) or invalid (exit 5) one; `workDirectoryFor` binds a directory to the live run for any agent without a same-session binding. |
| `skills/simple-changes/scripts/lib/work-directory.ts` | `bindRunWorkDirectory` documents that any agent the run's `workdir` serves is bound, so a clean close removes it. |
| `skills/simple-changes/scripts/lib/onboarding.ts` | The question and the **Add the rule** description say "one scratch folder of its own" and "deletes only that folder". |
| `skills/simple-changes/SKILL.md` | "Keep every file you pass to the CLI, and your scratch files, in your own `simple-changes workdir --agent-id "$AGENT_ID"` directory; delete nothing outside it." To stay inside the 17,500-byte budget (the file was 7 bytes under it), "use the same invocation everywhere" is dropped and the parallel-agents opening clause is shortened. |
| `skills/simple-changes/references/inventory-and-concurrency.md` | "Agent work directories" gains the ownership paragraph: the directory and everything in it is the agent's alone, a harness scratch directory is shared, only the run or the owner removes a work directory, never delete by pattern, extension, or age in the work root or a harness scratch directory, and a file another agent reads stays until finalization. "Parallel agents" step 2 adds the `workDir` to what every brief gives, and a second required brief clause: scratch files go only in that `workDir`, delete nothing outside it, including in a harness scratch directory shared with the controller, and leave it in place. Step 3 leaves the work directory in place. |
| `skills/simple-changes/references/setup-and-policy.md` | Describes the new rule, `scratchFileRule`, and the refresh command, which never adds the rule to a file without one. |
| `skills/simple-changes/references/onboarding.md` | The rule "gives every agent one scratch folder of its own outside project folders, and lets it delete only that folder". |
| `README.md` | The `--scratch-file-rule add` paragraph. |
| `tooling/simple-changes/tests/repository-instructions.test.ts` | Pins the ownership phrases of the rule, rejects "Delete them when the task ends", and covers `inspectScratchFileRule` and `discoverGlobalInstructionTargets`. |
| `tooling/simple-changes/tests/cli.test.ts` | `initialize` against a fixture home with a stale global block, the refresh, and the refusal for a file without the rule. |
| `tooling/simple-changes/tests/work-directory.test.ts` | A reviewer's directory binds to the run and finalize removes it. |
| `tooling/simple-changes/tests/skill-contract.test.ts` | Pins the SKILL.md sentence and the brief requirements. |
| `CHANGELOG.md`, `DEVELOPER_CHANGELOG.md`, `skills/simple-changes/CHANGELOG.md` | `Unreleased` entries in the public and developer histories. The packaged copy is regenerated with `bun tooling/simple-changes/package-changelog.ts`, because the release-history test requires it to be the exact generated window of the root file, `Unreleased` included; the `release-notes` command omits that section when it renders. |

Release impact: `release:package`, `release:customer-visible`. Guidance stays
at 29 and the release is a silent `0.29.2`: the stale-block report replaces an
update notice. The release owner does the version bump and release prep.

## How forks pick it up

Forks update through the `update-local-forks` skill after the release, not by
hand:

1. Release and tag `0.29.2`, update the global install, then run
   `update-local-forks discover` and, per fork,
   `plan --fork <dir> --upstream /Users/jaay/Developer/simple-changes --json`,
   explain the plan, and `apply` it.
2. What each fork should expect. `scripts/lib/repository-instructions.ts`,
   `onboarding.ts`, `initialization.ts`, and `work-directory.ts` update (mapped under `runtime/`
   for a runtime-directory layout, three-way merged where the fork edited
   them), so the fork's own `setup --scratch-file-rule add` writes the new
   text. `references/inventory-and-concurrency.md`, `setup-and-policy.md`,
   and `onboarding.md` update or merge. `SKILL.md` almost always conflicts
   because forks rewrite it: read the `.upstream-merge` sidecar, port the one
   sentence into the fork's prose, delete the sidecar, then plan again with
   `--resolved SKILL.md --resolved-against <0.29.2 commit>` so the pin moves.
   A version-literals review item names fork lines that still say 0.29.1.
3. Fork-specific text. A fork that briefs subagents in its own words, such as
   Site Secure's `thor-simple-changes`, ports two things: the ownership
   paragraph under "Agent work directories" and the "Also required in every
   brief" clause, keeping its stricter local rules. A repository
   `AGENTS.md` or `CLAUDE.md` that holds an older managed block is refreshed
   by the fork's `scratch-file-rule refresh` once `initialize` reports it
   stale, by that fork's setup with `--scratch-file-rule add`, or by the same
   diff.
4. Run the fork's own checks and its runtime's `simple-changes skill check`,
   append the range to the fork's `references/fork-maintenance.md`, and hand
   the change to that repository's Simple Changes policy. The updater never
   commits or pushes.

## Verification

The branch must pass `bun run check` (typecheck, lint, test, eval) and the
Simple Changelogs structure lint
(`simple-changelogs-skill-maintainer/scripts/query.ts check`). The results of
the run on this branch travel with the hand-off to the release owner.

## Decisions

The user answered the six open questions on 2026-10-14:

1. **Detect a stale block: yes.** `initialize` reports each repository and
   global instruction file's block as `current`, `stale`, `absent`, or
   `invalid`, and offers a stale one's `refreshCommand` once.
2. **Silent `0.29.2`, not guidance 30.** The stale-block report reaches users
   who added the old block, so no update notice is needed.
3. **Length: shortened.** The rule is 627 bytes, down from a 960-byte first
   draft (348 before). It keeps the four guarantees: one folder of your own,
   a folder inside yours for each child, deletion of exactly your own folder,
   and no deletion by pattern, extension, or age in a shared directory. The
   sentences on shared parents, hand-off files, and folders you did not
   create moved to `references/inventory-and-concurrency.md`, since the
   guarantees already imply them.
4. **Helper agents: bound to the run.** `workdir --agent-id` inside a run
   binds any agent's directory, so a clean finalize removes reviewers' and
   check runners' directories with the rest.
5. **No stricter subagent rule.** Banning the shared scratchpad would push an
   unbriefed subagent into the system temporary directory, which can need
   permission and is not cleaned with the session. The one-folder rule
   already prevents the incident.
6. **Site Secure carries the block too.** Its repository `AGENTS.md` gets the
   same managed block, so agents that do not load the global file see it.
