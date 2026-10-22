/**
 * The scoped transactions (spec §6.4).
 *
 * Every data transaction carries the scope of its request: the tenant,
 * the workspace and the principal. The scope is set with
 * `set_config(..., true)`, which is local to the transaction: a pooled
 * connection never carries the scope of another request.
 *
 * The transaction has a budget. When the budget is spent, the statement
 * is cancelled by the server and the connection is destroyed, so the
 * server rolls the transaction back and the connection never returns to
 * the pool with an unknown state.
 */

import type { PoolClient } from 'pg'
import { ServiceError } from '../../protocol/errors'
import type { Metrics } from '../../observability/metrics'
import type { DataStore, Scope, TransactionOptions, UnitOfWork } from '../../domains/records'
import { type ConnectionPool, DatabaseError, codeOf } from './database'
import { breaksConnection, serviceErrorFor } from './errors'

/** The settings that carry the scope of a statement. */
export const SCOPE_SETTINGS = {
  tenant: 'data.tenant_id',
  workspace: 'data.workspace_id',
  principal: 'data.principal_id',
} as const

/** The unit of work of a transaction. */
class ScopedUnit implements UnitOfWork {
  readonly #client: PoolClient
  readonly #onError: (error: unknown) => void

  constructor(client: PoolClient, onError: (error: unknown) => void) {
    this.#client = client
    this.#onError = onError
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    try {
      const result = await this.#client.query({ text: sql, values: params as unknown[] })
      return result.rows as T[]
    } catch (error) {
      this.#onError(error)
      throw serviceErrorFor(error) ?? error
    }
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    try {
      const result = await this.#client.query({ text: sql, values: params as unknown[] })
      return result.rowCount ?? 0
    } catch (error) {
      this.#onError(error)
      throw serviceErrorFor(error) ?? error
    }
  }
}

/** The store of the business data, on a pool of connections. */
export class PostgresDataStore implements DataStore {
  readonly #pool: ConnectionPool
  readonly #statementTimeoutMs: number
  readonly #transactionTimeoutMs: number
  readonly #metrics?: Metrics

  constructor(
    pool: ConnectionPool,
    options: { statementTimeoutMs: number; transactionTimeoutMs: number; metrics?: Metrics }
  ) {
    this.#pool = pool
    this.#statementTimeoutMs = options.statementTimeoutMs
    this.#transactionTimeoutMs = options.transactionTimeoutMs
    this.#metrics = options.metrics
  }

  /** Runs a read inside a scoped, read only transaction. */
  async read<T>(
    action: (unit: UnitOfWork) => Promise<T>,
    scope: Scope,
    options: TransactionOptions = {}
  ): Promise<T> {
    return await this.#run(action, scope, { ...options, readOnly: true })
  }

  /** Runs a write inside a scoped transaction. */
  async write<T>(
    action: (unit: UnitOfWork) => Promise<T>,
    scope: Scope,
    options: TransactionOptions = {}
  ): Promise<T> {
    return await this.#run(action, scope, { ...options, readOnly: false })
  }

  /** Runs a transaction with its scope. */
  async #run<T>(
    action: (unit: UnitOfWork) => Promise<T>,
    scope: Scope,
    options: TransactionOptions & { readOnly: boolean }
  ): Promise<T> {
    const client = await this.#pool.acquire()
    let broken = false
    const unit = new ScopedUnit(client, (error) => {
      // A statement that failed does not break the connection: the
      // transaction is rolled back and the session is clean. Only a
      // failure of the connection itself does, and only then the
      // connection may not go back to the pool.
      if (breaksConnection(error)) broken = true
    })
    const timeoutMs = Math.min(
      options.timeoutMs ?? this.#transactionTimeoutMs,
      this.#transactionTimeoutMs
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    let released = false
    const expire = (): void => {
      // The transaction is abandoned: the connection is destroyed, so the
      // server rolls the transaction back and the connection never
      // returns to the pool with an unknown state.
      expired = true
      broken = true
      released = true
      try {
        client.release(true)
      } catch {
        // The connection is already gone.
      }
    }
    timer = setTimeout(expire, timeoutMs)
    timer.unref?.()
    try {
      await client.query('begin')
      await client.query(
        `select set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)`,
        [
          SCOPE_SETTINGS.tenant,
          scope.tenantId,
          SCOPE_SETTINGS.workspace,
          scope.workspaceId,
          SCOPE_SETTINGS.principal,
          scope.principalId,
        ]
      )
      await client.query(`set local statement_timeout = ${this.#statementTimeoutMs}`)
      await client.query(`set local lock_timeout = '2000ms'`)
      if (options.readOnly) {
        await client.query('set transaction read only')
      }
      const result = await action(unit)
      if (options.beforeCommit) {
        options.beforeCommit()
      }
      await client.query('commit')
      return result
    } catch (error) {
      try {
        await client.query('rollback')
        this.#metrics?.increment('data_transaction_rollbacks_total')
      } catch {
        broken = true
      }
      if (expired) {
        throw new ServiceError('DEADLINE_EXCEEDED')
      }
      // A failure of the driver is a code of the contract and not an
      // internal error: a lock that was not granted, a constraint that
      // was violated and a budget that was spent are the answers the
      // contract publishes, and a caller switches on the code.
      const translated = serviceErrorFor(error)
      if (translated) {
        throw translated
      }
      if (broken) {
        // The connection is lost: the database is not available, and the
        // answer of the contract is the one of the dependency.
        throw new ServiceError('DATABASE_UNAVAILABLE', {
          cause: new DatabaseError(
            `the transaction could not be completed: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
            codeOf(error)
          ),
        })
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (!released) {
        if (!broken) {
          client.release()
        } else {
          // The connection is not usable: it is destroyed and not
          // returned to the pool, so the pool never hands a broken
          // session to the next request.
          try {
            client.release(true)
          } catch {
            // The connection is already gone.
          }
        }
      }
    }
  }
}
