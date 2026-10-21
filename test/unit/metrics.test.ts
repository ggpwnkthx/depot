import { expect, test } from 'bun:test'
import { Metrics, createMetrics } from '../../src/observability/metrics'
import { ContextResolver } from '../../src/domains/authorization'
import type { AccessContext, AccessContextClient } from '../../src/domains/authorization'

/**
 * The metrics of the service (spec §15.1).
 *
 * The exposition is the text format of Prometheus: the histograms carry
 * the cumulative count of their buckets, and the counters of the hub and
 * of the cache of the context say what the process did.
 */

test('the buckets of a histogram are cumulative', () => {
  const metrics = new Metrics([
    { name: 'data_test_duration_ms', kind: 'histogram', help: 'A duration.', buckets: [10, 100] },
  ])
  metrics.observe('data_test_duration_ms', 5)
  metrics.observe('data_test_duration_ms', 50)
  metrics.observe('data_test_duration_ms', 500)
  const rendered = metrics.render()
  expect(rendered).toContain('data_test_duration_ms_bucket{le="10"} 1')
  expect(rendered).toContain('data_test_duration_ms_bucket{le="100"} 2')
  expect(rendered).toContain('data_test_duration_ms_bucket{le="+Inf"} 3')
  expect(rendered).toContain('data_test_duration_ms_count 3')
  expect(rendered).toContain('data_test_duration_ms_sum 555')
})

test('the counters of the service are rendered with their labels', () => {
  const metrics = createMetrics()
  metrics.increment('data_requests_total', { route: '/items', status: '200' })
  metrics.increment('data_requests_total', { route: '/items', status: '200' })
  const rendered = metrics.render()
  expect(rendered).toContain('data_requests_total{route="/items",status="200"} 2')
})

/** A client of the contract that answers a context. */
function clientOf(counter: { calls: number }): AccessContextClient {
  return {
    discover: async () => ({
      versions: [1],
      maxPermissionKeys: 64,
      maxLifetimeMs: 5000,
    }),
    evaluate: async (): Promise<AccessContext> => {
      counter.calls += 1
      const evaluatedAt = new Date()
      // The answer of the hub is the wire form: the times are strings.
      return {
        version: 1,
        allow: true,
        subject: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
        workspaceId: '33333333-3333-4333-8333-333333333333',
        routeId: 'data-api',
        permissionKeys: ['content.reader'],
        evaluatedAt: evaluatedAt.toISOString(),
        validUntil: new Date(evaluatedAt.getTime() + 5000).toISOString(),
      } as unknown as AccessContext
    },
  }
}

const request = {
  subject: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  routeId: 'data-api',
}

const options = { source: 'shuttle' as const, requestId: 'r1', policyBundleVersion: 'v1' }

test('the cache of the context counts its hits and its misses', async () => {
  const metrics = createMetrics()
  const counter = { calls: 0 }
  const resolver = new ContextResolver({
    client: clientOf(counter),
    cacheTtlMs: 5000,
    credentialScope: 'scope',
    clock: { now: () => Date.now(), monotonic: () => performance.now() },
    metrics,
  })
  await resolver.resolve(request, { ...options, fresh: false })
  await resolver.resolve(request, { ...options, fresh: false })
  expect(counter.calls).toBe(1)
  const rendered = metrics.render()
  expect(rendered).toContain('data_context_cache_hits_total 1')
  expect(rendered).toContain('data_context_cache_misses_total 1')
})

test('a mutation never reads the cache of the context', async () => {
  const metrics = createMetrics()
  const counter = { calls: 0 }
  const resolver = new ContextResolver({
    client: clientOf(counter),
    cacheTtlMs: 5000,
    credentialScope: 'scope',
    clock: { now: () => Date.now(), monotonic: () => performance.now() },
    metrics,
  })
  await resolver.resolve(request, { ...options, fresh: true })
  await resolver.resolve(request, { ...options, fresh: true })
  expect(counter.calls).toBe(2)
  const rendered = metrics.render()
  expect(rendered).not.toContain('data_context_cache_hits_total')
})
