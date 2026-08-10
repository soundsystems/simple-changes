# Installed guidance updates

Treat a meaningful installed-skill update as a one-time workflow checkpoint,
not as first-use onboarding and not as changelog authoring. Pure fixes,
refactors, packaging changes, and other updates that do not materially alter
behavior, onboarding, settings, or integrations remain silent.

## Present the update

When `initialize` reports `guidanceUpdate.status: "update-available"`, pause the
write-capable run before mutation and translate the structured changes into a
short user-facing notice. Explain only practical effects on Simple Changes and
offer:

- **Review Simple Changes settings:** Show the affected settings and proposed
  values before changing them.
- **Keep current Simple Changes settings:** Preserve the current choices and
  accept defaults only for newly introduced fields after naming them.
- **Skip for this version:** Preserve current behavior and record the update as
  deferred so the same version does not prompt again.
- **View detailed Simple Changes release notes:** Run the advertised read-only
  release-notes command and show the requested released section.

After the user reviews, accepts, or defers the update, record that exact choice:

```sh
simple-changes acknowledge-update \
  --guidance-decision <reviewed|accepted|deferred> \
  --json
```

Do not record a disposition because the notice was merely prepared or shown.
Resume the original request after the acknowledgement succeeds. A later
guidance version may cause one new prompt.

## Keep changelog ownership separate

Simple Changes owns only its workflow behavior and settings. Never describe its
update checkpoint as a changelog backfill, never inspect historical release
notes as part of accepting the Simple Changes update, and never write a
Simple Changelogs policy or release-note destination.

When the notice reports `changelogHandoff.available: true`, offer a separate
**Review with Simple Changelogs** action. Explain that Simple Changelogs owns the
assessment of its settings and existing release notes. Delegate only if the
user selects that action and the provider passes normal capability negotiation.
If Simple Changelogs is absent, omit the action entirely. Its absence never
blocks acknowledgement of the Simple Changes update.

## Maintain guidance versions

Bump `CURRENT_GUIDANCE_VERSION` and add one closed update definition only when
an installed release materially changes Simple Changes behavior, onboarding,
settings, or companion integration. Name every newly introduced setting and
its proposed default in the definition. Do not bump guidance for pure fixes,
refactors, tests, documentation cleanup, packaging, or other changes that need
no user decision. Keep detailed release history in the established Simple
Changes changelog; the update definition contains only the practical notice.
