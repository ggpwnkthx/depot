/**
 * The service of the records (spec §9 and §10).
 *
 * The service owns the record operations. It reads the rules of the
 * policies, it builds the statements, it writes the audit entry, the
 * event and the receipt of a mutation inside the transaction of the
 * mutation, and it answers with the canonical representation of a record.
 *
 * Every mutation asks for a fresh context before it begins and it checks
 * the deadline of that context again immediately before the commit.
 */

import { createHash, randomUUID } from 'node:crypto'
import { ServiceError } from '../../protocol/errors'
import {
  type AuthorizationInput,
  type FilterNode,
  type Policy,
  type RequestContext,
  type SubstitutionContext,
  applicablePolicies,
  evaluateFilter,
  filterSortIntersection,
  parseFilter,
  readableUnion,
  selectWritePolicy,
} from '../authorization'
import type { CollectionDefinition, FieldDefinition } from '../schema'
import {
  type AggregateFunction,
  type AggregateGroup,
  type AggregateMetric,
  type AggregateOptions,
  type AggregateResult,
  type CreateOptions,
  type DeleteOptions,
  type ListOptions,
  type ListResult,
  type RecordRow,
  type RecordsServiceOptions,
  type Scope,
  type TransactionOptions,
  type UnitOfWork,
  type UpdateOptions,
  type WriteResult,
  CURSOR_LIFETIME_MS,
  DEFAULT_AGGREGATE_GROUPS,
  DEFAULT_LIMIT,
  MAX_AGGREGATE_GROUP_FIELDS,
  MAX_AGGREGATE_GROUPS,
  MAX_AGGREGATE_METRICS,
  MAX_INCLUDES,
  MAX_LIMIT,
  MAX_RELATED_ROWS_PER_RESPONSE,
  MAX_RELATED_ROWS_PER_ROOT,
  MAX_RESPONSE_BYTES,
  MAX_SEARCH_LENGTH,
  MAX_SELECTED_FIELDS,
  MAX_SORT_FIELDS,
} from './types'
import {
  canonicalJson,
  decodeCursor,
  encodeCursor,
  etagMatches,
  etagOf,
  parseIfMatch,
  queryFingerprint,
} from './canonical'
import { BodyError, validateBody } from './validation'
import {
  EXPOSED_SERVER_FIELDS,
  type AggregateMetricColumn,
  Parameters,
  type SortColumn,
  buildAggregate,
  catalogueFor,
  compileInto,
  jsonExpression,
  keysetCondition,
  rowPredicate,
  searchClause,
  sortColumns,
} from './sql'

/** The row of a read, as the statement returns it. */
interface SelectedRow {
  id: string
  version: number
  payload: Record<string, unknown>
  relations: string[]
  /** The values of the columns of the sort, with the rank of the nulls. */
  position: unknown[]
  /** The values of the foreign keys of the relations, hidden from the answer. */
  foreignKeys: Record<string, unknown>
}

/** The service of the records. */
export class RecordsService {
  readonly #options: RecordsServiceOptions

  constructor(options: RecordsServiceOptions) {
    this.#options = options
  }

  /**
   * The collection of a key in the catalog of the workspace.
   *
   * The catalog of the workspace holds the collections it serves: a
   * collection that the workspace did not register is not a collection
   * of the service, and the answer is the answer of a collection that
   * does not exist.
   */
  collection(context: RequestContext, key: string): CollectionDefinition | null {
    return context.catalog.manifest.collections.find((entry) => entry.key === key) ?? null
  }

  /** The authorization input of a context. */
  #authorization(context: RequestContext): AuthorizationInput {
    return {
      permissionKeys: context.permissionKeys,
      bundle: context.catalog.bundle,
      manifest: context.catalog.manifest,
    }
  }

  /** The substitution values of a context. */
  #substitutions(context: RequestContext): SubstitutionContext {
    return {
      principalId: context.principalId,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
    }
  }

  /** The scope of a context. */
  #scope(context: RequestContext): Scope {
    return {
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      principalId: context.principalId,
    }
  }

  /** The read policies of a collection. */
  #readPolicies(context: RequestContext, collection: string): Policy[] {
    return applicablePolicies(this.#authorization(context), collection, 'read')
  }

  /** The fields a caller may see of a collection. */
  #grantedFields(context: RequestContext, collection: CollectionDefinition): string[] {
    const policies = this.#readPolicies(context, collection.key)
    const union = new Set(readableUnion(policies))
    const fields = new Set<string>()
    for (const name of Object.keys(collection.fields)) {
      if (union.has(name)) fields.add(name)
    }
    for (const name of EXPOSED_SERVER_FIELDS) {
      if (union.has(name)) fields.add(name)
    }
    return [...fields]
  }

  /** The relations a caller may expand of a collection. */
  #grantedRelations(context: RequestContext, collection: CollectionDefinition): string[] {
    const policies = this.#readPolicies(context, collection.key)
    const union = new Set(readableUnion(policies))
    return Object.keys(collection.relations).filter((name) => union.has(name))
  }

  /** The fields a caller may filter and sort by. */
  #filterableFields(context: RequestContext, collection: CollectionDefinition): string[] {
    const policies = this.#readPolicies(context, collection.key)
    const intersection = new Set(filterSortIntersection(policies))
    const catalogue = catalogueFor(collection)
    return Object.keys(catalogue)
      .filter((name) => intersection.has(name))
      .sort()
  }

  /** Refuses a collection that is not registered. */
  #requireCollection(context: RequestContext, key: string): CollectionDefinition {
    const collection = this.collection(context, key)
    if (!collection) {
      throw new ServiceError('NOT_FOUND')
    }
    return collection
  }

  /** Refuses a collection the caller may not read. */
  #requireReadable(context: RequestContext, collection: CollectionDefinition): Policy[] {
    const policies = this.#readPolicies(context, collection.key)
    if (policies.length === 0) {
      throw new ServiceError('FORBIDDEN')
    }
    return policies
  }

  /** The options of a transaction, with the deadline of the authorization. */
  #transactionOptions(context: RequestContext, timeoutMs?: number): TransactionOptions {
    const deadline = context.authorizationDeadline
    if (this.#options.clock.monotonic() > deadline) {
      throw new ServiceError('FORBIDDEN', {
        message: 'the authorization of the request is expired',
      })
    }
    const options: { timeoutMs?: number; beforeCommit: () => void } = {
      beforeCommit: () => {
        if (this.#options.clock.monotonic() > deadline) {
          throw new ServiceError('FORBIDDEN', {
            message: 'the authorization of the request expired before the commit',
          })
        }
      },
    }
    if (timeoutMs !== undefined) options.timeoutMs = timeoutMs
    return options
  }

  // ----------------------------------------------------------------- list

  /**
   * Lists the records of a collection.
   *
   * The list is bounded: the limit, the size of the answer and the
   * expansions all have a budget, and the budget is checked while the
   * rows are encoded, not after the whole page was built.
   */
  async list(
    context: RequestContext,
    collectionKey: string,
    options: ListOptions
  ): Promise<ListResult> {
    const collection = this.#requireCollection(context, collectionKey)
    const policies = this.#requireReadable(context, collection)
    const catalogue = catalogueFor(collection)
    const granted = this.#grantedFields(context, collection)
    const filterable = this.#filterableFields(context, collection)
    const relations = this.#grantedRelations(context, collection)

    const selected = this.#selectedFields(options.fields, granted)
    const clientFilter = this.#clientFilter(options.filter, catalogue, filterable)
    const sort = this.#sortOf(options.sort, filterable)
    const include = this.#includes(options.include, relations)

    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    const queryKey = queryFingerprint({
      fields: [...selected].sort(),
      filter: options.filter ?? null,
      search: options.search ?? null,
      sort: sort.map((column) => `${column.descending ? '-' : ''}${column.field}`),
      include: [...include].sort(),
      includeCount: options.includeCount,
      limit,
    })

    const scope = this.#scope(context)
    const substitutions = this.#substitutions(context)

    return await this.#options.store.read(async (unit) => {
      const parameters = new Parameters()
      const scopeClause = `t.tenant_id = ${parameters.add(context.tenantId, 'uuid')} and t.workspace_id = ${parameters.add(context.workspaceId, 'uuid')}`
      const predicate = rowPredicate(policies, parameters, catalogue, substitutions)
      const search = this.#search(collection, options.search, filterable, parameters)
      const filterClause = this.#filterClause(clientFilter, catalogue, parameters, search)

      let position: readonly unknown[] | null = null
      if (options.cursor) {
        const payload = decodeCursor(
          options.cursor,
          this.#options.cursorKey,
          {
            principal: context.principalId,
            tenant: context.tenantId,
            workspace: context.workspaceId,
            collection: collection.key,
            route: context.routeId,
            query: queryKey,
            schemaVersion: context.catalog.manifest.schemaVersion,
            policyVersion: context.catalog.bundle.bundleVersion,
            permissions: [...context.permissionKeys].sort().join(','),
          },
          this.#options.clock.now()
        )
        position = payload.position
      }
      const keyset = position === null ? 'true' : keysetCondition(sort, position, parameters)

      const selectedFields = selected.filter((field) => catalogue[field])
      const foreignKeys = include
        .map((name) => collection.relations[name])
        .filter((relation) => relation && relation.type === 'many-to-one')
        .map((relation) => relation!.field)

      const sql = buildSelect({
        table: collection.table,
        scopeClause,
        predicate,
        filterClause,
        keyset,
        policies,
        catalogue,
        substitutions,
        parameters,
        selectedFields,
        foreignKeys,
        relations: include,
        sort,
        limit: limit + 1,
        withLimit: true,
      })

      const raw = await unit.query<Record<string, unknown>>(sql, parameters.values)
      const rows = raw.map((row) => mapRow(row, sort, foreignKeys))
      const page = rows.slice(0, limit)
      const hasMore = rows.length > limit

      const data = await this.#hydrate(unit, context, collection, page, include)
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_RESPONSE_BYTES) {
        throw new ServiceError('RESULT_TOO_LARGE')
      }

      let count: number | undefined
      if (options.includeCount) {
        const countParameters = new Parameters()
        const countScope = `t.tenant_id = ${countParameters.add(context.tenantId, 'uuid')} and t.workspace_id = ${countParameters.add(context.workspaceId, 'uuid')}`
        const countPredicate = rowPredicate(policies, countParameters, catalogue, substitutions)
        const countSearch = this.#search(collection, options.search, filterable, countParameters)
        const countFilter = this.#filterClause(
          clientFilter,
          catalogue,
          countParameters,
          countSearch
        )
        const countRows = await unit.query<{ count: string }>(
          `select count(*)::text as count from ${collection.table} t where ${countScope} and (${countPredicate}) and (${countFilter})`,
          countParameters.values
        )
        count = Number(countRows[0]?.count ?? '0')
      }

      let nextCursor: string | null = null
      if (hasMore && page.length > 0) {
        const last = page[page.length - 1]!
        nextCursor = encodeCursor(
          {
            v: 1,
            principal: context.principalId,
            tenant: context.tenantId,
            workspace: context.workspaceId,
            collection: collection.key,
            route: context.routeId,
            query: queryKey,
            position: last.position ?? [],
            expiry: this.#options.clock.now() + CURSOR_LIFETIME_MS,
            schemaVersion: context.catalog.manifest.schemaVersion,
            policyVersion: context.catalog.bundle.bundleVersion,
            permissions: [...context.permissionKeys].sort().join(','),
          },
          this.#options.cursorKey
        )
      }

      return {
        data,
        meta: {
          limit,
          nextCursor,
          ...(count === undefined ? {} : { count }),
        },
      }
    }, scope)
  }

  // ------------------------------------------------------------- aggregate

  /**
   * Aggregates the records of a collection.
   *
   * The aggregate reads the rows that a list would read: the same scope,
   * the same predicate of the policies and the same filter of the
   * caller. It is not a privileged query path, and it is bounded: the
   * number of the groups is capped and the answer says when the groups
   * of the answer are not all of them.
   *
   * The fields of the group and the fields of the metrics are the fields
   * the caller may filter and sort by: the intersection of the policies
   * is the conservative answer, and an aggregate over a field that a
   * policy hides would leak what the policy protects.
   */
  async aggregate(
    context: RequestContext,
    collectionKey: string,
    options: AggregateOptions
  ): Promise<AggregateResult> {
    const collection = this.#requireCollection(context, collectionKey)
    const policies = this.#requireReadable(context, collection)
    const catalogue = catalogueFor(collection)
    const filterable = this.#filterableFields(context, collection)

    const groupBy = this.#aggregateGroupBy(options.groupBy, filterable, catalogue)
    const metrics = this.#aggregateMetrics(options.metrics, filterable, catalogue)
    const clientFilter = this.#clientFilter(options.filter, catalogue, filterable)
    const limit = Math.min(
      Math.max(1, options.limit ?? DEFAULT_AGGREGATE_GROUPS),
      MAX_AGGREGATE_GROUPS
    )

    const scope = this.#scope(context)
    const substitutions = this.#substitutions(context)

    return await this.#options.store.read(async (unit) => {
      const parameters = new Parameters()
      const scopeClause = `t.tenant_id = ${parameters.add(context.tenantId, 'uuid')} and t.workspace_id = ${parameters.add(context.workspaceId, 'uuid')} `
      const predicate = rowPredicate(policies, parameters, catalogue, substitutions)
      const search = this.#search(collection, options.search, filterable, parameters)
      const filterClause = this.#filterClause(clientFilter, catalogue, parameters, search)

      const sql = buildAggregate({
        table: collection.table,
        scopeClause,
        predicate,
        filterClause,
        groupBy,
        metrics,
        catalogue,
        parameters,
        limit: limit + 1,
      })
      const rows = await unit.query<Record<string, unknown>>(sql, parameters.values)
      const truncated = rows.length > limit
      const page = rows.slice(0, limit)
      const data = page.map((row) => mapAggregate(row, groupBy, metrics))
      return {
        data,
        meta: { limit, groups: data.length, truncated },
      }
    }, scope)
  }

  /**
   * The clause of a search.
   *
   * The search reads the fields that the deployment declared searchable,
   * and they have to be the fields the caller may filter and sort by:
   * a search over a field that a policy hides would disclose what the
   * policy protects.
   */
  #search(
    collection: CollectionDefinition,
    text: string | undefined,
    filterable: readonly string[],
    parameters: Parameters
  ): string | null {
    if (text === undefined) return null
    const trimmed = text.trim()
    if (trimmed.length === 0) return null
    if (trimmed.length > MAX_SEARCH_LENGTH) {
      throw new ServiceError('INVALID_QUERY', {
        message: `the search is longer than ${MAX_SEARCH_LENGTH} characters`,
      })
    }
    if (!collection.search) {
      throw new ServiceError('INVALID_QUERY', { message: 'the collection has no search' })
    }
    for (const field of collection.search.fields) {
      if (!filterable.includes(field)) {
        throw new ServiceError('FORBIDDEN', {
          message: 'the search may not be used by this caller',
        })
      }
    }
    return searchClause(collection, parameters, trimmed)
  }

  /** The clause of the filter of a caller, with the search that follows it. */
  #filterClause(
    clientFilter: FilterNode,
    catalogue: Record<string, FieldDefinition>,
    parameters: Parameters,
    search: string | null
  ): string {
    const filter =
      clientFilter.kind === 'all'
        ? 'true'
        : compileInto(clientFilter, parameters, { fields: catalogue, alias: 't' })
    return search === null ? filter : `(${filter}) and (${search})`
  }

  /** The fields of the group of an aggregate. */
  #aggregateGroupBy(
    fields: readonly string[],
    filterable: readonly string[],
    catalogue: Record<string, FieldDefinition>
  ): string[] {
    if (fields.length === 0) return []
    if (fields.length > MAX_AGGREGATE_GROUP_FIELDS) {
      throw new ServiceError('INVALID_QUERY', {
        message: `an aggregate groups by at most ${MAX_AGGREGATE_GROUP_FIELDS} fields`,
      })
    }
    const names: string[] = []
    for (const field of fields) {
      if (!catalogue[field]) {
        throw new ServiceError('INVALID_QUERY', { message: `the field "${field}" is not known` })
      }
      if (!filterable.includes(field)) {
        throw new ServiceError('INVALID_QUERY', {
          message: `the field "${field}" may not be used to group the records`,
        })
      }
      names.push(field)
    }
    return names
  }

  /** The metrics of an aggregate. */
  #aggregateMetrics(
    metrics: readonly AggregateMetric[],
    filterable: readonly string[],
    catalogue: Record<string, FieldDefinition>
  ): AggregateMetricColumn[] {
    if (metrics.length > MAX_AGGREGATE_METRICS) {
      throw new ServiceError('INVALID_QUERY', {
        message: `an aggregate holds at most ${MAX_AGGREGATE_METRICS} metrics`,
      })
    }
    const columns: AggregateMetricColumn[] = []
    for (const metric of metrics) {
      const definition = catalogue[metric.field]
      if (!definition) {
        throw new ServiceError('INVALID_QUERY', {
          message: `the field "${metric.field}" is not known`,
        })
      }
      if (!filterable.includes(metric.field)) {
        throw new ServiceError('INVALID_QUERY', {
          message: `the field "${metric.field}" may not be used in an aggregate`,
        })
      }
      if (!supportsAggregate(metric.function, definition)) {
        throw new ServiceError('INVALID_QUERY', {
          message: `the function "${metric.function}" is not defined for the type "${definition.type}"`,
        })
      }
      columns.push({ function: metric.function, field: metric.field })
    }
    return columns
  }

  // ------------------------------------------------------------------ get

  /** Reads one record and its validator. */
  async get(
    context: RequestContext,
    collectionKey: string,
    id: string
  ): Promise<{ representation: Record<string, unknown>; etag: string }> {
    const collection = this.#requireCollection(context, collectionKey)
    const policies = this.#requireReadable(context, collection)
    const catalogue = catalogueFor(collection)
    const selected = this.#grantedFields(context, collection).filter((field) => catalogue[field])
    const scope = this.#scope(context)
    const substitutions = this.#substitutions(context)

    return await this.#options.store.read(async (unit) => {
      const parameters = new Parameters()
      const scopeClause = `t.tenant_id = ${parameters.add(context.tenantId, 'uuid')} and t.workspace_id = ${parameters.add(context.workspaceId, 'uuid')}`
      const idClause = `t."id" = ${parameters.add(id, 'uuid')}`
      const predicate = rowPredicate(policies, parameters, catalogue, substitutions)
      const sql = buildSelect({
        table: collection.table,
        scopeClause,
        predicate,
        filterClause: idClause,
        keyset: 'true',
        policies,
        catalogue,
        substitutions,
        parameters,
        selectedFields: selected,
        foreignKeys: [],
        relations: [],
        sort: [],
        limit: 1,
        withLimit: false,
      })
      const row = await unit.queryOne<Record<string, unknown>>(sql, parameters.values)
      if (!row) {
        throw new ServiceError('NOT_FOUND')
      }
      const mapped = mapRow(row, [], [])
      const representation = { id: mapped.id, version: mapped.version, ...mapped.payload }
      return { representation, etag: etagOf({ data: representation }) }
    }, scope)
  }

  // --------------------------------------------------------------- create

  /** Creates a record and its receipt. */
  async create(
    context: RequestContext,
    collectionKey: string,
    options: CreateOptions
  ): Promise<WriteResult> {
    const collection = this.#requireCollection(context, collectionKey)
    this.#requireReadable(context, collection)
    const policies = applicablePolicies(this.#authorization(context), collection.key, 'create')
    if (policies.length === 0) {
      throw new ServiceError('FORBIDDEN')
    }

    const validated = this.#validated(options.body, collection, 'create')
    const scope = this.#scope(context)
    const substitutions = this.#substitutions(context)
    const id = randomUUID()
    const now = new Date(this.#options.clock.now()).toISOString()
    const values: Record<string, unknown> = {}
    for (const [name, definition] of Object.entries(collection.fields)) {
      if (name in validated.values) {
        values[name] = validated.values[name]
        continue
      }
      if (definition.default !== undefined) values[name] = definition.default
    }

    const resultingRow: Record<string, unknown> = {
      id,
      tenant_id: context.tenantId,
      workspace_id: context.workspaceId,
      created_by: context.principalId,
      created_at: now,
      updated_by: context.principalId,
      updated_at: now,
      version: 1,
      ...values,
    }

    const decision = selectWritePolicy(policies, {
      action: 'create',
      writtenFields: validated.fields,
      resultingRow,
      context: substitutions,
    })
    if (!decision.allowed || !decision.policy) {
      throw new ServiceError('FORBIDDEN')
    }
    const policyId = decision.policy.id

    const fingerprint = createHash('sha256')
      .update(
        canonicalJson({
          method: 'POST',
          path: `/ws/${context.workspaceId}/v1/items/${collection.key}`,
          body: options.body,
        })
      )
      .digest('hex')

    return await this.#options.store.write(
      async (unit) => {
        await this.#checkReferences(unit, context, collection, values)
        await unit.execute(`set local lock_timeout = '2000ms'`)
        const claim = await unit.query<{ record_id: string }>(
          `insert into platform.idempotency_receipts
     (tenant_id, workspace_id, principal_id, route_id, endpoint, key, fingerprint, status, record_id, record_version, created_at, expires_at)
   values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'committed', $8::uuid, $9, now(), now() + interval '24 hours')
   on conflict (tenant_id, workspace_id, principal_id, route_id, endpoint, key)
   do update set fingerprint = platform.idempotency_receipts.fingerprint where false
   returning record_id`,
          [
            context.tenantId,
            context.workspaceId,
            context.principalId,
            context.routeId,
            `POST /items/${collection.key}`,
            options.idempotencyKey,
            fingerprint,
            id,
            1,
          ]
        )
        if (claim.length === 0) {
          const existing = await unit.queryOne<{
            record_id: string
            record_version: number
            fingerprint: string
          }>(
            `select record_id, record_version, fingerprint from platform.idempotency_receipts
       where tenant_id = $1::uuid and workspace_id = $2::uuid and principal_id = $3::uuid
         and route_id = $4 and endpoint = $5 and key = $6`,
            [
              context.tenantId,
              context.workspaceId,
              context.principalId,
              context.routeId,
              `POST /items/${collection.key}`,
              options.idempotencyKey,
            ]
          )
          if (!existing) {
            throw new ServiceError('OPERATION_IN_PROGRESS', { headers: { 'Retry-After': '1' } })
          }
          if (existing.fingerprint !== fingerprint) {
            throw new ServiceError('IDEMPOTENCY_CONFLICT')
          }
          const replay = selectWritePolicy(policies, {
            action: 'create',
            writtenFields: validated.fields,
            resultingRow,
            context: substitutions,
          })
          if (!replay.allowed || !replay.policy) {
            throw new ServiceError('FORBIDDEN')
          }
          return {
            receipt: { id: existing.record_id, version: existing.record_version },
            replayed: true,
            changedFields: validated.fields,
          }
        }

        const columns = Object.keys(values)
        const parameters = new Parameters()
        const names = [
          '"id"',
          '"tenant_id"',
          '"workspace_id"',
          '"created_by"',
          '"created_at"',
          '"updated_by"',
          '"updated_at"',
          '"version"',
          ...columns.map((name) => `"${name}"`),
        ]
        const placeholders = [
          parameters.add(id, 'uuid'),
          parameters.add(context.tenantId, 'uuid'),
          parameters.add(context.workspaceId, 'uuid'),
          parameters.add(context.principalId, 'uuid'),
          parameters.add(now, 'timestamptz'),
          parameters.add(context.principalId, 'uuid'),
          parameters.add(now, 'timestamptz'),
          parameters.add(1, 'integer'),
          ...columns.map((name) =>
            parameters.add(values[name], columnType(collection.fields[name]!))
          ),
        ]
        try {
          await unit.execute(
            `insert into ${collection.table} (${names.join(', ')}) values (${placeholders.join(', ')})`,
            parameters.values
          )
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ServiceError('CONFLICT')
          }
          throw error
        }

        const changedFields = Object.keys(values)
        await this.#writeAuditAndEvent(unit, context, {
          collection: collection.key,
          recordId: id,
          action: 'create',
          resultVersion: 1,
          changedFields,
          policyId,
          causation: null,
        })

        return { receipt: { id, version: 1 }, replayed: false, changedFields }
      },
      scope,
      this.#transactionOptions(context)
    )
  }

  // --------------------------------------------------------------- update

  /** Updates a record. */
  async update(
    context: RequestContext,
    collectionKey: string,
    options: UpdateOptions
  ): Promise<WriteResult> {
    const collection = this.#requireCollection(context, collectionKey)
    const readPolicies = this.#requireReadable(context, collection)
    const writePolicies = applicablePolicies(this.#authorization(context), collection.key, 'update')
    if (writePolicies.length === 0) {
      throw new ServiceError('FORBIDDEN')
    }
    const expected = parseIfMatch(options.expectedEtag)
    const validated = this.#validated(options.body, collection, 'update')
    if (validated.fields.length === 0) {
      throw new ServiceError('VALIDATION_FAILED', {
        message: 'the update does not change anything',
      })
    }

    const scope = this.#scope(context)
    const substitutions = this.#substitutions(context)

    return await this.#options.store.write(
      async (unit) => {
        const current = await this.#lockRow(unit, context, collection, options.id)
        const representation = this.#representationOf(context, collection, current, readPolicies)
        if (!etagMatches(expected, etagOf({ data: representation }))) {
          throw new ServiceError('PRECONDITION_FAILED')
        }
        const resulting: Record<string, unknown> = { ...current, ...validated.values }
        const decision = selectWritePolicy(writePolicies, {
          action: 'update',
          writtenFields: validated.fields,
          currentRow: current,
          resultingRow: resulting,
          context: substitutions,
        })
        if (!decision.allowed || !decision.policy) {
          throw new ServiceError('FORBIDDEN')
        }
        const policyId = decision.policy.id
        await this.#checkReferences(unit, context, collection, validated.values)

        const now = new Date(this.#options.clock.now()).toISOString()
        const updateParameters = new Parameters()
        const assignments = validated.fields.map(
          (name) =>
            `"${name}" = ${updateParameters.add(validated.values[name], columnType(collection.fields[name]!))}`
        )
        assignments.push(`"updated_by" = ${updateParameters.add(context.principalId, 'uuid')}`)
        assignments.push(`"updated_at" = ${updateParameters.add(now, 'timestamptz')}`)
        assignments.push('"version" = "version" + 1')
        await unit.execute(
          `update ${collection.table} set ${assignments.join(', ')}
       where "id" = ${updateParameters.add(options.id, 'uuid')}
         and "tenant_id" = ${updateParameters.add(context.tenantId, 'uuid')}
         and "workspace_id" = ${updateParameters.add(context.workspaceId, 'uuid')}`,
          updateParameters.values
        )

        await this.#writeAuditAndEvent(unit, context, {
          collection: collection.key,
          recordId: options.id,
          action: 'update',
          resultVersion: Number(current.version ?? 1) + 1,
          changedFields: validated.fields,
          policyId,
          causation: null,
        })

        const updated = await this.#lockRow(unit, context, collection, options.id, false)
        const newRepresentation = this.#representationOf(context, collection, updated, readPolicies)
        return {
          representation: newRepresentation,
          etag: etagOf({ data: newRepresentation }),
          replayed: false,
          changedFields: validated.fields,
        }
      },
      scope,
      this.#transactionOptions(context)
    )
  }

  // --------------------------------------------------------------- delete

  /** Deletes a record. */
  async remove(
    context: RequestContext,
    collectionKey: string,
    options: DeleteOptions
  ): Promise<WriteResult> {
    const collection = this.#requireCollection(context, collectionKey)
    const readPolicies = this.#requireReadable(context, collection)
    const writePolicies = applicablePolicies(this.#authorization(context), collection.key, 'delete')
    if (writePolicies.length === 0) {
      throw new ServiceError('FORBIDDEN')
    }
    const expected = parseIfMatch(options.expectedEtag)
    const scope = this.#scope(context)
    const substitutions = this.#substitutions(context)

    return await this.#options.store.write(
      async (unit) => {
        const current = await this.#lockRow(unit, context, collection, options.id)
        const representation = this.#representationOf(context, collection, current, readPolicies)
        if (!etagMatches(expected, etagOf({ data: representation }))) {
          throw new ServiceError('PRECONDITION_FAILED')
        }
        const decision = selectWritePolicy(writePolicies, {
          action: 'delete',
          writtenFields: [],
          currentRow: current,
          context: substitutions,
        })
        if (!decision.allowed || !decision.policy) {
          throw new ServiceError('FORBIDDEN')
        }
        const policyId = decision.policy.id
        const parameters = new Parameters()
        await unit.execute(
          `delete from ${collection.table} where "id" = ${parameters.add(options.id, 'uuid')} and "tenant_id" = ${parameters.add(context.tenantId, 'uuid')} and "workspace_id" = ${parameters.add(context.workspaceId, 'uuid')}`,
          parameters.values
        )
        await this.#writeAuditAndEvent(unit, context, {
          collection: collection.key,
          recordId: options.id,
          action: 'delete',
          resultVersion: Number(current.version ?? 1),
          changedFields: Object.keys(collection.fields),
          policyId,
          causation: null,
        })
        return { replayed: false, changedFields: [] }
      },
      scope,
      this.#transactionOptions(context)
    )
  }

  // -------------------------------------------------------------- helpers

  /** The fields of a page. */
  #selectedFields(requested: readonly string[] | undefined, granted: readonly string[]): string[] {
    if (!requested || requested.length === 0) return [...granted]
    if (requested.length > MAX_SELECTED_FIELDS) {
      throw new ServiceError('INVALID_QUERY', {
        message: `at most ${MAX_SELECTED_FIELDS} fields may be selected`,
      })
    }
    const selected: string[] = []
    for (const field of requested) {
      if (!granted.includes(field)) {
        throw new ServiceError('INVALID_QUERY', { message: `the field "${field}" is not readable` })
      }
      if (!selected.includes(field)) selected.push(field)
    }
    return selected
  }

  /** The filter of a caller. */
  #clientFilter(
    filter: unknown,
    catalogue: Record<string, FieldDefinition>,
    filterable: readonly string[]
  ): FilterNode {
    if (filter === undefined || filter === null) return { kind: 'all' }
    let parsed: FilterNode
    try {
      parsed = parseFilter(filter, { fields: catalogue })
    } catch (error) {
      throw new ServiceError('INVALID_QUERY', {
        message: error instanceof Error ? error.message : 'the filter is not valid',
      })
    }
    for (const field of referencedFields(parsed)) {
      if (!filterable.includes(field)) {
        throw new ServiceError('INVALID_QUERY', {
          message: `the field "${field}" cannot be used in a filter`,
        })
      }
    }
    return parsed
  }

  /** The sort of a caller. */
  #sortOf(sort: readonly string[] | undefined, filterable: readonly string[]): SortColumn[] {
    const columns: SortColumn[] = []
    for (const entry of sort ?? []) {
      if (columns.length >= MAX_SORT_FIELDS) {
        throw new ServiceError('INVALID_QUERY', {
          message: `at most ${MAX_SORT_FIELDS} fields may be sorted`,
        })
      }
      const descending = entry.startsWith('-')
      const field = descending ? entry.slice(1) : entry
      if (field !== 'id' && !filterable.includes(field)) {
        throw new ServiceError('INVALID_QUERY', {
          message: `the field "${field}" cannot be used in a sort`,
        })
      }
      if (columns.some((column) => column.field === field)) continue
      columns.push({ field, descending })
    }
    if (columns.length === 0) columns.push({ field: 'id', descending: false })
    if (!columns.some((column) => column.field === 'id')) {
      columns.push({ field: 'id', descending: false })
    }
    return columns
  }

  /** The relations of a page. */
  #includes(included: readonly string[] | undefined, relations: readonly string[]): string[] {
    const result: string[] = []
    for (const name of included ?? []) {
      if (result.length >= MAX_INCLUDES) {
        throw new ServiceError('INVALID_QUERY', {
          message: `at most ${MAX_INCLUDES} relations may be included`,
        })
      }
      if (!relations.includes(name)) {
        throw new ServiceError('INVALID_QUERY', {
          message: `the relation "${name}" is not readable`,
        })
      }
      if (!result.includes(name)) result.push(name)
    }
    return result
  }

  /** The body of a write, validated. */
  #validated(body: unknown, collection: CollectionDefinition, mode: 'create' | 'update') {
    try {
      return validateBody(body, collection, mode)
    } catch (error) {
      if (error instanceof BodyError) {
        throw new ServiceError('VALIDATION_FAILED', {
          message: error.message,
          details: error.details,
        })
      }
      throw error
    }
  }

  /** The row of a record, locked for a write. */
  async #lockRow(
    unit: UnitOfWork,
    context: RequestContext,
    collection: CollectionDefinition,
    id: string,
    lock = true
  ): Promise<RecordRow> {
    const row = await unit.queryOne<RecordRow>(
      `select t.* from ${collection.table} t
       where t."id" = $1::uuid and t."tenant_id" = $2::uuid and t."workspace_id" = $3::uuid${
         lock ? ' for update' : ''
       }`,
      [id, context.tenantId, context.workspaceId]
    )
    if (!row) {
      throw new ServiceError('NOT_FOUND')
    }
    return { ...row }
  }

  /**
   * The representation of a row, with the fields the caller may see.
   *
   * The representation is built exactly like the one of a read: the
   * fields a policy that matches the row grants are the fields of the
   * answer, and the values are normalized the way the projection of a
   * read normalizes them. The validator of a record is therefore the
   * same whether the record was read or locked.
   */
  #representationOf(
    context: RequestContext,
    collection: CollectionDefinition,
    row: RecordRow,
    policies: readonly Policy[]
  ): Record<string, unknown> {
    const substitutions = this.#substitutions(context)
    const matching = policies.filter((policy) => evaluateFilter(policy.where, row, substitutions))
    const granted = new Set<string>()
    for (const policy of matching) {
      for (const field of policy.fields) granted.add(field)
    }
    const representation: Record<string, unknown> = {
      id: String(row.id),
      version: Number(row.version ?? 1),
    }
    for (const name of Object.keys(collection.fields)) {
      if (!granted.has(name)) continue
      representation[name] = normalizeValue(collection.fields[name]!, row[name])
    }
    for (const name of EXPOSED_SERVER_FIELDS) {
      if (name === 'id' || name === 'version') continue
      if (!granted.has(name)) continue
      representation[name] = normalizeValue(serverDefinition(name), row[name])
    }
    return representation
  }

  /**
   * Checks the references of a write.
   *
   * A reference has to be readable by the caller in the same tenant and
   * workspace. A reference that is not readable is refused with a generic
   * error: the answer never says whether the target exists elsewhere.
   */
  async #checkReferences(
    unit: UnitOfWork,
    context: RequestContext,
    collection: CollectionDefinition,
    values: Record<string, unknown>
  ): Promise<void> {
    for (const relation of Object.values(collection.relations)) {
      if (relation.type !== 'many-to-one') continue
      const value = values[relation.field]
      if (value === undefined || value === null) continue
      const target = this.collection(context, relation.target)
      if (!target) continue
      const targetPolicies = this.#readPolicies(context, target.key)
      if (targetPolicies.length === 0) {
        throw new ServiceError('INVALID_REFERENCE')
      }
      const catalogue = catalogueFor(target)
      const parameters = new Parameters()
      const scopeClause = `t.tenant_id = ${parameters.add(context.tenantId, 'uuid')} and t.workspace_id = ${parameters.add(context.workspaceId, 'uuid')}`
      const predicate = rowPredicate(
        targetPolicies,
        parameters,
        catalogue,
        this.#substitutions(context)
      )
      const idClause = `t."id" = ${parameters.add(String(value), 'uuid')}`
      const rows = await unit.query<{ id: string }>(
        `select t."id"::text as id from ${target.table} t where ${scopeClause} and ${idClause} and (${predicate})`,
        parameters.values
      )
      if (rows.length === 0) {
        throw new ServiceError('INVALID_REFERENCE')
      }
    }
  }

  /** Writes the audit entry and the event of a mutation. */
  async #writeAuditAndEvent(
    unit: UnitOfWork,
    context: RequestContext,
    mutation: {
      collection: string
      recordId: string
      action: 'create' | 'update' | 'delete'
      resultVersion: number
      changedFields: readonly string[]
      policyId: string
      causation: { eventId: string; depth: number; principalId: string } | null
    }
  ): Promise<void> {
    const occurredAt = new Date(this.#options.clock.now()).toISOString()
    const eventId = randomUUID()
    await this.#options.audit.append(
      {
        id: randomUUID(),
        occurredAt,
        principalId: context.principalId,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        routeId: context.routeId,
        requestId: context.requestId,
        source: context.source,
        collection: mutation.collection,
        recordId: mutation.recordId,
        action: mutation.action,
        resultVersion: mutation.resultVersion,
        changedFields: mutation.changedFields,
        policyBundleVersion: context.catalog.bundle.bundleVersion,
        policyId: mutation.policyId,
        causationEventId: context.causationId ?? null,
        causationPrincipalId: context.causationPrincipalId ?? null,
      },
      unit
    )
    const eventType =
      mutation.action === 'create'
        ? 'record.created'
        : mutation.action === 'update'
          ? 'record.updated'
          : 'record.deleted'
    const subscribers = this.#options.subscribers.filter((subscriber) => {
      const collections = subscriber.filter.collections
      if (collections && !collections.includes(mutation.collection)) return false
      const types = subscriber.filter.types
      if (types && !types.includes(eventType)) return false
      return true
    })
    await this.#options.outbox.append(
      {
        version: 1,
        eventId,
        type: eventType,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        collection: mutation.collection,
        recordId: mutation.recordId,
        recordVersion: mutation.resultVersion,
        actorId: context.principalId,
        occurredAt,
        changedFields: mutation.changedFields,
        correlationId: context.requestId,
        causationId: context.causationId ?? null,
        causationDepth: context.causationDepth ?? 0,
      },
      subscribers,
      unit
    )
  }

  /** Adds the relations of the rows to their payload. */
  async #hydrate(
    unit: UnitOfWork,
    context: RequestContext,
    collection: CollectionDefinition,
    rows: readonly SelectedRow[],
    include: readonly string[]
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = []
    let relatedTotal = 0
    for (const row of rows) {
      const payload: Record<string, unknown> = { id: row.id, version: row.version, ...row.payload }
      for (const name of include) {
        if (!row.relations.includes(name)) continue
        const relation = collection.relations[name]
        if (!relation) continue
        const target = this.collection(context, relation.target)
        if (!target) continue
        const targetPolicies = this.#readPolicies(context, target.key)
        if (targetPolicies.length === 0) continue
        if (relation.type === 'many-to-one') {
          const value = row.foreignKeys[relation.field]
          if (value === undefined || value === null) {
            payload[name] = null
            continue
          }
          const found = await this.#fetchRelated(unit, context, target, targetPolicies, 'id', [
            String(value),
          ])
          relatedTotal += found.length
          if (relatedTotal > MAX_RELATED_ROWS_PER_RESPONSE) {
            throw new ServiceError('RESULT_TOO_LARGE')
          }
          payload[name] = found[0]?.representation ?? null
          continue
        }
        const found = await this.#fetchRelated(
          unit,
          context,
          target,
          targetPolicies,
          relation.field,
          [row.id]
        )
        if (found.length > MAX_RELATED_ROWS_PER_ROOT) {
          throw new ServiceError('RESULT_TOO_LARGE')
        }
        relatedTotal += found.length
        if (relatedTotal > MAX_RELATED_ROWS_PER_RESPONSE) {
          throw new ServiceError('RESULT_TOO_LARGE')
        }
        payload[name] = found
          .filter((entry) => entry.parent === row.id)
          .map((entry) => entry.representation)
      }
      out.push(payload)
    }
    return out
  }

  /** Reads the related rows of a relation. */
  async #fetchRelated(
    unit: UnitOfWork,
    context: RequestContext,
    target: CollectionDefinition,
    policies: readonly Policy[],
    field: string,
    values: readonly string[]
  ): Promise<{ representation: Record<string, unknown>; parent: string }[]> {
    const catalogue = catalogueFor(target)
    const granted = this.#grantedFields(context, target).filter((name) => catalogue[name])
    const parameters = new Parameters()
    const scopeClause = `t.tenant_id = ${parameters.add(context.tenantId, 'uuid')} and t.workspace_id = ${parameters.add(context.workspaceId, 'uuid')}`
    const predicate = rowPredicate(policies, parameters, catalogue, this.#substitutions(context))
    const fieldClause = `t."${field}" = any(${parameters.add([...values], 'uuid[]')})`
    const sql = buildSelect({
      table: target.table,
      scopeClause,
      predicate,
      filterClause: fieldClause,
      keyset: 'true',
      policies,
      catalogue,
      substitutions: this.#substitutions(context),
      parameters,
      selectedFields: granted,
      foreignKeys: [field],
      relations: [],
      sort: [{ field: 'id', descending: false }],
      limit: MAX_RELATED_ROWS_PER_RESPONSE + 1,
      withLimit: true,
    })
    const raw = await unit.query<Record<string, unknown>>(sql, parameters.values)
    const rows = raw.map((row) => mapRow(row, [{ field: 'id', descending: false }], [field]))
    if (rows.length > MAX_RELATED_ROWS_PER_RESPONSE) {
      throw new ServiceError('RESULT_TOO_LARGE')
    }
    return rows.map((row) => ({
      representation: { id: row.id, version: row.version, ...row.payload },
      parent: String(row.foreignKeys[field] ?? ''),
    }))
  }
}

/** The names of the fields a filter uses. */
function referencedFields(node: FilterNode): string[] {
  if (node.kind === 'all') return []
  if (node.kind === 'cmp') return [node.field]
  if (node.kind === 'not') return referencedFields(node.node)
  return node.nodes.flatMap((entry) => referencedFields(entry))
}

/** The options of the statement of a read. */
interface SelectOptions {
  table: string
  scopeClause: string
  predicate: string
  filterClause: string
  keyset: string
  policies: readonly Policy[]
  catalogue: Record<string, FieldDefinition>
  substitutions: SubstitutionContext
  parameters: Parameters
  selectedFields: readonly string[]
  foreignKeys: readonly string[]
  relations: readonly string[]
  sort: readonly SortColumn[]
  limit: number
  withLimit: boolean
}

/**
 * Builds the statement of a read.
 *
 * The statement computes, for every policy, whether the policy matches
 * the row. The payload of the row is built from those flags: a field is
 * added only when a policy that matched the row grants it, so a value
 * the caller may not see never leaves the database.
 */
function buildSelect(options: SelectOptions): string {
  const { parameters, policies, catalogue, substitutions } = options
  const parts: string[] = []
  parts.push('t."id"::text as id')
  parts.push('t."version"::int as version')
  options.selectedFields.forEach((field, index) => {
    parts.push(`${jsonExpression(field, catalogue[field]!)} as c${index}`)
  })
  options.foreignKeys.forEach((field, index) => {
    parts.push(`t."${field}"::text as f${index}`)
  })
  if (options.sort.length > 0) {
    parts.push(sortColumns(options.sort))
  }
  policies.forEach((policy, index) => {
    parts.push(
      `(${compileInto(policy.where, parameters, { fields: catalogue, alias: 't', substitutions })}) as m${index}`
    )
  })

  const selected: string[] = ['id', 'version']
  options.selectedFields.forEach((_field, index) => {
    selected.push(`c${index}`)
  })
  options.foreignKeys.forEach((_field, index) => {
    selected.push(`f${index}`)
  })
  if (options.sort.length > 0) {
    options.sort.forEach((_column, index) => {
      selected.push(`n${index}`, `s${index}`)
    })
  }

  const payloadParts = options.selectedFields.map((field, index) => {
    const granting = policies
      .map((policy, policyIndex) => (policy.fields.includes(field) ? `m${policyIndex}` : null))
      .filter((entry): entry is string => entry !== null)
    const condition = granting.length === 0 ? 'false' : `(${granting.join(' or ')})`
    return `case when ${condition} then jsonb_build_object('${field}', c${index}) else '{}'::jsonb end`
  })
  const payload = payloadParts.length === 0 ? `'{}'::jsonb` : payloadParts.join(' || ')

  const relationParts = options.relations.map((name) => {
    const granting = policies
      .map((policy, policyIndex) => (policy.fields.includes(name) ? `m${policyIndex}` : null))
      .filter((entry): entry is string => entry !== null)
    const condition = granting.length === 0 ? 'false' : `(${granting.join(' or ')})`
    return `case when ${condition} then jsonb_build_object('${name}', true) else '{}'::jsonb end`
  })
  const relations = relationParts.length === 0 ? `'{}'::jsonb` : relationParts.join(' || ')

  const outerOrder =
    options.sort.length === 0
      ? ''
      : `order by ${options.sort
          .map((column, index) => `n${index} asc, s${index} ${column.descending ? 'desc' : 'asc'}`)
          .join(', ')}`

  const where =
    policies.length === 0 ? 'false' : `(${policies.map((_p, index) => `m${index}`).join(' or ')})`

  return `with base as (
  select
    ${parts.join(',\n    ')}
  from ${options.table} t
  where ${options.scopeClause} and (${options.predicate}) and (${options.filterClause}) and (${options.keyset})
)
select ${selected.join(', ')}, (${payload}) as payload, (${relations}) as relations
from base
where ${where}
${outerOrder}${options.withLimit ? `\nlimit ${options.limit}` : ''}`
}

/**
 * Maps a row of a statement to the row of the domain.
 *
 * The position of the row is the tuple of the sort: it is the position
 * of the page that follows it.
 */
function mapRow(
  row: Record<string, unknown>,
  sort: readonly SortColumn[],
  foreignKeys: readonly string[]
): SelectedRow {
  const payload = (row.payload ?? {}) as Record<string, unknown>
  const relations = (row.relations ?? {}) as Record<string, unknown>
  const position: unknown[] = []
  sort.forEach((_column, index) => {
    position.push(row[`n${index}`] ?? 0)
    position.push(row[`s${index}`] ?? null)
  })
  const keys: Record<string, unknown> = {}
  foreignKeys.forEach((field, index) => {
    keys[field] = row[`f${index}`] ?? null
  })
  return {
    id: String(row.id),
    version: Number(row.version ?? 1),
    payload,
    relations: Object.keys(relations).filter((name) => relations[name] === true),
    position,
    foreignKeys: keys,
  }
}

/**
 * Reports whether a function of an aggregate is defined for a type.
 *
 * The sum and the average are the functions of the numbers, and the
 * minimum and the maximum are the functions of the values that have an
 * order. The rules are the rules of the operators of the filters: a
 * function that is not defined for a type is refused before the
 * statement runs.
 */
function supportsAggregate(fn: AggregateFunction, definition: FieldDefinition): boolean {
  if (fn === 'sum' || fn === 'avg') {
    return definition.type === 'integer' || definition.type === 'decimal'
  }
  return ['string', 'text', 'integer', 'decimal', 'uuid', 'timestamp', 'enum'].includes(
    definition.type
  )
}

/**
 * Maps the row of an aggregate to the group it holds.
 *
 * The values of the group and the values of the metrics are the values
 * of the rows: a minimum of a field is the field as a row carries it.
 */
function mapAggregate(
  row: Record<string, unknown>,
  groupBy: readonly string[],
  metrics: readonly AggregateMetricColumn[]
): AggregateGroup {
  const group: Record<string, unknown> = {}
  groupBy.forEach((field, index) => {
    group[field] = row[`g${index}`] ?? null
  })
  const result: {
    group: Record<string, unknown>
    count: number
    sum?: Record<string, string | null>
    avg?: Record<string, string | null>
    min?: Record<string, unknown>
    max?: Record<string, unknown>
  } = {
    group,
    count: Number(row.count ?? '0'),
  }
  for (const metric of metrics) {
    const value = row[`${metric.function}:${metric.field}`] ?? null
    if (metric.function === 'sum') {
      result.sum = { ...(result.sum ?? {}), [metric.field]: value === null ? null : String(value) }
      continue
    }
    if (metric.function === 'avg') {
      result.avg = { ...(result.avg ?? {}), [metric.field]: value === null ? null : String(value) }
      continue
    }
    if (metric.function === 'min') {
      result.min = { ...(result.min ?? {}), [metric.field]: value }
      continue
    }
    result.max = { ...(result.max ?? {}), [metric.field]: value }
  }
  return result
}

/** The type of a column of the database. */
function columnType(definition: FieldDefinition): string {
  switch (definition.type) {
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
    default:
      return 'text'
  }
}

/** The definition of a server maintained field. */
function serverDefinition(name: string): FieldDefinition {
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
 * Normalizes a value of a row the way the projection of a read does.
 *
 * The two normalizations have to agree: the validator of a record is
 * computed from one and from the other, and a difference would refuse
 * every write of a record that was read before.
 */
function normalizeValue(definition: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (definition.type) {
    case 'timestamp':
      if (value instanceof Date) return value.toISOString()
      return value
    case 'integer':
      return typeof value === 'number' ? value : Number(value)
    case 'decimal':
      return typeof value === 'string' ? value : String(value)
    case 'json':
      return value
    default:
      return value
  }
}

/** Reports whether an error is a unique violation. */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: string }).code
  return code === '23505'
}
