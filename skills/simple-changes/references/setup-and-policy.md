# Setup and policy

## Discovery order

1. Read the user's current request; it is the highest authority for this run.
2. Read repository and directory-scoped agent instructions.
3. Load `.simple-changes.json` from the canonical primary checkout when present.
4. Otherwise load the user's saved Simple Changes preferences when present.
5. Discover Git, forge, changelog, review, CI, release, migration, and deployment
   capabilities from tracked repository evidence.
6. Treat remote/provider state as discovered fact, never durable policy.

Effective preference precedence is:

1. the user's current request;
2. repository `.simple-changes.json`;
3. saved user preferences;
4. safe defaults.

## Automatic initialization checkpoint

Classify the request mode, then run:

```sh
simple-changes initialize --mode <mode> --json
```

Queue, sweep, integrate, ship, reconcile, and resume are write-capable.
Preview and pause are read-only or preservation-only. When a write-capable mode
has policy source `default`, onboarding is required before any local branch,
commit, push, proposal, merge, cleanup, or deployment mutation.

Start onboarding automatically; do not add a separate "would you like to set
this up?" prompt. The request mode supplies the finish choice for queue, sweep,
integrate, reconcile, and ship. Ask only unresolved questions, confirm the
summary, persist the selected scope, and continue the original task.

Ask **How should changelog work be handled?** only when established changelog
surfaces or a compatible changelog skill are discovered. Offer delegation when
available, preservation and reporting, or asking before delegation. The safe
fallback is preservation; setup never grants release, version, or publication
authority.

In an interactive terminal, `initialize` directly launches setup. In a
non-interactive agent runtime, it emits a closed machine-readable status. The
agent must translate that status into the same onboarding questions in chat,
then call `setup` with explicit flags. A valid repository or personal policy
suppresses repeat onboarding.

Use these safe defaults when no committed policy exists:

```json
{
  "schemaVersion": 1,
  "guidance": { "version": 1 },
  "changelogHandling": "preserve-and-report",
  "defaultFinish": "open-change-request",
  "questions": "blocking-only",
  "review": "repository-policy",
  "productionDeploy": "ask",
  "concurrentWork": "preserve"
}
```

Validate policy with `evals/schemas/repo-policy.schema.json`. Reject unknown
fields so misspellings cannot silently weaken safeguards. Policy may record team
choices; it must not contain credentials, derived project IDs, transient branch
names, or run state.

Use `simple-changes setup` for interactive onboarding. It can save the same
closed policy contract for the user, in the platform configuration directory,
or for the repository, at the canonical primary checkout. Run-only setup writes
nothing. Personal and run-only setup can run outside Git; repository scope
requires a repository. For deterministic agent or automation use, supply:

```sh
simple-changes setup \
  --finish review \
  --changelog preserve-and-report \
  --questions blocking-only \
  --scope user \
  --yes
```

For `--finish ship`, also supply `--production ask|allow|deny`.
`SIMPLE_CHANGES_CONFIG_DIR` may override the personal configuration root for
isolated automation and tests.

## Capability status

Represent each capability as one of:

- `supported`: discovered and available;
- `unsupported`: the adapter cannot provide it;
- `configuration`: the capability exists but CLI, authentication, or repository
  configuration is missing;
- `unavailable`: a temporary provider failure;
- `partial`: the operation produced incomplete evidence.

Never translate any non-supported status into success. Provider-specific
commands belong only in the matching provider reference or adapter.
