/**
 * The composition root (spec §13).
 *
 * The composition root is the only place that knows the concrete
 * adapters: it reads the configuration, it loads the artifacts of the
 * deployment, it constructs the ports and it hands the application and
 * the worker the objects they use.
 */

import { readFile } from 'node:fs/promises'
import { systemClock } from '../protocol/clock'
import { ServiceError } from '../protocol/errors'
import { createLogger, type Logger } from '../observability/logger'
import { createMetrics } from '../observability/metrics'
import { createApp } from '../app/app'
import { ContextResolver } from '../domains/authorization'
import { parsePolicyBundle } from '../domains/authorization'
import { HubAccessContextClient } from '../domains/authorization/adapters/hub-access-context'
import { WorkspaceCatalogProvider } from '../domains/catalog'
import { type ResolvedBinding, parseBindingsFile } from '../domains/gateway-context'
import { RecordsService } from '../domains/records'
import { parseManifestBundle } from '../domains/schema'
import {
  PostgresAuditReader,
  PostgresAuditSink,
  PostgresDeliveryStore,
  PostgresOutbox,
} from '../platform/postgres/adapters'
import { PostgresCatalogStore } from '../platform/postgres/catalog'
import { ConnectionPool } from '../platform/postgres/database'
import { loadMigrations } from '../platform/postgres/migrations'
import { PostgresDataStore } from '../platform/postgres/scoped'
import { type Env, type RuntimeSettings, readEnv } from './config'
import { Readiness } from './readiness'
import { articleProjectionSubscriber } from './subscribers'
import { SubscriberWorker } from './worker'

/** The runtime of the process. */
export interface Runtime {
  readonly settings: RuntimeSettings
  readonly app: ReturnType<typeof createApp>
  readonly logger: Logger
  readonly metrics: ReturnType<typeof createMetrics>
  readonly worker?: SubscriberWorker
  readonly readiness: Readiness
  /** Closes the pools and the worker. */
  stop: () => Promise<void>
}

/** The options of the composition. */
export interface CompositionOptions {
  readonly env?: Env
  /** The directory of the migrations. */
  readonly migrationsDir?: string
}

/**
 * Reads the derived identity key of a gateway.
 *
 * The file holds the key of the signature of the identity, in base64 or
 * in hexadecimal. It is the derived key and not the secret of the
 * session: the two are not the same secret and they are not confused.
 */
export async function readIdentityKey(path: string): Promise<Uint8Array> {
  const raw = (await readFile(path, 'utf8')).trim()
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return new Uint8Array(Buffer.from(raw, 'hex'))
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) {
    const decoded = Buffer.from(raw, 'base64')
    if (decoded.length >= 16) return new Uint8Array(decoded)
  }
  const bytes = new Uint8Array(Buffer.from(raw, 'utf8'))
  if (bytes.length >= 16) return bytes
  throw new Error(`the identity key file is too short: ${path}`)
}

/** Builds the runtime of the process. */
export async function createRuntime(options: CompositionOptions = {}): Promise<Runtime> {
  const settings = readEnv(options.env)
  const logger = createLogger({ level: settings.observability.logLevel })
  const metrics = createMetrics()

  // The artifacts of the deployment.
  const manifest = parseManifestBundle(await readFile(settings.bundles.schemaFile, 'utf8'))
  const bundle = parsePolicyBundle(await readFile(settings.bundles.policyFile, 'utf8'), manifest)
  const migrations = await loadMigrations(options.migrationsDir ?? './migrations')

  // The bindings of the gateway and the keys that verify its signatures.
  const bindings: ResolvedBinding[] = []
  if (settings.bindings.file) {
    const raw = await readFile(settings.bindings.file, 'utf8')
    for (const binding of parseBindingsFile(raw)) {
      bindings.push({ binding, identityKey: await readIdentityKey(binding.identityKeyFile) })
    }
  }

  // The pools.
  const dataPool = new ConnectionPool({
    url: settings.database.dataUrl,
    max: settings.database.poolMax,
    statementTimeoutMs: settings.database.statementTimeoutMs,
    acquireTimeoutMs: settings.database.acquireTimeoutMs,
    applicationName: 'data-backend',
    metrics,
  })
  const registryPool = new ConnectionPool({
    url: settings.database.registryUrl,
    max: settings.database.registryPoolMax,
    statementTimeoutMs: settings.database.statementTimeoutMs,
    acquireTimeoutMs: settings.database.acquireTimeoutMs,
    applicationName: 'data-backend-registry',
  })
  const deliveryPool = new ConnectionPool({
    url: settings.database.deliveryUrl,
    max: settings.database.deliveryPoolMax,
    statementTimeoutMs: settings.database.statementTimeoutMs,
    acquireTimeoutMs: settings.database.acquireTimeoutMs,
    applicationName: 'data-backend-delivery',
  })

  // The adapters.
  const store = new PostgresDataStore(dataPool, {
    statementTimeoutMs: settings.database.statementTimeoutMs,
    transactionTimeoutMs: settings.database.transactionTimeoutMs,
    metrics,
  })
  const auditSink = new PostgresAuditSink()
  const auditReader = new PostgresAuditReader(store)
  const outbox = new PostgresOutbox()
  const deliveryStore = new PostgresDeliveryStore(deliveryPool)

  // The client of the hub.
  const hubClient = new HubAccessContextClient({
    baseUrl: settings.hub.url,
    credential: settings.hub.credential,
    timeoutMs: settings.hub.timeoutMs,
    metrics,
  })
  const resolver = new ContextResolver({
    client: hubClient,
    cacheTtlMs: settings.hub.contextCacheTtlMs,
    credentialScope: settings.hub.credential.slice(0, 8),
    clock: systemClock,
    metrics,
  })

  // The catalog of the workspaces: the collections a workspace serves
  // and the bundle of policies that applies to it.
  const catalog = new WorkspaceCatalogProvider({
    store: new PostgresCatalogStore(registryPool),
    deployment: { manifest, bundle },
  })

  // The records.
  const cursorKey = new Uint8Array(
    Buffer.from((await readFile(settings.cursorKeyFile, 'utf8')).trim(), 'utf8')
  )
  // The subscribers are known before the service: the service writes the
  // deliveries of the events, and the handler of a subscriber is bound to
  // the service once it exists.
  const subscriberDefinitions = [
    {
      id: 'article-projection',
      filter: { collections: ['articles'], types: ['record.created', 'record.updated'] },
    },
  ]
  const records = new RecordsService({
    store,
    clock: systemClock,
    cursorKey,
    audit: auditSink,
    outbox,
    subscribers: subscriberDefinitions,
  })
  // The subscriber needs the service, and the service needs the list of
  // the subscribers: the list is built first and the handler is bound
  // afterwards.
  const boundSubscribers = [
    articleProjectionSubscriber({
      records,
      contextFor: async (event) => {
        const found = await catalog.find(event.workspaceId)
        if (!found) {
          throw new ServiceError('FORBIDDEN')
        }
        const resolved = await resolver.resolve(
          {
            subject: settings.worker.principalId,
            tenantId: event.tenantId,
            workspaceId: event.workspaceId,
            routeId: settings.worker.routeId,
          },
          {
            fresh: true,
            source: 'worker',
            requestId: `worker-${event.eventId}`,
            policyBundleVersion: found.catalog.policyBundleVersion,
          }
        )
        return {
          ...resolved.context,
          policyBundleVersion: found.catalog.policyBundleVersion,
          catalog: {
            manifest: found.catalog.manifest,
            bundle: found.catalog.bundle,
          },
          causationId: event.eventId,
          causationDepth: event.causationDepth + 1,
          causationPrincipalId: event.actorId,
        }
      },
    }),
  ]

  const readiness = new Readiness({
    pool: dataPool,
    migrations,
    manifest,
    hub: hubClient,
    logger,
    clock: systemClock,
    worker: settings.role === 'worker' || settings.role === 'all',
    deliveryCheck: async () => {
      await deliveryStore.backlog()
    },
    subscriberCount: boundSubscribers.length,
  })

  const app = createApp({
    settings: {
      production: settings.production,
      requests: settings.requests,
      observability: settings.observability,
    },
    records,
    resolver,
    bindings,
    catalog,
    auditReader,
    metrics,
    logger,
    clock: systemClock,
    readiness,
    schemaVersion: manifest.schemaVersion,
  })

  const worker =
    settings.role === 'worker' || settings.role === 'all'
      ? new SubscriberWorker({
          store: deliveryStore,
          resolver,
          catalog,
          records,
          subscribers: boundSubscribers,
          principalId: settings.worker.principalId,
          routeId: settings.worker.routeId,
          concurrency: settings.worker.concurrency,
          leaseMs: 30_000,
          heartbeatMs: 10_000,
          logger,
          metrics,
          clock: systemClock,
        })
      : undefined

  let stopped = false
  return {
    settings,
    app,
    logger,
    metrics,
    ...(worker ? { worker } : {}),
    readiness,
    stop: async () => {
      // The stop is idempotent: a deployment may send a second signal
      // while the first one is draining, and the pools refuse to be
      // closed twice.
      if (stopped) return
      stopped = true
      if (worker) await worker.stop()
      await dataPool.close()
      await registryPool.close()
      await deliveryPool.close()
    },
  }
}
