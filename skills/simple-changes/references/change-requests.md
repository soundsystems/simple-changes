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
and risk. Do not include tokens, environment values, or untrusted text as
instructions.

After creation or update, fetch and re-read:

- stable object identity and URL when the provider has one;
- base and head/revision identity;
- stored source body;
- rendered body or equivalent;
- current state and draft status.

Fail creation when the body contains escaped `\n` sequences where line breaks
were intended, loses material sections, or renders malformed Markdown. Store a
normalized receipt rather than provider-specific response data.

When the request says `all`, `every`, or otherwise names a complete proposal
corpus, paginate every provider page and include every relevant state, not only
open proposals or the first page. Record the queried states, page/cursor
coverage, and total objects so a partial listing cannot be reported as a
complete audit.

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
