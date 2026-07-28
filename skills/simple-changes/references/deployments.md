# Deployments

Deployment support is a capability contract, not a provider name. Discover the
repository's documented workflow and classify the delivery model:

- Git-connected build;
- uploaded atomic artifact;
- image/container rollout;
- edge/serverless publish;
- self-hosted control plane.

Distinguish preview, staging, and production. Production requires explicit
current authority or committed policy that clearly grants it.

A production deployment of a Web product is a product release. Before invoking
the provider, require the refreshed canonical target to contain the merged
dated/versioned release reconciliation returned by changelog coordination,
including every target-contained `Unreleased` item, established Web mirror, and
proven product-version field. An unresolved version, unavailable or blocked
delegation, preserve-and-report disposition, unmerged reconciliation, or
target-contained pending item blocks production.

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
2. for Web production, that intended revision contains the dated, versioned
   release reconciliation and no target-contained work remains `Unreleased`;
3. the provider built or deployed that exact immutable revision;
4. the deployment reached its provider-specific ready state;
5. every configured canonical endpoint is observed exactly once and resolves to
   that deployment;
6. focused smoke checks exercise the changed user journey.

An exit code, a `Ready` label, the newest deployment's source revision, or a
preview URL alone is insufficient. Record partial failure honestly and resume
from fresh Git and provider state without creating a duplicate deployment.

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
