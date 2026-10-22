# Harness-aware Git push authorization

`gitPushAuthorization` records workflow intent. It does not itself grant network
export, sandbox escape, credentials, or administrator-managed permission. Before
the first push in Queue, Sweep, Integrate, Ship, Reconcile, or Resume, apply the
saved intent to the current harness and the verified repository remote.

## Closed preference values

- `configure-harness`: after the user confirms this preference, detect the
  current harness and offer or write only its narrowest repository-scoped,
  destination-bound persistent push rule. Re-read the effective setting. If the
  harness cannot persist such a rule, return the exact manual next action.
- `ask`: leave harness settings unchanged and request approval at each push
  boundary.
- `never`: do not push and do not request or write push permission. Stop with
  local work ready.

`release-tag` pushes one release tag from inside its own command, so it is a
push boundary too: under `ask`, get the same approval as for a branch push
before applying it; a `configure-harness` rule for `git push` does not match
it, so the harness may still prompt for the `release-tag` command; and under
`never` it refuses before any write and prints the exact commands for the
user.

Never translate `configure-harness` into blanket shell access, permission for
every remote, credential storage, or authority to force-push. Resolve the exact
remote name and URL from current Git configuration first. Repository ownership,
the user request, branch protections, and provider permissions remain separate
gates.

## Required confirmation copy

Whenever the user selects `configure-harness` or asks colloquially for “auto
push” (during onboarding, an update notice, or any later run), explain and
confirm this exact consequence before saving:

> Automatic Git pushes let Simple Changes request the harness's narrowest
> persistent permission for ordinary `git push` to this one verified repository
> and remote, avoiding repeat host prompts. It does not grant credentials,
> network access, force-push, branch-protection bypass, proposal/merge/deploy
> authority, or permission for another destination. If the harness cannot
> express that exact scope, Simple Changes must keep asking. Save this setting?

The explanation and confirmation apply across Codex, Claude Code, and every
other harness; only the harness-specific mechanism differs.

## Codex

Prefer a reusable approval for the exact `git push <remote>` command prefix when
the host exposes an approval UI. In a trusted repository that intentionally
stores project-local Codex rules, use a narrow `.codex/rules/` rule matching the
verified remote rather than a general `git` or shell allow rule. Re-read the
effective rule before relying on it.

Codex rules can remove repeat command approval prompts, but they do not override
network restrictions, sandbox policy, credentials, managed requirements, or an
administrator denial. Follow the official Codex rules and approval/security
documentation for the installed Codex version.

## Claude Code

Prefer the uncommitted project-local `.claude/settings.local.json` file when the
user wants the permission only for this checkout. Add the narrowest
`permissions.allow` matcher for `Bash(git push <verified-remote> ...)`; preserve
all existing settings and validate the JSON afterward. Do not add broad
`Bash(git *)`, shell, or distributed skill `allowed-tools` permission.

Claude deny and ask rules, sandbox restrictions, managed settings, credentials,
and provider policy still win. Follow the official [Claude Code permissions](https://code.claude.com/docs/en/permissions)
contract.

## Other harnesses

Probe for all of these capabilities before changing anything:

1. a project- or repository-scoped persistent permission store;
2. a matcher narrow enough to bind `git push` to the verified remote;
3. an observable effective-setting readback;
4. a user-confirmation or approval mechanism.

When all are supported, configure the narrow rule and verify it. When any are
missing, do not guess a settings path or syntax. Report the unsupported
capability and provide a manual next action. Continue local checks and packaging
that do not require push permission.

Some harnesses forbid an agent from editing its own permission or allowlist
files at all; user approval in chat does not lift that guard. That refusal is
correct behavior, not a failure: provide the exact lines and the exact file for
the user to add themselves, then continue the work that needs no new
permission.
