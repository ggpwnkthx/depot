/**
 * The subscribers of the deployment (spec §11.4).
 *
 * The subscribers are registered by the deployment, in the composition
 * root. There is no uploaded plugin, no arbitrary target url and no
 * caller defined handler in version 0.1.
 *
 * A handler runs outside the business transaction and it uses the
 * authority of the service principal of the worker. The identity of the
 * caller that started the chain is an attribution, never an authority.
 */

import type { RequestContext } from '../domains/authorization'
import type { DeliveryIdentity, DomainEvent, EventType, Subscriber } from '../domains/events'
import type { RecordsService } from '../domains/records'

/** The number of words of a text. */
export function countWords(text: string | null | undefined): number {
  if (!text) return 0
  return text.split(/\s+/).filter((word) => word.length > 0).length
}

/** The options of the projection subscriber. */
export interface ArticleProjectionOptions {
  /** The identifier of the subscriber. */
  readonly id?: string
  /** The collection it watches. */
  readonly collection?: string
  /** The collection it writes. */
  readonly target?: string
  /** The service that reads and writes the records. */
  readonly records: RecordsService
  /** The context of the worker for an event. */
  readonly contextFor: (event: DomainEvent) => Promise<RequestContext>
}

/**
 * The projection of the articles.
 *
 * The subscriber reads the record that changed, with the authority of the
 * worker, and writes a summary of it. The write is idempotent: the
 * identity of the effect is the pair of the event and the subscriber, and
 * the idempotency key of the creation is derived from it.
 */
export function articleProjectionSubscriber(options: ArticleProjectionOptions): Subscriber {
  const id = options.id ?? 'article-projection'
  const collection = options.collection ?? 'articles'
  const target = options.target ?? 'article_stats'
  return {
    id,
    filter: {
      collections: [collection],
      types: ['record.created', 'record.updated'] as EventType[],
    },
    handler: async (event: DomainEvent, _identity: DeliveryIdentity) => {
      const context = await options.contextFor(event)
      const record = await options.records.get(context, collection, event.recordId)
      const title =
        typeof record.representation.title === 'string' ? record.representation.title : ''
      const body =
        typeof record.representation.body === 'string' ? record.representation.body : null
      await options.records.create(context, target, {
        body: {
          article_id: event.recordId,
          word_count: countWords(`${title} ${body ?? ''}`.trim()),
          event_id: event.eventId,
        },
        idempotencyKey: `sub-${id}-${event.eventId}`.slice(0, 128),
      })
    },
  }
}
