# Conversational onboarding

Use this flow when a write-capable Simple Changes request reaches a repository
without valid repository or personal preferences. Onboarding is a checkpoint
inside the original task, not a separate task. After confirmation, continue the
request without making the user repeat it.

## Explain before asking

Do not open with internal terms such as initialization, mutation, policy source,
or preference scope. Start by saying, in plain language:

- Simple Changes has a first-use onboarding flow;
- why it appeared now;
- which parts of future work it controls;
- what the current request already decided;
- what the recommended defaults are; and
- that nothing has been pushed, merged, deployed, or saved yet.

Summarize concrete evidence: the repository path, the finish implied by the
request, whether changelog surfaces and a compatible changelog workflow were
found, whether multiple UI artifacts are relevant, and the exact instruction
file that could receive a pointer. Do not ask for a decision already supplied by
the request or proven repository policy.

## Question presentation contract

Onboarding is for the repository owner, not an implementation quiz. Ask one
question at a time unless two choices are inseparable. Each question must first
explain what is being decided and why it matters. Present a numbered,
choose-one list in which every option includes:

- a short outcome label;
- **Recommended** on the evidence-backed default;
- what Simple Changes will do;
- what the user or team will experience; and
- the important boundary or tradeoff.

Accept the option number or label. Do not lead with enum values, policy field
names, framework jargon, an unexplained yes/no prompt, or language such as
“before I mutate Git.” Show stored values only as secondary receipt detail when
it helps an expert verify the result.

Use a compact text diagram when a choice changes workflow reach, write scope,
audience, or data flow. Label both the active and stopped path. Skip diagrams
when one sentence is clearer.

## First screen

Show the recommended workflow for the current request before asking the first
question. For example:

```text
ready work -> focused proposal -> checks -> STOP for review
```

Then ask **Simple Changes can set up the workflow before continuing. Choose
one:**

1. **Use recommended setup — Recommended** — Use the finish implied by the
   current request, ask only when blocked, keep production behind confirmation,
   preserve changelog work for its owning workflow, and save visible repository
   policy when a repository exists. Show a full receipt before writing.
2. **Customize** — Explain and ask only the unresolved preferences below, one at
   a time.
3. **Use recommended setup for this run only** — Apply the same defaults to the
   current task without writing repository or personal preferences. Onboarding
   appears again next time.

Outside Git, the recommended durable scope is private personal preferences
because repository policy is unavailable. An explicit current request always
overrides a recommendation.

## Customized questions

Before the finish choice, show all three paths:

```text
Review: ready work -> proposal -> checks -> STOP for review
Merge:  ready work -> proposal -> checks -> approval -> merge -> STOP
Ship:   ready work -> proposal -> checks -> approval -> merge
        -> authorized deploy -> live verification
```

Ask **How far should I usually take ready work? Choose one:**

1. **Put it up for review** — Create focused proposals, run checks, and stop.
2. **Merge when approved** — Also merge the exact revision after checks and
   required reviews pass.
3. **Ship when approved** — Also deploy authorized targets and verify the live
   result.

Mark the current request's finish **Recommended**. Explain that this is a normal
finish line, not blanket permission for high-risk operations.

Only for Ship, ask **What should happen with production? Choose one:**

1. **Ask me first — Recommended** — Merge automatically, then confirm before a
   production deployment.
2. **Deploy automatically** — Deploy when repository rules and all normal
   release checks allow it.
3. **Never deploy production** — Stop after merge or an authorized preview.

When relevant, ask **How should changelog work be handled? Choose one:**

1. **Delegate when available** — Use a compatible changelog skill when present;
   otherwise preserve and report the work.
2. **Preserve and report — Safe default** — Leave changelog destinations
   untouched and identify the remaining work.
3. **Ask before delegating** — Confirm before handing the changelog portion to a
   compatible skill.

Explain that Simple Changes never writes release notes itself and that this
preference grants no version, release, deployment, or publication authority.

Ask UI artifact naming only when several screenshots, design exports, static
previews, or similar iterations will be saved and no repository convention
already decides it. Explain that this does not name source files, Git revisions,
deployments, packages, or releases.

Ask **When should I ask for permission or help? Choose one:**

1. **Only when blocked — Recommended** — Continue through already-authorized
   work and interrupt only for a decision that is genuinely required.
2. **At major steps** — Confirm before consequential workflow steps even when
   they are otherwise authorized.
3. **Don't interrupt me** — Skip anything that lacks authority and report it at
   the end.

## Preference storage

Before asking where to save the answers, explain the storage boundary. **This
choice controls only where the workflow is remembered.** It does not expand the
current task's authority.

```text
This repository  -> <primary-checkout>/.simple-changes.json -> team policy
All repositories -> private preferences.json               -> personal fallback
This run only    -> no file                                -> ask again next time
```

Ask **Where should these preferences live? Choose one:**

1. **This repository — Recommended for teams** — Save visible project policy
   beside the code so teammates and future agents use the same workflow.
2. **All my repositories** — Save private personal defaults used only when a
   repository has no policy of its own.
3. **This run only** — Write no preference file and ask again next time.

Repository policy overrides personal preferences; the current request overrides
both. Name the exact path in the question or adjacent explanation. Use
placeholders only when the runtime genuinely cannot resolve a path.

After durable scope is known, offer an existing exact instruction file. Explain
that the short managed pointer makes completed implementation discover Simple
Changes automatically; it does not copy this skill's rules or grant new
authority. Never create an instruction file, follow a symlink, or add a second
managed block.

## Confirm, apply, and continue

Before writing, show a plain-language receipt containing:

- the exact ready-work path and stopping point;
- production behavior when relevant;
- changelog behavior when relevant;
- UI artifact naming when relevant;
- when the user will be interrupted;
- the exact preference path, or that no file will be written;
- the exact instruction-pointer target and managed block, when selected; and
- the high-risk operations that still require explicit exact-target authority.

Ask for confirmation only after displaying the receipt. If confirmed, apply the
selected setup and state exactly what was written. If declined, write nothing.
Then continue the original request without another setup gate.

In a non-TTY agent runtime, `initialize --json` is only the machine-readable
handshake. The agent must present this same conversational flow in chat and pass
the explicit answers to `setup`. Never expose the raw handshake as though it
were the onboarding question.
