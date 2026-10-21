import { describe, expect, test } from 'bun:test'
import { checkArchitecture, DOMAIN_MATRIX } from '../../scripts/architecture'

describe('the architecture of the service', () => {
  test('the imports of the source follow the matrix of the specification', async () => {
    const problems = await checkArchitecture('src')
    expect(problems).toEqual([])
  })

  test('the matrix names every domain of the service', () => {
    expect(Object.keys(DOMAIN_MATRIX).sort()).toEqual([
      'audit',
      'authorization',
      'catalog',
      'events',
      'gateway-context',
      'records',
      'schema',
      'workspaces',
    ])
  })
})
