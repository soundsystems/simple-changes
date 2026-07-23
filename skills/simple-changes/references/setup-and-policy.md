# Setup and policy

## Discovery order

1. Read the user's current request; it is the highest authority for this run.
2. Read repository and directory-scoped agent instructions.
3. Load `.simple-changes.json` from the canonical primary checkout when present.
4. Discover Git, forge, review, CI, release, migration, and deployment
   capabilities from tracked repository evidence.
5. Treat remote/provider state as discovered fact, never durable policy.

Use these safe defaults when no committed policy exists:

```json
{
  "schemaVersion": 1,
  "guidance": { "version": 1 },
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
