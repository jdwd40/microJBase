# Architecture Decisions

Accepted decisions bind the milestone under which they were accepted: D-001 through D-009 bind v0.1, and D-010 onward bind the v0.2 plan. Additions use the next number; existing entries are not rewritten to hide history.

## D-001 — Build a focused backend, not a small Supabase clone

**Status:** Accepted 2026-09-19

microJBase provides basic auth and safe SQL CRUD only. Storage, realtime, edge functions, analytics, OAuth, and a dashboard are excluded. Each extra subsystem would weaken the low-footprint and low-maintenance goal.

## D-002 — Use PostgreSQL as the only stateful dependency

**Status:** Accepted 2026-09-19

PostgreSQL is already familiar, durable, widely hosted, and provides transactions, constraints, and RLS. SQLite would reduce server overhead but complicate concurrent remote access and diverge from the intended SQL service model.

## D-003 — Use one Node.js/TypeScript modular monolith

**Status:** Accepted 2026-09-19

One process is simpler to deploy and measure than multiple services. Internal modules and frozen ports let different agents work independently. We use one npm package and directory boundaries rather than workspaces, which would add build/configuration overhead without runtime isolation.

## D-004 — Use Fastify directly; do not use PostgREST

**Status:** Accepted 2026-09-19

PostgREST is capable but would add another process and split authentication/authorisation across components. Fastify supplies mature routing, validation, and structured logging in the existing process. `pg` remains the only database client.

## D-005 — Use opaque database-backed sessions, not JWTs

**Status:** Accepted 2026-09-19

A random bearer token plus a stored SHA-256 digest gives immediate logout/revocation, requires no signing-key lifecycle, and removes a runtime dependency. The database lookup is acceptable for a small self-hosted service. JWTs may be revisited only with measured need.

## D-006 — PostgreSQL RLS is the final row-access boundary

**Status:** Accepted 2026-09-19

The API authenticates users and sets a transaction-local PostgreSQL identity. RLS policies decide row access. This keeps data isolation close to the data and avoids duplicating ownership conditions in every CRUD query. Startup checks fail closed if an exposed table or runtime role is unsafe.

## D-007 — Expose only configured tables and a fixed CRUD surface

**Status:** Accepted 2026-09-19

There is no arbitrary SQL endpoint. Public aliases map to verified schema/table names at startup. v0.1 supports list/get/create/update/delete with limit/offset only; general filters, joins, ordering, and RPC are deferred.

## D-008 — Separate migration and runtime privileges

**Status:** Accepted 2026-09-19

The migration role owns objects and may perform DDL. The API runtime role is restricted, is not superuser, and lacks `BYPASSRLS`. Using one privileged connection in production would silently undermine RLS.

## D-009 — No email verification

**Status:** Accepted 2026-09-19

Email is a login identifier only; microJBase does not claim that an address is deliverable or owned by the user. Applications needing verified identities require another service or a future explicit module.

## D-010 — Preserve the modular monolith and the no-arbitrary-SQL rule in v0.2

**Status:** Accepted 2026-09-21

v0.2 keeps one Node process, one PostgreSQL database, and the existing module boundaries. Application clients never send arbitrary SQL; schema management is expressed as typed commands compiled by one audited DDL layer inside the server.

## D-011 — Keep three distinct PostgreSQL privilege lanes

**Status:** Accepted 2026-09-21

The restricted runtime data role (`DATABASE_URL`), the explicit migration command role (`MIGRATION_DATABASE_URL`, never used by request handlers), and the optional schema-admin role (`SCHEMA_DATABASE_URL`) stay separate. The schema-admin role connects as a non-superuser, non-`BYPASSRLS` PostgreSQL role that owns every table it mutates. It may be the same PostgreSQL role as `MIGRATION_DATABASE_URL`, but the connection URL remains a separate request-time surface and must never be the restricted runtime role (`DATABASE_URL`). Create/alter operations leave ownership on that owner role. Expose/unexpose applies least-privilege `GRANT`/`REVOKE` for the runtime role and fails closed when required grants are missing. Policy management executes only as the table owner, never via superuser escalation or `SET ROLE` to a superuser. The schema-admin role is used only by the disabled-by-default admin/schema module.

## D-012 — Admin/schema API is opt-in and disabled by default

**Status:** Accepted 2026-09-21

The admin/schema API is enabled only when both a schema-admin database URL and an operator-token SHA-256 digest are configured. Configuring exactly one of the two fails startup; with neither, the module is inert. It uses a separate `/v1/admin/schema` route tree and a small bounded admin pool.

## D-013 — Single operator bearer token with SHA-256 digest verification

**Status:** Accepted 2026-09-21

Admin authorization is one operator bearer token whose SHA-256 digest is configured as `MICROJBASE_ADMIN_TOKEN_SHA256` and checked with constant-time comparison. The raw token is never stored, logged, or accepted in ordinary user/session auth. No accounts, roles, email, OAuth, or another auth platform is added.

## D-014 — Typed schema commands compiled by one audited DDL layer

**Status:** Accepted 2026-09-21

Schema operations are typed commands compiled by a single audited DDL layer. HTTP handlers never construct SQL. Values remain parameterised where PostgreSQL permits; identifiers are accepted only after conservative validation and are quoted by the audited helper. Defaults use a typed allowlist/template model, not arbitrary SQL: the initial templates are a typed literal, `current_timestamp` (emitting `CURRENT_TIMESTAMP` only for `timestamp`/`timestamptz`), and `random_uuid` (emitting `gen_random_uuid()` only for `uuid`).

## D-015 — Destructive commands require explicit confirmation

**Status:** Accepted 2026-09-21

Destructive schema commands require an explicit confirmation value and refuse internal schemas and objects. An exposed table must be unexposed before destructive mutation.

## D-016 — Read-only schema introspection precedes mutation

**Status:** Accepted 2026-09-21

Read-only schema introspection ships before any schema mutation. It reports schemas/tables, columns/types/defaults/nullability, primary/foreign/unique constraints, indexes, owners, and RLS state without changing the database.

## D-017 — Controlled schema commands are transactional, idempotent, and recorded

**Status:** Accepted 2026-09-21

Controlled schema commands are transactionally executed when PostgreSQL supports it, protected by idempotency/replay keys, recorded in durable operation history, and serialized with the reserved schema-DDL advisory-lock key `7921890504698152930`, distinct from the migration runner key `7921890504698152929`. No arbitrary migration SQL upload or normal-client SQL endpoint is introduced.

## D-018 — Database existence and API exposure are separate states

**Status:** Accepted 2026-09-21

v0.2 introduces a durable exposure registry and an explicit, tested migration path from `MICROJBASE_TABLES`. After the one-time import, the durable registry is the sole runtime exposure source: `MICROJBASE_TABLES` cannot add tables at runtime and cannot re-expose a table after an admin unexpose. Internal schemas and tables are permanently ineligible for exposure.

## D-019 — RLS management starts with predefined ownership templates

**Status:** Accepted 2026-09-21

RLS management begins with named read, insert, update, and delete ownership templates around `microjbase.user_id`. Arbitrary policy SQL is out of scope.

## D-020 — Admin API lands last; no GUI in this queue

**Status:** Accepted 2026-09-21

The admin API is added only after internal services are stable. A GUI is not part of this queue; the final wave ends with a stable backend contract ready for a lightweight GUI.

## D-021 — Schema catalogue reads one pinned snapshot and fail-closed mapping

**Status:** Accepted 2026-09-21

The V02-01 schema-catalogue reader issues exactly one static read-only statement per read and pins `search_path` to `pg_catalog` transaction-locally inside that statement: a `MATERIALIZED` pin CTE executes `pg_catalog.set_config` once before the outer query, and the catalogue `UNION` renders inside a `LATERAL` subquery that outer-references the pin in every branch, so `format_type`/`pg_get_expr` rendering cannot execute ahead of the pin on any planner path. One statement gives one PostgreSQL snapshot (no cross-connection stitching under concurrent DDL) and deterministic rendering regardless of the caller's `search_path`; the pin is transaction-local, so pooled sessions are never mutated. Rows are validated strictly before mapping — fields of other row kinds must be null, duplicate schema/table/column keys and orphan rows fail closed — because a catalogue that fabricates or silently drops metadata is worse than one that refuses to answer. Generated columns report `generated: "stored" | "virtual"` (PostgreSQL 18 `attgenerated 'v'`) with `defaultExpression` always null, and `baseType` is the immediate `pg_type.typbasetype` of a declared domain, which may itself be a domain.

## D-022 — Constraint and index introspection extend the same single pinned statement

**Status:** Accepted 2026-09-24

V02-02 extends the V02-01 statement with `pg_constraint` and `pg_index` branches instead of adding separate queries, preserving one-statement/one-snapshot semantics: constraints and indexes are read under the same pinned snapshot as tables and columns, so concurrent DDL cannot stitch together a constraint list that never existed. The branch filter admits only `contype IN ('p','u','f','c','x')`; PostgreSQL 18's NOT NULL constraint entries (`contype 'n'`) are excluded because nullability is already reported per column, and output must stay identical between PostgreSQL 16 CI and newer servers. Check constraints always report an empty column list because PostgreSQL 18 populates `conkey` for checks while PostgreSQL 16 does not, and a catalogue that reports different shapes per server version cannot be a stable contract. Constraint-backed indexes (primary key, unique, exclusion) are excluded from the index list via `pg_constraint.conindid` so they are never double-reported alongside their constraint; expression index columns report `null` placeholders for expression positions so they are never misrepresented as plain column lists. Check and exclusion constraints and expression/partial indexes are explicitly classified read-only metadata — reported and classified, never silently dropped and never implied manageable.

## D-023 — Schema snapshots assemble catalogue, migration history, and exposure state read-only

**Status:** Accepted 2026-09-24

V02-03 assembles immutable, deterministically ordered snapshots from the catalogue reader, one additional fixed read-only statement against `microjbase.schema_migrations`, and the injected v0.1 `TableRegistry`. The migration-history table is written only by the migration command, so reading it in a second statement cannot stitch together a state management would misread; `applied_at` renders as a fixed-format UTC ISO-8601 string so snapshots are byte-stable regardless of session timezone. Internal schemas (`microjbase`, `pg_catalog`, `information_schema`, `pg_*`) classify as `internal` and are never presented as manageable. Exposure state comes from the v0.1 registry until the durable registry (V02-10) replaces it; a registry that lists an internal table, duplicates a target, or lists a table missing from the catalogue fails closed instead of being normalized, because a snapshot that papered over such contradictions would misrepresent both the schema and the API surface.

## D-024 — Schema-admin lane fails startup on partial config, runtime-lane sharing, and unsafe role attributes

**Status:** Accepted 2026-09-25

V02-04 makes the schema-admin lane a third, disabled-by-default connection surface. `parseConfig` rejects three operator mistakes at startup: exactly one of `SCHEMA_DATABASE_URL`/`MICROJBASE_ADMIN_TOKEN_SHA256` configured (D-012 pairing), `SCHEMA_DATABASE_URL` equal to `DATABASE_URL` (the runtime lane surface must stay distinct even if another lane shares the underlying role), and a malformed `MICROJBASE_ADMIN_TOKEN_SHA256` digest. When both settings are present, the composition root creates a small bounded admin pool and runs fail-closed role-attribute checks before listening: the connecting role must not be a superuser, must not have `BYPASSRLS`, and must not hold role-management rights (`CREATEROLE`). Startup aborts on any rejection so unsafe configurations can never serve admin operations. Per-object ownership ("owns every table it mutates") is enforced per operation by later waves, and the admin pool is never created when the lane is disabled, so admin operations cannot run.

## D-025 — Durable schema-operation log with checksum idempotency and salted actor fingerprints

**Status:** Accepted 2026-09-25

V02-05 records every controlled schema mutation in `microjbase.schema_operations` (forward-only migration 0005) with the typed command, a SHA-256 checksum over the canonicalized command, an idempotency key, terminal status, and a salted SHA-256 actor fingerprint — never a raw actor label. The repository defines the replay contract the executor relies on: an unused key records `running` and is `accepted`; a key whose operation succeeded (same checksum) is `replay` and must not re-execute; a key whose operation failed (same checksum) may be retried (`accepted` with `retryOfFailure`) because no state changed; a key already `running` is `in_progress` so concurrent duplicates never double-execute; and a previously used key with a different checksum is always a `CONFLICT`. The idempotency-key unique constraint is the concurrency boundary — racing begins contend for one row and losers observe the winner's record. Records surface in history newest-first for the later read-only admin API.

## D-026 — One audited DDL compiler and transactional executor with dry-run and reserved advisory serialization

**Status:** Accepted 2026-09-25

V02-06 builds the single DDL layer all later mutation commands compile through. Identifiers pass conservative validation and one quoting helper; values are parameterised where PostgreSQL permits and otherwise come only from typed literal templates (strict per-type validation, including real calendar-date checks) because PostgreSQL rejects parameters in DDL `DEFAULT` clauses. The type allowlist and default templates (`literal`, `current_timestamp`, `random_uuid`) are frozen by the plan; internal schemas are refused at the compiler before SQL exists. Plans are data: a dry run executes the plan inside a transaction that always rolls back and never writes history. Real execution serializes on the reserved advisory key `7921890504698152930` (distinct from the migration key `7921890504698152929`), records the operation through the D-025 log, maps PostgreSQL errors to stable safe envelopes with no database internals, and logs only structured event names plus counts — never statement text, identifiers, values, or database error text.

## D-027 — Typed mutation commands are replay-first, guard-heavy, and matrix-bound

**Status:** Accepted 2026-09-25

V02-07..V02-09 add the operator-facing table/column command layer on top of the D-026 substrate. Four properties are frozen:

1. **Replay first.** Every command consults the durable operation log before any preflight guard. When a record already exists for the idempotency key, the guards are bypassed and the executor alone classifies the begin outcome (replay, checksum conflict, retry-of-failure, in-progress), so a stateful guard such as "relation already exists" can never shadow the D-025 replay contract for a retried key. Confirmation values are validated on first execution; a replay returns the recorded outcome without re-confirmation because a replay is not a new destructive action. Compilation on the replay path resolves what it needs from the catalogue without the ownership/exposure guards so the recorded statement list — and therefore the checksum — can be reconstructed for comparison.
2. **Managed-shape enforcement.** `createTable` always appends the `"id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY` column; operator columns may not use `id` in any case variant, and table names starting with the PostgreSQL-reserved `pg_` prefix are refused. Internal schemas (`microjbase`, `pg_catalog`, `information_schema`, `pg_*`) are refused case-insensitively before SQL exists.
3. **Safeguarded columns.** Generated (stored/virtual) and identity columns are outside the managed lifecycle in both directions — the commands can neither create nor drop, rename, default, or type-change them. The primary-key column is never dropped, renamed, or type-changed. Columns used by a constraint or index are never dropped or type-changed, and a table referenced by another table's foreign key is never dropped; self-referencing foreign keys drop with their table, matching PostgreSQL.
4. **Preflight is advisory.** Guards read the immutable catalogue and parameterised existence/null probes so refused commands fail with stable codes before the executor runs, but they are a friendly early gate, not a security boundary: PostgreSQL re-validates everything inside the single DDL transaction, and the executor's rollback removes the history row together with the failed DDL (D-025/JDW-17 semantics).

## D-028 — The durable exposure registry is authoritative after a validated one-time import

**Status:** Accepted 2026-09-25

V02-10 (D-018) replaces the v0.1 environment-variable registry as the runtime exposure source with a durable registry owned by migration 0006 (`microjbase.exposure_registry` plus a singleton initialization guard). Four properties are frozen:

1. **One-time import.** On the first startup after migration 0006 the composition root validates the configured `MICROJBASE_TABLES` mappings through the verified v0.1 registry builder and then calls `microjbase.import_exposure_registry`, a `SECURITY DEFINER` function owned by the migration role that validates the payload independently (alias shape, identifier shape, internal-schema refusal, duplicate aliases/targets) and refuses a second call. Validation before the import commit means a bad configuration fails startup without baking the mistake into the durable registry. A failed import re-reads the guard: when a concurrent process initialized the registry first with the same exposed set, its state is used so startup proceeds exactly once; a concurrent winner with a different set fails startup closed with CONFLICT, because installing a mismatched winner would serve an exposure mapping this process never validated (R5 review, JDW-23). Migration 0007 revoked the PostgreSQL default `EXECUTE` grant to PUBLIC that 0006 left in place, closing the window where any login role with CONNECT and schema USAGE could win the import; only the runtime role holds EXECUTE through the documented out-of-band grant.
2. **Authoritative source.** After initialization the runtime reads only the durable registry (`exposed = true` rows) through the restricted runtime role; `MICROJBASE_TABLES` is never consulted again and can neither add tables nor re-expose an unexposed table. Unexpose keeps the row with `exposed = false` as operator history.
3. **Privilege model.** The restricted runtime role receives `SELECT` on the registry tables and `EXECUTE` on the import function from the operator out of band (the role name is unknown at migration time; migration 0007 revoked the default PUBLIC EXECUTE so the grant is mandatory rather than advisory); the schema-admin role receives `SELECT, INSERT, UPDATE` on the registry table, `USAGE` on its sequence, and `SELECT` on the guard table. The composition root probes both sets at startup and fails with operator-facing messages, mirroring the D-025 operation-log probe.
4. **Registry rows are not grants.** Expose/unexpose (D-031) update the durable rows; the runtime snapshot is rebuilt from them and re-verified as the runtime role before it is served.

## D-029 — Allowlisted index and unique-constraint management

**Status:** Accepted 2026-09-25

V02-11 manages ordinary indexes and unique constraints through the D-026 compiler with a deliberately small shape: plain column lists over catalogue-verified columns (1..16 columns, no duplicates), validated explicit names or deterministic `mjb_<table>_<columns>_<kind>_<digest>` names — the digest hashes the full identity (table, columns, kind) because validated identifiers may themselves contain underscores and the bare join is ambiguous (`["a_b","c"]` and `["a","b_c"]` collide without it; R5 review, JDW-23), and overlong bases are truncated with the digest retained instead of PostgreSQL's silent truncation — and internal-schema refusal before SQL exists. Expression indexes, partial indexes, and concurrent modes have no typed representation, so they cannot be compiled; unsupported catalogue constructs remain classified read-only metadata. `dropIndex` refuses constraint-backed names (the constraint must be dropped instead) and indexes that belong to a different table. Index and constraint management is allowed on exposed tables because it does not change the frozen data-API column contract the exposure registry snapshots; ownership and internal-object guards still apply. Commands are replay-first and recorded through the D-025 log like every other mutation.

## D-030 — Foreign keys use a frozen action allowlist; primary keys stay lifecycle-owned

**Status:** Accepted 2026-09-25

V02-12 adds foreign-key create/drop with `onUpdate`/`onDelete` restricted to the frozen allowlist `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`; `SET DEFAULT` has no representation anywhere in the command or compiler. `SET NULL` compiles only after the service has verified every referencing column is nullable. Referenced targets must exist in the immutable catalogue, both tables must be owned by the schema-admin role, and mapped type pairs that disagree are refused preflight (unmapped types are left to the in-transaction PostgreSQL validation, which the executor maps to a safe envelope). Primary keys are managed solely by the table lifecycle: the managed `"id" uuid` primary key is created with the table and drops with it, `dropConstraint` refuses primary keys, and no add-primary-key command exists. Check and exclusion constraints remain classified read-only metadata and are refused by `dropConstraint`.

## D-031 — Expose/unexpose applies least-privilege grants and swaps the runtime snapshot atomically

**Status:** Accepted 2026-09-25

V02-13 exposes or unexposes tables through the same replay-first command pattern as the other mutations, with two wave-specific properties:

1. **Verification defines the grant contract.** A table becomes exposed only when it exists, has the managed single-column UUID `"id"` primary key, ENABLE plus FORCE ROW LEVEL SECURITY, at least one RLS policy applicable to the runtime role, and a computed non-empty readable/insertable/updatable column contract (supported types readable; insert and update restricted to supported types as well, so a column the data contract cannot represent — for example `bytea` — receives no grant; generated/identity columns excluded from writes; the `id` column excluded from updates). The contract is computed from the catalogue shape because the expose grants themselves create the runtime privileges: `USAGE` on the schema, table-level `DELETE`, and column-level `SELECT`/`INSERT`/`UPDATE` matching the contract; the compiler allowlists the privilege tokens at runtime the way foreign-key actions are allowlisted. Unexpose revokes exactly those privileges with a table-level `REVOKE` (which also removes the column-level grants) and never touches schema `USAGE`, which sibling tables may still need. Because a REVOKE removes only grants the revoker made, a compiled guard statement re-reads the runtime role's effective privileges inside the same advisory-locked transaction and raises when any residual column `SELECT`/`INSERT`/`UPDATE` or table `DELETE` survives, rolling the registry update back — a table can never be recorded unexposed while the runtime role keeps a privilege on it. The authoritative assertion that the grants took effect is the post-commit runtime registry rebuild, which runs the verified v0.1 builder as the runtime role before serving the new snapshot, and which now runs after every non-dry-run success including idempotent replays so a failed refresh can never leave the served snapshot stale until restart.
2. **Atomic swap.** The grants and the durable registry row commit in one D-025/D-017 transaction; only after the commit does the composition root rebuild the verified registry from the durable state and atomically replace the delegate inside a `SwappableTableRegistry`. Concurrent CRUD requests read the registry synchronously per request and therefore observe either the complete old snapshot or the complete new one; in-flight requests that already resolved the old snapshot fail closed at the database once the revoke lands. Expose/unexpose do not drop tables, do not require destructive confirmation (unexpose is reversible operator history), and refuse internal targets, missing ownership, duplicate aliases, and already-exposed/unexposed state with stable safe errors.


## D-032 — R5 remediation: import ACL, qualified probes, and fail-closed unexpose

**Status:** Accepted 2026-09-25

The R5 independent review of V02-10–13 (JDW-22) produced four remediations, implemented under JDW-23 on top of `735daa9`:

1. **The one-time import is no longer public.** Migration 0007 revokes the PostgreSQL default `EXECUTE` grant to PUBLIC on `microjbase.import_exposure_registry(jsonb)`, which 0006 created as SECURITY DEFINER but left callable by any login role holding CONNECT and schema USAGE; reproduced on PostgreSQL 18.6 (a role with no registry DML committed its own exposure set). The out-of-band `GRANT EXECUTE` to the runtime role is unchanged and now mandatory.
2. **Race losers must match the winner.** `importInitialExposure` adopts a concurrent winner's initialized state only when the durable exposed set equals the validated local payload; a mismatched winner fails startup with CONFLICT instead of installing an unvalidated mapping (D-028 amended above).
3. **Exposure probes are search_path-proof.** Every catalogue relation and privilege function the expose verification and the startup registry probe reference is schema-qualified with `pg_catalog`, because those statements run on the admin pool before the executor pins `search_path`; with a decoy schema first in the path, unqualified `pg_class`/`has_table_privilege` resolved to forged objects that made an unhardened table verifiable (reproduced on PostgreSQL 18.6). This is the same hostile-search_path discipline the catalogue reader and the DDL executor already closed.
4. **Unexpose fails closed on residual grants.** Insert/update grant lists are restricted to supported data-contract types (no INSERT/UPDATE on types the API cannot represent, such as `bytea`), the compiler allowlists runtime privilege tokens like foreign-key actions, and an in-transaction guard statement raises application-defined SQLSTATE `9C002` when the runtime role retains any column SELECT/INSERT/UPDATE or table DELETE after the revoke — because a REVOKE removes only grants the revoker made, grants from other roles would otherwise survive while the registry row says unexposed. The runtime snapshot refresh also runs after every non-dry-run success including replays, so a post-commit refresh failure cannot strand the served snapshot (D-031 amended above).

## D-033 — RLS state management enables and forces together; disable fails closed

**Status:** Accepted 2026-09-25

V02-14 manages row-security state through the same replay-first, D-025-recorded command pattern as the earlier waves, with fail-closed semantics frozen around it:

1. **Enablement is always forced.** `enableRowSecurity` compiles `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` as one plan, so a managed table can never sit with RLS enabled but unforced — the table owner (and every other non-policy-checked path) must be subject to the same policies as the pooled runtime lane; the exposure verification from D-031 keeps requiring both bits. Disable compiles `NO FORCE` before `DISABLE` so the relforcerowsecurity bit never outlives the row-security bit inside the transaction.
2. **Disable fails closed at the durable registry, inside the lock.** `disableRowSecurity` requires the exact `"schema.table"` confirmation value (D-015 shape), refuses internal targets before SQL exists, and requires catalogue-reported ownership by the schema-admin role. The injected v0.1 `TableRegistry` check is only a friendly early gate over the process-local snapshot — another process can serve a staler or fresher view, and the exposure service refreshes only its own holder — so it is not the security boundary. The compiled plan's first statement, after the executor's advisory lock, re-reads `microjbase.exposure_registry` and raises 9C003 when the target is still exposed; an exposed table whose row security was disabled would let the pooled lane read and write every user's rows, so the command conflicts instead and the whole transaction rolls back.
3. **Expose re-verifies row security inside the same lock.** The exposure verification reads the `relrowsecurity`/`relforcerowsecurity` catalogue bits on the admin pool before the executor takes the advisory lock, which is likewise only an early gate. The expose plan's first statement re-reads both bits under the lock and raises 9C004 unless both are still true, so the grants and the durable registry row can never commit against a table whose row security was disabled in the window between verification and execution. Transactionality, owner semantics, and the advisory-lock serialization are inherited unchanged from the D-026 executor; runtime identity isolation (the transaction-local `microjbase.user_id` mechanism) is untouched.

## D-034 — Predefined ownership policy templates bind user_id, never arbitrary SQL

**Status:** Accepted 2026-09-25

V02-15 implements D-019: four named templates — `read`, `insert`, `update`, `delete` — compiled by the sealed D-026 layer and applied TO the restricted runtime role only (least privilege: the table owner is not a policy target either, so FORCE RLS closes that path too). Every template renders one fixed ownership comparison — `ownership_column = nullif(current_setting('microjbase.user_id', true), '')::uuid` — against the transaction-local request identity; a missing or empty GUC matches no rows, so an unset identity fails closed instead of seeing everything. There is deliberately no arbitrary policy-expression path anywhere in the command or compiler.

Template names are deterministic module-owned names (`mjb_<table>_<column>_<template>_<digest>` via the D-029 helper), so removal addresses policies only by the name the module created: `removeOwnershipPolicy` refuses when the named policy does not exist and drops only that name — it never restores or reconstructs operator-authored policies. Creation validates from the immutable catalogue that the table is admin-owned, the column exists, is a plain (non-generated, non-identity) column of exactly the allowlisted `uuid` type, and that the module-created policy does not already exist; duplicate creation with a fresh key conflicts. Policy management is allowed on exposed tables (adding or removing a policy changes row visibility, never the frozen column contract the exposure registry snapshots), and ownership/internal guards still apply. Commands are replay-first and dry-run aware like every other mutation: reused keys bypass stateful preflight so the D-025 contract classifies the outcome, while dry runs always preflight (D-027).

## D-035 — R6 remediation: the exposure/RLS invariants are locked, the runtime snapshot is ticketed, and expose owns its policy gate

**Status:** Accepted 2026-09-25

The R6 integrated review of the schema-mutation commands (JDW-27, on top of `fefd852`) produced six remediations, all implemented behind the existing advisory-lock serialization:

1. **Structural mutations and RLS disablement re-check the durable registry inside the lock.** The preflight guards read the process-local registry snapshot and the live catalogue before the executor acquires its connection and advisory lock, so a concurrent expose could commit in that window and serve the mutation a stale answer (reproduced on PostgreSQL 18.6: `disableRowSecurity` still compiled `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, and `dropTable` still compiled `DROP TABLE`, against a table the durable registry already listed exposed). The compiled plans now lead with an application-defined guard statement (SQLSTATE `9C003`) that re-reads `microjbase.exposure_registry` under the same lock, for `disableRowSecurity` (D-033 amended above) and every guarded structural mutation; the preflight stays as the friendly early error only.
2. **The runtime registry refresher is generation-ticketed.** Each refresh captures a monotonic ticket before its read and swaps the rebuilt snapshot only while still newest, so a slower older read can no longer finish last and replace a fresh snapshot with a stale one.
3. **Expose owns its policy gate.** Exposure verification no longer accepts "any applicable policy": for each command the runtime role exercises (SELECT, INSERT, UPDATE, DELETE) the applicable permissive policies must be exactly the module-owned ownership template (deterministic `mjb_` name plus the frozen ownership expression), and any other permissive policy applicable to the role fails the expose closed, because permissive policies OR together and a broader `USING (true)` beside the ownership policy let one tenant read another's rows (reproduced on PostgreSQL 18.6). The required expression is not matched against a hard-coded `pg_get_expr` rendering — that text is server-version-dependent — but against what `pg_get_expr` returns on the running server for a throwaway probe policy the module compiles and deparses inside a rolled-back transaction, so the gate is exactly the compiler's own output on any supported version. Restrictive policies remain allowed because they only narrow.
4. **Cascading referential actions refuse exposed tables.** `ON DELETE/UPDATE CASCADE` and `SET NULL` rewrite rows in the referencing table as its owner, bypassing row security (reproduced on PostgreSQL 18.6: Alice's `DELETE` removed Bob's comment through `ON DELETE CASCADE` under `FORCE ROW LEVEL SECURITY`). The foreign-key plan now leads with the same locked guard on both ends of the key and raises `9C003` when either table is exposed; unexposed tables keep the frozen action allowlist.
5. **The runtime catalogue probes are search_path-proof.** Every catalogue relation and privilege function in `buildTableRegistry`'s verification and in `checkTableOwnershipAndRls` is schema-qualified with `pg_catalog`, closing the same hostile-search_path hole the R5 review fixed for the admin probes (reproduced on PostgreSQL 18.6: `search_path = decoy, pg_catalog` made an unqualified `pg_class` probe report `relrowsecurity = true` for a table whose real flags were false).
6. **Expose replays are replay-first and concurrent exposes conflict instead of renaming.** A key with an existing operation record bypasses the live verification gate (the recorded command now carries the verified column contract, so the statement list and checksum are reconstructed byte-identically) and reaches the executor's replay classification and the post-commit registry refresh; and the expose plan's locked prerequisite guard raises `9C004` when the target is already exposed, so a second concurrent expose conflicts instead of the registry upsert renaming the public alias.

The new SQLSTATEs map to fixed safe envelopes in `DDL_ERROR_MAP` (`9C003` and `9C004` to the in-progress-style 409 CONFLICT, like `9C001`/`9C002`); no database error text crosses the boundary.

## D-036 — JDW-29 re-review blockers: expose refuses cascading foreign keys planted while unexposed, and the ownership probe renders on a pinned search_path

**Status:** Accepted 2026-09-25

The independent re-review of the JDW-27 remediation (JDW-29, on top of the JDW-27 tree) returned changes required: two supported sequences still broke tenant isolation. Both are closed behind the existing advisory-lock serialization:

1. **Expose refuses a table that participates in a cascading or nullifying foreign key.** `compileAddForeignKey` only guards the sequence where an end is already exposed at key-creation time, so a `CASCADE`/`SET NULL` key planted while both ends were unexposed sailed through, and exposing either end afterwards gave the runtime role a path that rewrote the other tenant's rows without consulting row security. The expose plan's locked prerequisite guard now also re-reads `pg_catalog.pg_constraint` under the advisory lock — refusing the target as either `conrelid` or `confrelid` of a `contype = 'f'` constraint whose `confupdtype` or `confdeltype` is `c` or `n` — and raises `9C004`, rolling the grants and the registry row back with it. The in-memory preflight still sees nothing wrong; the locked guard is the authority.
2. **The ownership-comparison probe renders on a pinned session.** Exposure verification had compared each candidate policy's expressions against the module's frozen comparison by deparsing both through `pg_get_expr` on the unpinned admin pool. `pg_get_expr` only schema-qualifies an operator when it is not visible in the session `search_path`, so a policy planted under `search_path = hostile, pg_catalog` whose `uuid =` resolved to an always-true operator deparsed to the identical string the probe rendered, and verification accepted it (reproduced on PostgreSQL 18.6: one tenant's session returned both tenants' rows). The probe now pins `standard_conforming_strings=on` and `search_path=pg_catalog` inside its rolled-back transaction — the same hardening the executor applies to real DDL — before `CREATE POLICY`, and deparses candidate policies on that same pinned session, so a hostile-bound operator renders `OPERATOR(hostile.=)` and fails closed while a genuine `pg_catalog` policy still renders identically and exposes. One sharp edge matters for reproduction and operation: PostgreSQL silently skips `search_path` schemas the current role lacks `USAGE` on, so the planting role must hold `USAGE` on the hostile schema for the hostile operator to bind at all (verified empirically on PostgreSQL 18.6).

The locked `9C003` guard's envelope message is generalized to "Table is exposed to the data API and cannot be modified", since the same SQLSTATE now covers structural mutations, cascading foreign keys, and RLS disablement.

## D-037 — The admin HTTP API is one operator token, one rate limiter, and one key per mutation

**Status:** Accepted 2026-09-25

V02-16..V02-18 (B6) expose the internal schema services over `/v1/admin/schema`. Six properties are frozen:

1. **One operator identity over HTTP.** The single operator token (D-013) means HTTP-originated commands all carry the fixed actor label `http-operator`; the durable history records only the salted SHA-256 actor fingerprint (D-025), never a raw label. Per-token actors would need a second identity system, which D-013 explicitly rejects.
2. **Authentication is digest comparison, never a lookup.** `verifyOperatorToken` hashes the presented token and compares digests with `timingSafeEqual`; there is no database lookup to rate-limit or enumerate against, and ordinary session tokens are indistinguishable from wrong guesses (both are `401 INVALID_CREDENTIALS`, missing/malformed headers are `401 AUTH_REQUIRED`). The operator token used as a session token fails session authentication the same way, so the two credential systems never cross-authenticate.
3. **The admin tree is rate-limited separately and inert when disabled.** A dedicated `InMemoryRateLimiter` instance (30 attempts per endpoint per client IP per 60-second window, the same bounded fixed-window shape as the auth limiter) counts admin traffic only; login/register limits are untouched by admin load and vice versa. When the admin lane is not configured, the route tree is not registered at all — `/v1/admin/*` is the public 404 — so an opted-out server exposes no admin fingerprint, and the no-store/error contract still applies to those 404s.
4. **Every mutation requires an `Idempotency-Key` header** matching the command pattern; there is deliberately no un-keyed mutation path, and the header is validated at the transport layer so malformed keys are `400 VALIDATION_ERROR` rather than command failures. `dry_run` is a body flag on every mutation; dry runs compile and preflight inside a transaction that always rolls back and write no history.
5. **HTTP handlers never construct SQL and never see raw PostgreSQL errors.** Strict per-endpoint validation (unknown fields rejected, snake_case mapped onto the frozen camelCase commands, confirmations required at the transport layer for destructive commands) precedes the service call; the audited compiler/executor remains the only SQL boundary (D-014/D-026), and every guard SQLSTATE and privilege failure surfaces only as the frozen safe envelopes. Response bodies carry the operation record (snake_case, salted fingerprint) so operators get durable audit without any statement text.
6. **The admin lane reads migration history, so its grant set grew by one.** The deterministic snapshot (V02-03) reads `microjbase.schema_migrations` through the admin pool, which the original D-025/D-028 out-of-band grants did not cover: the operator procedure now also grants `SELECT ON microjbase.schema_migrations` to the schema-admin role (documented in docs/admin-api.md). Startup still probes and fails closed when any grant is missing.
