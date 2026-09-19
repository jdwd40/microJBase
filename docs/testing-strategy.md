# Testing Strategy

Testing is part of each module task, not a final clean-up stage.

## Test layers

### Unit

No PostgreSQL or network.

- config parsing and redaction;
- email/password validation;
- auth service with fake repositories;
- token generation/hash boundaries;
- data service table/column validation;
- error mapping and response envelopes;
- rate-limiter bounds and expiry using a fake clock.

### Integration

Runs against a real supported PostgreSQL instance.

- migrations on an empty database;
- migration checksum and locking behaviour;
- user/session repositories;
- table-registry safety failures;
- CRUD and constraints;
- RLS isolation between Alice and Bob;
- transaction rollback;
- pooled-connection identity leakage;
- restricted role and `BYPASSRLS` startup refusal.

Mocks are not acceptable for PostgreSQL semantics, RLS, migrations, or SQL-injection tests.

### End to end

Starts the compiled server and uses HTTP only. It covers the proof-of-life flow in `v0.1-scope.md`, validation/errors, expiry/logout, pagination bounds, body-size rejection, and graceful database failure.

### Adversarial/security

At minimum:

- table aliases and JSON keys containing quotes, separators, comments, Unicode, and overlong input;
- attempts to expose `microjbase.users`, system schemas, or an unlisted table;
- invalid/expired/revoked tokens and log inspection for token leakage;
- wrong-email versus wrong-password public equivalence;
- RLS bypass attempts using supplied `user_id` values;
- parallel requests from different users on a small pool;
- malformed JSON, large bodies, large offsets, and rate-limit state bounds;
- PostgreSQL error text never reaching the client.

## Determinism and isolation

- Tests create unique data and clean it transactionally or recreate the test database.
- Time and random-token sources are injectable at the auth-service boundary for unit tests.
- No test depends on order, production secrets, or an external internet service.
- Integration/e2e commands fail clearly when their test PostgreSQL URL is absent.
- CI uses a clean PostgreSQL service and applies migrations from zero.

## Standard commands

Stage 1 must provide these stable scripts:

```bash
npm run build
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm test
```

`npm test` runs all non-benchmark checks appropriate for CI.

## Coverage

Coverage is a signal, not the goal. Initial gates:

- 90% branch coverage for `auth/`, `data/`, and `core/`;
- 80% branch coverage overall;
- all security invariants have explicit named tests regardless of percentage.

Generated coverage is not committed.

## Footprint and performance

Benchmarks run separately from correctness tests and record:

- machine/OS, Node, PostgreSQL, dependency-lock, and commit versions;
- cold startup to ready;
- idle RSS after 60 seconds;
- RSS and latency under a documented 20-concurrent-client CRUD workload;
- database pool size and row count.

The initial release target is API idle RSS at or below 80 MiB. If missed, profile before replacing libraries. Results, including disappointing ones, are committed as Markdown; generated raw output is not.

## Pull-request evidence

Every implementation PR or agent handoff lists commands run and their exact result. “Tests should pass” is not evidence.

