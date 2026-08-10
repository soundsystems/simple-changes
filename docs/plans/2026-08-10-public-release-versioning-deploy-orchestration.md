# Public release versioning and deploy orchestration plan

**Date:** 2026-08-10
**Status:** Proposed
**Scope:** Simple Changes receipt validation, Ship orchestration, approval
composition, resumability, deployment verification, and cross-repository
compatibility
**Companion plan:** `2026-08-10-public-release-version-policy.md` in the
Simple Changelogs repository

## Outcome

Teach Simple Changes to enforce a public-version decision made by Simple
Changelogs without becoming a second version-policy owner.

After implementation, a Ship run will:

1. finish and merge the selected feature units;
2. refresh the exact release-bearing target;
3. delegate release classification and version selection to Simple Changelogs;
4. consume a revision-bound version-decision receipt;
5. ask only for the unresolved version and production authorities;
6. merge a prepared release reconciliation only when the next consequential
   boundary is authorized;
7. deploy or verify the exact refreshed reconciled revision; and
8. resume safely without selecting another version or creating a duplicate
   deployment.

Simple Changes continues to own `productionDeploy: ask|allow|deny` and all
provider operations. It must not store or interpret the user's patch, minor,
or major preferences in `.simple-changes.json`.

## Product decisions

| Concern | Owner | Decision |
| --- | --- | --- |
| Public release detection | Simple Changelogs | Determine whether the affected train crosses a public release boundary. |
| Patch/minor/major classification | Simple Changelogs | Classify the aggregate target-contained release, following repository convention. |
| Automatic versus user-directed version selection | Simple Changelogs | Resolve from the current request, repository policy, or confirmed run-only choice. |
| Version suggestion | Simple Changelogs | Return the exact suggestion and supporting evidence when approval is required. |
| Integration capabilities | Simple Changelogs reports; Simple Changes negotiates | Prove supported request/receipt versions and features before delegation. |
| Delegation request | Simple Changes | Send a closed, phase-specific, revision-bound request without raw prompt text. |
| Production authority | Simple Changes | Resolve from the current request and `productionDeploy`. |
| Release reconciliation | Simple Changelogs authors; Simple Changes integrates | Accept only a validated, digest-bound handoff. |
| Final release verification | Simple Changelogs | Reinspect the merged target and prove release/version consistency at its new exact revision. |
| Deployment and live verification | Simple Changes | Deploy, promote, or verify the exact reconciled target and canonical endpoints. |
| Composite delivery receipt | Simple Changes | Bind the verified release transaction to the deployment result without copying policy. |
| Durable version preference storage | Simple Changelogs only | Never mirror the setting into `.simple-changes.json`. |

The two products share a versioned receipt contract. Sharing a protocol is not
shared policy ownership.

The companion repository stores the granular setting as
`.simple-changelogs.json.publicVersioning`, including `suggestWhenAsking`.
Simple Changes may report that a compatible policy owner was discovered, but
must not parse that object as deploy or version authority. Only the validated
receipt carries the decision into this workflow.

## Non-goals

- Do not add patch/minor/major settings to the Simple Changes policy.
- Do not let version approval imply production authority, or production
  authority imply version approval.
- Do not make an automatic preference a background deployment trigger.
- Do not use this policy for preview, staging, branch, or internal test
  deployments.
- Do not authorize mobile/store publication, package publication, remote build
  counters, migrations, secrets, environment changes, or DNS changes.
- Do not append pending work to a previously published release.
- Do not author changelog text or change version fields directly in Simple
  Changes.
- Do not parse human-readable changelog reasons to select the next action.
- Do not treat one repository as an atomic multi-product release set unless
  repository policy explicitly establishes that requirement.

## Integration capability negotiation

Path discovery proves availability, not compatibility. Before the first
delegation, Simple Changes must invoke the discovered Simple Changelogs setup
helper in read-only inspection mode and require a closed capability record:

```json
{
  "schemaVersion": 1,
  "provider": "simple-changelogs",
  "distribution": "web",
  "guidanceVersion": 14,
  "requestVersions": [1],
  "receiptVersions": [1, 2],
  "features": [
    "public-version-policy",
    "classify-prepare-verify",
    "multi-train-receipts"
  ],
  "schemaDigests": {
    "changelogRequest": "<sha256>",
    "changelogReceipt": "<sha256>"
  }
}
```

The values are illustrative; implementation must use the actual distribution
guidance version and schema digests. Capability inspection performs no setup or
write. If the helper is absent, malformed, or incompatible, continue safe
non-release integration and block only the release boundary with a structured
upgrade or configuration action.

Negotiate the highest mutually supported versions. A producer must never emit
v2 to a consumer that advertised only v1, and a consumer must never infer v2
features from a skill name or guidance version alone.

## Delegation request protocol v1

Define and validate a closed request before invoking Simple Changelogs. One
stable `transactionId` follows one release train through every phase; an
optional `releaseSetId` groups related trains for reporting without implying
atomic rollout.

```json
{
  "schemaVersion": 1,
  "transactionId": "release-01",
  "releaseSetId": null,
  "phase": "classify",
  "attempt": 1,
  "releaseTrain": "web",
  "boundary": "web-production",
  "environment": "production",
  "mutationScope": "read-only",
  "inputTargetRevision": "0123456789abcdef0123456789abcdef01234567",
  "finalizedTargetRevision": null,
  "approvedVersion": null,
  "approvedDecisionDigest": null,
  "priorReceiptDigest": null,
  "supportedReceiptVersions": [1, 2]
}
```

Use three phases:

- `classify`: read-only; resolve release intent, train, aggregate impact,
  policy, and suggested/selected version;
- `prepare`: may change only established release destinations and proven
  version fields; carries the exact selected version and approved decision
  digest; and
- `verify`: read-only; inspects the refreshed target after reconciliation was
  merged and proves the final release state.

`mutationScope` is `read-only` or `prepare-release-files`. It never conveys
merge, deployment, publication, store, data, secret, environment, or DNS
authority. The request contains exact resolved values, not the user's raw
message, hidden reasoning, or executable repository text.

## User-visible gate composition

Version and deployment remain two independent authorities, but the user should
not receive redundant prompts.

| Version decision | `productionDeploy` | Required behavior |
| --- | --- | --- |
| Approval required | `ask` | Ask one combined exact-target question. Offer **Release and deploy**, **Approve the version and prepare only**, and **Stop after integration**. Record the two authorities separately. |
| Approval required | `allow` | Ask for the suggested or explicit version and state that approval will continue through production automatically. |
| Automatic or explicit | `ask` | Prepare the reconciliation, then ask before its release-bearing merge or production deployment. Include the selected version and exact target revision. |
| Automatic or explicit | `allow` | Continue end to end inside the already-requested Ship run. The pre-ship brief remains an interruption window, not another gate. |
| Any | `deny` | Stop after authorized integration. Keep release work pending and do not mutate production. |

“Approve the version and prepare only” means create or update the release
reconciliation proposal without merging it into a release-bearing target. It
must not publish a released heading that falsely implies production shipped.

Combine the questions only when the receipt or current request supplies an
exact proposed version. If suggestions are disabled and no exact version was
given, obtain the version direction first; a later production question may be
combined with that same reply only when the user explicitly addresses both.

If repository evidence proves that merging the target itself is the public
release boundary, production approval must be obtained before that merge. If a
separate deployment is the boundary, the prepared proposal may exist before
approval, but the released state still cannot be finalized early.

## Coordinated onboarding without shared ownership

When a Ship-capable task discovers that both `.simple-changes.json` and the
applicable Simple Changelogs public-version policy are missing, present one
coordinated setup conversation instead of two consecutive questionnaires.
Simple Changes orchestrates the conversation; Simple Changelogs supplies a
structured list of only the version questions relevant to the discovered
release trains, its proposed policy summary, and its exact owner-controlled
destination.

The final confirmation must show the two independent policy destinations and
owners. After confirmation, invoke each owner's setup helper separately. Track
the coordinated setup as `pending`, `completed`, or `partial`; a valid write by
one owner is never rolled back because the other write failed. Resume inspects
both destinations, skips already-matching writes, and completes only the
missing or stale owner transaction. The orchestration record stores digests and
write receipts, not duplicate policy values.

Do not ask patch/minor/major questions when Simple Changelogs reports that no
public release train is applicable. Never mirror its answers into
`.simple-changes.json` or make either helper write the other product's policy.

## Changelog receipt protocol v2

### Compatibility rule

Add consumer support before Simple Changelogs starts emitting the new
contract. Simple Changes must accept both receipt versions during rollout:

- v1 remains valid for non-release changelog work and for verifying an exact
  release that was already reconciled before the protocol upgrade;
- v2 is required before selecting or forming a new public release under the
  configurable version policy; and
- a v1 producer that would need to choose a new production version blocks with
  an upgrade action after the enforcement phase begins.

Do not silently treat a v1 automatic bump as user approval.

### Required v2 transaction receipt

Extend the closed changelog receipt with the negotiated transaction, phase,
revision lineage, effective-policy digest, decision digest, and one nullable
`versionDecision` bound to one release train. Normal approval is
`decision-required`, not a failure:

```json
{
  "schemaVersion": 2,
  "provider": "simple-changelogs",
  "status": "decision-required",
  "transactionId": "release-01",
  "releaseSetId": null,
  "phase": "classify",
  "observedAt": "2026-08-10T12:00:00-05:00",
  "sourceRevision": "0123456789abcdef0123456789abcdef01234567",
  "revisionLineage": {
    "inputTargetRevision": "0123456789abcdef0123456789abcdef01234567",
    "reconciliationHeadRevision": null,
    "finalizedTargetRevision": null
  },
  "effectivePolicyDigest": "<sha256>",
  "decisionDigest": "<sha256>",
  "paths": [],
  "checks": ["Inspected the exact release-bearing target."],
  "evidence": ["The aggregate target-contained change is a compatible capability release."],
  "releaseImpact": "minor",
  "versionDecision": {
    "releaseTrain": "web",
    "boundary": "web-production",
    "currentVersion": "0.9.0",
    "bumpLevel": "minor",
    "suggestedVersion": "0.10.0",
    "selectedVersion": null,
    "policyAction": "ask",
    "resolution": "approval-required",
    "source": "repository-policy"
  },
  "release": null,
  "reasonCode": "version-direction-required",
  "requiredAction": "choose-version",
  "reason": "Approval is required before creating public version 0.10.0."
}
```

Use closed enums:

- `status`: `decision-required`, `prepared`, `verified`, `not-applicable`, or
  `blocked`;
- `phase`: `classify`, `prepare`, or `verify`;
- `boundary`: `release-bearing-merge`, `web-production`,
  `package-publication`, `store-release`, `other-public-release`, or `none`;
- `bumpLevel`: `none`, `patch`, `minor`, `major`, or `unknown`;
- `policyAction`: `ask`, `automatic`, or `not-applicable`;
- `resolution`: `not-required`, `automatic`, `explicit-direction`,
  `repository-automation`, `approval-required`, or `blocked`; and
- `source`: `current-request`, `repository-policy`, `run-only`, or
  `repository-convention`.

One receipt represents one release train. A Ship run covering independent
products requires one receipt per train rather than one ambiguous array with
partial approval. `releaseSetId` may group those receipts for reporting, but it
does not make the trains atomic.

### Structured reason and action taxonomy

Never branch on the human-readable `reason`. Define closed `reasonCode` and
`requiredAction` enums with at least:

| `reasonCode` | `requiredAction` |
| --- | --- |
| `version-direction-required` | `choose-version` |
| `target-moved` | `refresh-and-reclassify` |
| `policy-changed` | `refresh-and-reclassify` |
| `release-train-ambiguous` | `resolve-release-train` |
| `version-owner-ambiguous` | `resolve-version-owner` |
| `unsupported-protocol` | `upgrade-producer` |
| `unsupported-consumer` | `upgrade-consumer` |
| `schema-digest-mismatch` | `repair-integration` |
| `malformed-request` | `repair-request` |
| `malformed-policy` | `repair-policy` |
| `invalid-version-direction` | `choose-version` |
| `final-verification-failed` | `review-finalization` |

Allow `null` for both fields only when no action is required. New codes require
a protocol revision or an explicitly extensible namespaced error contract; do
not add ad hoc strings that older consumers might misinterpret.

### Cross-field invariants

The validator must enforce:

1. The receipt transaction, phase, train, boundary, and applicable revision
   equal the exact request Simple Changes delegated.
2. `decision-required` has `resolution: approval-required`,
   `policyAction: ask`, a null `selectedVersion`, and a
   non-null suggestion only when suggestions are enabled.
3. `automatic`, `explicit-direction`, and `repository-automation` have a
   non-null `selectedVersion`.
4. A `prepared` public-release receipt has a non-null reconciliation head and
   release record; its version equals `selectedVersion`, and its
   target-contained state is `prepared` rather than proof of a merged target.
5. `not-required` has `boundary: none`, `bumpLevel: none`,
   `policyAction: not-applicable`, null selected and suggested versions, and no
   new public release record.
6. `unknown` can never resolve automatically.
7. `store-release` never grants store submission authority.
8. The receipt's changed paths and SHA-256 digests retain the existing safety
   validation.
9. `verified` is read-only, has no changed paths, names the refreshed
   `finalizedTargetRevision`, proves `targetContainedUnreleased: integrated`,
   and matches the selected version and decision digest from `prepared`.
10. Any change to the effective version policy, release-train ownership,
    decision inputs, or target revision changes the appropriate digest and
    invalidates prior approval.

The receipt records a decision outcome, not prompt text, private reasoning,
credentials, or transient provider data.

## Ship release-gate state machine

Implement the release gate as three explicit, resumable protocol phases before
provider mutation:

```text
feature units merged
        |
refresh canonical target A
        |
negotiate Simple Changelogs capabilities + schema digests
        |
CLASSIFY (read-only request for A)
        |
        +-- not-applicable ----------> continue without public version gate
        |
        +-- decision-required -------> ask exact version/deploy question
        |                                  |
        |                                  +-- no answer -> preserve decision-required
        |                                  +-- direction -> bind approval to decisionDigest
        |
        +-- blocked -----------------> report reasonCode + requiredAction
        |
PREPARE (approved decision for A; release-file mutation only)
        |
validate prepared receipt + reconciliation head B
        |
merge reconciliation when authorized
        |
refresh canonical target C
        |
VERIFY (read-only request for C)
        |
require verified receipt for the same transaction + decisionDigest
        |
check production authority; deploy/promote/observe exact C
        |
write composite delivery receipt binding C to deployed revision D
```

Every target refresh after approval revalidates the effective policy and
decision inputs. A change to target A, the policy digest, release-train
ownership, schema negotiation, or selected version invalidates the decision
digest and its approval. Movement between reconciliation head B and refreshed
target C is expected only when C contains B; any other movement returns to
classification. Production authority is separately rebound to C.

## Deployment behavior

### Non-production environments

Preview, branch, staging, and internal test deployments do not invoke the
public-version gate. They still require authority from the current Ship request
or repository policy and must produce ordinary deployment receipts.

A publicly distributed prerelease is not an internal deployment merely because
its version contains `alpha`, `beta`, or `rc`; use the changelog receipt's
boundary classification.

### Existing live revision

Before creating anything, inspect production. When the exact refreshed,
reconciled target is already live and healthy, require a `verified` receipt for
that exact finalized target, then:

- reuse its existing release version;
- verify readiness, every canonical target, and the focused journey;
- write no new release decision and create no duplicate deployment; and
- report the run as verification of the existing immutable result.

### Failed deployment and retry

Persist enough local run evidence to make retries idempotent:

- a retry, promotion, or target repair of the same immutable reconciled
  revision and decision digest reuses the selected version;
- a provider failure does not cause another bump;
- a changed code or release-reconciliation revision invalidates reuse and
  returns to classification;
- an ahead or divergent production result remains drift, not success; and
- a completed deployment lacking a valid release receipt uses a forward
  reconciliation change rather than rewriting released history.

Every retry references the original transaction and decision digest. If either
cannot be validated against fresh target, policy, and provider evidence, return
to classification rather than inferring continuity from version text.

### Rollback and hot fix

Redeploying an exact previously released artifact retains its historical
version identity. A corrective code change is a new release and returns to
Simple Changelogs for a new decision, normally a patch unless repository policy
classifies it otherwise. Rollback execution remains a separately discovered and
authorized provider capability.

### Multiple products and canonical targets

Keep release trains distinct from canonical URLs:

- one release train may own several canonical endpoints;
- several independent products may require several version decisions and
  deployments;
- failure in one train must not falsely mark another train incomplete; and
- a requested all-or-nothing rollout must be established by repository policy,
  not inferred from a monorepo.

## Composite release-delivery receipt

After final release verification and deployment observation, Simple Changes
owns a composite receipt that links the version decision to what reached the
provider without copying Simple Changelogs policy:

```json
{
  "schemaVersion": 1,
  "transactionId": "release-01",
  "releaseSetId": null,
  "releaseTrain": "web",
  "version": "0.10.0",
  "decisionDigest": "<sha256>",
  "inputTargetRevision": "<revision-a>",
  "reconciliationHeadRevision": "<revision-b>",
  "finalizedTargetRevision": "<revision-c>",
  "deploymentReceiptId": "provider-receipt-01",
  "deployedRevision": "<revision-c>",
  "status": "complete",
  "reasonCode": null,
  "requiredAction": null
}
```

Use the closed status enum `complete`, `partial`, or `blocked`. A complete
receipt requires the verified changelog receipt, provider deployment receipt,
and observed revision to agree. `partial` records an interrupted multi-train
run without implying that grouped trains are atomic. This receipt is the source
for the final user report and retry correlation, not a new policy store.
Composite failures also use closed codes, including
`deployment-revision-mismatch` / `inspect-deployment` and
`provider-observation-incomplete` / `retry-observation`; never route a retry
from provider prose.

## Resumable run state

Add an optional `releaseDecisions` ledger to the existing run-state contract so
old run files remain readable. Each entry records only:

- transaction and optional release-set identifiers;
- current phase, attempt, release train, and boundary;
- input target, reconciliation head, finalized target, and deployed revisions;
- current, suggested, and selected versions;
- bump level, policy action, resolution, and source;
- whether version approval and production authority were obtained;
- negotiated request/receipt versions and schema digests;
- effective-policy, decision, request, and validated-receipt digests;
- structured status, reason code, and required action;
- reconciliation proposal/head identity when one exists; and
- the last completed release-gate boundary and composite delivery receipt.

Never persist the user's message, hidden reasoning, credentials, or a standing
approval beyond the exact target. On resume, compare the ledger with fresh Git,
provider, and receipt evidence before reusing it.

## Implementation work

### 1. Extend types and schemas

- [ ] Add receipt-v2 types and closed enums in
  `skills/simple-changes/scripts/lib/types.ts`.
- [ ] Add canonical
  `changelog-capabilities.schema.json`, `changelog-request.schema.json`, and
  `release-delivery-receipt.schema.json` contracts alongside the receipt
  schema; publish their SHA-256 digests for negotiation.
- [ ] Update
  `skills/simple-changes/evals/schemas/changelog-receipt.schema.json` to accept
  the explicit v1/v2 union and enforce the v2 cross-field rules with JSON Schema
  conditionals.
- [ ] Extend `skills/simple-changes/evals/schemas/run-state.schema.json` and the
  matching TypeScript state with the optional phased release-decision ledger,
  coordinated-onboarding transaction, and composite receipt.
- [ ] Keep `skills/simple-changes/scripts/lib/schema.ts` fail-closed for unknown
  receipt versions and properties.
- [ ] Add safe render/redaction helpers so release-train and version strings are
  displayed as data and never interpolated into commands.

### 2. Add a pure release-gate decision module

- [ ] Add `skills/simple-changes/scripts/lib/release-gate.ts`.
- [ ] Model decisions for continue, request-version-approval,
  request-production-approval, request-combined-approval, re-delegate,
  classify, prepare, verify, merge-reconciliation,
  verify-existing-production, deploy, and block.
- [ ] Bind every action to the exact target revision, environment, train, and
  selected version.
- [ ] Reject stale approvals, receipt/target mismatches, invalid retries,
  policy or schema-digest changes, multi-train ambiguity, and automatic
  `unknown` decisions.
- [ ] Model `decision-required` separately from `blocked` and route only by
  closed `reasonCode` and `requiredAction` values, never reason prose.
- [ ] Treat provider auto-deployment as evidence to inspect, not permission to
  create a second deployment.

### 3. Compose prompts and Ship communication

- [ ] Extend `skills/simple-changes/references/ship-communication.md` with the
  combined approval behavior and exact no-answer outcome.
- [ ] Add deterministic prompt rendering that names the suggested version,
  bump level, exact revision, release train, production environment, and what
  each option permits.
- [ ] Ensure `questions: never` skips unauthorized work and reports it; it must
  not reinterpret silence as version or production approval.
- [ ] Show automatic version selection in the pre-ship brief without adding a
  redundant confirmation gate.
- [ ] On completion, report version-decision source, final version, canonical
  target, full revision lineage, deployment identity, and any approval
  invalidation caused by target or policy movement.
- [ ] Add the coordinated one-conversation onboarding renderer and partial
  owner-write recovery without duplicating the changelog policy.

### 4. Integrate the release gate into Ship and Resume

- [ ] Update the Ship orchestration described in
  `skills/simple-changes/SKILL.md` and implemented by the CLI/run modules so
  changelog delegation occurs after the final feature merge against a freshly
  resolved target.
- [ ] Negotiate capabilities and schema digests before emitting a versioned
  request; distinguish absent, incompatible, and malformed providers.
- [ ] Emit a validated phase-specific request for `classify`, `prepare`, and
  `verify`; never pass raw user text as the inter-skill API.
- [ ] On `approval-required`, finish safe independent work, persist the exact
  boundary, and stop before release-bearing mutation.
- [ ] Feed an approved exact version back to the changelog workflow; do not edit
  release files in Simple Changes.
- [ ] Validate the prepared receipt, package only its recorded paths, merge the
  release reconciliation, and refresh the target again.
- [ ] Delegate a read-only final `verify` request after merge and require a
  matching `verified` receipt before any production release boundary.
- [ ] Re-run `loop verify` before each proposal, merge, deployment, promotion,
  and managed-target reconciliation mutation.
- [ ] Make Resume reconstruct the release gate from fresh state and the ledger
  without repeating approvals or provider operations.

### 5. Strengthen deployment verification

- [ ] Extend `skills/simple-changes/scripts/adapters/deployment.ts` inputs so a
  Web production verification can require the validated release-train/version
  binding for the same intended revision.
- [ ] Keep generic providers version-agnostic; the gate supplies the product
  release evidence.
- [ ] Verify no-op live deployments, exact-version retry, failed deployment,
  changed-target retry, rollback identity, and auto-deploy deduplication.
- [ ] Continue to require complete canonical-target inventory, readiness, exact
  observed revision, and focused smoke evidence.
- [ ] Emit the composite release-delivery receipt and prove its deployed
  revision matches the verified finalized target or records a non-complete
  status with a structured action.

### 6. Update portable guidance and documentation

- [ ] Update `skills/simple-changes/references/changelog-coordination.md` with
  capability negotiation, request v1, receipt v2, three-phase lifecycle,
  single-train scope, compatibility behavior, and policy ownership.
- [ ] Update `skills/simple-changes/references/deployments.md` with the composed
  gates and failure/retry rules.
- [ ] Update `skills/simple-changes/references/setup-and-policy.md` to state that
  public version preferences are discovered from Simple Changelogs, can be
  presented in one coordinated setup conversation, and are never stored in
  `.simple-changes.json`.
- [ ] Update `skills/simple-changes/SKILL.md`, `skills/simple-changes/SPEC.md`,
  and `README.md` with the concise user contract.
- [ ] Do not add a new Simple Changes onboarding question for patch, minor, or
  major behavior. When relevant, the changelog workflow owns that conditional
  question and storage receipt.

### 7. Add tests and evals

- [ ] Add `tooling/simple-changes/tests/release-gate.test.ts` for the pure state
  matrix.
- [ ] Extend `tooling/simple-changes/tests/schema.test.ts` with valid and invalid
  capability records, requests, v1/v2 receipts, composite receipts, and every
  cross-field invariant.
- [ ] Extend `tooling/simple-changes/tests/adapters.test.ts` with release-bound
  production verification and retry/no-op cases.
- [ ] Extend `tooling/simple-changes/tests/skill-contract.test.ts` with the
  ownership, combined-gate, and fail-closed protocol rules.
- [ ] Add behavior evals for all gate combinations, target movement after
  approval, suggestions disabled, old producer compatibility, independent
  trains, provider auto-deploy, failed retry, and mobile/store exclusion.
- [ ] Add version-skew tests for old consumer/new producer and new consumer/old
  producer, proving negotiation prevents an unsupported envelope from being
  emitted.
- [ ] Add interruption and chaos tests after classify, approval, prepare,
  reconciliation merge, provider mutation, and each owner-specific onboarding
  write; every resume must be idempotent.
- [ ] Add cross-repository fixtures that recalculate policy, decision, request,
  receipt, and schema digests and reject a single-field mismatch.
- [ ] Prove ordinary Queue and Integrate modes never finalize a version unless
  the target is independently established as release-bearing.

## Required test matrix

| Scenario | Expected result |
| --- | --- |
| Version ask + production ask | One combined prompt; no mutation before answer. |
| Version ask + production allow | Exact version prompt; approval continues through production. |
| Version automatic + production ask | Reconciliation may be prepared; release-bearing merge/deploy waits. |
| Version automatic + production allow | End-to-end Ship after the pre-ship brief. |
| Production deny | No production mutation regardless of version policy. |
| Suggestions disabled | Ask for explicit version without inventing one. |
| Target changes after approval | Invalidate and re-delegate; never reuse stale authority. |
| Policy changes after approval | Decision digest changes; reclassify and reacquire direction. |
| Normal version approval | `decision-required`, never `blocked`. |
| Capability version has no overlap | Block release work with `unsupported-protocol` and `upgrade-producer`; continue safe non-release integration. |
| Producer advertises unsupported schema digest | Do not emit a request; fail closed with a structured upgrade/repair action. |
| Prepared head not contained in finalized target | Final verification fails; never deploy. |
| Finalized target differs from verify request | Reject the receipt and refresh/reclassify. |
| Verify reports finalization failure | Preserve merged evidence, record `review-finalization`, and do not deploy. |
| Exact failed deployment retry | Reuse version and artifact/revision; no bump. |
| Retry contains new code | New version decision required. |
| Exact revision already live | Verify existing deployment; no duplicate. |
| Preview/staging | No public-version gate. |
| Public prerelease | Public-version gate applies. |
| Multiple independent trains | Separate receipts and outcomes. |
| Grouped release set with one failed train | Composite status is partial; successful independent train remains complete. |
| Legacy v1, non-release | Continue under v1 compatibility. |
| Legacy v1, new production version after enforcement | Block with upgrade action. |
| Old consumer + new producer | Producer negotiates down; it never emits an unreadable v2 receipt. |
| New consumer + old producer | Continue only within documented v1 compatibility. |
| Crash after classify/approval/prepare/merge/deploy | Resume from digests and fresh evidence without duplicate bump, merge, or deployment. |
| Second onboarding owner write fails | Preserve the first valid write and idempotently resume the missing write. |
| Store/mobile release | Require separate exact store authority. |

## Rollout order

1. **Consumer compatibility:** Release Simple Changes with capability,
   request-v1, receipt-v2, digest, run-state, and composite-receipt support
   while preserving documented v1 behavior.
2. **Producer capability rollout:** Release Simple Changelogs capability
   reporting and request validation before it emits v2 by default.
3. **Producer transaction rollout:** Enable classify/prepare/verify and v2
   receipts only after negotiation proves the consumer can read them.
4. **Verification enforcement:** Require a final verified receipt before a new
   public production boundary; continue v1 only for non-release work and exact
   already-reconciled retries.
5. **Cleanup:** Remove transitional diagnostics only after supported
   Simple Changelogs distributions all emit v2. Do not remove the explicit v1
   parser until the documented compatibility window closes.

The Simple Changes release must not claim the policy is supported end to end
until the companion Simple Changelogs release exists and the cross-repository
fixtures pass against both released artifacts.

## Verification

During implementation, run:

```sh
bun run typecheck
bun run lint
bun run test
bun run eval
bun run check
```

Also run a cross-repository fixture that validates an emitted Simple
Changelogs v2 receipt with the packaged Simple Changes CLI, followed by one
fully automatic Ship simulation, one approval-required simulation, version-skew
negotiation in both directions, and crash recovery at every transaction phase.

Release-note wording authored during implementation must follow the workspace
model rule: use `gpt-5.6-sol` at medium reasoning effort when available, and
state the actual fallback model if it is unavailable.

## Acceptance criteria

- [ ] `.simple-changes.json` contains no public-version policy.
- [ ] Simple Changes accepts a version-decision result only from a validated,
  revision-bound changelog receipt.
- [ ] Delegation uses a negotiated, schema-validated request; path detection or
  prompt prose is never the API.
- [ ] Classify, prepare, and final verify are distinct resumable phases.
- [ ] `decision-required` is user direction, while `blocked` is an operational
  or contract failure with a structured reason and action.
- [ ] Approval is bound to the effective-policy and decision digests and cannot
  survive a relevant policy, input, ownership, schema, or target change.
- [ ] Version and production approval remain independent internally.
- [ ] When both need approval, the user receives one clear combined question.
- [ ] A release-bearing reconciliation is never merged before its next required
  authority is available.
- [ ] Target movement invalidates stale version and deploy approval.
- [ ] Preview and staging never cause a public bump.
- [ ] Exact retries and already-live revisions never create a second bump or
  duplicate deployment.
- [ ] Independent release trains remain independent.
- [ ] Optional release-set grouping never implies atomic deployment.
- [ ] Mobile/store publication and other high-risk operations retain their
  separate authority gates.
- [ ] Resume is idempotent from fresh Git, receipt, and provider evidence.
- [ ] Coordinated onboarding uses one conversation but separate owner writes,
  and safely resumes a partial setup.
- [ ] A complete composite receipt links transaction, decision, full revision
  lineage, verified release, provider receipt, and deployed revision.
- [ ] The packaged skill, schemas, tests, evals, and documentation agree on the
  same protocol version and behavior.
