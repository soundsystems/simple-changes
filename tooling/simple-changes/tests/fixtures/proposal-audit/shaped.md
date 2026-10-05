## Summary

Retry a failed webhook delivery once before reporting it, so one dropped
connection no longer pages the on-call engineer.

```ts
deliver(event)
  .catch(() => deliver(event)) // one retry
  .catch(report); // logs "retry failed\n" verbatim
```

## Evidence

- **Before:** `bun test webhooks` failed `retries once` after one attempt.
  **After:** the same test passes after two attempts.

Checks: `bun run check` passed; nothing pre-existing or unavailable.

## Merge danger

**Door:** `two-way`; reverting the merge restores single-attempt delivery.
**Blast radius:** webhook consumers that count delivery attempts.

---
[[Authored by Fable 5.1]]
[[Reviewed by Opus 5]]
