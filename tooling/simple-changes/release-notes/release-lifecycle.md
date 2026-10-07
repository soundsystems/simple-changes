# Release lifecycle

Use this reference for `Unreleased`, change proposals, release-bearing merges,
deployments, version maps, and project-native release-note destinations.

## Contents

- Establish release intent
- Non-release handoff
- Release finalization
- Merge reconciliation
- Destination scope
- Version consistency

## Establish release intent

Do not move pending entries, select a version, or synchronize destinations
merely because work touches Git, a preview, or a deployment command.

Release intent exists when:

- the user explicitly requests release, publication, finalization, or a merge
  into a proven release-bearing target;
- repository documentation, automation, or package metadata identifies the
  current action as the release boundary; or
- users directly install, consume, or deploy from the affected target.

An explicit request for the named release is enough. A branch name alone is
not.

## Non-release handoff

Before opening or updating a non-release proposal:

- re-read the final diff and pending entries;
- keep unshipped work under `Unreleased`;
- make the customer and developer changelog decisions explicit;
- do not bump versions or synchronize release destinations unless the request
  includes release preparation.

## Release finalization

Before a release-bearing push, merge, publication, or deployment:

1. Inspect the target ref and its changelogs.
2. Re-read the final diff and confirm every pending statement remains true.
3. Separate target-contained work from local or still-unshipped work.
4. Move only shipped or release-prep entries into the matching version and date.
5. Move matching developer notes when they share the release.
6. Remove empty `Unreleased` headings.
7. Synchronize only established destinations and version fields proven to
   share this release.
8. Render the public section through the repository's established surface and
   run release checks.

Merged work may remain pending only when tracked evidence establishes a separate
publication system that has not shipped it. State that evidence.

## Merge reconciliation

When integrating one or more proposals into a release-bearing target:

1. Fetch or inspect the target before merging.
2. Read both target changelogs and classify any existing pending entries by
   commit containment.
3. Reinspect the updated target after the final merge.
4. Split mixed pending sections: finalize target-contained work and retain only
   genuinely pending work.
5. Align customer and developer headings, established destinations, and
   affected version metadata.
6. Run repository-native release checks.

Do not call integration cleanup complete while a release-bearing target retains
target-contained `Unreleased` entries unless a separate release system is
documented and still pending.

This check is distinct from generic Markdown validation, which may accept a
structurally valid but stale pending section.

## Destination scope

The Simple Changes product publishes release notes through its CLI. The
installed CLI reads `skills/simple-changes/CHANGELOG.md`, a public mirror of the
canonical root `CHANGELOG.md`.

This maintainer fork operates only in the Simple Changes source repository. Do
not use it to discover or update destinations in an end user's repository.

Updating an established destination within the active release is normal work.
Creating a new UI, store, email, CMS, documentation, or operator destination is
product implementation and needs explicit current authority or documented
repository policy.

Never expose developer, security, or operational notes through a public
destination. Do not assume authentication alone authorizes an internal
audience.

## Version consistency

Build a concrete map before finalization:

- customer changelog version and date;
- installed-skill changelog mirror;
- developer changelog version and date;
- published root package or CLI version;
- affected application or package versions;
- established generated feeds or release metadata;
- tests or automation enforcing the relationship.

Update only fields proven to share the release. Do not guess remote metadata,
build numbers, or independently versioned packages.

For the Simple Changes package, run:

```sh
bun skills/simple-changes/scripts/simple-changes.ts release-notes \
  --check --repo .
```

The check must fail when the latest public release, developer release, root
package version, packaged `skills/simple-changes/CHANGELOG.md` release, and
`skills/simple-changes/SKILL.md` frontmatter `metadata.version` disagree, or
when an empty pending section exists.
