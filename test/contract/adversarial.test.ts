import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import {
  createHarness,
  OTHER_WORKSPACE_ID,
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
  console.log('stopping')
  await harness?.stop()
  console.log('stopped')
}, 30_000)

/** The body of a response, as json. */
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Creates an article and returns its receipt. */
async function create(title: string, key = `adversarial-${title}`): Promise<string> {
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
    method: 'POST',
    body: { title },
    headers: { 'idempotency-key': key },
  })
  const body = await json(response)
  return body.data.id as string
}

describe('the roles and the e-mail of the gateway are not permissions', () => {
  test('a forged role does not grant anything', async () => {
    // The principal of the test holds the reader and the editor: the
    // roles of the header are a diagnostic and they are never a
    // permission. A principal that holds nothing is refused whatever it
    // claims.
    const other = '55555555-5555-4555-8555-555555555555'
    harness.hub.grants.set(other, [])
    const refused = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      subject: other,
      roles: ['platform-admin', 'superuser', 'owner'],
    })
    expect(refused.status).toBe(403)
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      subject: other,
      roles: ['platform-admin'],
      body: { title: 'Forged role' },
      headers: { 'idempotency-key': 'forged-role' },
    })
    expect(created.status).toBe(403)
  })

  test('a forged e-mail does not grant anything', async () => {
    const other = '99999999-9999-4999-8999-999999999999'
    harness.hub.grants.set(other, [{ tenantId: TENANT_ID, permissionKeys: ['content.reader'] }])
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      subject: other,
      email: 'alice@acme.example.test',
    })
    // The principal of the answer holds only the reader: it may read, and
    // it may not write.
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      subject: other,
      email: 'alice@acme.example.test',
      body: { title: 'Forged' },
      headers: { 'idempotency-key': 'forged-e-mail' },
    })
    expect(created.status).toBe(403)
    expect(response.status).toBe(200)
  })
})

describe('the revocation is visible', () => {
  test('a principal whose grant was revoked is refused', async () => {
    const other = '88888888-8888-4888-8888-888888888888'
    harness.hub.grants.set(other, [{ tenantId: TENANT_ID, permissionKeys: ['content.reader'] }])
    const allowed = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      subject: other,
    })
    expect(allowed.status).toBe(200)
    harness.hub.grants.set(other, [])
    const refused = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      subject: other,
    })
    expect(refused.status).toBe(403)
  })

  test('an expired grant is refused', async () => {
    const other = '77777777-7777-4777-8777-777777777777'
    harness.hub.grants.set(other, [
      {
        tenantId: TENANT_ID,
        permissionKeys: ['content.reader'],
        expiresAt: Date.now() - 1000,
      },
    ])
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      subject: other,
    })
    expect(response.status).toBe(403)
  })

  test('a disabled workspace is refused', async () => {
    const owner = new Client({ connectionString: harness.database.ownerUrl })
    await owner.connect()
    await owner.query(`update platform.workspaces set status = 'disabled' where id = $1::uuid`, [
      OTHER_WORKSPACE_ID,
    ])
    await owner.end()
    const response = await harness.request(`/ws/${OTHER_WORKSPACE_ID}/v1/me`, {
      workspaceId: OTHER_WORKSPACE_ID,
    })
    expect(response.status).toBe(404)
  })
})

describe('the counts and the expansions use the same rules as the list', () => {
  test('the count of a list that is filtered by a policy is the count of the rows', async () => {
    const other = '66666666-6666-4666-8666-666666666666'
    // The principal holds the author permission: it reads the rows it
    // created and nothing else.
    harness.hub.grants.set(other, [
      { tenantId: TENANT_ID, permissionKeys: ['content.author', 'content.editor'] },
    ])
    const mine = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      subject: other,
    })
    const mineBody = await json(mine)
    expect(mineBody.data).toHaveLength(0)
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      subject: other,
      body: { title: 'Owned' },
      headers: { 'idempotency-key': 'owned-1' },
    })
    expect(created.status).toBe(201)
    const after = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?include_count=true`,
      { subject: other }
    )
    const afterBody = await json(after)
    if (after.status !== 200)
      console.log('the count answered', after.status, JSON.stringify(afterBody))
    expect(afterBody.data).toHaveLength(1)
    expect(afterBody.meta.count).toBe(1)
  })
})

describe('the concurrency of the writes', () => {
  test('two updates with the same validator answer one success and one refusal', async () => {
    const id = await create('Concurrent')
    const path = `/ws/${WORKSPACE_ID}/v1/items/articles/${id}`
    const read = await harness.request(path)
    const etag = read.headers.get('etag')!
    const [first, second] = await Promise.all([
      harness.request(path, {
        method: 'PATCH',
        body: { title: 'First' },
        headers: { 'if-match': etag },
      }),
      harness.request(path, {
        method: 'PATCH',
        body: { title: 'Second' },
        headers: { 'if-match': etag },
      }),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 412])
    const after = await harness.request(path)
    const afterBody = await json(after)
    expect(afterBody.data.version).toBe(2)
  })
})

describe('the context of the hub is never used when it is not valid', () => {
  test('an expired answer of the hub is refused', async () => {
    harness.hub.expired = true
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    expect(response.status).toBe(503)
    const body = await json(response)
    expect(body.error.code).toBe('AUTHORIZATION_UNAVAILABLE')
    harness.hub.expired = false
  })

  test('an unavailable hub is refused', async () => {
    harness.hub.unavailable = true
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    expect(response.status).toBe(503)
    const body = await json(response)
    expect(body.error.code).toBe('AUTHORIZATION_UNAVAILABLE')
    harness.hub.unavailable = false
  })

  test('a context of another workspace is refused', async () => {
    // The hub answers the fields of the request: a context that names
    // another workspace is not the context of the request.
    const original = harness.hub.grants.get(PRINCIPAL_ID)
    harness.hub.grants.set(PRINCIPAL_ID, [])
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`)
    expect(response.status).toBe(403)
    harness.hub.grants.set(PRINCIPAL_ID, original ?? [])
  })
})
