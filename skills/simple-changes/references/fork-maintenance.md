# Fork maintenance

Project forks may add stricter repository-native behavior without changing the
generic contracts. Record provenance directly below the fork title:

```md
Forked from `simple-changes` @ `<short-sha>`. <project>-specific deltas:
<local policy, provider boundaries, commands, release surfaces, ...>
```

Keep that delta map small and include:

- upstream package version or commit;
- local policy and reference additions;
- project-native verification, changelog, parity, data, and release hooks;
- provider/deployment adapter overrides;
- intentional deviations with tests.

Do not copy product-specific commands or rules into the generic core. Keep local
rules in clearly owned references and link them from the fork's router.

After every edit to a fork, run `simple-changes skill check` from the fork's
own runtime (`--skill-dir <fork>` checks another copy). It fails when skill
discovery would skip or misread the fork: frontmatter that is not strict YAML,
a name that is not a spec name matching the fork's directory, a description
outside 1 to 1,024 characters, Claude Code and Codex invocation settings that
disagree with `agents/openai.yaml`, or a relative link in `SKILL.md` or
`references/` that does not resolve. Use it instead of a fork-local
frontmatter or link script, and keep the fork's behavior tests.

The canonical Simple Changes source repository includes a maintainer drift
checker under `tooling/simple-changes/`. It is intentionally absent from the
installed skill. In a source checkout, run:

```sh
tooling/simple-changes/check-fork-sync.sh \
  /path/to/fork/SKILL.md /path/to/simple-changes origin/main
```

Exit `0` means current, `1` means the canonical skill has newer commits, `2`
means invalid input, and `3` means the histories diverged. The explicit
repository and ref are optional when the checker runs inside the canonical
checkout.

The installable `update-local-forks` skill from the same package automates
this loop for every fork on a machine: it plans each fork against its pinned
base and the globally installed skill, applies portable changes, keeps fork
deltas, three-way merges shared edits, reports conflicts and omitted
references, and advances the pin only to the verified release commit. Prefer
it over hand-porting. When updating by hand from upstream:

1. fetch and verify the canonical default branch;
2. run the checker and review the entire canonical diff from the old pin;
3. classify upstream contract changes;
4. reapply the documented local delta;
5. run both canonical contract tests and project behavior tests;
6. update provenance only after review and verification.

## Downstream classification

Use the generic inventory, concurrency, proposal, review, authority, deployment,
surface-parity, cleanup, and completion invariants as the parity baseline.
Canonical deployment parity includes exhaustive expected-target coverage and
bounded existing-artifact promotion/managed-target reconciliation; a downstream
domain verifier may specialize discovery and commands but must not weaken that
contract. Classify every upstream change before editing a downstream package:

- **portable**: apply the generic behavior;
- **locally overridden**: preserve a stricter documented policy and adapt only
  the surrounding portable behavior;
- **not applicable**: omit behavior outside the downstream product's supported
  forge, data, deployment, or release surface;
- **upstream candidate**: propose a generally useful downstream improvement to
  the canonical package instead of allowing silent divergence.

Run the canonical drift checker for an existing provenance pin and review the
full upstream range even when it reports only one changed file. If a downstream
package already expresses a portable rule more strictly and its tests cover it,
make no semantic edit. Never bump a provenance pin to an uncommitted upstream
tree or, when a canonical remote exists, a revision not on its default branch.

The source repository's Simple Changelogs-derived release-note module has a
separate provenance check under `tooling/simple-changes/`. It is
maintainer-only and is never bundled into this installed skill.
