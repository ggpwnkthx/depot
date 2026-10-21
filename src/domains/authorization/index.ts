/**
 * The authorization domain (spec §5 and §8).
 *
 * The domain owns the context of a request: the principal, the tenant,
 * the workspace, the route and the permission keys that hold right now.
 * It also owns the meaning of a permission for a collection.
 *
 * The domain imports the gateway context, the workspace registry and the
 * schema of the deployment, and it imports no adapter: the client of the
 * hub is a port.
 */

import type { Clock } from '../../protocol/clock'
import { ServiceError } from '../../protocol/errors'
import {
  type AccessContext,
  type AccessContextClient,
  type AccessContextDiscovery,
  type AccessContextRequest,
  MAX_LIFETIME_MS,
  MAX_PERMISSION_KEYS,
  contextCacheKey,
  validateContext,
  validateDiscovery,
} from './access-context'

export {
  ACCESS_CONTEXT_VERSION,
  type AccessContext,
  type AccessContextClient,
  type AccessContextDiscovery,
  type AccessContextRequest,
  CLOCK_TOLERANCE_MS,
  MAX_CONTEXT_BODY_BYTES,
  MAX_LIFETIME_MS,
  MAX_PERMISSION_KEYS,
  contextCacheKey,
  validateContext,
  validateDiscovery,
} from './access-context'
export {
  ACTIONS,
  type Action,
  MAX_POLICIES,
  MAX_POLICY_BUNDLE_BYTES,
  PERMISSION_KEY_PATTERN,
  POLICY_BUNDLE_VERSION,
  type Policy,
  type PolicyBundle,
  parsePolicyBundle,
} from './policies'
export {
  FILTER_OPERATORS,
  type FilterNode,
  FilterError,
  MAX_FILTER_DEPTH,
  MAX_FILTER_LEAVES,
  MAX_FILTER_VALUES,
  type FilterOperator,
  SUBSTITUTIONS,
  type SubstitutionContext,
  type SubstitutionName,
  compileFilter,
  evaluateFilter,
  parseFilter,
  quoteIdentifier,
  resolveSubstitutions,
  sqlTypeOf,
  validateOperand,
} from './filter'
export {
  type AuthorizationInput,
  type WriteDecision,
  type WriteRequest,
  applicablePolicies,
  filterSortIntersection,
  readableUnion,
  selectWritePolicy,
} from './rules'

/** The resolved context of a request. */
export interface ResolvedContext {
  /** The context the domain operations receive. */
  readonly context: RequestContext
  /** The moment the context stops being usable, on the monotonic clock. */
  readonly deadline: number
}

/** The context every domain operation receives (spec §6.2). */
export interface RequestContext {
  readonly principalId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly routeId: string
  readonly permissionKeys: readonly string[]
  readonly requestId: string
  readonly source: 'shuttle' | 'worker'
  readonly policyBundleVersion: string
  /** The deadline of the authorization, on the monotonic clock. */
  readonly authorizationDeadline: number
  /** The event that caused the command, when a worker made it. */
  readonly causationId?: string | null
  /** The depth of the chain of events. */
  readonly causationDepth?: number
  /** The principal that started the chain of events. */
  readonly causationPrincipalId?: string | null
}

/** A cached context. */
interface CacheEntry {
  readonly context: AccessContext
  /** The moment the authorization stops being valid, on the monotonic clock. */
  readonly deadline: number
  /** The moment the entry leaves the cache, on the monotonic clock. */
  readonly expiresAt: number
}

/** The options of the resolver. */
export interface ContextResolverOptions {
  readonly client: AccessContextClient
  /** The lifetime of the read only cache, in milliseconds. */
  readonly cacheTtlMs: number
  /** The scope of the service credential, part of the key of the cache. */
  readonly credentialScope: string
  readonly clock: Clock
  /** The limits of the contract, when they are known. */
  readonly limits?: { maxPermissionKeys: number; maxLifetimeMs: number }
}

/**
 * Resolves the context of a request.
 *
 * The default is no cache: every request asks the hub. A cache is
 * allowed for the reads only, it is bounded by the local lifetime and by
 * the lifetime the hub announced, and a failure never extends an entry
 * and never falls back on a stale one.
 */
export class ContextResolver {
  readonly #options: ContextResolverOptions
  readonly #cache = new Map<string, CacheEntry>()
  #limits: { maxPermissionKeys: number; maxLifetimeMs: number } | null

  constructor(options: ContextResolverOptions) {
    this.#options = options
    this.#limits = options.limits ?? null
  }

  /** The limits of the contract, when they are known. */
  get limits(): { maxPermissionKeys: number; maxLifetimeMs: number } {
    return (
      this.#limits ?? { maxPermissionKeys: MAX_PERMISSION_KEYS, maxLifetimeMs: MAX_LIFETIME_MS }
    )
  }

  /**
   * Reads the discovery of the contract.
   *
   * The discovery is the readiness check of the dependency: an unknown
   * version stops the readiness of the service.
   */
  async discover(): Promise<AccessContextDiscovery> {
    const discovery = validateDiscovery(await this.#options.client.discover())
    this.#limits = {
      maxPermissionKeys: discovery.maxPermissionKeys,
      maxLifetimeMs: discovery.maxLifetimeMs,
    }
    return discovery
  }

  /**
   * Resolves the context of a request.
   *
   * `fresh` forces a call to the hub: a mutation and a worker command
   * always ask for a fresh context.
   */
  async resolve(
    request: AccessContextRequest,
    options: {
      fresh: boolean
      source: 'shuttle' | 'worker'
      requestId: string
      policyBundleVersion: string
    }
  ): Promise<ResolvedContext> {
    const started = this.#options.clock.now()
    const monoStarted = this.#options.clock.monotonic()
    const key = contextCacheKey(this.#options.credentialScope, request)

    if (!options.fresh && this.#options.cacheTtlMs > 0) {
      const entry = this.#cache.get(key)
      if (entry && entry.expiresAt > this.#options.clock.monotonic()) {
        return this.#toResolved(entry, options)
      }
      this.#cache.delete(key)
    }

    const raw = await this.#options.client.evaluate(request)
    const context = validateContext(raw, request, started, this.limits)
    const deadline = this.#deadlineOf(context, started, monoStarted)
    const expiresAt = Math.min(deadline, this.#options.clock.monotonic() + this.#options.cacheTtlMs)
    const entry: CacheEntry = { context, deadline, expiresAt }
    if (!options.fresh && this.#options.cacheTtlMs > 0) {
      this.#cache.set(key, entry)
    }
    return this.#toResolved(entry, options)
  }

  /**
   * The moment the authorization stops being valid.
   *
   * The deadline of the hub is turned into the monotonic clock of the
   * process, and it is never longer than the life the hub announced. The
   * lifetime of the cache is a different bound: it applies to the entry
   * of the cache and not to the authorization.
   */
  #deadlineOf(context: AccessContext, startedAt: number, monoStarted: number): number {
    if (context.validUntil === undefined) return this.#options.clock.monotonic()
    const remaining = Math.max(0, context.validUntil - startedAt)
    return monoStarted + remaining
  }

  /** Builds the resolved context of a cached entry. */
  #toResolved(
    entry: CacheEntry,
    options: { source: 'shuttle' | 'worker'; requestId: string; policyBundleVersion: string }
  ): ResolvedContext {
    if (!entry.context.allow) {
      throw new ServiceError('FORBIDDEN')
    }
    return {
      context: {
        principalId: entry.context.subject,
        tenantId: entry.context.tenantId,
        workspaceId: entry.context.workspaceId,
        routeId: entry.context.routeId,
        permissionKeys: entry.context.permissionKeys,
        requestId: options.requestId,
        source: options.source,
        policyBundleVersion: options.policyBundleVersion,
        authorizationDeadline: entry.deadline,
      },
      deadline: entry.deadline,
    }
  }
}

/** The fingerprint of the permission keys of a context. */
export function permissionFingerprint(keys: readonly string[]): string {
  return [...keys].sort().join(',')
}
