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
      permissionKeys: ['content.reader', 'content.editor'],
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

/** Creates an article with a body of a size. */
async function create(index: number, size: number): Promise<void> {
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
    method: 'POST',
    body: { title: `the budget ${index}`, body: 'x'.repeat(size) },
    headers: { 'idempotency-key': `budget-${index}-${size}` },
  })
  expect(response.status).toBe(201)
}

describe('the budget of the size of an answer', () => {
  test('an answer that fits in the budget is answered', async () => {
    for (let index = 0; index < 5; index += 1) await create(index, 100_000)
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=10&sort=title`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.length).toBeGreaterThan(0)
  })

  test('an answer that does not fit in the budget is refused', async () => {
    // Forty records of two hundred kilobytes are eight mebibytes: the
    // answer is refused, and it is refused before it is built.
    for (let index = 0; index < 40; index += 1) await create(100 + index, 200_000)
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=50&sort=title`
    )
    expect(response.status).toBe(422)
    const body = await json(response)
    expect(body.error.code).toBe('RESULT_TOO_LARGE')
  })

  test('the refusal of the budget does not leak the size of the answer', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles?limit=50&sort=title`
    )
    const body = await json(response)
    expect(body.error.message).toBe('The result is larger than the budget of the service.')
    expect(JSON.stringify(body)).not.toContain('x'.repeat(100))
  })

  test('the service still answers after a refusal', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles?limit=5`)
    expect(response.status).toBe(200)
  })
})
