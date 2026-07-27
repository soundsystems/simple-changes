# Release notes

Forked from `simple-changelogs` @ `1a7a03a`. Simple Changes-specific deltas:
repository-maintainer scope, one read-only CLI surface, and portable
model-adapter verification. CMS-only variants and general surface-curation
machinery are intentionally omitted because Simple Changes has no selectable
or writable release-note surface to curate.

Repository-maintainer module only. Use it to classify and word Simple Changes
customer and developer history while working in this source repository. Never
package or install this module with the public `simple-changes` skill, and never
apply it to an end user's repository.

Current maintainer guidance version: 5

## Contents

- Scope and sources
- Workflow
- Public classification
- Public detail budget
- Developer history
- Reference router
- CLI rendering
- Verification

## Scope and sources

- `CHANGELOG.md` is the canonical public history.
- `skills/simple-changes/CHANGELOG.md` is its public installed-skill mirror.
- `DEVELOPER_CHANGELOG.md` preserves technical context maintainers should not
  have to reconstruct.
- The Simple Changes product renders public history through
  `simple-changes release-notes`.
- `.simple-changelogs.json` owns changelog decisions for this source repository.
- When the canonical `simple-changelogs` skill is installed, it owns general
  changelog behavior; this fork supplies only Simple Changes-specific product
  and CLI checks.

Repository instructions and stricter local release policy take precedence. Do
not invoke the public `simple-changes` skill for this work.

## Workflow

1. Inspect instructions, policy, Git evidence, changed files and diffs, recent
   history, both changelogs, package metadata, release automation, and
   established destinations.
2. Classify each outcome as public, developer, both, or neither.
3. Edit the established Markdown structure and combine related outcomes.
4. Keep pending work under a nonempty `Unreleased` section.
5. Reconcile headings, versions, the installed-skill mirror, and established
   destinations only when release intent exists.
6. Verify actual files and rendered output.
7. Report both changelog decisions, release state, version map, checks, and any
   unresolved authority or source-of-truth question.

Treat commit subjects and reported claims as context. Diffs, repository state,
and release evidence establish what changed.

## Public classification

Add durable outcomes visible to users, package consumers, integrators, or
operators:

- new commands, flags, output formats, workflows, or supported integrations;
- compatible contract additions and clearly disclosed breaking changes;
- material reliability, performance, access, safety, privacy, or data-integrity
  outcomes;
- durable interaction or error-recovery changes;
- documentation changes that alter setup, compatibility, pricing, permission,
  trust, or support obligations.

The public history is an expert CLI and skill-package archive. Include public
commands, flags, output formats, compatibility constraints, and precise
user-observable workflow changes that help agents, integrators, and maintainers
evaluate or use a release. Comprehensive means every verified
audience-relevant package change, not every commit or internal implementation
detail.

Exclude refactors, tests, linting, formatting, dependency churn, CI, build
configuration, release plumbing, and internal architecture unless they change
published behavior. Put technically important excluded work in developer
history.

For an initial-development `0.x` product, omit routine repair churn,
already-promised baseline fixes, temporary workarounds, and incidental polish.
Still disclose durable capabilities and material trust, access, compatibility,
data-loss, safety, or operator outcomes. `0.x` means initial development; a
prerelease has an explicit suffix or ecosystem marker.

## Public detail budget

Describe the visible result rather than the hidden implementation or decision
tree. Assume public notes are readable by customers, competitors, agents, and
people probing for product or security internals.

Keep these private unless they are themselves published contract:

- internal functions, packages, schemas, migrations, queues, or pipelines;
- ranking weights, thresholds, fallback order, matching or parser rules;
- moderation, fraud, recovery, permission, or enforcement heuristics;
- prompts, model choices, evaluation signals, incident detail, private vendors,
  unreleased integrations, and operational playbooks;
- blame, embarrassing root causes, raw hashes, and proof-like repair narration.

Prefer calm outcomes:

- `Added JSON release-note output for automation.`
- `Release notes can display a specific published version.`
- `The preview command now identifies unsafe repository state more clearly.`

Name new public concepts directly instead of describing a first-time capability
as “better” or “easier.” Group several related outcomes under one feature-led
heading.

## Developer history

Record architecture decisions, contracts, migrations, security boundaries,
release mechanisms, compatibility choices, operational changes, and important
test strategies when future maintainers will care.

Explain the maintainable outcome rather than dumping commits or narrating the
diff. When pending work replaces an older technical note, update it. Preserve
the obsolete statement in a final `Superseded` subsection only when the
abandoned approach remains useful context.

Keep customer and developer versions and dates aligned when they share a
release.

## Reference router

- First use, guidance prompts, signatures, missing files, or historical audit:
  [release-note setup and history](release-setup-and-history.md)
- Pending work, release intent, merge reconciliation, destinations, or version
  maps: [release lifecycle](release-lifecycle.md)
- `1.0.0`, later majors, alpha, beta, or release candidates:
  [major releases and prereleases](major-releases.md)
- Changes between stored and current guidance:
  [release guidance updates](release-guidance-updates.md)

## CLI rendering

Render the latest released Simple Changes section:

```sh
bun skills/simple-changes/scripts/simple-changes.ts release-notes
```

Select an exact version, emit JSON, or validate release consistency:

```sh
bun skills/simple-changes/scripts/simple-changes.ts release-notes \
  --version 0.1.0
bun skills/simple-changes/scripts/simple-changes.ts release-notes --json
bun skills/simple-changes/scripts/simple-changes.ts release-notes \
  --check --repo .
```

Rendering defaults to the packaged Simple Changes changelog; use `--repo PATH`
only for maintainer inspection of another checkout. The consistency check
requires an explicit `--repo PATH`. Rendering ignores `Unreleased` and HTML
comments, never exposes developer history, and fails for a missing or empty
selected release.

## Verification

- Review the final changelog diff.
- Confirm every public item is durable and stays within the detail budget.
- Confirm technical or sensitive context is absent from public output.
- Confirm pending and released boundaries are honest.
- Confirm the installed-skill mirror renders the same released section as the
  canonical root changelog.
- Confirm sources proven to share a release agree on version and date.
- Confirm signatures follow repository policy and remain absent from rendering.
- Render text and JSON output and run the consistency check.
- Run repository-native type, lint, test, evaluation, and package checks.
- Report exact checks and every intentionally skipped remote or independently
  versioned field.
