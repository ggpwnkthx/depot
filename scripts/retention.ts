#!/usr/bin/env bun
/**
 * The retention of the history (spec §15.4).
 *
 * The command runs under the maintenance role, in bounded batches, and
 * it never touches the business records: the retention of the data is
 * the responsibility of the application that owns it.
 *
 * The command is idempotent: it may be run at any time and it may be
 * run twice.
 */

import { Client } from 'pg'

/** The batch size of the command. */
const BATCH = 1000

/** The retention of the audit log, in days. */
const AUDIT_DAYS = Number(process.env.DATA_AUDIT_RETENTION_DAYS ?? '90')
/** The retention of the receipts, in hours. */
const RECEIPT_HOURS = Number(process.env.DATA_RECEIPT_RETENTION_HOURS ?? '24')
/** The retention of the completed deliveries, in days. */
const EVENT_DAYS = Number(process.env.DATA_EVENT_RETENTION_DAYS ?? '7')

const url = process.env.DATA_MAINTENANCE_DATABASE_URL
if (!url) {
  throw new Error('DATA_MAINTENANCE_DATABASE_URL must be set: it names the maintenance role')
}

/** The actor of the retention, for the audit of the operator. */
const actor = process.env.DATA_RETENTION_ACTOR ?? 'operator'

const client = new Client({ connectionString: url })
await client.connect()

/** Deletes a table in bounded batches and returns the number of the rows. */
async function purge(table: string, where: string, parameters: unknown[]): Promise<number> {
  let total = 0
  for (;;) {
    const result = await client.query(
      `delete from ${table} where ctid in (
         select ctid from ${table} where ${where} limit ${BATCH}
       )`,
      parameters
    )
    total += result.rowCount ?? 0
    if ((result.rowCount ?? 0) < BATCH) break
  }
  return total
}

try {
  const audit = await purge(
    'platform.audit_entries',
    `occurred_at < now() - interval '${AUDIT_DAYS} days'`,
    []
  )
  const receipts = await purge(
    'platform.idempotency_receipts',
    `expires_at < now() - interval '${RECEIPT_HOURS} hours'`,
    []
  )
  const deliveries = await purge(
    'platform.outbox_deliveries',
    `state = 'acked' and updated_at < now() - interval '${EVENT_DAYS} days'`,
    []
  )
  const events = await purge(
    'platform.outbox_events',
    `not exists (select 1 from platform.outbox_deliveries d where d.event_id = platform.outbox_events.id)
       and occurred_at < now() - interval '${EVENT_DAYS} days'`,
    []
  )
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'the retention ran',
      actor,
      audit,
      receipts,
      deliveries,
      events,
    })
  )
} finally {
  await client.end()
}
