import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import {
  createHarness,
  PRINCIPAL_ID,
  TENANT_ID,
  WORKSPACE_ID,
  type Harness,
} from '../helpers/harness'
import { testDatabase, type TestDatabase } from '../helpers/database'

let harness: Harness
let database: TestDatabase

beforeAll(async () => {
  database = await testDatabase()
  harness = await createHarness()
  harness.hub.grants.set(PRINCIPAL_ID, [
    {
      tenantId: TENANT_ID,
      permissionKeys: ['content.reader', 'content.editor'],
    },
  ])
})

afterAll(async () => {
  await harness?.stop()
  await database?.stop()
})

/** The body of a response, as json. */
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Creates an article and answers its identifier and its validator. */
async function create(title: string): Promise<{ id: string; etag: string }> {
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
    method: 'POST',
    body: { title },
    headers: { 'idempotency-key': `pool-${title.replace(/\s+/g, '-')}` },
  })
  expect(response.status).toBe(201)
  const body = await json(response)
  const id = body.data.id as string
  const read = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`)
  return { id, etag: read.headers.get('etag') ?? '' }
}

describe('the pool of the database', () => {
  test('it survives the statements that fail', async () => {
    const { id, etag } = await create('the pool probe')
    const other = new Client({ connectionString: database.runtimeUrl })
    await other.connect()
    await other.query('begin')
    await other.query(
      `select set_config('data.tenant_id', $1, true), set_config('data.workspace_id', $2, true)`,
      [TENANT_ID, WORKSPACE_ID]
    )
    await other.query(`select id from data.articles where id = $1 for update`, [id])

    // Every attempt waits for the lock that the other session holds,
    // and every attempt fails with the lock timeout of the service.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`, {
        method: 'PATCH',
        body: { title: `the locked title ${attempt}` },
        headers: { 'if-match': etag },
      })
      // The refusal of the contract is a conflict and not an internal
      // error: a lock that was not granted in time is a conflict with
      // the current state of the record.
      expect(response.status).toBe(409)
      const body = await json(response)
      expect(body.error.code).toBe('CONFLICT')
    }

    await other.query('rollback')
    await other.end()

    // The failures above did not take the connections of the pool with
    // them: the service still answers.
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`, {
      method: 'PATCH',
      body: { title: 'the title after the locks' },
      headers: { 'if-match': etag },
    })
    expect(response.status).toBe(200)
  }, 60_000)
})
