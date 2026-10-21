import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { testDatabase, type TestDatabase } from '../helpers/database'
import { RecordsService, type DataStore, type UnitOfWork } from '../../src/domains/records'
import { parseManifestBundle } from '../../src/domains/schema'
import { parsePolicyBundle } from '../../src/domains/authorization/policies'
import { PostgresAuditSink, PostgresOutbox } from '../../src/platform/postgres/adapters'
import { ConnectionPool } from '../../src/platform/postgres/database'
import { PostgresDataStore } from '../../src/platform/postgres/scoped'
import { systemClock } from '../../src/protocol/clock'
import type { RequestContext } from '../../src/domains/authorization'

let database: TestDatabase
let owner: Client
let pool: ConnectionPool

beforeAll(async () => {
  database = await testDatabase()
  await database.reset()
  await database.seed([
    {
      id: '22222222-2222-4222-8222-222222222222',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      slug: 'acme',
    },
  ])
  owner = new Client({ connectionString: database.ownerUrl })
  await owner.connect()
  pool = new ConnectionPool({
    url: database.runtimeUrl,
    max: 5,
    statementTimeoutMs: 3000,
    acquireTimeoutMs: 2000,
    applicationName: 'test-transactions',
  })
})

afterAll(async () => {
  await owner?.end()
  await pool?.close()
})

/** The manifest of the deployment. */
const manifest = parseManifestBundle(await Bun.file('manifests/schema.json').text())
/** The bundle of the deployment. */
const bundle = parsePolicyBundle(await Bun.file('manifests/policies.json').text(), manifest)

const context: RequestContext = {
  principalId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  routeId: 'data-api',
  permissionKeys: ['content.reader', 'content.editor'],
  requestId: 'request-1',
  source: 'shuttle',
  policyBundleVersion: 'test',
  authorizationDeadline: Number.MAX_SAFE_INTEGER,
  // The catalog of the workspace: the manifest and the bundle of the
  // deployment.
  catalog: { manifest, bundle },
}

/** A store that fails on the statements that match a pattern. */
function failingStore(inner: DataStore, pattern: RegExp): DataStore {
  const wrap = (unit: UnitOfWork): UnitOfWork => ({
    query: async <T>(sql: string, params: readonly unknown[] = []) => {
      if (pattern.test(sql)) throw new Error('the injected failure')
      return await unit.query<T>(sql, params)
    },
    queryOne: async <T>(sql: string, params: readonly unknown[] = []) => {
      if (pattern.test(sql)) throw new Error('the injected failure')
      return await unit.queryOne<T>(sql, params)
    },
    execute: async (sql: string, params: readonly unknown[] = []) => {
      if (pattern.test(sql)) throw new Error('the injected failure')
      return await unit.execute(sql, params)
    },
  })
  return {
    read: (action, scope, options) => inner.read((unit) => action(wrap(unit)), scope, options),
    write: (action, scope, options) => inner.write((unit) => action(wrap(unit)), scope, options),
  }
}

/** The state of the tables of a workspace. */
async function state(): Promise<{
  articles: number
  receipts: number
  audit: number
  events: number
  deliveries: number
}> {
  const articles = await owner.query(
    `select count(*)::text as count from data.articles where workspace_id = $1::uuid`,
    [context.workspaceId]
  )
  const receipts = await owner.query(
    'select count(*)::text as count from platform.idempotency_receipts'
  )
  const audit = await owner.query('select count(*)::text as count from platform.audit_entries')
  const events = await owner.query('select count(*)::text as count from platform.outbox_events')
  const deliveries = await owner.query(
    'select count(*)::text as count from platform.outbox_deliveries'
  )
  return {
    articles: Number(articles.rows[0].count),
    receipts: Number(receipts.rows[0].count),
    audit: Number(audit.rows[0].count),
    events: Number(events.rows[0].count),
    deliveries: Number(deliveries.rows[0].count),
  }
}

describe('the atomicity of a mutation', () => {
  test('a creation commits the record, the receipt, the audit and the event', async () => {
    const store = new PostgresDataStore(pool, {
      statementTimeoutMs: 3000,
      transactionTimeoutMs: 5000,
    })
    const records = new RecordsService({
      store,
      clock: systemClock,
      cursorKey: new Uint8Array(Buffer.from('cursor-key-of-the-tests-000000000000')),
      audit: new PostgresAuditSink(),
      outbox: new PostgresOutbox(),
      subscribers: [
        {
          id: 'article-projection',
          filter: { collections: ['articles'], types: ['record.created'] },
        },
      ],
    })
    const before = await state()
    const result = await records.create(context, 'articles', {
      body: { title: 'Atomic' },
      idempotencyKey: 'atomic-1',
    })
    expect(result.receipt).toBeTruthy()
    const after = await state()
    expect(after.articles).toBe(before.articles + 1)
    expect(after.receipts).toBe(before.receipts + 1)
    expect(after.audit).toBe(before.audit + 1)
    expect(after.events).toBe(before.events + 1)
    expect(after.deliveries).toBe(before.deliveries + 1)
  })

  test('a failure of the audit leaves nothing behind', async () => {
    const inner = new PostgresDataStore(pool, {
      statementTimeoutMs: 3000,
      transactionTimeoutMs: 5000,
    })
    const records = new RecordsService({
      store: inner,
      clock: systemClock,
      cursorKey: new Uint8Array(Buffer.from('cursor-key-of-the-tests-000000000000')),
      audit: {
        append: async () => {
          throw new Error('the injected failure of the audit')
        },
      },
      outbox: new PostgresOutbox(),
      subscribers: [],
    })
    const before = await state()
    await expect(
      records.create(context, 'articles', { body: { title: 'Broken' }, idempotencyKey: 'broken-1' })
    ).rejects.toThrow()
    const after = await state()
    expect(after).toEqual(before)
  })

  test('a failure of the event leaves nothing behind', async () => {
    const inner = new PostgresDataStore(pool, {
      statementTimeoutMs: 3000,
      transactionTimeoutMs: 5000,
    })
    const records = new RecordsService({
      store: inner,
      clock: systemClock,
      cursorKey: new Uint8Array(Buffer.from('cursor-key-of-the-tests-000000000000')),
      audit: new PostgresAuditSink(),
      outbox: {
        append: async () => {
          throw new Error('the injected failure of the outbox')
        },
      },
      subscribers: [],
    })
    const before = await state()
    await expect(
      records.create(context, 'articles', { body: { title: 'Broken' }, idempotencyKey: 'broken-2' })
    ).rejects.toThrow()
    const after = await state()
    expect(after).toEqual(before)
  })

  test('a failure of the receipt leaves nothing behind', async () => {
    const inner = new PostgresDataStore(pool, {
      statementTimeoutMs: 3000,
      transactionTimeoutMs: 5000,
    })
    const records = new RecordsService({
      store: failingStore(inner, /idempotency_receipts/),
      clock: systemClock,
      cursorKey: new Uint8Array(Buffer.from('cursor-key-of-the-tests-000000000000')),
      audit: new PostgresAuditSink(),
      outbox: new PostgresOutbox(),
      subscribers: [],
    })
    const before = await state()
    await expect(
      records.create(context, 'articles', { body: { title: 'Broken' }, idempotencyKey: 'broken-3' })
    ).rejects.toThrow()
    const after = await state()
    expect(after).toEqual(before)
  })

  test('a failure of the business insert leaves nothing behind', async () => {
    const inner = new PostgresDataStore(pool, {
      statementTimeoutMs: 3000,
      transactionTimeoutMs: 5000,
    })
    const records = new RecordsService({
      store: failingStore(inner, /insert into data\.articles/),
      clock: systemClock,
      cursorKey: new Uint8Array(Buffer.from('cursor-key-of-the-tests-000000000000')),
      audit: new PostgresAuditSink(),
      outbox: new PostgresOutbox(),
      subscribers: [],
    })
    const before = await state()
    await expect(
      records.create(context, 'articles', { body: { title: 'Broken' }, idempotencyKey: 'broken-4' })
    ).rejects.toThrow()
    const after = await state()
    expect(after).toEqual(before)
  })
})
