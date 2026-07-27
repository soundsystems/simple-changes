# Release-note guidance updates

Repository-maintainer module only. The canonical `simple-changelogs` skill owns
general guidance. This local record preserves the Simple Changes fork's
interpretation without creating another discoverable skill.

## Guidance 1

Established paired customer and developer histories, durable-outcome
classification, honest pending/released boundaries, and evidence-based version
alignment.

## Guidance 2

Moved durable changelog decisions into `.simple-changelogs.json`, added
configurable raw-Markdown signatures and resumable historical-audit status,
separated release-note destinations from canonical history, clarified `0.x`
versus explicit prereleases, and added deterministic fork/evaluation helpers.

## Guidance 3

Added stable-major synthesis and separated next-major development or
prerelease trains from stable-major finalization. Preserve published preview
history when synthesizing a stable release.

## Guidance 4

Separated complete customer history from compact announcements. Durable,
identifiable product polish may remain in `CHANGELOG.md` even when it is too
minor for a short announcement; incidental cosmetic churn remains omitted.

## Guidance 5

Added evidence-based expert public release notes so the established Simple
Changes CLI and skill-package archive retains public commands, compatibility
details, and narrow workflow changes its technical audience needs without
copying internal developer history.

Added destination-level scope verification. This repository has one public
release-note destination: `skills/simple-changes/CHANGELOG.md`, rendered by the
installed CLI from the canonical customer history. Web, mobile, store, CMS, and
internal product-surface curation remain not applicable.

The released `0.1.0` history was audited against this guidance. Its public CLI
and package details match the expert audience, its developer-only architecture
remains private, and no meaning or visibility changes were required.

The later `simple-changelogs` skill-repository setup update is also portable:
initial adoption now recommends a complete accessible-history backfill, asks
last whether to defer or decline it, and records completion only after every
range and established mirror is accounted for. Product archive design,
component selection, web/mobile feed placement, CMS, and store workflows remain
not applicable because Simple Changes exposes one read-only packaged archive
and no writable product surface.

When moving between guidance versions, summarize the applicable entries and
record one honest historical-audit disposition. Current guidance applies
prospectively regardless of that disposition.
