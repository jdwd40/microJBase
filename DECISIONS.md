# Architecture Decisions

Accepted decisions are binding for v0.1. Additions use the next number; existing entries are not rewritten to hide history.

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

