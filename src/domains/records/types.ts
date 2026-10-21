/**
 * The ports and the types of the records domain (spec §9 and §10).
 *
 * The domain owns the record operations and the rules of the wire
 * contract. It builds the statements it runs: every identifier of a
 * statement comes from the manifest of the deployment and every value is
 * a bound parameter, so a caller never chooses a fragment of SQL.
 *
 * The domain imports the other domains through their public entry points
 * and it imports no adapter: the store is a port.
 */

import type { Clock } from '../../protocol/clock'

/** The scope of a data transaction. */
export interface Scope {
  readonly tenantId: string
  readonly workspaceId: string
  readonly principalId: string
}

/** A statement that runs inside a transaction. */
export interface UnitOfWork {
  /** Runs a statement and returns its rows. */
  query: <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<T[]>
  /** Runs a statement and returns its first row. */
  queryOne: <T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<T | null>
  /** Runs a statement and returns the number of rows it touched. */
  execute: (sql: string, params?: readonly unknown[]) => Promise<number>
}

/** The options of a transaction. */
export interface TransactionOptions {
  /** The deadline of the transaction, in milliseconds. */
  readonly timeoutMs?: number
  /**
   * A check that runs immediately before the commit.
   *
   * The check throws when the authorization of the transaction is no
   * longer valid: the transaction is rolled back and nothing is
   * committed.
   */
  readonly beforeCommit?: () => void
}

/** The store of the business data. */
export interface DataStore {
  /** Runs a read inside a scoped, read only transaction. */
  read: <T>(
    action: (unit: UnitOfWork) => Promise<T>,
    scope: Scope,
    options?: TransactionOptions
  ) => Promise<T>
  /** Runs a write inside a scoped transaction. */
  write: <T>(
    action: (unit: UnitOfWork) => Promise<T>,
    scope: Scope,
    options?: TransactionOptions
  ) => Promise<T>
}

/** A record as the domain holds it. */
export type RecordRow = Record<string, unknown>

/** The result of a list. */
export interface ListResult {
  readonly data: readonly Record<string, unknown>[]
  readonly meta: {
    readonly limit: number
    readonly nextCursor: string | null
    readonly count?: number
  }
}

/** The functions of an aggregate. */
export const AGGREGATE_FUNCTIONS = ['sum', 'avg', 'min', 'max'] as const

/** The function of an aggregate. */
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number]

/** One metric of an aggregate. */
export interface AggregateMetric {
  /** The function of the metric. */
  readonly function: AggregateFunction
  /** The field the metric reads. */
  readonly field: string
}

/** The options of an aggregate. */
export interface AggregateOptions {
  /** The fields the rows are grouped by. */
  readonly groupBy: readonly string[]
  /** The metrics of every group. */
  readonly metrics: readonly AggregateMetric[]
  /** The filter of the caller. */
  readonly filter?: unknown
  /** The text of the search of the collection. */
  readonly search?: string
  /** The maximum number of groups. */
  readonly limit: number
}

/** One group of an aggregate. */
export interface AggregateGroup {
  /** The values of the fields of the group. */
  readonly group: Record<string, unknown>
  /** The number of the rows of the group. */
  readonly count: number
  /** The sums of the fields, when a sum was asked. A sum of no row is null. */
  readonly sum?: Record<string, string | null>
  /** The averages of the fields, when an average was asked. */
  readonly avg?: Record<string, string | null>
  /** The smallest values of the fields, when a minimum was asked. */
  readonly min?: Record<string, unknown>
  /** The largest values of the fields, when a maximum was asked. */
  readonly max?: Record<string, unknown>
}

/** The result of an aggregate. */
export interface AggregateResult {
  readonly data: readonly AggregateGroup[]
  readonly meta: {
    /** The maximum number of groups that were asked. */
    readonly limit: number
    /** The number of the groups of the answer. */
    readonly groups: number
    /** True when the groups of the answer are not all of them. */
    readonly truncated: boolean
  }
}

/** The options of a list. */
export interface ListOptions {
  readonly fields?: readonly string[]
  readonly filter?: unknown
  /** The text of the search of the collection. */
  readonly search?: string
  readonly sort?: readonly string[]
  readonly limit: number
  readonly cursor?: string
  readonly include?: readonly string[]
  readonly includeCount: boolean
}

/** The receipt of a creation. */
export interface CreateReceipt {
  readonly id: string
  readonly version: number
}

/** The options of a creation. */
export interface CreateOptions {
  readonly body: Record<string, unknown>
  readonly idempotencyKey: string
}

/** The options of an update. */
export interface UpdateOptions {
  readonly id: string
  readonly body: Record<string, unknown>
  readonly expectedEtag: string
}

/** The options of a delete. */
export interface DeleteOptions {
  readonly id: string
  readonly expectedEtag: string
}

/** The result of a write. */
export interface WriteResult {
  /** The canonical representation of the record, when there is one. */
  readonly representation?: Record<string, unknown>
  /** The validator of the representation. */
  readonly etag?: string
  /** The receipt of a creation. */
  readonly receipt?: CreateReceipt
  /** True when the receipt was replayed. */
  readonly replayed: boolean
  /** The identifiers of the fields that changed. */
  readonly changedFields: readonly string[]
}

/** The shape of an audit entry the records domain writes. */
export interface AuditEntryLike {
  readonly id: string
  readonly occurredAt: string
  readonly principalId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly routeId: string
  readonly requestId: string
  readonly source: 'shuttle' | 'worker'
  readonly collection: string
  readonly recordId: string
  readonly action: 'create' | 'update' | 'delete'
  readonly resultVersion: number
  readonly changedFields: readonly string[]
  readonly policyBundleVersion: string
  readonly policyId: string
  readonly causationEventId?: string | null
  readonly causationPrincipalId?: string | null
}

/** The shape of an event the records domain writes. */
export interface EventLike {
  readonly version: number
  readonly eventId: string
  readonly type: 'record.created' | 'record.updated' | 'record.deleted'
  readonly tenantId: string
  readonly workspaceId: string
  readonly collection: string
  readonly recordId: string
  readonly recordVersion: number
  readonly actorId: string
  readonly occurredAt: string
  readonly changedFields: readonly string[]
  readonly correlationId: string
  readonly causationId: string | null
  readonly causationDepth: number
}

/** The shape of a subscriber the records domain reads. */
export interface SubscriberLike {
  readonly id: string
  readonly filter: {
    readonly collections?: readonly string[]
    readonly types?: readonly string[]
  }
}

/** The dependencies of the records service. */
export interface RecordsServiceOptions {
  readonly store: DataStore
  readonly clock: Clock
  /** The key that signs the cursors. */
  readonly cursorKey: Uint8Array
  readonly audit: { append: (entry: AuditEntryLike, unit: unknown) => Promise<void> }
  readonly outbox: {
    append: (
      event: EventLike,
      subscribers: readonly SubscriberLike[],
      unit: unknown
    ) => Promise<void>
  }
  readonly subscribers: readonly SubscriberLike[]
}

/** The maximum size of a body of a record, in bytes. */
export const MAX_RECORD_BODY_BYTES = 256 * 1024

/** The maximum number of explicitly selected fields. */
export const MAX_SELECTED_FIELDS = 50

/** The maximum number of fields of a sort. */
export const MAX_SORT_FIELDS = 3

/** The maximum number of relations of an expansion. */
export const MAX_INCLUDES = 5

/** The maximum number of related rows of one root record. */
export const MAX_RELATED_ROWS_PER_ROOT = 100

/** The maximum number of related rows of a response. */
export const MAX_RELATED_ROWS_PER_RESPONSE = 1000

/** The maximum size of a response, in bytes. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** The maximum number of the groups of an aggregate. */
export const MAX_AGGREGATE_GROUPS = 1000

/** The maximum number of the fields of the group of an aggregate. */
export const MAX_AGGREGATE_GROUP_FIELDS = 3

/** The maximum number of the metrics of an aggregate. */
export const MAX_AGGREGATE_METRICS = 10

/** The maximum length of the text of a search. */
export const MAX_SEARCH_LENGTH = 256

/** The default number of the groups of an aggregate. */
export const DEFAULT_AGGREGATE_GROUPS = 100

/** The maximum depth of an expansion. */
export const MAX_EXPANSION_DEPTH = 1

/** The lifetime of a cursor, in milliseconds. */
export const CURSOR_LIFETIME_MS = 15 * 60 * 1000

/** The limit of a page. */
export const MAX_LIMIT = 200

/** The default of a page. */
export const DEFAULT_LIMIT = 50
