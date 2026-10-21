/**
 * The filter grammar of the service (spec §9.3).
 *
 * A filter is a small, closed expression: a set of predicates over the
 * fields of a collection. It is used by the queries of the callers and by
 * the predicates of the policies, and it is never compiled from a string
 * the caller wrote: a filter is a value, and the values of a filter are
 * bound parameters of the statement it produces.
 *
 * The module owns the grammar, the validation of the operators against
 * the types of the fields and the two ways of reading a filter: as SQL
 * and as a predicate over a row that is already in memory.
 */

import type { FieldDefinition } from '../schema'

/** The operators of a predicate. */
export const FILTER_OPERATORS = [
  '_eq',
  '_neq',
  '_in',
  '_nin',
  '_lt',
  '_lte',
  '_gt',
  '_gte',
  '_is_null',
] as const

/** The operator of a predicate. */
export type FilterOperator = (typeof FILTER_OPERATORS)[number]

/** The maximum depth of a filter. */
export const MAX_FILTER_DEPTH = 5

/** The maximum number of leaf predicates of a filter. */
export const MAX_FILTER_LEAVES = 50

/** The maximum number of values of `_in` and `_nin`. */
export const MAX_FILTER_VALUES = 100

/** The names of the server substitutions. */
export const SUBSTITUTIONS = ['$principalId', '$tenantId', '$workspaceId'] as const

/** The name of a server substitution. */
export type SubstitutionName = (typeof SUBSTITUTIONS)[number]

/** The values the substitutions are replaced with. */
export interface SubstitutionContext {
  readonly principalId: string
  readonly tenantId: string
  readonly workspaceId: string
}

/** A node of a parsed filter. */
export type FilterNode =
  | { readonly kind: 'all' }
  | { readonly kind: 'and'; readonly nodes: readonly FilterNode[] }
  | { readonly kind: 'or'; readonly nodes: readonly FilterNode[] }
  | {
      readonly kind: 'cmp'
      readonly field: string
      readonly operator: FilterOperator
      readonly value?: unknown
      readonly values?: readonly unknown[]
    }

/** The problem of a filter that cannot be used. */
export class FilterError extends Error {
  override readonly name = 'FilterError'
  /** The field the problem is about, when there is one. */
  readonly field?: string
  /** The machine readable reason of the problem. */
  readonly code: string

  constructor(message: string, code = 'INVALID_FILTER', field?: string) {
    super(message)
    this.code = code
    this.field = field
  }
}

/** The fields a filter may use, with their types. */
export type FieldCatalogue = Readonly<Record<string, FieldDefinition>>

/** The options of the parser. */
export interface FilterParseOptions {
  /** The fields a filter may use. */
  readonly fields: FieldCatalogue
  /** True when the server substitutions are recognized. */
  readonly substitutions?: boolean
}

/** Reports whether a value is an object and not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The operators that compare an order. */
const ORDERING_OPERATORS: ReadonlySet<string> = new Set(['_lt', '_lte', '_gt', '_gte'])

/** The operators that take a list of values. */
const LIST_OPERATORS: ReadonlySet<string> = new Set(['_in', '_nin'])

/**
 * Validates the value of a predicate against the type of its field.
 *
 * The type is checked here and nowhere else: a statement never receives
 * an operand of the wrong type, so the comparison of the database is
 * never a conversion that hides a mistake of the caller.
 */
export function validateOperand(
  field: string,
  definition: FieldDefinition,
  operator: FilterOperator,
  value: unknown,
  options: { substitutions?: boolean } = {}
): void {
  if (operator === '_is_null') {
    if (typeof value !== 'boolean') {
      throw new FilterError(
        `the operator _is_null of "${field}" takes a boolean`,
        'INVALID_OPERATOR',
        field
      )
    }
    return
  }
  if (value === null) {
    throw new FilterError(
      `the operator ${operator} of "${field}" does not accept null`,
      'NULL_OPERAND',
      field
    )
  }
  // A server substitution is a typed value of the server: it is checked
  // when it is replaced, and not here.
  if (
    options.substitutions &&
    typeof value === 'string' &&
    (SUBSTITUTIONS as readonly string[]).includes(value)
  ) {
    return
  }
  if (ORDERING_OPERATORS.has(operator)) {
    if (
      !['string', 'text', 'integer', 'decimal', 'uuid', 'timestamp', 'enum'].includes(
        definition.type
      )
    ) {
      throw new FilterError(
        `the operator ${operator} is not defined for the type "${definition.type}"`,
        'INVALID_OPERATOR',
        field
      )
    }
  }
  switch (definition.type) {
    case 'string':
    case 'text':
      if (typeof value !== 'string') {
        throw new FilterError(`the field "${field}" is a string`, 'TYPE_MISMATCH', field)
      }
      if (definition.maxLength !== undefined && [...value].length > definition.maxLength) {
        throw new FilterError(`the field "${field}" is too long`, 'MAX_LENGTH', field)
      }
      break
    case 'enum':
      if (typeof value !== 'string') {
        throw new FilterError(`the field "${field}" is a string`, 'TYPE_MISMATCH', field)
      }
      if (definition.enum && !definition.enum.includes(value)) {
        throw new FilterError(
          `the field "${field}" does not hold that value`,
          'INVALID_ENUM',
          field
        )
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new FilterError(`the field "${field}" is a boolean`, 'TYPE_MISMATCH', field)
      }
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new FilterError(`the field "${field}" is an integer`, 'TYPE_MISMATCH', field)
      }
      break
    case 'decimal':
      if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) {
        throw new FilterError(
          `the field "${field}" is a decimal written as a string`,
          'TYPE_MISMATCH',
          field
        )
      }
      break
    case 'uuid':
      if (typeof value !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(value)) {
        throw new FilterError(`the field "${field}" is a uuid`, 'TYPE_MISMATCH', field)
      }
      break
    case 'timestamp':
      if (typeof value !== 'string' || !isTimestamp(value)) {
        throw new FilterError(
          `the field "${field}" is a timestamp with an explicit offset`,
          'TYPE_MISMATCH',
          field
        )
      }
      break
    case 'json':
      if (typeof value !== 'object') {
        throw new FilterError(`the field "${field}" is a json value`, 'TYPE_MISMATCH', field)
      }
      break
    default:
      break
  }
}

/**
 * Reports whether a value is a timestamp with an explicit offset.
 *
 * A local time without an offset is refused: the server would have to
 * guess the zone of the caller, and two servers would guess differently.
 */
export function isTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) {
    return false
  }
  return !Number.isNaN(Date.parse(value))
}

/**
 * Parses a filter.
 *
 * The parser is strict: an unknown operator, an unknown field, a wrong
 * type or a filter that is too deep is refused. A filter that is not
 * understood is never partially applied.
 */
export function parseFilter(value: unknown, options: FilterParseOptions): FilterNode {
  const state = { leaves: 0 }
  return parseNode(value, options, state, 1)
}

/** Parses one node of a filter. */
function parseNode(
  value: unknown,
  options: FilterParseOptions,
  state: { leaves: number },
  depth: number
): FilterNode {
  if (depth > MAX_FILTER_DEPTH) {
    throw new FilterError(`the filter is deeper than ${MAX_FILTER_DEPTH}`, 'FILTER_TOO_DEEP')
  }
  if (!isObject(value)) {
    throw new FilterError('the filter is not an object', 'INVALID_FILTER')
  }
  const entries = Object.entries(value)
  if (entries.length === 0) {
    // An empty filter object means no additional predicate.
    return { kind: 'all' }
  }
  if (entries.length > 1) {
    throw new FilterError('a filter node holds one field or one operator', 'INVALID_FILTER')
  }
  const [key, raw] = entries[0]!

  if (key === '_and' || key === '_or') {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new FilterError(`the operator ${key} takes a non-empty list`, 'INVALID_FILTER')
    }
    const nodes = raw.map((entry) => parseNode(entry, options, state, depth + 1))
    return key === '_and' ? { kind: 'and', nodes } : { kind: 'or', nodes }
  }

  if ((FILTER_OPERATORS as readonly string[]).includes(key)) {
    throw new FilterError(`the operator ${key} needs a field`, 'INVALID_FILTER')
  }

  const definition = options.fields[key]
  if (!definition) {
    throw new FilterError(`the field "${key}" is not known`, 'UNKNOWN_FIELD', key)
  }
  if (!isObject(raw)) {
    throw new FilterError(`the predicate of "${key}" is not an object`, 'INVALID_FILTER', key)
  }
  const operatorEntries = Object.entries(raw)
  if (operatorEntries.length !== 1) {
    throw new FilterError(`the predicate of "${key}" holds one operator`, 'INVALID_FILTER', key)
  }
  const [operator, operand] = operatorEntries[0]!
  if (!(FILTER_OPERATORS as readonly string[]).includes(operator)) {
    throw new FilterError(`the operator "${operator}" is not known`, 'INVALID_OPERATOR', key)
  }
  state.leaves += 1
  if (state.leaves > MAX_FILTER_LEAVES) {
    throw new FilterError(
      `the filter holds more than ${MAX_FILTER_LEAVES} predicates`,
      'FILTER_TOO_LARGE'
    )
  }

  const typed = operator as FilterOperator
  if (LIST_OPERATORS.has(typed)) {
    if (!Array.isArray(operand) || operand.length === 0) {
      throw new FilterError(
        `the operator ${typed} of "${key}" takes a list of values`,
        'INVALID_OPERATOR',
        key
      )
    }
    if (operand.length > MAX_FILTER_VALUES) {
      throw new FilterError(
        `the operator ${typed} of "${key}" takes at most ${MAX_FILTER_VALUES} values`,
        'INVALID_OPERATOR',
        key
      )
    }
    for (const entry of operand) {
      validateOperand(key, definition, typed, entry, options)
    }
    return { kind: 'cmp', field: key, operator: typed, values: operand }
  }

  validateOperand(key, definition, typed, operand, options)
  return { kind: 'cmp', field: key, operator: typed, value: operand }
}

/**
 * Replaces the server substitutions of a filter.
 *
 * The substitutions are typed server values: they are not evaluated code
 * and they never come from a caller.
 */
export function resolveSubstitutions(node: FilterNode, context: SubstitutionContext): FilterNode {
  if (node.kind === 'all') return node
  if (node.kind === 'cmp') {
    const substitute = (value: unknown): unknown => {
      if (value === '$principalId') return context.principalId
      if (value === '$tenantId') return context.tenantId
      if (value === '$workspaceId') return context.workspaceId
      return value
    }
    if (node.values) {
      return { ...node, values: node.values.map((entry) => substitute(entry)) }
    }
    return { ...node, value: substitute(node.value) }
  }
  return { kind: node.kind, nodes: node.nodes.map((entry) => resolveSubstitutions(entry, context)) }
}

/** The SQL type a field is compared with. */
export function sqlTypeOf(definition: FieldDefinition): string {
  switch (definition.type) {
    case 'string':
    case 'text':
      return 'text'
    case 'boolean':
      return 'boolean'
    case 'integer':
      return 'bigint'
    case 'decimal':
      return 'numeric'
    case 'uuid':
      return 'uuid'
    case 'timestamp':
      return 'timestamptz'
    case 'json':
      return 'jsonb'
    case 'enum':
      return 'text'
    default:
      return 'text'
  }
}

/** The compiled form of a filter. */
export interface CompiledFilter {
  /** The SQL fragment, with numbered parameters. */
  readonly sql: string
  /** The parameters of the fragment, in the order of the placeholders. */
  readonly params: readonly unknown[]
}

/** The options of the compiler. */
export interface CompileFilterOptions {
  /** The fields the filter may use. */
  readonly fields: FieldCatalogue
  /** The alias of the table in the statement. */
  readonly alias?: string
  /** The parameters that are already bound, so the numbers continue. */
  readonly startIndex?: number
  /** The substitutions that are replaced before the compilation. */
  readonly substitutions?: SubstitutionContext
}

/** Quotes an identifier of the manifest. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Compiles a filter into a SQL fragment.
 *
 * Every value is a bound parameter and every identifier comes from the
 * manifest: a caller never chooses a SQL fragment.
 */
export function compileFilter(node: FilterNode, options: CompileFilterOptions): CompiledFilter {
  const params: unknown[] = []
  let index = options.startIndex ?? 1
  const alias = options.alias ? `${quoteIdentifier(options.alias)}.` : ''
  const resolved = options.substitutions ? resolveSubstitutions(node, options.substitutions) : node

  const placeholder = (value: unknown, type: string): string => {
    params.push(value)
    const current = `$${index}`
    index += 1
    return type === 'text' ? current : `${current}::${type}`
  }

  const walk = (current: FilterNode): string => {
    if (current.kind === 'all') return 'true'
    if (current.kind === 'and') {
      return `(${current.nodes.map(walk).join(' and ')})`
    }
    if (current.kind === 'or') {
      return `(${current.nodes.map(walk).join(' or ')})`
    }
    const definition = options.fields[current.field]
    if (!definition) {
      throw new FilterError(
        `the field "${current.field}" is not known`,
        'UNKNOWN_FIELD',
        current.field
      )
    }
    const type = sqlTypeOf(definition)
    // The comparison of the text is the comparison of the bytes, and not
    // the comparison of the locale of the database: the evaluation in
    // memory compares the code units, and the two evaluations have to
    // agree whatever the collation of the deployment is.
    const column =
      type === 'text'
        ? `${alias}${quoteIdentifier(current.field)} collate "C"`
        : `${alias}${quoteIdentifier(current.field)}`
    switch (current.operator) {
      case '_eq':
        return `${column} = ${placeholder(current.value, type)}`
      case '_neq':
        return `${column} <> ${placeholder(current.value, type)}`
      case '_lt':
        return `${column} < ${placeholder(current.value, type)}`
      case '_lte':
        return `${column} <= ${placeholder(current.value, type)}`
      case '_gt':
        return `${column} > ${placeholder(current.value, type)}`
      case '_gte':
        return `${column} >= ${placeholder(current.value, type)}`
      case '_is_null':
        return current.value === true ? `${column} is null` : `${column} is not null`
      case '_in':
      case '_nin': {
        const values = (current.values ?? []).map((value) => placeholder(value, type))
        const list = values.join(', ')
        return current.operator === '_in'
          ? `${column} in (${list})`
          : `not (${column} in (${list}))`
      }
      default:
        throw new FilterError('the operator is not known', 'INVALID_OPERATOR', current.field)
    }
  }

  return { sql: walk(resolved), params }
}

/**
 * Reports whether a value of a row is the null of the database.
 *
 * A field that the row does not carry is the null of the column: the
 * two are the same absence in the two evaluations.
 */
function isNull(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * Evaluates a filter against a row that is already in memory.
 *
 * The evaluation is used by the write rules, where the row is locked and
 * its values are known, and by the representation of a single record.
 * It uses the same rules as the compiled form, so a row that is accepted
 * in memory is the row the statement would find.
 *
 * **The null follows the three valued logic of the database.** A
 * comparison with a null value is unknown and never true: `status <> 'x'`
 * does not match a row whose status is null, exactly as the statement
 * does not match it. Only `_is_null` matches a null value. The two
 * evaluations have to agree: a row that the read hides because the
 * statement does not match it may not be written, and its fields may not
 * be shown, because the rules of the write path would answer otherwise.
 */
export function evaluateFilter(
  node: FilterNode,
  row: Readonly<Record<string, unknown>>,
  context: SubstitutionContext
): boolean {
  const resolved = resolveSubstitutions(node, context)
  const walk = (current: FilterNode): boolean => {
    if (current.kind === 'all') return true
    if (current.kind === 'and') return current.nodes.every(walk)
    if (current.kind === 'or') return current.nodes.some(walk)
    const value = row[current.field]
    const operand = current.value
    if (current.operator === '_is_null') {
      return operand === true ? isNull(value) : !isNull(value)
    }
    // Every other operator compares a value with the null of the column:
    // the answer of the database is unknown and it is never true.
    if (isNull(value)) return false
    switch (current.operator) {
      case '_eq':
        return valuesEqual(value, operand)
      case '_neq':
        return !valuesEqual(value, operand)
      case '_lt':
        return compareValues(value, operand) < 0
      case '_lte':
        return compareValues(value, operand) <= 0
      case '_gt':
        return compareValues(value, operand) > 0
      case '_gte':
        return compareValues(value, operand) >= 0
      case '_in':
        return (current.values ?? []).some((entry) => valuesEqual(value, entry))
      case '_nin':
        return !(current.values ?? []).some((entry) => valuesEqual(value, entry))
      default:
        return false
    }
  }
  return walk(resolved)
}

/** Reports whether two values are equal, with the rules of their type. */
export function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === null || right === undefined
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right)
  if (left instanceof Date || right instanceof Date) {
    return new Date(left as Date).getTime() === new Date(right as Date).getTime()
  }
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right)
  }
  return String(left) === String(right)
}

/**
 * Compares two values.
 *
 * The comparison of a decimal is exact: the values are compared as
 * decimals and not as numbers, so a value that does not fit in a double
 * keeps its order.
 */
export function compareValues(left: unknown, right: unknown): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : -1
  if (left instanceof Date) return left.getTime() - new Date(right as string).getTime()
  if (typeof left === 'number' && typeof right === 'number') return left - right
  const leftText = String(left)
  const rightText = String(right)
  if (/^-?\d+(\.\d+)?$/.test(leftText) && /^-?\d+(\.\d+)?$/.test(rightText)) {
    return compareDecimals(leftText, rightText)
  }
  if (leftText < rightText) return -1
  if (leftText > rightText) return 1
  return 0
}

/** Compares two decimal strings exactly. */
export function compareDecimals(left: string, right: string): number {
  const normalize = (value: string): { sign: number; integer: string; fraction: string } => {
    const negative = value.startsWith('-')
    const body = negative ? value.slice(1) : value
    const [integer = '0', fraction = ''] = body.split('.')
    return {
      sign: negative ? -1 : 1,
      integer: integer.replace(/^0+(?=\d)/, ''),
      fraction,
    }
  }
  const a = normalize(left)
  const b = normalize(right)
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1
  if (a.integer.length !== b.integer.length) {
    return a.integer.length < b.integer.length ? -1 : 1
  }
  if (a.integer !== b.integer) return a.integer < b.integer ? -1 : 1
  const length = Math.max(a.fraction.length, b.fraction.length)
  const leftFraction = a.fraction.padEnd(length, '0')
  const rightFraction = b.fraction.padEnd(length, '0')
  if (leftFraction === rightFraction) return 0
  return leftFraction < rightFraction ? -1 : 1
}
