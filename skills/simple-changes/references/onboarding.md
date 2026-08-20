# Conversational onboarding

Use this flow when a write-capable Simple Changes request reaches a repository
without valid repository or personal preferences. Onboarding is a checkpoint
inside the original task, not a separate task. After confirmation, continue the
request without making the user repeat it.

Preview, Pause, and guarded Sync do not block for setup. On a first run, finish
their normal safe behavior and offer: **New to Simple Changes? I can give you a
quick walkthrough of everything it can do.**

## Explain before asking

Do not open with internal terms such as initialization, mutation, policy source,
or preference scope. Start by saying, in plain language:

- Simple Changes first inventories the repository, separates stable work into
  focused units, checks and reviews those units, then stops, merges, or ships
  according to the selected finish;
- Ship verifies the exact delivered revision and cleanup removes only proven
  safe objects;
- the best way to use it is natural direction such as **Put it up**, **Merge
  it**, or **Ship it**, with urgency stated when speed truly matters;
- Simple Changes has a first-use onboarding flow;
- the main ways it can be used: safe sync, queue, sweep, merge, ship, reconcile
  cleanup, preview, resume, and preservation;
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
2. **Walk me through it** — Explain every main workflow and each preference in
   plain language, one at a time, before saving anything.
3. **Customize** — Explain and ask only the unresolved preferences below, one at
   a time.
4. **Use recommended setup for this run only** — Apply the same defaults to the
   current task without writing repository or personal preferences. Onboarding
   appears again next time.

Before these choices, show one short bullet for each main natural-language use:
**Sync with main**, **Put this up**, **Open changes for everything ready**,
**Merge what's ready**, **Ship what's ready**, **Clean up the repo**, **Show me
what you would do**, **Continue**, and **Leave this work alone**. Also explain
that Simple Changes coordinates with Simple Changelogs when available but does
not author changelogs itself.

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

Then ask **How should routine Ship requests run? Choose one:**

1. **Standard shipping — Recommended** — Complete changelog and release
   reconciliation before the first production deployment.
2. **Expedited by default** — Keep focused checks, independent review, and
   merge before deployment, then complete release reconciliation, final
   verification, and cleanup immediately afterward.
3. **Break-glass by default — Advanced** — When **Deploy automatically** is also
   selected, treat an ordinary Ship request as authority to deploy one exact
   candidate before independent review after rollback is verified. Immediately
   finish focused checks, review, merge/reconciliation, final verification, and
   cleanup afterward.

Do not require a second “authorized for break-glass” phrase when saved
break-glass ordering and automatic production authority are both effective.
Native provider rollback is sufficient and does not require a blocking
pre-deploy lookup. Explicit current-request direction always overrides saved
preferences.

Then ask **Should Simple Changes configure this harness for routine repository
pushes? Choose one:**

1. **Configure this harness — Recommended for automatic Ship** — After this
   confirmation, configure the narrowest repository-scoped push permission the
   detected harness supports for the verified remote. Harness sandbox, network,
   administrator, credential, and provider policy still apply.
2. **Ask for each push** — Leave harness settings unchanged and request approval
   at each Git push boundary.
3. **Never push** — Do not request or configure push permission; stop with local
   work ready.

This preference must use the current harness's documented permission mechanism.
It never grants blanket shell access and never claims that repository policy can
override host security. Follow
[harness-aware Git push authorization](harness-push-authorization.md).
Before saving this choice, explicitly explain that it covers only ordinary
`git push` to the one verified repository/remote and does not grant credentials,
network access, force-push, branch-protection bypass, proposal/merge/deploy
authority, or another destination. Ask for confirmation after that explanation;
do not treat a bare “auto push” answer as sufficient to write policy.

Then ask **How should reviewed database migrations be handled during Ship?
Choose one:**

1. **Ask after review — Recommended** — Audit every exact pending migration,
   then confirm before applying it to the remote target.
2. **Auto-apply routine after review — Advanced** — After review, automatically
   apply only routine, reversible, bounded, lock-safe migrations to saved exact
   provider/project/environment targets.
3. **Auto-apply eligible after review — Advanced** — After review,
   automatically apply routine and other eligible safe migrations to saved
   exact targets.
4. **Never apply automatically** — Audit and report migrations, but leave every
   remote apply for a separate workflow.

Both automatic tiers review the generated/native operations before apply and
require verified backup or rollback evidence plus planned post-apply checks.
They never auto-apply destructive or data-deleting, irreversible, unbounded,
lock-heavy, target-mismatched, or unprotected changes. The routine tier also
asks before every reviewed migration classified as non-routine. The broader
eligible tier may proceed with a reviewed non-routine migration only when none
of those exclusions apply.

For either automatic tier, collect and display every exact
`provider:project:environment` target. Do not accept an automatic tier without
at least one bound target, and do not infer a target from a migration filename.

When relevant, ask **How should changelog work be handled? Choose one:**

1. **Delegate when available — Recommended when installed** — Use a compatible
   changelog skill when present; otherwise preserve and report the work.
2. **Preserve and report — Safe fallback** — Leave changelog destinations
   untouched and identify the remaining work.
3. **Ask before delegating** — Confirm before handing the changelog portion to a
   compatible skill.

Explain that Simple Changes never writes release notes itself and that this
preference grants no version, release, deployment, or publication authority.
When compatible Simple Changelogs is installed, preselect **Delegate when
available**. When changelog work is relevant but the skill is not installed or
compatible, first explain that it owns release classification and release-note
writing, then ask **Would you like me to install Simple Changelogs now?** Never
install it silently. If the user agrees, ask **When should I set up Simple
Changelogs: now, after this shipment, or later?**

- **Now:** Run its separate owner-controlled onboarding, rediscover
  compatibility, then return with delegation recommended.
- **After this shipment:** Record a follow-up and preserve current changelog
  work. If this shipment requires changelog reconciliation before it can
  complete, explain that setup must happen now or the shipment must stop at the
  safe pre-release boundary.
- **Later:** Leave the skill installed but unconfigured and preserve/report
  changelog work until the user asks to set it up.

Installation consent and setup timing grant no version, release, publication,
deployment, or data-write authority.

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

Before the main preference questions, inspect the normal private policy path.
When a saved policy exists, explain that **Global personal defaults** are a
private fallback used only when a repository has no visible team policy, then
ask **I found existing global personal defaults. Would you like to use them for
this run?** Offer:

1. **Use global personal defaults — Recommended** — Apply them to this run and
   change no preference file.
2. **Review or replace them** — Continue onboarding. If global personal storage
   is selected later, clearly state that the existing private fallback will be
   updated and overwritten.

Before asking where to save the answers, explain the storage boundary. **This
choice controls only where the workflow is remembered.** It does not expand the
current task's authority.

```text
Repository               -> <primary-checkout>/.simple-changes.json -> team policy
Global personal defaults -> private preferences.json               -> private fallback
This run                 -> no file                                -> ask next time
```

Ask **Where should these preferences live? Choose one:**

1. **This repository — Recommended for teams** — Save visible project policy
   beside the code so teammates and future agents use the same workflow.
2. **Global personal defaults** — Save a private fallback used only when a
   repository has no team policy. If one already exists, label this choice
   **Update global personal defaults** and say it overwrites that saved file.
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
- routine shipping mode when relevant;
- harness-aware Git push authorization when relevant;
- migration handling and every automatic target when relevant;
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
