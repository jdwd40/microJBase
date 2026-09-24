# Roadmap

The roadmap is deliberately narrow. A stage begins only after the previous stage is integrated and green.

## v0.1 — complete

All v0.1 stages are merged on `master` and tagged `v0.1.0`. Merged implementation/release PRs: #14 through #24. Evidence: [docs/release-notes-v0.1.md](docs/release-notes-v0.1.md) and [docs/release-checklist.md](docs/release-checklist.md).

## Stage 0 — Documentation foundation

- [x] Define v0.1 scope and non-goals
- [x] Freeze architecture and module contracts
- [x] Define agent ownership and review workflow
- [x] Define API, auth, database, and testing specifications

## Stage 1 — Skeleton and composition

Owner: architect/integrator. Merged in PR #14.

- [x] Add Node 22/TypeScript project configuration
- [x] Add strict compiler, lint, format, test, and build scripts
- [x] Create the source layout from `ARCHITECTURE.md`
- [x] Materialise interfaces from `CONTRACTS.md`
- [x] Add a minimal Fastify server and composition root
- [x] Add `.env.example` with non-secret placeholders
- [x] Add local PostgreSQL development configuration

Acceptance: clean install, build, typecheck, lint, and placeholder test pass without feature logic.

## Stage 2 — Database foundation

Owner: database agent. Merged in PRs #18 and #19.

- [x] Connection pool and clean shutdown
- [x] Raw SQL migration runner with advisory lock and version table
- [x] Internal users/sessions migrations
- [x] Runtime-role safety checks
- [x] Exposed-table configuration parser and metadata registry
- [x] Request-identity transaction helper
- [x] Repository adapter tests against PostgreSQL

Acceptance: migrations are repeatable, the restricted role passes startup checks, and transaction-local identity cannot leak between pooled requests.

## Stage 3 — Authentication

Owner: auth agent; database adapter work remains with database owner. Merged in PRs #16 and #19.

- [x] Email normalisation and input rules
- [x] Argon2id hash/verify
- [x] Cryptographically random opaque session tokens
- [x] Register/login/authenticate/logout services
- [x] Auth repository adapters
- [x] Unit and integration tests, including enumeration and log-redaction cases

Acceptance: the full auth service contract passes without HTTP.

## Stage 4 — Data API core

Owner: data agent plus database agent for adapters. Merged in PRs #17 and #20.

- [x] List/get/create/update/delete services
- [x] Column validation against the registry
- [x] Parameterised SQL and safe verified identifiers
- [x] RLS-backed data repository implementation
- [x] Unit and integration tests for ownership isolation

Acceptance: two users cannot read or mutate each other's rows, including under pooled connection reuse.

## Stage 5 — HTTP API

Owner: HTTP agent. Merged in PRs #21 and #22.

- [x] Health route
- [x] Auth routes and bearer middleware
- [x] Data routes, pagination, request limits, and response envelopes
- [x] Stable error mapping
- [x] Bounded in-memory auth rate limiting
- [x] End-to-end tests

Acceptance: the proof-of-life flow in `docs/v0.1-scope.md` passes entirely through HTTP.

## Stage 6 — Adversarial review and hardening

Owners: Grok Red and Grok Green; fixes integrated by Kimi/OpenCode. Merged in PR #23.

- [x] Threat-oriented review with reproducible findings
- [x] Architecture/contract compliance audit
- [x] Dependency and secret scan
- [x] Clean-database and upgrade migration test
- [x] Failure testing: database loss, shutdown, malformed/oversized input
- [x] Resolve all critical/high findings and explicitly disposition lower findings

PR #23 fixed the single MAJOR finding (RLS `42501` mapped to a safe `409 CONFLICT` envelope); its final review verdict was SHIP with 0 blockers / 0 majors / 2 minors.

## Stage 7 — Footprint, deployment, and v0.1

Merged in PR #24.

- [x] Commit reproducible idle/load benchmark scripts
- [x] Record CPU/RSS/startup measurements and environment
- [x] Add production systemd example and reverse-proxy guidance
- [x] Add backup/restore and upgrade documentation
- [x] Run the full release checklist
- [x] Tag `v0.1.0`

## v0.2 — schema management (active)

V02-00 is complete in PR #25 and V02-01 (read-only schema catalogue contracts and the table/column reader) is merged in PR #26 at `b10c8c8`. V02-02 (constraint and index introspection) and V02-03 (schema snapshot service with migration/exposure state) are implemented on `master` and await independent review; the remaining queue V02-04..V02-19 stays frozen. Progress is 2 of 20 queue items merged (10%). v0.2 adds deliberately small schema-management capabilities: read-only introspection, a typed audited DDL layer, a durable exposure registry, predefined RLS ownership templates, and an opt-in admin API. The frozen sequential queue (V02-00 through V02-19, one active implementation PR at a time) is defined in [docs/v0.2-implementation-plan.md](docs/v0.2-implementation-plan.md); scope and architecture are in [docs/v0.2-scope.md](docs/v0.2-scope.md) and [docs/v0.2-architecture.md](docs/v0.2-architecture.md).

## Later candidates — not commitments

Only consider these after real use demonstrates a need:

- filtered/sorted data queries;
- password changes or operator-issued reset tokens;
- session listing/revocation;
- a tiny TypeScript client;
- PostgreSQL functions/RPC;
- optional public-read policies;
- per-table pagination cursors.

Storage, realtime, arbitrary functions, analytics, and a large dashboard remain outside the project's identity.

