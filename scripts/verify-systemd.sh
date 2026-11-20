#!/usr/bin/env bash
# Runs on a fresh GitHub-hosted Linux runner after CI builds the application.
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?}" "${INTEGRATION_DATABASE_URL:?}"
runtime_url="${INTEGRATION_DATABASE_URL%/*}/microjbase_deploy_check"
psql -X -v ON_ERROR_STOP=1 "$MIGRATION_DATABASE_URL" -c "CREATE ROLE microjbase_deploy_owner LOGIN PASSWORD 'ci_deploy_owner'"
createdb --maintenance-db="$MIGRATION_DATABASE_URL" --owner=microjbase_deploy_owner microjbase_deploy_check
owner_url="postgres://microjbase_deploy_owner:ci_deploy_owner@localhost:5432/microjbase_deploy_check"
MIGRATION_DATABASE_URL="$owner_url" npm run migrate
awk '/^GRANT USAGE ON SCHEMA microjbase/{copy=1} copy && /^```/{exit} copy' docs/deployment.md |
  psql -X -v ON_ERROR_STOP=1 "$owner_url"

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
token=$(curl -fsS http://127.0.0.1:39010/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"restore@example.test","password":"disposable smoke test password"}' | jq -er '.data.token')
row=$(curl -fsS http://127.0.0.1:39010/v1/data/todos -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' -d '{"title":"restore round trip"}' | jq -er '.data.id')
sudo systemctl stop microjbase
test "$(systemctl show microjbase -p Result --value)" = success
test "$(systemctl show microjbase -p ActiveState --value)" = inactive


# Use the matching PostgreSQL client tools from the ephemeral database service.
umask 077
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
docker exec "$POSTGRES_CONTAINER" pg_dump -U microjbase -Fc microjbase_deploy_check > "$archive"
createdb --maintenance-db="$MIGRATION_DATABASE_URL" --owner=microjbase_deploy_owner microjbase_restore_check
docker exec -i "$POSTGRES_CONTAINER" pg_restore -U microjbase --exit-on-error --single-transaction \
  --dbname=microjbase_restore_check < "$archive"
MIGRATION_DATABASE_URL="${owner_url%/*}/microjbase_restore_check" npm run migrate
sudo sed -i 's/microjbase_deploy_check$/microjbase_restore_check/' /etc/microjbase/microjbase.env
sudo systemctl start microjbase
curl --retry 15 --retry-connrefused --retry-delay 1 -fsS "http://127.0.0.1:39010/v1/data/todos/$row" \
  -H "Authorization: Bearer $token" | jq -e '.data.title == "restore round trip"'
sudo systemctl stop microjbase
