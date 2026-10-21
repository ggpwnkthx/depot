import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { testDatabase, type TestDatabase } from '../helpers/database'
import { Parameters, searchClause } from '../../src/domains/records/sql'
import { parseManifestBundle } from '../../src/domains/schema'

/**
 * The search of a collection is cheap only when the index of the search
 * is used, and the index is used only when its expression is the
 * expression of the statement. The test reads the plan of the database:
 * a change of the statement that breaks the match is a silent
 * regression, and the plan is the evidence.
 */

let database: TestDatabase
let owner: Client

const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111'

beforeAll(async () => {
  database = await testDatabase()
  await database.reset()
  await database.seed([{ id: WORKSPACE_ID, tenantId: TENANT_ID, slug: 'acme' }])
  owner = new Client({ connectionString: database.ownerUrl })
  await owner.connect()
})

afterAll(async () => {
  await owner?.end()
})

describe('the index of the search', () => {
  test('the plan of the search uses the index of the deployment', async () => {
    const manifest = parseManifestBundle(await Bun.file('manifests/schema.json').text())
    const articles = manifest.collections.find((entry) => entry.key === 'articles')!
    expect(articles.search).toBeDefined()

    // The rows are many and the term of the search is rare: the
    // planner only uses the index when the index is the cheaper way.
    await owner.query(
      `insert into data.articles
         (tenant_id, workspace_id, created_by, updated_by, title, body, status)
       select $1::uuid, $2::uuid, $3::uuid, $3::uuid,
              case when g <= 10 then 'Zeppelin ' || g else 'Article ' || g end,
              case when g <= 10 then 'The journey of the airship.' else 'The body of the record.' end,
              'draft'
         from generate_series(1, 5000) g`,
      [TENANT_ID, WORKSPACE_ID, PRINCIPAL_ID]
    )
    await owner.query('analyze data.articles')

    const parameters = new Parameters()
    const clause = searchClause(articles, parameters, 'zeppelin')!
    const plan = await owner.query(
      `explain select id from data.articles t where ${clause}`,
      parameters.values
    )
    const text = plan.rows.map((row) => String(row['QUERY PLAN'])).join('\n')
    expect(text).toContain('articles_search_idx')

    await owner.query('delete from data.articles')
  })
})
