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
import type { Metrics } from '../../observability/metrics'
import type { ManifestBundle } from '../schema'
import type { PolicyBundle } from './policies'
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
  bundleVersionOf,
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
  writeCandidates,
} from './rules'

/**
 * The catalog a request works with.
 *
 * The catalog is the manifest of the workspace and the bundle of the
 * policies that applies to it. It is resolved once per request, before
 * the first domain operation, and it is carried by the context: every
 * operation of the request sees the same collections and the same
 * policies, and a policy that was published in the middle of a request
 * does not change the answer of that request.
 */
export interface RequestCatalog {
  /** The manifest of the workspace. */
  readonly manifest: ManifestBundle
  /** The bundle that applies to the workspace. */
  readonly bundle: PolicyBundle
}

/** The resolved context of a request. */
export interface ResolvedContext {
  /**
   * The context the domain operations receive.
   *
   * The resolver knows the principal and the permissions, and nothing of
   * the workspace: the caller that resolved the catalog of the workspace
   * completes the context with it.
   */
  readonly context: ResolvedRequestContext
  /** The moment the context stops being usable, on the monotonic clock. */
  readonly deadline: number
}

/** The context of a request, without the catalog. */
export type ResolvedRequestContext = Omit<RequestContext, 'catalog'>

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
  /** The catalog of the workspace: the manifest and the bundle of the request. */
  readonly catalog: RequestCatalog
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
  /**
   * The maximum number of the entries of the cache.
   *
   * The cache is bounded: it is the mitigation of the availability of
   * Hub, and a mitigation that grows without a bound is a leak. The
   * default is a bound that holds the contexts of a few thousand
   * principals.
   */
  readonly cacheMaxEntries?: number
  /** The scope of the service credential, part of the key of the cache. */
  readonly credentialScope: string
  readonly clock: Clock
  /** The limits of the contract, when they are known. */
  readonly limits?: { maxPermissionKeys: number; maxLifetimeMs: number }
  /** The metrics of the process. */
  readonly metrics?: Metrics
}

/**
 * The default number of the entries of the cache of the context.
 *
 * Every entry holds the keys of the permissions of a principal, and the
 * keys of the permissions are the ones of the deployment. A thousand
 * entries hold a few thousand keys, and the memory of the cache stays
 * in the order of the megabytes.
 */
export const DEFAULT_CONTEXT_CACHE_MAX_ENTRIES = 4096

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
  readonly #cacheMaxEntries: number
  #limits: { maxPermissionKeys: number; maxLifetimeMs: number } | null

  constructor(options: ContextResolverOptions) {
    this.#options = options
    this.#limits = options.limits ?? null
    this.#cacheMaxEntries = Math.max(
      1,
      options.cacheMaxEntries ?? DEFAULT_CONTEXT_CACHE_MAX_ENTRIES
    )
  }

  /** The number of the entries of the cache. */
  get cacheSize(): number {
    return this.#cache.size
  }

  /**
   * Removes the entries of the cache that are spent.
   *
   * An entry is spent when its deadline is past. The sweep runs when the
   * cache is full and before an entry is refused for the room: the
   * cache never refuses an entry that it could have made room for.
   */
  #sweep(now: number): void {
    for (const [key, entry] of [...this.#cache]) {
      if (entry.expiresAt <= now) this.#cache.delete(key)
    }
  }

  /**
   * Puts an entry in the cache.
   *
   * The cache is bounded: the least recently used entry leaves when the
   * cache is full. The map keeps the order of the insertion, and the
   * entry that is read is put at the end again: the first key of the
   * map is the least recently used one.
   */
  #store(key: string, entry: CacheEntry): void {
    const now = this.#options.clock.monotonic()
    this.#sweep(now)
    this.#cache.delete(key)
    this.#cache.set(key, entry)
    while (this.#cache.size > this.#cacheMaxEntries) {
      const oldest = this.#cache.keys().next()
      if (oldest.done) break
      this.#cache.delete(oldest.value)
    }
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
      /**
       * The version of the bundle of the request.
       *
       * The caller that resolved the catalog of the workspace overwrites
       * the version with the effective one: the resolver does not know
       * the catalog, and the version it stamps is the one of the
       * deployment.
       */
      policyBundleVersion?: string
    }
  ): Promise<ResolvedContext> {
    const started = this.#options.clock.now()
    const monoStarted = this.#options.clock.monotonic()
    const key = contextCacheKey(this.#options.credentialScope, request)

    if (!options.fresh && this.#options.cacheTtlMs > 0) {
      const entry = this.#cache.get(key)
      if (entry && entry.expiresAt > this.#options.clock.monotonic()) {
        this.#options.metrics?.increment('data_context_cache_hits_total')
        // The entry that is read is the most recently used one: it goes
        // to the end of the map, and it is the first one that leaves
        // when the cache is full.
        this.#cache.delete(key)
        this.#cache.set(key, entry)
        return this.#toResolved(entry, options)
      }
      this.#cache.delete(key)
      this.#options.metrics?.increment('data_context_cache_misses_total')
    } else if (!options.fresh) {
      // The cache is off: every read asks the hub, and the miss is
      // counted as well, so the metric says what the deployment does.
      this.#options.metrics?.increment('data_context_cache_misses_total')
    }

    const raw = await this.#options.client.evaluate(request)
    const context = validateContext(raw, request, started, this.limits)
    const deadline = this.#deadlineOf(context, started, monoStarted)
    const expiresAt = Math.min(deadline, this.#options.clock.monotonic() + this.#options.cacheTtlMs)
    const entry: CacheEntry = { context, deadline, expiresAt }
    if (!options.fresh && this.#options.cacheTtlMs > 0) {
      this.#store(key, entry)
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
    options: { source: 'shuttle' | 'worker'; requestId: string; policyBundleVersion?: string }
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
        policyBundleVersion: options.policyBundleVersion ?? '',
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
