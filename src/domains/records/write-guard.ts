/**
 * The guard of a write (spec §8.3).
 *
 * A write is authorized by one complete policy: the predicates and the
 * fields of two policies are never mixed. The rule used to be applied
 * twice — once in memory, over the row that the write locked, and once
 * by the statement of the read — and the two implementations of the
 * same rule diverged three times before the comparison was made the
 * comparison of the type of the field.
 *
 * The guard closes the gap. The statement of the write carries the
 * predicates of the policies, compiled by the same compiler as the
 * reads, and **the database evaluates them**. The row after the change
 * is given to the database as a common table expression of bound
 * parameters, so the check of a write is the check of the row that the
 * write produces, and not the check of a row that the memory guessed.
 *
 * The evaluation in memory stays as the **oracle** of the check: it is
 * fast, it refuses a write before it touches the database, and the
 * differential test compares it with the statement on predicates that
 * were not written by hand. The two answers have to be the same, and
 * the statement is the one that decides: a write that the memory
 * accepts and that the statement refuses is refused.
 */

import { type FilterNode, type Policy, type SubstitutionContext, sqlTypeOf } from '../authorization'
import type { CollectionDefinition, FieldDefinition } from '../schema'
import { type Parameters, compileInto } from './sql'

/** The names of the fields a predicate uses. */
export function referencedFields(node: FilterNode): string[] {
  if (node.kind === 'all') return []
  if (node.kind === 'cmp') return [node.field]
  if (node.kind === 'not') return referencedFields(node.node)
  return node.nodes.flatMap((entry) => referencedFields(entry))
}

/** The server maintained fields that a creation sets. */
const CREATE_SERVER_FIELDS = [
  'id',
  'tenant_id',
  'workspace_id',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
  'version',
] as const

/** The server maintained fields that an update sets. */
const UPDATE_SERVER_FIELDS = ['updated_by', 'updated_at'] as const

/** The context of the guard of a write. */
export interface GuardContext {
  /** The collection that is written. */
  readonly collection: CollectionDefinition
  /** The fields a predicate may use, with their types. */
  readonly catalogue: Record<string, FieldDefinition>
  /** The policies that may authorize the write. */
  readonly policies: readonly Policy[]
  /** The values of the substitutions of the caller. */
  readonly substitutions: SubstitutionContext
  /** The parameters of the statement. */
  readonly parameters: Parameters
}

/** The guard of a write. */
export interface WriteGuard {
  /**
   * The prefix of the statement: the common table expressions that
   * hold the row before the change and the row after it.
   */
  readonly prefix: string
  /** The condition that authorizes the write. */
  readonly guard: string
  /**
   * The tables the guard reads.
   *
   * The database does not resolve a common table expression in the
   * condition of an update: the condition of an update sees the table
   * it writes and nothing else. The condition is therefore a
   * subquery over the expressions, and this is the list it reads.
   */
  readonly sources: string
  /** The placeholders of the values of the write, by field. */
  readonly placeholders: Readonly<Record<string, string>>
  /** The columns of the row that is written, in the order of the insert. */
  readonly columns: readonly string[]
}

/** The options of the guard of a creation. */
export interface CreateGuardOptions extends GuardContext {
  /** The values of the row that is created, by field. */
  readonly values: Readonly<Record<string, unknown>>
  /** The identifier of the row that is created. */
  readonly id: string
  /** The tenant of the row. */
  readonly tenantId: string
  /** The workspace of the row. */
  readonly workspaceId: string
  /** The identity of the principal that writes. */
  readonly principalId: string
  /** The instant of the write. */
  readonly now: string
}

/** The options of the guard of an update. */
export interface UpdateGuardOptions extends GuardContext {
  /** The values the client writes. */
  readonly written: Readonly<Record<string, unknown>>
  /** The identity of the principal that writes. */
  readonly principalId: string
  /** The instant of the write. */
  readonly now: string
  /** The scope of the row, with the placeholders of the caller. */
  readonly scopeClause: string
}

/** The options of the guard of a deletion. */
export interface DeleteGuardOptions extends GuardContext {
  /** The scope of the row, with the placeholders of the caller. */
  readonly scopeClause: string
}

/**
 * Builds the guard of a creation.
 *
 * The row that is created is given to the database as a common table
 * expression of bound parameters: the check of the policies is
 * evaluated over the row that the insert is about to write, and not
 * over a row that the memory assembled.
 */
export function buildCreateGuard(options: CreateGuardOptions): WriteGuard {
  const { parameters } = options
  const placeholders: Record<string, string> = {}
  const serverValues: Record<string, unknown> = {
    id: options.id,
    tenant_id: options.tenantId,
    workspace_id: options.workspaceId,
    created_by: options.principalId,
    created_at: options.now,
    updated_by: options.principalId,
    updated_at: options.now,
    version: 1,
  }
  for (const field of CREATE_SERVER_FIELDS) {
    placeholders[field] = typed(parameters, serverValues[field], serverType(field))
  }
  for (const [field, value] of Object.entries(options.values)) {
    const definition = options.catalogue[field]
    if (!definition) continue
    placeholders[field] = typed(parameters, boundValue(definition, value), sqlTypeOf(definition))
  }

  const columns = [...CREATE_SERVER_FIELDS, ...Object.keys(options.values)]
  const checkFields = fieldsOf(options.policies, 'check')
  const image = [...columns]
  for (const field of checkFields) {
    if (image.includes(field)) continue
    const definition = options.catalogue[field]
    if (!definition) continue
    // A field that the write does not set is the null of the column:
    // the manifest holds the defaults of a deployment, and a default
    // that the manifest does not declare is not one.
    image.push(field)
  }

  const selections = image.map((field) => {
    const placeholder = placeholders[field]
    if (placeholder !== undefined) {
      return `${placeholder} as ${quote(field)}`
    }
    const definition = options.catalogue[field]
    const type = definition ? sqlTypeOf(definition) : 'text'
    return `null::${type} as ${quote(field)}`
  })

  const guard = disjunction(options.policies, (policy) =>
    compileInto(policy.check, parameters, {
      fields: options.catalogue,
      alias: 'post',
      substitutions: options.substitutions,
    })
  )

  return {
    prefix: `with post as materialized (select ${selections.join(', ')}) `,
    guard,
    sources: 'post',
    placeholders,
    columns,
  }
}

/**
 * Builds the guard of an update.
 *
 * The statement carries two images of the row: the row before the
 * change, which the predicates of `where` are evaluated over, and the
 * row after the change, which the predicates of `check` are evaluated
 * over. The second one is the row that the update produces: the fields
 * the client writes are the bound parameters of the statement, the
 * fields the server maintains are the ones the statement sets, and the
 * other fields are the ones of the row before the change.
 */
export function buildUpdateGuard(options: UpdateGuardOptions): WriteGuard {
  const { parameters } = options
  const placeholders: Record<string, string> = {}
  for (const [field, value] of Object.entries(options.written)) {
    const definition = options.catalogue[field]
    if (!definition) continue
    placeholders[field] = typed(parameters, boundValue(definition, value), sqlTypeOf(definition))
  }
  for (const field of UPDATE_SERVER_FIELDS) {
    const value = field === 'updated_at' ? options.now : options.principalId
    placeholders[field] = typed(parameters, value, field === 'updated_at' ? 'timestamptz' : 'uuid')
  }

  const written = new Set(Object.keys(options.written))
  const whereFields = fieldsOf(options.policies, 'where')
  const checkFields = fieldsOf(options.policies, 'check')

  // The row before the change holds the fields the predicates of `where`
  // use, and the fields the row after the change inherits from it.
  const preFields = new Set<string>(['id'])
  for (const field of whereFields) preFields.add(field)
  for (const field of checkFields) {
    if (written.has(field)) continue
    if ((UPDATE_SERVER_FIELDS as readonly string[]).includes(field)) continue
    preFields.add(field)
  }

  const preSelections = [...preFields].map((field) => `t.${quote(field)}`)
  const postSelections = checkFields.map((field) => {
    const placeholder = placeholders[field]
    if (placeholder !== undefined) {
      return `${placeholder} as ${quote(field)}`
    }
    if (field === 'version') return `pre.${quote(field)} + 1 as ${quote(field)}`
    return `pre.${quote(field)} as ${quote(field)}`
  })

  const guard = disjunction(options.policies, (policy) => {
    const where = compileInto(policy.where, parameters, {
      fields: options.catalogue,
      alias: 'pre',
      substitutions: options.substitutions,
    })
    const check = compileInto(policy.check, parameters, {
      fields: options.catalogue,
      alias: 'post',
      substitutions: options.substitutions,
    })
    return `(${where}) and (${check})`
  })

  const prefix =
    `with pre as materialized (select ${preSelections.join(', ')} from ${options.collection.table} t where ${options.scopeClause})` +
    (postSelections.length > 0
      ? `, post as materialized (select ${postSelections.join(', ')} from pre) `
      : ' ')

  return {
    prefix,
    guard,
    sources: postSelections.length > 0 ? 'pre, post' : 'pre',
    placeholders,
    columns: [],
  }
}

/**
 * Builds the guard of a deletion.
 *
 * A deletion has no row after the change: the predicates of `where` are
 * evaluated over the row that the delete removes, and the row is the
 * row of the table.
 */
export function buildDeleteGuard(options: DeleteGuardOptions): WriteGuard {
  const guard = disjunction(options.policies, (policy) =>
    compileInto(policy.where, options.parameters, {
      fields: options.catalogue,
      alias: 't',
      substitutions: options.substitutions,
    })
  )
  return { prefix: '', guard, sources: 't', placeholders: {}, columns: [] }
}

/**
 * The disjunction of the terms of the policies.
 *
 * A write is authorized by one complete policy, and the disjunction is
 * the "some policy authorizes it": the predicates of two policies are
 * never mixed, because every term of the disjunction holds the two
 * predicates of one policy.
 */
function disjunction(policies: readonly Policy[], term: (policy: Policy) => string): string {
  if (policies.length === 0) return 'false'
  return `(${policies.map((policy) => `(${term(policy)})`).join(' or ')})`
}

/** The fields the predicates of the policies use. */
function fieldsOf(policies: readonly Policy[], kind: 'where' | 'check'): string[] {
  const fields = new Set<string>()
  for (const policy of policies) {
    for (const field of referencedFields(policy[kind])) fields.add(field)
  }
  return [...fields]
}

/** The type of a server maintained field. */
function serverType(field: string): string {
  switch (field) {
    case 'created_at':
    case 'updated_at':
      return 'timestamptz'
    case 'version':
      return 'integer'
    default:
      return 'uuid'
  }
}

/**
 * Binds a value and returns its placeholder with its cast.
 *
 * The cast is always written: a parameter of a common table expression
 * has no column to take its type from, and the database refuses a
 * parameter whose type it cannot determine.
 */
function typed(parameters: Parameters, value: unknown, type: string): string {
  return `${parameters.add(value)}::${type}`
}

/**
 * The value of a field, as the database binds it.
 *
 * A json value is bound as its text: the driver of the database writes
 * a list as the literal of a list, and the literal of a list is not a
 * json value.
 */
function boundValue(definition: FieldDefinition, value: unknown): unknown {
  if (definition.type === 'json') return JSON.stringify(value)
  return value
}

/** Quotes an identifier of the manifest. */
function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
