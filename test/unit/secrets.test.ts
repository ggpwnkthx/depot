import { expect, test } from 'bun:test'
import { secretsMatch } from '../../src/app/secrets'

/**
 * The comparison of a secret (spec §14).
 *
 * The token of the metrics is a secret: it is compared in constant time,
 * so the answer of the endpoint does not depend on the length of the
 * common prefix of the presented value and of the expected one.
 */

test('a presented secret is the expected one', () => {
  expect(secretsMatch('Bearer the-token', 'Bearer the-token')).toBe(true)
})

test('a presented secret that is not the expected one is refused', () => {
  expect(secretsMatch('Bearer the-toke', 'Bearer the-token')).toBe(false)
  expect(secretsMatch('Bearer the-tokenx', 'Bearer the-token')).toBe(false)
  expect(secretsMatch('', 'Bearer the-token')).toBe(false)
})

test('a presented secret of another length is refused', () => {
  expect(secretsMatch('Bearer ', 'Bearer the-token')).toBe(false)
  expect(secretsMatch('Bearer the-token-and-more', 'Bearer the-token')).toBe(false)
})
