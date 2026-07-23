# Vercel deployment adapter

Support tier: **contract-tested; live mutation remains credential-dependent**.

Model Vercel as a Git-connected or uploaded atomic deployment. Capture immutable
deployment ID/URL, project, environment, intended and observed commit SHA, build
status, canonical alias mapping, and focused smoke result. A ready deployment is
not complete until the canonical target maps to it.

Resolve the linked project and scope from repository evidence. Fetch the
project's configured production domains separately from the deployment's
current aliases, then derive concrete canonical hostnames from repository
policy, app configuration, and documented production origins. A wildcard proves
provider ownership but is not permission to invent tenant hostnames.

Inspect the new deployment and every concrete canonical hostname. Compare
immutable deployment IDs, not page content, timestamps, default project aliases,
or a single successful hostname.

When a Ready production deployment of the intended revision is not live:

1. promote that existing deployment with Vercel's promotion capability;
2. re-inspect every configured canonical hostname;
3. if Vercel reports the deployment is already current but an exact hostname
   remains stale, use alias assignment only when that hostname is already a
   verified domain of the same linked project and production-deploy authority
   is active;
4. re-inspect all hostnames and block completion on any remaining mismatch.

Do not promote a preview that has not passed the immutable-revision and
readiness checks. Do not use alias assignment to transfer domains between
projects, replace wildcard configuration, or modify DNS. Record the deployment
ID and each hostname-to-deployment-ID mapping in the normalized receipt.
