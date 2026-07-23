# Evaluation contract

This entire directory is source-repository maintainer tooling. It is not copied
into the public `simple-changes` skill and must never run in an end user's
repository.

Run `bun run eval` from the repository root. The credential-free suite checks:

- positive and near-miss trigger classification;
- fourteen representative behavior journeys and their authority ceilings;
- five release-note behavior cases and safe filesystem assertions;
- closed schema validity and runner request/response parity;
- package shape, links, and one discoverable `SKILL.md`;
- provider-neutral core prose;
- preview's zero-mutation contract.

## Portable model-adapter harness

The optional harness copies one release fixture into a disposable Git
repository, sends a neutral JSON request to one adapter, and independently
checks the resulting files. It tests whether different agent runtimes can
follow the same release guidance; it is not a benchmark of prose taste or model
intelligence.

Each adapter creates a permission-locked snapshot of the non-public release
guidance inside the fixture. The agent may mutate the disposable fixture
repository but not the guidance snapshot.
Successful fixtures and their snapshots are deleted. Add `--keep-failures` to
retain a failing repository for diagnosis.

```sh
bun run behavior \
  --adapter tooling/simple-changes/adapters/codex-eval.ts

bun run behavior \
  --adapter tooling/simple-changes/adapters/claude-eval.ts \
  --case release-merge-reconciliation \
  --keep-failures
```

The request and response are validated against the maintainer-only schemas
under `tooling/simple-changes/evals/schemas/`. An adapter's `passed` claim is
insufficient: the harness performs the manifest's file assertions itself.

## Adapters

All runners require their corresponding CLI to be installed and authenticated.
The default model is the CLI's configured default unless an environment
variable below selects one.

| Adapter | Model setting | Isolation |
| --- | --- | --- |
| Codex CLI | `SIMPLE_CHANGES_CODEX_MODEL` | MCP and user config disabled, ephemeral session, workspace-write sandbox |
| Claude Code | `SIMPLE_CHANGES_CLAUDE_MODEL` | safe mode, no session persistence, explicit read/write sandbox |
| Hermes Agent | `SIMPLE_CHANGES_HERMES_PROVIDER`, `SIMPLE_CHANGES_HERMES_MODEL` | nonpersistent Docker terminal, fixture mount, read-only skill override, terminal network disabled |
| Cursor Agent | `SIMPLE_CHANGES_CURSOR_MODEL` | disposable repository and read-only guidance snapshot; Cursor owns its agent sandbox |
| Grok Build | `SIMPLE_CHANGES_GROK_MODEL`, `SIMPLE_CHANGES_GROK_REASONING_EFFORT` | strict sandbox, disposable repository, no memory, subagents, plan mode, or web search |

Hermes also accepts `SIMPLE_CHANGES_HERMES_TERMINAL_ENV=docker`; other terminal
backends are rejected because they do not establish the required fixture
boundary.

Cursor command auto-approval is off by default. Set
`SIMPLE_CHANGES_CURSOR_FORCE=true` only when you intentionally want Cursor's
`--force` behavior for the disposable fixture. The harness does not change
Cursor's global sandbox configuration.

These authenticated runs may consume model quota and are therefore not part of
`bun run check`. Deterministic command-builder, schema, snapshot-permission, and
assertion tests still cover every adapter without credentials.

## Case coverage

- first-use policy and paired histories;
- merge-time pending/released reconciliation;
- guidance-version backfill and recorded disposition;
- stable-major synthesis while preserving prerelease history;
- read-only CLI release notes without extra JSON or UI destinations.

Behavior fixtures under `tooling/simple-changes/evals/fixtures/` are inputs,
never golden model responses. Provider mutation smoke tests remain outside the
public skill.
