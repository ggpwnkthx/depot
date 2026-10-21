import { expect, test } from 'bun:test'
import { Client } from 'pg'
import { testDatabase } from '../helpers/database'
import {
  compileFilter,
  evaluateFilter,
  type FilterNode,
  parseFilter,
} from '../../src/domains/authorization/filter'
import type { FieldDefinition } from '../../src/domains/schema'

/**
 * The two evaluations of a predicate have to agree, on every predicate.
 *
 * The file `filter.test.ts` holds the predicates that were thought of.
 * This file holds the predicates that were not: it generates them, it
 * generates the rows they are read over, and it compares the two
 * answers of every one of them.
 *
 * The reason is the history of the module: three divergences were found
 * and fixed in three commits, and the list of the written predicates did
 * not find them. A list is a sample, and a sample of a contract is not
 * a proof of it. The generator turns the contract into something the CI
 * can check.
 *
 * The generator is deterministic: the seed is printed with a failure,
 * and the same seed replays the same predicates.
 */

/** The seed of the run. The environment may change it. */
const SEED = Number(process.env.FILTER_PROPERTY_SEED ?? 20261021)

/** The number of the rows of the fixture. */
const ROWS = Number(process.env.FILTER_PROPERTY_ROWS ?? 24)

/** The number of the predicates of the run. */
const CASES = Number(process.env.FILTER_PROPERTY_CASES ?? 400)

/** The catalogue of the probe. It mirrors the types of the service. */
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

/** The substitutions of the run. */
const substitutions = {
  principalId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
}

/**
 * The values of each type.
 *
 * The pool holds the values that are ordinary and the values that are
 * awkward: the case, the space, the text that looks like a number, the
 * character that is outside the plane of the basic multilingual one,
 * the instant that is written in two zones, and the json whose keys are
 * in another order. Those are the values that the two evaluations tend
 * to disagree about.
 */
const POOL: Record<string, readonly unknown[]> = {
  string: [
    'alpha',
    'beta',
    'gamma',
    'Zebra',
    'apple',
    'ALPHA',
    'Alpha',
    '10',
    '9',
    '10.50',
    '-1',
    '',
    ' a',
    'a ',
    'a b',
    'ä',
    'é',
    '😀',
    '�',
    '🐟',
  ],
  integer: [0, 1, 9, 10, 20, -1, 100, 1000000],
  boolean: [true, false],
  uuid: [
    'abcdef01-2345-6789-abcd-ef0123456789',
    '55555555-5555-4555-8555-555555555555',
    '11111111-1111-4111-8111-111111111111',
    'ABCDEF01-2345-6789-ABCD-EF0123456789',
  ],
  timestamp: [
    '2024-01-01T00:00:00.000Z',
    '2024-06-01T12:30:00.000Z',
    '2024-06-01T14:30:00.000+02:00',
    '2024-06-01T00:00:00.000-12:30',
    '2024-12-31T23:59:59.999Z',
  ],
  decimal: ['0', '0.10', '10.50', '20.25', '-5.00', '100', '0.0000001'],
  json: [{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1 }, [1, 2], ['a', 'b'], { ä: '😀' }],
}

/** The operators that each type accepts. */
const OPERATORS: Record<string, readonly string[]> = {
  string: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  integer: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  boolean: ['_eq', '_neq', '_is_null'],
  uuid: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  timestamp: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  decimal: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  json: ['_eq', '_neq', '_is_null'],
}

/** The columns of the probe, with the type of the catalogue. */
const COLUMNS: readonly { name: string; type: string; sql: string }[] = [
  { name: 'label', type: 'string', sql: 'text' },
  { name: 'amount', type: 'integer', sql: 'bigint' },
  { name: 'flag', type: 'boolean', sql: 'boolean' },
  { name: 'ref', type: 'uuid', sql: 'uuid' },
  { name: 'at', type: 'timestamp', sql: 'timestamptz' },
  { name: 'price', type: 'decimal', sql: 'numeric' },
  { name: 'titled', type: 'string', sql: 'text' },
  { name: 'payload', type: 'json', sql: 'jsonb' },
]

/** A generator of numbers that replays the same run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Picks an element of a list. */
function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

/** The rows of the fixture. */
interface Fixture {
  readonly id: number
  readonly values: Record<string, unknown>
}

test('the two evaluations of a predicate agree on every generated predicate', async () => {
  const database = await testDatabase()
  const client = new Client({ connectionString: database.ownerUrl })
  await client.connect()
  await client.query('drop table if exists filter_property_probe')
  const collations = await client.query(`select 1 from pg_collation where collname = 'en-x-icu'`)
  const collation = collations.rowCount ? 'en-x-icu' : 'C'
  await client.query(`create table filter_property_probe (
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

  const random = mulberry32(SEED)

  // The rows: the values of the pool, and a null on one row in four.
  const fixtures: Fixture[] = []
  for (let index = 0; index < ROWS; index += 1) {
    const values: Record<string, unknown> = {}
    for (const column of COLUMNS) {
      values[column.name] = random() < 0.25 ? null : pick(random, POOL[column.type]!)
    }
    fixtures.push({ id: index + 1, values })
  }
  for (const fixture of fixtures) {
    await client.query(
      `insert into filter_property_probe (id, label, amount, flag, ref, at, price, titled, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        fixture.id,
        fixture.values.label,
        fixture.values.amount,
        fixture.values.flag,
        fixture.values.ref,
        fixture.values.at,
        fixture.values.price,
        fixture.values.titled,
        fixture.values.payload === null || fixture.values.payload === undefined
          ? null
          : JSON.stringify(fixture.values.payload),
      ]
    )
  }
  const rows = (await client.query('select * from filter_property_probe order by id')).rows

  // The predicates: a random tree of comparisons, conjunctions,
  // disjunctions and negations.
  const divergences: string[] = []
  let checked = 0
  for (let index = 0; index < CASES; index += 1) {
    const filter = randomFilter(random, 1)
    let node: FilterNode
    try {
      node = parseFilter(filter, { fields: catalogue, substitutions: true })
    } catch (error) {
      divergences.push(
        `the generated filter was refused: ${JSON.stringify(filter)} (${String(error)})`
      )
      continue
    }
    const compiled = compileFilter(node, { fields: catalogue, startIndex: 1, substitutions })
    const answered = await client.query(
      `select id from filter_property_probe where ${compiled.sql} order by id`,
      [...compiled.params]
    )
    const sqlIds = answered.rows.map((row) => Number(row.id))
    const memoryIds = rows
      .filter((row) => evaluateFilter(node, row, substitutions))
      .map((row) => Number(row.id))
    checked += 1
    if (sqlIds.join(',') !== memoryIds.join(',')) {
      divergences.push(describe(filter, rows, sqlIds, memoryIds))
      if (divergences.length >= 10) break
    }
  }

  await client.query('drop table filter_property_probe')
  await client.end()

  expect(
    divergences,
    `the two evaluations disagree. the seed is ${SEED}; replay it with FILTER_PROPERTY_SEED=${SEED}`
  ).toEqual([])
  expect(checked).toBeGreaterThan(0)
})

/** Describes a divergence, with the rows that the two answers separate. */
function describe(
  filter: unknown,
  rows: readonly Record<string, unknown>[],
  sqlIds: readonly number[],
  memoryIds: readonly number[]
): string {
  const only = sqlIds.filter((id) => !memoryIds.includes(id))
  const missing = memoryIds.filter((id) => !sqlIds.includes(id))
  const rowsOf = (ids: readonly number[]): string =>
    ids
      .map((id) => {
        const row = rows.find((entry) => Number(entry.id) === id)
        return `      ${JSON.stringify(row)}`
      })
      .join('\n')
  return [
    `the filter ${JSON.stringify(filter)}`,
    `  the statement matched [${sqlIds.join(', ')}] and the memory matched [${memoryIds.join(', ')}]`,
    `  only the statement matched:`,
    rowsOf(only),
    `  only the memory matched:`,
    rowsOf(missing),
  ].join('\n')
}

/**
 * Generates a random filter.
 *
 * The depth is bounded by the grammar of the service: the generator
 * never builds a filter that the parser would refuse for its depth.
 */
function randomFilter(random: () => number, depth: number): unknown {
  const roll = random()
  if (depth < 4 && roll < 0.18) {
    const branches = 2 + Math.floor(random() * 2)
    const children = Array.from({ length: branches }, () => randomFilter(random, depth + 1))
    return roll < 0.09
      ? { _not: randomFilter(random, depth + 1) }
      : { [random() < 0.5 ? '_and' : '_or']: children }
  }
  if (depth < 4 && roll < 0.24) {
    return { _not: randomFilter(random, depth + 1) }
  }
  const column = pick(random, COLUMNS)
  const operator = pick(random, OPERATORS[column.type]!)
  if (operator === '_is_null') {
    return { [column.name]: { _is_null: random() < 0.5 } }
  }
  if (operator === '_in' || operator === '_nin') {
    const count = 1 + Math.floor(random() * 3)
    const values = Array.from({ length: count }, () => pick(random, POOL[column.type]!))
    return { [column.name]: { [operator]: values } }
  }
  return { [column.name]: { [operator]: pick(random, POOL[column.type]!) } }
}
