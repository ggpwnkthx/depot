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

/**
 * The expression that reads a field into a json payload.
 *
 * The alias is the table of the field, when the expression is used in a
 * statement that reads more than one table.
 */
export function jsonExpression(field: string, definition: FieldDefinition, alias?: string): string {
  const column = alias
    ? `${quoteIdentifier(alias)}.${quoteIdentifier(field)}`
    : quoteIdentifier(field)
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
/**
 * The order of a page, in the form of the database.
 *
 * The order of the service is the order of the nulls last, in the two
 * directions. The database writes it as `col asc nulls last`, and the
 * order it writes is the order of an index: a deployment that declares
 * an index on the field of the sort sees the database read the page
 * with that index and without a sort.
 *
 * The form of the service, `((col is null))::int asc, col asc`, is the
 * same order — the nulls are last in the two forms — but the database
 * does not recognise it as the order of an index, and it reads the
 * whole scope and sorts it for every page.
 */
export function orderBy(columns: readonly SortColumn[], alias = 't'): string {
  return columns
    .map(
      (column) =>
        `${quoteIdentifier(alias)}.${quoteIdentifier(column.field)} ${column.descending ? 'desc' : 'asc'} nulls last`
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
 *
 * The equality of a value is the prefix of the column that follows it,
 * and it is bound only when there is a column that follows it: a
 * parameter that the statement does not reference is refused by the
 * database, and the second page of every collection would fail.
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
    const comparison =
      value === null || value === undefined
        ? 'false'
        : `${reference} ${column.descending ? '<' : '>'} ${parameters.add(value)}`
    const prefix = equalities.length === 0 ? '' : `${equalities.join(' and ')} and `
    parts.push(`(${prefix}(${greaterRank} or (${sameRank} and ${comparison})))`)
    if (index + 1 < columns.length) {
      equalities.push(`${sameRank}`, `${reference} is not distinct from ${parameters.add(value)}`)
    }
  }
  if (parts.length === 0) return 'false'
  return `(${parts.join(' or ')})`
}

/**
 * Builds the clause of a search.
 *
 * The search is a text search of the database over the fields that the
 * deployment declared searchable. The configuration is a part of the
 * deployment and it is written in the statement: the pattern of the
 * manifest keeps it a plain name, and the values of the search are
 * bound parameters.
 *
 * The search is never evaluated in memory: it belongs to the queries of
 * the callers and not to the predicates of the policies, and the write
 * path never reads it.
 */
export function searchClause(
  collection: CollectionDefinition,
  parameters: Parameters,
  text: string,
  alias = 't'
): string | null {
  const search = collection.search
  if (!search || search.fields.length === 0) return null
  // The configuration is casted explicitly: the index of the search
  // holds the expression with the cast, and the database only uses the
  // index when the two expressions are the same.
  const config = `'${search.config}'::regconfig`
  const vectors = search.fields.map((field) => {
    const column = `${quoteIdentifier(alias)}.${quoteIdentifier(field)}`
    return `to_tsvector(${config}, coalesce(${column}, ''))`
  })
  const query = parameters.add(text)
  return `(${vectors.join(' || ')}) @@ plainto_tsquery(${config}, ${query})`
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

/** One metric of an aggregate, as the statement builder reads it. */
export interface AggregateMetricColumn {
  /** The function of the metric. */
  readonly function: 'sum' | 'avg' | 'min' | 'max'
  /** The field the metric reads. */
  readonly field: string
}

/** The options of the statement of an aggregate. */
export interface AggregateStatement {
  readonly table: string
  readonly scopeClause: string
  readonly predicate: string
  readonly filterClause: string
  /** The fields the rows are grouped by. */
  readonly groupBy: readonly string[]
  /** The metrics of every group. */
  readonly metrics: readonly AggregateMetricColumn[]
  readonly catalogue: Record<string, FieldDefinition>
  readonly parameters: Parameters
  /** The maximum number of groups, plus the one that detects the truncation. */
  readonly limit: number
}

/**
 * Builds the statement of an aggregate.
 *
 * The statement is the statement of a list with a `group by`: the same
 * scope, the same predicate of the policies and the same filter of the
 * caller. An aggregate is not a privileged query path: it reads the rows
 * that a list would read, and nothing else.
 *
 * The groups are ordered by the fields of the group, so the answer is
 * stable and a caller may page it.
 */
export function buildAggregate(options: AggregateStatement): string {
  const alias = 't'
  const groupColumns = options.groupBy.map(
    (field) => `${quoteIdentifier(alias)}.${quoteIdentifier(field)}`
  )
  const groupSelections = options.groupBy.map((field, index) => {
    const definition = options.catalogue[field]
    return `${jsonExpression(field, definition ?? serverFieldDefinition(field))} as ${quoteIdentifier(`g${index}`)}`
  })
  const metricSelections = options.metrics.map((metric) => {
    const column = `${quoteIdentifier(alias)}.${quoteIdentifier(metric.field)}`
    const name = quoteIdentifier(`${metric.function}:${metric.field}`)
    switch (metric.function) {
      case 'sum':
        // The sum of an integer is a decimal: the sum of a big integer
        // does not fit in a big integer.
        return `sum(${column})::text as ${name}`
      case 'avg':
        return `avg(${column})::text as ${name}`
      case 'min':
        return `min(${column}) as ${name}`
      case 'max':
        return `max(${column}) as ${name}`
      default:
        throw new Error('the function of the metric is not known')
    }
  })
  const selection = [
    ...groupSelections,
    `count(*)::text as ${quoteIdentifier('count')}`,
    ...metricSelections,
  ].join(', ')
  const group = groupColumns.length > 0 ? `group by ${groupColumns.join(', ')}` : ''
  const order = groupColumns.length > 0 ? `order by ${groupColumns.join(', ')}` : ''
  return `select ${selection} from ${options.table} ${alias} where ${options.scopeClause} and (${options.predicate}) and (${options.filterClause}) ${group} ${order} limit ${options.limit}`
}
