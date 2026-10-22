/**
 * The verification of the identity of the gateway (spec §4.2).
 *
 * The gateway signs the identity it writes into the headers of a request
 * it forwards. The signature is a detached JWS: the payload is not
 * transmitted, and the upstream rebuilds it from the request it received
 * and from the identity headers.
 *
 * The module owns the canonical form of that payload and the verification
 * of the signature. It reads no file and knows nothing about the database:
 * it is the part of the service that answers "did this request really
 * come through the gateway".
 *
 * The verification is configured per route: the binding names the
 * version of the signature it accepts, the algorithm of that version and
 * the key that verifies it. The version and the algorithm are never read
 * from the request: a caller that chooses the algorithm of its own
 * signature chooses the key that verifies it.
 */

import { base64url, compactVerify, type KeyInput } from 'jose'
import {
  type IdentitySignatureAlgorithm,
  type IdentitySignatureVersion,
  type RouteBinding,
  WORKSPACE_PLACEHOLDER,
  isUuid,
} from './bindings'

/** The header the signature is written to. */
export const SIGNATURE_HEADER = 'x-shuttle-signature'

/** The header the subject is written to. */
export const SUBJECT_HEADER = 'x-shuttle-user'

/** The header the e-mail address is written to. */
export const EMAIL_HEADER = 'x-shuttle-email'

/** The header the roles are written to. */
export const ROLES_HEADER = 'x-shuttle-roles'

/** The header the workspace is written to. */
export const WORKSPACE_HEADER = 'x-shuttle-workspace'

/** The header the signed authority is written to. */
export const FORWARDED_HOST_HEADER = 'x-forwarded-host'

/** The type of the protected header of the signature. */
export const IDENTITY_SIGNATURE_TYPE = 'shuttle-identity'

/** The identity as the gateway wrote it into the headers. */
export interface WrittenIdentity {
  readonly subject: string
  readonly email?: string
  readonly roles: readonly string[]
  readonly workspaceId?: string
}

/** The request the signature belongs to. */
export interface SignedRequest {
  /** The method of the request, in upper case. */
  readonly method: string
  /** The path the upstream received, with its percent encoding. */
  readonly path: string
  /** The query string the upstream received, with its leading question mark. */
  readonly query: string
  /** The authority the caller used to reach the gateway. */
  readonly host: string
}

/**
 * The key that verifies the signatures of a route.
 *
 * The key belongs to the route and it is loaded by the runtime: the
 * domain never reads a file. For the version `v5` it is the public key
 * of the deployment of the gateway, and for the legacy version `v4` it
 * is the derived secret of the gateway.
 */
export interface IdentityVerification {
  /** The version of the signature the route accepts. */
  readonly version: IdentitySignatureVersion
  /** The algorithm the route accepts. */
  readonly algorithm: IdentitySignatureAlgorithm
  /** The key that verifies the signature. */
  readonly key: KeyInput
}

/**
 * The canonical form of the signed payload.
 *
 * The form is the one of the pinned gateway (spec §4.2): the fields are
 * written in a fixed order, the roles are sorted, and a missing value is
 * an empty string. The values are not normalized before the payload is
 * built: a value that was changed would change the signature.
 *
 * The version is part of the payload: it binds the format of the
 * signature, and an upstream that rebuilds the payload of a version it
 * does not know refuses the signature.
 */
export function canonicalIdentityPayload(
  identity: WrittenIdentity,
  request: SignedRequest,
  version: IdentitySignatureVersion
): string {
  return JSON.stringify({
    v: version,
    method: request.method.toUpperCase(),
    path: request.path,
    query: request.query,
    host: request.host.toLowerCase(),
    subject: identity.subject,
    workspaceId: identity.workspaceId ?? '',
    email: identity.email ?? '',
    roles: [...identity.roles].sort(),
  })
}

/**
 * Verifies a detached signature.
 *
 * The verification is the one of the library: the signature is checked
 * against the rebuilt payload, so a signature that does not belong to
 * the request is refused by the cryptography and not by a comparison that
 * could be written wrong.
 *
 * The version of the value, the algorithm and the type of the protected
 * header are the ones the route is configured with, and the payload of
 * the signature has to be detached: a signature that carries its payload
 * is not the format of the gateway.
 */
export async function verifyIdentitySignature(
  identity: WrittenIdentity,
  request: SignedRequest,
  verification: IdentityVerification,
  signature: string | null | undefined
): Promise<boolean> {
  if (!signature) return false
  const prefix = `${verification.version}=`
  if (!signature.startsWith(prefix)) return false
  const parts = signature.slice(prefix.length).split('.')
  if (parts.length !== 3) return false
  const protectedHeader = parts[0]
  const transmittedPayload = parts[1]
  const detachedSignature = parts[2]
  if (!protectedHeader || !detachedSignature) return false
  // The payload is detached: the segment that would carry it has to be
  // empty. A signature that carries its payload is not the format of the
  // gateway, and it is refused before the cryptography is asked.
  if (transmittedPayload !== '') return false
  let header: { alg?: string; typ?: string; crit?: unknown }
  try {
    header = JSON.parse(new TextDecoder().decode(base64url.decode(protectedHeader)))
  } catch {
    return false
  }
  if (!header || typeof header !== 'object') return false
  if (header.alg !== verification.algorithm) return false
  if (header.typ !== IDENTITY_SIGNATURE_TYPE) return false
  // A critical header the backend does not know is refused: the library
  // would refuse it too, and the refusal is explicit here.
  if (header.crit !== undefined) return false
  const payload = new TextEncoder().encode(
    canonicalIdentityPayload(identity, request, verification.version)
  )
  const compact = `${protectedHeader}.${base64url.encode(payload)}.${detachedSignature}`
  try {
    await compactVerify(compact, verification.key, { algorithms: [verification.algorithm] })
    return true
  } catch {
    return false
  }
}

/** The binding that matched a request, and the workspace of the request. */
export interface BindingMatch {
  readonly binding: RouteBinding
  /** The workspace of the path of the request. */
  readonly workspaceId: string
}

/**
 * Matches a request against the bindings.
 *
 * The host is compared exactly: the gateway signs the authority the
 * caller used, and a comparison that normalized it would accept a request
 * that was signed for another host.
 */
export function matchBinding(
  bindings: readonly RouteBinding[],
  host: string,
  path: string
): BindingMatch | null {
  const candidates = bindings.filter((binding) => binding.host === host)
  const matches: BindingMatch[] = []
  for (const binding of candidates) {
    const workspaceId = matchPattern(binding.upstreamPathPattern, path)
    if (workspaceId) matches.push({ binding, workspaceId })
  }
  if (matches.length !== 1) return null
  return matches[0]!
}

/**
 * Matches a path against a pattern and returns the workspace of the path.
 *
 * The workspace segment is a uuid: a segment that carries an encoded
 * separator, a backslash or a dot is not a workspace and never matches.
 */
export function matchPattern(pattern: string, path: string): string | null {
  if (!path.startsWith('/')) return null
  const patternSegments = pattern.slice(1, -2).split('/')
  const pathSegments = path.split('/')
  // The first segment of a path is empty: the path starts with a slash.
  if (pathSegments.length < patternSegments.length + 1) return null
  let workspaceId: string | null = null
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index]!
    const actual = pathSegments[index + 1] ?? ''
    if (expected === WORKSPACE_PLACEHOLDER) {
      if (actual.length === 0) return null
      if (actual.includes('%') || actual.includes('\\') || actual.includes('.')) return null
      if (!isUuid(actual)) return null
      workspaceId = actual
      continue
    }
    if (actual !== expected) return null
  }
  return workspaceId
}
