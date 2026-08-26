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
