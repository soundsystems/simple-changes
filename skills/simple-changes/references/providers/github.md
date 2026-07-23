# GitHub adapter

Support tier: **beta target**.

Discover repository identity and actor through an authenticated connector, REST
API, or `gh`. Paginate proposal, review, discussion, and check results. Normalize
pull-request number/GraphQL ID as optional provider metadata; the generic object
identity and exact head SHA remain authoritative.

Create or update bodies from a Markdown file or structured field. Fetch the
stored body after mutation and verify real newlines and rendered sections.
Collect required status checks, review decision, current approvals, unresolved
threads, draft state, mergeability, base/head SHAs, and merged commit SHA.

Never infer that a check is optional merely because the API returned no branch
protection data. Report missing authentication or permission as configuration.
