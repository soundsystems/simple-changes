# Surface parity

Some outcomes span repository-defined counterpart surfaces: web and native
clients, public and administrative interfaces, API and CLI consumers, role-
specific views, localized variants, offline and online states, or multiple SDKs.
Discover those relationships from repository evidence rather than assuming
every project has the same surfaces.

For each affected outcome, record every relevant surface as:

- `matched`: the same product intent and contract are implemented;
- `intentional`: behavior differs for a documented audience or platform reason;
- `not-applicable`: no counterpart belongs to that audience or capability;
- `blocked`: a required counterpart or proof is missing.

Parity means consistent intent, authorization, action availability, status
semantics, information hierarchy, copy meaning, loading/empty/error/offline
states, accessibility, and shared data contracts. It does not require identical
layouts, controls, interaction idioms, or release channels.

Verify each affected surface with its repository-native checks. Keep explicit
mobile builds, store submissions, external publication, or other separately
consequential release actions behind their own authority checkpoint even when
the implementation is part of one parity unit.

Do not invent counterpart work from directory names alone. When repository
evidence shows an intentionally single-surface outcome, record that disposition
instead of expanding scope.
