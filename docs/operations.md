# Operating microJBase v0.1

Backup, restore, and upgrade procedures for a deployment per
[deployment.md](deployment.md). Examples assume the systemd unit
`microjbase.service` and environment file `/etc/microjbase/microjbase.env`.

## Backup

The simplest reliable backup is a `pg_dump` custom-format archive taken with
the migration/admin role. `pg_dump` output is consistent per-table; for a
tiny application a brief maintenance window is the safe choice.

```bash
set -a; . /etc/microjbase/microjbase.env; set +a
pg_dump --format=custom --compress=9 \
  --file="microjbase-$(date -u +%F-%H%M%S).dump" \
  "$MIGRATION_DATABASE_URL"
```

What the dump contains: schema (all migrations applied), table data, and the
runtime grants relevant to data. What it does **not** contain: the role
definitions themselves (`CREATE ROLE` statements) — keep the role/password
provisioning SQL from deployment under version control or in your secrets
manager, because a restore into a fresh cluster needs them first.

**Take the backup with the application stopped or during a quiet window.** The
dump is not crash-consistent with concurrent writes; writes in flight during
the dump may be absent or half-visible. For v0.1 workloads:

```bash
sudo systemctl stop microjbase
pg_dump ... (command above)
sudo systemctl start microjbase
```

Copy the `.dump` file off the host. Test restores periodically — an untested
backup is not a backup.

## Restore

Target: rebuild the service from a backup, on the same or a newer application
version. Migrations are forward-only, so restoring an older data set and then
starting the app never runs "down" migrations — but it also never repairs
schema drift; restore to the application version that took the backup, then
upgrade normally.

Database-level operations (dropping/creating the database) must run while
connected to a **different** database — you cannot drop the database you are
currently connected to. Define a maintenance URL that points at the standard
`postgres` maintenance database (same host/admin role, different database):

```bash
set -a; . /etc/microjbase/microjbase.env; set +a
MAINTENANCE_DATABASE_URL='postgres://microjbase_admin:<strong-random-password>@127.0.0.1:5432/postgres'
```

Every `psql` command in steps 3 below uses this maintenance URL — not
`MIGRATION_DATABASE_URL`. (A URI's database component selects the connection
database; appending `-d postgres` to a psql invocation does **not** reliably
override a connection URL that already names another database.)

1. **Provision roles/database** if the cluster is fresh (same SQL as
   deployment §2.1), with the same passwords as at backup time, or update
   `/etc/microjbase/microjbase.env` to the new credentials. If the roles were
   recreated rather than preserved, reapply the runtime GRANTs from
   [deployment.md](deployment.md) §2.4 — `pg_dump` archives do not carry
   grants for roles that did not exist at dump time.

2. **Stop the application**:

   ```bash
   sudo systemctl stop microjbase
   ```

3. **Terminate active connections, then drop and recreate the database**
   (restoring into a dirty database risks constraint conflicts). All three
   commands connect through the maintenance URL to the `postgres` database,
   never to `microjbase` itself:

   ```bash
   psql "$MAINTENANCE_DATABASE_URL" \
     -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
         WHERE datname = 'microjbase' AND pid <> pg_backend_pid();"

   psql "$MAINTENANCE_DATABASE_URL" -c 'DROP DATABASE microjbase;'

   psql "$MAINTENANCE_DATABASE_URL" \
     -c 'CREATE DATABASE microjbase OWNER microjbase_admin;'
   ```

4. **Restore into the recreated application database** using the
   migration/admin URL (here the URI's database component is correct — it
   names the freshly recreated `microjbase`):

   ```bash
   pg_restore --clean --if-exists --exit-on-error \
     --dbname="$MIGRATION_DATABASE_URL" microjbase-<timestamp>.dump
   ```

   Schema-migration bookkeeping (`microjbase.schema_migrations`) is restored
   with the data, so already-applied migrations will not re-run.

5. **Verify the restoration before serving traffic**:

   ```bash
   cd /opt/microjbase/app && npm run migrate   # must print nothing and exit 0
   sudo systemctl start microjbase
   curl -fsS http://127.0.0.1:3000/health
   # then an authenticated CRUD round-trip (deployment.md §2.7)
   ```

   Confirm row counts look sane for your tables, and that an existing user
   can log in — password hashes and session rows are table data and survive
   the restore.

**Credential warning:** backups contain all application data including hashed
passwords and opaque session rows. Handle `.dump` files as secrets.

**Version warning:** never point an *older* application build at a database
restored from a *newer* version's backup — forward-only migrations mean the
old code does not understand the new schema.

## Upgrade

Normal sequence for a new application release:

```bash
# 1. Backup (see above).

# 2. Fetch and install the new version.
cd /opt/microjbase/app
sudo systemctl stop microjbase
git fetch --tags
git checkout <new-release-tag>
npm ci
npm run build

# 3. Forward migrations — explicit, advisory-locked, idempotent.
set -a; . /etc/microjbase/microjbase.env; set +a
npm run migrate

# 4. Restart and verify.
sudo systemctl start microjbase
sleep 1
curl -fsS http://127.0.0.1:3000/health
# Smoke test: register/login, one CRUD round-trip, one RLS negative check.
```

Notes:

- Migrations must run **before** the new code serves traffic — the runtime
  role has no DDL rights, and the old code tolerates additive changes only by
  luck; don't rely on it.
- The service tolerates stop/start cleanly (graceful shutdown closes the pool
  after in-flight requests), so the maintenance window is seconds.
- If `npm run migrate` fails, the service stays stopped and the database is
  left at its previous migration state (each migration runs in its own
  transaction); investigate before retrying.
- Rollback = restore from the pre-upgrade backup. There is no downgrade path.
