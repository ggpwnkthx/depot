import { describe, expect, test } from 'bun:test'
import { ServiceError } from '../../src/protocol/errors'
import { ResponseBudget } from '../../src/domains/records/budget'
import { TenantLimiter } from '../../src/runtime/limits'

describe('the budget of the bytes of an answer', () => {
  test('it counts the bytes of what it is given', () => {
    const budget = new ResponseBudget(1024)
    budget.addBytes(10)
    expect(budget.used).toBeGreaterThan(10)
    expect(budget.used).toBeLessThan(1024)
  })

  test('it refuses the answer when the budget is spent', () => {
    const budget = new ResponseBudget(64)
    expect(() => budget.addBytes(1024)).toThrow(ServiceError)
    try {
      budget.addBytes(1024)
    } catch (error) {
      expect((error as ServiceError).code).toBe('RESULT_TOO_LARGE')
      expect((error as ServiceError).status).toBe(422)
    }
  })

  test('it refuses the answer before it is complete, not after', () => {
    const budget = new ResponseBudget(1000)
    let accepted = 0
    try {
      for (let index = 0; index < 100; index += 1) {
        budget.addBytes(100)
        accepted += 1
      }
    } catch {
      // The refusal is the point of the test.
    }
    // The budget refuses at the row that crosses it: the rows that
    // follow are never built.
    expect(accepted).toBeLessThan(100)
    expect(accepted).toBeGreaterThan(0)
  })

  test('the budget counts the separator of the answer with every row', () => {
    const budget = new ResponseBudget(1024 * 1024)
    const size = budget.addBytes(100)
    expect(size).toBe(100)
    // The separator of the array and the envelope of the answer are
    // counted with every row: the budget is an upper bound.
    expect(budget.used).toBe(101)
  })
})

describe('the limiter of the tenants', () => {
  test('a tenant may hold its whole room', () => {
    const limiter = new TenantLimiter({ maxInFlightPerTenant: 2 })
    limiter.enter('tenant-a')
    limiter.enter('tenant-a')
    expect(() => limiter.enter('tenant-a')).toThrow(ServiceError)
  })

  test('the refusal is a 429 with a Retry-After', () => {
    const limiter = new TenantLimiter({ maxInFlightPerTenant: 1 })
    limiter.enter('tenant-a')
    try {
      limiter.enter('tenant-a')
      throw new Error('the limiter did not refuse')
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceError)
      expect((error as ServiceError).code).toBe('TOO_MANY_REQUESTS')
      expect((error as ServiceError).status).toBe(429)
      expect((error as ServiceError).headers['Retry-After']).toBe('1')
    }
  })

  test('a tenant does not take the room of another one', () => {
    const limiter = new TenantLimiter({ maxInFlightPerTenant: 1 })
    limiter.enter('tenant-a')
    expect(() => limiter.enter('tenant-b')).not.toThrow()
  })

  test('the room is given back', () => {
    const limiter = new TenantLimiter({ maxInFlightPerTenant: 1 })
    limiter.enter('tenant-a')
    limiter.leave('tenant-a')
    expect(() => limiter.enter('tenant-a')).not.toThrow()
  })

  test('a tenant that holds no request leaves the map', () => {
    const limiter = new TenantLimiter({ maxInFlightPerTenant: 4 })
    limiter.enter('tenant-a')
    expect(limiter.size).toBe(1)
    limiter.leave('tenant-a')
    expect(limiter.size).toBe(0)
  })

  test('the bound is disabled when it is zero', () => {
    const limiter = new TenantLimiter({ maxInFlightPerTenant: 0 })
    for (let index = 0; index < 100; index += 1) limiter.enter('tenant-a')
    expect(() => limiter.enter('tenant-a')).not.toThrow()
  })
})
