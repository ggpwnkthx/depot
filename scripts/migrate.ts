#!/usr/bin/env bun
/**
 * The migrations of the deployment (spec §7.5).
 *
 * The command runs with the credentials of the owner of the schema and
 * with an exclusive lock. It is an operator command: it is not an HTTP
 * route and it does not bypass Hub.
 */

import { ConnectionPool } from '../src/platform/postgres/database'
import { applyMigrations, loadMigrations } from '../src/platform/postgres/migrations'

const url = process.env.DATA_OWNER_DATABASE_URL ?? process.env.DATA_DATABASE_URL
if (!url) {
  throw new Error('DATA_OWNER_DATABASE_URL must be set: it names the owner of the schema')
}

const directory = process.env.DATA_MIGRATIONS_DIR ?? './migrations'
const migrations = await loadMigrations(directory)
const pool = new ConnectionPool({
  url,
  max: 1,
  statementTimeoutMs: 120_000,
  acquireTimeoutMs: 10_000,
  applicationName: 'data-backend-migrate',
})
try {
  const applied = await applyMigrations(pool, migrations)
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'the migrations were applied',
      applied,
      total: migrations.length,
    })
  )
} finally {
  await pool.close()
}
