# Release-note setup and history

Use this reference for first-time adoption, guidance-version changes,
signatures, missing changelogs, historical reconstruction, and released-history
audits.

## Contents

- Policy checkpoint
- First-time adoption
- Guidance-version prompts
- Raw-Markdown signatures
- Historical reconstruction
- Released-history authority
- Audit completion

## Policy checkpoint

Keep release-note decisions in `.simple-changelogs.json`. Never put changelog
policy in `.simple-changes.json`; that file belongs to the public change
integration skill. Validate changelog policy before relying on it.

The changelog policy records:

- `developerChangelog`: `required` or `optional`;
- `signatures`: `agent-and-timestamp` or `none`;
- `newReleaseNoteSurfaces`: `ask`, `allow`, or `existing-only`.

The `guidance` object records the newest release-note guidance version for which
the repository has a disposition and the matching `backfillStatus`. Status is
one of `not-applicable`, `completed`, `declined`, `deferred`, `partial`, or
`failed`. A completed audit may still report semantic candidates intentionally
left unchanged; use `partial` only when the authorized audit itself stopped.

Policy records decisions, not discovered facts, credentials, transient release
state, or a copy of this guidance.

## First-time adoption

For a read-only question, inspect and answer without creating policy or
changelog files.

For write-capable changelog work when `.simple-changelogs.json` is absent:

1. Inspect repository instructions, existing changelogs, release automation,
   tags, package metadata, and established release-note destinations.
2. If no released history exists, create the policy at the current guidance
   version with `backfillStatus: "not-applicable"`.
3. If released history exists and the current request does not already decide
   whether to audit it, ask once before writing policy or changelog files. No
   answer is not `deferred` or `declined`.
4. Create `CHANGELOG.md` and, when policy requires it,
   `DEVELOPER_CHANGELOG.md`. Continue the original task after setup.

When pending work exists, start with a title and a nonempty `Unreleased`
section. When no entry exists, create only the title; do not leave placeholder
or empty pending sections.

If `developerChangelog` is `optional`, preserve useful technical context in the
change proposal or commit and do not create a developer history unless the user
asks for one.

## Guidance-version prompts

Current guidance applies prospectively even when historical auditing is
declined or deferred.

When stored `guidance.version` is older than the maintainer version declared in
`release-notes.md`:

1. Read the intervening entries in
   [release guidance updates](release-guidance-updates.md).
2. Explain their practical effect in ordinary language.
3. Ask once whether to audit already released history.
4. Record the newest prompted version and the actual response immediately.

For an approved audit, write `partial` before historical edits, then
`completed` after fresh verification or `failed` after a handled failure.
Resume `deferred`, `partial`, or `failed` work only after an explicit request.
A later guidance version may cause one new prompt.

Never advance the recorded version because a prompt was merely prepared or
displayed.

## Raw-Markdown signatures

When policy sets `signatures: "agent-and-timestamp"`, add one nearby comment for
each contiguous block or release section changed directly:

```html
<!-- simple-changelogs-signature agent="Example Agent" at="2026-07-23T12:00:00-05:00" -->
```

Use only runtime-exposed identity and time:

- use `unreported` when exactly one value is unavailable;
- omit the comment when both would be `unreported`;
- use an ISO 8601 timestamp with its observed offset;
- escape `&`, `"`, `<`, and `>` in attribute values;
- preserve existing signatures;
- never invent a human author, model version, time, or timezone.

Signatures are transparent audit metadata, not authorship proof. Public
renderers must ignore HTML comments generally.

When policy sets `signatures: "none"`, write no new signature comments and
preserve existing ones.

## Historical reconstruction

For a requested backfill:

1. Establish trustworthy boundaries from tags, published packages, hosted
   releases, deployment milestones, and version metadata.
2. Work through one bounded range at a time.
3. Use commit history to find candidates and inspect diffs whenever subjects do
   not establish audience impact.
4. Combine commits into shipped outcomes; omit abandoned experiments,
   reversions, incidental churn, and private incident detail.
5. Put durable architecture, migration, operational, release, and regression
   context in developer history.
6. Preserve established versions and dates. Mark uncertainty rather than
   inventing a boundary or shipped behavior.

For large histories, propose reviewable batches. Conservative omission is safer
than fabricated completeness.

## Released-history authority

Noticing drift or receiving new guidance does not authorize rewriting released
history.

An explicitly authorized audit may make deterministic repairs that preserve
meaning, visibility, and release boundaries:

- align an exact copied version or date to an unambiguous source;
- regenerate an established derived destination from its unchanged source;
- remove empty pending headings after finalization;
- remove duplicate generated output while retaining the canonical source;
- report semantic or ambiguous drift without modifying it.

Require explicit scope before deleting, materially rewording, combining,
reclassifying, changing a release boundary, or changing who can see released
information. Moving a public note into developer-only history is a visibility
change even when the text is preserved.

A current request that names the exact semantic operation already supplies that
authority; do not ask twice.

## Audit completion

Report:

- ranges and release sources inspected;
- deterministic repairs made;
- candidates left unchanged and why;
- verification performed;
- the stored guidance version and status.

Do not claim historical completeness when shallow history, missing tags,
unavailable release data, or vague commits limit the evidence.
