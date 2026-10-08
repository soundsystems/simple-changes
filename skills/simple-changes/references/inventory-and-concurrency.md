# Inventory and concurrency

Contents:

- Integration-controller lease and concurrent authors
- New agents during an active loop
- Parallel agents
- Ready work blocked by another shipping controller
- Ready-work receipts
- Shipment holds
- Owner claims and safe pauses
- Exact overrides
- Opening-worktree dispositions
- Exact retained exclusions

Capture the opening inventory before mutation:

- canonical primary and current checkout;
- common Git directory and target ref;
- local and remote branches with revision IDs;
- all worktrees, including dirty state and branch/detached identity;
- existing stashes without applying or modifying them;
- staged, unstaged, untracked, renamed, deleted, conflicted, and symlink paths;
- open proposals and provider capabilities when available;
- policy sources and a stable baseline digest.

Before interpreting unique commits on an old branch as new work, run
`branch audit --head <source-ref> --target <ref> --json` from the primary
checkout. Resolve any replacement candidates before creating an author
worktree or reapplying the branch. See [replacement lineage](replacement-lineage.md).

Before assigning several independent authors, apply `proposalScheduling`:

- `balanced`: prefer consecutive work, but parallelize when it saves meaningful
  time or isolation is necessary; ask only when the tradeoff is substantial;
- `consecutive`: schedule one PR or MR at a time unless isolation is necessary;
- `parallel`: use distinct claimed worktrees for independent PRs or MRs, but
  confirm unusually expensive fan-out.

Once parallel authoring is selected, every author still requires a distinct
claimed worktree. To hand independent units to separate agents, follow
[parallel agents](#parallel-agents). After verified integration, ordinary
finalization removes proven-safe completed worktrees, including their local
dependencies and build artifacts. Never delete dependencies from an active,
retained, or uncertain worktree merely to reclaim space.

Do not substitute a standalone clone for a claimed worktree. Its separate
common Git directory cannot see this repository's controller and claims, so it
can advance the same remote target while leaving stale local bookkeeping. Close
or safely resume the existing controller before another shipment moves that
target.

Resolve the canonical primary checkout from `git worktree list --porcelain`, not
from the current directory. Record the primary path and return to that exact
checkout after mutations.

Take another snapshot before packaging. Compare evidence:

- A worktree first seen after the opening baseline is a concurrent arrival.
- A pre-existing worktree whose head or change digest differs is actively
  changing.
- Work unchanged across snapshots is stable by default, even when its branch
  name contains `wip`.
- Objects created by this run are attributed by the run ledger and are not
  concurrent arrivals.

Preserve concurrent or active work. Continue independent stable units. If an
ambiguous item truly blocks one unit, defer the question until safe independent
work is complete.

Treat a pause in the current request as authoritative. On resume, re-read the
newest request and fresh repository evidence instead of carrying an old pause
forward forever or silently reviving it. Resume preserved work only when the
user clearly releases the pause or current evidence and policy resolve the
named condition.

The read-only preview takes repeated snapshots without writing
`.git/simple-changes/`. Mutation modes may keep resumable state there, but must
reconstruct truth from fresh Git/provider evidence on every resume.

## Integration-controller lease and concurrent authors

Queue, Sweep, Integrate, Ship, Reconcile, and Resume use one active
integration-controller lease stored
as `simple-changes/active-loop.json` beneath the repository's common Git
directory. `loop start` creates it atomically and records:

- the run and controller identities;
- the opening inventory digest, canonical target ref, and exact target revision,
  plus a digest of the policy, capabilities, remote bindings, and target
  binding that a first shipment scope depends on;
- every worktree's exact path, branch, head, and content-sensitive change
  digest, including staged and unstaged patches plus untracked contents;
- whether the worktree is controller-owned, run-author-owned,
  concurrent-author-owned, or preserved; and
- exact user-approved overrides and audited removal dispositions, when any
  exist.

The lock directory prevents two integration operations from updating shared
manifest, target, proposal, merge, deployment, or cleanup state at once. It is
not a repository-wide authoring mutex. A second controller cannot replace an
active lease without an exact, user-authorized takeover, but run-prepared and
independently claimed authors may continue normal edits and commits in distinct
registered worktrees. Do not remove or rewrite the lock or state file by hand.

`loop guard` is a moment-in-time read-only preflight. It does not reserve a
future mutation. Use `loop exec` only for operations that change shared
integration state, so the same atomic lock covers a fresh manifest check, one
argument-array command, and a fresh post-command check. The reusable callback
awaits asynchronous work under that same boundary. It requires that the
caller's agent ID owns the exact registered controller or run-author worktree on
its recorded branch. It rejects any new unclaimed worktree, branch switch,
incomplete preparation, missing baseline worktree, or head/content change in a
preserved worktree. Run `loop verify` before merge, deployment, cleanup, and
completion even when every earlier operation passed.

`loop exec` pins every registered unit the run does not author itself to its
recorded head: a released or handed-off author's recorded state, and a
preserved, adopted, or retained checkout's baseline or approved override. No
merge-like `loop exec` command can integrate a commit other than a registered
unit's recorded head. While units are pinned, `loop exec` runs only Git and
provider merges that name their commit (`glab mr merge <iid> --sha <head>`);
any other program, including shells, interpreters, and scripts, is refused
before it starts, so run it outside `loop exec` or after the units are
integrated. The only merge-like Git subcommands it runs are `merge`,
`cherry-pick`, `revert`, `rebase`, `reset`, `push`, `fetch`, `update-ref`,
`branch`, `tag`, `worktree`, `stash`, `checkout`, `restore`, `am`, and
`apply`, and one is refused when it could resolve a unit's moving name: an
argument naming a pinned branch in any spelling, a path into a pinned
checkout, an indirect name (`@{...}`, `-`, `FETCH_HEAD`, the stash, another
worktree's refs, `:/` searches, every-branch or stdin options), an upstream or
fetch or push mapping, or a revision containing a commit a unit gained after
its recorded head. `-c`, Git options that run commands, configuration writes,
and staging that could record a nested checkout's HEAD are refused for every
Git command; a fetch may write only remote-tracking refs, a push or fetch may
use only known options, and nothing may run in a checkout the run does not
author. Name the recorded commit instead, as in `git merge --ff-only <head>`;
the refusal prints that command when it is certainly equivalent, or says the
unit moved and prints the claim, pause, and accept steps. `loop verify --for
merge` also fails while such a unit's branch has left its recorded head. The
controller and its prepared authors are not pinned.

For a Ship lease whose opening inventory contains local changes, first record
the conserved preview plan with `loop record-scope --receipt <file>`. The plan
must come from the exact current inventory and account for every changed path
in every worktree; the command persists the plan digest with that inventory's
digest and returns the pre-ship scope summary. Until then, `loop guard`,
`loop exec`, and completion fail closed. Record-scope accepts unrelated changes
made after `loop start`: claimed authors' edits and commits, other branches,
stashes, and late claimed worktrees. It still refuses when the pinned target
moved; when policy, discovered capabilities, remote bindings, or the target
binding changed; when `loop verify` fails, so a changed unclaimed opening
worktree first needs `loop allow`; or when the controller checkout or any unit
source worktree differs from its loop-start branch, head, or content. When the
first scope can no longer be recorded and the run has changed nothing yet,
`loop end` closes it with an `abort-unmutated.json` receipt, and a fresh
`loop start` takes a new baseline; a run with mutation evidence is finalized
and replanned instead.
Do not infer shipment exclusion from a `preserved` lease role: it means only
that the checkout cannot be changed or removed by the controller.
If independent review requires source changes, generate a new non-mutating
preview from the exact current inventory and record it with `loop refresh-scope
--receipt <change-plan.json>` before another mutation. This controller-only
action is rejected after an outcome exists and preserves the superseded scope
digest and timestamps in the lease history. A refresh keeps the scoped units and
cannot add a path to a scoped source worktree, but it accepts new paths that the
refreshed plan lists in `preserved` for any other worktree, such as another
agent's actively changing checkout. Outside scoped source worktrees, every path
preserved earlier stays preserved while it is still changed, whatever the
refreshed preview proposes for it. A refresh does not excuse the change itself:
`loop verify` still reports a registered worktree as changed, so record a
user-approved exact-state `loop allow` each time it changes; a worktree that
appeared after loop start is an `unregistered-worktree` violation instead,
handled as described below. `loop exec` also rejects `git switch` and `git
checkout` before Git can move a registered checkout; prepare the correct
branch-bound worktree before the loop instead.

Use these boundaries after an author is registered:

| Author-local and concurrent | Shared integration and serialized |
| --- | --- |
| Edit, generate, format, and run repository-local checks inside the author's worktree | Create, remove, detach, attach, or prune worktrees |
| `git add` and `git commit` on the author's distinct registered branch | Switch branches or move/update the canonical target or integration branch |
| Read Git/provider state | Merge, cherry-pick, or rebase work into the integration branch |
| Write normal worktree-local caches or build output | Push, mutate proposals, merge remotely, deploy, or clean repository objects |

Git already uses separate per-worktree indexes and atomic locks for distinct
branch refs and object writes. Simple Changes should not add a repository-wide
mutex around that ordinary authoring. Authors must still avoid shared Git
maintenance/configuration, stashes, tags, branch deletion, history rewrites,
provider writes, and any command that targets another worktree or branch unless
the matching integration boundary and authority apply.

When a genuine integration lock is busy, wait or retry only that short shared
operation; unrelated authors continue. Never pause them, demand a lease-null
handoff, export patches, or clean worktrees merely to free the lock. When lock
creation instead fails with `EPERM`, `EACCES`, `EROFS`, or another
permission-denied result, treat it as a local harness/filesystem authorization
failure. It is not evidence of a live lock owner, so do not run recovery or
coordinate an owner pause until actual lock metadata proves contention.

The default `concurrentWork: "allow-claimed"` policy recognizes an active owner
claim on a distinct non-primary branch as `concurrent-author`. The author may
keep editing and committing without a pause receipt, both when present at loop
start, when claimed after the opening manifest recorded it as `preserved`, and
when arriving later. The next guarded observation promotes a qualifying opening
`preserved` entry and binds its exact claim ID and owner. Head and content-digest
drift are expected for that role. The controller excludes it from the current
integration and cleanup. Verification still fails closed if the claim is
absent, reassigned, or branch-mismatched, if the worktree changed after its
owner released the claim, or if the worktree is primary or on the primary
target branch. A released claim is never refreshed, so `loop verify` and `loop
status` then print the exact recovery: the owner claims and pauses the checkout
with `preserve-in-place`, and the controller runs `loop accept-paused-change`. Use `concurrentWork: "strict"` for the
older repository-wide serialized behavior. Legacy `preserve` policy values
follow `allow-claimed`.

An external provider mutation that cannot execute inside `loop exec` uses the
narrow fallback: `loop guard` immediately before the call and `loop verify`
immediately after it. Never describe that fallback as an atomic local mutation
lock.

If a process crashes, `loop recover` removes the loop lock only when its ownership
metadata is valid, it is older than the recovery boundary, the recorded host is
the current host, the controller PID is provably dead, child launch is fully
recorded, every recorded child/process group is inactive, and the caller owns
the active lease. When the same dead PID also owns a stale worktree-coordination
lock, recovery removes that exact matching lock in the same transaction; a
mismatched coordination owner fails closed. A live, remote-host, young,
ownerless, malformed, unresolved, or still-running process-group lock remains a
blocker.

The transient lock and persistent controller lease have different recovery
paths. `loop recover` never transfers the persistent lease. A controller that
reaches the end of its agent turn must run `loop finalize`: a fully reconciled
run closes and deletes the lease, while an incomplete run records its blockers,
marks the controller `relinquished`, disables its mutation authority, and keeps
all ledger evidence. Unexpected finalization errors also relinquish the latest
saved state once ownership and both locks are established, if that state remains
writable; the command still fails and records the error on the controller.
Re-read `loop status --json` before replying to verify release. The next controller
starts with mode `resume`, adopts that exact run ID, and continues from fresh evidence.
Relinquishment is not a repository-wide authoring pause: registered authors may
continue ordinary author-local work, and no controller should destructively
park or clean their work merely to manufacture a lease-null interval.

If a controller disappears before finalization, do not delete the state file or
infer abandonment from elapsed time or a dead helper PID: helper commands exit
between agent steps. Re-read `loop status` and follow its recovery guidance using
explicit session authority. A stale lease can use `loop recover --stale-lease`;
an active takeover requires the exact current run ID and manifest digest,
approver, and reason. Any intervening manifest change invalidates takeover evidence.

Normal command completion is also process-group scoped. A direct command
leader that exits while background descendants remain does not complete the
guarded mutation. Terminate those descendants and reject the command before
releasing the lock. If the process group cannot be terminated, retain the lock
so explicit recovery must prove the remaining processes inactive.

## New agents during an active loop

An agent joining the same integration unit must begin with `prepare-agent`. The command records a
pending preparation before creating a unique branch and sibling worktree from
the pinned target revision, then registers the completed worktree with the
active run and returns its exact path. Use that path as the agent's working
directory before it edits, formats, generates, stages, or commits files.
Repeating the command for the same agent ID returns the existing registration;
if creation stopped partway through, the same command validates and resumes the
recorded preparation instead of guessing or creating another branch. It refuses
to adopt staged, unstaged, or untracked content, and a registered author loses
mutation authority after switching away from the recorded branch.

An independent feature agent instead creates its own isolated worktree and runs
`worktree claim` as the immediate next command. Do not inspect project files
from the new checkout, install dependencies, format, generate, edit, stage, or
commit there before the claim succeeds. It does not acquire a second integration
lease and does not need `prepare-agent` unless its work is being assigned into
the active integration run.

Read-only review can inspect commit objects or provider diffs without an
authoring worktree. The moment a reviewer needs to make a change, it becomes an
author and must prepare an isolated worktree first.

## Parallel agents

When scheduling selects parallel authoring and the host can start isolated
agents and learn when each one finishes, the controller may hand each
independent unit to its own agent instead of authoring the units one after
another. Delegation changes who edits a unit, not what the agents share. When
the host cannot start agents or report their completion, author the units
consecutively; that is a harness limit, not a policy change.

`consecutive` delegates only for necessary isolation, `balanced` delegates
when the time saved is meaningful, and `parallel` delegates every independent
unit while still confirming unusually expensive fan-out. Every prepared branch
starts from the lease's pinned target revision, so a unit that needs another
unit's result is either authored by the controller after that result is
integrated or delegated only after the controller refreshes its prepared
branch onto the updated target through `loop exec`.

1. After any required scope is recorded, the controller runs `prepare-agent`
   once per independent unit, one call at a time, before starting those
   agents. Give each unit a new agent ID that is never the controller's own,
   and require `created: true` from its first call: a repeated ID returns
   whatever that ID already registered, including the controller's checkout.
   Concurrent calls collide on the busy state lock, so agents gain nothing by
   preparing their own worktrees.
2. Start the agents together. Give each one its exact prepared path, branch,
   agent ID, and unit scope; the checks to run; and its boundary: edit,
   generate, format, check, stage, and commit only inside that worktree. A
   delegated agent runs no `initialize` or `loop` command, push, provider call,
   merge, release, deployment, or cleanup, and never touches another worktree,
   branch, stash, or tag. The runtime still lets any run-prepared author use
   the guarded executor, so this boundary lives in the brief.
3. Each agent returns its final commit, the checks it ran with their results,
   and any open question, leaving its worktree clean. Before treating the unit
   as ready, the controller confirms that the registered branch head equals the
   reported commit and that no uncommitted changes remain. A unit with an open
   question or a failed check waits while the others continue.
4. The controller alone pushes, opens or updates proposals, and merges each
   unit through the ordinary serialized path, refreshing and re-verifying
   downstream units after every target move. It changes a delegated worktree,
   including a refresh onto the new target, only after every agent using that
   worktree, whether author or check runner, has returned.

Never let the host create an agent's checkout, including through its own
worktree isolation. A worktree that appears after loop start without run
preparation is an `unregistered-worktree` violation: it blocks every guarded
operation and further `prepare-agent` until it is claimed under
`allow-claimed`, adopted, or rebaselined, and even a claimed one becomes
concurrent-author work this run cannot integrate.

To retry a stopped agent, first confirm the earlier agent has ended, then give
the replacement the same agent ID and prepared path; `prepare-agent` returns
the existing registration instead of creating a second worktree. The
replacement inspects the existing commits and uncommitted changes before
editing. A resumed run whose scope froze can finish registered agents but
cannot prepare new ones.

Read-only work pinned to one exact head may also run in parallel: independent
review and local reproduction of required checks. An agent never reviews a
unit it authored. Reproduce checks inside the unit's registered worktree after
its author has returned, never in a new checkout. Changelog phases keep the
order in [changelog coordination](changelog-coordination.md); because
`prepare` moves the head, review and checks for that head start only after it
lands, and any later commit invalidates pinned results the usual way.

Inventory snapshots, the controller lease, target movement, pushes, merges,
version selection, release, deployment, and finalization stay with the
controller. A snapshot split across agents is not one baseline.

## Ready work blocked by another shipping controller

When a separate task already owns the active shipping controller, finished and
verified work must remain on its exact worktree, branch, and commit. Do not
start a competing shipment. Offer the user two choices in plain language:

- **Fold into the active shipment:** with explicit approval, record a
  [ready-work receipt](#ready-work-receipts) with `worktree release
  --ready-receipt <file>`. The active controller finds it through `worktree
  status --json` at its next planning point, so no message is needed. When the
  host can identify and contact the exact owning task, you may also tell it
  that the receipt is recorded.
- **Ship separately afterward:** preserve the claim and work unchanged, wait
  for the active shipment to close, then begin a fresh shipment.

Do not imply that another task accepted, integrated, shipped, or deployed the
work before confirmation. A ready-work receipt is coordination, not authority
to take ownership, merge, deploy, apply migrations, or clean up. Never guess a
recipient; the recorded receipt reaches every controller without one.

## Ready-work receipts

A ready-work receipt is the passive form of a handoff. The finished author
records it once, and every controller in every harness on this machine reads it
from the shared coordination directory without either side messaging the
other. Write the author half as JSON:

```json
{
  "scope": "One sentence naming what this unit changes.",
  "checks": [{ "command": "bun run check", "result": "passed" }],
  "releaseImpact": "patch",
  "migrations": [],
  "deploymentConstraints": ["Deploy only after the 17:00 freeze lifts."],
  "unresolvedAuthority": []
}
```

Then run `worktree release --agent-id <owner> --claim-id <id> --ready-receipt
<file>`. The checkout must be clean and on its branch, so commit first. The
runtime binds the claim, owner, path, branch, exact head, and content digest
itself, rejects those fields in the input, and refuses secrets.
`releaseImpact` is `none`, `patch`, `minor`, `major`, or `unknown`; each check
`result` is `passed`, `failed`, or `skipped` with an optional `note`. In the
same lock interval it releases the claim as a completed-work `handoff` that
records the receipted evidence, so an active loop that admitted the author
keeps integrating instead of reporting a stale claim.

`worktree status --json` lists every receipt under `readyWork` with its
freshness: `current` while the branch is still at the receipted head and the
checkout is unchanged, `stale` once either moves, and `shipped` once the target
contains the head. For a stale receipt, ask the owner for a new one; never ship
newer commits on an old receipt. A controller plans current receipts as
ordinary released units and carries their migrations and deployment
constraints into the shipment. A receipt is evidence, not authority: it never
grants merge, deploy, migration, or cleanup permission.

## Shipment holds

A hold is how any agent tells every shipping controller to stop or wait without
contacting it. Add one when a task outside the shipment could break, or be
broken by, the next merge, deployment, or migration: a production backfill or
migration in progress, an incident, a release freeze, or a companion change
that must land first.

```sh
simple-changes hold add --agent-id "$AGENT_ID" --adapter <harness> \
  --hold-scope ship|deploy|migrations --severity delay|halt \
  --reason "<plain reason the user will read>" [--until-merged <branch>]
```

- **Scope:** `ship` covers merges, deployments, and migrations; `deploy` covers
  deployments; `migrations` covers migration applies. Before a merge, a
  `deploy` or `migrations` hold is advisory: if merging the target deploys or
  migrates automatically, treat it as blocking and ask the user.
- **Severity:** a `delay` pauses the covered step until the user decides; a
  `halt` stops it until the hold ends.
- **Evidence:** `--until-merged <branch>` ends the hold once the target
  contains that branch by ancestry or patch equivalence, and the first gate
  that observes it records the release as `merged`. The branch must exist and
  must not already be contained.

Holds live in `holds.json` beside the worktree claims, so agents in any harness
on this machine see them at once. To reach clones on other machines or in cloud
sandboxes, the owner runs `hold publish --agent-id <owner> --hold-id <id>`,
which pushes the hold as `refs/simple-changes/holds/<id>` to the target remote.
Publishing is a push, so follow
[harness push authorization](harness-push-authorization.md); a repository whose
push authorization is `never` keeps its holds local. Publication is recorded
before the push and confirmed only once the remote lists the ref, so a retry
pushes the same commit and a release that races the push still withdraws it.
Published holds are read with plain `ls-remote` and fetch, never prompt for
credentials, and time out instead of waiting. Another clone judges a published
`--until-merged` hold only from that remote's copy of the branch, never from a
same-named local branch, so push the branch too; otherwise other clones can
clear the hold only when its owner releases it.

The owner ends a hold with `hold release --agent-id <owner> --hold-id <id>` as
soon as its reason is over. Release also withdraws a published ref and reports
a failed withdrawal with its retry; status lists released holds whose refs are
still published. Another agent releases a hold only with `--approved-by` and
`--reason` from the user, plus `--override-halt` for a halt; the owner's own
clone keeps its record until the owner releases it there, and its gates report
that the published ref was withdrawn elsewhere. No hold is released by elapsed
time.

Check holds at each covered step: run `loop verify --for merge`, `--for
deploy`, or `--for migrations` immediately before that step, and `hold check
--for <step>` for a step outside a loop. `migration apply` enforces
`migrations` holds itself. `loop start` and `loop status` list the holds
recorded here; the gates also evaluate merge evidence and read published holds
from the target remote, plus any `--remote` you name. A gate fails closed when
published holds cannot be read, including when remotes exist but none is the
target; pass `--local-only` only after the user agrees.

When a hold blocks:

- **Delay:** stop and ask: **<owner> asked to delay <step> because <reason>.
  Should I wait, or continue without it?** If the user chooses to continue,
  record `hold waive --run-id <run> --agent-id <controller> --hold-id <id>
  --approved-by <user> --reason "<why>"`.
- **Halt:** stop the covered step and tell the user who halted it and why.
  Waive it only when the user explicitly approves overriding that exact hold,
  adding `--override-halt`.

A waiver binds the current run and the hold's exact content, so it never
carries into the next shipment. Only that run's active controller records one,
and it applies only while that controller holds control. Work a hold does not cover may continue. Holds never block `loop
finalize`: a halted run relinquishes with its blockers recorded like any other
incomplete run.

## Owner claims and safe pauses

Every owner-created worktree should be claimed immediately with `worktree
claim`. The claim lives beneath the common Git directory, binds the canonical
path, repository identity, branch, HEAD, content-sensitive digest, owner agent,
adapter slug, and opaque `ownerRef`, and is written atomically with mode `0600`.
Do not put titles, prompts, message bodies, credentials, or tokens in the owner
reference.

Release the claim when the work is done. An active claim excludes its
checkout from packaging, merge, and cleanup, so a finished branch stays
unshippable until its owner runs `worktree release --claim-id <id>` or hands
the work off with `initialize --mode handoff --agent-id <owner>`, which
releases the owner's own claim on the current checkout the moment the handoff
proceeds. Do not release a claim to "free" a lock or to make a controller's
inventory smaller; release it because the work is complete, verified, and
committed on its branch. `worktree status --json` lists every claim, pause
receipt, and recorded release reason; `worktree request` builds the
adapter-shaped pause, detach, or resume message for one exact owner and sends
nothing by itself.

Finalization also releases claims by evidence, never by elapsed time: the
controller's own active claim on a clean checkout whose exact head the
refreshed target already contains (`releaseReason: "shipped"`), and any live
non-detached claim whose worktree directory no longer exists
(`releaseReason: "worktree-absent"`). A detached claim keeps its branch and is
never released this way. Another owner's live claim on an existing checkout is
untouched.

A claim whose recorded owner no longer exists and whose worktree is still
present is not released by guessing the owner identity; use the audited
`worktree takeover` recovery in
[cleanup and completion](cleanup-and-completion.md).

Under `allow-claimed`, a healthy distinct active claim does not block the loop;
its owner keeps working and the controller excludes it. A valid active claim
also promotes an opening `preserved` registration automatically. Do not ask for
user approval or call `loop allow` for ordinary claimed concurrency. When strict
policy or a real collision blocks a loop, contact only the exact claimed owner.
The owner runs `worktree pause` at a safe boundary. `preserve-in-place` accepts
dirty work but rejects active Git operations and conflicts;
`detach-clean-checkout` additionally requires no changes. The resulting receipt
is evidence, not permission to edit the worktree.

Use `loop adopt-worktree` for a paused worktree that appeared after loop start.
Use `loop accept-paused-change` for an opening preserved worktree whose owner
changed it before pausing. Both commands require the receipt's run, repository,
path, branch, HEAD, digest, claim owner, and current state to match, register the
worktree as preserved with `mutationAllowed: false`, and reject the update when
any unrelated manifest violation remains. A sibling worktree that either
command could record next, and whose exact current state its own valid current
pause receipt for this run covers, does not count as a blocking violation, so
several receipted checkouts can be adopted or accepted one at a time in any
order instead of deadlocking against each other. `loop allow` remains the separate
exceptional user-approved override path.

Harness support is not uniform. The host orchestration layer must probe exact
discovery, delivery, waiting, scope, and worktree-identity capabilities before
sending a request. Missing capability returns the structured manual next step;
it never selects an owner from a title or weak hint.

## Exact overrides

An override is an exceptional user handoff, not a way to suppress the guard.
When several preserved worktrees each need an override, record each exact
path-and-digest approval independently. The controller persists a valid
per-path override even while other paths remain blocked, so the sequence cannot
deadlock on an impossible all-at-once lease update.
Record it through `loop allow` only after the user explicitly names the work to
include. The command verifies and stores the preserved worktree's absolute
path, current content-sensitive change digest, current head, approver identity,
and reason. It does not accept a wildcard, repository-wide permission, or stale
digest. A later edit or commit changes the evidence and blocks the loop again.

`loop end` is the strict non-mutating completed-run primitive. At the terminal
boundary use `loop finalize` instead: in integration/reconciliation modes it
first removes unchanged clean target-contained worktrees and branches, prunes
stale worktree metadata, normalizes recoverable tracked primary paths already
identical to the target, and restores the primary. It then performs the
same completion gates and releases the lease when they pass, or relinquishes
the controller with a nonzero exit while preserving the incomplete run.

The opening lease records exact local branch names and revisions. Automatic
branch deletion accepts only an unchanged opening branch or a branch created by
the current run; an unattached branch that appears or moves later is preserved.
Final cleanup holds both loop and worktree-coordination locks, re-reads each
candidate's branch, head, digest, and claim state immediately before removal,
and durably records the exact opening-worktree removal intent before invoking
Git. If the controller dies after removal, that intent authorizes only the
matching absence so stale-lock recovery can resume without weakening any other
preserved-worktree check.

## Opening-worktree dispositions

Do not reinterpret changed, dirty, claimed, retained, late-arriving, or unique
opening work as cleanup. An opening worktree that remains unchanged across the
run, is clean and unclaimed, and has an exact head already contained in the
refreshed target is a normal automatic cleanup candidate. Use
`loop retain-worktree` when that checkout should stay. For exceptional changed
opening work, and for a worktree adopted into the lease mid-run through
`adopt-worktree` or `accept-paused-change`, `loop dispose-worktree` records a
manual removal disposition under the active lease; never fall back to raw
`git worktree remove` for lease-registered state. The command accepts only the
exact current path and content-sensitive status digest, requires the loop
owner and named approver, rejects the canonical primary checkout, and audits
that the worktree is clean and its head has zero unique commits outside the
lease's pinned canonical target revision, where a commit whose exact patch the
target already contains (a squash- or rebase-merged straggler) counts as not
unique and the proving method is recorded. The manifest records its branch,
head, digest, target ref and revision, approver, reason, and
zero-unique-commit result before deletion.

The disposition permits only that opening worktree's absence. It does not
remove the path, authorize `--force`, delete its branch, suppress other
violations, survive an intervening worktree change, or match when its recorded
target ref or revision differs from the active lease. Run the exact removal
through `loop exec` so preflight sees the recorded disposition and postflight
proves only the authorized path disappeared.

If a preserved worktree the run did not create, whether registered at loop
start, adopted, or added by `loop rebaseline`, has already disappeared because
its owning task removed it, `loop retire-absent-worktree` records the absence
instead. It
accepts only a path missing from disk and from the live worktree list, needs
the loop owner and a named approver, binds to the exact registered baseline,
and leaves branches, claims, and delivery proof untouched.

Concurrent cleanup must preserve every path and branch registered by an open
loop, including prepared authors, released claims, and stale or relinquished
runs. Run `prune` to clean eligible unrelated state; its deferred items belong
to the controller or a later pass after closure. Do not remove a registered
checkout through raw Git, filesystem deletion, or editor cleanup. The
controller's exact removal disposition, or an approved retirement record for
a checkout its owner removed, already lets verification accept the absence
without a separate repair. A missing path without either record still requires
investigation; a formerly clean HEAD does not prove that no uncommitted work
was lost.

## Exact retained exclusions

When the user explicitly wants a clean, target-contained, non-primary worktree
left in place and outside the shipment, use `loop retain-worktree` with its exact
current path and status digest. This records role `retained`, keeps mutation
disabled, and exempts the unchanged worktree from completed-run cleanup. It
does not remove, modify, include, push, or merge that worktree.

Any HEAD or digest change invalidates retention. If the worktree becomes active,
its owner must create or refresh an active claim; the lease then promotes it to
`concurrent-author`. Use harness owner discovery and delivery before asking the
user to pause another task. Without an active claim or stable pause, the moving
worktree remains a blocker.
