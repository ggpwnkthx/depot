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
      permissionKeys: [
        'content.reader',
        'content.editor',
        'data.audit.read',
        'data.projection.write',
      ],
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

/** Creates an article. */
async function createArticle(title: string, status = 'draft'): Promise<string> {
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
    method: 'POST',
    body: { title, status },
    headers: { 'idempotency-key': `aggregate-${title.replace(/[^A-Za-z0-9._-]/g, '-')}` },
  })
  expect(response.status).toBe(201)
  const body = await json(response)
  return body.data.id
}

describe('the aggregate of a collection', () => {
  test('it counts the rows of the collection', async () => {
    await createArticle('Counted')
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/aggregate/articles`)
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].count).toBe(1)
    expect(body.data[0].group).toEqual({})
    expect(body.meta).toEqual({ limit: 100, groups: 1, truncated: false })
  })

  test('it groups the rows by a field', async () => {
    await createArticle('Grouped draft', 'draft')
    await createArticle('Grouped review', 'review')
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/aggregate/articles?group_by=status`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    const groups = Object.fromEntries(
      body.data.map((entry: any) => [entry.group.status, entry.count])
    )
    expect(groups.draft).toBe(2)
    expect(groups.review).toBe(1)
  })

  test('it sums and bounds the values of a field', async () => {
    const articleId = await createArticle('Measured')
    for (const [key, words, event] of [
      ['aggregate-stats-1', 10, 'event-1'],
      ['aggregate-stats-2', 20, 'event-2'],
    ] as const) {
      const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/article_stats`, {
        method: 'POST',
        body: {
          article_id: articleId,
          word_count: words,
          event_id: '44444444-4444-4444-8444-44444444444' + (event === 'event-1' ? '1' : '2'),
        },
        headers: { 'idempotency-key': key },
      })
      expect(response.status).toBe(201)
    }
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/aggregate/article_stats?metrics=sum:word_count,min:word_count,max:word_count,avg:word_count`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].count).toBe(2)
    expect(body.data[0].sum.word_count).toBe('30')
    expect(body.data[0].min.word_count).toBe('10')
    expect(body.data[0].max.word_count).toBe('20')
    expect(body.data[0].avg.word_count).toBe('15.0000000000000000')
  })

  test('it applies the filter of the caller', async () => {
    await createArticle('Filtered draft', 'draft')
    const filter = encodeURIComponent(JSON.stringify({ status: { _eq: 'review' } }))
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/aggregate/articles?group_by=status&filter=${filter}`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].group.status).toBe('review')
    expect(body.data[0].count).toBe(1)
  })

  test('it says when the groups of the answer are not all of them', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/aggregate/articles?group_by=status&limit=1`
    )
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.data).toHaveLength(1)
    expect(body.meta.truncated).toBe(true)
    expect(body.meta.limit).toBe(1)
  })

  test('it refuses a field the caller may not filter by', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/aggregate/articles?group_by=created_by`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_QUERY')
  })

  test('it refuses a function that the type of the field does not support', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/aggregate/articles?metrics=sum:title`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_QUERY')
  })

  test('it refuses an unknown function', async () => {
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/aggregate/articles?metrics=median:title`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_QUERY')
  })

  test('it refuses a collection that does not exist', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/aggregate/invoices`)
    expect(response.status).toBe(404)
  })
})
