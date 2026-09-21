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

## Planned stack

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

## Proposed API

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

**Active; documentation and contracts frozen for the v0.1 implementation phase.**

The implementation sequence is in [ROADMAP.md](ROADMAP.md). AI coding agents must follow [AGENTS.md](AGENTS.md).

