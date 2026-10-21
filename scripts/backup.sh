#!/usr/bin/env bash
# The backup of a deployment (spec §15.4).
#
# The backup holds the business records, the workspaces, the audit log,
# the events, the deliveries, the receipts and the history of the
# migrations. The secrets are not in the backup: they belong to the
# secret manager of the deployment.
#
#   DATA_ADMIN_DATABASE_URL=... DATA_BACKUP_DIR=... ./scripts/backup.sh

set -euo pipefail

: "${DATA_ADMIN_DATABASE_URL:?the url of the administrator of the server is required}"
: "${DATA_BACKUP_DIR:?the directory of the backup is required}"

mkdir -p "${DATA_BACKUP_DIR}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${DATA_BACKUP_DIR}/depot-${STAMP}.dump"

echo "the backup is written to ${FILE}"
pg_dump --format=custom --no-owner --file "${FILE}" "${DATA_ADMIN_DATABASE_URL}"

# The artifacts of the deployment travel with the backup: the manifests
# and the policies are the meaning of the data.
for artifact in manifests/schema.json manifests/policies.json; do
  if [ -f "${artifact}" ]; then
    cp "${artifact}" "${DATA_BACKUP_DIR}/$(basename "${artifact}")-${STAMP}"
  fi
done

sha256sum "${FILE}" > "${FILE}.sha256"
echo "the backup is done"
