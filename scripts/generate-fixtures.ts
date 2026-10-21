#!/usr/bin/env bun
/**
 * The fixtures of the signature of the identity (spec §4.2).
 *
 * The fixture is produced by the pinned gateway itself: the canonical
 * payload and the signature come from the code of the gateway, and the
 * test of the backend checks its own verification against those bytes.
 *
 * The command needs a checkout of the pinned gateway:
 *
 *   SHUTTLE_CHECKOUT=/path/to/shuttle bun run scripts/generate-fixtures.ts
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const checkout = process.env.SHUTTLE_CHECKOUT
if (!checkout) {
  throw new Error('SHUTTLE_CHECKOUT must name a checkout of the pinned gateway')
}

const identity = await import(join(checkout, 'src/domains/forwarding/identity.ts'))
const { signIdentity, deriveIdentityKey, canonicalIdentityPayload } = identity

/** The secret of the fixture. It is a fixture, not a secret of a deployment. */
const SECRET = 'shuttle-fixture-session-secret-0001'
const key = deriveIdentityKey(SECRET)

/** The cases of the fixture. */
const cases = [
  {
    name: 'a read of the list of the articles',
    identity: {
      subject: '11111111-1111-4111-8111-111111111111',
      email: 'alice@example.test',
      roles: ['member', 'editor'],
      workspaceId: '22222222-2222-4222-8222-222222222222',
    },
    request: {
      method: 'GET',
      path: '/ws/22222222-2222-4222-8222-222222222222/v1/items/articles',
      query: '',
      host: 'api.example.test',
    },
  },
  {
    name: 'a write with a filter and a sort',
    identity: {
      subject: '11111111-1111-4111-8111-111111111111',
      roles: ['editor'],
      workspaceId: '22222222-2222-4222-8222-222222222222',
    },
    request: {
      method: 'POST',
      path: '/ws/22222222-2222-4222-8222-222222222222/v1/items/articles',
      query: '?limit=10&sort=-title',
      host: 'api.example.test',
    },
  },
  {
    name: 'a request with an upper case host and an email',
    identity: {
      subject: '33333333-3333-4333-8333-333333333333',
      email: 'bob@example.test',
      roles: [],
      workspaceId: '44444444-4444-4444-8444-444444444444',
    },
    request: {
      method: 'DELETE',
      path: '/ws/44444444-4444-4444-8444-444444444444/v1/items/articles/55555555-5555-4555-8555-555555555555',
      query: '',
      host: 'api.example.test:8443',
    },
  },
]

const fixtures = []
for (const entry of cases) {
  const signature = await signIdentity(entry.identity, entry.request, key)
  fixtures.push({
    name: entry.name,
    identity: entry.identity,
    request: entry.request,
    canonicalPayload: canonicalIdentityPayload(entry.identity, entry.request),
    signature,
  })
}

const target = join(process.cwd(), 'test', 'fixtures', 'shuttle-identity.json')
await mkdir(dirname(target), { recursive: true })
await writeFile(
  target,
  `${JSON.stringify(
    {
      comment:
        'The fixtures are produced by the pinned gateway, with scripts/generate-fixtures.ts.',
      shuttleCommit: process.env.SHUTTLE_COMMIT ?? 'e39d73efc37e0ca75ae5df24136babf56430ebc7',
      keyBase64: Buffer.from(key).toString('base64'),
      cases: fixtures,
    },
    null,
    2
  )}\n`
)
console.log(JSON.stringify({ level: 'info', msg: 'the fixtures were written', target }))
