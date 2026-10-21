import { describe, expect, test } from 'bun:test'
import {
  canonicalIdentityPayload,
  matchPattern,
  parseBindingsFile,
  verifyGatewayRequest,
  verifyIdentitySignature,
} from '../../src/domains/gateway-context'

/** The fixtures of the pinned gateway. */
interface Fixture {
  name: string
  identity: {
    subject: string
    email?: string
    roles: string[]
    workspaceId: string
  }
  request: { method: string; path: string; query: string; host: string }
  canonicalPayload: string
  signature: string
}

const fixture = (await Bun.file('test/fixtures/shuttle-identity.json').json()) as {
  keyBase64: string
  cases: Fixture[]
}

const key = new Uint8Array(Buffer.from(fixture.keyBase64, 'base64'))

describe('the canonical payload of the identity', () => {
  test('it is the payload of the pinned gateway, byte for byte', () => {
    for (const entry of fixture.cases) {
      const payload = canonicalIdentityPayload(entry.identity, entry.request)
      expect(payload).toBe(entry.canonicalPayload)
    }
  })

  test('the roles are sorted and the order is not part of the meaning', () => {
    const entry = fixture.cases[0]!
    const payload = canonicalIdentityPayload(
      { ...entry.identity, roles: ['editor', 'member'] },
      entry.request
    )
    expect(payload).toBe(entry.canonicalPayload)
  })
})

describe('the verification of the signature', () => {
  test('it accepts the signature of the pinned gateway', async () => {
    for (const entry of fixture.cases) {
      const valid = await verifyIdentitySignature(
        entry.identity,
        entry.request,
        key,
        entry.signature
      )
      expect(valid).toBe(true)
    }
  })

  test('it refuses a signature of another path', async () => {
    const entry = fixture.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      { ...entry.request, path: '/ws/22222222-2222-4222-8222-222222222222/v1/items/categories' },
      key,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another query', async () => {
    const entry = fixture.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      { ...entry.request, query: '?limit=10' },
      key,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another host', async () => {
    const entry = fixture.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      { ...entry.request, host: 'other.example.test' },
      key,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another subject', async () => {
    const entry = fixture.cases[0]!
    const valid = await verifyIdentitySignature(
      { ...entry.identity, subject: '99999999-9999-4999-8999-999999999999' },
      entry.request,
      key,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another key', async () => {
    const entry = fixture.cases[0]!
    const other = new Uint8Array(32).fill(7)
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      other,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another version', async () => {
    const entry = fixture.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      key,
      entry.signature.replace('v4=', 'v3=')
    )
    expect(valid).toBe(false)
  })
})

describe('the matching of a pattern', () => {
  test('it matches the workspace of the path', () => {
    const workspace = matchPattern(
      '/ws/{workspaceId}/v1/*',
      '/ws/22222222-2222-4222-8222-222222222222/v1/items/articles'
    )
    expect(workspace).toBe('22222222-2222-4222-8222-222222222222')
  })

  test('it matches the path without a remainder', () => {
    const workspace = matchPattern(
      '/ws/{workspaceId}/v1/*',
      '/ws/22222222-2222-4222-8222-222222222222/v1'
    )
    expect(workspace).toBe('22222222-2222-4222-8222-222222222222')
  })

  test('it refuses a workspace that is not a uuid', () => {
    expect(matchPattern('/ws/{workspaceId}/v1/*', '/ws/abc/v1/items')).toBeNull()
  })

  test('it refuses an encoded separator', () => {
    expect(
      matchPattern('/ws/{workspaceId}/v1/*', '/ws/22222222-2222-4222-8222-222222222222%2Fx/v1')
    ).toBeNull()
  })

  test('it refuses another path', () => {
    expect(
      matchPattern('/ws/{workspaceId}/v1/*', '/ws/22222222-2222-4222-8222-222222222222/v2')
    ).toBeNull()
  })
})

describe('the file of the bindings', () => {
  const binding = {
    id: 'data-api',
    host: 'api.example.test',
    upstreamPathPattern: '/ws/{workspaceId}/v1/*',
    routeId: 'data-api',
    identityKeyFile: '/run/secrets/identity.key',
  }

  test('it accepts a valid file', () => {
    const bindings = parseBindingsFile(JSON.stringify({ version: 1, bindings: [binding] }))
    expect(bindings).toHaveLength(1)
  })

  test('it refuses an unknown property', () => {
    expect(() =>
      parseBindingsFile(JSON.stringify({ version: 1, bindings: [{ ...binding, extra: true }] }))
    ).toThrow()
  })

  test('it refuses a host that is not lowercase', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({ version: 1, bindings: [{ ...binding, host: 'API.example.test' }] })
      )
    ).toThrow()
  })

  test('it refuses a pattern without a placeholder', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({ version: 1, bindings: [{ ...binding, upstreamPathPattern: '/ws/*' }] })
      )
    ).toThrow()
  })

  test('it refuses two bindings that overlap', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({
          version: 1,
          bindings: [binding, { ...binding, id: 'other' }],
        })
      )
    ).toThrow()
  })

  test('it refuses a tenant that is not a uuid', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({ version: 1, bindings: [{ ...binding, expectedTenantId: 'nope' }] })
      )
    ).toThrow()
  })
})

describe('the verification of a request', () => {
  const bindings = [
    {
      binding: {
        id: 'data-api',
        host: 'api.example.test',
        upstreamPathPattern: '/ws/{workspaceId}/v1/*',
        routeId: 'data-api',
        identityKeyFile: 'test',
      },
      identityKey: key,
    },
  ]

  const headers = (values: Record<string, string>): { get: (name: string) => string | null } => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  })

  test('it accepts a request of the gateway', async () => {
    const entry = fixture.cases[0]!
    const identity = await verifyGatewayRequest(bindings, {
      method: entry.request.method,
      path: entry.request.path,
      query: entry.request.query,
      headers: headers({
        'x-forwarded-host': entry.request.host,
        'x-shuttle-signature': entry.signature,
        'x-shuttle-user': entry.identity.subject,
        'x-shuttle-workspace': entry.identity.workspaceId,
        'x-shuttle-roles': entry.identity.roles.join(','),
        ...(entry.identity.email ? { 'x-shuttle-email': entry.identity.email } : {}),
      }),
    })
    expect(identity.subject).toBe(entry.identity.subject)
    expect(identity.workspaceId).toBe(entry.identity.workspaceId)
    expect(identity.routeId).toBe('data-api')
  })

  test('it refuses a request without a signature', async () => {
    const entry = fixture.cases[0]!
    await expect(
      verifyGatewayRequest(bindings, {
        method: entry.request.method,
        path: entry.request.path,
        query: entry.request.query,
        headers: headers({
          'x-forwarded-host': entry.request.host,
          'x-shuttle-user': entry.identity.subject,
          'x-shuttle-workspace': entry.identity.workspaceId,
        }),
      })
    ).rejects.toThrow()
  })

  test('it refuses a request whose workspace differs from the path', async () => {
    const entry = fixture.cases[0]!
    await expect(
      verifyGatewayRequest(bindings, {
        method: entry.request.method,
        path: entry.request.path,
        query: entry.request.query,
        headers: headers({
          'x-forwarded-host': entry.request.host,
          'x-shuttle-signature': entry.signature,
          'x-shuttle-user': entry.identity.subject,
          'x-shuttle-workspace': '99999999-9999-4999-8999-999999999999',
        }),
      })
    ).rejects.toThrow()
  })

  test('it refuses a request of another host', async () => {
    const entry = fixture.cases[0]!
    await expect(
      verifyGatewayRequest(bindings, {
        method: entry.request.method,
        path: entry.request.path,
        query: entry.request.query,
        headers: headers({
          'x-forwarded-host': 'other.example.test',
          'x-shuttle-signature': entry.signature,
          'x-shuttle-user': entry.identity.subject,
          'x-shuttle-workspace': entry.identity.workspaceId,
        }),
      })
    ).rejects.toThrow()
  })
})
