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

