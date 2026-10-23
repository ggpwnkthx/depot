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
}, 30_000)

/** The body of a response, as json. */
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Creates an article and returns its identifier. */
async function create(title: string, key: string): Promise<string> {
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
    method: 'POST',
    body: { title },
    headers: { 'idempotency-key': key },
  })
  const body = await json(response)
  return body.data.id as string
}

/** Reads a record and returns its representation and its validator. */
async function read(id: string): Promise<{ record: any; etag: string }> {
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`)
  const body = await json(response)
  return { record: body.data, etag: response.headers.get('etag')! }
}

/** Updates a record and returns the status of the answer. */
async function update(id: string, body: Record<string, unknown>, etag: string): Promise<Response> {
  return await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`, {
    method: 'PATCH',
    body,
    headers: { 'if-match': etag },
  })
}

describe('the history of the versions of a record', () => {
  test('the versions of a record that was never changed are empty', async () => {
    const id = await create('Never changed', 'versions-empty')
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/versions`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toEqual([])
  })

  test('every change writes the image of the version it supersedes', async () => {
    const id = await create('The first title', 'versions-chain')
    const first = await read(id)
    expect(first.record.version).toBe(1)

    await update(id, { title: 'The second title' }, first.etag)
    const second = await read(id)
    await update(id, { title: 'The third title', status: 'review' }, second.etag)

    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/versions`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(2)
    // The versions are the latest first.
    expect(body.data[0].version).toBe(2)
    expect(body.data[0].operation).toBe('update')
    expect(body.data[0].changedFields).toEqual(['title', 'status'])
    expect(body.data[0].supersededBy).toBe(PRINCIPAL_ID)
    expect(body.data[1].version).toBe(1)
    expect(body.data[1].changedFields).toEqual(['title'])
  })

  test('a version is read with the policies of the deployment', async () => {
    const id = await create('The original title', 'versions-read')
    const first = await read(id)
    await update(id, { title: 'The other title' }, first.etag)

    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/versions/1`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.title).toBe('The original title')
    expect(body.data.version).toBe(1)
    expect(response.headers.get('etag')).toBeTruthy()

    const missing = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/versions/9`)
    expect(missing.status).toBe(404)

    // The current version of a record is the record itself: the
    // validator of the version is the validator of the record.
    const current = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/versions/2`)
    expect(current.status).toBe(200)
    expect(current.headers.get('etag')).toBe((await read(id)).etag)
  })

  test('a version that the caller may not read is not found', async () => {
    const id = await create('The private title', 'versions-private')
    const first = await read(id)
    await update(id, { title: 'The private title, revised' }, first.etag)

    // The other principal holds the author permission: it reads the
    // records it created, and it reads nothing else.
    const other = '55555555-5555-4555-8555-555555555555'
    harness.hub.grants.set(other, [{ tenantId: TENANT_ID, permissionKeys: ['content.author'] }])
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles/${id}/versions/1`,
      { subject: other }
    )
    expect(response.status).toBe(404)
    const list = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/versions`, {
      subject: other,
    })
    expect(list.status).toBe(200)
    expect((await json(list)).data).toEqual([])
  })

  test('a collection that keeps no history answers nothing', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/categories/44444444-4444-4444-8444-444444444444/versions`
    )
    expect(response.status).toBe(404)
  })
})

describe('the rollback of a version', () => {
  test('a record is rolled back to one of its versions', async () => {
    const id = await create('The title of the first version', 'rollback-ok')
    const first = await read(id)
    await update(id, { title: 'The title of the second version' }, first.etag)
    const second = await read(id)
    expect(second.record.title).toBe('The title of the second version')

    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/rollback`, {
      method: 'POST',
      body: { version: 1 },
      headers: { 'if-match': second.etag },
    })
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.title).toBe('The title of the first version')
    // The version of the record never moves back: the rollback is a
    // change like any other.
    expect(body.data.version).toBe(3)
    expect(response.headers.get('etag')).toBeTruthy()
  })

  test('the rollback needs a validator', async () => {
    const id = await create('The title of the version', 'rollback-validator')
    const first = await read(id)
    const refused = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/rollback`, {
      method: 'POST',
      body: { version: 1 },
    })
    expect(refused.status).toBe(428)

    const stale = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/rollback`, {
      method: 'POST',
      body: { version: 1 },
      headers: { 'if-match': `"sha256:${'0'.repeat(64)}"` },
    })
    expect(stale.status).toBe(412)
    expect(first.etag).toBeTruthy()
  })

  test('a rollback to the current version is a conflict', async () => {
    const id = await create('The title of the version', 'rollback-current')
    const first = await read(id)
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/rollback`, {
      method: 'POST',
      body: { version: 1 },
      headers: { 'if-match': first.etag },
    })
    expect(response.status).toBe(409)
  })

  test('a rollback to a version that does not exist is not found', async () => {
    const id = await create('The title of the version', 'rollback-missing')
    const first = await read(id)
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/rollback`, {
      method: 'POST',
      body: { version: 7 },
      headers: { 'if-match': first.etag },
    })
    expect(response.status).toBe(404)
  })

  test('the body of a rollback holds one version', async () => {
    const id = await create('The title of the version', 'rollback-body')
    const first = await read(id)
    const malformed = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles/${id}/rollback`,
      { method: 'POST', body: { version: '1' }, headers: { 'if-match': first.etag } }
    )
    expect(malformed.status).toBe(400)
    const unknown = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/rollback`, {
      method: 'POST',
      body: { version: 1, reason: 'because' },
      headers: { 'if-match': first.etag },
    })
    expect(unknown.status).toBe(400)
  })

  test('a rollback is a write, and the policies of the deployment decide', async () => {
    const id = await create('The title of the version', 'rollback-policy')
    const first = await read(id)
    await update(id, { title: 'The other title' }, first.etag)
    const second = await read(id)

    // The other principal may read the record and may not write it.
    const other = '55555555-5555-4555-8555-555555555555'
    harness.hub.grants.set(other, [{ tenantId: TENANT_ID, permissionKeys: ['content.reader'] }])
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/rollback`, {
      method: 'POST',
      subject: other,
      body: { version: 1 },
      headers: { 'if-match': second.etag },
    })
    expect(response.status).toBe(403)
  })

  test('the rollback of a deleted record restores it', async () => {
    const id = await create('The title of the deleted record', 'rollback-delete')
    const first = await read(id)
    const removed = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}`, {
      method: 'DELETE',
      headers: { 'if-match': first.etag },
    })
    expect(removed.status).toBe(204)

    // The tombstone is the last version of the record.
    const versions = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/versions`)
    const list = await json(versions)
    expect(list.data).toHaveLength(1)
    expect(list.data[0].version).toBe(1)
    expect(list.data[0].operation).toBe('delete')

    const tombstone = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles/${id}/versions/1`
    )
    expect(tombstone.status).toBe(200)
    const etag = tombstone.headers.get('etag')!

    const restored = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles/${id}/rollback`, {
      method: 'POST',
      body: { version: 1 },
      headers: { 'if-match': etag },
    })
    expect(restored.status).toBe(200)
    const body = await json(restored)
    expect(body.data.title).toBe('The title of the deleted record')
    expect(body.data.version).toBe(2)

    const read2 = await read(id)
    expect(read2.record.title).toBe('The title of the deleted record')
  })
})
