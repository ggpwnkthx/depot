/**
 * The harness of the tests of the service.
 *
 * The harness builds the real application, with the real adapters and a
 * real PostgreSQL server, and it signs the requests the way the pinned
 * gateway does. The hub is the fixture of the tests: the evidence of the
 * real integration is produced by the compatibility harness.
 */

import { CompactSign, base64url } from 'jose'
import { createApp } from '../../src/app/app'
import { ContextResolver } from '../../src/domains/authorization'
import { parsePolicyBundle } from '../../src/domains/authorization/policies'
import { HubAccessContextClient } from '../../src/domains/authorization/adapters/hub-access-context'
import { WorkspaceCatalogProvider } from '../../src/domains/catalog'
import type { ResolvedBinding } from '../../src/domains/gateway-context'
import { RecordsService } from '../../src/domains/records'
import { parseManifestBundle } from '../../src/domains/schema'
import {
  PostgresAuditReader,
  PostgresAuditSink,
  PostgresOutbox,
} from '../../src/platform/postgres/adapters'
import { PostgresCatalogStore } from '../../src/platform/postgres/catalog'
import { ConnectionPool } from '../../src/platform/postgres/database'
import { PostgresDataStore } from '../../src/platform/postgres/scoped'
import { createLogger } from '../../src/observability/logger'
import { createMetrics } from '../../src/observability/metrics'
import { systemClock } from '../../src/protocol/clock'
import { type FakeHub, startFakeHub } from './hub'
import { type TestDatabase, testDatabase } from './database'

/** The workspace of the tests. */
export const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
/** The other workspace of the tests, of another tenant. */
export const OTHER_WORKSPACE_ID = '33333333-3333-4333-8333-333333333333'
/** The principal of the tests. */
export const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111'
/** The tenant of the workspace of the tests. */
export const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** The tenant of the other workspace. */
export const OTHER_TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** The key of the identity of the tests. */
export const IDENTITY_KEY = new Uint8Array(
  Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef', 'utf8')
)

/** The host of the tests. */
export const HOST = 'api.example.test'

/** The harness of the tests. */
export interface Harness {
  readonly app: ReturnType<typeof createApp>
  readonly hub: FakeHub
  readonly database: TestDatabase
  readonly records: RecordsService
  /** Sends a signed request to the application. */
  request: (
    path: string,
    options?: {
      method?: string
      body?: unknown
      headers?: Record<string, string>
      subject?: string
      workspaceId?: string
      host?: string
      query?: string
      roles?: string[]
      email?: string
      signature?: string | null
      key?: Uint8Array
    }
  ) => Promise<Response>
  /** Sends a request without a signature. */
  raw: (
    path: string,
    options?: { method?: string; headers?: Record<string, string> }
  ) => Promise<Response>
  stop: () => Promise<void>
}

/** Builds the harness. */
export async function createHarness(options: { policies?: string } = {}): Promise<Harness> {
  const database = await testDatabase()
  await database.reset()
  await database.seed([
    { id: WORKSPACE_ID, tenantId: TENANT_ID, slug: 'acme', name: 'Acme' },
    { id: OTHER_WORKSPACE_ID, tenantId: OTHER_TENANT_ID, slug: 'other', name: 'Other' },
  ])
  const hub = await startFakeHub()
  const manifest = parseManifestBundle(await readFile('manifests/schema.json'))
  const bundle = parsePolicyBundle(
    options.policies ?? (await readFile('manifests/policies.json')),
    manifest
  )

  const dataPool = new ConnectionPool({
    url: database.runtimeUrl,
    max: 5,
    statementTimeoutMs: 3000,
    acquireTimeoutMs: 2000,
    applicationName: 'data-backend-test',
  })
  const registryPool = new ConnectionPool({
    url: database.registryUrl,
    max: 2,
    statementTimeoutMs: 3000,
    acquireTimeoutMs: 2000,
    applicationName: 'data-backend-test-registry',
  })

  const store = new PostgresDataStore(dataPool, {
    statementTimeoutMs: 3000,
    transactionTimeoutMs: 5000,
  })
  const audit = new PostgresAuditSink()
  const auditReader = new PostgresAuditReader(store)
  const outbox = new PostgresOutbox()

  const hubClient = new HubAccessContextClient({
    baseUrl: hub.url,
    credential: 'test-access-context-credential',
    timeoutMs: 1000,
  })
  const resolver = new ContextResolver({
    client: hubClient,
    cacheTtlMs: 0,
    credentialScope: 'test',
    clock: systemClock,
  })

  const records = new RecordsService({
    store,
    clock: systemClock,
    cursorKey: new Uint8Array(Buffer.from('cursor-key-of-the-tests-000000000000', 'utf8')),
    audit,
    outbox,
    subscribers: [],
  })

  const catalog = new WorkspaceCatalogProvider({
    store: new PostgresCatalogStore(registryPool),
    deployment: { manifest, bundle },
  })

  const bindings: ResolvedBinding[] = [
    {
      binding: {
        id: 'data-api',
        host: HOST,
        upstreamPathPattern: '/ws/{workspaceId}/v1/*',
        routeId: 'data-api',
        identityKeyFile: 'test',
      },
      identityKey: IDENTITY_KEY,
    },
  ]

  const app = createApp({
    settings: {
      production: false,
      requests: { maxBodyBytes: 1024 * 1024, timeoutMs: 10_000 },
      observability: {},
    },
    records,
    resolver,
    bindings,
    catalog,
    auditReader,
    metrics: createMetrics(),
    logger: createLogger({ level: 'debug' }),
    clock: systemClock,
    readiness: { check: async () => ({ ready: true }) },
    schemaVersion: manifest.schemaVersion,
  })

  const request = async (
    path: string,
    options: {
      method?: string
      body?: unknown
      headers?: Record<string, string>
      subject?: string
      workspaceId?: string
      host?: string
      query?: string
      roles?: string[]
      email?: string
      signature?: string | null
      key?: Uint8Array
    } = {}
  ): Promise<Response> => {
    const method = options.method ?? 'GET'
    const separator = path.indexOf('?')
    const pathOnly = separator < 0 ? path : path.slice(0, separator)
    const query = separator < 0 ? (options.query ?? '') : path.slice(separator)
    const subject = options.subject ?? PRINCIPAL_ID
    const workspaceId = options.workspaceId ?? WORKSPACE_ID
    const host = options.host ?? HOST
    const roles = options.roles ?? ['member']
    const email = options.email
    const signature =
      options.signature === null
        ? null
        : (options.signature ??
          (await sign(
            method,
            pathOnly,
            query,
            host,
            subject,
            workspaceId,
            roles,
            email,
            options.key ?? IDENTITY_KEY
          )))
    const headers = new Headers(options.headers ?? {})
    headers.set('x-forwarded-host', host)
    headers.set('x-shuttle-user', subject)
    headers.set('x-shuttle-workspace', workspaceId)
    if (roles.length > 0) headers.set('x-shuttle-roles', roles.join(','))
    if (email) headers.set('x-shuttle-email', email)
    if (signature) headers.set('x-shuttle-signature', signature)
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    return await app.request(`http://${host}${pathOnly}${query}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }

  return {
    app,
    hub,
    database,
    records,
    request,
    raw: async (path, options = {}) =>
      await app.request(`http://${HOST}${path}`, {
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      }),
    stop: async () => {
      await dataPool.close()
      await registryPool.close()
      await hub.stop()
    },
  }
}

/** Reads a file of the repository. */
async function readFile(path: string): Promise<string> {
  return await Bun.file(path).text()
}

/** Signs a request the way the pinned gateway does. */
export async function sign(
  method: string,
  path: string,
  query: string,
  host: string,
  subject: string,
  workspaceId: string,
  roles: readonly string[],
  email: string | undefined,
  key: Uint8Array
): Promise<string> {
  const payload = JSON.stringify({
    v: 'v4',
    method: method.toUpperCase(),
    path,
    query,
    host: host.toLowerCase(),
    subject,
    workspaceId,
    email: email ?? '',
    roles: [...roles].sort(),
  })
  const jws = await new CompactSign(new TextEncoder().encode(payload))
    .setProtectedHeader({ alg: 'HS256', typ: 'shuttle-identity' })
    .sign(key)
  const [header, , signature] = jws.split('.')
  return `v4=${header}..${signature}`
}

/** The base64 of the identity of a body. */
export function base64(value: Uint8Array): string {
  return base64url.encode(value)
}
