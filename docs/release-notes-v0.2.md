# microJBase v0.2 release notes

v0.2 adds an opt-in, least-privilege schema-management capability to the existing modular monolith. Operators can inspect schema state and operation history, run a constrained set of typed and audited schema mutations, manage exposure and predefined ownership policies, and use the dependency-free management UI. The ordinary auth and data API remains isolated from the admin route tree.

The admin surface is disabled unless both operator-token and schema-admin configuration pass startup capability probes. Mutations are idempotent, transactionally logged, serialized, dry-run aware, and compiled only from allowlisted typed commands. The durable exposure registry remains the sole runtime exposure source and RLS invariants fail closed.

Upgrade from v0.1 is forward-only. Back up the database first, apply migrations with the privileged migration URL, grant the documented runtime access, then start the v0.2 binary. See [release-checklist-v0.2.md](release-checklist-v0.2.md) for verification and rollback details, [admin-api.md](admin-api.md) for HTTP contracts, and [management-ui.md](management-ui.md) for UI operation.
