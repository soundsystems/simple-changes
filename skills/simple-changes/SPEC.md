# Simple Changes behavioral specification

## Triggers

- Explicit requests to sync with the canonical Git target, package, queue,
  integrate, merge, ship, reconcile, or preview repository changes.
- A managed completed-work pointer after attributable implementation and
  proportionate verification.
- A user signal that completed implementation is ready to put up, merge, ship,
  finish, or reconcile.

## Non-triggers

- Read-only review, explanation, planning, or diagnosis.
- Blocked or incomplete implementation, failing required checks, or work that
  changed no repository files.
- Commit-message-only, changelog-only, or release-note-only requests.
- UI generation without a request to package or integrate the resulting work.
- Completion of a Simple Changes run or work owned by another active agent.

## Inputs

- The current user request and authority.
- Repository and directory-scoped instructions.
- Repository policy, then personal preferences, then safe defaults.
- Fresh Git, provider, deployment, changelog, and verification evidence.
- For Sync, the exact canonical remote target, original local HEAD, status, and
  ahead/behind/ancestry evidence.
- For completed-work handoff, the closed initialization status and attributable
  implementation scope.
- When multiple UI iterations will be saved, the repository convention or
  closed fallback artifact-naming preference.

## Outputs

- A validated initialization status before mutation.
- A focused plan and explicit outstanding-work ledger.
- Verified proposals, merges, deployments, or preserved work within the
  authorized finish boundary.
- For Sync, the fetched target and resulting or preserved local branch state.
- For Ship, a pre-mutation scope brief and a final shipped-state receipt with
  review-driven deltas.
- Exact receipts for policy and managed instruction-pointer writes.

## Guarantees

- Existing and concurrent work is preserved unless ownership and scope are
  proven.
- Write-capable integration modes hold one atomic active-loop lease with an
  opening worktree manifest; a second controller, unregistered worktree, or
  changed preserved worktree blocks mutation.
- Local mutations hold the lease lock across fresh preflight inventory, one
  bounded argument-array command, and post-mutation verification. Change
  digests include actual staged, unstaged, and untracked contents.
- New authoring agents receive an isolated, run-registered worktree before
  editing. Worktree creation is resumable from a pinned target revision, and a
  stale lock is recoverable only after proof that its recorded local owner died.
  Exact user overrides bind to one path, head, and content digest and become
  invalid after another change.
- Missing onboarding defaults to checked proposal creation and confirmation
  before completed-work handoff.
- Instruction setup updates only an existing exact file after confirmation,
  rejects symlinks and malformed managed blocks, and never creates a missing
  instruction file.
- Completed-work handoff cannot mutate while readiness confirmation is pending.
- UI artifact naming never overrides an established repository convention and
  never controls source, Git, deployment, package, or release versions.
- Sync never pushes, guesses an ambiguous remote, stashes dirty work, rewrites
  shared history, or leaves the checkout conflicted.
- Authorized Ship runs communicate scope before mutation without adding a
  redundant permission gate, then account for review-driven revisions.
- Deployment and high-risk actions retain their independent authority checks.

## Forbidden behaviors

- Treating implementation completion as production, migration, secret, DNS,
  store-release, or history-rewrite authority.
- Automatically handing off planning, diagnosis, blocked work, no-change work,
  or another agent's work.
- Starting a competing integration loop, mutating from another agent's
  checkout, running a local mutation outside the atomic executor, or bypassing
  an active manifest with a blanket exception.
- Creating an instruction file, guessing a global instruction path, or
  duplicating the managed pointer.
- Treating a generic Sync request as push, reset, rebase, proposal, deployment,
  or data-write authority.
- Reporting the original Ship plan as delivered without reconciling review
  changes and final provider evidence.
- Directly authoring changelogs, release notes, version fields, or release
  policy.
