import { createHmac } from 'node:crypto'
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

/** The key of the cursors of the tests. */
const CURSOR_KEY = 'cursor-key-of-the-tests-000000000000'

/** Signs a payload of a cursor, as the service does. */
function sign(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', CURSOR_KEY).update(body).digest('base64url')
  return `${body}.${signature}`
}

/** Reads the payload of a cursor. */
function payloadOf(cursor: string): Record<string, unknown> {
  const body = cursor.split('.')[0] ?? ''
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
}

/** Creates an article and answers its identifier. */
async function create(
  title: string,
  key = `cursor-${title.replace(/\s+/g, '-')}`
): Promise<string> {
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
    method: 'POST',
    body: { title },
    headers: { 'idempotency-key': key },
  })
  const body = await json(response)
  return body.data.id as string
}

/** A page of the articles, with its cursor. */
async function firstPage(): Promise<string> {
  for (let index = 0; index < 5; index += 1) await create(`cursor article ${index}`)
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles?limit=1`)
  const body = await json(response)
  return body.meta.nextCursor as string
}

describe('the cursor of a page', () => {
  test('a cursor that was tampered with is an invalid cursor', async () => {
    const cursor = await firstPage()
    const tampered = `${cursor.slice(0, -2)}xy`
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=1&cursor=${encodeURIComponent(tampered)}`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_CURSOR')
  })

  test('a cursor that is not a cursor at all is an invalid cursor', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=1&cursor=not-a-cursor`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_CURSOR')
  })

  test('an expired cursor is a stale cursor', async () => {
    const cursor = await firstPage()
    const payload = payloadOf(cursor)
    const expired = sign({ ...payload, expiry: Date.now() - 1000 })
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=1&cursor=${encodeURIComponent(expired)}`
    )
    expect(response.status).toBe(409)
    const body = await json(response)
    expect(body.error.code).toBe('CURSOR_STALE')
  })

  test('a cursor of another deployment is a stale cursor', async () => {
    const cursor = await firstPage()
    const payload = payloadOf(cursor)
    const stale = sign({ ...payload, policyVersion: 'another-bundle' })
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=1&cursor=${encodeURIComponent(stale)}`
    )
    expect(response.status).toBe(409)
    const body = await json(response)
    expect(body.error.code).toBe('CURSOR_STALE')
  })

  test('a cursor of another query is an invalid cursor', async () => {
    const cursor = await firstPage()
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=2&cursor=${encodeURIComponent(cursor)}`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_CURSOR')
  })

  test('a cursor of another principal is an invalid cursor', async () => {
    const cursor = await firstPage()
    const payload = payloadOf(cursor)
    const other = sign({ ...payload, principal: OTHER_TENANT_ID })
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=1&cursor=${encodeURIComponent(other)}`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_CURSOR')
  })

  test('a cursor of another workspace is an invalid cursor', async () => {
    const cursor = await firstPage()
    const payload = payloadOf(cursor)
    const other = sign({ ...payload, workspace: OTHER_WORKSPACE_ID })
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=1&cursor=${encodeURIComponent(other)}`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_CURSOR')
  })

  test('the refusal of a cursor never carries the reason of the refusal', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=1&cursor=not-a-cursor`
    )
    const body = await json(response)
    expect(body.error.message).toBe('The cursor is not valid.')
    expect(body.error.details).toBeUndefined()
  })
})
