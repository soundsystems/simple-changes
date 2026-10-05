# Simple Changes is not a general task scheduler

Simple Changes integrates finished Git work: it inventories it, packages it into proposals, verifies, merges, deploys, and cleans up. Requests to make it assign, start, or queue arbitrary agent work are out of scope.

## Why this is out of scope

The controller lease grants authority to preserve and account for work, not to create it. Adoption never grants mutation authority over another task's worktree, and ownership must be claimed explicitly by the task doing the work. A scheduler would have to decide what work exists and who does it, which is exactly the authority the coordination model withholds.

## What to use instead

- A harness scheduler (cron, routines, or a loop) can invoke Simple Changes on a cadence.
- Within a run, `prepare-agent` already hands each independent, known unit to its own isolated author.

## Decided in

The cross-thread worktree coordination plan's non-goals (`docs/plans/2026-08-07-cross-thread-worktree-coordination.md`, commit `6238559`), implemented in `962f533`.
