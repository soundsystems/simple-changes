# Fork sync

## Install once, fork per repository

Install Simple Changes globally so every repository and every fork updates
from one source:

```sh
bunx skills add https://gitlab.com/soundsystems/simple-changes --skill simple-changes
```

Install this skill beside it when at least one fork exists:

```sh
bunx skills add https://gitlab.com/soundsystems/simple-changes --skill update-local-forks
```

A repository that needs stricter or product-specific behavior copies the
installed skill into its own directory (for example `skills/<project>-simple-changes`),
renames it, records the provenance pin under the title, and documents its
deltas. Two layouts are recognized:

- **In place**: the fork keeps upstream's `scripts/` and `evals/` where they
  are and edits files directly.
- **Runtime directory**: the fork moves upstream's `scripts/` and `evals/`
  under `runtime/` and keeps its own `scripts/` for wrappers and checks. The
  planner maps upstream runtime paths into `runtime/` automatically.

## How every file is classified

| Upstream | Fork | Action |
| --- | --- | --- |
| Unchanged since the pin | Unchanged | `current` |
| Unchanged since the pin | Edited | `keep-fork-delta` (never touched) |
| Unchanged since the pin | Omitted | `omitted` |
| Changed | Unchanged | `update` (upstream version written) |
| Changed | Edited on different lines | `merge` (three-way result written) |
| Changed | Edited on the same lines | `conflict` (file untouched; marked merge written to `<file>.upstream-merge`) |
| Changed | Omitted | `review` (confirm the omission still applies) |
| New runtime file | Absent | `add` |
| New non-runtime file | Absent | `review` (forks omit references on purpose) |
| New | Present with other content | `conflict` |
| Removed | Unchanged | `delete` |
| Removed | Edited | `review` |
| `CHANGELOG.md` | Any | `skip` (the fork owns its own history) |
| Absent | Present | `keep-fork-only` |

The plan also rewrites exact literals the fork pins in its own files outside
the runtime: the old provenance sha, `CURRENT_GUIDANCE_VERSION = <old>`, and
`Simple Changes <old version>`. Only those exact strings change; nothing is
inferred.

A `.upstream-merge` sidecar is the durable record of an unresolved conflict.
When `SKILL.md` conflicts, the provenance pin stays pending; otherwise it can
advance with the rest of the update. Every later plan reports the conflicted
file as `review` until the sidecar is merged in and deleted.
Never leave conflict markers inside a live skill file.

## Classify what you port by hand

Use the same rules as the canonical fork-maintenance reference:

- **portable**: apply the generic behavior;
- **locally overridden**: keep the fork's stricter documented policy and adapt
  only the surrounding portable text;
- **not applicable**: omit behavior outside the fork's forge, data,
  deployment, or release surface, and say so in the fork's maintenance note;
- **upstream candidate**: a generally useful fork improvement belongs in the
  canonical package; propose it there instead of letting the fork drift.

Never bump a pin to an uncommitted upstream tree. The planner refuses to
advance the pin unless the installed source is byte-identical to a commit that
introduced that release on the canonical default branch.

## Guidance versions

The installed source's `CURRENT_GUIDANCE_VERSION` is the value forks pin in
their checks. When it moved, the fork's users will see one Simple Changes
update notice on their next write-capable run; the fork's maintenance note
should say what changed for that fork so the notice can be answered quickly.

## After applying

1. Run the fork's own checks (`scripts/test.sh` when present) and the
   repository's native checks.
2. Re-run `plan`; it should report no `update`, `merge`, `add`, or `delete`
   actions and no pending literal rewrites.
3. Record the sync in the fork's maintenance note.
4. Hand the repository change to Simple Changes. This skill never commits,
   pushes, or opens proposals.
