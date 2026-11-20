# Ultra-Simple Mode

Contents:

- What it changes
- Turn it on or off
- Words
- Setup
- Questions
- Messages
- Other people's work
- Database updates
- Autopilot
- What never changes

Ultra-Simple Mode is for anyone who wants the result and not the tooling. The
person says what they want and gets a link, a short status, and a question
only when their answer changes what happens. The name describes the
experience, not the person: it suits an engineer in a hurry as well as someone
who has never used version control.

## What it changes

Two things: the words Simple Changes uses, and which optional setup questions
it asks. The inventory, checks, review, records, and every safety rule run
exactly as in the standard mode. It is a display preference, never a
permission.

Apply it whenever `initialize --json` reports `communication.style` as
`ultra-simple`, or the person asks for it in their own words ("keep it
simple", "skip the Git talk", "just give me the link").

## Turn it on or off

```sh
simple-changes setup --communication ultra-simple --scope repository --confirm
```

That writes one file, `<primary-checkout>/.simple-changes-communication.json`,
and nothing else: no policy, no trust receipt, no instruction file. Commit it
beside `.simple-changes.json` and it is the project's default: teammates get
the mode with no setup of their own, unless their own setting says
otherwise. `--scope personal` writes a private `communication.json` beside
the personal preferences instead, for this person in every project.
`--communication standard` turns it off.

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

Do not say controller, lease, loop, ledger, manifest, digest, receipt, hold,
or claim. Say what they mean for the person: "I'm still working on it", "I
kept a record", "someone else is using that right now".

**What an approval is bound to stays visible.** When the person is asked to
approve something exact, such as holding one change out of a shipment or
acting on one named target, show the exact evidence the standard mode
requires beside the plain question, revisions included. The word rule never
removes what an approval covers.

**Details.** The technical record is one word away. When the person says
"details", or asks why or how, answer that one question in the standard
mode's full terms: exact names, revisions, commands, and evidence. One
answer in detail does not turn the mode off. Mention that details exist once,
in the first reply of a conversation, and again only after a problem. Do not
end every message with it.

Proposal titles and descriptions, commit messages, and every machine-readable
record are written exactly as the standard rules say. The mode changes what
Simple Changes says to the person, not what it writes for reviewers and tools.

## Setup

The mode does not change setup. When a request that needs setup meets a
project with nothing saved, follow [onboarding](onboarding.md) as written:
the same choices, the same receipt, and the same confirmation before
anything is saved, said in this mode's words when the mode is already in
effect. Nothing is chosen for the person because the mode is on.

## Questions

Ask only when the answer changes what happens and nothing saved or said
already answers it. One question, in plain words, with the consequence of
each choice. The saved `questions` setting still governs, as
[questions and blockers](user-communication.md#questions-and-blockers) says:
**At major steps** keeps its confirmations, and **Don't interrupt me** means
work that lacks permission is skipped and reported, not asked about.

Outside setup, optional choices that would otherwise come up when they first
matter are not asked in this mode: scheduling, signatures, artifact naming,
and adding the instruction pointer or either instruction rule. Use what is
saved, or the recommended default, and save nothing. Inside setup, the path
the owner chose decides what is asked.

Everything `initialize` requires is still presented, in plain words and
before the run changes anything:

- a required answer, such as the pending review question when two or more
  agents are detected ("Who should give your changes a second look? A
  different AI tool is the safer choice.");
- an [update notice](guidance-updates.md): its required answers first, then
  any recommended change with the current and the proposed setting, then
  what matters in a line and every choice the standard notice offers, each
  under a short label of its own ("Simple Changes was updated: `<what
  matters>`. Your settings are the same. **Carry on**, **Quick tour**,
  **Full tour**, **Release notes**, or **Decide later**?");
- the one-time turn-end guard offer, in one line the person can decline.
  An offer to refresh a note in the person's own agent instruction files is
  not made in this mode: mention it only under Details.

Asked whenever saved setup and the request do not already cover it:

- putting something live;
- a database change;
- removing work that might not be saved anywhere else;
- overriding a stop another person or agent put in place;
- a choice between two real outcomes, such as two versions of the same text.

Never ask twice for the same thing while nothing has changed.

**Uploads.** When the saved setting is to ask before uploads, the person is
the one who answers, in this conversation. A request to send a change for
review, such as "put this up", is that answer for one upload: the change's
own separate copy, sent for review. Any other upload gets one plain question
first, such as "Should I send your change to the shared project? Nothing
goes live.", and no upload ever goes straight onto the main version without
a yes that names it. A prompt from the computer is extra, never a
substitute: when one may appear, say what it is in one line ("Your computer
may ask to allow an upload. That's me sending your change for review.").

**No review link.** When the project has nowhere to open a review link, a
change can be saved and sent as its own copy, and no further: do not add it
to the project, with or without [Autopilot](#autopilot), until a review
link exists or the owner says to add it without one. Say what is missing
and stop there. End that run with `loop finalize --no-proposal "<what is
missing>"`, which closes it as sent without a review link. Where the host
can open review links, a change sent without one keeps the run open
instead.

## Messages

**Progress.** One short line, only when something the person would notice has
changed: "Checking your change." "Checks passed. Getting it a second look."

**Before a merge or a go-live.** The brief keeps its standard timing and
content: it is sent before the first step that changes anything shared, it
presents the recorded scope, and it names the reviewer as the standard brief
does: the agent, its model and effort, whether it must differ from the
author, and the setting that chose it with the file it is saved in. Only the
opening changes. Lead with each change by what it does, how far it will go,
and anything left out, then give the recorded scope and the reviewer:

> I'm adding two changes to the project: the new pricing table and the footer
> fix. Sam's gallery work stays as it is. Nothing goes live.
>
> A second look comes from Codex (gpt-6.1-sol, high effort), a different
> agent from the one that wrote these. This project's review setting asks
> for that (`<path>/.simple-changes-authoring.json`).
> `<the recorded scope, as the standard brief lists it>`

It is a chance to interrupt, not a request for permission that already
exists.

**A decision.** The consequence, what you did meanwhile, and one question that
offers the safer way forward:

> This would remove saved addresses from the live store. I've left them alone.
> Should I prepare a version that keeps them?

**A problem.** What happened, what stayed safe, and the next useful step:

> I couldn't confirm the live database backup, so I didn't change the
> database. Your review link is ready.

No error codes, command output, or list of what was tried; those go under
Details.

**Delivery.** There are three finished states. Open with one of these labels
and no other, so "done" always means the same thing, then say what changed
and what was actually checked:

- **Ready for review:** "Ready for review: the new pricing table. `<link>`.
  Checks passed. Nothing is live."
- **Added to the project:** "Added to the project: the new pricing table,
  approved at `<link>`. Nothing is live yet."
- **Live:** "Live: the new pricing table, at `<address>`. `<the check that
  ran>` confirms it."

Name the check that really ran, such as opening the live page or a request to
the live service; never claim one that did not. A run that finished only part
of the request never uses a finished label for all of it. Say exactly what
did and did not happen: "The headline change is ready for review: `<link>`.
The new contact form is not: one of its checks fails, and I'm fixing it."

When the host built a preview for this exact change, add it: "Preview:
`<link>`." Report a preview that exists; never create one or promise one.
When the change is something a person can see and a browser or device tool is
available, show a before and after picture of it in the message, taken from
the preview when there is one. Say so in a few words when a picture could not
be taken; it never holds anything up.

For a merge or a go-live, the progress checklist is these four lines, ticked
as each is proven: checked, second look, added to the project, live. Add a
line for anything else the run still owes, such as release notes or
clean-up, and never report the run finished while a line is open.

**Old copies.** Each change you send for review gets its own separate copy
of the project on this computer. Once that change has been added to the
project, a later request clears the copy by itself; say nothing about it.
When it leaves one in place, pass on the line it gives, once, as written: it
says why, such as files that exist only in that copy, and where the copy is.
Remove such a copy only when the person asks.

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
only how the saved routine setting is offered. The mode itself, "ship it",
"handle it", and "do whatever it takes" are never database permission.

When a checked, low-risk database update is waiting, saved setup says to ask
(`ask-after-review`), and the request reaches that step, ask once, naming the
exact target:

> Your change needs a small database update on **`<provider>`: `<project>` /
> `<environment>`**: `<what it does, in one line>`. It's been checked and can
> be undone. Should I handle checked, low-risk updates like this on
> `<provider>`: `<project>` / `<environment>` from now on?

1. **Yes, handle them on `<provider>`: `<project>` / `<environment>`**: this
   update and later checked, low-risk, undoable ones on this one target run
   without a question, and I tell you each time one ran. Anything bigger
   still asks. Say "stop automatic database updates" to turn it off.
2. **No, leave the database alone**: keep the rest of the change moving and
   report the update as not applied.

Name all three parts of the target, because the saved permission is bound
to all three. Offer it only when the audit classed this update as routine,
the exact target was observed, and saved setup is not `never`. A yes saves the existing
`auto-apply-reviewed-routine` setting for that one
`provider:project:environment` target through `setup`, with its trust
receipt, and the update then runs through `migration decision` and
`migration apply` as usual. It never selects the wider `auto-apply-reviewed`
tier, which stays a standard-setup choice. A single one-time apply is not
part of this question: the guarded apply runs only under a saved setting.

From then on a qualifying update on that target runs without a question, is
verified, and is reported in the delivery line: "I also applied a database
update on `<provider>`: `<project>` / `<environment>` and confirmed it
worked." The same update on any other target asks.

- A request that stops at review applies nothing and offers nothing.
- A stricter saved setting or an earlier "no" wins; do not offer again in the
  same conversation.
- An update that could delete records, lock a busy table, or reach a
  different target is not applied. Say what it would do and the safer way,
  and keep the rest of the work moving.
- Out-of-date evidence, or not knowing whether older app versions still work,
  means checking again. There is no "apply anyway".
- Backfills and repairs keep their own separate permission.

## Autopilot

Autopilot is the plain name for two settings Simple Changes already has:
the **Ship when approved** finish with **Deploy automatically**. With both
saved, a request to ship is taken all the way live and confirmed live
without a question about going live. So is finished work handed over with no
other instruction, when the saved
[handoff setting](setup-and-policy.md#completed-work-handoff-checkpoint)
lets it start: after the person confirms it is ready, after they say so
themselves, or straight away when handoff is automatic. A request that asks
for less, such as "put this up", still stops where it says.

The saved shipping order decides what happens before going live, and
Autopilot does not change it. Under the standard and expedited orders the
change is checked, given a second look, and added to the project first.
Under a saved break-glass order a Ship request can go live before the second
look. Read both settings before describing Autopilot, and never promise a
second look first to a project that saved break-glass.

It is a permission, not a way of talking, so it is separate from this mode
and never part of it. Nothing turns it on by implication: not Ultra-Simple
Mode, not "ship it", not urgency. Offer it only when the owner asks for it
by name or asks for changes to go live without being asked, and say first
what it means, with the handoff line that matches the saved setting:

> With Autopilot, when you ask me to ship, I put it live once checks and a
> second look pass, without asking about going live. Finished work you hand
> me without saying how far to take it goes the same way `<after you confirm
> it's ready | once you tell me it's ready | as soon as it's built and
> checked, without asking>`. Database changes, removing work, and anything
> that looks wrong keep their own rules. Each person turns it on for their
> own computer. Turn it on for this project?

When break-glass is saved, replace the first sentence with what that order
does: "when you ask me to ship, I can put it live before the second look,
and finish the checks right after."

On yes, save those two answers through the standard `setup`, with
[the choices and confirmations](onboarding.md#customized-questions) it
requires for them, and the push setting the owner picks. Saved for a
project, it takes effect on each computer only after that person confirms
the saved setup there through `setup`, because a project file alone never
grants permission to deploy; until then that person's agent asks before going
live, as before. "Turn off Autopilot" saves **Ask me first** again.

Autopilot removes one question, the one about going live, and nothing else.
The handoff setting still decides when finished work is handed over. A
saved **At major steps** setting still confirms each major step. Database
changes follow the saved database setting and the section above. Secrets,
domains, store releases, and removing work keep their own questions.
Break-glass shipping is a different, advanced choice and is never offered
under this name.

## What never changes

- What Simple Changes may do. Turning the mode on grants no push, merge,
  go-live, database, or cleanup permission beyond what saved setup and the
  request already give.
- Checks, the second look, and the records they leave.
- Every required stop: a question the standard mode must ask is still asked
  here, in plain words. A quiet interface never skips a safety or cleanup
  question.
- Honesty about state. Blocked, partial, and failed work is named as such.
- The technical record. Receipts, exact revisions, and audit evidence are
  written as always and shown on request.
