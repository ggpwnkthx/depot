/**
 * The keys that verify the identity of the gateway (spec §4.2).
 *
 * The module is the boundary between the files of a deployment and the
 * verification of the gateway context: it reads the key of a route and
 * it hands the verification over to the domain. The domain never reads a
 * file, and it never learns where the key came from.
 *
 * The current key of a route is the **public** key of the deployment of
 * the gateway: the gateway holds the private one and signs with it, and
 * the backend verifies with the public one. A backend that can verify an
 * identity cannot mint one.
 *
 * The legacy key is the derived secret of the gateway. It is a signing
 * capable secret: it is read only for a route that is explicitly
 * configured as legacy, and a file that holds a key of another kind is
 * refused instead of being used as a secret.
 */

import { readFile } from 'node:fs/promises'
import { importSPKI, type CryptoKey } from 'jose'
import type { IdentityVerification, IdentityVerificationConfig } from '../domains/gateway-context'

/**
 * Reads the derived identity key of a gateway.
 *
 * The file holds the key of the signature of the identity, in base64 or
 * in hexadecimal. It is the derived key and not the secret of the
 * session: the two are not the same secret and they are not confused.
 *
 * A file that holds a pem is refused: a pem is not a secret, and a
 * deployment that points the legacy verification at the public key of
 * the gateway would verify with a key it never meant to trust.
 */
export async function readIdentityKey(path: string): Promise<Uint8Array> {
  const raw = (await readFile(path, 'utf8')).trim()
  if (raw.includes('-----BEGIN')) {
    throw new Error(
      `the identity key file holds a pem and not a derived key: ${path}. ` +
        'A legacy route verifies with a derived secret; a route that verifies with a public key is configured with the version "v5".'
    )
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return new Uint8Array(Buffer.from(raw, 'hex'))
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) {
    const decoded = Buffer.from(raw, 'base64')
    if (decoded.length >= 16) return new Uint8Array(decoded)
  }
  const bytes = new Uint8Array(Buffer.from(raw, 'utf8'))
  if (bytes.length >= 16) return bytes
  throw new Error(`the identity key file is too short: ${path}`)
}

/**
 * Reads the public key of the gateway.
 *
 * The file holds the public key of the deployment of the gateway, as a
 * pem of a key on the curve P-256. The private key of the gateway never
 * reaches the backend: a file that holds one is refused.
 */
export async function readPublicKey(path: string): Promise<CryptoKey> {
  const raw = (await readFile(path, 'utf8')).trim()
  if (raw.includes('PRIVATE KEY')) {
    throw new Error(
      `the public key file holds a private key: ${path}. ` +
        'The backend verifies with the public key of the gateway and never holds the private one.'
    )
  }
  if (!raw.includes('-----BEGIN PUBLIC KEY-----')) {
    throw new Error(`the public key file does not hold a public key in pem: ${path}`)
  }
  try {
    return await importSPKI(raw, 'ES256')
  } catch (error) {
    throw new Error(
      `the public key file does not hold a key of the curve P-256: ${path}. ` +
        `${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Loads the verification of a route.
 *
 * The key of the route is loaded once, at the start of the process: a
 * request never waits for a file, and a key that cannot be read stops
 * the service instead of being ignored.
 */
export async function loadIdentityVerification(
  config: IdentityVerificationConfig
): Promise<IdentityVerification> {
  if (config.algorithm === 'ES256') {
    return {
      version: config.version,
      algorithm: config.algorithm,
      key: await readPublicKey(config.keyFile),
    }
  }
  return {
    version: config.version,
    algorithm: config.algorithm,
    key: await readIdentityKey(config.keyFile),
  }
}
