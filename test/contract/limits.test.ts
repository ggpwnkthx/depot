import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createHarness,
  PRINCIPAL_ID,
  TENANT_ID,
  WORKSPACE_ID,
  type Harness,
} from '../helpers/harness'

let harness: Harness

beforeAll(async () => {
  // The bound of the tenant is one: the second request of the tenant
  // is refused while the first one holds its room.
  harness = await createHarness({ maxInFlightPerTenant: 1 })
  harness.hub.grants.set(PRINCIPAL_ID, [
    {
      tenantId: TENANT_ID,
      permissionKeys: ['content.reader', 'content.editor'],
    },
  ])
})

afterAll(async () => {
  await harness?.stop()
})

describe('the bound of a tenant', () => {
  test('a request that holds the room refuses the next one', async () => {
    // The room is taken by the request itself, and it is given back
    // when the request ends.
    const first = await harness.request(`/ws/${WORKSPACE_ID}/v1/me`)
    expect(first.status).toBe(200)

    // The limiter is exercised directly: the requests of the test are
    // not concurrent, and the room of the tenant is taken by hand.
    harness.limiter.enter(TENANT_ID)
    const refused = await harness.request(`/ws/${WORKSPACE_ID}/v1/me`)
    expect(refused.status).toBe(429)
    const body = (await refused.json()) as { error: { code: string } }
    expect(body.error.code).toBe('TOO_MANY_REQUESTS')
    expect(refused.headers.get('retry-after')).toBe('1')
    harness.limiter.leave(TENANT_ID)
  })

  test('the room is given back when the request ends', async () => {
    const response = await harness.request(`/ws/${WORKSPACE_ID}/v1/me`)
    expect(response.status).toBe(200)
    expect(harness.limiter.size).toBe(0)
  })

  test('a probe is not a tenant', async () => {
    // The probes of the deployment are not routed through the
    // authorization of a workspace, and they are not refused by the
    // bound of a tenant.
    harness.limiter.enter(TENANT_ID)
    const response = await harness.raw('/healthz')
    expect(response.status).toBe(200)
    harness.limiter.leave(TENANT_ID)
  })
})
