# No automatic rebase, merge, or forced removal of another task's worktree

Simple Changes does not automatically merge or rebase dirty feature worktrees, force-remove worktrees, or delete branches as part of pause, detach, adoption, or resume.

## Why this is out of scope

Preservation is the default transition. A pause or adoption receipt binds to an exact path, HEAD, and content digest, and any edit invalidates it, so rewriting a worktree on someone else's behalf would destroy the evidence that makes coordination safe. Cleanup removes only what a proof shows is safe.

## What to use instead

- The owner releases a claim with `worktree release`, or hands off with `initialize --mode handoff`.
- `prune` and finalization remove only proven-safe worktrees, naming the containment method for each.

## Decided in

The cross-thread worktree coordination plan's non-goals (`docs/plans/2026-08-07-cross-thread-worktree-coordination.md`, commit `6238559`).
