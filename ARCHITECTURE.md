# Architecture

## 1. System shape

microJBase v0.1 is one TypeScript application connected to one PostgreSQL database. Nginx or Caddy may terminate TLS in production, but it is not part of the application.

```text
Client
  |
  | HTTPS + bearer session
  v
Reverse proxy (optional)
  |
  v
microJBase server (one Node.js process)
  |-- HTTP module
  |-- Auth module
  |-- Data module
  |-- Core module
  `-- PostgreSQL adapters
          |
          v
      PostgreSQL 16+
```

No internal network calls, queues, caches, or independently deployed services are permitted in v0.1.

## 2. Intended source layout

```text
src/
├── main.ts                 # composition root; wires concrete dependencies
├── core/
│   ├── config.ts
│   ├── errors.ts
│   └── lifecycle.ts
├── contracts/              # frozen ports and shared public types
│   ├── auth.ts
│   ├── data.ts
│   ├── schema.ts            # v0.2 schema-catalogue/snapshot contracts (V02-01..V02-03)
│   └── index.ts
├── auth/                   # auth domain logic; no pg/Fastify imports
│   ├── service.ts
│   └── password.ts
├── data/                   # CRUD domain logic; no pg/Fastify imports
│   └── service.ts
├── database/
│   ├── pool.ts
│   ├── transaction.ts
│   ├── table-registry.ts
│   ├── auth-repository.ts
│   ├── data-repository.ts
│   ├── schema-catalogue.ts  # v0.2 read-only catalogue reader (V02-01..V02-03)
│   └── schema-snapshot.ts   # v0.2 read-only snapshot assembly (V02-03)
├── http/
│   ├── server.ts
│   ├── auth-routes.ts
│   ├── data-routes.ts
│   └── responses.ts
└── shared/
    └── types.ts             # dependency-free utility types only

migrations/                  # ordered, immutable SQL files
scripts/                     # migration/benchmark entry points
tests/
├── unit/
├── integration/
└── e2e/
```

This is one npm package, not an npm-workspaces monorepo. Directory ownership gives agents parallel boundaries without multiplying manifests, build graphs, or runtime packages.

## 3. Dependency rules

Allowed dependencies:

```text
http ------> auth ------> contracts <------ database
  |            ^                              ^
  `--------> data ----------------------------'

main ------> every module (composition only)
core ------> no feature module
shared ----> no project module
```

Rules:

1. `auth/` and `data/` contain domain behaviour and depend on contracts, not PostgreSQL or Fastify.
2. `database/` implements contracts and is the only module that imports `pg`.
3. `http/` maps HTTP requests to service calls and owns transport validation. It does not contain SQL or password logic.
4. `main.ts` is the only composition root. It may instantiate and wire every module but contains no business rules.
5. `contracts/` is architect-owned. A module agent must request contract changes rather than editing it.
6. Cross-module imports must use the module's public entry point; never import another module's private file.
7. Circular imports are forbidden.

## 4. Request flows

### Register or login

1. HTTP validates the request shape.
2. Auth normalises the email and applies credential rules.
3. Auth calls repository contracts.
4. The PostgreSQL adapter stores/fetches users and sessions.
5. The raw session token is returned exactly once; only its SHA-256 digest is stored.

### Authenticated data request

1. HTTP reads `Authorization: Bearer <token>`.
2. Auth hashes the token and resolves a non-expired, non-revoked session.
3. Data resolves `:table` through the startup-built table registry.
4. Database starts a transaction.
5. Database runs `SELECT set_config('microjbase.user_id', $1, true)` with the user UUID.
6. Database performs parameterised CRUD within that same transaction.
7. PostgreSQL RLS filters or rejects rows.
8. Database commits, and HTTP serialises the standard response envelope.

The identity setting is transaction-local. A pooled connection must never retain a user's identity.

## 5. Trust boundaries

Untrusted input includes bearer tokens, route parameters, query strings, JSON keys/values, proxy headers, and database-returned error text.

Security boundaries:

- The HTTP layer rejects malformed input and oversized bodies.
- The table registry maps a public alias to a configured schema/table; the client never supplies a raw SQL identifier.
- Database metadata validates body keys as real writable columns before identifiers are quoted.
- All values use PostgreSQL parameters.
- RLS is the final row-level boundary and must be enabled and forced on every exposed table.
- The runtime database role must not be superuser and must not have `BYPASSRLS`.
- The `microjbase` internal schema can never be exposed by the data API.
- Logs must never contain passwords or raw session tokens.

## 6. Configuration

Configuration is read and validated once at startup. The initial contract is:

```text
DATABASE_URL                 required; restricted runtime role
MIGRATION_DATABASE_URL       optional; privileged role used by migration command only
HOST                         default 127.0.0.1
PORT                         default 3000
LOG_LEVEL                    default info
SESSION_TTL_SECONDS          default 604800 (7 days)
MICROJBASE_TABLES            seeds the durable exposure registry once (v0.2); alias mappings
TRUST_PROXY                   default false
MAX_BODY_BYTES               default 1048576 (1 MiB)
```

Example:

```text
MICROJBASE_TABLES=todos=public.todos,profiles=public.profiles
```

Secrets are never committed. `.env` is development-only; production uses the process environment or a service manager secret file.

## 7. Database ownership model

The migration role owns schemas/tables. The runtime role receives only the grants needed for auth tables, migration-version reads, and exposed application tables. The server refuses to start when the runtime role is superuser or has `BYPASSRLS`.

Every exposed application table must:

- have a single UUID primary key named `id`;
- have RLS enabled and forced;
- include policies for the runtime role;
- be recorded as `exposed` in the durable exposure registry (`microjbase.exposure_registry`, D-018), which the runtime reads as its sole exposure source;
- not be in the `microjbase`, `pg_catalog`, or `information_schema` schemas.

`MICROJBASE_TABLES` feeds the one-time import into that registry on the first startup after migration 0006 (validated before it commits); afterwards the environment variable can neither add tables nor re-expose an unexposed table.

The exact SQL requirements are in [docs/database-spec.md](docs/database-spec.md).

## 8. Operations and footprint

Production target:

- one Node process managed by systemd or an equivalent supervisor;
- one PostgreSQL database, which may already exist on the VPS;
- graceful shutdown on `SIGTERM`/`SIGINT`;
- `/health` for liveness and database readiness;
- JSON logs to stdout;
- no runtime write access to the local filesystem.

Performance targets are guardrails, not marketing promises:

- API idle RSS at or below 80 MiB on Node 22 after warm-up;
- server ready within 1 second, excluding an unavailable database timeout;
- no more than 10 database pool connections by default;
- no unbounded in-memory collections.

The benchmark environment and measured results must be committed before v0.1 is tagged.

