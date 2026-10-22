/**
 * The limits of the tenants (spec §15.3).
 *
 * The listener admits the requests of the whole process: its bound is
 * the bound of the capacity of the machine. The bound of the listener
 * is the same for every tenant, and a tenant that sends more requests
 * than the others takes the room of the others: the answer of the
 * listener is a `503 OVERLOADED`, and it tells the caller that the
 * service is broken rather than that it is sending too much.
 *
 * The limiter of the tenants is the second bound. It is applied once the
 * tenant of the request is known — after the signature of the gateway
 * and the registry of the workspaces — and it answers `429 TOO_MANY_REQUESTS`
 * with a `Retry-After`: the caller is told to slow down, and the other
 * tenants of the deployment keep their room.
 *
 * The room of a tenant is the room of the process until the deployment
 * declares another one. A deployment with one tenant does not need to
 * declare it, and a deployment with several declares the room that
 * each of them may hold.
 */

import { ServiceError } from '../protocol/errors'
import type { Metrics } from '../observability/metrics'

/** The options of the limiter. */
export interface TenantLimiterOptions {
  /**
   * The maximum number of the requests of a tenant that run at the same
   * time.
   *
   * The configuration never declares zero: the bound of a tenant is the
   * bound of the process until the deployment declares another one.
   * Zero is accepted by the limiter itself, and it means that the bound
   * is not applied.
   */
  readonly maxInFlightPerTenant: number
  /** The metrics of the process. */
  readonly metrics?: Metrics
}

/** The limiter of the tenants. */
export class TenantLimiter {
  readonly #options: TenantLimiterOptions
  readonly #inFlight = new Map<string, number>()

  constructor(options: TenantLimiterOptions) {
    this.#options = options
  }

  /** The number of the tenants that hold a request at the moment. */
  get size(): number {
    return this.#inFlight.size
  }

  /** The bound of a tenant, or zero when it is disabled. */
  get limit(): number {
    return this.#options.maxInFlightPerTenant
  }

  /**
   * Takes a room for a request of a tenant.
   *
   * The answer is a `429 TOO_MANY_REQUESTS` when the tenant already
   * holds its whole room: the caller is too fast, and the answer says
   * so.
   */
  enter(tenantId: string): void {
    const limit = this.#options.maxInFlightPerTenant
    if (limit <= 0) return
    const current = this.#inFlight.get(tenantId) ?? 0
    if (current >= limit) {
      this.#options.metrics?.increment('data_tenant_overload_total')
      throw new ServiceError('TOO_MANY_REQUESTS', { headers: { 'Retry-After': '1' } })
    }
    this.#inFlight.set(tenantId, current + 1)
  }

  /**
   * Gives the room of a request back.
   *
   * The tenant leaves the map when it holds no request any more: the map
   * is the number of the tenants that are working, and it does not grow
   * with the number of the requests.
   */
  leave(tenantId: string): void {
    const current = this.#inFlight.get(tenantId) ?? 0
    if (current <= 1) {
      this.#inFlight.delete(tenantId)
      return
    }
    this.#inFlight.set(tenantId, current - 1)
  }
}
