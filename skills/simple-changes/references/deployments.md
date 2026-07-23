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

A successful deployment receipt includes provider, immutable deployment
identity, project, environment, intended committed revision, observed revision,
provider readiness, URL, delivery model, the complete configured canonical-target
inventory, each observed target mapping, focused smoke evidence, and safe
provider evidence.

Verification requires all of:

1. the intended code is committed and, for production, merged as policy
   requires;
2. the provider built or deployed that exact immutable revision;
3. the deployment reached its provider-specific ready state;
4. every configured canonical endpoint is observed exactly once and resolves to
   that deployment;
5. focused smoke checks exercise the changed user journey.

An exit code, a `Ready` label, or a preview URL alone is insufficient. Record
partial failure honestly and resume from fresh provider state without creating a
duplicate deployment.

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
   project/environment, exact intended revision, and provider readiness.
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
