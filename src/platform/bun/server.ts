/**
 * The listener of the process (spec §15.3).
 *
 * The listener owns the socket, the admission of the requests and the
 * drain of the process. A process that drains stops admitting requests,
 * lets the requests that are running finish, and closes its listeners
 * and its pools exactly once.
 */

import type { Logger } from '../../observability/logger'
import type { Metrics } from '../../observability/metrics'

/** The options of the listener. */
export interface ListenerOptions {
  readonly host: string
  readonly port: number
  readonly logger: Logger
  readonly metrics: Metrics
  /** The maximum number of the requests that are handled at the same time. */
  readonly maxInFlightRequests: number
  /** The budget of the drain, in milliseconds. */
  readonly drainMs: number
  /** The handler of the requests. */
  readonly fetch: (request: Request) => Response | Promise<Response>
}

/** The listener of the process. */
export class Listener {
  readonly #options: ListenerOptions
  #server: { stop: (closeActiveConnections?: boolean) => void; port?: number } | null = null
  #draining = false
  #inFlight = 0
  #closed = false

  constructor(options: ListenerOptions) {
    this.#options = options
  }

  /** True when the process drains. */
  get draining(): boolean {
    return this.#draining
  }

  /** The port the listener binds. */
  get port(): number {
    return this.#server?.port ?? this.#options.port
  }

  /** Starts the listener. */
  async start(): Promise<void> {
    const server = Bun.serve({
      hostname: this.#options.host,
      port: this.#options.port,
      fetch: async (request: Request) => {
        if (this.#draining) {
          return new Response(
            JSON.stringify({
              error: { code: 'DRAINING', message: 'The service is draining.' },
              requestId: request.headers.get('x-request-id') ?? 'unknown',
            }),
            { status: 503, headers: { 'content-type': 'application/json' } }
          )
        }
        if (this.#inFlight >= this.#options.maxInFlightRequests) {
          this.#options.metrics.increment('data_requests_total', {
            route: 'admission',
            method: request.method,
            status: '503',
          })
          return new Response(
            JSON.stringify({
              error: { code: 'OVERLOADED', message: 'The service is overloaded.' },
              requestId: request.headers.get('x-request-id') ?? 'unknown',
            }),
            { status: 503, headers: { 'content-type': 'application/json' } }
          )
        }
        this.#inFlight += 1
        this.#options.metrics.set('data_in_flight_requests', this.#inFlight)
        try {
          return await this.#options.fetch(request)
        } finally {
          this.#inFlight -= 1
          this.#options.metrics.set('data_in_flight_requests', this.#inFlight)
        }
      },
    })
    this.#server = server
    this.#options.logger.info('the listener is ready', {
      host: this.#options.host,
      port: server.port,
    })
  }

  /**
   * Drains the process.
   *
   * The listener stops admitting requests, the requests that are running
   * are given the budget of the drain, and the socket is closed.
   */
  async drain(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    this.#options.metrics.set('data_draining', 1)
    const deadline = Date.now() + this.#options.drainMs
    while (this.#inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await this.close()
  }

  /** Closes the listener exactly once. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#server?.stop(true)
    this.#server = null
  }
}
