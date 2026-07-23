# Major releases and prereleases

Use this reference for `1.0.0`, later stable majors, next-major development
lines, and alpha, beta, or release-candidate trains.

## Establish the boundary

Resolve the canonical version owner and release convention from repository
documentation, package metadata, automation, and prior releases. Use the
ecosystem's native version parser when available.

A stable major is ready only when:

1. the canonical version crosses to a higher major;
2. the resulting version is stable;
3. explicit release intent or a documented release-bearing action exists; and
4. the affected surface participates in that version and release flow.

Names such as `v2`, `next`, or `release/2.x` are supporting evidence, not proof.
Prepare reviewed major-release copy in the proposal that establishes the stable
version when possible.

## Prerelease trains

Recognize the repository's convention, including SemVer suffixes such as
`2.0.0-beta.2` and ecosystem forms such as PEP 440 `2.0rc1`.

- Keep unpublished stabilization churn pending or in developer history.
- Give a publicly distributed preview its own clearly labeled notes when
  testers need the outcomes.
- Preserve published prerelease headings.
- Do not finalize the stable summary because a next-major branch merged or one
  prerelease shipped.
- At stable release, synthesize the durable result without repeating every
  test-cycle repair or deleting preview history.

## Synthesize from evidence

Inspect the current product, latest prior stable release, intervening
prereleases, migration and deprecation guidance, changelogs, and the diff
between proven boundaries. Current behavior overrides superseded historical
claims.

For `1.0.0`, explain the documented stability or public-contract milestone and
curate the durable capabilities built during `0.x` without pretending they all
first appeared in `1.0.0`.

For later majors, explain the transition from the latest stable prior line:
new outcomes, changed behavior, removals, compatibility effects, and required
migration. Do not retell the product's entire history.

For independently versioned packages, cover only the surface whose canonical
version crossed the boundary.

## Shape the output

Adapt to local format and include, when applicable:

1. a concise milestone or generational outcome;
2. a few feature-led public highlights;
3. breaking changes, removals, and affected audiences;
4. concrete migration or upgrade actions; and
5. one route to detailed history.

Keep implementation and maintainer-only migration context in developer history.
Comprehensive means covering durable outcomes and required action, not
concatenating every prior bullet.
