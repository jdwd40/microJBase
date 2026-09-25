# microJBase

**A tiny self-hosted backend for apps that need users and PostgreSQL—nothing more.**

microJBase provides basic email/password authentication and a small, authenticated CRUD API over explicitly exposed PostgreSQL tables. It is designed for one VPS, one Node.js process, and one PostgreSQL database.

The project values, in order:

1. Security and correct data isolation
2. A small runtime and dependency footprint
3. A simple deployment and operating model
4. Clear module contracts for human and AI contributors
5. Familiar HTTP and SQL behaviour

## v0.1 at a glance

Included:

- register, login, logout, and current-user endpoints
- Argon2id password hashing
- opaque, revocable bearer sessions stored as hashes
- authenticated create/read/update/delete operations
- an explicit table allowlist
- PostgreSQL row-level security (RLS) as the final data-access boundary
- SQL migrations, health checks, structured errors, and tests

Deliberately excluded:

- email verification and password-reset email
- OAuth, MFA, magic links, and social login
- file storage, realtime, edge functions, analytics, and a dashboard
- arbitrary SQL over HTTP
- Supabase API compatibility
- multiple runtime services or a plugin system

See [docs/v0.1-scope.md](docs/v0.1-scope.md) for the frozen milestone.

## v0.1 stack (implemented)

- Node.js 22 LTS and TypeScript
- Fastify for HTTP and its built-in logging/schema support
- PostgreSQL 16+
- `pg` for database access
- `argon2` for password hashing
- raw versioned SQL migrations
- Vitest for unit and integration tests

There is no PostgREST, JWT service, Redis, message broker, or frontend in v0.1.

## Documentation

- [docs/api-spec.md](docs/api-spec.md) — HTTP request/response contract.
- [docs/database-spec.md](docs/database-spec.md) — PostgreSQL schema, roles, RLS, migrations.
- [docs/deployment.md](docs/deployment.md) — reproducible systemd + nginx deployment.
- [docs/operations.md](docs/operations.md) — backup, restore, and upgrade procedures.
- [docs/benchmarks.md](docs/benchmarks.md) — measured startup, RSS, and load evidence (reproducible via `scripts/benchmark.ts`).
- [docs/release-checklist.md](docs/release-checklist.md) and [docs/release-notes-v0.1.md](docs/release-notes-v0.1.md) — v0.1 release evidence.
- [docs/v0.2-scope.md](docs/v0.2-scope.md) — v0.2 product statement, security boundaries, and non-goals (planned).
- [docs/v0.2-architecture.md](docs/v0.2-architecture.md) — v0.2 target internal modules and trust boundaries (planned).
- [docs/v0.2-implementation-plan.md](docs/v0.2-implementation-plan.md) — the sequential V02-00..V02-19 queue (planned).
- [Project wiki](docs/project/index.html) — framework-free static dashboard of verified repository state.

## Architecture

microJBase is a modular monolith: one deployable server with strict internal boundaries.

```text
HTTP routes
   |-- Auth service ---- repository contracts ---- PostgreSQL adapters
   |-- Data service ---- repository contracts ---- PostgreSQL adapters
   `-- Core config/errors/logging
```

The API process authenticates a session, begins a database transaction, sets the local PostgreSQL identity (`microjbase.user_id`), and lets RLS decide which rows the caller may access.

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRACTS.md](CONTRACTS.md) before implementation.

## v0.1 API (implemented)

```text
GET    /health
POST   /v1/auth/register
POST   /v1/auth/login
POST   /v1/auth/logout
GET    /v1/auth/me

GET    /v1/data/:table
GET    /v1/data/:table/:id
POST   /v1/data/:table
PATCH  /v1/data/:table/:id
DELETE /v1/data/:table/:id
```

Only configured aliases such as `todos=public.todos` are exposed. Table and column identifiers are never accepted blindly, and SQL values are always parameterised.

## Status

**v0.1.0 released.** The v0.1 milestone is complete: tag `v0.1.0` on `master` (base commit `9413cfa`), 34 test files / 352 tests green, latest base-commit CI green. See [docs/release-notes-v0.1.md](docs/release-notes-v0.1.md) for release evidence.

**v0.2 active.** The V02-00 planning/wiki foundation and V02-01 (read-only schema catalogue contracts and table/column reader, PR #26 at `b10c8c8`) are merged. Wave 1 V02-02 (constraint and index introspection) and V02-03 (schema snapshot service with migration/exposure state) are implemented on `master` and in independent review. Wave 2 V02-04 (disabled-by-default schema-admin connection and capability boundary), V02-05 (durable checksummed schema-operation history with idempotency), and V02-06 (single typed DDL compiler/executor with dry-run, advisory serialization, and safe error mapping) are implemented on `master` and await independent review. The milestone adds deliberately small schema-management capabilities behind an opt-in admin boundary. See [docs/v0.2-scope.md](docs/v0.2-scope.md), [docs/v0.2-architecture.md](docs/v0.2-architecture.md), and [docs/v0.2-implementation-plan.md](docs/v0.2-implementation-plan.md). Progress is tracked on the [project wiki](docs/project/index.html).

The implementation sequence for v0.1 is in [ROADMAP.md](ROADMAP.md). AI coding agents must follow [AGENTS.md](AGENTS.md).

