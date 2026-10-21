/**
 * The readiness of the process (spec §15.1).
 *
 * The service is ready when its configuration is valid, when the
 * migrations of the deployment are applied and match the files of the
 * repository, when the privileges of the role of the connection are the
 * ones the deployment expects and when the hub speaks the version of the
 * access context contract.
 *
 * The probes are not routed through the authorization of a workspace: a
 * probe of an operator is not a caller of a tenant.
 */

import type { Logger } from '../observability/logger'
import { type ConnectionPool, roleOf } from '../platform/postgres/database'
import { type Migration, verifyMigrations } from '../platform/postgres/migrations'
import type { ManifestBundle } from '../domains/schema'

/** The options of the readiness. */
export interface ReadinessOptions {
  readonly pool: ConnectionPool
  readonly migrations: readonly Migration[]
  readonly manifest: ManifestBundle
  readonly hub: {
    discover: () => Promise<unknown>
  }
  readonly logger: Logger
  readonly clock: { now: () => number }
  /** True when the process runs the workers. */
  readonly worker: boolean
  /** The check of the delivery store, for a worker. */
  readonly deliveryCheck?: () => Promise<void>
  /** The number of the subscribers that are registered. */
  readonly subscriberCount: number
}

/** The maximum age of a successful discovery of the contract. */
export const DISCOVERY_TTL_MS = 10_000

/** The state of the readiness. */
export interface ReadinessState {
  readonly ready: boolean
  readonly reason?: string
}

/** The readiness of the process. */
export class Readiness {
  readonly #options: ReadinessOptions
  #lastDiscovery = 0
  #discoveryOk = false
  #lastReason = 'the service did not check its dependencies yet'

  constructor(options: ReadinessOptions) {
    this.#options = options
  }

  /** Checks the dependencies of the service. */
  async check(): Promise<ReadinessState> {
    // The role of the connection: a superuser or a role with BYPASSRLS is
    // not subject to the policies of the tables.
    try {
      const role = await roleOf(this.#options.pool)
      if (role.superuser || role.bypassesRowLevelSecurity) {
        this.#lastReason = 'the role of the connection bypasses the isolation of the rows'
        return { ready: false, reason: this.#lastReason }
      }
    } catch (error) {
      this.#lastReason = `the database is not available: ${
        error instanceof Error ? error.message : 'unknown error'
      }`
      return { ready: false, reason: this.#lastReason }
    }

    // The migrations of the deployment.
    try {
      await verifyMigrations(this.#options.pool, this.#options.migrations)
    } catch (error) {
      this.#lastReason = `the schema of the deployment is not ready: ${
        error instanceof Error ? error.message : 'unknown error'
      }`
      return { ready: false, reason: this.#lastReason }
    }

    // The hub: a successful discovery may be reused for ten seconds.
    const now = this.#options.clock.now()
    if (now - this.#lastDiscovery > DISCOVERY_TTL_MS || !this.#discoveryOk) {
      try {
        await this.#options.hub.discover()
        this.#lastDiscovery = now
        this.#discoveryOk = true
      } catch (error) {
        this.#discoveryOk = false
        this.#lastReason = `the authorization service is not ready: ${
          error instanceof Error ? error.message : 'unknown error'
        }`
        return { ready: false, reason: this.#lastReason }
      }
    }

    // The delivery store of a worker.
    if (this.#options.worker) {
      if (this.#options.subscriberCount === 0) {
        this.#lastReason = 'the worker runs without a registered subscriber'
        return { ready: false, reason: this.#lastReason }
      }
      if (this.#options.deliveryCheck) {
        try {
          await this.#options.deliveryCheck()
        } catch (error) {
          this.#lastReason = `the delivery store is not available: ${
            error instanceof Error ? error.message : 'unknown error'
          }`
          return { ready: false, reason: this.#lastReason }
        }
      }
    }

    this.#lastReason = 'ready'
    return { ready: true }
  }
}
