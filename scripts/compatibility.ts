#!/usr/bin/env bun
/**
 * The compatibility harness (spec §16 and §17).
 *
 * The harness runs the **real** pinned gateway, the **real** extended
 * hub and the **real** backend of this repository, against a real
 * PostgreSQL server, and it performs the acceptance scenario through the
 * gateway.
 *
 * The hub is the extended one: the pinned hub carries the extension of
 * the access context contract since `4cedcfc`, and the harness checks
 * the contract against it directly. The gateway is the pinned one and it
 * is never modified.
 *
 * The commands:
 *
 *   bun run scripts/compatibility.ts
 *
 * The environment:
 *
 *   SHUTTLE_REPOSITORY  the repository of the gateway (default: github)
 *   HUB_REPOSITORY      the repository of the hub (default: github)
 *   COMPAT_KEEP         when it is set, the temporary directory is kept
 */

import { spawn, spawnSync, type Subprocess } from 'bun'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { Client } from 'pg'
import { startPostgres, type StartedPostgres } from './postgres'
import { freePort } from './postgres'
import { applyMigrations, loadMigrations } from '../src/platform/postgres/migrations'
import { ConnectionPool } from '../src/platform/postgres/database'

/** The commit of the gateway. */
const SHUTTLE_COMMIT = process.env.SHUTTLE_COMMIT ?? 'e39d73efc37e0ca75ae5df24136babf56430ebc7'
/** The commit of the hub. It carries the extension of the access context. */
const HUB_COMMIT = process.env.HUB_COMMIT ?? '4cedcfc48e9bb4eb556d2316eb502e1ab87d3105'
/** The repository of the gateway. */
const SHUTTLE_REPOSITORY = process.env.SHUTTLE_REPOSITORY ?? 'https://github.com/ggpwnkthx/shuttle'
/** The repository of the hub. */
const HUB_REPOSITORY = process.env.HUB_REPOSITORY ?? 'https://github.com/ggpwnkthx/hub'

/** The secrets of the harness. They are fixtures of a test. */
const SESSION_SECRET = 'compatibility-session-secret-0001'
const HUB_ADMIN_TOKEN = 'compatibility-admin-token-000001'
const HUB_ACCESS_TOKEN = 'compatibility-access-token-000001'
const CONTEXT_TOKEN = 'compatibility-context-token-00001'
const ROLE_PASSWORDS = {
  owner: 'compatibility-owner-password-01',
  runtime: 'compatibility-runtime-password-1',
  registry: 'compatibility-registry-password',
  delivery: 'compatibility-delivery-password',
  maintenance: 'compatibility-maintenance-passw',
} as const

/** The tenants of the harness. */
const TENANT_SLUG = 'acme'
const OTHER_TENANT_SLUG = 'globex'
/** The workspace of the harness. */
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_WORKSPACE_ID = '33333333-3333-4333-8333-333333333333'
/** The host of the gateway. */
const HOST = 'api.shuttle.test'

/** The steps of the harness. */
const steps: string[] = []

/** Reports a step. */
function step(message: string): void {
  steps.push(message)
  console.log(JSON.stringify({ level: 'info', msg: message }))
}

/** Fails the harness. */
function _fail(message: string): never {
  console.error(JSON.stringify({ level: 'error', msg: message }))
  process.exit(1)
}

/** Waits for an endpoint to answer. */
async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.status < 500) return
    } catch {
      // The service is not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`the service at ${url} did not answer`)
}

/** Clones a repository at a commit. */
function clone(repository: string, commit: string, directory: string): void {
  const clone = spawnSync(['git', 'clone', '--quiet', repository, directory])
  if (clone.exitCode !== 0) {
    throw new Error(`the clone of ${repository} failed: ${clone.stderr.toString()}`)
  }
  const checkout = spawnSync(['git', 'checkout', '--quiet', commit], { cwd: directory })
  if (checkout.exitCode !== 0) {
    throw new Error(`the checkout of ${commit} failed: ${checkout.stderr.toString()}`)
  }
}

/** Installs the dependencies of a checkout. */
function install(directory: string): void {
  const result = spawnSync(['bun', 'install'], { cwd: directory })
  if (result.exitCode !== 0) {
    throw new Error(`the installation of ${directory} failed: ${result.stderr.toString()}`)
  }
}

/** Starts a process and waits for its port. */
function start(
  name: string,
  command: string[],
  options: { cwd: string; env: Record<string, string> }
): { process: Subprocess; logs: string[] } {
  const child = spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const lines: string[] = []
  const collect = (stream: ReadableStream<Uint8Array> | undefined): void => {
    if (!stream) return
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) {
        for (const line of decoder.decode(chunk).split('\n')) {
          if (line.trim().length === 0) continue
          lines.push(line)
          if (lines.length > 200) lines.shift()
        }
      }
    })()
  }
  collect(child.stdout as ReadableStream<Uint8Array>)
  collect(child.stderr as ReadableStream<Uint8Array>)
  child.exited.then(() => {
    console.error(
      JSON.stringify({ level: 'error', msg: `the process ${name} stopped`, logs: lines.slice(-10) })
    )
  })
  return { process: child, logs: lines }
}

/** A very small cookie jar. */
class CookieJar {
  #cookies = new Map<string, string>()

  capture(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const cookies = headers.getSetCookie?.() ?? []
    for (const cookie of cookies) {
      const [pair] = cookie.split(';')
      if (!pair) continue
      const index = pair.indexOf('=')
      if (index < 0) continue
      this.#cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
    }
  }

  header(): string {
    return [...this.#cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
  }
}

/** The main of the harness. */
async function main(): Promise<void> {
  let postgres: StartedPostgres | null = null
  const workspace = await mkdtemp(join(tmpdir(), 'data-backend-compat-'))
  const processes: Subprocess[] = []
  const stop = async (): Promise<void> => {
    for (const process of processes) {
      try {
        process.kill()
      } catch {
        // The process is already gone.
      }
    }
    if (process.env.COMPAT_KEEP) {
      console.log(
        JSON.stringify({ level: 'info', msg: 'the directory is kept', directory: workspace })
      )
      return
    }
    await rm(workspace, { recursive: true, force: true })
  }

  try {
    // 1. The reference checkouts.
    const shuttleDirectory = join(workspace, 'shuttle')
    const hubDirectory = join(workspace, 'hub')
    step(`the gateway is cloned at ${SHUTTLE_COMMIT}`)
    clone(SHUTTLE_REPOSITORY, SHUTTLE_COMMIT, shuttleDirectory)
    step(`the hub is cloned at ${HUB_COMMIT}`)
    clone(HUB_REPOSITORY, HUB_COMMIT, hubDirectory)
    install(shuttleDirectory)
    install(hubDirectory)

    // 2. The database.
    postgres = await startPostgres({
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
    for (const role of [
      'data_owner',
      'data_runtime',
      'data_registry',
      'data_delivery',
      'data_maintenance',
    ]) {
      const password = ROLE_PASSWORDS[role.replace('data_', '') as keyof typeof ROLE_PASSWORDS]
      const statement = await admin.query<{ statement: string }>(
        `select format('create role %I with login password %L', $1::text, $2::text) as statement`,
        [role, password]
      )
      await admin.query(statement.rows[0]!.statement)
    }
    await admin.query('create database depot_compat owner data_owner')
    await admin.end()
    step('the database of the harness is ready')

    const base = `postgres://depot:depot@127.0.0.1:${postgres.port}`
    const ownerUrl = `postgres://data_owner:${ROLE_PASSWORDS.owner}@127.0.0.1:${postgres.port}/depot_compat`
    const runtimeUrl = `postgres://data_runtime:${ROLE_PASSWORDS.runtime}@127.0.0.1:${postgres.port}/depot_compat`
    const registryUrl = `postgres://data_registry:${ROLE_PASSWORDS.registry}@127.0.0.1:${postgres.port}/depot_compat`
    const deliveryUrl = `postgres://data_delivery:${ROLE_PASSWORDS.delivery}@127.0.0.1:${postgres.port}/depot_compat`
    const _maintenanceUrl = `postgres://data_maintenance:${ROLE_PASSWORDS.maintenance}@127.0.0.1:${postgres.port}/depot_compat`

    // 3. The migrations of the backend.
    const ownerPool = new ConnectionPool({
      url: ownerUrl,
      max: 1,
      statementTimeoutMs: 60_000,
      acquireTimeoutMs: 10_000,
      applicationName: 'compat-migrate',
    })
    const migrations = await loadMigrations(join(process.cwd(), 'migrations'))
    await applyMigrations(ownerPool, migrations)
    await ownerPool.close()
    step('the migrations of the backend are applied')

    // 4. The extended hub.
    const hubPort = await freePort()
    const hubUrl = `http://127.0.0.1:${hubPort}`
    // The database of the hub is created before it starts.
    const creator = new Client({
      connectionString: `postgres://depot@localhost/postgres?host=${encodeURIComponent(socketDirectory)}&port=${postgres.port}`,
    })
    await creator.connect()
    await creator.query('create database hub_compat owner depot')
    await creator.end()
    const hub = start('hub', ['bun', 'run', 'src/main.ts'], {
      cwd: hubDirectory,
      env: {
        HUB_HOST: '127.0.0.1',
        HUB_PORT: String(hubPort),
        HUB_ISSUER: hubUrl,
        HUB_PUBLIC_URL: hubUrl,
        HUB_DATABASE_URL: `${base}/hub_compat`,
        HUB_ALLOW_MEMORY_STATE: 'true',
        HUB_ADMIN_TOKEN: HUB_ADMIN_TOKEN,
        HUB_ACCESS_TOKEN: HUB_ACCESS_TOKEN,
        HUB_ACCESS_CONTEXT_TOKENS: JSON.stringify({ [CONTEXT_TOKEN]: null }),
        HUB_STATE_SECRET: 'compatibility-state-secret-0000001',
        HUB_SECRET_ENCRYPTION_KEY: 'compatibility-encryption-key-00001',
        HUB_LOG_LEVEL: 'error',
        HUB_ENVIRONMENT: 'development',
      },
    })
    processes.push(hub.process)
    await waitFor(`${hubUrl}/healthz`)
    step('the extended hub is ready')

    // The discovery of the access context contract. The pinned hub has to
    // answer it: it is the readiness check of the backend, and a hub that
    // does not answer it never lets the backend serve a request.
    const contextDiscovery = await fetch(`${hubUrl}/v1/access-context`, {
      headers: { authorization: `Bearer ${CONTEXT_TOKEN}` },
    })
    if (!contextDiscovery.ok) {
      throw new Error(
        `the hub does not answer the discovery of the access context: ${await contextDiscovery.text()}`
      )
    }
    const contract = (await contextDiscovery.json()) as { versions?: number[] }
    if (!Array.isArray(contract.versions) || !contract.versions.includes(1)) {
      throw new Error('the hub does not speak the version of the access context contract')
    }
    step('the hub answers the discovery of the access context contract')

    // 5. The fixtures of the hub: a tenant, a principal, a group, the grants.
    const adminCall = async (
      path: string,
      body: unknown,
      method = 'POST'
    ): Promise<Record<string, unknown>> => {
      const response = await fetch(`${hubUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${HUB_ADMIN_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`the administration of the hub failed at ${path}: ${text}`)
      }
      return JSON.parse(text) as Record<string, unknown>
    }

    const tenant = await adminCall('/v1/admin/tenants', {
      slug: TENANT_SLUG,
      displayName: 'Acme',
      issuer: `${hubUrl}/oidc`,
      idpClientId: 'client',
      idpClientSecret: 'secret',
      clientId: 'gateway',
      clientSecret: 'gateway-secret',
    })
    const otherTenant = await adminCall('/v1/admin/tenants', {
      slug: OTHER_TENANT_SLUG,
      displayName: 'Globex',
      issuer: `${hubUrl}/oidc`,
      idpClientId: 'client',
      idpClientSecret: 'secret',
      clientId: 'gateway-other',
      clientSecret: 'gateway-secret-other',
    })
    const tenantId = String((tenant as { id?: string }).id ?? tenant.tenantId ?? '')
    const otherTenantId = String((otherTenant as { id?: string }).id ?? otherTenant.tenantId ?? '')
    if (!tenantId || !otherTenantId) {
      throw new Error('the administration of the hub did not answer the identifiers')
    }

    const principal = await adminCall('/v1/admin/users', {
      tenant: TENANT_SLUG,
      externalSubject: 'alice-at-the-provider',
      email: 'alice@example.test',
    })
    const principalId = String((principal as { id?: string }).id ?? '')
    const otherPrincipal = await adminCall('/v1/admin/users', {
      tenant: OTHER_TENANT_SLUG,
      externalSubject: 'bob-at-the-provider',
      email: 'bob@example.test',
    })
    const otherPrincipalId = String((otherPrincipal as { id?: string }).id ?? '')

    // The group of the principals, with a grant of its own.
    await adminCall('/v1/admin/groups', {
      tenant: TENANT_SLUG,
      key: 'editors',
      displayName: 'Editors',
      members: ['alice-at-the-provider'],
    })
    await adminCall(
      '/v1/admin/grants',
      {
        tenant: TENANT_SLUG,
        userId: principalId,
        permission: 'content.reader',
        workspaceId: WORKSPACE_ID,
        routeId: 'data-api',
      },
      'PUT'
    )
    await adminCall(
      '/v1/admin/grants',
      {
        tenant: TENANT_SLUG,
        userId: principalId,
        permission: 'content.editor',
        workspaceId: WORKSPACE_ID,
        routeId: 'data-api',
      },
      'PUT'
    )
    // The reader of the worker: the subscriber reads the article with
    // the route of the worker.
    await adminCall(
      '/v1/admin/grants',
      {
        tenant: TENANT_SLUG,
        userId: principalId,
        permission: 'content.reader',
        workspaceId: WORKSPACE_ID,
        routeId: 'data-worker',
      },
      'PUT'
    )
    // The permission of the projection: the subscriber of the worker
    // writes the statistics of the articles with it.
    await adminCall(
      '/v1/admin/grants',
      {
        tenant: TENANT_SLUG,
        userId: principalId,
        permission: 'data.projection.write',
        workspaceId: WORKSPACE_ID,
        routeId: 'data-worker',
      },
      'PUT'
    )
    // The grant of the group: the keys of a group are part of the answer.
    await adminCall(
      '/v1/admin/grants',
      {
        tenant: TENANT_SLUG,
        group: 'editors',
        permission: 'data.audit.read',
        workspaceId: WORKSPACE_ID,
        routeId: 'data-api',
      },
      'PUT'
    )
    // The principal of the other tenant has a grant of its own tenant.
    await adminCall(
      '/v1/admin/grants',
      {
        tenant: OTHER_TENANT_SLUG,
        userId: otherPrincipalId,
        permission: 'globex.reader',
        workspaceId: OTHER_WORKSPACE_ID,
        routeId: 'data-api',
      },
      'PUT'
    )
    step('the fixtures of the hub are written')
    const debugDecision = await fetch(`${hubUrl}/v1/decisions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${HUB_ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        subject: principalId,
        workspaceId: WORKSPACE_ID,
        routeId: 'data-api',
        roles: ['member'],
      }),
    })
    if (debugDecision.status !== 200) {
      throw new Error('the decision of the hub failed')
    }

    // 6. The registry of the backend.
    const owner = new Client({ connectionString: ownerUrl })
    await owner.connect()
    await owner.query(
      `insert into platform.workspaces (id, tenant_id, slug, display_name, status)
       values ($1::uuid, $2::uuid, 'acme', 'Acme', 'active'),
              ($3::uuid, $4::uuid, 'globex', 'Globex', 'active')`,
      [WORKSPACE_ID, tenantId, OTHER_WORKSPACE_ID, otherTenantId]
    )
    await owner.end()
    step('the registry of the backend knows the workspaces')

    // 7. The identity key of the gateway and the configuration of the backend.
    const identityKey = createHmac('sha256', SESSION_SECRET)
      .update('shuttle-identity-signature-v1')
      .digest()
    const identityKeyFile = join(workspace, 'identity.key')
    await writeFile(identityKeyFile, identityKey.toString('base64'))
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
    await writeFile(cursorKeyFile, 'the-cursor-key-of-the-compatibility-harness-0001')

    const backendPort = await freePort()
    const backendUrl = `http://127.0.0.1:${backendPort}`
    const backend = start('backend', ['bun', 'run', 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        DATA_HOST: '127.0.0.1',
        DATA_PORT: String(backendPort),
        DATA_PROCESS_ROLE: 'all',
        DATA_DATABASE_URL: runtimeUrl,
        DATA_REGISTRY_DATABASE_URL: registryUrl,
        DATA_DELIVERY_DATABASE_URL: deliveryUrl,
        DATA_SHUTTLE_BINDINGS_FILE: bindingsFile,
        DATA_SCHEMA_BUNDLE_FILE: join(process.cwd(), 'manifests/schema.json'),
        DATA_POLICY_BUNDLE_FILE: join(process.cwd(), 'manifests/policies.json'),
        DATA_HUB_URL: hubUrl,
        DATA_HUB_CONTEXT_TOKEN_FILE: (() => {
          const file = join(workspace, 'hub-context.token')
          spawnSync(['sh', '-c', `printf %s ${CONTEXT_TOKEN} > ${file}`])
          return file
        })(),
        DATA_CURSOR_KEY_FILE: cursorKeyFile,
        DATA_WORKER_PRINCIPAL_ID: principalId,
        DATA_WORKER_ROUTE_ID: 'data-worker',
        DATA_LOG_LEVEL: 'info',
        DATA_ENVIRONMENT: 'development',
      },
    })
    processes.push(backend.process)
    try {
      await waitFor(`${backendUrl}/readyz`)
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'the backend did not start',
          logs: backend.logs.slice(-20),
        })
      )
      throw error
    }
    step('the backend is ready')

    // 8. The identity provider and the gateway.
    const oidc = await import(join(shuttleDirectory, 'services/oidc-provider.ts'))
    const gatewayPort = await freePort()
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`
    const idp = await oidc.startOidcProvider({
      redirectUris: [`${gatewayUrl}/auth/callback`],
      users: [
        {
          // The subject of the caller is the identifier of the principal
          // of the hub: it is what the tokens of the hub carry, and it
          // is what the gateway forwards.
          sub: principalId,
          email: 'alice@example.test',
          name: 'Alice',
          roles: ['member'],
          password: 'alice-password',
        },
      ],
    })
    const configFile = join(workspace, 'routes.json')
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        defaults: { auth: { mode: 'none' }, forwardAuthorization: false },
        trustedProxies: ['127.0.0.1/32'],
        routes: [
          {
            id: 'data-api',
            match: { host: HOST, path: '/ws/{workspaceId}/' },
            upstream: backendUrl,
            auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
            forwardAuthorization: false,
          },
        ],
      })
    )
    const gateway = start('gateway', ['bun', 'run', 'src/main.ts'], {
      cwd: shuttleDirectory,
      env: {
        SHUTTLE_CONFIG: configFile,
        SHUTTLE_GATEWAY_HOST: '127.0.0.1',
        SHUTTLE_GATEWAY_PORT: String(gatewayPort),
        SHUTTLE_OIDC_ISSUER: idp.issuer,
        SHUTTLE_OIDC_CLIENT_ID: idp.clientId,
        SHUTTLE_OIDC_CLIENT_SECRET: idp.clientSecret,
        SHUTTLE_OIDC_REDIRECT_URI: `${gatewayUrl}/auth/callback`,
        SHUTTLE_OIDC_ALLOW_INSECURE: 'true',
        SHUTTLE_ACCESS_URL: hubUrl,
        SHUTTLE_ACCESS_TOKEN: HUB_ACCESS_TOKEN,
        SHUTTLE_SESSION_SECRET: SESSION_SECRET,
        SHUTTLE_SESSION_URL: 'memory://local',
        SHUTTLE_ALLOW_MEMORY_STATE: 'true',
        SHUTTLE_COOKIE_SECURE: 'false',
        SHUTTLE_LOG_LEVEL: 'error',
        SHUTTLE_TRUSTED_PROXIES: '127.0.0.1/32',
      },
    })
    processes.push(gateway.process)
    await waitFor(`${gatewayUrl}/healthz`)
    step('the pinned gateway is ready')

    // 9. The login of the caller, through the gateway.
    const jar = new CookieJar()
    const start_ = await fetch(`${gatewayUrl}/auth/login?redirect=%2F`, { redirect: 'manual' })
    jar.capture(start_)
    const authorizeUrl = start_.headers.get('location')
    if (!authorizeUrl) throw new Error('the gateway did not redirect to the identity provider')
    const resolve = (value: string): string =>
      value.startsWith('/') ? new URL(value, idp.url).toString() : value
    let location = resolve(authorizeUrl)
    for (let hop = 0; hop < 10; hop += 1) {
      if (location.includes('code=')) break
      if (location.includes('/interaction/')) {
        const submitted = await fetch(location, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            ...(jar.header() ? { cookie: jar.header() } : {}),
          },
          body: new URLSearchParams({
            email: 'alice@example.test',
            password: 'alice-password',
          }),
          redirect: 'manual',
        })
        const next = submitted.headers.get('location')
        if (!next) throw new Error('the identity provider rejected the credentials')
        location = resolve(next)
        continue
      }
      const response = await fetch(location, {
        redirect: 'manual',
        headers: jar.header() ? { cookie: jar.header() } : undefined,
      })
      jar.capture(response)
      const next = response.headers.get('location')
      if (!next) throw new Error(`the identity provider stopped the flow (${response.status})`)
      location = resolve(next)
    }
    const callback = await fetch(location, {
      redirect: 'manual',
      headers: jar.header() ? { cookie: jar.header() } : undefined,
    })
    jar.capture(callback)
    if (!jar.header().includes('shuttle_session')) {
      throw new Error('the login did not create a session')
    }
    step('the caller is authenticated through the gateway')

    // 10. The acceptance scenario, through the gateway.
    const call = async (
      path: string,
      options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
    ): Promise<{ status: number; body: unknown; headers: Headers }> => {
      const response = await fetch(`${gatewayUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          host: HOST,
          cookie: jar.header(),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.headers ?? {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: 'manual',
      })
      const text = await response.text()
      let body: unknown = null
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status: response.status, body, headers: response.headers }
    }

    const schema = await call(`/ws/${WORKSPACE_ID}/v1/schema`)
    if (schema.status !== 200) {
      throw new Error(`the schema was not discovered: ${JSON.stringify(schema.body)}`)
    }
    const metadata = schema.body as { data: { collections?: { key: string }[] } }
    const keys = (metadata.data.collections ?? []).map((entry) => entry.key)
    if (!keys.includes('articles')) {
      throw new Error(`the articles collection was not discovered: ${keys.join(', ')}`)
    }
    step('the collection is discovered through the gateway')

    const created = await call(`/ws/${WORKSPACE_ID}/v1/items/articles`, {
      method: 'POST',
      headers: { 'idempotency-key': 'compat-1' },
      body: { title: 'Launch notes', body: 'Initial content.' },
    })
    if (created.status !== 201) {
      throw new Error(`the creation failed: ${JSON.stringify(created.body)}`)
    }
    const receipt = created.body as { data: { id: string } }
    const articleId = receipt.data.id
    step('an article is created through the gateway')

    const read = await call(`/ws/${WORKSPACE_ID}/v1/items/articles/${articleId}`)
    if (read.status !== 200) {
      throw new Error(`the read failed: ${JSON.stringify(read.body)}`)
    }
    const record = read.body as { data: { title: string } }
    if (record.data.title !== 'Launch notes') {
      throw new Error('the read did not answer the permitted fields')
    }
    const etag = read.headers.get('etag')
    if (!etag) throw new Error('the read did not answer a validator')
    step('the article is read with its validator')

    const updated = await call(`/ws/${WORKSPACE_ID}/v1/items/articles/${articleId}`, {
      method: 'PATCH',
      headers: { 'if-match': etag },
      body: { title: 'Launch notes, revised' },
    })
    if (updated.status !== 200) {
      throw new Error(`the update failed: ${JSON.stringify(updated.body)}`)
    }
    const updatedRecord = updated.body as { data: { version: number } }
    if (updatedRecord.data.version !== 2) {
      throw new Error('the update did not increment the version')
    }
    step('the article is updated with a current validator')

    const audit = await call(`/ws/${WORKSPACE_ID}/v1/audit`)
    if (audit.status !== 200) {
      throw new Error(`the audit was not readable: ${JSON.stringify(audit.body)}`)
    }
    const auditBody = audit.body as { data: unknown[] }
    if (!Array.isArray(auditBody.data) || auditBody.data.length === 0) {
      throw new Error('the audit log is empty')
    }
    step('the audit metadata is readable')

    // The subscriber of the worker writes the statistics of the article.
    const deadline = Date.now() + 20_000
    let projected = 0
    const reader = new Client({ connectionString: ownerUrl })
    await reader.connect()
    while (Date.now() < deadline && projected === 0) {
      const stats = await reader.query(
        `select count(*)::text as count from data.article_stats where workspace_id = $1::uuid`,
        [WORKSPACE_ID]
      )
      projected = Number(stats.rows[0]?.count ?? '0')
      if (projected === 0) await new Promise((resolve) => setTimeout(resolve, 200))
    }
    await reader.end()
    if (projected === 0) {
      throw new Error('the subscriber of the worker did not write its projection')
    }
    step('the subscriber of the worker wrote its projection')

    // The other tenant and the other workspace are not accessible.
    const other = await call(`/ws/${OTHER_WORKSPACE_ID}/v1/items/articles/${articleId}`)
    if (other.status !== 404 && other.status !== 403) {
      throw new Error(`another workspace was accessible: ${other.status}`)
    }
    const otherList = await call(`/ws/${OTHER_WORKSPACE_ID}/v1/items/articles`)
    if (otherList.status !== 404 && otherList.status !== 403) {
      throw new Error(`another workspace was listable: ${otherList.status}`)
    }
    step('another tenant and another workspace cannot reach the data')

    // 11. The contract of the hub, on the real service.
    const discovery = await fetch(`${hubUrl}/v1/access-context`, {
      headers: { authorization: `Bearer ${CONTEXT_TOKEN}` },
    })
    if (!discovery.ok) {
      throw new Error(`the discovery of the contract failed: ${discovery.status}`)
    }
    const discoveryBody = (await discovery.json()) as Record<string, unknown>
    if (!((discoveryBody.versions as number[]) ?? []).includes(1)) {
      throw new Error('the hub does not speak the version of the contract')
    }
    const context = await fetch(`${hubUrl}/v1/access-context`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CONTEXT_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: 1,
        subject: principalId,
        tenantId,
        workspaceId: WORKSPACE_ID,
        routeId: 'data-api',
      }),
    })
    if (!context.ok) {
      throw new Error(`the context of the hub failed: ${context.status}`)
    }
    const contextBody = (await context.json()) as Record<string, unknown>
    const permissionKeys = (contextBody.permissionKeys as string[]) ?? []
    for (const key of ['content.reader', 'content.editor', 'data.audit.read']) {
      if (!permissionKeys.includes(key)) {
        throw new Error(
          `the context of the hub does not hold "${key}": ${permissionKeys.join(', ')}`
        )
      }
    }
    step('the real hub answers the complete set of the scoped keys')

    // The existing decision of the gateway is untouched.
    const decision = await fetch(`${hubUrl}/v1/decisions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${HUB_ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        subject: principalId,
        workspaceId: WORKSPACE_ID,
        routeId: 'data-api',
        roles: ['member'],
      }),
    })
    const decisionBody = (await decision.json()) as Record<string, unknown>
    if (decisionBody.allow !== true) {
      throw new Error('the existing decision of the gateway does not allow the principal')
    }
    step('the existing decision of the gateway still works')

    // 12. The tampering, directly against the backend.
    const forged = await fetch(`${backendUrl}/ws/${WORKSPACE_ID}/v1/items/articles`, {
      headers: {
        'x-forwarded-host': HOST,
        'x-shuttle-user': '11111111-1111-4111-8111-111111111111',
        'x-shuttle-workspace': WORKSPACE_ID,
        'x-shuttle-signature': 'v4=eyJhbGciOiJIUzI1NiIsInR5cCI6InNodXR0bGUtaWRlbnRpdHkifQ..AAAA',
      },
    })
    if (forged.status !== 401) {
      throw new Error(`a forged signature was accepted: ${forged.status}`)
    }
    const withoutSignature = await fetch(`${backendUrl}/ws/${WORKSPACE_ID}/v1/items/articles`, {
      headers: {
        'x-forwarded-host': HOST,
        'x-shuttle-user': '11111111-1111-4111-8111-111111111111',
        'x-shuttle-workspace': WORKSPACE_ID,
      },
    })
    if (withoutSignature.status !== 401) {
      throw new Error(`a request without a signature was accepted: ${withoutSignature.status}`)
    }
    step('a forged or missing signature is refused')

    await idp.stop()
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'the compatibility harness passed',
        steps: steps.length,
      })
    )
  } finally {
    await stop()
    postgres?.stop()
  }
}

await main()
