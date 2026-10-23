/**
 * The audit log (spec §11.2).
 *
 * The audit log is an append only record of the committed mutations of a
 * workspace. It holds the identifiers of the mutation and the names of
 * the fields that changed, never the values: an audit log is not a
 * revision store and it is not a copy of the business data.
 *
 * The domain owns the shape of an entry and the ports that write and
 * read it. It imports no domain and no adapter.
 */

/** The action of a mutation. */
export type AuditAction = 'create' | 'update' | 'delete'

/** The source of a mutation. */
export type AuditSource = 'shuttle' | 'worker'

/** One entry of the audit log. */
export interface AuditEntry {
  /** The identifier of the entry. */
  readonly id: string
  /** The moment the mutation was committed. */
  readonly occurredAt: string
  /** The principal that made the mutation. */
  readonly principalId: string
  readonly tenantId: string
  readonly workspaceId: string
  /** The route the mutation came through. */
  readonly routeId: string
  /** The correlation id of the request. */
  readonly requestId: string
  /** The source of the mutation. */
  readonly source: AuditSource
  /** The collection that was mutated. */
  readonly collection: string
  /** The record that was mutated. */
  readonly recordId: string
  /** The action of the mutation. */
  readonly action: AuditAction
  /** The version of the record after the mutation, the last one for a delete. */
  readonly resultVersion: number
  /** The names of the fields that changed. */
  readonly changedFields: readonly string[]
  /** The version of the policy bundle that authorized the mutation. */
  readonly policyBundleVersion: string
  /** The policy that authorized the mutation. */
  readonly policyId: string
  /** The event that caused the mutation, when a worker made it. */
  readonly causationEventId?: string | null
  /** The principal that started the chain of events. */
  readonly causationPrincipalId?: string | null
}

/** A page of the audit log. */
export interface AuditPage {
  readonly entries: readonly AuditEntry[]
  readonly nextCursor: string | null
}

/** The reader of the audit log. */
export interface AuditReader {
  /**
   * Reads a page of the audit log of a workspace.
   *
   * The reader is scoped: it never returns an entry of another
   * workspace.
   */
  list: (
    scope: { tenantId: string; workspaceId: string },
    options: { limit: number; position?: AuditPosition }
  ) => Promise<AuditPage>
}

/** The position of a page of the audit log. */
export interface AuditPosition {
  readonly occurredAt: string
  readonly id: string
}

/**
 * The sink of the audit log.
 *
 * The sink is written inside the transaction of the mutation: an entry
 * that is not committed with the mutation does not exist.
 */
export interface AuditSink {
  append: (entry: AuditEntry, unit: unknown) => Promise<void>
}
