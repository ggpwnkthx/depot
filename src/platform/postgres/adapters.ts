/**
 * The adapters of the ports of the domains (spec §6.3 and §11).
 *
 * The adapters are the only code that speaks SQL about the tables of the
 * backend. They are constructed by the composition root and they are
 * never imported by a domain.
 */

import { randomUUID } from 'node:crypto'
import type { AuditEntry, AuditPage, AuditReader, AuditSink } from '../../domains/audit'
import type { Delivery, DomainEvent, Outbox, Subscriber } from '../../domains/events'
import type { DataStore, SubscriberLike, UnitOfWork } from '../../domains/records'
import type { WorkspaceIdentity, WorkspaceRegistry } from '../../domains/workspaces'
import type { ConnectionPool } from './database'

/** The reader of the registry of the workspaces. */
export class PostgresWorkspaceRegistry implements WorkspaceRegistry {
  readonly #pool: ConnectionPool

  constructor(pool: ConnectionPool) {
    this.#pool = pool
  }

  /**
   * Reads the identity of a workspace.
   *
   * The statement reads three columns: the role of the reader may not
   * select anything else, and the reader may not enumerate the
   * workspaces.
   */
  async findById(id: string): Promise<WorkspaceIdentity | null> {
    const rows = await this.#pool.query<{ id: string; tenant_id: string; status: string }>(
      'select id, tenant_id, status from platform.workspaces where id = $1::uuid',
      [id]
    )
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      tenantId: row.tenant_id,
      status: row.status === 'disabled' ? 'disabled' : 'active',
    }
  }
}

/** The writer of the audit log. */
export class PostgresAuditSink implements AuditSink {
  async append(entry: AuditEntry, unit: unknown): Promise<void> {
    const work = unit as UnitOfWork
    await work.execute(
      `insert into platform.audit_entries
   (id, occurred_at, principal_id, tenant_id, workspace_id, route_id, request_id, source,
    collection, record_id, action, result_version, changed_fields, policy_bundle_version, policy_id,
    causation_event_id, causation_principal_id)
 values ($1::uuid, $2::timestamptz, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8,
         $9, $10::uuid, $11, $12, $13, $14, $15, $16::uuid, $17::uuid)`,
      [
        entry.id,
        entry.occurredAt,
        entry.principalId,
        entry.tenantId,
        entry.workspaceId,
        entry.routeId,
        entry.requestId,
        entry.source,
        entry.collection,
        entry.recordId,
        entry.action,
        entry.resultVersion,
        entry.changedFields,
        entry.policyBundleVersion,
        entry.policyId,
        entry.causationEventId ?? null,
        entry.causationPrincipalId ?? null,
      ]
    )
  }
}

/** The reader of the audit log. */
export class PostgresAuditReader implements AuditReader {
  readonly #store: DataStore

  constructor(store: DataStore) {
    this.#store = store
  }

  async list(
    scope: { tenantId: string; workspaceId: string },
    options: { limit: number; position?: { occurredAt: string; id: string } }
  ): Promise<AuditPage> {
    const params: unknown[] = [scope.tenantId, scope.workspaceId]
    let clause = ''
    if (options.position) {
      params.push(options.position.occurredAt)
      params.push(options.position.id)
      clause = `and (occurred_at, id) < ($3::timestamptz, $4::uuid)`
    }
    const rows = await this.#store.read(
      async (unit) =>
        await unit.query<{
          id: string
          occurred_at: string
          principal_id: string
          tenant_id: string
          workspace_id: string
          route_id: string
          request_id: string
          source: string
          collection: string
          record_id: string
          action: string
          result_version: number
          changed_fields: string[]
          policy_bundle_version: string
          policy_id: string
          causation_event_id: string | null
          causation_principal_id: string | null
        }>(
          `select id, occurred_at, principal_id, tenant_id, workspace_id, route_id, request_id, source,
              collection, record_id, action, result_version, changed_fields, policy_bundle_version, policy_id,
              causation_event_id, causation_principal_id
         from platform.audit_entries
        where tenant_id = $1::uuid and workspace_id = $2::uuid ${clause}
        order by occurred_at desc, id desc
        limit $${params.length + 1}`,
          [...params, options.limit + 1]
        ),
      { tenantId: scope.tenantId, workspaceId: scope.workspaceId, principalId: scope.tenantId }
    )
    const page = rows.slice(0, options.limit)
    const last = page[page.length - 1]
    return {
      entries: page.map((row) => ({
        id: row.id,
        occurredAt: new Date(row.occurred_at).toISOString(),
        principalId: row.principal_id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        routeId: row.route_id,
        requestId: row.request_id,
        source: row.source === 'worker' ? 'worker' : 'shuttle',
        collection: row.collection,
        recordId: row.record_id,
        action: row.action as 'create' | 'update' | 'delete',
        resultVersion: row.result_version,
        changedFields: row.changed_fields ?? [],
        policyBundleVersion: row.policy_bundle_version,
        policyId: row.policy_id,
        causationEventId: row.causation_event_id,
        causationPrincipalId: row.causation_principal_id,
      })),
      nextCursor: rows.length > options.limit && last ? `${last.occurred_at}|${last.id}` : null,
    }
  }
}

/** The writer of the outbox. */
export class PostgresOutbox implements Outbox {
  async append(
    event: DomainEvent,
    subscribers: readonly Subscriber[] | readonly SubscriberLike[],
    unit: unknown
  ): Promise<void> {
    const work = unit as UnitOfWork
    await work.execute(
      `insert into platform.outbox_events
   (id, version, type, tenant_id, workspace_id, collection, record_id, record_version, actor_id,
    occurred_at, changed_fields, correlation_id, causation_id, causation_depth, payload)
 values ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7::uuid, $8, $9::uuid,
         $10::timestamptz, $11, $12, $13::uuid, $14, $15::jsonb)`,
      [
        event.eventId,
        event.version,
        event.type,
        event.tenantId,
        event.workspaceId,
        event.collection,
        event.recordId,
        event.recordVersion,
        event.actorId,
        event.occurredAt,
        event.changedFields,
        event.correlationId,
        event.causationId,
        event.causationDepth,
        JSON.stringify(event),
      ]
    )
    for (const subscriber of subscribers) {
      await work.execute(
        `insert into platform.outbox_deliveries
     (event_id, subscriber_id, tenant_id, workspace_id, state, attempts, next_attempt_at, created_at, updated_at)
   values ($1::uuid, $2, $3::uuid, $4::uuid, 'pending', 0, now(), now(), now())`,
        [event.eventId, subscriber.id, event.tenantId, event.workspaceId]
      )
    }
  }
}

/** The store of the deliveries. */
export class PostgresDeliveryStore {
  readonly #pool: ConnectionPool

  constructor(pool: ConnectionPool) {
    this.#pool = pool
  }

  /**
   * Claims the deliveries that are due.
   *
   * The claim is atomic and it uses `for update skip locked`: two
   * workers never claim the same delivery and a worker never waits for
   * the other one.
   */
  async claimDue(options: {
    workerId: string
    limit: number
    leaseMs: number
  }): Promise<Delivery[]> {
    const rows = await this.#pool.query<{
      event_id: string
      subscriber_id: string
      state: string
      attempts: number
      next_attempt_at: string
      lease_expires_at: string | null
      last_error: string | null
      payload: Record<string, unknown>
    }>(
      `with due as (
         select d.event_id, d.subscriber_id
           from platform.outbox_deliveries d
          where (d.state = 'pending' and d.next_attempt_at <= now())
             or (d.state = 'leased' and d.lease_expires_at is not null and d.lease_expires_at <= now())
          order by d.next_attempt_at asc
          limit $1
          for update skip locked
       )
       update platform.outbox_deliveries d
          set state = 'leased',
              lease_expires_at = now() + ($2 || ' milliseconds')::interval,
              locked_by = $3,
              attempts = d.attempts + 1,
              updated_at = now()
         from due, platform.outbox_events e
        where d.event_id = due.event_id
          and d.subscriber_id = due.subscriber_id
          and e.id = d.event_id
       returning d.event_id, d.subscriber_id, d.state, d.attempts, d.next_attempt_at,
                 d.lease_expires_at, d.last_error, e.payload`,
      [options.limit, String(options.leaseMs), options.workerId]
    )
    return rows.map((row) => ({
      eventId: row.event_id,
      subscriberId: row.subscriber_id,
      state: row.state as Delivery['state'],
      attempts: row.attempts,
      nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
      lastError: row.last_error,
      event: row.payload as unknown as DomainEvent,
    }))
  }

  /** Acknowledges a delivery. */
  async acknowledge(delivery: Delivery): Promise<void> {
    await this.#pool.execute(
      `update platform.outbox_deliveries
          set state = 'acked', lease_expires_at = null, locked_by = null, updated_at = now()
        where event_id = $1::uuid and subscriber_id = $2`,
      [delivery.eventId, delivery.subscriberId]
    )
  }

  /** Records a failure of a delivery and schedules its next attempt. */
  async fail(delivery: Delivery, error: string, retryInMs: number | null): Promise<void> {
    if (retryInMs === null) {
      await this.#pool.execute(
        `update platform.outbox_deliveries
            set state = 'failed', lease_expires_at = null, locked_by = null,
                last_error = $3, updated_at = now()
          where event_id = $1::uuid and subscriber_id = $2`,
        [delivery.eventId, delivery.subscriberId, error.slice(0, 500)]
      )
      return
    }
    await this.#pool.execute(
      `update platform.outbox_deliveries
          set state = 'pending', lease_expires_at = null, locked_by = null,
              last_error = $3,
              next_attempt_at = now() + ($4 || ' milliseconds')::interval,
              updated_at = now()
        where event_id = $1::uuid and subscriber_id = $2`,
      [delivery.eventId, delivery.subscriberId, error.slice(0, 500), String(retryInMs)]
    )
  }

  /** Requeues a delivery, for the operator. */
  async requeue(eventId: string, subscriberId: string, actor: string): Promise<boolean> {
    const count = await this.#pool.execute(
      `update platform.outbox_deliveries
          set state = 'pending', attempts = 0, next_attempt_at = now(),
              lease_expires_at = null, locked_by = null, updated_at = now()
        where event_id = $1::uuid and subscriber_id = $2`,
      [eventId, subscriberId]
    )
    void actor
    return count > 0
  }

  /** The number of the deliveries that are not finished. */
  async backlog(): Promise<{ pending: number; failed: number; oldestSeconds: number }> {
    const rows = await this.#pool.query<{
      pending: string
      failed: string
      oldest: string | null
    }>(
      `select
         count(*) filter (where state in ('pending', 'leased'))::text as pending,
         count(*) filter (where state = 'failed')::text as failed,
         extract(epoch from (now() - min(created_at) filter (where state in ('pending', 'leased'))))::text as oldest
       from platform.outbox_deliveries`
    )
    const row = rows[0]
    return {
      pending: Number(row?.pending ?? '0'),
      failed: Number(row?.failed ?? '0'),
      oldestSeconds: Number(row?.oldest ?? '0'),
    }
  }

  /** The deliveries of an event, for the diagnostics. */
  async deliveriesOf(eventId: string): Promise<Delivery[]> {
    const rows = await this.#pool.query<{
      event_id: string
      subscriber_id: string
      state: string
      attempts: number
      next_attempt_at: string
      lease_expires_at: string | null
      last_error: string | null
      payload: Record<string, unknown>
    }>(
      `select d.event_id, d.subscriber_id, d.state, d.attempts, d.next_attempt_at,
              d.lease_expires_at, d.last_error, e.payload
         from platform.outbox_deliveries d
         join platform.outbox_events e on e.id = d.event_id
        where d.event_id = $1::uuid`,
      [eventId]
    )
    return rows.map((row) => ({
      eventId: row.event_id,
      subscriberId: row.subscriber_id,
      state: row.state as Delivery['state'],
      attempts: row.attempts,
      nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
      lastError: row.last_error,
      event: row.payload as unknown as DomainEvent,
    }))
  }
}

/** The identifier of a new audit entry. */
export function newAuditId(): string {
  return randomUUID()
}
