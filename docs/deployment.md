# Deploying microJBase v0.1

microJBase is one Node.js process and one PostgreSQL database. This guide is a
minimal, reproducible production deployment on Ubuntu/Debian using systemd and
nginx. No containers or orchestration are required.

## 1. Requirements

- Ubuntu 22.04/24.04 or Debian 12+ (any modern Linux works; commands below use apt).
- Node.js **22.13.0 or newer** LTS. Install from [nodejs.org](https://nodejs.org/)
  or your distribution's nodejs package only if it meets the version in `package.json` `engines`.
- PostgreSQL **16 or newer**, running locally or on a host you control.
- A non-root deployment user, e.g. `microjbase`.
- nginx (or another reverse proxy) for TLS termination in production.

The application listens on `HOST:PORT` (default `127.0.0.1:3000`), expects
PostgreSQL via `DATABASE_URL`, and serves no static files. All state lives in
PostgreSQL.

## 2. Initial deployment

### 2.1 Create the database and roles

Use two roles, matching the project's privilege model
(`ARCHITECTURE.md` §7, `DECISIONS.md` D-008):

- **migration/admin role** — owns the database objects and runs DDL. Used only
  by `npm run migrate`.
- **runtime role** — the restricted role the API connects as. Never superuser,
  never `BYPASSRLS`.

Run as a PostgreSQL superuser (e.g. `sudo -u postgres psql`):

```sql
CREATE ROLE microjbase_admin WITH LOGIN PASSWORD '<strong-random-password>';
CREATE DATABASE microjbase OWNER microjbase_admin;

-- Restricted runtime role: the API refuses to start if this role is a
-- superuser or has BYPASSRLS.
CREATE ROLE microjbase_runtime WITH LOGIN PASSWORD '<strong-random-password>'
  NOSUPERUSER NOBYPASSRLS;
```

### 2.2 Install the application

```bash
sudo useradd --system --home /opt/microjbase --shell /usr/sbin/nologin microjbase
sudo mkdir -p /opt/microjbase
sudo chown microjbase:microjbase /opt/microjbase

# As the deploy user, from the release checkout:
git clone https://github.com/jdwd40/microJBase.git /opt/microjbase/app
cd /opt/microjbase/app
git checkout <release-tag-or-commit>
npm ci                 # reproducible install from package-lock.json
npm run build          # compiles src/ to dist/
```

`npm ci --omit=dev` is **not** supported for running the compiled server in
this release: the migration command (`npm run migrate`) runs through `tsx`,
which is a dev dependency. Either keep dev dependencies installed, or run
migrations from a separate checkout with `MIGRATION_DATABASE_URL` pointing at
the production database.

### 2.3 Configure the environment

Create `/etc/microjbase/microjbase.env` (mode `0400`, readable only by the
service user). systemd `EnvironmentFile` uses plain `KEY=value` lines — no
shell expansion:

```ini
DATABASE_URL=postgres://microjbase_runtime:<strong-random-password>@127.0.0.1:5432/microjbase
MIGRATION_DATABASE_URL=postgres://microjbase_admin:<strong-random-password>@127.0.0.1:5432/microjbase
HOST=127.0.0.1
PORT=3000
LOG_LEVEL=info
SESSION_TTL_SECONDS=604800
MICROJBASE_TABLES=todos=public.todos
TRUST_PROXY=false
MAX_BODY_BYTES=1048576
```

Variable contract: `ARCHITECTURE.md` §6. Secrets are never committed;
`.env` files in the repo are development-only.

### 2.4 Run migrations

Migrations are forward-only, run explicitly — never automatically at startup.
They take a PostgreSQL advisory lock, so concurrent runs serialize safely:

```bash
set -a; . /etc/microjbase/microjbase.env; set +a
cd /opt/microjbase/app
npm run migrate
```

Expected output: `Applied migration 0001_...` through the newest file. A
re-run prints nothing and exits 0.

Migrations intentionally create no roles and grant no runtime privileges.
Before the application can start, the restricted runtime role needs exactly
the privileges the API uses — nothing more. Run as the migration/admin role:

```sql
GRANT USAGE ON SCHEMA microjbase TO microjbase_runtime;

GRANT SELECT ON microjbase.schema_migrations TO microjbase_runtime;

GRANT SELECT, INSERT ON microjbase.users TO microjbase_runtime;

GRANT SELECT, INSERT, UPDATE ON microjbase.sessions TO microjbase_runtime;

GRANT USAGE ON SCHEMA public TO microjbase_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.todos TO microjbase_runtime;
```

This mirrors the privilege model proven by the integration/E2E suites. Keep
these rules in mind:

- The runtime role must remain `NOSUPERUSER NOBYPASSRLS` — the application
  checks this at startup and refuses to run otherwise. Do not broaden the
  role to make something "work"; fix the missing grant instead.
- Every exposed application table (each `MICROJBASE_TABLES` entry) requires
  its own explicit runtime grant. Adding another table means granting its
  intended CRUD privileges here after creating/migrating it.
- This is also why the migrations never grant anything: privileges are a
  deployment decision, reviewed per exposed table.
- When restoring into newly recreated roles (see
  [operations.md](operations.md)), these grants may need to be reapplied —
  `pg_dump` archives do not carry `GRANT` statements for roles that did not
  exist at dump time.

### 2.5 systemd unit

`/etc/systemd/system/microjbase.service`:

```ini
[Unit]
Description=microJBase API
Documentation=https://github.com/jdwd40/microJBase
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=microjbase
Group=microjbase
WorkingDirectory=/opt/microjbase/app
EnvironmentFile=/etc/microjbase/microjbase.env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
# The application completes in-flight requests and closes its pool on
# SIGTERM; measured shutdown is well under a second.
TimeoutStopSec=15

# Hardening. The application needs no filesystem writes, no device access,
# no elevated privileges, and no exotic syscalls; these directives are safe
# for that shape on modern systemd. Review against your systemd version
# rather than treating this list as certified.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
LockPersonality=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
```

Adjust `ExecStart` to the absolute path of Node 22 (`command -v node`).
`ProtectSystem=full` leaves `/opt` writable-owned-by-root read-only, which is
fine: the application performs no runtime filesystem writes.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now microjbase
systemctl status microjbase
```

### 2.6 Reverse proxy (nginx)

The application defaults to `HOST=127.0.0.1` and `TRUST_PROXY=false`. Keep
both: nginx talks to the app over loopback TCP, so the app never needs to
trust forwarded headers.

`/etc/nginx/sites-available/microjbase`:

```nginx
server {
    listen 80;
    server_name api.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    # Application default is 1 MiB; keep the proxy in step.
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

Notes:

- Set `TRUST_PROXY=true` **only** if you move the proxy off-loopback and need
  per-client-IP rate limiting behind exactly one trusted proxy hop. Leaving it
  `false` is the safe default; forwarded headers are then ignored.
- TLS terminates at nginx; traffic nginx→app is plain HTTP on loopback.
- Acquire certificates with certbot or your CA; that is standard nginx
  operation and not microJBase-specific.

### 2.7 Verify

```bash
curl -fsS http://127.0.0.1:3000/health
# {"data":{"status":"ok","database":"ok"},"error":null}

TOKEN=$(curl -fsS -X POST http://127.0.0.1:3000/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"deploy-check@example.com","password":"correct horse battery staple"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])')
curl -fsS -X POST http://127.0.0.1:3000/v1/data/todos \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"deployment verified"}'
```

See [operations.md](operations.md) for backup, restore, and upgrade.
