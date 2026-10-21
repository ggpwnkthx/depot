#!/usr/bin/env bun
/**
 * The measurement of the shape of the statements at scale.
 *
 * The report of `docs/capacity.md` measures the latency of the service
 * on a small table of a development machine. This command measures
 * something else: the *plan* of the statements of the service when the
 * table is large.
 *
 * The question it answers is the one of the second decision of
 * `docs/decisions.md`: the projection of a read is built by the
 * statement, so a field is added only when a policy that matched the
 * row grants it. The statement is therefore longer than the one a
 * reader would write by hand, and it computes one boolean per policy
 * for every row it reads. Whether that is affordable is not a matter of
 * taste: it is a matter of the plan of the database.
 *
 * The command:
 *
 *   bun run scripts/scale.ts
 *
 * The environment:
 *
 *   SCALE_ROWS        the number of rows of the collection (default 1000000)
 *   SCALE_PAGES       the number of pages that are read (default 20)
 *   SCALE_PAGE_SIZE   the size of a page (default 50)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { Client } from 'pg'
import { startPostgres } from './postgres'
import { loadMigrations, applyMigrations } from '../src/platform/postgres/migrations'
import { ConnectionPool } from '../src/platform/postgres/database'
import { PostgresDataStore } from '../src/platform/postgres/scoped'
import { parseManifestBundle } from '../src/domains/schema'
import { parsePolicyBundle } from '../src/domains/authorization'
import { RecordsService } from '../src/domains/records'
import type { DataStore, UnitOfWork } from '../src/domains/records/types'
import type { RequestContext } from '../src/domains/authorization'

/** The number of rows of the collection. */
const ROWS = Number(process.env.SCALE_ROWS ?? '1000000')

/** The number of pages that are read. */
const PAGES = Number(process.env.SCALE_PAGES ?? '20')

/** The size of a page. */
const PAGE_SIZE = Number(process.env.SCALE_PAGE_SIZE ?? '50')

/** The workspace of the measurement. */
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
/** The tenant of the measurement. */
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** The principal of the measurement. */
const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111'

/** The passwords of the roles of the measurement. They are fixtures. */
const PASSWORDS = {
  owner: 'scale-owner-password-0000001',
  runtime: 'scale-runtime-password-00001',
} as const

/** The statement of a read, with the plan of the database. */
interface Captured {
  readonly sql: string
  readonly params: readonly unknown[]
}

/** Prints the tree of a plan, with the numbers that matter. */
function printPlan(plan: Record<string, unknown> | undefined, depth = 0): void {
  if (!plan) return
  const node = (plan['Plan'] ?? plan) as Record<string, unknown>
  const fields = [
    'Node Type',
    'Relation Name',
    'Index Name',
    'Actual Total Time',
    'Actual Rows',
    'Workers Launched',
    'Sort Method',
    'Sort Key',
    'Shared Hit Blocks',
    'Shared Read Blocks',
    'Filter',
  ]
  const line = fields
    .filter((field) => node[field] !== undefined)
    .map((field) => `${field}=${JSON.stringify(node[field])}`)
    .join('  ')
  console.log(`${'  '.repeat(depth)}${line}`)
  for (const child of (node['Plans'] as Record<string, unknown>[] | undefined) ?? []) {
    printPlan(child, depth + 1)
  }
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'depot-scale-'))
  const server = await startPostgres({
    dataDir: join(dataDir, 'data'),
    fresh: true,
    user: 'depot',
    password: 'depot',
  })
  const socketDir = join(dataDir, 'socket')
  const adminUrl = `postgres://depot@localhost/postgres?host=${encodeURIComponent(socketDir)}&port=${server.port}`
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query("alter role depot with password 'depot'")
  await admin.query(`create role data_owner with login password '${PASSWORDS.owner}'`)
  await admin.query(`create role data_runtime with login password '${PASSWORDS.runtime}'`)
  await admin.query(`create role data_registry with login password 'scale-registry-password-0001'`)
  await admin.query(`create role data_delivery with login password 'scale-delivery-password-0001'`)
  await admin.query(
    `create role data_maintenance with login password 'scale-maintenance-password-001'`
  )
  await admin.query('create database depot_scale owner data_owner')
  await admin.end()

  const ownerUrl = `postgres://data_owner:${PASSWORDS.owner}@127.0.0.1:${server.port}/depot_scale`
  const runtimeUrl = `postgres://data_runtime:${PASSWORDS.runtime}@127.0.0.1:${server.port}/depot_scale`

  const pool = new ConnectionPool({
    url: ownerUrl,
    max: 1,
    statementTimeoutMs: 600_000,
    acquireTimeoutMs: 10_000,
    applicationName: 'data-backend-scale-migrate',
  })
  await applyMigrations(pool, await loadMigrations('./migrations'))
  await pool.close()

  // The rows of the collection. The insert is the one of a deployment
  // that has rows: the shape of the table is the one of the migration.
  const loader = new Client({ connectionString: ownerUrl })
  await loader.connect()
  await loader.query(
    `insert into platform.workspaces (id, tenant_id, slug, display_name, status)
     values ($1::uuid, $2::uuid, 'scale', 'scale', 'active')`,
    [WORKSPACE_ID, TENANT_ID]
  )
  const started = Date.now()
  await loader.query(
    `insert into data.articles
       (id, tenant_id, workspace_id, created_by, updated_by, created_at, updated_at, version, title, body, status)
     select gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $3::uuid,
            now() - (g || ' seconds')::interval, now(), 1,
            'the title of the row ' || g, 'the body of the row ' || g, 'published'
     from generate_series(1, $4) as g`,
    [TENANT_ID, WORKSPACE_ID, PRINCIPAL_ID, ROWS]
  )
  await loader.query('analyze data.articles')
  await loader.end()
  const loaded = Date.now()
  console.log(`the collection holds ${ROWS} rows; they were written in ${loaded - started} ms`)

  // The service, with a store that keeps the statements it builds.
  const manifest = parseManifestBundle(await readFile('./manifests/schema.json', 'utf8'))
  const bundle = parsePolicyBundle(await readFile('./manifests/policies.json', 'utf8'), manifest)
  const captured: Captured[] = []
  const unit: UnitOfWork = {
    query: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
      captured.push({ sql, params: params ?? [] })
      return [] as T[]
    },
    queryOne: async () => null,
    execute: async () => 0,
  }
  const store: DataStore = {
    read: async <T>(action: (u: UnitOfWork) => Promise<T>) => await action(unit),
    write: async <T>(action: (u: UnitOfWork) => Promise<T>) => await action(unit),
  }
  const service = new RecordsService({
    store,
    clock: { now: () => Date.now(), monotonic: () => Date.now() },
    cursorKey: new Uint8Array(32).fill(3),
    audit: { append: async () => undefined },
    outbox: { append: async () => undefined },
    subscribers: [],
  })
  const context: RequestContext = {
    principalId: PRINCIPAL_ID,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    routeId: 'data-api',
    permissionKeys: ['content.reader'],
    requestId: 'scale',
    source: 'shuttle',
    policyBundleVersion: bundle.bundleVersion,
    catalog: { manifest, bundle },
    authorizationDeadline: Date.now() + 60_000,
  }

  // The pages that a caller reads.
  const durations: number[] = []
  for (let index = 0; index < PAGES; index += 1) {
    const at = Date.now()
    await service.list(context, 'articles', { limit: PAGE_SIZE, includeCount: false })
    durations.push(Date.now() - at)
  }
  const statement = captured[0]
  if (!statement) throw new Error('the service did not build a statement')

  // The plan of the statement, with the role of the api and the scope
  // of the workspace: the plan of the deployment and not the plan of
  // the owner.
  const runtime = new Client({ connectionString: runtimeUrl })
  await runtime.connect()
  await runtime.query('begin')
  await runtime.query(
    `select set_config('data.tenant_id', $1, true), set_config('data.workspace_id', $2, true),
            set_config('data.principal_id', $3, true)`,
    [TENANT_ID, WORKSPACE_ID, PRINCIPAL_ID]
  )
  const explained = await runtime.query(
    `explain (analyze, buffers, format json) ${statement.sql}`,
    [...statement.params]
  )
  await runtime.query('commit')
  await runtime.end()

  const plan = explained.rows[0]?.['QUERY PLAN']?.[0] as Record<string, unknown> | undefined
  console.log('\nThe statement of the read:')
  console.log(statement.sql.replace(/\s+/g, ' ').slice(0, 600))
  console.log('\nThe plan of the database:')
  printPlan(plan)
  await writeFile('./.pg/scale-plan.json', JSON.stringify(plan, null, 2))

  const scanned = await runtime
    .query(
      `select count(*)::text as count from data.articles
       where tenant_id = $1::uuid and workspace_id = $2::uuid`,
      [TENANT_ID, WORKSPACE_ID]
    )
    .catch(() => null)
  console.log('\nThe rows of the scope:', scanned?.rows[0]?.count ?? 'unknown')

  const sorted = [...durations].sort((a, b) => a - b)
  console.log(
    `\nThe pages: ${sorted.length} pages of ${PAGE_SIZE} rows; ` +
      `p50 ${sorted[Math.floor(sorted.length / 2)]} ms, ` +
      `max ${sorted[sorted.length - 1]} ms`
  )
  console.log(
    'The durations above are the durations of the service with a store that answers nothing: ' +
      'they are the cost of the building of the statement, not the cost of the database.'
  )

  // The pagination of the service has to cover the collection with the
  // rows in the order of the database: the cursor is a position in the
  // order, and the order of the service and the order of the statement
  // have to be the same order. The check reads every page and compares
  // the rows with the rows of one statement.
  const readerPool = new ConnectionPool({
    url: runtimeUrl,
    max: 4,
    statementTimeoutMs: 60_000,
    acquireTimeoutMs: 10_000,
    applicationName: 'data-backend-scale-read',
  })
  const real = new PostgresDataStore(readerPool, {
    statementTimeoutMs: 60_000,
    transactionTimeoutMs: 60_000,
  })
  const reader = new RecordsService({
    store: {
      read: async (action, scope, options) =>
        await real.read(
          async (unit) => {
            return await action({
              query: async <T = Record<string, unknown>>(
                sql: string,
                params?: readonly unknown[]
              ) => {
                try {
                  return await unit.query<T>(sql, params)
                } catch (error) {
                  console.log('the statement that failed:')
                  console.log(sql)
                  console.log('the parameters:', JSON.stringify(params))
                  throw error
                }
              },
              queryOne: unit.queryOne,
              execute: unit.execute,
            })
          },
          scope,
          options
        ),
      write: real.write,
    },
    clock: { now: () => Date.now(), monotonic: () => Date.now() },
    cursorKey: new Uint8Array(32).fill(3),
    audit: { append: async () => undefined },
    outbox: { append: async () => undefined },
    subscribers: [],
  })
  const walked: string[] = []
  let cursor: string | undefined
  let pages = 0
  const startedAt = Date.now()
  do {
    const page = await reader.list(context, 'articles', {
      limit: PAGE_SIZE,
      includeCount: false,
      ...(cursor ? { cursor } : {}),
    })
    for (const row of page.data as { id: string }[]) walked.push(row.id)
    cursor = page.meta.nextCursor ?? undefined
    pages += 1
  } while (cursor !== undefined && pages < 20_000)
  const elapsed = Date.now() - startedAt

  const checker = new Client({ connectionString: runtimeUrl })
  await checker.connect()
  await checker.query('begin')
  await checker.query(
    `select set_config('data.tenant_id', $1, true), set_config('data.workspace_id', $2, true),
            set_config('data.principal_id', $3, true)`,
    [TENANT_ID, WORKSPACE_ID, PRINCIPAL_ID]
  )
  const expected = await checker.query(
    `select id::text as id from data.articles
     where tenant_id = $1::uuid and workspace_id = $2::uuid
     order by id asc nulls last`,
    [TENANT_ID, WORKSPACE_ID]
  )
  await checker.query('commit')
  await checker.end()
  const expectedIds = expected.rows.map((row) => String(row.id))
  // The walk is bounded by the number of the pages: it compares the rows
  // it walked with the rows of the statement, in the order of the
  // database.
  const prefix = expectedIds.slice(0, walked.length)
  const same = walked.length === prefix.length && walked.every((id, i) => id === prefix[i])
  console.log(
    `\nThe pagination: ${pages} pages, ${walked.length} rows in ${elapsed} ms; ` +
      `the collection holds ${expectedIds.length} rows`
  )
  console.log(
    same
      ? 'The pages cover the collection in the order of the database: the same rows, the same order.'
      : 'THE PAGES DO NOT COVER THE COLLECTION IN THE ORDER OF THE DATABASE.'
  )
  if (walked.length < expectedIds.length) {
    console.log(
      `  the walk stopped at the bound of the pages: ${walked.length} of ${expectedIds.length} rows were compared.`
    )
  }
  if (!same) {
    const at = walked.findIndex((id, index) => id !== prefix[index])
    console.log(`  the first difference is at the row ${at}: ${walked[at]} and ${prefix[at]}`)
    server.stop()
    await rm(dataDir, { recursive: true, force: true })
    process.exitCode = 1
    return
  }
  await readerPool.close()

  server.stop()
  await rm(dataDir, { recursive: true, force: true })
}

await main()
