import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createHarness,
  PRINCIPAL_ID,
  TENANT_ID,
  WORKSPACE_ID,
  type Harness,
} from '../helpers/harness'

let harness: Harness

beforeAll(async () => {
  harness = await createHarness()
  harness.hub.grants.set(PRINCIPAL_ID, [
    {
      tenantId: TENANT_ID,
      permissionKeys: ['content.reader', 'content.editor', 'data.audit.read'],
    },
  ])
})

afterAll(async () => {
  await harness?.stop()
})

/** The body of a response, as json. */
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

describe('the search of a collection', () => {
  test('it finds the records that hold the text', async () => {
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Zeppelin expedition', body: 'The journey of the airship.' },
      headers: { 'idempotency-key': 'search-1' },
    })
    expect(created.status).toBe(201)
    await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Submarine voyage', body: 'The journey under the sea.' },
      headers: { 'idempotency-key': 'search-2' },
    })

    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles?search=zeppelin`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].title).toBe('Zeppelin expedition')
  })

  test('it searches the body as well as the title', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles?search=airship`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].title).toBe('Zeppelin expedition')
  })

  test('it is combined with the filter of the caller', async () => {
    const filter = encodeURIComponent(JSON.stringify({ status: { _eq: 'published' } }))
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?search=zeppelin&filter=${filter}`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(0)
  })

  test('the count of a search counts the rows of the search', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?search=zeppelin&include_count=true`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.meta.count).toBe(1)
  })

  test('it refuses a search of a collection that has none', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/categories?search=name`)
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_QUERY')
  })

  test('it refuses a search that is too long', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?search=${'x'.repeat(300)}`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_QUERY')
  })

  test('the aggregate answers the groups of a search', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/aggregate/articles?group_by=status&search=zeppelin`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].count).toBe(1)
    expect(body.data[0].group.status).toBe('draft')
  })
})
