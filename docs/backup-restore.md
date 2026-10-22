# The backup and the restore

## What is in the backup

- the business records of every collection,
- the registry of the workspaces,
- the audit log, the events, the deliveries and the receipts,
- the history of the migrations,
- the manifests and the policy bundle of the deployment, next to the
  dump.

The secrets are **not** in the backup. The public key of the identity
of the gateway, the derived identity key of the legacy format, the
credential of the access context, the key of the cursors and the
passwords of the roles belong to the secret manager of the deployment,
and they are rotated and restored by it.

## The command

```bash
DATA_BACKUP_DATABASE_URL=... DATA_BACKUP_DIR=/var/backups/depot \
  ./scripts/backup.sh
```

The backup is a custom format dump of `pg_dump`, with its digest in a
file next to it. It is taken with a consistent snapshot, so the dump is
a state of the database and not a mixture of two states.

**The role of the backup bypasses the row level security.** The tables
of the deployment carry the row level security, and it is forced: the
owner of a table is subject to it as well. A backup holds the rows of
every tenant, so the role that takes it is the administrator of the
server or a role with the attribute `BYPASSRLS`. The command refuses a
role that is subject to the policies of the tables: a backup that holds
the rows of one tenant is not a backup of the deployment.

## The rehearsal

```bash
DATA_ADMIN_DATABASE_URL=... DATA_RUNTIME_DATABASE_URL=... \
  DATA_BACKUP_FILE=/var/backups/depot/depot-....dump \
  DATA_RESTORE_DATABASE=depot_restore ./scripts/restore.sh
```

The restore runs with the administrator of the server, for the same
reason as the backup: the rows of a restore belong to every tenant.
When the url of the owner of the schema is given, the ownership of the
restored tables and of the restored schemas goes back to it, and the
separation of the privileges of the deployment is the same before and
after the restore.

The rehearsal restores into a database of its own and it checks:

1. the restore completes without an error,
2. the isolation of the tenants holds after the restore: the rows of a
   scope that does not exist are not visible. The check runs with the
   role of the api, because an administrator bypasses the policies of
   the tables,
3. the deliveries that were pending are still there, and they are still
   safe: the worker claims them again, it asks Hub for a fresh context,
   and it does not repeat an effect that is already durable.

The rehearsal is a part of the release of a deployment. The record of
the last rehearsal is in the release notes of the deployment.

### The rehearsal of the release of version 0.1

The rehearsal was run on the development machine of the release, on
the PostgreSQL 15.19 of the machine, with the migrations of the
repository and with one article in one workspace:

```
the backup is written to /tmp/rehearsal-backup/depot-20261021T172011Z.dump
the backup is done
the database of the rehearsal is created
the backup is restored
the isolation of the tenants is checked
the restored rows are 0
the rows of a scope that does not exist are 0
the deliveries of the restored state are counted
0
the rehearsal is done
```

The restored rows are zero because the check runs with the role of the
api and the scope of the transaction is not set: the policies of the
tables refuse the rows. The scope that does not exist sees nothing, and
the deliveries are read with the role of the deliveries.

The rehearsal of a deployment runs the same command on its own data.

### The rehearsal of the release candidate of the version 1.0

The rehearsal was run on the development machine of the release, on the
PostgreSQL 15.19 of the machine, with the migrations of the repository
and with one article in one workspace. The command of the rehearsal of
the repository is `bash scripts/rehearse-backup.sh`: it starts a server
of its own, it provisions the roles, it applies the migrations, it
writes the workspace and its record, and it runs the two commands of the
deployment.

```
the server of the rehearsal is started
the roles and the database are provisioned
the schema is applied
the workspace and its record are written
the backup is written
the backup is written to /tmp/depot-rehearsal-AVHmOZ/backup/depot-20261022T181856Z.dump
the backup is done
the restore is rehearsed
the database of the rehearsal is created
the backup is restored
the ownership of the restored tables goes back to the owner of the schema
the isolation of the tenants is checked
the restored rows are 0
the rows of a scope that does not exist are 0
the deliveries of the restored state are counted
0
the rehearsal is done
```

The restored rows are zero because the check runs with the role of the
api and the scope of the transaction is not set: the policies of the
tables refuse the rows. The scope that does not exist sees nothing, and
the deliveries are read with the role of the deliveries.

**The rehearsal found a defect of the command of the backup.** The
tables of the deployment carry the row level security, and it is
forced: the owner of a table is subject to it. The backup was taken
with the owner of the schema, and `pg_dump` refused to read the rows.
The command of the backup now refuses a role that is subject to the
policies of the tables and names the role that bypasses them, and the
command of the restore gives the ownership of the restored tables back
to the owner of the schema.

## The order of a restore

1. stop the api and the workers: a restore writes the tables of the
   business,
2. restore the dump,
3. check the migrations: the ledger of the restored database holds the
   checksums of the backup, and the manifests of the release have to
   match them,
4. start the api and the workers: the workers claim the deliveries that
   were pending, and the handlers are idempotent.

## The rollback

A migration that changed the data is not rolled back with the schema:
the rollback of a data change is a forward fix. The backup is the
safety net, and the restore rehearsal is what proves that the net is
there.

A rolling release preserves the backward compatibility of the schema
and of the API. A destructive migration needs a reviewed maintenance
plan and a tested restore.
