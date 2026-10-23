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
  filterSortIntersection,
  parseFilter,
  readableUnion,
  selectWritePolicy,
  writeCandidates,
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
  type RollbackOptions,
  type Scope,
  type TransactionOptions,
  type UnitOfWork,
  type UpdateOptions,
  type VersionEntry,
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
  MAX_VERSIONS_PER_RECORD,
  EXPANSION_CHUNK_BYTES,
  EXPANSION_FIRST_CHUNK_ROWS,
  EXPANSION_MAX_CHUNK_ROWS,
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
import { ResponseBudget } from './budget'
import {
  buildCreateGuard,
  buildDeleteGuard,
  buildDeleteStatement,
  buildUpdateGuard,
  buildUpdateStatement,
} from './write-guard'
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
  orderBy,
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
  /** The size of the payload, in bytes, as the database measured it. */
  size: number
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
        let claim: { record_id: string }[]
        try {
          claim = await unit.query<{ record_id: string }>(
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
        } catch (error) {
          // The claim waits for the transaction that holds the key, and
          // the wait is bounded by the lock timeout. The only conflict
          // of this statement is that wait: the answer of a wait that
          // was not resolved is the answer of an operation that is in
          // progress.
          if (error instanceof ServiceError && error.code === 'CONFLICT') {
            throw new ServiceError('OPERATION_IN_PROGRESS', { headers: { 'Retry-After': '1' } })
          }
          throw error
        }
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

        const parameters = new Parameters()
        // The guard of the write: the statement carries the predicates
        // of the policies, and the database evaluates them over the row
        // before the change and over the row after it.
        const guard = buildCreateGuard({
          collection,
          catalogue: catalogueFor(collection),
          policies: writeCandidates(policies, validated.fields),
          substitutions,
          parameters,
          values,
          id,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          principalId: context.principalId,
          now,
        })
        const columnList = guard.columns.map((name) => `"${name}"`).join(', ')
        const selection = guard.columns.map((name) => `post."${name}"`).join(', ')
        try {
          const written = await unit.execute(
            `${guard.prefix}insert into ${collection.table} (${columnList}) select ${selection} from post where (${guard.guard})`,
            parameters.values
          )
          if (written === 0) {
            // The guard refused the write. The statement of the database
            // and the evaluation in memory do not agree, and the
            // statement is the one that decides: the write is refused.
            throw new ServiceError('FORBIDDEN')
          }
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
    const scope = this.#scope(context)

    return await this.#options.store.write(
      async (unit) =>
        await this.#applyUpdate(unit, context, collection, {
          id: options.id,
          body: options.body,
          expectedEtag: options.expectedEtag,
        }),
      scope,
      this.#transactionOptions(context)
    )
  }

  /**
   * Applies an update inside the transaction of the request.
   *
   * The method is the body of the update, and the rollback of a version
   * is an update: the two share the guard of the write, the policies of
   * the deployment, the audit entry, the event and the image of the
   * version that the change supersedes.
   */
  async #applyUpdate(
    unit: UnitOfWork,
    context: RequestContext,
    collection: CollectionDefinition,
    options: {
      id: string
      body: Record<string, unknown>
      expectedEtag: string
      /** The version that the change restores, when it is a rollback. */
      restoredFrom?: number
    }
  ): Promise<WriteResult> {
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

    const substitutions = this.#substitutions(context)

    const current = await this.#lockRow(unit, context, collection, options.id, readPolicies)
    const representation = this.#representationOf(collection, current, readPolicies)
    if (!etagMatches(expected, etagOf({ data: representation }))) {
      throw new ServiceError('PRECONDITION_FAILED')
    }
    const now = new Date(this.#options.clock.now()).toISOString()
    // The row after the change: the fields the client writes, the
    // fields the server maintains and the fields the row already
    // had. It is the row that the statement of the update produces,
    // and the check of the policies is evaluated over it.
    const resulting: Record<string, unknown> = {
      ...current,
      ...validated.values,
      updated_by: context.principalId,
      updated_at: now,
      version: Number(current.version ?? 1) + 1,
    }
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

    const parameters = new Parameters()
    const scopeId = parameters.add(options.id, 'uuid')
    const scopeTenant = parameters.add(context.tenantId, 'uuid')
    const scopeWorkspace = parameters.add(context.workspaceId, 'uuid')
    const scopeClause = `t."id" = ${scopeId} and t."tenant_id" = ${scopeTenant} and t."workspace_id" = ${scopeWorkspace}`
    const guard = buildUpdateGuard({
      collection,
      catalogue: catalogueFor(collection),
      policies: writeCandidates(writePolicies, validated.fields),
      substitutions,
      parameters,
      written: validated.values,
      principalId: context.principalId,
      now,
      scopeClause,
      ...(collection.versions
        ? {
            history: {
              table: collection.versions.table,
              changedFields: validated.fields,
              principalId: context.principalId,
              now,
              ...(options.restoredFrom === undefined ? {} : { restoredFrom: options.restoredFrom }),
            },
          }
        : {}),
    })
    const assignments = validated.fields.map((name) => `"${name}" = ${guard.placeholders[name]}`)
    assignments.push(`"updated_by" = ${guard.placeholders.updated_by}`)
    assignments.push(`"updated_at" = ${guard.placeholders.updated_at}`)
    assignments.push('"version" = "version" + 1')
    const condition = `"id" = ${scopeId}
       and "tenant_id" = ${scopeTenant}
       and "workspace_id" = ${scopeWorkspace}
       and exists (select 1 from ${guard.sources} where (${guard.guard}))`
    // The image of the version that the change supersedes is written
    // by the statement of the change itself: the image and the change
    // commit together, and a change that the guard refuses writes no
    // image.
    const written = await unit.execute(
      buildUpdateStatement({ guard, collection, assignments, condition }),
      parameters.values
    )
    if (written === 0) {
      // The guard refused the write. The statement of the database
      // and the evaluation in memory do not agree, and the statement
      // is the one that decides: the write is refused.
      throw new ServiceError('FORBIDDEN')
    }

    await this.#writeAuditAndEvent(unit, context, {
      collection: collection.key,
      recordId: options.id,
      action: 'update',
      resultVersion: Number(current.version ?? 1) + 1,
      changedFields: validated.fields,
      policyId,
      causation: null,
    })

    const updated = await this.#lockRow(unit, context, collection, options.id, readPolicies, false)
    const newRepresentation = this.#representationOf(collection, updated, readPolicies)
    return {
      representation: newRepresentation,
      etag: etagOf({ data: newRepresentation }),
      replayed: false,
      changedFields: validated.fields,
    }
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
        const current = await this.#lockRow(unit, context, collection, options.id, readPolicies)
        const representation = this.#representationOf(collection, current, readPolicies)
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
        const now = new Date(this.#options.clock.now()).toISOString()
        const parameters = new Parameters()
        const scopeId = parameters.add(options.id, 'uuid')
        const scopeTenant = parameters.add(context.tenantId, 'uuid')
        const scopeWorkspace = parameters.add(context.workspaceId, 'uuid')
        const scopeClause = `t."id" = ${scopeId} and t."tenant_id" = ${scopeTenant} and t."workspace_id" = ${scopeWorkspace}`
        // The guard of the write: the predicates of the policies are
        // evaluated by the database, over the row that the delete
        // removes.
        const guard = buildDeleteGuard({
          collection,
          catalogue: catalogueFor(collection),
          policies: writeCandidates(writePolicies, []),
          substitutions,
          parameters,
          scopeClause,
          ...(collection.versions
            ? {
                history: {
                  table: collection.versions.table,
                  changedFields: Object.keys(collection.fields),
                  principalId: context.principalId,
                  now,
                },
              }
            : {}),
        })
        // The image of the version that the deletion supersedes is
        // written by the statement of the deletion itself: the image
        // and the deletion commit together, and the image is the
        // tombstone of the record.
        const removed = await unit.execute(
          buildDeleteStatement({
            guard,
            collection,
            condition: `t."id" = ${scopeId}
         and t."tenant_id" = ${scopeTenant}
         and t."workspace_id" = ${scopeWorkspace}
         and (${guard.guard})`,
          }),
          parameters.values
        )
        if (removed === 0) {
          // The guard refused the write. The statement of the database
          // and the evaluation in memory do not agree, and the statement
          // is the one that decides: the write is refused.
          throw new ServiceError('FORBIDDEN')
        }
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

  // -------------------------------------------------------------- versions

  /**
   * The history of the versions of a record.
   *
   * The list holds the versions that are not the current one: the
   * current version of a record is the row of the collection itself. A
   * record that was deleted holds its tombstone, the image of its last
   * version with the operation `delete`.
   *
   * The versions that the caller may not read are not in the list: the
   * predicates of the policies are evaluated by the database over the
   * image of every version, exactly as they are over the record.
   */
  async versions(
    context: RequestContext,
    collectionKey: string,
    id: string
  ): Promise<{ data: readonly VersionEntry[] }> {
    const collection = this.#requireCollection(context, collectionKey)
    const policies = this.#requireReadable(context, collection)
    const history = collection.versions
    if (!history) {
      // The collection does not keep a history: the answer is the
      // answer of a collection that does not exist.
      throw new ServiceError('NOT_FOUND')
    }
    const catalogue = catalogueFor(collection)
    const substitutions = this.#substitutions(context)
    const scope = this.#scope(context)

    return await this.#options.store.read(async (unit) => {
      const parameters = new Parameters()
      const scopeClause = `t.tenant_id = ${parameters.add(context.tenantId, 'uuid')} and t.workspace_id = ${parameters.add(context.workspaceId, 'uuid')}`
      const idClause = `t."id" = ${parameters.add(id, 'uuid')}`
      const predicate = rowPredicate(policies, parameters, catalogue, substitutions)
      const rows = await unit.query<{
        version: number
        operation: string
        changed_fields: string[]
        superseded_at: Date
        superseded_by: string
      }>(
        `select t."version"::int as version,
                t."operation" as operation,
                t."changed_fields" as changed_fields,
                t."superseded_at" as superseded_at,
                t."superseded_by"::text as superseded_by
           from ${history.table} t
          where ${scopeClause} and ${idClause} and (${predicate})
          order by t."version" desc
          limit ${MAX_VERSIONS_PER_RECORD}`,
        parameters.values
      )
      const data = rows.map((row) => ({
        version: Number(row.version),
        operation: row.operation === 'delete' ? ('delete' as const) : ('update' as const),
        changedFields: row.changed_fields ?? [],
        supersededAt: new Date(row.superseded_at).toISOString(),
        supersededBy: row.superseded_by,
      }))
      return { data }
    }, scope)
  }

  /**
   * One version of a record.
   *
   * The version is read with the same statement and the same policies
   * as a record: a version that the caller may not read answers `404`,
   * and the fields that the policies do not grant are not in the
   * answer.
   */
  async version(
    context: RequestContext,
    collectionKey: string,
    id: string,
    version: number
  ): Promise<{ representation: Record<string, unknown>; etag: string }> {
    const collection = this.#requireCollection(context, collectionKey)
    const policies = this.#requireReadable(context, collection)
    const history = collection.versions
    if (!history) {
      throw new ServiceError('NOT_FOUND')
    }
    const scope = this.#scope(context)

    return await this.#options.store.read(async (unit) => {
      // The current version of a record is the row of the collection;
      // the other versions are the images of the history.
      const row =
        (await this.#versionImage(
          unit,
          context,
          collection,
          policies,
          id,
          version,
          history.table
        )) ??
        (await this.#versionImage(
          unit,
          context,
          collection,
          policies,
          id,
          version,
          collection.table
        ))
      if (!row) {
        throw new ServiceError('NOT_FOUND')
      }
      const representation = this.#representationOf(collection, row, policies)
      return { representation, etag: etagOf({ data: representation }) }
    }, scope)
  }

  /**
   * Rolls a record back to one of its versions.
   *
   * The rollback is a write and not a privileged command: the version
   * that is restored is read with the policies of the deployment, and
   * the write that restores it is authorized by the same policies as
   * any other update. A version that the caller may not read answers
   * `404`, and a version that the policies forbid to write answers
   * `403`.
   *
   * The version of the record never moves back: the rollback is a
   * change like any other, and the record holds the version that
   * follows the one it had. A record that was deleted is restored with
   * the image of the version, and its version follows the one of its
   * tombstone.
   */
  async rollback(
    context: RequestContext,
    collectionKey: string,
    options: RollbackOptions
  ): Promise<WriteResult> {
    const collection = this.#requireCollection(context, collectionKey)
    const policies = this.#requireReadable(context, collection)
    const history = collection.versions
    if (!history) {
      throw new ServiceError('NOT_FOUND')
    }
    const expected = parseIfMatch(options.expectedEtag)
    const scope = this.#scope(context)

    return await this.#options.store.write(
      async (unit) => {
        const live = await this.#readRow(unit, context, collection, options.id, policies, true)
        // The validator is the one of the current state of the record:
        // the validator of the record, or the one of its tombstone when
        // the record was deleted. The precondition is checked before
        // anything else: a validator that is stale is stale whatever
        // the version of the rollback.
        const current =
          live ??
          (await this.#versionImage(
            unit,
            context,
            collection,
            policies,
            options.id,
            null,
            history.table
          ))
        if (!current) {
          throw new ServiceError('NOT_FOUND')
        }
        const currentRepresentation = this.#representationOf(collection, current, policies)
        if (!etagMatches(expected, etagOf({ data: currentRepresentation }))) {
          throw new ServiceError('PRECONDITION_FAILED')
        }
        const target = await this.#versionImage(
          unit,
          context,
          collection,
          policies,
          options.id,
          options.version,
          history.table
        )
        if (!target) {
          // The version is the current one of the record: the record
          // already holds it, and a rollback to itself changes nothing.
          if (live && Number(live.version) === options.version) {
            throw new ServiceError('CONFLICT', {
              message: 'the record already holds that version',
            })
          }
          throw new ServiceError('NOT_FOUND')
        }
        if (live) {
          const body = this.#diffOf(collection, target, live)
          if (Object.keys(body).length === 0) {
            throw new ServiceError('CONFLICT', {
              message: 'the record already holds that version',
            })
          }
          return await this.#applyUpdate(unit, context, collection, {
            id: options.id,
            body,
            expectedEtag: expected,
            restoredFrom: options.version,
          })
        }
        // The record was deleted: the rollback restores it with the
        // image of the version, and its version follows the one of the
        // tombstone.
        return await this.#restore(unit, context, collection, target, Number(current.version) + 1)
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

  /**
   * The row of a record, locked for a write.
   *
   * The statement computes the flags of the policies of the read: the
   * predicates of the policies are compiled by the same compiler as
   * the queries, and the database evaluates them over the row that it
   * locks. The representation of the record is built from those flags,
   * and it is the same representation that a read of the record builds
   * with the projection of the database.
   */
  async #lockRow(
    unit: UnitOfWork,
    context: RequestContext,
    collection: CollectionDefinition,
    id: string,
    policies: readonly Policy[],
    lock = true
  ): Promise<RecordRow> {
    const row = await this.#readRow(unit, context, collection, id, policies, lock)
    if (!row) {
      throw new ServiceError('NOT_FOUND')
    }
    return row
  }

  /**
   * The row of a record, or nothing when it does not exist.
   *
   * The method is the row of the lock without the refusal: the rollback
   * of a version reads the row to know whether the record exists, and
   * a record that was deleted is restored instead of updated.
   */
  async #readRow(
    unit: UnitOfWork,
    context: RequestContext,
    collection: CollectionDefinition,
    id: string,
    policies: readonly Policy[],
    lock: boolean
  ): Promise<RecordRow | null> {
    const catalogue = catalogueFor(collection)
    const substitutions = this.#substitutions(context)
    const parameters = new Parameters()
    const idPlaceholder = parameters.add(id, 'uuid')
    const tenantPlaceholder = parameters.add(context.tenantId, 'uuid')
    const workspacePlaceholder = parameters.add(context.workspaceId, 'uuid')
    const flags = policies.map(
      (policy, index) =>
        `(${compileInto(policy.where, parameters, { fields: catalogue, alias: 't', substitutions })}) as m${index}`
    )
    const row = await unit.queryOne<RecordRow>(
      `select t.*${flags.length > 0 ? `, ${flags.join(', ')}` : ''} from ${collection.table} t
       where t."id" = ${idPlaceholder} and t."tenant_id" = ${tenantPlaceholder} and t."workspace_id" = ${workspacePlaceholder}${
         lock ? ' for update' : ''
       }`,
      parameters.values
    )
    return row ? { ...row } : null
  }

  /**
   * The image of one version of a record.
   *
   * The image is the row of the table of the versions, or the row of
   * the collection when the version is the current one. The predicates
   * of the policies are evaluated by the database over the image: a
   * version that the caller may not read is not found.
   *
   * A version of nothing is the last version of the record.
   */
  async #versionImage(
    unit: UnitOfWork,
    context: RequestContext,
    collection: CollectionDefinition,
    policies: readonly Policy[],
    id: string,
    version: number | null,
    table: string
  ): Promise<RecordRow | null> {
    const catalogue = catalogueFor(collection)
    const substitutions = this.#substitutions(context)
    const parameters = new Parameters()
    const idPlaceholder = parameters.add(id, 'uuid')
    const tenantPlaceholder = parameters.add(context.tenantId, 'uuid')
    const workspacePlaceholder = parameters.add(context.workspaceId, 'uuid')
    const versionClause =
      version === null ? '' : `and t."version" = ${parameters.add(version, 'integer')}`
    const flags = policies.map(
      (policy, index) =>
        `(${compileInto(policy.where, parameters, { fields: catalogue, alias: 't', substitutions })}) as m${index}`
    )
    const predicate = rowPredicate(policies, parameters, catalogue, substitutions)
    const row = await unit.queryOne<RecordRow>(
      `select t.*${flags.length > 0 ? `, ${flags.join(', ')}` : ''} from ${table} t
       where t."id" = ${idPlaceholder} and t."tenant_id" = ${tenantPlaceholder} and t."workspace_id" = ${workspacePlaceholder}
         ${versionClause} and (${predicate})
       order by t."version" desc
       limit 1`,
      parameters.values
    )
    return row ? { ...row } : null
  }

  /**
   * The fields that differ between a version and the current row.
   *
   * The rollback writes the fields that changed and leaves the others
   * alone: the write is the smallest one that puts the record back at
   * the version, and it is authorized by the policies of the deployment
   * like any other write.
   */
  #diffOf(
    collection: CollectionDefinition,
    target: Record<string, unknown>,
    current: Record<string, unknown>
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {}
    for (const [name, definition] of Object.entries(collection.fields)) {
      const before = normalizeValue(definition, target[name] ?? null)
      const now = normalizeValue(definition, current[name] ?? null)
      if (sameValue(before, now)) continue
      body[name] = before
    }
    return body
  }

  /**
   * Restores a record that was deleted.
   *
   * The restoration is a creation: the policies of the deployment are
   * evaluated over the image that is restored, exactly as they are over
   * the image of a creation. The version of the record follows the one
   * of the tombstone: the counter never moves back, and the identity of
   * the record and the instant of its creation are the ones it had.
   */
  async #restore(
    unit: UnitOfWork,
    context: RequestContext,
    collection: CollectionDefinition,
    image: Record<string, unknown>,
    version: number
  ): Promise<WriteResult> {
    const policies = applicablePolicies(this.#authorization(context), collection.key, 'create')
    if (policies.length === 0) {
      throw new ServiceError('FORBIDDEN')
    }
    const substitutions = this.#substitutions(context)
    const now = new Date(this.#options.clock.now()).toISOString()
    const id = String(image.id)
    const createdBy = String(image.created_by ?? context.principalId)
    const createdAt =
      image.created_at instanceof Date
        ? image.created_at.toISOString()
        : String(image.created_at ?? now)
    const values: Record<string, unknown> = {}
    for (const [name, definition] of Object.entries(collection.fields)) {
      const value = image[name]
      values[name] =
        value === undefined || value === null ? null : normalizeValue(definition, value)
    }
    const resultingRow: Record<string, unknown> = {
      id,
      tenant_id: context.tenantId,
      workspace_id: context.workspaceId,
      created_by: createdBy,
      created_at: createdAt,
      updated_by: context.principalId,
      updated_at: now,
      version,
      ...values,
    }
    const decision = selectWritePolicy(policies, {
      action: 'create',
      writtenFields: Object.keys(values),
      resultingRow,
      context: substitutions,
    })
    if (!decision.allowed || !decision.policy) {
      throw new ServiceError('FORBIDDEN')
    }
    const policyId = decision.policy.id
    await this.#checkReferences(unit, context, collection, values)

    const parameters = new Parameters()
    const guard = buildCreateGuard({
      collection,
      catalogue: catalogueFor(collection),
      policies: writeCandidates(policies, Object.keys(values)),
      substitutions,
      parameters,
      values,
      id,
      version,
      tenantId: context.tenantId,
      workspaceId: context.workspaceId,
      principalId: context.principalId,
      createdBy,
      createdAt,
      now,
    })
    const columnList = guard.columns.map((name) => `"${name}"`).join(', ')
    const selection = guard.columns.map((name) => `post."${name}"`).join(', ')
    const written = await unit.execute(
      `${guard.prefix}insert into ${collection.table} (${columnList}) select ${selection} from post where (${guard.guard})`,
      parameters.values
    )
    if (written === 0) {
      throw new ServiceError('FORBIDDEN')
    }

    await this.#writeAuditAndEvent(unit, context, {
      collection: collection.key,
      recordId: id,
      action: 'create',
      resultVersion: version,
      changedFields: Object.keys(values),
      policyId,
      causation: null,
    })

    const readPolicies = this.#readPolicies(context, collection.key)
    const restored = await this.#lockRow(unit, context, collection, id, readPolicies, false)
    const representation = this.#representationOf(collection, restored, readPolicies)
    return {
      representation,
      etag: etagOf({ data: representation }),
      replayed: false,
      changedFields: Object.keys(values),
    }
  }

  /**
   * The representation of a row, with the fields the caller may see.
   *
   * The representation is built exactly like the one of a read: the
   * fields a policy that matches the row grants are the fields of the
   * answer, and the values are normalized the way the projection of a
   * read normalizes them. The validator of a record is therefore the
   * same whether the record was read or locked.
   *
   * The policies that match the row are the ones that the database
   * evaluated: the flags of the statement of the lock carry the answer
   * of the predicates of the policies, and they are the same flags that
   * the projection of a read computes.
   */
  #representationOf(
    collection: CollectionDefinition,
    row: RecordRow,
    policies: readonly Policy[]
  ): Record<string, unknown> {
    const granted = new Set<string>()
    policies.forEach((policy, index) => {
      if (row[`m${index}`] !== true) return
      for (const field of policy.fields) granted.add(field)
    })
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
    const budget = new ResponseBudget(MAX_RESPONSE_BYTES)
    const out: Record<string, unknown>[] = []
    for (const row of rows) {
      const payload: Record<string, unknown> = { id: row.id, version: row.version, ...row.payload }
      // The row is counted before its relations are attached: the
      // relations are counted on their own, and the sum of the two is
      // the size of the answer. The size is the one that the database
      // measured: the process does not serialize a row to know how big
      // it is.
      budget.addBytes(row.size)
      out.push(payload)
    }
    let relatedTotal = 0
    for (const name of include) {
      const relation = collection.relations[name]
      if (!relation) continue
      const target = this.collection(context, relation.target)
      if (!target) continue
      const targetPolicies = this.#readPolicies(context, target.key)
      if (targetPolicies.length === 0) continue
      // The roots that hold the relation: a root that does not grant it
      // does not carry the key at all.
      const indexes: number[] = []
      for (let index = 0; index < rows.length; index += 1) {
        if (rows[index]!.relations.includes(name)) indexes.push(index)
      }
      if (indexes.length === 0) continue
      if (relation.type === 'many-to-one') {
        const values: string[] = []
        for (const index of indexes) {
          const value = rows[index]!.foreignKeys[relation.field]
          if (value === undefined || value === null) continue
          values.push(String(value))
        }
        // One statement for the whole page: the relation of every root
        // is read at once, and not once per root.
        const found = await this.#fetchRelated(
          unit,
          context,
          target,
          targetPolicies,
          'id',
          values,
          budget
        )
        relatedTotal += found.length
        if (relatedTotal > MAX_RELATED_ROWS_PER_RESPONSE) {
          throw new ServiceError('RESULT_TOO_LARGE')
        }
        const byValue = new Map(found.map((entry) => [entry.parent, entry.representation]))
        for (const index of indexes) {
          const value = rows[index]!.foreignKeys[relation.field]
          out[index]![name] =
            value === undefined || value === null ? null : (byValue.get(String(value)) ?? null)
        }
        continue
      }
      const ids = indexes.map((index) => rows[index]!.id)
      const found = await this.#fetchRelated(
        unit,
        context,
        target,
        targetPolicies,
        relation.field,
        ids,
        budget
      )
      relatedTotal += found.length
      if (relatedTotal > MAX_RELATED_ROWS_PER_RESPONSE) {
        throw new ServiceError('RESULT_TOO_LARGE')
      }
      const byParent = new Map<string, { representation: Record<string, unknown> }[]>()
      for (const entry of found) {
        const list = byParent.get(entry.parent) ?? []
        list.push(entry)
        byParent.set(entry.parent, list)
      }
      for (const index of indexes) {
        const list = byParent.get(rows[index]!.id) ?? []
        if (list.length > MAX_RELATED_ROWS_PER_ROOT) {
          throw new ServiceError('RESULT_TOO_LARGE')
        }
        out[index]![name] = list.map((entry) => entry.representation)
      }
    }
    return out
  }

  /**
   * Reads the related rows of a relation.
   *
   * The rows are read in chunks: a chunk is read, it is counted by the
   * budget of the answer, and the next chunk is read only if the budget
   * still has room for it. The size of the chunk follows the size of
   * the rows: a collection of small rows is read in big chunks, and a
   * collection of large rows is read in small ones.
   *
   * The bound of the number of the rows is the one of the contract: the
   * answer never carries more than a thousand related rows, and the
   * chunk that crosses the bound is the last one.
   */
  async #fetchRelated(
    unit: UnitOfWork,
    context: RequestContext,
    target: CollectionDefinition,
    policies: Policy[],
    field: string,
    values: readonly string[],
    budget: ResponseBudget
  ): Promise<{ representation: Record<string, unknown>; parent: string }[]> {
    const catalogue = catalogueFor(target)
    const granted = this.#grantedFields(context, target).filter((name) => catalogue[name])
    const found: { representation: Record<string, unknown>; parent: string }[] = []
    const sort: SortColumn[] = [{ field: 'id', descending: false }]
    let after: string | null = null
    let chunk = EXPANSION_FIRST_CHUNK_ROWS
    while (found.length < MAX_RELATED_ROWS_PER_RESPONSE + 1) {
      const parameters = new Parameters()
      const scopeClause = `t.tenant_id = ${parameters.add(context.tenantId, 'uuid')} and t.workspace_id = ${parameters.add(context.workspaceId, 'uuid')}`
      const predicate = rowPredicate(policies, parameters, catalogue, this.#substitutions(context))
      const fieldClause = `t."${field}" = any(${parameters.add([...values], 'uuid[]')})`
      // The chunk continues after the last row of the previous one: the
      // rows are ordered by their identifier, and the identifier is
      // unique.
      const keyset = after === null ? 'true' : `t."id" > ${parameters.add(after, 'uuid')}`
      const sql = buildSelect({
        table: target.table,
        scopeClause,
        predicate,
        filterClause: fieldClause,
        keyset,
        policies,
        catalogue,
        substitutions: this.#substitutions(context),
        parameters,
        selectedFields: granted,
        foreignKeys: [field],
        relations: [],
        sort,
        limit: chunk,
      })
      const raw = await unit.query<Record<string, unknown>>(sql, parameters.values)
      const rows = raw.map((row) => mapRow(row, sort, [field]))
      if (rows.length === 0) break
      const before = budget.used
      for (const row of rows) {
        const representation: Record<string, unknown> = {
          id: row.id,
          version: row.version,
          ...row.payload,
        }
        budget.addBytes(row.size)
        found.push({
          representation,
          parent: String(row.foreignKeys[field] ?? ''),
        })
      }
      if (rows.length < chunk) break
      after = String(rows[rows.length - 1]!.id)
      chunk = nextChunkSize(chunk, budget.used - before, rows.length)
    }
    return found
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
}

/**
 * Builds the statement of a read.
 *
 * The statement has two parts. The first one reads the page: the
 * identifiers of the rows, the order and the limit. The second one
 * builds the payload of the rows of the page.
 *
 * The two parts are separate because the projection of a row is the
 * expensive part of a read: it reads every field of a row and it
 * builds a json value for each of them. A statement that projected
 * every row of the scope and then kept the page would cost a page what
 * the whole scope costs, and the collection would grow with the number
 * of the rows that were never read.
 *
 * The second part computes, for every policy, whether the policy
 * matches the row. The payload of the row is built from those flags: a
 * field is added only when a policy that matched the row grants it, so
 * a value the caller may not see never leaves the database.
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

  // The size of the payload, measured by the database.
  //
  // The size of every piece of the payload is the size of the object
  // that the piece holds: the statement measures it while it builds
  // the row, and the process does not serialize a row to know how big
  // it is. The measure counts the pieces that the policies do not
  // grant for the row: the budget is an upper bound of the size of
  // the answer, and never a lower one.
  const sizeParts = options.selectedFields.map((field) => {
    const definition = catalogue[field]!
    const piece = `jsonb_build_object('${field}', ${jsonExpression(field, definition, 't')})`
    return `octet_length(${piece}::text)`
  })
  const size =
    sizeParts.length === 0
      ? '64'
      : `(${sizeParts.join(' + ')} + ${options.selectedFields.length * 8 + 64})`

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

  // The page: the identifiers of the rows, the order and the limit. The
  // predicate of the policies is here, so the page holds the rows that
  // a policy covers and no other.
  const innerOrder = options.sort.length === 0 ? '' : `order by ${orderBy(options.sort)}\n  `

  return `with page as (
  select t."id" as id
  from ${options.table} t
  where ${options.scopeClause} and (${options.predicate}) and (${options.filterClause}) and (${options.keyset})
  ${innerOrder}limit ${options.limit}
), rows as (
  select
    ${parts.join(',\n    ')},
    (${size}) as size
  from page p
  join ${options.table} t on t."id" = p.id and (${options.scopeClause})
)
select ${selected.join(', ')}, (${payload}) as payload, (${relations}) as relations, size
from rows
where ${where}
${outerOrder}`
}

/**
 * The size of the next chunk of an expansion.
 *
 * The chunk aims at a mebibyte: a collection of small rows is read in
 * big chunks, and a collection of large rows is read in small ones. The
 * chunk never grows beyond the bound of the contract, and it is never
 * empty: a chunk of one row is slow, and it is the last resort.
 */
function nextChunkSize(current: number, bytes: number, rows: number): number {
  if (rows <= 0 || bytes <= 0) return current
  const perRow = bytes / rows
  const wanted = Math.floor(EXPANSION_CHUNK_BYTES / perRow)
  return Math.min(EXPANSION_MAX_CHUNK_ROWS, Math.max(1, wanted))
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
    size: Number(row.size ?? 0),
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

/**
 * Reports whether two values of a field are the same.
 *
 * The values of a field are compared after their normalization: the
 * value of a timestamp of the database and the value of the same
 * timestamp of the answer are the same instant, and the value of a
 * json field is compared by its content.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right)
  }
  return false
}
