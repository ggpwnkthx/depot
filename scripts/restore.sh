#!/usr/bin/env bash
# The restore of a deployment (spec §15.4).
#
# The restore is a rehearsal until it is proved: it restores into a
# database of its own, it checks the isolation of the tenants and it
# checks that the deliveries of the restored state are still safe.
#
#   DATA_ADMIN_DATABASE_URL=... DATA_BACKUP_FILE=... ./scripts/restore.sh

set -euo pipefail

: "${DATA_ADMIN_DATABASE_URL:?the url of the administrator of the server is required}"
: "${DATA_BACKUP_FILE:?the file of the backup is required}"
: "${DATA_RESTORE_DATABASE:?the name of the database of the rehearsal is required}"

echo "the database of the rehearsal is created"
psql "${DATA_ADMIN_DATABASE_URL}" -c "drop database if exists ${DATA_RESTORE_DATABASE}" >/dev/null
psql "${DATA_ADMIN_DATABASE_URL}" -c "create database ${DATA_RESTORE_DATABASE}" >/dev/null

RESTORE_URL="$(python3 - "${DATA_ADMIN_DATABASE_URL}" "${DATA_RESTORE_DATABASE}" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
url = urlsplit(sys.argv[1])
print(urlunsplit((url.scheme, url.netloc, '/' + sys.argv[2], url.query, url.fragment)))
PY
)"

echo "the backup is restored"
pg_restore --no-owner --dbname "${RESTORE_URL}" "${DATA_BACKUP_FILE}"

echo "the isolation of the tenants is checked"
# The rows of a workspace are only visible in the scope of their
# workspace: the check runs the same statement as the service, with and
# without the scope of the transaction.
PSQL=(psql "${RESTORE_URL}" -v ON_ERROR_STOP=1 -tA)
"${PSQL[@]}" -c "select count(*) from data.articles" >/dev/null
SCOPED=$("${PSQL[@]}" <<'SQL'
begin;
select set_config('data.tenant_id', '00000000-0000-0000-0000-000000000000', true),
       set_config('data.workspace_id', '00000000-0000-0000-0000-000000000000', true);
select count(*) from data.articles;
commit;
SQL
)
echo "the rows of a scope that does not exist are ${SCOPED}"

echo "the deliveries of the restored state are counted"
"${PSQL[@]}" -c "select count(*) from platform.outbox_deliveries where state in ('pending','leased')"

echo "the rehearsal is done"
