# Ship communication

Ship combines consequential operations that may take time and may change during
review. Keep the user oriented with a pre-ship brief and a final delivery
receipt in the same agent run. Apply
[plain-language communication](user-communication.md): explain scope, meaning,
and next action before internal workflow terms or exact audit evidence.

## Before the first consequential mutation

After fresh inventory, scope attribution, and plan validation, send a concise
progress update headed by the outcome rather than a permission question. Keep
it to the shortest message that covers:

- **Ready scope:** the units, branches, proposals, and user-visible outcomes
  intended for this Ship run;
- **Path to production:** checks, proposal/merge order, release reconciliation,
  deployments, and focused verification that are actually in scope;
- **Consequential boundaries:** data changes, migrations, secrets, domains,
  store releases, or other separately authorized operations;
- **Preserved or blocked work:** anything discovered but not being taken over.

If completed, verified work is blocked only because a different task owns the
active shipping controller, include this choice instead of stopping at a
deployment disclaimer: **Do you want me to ask that agent to fold this work
into the active shipment, or should I wait until that shipment finishes and
ship this separately afterward?** Do not contact the other task or assume a
selection before the user answers.

If opening local changes exist, the brief must be the summary returned after
`loop record-scope --receipt <change-plan.json>`. Do not push an early subset
and audit the other worktrees afterward. The recorded plan must first account
for every changed path across the primary checkout and all linked worktrees.
Safety-lease `preserved` status protects a checkout from mutation or deletion;
it does not prove that finished work is unrelated or excluded.
For each included unit, show a short feature/outcome description, its branch or
detached revision, and its source worktree. List preserved and excluded work in
separate short sections. Refine generic directory-based planner labels before
recording scope so the user sees “Resend contact delivery” rather than
“repository-level changes.”
Overlapping paths are normal integration work. Reconcile them once, run the
scoped checks, and report the combined outcome; do not ask the user to choose
between finished implementations unless their intended behavior truly
conflicts.
Before the final delivery receipt, record the exact shipment
outcome. Keep its user-facing summary short: name reviewed additions or external
target changes, but do not dump path-entry hashes unless the user asks.

When the current request or stored policy already authorizes Ship, state that
the run is proceeding and continue in the same assistant turn. Do not turn this
brief into a redundant confirmation gate. It creates an interruption window:
if the user steers new information before a pending action, reevaluate the plan
and authority before continuing.

If any consequential step still lacks authority, inventory all unresolved
boundaries already knowable from the validated Ship plan before the first one
blocks progress. Present one permission checklist rather than serial prompts.
Each item must name an ID, the action, exact repository/provider/project/
environment target, consequence, and reason. Include, when known, Git export,
release-version selection, merge, production deployment, migration apply,
secret or environment writes, DNS changes, store releases, remote cleanup, and
history rewrites. Let the user approve all listed items, decline all, or approve
named IDs in one reply, then record each decision independently.

The bundle is not blanket authority. It cannot authorize an unlisted action,
different target, changed revision, force push, protection bypass, credentials,
or provider-administrator operation. Do not repeat a still-valid approval. Ask
again only when later evidence reveals a genuinely new boundary or invalidates
an approved target, revision, command, or decision digest. Host sandbox and
network approval dialogs may still be enforced separately by the harness; the
workflow should nevertheless front-load every product/user decision it can
already prove.

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

Open with what shipped, not with how it shipped. The first line after the
status names the actual change in plain language: the behavior, fix, or
capability that is now live and who it affects, using each shipped unit's
recorded outcome from the plan, refined into a real product statement. This
lead is required even when no changelog entry was written and no customer
notes apply: a merge identity, a green check list, and a resolving domain
prove the shipment happened, but none of them say what it was. A receipt whose
reader cannot answer “what is different now?” is incomplete regardless of how
much evidence it carries.

The final response then compares the pre-ship brief with the observed result:

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
ship. Lead with the practical outcome; place required revisions, digests, and
receipt identities afterward instead of making the user decode them first.
Never leave internal cross-references such as “Annotation 1” or footnote
markers that resolve nowhere in the message, and state what evidence supports
the shipment rather than listing evidence that was deliberately not relied on;
if a disclaimer matters, say its practical consequence in one sentence.

Avoid a receipt that proves the shipment but never names the product:

> Shipped and live.
>
> - Merged MR !802 to `main` (`fe464b46`).
> - Production is READY: the canonical domain resolves to the new deployment.
> - Guarded rollout, build, lint, typecheck, tests, and two exact-head
>   independent reviews passed.

Prefer the same receipt led by the actual change:

> Shipped and live: duplicate link submissions are now repaired automatically
> instead of returning an error, and the resolver no longer drops the query
> string on short links.
>
> - Merged MR !802 to `main` (`fe464b46`); production verified at the
>   canonical domain.
> - Guarded rollout, build, lint, typecheck, tests, and two independent
>   reviews of the exact merged head passed.
> - No customer notes this run: the release train consolidates into the next
>   public version.

When the run finalizes or reconciles a public release, end with **Latest customer
notes**: two to five practical notes summarized from the public notes for the
exact selected version in the delivery receipt. Group them under a few useful
customer-facing areas when appropriate, and render each note as a Markdown
blockquote (`>`) rather than another operational bullet. This is a concise
customer recap, not a second audit log. Exclude developer notes, signatures,
unreleased sections, and changes from newer releases. Omit it for internal-only
or `release:none` work.
If production is still blocked, report that first and make clear that the notes
describe the reconciled release rather than a completed deployment.
