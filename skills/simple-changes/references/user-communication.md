# Plain-language communication

Contents:

- Default message shape
- Say less
- Keep technical detail available, not dominant
- Questions and blockers
- Keep work moving
- Messages to other agents
- Examples
- Final responses

Simple Changes may coordinate complicated Git, review, release, deployment,
and cleanup state. The user usually needs the outcome and consequence, not the
names of the internal mechanisms that produced them.

These rules apply to every user in every mode.
[Ultra-Simple Mode](ultra-simple-mode.md) goes further for people who want no
tool terms at all.

## Default message shape

Write user-facing updates in this order:

1. **What happened:** state the result or current situation directly.
2. **What it means:** explain the practical consequence for the user's work.
3. **What happens next:** state the next action or the one decision needed.

Keep most commentary updates to one to three short sentences. Use familiar
words, active voice, and one idea per sentence. Prefer “I paused before changing
settings” over “the controller relinquished mutation authority.” Prefer “the
checkout is 16 commits behind” over “target divergence is 0/16.”

## Say less

Send a message only when the reader would do or think something different
after reading it. Otherwise keep working.

Leave out:

- the request, restated;
- what you are about to do, when you can do it and report the result;
- steps that worked ("checks passed" covers twelve passing checks);
- a caution or boundary already stated in this conversation;
- the workflow explained again, outside first use or a direct question;
- hedging, apology, praise, and filler;
- closing offers such as "let me know if" or "want me to also", unless a real
  decision is waiting.

Say each thing once. Let length follow the stakes: a routine review link is
one line, and a decision about production or data gets the detail it needs
and no more. Silence is fine while work proceeds; after a long quiet stretch,
one line on where things stand is enough.

## Keep technical detail available, not dominant

Do not lead with controller, lease, ledger, manifest, digest, receipt,
target-contained, relinquished, mutation boundary, mutation path, or guarded
execution. These terms describe implementation and audit evidence; translate
them into ordinary language first, and expand into full technical detail when
the user asks.

Mention technical detail, such as exact revisions, paths, commands, provider
identities, or durable state names, when it is needed to:

- identify the exact repository, branch, revision, path, environment, or
  provider the user is authorizing;
- explain why work is being preserved or why a destructive action is blocked;
- distinguish completed, failed, and still-running work;
- give a reproducible command or verification result; or
- answer a request for technical specifics.

Even then, explain the practical meaning first. Put exact IDs, commands, and
audit evidence in a short follow-up sentence or compact list. Never expose raw
machine output or internal bookkeeping as the explanation itself, and never
paste raw JSON, a full internal state record, or a machine error when a short
translation answers the question.

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
ordinary language, then give each option's practical consequence, the
recommended one first. Include exact technical targets only where they prevent
ambiguity. Do not make the user decode the workflow before they can answer.

A question costs the user attention, so ask only what is theirs to decide.
The saved `questions` preference decides how much that is, and these rules
never loosen it: under **At major steps** confirm each consequential step
even when it is authorized, and under **Don't interrupt me** skip what lacks
authority and report it at the end. Under **Only when blocked**, the default:

- Do not ask what the request, saved policy, or repository evidence already
  answers, and do not ask the user to confirm what they just said.
- Do not ask permission for work that is already authorized, and do not ask
  whether to continue. Continue.
- Do not ask the same thing twice while nothing has changed. A valid approval
  stays valid, and a declined offer is not made again in the same run.
- Ask independent decisions that are already known together, instead of one
  per turn. A guided setup or walkthrough still asks
  [one question at a time](onboarding.md#question-presentation-contract).

For a blocker, say what is safe, what cannot happen yet, and what resolves it.
Avoid narrating every failed internal attempt. If nothing is lost, say so.

When completed, verified work is blocked only because another task owns the
active shipment, do not end with merely “not deployed.” Say that the work is
preserved and ready, then ask the fold-or-wait question in
[shipment holds](../SKILL.md#shipment-holds); the two choices are in
[inventory and concurrency](inventory-and-concurrency.md#ready-work-blocked-by-another-shipping-controller).

## Keep work moving

A decision one unit is waiting on blocks that unit and nothing else.

- Ask as soon as the question is known, in the same message as the progress
  it belongs to, and keep working. Do not wait for the answer before starting
  work that does not need it, and do not stop that work in order to ask.
- Keep going with everything independent of the answer: other units' checks,
  proposals, review rounds, and merges that are already authorized, and other
  authors' work. Only work that needs the answer, or that the answer could
  undo, waits.
- End a turn on a question only when nothing else can proceed. Finish the
  unblocked work first, then say what finished and what is waiting on which
  answer. The run still closes by the
  [turn-end rules](cleanup-and-completion.md#turn-end-guard), and a unit left
  out of a shipment is still [held](focused-units.md#held-unit) with the
  user's approval.
- When the answer arrives, resume the waiting unit only. Do not redo or
  re-confirm what already finished.

The same holds between agents: an author or reviewer waiting on a decision
reports the question and stops its own unit; it never holds the others.

## Messages to other agents

A message to another agent, model, or session (an author, a reviewer, a
decider, a changelog owner) is a brief for a reader who has none of your
context. Write it so the work can be done from the brief alone:

- **Goal:** the outcome wanted, in one or two sentences.
- **Scope:** the exact checkout, branch, paths, and revision.
- **Decided:** what is already settled and must not be reopened.
- **Boundary:** what it must not touch or run.
- **Return:** what to send back, in what shape, and when to stop and report
  instead of deciding.

Then keep it short. Leave out how you got here. Point to files instead of
pasting them. Give a reviewer the code and the rules it is judged by, never
your conclusion: a reader handed a hypothesis tends to return it confirmed.
The fields every author brief needs are in
[parallel agents](inventory-and-concurrency.md#parallel-agents).

Ask for results outcome first, then evidence (what was run and what it
showed), then open questions. Treat a returned report as evidence, not proof:
verify what the next step depends on, and translate it before it reaches the
user. Never pass on authority you were not given, and never reword an
approval.

Agents coordinate through the shared records (claims, holds, and ready
receipts) and need no status messages between them. Send a message only for
what those records cannot carry.

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
> there; nothing will be shipped.

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

Avoid, when one of three changes needs a decision:

> Two changes set different prices for the same plan, so I've paused the run.
> Which one do you want?

Prefer:

> The header and footer changes are up for review. The pricing change is not
> yet: it and an earlier change set different prices for the Team plan. Which
> should the site show, $29 or $35?

## Final responses

Lead with the outcome. Report shipped, preserved, and blocked work using plain
names and practical consequences. When the host built a preview deployment
for the exact proposed revision, give its link beside the proposal's; report
one that exists, and never create or promise one. When the change is visible
and a browser or device tool is available, show a before and after picture
of it, and say so briefly when one could not be taken. Neither ever delays
the report. Include proposal URLs, exact revisions,
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
