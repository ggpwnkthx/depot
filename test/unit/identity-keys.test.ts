import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import {
  loadIdentityVerification,
  readIdentityKey,
  readPublicKey,
} from '../../src/runtime/identity-keys'

/** A key pair of the curve P-256. */
const pair = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

/** A key pair of another curve. */
const otherCurve = generateKeyPairSync('ec', {
  namedCurve: 'P-384',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

/** A key pair of another kind. */
const otherKind = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

/** Writes a file in a temporary directory and returns its path. */
async function withFile(content: string, run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'depot-keys-'))
  try {
    const path = join(directory, 'key')
    await writeFile(path, content)
    await run(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('the public key of the gateway', () => {
  test('it reads the public key of the curve P-256', async () => {
    await withFile(pair.publicKey.toString(), async (path) => {
      const key = await readPublicKey(path)
      expect(key.type).toBe('public')
      expect(key.algorithm.name).toBe('ECDSA')
    })
  })

  test('it refuses a private key', async () => {
    await withFile(pair.privateKey.toString(), async (path) => {
      await expect(readPublicKey(path)).rejects.toThrow(/private key/)
    })
  })

  test('it refuses a key of another curve', async () => {
    await withFile(otherCurve.publicKey.toString(), async (path) => {
      await expect(readPublicKey(path)).rejects.toThrow(/P-256/)
    })
  })

  test('it refuses a key of another kind', async () => {
    await withFile(otherKind.publicKey.toString(), async (path) => {
      await expect(readPublicKey(path)).rejects.toThrow()
    })
  })

  test('it refuses a file that does not hold a key', async () => {
    await withFile('the key is not there', async (path) => {
      await expect(readPublicKey(path)).rejects.toThrow(/public key/)
    })
  })
})

describe('the derived key of the legacy format', () => {
  test('it reads a key in base64', async () => {
    const bytes = new Uint8Array(32).fill(3)
    await withFile(Buffer.from(bytes).toString('base64'), async (path) => {
      const key = await readIdentityKey(path)
      expect(key).toEqual(bytes)
    })
  })

  test('it reads a key in hexadecimal', async () => {
    const bytes = new Uint8Array(32).fill(5)
    await withFile(Buffer.from(bytes).toString('hex'), async (path) => {
      const key = await readIdentityKey(path)
      expect(key).toEqual(bytes)
    })
  })

  test('it refuses a pem', async () => {
    await withFile(pair.publicKey.toString(), async (path) => {
      await expect(readIdentityKey(path)).rejects.toThrow(/pem/)
    })
  })

  test('it refuses a key that is too short', async () => {
    await withFile('short', async (path) => {
      await expect(readIdentityKey(path)).rejects.toThrow(/too short/)
    })
  })
})

describe('the verification of a route', () => {
  test('the current format is verified with the public key', async () => {
    await withFile(pair.publicKey.toString(), async (path) => {
      const verification = await loadIdentityVerification({
        version: 'v5',
        algorithm: 'ES256',
        keyFile: path,
      })
      expect(verification.version).toBe('v5')
      expect(verification.algorithm).toBe('ES256')
    })
  })

  test('the legacy format is verified with the derived key', async () => {
    const bytes = new Uint8Array(32).fill(9)
    await withFile(Buffer.from(bytes).toString('base64'), async (path) => {
      const verification = await loadIdentityVerification({
        version: 'v4',
        algorithm: 'HS256',
        keyFile: path,
      })
      expect(verification.version).toBe('v4')
      expect(verification.algorithm).toBe('HS256')
      expect(verification.key).toEqual(bytes)
    })
  })
})
