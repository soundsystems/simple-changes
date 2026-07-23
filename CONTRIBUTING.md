# Contributing

Thanks for helping make repository integration safer and easier to understand.

1. Open an issue for contract changes so provider-neutral behavior can be
   discussed before an adapter depends on it.
2. Install dependencies with `bun install`.
3. Keep normative workflow rules in one canonical reference. Link to them from
   provider notes instead of copying them.
4. Add a credential-free fixture and test for every behavior change.
5. Run `bun run check` before opening a change proposal.

Provider support is evidence-based. A provider becomes first-class only after it
passes the shared capability suite; documentation and fixtures alone mean
experimental support.

Use real Markdown newlines in proposal descriptions and re-read the stored body
after creation. Never include credentials, environment values, or customer data
in fixtures, logs, or receipts.
