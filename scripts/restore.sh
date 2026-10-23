#!/usr/bin/env bash
# The restore of a deployment (spec §15.4).
#
# The restore is a rehearsal until it is proved: it restores into a
# database of its own, it checks the isolation of the tenants and it
# checks that the deliveries of the restored state are still safe.
#
#   DATA_ADMIN_DATABASE_URL=... DATA_RUNTIME_DATABASE_URL=... \
# DATA_BACKUP_FILE=... ./scripts/restore.sh
#
# The restore runs with the administrator of the server: the tables of
# the deployment are protected by the row level security, and the rows
# of a restore belong to every tenant. The ownership of the restored
# tables goes back to the owner of the schema, when the url of the
# owner is given.

set -euo pipefail

: "${DATA_ADMIN_DATABASE_URL:?the url of the administrator of the server is required}"
: "${DATA_BACKUP_FILE:?the file of the backup is required}"
: "${DATA_RESTORE_DATABASE:?the name of the database of the rehearsal is required}"

# The client of the restore must not be older than the server: a dump
# that is taken by a newer client is not restored by an older one, and
# the refusal of the client is not the message that an operator needs.
SERVER_MAJOR="$(( $(psql "${DATA_ADMIN_DATABASE_URL}" -v ON_ERROR_STOP=1 -tA -q -c 'show server_version_num') / 10000 ))"
CLIENT_MAJOR="$(pg_restore --version | sed -E 's/.*PostgreSQL\) ([0-9]+).*/\1/')"
case "${CLIENT_MAJOR}" in
  '' | *[!0-9]*) CLIENT_MAJOR=0 ;;
esac
if [ "${CLIENT_MAJOR}" -lt "${SERVER_MAJOR}" ]; then
  echo "the client of the restore is the version ${CLIENT_MAJOR} and the server is the version ${SERVER_MAJOR}" >&2
  echo "the client must not be older than the server: install the client of the major of the server" >&2
  exit 1
fi

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

# The ownership of the restored tables goes back to the owner of the
# schema: the restore is done with the administrator of the server, and
# the owner is the only role that may alter the schema.
if [ -n "${DATA_OWNER_DATABASE_URL:-}" ]; then
  echo "the ownership of the restored tables goes back to the owner of the schema"
  OWNER_URL="$(python3 - "${DATA_OWNER_DATABASE_URL}" "${DATA_RESTORE_DATABASE}" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
url = urlsplit(sys.argv[1])
print(urlunsplit((url.scheme, url.netloc, '/' + sys.argv[2], url.query, url.fragment)))
PY
)"
  psql "${RESTORE_URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
declare
  entry record;
begin
  for entry in
    select c.relname as name, n.nspname as schema
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('platform', 'data') and c.relkind in ('r', 'p')
  loop
    execute format('alter table %I.%I owner to data_owner', entry.schema, entry.name);
  end loop;
  for entry in
    select nspname as name from pg_namespace where nspname in ('platform', 'data')
  loop
    execute format('alter schema %I owner to data_owner', entry.name);
  end loop;
end
$$;
SQL
fi

echo "the isolation of the tenants is checked"
# The rows of a workspace are only visible in the scope of their
# workspace: the check runs the same statement as the service, with and
# without the scope of the transaction.
#
# The check runs with the role of the api and not with the
# administrator: an administrator bypasses the policies of the tables,
# and the check would prove nothing.
if [ -z "${DATA_RUNTIME_DATABASE_URL:-}" ]; then
  echo "DATA_RUNTIME_DATABASE_URL is required for the check of the isolation" >&2
  echo "it names the role of the api, in the database of the rehearsal" >&2
  exit 1
fi
CHECK_URL="$(python3 - "${DATA_RUNTIME_DATABASE_URL}" "${DATA_RESTORE_DATABASE}" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
url = urlsplit(sys.argv[1])
print(urlunsplit((url.scheme, url.netloc, '/' + sys.argv[2], url.query, url.fragment)))
PY
)"
PSQL=(psql "${CHECK_URL}" -v ON_ERROR_STOP=1 -tA -q)
RESTORED=$("${PSQL[@]}" -c "select count(*) from data.articles")
# The images of the versions are part of the business data: they are
# restored with it, and the scope that does not exist sees none of them.
RESTORED_VERSIONS=$("${PSQL[@]}" -c "select count(*) from data.article_versions")
SCOPED=$("${PSQL[@]}" <<'SQL' | tail -1
begin;
select set_config('data.tenant_id', '00000000-0000-0000-0000-000000000000', true),
       set_config('data.workspace_id', '00000000-0000-0000-0000-000000000000', true);
select count(*) from data.articles;
commit;
SQL
)
SCOPED_VERSIONS=$("${PSQL[@]}" <<'SQL' | tail -1
begin;
select set_config('data.tenant_id', '00000000-0000-0000-0000-000000000000', true),
       set_config('data.workspace_id', '00000000-0000-0000-0000-000000000000', true);
select count(*) from data.article_versions;
commit;
SQL
)
echo "the restored rows are ${RESTORED}"
echo "the rows of a scope that does not exist are ${SCOPED}"
echo "the restored images of the versions are ${RESTORED_VERSIONS}"
echo "the images of a scope that does not exist are ${SCOPED_VERSIONS}"

echo "the deliveries of the restored state are counted"
# The deliveries are the metadata of the worker: the role of the api may
# not read them, and the check uses the role of the deliveries.
DELIVERY_URL="$(python3 - "${DATA_DELIVERY_DATABASE_URL:-}" "${DATA_RESTORE_DATABASE}" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit
if not sys.argv[1]:
    print('')
else:
    url = urlsplit(sys.argv[1])
    print(urlunsplit((url.scheme, url.netloc, '/' + sys.argv[2], url.query, url.fragment)))
PY
)"
if [ -n "${DELIVERY_URL}" ]; then
  psql "${DELIVERY_URL}" -v ON_ERROR_STOP=1 -tA -q \
    -c "select count(*) from platform.outbox_deliveries where state in ('pending','leased')"
else
  echo "DATA_DELIVERY_DATABASE_URL is not set: the deliveries are not counted" >&2
fi

echo "the rehearsal is done"
