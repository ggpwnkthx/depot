/**
 * The hub of the tests (spec §5).
 *
 * The fake hub speaks the access context contract of the specification:
 * it answers the discovery, it evaluates a request against the grants it
 * holds and it refuses what it may not answer. It is a fixture of the
 * domain tests and of the tests of the failure injection.
 *
 * The evidence of the real integration is produced by the compatibility
 * harness, which runs the real hub with the real extension.
 */

/** The grants of a principal. */
export interface FakeGrant {
  readonly tenantId: string
  readonly workspaceId?: string
  readonly routeId?: string
  readonly permissionKeys: readonly string[]
  /** The moment the grant expires, in milliseconds since the epoch. */
  readonly expiresAt?: number
  /** True when the grant was revoked. */
  readonly revoked?: boolean
}

/** The fake hub. */
export interface FakeHub {
  url: string
  /** The requests the hub received, for the assertions. */
  readonly requests: { path: string; body: unknown }[]
  /** The grants of the fixture. */
  readonly grants: Map<string, FakeGrant[]>
  /** True when the hub refuses every request. */
  unavailable: boolean
  /** True when the hub answers a context that is already expired. */
  expired: boolean
  /** The lifetime the hub announces. */
  maxLifetimeMs: number
  /** Stops the hub. */
  stop: () => Promise<void>
}

/** The options of the fake hub. */
export interface FakeHubOptions {
  /** The credential the hub accepts. */
  readonly credential?: string
  /** The port of the hub. */
  readonly port?: number
}

/** Starts the fake hub. */
export async function startFakeHub(options: FakeHubOptions = {}): Promise<FakeHub> {
  const credential = options.credential ?? 'test-access-context-credential'
  const state: FakeHub = {
    url: '',
    requests: [],
    grants: new Map(),
    unavailable: false,
    expired: false,
    maxLifetimeMs: 5000,
    stop: async () => {
      await server.stop(true)
    },
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/v1/access-context') {
        return new Response('not found', { status: 404 })
      }
      if (state.unavailable) {
        return new Response('unavailable', { status: 503 })
      }
      if (request.headers.get('authorization') !== `Bearer ${credential}`) {
        return new Response('unauthorized', { status: 401 })
      }
      if (request.method === 'GET') {
        return Response.json({
          versions: [1],
          maxPermissionKeys: 4096,
          maxLifetimeMs: state.maxLifetimeMs,
        })
      }
      const body = (await request.json()) as Record<string, unknown>
      state.requests.push({ path: url.pathname, body })
      if (body.version !== 1) {
        return Response.json({ error: 'bad_request' }, { status: 400 })
      }
      const subject = String(body.subject ?? '')
      const tenantId = String(body.tenantId ?? '')
      const workspaceId = String(body.workspaceId ?? '')
      const routeId = String(body.routeId ?? '')
      const grants = state.grants.get(subject) ?? []
      const now = Date.now()
      const live = grants.filter((grant) => {
        if (grant.tenantId !== tenantId) return false
        if (grant.revoked) return false
        if (grant.expiresAt !== undefined && grant.expiresAt <= now) return false
        if (grant.workspaceId !== undefined && grant.workspaceId !== workspaceId) return false
        if (grant.routeId !== undefined && grant.routeId !== routeId) return false
        return true
      })
      const evaluatedAt = new Date(now).toISOString()
      if (live.length === 0) {
        return Response.json({
          version: 1,
          allow: false,
          subject,
          tenantId,
          workspaceId,
          routeId,
          permissionKeys: [],
          evaluatedAt,
        })
      }
      const keys = [...new Set(live.flatMap((grant) => [...grant.permissionKeys]))].sort()
      const earliest = live.reduce<number | undefined>((current, grant) => {
        if (grant.expiresAt === undefined) return current
        return current === undefined ? grant.expiresAt : Math.min(current, grant.expiresAt)
      }, undefined)
      const limit = Math.min(now + state.maxLifetimeMs, earliest ?? now + state.maxLifetimeMs)
      const validUntil = state.expired ? now - 1000 : limit
      return Response.json({
        version: 1,
        allow: true,
        subject,
        tenantId,
        workspaceId,
        routeId,
        permissionKeys: keys,
        evaluatedAt,
        validUntil: new Date(validUntil).toISOString(),
      })
    },
  })
  state.url = `http://127.0.0.1:${server.port}`
  return state
}
