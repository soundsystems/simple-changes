# Simple Changes does not create hosted releases

`release-tag` publishes a plain annotated Git tag on the verified release commit. Simple Changes does not create, edit, or verify a hosted release page on any Git host, such as GitHub Releases or GitLab Releases.

## Why this is out of scope

- A hosted release is a new public release-note destination with its own copy, and Simple Changelogs already requires separate authority for any release-note surface the user did not request.
- Tags are plain Git on every supported host. Hosted releases need a different API, credentials, and lifecycle on each host, and do not exist on a bare remote at all.
- Many repositories already build hosted releases from tags in CI; a published tag unblocks that without duplicating it.

## What to use instead

- The release tag itself, which any host or CI can turn into a hosted release.
- A later release could add hosted releases as an explicitly authorized Simple Changelogs destination built on the tag.

## Decided in

The release-tags design for Simple Changes 0.26.0 and Simple Changelogs 0.2.0 (section 8, 2026-10-07).
