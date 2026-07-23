# Focused units

A focused unit describes one user-visible outcome. Group by behavior,
dependency, data boundary, ownership, and independently verifiable value—not by
file count, directory convenience, or commit count.

For each unit record:

- stable ID and plain-language title;
- outcome;
- exact relative paths;
- source checkout/branch;
- dependencies and merge order;
- exclusions and preserved paths;
- proportionate checks;
- release impact;
- counterpart-surface parity dispositions when the repository defines related
  clients, roles, locales, interfaces, or SDKs;
- required authority and proposed operations.

Every changed path must appear exactly once across units, preserved concurrent
work, paused work, or explicit exclusions. Reject duplicates, missing paths,
absolute paths, `..` traversal, paths outside the canonical checkout, and
symlinks.

Prefer one unit when changes share an outcome and must ship together. Split when
they are independently valuable or carry distinct review, data, ownership, or
deployment risk. Make dependencies explicit instead of combining unrelated
work.

When deterministic grouping cannot infer a meaningful outcome, it may propose a
conservative unit and say why. A model may refine the plan, but the bundled
validator still owns path conservation and authority enforcement.
