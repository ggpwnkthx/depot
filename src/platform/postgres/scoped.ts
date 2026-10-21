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
      throw error
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
      throw error
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
    const unit = new ScopedUnit(client, () => {
      broken = true
    })
    const timeoutMs = Math.min(
      options.timeoutMs ?? this.#transactionTimeoutMs,
      this.#transactionTimeoutMs
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    let expired = false
    const expire = (): void => {
      // The transaction is abandoned: the connection is destroyed, so the
      // server rolls the transaction back and the connection never
      // returns to the pool with an unknown state.
      expired = true
      broken = true
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
      if (broken) {
        throw new DatabaseError(
          `the transaction could not be completed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
          codeOf(error)
        )
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (!broken) {
        client.release()
      }
    }
  }
}
