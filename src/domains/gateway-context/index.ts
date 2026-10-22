/**
 * The gateway context domain (spec §4).
 *
 * The domain owns one question: "is this request a request of a trusted
 * gateway, and which route of the gateway is it for". It answers with
 * the verified identity of the caller and with the route scope of the
 * binding that matched.
 *
 * The domain imports no other domain and no adapter: it reads the
 * bindings and the keys it is given, and it refuses everything it cannot
 * prove.
 */

import { ServiceError } from '../../protocol/errors'
import { type RouteBinding, isUuid } from './bindings'
import {
  EMAIL_HEADER,
  FORWARDED_HOST_HEADER,
  ROLES_HEADER,
  SIGNATURE_HEADER,
  SUBJECT_HEADER,
  WORKSPACE_HEADER,
  type IdentityVerification,
  type SignedRequest,
  type WrittenIdentity,
  matchBinding,
  verifyIdentitySignature,
} from './verify'

export {
  type IdentitySignatureAlgorithm,
  type IdentitySignatureVersion,
  type IdentityVerificationConfig,
  type LegacyIdentityMode,
  type RouteBinding,
  BINDING_FILE_VERSION,
  DEFAULT_LEGACY_IDENTITY_MODE,
  IDENTITY_SIGNATURE_VERSIONS,
  LEGACY_BINDING_FILE_VERSION,
  LEGACY_IDENTITY_MODES,
  MAX_BINDINGS,
  WORKSPACE_PLACEHOLDER,
  isUuid,
  legacyBindings,
  parseBindingsFile,
} from './bindings'
export {
  EMAIL_HEADER,
  FORWARDED_HOST_HEADER,
  IDENTITY_SIGNATURE_TYPE,
  ROLES_HEADER,
  SIGNATURE_HEADER,
  SUBJECT_HEADER,
  WORKSPACE_HEADER,
  type IdentityVerification,
  type SignedRequest,
  type WrittenIdentity,
  canonicalIdentityPayload,
  matchBinding,
  matchPattern,
  verifyIdentitySignature,
} from './verify'

/** The headers of a request, as the domain reads them. */
export interface GatewayHeaders {
  get: (name: string) => string | null
}

/** The request the domain verifies. */
export interface GatewayRequest {
  readonly method: string
  /** The path the upstream received, with its percent encoding. */
  readonly path: string
  /** The query string the upstream received, with its leading question mark. */
  readonly query: string
  readonly headers: GatewayHeaders
}

/** A binding with the key that verifies the signatures of its route. */
export interface ResolvedBinding {
  readonly binding: RouteBinding
  /** The verification of the signatures of the route. */
  readonly verification: IdentityVerification
}

/** The identity the domain verified. */
export interface VerifiedGatewayIdentity {
  /** The principal of the caller, as the gateway signed it. */
  readonly subject: string
  /** The workspace of the request, as the gateway signed it. */
  readonly workspaceId: string
  /** The route scope of the binding that matched. */
  readonly routeId: string
  /** The tenant the binding restricts the gateway to, when it does. */
  readonly expectedTenantId?: string
  /** The e-mail address of the caller. A display value, never a permission. */
  readonly email?: string
  /** The roles of the caller. A diagnostic, never a permission. */
  readonly roles: readonly string[]
}

/** The refusal of the verification. */
function reject(): never {
  throw new ServiceError('UNAUTHENTICATED')
}

/**
 * Reads a header that carries one value.
 *
 * A header that appears twice is refused: the gateway writes every
 * identity header once, and a repeated header is an attempt to make the
 * reader pick the value that fits.
 */
function singleValue(headers: GatewayHeaders, name: string): string | undefined {
  const value = headers.get(name)
  if (value === null || value === undefined) return undefined
  if (value.includes(',')) reject()
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Verifies the identity of a request.
 *
 * Every refusal answers with the same generic error: a caller learns
 * nothing about the bindings, the tenants and the policies of the
 * deployment.
 *
 * The order of the checks is the order of the contract: the route is
 * found first, the version of the signature is the one of that route,
 * the signature is verified with the key of that route, and the values
 * of the identity are validated only after the cryptography of the
 * signature has accepted them.
 */
export async function verifyGatewayRequest(
  bindings: readonly ResolvedBinding[],
  request: GatewayRequest
): Promise<VerifiedGatewayIdentity> {
  const host = singleValue(request.headers, FORWARDED_HOST_HEADER)?.toLowerCase()
  if (!host) reject()
  const signature = singleValue(request.headers, SIGNATURE_HEADER)
  if (!signature) reject()
  const subject = singleValue(request.headers, SUBJECT_HEADER)
  if (!subject) reject()
  const signedWorkspace = singleValue(request.headers, WORKSPACE_HEADER)
  const email = singleValue(request.headers, EMAIL_HEADER)

  const rawRoles = request.headers.get(ROLES_HEADER)
  const roles =
    rawRoles === null || rawRoles === undefined || rawRoles.trim().length === 0
      ? []
      : rawRoles
          .split(',')
          .map((role) => role.trim())
          .filter((role) => role.length > 0)

  const match = matchBinding(
    bindings.map((entry) => entry.binding),
    host,
    request.path
  )
  if (!match) reject()

  const resolved = bindings.find(
    (entry) => entry.binding.id === match.binding.id && entry.binding.host === host
  )
  if (!resolved) reject()

  // The version of the signature is the one of the route, and it is not
  // read from the request: a route that expects the version `v5` refuses
  // the version `v4` and the other way round, and there is no fallback
  // after a refused signature.
  if (!signature.startsWith(`${resolved.verification.version}=`)) reject()

  const identity: WrittenIdentity = {
    subject,
    workspaceId: signedWorkspace,
    roles,
    ...(email ? { email } : {}),
  }
  const signedRequest: SignedRequest = {
    method: request.method,
    path: request.path,
    query: request.query,
    host,
  }

  const valid = await verifyIdentitySignature(
    identity,
    signedRequest,
    resolved.verification,
    signature
  )
  if (!valid) reject()

  // The values of the identity are validated only after the signature
  // has been verified: an unsigned request never reaches this point.
  if (!isUuid(match.workspaceId)) reject()
  if (!isUuid(subject)) reject()
  // The workspace of the path and the workspace of the signature are the
  // same workspace: a request that names another one is refused.
  if (signedWorkspace !== match.workspaceId) reject()

  return {
    subject,
    workspaceId: match.workspaceId,
    routeId: match.binding.routeId,
    ...(match.binding.expectedTenantId ? { expectedTenantId: match.binding.expectedTenantId } : {}),
    ...(email ? { email } : {}),
    roles,
  }
}
