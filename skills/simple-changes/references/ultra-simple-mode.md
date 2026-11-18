# Ultra-Simple Mode

Contents:

- What it changes
- Turn it on or off
- Words
- First use
- Questions
- Messages
- Other people's work
- Database updates
- What never changes

Ultra-Simple Mode is for anyone who wants the result and not the tooling. The
person says what they want and gets a link, a short status, and a question
only when their answer changes what happens. The name describes the
experience, not the person: it suits an engineer in a hurry as well as someone
who has never used version control.

## What it changes

Two things: the words Simple Changes uses, and how often it asks. The
inventory, checks, review, records, and every safety rule run exactly as in
the standard mode. It is a display preference, never a permission.

Apply it whenever `initialize --json` reports `communication.style` as
`ultra-simple`, or the person asks for it in their own words ("keep it
simple", "skip the Git talk", "just give me the link").

## Turn it on or off

```sh
simple-changes setup --communication ultra-simple --scope repository --confirm
```

That writes one file, `<primary-checkout>/.simple-changes-communication.json`,
and nothing else: no policy, no trust receipt, no instruction file. Commit it
beside `.simple-changes.json` and everyone working in the project gets the
mode with no setup of their own. `--scope personal` writes a private
`communication.json` beside the personal preferences instead, for this person
in every project. `--communication standard` turns it off.

Which setting applies, highest first:

1. what the person says in this conversation;
2. their personal setting;
3. the project's setting;
4. the project's Simple Changelogs setting, when Simple Changes has none;
5. standard.

A personal setting outranks the project's because the mode grants nothing. An
owner can set a project to Ultra-Simple for the team and keep full detail for
themselves with `--communication standard --scope personal`.

When a person asks for the mode in conversation, use it at once, then offer
once: **Want me to keep it this way for this project?** Save only on yes.

To prepare a project for a team: run the usual setup once (choose the finish,
and add the instruction pointer so finished work is offered for review by
itself), turn the mode on for the repository, and commit both files.

## Words

Never introduce a tool term. Use the person's own words: if they say "branch"
or "PR", so may you. Otherwise say what the thing does for them.

| Instead of | Say |
| --- | --- |
| commit | saved, a saved version |
| branch, worktree, checkout | your copy, a separate copy of the project |
| main, target branch | the project, the main version |
| merge request, pull request, proposal | review link |
| merge, integrate | add to the project |
| deploy to production, ship, release | put live, go live |
| preview deployment | preview link |
| CI, lint, typecheck, test suite | checks |
| independent review | a second look |
| conflict | two changes touch the same part |
| rebase, sync, fast-forward | update your copy with the latest |
| revert, rollback | undo |
| migration | database update |
| uncommitted, untracked, stash | unsaved work, work in progress |

Never say controller, lease, loop, ledger, manifest, digest, receipt, hold,
claim, or a revision ID. Say what they mean for the person: "I'm still working
on it", "I kept a record", "someone else is using that right now".

**Details.** The technical record is one word away. When the person says
"details", or asks why or how, answer that one question in the standard
mode's full terms: exact names, revisions, commands, and evidence. One
answer in detail does not turn the mode off. Mention that details exist once,
in the first reply of a conversation, and again only after a problem. Do not
end every message with it.

Proposal titles and descriptions, commit messages, and every machine-readable
record are written exactly as the standard rules say. The mode changes what
Simple Changes says to the person, not what it writes for reviewers and tools.

## First use

When setup is needed, the first screen is one sentence and two choices; see
[the first screen](onboarding.md#first-screen). Choosing **Use this setup**
saves the recommended setup and this mode. Before saving, show what will be
remembered and where:

> Here's what I'll remember for this project:
>
> - I stop at a review link unless you ask for more.
> - I ask before anything goes live, and before any database change.
> - I keep updates short and skip the technical terms. Say "details" any time.
>
> I'll save that in `<path>/.simple-changes.json` and
> `<path>/.simple-changes-communication.json`, so anyone working on this
> project gets the same setup. OK to save?

Use the real paths. Change the first line to match the request's finish: "I
add your change to the project once it's approved" for merge, and "I take your
change live after I ask you" for ship. Then carry on with the original
request without another setup step.

That path asks nothing else. It takes the finish from the request, saves to
the project when there is one and to personal preferences otherwise, and
leaves instruction files, agent and model choices, and review settings alone.

## Questions

Ask only when the answer changes what happens and nothing saved or said
already answers it. One question, in plain words, with the consequence of
each choice.

Not asked in this mode: which copy or base to use, agents, models, review
effort and rounds, scheduling, signatures, artifact naming, instruction-file
rules, and the turn-end guard. For each, use what is saved; where nothing is
saved, use the default the runtime already applies to an unanswered question,
and save nothing. List what was skipped once, under Details, as settings the
project owner can change in the standard setup.

An [update notice](guidance-updates.md) still stops the run once, because
the person decides whether to carry on. Shrink it to what matters and its one
question, and offer the walkthrough only if they ask: "Simple Changes was
updated: `<what matters, in a line>`. Your settings are the same. Carry on?"

Always asked, whatever the mode:

- putting something live, unless saved setup already allows it;
- a database change saved setup does not cover;
- removing work that might not be saved anywhere else;
- overriding a stop another person or agent put in place;
- a choice between two real outcomes, such as two versions of the same text.

Never ask twice for the same thing while nothing has changed, and never ask
for something the request or saved setup already allows. When the computer
itself asks to allow an upload, say what it is in one line: "Your computer
will ask to allow an upload. That's me sending your change for review."

## Messages

**Progress.** One short line, only when something the person would notice has
changed: "Checking your change." "Checks passed. Getting it a second look."

**Before a merge or a go-live.** One short message names each change by what
it does, says how far it will go, and names anything left out. It is a chance
to interrupt, not a request for permission that already exists:

> I'm adding two changes to the project: the new pricing table and the footer
> fix. Sam's gallery work stays as it is. Nothing goes live.

**A decision.** The consequence, what you did meanwhile, and one question that
offers the safer way forward:

> This would remove saved addresses from the live store. I've left them alone.
> Should I prepare a version that keeps them?

**A problem.** What happened, what stayed safe, and the next useful step:

> I couldn't confirm the live database backup, so I didn't change the
> database. Your review link is ready.

No error codes, command output, or list of what was tried; those go under
Details.

**Delivery.** There are three finished states. Use these words for them and
no others, so "done" always means the same thing:

- **Ready for review:** "Ready for review: `<link>`. Checks passed. Nothing is
  live."
- **Added to the project:** "Approved and added to the project: `<link>`.
  Nothing is live yet."
- **Live:** "Live: `<address>`. I opened the live site and it shows your
  change."

A run that finished only part of the request never uses those lines alone.
Say exactly what did and did not happen: "Your headline change is ready for
review: `<link>`. The new contact form is not; it needs a database update I
haven't been allowed to make."

When the host built a preview for this exact change, add it: "Preview:
`<link>`." Report a preview that exists; never create one or promise one.

For a merge or a go-live, the progress checklist is these four lines, ticked
as each is proven: checked, second look, added to the project, live.

## Other people's work

Say it once when other work is found, then leave it alone: "Sam's unfinished
work is still there, untouched. I only sent yours." Never ask the person to
sort out the state of the project; that is the tool's job.

When two finished changes disagree about the same thing, keep both and ask
about the outcome, not the mechanics:

> You and Sam both changed the homepage headline. I kept both and didn't pick
> one. Which should the site use: yours ("Book a free call") or Sam's ("Talk
> to us today")?

"Is my work saved?" has three honest answers; give the one that is true: on
this computer only, sent for review, or live.

"Undo that" means a new change that reverses the old one, sent for review
like any other: "I've prepared an undo: `<link>`. Nothing changes until it's
approved." It never means rewriting history.

## Database updates

Database rules are the ones in
[high-risk actions](migrations-and-high-risk-actions.md); this mode changes
only how the existing approval is asked. The mode itself, "ship it", "handle
it", and "do whatever it takes" are never database permission.

When a checked, low-risk database update is waiting, saved setup says to ask
(`ask-after-review`), and the request reaches that step, ask once, naming the
exact target:

> Your change needs a small database update on **`<project>` /
> `<environment>`**: `<what it does, in one line>`. It's been checked and can
> be undone. Apply it?

1. **Yes, this once**: apply this update and ask again next time.
2. **Yes, and handle updates like this for `<project>` / `<environment>` from
   now on**: checked, low-risk, undoable updates on this one target run
   without a question, and I tell you each time one ran. Anything bigger
   still asks. Say "stop automatic database updates" to turn it off.
3. **No, leave the database alone**: keep the rest of the change moving and
   report the update as not applied.

Offer choice 2 only when the audit classed this update as routine, the exact
target was observed, and saved setup is not `never`. Choosing it saves the
existing `auto-apply-reviewed-routine` setting for that one
`provider:project:environment` target through `setup`, with its trust receipt,
and then applies the update through `migration decision` and `migration
apply` as usual. It never selects the wider `auto-apply-reviewed` tier, which
stays a standard-setup choice.

From then on a qualifying update on that target runs without a question, is
verified, and is reported in the delivery line: "I also applied a database
update on `<project>` / `<environment>` and confirmed it worked." The same
update on any other target asks.

- A request that stops at review applies nothing and offers nothing.
- A stricter saved setting or an earlier "no" wins; do not offer again in the
  same conversation.
- An update that could delete records, lock a busy table, or reach a
  different target is not applied. Say what it would do and the safer way,
  and keep the rest of the work moving.
- Out-of-date evidence, or not knowing whether older app versions still work,
  means checking again. There is no "apply anyway".
- Backfills and repairs keep their own separate permission.

## What never changes

- What Simple Changes may do. Turning the mode on, or choosing **Use this
  setup**, grants no push, merge, go-live, database, or cleanup permission
  beyond what saved setup and the request already give.
- Checks, the second look, and the records they leave.
- Every required stop: a question the standard mode must ask is still asked
  here, in plain words. A quiet interface never skips a safety or cleanup
  question.
- Honesty about state. Blocked, partial, and failed work is named as such.
- The technical record. Receipts, exact revisions, and audit evidence are
  written as always and shown on request.
