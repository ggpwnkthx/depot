import { describe, expect, test } from 'bun:test'
import { base64url } from 'jose'
import {
  canonicalIdentityPayload,
  verifyIdentitySignature,
} from '../../src/domains/gateway-context'
import { FilterError, compileFilter, parseFilter } from '../../src/domains/authorization/filter'
import type { FieldDefinition } from '../../src/domains/schema'

/**
 * The fuzzing of the trust boundary.
 *
 * Two things decide whether a request may touch the data of a
 * workspace: the parser of the filter and the verification of the
 * signature of the gateway. Both of them read a value that a caller
 * controls, and both of them have to answer with a refusal and never
 * with an error of the process.
 *
 * The checks of the other files write the values that were thought of.
 * These two write the values that were not: a random json, a random
 * signature, and the signature of the pinned gateway with one of its
 * characters changed.
 */

/** The seed of the run. */
const SEED = Number(process.env.FUZZ_SEED ?? 4242)

/** The number of the cases of the run. */
const CASES = Number(process.env.FUZZ_CASES ?? 3000)

/** The fixtures of the pinned gateway. */
const fixture = (await Bun.file('test/fixtures/shuttle-identity.json').json()) as {
  keyBase64: string
  cases: {
    identity: { subject: string; email?: string; roles: string[]; workspaceId: string }
    request: { method: string; path: string; query: string; host: string }
    signature: string
  }[]
}

/** The key of the fixtures. */
const key = new Uint8Array(Buffer.from(fixture.keyBase64, 'base64'))

/** The first case of the fixtures. */
const entry = fixture.cases[0]!

/** A generator of numbers that replays the same run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The catalogue of the fuzzing. */ const catalogue: Record<string, FieldDefinition> = {
  title: { type: 'string', required: false, nullable: true },
  version: { type: 'integer', required: false, nullable: true },
  published: { type: 'boolean', required: false, nullable: true },
  ref: { type: 'uuid', required: false, nullable: true },
  at: { type: 'timestamp', required: false, nullable: true },
  price: { type: 'decimal', required: false, nullable: true },
  body: { type: 'json', required: false, nullable: true },
}

/**
 * The texts of the fuzzing.
 *
 * They hold the characters that break a naive implementation: the quote,
 * the backslash, the newline, the semicolon, the comment of the
 * database, and the text of a statement.
 */
const TEXTS = [
  '',
  'a',
  'Launch notes',
  "'",
  '"',
  '\\',
  '\n',
  '\r\n',
  '; drop table data.articles; --',
  "' or '1'='1",
  '" or ""=""',
  '%00',
  '$' + '{jndi:ldap://x}',
  '../../etc/passwd',
  '😀',
  'ä',
  'a'.repeat(4096),
]

/** Generates a random json value. */
function randomJson(random: () => number, depth: number): unknown {
  const roll = random()
  if (depth > 3 || roll < 0.35) {
    const kind = random()
    if (kind < 0.3) return null
    if (kind < 0.5) return random() < 0.5
    if (kind < 0.75) return Math.floor(random() * 2000) - 1000
    return TEXTS[Math.floor(random() * TEXTS.length)]!
  }
  if (roll < 0.7) {
    const size = Math.floor(random() * 4)
    return Array.from({ length: size }, () => randomJson(random, depth + 1))
  }
  const size = Math.floor(random() * 4)
  const object: Record<string, unknown> = {}
  for (let index = 0; index < size; index += 1) {
    const name = random() < 0.5 ? TEXTS[Math.floor(random() * TEXTS.length)]! : `field${index}`
    object[name] = randomJson(random, depth + 1)
  }
  return object
}

/** Generates a random filter that names the fields of the catalogue. */
function randomFilter(random: () => number, depth: number): unknown {
  const fields = Object.keys(catalogue)
  const field = fields[Math.floor(random() * fields.length)]!
  const operators = [
    '_eq',
    '_neq',
    '_in',
    '_nin',
    '_lt',
    '_lte',
    '_gt',
    '_gte',
    '_is_null',
    '_and',
    '_or',
    '_not',
    'unknown',
  ]
  const operator = operators[Math.floor(random() * operators.length)]!
  if (depth < 3 && (operator === '_and' || operator === '_or')) {
    const size = 1 + Math.floor(random() * 3)
    return {
      [operator]: Array.from({ length: size }, () => randomFilter(random, depth + 1)),
    }
  }
  if (operator === '_not') return { _not: randomFilter(random, depth + 1) }
  const operand = randomJson(random, depth + 1)
  if (operator === '_in' || operator === '_nin') {
    const values = Array.isArray(operand) ? operand : [operand]
    return { [field]: { [operator]: values } }
  }
  return { [field]: { [operator]: operand } }
}

describe('the parser of the filter', () => {
  test('a random filter is refused with a filter error and never with a crash', () => {
    const random = mulberry32(SEED)
    let accepted = 0
    for (let index = 0; index < CASES; index += 1) {
      const filter = randomFilter(random, 1)
      try {
        const node = parseFilter(filter, { fields: catalogue, substitutions: true })
        accepted += 1
        // A filter that is accepted compiles, and the statement holds
        // no value of the caller.
        const compiled = compileFilter(node, { fields: catalogue, startIndex: 1 })
        expect(compiled.sql).toMatch(/^[\s\S]*$/)
        const placeholders = compiled.sql.match(/\$\d+/g) ?? []
        expect(placeholders.length).toBe(compiled.params.length)
        for (const param of compiled.params) {
          if (typeof param !== 'string') continue
          if (param.length < 4) continue
          expect(compiled.sql).not.toContain(param)
        }
      } catch (error) {
        expect(error).toBeInstanceOf(FilterError)
        expect((error as FilterError).code).toBeTruthy()
      }
    }
    expect(accepted).toBeGreaterThan(0)
  })

  test('a random json is refused and never reaches a statement', () => {
    const random = mulberry32(SEED + 1)
    for (let index = 0; index < CASES; index += 1) {
      const value = randomJson(random, 0)
      try {
        const node = parseFilter(value, { fields: catalogue, substitutions: true })
        const compiled = compileFilter(node, { fields: catalogue, startIndex: 1 })
        // The identifiers of the statement are the ones of the
        // catalogue: they are quoted, and nothing else is.
        for (const identifier of compiled.sql.match(/"[^"]*"/g) ?? []) {
          const name = identifier.slice(1, -1)
          expect(
            name in catalogue || ['id', 'version'].includes(name),
            `the statement holds the identifier "${name}"`
          ).toBe(true)
        }
      } catch (error) {
        expect(error).toBeInstanceOf(FilterError)
      }
    }
  })
})

describe('the verification of the signature', () => {
  test('a random signature is refused and never throws', async () => {
    const random = mulberry32(SEED + 2)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.='
    for (let index = 0; index < CASES; index += 1) {
      const length = Math.floor(random() * 200)
      let signature = ''
      for (let position = 0; position < length; position += 1) {
        signature += alphabet[Math.floor(random() * alphabet.length)]!
      }
      const valid = await verifyIdentitySignature(entry.identity, entry.request, key, signature)
      expect(valid).toBe(false)
    }
  })

  test('a signature with one character changed is refused', async () => {
    for (let position = 0; position < entry.signature.length; position += 1) {
      const character = entry.signature[position]!
      if (character === '.') continue
      for (const replacement of ['A', 'z', '0', '-', '_', '/', '+']) {
        if (replacement === character) continue
        const mutated =
          entry.signature.slice(0, position) + replacement + entry.signature.slice(position + 1)
        const valid = await verifyIdentitySignature(entry.identity, entry.request, key, mutated)
        expect(valid, `the signature mutated at ${position} was accepted`).toBe(false)
      }
    }
  })

  test('a signature of another algorithm or type is refused', async () => {
    const parts = entry.signature.slice('v4='.length).split('.')
    const signature = parts[2]!
    const payload = base64url.encode(
      new TextEncoder().encode(canonicalIdentityPayload(entry.identity, entry.request))
    )
    const headers = [
      { alg: 'none', typ: 'shuttle-identity' },
      { alg: 'HS512', typ: 'shuttle-identity' },
      { alg: 'HS256', typ: 'jwt' },
      { alg: 'HS256', typ: 'shuttle-identity', extra: true },
      { alg: 'HS256' },
      {},
    ]
    for (const value of headers) {
      const encoded = base64url.encode(new TextEncoder().encode(JSON.stringify(value)))
      const valid = await verifyIdentitySignature(
        entry.identity,
        entry.request,
        key,
        `v4=${encoded}.${payload}.${signature}`
      )
      expect(valid, `the header ${JSON.stringify(value)} was accepted`).toBe(false)
    }
  })

  test('the transmitted payload is not an input of the decision', async () => {
    // The signature is detached: the payload is rebuilt from the
    // request, and the segment that carries it in the header is never
    // read. A caller may not change the answer with it.
    const parts = entry.signature.slice('v4='.length).split('.')
    const header = parts[0]!
    const signature = parts[2]!
    const payload = base64url.encode(
      new TextEncoder().encode(canonicalIdentityPayload(entry.identity, entry.request))
    )
    const variants = [
      `v4=${header}..${signature}`,
      `v4=${header}.${payload}.${signature}`,
      `v4=${header}.Zm9yZWJhcg.${signature}`,
    ]
    for (const variant of variants) {
      const valid = await verifyIdentitySignature(entry.identity, entry.request, key, variant)
      expect(valid, `the signature "${variant}" was refused`).toBe(true)
    }
  })

  test('a signature of a truncated or of an extended signature is refused', async () => {
    const parts = entry.signature.slice('v4='.length).split('.')
    const header = parts[0]!
    const payload = parts[1]!
    const signature = parts[2]!
    const variants = [
      `v4=${header}.${payload}`,
      `v4=${header}.${payload}.${signature}AA`,
      `v4=${header}.${payload}.${signature.slice(0, -1)}`,
      `v4=.${payload}.${signature}`,
      `v5=${header}.${payload}.${signature}`,
      `v4=${header}.${payload}.`,
    ]
    for (const variant of variants) {
      const valid = await verifyIdentitySignature(entry.identity, entry.request, key, variant)
      expect(valid, `the signature "${variant}" was accepted`).toBe(false)
    }
  })
})
