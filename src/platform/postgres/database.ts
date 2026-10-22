/**
 * The connection to PostgreSQL (spec §6.4).
 *
 * The module owns the lifecycle of the connections: the pools, the
 * budgets of the statements and of the transactions, and the check of the
 * role of the connection. A role that bypasses the isolation is refused:
 * the policies of the tables are a rule and not a promise.
 */

import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg'
import { ServiceError } from '../../protocol/errors'
import type { Metrics } from '../../observability/metrics'

/** The problem of a database that cannot be used. */
export class DatabaseError extends Error {
  override readonly name = 'DatabaseError'
  /** The code of the error of the driver. */
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

/** The settings of a pool. */
export interface PoolSettings {
  readonly url: string
  readonly max: number
  /** The budget of a statement, in milliseconds. */
  readonly statementTimeoutMs: number
  /** The budget of the wait for a connection, in milliseconds. */
  readonly acquireTimeoutMs: number
  /** The application name of the connections. */
  readonly applicationName: string
  /** The metrics of the process. */
  readonly metrics?: Metrics
}

/** A pool of connections. */
export class ConnectionPool {
  readonly #pool: Pool
  readonly #settings: PoolSettings
  readonly #metrics?: Metrics

  constructor(settings: PoolSettings) {
    this.#settings = settings
    this.#metrics = settings.metrics
    const config: PoolConfig = {
      connectionString: settings.url,
      max: settings.max,
      connectionTimeoutMillis: settings.acquireTimeoutMs,
      idleTimeoutMillis: 30_000,
      application_name: settings.applicationName,
      statement_timeout: settings.statementTimeoutMs,
      options: `-c statement_timeout=${settings.statementTimeoutMs} -c idle_in_transaction_session_timeout=${settings.statementTimeoutMs * 2}`,
    }
    this.#pool = new Pool(config)
    this.#pool.on('error', () => {
      // A broken connection is replaced by the pool. The error is not
      // fatal and it must not carry the connection string.
    })
  }

  /** Takes a connection from the pool. */
  async acquire(): Promise<PoolClient> {
    const started = performance.now()
    const waited = this.#pool.waitingCount
    try {
      const client = await this.#pool.connect()
      const duration = performance.now() - started
      if (this.#metrics) {
        // The wait is a wait of the pool: the requests that waited are
        // the ones that found every connection busy.
        if (waited > 0) {
          this.#metrics.increment('data_db_pool_waits_total')
        }
        this.#metrics.observe('data_db_acquire_duration_ms', duration)
      }
      return client
    } catch (error) {
      // The database is not reachable: the answer of the contract is the
      // one of the dependency, and it is not an internal error.
      throw new ServiceError('DATABASE_UNAVAILABLE', { cause: error })
    }
  }

  /** Runs a statement on a connection of the pool. */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    const client = await this.acquire()
    try {
      const result = await client.query<T>({ text, values: params as unknown[] })
      return result.rows
    } finally {
      client.release()
    }
  }

  /** Runs a statement and returns the number of rows it touched. */
  async execute(text: string, params: readonly unknown[] = []): Promise<number> {
    const client = await this.acquire()
    try {
      const result = await client.query({ text, values: params as unknown[] })
      return result.rowCount ?? 0
    } finally {
      client.release()
    }
  }

  /** Ends the pool. */
  async close(): Promise<void> {
    await this.#pool.end()
  }

  /** The settings of the pool. */
  get settings(): PoolSettings {
    return this.#settings
  }
}

/** The code of an error of the driver. */
export function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: string }).code
  return typeof code === 'string' ? code : undefined
}

/** The identity of the role of a connection. */
export interface RoleIdentity {
  readonly name: string
  readonly superuser: boolean
  readonly bypassesRowLevelSecurity: boolean
}

/**
 * Reads the role of the connection.
 *
 * A superuser and a role with `BYPASSRLS` are not subject to the
 * policies of the tables: a deployment that uses such a role does not
 * have the isolation it believes it has.
 */
export async function roleOf(pool: ConnectionPool): Promise<RoleIdentity> {
  const rows = await pool.query<{
    name: string
    superuser: boolean
    bypasses: boolean
  }>(
    `select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypasses
     from pg_roles r where r.rolname = current_user`
  )
  const row = rows[0]
  return {
    name: row?.name ?? 'unknown',
    superuser: row?.superuser ?? true,
    bypassesRowLevelSecurity: row?.bypasses ?? true,
  }
}
