import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createHarness,
  PRINCIPAL_ID,
  TENANT_ID,
  WORKSPACE_ID,
  type Harness,
} from '../helpers/harness'
import { etagOf } from '../../src/domains/records/canonical'

/**
 * The two evaluations of a predicate have to agree (spec §8).
 *
 * The reads compile a predicate into SQL and the writes evaluate the same
 * predicate in memory, over the row that is locked. The null follows the
 * three valued logic of the database: a comparison with a null value is
 * unknown, and it never matches.
 *
 * The deployment of this test is a policy that reads and writes the
 * articles whose body differs from a value. A record whose body is null
 * does not match the policy: the read hides it, and the write has to
 * refuse it as well.
 */

const POLICIES = JSON.stringify({
  version: 1,
  policies: [
    {
      id: 'read-articles',
      permission: 'content.reader',
      collection: 'articles',
      action: 'read',
      where: { body: { _neq: 'hidden' } },
      fields: ['title', 'body', 'status'],
    },
    {
      id: 'create-articles',
      permission: 'content.editor',
      collection: 'articles',
      action: 'create',
      where: {},
      check: {},
      fields: ['title', 'body', 'status'],
    },
    {
      id: 'update-articles',
      permission: 'content.editor',
      collection: 'articles',
      action: 'update',
      where: { body: { _neq: 'hidden' } },
      check: {},
      fields: ['title'],
    },
    {
      id: 'delete-articles',
      permission: 'content.editor',
      collection: 'articles',
      action: 'delete',
      where: { body: { _neq: 'hidden' } },
      fields: [],
    },
  ],
})

/** The policies of a deployment where every article is readable. */
const POLICIES_OF_A_VISIBLE_DEPLOYMENT = JSON.stringify({
  version: 1,
  policies: [
    {
      id: 'read-articles',
      permission: 'content.reader',
      collection: 'articles',
      action: 'read',
      where: {},
      fields: ['title', 'body', 'status'],
    },
    {
      id: 'create-articles',
      permission: 'content.editor',
      collection: 'articles',
      action: 'create',
      where: {},
      check: {},
      fields: ['title', 'body', 'status'],
    },
    {
      id: 'update-articles',
      permission: 'content.editor',
      collection: 'articles',
      action: 'update',
      where: { body: { _neq: 'hidden' } },
      check: {},
      fields: ['title'],
    },
  ],
})

let harness: Harness

beforeAll(async () => {
  harness = await createHarness({ policies: POLICIES })
  harness.hub.grants.set(PRINCIPAL_ID, [
    { tenantId: TENANT_ID, permissionKeys: ['content.reader', 'content.editor'] },
  ])
})

afterAll(async () => {
  await harness?.stop()
})

/** The body of a response, as json. */
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Creates an article and answers its identifier. */
let created = 0
async function create(body: Record<string, unknown>): Promise<string> {
  created += 1
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
    method: 'POST',
    body: { title: 'The title', ...body },
    headers: { 'idempotency-key': `key-${created}` },
  })
  expect(response.status).toBe(201)
  const answer = await json(response)
  return answer.data.id as string
}

describe('a null value in a predicate', () => {
  test('a record whose body is null is not visible', async () => {
    const id = await create({ body: null })
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    expect(response.status).toBe(200)
    const body = await json(response)
    const items = body.data as { id: string }[]
    expect(items.map((item) => item.id)).not.toContain(id)
  })

  test('a record whose body is null cannot be updated', async () => {
    const id = await create({ body: null })
    // The record is not visible, so its representation carries its
    // identifier and its version only. The validator of that
    // representation is the one the caller computes.
    const validator = etagOf({ data: { id, version: 1 } })
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`, {
      method: 'PATCH',
      body: { title: 'Another title' },
      headers: { 'if-match': validator },
    })
    expect(response.status).toBe(403)
    const body = await json(response)
    expect(body.error.code).toBe('FORBIDDEN')
  })

  test('a record whose body is null cannot be deleted', async () => {
    const id = await create({ body: null })
    const validator = etagOf({ data: { id, version: 1 } })
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`, {
      method: 'DELETE',
      headers: { 'if-match': validator },
    })
    expect(response.status).toBe(403)
  })

  test('a record whose body is not null is visible and writable', async () => {
    const id = await create({ body: 'visible' })
    const list = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    const listed = await json(list)
    expect((listed.data as { id: string }[]).map((item) => item.id)).toContain(id)

    const read = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`)
    const etag = read.headers.get('etag')!
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`, {
      method: 'PATCH',
      body: { title: 'Another title' },
      headers: { 'if-match': etag },
    })
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.title).toBe('Another title')
  })

  test('a record whose body is the excluded value is not visible either', async () => {
    const id = await create({ body: 'hidden' })
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    const body = await json(response)
    expect((body.data as { id: string }[]).map((item) => item.id)).not.toContain(id)
  })
})

describe('a null value in the predicate of a write', () => {
  test('a readable record whose body is null is not written', async () => {
    const visible = await createHarness({ policies: POLICIES_OF_A_VISIBLE_DEPLOYMENT })
    visible.hub.grants.set(PRINCIPAL_ID, [
      { tenantId: TENANT_ID, permissionKeys: ['content.reader', 'content.editor'] },
    ])
    try {
      const created = await visible.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
        method: 'POST',
        body: { title: 'The title', body: null },
        headers: { 'idempotency-key': 'key-null' },
      })
      expect(created.status).toBe(201)
      const id = (await json<{ data: { id: string } }>(created)).data.id

      const read = await visible.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`)
      expect(read.status).toBe(200)
      const etag = read.headers.get('etag')!

      // The policy of the update only covers the records whose body
      // differs from a value: a record whose body is null is not one of
      // them, and the write is refused.
      const response = await visible.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`, {
        method: 'PATCH',
        body: { title: 'Another title' },
        headers: { 'if-match': etag },
      })
      expect(response.status).toBe(403)
      const body = await json(response)
      expect(body.error.code).toBe('FORBIDDEN')
    } finally {
      await visible.stop()
    }
  })
})
