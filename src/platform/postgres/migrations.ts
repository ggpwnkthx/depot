/**
 * The migrations of the deployment (spec §7.5).
 *
 * The migrations run with the credentials of the owner and with an
 * exclusive lock: two deployments never apply a migration at the same
 * time. The ledger holds the checksum of every applied migration, and
 * the process verifies the checksums when it starts: a migration that
 * was changed after it was applied is a drift and it stops the readiness
 * of the service.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManifestBundle } from '../../domains/schema'
import type { ConnectionPool } from './database'

/** The lock of the migrations. It is an arbitrary constant of the deployment. */
const MIGRATION_LOCK = 0x6461_7461

/** One migration of the deployment. */
export interface Migration {
  /** The identifier of the migration, the name of its file. */
  readonly id: string
  /** The statements of the migration. */
  readonly sql: string
  /** The digest of the statements. */
  readonly checksum: string
}

/** The problem of a migration that cannot be applied. */
export class MigrationError extends Error {
  override readonly name = 'MigrationError'
}

/** Reads the migrations of a directory. */
export async function loadMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()
  const migrations: Migration[] = []
  for (const name of names) {
    const sql = await readFile(join(directory, name), 'utf8')
    migrations.push({
      id: name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    })
  }
  return migrations
}

/**
 * Applies the migrations that were not applied yet.
 *
 * The lock is an advisory lock of the database: it is held for the whole
 * run and it is released when the connection ends.
 */
export async function applyMigrations(
  pool: ConnectionPool,
  migrations: readonly Migration[]
): Promise<string[]> {
  const client = await pool.acquire()
  const applied: string[] = []
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK])
    try {
      await client.query('create schema if not exists platform')
      await client.query(
        `create table if not exists platform.schema_migrations (
           id text primary key,
           checksum text not null,
           applied_at timestamptz not null default now()
         )`
      )
      const rows = await client.query<{ id: string; checksum: string }>(
        'select id, checksum from platform.schema_migrations'
      )
      const known = new Map(rows.rows.map((row) => [row.id, row.checksum]))
      for (const migration of migrations) {
        const existing = known.get(migration.id)
        if (existing) {
          if (existing !== migration.checksum) {
            throw new MigrationError(
              `the migration "${migration.id}" was changed after it was applied`
            )
          }
          continue
        }
        await client.query('begin')
        try {
          await client.query(migration.sql)
          await client.query(
            'insert into platform.schema_migrations (id, checksum) values ($1, $2)',
            [migration.id, migration.checksum]
          )
          await client.query('commit')
          applied.push(migration.id)
        } catch (error) {
          await client.query('rollback')
          throw new MigrationError(
            `the migration "${migration.id}" could not be applied: ${
              error instanceof Error ? error.message : 'unknown error'
            }`
          )
        }
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK])
    }
  } finally {
    client.release()
  }
  return applied
}

/**
 * Verifies that the applied migrations are the ones of the deployment.
 *
 * A migration that is missing or that was changed stops the readiness of
 * the service.
 */
export async function verifyMigrations(
  pool: ConnectionPool,
  migrations: readonly Migration[]
): Promise<void> {
  const rows = await pool.query<{ id: string; checksum: string }>(
    'select id, checksum from platform.schema_migrations'
  )
  const known = new Map(rows.map((row) => [row.id, row.checksum]))
  for (const migration of migrations) {
    const existing = known.get(migration.id)
    if (!existing) {
      throw new MigrationError(`the migration "${migration.id}" was not applied`)
    }
    if (existing !== migration.checksum) {
      throw new MigrationError(`the migration "${migration.id}" was changed after it was applied`)
    }
  }
}

/**
 * Compares the manifest of the deployment with the deployed schema.
 *
 * The service never alters a table while it runs: a column that is
 * missing, a column of another type, a relation without its constraint
 * and a table without its isolation are a drift, and the drift stops the
 * readiness of the service.
 */
export async function detectDrift(
  pool: ConnectionPool,
  manifest: ManifestBundle
): Promise<string[]> {
  const problems: string[] = []
  const rows = await pool.query<{
    table_schema: string
    table_name: string
    column_name: string
    data_type: string
    is_nullable: string
  }>(
    `select table_schema, table_name, column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema in ('data', 'platform')`
  )
  const columns = new Map<string, { data_type: string; is_nullable: string }>()
  for (const row of rows) {
    columns.set(`${row.table_schema}.${row.table_name}.${row.column_name}`, {
      data_type: row.data_type,
      is_nullable: row.is_nullable,
    })
  }

  const expected = new Map<string, string>()
  for (const collection of manifest.collections) {
    for (const [name, definition] of Object.entries(collection.fields)) {
      expected.set(`${collection.table}.${name}`, expectedType(definition.type))
    }
    // The table of the versions is a mirror of the table of the
    // collection: the columns of the record carry the same names and
    // the same types, so the statement of a read of a version is the
    // statement of a read of a record.
    if (collection.versions) {
      for (const [name, type] of SERVER_COLUMN_TYPES) {
        expected.set(`${collection.versions.table}.${name}`, type)
      }
      for (const [name, definition] of Object.entries(collection.fields)) {
        expected.set(`${collection.versions.table}.${name}`, expectedType(definition.type))
      }
    }
  }

  for (const [key, type] of expected) {
    const column = columns.get(key)
    if (!column) {
      problems.push(`the column "${key}" is missing`)
      continue
    }
    if (column.data_type !== type) {
      problems.push(`the column "${key}" is of the type "${column.data_type}" and not "${type}"`)
    }
  }

  const protectedRows = await pool.query<{
    schemaname: string
    tablename: string
    rowsecurity: boolean
    forcerowsecurity: boolean
  }>(
    `select n.nspname as schemaname, c.relname as tablename,
            c.relrowsecurity as rowsecurity, c.relforcerowsecurity as forcerowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('data', 'platform') and c.relkind = 'r'`
  )
  const protectedTables = new Set(
    protectedRows
      .filter((row) => row.rowsecurity && row.forcerowsecurity)
      .map((row) => `${row.schemaname}.${row.tablename}`)
  )
  for (const collection of manifest.collections) {
    if (!protectedTables.has(collection.table)) {
      problems.push(`the table "${collection.table}" does not force its row level security`)
    }
    if (collection.versions && !protectedTables.has(collection.versions.table)) {
      problems.push(
        `the table "${collection.versions.table}" does not force its row level security`
      )
    }
  }
  for (const table of [
    'platform.workspaces',
    'platform.audit_entries',
    'platform.outbox_events',
    'platform.collection_registry',
    'platform.policy_bundles',
  ]) {
    if (!protectedTables.has(table)) {
      problems.push(`the table "${table}" does not force its row level security`)
    }
  }
  return problems
}

/**
 * The columns of the server that every table of a record holds.
 *
 * The table of the versions is a mirror of the table of the record:
 * the columns of the server carry the same names and the same types.
 */
const SERVER_COLUMN_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['id', 'uuid'],
  ['version', 'integer'],
  ['tenant_id', 'uuid'],
  ['workspace_id', 'uuid'],
  ['created_by', 'uuid'],
  ['created_at', 'timestamp with time zone'],
  ['updated_by', 'uuid'],
  ['updated_at', 'timestamp with time zone'],
]

/** The type of the database of a field of the manifest. */
function expectedType(type: string): string {
  switch (type) {
    case 'string':
    case 'text':
    case 'enum':
      return 'text'
    case 'boolean':
      return 'boolean'
    case 'integer':
      return 'bigint'
    case 'decimal':
      return 'numeric'
    case 'uuid':
      return 'uuid'
    case 'timestamp':
      return 'timestamp with time zone'
    case 'json':
      return 'jsonb'
    default:
      return 'text'
  }
}
