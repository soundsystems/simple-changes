# Railway deployment adapter

Support tier: **experimental until the shared deployment suite passes**.

Discover project, service, and environment from repository configuration.
Capture immutable deployment identity, source commit or image identity, build
and rollout state, public domain mapping, logs, and focused smoke result. Do not
infer production authority from an available Railway token.

Use the environment's existing provider-managed domain inventory as the
expected set, then refresh every mapping after an existing-deployment promotion
or rollback. Adding, transferring, or changing custom-domain ownership is not
implicit deployment finalization.
