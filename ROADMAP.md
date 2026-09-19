# Roadmap

The roadmap is deliberately narrow. A stage begins only after the previous stage is integrated and green.

## Stage 0 — Documentation foundation

- [x] Define v0.1 scope and non-goals
- [x] Freeze architecture and module contracts
- [x] Define agent ownership and review workflow
- [x] Define API, auth, database, and testing specifications

## Stage 1 — Skeleton and composition

Owner: architect/integrator.

- [ ] Add Node 22/TypeScript project configuration
- [ ] Add strict compiler, lint, format, test, and build scripts
- [ ] Create the source layout from `ARCHITECTURE.md`
- [ ] Materialise interfaces from `CONTRACTS.md`
- [ ] Add a minimal Fastify server and composition root
- [ ] Add `.env.example` with non-secret placeholders
- [ ] Add local PostgreSQL development configuration

Acceptance: clean install, build, typecheck, lint, and placeholder test pass without feature logic.

## Stage 2 — Database foundation

Owner: database agent.

- [ ] Connection pool and clean shutdown
- [ ] Raw SQL migration runner with advisory lock and version table
- [ ] Internal users/sessions migrations
- [ ] Runtime-role safety checks
- [ ] Exposed-table configuration parser and metadata registry
- [ ] Request-identity transaction helper
- [ ] Repository adapter tests against PostgreSQL

Acceptance: migrations are repeatable, the restricted role passes startup checks, and transaction-local identity cannot leak between pooled requests.

## Stage 3 — Authentication

Owner: auth agent; database adapter work remains with database owner.

- [ ] Email normalisation and input rules
- [ ] Argon2id hash/verify
- [ ] Cryptographically random opaque session tokens
- [ ] Register/login/authenticate/logout services
- [ ] Auth repository adapters
- [ ] Unit and integration tests, including enumeration and log-redaction cases

Acceptance: the full auth service contract passes without HTTP.

## Stage 4 — Data API core

Owner: data agent plus database agent for adapters.

- [ ] List/get/create/update/delete services
- [ ] Column validation against the registry
- [ ] Parameterised SQL and safe verified identifiers
- [ ] RLS-backed data repository implementation
- [ ] Unit and integration tests for ownership isolation

Acceptance: two users cannot read or mutate each other's rows, including under pooled connection reuse.

## Stage 5 — HTTP API

Owner: HTTP agent.

- [ ] Health route
- [ ] Auth routes and bearer middleware
- [ ] Data routes, pagination, request limits, and response envelopes
- [ ] Stable error mapping
- [ ] Bounded in-memory auth rate limiting
- [ ] End-to-end tests

Acceptance: the proof-of-life flow in `docs/v0.1-scope.md` passes entirely through HTTP.

## Stage 6 — Adversarial review and hardening

Owners: Grok Red and Grok Green; fixes integrated by Kimi/OpenCode.

- [ ] Threat-oriented review with reproducible findings
- [ ] Architecture/contract compliance audit
- [ ] Dependency and secret scan
- [ ] Clean-database and upgrade migration test
- [ ] Failure testing: database loss, shutdown, malformed/oversized input
- [ ] Resolve all critical/high findings and explicitly disposition lower findings

## Stage 7 — Footprint, deployment, and v0.1

- [ ] Commit reproducible idle/load benchmark scripts
- [ ] Record CPU/RSS/startup measurements and environment
- [ ] Add production systemd example and reverse-proxy guidance
- [ ] Add backup/restore and upgrade documentation
- [ ] Run the full release checklist
- [ ] Tag `v0.1.0`

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

