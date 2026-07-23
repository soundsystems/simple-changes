# Database and data-system changes

Use this reference whenever a focused unit changes a database schema, migration
history, stored routine, data backfill, index, projection, search mapping,
document validation rule, graph constraint, or generated ORM artifact.

The core is provider- and language-agnostic. Discover the repository's actual
tooling and invoke its documented commands; do not substitute a remembered ORM,
database CLI, cloud console, or SQL dialect.

## Classify the change

Record each affected data surface by behavior:

| Class | Examples of evidence | Primary risks |
| --- | --- | --- |
| Migration history | Ordered migration directories, changelogs, revision files | Ordering, immutability, partial apply, drift |
| Schema definition | Declarative schema, ORM model, validation or constraint files | Generated parity, compatibility, destructive DDL |
| Query or routine | SQL, stored procedures, graph/document queries | Dialect, permissions, search path, query plans |
| Backfill or seed | Data migrations, repair scripts, seed/copy jobs | Scope, idempotence, batching, irreversible mutation |
| Index or projection | Database indexes, search mappings, materialized views | Build cost, locks, freshness, dual-read transition |

One unit may touch several classes. Query language is evidence about semantics
and risk, not authority. SQL-like DDL may be transactional on one engine and
implicitly committing on another. Document, graph, search, and analytics
systems may express compatibility through index versions, validators,
constraints, projections, or rebuild workflows rather than tables.

## Treat ORMs as discovery evidence

ORM guidance has value when it tells the agent what to discover, not when it
blesses one framework's commands. Establish:

- whether models, migrations, or the live database are the source of truth;
- whether migration files are generated, handwritten, or paired;
- which generated artifacts must remain in parity with their inputs;
- how the repository detects drift and validates a fresh database;
- where raw/native queries bypass ORM-level safety or portability;
- whether an application rollout must support old and new schemas
  simultaneously.

Use the same evidence model for relational, document, graph, search, analytics,
and event-backed systems. Route to repository-native SQL, CQL, Cypher, SPARQL,
GraphQL, mapping, pipeline, or other query guidance only after discovering that
surface. Do not infer a database mutation merely from an unrelated example file
that happens to use a query-language extension.

## Discover every history

Inspect repository instructions, configuration, package scripts, schema files,
generated artifacts, and migration directories. Record:

- every canonical and generated/paired migration history;
- the ordering and identity convention;
- whether generated files must match a source schema;
- the exact configured local and remote target;
- repository-native audit, dry-run, apply, and verification commands;
- whether old and new application revisions must coexist during rollout.

Do not assume the first `migrations` directory is the only history. When two
histories represent the same logical change, compare their content or generated
identity according to repository policy.

## Audit read-only

Audit every detected data change without inferring remote-write authority:

1. Compare local history with the remote ledger or equivalent observed state.
2. Treat remotely observed revisions as immutable. Correct an applied change
   with a new revision instead of rewriting history.
3. Inspect transaction behavior, locks, table or collection rewrites, index
   build strategy, constraints, permissions, row-level rules, routine search
   paths, query plans, and rollback/recovery implications when applicable.
4. Check forward and backward compatibility across the deployment window.
5. Run repository-native validation and dry-run commands with explicit argument
   arrays.
6. Classify failures as introduced, pre-existing, configuration, unsupported,
   unavailable, or partial.

An ORM-generated migration still requires inspection of the generated database
operations. A schema diff, successful generation command, or zero exit status
does not prove remote safety.

## Apply only with exact authority

Remote schema apply, data mutation, repair, and backfill are separate
consequential operations. Require current authority naming the target and exact
operation. A migration-apply request covers only the audited pending revisions;
it does not silently authorize an ad hoc backfill, destructive cleanup, or
production target inferred from local configuration.

For authorized backfills:

- make selection criteria deterministic and bounded;
- measure candidate and affected counts;
- preserve referential or document/graph invariants;
- batch or cap lock duration when volume warrants it;
- make restart and duplicate-execution behavior explicit;
- verify postconditions and unexpected leftovers;
- record the exact revision, target identity, and redacted evidence.

After any apply, re-read remote history and affected invariants. Do not report
success from command exit alone.
