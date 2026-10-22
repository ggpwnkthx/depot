#!/usr/bin/env bash
# The rehearsal of the backup and of the restore (spec §15.4).
#
# The rehearsal is a step of the release of a deployment: it writes a
# backup of a database with data, it restores it into a database of its
# own, and it checks the isolation of the tenants and the deliveries of
# the restored state.
#
#   bash scripts/rehearse-backup.sh
#
# The script starts a PostgreSQL server of its own, it provisions the
# roles of the separation, it applies the migrations, it writes one
# record in one workspace, and it runs the two commands of the
# deployment.

set -euo pipefail

export LANG=C
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

WORKSPACE="$(mktemp -d /tmp/depot-rehearsal-XXXXXX)"
SERVER_PORT="${REHEARSAL_PORT:-39937}"
PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)"
OWNER_PASSWORD="rehearsal-owner-password-001"
RUNTIME_PASSWORD="rehearsal-runtime-password-01"
REGISTRY_PASSWORD="rehearsal-registry-password-01"
DELIVERY_PASSWORD="rehearsal-delivery-password-01"
MAINTENANCE_PASSWORD="rehearsal-maintenance-password-1"

cleanup() {
  "${PG_BIN}/pg_ctl" -D "${WORKSPACE}/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "${WORKSPACE}"
}
trap cleanup EXIT

echo "the server of the rehearsal is started"
mkdir -p "${WORKSPACE}/data" "${WORKSPACE}/socket"
LANG=C LC_ALL=C "${PG_BIN}/initdb" -D "${WORKSPACE}/data" -U depot --auth=trust >/dev/null
LANG=C LC_ALL=C "${PG_BIN}/pg_ctl" -D "${WORKSPACE}/data" \
  -o "-p ${SERVER_PORT} -k ${WORKSPACE}/socket -c listen_addresses=127.0.0.1" \
  -l "${WORKSPACE}/server.log" start >/dev/null

ADMIN_URL="postgres://depot@127.0.0.1:${SERVER_PORT}/postgres"
CLUSTER_URL="postgres://depot@127.0.0.1:${SERVER_PORT}/depot"

export DATA_ADMIN_DATABASE_URL="${ADMIN_URL}"
export DATA_OWNER_DATABASE_URL="postgres://data_owner:${OWNER_PASSWORD}@127.0.0.1:${SERVER_PORT}/depot"
export DATA_OWNER_PASSWORD="${OWNER_PASSWORD}"
export DATA_RUNTIME_PASSWORD="${RUNTIME_PASSWORD}"
export DATA_REGISTRY_PASSWORD="${REGISTRY_PASSWORD}"
export DATA_DELIVERY_PASSWORD="${DELIVERY_PASSWORD}"
export DATA_MAINTENANCE_PASSWORD="${MAINTENANCE_PASSWORD}"

echo "the roles and the database are provisioned"
bun run scripts/provision.ts

echo "the schema is applied"
bun run scripts/migrate.ts

echo "the workspace and its record are written"
WORKSPACE_ID="44444444-4444-4444-8444-444444444444"
TENANT_ID="55555555-5555-4555-8555-555555555555"
LANG=C LC_ALL=C psql "${CLUSTER_URL}" -v ON_ERROR_STOP=1 -q <<SQL
insert into platform.workspaces (id, tenant_id, slug, display_name)
values ('${WORKSPACE_ID}', '${TENANT_ID}', 'acme', 'The workspace of the rehearsal');
SQL
LANG=C LC_ALL=C psql "postgres://data_runtime:${RUNTIME_PASSWORD}@127.0.0.1:${SERVER_PORT}/depot" -v ON_ERROR_STOP=1 -q <<SQL
begin;
select set_config('data.tenant_id', '${TENANT_ID}', true),
       set_config('data.workspace_id', '${WORKSPACE_ID}', true),
       set_config('data.principal_id', '11111111-1111-4111-8111-111111111111', true);
insert into data.articles (id, tenant_id, workspace_id, created_by, created_at, updated_by, updated_at, version, title)
values ('66666666-6666-4666-8666-666666666666', '${TENANT_ID}', '${WORKSPACE_ID}',
        '11111111-1111-4111-8111-111111111111', now(), '11111111-1111-4111-8111-111111111111', now(), 1, 'The article of the rehearsal');
commit;
SQL

echo "the backup is written"
# The backup runs with the administrator of the server: the tables of
# the deployment carry the row level security, and the backup holds the
# rows of every tenant.
export DATA_BACKUP_DATABASE_URL="${CLUSTER_URL}"
export DATA_BACKUP_DIR="${WORKSPACE}/backup"
bash scripts/backup.sh

echo "the restore is rehearsed"
export DATA_RUNTIME_DATABASE_URL="postgres://data_runtime:${RUNTIME_PASSWORD}@127.0.0.1:${SERVER_PORT}/depot"
export DATA_DELIVERY_DATABASE_URL="postgres://data_delivery:${DELIVERY_PASSWORD}@127.0.0.1:${SERVER_PORT}/depot"
export DATA_BACKUP_FILE="$(ls "${WORKSPACE}"/backup/depot-*.dump | head -1)"
export DATA_RESTORE_DATABASE="depot_rehearsal"
export DATA_OWNER_DATABASE_URL="postgres://data_owner:${OWNER_PASSWORD}@127.0.0.1:${SERVER_PORT}/depot"
bash scripts/restore.sh
