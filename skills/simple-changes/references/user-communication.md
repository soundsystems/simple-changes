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

## Examples

Avoid:

> Simple Changes paused the write because the earlier MR run was safely
> relinquished, so it won’t change repository policy outside that ledger. I’m
> resuming that exact controller, applying only the confirmed policy through its
> guarded mutation path, then relinquishing it again without shipping anything.

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
