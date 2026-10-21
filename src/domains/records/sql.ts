/**
 * The statements of the records domain.
 *
 * The module builds the statements of the service. Every identifier comes
 * from the manifest of the deployment and every value is a bound
 * parameter, so a caller never chooses a fragment of SQL.
 *
 * The projection of a read is built so that a value the caller may not
 * see never leaves the database: a field is added to the payload of a row
 * only when a policy that matched that row grants it.
 */

import {
  type FilterNode,
  type Policy,
  type SubstitutionContext,
  compileFilter,
  quoteIdentifier,
} from '../authorization'
import type { CollectionDefinition, FieldDefinition } from '../schema'

/** The server maintained fields a caller may see. */
export const EXPOSED_SERVER_FIELDS = [
  'id',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
  'version',
] as const

/** The definition of a server maintained field. */
export function serverFieldDefinition(name: string): FieldDefinition {
  switch (name) {
    case 'created_at':
    case 'updated_at':
      return { type: 'timestamp', required: true, nullable: false }
    case 'version':
      return { type: 'integer', required: true, nullable: false, minimum: 1 }
    default:
      return { type: 'uuid', required: true, nullable: false }
  }
}

/**
 * The fields a query of a collection may use.
 *
 * The scope columns are internal: they are never exposed and they are
 * never part of a query of a caller.
 */
export function catalogueFor(collection: CollectionDefinition): Record<string, FieldDefinition> {
  const catalogue: Record<string, FieldDefinition> = {}
  for (const [name, definition] of Object.entries(collection.fields)) catalogue[name] = definition
  for (const name of EXPOSED_SERVER_FIELDS) catalogue[name] = serverFieldDefinition(name)
  return catalogue
}

/** The parameters of a statement, in the order of their placeholders. */
export class Parameters {
  readonly values: unknown[] = []

  /** Binds a value and returns its placeholder. */
  add(value: unknown, type?: string): string {
    this.values.push(value)
    const placeholder = `$${this.values.length}`
    return type && type !== 'text' ? `${placeholder}::${type}` : placeholder
  }

  /** The number of the next placeholder. */
  get next(): number {
    return this.values.length + 1
  }
}

/**
 * Compiles a filter into the parameters of a statement.
 *
 * The values of the filter are bound: they never become a part of the
 * statement.
 */
export function compileInto(
  node: FilterNode,
  parameters: Parameters,
  options: {
    fields: Record<string, FieldDefinition>
    alias?: string
    substitutions?: SubstitutionContext
  }
): string {
  const compiled = compileFilter(node, {
    fields: options.fields,
    ...(options.alias ? { alias: options.alias } : {}),
    startIndex: parameters.next,
    ...(options.substitutions ? { substitutions: options.substitutions } : {}),
  })
  parameters.values.push(...compiled.params)
  return compiled.sql
}

/** The expression that reads a field into a json payload. */
export function jsonExpression(field: string, definition: FieldDefinition): string {
  const column = quoteIdentifier(field)
  switch (definition.type) {
    case 'decimal':
      return `${column}::text`
    case 'timestamp':
      return `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    case 'json':
      return `${column}::jsonb`
    default:
      return column
  }
}

/** One column of a sort. */
export interface SortColumn {
  readonly field: string
  readonly descending: boolean
}

/**
 * The order of a statement.
 *
 * The order is written with the rank of the null values first, so the
 * position of a page is a tuple of comparable values: the nulls are the
 * last ones in both directions.
 */
export function orderBy(columns: readonly SortColumn[], alias = 't'): string {
  return columns
    .map(
      (column, _index) =>
        `(${quoteIdentifier(alias)}.${quoteIdentifier(column.field)} is null)::int asc, ${quoteIdentifier(alias)}.${quoteIdentifier(column.field)} ${column.descending ? 'desc' : 'asc'}`
    )
    .join(', ')
}

/** The columns of a sort, with their rank of the null values. */
export function sortColumns(columns: readonly SortColumn[], alias = 't'): string {
  return columns
    .flatMap((column, index) => [
      `(${quoteIdentifier(alias)}.${quoteIdentifier(column.field)} is null)::int as n${index}`,
      `${quoteIdentifier(alias)}.${quoteIdentifier(column.field)} as s${index}`,
    ])
    .join(', ')
}

/**
 * The condition that continues after a position.
 *
 * The comparison is a tuple comparison, written out: the values of the
 * columns are compared one after the other, and the first difference
 * decides.
 */
export function keysetCondition(
  columns: readonly SortColumn[],
  position: readonly unknown[],
  parameters: Parameters,
  alias = 't'
): string {
  const parts: string[] = []
  const equalities: string[] = []
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index]!
    const reference = `${quoteIdentifier(alias)}.${quoteIdentifier(column.field)}`
    const nullRank = position[index * 2]
    const value = position[index * 2 + 1]
    const rank = `(${reference} is null)::int`
    const sameRank = `${rank} = ${parameters.add(nullRank)}`
    const greaterRank = `${rank} > ${parameters.add(nullRank)}`
    const sameValue = `${reference} is not distinct from ${parameters.add(value)}`
    const comparison =
      value === null || value === undefined
        ? 'false'
        : `${reference} ${column.descending ? '<' : '>'} ${parameters.add(value)}`
    const prefix = equalities.length === 0 ? '' : `${equalities.join(' and ')} and `
    parts.push(`(${prefix}(${greaterRank} or (${sameRank} and ${comparison})))`)
    equalities.push(`${sameRank}`, `${sameValue}`)
  }
  if (parts.length === 0) return 'false'
  return `(${parts.join(' or ')})`
}

/**
 * The predicate of the rows of a collection.
 *
 * The predicate is the disjunction of the predicates of the read
 * policies: a row is visible when at least one policy covers it.
 */
export function rowPredicate(
  policies: readonly Policy[],
  parameters: Parameters,
  fields: Record<string, FieldDefinition>,
  substitutions: SubstitutionContext
): string {
  if (policies.length === 0) return 'false'
  const parts = policies.map((policy) =>
    compileInto(policy.where, parameters, { fields, alias: 't', substitutions })
  )
  return `(${parts.join(' or ')})`
}
