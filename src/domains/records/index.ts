/**
 * The records domain (spec §9 and §10).
 *
 * The public entry point of the domain. The application and the runtime
 * import this module and not the files behind it.
 */

export {
  type AggregateFunction,
  type AggregateGroup,
  type AggregateMetric,
  type AggregateOptions,
  type AggregateResult,
  type CreateOptions,
  type CreateReceipt,
  type DataStore,
  type DeleteOptions,
  type ListOptions,
  type ListResult,
  type RecordRow,
  type RecordsServiceOptions,
  type Scope,
  type SubscriberLike,
  type TransactionOptions,
  type UnitOfWork,
  type UpdateOptions,
  type WriteResult,
  AGGREGATE_FUNCTIONS,
  CURSOR_LIFETIME_MS,
  DEFAULT_AGGREGATE_GROUPS,
  DEFAULT_LIMIT,
  MAX_AGGREGATE_GROUP_FIELDS,
  MAX_AGGREGATE_GROUPS,
  MAX_AGGREGATE_METRICS,
  MAX_INCLUDES,
  MAX_LIMIT,
  MAX_RECORD_BODY_BYTES,
  MAX_RELATED_ROWS_PER_RESPONSE,
  MAX_RELATED_ROWS_PER_ROOT,
  MAX_RESPONSE_BYTES,
  MAX_SEARCH_LENGTH,
  MAX_SELECTED_FIELDS,
  MAX_SORT_FIELDS,
} from './types'
export { RecordsService } from './service'
export {
  type CursorFailure,
  type CursorPayload,
  CursorError,
  canonicalBytes,
  canonicalJson,
  decodeCursor,
  encodeCursor,
  etagMatches,
  etagOf,
  parseIfMatch,
  queryFingerprint,
} from './canonical'
export { BodyError, MAX_JSON_DEPTH, validateBody } from './validation'
export { EXPOSED_SERVER_FIELDS, catalogueFor } from './sql'
