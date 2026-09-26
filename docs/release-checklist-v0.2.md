# microJBase v0.2 release checklist

Verified release baseline: `4ca05c4` (including the V02-19 documentation/version increment and two verification-harness fixes). This checklist records release preparation only; it does not authorize a tag or production deployment.

## Review disposition

- R4 integrated backend/UI review (JDW-15): six findings resolved at `16a8e7d`; no unresolved BLOCKER or MAJOR finding.
- R8 admin HTTP review (JDW-34): SHIP at `dc9dd44`; its five MINOR hardening notes were subsequently closed at `4dd4c68`.
- Earlier R2/R3/R5/R6 findings are represented by the accepted remediation decisions D-027, D-032, and D-035 and their tests.

## Reproducible gates

- [x] `npm ci` succeeds from the committed lockfile; package version is reconciled to `0.2.0`.
- [x] `npm run lint`, `npm run typecheck`, and `npm run build` pass.
- [x] `npm audit --omit=dev --audit-level=moderate` reports zero vulnerabilities.
- [x] tracked high-signal secret scan reports no matches.
- [x] clean database applies migrations 0001 through 0007 in order.
- [x] database-backed unit/integration/E2E suite passes from clean isolated databases: 68 files / 935 tests (unit 36/580, integration 22/287, E2E 10/68).
- [x] compiled-server E2E passes: 10 files / 68 tests spawn `node dist/main.js` behind the build-freshness guard.
- [x] Playwright management-UI suite passes with package-pinned Chromium 1243: 14 tests.
- [x] v0.1-to-v0.2 migration is exercised from the 0001..0004 boundary through 0005..0007; representative users, sessions, and todos remain byte-identical.
- [x] measurements are recorded: 396 ms median startup, 84.26 MiB idle RSS, one idle runtime database connection, and 1,267 req/s with zero failures.

Exact environment, commands, and results are recorded on JDW-36 and summarized here. The 84.26 MiB Node 24 idle measurement exceeds the original 80 MiB target, as did the earlier 81.6 MiB Node 22 measurement. This is accepted as a documented guardrail miss rather than a correctness blocker: startup, workload, and connection checks pass, and the testing strategy explicitly calls for profiling rather than library replacement when the target is missed.

## Rollback

Migrations are forward-only. Before upgrade, stop writes and take a verified logical or physical backup. If application rollback is required before a schema mutation, stop the v0.2 process, restore the pre-upgrade database backup, and run the v0.1.0 application against the restored database. Do not point v0.1.0 at a database after v0.2 migrations or schema operations. For a failed operator mutation, rely on the command transaction rollback and operation log; for a committed destructive mutation, restore from backup rather than attempting ad-hoc reverse SQL.

Admin capability rollback is independently reversible: remove `ADMIN_TOKEN` and `SCHEMA_DATABASE_URL`, restart, and verify the admin routes are absent while the v0.1 auth/data API remains available.
