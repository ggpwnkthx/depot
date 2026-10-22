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
})

afterAll(async () => {
  await harness?.stop()
})

/** The body of a response, as json. */
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Gives the permissions of a principal to the hub of the tests. */
function grants(principal: string, permissionKeys: string[]): void {
  harness.hub.grants.set(principal, [{ tenantId: TENANT_ID, permissionKeys }])
}

describe('the projection of a read', () => {
  test('a field that a policy hides is not in the answer', async () => {
    // The principal holds the author and the editor, and not the
    // reader: the policy that covers its own rows grants five fields,
    // and the others are not in the answer.
    grants(PRINCIPAL_ID, ['content.author', 'content.editor'])
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'the projection', body: 'the body', status: 'draft' },
      headers: { 'idempotency-key': 'projection-1' },
    })
    expect(created.status).toBe(201)
    const id = (await json(created)).data.id as string

    const read = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`)
    expect(read.status).toBe(200)
    const body = await json(read)
    // The policy grants these fields.
    expect(body.data.title).toBe('the projection')
    expect(body.data.body).toBe('the body')
    expect(body.data.status).toBe('draft')
    // The policy does not grant these ones: the value of a field the
    // caller may not see never leaves the database.
    expect(body.data.category_id).toBeUndefined()
    expect(body.data.parent_id).toBeUndefined()
    expect(body.data.children).toBeUndefined()
    expect(body.data.category).toBeUndefined()
  })

  test('a relation that a policy does not grant may not be expanded', async () => {
    grants(PRINCIPAL_ID, ['content.author', 'content.editor'])
    // The relation is not a field of the policy of the principal, and
    // the caller may not ask for it: the answer is a refusal of the
    // query and not an answer with the relation.
    const refused = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles?include=category`)
    expect(refused.status).toBe(400)
    const refusal = await json(refused)
    expect(refusal.error.code).toBe('INVALID_QUERY')

    const list = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    expect(list.status).toBe(200)
    const body = await json(list)
    for (const row of body.data) {
      expect(row.category).toBeUndefined()
    }
  })

  test('the fields of a policy that covers every row are in the answer', async () => {
    grants(PRINCIPAL_ID, ['content.reader'])
    const list = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    expect(list.status).toBe(200)
    const body = await json(list)
    expect(body.data.length).toBeGreaterThan(0)
    for (const row of body.data) {
      expect(row.title).toBeDefined()
      expect(row.status).toBeDefined()
      // The reader holds every field of the collection.
      expect('category_id' in row).toBe(true)
    }
  })
})

describe('a collection that the caller may not use', () => {
  test('it is forbidden', async () => {
    // The principal holds the reader and the editor, and not the
    // permission of the projection: the collection exists, and it is
    // not a collection of the caller.
    grants(PRINCIPAL_ID, ['content.reader', 'content.editor'])
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/article_stats`)
    expect(response.status).toBe(403)
    const body = await json(response)
    expect(body.error.code).toBe('FORBIDDEN')
  })

  test('the schema does not offer it either', async () => {
    grants(PRINCIPAL_ID, ['content.reader', 'content.editor'])
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/schema`)
    expect(response.status).toBe(200)
    const body = await json(response)
    const keys = body.data.collections.map((entry: any) => entry.key)
    expect(keys).toContain('articles')
    expect(keys).not.toContain('article_stats')
  })

  test('a collection that holds no policy is refused', async () => {
    grants(PRINCIPAL_ID, ['content.reader'])
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/does_not_exist`)
    expect(response.status).toBe(404)
    const body = await json(response)
    expect(body.error.code).toBe('NOT_FOUND')
  })
})
