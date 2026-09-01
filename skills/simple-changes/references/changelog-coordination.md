# Changelog coordination

Simple Changes owns integration; a compatible changelog workflow owns release
classification, wording, policy, signatures, version alignment, and edits to
release-note destinations.

## Detect relevance, then negotiate capability

Treat changelog coordination as relevant when repository evidence includes an
established changelog surface or a compatible changelog skill. The deterministic
CLI recognizes `.simple-changelogs.json`, `CHANGELOG.md`,
`DEVELOPER_CHANGELOG.md`, and repository-local or configured
`simple-changelogs` skill roots.

Keep these states distinct:

- **relevant and available**: delegation can run;
- **relevant but unavailable**: preserve the paths and report the missing skill;
- **not relevant**: do not add a setup question or invent release surfaces.

Availability is not compatibility. Before delegation, obtain the provider's
read-only `changelog-capabilities` record and negotiate the highest shared
request and receipt versions. Compatibility is decided by that version overlap;
every request and receipt is then validated against the packaged schema at the
moment it is used, which is what actually enforces the contract. A missing
helper or unsupported version blocks only the release boundary; safe non-release
integration may continue.

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
than presenting a guess as a declaration.

Installed-update detection is a narrower read-only pre-loop check, not
capability negotiation. Compare the selected provider's declared current
guidance version with `.simple-changelogs.json`. When a request requires
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
never raw user text.

1. `classify` is read-only and returns `decision-required`, `not-applicable`,
   `blocked`, or an exact selected version.
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
- `decision-required`, `prepared`, `verified`, `not-applicable`, or `blocked`
  status;
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
   receipt to the provider receipt in a `release-delivery-receipt`.

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
