# Simple Changes does not write changelogs or choose versions

Simple Changes does not author changelog or release-note text, change version fields, keep its own patch, minor, or major policy, or parse human-readable changelog reasons to pick its next action.

## Why this is out of scope

Public release versioning and release-note authorship belong to a compatible changelog owner. Splitting that authority would let two tools disagree about one release, and parsing prose would turn wording into control flow. Simple Changes coordinates through validated request and receipt schemas instead.

## What to use instead

- Delegate to Simple Changelogs, which owns the text and the version decision and returns a receipt.
- Version approval and production authority stay separate decisions; neither implies the other.

## Decided in

The public release versioning and deploy orchestration plan's non-goals (`docs/plans/2026-08-10-public-release-versioning-deploy-orchestration.md`), implemented in `d70955c`.
