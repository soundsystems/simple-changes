# Plain-language communication

Simple Changes may coordinate complicated Git, review, release, deployment,
and cleanup state. The user usually needs the outcome and consequence, not the
names of the internal mechanisms that produced them.

## Default message shape

Write user-facing updates in this order:

1. **What happened:** state the result or current situation directly.
2. **What it means:** explain the practical consequence for the user's work.
3. **What happens next:** state the next action or the one decision needed.

Keep most commentary updates to one to three short sentences. Use familiar
words, active voice, and one idea per sentence. Prefer “I paused before changing
settings” over “the controller relinquished mutation authority.” Prefer “the
checkout is 16 commits behind” over “target divergence is 0/16.”

## Keep technical detail available, not dominant

Do not lead with controller, lease, ledger, manifest, digest, receipt,
target-contained, relinquished, mutation boundary, or guarded execution. These
terms describe implementation and audit evidence; they are rarely the user's
main concern.

Mention technical detail when it is needed to:

- identify the exact repository, branch, revision, path, environment, or
  provider the user is authorizing;
- explain why work is being preserved or why a destructive action is blocked;
- distinguish completed, failed, and still-running work;
- give a reproducible command or verification result; or
- answer a request for technical specifics.

Even then, explain the practical meaning first. Put exact IDs, commands, and
audit evidence in a short follow-up sentence or compact list. Never paste raw
JSON, a full internal state record, or a machine error when a short translation
answers the question.

When review, audit, or verification finds two or more issues, list every
finding as its own concise bullet. Do not replace the list with an abstract
count or phrases such as “several edge cases.” Lead with severity only when it
helps prioritization, and keep the concrete affected behavior in each bullet.
When a finding points to local code, make its primary file and line a clickable
Markdown link when the surface renders links; otherwise give the plain
`path:line`. Keep the bullet readable: link the main failure site and mention
supporting locations only when they help the user act.

Durable workflow status names such as `live-unreviewed` may still be required
for accurate recovery. Introduce them after the plain explanation: “The fix is
live but still needs independent review. I recorded that as
`live-unreviewed` so the next run cannot mistake it for complete.”

## Questions and blockers

Ask the smallest question that lets work continue. Start with the decision in
ordinary language, then give each option's practical consequence. Include exact
technical targets only where they prevent ambiguity. Do not make the user decode
the workflow before they can answer.

For a blocker, say what is safe, what cannot happen yet, and what resolves it.
Avoid narrating every failed internal attempt. If nothing is lost, say so.

When completed, verified work is blocked only because another task owns the
active shipment, do not end with merely “not deployed.” Say that the work is
preserved and ready, then ask:

> Do you want me to ask that agent to fold this work into the active shipment,
> or should I wait until that shipment finishes and ship this separately
> afterward?

The first choice requires explicit approval before contacting the other task.
The second keeps the work untouched until a fresh shipment can begin.

## Examples

Avoid:

> Simple Changes paused the write because the earlier MR run was safely
> relinquished, so it won’t change repository policy outside that ledger. I’m
> resuming that exact controller, applying only the confirmed policy through its
> guarded mutation path, then relinquishing it again without shipping anything.

For concurrent worktrees, describe only the operation that is actually waiting:

> Another integration step is using the short shared lock. Your other agents
> can keep editing, testing, and committing in their own worktrees; only this
> merge/push/cleanup step is waiting.

For a permission-denied state write, do not call it lock contention:

> The harness blocked Simple Changes from writing its local controller record.
> No other agent owns the lock; I’ll fix that permission boundary without
> pausing or cleaning their worktrees.

Prefer:

> I paused before changing settings because the earlier run had ended safely.
> I’m reopening that run, applying only the setting you approved, and stopping
> there—nothing will be shipped.

Avoid:

> Finalization failed because a target-contained opening worktree lacks a
> current disposition receipt.

Prefer:

> Cleanup stopped at `/Users/alex/project/.worktrees/catalog-fix` because that
> checkout may contain unique work. Your work is safe; I’ll first coordinate
> with its owner, then ask for your approval only if removal is still needed.

Avoid:

> The remote-branch reconciliation ledger has one preserved-ambiguous entry.

Prefer:

> I left `codex/catalog-fix` alone because it may contain unique work. I can
> inspect that branch in detail if you want.

## Final responses

Lead with the outcome. Report shipped, preserved, and blocked work using plain
names and practical consequences. Include proposal URLs, exact revisions,
deployment identities, decision digests, or receipt IDs only when the workflow
contract requires them or they help the user verify the result. Put dense audit
details last, under a clearly optional technical section, or omit them until the
user asks.

When a shipment finalizes or reconciles a public release, finish the delivery
summary with short **Latest customer notes** derived from the public release
notes for the exact version handled by this run. Use the finalized release
receipt or version-bound changelog section, not whichever release happens to be
newest when the response is written. Consolidate duplicates and summarize the
practical changes in two to five short notes, grouped under useful
customer-facing areas when that improves scanning. Render each customer note as
a Markdown blockquote (`>`) so it is visually distinct from the operational
shipment bullets. Do not paste the full changelog,
developer-only notes, signatures, or internal implementation detail.

Status and blockers still come first. A reconciled public release may have
customer notes even when its production deployment is blocked; state the exact
completed boundary and deployment blocker before the notes. Do not add the
section when no public release was finalized or reconciled, or when the work was
internal-only or `release:none`. Never use release-note prose to imply that a
preserved, blocked, preview-only, or unmerged unit shipped. If useful, offer the
full version-bound notes after the concise summary.
