# Cloudflare Pages and Workers deployment adapter

Support tier: **experimental until the shared deployment suite passes**.

Classify Pages as Git-connected/atomic and Workers as edge/serverless publish.
Capture project/script identity, immutable deployment or version ID, intended
revision, environment, route/domain mapping, readiness, and smoke result.
Reconcile an existing same-project provider-managed production route only under
production-deploy authority and the bounded deployment contract. Creating or
transferring zones, DNS records, custom domains, or wildcard ownership requires
separate exact authority.
