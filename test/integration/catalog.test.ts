import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { testDatabase, type TestDatabase } from '../helpers/database'
import { PostgresCatalogStore } from '../../src/platform/postgres/catalog'
import { ConnectionPool } from '../../src/platform/postgres/database'

let database: TestDatabase
let owner: Client
let runtime: Client
let registryPool: ConnectionPool
let store: PostgresCatalogStore

const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_WORKSPACE_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

beforeAll(async () => {
  database = await testDatabase()
  await database.reset()
  await database.seed([
    { id: WORKSPACE_ID, tenantId: TENANT_ID, slug: 'acme' },
    { id: OTHER_WORKSPACE_ID, tenantId: OTHER_TENANT_ID, slug: 'other' },
  ])
  owner = new Client({ connectionString: database.ownerUrl })
  runtime = new Client({ connectionString: database.runtimeUrl })
  await owner.connect()
  await runtime.connect()
  registryPool = new ConnectionPool({
    url: database.registryUrl,
    max: 3,
    statementTimeoutMs: 3000,
    acquireTimeoutMs: 2000,
    applicationName: 'test-catalog-registry',
  })
  store = new PostgresCatalogStore(registryPool)
})

afterAll(async () => {
  await owner?.end()
  await runtime?.end()
  await registryPool?.close()
})

describe('the catalog of the workspaces', () => {
  test('the workspace and its registry are read in one read', async () => {
    await owner.query(
      `insert into platform.collection_registry
         (workspace_id, tenant_id, collection_key, table_name, schema_version, enabled)
       values ($1::uuid, $2::uuid, 'articles', 'data.articles', 'articles-v1', true)`,
      [WORKSPACE_ID, TENANT_ID]
    )
    const entry = await store.findById(WORKSPACE_ID)
    expect(entry?.workspace.id).toBe(WORKSPACE_ID)
    expect(entry?.workspace.tenantId).toBe(TENANT_ID)
    expect(entry?.workspace.status).toBe('active')
    expect(entry?.registry.collections).toHaveLength(1)
    expect(entry?.registry.collections[0]?.key).toBe('articles')
    expect(entry?.registry.collections[0]?.table).toBe('data.articles')
    expect(entry?.registry.bundle).toBeNull()
  })

  test('a workspace that does not exist is not a workspace', async () => {
    const entry = await store.findById('99999999-9999-4999-8999-999999999999')
    expect(entry).toBeNull()
  })

  test('the registry of another workspace is not read with the first one', async () => {
    await owner.query(
      `insert into platform.collection_registry
         (workspace_id, tenant_id, collection_key, table_name, schema_version, enabled)
       values ($1::uuid, $2::uuid, 'categories', 'data.categories', 'articles-v1', true)`,
      [OTHER_WORKSPACE_ID, OTHER_TENANT_ID]
    )
    const entry = await store.findById(WORKSPACE_ID)
    expect(entry?.registry.collections.map((entry) => entry.key)).toEqual(['articles'])
    const other = await store.findById(OTHER_WORKSPACE_ID)
    expect(other?.registry.collections.map((entry) => entry.key)).toEqual(['categories'])
  })

  test('the row level security of the registry refuses the rows of another workspace', async () => {
    await runtime.query('begin')
    try {
      await runtime.query(
        `select set_config('data.tenant_id', $1, true), set_config('data.workspace_id', $2, true)`,
        [TENANT_ID, WORKSPACE_ID]
      )
      const rows = await runtime.query(
        'select collection_key from platform.collection_registry order by collection_key'
      )
      expect(rows.rows.map((row) => row.collection_key)).toEqual(['articles'])
    } finally {
      await runtime.query('rollback')
    }
  })

  test('the role of the api may not write the registry', async () => {
    await runtime.query('begin')
    try {
      await runtime.query(
        `select set_config('data.tenant_id', $1, true), set_config('data.workspace_id', $2, true)`,
        [TENANT_ID, WORKSPACE_ID]
      )
      await expect(
        runtime.query(
          `insert into platform.collection_registry
             (workspace_id, tenant_id, collection_key, table_name, schema_version, enabled)
           values ($1::uuid, $2::uuid, 'categories', 'data.categories', 'articles-v1', true)`,
          [WORKSPACE_ID, TENANT_ID]
        )
      ).rejects.toThrow()
    } finally {
      await runtime.query('rollback')
    }
  })

  test('the published bundle of a workspace is read, and the last publication is the one that applies', async () => {
    await owner.query(
      `insert into platform.policy_bundles
         (workspace_id, tenant_id, version, bundle_version, body, published_by)
       values ($1::uuid, $2::uuid, 1, 'v1', $3::jsonb, 'operator')`,
      [WORKSPACE_ID, TENANT_ID, JSON.stringify({ version: 1, policies: [] })]
    )
    await owner.query(
      `insert into platform.policy_bundles
         (workspace_id, tenant_id, version, bundle_version, body, published_by)
       values ($1::uuid, $2::uuid, 2, 'v2', $3::jsonb, 'operator')`,
      [WORKSPACE_ID, TENANT_ID, JSON.stringify({ version: 1, policies: [] })]
    )
    const entry = await store.findById(WORKSPACE_ID)
    expect(entry?.registry.bundle?.version).toBe(2)
    expect(entry?.registry.bundle?.bundleVersion).toBe('v2')
    expect(JSON.parse(entry!.registry.bundle!.body)).toEqual({ version: 1, policies: [] })
  })

  test('the bundle of another workspace is not read with the first one', async () => {
    await owner.query(
      `insert into platform.policy_bundles
         (workspace_id, tenant_id, version, bundle_version, body, published_by)
       values ($1::uuid, $2::uuid, 1, 'other', $3::jsonb, 'operator')`,
      [OTHER_WORKSPACE_ID, OTHER_TENANT_ID, JSON.stringify({ version: 1, policies: [] })]
    )
    const entry = await store.findById(WORKSPACE_ID)
    expect(entry?.registry.bundle?.bundleVersion).toBe('v2')
    const other = await store.findById(OTHER_WORKSPACE_ID)
    expect(other?.registry.bundle?.bundleVersion).toBe('other')
  })

  test('the registry of a workspace is removed with the workspace', async () => {
    await owner.query('delete from platform.workspaces where id = $1::uuid', [OTHER_WORKSPACE_ID])
    const rows = await owner.query(
      'select count(*)::text as count from platform.collection_registry where workspace_id = $1::uuid',
      [OTHER_WORKSPACE_ID]
    )
    expect(rows.rows[0]!.count).toBe('0')
  })
})
