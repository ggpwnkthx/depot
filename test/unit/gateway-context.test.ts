import { describe, expect, test } from 'bun:test'
import { base64url, importPKCS8, importSPKI } from 'jose'
import { generateKeyPairSync } from 'node:crypto'
import {
  canonicalIdentityPayload,
  legacyBindings,
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
  shuttleCommit: string
  current: { version: string; algorithm: string; publicKeyPem: string; cases: Fixture[] }
  legacy: { version: string; algorithm: string; keyBase64: string; cases: Fixture[] }
}

/** The public key of the current fixtures of the gateway. */
const currentKey = await importSPKI(fixture.current.publicKeyPem, 'ES256')
/** The derived key of the legacy fixtures of the gateway. */
const legacyKey = new Uint8Array(Buffer.from(fixture.legacy.keyBase64, 'base64'))

/** The verification of the current format. */
const currentVerification = {
  version: 'v5',
  algorithm: 'ES256',
  key: currentKey,
} as const

/** The verification of the legacy format. */
const legacyVerification = {
  version: 'v4',
  algorithm: 'HS256',
  key: legacyKey,
} as const

/** Another key pair of the curve P-256, for the refusals. */
const otherPair = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const otherKey = await importSPKI(otherPair.publicKey.toString(), 'ES256')

/** A key of another curve, for the refusals. */
const otherCurvePair = generateKeyPairSync('ec', {
  namedCurve: 'P-384',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

describe('the canonical payload of the identity', () => {
  test('it is the payload of the pinned gateway, byte for byte', () => {
    for (const entry of fixture.current.cases) {
      const payload = canonicalIdentityPayload(entry.identity, entry.request, 'v5')
      expect(payload).toBe(entry.canonicalPayload)
    }
  })

  test('it is the payload of the legacy gateway, byte for byte', () => {
    for (const entry of fixture.legacy.cases) {
      const payload = canonicalIdentityPayload(entry.identity, entry.request, 'v4')
      expect(payload).toBe(entry.canonicalPayload)
    }
  })

  test('the roles are sorted and the order is not part of the meaning', () => {
    const entry = fixture.current.cases[0]!
    const payload = canonicalIdentityPayload(
      { ...entry.identity, roles: ['editor', 'member'] },
      entry.request,
      'v5'
    )
    expect(payload).toBe(entry.canonicalPayload)
  })

  test('the version is part of the payload', () => {
    const entry = fixture.current.cases[0]!
    expect(canonicalIdentityPayload(entry.identity, entry.request, 'v5')).not.toBe(
      canonicalIdentityPayload(entry.identity, entry.request, 'v4')
    )
  })
})

describe('the verification of the signature', () => {
  test('it accepts the signature of the pinned gateway', async () => {
    for (const entry of fixture.current.cases) {
      const valid = await verifyIdentitySignature(
        entry.identity,
        entry.request,
        currentVerification,
        entry.signature
      )
      expect(valid).toBe(true)
    }
  })

  test('it accepts the legacy signature of the pinned gateway', async () => {
    for (const entry of fixture.legacy.cases) {
      const valid = await verifyIdentitySignature(
        entry.identity,
        entry.request,
        legacyVerification,
        entry.signature
      )
      expect(valid).toBe(true)
    }
  })

  test('it refuses a signature of another path', async () => {
    const entry = fixture.current.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      { ...entry.request, path: '/ws/22222222-2222-4222-8222-222222222222/v1/items/categories' },
      currentVerification,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another query', async () => {
    const entry = fixture.current.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      { ...entry.request, query: '?limit=10' },
      currentVerification,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another host', async () => {
    const entry = fixture.current.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      { ...entry.request, host: 'other.example.test' },
      currentVerification,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another subject', async () => {
    const entry = fixture.current.cases[0]!
    const valid = await verifyIdentitySignature(
      { ...entry.identity, subject: '99999999-9999-4999-8999-999999999999' },
      entry.request,
      currentVerification,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another key', async () => {
    const entry = fixture.current.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      { version: 'v5', algorithm: 'ES256', key: otherKey },
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another version', async () => {
    const entry = fixture.current.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      currentVerification,
      entry.signature.replace('v5=', 'v3=')
    )
    expect(valid).toBe(false)
  })

  test('a route of the current version refuses the legacy signature', async () => {
    const entry = fixture.legacy.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      currentVerification,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('a legacy route refuses the current signature', async () => {
    const entry = fixture.current.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      legacyVerification,
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('a legacy route does not accept a public key as a secret', async () => {
    const entry = fixture.legacy.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      {
        version: 'v4',
        algorithm: 'HS256',
        key: new TextEncoder().encode(fixture.current.publicKeyPem),
      },
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature of another algorithm', async () => {
    const entry = fixture.current.cases[0]!
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      { version: 'v5', algorithm: 'HS256', key: legacyKey },
      entry.signature
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature whose type is not the one of the gateway', async () => {
    const entry = fixture.current.cases[0]!
    const [, header, signature] = entry.signature.slice('v5='.length).split('.')
    const wrongType = base64url.encode(
      new TextEncoder().encode(JSON.stringify({ alg: 'ES256', typ: 'jwt' }))
    )
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      currentVerification,
      `v5=${wrongType}..${signature}`
    )
    expect(valid).toBe(false)
    // The header of the real signature is the one of the gateway.
    expect(header).toBeDefined()
  })

  test('it refuses a signature that carries its payload', async () => {
    const entry = fixture.current.cases[0]!
    const [header, , signature] = entry.signature.slice('v5='.length).split('.')
    const payload = base64url.encode(new TextEncoder().encode(entry.canonicalPayload))
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      currentVerification,
      `v5=${header}.${payload}.${signature}`
    )
    expect(valid).toBe(false)
  })

  test('it refuses a signature that is not a compact serialization', async () => {
    const entry = fixture.current.cases[0]!
    const [header, , signature] = entry.signature.slice('v5='.length).split('.')
    for (const variant of [
      `v5=${header}`,
      `v5=${header}.${signature}`,
      `v5=${header}..`,
      `v5=..${signature}`,
      `v5=not-base64.${signature}`,
      `v5=${header}..${signature}AA`,
    ]) {
      const valid = await verifyIdentitySignature(
        entry.identity,
        entry.request,
        currentVerification,
        variant
      )
      expect(valid, `the signature "${variant}" was accepted`).toBe(false)
    }
  })

  test('it refuses a signature with a critical header it does not know', async () => {
    const entry = fixture.current.cases[0]!
    const [, , signature] = entry.signature.slice('v5='.length).split('.')
    const header = base64url.encode(
      new TextEncoder().encode(
        JSON.stringify({ alg: 'ES256', typ: 'shuttle-identity', crit: ['exp'], exp: 1 })
      )
    )
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      currentVerification,
      `v5=${header}..${signature}`
    )
    expect(valid).toBe(false)
  })

  test('it refuses a key of another curve', async () => {
    const entry = fixture.current.cases[0]!
    const wrongCurve = await importSPKI(otherCurvePair.publicKey.toString(), 'ES256').catch(
      () => undefined
    )
    // The library refuses the key itself: a key of another curve never
    // reaches the verification.
    expect(wrongCurve).toBeUndefined()
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      currentVerification,
      entry.signature
    )
    expect(valid).toBe(true)
  })

  test('it refuses a signature that was signed with the private key of another pair', async () => {
    const entry = fixture.current.cases[0]!
    const otherPrivate = await importPKCS8(otherPair.privateKey.toString(), 'ES256')
    const { CompactSign } = await import('jose')
    const jws = await new CompactSign(new TextEncoder().encode(entry.canonicalPayload))
      .setProtectedHeader({ alg: 'ES256', typ: 'shuttle-identity' })
      .sign(otherPrivate)
    const [header, , signature] = jws.split('.')
    const valid = await verifyIdentitySignature(
      entry.identity,
      entry.request,
      currentVerification,
      `v5=${header}..${signature}`
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
    identity: { version: 'v5', algorithm: 'ES256', publicKeyFile: '/run/secrets/identity.pem' },
  }

  test('it accepts a valid file', () => {
    const bindings = parseBindingsFile(JSON.stringify({ version: 2, bindings: [binding] }))
    expect(bindings).toHaveLength(1)
    expect(bindings[0]!.identity).toEqual({
      version: 'v5',
      algorithm: 'ES256',
      keyFile: '/run/secrets/identity.pem',
    })
  })

  test('it refuses the legacy format of the file', () => {
    const legacy = {
      id: 'data-api',
      host: 'api.example.test',
      upstreamPathPattern: '/ws/{workspaceId}/v1/*',
      routeId: 'data-api',
      identityKeyFile: '/run/secrets/identity.key',
    }
    expect(() =>
      parseBindingsFile(JSON.stringify({ version: 1, bindings: [legacy] }), 'refuse')
    ).toThrow(/legacy/)
    expect(
      parseBindingsFile(JSON.stringify({ version: 1, bindings: [legacy] }), 'allow')
    ).toHaveLength(1)
  })

  test('it refuses the legacy verification of a route', () => {
    const legacy = {
      id: 'data-api',
      host: 'api.example.test',
      upstreamPathPattern: '/ws/{workspaceId}/v1/*',
      routeId: 'data-api',
      identity: { version: 'v4', algorithm: 'HS256', identityKeyFile: '/run/secrets/identity.key' },
    }
    expect(() =>
      parseBindingsFile(JSON.stringify({ version: 2, bindings: [legacy] }), 'refuse')
    ).toThrow(/legacy/)
    const allowed = parseBindingsFile(JSON.stringify({ version: 2, bindings: [legacy] }), 'warn')
    expect(allowed).toHaveLength(1)
    expect(legacyBindings(allowed)).toHaveLength(1)
  })

  test('it does not name the legacy routes of a current deployment', () => {
    const bindings = parseBindingsFile(JSON.stringify({ version: 2, bindings: [binding] }))
    expect(legacyBindings(bindings)).toHaveLength(0)
  })

  test('it refuses an unknown property', () => {
    expect(() =>
      parseBindingsFile(JSON.stringify({ version: 2, bindings: [{ ...binding, extra: true }] }))
    ).toThrow()
  })

  test('it refuses a host that is not lowercase', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({ version: 2, bindings: [{ ...binding, host: 'API.example.test' }] })
      )
    ).toThrow()
  })

  test('it refuses a pattern without a placeholder', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({
          version: 2,
          bindings: [{ ...binding, upstreamPathPattern: '/ws/*' }],
        })
      )
    ).toThrow()
  })

  test('it refuses two bindings that overlap', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({
          version: 2,
          bindings: [binding, { ...binding, id: 'other' }],
        })
      )
    ).toThrow()
  })

  test('it refuses a tenant that is not a uuid', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({
          version: 2,
          bindings: [{ ...binding, expectedTenantId: 'nope' }],
        })
      )
    ).toThrow()
  })

  test('it refuses a version that does not exist', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({
          version: 2,
          bindings: [
            {
              ...binding,
              identity: { version: 'v6', algorithm: 'ES256', publicKeyFile: '/run/secrets/i.pem' },
            },
          ],
        })
      )
    ).toThrow()
  })

  test('it refuses an algorithm that does not belong to the version', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({
          version: 2,
          bindings: [
            {
              ...binding,
              identity: { version: 'v5', algorithm: 'HS256', publicKeyFile: '/run/secrets/i.pem' },
            },
          ],
        })
      )
    ).toThrow()
  })

  test('it refuses a public key file in a legacy route', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({
          version: 2,
          bindings: [
            {
              ...binding,
              identity: { version: 'v4', algorithm: 'HS256', publicKeyFile: '/run/secrets/i.pem' },
            },
          ],
        })
      )
    ).toThrow()
  })

  test('it refuses a derived key file in a current route', () => {
    expect(() =>
      parseBindingsFile(
        JSON.stringify({
          version: 2,
          bindings: [
            {
              ...binding,
              identity: {
                version: 'v5',
                algorithm: 'ES256',
                identityKeyFile: '/run/secrets/i.key',
              },
            },
          ],
        })
      )
    ).toThrow()
  })

  test('it reads the legacy file as the legacy mode it is', () => {
    const bindings = parseBindingsFile(
      JSON.stringify({
        version: 1,
        bindings: [
          {
            id: 'data-api',
            host: 'api.example.test',
            upstreamPathPattern: '/ws/{workspaceId}/v1/*',
            routeId: 'data-api',
            identityKeyFile: '/run/secrets/identity.key',
          },
        ],
      })
    )
    expect(bindings[0]!.identity).toEqual({
      version: 'v4',
      algorithm: 'HS256',
      keyFile: '/run/secrets/identity.key',
    })
  })

  test('it refuses a version of the file that does not exist', () => {
    expect(() => parseBindingsFile(JSON.stringify({ version: 3, bindings: [binding] }))).toThrow()
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
        identity: { version: 'v5', algorithm: 'ES256', keyFile: 'test' } as const,
      },
      verification: currentVerification,
    },
  ]

  const headers = (values: Record<string, string>): { get: (name: string) => string | null } => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  })

  test('it accepts a request of the gateway', async () => {
    const entry = fixture.current.cases[0]!
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
    const entry = fixture.current.cases[0]!
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
    const entry = fixture.current.cases[0]!
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
    const entry = fixture.current.cases[0]!
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

  test('it refuses a request whose signature is of another version', async () => {
    const entry = fixture.legacy.cases[0]!
    await expect(
      verifyGatewayRequest(bindings, {
        method: entry.request.method,
        path: entry.request.path,
        query: entry.request.query,
        headers: headers({
          'x-forwarded-host': entry.request.host,
          'x-shuttle-signature': entry.signature,
          'x-shuttle-user': entry.identity.subject,
          'x-shuttle-workspace': entry.identity.workspaceId,
        }),
      })
    ).rejects.toThrow()
  })

  test('it refuses a request whose identity header is repeated', async () => {
    const entry = fixture.current.cases[0]!
    await expect(
      verifyGatewayRequest(bindings, {
        method: entry.request.method,
        path: entry.request.path,
        query: entry.request.query,
        headers: {
          get: (name: string) => {
            const lower = name.toLowerCase()
            if (lower === 'x-forwarded-host') return entry.request.host
            if (lower === 'x-shuttle-signature') return entry.signature
            if (lower === 'x-shuttle-user')
              return `${entry.identity.subject},${entry.identity.subject}`
            if (lower === 'x-shuttle-workspace') return entry.identity.workspaceId
            return null
          },
        },
      })
    ).rejects.toThrow()
  })

  test('it refuses a request whose signed identity was changed', async () => {
    const entry = fixture.current.cases[0]!
    await expect(
      verifyGatewayRequest(bindings, {
        method: entry.request.method,
        path: entry.request.path,
        query: entry.request.query,
        headers: headers({
          'x-forwarded-host': entry.request.host,
          'x-shuttle-signature': entry.signature,
          'x-shuttle-user': '99999999-9999-4999-8999-999999999999',
          'x-shuttle-workspace': entry.identity.workspaceId,
        }),
      })
    ).rejects.toThrow()
  })

  test('it accepts the legacy request of a legacy route', async () => {
    const entry = fixture.legacy.cases[0]!
    const legacyBindings = [
      {
        binding: {
          id: 'data-api',
          host: 'api.example.test',
          upstreamPathPattern: '/ws/{workspaceId}/v1/*',
          routeId: 'data-api',
          identity: { version: 'v4', algorithm: 'HS256', keyFile: 'test' } as const,
        },
        verification: legacyVerification,
      },
    ]
    const identity = await verifyGatewayRequest(legacyBindings, {
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
  })

  test('a legacy route refuses the signature of the current format', async () => {
    const entry = fixture.current.cases[0]!
    const legacyBindings = [
      {
        binding: {
          id: 'data-api',
          host: 'api.example.test',
          upstreamPathPattern: '/ws/{workspaceId}/v1/*',
          routeId: 'data-api',
          identity: { version: 'v4', algorithm: 'HS256', keyFile: 'test' } as const,
        },
        verification: legacyVerification,
      },
    ]
    await expect(
      verifyGatewayRequest(legacyBindings, {
        method: entry.request.method,
        path: entry.request.path,
        query: entry.request.query,
        headers: headers({
          'x-forwarded-host': entry.request.host,
          'x-shuttle-signature': entry.signature,
          'x-shuttle-user': entry.identity.subject,
          'x-shuttle-workspace': entry.identity.workspaceId,
        }),
      })
    ).rejects.toThrow()
  })
})
