import { describe, expect, test } from 'bun:test'
import { ApiError, DataClient } from '../src/index'

/**
 * A stand in for the deployment.
 *
 * The consumer test does not need a database: it needs a server that
 * speaks the contract. The server answers the paths of the API and it
 * records what the client sent.
 */
interface Call {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

const calls: Call[] = []
let counter = 0

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url)
    const body =
      request.method === 'GET' || request.method === 'DELETE' ? null : await request.json()
    calls.push({
      method: request.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      body: body as unknown,
    })
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      })

    if (url.pathname.endsWith('/v1/me')) {
      return json({
        data: {
          principalId: '11111111-1111-4111-8111-111111111111',
          tenantId: '22222222-2222-4222-8222-222222222222',
          workspaceId: '33333333-3333-4333-8333-333333333333',
          routeId: 'data-api',
          apiVersion: 'v1',
        },
      })
    }
    if (url.pathname.endsWith('/v1/schema')) {
      return json({
        data: {
          apiVersion: 'v1',
          schemaVersion: 'articles-v1',
          policyBundleVersion: 'test',
          collections: [
            {
              key: 'articles',
              label: 'Articles',
              schemaVersion: 'articles-v1',
              actions: ['read', 'create'],
              readableFields: ['title'],
              writableFields: ['title'],
              filterableFields: ['title'],
              fields: [{ name: 'title', type: 'string', required: true, nullable: false }],
              relations: [],
            },
          ],
        },
      })
    }
    if (url.pathname.endsWith('/v1/items/articles') && request.method === 'POST') {
      counter += 1
      return json(
        { data: { id: `44444444-4444-4444-8444-44444444444${counter}`, version: 1 } },
        201,
        { location: '/ws/33333333-3333-4333-8333-333333333333/v1/items/articles/1' }
      )
    }
    if (url.pathname.includes('/v1/items/articles/') && request.method === 'GET') {
      return json(
        { data: { id: '44444444-4444-4444-8444-444444444444', version: 1, title: 'Launch' } },
        200,
        { etag: '"sha256:0000000000000000000000000000000000000000000000000000000000000000"' }
      )
    }
    if (url.pathname.includes('/v1/items/articles/') && request.method === 'PATCH') {
      return json(
        { data: { id: '44444444-4444-4444-8444-444444444444', version: 2, title: 'Changed' } },
        200,
        { etag: '"sha256:1111111111111111111111111111111111111111111111111111111111111111"' }
      )
    }
    if (url.pathname.includes('/v1/items/articles/') && request.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith('/v1/items/articles')) {
      const cursor = url.searchParams.get('cursor')
      if (!cursor) {
        return json({
          data: [{ id: '1', version: 1, title: 'One' }],
          meta: { limit: 1, nextCursor: 'next-page' },
        })
      }
      return json({
        data: [{ id: '2', version: 1, title: 'Two' }],
        meta: { limit: 1, nextCursor: null },
      })
    }
    if (url.pathname.endsWith('/v1/audit')) {
      return json({ data: [{ id: '1' }], meta: { limit: 50, nextCursor: null } })
    }
    return json(
      {
        error: { code: 'NOT_FOUND', message: 'The resource does not exist.' },
        requestId: 'request-1',
      },
      404
    )
  },
})

const client = new DataClient({
  baseUrl: `http://127.0.0.1:${server.port}`,
  workspaceId: '33333333-3333-4333-8333-333333333333',
  headers: { cookie: 'shuttle_session=the-session-of-the-caller' },
})

describe('the client of the api', () => {
  test('it reads the identity of the caller', async () => {
    const me = await client.me()
    expect(me.apiVersion).toBe('v1')
    const call = calls.at(-1)!
    expect(call.path).toBe('/ws/33333333-3333-4333-8333-333333333333/v1/me')
    expect(call.headers.cookie).toBe('shuttle_session=the-session-of-the-caller')
  })

  test('it reads the metadata of the collections', async () => {
    const schema = await client.schema()
    expect(schema.collections[0]?.key).toBe('articles')
  })

  test('it lists with a query', async () => {
    const page = await client.list('articles', {
      fields: ['title'],
      filter: { title: { _eq: 'Launch' } },
      sort: ['-title'],
      limit: 10,
      includeCount: true,
    })
    expect(page.data).toHaveLength(1)
    const call = calls.at(-1)!
    expect(call.path).toContain('fields=title')
    expect(call.path).toContain('include_count=true')
    expect(call.path).toContain('filter=')
  })

  test('it traverses the pages with the cursor', async () => {
    const pages: string[][] = []
    for await (const page of client.listAll('articles', { limit: 1 })) {
      pages.push(page.map((entry) => String(entry.id)))
    }
    expect(pages).toEqual([['1'], ['2']])
  })

  test('it creates with an idempotency key', async () => {
    const receipt = await client.create(
      'articles',
      { title: 'Launch' },
      {
        idempotencyKey: 'key-1',
      }
    )
    expect(receipt.version).toBe(1)
    const call = calls.at(-1)!
    expect(call.method).toBe('POST')
    expect(call.headers['idempotency-key']).toBe('key-1')
  })

  test('it reads a record with its validator', async () => {
    const { record, etag } = await client.getWithValidator('articles', '1')
    expect(record.title).toBe('Launch')
    expect(etag).toContain('sha256:')
  })

  test('it updates with the validator of the record', async () => {
    const { record } = await client.update(
      'articles',
      '44444444-4444-4444-8444-444444444444',
      { title: 'Changed' },
      { etag: '"sha256:0000000000000000000000000000000000000000000000000000000000000000"' }
    )
    expect(record.version).toBe(2)
    const call = calls.at(-1)!
    expect(call.headers['if-match']).toContain('sha256:')
  })

  test('it deletes with the validator of the record', async () => {
    await client.remove('articles', '44444444-4444-4444-8444-444444444444', {
      etag: '"sha256:0000000000000000000000000000000000000000000000000000000000000000"',
    })
    expect(calls.at(-1)!.method).toBe('DELETE')
  })

  test('it exposes the stable codes of the errors', async () => {
    let error: unknown = null
    try {
      await client.get('unknown', 'not-a-record')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('NOT_FOUND')
    expect((error as ApiError).status).toBe(404)
    expect((error as ApiError).requestId).toBe('request-1')
  })
})
