import { describe, expect, test } from 'bun:test'
import {
  type AuthorizationInput,
  type PolicyBundle,
  compileFilter,
  evaluateFilter,
  filterSortIntersection,
  parseFilter,
  readableUnion,
  selectWritePolicy,
  applicablePolicies,
} from '../../src/domains/authorization'
import { parseManifestBundle } from '../../src/domains/schema'
import { parsePolicyBundle } from '../../src/domains/authorization/policies'

const manifest = parseManifestBundle(await Bun.file('manifests/schema.json').text())
const bundle: PolicyBundle = parsePolicyBundle(
  await Bun.file('manifests/policies.json').text(),
  manifest
)

const catalogue = {
  title: { type: 'string' as const, required: true, nullable: false, maxLength: 240 },
  body: { type: 'text' as const, required: false, nullable: true },
  created_by: { type: 'uuid' as const, required: true, nullable: false },
  created_at: { type: 'timestamp' as const, required: true, nullable: false },
  version: { type: 'integer' as const, required: true, nullable: false },
}

const context = {
  principalId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
}

describe('the grammar of a filter', () => {
  test('it accepts the operators of the contract', () => {
    const node = parseFilter(
      {
        _and: [
          { title: { _eq: 'Launch notes' } },
          { _or: [{ body: { _is_null: true } }, { version: { _gte: 2 } }] },
        ],
      },
      { fields: catalogue }
    )
    expect(node.kind).toBe('and')
  })

  test('an empty filter is no predicate', () => {
    const node = parseFilter({}, { fields: catalogue })
    expect(node.kind).toBe('all')
    expect(evaluateFilter(node, { title: 'x' }, context)).toBe(true)
  })

  test('it accepts the negation of a predicate', () => {
    const node = parseFilter({ _not: { title: { _eq: 'Launch notes' } } }, { fields: catalogue })
    expect(node.kind).toBe('not')
    expect(evaluateFilter(node, { title: 'Other' }, context)).toBe(true)
    expect(evaluateFilter(node, { title: 'Launch notes' }, context)).toBe(false)
  })

  test('the negation of an unknown is an unknown', () => {
    const node = parseFilter({ _not: { body: { _eq: 'x' } } }, { fields: catalogue })
    // The body is null: the comparison is unknown, and the negation of an
    // unknown never matches a row.
    expect(evaluateFilter(node, { title: 'x', body: null }, context)).toBe(false)
  })

  test('it refuses a negation that is not a filter', () => {
    expect(() => parseFilter({ _not: 'title' }, { fields: catalogue })).toThrow()
    expect(() => parseFilter({ _not: 3 }, { fields: catalogue })).toThrow()
  })

  test('it refuses an unknown field', () => {
    expect(() => parseFilter({ secret: { _eq: 'x' } }, { fields: catalogue })).toThrow()
  })

  test('it refuses an unknown operator', () => {
    expect(() => parseFilter({ title: { _like: 'x' } }, { fields: catalogue })).toThrow()
  })

  test('it refuses a value of the wrong type', () => {
    expect(() => parseFilter({ title: { _eq: 42 } }, { fields: catalogue })).toThrow()
  })

  test('it refuses null as an operand of an equality', () => {
    expect(() => parseFilter({ title: { _eq: null } }, { fields: catalogue })).toThrow()
  })

  test('it refuses a filter that is too deep', () => {
    let filter: unknown = { title: { _eq: 'x' } }
    for (let index = 0; index < 6; index += 1) filter = { _and: [filter] }
    expect(() => parseFilter(filter, { fields: catalogue })).toThrow()
  })

  test('it refuses a list that is too long', () => {
    expect(() =>
      parseFilter(
        { title: { _in: Array.from({ length: 101 }, (_v, i) => `v${i}`) } },
        { fields: catalogue }
      )
    ).toThrow()
  })
})

describe('the evaluation of a filter', () => {
  test('it compares the fields of a row', () => {
    const node = parseFilter({ title: { _eq: 'Launch notes' } }, { fields: catalogue })
    expect(evaluateFilter(node, { title: 'Launch notes' }, context)).toBe(true)
    expect(evaluateFilter(node, { title: 'Other' }, context)).toBe(false)
  })

  test('it resolves the server substitutions', () => {
    const node = parseFilter(
      { created_by: { _eq: '$principalId' } },
      { fields: catalogue, substitutions: true }
    )
    expect(evaluateFilter(node, { created_by: context.principalId }, context)).toBe(true)
    expect(
      evaluateFilter(node, { created_by: '99999999-9999-4999-8999-999999999999' }, context)
    ).toBe(false)
  })

  test('it compares the null values with the rank of the sort', () => {
    const node = parseFilter({ body: { _is_null: true } }, { fields: catalogue })
    expect(evaluateFilter(node, { body: null }, context)).toBe(true)
    expect(evaluateFilter(node, { body: 'x' }, context)).toBe(false)
  })
})

describe('the compilation of a filter', () => {
  test('the values are bound and the identifiers are quoted', () => {
    const node = parseFilter({ title: { _eq: 'Launch notes' } }, { fields: catalogue })
    const compiled = compileFilter(node, { fields: catalogue, alias: 't' })
    expect(compiled.sql).toBe('"t"."title" collate "C" = $1')
    expect(compiled.params).toEqual(['Launch notes'])
  })

  test('the comparison of the text does not depend on the collation of the database', () => {
    const node = parseFilter({ title: { _lt: 'apple' } }, { fields: catalogue })
    const compiled = compileFilter(node, { fields: catalogue, alias: 't' })
    expect(compiled.sql).toContain('collate "C"')
    const number = parseFilter({ version: { _lt: 10 } }, { fields: catalogue })
    const compiledNumber = compileFilter(number, { fields: catalogue, alias: 't' })
    expect(compiledNumber.sql).not.toContain('collate')
  })
})

describe('the composition of the policies', () => {
  const authorization: AuthorizationInput = {
    permissionKeys: ['content.reader', 'content.editor'],
    bundle,
    manifest,
  }

  test('the union of the fields is the answer of the readable policies', () => {
    const policies = applicablePolicies(authorization, 'articles', 'read')
    const union = readableUnion(policies)
    expect(union).toContain('title')
    expect(union).toContain('body')
  })

  test('the intersection of the fields is the conservative answer', () => {
    const policies = applicablePolicies(authorization, 'articles', 'read')
    const intersection = filterSortIntersection(policies)
    expect(intersection.length).toBeGreaterThan(0)
    // Every field of the intersection is in every policy.
    for (const policy of policies) {
      for (const field of intersection) {
        expect(policy.fields).toContain(field)
      }
    }
  })

  test('a write is authorized by one policy and not by a mixture', () => {
    const policies = applicablePolicies(authorization, 'articles', 'update')
    const decision = selectWritePolicy(policies, {
      action: 'update',
      writtenFields: ['title', 'body'],
      currentRow: { created_by: context.principalId },
      resultingRow: { created_by: context.principalId },
      context,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.policy?.id).toBe('update-articles-own')
  })

  test('a write of another principal is refused', () => {
    const policies = applicablePolicies(authorization, 'articles', 'update')
    const decision = selectWritePolicy(policies, {
      action: 'update',
      writtenFields: ['title'],
      currentRow: { created_by: '99999999-9999-4999-8999-999999999999' },
      resultingRow: { created_by: '99999999-9999-4999-8999-999999999999' },
      context,
    })
    expect(decision.allowed).toBe(false)
  })

  test('a write of a field that no policy grants is refused', () => {
    const policies = applicablePolicies(authorization, 'articles', 'update')
    const decision = selectWritePolicy(policies, {
      action: 'update',
      writtenFields: ['title', 'not_granted'],
      currentRow: { created_by: context.principalId },
      resultingRow: { created_by: context.principalId },
      context,
    })
    expect(decision.allowed).toBe(false)
  })

  test('a write that moves the row out of its check is refused', () => {
    const policies = applicablePolicies(authorization, 'articles', 'update')
    const decision = selectWritePolicy(policies, {
      action: 'update',
      writtenFields: ['title'],
      currentRow: { created_by: context.principalId },
      resultingRow: { created_by: '99999999-9999-4999-8999-999999999999' },
      context,
    })
    expect(decision.allowed).toBe(false)
  })

  test('a principal without the permission has no policy', () => {
    const without: AuthorizationInput = {
      permissionKeys: ['content.reader'],
      bundle,
      manifest,
    }
    expect(applicablePolicies(without, 'articles', 'update')).toHaveLength(0)
  })
})
