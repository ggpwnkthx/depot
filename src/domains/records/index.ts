/**
 * The records domain (spec §9 and §10).
 *
 * The public entry point of the domain. The application and the runtime
 * import this module and not the files behind it.
 */

export {
  type AggregateFunction,
  type AggregateMetric,
  type DataStore,
  type Scope,
  type SubscriberLike,
  type TransactionOptions,
  type UnitOfWork,
  AGGREGATE_FUNCTIONS,
} from './types'
export { RecordsService } from './service'
