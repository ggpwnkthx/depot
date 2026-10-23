import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { testDatabase, type TestDatabase } from '../helpers/database'
import { RecordsService } from '../../src/domains/records'
import { buildUpdateGuard, buildUpdateStatement } from '../../src/domains/records/write-guard'
import { Parameters, catalogueFor } from '../../src/domains/records/sql'
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
    applicationName: 'test-versions',
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
  catalog: { manifest, bundle },
}

/** The service of the records, on the real database. */
function service(): RecordsService {
  const store = new PostgresDataStore(pool, {
    statementTimeoutMs: 3000,
    transactionTimeoutMs: 5000,
  })
  return new RecordsService({
    store,
    clock: systemClock,
    cursorKey: new Uint8Array(Buffer.from('cursor-key-of-the-tests-000000000000')),
    audit: new PostgresAuditSink(),
    outbox: new PostgresOutbox(),
    subscribers: [],
  })
}

/** The images of the versions of the records of the workspace. */
async function images(): Promise<
  {
    id: string
    version: number
    title: string
    operation: string
    changed_fields: string[]
    restored_from: number | null
  }[]
> {
  const answer = await owner.query(
    `select id::text as id, version, title, operation, changed_fields, restored_from
       from data.article_versions
      where workspace_id = $1::uuid
      order by id, version`,
    [context.workspaceId]
  )
  return answer.rows as never
}

describe('the history of the versions of the records', () => {
  test('a creation writes no image: the record is its current version', async () => {
    const records = service()
    const created = await records.create(context, 'articles', {
      body: { title: 'The first title' },
      idempotencyKey: 'history-create',
    })
    expect(created.receipt).toBeTruthy()
    expect(await images()).toEqual([])
  })

  test('a change writes the image of the version it supersedes', async () => {
    const records = service()
    const created = await records.create(context, 'articles', {
      body: { title: 'The title before the change' },
      idempotencyKey: 'history-update',
    })
    const id = created.receipt!.id
    const read = await records.get(context, 'articles', id)
    await records.update(context, 'articles', {
      id,
      body: { title: 'The title after the change' },
      expectedEtag: read.etag,
    })

    const found = await images()
    expect(found).toHaveLength(1)
    expect(found[0]?.id).toBe(id)
    expect(found[0]?.version).toBe(1)
    expect(found[0]?.title).toBe('The title before the change')
    expect(found[0]?.operation).toBe('update')
    expect(found[0]?.changed_fields).toEqual(['title'])
    expect(found[0]?.restored_from).toBeNull()
  })

  test('a deletion writes the tombstone of the record', async () => {
    const records = service()
    const created = await records.create(context, 'articles', {
      body: { title: 'The title of the deleted record' },
      idempotencyKey: 'history-delete',
    })
    const id = created.receipt!.id
    const read = await records.get(context, 'articles', id)
    await records.remove(context, 'articles', { id, expectedEtag: read.etag })

    const found = await images()
    const tombstone = found.find((entry) => entry.id === id)
    expect(tombstone).toBeTruthy()
    expect(tombstone?.version).toBe(1)
    expect(tombstone?.operation).toBe('delete')
    expect(tombstone?.title).toBe('The title of the deleted record')
  })

  test('a rollback writes the version it restored', async () => {
    const records = service()
    const created = await records.create(context, 'articles', {
      body: { title: 'The title of the rolled back record' },
      idempotencyKey: 'history-rollback',
    })
    const id = created.receipt!.id
    const first = await records.get(context, 'articles', id)
    await records.update(context, 'articles', {
      id,
      body: { title: 'The title of the change' },
      expectedEtag: first.etag,
    })
    const second = await records.get(context, 'articles', id)
    await records.rollback(context, 'articles', {
      id,
      version: 1,
      expectedEtag: second.etag,
    })

    const found = await images()
    const record = found.filter((entry) => entry.id === id)
    expect(record).toHaveLength(2)
    // The version that the rollback superseded says what it restored.
    expect(record[1]?.restored_from).toBe(1)
  })

  test('a write that the guard refuses writes no image', async () => {
    const records = service()
    const created = await records.create(context, 'articles', {
      body: { title: 'The title of the refused record' },
      idempotencyKey: 'history-refused',
    })
    const id = created.receipt!.id
    const read = await records.get(context, 'articles', id)

    // The other principal may write the collection, and the policy of
    // the update only covers the records it created: the guard of the
    // write refuses the row, and the image of the version is not
    // written.
    const other: RequestContext = {
      ...context,
      principalId: '55555555-5555-4555-8555-555555555555',
    }
    await expect(
      records.update(other, 'articles', {
        id,
        body: { title: 'The title of the refused change' },
        expectedEtag: read.etag,
      })
    ).rejects.toThrow()

    const found = await images()
    expect(found.filter((entry) => entry.id === id)).toEqual([])
  })

  test('the statement of the change writes no image when it refuses the write', async () => {
    // The statement is built by hand here, and not by the service: the
    // refusal of the guard of the database is the only way to reach
    // the branch where the change does not happen. The image of the
    // version is written by the statement of the change, and the
    // statement writes no image when it refuses the change.
    const records = service()
    const created = await records.create(context, 'articles', {
      body: { title: 'The title of the refused statement' },
      idempotencyKey: 'history-refused-statement',
    })
    const id = created.receipt!.id
    const collection = manifest.collections.find((entry) => entry.key === 'articles')!
    const catalogue = catalogueFor(collection)
    const parameters = new Parameters()
    const scopeId = parameters.add(id, 'uuid')
    const scopeTenant = parameters.add(context.tenantId, 'uuid')
    const scopeWorkspace = parameters.add(context.workspaceId, 'uuid')
    const scopeClause = `t."id" = ${scopeId} and t."tenant_id" = ${scopeTenant} and t."workspace_id" = ${scopeWorkspace}`
    const now = new Date().toISOString()
    const guard = buildUpdateGuard({
      collection,
      catalogue,
      policies: [
        {
          id: 'update-strict',
          permission: 'content.editor',
          collection: 'articles',
          action: 'update',
          where: { kind: 'all' },
          // The check refuses the change: the row after the change
          // holds a published article, and the policy does not allow it.
          check: { kind: 'cmp', field: 'status', operator: '_neq', value: 'published' },
          fields: ['status'],
        },
      ],
      substitutions: {
        principalId: context.principalId,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
      },
      parameters,
      written: { status: 'published' },
      principalId: context.principalId,
      now,
      scopeClause,
      history: {
        table: 'data.article_versions',
        changedFields: ['status'],
        principalId: context.principalId,
        now,
      },
    })
    const assignments = [`"status" = ${guard.placeholders.status}`]
    assignments.push(`"updated_by" = ${guard.placeholders.updated_by}`)
    assignments.push(`"updated_at" = ${guard.placeholders.updated_at}`)
    assignments.push('"version" = "version" + 1')
    const answer = await owner.query(
      buildUpdateStatement({
        guard,
        collection,
        assignments,
        condition: `"id" = ${scopeId}
     and "tenant_id" = ${scopeTenant}
     and "workspace_id" = ${scopeWorkspace}
     and exists (select 1 from ${guard.sources} where (${guard.guard}))`,
      }),
      parameters.values
    )
    // The guard of the database refused the change, and the statement
    // wrote no row.
    expect(answer.rowCount).toBe(0)
    const found = await images()
    expect(found.filter((entry) => entry.id === id)).toEqual([])
  })
})
