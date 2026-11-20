#!/usr/bin/env bash
# Runs on a fresh GitHub-hosted Linux runner after CI builds the application.
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?}" "${INTEGRATION_DATABASE_URL:?}"
admin_url="${MIGRATION_DATABASE_URL%/*}/microjbase_deploy_check"
runtime_url="${INTEGRATION_DATABASE_URL%/*}/microjbase_deploy_check"
createdb --maintenance-db="$MIGRATION_DATABASE_URL" microjbase_deploy_check
MIGRATION_DATABASE_URL="$admin_url" npm run migrate
awk '/^GRANT USAGE ON SCHEMA microjbase/{copy=1} copy && /^```/{exit} copy' docs/deployment.md |
  psql -X -v ON_ERROR_STOP=1 "$admin_url"

sudo useradd --system --user-group --home /opt/microjbase --shell /usr/sbin/nologin microjbase
sudo install -d /opt/microjbase/app /etc/microjbase
sudo cp -a dist node_modules admin-ui package.json /opt/microjbase/app/
sudo install -m 755 "$(command -v node)" /opt/microjbase/node
sudo install -m 600 /dev/null /etc/microjbase/microjbase.env
printf '%s\n' "DATABASE_URL=$runtime_url" 'HOST=127.0.0.1' 'PORT=39010' 'MICROJBASE_TABLES=todos=public.todos' |
  sudo tee /etc/microjbase/microjbase.env >/dev/null
awk '/^\[Unit\]/{copy=1} copy && /^```/{exit} copy' docs/deployment.md |
  sed 's|ExecStart=/usr/bin/node|ExecStart=/opt/microjbase/node|' |
  sudo tee /etc/systemd/system/microjbase.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl start microjbase
curl --retry 15 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:39010/health |
  jq -e '.data.database == "ok"'
sudo systemctl stop microjbase
test "$(systemctl show microjbase -p Result --value)" = success
test "$(systemctl show microjbase -p ActiveState --value)" = inactive
