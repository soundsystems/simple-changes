# Changelog coordination

Contents:

- Detect relevance, then negotiate capability
- Apply the preference
- Use a closed three-phase transaction
- Require a handoff receipt
- Shared version lines
- Operator-history entry handoff
- Web production release gate

Simple Changes owns integration; a compatible changelog workflow owns release
classification, wording, policy, signatures, version alignment, and edits to
release-note destinations.

## Detect relevance, then negotiate capability

Treat changelog coordination as relevant when repository evidence includes an
established changelog surface or a compatible changelog skill. The deterministic
CLI recognizes `.simple-changelogs.json`, `CHANGELOG.md`,
`DEVELOPER_CHANGELOG.md`, the CMS-only `.simple-changelogs-cms.json` and
`CMS_CHANGELOG.json`, and every `simple-changelogs*` installation name
(including `simple-changelogs-cms`) under repository-local or configured skill
roots.

Keep these states distinct:

- **relevant and available**: delegation can run;
- **relevant but unavailable**: preserve the paths and report the missing skill;
- **relevant but not applicable**: every discovered provider declares a
  discovery-only marker (empty `requestVersions` and `receiptVersions`) and so
  implements no handoff. Report it as discovered with
  `capabilityStatus: "not-applicable"`, preserve its files, and never delegate
  release classification to it. `simple-changelogs-cms` is not such a
  provider: it owns a version-less operator history and takes the entry-only
  handoff described below;
- **not relevant**: do not add a setup question or invent release surfaces.

Availability is not compatibility. Before delegation, obtain the provider's
read-only `changelog-capabilities` record and negotiate the highest shared
request and receipt versions. Compatibility is decided by that version overlap;
every request and receipt is then validated against the packaged schema at the
moment it is used, which is what actually enforces the contract. A missing
helper or unsupported version blocks only the release boundary; safe non-release
integration may continue.

Negotiation ignores versions and features this consumer does not know, so a
provider may advertise newer ones without breaking it. Simple Changes 0.13.0
and later ignore unknown versions (earlier releases reject them, so
advertising request v2 or receipt v3 needs every controller at 0.13.0 or
later), but releases before 0.23.0 reject any feature outside their closed
list, so a provider must not advertise `shared-version-lines` in a repository
until every Simple Changes controller there, including fork copies, is 0.23.0
or later.

Advertised schema digests are advisory. When both sides publish them, record
`schemaDigestStatus` as `match`, `differs`, or `unadvertised` so drift stays
observable, and mention a `differs` result alongside any later validation
failure. Do not block a version-compatible peer on digest inequality: a
cosmetic schema edit would otherwise stop an otherwise working integration.

Never infer compatibility from a path, skill name, or prose. A provider
declares itself in a machine-readable `changelog-provider.json` beside its
`SKILL.md`, carrying at least `schemaVersion`, `provider`, `distribution`, and
`guidanceVersion` in the `changelog-capabilities` shape. Prefer that marker for
distribution matching and installed-guidance comparison. Only when no marker is
installed may discovery fall back to the installation directory name and
SKILL.md prose, and it must then report `providerEvidence: "inferred"` rather
than presenting a guess as a declaration. A discovery-only marker advertises
empty `requestVersions` and `receiptVersions`; never negotiate a handoff with
it. When a handoff-capable provider and a discovery-only provider are both
installed, the handoff-capable one is selected.

Installed-update detection is a narrower read-only pre-loop check, not
capability negotiation. Compare the selected provider's declared current
guidance version with `.simple-changelogs.json`, or with
`.simple-changelogs-cms.json` when that is the only policy file present (its
presence alone selects the `cms` distribution). When a request requires
changelog work and the installed version is newer, route the update notice and
disposition to Simple Changelogs before starting the Simple Changes integration
loop. Do not acquire a loop lease and later pause it for this conversation.

## Apply the preference

- `delegate-if-available`: invoke the compatible workflow when present;
  otherwise preserve and report the work.
- `preserve-and-report`: never invoke a changelog workflow automatically.
- `ask`: finish independent work, then ask before delegation.

The preference grants coordination behavior, not permission to invent release
intent, create new destinations, publish a release, change a version, or bypass
the changelog workflow's own authority checks.

## Use a closed three-phase transaction

Create one `changelog-request` per release train with a stable transaction ID,
exact boundary and target revision, phase-specific mutation scope, prior receipt
digest, and negotiated receipt versions. The request contains resolved values,
never raw user text. `attempt` and `environment` are optional, informational
fields: the provider checks their shape when present and never stores, echoes,
or keys retries on them, so transaction identity rests on the transaction ID,
phase, revisions, and prior receipt digest alone.

1. `classify` is read-only and returns `decision-required`, `classified`,
   `not-applicable`, `blocked`, or an exact selected version. `classified` is
   the entry-only outcome that proceeds directly to `prepare`.
2. `prepare` is the only phase allowed to change established release files. It
   requires the approved version and decision digest and returns a prepared
   reconciliation-head revision.
3. After the reconciliation merge, refresh the canonical target and delegate
   read-only `verify`. Require `verified` for the same transaction, decision
   digest, version, and full input/head/finalized revision lineage.

Treat `decision-required` as normal user direction, not an operational failure.
Route only on closed `reasonCode` and `requiredAction`; human-readable reasons
are display text.
Reject `decision-required` when aggregate impact is `none`. Internal-only,
developer-only, preview, staging, and DX patches must return `not-applicable`
and continue without asking for a hypothetical public version, even when a
repository package happens to have an obvious next patch number.

## Require a handoff receipt

The changelog workflow returns a closed `changelog-receipt` contract containing:

- provider and exact source revision;
- negotiated protocol version, transaction, phase, release train, and full
  revision lineage;
- effective-policy and decision digests that invalidate stale approval;
- `decision-required`, `classified`, `prepared`, `verified`, `not-applicable`,
  or `blocked` status;
- every changed relative path and its SHA-256 digest;
- release-impact classification, checks, evidence, and any blocking reason.

Validate the receipt with:

```sh
simple-changes validate changelog-receipt <receipt.json>
```

Then bind it to the delegated request. For every phase after the first, pass
the receipt the request builds on so its digest is proven against the
request's `priorReceiptDigest`; a mismatch fails closed. Without
`--prior-receipt`, the result reports `priorReceiptDigestStatus: "unverified"`
instead of proof:

```sh
simple-changes validate-changelog-transaction <request.json> <receipt.json> \
  --prior-receipt <prior-receipt.json>
```

For `prepared`, verify every path is safe, belongs to the current stable
worktree, still matches its recorded digest, and is limited to the delegated
unit. Re-inventory after delegation because the external workflow changed the
working state. Package the changelog unit only after repository-native checks
pass.

For `verified`, require zero changed paths and an exact finalized target. For
`not-applicable`, preserve any pre-existing changelog edits that the receipt
does not explicitly account for. For `blocked`, continue independent units and
report the exact missing capability, authority, evidence, or decision.

Never treat an installed skill name, a policy file, or a receipt alone as proof
that file contents are current and safe.

## Shared version lines

A monorepo may keep two or more release trains (for example `web`, `ios`, and
`android`) on one shared public version line. The changelog workflow owns the
policy and the number; the protocol only carries the decision so Simple
Changes can bind it. It needs request v2 and receipt v3, and the negotiated
versions alone decide whether it is available. The `shared-version-lines`
feature is optional and informational: negotiation reports it, but nothing
gates on it. A provider may leave it out until it gates real behavior; one
that advertises it must still wait until every controller in the repository
is 0.23.0 or later.

- **Request v2** adds `releaseSetTrains`: every train released together from
  one input target revision under one `releaseSetId`, or null. It is null
  whenever `releaseSetId` is null, includes the request's own `releaseTrain`,
  and lets `supportedReceiptVersions` include 3. Request v1 still works
  unchanged.
- **Receipt v3** is receipt v2 plus `releaseSetTrains`, which must echo the
  request, and `versionDecision.versionLine`: null for an independent train,
  otherwise `mode` (`catch-up` or `bump-shared`), `members` (the line's
  trains, sorted), `memberVersions` (each member's latest stable public
  version at the input target revision, or null), `sharedVersion` (the line
  head H: the highest of those, or null), `sharedVersionTrains` (the members
  holding H, sorted; empty when H is null), and `outcome` (`catch-up` or
  `advance`). A train that skips a number releases nothing and has no
  receipt.

`validate-changelog-transaction` checks a v3 receipt beyond the schema:

- `members` names the releasing train, and `memberVersions` names exactly the
  members;
- `sharedVersion` and `sharedVersionTrains` are recomputed from
  `memberVersions`;
- `catch-up` takes exactly H, and only for a train below H;
- `advance` exceeds H, or H is null; `bump-shared` always advances. A train
  that reclassifies after a partner released must advance past it or start a
  new release set, because `memberVersions` cannot tell a release inside the
  set from one before it;
- the proposed version exceeds the train's own previous version and is not
  below a stable `currentVersion` (the version owner's value, which may
  already be bumped). It is the
  suggestion on `decision-required` and the selection on `classified`,
  `prepared`, or `verified`; a `blocked` or `not-applicable` receipt gets only
  the structural checks and keeps its closed-code routing.

Versions compare as one to three dotted numbers, zero-padded (`1.2` equals
`1.2.0`), with `+build` metadata ignored; any other version on a line fails
closed. The receipt's `decisionDigest` must cover the line state (`mode`,
`members`, `memberVersions`, and `sharedVersion`), so a release on another
member changes it and invalidates an outstanding approval. The `outcome` may
change under the same digest, because an approved direction can turn a
catch-up into an advance. When the prior receipt is supplied, a later phase
whose line state changed under the same digest fails closed.

A multi-train release set stays non-atomic: each train keeps its own request,
receipt, and phases, and a train that fails later reclassifies on its own.
After the receipts of one release set exist, check them together:

```sh
simple-changes validate-changelog-release-set <receipt.json> <receipt.json>...
```

It requires receipt v3 from one release set, input target revision, and train
list (in any order), at most one receipt per train, and each train on at most
one line, carried by its own receipt. Every receipt on one line must agree on
the line state, compared by value, and publish one identical version string.
Trains with no receipt yet are reported as `missingTrains`, not refused. That no two members of a `bump-shared` line ever share a
number outside one release set is the changelog workflow's `verify`
invariant; Simple Changes cannot see other trains' released sections.

## Operator-history entry handoff

The `simple-changelogs-cms` distribution owns a version-less operator history
(`CMS_CHANGELOG.json`) and no public release files. It is a full handoff
participant, but its transaction is entry-only: it never classifies, selects,
or reconciles a version, tag, or public note. A change to the CMS surface
still produces its operator entry at ship time and is verified before merge,
exactly as the other distributions write theirs.

Create its request with `boundary: "none"` and `releaseTrain: "cms-operators"`.
`approvedVersion` stays null in every phase; `approvedDecisionDigest` still
binds `prepare` and `verify` to the classification.

- `classify` answers whether the change is operator-relevant.
  `not-applicable` with `releaseImpact: "none"` means no operator entry is
  needed; continue without one. An operator-relevant result returns
  `classified` with the decision digest and classified impact; the gate answers
  `re-delegate`, so proceed to `prepare` without requesting version or
  production approval.
- `prepared` carries `release: null`, `releaseImpact` as classified,
  `versionDecision` either null or `bumpLevel: "none"` with
  `resolution: "not-required"`, and `paths` listing the changed
  `CMS_CHANGELOG.json` with its digest. The gate answers
  `merge-reconciliation`: package and merge the entry like any other
  reconciliation.
- `verified` carries `release: null` and proves through
  `revisionLineage.reconciliationHeadRevision` and
  `finalizedTargetRevision` that the finalized target contains the entry. The
  gate answers `continue`, never `deploy`; `release-delivery` is not involved
  because no deployment belongs to operator history.

A `prepared` or `verified` receipt may omit its release record only on the
`none` boundary. The receipt does not carry the boundary, so
`validate-changelog-transaction` binds it: a public boundary that receives a
version-less receipt, or a `none` boundary that receives a version, fails
closed.

## Web production release gate

A production deployment of a Web product is a product release. Preview,
branch, staging, and internal test deployments do not cross this boundary.

After the final feature merge and before production:

1. Refresh the canonical deployment target, negotiate capabilities, and
   classify against that exact input revision.
2. Require the workflow to classify every nonempty `Unreleased` customer and
   developer item by target containment. Every target-contained item must enter
   one dated, versioned release and every established Web mirror and proven
   product-version field must be integrated with it.
3. For a `prepared` receipt, require a non-null `release` record naming the
   version and date and reporting `targetContainedUnreleased: "prepared"`.
   Its checks and evidence must identify the inspected target and account for
   any item that remains pending as absent from that target or assigned to a
   different unshipped train.
4. Package and merge the release reconciliation. Refresh the canonical target
   again and request final read-only verification. Require `verified`,
   `targetContainedUnreleased: "integrated"`, the same decision digest and
   version, and proof that the finalized target contains the reconciliation
   head.
5. Deploy only that verified finalized target and bind the verified changelog
   receipt to the provider receipt with `simple-changes release-delivery`,
   which composes the `release-delivery-receipt` from both sources.

Decide each boundary with `simple-changes release-gate --request <file>
--receipt <file> [--prior-receipt <file>] --production ask|allow|deny [--already-live]
[--production-authorized] [--version-authorized] --json`. Its `action`
(`continue`, `request-version-approval`, `request-production-approval`,
`request-combined-approval`, `merge-reconciliation`,
`verify-existing-production`, `deploy`, `stop-after-integration`,
`re-delegate`, or `block`) is the decision; do not re-derive it from the
receipt prose.

The gate takes its flags on trust and grants no authority, so no printed
action, including `deploy`, is permission. Take each flag only from its
source:

- `--production`: only the effective `productionDeploy` as
  [setup and policy](setup-and-policy.md) resolves it. A repository `allow`
  without its local trust receipt counts as `ask`, and current user
  direction never raises the value above `ask`; a user's production approval
  goes in `--production-authorized`.
- `--production-authorized`: only explicit current-request production
  authority for this exact target, under the production-authority rules in
  this skill's [SKILL.md](../SKILL.md) and
  [ship communication](ship-communication.md#compose-version-and-production-direction),
  never your own inference.
- `--version-authorized`: only an explicit user version decision bound to
  this receipt's decision digest.
- `--already-live`: only fresh provider evidence that the exact verified
  finalized target is live.

Route on the printed `action`, not the exit code: every decision, including
`block`, exits 0. A nonzero exit means the inputs were rejected and nothing
was decided, which blocks the boundary.

When a prepare or verify request names `priorReceiptDigest`, pass that exact
receipt with `--prior-receipt`; the gate blocks merge and deployment while the
lineage is unverified.

A `not-applicable` receipt satisfies this gate only when its evidence proves the
exact refreshed target already contains a dated, versioned release
reconciliation with no target-contained pending work. `blocked`, unavailable,
preserve-and-report, version ambiguity, an unmerged reconciliation, or an
unaccounted pending item blocks production but does not erase independently
completed integration work.

An exact retry or promotion may reuse a release version only when the immutable
target was already reconciled into that version. If production already happened
without this gate, leave the deployment incomplete and prepare a forward
release-reconciliation change; do not rewrite deployed history to hide the gap.
