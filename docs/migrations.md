# The migrations and the drift

## The commands

```bash
# The roles and the database. Once per deployment, with an administrator.
DATA_ADMIN_DATABASE_URL=... bun run scripts/provision.ts

# The schema. With the owner of the schema.
DATA_OWNER_DATABASE_URL=... bun run migrate
```

The command of the migrations takes an exclusive advisory lock: two
deployments never apply a migration at the same time. The ledger of the
migrations holds the identifier and the checksum of every applied
migration.

The directory of the migrations is `./migrations`, and
`DATA_MIGRATIONS_DIR` changes it.

## The order of the migrations

| Migration | What it holds |
| --- | --- |
| `0002_platform.sql` | The schema of the backend: the ledger, the registry of the workspaces, the audit log, the events, the deliveries and the receipts. |
| `0003_collections.sql` | The collections of the example deployment: the categories, the articles and the statistics of the articles. |
| `0004_isolation.sql` | The row level security, the composite relations and the privileges of the roles. |
| `0005_operator_policies.sql` | The policies of the owner of the schema and of the maintenance role. |
| `0006_catalog.sql` | The catalog of the workspaces: the registry of the collections and the history of the published bundles. |
| `0007_search.sql` | The index of the text search of the collections. |
| `0008_record_versions.sql` | The history of the versions of the records: the table of the images of the example deployment, its isolation and its privileges. |

A migration that was applied is never changed: the checksum of the file
is compared with the checksum of the ledger, and a difference is a
drift that stops the readiness of the service. A change of a migration
is a new migration.

## The drift

The process compares the manifest of the deployment with the deployed
schema when it starts and when it answers its readiness probe:

- a column of the manifest that is missing,
- a column of another type,
- a table of a collection that does not force its row level security,
- a table of the backend that does not force it.

The service never creates a table and never alters one while it runs. A
drift is stopped by a migration and by a new release of the manifests.

## The bundles

The manifests and the policies are deployment artifacts. They are
immutable per generation of the process, and their version is the
digest of their content: two bundles with the same content have the
same version, and a change of the content changes the version.

A change of the bundles is a release: the new bundles are read by the
new replicas, and the old replicas keep the old ones. A schema change
that is not backward compatible needs the old replicas to be drained
first.

## The roles

| Role | What it may |
| --- | --- |
| `data_owner` | Own the schemas and the tables, apply the migrations, write the registry of the workspaces, run the backup and the restore. |
| `data_runtime` | Read and write the business data of the scope of its transaction, append the audit log, write the events and the receipts. It may not alter the schema, it may not read the deliveries and it may not change the history. |
| `data_registry` | Select `id`, `tenant_id` and `status` of the registry. It may not read anything else. |
| `data_delivery` | Claim and finish the deliveries of every workspace. It may not read a business record. |
| `data_maintenance` | Delete the history that the retention has reached. It may not write a business record. |

The api never uses the owner, the registry reader, the delivery role or
the maintenance role. The credentials of the operator commands are not
in the environment of the api.

The roles are created by `scripts/provision.ts`, which takes the
passwords from the environment and never prints them.
