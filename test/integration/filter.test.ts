import { expect, test } from 'bun:test'
import { Client } from 'pg'
import { testDatabase } from '../helpers/database'
import {
  type FilterNode,
  compileFilter,
  evaluateFilter,
} from '../../src/domains/authorization/filter'
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
}

const substitutions = {
  principalId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
}

/** The rows of the fixture: every column is null on one row. */
const FIXTURE = `
  insert into filter_probe values
    (1, 'alpha', 10, true,  '44444444-4444-4444-8444-444444444444', '2024-01-01T00:00:00.000Z', '10.50'),
    (2, 'beta',  20, false, '55555555-5555-4555-8555-555555555555', '2024-06-01T12:30:00.000Z', '20.25'),
    (3, null,   null, null, null, null, null),
    (4, 'gamma', null, true, null, null, '0.10')
`

/** The predicates the two evaluations have to agree on. */
const PREDICATES: readonly { name: string; node: FilterNode }[] = [
  { name: 'eq', node: { kind: 'cmp', field: 'label', operator: '_eq', value: 'alpha' } },
  { name: 'neq', node: { kind: 'cmp', field: 'label', operator: '_neq', value: 'alpha' } },
  { name: 'lt', node: { kind: 'cmp', field: 'amount', operator: '_lt', value: 20 } },
  { name: 'lte', node: { kind: 'cmp', field: 'amount', operator: '_lte', value: 20 } },
  { name: 'gt', node: { kind: 'cmp', field: 'amount', operator: '_gt', value: 10 } },
  { name: 'gte', node: { kind: 'cmp', field: 'amount', operator: '_gte', value: 20 } },
  {
    name: 'in',
    node: { kind: 'cmp', field: 'label', operator: '_in', values: ['alpha', 'gamma'] },
  },
  { name: 'nin', node: { kind: 'cmp', field: 'label', operator: '_nin', values: ['alpha'] } },
  {
    name: 'is_null_true',
    node: { kind: 'cmp', field: 'label', operator: '_is_null', value: true },
  },
  {
    name: 'is_null_false',
    node: { kind: 'cmp', field: 'label', operator: '_is_null', value: false },
  },
  {
    name: 'and_of_two',
    node: {
      kind: 'and',
      nodes: [
        { kind: 'cmp', field: 'label', operator: '_neq', value: 'alpha' },
        { kind: 'cmp', field: 'flag', operator: '_eq', value: true },
      ],
    },
  },
  {
    name: 'or_of_two',
    node: {
      kind: 'or',
      nodes: [
        { kind: 'cmp', field: 'label', operator: '_eq', value: 'beta' },
        { kind: 'cmp', field: 'label', operator: '_is_null', value: true },
      ],
    },
  },
  {
    name: 'the_substitution',
    node: {
      kind: 'cmp',
      field: 'ref',
      operator: '_eq',
      value: '$principalId',
    },
  },
  {
    name: 'a_decimal',
    node: { kind: 'cmp', field: 'price', operator: '_lt', value: '10.50' },
  },
  {
    name: 'a_timestamp',
    node: { kind: 'cmp', field: 'at', operator: '_gte', value: '2024-06-01T12:30:00.000Z' },
  },
]

test('the two evaluations of a predicate agree', async () => {
  const database = await testDatabase()
  const client = new Client({ connectionString: database.ownerUrl })
  await client.connect()
  await client.query('drop table if exists filter_probe')
  await client.query(`create table filter_probe (
    id int primary key,
    label text,
    amount bigint,
    flag boolean,
    ref uuid,
    at timestamptz,
    price numeric
  )`)
  await client.query(FIXTURE)
  const rows = (await client.query('select * from filter_probe order by id')).rows

  for (const predicate of PREDICATES) {
    const compiled = compileFilter(predicate.node, {
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
      .filter((row) => evaluateFilter(predicate.node, row, substitutions))
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
