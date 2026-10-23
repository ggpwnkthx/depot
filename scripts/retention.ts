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

import { readFile } from 'node:fs/promises'
import { Client } from 'pg'
import { parseManifestBundle } from '../src/domains/schema/manifest'

/** The batch size of the command. */
const BATCH = 1000

/** The retention of the audit log, in days. */
const AUDIT_DAYS = Number(process.env.DATA_AUDIT_RETENTION_DAYS ?? '90')
/** The retention of the receipts, in hours. */
const RECEIPT_HOURS = Number(process.env.DATA_RECEIPT_RETENTION_HOURS ?? '24')
/** The retention of the completed deliveries, in days. */
const EVENT_DAYS = Number(process.env.DATA_EVENT_RETENTION_DAYS ?? '7')
/** The retention of the versions of the records, in days. */
const VERSIONS_DAYS = Number(process.env.DATA_VERSIONS_RETENTION_DAYS ?? '90')

const url = process.env.DATA_MAINTENANCE_DATABASE_URL
if (!url) {
  throw new Error('DATA_MAINTENANCE_DATABASE_URL must be set: it names the maintenance role')
}

/** The actor of the retention, for the audit of the operator. */
const actor = process.env.DATA_RETENTION_ACTOR ?? 'operator'

const client = new Client({ connectionString: url })
await client.connect()

/**
 * The tables that hold the versions of the records.
 *
 * The tables are the ones that the manifest of the deployment declares:
 * the retention of the history is the work of the deployment, and the
 * command purges the tables it knows about.
 */
async function versionTables(): Promise<string[]> {
  const file = process.env.DATA_SCHEMA_BUNDLE_FILE
  if (!file) return []
  const manifest = parseManifestBundle(await readFile(file, 'utf8'))
  const tables: string[] = []
  for (const collection of manifest.collections) {
    if (collection.versions) tables.push(collection.versions.table)
  }
  return tables
}

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
  const versions: Record<string, number> = {}
  for (const table of await versionTables()) {
    versions[table] = await purge(
      table,
      `superseded_at < now() - interval '${VERSIONS_DAYS} days'`,
      []
    )
  }
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'the retention ran',
      actor,
      audit,
      receipts,
      deliveries,
      events,
      versions,
    })
  )
} finally {
  await client.end()
}
