# Migrations and high-risk actions

Detect migration-like changes from repository conventions, schema directories,
database tooling, and project instructions. Audit them read-only by default:

- ordering, naming, reversibility, and transaction behavior;
- destructive or lock-heavy operations;
- data backfill volume and resumability;
- paired histories or generated artifacts required by the project;
- compatibility between old/new application revisions.

Follow [database and data-system changes](data-changes.md) for migration-history
discovery, ORM/generated-schema parity, non-relational data systems, dialect
risk, bounded backfills, and postcondition evidence.

The presence of a migration never authorizes a remote apply. Queueing,
integrating, or shipping code does not by itself authorize:

- remote migrations, backfills, repairs, or production data changes;
- secrets or environment mutations;
- DNS/domain reassignment;
- mobile/store releases;
- force pushes or history rewrites.

Require current explicit authority naming the exact operation and target. State
the item, impact, recommended option, alternatives, and safe no-answer result.
Delegate execution to repository-native or specialized guidance and record a
redacted receipt.

Provider-native promotion of an already verified production artifact and
bounded reconciliation of exact provider-managed targets already owned by the
same project remain inside authorized production deployment finalization.
Creating or transferring domains, editing external DNS, changing wildcard
ownership, or attaching a target whose ownership is not proven remains a
separate DNS/domain action under this checkpoint.
