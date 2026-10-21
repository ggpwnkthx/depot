import { expect, test } from 'bun:test'
import { Client } from 'pg'
import { testDatabase } from '../helpers/database'
import { compileFilter, evaluateFilter, parseFilter } from '../../src/domains/authorization/filter'
import type { FieldDefinition } from '../../src/domains/schema'

/**
 * The two evaluations of a predicate have to agree.
 *
 * The reads compile a predicate into SQL and the writes evaluate the
 * same predicate in memory, over the row that is locked. A row that the
 * statement does not match may not be written, and its fields may not be
 * shown: the two answers have to be the same.
 *
 * The check runs against a real PostgreSQL server, because the semantics
 * that matter here — the three valued logic of the null — are the
 * semantics of the database.
 */

const catalogue: Record<string, FieldDefinition> = {
  label: { type: 'string', required: false, nullable: true },
  amount: { type: 'integer', required: false, nullable: true },
  flag: { type: 'boolean', required: false, nullable: true },
  ref: { type: 'uuid', required: false, nullable: true },
  at: { type: 'timestamp', required: false, nullable: true },
  price: { type: 'decimal', required: false, nullable: true },
  titled: { type: 'string', required: false, nullable: true },
  payload: { type: 'json', required: false, nullable: true },
}

const substitutions = {
  principalId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
}

/** The rows of the fixture: every column is null on one row. */
const FIXTURE = `
  insert into filter_probe values
    (1, 'alpha', 10, true,  'abcdef01-2345-6789-abcd-ef0123456789', '2024-01-01T00:00:00.000Z', '10.50', 'Zebra', '{"a":1,"b":2}'),
    (2, 'beta',  20, false, '55555555-5555-4555-8555-555555555555', '2024-06-01T12:30:00.000Z', '20.25', 'apple', '{"b":2,"a":1}'),
    (3, null,   null, null, null, null, null, null, null),
    (4, 'gamma', null, true, null, null, '0.10', 'Zebra', '{"a":1}')
`

/** The predicates the two evaluations have to agree on. */
const PREDICATES: readonly { name: string; filter: unknown }[] = [
  { name: 'eq', filter: { label: { _eq: 'alpha' } } },
  { name: 'neq', filter: { label: { _neq: 'alpha' } } },
  { name: 'lt', filter: { amount: { _lt: 20 } } },
  { name: 'lte', filter: { amount: { _lte: 20 } } },
  { name: 'gt', filter: { amount: { _gt: 10 } } },
  { name: 'gte', filter: { amount: { _gte: 20 } } },
  { name: 'in', filter: { label: { _in: ['alpha', 'gamma'] } } },
  { name: 'nin', filter: { label: { _nin: ['alpha'] } } },
  { name: 'is_null_true', filter: { label: { _is_null: true } } },
  { name: 'is_null_false', filter: { label: { _is_null: false } } },
  {
    name: 'and_of_two',
    filter: { _and: [{ label: { _neq: 'alpha' } }, { flag: { _eq: true } }] },
  },
  {
    name: 'or_of_two',
    filter: { _or: [{ label: { _eq: 'beta' } }, { label: { _is_null: true } }] },
  },
  { name: 'the_substitution', filter: { ref: { _eq: '$principalId' } } },
  { name: 'a_decimal', filter: { price: { _lt: '10.50' } } },
  { name: 'a_timestamp', filter: { at: { _gte: '2024-06-01T12:30:00.000Z' } } },
  {
    // The comparison of the text is the comparison of the bytes: the
    // column of the fixture carries the collation of the unicode, and the
    // two evaluations still have to agree.
    name: 'a_text_of_a_unicode_collation',
    filter: { titled: { _lt: 'apple' } },
  },
  {
    // The uuid of the database is written in lower case, and the cast of
    // the statement normalizes the operand.
    name: 'a_uuid_in_upper_case',
    filter: { ref: { _eq: 'ABCDEF01-2345-6789-ABCD-EF0123456789' } },
  },
  {
    // The json of the database does not keep the order of the keys.
    name: 'a_json_with_another_order',
    filter: { payload: { _eq: { b: 2, a: 1 } } },
  },
  {
    // The negation of a comparison: the row whose label is null is not
    // matched, because the comparison is unknown and the negation of an
    // unknown is an unknown.
    name: 'the_negation_of_a_comparison',
    filter: { _not: { label: { _eq: 'alpha' } } },
  },
  {
    name: 'the_negation_of_a_disjunction',
    filter: { _not: { _or: [{ label: { _eq: 'alpha' } }, { flag: { _eq: true } }] } },
  },
  {
    name: 'the_negation_of_a_conjunction',
    filter: { _not: { _and: [{ label: { _eq: 'alpha' } }, { amount: { _eq: 10 } }] } },
  },
  {
    name: 'the_negation_of_a_null',
    filter: { _not: { label: { _is_null: true } } },
  },
  {
    name: 'a_negation_inside_a_disjunction',
    filter: { _or: [{ _not: { label: { _eq: 'alpha' } } }, { label: { _eq: 'gamma' } }] },
  },
]

test('the two evaluations of a predicate agree', async () => {
  const database = await testDatabase()
  const client = new Client({ connectionString: database.ownerUrl })
  await client.connect()
  await client.query('drop table if exists filter_probe')
  // The column of the text carries the collation of the unicode: the
  // comparison of the database is not the comparison of the bytes, and
  // the compiler has to be the one that decides.
  const collations = await client.query(`select 1 from pg_collation where collname = 'en-x-icu'`)
  const collation = collations.rowCount ? 'en-x-icu' : 'C'
  await client.query(`create table filter_probe (
    id int primary key,
    label text,
    amount bigint,
    flag boolean,
    ref uuid,
    at timestamptz,
    price numeric,
    titled text collate "${collation}",
    payload jsonb
  )`)
  await client.query(FIXTURE)
  const rows = (await client.query('select * from filter_probe order by id')).rows

  for (const predicate of PREDICATES) {
    // The node is built by the parser, the way a caller and a policy
    // build it: the normalizations of the parser are part of the meaning
    // of a predicate.
    const node = parseFilter(predicate.filter, { fields: catalogue, substitutions: true })
    const compiled = compileFilter(node, {
      fields: catalogue,
      startIndex: 1,
      substitutions,
    })
    const answered = await client.query(
      `select id from filter_probe where ${compiled.sql} order by id`,
      [...compiled.params]
    )
    const sqlIds = answered.rows.map((row) => Number(row.id))
    const memoryIds = rows
      .filter((row) => evaluateFilter(node, row, substitutions))
      .map((row) => Number(row.id))
    expect(memoryIds, `the predicate "${predicate.name}" disagrees`).toEqual(sqlIds)
  }

  await client.query('drop table filter_probe')
  await client.end()
})

test('a null value never matches a comparison', () => {
  const row = { label: null, amount: null }
  const context = substitutions
  expect(
    evaluateFilter({ kind: 'cmp', field: 'label', operator: '_neq', value: 'alpha' }, row, context)
  ).toBe(false)
  expect(
    evaluateFilter({ kind: 'cmp', field: 'label', operator: '_eq', value: 'alpha' }, row, context)
  ).toBe(false)
  expect(
    evaluateFilter({ kind: 'cmp', field: 'amount', operator: '_lt', value: 10 }, row, context)
  ).toBe(false)
  expect(
    evaluateFilter(
      { kind: 'cmp', field: 'label', operator: '_nin', values: ['alpha'] },
      row,
      context
    )
  ).toBe(false)
  expect(
    evaluateFilter({ kind: 'cmp', field: 'label', operator: '_is_null', value: true }, row, context)
  ).toBe(true)
})
