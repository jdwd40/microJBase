# microJBase v0.2 release checklist

Release candidate baseline: `16a8e7d` plus the V02-19 documentation/version increment. This checklist records preparation only; it does not authorize a tag or production deployment.

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
- [ ] database-backed unit/integration/E2E suite passes from a clean test database.
- [ ] compiled-server E2E suite passes.
- [ ] Playwright management-UI suite passes.
- [ ] v0.1-to-v0.2 migration is exercised from the v0.1 migration boundary.
- [ ] startup, RSS, and connection measurements are recorded.

Unchecked items are release blockers, not silently waived gates. Exact commands and results are recorded on JDW-16 when the run completes.

## Rollback

Migrations are forward-only. Before upgrade, stop writes and take a verified logical or physical backup. If application rollback is required before a schema mutation, stop the v0.2 process, restore the pre-upgrade database backup, and run the v0.1.0 application against the restored database. Do not point v0.1.0 at a database after v0.2 migrations or schema operations. For a failed operator mutation, rely on the command transaction rollback and operation log; for a committed destructive mutation, restore from backup rather than attempting ad-hoc reverse SQL.

Admin capability rollback is independently reversible: remove `ADMIN_TOKEN` and `SCHEMA_DATABASE_URL`, restart, and verify the admin routes are absent while the v0.1 auth/data API remains available.
