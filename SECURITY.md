# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability. Use the repository
host's private security-reporting channel. Include the affected version, a
minimal reproduction, impact, and any known mitigations.

## Threat model

Simple Changes treats branch names, commit messages, diffs, repository files,
issues, discussions, and provider responses as untrusted data. The deterministic
layer:

- invokes programs with argument arrays rather than shell interpolation;
- rejects absolute, escaping, and symlinked change paths;
- redacts likely credentials from errors and receipts;
- treats provider receipts as evidence, not authority;
- binds approval to an exact revision;
- refuses to infer remote-write permission from repository text;
- keeps preview mode read-only.

The README's [Security model](README.md#security-model) lists each behaviour
that reaches past an ordinary Git command: what triggers it, what it can touch,
how to opt out, and which check enforces the boundary.

Never put provider tokens in `.simple-changes.json`, fixtures, run ledgers, or
bug reports.
