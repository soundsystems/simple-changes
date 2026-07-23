# Changelog

## 0.1.0 - 2026-07-23

- Production deployment verification now checks the complete configured set of
  canonical endpoints against the immutable deployment, rather than accepting a
  Ready artifact or one correct hostname.
- Stale provider-managed routing now follows a bounded recovery sequence that
  promotes the existing verified artifact, refreshes every endpoint, and
  reconciles only proven same-project targets without creating duplicate
  deployments or treating DNS changes as ordinary deploys.
- Multi-surface changes now carry explicit parity dispositions for related
  clients, roles, locales, and interfaces while preserving platform-native
  behavior and separate release authority.
- Requests to audit every change proposal now require complete pagination across
  relevant provider states.

- Added the portable Simple Changes skill and CLI for turning repository state
  into focused, verified change proposals while preserving paused and
  concurrent work.
- Added read-only `inventory` and `preview` commands that resolve the canonical
  primary checkout, inspect worktrees, branches, stashes, local changes, policy,
  and available delivery capabilities, then account for every changed path.
- Repeated snapshots distinguish stable work from work that appears or changes
  during a run, so active work remains preserved instead of being swept into a
  proposal.
- Added a strictly read-only `release-notes` command for displaying the latest
  Simple Changes release or a selected version in text or JSON.
- Release-note display defaults to the packaged Simple Changes changelog
  regardless of the current working directory, and an explicit `--repo` can
  inspect another checkout without changing it.
- Public release-note output omits pending `Unreleased` content, private HTML
  comments, and developer-only history.
- Maintainer consistency checking requires
  `release-notes --check --repo PATH`, making repository inspection an explicit
  choice while catching mismatched public, developer, and package releases.
- The installed skill contains no changelog-writing guidance, release behavior
  harness, or model adapters. It reports release impact for handoff but does not
  create or edit release history.
- Simple Changes can be installed alongside `simple-changelogs` without
  overlapping responsibilities: Simple Changes integrates ready work and
  displays its packaged notes, while `simple-changelogs` owns changelog
  authoring.
- Added portable Skills-directory installation and auditable guidance for
  repository-specific Simple Changes forks.
- Added provider-neutral guidance for safely classifying database and
  data-system changes, including migrations, schemas, queries, backfills,
  indexes, and projections, without granting remote-write authority.
- Added schema validation, multiline Markdown verification, human-readable and
  JSON reports, and stable exit codes.
- This initial credential-free release does not create commits, push branches,
  open or merge change proposals, deploy, apply migrations, or clean up Git
  state.
