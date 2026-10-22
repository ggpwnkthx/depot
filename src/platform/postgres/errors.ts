/**
 * The errors of the database (spec §9.7).
 *
 * The driver of PostgreSQL answers with the SQLSTATE of the server: a
 * five character code that names the cause of the failure. The service
 * has its own vocabulary, and the contract of the API publishes it: the
 * codes of [the contract of v1](../../docs/api.md) are stable, and a
 * client switches on the code and never on the message.
 *
 * This module owns the translation between the two. It is the only place
 * that knows the SQLSTATE of the server, and the only place that turns
 * a failure of the driver into a code of the service.
 *
 * The translation is deliberately conservative. A state that is not in
 * the table below is not translated: a programming error — a statement
 * that does not parse, a column that does not exist — is a defect of the
 * service, and it is reported as an internal error rather than as the
 * refusal of a caller. A translation that hides a defect of the service
 * behind a plausible answer is worse than an answer that is obviously
 * wrong.
 */

import { type ErrorCode, ServiceError } from '../../protocol/errors'

/**
 * The translation of the SQLSTATE of the server.
 *
 * | The state | The cause | The code of the service |
 * | --- | --- | --- |
 * | `40001` | the serialization of the transaction failed | `CONFLICT` |
 * | `40P01` | a deadlock | `CONFLICT` |
 * | `55P03` | the lock of a row was not granted in time | `CONFLICT` |
 * | `55006` | the object is in use | `CONFLICT` |
 * | `23505` | a unique constraint was violated | `CONFLICT` |
 * | `23503` | a foreign key was violated | `INVALID_REFERENCE` |
 * | `23502` | a column that may not be null was null | `VALIDATION_FAILED` |
 * | `23514` | a check constraint was violated | `VALIDATION_FAILED` |
 * | `57014` | the statement was cancelled by its budget | `DEADLINE_EXCEEDED` |
 * | `53300` | the server has no connection left | `DATABASE_UNAVAILABLE` |
 * | `53200` | the server ran out of memory | `DATABASE_UNAVAILABLE` |
 * | `40003` | the transaction was lost in the middle | `DATABASE_UNAVAILABLE` |
 * | `08000`, `08001`, `08002`, `08003`, `08004`, `08006`, `08007`, `08P01` | the connection failed | `DATABASE_UNAVAILABLE` |
 * | `57P01`, `57P02`, `57P03` | the server is shutting down | `DATABASE_UNAVAILABLE` |
 * | `58000`, `58030` | the server failed | `DATABASE_UNAVAILABLE` |
 */
const SQLSTATE_CODES: Readonly<Record<string, ErrorCode>> = Object.freeze({
  '40001': 'CONFLICT',
  '40P01': 'CONFLICT',
  '55P03': 'CONFLICT',
  '55006': 'CONFLICT',
  '23505': 'CONFLICT',
  '23503': 'INVALID_REFERENCE',
  '23502': 'VALIDATION_FAILED',
  '23514': 'VALIDATION_FAILED',
  '57014': 'DEADLINE_EXCEEDED',
  '53300': 'DATABASE_UNAVAILABLE',
  '53200': 'DATABASE_UNAVAILABLE',
  '40003': 'DATABASE_UNAVAILABLE',
  '08000': 'DATABASE_UNAVAILABLE',
  '08001': 'DATABASE_UNAVAILABLE',
  '08002': 'DATABASE_UNAVAILABLE',
  '08003': 'DATABASE_UNAVAILABLE',
  '08004': 'DATABASE_UNAVAILABLE',
  '08006': 'DATABASE_UNAVAILABLE',
  '08007': 'DATABASE_UNAVAILABLE',
  '08P01': 'DATABASE_UNAVAILABLE',
  '57P01': 'DATABASE_UNAVAILABLE',
  '57P02': 'DATABASE_UNAVAILABLE',
  '57P03': 'DATABASE_UNAVAILABLE',
  '58000': 'DATABASE_UNAVAILABLE',
  '58030': 'DATABASE_UNAVAILABLE',
})

/**
 * The codes of the failures of the transport of the driver.
 *
 * They are not SQLSTATEs: they are the codes of the sockets of the
 * node, and they name the same cause — the database is not reachable.
 */
const TRANSPORT_CODES: Readonly<Record<string, ErrorCode>> = Object.freeze({
  ECONNREFUSED: 'DATABASE_UNAVAILABLE',
  ECONNRESET: 'DATABASE_UNAVAILABLE',
  ECONNABORTED: 'DATABASE_UNAVAILABLE',
  ETIMEDOUT: 'DATABASE_UNAVAILABLE',
  EPIPE: 'DATABASE_UNAVAILABLE',
  ENOTFOUND: 'DATABASE_UNAVAILABLE',
  EHOSTUNREACH: 'DATABASE_UNAVAILABLE',
  ENETUNREACH: 'DATABASE_UNAVAILABLE',
  EAI_AGAIN: 'DATABASE_UNAVAILABLE',
})

/** The code of a failure of the driver. */
export function driverCodeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string' || code.length === 0) return null
  return code
}

/**
 * The code of the service for a failure of the driver.
 *
 * The answer is `null` when the failure is not one of the known causes:
 * the caller then keeps its own handling, and an unknown failure stays
 * the internal error that it is.
 */
export function serviceCodeFor(error: unknown): ErrorCode | null {
  if (error instanceof ServiceError) return error.code
  const code = driverCodeOf(error)
  if (!code) return null
  const state = SQLSTATE_CODES[code]
  if (state) return state
  const transport = TRANSPORT_CODES[code]
  if (transport) return transport
  return null
}

/**
 * The codes of the failures that break the connection.
 *
 * A statement that fails — a constraint that is violated, a lock that is
 * not granted — leaves the connection usable: the transaction is rolled
 * back and the session is clean. A failure of the connection itself does
 * not: the state of the session is unknown, and the connection must not
 * go back to the pool.
 */
const BREAKING_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  '08000',
  '08001',
  '08002',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '40003',
  '57P01',
  '57P02',
  '57P03',
  '58000',
  '58030',
])

/**
 * Reports whether a failure breaks the connection.
 *
 * The distinction is the difference between a transaction that failed and
 * a session that is gone. A connection that is returned to the pool
 * after a broken statement is a connection that the next request takes:
 * a failure that does not break the connection must not cost a
 * connection of the pool.
 */
export function breaksConnection(error: unknown): boolean {
  const code = driverCodeOf(error)
  if (!code) return false
  return BREAKING_CODES.has(code)
}

/**
 * The error of the service for a failure of the driver.
 *
 * The answer is `null` when the failure is not one of the known causes.
 * The cause of the error is kept: it holds the text of the statement and
 * the reason of the server, and it belongs to the log and never to the
 * answer of the service.
 */
export function serviceErrorFor(error: unknown): ServiceError | null {
  if (error instanceof ServiceError) return error
  const code = serviceCodeFor(error)
  if (!code) return null
  return new ServiceError(code, { cause: error })
}
