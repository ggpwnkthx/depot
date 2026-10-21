/**
 * The error vocabulary of the service (spec §9.7).
 *
 * The codes are stable, machine readable identifiers. The mapping from a
 * code to a status is fixed here, so every layer of the service answers
 * with the same status for the same cause.
 *
 * This module is a shared protocol module: it carries small, versioned
 * vocabularies and nothing else. It exposes no table and no repository of
 * any service.
 */

/** Every error code of version 0.1. */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_QUERY',
  'INVALID_CURSOR',
  'INVALID_PRECONDITION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'OPERATION_IN_PROGRESS',
  'CURSOR_STALE',
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'INVALID_REFERENCE',
  'RESULT_TOO_LARGE',
  'PRECONDITION_REQUIRED',
  'TOO_MANY_REQUESTS',
  'INTERNAL_ERROR',
  'AUTHORIZATION_UNAVAILABLE',
  'DATABASE_UNAVAILABLE',
  'OVERLOADED',
  'DRAINING',
  'DEADLINE_EXCEEDED',
] as const

/** The type of an error code. */
export type ErrorCode = (typeof ERROR_CODES)[number]

/** The status every code answers with. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  INVALID_REQUEST: 400,
  INVALID_QUERY: 400,
  INVALID_CURSOR: 400,
  INVALID_PRECONDITION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  OPERATION_IN_PROGRESS: 409,
  CURSOR_STALE: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_FAILED: 422,
  INVALID_REFERENCE: 422,
  RESULT_TOO_LARGE: 422,
  PRECONDITION_REQUIRED: 428,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  AUTHORIZATION_UNAVAILABLE: 503,
  DATABASE_UNAVAILABLE: 503,
  OVERLOADED: 503,
  DRAINING: 503,
  DEADLINE_EXCEEDED: 504,
})

/** The safe message of every code. */
export const ERROR_MESSAGE: Readonly<Record<ErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: 'The request is not understood.',
  INVALID_QUERY: 'The query is not valid.',
  INVALID_CURSOR: 'The cursor is not valid.',
  INVALID_PRECONDITION: 'The precondition header is not valid.',
  UNAUTHENTICATED: 'The request could not be authenticated.',
  FORBIDDEN: 'The request is not allowed.',
  NOT_FOUND: 'The resource does not exist.',
  CONFLICT: 'The request conflicts with the current state.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key was used with another request.',
  OPERATION_IN_PROGRESS: 'The same operation is already running.',
  CURSOR_STALE: 'The cursor is stale.',
  PRECONDITION_FAILED: 'The record changed since the validator was issued.',
  PAYLOAD_TOO_LARGE: 'The payload is too large.',
  VALIDATION_FAILED: 'The request contains invalid values.',
  INVALID_REFERENCE: 'A reference of the request is not valid.',
  RESULT_TOO_LARGE: 'The result is larger than the budget of the service.',
  PRECONDITION_REQUIRED: 'A precondition header is required.',
  TOO_MANY_REQUESTS: 'Too many requests.',
  INTERNAL_ERROR: 'The request could not be completed.',
  AUTHORIZATION_UNAVAILABLE: 'The authorization service is not available.',
  DATABASE_UNAVAILABLE: 'The database is not available.',
  OVERLOADED: 'The service is overloaded.',
  DRAINING: 'The service is draining.',
  DEADLINE_EXCEEDED: 'The request took longer than its budget.',
})

/** The detail of an error: it names a field and a reason. */
export interface ErrorDetail {
  /** The name of the field the detail is about. */
  readonly field: string
  /** The machine readable reason of the detail. */
  readonly code: string
}

/**
 * An error of the service.
 *
 * The message is a safe summary: it never carries a stack trace, a SQL
 * text, a name of a constraint, a reason of Hub or a credential.
 */
export class ServiceError extends Error {
  override readonly name = 'ServiceError'
  /** The code of the error. */
  readonly code: ErrorCode
  /** The status the error answers with. */
  readonly status: number
  /** The details of the error. */
  readonly details: readonly ErrorDetail[]
  /** Extra headers the answer carries, such as `Retry-After`. */
  readonly headers: Readonly<Record<string, string>>

  constructor(
    code: ErrorCode,
    options: {
      message?: string
      details?: readonly ErrorDetail[]
      headers?: Record<string, string>
    } = {}
  ) {
    super(options.message ?? ERROR_MESSAGE[code])
    this.code = code
    this.status = ERROR_STATUS[code]
    this.details = options.details ?? []
    this.headers = options.headers ?? {}
  }
}

/** Builds an error of the service. */
export function fail(
  code: ErrorCode,
  options: {
    message?: string
    details?: readonly ErrorDetail[]
    headers?: Record<string, string>
  } = {}
): ServiceError {
  return new ServiceError(code, options)
}
