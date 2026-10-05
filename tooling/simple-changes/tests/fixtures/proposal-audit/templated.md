## What does this MR do and why?

Retry a failed webhook delivery once before reporting it.

## How to test

Run `bun test webhooks` and expect two delivery attempts.

## Merge danger

**Door:** unknown; the rollback capability of the webhook worker is unverified.
**Blast radius:** webhook consumers that count delivery attempts.

---
[[Authored by Fable 5.1]]
