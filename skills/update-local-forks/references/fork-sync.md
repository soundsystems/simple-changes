# Fork sync

Contents:

- Install once, fork per repository
- How every file is classified
- Omitted references
- Command gates
- Classify what you port by hand
- Guidance versions
- After applying

## Install once, fork per repository

Install Simple Changes globally so every repository and every fork updates
from one source:

```sh
bunx skills add https://github.com/soundsystems/simple-changes --skill simple-changes -g
```

Install this skill beside it when at least one fork exists:

```sh
bunx skills add https://github.com/soundsystems/simple-changes --skill update-local-forks -g
```

Both commands use the read-only GitHub mirror of the GitLab repository.
Older Skills CLI releases, and lock entries without a recorded source URL,
re-resolve a stored source as GitHub shorthand, so a mirror install, which
records `sourceType: github`, is the one `skills update` refreshes with every
release; the installed files are identical either way.

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
| Changed reference | Omitted, not recorded | `unrecorded-omission` (holds the pin) |
| Changed reference | Omitted, recorded | `review` (confirm the recorded reason still holds) |
| Changed, not a reference | Omitted | `review` (confirm the omission still applies) |
| New runtime file | Absent | `add` |
| New reference | Absent, not recorded | `unrecorded-omission` (holds the pin) |
| New reference | Absent, recorded | `review` (confirm the recorded reason still holds) |
| New file, neither runtime nor reference | Absent | `review` (decide whether the fork carries it) |
| New | Present with other content | `conflict` |
| Removed | Unchanged | `delete` |
| Removed | Edited | `review` |
| `CHANGELOG.md` | Any | `skip` (the fork owns its own history) |
| Absent | Present | `keep-fork-only` |

Every write is byte for byte: an upstream version, a three-way merge, and a
literal rewrite keep each byte as upstream or the fork has it, invalid UTF-8
included, and a saved plan carries such content as base64. Apply checks each
file it writes, deletes, or rewrites against a digest of its raw bytes taken
at plan time. A plan saved by an earlier `update-local-forks` hashed and
stored decoded text instead. It still applies where every incoming and fork
file is valid UTF-8. Apply refuses it as changed since the plan when an
existing fork file is not valid UTF-8, but it cannot detect incoming content
that such a plan already decoded. Plan again instead of applying an earlier
plan whenever any incoming or fork file holds invalid UTF-8.

File names must be valid UTF-8. Planning refuses an installed source or a
fork that holds a path that is not, naming the path bytes in hex, and a
release tree that names one never verifies, so the pin never moves past a
file the plan cannot carry. Rename the file, then plan again.

The plan also moves the old provenance sha where the fork's own files outside
the runtime name it, as the exact string; nothing is inferred.
It never rewrites a version literal, `CURRENT_GUIDANCE_VERSION = <old>` or
`Simple Changes <old version>` (the old version is the pinned tree's
`SKILL.md` `metadata.version`, or its `CHANGELOG.md` top release when it
states none): whether a line states the fork's current
version, a minimum, or a past release is a maintainer's call. Instead, every
fork-owned line that names one becomes a `review` item giving the line, its
text, and a suggested replacement; change by hand each one that states the
current version. The suggestion replaces each occurrence of the old literal, so
a longer value that holds it, such as `0.25.10`, is listed too; leave it as
written. In practice the list is a version check or two in the fork's
`scripts/test.sh`. A file the plan writes, such as a merged `SKILL.md`, carries
the same list in its entry, and so does a conflicting file, for the lines it
keeps. A file the fork carries byte for byte from upstream, at the pin or in
the installed release, keeps upstream's bytes and is never listed, and neither
is a line of a fork-edited file that repeats upstream's text. Apply refuses a
plan saved by an earlier version that rewrites a version literal, or any
literal in a file that plan marks `current` from upstream, before writing
anything; plan again. The fork's own records keep the literal they were written
with, and are neither moved nor listed: a line naming a commit or version range
(`7ab67a1..628c66b`), and in Markdown every heading and every line of a history
entry or a history section.
An entry's heading names what it records: a commit, a range, or a date, as in
``## Upstream 0.24.1 (`628c66b..fd16f54`)``, ``### Fork fix: ... (pin
`fd16f54`)``, or ``## Canonical 0.12.4 (`1b7b7e7`)``. An abbreviated SHA
counts in backticks, after "pin" or "commit", or in parentheses, as in
`(pin deadbee)`; elsewhere a bare one must mix digits and letters. A heading
naming a history, such as `## History`, holds entries. A history log runs to the end
of its parent section, so every later section beside an entry is one too,
even when titled only by its subject. A heading that starts with "Current",
such as `## Current upstream (0.25.0)`, marks current state outside a history
section: its section stays a current claim and ends the log beside it. Keep
other current notes above the history. Only `#` headings are read; an
underlined (Setext) heading such as `History` over `=======` is plain text,
so title history sections and entries with `#`. A test that asserts such a
record stays matched to it.

## Omitted references

Forks leave out references on purpose, but an omission must be visible: a
reference upstream added or changed since the pin is new guidance the fork
otherwise never receives. A fork records each reference it leaves out under
`## Intentional omissions` in its own `references/fork-maintenance.md`, which
defines the record. A recorded omission is a `review` item quoting its
reason. An unrecorded one is an `unrecorded-omission`: the provenance pin and
`SKILL.md` stay on the old base, and `plan` and `apply` exit 3, until the fork
carries the file or records it. Other updates in the plan still apply.

## Command gates

Every rule above weighs one file on its own, which cannot see an invariant
that spans two. A fork that puts its own wrapper in front of the runtime has
copied the upstream command surface into a fork-owned file. When upstream adds
a command, the vendored runtime updates cleanly, the wrapper keeps its
`keep-fork-only` classification, and the new command stays unreachable through
the fork until somebody runs into the refusal.

So the plan compares the command surface at the pin against the surface in the
installed source, taking both the documented commands in the CLI help text and
the case labels of its dispatch switch. A fork-owned script or manifest that
lists three or more of the pinned commands close together reads as a gate. If
it does not name a command upstream added, it is reported as `review` naming
the command; the file itself is never written.

Prose is not a gate. Markdown is excluded outright, and the check measures how
many distinct commands appear within a short span rather than how many the file
mentions in total, so an eval suite naming a command per case stays
`keep-fork-only`.

The check reads what a file says, not what it enforces. A gate that loads its
allowlist from elsewhere, or matches by pattern, is invisible to it; a fork
that shape needs its own test. Commands upstream *removes* are not reported,
because a gate that still permits a retired command is refused by the runtime
anyway.

A `.upstream-merge` sidecar is the durable record of an unresolved conflict.
When `SKILL.md` conflicts or new-command gate review remains unresolved, the
provenance pin stays pending so a later plan cannot lose that review. Pending
command-gate review also keeps `SKILL.md` unchanged, avoiding a partial prose
merge against an old pin when planning again. Other clean runtime updates can
still apply. Otherwise the pin can
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
advance the pin unless the installed source is byte-identical to a commit of
that release on the canonical default branch: the commit that added the
release's changelog entry, or a later commit before the next release entry,
since review fixes often land after the release-prep commit. It prefers a
commit on the default branch's first-parent history, such as the merge that
brought the release in, over one only on a merged side branch. When no commit
in that range matches, the pin stays and the plan says why. The packaged
`CHANGELOG.md` carries only recent releases, so a later release that trims an
older release's heading out of it is never taken for that release's entry;
history is never rewritten, so the trimmed release's own tree still proves
byte identity.

Before that search, the planner tries the release tag `v<version>` (the
version the installed `SKILL.md` states in frontmatter `metadata.version`,
or, for a release before 0.27.0 that states none, the top release of its
`CHANGELOG.md`) as a shortcut. With
`--upstream`, it reads the checkout's own tag and never fetches into it;
otherwise it fetches only that tag into the cache's private
`refs/upstream-tags/` namespace at the branch fetch's depth, and both cache
fetches pass `--no-tags`, so the cache never collects other tags. The tag's
name proves nothing: its commit must be on the searched branch's first-parent
history and its packaged tree must pass the same byte-identity proof, and the
reason then reads `byte-identical tree at tag v<version> (<commit>)`. A
missing or unfetchable tag falls back to the search silently; a tag that fails
either check falls back too, and the reason says why it did not verify. The
pin still moves only to a verified commit.

## Guidance versions

The installed source's `CURRENT_GUIDANCE_VERSION` is the value forks pin in
their checks. When it moved, the fork's users will see one Simple Changes
update notice on their next write-capable run; the fork's maintenance note
should say what changed for that fork so the notice can be answered quickly.

## After applying

1. Run the fork's own checks (`scripts/test.sh` when present) and the
   repository's native checks.
2. Re-run `plan`; it should report no `update`, `merge`, `add`, `delete`, or
   `unrecorded-omission` actions and no pending pin rewrites. Change the
   listed version literals in the same update: once the pin moves, the old
   version is no longer the pinned one, so a later plan stops listing a line
   left as written.
3. Record the sync in the fork's maintenance note.
4. Hand the repository change to Simple Changes. This skill never commits,
   pushes, or opens proposals.
