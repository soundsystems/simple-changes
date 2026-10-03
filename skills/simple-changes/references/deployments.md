# Deployments

Contents:

- Emergency Ship exception
- Discover canonical targets completely
- Reconcile stale provider-managed targets

Deployment support is a capability contract, not a provider name. Discover the
repository's documented workflow and classify the delivery model:

- Git-connected build;
- uploaded atomic artifact;
- image/container rollout;
- edge/serverless publish;
- self-hosted control plane.

Distinguish preview, staging, and production. Production requires explicit
current authority or effective policy that clearly grants it; repository
policy is effective only with its local trust receipt, per
[setup and policy](setup-and-policy.md). A `release-gate` decision is never
that authority.

A production deployment of a Web product is a product release. Normally, before
invoking the provider, require a v2 or later `verified` changelog receipt for the exact
refreshed canonical target. It must bind the effective policy, selected version,
decision digest, input target, reconciliation head, and finalized target. An
unresolved version, `decision-required`, unavailable or blocked delegation,
preserve-and-report disposition, unmerged reconciliation, failed final
verification, or target-contained pending item blocks normal production.

## Emergency Ship exception

Emergency Ship is a narrow exception to the normal ordering. Its urgency
evidence remains run-bound, while advanced policy may save break-glass ordering:

- `expedited` runs focused checks, independent review, and merge before the
  first deployment, then records `live-unreconciled` while changelog/version
  reconciliation, remaining verification, and cleanup continue.
- `break-glass` requires current-request or saved break-glass ordering,
  production authority, and a known native rollback or corrective-release
  capability. Saved `shippingMode: "break-glass"` plus
  `productionDeploy: "allow"` makes an ordinary Ship request sufficient without
  another authorization prompt. It deploys one exact candidate immediately,
  before focused checks or independent review, and records `live-unreviewed`
  until those deferred steps complete.

Treat rollback as a capability, not a provider-name checklist or a required
pre-deploy inventory call. Repository/provider configuration may establish the
capability before the run. Atomic deployment history, retained immutable
artifacts, revision traffic switching, provider-native previous-deployment
rollback, or an enabled automatic rollback controller are sufficient. This
includes common configurations on Vercel, Netlify, Cloudflare Workers,
Railway, Render, Cloud Run, and ECS. Do not delay the first deployment merely
to fetch the currently live deployment ID when the provider can already roll
back to its previous successful production state.

Fail closed only when rollback capability is unknown or genuinely unavailable,
such as expired artifacts, mutable image tags without a pinned digest,
unconfigured rollout controllers, deleted provider bindings/resources, or
stateful changes that the deployment provider cannot reverse. Database/schema
migrations, persistent disks, external APIs, secrets, environment, DNS, and
other state remain separate authority and recovery boundaries; native code
rollback does not make those reversible.

Active user impact, urgency, or a claim that testing passed may recommend
break-glass but cannot authorize it. An unambiguous request such as “deploy
first and review afterward” can. Break-glass never authorizes migrations,
backfills, secrets, environment changes, DNS changes, store releases, history
rewrites, or bypassing a protected merge.

Immediately after deployment, verify candidate health, run focused checks, and
resume the deferred sequence. A
review rejection requires rollback or a corrective revision. Approval proceeds
through canonical Git integration and forward changelog/version reconciliation;
never rewrite an already observed release record. Persist candidate, initial
deployment, reconciliation, canonical, and final production evidence so Resume
does not repeat any operation. Record each step with
`loop emergency record --run-id <id> --agent-id <you> --state <file>` and
read the next required action from `loop emergency status --run-id <id>`;
both bind to the active run and refuse a stale or replayed ledger.

After reconciliation, decide the final production action from immutable
evidence:

1. When the final canonical revision is already live, verify it without another
   deployment.
2. When revisions differ but both resolve to the same immutable artifact,
   require explicit artifact-equivalence proof and bind the canonical revision
   to that existing artifact before final verification.
3. Otherwise deploy the final canonical runtime artifact and verify it replaces
   the emergency candidate.

Do not create a second deployment merely because reconciliation produced a new
Git revision. Conversely, matching filenames, version text, build logs, or
human claims are not artifact-equivalence proof. Completion still requires
approved independent review, canonical Git and release state, final production
verification, remaining checks, and cleanup.

A successful deployment receipt includes provider, immutable deployment
identity, project, environment, intended committed revision, observed revision,
provider readiness, URL, delivery model, the complete configured canonical-target
inventory, each observed target mapping, focused smoke evidence, and safe
provider evidence. For a Web production deployment, the run report also binds
that receipt to the verified product release version and release-reconciliation
evidence from the same intended revision.

For Ship and resumed Ship loops, resolve the canonical remote target branch
(normally `main`) again after the final merge. Its exact head is the deployment
receipt's intended revision. Do not copy the revision from a deployment record
or retain a pre-merge target revision: both can make a stale deployment appear
current. Inspect the production deployment even when the run did not create a
new one, and compare its observed revision with that refreshed target head.

Verification requires all of:

1. the intended code is committed and, for production, the intended revision
   equals the freshly resolved canonical target head after all merges;
2. for Web production, a read-only final changelog verification names that same
   intended revision and proves the prepared reconciliation is integrated;
3. the provider built or deployed that exact immutable revision;
4. the deployment reached its provider-specific ready state;
5. every configured canonical endpoint is observed exactly once and resolves to
   that deployment;
6. focused smoke checks exercise the changed user journey.

After observation, build the composite `release-delivery-receipt` with
`simple-changes release-delivery --changelog-receipt <verified.json>
--provider-receipt <deployment.json> [--request <request.json>]`. It derives
the transaction and optional release-set IDs, train, version, decision digest,
input/reconciliation/finalized revisions, provider receipt ID, and deployed
revision from those two sources rather than copying them, so the composite
cannot disagree with its inputs. `complete` requires the observed deployment
revision to equal the verified finalized target; the command exits nonzero for
`partial` or `blocked`. Use structured failure codes for drift or incomplete
observation; never parse provider prose to decide a retry. Release-set grouping
is reporting only and does not make independent trains atomic.

An exit code, a `Ready` label, the newest deployment's source revision, or a
preview URL alone is insufficient. Record partial failure honestly and resume
from fresh Git and provider state without creating a duplicate deployment.

Retries reuse the selected version only when the transaction, decision digest,
verified finalized target, and immutable artifact are unchanged. Code, policy,
owner, schema, or target changes return to classification. A provider failure
alone never selects another version.

If production is behind the canonical target, a Ship loop may create, reuse, or
promote a verified artifact for the refreshed target revision only when
production deployment is authorized. Without that authority, do not mutate the
deployment; report both revisions and the exact blocked action. A deployment
ahead of or divergent from the canonical target is also drift and must not be
reported as complete.

## Discover canonical targets completely

Build the expected target inventory from committed repository policy,
application configuration, provider project configuration, and documented
production origins. Do not infer it from the aliases attached to the new
deployment alone: that is the state being verified and can omit a stale target.

For wildcard routes, prove ownership of the wildcard and verify only concrete
hostnames established by repository evidence. Do not invent customer, tenant,
or branch hostnames, and do not attempt to enumerate an unbounded namespace.
Normalize harmless URL spelling differences before comparison, but preserve
meaningful paths.

A production receipt is partial when:

- the expected inventory is absent or duplicated;
- an expected target was not observed;
- an unexpected target appears in the observed production set;
- any observed target resolves to another immutable deployment; or
- only one of several canonical endpoints was checked.

Create shipment-specific deployment checkouts through `prepare-agent` so the
active run records them as run-created cleanup artifacts. Do not classify a
temporary deployment checkout as `retained`; retention means that checkout is
expected to remain after shipment, so its later disappearance correctly looks
like lost work.

## Reconcile stale provider-managed targets

Use a bounded recovery sequence against the existing verified artifact:

1. Confirm production-deploy authority, immutable deployment identity, expected
   project/environment, freshly resolved canonical target revision, matching
   intended revision, and provider readiness.
2. Refresh the complete expected target inventory and every observed mapping.
3. When supported and the artifact is not already current, perform one
   provider-native promotion of that existing artifact.
4. Refresh all target mappings; do not trust promotion command success.
5. If mappings remain stale, use one provider-managed target reconciliation
   only when the adapter supports it and ownership of every exact target by the
   same project is proven.
6. Refresh every target and run the focused smoke journey through a canonical
   endpoint.
7. Stop as partial or blocked when convergence still fails. Do not create a
   duplicate deployment merely to retry routing.

Promotion and same-project provider-managed target attachment are deployment
finalization operations. External DNS edits, ownership transfers, targets
belonging to another project, wildcard replacement, secret/environment changes,
and arbitrary domain reassignment remain separate high-risk actions requiring
exact authority.

Persist each attempt in the run ledger or provider receipts so resume cannot
repeat promotion or target reconciliation indefinitely. The generic decision
contract allows at most one of each before blocking.
