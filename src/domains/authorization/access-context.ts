/**
 * The access context of Hub (spec §5).
 *
 * The backend owns the meaning of a permission, and Hub owns the decision
 * of which permissions a principal holds right now. The contract between
 * the two is the access context: a request for the context of a principal
 * in a workspace, and an answer that carries the complete set of the
 * permission keys of that principal.
 *
 * The domain owns the vocabulary of the contract and the validation of an
 * answer. A malformed, incomplete or stale answer is never used: the
 * service fails closed.
 */

import { ServiceError } from '../../protocol/errors'

/** The version of the contract this backend speaks. */
export const ACCESS_CONTEXT_VERSION = 1

/** The maximum number of permission keys of an answer. */
export const MAX_PERMISSION_KEYS = 4096

/** The maximum lifetime of an answer, in milliseconds. */
export const MAX_LIFETIME_MS = 5000

/** The maximum size of a body of the contract, in bytes. */
export const MAX_CONTEXT_BODY_BYTES = 512 * 1024

/** The tolerance of the clock, in milliseconds. */
export const CLOCK_TOLERANCE_MS = 1000

/** The request of a context. */
export interface AccessContextRequest {
  /** The principal, as the gateway signed it. */
  readonly subject: string
  /** The tenant of the workspace, as the registry holds it. */
  readonly tenantId: string
  /** The workspace of the request. */
  readonly workspaceId: string
  /** The route scope of the binding or of the worker. */
  readonly routeId: string
}

/** The answer of a context. */
export interface AccessContext {
  readonly version: number
  readonly allow: boolean
  readonly subject: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly routeId: string
  readonly permissionKeys: readonly string[]
  readonly evaluatedAt: number
  /** The moment the answer stops being usable, in milliseconds since the epoch. */
  readonly validUntil?: number
}

/** The discovery of the contract. */
export interface AccessContextDiscovery {
  readonly versions: readonly number[]
  readonly maxPermissionKeys: number
  readonly maxLifetimeMs: number
}

/** The client of the contract. */
export interface AccessContextClient {
  /** Reads the discovery of the contract. */
  discover: () => Promise<AccessContextDiscovery>
  /** Reads the context of a principal. */
  evaluate: (request: AccessContextRequest) => Promise<AccessContext>
}

/** Reports whether a value is an object and not an array. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The failure of a dependency of the authorization. */
function unavailable(reason: string): never {
  throw new ServiceError('AUTHORIZATION_UNAVAILABLE', {
    message: `the authorization is not available: ${reason}`,
  })
}

/**
 * Validates the discovery of the contract.
 *
 * An unknown version stops the readiness of the service: a backend that
 * does not know the contract of its hub would guess the permissions.
 */
export function validateDiscovery(raw: unknown): AccessContextDiscovery {
  if (!isObject(raw)) unavailable('the discovery is not an object')
  const versions = raw.versions
  if (!Array.isArray(versions) || versions.some((entry) => typeof entry !== 'number')) {
    unavailable('the discovery does not hold its versions')
  }
  if (!versions.includes(ACCESS_CONTEXT_VERSION)) {
    throw new ServiceError('AUTHORIZATION_UNAVAILABLE', {
      message: `the authorization service does not speak the version ${ACCESS_CONTEXT_VERSION} of the access context`,
    })
  }
  const maxPermissionKeys = raw.maxPermissionKeys
  const maxLifetimeMs = raw.maxLifetimeMs
  if (
    typeof maxPermissionKeys !== 'number' ||
    !Number.isInteger(maxPermissionKeys) ||
    maxPermissionKeys <= 0
  ) {
    unavailable('the discovery does not hold its limit of permission keys')
  }
  if (typeof maxLifetimeMs !== 'number' || !Number.isInteger(maxLifetimeMs) || maxLifetimeMs <= 0) {
    unavailable('the discovery does not hold its limit of lifetime')
  }
  if (maxPermissionKeys > MAX_PERMISSION_KEYS) {
    unavailable('the discovery announces more permission keys than the contract allows')
  }
  if (maxLifetimeMs > MAX_LIFETIME_MS) {
    unavailable('the discovery announces a longer lifetime than the contract allows')
  }
  return { versions, maxPermissionKeys, maxLifetimeMs }
}

/**
 * Validates the answer of a context.
 *
 * The validation is strict: the identifiers of the answer have to be the
 * ones of the request, the keys have to be complete and sorted, and the
 * validity has to stay inside the bounds of the contract. An answer that
 * fails is a failure of the dependency, not a refusal of the caller.
 */
export function validateContext(
  raw: unknown,
  request: AccessContextRequest,
  now: number,
  limits: { maxPermissionKeys: number; maxLifetimeMs: number }
): AccessContext {
  if (!isObject(raw)) unavailable('the answer is not an object')
  if (raw.version !== ACCESS_CONTEXT_VERSION) unavailable('the answer has an unknown version')
  if (typeof raw.allow !== 'boolean') unavailable('the answer does not hold its decision')
  for (const field of ['subject', 'tenantId', 'workspaceId', 'routeId'] as const) {
    if (typeof raw[field] !== 'string') unavailable(`the answer does not hold its ${field}`)
    if (raw[field] !== request[field]) {
      unavailable(`the answer holds another ${field} than the one of the request`)
    }
  }
  const keys = raw.permissionKeys
  if (!Array.isArray(keys)) unavailable('the answer does not hold its permission keys')
  if (keys.length > limits.maxPermissionKeys) {
    unavailable('the answer holds more permission keys than the contract allows')
  }
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) {
      unavailable('the answer holds a permission key that is not a string')
    }
  }
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1] as string
    const current = keys[index] as string
    if (previous === current) unavailable('the answer holds a permission key twice')
    if (previous > current) unavailable('the answer does not hold its permission keys sorted')
  }
  if (raw.allow && keys.length === 0) {
    unavailable('the answer allows without a single permission key')
  }
  if (!raw.allow && keys.length > 0) {
    unavailable('the answer refuses and holds permission keys')
  }
  const evaluatedAt = raw.evaluatedAt
  if (typeof evaluatedAt !== 'string' || Number.isNaN(Date.parse(evaluatedAt))) {
    unavailable('the answer does not hold its evaluation time')
  }
  const evaluatedAtMs = Date.parse(evaluatedAt)
  if (evaluatedAtMs > now + CLOCK_TOLERANCE_MS) {
    unavailable('the answer was evaluated in the future')
  }
  if (raw.validUntil !== undefined) {
    if (typeof raw.validUntil !== 'string' || Number.isNaN(Date.parse(raw.validUntil))) {
      unavailable('the answer does not hold its validity')
    }
    const validUntilMs = Date.parse(raw.validUntil)
    if (validUntilMs <= now) unavailable('the answer is already expired')
    if (validUntilMs > evaluatedAtMs + limits.maxLifetimeMs) {
      unavailable('the answer is valid for longer than the contract allows')
    }
    if (!raw.allow) unavailable('a refusal must not carry a validity')
    return {
      version: ACCESS_CONTEXT_VERSION,
      allow: raw.allow,
      subject: request.subject,
      tenantId: request.tenantId,
      workspaceId: request.workspaceId,
      routeId: request.routeId,
      permissionKeys: keys as string[],
      evaluatedAt: evaluatedAtMs,
      validUntil: validUntilMs,
    }
  }
  if (raw.allow) {
    unavailable('the answer allows without a validity')
  }
  return {
    version: ACCESS_CONTEXT_VERSION,
    allow: raw.allow,
    subject: request.subject,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    routeId: request.routeId,
    permissionKeys: [],
    evaluatedAt: evaluatedAtMs,
  }
}

/** The key of the cache of a context. */
export function contextCacheKey(credentialScope: string, request: AccessContextRequest): string {
  return [
    credentialScope,
    request.subject,
    request.tenantId,
    request.workspaceId,
    request.routeId,
  ].join('|')
}
