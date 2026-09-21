# microJBase v0.1 release notes

**microJBase is an intentionally small backend foundation providing basic
authentication and PostgreSQL CRUD with a minimal operational footprint.**

v0.1 is the first complete, reviewed, and release-checked version of that
foundation. It is a foundation to build on — not a platform, and not a
managed-Postgres service.

## What v0.1 provides

- **Email/password authentication** — Argon2id password hashing with explicit
  parameters (19 MiB memory, 2 iterations, parallelism 1 — `ARGON2_MEMORY_COST_KIB`
  = 19,456 in `src/auth/password.ts`), timing-consistent unknown-email
  handling via a dummy Argon2id verification.
- **Opaque session tokens** — 32 random bytes (base64url transport), SHA-256
  hashed at rest, fixed lifetime of 7 days by default: `expires_at` is set at
  registration/login and is **not** extended by activity (no sliding
  expiration; logging in again creates a new session).
- **PostgreSQL persistence** — one schema owned by the application, forward-only
  migrations applied explicitly (never at request time), schema-migration
  bookkeeping in `microjbase.schema_migrations`.
- **Restricted runtime role** — the API connects as a non-superuser,
  non-`BYPASSRLS` role and **refuses to start** if that is violated. DDL rights
  live only in the migration/admin role.
- **Safe CRUD over HTTP** — table whitelist, column allow-listing, typed value
  validation, parameterised SQL only, bounded body size, sane error envelopes
  that never leak internals.
- **RLS-based ownership isolation** — row-level security is the enforcement
  boundary for multi-user data; verified by dedicated Alice/Bob test
  characters in integration and E2E suites.
- **Operational shape** — graceful shutdown (finish in-flight, close pool),
  health endpoint with live DB check, structured request logs, bounded
  connection pool (≤ 10 by default), fail-closed configuration.
- **Testing** — 352 tests across unit/integration/E2E layers, including a
  compiled-server end-to-end acceptance suite, RLS isolation proofs, and a
  security review (gate: PASS, 0 blockers).
- **Deployment evidence** — reproducible systemd + nginx deployment
  ([docs](deployment.md)), backup/restore/upgrade procedures
  ([docs](operations.md)), and measured startup (~420 ms), idle RSS
  (~82 MiB), and small-load results ([docs](benchmarks.md)).

## Intentional limitations

These are boundaries of the product, not gaps to read into it:

- **Single-node process.** No clustering, horizontal scaling, or
  queue-backed workers.
- **No permission system beyond ownership.** Users can act only on their own
  rows; there are no roles, teams, or sharing.
- **No realtime.** Polling only; no websockets or change feeds.
- **No file/blob storage.** Data is JSON values in PostgreSQL.
- **One write model.** The transaction strategy is deliberately boring;
  cross-table transactions stay on the roadmap (v0.3+).
- **Rate limiting is in-memory and per-process.** Fine behind a single
  instance; a second instance does not share the limiter.
- **Migrations are forward-only.** Rollback = restore from backup.
- **Known deferred findings** from the security review are listed in the
  [release checklist](release-checklist.md).

## Compatibility

- Node.js ≥ 22.13.0, PostgreSQL ≥ 16.
- HTTP API per [docs/api-spec.md](api-spec.md); contracts per
  [CONTRACTS.md](../CONTRACTS.md).

## Verification summary for this release

- `npm test`: 34 files / 352 tests green (unit 206, integration 111, e2e 35).
- Startup median 420 ms (guardrail < 1 s). Idle RSS ~82 MiB.
- Load evidence: 726 req/s mixed health/authed-read, 0 failures, p95 29 ms.
- Security review: PASS; the single MAJOR finding (RLS 42501 → 500 mapping)
  was fixed before this release.
