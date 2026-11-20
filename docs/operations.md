# Operating microJBase v0.1

Backup, restore, and upgrade procedures for a deployment per
[deployment.md](deployment.md). Examples assume the systemd unit
`microjbase.service` and environment file `/etc/microjbase/microjbase.env`.

## Backup

Take a full custom-format archive on the database host. The documented
migration owner is subject to FORCE ROW LEVEL SECURITY and cannot take a
complete dump. The local PostgreSQL maintenance account can read all rows.
Run these commands from a private backup directory as the operator:

```bash
umask 077
archive="microjbase-$(date -u +%F-%H%M%S).dump"
sudo -u postgres pg_dump --format=custom --compress=9 --dbname=microjbase > "$archive"
```

Check the command's exit status before retaining or transferring the archive.
Keep the maintenance account separate from application credentials.

What the dump contains: schema (all migrations applied), table data, and the
runtime grants relevant to data. What it does **not** contain: the role
definitions themselves (`CREATE ROLE` statements) — keep the role/password
provisioning SQL from deployment under version control or in your secrets
manager, because a restore into a fresh cluster needs them first.

PostgreSQL takes a consistent snapshot while the application is running.
For a cutover, pause writes before the final dump so later writes are retained.

Copy the `.dump` file off the host. Test restores periodically — an untested
backup is not a backup.

## Restore

Target: rebuild the service from a backup, on the same or a newer application
version. Migrations are forward-only, so restoring an older data set and then
starting the app never runs "down" migrations — but it also never repairs
schema drift; restore to the application version that took the backup, then
upgrade normally.

Run database creation from a cluster administrator's maintenance session on
the database host. The migration role in the deployment guide lacks CREATEDB.
Keep cluster-administrator credentials outside the application environment.
On Debian or Ubuntu the examples below use local peer authentication.

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

3. **Create a fresh restore target while retaining the original database.**
   Choose an unused database name. If creation fails, stop and correct the
   error. Leave the existing database available for rollback.

   ```bash
   sudo -u postgres createdb --owner=microjbase_admin microjbase_restored
   ```

   Set the database name in the migration, runtime and any enabled schema-admin
   connection URLs to the new target, preserving each role and its credentials.
   Load the updated environment in the restore shell before running the next
   commands. Keep a copy of the original configuration for rollback.

4. **Restore into the fresh target** using the local maintenance account.
   Set `archive` to the selected backup path in the operator shell:

   ```bash
   sudo -u postgres pg_restore --exit-on-error --single-transaction \
     --dbname=microjbase_restored < "$archive"
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
set -a; . /etc/microjbase/migration.env; set +a
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
