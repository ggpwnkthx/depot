import { describe, expect, test } from 'bun:test'
import { ContextResolver } from '../../src/domains/authorization'
import type { AccessContextClient, AccessContextRequest } from '../../src/domains/authorization'
import { fixedClock, type Clock } from '../../src/protocol/clock'

/** The client of the context that answers for every principal. */
function countingClient(clock: Clock): { client: AccessContextClient; calls: () => number } {
  let calls = 0
  const client: AccessContextClient = {
    discover: async () => ({ versions: [1], maxPermissionKeys: 4096, maxLifetimeMs: 5000 }),
    evaluate: async (request: AccessContextRequest): Promise<unknown> => {
      calls += 1
      return {
        version: 1,
        allow: true,
        subject: request.subject,
        tenantId: request.tenantId,
        workspaceId: request.workspaceId,
        routeId: request.routeId,
        permissionKeys: ['content.reader'],
        evaluatedAt: new Date(clock.now()).toISOString(),
        validUntil: new Date(clock.now() + 5000).toISOString(),
      }
    },
  }
  return { client, calls: () => calls }
}

/** The request of a principal. */
function request(subject: string): AccessContextRequest {
  return {
    subject,
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    routeId: 'data-api',
  }
}

describe('the cache of the context', () => {
  test('it is off by default', async () => {
    const clock = fixedClock(1000)
    const { client, calls } = countingClient(clock)
    const resolver = new ContextResolver({
      client,
      cacheTtlMs: 0,
      credentialScope: 'scope',
      clock,
    })
    await resolver.resolve(request('a'), { fresh: false, source: 'shuttle', requestId: 'r' })
    await resolver.resolve(request('a'), { fresh: false, source: 'shuttle', requestId: 'r' })
    expect(calls()).toBe(2)
  })

  test('it answers a read from the cache', async () => {
    const clock = fixedClock(1000)
    const { client, calls } = countingClient(clock)
    const resolver = new ContextResolver({
      client,
      cacheTtlMs: 1000,
      credentialScope: 'scope',
      clock,
    })
    await resolver.resolve(request('a'), { fresh: false, source: 'shuttle', requestId: 'r' })
    await resolver.resolve(request('a'), { fresh: false, source: 'shuttle', requestId: 'r' })
    expect(calls()).toBe(1)
  })

  test('a mutation always asks for a fresh context', async () => {
    const clock = fixedClock(1000)
    const { client, calls } = countingClient(clock)
    const resolver = new ContextResolver({
      client,
      cacheTtlMs: 1000,
      credentialScope: 'scope',
      clock,
    })
    await resolver.resolve(request('a'), { fresh: false, source: 'shuttle', requestId: 'r' })
    await resolver.resolve(request('a'), { fresh: true, source: 'shuttle', requestId: 'r' })
    expect(calls()).toBe(2)
  })

  test('the cache is bounded', async () => {
    const clock = fixedClock(1000)
    const { client } = countingClient(clock)
    const resolver = new ContextResolver({
      client,
      cacheTtlMs: 60_000,
      cacheMaxEntries: 10,
      credentialScope: 'scope',
      clock,
    })
    for (let index = 0; index < 100; index += 1) {
      await resolver.resolve(request(`principal-${index}`), {
        fresh: false,
        source: 'shuttle',
        requestId: 'r',
      })
    }
    // The cache is the mitigation of the availability of Hub, and a
    // mitigation that grows without a bound is a leak.
    expect(resolver.cacheSize).toBeLessThanOrEqual(10)
  })

  test('the entries that are spent leave the cache', async () => {
    const clock = fixedClock(1000)
    const { client } = countingClient(clock)
    const resolver = new ContextResolver({
      client,
      cacheTtlMs: 100,
      cacheMaxEntries: 100,
      credentialScope: 'scope',
      clock,
    })
    for (let index = 0; index < 50; index += 1) {
      await resolver.resolve(request(`principal-${index}`), {
        fresh: false,
        source: 'shuttle',
        requestId: 'r',
      })
    }
    expect(resolver.cacheSize).toBe(50)
    // The entries expire: the sweep removes them the next time the
    // cache is written.
    clock.advance(200)
    await resolver.resolve(request('another-principal'), {
      fresh: false,
      source: 'shuttle',
      requestId: 'r',
    })
    expect(resolver.cacheSize).toBeLessThanOrEqual(1)
  })
})
