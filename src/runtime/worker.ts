/**
 * The worker of the subscribers (spec §11.5).
 *
 * The worker claims the deliveries that are due, runs the handler of the
 * subscriber outside the business transaction and acknowledges the
 * delivery when the handler finished its effect.
 *
 * The delivery is at least once: a worker that crashes leaves a lease
 * behind, and the lease makes the delivery eligible again. The handler
 * receives the identity of the effect, so it can be idempotent.
 */

import type { Clock } from '../protocol/clock'
import { ServiceError } from '../protocol/errors'
import type { Logger } from '../observability/logger'
import type { Metrics } from '../observability/metrics'
import type { RequestContext, ResolvedContext } from '../domains/authorization'
import type { CatalogProvider } from '../domains/catalog'
import { MAX_CAUSATION_DEPTH, type Delivery, type Subscriber } from '../domains/events'
import type { RecordsService } from '../domains/records'
import type { PostgresDeliveryStore } from '../platform/postgres/adapters'

/** The options of the worker. */
export interface WorkerOptions {
  readonly store: PostgresDeliveryStore
  readonly resolver: {
    resolve: (
      request: {
        subject: string
        tenantId: string
        workspaceId: string
        routeId: string
      },
      options: {
        fresh: boolean
        source: 'shuttle' | 'worker'
        requestId: string
        policyBundleVersion?: string
      }
    ) => Promise<ResolvedContext>
  }
  /** The catalog of the workspace of the command. */
  readonly catalog: CatalogProvider
  readonly records: RecordsService
  readonly subscribers: readonly Subscriber[]
  readonly principalId: string
  readonly routeId: string
  readonly concurrency: number
  readonly leaseMs: number
  readonly heartbeatMs: number
  readonly logger: Logger
  readonly metrics: Metrics
  readonly clock: Clock
}

/** The maximum number of attempts of a delivery. */
export const MAX_ATTEMPTS = 8

/** The first delay of a retry, in milliseconds. */
export const FIRST_RETRY_MS = 1000

/** The longest delay of a retry, in milliseconds. */
export const MAX_RETRY_MS = 5 * 60 * 1000

/** The number of ticks between two readings of the backlog. */
const BACKLOG_READING_TICKS = 10

/**
 * The delay of the next attempt.
 *
 * The delay grows exponentially and it carries a jitter, so a fleet of
 * workers does not retry at the same instant.
 */
export function retryDelay(attempt: number, random = Math.random): number {
  const exponential = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, attempt - 1))
  const jitter = exponential * 0.2 * random()
  return Math.min(MAX_RETRY_MS, Math.round(exponential - exponential * 0.1 + jitter))
}

/** The worker of the subscribers. */
export class SubscriberWorker {
  readonly #options: WorkerOptions
  #running = false
  #loop: Promise<void> | null = null
  #stop: (() => void) | null = null
  #ticks = 0

  constructor(options: WorkerOptions) {
    this.#options = options
  }

  /** Starts the loop of the worker. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.#loop = this.#run()
  }

  /** Stops the loop of the worker and waits for the last tick. */
  async stop(): Promise<void> {
    this.#running = false
    this.#stop?.()
    this.#stop = null
    await this.#loop
    this.#loop = null
  }

  /** The loop of the worker. */
  async #run(): Promise<void> {
    while (this.#running) {
      try {
        const handled = await this.tick()
        if (!handled) {
          await this.#sleep(500)
        }
      } catch (error) {
        this.#options.logger.error('the worker could not claim its deliveries', {
          error: error instanceof Error ? error.message : 'unknown error',
        })
        await this.#sleep(1000)
      }
    }
  }

  /** Waits for a while, and stops early when the worker is stopped. */
  async #sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
      this.#stop = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  /**
   * Claims and runs the deliveries that are due.
   *
   * The number of the deliveries is bounded by the concurrency of the
   * worker, and the deliveries of one tick are run one after the other:
   * the concurrency of the worker is the number of the workers of the
   * deployment, not the number of the threads of one worker.
   */
  async tick(): Promise<boolean> {
    const deliveries = await this.#options.store.claimDue({
      workerId: `worker-${process.pid}`,
      limit: this.#options.concurrency,
      leaseMs: this.#options.leaseMs,
    })
    if (deliveries.length === 0) {
      await this.#readBacklog(false)
      return false
    }
    for (const delivery of deliveries) {
      await this.#handle(delivery)
    }
    await this.#readBacklog(true)
    return true
  }

  /**
   * Reads the backlog of the deliveries and publishes it.
   *
   * The reading is an aggregate over the table of the deliveries, so an
   * idle worker does not take it on every tick: it reads it every tenth
   * tick, and a worker that handled deliveries reads it at the end of
   * the tick.
   */
  async #readBacklog(force: boolean): Promise<void> {
    this.#ticks += 1
    if (!force && this.#ticks % BACKLOG_READING_TICKS !== 0) return
    try {
      const backlog = await this.#options.store.backlog()
      this.#options.metrics.set('data_outbox_backlog', backlog.pending)
      this.#options.metrics.set('data_outbox_oldest_age_seconds', backlog.oldestSeconds)
    } catch (error) {
      this.#options.logger.warn('the backlog of the deliveries could not be read', {
        error: error instanceof Error ? error.message : 'unknown error',
      })
    }
  }

  /** Runs the handler of one delivery. */
  async #handle(delivery: Delivery): Promise<void> {
    const subscriber = this.#options.subscribers.find((entry) => entry.id === delivery.subscriberId)
    if (!subscriber) {
      this.#options.logger.error('a delivery has no handler', {
        eventId: delivery.eventId,
        subscriberId: delivery.subscriberId,
      })
      await this.#options.store.fail(
        delivery,
        'the subscriber is not registered in this deployment',
        null
      )
      this.#options.metrics.increment('data_delivery_failures_total', {
        reason: 'missing_handler',
      })
      return
    }

    const event = delivery.event
    if (event.causationDepth + 1 > MAX_CAUSATION_DEPTH) {
      await this.#options.store.fail(
        delivery,
        `the depth of the chain of events is above ${MAX_CAUSATION_DEPTH}`,
        null
      )
      this.#options.metrics.increment('data_delivery_failures_total', {
        reason: 'causation_depth',
      })
      return
    }

    try {
      const _context = await this.#contextFor(event)
      await subscriber.handler(event, {
        eventId: event.eventId,
        subscriberId: delivery.subscriberId,
        attempt: delivery.attempts,
      })
      await this.#options.store.acknowledge(delivery)
    } catch (error) {
      const permanent =
        error instanceof ServiceError &&
        (error.code === 'FORBIDDEN' || error.code === 'AUTHORIZATION_UNAVAILABLE')
      const exhausted = delivery.attempts >= MAX_ATTEMPTS
      if (permanent || exhausted) {
        await this.#options.store.fail(
          delivery,
          error instanceof Error ? error.message : 'unknown error',
          null
        )
        this.#options.metrics.increment('data_delivery_failures_total', {
          reason: permanent ? 'forbidden' : 'exhausted',
        })
        this.#options.logger.error('a delivery failed for good', {
          eventId: delivery.eventId,
          subscriberId: delivery.subscriberId,
          attempts: delivery.attempts,
        })
        return
      }
      await this.#options.store.fail(
        delivery,
        error instanceof Error ? error.message : 'unknown error',
        retryDelay(delivery.attempts)
      )
      this.#options.metrics.increment('data_delivery_retries_total', {
        subscriber: delivery.subscriberId,
      })
    }
  }

  /**
   * The context of a command of the worker.
   *
   * The context is fresh: the hub resolves the grants of the service
   * principal before every command. The identity of the caller that
   * started the chain is an attribution and never an authority.
   */
  async #contextFor(event: {
    tenantId: string
    workspaceId: string
    actorId: string
    eventId: string
    causationDepth: number
  }): Promise<RequestContext> {
    // The workspace and its catalog are read together: the identity of
    // the workspace is the identity of the registry, and the catalog is
    // the configuration of the workspace.
    const found = await this.#options.catalog.find(event.workspaceId)
    if (found?.workspace.status !== 'active') {
      throw new ServiceError('FORBIDDEN')
    }
    const workspace = found.workspace
    if (workspace.tenantId !== event.tenantId) {
      throw new ServiceError('FORBIDDEN')
    }
    const resolved = await this.#options.resolver.resolve(
      {
        subject: this.#options.principalId,
        tenantId: workspace.tenantId,
        workspaceId: workspace.id,
        routeId: this.#options.routeId,
      },
      {
        fresh: true,
        source: 'worker',
        requestId: `worker-${event.eventId}`,
        policyBundleVersion: found.catalog.policyBundleVersion,
      }
    )
    // The command of a worker sees the same collections and the same
    // policies as the request that started the chain.
    return {
      ...resolved.context,
      policyBundleVersion: found.catalog.policyBundleVersion,
      catalog: { manifest: found.catalog.manifest, bundle: found.catalog.bundle },
      causationId: event.eventId,
      causationDepth: event.causationDepth + 1,
      causationPrincipalId: event.actorId,
    }
  }
}
