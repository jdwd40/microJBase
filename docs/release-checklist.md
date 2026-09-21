# microJBase v0.1 release checklist

For the integrator's final go/no-go. Every item cites where the evidence
lives; nothing here is assumed.

## Verification

- [ ] CI green on the merge commit (GitHub `verify` workflow).
- [ ] `npm run format:check` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — clean compile of `src/` to `dist/`.
- [ ] `npm test` — **34 files / 352 tests green** (unit 206, integration 111,
      e2e 35). Baseline recorded in `package.json` history and PR #23.
- [ ] Clean-database migration: fresh database, `npm run migrate` applies
      0001→0004 and is idempotent on re-run (evidence: deployment.md §2.4
      procedure; exercised by integration/e2e suites and the benchmark
      script's provisioning path).
- [ ] No uncommitted changes or undeclared dependencies
      (`git status` clean; `npm ci` reproduces `node_modules`).

## Functional smoke (deployed, compiled application)

- [ ] `GET /health` → 200 `{"status":"ok","database":"ok"}`.
- [ ] Register + login → opaque bearer token.
- [ ] Authenticated CRUD round-trip on an exposed table.
- [ ] Missing `Authorization` on `/v1/data/*` → 401 `AUTH_REQUIRED`, no
      database mutation.
- [ ] RLS isolation: user B cannot read/update user A's rows
      (404 `ROW_NOT_FOUND` envelope; no cross-user leakage).

## Security

- [ ] Security review status: PASS (Red review of v0.1: 0 blockers, 1 major
      fixed in PR #23, 8 minors deferred and recorded below).
- [ ] Runtime role check: `microjbase_runtime` is `NOSUPERUSER`,
      `NOBYPASSRLS`; application refuses to start otherwise.
- [ ] Secrets in environment only — none in repository or logs.

## Operations

- [ ] [deployment.md](deployment.md) followed end-to-end on a clean host:
      systemd unit starts, serves, and stops cleanly (SIGTERM → pool closed,
      measured shutdown well under `TimeoutStopSec=15`).
- [ ] Backup procedure run at least once and the archive copied off-host.
- [ ] Restore procedure rehearsed at least once into a scratch database and
      verified with the smoke checks above.
- [ ] Upgrade sequence (backup → `npm ci` → build → migrate → restart →
      health) rehearsed or reviewed against this host's layout.

## Known limitations (recorded, non-blocking)

Deferred from the Red review; see PR #23 body and
[release notes](release-notes-v0.1.md):

- No network-level "PostgreSQL unreachable" E2E harness (DB→503 behaviour is
  unit/integration covered instead).
- Rate-limiter eviction behaviour at maximum entries.
- Catch-all 404 uses `TABLE_NOT_FOUND` naming even for non-table routes.
- Fastify's default 415 mapping not customized.
- Runtime privilege-check placement could be factored into the database
  module.
- No policy-expression introspection endpoint (by design).
- Client-supplied `updated_at` accepted on rows without an ownership column.
- Own-UUID ownership comparison is case-sensitive on some paths.
- Broad `42501 → 409 CONFLICT` mapping in the data repository (defence in
  depth; RLS is the real enforcement boundary).

## Release mechanics

- [ ] All PRs in the v0.1 plan merged; PR #11 (this one) last.
- [ ] **Do not create the version tag in this PR.** The `v0.1` tag is created
      by the integrator only after this checklist is fully checked.
