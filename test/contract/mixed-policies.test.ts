import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from '../helpers/harness'

/**
 * The fields of two policies are never mixed.
 *
 * The bundle of this file holds two read policies that grant different
 * fields and that cover different rows: one covers every row and
 * grants the title, the other covers the rows of the principal and
 * grants the body.
 *
 * The answer of a row that the second policy does not cover does not
 * carry the body, even though the caller holds the second policy: the
 * fields of a row are the fields of the policies that **cover that
 * row**, and not the fields of the policies of the caller.
 */

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '55555555-5555-4555-8555-555555555555'

/** The bundle of the policies of this file. */
const BUNDLE = JSON.stringify({
  version: 1,
  policies: [
    {
      id: 'read-title',
      permission: 'x.reader',
      collection: 'articles',
      action: 'read',
      where: {},
      fields: ['title'],
    },
    {
      id: 'read-body-own',
      permission: 'x.owner',
      collection: 'articles',
      action: 'read',
      where: { created_by: { _eq: '$principalId' } },
      fields: ['body'],
    },
    {
      id: 'create-articles',
      permission: 'x.editor',
      collection: 'articles',
      action: 'create',
      where: {},
      check: {},
      fields: ['title', 'body'],
    },
  ],
})

let harness: Harness

beforeAll(async () => {
  harness = await createHarness({ policies: BUNDLE })
  harness.hub.grants.set(OWNER, [
    {
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      permissionKeys: ['x.reader', 'x.owner', 'x.editor'],
    },
  ])
  harness.hub.grants.set(OTHER, [
    { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', permissionKeys: ['x.reader', 'x.editor'] },
  ])
})

afterAll(async () => {
  await harness?.stop()
})

/** The body of a response, as json. */
async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Creates an article as a principal. */
async function create(subject: string, title: string, body: string): Promise<string> {
  const response = await harness.request(
    '/ws/22222222-2222-4222-8222-222222222222/v1/items/articles',
    {
      method: 'POST',
      body: { title, body },
      headers: { 'idempotency-key': `mixed-${subject}-${title.replace(/\s+/g, '-')}` },
      subject,
    }
  )
  expect(response.status).toBe(201)
  const answer = await json(response)
  return answer.data.id as string
}

describe('the fields of two policies', () => {
  test('a row carries the fields of the policies that cover it', async () => {
    await create(OWNER, 'the own article', 'the own body')
    await create(OTHER, 'the other article', 'the other body')

    const response = await harness.request(
      '/ws/22222222-2222-4222-8222-222222222222/v1/items/articles?limit=50'
    )
    expect(response.status).toBe(200)
    const body = await json(response)

    const own = body.data.find((row: any) => row.title === 'the own article')
    const other = body.data.find((row: any) => row.title === 'the other article')
    expect(own).toBeDefined()
    expect(other).toBeDefined()

    // The row of the principal is covered by the two policies: it
    // carries the title of the first one and the body of the second.
    expect(own.title).toBe('the own article')
    expect(own.body).toBe('the own body')

    // The row of the other is covered by the first policy only: it
    // carries the title, and it does not carry the body of a policy
    // that does not cover it.
    expect(other.title).toBe('the other article')
    expect(other.body).toBeUndefined()
  })

  test('the fields of a row are the fields of the policies of the row', async () => {
    const id = await create(OTHER, 'the second other article', 'the second other body')
    const response = await harness.request(
      `/ws/22222222-2222-4222-8222-222222222222/v1/items/articles/${id}`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data.title).toBe('the second other article')
    expect(body.data.body).toBeUndefined()
  })
})
