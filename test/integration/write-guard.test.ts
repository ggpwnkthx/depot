import { expect, test } from 'bun:test'
import { Client } from 'pg'
import { testDatabase } from '../helpers/database'
import {
  buildCreateGuard,
  buildDeleteGuard,
  buildUpdateGuard,
} from '../../src/domains/records/write-guard'
import { Parameters } from '../../src/domains/records/sql'
import {
  type FilterNode,
  evaluateFilter,
  parseFilter,
} from '../../src/domains/authorization/filter'
import type { CollectionDefinition, FieldDefinition } from '../../src/domains/schema'

/**
 * The two evaluations of the predicate of a write have to agree.
 *
 * The write path used to evaluate the predicates of the policies in
 * memory, over the row that the write had locked, and the read path
 * compiled the same predicates into SQL. The two implementations were
 * one rule that lived in two places, and they diverged three times.
 *
 * The write path now hands the row after the change to the database,
 * and the statement of the write decides. The evaluation in memory
 * stays as the oracle of the check, and this file is the proof that the
 * two answers are the same: it generates the policies that were not
 * written by hand, it writes the rows they are read over, and it
 * compares the two answers of every one of them.
 */

/** The seed of the run. The environment may change it. */
const SEED = Number(process.env.WRITE_GUARD_SEED ?? 20261022)

/** The number of the policies of the run. */
const CASES = Number(process.env.WRITE_GUARD_CASES ?? 60)

/** The number of the rows of the fixture. */
const ROWS = Number(process.env.WRITE_GUARD_ROWS ?? 8)

/** The scope of the fixture. */
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333'
const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_PRINCIPAL_ID = '44444444-4444-4444-8444-444444444444'

/** The substitutions of the run. */
const substitutions = {
  principalId: PRINCIPAL_ID,
  tenantId: TENANT_ID,
  workspaceId: WORKSPACE_ID,
}

/** The catalogue of the probe. It mirrors the collection of the service. */
const catalogue: Record<string, FieldDefinition> = {
  title: { type: 'string', required: true, nullable: false, maxLength: 240 },
  body: { type: 'text', required: false, nullable: true },
  status: {
    type: 'enum',
    required: false,
    nullable: false,
    enum: ['draft', 'review', 'published'],
  },
  category_id: { type: 'uuid', required: false, nullable: true },
  id: { type: 'uuid', required: true, nullable: false },
  created_by: { type: 'uuid', required: true, nullable: false },
  created_at: { type: 'timestamp', required: true, nullable: false },
  updated_by: { type: 'uuid', required: true, nullable: false },
  updated_at: { type: 'timestamp', required: true, nullable: false },
  version: { type: 'integer', required: true, nullable: false, minimum: 1 },
}

/** The collection of the probe. */
const collection: CollectionDefinition = {
  key: 'articles',
  table: 'write_guard_probe',
  label: 'The probe of the guard of a write.',
  fields: {
    title: catalogue.title!,
    body: catalogue.body!,
    status: catalogue.status!,
    category_id: catalogue.category_id!,
  },
  relations: {},
}

/** The values of each type. */
const POOL: Record<string, readonly unknown[]> = {
  string: ['alpha', 'beta', 'hidden', '10', '9', '', ' a', 'ä', '😀'],
  text: ['alpha', 'hidden', '', 'a longer text of the probe'],
  enum: ['draft', 'review', 'published'],
  uuid: [
    'abcdef01-2345-6789-abcd-ef0123456789',
    '55555555-5555-4555-8555-555555555555',
    PRINCIPAL_ID,
    OTHER_PRINCIPAL_ID,
  ],
  timestamp: ['2024-01-01T00:00:00.000Z', '2024-06-01T12:30:00.000Z', '2024-12-31T23:59:59.999Z'],
  integer: [1, 2, 10, 100],
}

/** The operators that each type accepts. */
const OPERATORS: Record<string, readonly string[]> = {
  string: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  text: ['_eq', '_neq', '_in', '_nin', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  enum: ['_eq', '_neq', '_in', '_nin', '_is_null'],
  uuid: ['_eq', '_neq', '_in', '_nin', '_is_null'],
  timestamp: ['_eq', '_neq', '_lt', '_lte', '_gt', '_gte', '_is_null'],
  integer: ['_eq', '_neq', '_lt', '_lte', '_gt', '_gte', '_is_null'],
}

/** The columns of the probe, with the type of the catalogue. */
const COLUMNS: readonly { name: string; type: string }[] = [
  { name: 'title', type: 'string' },
  { name: 'body', type: 'text' },
  { name: 'status', type: 'enum' },
  { name: 'category_id', type: 'uuid' },
  { name: 'id', type: 'uuid' },
  { name: 'created_by', type: 'uuid' },
  { name: 'created_at', type: 'timestamp' },
  { name: 'updated_by', type: 'uuid' },
  { name: 'updated_at', type: 'timestamp' },
  { name: 'version', type: 'integer' },
]

/** A generator of numbers that replays the same run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Picks an element of a list. */
function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

test('the guard of a write and the evaluation in memory agree', async () => {
  const database = await testDatabase()
  const client = new Client({ connectionString: database.ownerUrl })
  await client.connect()
  await client.query('drop table if exists write_guard_probe')
  await client.query(`create table write_guard_probe (
    id uuid primary key,
    tenant_id uuid not null,
    workspace_id uuid not null,
    created_by uuid not null,
    created_at timestamptz not null,
    updated_by uuid not null,
    updated_at timestamptz not null,
    version integer not null,
    title text,
    body text,
    status text,
    category_id uuid
  )`)

  const random = mulberry32(SEED)

  // The rows of the fixture: the values of the pool, and a null on one
  // row in four.
  const identifiers: string[] = []
  for (let index = 0; index < ROWS; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    identifiers.push(id)
    const values: Record<string, unknown> = {}
    for (const column of COLUMNS) {
      values[column.name] = random() < 0.25 ? null : pick(random, POOL[column.type]!)
    }
    await client.query(
      `insert into write_guard_probe
       (id, tenant_id, workspace_id, created_by, created_at, updated_by, updated_at, version, title, body, status, category_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        TENANT_ID,
        WORKSPACE_ID,
        random() < 0.5 ? PRINCIPAL_ID : OTHER_PRINCIPAL_ID,
        pick(random, POOL.timestamp!),
        random() < 0.5 ? PRINCIPAL_ID : OTHER_PRINCIPAL_ID,
        pick(random, POOL.timestamp!),
        1,
        values.title ?? 'alpha',
        values.body ?? null,
        values.status ?? 'draft',
        values.category_id ?? null,
      ]
    )
  }
  const rows = (await client.query('select * from write_guard_probe order by id')).rows as Record<
    string,
    unknown
  >[]

  const divergences: string[] = []
  let checked = 0

  for (let index = 0; index < CASES; index += 1) {
    const where = parseFilter(randomFilter(random, 1), { fields: catalogue, substitutions: true })
    const check = parseFilter(randomFilter(random, 1), { fields: catalogue, substitutions: true })
    const policy = {
      id: `policy-${index}`,
      permission: 'content.editor',
      collection: 'articles',
      action: 'update' as const,
      where,
      check,
      fields: ['title', 'body', 'status'],
    }
    const written = { title: pick(random, POOL.string!) }

    for (const row of rows) {
      const now = '2026-10-22T00:00:00.000Z'
      // The row after the change: the fields the client writes, the
      // fields the server maintains and the fields the row already had.
      const post = {
        ...row,
        ...written,
        updated_by: PRINCIPAL_ID,
        updated_at: now,
        version: Number(row.version) + 1,
      }
      const memory =
        evaluateFilter(where, row, substitutions) && evaluateFilter(check, post, substitutions)

      await client.query('begin')
      const statement = await updateStatement(policy, written, now, String(row.id))
      const answer = await client.query(statement.sql, [...statement.parameters])
      await client.query('rollback')
      const databaseAnswer = (answer.rowCount ?? 0) > 0
      checked += 1
      if (databaseAnswer !== memory) {
        divergences.push(
          `the policy ${index} disagrees on the row ${String(row.id)}: ` +
            `the memory says ${String(memory)} and the statement says ${String(databaseAnswer)}. ` +
            `the predicate of where is ${JSON.stringify(where)} and the one of check is ${JSON.stringify(check)}`
        )
        if (divergences.length >= 10) break
      }
    }
    if (divergences.length >= 10) break
  }

  // The creation and the deletion use the same rules.
  for (let index = 0; index < CASES; index += 1) {
    const where = parseFilter(randomFilter(random, 1), { fields: catalogue, substitutions: true })
    const check = parseFilter(randomFilter(random, 1), { fields: catalogue, substitutions: true })
    const now = '2026-10-22T00:00:00.000Z'
    const values = { title: pick(random, POOL.string!), body: pick(random, POOL.text!) }
    const id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`

    const post = {
      id,
      tenant_id: TENANT_ID,
      workspace_id: WORKSPACE_ID,
      created_by: PRINCIPAL_ID,
      created_at: now,
      updated_by: PRINCIPAL_ID,
      updated_at: now,
      version: 1,
      ...values,
    }
    const memory = evaluateFilter(check, post, substitutions)

    await client.query('begin')
    const parameters = new Parameters()
    const guard = buildCreateGuard({
      collection,
      catalogue,
      policies: [
        {
          id: `create-${index}`,
          permission: 'content.editor',
          collection: 'articles',
          action: 'create',
          where,
          check,
          fields: ['title', 'body', 'status'],
        },
      ],
      substitutions,
      parameters,
      values,
      id,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      now,
    })
    const columns = guard.columns.map((name) => `"${name}"`).join(', ')
    const selection = guard.columns.map((name) => `post."${name}"`).join(', ')
    const answer = await client.query(
      `${guard.prefix}insert into write_guard_probe (${columns}) select ${selection} from post where (${guard.guard})`,
      parameters.values
    )
    await client.query('rollback')
    const databaseAnswer = (answer.rowCount ?? 0) > 0
    checked += 1
    if (databaseAnswer !== memory) {
      divergences.push(
        `the creation ${index} disagrees: the memory says ${String(memory)} and the statement says ${String(databaseAnswer)}. ` +
          `the predicate of check is ${JSON.stringify(check)}`
      )
      if (divergences.length >= 10) break
    }
  }

  for (let index = 0; index < CASES; index += 1) {
    const where = parseFilter(randomFilter(random, 1), { fields: catalogue, substitutions: true })
    for (const row of rows) {
      const memory = evaluateFilter(where, row, substitutions)
      await client.query('begin')
      const parameters = new Parameters()
      const scopeId = parameters.add(String(row.id), 'uuid')
      const scopeTenant = parameters.add(TENANT_ID, 'uuid')
      const scopeWorkspace = parameters.add(WORKSPACE_ID, 'uuid')
      const scopeClause = `t."id" = ${scopeId} and t."tenant_id" = ${scopeTenant} and t."workspace_id" = ${scopeWorkspace}`
      const guard = buildDeleteGuard({
        collection,
        catalogue,
        policies: [
          {
            id: `delete-${index}`,
            permission: 'content.editor',
            collection: 'articles',
            action: 'delete',
            where,
            check: { kind: 'all' },
            fields: [],
          },
        ],
        substitutions,
        parameters,
        scopeClause,
      })
      const answer = await client.query(
        `delete from write_guard_probe as t
       where t."id" = ${scopeId}
         and t."tenant_id" = ${scopeTenant}
         and t."workspace_id" = ${scopeWorkspace}
         and (${guard.guard})`,
        parameters.values
      )
      await client.query('rollback')
      const databaseAnswer = (answer.rowCount ?? 0) > 0
      checked += 1
      if (databaseAnswer !== memory) {
        divergences.push(
          `the deletion ${index} disagrees on the row ${String(row.id)}: ` +
            `the memory says ${String(memory)} and the statement says ${String(databaseAnswer)}. ` +
            `the predicate of where is ${JSON.stringify(where)}`
        )
        if (divergences.length >= 10) break
      }
    }
    if (divergences.length >= 10) break
  }

  await client.query('drop table write_guard_probe')
  await client.end()

  expect(
    divergences,
    `the two evaluations disagree. the seed is ${SEED}; replay it with WRITE_GUARD_SEED=${SEED}`
  ).toEqual([])
  expect(checked).toBeGreaterThan(0)
}, 180_000)

/** Builds the statement of an update, with its guard. */
async function updateStatement(
  policy: {
    id: string
    permission: string
    collection: string
    action: 'update'
    where: FilterNode
    check: FilterNode
    fields: readonly string[]
  },
  written: Record<string, unknown>,
  now: string,
  id: string
): Promise<{ sql: string; parameters: readonly unknown[] }> {
  const parameters = new Parameters()
  const scopeId = parameters.add(id, 'uuid')
  const scopeTenant = parameters.add(TENANT_ID, 'uuid')
  const scopeWorkspace = parameters.add(WORKSPACE_ID, 'uuid')
  const scopeClause = `t."id" = ${scopeId} and t."tenant_id" = ${scopeTenant} and t."workspace_id" = ${scopeWorkspace}`
  const guard = buildUpdateGuard({
    collection,
    catalogue,
    policies: [policy],
    substitutions,
    parameters,
    written,
    principalId: PRINCIPAL_ID,
    now,
    scopeClause,
  })
  const assignments = Object.keys(written).map((name) => `"${name}" = ${guard.placeholders[name]}`)
  assignments.push(`"updated_by" = ${guard.placeholders.updated_by}`)
  assignments.push(`"updated_at" = ${guard.placeholders.updated_at}`)
  assignments.push('"version" = "version" + 1')
  return {
    sql: `${guard.prefix}update write_guard_probe set ${assignments.join(', ')}
       where "id" = ${scopeId}
         and "tenant_id" = ${scopeTenant}
         and "workspace_id" = ${scopeWorkspace}
         and exists (select 1 from ${guard.sources} where (${guard.guard}))`,
    parameters: parameters.values,
  }
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
