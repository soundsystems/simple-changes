# Migrations and high-risk actions

Contents:

- Installed-client compatibility gate

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

## Installed-client compatibility gate

Use this gate when a candidate can change behavior consumed by a separately
released installed client, including mobile or desktop binaries. Trigger it for
database migrations; API, RPC, GraphQL, authentication, authorization, storage,
or realtime contract changes; shared validation or persisted-data contracts;
and client changes that may still need distribution.

Identify the supported production client builds and their source revisions when
that evidence is available. Do not assume the newest store build is installed;
without an enforced minimum-version boundary, older installed clients may still
use the production backend. Compare those clients' reads, writes, RPC calls,
response parsing, permissions, and offline/retry behavior with the candidate.
Pay particular attention to removed or renamed fields, tables, endpoints, or
routines; changed parameter or return shapes; stricter nullability, constraints,
or enums; and row-level, storage, or realtime rules that reject previously valid
operations. Additive nullable fields, new independent objects, and indexes are
usually compatible but still require evidence when they affect a client path.

Record exactly one result with concise evidence:

- `compatible`: supported installed clients remain functional; no client
  release is required for safety.
- `release-recommended`: installed clients remain safe, but candidate client
  behavior is not delivered until a separately authorized client release.
- `incompatible`: a supported installed client can fail, corrupt work, or
  crash; block the affected migration or backend/production rollout.
- `unverified`: the supported client boundary or contract effect could not be
  established; block only the affected migration or deployment until resolved.

Cutting a client release does not by itself make `incompatible` safe because old
binaries remain installed during review, rollout, and adoption. Use an
expand-and-contract sequence instead: preserve the old contract while adding
the new one, ship the compatible client, establish the enforced support or
adoption boundary, and remove the legacy contract in a later reviewed change.
This gate grants no migration, deployment, build, submission, or store-release
authority.

The presence of a migration never authorizes a remote apply. Queueing,
integrating, or shipping code does not by itself authorize:

- remote migrations, backfills, repairs, or production data changes;
- secrets or environment mutations;
- DNS/domain reassignment;
- mobile/store releases;
- force pushes or history rewrites.

Every migration must finish the read-only technical audit before apply. After
review, evaluate `migrationHandling` against the exact observed
provider/project/environment target:

Materialize that audit as closed `migration-review` data whose canonical digest
binds every reviewed revision path and its content digest. Capture the fresh
pending operations as closed `migration-pending` data with the same identity,
then run
`simple-changes migration decision --state REVIEW_FILE --pending PENDING_FILE --apply-plan APPLY_PLAN_FILE --repo REPOSITORY`.
The apply plan must bind a fresh remote ledger, exact target, bounded nonce and
expiry, adapter, absolute executable path and executable SHA-256 digest. After
an `auto-apply` decision, run `simple-changes migration apply` with the same
review, pending set, and apply plan. That command recomputes current evidence,
atomically consumes the authorization, and launches the exact argv without a
shell as one operation. Then refresh the remote ledger and run the planned
post-apply verification.
The CLI re-hashes every current operation source before policy evaluation.
Missing, stale, replayed, or changed identity fails closed and requires a new
review; a prior review for the same target never authorizes later operations or
same-path content edits.
The apply plan must prove that the command applies exactly the listed operation
set. A provider-native command that applies every pending migration is not
eligible for automatic policy authorization unless its adapter constrains and
proves that exact set; otherwise request explicit authority.
Only an `auto-apply` result grants saved-policy authority to continue without
another permission prompt; follow every other result exactly.

- `ask-after-review`: request exact apply authority after the audit.
- `auto-apply-reviewed-routine`: proceed without another prompt only when the
  reviewed migration is routine and the target exactly matches a saved
  `migrationTargets` entry.
- `auto-apply-reviewed`: proceed without another prompt for routine or other
  reviewed eligible migrations on an exact saved target.
- `never`: preserve and report every remote apply.

Both automatic tiers require verified backup or rollback evidence and a planned
post-apply verification. Neither tier covers destructive or data-deleting,
irreversible, unbounded, lock-heavy, target-mismatched, or unprotected changes.
Those findings require current explicit authority naming the exact revisions,
operation, and target. Backfills and repairs remain separately authorized even
when stored near schema migrations.

Delegate execution to repository-native or specialized guidance and record a
redacted receipt. After any apply, re-read remote migration history and verify
the planned postconditions; command exit alone is not success evidence.

Provider-native promotion of an already verified production artifact and
bounded reconciliation of exact provider-managed targets already owned by the
same project remain inside authorized production deployment finalization.
Creating or transferring domains, editing external DNS, changing wildcard
ownership, or attaching a target whose ownership is not proven remains a
separate DNS/domain action under this checkpoint.
