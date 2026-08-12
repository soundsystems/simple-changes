# Ship communication

Ship combines consequential operations that may take time and may change during
review. Keep the user oriented with a pre-ship brief and a final delivery
receipt in the same agent run.

## Before the first consequential mutation

After fresh inventory, scope attribution, and plan validation, send a concise
progress update headed by the outcome rather than a permission question. Cover:

- **Ready scope:** the units, branches, proposals, and user-visible outcomes
  intended for this Ship run;
- **Path to production:** checks, proposal/merge order, release reconciliation,
  deployments, and focused verification that are actually in scope;
- **Consequential boundaries:** data changes, migrations, secrets, domains,
  store releases, or other separately authorized operations;
- **Preserved or blocked work:** anything discovered but not being taken over.

When the current request or stored policy already authorizes Ship, state that
the run is proceeding and continue in the same assistant turn. Do not turn this
brief into a redundant confirmation gate. It creates an interruption window:
if the user steers new information before a pending action, reevaluate the plan
and authority before continuing.

If production or another separately consequential step still lacks authority,
summarize the authorized portion, finish its safe independent work, and ask only
at the actual authority boundary.

## Emergency Ship communication

Name `expedited` or `break-glass` in the pre-ship brief and list the closed
evidence labels that produced the inference. Do not persist or replay the raw
request. Urgency-only language authorizes neither production nor post-deploy
review. A manually configured advanced `shippingMode: "break-glass"` may
authorize deploy-before-review ordering, but it still supplies no production
authority and does not waive rollback evidence. When active user impact or tested production readiness recommends
break-glass without authorizing it, continue safe expedited work and use one
concise blocking question at the deploy-before-review boundary.

When the current request explicitly says to deploy first or review after
deployment, state rather than re-ask the exact consequence: one checked,
revision-bound candidate may reach production before independent review, then
review and forward reconciliation begin immediately. Report the previous live
revision and rollback capability before deploying. Known provider-native
rollback is sufficient; do not delay break-glass with a current-production
lookup solely to manufacture an anchor identifier.

After the first deployment, use the durable status names verbatim:

- `live-unreconciled` for an expedited deployment awaiting release
  reconciliation;
- `live-unreviewed` for a break-glass deployment awaiting independent review;
- `rollback-required` when post-deploy review rejects the live candidate; and
- `canonicalized` only after reviewed Git and release state identify the final
  canonical revision.

None of these intermediate states is completion. The final summary must show
the candidate, deployed, and canonical revisions; review result; deferred work;
artifact-equivalence evidence when a duplicate deployment was avoided; and the
final verification and cleanup receipts.

## Compose version and production direction

Version selection and production deployment are separate authorities even when
one user-facing question can resolve both. When changelog classification returns
`decision-required` and production is also `ask`, present the suggested version,
bump evidence, exact release train and target revision, then offer:

- **Release and deploy:** approve the exact decision digest and production for
  the resulting finalized target;
- **Approve the version and prepare only:** permit release-file preparation but
  no release-bearing merge or production mutation; and
- **Stop after integration:** preserve release work without crossing the public
  boundary.

Record the two decisions independently. When suggestions are disabled, ask for
the exact version direction instead of inventing one. `questions: never` skips
unauthorized work and reports it; silence never becomes approval. Target,
policy, ownership, negotiated-schema, or decision-input movement invalidates
the affected approval and returns to classification.

## Track review-driven changes

Record the proposal's original reviewed head and maintain a small review delta
ledger:

- requested changes, material discussion decisions, and their source;
- new or replaced commits and the behavior or paths they changed;
- checks rerun after each revision;
- approvals invalidated and reacquired for the new exact head;
- merge, release, and deployment receipts that changed from the original plan.

Do not treat automated formatting, rebasing metadata, or unrelated concurrent
work as review-driven product changes. If review caused no code or behavior
change, say so explicitly.

## Final shipped summary

The final response compares the pre-ship brief with the observed result:

- what actually shipped and its user-visible or operational outcomes;
- proposal, merge, release, canonical-target, and deployment identities;
- the selected version and source, policy/decision digests, complete
  input/reconciliation/finalized/deployed revision lineage, and composite
  release-delivery receipt;
- every material review-driven change, including the resulting exact revision
  and re-verification;
- checks and focused live verification;
- preserved, skipped, blocked, or outstanding work and the next action.

Do not report planned work as shipped. If the run stops before production, name
the highest completed boundary and the exact reason the remaining work did not
ship.
