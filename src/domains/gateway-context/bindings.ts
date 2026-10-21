/**
 * The trusted route bindings of the gateway (spec §4.1).
 *
 * A binding is the operator's answer to the question "which route of the
 * gateway is this request for". The request itself never carries a route
 * identifier: Shuttle v4 does not sign one, and a client that sends one
 * would be choosing its own route.
 *
 * The module owns the vocabulary of the bindings. It reads no file and
 * touches no database: the runtime loads the files and hands the parsed
 * values over.
 */

/** The maximum number of bindings of a deployment. */
export const MAX_BINDINGS = 100

/** The version of the file of the bindings. */
export const BINDING_FILE_VERSION = 1

/** The name of the placeholder of the workspace in a pattern. */
export const WORKSPACE_PLACEHOLDER = '{workspaceId}'

/** One accepted gateway route. */
export interface RouteBinding {
  /** The local identifier of the binding, for the diagnostics. */
  readonly id: string
  /** The exact signed public authority, with a port when there is one. */
  readonly host: string
  /** The backend received path pattern, with the workspace placeholder. */
  readonly upstreamPathPattern: string
  /** The hub route scope of the route. */
  readonly routeId: string
  /** The file that holds the derived identity key of the gateway. */
  readonly identityKeyFile: string
  /** The tenant the gateway is restricted to, when it is. */
  readonly expectedTenantId?: string
}

/** The problem of a configuration that cannot be used. */
export class BindingConfigError extends Error {
  override readonly name = 'BindingConfigError'
}

/** Reports whether a value is a canonical uuid. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

/**
 * Validates the authority of a binding.
 *
 * The authority is the exact value the gateway signs: a comparison that
 * normalizes it would accept a request that was signed for another host.
 */
function validateHost(host: string, where: string): void {
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(host)
  if (!match) {
    throw new BindingConfigError(`${where}: the host must be an authority with an optional port`)
  }
  const name = match[1] ?? ''
  const port = match[2]
  if (name.length === 0 || name.length > 253) {
    throw new BindingConfigError(`${where}: the host name is empty or too long`)
  }
  if (name !== name.toLowerCase()) {
    throw new BindingConfigError(`${where}: the host must be lowercase`)
  }
  if (!/^[a-z0-9.-]+$/.test(name)) {
    throw new BindingConfigError(`${where}: the host must be a dns authority`)
  }
  for (const label of name.split('.')) {
    if (label.length === 0 || label.length > 63) {
      throw new BindingConfigError(`${where}: the host has an empty or too long label`)
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new BindingConfigError(`${where}: the host has an invalid label`)
    }
  }
  if (port !== undefined) {
    const number = Number(port)
    if (number < 1 || number > 65_535) {
      throw new BindingConfigError(`${where}: the port of the host is out of range`)
    }
  }
}

/**
 * Validates the path pattern of a binding.
 *
 * The pattern is a literal path with one placeholder and a terminal
 * remainder. It is not an expression: nothing in it is ever compiled, so
 * a pattern cannot carry a regular expression or a substitution.
 */
function validatePattern(pattern: string, where: string): void {
  if (!pattern.startsWith('/')) {
    throw new BindingConfigError(`${where}: the path pattern must start with a slash`)
  }
  if (pattern.includes('\\')) {
    throw new BindingConfigError(`${where}: the path pattern must not contain a backslash`)
  }
  if (pattern.includes('//')) {
    throw new BindingConfigError(`${where}: the path pattern must not contain an empty segment`)
  }
  if (!pattern.endsWith('/*')) {
    throw new BindingConfigError(`${where}: the path pattern must end with the remainder "/*"`)
  }
  const segments = pattern.slice(1, -2).split('/')
  let placeholders = 0
  for (const segment of segments) {
    if (segment === WORKSPACE_PLACEHOLDER) {
      placeholders += 1
      continue
    }
    if (segment.length === 0) {
      throw new BindingConfigError(`${where}: the path pattern must not contain an empty segment`)
    }
    if (segment.includes('{') || segment.includes('}')) {
      throw new BindingConfigError(
        `${where}: the path pattern may only hold the ${WORKSPACE_PLACEHOLDER} placeholder`
      )
    }
    if (segment === '.' || segment === '..') {
      throw new BindingConfigError(`${where}: the path pattern must not contain a dot segment`)
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw new BindingConfigError(`${where}: the path pattern has an invalid segment`)
    }
  }
  if (placeholders !== 1) {
    throw new BindingConfigError(
      `${where}: the path pattern must hold exactly one ${WORKSPACE_PLACEHOLDER} segment`
    )
  }
}

/**
 * Parses and validates the file of the bindings.
 *
 * The file is rejected as a whole when anything is wrong: a deployment
 * that accepts half of its bindings is a deployment nobody can reason
 * about.
 */
export function parseBindingsFile(raw: string): RouteBinding[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BindingConfigError('the file of the bindings is not json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BindingConfigError('the file of the bindings is not an object')
  }
  const file = parsed as Record<string, unknown>
  const unknownKeys = Object.keys(file).filter((key) => key !== 'version' && key !== 'bindings')
  if (unknownKeys.length > 0) {
    throw new BindingConfigError(
      `the file of the bindings has unknown properties: ${unknownKeys.sort().join(', ')}`
    )
  }
  if (file.version !== BINDING_FILE_VERSION) {
    throw new BindingConfigError(
      `the file of the bindings must have the version ${BINDING_FILE_VERSION}`
    )
  }
  if (!Array.isArray(file.bindings)) {
    throw new BindingConfigError('the file of the bindings must hold a list of bindings')
  }
  if (file.bindings.length === 0) {
    throw new BindingConfigError('the file of the bindings must hold at least one binding')
  }
  if (file.bindings.length > MAX_BINDINGS) {
    throw new BindingConfigError(
      `the file of the bindings must hold at most ${MAX_BINDINGS} bindings`
    )
  }

  const bindings: RouteBinding[] = []
  const identifiers = new Set<string>()
  file.bindings.forEach((entry, index) => {
    const where = `binding ${index}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BindingConfigError(`${where}: the binding is not an object`)
    }
    const record = entry as Record<string, unknown>
    const allowed = new Set([
      'id',
      'host',
      'upstreamPathPattern',
      'routeId',
      'identityKeyFile',
      'expectedTenantId',
    ])
    const unknown = Object.keys(record).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      throw new BindingConfigError(
        `${where}: the binding has unknown properties: ${unknown.sort().join(', ')}`
      )
    }
    const id = record.id
    const host = record.host
    const pattern = record.upstreamPathPattern
    const routeId = record.routeId
    const keyFile = record.identityKeyFile
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      throw new BindingConfigError(`${where}: the id is required and it is a short string`)
    }
    if (identifiers.has(id)) {
      throw new BindingConfigError(`${where}: the id "${id}" is used twice`)
    }
    identifiers.add(id)
    if (typeof host !== 'string') {
      throw new BindingConfigError(`${where}: the host is required and it is a string`)
    }
    validateHost(host, where)
    if (typeof pattern !== 'string') {
      throw new BindingConfigError(
        `${where}: the upstream path pattern is required and it is a string`
      )
    }
    validatePattern(pattern, where)
    if (typeof routeId !== 'string' || routeId.length === 0 || routeId.length > 128) {
      throw new BindingConfigError(`${where}: the route id is required and it is a short string`)
    }
    if (typeof keyFile !== 'string' || keyFile.length === 0) {
      throw new BindingConfigError(`${where}: the identity key file is required`)
    }
    const expectedTenantId = record.expectedTenantId
    if (expectedTenantId !== undefined) {
      if (typeof expectedTenantId !== 'string' || !isUuid(expectedTenantId)) {
        throw new BindingConfigError(`${where}: the expected tenant id must be a uuid`)
      }
    }
    bindings.push({
      id,
      host,
      upstreamPathPattern: pattern,
      routeId,
      identityKeyFile: keyFile,
      ...(expectedTenantId === undefined ? {} : { expectedTenantId }),
    })
  })

  assertUnambiguous(bindings)
  return bindings
}

/**
 * Reports whether two patterns of the same host can match the same path.
 *
 * Two patterns overlap when one of them is a prefix of the other: the
 * placeholder sits at the same place in both, so the shorter one covers
 * the longer one.
 */
function patternsOverlap(left: string, right: string): boolean {
  const prefixOf = (pattern: string): string[] =>
    pattern
      .slice(1, -2)
      .split('/')
      .filter((segment) => segment !== WORKSPACE_PLACEHOLDER)
  const a = prefixOf(left)
  const b = prefixOf(right)
  const shortest = Math.min(a.length, b.length)
  for (let index = 0; index < shortest; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/** Refuses a configuration whose bindings are ambiguous. */
function assertUnambiguous(bindings: RouteBinding[]): void {
  for (let left = 0; left < bindings.length; left += 1) {
    for (let right = left + 1; right < bindings.length; right += 1) {
      const a = bindings[left]!
      const b = bindings[right]!
      if (a.host !== b.host) continue
      if (a.upstreamPathPattern === b.upstreamPathPattern) {
        throw new BindingConfigError(
          `the bindings "${a.id}" and "${b.id}" cover the same host and the same path`
        )
      }
      if (patternsOverlap(a.upstreamPathPattern, b.upstreamPathPattern)) {
        throw new BindingConfigError(
          `the bindings "${a.id}" and "${b.id}" overlap on the host "${a.host}"`
        )
      }
    }
  }
}
