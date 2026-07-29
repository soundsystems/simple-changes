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
- every material review-driven change, including the resulting exact revision
  and re-verification;
- checks and focused live verification;
- preserved, skipped, blocked, or outstanding work and the next action.

Do not report planned work as shipped. If the run stops before production, name
the highest completed boundary and the exact reason the remaining work did not
ship.
