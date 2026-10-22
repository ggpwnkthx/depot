/**
 * The comparison of a secret (spec §14).
 *
 * A secret is compared in constant time: the time of the answer never
 * depends on the length of the common prefix of the presented value and
 * of the expected one. The two values are hashed before they are
 * compared, so the comparison takes the same time whatever the length of
 * the presented value is, and the length of the secret never leaks.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** Reports whether a presented secret is the expected one. */
export function secretsMatch(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented, 'utf8').digest()
  const right = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(left, right)
}
