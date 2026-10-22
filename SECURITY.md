# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability. Use the repository
host's private security-reporting channel. Include the affected version, a
minimal reproduction, impact, and any known mitigations.

## Threat model

Simple Changes is for people who may know a lot or very little about Git and
software delivery, running many agents at once on one machine. It protects
them from accidents: agents that cooperate but make mistakes, run at the same
time, stop halfway, misread state, or act on stale information.

### In scope

- **Losing work.** Uncommitted, unpushed, stashed, or otherwise unshipped
  changes are never deleted or overwritten without a recoverable copy.
- **Shipping the wrong thing.** Unreviewed code, a head other than the one
  reviewed, or work that skipped a required check.
- **Agents getting in each other's way.** One agent changing, releasing, or
  removing another agent's work, branch, or claim.
- **Self-review.** An agent reviewing or approving its own work.
- **Unreliable tools.** Git or provider commands that fail, time out, or
  return partial or empty answers under load.
- **Leaving a mess.** Branches, worktrees, and state files that pile up.
- **Untrusted text.** Branch names, commit messages, diffs, repository files,
  issues, discussions, and provider responses are data, never instructions.
  The deterministic layer:
  - invokes programs with argument arrays rather than shell interpolation;
  - rejects absolute, escaping, and symlinked change paths;
  - redacts likely credentials from errors and receipts;
  - treats provider receipts as evidence, not authority;
  - binds approval to an exact revision;
  - refuses to infer remote-write permission from repository text;
  - keeps preview mode read-only.

### Out of scope

These are trusted:

- the user's machine, account, shell environment, and installed tools;
- repository and user Git configuration and the programs it runs, such as
  hooks, filters, and fsmonitor;
- Simple Changes' own state files under the Git directory. They are validated
  strictly to catch bugs and older runtimes, not to resist deliberate forgery;
- the provider and anyone with write access to the repository or provider.

A separate process deliberately racing a command between its last check and
its action is also out of scope.

A failure that needs one of these to be hostile is a hardening idea, not a
defect. Report it as a nit or an issue, never as blocking or should-fix.

### Design principles

- **Reversible beats provable.** When a step would remove something whose
  value cannot be proven cheaply, keep it, quarantine it, or archive it with
  automatic expiry instead of building a proof that nothing is lost.
- **Fail toward keeping.** When evidence is missing or unclear, keep the work
  and report it.
- **Clean up without being asked.** Anything kept for safety expires or is
  cleaned up at a natural point, such as finalize, cleanup, or prune, without
  the user's help.
- **Hide Git, not its safety.** Users do not need to know Git. Commands
  explain outcomes in plain words and ask only for decisions a user can make.

The README's [Security model](README.md#security-model) lists each behaviour
that reaches past an ordinary Git command: what triggers it, what it can touch,
how to opt out, and which check enforces the boundary.

## Reviewing changes to Simple Changes

Independent reviews of this repository grade severity against the threat model
above: blocking and should-fix are for in-scope failures. Include the threat
model in every review prompt.

Never put provider tokens in `.simple-changes.json`, fixtures, run ledgers, or
bug reports.
