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
 *
 * The checkout has to be at the revision of the baseline of
 * `compatibility.json`: the fixture is the evidence of the contract of
 * that revision and not of another one.
 */

import { spawnSync } from 'bun'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { readCompatibilityManifest } from './compatibility-manifest'

const checkout = process.env.SHUTTLE_CHECKOUT
if (!checkout) {
  throw new Error('SHUTTLE_CHECKOUT must name a checkout of the pinned gateway')
}

const manifest = await readCompatibilityManifest()
const pinned = manifest.repositories.shuttle.commit

// The checkout has to be the revision of the baseline: a fixture that
// comes from another revision is not the evidence of the contract.
const head = spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: checkout })
if (head.exitCode !== 0) {
  throw new Error(`the checkout ${checkout} is not a git repository`)
}
const revision = head.stdout.toString().trim()
if (revision !== pinned) {
  throw new Error(
    `the checkout ${checkout} is at ${revision} and the baseline of the gateway is ${pinned}`
  )
}

const identity = await import(join(checkout, 'src/domains/forwarding/identity.ts'))
const { signIdentity, canonicalIdentityPayload, asymmetricIdentityKey } = identity

/**
 * The secret of the legacy fixture.
 *
 * It is a fixture, not a secret of a deployment: it is the secret of the
 * sessions of a gateway that signs with the derived key.
 */
const LEGACY_SECRET = 'shuttle-fixture-session-secret-0001'

/**
 * The derived key of the legacy format.
 *
 * The gateway does not sign the legacy format any more: it was removed
 * in the release `1.0.0`, because its key was shared with the upstreams
 * and an upstream that verified an identity could mint one. The backend
 * still reads the format for the deployments whose gateway is older,
 * so the fixture still carries it, and the derivation of the key is the
 * one part that the gateway does not offer any more: it is the
 * `HMAC-SHA256` of the secret of the sessions and of the label of the
 * format. The payload and the signature are still the ones of the
 * gateway: the signer of the gateway signs them with this key.
 */
const legacyKey = {
  version: 'v4',
  algorithm: 'HS256',
  key: createHmac('sha256', LEGACY_SECRET).update('shuttle-identity-signature-v1').digest(),
}

/**
 * The key pair of the current fixture.
 *
 * The private key signs the fixtures and it is not written anywhere: the
 * fixture holds the public key and the signatures, and the backend never
 * holds a private key of the gateway.
 */
const pair = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const publicKeyPem = pair.publicKey.toString()
const currentKey = asymmetricIdentityKey(pair.privateKey.toString())

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

const current = []
const legacy = []
for (const entry of cases) {
  current.push({
    name: entry.name,
    identity: entry.identity,
    request: entry.request,
    canonicalPayload: canonicalIdentityPayload(entry.identity, entry.request, 'v5'),
    signature: await signIdentity(entry.identity, entry.request, currentKey),
  })
  legacy.push({
    name: entry.name,
    identity: entry.identity,
    request: entry.request,
    canonicalPayload: canonicalIdentityPayload(entry.identity, entry.request, 'v4'),
    signature: await signIdentity(entry.identity, entry.request, legacyKey),
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
      shuttleCommit: pinned,
      current: {
        version: 'v5',
        algorithm: 'ES256',
        publicKeyPem,
        cases: current,
      },
      legacy: {
        version: 'v4',
        algorithm: 'HS256',
        keyBase64: Buffer.from(legacyKey.key as Buffer).toString('base64'),
        cases: legacy,
      },
    },
    null,
    2
  )}\n`
)
console.log(JSON.stringify({ level: 'info', msg: 'the fixtures were written', target }))
