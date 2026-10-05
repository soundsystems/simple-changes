# The runtime does not call vendor agent APIs

The Simple Changes runtime does not call Codex, Claude, IDE, or other vendor-specific APIs directly, for example to message, pause, or wake another agent session.

## Why this is out of scope

Core contracts stay forge-, database-, hosting-, and harness-agnostic. A direct vendor call would tie the runtime to one harness's availability and authentication, and an unattended call to another agent is an action no receipt could bind to exact evidence.

## What to use instead

- `worktree request` builds the adapter-shaped pause, detach, or resume message for one exact owner and sends nothing by itself; the harness or the user delivers it.
- Capability probes report what an adapter can do, so an unsupported capability is a reported blocker rather than a guessed success.

## Decided in

The cross-thread worktree coordination plan's non-goals (`docs/plans/2026-08-07-cross-thread-worktree-coordination.md`, commit `6238559`).
