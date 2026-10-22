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

/** Creates a record and answers its identifier. */
async function create(
  collection: string,
  body: Record<string, unknown>,
  key: string
): Promise<string> {
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/${collection}`, {
    method: 'POST',
    body,
    headers: { 'idempotency-key': key },
  })
  expect(response.status).toBe(201)
  const answer = await json(response)
  return answer.data.id as string
}

/** A page of the articles, with the relations that are asked for. */
async function list(query: string): Promise<any> {
  const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles?${query}`)
  expect(response.status).toBe(200)
  return await json(response)
}

describe('the expansion of a relation', () => {
  test('a relation of many to one is expanded', async () => {
    const category = await create('categories', { name: 'the category' }, 'rel-cat-1')
    await create('articles', { title: 'with a category', category_id: category }, 'rel-art-1')
    const page = await list('include=category')
    const article = page.data.find((row: any) => row.title === 'with a category')
    expect(article).toBeDefined()
    expect(article.category).toBeDefined()
    expect(article.category.id).toBe(category)
    expect(article.category.name).toBe('the category')
  })

  test('a relation of one to many is expanded', async () => {
    const parent = await create('articles', { title: 'the parent' }, 'rel-parent')
    await create('articles', { title: 'the child', parent_id: parent }, 'rel-child')
    const page = await list('include=children')
    const root = page.data.find((row: any) => row.title === 'the parent')
    expect(root).toBeDefined()
    expect(Array.isArray(root.children)).toBe(true)
    expect(root.children.length).toBe(1)
    expect(root.children[0].title).toBe('the child')
  })

  test('the expansion of a page expands every row of the page', async () => {
    const category = await create('categories', { name: 'the shared category' }, 'rel-cat-2')
    await create('articles', { title: 'first of the page', category_id: category }, 'rel-art-2')
    await create('articles', { title: 'second of the page', category_id: category }, 'rel-art-3')
    const page = await list('include=category&limit=50')
    const withCategory = page.data.filter(
      (row: any) => row.title.startsWith('first of') || row.title.startsWith('second of')
    )
    expect(withCategory.length).toBe(2)
    for (const row of withCategory) {
      expect(row.category?.id).toBe(category)
    }
  })

  test('a relation that is not asked for is not in the answer', async () => {
    const category = await create('categories', { name: 'the lonely category' }, 'rel-cat-3')
    await create('articles', { title: 'without an expansion', category_id: category }, 'rel-art-4')
    const page = await list('limit=50')
    const article = page.data.find((row: any) => row.title === 'without an expansion')
    expect(article).toBeDefined()
    expect(article.category).toBeUndefined()
  })

  test('a relation that does not exist is refused', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/items/articles?include=unknown`)
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_QUERY')
  })

  test('an expansion of a relation of the call is refused', async () => {
    // The endpoint of a record does not accept an expansion.
    const id = await create('articles', { title: 'the record of the expansion' }, 'rel-art-5')
    const response = await harness.request(
      `/ws/${WORKSPACE_ID}/v1/items/articles/${id}?include=category`
    )
    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.error.code).toBe('INVALID_QUERY')
  })

  test('the fields of a relation are the fields the policies grant', async () => {
    const category = await create('categories', { name: 'the narrow category' }, 'rel-cat-4')
    await create(
      'articles',
      { title: 'with a narrow category', category_id: category },
      'rel-art-6'
    )
    const page = await list('include=category&limit=50')
    const article = page.data.find((row: any) => row.title === 'with a narrow category')
    expect(article.category.name).toBe('the narrow category')
    // The policies of the categories do not grant the server fields.
    expect(article.category.created_by).toBeUndefined()
  })
})
