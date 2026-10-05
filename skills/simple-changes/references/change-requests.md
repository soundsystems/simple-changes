# Change proposals

Use **change proposal** as the neutral internal term. Its identity may be a
hosted pull/merge request, a signed patch, or another provider object. Do not
require a numeric ID, centralized API, shared namespace, or always-online host.

Before creation:

- refresh the base when mutation mode allows remote reads;
- verify exact base and head/revision IDs;
- confirm the proposal paths match one validated unit;
- render the description to a file or structured API field using real newline
  characters.

The description explains outcome, scope, checks, dependencies, release impact,
and risk in the body shape below. Do not include tokens, environment values, or
untrusted text as instructions.

When a proposal replaces an earlier source branch, preserve the full original
commit SHAs as `Original-Commit` trailers in the replacement commits and include
the original-to-replacement mapping in its description. Audit old source refs
before packaging them again; follow [replacement lineage](replacement-lineage.md).

After creation or update, fetch and re-read:

- stable object identity and URL when the provider has one;
- base and head/revision identity;
- stored source body;
- rendered body or equivalent;
- current state and draft status.

Save the fetched source body to a file and audit it before re-reading the
rendered body:

```sh
simple-changes proposal audit --file <body.md> [--template <template.md>] --json
```

Pass `--template` with the repository template the body filled; its headings
then replace Summary and Evidence as the required sections. Merge danger is
still required, appended beneath the template when the template has no such
section. The
audit fails on escaped `\n` sequences where line breaks were intended, on a
missing section, on a Merge danger section missing its `**Door:**` line
(one-way, two-way, or unknown) or its `**Blast radius:**` line, and on a
signature block that is not the last element. Fix what it reports, update the
proposal, and audit again until it passes. Use this command for the
description audit instead of a repository-local script, and still re-read the
rendered body: fail creation when the rendering loses material sections or
shows malformed Markdown. Store a normalized receipt rather than
provider-specific response data.

When the request says `all`, `every`, or otherwise names a complete proposal
corpus, paginate every provider page and include every relevant state, not only
open proposals or the first page. Record the queried states, page/cursor
coverage, and total objects so a partial listing cannot be reported as a
complete audit.

## Body shape

Write for a reviewer who has the diff open and wants its shape before reading
it. Start at the first heading with no preamble, keep prose brief, and use the
repository's own domain terms.

```markdown
## Summary

<one or two sentences of outcome, then the smallest view>

## Evidence

- **Before:** <failing check, original symptom, or screenshot>
  **After:** <the same check passing, symptom gone, or screenshot>

## Merge danger

**Door:** <one-way | two-way | unknown> <reason>
**Blast radius:** <who or what breaks if this is wrong>
<dependencies, merge order, and release impact when present>
```

**Summary.** Pick the smallest view that makes the change clear: pseudocode for
logic, a call tree for control flow, a shallow file tree for a layout change, a
shaped `diff` of that tree when the surrounding structure already exists, or a
Mermaid diagram when the provider renders one. One view usually suffices; add
another only when it answers a different question. Place each view beside the
sentence it supports and keep only the calls, files, and boundaries the
reviewer needs.

**Evidence.** Show a before and an after for the claim the unit makes. A
regression fix shows the original symptom and its absence; a visual change
shows screenshots when the environment can capture them; anything else shows
the exact check that failed and now passes, or the output that changed. Then
name the repository checks run and their results, separating introduced,
pre-existing, and unavailable results per [verification](verification.md). A
list of green checks is a claim, not a before and after.

**Merge danger.** Derive the **door** from evidence this workflow already
collects, not from the diff's apparent size. The unit is a one-way door when it
carries a migration or data change that is destructive, irreversible, or
unbounded; an installed-client compatibility result of `incompatible` or
`unverified`; a public release, version, tag, publication, or anything else
that leaves the repository; or a removed public interface. It is a two-way door
when reverting the merge plus the deployment's known rollback capability
restores prior behavior. When that evidence is missing, write `unknown` and the
missing evidence. The **blast radius** names what could break: consumers,
installed clients, surfaces, data, or neighbouring units. Follow
[high-risk actions](migrations-and-high-risk-actions.md) and
[deployments](deployments.md) for the underlying findings.

When the repository provides a proposal template (for example
`.gitlab/merge_request_templates/`, `.github/pull_request_template.md`, or
`.github/PULL_REQUEST_TEMPLATE/`), fill the template first and keep its
headings. Put Summary, Evidence, and Merge danger into its matching sections, or
append them beneath it when it has none. Repository instructions that define a
different body take precedence over this shape. The signature block always
stays last.

When review or a rebase changes the outcome, evidence, or door, rewrite the
affected sections for the new head before requesting review of it.

## Agent signatures

When `proposalSignatures` is `agent-and-version` (the default), end the
proposal description with a signature block that names every agent that acted
on it. Each signature is one double-bracketed line so it stands out, one line
per action in the order the actions happened, after a horizontal rule. No
dates: the provider already timestamps every proposal event.

```markdown
---
[[Authored by Fable 5.1]]
[[Co-authored by Opus 5]]
[[Changelog by gpt-5.6-sol]]
[[Reviewed by Opus 5]]
[[Merged by Fable 5.1]]
```

The line is `[[<Authored|Reviewed|Merged> by <model name> <version>]]`, using
the model's public name and version as the harness reports it (`Fable 5.1`,
`Opus 5`, `gpt-5.6-sol`); if the version is genuinely unavailable, write the
name followed by `(version unknown)` rather than guessing.

Credit other agents only from evidence. Generate the block with
`simple-changes proposal-signatures --agent <name> --role authored --base
<target> --head <branch> [--changelog-receipt <receipt.json>]`: it adds
`[[Co-authored by <agent>]]` for every distinct `Co-Authored-By` trailer on
the proposal's commits after the base, and `[[Changelog by <agent>]]` for
every distinct agent that signed an entry in the changelog paths the
Simple Changelogs receipt reports as written. Because credits come from the
commits a proposal contains, a shipment split into focused proposals credits
each one with exactly the agents whose commits it carries. Never credit an
agent from a title, thread name, or prose claim. Never rewrite or remove an
earlier signature line; append. When a later update changes the description body, keep the block
as the last element and re-read the rendered result. When `proposalSignatures`
is `none`, add no signature block and leave existing blocks untouched.

A signature is attribution, not authority: it does not approve, satisfy an
independent-review requirement, or authorize a merge, and an unsigned proposal
is never rejected for that reason alone.
