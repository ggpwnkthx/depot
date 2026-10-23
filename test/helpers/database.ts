/**
 * The database of the tests.
 *
 * The tests run against a real PostgreSQL server: the isolation, the
 * locking and the claims of the workers are the behaviour of a server
 * and not of an embedded engine. The server is started once per test
 * process, the migrations are applied to it and the roles of the
 * separation are provisioned.
 */

import { join } from 'node:path'
import { Client } from 'pg'
import { startPostgres, type StartedPostgres } from '../../scripts/postgres'
import { ConnectionPool } from '../../src/platform/postgres/database'
import { applyMigrations, loadMigrations } from '../../src/platform/postgres/migrations'

/** The passwords of the roles of the tests. They are fixtures. */
const PASSWORDS = {
  owner: 'test-owner-password-000001',
  runtime: 'test-runtime-password-00001',
  registry: 'test-registry-password-0001',
  delivery: 'test-delivery-password-0001',
  maintenance: 'test-maintenance-password-001',
} as const

/** The database of the tests. */
export interface TestDatabase {
  /** The url of the owner of the schema. */
  readonly ownerUrl: string
  /** The url of the role of the api. */
  readonly runtimeUrl: string
  /** The url of the narrow reader of the registry. */
  readonly registryUrl: string
  /** The url of the role of the deliveries. */
  readonly deliveryUrl: string
  /** The url of the role of the retention. */
  readonly maintenanceUrl: string
  /** The server of the tests. */
  readonly server: StartedPostgres
  /** Empties the tables of the business data. */
  reset: () => Promise<void>
  /** Writes the workspaces of the fixtures. */
  seed: (
    workspaces: readonly { id: string; tenantId: string; slug: string; name?: string }[]
  ) => Promise<void>
  /** Stops the server. */
  stop: () => void
}

let instance: TestDatabase | null = null
let starting: Promise<TestDatabase> | null = null

/** The database of the tests, started once per process. */
export async function testDatabase(): Promise<TestDatabase> {
  if (instance) return instance
  if (!starting) {
    starting = build()
  }
  instance = await starting
  return instance
}

/** Builds the database of the tests. */
async function build(): Promise<TestDatabase> {
  const server = await startPostgres({
    dataDir: '.pg/test-data',
    fresh: true,
    user: 'depot',
    password: 'depot',
  })
  // The administration goes through the socket of the server: the
  // password of the cluster is set with it.
  const socketDir = join(server.dataDir, '..', 'socket')
  const adminUrl = `postgres://depot@localhost/postgres?host=${encodeURIComponent(socketDir)}&port=${server.port}`
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query("alter role depot with password 'depot'")

  const roles = ['data_owner', 'data_runtime', 'data_registry', 'data_delivery', 'data_maintenance']
  for (const role of roles) {
    const statement = await admin.query<{ statement: string }>(
      `select format('create role %I with login password %L', $1::text, $2::text) as statement`,
      [role, PASSWORDS[role.replace('data_', '') as keyof typeof PASSWORDS]]
    )
    const existing = await admin.query('select 1 from pg_roles where rolname = $1', [role])
    if (existing.rowCount && existing.rowCount > 0) {
      const alter = await admin.query<{ statement: string }>(
        `select format('alter role %I with login password %L', $1::text, $2::text) as statement`,
        [role, PASSWORDS[role.replace('data_', '') as keyof typeof PASSWORDS]]
      )
      await admin.query(alter.rows[0]!.statement)
      continue
    }
    await admin.query(statement.rows[0]!.statement)
  }
  await admin.query('create database depot_test owner data_owner')
  await admin.end()

  const ownerUrl = `postgres://data_owner:${PASSWORDS.owner}@127.0.0.1:${server.port}/depot_test`
  const runtimeUrl = `postgres://data_runtime:${PASSWORDS.runtime}@127.0.0.1:${server.port}/depot_test`
  const registryUrl = `postgres://data_registry:${PASSWORDS.registry}@127.0.0.1:${server.port}/depot_test`
  const deliveryUrl = `postgres://data_delivery:${PASSWORDS.delivery}@127.0.0.1:${server.port}/depot_test`
  const maintenanceUrl = `postgres://data_maintenance:${PASSWORDS.maintenance}@127.0.0.1:${server.port}/depot_test`

  // The migrations run with the owner of the schema.
  const pool = new ConnectionPool({
    url: ownerUrl,
    max: 1,
    statementTimeoutMs: 60_000,
    acquireTimeoutMs: 10_000,
    applicationName: 'data-backend-test-migrate',
  })
  const migrations = await loadMigrations('./migrations')
  await applyMigrations(pool, migrations)
  await pool.close()

  const reset = async (): Promise<void> => {
    const client = new Client({ connectionString: ownerUrl })
    await client.connect()
    try {
      await client.query(
        `truncate data.articles, data.categories, data.article_stats, data.article_versions,
                platform.audit_entries, platform.outbox_deliveries, platform.outbox_events,
                platform.idempotency_receipts restart identity cascade`
      )
      await client.query('delete from platform.workspaces')
      await client.query('delete from platform.policy_bundles')
      await client.query('delete from platform.collection_registry')
    } finally {
      await client.end()
    }
  }

  const seed = async (
    workspaces: readonly { id: string; tenantId: string; slug: string; name?: string }[]
  ): Promise<void> => {
    const client = new Client({ connectionString: ownerUrl })
    await client.connect()
    try {
      for (const workspace of workspaces) {
        await client.query(
          `insert into platform.workspaces (id, tenant_id, slug, display_name, status)
           values ($1::uuid, $2::uuid, $3, $4, 'active')
           on conflict (id) do nothing`,
          [workspace.id, workspace.tenantId, workspace.slug, workspace.name ?? workspace.slug]
        )
      }
    } finally {
      await client.end()
    }
  }

  return {
    ownerUrl,
    runtimeUrl,
    registryUrl,
    deliveryUrl,
    maintenanceUrl,
    server,
    reset,
    seed,
    stop: () => server.stop(),
  }
}
