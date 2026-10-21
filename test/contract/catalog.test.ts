import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import {
  createHarness,
  PRINCIPAL_ID,
  TENANT_ID,
  WORKSPACE_ID,
  type Harness,
} from '../helpers/harness'

let harness: Harness
let owner: Client

beforeAll(async () => {
  harness = await createHarness()
  harness.hub.grants.set(PRINCIPAL_ID, [
    {
      tenantId: TENANT_ID,
      permissionKeys: ['content.reader', 'content.editor', 'data.audit.read'],
    },
  ])
  owner = new Client({ connectionString: harness.database.ownerUrl })
  await owner.connect()
})

afterAll(async () => {
  await owner?.end()
  await harness?.stop()
})

/** The body of a response, as json. */
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

describe('the catalog of the workspace', () => {
  test('a workspace that registered nothing serves every collection of the deployment', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/schema`)
    expect(response.status).toBe(200)
    const body = await json(response)
    // The metadata is filtered by the permissions of the caller: the
    // projections are not part of it, the principal does not hold the
    // permission that reads them.
    expect(body.data.collections.map((entry: any) => entry.key).sort()).toEqual([
      'articles',
      'categories',
    ])
  })

  test('a workspace that registered a collection serves only that one', async () => {
    await owner.query(
      `insert into platform.collection_registry
         (workspace_id, tenant_id, collection_key, table_name, schema_version, enabled)
       values ($1::uuid, $2::uuid, 'articles', 'data.articles', 'articles-v1', true)`,
      [WORKSPACE_ID, TENANT_ID]
    )
    const schema = await harness.request(`/ws/${WORKSPACE_ID}/v1/schema`)
    expect(schema.status).toBe(200)
    const body = await json(schema)
    expect(body.data.collections.map((entry: any) => entry.key)).toEqual(['articles'])

    // The collection that the workspace does not serve is not a
    // collection of the service: the answer is the answer of a
    // collection that does not exist.
    const categories = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/categories`)
    expect(categories.status).toBe(404)
    const body404 = await json(categories)
    expect(body404.error.code).toBe('NOT_FOUND')
  })

  test('the metadata of a collection that the workspace does not serve is absent', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/schema/categories`)
    expect(response.status).toBe(404)
  })

  test('the bundle a workspace published applies to the requests that follow', async () => {
    // The bundle of the deployment is read by the reader; the bundle
    // below refuses the read of the articles to everybody.
    await owner.query(
      `insert into platform.policy_bundles
         (workspace_id, tenant_id, version, bundle_version, body, published_by)
       values ($1::uuid, $2::uuid, 1, 'published-v1', $3::jsonb, 'operator')`,
      [
        WORKSPACE_ID,
        TENANT_ID,
        JSON.stringify({
          version: 1,
          policies: [
            {
              id: 'create-articles',
              permission: 'content.editor',
              collection: 'articles',
              action: 'create',
              where: {},
              check: {},
              fields: ['title'],
            },
          ],
        }),
      ]
    )
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    expect(response.status).toBe(403)
    const body = await json(response)
    expect(body.error.code).toBe('FORBIDDEN')
  })

  test('a bundle that was published is refused when it cannot be used', async () => {
    await owner.query('delete from platform.policy_bundles where workspace_id = $1::uuid', [
      WORKSPACE_ID,
    ])
    await owner.query(
      `insert into platform.policy_bundles
         (workspace_id, tenant_id, version, bundle_version, body, published_by)
       values ($1::uuid, $2::uuid, 1, 'broken', $3::jsonb, 'operator')`,
      [WORKSPACE_ID, TENANT_ID, JSON.stringify({ version: 1, policies: [{ id: 'x' }] })]
    )
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    // The service fails closed: a bundle that cannot be used never
    // serves a partial answer.
    expect(response.status).toBe(500)
    const body = await json(response)
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })
})
