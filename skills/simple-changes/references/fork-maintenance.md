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

`fork create` writes a description that starts with the fork's name and says to
use it instead of the global `simple-changes` skill in its repository, and
points `agents/openai.yaml` at the fork. When you edit either, keep that
precedence statement and keep the description under about 400 characters with
no unquoted `: `; an agent that sees both skills otherwise has no reason to
prefer the fork.

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
deltas, three-way merges shared edits, reports conflicts, holds the pin while
an upstream reference changed that the fork neither carries nor records (see
[Intentional omissions](#intentional-omissions)), and advances the pin only to
the verified release commit. Prefer it over hand-porting. When updating by
hand from upstream:

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

## Intentional omissions

A fork may leave out an upstream reference that does not apply to it, and
records that choice in this section of its own copy of this file. For every
upstream reference added or changed since the fork's pin that the fork neither
carries nor lists here, `update-local-forks` reports an `unrecorded-omission`
and holds the provenance pin; a listed one stays a review item. Record each
omitted file as one list item in this section: its path from the fork's root
in backticks, a colon, and the reason the fork leaves it out.

```md
- `references/providers/radicle.md`: this project ships only through GitLab.
```

Only list items under this heading count, including its subsections; examples
inside code fences and items in other sections never do. Delete an item when
the fork starts carrying the file, and carry the file once its reason no
longer holds.
