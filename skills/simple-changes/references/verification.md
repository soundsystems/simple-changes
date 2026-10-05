# Verification

Use repository-native evidence to select checks:

1. Read documented scripts, CI configuration, affected package boundaries, and
   existing tests.
2. Run the narrowest meaningful checks while iterating.
3. Before proposal or merge, run the complete checks required by repository
   policy for the affected surfaces.
4. When a check fails, fix what it reports and re-run it; repeat until it
   passes or the failure is proven pre-existing. Re-run checks after any
   code-changing fix.

Capture an opening failure baseline when the repository is already dirty or
checks are known to fail. Distinguish:

- failure introduced by the unit;
- pre-existing failure unchanged by the unit;
- environment/configuration failure;
- unsupported or unavailable check capability.

Do not label a failing required job acceptable because it looks unrelated.
Provider policy decides whether it blocks merging. Do not infer success from
missing, skipped, stale, or incomplete jobs.

For regression fixes, verify the original symptom. Tests, type checking,
format/lint, build, migrations, and smoke checks prove different claims; one
cannot stand in for another.

To enforce a check at the moment of an integration command, such as a green
hosted pipeline before a merge, a repository can declare an `execGuard` that
runs before every `loop exec` child; see
[setup and policy](setup-and-policy.md).
