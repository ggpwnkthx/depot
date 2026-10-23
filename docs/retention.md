# The retention of the history

| Data | The default | The rule |
| --- | --- | --- |
| The business records | — | The application owns them. There is no automatic purge. |
| The images of the versions of the records | 90 days | `DATA_VERSIONS_RETENTION_DAYS`. The images that are too old are removed in bounded batches. The tables are the ones that the manifest declares. |
| The audit log | 90 days | `DATA_AUDIT_RETENTION_DAYS`. The entries are removed in bounded batches. |
| The receipts of the creations | 24 hours | `DATA_RECEIPT_RETENTION_HOURS`. A key that is reused after that is a new operation. |
| The completed events and their deliveries | 7 days | `DATA_EVENT_RETENTION_DAYS`. The deliveries of the subscribers that are not finished are never removed. |
| The pending and the failed deliveries | — | They are never removed automatically. An operator resolves them. |

## The command

```bash
DATA_MAINTENANCE_DATABASE_URL=... DATA_RETENTION_ACTOR=operator \
  bun run scripts/retention.ts
```

The command runs with the maintenance role, in batches of a thousand
rows, and it is idempotent. It never touches a business record: there
is no generic collection endpoint that purges the history of the
platform, and the audit log may not be edited by the api.

The images of the versions of the records are purged with the same
command, and the tables are the ones that the manifest of the
deployment declares: the command reads the manifest with
`DATA_SCHEMA_BUNDLE_FILE`, and it purges the images that the
retention of the versions has reached. The current version of a record
is never purged: it is the row of the collection itself, and it is not
an image.

The removals of the completed deliveries are followed by the removals of
the events that have no delivery left. An event with a pending or a
failed delivery stays.

## The attribution

The command takes the name of the operator in `DATA_RETENTION_ACTOR`
and writes it in the log of the run. The audit log of the mutations of
the business is not touched by the retention: the retention of the
audit log is the removal of the entries themselves.

## The backlog

The capacity of the outbox is bounded: the completed metadata is kept
for seven days, so a backlog that lasts longer than that is a
deployment that needs more workers or a subscriber that has to be
fixed. The backlog and the age of the oldest delivery are the metrics
`data_outbox_backlog` and `data_outbox_oldest_age_seconds`.

A capacity limit refuses the new work before a transaction commits an
event that cannot be kept. The limit of the backlog of a deployment is
the operator's decision: it is a multiple of the number of the events
of a day of the traffic.

## The deliveries of a failed subscriber

A delivery that failed is not removed by the retention. The operator
resolves it, and the requeue is an explicit command with an
attribution:

```bash
DATA_DELIVERY_DATABASE_URL=... bun run scripts/delivery.ts list
DATA_DELIVERY_DATABASE_URL=... bun run scripts/delivery.ts requeue \
  --event <uuid> --subscriber <id> --actor <name>
```

The requeue does not bypass the authorization of the business: the
handler of the subscriber asks Hub again before it does anything.

## The removal of a workspace

Moving a workspace between tenants is not supported. The removal of a
workspace is an explicit procedure:

1. disable the workspace (`bun run scripts/workspace.ts disable --id <uuid>`): the
   api answers `404` for it, and no request reaches its data,
2. stop the deliveries of the workspace and resolve the pending ones,
3. satisfy the retention and the export requirements of the deployment,
4. remove the rows in bounded operations, with the owner of the schema.
