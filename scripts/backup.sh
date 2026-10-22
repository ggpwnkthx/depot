#!/usr/bin/env bash
# The backup of a deployment (spec §15.4).
#
# The backup holds the business records, the workspaces, the audit log,
# the events, the deliveries, the receipts and the history of the
# migrations. The secrets are not in the backup: they belong to the
# secret manager of the deployment.
#
#   DATA_BACKUP_DATABASE_URL=... DATA_BACKUP_DIR=... ./scripts/backup.sh
#
# The url of the backup names a role that **bypasses the row level
# security**: the tables of the deployment are protected by it, and the
# backup of a deployment holds the rows of every tenant. The
# administrator of the server is such a role, and a role with the
# attribute BYPASSRLS is one as well. The command refuses a role that
# is subject to the policies of the tables, because a backup that holds
# the rows of one tenant is not a backup of the deployment.

set -euo pipefail

: "${DATA_BACKUP_DATABASE_URL:?the url of the database of the deployment is required}"
: "${DATA_BACKUP_DIR:?the directory of the backup is required}"

mkdir -p "${DATA_BACKUP_DIR}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${DATA_BACKUP_DIR}/depot-${STAMP}.dump"

# The role of the backup has to see every row of the deployment: the
# tables of the business carry the row level security, forced, and the
# owner of a table is subject to it.
BYPASSES="$(psql "${DATA_BACKUP_DATABASE_URL}" -v ON_ERROR_STOP=1 -tA -q -c \
  "select coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), false)")"
if [ "${BYPASSES}" != "t" ]; then
  echo "the role of the backup is subject to the row level security of the tables" >&2
  echo "the backup of a deployment holds the rows of every tenant: it needs a role" >&2
  echo "that bypasses it, the administrator of the server or a role with BYPASSRLS" >&2
  exit 1
fi

echo "the backup is written to ${FILE}"
pg_dump --format=custom --no-owner --file "${FILE}" "${DATA_BACKUP_DATABASE_URL}"

# The artifacts of the deployment travel with the backup: the manifests
# and the policies are the meaning of the data.
for artifact in manifests/schema.json manifests/policies.json; do
  if [ -f "${artifact}" ]; then
    cp "${artifact}" "${DATA_BACKUP_DIR}/$(basename "${artifact}")-${STAMP}"
  fi
done

sha256sum "${FILE}" > "${FILE}.sha256"
echo "the backup is done"
