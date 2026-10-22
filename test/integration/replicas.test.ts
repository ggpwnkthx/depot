import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime, type Runtime } from '../../src/runtime/composition'
import { testDatabase, type TestDatabase } from '../helpers/database'
import { startFakeHub, type FakeHub } from '../helpers/hub'
import {
  HOST,
  IDENTITY_PUBLIC_PEM,
  PRINCIPAL_ID,
  TENANT_ID,
  WORKSPACE_ID,
  sign,
} from '../helpers/harness'

/**
 * Two replicas of the service against one database.
 *
 * The deployment runs more than one process, and the processes share
 * the database and the state of the hub. The test proves the three
 * things that the sharing can break: the records of one replica are the
 * records of the other, the scope of a transaction never leaks from one
 * request to the next one, and the drain of a replica leaves the other
 * one serving.
 */

let database: TestDatabase
let hub: FakeHub
let workspace: string
let first: Runtime
let second: Runtime

beforeAll(async () => {
  database = await testDatabase()
  await database.reset()
  await database.seed([{ id: WORKSPACE_ID, tenantId: TENANT_ID, slug: 'acme' }])
  hub = await startFakeHub()
  hub.grants.set(PRINCIPAL_ID, [
    { tenantId: TENANT_ID, permissionKeys: ['content.reader', 'content.editor'] },
  ])

  workspace = await mkdtemp(join(tmpdir(), 'depot-replicas-'))
  // The key of the route is the public key of the gateway: the backend
  // verifies with it and it never holds the private one.
  const publicKeyFile = join(workspace, 'identity.public.pem')
  await writeFile(publicKeyFile, IDENTITY_PUBLIC_PEM)
  const bindingsFile = join(workspace, 'bindings.json')
  await writeFile(
    bindingsFile,
    JSON.stringify({
      version: 2,
      bindings: [
        {
          id: 'data-api',
          host: HOST,
          upstreamPathPattern: '/ws/{workspaceId}/v1/*',
          routeId: 'data-api',
          identity: { version: 'v5', algorithm: 'ES256', publicKeyFile },
        },
      ],
    })
  )
  const cursorKeyFile = join(workspace, 'cursor.key')
  await writeFile(cursorKeyFile, 'the-cursor-key-of-the-replica-test-000000001')
  const tokenFile = join(workspace, 'hub-context.token')
  await writeFile(tokenFile, 'test-access-context-credential')

  const env = {
    DATA_HOST: '127.0.0.1',
    DATA_PORT: '8099',
    DATA_PROCESS_ROLE: 'api',
    DATA_ENVIRONMENT: 'development',
    DATA_LOG_LEVEL: 'error',
    DATA_DATABASE_URL: database.runtimeUrl,
    DATA_REGISTRY_DATABASE_URL: database.registryUrl,
    DATA_SHUTTLE_BINDINGS_FILE: bindingsFile,
    DATA_SCHEMA_BUNDLE_FILE: join(process.cwd(), 'manifests/schema.json'),
    DATA_POLICY_BUNDLE_FILE: join(process.cwd(), 'manifests/policies.json'),
    DATA_HUB_URL: hub.url,
    DATA_HUB_CONTEXT_TOKEN_FILE: tokenFile,
    DATA_CURSOR_KEY_FILE: cursorKeyFile,
  } as Record<string, string>

  first = await createRuntime({ env })
  second = await createRuntime({ env })
})

afterAll(async () => {
  await first?.stop()
  await second?.stop()
  await hub?.stop()
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

/** Sends a signed request to a replica. */
async function request(
  runtime: Runtime,
  path: string,
  options: {
    method?: string
    body?: unknown
    headers?: Record<string, string>
    workspaceId?: string
  } = {}
): Promise<Response> {
  const method = options.method ?? 'GET'
  const separator = path.indexOf('?')
  const pathOnly = separator < 0 ? path : path.slice(0, separator)
  const query = separator < 0 ? '' : path.slice(separator)
  const workspaceId = options.workspaceId ?? WORKSPACE_ID
  const signature = await sign(
    method,
    pathOnly,
    query,
    HOST,
    PRINCIPAL_ID,
    workspaceId,
    ['member'],
    undefined
  )
  const headers = new Headers(options.headers ?? {})
  headers.set('x-forwarded-host', HOST)
  headers.set('x-shuttle-user', PRINCIPAL_ID)
  headers.set('x-shuttle-workspace', workspaceId)
  headers.set('x-shuttle-roles', 'member')
  headers.set('x-shuttle-signature', signature)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return await runtime.app.request(`http://${HOST}${pathOnly}${query}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

describe('two replicas of the service', () => {
  test('both replicas answer the identity of the caller', async () => {
    for (const runtime of [first, second]) {
      const response = await request(runtime, `/ws/${WORKSPACE_ID}/v1/me`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: { workspaceId: string } }
      expect(body.data.workspaceId).toBe(WORKSPACE_ID)
    }
  })

  test('a record of one replica is the record of the other one', async () => {
    const created = await request(first, `/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      body: { title: 'Shared' },
      headers: { 'idempotency-key': 'replica-1' },
    })
    expect(created.status).toBe(201)
    const receipt = (await created.json()) as { data: { id: string } }

    const read = await request(second, `/ws/${WORKSPACE_ID}/v1/items/articles/${receipt.data.id}`)
    expect(read.status).toBe(200)
    const body = (await read.json()) as { data: { title: string } }
    expect(body.data.title).toBe('Shared')
  })

  test('the scope of a transaction never leaks from a request to the next one', async () => {
    const other = '33333333-3333-4333-8333-333333333333'
    // The request is signed for the other workspace: the signature is
    // valid, and the workspace does not exist.
    const refused = await request(first, `/ws/${other}/v1/me`, { workspaceId: other })
    expect(refused.status).toBe(404)

    // The connection of the pool is the one of the refused request: the
    // next request must not see the scope of the refused one.
    const answered = await request(first, `/ws/${WORKSPACE_ID}/v1/me`)
    expect(answered.status).toBe(200)
  })

  test('the drain of a replica leaves the other one serving', async () => {
    await first.stop()
    const response = await request(second, `/ws/${WORKSPACE_ID}/v1/me`)
    expect(response.status).toBe(200)
    const list = await request(second, `/ws/${WORKSPACE_ID}/v1/items/articles`)
    expect(list.status).toBe(200)
  })
})
