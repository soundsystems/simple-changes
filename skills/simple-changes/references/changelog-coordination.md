# Changelog coordination

Simple Changes owns integration; a compatible changelog workflow owns release
classification, wording, policy, signatures, version alignment, and edits to
release-note destinations.

## Detect relevance and capability

Treat changelog coordination as relevant when repository evidence includes an
established changelog surface or a compatible changelog skill. The deterministic
CLI recognizes `.simple-changelogs.json`, `CHANGELOG.md`,
`DEVELOPER_CHANGELOG.md`, and repository-local or configured
`simple-changelogs` skill roots.

Keep these states distinct:

- **relevant and available**: delegation can run;
- **relevant but unavailable**: preserve the paths and report the missing skill;
- **not relevant**: do not add a setup question or invent release surfaces.

## Apply the preference

- `delegate-if-available`: invoke the compatible workflow when present;
  otherwise preserve and report the work.
- `preserve-and-report`: never invoke a changelog workflow automatically.
- `ask`: finish independent work, then ask before delegation.

The preference grants coordination behavior, not permission to invent release
intent, create new destinations, publish a release, change a version, or bypass
the changelog workflow's own authority checks.

## Require a handoff receipt

The changelog workflow returns a closed `changelog-receipt` contract containing:

- provider and exact source revision;
- `prepared`, `not-applicable`, or `blocked` status;
- every changed relative path and its SHA-256 digest;
- release-impact classification, checks, evidence, and any blocking reason.

Validate the receipt with:

```sh
simple-changes validate changelog-receipt <receipt.json>
```

For `prepared`, verify every path is safe, belongs to the current stable
worktree, still matches its recorded digest, and is limited to the delegated
unit. Re-inventory after delegation because the external workflow changed the
working state. Package the changelog unit only after repository-native checks
pass.

For `not-applicable`, preserve any pre-existing changelog edits that the receipt
does not explicitly account for. For `blocked`, continue independent units and
report the exact missing capability, authority, evidence, or decision.

Never treat an installed skill name, a policy file, or a receipt alone as proof
that file contents are current and safe.

## Web production release gate

A production deployment of a Web product is always a product release. Preview,
branch, staging, and internal test deployments do not cross this boundary.

After the final feature merge and before production:

1. Refresh the canonical deployment target and delegate changelog
   reconciliation against that exact revision.
2. Require the workflow to classify every nonempty `Unreleased` customer and
   developer item by target containment. Every target-contained item must enter
   one dated, versioned release and every established Web mirror and proven
   product-version field must be integrated with it.
3. For a `prepared` receipt, require a non-null `release` record naming the
   version and date and reporting `targetContainedUnreleased: "integrated"`.
   Its checks and evidence must identify the inspected target and account for
   any item that remains pending as absent from that target or assigned to a
   different unshipped train.
4. Package and merge the release reconciliation. Refresh the canonical target
   again and verify the recorded version, released headings, established
   mirrors, and proven version metadata are present and no target-contained item
   remains under `Unreleased`.
5. Deploy only that refreshed reconciled target.

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
