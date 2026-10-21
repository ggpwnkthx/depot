import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createHarness,
  OTHER_TENANT_ID,
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
  await harness?.stop()
})

/** The body of a response, as json. */
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

describe('the operational endpoints', () => {
  test('the health probe does not call a dependency', async () => {
    const response = await harness.raw('/healthz')
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.status).toBe('ok')
  })

  test('the readiness probe answers when the service is ready', async () => {
    const response = await harness.raw('/readyz')
    expect(response.status).toBe(200)
  })

  test('the metrics endpoint is absent without a token', async () => {
    const response = await harness.raw('/metrics')
    expect(response.status).toBe(404)
  })
})

describe('the identity of the caller', () => {
  test('it answers with the principal, the tenant and the workspace', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/me`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.principalId).toBe(PRINCIPAL_ID)
    expect(body.data.tenantId).toBe(TENANT_ID)
    expect(body.data.workspaceId).toBe(WORKSPACE_ID)
    expect(body.data.apiVersion).toBe('v1')
  })

  test('it refuses a request without a signature', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/me`, { signature: null })
    expect(response.status).toBe(401)
    const body = await json(response)
    expect(body.error.code).toBe('UNAUTHENTICATED')
  })

  test('it refuses a request of an unknown workspace', async () => {
    const response = await harness.request('/ws/99999999-9999-4999-8999-999999999999/v1/me', {
      workspaceId: '99999999-9999-4999-8999-999999999999',
    })
    expect(response.status).toBe(404)
  })

  test('it refuses a request of another tenant without disclosing it', async () => {
    const response = await harness.request(`/ws/${OTHER_WORKSPACE_ID}/v1/me`, {
      workspaceId: OTHER_WORKSPACE_ID,
    })
    expect(response.status).toBe(403)
    const body = await json(response)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(JSON.stringify(body)).not.toContain(OTHER_TENANT_ID)
  })
})

describe('the metadata of the collections', () => {
  test('it names the collections the caller may use', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/schema`)
    expect(response.status).toBe(200)
    const body = await json(response)
    const keys = body.data.collections.map((entry: { key: string }) => entry.key)
    expect(keys).toContain('articles')
    expect(body.data.policyBundleVersion).toBeTruthy()
    expect(body.data.limits.maxLimit).toBe(200)
  })

  test('it never carries a SQL identifier', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/schema`)
    const text = await response.text()
    expect(text).not.toContain('data.articles')
    expect(text).not.toContain('_eq')
  })

  test('it answers with the metadata of one collection', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/schema/articles`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.key).toBe('articles')
    expect(body.data.actions).toContain('read')
  })

  test('it answers 404 for a collection that does not exist', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/schema/nope`)
    expect(response.status).toBe(404)
  })
})

describe('the records', () => {
  test('a creation needs an idempotency key', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Launch notes' },
    })
    expect(response.status).toBe(400)
  })

  test('a creation answers with a minimal receipt', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Launch notes', body: 'Initial content.' },
      headers: { 'idempotency-key': 'key-1' },
    })
    expect(response.status).toBe(201)
    const body = await json(response)
    expect(Object.keys(body.data).sort()).toEqual(['id', 'version'])
    expect(body.data.version).toBe(1)
    expect(response.headers.get('location')).toBe(
      `/ws/${WORKSPACE_ID}/v1/items/articles/${body.data.id}`
    )
  })

  test('a creation refuses a server field', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'x', id: '11111111-1111-4111-8111-111111111111' },
      headers: { 'idempotency-key': 'key-server-field' },
    })
    expect(response.status).toBe(422)
    const body = await json(response)
    expect(body.error.details[0].code).toBe('SERVER_FIELD')
  })

  test('a creation refuses a value that is too long', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'x'.repeat(241) },
      headers: { 'idempotency-key': 'key-too-long' },
    })
    expect(response.status).toBe(422)
    const body = await json(response)
    expect(body.error.details[0].code).toBe('MAX_LENGTH')
  })

  test('the same key and the same body answer with the same receipt', async () => {
    const first = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Replay' },
      headers: { 'idempotency-key': 'key-replay' },
    })
    const second = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Replay' },
      headers: { 'idempotency-key': 'key-replay' },
    })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.headers.get('idempotency-replayed')).toBe('true')
    const firstBody = await json(first)
    const secondBody = await json(second)
    expect(secondBody.data.id).toBe(firstBody.data.id)
  })

  test('the same key and another body are a conflict', async () => {
    await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'One' },
      headers: { 'idempotency-key': 'key-conflict' },
    })
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Another' },
      headers: { 'idempotency-key': 'key-conflict' },
    })
    expect(response.status).toBe(409)
    const body = await json(response)
    expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('a record is read with its validator', async () => {
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Readable' },
      headers: { 'idempotency-key': 'key-readable' },
    })
    const receipt = await json(created)
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles/${receipt.data.id}`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.id).toBe(receipt.data.id)
    expect(body.data.title).toBe('Readable')
    expect(response.headers.get('etag')).toMatch(/^"sha256:[0-9a-f]{64}"$/)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  test('an update needs a validator', async () => {
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Conditional' },
      headers: { 'idempotency-key': 'key-conditional' },
    })
    const receipt = await json(created)
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles/${receipt.data.id}`,
      { method: 'PATCH', body: { title: 'Changed' } }
    )
    expect(response.status).toBe(428)
  })

  test('a weak validator is refused', async () => {
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Weak' },
      headers: { 'idempotency-key': 'key-weak' },
    })
    const receipt = await json(created)
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles/${receipt.data.id}`,
      {
        method: 'PATCH',
        body: { title: 'Changed' },
        headers: {
          'if-match': 'W/"sha256:0000000000000000000000000000000000000000000000000000000000000000"',
        },
      }
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_PRECONDITION')
  })

  test('an update with a current validator changes the version', async () => {
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Before' },
      headers: { 'idempotency-key': 'key-update' },
    })
    const receipt = await json(created)
    const path = `/ws/${WORKSPACE_ID}/v1/items/articles/${receipt.data.id}`
    const read = await harness.request(path)
    const etag = read.headers.get('etag')!
    const response = await harness.request(path, {
      method: 'PATCH',
      body: { title: 'After' },
      headers: { 'if-match': etag },
    })
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.version).toBe(2)
    expect(body.data.title).toBe('After')
    expect(response.headers.get('etag')).not.toBe(etag)
  })

  test('an update with an old validator is refused', async () => {
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Stale' },
      headers: { 'idempotency-key': 'key-stale' },
    })
    const receipt = await json(created)
    const path = `/ws/${WORKSPACE_ID}/v1/items/articles/${receipt.data.id}`
    const read = await harness.request(path)
    const etag = read.headers.get('etag')!
    await harness.request(path, {
      method: 'PATCH',
      body: { title: 'First' },
      headers: { 'if-match': etag },
    })
    const response = await harness.request(path, {
      method: 'PATCH',
      body: { title: 'Second' },
      headers: { 'if-match': etag },
    })
    expect(response.status).toBe(412)
    const body = await json(response)
    expect(body.error.code).toBe('PRECONDITION_FAILED')
  })

  test('a delete needs a validator and answers 204', async () => {
    const created = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Deletable' },
      headers: { 'idempotency-key': 'key-delete' },
    })
    const receipt = await json(created)
    const path = `/ws/${WORKSPACE_ID}/v1/items/articles/${receipt.data.id}`
    const withoutValidator = await harness.request(path, { method: 'DELETE' })
    expect(withoutValidator.status).toBe(428)
    const read = await harness.request(path)
    const etag = read.headers.get('etag')!
    const response = await harness.request(path, {
      method: 'DELETE',
      headers: { 'if-match': etag },
    })
    expect(response.status).toBe(204)
    const after = await harness.request(path)
    expect(after.status).toBe(404)
  })

  test('a list is bounded and answers its meta', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=2&include_count=true`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.meta.limit).toBe(2)
    expect(typeof body.meta.count).toBe('number')
    expect(Array.isArray(body.data)).toBe(true)
  })

  test('an unknown query parameter is refused', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles?unknown=1`)
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_QUERY')
  })

  test('a repeated query parameter is refused', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles?limit=1&limit=2`)
    expect(response.status).toBe(400)
  })

  test('a filter on a field that is not readable is refused', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?filter=${encodeURIComponent(JSON.stringify({ created_by: { _eq: PRINCIPAL_ID } }))}`
    )
    expect(response.status).toBe(400)
  })

  test('a filter of a readable field is accepted', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?filter=${encodeURIComponent(JSON.stringify({ title: { _eq: 'Readable' } }))}`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(1)
  })

  test('an unknown method answers 405 with the allowed methods', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'PUT',
      body: {},
    })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toContain('GET')
  })

  test('an unknown path answers 404', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/nope`)
    expect(response.status).toBe(404)
  })
})

describe('the deferred capabilities', () => {
  const deferred = [
    '/ws/{workspaceId}/v1/items/articles/export',
    '/ws/{workspaceId}/v1/graphql',
    '/ws/{workspaceId}/v1/assets',
    '/ws/{workspaceId}/v1/items/articles/bulk',
    '/ws/{workspaceId}/v1/subscriptions',
    '/ws/{workspaceId}/v1/workflows',
    '/ws/{workspaceId}/v1/items/articles/search',
  ]

  test('they are absent', async () => {
    for (const path of deferred) {
      const response = await harness.request(path.replace('{workspaceId}', WORKSPACE_ID))
      expect(response.status).toBe(404)
    }
  })
})

describe('the audit log', () => {
  test('it is refused without the permission', async () => {
    const other = '99999999-9999-4999-8999-999999999999'
    harness.hub.grants.set(other, [{ tenantId: TENANT_ID, permissionKeys: ['content.reader'] }])
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/audit`, { subject: other })
    expect(response.status).toBe(403)
  })

  test('it answers the metadata of the mutations', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/audit`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.length).toBeGreaterThan(0)
    const entry = body.data[0]
    expect(entry.collection).toBe('articles')
    expect(entry.action).toBeTruthy()
    expect(entry.changedFields).toBeInstanceOf(Array)
    expect(entry).not.toHaveProperty('body')
  })
})

describe('the description of the API', () => {
  test('it is a versioned document', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/openapi.json`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.openapi).toBe('3.1.0')
    expect(body.paths['/ws/{workspaceId}/v1/items/{collection}']).toBeTruthy()
  })
})
