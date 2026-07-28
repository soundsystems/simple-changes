# Simple Changes onboarding and automatic handoff plan

**Date:** 2026-07-27
**Status:** Proposed
**Scope:** Personal defaults, repository onboarding, technology expectations,
repository-instruction pointers, and automatic post-implementation handoff

## Outcome

Expand Simple Changes onboarding so a globally installed skill can learn
portable user preferences without confusing those preferences with facts about
an individual repository.

The completed design should:

1. capture the user's normal change-integration workflow;
2. optionally capture fallback technology and deployment preferences;
3. inspect each repository before asking repository-specific questions;
4. offer an explicit, short Simple Changes pointer in an always-loaded
   repository-instruction file;
5. ask when agents should hand completed implementation work to Simple Changes;
6. support an automatic post-implementation handoff without turning every agent
   completion into an implicit production deployment; and
7. preserve the existing authority boundaries for production, data changes,
   secrets, DNS, store releases, and history rewrites.

## Design principles

### Separate preference, evidence, and authority

Use three layers:

| Layer | Purpose | Examples |
| --- | --- | --- |
| Personal defaults | Portable fallback preferences | Preferred package managers, common deployment providers, normal proposal behavior |
| Repository policy and evidence | Facts and team decisions for one repository | Lockfiles, CI, review rules, deployment project, instruction pointer |
| Current-run authority | Exact authorization for consequential operations | Production deployment, remote migration, secret change, DNS edit |

Precedence remains:

1. the current user request;
2. repository policy and repository instructions;
3. personal defaults;
4. safe defaults.

Repository evidence always wins over a personal technology preference. A
personal preference is used only when the repository leaves a genuine choice.

### Keep the skill stack-neutral

Simple Changes should discover the current stack and compose relevant provider
or framework guidance. It should not embed a broad tutorial for every framework
or deployment platform.

Technology-specific references should cover operational contracts that must be
reliable, such as:

- project and environment discovery;
- immutable revision matching;
- readiness evidence;
- promotion versus rebuild semantics;
- canonical target discovery;
- smoke verification; and
- bounded recovery from stale provider-managed targets.

General framework implementation should remain the model's responsibility or
be delegated to a discovered specialized skill.

### Store hints, never invented facts

Personal technology preferences are hints. They must never be treated as proof
that a repository uses a provider, account, project, environment, domain, or
deployment topology.

Do not store:

- credentials or tokens;
- account or team secrets;
- derived provider project IDs;
- repository identifiers in a personal profile;
- transient branch names;
- environment-specific URLs or domains; or
- standing authority for high-risk operations.

### Use progressive disclosure

Do not turn first use into an unconditional long questionnaire.

Offer:

- **Use recommended setup** — apply safe, evidence-backed defaults and show the
  receipt;
- **Customize** — ask only questions not already answered by the request,
  repository evidence, or saved preferences; and
- **Use these preferences for this run only** — write no durable state and
  explain that onboarding may appear again.

Production, changelog, technology, deployment, and repository-instruction
questions remain conditional.

## Onboarding architecture

### Personal setup

Personal setup can run outside a Git repository:

```sh
bun skills/simple-changes/scripts/simple-changes.ts setup --scope user
```

It records portable workflow defaults and optional technology hints. It cannot
write repository instructions because no repository is in scope. After the user
chooses personal scope, it may separately offer a short pointer in an existing
global, always-loaded agent-instruction file. If no global instruction file
exists, report that fact and move on without creating one.

Personal setup should no longer write the repository-policy schema directly.
Introduce a separate personal-preferences contract so personal-only technology
hints do not leak into `.simple-changes.json`.

Suggested shape:

```json
{
  "schemaVersion": 2,
  "guidance": {
    "version": 2
  },
  "workflow": {
    "ambiguousScope": "current-task",
    "changelogHandling": "preserve-and-report",
    "defaultFinish": "open-change-request",
    "permissionPrompts": "blocking-only",
    "progressUpdates": "milestones",
    "productionDeploy": "ask",
    "proposalState": "ready-when-verified",
    "reviewFallback": "independent",
    "workspaceIsolation": "adaptive"
  },
  "technology": {
    "preferred": {
      "packageManagers": [],
      "runtimes": [],
      "frameworks": [],
      "dataPlatforms": [],
      "ciPlatforms": [],
      "deploymentPlatforms": []
    },
    "deliveryPath": "repository-or-provider-native",
    "missingDeployment": "report"
  }
}
```

The arrays contain normalized user-provided hints. Treat them as untrusted
data: never interpolate them into shell commands and never use them to select
an account, project, or production target.

### Repository activation

A valid personal profile should prefill repository onboarding, not erase the
distinction between personal defaults and repository policy.

On the first write-capable use in a repository without
`.simple-changes.json`, offer:

- **Use my defaults for this repository** — create a visible repository policy
  from the applicable workflow defaults, after confirmation;
- **Customize this repository** — ask only unresolved repository workflow
  questions; or
- **Use my defaults for this run only** — write no policy or instruction
  pointer and explain that repository onboarding can appear again.

Ask about the instruction pointer only after preference scope is known. For
repository scope, target the repository's instruction file. For personal scope,
target the user's existing global instruction file. Run-only scope never offers
or writes a pointer.

Read-only preview and pause modes must not start personal or repository
onboarding.

### Existing policies

Keep legacy policies readable. Normalize guidance version 1 into safe version 2
defaults in memory, then use a one-time guidance-update prompt before durable
writes.

The version 2 update should explain:

- the new repository-instruction pointer;
- the new handoff-timing choice;
- the split between permission prompts and progress updates; and
- any newly stored workflow defaults.

Do not silently add or edit an instruction file during migration.

## Workflow questions

The customized flow should ask only unresolved questions, in this order.

### 1. How far should I usually take ready work?

- **Put it up for review** — Create focused proposals, run checks, and stop.
- **Merge when approved** — Also merge after checks and required reviews pass.
- **Ship when approved** — Also deploy and verify merged work when separately
  authorized.

Use the current request to prefill this answer.

### 2. When my request is ambiguous, what work should I treat as in scope?

- **The current task only** — Recommended. Inventory other work, but package
  only the outcome attributable to the current task.
- **All stable work in the repository** — Include ready work found across
  branches and worktrees.
- **Ask before expanding** — Stop for confirmation when more than one plausible
  unit is found.

Automatic post-implementation handoff always defaults to **The current task
only**, even when a broader personal preference exists, unless repository policy
explicitly says otherwise.

### 3. How should I work around an active checkout?

- **Choose the safest workspace automatically** — Recommended. Use the current
  checkout when safe and isolate packaging work when concurrent or uncertain
  work exists.
- **Always use an isolated worktree** — Keep packaging work away from the
  user's active checkout.
- **Use the current checkout when possible** — Avoid a new worktree unless
  preservation requires one.

All options retain the non-negotiable preservation rules.

### 4. How should new proposals enter review?

- **Ready when verified, draft when blocked** — Recommended. Open a ready
  proposal after applicable checks pass and a draft when known work remains.
- **Always start as a draft** — Require a later explicit promotion.
- **Follow repository convention** — Use proven team or provider convention,
  with a draft fallback when evidence is missing.

### 5. When repository rules are silent, what approval is enough to merge?

- **Independent human approval** — Recommended. Do not treat passing CI alone
  as merge approval.
- **Provider mergeability rules** — Merge when the current revision satisfies
  every configured provider requirement.
- **Passing checks are sufficient** — Allow a checks-only merge only when no
  repository or provider rule requires review.

Repository protection and explicit review policy always override this fallback.

### 6. How much progress communication do you want?

- **Milestone updates** — Recommended. Report packaging, proposal, approval,
  merge, and deployment transitions.
- **Only blockers and completion** — Keep routine progress quiet.
- **Detailed updates** — Explain checks, grouping decisions, and provider state
  while working.

Keep this separate from permission behavior. A preference for fewer status
updates never suppresses a required authority question.

### 7. When should I ask for a decision or additional permission?

- **Only when blocked** — Continue independent authorized work and ask only
  when a decision is genuinely required.
- **At major steps** — Confirm before consequential workflow transitions.
- **Do not interrupt me** — Skip operations that lack authority and report them
  afterward.

Rename the stored field from the ambiguous `questions` concept to
`permissionPrompts`. Continue to require exact authorization for operations
whose authority cannot be skipped or inferred.

### 8. Conditional production and changelog questions

Retain the existing production question only when shipping is selected. Retain
the changelog-coordination question only when a compatible skill or changelog
surface is discovered.

## Optional technology profile

Ask:

> Would you like to save fallback technology preferences for repositories that
> do not already establish them?

- **Use repository discovery only** — Recommended safe default. Make no
  technology assumption when evidence is absent.
- **Record my usual defaults** — Ask the optional questions below and use the
  answers only at genuine choice points.
- **Use defaults for this run only** — Keep any answers out of durable personal
  state.

When customization is selected, collect optional text for:

- package managers;
- runtimes;
- frameworks;
- data platforms;
- CI platforms; and
- deployment platforms.

The prompt should say explicitly:

> Name the technologies you normally prefer when a repository has not already
> chosen. These are fallback hints, not instructions to replace an existing
> lockfile, framework, provider, or deployment configuration.

### Deployment expectations

Ask:

> When a repository does not define its delivery path, what workflow should I
> expect?

- **Repository or provider native** — Recommended. Discover and follow the
  established Git-connected, artifact, image, edge, or self-hosted flow.
- **Preview, then production after merge** — Prefer a verified proposal preview
  and production only after integration.
- **Staging before production** — Require a verified staging step before
  production.
- **Ask for each repository** — Establish the path during repository
  activation.

Then ask:

> If a repository has no deployment configuration, what should I do?

- **Report what is missing** — Recommended. Do not introduce infrastructure as
  part of a change-integration task.
- **Recommend a setup** — Suggest the preferred provider and required work
  without creating it.
- **Offer a separate setup task** — Ask for explicit authorization before
  configuring a provider, resources, keys, or environments.

Do not make deployment verification optional. Every completed deployment still
requires the intended immutable revision, provider readiness, complete
canonical-target coverage, and focused verification of the changed journey.

## Repository-instruction pointer

Model this on the Simple Changelogs repository-instruction pointer:

- inspect before asking;
- name the exact file;
- show the proposed pointer in the confirmation receipt;
- require explicit confirmation;
- write a pointer, not a copy of the skill;
- update an existing managed pointer in place;
- never append a duplicate block; and
- leave instruction files unchanged when declined.

The current Simple Changelogs source establishes this as an onboarding guidance
contract rather than a reusable pointer-writing API. Simple Changes should
mirror its scope and safety behavior, but implement and test its own
deterministic writer instead of assuming shared code exists.

Ask about the pointer after preference scope and target the selected scope:

- **Repository scope** offers the repository's existing, always-loaded
  instruction file.
- **Personal scope** offers the user's existing global instruction file.
- **Run-only scope** writes nothing and asks no pointer or handoff-timing
  question.

Treat the global instruction file as the higher-consequence target because it
affects every repository in that agent environment, including repositories
that do not use Simple Changes.

### Instruction-file discovery

For repository scope, inspect the canonical primary checkout and identify
repository-wide, always-loaded instruction candidates.

Recommended order:

1. root `AGENTS.md`;
2. an existing repository-designated instruction file;
3. root `CLAUDE.md` or another proven always-loaded runtime instruction file.

If multiple candidates conflict, ask which exact file to update. Do not write
the pointer to every candidate automatically.

For personal scope, inspect only the current runtime's established global
instruction location. Do not guess a path or search for arbitrary similarly
named files.

When the chosen scope has no existing instruction file, say so and move on.
Do not create `AGENTS.md`, `CLAUDE.md`, or a global instruction file as part of
this prompt.

### First pointer question

When the chosen scope has an existing instruction file:

> Should I add a short Simple Changes instruction to `<exact-path>`?

- **Add the pointer** — Recommended. Agents will know when to load Simple
  Changes without duplicating its workflow rules.
- **Leave instructions unchanged** — Save no pointer and rely on explicit user
  requests or runtime skill discovery.

Never write to an agent-instruction file without explicit confirmation. The
receipt must distinguish a repository target from a global target and explain
the wider effect of the global edit.

### Handoff-timing question

Ask this immediately after the user chooses to add the pointer:

> When should agents hand completed work to Simple Changes?

- **Automatically after implementation** — After an agent completes and
  verifies its assigned implementation work, invoke Simple Changes and continue
  only to the finish point authorized by the current request and applicable
  policy.
- **When I say the work is ready** — Recommended safe default. Leave completed
  work in place until the user asks to put it up, merge it, ship it, finish it,
  or reconcile the repository.

This wording is preferable to “trigger automatically” because it explains the
event, the scope, and the resulting workflow boundary.

Do not ask the handoff-timing question when the user leaves repository
instructions unchanged; without a durable pointer, the choice would imply a
reliability the setup did not establish.

### Pointer templates

Use managed markers so rerunning setup updates the block in place.

Repository automatic handoff:

```md
<!-- simple-changes:start -->
After an agent completes and verifies assigned implementation work, use the
`simple-changes` skill to inventory and hand off that completed work according
to the current request and `.simple-changes.json`.
<!-- simple-changes:end -->
```

Repository user-signaled handoff:

```md
<!-- simple-changes:start -->
When the user indicates that completed work is ready to put up, merge, ship,
finish, or reconcile, use the `simple-changes` skill and follow the current
request and `.simple-changes.json`.
<!-- simple-changes:end -->
```

Global automatic handoff:

```md
<!-- simple-changes:start -->
After an agent completes and verifies assigned implementation work, use the
applicable `simple-changes` skill to hand off that completed work according to
the current request and the repository's own policy.
<!-- simple-changes:end -->
```

Global user-signaled handoff:

```md
<!-- simple-changes:start -->
When the user indicates that completed work is ready to put up, merge, ship,
finish, or reconcile, use the applicable `simple-changes` skill and follow the
current request and the repository's own policy.
<!-- simple-changes:end -->
```

The global variants must stay repository-neutral. They name no repository,
policy path, provider, environment, project, branch, or finish boundary. They
must also allow a repository-local Simple Changes fork or stricter repository
instruction to take precedence.

Keep detailed preservation, approval, migration, deployment, and cleanup rules
inside the skill. The pointer should only identify when the decision is due,
which skill owns it, and which policy controls the finish boundary.

### Pointer state and repeat behavior

Do not duplicate the instruction path or handoff timing into personal or
repository policy. The managed pointer is the durable evidence of the selected
trigger, while the confirmed setup receipt records whether the pointer was
added or declined.

Valid saved preferences suppress repeat first-use onboarding. A later guidance
update may inspect an existing managed pointer and offer an in-place update.
If the pointer is missing or hand-edited, report the drift and offer the exact
repair; do not silently rewrite it.

Run-only setup writes neither preferences nor an instruction pointer.

## Automatic post-implementation handoff

### Add a handoff mode

Add a deterministic `handoff` initialization mode for the
`automatic-after-implementation` pointer.

`handoff` should:

1. be write-capable;
2. scope mutation to work attributable to the completed assignment;
3. inventory and report all other stable or active repository work;
4. resolve its finish boundary from the current request, then repository
   policy, then personal defaults;
5. fall back to opening a checked proposal when no finish policy exists; and
6. retain every existing authority checkpoint.

Do not reinterpret an ordinary implementation request as production authority.
Automatic production is possible only when the repository pointer explicitly
selects automatic handoff, effective policy selects shipping, production policy
allows it, and every other deployment condition is satisfied.

### Positive trigger boundary

Automatic handoff applies only after an agent:

- was assigned implementation work;
- created or changed repository work attributable to that assignment;
- completed proportionate local verification; and
- is otherwise ready to return a successful implementation result.

### Negative trigger boundary

Do not automatically hand off after:

- read-only review, explanation, planning, or diagnosis;
- a blocked or incomplete implementation;
- a task that produced no repository change;
- a commit-message-only task;
- a changelog-only or release-note-only task;
- a Simple Changes run itself;
- a handoff report or resume of the same handoff; or
- work owned by another active agent, task, or person.

This prevents recursive invocation and avoids broad automatic sweeps when
multiple agents are sharing a repository.

### Attribution and concurrency

Automatic handoff should default to the current assignment's attributable unit,
not every stable unit in the repository. Continue to account for all discovered
work in the outstanding-work ledger.

Use the existing repeated snapshot and ownership rules. Recheck ownership
immediately before mutation. A generic completion pointer never transfers
ownership of another agent's branch, worktree, proposal, or changing files.

Persist enough run provenance under `.git/simple-changes/` to prevent duplicate
handoffs after resume without committing transient state.

## Confirmation receipt

Before writing personal preferences, repository policy, or repository
instructions, show a plain-language receipt containing:

- finish boundary;
- ambiguous-scope behavior;
- workspace isolation;
- proposal state;
- review fallback;
- progress and permission behavior;
- production behavior when relevant;
- changelog behavior when relevant;
- every saved technology hint;
- delivery-path and missing-deployment behavior;
- preference scope and every path to be written;
- exact instruction-file path;
- proposed managed pointer;
- automatic or user-signaled handoff timing; and
- the high-risk operations that remain separately authorized.

One confirmation may authorize the exact writes named in the receipt. A changed
target path or changed pointer requires a new receipt.

After applying, re-read and validate every written JSON and instruction file.

## Implementation work

### Task 1: Split personal preferences from repository policy

Files:

- `skills/simple-changes/scripts/lib/types.ts`
- `skills/simple-changes/scripts/lib/policy.ts`
- `skills/simple-changes/scripts/lib/schema.ts`
- `skills/simple-changes/evals/schemas/repo-policy.schema.json`
- new `skills/simple-changes/evals/schemas/user-preferences.schema.json`
- `tooling/simple-changes/tests/onboarding.test.ts`
- `tooling/simple-changes/tests/schema.test.ts`

Work:

- define shared workflow defaults;
- keep repository policy limited to repository workflow decisions;
- define optional personal technology hints;
- normalize legacy personal and repository policies safely;
- preserve strict unknown-field rejection; and
- keep personal files private and repository policy visible.

### Task 2: Build onboarding inspection and recommendations

Files:

- new `skills/simple-changes/scripts/lib/onboarding-inspection.ts`
- `skills/simple-changes/scripts/lib/initialization.ts`
- `skills/simple-changes/scripts/lib/onboarding.ts`
- `skills/simple-changes/scripts/lib/inventory.ts`
- `tooling/simple-changes/tests/initialization.test.ts`
- `tooling/simple-changes/tests/onboarding.test.ts`

Work:

- distinguish personal setup from repository activation;
- inspect stack, provider, instruction-file, changelog, and deployment evidence
  before asking;
- return resolved, recommended, and unresolved fields in JSON;
- skip questions answered by the current request or trustworthy evidence; and
- keep preview and pause non-interactive.

### Task 3: Expand interactive and non-interactive setup

Files:

- `skills/simple-changes/scripts/simple-changes.ts`
- `skills/simple-changes/scripts/lib/onboarding.ts`
- `tooling/simple-changes/tests/cli.test.ts`
- `tooling/simple-changes/tests/onboarding.test.ts`

Work:

- add recommended, customized, and run-only flows;
- add text input support for optional technology hints;
- add deterministic CLI flags or a validated profile JSON input for automation;
- add flags for every new closed workflow choice;
- include conditional instruction-pointer and handoff choices; and
- require `--yes` only with a complete, unambiguous non-interactive receipt.

### Task 4: Add safe scope-aware instruction management

Files:

- new `skills/simple-changes/scripts/lib/repository-instructions.ts`
- `skills/simple-changes/scripts/lib/path-safety.ts`
- `skills/simple-changes/scripts/simple-changes.ts`
- new `tooling/simple-changes/tests/repository-instructions.test.ts`
- `tooling/simple-changes/tests/security.test.ts`

Work:

- discover the exact existing instruction target for the chosen scope;
- require repository targets to remain inside the canonical primary checkout;
- require personal targets to equal the runtime's established global
  instruction path;
- reject symlinks, traversal, arbitrary global paths, and missing targets;
- render the four repository/global and automatic/user-signaled pointer
  variants;
- preview the exact edit in the receipt;
- update atomically after confirmation without creating a missing instruction
  file;
- preserve existing content and newline style;
- update managed markers in place;
- detect duplicate or conflicting hand-written blocks without deleting them
  silently; and
- re-read and verify the result.

### Task 5: Add automatic handoff mode

Files:

- `skills/simple-changes/scripts/lib/types.ts`
- `skills/simple-changes/scripts/lib/triggers.ts`
- `skills/simple-changes/scripts/lib/initialization.ts`
- `skills/simple-changes/scripts/lib/planner.ts`
- `skills/simple-changes/scripts/lib/authority.ts`
- `skills/simple-changes/scripts/simple-changes.ts`
- `tooling/simple-changes/tests/triggers.test.ts`
- `tooling/simple-changes/tests/initialization.test.ts`
- `tooling/simple-changes/tests/planner.test.ts`

Work:

- add `handoff` to the request-mode contract;
- resolve the effective finish boundary deterministically;
- constrain automatic scope to the completed assignment;
- add recursion and duplicate-handoff guards;
- preserve all other work and report it explicitly; and
- keep production and high-risk authority separate.

### Task 6: Add evaluation coverage

Files:

- `tooling/simple-changes/evals/cases.json`
- `tooling/simple-changes/evals/schemas/eval-manifest.schema.json`
- `tooling/simple-changes/tests/behavior-eval.test.ts`
- `tooling/simple-changes/tests/skill-contract.test.ts`

Add positive cases for:

- explicit queue, merge, and ship language;
- automatic handoff after completed verified implementation;
- user-signaled handoff from the managed pointer;
- repository evidence overriding personal technology hints; and
- a missing deployment configuration following the saved report or recommend
  behavior.

Add negative cases for:

- read-only review;
- planning and diagnosis;
- blocked implementation;
- no-change completion;
- commit-message-only work;
- changelog-only work;
- recursive Simple Changes completion;
- another agent's active work; and
- technology hints being treated as provider proof or deployment authority.

### Task 7: Update skill guidance and user documentation

Files:

- `skills/simple-changes/SKILL.md`
- `skills/simple-changes/references/setup-and-policy.md`
- new `skills/simple-changes/references/onboarding.md`
- `skills/simple-changes/references/deployments.md`
- provider references only where their evidence contract changes
- `README.md`
- `tooling/simple-changes/EVAL.md`

Keep the main skill concise. Route detailed conversational setup into the new
onboarding reference, following the Simple Changelogs pattern.

Do not duplicate provider-specific commands in general onboarding guidance.

### Task 8: Coordinate release documentation

Simple Changes must not author its own changelog or release notes. After the
implementation and verification are complete, hand the release-impact evidence
to the configured compatible changelog workflow and accept only a current
validated receipt.

Release-note writing must follow the repository's required release-note model
and effort policy.

## Verification

Run targeted checks while implementing:

```sh
bun test tooling/simple-changes/tests/onboarding.test.ts
bun test tooling/simple-changes/tests/initialization.test.ts
bun test tooling/simple-changes/tests/repository-instructions.test.ts
bun test tooling/simple-changes/tests/triggers.test.ts
bun test tooling/simple-changes/tests/security.test.ts
```

Then run the repository-native full suite:

```sh
bun run typecheck
bun run lint
bun run test
bun run eval
bun run check
```

Verify manually with isolated temporary configuration directories:

1. global setup outside Git with an existing global instruction file;
2. global setup with no global instruction file, proving no file is created;
3. first repository activation with personal defaults;
4. existing repository `AGENTS.md` pointer addition;
5. repository scope with no instruction file, proving no file is created;
6. declined global and repository instruction edits;
7. update of an existing managed pointer;
8. automatic completion handoff to review only;
9. user-signaled ship flow;
10. a repository stack overriding personal hints;
11. a missing deployment configuration that is reported without provisioning;
12. a legacy policy guidance update; and
13. run-only setup proving that no durable file was written.

## Acceptance criteria

- Global onboarding can record portable workflow and optional technology
  preferences without storing repository facts.
- Repository evidence overrides personal technology hints.
- After preference scope is selected, setup offers only the exact existing
  instruction-file target for that scope and requires confirmation.
- Missing instruction files are reported and never created by onboarding.
- The handoff-timing question is asked only after the user chooses to add the
  pointer.
- The user-facing wording is:
  **“When should agents hand completed work to Simple Changes?”**
- Automatic handoff runs only after completed, verified implementation work and
  never after the negative-trigger cases.
- Automatic handoff scopes mutation to attributable work and cannot claim
  another active agent's work.
- A managed pointer is updated in place and never duplicated.
- Declining the pointer leaves repository instructions byte-for-byte unchanged.
- No personal or repository preference silently authorizes production, remote
  data writes, secrets, DNS, store releases, or exceptional history rewrites.
- Deployment success still requires exact revision, readiness, canonical
  target, and changed-journey evidence.
- All schemas, unit tests, trigger evaluations, security checks, Biome, and
  Ultracite pass.

## Recommended defaults

- Ambiguous scope: current task only
- Workspace isolation: adaptive
- Proposal state: ready when verified, draft when blocked
- Review fallback: independent human approval
- Progress updates: milestones
- Permission prompts: blocking only
- Technology profile: repository discovery only
- Delivery path: repository or provider native
- Missing deployment configuration: report what is missing
- Instruction pointer: recommend adding it when the chosen scope already has an
  instruction file; otherwise move on
- Handoff timing: wait until the user says the work is ready
- Production: ask first

These defaults keep globally installed behavior useful without letting personal
preferences masquerade as repository evidence or operational authority.
