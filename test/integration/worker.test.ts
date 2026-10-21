import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { testDatabase, type TestDatabase } from '../helpers/database'
import { PostgresDeliveryStore } from '../../src/platform/postgres/adapters'
import { ConnectionPool } from '../../src/platform/postgres/database'
import { SubscriberWorker, retryDelay } from '../../src/runtime/worker'
import { createLogger } from '../../src/observability/logger'
import { createMetrics } from '../../src/observability/metrics'
import { systemClock } from '../../src/protocol/clock'
import type { Subscriber } from '../../src/domains/events'
import { ServiceError } from '../../src/protocol/errors'
import { WorkspaceCatalogProvider } from '../../src/domains/catalog'
import { parseManifestBundle } from '../../src/domains/schema'
import { parsePolicyBundle } from '../../src/domains/authorization/policies'

let database: TestDatabase
let owner: Client
let pool: ConnectionPool
let store: PostgresDeliveryStore

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111'

beforeAll(async () => {
  database = await testDatabase()
  await database.reset()
  await database.seed([{ id: WORKSPACE_ID, tenantId: TENANT_ID, slug: 'acme' }])
  owner = new Client({ connectionString: database.ownerUrl })
  await owner.connect()
  pool = new ConnectionPool({
    url: database.deliveryUrl,
    max: 5,
    statementTimeoutMs: 3000,
    acquireTimeoutMs: 2000,
    applicationName: 'test-delivery',
  })
  store = new PostgresDeliveryStore(pool)
})

afterAll(async () => {
  await owner?.end()
  await pool?.close()
})

/** Writes an event and a delivery. */
async function writeEvent(
  options: { eventId?: string; subscriberId?: string; causationDepth?: number } = {}
): Promise<string> {
  const eventId = options.eventId ?? crypto.randomUUID()
  const subscriberId = options.subscriberId ?? 'test-subscriber'
  await owner.query(
    `insert into platform.outbox_events
     (id, version, type, tenant_id, workspace_id, collection, record_id, record_version, actor_id,
      occurred_at, changed_fields, correlation_id, causation_id, causation_depth, payload)
     values ($1::uuid, 1, 'record.created', $2::uuid, $3::uuid, 'articles', $4::uuid, 1, $5::uuid,
             now(), '{}', 'request-1', null, $6, $7::jsonb)`,
    [
      eventId,
      TENANT_ID,
      WORKSPACE_ID,
      crypto.randomUUID(),
      PRINCIPAL_ID,
      options.causationDepth ?? 0,
      JSON.stringify({
        version: 1,
        eventId,
        type: 'record.created',
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        collection: 'articles',
        recordId: crypto.randomUUID(),
        recordVersion: 1,
        actorId: PRINCIPAL_ID,
        occurredAt: new Date().toISOString(),
        changedFields: [],
        correlationId: 'request-1',
        causationId: null,
        causationDepth: options.causationDepth ?? 0,
      }),
    ]
  )
  await owner.query(
    `insert into platform.outbox_deliveries
     (event_id, subscriber_id, tenant_id, workspace_id, state, attempts, next_attempt_at, created_at, updated_at)
     values ($1::uuid, $2, $3::uuid, $4::uuid, 'pending', 0, now(), now(), now())`,
    [eventId, subscriberId, TENANT_ID, WORKSPACE_ID]
  )
  return eventId
}

/** The manifest of the deployment. */
const manifest = parseManifestBundle(await Bun.file('manifests/schema.json').text())
/** The bundle of the deployment. */
const bundle = parsePolicyBundle(await Bun.file('manifests/policies.json').text(), manifest)

/** The catalog of the tests: the deployment registered nothing. */
const catalog = new WorkspaceCatalogProvider({
  store: {
    findById: async (id: string) => ({
      workspace: { id, tenantId: TENANT_ID, status: 'active' as const },
      registry: { collections: [], bundle: null },
    }),
  },
  deployment: { manifest, bundle },
})

/** A resolver of the tests. */
const resolver = {
  resolve: async () => ({
    context: {
      principalId: PRINCIPAL_ID,
      tenantId: TENANT_ID,
      workspaceId: WORKSPACE_ID,
      routeId: 'data-worker',
      permissionKeys: ['content.reader'],
      requestId: 'worker-1',
      source: 'worker' as const,
      policyBundleVersion: 'test',
      authorizationDeadline: Number.MAX_SAFE_INTEGER,
    },
    deadline: Number.MAX_SAFE_INTEGER,
  }),
}

/** A worker with the subscribers that are asked. */
function worker(subscribers: readonly Subscriber[]): SubscriberWorker {
  return new SubscriberWorker({
    store,
    resolver,
    catalog,
    records: {} as never,
    subscribers,
    principalId: PRINCIPAL_ID,
    routeId: 'data-worker',
    concurrency: 4,
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    logger: createLogger({ level: 'error' }),
    metrics: createMetrics(),
    clock: systemClock,
  })
}

/** A subscriber that does nothing. */
const noop: Subscriber = {
  id: 'test-subscriber',
  filter: { collections: ['articles'] },
  handler: async () => {},
}

describe('the claim of the deliveries', () => {
  test('two workers never claim the same delivery', async () => {
    const first = await writeEvent()
    const second = await writeEvent()
    const a = await store.claimDue({ workerId: 'a', limit: 1, leaseMs: 30_000 })
    const b = await store.claimDue({ workerId: 'b', limit: 1, leaseMs: 30_000 })
    const ids = new Set([...a, ...b].map((delivery) => delivery.eventId))
    expect(ids.size).toBe(2)
    expect([a[0]?.eventId, b[0]?.eventId].sort()).toEqual([first, second].sort())
  })

  test('a delivery that is leased is not claimed twice', async () => {
    await writeEvent()
    const first = await store.claimDue({ workerId: 'a', limit: 10, leaseMs: 30_000 })
    const second = await store.claimDue({ workerId: 'b', limit: 10, leaseMs: 30_000 })
    expect(first.length).toBe(1)
    expect(second.length).toBe(0)
  })

  test('a delivery whose lease expired is claimed again', async () => {
    const eventId = await writeEvent()
    await store.claimDue({ workerId: 'a', limit: 10, leaseMs: 30_000 })
    await owner.query(
      `update platform.outbox_deliveries set lease_expires_at = now() - interval '1 second' where event_id = $1::uuid`,
      [eventId]
    )
    const again = await store.claimDue({ workerId: 'b', limit: 10, leaseMs: 30_000 })
    expect(again.map((delivery) => delivery.eventId)).toContain(eventId)
    expect(again[0]?.attempts).toBe(2)
  })

  test('an acknowledged delivery is not claimed again', async () => {
    const eventId = await writeEvent()
    const claimed = await store.claimDue({ workerId: 'a', limit: 10, leaseMs: 30_000 })
    const delivery = claimed.find((entry) => entry.eventId === eventId)!
    await store.acknowledge(delivery)
    const again = await store.claimDue({ workerId: 'b', limit: 10, leaseMs: 30_000 })
    expect(again.map((entry) => entry.eventId)).not.toContain(eventId)
  })
})

describe('the execution of the deliveries', () => {
  test('a delivery without a handler is failed and not acknowledged', async () => {
    const eventId = await writeEvent({ subscriberId: 'missing-subscriber' })
    const instance = worker([noop])
    await instance.tick()
    const deliveries = await store.deliveriesOf(eventId)
    expect(deliveries[0]?.state).toBe('failed')
    expect(deliveries[0]?.lastError).toContain('not registered')
  })

  test('a delivery of a handler is acknowledged', async () => {
    const eventId = await writeEvent()
    const seen: string[] = []
    const instance = worker([
      {
        id: 'test-subscriber',
        filter: { collections: ['articles'] },
        handler: async (event) => {
          seen.push(event.eventId)
        },
      },
    ])
    await instance.tick()
    const deliveries = await store.deliveriesOf(eventId)
    expect(deliveries[0]?.state).toBe('acked')
    expect(seen).toContain(eventId)
  })

  test('a chain of events that is too deep is refused', async () => {
    const eventId = await writeEvent({ causationDepth: 10 })
    const instance = worker([noop])
    await instance.tick()
    const deliveries = await store.deliveriesOf(eventId)
    expect(deliveries[0]?.state).toBe('failed')
    expect(deliveries[0]?.lastError).toContain('depth')
  })

  test('a failure is retried and the retry grows', async () => {
    const eventId = await writeEvent()
    const instance = worker([
      {
        id: 'test-subscriber',
        filter: { collections: ['articles'] },
        handler: async () => {
          throw new Error('the temporary failure')
        },
      },
    ])
    await instance.tick()
    const deliveries = await store.deliveriesOf(eventId)
    expect(deliveries[0]?.state).toBe('pending')
    expect(deliveries[0]?.attempts).toBe(1)
    expect(retryDelay(1, () => 0)).toBeLessThan(retryDelay(5, () => 0))
    expect(retryDelay(20, () => 0)).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  test('a delivery that exhausted its attempts is failed', async () => {
    const eventId = await writeEvent()
    await owner.query(
      `update platform.outbox_deliveries set attempts = 8, next_attempt_at = now() where event_id = $1::uuid`,
      [eventId]
    )
    const instance = worker([
      {
        id: 'test-subscriber',
        filter: { collections: ['articles'] },
        handler: async () => {
          throw new Error('the temporary failure')
        },
      },
    ])
    await instance.tick()
    const deliveries = await store.deliveriesOf(eventId)
    expect(deliveries[0]?.state).toBe('failed')
  })

  test('a refusal of the authorization fails the delivery for good', async () => {
    const eventId = await writeEvent()
    const instance = new SubscriberWorker({
      store,
      resolver: {
        resolve: async () => {
          throw new ServiceError('FORBIDDEN')
        },
      },
      catalog,
      records: {} as never,
      subscribers: [noop],
      principalId: PRINCIPAL_ID,
      routeId: 'data-worker',
      concurrency: 4,
      leaseMs: 30_000,
      heartbeatMs: 10_000,
      logger: createLogger({ level: 'error' }),
      metrics: createMetrics(),
      clock: systemClock,
    })
    await instance.tick()
    const deliveries = await store.deliveriesOf(eventId)
    expect(deliveries[0]?.state).toBe('failed')
  })
})
