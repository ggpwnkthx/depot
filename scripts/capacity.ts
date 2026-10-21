#!/usr/bin/env bun
/**
 * The capacity measurement of a deployment (spec §15.5).
 *
 * The command starts a complete deployment of the development machine: a
 * PostgreSQL server, a hub of the fixtures, the backend and a load. It
 * measures the latency of the reads, the latency of the writes and the
 * behaviour under the failure of a dependency.
 *
 * The numbers of the report of `docs/capacity.md` come from this command.
 * They describe the machine they were measured on, and they are not a
 * promise about another one.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { CompactSign } from 'jose'
import { startPostgres, freePort } from './postgres'
import { loadMigrations, applyMigrations } from '../src/platform/postgres/migrations'
import { ConnectionPool } from '../src/platform/postgres/database'
import { createRuntime } from '../src/runtime/composition'
import { startFakeHub } from '../test/helpers/hub'
import { writeFile } from 'node:fs/promises'

/** The scenarios of the measurement. */
const CLIENTS = Number(process.env.CAPACITY_CLIENTS ?? '16')
const DURATION_MS = Number(process.env.CAPACITY_DURATION_MS ?? '10000')
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111'
const HOST = 'api.example.test'
const KEY = new Uint8Array(Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef', 'utf8'))

/** The percentiles of a list of durations. */
function percentiles(values: number[]): Record<string, number> {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
  }
}

/** Signs a request the way the gateway does. */
async function sign(
  method: string,
  path: string,
  query: string,
  subject: string,
  workspaceId: string
): Promise<string> {
  const payload = JSON.stringify({
    v: 'v4',
    method,
    path,
    query,
    host: HOST,
    subject,
    workspaceId,
    email: '',
    roles: [],
  })
  const jws = await new CompactSign(new TextEncoder().encode(payload))
    .setProtectedHeader({ alg: 'HS256', typ: 'shuttle-identity' })
    .sign(KEY)
  const [header, , signature] = jws.split('.')
  return `v4=${header}..${signature}`
}

/** The main of the measurement. */
async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'data-backend-capacity-'))
  const postgres = await startPostgres({
    dataDir: join(workspace, 'pg'),
    fresh: true,
    user: 'depot',
    password: 'depot',
  })
  const socketDirectory = join(workspace, 'socket')
  const admin = new Client({
    connectionString: `postgres://depot@localhost/postgres?host=${encodeURIComponent(socketDirectory)}&port=${postgres.port}`,
  })
  await admin.connect()
  await admin.query("alter role depot with password 'depot'")
  const passwords = {
    data_owner: 'capacity-owner-password-000001',
    data_runtime: 'capacity-runtime-password-0001',
    data_registry: 'capacity-registry-password-001',
    data_delivery: 'capacity-delivery-password-0001',
    data_maintenance: 'capacity-maintenance-password-01',
  }
  for (const [role, password] of Object.entries(passwords)) {
    const statement = await admin.query<{ statement: string }>(
      `select format('create role %I with login password %L', $1::text, $2::text) as statement`,
      [role, password]
    )
    await admin.query(statement.rows[0]!.statement)
  }
  await admin.query('create database depot_capacity owner data_owner')
  await admin.end()

  const _base = `postgres://depot:depot@127.0.0.1:${postgres.port}`
  const ownerUrl = `postgres://data_owner:${passwords.data_owner}@127.0.0.1:${postgres.port}/depot_capacity`
  const runtimeUrl = `postgres://data_runtime:${passwords.data_runtime}@127.0.0.1:${postgres.port}/depot_capacity`
  const registryUrl = `postgres://data_registry:${passwords.data_registry}@127.0.0.1:${postgres.port}/depot_capacity`
  const deliveryUrl = `postgres://data_delivery:${passwords.data_delivery}@127.0.0.1:${postgres.port}/depot_capacity`

  const ownerPool = new ConnectionPool({
    url: ownerUrl,
    max: 1,
    statementTimeoutMs: 60_000,
    acquireTimeoutMs: 10_000,
    applicationName: 'capacity-migrate',
  })
  await applyMigrations(ownerPool, await loadMigrations(join(process.cwd(), 'migrations')))
  await ownerPool.close()

  const owner = new Client({ connectionString: ownerUrl })
  await owner.connect()
  await owner.query(
    `insert into platform.workspaces (id, tenant_id, slug, display_name, status)
     values ($1::uuid, $2::uuid, 'acme', 'Acme', 'active')`,
    [WORKSPACE_ID, TENANT_ID]
  )
  await owner.end()

  const hub = await startFakeHub()
  hub.grants.set(PRINCIPAL_ID, [
    {
      tenantId: TENANT_ID,
      permissionKeys: ['content.reader', 'content.editor', 'data.audit.read'],
    },
  ])

  const identityKeyFile = join(workspace, 'identity.key')
  await writeFile(identityKeyFile, Buffer.from(KEY).toString('base64'))
  const bindingsFile = join(workspace, 'bindings.json')
  await writeFile(
    bindingsFile,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          id: 'data-api',
          host: HOST,
          upstreamPathPattern: '/ws/{workspaceId}/v1/*',
          routeId: 'data-api',
          identityKeyFile,
        },
      ],
    })
  )
  const cursorKeyFile = join(workspace, 'cursor.key')
  await writeFile(cursorKeyFile, 'the-cursor-key-of-the-capacity-harness-000001')
  const tokenFile = join(workspace, 'hub-context.token')
  await writeFile(tokenFile, 'test-access-context-credential')

  const port = await freePort()
  const runtime = await createRuntime({
    env: {
      DATA_HOST: '127.0.0.1',
      DATA_PORT: String(port),
      DATA_PROCESS_ROLE: 'api',
      DATA_ENVIRONMENT: 'development',
      DATA_LOG_LEVEL: 'error',
      DATA_DATABASE_URL: runtimeUrl,
      DATA_REGISTRY_DATABASE_URL: registryUrl,
      DATA_DELIVERY_DATABASE_URL: deliveryUrl,
      DATA_SHUTTLE_BINDINGS_FILE: bindingsFile,
      DATA_SCHEMA_BUNDLE_FILE: join(process.cwd(), 'manifests/schema.json'),
      DATA_POLICY_BUNDLE_FILE: join(process.cwd(), 'manifests/policies.json'),
      DATA_HUB_URL: hub.url,
      DATA_HUB_CONTEXT_TOKEN_FILE: tokenFile,
      DATA_CURSOR_KEY_FILE: cursorKeyFile,
      DATA_CONTEXT_CACHE_TTL_MS: process.env.DATA_CONTEXT_CACHE_TTL_MS ?? '0',
    } as Record<string, string>,
  })
  const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: runtime.app.fetch })

  const call = async (
    path: string,
    method = 'GET',
    body?: unknown,
    extraHeaders: Record<string, string> = {}
  ): Promise<number> => {
    const separator = path.indexOf('?')
    const pathOnly = separator < 0 ? path : path.slice(0, separator)
    const query = separator < 0 ? '' : path.slice(separator)
    const signature = await sign(method, pathOnly, query, PRINCIPAL_ID, WORKSPACE_ID)
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'x-forwarded-host': HOST,
        'x-shuttle-user': PRINCIPAL_ID,
        'x-shuttle-workspace': WORKSPACE_ID,
        'x-shuttle-signature': signature,
        ...extraHeaders,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    await response.text()
    return response.status
  }

  // The data of the measurement: a thousand articles.
  console.log(JSON.stringify({ level: 'info', msg: 'the data is written' }))
  for (let index = 0; index < 1000; index += 1) {
    await call(
      `/ws/${WORKSPACE_ID}/v1/items/articles`,
      'POST',
      { title: `Article ${index}`, body: 'The body of the article.' },
      { 'idempotency-key': `seed-${index}` }
    )
  }

  /** Runs a scenario and returns the durations and the failures. */
  const run = async (
    name: string,
    action: (client: number) => Promise<number>
  ): Promise<{ name: string; durations: number[]; failures: number; requests: number }> => {
    const durations: number[] = []
    const statuses = new Map<number, number>()
    let failures = 0
    let requests = 0
    const deadline = Date.now() + DURATION_MS
    await Promise.all(
      Array.from({ length: CLIENTS }, async (_value, client) => {
        while (Date.now() < deadline) {
          const started = performance.now()
          const status = await action(client)
          durations.push(performance.now() - started)
          requests += 1
          statuses.set(status, (statuses.get(status) ?? 0) + 1)
          if (status >= 500) failures += 1
        }
      })
    )
    const result = { name, durations, failures, requests }
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'the scenario ran',
        name,
        requests,
        failures,
        statuses: Object.fromEntries(statuses),
        latencyMs: percentiles(durations),
        requestsPerSecond: Math.round(requests / (DURATION_MS / 1000)),
      })
    )
    return result
  }

  const read = await run(
    'read-heavy',
    async () => await call(`/ws/${WORKSPACE_ID}/v1/items/articles?limit=50`)
  )
  const mixed = await run('mixed', async (client) => {
    if (client % 2 === 0) {
      return await call(`/ws/${WORKSPACE_ID}/v1/items/articles?limit=20`)
    }
    return await call(
      `/ws/${WORKSPACE_ID}/v1/items/articles`,
      'POST',
      { title: `Concurrent ${client}` },
      { 'idempotency-key': `load-${client}-${Date.now()}-${Math.random()}` }
    )
  })
  const concurrent = await run('concurrent update of one record', async () => {
    const read = await fetch(`http://127.0.0.1:${port}/ws/${WORKSPACE_ID}/v1/items/articles`, {
      headers: {
        'x-forwarded-host': HOST,
        'x-shuttle-user': PRINCIPAL_ID,
        'x-shuttle-workspace': WORKSPACE_ID,
        'x-shuttle-signature': await sign(
          'GET',
          `/ws/${WORKSPACE_ID}/v1/items/articles`,
          '',
          PRINCIPAL_ID,
          WORKSPACE_ID
        ),
      },
    })
    const body = (await read.json()) as { data: { id: string }[] }
    const id = body.data[0]?.id
    if (!id) return 404
    const path = `/ws/${WORKSPACE_ID}/v1/items/articles/${id}`
    const current = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: {
        'x-forwarded-host': HOST,
        'x-shuttle-user': PRINCIPAL_ID,
        'x-shuttle-workspace': WORKSPACE_ID,
        'x-shuttle-signature': await sign('GET', path, '', PRINCIPAL_ID, WORKSPACE_ID),
      },
    })
    const etag = current.headers.get('etag') ?? ''
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'PATCH',
      headers: {
        'x-forwarded-host': HOST,
        'x-shuttle-user': PRINCIPAL_ID,
        'x-shuttle-workspace': WORKSPACE_ID,
        'x-shuttle-signature': await sign('PATCH', path, '', PRINCIPAL_ID, WORKSPACE_ID),
        'if-match': etag,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'Updated' }),
    })
    await response.text()
    return response.status
  })

  // The failure of a dependency: the hub is not available any more.
  hub.unavailable = true
  const degraded = await run(
    'the hub is down',
    async () => await call(`/ws/${WORKSPACE_ID}/v1/items/articles?limit=10`)
  )
  hub.unavailable = false

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'the capacity report is ready',
      scenarios: [read, mixed, concurrent, degraded].map((entry) => ({
        name: entry.name,
        requests: entry.requests,
        failures: entry.failures,
        latencyMs: percentiles(entry.durations),
      })),
    })
  )

  server.stop(true)
  await runtime.stop()
  await hub.stop()
  postgres.stop()
  await rm(workspace, { recursive: true, force: true })
}

await main()
