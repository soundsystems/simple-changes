# Installed guidance updates

Treat a meaningful installed-skill update as a one-time workflow checkpoint,
not as first-use onboarding and not as changelog authoring. Pure fixes,
refactors, packaging changes, and other updates that do not materially alter
behavior, onboarding, settings, or integrations remain silent.

## Present the update

When `initialize` reports `guidanceUpdate.status: "update-available"`, pause the
write-capable run before mutation or loop creation. Do not expose internal
phrases such as “guidance update requires review.” Use this structure:

> **Simple Changes has recently been updated.**
>
> - Up to three short, practical changes from `summaryBullets`.
>
> Your existing settings and repository files have not been changed.
>
> Would you like me to walk you through all recent updates to the skill?

Always show the practical bullets before the choices. Recommend reviewing the
new abilities; never mark keeping settings, skipping, continuing, or deferring
as Recommended. A user cannot make an informed disposition from setting names
alone.

Explain only practical effects on Simple Changes and offer:

- **Review what changed — Recommended:** Explain every new ability first, then
  show affected settings, proposed defaults, concrete examples, consequences,
  and safety boundaries before changing anything.
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

If the user selects `configure-harness` or says “auto push,” explain and confirm
this exact consequence before saving:

> Automatic Git pushes let Simple Changes request the harness's narrowest
> persistent permission for ordinary `git push` to this one verified repository
> and remote, avoiding repeat host prompts. It does not grant credentials,
> network access, force-push, branch-protection bypass, proposal/merge/deploy
> authority, or permission for another destination. If the harness cannot
> express that exact scope, Simple Changes must keep asking. Save this setting?

Do not translate “auto push” directly into a policy write before that
confirmation. The explanation and confirmation apply across Codex, Claude Code,
and every other harness; only the harness-specific mechanism differs.

## Detect the companion update separately

Simple Changes owns only its workflow behavior and settings. Never describe its
update checkpoint as a changelog backfill, never inspect historical release
notes as part of accepting the Simple Changes update, and never write a
Simple Changelogs policy or release-note destination.

`changelogCoordination.guidanceUpdate` compares the selected installed
provider's declared guidance version with the repository's recorded
`.simple-changelogs.json` guidance version. Repository-local providers take
precedence over global providers. Treat malformed, missing, or unprovable
version evidence as `unknown`, never as an update.

When its status is `update-available`, use this structure:

> **Simple Changelogs has recently been updated.**
>
> - Up to three short, practical effects summarized from the exact intervening
>   sections of its owner-controlled `detailsPath`.
>
> Its saved settings and released history have not been changed.
>
> Would you like me to walk you through the recent Simple Changelogs updates
> before I continue?

Simple Changes may detect and announce the companion update. Simple Changelogs
owns its walkthrough, detailed notes, settings/history assessment, and recorded
disposition. If Simple Changelogs is absent, unconfigured, current, or unknown,
omit the update notice. Presence alone is not an update.

If both skills have an available update, present both headlines and their short
bullets, then ask one combined question before continuing:

> Would you like me to walk you through all recent updates to both skills?

Offer **Walk me through both**, **Simple Changes only**, **Keep my current
settings and continue**, and **View full release notes**. Do not make the user
answer two overlapping update prompts.

## Resolve required changelog updates before a loop

When the request requires changelog work, call initialization with
`--changelog-required`. If the companion update is available, initialization
returns `preLoopActionRequired: true` and `mutationAllowed: false`.

Present the notice and obtain the user's **Walk me through it**, **Continue for
now**, or **View full release notes** choice before `loop start`. Route the
choice to Simple Changelogs so that skill—not Simple Changes—records any
reviewed, declined, or deferred disposition. Then rerun initialization.

Pass `--changelog-required` to the later `loop start` command too. It is a
command-level backstop that refuses to create the loop while initialization or
a required update choice remains open.

Do not acquire a shipment lease, send the pre-ship brief, or begin the shipment
loop and later pause it for the update conversation. The update checkpoint is a
pre-loop phase. Start the loop only after initialization returns
`preLoopActionRequired: false`.

When changelog work is not required, the companion notice may be given as a
nonblocking opening update and the unrelated Simple Changes work may continue.

## Maintain guidance versions

Bump `CURRENT_GUIDANCE_VERSION` and add one closed update definition only when
an installed release materially changes Simple Changes behavior, onboarding,
settings, or companion integration. Name every newly introduced setting and
its proposed default in the definition. Do not bump guidance for pure fixes,
refactors, tests, documentation cleanup, packaging, or other changes that need
no user decision. Keep detailed release history in the established Simple
Changes changelog; the update definition contains only the practical notice.
