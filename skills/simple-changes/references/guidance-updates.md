# Installed guidance updates

Contents:

- Present the update
- Detect the companion update separately
- Resolve required changelog updates before a loop
- Maintain guidance versions

Treat a meaningful installed-skill update as a one-time workflow checkpoint,
not as first-use onboarding and not as changelog authoring. Pure fixes,
refactors, packaging changes, and other updates that do not materially alter
behavior, onboarding, settings, or integrations remain silent.

## Present the update

When `initialize` reports `guidanceUpdate.status: "update-available"`, pause the
write-capable run before mutation or loop creation. Do not expose internal
phrases such as “guidance update requires review.”

First inspect `requiredAnswers` and `recommendedChanges`. If
`requiredAnswers` is nonempty, ask those questions immediately, one at a time,
before asking whether the user wants any walkthrough. Every question is
multiple choice; put the recommended answer first and explain its practical
consequence in one sentence. Do not bury a required answer in release notes or
an exhaustive feature tour.

If `recommendedChanges` is nonempty, show those next under **Recommended
change** with the current and recommended answer. A recommendation is not a
mandatory answer unless it also appears in `requiredAnswers`.

Then use this short structure:

> **Simple Changes has recently been updated.**
>
> No new settings answers are required.
>
> **What matters:**
> - Up to three short, practical changes from `summaryBullets`.
>
> Your existing settings, repository files, and current work have not changed.
>
> How would you like to continue?

When no answer is required, say so plainly and recommend continuing with
current settings. The short practical bullets already provide the information
needed for that disposition. Do not recommend an exhaustive walkthrough merely
because several versions were skipped.

Offer these multiple-choice actions:

- **Continue with current settings (Recommended when nothing is unresolved):**
  Acknowledge the update and resume the original request with existing
  confirmed choices.
- **Short walkthrough (Recommended when a setting change is proposed):** Show
  required answers first, then recommended changes, then at most three practical
  improvements. Do not enumerate every intervening version.
- **Expanded walkthrough:** Explain every intervening behavior, setting,
  example, consequence, and safety boundary only when the user asks for it.
- **View detailed Simple Changes release notes:** Run the advertised read-only
  release-notes command and show the requested released section.
- **Decide later:** Leave the update unresolved so it appears again next time.
  When `requiredAnswers` is empty and the user chooses this a second time for
  the same version, record `deferred` instead so the notice stops repeating;
  the release notes remain available on request.

If no choice is required and there is no recommended setting change, it is also
acceptable to say only that Simple Changes improved behind the scenes and ask
whether the user wants the short summary, expanded walkthrough, or full release
notes. Do not manufacture a settings decision.

After the user reviews, accepts, or defers the update, record that exact choice:

```sh
simple-changes acknowledge-update \
  --guidance-decision <reviewed|accepted|deferred> \
  --json
```

Do not record a disposition because the notice was merely prepared or shown.
Resume the original request after the acknowledgement succeeds. A later
guidance version may cause one new prompt.

The acknowledgement edits only the `guidance` disposition and version in the
saved policy file. Every other byte stays as written, including consequential
settings that run with reduced authority because this clone has not confirmed
them. It never creates or renews a policy trust receipt. Repeating the decision
already recorded writes nothing, so a confirmed policy stays confirmed. A new
decision changes the bytes the receipt is bound to, so consequential settings
then run with reduced authority until setup confirms them again. When a policy
with consequential settings is unconfirmed and its receipt names the exact
bytes the edit would produce, or cannot be read, the command refuses and writes
nothing rather than risk re-enabling those settings; run setup to confirm the
policy instead. The
acknowledgement and setup save under the same short repository lock; if either
reports that state is busy, retry it after the other finishes.

If the user selects `configure-harness` or says “auto push,” give the exact
scoped-push explanation and confirmation from
[harness-aware Git push authorization](harness-push-authorization.md) before
saving. Do not translate “auto push” directly into a policy write before that
confirmation.

## Detect the companion update separately

Simple Changes owns only its workflow behavior and settings. Never describe its
update checkpoint as a changelog backfill, never inspect historical release
notes as part of accepting the Simple Changes update, and never write a
Simple Changelogs policy or release-note destination.

`changelogCoordination.guidanceUpdate` compares the selected installed
provider's declared guidance version with the repository's recorded
`.simple-changelogs.json` guidance version (or `.simple-changelogs-cms.json`
when it is the only policy present). Repository-local providers take
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

If both skills have an available update, ask any owner-controlled required
answers first. Then present both headlines and short bullets and offer one
combined multiple-choice continuation: **Continue with current settings** when
nothing remains unresolved, **Short walkthrough**, **Expanded walkthrough**,
**View full release notes**, or **Decide later**. Do not make the user answer two
overlapping update prompts, and do not recommend the expanded walkthrough by
default.

## Resolve required changelog updates before a loop

Resolve installed update choices before acquiring a loop. When the request
requires changelog work, call initialization with
`--changelog-required`. If the companion update is available, initialization
returns `preLoopActionRequired: true` and `mutationAllowed: false`.

Present the notice and obtain any required owner-controlled answer before
`loop start`. Ask that multiple-choice answer before offering **Short
walkthrough**, **Expanded walkthrough**, **Continue for now**, or **View full
release notes**. Route the answer to Simple Changelogs so that skill, not Simple
Changes, records any reviewed, declined, or deferred disposition. Then rerun
initialization.

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
