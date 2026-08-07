# Cross-thread worktree coordination for Simple Changes

**Date:** 2026-08-07

**Status:** Proposed

**Scope:** Worktree ownership, pause receipts, active-loop adoption, safe detach/attach, controller-to-owner coordination, and the Thor/Codex integration
**Upstream baseline inspected:** `origin/main` at `d5e2721`

**Local workspace note:** the opening checkout was 26 commits behind
`origin/main` and carried unrelated uncommitted onboarding/initialization work.
The reconciliation loop proved that work integrated or superseded, preserved a
recovery copy, and fast-forwarded local `main` to `d5e2721`. Implement from a
fresh isolated worktree after re-verifying the baseline. See "Workspace
prerequisites" under the rollout plan.

## Outcome

Make cross-agent repository synchronization a first-class Simple Changes workflow.

When a controller encounters work owned by another task, it should be able to:

1. identify the owning task from durable local evidence;
2. ask that task to pause at a safe boundary;
3. receive an exact, content-sensitive pause receipt;
4. adopt the paused worktree into the active lease as preserved state;
5. synchronize the canonical checkout without deleting, resetting, stashing, or rewriting the paused work;
6. optionally detach a clean worktree while preserving its branch and commits;
7. recreate a detached worktree after synchronization; and
8. notify the owning task that it may safely resume.

The upstream skill must remain platform-neutral. Thor should provide the Codex-specific adapter that discovers tasks, sends messages, waits for acknowledgements, and posts resume instructions.

## Motivation

The active-loop lease correctly blocks mutation when a new worktree appears after the opening inventory or when a preserved worktree changes. That guarantee prevents one controller from silently overwriting another agent's work.

The missing piece is a safe recovery path. Today:

- an unregistered worktree blocks every guarded mutation;
- `loop allow` applies only to a worktree that was already preserved at lease start;
- `prepare-agent` creates a new isolated worktree and cannot adopt an existing owner-created checkout;
- `loop dispose-worktree` intentionally rejects unique commits because it models obsolete cleanup, not a temporary coordination detach; and
- the runtime has no durable mapping from a worktree to the task or agent that owns it.

This creates a coordination deadlock. The controller can discover the responsible task manually and ask it to remove a clean worktree, but the workflow is not encoded, portable, or automatically verifiable.

The desired behavior is not a weaker guard. It is a stronger protocol that converts an unknown concurrent arrival into exact, acknowledged, preserved state.

## Incident-derived requirements

The design is based on a real synchronization run with two paused worktrees:

- A dirty notification-lifecycle worktree changed after the controller's lease started. Its staged, unstaged, and untracked contents had to remain byte-for-byte preserved.
- A clean capability-registry worktree appeared after lease start and contained two commits beyond the pinned target. Its owning Codex task was found, asked to pause, and instructed to remove only the worktree registration while retaining the branch and commits.
- After the clean worktree was detached and the dirty worktree was accepted by exact digest, the controller fast-forwarded local `main`, verified `0/0` divergence, ran the repository check, and told both tasks to resume.

The automated workflow must support that sequence without relying on thread-title guesses, prose-only promises, blanket overrides, or branch deletion.

## Non-goals

- Do not make Simple Changes a general task scheduler.
- Do not let the upstream runtime call Codex-, Claude-, IDE-, or vendor-specific APIs directly.
- Do not infer ownership from a branch name, worktree basename, process title, or task title alone.
- Do not automatically merge or rebase dirty feature worktrees.
- Do not force-remove worktrees.
- Do not delete branches as part of pause, detach, adoption, or resume.
- Do not turn a pause receipt into permission to edit another task's work.
- Do not weaken the current process-group, target-pinning, path, digest, or active-controller safeguards.

## Design principles

### Preservation is the default transition

Adoption gives the controller permission to preserve and account for the worktree. It does not grant mutation authority over that worktree.

### Ownership must be explicit and local

The task that creates or begins using a worktree should claim it. Claims and pause receipts live beneath the repository's common Git directory, not in tracked source files.

### Every acknowledgement binds to exact evidence

A pause or adoption receipt binds to:

- canonical worktree path;
- common Git directory;
- branch or detached identity;
- exact HEAD;
- content-sensitive change digest;
- owner identity and opaque task reference;
- request and acknowledgement timestamps; and
- intended disposition.

Any edit, commit, branch switch, removal, or recreation invalidates the receipt until it is refreshed by the owner.

### Platform adapters coordinate; the runtime verifies

The core runtime should emit structured coordination requirements and validate receipts. An optional environment adapter may deliver messages and wait for responses, but it may not bypass runtime verification.

### Detach is not disposal

Two operations must remain distinct:

- **Dispose:** obsolete cleanup; requires zero unique commits beyond the pinned target and the existing exact user-approved disposition.
- **Detach:** temporary removal of a clean, non-primary checkout; allows unique commits because the local branch must remain at the exact HEAD.

## State model

Each claimed worktree has one coordination state:

```text
active
  -> pause-requested
  -> paused
  -> adopted-preserved
  -> resume-ready
  -> active

paused
  -> detach-requested
  -> detached
  -> attached
  -> resume-ready
  -> active
```

Terminal or exceptional states:

- `released`: the owner explicitly relinquished the claim without deleting work;
- `stale`: current Git evidence no longer matches the recorded claim;
- `blocked`: ownership is ambiguous, the owner did not acknowledge, or a safety invariant failed.

State transitions must be atomic and append an audit event. The current state can be materialized for fast reads, but the append-only events provide recovery and debugging evidence.

Transition authority is explicit:

- `pause-requested` and `detach-requested` are controller-written request records stored with the run's coordination requests; they never modify the owner's claim file.
- `paused`, `detached`, `attached`, and `released` transitions are written only by the claim owner.
- `adopted-preserved` and `resume-ready` are controller-written annotations on the lease and coordination metadata, valid only against a current owner receipt.
- `resume-ready -> active` happens when the owner refreshes its claim on resume.
- `loop dispose-worktree` and `loop end` mark any linked claim `released` or `stale`; stale claims are reported, never silently deleted.

## Durable contracts

### Worktree claim

Add a `worktree-coordination` schema with a claim shaped like:

```json
{
  "schemaVersion": 1,
  "claimId": "claim-...",
  "repositoryId": "sha256(commonGitDirectory)",
  "commonGitDirectory": "/absolute/common/git/dir",
  "path": "/absolute/worktree/path",
  "branch": "feat/example",
  "headSha": "<full-sha>",
  "changeDigest": "<sha256>",
  "owner": {
    "agentId": "agent-id",
    "adapter": "codex|manual|none",
    "taskRef": "opaque-local-reference"
  },
  "state": "active",
  "createdAt": "<date-time>",
  "updatedAt": "<date-time>"
}
```

`taskRef` is opaque and local. The upstream runtime must not parse it or store task titles, prompts, user messages, credentials, or provider tokens.

### Pause receipt

A pause acknowledgement records:

```json
{
  "schemaVersion": 1,
  "receiptId": "pause-...",
  "claimId": "claim-...",
  "requestingRunId": "run-...",
  "path": "/absolute/worktree/path",
  "branch": "feat/example",
  "headSha": "<full-sha>",
  "changeDigest": "<sha256>",
  "ownerAgentId": "agent-id",
  "disposition": "preserve-in-place|detach-clean-checkout",
  "acknowledgedAt": "<date-time>",
  "reason": "bounded human-readable reason"
}
```

The runtime captures the inventory itself immediately before writing the receipt. Callers cannot supply HEAD or digest as trusted facts.

### Loop-lease linkage

Extend `LoopWorktreeLease` with optional additive fields so existing schema-version-1 leases remain readable:

```ts
claimId?: string;
pauseReceiptId?: string;
coordinationState?: "adopted-preserved" | "resume-ready";
```

Do not bump the active-loop schema merely to add optional fields. If later semantics require incompatible interpretation, introduce schema version 2 with an explicit version-1 normalization path.

The schema document itself still needs an additive edit: `loop-lease.schema.json` validates worktree entries strictly, so the new optional fields must be declared explicitly for version-1 leases and linked leases to co-validate. Register the new `worktree-coordination` schema in the `schemaNames` list in `schema.ts` so `simple-changes validate` accepts it.

## Upstream CLI

### `worktree claim`

```sh
simple-changes worktree claim \
  --agent-id AGENT \
  --worktree PATH \
  --adapter codex \
  --task-ref OPAQUE_REF \
  --json
```

Requirements:

- resolve the canonical real path;
- prove the path is a current worktree in the same common Git directory;
- reject the primary checkout unless the caller is its registered controller;
- capture branch, HEAD, and content digest internally;
- reject conflicting live claims unless ownership is explicitly handed off; and
- write state atomically with mode `0600` beneath `<commonGitDirectory>/simple-changes/worktree-coordination/`, a sibling of the existing `simple-changes/active-loop.json` state, guarded by the same lock-directory pattern the loop lease already uses (`worktree-coordination.lock/owner.json`).

Repeated claims by the same owner are idempotent when the path and Git identity still match. Re-running `worktree claim` after an approved post-detach branch move is the explicit claim-refresh path; the refreshed claim must record what changed.

### `worktree pause`

```sh
simple-changes worktree pause \
  --agent-id AGENT \
  --worktree PATH \
  --run-id REQUESTING_RUN \
  --disposition preserve-in-place \
  --reason TEXT \
  --json
```

Only the current claim owner may acknowledge the pause. The command must:

- reject an active Git operation or unresolved conflict;
- capture fresh Git evidence;
- write the exact pause receipt;
- change only coordination metadata; and
- perform no source, branch, index, stash, or remote mutation.

Dirty worktrees may use `preserve-in-place`. `detach-clean-checkout` requires a completely clean worktree.

### `loop adopt-worktree`

```sh
simple-changes loop adopt-worktree \
  --run-id RUN \
  --agent-id CONTROLLER \
  --pause-receipt RECEIPT_ID \
  --json
```

This is the missing deadlock breaker. Under the active-loop state lock it must:

1. verify controller ownership;
2. load the current repository inventory;
3. verify the receipt belongs to the same common Git directory and run;
4. require current path, branch, HEAD, and digest to match the receipt;
5. require the owner claim to still be paused;
6. add the worktree to the lease as `role: "preserved"`, `mutationAllowed: false`, and `createdByRun: false`;
7. attach claim and receipt IDs; and
8. verify that no other manifest violation remains before committing the lease update.

Adoption must never register the worktree as an author or controller checkout.

### `loop accept-paused-change`

```sh
simple-changes loop accept-paused-change \
  --run-id RUN \
  --agent-id CONTROLLER \
  --pause-receipt RECEIPT_ID \
  --json
```

This handles a worktree that existed at loop start but changed before its owner paused. It replaces the preserved baseline only when the pause receipt exactly matches current evidence.

This is distinct from `loop allow`:

- `accept-paused-change` means “the owner paused this exact state; preserve it.”
- `loop allow` remains an exceptional user-approved override for including or tolerating a changed preserved worktree without an owner pause receipt.

### `worktree detach`

```sh
simple-changes worktree detach \
  --agent-id OWNER \
  --worktree PATH \
  --pause-receipt RECEIPT_ID \
  --json
```

Detach is allowed only when all of the following are proven immediately before mutation:

- the worktree is not primary;
- the worktree is clean;
- no Git operation is active;
- it is attached to a local branch;
- the branch ref resolves to the worktree's exact HEAD;
- the claim owner matches;
- the pause receipt requests `detach-clean-checkout`; and
- the exact checkout path is not needed by another active lease.

Run `git worktree remove PATH` without `--force` through the repository's serialized Git mutation path. Verify afterward that:

- the worktree registration and directory are absent;
- the branch still exists at the exact recorded HEAD; and
- no other worktree or ref changed.

Unique commits are permitted because branch retention is proven. The command never deletes the branch.

### `worktree attach`

```sh
simple-changes worktree attach \
  --agent-id OWNER \
  --claim-id CLAIM \
  --json
```

Attach recreates a detached worktree only when:

- the recorded path is absent;
- the local branch still exists;
- the branch has not moved unexpectedly since detach, unless the owner explicitly refreshes the claim;
- the path is safe and belongs to the expected repository; and
- no active lease forbids creation.

It runs `git worktree add PATH BRANCH` without creating, deleting, resetting, or rebasing the branch.

### `worktree resume-ready`

```sh
simple-changes worktree resume-ready \
  --run-id RUN \
  --agent-id CONTROLLER \
  --claim-id CLAIM \
  --json
```

The controller marks a paused claim `resume-ready` after the canonical checkout is synchronized and final verification passes. The command records the canonical target ref and exact target SHA for the owner. The runtime resolves the lease's target ref at its current, verified post-synchronization head; callers cannot supply the ref or SHA as trusted facts, and the lease-start pinned revision is never substituted for the refreshed head.

It does not update the feature branch. On resume:

- a clean feature worktree may use the repository-established merge strategy;
- a dirty worktree remains preserved and must reconcile target changes under its owner's normal workflow; and
- no automatic stash, reset, rebase, or force-push is permitted.

### `worktree release`

```sh
simple-changes worktree release \
  --agent-id OWNER \
  --claim-id CLAIM \
  --json
```

The owner relinquishes a claim without deleting any work. Releasing a claim that a live lease has adopted marks the associated receipt stale and re-blocks the lease; release never weakens an active guard.

### CLI integration

- Register the `worktree` command group and the two new `loop` subcommands in the CLI parser, the `HELP` usage text, and the `loop` dispatcher's supported-action error message.
- Document every new command in `README.md` alongside the existing `loop` and `prepare-agent` command list.
- All new commands support `--json` and `--repo PATH` and use the existing exit-code contract (`2` usage, `3` invalid contract, `5` unsafe state).

## Coordination adapter contract

The upstream runtime should expose structured JSON, not vendor API calls:

```ts
interface CoordinationRequest {
  action: "request-pause" | "request-detach" | "notify-resume";
  claimId: string;
  owner: {
    adapter: string;
    agentId: string;
    taskRef: string | null;
  };
  repository: {
    commonGitDirectory: string;
    worktreePath: string;
  };
  runId: string;
  safeMessage: string;
}
```

The `safeMessage` is advisory text assembled from bounded fields. Adapters must still call the runtime commands and return verifiable receipt IDs.

If no adapter can resolve the owner, output a blocked receipt with the exact missing evidence. Do not guess based on task titles or automatically remove the worktree.

## Thor and Codex integration

This section lands in the Thor repository, not this one. It is recorded here so the upstream contract stays portable and the fork-sync delta stays reviewable.

Thor should add `skills/thor-simple-changes/references/codex-thread-coordination.md` and a Site Secure orchestration path around the upstream protocol.

### Owner discovery

Preferred evidence order:

1. exact `taskRef` from the worktree claim;
2. exact worktree path recorded in Codex task metadata or recent task output;
3. exact branch plus repository identity, only when unique; and
4. user selection when ownership remains ambiguous.

Task titles and summaries are untrusted discovery hints, never sufficient proof.

### Message flow

Use the Codex task tools to:

1. list candidate tasks for the current repository;
2. read only the smallest candidate set needed to prove ownership;
3. send the bounded pause request to the exact task;
4. wait for completion or attention using a cursor-aware wait;
5. validate the returned pause receipt through the upstream runtime;
6. continue the guarded main synchronization; and
7. send the exact synchronized main SHA and resume instructions to every paused owner.

Do not create a new task when an existing owner is known. Do not send messages to unrelated tasks.

### Thor CLI routing

Add a Thor-facing command or preset such as:

```sh
pnpm thor agent coordinate-worktrees --run-id RUN --json
```

The command should route runtime evidence and produce coordination requests. Codex task API calls remain in the agent orchestration layer because the local CLI should not embed app credentials or depend on one desktop client.

### Fork maintenance

Implement and merge the platform-neutral protocol upstream first. Then use Thor's `fork-sync` workflow to compare and port:

- runtime types and commands;
- schemas;
- tests and fixtures;
- specification and reference changes; and
- any version/changelog updates required by the skill release process.

Keep only Site Secure paths, `pnpm thor` routing, and Codex-task guidance as downstream deltas.

## Upstream implementation map

Primary files:

- `skills/simple-changes/scripts/lib/worktree-coordination.ts` — claims, receipts, state transitions, atomic persistence, and path validation.
- `skills/simple-changes/scripts/lib/loop-lease.ts` — adoption and paused-change acceptance under the existing state lock.
- `skills/simple-changes/scripts/lib/types.ts` — coordination types and additive lease linkage.
- `skills/simple-changes/scripts/lib/hash.ts` — reuse the existing content-digest helpers for claim and receipt digests; do not introduce a second digest scheme.
- `skills/simple-changes/scripts/lib/path-safety.ts` — reuse canonical-path and symlink-escape validation for claim paths.
- `skills/simple-changes/scripts/lib/process.ts` — serialized Git execution for detach/attach mutations.
- `skills/simple-changes/scripts/simple-changes.ts` — CLI parsing, usage, and JSON output.
- `skills/simple-changes/evals/schemas/worktree-coordination.schema.json` — durable coordination contract.
- `skills/simple-changes/evals/schemas/loop-lease.schema.json` — optional linkage fields.
- `skills/simple-changes/scripts/lib/schema.ts` — schema registration.
- `skills/simple-changes/SPEC.md` — ownership, pause, adoption, detach, and resume guarantees.
- `skills/simple-changes/SKILL.md` — orchestration workflow and stop conditions.
- `skills/simple-changes/references/inventory-and-concurrency.md` — claims and pause/adoption procedure.
- `skills/simple-changes/references/cleanup-and-completion.md` — detach versus disposal and resume notifications.
- `README.md` — new `worktree` and `loop` command documentation next to the existing command list.

Verification files:

- `tooling/simple-changes/tests/worktree-coordination.test.ts` (new)
- `tooling/simple-changes/tests/loop-lease.test.ts`
- `tooling/simple-changes/tests/cli.test.ts`
- `tooling/simple-changes/tests/schema.test.ts`
- `tooling/simple-changes/tests/skill-contract.test.ts`
- `tooling/simple-changes/tests/security.test.ts` — no secrets, prompts, or message bodies in coordination metadata (safety invariant 12).
- `tooling/simple-changes/evals/cases.json`
- new fixtures under `tooling/simple-changes/evals/fixtures/` (the existing `worktree` and `concurrent-change` scenarios are the starting points for the incident regression)

## Safety invariants

The implementation is acceptable only if all of these remain true:

1. A paused or adopted worktree is mutation-forbidden to the controller.
2. A changed digest, HEAD, branch, path, claim owner, or common Git directory invalidates the receipt.
3. Adoption cannot hide a second active controller or a live guarded process.
4. An owner cannot acknowledge a pause for a worktree it does not currently claim.
5. A controller cannot manufacture an owner acknowledgement.
6. Dirty worktrees cannot be detached.
7. Detach cannot target the primary checkout, detached HEAD, missing branch, symlinked path, active Git operation, or conflicted checkout.
8. Detach never uses force and never deletes a branch.
9. Attach never creates a replacement branch or moves the preserved branch.
10. Resume notification occurs only after the controller's final target, status, and manifest verification succeeds.
11. Adapter failure leaves the repository blocked and unchanged.
12. Coordination metadata contains no secrets, prompts, message bodies, or human-readable task history.

## Test matrix

### Claims and ownership

- Claim a clean worktree and repeat idempotently.
- Claim a dirty worktree with a digest covering staged, unstaged, and untracked contents.
- Reject conflicting owners.
- Reject a path from another repository or a symlink escape.
- Mark a claim stale after branch, HEAD, or content changes.

### Pause and adoption

- Reproduce a worktree that appears after lease start; pause and adopt it without removing it.
- Reproduce a preserved worktree that changes after lease start; accept its exact owner pause receipt.
- Reject stale, wrong-run, wrong-owner, wrong-repository, or wrong-digest receipts.
- Confirm a second change after adoption blocks the lease again.
- Confirm adoption grants no mutation authority.
- Confirm unrelated manifest violations still prevent the lease update.

### Detach and attach

- Detach a clean worktree with two unique commits and prove the branch retains exact HEAD.
- Reject dirty, conflicted, primary, detached, or branch-mismatched worktrees.
- Reattach at the recorded path and branch.
- Reject path reuse and unexpected branch movement.
- Confirm disposal retains its stricter zero-unique-commit contract.

### Adapter behavior

- Exact task reference resolves to one owner.
- Missing task reference returns a structured manual-coordination blocker.
- Ambiguous discovery never auto-selects a task.
- Timeout or owner refusal leaves the lease unchanged.
- Resume messages include the exact canonical SHA and preserved-work disposition.

### End-to-end regression

Model the incident sequence:

1. start a lease on clean `main`;
2. create one dirty pre-existing worktree and one clean concurrent worktree with two unique commits;
3. pause both owners;
4. accept the changed preserved worktree;
5. adopt or detach the clean concurrent worktree;
6. fetch and fast-forward `main`;
7. prove exact target equality and a clean primary checkout;
8. mark both claims resume-ready; and
9. end the lease with every branch and dirty file preserved.

The test must assert object IDs and content digests before and after the sequence.

## Rollout plan

### Workspace prerequisites

- Confirm local `main` still equals `origin/main`; the reconciliation loop
  fast-forwarded both to `d5e2721` before this plan was published.
- Create an isolated implementation worktree and branch rather than editing the
  primary checkout (this plan's own protocol, applied manually).
- Re-verify the baseline before starting; the implementation map is valid only at `d5e2721` or newer.

### Phase 0 — Specification and schemas

- Add this protocol to `SPEC.md` and the concurrency reference.
- Add coordination types and schema validation.
- Add contract tests before introducing mutations.

### Phase 1 — Claims and pause receipts

- Implement atomic local persistence and CLI commands.
- Add idempotency, ownership-conflict, path-safety, and stale-receipt tests.
- Update agent guidance so every created worktree is claimed immediately.

### Phase 2 — Active-loop adoption

- Implement `loop adopt-worktree` and `loop accept-paused-change` under the existing state lock.
- Add the full unregistered-worktree deadlock regression.
- Preserve `loop allow` as the explicit user-override path.

### Phase 3 — Safe detach and attach

- Implement clean-checkout detach with branch retention proof.
- Implement exact attach and resume-ready receipts.
- Keep obsolete disposal behavior unchanged.

### Phase 4 — Thor/Codex adapter

- Add task discovery, exact-owner messaging, bounded waits, and resume notifications.
- Add Thor routing and documentation.
- Dogfood against multiple paused Site Secure worktrees.

### Phase 5 — Upstream release and fork sync

- Run upstream unit, CLI, schema, skill-contract, and eval suites.
- Bump the package from `0.6.1` to `0.7.0` (minor capability release), keep the CLI `VERSION` constant and changelog headings consistent, and verify with `simple-changes release-notes --check`.
- Author changelog entries through the repository's configured changelog workflow (`.simple-changelogs.json`); do not hand-write release text outside it.
- Release through the `publish-skill` production loop.
- Port through Thor's `fork-sync` workflow.
- Run Thor runtime and repository integration tests.
- Record the upstream revision and downstream delta receipt.

## Acceptance criteria

The project is complete when:

- a claimed concurrent worktree can be owner-paused and adopted without removal;
- a changed preserved worktree can be refreshed only from an exact owner pause receipt;
- a clean worktree with unique commits can be detached and reattached without branch movement;
- a controller can synchronize the canonical checkout while dirty paused work remains unchanged;
- Codex can contact the exact responsible task without relying on title guesses;
- every paused task receives an exact-SHA resume notification after final verification;
- all new failure modes stop before mutation and return actionable structured evidence;
- upstream tests and evals cover the complete incident sequence; and
- Thor consumes the upstream implementation with only repository- and Codex-specific deltas.

## Release and compatibility

This is an internal workflow/runtime feature. It does not change a product deployment or customer-facing application.

- Upstream package impact: minor capability release, `0.6.1` -> `0.7.0`. New commands and schemas are additive; no existing command changes behavior.
- Thor/Site Secure impact: `release:none` for the customer product.
- Existing active-loop leases remain readable through additive optional fields.
- Repositories without claims or a coordination adapter retain today's conservative blocking behavior.
- Rollback consists of disabling adoption/detach commands while leaving claims and receipts as inert local metadata; no Git history rewrite is required.

## Resolved decisions

- Build the generic protocol upstream first, then fork-sync into Thor.
- Keep vendor task APIs out of the upstream runtime.
- Require explicit owner claims; use task discovery only as a bounded fallback.
- Adopt concurrent worktrees as preserved, never mutation-authorized.
- Keep dirty worktrees in place.
- Allow detaching clean worktrees with unique commits only when branch retention is proven.
- Never automatically rebase, reset, stash, force-remove, or delete branches.
- Send resume notifications only after exact main synchronization and final verification.
