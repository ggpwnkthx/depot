/**
 * The canonical form of a representation and the cursors (spec §9.4 and
 * §9.5).
 *
 * The canonical form is the deterministic serialization of a value: the
 * keys are sorted recursively, the arrays keep their order and the JSON
 * carries no insignificant whitespace. The validator of a record is the
 * digest of those exact bytes, so a client can compare it with the one
 * it holds and the service can refuse a write that is based on an old
 * representation.
 *
 * A cursor is a signed position. It binds the principal, the tenant, the
 * workspace, the collection, the route, the query, the position, the
 * expiry and the versions of the deployment. It is not a credential: the
 * page it names is authorized again.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { ServiceError } from '../../protocol/errors'

/** The canonical form of a value, with the keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${parts.join(',')}}`
}

/** The canonical bytes of a value. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8')
}

/**
 * The validator of a representation.
 *
 * The validator is strong: it is the digest of the exact bytes of the
 * canonical representation. Those bytes carry the version of the record,
 * so a change of the record invalidates the validator.
 */
export function etagOf(representation: unknown): string {
  return `"sha256:${createHash('sha256').update(canonicalBytes(representation)).digest('hex')}"`
}

/**
 * Parses the validator of a request.
 *
 * Only one strong validator is accepted: a weak one, a wildcard, a list
 * of them and a malformed one are refused.
 */
export function parseIfMatch(value: string | undefined | null): string {
  if (value === undefined || value === null || value.trim().length === 0) {
    throw new ServiceError('PRECONDITION_REQUIRED')
  }
  const trimmed = value.trim()
  if (trimmed.includes(',') || trimmed === '*' || trimmed.startsWith('W/')) {
    throw new ServiceError('INVALID_PRECONDITION')
  }
  if (!/^"sha256:[0-9a-f]{64}"$/.test(trimmed)) {
    throw new ServiceError('INVALID_PRECONDITION')
  }
  return trimmed
}

/** Reports whether two validators are the same. */
export function etagMatches(expected: string, current: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(current, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** The payload of a cursor. */
export interface CursorPayload {
  readonly v: 1
  readonly principal: string
  readonly tenant: string
  readonly workspace: string
  readonly collection: string
  readonly route: string
  /** The fingerprint of the query the cursor belongs to. */
  readonly query: string
  /** The values of the sort columns and of the identifier of the last row. */
  readonly position: readonly unknown[]
  /** The moment the cursor expires, in milliseconds since the epoch. */
  readonly expiry: number
  readonly schemaVersion: string
  readonly policyVersion: string
  /** The fingerprint of the permission keys of the caller. */
  readonly permissions: string
}

/** The reason a cursor was refused. */
export type CursorFailure = 'INVALID_CURSOR' | 'CURSOR_STALE'

/**
 * The refusal of a cursor.
 *
 * It is a `ServiceError`: the two reasons of the refusal are codes of
 * the published contract, and a cursor that is tampered with is a
 * `400 INVALID_CURSOR` and not an internal error of the service.
 *
 * The reason of the refusal is the cause of the error and not its
 * message: the answer of the service is the safe summary of the code,
 * and the reason belongs to the log. A caller that learns *why* its
 * cursor was refused learns something about the service that it does
 * not need.
 */
export class CursorError extends ServiceError {
  override readonly name = 'CursorError'

  constructor(code: CursorFailure, message: string) {
    super(code, { cause: new Error(message) })
  }
}

/** Encodes a cursor. */
export function encodeCursor(payload: CursorPayload, key: Uint8Array): string {
  const body = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(body).digest('base64url')
  return `${body}.${signature}`
}

/**
 * Decodes a cursor.
 *
 * A cursor that was tampered with is refused with `INVALID_CURSOR`: the
 * signature does not match. A cursor that is expired, or whose
 * deployment changed under it, is refused with `CURSOR_STALE`: it was
 * valid and it is not any more.
 */
export function decodeCursor(
  token: string,
  key: Uint8Array,
  expected: {
    principal: string
    tenant: string
    workspace: string
    collection: string
    route: string
    query: string
    schemaVersion: string
    policyVersion: string
    permissions: string
  },
  now: number
): CursorPayload {
  const parts = token.split('.')
  if (parts.length !== 2) {
    throw new CursorError('INVALID_CURSOR', 'the cursor is malformed')
  }
  const [body, signature] = parts as [string, string]
  const expectedSignature = createHmac('sha256', key).update(body).digest('base64url')
  const left = Buffer.from(signature, 'utf8')
  const right = Buffer.from(expectedSignature, 'utf8')
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new CursorError('INVALID_CURSOR', 'the cursor was not signed by this service')
  }
  let payload: CursorPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload
  } catch {
    throw new CursorError('INVALID_CURSOR', 'the cursor is malformed')
  }
  if (
    payload.principal !== expected.principal ||
    payload.tenant !== expected.tenant ||
    payload.workspace !== expected.workspace ||
    payload.collection !== expected.collection ||
    payload.route !== expected.route
  ) {
    throw new CursorError('INVALID_CURSOR', 'the cursor belongs to another scope')
  }
  if (payload.query !== expected.query) {
    throw new CursorError('INVALID_CURSOR', 'the cursor belongs to another query')
  }
  if (payload.expiry <= now) {
    throw new CursorError('CURSOR_STALE', 'the cursor is expired')
  }
  if (
    payload.schemaVersion !== expected.schemaVersion ||
    payload.policyVersion !== expected.policyVersion ||
    payload.permissions !== expected.permissions
  ) {
    throw new CursorError('CURSOR_STALE', 'the deployment changed under the cursor')
  }
  return payload
}

/** The fingerprint of the query of a page. */
export function queryFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
