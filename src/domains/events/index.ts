/**
 * The domain events and their subscribers (spec §11.3 and §11.4).
 *
 * An event is committed with the mutation that caused it, in the same
 * transaction. It carries the identifiers of the mutation and the names of
 * the fields that changed, never the values: a subscriber that needs the
 * current data reads it through an authorized read.
 *
 * The delivery is at least once. The subscribers are registered by the
 * deployment, in the composition root: there is no uploaded plugin and no
 * caller defined handler in version 0.1.
 */

/** The types of the events of version 0.1. */
export const EVENT_TYPES = ['record.created', 'record.updated', 'record.deleted'] as const

/** The type of an event. */
export type EventType = (typeof EVENT_TYPES)[number]

/** The envelope of an event. */
export interface DomainEvent {
  readonly version: number
  readonly eventId: string
  readonly type: EventType
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

/** The maximum depth of a chain of events. */
export const MAX_CAUSATION_DEPTH = 10

/** The state of a delivery. */
export type DeliveryState = 'pending' | 'leased' | 'acked' | 'failed'

/** One delivery of an event to a subscriber. */
export interface Delivery {
  readonly eventId: string
  readonly subscriberId: string
  readonly state: DeliveryState
  readonly attempts: number
  readonly nextAttemptAt: string
  readonly leaseExpiresAt: string | null
  readonly lastError: string | null
  readonly event: DomainEvent
}

/** The filter of a subscriber. */
export interface SubscriberFilter {
  /** The collections the subscriber handles. */
  readonly collections?: readonly string[]
  /** The types of the events the subscriber handles. */
  readonly types?: readonly EventType[]
}

/** The handler of a subscriber. */
export type SubscriberHandler = (
  /**
   * Handles one event.
   *
   * The handler runs outside the business transaction, with the authority
   * of the service principal of the worker. It has to be idempotent: the
   * identity of the effect is the pair of the event and the subscriber.
   */
  event: DomainEvent,
  identity: DeliveryIdentity
) => Promise<void>

/** The identity of an effect, for an idempotent handler. */
export interface DeliveryIdentity {
  readonly eventId: string
  readonly subscriberId: string
  /** The number of the attempt. */
  readonly attempt: number
}

/** A subscriber of the deployment. */
export interface Subscriber {
  /** The stable identifier of the subscriber. */
  readonly id: string
  /** The events the subscriber handles. */
  readonly filter: SubscriberFilter
  /** The handler of the subscriber. */
  readonly handler: SubscriberHandler
}

/** Reports whether a subscriber handles an event. */
export function subscriberHandles(subscriber: Subscriber, event: DomainEvent): boolean {
  const collections = subscriber.filter.collections
  if (collections && !collections.includes(event.collection)) return false
  const types = subscriber.filter.types
  if (types && !types.includes(event.type)) return false
  return true
}

/**
 * The outbox.
 *
 * The outbox is written inside the transaction of the mutation: an event
 * that is not committed with the mutation does not exist, and a mutation
 * without its event does not commit.
 */
export interface Outbox {
  /** Writes an event and its deliveries. */
  append: (event: DomainEvent, subscribers: readonly Subscriber[], unit: unknown) => Promise<void>
}

/** The claim of a delivery. */
export interface DeliveryClaim {
  readonly delivery: Delivery
  /** The moment the lease of the claim expires. */
  readonly leaseExpiresAt: string
}
