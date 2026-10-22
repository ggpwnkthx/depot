/**
 * The HTTP boundary of the service (spec §9).
 *
 * The module owns the routes, the parsing of the requests and the mapping
 * of the failures to the answers. It establishes the context of a request
 * before a domain operation runs: no domain operation starts without a
 * verified principal and a resolved workspace.
 */

import { Hono, type Context, type Next } from 'hono'
import { ServiceError } from '../protocol/errors'
import type { Clock } from '../protocol/clock'
import type { Logger } from '../observability/logger'
import type { Metrics } from '../observability/metrics'
import type { RequestContext, ResolvedContext } from '../domains/authorization'
import type { AuditReader } from '../domains/audit'
import {
  type ResolvedBinding,
  type VerifiedGatewayIdentity,
  verifyGatewayRequest,
} from '../domains/gateway-context'
import type { CatalogProvider } from '../domains/catalog'
import {
  type AggregateFunction,
  type AggregateMetric,
  AGGREGATE_FUNCTIONS,
} from '../domains/records'
import type { RecordsService } from '../domains/records'
import type { WorkspaceIdentity } from '../domains/workspaces'
import { envelopeFor } from './errors'
import { openapiDocument } from './openapi'
import { secretsMatch } from './secrets'
import { buildSchemaMetadata } from './schema-metadata'

/** The environment of the application: the variables of the request. */
export type AppEnv = { Variables: AppVariables }

/** The variables of the context of a request. */
export interface AppVariables {
  requestId: string
  context?: RequestContext
  gateway?: VerifiedGatewayIdentity
  workspace?: WorkspaceIdentity
}

/** The dependencies of the application. */
export interface AppDependencies {
  readonly settings: {
    readonly production: boolean
    readonly requests: { maxBodyBytes: number; timeoutMs: number }
    readonly observability: { metricsToken?: string }
  }
  readonly records: RecordsService
  readonly resolver: ContextResolverLike
  readonly bindings: readonly ResolvedBinding[]
  /** The catalog of the workspace: its collections and its policies. */
  readonly catalog: CatalogProvider
  readonly auditReader: AuditReader
  readonly metrics: Metrics
  readonly logger: Logger
  readonly clock: Clock
  readonly readiness: ReadinessLike
  /** The version of the service, as the release that built it. */
  readonly serviceVersion: string
  /** The version of the manifest of the deployment. */
  readonly schemaVersion: string
}

/** The resolver of the context, as the application uses it. */
export interface ContextResolverLike {
  resolve: (
    request: {
      subject: string
      tenantId: string
      workspaceId: string
      routeId: string
    },
    options: {
      fresh: boolean
      source: 'shuttle' | 'worker'
      requestId: string
      policyBundleVersion?: string
    }
  ) => Promise<ResolvedContext>
}

/** The readiness of the process, as the application uses it. */
export interface ReadinessLike {
  check: () => Promise<{ ready: boolean; reason?: string }>
}

/** The methods of every route of the service. */
const ROUTES: readonly { pattern: RegExp; methods: readonly string[] }[] = [
  { pattern: /^\/ws\/[^/]+\/v1\/me$/, methods: ['GET'] },
  { pattern: /^\/ws\/[^/]+\/v1\/schema$/, methods: ['GET'] },
  { pattern: /^\/ws\/[^/]+\/v1\/schema\/[^/]+$/, methods: ['GET'] },
  { pattern: /^\/ws\/[^/]+\/v1\/aggregate\/[^/]+$/, methods: ['GET'] },
  { pattern: /^\/ws\/[^/]+\/v1\/items\/[^/]+$/, methods: ['GET', 'POST'] },
  { pattern: /^\/ws\/[^/]+\/v1\/items\/[^/]+\/[^/]+$/, methods: ['GET', 'PATCH', 'DELETE'] },
  { pattern: /^\/ws\/[^/]+\/v1\/audit$/, methods: ['GET'] },
  { pattern: /^\/ws\/[^/]+\/v1\/openapi\.json$/, methods: ['GET'] },
]

/** The parameters of a query, with the detection of the repetitions. */
export class QueryError extends ServiceError {
  constructor(message: string) {
    super('INVALID_QUERY', { message })
  }
}

/**
 * Reads the parameters of a query.
 *
 * A parameter that appears twice is refused: the answer would depend on
 * which value the reader picked.
 */
export function readQuery(url: URL, allowed: readonly string[]): Map<string, string> {
  const raw = url.search.startsWith('?') ? url.search.slice(1) : url.search
  if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) {
    throw new QueryError('the query is too long')
  }
  const values = new Map<string, string>()
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key)) {
      throw new QueryError(`the parameter "${key}" is not known`)
    }
    if (values.has(key)) {
      throw new QueryError(`the parameter "${key}" appears twice`)
    }
    values.set(key, value)
  }
  return values
}

/** The methods that change the data. */
const MUTATIONS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/** Builds the application. */
export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
    const started = Date.now()
    try {
      await next()
    } finally {
      const status = c.res.status
      const duration = Date.now() - started
      dependencies.metrics.increment('data_requests_total', {
        route: normalizeRoute(c.req.path),
        method: c.req.method,
        status: String(status),
      })
      dependencies.metrics.observe('data_request_duration_ms', duration, {
        route: normalizeRoute(c.req.path),
        method: c.req.method,
      })
    }
  })

  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? 'unknown'
    if (error instanceof ServiceError) {
      if (error.code === 'FORBIDDEN') {
        dependencies.metrics.increment('data_authorization_denials_total', { reason: error.code })
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...error.headers,
      }
      return new Response(JSON.stringify(envelopeFor(error, requestId)), {
        status: error.status,
        headers,
      })
    }
    dependencies.logger.error('the request could not be completed', {
      requestId,
      route: normalizeRoute(c.req.path),
      error: error instanceof Error ? error.message : 'unknown error',
      stack: error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 4).join(' | ') : '',
    })
    const failure = new ServiceError('INTERNAL_ERROR')
    return new Response(JSON.stringify(envelopeFor(failure, requestId)), {
      status: failure.status,
      headers: { 'content-type': 'application/json' },
    })
  })

  app.notFound((c) => {
    const requestId = c.get('requestId') ?? 'unknown'
    const path = new URL(c.req.url).pathname
    for (const route of ROUTES) {
      if (!route.pattern.test(path)) continue
      if (route.methods.includes(c.req.method)) continue
      const error = new ServiceError('INVALID_REQUEST', {
        message: 'the method is not allowed here',
      })
      return new Response(JSON.stringify(envelopeFor(error, requestId)), {
        status: 405,
        headers: { 'content-type': 'application/json', allow: route.methods.join(', ') },
      })
    }
    const error = new ServiceError('NOT_FOUND')
    return new Response(JSON.stringify(envelopeFor(error, requestId)), {
      status: error.status,
      headers: { 'content-type': 'application/json' },
    })
  })

  // The operational endpoints are not routed through the authorization of
  // a workspace.
  app.get('/healthz', (c) =>
    c.json({
      status: 'ok',
      service: 'data-backend',
      version: dependencies.serviceVersion,
      schemaVersion: dependencies.schemaVersion,
    })
  )

  app.get('/readyz', async (c) => {
    const state = await dependencies.readiness.check()
    if (!state.ready) {
      return c.json({ status: 'not_ready', reason: state.reason ?? 'unknown' }, 503)
    }
    return c.json({ status: 'ready' })
  })

  app.get('/metrics', (c) => {
    const token = dependencies.settings.observability.metricsToken
    if (!token) {
      return new Response('not found', { status: 404 })
    }
    const presented = c.req.header('authorization') ?? ''
    if (!secretsMatch(presented, `Bearer ${token}`)) {
      return new Response('unauthorized', { status: 401 })
    }
    return new Response(dependencies.metrics.render(), {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    })
  })

  // The context of a request: the gateway, the workspace and Hub.
  const establish = async (c: Context<AppEnv>, next: Next): Promise<void> => {
    const url = new URL(c.req.url)
    const identity = await verifyGatewayRequest(dependencies.bindings, {
      method: c.req.method,
      path: url.pathname,
      query: url.search,
      headers: c.req.raw.headers,
    })
    const workspaceId = c.req.param('workspaceId')
    if (workspaceId !== identity.workspaceId) {
      throw new ServiceError('UNAUTHENTICATED')
    }
    // The workspace and its catalog are read together: the identity of
    // the workspace is the identity of the registry, and the catalog is
    // the configuration of the workspace.
    const found = await dependencies.catalog.find(identity.workspaceId)
    if (!found) {
      throw new ServiceError('NOT_FOUND')
    }
    const workspace = found.workspace
    if (workspace.status !== 'active') {
      throw new ServiceError('NOT_FOUND')
    }
    if (identity.expectedTenantId && identity.expectedTenantId !== workspace.tenantId) {
      throw new ServiceError('NOT_FOUND')
    }
    const fresh = MUTATIONS.has(c.req.method)
    const resolved = await dependencies.resolver.resolve(
      {
        subject: identity.subject,
        tenantId: workspace.tenantId,
        workspaceId: workspace.id,
        routeId: identity.routeId,
      },
      {
        fresh,
        source: 'shuttle',
        requestId: c.get('requestId') ?? 'unknown',
        policyBundleVersion: found.catalog.policyBundleVersion,
      }
    )
    const context: RequestContext = {
      ...resolved.context,
      policyBundleVersion: found.catalog.policyBundleVersion,
      catalog: { manifest: found.catalog.manifest, bundle: found.catalog.bundle },
    }
    c.set('context', context)
    c.set('gateway', identity)
    c.set('workspace', workspace)
    await next()
  }

  const scope = '/ws/:workspaceId/v1'

  app.get(`${scope}/me`, establish, (c) => {
    const context = requireContext(c)
    return c.json(
      {
        data: {
          principalId: context.principalId,
          tenantId: context.tenantId,
          workspaceId: context.workspaceId,
          routeId: context.routeId,
          apiVersion: 'v1',
        },
      },
      200,
      { 'cache-control': 'no-store' }
    )
  })

  app.get(`${scope}/openapi.json`, establish, (c) =>
    c.json(openapiDocument(dependencies.schemaVersion, dependencies.serviceVersion), 200, {
      'cache-control': 'no-store',
    })
  )

  app.get(`${scope}/schema`, establish, (c) => {
    const context = requireContext(c)
    const metadata = buildSchemaMetadata({
      context,
      manifest: context.catalog.manifest,
      bundle: context.catalog.bundle,
      schemaVersion: context.catalog.manifest.schemaVersion,
    })
    return c.json({ data: metadata }, 200, { 'cache-control': 'no-store' })
  })

  app.get(`${scope}/schema/:collection`, establish, (c) => {
    const context = requireContext(c)
    const key = collectionOf(c) ?? ''
    const metadata = buildSchemaMetadata({
      context,
      manifest: context.catalog.manifest,
      bundle: context.catalog.bundle,
      schemaVersion: context.catalog.manifest.schemaVersion,
    })
    const collection = metadata.collections.find((entry) => entry.key === key)
    if (!collection) {
      throw new ServiceError('NOT_FOUND')
    }
    return c.json({ data: collection }, 200, { 'cache-control': 'no-store' })
  })

  app.get(`${scope}/aggregate/:collection`, establish, async (c) => {
    const context = requireContext(c)
    const url = new URL(c.req.url)
    const query = readQuery(url, ['group_by', 'metrics', 'filter', 'search', 'limit'])
    const limit = query.has('limit') ? Number(query.get('limit')) : undefined
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
      throw new ServiceError('INVALID_QUERY', { message: 'the limit is not a valid number' })
    }
    const groupBy = (query.get('group_by') ?? '')
      .split(',')
      .map((field) => field.trim())
      .filter((field) => field.length > 0)
    const metrics = parseMetrics(query.get('metrics') ?? '')
    const filter = query.has('filter') ? parseJson(query.get('filter')!) : undefined
    const result = await dependencies.records.aggregate(context, collectionOf(c), {
      groupBy,
      metrics,
      ...(filter === undefined ? {} : { filter }),
      ...(query.has('search') ? { search: query.get('search')! } : {}),
      limit: limit ?? 100,
    })
    return c.json({ data: result.data, meta: result.meta }, 200, { 'cache-control': 'no-store' })
  })

  app.get(`${scope}/items/:collection`, establish, async (c) => {
    const context = requireContext(c)
    const url = new URL(c.req.url)
    const query = readQuery(url, [
      'fields',
      'filter',
      'search',
      'sort',
      'limit',
      'cursor',
      'include',
      'include_count',
    ])
    const limit = query.has('limit') ? Number(query.get('limit')) : undefined
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
      throw new ServiceError('INVALID_QUERY', { message: 'the limit is not a valid number' })
    }
    const filter = query.has('filter') ? parseJson(query.get('filter')!) : undefined
    const result = await dependencies.records.list(context, collectionOf(c), {
      ...(query.has('fields')
        ? {
            fields: query
              .get('fields')!
              .split(',')
              .filter((f) => f.length > 0),
          }
        : {}),
      ...(filter === undefined ? {} : { filter }),
      ...(query.has('search') ? { search: query.get('search')! } : {}),
      ...(query.has('sort')
        ? {
            sort: query
              .get('sort')!
              .split(',')
              .filter((f) => f.length > 0),
          }
        : {}),
      limit: limit ?? 50,
      ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}),
      ...(query.has('include')
        ? {
            include: query
              .get('include')!
              .split(',')
              .filter((f) => f.length > 0),
          }
        : {}),
      includeCount: query.get('include_count') === 'true',
    })
    return c.json({ data: result.data, meta: result.meta }, 200, { 'cache-control': 'no-store' })
  })

  app.get(`${scope}/items/:collection/:id`, establish, async (c) => {
    const context = requireContext(c)
    const result = await dependencies.records.get(context, collectionOf(c), recordId(recordOf(c)))
    return new Response(JSON.stringify({ data: result.representation }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        etag: result.etag,
        'cache-control': 'no-store',
      },
    })
  })

  app.post(`${scope}/items/:collection`, establish, async (c) => {
    const context = requireContext(c)
    const body = await readJsonBody(c, dependencies.settings.requests.maxBodyBytes)
    const key = c.req.header('idempotency-key')
    if (!key || !/^[A-Za-z0-9._-]{1,128}$/.test(key)) {
      throw new ServiceError('INVALID_REQUEST', {
        message: 'the idempotency key is required and it is a short string',
      })
    }
    const result = await dependencies.records.create(context, collectionOf(c), {
      body,
      idempotencyKey: key,
    })
    const id = result.receipt!.id
    return new Response(JSON.stringify({ data: result.receipt }), {
      status: 201,
      headers: {
        'content-type': 'application/json',
        location: `/ws/${context.workspaceId}/v1/items/${collectionOf(c)}/${id}`,
        ...(result.replayed ? { 'idempotency-replayed': 'true' } : {}),
        'cache-control': 'no-store',
      },
    })
  })

  app.patch(`${scope}/items/:collection/:id`, establish, async (c) => {
    const context = requireContext(c)
    const body = await readJsonBody(c, dependencies.settings.requests.maxBodyBytes)
    const result = await dependencies.records.update(context, collectionOf(c), {
      id: recordId(recordOf(c)),
      body,
      expectedEtag: c.req.header('if-match') ?? '',
    })
    return new Response(JSON.stringify({ data: result.representation }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        etag: result.etag!,
        'cache-control': 'no-store',
      },
    })
  })

  app.delete(`${scope}/items/:collection/:id`, establish, async (c) => {
    const context = requireContext(c)
    await dependencies.records.remove(context, collectionOf(c), {
      id: recordId(recordOf(c)),
      expectedEtag: c.req.header('if-match') ?? '',
    })
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  })

  app.get(`${scope}/audit`, establish, async (c) => {
    const context = requireContext(c)
    if (!context.permissionKeys.includes('data.audit.read')) {
      throw new ServiceError('FORBIDDEN')
    }
    const url = new URL(c.req.url)
    const query = readQuery(url, ['limit', 'cursor'])
    const limit = query.has('limit') ? Number(query.get('limit')) : 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ServiceError('INVALID_QUERY', { message: 'the limit is not a valid number' })
    }
    let position: { occurredAt: string; id: string } | undefined
    if (query.has('cursor')) {
      const raw = query.get('cursor')!
      const index = raw.indexOf('|')
      if (index < 0) {
        throw new ServiceError('INVALID_CURSOR')
      }
      position = { occurredAt: raw.slice(0, index), id: raw.slice(index + 1) }
    }
    const page = await dependencies.auditReader.list(
      { tenantId: context.tenantId, workspaceId: context.workspaceId },
      { limit, ...(position ? { position } : {}) }
    )
    return c.json(
      {
        data: page.entries,
        meta: { limit, nextCursor: page.nextCursor },
      },
      200,
      { 'cache-control': 'no-store' }
    )
  })

  return app
}

/**
 * The identifier of a record.
 *
 * An identifier that is not a uuid names no record: the answer is the
 * same as the answer of a record that does not exist.
 */
function collectionOf(c: Context<AppEnv>): string {
  return c.req.param('collection') ?? ''
}

/** The identifier of a record of a request. */
function recordOf(c: Context<AppEnv>): string {
  return recordId(c.req.param('id') ?? '')
}

/** The identifier of a record. */
function recordId(value: string): string {
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
  ) {
    throw new ServiceError('NOT_FOUND')
  }
  return value.toLowerCase()
}

/** The context of a request, when it is established. */
function requireContext(c: Context<AppEnv>): RequestContext {
  const context = c.get('context') as RequestContext | undefined
  if (!context) {
    throw new ServiceError('UNAUTHENTICATED')
  }
  return context
}

/** Reads the body of a write. */
async function readJsonBody(
  c: Context<AppEnv>,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ServiceError('INVALID_REQUEST', {
      message: 'the body must be a json document',
    })
  }
  const text = await c.req.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ServiceError('PAYLOAD_TOO_LARGE')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ServiceError('INVALID_REQUEST', { message: 'the body is not json' })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ServiceError('INVALID_REQUEST', { message: 'the body is not an object' })
  }
  return parsed as Record<string, unknown>
}

/** Parses a json value of a query. */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new ServiceError('INVALID_QUERY', { message: 'the filter is not json' })
  }
}

/**
 * Parses the metrics of an aggregate.
 *
 * A metric is `count`, or a function and a field: `sum:amount`. The
 * function is checked by the domain, and the field with it.
 */
function parseMetrics(value: string): AggregateMetric[] {
  const metrics: AggregateMetric[] = []
  for (const entry of value.split(',')) {
    const name = entry.trim()
    if (name.length === 0) continue
    if (name === 'count') continue
    const separator = name.indexOf(':')
    if (separator <= 0 || separator === name.length - 1) {
      throw new ServiceError('INVALID_QUERY', {
        message: 'a metric is count, or a function and a field',
      })
    }
    const fn = name.slice(0, separator)
    const field = name.slice(separator + 1)
    if (!(AGGREGATE_FUNCTIONS as readonly string[]).includes(fn)) {
      throw new ServiceError('INVALID_QUERY', { message: `the function "${fn}" is not known` })
    }
    metrics.push({ function: fn as AggregateFunction, field })
  }
  if (metrics.length === 0) {
    // The count of the rows is always part of the answer.
    return []
  }
  return metrics
}

/**
 * The normalized name of a route.
 *
 * The name is a pattern and not a path: a path carries the identifiers
 * of the records and it would grow the metrics without a bound.
 */
export function normalizeRoute(path: string): string {
  for (const route of ROUTES) {
    if (route.pattern.test(path)) {
      return route.pattern.source
    }
  }
  if (path === '/healthz') return '/healthz'
  if (path === '/readyz') return '/readyz'
  if (path === '/metrics') return '/metrics'
  return 'other'
}
